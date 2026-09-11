import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { IconEye, IconLoader, IconPlus, IconTrash, IconType, IconX } from '../../components/icons.jsx';
import { MiniMarkdownEditor } from '../../components/MiniMarkdownEditor.jsx';
import { PropertiesPanel } from '../../components/PropertiesPanel.jsx';
import { parseFrontmatter } from '../../lib/markdownParse.js';
import { VectorToolbar } from './VectorToolbar.jsx';
import {
  AXIS_SNAP_PX,
  DEFAULT_CIRCLE_FILL,
  DEFAULT_CIRCLE_RADIUS,
  DEFAULT_STYLE,
  DEFAULT_TEXT_ALIGN,
  DEFAULT_TEXT_COLOR,
  DEFAULT_TEXT_FONT_SIZE,
  DEFAULT_TEXT_HEIGHT,
  DEFAULT_TEXT_WIDTH,
  EDGE_SNAP_PX,
  SEVER_THRESHOLD_PX,
  VECTOR_ZOOM_MAX,
  VECTOR_ZOOM_MIN,
  VERTEX_SNAP_PX,
  addCircle,
  addEdge,
  addFillAt,
  addLayer,
  addText,
  addVertex,
  bindVertexOntoEdge,
  compileVectorSvg,
  contrastDotColor,
  deleteCircles,
  deleteEdges,
  deleteTexts,
  deleteVertices,
  groupIdForVertex,
  groupVertexIds,
  groupVertices,
  moveCircles,
  moveVertices,
  moveToLayer,
  parseVectorContent,
  removeLayer,
  renameLayer,
  reorderLayer,
  resizeCircle,
  resolveTextQuad,
  selectionIsExactlyOneGroup,
  serializeVectorState,
  setCanvasBackground,
  setCircleStyle,
  setDescription,
  setEdgeStyle,
  setLayerVisible,
  setTextContent,
  setTextStyle,
  severEdgeEndpoint,
  subdivideEdge,
  ungroupVertices,
  loopsToPathData
} from './vectorState.js';
import { SpatialGrid, buildVertexAdjacency, closestPointOnSegment, computeMiterJoints, computeQuadWarpMatrix3d, dist, findFillBoundary, resolveBoundaryPolygon, snapCandidate } from './vectorTopology.js';
import { clamp } from '../../lib/mathUtils.js';

const MOVE_THRESHOLD = 3; // world px before a pointerdown counts as a drag, not a click — same convention as CanvasView

// A big multiple of the guideline threshold — just long enough that an
// alignment guide reads clearly on screen without needing the real canvas
// bounds plumbed through every caller.
const GUIDE_LINE_SPAN = 4000;

// Snap thresholds are authored in screen px (vectorState.js) but every
// distance in this editor's geometry is in WORLD units, so every threshold
// gets divided by the current zoom right before use — otherwise "14px" of
// slack would mean 14 world units regardless of zoom, i.e. a hit target
// that's way too generous zoomed in and way too tight zoomed out.
function snapOpts(zoom, grid, axisSnapEnabled, opts = {}) {
  return {
    grid,
    vertexPx: (opts.vertexPx ?? VERTEX_SNAP_PX) / zoom,
    edgePx: opts.allowSubdivide === false ? -1 : EDGE_SNAP_PX / zoom,
    axisPx: axisSnapEnabled && opts.allowAxisSnap !== false ? AXIS_SNAP_PX / zoom : -1,
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
function resolvePlacement(doc, grid, rawPoint, zoom, axisSnapEnabled, opts = {}, snapVertices = doc.vertices, snapEdges = doc.edges) {
  const snap = snapCandidate(snapVertices, snapEdges, rawPoint, snapOpts(zoom, grid, axisSnapEnabled, opts));
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


function VectorEditorView({ file, content, onChange, loading, handlers, linkIndex }) {
  const [doc, setDoc] = useState(() => parseVectorContent(content));
  const [viewport, setViewport] = useState({ x: 0, y: 0, zoom: 1 });
  const [tool, setTool] = useState('select');
  const [activeStyle, setActiveStyle] = useState(DEFAULT_STYLE);
  const [axisSnapEnabled, setAxisSnapEnabled] = useState(true);
  const [selectedVertexIds, setSelectedVertexIds] = useState(() => new Set());
  const [selectedEdgeIds, setSelectedEdgeIds] = useState(() => new Set());
  const [selectedCircleIds, setSelectedCircleIds] = useState(() => new Set());
  const [localEditGroupId, setLocalEditGroupId] = useState(null);
  const [edgeChainFirst, setEdgeChainFirst] = useState(null);
  const [polylineChain, setPolylineChain] = useState([]);
  const [liveOverrides, setLiveOverrides] = useState(null);
  const [circleDraft, setCircleDraft] = useState(null); // live preview while drawing/moving/resizing a circle: { id?, cx, cy, r }
  const [marquee, setMarquee] = useState(null);
  const [pointerWorld, setPointerWorld] = useState(null);
  const [snapPreview, setSnapPreview] = useState(null);
  const [spaceDown, setSpaceDown] = useState(false);
  const [isPanning, setIsPanning] = useState(false);
  const [historyTick, setHistoryTick] = useState(0);
  const [activeRadius, setActiveRadius] = useState(DEFAULT_CIRCLE_RADIUS);
  const [activeCircleFill, setActiveCircleFill] = useState(DEFAULT_CIRCLE_FILL);
  // View mode hides the editing-only overlay (vertex dots, the dashed
  // guide for 0px-weight edges/circles, selection UI) so the canvas reads
  // exactly like the exported SVG. Edit mode is the default.
  const [viewMode, setViewMode] = useState(false);
  const [activeLayerId, setActiveLayerId] = useState(null); // null = "use doc.layers[0]" (see safeActiveLayerId) — lets a freshly-loaded/undone doc always resolve to a real layer without a mount-order race
  const [snapCrossLayer, setSnapCrossLayer] = useState(true);
  const [layersPanelOpen, setLayersPanelOpen] = useState(false);
  const [descriptionPanelOpen, setDescriptionPanelOpen] = useState(false);
  const [activeTextStyle, setActiveTextStyle] = useState({ color: DEFAULT_TEXT_COLOR, fontSize: DEFAULT_TEXT_FONT_SIZE, align: DEFAULT_TEXT_ALIGN });
  const [textDraft, setTextDraft] = useState(null); // { x0, y0, x1, y1 } — rectangle preview while drawing a new text box
  // The id of the text currently being typed into, plus a local editing
  // buffer separate from doc.texts — content only commits on blur/Escape
  // (see the plain-<textarea> overlay below), same "don't push a save per
  // keystroke" convention as MiniMarkdownEditor.
  const [editingTextId, setEditingTextId] = useState(null);
  const [editingTextBuffer, setEditingTextBuffer] = useState('');

  const containerRef = useRef(null);
  const dragRef = useRef(null);
  const rafRef = useRef(null);
  const pendingOverridesRef = useRef(null);
  const pastRef = useRef([]);
  const futureRef = useRef([]);
  const loadedOnceRef = useRef(!loading);

  useEffect(() => {
    if (!loading && !loadedOnceRef.current) {
      loadedOnceRef.current = true;
      setDoc(parseVectorContent(content));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loading]);

  const commitState = useCallback(
    (nextDoc) => {
      pastRef.current.push(doc);
      if (pastRef.current.length > 200) pastRef.current.shift(); // cap history so a long session doesn't grow this unbounded
      futureRef.current = [];
      setDoc(nextDoc);
      onChange(serializeVectorState(nextDoc));
      setHistoryTick((t) => t + 1);
    },
    [doc, onChange]
  );

  const undo = useCallback(() => {
    if (!pastRef.current.length) return;
    const prev = pastRef.current.pop();
    futureRef.current.push(doc);
    setDoc(prev);
    onChange(serializeVectorState(prev));
    setHistoryTick((t) => t + 1);
  }, [doc, onChange]);

  const redo = useCallback(() => {
    if (!futureRef.current.length) return;
    const next = futureRef.current.pop();
    pastRef.current.push(doc);
    setDoc(next);
    onChange(serializeVectorState(next));
    setHistoryTick((t) => t + 1);
  }, [doc, onChange]);

  const grid = useMemo(() => {
    const g = new SpatialGrid();
    g.rebuild(doc.vertices);
    return g;
  }, [doc.vertices]);

  const adjacency = useMemo(() => buildVertexAdjacency(doc.vertices, doc.edges), [doc.vertices, doc.edges]);

  const verticesForRender = useMemo(() => {
    if (!liveOverrides) return doc.vertices;
    return doc.vertices.map((v) => (liveOverrides.has(v.id) ? { ...v, ...liveOverrides.get(v.id) } : v));
  }, [doc.vertices, liveOverrides]);

  const vertexById = useMemo(() => new Map(verticesForRender.map((v) => [v.id, v])), [verticesForRender]);

  // Edges sorted so heavier strokes draw last (on top) — Dynamic Z-Index.
  const sortedEdges = useMemo(() => [...doc.edges].sort((a, b) => a.style.thickness - b.style.thickness), [doc.edges]);

  // Plugs the butt-cap notch at any vertex where exactly two EQUAL-weight
  // edges meet — see vectorTopology.js's computeMiterJoints. Computed
  // per-layer (a Map keyed by layer id) so two edges on different layers
  // never miter with each other even if they share a vertex — see the
  // render loop below. Uses verticesForRender (not doc.vertices) so the
  // wedge follows a vertex's live drag position instead of lagging a
  // frame behind it.
  const miterJointsByLayer = useMemo(() => {
    const map = new Map();
    for (const layer of doc.layers) {
      map.set(layer.id, computeMiterJoints(verticesForRender, doc.edges.filter((e) => e.layerId === layer.id)));
    }
    return map;
  }, [doc.layers, doc.edges, verticesForRender]);

  // Fills resolve against verticesForRender (not doc.vertices), so a fill
  // visibly tracks its shape live while a drag is in progress, not just
  // after it's dropped — this is also what keeps a fill from "breaking"
  // (going stale) as vertices move, since it's recomputed from current
  // positions on every render rather than a fixed point captured at
  // fill-time. A fill whose boundary depends on a deleted vertex/edge
  // resolves to null and is skipped — pruneFills (vectorState.js) removes
  // those from the document outright the next time the graph is edited.
  const resolvedFills = useMemo(() => {
    // resolveBoundaryPolygon now returns { outer, holes } — see
    // vectorTopology.js's findFillBoundary. A ring/frame's cutout renders
    // as an additional subpath under fill-rule="evenodd" rather than a
    // second element, so a nested hole always punches through regardless
    // of fill color/z-order.
    return doc.fills.map((f) => ({ fill: f, resolved: resolveBoundaryPolygon(verticesForRender, doc.edges, f.boundary) })).filter((x) => x.resolved);
  }, [doc.fills, doc.edges, verticesForRender]);

  // Circles are independent primitives (not part of the vertex/edge graph),
  // so their live-drag preview is a simple single-circle draft rather than
  // the batched liveOverrides map above — there's only ever one being
  // dragged/resized/drawn at a time.
  const circlesForRender = useMemo(() => {
    if (!circleDraft || !circleDraft.id) return doc.circles;
    return doc.circles.map((c) => (c.id === circleDraft.id ? { ...c, ...circleDraft } : c));
  }, [doc.circles, circleDraft]);

  // Picks whichever of black/white contrasts more against the current
  // canvas color, so the alignment-dot grid stays legible against any
  // background the document is set to.
  const dotColor = useMemo(() => contrastDotColor(doc.canvas.background), [doc.canvas.background]);

  // handlers/linkIndex come from the parent editor pane (same props the
  // note editor and Canvas view already receive) — optional here since a
  // caller that hasn't threaded them through yet still gets a working
  // (if link/tag-inert) description editor rather than a crash.
  const safeHandlers = useMemo(() => handlers || { onOpenById: () => {}, onCreateOrOpenByName: () => {}, onOpenTag: () => {} }, [handlers]);
  const frontmatterProperties = useMemo(() => parseFrontmatter(doc.description).properties, [doc.description]);

  // Falls back to the bottom layer whenever activeLayerId hasn't been set
  // yet, or no longer names a real layer (its layer was just deleted, or a
  // freshly-loaded/undone doc has a different layer set entirely) —
  // avoids needing an effect just to keep this in sync.
  const safeActiveLayerId = doc.layers.some((l) => l.id === activeLayerId) ? activeLayerId : doc.layers[0].id;

  // What snapCandidate/resolvePlacement are allowed to consider — the full
  // graph when snapCrossLayer is on, or just the active layer's own edges
  // (plus any vertex not owned by an edge on ANY layer, since a bare
  // vertex isn't "on" a layer to begin with) when it's off. See the
  // snap-cross-layer toggle in the toolbar.
  const edgesForSnap = useMemo(() => (snapCrossLayer ? doc.edges : doc.edges.filter((e) => e.layerId === safeActiveLayerId)), [snapCrossLayer, doc.edges, safeActiveLayerId]);
  const verticesForSnap = useMemo(() => {
    if (snapCrossLayer) return doc.vertices;
    const sameLayer = new Set();
    const anyLayer = new Set();
    for (const e of doc.edges) {
      anyLayer.add(e.v1);
      anyLayer.add(e.v2);
      if (e.layerId === safeActiveLayerId) {
        sameLayer.add(e.v1);
        sameLayer.add(e.v2);
      }
    }
    return doc.vertices.filter((v) => sameLayer.has(v.id) || !anyLayer.has(v.id));
  }, [snapCrossLayer, doc.edges, doc.vertices, safeActiveLayerId]);

  const scheduleLiveOverrides = useCallback((map) => {
    pendingOverridesRef.current = map;
    if (rafRef.current) return;
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = null;
      setLiveOverrides(pendingOverridesRef.current);
    });
  }, []);
  useEffect(() => () => rafRef.current && cancelAnimationFrame(rafRef.current), []);

  const screenToWorld = useCallback(
    (sx, sy) => {
      const rect = containerRef.current.getBoundingClientRect();
      return { x: (sx - rect.left - viewport.x) / viewport.zoom, y: (sy - rect.top - viewport.y) / viewport.zoom };
    },
    [viewport]
  );

  // Inverse of screenToWorld, but container-relative rather than
  // page-relative — for positioning a plain HTML overlay (the text-content
  // edit <textarea>) as an absolutely-positioned child of .vector-surface
  // itself, alongside the <svg>, rather than inside its world-transformed
  // <g> (that overlay is deliberately NOT warped by a text's quad
  // transform — see the Text section of vectorState.js for why).
  const worldToLocal = useCallback((wx, wy) => ({ x: wx * viewport.zoom + viewport.x, y: wy * viewport.zoom + viewport.y }), [viewport]);

  const zoomBy = useCallback((factor, centerScreen) => {
    setViewport((v) => {
      const nextZoom = clamp(v.zoom * factor, VECTOR_ZOOM_MIN, VECTOR_ZOOM_MAX);
      const rect = containerRef.current.getBoundingClientRect();
      const cx = centerScreen ? centerScreen.x - rect.left : rect.width / 2;
      const cy = centerScreen ? centerScreen.y - rect.top : rect.height / 2;
      const worldX = (cx - v.x) / v.zoom;
      const worldY = (cy - v.y) / v.zoom;
      return { x: cx - worldX * nextZoom, y: cy - worldY * nextZoom, zoom: nextZoom };
    });
  }, []);

  const fitToContent = useCallback(() => {
    if (!containerRef.current) return;
    if (!doc.vertices.length) {
      setViewport({ x: 0, y: 0, zoom: 1 });
      return;
    }
    const b = bboxOf(doc.vertices, new Set(doc.vertices.map((v) => v.id)));
    const rect = containerRef.current.getBoundingClientRect();
    const pad = 60;
    const zoom = clamp(Math.min((rect.width - pad * 2) / Math.max(1, b.maxX - b.minX), (rect.height - pad * 2) / Math.max(1, b.maxY - b.minY)), VECTOR_ZOOM_MIN, 1.5);
    setViewport({ x: rect.width / 2 - ((b.minX + b.maxX) / 2) * zoom, y: rect.height / 2 - ((b.minY + b.maxY) / 2) * zoom, zoom });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doc.vertices]);

  useEffect(() => {
    const raf = requestAnimationFrame(() => fitToContent());
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [file.id]);

  useEffect(() => {
    const kd = (e) => {
      if (e.code === 'Space' && !e.repeat && document.activeElement?.tagName !== 'TEXTAREA') setSpaceDown(true);
    };
    const ku = (e) => {
      if (e.code === 'Space') setSpaceDown(false);
    };
    window.addEventListener('keydown', kd);
    window.addEventListener('keyup', ku);
    return () => {
      window.removeEventListener('keydown', kd);
      window.removeEventListener('keyup', ku);
    };
  }, []);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return undefined;
    const onWheel = (e) => {
      e.preventDefault();
      if (e.ctrlKey || e.metaKey) zoomBy(Math.exp(-e.deltaY * 0.012), { x: e.clientX, y: e.clientY });
      else setViewport((v) => ({ ...v, x: v.x - e.deltaX, y: v.y - e.deltaY }));
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [zoomBy]);

  // ---------------------------------------------------------------------
  // Selection helpers — clicking a grouped vertex selects the whole group
  // (Global Transform target) unless we're in that group's Local Transform
  // mode, in which case individual vertices select normally.
  // ---------------------------------------------------------------------
  const effectiveSelectionForVertex = useCallback(
    (vertexId) => {
      const gid = groupIdForVertex(doc, vertexId);
      if (gid && gid !== localEditGroupId) return new Set(groupVertexIds(doc, gid));
      return new Set([vertexId]);
    },
    [doc, localEditGroupId]
  );

  const clearToolInProgress = () => {
    setEdgeChainFirst(null);
    setPolylineChain([]);
  };

  const deleteSelection = useCallback(() => {
    if (selectedEdgeIds.size) {
      commitState(deleteEdges(doc, selectedEdgeIds));
      setSelectedEdgeIds(new Set());
      return;
    }
    if (selectedCircleIds.size) {
      commitState(deleteCircles(doc, selectedCircleIds));
      setSelectedCircleIds(new Set());
      return;
    }
    if (selectedVertexIds.size) {
      commitState(deleteVertices(doc, selectedVertexIds));
      setSelectedVertexIds(new Set());
    }
  }, [doc, selectedVertexIds, selectedEdgeIds, selectedCircleIds, commitState]);

  // ---------------------------------------------------------------------
  // Pointer handling
  // ---------------------------------------------------------------------
  const beginPan = (e) => {
    containerRef.current.setPointerCapture(e.pointerId);
    dragRef.current = { mode: 'pan', startClient: { x: e.clientX, y: e.clientY }, startViewport: viewport };
    setIsPanning(true);
  };

  const onVertexPointerDown = (e, vertexId) => {
    e.stopPropagation();
    if (spaceDown) {
      beginPan(e);
      return;
    }
    containerRef.current.focus();
    containerRef.current.setPointerCapture(e.pointerId);
    const world = screenToWorld(e.clientX, e.clientY);

    if (tool === 'eyedropper') return; // eyedropper only samples edges/fills — vertices carry no style

    if (tool === 'vertex') {
      // Drag FROM an existing vertex spawns a new connected vertex at the drop point.
      dragRef.current = { mode: 'spawn-connected', fromVertexId: vertexId, startWorld: world, moved: false };
      return;
    }

    if (tool === 'edge') {
      if (edgeChainFirst && edgeChainFirst !== vertexId) {
        const { state: next, ok } = addEdge(doc, edgeChainFirst, vertexId, activeStyle, safeActiveLayerId);
        if (ok) commitState(next);
        setEdgeChainFirst(null);
      } else {
        setEdgeChainFirst(vertexId);
      }
      return;
    }

    if (tool === 'polyline') {
      if (polylineChain.length && polylineChain.includes(vertexId)) {
        // Closing the loop on an existing (already-in-chain) vertex ends the chain.
        const last = polylineChain[polylineChain.length - 1];
        if (last !== vertexId) {
          const { state: next, ok } = addEdge(doc, last, vertexId, activeStyle, safeActiveLayerId);
          if (ok) commitState(next);
        }
        setPolylineChain([]);
        return;
      }
      if (polylineChain.length) {
        const last = polylineChain[polylineChain.length - 1];
        const { state: next, ok } = addEdge(doc, last, vertexId, activeStyle, safeActiveLayerId);
        if (ok) commitState(next);
      }
      setPolylineChain((chain) => [...chain, vertexId]);
      return;
    }

    if (tool === 'fill') return;

    // select tool
    if (e.altKey) {
      // Graph Severing (Tear-Away Disconnect): grab whichever incident edge
      // points closest to the drag's initial direction; it detaches once
      // the drag passes SEVER_THRESHOLD_PX, and only that one edge — every
      // other edge at this vertex stays put.
      const incident = adjacency.adj.get(vertexId) || [];
      if (incident.length === 0) return;
      dragRef.current = { mode: 'tearaway-pending', vertexId, incident, startWorld: world };
      return;
    }

    let nextSelection = selectedVertexIds;
    if (e.shiftKey) {
      nextSelection = new Set(selectedVertexIds);
      const groupIds = effectiveSelectionForVertex(vertexId);
      const alreadyAllIn = Array.from(groupIds).every((id) => nextSelection.has(id));
      for (const id of groupIds) (alreadyAllIn ? nextSelection.delete(id) : nextSelection.add(id));
      setSelectedVertexIds(nextSelection);
    } else if (!selectedVertexIds.has(vertexId)) {
      nextSelection = effectiveSelectionForVertex(vertexId);
      setSelectedVertexIds(nextSelection);
    }
    setSelectedEdgeIds(new Set());

    const ids = nextSelection.size ? nextSelection : new Set([vertexId]);
    const startPositions = new Map(Array.from(ids).map((id) => [id, vertexById.get(id)]));
    dragRef.current = { mode: 'move', ids, startPositions, startWorld: world, moved: false, singleId: ids.size === 1 ? vertexId : null };
  };

  const onVertexDoubleClick = (e, vertexId) => {
    e.stopPropagation();
    const gid = groupIdForVertex(doc, vertexId);
    if (gid) {
      setLocalEditGroupId(gid);
      setSelectedVertexIds(new Set([vertexId]));
    }
  };

  // Clicking an edge directly with the Vertex or Polyline tool subdivides
  // it right at the clicked point — this is the "click along an edge"
  // Vertex Insertion path from an edge that's thin enough to land on
  // exactly (the background handler below covers the wider snap-radius
  // case, near-but-not-on an edge).
  const onEdgePointerDown = (e, edgeId) => {
    e.stopPropagation();
    if (spaceDown) {
      beginPan(e);
      return;
    }
    if (viewMode) return;
    if (tool === 'eyedropper') {
      const edge = doc.edges.find((ed) => ed.id === edgeId);
      if (edge) setActiveStyle((s) => ({ ...s, ...edge.style }));
      return;
    }
    if (tool === 'vertex' || tool === 'polyline') {
      const edge = doc.edges.find((ed) => ed.id === edgeId);
      const a = vertexById.get(edge?.v1);
      const b = vertexById.get(edge?.v2);
      if (!edge || !a || !b) return;
      const world = screenToWorld(e.clientX, e.clientY);
      const { point } = closestPointOnSegment(world, a, b);
      const next = subdivideEdge(doc, edgeId, point);
      const newVid = next._newVertexId;
      if (tool === 'vertex') {
        commitState(next);
      } else {
        let working = next;
        if (polylineChain.length) {
          const last = polylineChain[polylineChain.length - 1];
          const { state: withEdge, ok } = addEdge(working, last, newVid, activeStyle, safeActiveLayerId);
          if (ok) working = withEdge;
        }
        commitState(working);
        setPolylineChain((chain) => [...chain, newVid]);
      }
      return;
    }
    if (tool === 'select') {
      setSelectedEdgeIds((prev) => {
        const next = e.shiftKey ? new Set(prev) : new Set();
        next.has(edgeId) ? next.delete(edgeId) : next.add(edgeId);
        return next;
      });
      setSelectedVertexIds(new Set());
    }
  };

  const onFillPointerDown = (e, fill) => {
    e.stopPropagation();
    if (viewMode) return;
    if (tool === 'eyedropper') {
      setActiveStyle((s) => ({ ...s, color: fill.color })); // fills have no thickness — eyedropper on a fill only carries color
    }
  };

  const onCirclePointerDown = (e, circleId) => {
    e.stopPropagation();
    if (spaceDown) {
      beginPan(e);
      return;
    }
    if (viewMode) return;
    containerRef.current.focus();
    const circle = doc.circles.find((c) => c.id === circleId);
    if (!circle) return;

    if (tool === 'eyedropper') {
      // The eyedropper logs a circle's radius too, not just its outline
      // color/weight and fill — so the next circle you draw matches size
      // as well as style.
      setActiveStyle((s) => ({ ...s, ...circle.style }));
      setActiveCircleFill(circle.fill || 'none');
      setActiveRadius(Math.round(circle.r));
      return;
    }

    if (tool !== 'select') return;

    containerRef.current.setPointerCapture(e.pointerId);
    const world = screenToWorld(e.clientX, e.clientY);
    setSelectedCircleIds((prev) => {
      if (!e.shiftKey) return new Set([circleId]);
      const next = new Set(prev);
      next.has(circleId) ? next.delete(circleId) : next.add(circleId);
      return next;
    });
    setSelectedVertexIds(new Set());
    setSelectedEdgeIds(new Set());
    dragRef.current = { mode: 'move-circle', circleId, startWorld: world, startCx: circle.cx, startCy: circle.cy, moved: false };
  };

  // Resize handle drag: radius is always recomputed as the plain distance
  // from the (fixed) center to the pointer, regardless of drag direction —
  // that's what keeps it a perfect circle rather than letting it stretch
  // into an oval.
  const beginCircleResize = (e, circleId) => {
    e.stopPropagation();
    if (viewMode) return;
    containerRef.current.setPointerCapture(e.pointerId);
    const circle = doc.circles.find((c) => c.id === circleId);
    if (!circle) return;
    dragRef.current = { mode: 'resize-circle', circleId, cx: circle.cx, cy: circle.cy };
  };

  // Clicking a text's rendered body (not one of its 4 corner dots)
  // selects all 4 corners at once — the existing multi-vertex selection
  // system then gives the bounding-box scale/rotate handles "for free"
  // (see the Text section of vectorState.js). Grabbing a single corner
  // dot directly still goes through the ordinary onVertexPointerDown path
  // and produces the independent-corner skew instead.
  const onTextPointerDown = (e, text) => {
    e.stopPropagation();
    if (spaceDown) {
      beginPan(e);
      return;
    }
    if (viewMode) return;

    if (tool === 'eyedropper') {
      setActiveTextStyle({ color: text.color, fontSize: text.fontSize, align: text.align });
      return;
    }
    if (tool !== 'select') return;

    const corners = new Set([text.v1, text.v2, text.v3, text.v4]);
    setSelectedVertexIds((prev) => {
      if (!e.shiftKey) return corners;
      const next = new Set(prev);
      const allSelected = [...corners].every((id) => next.has(id));
      corners.forEach((id) => (allSelected ? next.delete(id) : next.add(id)));
      return next;
    });
    setSelectedEdgeIds(new Set());
    setSelectedCircleIds(new Set());
  };

  const beginTextEdit = (text) => {
    setEditingTextId(text.id);
    setEditingTextBuffer(text.content);
  };

  const commitTextEdit = () => {
    if (editingTextId) commitState(setTextContent(doc, editingTextId, editingTextBuffer));
    setEditingTextId(null);
  };

  // Selection bounding-box body: dragging it anywhere (not just by grabbing
  // an individual vertex dot) moves the whole selection.
  const onSelectionBoxPointerDown = (e) => {
    e.stopPropagation();
    if (spaceDown) {
      beginPan(e);
      return;
    }
    if (viewMode) return;
    containerRef.current.setPointerCapture(e.pointerId);
    const world = screenToWorld(e.clientX, e.clientY);
    const ids = selectedVertexIds;
    const startPositions = new Map(Array.from(ids).map((id) => [id, vertexById.get(id)]));
    dragRef.current = { mode: 'move', ids, startPositions, startWorld: world, moved: false, singleId: ids.size === 1 ? Array.from(ids)[0] : null };
  };

  const onBackgroundPointerDown = (e) => {
    if (e.target !== containerRef.current && !e.target.classList.contains('vector-bg-hit')) return;
    containerRef.current.focus();
    if (spaceDown || e.button === 1) {
      beginPan(e);
      return;
    }
    if (viewMode) return; // View mode is look-only, aside from pan (handled above) and zoom
    containerRef.current.setPointerCapture(e.pointerId);
    const world = screenToWorld(e.clientX, e.clientY);

    if (tool === 'vertex') {
      dragRef.current = { mode: 'place-vertex', startWorld: world, moved: false };
      return;
    }
    if (tool === 'edge') {
      setEdgeChainFirst(null); // clicking empty space cancels an in-progress edge
      return;
    }
    if (tool === 'polyline') {
      const { nextDoc, vertexId } = resolvePlacement(doc, grid, world, viewport.zoom, axisSnapEnabled, {}, verticesForSnap, edgesForSnap);
      if (nextDoc !== doc) commitState(nextDoc);
      if (polylineChain.length) {
        const last = polylineChain[polylineChain.length - 1];
        const { state: withEdge, ok } = addEdge(nextDoc, last, vertexId, activeStyle, safeActiveLayerId);
        if (ok) commitState(withEdge);
      }
      setPolylineChain((chain) => [...chain, vertexId]);
      return;
    }
    if (tool === 'circle') {
      dragRef.current = { mode: 'draw-circle', startWorld: world };
      setCircleDraft({ cx: world.x, cy: world.y, r: 0 });
      return;
    }
    if (tool === 'text') {
      dragRef.current = { mode: 'draw-text', startWorld: world };
      setTextDraft({ x0: world.x, y0: world.y, x1: world.x, y1: world.y });
      return;
    }
    if (tool === 'fill') {
      const { state: next, ok } = addFillAt(doc, world, activeStyle.color, safeActiveLayerId);
      if (ok) commitState(next);
      return;
    }
    if (tool === 'eyedropper') return;

    // select tool: start a marquee
    setSelectedVertexIds(new Set());
    setSelectedEdgeIds(new Set());
    setSelectedCircleIds(new Set());
    if (localEditGroupId) setLocalEditGroupId(null);
    dragRef.current = { mode: 'marquee', startWorld: world };
    setMarquee({ x0: world.x, y0: world.y, x1: world.x, y1: world.y });
  };

  const onContainerPointerMove = (e) => {
    const world = screenToWorld(e.clientX, e.clientY);
    setPointerWorld(world);
    const drag = dragRef.current;
    if (!drag) {
      setSnapPreview(null);
      return;
    }

    if (drag.mode === 'pan') {
      setViewport((v) => ({ ...v, x: drag.startViewport.x + (e.clientX - drag.startClient.x), y: drag.startViewport.y + (e.clientY - drag.startClient.y) }));
      return;
    }

    if (drag.mode === 'marquee') {
      setMarquee({ x0: drag.startWorld.x, y0: drag.startWorld.y, x1: world.x, y1: world.y });
      return;
    }

    if (drag.mode === 'place-vertex') {
      if (dist(drag.startWorld, world) > MOVE_THRESHOLD / viewport.zoom) drag.moved = true;
      const snap = snapCandidate(verticesForSnap, edgesForSnap, world, snapOpts(viewport.zoom, grid, axisSnapEnabled));
      setSnapPreview(snap);
      return;
    }

    if (drag.mode === 'move') {
      if (dist(drag.startWorld, world) > MOVE_THRESHOLD / viewport.zoom) drag.moved = true;
      if (drag.singleId) {
        // Single-vertex drags snap live: to another vertex's exact position
        // (visual alignment, not a merge — both stay distinct), onto an
        // edge (bound on drop — see below), or to an axis. Group drags
        // intentionally skip target-snapping and just move by a uniform
        // delta, per "maintaining relative distances".
        const snap = snapCandidate(verticesForSnap, edgesForSnap, world, snapOpts(viewport.zoom, grid, axisSnapEnabled, { excludeVertexId: drag.singleId }));
        setSnapPreview(snap);
        scheduleLiveOverrides(new Map([[drag.singleId, snap.point]]));
      } else {
        setSnapPreview(null);
        const dx = world.x - drag.startWorld.x;
        const dy = world.y - drag.startWorld.y;
        const map = new Map();
        for (const [id, pos] of drag.startPositions) map.set(id, { x: pos.x + dx, y: pos.y + dy });
        scheduleLiveOverrides(map);
      }
      return;
    }

    if (drag.mode === 'spawn-connected') {
      if (dist(drag.startWorld, world) > MOVE_THRESHOLD / viewport.zoom) drag.moved = true;
      const snap = snapCandidate(verticesForSnap, edgesForSnap, world, snapOpts(viewport.zoom, grid, axisSnapEnabled, { excludeVertexId: drag.fromVertexId }));
      setSnapPreview(snap);
      return; // preview line follows pointerWorld automatically; the actual vertex/edge is created on pointerup
    }

    if (drag.mode === 'draw-circle') {
      setCircleDraft({ cx: drag.startWorld.x, cy: drag.startWorld.y, r: dist(drag.startWorld, world) });
      return;
    }

    if (drag.mode === 'move-circle') {
      if (dist(drag.startWorld, world) > MOVE_THRESHOLD / viewport.zoom) drag.moved = true;
      const dx = world.x - drag.startWorld.x;
      const dy = world.y - drag.startWorld.y;
      setCircleDraft({ id: drag.circleId, cx: drag.startCx + dx, cy: drag.startCy + dy });
      return;
    }

    if (drag.mode === 'resize-circle') {
      setCircleDraft({ id: drag.circleId, cx: drag.cx, cy: drag.cy, r: dist({ x: drag.cx, y: drag.cy }, world) });
      return;
    }

    if (drag.mode === 'draw-text') {
      setTextDraft({ x0: drag.startWorld.x, y0: drag.startWorld.y, x1: world.x, y1: world.y });
      return;
    }

    if (drag.mode === 'tearaway-pending') {
      const d = dist(drag.startWorld, world);
      if (d > SEVER_THRESHOLD_PX / viewport.zoom) {
        // Pick the incident edge whose direction is closest to the drag angle.
        const dragAngle = Math.atan2(world.y - drag.startWorld.y, world.x - drag.startWorld.x);
        const origin = vertexById.get(drag.vertexId);
        let best = null, bestDiff = Infinity;
        for (const he of drag.incident) {
          const other = vertexById.get(he.to);
          const a = Math.atan2(other.y - origin.y, other.x - origin.x);
          let diff = Math.abs(a - dragAngle);
          if (diff > Math.PI) diff = 2 * Math.PI - diff;
          if (diff < bestDiff) {
            bestDiff = diff;
            best = he;
          }
        }
        const next = severEdgeEndpoint(doc, best.edgeId, drag.vertexId, world);
        commitState(next);
        dragRef.current = { mode: 'move', ids: new Set([next._newVertexId]), startPositions: new Map([[next._newVertexId, world]]), startWorld: world, moved: true, singleId: next._newVertexId };
        setSelectedVertexIds(new Set([next._newVertexId]));
      }
      return;
    }

    if (drag.mode === 'transform') {
      const next = computeTransform(drag, world);
      scheduleLiveOverrides(next);
    }
  };

  const onContainerPointerUp = () => {
    const drag = dragRef.current;
    dragRef.current = null;
    setIsPanning(false);
    setSnapPreview(null);
    if (!drag) return;

    if (drag.mode === 'marquee') {
      setMarquee(null);
      const x0 = Math.min(drag.startWorld.x, pointerWorld?.x ?? drag.startWorld.x);
      const x1 = Math.max(drag.startWorld.x, pointerWorld?.x ?? drag.startWorld.x);
      const y0 = Math.min(drag.startWorld.y, pointerWorld?.y ?? drag.startWorld.y);
      const y1 = Math.max(drag.startWorld.y, pointerWorld?.y ?? drag.startWorld.y);
      const hit = new Set(doc.vertices.filter((v) => v.x >= x0 && v.x <= x1 && v.y >= y0 && v.y <= y1).map((v) => v.id));
      setSelectedVertexIds(hit);
      return;
    }

    if (drag.mode === 'place-vertex') {
      if (!drag.moved && pointerWorld) {
        const { nextDoc } = resolvePlacement(doc, grid, pointerWorld, viewport.zoom, axisSnapEnabled, {}, verticesForSnap, edgesForSnap);
        if (nextDoc !== doc) commitState(nextDoc);
      }
      return;
    }

    if (drag.mode === 'spawn-connected') {
      if (pointerWorld) {
        const dropDist = dist(drag.startWorld, pointerWorld);
        if (dropDist > MOVE_THRESHOLD / viewport.zoom) {
          const { nextDoc, vertexId } = resolvePlacement(doc, grid, pointerWorld, viewport.zoom, axisSnapEnabled, { excludeVertexId: drag.fromVertexId }, verticesForSnap, edgesForSnap);
          const { state: withEdge, ok } = addEdge(nextDoc, drag.fromVertexId, vertexId, activeStyle, safeActiveLayerId);
          commitState(ok ? withEdge : nextDoc);
        }
      }
      return;
    }

    if (drag.mode === 'move') {
      if (drag.singleId && pointerWorld) {
        // Re-resolve the final snap once more at drop time: if it lands on
        // an edge the vertex isn't already part of, Edge Mid-Point
        // Insertion binds it into that edge's topology instead of just
        // leaving it sitting on top.
        const snap = snapCandidate(verticesForSnap, edgesForSnap, pointerWorld, snapOpts(viewport.zoom, grid, axisSnapEnabled, { excludeVertexId: drag.singleId }));
        let next = moveVertices(doc, new Map([[drag.singleId, snap.point]]));
        if (snap.snappedEdgeId) next = bindVertexOntoEdge(next, snap.snappedEdgeId, drag.singleId);
        commitState(next);
      } else if (liveOverrides && liveOverrides.size) {
        commitState(moveVertices(doc, liveOverrides));
      }
      setLiveOverrides(null);
      return;
    }

    if (drag.mode === 'transform') {
      if (liveOverrides && liveOverrides.size) {
        commitState(moveVertices(doc, liveOverrides));
      }
      setLiveOverrides(null);
      return;
    }

    if (drag.mode === 'tearaway-pending') {
      // Threshold never crossed — treat as a no-op (nothing to undo, nothing moved).
      return;
    }

    if (drag.mode === 'draw-circle') {
      setCircleDraft(null);
      const r = pointerWorld ? dist(drag.startWorld, pointerWorld) : 0;
      // A plain click (no real drag) places a circle at the toolbar's
      // current default radius rather than a near-zero one.
      const placedR = r > MOVE_THRESHOLD / viewport.zoom ? r : activeRadius;
      commitState(addCircle(doc, drag.startWorld.x, drag.startWorld.y, placedR, activeStyle, activeCircleFill, safeActiveLayerId));
      if (r > MOVE_THRESHOLD / viewport.zoom) setActiveRadius(Math.round(placedR)); // drawing calibrates the default for next time
      return;
    }

    if (drag.mode === 'move-circle') {
      setCircleDraft(null);
      if (drag.moved && pointerWorld) {
        const dx = pointerWorld.x - drag.startWorld.x;
        const dy = pointerWorld.y - drag.startWorld.y;
        commitState(moveCircles(doc, new Map([[drag.circleId, { cx: drag.startCx + dx, cy: drag.startCy + dy }]])));
      }
      return;
    }

    if (drag.mode === 'resize-circle') {
      setCircleDraft(null);
      if (pointerWorld) {
        const r = dist({ x: drag.cx, y: drag.cy }, pointerWorld);
        commitState(resizeCircle(doc, drag.circleId, r));
        setActiveRadius(Math.round(r));
      }
      return;
    }

    if (drag.mode === 'draw-text') {
      setTextDraft(null);
      const end = pointerWorld || drag.startWorld;
      const dragged = dist(drag.startWorld, end) > MOVE_THRESHOLD / viewport.zoom;
      // A plain click (no real drag) places a default-sized box anchored
      // at the click point, same "click for a default, drag for a custom
      // size" convention as the circle tool.
      const x0 = drag.startWorld.x;
      const y0 = drag.startWorld.y;
      const x1 = dragged ? end.x : x0 + DEFAULT_TEXT_WIDTH;
      const y1 = dragged ? end.y : y0 + DEFAULT_TEXT_HEIGHT;
      const left = Math.min(x0, x1), right = Math.max(x0, x1);
      const top = Math.min(y0, y1), bottom = Math.max(y0, y1);
      const corners = [
        { x: left, y: top },
        { x: right, y: top },
        { x: right, y: bottom },
        { x: left, y: bottom }
      ];
      const next = addText(doc, corners, '', activeTextStyle, safeActiveLayerId);
      commitState(next);
      // Drop straight into content editing and back to the select tool —
      // an empty text box has no visible outline of its own (see the
      // Text section of vectorState.js), so leaving the user in the text
      // tool staring at a blank spot isn't useful; typing immediately is.
      setEditingTextId(next._newTextId);
      setEditingTextBuffer('');
      setTool('select');
      return;
    }
  };

  // ---------------------------------------------------------------------
  // Global transform (bounding-box scale/rotate handles) for the current
  // selection. Local Transform mode doesn't need separate handle code: it
  // just narrows what a click can select (see effectiveSelectionForVertex)
  // and ordinary single-vertex drag already works.
  // ---------------------------------------------------------------------
  function computeTransform(drag, world) {
    const map = new Map();
    if (drag.kind === 'scale') {
      const dx = world.x - drag.anchor.x;
      const dy = world.y - drag.anchor.y;
      let scaleX = drag.spanX === 0 ? 1 : dx / drag.spanX;
      let scaleY = drag.spanY === 0 ? 1 : dy / drag.spanY;
      if (drag.axisLock === 'x') scaleY = 1; // edge-midpoint handle: horizontal-only scaling
      if (drag.axisLock === 'y') scaleX = 1; // edge-midpoint handle: vertical-only scaling
      for (const [id, pos] of drag.startPositions) {
        map.set(id, { x: drag.anchor.x + (pos.x - drag.anchor.x) * scaleX, y: drag.anchor.y + (pos.y - drag.anchor.y) * scaleY });
      }
    } else if (drag.kind === 'rotate') {
      const a0 = Math.atan2(drag.startWorld.y - drag.center.y, drag.startWorld.x - drag.center.x);
      const a1 = Math.atan2(world.y - drag.center.y, world.x - drag.center.x);
      const da = a1 - a0;
      const cos = Math.cos(da), sin = Math.sin(da);
      for (const [id, pos] of drag.startPositions) {
        const dx = pos.x - drag.center.x, dy = pos.y - drag.center.y;
        map.set(id, { x: drag.center.x + dx * cos - dy * sin, y: drag.center.y + dx * sin + dy * cos });
      }
    }
    return map;
  }

  const beginScale = (e, handle) => {
    e.stopPropagation();
    containerRef.current.setPointerCapture(e.pointerId);
    const world = screenToWorld(e.clientX, e.clientY);
    const startPositions = new Map(Array.from(selectedVertexIds).map((id) => [id, vertexById.get(id)]));
    dragRef.current = { mode: 'transform', kind: 'scale', anchor: handle.anchor, axisLock: handle.axisLock, spanX: world.x - handle.anchor.x, spanY: world.y - handle.anchor.y, startPositions };
  };

  const beginRotate = (e, box) => {
    e.stopPropagation();
    containerRef.current.setPointerCapture(e.pointerId);
    const center = { x: (box.minX + box.maxX) / 2, y: (box.minY + box.maxY) / 2 };
    const startPositions = new Map(Array.from(selectedVertexIds).map((id) => [id, vertexById.get(id)]));
    dragRef.current = { mode: 'transform', kind: 'rotate', center, startWorld: screenToWorld(e.clientX, e.clientY), startPositions };
  };

  // ---------------------------------------------------------------------
  // Keyboard
  // ---------------------------------------------------------------------
  const onKeyDown = (e) => {
    if (viewMode) return; // View mode is look-only — undo/redo/shortcuts don't apply since nothing can be selected or edited
    if (e.key === 'Delete' || e.key === 'Backspace') {
      e.preventDefault();
      deleteSelection();
    } else if (e.key === 'Escape') {
      setSelectedVertexIds(new Set());
      setSelectedEdgeIds(new Set());
      setSelectedCircleIds(new Set());
      clearToolInProgress();
      setLocalEditGroupId(null);
    } else if (e.key === 'Enter' && polylineChain.length) {
      setPolylineChain([]);
    } else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z' && e.shiftKey) {
      e.preventDefault();
      redo();
    } else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z') {
      e.preventDefault();
      undo();
    } else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'y') {
      e.preventDefault();
      redo();
    } else if (!e.metaKey && !e.ctrlKey && e.key.toLowerCase() === 'g' && selectedVertexIds.size > 1) {
      e.preventDefault();
      commitState(e.shiftKey ? ungroupVertices(doc, selectedVertexIds) : groupVertices(doc, selectedVertexIds));
    } else if (!e.metaKey && !e.ctrlKey && !e.target.closest('select')) {
      const map = { v: 'select', p: 'vertex', e: 'edge', l: 'polyline', c: 'circle', t: 'text', i: 'eyedropper', f: 'fill' };
      const next = map[e.key.toLowerCase()];
      if (next) {
        setTool(next);
        clearToolInProgress();
      }
    }
  };

  const exportSvg = () => {
    const svg = compileVectorSvg(doc);
    const blob = new Blob([svg], { type: 'image/svg+xml' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${(doc.title || file.name || 'vector-art').replace(/\.vec$/i, '')}.svg`;
    a.click();
    URL.revokeObjectURL(url);
  };

  if (loading) {
    return (
      <div className="db-loading">
        <IconLoader size={18} /> Loading vector art…
      </div>
    );
  }

  const selectionBox = !viewMode && tool === 'select' && selectedVertexIds.size > 1 ? bboxOf(verticesForRender, selectedVertexIds) : null;
  // A text counts as "selected" once ALL 4 of its corners are — see
  // onTextPointerDown and the Text section of vectorState.js. Used for the
  // toolbar's text style controls and the layer-move buttons below; a
  // partial-corner vertex selection (e.g. mid-marquee) doesn't count.
  const selectedTextIds = new Set(doc.texts.filter((t) => [t.v1, t.v2, t.v3, t.v4].every((id) => selectedVertexIds.has(id))).map((t) => t.id));
  // A text's 4 corners must stay independently draggable (that's what
  // produces the skew/trapezoid effect) — grouping them would make moving
  // one drag the whole group instead, silently breaking that. So Group
  // is unavailable whenever the selection includes a fully-selected text.
  const canGroup = selectedVertexIds.size > 1 && !selectionIsExactlyOneGroup(doc, selectedVertexIds) && selectedTextIds.size === 0;
  const canUngroup = selectionIsExactlyOneGroup(doc, selectedVertexIds);

  return (
    <div className="vector-view">
      <VectorToolbar
        tool={tool}
        onSetTool={(t) => {
          setTool(t);
          clearToolInProgress();
        }}
        activeStyle={activeStyle}
        onSetColor={(color) => {
          setActiveStyle((s) => ({ ...s, color }));
          if (selectedEdgeIds.size) commitState(Array.from(selectedEdgeIds).reduce((d, id) => setEdgeStyle(d, id, { color }), doc));
          if (selectedCircleIds.size) commitState(Array.from(selectedCircleIds).reduce((d, id) => setCircleStyle(d, id, { style: { color } }), doc));
        }}
        onSetThickness={(thickness) => {
          setActiveStyle((s) => ({ ...s, thickness }));
          if (selectedEdgeIds.size) commitState(Array.from(selectedEdgeIds).reduce((d, id) => setEdgeStyle(d, id, { thickness }), doc));
          if (selectedCircleIds.size) commitState(Array.from(selectedCircleIds).reduce((d, id) => setCircleStyle(d, id, { style: { thickness } }), doc));
        }}
        activeRadius={activeRadius}
        onSetRadius={(r) => {
          setActiveRadius(r);
          if (selectedCircleIds.size) commitState(Array.from(selectedCircleIds).reduce((d, id) => resizeCircle(d, id, r), doc));
        }}
        circleFill={activeCircleFill}
        onSetCircleFill={(fill) => {
          setActiveCircleFill(fill);
          if (selectedCircleIds.size) commitState(Array.from(selectedCircleIds).reduce((d, id) => setCircleStyle(d, id, { fill }), doc));
        }}
        activeTextStyle={activeTextStyle}
        onSetTextColor={(color) => {
          setActiveTextStyle((s) => ({ ...s, color }));
          if (selectedTextIds.size) commitState(Array.from(selectedTextIds).reduce((d, id) => setTextStyle(d, id, { color }), doc));
        }}
        onSetTextFontSize={(fontSize) => {
          setActiveTextStyle((s) => ({ ...s, fontSize }));
          if (selectedTextIds.size) commitState(Array.from(selectedTextIds).reduce((d, id) => setTextStyle(d, id, { fontSize }), doc));
        }}
        onSetTextAlign={(align) => {
          setActiveTextStyle((s) => ({ ...s, align }));
          if (selectedTextIds.size) commitState(Array.from(selectedTextIds).reduce((d, id) => setTextStyle(d, id, { align }), doc));
        }}
        canvasBackground={doc.canvas.background}
        onSetCanvasBackground={(color) => commitState(setCanvasBackground(doc, color))}
        axisSnapEnabled={axisSnapEnabled}
        onToggleAxisSnap={() => setAxisSnapEnabled((v) => !v)}
        layersPanelOpen={layersPanelOpen}
        onToggleLayersPanel={() => setLayersPanelOpen((v) => !v)}
        descriptionPanelOpen={descriptionPanelOpen}
        onToggleDescriptionPanel={() => setDescriptionPanelOpen((v) => !v)}
        viewMode={viewMode}
        onToggleViewMode={() => {
          setViewMode((v) => !v);
          // Reset to a neutral tool and clear every selection/in-progress
          // gesture on the way in OR out — otherwise edit-only UI (handles,
          // 0px dashed guides, an in-progress polyline) could pop back with
          // stale state the moment the user returns to Edit mode.
          setTool('select');
          setSelectedVertexIds(new Set());
          setSelectedEdgeIds(new Set());
          setSelectedCircleIds(new Set());
          clearToolInProgress();
        }}
        onUndo={undo}
        onRedo={redo}
        canUndo={pastRef.current.length > 0}
        canRedo={futureRef.current.length > 0}
        zoom={viewport.zoom}
        onZoomIn={() => zoomBy(1.2)}
        onZoomOut={() => zoomBy(1 / 1.2)}
        onZoomReset={() => setViewport((v) => ({ ...v, zoom: 1 }))}
        onFitToContent={fitToContent}
        onExportSvg={exportSvg}
      />
      {/* historyTick isn't read directly — it exists purely to force this toolbar to
          re-render after undo/redo mutate the ref-backed history stacks below. */}
      <div style={{ display: 'none' }}>{historyTick}</div>
      <div
        className={`vector-surface ${isPanning || spaceDown ? 'panning' : ''}`}
        ref={containerRef}
        tabIndex={0}
        style={{
          // The canvas is just this color filling the whole surface — not a
          // bounded box drawn inside it (see the removed vector-page rect
          // below) — with the alignment-dot texture picked to contrast
          // against whatever that color is.
          backgroundColor: doc.canvas.background,
          backgroundImage: viewMode ? 'none' : undefined, // the dot grid is an editing aid, not artwork — View mode hides it like everything else edit-only
          '--vector-dot-color': dotColor,
          backgroundPosition: `${viewport.x}px ${viewport.y}px`,
          backgroundSize: `${22 * viewport.zoom}px ${22 * viewport.zoom}px`
        }}
        onPointerDown={onBackgroundPointerDown}
        onPointerMove={onContainerPointerMove}
        onPointerUp={onContainerPointerUp}
        onPointerCancel={onContainerPointerUp}
        onKeyDown={onKeyDown}
      >
        <svg className="vector-svg" width="100%" height="100%">
          <rect className="vector-bg-hit" x="0" y="0" width="100%" height="100%" fill="transparent" />
          <g transform={`translate(${viewport.x} ${viewport.y}) scale(${viewport.zoom})`}>
            {/* Layers are a strict z-partition (see vectorState.js) —
                everything on a lower layer renders fully behind everything
                on a higher one, so the whole fills → circles → edges →
                miter-joints stack repeats per layer, bottom to top, rather
                than once globally. A hidden layer's content isn't
                rendered (or interactive) at all. */}
            {doc.layers
              .filter((layer) => layer.visible !== false)
              .map((layer) => (
                <g key={layer.id}>
                  {resolvedFills
                    .filter(({ fill }) => fill.layerId === layer.id)
                    .map(({ fill, resolved }) => (
                      <path
                        key={fill.id}
                        d={loopsToPathData([resolved.outer, ...resolved.holes])}
                        fill={fill.color}
                        stroke="none"
                        fillRule="evenodd"
                        className={`vector-fill ${tool === 'eyedropper' ? 'pickable' : ''}`}
                        onPointerDown={(ev) => onFillPointerDown(ev, fill)}
                      />
                    ))}

                  {circlesForRender
                    .filter((c) => c.layerId === layer.id)
                    .map((c) => {
                      const selected = selectedCircleIds.has(c.id);
                      const isZeroWeight = c.style.thickness === 0;
                      return (
                        <g key={c.id}>
                          {selected && !viewMode && (
                            <circle cx={c.cx} cy={c.cy} r={c.r} className="vector-selection-halo" strokeWidth={Math.max(c.style.thickness, 3) + 6 / viewport.zoom} />
                          )}
                          {isZeroWeight && !viewMode && (
                            <circle cx={c.cx} cy={c.cy} r={c.r} className="vector-zero-weight-guide" strokeWidth={1.5 / viewport.zoom} onPointerDown={(ev) => onCirclePointerDown(ev, c.id)} />
                          )}
                          <circle
                            cx={c.cx}
                            cy={c.cy}
                            r={c.r}
                            stroke={c.style.color}
                            strokeWidth={c.style.thickness}
                            fill={c.fill && c.fill !== 'none' ? c.fill : 'none'}
                            className={`vector-circle ${selected ? 'selected' : ''}`}
                            onPointerDown={viewMode ? undefined : (ev) => onCirclePointerDown(ev, c.id)}
                          />
                          {selected && !viewMode && (
                            <rect
                              className="vector-scale-handle"
                              style={{ cursor: 'ew-resize' }}
                              x={c.cx + c.r - 4 / viewport.zoom}
                              y={c.cy - 4 / viewport.zoom}
                              width={8 / viewport.zoom}
                              height={8 / viewport.zoom}
                              onPointerDown={(e) => beginCircleResize(e, c.id)}
                            />
                          )}
                        </g>
                      );
                    })}

                  {doc.texts
                    .filter((t) => t.layerId === layer.id)
                    .map((t) => {
                      const quad = resolveTextQuad(verticesForRender, t);
                      if (!quad) return null;
                      const matrix = computeQuadWarpMatrix3d(quad, DEFAULT_TEXT_WIDTH, DEFAULT_TEXT_HEIGHT);
                      const allCornersSelected = [t.v1, t.v2, t.v3, t.v4].every((id) => selectedVertexIds.has(id));
                      const isEmpty = !t.content;
                      return (
                        <g key={t.id}>
                          {allCornersSelected && !viewMode && (
                            <polygon points={quad.map((p) => `${p.x},${p.y}`).join(' ')} className="vector-selection-halo" fill="none" strokeWidth={2 / viewport.zoom} />
                          )}
                          <foreignObject x="0" y="0" width={DEFAULT_TEXT_WIDTH} height={DEFAULT_TEXT_HEIGHT} overflow="visible" style={{ transform: matrix, transformOrigin: '0 0', pointerEvents: viewMode || editingTextId === t.id ? 'none' : 'auto' }}>
                            <div
                              xmlns="http://www.w3.org/1999/xhtml"
                              className="vector-text-body"
                              style={{
                                width: DEFAULT_TEXT_WIDTH,
                                height: DEFAULT_TEXT_HEIGHT,
                                color: isEmpty ? undefined : t.color,
                                fontSize: t.fontSize,
                                textAlign: t.align
                              }}
                              onPointerDown={(ev) => onTextPointerDown(ev, t)}
                              onDoubleClick={(ev) => {
                                ev.stopPropagation();
                                if (!viewMode && tool === 'select') beginTextEdit(t);
                              }}
                            >
                              {/* An empty text is genuinely blank in the exported artwork (see
                                  compileVectorSvg) — this placeholder is Edit-mode-only, same
                                  spirit as the 0px-weight dashed guide, so it never leaks into
                                  View mode or the export. */}
                              {isEmpty ? (!viewMode && <span className="vector-text-placeholder">Double-click to edit</span>) : t.content}
                            </div>
                          </foreignObject>
                        </g>
                      );
                    })}

                  {sortedEdges
                    .filter((e) => e.layerId === layer.id)
                    .map((e) => {
                      const a = vertexById.get(e.v1);
                      const b = vertexById.get(e.v2);
                      if (!a || !b) return null;
                      const selected = selectedEdgeIds.has(e.id);
                      const isZeroWeight = e.style.thickness === 0;
                      return (
                        <g key={e.id}>
                          {/* Selection halo — a real extra line rather than only the
                              CSS filter, since a filter has nothing to shadow on a
                              true 0px-weight edge (stroke-width:0 paints nothing to
                              begin with). This is the "edge is selected" indicator. */}
                          {selected && !viewMode && (
                            <line x1={a.x} y1={a.y} x2={b.x} y2={b.y} className="vector-selection-halo" strokeWidth={Math.max(e.style.thickness, 3) + 6 / viewport.zoom} strokeLinecap="round" />
                          )}
                          {/* 0px-weight edges paint no real stroke (by design — see
                              vectorState.js) so they'd otherwise be both invisible
                              and unclickable; this dashed guide is Edit-mode-only
                              and disappears in View mode, matching the export. */}
                          {isZeroWeight && !viewMode && (
                            <line x1={a.x} y1={a.y} x2={b.x} y2={b.y} className="vector-zero-weight-guide" strokeWidth={1.5 / viewport.zoom} onPointerDown={(ev) => onEdgePointerDown(ev, e.id)} />
                          )}
                          <line
                            x1={a.x}
                            y1={a.y}
                            x2={b.x}
                            y2={b.y}
                            stroke={e.style.color}
                            strokeWidth={e.style.thickness}
                            strokeLinecap="butt"
                            strokeLinejoin="miter"
                            className={`vector-edge ${selected ? 'selected' : ''} ${snapPreview?.snappedEdgeId === e.id ? 'snap-target' : ''}`}
                            onPointerDown={viewMode ? undefined : (ev) => onEdgePointerDown(ev, e.id)}
                          />
                        </g>
                      );
                    })}

                  {/* Miter join wedges — see vectorTopology.js's
                      computeMiterJoints. Computed from THIS layer's own
                      edges only (a vertex with one edge on this layer and
                      another on a different layer never miters across
                      them), and drawn after this layer's own edges. These
                      are real artwork (they render in the exported SVG
                      too, see compileVectorSvg), so — unlike the
                      selection/snap UI below — they stay visible in View
                      mode as well as Edit mode. */}
                  {(miterJointsByLayer.get(layer.id) || []).map((j) => (
                    <polygon key={j.vertexId} points={j.points.map((p) => `${p.x},${p.y}`).join(' ')} fill={j.color} stroke="none" className="vector-miter-joint" />
                  ))}
                </g>
              ))}

            {/* In-progress circle draw preview — not yet a real circle in the
                doc, so it's rendered separately from circlesForRender. */}
            {circleDraft && !circleDraft.id && (
              <circle cx={circleDraft.cx} cy={circleDraft.cy} r={circleDraft.r} className="vector-zero-weight-guide" strokeWidth={1.5 / viewport.zoom} />
            )}

            {/* In-progress text draw preview — just a plain rectangle
                outline; the actual quad-warp rendering only applies once
                it's a real text with real corner vertices. */}
            {textDraft && (
              <rect
                x={Math.min(textDraft.x0, textDraft.x1)}
                y={Math.min(textDraft.y0, textDraft.y1)}
                width={Math.abs(textDraft.x1 - textDraft.x0)}
                height={Math.abs(textDraft.y1 - textDraft.y0)}
                className="vector-zero-weight-guide"
                strokeWidth={1.5 / viewport.zoom}
              />
            )}

            {/* Selection move hit-area, rendered BEFORE vertices so an
                individual vertex on top of it still gets pointer priority
                for its own more-specific click behavior. Vertices/edges
                are layerless selection targets, so this sits above every
                layer's content rather than inside the loop above. */}
            {selectionBox && (
              <rect
                className="vector-selection-move-hit"
                x={selectionBox.minX}
                y={selectionBox.minY}
                width={selectionBox.maxX - selectionBox.minX}
                height={selectionBox.maxY - selectionBox.minY}
                onPointerDown={onSelectionBoxPointerDown}
              />
            )}

            {/* Live preview of the segment about to be created */}
            {tool === 'edge' && edgeChainFirst && pointerWorld && vertexById.get(edgeChainFirst) && (
              <line className="vector-preview-line" x1={vertexById.get(edgeChainFirst).x} y1={vertexById.get(edgeChainFirst).y} x2={pointerWorld.x} y2={pointerWorld.y} />
            )}
            {tool === 'polyline' && polylineChain.length > 0 && pointerWorld && vertexById.get(polylineChain[polylineChain.length - 1]) && (
              <line
                className="vector-preview-line"
                x1={vertexById.get(polylineChain[polylineChain.length - 1]).x}
                y1={vertexById.get(polylineChain[polylineChain.length - 1]).y}
                x2={pointerWorld.x}
                y2={pointerWorld.y}
              />
            )}
            {dragRef.current?.mode === 'spawn-connected' && pointerWorld && vertexById.get(dragRef.current.fromVertexId) && (
              <line
                className="vector-preview-line"
                x1={vertexById.get(dragRef.current.fromVertexId).x}
                y1={vertexById.get(dragRef.current.fromVertexId).y}
                x2={pointerWorld.x}
                y2={pointerWorld.y}
              />
            )}

            {/* Snapping guidelines: full-length dashed lines through whichever
                vertex produced an axis snap, plus a highlight ring/marker on
                a snapped vertex or edge point. */}
            {!viewMode && snapPreview?.axisSnapVertexX != null && vertexById.get(snapPreview.axisSnapVertexX) && (
              <line className="vector-snap-guide" x1={snapPreview.point.x} y1={-GUIDE_LINE_SPAN} x2={snapPreview.point.x} y2={GUIDE_LINE_SPAN} />
            )}
            {!viewMode && snapPreview?.axisSnapVertexY != null && vertexById.get(snapPreview.axisSnapVertexY) && (
              <line className="vector-snap-guide" x1={-GUIDE_LINE_SPAN} y1={snapPreview.point.y} x2={GUIDE_LINE_SPAN} y2={snapPreview.point.y} />
            )}
            {!viewMode && snapPreview?.snappedVertexId && vertexById.get(snapPreview.snappedVertexId) && (
              <circle className="vector-snap-marker" cx={snapPreview.point.x} cy={snapPreview.point.y} r={9 / viewport.zoom} />
            )}
            {!viewMode && snapPreview?.snappedEdgeId && <circle className="vector-snap-marker" cx={snapPreview.point.x} cy={snapPreview.point.y} r={5 / viewport.zoom} />}

            {/* Vertex dots are an editing aid, not artwork — hidden in View mode. */}
            {!viewMode &&
              verticesForRender.map((v) => {
                const selected = selectedVertexIds.has(v.id);
                const gid = groupIdForVertex(doc, v.id);
                return (
                  <circle
                    key={v.id}
                    cx={v.x}
                    cy={v.y}
                    r={5 / viewport.zoom}
                    className={`vector-vertex ${selected ? 'selected' : ''} ${gid ? 'grouped' : ''} ${polylineChain.includes(v.id) ? 'in-chain' : ''}`}
                    onPointerDown={(e) => onVertexPointerDown(e, v.id)}
                    onDoubleClick={(e) => onVertexDoubleClick(e, v.id)}
                  />
                );
              })}

            {!viewMode && marquee && (
              <rect
                className="vector-marquee"
                x={Math.min(marquee.x0, marquee.x1)}
                y={Math.min(marquee.y0, marquee.y1)}
                width={Math.abs(marquee.x1 - marquee.x0)}
                height={Math.abs(marquee.y1 - marquee.y0)}
              />
            )}

            {selectionBox && (
              <g className="vector-transform-handles">
                <rect x={selectionBox.minX} y={selectionBox.minY} width={selectionBox.maxX - selectionBox.minX} height={selectionBox.maxY - selectionBox.minY} className="vector-selection-box" />
                {handleConfigsFor(selectionBox).map((h) => (
                  <rect
                    key={h.key}
                    className="vector-scale-handle"
                    style={{ cursor: h.cursor }}
                    x={h.x - 4 / viewport.zoom}
                    y={h.y - 4 / viewport.zoom}
                    width={8 / viewport.zoom}
                    height={8 / viewport.zoom}
                    onPointerDown={(e) => beginScale(e, h)}
                  />
                ))}
                <line className="vector-rotate-stem" x1={(selectionBox.minX + selectionBox.maxX) / 2} y1={selectionBox.minY} x2={(selectionBox.minX + selectionBox.maxX) / 2} y2={selectionBox.minY - 24 / viewport.zoom} />
                <circle
                  className="vector-rotate-handle"
                  cx={(selectionBox.minX + selectionBox.maxX) / 2}
                  cy={selectionBox.minY - 24 / viewport.zoom}
                  r={6 / viewport.zoom}
                  onPointerDown={(e) => beginRotate(e, selectionBox)}
                />
              </g>
            )}
          </g>
        </svg>

        {/* Text content editing overlay — deliberately a plain, unwarped
            <textarea> positioned near (not exactly matching) the quad's
            on-screen bounds, rather than making the warped foreignObject
            itself directly editable. Caret/selection behavior inside a
            CSS matrix3d-transformed contentEditable is inconsistent
            across browsers; a flat textarea sidesteps that entirely while
            still satisfying "edit the content even after a transform has
            occurred" — the transform only ever affects how the committed
            text is DISPLAYED, never how it's typed. */}
        {editingTextId &&
          (() => {
            const editingText = doc.texts.find((t) => t.id === editingTextId);
            if (!editingText) return null;
            const quad = resolveTextQuad(verticesForRender, editingText);
            if (!quad) return null;
            const screenPts = quad.map((p) => worldToLocal(p.x, p.y));
            const minX = Math.min(...screenPts.map((p) => p.x));
            const minY = Math.min(...screenPts.map((p) => p.y));
            const maxX = Math.max(...screenPts.map((p) => p.x));
            const maxY = Math.max(...screenPts.map((p) => p.y));
            return (
              <textarea
                className="vector-text-edit-overlay"
                style={{ left: minX, top: minY, width: Math.max(80, maxX - minX), height: Math.max(40, maxY - minY) }}
                value={editingTextBuffer}
                autoFocus
                onChange={(e) => setEditingTextBuffer(e.target.value)}
                onPointerDown={(e) => e.stopPropagation()}
                onKeyDown={(e) => {
                  e.stopPropagation();
                  if (e.key === 'Escape') {
                    e.preventDefault();
                    commitTextEdit();
                  }
                }}
                onBlur={commitTextEdit}
              />
            );
          })()}

        {!viewMode && (selectedVertexIds.size > 0 || selectedEdgeIds.size > 0 || selectedCircleIds.size > 0) && (
          <div className="vector-selection-toolbar">
            {canGroup && (
              <button className="text-action" onClick={() => commitState(groupVertices(doc, selectedVertexIds))} title="Group (G)">
                Group
              </button>
            )}
            {canUngroup && (
              <button className="text-action" onClick={() => commitState(ungroupVertices(doc, selectedVertexIds))} title="Ungroup (Shift+G)">
                Ungroup
              </button>
            )}
            {/* Layer reassignment applies to edges/circles/texts — a pure
                (non-text) vertex selection is layerless shared
                infrastructure (see vectorState.js) and gets no layer-move
                controls; a fully-selected text counts via selectedTextIds. */}
            {(selectedEdgeIds.size > 0 || selectedCircleIds.size > 0 || selectedTextIds.size > 0) && (
              <>
                <button
                  className="icon-btn"
                  title="Move selection to the layer above"
                  disabled={doc.layers.findIndex((l) => l.id === safeActiveLayerId) >= doc.layers.length - 1}
                  onClick={() => {
                    const i = doc.layers.findIndex((l) => l.id === safeActiveLayerId);
                    if (i < doc.layers.length - 1) commitState(moveToLayer(doc, { edgeIds: selectedEdgeIds, circleIds: selectedCircleIds, textIds: selectedTextIds }, doc.layers[i + 1].id));
                  }}
                >
                  ↑
                </button>
                <button
                  className="icon-btn"
                  title="Move selection to the layer below"
                  disabled={doc.layers.findIndex((l) => l.id === safeActiveLayerId) <= 0}
                  onClick={() => {
                    const i = doc.layers.findIndex((l) => l.id === safeActiveLayerId);
                    if (i > 0) commitState(moveToLayer(doc, { edgeIds: selectedEdgeIds, circleIds: selectedCircleIds, textIds: selectedTextIds }, doc.layers[i - 1].id));
                  }}
                >
                  ↓
                </button>
              </>
            )}
            <button className="icon-btn" onClick={deleteSelection} title="Delete">
              <IconTrash size={14} />
            </button>
          </div>
        )}
      </div>

      {layersPanelOpen && (
        <div className="vector-layers-panel">
          <div className="vector-layers-panel-header">
            <span>Layers</span>
            <button
              className="icon-btn"
              title="Add layer"
              onClick={() => {
                const next = addLayer(doc, undefined);
                commitState(next);
                setActiveLayerId(next._newLayerId);
              }}
            >
              <IconPlus size={13} />
            </button>
          </div>
          <div className="vector-layers-list">
            {/* Rendered top-to-bottom (reverse of the stored bottom-to-top
                z-order) so the layer that's visually on top is listed
                first, matching how every other layers panel reads. */}
            {[...doc.layers].reverse().map((layer) => {
              const i = doc.layers.findIndex((l) => l.id === layer.id);
              return (
                <div key={layer.id} className={`vector-layer-row ${layer.id === safeActiveLayerId ? 'active' : ''}`} onClick={() => setActiveLayerId(layer.id)}>
                  <button
                    className="icon-btn"
                    title={layer.visible === false ? 'Show layer' : 'Hide layer'}
                    onClick={(e) => {
                      e.stopPropagation();
                      commitState(setLayerVisible(doc, layer.id, layer.visible === false));
                    }}
                  >
                    <IconEye size={13} style={layer.visible === false ? { opacity: 0.35 } : undefined} />
                  </button>
                  <input className="vector-layer-name-input" value={layer.name} onClick={(e) => e.stopPropagation()} onChange={(e) => commitState(renameLayer(doc, layer.id, e.target.value))} />
                  <button
                    className="icon-btn"
                    title="Move layer up"
                    disabled={i === doc.layers.length - 1}
                    onClick={(e) => {
                      e.stopPropagation();
                      commitState(reorderLayer(doc, layer.id, 'up'));
                    }}
                  >
                    ↑
                  </button>
                  <button
                    className="icon-btn"
                    title="Move layer down"
                    disabled={i === 0}
                    onClick={(e) => {
                      e.stopPropagation();
                      commitState(reorderLayer(doc, layer.id, 'down'));
                    }}
                  >
                    ↓
                  </button>
                  <button
                    className="icon-btn"
                    title="Delete layer"
                    disabled={doc.layers.length <= 1}
                    onClick={(e) => {
                      e.stopPropagation();
                      commitState(removeLayer(doc, layer.id));
                    }}
                  >
                    <IconTrash size={13} />
                  </button>
                </div>
              );
            })}
          </div>
          <label className="vector-layers-snap-toggle">
            <input type="checkbox" checked={snapCrossLayer} onChange={(e) => setSnapCrossLayer(e.target.checked)} />
            Snap across all layers
          </label>
        </div>
      )}

      {/* Description sidebar — the document's own raw markdown text (see
          setDescription), edited exactly like a note's content: frontmatter
          block, tags, and wikilinks all live in that one text, with
          PropertiesPanel giving the same clickable read display a note's
          frontmatter gets elsewhere, and MiniMarkdownEditor giving the same
          inline-styled editing experience (not full markdown rendering —
          same "lighter than the full note editor" scope MiniMarkdownEditor
          already has everywhere else it's used). */}
      {descriptionPanelOpen && (
        <div className="vector-description-panel">
          <div className="vector-description-panel-header">
            <span>Description</span>
            <button className="icon-btn" title="Close" onClick={() => setDescriptionPanelOpen(false)}>
              <IconX size={13} />
            </button>
          </div>
          <div className="vector-description-panel-body">
            {frontmatterProperties.length > 0 && <PropertiesPanel properties={frontmatterProperties} handlers={safeHandlers} linkIndex={linkIndex} />}
            <MiniMarkdownEditor
              value={doc.description}
              onCommit={(text) => commitState(setDescription(doc, text))}
              placeholderText="Describe this piece — frontmatter, tags, links…"
              linkIndex={linkIndex}
              allTags={safeHandlers.allTags || []}
              className="vector-description-editor"
            />
          </div>
        </div>
      )}
    </div>
  );
}

export { VectorEditorView };
