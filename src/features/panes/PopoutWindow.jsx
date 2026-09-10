import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

// ---------------------------------------------------------------------------
// Renders `children` into a real, separate browser window (via
// window.open) rather than a DOM node inside the current document — a
// genuine detached window, not a modal or an iframe. Because this is a
// *portal* and not a second React root, the exact same component
// instances, the exact same `handlers`/closures, and the exact same event
// system apply inside it: editing a note here goes through the identical
// onChange -> save-debounce pipeline as any pane in the main window, so
// there's no separate copy of the note's state to keep in sync — see
// PopoutNotePane.jsx for what actually gets rendered into it.
//
// window.open('', ...) starts from a blank about:blank document, so
// there's no CSS to inherit — every stylesheet/style tag from the main
// document is cloned into the new one's <head> once, up front. Anything
// injected into <head> *after* this mount (nothing in this app does today
// — see CLAUDE.md 2, "no CSS-in-JS") would need copying too; extend the
// clone step below rather than diffing on every render if that changes.
// ---------------------------------------------------------------------------
function PopoutWindow({ title, onClose, children }) {
  const [container, setContainer] = useState(null);
  const winRef = useRef(null);

  useEffect(() => {
    const win = window.open('', '_blank', 'width=760,height=860');
    if (!win) {
      // Popup blocked — there's nothing to portal into. Tell the caller so
      // the note doesn't just silently vanish from the pane tree.
      window.alert("Couldn't open a new window — check your browser's popup blocker for this site.");
      onClose();
      return undefined;
    }
    winRef.current = win;

    const doc = win.document;
    doc.title = title;
    // Matches index.html's own <meta> so native form controls (scrollbars,
    // <select>, etc.) render dark-themed instead of the browser default.
    const colorScheme = doc.createElement('meta');
    colorScheme.name = 'color-scheme';
    colorScheme.content = 'dark';
    doc.head.appendChild(colorScheme);

    // Clone every stylesheet/style tag so the popout looks identical —
    // same design tokens, same component CSS, same accent-color override
    // if that's implemented as an injected <style> rather than an inline
    // custom property (the line below covers it either way).
    document.querySelectorAll('link[rel="stylesheet"], style').forEach((node) => {
      doc.head.appendChild(node.cloneNode(true));
    });
    doc.documentElement.setAttribute('style', document.documentElement.getAttribute('style') || '');
    doc.documentElement.className = document.documentElement.className;
    doc.body.className = document.body.className;

    // A bare `<div>` in a blank document has no ambient height, so
    // PopoutNotePane's `height: 100%` would collapse to zero without
    // this — deliberately a plain injected <style>, not something that
    // depends on matching an app class/id it doesn't know the name of.
    const baseStyle = doc.createElement('style');
    baseStyle.textContent = 'html,body{height:100%;margin:0;}#popout-portal-root{height:100%;display:flex;flex-direction:column;}';
    doc.head.appendChild(baseStyle);

    const root = doc.createElement('div');
    root.id = 'popout-portal-root';
    doc.body.appendChild(root);
    setContainer(root);

    // The person closing the popout window (native close button, Cmd+W,
    // the OS window switcher, ...) is the only "close" signal that can
    // come from that side — there's no React unmount to hook otherwise,
    // so poll for it.
    const poll = setInterval(() => {
      if (win.closed) {
        clearInterval(poll);
        onClose();
      }
    }, 500);

    return () => {
      clearInterval(poll);
      if (!win.closed) win.close();
    };
    // Mount-once by design: `onClose`/`title` here only need their
    // first-render identities (onClose closes over a fixed fileId via a
    // functional state update; title is kept in sync separately below).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Keep the window's title bar in sync with the note's own title field —
  // renaming a note while it's popped out shouldn't leave the old name
  // stuck in the window's title/taskbar entry.
  useEffect(() => {
    if (winRef.current && !winRef.current.closed) winRef.current.document.title = title;
  }, [title]);

  if (!container) return null;
  return createPortal(children, container);
}

export { PopoutWindow };
