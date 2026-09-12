import { boundaryReferencesOnly, buildVertexAdjacency, computeMiterJoints, computeQuadWarpMatrix3d, findFillBoundary, incidentEdgeIds, resolveBoundaryPolygon } from './vectorTopology.js';

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

const DEFAULT_TEXT_COLOR = '#ffffff';
const DEFAULT_TEXT_FONT_SIZE = 24;
const DEFAULT_TEXT_ALIGN = 'left';
const DEFAULT_TEXT_WIDTH = 160;
const DEFAULT_TEXT_HEIGHT = 60;

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
    texts: [],
    groups: [],
    layers: [{ id: 'layer-1', name: 'Layer 1', visible: true }],
    snapAxes: []
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
    // A text's 4 corners are real vertex ids (see addText) — a text whose
    // corners aren't all still valid vertices is dropped rather than
    // rendered broken.
    const texts = Array.isArray(p?.texts)
      ? p.texts
          .filter((t) => t && t.id && [t.v1, t.v2, t.v3, t.v4].every((id) => vertexIds.has(id)))
          .map((t) => ({
            id: t.id,
            v1: t.v1,
            v2: t.v2,
            v3: t.v3,
            v4: t.v4,
            content: typeof t.content === 'string' ? t.content : '',
            color: typeof t.color === 'string' ? t.color : DEFAULT_TEXT_COLOR,
            fontSize: Number(t.fontSize) > 0 ? Number(t.fontSize) : DEFAULT_TEXT_FONT_SIZE,
            align: ['left', 'center', 'right'].includes(t.align) ? t.align : DEFAULT_TEXT_ALIGN,
            layerId: layerIds.has(t.layerId) ? t.layerId : defaultLayerId
          }))
      : [];
    const groups = Array.isArray(p?.groups)
      ? p.groups.filter((g) => g && g.id && Array.isArray(g.vertexIds)).map((g) => ({ id: g.id, vertexIds: g.vertexIds.filter((id) => vertexIds.has(id)) })).filter((g) => g.vertexIds.length > 1)
      : [];
    // User-drawn persistent snap axes — an editing aid, not artwork (they
    // never appear in compileVectorSvg's output), so they're just two raw
    // points, not vertex references: unlike everything else in this
    // schema they aren't meant to be part of the topology at all.
    const snapAxes = Array.isArray(p?.snapAxes)
      ? p.snapAxes
          .filter((a) => a && a.id && [a.x1, a.y1, a.x2, a.y2].every((n) => Number.isFinite(Number(n))))
          .map((a) => ({ id: a.id, x1: Number(a.x1), y1: Number(a.y1), x2: Number(a.x2), y2: Number(a.y2) }))
      : [];
    return {
      title: typeof p?.title === 'string' ? p.title : 'Untitled',
      description: typeof p?.description === 'string' ? p.description : '',
      canvas: { width: Number(p?.canvas?.width) || 1600, height: Number(p?.canvas?.height) || 1000, background: p?.canvas?.background || '#1e1e1e' },
      vertices,
      edges,
      fills,
      circles,
      texts,
      groups,
      layers,
      snapAxes
    };
  } catch {
    return makeDefaultVectorState();
  }
}


function serializeVectorState(state) {
  return JSON.stringify(
    {
      title: state.title,
      description: state.description,
      canvas: state.canvas,
      vertices: state.vertices,
      edges: state.edges,
      fills: state.fills,
      circles: state.circles,
      texts: state.texts,
      groups: state.groups,
      layers: state.layers,
      snapAxes: state.snapAxes
    },
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

// The document's own description — a full raw markdown string (frontmatter
// block plus body), edited the same way a note's content is. See
// VectorEditorView's description sidebar.
function setDescription(state, description) {
  return { ...state, description };
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

// Disconnect: a discrete, click-based counterpart to the tear-away drag
// above — for a vertex with exactly one or two incident edges, removes it
// from the path entirely rather than peeling off one edge at a time.
//   - degree 0 (already isolated): no-op.
//   - degree 1 (a dead end, A-V): removes that edge; V is left isolated.
//   - degree 2 (a through-point, A-V-C): removes both edges and adds a
//     direct A-C edge instead (using whichever edge's style is later in
//     the array, same convention as everywhere else in this file that
//     needs to pick one of two — see computeMiterJoints); V is left
//     isolated. If A-C already exists, or A and C are the same vertex
//     (a degenerate A-V-A loop), there's nothing valid to bypass with, so
//     both edges are just removed and V is left isolated either way.
//   - degree 3+: no single well-defined bypass pairing (which two of the
//     three-plus edges would it connect?), so this is a no-op — same
//     scope boundary already established for computeMiterJoints.
function disconnectVertex(state, vertexId) {
  const incident = state.edges.filter((e) => e.v1 === vertexId || e.v2 === vertexId);
  if (incident.length === 0 || incident.length > 2) return state;
  const incidentIds = new Set(incident.map((e) => e.id));
  if (incident.length === 1) {
    return pruneFills({ ...state, edges: state.edges.filter((e) => !incidentIds.has(e.id)) });
  }
  const [e1, e2] = incident;
  const other1 = e1.v1 === vertexId ? e1.v2 : e1.v1;
  const other2 = e2.v1 === vertexId ? e2.v2 : e2.v1;
  const withoutBoth = state.edges.filter((e) => !incidentIds.has(e.id));
  const bypassAlreadyExists = withoutBoth.some((e) => (e.v1 === other1 && e.v2 === other2) || (e.v1 === other2 && e.v2 === other1));
  if (other1 === other2 || bypassAlreadyExists) {
    return pruneFills({ ...state, edges: withoutBoth });
  }
  const bypass = { id: `e-${cryptoRandomId()}`, v1: other1, v2: other2, style: { ...e2.style }, layerId: e2.layerId };
  return pruneFills({ ...state, edges: [...withoutBoth, bypass] });
}

// Split: the discrete counterpart to dragging an edge endpoint past
// SEVER_THRESHOLD_PX — splits a shared vertex into as many independent,
// exactly-coincident vertices as it has incident edges, in one step
// rather than one drag per edge. The first incident edge keeps the
// original vertex id; every other gets its own brand-new vertex at the
// same point, ready to be dragged apart. No-op below degree 2 (nothing to
// split a single edge — or a bare vertex — into).
function splitVertex(state, vertexId) {
  const v = state.vertices.find((vv) => vv.id === vertexId);
  const incident = state.edges.filter((e) => e.v1 === vertexId || e.v2 === vertexId);
  if (!v || incident.length < 2) return state;
  const newVertices = [];
  let edges = state.edges;
  for (let i = 1; i < incident.length; i++) {
    const edgeId = incident[i].id;
    const newVertex = { id: `v-${cryptoRandomId()}`, x: v.x, y: v.y };
    newVertices.push(newVertex);
    edges = edges.map((e) => (e.id === edgeId ? { ...e, v1: e.v1 === vertexId ? newVertex.id : e.v1, v2: e.v2 === vertexId ? newVertex.id : e.v2 } : e));
  }
  return { ...state, vertices: [...state.vertices, ...newVertices], edges, _newVertexIds: newVertices.map((nv) => nv.id) };
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

// Deletes vertices (and every edge/fill/text that depended on them). Edges
// are found via the adjacency index, not a full-array scan, so this stays
// O(degree) per removed vertex rather than O(E). A text loses ALL 4 of its
// corners together whenever ANY one of them is deleted here — a 3- (or
// fewer-) cornered text quad isn't a meaningful shape, so there's no
// partial-survival case to handle.
function deleteVertices(state, vertexIds) {
  if (!vertexIds.size) return state;
  const { adj } = buildVertexAdjacency(state.vertices, state.edges);
  const doomedEdgeIds = new Set();
  for (const id of vertexIds) for (const eid of incidentEdgeIds(adj, id)) doomedEdgeIds.add(eid);
  const vertices = state.vertices.filter((v) => !vertexIds.has(v.id));
  const edges = state.edges.filter((e) => !doomedEdgeIds.has(e.id));
  const texts = state.texts.filter((t) => ![t.v1, t.v2, t.v3, t.v4].some((id) => vertexIds.has(id)));
  const groups = state.groups.map((g) => ({ ...g, vertexIds: g.vertexIds.filter((id) => !vertexIds.has(id)) })).filter((g) => g.vertexIds.length > 1);
  return pruneFills({ ...state, vertices, edges, texts, groups });
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

function deleteFills(state, fillIds) {
  if (!fillIds.size) return state;
  return { ...state, fills: state.fills.filter((f) => !fillIds.has(f.id)) };
}

function setFillColor(state, fillId, color) {
  return { ...state, fills: state.fills.map((f) => (f.id === fillId ? { ...f, color } : f)) };
}

// ---------------------------------------------------------------------------
// Snap axes — user-drawn reference lines that are always visible (as a
// dotted guide) in Edit mode and always available as a snap target,
// regardless of what's currently being dragged. Purely an editing aid:
// two raw points, no vertex/topology involvement, never rendered in
// compileVectorSvg's export output — the same "not real artwork" status
// as the vertex dots or a 0px-weight edge's dashed guide.
// ---------------------------------------------------------------------------
function addSnapAxis(state, x1, y1, x2, y2) {
  const axis = { id: `axis-${cryptoRandomId()}`, x1, y1, x2, y2 };
  return { ...state, snapAxes: [...state.snapAxes, axis], _newSnapAxisId: axis.id };
}

function deleteSnapAxes(state, axisIds) {
  if (!axisIds.size) return state;
  return { ...state, snapAxes: state.snapAxes.filter((a) => !axisIds.has(a.id)) };
}

function moveSnapAxis(state, axisId, dx, dy) {
  return { ...state, snapAxes: state.snapAxes.map((a) => (a.id === axisId ? { ...a, x1: a.x1 + dx, y1: a.y1 + dy, x2: a.x2 + dx, y2: a.y2 + dy } : a)) };
}

// `which` is 'p1' or 'p2' — lets either endpoint be dragged independently
// to re-aim the axis, same spirit as a circle's single resize handle.
function setSnapAxisEndpoint(state, axisId, which, point) {
  return {
    ...state,
    snapAxes: state.snapAxes.map((a) => (a.id === axisId ? { ...a, ...(which === 'p1' ? { x1: point.x, y1: point.y } : { x2: point.x, y2: point.y }) } : a))
  };
}

// ---------------------------------------------------------------------------
// Text — deliberately NOT its own graph-independent primitive the way a
// circle is. A text's 4 corners (TL, TR, BR, BL) are 4 REAL vertices in
// state.vertices, which is what gives it "move/rotate/scale, and drag any
// one corner independently to squish/stretch it into a trapezoid" for
// free: it's exactly the existing multi-vertex selection/marquee/group/
// transform-handle system (see VectorEditorView), plus the existing
// single-vertex drag for one corner, with no new selection model needed.
// Deleting any one corner (deleteVertices, updated above) takes the whole
// text with it, same as an edge loses its shape if either endpoint goes.
//
// Rendering warps a <foreignObject> onto those 4 corners via a CSS
// matrix3d homography (vectorTopology.js's computeQuadWarpMatrix3d) rather
// than storing position/rotation/scale fields — the quad IS the source of
// truth, so there's nothing else to keep in sync when a corner moves.
// ---------------------------------------------------------------------------
function addText(state, corners, content, style, layerId) {
  const v1 = { id: `v-${cryptoRandomId()}`, x: corners[0].x, y: corners[0].y };
  const v2 = { id: `v-${cryptoRandomId()}`, x: corners[1].x, y: corners[1].y };
  const v3 = { id: `v-${cryptoRandomId()}`, x: corners[2].x, y: corners[2].y };
  const v4 = { id: `v-${cryptoRandomId()}`, x: corners[3].x, y: corners[3].y };
  const text = {
    id: `t-${cryptoRandomId()}`,
    v1: v1.id,
    v2: v2.id,
    v3: v3.id,
    v4: v4.id,
    content: content || '',
    color: style?.color ?? DEFAULT_TEXT_COLOR,
    fontSize: style?.fontSize ?? DEFAULT_TEXT_FONT_SIZE,
    align: style?.align ?? DEFAULT_TEXT_ALIGN,
    layerId: layerId || state.layers[0].id
  };
  return { ...state, vertices: [...state.vertices, v1, v2, v3, v4], texts: [...state.texts, text], _newTextId: text.id, _newTextCornerIds: [v1.id, v2.id, v3.id, v4.id] };
}

function setTextContent(state, textId, content) {
  return { ...state, texts: state.texts.map((t) => (t.id === textId ? { ...t, content } : t)) };
}

function setTextStyle(state, textId, patch) {
  return { ...state, texts: state.texts.map((t) => (t.id === textId ? { ...t, ...patch } : t)) };
}

// Convenience wrapper — deletes a text by deleting its corners, which
// cascades through the ordinary deleteVertices path (including pruning any
// fill that happened to also reference one of those points).
function deleteTexts(state, textIds) {
  if (!textIds.size) return state;
  const cornerIds = new Set();
  for (const t of state.texts) {
    if (textIds.has(t.id)) [t.v1, t.v2, t.v3, t.v4].forEach((id) => cornerIds.add(id));
  }
  return deleteVertices(state, cornerIds);
}

// Resolves a text's 4 live corner points from the current vertex
// positions — null if any corner vertex is missing (shouldn't normally
// happen given the deleteVertices cascade above, but rendering stays
// defensive the same way resolveBoundaryPolygon is for fills).
function resolveTextQuad(vertices, text) {
  const vmap = new Map(vertices.map((v) => [v.id, v]));
  const corners = [vmap.get(text.v1), vmap.get(text.v2), vmap.get(text.v3), vmap.get(text.v4)];
  return corners.every(Boolean) ? corners.map((v) => ({ x: v.x, y: v.y })) : null;
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
function moveToLayer(state, { edgeIds, circleIds, textIds }, layerId) {
  return {
    ...state,
    edges: state.edges.map((e) => (edgeIds?.has(e.id) ? { ...e, layerId } : e)),
    circles: state.circles.map((c) => (circleIds?.has(c.id) ? { ...c, layerId } : c)),
    texts: state.texts.map((t) => (textIds?.has(t.id) ? { ...t, layerId } : t))
  };
}

// ---------------------------------------------------------------------------
// Copy/paste — a plain, portable snapshot (still-original ids, no
// remapping yet) of a selection's vertices/edges/circles/texts/groups.
// Deliberately excludes fills: a fill is just a flood-fill record over
// whatever boundary happens to close up at a point, not something users
// select directly (there's no fill-selection UI), and the pasted copy's
// identical shape can always be filled again with one click if wanted.
// An edge/text is only included if EVERY vertex it depends on is also in
// the selection — copying "half" a dangling edge/text wouldn't be a
// meaningful, independently-pasteable shape.
function copySelection(state, { vertexIds, circleIds, textIds }) {
  const vSet = vertexIds || new Set();
  const cSet = circleIds || new Set();
  const tSet = textIds || new Set();
  return {
    vertices: state.vertices.filter((v) => vSet.has(v.id)),
    edges: state.edges.filter((e) => vSet.has(e.v1) && vSet.has(e.v2)),
    circles: state.circles.filter((c) => cSet.has(c.id)),
    texts: state.texts.filter((t) => tSet.has(t.id)),
    groups: state.groups.filter((g) => g.vertexIds.every((id) => vSet.has(id)))
  };
}

// The inverse: takes a copySelection() snapshot and adds a fresh,
// independent copy of it to `state` — every id remapped (so pasting
// doesn't collide with the originals, and pasting the same clipboard
// twice doesn't collide with itself either), shifted by `offset`, all
// landing on `layerId`. Returns the new ids too, so the caller can select
// the pasted copy the way every other "create" mutation's _newXId does.
function pasteClipboard(state, clipboard, offset, layerId) {
  const vertexIdMap = new Map();
  const vertices = clipboard.vertices.map((v) => {
    const id = `v-${cryptoRandomId()}`;
    vertexIdMap.set(v.id, id);
    return { id, x: v.x + offset.x, y: v.y + offset.y };
  });
  const edges = clipboard.edges.map((e) => ({
    id: `e-${cryptoRandomId()}`,
    v1: vertexIdMap.get(e.v1),
    v2: vertexIdMap.get(e.v2),
    style: { ...e.style },
    layerId
  }));
  const circles = clipboard.circles.map((c) => ({
    id: `c-${cryptoRandomId()}`,
    cx: c.cx + offset.x,
    cy: c.cy + offset.y,
    r: c.r,
    style: { ...c.style },
    fill: c.fill,
    layerId
  }));
  const texts = clipboard.texts.map((t) => ({
    id: `t-${cryptoRandomId()}`,
    v1: vertexIdMap.get(t.v1),
    v2: vertexIdMap.get(t.v2),
    v3: vertexIdMap.get(t.v3),
    v4: vertexIdMap.get(t.v4),
    content: t.content,
    color: t.color,
    fontSize: t.fontSize,
    align: t.align,
    layerId
  }));
  const groups = clipboard.groups.map((g) => ({ id: `g-${cryptoRandomId()}`, vertexIds: g.vertexIds.map((id) => vertexIdMap.get(id)) }));
  return {
    state: {
      ...state,
      vertices: [...state.vertices, ...vertices],
      edges: [...state.edges, ...edges],
      circles: [...state.circles, ...circles],
      texts: [...state.texts, ...texts],
      groups: [...state.groups, ...groups]
    },
    pastedVertexIds: vertices.map((v) => v.id),
    pastedCircleIds: circles.map((c) => c.id),
    pastedTextIds: texts.map((t) => t.id)
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

// Minimal XML-escaping for text dropped into a foreignObject's XHTML —
// only the 5 characters that are ever structurally significant there.
function escapeXml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
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

      const layerTexts = state.texts.filter((t) => t.layerId === layer.id);
      // A foreignObject warped onto the 4 corners via the same
      // matrix3d homography the editor uses (computeQuadWarpMatrix3d) —
      // see the schema note on the "Text" section for why the export
      // stays a real, editable <div> of text rather than converting to
      // outlined paths (a much bigger undertaking most SVG consumers,
      // including browsers, don't actually require).
      const textsMarkup = layerTexts
        .map((t) => {
          const quad = resolveTextQuad(state.vertices, t);
          if (!quad) return '';
          const matrix = computeQuadWarpMatrix3d(quad, DEFAULT_TEXT_WIDTH, DEFAULT_TEXT_HEIGHT);
          const style = `width:${DEFAULT_TEXT_WIDTH}px;height:${DEFAULT_TEXT_HEIGHT}px;transform:${matrix};transform-origin:0 0;color:${t.color};font-size:${t.fontSize}px;text-align:${t.align};white-space:pre-wrap;word-wrap:break-word;font-family:sans-serif;line-height:1.25;`;
          // The foreignObject's own box only needs to be big enough not to
          // clip the warped div inside it (the div's CSS transform is what
          // actually positions/shapes it, via transform-origin:0 0) — the
          // full canvas size is a generous, simple bound for that, with
          // overflow="visible" as a second guard for a quad dragged
          // slightly outside the canvas.
          return `  <foreignObject x="0" y="0" width="${width}" height="${height}" overflow="visible"><div xmlns="http://www.w3.org/1999/xhtml" style="${style}">${escapeXml(t.content)}</div></foreignObject>`;
        })
        .filter(Boolean)
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

      return [fillsMarkup, circlesMarkup, textsMarkup, edgesMarkup, miterMarkup].filter(Boolean).join('\n');
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
  disconnectVertex,
  splitVertex,
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
  deleteFills,
  setFillColor,
  addSnapAxis,
  deleteSnapAxes,
  moveSnapAxis,
  setSnapAxisEndpoint,
  contrastDotColor,
  addText,
  setTextContent,
  setTextStyle,
  deleteTexts,
  resolveTextQuad,
  setDescription,
  addLayer,
  removeLayer,
  renameLayer,
  setLayerVisible,
  reorderLayer,
  moveToLayer,
  copySelection,
  pasteClipboard,
  compileVectorSvg
};
