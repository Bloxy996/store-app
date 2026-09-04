import React from 'react';

import { IconCommand, IconFilePlus, IconFolder, IconGraph, IconListTree, IconLoader, IconLogOut, IconRefresh, IconSearch, IconStar, IconTag } from './icons.jsx';


// ---------------------------------------------------------------------------
// Activity bar — the thin left-most icon ribbon, mirroring Obsidian's icon
// strip. Switches which panel the side dock shows.
// ---------------------------------------------------------------------------
const ActivityBar = React.memo(function ActivityBar({ activeView, onSetView, onOpenGraph, onOpenCommandPalette, onSync, syncing, onChangeFolder, onSignOut, folderName }) {
  const item = (view, Icon, label, extra) => (
    <button
      className={`activity-btn ${activeView === view ? 'active' : ''}`}
      onClick={() => onSetView(view)}
      title={label}
      aria-label={label}
    >
      <Icon size={19} />
      {extra}
    </button>
  );
  return (
    <div className="activity-bar">
      <div className="activity-bar-top">
        {item('explorer', IconFilePlus, 'Files')}
        {item('search', IconSearch, 'Search')}
        {item('toc', IconListTree, 'Outline')}
        {item('tags', IconTag, 'Tags')}
        {item('bookmarks', IconStar, 'Bookmarks')}
        <button className="activity-btn" onClick={onOpenGraph} title="Graph view" aria-label="Graph view">
          <IconGraph size={19} />
        </button>
      </div>
      <div className="activity-bar-bottom">
        <button className="activity-btn" onClick={onOpenCommandPalette} title="Command palette (⌘K)">
          <IconCommand size={18} />
        </button>
        <button className="activity-btn" onClick={onSync} title="Sync vault" disabled={syncing}>
          {syncing ? <IconLoader size={18} /> : <IconRefresh size={18} />}
        </button>
        <button className="activity-btn" onClick={onChangeFolder} title={`Vault: ${folderName || ''} — change folder`}>
          <IconFolder size={18} />
        </button>
        <button className="activity-btn" onClick={onSignOut} title="Sign out">
          <IconLogOut size={18} />
        </button>
      </div>
    </div>
  );
});

export { ActivityBar };
