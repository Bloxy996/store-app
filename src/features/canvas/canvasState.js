

// ============================================================================
// CANVAS BOARD — an Obsidian-style infinite canvas, stored as JSON inside a
// ".canvas" file. Same "just JSON through the debounced Drive-save pipeline"
// approach as the Database section above (see the file-format note at
// CANVAS_EXTENSIONS near the top of this file). Schema:
//
//   { nodes: [
//       { id, type:'text',  x,y,width,height, color, text },
//       { id, type:'file',  x,y,width,height, color, file: <driveFileId> },
//       { id, type:'link',  x,y,width,height, color, url },
//       { id, type:'group', x,y,width,height, color, label }
//     ],
//     edges: [ { id, fromNode, fromSide, toNode, toSide, color, label } ] }
//
// Performance notes (see also the mobile/perf pass elsewhere in this file):
//  - Node drag/resize never calls `onChange` per pixel. Live movement is
//    tracked in a `liveOverrides` Map, batched to one state update per
//    animation frame (see scheduleLiveOverrides), and only merged into the
//    real (persisted) state — one single onChange/save — on pointer-up.
//  - A plain click (pointerdown+up with no real movement) never touches
//    state at all, so opening a canvas and clicking around doesn't spam
//    Drive with saves.
// ============================================================================
const CANVAS_MIN_W = 120;

const CANVAS_MIN_H = 60;

const CANVAS_COLORS = ['#e0555a', '#e0a63d', '#d8c34a', '#6fcf97', '#4fb0c6', '#9b7fd1'];

const CANVAS_ZOOM_MIN = 0.1;

const CANVAS_ZOOM_MAX = 3;

const CANVAS_MOVE_THRESHOLD = 3; // world px before a pointerdown counts as a drag, not a click


function makeDefaultCanvasState() {
  return { nodes: [], edges: [] };
}


// Tolerant parse: malformed/foreign JSON just yields a fresh empty canvas
// rather than crashing the pane, same convention as parseDatabaseContent.
function parseCanvasContent(content) {
  if (!content || !content.trim()) return makeDefaultCanvasState();
  try {
    const p = JSON.parse(content);
    const nodes = Array.isArray(p?.nodes)
      ? p.nodes.filter((n) => n && n.id && n.type).map((n) => ({
          width: CANVAS_MIN_W,
          height: CANVAS_MIN_H,
          x: 0,
          y: 0,
          ...n
        }))
      : [];
    const edges = Array.isArray(p?.edges) ? p.edges.filter((e) => e && e.id && e.fromNode && e.toNode) : [];
    return { nodes, edges };
  } catch {
    return makeDefaultCanvasState();
  }
}


function serializeCanvasState(state) {
  return JSON.stringify({ nodes: state.nodes, edges: state.edges }, null, 2);
}


function canvasNodeRect(node) {
  return {
    left: node.x,
    top: node.y,
    right: node.x + node.width,
    bottom: node.y + node.height,
    cx: node.x + node.width / 2,
    cy: node.y + node.height / 2
  };
}


function canvasSideAnchor(node, side) {
  const r = canvasNodeRect(node);
  if (side === 'top') return { x: r.cx, y: r.top };
  if (side === 'bottom') return { x: r.cx, y: r.bottom };
  if (side === 'left') return { x: r.left, y: r.cy };
  return { x: r.right, y: r.cy };
}


function canvasOppositeSide(side) {
  return side === 'top' ? 'bottom' : side === 'bottom' ? 'top' : side === 'left' ? 'right' : 'left';
}


// Whichever side of `node` is closest to world point `pt` — used when an
// edge is dropped onto a node's body rather than one of its 4 dots.
function canvasNearestSide(node, pt) {
  const r = canvasNodeRect(node);
  const d = { top: Math.abs(pt.y - r.top), bottom: Math.abs(pt.y - r.bottom), left: Math.abs(pt.x - r.left), right: Math.abs(pt.x - r.right) };
  return Object.keys(d).reduce((a, b) => (d[a] <= d[b] ? a : b));
}


function canvasHitTest(nodes, pt, excludeId) {
  for (let i = nodes.length - 1; i >= 0; i--) {
    const n = nodes[i];
    if (n.id === excludeId || n.type === 'group') continue;
    if (pt.x >= n.x && pt.x <= n.x + n.width && pt.y >= n.y && pt.y <= n.y + n.height) return n;
  }
  return null;
}


// A gently-curved connector (Obsidian-style): control points are pulled
// straight out from each anchor along its side's normal, so the curve
// always leaves/arrives perpendicular to the card it's attached to.
function canvasEdgePath(from, fromSide, to, toSide) {
  const pull = Math.max(30, Math.min(140, Math.hypot(to.x - from.x, to.y - from.y) / 2));
  const off = (side) => (side === 'top' ? { x: 0, y: -pull } : side === 'bottom' ? { x: 0, y: pull } : side === 'left' ? { x: -pull, y: 0 } : { x: pull, y: 0 });
  const o1 = off(fromSide);
  const o2 = off(toSide);
  return `M ${from.x} ${from.y} C ${from.x + o1.x} ${from.y + o1.y}, ${to.x + o2.x} ${to.y + o2.y}, ${to.x} ${to.y}`;
}

export { CANVAS_MIN_W, CANVAS_MIN_H, CANVAS_COLORS, CANVAS_ZOOM_MIN, CANVAS_ZOOM_MAX, CANVAS_MOVE_THRESHOLD, makeDefaultCanvasState, parseCanvasContent, serializeCanvasState, canvasNodeRect, canvasSideAnchor, canvasOppositeSide, canvasNearestSide, canvasHitTest, canvasEdgePath };
