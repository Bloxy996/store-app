import { extensionForKind } from './vaultConfig.js';

// Pure live-rule resolver: roots are the only persisted choice; descendants
// are recalculated from the current tree, never copied onto child records.
function resolveOfflineIds(offlineRoots, foldersMeta, filesMeta, vaultRootId) {
  const foldersByParent = new Map();
  foldersMeta.forEach((folder) => (folder.parents || [vaultRootId]).forEach((parent) => {
    const children = foldersByParent.get(parent) || [];
    children.push(folder.id); foldersByParent.set(parent, children);
  }));
  const offlineFolderIds = new Set();
  (offlineRoots || []).filter((root) => root.type === 'folder' && (root.id === vaultRootId || foldersMeta.some((f) => f.id === root.id))).forEach((root) => {
    const queue = [root.id];
    while (queue.length) {
      const id = queue.shift();
      if (offlineFolderIds.has(id)) continue;
      offlineFolderIds.add(id);
      queue.push(...(foldersByParent.get(id) || []));
    }
  });
  const offlineFileIds = new Set((offlineRoots || []).filter((root) => root.type === 'file' && filesMeta.some((f) => f.id === root.id)).map((root) => root.id));
  filesMeta.forEach((file) => {
    if ((file.parents || [vaultRootId]).some((parent) => offlineFolderIds.has(parent))) offlineFileIds.add(file.id);
  });
  return { offlineFileIds, offlineFolderIds };
}

function buildConflictCopyName(originalName, kind) {
  const extension = extensionForKind(kind);
  const base = (originalName || 'Untitled').replace(/\.[^.]+$/, '');
  return `${base} (offline copy — ${new Date().toLocaleString()}).${extension}`;
}
export { resolveOfflineIds, buildConflictCopyName };
