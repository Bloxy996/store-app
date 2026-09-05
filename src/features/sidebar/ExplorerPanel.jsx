import React, { useRef, useState } from 'react';

import { DropdownMenu, MenuDivider, MenuItem } from '../../components/DropdownMenu.jsx';
import { ASSET_KIND_ICONS, IconCanvasKind, IconChevronDown, IconChevronRight, IconDatabase, IconEdit, IconFilePlus, IconFolderPlus, IconMoreVertical, IconPlus, IconStar, IconStarFilled, IconTrash, IconUpload } from '../../components/icons.jsx';
import { opensInEditorPane } from '../../lib/vaultConfig.js';


// ---------------------------------------------------------------------------
// File explorer — tree view, drag-and-drop reorganization, and the merged
// "add item" dropdown (New note / New folder / Upload files) that replaces
// the old separate +note / +folder buttons.
// ---------------------------------------------------------------------------
const DND_MIME = 'application/x-vault-node';


function AddMenu({ onNewNote, onNewDatabase, onNewCanvas, onNewFolder, onUploadFiles, canUpload, align = 'left' }) {
  const fileInputRef = useRef(null);
  return (
    <DropdownMenu
      align={align}
      trigger={(toggle) => (
        <button className="icon-btn" onClick={toggle} title="New note, canvas, database, folder, or upload" aria-label="Add">
          <IconPlus size={16} />
        </button>
      )}
    >
      <MenuItem icon={<IconFilePlus size={15} />} onClick={onNewNote}>
        New note
      </MenuItem>
      <MenuItem icon={<IconCanvasKind size={15} />} onClick={onNewCanvas}>
        New canvas
      </MenuItem>
      <MenuItem icon={<IconDatabase size={15} />} onClick={onNewDatabase}>
        New database
      </MenuItem>
      <MenuItem icon={<IconFolderPlus size={15} />} onClick={onNewFolder}>
        New folder
      </MenuItem>
      <MenuItem
        icon={<IconUpload size={15} />}
        disabled={!canUpload}
        onClick={() => (canUpload ? fileInputRef.current?.click() : null)}
      >
        Upload files{!canUpload ? ' (needs Google sign-in)' : ''}
      </MenuItem>
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
    </DropdownMenu>
  );
}


function TreeItemMenu({ isFolder, canUpload, onNewNote, onNewDatabase, onNewCanvas, onNewFolder, onUploadFiles, onRename, onToggleBookmark, isBookmarked, onDelete }) {
  const fileInputRef = useRef(null);
  return (
    <DropdownMenu
      align="right"
      trigger={(toggle) => (
        <button className="tree-menu-btn" onClick={toggle} aria-label="More actions">
          <IconMoreVertical size={14} />
        </button>
      )}
    >
      {isFolder && (
        <MenuItem icon={<IconFilePlus size={15} />} onClick={onNewNote}>
          New note
        </MenuItem>
      )}
      {isFolder && (
        <MenuItem icon={<IconCanvasKind size={15} />} onClick={onNewCanvas}>
          New canvas
        </MenuItem>
      )}
      {isFolder && (
        <MenuItem icon={<IconDatabase size={15} />} onClick={onNewDatabase}>
          New database
        </MenuItem>
      )}
      {isFolder && (
        <MenuItem icon={<IconFolderPlus size={15} />} onClick={onNewFolder}>
          New folder
        </MenuItem>
      )}
      {isFolder && (
        <MenuItem
          icon={<IconUpload size={15} />}
          disabled={!canUpload}
          onClick={() => (canUpload ? fileInputRef.current?.click() : null)}
        >
          Upload files{!canUpload ? ' (needs Google sign-in)' : ''}
        </MenuItem>
      )}
      {isFolder && <MenuDivider />}
      {!isFolder && (
        <MenuItem icon={isBookmarked ? <IconStarFilled size={15} /> : <IconStar size={15} />} onClick={onToggleBookmark}>
          {isBookmarked ? 'Remove bookmark' : 'Bookmark'}
        </MenuItem>
      )}
      <MenuItem icon={<IconEdit size={15} />} onClick={onRename}>
        Rename
      </MenuItem>
      <MenuItem icon={<IconTrash size={15} />} danger onClick={onDelete}>
        Delete
      </MenuItem>
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
    </DropdownMenu>
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
        <TreeItemMenu
          isFolder={false}
          isBookmarked={isBookmarked}
          onToggleBookmark={() => onToggleBookmark(node.id)}
          onRename={() => onRename(node)}
          onDelete={() => onDelete(node)}
        />
      </div>
    );
  }

  const isOpen = expanded.has(node.id);
  return (
    <div>
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
        <TreeItemMenu
          isFolder
          canUpload={canUpload}
          onNewNote={() => onCreateNote(node.id)}
          onNewDatabase={() => onCreateDatabase(node.id)}
          onNewCanvas={() => onCreateCanvas(node.id)}
          onNewFolder={() => onCreateFolder(node.id)}
          onUploadFiles={(files) => onUploadFiles(node.id, files)}
          onRename={() => onRename(node)}
          onDelete={() => onDelete(node)}
        />
      </div>
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
      <div className="side-panel-header">
        <span className="side-panel-title">Files</span>
        <div className="side-panel-actions">
          <AddMenu
            onNewNote={() => onCreateNote(vaultRootId)}
            onNewDatabase={() => onCreateDatabase(vaultRootId)}
            onNewCanvas={() => onCreateCanvas(vaultRootId)}
            onNewFolder={() => onCreateFolder(vaultRootId)}
            onUploadFiles={(files) => onUploadFiles(vaultRootId, files)}
            canUpload={canUpload}
          />
          <button className="icon-btn" title="Expand all" onClick={expandAll}>
            <IconChevronDown size={15} />
          </button>
          <button className="icon-btn" title="Collapse all" onClick={collapseAll}>
            <IconChevronRight size={15} />
          </button>
        </div>
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

export { DND_MIME, AddMenu, TreeItemMenu, TreeNode, collectAllFolderIds, ExplorerPanel };
