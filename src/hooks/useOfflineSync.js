import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { driveCreateFile, driveGetFileBlob, driveGetFileContent, driveGetFileMetadata, driveUpdateFileContent } from '../lib/driveApi.js';
import { idbDeleteMany, idbGet, idbGetAll, idbPut } from '../lib/indexedDb.js';
import { buildConflictCopyName, resolveOfflineIds } from '../lib/offlineRules.js';
import { STORE_META, STORE_OFFLINE_ASSETS, STORE_OFFLINE_NOTES } from '../lib/vaultConfig.js';

const subscribeOnline = (notify) => { window.addEventListener('online', notify); window.addEventListener('offline', notify); return () => { window.removeEventListener('online', notify); window.removeEventListener('offline', notify); }; };
const getOnline = () => navigator.onLine;
const assetKind = (kind) => !['note', 'database', 'canvas'].includes(kind);

function useOfflineSync(token, folder, sync) {
  const isOnline = useSyncExternalStore(subscribeOnline, getOnline, () => true);
  const [offlineRoots, setOfflineRoots] = useState([]);
  const [dirtyRows, setDirtyRows] = useState([]);
  const [pendingConflicts, setPendingConflicts] = useState([]);
  const priorIds = useRef(new Set());
  const { offlineFileIds, offlineFolderIds } = useMemo(
    () => resolveOfflineIds(offlineRoots, sync.foldersMeta, sync.filesMeta, folder?.id),
    [offlineRoots, sync.foldersMeta, sync.filesMeta, folder?.id]
  );
  const refreshDirty = useCallback(async () => setDirtyRows((await idbGetAll(STORE_OFFLINE_NOTES)).filter((r) => r.dirty)), []);

  useEffect(() => { let cancelled = false; setOfflineRoots([]); setPendingConflicts([]); if (!folder?.id) return undefined; idbGet(STORE_META, `offlineRoots:${folder.id}`).then((r) => !cancelled && setOfflineRoots(r?.value || [])); return () => { cancelled = true; }; }, [folder?.id]);
  useEffect(() => { refreshDirty(); }, [folder?.id, refreshDirty]);

  const getOfflineContent = useCallback(async (fileId) => (await idbGet(STORE_OFFLINE_NOTES, fileId))?.content ?? null, []);
  const setOfflineContent = useCallback(async (fileId, content, { dirty = false } = {}) => {
    const old = await idbGet(STORE_OFFLINE_NOTES, fileId);
    const file = sync.filesMeta.find((f) => f.id === fileId);
    await idbPut(STORE_OFFLINE_NOTES, { ...old, fileId, content, kind: old?.kind || file?.kind || 'note', baselineModifiedTime: old?.baselineModifiedTime || file?.modifiedTime || null, dirty, localEditedAt: dirty ? Date.now() : null, cachedAt: Date.now() });
    refreshDirty();
  }, [refreshDirty, sync.filesMeta]);
  const refreshCacheAfterSave = useCallback(async (fileId, content, modifiedTime) => {
    const old = await idbGet(STORE_OFFLINE_NOTES, fileId); const file = sync.filesMeta.find((f) => f.id === fileId);
    await idbPut(STORE_OFFLINE_NOTES, { ...old, fileId, content, kind: old?.kind || file?.kind || 'note', baselineModifiedTime: modifiedTime, dirty: false, localEditedAt: null, cachedAt: Date.now() }); refreshDirty();
  }, [refreshDirty, sync.filesMeta]);

  useEffect(() => {
    const current = new Set(offlineFileIds); const previous = priorIds.current; priorIds.current = current;
    const run = async () => {
      const removed = [...previous].filter((id) => !current.has(id));
      const notes = await idbGetAll(STORE_OFFLINE_NOTES);
      const dirty = new Set(notes.filter((r) => r.dirty).map((r) => r.fileId));
      await idbDeleteMany(STORE_OFFLINE_NOTES, removed.filter((id) => !dirty.has(id)));
      await idbDeleteMany(STORE_OFFLINE_ASSETS, removed);
      if (!token || !isOnline) return;
      for (const id of current) {
        const file = sync.filesMeta.find((f) => f.id === id); if (!file) continue;
        const store = assetKind(file.kind) ? STORE_OFFLINE_ASSETS : STORE_OFFLINE_NOTES;
        const cached = await idbGet(store, id);
        if (cached && (cached.dirty || cached.baselineModifiedTime === file.modifiedTime)) continue;
        if (assetKind(file.kind)) { const blob = await driveGetFileBlob(token, id); await idbPut(store, { fileId: id, blob, mimeType: file.mimeType, baselineModifiedTime: file.modifiedTime, cachedAt: Date.now() }); }
        else { const content = await driveGetFileContent(token, id); await idbPut(store, { fileId: id, content, kind: file.kind, baselineModifiedTime: file.modifiedTime, dirty: false, localEditedAt: null, cachedAt: Date.now() }); }
      }
      refreshDirty();
    }; run().catch(() => {});
  }, [offlineFileIds, offlineFolderIds, token, isOnline, sync.filesMeta, refreshDirty]);

  const reconcileNow = useCallback(async (onlyIds) => {
    if (!token || !isOnline) return { ok: false, message: 'Reconnect before syncing offline changes.' };
    const rows = (await idbGetAll(STORE_OFFLINE_NOTES)).filter((r) => r.dirty && (!onlyIds || onlyIds.has(r.fileId)));
    const conflicts = [];
    for (const row of rows) {
      const local = sync.filesMeta.find((f) => f.id === row.fileId);
      try {
        const remote = await driveGetFileMetadata(token, row.fileId);
        if (remote.modifiedTime && remote.modifiedTime !== row.baselineModifiedTime) {
          conflicts.push({ fileId: row.fileId, name: remote.name || local?.name || 'Untitled', kind: row.kind, localContent: row.content, remoteContent: await driveGetFileContent(token, row.fileId), remote, type: 'changed', parentId: (remote.parents || local?.parents || [folder?.id])[0] }); continue;
        }
        const updated = await driveUpdateFileContent(token, row.fileId, row.content); await refreshCacheAfterSave(row.fileId, row.content, updated.modifiedTime || remote.modifiedTime); sync.applyLocalEdit(row.fileId, row.content, updated.modifiedTime || remote.modifiedTime);
      } catch (err) {
        if (err.status === 404) conflicts.push({ fileId: row.fileId, name: local?.name || 'Untitled', kind: row.kind, localContent: row.content, type: 'deleted-on-Drive', parentId: (local?.parents || [folder?.id])[0] }); else throw err;
      }
    }
    if (conflicts.length) setPendingConflicts((old) => [...old.filter((c) => !conflicts.some((n) => n.fileId === c.fileId)), ...conflicts]); refreshDirty(); return { ok: !conflicts.length };
  }, [token, isOnline, sync, folder?.id, refreshCacheAfterSave, refreshDirty]);

  const toggleOfflineRoot = useCallback(async (id, type, on) => {
    const existing = offlineRoots.some((r) => r.id === id && r.type === type);
    if (!on || existing) {
      const covered = resolveOfflineIds(offlineRoots, sync.foldersMeta, sync.filesMeta, folder?.id).offlineFileIds;
      const dirty = (await idbGetAll(STORE_OFFLINE_NOTES)).filter((r) => r.dirty && covered.has(r.fileId));
      if (dirty.length && !isOnline) return { ok: false, message: 'Reconnect before removing offline files with unsynced changes.' };
      if (dirty.length) { const result = await reconcileNow(new Set(dirty.map((r) => r.fileId))); if (!result.ok) return { ok: false, message: 'Resolve offline conflicts before removing this offline rule.' }; }
    }
    const next = on ? (existing ? offlineRoots : [...offlineRoots, { id, type }]) : offlineRoots.filter((r) => !(r.id === id && r.type === type));
    setOfflineRoots(next); if (folder?.id) await idbPut(STORE_META, { key: `offlineRoots:${folder.id}`, value: next }); return { ok: true };
  }, [offlineRoots, sync.foldersMeta, sync.filesMeta, folder?.id, isOnline, reconcileNow]);

  const resolveConflict = useCallback(async (fileId, action) => {
    const conflict = pendingConflicts.find((c) => c.fileId === fileId); if (!conflict || !token) return;
    const row = await idbGet(STORE_OFFLINE_NOTES, fileId);
    if (action === 'discard') await idbDeleteMany(STORE_OFFLINE_NOTES, [fileId]);
    else if (action === 'keep-drive') await refreshCacheAfterSave(fileId, conflict.remoteContent, conflict.remote?.modifiedTime);
    else if (action === 'keep-mine') { const updated = await driveUpdateFileContent(token, fileId, row.content); await refreshCacheAfterSave(fileId, row.content, updated.modifiedTime); sync.applyLocalEdit(fileId, row.content, updated.modifiedTime); }
    else if (action === 'keep-both') { const made = await driveCreateFile(token, conflict.parentId, buildConflictCopyName(conflict.name, conflict.kind), row.content, conflict.kind === 'database' ? 'base' : conflict.kind === 'canvas' ? 'canvas' : 'md', conflict.kind === 'note' ? 'text/markdown' : 'application/json'); sync.registerNewFile({ ...made, kind: conflict.kind }); await refreshCacheAfterSave(fileId, conflict.remoteContent, conflict.remote?.modifiedTime); }
    else if (action === 'restore') { const made = await driveCreateFile(token, conflict.parentId, conflict.name, row.content, conflict.kind === 'database' ? 'base' : conflict.kind === 'canvas' ? 'canvas' : 'md'); sync.registerNewFile({ ...made, kind: conflict.kind }); await idbDeleteMany(STORE_OFFLINE_NOTES, [fileId]); }
    setPendingConflicts((old) => old.filter((c) => c.fileId !== fileId)); refreshDirty();
  }, [pendingConflicts, token, refreshCacheAfterSave, sync, refreshDirty]);
  useEffect(() => { if (isOnline && dirtyRows.length) reconcileNow().catch(() => {}); }, [isOnline]); // intentionally sync on reconnect
  return { offlineRoots, offlineFileIds, offlineFolderIds, isOnline, toggleOfflineRoot, getOfflineContent, setOfflineContent, refreshCacheAfterSave, hasUnsyncedOfflineEdits: dirtyRows.length, pendingConflicts, reconcileNow, resolveConflict };
}
export { useOfflineSync };
