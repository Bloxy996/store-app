import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { IconLoader, IconTrash } from '../../components/icons.jsx';
import { VectorToolbar } from './VectorToolbar.jsx';
import {
  AXIS_SNAP_PX,
  DEFAULT_STYLE,
  EDGE_SNAP_PX,
  SEVER_THRESHOLD_PX,
  VECTOR_ZOOM_MAX,
  VECTOR_ZOOM_MIN,
  VERTEX_HIT_PX,
  VERTEX_SNAP_PX,
  addEdge,
  addFillAt,
  addVertex,
  compileVectorSvg,
  deleteEdges,
  deleteVertices,
  groupIdForVertex,
  groupVertexIds,
  groupVertices,
  moveVertices,
  parseVectorContent,
  serializeVectorState,
  severEdgeEndpoint,
  setEdgeStyle,
  subdivideEdge,
  ungroupVertices
} from './vectorState.js';
import { SpatialGrid, buildVertexAdjacency, dist, findMinimalFaceContainingPoint, snapCandidate } from './vectorTopology.js';
import { clamp } from '../../lib/mathUtils.js';

const MOVE_THRESHOLD = 3; // world px before a pointerdown counts as a drag, not a click — same convention as CanvasView


// Resolves a raw click point to a usable vertex id, applying the editor's
// snap priority (vertex > edge-subdivide > axis) and creating whatever the
// snap result implies. Pure — returns the next doc plus the vertex id
// without committing it, so callers can fold a whole gesture (e.g. a
// polyline click that both places a point AND connects it to the previous
// one) into a single undo step.
function resolvePlacement(doc, grid, rawPoint, opts = {}) {
  const snap = snapCandidate(doc.vertices, doc.edges, rawPoint, {
    grid,
    vertexPx: opts.vertexPx ?? VERTEX_SNAP_PX,
    edgePx: opts.allowSubdivide === false ? -1 : EDGE_SNAP_PX,
    axisPx: opts.allowAxisSnap === false ? -1 : AXIS_SNAP_PX,
    excludeVertexId: opts.excludeVertexId
  });
  if (snap.snappedVertexId) return { nextDoc: doc, vertexId: snap.snappedVertexId };
  if (snap.snappedEdgeId) {
    const nextDoc = subdivideEdge(doc, snap.snappedEdgeId, snap.point);
    return { nextDoc, vertexId: nextDoc._newVertexId };
  }
  const nextDoc = addVertex(doc, snap.point.x, snap.point.y);
  return { nextDoc, vertexId: nextDoc._newVertexId };
}

function bboxOf(vertices, ids) {
  const pts = vertices.filter((v) => ids.has(v.id));
  if (!pts.length) return null;
  const xs = pts.map((p) => p.x), ys = pts.map((p) => p.y);
  return { minX: Math.min(...xs), maxX: Math.max(...xs), minY: Math.min(...ys), maxY: Math.max(...ys) };
}


function VectorEditorView({ file, content, onChange, loading }) {
  const [doc, setDoc] = useState(() => parseVectorContent(content));
  const [viewport, setViewport] = useState({ x: 0, y: 0, zoom: 1 });
  const [tool, setTool] = useState('select');
  const [activeStyle, setActiveStyle] = useState(DEFAULT_STYLE);
  const [axisSnapEnabled, setAxisSnapEnabled] = useState(true);
  const [selectedVertexIds, setSelectedVertexIds] = useState(() => new Set());
  const [selectedEdgeIds, setSelectedEdgeIds] = useState(() => new Set());
  const [localEditGroupId, setLocalEditGroupId] = useState(null);
  const [edgeChainFirst, setEdgeChainFirst] = useState(null);
  const [polylineChain, setPolylineChain] = useState([]);
  const [liveOverrides, setLiveOverrides] = useState(null);
  const [marquee, setMarquee] = useState(null);
  const [pointerWorld, setPointerWorld] = useState(null);
  const [spaceDown, setSpaceDown] = useState(false);
  const [isPanning, setIsPanning] = useState(false);
  const [historyTick, setHistoryTick] = useState(0);

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
    if (selectedVertexIds.size) {
      commitState(deleteVertices(doc, selectedVertexIds));
      setSelectedVertexIds(new Set());
    }
  }, [doc, selectedVertexIds, selectedEdgeIds, commitState]);

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

    if (tool === 'eyedropper') return; // eyedropper only samples edges — vertices carry no style

    if (tool === 'vertex') {
      // Drag FROM an existing vertex spawns a new connected vertex at the drop point.
      dragRef.current = { mode: 'spawn-connected', fromVertexId: vertexId, startWorld: world, moved: false };
      return;
    }

    if (tool === 'edge') {
      if (edgeChainFirst && edgeChainFirst !== vertexId) {
        const { state: next, ok } = addEdge(doc, edgeChainFirst, vertexId, activeStyle);
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
          const { state: next, ok } = addEdge(doc, last, vertexId, activeStyle);
          if (ok) commitState(next);
        }
        setPolylineChain([]);
        return;
      }
      if (polylineChain.length) {
        const last = polylineChain[polylineChain.length - 1];
        const { state: next, ok } = addEdge(doc, last, vertexId, activeStyle);
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
    dragRef.current = { mode: 'move', ids, startPositions, startWorld: world, moved: false };
  };

  const onVertexDoubleClick = (e, vertexId) => {
    e.stopPropagation();
    const gid = groupIdForVertex(doc, vertexId);
    if (gid) {
      setLocalEditGroupId(gid);
      setSelectedVertexIds(new Set([vertexId]));
    }
  };

  const onEdgePointerDown = (e, edgeId) => {
    e.stopPropagation();
    if (spaceDown) {
      beginPan(e);
      return;
    }
    if (tool === 'eyedropper') {
      const edge = doc.edges.find((ed) => ed.id === edgeId);
      if (edge) setActiveStyle({ ...edge.style });
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

  const onBackgroundPointerDown = (e) => {
    if (e.target !== containerRef.current && !e.target.classList.contains('vector-bg-hit')) return;
    containerRef.current.focus();
    if (spaceDown || e.button === 1) {
      beginPan(e);
      return;
    }
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
      const { nextDoc, vertexId } = resolvePlacement(doc, grid, world);
      if (nextDoc !== doc) commitState(nextDoc);
      if (polylineChain.length) {
        const last = polylineChain[polylineChain.length - 1];
        const { state: withEdge, ok } = addEdge(nextDoc, last, vertexId, activeStyle);
        if (ok) commitState(withEdge);
      }
      setPolylineChain((chain) => [...chain, vertexId]);
      return;
    }
    if (tool === 'fill') {
      const { state: next, ok } = addFillAt(doc, world, activeStyle.color);
      if (ok) commitState(next);
      return;
    }
    if (tool === 'eyedropper') return;

    // select tool: start a marquee
    setSelectedVertexIds(new Set());
    setSelectedEdgeIds(new Set());
    if (localEditGroupId) setLocalEditGroupId(null);
    dragRef.current = { mode: 'marquee', startWorld: world };
    setMarquee({ x0: world.x, y0: world.y, x1: world.x, y1: world.y });
  };

  const onContainerPointerMove = (e) => {
    const world = screenToWorld(e.clientX, e.clientY);
    setPointerWorld(world);
    const drag = dragRef.current;
    if (!drag) return;

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
      return;
    }

    if (drag.mode === 'move') {
      if (dist(drag.startWorld, world) > MOVE_THRESHOLD / viewport.zoom) drag.moved = true;
      const dx = world.x - drag.startWorld.x;
      const dy = world.y - drag.startWorld.y;
      const map = new Map();
      for (const [id, pos] of drag.startPositions) map.set(id, { x: pos.x + dx, y: pos.y + dy });
      scheduleLiveOverrides(map);
      return;
    }

    if (drag.mode === 'spawn-connected') {
      if (dist(drag.startWorld, world) > MOVE_THRESHOLD / viewport.zoom) drag.moved = true;
      return; // preview line follows pointerWorld automatically; the actual vertex/edge is created on pointerup
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
        dragRef.current = { mode: 'move', ids: new Set([next._newVertexId]), startPositions: new Map([[next._newVertexId, world]]), startWorld: world, moved: true };
        setSelectedVertexIds(new Set([next._newVertexId]));
      }
      return;
    }

    if (drag.mode === 'transform') {
      const next = computeTransform(drag, world, e.shiftKey);
      scheduleLiveOverrides(next);
    }
  };

  const onContainerPointerUp = () => {
    const drag = dragRef.current;
    dragRef.current = null;
    setIsPanning(false);
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
        const { nextDoc } = resolvePlacement(doc, grid, pointerWorld);
        if (nextDoc !== doc) commitState(nextDoc);
      }
      return;
    }

    if (drag.mode === 'spawn-connected') {
      if (pointerWorld) {
        const dropDist = dist(drag.startWorld, pointerWorld);
        if (dropDist > MOVE_THRESHOLD / viewport.zoom) {
          const { nextDoc, vertexId } = resolvePlacement(doc, grid, pointerWorld, { excludeVertexId: drag.fromVertexId });
          const { state: withEdge, ok } = addEdge(nextDoc, drag.fromVertexId, vertexId, activeStyle);
          commitState(ok ? withEdge : nextDoc);
        }
      }
      return;
    }

    if (drag.mode === 'move' || drag.mode === 'transform') {
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
      const scaleX = drag.spanX === 0 ? 1 : dx / drag.spanX;
      const scaleY = drag.spanY === 0 ? 1 : dy / drag.spanY;
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

  const beginScale = (e, corner, box) => {
    e.stopPropagation();
    containerRef.current.setPointerCapture(e.pointerId);
    const anchor = { x: corner.x === 'min' ? box.maxX : box.minX, y: corner.y === 'min' ? box.maxY : box.minY };
    const world = screenToWorld(e.clientX, e.clientY);
    const startPositions = new Map(Array.from(selectedVertexIds).map((id) => [id, vertexById.get(id)]));
    dragRef.current = { mode: 'transform', kind: 'scale', anchor, spanX: world.x - anchor.x, spanY: world.y - anchor.y, startPositions };
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
    if (e.key === 'Delete' || e.key === 'Backspace') {
      e.preventDefault();
      deleteSelection();
    } else if (e.key === 'Escape') {
      setSelectedVertexIds(new Set());
      setSelectedEdgeIds(new Set());
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
      const map = { v: 'select', p: 'vertex', e: 'edge', l: 'polyline', i: 'eyedropper', f: 'fill' };
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

  const selectionBox = selectedVertexIds.size > 1 ? bboxOf(verticesForRender, selectedVertexIds) : null;
  const fillFaces = doc.fills
    .map((f) => ({ fill: f, face: findMinimalFaceContainingPoint(doc.vertices, doc.edges, f.seed) }))
    .filter((x) => x.face);

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
        }}
        onSetThickness={(thickness) => {
          setActiveStyle((s) => ({ ...s, thickness }));
          if (selectedEdgeIds.size) commitState(Array.from(selectedEdgeIds).reduce((d, id) => setEdgeStyle(d, id, { thickness }), doc));
        }}
        axisSnapEnabled={axisSnapEnabled}
        onToggleAxisSnap={() => setAxisSnapEnabled((v) => !v)}
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
        style={{ backgroundPosition: `${viewport.x}px ${viewport.y}px`, backgroundSize: `${22 * viewport.zoom}px ${22 * viewport.zoom}px` }}
        onPointerDown={onBackgroundPointerDown}
        onPointerMove={onContainerPointerMove}
        onPointerUp={onContainerPointerUp}
        onPointerCancel={onContainerPointerUp}
        onKeyDown={onKeyDown}
      >
        <svg className="vector-svg" width="100%" height="100%">
          <rect className="vector-bg-hit" x="0" y="0" width="100%" height="100%" fill="transparent" />
          <g transform={`translate(${viewport.x} ${viewport.y}) scale(${viewport.zoom})`}>
            {fillFaces.map(({ fill, face }) => (
              <polygon key={fill.id} points={face.points.map((p) => `${p.x},${p.y}`).join(' ')} fill={fill.color} stroke="none" />
            ))}

            {sortedEdges.map((e) => {
              const a = vertexById.get(e.v1);
              const b = vertexById.get(e.v2);
              if (!a || !b) return null;
              return (
                <line
                  key={e.id}
                  x1={a.x}
                  y1={a.y}
                  x2={b.x}
                  y2={b.y}
                  stroke={e.style.color}
                  strokeWidth={e.style.thickness}
                  strokeLinecap="butt"
                  strokeLinejoin="miter"
                  className={`vector-edge ${selectedEdgeIds.has(e.id) ? 'selected' : ''}`}
                  onPointerDown={(ev) => onEdgePointerDown(ev, e.id)}
                />
              );
            })}

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

            {verticesForRender.map((v) => {
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

            {marquee && (
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
                {[
                  { x: 'min', y: 'min' },
                  { x: 'max', y: 'min' },
                  { x: 'min', y: 'max' },
                  { x: 'max', y: 'max' }
                ].map((corner) => (
                  <rect
                    key={`${corner.x}-${corner.y}`}
                    className="vector-scale-handle"
                    x={(corner.x === 'min' ? selectionBox.minX : selectionBox.maxX) - 4 / viewport.zoom}
                    y={(corner.y === 'min' ? selectionBox.minY : selectionBox.maxY) - 4 / viewport.zoom}
                    width={8 / viewport.zoom}
                    height={8 / viewport.zoom}
                    onPointerDown={(e) => beginScale(e, corner, selectionBox)}
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

        {(selectedVertexIds.size > 0 || selectedEdgeIds.size > 0) && (
          <div className="vector-selection-toolbar">
            <button className="icon-btn" onClick={deleteSelection} title="Delete">
              <IconTrash size={14} />
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

export { VectorEditorView };
