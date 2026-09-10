import { boundaryReferencesOnly, buildVertexAdjacency, computeMiterJoints, findFillBoundary, incidentEdgeIds, resolveBoundaryPolygon } from './vectorTopology.js';

// ============================================================================
// VECTOR ART DOCUMENT — a strict node/edge graph, stored as JSON inside a
// ".vec" file. Same "just JSON through the debounced Drive-save pipeline" as
// the Canvas/Database sections. Schema:
//
//   { title, description,
//     canvas: { width, height, background },
//     vertices: [ { id, x, y } ],
//     edges:    [ { id, v1, v2, style: { color, thickness } } ],
//     fills:    [ { id, boundary: [...], color } ],
//     circles:  [ { id, cx, cy, r, style: { color, thickness }, fill } ],
//     groups:   [ { id, vertexIds: [...] } ] }
//
// Design notes (see also the rewritten build spec this ships against):
//  - Edges are undirected and ALWAYS carry their own explicit style — there
//    is no vertex style and no inheritance, so there's never a conflict to
//    resolve when an edge's two endpoints belong to differently-styled
//    edges elsewhere in the graph.
//  - An edge's (or circle's) `style.thickness` may be exactly 0 — a
//    deliberately "inkless" edge/outline that compiles to a real
//    stroke-width:0 stroke in the exported SVG (i.e. genuinely invisible,
//    not just thin). The editor still shows a dashed guide for these in
//    Edit mode so they stay findable/selectable; View mode hides that
//    guide so the canvas matches the export. See VectorEditorView.jsx.
//  - Circles are independent primitives — not part of the vertex/edge
//    graph, no snapping into it, no fill-boundary participation. Always
//    perfect circles (single radius), never ellipses.
//  - A fill's `boundary` is a STRUCTURAL reference, not a snapshot of
//    coordinates: each entry is either a real vertex id, or (at a fill-only
//    crossing — see vectorTopology.js's planarizeForFill) the two real edge
//    ids that cross there. resolveBoundaryPolygon turns that back into
//    concrete points from wherever those vertices/edges are RIGHT NOW, so a
//    fill tracks the shape as it's edited instead of a fixed snapshot going
//    stale the moment something moves. If a boundary's vertex/edge no
//    longer exists (deleted) or a crossing stops crossing, the fill is
//    pruned outright (pruneFills, called after every delete) rather than
//    silently failing to render.
//  - No multi-edges and no self-loops: addEdge is a no-op (returns the
//    state unchanged, `ok:false`) if the two vertices already share an edge
//    or are the same vertex.
// ============================================================================

const VECTOR_COLORS = ['#e0555a', '#e0a63d', '#d8c34a', '#6fcf97', '#4fb0c6', '#9b7fd1', '#dcddde'];

// 0 is a real, meaningful option here (see the schema note above) — it must
// stay first-class through parse/serialize, not fall back to a "truthy"
// default the way `x || DEFAULT` would.
const VECTOR_THICKNESSES = [0, 1, 2, 3, 5, 8, 12];

const VECTOR_RADII = [4, 8, 12, 20, 30, 50, 80, 120];

const DEFAULT_STYLE = { color: VECTOR_COLORS[6], thickness: 2 };

const DEFAULT_CIRCLE_STYLE = { color: VECTOR_COLORS[6], thickness: 2 };
const DEFAULT_CIRCLE_FILL = 'none';
const DEFAULT_CIRCLE_RADIUS = 30;

const VECTOR_ZOOM_MIN = 0.1;
const VECTOR_ZOOM_MAX = 6;

// Screen-px thresholds for snapping/hit-testing — the view divides these by
// the current zoom before passing them to snapCandidate, so the hit area
// stays visually constant on screen regardless of zoom level (same
// convention CanvasView uses for CANVAS_CONNECT_NEAR_PX).
const VERTEX_SNAP_PX = 14;
const VERTEX_HIT_PX = 10;
const EDGE_SNAP_PX = 10;
const AXIS_SNAP_PX = 7;

// World-px a pulled edge endpoint must travel from its shared vertex before
// Graph Severing (Tear-Away Disconnect) actually detaches it — below this
// it's treated as an ordinary (non-destructive) vertex nudge.
const SEVER_THRESHOLD_PX = 28;


function makeDefaultVectorState(title) {
  return {
    title: title || 'Untitled',
    description: '',
    canvas: { width: 1600, height: 1000, background: '#1e1e1e' },
    vertices: [],
    edges: [],
    fills: [],
    circles: [],
    groups: [],
    layers: [{ id: 'layer-1', name: 'Layer 1', visible: true }]
  };
}

// Parses a thickness value keeping an explicit 0 intact — `Number(x) || d`
// would silently coerce a real 0 into the fallback default, which is wrong
// now that 0 is a legitimate, distinct thickness.
function parseThickness(raw, fallback) {
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}


// Validates one boundary loop (outer or a hole): a flat list of
// vertex/crossing components referencing only ids that still exist.
function parseBoundaryLoop(raw, vertexIds, edgeIds) {
  if (!Array.isArray(raw) || raw.length < 3) return null;
  const loop = [];
  for (const comp of raw) {
    if (!comp) return null;
    if (comp.type === 'vertex' && vertexIds.has(comp.id)) loop.push({ type: 'vertex', id: comp.id });
    else if (comp.type === 'crossing' && edgeIds.has(comp.edgeA) && edgeIds.has(comp.edgeB)) loop.push({ type: 'crossing', edgeA: comp.edgeA, edgeB: comp.edgeB });
    else return null;
  }
  return loop;
}

// Accepts either the current `{ outer, holes }` shape or the older bare
// "just an outer loop" array (files saved before hole support existed),
// normalizing to `{ outer, holes }` either way. A hole that fails to
// validate is just dropped rather than invalidating the whole fill.
function parseFillBoundary(raw, vertexIds, edgeIds) {
  const spec = Array.isArray(raw) ? { outer: raw, holes: [] } : raw;
  if (!spec || typeof spec !== 'object') return null;
  const outer = parseBoundaryLoop(spec.outer, vertexIds, edgeIds);
  if (!outer) return null;
  const holes = Array.isArray(spec.holes) ? spec.holes.map((h) => parseBoundaryLoop(h, vertexIds, edgeIds)).filter(Boolean) : [];
  return { outer, holes };
}

// Tolerant parse: malformed/foreign JSON yields a fresh empty document
// rather than crashing the pane, same convention as parseCanvasContent.
function parseVectorContent(content) {
  if (!content || !content.trim()) return makeDefaultVectorState();
  try {
    const p = JSON.parse(content);
    const vertices = Array.isArray(p?.vertices) ? p.vertices.filter((v) => v && v.id).map((v) => ({ id: v.id, x: Number(v.x) || 0, y: Number(v.y) || 0 })) : [];
    const vertexIds = new Set(vertices.map((v) => v.id));
    // Layers always have at least one entry — a file saved before layers
    // existed (or with a corrupted layers list) gets a single default
    // layer, and everything below falls back onto it via layerIds.has(...)
    // ? ... : layers[0].id, so nothing in an old file silently disappears.
    const parsedLayers = Array.isArray(p?.layers)
      ? p.layers.filter((l) => l && l.id).map((l) => ({ id: l.id, name: typeof l.name === 'string' ? l.name : 'Layer', visible: l.visible !== false }))
      : [];
    const layers = parsedLayers.length ? parsedLayers : [{ id: 'layer-1', name: 'Layer 1', visible: true }];
    const layerIds = new Set(layers.map((l) => l.id));
    const defaultLayerId = layers[0].id;
    const edges = Array.isArray(p?.edges)
      ? p.edges
          .filter((e) => e && e.id && vertexIds.has(e.v1) && vertexIds.has(e.v2) && e.v1 !== e.v2)
          .map((e) => ({
            id: e.id,
            v1: e.v1,
            v2: e.v2,
            style: { color: e.style?.color || DEFAULT_STYLE.color, thickness: parseThickness(e.style?.thickness, DEFAULT_STYLE.thickness) },
            layerId: layerIds.has(e.layerId) ? e.layerId : defaultLayerId
          }))
      : [];
    const edgeIds = new Set(edges.map((e) => e.id));
    const fills = Array.isArray(p?.fills)
      ? p.fills
          .map((f) => (f && f.id && f.color ? { id: f.id, color: f.color, boundary: parseFillBoundary(f.boundary, vertexIds, edgeIds), layerId: layerIds.has(f.layerId) ? f.layerId : defaultLayerId } : null))
          .filter((f) => f && f.boundary)
      : [];
    const circles = Array.isArray(p?.circles)
      ? p.circles
          .filter((c) => c && c.id && Number.isFinite(Number(c.cx)) && Number.isFinite(Number(c.cy)))
          .map((c) => ({
            id: c.id,
            cx: Number(c.cx) || 0,
            cy: Number(c.cy) || 0,
            r: Math.max(0.5, Number(c.r) || DEFAULT_CIRCLE_RADIUS),
            style: { color: c.style?.color || DEFAULT_CIRCLE_STYLE.color, thickness: parseThickness(c.style?.thickness, DEFAULT_CIRCLE_STYLE.thickness) },
            fill: typeof c.fill === 'string' ? c.fill : DEFAULT_CIRCLE_FILL,
            layerId: layerIds.has(c.layerId) ? c.layerId : defaultLayerId
          }))
      : [];
    const groups = Array.isArray(p?.groups)
      ? p.groups.filter((g) => g && g.id && Array.isArray(g.vertexIds)).map((g) => ({ id: g.id, vertexIds: g.vertexIds.filter((id) => vertexIds.has(id)) })).filter((g) => g.vertexIds.length > 1)
      : [];
    return {
      title: typeof p?.title === 'string' ? p.title : 'Untitled',
      description: typeof p?.description === 'string' ? p.description : '',
      canvas: { width: Number(p?.canvas?.width) || 1600, height: Number(p?.canvas?.height) || 1000, background: p?.canvas?.background || '#1e1e1e' },
      vertices,
      edges,
      fills,
      circles,
      groups,
      layers
    };
  } catch {
    return makeDefaultVectorState();
  }
}


function serializeVectorState(state) {
  return JSON.stringify(
    { title: state.title, description: state.description, canvas: state.canvas, vertices: state.vertices, edges: state.edges, fills: state.fills, circles: state.circles, groups: state.groups, layers: state.layers },
    null,
    2
  );
}


// ---------------------------------------------------------------------------
// Mutations — every one returns a NEW state object (never mutates its
// argument), matching the rest of the app's "commit(updater)" convention.
// ---------------------------------------------------------------------------

function addVertex(state, x, y, id) {
  const vertex = { id: id || `v-${cryptoRandomId()}`, x, y };
  return { ...state, vertices: [...state.vertices, vertex], _newVertexId: vertex.id };
}

function edgeExists(state, v1, v2) {
  return state.edges.some((e) => (e.v1 === v1 && e.v2 === v2) || (e.v1 === v2 && e.v2 === v1));
}

// Rejects self-loops and duplicate connections between the same pair of
// vertices — returns { state, ok:false } unchanged if either applies.
function addEdge(state, v1, v2, style, layerId) {
  if (v1 === v2 || edgeExists(state, v1, v2)) return { state, ok: false };
  const edge = { id: `e-${cryptoRandomId()}`, v1, v2, style: { ...DEFAULT_STYLE, ...style }, layerId: layerId || state.layers[0].id };
  return { state: { ...state, edges: [...state.edges, edge] }, ok: true, edgeId: edge.id };
}

function moveVertex(state, vertexId, x, y) {
  return { ...state, vertices: state.vertices.map((v) => (v.id === vertexId ? { ...v, x, y } : v)) };
}

// Bulk move for marquee-drag / global transform — `deltas` is
// Map(vertexId -> {x, y}) of ABSOLUTE new positions. Fills aren't touched
// here: their boundary is structural (vertex/edge ids), so they follow the
// move automatically the next time they're resolved for rendering.
function moveVertices(state, deltas) {
  if (!deltas.size) return state;
  return { ...state, vertices: state.vertices.map((v) => (deltas.has(v.id) ? { ...v, ...deltas.get(v.id) } : v)) };
}

function setEdgeStyle(state, edgeId, style) {
  return { ...state, edges: state.edges.map((e) => (e.id === edgeId ? { ...e, style: { ...e.style, ...style } } : e)) };
}

function setCanvasBackground(state, background) {
  return { ...state, canvas: { ...state.canvas, background } };
}

// Vertex Insertion (Subdivision): E(v1,v2) -> V_new + E1(v1,V_new) +
// E2(V_new,v2), both inheriting the original edge's style.
function subdivideEdge(state, edgeId, point) {
  const edge = state.edges.find((e) => e.id === edgeId);
  if (!edge) return state;
  const newVertex = { id: `v-${cryptoRandomId()}`, x: point.x, y: point.y };
  const e1 = { id: `e-${cryptoRandomId()}`, v1: edge.v1, v2: newVertex.id, style: { ...edge.style }, layerId: edge.layerId };
  const e2 = { id: `e-${cryptoRandomId()}`, v1: newVertex.id, v2: edge.v2, style: { ...edge.style }, layerId: edge.layerId };
  return {
    ...state,
    vertices: [...state.vertices, newVertex],
    edges: [...state.edges.filter((e) => e.id !== edgeId), e1, e2],
    _newVertexId: newVertex.id
  };
}

// Edge Mid-Point Insertion, for an EXISTING vertex being dropped onto an
// edge (as opposed to subdivideEdge, which creates a brand-new one): the
// dragged vertex itself becomes the subdivision point, binding it into the
// topology while keeping whatever other edges it already had. No-op if the
// vertex is already one of the edge's own endpoints.
function bindVertexOntoEdge(state, edgeId, vertexId) {
  const edge = state.edges.find((e) => e.id === edgeId);
  if (!edge || edge.v1 === vertexId || edge.v2 === vertexId) return state;
  const e1 = { id: `e-${cryptoRandomId()}`, v1: edge.v1, v2: vertexId, style: { ...edge.style }, layerId: edge.layerId };
  const e2 = { id: `e-${cryptoRandomId()}`, v1: vertexId, v2: edge.v2, style: { ...edge.style }, layerId: edge.layerId };
  return { ...state, edges: [...state.edges.filter((e) => e.id !== edgeId), e1, e2] };
}

// Graph Severing (Tear-Away Disconnect), scoped to just the pulled edge:
// replaces ONE endpoint of ONE edge with a brand-new vertex at `point`,
// leaving every other edge at the original vertex fully intact.
function severEdgeEndpoint(state, edgeId, vertexIdBeingPulled, point) {
  const edge = state.edges.find((e) => e.id === edgeId);
  if (!edge) return state;
  const newVertex = { id: `v-${cryptoRandomId()}`, x: point.x, y: point.y };
  const updatedEdge = { ...edge, v1: edge.v1 === vertexIdBeingPulled ? newVertex.id : edge.v1, v2: edge.v2 === vertexIdBeingPulled ? newVertex.id : edge.v2 };
  return {
    ...state,
    vertices: [...state.vertices, newVertex],
    edges: state.edges.map((e) => (e.id === edgeId ? updatedEdge : e)),
    _newVertexId: newVertex.id
  };
}

// Drops any fill whose boundary depends on a vertex/edge id no longer
// present — called after every delete so a fill never silently orphans
// itself against a shape that no longer exists.
function pruneFills(state) {
  const vertexIds = new Set(state.vertices.map((v) => v.id));
  const edgeIds = new Set(state.edges.map((e) => e.id));
  const fills = state.fills.filter((f) => boundaryReferencesOnly(f.boundary, vertexIds, edgeIds));
  return fills.length === state.fills.length ? state : { ...state, fills };
}

// Deletes vertices (and every edge/fill that depended on them). Edges are
// found via the adjacency index, not a full-array scan, so this stays
// O(degree) per removed vertex rather than O(E).
function deleteVertices(state, vertexIds) {
  if (!vertexIds.size) return state;
  const { adj } = buildVertexAdjacency(state.vertices, state.edges);
  const doomedEdgeIds = new Set();
  for (const id of vertexIds) for (const eid of incidentEdgeIds(adj, id)) doomedEdgeIds.add(eid);
  const vertices = state.vertices.filter((v) => !vertexIds.has(v.id));
  const edges = state.edges.filter((e) => !doomedEdgeIds.has(e.id));
  const groups = state.groups.map((g) => ({ ...g, vertexIds: g.vertexIds.filter((id) => !vertexIds.has(id)) })).filter((g) => g.vertexIds.length > 1);
  return pruneFills({ ...state, vertices, edges, groups });
}

function deleteEdges(state, edgeIds) {
  if (!edgeIds.size) return state;
  return pruneFills({ ...state, edges: state.edges.filter((e) => !edgeIds.has(e.id)) });
}

// Subgraph Grouping: a vertex belongs to at most one group, so joining a
// new one implicitly leaves any group it was already part of.
function groupVertices(state, vertexIds) {
  if (vertexIds.size < 2) return state;
  const ids = Array.from(vertexIds);
  const groups = state.groups.map((g) => ({ ...g, vertexIds: g.vertexIds.filter((id) => !vertexIds.has(id)) })).filter((g) => g.vertexIds.length > 1);
  groups.push({ id: `g-${cryptoRandomId()}`, vertexIds: ids });
  return { ...state, groups };
}

// Removes any group that is entirely contained in the given selection.
function ungroupVertices(state, vertexIds) {
  const groups = state.groups.filter((g) => !g.vertexIds.every((id) => vertexIds.has(id)));
  return { ...state, groups };
}

function groupIdForVertex(state, vertexId) {
  const g = state.groups.find((gr) => gr.vertexIds.includes(vertexId));
  return g ? g.id : null;
}

function groupVertexIds(state, groupId) {
  return state.groups.find((g) => g.id === groupId)?.vertexIds || [];
}

// True only when `vertexIds` is exactly one whole group's membership (no
// more, no less) — used to decide whether the selection toolbar should
// offer "Group" or "Ungroup".
function selectionIsExactlyOneGroup(state, vertexIds) {
  if (vertexIds.size < 2) return false;
  return state.groups.some((g) => g.vertexIds.length === vertexIds.size && g.vertexIds.every((id) => vertexIds.has(id)));
}

// Vector Flood Fill: resolves the minimal enclosing face under `point` and
// records a fill there. Also resolves every EXISTING fill's current polygon
// and removes any that already covers this same point first — so clicking
// an already-filled region with a new color replaces it instead of
// stacking a duplicate fill underneath.
// Vector Flood Fill: resolves the minimal enclosing face under `point` and
// records a fill there. Also resolves every EXISTING fill's current polygon
// and removes any that already covers this same point first — so clicking
// an already-filled region with a new color replaces it instead of
// stacking a duplicate fill underneath.
//
// `layerId` scopes the fill to one layer two ways: only that layer's edges
// are considered when tracing the enclosing face (an edge on another layer
// can't wall off a region it isn't visually part of), and only that
// layer's existing fills are candidates for the "already filled, replace
// it" check (a fill sitting on a different layer shouldn't disappear just
// because you filled the same spot on this one).
function addFillAt(state, point, color, layerId) {
  const layerEdges = state.edges.filter((e) => e.layerId === layerId);
  const boundary = findFillBoundary(state.vertices, layerEdges, point);
  if (!boundary) return { state, ok: false };
  const fills = state.fills.filter((f) => {
    if (f.layerId !== layerId) return true;
    const resolved = resolveBoundaryPolygon(state.vertices, state.edges, f.boundary);
    return !resolved || !isPointInFillRegion(point, resolved);
  });
  const fill = { id: `f-${cryptoRandomId()}`, boundary, color, layerId };
  return { state: { ...state, fills: [...fills, fill] }, ok: true };
}

// A point counts as "inside" a fill only if it's inside the outer loop AND
// not inside any of its holes — a click in a ring's cutout should start a
// fresh fill there, not be treated as re-clicking the ring itself.
function isPointInFillRegion(pt, resolved) {
  if (!isPointInPolygon(pt, resolved.outer)) return false;
  return !resolved.holes.some((h) => isPointInPolygon(pt, h));
}

function isPointInPolygon(pt, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i].x, yi = poly[i].y;
    const xj = poly[j].x, yj = poly[j].y;
    const hit = yi > pt.y !== yj > pt.y && pt.x < ((xj - xi) * (pt.y - yi)) / (yj - yi) + xi;
    if (hit) inside = !inside;
  }
  return inside;
}

function cryptoRandomId() {
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

// ---------------------------------------------------------------------------
// Circles — always perfect circles (one radius, never an ellipse). Kept as
// their own array rather than folded into the vertex/edge graph: no
// snapping onto them, no fill-boundary participation, just an independent
// primitive with a stroke (color/thickness) and an optional fill.
// ---------------------------------------------------------------------------
function addCircle(state, cx, cy, r, style, fill, layerId) {
  const circle = { id: `c-${cryptoRandomId()}`, cx, cy, r: Math.max(0.5, r), style: { ...DEFAULT_CIRCLE_STYLE, ...style }, fill: fill ?? DEFAULT_CIRCLE_FILL, layerId: layerId || state.layers[0].id };
  return { ...state, circles: [...state.circles, circle], _newCircleId: circle.id };
}

// Bulk move, same "Map(id -> absolute new position)" convention as
// moveVertices.
function moveCircles(state, deltas) {
  if (!deltas.size) return state;
  return { ...state, circles: state.circles.map((c) => (deltas.has(c.id) ? { ...c, ...deltas.get(c.id) } : c)) };
}

function resizeCircle(state, circleId, r) {
  return { ...state, circles: state.circles.map((c) => (c.id === circleId ? { ...c, r: Math.max(0.5, r) } : c)) };
}

function setCircleStyle(state, circleId, patch) {
  return {
    ...state,
    circles: state.circles.map((c) => {
      if (c.id !== circleId) return c;
      const next = { ...c };
      if (patch.style) next.style = { ...c.style, ...patch.style };
      if ('fill' in patch) next.fill = patch.fill;
      return next;
    })
  };
}

function deleteCircles(state, circleIds) {
  if (!circleIds.size) return state;
  return { ...state, circles: state.circles.filter((c) => !circleIds.has(c.id)) };
}

// ---------------------------------------------------------------------------
// Layers — a strict, ordered z-partition: everything on a lower layer
// renders and hit-tests entirely behind everything on a higher one,
// regardless of that content's own thickness (which still governs z-order
// only WITHIN a layer — see VectorEditorView's sortedEdges/layerOrder and
// compileVectorSvg). Vertices themselves have no layer — they're shared
// infrastructure a layer's edges point into, same spirit as a fill
// referencing vertex/edge ids rather than owning coordinates outright — so
// "move to layer" only ever applies to edges/circles/fills, never to a
// bare vertex selection.
// ---------------------------------------------------------------------------
function addLayer(state, name) {
  const layer = { id: `layer-${cryptoRandomId()}`, name: name || `Layer ${state.layers.length + 1}`, visible: true };
  return { ...state, layers: [...state.layers, layer], _newLayerId: layer.id };
}

// Always keeps at least one layer — a no-op if this would remove the last
// one. Drops the layer's own edges/circles/fills; deliberately does NOT
// prune vertices left with no remaining edges, matching deleteEdges'
// existing precedent of never cascading edge-deletion into its endpoints.
function removeLayer(state, layerId) {
  if (state.layers.length <= 1) return state;
  const layers = state.layers.filter((l) => l.id !== layerId);
  return pruneFills({
    ...state,
    layers,
    edges: state.edges.filter((e) => e.layerId !== layerId),
    circles: state.circles.filter((c) => c.layerId !== layerId),
    fills: state.fills.filter((f) => f.layerId !== layerId)
  });
}

function renameLayer(state, layerId, name) {
  return { ...state, layers: state.layers.map((l) => (l.id === layerId ? { ...l, name } : l)) };
}

function setLayerVisible(state, layerId, visible) {
  return { ...state, layers: state.layers.map((l) => (l.id === layerId ? { ...l, visible } : l)) };
}

// Swaps a layer with its neighbor in the given direction — the array order
// IS the z-order (index 0 = bottom), so this is a plain adjacent swap.
function reorderLayer(state, layerId, direction) {
  const i = state.layers.findIndex((l) => l.id === layerId);
  const j = direction === 'up' ? i + 1 : i - 1;
  if (i === -1 || j < 0 || j >= state.layers.length) return state;
  const layers = state.layers.slice();
  [layers[i], layers[j]] = [layers[j], layers[i]];
  return { ...state, layers };
}

// Reassigns the layer of a selection's edges/circles in one step (the
// selection model never mixes vertex selection with edge/circle selection —
// see VectorEditorView — so there's no ambiguity about what "move this
// selection" refers to).
function moveToLayer(state, { edgeIds, circleIds }, layerId) {
  return {
    ...state,
    edges: state.edges.map((e) => (edgeIds?.has(e.id) ? { ...e, layerId } : e)),
    circles: state.circles.map((c) => (circleIds?.has(c.id) ? { ...c, layerId } : c))
  };
}

// Picks black or white — whichever contrasts more — for the grid-dot
// texture painted behind the artwork, so the alignment dots stay visible
// against any canvas background color instead of just using a fixed theme
// color that could wash out against a similarly-toned background.
function contrastDotColor(hex) {
  const clean = (hex || '').replace('#', '');
  const full = clean.length === 3 ? clean.split('').map((ch) => ch + ch).join('') : clean;
  const r = parseInt(full.slice(0, 2), 16);
  const g = parseInt(full.slice(2, 4), 16);
  const b = parseInt(full.slice(4, 6), 16);
  if ([r, g, b].some((n) => Number.isNaN(n))) return '#ffffff';
  const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  return luminance > 0.55 ? '#000000' : '#ffffff';
}


// ---------------------------------------------------------------------------
// SVG export (spec section 6) — edges compile to <line>, fills to
// <polygon> (rendered first, so strokes sit on top of them), sorted by
// stroke weight so heavier edges draw after (on top of) lighter ones. Each
// edge is its own independent <line> primitive rather than merged into a
// multi-segment <path>, so there's no browser line-join to render at a
// shared vertex in the first place — the "sharp joint, no rounding" rule is
// satisfied by construction, and the weight-based z-order above is what
// makes a heavier edge read as sitting cleanly on top at that vertex rather
// than looking gapped or blended.
// ---------------------------------------------------------------------------
// Turns one or more closed point loops (an outer boundary plus zero or more
// holes) into a single multi-subpath SVG path `d` string. Combined with
// fill-rule="evenodd" on the <path>, any subpath nested inside another
// automatically punches a hole rather than needing to be a separate
// element — the standard technique for "shape with a cutout" in SVG, and
// exactly what a fill with holes (see vectorTopology.js's findFillBoundary)
// needs for rendering.
function loopsToPathData(loops) {
  return loops
    .filter((loop) => loop && loop.length >= 3)
    .map((loop) => `M ${loop.map((p) => `${p.x} ${p.y}`).join(' L ')} Z`)
    .join(' ');
}

function compileVectorSvg(state) {
  const { width, height, background } = state.canvas;
  const vertexById = new Map(state.vertices.map((v) => [v.id, v]));

  // Layers are a strict z-partition — everything on a lower layer renders
  // fully behind everything on a higher one, so the whole fills → circles →
  // edges → miter-joints stack is repeated per layer (bottom to top)
  // rather than once globally. Mitering is computed from each layer's OWN
  // edge subset too, so two edges on different layers never miter with
  // each other even if they happen to share a vertex.
  const layerMarkup = (state.layers || [{ id: undefined, visible: true }])
    .filter((layer) => layer.visible !== false)
    .map((layer) => {
      const layerEdges = state.edges.filter((e) => e.layerId === layer.id);
      const layerFills = state.fills.filter((f) => f.layerId === layer.id);
      const layerCircles = state.circles.filter((c) => c.layerId === layer.id);
      const sortedEdges = [...layerEdges].sort((a, b) => a.style.thickness - b.style.thickness);

      const fillsMarkup = layerFills
        .map((f) => {
          const resolved = resolveBoundaryPolygon(state.vertices, state.edges, f.boundary);
          if (!resolved) return '';
          return `  <path d="${loopsToPathData([resolved.outer, ...resolved.holes])}" fill="${f.color}" stroke="none" fill-rule="evenodd" />`;
        })
        .filter(Boolean)
        .join('\n');

      // A thickness of exactly 0 compiles to a real stroke-width:0 stroke,
      // which SVG renders as no stroke at all — genuinely invisible edges/
      // outlines, not just very thin ones (see the schema note up top).
      const circlesMarkup = layerCircles
        .map((c) => `  <circle cx="${c.cx}" cy="${c.cy}" r="${c.r}" stroke="${c.style.color}" stroke-width="${c.style.thickness}" fill="${c.fill && c.fill !== 'none' ? c.fill : 'none'}" />`)
        .join('\n');

      const edgesMarkup = sortedEdges
        .map((e) => {
          const a = vertexById.get(e.v1);
          const b = vertexById.get(e.v2);
          if (!a || !b) return '';
          return `  <line x1="${a.x}" y1="${a.y}" x2="${b.x}" y2="${b.y}" stroke="${e.style.color}" stroke-width="${e.style.thickness}" stroke-linecap="butt" stroke-linejoin="miter" />`;
        })
        .filter(Boolean)
        .join('\n');

      // Plugs the butt-cap notch at any vertex where exactly two EQUAL-
      // weight edges meet — see vectorTopology.js's computeMiterJoints.
      // Rendered after (on top of) this layer's own edges.
      const miterMarkup = computeMiterJoints(state.vertices, layerEdges)
        .map((j) => `  <polygon points="${j.points.map((p) => `${p.x},${p.y}`).join(' ')}" fill="${j.color}" stroke="none" />`)
        .join('\n');

      return [fillsMarkup, circlesMarkup, edgesMarkup, miterMarkup].filter(Boolean).join('\n');
    })
    .filter(Boolean)
    .join('\n');

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">\n  <rect x="0" y="0" width="${width}" height="${height}" fill="${background}" />\n${layerMarkup}\n</svg>\n`;
}

export {
  VECTOR_COLORS,
  VECTOR_THICKNESSES,
  VECTOR_RADII,
  DEFAULT_STYLE,
  DEFAULT_CIRCLE_STYLE,
  DEFAULT_CIRCLE_FILL,
  DEFAULT_CIRCLE_RADIUS,
  VECTOR_ZOOM_MIN,
  VECTOR_ZOOM_MAX,
  VERTEX_SNAP_PX,
  VERTEX_HIT_PX,
  EDGE_SNAP_PX,
  AXIS_SNAP_PX,
  SEVER_THRESHOLD_PX,
  makeDefaultVectorState,
  parseVectorContent,
  serializeVectorState,
  addVertex,
  addEdge,
  edgeExists,
  moveVertex,
  moveVertices,
  setEdgeStyle,
  setCanvasBackground,
  subdivideEdge,
  bindVertexOntoEdge,
  severEdgeEndpoint,
  deleteVertices,
  deleteEdges,
  addFillAt,
  isPointInPolygon,
  isPointInFillRegion,
  loopsToPathData,
  groupVertices,
  ungroupVertices,
  groupIdForVertex,
  groupVertexIds,
  selectionIsExactlyOneGroup,
  addCircle,
  moveCircles,
  resizeCircle,
  setCircleStyle,
  deleteCircles,
  contrastDotColor,
  addLayer,
  removeLayer,
  renameLayer,
  setLayerVisible,
  reorderLayer,
  moveToLayer,
  compileVectorSvg
};
