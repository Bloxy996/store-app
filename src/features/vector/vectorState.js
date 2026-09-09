import { findMinimalFaceContainingPoint, incidentEdgeIds, buildVertexAdjacency } from './vectorTopology.js';

// ============================================================================
// VECTOR ART DOCUMENT — a strict node/edge graph, stored as JSON inside a
// ".vec" file. Same "just JSON through the debounced Drive-save pipeline" as
// the Canvas/Database sections. Schema:
//
//   { title, description,
//     canvas: { width, height, background },
//     vertices: [ { id, x, y } ],
//     edges:    [ { id, v1, v2, style: { color, thickness } } ],
//     fills:    [ { id, seed: {x,y}, color } ] }
//
// Design notes (see also the rewritten build spec this ships against):
//  - Edges are undirected and ALWAYS carry their own explicit style — there
//    is no vertex style and no inheritance, so there's never a conflict to
//    resolve when an edge's two endpoints belong to differently-styled
//    edges elsewhere in the graph.
//  - `fills` stores the user's actual choice (a seed point + a color) — that
//    part is authoritative, exactly like a vertex position. What's NOT
//    stored is which vertex/edge cycle currently bounds that seed point;
//    that's recomputed on every render/export via
//    findMinimalFaceContainingPoint (vectorTopology.js), consistent with the
//    spec's "Fill Cycle list is derived, not authoritative" rule. If an edit
//    leaves a fill's seed point no longer enclosed by anything, it simply
//    stops rendering rather than being force-deleted — the user can always
//    re-fill.
//  - No multi-edges and no self-loops: addEdge is a no-op (returns the
//    state unchanged, `ok:false`) if the two vertices already share an edge
//    or are the same vertex.
// ============================================================================

const VECTOR_COLORS = ['#e0555a', '#e0a63d', '#d8c34a', '#6fcf97', '#4fb0c6', '#9b7fd1', '#dcddde'];

const VECTOR_THICKNESSES = [1, 2, 3, 5, 8, 12];

const DEFAULT_STYLE = { color: VECTOR_COLORS[6], thickness: 2 };

const VECTOR_ZOOM_MIN = 0.1;
const VECTOR_ZOOM_MAX = 6;

// Screen-px thresholds for snapping/hit-testing — divided by zoom before use
// so they stay visually constant regardless of zoom level (same convention
// CanvasView uses for CANVAS_CONNECT_NEAR_PX).
const VERTEX_SNAP_PX = 14;
const VERTEX_HIT_PX = 10;
const EDGE_SNAP_PX = 8;
const AXIS_SNAP_PX = 6;

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
    groups: []
  };
}


// Tolerant parse: malformed/foreign JSON yields a fresh empty document
// rather than crashing the pane, same convention as parseCanvasContent.
function parseVectorContent(content) {
  if (!content || !content.trim()) return makeDefaultVectorState();
  try {
    const p = JSON.parse(content);
    const vertices = Array.isArray(p?.vertices) ? p.vertices.filter((v) => v && v.id).map((v) => ({ id: v.id, x: Number(v.x) || 0, y: Number(v.y) || 0 })) : [];
    const vertexIds = new Set(vertices.map((v) => v.id));
    const edges = Array.isArray(p?.edges)
      ? p.edges
          .filter((e) => e && e.id && vertexIds.has(e.v1) && vertexIds.has(e.v2) && e.v1 !== e.v2)
          .map((e) => ({ id: e.id, v1: e.v1, v2: e.v2, style: { color: e.style?.color || DEFAULT_STYLE.color, thickness: Number(e.style?.thickness) || DEFAULT_STYLE.thickness } }))
      : [];
    const fills = Array.isArray(p?.fills) ? p.fills.filter((f) => f && f.id && f.seed && f.color).map((f) => ({ id: f.id, seed: { x: Number(f.seed.x) || 0, y: Number(f.seed.y) || 0 }, color: f.color })) : [];
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
      groups
    };
  } catch {
    return makeDefaultVectorState();
  }
}


function serializeVectorState(state) {
  return JSON.stringify(
    { title: state.title, description: state.description, canvas: state.canvas, vertices: state.vertices, edges: state.edges, fills: state.fills, groups: state.groups },
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
function addEdge(state, v1, v2, style) {
  if (v1 === v2 || edgeExists(state, v1, v2)) return { state, ok: false };
  const edge = { id: `e-${cryptoRandomId()}`, v1, v2, style: { ...DEFAULT_STYLE, ...style } };
  return { state: { ...state, edges: [...state.edges, edge] }, ok: true, edgeId: edge.id };
}

function moveVertex(state, vertexId, x, y) {
  return { ...state, vertices: state.vertices.map((v) => (v.id === vertexId ? { ...v, x, y } : v)) };
}

// Bulk move for marquee-drag / global transform — `deltas` is
// Map(vertexId -> {x, y}) of ABSOLUTE new positions.
function moveVertices(state, deltas) {
  if (!deltas.size) return state;
  return { ...state, vertices: state.vertices.map((v) => (deltas.has(v.id) ? { ...v, ...deltas.get(v.id) } : v)) };
}

function setEdgeStyle(state, edgeId, style) {
  return { ...state, edges: state.edges.map((e) => (e.id === edgeId ? { ...e, style: { ...e.style, ...style } } : e)) };
}

// Vertex Insertion (Subdivision): E(v1,v2) -> V_new + E1(v1,V_new) +
// E2(V_new,v2), both inheriting the original edge's style.
function subdivideEdge(state, edgeId, point) {
  const edge = state.edges.find((e) => e.id === edgeId);
  if (!edge) return state;
  const newVertex = { id: `v-${cryptoRandomId()}`, x: point.x, y: point.y };
  const e1 = { id: `e-${cryptoRandomId()}`, v1: edge.v1, v2: newVertex.id, style: { ...edge.style } };
  const e2 = { id: `e-${cryptoRandomId()}`, v1: newVertex.id, v2: edge.v2, style: { ...edge.style } };
  return {
    ...state,
    vertices: [...state.vertices, newVertex],
    edges: [...state.edges.filter((e) => e.id !== edgeId), e1, e2],
    _newVertexId: newVertex.id
  };
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
  // Fills whose seed no longer resolves to any face just stop rendering
  // (see the schema note above) rather than being pruned here.
  return { ...state, vertices, edges, groups };
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

function deleteEdges(state, edgeIds) {
  if (!edgeIds.size) return state;
  return { ...state, edges: state.edges.filter((e) => !edgeIds.has(e.id)) };
}

// Vector Flood Fill: resolves the minimal enclosing face under `point` and
// records a fill there, replacing any existing fill that resolves to the
// same face (so re-clicking a filled region just changes its color instead
// of stacking a duplicate fill entry).
function addFillAt(state, point, color) {
  const face = findMinimalFaceContainingPoint(state.vertices, state.edges, point);
  if (!face) return { state, ok: false };
  const fills = state.fills.filter((f) => !isPointInPolygon(f.seed, face.points));
  const fill = { id: `f-${cryptoRandomId()}`, seed: point, color };
  return { state: { ...state, fills: [...fills, fill] }, ok: true };
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
function compileVectorSvg(state) {
  const { width, height, background } = state.canvas;
  const sortedEdges = [...state.edges].sort((a, b) => a.style.thickness - b.style.thickness);
  const fillsMarkup = state.fills
    .map((f) => {
      const face = findMinimalFaceContainingPoint(state.vertices, state.edges, f.seed);
      if (!face) return '';
      const pts = face.points.map((p) => `${p.x},${p.y}`).join(' ');
      return `  <polygon points="${pts}" fill="${f.color}" stroke="none" />`;
    })
    .filter(Boolean)
    .join('\n');
  const vertexById = new Map(state.vertices.map((v) => [v.id, v]));
  const edgesMarkup = sortedEdges
    .map((e) => {
      const a = vertexById.get(e.v1);
      const b = vertexById.get(e.v2);
      if (!a || !b) return '';
      return `  <line x1="${a.x}" y1="${a.y}" x2="${b.x}" y2="${b.y}" stroke="${e.style.color}" stroke-width="${e.style.thickness}" stroke-linecap="butt" stroke-linejoin="miter" />`;
    })
    .filter(Boolean)
    .join('\n');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">\n  <rect x="0" y="0" width="${width}" height="${height}" fill="${background}" />\n${fillsMarkup ? fillsMarkup + '\n' : ''}${edgesMarkup}\n</svg>\n`;
}

export {
  VECTOR_COLORS,
  VECTOR_THICKNESSES,
  DEFAULT_STYLE,
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
  subdivideEdge,
  severEdgeEndpoint,
  deleteVertices,
  deleteEdges,
  addFillAt,
  groupVertices,
  ungroupVertices,
  groupIdForVertex,
  groupVertexIds,
  compileVectorSvg
};
