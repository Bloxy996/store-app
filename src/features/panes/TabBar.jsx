import { history } from '@codemirror/commands';

import { DropdownMenu, MenuDivider, MenuItem } from '../../components/DropdownMenu.jsx';
import { IconArrowLeft, IconArrowRight, IconEdit, IconEye, IconMoreVertical, IconPanelLeft, IconPlus, IconSplitHorizontal, IconSplitVertical, IconStar, IconStarFilled, IconX } from '../../components/icons.jsx';
import { opensInEditorPane } from '../../lib/vaultConfig.js';


// ---------------------------------------------------------------------------
// Tab bar + pane header (breadcrumb, back/forward, edit/preview toggle,
// split controls) — replaces the old global Split/Edit/Preview buttons.
// Each pane now toggles Edit <-> Preview independently, and "split" means
// an actual second pane rather than a side-by-side textarea/preview.
// ---------------------------------------------------------------------------
function TabBar({ leaf, filesById, buffers, isActivePane, onSelectTab, onCloseTab, onNewTab, onSplitTab, onCloseOthers, onCloseAll }) {
  return (
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
              <DropdownMenu
                className="tab-menu-wrap"
                trigger={(toggle) => (
                  <button
                    className="tab-menu-btn"
                    onClick={(e) => {
                      e.stopPropagation();
                      toggle();
                    }}
                    aria-label="Tab options"
                  >
                    <IconMoreVertical size={12} />
                  </button>
                )}
              >
                <MenuItem icon={<IconSplitVertical size={15} />} onClick={() => onSplitTab(tab.id, 'row')}>
                  Split right
                </MenuItem>
                <MenuItem icon={<IconSplitHorizontal size={15} />} onClick={() => onSplitTab(tab.id, 'column')}>
                  Split down
                </MenuItem>
                <MenuDivider />
                <MenuItem icon={<IconX size={15} />} onClick={() => onCloseOthers(tab.id)}>
                  Close others
                </MenuItem>
                <MenuItem icon={<IconX size={15} />} onClick={onCloseAll}>
                  Close all
                </MenuItem>
              </DropdownMenu>
            </div>
          );
        })}
      </div>
      <button className="tab-new" onClick={onNewTab} title="New tab" aria-label="New tab">
        <IconPlus size={14} />
      </button>
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
