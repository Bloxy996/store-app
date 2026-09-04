import React, { useRef } from 'react';

import { ResizeHandle } from '../../components/ResizeHandle.jsx';
import { EditorContent } from '../editor/EditorContent.jsx';
import { PaneHeader, TabBar } from './TabBar.jsx';
import { equalSizes } from '../../lib/paneTree.js';


function PaneNode({ node, ...paneProps }) {
  const containerRef = useRef(null);
  if (node.type === 'split') {
    return (
      <div className={`pane-split pane-split-${node.direction}`} ref={containerRef}>
        {node.children.map((child, i) => (
          <React.Fragment key={child.id}>
            <div className="pane-split-cell" style={{ flexBasis: `${node.sizes[i]}%` }}>
              <PaneNode node={child} {...paneProps} />
            </div>
            {i < node.children.length - 1 && (
              <ResizeHandle
                direction={node.direction}
                onResize={(deltaPx) => paneProps.onResizeSplit(node.id, i, deltaPx, containerRef)}
              />
            )}
          </React.Fragment>
        ))}
      </div>
    );
  }
  return <LeafPane leaf={node} {...paneProps} />;
}


function findSplitNode(node, splitId) {
  if (node.type === 'leaf') return null;
  if (node.id === splitId) return node;
  for (const c of node.children) {
    const found = findSplitNode(c, splitId);
    if (found) return found;
  }
  return null;
}


function purgeFileFromTree(node, fileId) {
  if (node.type === 'leaf') {
    const tabs = node.tabs.filter((t) => t.fileId !== fileId);
    let activeTabId = node.activeTabId;
    if (!tabs.find((t) => t.id === activeTabId)) activeTabId = tabs[0]?.id || null;
    return { ...node, tabs, activeTabId };
  }
  return { ...node, children: node.children.map((c) => purgeFileFromTree(c, fileId)) };
}


function collapseEmptyLeaves(node) {
  if (node.type === 'leaf') return node;
  const children = node.children.map(collapseEmptyLeaves).filter((c) => !(c.type === 'leaf' && c.tabs.length === 0));
  if (children.length === 0) return null;
  if (children.length === 1) return children[0];
  return { ...node, children, sizes: equalSizes(children.length) };
}


function LeafPane({
  leaf,
  filesById,
  linkIndex,
  phantomRecords,
  buffers,
  activePaneId,
  onFocusPane,
  onSelectTab,
  onCloseTab,
  onNewTab,
  onSplitTab,
  onCloseOthers,
  onCloseAll,
  onSplit,
  onClosePane,
  canClosePane,
  onBack,
  onForward,
  onToggleMode,
  onChange,
  handlers,
  backlinkIndex,
  allFiles,
  getBody,
  bookmarks,
  onToggleBookmark,
  onToggleDock
}) {
  const activeTab = leaf.tabs.find((t) => t.id === leaf.activeTabId) || null;
  const file = activeTab ? filesById.get(activeTab.fileId) : null;
  const buf = activeTab ? buffers[activeTab.fileId] : null;
  const isActivePane = leaf.id === activePaneId;

  return (
    <div className={`pane-leaf ${isActivePane ? 'active' : ''}`} onMouseDown={() => onFocusPane(leaf.id)}>
      <TabBar
        leaf={leaf}
        filesById={filesById}
        buffers={buffers}
        isActivePane={isActivePane}
        onSelectTab={(tabId) => onSelectTab(leaf.id, tabId)}
        onCloseTab={(tabId) => onCloseTab(leaf.id, tabId)}
        onNewTab={() => onNewTab(leaf.id)}
        onSplitTab={(tabId, direction) => onSplitTab(leaf.id, tabId, direction)}
        onCloseOthers={(tabId) => onCloseOthers(leaf.id, tabId)}
        onCloseAll={() => onCloseAll(leaf.id)}
      />
      <PaneHeader
        leaf={leaf}
        activeTab={activeTab}
        file={file}
        linkIndex={linkIndex}
        onBack={() => onBack(leaf.id)}
        onForward={() => onForward(leaf.id)}
        onToggleMode={() => activeTab && onToggleMode(leaf.id, activeTab.id)}
        onSplit={(direction) => onSplit(leaf.id, direction)}
        onClosePane={() => onClosePane(leaf.id)}
        canClosePane={canClosePane}
        isBookmarked={file ? bookmarks.has(file.id) : false}
        onToggleBookmark={() => file && onToggleBookmark(file.id)}
        onToggleDock={onToggleDock}
      />
      <div className="pane-content">
        <EditorContent
          key={file ? file.id : 'empty'}
          file={file}
          content={buf ? buf.content : ''}
          onChange={(value) => activeTab && onChange(activeTab.fileId, value)}
          linkIndex={linkIndex}
          phantomRecords={phantomRecords}
          handlers={handlers}
          mode={activeTab?.mode || 'edit'}
          loadingNote={buf?.loading}
          backlinkIndex={backlinkIndex}
          allFiles={allFiles}
          getBody={getBody}
          isActivePane={isActivePane}
        />
      </div>
    </div>
  );
}

export { PaneNode, findSplitNode, purgeFileFromTree, collapseEmptyLeaves, LeafPane };
