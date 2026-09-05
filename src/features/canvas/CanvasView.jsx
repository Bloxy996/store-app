import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { IconLoader, IconTrash } from '../../components/icons.jsx';
import { CanvasFilePickerModal } from './CanvasFilePickerModal.jsx';
import { CanvasEdgesLayer, CanvasNode } from './CanvasNode.jsx';
import { CanvasToolbar } from './CanvasToolbar.jsx';
import { CANVAS_COLORS, CANVAS_CONNECT_NEAR_PX, CANVAS_GRID_SIZE, CANVAS_MIN_H, CANVAS_MIN_W, CANVAS_MOVE_THRESHOLD, CANVAS_ZOOM_MAX, CANVAS_ZOOM_MIN, canvasHitTest, canvasNearestSide, canvasNodeRect, canvasNodesNear, canvasOppositeSide, canvasSideAnchor, canvasSnap, parseCanvasContent, serializeCanvasState } from './canvasState.js';
import { clamp } from '../../lib/mathUtils.js';
import { uid } from '../../lib/paneTree.js';
import { opensInEditorPane } from '../../lib/vaultConfig.js';


function CanvasView({ file, content, onChange, handlers, linkIndex, loading, allFiles }) {
  const [state, setState] = useState(() => parseCanvasContent(content));
  const [viewport, setViewport] = useState({ x: 0, y: 0, zoom: 1 });
  const [selectedIds, setSelectedIds] = useState(() => new Set());
  const [selectedEdgeId, setSelectedEdgeId] = useState(null);
  const [hoveredId, setHoveredId] = useState(null);
  const [editingId, setEditingId] = useState(null);
  const [liveOverrides, setLiveOverrides] = useState(null);
  const [marquee, setMarquee] = useState(null);
  const [connecting, setConnecting] = useState(null);
  const [connectTargetId, setConnectTargetId] = useState(null);
  const [nearbyConnectIds, setNearbyConnectIds] = useState(null);
  const [filePickerOpen, setFilePickerOpen] = useState(false);
  const [spaceDown, setSpaceDown] = useState(false);
  const [isPanning, setIsPanning] = useState(false);
  // Off by default: nothing snaps unless the user turns this on from the
  // toolbar. See CanvasToolbar's grid-snap button.
  const [snapEnabled, setSnapEnabled] = useState(false);

  const containerRef = useRef(null);
  const dragRef = useRef(null);
  const rafRef = useRef(null);
  const pendingOverridesRef = useRef(null);
  const pointersRef = useRef(new Map());
  const loadedOnceRef = useRef(!loading);

  // The buffer starts empty while Drive is still fetching content (see
  // ensureFileLoaded in App) — this component mounts once per open tab, so
  // it re-syncs its local state the first time real content actually
  // arrives, then leaves local edits alone from then on (same "local state
  // is the source of truth once loaded" rule DatabaseView uses).
  useEffect(() => {
    if (!loading && !loadedOnceRef.current) {
      loadedOnceRef.current = true;
      setState(parseCanvasContent(content));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loading]);

  const commit = useCallback(
    (updater) => {
      setState((prev) => {
        const next = typeof updater === 'function' ? updater(prev) : updater;
        onChange(serializeCanvasState(next));
        return next;
      });
    },
    [onChange]
  );

  const allFilesById = useMemo(() => new Map((allFiles || []).map((f) => [f.id, f])), [allFiles]);

  const nodesForRender = useMemo(() => {
    if (!liveOverrides) return state.nodes;
    return state.nodes.map((n) => (liveOverrides.has(n.id) ? { ...n, ...liveOverrides.get(n.id) } : n));
  }, [state.nodes, liveOverrides]);

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
      const nextZoom = clamp(v.zoom * factor, CANVAS_ZOOM_MIN, CANVAS_ZOOM_MAX);
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
    if (!state.nodes.length) {
      setViewport({ x: 0, y: 0, zoom: 1 });
      return;
    }
    const xs = state.nodes.flatMap((n) => [n.x, n.x + n.width]);
    const ys = state.nodes.flatMap((n) => [n.y, n.y + n.height]);
    const minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys), maxY = Math.max(...ys);
    const rect = containerRef.current.getBoundingClientRect();
    const pad = 60;
    const zoom = clamp(
      Math.min((rect.width - pad * 2) / Math.max(1, maxX - minX), (rect.height - pad * 2) / Math.max(1, maxY - minY)),
      CANVAS_ZOOM_MIN,
      1.5
    );
    setViewport({ x: rect.width / 2 - ((minX + maxX) / 2) * zoom, y: rect.height / 2 - ((minY + maxY) / 2) * zoom, zoom });
  }, [state.nodes]);

  useEffect(() => {
    const raf = requestAnimationFrame(() => fitToContent());
    return () => cancelAnimationFrame(raf);
    // Only re-fit when a different canvas file is opened.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [file.id]);

  // Space bar toggles pan-drag mode (Obsidian convention): plain click-drag
  // on empty canvas draws a selection box; hold Space (or use a middle-
  // mouse / one-finger touch drag) to pan instead.
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

  // Wheel is attached natively (not passive) so preventDefault actually
  // stops the page from scrolling/zooming underneath the canvas.
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return undefined;
    const onWheel = (e) => {
      e.preventDefault();
      if (e.ctrlKey || e.metaKey) {
        zoomBy(Math.exp(-e.deltaY * 0.012), { x: e.clientX, y: e.clientY });
      } else {
        setViewport((v) => ({ ...v, x: v.x - e.deltaX, y: v.y - e.deltaY }));
      }
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [zoomBy]);

  const deleteSelection = useCallback(() => {
    if (selectedEdgeId) {
      commit((s) => ({ ...s, edges: s.edges.filter((e) => e.id !== selectedEdgeId) }));
      setSelectedEdgeId(null);
      return;
    }
    if (!selectedIds.size) return;
    commit((s) => ({
      ...s,
      nodes: s.nodes.filter((n) => !selectedIds.has(n.id)),
      edges: s.edges.filter((e) => !selectedIds.has(e.fromNode) && !selectedIds.has(e.toNode))
    }));
    setSelectedIds(new Set());
  }, [selectedIds, selectedEdgeId, commit]);

  const setSelectionColor = (color) => {
    if (!selectedIds.size) return;
    commit((s) => ({ ...s, nodes: s.nodes.map((n) => (selectedIds.has(n.id) ? { ...n, color } : n)) }));
  };

  const commitTextEdit = useCallback(
    (id, text) => {
      setEditingId(null);
      commit((s) => ({ ...s, nodes: s.nodes.map((n) => (n.id === id ? { ...n, text } : n)) }));
    },
    [commit]
  );

  const onBgPointerDown = useCallback(
    (e) => {
      containerRef.current.focus();
      containerRef.current.setPointerCapture(e.pointerId);
      pointersRef.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pointersRef.current.size >= 2) {
        const pts = Array.from(pointersRef.current.values());
        dragRef.current = {
          mode: 'pinch',
          startDist: Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y) || 1,
          startMid: { x: (pts[0].x + pts[1].x) / 2, y: (pts[0].y + pts[1].y) / 2 },
          startViewport: viewport
        };
        return;
      }
      // Plain click-and-drag on empty canvas pans by default — this used to
      // require the middle mouse button, which has no equivalent on a
      // trackpad. Middle-click and space+drag still work too (muscle
      // memory / mouse users), and two-finger trackpad scroll already pans
      // via the wheel handler below. Box-select now needs Shift held, the
      // same modifier already used to multi-select individual cards.
      const marqueeMode = e.button === 0 && e.shiftKey && !spaceDown;
      if (!marqueeMode) {
        setIsPanning(true);
        dragRef.current = { mode: 'pan', startClient: { x: e.clientX, y: e.clientY }, startViewport: viewport };
      } else {
        const world = screenToWorld(e.clientX, e.clientY);
        setSelectedIds(new Set());
        setSelectedEdgeId(null);
        dragRef.current = { mode: 'marquee', startWorld: world };
        setMarquee({ x0: world.x, y0: world.y, x1: world.x, y1: world.y });
      }
    },
    [viewport, spaceDown, screenToWorld]
  );

  const onBackgroundDoubleClick = useCallback(
    (e) => {
      const world = screenToWorld(e.clientX, e.clientY);
      const newNode = { id: uid('node'), type: 'text', x: world.x - 90, y: world.y - 30, width: 200, height: 80, text: '' };
      commit((s) => ({ ...s, nodes: [...s.nodes, newNode] }));
      setSelectedIds(new Set([newNode.id]));
      setEditingId(newNode.id);
    },
    [screenToWorld, commit]
  );

  const beginMove = useCallback(
    (e, node) => {
      if (editingId === node.id) return;
      e.stopPropagation();
      containerRef.current.focus();
      // Capture on the node's own element, not the container: capturing on
      // an ancestor makes the browser retarget the click/dblclick events
      // that follow this pointerdown to the capturing element instead of
      // the node underneath the cursor, so a double-click here was being
      // reported to canvas-surface as a background double-click (creating
      // a stray node) rather than to the node (entering text-edit mode).
      e.currentTarget.setPointerCapture(e.pointerId);
      let ids;
      if (e.shiftKey) {
        ids = new Set(selectedIds);
        ids.has(node.id) ? ids.delete(node.id) : ids.add(node.id);
        setSelectedIds(ids);
      } else if (selectedIds.has(node.id)) {
        ids = selectedIds;
      } else {
        ids = new Set([node.id]);
        setSelectedIds(ids);
      }
      setSelectedEdgeId(null);
      let dragIds = Array.from(ids);
      if (node.type === 'group') {
        const r = canvasNodeRect(node);
        const contained = state.nodes
          .filter((n) => n.id !== node.id && n.type !== 'group' && n.x >= r.left && n.y >= r.top && n.x + n.width <= r.right && n.y + n.height <= r.bottom)
          .map((n) => n.id);
        dragIds = Array.from(new Set([...dragIds, ...contained]));
      }
      const startPositions = new Map(state.nodes.filter((n) => dragIds.includes(n.id)).map((n) => [n.id, { x: n.x, y: n.y }]));
      dragRef.current = { mode: 'move', ids: dragIds, startPositions, startWorld: screenToWorld(e.clientX, e.clientY), moved: false };
    },
    [editingId, selectedIds, state.nodes, screenToWorld]
  );

  const beginResize = useCallback(
    (e, node) => {
      e.stopPropagation();
      e.currentTarget.setPointerCapture(e.pointerId);
      dragRef.current = { mode: 'resize', id: node.id, startW: node.width, startH: node.height, startWorld: screenToWorld(e.clientX, e.clientY), moved: false };
    },
    [screenToWorld]
  );

  const beginConnect = useCallback((e, node, side) => {
    e.stopPropagation();
    e.currentTarget.setPointerCapture(e.pointerId);
    const pt = canvasSideAnchor(node, side);
    dragRef.current = { mode: 'connect', fromNodeId: node.id, fromSide: side, startClient: { x: e.clientX, y: e.clientY } };
    setConnecting({ fromNodeId: node.id, fromSide: side, fromPt: pt, toPt: pt });
  }, []);

  const onNodeDoubleClick = useCallback(
    (e, node) => {
      e.stopPropagation();
      if (node.type === 'text') {
        setSelectedIds(new Set([node.id]));
        setEditingId(node.id);
      } else if (node.type === 'group') {
        const label = window.prompt('Group name:', node.label || '');
        if (label != null) commit((s) => ({ ...s, nodes: s.nodes.map((n) => (n.id === node.id ? { ...n, label } : n)) }));
      } else if (node.type === 'file') {
        const meta = allFilesById.get(node.file);
        if (meta) (opensInEditorPane(meta.kind) ? handlers.onOpenById(meta.id) : handlers.onOpenAsset(meta));
      } else if (node.type === 'link') {
        window.open(node.url, '_blank', 'noreferrer');
      }
    },
    [commit, allFilesById, handlers]
  );

  const onEdgeDoubleClick = useCallback(
    (edgeId) => {
      const edge = state.edges.find((e) => e.id === edgeId);
      const label = window.prompt('Edge label:', edge?.label || '');
      if (label != null) commit((s) => ({ ...s, edges: s.edges.map((e) => (e.id === edgeId ? { ...e, label } : e)) }));
    },
    [state.edges, commit]
  );

  const onContainerPointerMove = (e) => {
    if (pointersRef.current.has(e.pointerId)) pointersRef.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const drag = dragRef.current;
    if (!drag) return;
    if (drag.mode === 'pan') {
      const dx = e.clientX - drag.startClient.x;
      const dy = e.clientY - drag.startClient.y;
      setViewport({ ...drag.startViewport, x: drag.startViewport.x + dx, y: drag.startViewport.y + dy });
    } else if (drag.mode === 'pinch') {
      const pts = Array.from(pointersRef.current.values());
      if (pts.length < 2) return;
      const dist = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y) || 1;
      const mid = { x: (pts[0].x + pts[1].x) / 2, y: (pts[0].y + pts[1].y) / 2 };
      const nextZoom = clamp(drag.startViewport.zoom * (dist / drag.startDist), CANVAS_ZOOM_MIN, CANVAS_ZOOM_MAX);
      const rect = containerRef.current.getBoundingClientRect();
      const worldX = (drag.startMid.x - rect.left - drag.startViewport.x) / drag.startViewport.zoom;
      const worldY = (drag.startMid.y - rect.top - drag.startViewport.y) / drag.startViewport.zoom;
      setViewport({ x: mid.x - rect.left - worldX * nextZoom, y: mid.y - rect.top - worldY * nextZoom, zoom: nextZoom });
    } else if (drag.mode === 'marquee') {
      const world = screenToWorld(e.clientX, e.clientY);
      setMarquee({ x0: drag.startWorld.x, y0: drag.startWorld.y, x1: world.x, y1: world.y });
    } else if (drag.mode === 'move') {
      const world = screenToWorld(e.clientX, e.clientY);
      const dx = world.x - drag.startWorld.x;
      const dy = world.y - drag.startWorld.y;
      if (drag.moved || Math.abs(dx) > CANVAS_MOVE_THRESHOLD || Math.abs(dy) > CANVAS_MOVE_THRESHOLD) {
        drag.moved = true;
        const overrides = new Map();
        drag.ids.forEach((id) => {
          const base = drag.startPositions.get(id);
          if (base) overrides.set(id, { x: base.x + dx, y: base.y + dy });
        });
        scheduleLiveOverrides(overrides);
      }
    } else if (drag.mode === 'resize') {
      const world = screenToWorld(e.clientX, e.clientY);
      const w = Math.max(CANVAS_MIN_W, drag.startW + (world.x - drag.startWorld.x));
      const h = Math.max(CANVAS_MIN_H, drag.startH + (world.y - drag.startWorld.y));
      if (w !== drag.startW || h !== drag.startH) drag.moved = true;
      scheduleLiveOverrides(new Map([[drag.id, { width: w, height: h }]]));
    } else if (drag.mode === 'connect') {
      const world = screenToWorld(e.clientX, e.clientY);
      setConnecting((c) => c && { ...c, toPt: world });
      // Highlight whatever existing card the pointer is over so it's clear
      // a drop here will connect to it, instead of silently succeeding (or
      // silently missing and creating a new card) with no visual feedback.
      const target = canvasHitTest(state.nodes, world, drag.fromNodeId);
      setConnectTargetId(target ? target.id : null);
      // Also reveal the 4 dots on any card within a screen-constant radius
      // of the pointer (not just the one directly under it), so the user
      // can see and drag onto a precise connection point on a nearby card
      // instead of only ever landing a plain body-to-body edge.
      setNearbyConnectIds(canvasNodesNear(state.nodes, world, drag.fromNodeId, CANVAS_CONNECT_NEAR_PX / viewport.zoom));
    }
  };

  const onContainerPointerUp = (e) => {
    pointersRef.current.delete(e.pointerId);
    const drag = dragRef.current;
    dragRef.current = null;
    setIsPanning(false);
    if (!drag) return;
    if (drag.mode === 'marquee') {
      const m = marquee;
      setMarquee(null);
      if (m) {
        const box = { x0: Math.min(m.x0, m.x1), y0: Math.min(m.y0, m.y1), x1: Math.max(m.x0, m.x1), y1: Math.max(m.y0, m.y1) };
        const ids = state.nodes.filter((n) => n.x < box.x1 && n.x + n.width > box.x0 && n.y < box.y1 && n.y + n.height > box.y0).map((n) => n.id);
        if (ids.length) setSelectedIds(new Set(ids));
      }
    } else if (drag.mode === 'move' || drag.mode === 'resize') {
      if (drag.moved && pendingOverridesRef.current) {
        const overrides = pendingOverridesRef.current;
        // Snap on commit only (not on every live-preview frame), so the
        // card still glides smoothly under the pointer while dragging and
        // only jumps to the grid once at drop — same feel as Obsidian's
        // canvas snap.
        commit((s) => ({
          ...s,
          nodes: s.nodes.map((n) => {
            if (!overrides.has(n.id)) return n;
            const patch = overrides.get(n.id);
            const snapped = { ...patch };
            if ('x' in snapped) snapped.x = canvasSnap(snapped.x, snapEnabled);
            if ('y' in snapped) snapped.y = canvasSnap(snapped.y, snapEnabled);
            if ('width' in snapped) snapped.width = canvasSnap(snapped.width, snapEnabled);
            if ('height' in snapped) snapped.height = canvasSnap(snapped.height, snapEnabled);
            return { ...n, ...snapped };
          })
        }));
      }
      setLiveOverrides(null);
      pendingOverridesRef.current = null;
    } else if (drag.mode === 'connect') {
      const world = screenToWorld(e.clientX, e.clientY);
      const dist = Math.hypot(e.clientX - (drag.startClient?.x ?? e.clientX), e.clientY - (drag.startClient?.y ?? e.clientY));
      const target = canvasHitTest(state.nodes, world, drag.fromNodeId);
      if (target) {
        const toSide = canvasNearestSide(target, world);
        commit((s) => ({ ...s, edges: [...s.edges, { id: uid('edge'), fromNode: drag.fromNodeId, fromSide: drag.fromSide, toNode: target.id, toSide }] }));
      } else if (dist > 12) {
        const newNode = { id: uid('node'), type: 'text', x: world.x - 90, y: world.y - 30, width: 180, height: 60, text: '' };
        const toSide = canvasOppositeSide(drag.fromSide);
        commit((s) => ({
          ...s,
          nodes: [...s.nodes, newNode],
          edges: [...s.edges, { id: uid('edge'), fromNode: drag.fromNodeId, fromSide: drag.fromSide, toNode: newNode.id, toSide }]
        }));
        setSelectedIds(new Set([newNode.id]));
        setEditingId(newNode.id);
      }
      setConnecting(null);
      setConnectTargetId(null);
      setNearbyConnectIds(null);
    }
  };

  const onKeyDown = (e) => {
    if (editingId) return;
    if (e.key === 'Delete' || e.key === 'Backspace') {
      e.preventDefault();
      deleteSelection();
    } else if (e.key === 'Escape') {
      setSelectedIds(new Set());
      setSelectedEdgeId(null);
      setConnecting(null);
      setConnectTargetId(null);
      setNearbyConnectIds(null);
    } else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'a') {
      e.preventDefault();
      setSelectedIds(new Set(state.nodes.map((n) => n.id)));
    } else if ((e.metaKey || e.ctrlKey) && (e.key === '=' || e.key === '+')) {
      e.preventDefault();
      zoomBy(1.2);
    } else if ((e.metaKey || e.ctrlKey) && e.key === '-') {
      e.preventDefault();
      zoomBy(1 / 1.2);
    } else if ((e.metaKey || e.ctrlKey) && e.key === '0') {
      e.preventDefault();
      setViewport((v) => ({ ...v, zoom: 1 }));
    }
  };

  const centerWorld = useCallback(() => {
    const rect = containerRef.current.getBoundingClientRect();
    return screenToWorld(rect.left + rect.width / 2, rect.top + rect.height / 2);
  }, [screenToWorld]);

  const addTextNodeAtCenter = () => {
    const world = centerWorld();
    const newNode = { id: uid('node'), type: 'text', x: world.x - 100, y: world.y - 40, width: 200, height: 90, text: '' };
    commit((s) => ({ ...s, nodes: [...s.nodes, newNode] }));
    setSelectedIds(new Set([newNode.id]));
    setEditingId(newNode.id);
  };
  const addLinkNodeAtCenter = () => {
    const url = window.prompt('URL to embed:');
    if (!url || !url.trim()) return;
    const world = centerWorld();
    const newNode = { id: uid('node'), type: 'link', x: world.x - 110, y: world.y - 30, width: 240, height: 56, url: url.trim() };
    commit((s) => ({ ...s, nodes: [...s.nodes, newNode] }));
    setSelectedIds(new Set([newNode.id]));
  };
  const addGroupAtCenter = () => {
    const world = centerWorld();
    const newNode = { id: uid('node'), type: 'group', x: world.x - 160, y: world.y - 110, width: 320, height: 220, label: 'Group' };
    commit((s) => ({ ...s, nodes: [newNode, ...s.nodes] }));
    setSelectedIds(new Set([newNode.id]));
  };
  const addFileNodeFromPicker = (fileMeta) => {
    setFilePickerOpen(false);
    const world = centerWorld();
    const isMedia = fileMeta.kind === 'image' || fileMeta.kind === 'video' || fileMeta.kind === 'audio';
    const newNode = {
      id: uid('node'),
      type: 'file',
      x: world.x - 150,
      y: world.y - 100,
      width: 300,
      height: isMedia ? 220 : 260,
      file: fileMeta.id
    };
    commit((s) => ({ ...s, nodes: [...s.nodes, newNode] }));
    setSelectedIds(new Set([newNode.id]));
  };

  if (loading) {
    return (
      <div className="db-loading">
        <IconLoader size={18} /> Loading canvas…
      </div>
    );
  }

  const selectionBounds =
    selectedIds.size > 0
      ? (() => {
          const nodes = nodesForRender.filter((n) => selectedIds.has(n.id));
          if (!nodes.length) return null;
          const minX = Math.min(...nodes.map((n) => n.x));
          const minY = Math.min(...nodes.map((n) => n.y));
          return { x: minX * viewport.zoom + viewport.x, y: minY * viewport.zoom + viewport.y };
        })()
      : null;

  return (
    <div className="canvas-view">
      <CanvasToolbar
        zoom={viewport.zoom}
        onZoomIn={() => zoomBy(1.2)}
        onZoomOut={() => zoomBy(1 / 1.2)}
        onZoomReset={() => setViewport((v) => ({ ...v, zoom: 1 }))}
        onFitToContent={fitToContent}
        onAddText={addTextNodeAtCenter}
        onAddFile={() => setFilePickerOpen(true)}
        onAddLink={addLinkNodeAtCenter}
        onAddGroup={addGroupAtCenter}
        snapEnabled={snapEnabled}
        onToggleSnap={() => setSnapEnabled((v) => !v)}
      />
      <div
        className={`canvas-surface ${isPanning || spaceDown ? 'panning' : ''}`}
        ref={containerRef}
        tabIndex={0}
        style={{ backgroundPosition: `${viewport.x}px ${viewport.y}px`, backgroundSize: `${22 * viewport.zoom}px ${22 * viewport.zoom}px` }}
        onPointerDown={(e) => {
          if (e.target === containerRef.current || e.target.classList.contains('canvas-world')) onBgPointerDown(e);
        }}
        onPointerMove={onContainerPointerMove}
        onPointerUp={onContainerPointerUp}
        onPointerCancel={onContainerPointerUp}
        onDoubleClick={(e) => {
          if (e.target === containerRef.current || e.target.classList.contains('canvas-world')) onBackgroundDoubleClick(e);
        }}
        onKeyDown={onKeyDown}
      >
        <div className="canvas-world" style={{ transform: `translate(${viewport.x}px, ${viewport.y}px) scale(${viewport.zoom})` }}>
          <CanvasEdgesLayer
            nodes={nodesForRender}
            edges={state.edges}
            selectedEdgeId={selectedEdgeId}
            connecting={connecting}
            onSelectEdge={setSelectedEdgeId}
            onDoubleClickEdge={onEdgeDoubleClick}
          />
          {nodesForRender.map((node) => (
            <CanvasNode
              key={node.id}
              node={node}
              selected={selectedIds.has(node.id)}
              hovered={hoveredId === node.id}
              editing={editingId === node.id}
              connectTarget={connectTargetId === node.id}
              connectHighlight={!!connecting && nearbyConnectIds?.has(node.id)}
              allFilesById={allFilesById}
              handlers={handlers}
              linkIndex={linkIndex}
              onPointerDownBody={beginMove}
              onPointerDownResize={beginResize}
              onPointerDownDot={beginConnect}
              onDoubleClick={onNodeDoubleClick}
              onHoverChange={setHoveredId}
              onCommitEdit={commitTextEdit}
            />
          ))}
          {marquee && (
            <div
              className="canvas-marquee"
              style={{
                left: Math.min(marquee.x0, marquee.x1),
                top: Math.min(marquee.y0, marquee.y1),
                width: Math.abs(marquee.x1 - marquee.x0),
                height: Math.abs(marquee.y1 - marquee.y0)
              }}
            />
          )}
        </div>
        {selectionBounds && (
          <div className="canvas-selection-toolbar" style={{ left: Math.max(4, selectionBounds.x), top: Math.max(4, selectionBounds.y - 40) }}>
            {CANVAS_COLORS.map((c) => (
              <button key={c} className="canvas-color-swatch" style={{ background: c }} onClick={() => setSelectionColor(c)} title="Set color" />
            ))}
            <button className="canvas-color-swatch canvas-color-none" onClick={() => setSelectionColor(null)} title="Clear color">
              ×
            </button>
            <button className="icon-btn" onClick={deleteSelection} title="Delete">
              <IconTrash size={14} />
            </button>
          </div>
        )}
      </div>
      {filePickerOpen && <CanvasFilePickerModal files={allFiles || []} onPick={addFileNodeFromPicker} onClose={() => setFilePickerOpen(false)} />}
    </div>
  );
}

export { CanvasView };
