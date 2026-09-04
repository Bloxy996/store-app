import { history } from '@codemirror/commands';

function uid(prefix) {
  uidCounter += 1;
  return `${prefix}-${Date.now().toString(36)}-${uidCounter}`;
}


function makeTab(fileId, mode = 'edit') {
  return { id: uid('tab'), fileId, mode, history: [fileId], historyIndex: 0 };
}


function makeLeaf(fileId, mode) {
  const tab = makeTab(fileId, mode);
  return { type: 'leaf', id: uid('pane'), tabs: fileId ? [tab] : [], activeTabId: fileId ? tab.id : null };
}


function equalSizes(n) {
  const each = 100 / n;
  return Array.from({ length: n }, () => each);
}


function findLeaf(node, paneId) {
  if (!node) return null;
  if (node.type === 'leaf') return node.id === paneId ? node : null;
  for (const c of node.children) {
    const found = findLeaf(c, paneId);
    if (found) return found;
  }
  return null;
}


function getFirstLeaf(node) {
  if (!node) return null;
  if (node.type === 'leaf') return node;
  return getFirstLeaf(node.children[0]);
}


function collectLeaves(node, out = []) {
  if (!node) return out;
  if (node.type === 'leaf') out.push(node);
  else node.children.forEach((c) => collectLeaves(c, out));
  return out;
}


function updateLeaf(node, paneId, updater) {
  if (node.type === 'leaf') return node.id === paneId ? updater(node) : node;
  return { ...node, children: node.children.map((c) => updateLeaf(c, paneId, updater)) };
}


function updateSplitSizes(node, splitId, sizes) {
  if (node.type === 'leaf') return node;
  if (node.id === splitId) return { ...node, sizes };
  return { ...node, children: node.children.map((c) => updateSplitSizes(c, splitId, sizes)) };
}


function removeLeafFromTree(node, paneId) {
  if (node.type === 'leaf') return node.id === paneId ? null : node;
  const newChildren = node.children.map((c) => removeLeafFromTree(c, paneId)).filter(Boolean);
  if (newChildren.length === 0) return null;
  if (newChildren.length === 1) return newChildren[0];
  return { ...node, children: newChildren, sizes: equalSizes(newChildren.length) };
}


function splitLeafInTree(node, paneId, direction, newLeaf) {
  if (node.type === 'leaf') {
    if (node.id !== paneId) return node;
    return { type: 'split', id: uid('split'), direction, children: [node, newLeaf], sizes: [50, 50] };
  }
  const idx = node.children.findIndex((c) => c.type === 'leaf' && c.id === paneId);
  if (idx !== -1) {
    if (node.direction === direction) {
      const children = node.children.slice();
      children.splice(idx + 1, 0, newLeaf);
      return { ...node, children, sizes: equalSizes(children.length) };
    }
    const children = node.children.slice();
    children[idx] = { type: 'split', id: uid('split'), direction, children: [node.children[idx], newLeaf], sizes: [50, 50] };
    return { ...node, children };
  }
  return { ...node, children: node.children.map((c) => splitLeafInTree(c, paneId, direction, newLeaf)) };
}

export { uid, makeTab, makeLeaf, equalSizes, findLeaf, getFirstLeaf, collectLeaves, updateLeaf, updateSplitSizes, removeLeafFromTree, splitLeafInTree };
