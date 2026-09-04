import React from 'react';

import { ASSET_KIND_ICONS, IconStarFilled, IconX } from '../../components/icons.jsx';
import { opensInEditorPane } from '../../lib/vaultConfig.js';


// ---------------------------------------------------------------------------
// Bookmarks panel — a lightweight take on Obsidian's Bookmarks core plugin.
// ---------------------------------------------------------------------------
const BookmarksPanel = React.memo(function BookmarksPanel({ bookmarks, filesMeta, onOpenFile, onOpenImage, onToggleBookmark }) {
  const items = filesMeta
    .filter((f) => bookmarks.has(f.id))
    .sort((a, b) => a.name.localeCompare(b.name));
  return (
    <div className="side-panel">
      <div className="side-panel-header">
        <span className="side-panel-title">Bookmarks</span>
      </div>
      <div className="side-panel-body">
        {items.length === 0 && <p className="muted small empty-hint">Star a note or image to bookmark it.</p>}
        {items.map((f) => {
          const isAsset = !opensInEditorPane(f.kind);
          const AssetIcon = ASSET_KIND_ICONS[f.kind] || null;
          return (
            <div className="tree-row" key={f.id}>
              <button
                className="tree-item tree-file"
                onClick={() => (isAsset ? onOpenImage(f) : onOpenFile(f.id))}
              >
                <IconStarFilled size={12} className="bookmark-dot" />
                {AssetIcon && <AssetIcon className="tree-kind-icon" size={13} />}
                <span className="tree-label">{isAsset ? f.name : f.name.replace(/\.[^.]+$/i, '')}</span>
              </button>
              <button className="tree-menu-btn" title="Remove bookmark" onClick={() => onToggleBookmark(f.id)}>
                <IconX size={13} />
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
});

export { BookmarksPanel };
