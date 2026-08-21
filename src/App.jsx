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
 *
 *   Images follow the same rule: only their metadata (id/name/modifiedTime)
 *   is cached in IndexedDB. Image bytes are fetched on demand (when actually
 *   viewed or embedded) and kept only as in-memory blob URLs for the current
 *   session — never persisted.
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
const STORE_FILES = 'files'; // { id, name, modifiedTime, parents, mimeType, kind }  -- metadata only
const STORE_FOLDERS = 'folders'; // { id, name, parents } -- structure only, no content
const STORE_LINKS = 'links'; // { fileId, links: [{target, alias}], cachedAt } -- graph only
const STORE_META = 'meta'; // { key, value } -- app settings (vault folder id, etc.)

// How many Drive content requests run in parallel during a sync. Large
// vaults previously fetched every file's body one request at a time (a full
// network round-trip per file, strictly serialized) — that was the single
// biggest cause of "loading a big vault takes forever". Running several
// requests concurrently cuts wall-clock sync time roughly by this factor,
// while staying comfortably under Drive's per-user rate limits.
const FETCH_CONCURRENCY = 8;

// Image files participate in the vault (sidebar, viewing, [[links]]) the
// same way notes do, but their bytes are only ever fetched on demand
// (viewing or embedding) — never during a sync — so a vault full of
// screenshots never adds to sync time.
const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp']);
const IMAGE_MIME_TYPES = [
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'image/svg+xml',
  'image/bmp'
];

function fileExtension(name) {
  const m = /\.([a-z0-9]+)$/i.exec(name || '');
  return m ? m[1].toLowerCase() : '';
}

function isImageName(name) {
  return IMAGE_EXTENSIONS.has(fileExtension(name));
}

// ---------------------------------------------------------------------------
// Concurrency helpers
// ---------------------------------------------------------------------------
// Runs `worker` over `items` with at most `limit` in flight at once,
// preserving each result's original position. A single slow/failing item
// only occupies one of the `limit` lanes — the rest keep moving. Returns
// { ok, value } or { ok: false, error } per item (never throws itself).
async function mapWithConcurrency(items, limit, worker) {
  const results = new Array(items.length);
  let next = 0;
  async function lane() {
    while (next < items.length) {
      const i = next++;
      try {
        results[i] = { ok: true, value: await worker(items[i], i) };
      } catch (err) {
        results[i] = { ok: false, error: err };
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, lane));
  return results;
}

// Small retry wrapper for transient Drive errors (429 rate limit, 5xx).
// Running requests concurrently makes hitting these more likely than the
// old one-at-a-time loop did, so it matters more now than it used to.
async function withRetry(fn, retries = 2, baseDelayMs = 400) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      const status = err?.status;
      const retriable = status === 429 || (status >= 500 && status < 600);
      if (!retriable || attempt === retries) throw err;
      await new Promise((r) => setTimeout(r, baseDelayMs * 2 ** attempt));
    }
  }
  throw lastErr;
}

// ---------------------------------------------------------------------------
// IndexedDB — transient cache only. No note or image bodies ever touch
// these stores.
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
// RegExp wikilink parsing
// ---------------------------------------------------------------------------
// Matches [[Target]], [[Target#heading]], [[Target|Alias]], and their
// embed form ![[Target]] (the leading "!" is accepted but not required —
// see the smart-linking section below for why image links don't need it).
function parseWikilinks(content) {
  const re = /!?\[\[([^[\]|#]+)(?:#[^[\]|]*)?(?:\|([^[\]]+))?\]\]/g;
  const links = [];
  let m;
  while ((m = re.exec(content)) !== null) {
    links.push({ target: m[1].trim(), alias: m[2] ? m[2].trim() : null });
  }
  return links;
}

// ---------------------------------------------------------------------------
// Smart link resolution — mirrors how Obsidian resolves [[wikilinks]]:
//   - A link that's just a name ("Notes") matches by filename anywhere in
//     the vault, *as long as that name is unique*.
//   - If two or more files share that name, a bare name is ambiguous —
//     disambiguation requires the full path from the vault root
//     ("Projects/Notes").
//   - Note links omit the .md extension, same as before. Image links always
//     keep their extension (e.g. [[diagram.png]]) since that's the only way
//     to tell "diagram.png" and "diagram.svg" apart, and since an image
//     can't be created/renamed from inside a broken link the way a note can.
// ---------------------------------------------------------------------------
function buildLinkIndex(files, folders, rootId) {
  const folderById = new Map(folders.map((f) => [f.id, f]));
  const pathCache = new Map();

  function folderPath(folderId) {
    if (!folderId || folderId === rootId) return '';
    if (pathCache.has(folderId)) return pathCache.get(folderId);
    const f = folderById.get(folderId);
    if (!f) return '';
    const parentId = (f.parents && f.parents[0]) || rootId;
    const parentPath = folderPath(parentId);
    const full = parentPath ? `${parentPath}/${f.name}` : f.name;
    pathCache.set(folderId, full);
    return full;
  }

  const records = files.map((f) => {
    const parentId = (f.parents && f.parents[0]) || rootId;
    const dir = folderPath(parentId);
    const isImage = f.kind === 'image' || isImageName(f.name);
    const baseName = isImage ? f.name : f.name.replace(/\.md$/i, '');
    const relativePath = dir ? `${dir}/${baseName}` : baseName;
    return { ...f, isImage, baseName, relativePath };
  });

  const byBasenameKey = new Map();
  const byRelativePath = new Map();
  records.forEach((r) => {
    const key = `${r.isImage ? 'img' : 'note'}:${r.baseName.toLowerCase()}`;
    if (!byBasenameKey.has(key)) byBasenameKey.set(key, []);
    byBasenameKey.get(key).push(r);
    byRelativePath.set(r.relativePath.toLowerCase(), r);
  });

  return { records, byBasenameKey, byRelativePath };
}

// Resolves the text inside a [[...]] (already stripped of any |alias or
// #heading) against the current vault. One of:
//   { status: 'resolved', file }
//   { status: 'missing', isImage }                  -- no such file (yet)
//   { status: 'ambiguous', isImage, candidates }      -- name matches 2+ files
function resolveLinkTarget(rawTarget, linkIndex) {
  const target = String(rawTarget || '').trim();
  const isImage = isImageName(target);
  const cleaned = isImage ? target : target.replace(/\.md$/i, '');

  if (cleaned.includes('/')) {
    const hit = linkIndex.byRelativePath.get(cleaned.toLowerCase());
    return hit ? { status: 'resolved', file: hit } : { status: 'missing', isImage };
  }

  const key = `${isImage ? 'img' : 'note'}:${cleaned.toLowerCase()}`;
  const matches = linkIndex.byBasenameKey.get(key) || [];
  if (matches.length === 1) return { status: 'resolved', file: matches[0] };
  if (matches.length === 0) return { status: 'missing', isImage };
  return {
    status: 'ambiguous',
    isImage,
    candidates: matches.slice().sort((a, b) => a.relativePath.localeCompare(b.relativePath))
  };
}

// The link text to insert when autocomplete (or a "resolve this" action)
// picks `file` — the bare name if that's unambiguous vault-wide, otherwise
// the full path from the vault root. This is the other half of the smart
// linking behavior: it's what keeps typed links short by default.
function bestLinkTextFor(file, linkIndex) {
  const key = `${file.isImage ? 'img' : 'note'}:${file.baseName.toLowerCase()}`;
  const matches = linkIndex.byBasenameKey.get(key) || [];
  return matches.length <= 1 ? file.baseName : file.relativePath;
}

// Builds fileId -> Set(fileId) map of inbound links, resolved through the
// same smart resolver used for click-through and rendering (so backlinks
// stay consistent with what a link actually resolves to, ambiguous and
// missing links included/excluded the same way).
function buildBacklinkIndex(fileRecords, linksByFileId, linkIndex) {
  const backlinks = new Map();
  fileRecords.forEach((f) => backlinks.set(f.id, new Set()));

  for (const [sourceId, links] of linksByFileId.entries()) {
    for (const link of links) {
      const res = resolveLinkTarget(link.target, linkIndex);
      if (res.status === 'resolved' && res.file.id !== sourceId) {
        if (!backlinks.has(res.file.id)) backlinks.set(res.file.id, new Set());
        backlinks.get(res.file.id).add(sourceId);
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

function driveError(res, label) {
  const err = new Error(`${label} (${res.status})`);
  err.status = res.status;
  return err;
}

// Real vaults are almost always nested (subfolders for daily notes,
// attachments, etc). Drive's API has no recursive "in ancestors" query, so
// we BFS the folder tree ourselves, one level at a time. Different chunks
// *within* a level are independent queries, so they run concurrently —
// only the pagination within a single chunk has to stay sequential.
// Returns full {id,name,parents} records (not just ids) for the vault's
// SUBfolders — the root itself is not included, since it's represented
// separately as the vault folder.
async function driveListFolderTree(token, rootFolderId) {
  const allFolders = [];
  let frontier = [rootFolderId];
  while (frontier.length) {
    const chunks = chunkArray(frontier, 10);
    const chunkResults = await Promise.all(
      chunks.map(async (chunk) => {
        const parentClauses = chunk.map((id) => `'${id}' in parents`).join(' or ');
        const q = encodeURIComponent(`(${parentClauses}) and mimeType = 'application/vnd.google-apps.folder' and trashed = false`);
        const fields = encodeURIComponent('files(id,name,parents),nextPageToken');
        let pageToken = '';
        const found = [];
        do {
          const url = `${DRIVE_FILES_URL}?q=${q}&fields=${fields}&pageSize=1000&${DRIVE_ALL_DRIVES}${
            pageToken ? `&pageToken=${pageToken}` : ''
          }`;
          const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
          if (!res.ok) throw driveError(res, 'Drive folder list failed');
          const data = await res.json();
          found.push(...(data.files || []));
          pageToken = data.nextPageToken || '';
        } while (pageToken);
        return found;
      })
    );
    const nextFrontier = [];
    chunkResults.flat().forEach((f) => {
      allFolders.push(f);
      nextFrontier.push(f.id);
    });
    frontier = nextFrontier;
  }
  return allFolders;
}

// Lists every note (.md) AND image file across the given folder ids in one
// pass — a single Drive query covers both kinds (rather than two separate
// listing round-trips), and chunks of folder ids are queried concurrently.
async function driveListVaultContentInFolders(token, folderIds) {
  const mimeClauses = [
    "mimeType = 'text/markdown'",
    "mimeType = 'text/plain'",
    "fileExtension = 'md'",
    ...IMAGE_MIME_TYPES.map((m) => `mimeType = '${m}'`)
  ].join(' or ');

  const chunks = chunkArray(folderIds, 10);
  const chunkResults = await Promise.all(
    chunks.map(async (chunk) => {
      const parentClauses = chunk.map((id) => `'${id}' in parents`).join(' or ');
      const q = encodeURIComponent(`(${parentClauses}) and trashed = false and (${mimeClauses})`);
      const fields = encodeURIComponent('files(id,name,modifiedTime,parents,mimeType,size),nextPageToken');
      let pageToken = '';
      const found = [];
      do {
        const url = `${DRIVE_FILES_URL}?q=${q}&fields=${fields}&pageSize=1000&orderBy=name&${DRIVE_ALL_DRIVES}${
          pageToken ? `&pageToken=${pageToken}` : ''
        }`;
        const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
        if (!res.ok) throw driveError(res, 'Drive list failed');
        const data = await res.json();
        found.push(...(data.files || []));
        pageToken = data.nextPageToken || '';
      } while (pageToken);
      return found;
    })
  );

  return chunkResults.flat().map((f) => ({
    ...f,
    kind: isImageName(f.name) || IMAGE_MIME_TYPES.includes(f.mimeType) ? 'image' : 'note'
  }));
}

// Returns the full vault contents: every subfolder record, and every
// note/image file across the root + all subfolders.
async function driveListVaultFiles(token, rootFolderId) {
  const folders = await driveListFolderTree(token, rootFolderId);
  const folderIds = [rootFolderId, ...folders.map((f) => f.id)];
  const files = await driveListVaultContentInFolders(token, folderIds);
  return { folders, files };
}

async function driveGetFileContent(token, fileId) {
  const res = await fetch(`${DRIVE_FILES_URL}/${fileId}?alt=media&${DRIVE_ALL_DRIVES}`, {
    headers: { Authorization: `Bearer ${token}` }
  });
  if (!res.ok) throw driveError(res, 'Drive fetch failed');
  return res.text();
}

// Same request as above, but returns a Blob — used for images, which are
// fetched on demand only (see the constant comment on FETCH_CONCURRENCY).
async function driveGetFileBlob(token, fileId) {
  const res = await fetch(`${DRIVE_FILES_URL}/${fileId}?alt=media&${DRIVE_ALL_DRIVES}`, {
    headers: { Authorization: `Bearer ${token}` }
  });
  if (!res.ok) throw driveError(res, 'Drive fetch failed');
  return res.blob();
}

async function driveUpdateFileContent(token, fileId, content) {
  const res = await fetch(`${DRIVE_UPLOAD_URL}/${fileId}?uploadType=media&${DRIVE_ALL_DRIVES}`, {
    method: 'PATCH',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'text/markdown' },
    body: content
  });
  if (!res.ok) throw driveError(res, 'Drive save failed');
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
  if (!res.ok) throw driveError(res, 'Drive create failed');
  return res.json();
}

async function driveCreateFolder(token, parentId, name) {
  const res = await fetch(`${DRIVE_FILES_URL}?fields=id,name,parents&${DRIVE_ALL_DRIVES}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, parents: [parentId], mimeType: 'application/vnd.google-apps.folder' })
  });
  if (!res.ok) throw driveError(res, 'Drive folder create failed');
  return res.json();
}

// Renames a file or folder (metadata-only PATCH — content untouched).
async function driveRenameItem(token, id, newName) {
  const res = await fetch(`${DRIVE_FILES_URL}/${id}?fields=id,name&${DRIVE_ALL_DRIVES}`, {
    method: 'PATCH',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: newName })
  });
  if (!res.ok) throw driveError(res, 'Drive rename failed');
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
  if (!res.ok) throw driveError(res, 'Drive delete failed');
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
    releaseImageUrlCache();
    setToken('');
  }, [token]);

  return { token, gisReady, signIn, signOut };
}

// ---------------------------------------------------------------------------
// Vault sync engine — diffs Drive against the IndexedDB cache, fetches only
// new/modified note bodies (concurrently), and maintains the in-memory
// backlink graph. Also seeds state instantly from whatever's cached locally
// so reopening a previously-loaded vault doesn't reshow a blank sidebar
// while a fresh listing comes back.
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
        loaded += 1;
        setSyncProgress({ phase: 'fetching-content', loaded, total: toFetch.length });
        return { fileId: file.id, links: parseWikilinks(content), cachedAt: Date.now() };
      });

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
      kind: f.kind === 'image' ? 'image' : 'note',
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
// Drive image blob cache — module-level so the same image is never fetched
// twice in a session, no matter how many places embed/view it. Object URLs
// are revoked on sign-out / vault switch (see releaseImageUrlCache below).
// This lives only in memory: it is never written to IndexedDB.
// ---------------------------------------------------------------------------
const imageUrlCache = new Map(); // fileId -> objectURL
const imageUrlPromises = new Map(); // fileId -> in-flight Promise<objectURL>

function releaseImageUrlCache() {
  imageUrlCache.forEach((url) => URL.revokeObjectURL(url));
  imageUrlCache.clear();
  imageUrlPromises.clear();
}

function useDriveImageUrl(token, fileId) {
  const [url, setUrl] = useState(() => (fileId ? imageUrlCache.get(fileId) || null : null));
  const [error, setError] = useState('');

  useEffect(() => {
    if (!fileId || !token) return;
    let cancelled = false;
    const cached = imageUrlCache.get(fileId);
    if (cached) {
      setUrl(cached);
      return;
    }
    setUrl(null);
    setError('');
    let promise = imageUrlPromises.get(fileId);
    if (!promise) {
      promise = driveGetFileBlob(token, fileId).then((blob) => {
        const objectUrl = URL.createObjectURL(blob);
        imageUrlCache.set(fileId, objectUrl);
        return objectUrl;
      });
      imageUrlPromises.set(fileId, promise);
      promise.finally(() => imageUrlPromises.delete(fileId));
    }
    promise
      .then((objectUrl) => {
        if (!cancelled) setUrl(objectUrl);
      })
      .catch((err) => {
        if (!cancelled) setError(err.message || 'Failed to load image');
      });
    return () => {
      cancelled = true;
    };
  }, [token, fileId]);

  return { url, error };
}

// ---------------------------------------------------------------------------
// Caret-position helper for the link-typing autocomplete — a <textarea> has
// no built-in way to ask "where on screen is character N", so this mirrors
// the textarea's text into an off-screen div with identical font/box
// styling and reads back the position of a marker placed at that character.
// ---------------------------------------------------------------------------
function getCaretCoordinates(textarea, position) {
  const div = document.createElement('div');
  const style = getComputedStyle(textarea);
  const properties = [
    'boxSizing',
    'width',
    'fontFamily',
    'fontSize',
    'fontWeight',
    'lineHeight',
    'letterSpacing',
    'paddingTop',
    'paddingRight',
    'paddingBottom',
    'paddingLeft',
    'borderTopWidth',
    'borderRightWidth',
    'borderBottomWidth',
    'borderLeftWidth'
  ];
  properties.forEach((p) => {
    div.style[p] = style[p];
  });
  div.style.position = 'absolute';
  div.style.visibility = 'hidden';
  div.style.whiteSpace = 'pre-wrap';
  div.style.overflowWrap = 'break-word';
  div.style.top = '0';
  div.style.left = '-9999px';
  div.style.height = 'auto';

  div.textContent = textarea.value.slice(0, position);
  const marker = document.createElement('span');
  marker.textContent = '\u200b';
  div.appendChild(marker);
  document.body.appendChild(div);

  const lineHeight = parseFloat(style.lineHeight) || 20;
  const top = marker.offsetTop - textarea.scrollTop + lineHeight;
  const left = marker.offsetLeft - textarea.scrollLeft;

  document.body.removeChild(div);
  return { top, left };
}

// Powers the [[link autocomplete dropdown. Reads/writes the textarea's DOM
// value directly (rather than through the React `content` prop) so it never
// races a stale closure against the just-typed keystroke.
function useLinkAutocomplete(textareaRef, onChange, linkIndex) {
  const [state, setState] = useState(null); // { start, items, activeIndex, top, left }

  const computeSuggestions = useCallback(
    (query) => {
      const q = query.toLowerCase();
      const scoreOf = (hay) => (q ? hay.indexOf(q) : 0);
      const byBase = linkIndex.records
        .map((r) => ({ r, score: scoreOf(r.baseName.toLowerCase()) }))
        .filter((s) => s.score !== -1);
      const pool = byBase.length
        ? byBase
        : linkIndex.records.map((r) => ({ r, score: scoreOf(r.relativePath.toLowerCase()) })).filter((s) => s.score !== -1);
      return pool
        .sort((a, b) => a.score - b.score || a.r.baseName.localeCompare(b.r.baseName))
        .slice(0, 8)
        .map((s) => s.r);
    },
    [linkIndex]
  );

  const updateFromCaret = useCallback(() => {
    const ta = textareaRef.current;
    if (!ta) {
      setState(null);
      return;
    }
    const value = ta.value;
    const pos = ta.selectionStart;
    const windowStart = Math.max(0, pos - 200);
    const before = value.slice(windowStart, pos);
    const openIdx = before.lastIndexOf('[[');
    if (openIdx === -1) {
      setState(null);
      return;
    }
    const between = before.slice(openIdx + 2);
    // Don't trigger across a line break, once an alias "|" has been typed,
    // or once the link's already been closed.
    if (between.includes(']]') || between.includes('|') || between.includes('\n')) {
      setState(null);
      return;
    }

    const items = computeSuggestions(between);
    if (!items.length) {
      setState(null);
      return;
    }

    const coords = getCaretCoordinates(ta, pos);
    setState({ start: windowStart + openIdx, items, activeIndex: 0, top: coords.top, left: coords.left });
  }, [computeSuggestions, textareaRef]);

  const accept = useCallback(
    (file) => {
      const ta = textareaRef.current;
      if (!ta || !state) return;
      const pos = ta.selectionStart;
      const value = ta.value;
      const insertText = bestLinkTextFor(file, linkIndex);
      const alreadyClosed = value.slice(pos, pos + 2) === ']]';
      const next = value.slice(0, state.start) + '[[' + insertText + ']]' + value.slice(pos + (alreadyClosed ? 2 : 0));
      const caretPos = state.start + 2 + insertText.length + 2;
      setState(null);
      onChange(next);
      requestAnimationFrame(() => {
        ta.focus();
        ta.setSelectionRange(caretPos, caretPos);
      });
    },
    [state, onChange, linkIndex, textareaRef]
  );

  const dismiss = useCallback(() => setState(null), []);
  const move = useCallback((delta) => {
    setState((s) => (s ? { ...s, activeIndex: (s.activeIndex + delta + s.items.length) % s.items.length } : s));
  }, []);

  return { suggestion: state, updateFromCaret, accept, dismiss, move };
}

// ---------------------------------------------------------------------------
// Minimal markdown + wikilink renderer (no external markdown dependency)
// ---------------------------------------------------------------------------
function renderInline(text, keyPrefix, handlers, linkIndex) {
  const nodes = [];
  const re = /(!?\[\[[^[\]]+\]\])|(\*\*[^*]+\*\*)|(`[^`]+`)|(\[[^[\]]+\]\([^()\s]+\))|(\*[^*]+\*)/g;
  let lastIndex = 0;
  let match;
  let i = 0;
  while ((match = re.exec(text)) !== null) {
    if (match.index > lastIndex) nodes.push(text.slice(lastIndex, match.index));
    const token = match[0];
    const key = `${keyPrefix}-${i++}`;
    if (token.startsWith('[[') || token.startsWith('![[')) {
      const core = token.startsWith('!') ? token.slice(1) : token;
      const inner = core.slice(2, -2);
      const [rawTargetAndHeading, rawAlias] = inner.split('|');
      const rawTarget = rawTargetAndHeading.replace(/#.*$/, '').trim();
      const label = (rawAlias || rawTargetAndHeading).trim();
      const resolution = resolveLinkTarget(rawTarget, linkIndex);

      if (resolution.status === 'resolved' && resolution.file.isImage) {
        nodes.push(
          <ImageEmbed
            key={key}
            token={handlers.token}
            fileId={resolution.file.id}
            name={resolution.file.name}
            caption={rawAlias ? label : null}
            onOpen={() => handlers.onOpenImage(resolution.file)}
          />
        );
      } else if (resolution.status === 'resolved') {
        nodes.push(
          <span
            key={key}
            className="wikilink"
            onClick={() => handlers.onOpenById(resolution.file.id)}
            title={`Open ${resolution.file.baseName}`}
          >
            {label}
          </span>
        );
      } else if (resolution.status === 'ambiguous') {
        nodes.push(
          <AmbiguousLink
            key={key}
            label={label}
            candidates={resolution.candidates}
            onPick={(file) => (file.isImage ? handlers.onOpenImage(file) : handlers.onOpenById(file.id))}
          />
        );
      } else if (resolution.isImage) {
        nodes.push(
          <span key={key} className="wikilink wikilink-missing-image" title={`Image not found: ${rawTarget}`}>
            🖼 {rawTarget}
          </span>
        );
      } else {
        nodes.push(
          <span
            key={key}
            className="wikilink wikilink-new"
            onClick={() => handlers.onCreateOrOpenByName(rawTarget)}
            title={`Create "${rawTarget}"`}
          >
            {label}
          </span>
        );
      }
    } else if (token.startsWith('**')) {
      nodes.push(<strong key={key}>{token.slice(2, -2)}</strong>);
    } else if (token.startsWith('`')) {
      nodes.push(<code key={key}>{token.slice(1, -1)}</code>);
    } else if (token.startsWith('[')) {
      const m = token.match(/^\[([^[\]]+)\]\(([^()\s]+)\)$/);
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

function renderPreview(content, handlers, linkIndex) {
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
          <li key={idx}>{renderInline(item, `li-${blocks.length}-${idx}`, handlers, linkIndex)}</li>
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
      blocks.push(React.createElement(`h${level}`, { key: idx }, renderInline(heading[2], `h-${idx}`, handlers, linkIndex)));
    } else if (hr) {
      flushList();
      blocks.push(<hr key={idx} />);
    } else if (quote) {
      flushList();
      blocks.push(<blockquote key={idx}>{renderInline(quote[1], `q-${idx}`, handlers, linkIndex)}</blockquote>);
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
      blocks.push(<p key={idx}>{renderInline(line, `p-${idx}`, handlers, linkIndex)}</p>);
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
      <p className="muted">Pick the Google Drive folder that holds (or will hold) your notes.</p>
      <button className="btn btn-primary" onClick={onPick}>
        Select Drive folder
      </button>
    </div>
  );
}

// Full-screen, blocking loader shown only when there's nothing cached yet
// to show — i.e. the very first time a vault is opened on this device (or
// a genuinely empty vault). Repeat visits skip straight past this because
// useVaultSync seeds state from IndexedDB before this would ever render.
function VaultLoadingScreen({ progress }) {
  const { phase, loaded, total } = progress;
  const pct = total > 0 ? Math.round((loaded / total) * 100) : null;
  const label =
    phase === 'opening'
      ? 'Opening your vault…'
      : phase === 'listing-folders'
      ? 'Scanning folders…'
      : phase === 'listing-files'
      ? 'Listing notes and images…'
      : phase === 'fetching-content'
      ? total > 0
        ? `Loading ${loaded} of ${total} notes…`
        : 'Loading notes…'
      : 'Loading your vault…';
  return (
    <div className="center-screen">
      <div className="brand-mark" aria-hidden="true" />
      <h1>Vault</h1>
      <p className="muted">{label}</p>
      <div className="progress-bar">
        <div
          className={`progress-bar-fill ${pct === null ? 'indeterminate' : ''}`}
          style={pct !== null ? { width: `${pct}%` } : undefined}
        />
      </div>
      {pct !== null && <p className="muted small">{pct}%</p>}
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
        {syncError && (
          <span className="sync-error" title={syncError}>
            Sync error
          </span>
        )}
        <button className="icon-btn" onClick={onNewNote} title="New note">
          ＋
        </button>
        <button className="icon-btn" onClick={onChangeFolder} title="Change vault folder">
          📁
        </button>
        <button className="icon-btn" onClick={onSync} title="Sync now" disabled={syncing}>
          {syncing ? '…' : '⟳'}
        </button>
        <button className="icon-btn" onClick={onSignOut} title="Sign out">
          ⏻
        </button>
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

function TreeNode({
  node,
  depth,
  currentId,
  expanded,
  onToggleExpand,
  onOpenFile,
  onOpenImage,
  onCreateNote,
  onCreateFolder,
  onRename,
  onDelete
}) {
  const indent = { paddingLeft: 10 + depth * 14 };

  if (node.type === 'file') {
    const isImage = node.kind === 'image';
    return (
      <div className="tree-row">
        <button
          className={`tree-item tree-file ${node.id === currentId ? 'active' : ''}`}
          style={indent}
          onClick={() => (isImage ? onOpenImage(node) : onOpenFile(node.id))}
        >
          <span className="tree-icon">{isImage ? '🖼️' : '📄'}</span>
          <span className="tree-label">{isImage ? node.name : node.name.replace(/\.md$/i, '')}</span>
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
            onOpenImage={onOpenImage}
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
  onOpenImage,
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
          placeholder="Search notes and images…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <button className="icon-btn" title="New note in vault root" onClick={() => onCreateNote(vaultRootId)}>＋</button>
        <button className="icon-btn" title="New folder in vault root" onClick={() => onCreateFolder(vaultRootId)}>📁＋</button>
      </div>

      <nav className="file-tree">
        {searching ? (
          <>
            {flatMatches.map((f) => {
              const isImage = f.kind === 'image';
              return (
                <div className="tree-row" key={f.id}>
                  <button
                    className={`tree-item tree-file ${f.id === currentId ? 'active' : ''}`}
                    style={{ paddingLeft: 10 }}
                    onClick={() => (isImage ? onOpenImage(f) : onOpenFile(f.id))}
                  >
                    <span className="tree-icon">{isImage ? '🖼️' : '📄'}</span>
                    <span className="tree-label">{isImage ? f.name : f.name.replace(/\.md$/i, '')}</span>
                  </button>
                </div>
              );
            })}
            {flatMatches.length === 0 && <p className="muted small">No notes or images match.</p>}
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
                onOpenImage={onOpenImage}
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

// Inline popover for an ambiguous [[link]] — shown when a bare name matches
// more than one file, so the reader can pick which one was actually meant.
function AmbiguousLink({ label, candidates, onPick }) {
  const [open, setOpen] = useState(false);
  return (
    <span className="wikilink-ambiguous-wrap">
      <span
        className="wikilink wikilink-ambiguous"
        onClick={(e) => {
          e.stopPropagation();
          setOpen((v) => !v);
        }}
        title="Multiple files match this name — pick one"
      >
        {label}
      </span>
      {open && (
        <span className="ambiguous-menu" onMouseLeave={() => setOpen(false)}>
          {candidates.map((c) => (
            <button
              key={c.id}
              onClick={(e) => {
                e.stopPropagation();
                setOpen(false);
                onPick(c);
              }}
            >
              {c.isImage ? '🖼️' : '📄'} {c.relativePath}
            </button>
          ))}
        </span>
      )}
    </span>
  );
}

// Inline embedded image inside a note's preview — [[image.png]] (with or
// without the Obsidian-style leading "!") renders the picture itself,
// clickable to open the full viewer.
function ImageEmbed({ token, fileId, name, caption, onOpen }) {
  const { url, error } = useDriveImageUrl(token, fileId);
  if (error) {
    return (
      <span className="wikilink wikilink-missing-image" title={error}>
        🖼 {name}
      </span>
    );
  }
  return (
    <span className="image-embed-wrap">
      <span className="image-embed" onClick={onOpen} title={`Open ${name}`}>
        {url ? <img src={url} alt={caption || name} loading="lazy" /> : <span className="image-embed-loading">Loading image…</span>}
      </span>
      {caption && <span className="image-embed-caption">{caption}</span>}
    </span>
  );
}

// Full-size image viewer modal — opened from the sidebar, search results,
// or clicking an embedded/linked image inside a note. Shows which notes
// link to this image, reusing the same backlink graph notes get.
function ImageViewer({ token, file, backlinks, onOpenNote, onClose }) {
  const { url, error } = useDriveImageUrl(token, file?.id);

  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  if (!file) return null;
  return (
    <div className="image-viewer-scrim" onClick={onClose}>
      <div className="image-viewer" onClick={(e) => e.stopPropagation()}>
        <div className="image-viewer-header">
          <span className="image-viewer-name">{file.name}</span>
          <button className="icon-btn" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>
        <div className="image-viewer-body">
          {error && <p className="muted small">{error}</p>}
          {!error && !url && <p className="muted small">Loading…</p>}
          {url && <img src={url} alt={file.name} />}
        </div>
        {backlinks.length > 0 && (
          <div className="image-viewer-backlinks">
            <h3>Linked from</h3>
            {backlinks.map((f) => (
              <button key={f.id} className="backlink-item" onClick={() => onOpenNote(f.id)}>
                {f.name.replace(/\.md$/i, '')}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function Editor({ file, content, onChange, linkIndex, handlers, mode, setMode, loadingNote }) {
  const textareaRef = useRef(null);
  const autocomplete = useLinkAutocomplete(textareaRef, onChange, linkIndex);

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
        <button className={mode === 'split' ? 'active' : ''} onClick={() => setMode('split')}>
          Split
        </button>
        <button className={mode === 'edit' ? 'active' : ''} onClick={() => setMode('edit')}>
          Edit
        </button>
        <button className={mode === 'preview' ? 'active' : ''} onClick={() => setMode('preview')}>
          Preview
        </button>
      </div>
      {loadingNote && <div className="note-loading-bar" aria-hidden="true" />}
      <div className="editor-panes">
        {mode !== 'preview' && (
          <div className="editor-textarea-wrap">
            <textarea
              ref={textareaRef}
              className="editor-textarea"
              value={content}
              onChange={(e) => {
                onChange(e.target.value);
                autocomplete.updateFromCaret();
              }}
              onKeyUp={(e) => {
                if (!['ArrowUp', 'ArrowDown', 'Enter', 'Tab', 'Escape'].includes(e.key)) autocomplete.updateFromCaret();
              }}
              onKeyDown={(e) => {
                if (!autocomplete.suggestion) return;
                if (e.key === 'ArrowDown') {
                  e.preventDefault();
                  autocomplete.move(1);
                } else if (e.key === 'ArrowUp') {
                  e.preventDefault();
                  autocomplete.move(-1);
                } else if (e.key === 'Enter' || e.key === 'Tab') {
                  e.preventDefault();
                  autocomplete.accept(autocomplete.suggestion.items[autocomplete.suggestion.activeIndex]);
                } else if (e.key === 'Escape') {
                  autocomplete.dismiss();
                }
              }}
              onClick={autocomplete.updateFromCaret}
              onBlur={() => setTimeout(autocomplete.dismiss, 120)}
              spellCheck={false}
              placeholder="Start writing… use [[Note Name]] to link, or [[image.png]] for images."
            />
            {autocomplete.suggestion && (
              <ul className="autocomplete-menu" style={{ top: autocomplete.suggestion.top, left: autocomplete.suggestion.left }}>
                {autocomplete.suggestion.items.map((item, idx) => (
                  <li
                    key={item.id}
                    className={idx === autocomplete.suggestion.activeIndex ? 'active' : ''}
                    onMouseDown={(e) => {
                      e.preventDefault();
                      autocomplete.accept(item);
                    }}
                  >
                    <span className="autocomplete-icon">{item.isImage ? '🖼️' : '📄'}</span>
                    <span className="autocomplete-label">{item.baseName}</span>
                    {item.relativePath !== item.baseName && <span className="autocomplete-path">{item.relativePath}</span>}
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
        {mode !== 'edit' && <div className="editor-preview">{renderPreview(content, handlers, linkIndex)}</div>}
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
  const [folderRestoring, setFolderRestoring] = useState(true);
  const sync = useVaultSync(token, folder);

  const [currentFile, setCurrentFile] = useState(null);
  const [content, setContent] = useState('');
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [loadingNote, setLoadingNote] = useState(false);
  const [viewingImage, setViewingImage] = useState(null);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [search, setSearch] = useState('');
  const [mode, setMode] = useState(window.innerWidth < 768 ? 'edit' : 'split');

  const saveTimer = useRef(null);

  // Restore the last-selected vault folder (an ID string, not note content).
  useEffect(() => {
    idbGet(STORE_META, 'vaultFolder').then((rec) => {
      if (rec) setFolder(rec.value);
      setFolderRestoring(false);
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
      releaseImageUrlCache();
      setFolder(picked);
      idbPut(STORE_META, { key: 'vaultFolder', value: picked });
      setCurrentFile(null);
      setContent('');
      setDirty(false);
      setSearch('');
      setSidebarOpen(false);
      setViewingImage(null);
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
      if (!meta || !token || meta.kind === 'image') return;
      setLoadingNote(true);
      try {
        const text = await driveGetFileContent(token, id);
        setCurrentFile(meta);
        setContent(text);
        setDirty(false);
        setSidebarOpen(false);
      } finally {
        setLoadingNote(false);
      }
    },
    [token, sync.filesMeta]
  );

  const openNoteByName = useCallback(
    async (name) => {
      const resolution = resolveLinkTarget(name, sync.linkIndex);
      if (resolution.status === 'resolved' && !resolution.file.isImage) {
        return openNoteById(resolution.file.id);
      }
      if (!folder || !token) return;
      const skeleton = `# ${name}\n\n`;
      const created = await driveCreateFile(token, folder.id, name, skeleton);
      const fileRecord = {
        id: created.id,
        name: created.name,
        modifiedTime: created.modifiedTime || new Date().toISOString(),
        parents: [folder.id],
        kind: 'note'
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
            parents: [parentId],
            kind: 'note'
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
      const isImage = node.type === 'file' && node.kind === 'image';
      const currentDisplayName = node.type === 'file' && !isImage ? node.name.replace(/\.md$/i, '') : node.name;
      const input = window.prompt('Rename to:', currentDisplayName);
      if (!input || !input.trim() || input.trim() === currentDisplayName) return;

      let newName;
      if (node.type !== 'file') {
        newName = input.trim();
      } else if (isImage) {
        // Images keep whatever extension is typed; if the user dropped it,
        // fall back to the original extension instead of silently turning
        // the file into a ".md" note.
        const typed = input.trim();
        newName = fileExtension(typed) ? typed : `${typed}.${fileExtension(node.name) || 'png'}`;
      } else {
        newName = input.trim().toLowerCase().endsWith('.md') ? input.trim() : `${input.trim()}.md`;
      }

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
      const isImage = node.type === 'file' && node.kind === 'image';
      const label = node.type === 'file' && !isImage ? node.name.replace(/\.md$/i, '') : node.name;
      const warning =
        node.type === 'folder'
          ? `Delete folder "${label}" and everything inside it? This moves it to Drive's trash.`
          : `Delete "${label}"? This moves it to Drive's trash.`;
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
          if (viewingImage?.id === node.id) setViewingImage(null);
        } else {
          const removedFileIds = sync.removeFolder(node.id);
          if (currentFile && removedFileIds.includes(currentFile.id)) {
            setCurrentFile(null);
            setContent('');
            setDirty(false);
          }
          if (viewingImage && removedFileIds.includes(viewingImage.id)) setViewingImage(null);
        }
      } catch (err) {
        window.alert(`Couldn't delete: ${err.message}`);
      }
    },
    [token, sync, currentFile, viewingImage]
  );

  const tree = useMemo(
    () => buildVaultTree(folder?.id, sync.foldersMeta, sync.filesMeta),
    [folder?.id, sync.foldersMeta, sync.filesMeta]
  );

  const backlinksForCurrent = currentFile
    ? Array.from(sync.backlinkIndex.get(currentFile.id) || [])
        .map((id) => sync.filesMeta.find((f) => f.id === id))
        .filter(Boolean)
    : [];

  const imageBacklinks = viewingImage
    ? Array.from(sync.backlinkIndex.get(viewingImage.id) || [])
        .map((id) => sync.filesMeta.find((f) => f.id === id))
        .filter(Boolean)
    : [];

  const linkHandlers = useMemo(
    () => ({
      token,
      onOpenById: (id) => navigateTo(() => openNoteById(id)),
      onCreateOrOpenByName: (name) => navigateTo(() => openNoteByName(name)),
      onOpenImage: (file) => setViewingImage(file)
    }),
    [token, navigateTo, openNoteById, openNoteByName]
  );

  if (!token) {
    return <LoginScreen onSignIn={signIn} ready={gisReady} />;
  }
  if (folderRestoring) {
    return <VaultLoadingScreen progress={{ phase: 'opening', loaded: 0, total: 0 }} />;
  }
  if (!folder) {
    return <FolderPrompt onPick={handlePickFolder} />;
  }
  if (!sync.cacheLoaded) {
    return <VaultLoadingScreen progress={{ phase: 'opening', loaded: 0, total: 0 }} />;
  }
  if (sync.filesMeta.length === 0 && sync.syncing) {
    return <VaultLoadingScreen progress={sync.syncProgress} />;
  }

  const syncPct =
    sync.syncProgress.total > 0 ? Math.round((sync.syncProgress.loaded / sync.syncProgress.total) * 100) : null;

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
      {sync.syncing && syncPct !== null && (
        <div className="topbar-progress">
          <div className="topbar-progress-fill" style={{ width: `${syncPct}%` }} />
        </div>
      )}
      <div className={`workspace ${sidebarOpen ? 'sidebar-open' : ''}`}>
        <Sidebar
          tree={tree}
          files={sync.filesMeta}
          vaultRootId={folder.id}
          currentId={currentFile?.id}
          onOpenFile={(id) => navigateTo(() => openNoteById(id))}
          onOpenImage={(file) => {
            setViewingImage(file);
            setSidebarOpen(false);
          }}
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
          linkIndex={sync.linkIndex}
          handlers={linkHandlers}
          mode={mode}
          setMode={setMode}
          loadingNote={loadingNote}
        />
      </div>
      {viewingImage && (
        <ImageViewer
          token={token}
          file={viewingImage}
          backlinks={imageBacklinks}
          onOpenNote={(id) => {
            setViewingImage(null);
            navigateTo(() => openNoteById(id));
          }}
          onClose={() => setViewingImage(null)}
        />
      )}
    </div>
  );
}
