import {
  IconCircleTool,
  IconCursorTool,
  IconDownload,
  IconEdgeTool,
  IconEye,
  IconEyedropperTool,
  IconFillTool,
  IconGrid,
  IconImage,
  IconLayoutGrid,
  IconMaximize,
  IconPolylineTool,
  IconRedo,
  IconStickyNote,
  IconType,
  IconUndo,
  IconVertexTool,
  IconZoomIn,
  IconZoomOut
} from '../../components/icons.jsx';
import { colorAlphaParts, withAlpha } from './vectorGeometry.jsx';

// A small local icon — kept here rather than added to the shared icons.jsx
// module, since that file's giant single-line export statement is fragile
// to patch against (see icons.jsx's own IconCircleTool for the same
// reasoning) and this glyph is only ever used by this one tool button.
const IconAxisTool = (p) => (
  <svg width={p.size ?? 16} height={p.size ?? 16} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" style={{ flexShrink: 0 }}>
    <line x1="3" y1="21" x2="21" y2="3" strokeDasharray="2.5 3" />
    <circle cx="7" cy="17" r="1.6" fill="currentColor" stroke="none" />
    <circle cx="17" cy="7" r="1.6" fill="currentColor" stroke="none" />
  </svg>
);

// Proportional-scaling toggle glyph — a diagonal-locked resize arrow, kept
// local for the same reason as IconAxisTool above.
const IconLockRatio = (p) => (
  <svg width={p.size ?? 16} height={p.size ?? 16} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
    <path d="M4 20 L10 20 L10 14" />
    <path d="M20 4 L14 4 L14 10" />
    <line x1="20" y1="4" x2="4" y2="20" />
  </svg>
);

const TOOLS = [
  { id: 'select', label: 'Select (V)', Icon: IconCursorTool },
  { id: 'vertex', label: 'Vertex — click to place, click an edge to subdivide it (P)', Icon: IconVertexTool },
  { id: 'edge', label: 'Edge — click two vertices in turn (E)', Icon: IconEdgeTool },
  { id: 'polyline', label: 'Polyline — click to chain vertices, click the start point or press Enter/Escape to finish (L)', Icon: IconPolylineTool },
  { id: 'circle', label: 'Circle — click to place, drag to set radius (C)', Icon: IconCircleTool },
  { id: 'text', label: 'Text — click to place, drag to size the box (T)', Icon: IconType },
  { id: 'axis', label: 'Snap axis — draw a persistent reference/snap line, always visible in Edit mode (X)', Icon: IconAxisTool },
  { id: 'eyedropper', label: 'Eyedropper — sample an edge, fill, circle, or text\u2019s style (I)', Icon: IconEyedropperTool },
  { id: 'fill', label: 'Flood fill — click an enclosed region; click a filled region again to recolor it (F)', Icon: IconFillTool }
];

const SNAP_TOGGLES = [
  { key: 'vertexSnapEnabled', onKey: 'onToggleVertexSnap', label: 'Vertices' },
  { key: 'edgeSnapEnabled', onKey: 'onToggleEdgeSnap', label: 'Edges (subdivide)' },
  { key: 'axisSnapEnabled', onKey: 'onToggleAxisSnap', label: 'Horizontal / vertical' },
  { key: 'customAxisSnapEnabled', onKey: 'onToggleCustomAxisSnap', label: 'Your snap axes' },
  { key: 'perpParallelSnapEnabled', onKey: 'onTogglePerpParallelSnap', label: 'Perpendicular / parallel to edges' }
];

// A combined slider + editable number field for the toolbar's numeric
// setters (edge/outline weight, circle radius, text size) — replaces the
// old fixed-option <select> dropdowns with a continuously settable value
// that's still quick to drag.
function SliderNumber({ value, onChange, min, max, step = 1, title, numberWidth = 46 }) {
  return (
    <span className="vector-slider-field" title={title}>
      <input type="range" className="vector-slider" min={min} max={max} step={step} value={value} onChange={(e) => onChange(Number(e.target.value))} />
      <input type="number" className="vector-slider-number" min={min} max={max} step={step} value={value} style={{ width: numberWidth }} onChange={(e) => onChange(Number(e.target.value))} />
    </span>
  );
}

// The toolbar's one custom-color control for a given role (edge/outline,
// circle fill, text) — a hue/RGB picker plus an alpha slider so any color,
// including a fully transparent one, is reachable without a fixed swatch
// row. `noneValue`, when given, also renders a dedicated "no fill" swatch
// (circle fill's existing 'none' sentinel — distinct from a transparent
// *color*, since 'none' skips painting entirely rather than painting at
// 0% opacity of some hue).
function ColorAlphaField({ color, onChange, title, noneValue }) {
  const { hex6, alphaPct } = colorAlphaParts(color);
  return (
    <span className="vector-color-alpha-field">
      {noneValue !== undefined && (
        <button type="button" className={`vector-color-swatch vector-fill-none ${color === noneValue ? 'active' : ''}`} title="No fill" onClick={() => onChange(noneValue)} />
      )}
      <label className="vector-color-custom" title={title} style={{ background: color === noneValue ? 'transparent' : color }}>
        <input type="color" value={hex6} onChange={(e) => onChange(withAlpha(e.target.value, color === noneValue ? 100 : alphaPct))} />
      </label>
      <input
        type="range"
        className="vector-alpha-slider"
        min={0}
        max={100}
        value={color === noneValue ? 100 : alphaPct}
        title="Opacity — drag to 0 for a fully transparent color"
        onChange={(e) => onChange(withAlpha(hex6, Number(e.target.value)))}
      />
    </span>
  );
}

function VectorToolbar(props) {
  const {
    tool,
    onSetTool,
    activeStyle,
    onSetColor,
    onSetThickness,
    activeRadius,
    onSetRadius,
    circleFill,
    onSetCircleFill,
    activeTextStyle,
    onSetTextColor,
    onSetTextFontSize,
    onSetTextAlign,
    onSetTextValign,
    canvasBackground,
    onSetCanvasBackground,
    snapMenuOpen,
    onToggleSnapMenu,
    mergeCoincidentEnabled,
    onToggleMergeCoincident,
    layersPanelOpen,
    onToggleLayersPanel,
    descriptionPanelOpen,
    onToggleDescriptionPanel,
    proportionalScaling,
    onToggleProportionalScaling,
    onOpenImagePicker,
    viewMode,
    onToggleViewMode,
    onUndo,
    onRedo,
    canUndo,
    canRedo,
    zoom,
    onZoomIn,
    onZoomOut,
    onZoomReset,
    onFitToContent,
    onExportSvg
  } = props;
  return (
    <div className="vector-toolbar">
      {/* Everything inside this fieldset is inert while View mode is on —
          none of it applies to a canvas you're only looking at, not
          editing. The view-mode toggle itself, plus zoom/undo/export,
          stay live outside of it. */}
      <fieldset className="vector-toolbar-fieldset" disabled={viewMode}>
        <div className="vector-toolbar-group">
          {TOOLS.map(({ id, label, Icon }) => (
            <button key={id} className={`icon-btn ${tool === id ? 'active' : ''}`} title={label} aria-pressed={tool === id} onClick={() => onSetTool(id)}>
              <Icon size={15} />
            </button>
          ))}
        </div>
        <div className="vector-toolbar-group">
          <ColorAlphaField color={activeStyle.color} onChange={onSetColor} title="Edge/outline color for the next edge or circle you draw — drag the opacity slider to 0 for a transparent color" />
          <SliderNumber value={activeStyle.thickness} onChange={onSetThickness} min={0} max={40} title="Edge/outline weight for the next edge or circle you draw — 0 draws no ink at all, but stays visible/selectable as a dashed guide in Edit mode" />
          <div className="vector-snap-menu-anchor">
            <button className={`icon-btn ${snapMenuOpen ? 'active' : ''}`} title="Snapping & editing settings" aria-pressed={snapMenuOpen} onClick={onToggleSnapMenu}>
              <IconGrid size={15} />
            </button>
            {snapMenuOpen && (
              <div className="vector-snap-menu">
                {SNAP_TOGGLES.map(({ key, onKey, label }) => (
                  <label key={key} className="vector-snap-menu-row">
                    <input type="checkbox" checked={props[key]} onChange={() => props[onKey]()} />
                    {label}
                  </label>
                ))}
                <div className="vector-snap-menu-divider" />
                <label className="vector-snap-menu-row" title="When two points end up at the exact same spot after a drag, fold them into one instead of leaving two coincident points">
                  <input type="checkbox" checked={mergeCoincidentEnabled} onChange={onToggleMergeCoincident} />
                  Merge overlapping points
                </label>
              </div>
            )}
          </div>
          <button
            className={`icon-btn ${proportionalScaling ? 'active' : ''}`}
            title="Proportional scaling — keep the selection's aspect ratio locked while dragging a corner handle"
            aria-pressed={proportionalScaling}
            onClick={onToggleProportionalScaling}
          >
            <IconLockRatio size={15} />
          </button>
        </div>
        <div className="vector-toolbar-group">
          <SliderNumber value={activeRadius} onChange={onSetRadius} min={1} max={400} title="Radius for the next circle you draw" numberWidth={52} />
          <ColorAlphaField color={circleFill} onChange={onSetCircleFill} title="Circle fill color" noneValue="none" />
        </div>
        <div className="vector-toolbar-group">
          <ColorAlphaField color={activeTextStyle.color} onChange={onSetTextColor} title="Text color for the next text box you draw" />
          <SliderNumber value={activeTextStyle.fontSize} onChange={onSetTextFontSize} min={6} max={200} title="Font size for the next text box you draw" numberWidth={50} />
          <select className="vector-thickness-select" value={activeTextStyle.align} onChange={(e) => onSetTextAlign(e.target.value)} title="Horizontal text alignment">
            <option value="left">Left</option>
            <option value="center">Center</option>
            <option value="right">Right</option>
          </select>
          <select className="vector-thickness-select" value={activeTextStyle.valign} onChange={(e) => onSetTextValign(e.target.value)} title="Vertical text alignment">
            <option value="top">Top</option>
            <option value="middle">Middle</option>
            <option value="bottom">Bottom</option>
          </select>
        </div>
        <div className="vector-toolbar-group">
          <label className="vector-canvas-bg" title="Canvas background color" style={{ background: canvasBackground }}>
            <input type="color" value={canvasBackground} onChange={(e) => onSetCanvasBackground(e.target.value)} />
          </label>
          <span className="vector-canvas-bg-label">Canvas</span>
          <button className="icon-btn" title="Load a reference image from the vault — placed faded, always behind every layer, for tracing over" onClick={onOpenImagePicker}>
            <IconImage size={15} />
          </button>
        </div>
      </fieldset>
      <div className="vector-toolbar-group">
        <button className={`icon-btn ${layersPanelOpen ? 'active' : ''}`} title="Layers" aria-pressed={layersPanelOpen} onClick={onToggleLayersPanel}>
          <IconLayoutGrid size={15} />
        </button>
        <button className={`icon-btn ${descriptionPanelOpen ? 'active' : ''}`} title="Description" aria-pressed={descriptionPanelOpen} onClick={onToggleDescriptionPanel}>
          <IconStickyNote size={15} />
        </button>
      </div>
      <div className="vector-toolbar-group">
        <button className={`icon-btn ${viewMode ? 'active' : ''}`} title={viewMode ? 'View mode — vertexes and 0px guides are hidden. Click to switch to Edit mode' : 'Edit mode — click to preview in View mode'} aria-pressed={viewMode} onClick={onToggleViewMode}>
          <IconEye size={15} />
        </button>
      </div>
      <div className="vector-toolbar-group">
        <button className="icon-btn" title="Undo" disabled={!canUndo} onClick={onUndo}>
          <IconUndo size={15} />
        </button>
        <button className="icon-btn" title="Redo" disabled={!canRedo} onClick={onRedo}>
          <IconRedo size={15} />
        </button>
      </div>
      <div className="vector-toolbar-group">
        <button className="icon-btn" title="Zoom out" onClick={onZoomOut}>
          <IconZoomOut size={15} />
        </button>
        <button className="vector-zoom-pct" onClick={onZoomReset} title="Reset zoom to 100%">
          {Math.round(zoom * 100)}%
        </button>
        <button className="icon-btn" title="Zoom in" onClick={onZoomIn}>
          <IconZoomIn size={15} />
        </button>
        <button className="icon-btn" title="Zoom to fit" onClick={onFitToContent}>
          <IconMaximize size={15} />
        </button>
        <button className="icon-btn" title="Export as SVG" onClick={onExportSvg}>
          <IconDownload size={15} />
        </button>
      </div>
    </div>
  );
}

export { VectorToolbar };
