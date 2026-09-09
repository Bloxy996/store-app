import { IconCursorTool, IconDownload, IconEdgeTool, IconEyedropperTool, IconFillTool, IconGrid, IconMaximize, IconPolylineTool, IconRedo, IconUndo, IconVertexTool, IconZoomIn, IconZoomOut } from '../../components/icons.jsx';
import { VECTOR_COLORS, VECTOR_THICKNESSES } from './vectorState.js';


const TOOLS = [
  { id: 'select', label: 'Select (V)', Icon: IconCursorTool },
  { id: 'vertex', label: 'Vertex — click to place, click an edge to subdivide it (P)', Icon: IconVertexTool },
  { id: 'edge', label: 'Edge — click two vertices in turn (E)', Icon: IconEdgeTool },
  { id: 'polyline', label: 'Polyline — click to chain vertices, click the start point or press Enter/Escape to finish (L)', Icon: IconPolylineTool },
  { id: 'eyedropper', label: 'Eyedropper — sample an edge or fill\u2019s color (I)', Icon: IconEyedropperTool },
  { id: 'fill', label: 'Flood fill — click an enclosed region; click a filled region again to recolor it (F)', Icon: IconFillTool }
];


function VectorToolbar({
  tool,
  onSetTool,
  activeStyle,
  onSetColor,
  onSetThickness,
  canvasBackground,
  onSetCanvasBackground,
  axisSnapEnabled,
  onToggleAxisSnap,
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
            title="Edge color for the next edge you draw"
            onClick={() => onSetColor(c)}
          />
        ))}
        <label className="vector-color-custom" title="Custom edge color" style={{ background: activeStyle.color }}>
          <input type="color" value={activeStyle.color} onChange={(e) => onSetColor(e.target.value)} />
        </label>
        <select
          className="vector-thickness-select"
          value={activeStyle.thickness}
          onChange={(e) => onSetThickness(Number(e.target.value))}
          title="Edge stroke thickness for the next edge you draw"
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
        <label className="vector-canvas-bg" title="Canvas background color" style={{ background: canvasBackground }}>
          <input type="color" value={canvasBackground} onChange={(e) => onSetCanvasBackground(e.target.value)} />
        </label>
        <span className="vector-canvas-bg-label">Canvas</span>
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
