import { useEffect, useLayoutEffect, useState } from 'react';
import { createPortal } from 'react-dom';

import { ACCENT_PRESETS, DEFAULT_ACCENT } from './accentColor.js';


function AccentColorPicker({ accent, onChange, onClose, anchorRef, pickerRef }) {
  const [pos, setPos] = useState(null);
  useLayoutEffect(() => {
    const anchor = anchorRef?.current;
    if (!anchor) return;
    const rect = anchor.getBoundingClientRect();
    setPos({ left: rect.left, bottom: window.innerHeight - rect.top + 8 });
  }, [anchorRef]);
  useEffect(() => {
    const onKeyDown = (e) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [onClose]);
  // Portaled to <body> with fixed positioning computed from the anchor's
  // rect — this is what keeps it drawn in front of an open note's editor
  // pane (which otherwise clips an absolutely-positioned popover via its
  // own stacking context) instead of relying on ever-larger z-index values
  // inside that pane's tree.
  if (!pos) return null;
  return createPortal(
    <div
      ref={pickerRef}
      className="accent-picker accent-picker-portal"
      style={{ left: pos.left, bottom: pos.bottom }}
      onClick={(e) => e.stopPropagation()}
    >
      <div className="accent-picker-title">Accent color</div>
      <div className="accent-picker-swatches">
        {ACCENT_PRESETS.map((hex) => (
          <button
            key={hex}
            className={`accent-swatch ${accent.toLowerCase() === hex.toLowerCase() ? 'active' : ''}`}
            style={{ background: hex }}
            title={hex}
            aria-label={`Use accent color ${hex}`}
            onClick={() => onChange(hex)}
          />
        ))}
      </div>
      <label className="accent-picker-custom">
        Custom
        <input type="color" value={accent} onChange={(e) => onChange(e.target.value)} />
      </label>
      {accent !== DEFAULT_ACCENT && (
        <button className="accent-picker-reset" onClick={() => onChange(DEFAULT_ACCENT)}>
          Reset to default
        </button>
      )}
    </div>,
    document.body
  );
}

export { AccentColorPicker };
