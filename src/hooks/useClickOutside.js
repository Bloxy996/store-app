import { useEffect } from 'react';


// ---------------------------------------------------------------------------
// Generic dropdown menu — trigger button + floating panel, closes on
// outside click or Escape. Backs the merged "add item" button, per-row
// "⋮" menus, and the tab context menu.
// ---------------------------------------------------------------------------
// Accepts either a single ref or an array of refs — a click/touch is only
// "outside" if it falls outside every ref's subtree. Used so a menu rendered
// via portal (outside the trigger's DOM subtree) can still be treated as
// "inside" for the purposes of dismissal.
function useClickOutside(refs, onOutside) {
  useEffect(() => {
    const list = Array.isArray(refs) ? refs : [refs];
    function handler(e) {
      const inside = list.some((r) => r.current && r.current.contains(e.target));
      if (!inside) onOutside();
    }
    document.addEventListener('mousedown', handler);
    document.addEventListener('touchstart', handler);
    return () => {
      document.removeEventListener('mousedown', handler);
      document.removeEventListener('touchstart', handler);
    };
  }, [refs, onOutside]);
}

export { useClickOutside };
