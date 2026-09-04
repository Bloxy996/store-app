import { useCallback, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import { useClickOutside } from '../hooks/useClickOutside.js';


// Dropdown menu whose panel is rendered into a portal at the document root
// and positioned with `position: fixed` from the trigger's live bounding
// rect. Rendering in-place (as a plain absolutely-positioned child) would
// get clipped by any scrolling/overflow ancestor between the trigger and the
// viewport (e.g. the horizontally-scrolling tab bar) — the portal sidesteps
// that entirely, and keeps the menu above every other layer of the UI.
function DropdownMenu({ trigger, children, align = 'left', className = '' }) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState(null);
  const anchorRef = useRef(null);
  const menuRef = useRef(null);
  useClickOutside([anchorRef, menuRef], () => setOpen(false));

  const computePos = useCallback(() => {
    const el = anchorRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    setPos({ top: rect.bottom + 4, left: rect.left, right: window.innerWidth - rect.right });
  }, []);

  useLayoutEffect(() => {
    if (!open) return;
    computePos();
    const onReflow = () => computePos();
    window.addEventListener('resize', onReflow);
    window.addEventListener('scroll', onReflow, true);
    return () => {
      window.removeEventListener('resize', onReflow);
      window.removeEventListener('scroll', onReflow, true);
    };
  }, [open, computePos]);

  const toggle = useCallback(() => setOpen((v) => !v), []);

  return (
    <div className={`dropdown-wrap ${className}`} ref={anchorRef}>
      {trigger(toggle, open)}
      {open &&
        pos &&
        createPortal(
          <div
            ref={menuRef}
            className={`dropdown-menu portal align-${align}`}
            style={align === 'right' ? { top: pos.top, right: pos.right } : { top: pos.top, left: pos.left }}
            onClick={() => setOpen(false)}
          >
            {children}
          </div>,
          document.body
        )}
    </div>
  );
}


function MenuItem({ icon, children, danger, onClick, disabled }) {
  return (
    <button className={`menu-item ${danger ? 'danger' : ''}`} onClick={onClick} disabled={disabled}>
      {icon}
      <span>{children}</span>
    </button>
  );
}


function MenuDivider() {
  return <div className="menu-divider" />;
}

export { DropdownMenu, MenuItem, MenuDivider };
