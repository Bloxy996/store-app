import React, { useRef, useState } from 'react';

import { ASSET_KIND_ICONS, IconCanvasKind, IconChevronDown, IconChevronRight, IconDatabase, IconEdit, IconFilePlus, IconFolderPlus, IconMoreVertical, IconPlus, IconStar, IconStarFilled, IconTrash, IconUpload } from '../../components/icons.jsx';
import { useClickOutside } from '../../hooks/useClickOutside.js';
import { opensInEditorPane } from '../../lib/vaultConfig.js';


// ---------------------------------------------------------------------------
// File explorer — tree view, drag-and-drop reorganization, and the merged
// "add item" menu (New note / New folder / Upload files) that replaces
// the old separate +note / +folder buttons.
//
// Both the header's "add" menu and each row's "..." menu used to be a
// portaled `DropdownMenu`. Neither has the horizontal-scroll clipping
// problem the tab bar / database view-tabs had, but they're still popups,
// so both are now inline: the add menu opens a panel below the whole
// header row (outside `.side-panel-body`'s scroll area, so it's never
// clipped), and each row's menu opens a small panel directly below that
// one row, as a plain sibling in the vertical tree list — the tree already
// scrolls vertically and already varies row-to-row (folders show children
// below them), so one row temporarily growing to show its own menu is a
// harmless extension of that, not a new layout hazard. Deliberately NOT a
// single shared panel like `DbViewPanel`/`TabBar`'s tab menu: those anchor
// to one fixed-position row, but a file tree can have hundreds of rows at
// arbitrary scroll positions, so a global "one panel, moved to wherever
// was last clicked" would have to either float (a popup again) or yank
// the scroll position around. A per-row local toggle avoids both.
// ---------------------------------------------------------------------------
const DND_MIME = 'application/x-vault-node';


function AddMenuButton({ active, onToggle }) {
  return (
    <button className={`icon-btn ${active ? 'active' : ''}`} onClick={onToggle} title="New note, canvas, database, folder, or upload" aria-label="Add">
      <IconPlus size={16} />
    </button>
  );
}


// Rendered by ExplorerPanel as a full-width block below the whole header
// row — not anchored under the button itself — so it pushes the tree down
// in normal flow instead of floating over it, matching the DbViewPanel /
// TabBar-menu-panel convention established for other former popups.
function AddMenuPanel({ onNewNote, onNewDatabase, onNewCanvas, onNewFolder, onUploadFiles, canUpload, onClose }) {
  const fileInputRef = useRef(null);
  const run = (fn) => {
    fn();
    onClose();
  };
  return (
    <div className="add-menu-panel-inline">
      <button className="menu-item" onClick={() => run(onNewNote)}>
        <IconFilePlus size={15} />
        <span>New note</span>
      </button>
      <button className="menu-item" onClick={() => run(onNewCanvas)}>
        <IconCanvasKind size={15} />
        <span>New canvas</span>
      </button>
      <button className="menu-item" onClick={() => run(onNewDatabase)}>
        <IconDatabase size={15} />
        <span>New database</span>
      </button>
      <button className="menu-item" onClick={() => run(onNewFolder)}>
        <IconFolderPlus size={15} />
        <span>New folder</span>
      </button>
      <button
        className="menu-item"
        disabled={!canUpload}
        onClick={() => run(() => (canUpload ? fileInputRef.current?.click() : null))}
      >
        <IconUpload size={15} />
        <span>Upload files{!canUpload ? ' (needs Google sign-in)' : ''}</span>
      </button>
      <input
        ref={fileInputRef}
        type="file"
        multiple
        style={{ display: 'none' }}
        onChange={(e) => {
          if (e.target.files?.length) onUploadFiles(Array.from(e.target.files));
          e.target.value = '';
        }}
      />
    </div>
  );
}


// The inline panel for one row's "..." menu — rendered by TreeNode as a
// sibling directly below that row, never portaled.
function TreeItemMenuPanel({ isFolder, canUpload, onNewNote, onNewDatabase, onNewCanvas, onNewFolder, onUploadFiles, onRename, onToggleBookmark, isBookmarked, onDelete, onClose }) {
  const fileInputRef = useRef(null);
  const run = (fn) => {
    fn();
    onClose();
  };
  return (
    <div className="tree-menu-panel-inline">
      {isFolder && (
        <button className="menu-item" onClick={() => run(onNewNote)}>
          <IconFilePlus size={14} />
          <span>New note</span>
        </button>
      )}
      {isFolder && (
        <button className="menu-item" onClick={() => run(onNewCanvas)}>
          <IconCanvasKind size={14} />
          <span>New canvas</span>
        </button>
      )}
      {isFolder && (
        <button className="menu-item" onClick={() => run(onNewDatabase)}>
          <IconDatabase size={14} />
          <span>New database</span>
        </button>
      )}
      {isFolder && (
        <button className="menu-item" onClick={() => run(onNewFolder)}>
          <IconFolderPlus size={14} />
          <span>New folder</span>
        </button>
      )}
      {isFolder && (
        <button
          className="menu-item"
          disabled={!canUpload}
          onClick={() => run(() => (canUpload ? fileInputRef.current?.click() : null))}
        >
          <IconUpload size={14} />
          <span>Upload files{!canUpload ? ' (needs Google sign-in)' : ''}</span>
        </button>
      )}
      {isFolder && <span className="tree-menu-panel-divider" />}
      {!isFolder && (
        <button className="menu-item" onClick={() => run(onToggleBookmark)}>
          {isBookmarked ? <IconStarFilled size={14} /> : <IconStar size={14} />}
          <span>{isBookmarked ? 'Remove bookmark' : 'Bookmark'}</span>
        </button>
      )}
      <button className="menu-item" onClick={() => run(onRename)}>
        <IconEdit size={14} />
        <span>Rename</span>
      </button>
      <button className="menu-item danger" onClick={() => run(onDelete)}>
        <IconTrash size={14} />
        <span>Delete</span>
      </button>
      {isFolder && (
        <input
          ref={fileInputRef}
          type="file"
          multiple
          style={{ display: 'none' }}
          onChange={(e) => {
            if (e.target.files?.length) onUploadFiles(Array.from(e.target.files));
            e.target.value = '';
          }}
        />
      )}
    </div>
  );
}


// Memoized so that expanding/collapsing one folder, or a state change
// elsewhere in the app, doesn't re-render every row in a large vault's tree.
// The recursive self-reference below uses the outer `TreeNode` (the memoized
// wrapper) rather than the inner `TreeNodeImpl` name, so nested rows get the
// same memoization benefit as top-level ones — a named function expression
// would otherwise shadow itself and let recursive calls skip the memo.
const TreeNode = React.memo(function TreeNodeImpl({
  node,
  depth,
  currentIds,
  expanded,
  onToggleExpand,
  onOpenFile,
  onOpenImage,
  onCreateNote,
  onCreateDatabase,
  onCreateCanvas,
  onCreateFolder,
  onUploadFiles,
  onRename,
  onDelete,
  onMoveNode,
  canUpload,
  bookmarks,
  onToggleBookmark,
  dragState,
  setDragState
}) {
  const indent = { paddingLeft: 6 + depth * 16 };
  const isDragOver = dragState.overId === node.id;
  const [menuOpen, setMenuOpen] = useState(false);
  const rowWrapRef = useRef(null);
  useClickOutside([rowWrapRef], () => setMenuOpen(false));

  const handleDragStart = (e) => {
    e.stopPropagation();
    e.dataTransfer.setData(DND_MIME, JSON.stringify({ id: node.id, type: node.type }));
    e.dataTransfer.effectAllowed = 'move';
    setDragState({ draggingId: node.id, overId: null });
  };
  const handleDragEnd = () => setDragState({ draggingId: null, overId: null });

  if (node.type === 'file') {
    const isAsset = !opensInEditorPane(node.kind);
    const isBookmarked = bookmarks.has(node.id);
    const AssetIcon = ASSET_KIND_ICONS[node.kind] || null;
    return (
      <div ref={rowWrapRef}>
        <div className={`tree-row ${isDragOver ? 'drag-over' : ''}`}>
          <button
            className={`tree-item tree-file ${currentIds.has(node.id) ? 'active' : ''}`}
            style={indent}
            draggable
            onDragStart={handleDragStart}
            onDragEnd={handleDragEnd}
            onClick={(e) => (isAsset ? onOpenImage(node, e) : onOpenFile(node.id, e))}
          >
            {isBookmarked && <IconStarFilled className="bookmark-dot" size={11} />}
            {AssetIcon && <AssetIcon className="tree-kind-icon" size={13} />}
            <span className="tree-label">{isAsset ? node.name : node.name.replace(/\.[^.]+$/i, '')}</span>
          </button>
          <button
            className={`tree-menu-btn ${menuOpen ? 'active' : ''}`}
            onClick={(e) => {
              e.stopPropagation();
              setMenuOpen((v) => !v);
            }}
            aria-label="More actions"
          >
            <IconMoreVertical size={14} />
          </button>
        </div>
        {menuOpen && (
          <TreeItemMenuPanel
            isFolder={false}
            isBookmarked={isBookmarked}
            onToggleBookmark={() => onToggleBookmark(node.id)}
            onRename={() => onRename(node)}
            onDelete={() => onDelete(node)}
            onClose={() => setMenuOpen(false)}
          />
        )}
      </div>
    );
  }

  const isOpen = expanded.has(node.id);
  return (
    <div ref={rowWrapRef}>
      <div
        className={`tree-row ${isDragOver ? 'drag-over' : ''}`}
        onDragOver={(e) => {
          e.preventDefault();
          e.dataTransfer.dropEffect = 'move';
          if (dragState.overId !== node.id) setDragState((s) => ({ ...s, overId: node.id }));
        }}
        onDragLeave={() => setDragState((s) => (s.overId === node.id ? { ...s, overId: null } : s))}
        onDrop={(e) => {
          e.preventDefault();
          setDragState({ draggingId: null, overId: null });
          const raw = e.dataTransfer.getData(DND_MIME);
          if (!raw) return;
          const dragged = JSON.parse(raw);
          if (dragged.id !== node.id) onMoveNode(dragged.id, dragged.type, node.id);
        }}
      >
        <button
          className="tree-item tree-folder"
          style={indent}
          draggable
          onDragStart={handleDragStart}
          onDragEnd={handleDragEnd}
          onClick={() => onToggleExpand(node.id)}
        >
          <span className="tree-caret">{isOpen ? <IconChevronDown size={13} /> : <IconChevronRight size={13} />}</span>
          <span className="tree-label">{node.name}</span>
        </button>
        <button
          className={`tree-menu-btn ${menuOpen ? 'active' : ''}`}
          onClick={(e) => {
            e.stopPropagation();
            setMenuOpen((v) => !v);
          }}
          aria-label="More actions"
        >
          <IconMoreVertical size={14} />
        </button>
      </div>
      {menuOpen && (
        <TreeItemMenuPanel
          isFolder
          canUpload={canUpload}
          onNewNote={() => onCreateNote(node.id)}
          onNewDatabase={() => onCreateDatabase(node.id)}
          onNewCanvas={() => onCreateCanvas(node.id)}
          onNewFolder={() => onCreateFolder(node.id)}
          onUploadFiles={(files) => onUploadFiles(node.id, files)}
          onRename={() => onRename(node)}
          onDelete={() => onDelete(node)}
          onClose={() => setMenuOpen(false)}
        />
      )}
      {isOpen &&
        node.children.map((child) => (
          <TreeNode
            key={child.id}
            node={child}
            depth={depth + 1}
            currentIds={currentIds}
            expanded={expanded}
            onToggleExpand={onToggleExpand}
            onOpenFile={onOpenFile}
            onOpenImage={onOpenImage}
            onCreateNote={onCreateNote}
            onCreateDatabase={onCreateDatabase}
            onCreateCanvas={onCreateCanvas}
            onCreateFolder={onCreateFolder}
            onUploadFiles={onUploadFiles}
            onRename={onRename}
            onDelete={onDelete}
            onMoveNode={onMoveNode}
            canUpload={canUpload}
            bookmarks={bookmarks}
            onToggleBookmark={onToggleBookmark}
            dragState={dragState}
            setDragState={setDragState}
          />
        ))}
    </div>
  );
});


function collectAllFolderIds(tree) {
  const ids = [];
  const walk = (nodes) =>
    nodes.forEach((n) => {
      if (n.type === 'folder') {
        ids.push(n.id);
        walk(n.children);
      }
    });
  walk(tree);
  return ids;
}


const ExplorerPanel = React.memo(function ExplorerPanel({
  tree,
  vaultRootId,
  currentIds,
  onOpenFile,
  onOpenImage,
  onCreateNote,
  onCreateDatabase,
  onCreateCanvas,
  onCreateFolder,
  onUploadFiles,
  onRename,
  onDelete,
  onMoveNode,
  canUpload,
  bookmarks,
  onToggleBookmark
}) {
  const [expanded, setExpanded] = useState(new Set());
  const [dragState, setDragState] = useState({ draggingId: null, overId: null });
  const [addMenuOpen, setAddMenuOpen] = useState(false);
  const headerWrapRef = useRef(null);
  useClickOutside([headerWrapRef], () => setAddMenuOpen(false));
  const toggleExpand = (id) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  const collapseAll = () => setExpanded(new Set());
  const expandAll = () => setExpanded(new Set(collectAllFolderIds(tree)));

  return (
    <div className="side-panel">
      <div ref={headerWrapRef}>
        <div className="side-panel-header">
          <span className="side-panel-title">Files</span>
          <div className="side-panel-actions">
            <AddMenuButton active={addMenuOpen} onToggle={() => setAddMenuOpen((v) => !v)} />
            <button className="icon-btn" title="Expand all" onClick={expandAll}>
              <IconChevronDown size={15} />
            </button>
            <button className="icon-btn" title="Collapse all" onClick={collapseAll}>
              <IconChevronRight size={15} />
            </button>
          </div>
        </div>
        {addMenuOpen && (
          <AddMenuPanel
            onNewNote={() => onCreateNote(vaultRootId)}
            onNewDatabase={() => onCreateDatabase(vaultRootId)}
            onNewCanvas={() => onCreateCanvas(vaultRootId)}
            onNewFolder={() => onCreateFolder(vaultRootId)}
            onUploadFiles={(files) => onUploadFiles(vaultRootId, files)}
            canUpload={canUpload}
            onClose={() => setAddMenuOpen(false)}
          />
        )}
      </div>
      <div
        className="side-panel-body file-tree"
        onDragOver={(e) => {
          e.preventDefault();
          if (dragState.overId !== vaultRootId) setDragState((s) => ({ ...s, overId: vaultRootId }));
        }}
        onDrop={(e) => {
          if (e.target !== e.currentTarget) return;
          e.preventDefault();
          setDragState({ draggingId: null, overId: null });
          const raw = e.dataTransfer.getData(DND_MIME);
          if (!raw) return;
          const dragged = JSON.parse(raw);
          onMoveNode(dragged.id, dragged.type, vaultRootId);
        }}
      >
        {tree.map((node) => (
          <TreeNode
            key={node.id}
            node={node}
            depth={0}
            currentIds={currentIds}
            expanded={expanded}
            onToggleExpand={toggleExpand}
            onOpenFile={onOpenFile}
            onOpenImage={onOpenImage}
            onCreateNote={onCreateNote}
            onCreateDatabase={onCreateDatabase}
            onCreateCanvas={onCreateCanvas}
            onCreateFolder={onCreateFolder}
            onUploadFiles={onUploadFiles}
            onRename={onRename}
            onDelete={onDelete}
            onMoveNode={onMoveNode}
            canUpload={canUpload}
            bookmarks={bookmarks}
            onToggleBookmark={onToggleBookmark}
            dragState={dragState}
            setDragState={setDragState}
          />
        ))}
        {tree.length === 0 && <p className="muted small empty-hint">Empty store — use + to add a note.</p>}
        <div className={`root-drop-zone ${dragState.overId === vaultRootId ? 'drag-over' : ''}`} />
      </div>
    </div>
  );
});

export { DND_MIME, AddMenuButton, AddMenuPanel, TreeItemMenuPanel, TreeNode, collectAllFolderIds, ExplorerPanel };
