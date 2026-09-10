import { IconCircleTool, IconCursorTool, IconDownload, IconEdgeTool, IconEye, IconEyedropperTool, IconFillTool, IconGrid, IconLayoutGrid, IconMaximize, IconPolylineTool, IconRedo, IconUndo, IconVertexTool, IconZoomIn, IconZoomOut } from '../../components/icons.jsx';
import { VECTOR_COLORS, VECTOR_RADII, VECTOR_THICKNESSES } from './vectorState.js';


const TOOLS = [
  { id: 'select', label: 'Select (V)', Icon: IconCursorTool },
  { id: 'vertex', label: 'Vertex — click to place, click an edge to subdivide it (P)', Icon: IconVertexTool },
  { id: 'edge', label: 'Edge — click two vertices in turn (E)', Icon: IconEdgeTool },
  { id: 'polyline', label: 'Polyline — click to chain vertices, click the start point or press Enter/Escape to finish (L)', Icon: IconPolylineTool },
  { id: 'circle', label: 'Circle — click to place, drag to set radius (C)', Icon: IconCircleTool },
  { id: 'eyedropper', label: 'Eyedropper — sample an edge, fill, or circle\u2019s style (I)', Icon: IconEyedropperTool },
  { id: 'fill', label: 'Flood fill — click an enclosed region; click a filled region again to recolor it (F)', Icon: IconFillTool }
];


function VectorToolbar({
  tool,
  onSetTool,
  activeStyle,
  onSetColor,
  onSetThickness,
  activeRadius,
  onSetRadius,
  circleFill,
  onSetCircleFill,
  canvasBackground,
  onSetCanvasBackground,
  axisSnapEnabled,
  onToggleAxisSnap,
  layersPanelOpen,
  onToggleLayersPanel,
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
}) {
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
          {VECTOR_COLORS.map((c) => (
            <button
              key={c}
              className={`vector-color-swatch ${activeStyle.color === c ? 'active' : ''}`}
              style={{ background: c }}
              title="Edge/outline color for the next edge or circle you draw"
              onClick={() => onSetColor(c)}
            />
          ))}
          <label className="vector-color-custom" title="Custom edge/outline color" style={{ background: activeStyle.color }}>
            <input type="color" value={activeStyle.color} onChange={(e) => onSetColor(e.target.value)} />
          </label>
          <select
            className="vector-thickness-select"
            value={activeStyle.thickness}
            onChange={(e) => onSetThickness(Number(e.target.value))}
            title="Edge/outline weight for the next edge or circle you draw — 0 draws no ink at all, but stays visible/selectable as a dashed guide in Edit mode"
          >
            {VECTOR_THICKNESSES.map((t) => (
              <option key={t} value={t}>
                {t}px
              </option>
            ))}
          </select>
          <button className={`icon-btn ${axisSnapEnabled ? 'active' : ''}`} title={axisSnapEnabled ? 'Axis/alignment snap: on' : 'Axis/alignment snap: off'} aria-pressed={axisSnapEnabled} onClick={onToggleAxisSnap}>
            <IconGrid size={15} />
          </button>
        </div>
        <div className="vector-toolbar-group">
          <select className="vector-thickness-select" value={activeRadius} onChange={(e) => onSetRadius(Number(e.target.value))} title="Radius for the next circle you draw">
            {VECTOR_RADII.map((r) => (
              <option key={r} value={r}>
                r{r}
              </option>
            ))}
          </select>
          <button className={`vector-color-swatch vector-fill-none ${circleFill === 'none' ? 'active' : ''}`} title="No fill" onClick={() => onSetCircleFill('none')} />
          {VECTOR_COLORS.map((c) => (
            <button
              key={c}
              className={`vector-color-swatch ${circleFill === c ? 'active' : ''}`}
              style={{ background: c }}
              title="Circle fill color"
              onClick={() => onSetCircleFill(c)}
            />
          ))}
          <label className="vector-color-custom" title="Custom circle fill color" style={{ background: circleFill === 'none' ? 'transparent' : circleFill }}>
            <input type="color" value={circleFill === 'none' ? '#000000' : circleFill} onChange={(e) => onSetCircleFill(e.target.value)} />
          </label>
        </div>
        <div className="vector-toolbar-group">
          <label className="vector-canvas-bg" title="Canvas background color" style={{ background: canvasBackground }}>
            <input type="color" value={canvasBackground} onChange={(e) => onSetCanvasBackground(e.target.value)} />
          </label>
          <span className="vector-canvas-bg-label">Canvas</span>
        </div>
      </fieldset>
      <div className="vector-toolbar-group">
        <button className={`icon-btn ${layersPanelOpen ? 'active' : ''}`} title="Layers" aria-pressed={layersPanelOpen} onClick={onToggleLayersPanel}>
          <IconLayoutGrid size={15} />
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
