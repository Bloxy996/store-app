import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import { colorAlphaParts, withAlpha } from './vectorGeometry.jsx';

// Popup color picker with the opacity slider INSIDE it (the native
// <input type="color"> popup can't host one). Internal HSV is the source of
// truth while open so hue/saturation don't snap to 0 when the color passes
// through black, white, or fully transparent.

function hexToHsv(hex6) {
  const n = parseInt(hex6.slice(1), 16);
  const r = ((n >> 16) & 255) / 255, g = ((n >> 8) & 255) / 255, b = (n & 255) / 255;
  const max = Math.max(r, g, b), d = max - Math.min(r, g, b);
  let h = 0;
  if (d) h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return { h: (h * 60 + 360) % 360, s: max ? d / max : 0, v: max };
}

function hsvToHex({ h, s, v }) {
  const f = (n) => {
    const k = (n + h / 60) % 6;
    return Math.round((v - v * s * Math.max(0, Math.min(k, 4 - k, 1))) * 255).toString(16).padStart(2, '0');
  };
  return `#${f(5)}${f(3)}${f(1)}`;
}

// Drag helper for a 1D/2D track: reports 0..1 coords while the pointer is down.
function useDrag(onMove) {
  const ref = useRef(null);
  const handle = (e) => {
    const r = ref.current.getBoundingClientRect();
    onMove(Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)), Math.max(0, Math.min(1, (e.clientY - r.top) / r.height)));
  };
  return {
    ref,
    onPointerDown: (e) => { e.currentTarget.setPointerCapture(e.pointerId); handle(e); },
    onPointerMove: (e) => { if (e.currentTarget.hasPointerCapture(e.pointerId)) handle(e); }
  };
}

function ColorAlphaPopup({ color, onChange, onClose, anchorRef }) {
  const init = colorAlphaParts(color);
  const [hsv, setHsv] = useState(() => hexToHsv(init.hex6));
  const [alpha, setAlpha] = useState(init.alphaPct);
  const [hexText, setHexText] = useState(null); // non-null only while typing in the hex box
  const [pos, setPos] = useState(null);
  const popRef = useRef(null);

  useLayoutEffect(() => {
    const r = anchorRef.current.getBoundingClientRect();
    setPos({ left: Math.max(8, Math.min(r.left, window.innerWidth - 200)), top: r.bottom + 6 });
  }, [anchorRef]);

  useEffect(() => {
    const onDown = (e) => {
      if (!popRef.current?.contains(e.target) && !anchorRef.current?.contains(e.target)) onClose();
    };
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('pointerdown', onDown);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('pointerdown', onDown); document.removeEventListener('keydown', onKey); };
  }, [onClose, anchorRef]);

  const commit = (nextHsv, nextAlpha) => {
    setHsv(nextHsv);
    setAlpha(nextAlpha);
    onChange(withAlpha(hsvToHex(nextHsv), nextAlpha));
  };

  const sv = useDrag((x, y) => commit({ ...hsv, s: x, v: 1 - y }, alpha));
  const hue = useDrag((x) => commit({ ...hsv, h: x * 360 }, alpha));
  const op = useDrag((x) => commit(hsv, Math.round(x * 100)));
  const hex6 = hsvToHex(hsv);

  if (!pos) return null;
  return createPortal(
    <div ref={popRef} className="vector-color-popup" style={{ left: pos.left, top: pos.top }}>
      <div className="vcp-sv" ref={sv.ref} onPointerDown={sv.onPointerDown} onPointerMove={sv.onPointerMove} style={{ background: `linear-gradient(to top, #000, transparent), linear-gradient(to right, #fff, hsl(${hsv.h} 100% 50%))` }}>
        <span className="vcp-thumb" style={{ left: `${hsv.s * 100}%`, top: `${(1 - hsv.v) * 100}%` }} />
      </div>
      <div className="vcp-track vcp-hue" ref={hue.ref} onPointerDown={hue.onPointerDown} onPointerMove={hue.onPointerMove}>
        <span className="vcp-thumb" style={{ left: `${(hsv.h / 360) * 100}%`, top: '50%' }} />
      </div>
      <div className="vcp-track vcp-alpha" ref={op.ref} onPointerDown={op.onPointerDown} onPointerMove={op.onPointerMove} title="Opacity — drag to 0 for fully transparent">
        <span className="vcp-alpha-fill" style={{ background: `linear-gradient(to right, transparent, ${hex6})` }} />
        <span className="vcp-thumb" style={{ left: `${alpha}%`, top: '50%' }} />
      </div>
      <div className="vcp-row">
        <input
          className="vcp-hex"
          value={hexText ?? hex6}
          spellCheck={false}
          onChange={(e) => {
            setHexText(e.target.value);
            if (/^#[0-9a-f]{6}$/i.test(e.target.value)) commit(hexToHsv(e.target.value), alpha);
          }}
          onBlur={() => setHexText(null)}
        />
        <input
          className="vcp-pct"
          type="number"
          min={0}
          max={100}
          value={alpha}
          title="Opacity %"
          onChange={(e) => commit(hsv, Math.max(0, Math.min(100, Number(e.target.value) || 0)))}
        />
        <span className="vcp-unit">%</span>
      </div>
    </div>,
    document.body
  );
}

export { ColorAlphaPopup };
