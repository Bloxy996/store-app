import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';

/* ============================================================================
 * VAULT — a markdown notebook that reads/writes .md files directly to and
 * from Google Drive. Architectural rule enforced throughout this file:
 *
 *   Note CONTENT is NEVER written to disk on this device. It lives only in
 *   React state (RAM) for as long as a note is open, and is streamed to/from
 *   Drive over the REST API. IndexedDB is used exclusively as a *transient*
 *   cache for: (a) file metadata/modifiedTime, and (b) the derived wikilink
 *   graph — never for raw note bodies. Clearing IndexedDB never loses data,
 *   because Drive remains the single source of truth.
 * ==========================================================================*/

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const CLIENT_ID = import.meta.env.VITE_GOOGLE_CLIENT_ID;
const API_KEY = import.meta.env.VITE_GOOGLE_API_KEY; // optional, used by Picker
const APP_ID = import.meta.env.VITE_GOOGLE_APP_ID; // optional, used by Picker
// NOTE on scope: drive.file only grants access to files the app itself
// creates (or individual files the user explicitly picks one-by-one).
// Selecting a *folder* via the Picker does NOT retroactively grant access
// to that folder's pre-existing contents — only to the folder resource
// itself and to anything the app subsequently creates inside it. Since this
// app needs to read and edit an existing vault of arbitrary pre-existing
// notes, that per-file model doesn't fit, so it requests the broader
// `drive` scope instead (full read/write across the user's Drive). This is
// a "restricted" scope: Google requires it to be added under OAuth consent
// screen -> Data Access -> Scopes, and — like drive.file — it only needs
// full app verification once you leave Testing mode / add non-test users.
const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive';

const DRIVE_FILES_URL = 'https://www.googleapis.com/drive/v3/files';
const DRIVE_UPLOAD_URL = 'https://www.googleapis.com/upload/drive/v3/files';

const DB_NAME = 'vault-cache-db';
const DB_VERSION = 2;
const STORE_FILES = 'files'; // { id, name, modifiedTime, parents }  -- metadata only
const STORE_FOLDERS = 'folders'; // { id, name, parents } -- structure only, no content
const STORE_LINKS = 'links'; // { fileId, links: [{target, alias}], cachedAt } -- graph only
const STORE_META = 'meta'; // { key, value } -- app settings (vault folder id, etc.)

// ---------------------------------------------------------------------------
// IndexedDB — transient cache only. No note bodies ever touch these stores.
// ---------------------------------------------------------------------------
function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains(STORE_FILES)) db.createObjectStore(STORE_FILES, { keyPath: 'id' });
      if (!db.objectStoreNames.contains(STORE_FOLDERS)) db.createObjectStore(STORE_FOLDERS, { keyPath: 'id' });
      if (!db.objectStoreNames.contains(STORE_LINKS)) db.createObjectStore(STORE_LINKS, { keyPath: 'fileId' });
      if (!db.objectStoreNames.contains(STORE_META)) db.createObjectStore(STORE_META, { keyPath: 'key' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function idbGetAll(store) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const req = db.transaction(store, 'readonly').objectStore(store).getAll();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error);
  });
}

async function idbGet(store, key) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const req = db.transaction(store, 'readonly').objectStore(store).get(key);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => reject(req.error);
  });
}

async function idbPutMany(store, records) {
  if (!records.length) return;
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, 'readwrite');
    const os = tx.objectStore(store);
    records.forEach((r) => os.put(r));
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

function idbPut(store, record) {
  return idbPutMany(store, [record]);
}

async function idbDeleteMany(store, keys) {
  if (!keys.length) return;
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, 'readwrite');
    const os = tx.objectStore(store);
    keys.forEach((k) => os.delete(k));
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

// ---------------------------------------------------------------------------
// RegExp wikilink parsing + backlink graph
// ---------------------------------------------------------------------------
function normalizeNoteName(name) {
  return String(name || '').replace(/\.md$/i, '').trim().toLowerCase();
}

// Matches [[Target]], [[Target#heading]], [[Target|Alias]]
function parseWikilinks(content) {
  const re = /\[\[([^\[\]|#]+)(?:#[^\[\]|]*)?(?:\|([^\[\]]+))?\]\]/g;
  const links = [];
  let m;
  while ((m = re.exec(content)) !== null) {
    links.push({ target: m[1].trim(), alias: m[2] ? m[2].trim() : null });
  }
  return links;
}

// Builds fileId -> Set(fileId) map of inbound links, resolved by note name.
function buildBacklinkIndex(fileRecords, linksByFileId) {
  const nameToId = new Map();
  fileRecords.forEach((f) => nameToId.set(normalizeNoteName(f.name), f.id));

  const backlinks = new Map();
  fileRecords.forEach((f) => backlinks.set(f.id, new Set()));

  for (const [sourceId, links] of linksByFileId.entries()) {
    for (const link of links) {
      const targetId = nameToId.get(normalizeNoteName(link.target));
      if (targetId && targetId !== sourceId) {
        if (!backlinks.has(targetId)) backlinks.set(targetId, new Set());
        backlinks.get(targetId).add(sourceId);
      }
    }
  }
  return backlinks;
}

// ---------------------------------------------------------------------------
// Google Drive REST wrapper (full `drive` scope — see DRIVE_SCOPE note above)
//
// Every request below carries supportsAllDrives=true / includeItemsFromAllDrives=true.
// This matters for folders added via Google Drive desktop's "back up a folder
// from your computer" mode: those live under the special "Computers" area,
// a separate corpus from ordinary My Drive, and files.list silently omits
// it unless these flags are set. Folders that were already inside My Drive
// work either way, so this is always safe to include.
// ---------------------------------------------------------------------------
const DRIVE_ALL_DRIVES = 'supportsAllDrives=true&includeItemsFromAllDrives=true';

function chunkArray(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

// Real vaults are almost always nested (subfolders for daily notes,
// attachments, etc). Drive's API has no recursive "in ancestors" query, so
// we BFS the folder tree ourselves, one level at a time, batching parent
// clauses to keep query strings short. Returns full {id,name,parents}
// records (not just ids) for the vault's SUBfolders — the root itself is
// not included, since it's represented separately as the vault folder.
async function driveListFolderTree(token, rootFolderId) {
  const allFolders = [];
  let frontier = [rootFolderId];
  while (frontier.length) {
    const nextFrontier = [];
    for (const chunk of chunkArray(frontier, 10)) {
      const parentClauses = chunk.map((id) => `'${id}' in parents`).join(' or ');
      const q = encodeURIComponent(`(${parentClauses}) and mimeType = 'application/vnd.google-apps.folder' and trashed = false`);
      const fields = encodeURIComponent('files(id,name,parents),nextPageToken');
      let pageToken = '';
      do {
        const url = `${DRIVE_FILES_URL}?q=${q}&fields=${fields}&pageSize=1000&${DRIVE_ALL_DRIVES}${
          pageToken ? `&pageToken=${pageToken}` : ''
        }`;
        const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
        if (!res.ok) throw new Error(`Drive folder list failed (${res.status})`);
        const data = await res.json();
        (data.files || []).forEach((f) => {
          allFolders.push(f);
          nextFrontier.push(f.id);
        });
        pageToken = data.nextPageToken || '';
      } while (pageToken);
    }
    frontier = nextFrontier;
  }
  return allFolders;
}

// Lists .md files across every folder ID given (batched — Drive queries have
// a practical length limit, so we chunk the OR'd parent clauses).
async function driveListMarkdownFilesInFolders(token, folderIds) {
  let files = [];
  for (const chunk of chunkArray(folderIds, 10)) {
    const parentClauses = chunk.map((id) => `'${id}' in parents`).join(' or ');
    const q = encodeURIComponent(
      `(${parentClauses}) and trashed = false and (mimeType = 'text/markdown' or mimeType = 'text/plain' or fileExtension = 'md')`
    );
    const fields = encodeURIComponent('files(id,name,modifiedTime,parents),nextPageToken');
    let pageToken = '';
    do {
      const url = `${DRIVE_FILES_URL}?q=${q}&fields=${fields}&pageSize=1000&orderBy=name&${DRIVE_ALL_DRIVES}${
        pageToken ? `&pageToken=${pageToken}` : ''
      }`;
      const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
      if (!res.ok) throw new Error(`Drive list failed (${res.status})`);
      const data = await res.json();
      files = files.concat(data.files || []);
      pageToken = data.nextPageToken || '';
    } while (pageToken);
  }
  return files;
}

// Returns the full vault contents: every subfolder record, and every .md
// file across the root + all subfolders.
async function driveListVaultFiles(token, rootFolderId) {
  const folders = await driveListFolderTree(token, rootFolderId);
  const folderIds = [rootFolderId, ...folders.map((f) => f.id)];
  const files = await driveListMarkdownFilesInFolders(token, folderIds);
  return { folders, files };
}

async function driveGetFileContent(token, fileId) {
  const res = await fetch(`${DRIVE_FILES_URL}/${fileId}?alt=media&${DRIVE_ALL_DRIVES}`, {
    headers: { Authorization: `Bearer ${token}` }
  });
  if (!res.ok) throw new Error(`Drive fetch failed (${res.status})`);
  return res.text();
}

async function driveUpdateFileContent(token, fileId, content) {
  const res = await fetch(`${DRIVE_UPLOAD_URL}/${fileId}?uploadType=media&${DRIVE_ALL_DRIVES}`, {
    method: 'PATCH',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'text/markdown' },
    body: content
  });
  if (!res.ok) throw new Error(`Drive save failed (${res.status})`);
  return res.json();
}

async function driveCreateFile(token, folderId, rawName, content = '') {
  const name = rawName.toLowerCase().endsWith('.md') ? rawName : `${rawName}.md`;
  const metadata = { name, parents: [folderId], mimeType: 'text/markdown' };
  const boundary = `vault-${Date.now()}`;
  const body =
    `--${boundary}\r\n` +
    `Content-Type: application/json; charset=UTF-8\r\n\r\n` +
    `${JSON.stringify(metadata)}\r\n` +
    `--${boundary}\r\n` +
    `Content-Type: text/markdown\r\n\r\n` +
    `${content}\r\n` +
    `--${boundary}--`;
  const res = await fetch(`${DRIVE_UPLOAD_URL}?uploadType=multipart&fields=id,name,modifiedTime,parents&${DRIVE_ALL_DRIVES}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': `multipart/related; boundary=${boundary}` },
    body
  });
  if (!res.ok) throw new Error(`Drive create failed (${res.status})`);
  return res.json();
}

async function driveCreateFolder(token, parentId, name) {
  const res = await fetch(`${DRIVE_FILES_URL}?fields=id,name,parents&${DRIVE_ALL_DRIVES}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, parents: [parentId], mimeType: 'application/vnd.google-apps.folder' })
  });
  if (!res.ok) throw new Error(`Drive folder create failed (${res.status})`);
  return res.json();
}

// Renames a file or folder (metadata-only PATCH — content untouched).
async function driveRenameItem(token, id, newName) {
  const res = await fetch(`${DRIVE_FILES_URL}/${id}?fields=id,name&${DRIVE_ALL_DRIVES}`, {
    method: 'PATCH',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: newName })
  });
  if (!res.ok) throw new Error(`Drive rename failed (${res.status})`);
  return res.json();
}

// Moves a file or folder to Drive's trash (recoverable), rather than
// permanently deleting — matches what "Delete" does in Drive's own UI.
// Trashing a folder hides its contents from listings too; the app treats
// them as gone on the next sync without needing to trash each child.
async function driveTrashItem(token, id) {
  const res = await fetch(`${DRIVE_FILES_URL}/${id}?${DRIVE_ALL_DRIVES}`, {
    method: 'PATCH',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ trashed: true })
  });
  if (!res.ok) throw new Error(`Drive delete failed (${res.status})`);
  return res.json();
}

// ---------------------------------------------------------------------------
// Google Picker (vault folder selection)
// ---------------------------------------------------------------------------
function loadScriptOnce(src) {
  return new Promise((resolve, reject) => {
    if (document.querySelector(`script[src="${src}"]`)) return resolve();
    const s = document.createElement('script');
    s.src = src;
    s.async = true;
    s.onload = resolve;
    s.onerror = reject;
    document.head.appendChild(s);
  });
}

async function ensurePickerLoaded() {
  if (!window.gapi) await loadScriptOnce('https://apis.google.com/js/api.js');
  await new Promise((resolve) => window.gapi.load('picker', resolve));
}

async function openFolderPicker(token) {
  await ensurePickerLoaded();
  return new Promise((resolve) => {
    const view = new window.google.picker.DocsView(window.google.picker.ViewId.FOLDERS)
      .setSelectFolderEnabled(true)
      .setIncludeFolders(true);
    const builder = new window.google.picker.PickerBuilder()
      .setOAuthToken(token)
      .addView(view)
      .setTitle('Select your vault folder')
      .setCallback((data) => {
        if (data.action === window.google.picker.Action.PICKED) {
          const doc = data.docs[0];
          resolve({ id: doc.id, name: doc.name });
        } else if (data.action === window.google.picker.Action.CANCEL) {
          resolve(null);
        }
      });
    if (API_KEY) builder.setDeveloperKey(API_KEY);
    if (APP_ID) builder.setAppId(APP_ID);
    builder.build().setVisible(true);
  });
}

// ---------------------------------------------------------------------------
// Auth hook — Google Identity Services token client
// ---------------------------------------------------------------------------
function useGoogleAuth() {
  const [token, setToken] = useState(() => sessionStorage.getItem('vault_access_token') || '');
  const [tokenClient, setTokenClient] = useState(null);
  const [gisReady, setGisReady] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (function init() {
      if (cancelled) return;
      if (!window.google || !window.google.accounts) {
        setTimeout(init, 150);
        return;
      }
      const client = window.google.accounts.oauth2.initTokenClient({
        client_id: CLIENT_ID,
        scope: DRIVE_SCOPE,
        callback: (resp) => {
          if (resp && resp.access_token) {
            sessionStorage.setItem('vault_access_token', resp.access_token);
            setToken(resp.access_token);
          }
        }
      });
      setTokenClient(client);
      setGisReady(true);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const signIn = useCallback(() => {
    if (!tokenClient) return;
    tokenClient.requestAccessToken({ prompt: token ? '' : 'consent' });
  }, [tokenClient, token]);

  const signOut = useCallback(() => {
    if (token && window.google?.accounts?.oauth2?.revoke) {
      window.google.accounts.oauth2.revoke(token, () => {});
    }
    sessionStorage.removeItem('vault_access_token');
    setToken('');
  }, [token]);

  return { token, gisReady, signIn, signOut };
}

// ---------------------------------------------------------------------------
// Vault sync engine — diffs Drive against the IndexedDB cache, fetches only
// new/modified files, and maintains the in-memory backlink graph.
// ---------------------------------------------------------------------------
function useVaultSync(token, folder) {
  const [filesMeta, setFilesMeta] = useState([]);
  const [foldersMeta, setFoldersMeta] = useState([]);
  const [linksByFileId, setLinksByFileId] = useState(new Map());
  const [backlinkIndex, setBacklinkIndex] = useState(new Map());
  const [syncing, setSyncing] = useState(false);
  const [syncError, setSyncError] = useState('');
  const [lastSyncedAt, setLastSyncedAt] = useState(null);

  const recomputeBacklinks = useCallback((records, linksMap) => {
    setBacklinkIndex(buildBacklinkIndex(records, linksMap));
  }, []);

  const syncNow = useCallback(async () => {
    if (!token || !folder?.id) return;
    setSyncing(true);
    setSyncError('');
    try {
      // Source of truth: live Drive listing (id + modifiedTime), walking
      // the full subfolder tree under the vault root.
      const { folders: remoteFolders, files: remoteFiles } = await driveListVaultFiles(token, folder.id);

      // Transient cache: previously seen metadata + derived link graph.
      const [cachedFiles, cachedLinks] = await Promise.all([idbGetAll(STORE_FILES), idbGetAll(STORE_LINKS)]);
      const cachedMetaById = new Map(cachedFiles.map((f) => [f.id, f]));
      const cachedLinksById = new Map(cachedLinks.map((l) => [l.fileId, l.links]));

      // Diff: only fetch content for files that are new or whose
      // modifiedTime moved on — this is the "only new/modified" contract.
      const toFetch = remoteFiles.filter((f) => {
        const cached = cachedMetaById.get(f.id);
        return !cached || cached.modifiedTime !== f.modifiedTime;
      });

      const freshLinkRecords = [];
      for (const file of toFetch) {
        const content = await driveGetFileContent(token, file.id);
        freshLinkRecords.push({ fileId: file.id, links: parseWikilinks(content), cachedAt: Date.now() });
      }

      // Merge fresh links over cached graph; drop entries for deleted files.
      const remoteIds = new Set(remoteFiles.map((f) => f.id));
      const mergedLinks = new Map(cachedLinksById);
      freshLinkRecords.forEach((r) => mergedLinks.set(r.fileId, r.links));
      for (const id of Array.from(mergedLinks.keys())) {
        if (!remoteIds.has(id)) mergedLinks.delete(id);
      }
      const staleFileIds = cachedFiles.map((f) => f.id).filter((id) => !remoteIds.has(id));

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

      setFilesMeta(remoteFiles);
      setFoldersMeta(remoteFolders);
      setLinksByFileId(mergedLinks);
      recomputeBacklinks(remoteFiles, mergedLinks);
      setLastSyncedAt(Date.now());
    } catch (err) {
      setSyncError(err.message || 'Sync failed');
    } finally {
      setSyncing(false);
    }
  }, [token, folder, recomputeBacklinks]);

  // Refresh the graph immediately after a save, without a full resync.
  const applyLocalEdit = useCallback(
    (fileId, newContent, modifiedTime) => {
      const links = parseWikilinks(newContent);
      const nextFiles = filesMeta.map((f) => (f.id === fileId ? { ...f, modifiedTime } : f));
      const nextLinks = new Map(linksByFileId);
      nextLinks.set(fileId, links);

      setFilesMeta(nextFiles);
      setLinksByFileId(nextLinks);
      recomputeBacklinks(nextFiles, nextLinks);

      idbPut(STORE_LINKS, { fileId, links, cachedAt: Date.now() });
      const rec = nextFiles.find((f) => f.id === fileId);
      if (rec) idbPut(STORE_FILES, rec);
    },
    [filesMeta, linksByFileId, recomputeBacklinks]
  );

  const registerNewFile = useCallback(
    (file) => {
      const nextFiles = [...filesMeta, file].sort((a, b) => a.name.localeCompare(b.name));
      setFilesMeta(nextFiles);
      idbPut(STORE_FILES, file);
      recomputeBacklinks(nextFiles, linksByFileId);
    },
    [filesMeta, linksByFileId, recomputeBacklinks]
  );

  const renameFile = useCallback(
    (id, newName) => {
      const nextFiles = filesMeta.map((f) => (f.id === id ? { ...f, name: newName } : f));
      setFilesMeta(nextFiles);
      const rec = nextFiles.find((f) => f.id === id);
      if (rec) idbPut(STORE_FILES, rec);
      recomputeBacklinks(nextFiles, linksByFileId); // name changed => link resolution changes
    },
    [filesMeta, linksByFileId, recomputeBacklinks]
  );

  const removeFile = useCallback(
    (id) => {
      const nextFiles = filesMeta.filter((f) => f.id !== id);
      const nextLinks = new Map(linksByFileId);
      nextLinks.delete(id);
      setFilesMeta(nextFiles);
      setLinksByFileId(nextLinks);
      recomputeBacklinks(nextFiles, nextLinks);
      idbDeleteMany(STORE_FILES, [id]);
      idbDeleteMany(STORE_LINKS, [id]);
    },
    [filesMeta, linksByFileId, recomputeBacklinks]
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

      setFoldersMeta(nextFolders);
      setFilesMeta(nextFiles);
      setLinksByFileId(nextLinks);
      recomputeBacklinks(nextFiles, nextLinks);

      idbDeleteMany(STORE_FOLDERS, Array.from(toRemove));
      idbDeleteMany(STORE_FILES, removedFileIds);
      idbDeleteMany(STORE_LINKS, removedFileIds);
      return removedFileIds;
    },
    [foldersMeta, filesMeta, linksByFileId, recomputeBacklinks]
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
  }, []);

  return {
    filesMeta,
    foldersMeta,
    linksByFileId,
    backlinkIndex,
    syncing,
    syncError,
    lastSyncedAt,
    syncNow,
    applyLocalEdit,
    registerNewFile,
    renameFile,
    removeFile,
    registerNewFolder,
    renameFolder,
    removeFolder,
    resetVault
  };
}

// ---------------------------------------------------------------------------
// Builds a nested { type, id, name, children? } tree from the flat folder +
// file metadata lists, rooted at the vault folder. Folders sort before
// files at each level; both alphabetically.
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
    addChild((f.parents && f.parents[0]) || rootId, { type: 'file', id: f.id, name: f.name, modifiedTime: f.modifiedTime })
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

// Flat, search-filtered list of files (used instead of the tree while the
// sidebar search box has text in it).
function flattenFiles(files, query) {
  const q = query.toLowerCase();
  return files
    .filter((f) => f.name.toLowerCase().includes(q))
    .slice()
    .sort((a, b) => a.name.localeCompare(b.name));
}

// ---------------------------------------------------------------------------
// Minimal markdown + wikilink renderer (no external markdown dependency)
// ---------------------------------------------------------------------------
function renderInline(text, keyPrefix, onOpenLink, knownNames) {
  const nodes = [];
  const re = /(\[\[[^\[\]]+\]\])|(\*\*[^*]+\*\*)|(`[^`]+`)|(\[[^\[\]]+\]\([^()\s]+\))|(\*[^*]+\*)/g;
  let lastIndex = 0;
  let match;
  let i = 0;
  while ((match = re.exec(text)) !== null) {
    if (match.index > lastIndex) nodes.push(text.slice(lastIndex, match.index));
    const token = match[0];
    const key = `${keyPrefix}-${i++}`;
    if (token.startsWith('[[')) {
      const inner = token.slice(2, -2);
      const [rawTarget, rawAlias] = inner.split('|');
      const target = rawTarget.replace(/#.*$/, '').trim();
      const label = (rawAlias || rawTarget).trim();
      const exists = knownNames.has(normalizeNoteName(target));
      nodes.push(
        <span
          key={key}
          className={exists ? 'wikilink' : 'wikilink wikilink-new'}
          onClick={() => onOpenLink(target)}
          title={exists ? `Open ${target}` : `Create "${target}"`}
        >
          {label}
        </span>
      );
    } else if (token.startsWith('**')) {
      nodes.push(<strong key={key}>{token.slice(2, -2)}</strong>);
    } else if (token.startsWith('`')) {
      nodes.push(<code key={key}>{token.slice(1, -1)}</code>);
    } else if (token.startsWith('[')) {
      const m = token.match(/^\[([^\[\]]+)\]\(([^()\s]+)\)$/);
      nodes.push(
        <a key={key} href={m[2]} target="_blank" rel="noreferrer">
          {m[1]}
        </a>
      );
    } else if (token.startsWith('*')) {
      nodes.push(<em key={key}>{token.slice(1, -1)}</em>);
    }
    lastIndex = re.lastIndex;
  }
  if (lastIndex < text.length) nodes.push(text.slice(lastIndex));
  return nodes;
}

function renderPreview(content, onOpenLink, knownNames) {
  const lines = content.split('\n');
  const blocks = [];
  let listBuffer = [];
  let listType = null;

  const flushList = () => {
    if (!listBuffer.length) return;
    const Tag = listType === 'ol' ? 'ol' : 'ul';
    blocks.push(
      <Tag key={`list-${blocks.length}`}>
        {listBuffer.map((item, idx) => (
          <li key={idx}>{renderInline(item, `li-${blocks.length}-${idx}`, onOpenLink, knownNames)}</li>
        ))}
      </Tag>
    );
    listBuffer = [];
    listType = null;
  };

  lines.forEach((line, idx) => {
    const heading = line.match(/^(#{1,6})\s+(.*)$/);
    const quote = line.match(/^>\s?(.*)$/);
    const ul = line.match(/^[-*]\s+(.*)$/);
    const ol = line.match(/^\d+\.\s+(.*)$/);
    const hr = /^(-{3,}|\*{3,})$/.test(line.trim());

    if (heading) {
      flushList();
      const level = Math.min(heading[1].length, 6);
      blocks.push(React.createElement(`h${level}`, { key: idx }, renderInline(heading[2], `h-${idx}`, onOpenLink, knownNames)));
    } else if (hr) {
      flushList();
      blocks.push(<hr key={idx} />);
    } else if (quote) {
      flushList();
      blocks.push(<blockquote key={idx}>{renderInline(quote[1], `q-${idx}`, onOpenLink, knownNames)}</blockquote>);
    } else if (ul) {
      listType = 'ul';
      listBuffer.push(ul[1]);
    } else if (ol) {
      listType = 'ol';
      listBuffer.push(ol[1]);
    } else if (line.trim() === '') {
      flushList();
    } else {
      flushList();
      blocks.push(<p key={idx}>{renderInline(line, `p-${idx}`, onOpenLink, knownNames)}</p>);
    }
  });
  flushList();
  return blocks;
}

// ---------------------------------------------------------------------------
// UI: presentational components
// ---------------------------------------------------------------------------
function LoginScreen({ onSignIn, ready }) {
  return (
    <div className="center-screen">
      <div className="brand-mark" aria-hidden="true" />
      <h1>Vault</h1>
      <p className="muted">Your notes, in your Google Drive. Nothing stored on this device.</p>
      <button className="btn btn-primary" disabled={!ready} onClick={onSignIn}>
        {ready ? 'Sign in with Google' : 'Loading…'}
      </button>
    </div>
  );
}

function FolderPrompt({ onPick }) {
  return (
    <div className="center-screen">
      <div className="brand-mark" aria-hidden="true" />
      <h1>Choose your vault</h1>
      <p className="muted">Pick the Google Drive folder that holds (or will hold) your .md notes.</p>
      <button className="btn btn-primary" onClick={onPick}>
        Select Drive folder
      </button>
    </div>
  );
}

function TopBar({ folderName, syncing, syncError, onSync, onNewNote, onChangeFolder, onSignOut, onToggleSidebar, dirty, saving }) {
  return (
    <header className="topbar">
      <button className="icon-btn sidebar-toggle" onClick={onToggleSidebar} aria-label="Toggle sidebar">
        ☰
      </button>
      <div className="topbar-title">
        <span className="vault-name">{folderName}</span>
        <span className="save-state">{saving ? 'Saving…' : dirty ? 'Unsaved changes' : 'Saved'}</span>
      </div>
      <div className="topbar-actions">
        {syncError && <span className="sync-error" title={syncError}>Sync error</span>}
        <button className="icon-btn" onClick={onNewNote} title="New note">＋</button>
        <button className="icon-btn" onClick={onChangeFolder} title="Change vault folder">📁</button>
        <button className="icon-btn" onClick={onSync} title="Sync now" disabled={syncing}>
          {syncing ? '…' : '⟳'}
        </button>
        <button className="icon-btn" onClick={onSignOut} title="Sign out">⏻</button>
      </div>
    </header>
  );
}

// Small "⋮" popover menu attached to each tree row — actions differ for
// folders (can contain new notes/folders) vs files.
function TreeMenu({ isFolder, onNewNote, onNewFolder, onRename, onDelete }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="tree-menu-wrap">
      <button
        className="tree-menu-btn"
        onClick={(e) => {
          e.stopPropagation();
          setOpen((v) => !v);
        }}
        aria-label="More actions"
      >
        ⋮
      </button>
      {open && (
        <div className="tree-menu" onMouseLeave={() => setOpen(false)}>
          {isFolder && (
            <button
              onClick={(e) => {
                e.stopPropagation();
                setOpen(false);
                onNewNote();
              }}
            >
              New note
            </button>
          )}
          {isFolder && (
            <button
              onClick={(e) => {
                e.stopPropagation();
                setOpen(false);
                onNewFolder();
              }}
            >
              New folder
            </button>
          )}
          <button
            onClick={(e) => {
              e.stopPropagation();
              setOpen(false);
              onRename();
            }}
          >
            Rename
          </button>
          <button
            className="danger"
            onClick={(e) => {
              e.stopPropagation();
              setOpen(false);
              onDelete();
            }}
          >
            Delete
          </button>
        </div>
      )}
    </div>
  );
}

function TreeNode({ node, depth, currentId, expanded, onToggleExpand, onOpenFile, onCreateNote, onCreateFolder, onRename, onDelete }) {
  const indent = { paddingLeft: 10 + depth * 14 };

  if (node.type === 'file') {
    return (
      <div className="tree-row">
        <button
          className={`tree-item tree-file ${node.id === currentId ? 'active' : ''}`}
          style={indent}
          onClick={() => onOpenFile(node.id)}
        >
          <span className="tree-icon">📄</span>
          <span className="tree-label">{node.name.replace(/\.md$/i, '')}</span>
        </button>
        <TreeMenu isFolder={false} onRename={() => onRename(node)} onDelete={() => onDelete(node)} />
      </div>
    );
  }

  const isOpen = expanded.has(node.id);
  return (
    <div>
      <div className="tree-row">
        <button className="tree-item tree-folder" style={indent} onClick={() => onToggleExpand(node.id)}>
          <span className="tree-caret">{isOpen ? '▾' : '▸'}</span>
          <span className="tree-icon">📁</span>
          <span className="tree-label">{node.name}</span>
        </button>
        <TreeMenu
          isFolder
          onNewNote={() => onCreateNote(node.id)}
          onNewFolder={() => onCreateFolder(node.id)}
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
            currentId={currentId}
            expanded={expanded}
            onToggleExpand={onToggleExpand}
            onOpenFile={onOpenFile}
            onCreateNote={onCreateNote}
            onCreateFolder={onCreateFolder}
            onRename={onRename}
            onDelete={onDelete}
          />
        ))}
    </div>
  );
}

function Sidebar({
  tree,
  files,
  vaultRootId,
  currentId,
  onOpenFile,
  search,
  setSearch,
  backlinks,
  onCreateNote,
  onCreateFolder,
  onRename,
  onDelete
}) {
  const [expanded, setExpanded] = useState(new Set());
  const toggleExpand = (id) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });

  const searching = search.trim().length > 0;
  const flatMatches = searching ? flattenFiles(files, search.trim()) : [];

  return (
    <aside className="sidebar">
      <div className="sidebar-toolbar">
        <input
          className="search-input"
          placeholder="Search notes…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <button className="icon-btn" title="New note in vault root" onClick={() => onCreateNote(vaultRootId)}>＋</button>
        <button className="icon-btn" title="New folder in vault root" onClick={() => onCreateFolder(vaultRootId)}>📁＋</button>
      </div>

      <nav className="file-tree">
        {searching ? (
          <>
            {flatMatches.map((f) => (
              <div className="tree-row" key={f.id}>
                <button
                  className={`tree-item tree-file ${f.id === currentId ? 'active' : ''}`}
                  style={{ paddingLeft: 10 }}
                  onClick={() => onOpenFile(f.id)}
                >
                  <span className="tree-icon">📄</span>
                  <span className="tree-label">{f.name.replace(/\.md$/i, '')}</span>
                </button>
              </div>
            ))}
            {flatMatches.length === 0 && <p className="muted small">No notes match.</p>}
          </>
        ) : (
          <>
            {tree.map((node) => (
              <TreeNode
                key={node.id}
                node={node}
                depth={0}
                currentId={currentId}
                expanded={expanded}
                onToggleExpand={toggleExpand}
                onOpenFile={onOpenFile}
                onCreateNote={onCreateNote}
                onCreateFolder={onCreateFolder}
                onRename={onRename}
                onDelete={onDelete}
              />
            ))}
            {tree.length === 0 && <p className="muted small">Empty vault — use ＋ to add a note.</p>}
          </>
        )}
      </nav>

      <div className="backlinks-panel">
        <h3>Backlinks</h3>
        {backlinks.length === 0 && <p className="muted small">No notes link here yet.</p>}
        {backlinks.map((f) => (
          <button key={f.id} className="backlink-item" onClick={() => onOpenFile(f.id)}>
            {f.name.replace(/\.md$/i, '')}
          </button>
        ))}
      </div>
    </aside>
  );
}

function Editor({ file, content, onChange, onOpenLink, knownNames, mode, setMode }) {
  if (!file) {
    return (
      <main className="editor-empty">
        <p className="muted">Select a note, or click a [[wikilink]] to create one.</p>
      </main>
    );
  }
  return (
    <main className={`editor-shell mode-${mode}`}>
      <div className="editor-tabs">
        <button className={mode === 'split' ? 'active' : ''} onClick={() => setMode('split')}>Split</button>
        <button className={mode === 'edit' ? 'active' : ''} onClick={() => setMode('edit')}>Edit</button>
        <button className={mode === 'preview' ? 'active' : ''} onClick={() => setMode('preview')}>Preview</button>
      </div>
      <div className="editor-panes">
        {mode !== 'preview' && (
          <textarea
            className="editor-textarea"
            value={content}
            onChange={(e) => onChange(e.target.value)}
            spellCheck={false}
            placeholder="Start writing… use [[Note Name]] to link."
          />
        )}
        {mode !== 'edit' && (
          <div className="editor-preview">{renderPreview(content, onOpenLink, knownNames)}</div>
        )}
      </div>
    </main>
  );
}

// ---------------------------------------------------------------------------
// App — top-level composition and view-transition wiring
// ---------------------------------------------------------------------------
export default function App() {
  const { token, gisReady, signIn, signOut } = useGoogleAuth();
  const [folder, setFolder] = useState(null);
  const sync = useVaultSync(token, folder);

  const [currentFile, setCurrentFile] = useState(null);
  const [content, setContent] = useState('');
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [search, setSearch] = useState('');
  const [mode, setMode] = useState(window.innerWidth < 768 ? 'edit' : 'split');

  const saveTimer = useRef(null);

  // Restore the last-selected vault folder (an ID string, not note content).
  useEffect(() => {
    idbGet(STORE_META, 'vaultFolder').then((rec) => {
      if (rec) setFolder(rec.value);
    });
  }, []);

  // Kick off a diff-sync whenever we have both a token and a folder.
  useEffect(() => {
    if (token && folder) sync.syncNow();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token, folder?.id]);

  // Used both for the first-time folder prompt and for switching vaults
  // later from the top bar. Resets editor + sync state so nothing from the
  // previous vault lingers on screen.
  const handlePickFolder = useCallback(async () => {
    if (!token) return;
    const picked = await openFolderPicker(token);
    if (picked) {
      sync.resetVault();
      setFolder(picked);
      idbPut(STORE_META, { key: 'vaultFolder', value: picked });
      setCurrentFile(null);
      setContent('');
      setDirty(false);
      setSearch('');
      setSidebarOpen(false);
    }
  }, [token, sync]);

  const saveNow = useCallback(
    async (value) => {
      if (!currentFile || !token) return;
      setSaving(true);
      try {
        const updated = await driveUpdateFileContent(token, currentFile.id, value);
        sync.applyLocalEdit(currentFile.id, value, updated.modifiedTime || new Date().toISOString());
        setDirty(false);
      } catch (err) {
        console.error(err);
      } finally {
        setSaving(false);
      }
    },
    [currentFile, token, sync]
  );

  const openNoteById = useCallback(
    async (id) => {
      const meta = sync.filesMeta.find((f) => f.id === id);
      if (!meta || !token) return;
      const text = await driveGetFileContent(token, id);
      setCurrentFile(meta);
      setContent(text);
      setDirty(false);
      setSidebarOpen(false);
    },
    [token, sync.filesMeta]
  );

  const openNoteByName = useCallback(
    async (name) => {
      const normalized = normalizeNoteName(name);
      const existing = sync.filesMeta.find((f) => normalizeNoteName(f.name) === normalized);
      if (existing) return openNoteById(existing.id);
      if (!folder || !token) return;
      const skeleton = `# ${name}\n\n`;
      const created = await driveCreateFile(token, folder.id, name, skeleton);
      const fileRecord = {
        id: created.id,
        name: created.name,
        modifiedTime: created.modifiedTime || new Date().toISOString(),
        parents: [folder.id]
      };
      sync.registerNewFile(fileRecord);
      setCurrentFile(fileRecord);
      setContent(skeleton);
      setDirty(false);
      setSidebarOpen(false);
    },
    [token, folder, sync, openNoteById]
  );

  // Flush any pending save before switching notes so nothing is lost.
  const navigateTo = useCallback(
    async (opener) => {
      if (dirty && currentFile) {
        if (saveTimer.current) clearTimeout(saveTimer.current);
        await saveNow(content);
      }
      await opener();
    },
    [dirty, currentFile, content, saveNow]
  );

  const handleContentChange = useCallback(
    (value) => {
      setContent(value);
      setDirty(true);
      if (saveTimer.current) clearTimeout(saveTimer.current);
      saveTimer.current = setTimeout(() => saveNow(value), 1200);
    },
    [saveNow]
  );

  // Manual save shortcut.
  useEffect(() => {
    const handler = (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 's') {
        e.preventDefault();
        if (saveTimer.current) clearTimeout(saveTimer.current);
        saveNow(content);
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [content, saveNow]);

  // Create a note inside a specific folder (root or any subfolder), used by
  // the sidebar's root-level "+", each folder's context menu, and the top
  // bar's quick-add button (which always targets the vault root).
  const handleCreateNoteIn = useCallback(
    (parentId) => {
      const name = window.prompt('New note name:');
      if (!name || !name.trim()) return;
      navigateTo(async () => {
        try {
          const skeleton = `# ${name.trim()}\n\n`;
          const created = await driveCreateFile(token, parentId, name.trim(), skeleton);
          const fileRecord = {
            id: created.id,
            name: created.name,
            modifiedTime: created.modifiedTime || new Date().toISOString(),
            parents: [parentId]
          };
          sync.registerNewFile(fileRecord);
          setCurrentFile(fileRecord);
          setContent(skeleton);
          setDirty(false);
          setSidebarOpen(false);
        } catch (err) {
          window.alert(`Couldn't create note: ${err.message}`);
        }
      });
    },
    [token, sync, navigateTo]
  );

  const handleCreateFolderIn = useCallback(
    async (parentId) => {
      const name = window.prompt('New folder name:');
      if (!name || !name.trim()) return;
      try {
        const created = await driveCreateFolder(token, parentId, name.trim());
        sync.registerNewFolder({ id: created.id, name: created.name, parents: [parentId] });
      } catch (err) {
        window.alert(`Couldn't create folder: ${err.message}`);
      }
    },
    [token, sync]
  );

  const handleRenameNode = useCallback(
    async (node) => {
      const currentDisplayName = node.type === 'file' ? node.name.replace(/\.md$/i, '') : node.name;
      const input = window.prompt('Rename to:', currentDisplayName);
      if (!input || !input.trim() || input.trim() === currentDisplayName) return;
      const newName =
        node.type === 'file'
          ? input.trim().toLowerCase().endsWith('.md')
            ? input.trim()
            : `${input.trim()}.md`
          : input.trim();
      try {
        await driveRenameItem(token, node.id, newName);
        if (node.type === 'file') {
          sync.renameFile(node.id, newName);
          setCurrentFile((prev) => (prev && prev.id === node.id ? { ...prev, name: newName } : prev));
        } else {
          sync.renameFolder(node.id, newName);
        }
      } catch (err) {
        window.alert(`Couldn't rename: ${err.message}`);
      }
    },
    [token, sync]
  );

  const handleDeleteNode = useCallback(
    async (node) => {
      const label = node.type === 'file' ? node.name.replace(/\.md$/i, '') : node.name;
      const warning =
        node.type === 'folder'
          ? `Delete folder "${label}" and everything inside it? This moves it to Drive's trash.`
          : `Delete note "${label}"? This moves it to Drive's trash.`;
      if (!window.confirm(warning)) return;
      try {
        await driveTrashItem(token, node.id);
        if (node.type === 'file') {
          sync.removeFile(node.id);
          if (currentFile?.id === node.id) {
            setCurrentFile(null);
            setContent('');
            setDirty(false);
          }
        } else {
          const removedFileIds = sync.removeFolder(node.id);
          if (currentFile && removedFileIds.includes(currentFile.id)) {
            setCurrentFile(null);
            setContent('');
            setDirty(false);
          }
        }
      } catch (err) {
        window.alert(`Couldn't delete: ${err.message}`);
      }
    },
    [token, sync, currentFile]
  );

  const tree = useMemo(
    () => buildVaultTree(folder?.id, sync.foldersMeta, sync.filesMeta),
    [folder?.id, sync.foldersMeta, sync.filesMeta]
  );

  const knownNames = new Set(sync.filesMeta.map((f) => normalizeNoteName(f.name)));
  const backlinksForCurrent = currentFile
    ? Array.from(sync.backlinkIndex.get(currentFile.id) || [])
        .map((id) => sync.filesMeta.find((f) => f.id === id))
        .filter(Boolean)
    : [];

  if (!token) {
    return <LoginScreen onSignIn={signIn} ready={gisReady} />;
  }
  if (!folder) {
    return <FolderPrompt onPick={handlePickFolder} />;
  }

  return (
    <div className="app-shell">
      <TopBar
        folderName={folder.name}
        syncing={sync.syncing}
        syncError={sync.syncError}
        onSync={sync.syncNow}
        onNewNote={() => handleCreateNoteIn(folder.id)}
        onChangeFolder={handlePickFolder}
        onSignOut={signOut}
        onToggleSidebar={() => setSidebarOpen((v) => !v)}
        dirty={dirty}
        saving={saving}
      />
      <div className={`workspace ${sidebarOpen ? 'sidebar-open' : ''}`}>
        <Sidebar
          tree={tree}
          files={sync.filesMeta}
          vaultRootId={folder.id}
          currentId={currentFile?.id}
          onOpenFile={(id) => navigateTo(() => openNoteById(id))}
          search={search}
          setSearch={setSearch}
          backlinks={backlinksForCurrent}
          onCreateNote={handleCreateNoteIn}
          onCreateFolder={handleCreateFolderIn}
          onRename={handleRenameNode}
          onDelete={handleDeleteNode}
        />
        <div className="sidebar-scrim" onClick={() => setSidebarOpen(false)} />
        <Editor
          file={currentFile}
          content={content}
          onChange={handleContentChange}
          onOpenLink={(name) => navigateTo(() => openNoteByName(name))}
          knownNames={knownNames}
          mode={mode}
          setMode={setMode}
        />
      </div>
    </div>
  );
}
