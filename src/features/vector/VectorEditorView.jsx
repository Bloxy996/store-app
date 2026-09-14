import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { IconEye, IconLoader, IconPlus, IconTrash, IconType, IconX } from '../../components/icons.jsx';
import { MiniMarkdownEditor } from '../../components/MiniMarkdownEditor.jsx';
import { PropertiesPanel } from '../../components/PropertiesPanel.jsx';
import { useDriveImageUrl } from '../../hooks/useDriveImageUrl.js';
import { parseFrontmatter } from '../../lib/markdownParse.js';
import { CanvasFilePickerModal } from '../canvas/CanvasFilePickerModal.jsx';
import { VectorToolbar } from './VectorToolbar.jsx';
import {
  DEFAULT_CIRCLE_FILL,
  DEFAULT_CIRCLE_RADIUS,
  DEFAULT_STYLE,
  DEFAULT_TEXT_ALIGN,
  DEFAULT_TEXT_COLOR,
  DEFAULT_TEXT_FONT_SIZE,
  DEFAULT_TEXT_HEIGHT,
  DEFAULT_TEXT_VALIGN,
  DEFAULT_TEXT_WIDTH,
  EDGE_SNAP_PX,
  REFERENCE_IMAGE_OPACITY,
  SEVER_THRESHOLD_PX,
  VECTOR_ZOOM_MAX,
  VECTOR_ZOOM_MIN,
  VERTEX_SNAP_PX,
  addCircle,
  addEdge,
  addFillAt,
  addLayer,
  addReferenceImage,
  addSnapAxis,
  addText,
  bindVertexOntoEdge,
  compileVectorSvg,
  contrastDotColor,
  copySelection,
  deleteCircles,
  deleteEdges,
  deleteFills,
  deleteReferenceImage,
  deleteSnapAxes,
  deleteTexts,
  deleteVertices,
  disconnectVertex,
  groupIdForVertex,
  groupVertexIds,
  groupVertices,
  mergeCoincidentVertices,
  moveCircles,
  moveReferenceImage,
  moveSnapAxis,
  moveVertices,
  moveToLayer,
  parseVectorContent,
  pasteClipboard,
  removeLayer,
  renameLayer,
  reorderLayer,
  resizeCircle,
  resizeReferenceImage,
  resolveTextQuad,
  selectionIsExactlyOneGroup,
  serializeVectorState,
  setCanvasBackground,
  setCircleStyle,
  setDescription,
  setEdgeStyle,
  setFillColor,
  setLayerVisible,
  setSnapAxisEndpoint,
  setTextContent,
  setTextStyle,
  severEdgeEndpoint,
  splitVertex,
  subdivideEdge,
  ungroupVertices,
  loopsToPathData
} from './vectorState.js';
import { SpatialGrid, buildVertexAdjacency, closestPointOnSegment, computeMiterJoints, computeQuadWarpMatrix3d, dist, findFillBoundary, perpendicularParallelLines, resolveBoundaryPolygon, snapCandidate } from './vectorTopology.js';
import { clamp } from '../../lib/mathUtils.js';
import {
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
} from './vectorGeometry.jsx';

// A faded, non-interactive-until-selected tracing guide (see the toolbar's
// vault-image button). Its own component, not inlined into the render
// loop below, purely so useDriveImageUrl (a hook) can be called once per
// image rather than inside a .map — the same reason ImageEmbed in
// LinkEmbeds.jsx exists as its own component.
function ReferenceImageNode({ image, token, selected, onPointerDownImage, onPointerDownResize }) {
  const { url, loading: imgLoading } = useDriveImageUrl(token, image.fileId);
  return (
    <g className={`vector-reference-image ${selected ? 'selected' : ''}`}>
      {url ? (
        <image
          href={url}
          x={image.x}
          y={image.y}
          width={image.width}
          height={image.height}
          opacity={REFERENCE_IMAGE_OPACITY}
          preserveAspectRatio="none"
          onPointerDown={onPointerDownImage}
        />
      ) : (
        <rect
          x={image.x}
          y={image.y}
          width={image.width}
          height={image.height}
          fill="none"
          stroke="var(--vector-dot-color, #888)"
          strokeDasharray="6 6"
          opacity={REFERENCE_IMAGE_OPACITY}
          onPointerDown={onPointerDownImage}
        />
      )}
      {imgLoading && (
        <text x={image.x + image.width / 2} y={image.y + image.height / 2} textAnchor="middle" fill="var(--vector-dot-color, #888)" fontSize="12">
          Loading…
        </text>
      )}
      {selected && (
        <>
          <rect className="vector-reference-image-outline" x={image.x} y={image.y} width={image.width} height={image.height} fill="none" />
          <circle
            className="vector-reference-image-handle"
            cx={image.x + image.width}
            cy={image.y + image.height}
            r={7}
            onPointerDown={onPointerDownResize}
          />
        </>
      )}
    </g>
  );
}

function VectorEditorView({ file, content, onChange, loading, handlers, linkIndex, allFiles }) {
  const [doc, setDoc] = useState(() => parseVectorContent(content));
  const [viewport, setViewport] = useState({ x: 0, y: 0, zoom: 1 });
  const [tool, setTool] = useState('select');
  const [activeStyle, setActiveStyle] = useState(DEFAULT_STYLE);
  const [axisSnapEnabled, setAxisSnapEnabled] = useState(true);
  // Snap-type toggles — see the toolbar's snap-settings popover. Vertex
  // and edge(-subdivide) snap default on since they're the two most
  // fundamental kinds; the rest mirror axisSnapEnabled's default.
  const [vertexSnapEnabled, setVertexSnapEnabled] = useState(true);
  const [edgeSnapEnabled, setEdgeSnapEnabled] = useState(true);
  const [customAxisSnapEnabled, setCustomAxisSnapEnabled] = useState(true);
  const [perpParallelSnapEnabled, setPerpParallelSnapEnabled] = useState(true);
  const [snapMenuOpen, setSnapMenuOpen] = useState(false);
  const [selectedAxisIds, setSelectedAxisIds] = useState(() => new Set());
  const [axisDraft, setAxisDraft] = useState(null); // { x1, y1, x2, y2 } — preview while drawing a new snap axis
  // Live delta readout while moving/scaling/rotating a MULTI-selection via
  // the move/scale/rotate handles (see the measurement-overlay render
  // block) — { x, y, lines }, cleared the instant the drag ends.
  const [transformReadout, setTransformReadout] = useState(null);
  const [selectedVertexIds, setSelectedVertexIds] = useState(() => new Set());
  const [selectedEdgeIds, setSelectedEdgeIds] = useState(() => new Set());
  const [selectedCircleIds, setSelectedCircleIds] = useState(() => new Set());
  const [selectedFillIds, setSelectedFillIds] = useState(() => new Set());
  const [localEditGroupId, setLocalEditGroupId] = useState(null);
  const [edgeChainFirst, setEdgeChainFirst] = useState(null);
  const [polylineChain, setPolylineChain] = useState([]);
  const [liveOverrides, setLiveOverrides] = useState(null);
  // Circle equivalent of liveOverrides — separate state since a circle's
  // override shape (cx/cy/r) differs from a vertex's (x/y), populated only
  // during a move/scale/rotate drag that includes selected circles (see
  // the Transform section) — a lone circle being dragged/resized by
  // itself still uses circleDraft instead, unrelated to this.
  const [circleTransformOverrides, setCircleTransformOverrides] = useState(null);
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
  const [activeTextStyle, setActiveTextStyle] = useState({ color: DEFAULT_TEXT_COLOR, fontSize: DEFAULT_TEXT_FONT_SIZE, align: DEFAULT_TEXT_ALIGN, valign: DEFAULT_TEXT_VALIGN });
  const [textDraft, setTextDraft] = useState(null); // { x0, y0, x1, y1 } — rectangle preview while drawing a new text box
  // The id of the text currently being typed into, plus a local editing
  // buffer separate from doc.texts — content only commits on blur/Escape
  // (see the plain-<textarea> overlay below), same "don't push a save per
  // keystroke" convention as MiniMarkdownEditor.
  const [editingTextId, setEditingTextId] = useState(null);
  const [editingTextBuffer, setEditingTextBuffer] = useState('');
  // Corner-handle scaling keeps the selection's aspect ratio locked while
  // this is on (see computeTransform's scale branch) — off by default so
  // existing documents keep behaving exactly as before until switched on.
  const [proportionalScaling, setProportionalScaling] = useState(false);
  // Whether two points landing on the exact same spot after a drag get
  // folded into one automatically (see mergeCoincidentVertices) — on by
  // default per the toolbar's "Merge overlapping points" setting.
  const [mergeCoincidentEnabled, setMergeCoincidentEnabled] = useState(true);
  const [imagePickerOpen, setImagePickerOpen] = useState(false);
  const [selectedImageId, setSelectedImageId] = useState(null);
  // Live preview while dragging/resizing a reference image — same
  // "draft state, commit on pointer-up" convention as circleDraft.
  const [imageDraft, setImageDraft] = useState(null); // { id, x, y, width, height }

  const containerRef = useRef(null);
  const dragRef = useRef(null);
  // Copy/paste clipboard — deliberately a plain ref, not doc/React state:
  // it's per-editor-instance scratch data, not part of the document and
  // not undo-able itself (pasting IS undo-able, as an ordinary commit).
  // pasteOffsetCountRef increments with each successive paste of the SAME
  // copy so repeated Ctrl/Cmd+V steps the copies apart instead of stacking
  // them exactly on top of each other; a fresh copy resets it.
  const clipboardRef = useRef(null);
  const pasteOffsetCountRef = useRef(0);
  const rafRef = useRef(null);
  const pendingOverridesRef = useRef(null);
  const pendingCircleOverridesRef = useRef(null);
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

  // A vertex whose every edge/text lives on a hidden layer is itself part
  // of that hidden layer, so its dot shouldn't draw either — a vertex with
  // no edges/texts at all, or with at least one on a still-visible layer,
  // stays visible. Feeds the vertex-dot render loop below.
  const hiddenVertexIds = useMemo(() => {
    const hiddenLayerIds = new Set(doc.layers.filter((l) => l.visible === false).map((l) => l.id));
    if (!hiddenLayerIds.size) return new Set();
    const owningLayers = new Map(); // vertexId -> Set(layerId)
    const addOwner = (vertexId, layerId) => {
      if (!owningLayers.has(vertexId)) owningLayers.set(vertexId, new Set());
      owningLayers.get(vertexId).add(layerId);
    };
    for (const e of doc.edges) {
      addOwner(e.v1, e.layerId);
      addOwner(e.v2, e.layerId);
    }
    for (const t of doc.texts) {
      addOwner(t.v1, t.layerId);
      addOwner(t.v2, t.layerId);
      addOwner(t.v3, t.layerId);
      addOwner(t.v4, t.layerId);
    }
    const hidden = new Set();
    for (const [vertexId, layerIds] of owningLayers) {
      if (Array.from(layerIds).every((id) => hiddenLayerIds.has(id))) hidden.add(vertexId);
    }
    return hidden;
  }, [doc.layers, doc.edges, doc.texts]);

  // Vault files eligible for the reference-image picker.
  const imageFiles = useMemo(() => (allFiles || []).filter((f) => f.kind === 'image'), [allFiles]);

  const handlePickImage = useCallback(
    (f) => {
      const width = Math.round(doc.canvas.width * 0.5);
      const height = Math.round(doc.canvas.height * 0.5);
      const x = Math.round((doc.canvas.width - width) / 2);
      const y = Math.round((doc.canvas.height - height) / 2);
      const next = addReferenceImage(doc, f.id, f.name, x, y, width, height);
      commitState(next);
      setSelectedImageId(next._newReferenceImageId);
      setImagePickerOpen(false);
    },
    [doc, commitState]
  );

  const deleteSelectedImage = useCallback(() => {
    if (!selectedImageId) return;
    commitState(deleteReferenceImage(doc, selectedImageId));
    setSelectedImageId(null);
  }, [doc, commitState, selectedImageId]);

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

  // Circles are independent primitives (not part of the vertex/edge graph).
  // Two separate override sources can apply: circleTransformOverrides (a
  // batched map, populated when circles are moved/scaled/rotated together
  // with a mixed selection — see the Transform section) and circleDraft (a
  // single circle being individually dragged/resized/drawn, unrelated to
  // any selection).
  const circlesForRender = useMemo(() => {
    let circles = doc.circles;
    if (circleTransformOverrides && circleTransformOverrides.size) {
      circles = circles.map((c) => (circleTransformOverrides.has(c.id) ? { ...c, ...circleTransformOverrides.get(c.id) } : c));
    }
    if (circleDraft && circleDraft.id) {
      circles = circles.map((c) => (c.id === circleDraft.id ? { ...c, ...circleDraft } : c));
    }
    return circles;
  }, [doc.circles, circleDraft, circleTransformOverrides]);

  const axesForRender = useMemo(() => {
    if (!axisDraft || !axisDraft.id) return doc.snapAxes;
    return doc.snapAxes.map((a) => (a.id === axisDraft.id ? { ...a, ...axisDraft } : a));
  }, [doc.snapAxes, axisDraft]);

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

  // User-drawn snap axes as candidate lines, shared by every snap call
  // site below (vertex/edge/polyline placement, single-vertex move, and
  // circle placement/move) — previously only single-vertex drags folded
  // these into their candidateLines, so a custom axis snapped a point
  // already being dragged but not one being newly placed with the
  // vertex/edge/polyline tools, or a circle's center. Null (not just
  // empty) when the toggle is off, matching snapOpts/snapCandidate's
  // "no lines to consider" convention.
  const customAxisLines = useMemo(
    () => (customAxisSnapEnabled && doc.snapAxes.length ? doc.snapAxes.map((a) => ({ p1: { x: a.x1, y: a.y1 }, p2: { x: a.x2, y: a.y2 } })) : null),
    [customAxisSnapEnabled, doc.snapAxes]
  );

  // Snaps a bare point (a circle's center) using the SAME priority a
  // vertex drag gets — existing vertex, then a point on an existing edge,
  // then a custom axis/alignment line — even though a circle isn't part
  // of the vertex/edge graph itself (so, unlike a vertex landing on an
  // edge, this never subdivides anything; it's a position snap only).
  // Returns the full snap result (not just the point) so callers can also
  // feed it to setSnapPreview and get the same guide-line/marker feedback
  // a vertex drag shows.
  const snapCirclePoint = useCallback(
    (point) => snapCandidate(verticesForSnap, edgesForSnap, point, snapOpts(viewport.zoom, grid, { vertexSnapEnabled, edgeSnapEnabled, axisSnapEnabled }, { lines: customAxisLines })),
    [verticesForSnap, edgesForSnap, viewport.zoom, grid, vertexSnapEnabled, edgeSnapEnabled, axisSnapEnabled, customAxisLines]
  );

  const scheduleLiveOverrides = useCallback((map, circleMap) => {
    pendingOverridesRef.current = map;
    pendingCircleOverridesRef.current = circleMap || null;
    if (rafRef.current) return;
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = null;
      setLiveOverrides(pendingOverridesRef.current);
      setCircleTransformOverrides(pendingCircleOverridesRef.current);
    });
  }, []);
  useEffect(() => () => rafRef.current && cancelAnimationFrame(rafRef.current), []);

  // Folds whatever's currently in liveOverrides/circleTransformOverrides
  // into ONE commit — used at the end of a move/scale/rotate drag that may
  // have touched vertices, circles, or (via the shared bounding box — see
  // the Transform section) both together, so the whole gesture becomes a
  // single undo step rather than two.
  const commitCombinedOverrides = () => {
    let next = doc;
    if (liveOverrides && liveOverrides.size) {
      next = moveVertices(next, liveOverrides);
      if (mergeCoincidentEnabled) next = mergeCoincidentVertices(next, Array.from(liveOverrides.keys()));
    }
    if (circleTransformOverrides && circleTransformOverrides.size) {
      next = { ...next, circles: next.circles.map((c) => (circleTransformOverrides.has(c.id) ? { ...c, ...circleTransformOverrides.get(c.id) } : c)) };
    }
    if (next !== doc) commitState(next);
  };

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
    if (selectedAxisIds.size) {
      commitState(deleteSnapAxes(doc, selectedAxisIds));
      setSelectedAxisIds(new Set());
      return;
    }
    if (selectedFillIds.size) {
      commitState(deleteFills(doc, selectedFillIds));
      setSelectedFillIds(new Set());
      return;
    }
    // Vertices/edges/circles can now be selected together (shift-click
    // across types — see the Transform section), so all three delete in
    // ONE combined commit rather than only the first non-empty type.
    // deleteEdges/deleteCircles first, then deleteVertices last: deleting
    // vertices already cascades into removing any edge/text that
    // depended on them, so doing it last avoids deleteEdges redundantly
    // trying to remove an edge that's already gone.
    if (selectedEdgeIds.size || selectedCircleIds.size || selectedVertexIds.size) {
      let next = doc;
      if (selectedEdgeIds.size) next = deleteEdges(next, selectedEdgeIds);
      if (selectedCircleIds.size) next = deleteCircles(next, selectedCircleIds);
      if (selectedVertexIds.size) next = deleteVertices(next, selectedVertexIds);
      commitState(next);
      setSelectedEdgeIds(new Set());
      setSelectedCircleIds(new Set());
      setSelectedVertexIds(new Set());
    }
  }, [doc, selectedVertexIds, selectedEdgeIds, selectedCircleIds, selectedFillIds, selectedAxisIds, commitState]);

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
      // A plain (non-shift) click replaces the WHOLE selection, same as
      // ever — but shift-click is additive ACROSS types now (see the
      // Transform section): shift-clicking a vertex while edges/circles
      // are already selected keeps them, building a mixed selection that
      // shares one bounding box and one set of move/scale/rotate handles.
      setSelectedEdgeIds(new Set());
      setSelectedCircleIds(new Set());
    }
    setSelectedFillIds(new Set());
    setSelectedAxisIds(new Set());

    // A plain click/drag that landed on a vertex ALREADY part of a bigger
    // selection (more than just this one point) acts on this point alone
    // rather than dragging the whole group — the group has its own
    // dedicated move handle for that (onMoveHandlePointerDown, the
    // stem+circle below the selection box), so clicking into the middle
    // of a multi-selection to nudge one point no longer drags everything.
    // Selection itself is left as-is (still the full group, still
    // visually selected) — only what THIS drag moves is narrowed.
    const isGroupClick = !e.shiftKey && selectedVertexIds.has(vertexId) && (nextSelection.size > 1 || selectedCircleIds.size > 0);
    const ids = isGroupClick ? new Set([vertexId]) : nextSelection.size ? nextSelection : new Set([vertexId]);
    // Circles only ever carry into this drag when they were part of an
    // EXISTING selection preserved by this click (shift-click, or a plain
    // click that landed on an already-selected vertex — see above); a
    // plain click that replaced the selection already cleared them, and a
    // group click that's been narrowed to just this vertex excludes them too.
    const circleIds = isGroupClick ? new Set() : selectedCircleIds;
    const circleStartPositions = new Map(
      Array.from(circleIds)
        .map((id) => circlesForRender.find((c) => c.id === id))
        .filter(Boolean)
        .map((c) => [c.id, { cx: c.cx, cy: c.cy, r: c.r }])
    );
    const startPositions = new Map(Array.from(ids).map((id) => [id, vertexById.get(id)]));
    const singleId = ids.size === 1 && circleIds.size === 0 ? vertexId : null;
    // "Straighten"/"preserve direction" snap axes — computed once, right
    // now, from the vertex's PRE-MOVE topology, so they stay fixed
    // reference lines for the whole drag rather than sliding around as
    // the vertex itself moves. For A-V-C: the line through A and C
    // (straightens a bend back out), plus — for every incident edge — the
    // line through its far endpoint extended in that edge's original
    // direction (keeps a single dangling edge moving along the way it
    // already pointed). See vectorTopology.js's snapCandidate `lines`.
    let candidateLines = null;
    if (singleId) {
      const v0 = vertexById.get(singleId);
      const incidentEdges = doc.edges.filter((e) => e.v1 === singleId || e.v2 === singleId);
      const others = incidentEdges.map((e) => vertexById.get(e.v1 === singleId ? e.v2 : e.v1)).filter(Boolean);
      candidateLines = [];
      if (v0 && others.length) {
        candidateLines.push(...others.map((p) => ({ p1: p, p2: v0 })));
        if (others.length === 2) candidateLines.push({ p1: others[0], p2: others[1] });
      }
      // Custom user-drawn snap axes are always-available candidate lines,
      // independent of this vertex's own topology — see the Snap axes
      // section of vectorState.js.
      if (customAxisLines) candidateLines.push(...customAxisLines);
      // Perpendicular/parallel snap: only meaningful for a degree-1 vertex
      // (a single dangling edge V-P) — anchor the candidate lines at the
      // FIXED far endpoint P, matching every OTHER edge in the document
      // (excluding this one, which would trivially match itself).
      if (perpParallelSnapEnabled && v0 && others.length === 1) {
        const referenceEdges = doc.edges
          .filter((e) => !incidentEdges.includes(e))
          .map((e) => ({ p1: vertexById.get(e.v1), p2: vertexById.get(e.v2) }))
          .filter((e) => e.p1 && e.p2);
        candidateLines.push(...perpendicularParallelLines(others[0], referenceEdges));
      }
      if (!candidateLines.length) candidateLines = null;
    }
    dragRef.current = { mode: 'move', ids, circleIds, startPositions, circleStartPositions, startWorld: world, moved: false, singleId, candidateLines };
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
      const alreadySelected = selectedEdgeIds.has(edgeId);
      setSelectedEdgeIds((prev) => {
        const next = e.shiftKey ? new Set(prev) : new Set();
        next.has(edgeId) ? next.delete(edgeId) : next.add(edgeId);
        return next;
      });
      // Shift-click (or a plain click on an edge that's already part of
      // the selection) is additive ACROSS types — see the Transform
      // section — so it preserves any vertices/circles already selected
      // instead of clearing them.
      if (!e.shiftKey && !alreadySelected) {
        setSelectedVertexIds(new Set());
        setSelectedCircleIds(new Set());
      }
      setSelectedFillIds(new Set());
      setSelectedAxisIds(new Set());
    }
  };

  const onFillPointerDown = (e, fill) => {
    e.stopPropagation();
    if (viewMode) return;
    if (tool === 'eyedropper') {
      setActiveStyle((s) => ({ ...s, color: fill.color })); // fills have no thickness — eyedropper on a fill only carries color
      return;
    }
    if (tool !== 'select') return;
    setSelectedFillIds((prev) => {
      if (!e.shiftKey) return new Set([fill.id]);
      const next = new Set(prev);
      next.has(fill.id) ? next.delete(fill.id) : next.add(fill.id);
      return next;
    });
    setSelectedVertexIds(new Set());
    setSelectedEdgeIds(new Set());
    setSelectedCircleIds(new Set());
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
    const alreadySelected = selectedCircleIds.has(circleId);
    setSelectedCircleIds((prev) => {
      if (!e.shiftKey) return new Set([circleId]);
      const next = new Set(prev);
      next.has(circleId) ? next.delete(circleId) : next.add(circleId);
      return next;
    });
    // Shift-click (or a plain click on a circle that's already part of the
    // selection) is additive ACROSS types — see the Transform section —
    // so it preserves any vertices/edges already selected instead of
    // clearing them.
    if (!e.shiftKey && !alreadySelected) {
      setSelectedVertexIds(new Set());
      setSelectedEdgeIds(new Set());
    }
    setSelectedFillIds(new Set());
    setSelectedAxisIds(new Set());
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

  // Reference images (see the toolbar's vault-image button) are a much
  // simpler interactive object than everything else in this file — just a
  // position and a size, no topology, no style — so they get their own
  // small move/resize pair here rather than routing through the
  // vertex/circle selection machinery above.
  const onReferenceImagePointerDown = (e, image) => {
    e.stopPropagation();
    if (spaceDown) {
      beginPan(e);
      return;
    }
    if (viewMode || tool !== 'select') return;
    containerRef.current.focus();
    containerRef.current.setPointerCapture(e.pointerId);
    const world = screenToWorld(e.clientX, e.clientY);
    setSelectedImageId(image.id);
    setSelectedVertexIds(new Set());
    setSelectedEdgeIds(new Set());
    setSelectedFillIds(new Set());
    setSelectedCircleIds(new Set());
    setSelectedAxisIds(new Set());
    dragRef.current = { mode: 'move-image', imageId: image.id, startWorld: world, startX: image.x, startY: image.y };
  };

  const onReferenceImageResizePointerDown = (e, image) => {
    e.stopPropagation();
    if (viewMode) return;
    containerRef.current.setPointerCapture(e.pointerId);
    setSelectedImageId(image.id);
    dragRef.current = { mode: 'resize-image', imageId: image.id, x: image.x, y: image.y };
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
      setActiveTextStyle({ color: text.color, fontSize: text.fontSize, align: text.align, valign: text.valign });
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
    setSelectedFillIds(new Set());
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

  // Snap axes are an editing aid (see vectorState.js), so — like most
  // other pointer handlers here — they're inert outside the select tool
  // and in View mode. Clicking the axis LINE itself selects/moves it as a
  // whole; its two endpoint handles (rendered only when selected) resize
  // it — see beginAxisEndpointDrag.
  const onAxisPointerDown = (e, axis) => {
    e.stopPropagation();
    if (spaceDown) {
      beginPan(e);
      return;
    }
    if (viewMode || tool !== 'select') return;
    containerRef.current.setPointerCapture(e.pointerId);
    const world = screenToWorld(e.clientX, e.clientY);
    setSelectedAxisIds((prev) => {
      if (!e.shiftKey) return new Set([axis.id]);
      const next = new Set(prev);
      next.has(axis.id) ? next.delete(axis.id) : next.add(axis.id);
      return next;
    });
    setSelectedVertexIds(new Set());
    setSelectedEdgeIds(new Set());
    setSelectedCircleIds(new Set());
    setSelectedFillIds(new Set());
    dragRef.current = { mode: 'move-axis', axisId: axis.id, startWorld: world, x1: axis.x1, y1: axis.y1, x2: axis.x2, y2: axis.y2 };
  };

  const beginAxisEndpointDrag = (e, axisId, which) => {
    e.stopPropagation();
    if (viewMode) return;
    containerRef.current.setPointerCapture(e.pointerId);
    // Both endpoints' CURRENT coordinates have to be captured up front —
    // pointer-move's 'resize-axis' branch reads drag.x1/y1/x2/y2 to know
    // where the FIXED (non-dragged) endpoint sits. Without this, that
    // endpoint was undefined mid-drag, so the axis line/other point
    // vanished (NaN coordinates) until the drag ended and the real doc
    // value took over again.
    const axis = doc.snapAxes.find((a) => a.id === axisId);
    if (!axis) return;
    dragRef.current = { mode: 'resize-axis', axisId, which, x1: axis.x1, y1: axis.y1, x2: axis.x2, y2: axis.y2 };
  };

  // The selection bounding-box's dedicated MOVE handle (a stem+circle
  // below the box, mirroring the rotate handle's stem+circle above it —
  // see the render block). Deliberately NOT "click anywhere in the box
  // body" (which is what this used to be): a full-bbox hit-rect sits on
  // top of every edge/fill/circle/text inside it in z-order, which stole
  // their clicks entirely — there was no way to select/subdivide an edge
  // or click a fill if it happened to fall inside a multi-vertex
  // selection's box. A small dedicated handle leaves the whole box
  // interior free for normal interaction with what's actually in it.
  const onMoveHandlePointerDown = (e) => {
    e.stopPropagation();
    if (spaceDown) {
      beginPan(e);
      return;
    }
    if (viewMode) return;
    containerRef.current.setPointerCapture(e.pointerId);
    const world = screenToWorld(e.clientX, e.clientY);
    const ids = transformVertexIds;
    const startPositions = new Map(Array.from(ids).map((id) => [id, vertexById.get(id)]));
    const circleStartPositions = new Map(
      Array.from(selectedCircleIds)
        .map((id) => circlesForRender.find((c) => c.id === id))
        .filter(Boolean)
        .map((c) => [c.id, { cx: c.cx, cy: c.cy, r: c.r }])
    );
    dragRef.current = {
      mode: 'move',
      ids,
      circleIds: selectedCircleIds,
      startPositions,
      circleStartPositions,
      startWorld: world,
      moved: false,
      singleId: ids.size === 1 && selectedCircleIds.size === 0 ? Array.from(ids)[0] : null
    };
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
      const { nextDoc, vertexId } = resolvePlacement(doc, grid, world, viewport.zoom, { vertexSnapEnabled, edgeSnapEnabled, axisSnapEnabled }, { lines: customAxisLines }, verticesForSnap, edgesForSnap);
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
      const center = snapCirclePoint(world).point;
      dragRef.current = { mode: 'draw-circle', startWorld: center };
      setCircleDraft({ cx: center.x, cy: center.y, r: 0 });
      return;
    }
    if (tool === 'text') {
      dragRef.current = { mode: 'draw-text', startWorld: world };
      setTextDraft({ x0: world.x, y0: world.y, x1: world.x, y1: world.y });
      return;
    }
    if (tool === 'axis') {
      dragRef.current = { mode: 'draw-axis', startWorld: world };
      setAxisDraft({ x1: world.x, y1: world.y, x2: world.x, y2: world.y });
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
    setSelectedFillIds(new Set());
    setSelectedCircleIds(new Set());
    setSelectedAxisIds(new Set());
    setSelectedImageId(null);
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
      const snap = snapCandidate(verticesForSnap, edgesForSnap, world, snapOpts(viewport.zoom, grid, { vertexSnapEnabled, edgeSnapEnabled, axisSnapEnabled }, { lines: customAxisLines }));
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
        const snap = snapCandidate(verticesForSnap, edgesForSnap, world, snapOpts(viewport.zoom, grid, { vertexSnapEnabled, edgeSnapEnabled, axisSnapEnabled }, { excludeVertexId: drag.singleId, lines: drag.candidateLines }));
        setSnapPreview(snap);
        scheduleLiveOverrides(new Map([[drag.singleId, snap.point]]));
      } else {
        setSnapPreview(null);
        const dx = world.x - drag.startWorld.x;
        const dy = world.y - drag.startWorld.y;
        const map = new Map();
        for (const [id, pos] of drag.startPositions) map.set(id, { x: pos.x + dx, y: pos.y + dy });
        const circleMap = new Map();
        if (drag.circleStartPositions) {
          for (const [id, c] of drag.circleStartPositions) circleMap.set(id, { cx: c.cx + dx, cy: c.cy + dy });
        }
        scheduleLiveOverrides(map, circleMap);
        const totalCount = drag.ids.size + (drag.circleIds ? drag.circleIds.size : 0);
        if (totalCount > 1) setTransformReadout({ x: world.x, y: world.y, lines: [`\u0394x ${dx.toFixed(1)}`, `\u0394y ${dy.toFixed(1)}`] });
      }
      return;
    }

    if (drag.mode === 'spawn-connected') {
      if (dist(drag.startWorld, world) > MOVE_THRESHOLD / viewport.zoom) drag.moved = true;
      const snap = snapCandidate(verticesForSnap, edgesForSnap, world, snapOpts(viewport.zoom, grid, { vertexSnapEnabled, edgeSnapEnabled, axisSnapEnabled }, { excludeVertexId: drag.fromVertexId, lines: customAxisLines }));
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
      const snap = snapCirclePoint({ x: drag.startCx + dx, y: drag.startCy + dy });
      setSnapPreview(snap);
      setCircleDraft({ id: drag.circleId, cx: snap.point.x, cy: snap.point.y });
      return;
    }

    if (drag.mode === 'resize-circle') {
      setCircleDraft({ id: drag.circleId, cx: drag.cx, cy: drag.cy, r: dist({ x: drag.cx, y: drag.cy }, world) });
      return;
    }

    if (drag.mode === 'move-image') {
      const dx = world.x - drag.startWorld.x;
      const dy = world.y - drag.startWorld.y;
      setImageDraft({ id: drag.imageId, x: drag.startX + dx, y: drag.startY + dy });
      return;
    }

    if (drag.mode === 'resize-image') {
      const image = doc.referenceImages.find((r) => r.id === drag.imageId);
      if (image) setImageDraft({ id: drag.imageId, width: Math.max(8, world.x - drag.x), height: Math.max(8, world.y - drag.y) });
      return;
    }

    if (drag.mode === 'draw-text') {
      setTextDraft({ x0: drag.startWorld.x, y0: drag.startWorld.y, x1: world.x, y1: world.y });
      return;
    }

    if (drag.mode === 'draw-axis') {
      setAxisDraft({ x1: drag.startWorld.x, y1: drag.startWorld.y, x2: world.x, y2: world.y });
      return;
    }

    if (drag.mode === 'move-axis') {
      const dx = world.x - drag.startWorld.x;
      const dy = world.y - drag.startWorld.y;
      setAxisDraft({ id: drag.axisId, x1: drag.x1 + dx, y1: drag.y1 + dy, x2: drag.x2 + dx, y2: drag.y2 + dy });
      return;
    }

    if (drag.mode === 'resize-axis') {
      const fixed = drag.which === 'p1' ? { x2: drag.x2, y2: drag.y2 } : { x1: drag.x1, y1: drag.y1 };
      const moving = drag.which === 'p1' ? { x1: world.x, y1: world.y } : { x2: world.x, y2: world.y };
      setAxisDraft({ id: drag.axisId, ...fixed, ...moving });
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
      const { map, circleMap, delta } = computeTransform(drag, world);
      scheduleLiveOverrides(map, circleMap);
      if (delta) setTransformReadout({ x: delta.point.x, y: delta.point.y, lines: delta.lines });
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
        const { nextDoc } = resolvePlacement(doc, grid, pointerWorld, viewport.zoom, { vertexSnapEnabled, edgeSnapEnabled, axisSnapEnabled }, { lines: customAxisLines }, verticesForSnap, edgesForSnap);
        if (nextDoc !== doc) commitState(nextDoc);
      }
      return;
    }

    if (drag.mode === 'spawn-connected') {
      if (pointerWorld) {
        const dropDist = dist(drag.startWorld, pointerWorld);
        if (dropDist > MOVE_THRESHOLD / viewport.zoom) {
          const { nextDoc, vertexId } = resolvePlacement(doc, grid, pointerWorld, viewport.zoom, { vertexSnapEnabled, edgeSnapEnabled, axisSnapEnabled }, { excludeVertexId: drag.fromVertexId, lines: customAxisLines }, verticesForSnap, edgesForSnap);
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
        // Re-resolve with the SAME candidateLines the live drag used
        // (straighten/perpendicular/custom-axis lines) — otherwise the
        // final drop point could differ from what was just previewed,
        // e.g. losing a custom-axis snap in the last pixel of the drag.
        const snap = snapCandidate(verticesForSnap, edgesForSnap, pointerWorld, snapOpts(viewport.zoom, grid, { vertexSnapEnabled, edgeSnapEnabled, axisSnapEnabled }, { excludeVertexId: drag.singleId, lines: drag.candidateLines }));
        let next = moveVertices(doc, new Map([[drag.singleId, snap.point]]));
        if (snap.snappedEdgeId) next = bindVertexOntoEdge(next, snap.snappedEdgeId, drag.singleId);
        if (mergeCoincidentEnabled) next = mergeCoincidentVertices(next, [drag.singleId]);
        commitState(next);
      } else {
        commitCombinedOverrides();
      }
      setLiveOverrides(null);
      setCircleTransformOverrides(null);
      setTransformReadout(null);
      return;
    }

    if (drag.mode === 'transform') {
      commitCombinedOverrides();
      setLiveOverrides(null);
      setCircleTransformOverrides(null);
      setTransformReadout(null);
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
        const center = snapCirclePoint({ x: drag.startCx + dx, y: drag.startCy + dy }).point;
        commitState(moveCircles(doc, new Map([[drag.circleId, center]])));
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

    if (drag.mode === 'move-image') {
      setImageDraft(null);
      if (pointerWorld) {
        const dx = pointerWorld.x - drag.startWorld.x;
        const dy = pointerWorld.y - drag.startWorld.y;
        commitState(moveReferenceImage(doc, drag.imageId, drag.startX + dx, drag.startY + dy));
      }
      return;
    }

    if (drag.mode === 'resize-image') {
      setImageDraft(null);
      if (pointerWorld) {
        commitState(resizeReferenceImage(doc, drag.imageId, Math.max(8, pointerWorld.x - drag.x), Math.max(8, pointerWorld.y - drag.y)));
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

    if (drag.mode === 'draw-axis') {
      setAxisDraft(null);
      const end = pointerWorld || drag.startWorld;
      if (dist(drag.startWorld, end) > MOVE_THRESHOLD / viewport.zoom) {
        const next = addSnapAxis(doc, drag.startWorld.x, drag.startWorld.y, end.x, end.y);
        commitState(next);
        setSelectedAxisIds(new Set([next._newSnapAxisId]));
        setTool('select');
      }
      return;
    }

    if (drag.mode === 'move-axis') {
      setAxisDraft(null);
      if (pointerWorld) {
        const dx = pointerWorld.x - drag.startWorld.x;
        const dy = pointerWorld.y - drag.startWorld.y;
        if (Math.abs(dx) > 1e-6 || Math.abs(dy) > 1e-6) commitState(moveSnapAxis(doc, drag.axisId, dx, dy));
      }
      return;
    }

    if (drag.mode === 'resize-axis') {
      setAxisDraft(null);
      if (pointerWorld) commitState(setSnapAxisEndpoint(doc, drag.axisId, drag.which, pointerWorld));
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
    const circleMap = new Map();
    let delta = null;
    if (drag.kind === 'scale') {
      const dx = world.x - drag.anchor.x;
      const dy = world.y - drag.anchor.y;
      let scaleX = drag.spanX === 0 ? 1 : dx / drag.spanX;
      let scaleY = drag.spanY === 0 ? 1 : dy / drag.spanY;
      if (drag.axisLock === 'x') scaleY = 1; // edge-midpoint handle: horizontal-only scaling
      if (drag.axisLock === 'y') scaleX = 1; // edge-midpoint handle: vertical-only scaling
      // Proportional scaling (toolbar toggle) only applies to a corner
      // handle (axisLock is null there) — an edge-midpoint handle is
      // single-axis by design, and locking it too would make it
      // indistinguishable from a corner handle.
      if (proportionalScaling && !drag.axisLock) {
        const magnitude = (Math.abs(scaleX) + Math.abs(scaleY)) / 2;
        scaleX = magnitude * (scaleX < 0 ? -1 : 1);
        scaleY = magnitude * (scaleY < 0 ? -1 : 1);
      }
      for (const [id, pos] of drag.startPositions) {
        map.set(id, { x: drag.anchor.x + (pos.x - drag.anchor.x) * scaleX, y: drag.anchor.y + (pos.y - drag.anchor.y) * scaleY });
      }
      if (drag.circleStartPositions) {
        // A circle can't become an ellipse (this editor only ever supports
        // perfect circles), so a non-uniform drag scales its radius by the
        // geometric mean of scaleX/scaleY — one reasonable number that
        // still responds to the drag, rather than an oval or ignoring one
        // axis outright.
        const rFactor = Math.sqrt(Math.abs(scaleX * scaleY));
        for (const [id, c] of drag.circleStartPositions) {
          circleMap.set(id, {
            cx: drag.anchor.x + (c.cx - drag.anchor.x) * scaleX,
            cy: drag.anchor.y + (c.cy - drag.anchor.y) * scaleY,
            r: Math.max(0.5, c.r * rFactor)
          });
        }
      }
      // Shown as a ratio (see the request this implements: "as a ratio, so
      // like if you want to keep a 1:1 ratio") rather than two separate
      // percentages — reads directly as "still proportional" vs. "this is
      // stretching" without the person having to compare two numbers.
      delta = { lines: [`${scaleX.toFixed(2)} : ${scaleY.toFixed(2)}`], point: world };
    } else if (drag.kind === 'rotate') {
      const a0 = Math.atan2(drag.startWorld.y - drag.center.y, drag.startWorld.x - drag.center.x);
      const a1 = Math.atan2(world.y - drag.center.y, world.x - drag.center.x);
      const da = a1 - a0;
      const cos = Math.cos(da), sin = Math.sin(da);
      for (const [id, pos] of drag.startPositions) {
        const dx = pos.x - drag.center.x, dy = pos.y - drag.center.y;
        map.set(id, { x: drag.center.x + dx * cos - dy * sin, y: drag.center.y + dx * sin + dy * cos });
      }
      if (drag.circleStartPositions) {
        // A circle looks identical at any rotation — only its CENTER needs
        // to move around the pivot; the radius is untouched.
        for (const [id, c] of drag.circleStartPositions) {
          const dx = c.cx - drag.center.x, dy = c.cy - drag.center.y;
          circleMap.set(id, { cx: drag.center.x + dx * cos - dy * sin, cy: drag.center.y + dx * sin + dy * cos, r: c.r });
        }
      }
      delta = { lines: [`${((da * 180) / Math.PI).toFixed(1)}\u00b0`], point: world };
    }
    return { map, circleMap, delta };
  }

  const beginScale = (e, handle) => {
    e.stopPropagation();
    containerRef.current.setPointerCapture(e.pointerId);
    const world = screenToWorld(e.clientX, e.clientY);
    const startPositions = new Map(Array.from(transformVertexIds).map((id) => [id, vertexById.get(id)]));
    const circleStartPositions = new Map(
      Array.from(selectedCircleIds)
        .map((id) => circlesForRender.find((c) => c.id === id))
        .filter(Boolean)
        .map((c) => [c.id, { cx: c.cx, cy: c.cy, r: c.r }])
    );
    dragRef.current = { mode: 'transform', kind: 'scale', anchor: handle.anchor, axisLock: handle.axisLock, spanX: world.x - handle.anchor.x, spanY: world.y - handle.anchor.y, startPositions, circleStartPositions };
  };

  const beginRotate = (e, box) => {
    e.stopPropagation();
    containerRef.current.setPointerCapture(e.pointerId);
    const center = { x: (box.minX + box.maxX) / 2, y: (box.minY + box.maxY) / 2 };
    const startPositions = new Map(Array.from(transformVertexIds).map((id) => [id, vertexById.get(id)]));
    const circleStartPositions = new Map(
      Array.from(selectedCircleIds)
        .map((id) => circlesForRender.find((c) => c.id === id))
        .filter(Boolean)
        .map((c) => [c.id, { cx: c.cx, cy: c.cy, r: c.r }])
    );
    dragRef.current = { mode: 'transform', kind: 'rotate', center, startWorld: screenToWorld(e.clientX, e.clientY), startPositions, circleStartPositions };
  };

  // ---------------------------------------------------------------------
  // Keyboard
  // ---------------------------------------------------------------------
  const onKeyDown = (e) => {
    if (viewMode) return; // View mode is look-only — undo/redo/shortcuts don't apply since nothing can be selected or edited
    if (e.key === 'Delete' || e.key === 'Backspace') {
      e.preventDefault();
      if (selectedImageId) deleteSelectedImage();
      else deleteSelection();
    } else if (e.key === 'Escape') {
      setSelectedVertexIds(new Set());
      setSelectedEdgeIds(new Set());
      setSelectedFillIds(new Set());
      setSelectedCircleIds(new Set());
      setSelectedAxisIds(new Set());
      setSelectedImageId(null);
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
    } else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'c') {
      if (selectedVertexIds.size || selectedCircleIds.size || selectedTextIds.size) {
        e.preventDefault();
        clipboardRef.current = copySelection(doc, { vertexIds: selectedVertexIds, circleIds: selectedCircleIds, textIds: selectedTextIds });
        pasteOffsetCountRef.current = 0;
      }
    } else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'v') {
      if (clipboardRef.current) {
        e.preventDefault();
        pasteOffsetCountRef.current += 1;
        const shift = 24 * pasteOffsetCountRef.current; // steps successive pastes apart instead of stacking them exactly on top of each other
        const { state: next, pastedVertexIds, pastedCircleIds, pastedTextIds } = pasteClipboard(doc, clipboardRef.current, { x: shift, y: shift }, safeActiveLayerId);
        commitState(next);
        // Select the pasted copy, same "just-created things get selected"
        // convention as every other add* mutation in this file.
        setSelectedVertexIds(new Set(pastedVertexIds));
        setSelectedCircleIds(new Set(pastedCircleIds));
        setSelectedEdgeIds(new Set());
        setSelectedFillIds(new Set());
        void pastedTextIds; // a text's corners are already covered by pastedVertexIds' selection
      }
    } else if (!e.metaKey && !e.ctrlKey && e.key.toLowerCase() === 'g' && selectedVertexIds.size > 1) {
      e.preventDefault();
      commitState(e.shiftKey ? ungroupVertices(doc, selectedVertexIds) : groupVertices(doc, selectedVertexIds));
    } else if (!e.metaKey && !e.ctrlKey && !e.target.closest('select')) {
      const map = { v: 'select', p: 'vertex', e: 'edge', l: 'polyline', c: 'circle', t: 'text', x: 'axis', i: 'eyedropper', f: 'fill' };
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

  // An edge has no position of its own — only its endpoints do — so a
  // selected edge contributes its two vertices to the shared transform
  // target even when those vertices aren't independently selected.
  const transformVertexIds = useMemo(() => {
    if (!selectedEdgeIds.size) return selectedVertexIds;
    const ids = new Set(selectedVertexIds);
    for (const e of doc.edges) {
      if (selectedEdgeIds.has(e.id)) {
        ids.add(e.v1);
        ids.add(e.v2);
      }
    }
    return ids;
  }, [selectedVertexIds, selectedEdgeIds, doc.edges]);
  const transformItemCount = transformVertexIds.size + selectedCircleIds.size;
  const selectionBox = !viewMode && tool === 'select' && transformItemCount > 1 ? combinedBboxOf(verticesForRender, transformVertexIds, circlesForRender, selectedCircleIds) : null;
  // A text counts as "selected" once ALL 4 of its corners are — see
  // onTextPointerDown and the Text section of vectorState.js. Used for the
  // toolbar's text style controls and the layer-move buttons below; a
  // partial-corner vertex selection (e.g. mid-marquee) doesn't count.
  const selectedTextIds = new Set(doc.texts.filter((t) => [t.v1, t.v2, t.v3, t.v4].every((id) => selectedVertexIds.has(id))).map((t) => t.id));
  // Disconnect/Split (see vectorState.js) only make sense for exactly one
  // selected vertex, and only for the degrees they're actually defined
  // for — see each function's own doc comment for why 3+ is excluded.
  // Requires a PURE single-vertex selection — disconnect/split (and the
  // angle/position measurement overlay below) don't have a meaningful
  // reading once edges/circles are also part of a mixed selection.
  const singleSelectedVertexId = selectedVertexIds.size === 1 && selectedEdgeIds.size === 0 && selectedCircleIds.size === 0 ? [...selectedVertexIds][0] : null;
  const singleSelectedVertexDegree = singleSelectedVertexId ? doc.edges.filter((e) => e.v1 === singleSelectedVertexId || e.v2 === singleSelectedVertexId).length : 0;
  const canDisconnect = singleSelectedVertexDegree === 1 || singleSelectedVertexDegree === 2;
  const canSplit = singleSelectedVertexDegree >= 2;
  // When vertices are selected (directly, via marquee, or as a group),
  // "set edge color/weight" applies to every edge that runs BETWEEN two
  // selected vertices — the natural reading of "style the edges of this
  // selection" when the selection itself is a set of points, not edges.
  const edgesWithinVertexSelection = selectedVertexIds.size > 1 ? doc.edges.filter((e) => selectedVertexIds.has(e.v1) && selectedVertexIds.has(e.v2)) : [];
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
          if (edgesWithinVertexSelection.length) commitState(edgesWithinVertexSelection.reduce((d, e) => setEdgeStyle(d, e.id, { color }), doc));
          if (selectedFillIds.size) commitState(Array.from(selectedFillIds).reduce((d, id) => setFillColor(d, id, color), doc));
        }}
        onSetThickness={(thickness) => {
          setActiveStyle((s) => ({ ...s, thickness }));
          if (selectedEdgeIds.size) commitState(Array.from(selectedEdgeIds).reduce((d, id) => setEdgeStyle(d, id, { thickness }), doc));
          if (selectedCircleIds.size) commitState(Array.from(selectedCircleIds).reduce((d, id) => setCircleStyle(d, id, { style: { thickness } }), doc));
          if (edgesWithinVertexSelection.length) commitState(edgesWithinVertexSelection.reduce((d, e) => setEdgeStyle(d, e.id, { thickness }), doc));
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
        onSetTextValign={(valign) => {
          setActiveTextStyle((s) => ({ ...s, valign }));
          if (selectedTextIds.size) commitState(Array.from(selectedTextIds).reduce((d, id) => setTextStyle(d, id, { valign }), doc));
        }}
        canvasBackground={doc.canvas.background}
        onSetCanvasBackground={(color) => commitState(setCanvasBackground(doc, color))}
        axisSnapEnabled={axisSnapEnabled}
        onToggleAxisSnap={() => setAxisSnapEnabled((v) => !v)}
        vertexSnapEnabled={vertexSnapEnabled}
        onToggleVertexSnap={() => setVertexSnapEnabled((v) => !v)}
        edgeSnapEnabled={edgeSnapEnabled}
        onToggleEdgeSnap={() => setEdgeSnapEnabled((v) => !v)}
        customAxisSnapEnabled={customAxisSnapEnabled}
        onToggleCustomAxisSnap={() => setCustomAxisSnapEnabled((v) => !v)}
        perpParallelSnapEnabled={perpParallelSnapEnabled}
        onTogglePerpParallelSnap={() => setPerpParallelSnapEnabled((v) => !v)}
        mergeCoincidentEnabled={mergeCoincidentEnabled}
        onToggleMergeCoincident={() => setMergeCoincidentEnabled((v) => !v)}
        proportionalScaling={proportionalScaling}
        onToggleProportionalScaling={() => setProportionalScaling((v) => !v)}
        onOpenImagePicker={() => setImagePickerOpen(true)}
        snapMenuOpen={snapMenuOpen}
        onToggleSnapMenu={() => setSnapMenuOpen((v) => !v)}
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
          setSelectedFillIds(new Set());
          setSelectedCircleIds(new Set());
          setSelectedAxisIds(new Set());
          setSelectedImageId(null);
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
      {imagePickerOpen && <CanvasFilePickerModal files={imageFiles} onPick={handlePickImage} onClose={() => setImagePickerOpen(false)} />}
      {selectedImageId && (
        <div className="vector-selection-toolbar vector-reference-image-toolbar">
          <button className="icon-btn" onClick={deleteSelectedImage} title="Delete image">
            <IconTrash size={14} />
          </button>
        </div>
      )}
      {/* historyTick isn't read directly — it exists purely to force this toolbar to
          re-render after undo/redo mutate the ref-backed history stacks below. */}
      <div style={{ display: 'none' }}>{historyTick}</div>
      {/* vector-body: canvas + optional docked sidebars, side by side (flex
          row) rather than the sidebars overlaying the canvas — so Layers
          and Description can both be open and visible at once instead of
          stacking on top of each other. */}
      <div className="vector-body">
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
            {/* Reference/tracing images loaded from the vault — always painted
                first (behind every layer), faded, and non-interactive except
                through the select tool (see onReferenceImagePointerDown
                below). Never part of the exported SVG (compileVectorSvg). */}
            {doc.referenceImages.map((img) => (
              <ReferenceImageNode
                key={img.id}
                image={imageDraft && imageDraft.id === img.id ? { ...img, ...imageDraft } : img}
                token={handlers?.token}
                selected={!viewMode && tool === 'select' && selectedImageId === img.id}
                onPointerDownImage={(e) => onReferenceImagePointerDown(e, img)}
                onPointerDownResize={(e) => onReferenceImageResizePointerDown(e, img)}
              />
            ))}
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
                        className={`vector-fill ${tool === 'eyedropper' || tool === 'select' ? 'pickable' : ''} ${selectedFillIds.has(fill.id) ? 'selected' : ''}`}
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
                          {/* The individual per-circle radius handle only
                              applies when this circle is the SOLE thing
                              selected — once it's part of a bigger mixed
                              selection (selectionBox showing), the box's
                              own scale handles take over that job (see the
                              Transform section's geometric-mean radius
                              scaling), and showing both would be
                              confusing/redundant. */}
                          {selected && !viewMode && !selectionBox && (
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
                                textAlign: t.align,
                                display: 'flex',
                                flexDirection: 'column',
                                justifyContent: { top: 'flex-start', middle: 'center', bottom: 'flex-end' }[t.valign] || 'flex-start'
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

            {/* Live preview of the segment about to be created — each gets
                the same length+rotation readout a selected edge does, so
                the stat is available while DRAWING, not just afterward. */}
            {tool === 'edge' && edgeChainFirst && pointerWorld && vertexById.get(edgeChainFirst) && (
              <>
                <line className="vector-preview-line" x1={vertexById.get(edgeChainFirst).x} y1={vertexById.get(edgeChainFirst).y} x2={pointerWorld.x} y2={pointerWorld.y} />
                <MeasurementLabel
                  x={(vertexById.get(edgeChainFirst).x + pointerWorld.x) / 2}
                  y={(vertexById.get(edgeChainFirst).y + pointerWorld.y) / 2}
                  lines={[
                    `${dist(vertexById.get(edgeChainFirst), pointerWorld).toFixed(1)}`,
                    `${lineRotationDeg(pointerWorld.x - vertexById.get(edgeChainFirst).x, pointerWorld.y - vertexById.get(edgeChainFirst).y).toFixed(1)}\u00b0`
                  ]}
                  zoom={viewport.zoom}
                />
              </>
            )}
            {tool === 'polyline' && polylineChain.length > 0 && pointerWorld && vertexById.get(polylineChain[polylineChain.length - 1]) && (
              <>
                <line
                  className="vector-preview-line"
                  x1={vertexById.get(polylineChain[polylineChain.length - 1]).x}
                  y1={vertexById.get(polylineChain[polylineChain.length - 1]).y}
                  x2={pointerWorld.x}
                  y2={pointerWorld.y}
                />
                <MeasurementLabel
                  x={(vertexById.get(polylineChain[polylineChain.length - 1]).x + pointerWorld.x) / 2}
                  y={(vertexById.get(polylineChain[polylineChain.length - 1]).y + pointerWorld.y) / 2}
                  lines={[
                    `${dist(vertexById.get(polylineChain[polylineChain.length - 1]), pointerWorld).toFixed(1)}`,
                    `${lineRotationDeg(pointerWorld.x - vertexById.get(polylineChain[polylineChain.length - 1]).x, pointerWorld.y - vertexById.get(polylineChain[polylineChain.length - 1]).y).toFixed(1)}\u00b0`
                  ]}
                  zoom={viewport.zoom}
                />
              </>
            )}
            {dragRef.current?.mode === 'spawn-connected' && pointerWorld && vertexById.get(dragRef.current.fromVertexId) && (
              <>
                <line
                  className="vector-preview-line"
                  x1={vertexById.get(dragRef.current.fromVertexId).x}
                  y1={vertexById.get(dragRef.current.fromVertexId).y}
                  x2={pointerWorld.x}
                  y2={pointerWorld.y}
                />
                <MeasurementLabel
                  x={(vertexById.get(dragRef.current.fromVertexId).x + pointerWorld.x) / 2}
                  y={(vertexById.get(dragRef.current.fromVertexId).y + pointerWorld.y) / 2}
                  lines={[
                    `${dist(vertexById.get(dragRef.current.fromVertexId), pointerWorld).toFixed(1)}`,
                    `${lineRotationDeg(pointerWorld.x - vertexById.get(dragRef.current.fromVertexId).x, pointerWorld.y - vertexById.get(dragRef.current.fromVertexId).y).toFixed(1)}\u00b0`
                  ]}
                  zoom={viewport.zoom}
                />
              </>
            )}


            {/* Coordinate readout while about to place a plain vertex —
                the vertex tool's "creation" is a single click with no real
                draw phase, so this is the only chance to show its stat
                before it exists. */}
            {!viewMode && tool === 'vertex' && pointerWorld && !dragRef.current && (
              <MeasurementLabel x={pointerWorld.x} y={pointerWorld.y - 20 / viewport.zoom} lines={[`${pointerWorld.x.toFixed(1)}, ${pointerWorld.y.toFixed(1)}`]} zoom={viewport.zoom} />
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
            {/* Arbitrary-angle "straighten"/"preserve direction" guide —
                see vectorTopology.js's snapCandidate `lines` option and
                onVertexPointerDown's candidateLines. Extended well past
                its own two defining points so it reads as the same kind
                of full-length guide as the horizontal/vertical ones above. */}
            {!viewMode &&
              snapPreview?.lineSnapped &&
              (() => {
                const { snapLineP1: p1, snapLineP2: p2 } = snapPreview;
                const dx = p2.x - p1.x, dy = p2.y - p1.y;
                const len = Math.hypot(dx, dy) || 1;
                const ux = (dx / len) * GUIDE_LINE_SPAN, uy = (dy / len) * GUIDE_LINE_SPAN;
                return <line className="vector-snap-guide" x1={p1.x - ux} y1={p1.y - uy} x2={p2.x + ux} y2={p2.y + uy} />;
              })()}
            {!viewMode && snapPreview?.snappedVertexId && vertexById.get(snapPreview.snappedVertexId) && (
              <circle className="vector-snap-marker" cx={snapPreview.point.x} cy={snapPreview.point.y} r={9 / viewport.zoom} />
            )}
            {!viewMode && snapPreview?.snappedEdgeId && <circle className="vector-snap-marker" cx={snapPreview.point.x} cy={snapPreview.point.y} r={5 / viewport.zoom} />}

            {/* User-drawn snap axes — an editing aid, always visible (as a
                dotted line, extended to a fixed span so it reads as the
                infinite reference line it acts as) in Edit mode, hidden in
                View mode and never part of the export (see the Snap axes
                section of vectorState.js). */}
            {!viewMode &&
              axesForRender.map((a) => {
                const selected = selectedAxisIds.has(a.id);
                const dx = a.x2 - a.x1, dy = a.y2 - a.y1;
                const len = Math.hypot(dx, dy) || 1;
                const ux = (dx / len) * GUIDE_LINE_SPAN, uy = (dy / len) * GUIDE_LINE_SPAN;
                return (
                  <g key={a.id}>
                    {selected && <line className="vector-selection-halo" x1={a.x1 - ux} y1={a.y1 - uy} x2={a.x2 + ux} y2={a.y2 + uy} strokeWidth={3 / viewport.zoom} />}
                    {/* Invisible wide-stroke hit target, stacked on top of the
                        thin visible line below — a 1px dotted stroke is a
                        painfully small click target, especially zoomed out,
                        so pointer capture uses this much fatter (but
                        unpainted) duplicate instead of trying to widen the
                        line the person actually sees. */}
                    <line
                      className="vector-snap-axis-hit"
                      x1={a.x1 - ux}
                      y1={a.y1 - uy}
                      x2={a.x2 + ux}
                      y2={a.y2 + uy}
                      strokeWidth={14 / viewport.zoom}
                      onPointerDown={(e) => onAxisPointerDown(e, a)}
                    />
                    <line
                      className={`vector-snap-axis ${selected ? 'selected' : ''}`}
                      x1={a.x1 - ux}
                      y1={a.y1 - uy}
                      x2={a.x2 + ux}
                      y2={a.y2 + uy}
                    />
                    {selected && (
                      <>
                        <circle className="vector-scale-handle" cx={a.x1} cy={a.y1} r={5 / viewport.zoom} style={{ cursor: 'move' }} onPointerDown={(e) => beginAxisEndpointDrag(e, a.id, 'p1')} />
                        <circle className="vector-scale-handle" cx={a.x2} cy={a.y2} r={5 / viewport.zoom} style={{ cursor: 'move' }} onPointerDown={(e) => beginAxisEndpointDrag(e, a.id, 'p2')} />
                      </>
                    )}
                  </g>
                );
              })}
            {/* In-progress axis draw preview — not yet a real axis. */}
            {axisDraft && !axisDraft.id && (
              <>
                <line className="vector-snap-axis" x1={axisDraft.x1} y1={axisDraft.y1} x2={axisDraft.x2} y2={axisDraft.y2} />
                <MeasurementLabel
                  x={(axisDraft.x1 + axisDraft.x2) / 2}
                  y={(axisDraft.y1 + axisDraft.y2) / 2}
                  lines={[`${dist({ x: axisDraft.x1, y: axisDraft.y1 }, { x: axisDraft.x2, y: axisDraft.y2 }).toFixed(1)}`, `${lineRotationDeg(axisDraft.x2 - axisDraft.x1, axisDraft.y2 - axisDraft.y1).toFixed(1)}\u00b0`]}
                  zoom={viewport.zoom}
                />
              </>
            )}


            {/* Vertex dots are an editing aid, not artwork — hidden in View mode,
                and hidden per-vertex when every edge/text it belongs to is on a
                hidden layer (see hiddenVertexIds). */}
            {!viewMode &&
              verticesForRender
                .filter((v) => !hiddenVertexIds.has(v.id))
                .map((v) => {
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

            {/* Measurement overlays — Edit-mode-only, purely informational
                (never in the export). Kept selection-gated rather than
                shown for every edge/vertex/circle at once, which would be
                unreadable clutter; snap-axis intersection angles are the
                one exception (always shown, matching axes' own always-
                visible treatment) since deliberately-placed axes are
                sparse by nature. */}
            {!viewMode &&
              sortedEdges
                .filter((e) => selectedEdgeIds.has(e.id))
                .map((e) => {
                  const a = vertexById.get(e.v1), b = vertexById.get(e.v2);
                  if (!a || !b) return null;
                  const length = dist(a, b);
                  const rotation = lineRotationDeg(b.x - a.x, b.y - a.y);
                  return <MeasurementLabel key={`edge-${e.id}`} x={(a.x + b.x) / 2} y={(a.y + b.y) / 2} lines={[`${length.toFixed(1)}`, `${rotation.toFixed(1)}\u00b0`]} zoom={viewport.zoom} />;
                })}

            {!viewMode &&
              axesForRender
                .filter((a) => selectedAxisIds.has(a.id))
                .map((a) => {
                  const length = dist({ x: a.x1, y: a.y1 }, { x: a.x2, y: a.y2 });
                  const rotation = lineRotationDeg(a.x2 - a.x1, a.y2 - a.y1);
                  return <MeasurementLabel key={`axis-${a.id}`} x={(a.x1 + a.x2) / 2} y={(a.y1 + a.y2) / 2} lines={[`${length.toFixed(1)}`, `${rotation.toFixed(1)}\u00b0`]} zoom={viewport.zoom} />;
                })}

            {!viewMode &&
              axesForRender.flatMap((a, i) =>
                axesForRender.slice(i + 1).map((b) => {
                  const hit = infiniteLineIntersection({ x: a.x1, y: a.y1 }, { x: a.x2, y: a.y2 }, { x: b.x1, y: b.y1 }, { x: b.x2, y: b.y2 });
                  if (!hit || Math.abs(hit.x) > GUIDE_LINE_SPAN || Math.abs(hit.y) > GUIDE_LINE_SPAN) return null;
                  const angles = vertexAngles([
                    { x: a.x2 - a.x1, y: a.y2 - a.y1 },
                    { x: b.x2 - b.x1, y: b.y2 - b.y1 }
                  ]);
                  if (!angles.length) return null;
                  const { angleDeg, bisector } = angles[0];
                  const labelDist = 30 / viewport.zoom;
                  return (
                    <MeasurementLabel
                      key={`axisx-${a.id}-${b.id}`}
                      x={hit.x + Math.cos(bisector) * labelDist}
                      y={hit.y + Math.sin(bisector) * labelDist}
                      lines={[`${angleDeg.toFixed(1)}\u00b0`]}
                      zoom={viewport.zoom}
                    />
                  );
                })
              )}

            {/* Position + incident-angle readouts for EVERY selected vertex
                at once (not just a single "focused" one) — a mixed or
                multi-vertex selection now gets one label set per vertex,
                same as edges/axes already did above. */}
            {!viewMode &&
              selectedEdgeIds.size === 0 &&
              selectedCircleIds.size === 0 &&
              Array.from(selectedVertexIds).map((vertexId) => {
                const v = vertexById.get(vertexId);
                if (!v) return null;
                const others = doc.edges
                  .filter((e) => e.v1 === vertexId || e.v2 === vertexId)
                  .map((e) => vertexById.get(e.v1 === vertexId ? e.v2 : e.v1))
                  .filter(Boolean);
                const angles = vertexAngles(others.map((p) => ({ x: p.x - v.x, y: p.y - v.y })));
                const labelDist = 34 / viewport.zoom;
                return (
                  <g key={`vpos-${vertexId}`}>
                    <MeasurementLabel x={v.x} y={v.y - 22 / viewport.zoom} lines={[`${v.x.toFixed(1)}, ${v.y.toFixed(1)}`]} zoom={viewport.zoom} />
                    {angles.map(({ angleDeg, bisector }, i) => (
                      <MeasurementLabel key={i} x={v.x + Math.cos(bisector) * labelDist} y={v.y + Math.sin(bisector) * labelDist} lines={[`${angleDeg.toFixed(1)}\u00b0`]} zoom={viewport.zoom} />
                    ))}
                  </g>
                );
              })}

            {/* Position (+ radius, for a real one) readout for every circle
                of concern: every selected circle, AND — so the stat shows
                up live while creating/moving/resizing one too, not only
                once it's selected afterward — the in-progress circleDraft. */}
            {!viewMode &&
              circlesForRender
                .filter((c) => selectedCircleIds.has(c.id))
                .map((c) => (
                  <MeasurementLabel
                    key={`circle-${c.id}`}
                    x={c.cx}
                    y={c.cy - c.r - 18 / viewport.zoom}
                    lines={[`${c.cx.toFixed(1)}, ${c.cy.toFixed(1)}`, `r ${c.r.toFixed(1)}`]}
                    zoom={viewport.zoom}
                  />
                ))}
            {!viewMode && circleDraft && !circleDraft.id && (
              <MeasurementLabel
                x={circleDraft.cx}
                y={circleDraft.cy - circleDraft.r - 18 / viewport.zoom}
                lines={[`${circleDraft.cx.toFixed(1)}, ${circleDraft.cy.toFixed(1)}`, `r ${circleDraft.r.toFixed(1)}`]}
                zoom={viewport.zoom}
              />
            )}


            {/* Live delta readout while actively moving/scaling/rotating a
                multi-selection — see onMoveHandlePointerDown/beginScale/
                beginRotate and computeTransform. Offset from the cursor so
                the label doesn't sit directly under the pointer. */}
            {!viewMode && transformReadout && (
              <MeasurementLabel x={transformReadout.x + 40 / viewport.zoom} y={transformReadout.y - 24 / viewport.zoom} lines={transformReadout.lines} zoom={viewport.zoom} />
            )}

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
                {/* Move handle — a stem+circle below the box, the mirror
                    image of the rotate handle above it. Dragging this
                    (not the box body — see onMoveHandlePointerDown)
                    moves the whole selection as a rigid group. */}
                <line
                  className="vector-move-stem"
                  x1={(selectionBox.minX + selectionBox.maxX) / 2}
                  y1={selectionBox.maxY}
                  x2={(selectionBox.minX + selectionBox.maxX) / 2}
                  y2={selectionBox.maxY + 24 / viewport.zoom}
                />
                <circle
                  className="vector-move-handle"
                  style={{ cursor: 'move' }}
                  cx={(selectionBox.minX + selectionBox.maxX) / 2}
                  cy={selectionBox.maxY + 24 / viewport.zoom}
                  r={6 / viewport.zoom}
                  onPointerDown={onMoveHandlePointerDown}
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

        {!viewMode && (selectedVertexIds.size > 0 || selectedEdgeIds.size > 0 || selectedCircleIds.size > 0 || selectedFillIds.size > 0 || selectedAxisIds.size > 0) && (
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
            {canDisconnect && (
              <button
                className="text-action"
                onClick={() => {
                  commitState(disconnectVertex(doc, singleSelectedVertexId));
                  setSelectedVertexIds(new Set([singleSelectedVertexId]));
                }}
                title={singleSelectedVertexDegree === 2 ? 'Disconnect — bypass with a direct edge, leaving this point isolated' : 'Disconnect — remove this edge, leaving this point isolated'}
              >
                Disconnect
              </button>
            )}
            {canSplit && (
              <button
                className="text-action"
                onClick={() => {
                  const next = splitVertex(doc, singleSelectedVertexId);
                  commitState(next);
                  setSelectedVertexIds(new Set([singleSelectedVertexId, ...(next._newVertexIds || [])]));
                }}
                title="Split — turn this shared point into one independent point per edge, coincident until dragged apart"
              >
                Split
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
    </div>
  );
}

export { VectorEditorView };
