// Pure geometry/snap helpers for VectorEditorView.jsx, plus the small
// MeasurementLabel readout component — split out so VectorEditorView.jsx
// holds only the stateful editor itself (see CLAUDE.md 3.7). Nothing here
// closes over editor state; every function takes what it needs as args.
import { VERTEX_SNAP_PX, EDGE_SNAP_PX, AXIS_SNAP_PX, subdivideEdge, addVertex } from './vectorState.js';
import { snapCandidate } from './vectorTopology.js';

const MOVE_THRESHOLD = 3; // world px before a pointerdown counts as a drag, not a click — same convention as CanvasView

// A big multiple of the guideline threshold — just long enough that an
// alignment guide reads clearly on screen without needing the real canvas
// bounds plumbed through every caller.
const GUIDE_LINE_SPAN = 4000;

// A small floating readout — background pill + centered text lines — used
// for every measurement overlay below (edge/axis length+rotation, vertex
// position/angles, circle radius, live transform deltas). Width is
// estimated from character count rather than actually measured (no DOM
// access at render time here), which is deliberately generous rather than
// exact — a slightly-wide pill is harmless, text overflowing it looks broken.
function MeasurementLabel({ x, y, lines, zoom }) {
  const fontSize = 11 / zoom;
  const lineHeight = fontSize * 1.35;
  const padX = 5 / zoom, padY = 4 / zoom;
  const maxChars = Math.max(...lines.map((l) => l.length));
  const width = maxChars * fontSize * 0.62 + padX * 2;
  const height = lines.length * lineHeight + padY * 2 - (lineHeight - fontSize);
  return (
    <g transform={`translate(${x - width / 2} ${y - height / 2})`} className="vector-measurement-label" pointerEvents="none">
      <rect width={width} height={height} rx={3 / zoom} />
      {lines.map((line, i) => (
        <text key={i} x={width / 2} y={padY + fontSize * 0.85 + i * lineHeight} textAnchor="middle" fontSize={fontSize}>
          {line}
        </text>
      ))}
    </g>
  );
}

// Normalizes to [0, 180) — an edge/axis is undirected, so a "rotation" of
// 190° and 10° describe the same line and should read identically.
function lineRotationDeg(dx, dy) {
  const deg = (Math.atan2(dy, dx) * 180) / Math.PI;
  return ((deg % 180) + 180) % 180;
}

// The angle(s) formed at a vertex by its incident edges, one per
// ADJACENT pair going around in angular order (so a degree-3 vertex gets
// 3 angles, summing to 360°) — except degree exactly 2, which gets just
// the one non-reflex angle between them (showing both it and its 360-
// complement at a plain "corner" would be redundant clutter). Each result
// includes `bisector`, the direction from the vertex that bisects that
// angle — that's where its label belongs, per the request that these sit
// "where the center of the angle would be".
function vertexAngles(others) {
  if (others.length < 2) return [];
  const withAngles = others.map((p) => ({ angle: Math.atan2(p.y, p.x) })).sort((a, b) => a.angle - b.angle);
  const n = withAngles.length;
  const pairs = n === 2 ? [[0, 1]] : withAngles.map((_, i) => [i, (i + 1) % n]);
  return pairs.map(([i, j]) => {
    const a1 = withAngles[i].angle;
    let diff = withAngles[j].angle - a1;
    while (diff < 0) diff += 2 * Math.PI;
    let angleDeg = (diff * 180) / Math.PI;
    let bisector = a1 + diff / 2;
    if (n === 2 && angleDeg > 180) {
      // The sorted pair's CCW gap was the reflex (>180°) side — the angle
      // a person actually means by "the angle between these two edges" is
      // the other, non-reflex side.
      angleDeg = 360 - angleDeg;
      bisector += Math.PI;
    }
    return { angleDeg, bisector };
  });
}

// Where two INFINITE lines (not segments — irrelevant whether the
// intersection falls within either's drawn extent) cross, or null if
// they're parallel. Used only for showing the angle where two snap axes
// cross, since axes act as infinite reference lines for snapping.
function infiniteLineIntersection(a1, a2, b1, b2) {
  const d1x = a2.x - a1.x, d1y = a2.y - a1.y;
  const d2x = b2.x - b1.x, d2y = b2.y - b1.y;
  const denom = d1x * d2y - d1y * d2x;
  if (Math.abs(denom) < 1e-9) return null;
  const t = ((b1.x - a1.x) * d2y - (b1.y - a1.y) * d2x) / denom;
  return { x: a1.x + t * d1x, y: a1.y + t * d1y };
}

// Snap thresholds are authored in screen px (vectorState.js) but every
// distance in this editor's geometry is in WORLD units, so every threshold
// gets divided by the current zoom right before use — otherwise "14px" of
// slack would mean 14 world units regardless of zoom, i.e. a hit target
// that's way too generous zoomed in and way too tight zoomed out.
function snapOpts(zoom, grid, snapToggles, opts = {}) {
  const { vertexSnapEnabled = true, edgeSnapEnabled = true, axisSnapEnabled = true } = snapToggles;
  return {
    grid,
    vertexPx: vertexSnapEnabled ? (opts.vertexPx ?? VERTEX_SNAP_PX) / zoom : -1,
    edgePx: !edgeSnapEnabled || opts.allowSubdivide === false ? -1 : EDGE_SNAP_PX / zoom,
    axisPx: axisSnapEnabled && opts.allowAxisSnap !== false ? AXIS_SNAP_PX / zoom : -1,
    // The "straighten"/"preserve direction"/custom-axis/perpendicular-
    // parallel candidate lines (opts.lines, assembled by the caller —
    // see onVertexPointerDown) all share the plain axis snap's threshold,
    // since they're all "axis alignment" snapping in spirit, just against
    // a line other than a generic horizontal/vertical guide. Each
    // category of line has its OWN on/off toggle controlling whether the
    // caller includes it in opts.lines in the first place.
    linePx: axisSnapEnabled && opts.allowAxisSnap !== false ? AXIS_SNAP_PX / zoom : -1,
    lines: opts.lines,
    excludeVertexId: opts.excludeVertexId
  };
}

// Resolves a raw click point to a usable vertex id, applying the editor's
// snap priority (vertex > edge-subdivide > axis) and creating whatever the
// snap result implies. Pure — returns the next doc plus the vertex id
// without committing it, so callers can fold a whole gesture (e.g. a
// polyline click that both places a point AND connects it to the previous
// one) into a single undo step.
//
// `snapVertices`/`snapEdges` are the pool snapCandidate is allowed to
// consider — separate from `doc` (which this still mutates in full) so the
// snap-cross-layer toggle can restrict what's snappable without touching
// what actually gets created (see edgesForSnap/verticesForSnap).
function resolvePlacement(doc, grid, rawPoint, zoom, snapToggles, opts = {}, snapVertices = doc.vertices, snapEdges = doc.edges) {
  const snap = snapCandidate(snapVertices, snapEdges, rawPoint, snapOpts(zoom, grid, snapToggles, opts));
  if (snap.snappedVertexId) return { nextDoc: doc, vertexId: snap.snappedVertexId, snap };
  if (snap.snappedEdgeId) {
    const nextDoc = subdivideEdge(doc, snap.snappedEdgeId, snap.point);
    return { nextDoc, vertexId: nextDoc._newVertexId, snap };
  }
  const nextDoc = addVertex(doc, snap.point.x, snap.point.y);
  return { nextDoc, vertexId: nextDoc._newVertexId, snap };
}

function bboxOf(vertices, ids) {
  const pts = vertices.filter((v) => ids.has(v.id));
  if (!pts.length) return null;
  const xs = pts.map((p) => p.x), ys = pts.map((p) => p.y);
  return { minX: Math.min(...xs), maxX: Math.max(...xs), minY: Math.min(...ys), maxY: Math.max(...ys) };
}

// Same as bboxOf, but also folding in selected circles' extents (cx±r) —
// used for the shared selection box so a mixed vertex/edge/circle
// selection gets one bounding box and one set of transform handles,
// rather than circles being unable to join a group transform at all.
function combinedBboxOf(vertices, vertexIds, circles, circleIds) {
  const pts = vertices.filter((v) => vertexIds.has(v.id)).map((v) => ({ x: v.x, y: v.y }));
  for (const c of circles) {
    if (!circleIds.has(c.id)) continue;
    pts.push({ x: c.cx - c.r, y: c.cy - c.r }, { x: c.cx + c.r, y: c.cy + c.r });
  }
  if (!pts.length) return null;
  const xs = pts.map((p) => p.x), ys = pts.map((p) => p.y);
  return { minX: Math.min(...xs), maxX: Math.max(...xs), minY: Math.min(...ys), maxY: Math.max(...ys) };
}

// Corner and edge-midpoint transform handles for a selection bounding box.
// Edge-midpoint handles are axis-locked (top/bottom scale height only,
// left/right scale width only) — `anchor` is always the OPPOSITE side/
// corner, since that's what stays fixed while dragging.
function handleConfigsFor(box) {
  const midX = (box.minX + box.maxX) / 2;
  const midY = (box.minY + box.maxY) / 2;
  return [
    { key: 'nw', x: box.minX, y: box.minY, anchor: { x: box.maxX, y: box.maxY }, axisLock: null, cursor: 'nwse-resize' },
    { key: 'ne', x: box.maxX, y: box.minY, anchor: { x: box.minX, y: box.maxY }, axisLock: null, cursor: 'nesw-resize' },
    { key: 'sw', x: box.minX, y: box.maxY, anchor: { x: box.maxX, y: box.minY }, axisLock: null, cursor: 'nesw-resize' },
    { key: 'se', x: box.maxX, y: box.maxY, anchor: { x: box.minX, y: box.minY }, axisLock: null, cursor: 'nwse-resize' },
    { key: 'n', x: midX, y: box.minY, anchor: { x: box.minX, y: box.maxY }, axisLock: 'y', cursor: 'ns-resize' },
    { key: 's', x: midX, y: box.maxY, anchor: { x: box.minX, y: box.minY }, axisLock: 'y', cursor: 'ns-resize' },
    { key: 'w', x: box.minX, y: midY, anchor: { x: box.maxX, y: box.minY }, axisLock: 'x', cursor: 'ew-resize' },
    { key: 'e', x: box.maxX, y: midY, anchor: { x: box.minX, y: box.minY }, axisLock: 'x', cursor: 'ew-resize' }
  ];
}


export {
  MOVE_THRESHOLD,
  GUIDE_LINE_SPAN,
  MeasurementLabel,
  lineRotationDeg,
  vertexAngles,
  infiniteLineIntersection,
  snapOpts,
  resolvePlacement,
  bboxOf,
  combinedBboxOf,
  handleConfigsFor
};
