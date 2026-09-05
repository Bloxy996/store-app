import { useEffect, useState } from 'react';

import { IconDrive, IconFolder } from '../../components/icons.jsx';
import { driveBrowseFolders, driveResolveFolder } from '../../lib/driveApi.js';


// ---------------------------------------------------------------------------
// UI: onboarding — sign in, pick a vault folder, wait for the first sync.
//
// This used to be four separate components (LoginScreen / FolderPrompt /
// ProxyFolderPicker-as-modal / VaultLoadingScreen), each swapping in as a
// full "page" with its own icon, and the proxy folder browser popping up as
// a dark modal on top of FolderPrompt. It's now one shell (OnboardingFlow)
// that stays mounted across steps and just swaps its inner content, so
// picking a folder over the Apps Script proxy reads as the next step of the
// same page rather than a dialog stacked on another page.
// ---------------------------------------------------------------------------

// The folder-browsing UI for proxy mode (no OAuth token to hand the native
// Google Picker, so this browses via the Apps Script proxy's "browse"
// action instead). Used two places: inline as an onboarding step here, and
// as a modal later for "change vault folder" from within an open vault —
// `variant` controls which chrome wraps it.
function ProxyFolderBrowser({ token, onPick, onCancel, variant = 'inline' }) {
  const [stack, setStack] = useState([{ id: 'root', name: 'Drives' }]);
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [manualInput, setManualInput] = useState('');
  const [resolving, setResolving] = useState(false);
  const [resolveError, setResolveError] = useState('');
  const current = stack[stack.length - 1];

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    driveBrowseFolders(token, current.id).then((folders) => {
      if (!cancelled) {
        setItems(folders);
        setLoading(false);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [token, current.id]);

  const handleUseManualId = async () => {
    if (!manualInput.trim()) return;
    setResolving(true);
    setResolveError('');
    try {
      const meta = await driveResolveFolder(token, manualInput);
      onPick(meta);
    } catch (err) {
      setResolveError(err.message || 'Could not access that folder');
    } finally {
      setResolving(false);
    }
  };

  const content = (
    <>
      {variant === 'modal' && <h3>Select store folder</h3>}
      <div className="breadcrumb">
        {stack.map((s, i) => (
          <span key={s.id}>
            <button className="link-btn" onClick={() => setStack(stack.slice(0, i + 1))}>
              {s.name}
            </button>
            {i < stack.length - 1 ? ' / ' : ''}
          </span>
        ))}
      </div>
      {loading ? (
        <p className="muted">Loading…</p>
      ) : (
        <ul className="folder-list">
          {items.length === 0 && <li className="muted">No subfolders here</li>}
          {items.map((f) => (
            <li key={f.id}>
              <button className="link-btn" onClick={() => setStack([...stack, f])}>
                {f.isDrive ? <IconDrive size={14} /> : <IconFolder size={14} />}
                {f.name}
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className="manual-folder-entry">
        <p className="muted small">
          Folder not showing up (e.g. under "Computers")? Paste its link or ID instead:
        </p>
        <div className="manual-folder-row">
          <input
            type="text"
            placeholder="Drive folder link or ID"
            value={manualInput}
            onChange={(e) => setManualInput(e.target.value)}
          />
          <button className="btn btn-neutral" disabled={!manualInput.trim() || resolving} onClick={handleUseManualId}>
            {resolving ? 'Checking…' : 'Use'}
          </button>
        </div>
        {resolveError && <p className="error-text">{resolveError}</p>}
      </div>
      <div className="modal-actions">
        {onCancel && (
          <button className="btn" onClick={onCancel}>
            Cancel
          </button>
        )}
        <button className="btn btn-neutral" onClick={() => onPick(current)}>
          Use "{current.name}"
        </button>
      </div>
    </>
  );

  if (variant === 'modal') {
    return (
      <div className="modal-overlay">
        <div className="modal">{content}</div>
      </div>
    );
  }
  return <div className="inline-folder-browser">{content}</div>;
}

export { ProxyFolderBrowser };
