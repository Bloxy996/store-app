import { useCallback, useEffect, useMemo, useState } from 'react';

import { bumpSearchIndexVersion, noteBodyCache, releaseSearchIndex } from './useVaultIndex.js';
import { mapWithConcurrency, withRetry } from '../lib/concurrency.js';
import { driveGetFileContent, driveListFolderTree, driveListVaultContentInFolders } from '../lib/driveApi.js';
import { idbDeleteMany, idbGetAll, idbPut, idbPutMany } from '../lib/indexedDb.js';
import { buildBacklinkIndex, buildLinkIndex, fuzzyScore } from '../lib/linkGraph.js';
import { parseWikilinks } from '../lib/markdownParse.js';
import { FETCH_CONCURRENCY, STORE_FILES, STORE_FOLDERS, STORE_LINKS } from '../lib/vaultConfig.js';


// ---------------------------------------------------------------------------
// Vault sync engine — diffs Drive against the IndexedDB cache, fetches only
// new/modified note bodies (concurrently), and maintains the in-memory
// backlink graph. Also seeds state instantly from whatever's cached locally
// so reopening a previously-loaded vault doesn't reshow a blank sidebar
// while a fresh listing comes back. Every note body it fetches (to parse
// wikilinks) is also handed to the RAM-only search index for free — see
// noteBodyCache below.
// ---------------------------------------------------------------------------
function useVaultSync(token, folder) {
  const [filesMeta, setFilesMeta] = useState([]); // notes AND images
  const [foldersMeta, setFoldersMeta] = useState([]);
  const [linksByFileId, setLinksByFileId] = useState(new Map());
  const [backlinkIndex, setBacklinkIndex] = useState(new Map());
  const [syncing, setSyncing] = useState(false);
  const [syncError, setSyncError] = useState('');
  const [lastSyncedAt, setLastSyncedAt] = useState(null);
  // Drives the loading screen / progress bars. `phase` picks the message;
  // `loaded`/`total` drive the bar once they're known (folder discovery
  // can't know a total up front, so the UI shows an indeterminate bar then).
  const [syncProgress, setSyncProgress] = useState({ phase: 'idle', loaded: 0, total: 0 });
  // True once we've at least tried seeding state from the local cache for
  // the current folder — used to tell "nothing cached yet, please wait"
  // apart from "genuinely empty vault".
  const [cacheLoaded, setCacheLoaded] = useState(false);

  const linkIndex = useMemo(() => buildLinkIndex(filesMeta, foldersMeta, folder?.id), [filesMeta, foldersMeta, folder?.id]);

  const recomputeBacklinks = useCallback((records, linksMap, index) => {
    setBacklinkIndex(buildBacklinkIndex(records, linksMap, index));
  }, []);

  // Seed instantly from the local cache the moment a folder is selected,
  // before syncNow()'s network round-trip even starts.
  useEffect(() => {
    if (!folder?.id) {
      setCacheLoaded(false);
      return;
    }
    let cancelled = false;
    setCacheLoaded(false);
    (async () => {
      const [cachedFiles, cachedFolders, cachedLinks] = await Promise.all([
        idbGetAll(STORE_FILES),
        idbGetAll(STORE_FOLDERS),
        idbGetAll(STORE_LINKS)
      ]);
      if (cancelled) return;
      const linksMap = new Map(cachedLinks.map((l) => [l.fileId, l.links]));
      const index = buildLinkIndex(cachedFiles, cachedFolders, folder.id);
      setFilesMeta(cachedFiles);
      setFoldersMeta(cachedFolders);
      setLinksByFileId(linksMap);
      recomputeBacklinks(cachedFiles, linksMap, index);
      setCacheLoaded(true);
    })();
    return () => {
      cancelled = true;
    };
  }, [folder?.id, recomputeBacklinks]);

  const syncNow = useCallback(async () => {
    if (!token || !folder?.id) return;
    setSyncing(true);
    setSyncError('');
    try {
      setSyncProgress({ phase: 'listing-folders', loaded: 0, total: 0 });
      const remoteFolders = await driveListFolderTree(token, folder.id);
      const folderIds = [folder.id, ...remoteFolders.map((f) => f.id)];

      setSyncProgress({ phase: 'listing-files', loaded: 0, total: 0 });
      const remoteFiles = await driveListVaultContentInFolders(token, folderIds);

      // Transient cache: previously seen metadata + derived link graph.
      const [cachedFiles, cachedLinks] = await Promise.all([idbGetAll(STORE_FILES), idbGetAll(STORE_LINKS)]);
      const cachedMetaById = new Map(cachedFiles.map((f) => [f.id, f]));
      const cachedLinksById = new Map(cachedLinks.map((l) => [l.fileId, l.links]));

      // Only notes ever need their body fetched (to parse wikilinks) — and
      // only the new/modified ones. Images are cached as metadata only.
      const toFetch = remoteFiles.filter((f) => {
        if (f.kind !== 'note') return false;
        const cached = cachedMetaById.get(f.id);
        return !cached || cached.modifiedTime !== f.modifiedTime;
      });

      let loaded = 0;
      setSyncProgress({ phase: 'fetching-content', loaded: 0, total: toFetch.length });
      const fetchResults = await mapWithConcurrency(toFetch, FETCH_CONCURRENCY, async (file) => {
        const content = await withRetry(() => driveGetFileContent(token, file.id));
        noteBodyCache.set(file.id, content); // seed the RAM search/tag index for free
        loaded += 1;
        setSyncProgress({ phase: 'fetching-content', loaded, total: toFetch.length });
        return { fileId: file.id, links: parseWikilinks(content), cachedAt: Date.now() };
      });
      bumpSearchIndexVersion();

      const freshLinkRecords = [];
      const failedFiles = [];
      fetchResults.forEach((r, i) => {
        if (r.ok) freshLinkRecords.push(r.value);
        else failedFiles.push(toFetch[i]);
      });

      // Merge fresh links over cached graph; drop entries for deleted files.
      const remoteIds = new Set(remoteFiles.map((f) => f.id));
      const mergedLinks = new Map(cachedLinksById);
      freshLinkRecords.forEach((r) => mergedLinks.set(r.fileId, r.links));
      for (const id of Array.from(mergedLinks.keys())) {
        if (!remoteIds.has(id)) mergedLinks.delete(id);
      }
      const staleFileIds = cachedFiles.map((f) => f.id).filter((id) => !remoteIds.has(id));
      staleFileIds.forEach((id) => noteBodyCache.delete(id));

      // Folders have no content to diff — just cache the structure.
      const cachedFolders = await idbGetAll(STORE_FOLDERS);
      const remoteFolderIds = new Set(remoteFolders.map((f) => f.id));
      const staleFolderIds = cachedFolders.map((f) => f.id).filter((id) => !remoteFolderIds.has(id));

      // Persist ONLY metadata + structure + link graph. Content is discarded here.
      await Promise.all([
        idbPutMany(STORE_FILES, remoteFiles),
        idbPutMany(STORE_FOLDERS, remoteFolders),
        idbPutMany(STORE_LINKS, freshLinkRecords),
        idbDeleteMany(STORE_FILES, staleFileIds),
        idbDeleteMany(STORE_FOLDERS, staleFolderIds),
        idbDeleteMany(STORE_LINKS, staleFileIds)
      ]);

      const nextIndex = buildLinkIndex(remoteFiles, remoteFolders, folder.id);
      setFilesMeta(remoteFiles);
      setFoldersMeta(remoteFolders);
      setLinksByFileId(mergedLinks);
      recomputeBacklinks(remoteFiles, mergedLinks, nextIndex);
      setLastSyncedAt(Date.now());
      setCacheLoaded(true);

      if (failedFiles.length) {
        setSyncError(
          `${failedFiles.length} file${failedFiles.length === 1 ? '' : 's'} couldn't be read and will be retried next sync`
        );
      }
    } catch (err) {
      setSyncError(err.message || 'Sync failed');
    } finally {
      setSyncing(false);
      setSyncProgress({ phase: 'idle', loaded: 0, total: 0 });
    }
  }, [token, folder, recomputeBacklinks]);

  // Refresh the graph immediately after a save, without a full resync.
  const applyLocalEdit = useCallback(
    (fileId, newContent, modifiedTime) => {
      const links = parseWikilinks(newContent);
      const nextFiles = filesMeta.map((f) => (f.id === fileId ? { ...f, modifiedTime } : f));
      const nextLinks = new Map(linksByFileId);
      nextLinks.set(fileId, links);
      const index = buildLinkIndex(nextFiles, foldersMeta, folder?.id);

      setFilesMeta(nextFiles);
      setLinksByFileId(nextLinks);
      recomputeBacklinks(nextFiles, nextLinks, index);

      idbPut(STORE_LINKS, { fileId, links, cachedAt: Date.now() });
      const rec = nextFiles.find((f) => f.id === fileId);
      if (rec) idbPut(STORE_FILES, rec);
    },
    [filesMeta, foldersMeta, folder, linksByFileId, recomputeBacklinks]
  );

  const registerNewFile = useCallback(
    (file) => {
      const nextFiles = [...filesMeta, file].sort((a, b) => a.name.localeCompare(b.name));
      const index = buildLinkIndex(nextFiles, foldersMeta, folder?.id);
      setFilesMeta(nextFiles);
      idbPut(STORE_FILES, file);
      recomputeBacklinks(nextFiles, linksByFileId, index);
    },
    [filesMeta, foldersMeta, folder, linksByFileId, recomputeBacklinks]
  );

  const renameFile = useCallback(
    (id, newName) => {
      const nextFiles = filesMeta.map((f) => (f.id === id ? { ...f, name: newName } : f));
      const index = buildLinkIndex(nextFiles, foldersMeta, folder?.id);
      setFilesMeta(nextFiles);
      const rec = nextFiles.find((f) => f.id === id);
      if (rec) idbPut(STORE_FILES, rec);
      recomputeBacklinks(nextFiles, linksByFileId, index); // name changed => link resolution changes
    },
    [filesMeta, foldersMeta, folder, linksByFileId, recomputeBacklinks]
  );

  const moveFile = useCallback(
    (id, newParentId) => {
      const nextFiles = filesMeta.map((f) => (f.id === id ? { ...f, parents: [newParentId] } : f));
      setFilesMeta(nextFiles);
      const rec = nextFiles.find((f) => f.id === id);
      if (rec) idbPut(STORE_FILES, rec);
    },
    [filesMeta]
  );

  const moveFolder = useCallback(
    (id, newParentId) => {
      const next = foldersMeta.map((f) => (f.id === id ? { ...f, parents: [newParentId] } : f));
      setFoldersMeta(next);
      const rec = next.find((f) => f.id === id);
      if (rec) idbPut(STORE_FOLDERS, rec);
    },
    [foldersMeta]
  );

  const removeFile = useCallback(
    (id) => {
      const nextFiles = filesMeta.filter((f) => f.id !== id);
      const nextLinks = new Map(linksByFileId);
      nextLinks.delete(id);
      const index = buildLinkIndex(nextFiles, foldersMeta, folder?.id);
      setFilesMeta(nextFiles);
      setLinksByFileId(nextLinks);
      recomputeBacklinks(nextFiles, nextLinks, index);
      idbDeleteMany(STORE_FILES, [id]);
      idbDeleteMany(STORE_LINKS, [id]);
      noteBodyCache.delete(id);
      bumpSearchIndexVersion();
    },
    [filesMeta, foldersMeta, folder, linksByFileId, recomputeBacklinks]
  );

  const registerNewFolder = useCallback(
    (folderRecord) => {
      const next = [...foldersMeta, folderRecord];
      setFoldersMeta(next);
      idbPut(STORE_FOLDERS, folderRecord);
    },
    [foldersMeta]
  );

  const renameFolder = useCallback(
    (id, newName) => {
      const next = foldersMeta.map((f) => (f.id === id ? { ...f, name: newName } : f));
      setFoldersMeta(next);
      const rec = next.find((f) => f.id === id);
      if (rec) idbPut(STORE_FOLDERS, rec);
    },
    [foldersMeta]
  );

  // Removes a folder and every descendant folder/file from local state (Drive
  // trashing already hides them remotely). Returns the ids of removed files
  // so the caller can close the editor if one of them was open.
  const removeFolder = useCallback(
    (id) => {
      const toRemove = new Set([id]);
      let grew = true;
      while (grew) {
        grew = false;
        foldersMeta.forEach((f) => {
          if (!toRemove.has(f.id) && (f.parents || []).some((p) => toRemove.has(p))) {
            toRemove.add(f.id);
            grew = true;
          }
        });
      }
      const nextFolders = foldersMeta.filter((f) => !toRemove.has(f.id));
      const removedFileIds = filesMeta.filter((f) => (f.parents || []).some((p) => toRemove.has(p))).map((f) => f.id);
      const nextFiles = filesMeta.filter((f) => !removedFileIds.includes(f.id));
      const nextLinks = new Map(linksByFileId);
      removedFileIds.forEach((fid) => nextLinks.delete(fid));
      const index = buildLinkIndex(nextFiles, nextFolders, folder?.id);

      setFoldersMeta(nextFolders);
      setFilesMeta(nextFiles);
      setLinksByFileId(nextLinks);
      recomputeBacklinks(nextFiles, nextLinks, index);

      idbDeleteMany(STORE_FOLDERS, Array.from(toRemove));
      idbDeleteMany(STORE_FILES, removedFileIds);
      idbDeleteMany(STORE_LINKS, removedFileIds);
      removedFileIds.forEach((fid) => noteBodyCache.delete(fid));
      bumpSearchIndexVersion();
      return removedFileIds;
    },
    [foldersMeta, filesMeta, folder, linksByFileId, recomputeBacklinks]
  );

  // Called when switching to a different vault folder — clears in-memory
  // state immediately so the old vault's file list doesn't flash on screen
  // while the new folder's sync is still in flight. IndexedDB entries for
  // the old vault self-prune on the next syncNow (their ids won't be in the
  // new folder's remote listing).
  const resetVault = useCallback(() => {
    setFilesMeta([]);
    setFoldersMeta([]);
    setLinksByFileId(new Map());
    setBacklinkIndex(new Map());
    setSyncError('');
    setCacheLoaded(false);
    releaseSearchIndex();
  }, []);

  return {
    filesMeta,
    foldersMeta,
    linksByFileId,
    backlinkIndex,
    linkIndex,
    syncing,
    syncError,
    syncProgress,
    cacheLoaded,
    lastSyncedAt,
    syncNow,
    applyLocalEdit,
    registerNewFile,
    renameFile,
    moveFile,
    moveFolder,
    removeFile,
    registerNewFolder,
    renameFolder,
    removeFolder,
    resetVault
  };
}


// ---------------------------------------------------------------------------
// Builds a nested { type, id, name, kind?, children? } tree from the flat
// folder + file metadata lists, rooted at the vault folder. Folders sort
// before files at each level; both alphabetically.
// ---------------------------------------------------------------------------
function buildVaultTree(rootId, folders, files) {
  if (!rootId) return [];
  const childrenByParent = new Map();
  const addChild = (parentId, node) => {
    if (!childrenByParent.has(parentId)) childrenByParent.set(parentId, []);
    childrenByParent.get(parentId).push(node);
  };
  folders.forEach((f) => addChild((f.parents && f.parents[0]) || rootId, { type: 'folder', id: f.id, name: f.name }));
  files.forEach((f) =>
    addChild((f.parents && f.parents[0]) || rootId, {
      type: 'file',
      kind: f.kind || 'note',
      id: f.id,
      name: f.name,
      modifiedTime: f.modifiedTime
    })
  );

  const build = (parentId) => {
    const kids = (childrenByParent.get(parentId) || []).slice().sort((a, b) => {
      if (a.type !== b.type) return a.type === 'folder' ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    return kids.map((k) => (k.type === 'folder' ? { ...k, children: build(k.id) } : k));
  };
  return build(rootId);
}


// Flat, search-filtered list of files (used by the quick switcher).
function flattenFiles(files, query) {
  if (!query.trim()) return files.slice().sort((a, b) => a.name.localeCompare(b.name));
  return files
    .map((f) => ({ f, score: fuzzyScore(query, f.name) }))
    .filter((s) => s.score !== null)
    .sort((a, b) => a.score - b.score)
    .map((s) => s.f);
}

export { useVaultSync, buildVaultTree, flattenFiles };
