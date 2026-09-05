import { history } from '@codemirror/commands';
import { useRef, useState } from 'react';

import { IconArrowLeft, IconArrowRight, IconEdit, IconEye, IconMoreVertical, IconPanelLeft, IconPlus, IconSplitHorizontal, IconSplitVertical, IconStar, IconStarFilled, IconX } from '../../components/icons.jsx';
import { useClickOutside } from '../../hooks/useClickOutside.js';
import { opensInEditorPane } from '../../lib/vaultConfig.js';


// ---------------------------------------------------------------------------
// Tab bar + pane header (breadcrumb, back/forward, edit/preview toggle,
// split controls) — replaces the old global Split/Edit/Preview buttons.
// Each pane now toggles Edit <-> Preview independently, and "split" means
// an actual second pane rather than a side-by-side textarea/preview.
//
// The per-tab "..." menu used to be a `DropdownMenu` (portaled, fixed-
// positioned under the tab). `.tab-bar-scroll` scrolls horizontally
// (`overflow-x: auto`) exactly like `.db-view-tabs` did — a panel anchored
// under one tab would clip as that tab scrolled toward the row's edge, the
// same hazard CLAUDE.md documents for the database view tabs. Same fix:
// one shared inline panel rendered below the whole `.tab-bar` row (outside
// `.tab-bar-scroll`), not portaled. Only one tab's menu can be open at a
// time, tracked here as `menuTabId`.
// ---------------------------------------------------------------------------
function TabBar({ leaf, filesById, buffers, isActivePane, onSelectTab, onCloseTab, onNewTab, onSplitTab, onCloseOthers, onCloseAll }) {
  const [menuTabId, setMenuTabId] = useState(null);
  const wrapRef = useRef(null);
  useClickOutside([wrapRef], () => setMenuTabId(null));

  const menuTab = menuTabId ? leaf.tabs.find((t) => t.id === menuTabId) : null;
  const menuFile = menuTab ? filesById.get(menuTab.fileId) : null;

  return (
    <div ref={wrapRef}>
      <div className={`tab-bar ${isActivePane ? '' : 'inactive'}`}>
        <div className="tab-bar-scroll">
          {leaf.tabs.map((tab) => {
            const file = filesById.get(tab.fileId);
            const buf = buffers[tab.fileId];
            const label = file ? file.name.replace(/\.[^.]+$/i, '') : 'Untitled';
            return (
              <div
                key={tab.id}
                className={`tab ${tab.id === leaf.activeTabId ? 'active' : ''}`}
                onClick={() => onSelectTab(tab.id)}
                onMouseDown={(e) => {
                  if (e.button === 1) {
                    e.preventDefault();
                    onCloseTab(tab.id);
                  }
                }}
              >
                <span className="tab-label">{label}</span>
                {buf?.dirty && <span className="tab-dirty-dot" />}
                <button
                  className="tab-close"
                  onClick={(e) => {
                    e.stopPropagation();
                    onCloseTab(tab.id);
                  }}
                  aria-label="Close tab"
                >
                  <IconX size={12} />
                </button>
                <button
                  className={`tab-menu-btn ${menuTabId === tab.id ? 'active' : ''}`}
                  onClick={(e) => {
                    e.stopPropagation();
                    setMenuTabId((v) => (v === tab.id ? null : tab.id));
                  }}
                  aria-label="Tab options"
                >
                  <IconMoreVertical size={12} />
                </button>
              </div>
            );
          })}
        </div>
        <button className="tab-new" onClick={onNewTab} title="New tab" aria-label="New tab">
          <IconPlus size={14} />
        </button>
      </div>
      {menuTab && (
        <div className="tab-menu-panel-inline">
          <span className="tab-menu-panel-label">{menuFile ? menuFile.name.replace(/\.[^.]+$/i, '') : 'Untitled'}</span>
          <button
            className="tab-menu-panel-item"
            onClick={() => {
              onSplitTab(menuTab.id, 'row');
              setMenuTabId(null);
            }}
          >
            <IconSplitVertical size={14} /> Split right
          </button>
          <button
            className="tab-menu-panel-item"
            onClick={() => {
              onSplitTab(menuTab.id, 'column');
              setMenuTabId(null);
            }}
          >
            <IconSplitHorizontal size={14} /> Split down
          </button>
          <span className="tab-menu-panel-divider" />
          <button
            className="tab-menu-panel-item"
            onClick={() => {
              onCloseOthers(menuTab.id);
              setMenuTabId(null);
            }}
          >
            <IconX size={14} /> Close others
          </button>
          <button
            className="tab-menu-panel-item"
            onClick={() => {
              onCloseAll();
              setMenuTabId(null);
            }}
          >
            <IconX size={14} /> Close all
          </button>
        </div>
      )}
    </div>
  );
}


function Breadcrumb({ file, linkIndex }) {
  if (!file) return <span className="breadcrumb-empty">No file open</span>;
  const rec = linkIndex.records.find((r) => r.id === file.id);
  const dir = rec ? rec.dir : '';
  const label = opensInEditorPane(file.kind) ? file.name.replace(/\.[^.]+$/i, '') : file.name;
  return (
    <span className="pane-breadcrumb">
      {dir && <span className="breadcrumb-dir">{dir.replace(/\//g, ' / ')} / </span>}
      <span className="breadcrumb-name">{label}</span>
    </span>
  );
}


function PaneHeader({
  leaf,
  activeTab,
  file,
  linkIndex,
  onBack,
  onForward,
  onToggleMode,
  onSplit,
  onClosePane,
  canClosePane,
  isBookmarked,
  onToggleBookmark,
  onToggleDock
}) {
  const canBack = activeTab && activeTab.historyIndex > 0;
  const canForward = activeTab && activeTab.historyIndex < activeTab.history.length - 1;
  const mode = activeTab?.mode || 'edit';
  return (
    <div className="pane-header">
      <div className="pane-header-nav">
        <button className="icon-btn mobile-only" onClick={onToggleDock} title="Toggle sidebar" aria-label="Toggle sidebar">
          <IconPanelLeft size={15} />
        </button>
        <button className="icon-btn" disabled={!canBack} onClick={onBack} title="Navigate back">
          <IconArrowLeft size={15} />
        </button>
        <button className="icon-btn" disabled={!canForward} onClick={onForward} title="Navigate forward">
          <IconArrowRight size={15} />
        </button>
        <Breadcrumb file={file} linkIndex={linkIndex} />
      </div>
      <div className="pane-header-actions">
        {file && file.kind === 'note' && (
          <button className="icon-btn" onClick={onToggleBookmark} title={isBookmarked ? 'Remove bookmark' : 'Bookmark note'}>
            {isBookmarked ? <IconStarFilled size={15} /> : <IconStar size={15} />}
          </button>
        )}
        {file && file.kind === 'note' && (
          <button className="icon-btn" onClick={onToggleMode} title={mode === 'edit' ? 'Switch to reading view' : 'Switch to editing view'}>
            {mode === 'edit' ? <IconEye size={15} /> : <IconEdit size={15} />}
          </button>
        )}
        <button className="icon-btn" onClick={() => onSplit('row')} title="Split right">
          <IconSplitVertical size={15} />
        </button>
        <button className="icon-btn" onClick={() => onSplit('column')} title="Split down">
          <IconSplitHorizontal size={15} />
        </button>
        {canClosePane && (
          <button className="icon-btn" onClick={onClosePane} title="Close pane">
            <IconX size={15} />
          </button>
        )}
      </div>
    </div>
  );
}

export { TabBar, Breadcrumb, PaneHeader };
