import { useMemo, useState } from 'react';

import { ASSET_KIND_ICONS, IconFile, IconX } from '../../components/icons.jsx';
import { opensInEditorPane } from '../../lib/vaultConfig.js';


// A vault-file search/pick list, reused for "embed a file" — deliberately
// tiny (no fuzzy scoring) since PaletteModal already owns the fuzzy switcher.
function CanvasFilePickerModal({ files, onPick, onClose }) {
  const [q, setQ] = useState('');
  const filtered = useMemo(() => {
    const query = q.trim().toLowerCase();
    const list = query ? files.filter((f) => f.name.toLowerCase().includes(query)) : files;
    return list.slice(0, 200);
  }, [files, q]);
  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal canvas-file-picker" onClick={(e) => e.stopPropagation()}>
        <div className="help-modal-header">
          <h3>Embed a file</h3>
          <button className="icon-btn" onClick={onClose} aria-label="Close">
            <IconX size={16} />
          </button>
        </div>
        <input autoFocus className="canvas-file-picker-input" placeholder="Search store files…" value={q} onChange={(e) => setQ(e.target.value)} />
        <div className="canvas-file-picker-list">
          {filtered.map((f) => {
            const Icon = ASSET_KIND_ICONS[f.kind] || IconFile;
            return (
              <button key={f.id} className="canvas-file-picker-row" onClick={() => onPick(f)}>
                <Icon size={14} />
                <span>{opensInEditorPane(f.kind) ? f.name.replace(/\.[^.]+$/i, '') : f.name}</span>
              </button>
            );
          })}
          {!filtered.length && (
            <div className="muted small" style={{ padding: '10px 12px' }}>
              No files found.
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export { CanvasFilePickerModal };
