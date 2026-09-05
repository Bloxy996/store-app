import { IconFile, IconFrame, IconLink2, IconMaximize, IconStickyNote, IconZoomIn, IconZoomOut } from '../../components/icons.jsx';


function CanvasToolbar({ zoom, onZoomIn, onZoomOut, onZoomReset, onFitToContent, onAddText, onAddFile, onAddLink, onAddGroup }) {
  return (
    <div className="canvas-toolbar">
      <div className="canvas-toolbar-group">
        <button className="icon-btn" title="Add text card" onClick={onAddText}>
          <IconStickyNote size={15} />
        </button>
        <button className="icon-btn" title="Embed a store file" onClick={onAddFile}>
          <IconFile size={15} />
        </button>
        <button className="icon-btn" title="Add web link card" onClick={onAddLink}>
          <IconLink2 size={15} />
        </button>
        <button className="icon-btn" title="Add group" onClick={onAddGroup}>
          <IconFrame size={15} />
        </button>
      </div>
      <div className="canvas-toolbar-group">
        <button className="icon-btn" title="Zoom out" onClick={onZoomOut}>
          <IconZoomOut size={15} />
        </button>
        <button className="canvas-zoom-pct" onClick={onZoomReset} title="Reset zoom to 100%">
          {Math.round(zoom * 100)}%
        </button>
        <button className="icon-btn" title="Zoom in" onClick={onZoomIn}>
          <IconZoomIn size={15} />
        </button>
        <button className="icon-btn" title="Zoom to fit" onClick={onFitToContent}>
          <IconMaximize size={15} />
        </button>
      </div>
    </div>
  );
}

export { CanvasToolbar };
