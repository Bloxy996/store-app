import { useRef } from 'react';


// ---------------------------------------------------------------------------
// Recursive pane-tree renderer, with a draggable resize handle between
// each pair of siblings in a split.
// ---------------------------------------------------------------------------
function ResizeHandle({ direction, onResize }) {
  const draggingRef = useRef(false);
  const onMouseDown = (e) => {
    e.preventDefault();
    draggingRef.current = true;
    const move = (ev) => {
      if (!draggingRef.current) return;
      onResize(direction === 'row' ? ev.movementX : ev.movementY);
    };
    const up = () => {
      draggingRef.current = false;
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  };
  return <div className={`resize-handle resize-${direction}`} onMouseDown={onMouseDown} />;
}

export { ResizeHandle };
