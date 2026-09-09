// ============================================================================
// VECTOR TOPOLOGY ENGINE — the graph-theory core of the Topological Vector
// Art Editor (.vec files). Everything here is pure functions over plain
// {vertices, edges} data (see vectorState.js for the file schema) — no React,
// no mutation of its inputs.
//
// Scope note (read before "improving" this file): a true DCEL keeps live
// half-edge `next`/`prev`/`twin` pointers that are incrementally patched on
// every topology edit. This engine instead REBUILDS the half-edge adjacency
// from the flat Vertex/Edge arrays on demand (buildVertexAdjacency), and the
// face list on demand (traceFaces). For a vector *art* document (tens to a
// few hundred vertices, not a CAD mesh), an O(V log V + E) rebuild per edit
// is cheap and removes an entire class of pointer-maintenance bugs. If this
// is ever pointed at much larger graphs, promote buildVertexAdjacency's
// output into state that's patched incrementally instead of rebuilt.
// ============================================================================

// ---------------------------------------------------------------------------
// Spatial index — uniform grid buckets, used so vertex/edge hit-testing and
// snapping don't do an O(V) scan on every pointer move. Not a quadtree (a
// quadtree adapts cell size to point density, which matters more for very
// uneven distributions); a fixed grid is simpler to keep correct and is
// plenty for the point counts this editor deals with.
// ---------------------------------------------------------------------------
const GRID_CELL_SIZE = 80; // world units per bucket

class SpatialGrid {
  constructor(cellSize = GRID_CELL_SIZE) {
    this.cellSize = cellSize;
    this.buckets = new Map(); // "cx,cy" -> Set(vertexId)
    this.posById = new Map(); // vertexId -> {x,y} (last known position, for remove)
  }

  _key(cx, cy) {
    return `${cx},${cy}`;
  }

  _cellOf(x, y) {
    return [Math.floor(x / this.cellSize), Math.floor(y / this.cellSize)];
  }

  clear() {
    this.buckets.clear();
    this.posById.clear();
  }

  rebuild(vertices) {
    this.clear();
    for (const v of vertices) this.insert(v.id, v.x, v.y);
  }

  insert(id, x, y) {
    const [cx, cy] = this._cellOf(x, y);
    const key = this._key(cx, cy);
    if (!this.buckets.has(key)) this.buckets.set(key, new Set());
    this.buckets.get(key).add(id);
    this.posById.set(id, { x, y });
  }

  remove(id) {
    const pos = this.posById.get(id);
    if (!pos) return;
    const [cx, cy] = this._cellOf(pos.x, pos.y);
    const key = this._key(cx, cy);
    this.buckets.get(key)?.delete(id);
    this.posById.delete(id);
  }

  // All ids in cells overlapping a circle of `radius` around (x,y). May
  // include a few ids slightly outside the radius (cell-grained, not exact)
  // — callers do the precise distance check themselves.
  queryRadius(x, y, radius) {
    const [minCx, minCy] = this._cellOf(x - radius, y - radius);
    const [maxCx, maxCy] = this._cellOf(x + radius, y + radius);
    const out = [];
    for (let cx = minCx; cx <= maxCx; cx++) {
      for (let cy = minCy; cy <= maxCy; cy++) {
        const bucket = this.buckets.get(this._key(cx, cy));
        if (bucket) for (const id of bucket) out.push(id);
      }
    }
    return out;
  }
}

// ---------------------------------------------------------------------------
// Basic geometry
// ---------------------------------------------------------------------------
function dist(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

// Closest point on segment ab to point p, plus the distance and t in [0,1].
function closestPointOnSegment(p, a, b) {
  const abx = b.x - a.x;
  const aby = b.y - a.y;
  const lenSq = abx * abx + aby * aby;
  let t = lenSq > 0 ? ((p.x - a.x) * abx + (p.y - a.y) * aby) / lenSq : 0;
  t = Math.max(0, Math.min(1, t));
  const point = { x: a.x + abx * t, y: a.y + aby * t };
  return { point, t, dist: dist(p, point) };
}

// Point-in-polygon, standard even-odd ray cast. `poly` is [{x,y}, ...].
function pointInPolygon(p, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i].x, yi = poly[i].y;
    const xj = poly[j].x, yj = poly[j].y;
    const intersects = yi > p.y !== yj > p.y && p.x < ((xj - xi) * (p.y - yi)) / (yj - yi) + xi;
    if (intersects) inside = !inside;
  }
  return inside;
}

// Shoelace area (unsigned) — used only to rank candidate faces by size, so
// sign/winding direction doesn't matter here.
function polygonArea(poly) {
  let a = 0;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    a += poly[j].x * poly[i].y - poly[i].x * poly[j].y;
  }
  return Math.abs(a) / 2;
}

// Proper segment-segment intersection (excludes endpoint touches — those are
// shared vertices, not crossings, and are already real graph connections).
function segmentIntersection(a1, a2, b1, b2) {
  const d1x = a2.x - a1.x, d1y = a2.y - a1.y;
  const d2x = b2.x - b1.x, d2y = b2.y - b1.y;
  const denom = d1x * d2y - d1y * d2x;
  if (Math.abs(denom) < 1e-9) return null; // parallel/collinear
  const t = ((b1.x - a1.x) * d2y - (b1.y - a1.y) * d2x) / denom;
  const u = ((b1.x - a1.x) * d1y - (b1.y - a1.y) * d1x) / denom;
  const eps = 1e-6;
  if (t <= eps || t >= 1 - eps || u <= eps || u >= 1 - eps) return null; // touches an endpoint, not a true crossing
  return { x: a1.x + d1x * t, y: a1.y + d1y * t, t, u };
}

// ---------------------------------------------------------------------------
// Adjacency (angular order around each vertex) — the building block face
// tracing walks. See the module comment: rebuilt on demand, not cached.
// ---------------------------------------------------------------------------
function buildVertexAdjacency(vertices, edges) {
  const vmap = new Map(vertices.map((v) => [v.id, v]));
  const adj = new Map();
  for (const v of vertices) adj.set(v.id, []);
  for (const e of edges) {
    if (!adj.has(e.v1) || !adj.has(e.v2)) continue; // dangling reference — ignore rather than throw
    adj.get(e.v1).push({ to: e.v2, edgeId: e.id });
    adj.get(e.v2).push({ to: e.v1, edgeId: e.id });
  }
  for (const [id, list] of adj) {
    const v = vmap.get(id);
    list.sort((a, b) => Math.atan2(vmap.get(a.to).y - v.y, vmap.get(a.to).x - v.x) - Math.atan2(vmap.get(b.to).y - v.y, vmap.get(b.to).x - v.x));
  }
  return { vmap, adj };
}

// Every incident edge id for a vertex — O(1) via the adjacency map, used by
// vertex-move and vertex-delete so those stay O(degree), not O(E).
function incidentEdgeIds(adj, vertexId) {
  return (adj.get(vertexId) || []).map((he) => he.edgeId);
}

// ---------------------------------------------------------------------------
// Face tracing — classic planar-graph face walk: at the vertex a half-edge
// arrives at, the next half-edge of the SAME face is the one immediately
// after this half-edge's twin, in that vertex's angularly-sorted order.
// Walking every directed half-edge exactly once this way yields every face
// of the arrangement, including the unbounded "outside" face(s) — this
// function does not try to tell those apart (see findMinimalFaceContaining,
// which sidesteps that by picking the smallest face that contains a point
// rather than classifying inside/outside up front).
// ---------------------------------------------------------------------------
function traceFaces(vertices, edges) {
  const { vmap, adj } = buildVertexAdjacency(vertices, edges);
  const visited = new Set();
  const faces = [];
  const guardLimit = vertices.length + edges.length * 2 + 8;

  for (const e of edges) {
    for (const [u0, v0] of [[e.v1, e.v2], [e.v2, e.v1]]) {
      const startKey = `${u0}->${v0}`;
      if (visited.has(startKey)) continue;
      const vertexIds = [];
      let u = u0, v = v0, steps = 0;
      while (steps < guardLimit) {
        const key = `${u}->${v}`;
        if (visited.has(key)) break;
        visited.add(key);
        vertexIds.push(v);
        const list = adj.get(v) || [];
        const twinIdx = list.findIndex((he) => he.to === u);
        if (twinIdx === -1) break;
        const nextEntry = list[(twinIdx + 1) % list.length];
        u = v;
        v = nextEntry.to;
        steps++;
        if (u === u0 && v === v0) break; // closed the loop back to the start
      }
      if (vertexIds.length >= 3) {
        faces.push({ vertexIds, points: vertexIds.map((id) => vmap.get(id)) });
      }
    }
  }
  return faces;
}

// ---------------------------------------------------------------------------
// Fill-only planarization — per the editor's rule, two edges that visually
// cross without sharing a Vertex ID are treated as connected ONLY for face
// detection. This builds a throwaway copy of the graph with synthetic split
// vertices at every crossing, for traceFaces to run against; it never
// touches the real (editable) vertices/edges arrays.
// ---------------------------------------------------------------------------
function planarizeForFill(vertices, edges) {
  // 1. Find every proper crossing, grouped by which edge it falls on.
  const crossingsByEdge = new Map(edges.map((e) => [e.id, []]));
  const vmap = new Map(vertices.map((v) => [v.id, v]));
  const syntheticPoints = []; // {x,y} deduped list; index used as a stable synthetic id
  const syntheticSourceEdges = []; // parallel array: the [edgeIdA, edgeIdB] whose crossing produced syntheticPoints[i]

  const findOrAddSynthetic = (pt, edgeIdA, edgeIdB) => {
    const eps = 0.5;
    for (let i = 0; i < syntheticPoints.length; i++) {
      if (Math.abs(syntheticPoints[i].x - pt.x) < eps && Math.abs(syntheticPoints[i].y - pt.y) < eps) return i;
    }
    syntheticPoints.push({ x: pt.x, y: pt.y });
    syntheticSourceEdges.push([edgeIdA, edgeIdB]);
    return syntheticPoints.length - 1;
  };

  for (let i = 0; i < edges.length; i++) {
    for (let j = i + 1; j < edges.length; j++) {
      const ea = edges[i], eb = edges[j];
      if (ea.v1 === eb.v1 || ea.v1 === eb.v2 || ea.v2 === eb.v1 || ea.v2 === eb.v2) continue; // shares a real vertex — a real connection, not a crossing
      const a1 = vmap.get(ea.v1), a2 = vmap.get(ea.v2), b1 = vmap.get(eb.v1), b2 = vmap.get(eb.v2);
      if (!a1 || !a2 || !b1 || !b2) continue;
      const hit = segmentIntersection(a1, a2, b1, b2);
      if (!hit) continue;
      const synId = findOrAddSynthetic(hit, ea.id, eb.id);
      crossingsByEdge.get(ea.id).push({ t: hit.t, synId });
      crossingsByEdge.get(eb.id).push({ t: hit.u, synId });
    }
  }

  // vertexSourceEdges maps every synthetic vertex id back to the two real
  // edge ids that cross there, so a fill boundary that passes through it can
  // be re-resolved later purely from live edge endpoints (see
  // resolveBoundaryPolygon) instead of a fixed point that goes stale the
  // moment either crossing edge moves.
  const vertexSourceEdges = new Map();
  if (syntheticPoints.length === 0) return { vertices, edges, vertexSourceEdges }; // common case — nothing to planarize, reuse the real arrays

  const pVertices = vertices.slice();
  const synVertexIds = syntheticPoints.map((pt, i) => {
    const id = `__fillsyn_${i}`;
    pVertices.push({ id, x: pt.x, y: pt.y });
    vertexSourceEdges.set(id, syntheticSourceEdges[i]);
    return id;
  });

  const pEdges = [];
  let n = 0;
  for (const e of edges) {
    const crossings = crossingsByEdge.get(e.id);
    if (!crossings || crossings.length === 0) {
      pEdges.push(e);
      continue;
    }
    crossings.sort((a, b) => a.t - b.t);
    let prevId = e.v1;
    for (const c of crossings) {
      const synVid = synVertexIds[c.synId];
      if (synVid !== prevId) pEdges.push({ id: `__fillsplit_${n++}`, v1: prevId, v2: synVid });
      prevId = synVid;
    }
    if (prevId !== e.v2) pEdges.push({ id: `__fillsplit_${n++}`, v1: prevId, v2: e.v2 });
  }

  return { vertices: pVertices, edges: pEdges, vertexSourceEdges };
}

// Given a click point, finds the smallest traced face (by area) that
// contains it — see the module comment on traceFaces for why "smallest
// containing" needs no outer/inner classification — and converts its
// boundary into a STRUCTURAL spec: a list of components each referencing
// real vertex ids (or, at a fill-only crossing, the two real edge ids that
// cross there) rather than a fixed set of coordinates. That's what makes a
// fill survive vertices moving: resolveBoundaryPolygon (below) re-derives
// the actual points from wherever those vertices/edges currently are,
// every time it's called, instead of a snapshot taken at fill-time.
function findFillBoundary(vertices, edges, point) {
  const { vertices: pv, edges: pe, vertexSourceEdges } = planarizeForFill(vertices, edges);
  const faces = traceFaces(pv, pe);
  let best = null;
  let bestArea = Infinity;
  for (const f of faces) {
    if (!pointInPolygon(point, f.points)) continue;
    const area = polygonArea(f.points);
    if (area < bestArea) {
      bestArea = area;
      best = f;
    }
  }
  if (!best) return null;
  const boundary = best.vertexIds.map((id) => {
    const crossing = vertexSourceEdges.get(id);
    return crossing ? { type: 'crossing', edgeA: crossing[0], edgeB: crossing[1] } : { type: 'vertex', id };
  });
  return boundary;
}

// The inverse of findFillBoundary: turns a structural boundary spec back
// into concrete {x,y} points using the CURRENT vertices/edges. Returns null
// if anything the boundary depends on no longer exists (a referenced vertex
// was deleted) or no longer crosses (the two edges at a 'crossing' entry no
// longer intersect) — callers use a null result to drop the fill.
function resolveBoundaryPolygon(vertices, edges, boundary) {
  const vmap = new Map(vertices.map((v) => [v.id, v]));
  const emap = new Map(edges.map((e) => [e.id, e]));
  const points = [];
  for (const comp of boundary) {
    if (comp.type === 'vertex') {
      const v = vmap.get(comp.id);
      if (!v) return null;
      points.push({ x: v.x, y: v.y });
    } else {
      const ea = emap.get(comp.edgeA);
      const eb = emap.get(comp.edgeB);
      if (!ea || !eb) return null;
      const a1 = vmap.get(ea.v1), a2 = vmap.get(ea.v2), b1 = vmap.get(eb.v1), b2 = vmap.get(eb.v2);
      if (!a1 || !a2 || !b1 || !b2) return null;
      const hit = segmentIntersection(a1, a2, b1, b2);
      if (!hit) return null; // the two edges no longer cross — this fill's boundary no longer exists
      points.push({ x: hit.x, y: hit.y });
    }
  }
  return points;
}

// True if every vertex/edge a boundary depends on still exists in the given
// sets — used to prune fills after a delete without paying for a full
// segment-intersection re-check (deletion invalidates by ID, not geometry).
function boundaryReferencesOnly(boundary, vertexIdSet, edgeIdSet) {
  return boundary.every((comp) => (comp.type === 'vertex' ? vertexIdSet.has(comp.id) : edgeIdSet.has(comp.edgeA) && edgeIdSet.has(comp.edgeB)));
}

// ---------------------------------------------------------------------------
// Snapping — priority order per the editor's rules: an existing Vertex
// within threshold wins outright; otherwise a point on an existing Edge
// (which subdivides it); otherwise axis/alignment snap against nearby
// vertices; otherwise the raw point.
// ---------------------------------------------------------------------------
function snapCandidate(vertices, edges, rawPoint, opts) {
  const { grid, vertexPx, edgePx, axisPx, excludeVertexId } = opts;

  const nearVertexIds = grid ? grid.queryRadius(rawPoint.x, rawPoint.y, vertexPx) : vertices.map((v) => v.id);
  let bestVertex = null, bestVertexDist = Infinity;
  for (const id of nearVertexIds) {
    if (id === excludeVertexId) continue;
    const v = vertices.find((vv) => vv.id === id);
    if (!v) continue;
    const d = dist(rawPoint, v);
    if (d < vertexPx && d < bestVertexDist) {
      bestVertexDist = d;
      bestVertex = v;
    }
  }
  if (bestVertex) return { point: { x: bestVertex.x, y: bestVertex.y }, snappedVertexId: bestVertex.id };

  let bestEdge = null, bestEdgeDist = Infinity, bestEdgePoint = null, bestEdgeT = 0;
  for (const e of edges) {
    if (e.v1 === excludeVertexId || e.v2 === excludeVertexId) continue;
    const a = vertices.find((v) => v.id === e.v1);
    const b = vertices.find((v) => v.id === e.v2);
    if (!a || !b) continue;
    const res = closestPointOnSegment(rawPoint, a, b);
    if (res.dist < edgePx && res.dist < bestEdgeDist) {
      bestEdgeDist = res.dist;
      bestEdge = e;
      bestEdgePoint = res.point;
      bestEdgeT = res.t;
    }
  }
  if (bestEdge) return { point: bestEdgePoint, snappedEdgeId: bestEdge.id, snappedEdgeT: bestEdgeT };

  // Axis/alignment snap: pull the raw point onto a nearby vertex's x or y
  // if it's close on just that one axis. Tracks which vertex produced each
  // axis's snap (axisSnapVertexX/Y) purely so the UI can draw a guideline
  // through it — irrelevant to the resulting point itself.
  let snappedX = rawPoint.x, snappedY = rawPoint.y, axisSnapped = false;
  let axisSnapVertexX = null, axisSnapVertexY = null;
  let bestDx = axisPx, bestDy = axisPx;
  for (const v of vertices) {
    if (v.id === excludeVertexId) continue;
    const dx = Math.abs(v.x - rawPoint.x);
    const dy = Math.abs(v.y - rawPoint.y);
    if (dx < bestDx) {
      bestDx = dx;
      snappedX = v.x;
      axisSnapped = true;
      axisSnapVertexX = v.id;
    }
    if (dy < bestDy) {
      bestDy = dy;
      snappedY = v.y;
      axisSnapped = true;
      axisSnapVertexY = v.id;
    }
  }
  return { point: { x: snappedX, y: snappedY }, axisSnapped, axisSnapVertexX, axisSnapVertexY };
}

export {
  SpatialGrid,
  dist,
  closestPointOnSegment,
  pointInPolygon,
  polygonArea,
  buildVertexAdjacency,
  incidentEdgeIds,
  traceFaces,
  planarizeForFill,
  findFillBoundary,
  resolveBoundaryPolygon,
  boundaryReferencesOnly,
  snapCandidate
};
