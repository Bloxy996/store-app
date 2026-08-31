import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

/* ============================================================================
 * VAULT — a markdown notebook that reads/writes .md files directly to and
 * from Google Drive. Architectural rule enforced throughout this file:
 *
 *   Note CONTENT is NEVER written to disk on this device. It lives only in
 *   React state / in-memory caches for as long as the browser tab is open,
 *   and is streamed to/from Drive over the REST API. IndexedDB is used
 *   exclusively as a *transient* cache for: (a) file metadata/modifiedTime,
 *   and (b) the derived wikilink graph — never for raw note bodies.
 *   Clearing IndexedDB never loses data, because Drive remains the single
 *   source of truth.
 *
 *   Images follow the same rule: only their metadata (id/name/modifiedTime)
 *   is cached in IndexedDB. Image bytes are fetched on demand (when actually
 *   viewed or embedded) and kept only as in-memory blob URLs for the current
 *   session — never persisted.
 *
 *   The in-memory full-text search / tag index (see useVaultIndex) is the
 *   same idea taken one step further: note bodies are held in a RAM-only
 *   Map (module scope, never IndexedDB) so full-text search works without
 *   ever touching disk. It's rebuilt from Drive every time the page loads.
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
const STORE_META = 'meta'; // { key, value } -- app settings (vault folder id, bookmarks, etc.)

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
// Frontmatter / Properties — a leading "---\n...\n---" YAML-ish block.
// Parsed loosely (key: value per line, values may be inline lists like
// "[a, b]" or comma-separated) — enough to power the Properties panel and
// the tag index without pulling in a real YAML parser.
// ---------------------------------------------------------------------------
function parseFrontmatter(content) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*\r?\n?/.exec(content || '');
  if (!m) return { properties: [], body: content || '', raw: '' };
  const raw = m[1];
  const body = content.slice(m[0].length);
  const properties = [];
  const lines = raw.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const kv = /^([^:#\s][^:]*):\s*(.*)$/.exec(line);
    if (!kv) continue;
    let key = kv[1].trim();
    let value = kv[2].trim();
    // Gather an indented "- item" list that follows a bare "key:" line.
    if (!value) {
      const items = [];
      let j = i + 1;
      while (j < lines.length && /^\s*-\s+/.test(lines[j])) {
        items.push(lines[j].replace(/^\s*-\s+/, '').trim());
        j++;
      }
      if (items.length) {
        value = items.join(', ');
        i = j - 1;
      }
    }
    properties.push({ key, value });
  }
  return { properties, body, raw };
}

function splitListValue(value) {
  const trimmed = value.trim().replace(/^\[/, '').replace(/\]$/, '');
  return trimmed
    .split(',')
    .map((s) => s.trim().replace(/^["']|["']$/g, ''))
    .filter(Boolean);
}

// Tags come from two places, both real Obsidian conventions: a `tags:` (or
// `tag:`) frontmatter property, and inline `#hashtag` tokens anywhere in the
// body. Nested tags ("#parent/child") are kept as their full path. Inline
// tags inside fenced/inline code are skipped so code samples don't pollute
// the tag index.
function extractTags(content) {
  if (!content) return [];
  const { properties, body } = parseFrontmatter(content);
  const tags = new Set();

  properties.forEach((p) => {
    if (/^tags?$/i.test(p.key)) {
      splitListValue(p.value).forEach((t) => {
        const clean = t.replace(/^#/, '').trim();
        if (clean) tags.add(clean);
      });
    }
  });

  const withoutCode = body.replace(/```[\s\S]*?```/g, ' ').replace(/`[^`]*`/g, ' ');
  const re = /(^|[\s(])#([A-Za-z][A-Za-z0-9_\-/]*)/g;
  let m;
  while ((m = re.exec(withoutCode)) !== null) {
    tags.add(m[2]);
  }
  return Array.from(tags);
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
    return { ...f, isImage, baseName, relativePath, dir };
  });

  const byBasenameKey = new Map();
  const byRelativePath = new Map();
  records.forEach((r) => {
    const key = `${r.isImage ? 'img' : 'note'}:${r.baseName.toLowerCase()}`;
    if (!byBasenameKey.has(key)) byBasenameKey.set(key, []);
    byBasenameKey.get(key).push(r);
    byRelativePath.set(r.relativePath.toLowerCase(), r);
  });

  return { records, byBasenameKey, byRelativePath, folderPath };
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

// Fuzzy subsequence matcher used by the quick switcher and command palette.
// Returns null on no match, otherwise a score where lower is better (so
// results sort ascending). Contiguous runs and early matches score better,
// same general idea as Obsidian's / VS Code's fuzzy finders.
function fuzzyScore(query, text) {
  if (!query) return 0;
  const q = query.toLowerCase();
  const t = text.toLowerCase();
  let qi = 0;
  let score = 0;
  let lastMatch = -1;
  for (let ti = 0; ti < t.length && qi < q.length; ti++) {
    if (t[ti] === q[qi]) {
      score += ti - lastMatch - 1; // gap penalty
      if (lastMatch !== -1 && ti === lastMatch + 1) score -= 1; // contiguity bonus
      lastMatch = ti;
      qi++;
    }
  }
  if (qi < q.length) return null;
  score += lastMatch; // prefer earlier overall matches
  return score;
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

// --- Apps Script proxy support -------------------------------------------
// token is either a bearer-token string (direct Google OAuth, existing
// behavior) or an { proxy: true, url, secret } object (Apps Script proxy).
// Each drive*() function below branches on this. Proxy mode is read/write
// for text notes, folders, and metadata, but does not support binary
// uploads or moving items between folders — the deployed Apps Script only
// exposes create/rename/trash actions, so those two features degrade
// gracefully with a clear message instead of silently failing.
function isProxy(token) {
  return !!(token && typeof token === 'object' && token.proxy);
}

async function proxyGet(token, params) {
  const url = new URL(token.url);
  Object.entries({ ...params, secret: token.secret }).forEach(([k, v]) => url.searchParams.set(k, v));
  const res = await fetch(url.toString());
  if (!res.ok) throw new Error(`Proxy request failed (${res.status})`);
  return res;
}

// Content-Type text/plain (not application/json) deliberately — it's a
// CORS-safelisted type, so the browser sends this as a "simple request"
// with no OPTIONS preflight. Apps Script doesn't answer preflights, so
// application/json here would silently fail cross-origin.
async function proxyPost(token, body) {
  const res = await fetch(token.url, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body: JSON.stringify({ ...body, secret: token.secret })
  });
  if (!res.ok) throw new Error(`Proxy request failed (${res.status})`);
  const data = await res.json();
  if (data.error) throw new Error(data.error);
  return data;
}

async function driveBrowseFolders(token, parentId) {
  const res = await proxyGet(token, { action: 'browse', parent: parentId || 'root' });
  const data = await res.json();
  return data.folders || [];
}

// For folders the browse action can never reach (chiefly anything under
// "Computers" — Drive's desktop-backup section has no browsing API at
// all). The user pastes a Drive folder URL or bare ID instead of
// navigating to it.
async function driveResolveFolder(token, idOrUrl) {
  const id = extractDriveFolderId(idOrUrl);
  const res = await proxyGet(token, { action: 'resolveFolder', id });
  const data = await res.json();
  if (data.error) throw new Error(data.error);
  return data; // { id, name }
}

function extractDriveFolderId(input) {
  const trimmed = input.trim();
  const fromPath = trimmed.match(/\/folders\/([a-zA-Z0-9_-]+)/);
  if (fromPath) return fromPath[1];
  const fromQuery = trimmed.match(/[?&]id=([a-zA-Z0-9_-]+)/);
  if (fromQuery) return fromQuery[1];
  return trimmed; // assume it's already a bare folder ID
}

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
// only levels themselves are sequential (a child folder can't be queried
// until its parent's id is known).
async function driveListFolderTree(token, rootFolderId) {
  if (isProxy(token)) {
    const res = await proxyGet(token, { action: 'listFolderTree', root: rootFolderId });
    return (await res.json()).folders || [];
  }
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
  if (isProxy(token)) {
    const res = await proxyGet(token, { action: 'listVaultFiles', folders: folderIds.join(',') });
    return (await res.json()).files || [];
  }
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
  if (isProxy(token)) {
    const res = await proxyGet(token, { action: 'getContent', id: fileId });
    return res.text();
  }
  const res = await fetch(`${DRIVE_FILES_URL}/${fileId}?alt=media&${DRIVE_ALL_DRIVES}`, {
    headers: { Authorization: `Bearer ${token}` }
  });
  if (!res.ok) throw driveError(res, 'Drive fetch failed');
  return res.text();
}

// Same request as above, but returns a Blob — used for images, which are
// fetched on demand only (see the constant comment on FETCH_CONCURRENCY).
async function driveGetFileBlob(token, fileId) {
  if (isProxy(token)) {
    const res = await proxyGet(token, { action: 'getBlob', id: fileId });
    const data = await res.json();
    const binary = atob(data.base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return new Blob([bytes], { type: data.mimeType });
  }
  const res = await fetch(`${DRIVE_FILES_URL}/${fileId}?alt=media&${DRIVE_ALL_DRIVES}`, {
    headers: { Authorization: `Bearer ${token}` }
  });
  if (!res.ok) throw driveError(res, 'Drive fetch failed');
  return res.blob();
}

async function driveUpdateFileContent(token, fileId, content) {
  if (isProxy(token)) {
    return proxyPost(token, { action: 'updateContent', id: fileId, content });
  }
  const res = await fetch(`${DRIVE_UPLOAD_URL}/${fileId}?uploadType=media&${DRIVE_ALL_DRIVES}`, {
    method: 'PATCH',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'text/markdown' },
    body: content
  });
  if (!res.ok) throw driveError(res, 'Drive save failed');
  return res.json();
}

async function driveCreateFile(token, folderId, rawName, content = '') {
  if (isProxy(token)) {
    return proxyPost(token, { action: 'createFile', folderId, name: rawName, content });
  }
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

// Uploads an arbitrary local File/Blob (used by the sidebar's "Upload
// files" action) preserving its real MIME type and bytes exactly — unlike
// driveCreateFile above, which always writes UTF-8 markdown text. Direct
// OAuth only: the Apps Script proxy's createFile action always writes
// text/markdown, so binary uploads aren't safe to route through it.
async function driveUploadBinary(token, folderId, file) {
  if (isProxy(token)) {
    const err = new Error('Uploading files requires direct Google sign-in (not supported via the Apps Script proxy).');
    err.code = 'proxy-unsupported';
    throw err;
  }
  const bytes = await file.arrayBuffer();
  const metadata = { name: file.name, parents: [folderId], mimeType: file.type || 'application/octet-stream' };
  const boundary = `vault-${Date.now()}`;
  const head = `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n--${boundary}\r\nContent-Type: ${
    metadata.mimeType
  }\r\n\r\n`;
  const tail = `\r\n--${boundary}--`;
  const body = new Blob([head, bytes, tail]);
  const res = await fetch(`${DRIVE_UPLOAD_URL}?uploadType=multipart&fields=id,name,modifiedTime,parents,mimeType&${DRIVE_ALL_DRIVES}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': `multipart/related; boundary=${boundary}` },
    body
  });
  if (!res.ok) throw driveError(res, 'Drive upload failed');
  return res.json();
}

async function driveCreateFolder(token, parentId, name) {
  if (isProxy(token)) {
    return proxyPost(token, { action: 'createFolder', parentId, name });
  }
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
  if (isProxy(token)) {
    return proxyPost(token, { action: 'rename', id, newName });
  }
  const res = await fetch(`${DRIVE_FILES_URL}/${id}?fields=id,name&${DRIVE_ALL_DRIVES}`, {
    method: 'PATCH',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: newName })
  });
  if (!res.ok) throw driveError(res, 'Drive rename failed');
  return res.json();
}

// Moves a file or folder to a new parent folder — powers drag-and-drop
// reorganization in the sidebar. Direct OAuth only (see isProxy note
// above); the Apps Script proxy has no "move" action.
async function driveMoveItem(token, id, newParentId, oldParentId) {
  if (isProxy(token)) {
    const err = new Error('Moving items requires direct Google sign-in (not supported via the Apps Script proxy).');
    err.code = 'proxy-unsupported';
    throw err;
  }
  const res = await fetch(
    `${DRIVE_FILES_URL}/${id}?addParents=${newParentId}&removeParents=${oldParentId}&fields=id,parents&${DRIVE_ALL_DRIVES}`,
    { method: 'PATCH', headers: { Authorization: `Bearer ${token}` } }
  );
  if (!res.ok) throw driveError(res, 'Drive move failed');
  return res.json();
}

// Moves a file or folder to Drive's trash (recoverable), rather than
// permanently deleting — matches what "Delete" does in Drive's own UI.
// Trashing a folder hides its contents from listings too; the app treats
// them as gone on the next sync without needing to trash each child.
async function driveTrashItem(token, id) {
  if (isProxy(token)) {
    return proxyPost(token, { action: 'trash', id });
  }
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
    releaseSearchIndex();
    setToken('');
  }, [token]);

  return { token, gisReady, signIn, signOut };
}

// ---------------------------------------------------------------------------
// Auth hook — Apps Script proxy (URL + shared secret, no Google OAuth)
// ---------------------------------------------------------------------------
function useProxyAuth() {
  const [proxyToken, setProxyToken] = useState(() => {
    try {
      const raw = localStorage.getItem('vault_proxy_config');
      return raw ? JSON.parse(raw) : null;
    } catch {
      return null;
    }
  });

  const signInProxy = useCallback((url, secret) => {
    const cfg = { proxy: true, url: url.trim().replace(/\/$/, ''), secret: secret.trim() };
    localStorage.setItem('vault_proxy_config', JSON.stringify(cfg));
    setProxyToken(cfg);
  }, []);

  const signOutProxy = useCallback(() => {
    localStorage.removeItem('vault_proxy_config');
    releaseImageUrlCache();
    releaseSearchIndex();
    setProxyToken(null);
  }, []);

  return { proxyToken, signInProxy, signOutProxy };
}

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

// Flat, search-filtered list of files (used by the quick switcher).
function flattenFiles(files, query) {
  if (!query.trim()) return files.slice().sort((a, b) => a.name.localeCompare(b.name));
  return files
    .map((f) => ({ f, score: fuzzyScore(query, f.name) }))
    .filter((s) => s.score !== null)
    .sort((a, b) => a.score - b.score)
    .map((s) => s.f);
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

// Opens an image file in a real new browser tab (rather than an in-app
// viewer). The blank tab is opened synchronously, in direct response to the
// user gesture, so popup blockers don't swallow it — its location is filled
// in once the Drive blob has been fetched/decoded.
async function openImageInNewTab(token, file) {
  if (!file) return;
  const win = window.open('', '_blank');
  try {
    let url = imageUrlCache.get(file.id);
    if (!url) {
      let promise = imageUrlPromises.get(file.id);
      if (!promise) {
        promise = driveGetFileBlob(token, file.id).then((blob) => {
          const objectUrl = URL.createObjectURL(blob);
          imageUrlCache.set(file.id, objectUrl);
          return objectUrl;
        });
        imageUrlPromises.set(file.id, promise);
        promise.finally(() => imageUrlPromises.delete(file.id));
      }
      url = await promise;
    }
    if (win) win.location.href = url;
    else window.open(url, '_blank');
  } catch (err) {
    if (win) win.close();
    window.alert(`Couldn't open image: ${err.message || err}`);
  }
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
// RAM-only full-text search / tag index. `noteBodyCache` never touches
// IndexedDB — it exists purely so the current browser tab can search and
// list tags across the whole vault without re-fetching every note's body
// on every keystroke. It's rebuilt from Drive each time the page loads
// (see useVaultSync's sync pass, which seeds it for free) and wiped on
// sign-out / vault switch by releaseSearchIndex().
// ---------------------------------------------------------------------------
const noteBodyCache = new Map(); // fileId -> content string, RAM only
const searchIndexListeners = new Set();

function bumpSearchIndexVersion() {
  searchIndexListeners.forEach((fn) => fn());
}

function releaseSearchIndex() {
  noteBodyCache.clear();
  bumpSearchIndexVersion();
}

// Fetches (and caches) every note body not already in noteBodyCache, with
// bounded concurrency — the same approach useVaultSync uses for the
// wikilink pass. Called automatically in the background after the first
// sync, and again (awaited) the moment the Search or Tags panel opens, so
// results are never silently incomplete.
function useVaultIndex(token, filesMeta) {
  const [version, setVersion] = useState(0);
  const [building, setBuilding] = useState(false);
  const [progress, setProgress] = useState({ loaded: 0, total: 0 });
  const inFlight = useRef(false);

  useEffect(() => {
    const listener = () => setVersion((v) => v + 1);
    searchIndexListeners.add(listener);
    return () => searchIndexListeners.delete(listener);
  }, []);

  const ensureIndexed = useCallback(async () => {
    if (!token || inFlight.current) return;
    const notes = filesMeta.filter((f) => f.kind === 'note');
    const missing = notes.filter((f) => !noteBodyCache.has(f.id));
    if (!missing.length) return;
    inFlight.current = true;
    setBuilding(true);
    let loaded = 0;
    setProgress({ loaded: 0, total: missing.length });
    await mapWithConcurrency(missing, FETCH_CONCURRENCY, async (file) => {
      try {
        const content = await withRetry(() => driveGetFileContent(token, file.id));
        noteBodyCache.set(file.id, content);
      } catch {
        // leave it unindexed; a later sync/search retry can pick it up
      }
      loaded += 1;
      setProgress({ loaded, total: missing.length });
      if (loaded % 10 === 0) bumpSearchIndexVersion();
    });
    bumpSearchIndexVersion();
    inFlight.current = false;
    setBuilding(false);
  }, [token, filesMeta]);

  // Kick off background indexing shortly after the vault's file list first
  // appears, so Search/Tags are usually ready before the user opens them.
  useEffect(() => {
    if (!token || !filesMeta.length) return;
    const t = setTimeout(() => ensureIndexed(), 400);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token, filesMeta.length]);

  const getBody = useCallback((fileId) => noteBodyCache.get(fileId) || '', []);
  const updateBody = useCallback((fileId, content) => {
    noteBodyCache.set(fileId, content);
    bumpSearchIndexVersion();
  }, []);
  const indexedCount = filesMeta.filter((f) => f.kind === 'note' && noteBodyCache.has(f.id)).length;
  const totalNotes = filesMeta.filter((f) => f.kind === 'note').length;

  return {
    ensureIndexed,
    building,
    progress,
    getBody,
    updateBody,
    ready: indexedCount === totalNotes,
    indexedCount,
    totalNotes,
    version
  };
}

// Tag index: tag -> [{ file }] built from every indexed note's body.
function buildTagIndex(filesMeta, getBody) {
  const byTag = new Map();
  filesMeta.forEach((f) => {
    if (f.kind !== 'note') return;
    const body = getBody(f.id);
    if (!body) return;
    extractTags(body).forEach((tag) => {
      const key = tag.toLowerCase();
      if (!byTag.has(key)) byTag.set(key, { tag, files: [] });
      byTag.get(key).files.push(f);
    });
  });
  return Array.from(byTag.values()).sort((a, b) => a.tag.localeCompare(b.tag));
}

// ---------------------------------------------------------------------------
// Search query parsing — a subset of Obsidian's search syntax:
//   path:foo        only files whose path contains "foo"
//   file:foo        only files whose name contains "foo"
//   tag:foo / #foo  only files tagged #foo (or a descendant "#foo/bar")
//   line:(a b)      terms must all appear on the same line
//   section:(a b)   terms must all appear under the same heading
//   [key] / [key:value]   frontmatter property match
//   "exact phrase"  literal phrase match
//   bare words      plain content terms (AND-ed together)
// ---------------------------------------------------------------------------
function parseSearchQuery(raw) {
  const clauses = { path: [], file: [], tag: [], line: [], section: [], property: [], phrase: [], term: [] };
  let s = raw;

  s = s.replace(/\[([^:\]]+):([^\]]+)\]/g, (_, k, v) => {
    clauses.property.push({ key: k.trim().toLowerCase(), value: v.trim().toLowerCase() });
    return ' ';
  });
  s = s.replace(/\[([^\]]+)\]/g, (_, k) => {
    clauses.property.push({ key: k.trim().toLowerCase(), value: null });
    return ' ';
  });
  s = s.replace(/"([^"]+)"/g, (_, v) => {
    clauses.phrase.push(v.toLowerCase());
    return ' ';
  });
  s = s.replace(/path:(\([^)]*\)|\S+)/gi, (_, v) => {
    clauses.path.push(v.replace(/^\(|\)$/g, '').toLowerCase());
    return ' ';
  });
  s = s.replace(/file:(\([^)]*\)|\S+)/gi, (_, v) => {
    clauses.file.push(v.replace(/^\(|\)$/g, '').toLowerCase());
    return ' ';
  });
  s = s.replace(/tag:(\([^)]*\)|\S+)/gi, (_, v) => {
    clauses.tag.push(v.replace(/^\(|\)$/g, '').replace(/^#/, '').toLowerCase());
    return ' ';
  });
  s = s.replace(/line:\(([^)]*)\)/gi, (_, v) => {
    clauses.line.push(v.trim().toLowerCase().split(/\s+/).filter(Boolean));
    return ' ';
  });
  s = s.replace(/section:\(([^)]*)\)/gi, (_, v) => {
    clauses.section.push(v.trim().toLowerCase().split(/\s+/).filter(Boolean));
    return ' ';
  });
  s = s.replace(/(^|\s)#([A-Za-z][A-Za-z0-9_\-/]*)/g, (_, pre, v) => {
    clauses.tag.push(v.toLowerCase());
    return ' ';
  });

  clauses.term = s.trim().split(/\s+/).filter(Boolean).map((t) => t.toLowerCase());
  return clauses;
}

// Runs a parsed query against the in-memory vault index, returning results
// grouped by file: [{ file, matches: [{ line, lineNumber, ranges }] }],
// sorted by file name to match the reference search UI.
function runVaultSearch(query, filesMeta, linkIndex, getBody, tagsByFileId) {
  const clauses = parseSearchQuery(query);
  const hasStructural = clauses.path.length || clauses.file.length || clauses.tag.length || clauses.property.length;
  const hasContent = clauses.term.length || clauses.phrase.length || clauses.line.length || clauses.section.length;
  if (!hasStructural && !hasContent) return [];

  const results = [];
  filesMeta.forEach((f) => {
    if (f.kind !== 'note') return;
    const rec = linkIndex.records.find((r) => r.id === f.id);
    const path = (rec ? rec.relativePath : f.name).toLowerCase();
    const name = f.name.toLowerCase();

    if (clauses.path.some((v) => !path.includes(v))) return;
    if (clauses.file.some((v) => !name.includes(v))) return;

    const body = getBody(f.id);
    const { properties, body: bodyNoFrontmatter } = parseFrontmatter(body);
    const propMap = new Map(properties.map((p) => [p.key.toLowerCase(), p.value.toLowerCase()]));
    if (
      clauses.property.some(({ key, value }) => {
        if (!propMap.has(key)) return true;
        if (value === null) return false;
        return !propMap.get(key).includes(value);
      })
    )
      return;

    const fileTags = (tagsByFileId.get(f.id) || []).map((t) => t.toLowerCase());
    if (
      clauses.tag.some((v) => !fileTags.some((t) => t === v || t.startsWith(v + '/')))
    )
      return;

    if (!hasContent) {
      results.push({ file: f, path: rec ? rec.relativePath : f.name, matches: [] });
      return;
    }
    if (!body) return; // not indexed yet — will appear once indexing finishes

    const lines = bodyNoFrontmatter.split('\n');
    const lower = bodyNoFrontmatter.toLowerCase();
    const allTermsPresent =
      clauses.term.every((t) => lower.includes(t)) && clauses.phrase.every((p) => lower.includes(p));
    if (!allTermsPresent) return;

    // Build heading sections for section: matching.
    let currentHeading = '';
    const headingByLine = lines.map((l) => {
      const h = /^#{1,6}\s+(.*)$/.exec(l);
      if (h) currentHeading = h[1];
      return currentHeading;
    });

    const wanted = [...clauses.term, ...clauses.phrase];
    const matches = [];
    lines.forEach((line, idx) => {
      const lowerLine = line.toLowerCase();
      const lineHasAll = wanted.length ? wanted.every((t) => lowerLine.includes(t)) : false;
      const lineOk = clauses.line.every((group) => group.every((t) => lowerLine.includes(t)));
      const sectionOk = clauses.section.every((group) =>
        group.every((t) => headingByLine[idx].toLowerCase().includes(t) || lowerLine.includes(t))
      );
      const contributesLine = wanted.length ? lineHasAll : true;
      if (contributesLine && lineOk && sectionOk && (wanted.length || clauses.line.length || clauses.section.length)) {
        matches.push({ line, lineNumber: idx + 1, terms: wanted });
      }
    });

    // line:/section: without plain terms still need at least one satisfying
    // line to count as a file match.
    if ((clauses.line.length || clauses.section.length) && !matches.length) return;

    if (wanted.length && !matches.length) {
      // Terms appear in the file (allTermsPresent) but never together on one
      // line — still a file-level match; show the first line containing any term.
      const idx = lines.findIndex((l) => wanted.some((t) => l.toLowerCase().includes(t)));
      if (idx !== -1) matches.push({ line: lines[idx], lineNumber: idx + 1, terms: wanted });
    }

    results.push({ file: f, path: rec ? rec.relativePath : f.name, matches: matches.slice(0, 6), matchCount: matches.length });
  });

  results.sort((a, b) => a.path.localeCompare(b.path));
  return results;
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
function useLinkAutocomplete(textareaRef, onChange, linkIndex, phantomRecords) {
  const [state, setState] = useState(null); // { start, items, activeIndex, top, left }

  const computeSuggestions = useCallback(
    (query) => {
      const q = query.toLowerCase();
      const scoreOf = (hay) => (q ? hay.indexOf(q) : 0);
      const pool = linkIndex.records.concat(phantomRecords || []);
      const byBase = pool.map((r) => ({ r, score: scoreOf(r.baseName.toLowerCase()) })).filter((s) => s.score !== -1);
      const finalPool = byBase.length
        ? byBase
        : pool.map((r) => ({ r, score: scoreOf(r.relativePath.toLowerCase()) })).filter((s) => s.score !== -1);
      return finalPool
        .sort((a, b) => a.score - b.score || a.r.baseName.localeCompare(b.r.baseName))
        .slice(0, 8)
        .map((s) => s.r);
    },
    [linkIndex, phantomRecords]
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
// Icon library — small hand-drawn line icons in the same monoline style
// Obsidian itself uses, so nothing in the UI relies on emoji glyphs. Folders
// are identified purely by their expand/collapse chevron, notes have no
// icon at all, and images are identified by their visible ".png"/".jpg"
// extension — exactly per the "no emoji, no redundant icons" brief.
// ---------------------------------------------------------------------------
function Svg({ children, size = 16, style, ...rest }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      style={{ flexShrink: 0, ...style }}
      {...rest}
    >
      {children}
    </svg>
  );
}

const IconChevronRight = (p) => (
  <Svg {...p}>
    <polyline points="9 18 15 12 9 6" />
  </Svg>
);
const IconChevronDown = (p) => (
  <Svg {...p}>
    <polyline points="6 9 12 15 18 9" />
  </Svg>
);
const IconMenu = (p) => (
  <Svg {...p}>
    <line x1="4" y1="7" x2="20" y2="7" />
    <line x1="4" y1="12" x2="20" y2="12" />
    <line x1="4" y1="17" x2="20" y2="17" />
  </Svg>
);
const IconPlus = (p) => (
  <Svg {...p}>
    <line x1="12" y1="5" x2="12" y2="19" />
    <line x1="5" y1="12" x2="19" y2="12" />
  </Svg>
);
const IconFilePlus = (p) => (
  <Svg {...p}>
    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
    <polyline points="14 2 14 8 20 8" />
    <line x1="12" y1="12" x2="12" y2="18" />
    <line x1="9" y1="15" x2="15" y2="15" />
  </Svg>
);
const IconFolderPlus = (p) => (
  <Svg {...p}>
    <path d="M3 7a2 2 0 0 1 2-2h4l2 2h6a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
    <line x1="12" y1="11" x2="12" y2="16" />
    <line x1="9.5" y1="13.5" x2="14.5" y2="13.5" />
  </Svg>
);
const IconUpload = (p) => (
  <Svg {...p}>
    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
    <polyline points="17 8 12 3 7 8" />
    <line x1="12" y1="3" x2="12" y2="15" />
  </Svg>
);
const IconMoreVertical = (p) => (
  <Svg {...p}>
    <circle cx="12" cy="5" r="1.4" fill="currentColor" stroke="none" />
    <circle cx="12" cy="12" r="1.4" fill="currentColor" stroke="none" />
    <circle cx="12" cy="19" r="1.4" fill="currentColor" stroke="none" />
  </Svg>
);
const IconEdit = (p) => (
  <Svg {...p}>
    <path d="M12 20h9" />
    <path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z" />
  </Svg>
);
const IconTrash = (p) => (
  <Svg {...p}>
    <polyline points="3 6 5 6 21 6" />
    <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
    <path d="M10 11v6" />
    <path d="M14 11v6" />
    <path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2" />
  </Svg>
);
const IconX = (p) => (
  <Svg {...p}>
    <line x1="18" y1="6" x2="6" y2="18" />
    <line x1="6" y1="6" x2="18" y2="18" />
  </Svg>
);
const IconPanelLeft = (p) => (
  <Svg {...p}>
    <rect x="3" y="4" width="18" height="16" rx="2" />
    <line x1="9" y1="4" x2="9" y2="20" />
  </Svg>
);
const IconSearch = (p) => (
  <Svg {...p}>
    <circle cx="11" cy="11" r="7" />
    <line x1="21" y1="21" x2="16.2" y2="16.2" />
  </Svg>
);
const IconTag = (p) => (
  <Svg {...p}>
    <path d="M20.6 12.6 12.4 20.8a2 2 0 0 1-2.8 0l-7.4-7.4a2 2 0 0 1 0-2.8L10.4 2.4A2 2 0 0 1 11.8 2H18a2 2 0 0 1 2 2v6.2a2 2 0 0 1-.6 1.4Z" />
    <circle cx="15" cy="8" r="1.4" fill="currentColor" stroke="none" />
  </Svg>
);
const IconStar = (p) => (
  <Svg {...p}>
    <polygon points="12 2 15.1 8.6 22 9.6 17 14.6 18.2 21.6 12 18.2 5.8 21.6 7 14.6 2 9.6 8.9 8.6" />
  </Svg>
);
const IconStarFilled = (p) => (
  <Svg {...p} fill="currentColor">
    <polygon points="12 2 15.1 8.6 22 9.6 17 14.6 18.2 21.6 12 18.2 5.8 21.6 7 14.6 2 9.6 8.9 8.6" />
  </Svg>
);
const IconRefresh = (p) => (
  <Svg {...p}>
    <polyline points="23 4 23 10 17 10" />
    <polyline points="1 20 1 14 7 14" />
    <path d="M3.5 9a8.5 8.5 0 0 1 14.3-4.1L23 10" />
    <path d="M20.5 15a8.5 8.5 0 0 1-14.3 4.1L1 14" />
  </Svg>
);
const IconLogOut = (p) => (
  <Svg {...p}>
    <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
    <polyline points="16 17 21 12 16 7" />
    <line x1="21" y1="12" x2="9" y2="12" />
  </Svg>
);
const IconFolder = (p) => (
  <Svg {...p}>
    <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
  </Svg>
);
const IconDrive = (p) => (
  <Svg {...p}>
    <rect x="2" y="6" width="20" height="12" rx="2" />
    <line x1="2" y1="12" x2="22" y2="12" />
    <line x1="6" y1="15" x2="6.01" y2="15" />
  </Svg>
);
const IconSplitVertical = (p) => (
  <Svg {...p}>
    <rect x="3" y="4" width="18" height="16" rx="2" />
    <line x1="12" y1="4" x2="12" y2="20" />
  </Svg>
);
const IconSplitHorizontal = (p) => (
  <Svg {...p}>
    <rect x="3" y="4" width="18" height="16" rx="2" />
    <line x1="3" y1="12" x2="21" y2="12" />
  </Svg>
);
const IconEye = (p) => (
  <Svg {...p}>
    <path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7-11-7-11-7Z" />
    <circle cx="12" cy="12" r="3" />
  </Svg>
);
const IconArrowLeft = (p) => (
  <Svg {...p}>
    <line x1="19" y1="12" x2="5" y2="12" />
    <polyline points="12 19 5 12 12 5" />
  </Svg>
);
const IconArrowRight = (p) => (
  <Svg {...p}>
    <line x1="5" y1="12" x2="19" y2="12" />
    <polyline points="12 5 19 12 12 19" />
  </Svg>
);
const IconSettings = (p) => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="3" />
    <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.6 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.6a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1Z" />
  </Svg>
);
const IconHelp = (p) => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="10" />
    <path d="M9.1 9a3 3 0 0 1 5.82 1c0 2-3 2.5-3 4.5" />
    <line x1="12" y1="17.5" x2="12" y2="17.51" />
  </Svg>
);
const IconSliders = (p) => (
  <Svg {...p}>
    <line x1="4" y1="6" x2="20" y2="6" />
    <line x1="4" y1="12" x2="20" y2="12" />
    <line x1="4" y1="18" x2="20" y2="18" />
    <circle cx="9" cy="6" r="2" fill="var(--bg-1)" />
    <circle cx="15" cy="12" r="2" fill="var(--bg-1)" />
    <circle cx="7" cy="18" r="2" fill="var(--bg-1)" />
  </Svg>
);
const IconInfo = (p) => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="10" />
    <line x1="12" y1="16" x2="12" y2="11.5" />
    <line x1="12" y1="8" x2="12" y2="8.01" />
  </Svg>
);
const IconImageMissing = (p) => (
  <Svg {...p}>
    <rect x="3" y="3" width="18" height="18" rx="2" />
    <circle cx="9" cy="9" r="1.8" />
    <path d="m21 15-5-5L5 21" />
    <line x1="3" y1="3" x2="21" y2="21" stroke="var(--danger)" />
  </Svg>
);
const IconCheck = (p) => (
  <Svg {...p}>
    <polyline points="20 6 9 17 4 12" />
  </Svg>
);
const IconLoader = (p) => (
  <Svg {...p} className={`spin ${p.className || ''}`}>
    <line x1="12" y1="2" x2="12" y2="6" />
    <line x1="12" y1="18" x2="12" y2="22" />
    <line x1="4.9" y1="4.9" x2="7.8" y2="7.8" />
    <line x1="16.2" y1="16.2" x2="19.1" y2="19.1" />
    <line x1="2" y1="12" x2="6" y2="12" />
    <line x1="18" y1="12" x2="22" y2="12" />
    <line x1="4.9" y1="19.1" x2="7.8" y2="16.2" />
    <line x1="16.2" y1="7.8" x2="19.1" y2="4.9" />
  </Svg>
);
const IconCommand = (p) => (
  <Svg {...p}>
    <path d="M6 3a3 3 0 0 1 3 3v12a3 3 0 1 1-3-3h12a3 3 0 1 1-3 3V6a3 3 0 1 1 3-3H6z" />
  </Svg>
);
const IconAlertTriangle = (p) => (
  <Svg {...p}>
    <path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z" />
    <line x1="12" y1="9" x2="12" y2="13" />
    <line x1="12" y1="17" x2="12" y2="17.01" />
  </Svg>
);

// ---------------------------------------------------------------------------
// Minimal markdown + wikilink + tag renderer (no external markdown dependency)
// ---------------------------------------------------------------------------
function renderInline(text, keyPrefix, handlers, linkIndex) {
  const nodes = [];
  const re =
    /(!?\[\[[^[\]]+\]\])|(\*\*[^*]+\*\*)|(`[^`]+`)|(\[[^[\]]+\]\([^()\s]+\))|(\*[^*]+\*)|((?:^|[\s(])#[A-Za-z][A-Za-z0-9_\-/]*)/g;
  let lastIndex = 0;
  let match;
  let i = 0;
  while ((match = re.exec(text)) !== null) {
    let token = match[0];
    let tokenStart = match.index;
    // The tag alternative captures an optional leading space/paren so the
    // word-boundary check works without lookbehind edge cases — push that
    // leading character back out as plain text before handling the tag.
    if (match[6]) {
      const tagToken = match[6];
      const lead = /^[\s(]/.test(tagToken) ? tagToken[0] : '';
      if (lead) {
        if (tokenStart > lastIndex) nodes.push(text.slice(lastIndex, tokenStart));
        nodes.push(lead);
        lastIndex = tokenStart + lead.length;
        tokenStart = lastIndex;
        token = tagToken.slice(lead.length);
      }
    }
    if (tokenStart > lastIndex) nodes.push(text.slice(lastIndex, tokenStart));
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
            {rawTarget}
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
    } else if (token.startsWith('#')) {
      const tagName = token.slice(1);
      nodes.push(
        <span
          key={key}
          className="tag-chip"
          onClick={() => handlers.onOpenTag && handlers.onOpenTag(tagName)}
          title={`Search #${tagName}`}
        >
          #{tagName}
        </span>
      );
    } else if (token.startsWith('*')) {
      nodes.push(<em key={key}>{token.slice(1, -1)}</em>);
    }
    lastIndex = tokenStart + token.length;
  }
  if (lastIndex < text.length) nodes.push(text.slice(lastIndex));
  return nodes;
}

function renderMarkdownBlocks(content, handlers, linkIndex, keyBase = '') {
  const lines = content.split('\n');
  const blocks = [];
  let listBuffer = [];
  let listType = null;
  let codeBuffer = null;

  const flushList = () => {
    if (!listBuffer.length) return;
    const Tag = listType === 'ol' ? 'ol' : 'ul';
    blocks.push(
      <Tag key={`${keyBase}list-${blocks.length}`}>
        {listBuffer.map((item, idx) => (
          <li key={idx}>{renderInline(item, `${keyBase}li-${blocks.length}-${idx}`, handlers, linkIndex)}</li>
        ))}
      </Tag>
    );
    listBuffer = [];
    listType = null;
  };

  lines.forEach((line, idx) => {
    if (codeBuffer !== null) {
      if (/^```/.test(line.trim())) {
        blocks.push(
          <pre key={`${keyBase}code-${idx}`}>
            <code>{codeBuffer.join('\n')}</code>
          </pre>
        );
        codeBuffer = null;
      } else {
        codeBuffer.push(line);
      }
      return;
    }
    const fence = /^```/.test(line.trim());
    const heading = line.match(/^(#{1,6})\s+(.*)$/);
    const quote = line.match(/^>\s?(.*)$/);
    const ul = line.match(/^\s*[-*]\s+(.*)$/);
    const ol = line.match(/^\s*\d+\.\s+(.*)$/);
    const hr = /^(-{3,}|\*{3,})$/.test(line.trim());
    const taskUl = line.match(/^\s*[-*]\s+\[( |x|X)\]\s+(.*)$/);

    if (fence) {
      flushList();
      codeBuffer = [];
    } else if (taskUl) {
      flushList();
      const checked = taskUl[1].toLowerCase() === 'x';
      blocks.push(
        <div className="task-line" key={`${keyBase}task-${idx}`}>
          <input type="checkbox" checked={checked} readOnly />
          <span className={checked ? 'task-done' : ''}>{renderInline(taskUl[2], `${keyBase}t-${idx}`, handlers, linkIndex)}</span>
        </div>
      );
    } else if (heading) {
      flushList();
      const level = Math.min(heading[1].length, 6);
      const headingId = heading[2].trim().toLowerCase().replace(/[^a-z0-9]+/g, '-');
      blocks.push(
        React.createElement(
          `h${level}`,
          { key: `${keyBase}h-${idx}`, id: `${keyBase}${headingId}` },
          renderInline(heading[2], `${keyBase}h-${idx}`, handlers, linkIndex)
        )
      );
    } else if (hr) {
      flushList();
      blocks.push(<hr key={`${keyBase}hr-${idx}`} />);
    } else if (quote) {
      flushList();
      blocks.push(<blockquote key={`${keyBase}q-${idx}`}>{renderInline(quote[1], `${keyBase}q-${idx}`, handlers, linkIndex)}</blockquote>);
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
      blocks.push(<p key={`${keyBase}p-${idx}`}>{renderInline(line, `${keyBase}p-${idx}`, handlers, linkIndex)}</p>);
    }
  });
  flushList();
  if (codeBuffer !== null) {
    blocks.push(
      <pre key={`${keyBase}code-end`}>
        <code>{codeBuffer.join('\n')}</code>
      </pre>
    );
  }
  return blocks;
}

// The frontmatter block, rendered as a small key/value "Properties" panel —
// a lighter-weight stand-in for Obsidian's Properties editor UI.
function PropertiesPanel({ properties, handlers }) {
  if (!properties.length) return null;
  return (
    <div className="properties-panel">
      {properties.map((p) => {
        const isTagProp = /^tags?$/i.test(p.key);
        return (
          <div className="properties-row" key={p.key}>
            <span className="properties-key">{p.key}</span>
            <span className="properties-value">
              {isTagProp ? (
                splitListValue(p.value).map((t) => (
                  <span
                    key={t}
                    className="tag-chip"
                    onClick={() => handlers.onOpenTag && handlers.onOpenTag(t.replace(/^#/, ''))}
                  >
                    #{t.replace(/^#/, '')}
                  </span>
                ))
              ) : (
                <span>{p.value}</span>
              )}
            </span>
          </div>
        );
      })}
    </div>
  );
}

// Extracts a short, highlighted context snippet around the first
// occurrence of `needle` in `haystack` — used by both the search results
// panel and the inline "Linked/Unlinked mentions" sections at the bottom
// of a note, so both features share one look.
function snippetAround(haystack, needle, radius = 60) {
  const lower = haystack.toLowerCase();
  const idx = needle ? lower.indexOf(needle.toLowerCase()) : -1;
  if (idx === -1) {
    return { before: haystack.slice(0, radius * 2), match: '', after: '' };
  }
  const start = Math.max(0, idx - radius);
  const end = Math.min(haystack.length, idx + needle.length + radius);
  return {
    before: (start > 0 ? '…' : '') + haystack.slice(start, idx),
    match: haystack.slice(idx, idx + needle.length),
    after: haystack.slice(idx + needle.length, end) + (end < haystack.length ? '…' : '')
  };
}

function HighlightedSnippet({ text, needle }) {
  const { before, match, after } = snippetAround(text, needle);
  return (
    <>
      {before}
      {match && <mark>{match}</mark>}
      {after}
    </>
  );
}

// Inline "Linked mentions" / "Unlinked mentions" — reproduces Obsidian's
// in-document backlinks pane. Linked mentions are notes that [[link]] here
// (grouped by source note, each occurrence shown with context and the
// link text highlighted); unlinked mentions are notes that mention this
// note's title as plain text without ever linking to it.
function InlineMentions({ file, linkIndex, getBody, backlinkFileIds, allFiles, onOpenNote }) {
  const [linkedOpen, setLinkedOpen] = useState(true);
  const [unlinkedOpen, setUnlinkedOpen] = useState(false);

  const linked = useMemo(() => {
    return backlinkFileIds
      .map((id) => allFiles.find((f) => f.id === id))
      .filter(Boolean)
      .map((src) => {
        const body = getBody(src.id);
        const occurrences = [];
        const re = /!?\[\[([^[\]|#]+)(?:#[^[\]|]*)?(?:\|[^[\]]+)?\]\]/g;
        let m;
        while ((m = re.exec(body)) !== null) {
          const res = resolveLinkTarget(m[1].trim(), linkIndex);
          if (res.status === 'resolved' && res.file.id === file.id) {
            occurrences.push(snippetAround(body, m[0]));
          }
        }
        return { src, occurrences: occurrences.length ? occurrences : [snippetAround(body, '')] };
      })
      .sort((a, b) => a.src.name.localeCompare(b.src.name));
  }, [backlinkFileIds, allFiles, getBody, linkIndex, file.id]);

  const unlinked = useMemo(() => {
    const title = (file.baseName || file.name || '').trim();
    if (!title) return [];
    const titleLower = title.toLowerCase();
    const linkedIds = new Set(backlinkFileIds);
    return allFiles
      .filter((f) => f.kind === 'note' && f.id !== file.id && !linkedIds.has(f.id))
      .map((f) => {
        const body = getBody(f.id);
        if (!body || !body.toLowerCase().includes(titleLower)) return null;
        // Skip if every occurrence is actually inside a [[...]] (already
        // counted as linked some other way, or a partial-name collision).
        return { src: f, occurrences: [snippetAround(body, title)] };
      })
      .filter(Boolean)
      .sort((a, b) => a.src.name.localeCompare(b.src.name));
  }, [allFiles, getBody, file, backlinkFileIds]);

  const linkedCount = linked.reduce((n, g) => n + g.occurrences.length, 0);

  return (
    <div className="inline-mentions">
      <div className="mentions-group">
        <button className="mentions-header" onClick={() => setLinkedOpen((v) => !v)}>
          {linkedOpen ? <IconChevronDown size={13} /> : <IconChevronRight size={13} />}
          <span>Linked mentions</span>
          <span className="mentions-count">{linkedCount}</span>
        </button>
        {linkedOpen && (
          <div className="mentions-body">
            {linked.length === 0 && <p className="muted small">No notes link here yet.</p>}
            {linked.map(({ src, occurrences }) => (
              <div className="mentions-source" key={src.id}>
                <button className="mentions-source-name" onClick={() => onOpenNote(src.id)}>
                  {src.name.replace(/\.md$/i, '')}
                </button>
                {occurrences.map((occ, i) => (
                  <div className="mentions-snippet" key={i} onClick={() => onOpenNote(src.id)}>
                    {occ.before}
                    {occ.match && <mark>{occ.match}</mark>}
                    {occ.after}
                  </div>
                ))}
              </div>
            ))}
          </div>
        )}
      </div>
      <div className="mentions-group">
        <button className="mentions-header muted-header" onClick={() => setUnlinkedOpen((v) => !v)}>
          {unlinkedOpen ? <IconChevronDown size={13} /> : <IconChevronRight size={13} />}
          <span>Unlinked mentions</span>
          <span className="mentions-count">{unlinked.length}</span>
        </button>
        {unlinkedOpen && (
          <div className="mentions-body">
            {unlinked.length === 0 && <p className="muted small">No unlinked mentions.</p>}
            {unlinked.map(({ src, occurrences }) => (
              <div className="mentions-source" key={src.id}>
                <button className="mentions-source-name" onClick={() => onOpenNote(src.id)}>
                  {src.name.replace(/\.md$/i, '')}
                </button>
                {occurrences.map((occ, i) => (
                  <div className="mentions-snippet" key={i} onClick={() => onOpenNote(src.id)}>
                    {occ.before}
                    {occ.match && <mark>{occ.match}</mark>}
                    {occ.after}
                  </div>
                ))}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// UI: login / folder-select / loading screens
// ---------------------------------------------------------------------------
function LoginScreen({ onSignIn, ready, onSignInProxy }) {
  const [showProxyForm, setShowProxyForm] = useState(false);
  const [proxyUrl, setProxyUrl] = useState(() => localStorage.getItem('vault_proxy_url_draft') || '');
  const [proxySecret, setProxySecret] = useState('');

  const submitProxy = (e) => {
    e.preventDefault();
    if (!proxyUrl.trim() || !proxySecret.trim()) return;
    localStorage.setItem('vault_proxy_url_draft', proxyUrl.trim());
    onSignInProxy(proxyUrl.trim(), proxySecret.trim());
  };

  return (
    <div className="center-screen">
      <div className="brand-mark" aria-hidden="true">
        <IconFolder size={22} />
      </div>
      <h1>Vault</h1>
      <p className="muted">Your notes, in your Google Drive. Nothing stored on this device.</p>
      <button className="btn btn-primary" disabled={!ready} onClick={onSignIn}>
        {ready ? 'Sign in with Google' : 'Loading…'}
      </button>

      {!showProxyForm ? (
        <button className="btn btn-secondary" onClick={() => setShowProxyForm(true)}>
          Use Apps Script proxy instead
        </button>
      ) : (
        <form className="proxy-form" onSubmit={submitProxy}>
          <input
            type="url"
            placeholder="Apps Script Web App URL"
            value={proxyUrl}
            onChange={(e) => setProxyUrl(e.target.value)}
            required
          />
          <input
            type="password"
            placeholder="Shared secret"
            value={proxySecret}
            onChange={(e) => setProxySecret(e.target.value)}
            required
          />
          <button type="submit" className="btn btn-primary">
            Connect
          </button>
        </form>
      )}
    </div>
  );
}

function FolderPrompt({ onPick }) {
  return (
    <div className="center-screen">
      <div className="brand-mark" aria-hidden="true">
        <IconFolder size={22} />
      </div>
      <h1>Choose your vault</h1>
      <p className="muted">Pick the Google Drive folder that holds (or will hold) your notes.</p>
      <button className="btn btn-primary" onClick={onPick}>
        Select Drive folder
      </button>
    </div>
  );
}

// Picker needs an OAuth token, which proxy mode doesn't have — this
// replaces it for that mode only, browsing folders via the Apps Script
// proxy's "browse" action instead.
function ProxyFolderPicker({ token, onPick, onCancel }) {
  const [stack, setStack] = useState([{ id: 'root', name: 'Drives' }]);
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [manualInput, setManualInput] = useState('');
  const [resolving, setResolving] = useState(false);
  const [resolveError, setResolveError] = useState('');
  const current = stack[stack.length - 1];

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    driveBrowseFolders(token, current.id).then((folders) => {
      if (!cancelled) {
        setItems(folders);
        setLoading(false);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [token, current.id]);

  const handleUseManualId = async () => {
    if (!manualInput.trim()) return;
    setResolving(true);
    setResolveError('');
    try {
      const meta = await driveResolveFolder(token, manualInput);
      onPick(meta);
    } catch (err) {
      setResolveError(err.message || 'Could not access that folder');
    } finally {
      setResolving(false);
    }
  };

  return (
    <div className="modal-overlay">
      <div className="modal">
        <h3>Select vault folder</h3>
        <div className="breadcrumb">
          {stack.map((s, i) => (
            <span key={s.id}>
              <button className="link-btn" onClick={() => setStack(stack.slice(0, i + 1))}>
                {s.name}
              </button>
              {i < stack.length - 1 ? ' / ' : ''}
            </span>
          ))}
        </div>
        {loading ? (
          <p className="muted">Loading…</p>
        ) : (
          <ul className="folder-list">
            {items.length === 0 && <li className="muted">No subfolders here</li>}
            {items.map((f) => (
              <li key={f.id}>
                <button className="link-btn" onClick={() => setStack([...stack, f])}>
                  {f.isDrive ? <IconDrive size={14} /> : <IconFolder size={14} />}
                  {f.name}
                </button>
              </li>
            ))}
          </ul>
        )}
        <div className="manual-folder-entry">
          <p className="muted small">
            Folder not showing up (e.g. under "Computers")? Paste its link or ID instead:
          </p>
          <div className="manual-folder-row">
            <input
              type="text"
              placeholder="Drive folder link or ID"
              value={manualInput}
              onChange={(e) => setManualInput(e.target.value)}
            />
            <button className="btn" disabled={!manualInput.trim() || resolving} onClick={handleUseManualId}>
              {resolving ? 'Checking…' : 'Use'}
            </button>
          </div>
          {resolveError && <p className="error-text">{resolveError}</p>}
        </div>
        <div className="modal-actions">
          <button className="btn" onClick={onCancel}>
            Cancel
          </button>
          <button className="btn btn-primary" onClick={() => onPick(current)}>
            Use "{current.name}"
          </button>
        </div>
      </div>
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
      <div className="brand-mark" aria-hidden="true">
        <IconFolder size={22} />
      </div>
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

// ---------------------------------------------------------------------------
// Generic dropdown menu — trigger button + floating panel, closes on
// outside click or Escape. Backs the merged "add item" button, per-row
// "⋮" menus, and the tab context menu.
// ---------------------------------------------------------------------------
// Accepts either a single ref or an array of refs — a click/touch is only
// "outside" if it falls outside every ref's subtree. Used so a menu rendered
// via portal (outside the trigger's DOM subtree) can still be treated as
// "inside" for the purposes of dismissal.
function useClickOutside(refs, onOutside) {
  useEffect(() => {
    const list = Array.isArray(refs) ? refs : [refs];
    function handler(e) {
      const inside = list.some((r) => r.current && r.current.contains(e.target));
      if (!inside) onOutside();
    }
    document.addEventListener('mousedown', handler);
    document.addEventListener('touchstart', handler);
    return () => {
      document.removeEventListener('mousedown', handler);
      document.removeEventListener('touchstart', handler);
    };
  }, [refs, onOutside]);
}

// Dropdown menu whose panel is rendered into a portal at the document root
// and positioned with `position: fixed` from the trigger's live bounding
// rect. Rendering in-place (as a plain absolutely-positioned child) would
// get clipped by any scrolling/overflow ancestor between the trigger and the
// viewport (e.g. the horizontally-scrolling tab bar) — the portal sidesteps
// that entirely, and keeps the menu above every other layer of the UI.
function DropdownMenu({ trigger, children, align = 'left', className = '' }) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState(null);
  const anchorRef = useRef(null);
  const menuRef = useRef(null);
  useClickOutside([anchorRef, menuRef], () => setOpen(false));

  const computePos = useCallback(() => {
    const el = anchorRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    setPos({ top: rect.bottom + 4, left: rect.left, right: window.innerWidth - rect.right });
  }, []);

  useLayoutEffect(() => {
    if (!open) return;
    computePos();
    const onReflow = () => computePos();
    window.addEventListener('resize', onReflow);
    window.addEventListener('scroll', onReflow, true);
    return () => {
      window.removeEventListener('resize', onReflow);
      window.removeEventListener('scroll', onReflow, true);
    };
  }, [open, computePos]);

  const toggle = useCallback(() => setOpen((v) => !v), []);

  return (
    <div className={`dropdown-wrap ${className}`} ref={anchorRef}>
      {trigger(toggle, open)}
      {open &&
        pos &&
        createPortal(
          <div
            ref={menuRef}
            className={`dropdown-menu portal align-${align}`}
            style={align === 'right' ? { top: pos.top, right: pos.right } : { top: pos.top, left: pos.left }}
            onClick={() => setOpen(false)}
          >
            {children}
          </div>,
          document.body
        )}
    </div>
  );
}

function MenuItem({ icon, children, danger, onClick, disabled }) {
  return (
    <button className={`menu-item ${danger ? 'danger' : ''}`} onClick={onClick} disabled={disabled}>
      {icon}
      <span>{children}</span>
    </button>
  );
}

function MenuDivider() {
  return <div className="menu-divider" />;
}

// ---------------------------------------------------------------------------
// Activity bar — the thin left-most icon ribbon, mirroring Obsidian's icon
// strip. Switches which panel the side dock shows.
// ---------------------------------------------------------------------------
function ActivityBar({ activeView, onSetView, onOpenCommandPalette, onSync, syncing, onChangeFolder, onSignOut, folderName }) {
  const item = (view, Icon, label, extra) => (
    <button
      className={`activity-btn ${activeView === view ? 'active' : ''}`}
      onClick={() => onSetView(view)}
      title={label}
      aria-label={label}
    >
      <Icon size={19} />
      {extra}
    </button>
  );
  return (
    <div className="activity-bar">
      <div className="activity-bar-top">
        {item('explorer', IconFilePlus, 'Files')}
        {item('search', IconSearch, 'Search')}
        {item('tags', IconTag, 'Tags')}
        {item('bookmarks', IconStar, 'Bookmarks')}
      </div>
      <div className="activity-bar-bottom">
        <button className="activity-btn" onClick={onOpenCommandPalette} title="Command palette (⌘K)">
          <IconCommand size={18} />
        </button>
        <button className="activity-btn" onClick={onSync} title="Sync vault" disabled={syncing}>
          {syncing ? <IconLoader size={18} /> : <IconRefresh size={18} />}
        </button>
        <button className="activity-btn" onClick={onChangeFolder} title={`Vault: ${folderName || ''} — change folder`}>
          <IconFolder size={18} />
        </button>
        <button className="activity-btn" onClick={onSignOut} title="Sign out">
          <IconLogOut size={18} />
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// File explorer — tree view, drag-and-drop reorganization, and the merged
// "add item" dropdown (New note / New folder / Upload files) that replaces
// the old separate +note / +folder buttons.
// ---------------------------------------------------------------------------
const DND_MIME = 'application/x-vault-node';

function AddMenu({ onNewNote, onNewFolder, onUploadFiles, canUpload, align = 'left' }) {
  const fileInputRef = useRef(null);
  return (
    <DropdownMenu
      align={align}
      trigger={(toggle) => (
        <button className="icon-btn" onClick={toggle} title="New note, folder, or upload" aria-label="Add">
          <IconPlus size={16} />
        </button>
      )}
    >
      <MenuItem icon={<IconFilePlus size={15} />} onClick={onNewNote}>
        New note
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

function TreeItemMenu({ isFolder, canUpload, onNewNote, onNewFolder, onUploadFiles, onRename, onToggleBookmark, isBookmarked, onDelete }) {
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

function TreeNode({
  node,
  depth,
  currentIds,
  expanded,
  onToggleExpand,
  onOpenFile,
  onOpenImage,
  onCreateNote,
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
    const isImage = node.kind === 'image';
    const isBookmarked = bookmarks.has(node.id);
    return (
      <div className={`tree-row ${isDragOver ? 'drag-over' : ''}`}>
        <button
          className={`tree-item tree-file ${currentIds.has(node.id) ? 'active' : ''}`}
          style={indent}
          draggable
          onDragStart={handleDragStart}
          onDragEnd={handleDragEnd}
          onClick={(e) => (isImage ? onOpenImage(node) : onOpenFile(node.id, e))}
        >
          {isBookmarked && <IconStarFilled className="bookmark-dot" size={11} />}
          <span className="tree-label">{isImage ? node.name : node.name.replace(/\.md$/i, '')}</span>
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
}

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

function ExplorerPanel({
  tree,
  vaultRootId,
  currentIds,
  onOpenFile,
  onOpenImage,
  onCreateNote,
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
        {tree.length === 0 && <p className="muted small empty-hint">Empty vault — use + to add a note.</p>}
        <div className={`root-drop-zone ${dragState.overId === vaultRootId ? 'drag-over' : ''}`} />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Search panel — Obsidian-style operators (path:, file:, tag:, line:,
// section:, [property]), grouped-by-file results with highlighted context
// snippets, collapsible per file.
// ---------------------------------------------------------------------------
const SEARCH_HELP = [
  { op: 'path:', desc: 'match path of the file' },
  { op: 'file:', desc: 'match file name' },
  { op: 'tag:', desc: 'search for tags' },
  { op: 'line:', desc: 'keywords on same line' },
  { op: 'section:', desc: 'keywords under same heading' },
  { op: '[property]', desc: 'match property' }
];

function SearchPanel({ query, setQuery, filesMeta, linkIndex, getBody, tagsByFileId, onOpenNote, indexing, ensureIndexed, indexVersion }) {
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [collapsed, setCollapsed] = useState(new Set());
  const [showHelp, setShowHelp] = useState(false);
  const [sortDesc, setSortDesc] = useState(false);
  const inputRef = useRef(null);

  useEffect(() => {
    ensureIndexed();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const results = useMemo(() => {
    if (!query.trim()) return [];
    const effectiveGetBody = caseSensitive ? getBody : (id) => getBody(id);
    const r = runVaultSearch(query, filesMeta, linkIndex, effectiveGetBody, tagsByFileId);
    return sortDesc ? r.slice().reverse() : r;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, filesMeta, linkIndex, getBody, tagsByFileId, sortDesc, caseSensitive, indexVersion]);

  const toggleCollapsed = (id) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });

  const totalMatches = results.reduce((n, r) => n + (r.matchCount ?? (r.matches.length ? r.matches.length : 1)), 0);

  return (
    <div className="side-panel search-panel">
      <div className="search-bar">
        <IconSearch className="search-bar-icon" size={15} />
        <input
          ref={inputRef}
          className="search-bar-input"
          placeholder="Search…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        {query && (
          <button className="search-bar-clear" onClick={() => setQuery('')} aria-label="Clear search">
            <IconX size={13} />
          </button>
        )}
        <button
          className={`search-bar-case ${caseSensitive ? 'active' : ''}`}
          onClick={() => setCaseSensitive((v) => !v)}
          title="Match case"
        >
          Aa
        </button>
        <DropdownMenu
          align="right"
          trigger={(toggle) => (
            <button className="icon-btn" onClick={toggle} title="Search options">
              <IconSliders size={15} />
            </button>
          )}
        >
          <div className="search-options-menu">
            <div className="search-options-title">
              Search options
              <IconInfo size={13} onClick={() => setShowHelp((v) => !v)} />
            </div>
            {SEARCH_HELP.map((h) => (
              <div className="search-options-row" key={h.op}>
                <code>{h.op}</code>
                <span>{h.desc}</span>
              </div>
            ))}
          </div>
        </DropdownMenu>
      </div>

      {indexing.building && (
        <div className="indexing-banner">
          <IconLoader size={13} />
          Indexing vault… {indexing.progress.loaded}/{indexing.progress.total}
        </div>
      )}

      {query.trim() ? (
        <>
          <div className="search-results-meta">
            <span>{results.length} result{results.length === 1 ? '' : 's'}</span>
            <button className="link-btn small" onClick={() => setSortDesc((v) => !v)}>
              File name ({sortDesc ? 'Z to A' : 'A to Z'})
            </button>
          </div>
          <div className="side-panel-body search-results">
            {results.length === 0 && <p className="muted small empty-hint">No matches found.</p>}
            {results.map(({ file, path, matches }) => {
              const isCollapsed = collapsed.has(file.id);
              return (
                <div className="search-result-group" key={file.id}>
                  <button className="search-result-header" onClick={() => toggleCollapsed(file.id)}>
                    {isCollapsed ? <IconChevronRight size={13} /> : <IconChevronDown size={13} />}
                    <span className="search-result-name">{file.name.replace(/\.md$/i, '')}</span>
                    <span className="search-result-count">{matches.length || 1}</span>
                  </button>
                  {!isCollapsed && (
                    <div className="search-result-snippets">
                      {(matches.length ? matches : [{ line: path, lineNumber: null }]).map((m, i) => (
                        <div className="search-snippet" key={i} onClick={() => onOpenNote(file.id)}>
                          <SearchHighlightedLine line={m.line} terms={m.terms || []} />
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </>
      ) : (
        <p className="muted small empty-hint">
          Type to search across your vault. Try <code>tag:</code>, <code>path:</code>, or plain text.
        </p>
      )}
    </div>
  );
}

// Highlights every occurrence of any search term within a line of text —
// used for search result snippets (as opposed to HighlightedSnippet, which
// highlights a single [[link]] occurrence for the inline mentions panel).
function SearchHighlightedLine({ line, terms }) {
  if (!terms.length) return <>{line}</>;
  const re = new RegExp(`(${terms.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})`, 'gi');
  const parts = line.split(re);
  return (
    <>
      {parts.map((part, i) => (terms.some((t) => part.toLowerCase() === t.toLowerCase()) ? <mark key={i}>{part}</mark> : part))}
    </>
  );
}

// ---------------------------------------------------------------------------
// Tags panel — every tag in the vault with a note count, clicking opens it
// as a search query.
// ---------------------------------------------------------------------------
function TagsPanel({ filesMeta, getBody, onOpenTag, indexing, ensureIndexed, indexVersion }) {
  useEffect(() => {
    ensureIndexed();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const tags = useMemo(() => buildTagIndex(filesMeta, getBody), [filesMeta, getBody, indexVersion]);

  return (
    <div className="side-panel">
      <div className="side-panel-header">
        <span className="side-panel-title">Tags</span>
        <span className="side-panel-count">{tags.length}</span>
      </div>
      {indexing.building && (
        <div className="indexing-banner">
          <IconLoader size={13} />
          Indexing vault… {indexing.progress.loaded}/{indexing.progress.total}
        </div>
      )}
      <div className="side-panel-body tag-list">
        {tags.length === 0 && <p className="muted small empty-hint">No tags yet. Use #tag anywhere in a note.</p>}
        {tags.map(({ tag, files }) => (
          <button key={tag} className="tag-row" onClick={() => onOpenTag(tag)}>
            <IconTag size={13} className="tag-row-icon" />
            <span className="tag-row-name">{tag}</span>
            <span className="tag-row-count">{files.length}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Bookmarks panel — a lightweight take on Obsidian's Bookmarks core plugin.
// ---------------------------------------------------------------------------
function BookmarksPanel({ bookmarks, filesMeta, onOpenFile, onOpenImage, onToggleBookmark }) {
  const items = filesMeta
    .filter((f) => bookmarks.has(f.id))
    .sort((a, b) => a.name.localeCompare(b.name));
  return (
    <div className="side-panel">
      <div className="side-panel-header">
        <span className="side-panel-title">Bookmarks</span>
      </div>
      <div className="side-panel-body">
        {items.length === 0 && <p className="muted small empty-hint">Star a note or image to bookmark it.</p>}
        {items.map((f) => {
          const isImage = f.kind === 'image';
          return (
            <div className="tree-row" key={f.id}>
              <button
                className="tree-item tree-file"
                onClick={() => (isImage ? onOpenImage(f) : onOpenFile(f.id))}
              >
                <IconStarFilled size={12} className="bookmark-dot" />
                <span className="tree-label">{isImage ? f.name : f.name.replace(/\.md$/i, '')}</span>
              </button>
              <button className="tree-menu-btn" title="Remove bookmark" onClick={() => onToggleBookmark(f.id)}>
                <IconX size={13} />
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Split-pane tree helpers. A node is either:
//   { type: 'leaf', id, tabs: [{ id, fileId, mode, history, historyIndex }], activeTabId }
//   { type: 'split', id, direction: 'row'|'column', children: [node,...], sizes: [%,...] }
// ---------------------------------------------------------------------------
let uidCounter = 0;
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
          const label = file ? file.name.replace(/\.md$/i, '') : 'Untitled';
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
  const label = file.kind === 'image' || isImageName(file.name) ? file.name : file.name.replace(/\.md$/i, '');
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
        {file && file.kind !== 'image' && (
          <button className="icon-btn" onClick={onToggleBookmark} title={isBookmarked ? 'Remove bookmark' : 'Bookmark note'}>
            {isBookmarked ? <IconStarFilled size={15} /> : <IconStar size={15} />}
          </button>
        )}
        {file && file.kind !== 'image' && (
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

// ---------------------------------------------------------------------------
// Editor content — the textarea (source) or rendered preview for a single
// open tab. Mode is a per-tab property now, toggled from PaneHeader.
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// Source-mode syntax highlighting — mirrors Obsidian's "source mode": the
// raw markdown stays fully intact and editable (nothing is hidden or
// stripped), but the marker characters (#, *, _, `, [[ ]]) are dimmed and
// the content they wrap is styled (headings sized up, links colored, etc).
// Rendered as a layer positioned exactly behind a transparent-text textarea
// (see the `.editor-textarea-source` styles) — this function only ever
// changes color/weight/size, never the text content or its layout width, so
// the overlay's line-wrapping stays pixel-identical to the real textarea.
// ---------------------------------------------------------------------------
const INLINE_SYNTAX_RE =
  /(\[\[[^\]|]+(?:\|[^\]]+)?\]\])|(\[[^\]]+\]\([^)]+\))|(\*\*[^*]+\*\*)|(__[^_]+__)|(`[^`]+`)|(#[\w/-]+)|(\*[^*\s][^*]*?\*)|(_[^_\s][^_]*?_)/g;

function highlightInlineSyntax(text, keyPrefix) {
  if (!text) return null;
  const nodes = [];
  let lastIndex = 0;
  let i = 0;
  let m;
  INLINE_SYNTAX_RE.lastIndex = 0;
  while ((m = INLINE_SYNTAX_RE.exec(text)) !== null) {
    const token = m[0];
    if (m.index > lastIndex) nodes.push(text.slice(lastIndex, m.index));
    const key = `${keyPrefix}-i${i++}`;
    if (token.startsWith('[[')) {
      const inner = token.slice(2, -2);
      const pipe = inner.indexOf('|');
      const target = pipe === -1 ? inner : inner.slice(0, pipe);
      const alias = pipe === -1 ? null : inner.slice(pipe + 1);
      nodes.push(
        <span key={key}>
          <span className="syn-mark">[[</span>
          <span className="syn-link">{target}</span>
          {alias !== null && (
            <span>
              <span className="syn-mark">|</span>
              <span className="syn-link">{alias}</span>
            </span>
          )}
          <span className="syn-mark">]]</span>
        </span>
      );
    } else if (token[0] === '[') {
      const mm = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(token);
      nodes.push(
        <span key={key}>
          <span className="syn-mark">[</span>
          <span className="syn-link">{mm ? mm[1] : token}</span>
          <span className="syn-mark">{`](${mm ? mm[2] : ''})`}</span>
        </span>
      );
    } else if (token.startsWith('**')) {
      nodes.push(
        <span key={key}>
          <span className="syn-mark">**</span>
          <span className="syn-bold">{token.slice(2, -2)}</span>
          <span className="syn-mark">**</span>
        </span>
      );
    } else if (token.startsWith('__')) {
      nodes.push(
        <span key={key}>
          <span className="syn-mark">__</span>
          <span className="syn-bold">{token.slice(2, -2)}</span>
          <span className="syn-mark">__</span>
        </span>
      );
    } else if (token[0] === '`') {
      nodes.push(
        <span key={key}>
          <span className="syn-mark">`</span>
          <span className="syn-code">{token.slice(1, -1)}</span>
          <span className="syn-mark">`</span>
        </span>
      );
    } else if (token[0] === '#') {
      nodes.push(
        <span key={key} className="syn-tag">
          {token}
        </span>
      );
    } else if (token[0] === '*') {
      nodes.push(
        <span key={key}>
          <span className="syn-mark">*</span>
          <span className="syn-italic">{token.slice(1, -1)}</span>
          <span className="syn-mark">*</span>
        </span>
      );
    } else {
      nodes.push(
        <span key={key}>
          <span className="syn-mark">_</span>
          <span className="syn-italic">{token.slice(1, -1)}</span>
          <span className="syn-mark">_</span>
        </span>
      );
    }
    lastIndex = m.index + token.length;
  }
  if (lastIndex < text.length) nodes.push(text.slice(lastIndex));
  return nodes;
}

// A list item's text can start with a "[ ]" / "[x]" task checkbox before any
// other inline syntax — handled as its own leading token, then the rest goes
// through the normal inline pass.
function highlightListBody(text, keyPrefix) {
  const m = /^(\[[ xX]\])(.*)$/.exec(text);
  if (!m) return highlightInlineSyntax(text, keyPrefix);
  return (
    <span key={`${keyPrefix}-task`}>
      <span className="syn-mark syn-task">{m[1]}</span>
      {highlightInlineSyntax(m[2], `${keyPrefix}-t`)}
    </span>
  );
}

function highlightSourceLine(line, lineKey) {
  let m = /^(#{1,6})( +)(.*)$/.exec(line);
  if (m) {
    return (
      <span key={lineKey}>
        <span className="syn-mark">{m[1] + m[2]}</span>
        <span className={`syn-h syn-h${m[1].length}`}>{highlightInlineSyntax(m[3], `${lineKey}h`)}</span>
      </span>
    );
  }

  if (/^ {0,3}(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
    return (
      <span key={lineKey} className="syn-mark">
        {line}
      </span>
    );
  }

  m = /^(\s{0,3}>+)( ?)(.*)$/.exec(line);
  if (m) {
    return (
      <span key={lineKey}>
        <span className="syn-mark">{m[1] + m[2]}</span>
        <span className="syn-quote">{highlightInlineSyntax(m[3], `${lineKey}q`)}</span>
      </span>
    );
  }

  m = /^(\s*)(\d{1,9}[.)])( +)(.*)$/.exec(line);
  if (m) {
    return (
      <span key={lineKey}>
        {m[1]}
        <span className="syn-mark">{m[2]}</span>
        {m[3]}
        {highlightListBody(m[4], `${lineKey}ol`)}
      </span>
    );
  }

  m = /^(\s*)([-*+])( +)(.*)$/.exec(line);
  if (m) {
    return (
      <span key={lineKey}>
        {m[1]}
        <span className="syn-mark">{m[2]}</span>
        {m[3]}
        {highlightListBody(m[4], `${lineKey}ul`)}
      </span>
    );
  }

  return <span key={lineKey}>{highlightInlineSyntax(line, lineKey)}</span>;
}

function highlightMarkdownSource(text) {
  const lines = text.split('\n');
  const out = [];
  lines.forEach((line, idx) => {
    out.push(highlightSourceLine(line, `l${idx}`));
    if (idx < lines.length - 1) out.push('\n');
  });
  return out;
}

// ---------------------------------------------------------------------------
// Custom undo/redo for the note editor. The textarea is fully React-
// controlled, so any programmatic value swap (accepting a [[ autocomplete
// suggestion, etc.) clears the browser's native undo stack — this keeps its
// own stack instead, coalescing rapid same-size keystrokes (ordinary typing)
// into a single undo step and treating pastes/deletes/programmatic jumps as
// their own step, the same grouping heuristic most text editors use.
// ---------------------------------------------------------------------------
const UNDO_COALESCE_MS = 700;

function useEditorUndo(initialValue) {
  const historyRef = useRef({ past: [], future: [], last: initialValue, lastTime: 0 });

  const record = useCallback((newValue) => {
    const h = historyRef.current;
    const now = Date.now();
    const bigJump = Math.abs(newValue.length - h.last.length) > 1;
    if (now - h.lastTime > UNDO_COALESCE_MS || bigJump) {
      h.past.push(h.last);
      if (h.past.length > 200) h.past.shift();
      h.future = [];
    }
    h.last = newValue;
    h.lastTime = now;
  }, []);

  const undo = useCallback(() => {
    const h = historyRef.current;
    if (!h.past.length) return null;
    const prev = h.past.pop();
    h.future.push(h.last);
    h.last = prev;
    h.lastTime = 0;
    return prev;
  }, []);

  const redo = useCallback(() => {
    const h = historyRef.current;
    if (!h.future.length) return null;
    const next = h.future.pop();
    h.past.push(h.last);
    h.last = next;
    h.lastTime = 0;
    return next;
  }, []);

  return { record, undo, redo };
}

// Inline-editable note title, shown above the note content in both edit and
// reading view. Renames the underlying file on blur / Enter, matching
// Obsidian's "click the title to rename" behavior. Keeps its own draft state
// so keystrokes aren't round-tripped through a Drive rename on every change —
// only committed once editing settles.
function NoteTitleField({ file, onRename }) {
  const [draft, setDraft] = useState(() => file.name.replace(/\.md$/i, ''));
  const inputRef = useRef(null);

  useEffect(() => {
    setDraft(file.name.replace(/\.md$/i, ''));
  }, [file.id, file.name]);

  const commit = useCallback(() => {
    const trimmed = draft.trim();
    const current = file.name.replace(/\.md$/i, '');
    if (trimmed && trimmed !== current) {
      onRename(file.id, trimmed);
    } else {
      setDraft(current);
    }
  }, [draft, file.id, file.name, onRename]);

  return (
    <input
      ref={inputRef}
      className="note-title-input"
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          inputRef.current?.blur();
        } else if (e.key === 'Escape') {
          setDraft(file.name.replace(/\.md$/i, ''));
          inputRef.current?.blur();
        }
      }}
      placeholder="Untitled"
      aria-label="Note title"
    />
  );
}

function EditorContent({ file, content, onChange, linkIndex, phantomRecords, handlers, mode, loadingNote, backlinkIndex, allFiles, getBody }) {
  const textareaRef = useRef(null);
  const highlightRef = useRef(null);
  const undoCtl = useEditorUndo(content);
  const wrappedOnChange = useCallback(
    (v) => {
      undoCtl.record(v);
      onChange(v);
    },
    [onChange, undoCtl]
  );
  const autocomplete = useLinkAutocomplete(textareaRef, wrappedOnChange, linkIndex, phantomRecords);

  if (!file) {
    return (
      <div className="editor-empty">
        <p className="muted">Select a note, or click a [[wikilink]] to create one.</p>
      </div>
    );
  }

  if (file.kind === 'image') {
    return <EmbeddedImagePane token={handlers.token} file={file} />;
  }

  const { properties, body } = parseFrontmatter(content);

  return (
    <div className="editor-panes">
      {loadingNote && <div className="note-loading-bar" aria-hidden="true" />}
      {mode === 'edit' ? (
        <div className="editor-textarea-wrap">
          <NoteTitleField file={file} onRename={handlers.onRenameFile} />
          <div className="editor-textarea-source">
            <div ref={highlightRef} className="editor-highlight" aria-hidden="true">
              {highlightMarkdownSource(content)}
              {'\n'}
            </div>
            <textarea
              ref={textareaRef}
              className="editor-textarea"
              value={content}
              onChange={(e) => {
                wrappedOnChange(e.target.value);
                autocomplete.updateFromCaret();
              }}
              onScroll={(e) => {
                if (highlightRef.current) {
                  highlightRef.current.scrollTop = e.target.scrollTop;
                  highlightRef.current.scrollLeft = e.target.scrollLeft;
                }
              }}
              onKeyUp={(e) => {
                if (!['ArrowUp', 'ArrowDown', 'Enter', 'Tab', 'Escape'].includes(e.key)) autocomplete.updateFromCaret();
              }}
              onKeyDown={(e) => {
                const mod = e.metaKey || e.ctrlKey;
                if (mod && !e.altKey && (e.key === 'z' || e.key === 'Z')) {
                  e.preventDefault();
                  const val = e.shiftKey ? undoCtl.redo() : undoCtl.undo();
                  if (val != null) {
                    onChange(val);
                    requestAnimationFrame(() => {
                      const ta = textareaRef.current;
                      if (ta) ta.setSelectionRange(val.length, val.length);
                    });
                  }
                  return;
                }
                if (mod && !e.altKey && (e.key === 'y' || e.key === 'Y')) {
                  e.preventDefault();
                  const val = undoCtl.redo();
                  if (val != null) {
                    onChange(val);
                    requestAnimationFrame(() => {
                      const ta = textareaRef.current;
                      if (ta) ta.setSelectionRange(val.length, val.length);
                    });
                  }
                  return;
                }
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
              placeholder="Start writing… use [[Note Name]] to link, #tag to tag, or [[image.png]] for images."
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
                    <span className="autocomplete-label">{item.baseName}</span>
                    {item.isPhantom ? (
                      <span className="autocomplete-new">new</span>
                    ) : (
                      item.relativePath !== item.baseName && <span className="autocomplete-path">{item.dir}/</span>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      ) : (
        <div className="editor-preview">
          <NoteTitleField file={file} onRename={handlers.onRenameFile} />
          <PropertiesPanel properties={properties} handlers={handlers} />
          {renderMarkdownBlocks(body, handlers, linkIndex)}
          <InlineMentions
            file={linkIndex.records.find((r) => r.id === file.id) || file}
            linkIndex={linkIndex}
            getBody={getBody}
            backlinkFileIds={Array.from(backlinkIndex.get(file.id) || [])}
            allFiles={allFiles}
            onOpenNote={handlers.onOpenById}
          />
        </div>
      )}
    </div>
  );
}

function EmbeddedImagePane({ token, file }) {
  const { url, error } = useDriveImageUrl(token, file.id);
  return (
    <div className="editor-preview image-pane">
      <h1 className="preview-title">{file.name}</h1>
      {error && <p className="muted small">{error}</p>}
      {!error && !url && <p className="muted small">Loading…</p>}
      {url && <img src={url} alt={file.name} className="image-pane-img" />}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Status bar — global footer reflecting the currently focused pane's file:
// word count, character count, backlink count, property count, plus a
// small live sync indicator on the far right.
// ---------------------------------------------------------------------------
function StatusBar({ file, content, backlinkCount, syncing, syncError, dirty, saving }) {
  const { properties, body } = parseFrontmatter(content || '');
  const words = body.trim() ? body.trim().split(/\s+/).length : 0;
  const chars = body.length;

  return (
    <footer className="status-bar">
      <div className="status-bar-left">
        {file && (
          <>
            <span>{backlinkCount} backlink{backlinkCount === 1 ? '' : 's'}</span>
            <span>{properties.length} propert{properties.length === 1 ? 'y' : 'ies'}</span>
            <span>{words} word{words === 1 ? '' : 's'}</span>
            <span>{chars} character{chars === 1 ? '' : 's'}</span>
            {file.kind !== 'image' && (
              <span className="status-save-state" title={saving ? 'Saving…' : dirty ? 'Unsaved changes' : 'Saved'}>
                {saving ? <IconLoader size={12} /> : dirty ? null : <IconCheck size={12} />}
              </span>
            )}
          </>
        )}
      </div>
      <div className="status-bar-right">
        {syncError && (
          <span className="status-sync-error" title={syncError}>
            <IconAlertTriangle size={13} />
          </span>
        )}
        <span className={`status-sync-dot ${syncing ? 'syncing' : ''}`} title={syncing ? 'Syncing…' : 'Synced with Drive'} />
      </div>
    </footer>
  );
}

// ---------------------------------------------------------------------------
// Recursive pane-tree renderer, with a draggable resize handle between
// each pair of siblings in a split.
// ---------------------------------------------------------------------------
function ResizeHandle({ direction, onResize }) {
  const draggingRef = useRef(false);
  const onMouseDown = (e) => {
    e.preventDefault();
    draggingRef.current = true;
    const move = (ev) => {
      if (!draggingRef.current) return;
      onResize(direction === 'row' ? ev.movementX : ev.movementY);
    };
    const up = () => {
      draggingRef.current = false;
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  };
  return <div className={`resize-handle resize-${direction}`} onMouseDown={onMouseDown} />;
}

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
      {activeTab && (
        <PaneHeader
          leaf={leaf}
          activeTab={activeTab}
          file={file}
          linkIndex={linkIndex}
          onBack={() => onBack(leaf.id)}
          onForward={() => onForward(leaf.id)}
          onToggleMode={() => onToggleMode(leaf.id, activeTab.id)}
          onSplit={(direction) => onSplit(leaf.id, direction)}
          onClosePane={() => onClosePane(leaf.id)}
          canClosePane={canClosePane}
          isBookmarked={file ? bookmarks.has(file.id) : false}
          onToggleBookmark={() => file && onToggleBookmark(file.id)}
          onToggleDock={onToggleDock}
        />
      )}
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
        />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Inline popover for an ambiguous [[link]] — shown when a bare name matches
// more than one file, so the reader can pick which one was actually meant.
// ---------------------------------------------------------------------------
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
              {c.relativePath}
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
        <IconImageMissing size={13} /> {name}
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
// ---------------------------------------------------------------------------
// Command palette / quick switcher — one shared modal component. In
// 'switcher' mode it fuzzy-matches file names (⌘O); in 'commands' mode it
// fuzzy-matches a fixed command list (⌘K / ⌘P).
// ---------------------------------------------------------------------------
function PaletteModal({ mode, files, commands, onClose, onPickFile, onRunCommand }) {
  const [query, setQuery] = useState('');
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const results = useMemo(() => {
    if (mode === 'switcher') {
      return files
        .map((f) => ({ f, score: fuzzyScore(query, f.name.replace(/\.md$/i, '')) }))
        .filter((s) => s.score !== null)
        .sort((a, b) => a.score - b.score)
        .slice(0, 50)
        .map((s) => s.f);
    }
    return commands
      .map((c) => ({ c, score: fuzzyScore(query, c.label) }))
      .filter((s) => s.score !== null)
      .sort((a, b) => a.score - b.score)
      .map((s) => s.c);
  }, [mode, query, files, commands]);

  useEffect(() => setActiveIndex(0), [query, mode]);

  const runActive = (opts) => {
    const item = results[activeIndex];
    if (!item) return;
    if (mode === 'switcher') onPickFile(item, opts);
    else onRunCommand(item);
  };

  return (
    <div className="modal-overlay palette-overlay" onClick={onClose}>
      <div className="palette-modal" onClick={(e) => e.stopPropagation()}>
        <div className="palette-input-row">
          {mode === 'switcher' ? <IconSearch size={16} /> : <IconCommand size={16} />}
          <input
            ref={inputRef}
            className="palette-input"
            placeholder={mode === 'switcher' ? 'Jump to note…' : 'Type a command…'}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown') {
                e.preventDefault();
                setActiveIndex((i) => Math.min(i + 1, results.length - 1));
              } else if (e.key === 'ArrowUp') {
                e.preventDefault();
                setActiveIndex((i) => Math.max(i - 1, 0));
              } else if (e.key === 'Enter') {
                e.preventDefault();
                runActive({ newTab: e.metaKey || e.ctrlKey });
              } else if (e.key === 'Escape') {
                onClose();
              }
            }}
          />
        </div>
        <div className="palette-results">
          {results.length === 0 && <p className="muted small empty-hint">No matches.</p>}
          {mode === 'switcher'
            ? results.map((f, i) => (
                <button
                  key={f.id}
                  className={`palette-result ${i === activeIndex ? 'active' : ''}`}
                  onMouseEnter={() => setActiveIndex(i)}
                  onClick={(e) => onPickFile(f, { newTab: e.metaKey || e.ctrlKey })}
                >
                  <span className="palette-result-name">{f.name.replace(/\.md$/i, '')}</span>
                </button>
              ))
            : results.map((c, i) => (
                <button
                  key={c.id}
                  className={`palette-result ${i === activeIndex ? 'active' : ''}`}
                  onMouseEnter={() => setActiveIndex(i)}
                  onClick={() => onRunCommand(c)}
                >
                  {c.icon}
                  <span className="palette-result-name">{c.label}</span>
                  {c.hint && <span className="palette-result-hint">{c.hint}</span>}
                </button>
              ))}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// App — top-level composition and view-transition wiring
// ---------------------------------------------------------------------------
export default function App() {
  const { token: googleToken, gisReady, signIn, signOut: signOutGoogle } = useGoogleAuth();
  const { proxyToken, signInProxy, signOutProxy } = useProxyAuth();
  const token = googleToken || proxyToken;
  const signOut = useCallback(() => {
    signOutGoogle();
    signOutProxy();
  }, [signOutGoogle, signOutProxy]);

  const [showProxyFolderPicker, setShowProxyFolderPicker] = useState(false);
  const [folder, setFolder] = useState(null);
  const [folderRestoring, setFolderRestoring] = useState(true);
  const sync = useVaultSync(token, folder);
  const vaultIndex = useVaultIndex(token, sync.filesMeta);

  // buffers: fileId -> { content, dirty, saving, loading, loadError }
  const [buffers, setBuffers] = useState({});
  const loadingFileIds = useRef(new Set());
  const saveTimers = useRef({});

  const [paneTree, setPaneTree] = useState(() => makeLeaf(null));
  const [activePaneId, setActivePaneId] = useState(() => paneTree.id);

  const [activeSideView, setActiveSideView] = useState('explorer'); // explorer | search | tags | bookmarks
  const [mobileDockOpen, setMobileDockOpen] = useState(false);
  const [sideDockWidth, setSideDockWidth] = useState(280);
  const [searchQuery, setSearchQuery] = useState('');
  const [bookmarks, setBookmarks] = useState(new Set());
  const [paletteMode, setPaletteMode] = useState(null); // null | 'commands' | 'switcher'
  // When the switcher is opened via the tab bar's "+" button, the next pick
  // should always open in a new tab — unlike ⌘O, which navigates the current
  // tab unless the user holds Cmd/Ctrl. Tracked as a ref (not state) since it
  // only needs to be read once, synchronously, when a pick is made.
  const paletteForceNewTabRef = useRef(false);

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

  // Load this vault's bookmark list (just fileIds — metadata, not content).
  useEffect(() => {
    if (!folder?.id) {
      setBookmarks(new Set());
      return;
    }
    idbGet(STORE_META, `bookmarks:${folder.id}`).then((rec) => setBookmarks(new Set(rec?.value || [])));
  }, [folder?.id]);

  const toggleBookmark = useCallback(
    (fileId) => {
      setBookmarks((prev) => {
        const next = new Set(prev);
        next.has(fileId) ? next.delete(fileId) : next.add(fileId);
        if (folder?.id) idbPut(STORE_META, { key: `bookmarks:${folder.id}`, value: Array.from(next) });
        return next;
      });
    },
    [folder?.id]
  );

  // Used both for the first-time folder prompt and for switching vaults
  // later from the ribbon. Resets editor + sync state so nothing from the
  // previous vault lingers on screen.
  const applyPickedFolder = useCallback(
    (picked) => {
      sync.resetVault();
      releaseImageUrlCache();
      setFolder(picked);
      idbPut(STORE_META, { key: 'vaultFolder', value: picked });
      setBuffers({});
      saveTimers.current = {};
      setPaneTree(makeLeaf(null));
      setActivePaneId((prev) => prev);
      setSearchQuery('');
      setMobileDockOpen(false);
      setActiveSideView('explorer');
    },
    [sync]
  );

  const handlePickFolder = useCallback(async () => {
    if (!token) return;
    if (isProxy(token)) {
      setShowProxyFolderPicker(true);
      return;
    }
    const picked = await openFolderPicker(token);
    if (picked) applyPickedFolder(picked);
  }, [token, applyPickedFolder]);

  const handleProxyFolderPicked = useCallback(
    (picked) => {
      setShowProxyFolderPicker(false);
      applyPickedFolder(picked);
    },
    [applyPickedFolder]
  );

  // Keep activePaneId valid whenever the pane tree changes shape (closing
  // the active pane, vault switch, etc.).
  useEffect(() => {
    if (!findLeaf(paneTree, activePaneId)) {
      const first = getFirstLeaf(paneTree);
      if (first) setActivePaneId(first.id);
    }
  }, [paneTree, activePaneId]);

  const filesById = useMemo(() => new Map(sync.filesMeta.map((f) => [f.id, f])), [sync.filesMeta]);

  // Wikilink targets that don't resolve to any real file yet ("phantom"
  // notes, in Obsidian's terminology) — collected from every link in the
  // vault so they still show up in [[ autocomplete even though nothing has
  // been created for them. Picking one from the list just inserts the link;
  // the note itself is created the normal way, on first click-through.
  const phantomRecords = useMemo(() => {
    const seen = new Set();
    const out = [];
    for (const links of sync.linksByFileId.values()) {
      for (const link of links) {
        const res = resolveLinkTarget(link.target, sync.linkIndex);
        if (res.status !== 'missing') continue;
        const raw = String(link.target || '').trim();
        if (!raw) continue;
        const isImage = res.isImage;
        const cleaned = isImage ? raw : raw.replace(/\.md$/i, '');
        const key = `${isImage ? 'img' : 'note'}:${cleaned.toLowerCase()}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const slash = cleaned.lastIndexOf('/');
        const baseName = slash === -1 ? cleaned : cleaned.slice(slash + 1);
        out.push({
          id: `phantom:${key}`,
          name: isImage ? baseName : `${baseName}.md`,
          baseName,
          relativePath: cleaned,
          dir: slash === -1 ? '' : cleaned.slice(0, slash),
          isImage,
          isPhantom: true
        });
      }
    }
    return out;
  }, [sync.linksByFileId, sync.linkIndex]);
  const tree = useMemo(() => buildVaultTree(folder?.id, sync.foldersMeta, sync.filesMeta), [folder?.id, sync.foldersMeta, sync.filesMeta]);
  const tagsByFileId = useMemo(() => {
    const map = new Map();
    sync.filesMeta.forEach((f) => {
      if (f.kind === 'note') map.set(f.id, extractTags(vaultIndex.getBody(f.id)));
    });
    return map;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sync.filesMeta, vaultIndex.getBody, vaultIndex.version]);

  // --- Content loading (per open tab) --------------------------------------
  const ensureFileLoaded = useCallback(
    (fileId) => {
      if (!fileId || !token) return;
      if (buffers[fileId] || loadingFileIds.current.has(fileId)) return;
      const meta = sync.filesMeta.find((f) => f.id === fileId);
      if (!meta || meta.kind === 'image') return;
      loadingFileIds.current.add(fileId);
      setBuffers((prev) => ({ ...prev, [fileId]: { content: '', dirty: false, saving: false, loading: true } }));
      driveGetFileContent(token, fileId)
        .then((text) => {
          vaultIndex.updateBody(fileId, text);
          setBuffers((prev) => ({ ...prev, [fileId]: { content: text, dirty: false, saving: false, loading: false } }));
        })
        .catch((err) => {
          setBuffers((prev) => ({
            ...prev,
            [fileId]: { content: '', dirty: false, saving: false, loading: false, loadError: err.message }
          }));
        })
        .finally(() => loadingFileIds.current.delete(fileId));
    },
    [token, buffers, sync.filesMeta, vaultIndex]
  );

  const saveNow = useCallback(
    async (fileId, value) => {
      if (!token) return;
      setBuffers((prev) => (prev[fileId] ? { ...prev, [fileId]: { ...prev[fileId], saving: true } } : prev));
      try {
        const updated = await driveUpdateFileContent(token, fileId, value);
        sync.applyLocalEdit(fileId, value, updated.modifiedTime || new Date().toISOString());
        vaultIndex.updateBody(fileId, value);
        setBuffers((prev) => (prev[fileId] ? { ...prev, [fileId]: { ...prev[fileId], dirty: false, saving: false } } : prev));
      } catch (err) {
        console.error(err);
        setBuffers((prev) => (prev[fileId] ? { ...prev, [fileId]: { ...prev[fileId], saving: false } } : prev));
      }
    },
    [token, sync, vaultIndex]
  );

  const handleContentChange = useCallback(
    (fileId, value) => {
      setBuffers((prev) => ({ ...prev, [fileId]: { ...prev[fileId], content: value, dirty: true } }));
      if (saveTimers.current[fileId]) clearTimeout(saveTimers.current[fileId]);
      saveTimers.current[fileId] = setTimeout(() => saveNow(fileId, value), 1200);
    },
    [saveNow]
  );

  // Manual save shortcut — saves whichever file the focused pane has open.
  useEffect(() => {
    const handler = (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 's') {
        e.preventDefault();
        const leaf = findLeaf(paneTree, activePaneId);
        const tab = leaf?.tabs.find((t) => t.id === leaf.activeTabId);
        if (tab) {
          if (saveTimers.current[tab.fileId]) clearTimeout(saveTimers.current[tab.fileId]);
          const buf = buffers[tab.fileId];
          if (buf) saveNow(tab.fileId, buf.content);
        }
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [paneTree, activePaneId, buffers, saveNow]);

  // Command palette (⌘K / ⌘P) + quick switcher (⌘O).
  useEffect(() => {
    const handler = (e) => {
      const mod = e.metaKey || e.ctrlKey;
      if (mod && (e.key === 'k' || e.key === 'p')) {
        e.preventDefault();
        setPaletteMode('commands');
      } else if (mod && e.key === 'o') {
        e.preventDefault();
        paletteForceNewTabRef.current = false;
        setPaletteMode('switcher');
      } else if (e.key === 'Escape') {
        setPaletteMode(null);
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []);

  // --- Pane-tree actions -----------------------------------------------------
  const openFileInPane = useCallback(
    (paneId, fileId, { newTab = false } = {}) => {
      if (!paneId || !fileId) return;
      ensureFileLoaded(fileId);
      const next = updateLeaf(paneTree, paneId, (leaf) => {
        const existingTab = leaf.tabs.find((t) => t.fileId === fileId);
        if (existingTab && !newTab) {
          return { ...leaf, activeTabId: existingTab.id };
        }
        if (!newTab && leaf.activeTabId) {
          const tabs = leaf.tabs.map((t) => {
            if (t.id !== leaf.activeTabId) return t;
            const history = t.history.slice(0, t.historyIndex + 1);
            history.push(fileId);
            return { ...t, fileId, history, historyIndex: history.length - 1 };
          });
          return { ...leaf, tabs };
        }
        const tab = makeTab(fileId, 'edit');
        return { ...leaf, tabs: [...leaf.tabs, tab], activeTabId: tab.id };
      });
      setPaneTree(next);
      setActivePaneId(paneId);
      setMobileDockOpen(false);
    },
    [paneTree, ensureFileLoaded]
  );

  const selectTab = useCallback(
    (paneId, tabId) => {
      setPaneTree(updateLeaf(paneTree, paneId, (leaf) => ({ ...leaf, activeTabId: tabId })));
      setActivePaneId(paneId);
    },
    [paneTree]
  );

  const closeTab = useCallback(
    (paneId, tabId) => {
      let next = updateLeaf(paneTree, paneId, (leaf) => {
        const idx = leaf.tabs.findIndex((t) => t.id === tabId);
        const tabs = leaf.tabs.filter((t) => t.id !== tabId);
        let activeTabId = leaf.activeTabId;
        if (activeTabId === tabId) {
          const fallback = tabs[idx] || tabs[idx - 1] || tabs[tabs.length - 1] || null;
          activeTabId = fallback ? fallback.id : null;
        }
        return { ...leaf, tabs, activeTabId };
      });
      const leaf = findLeaf(next, paneId);
      if (leaf && leaf.tabs.length === 0 && collectLeaves(next).length > 1) {
        next = removeLeafFromTree(next, paneId);
      }
      setPaneTree(next || makeLeaf(null));
    },
    [paneTree]
  );

  const closeOthers = useCallback(
    (paneId, tabId) => {
      setPaneTree(updateLeaf(paneTree, paneId, (leaf) => ({ ...leaf, tabs: leaf.tabs.filter((t) => t.id === tabId), activeTabId: tabId })));
    },
    [paneTree]
  );

  const closeAllTabs = useCallback(
    (paneId) => {
      let next = updateLeaf(paneTree, paneId, (leaf) => ({ ...leaf, tabs: [], activeTabId: null }));
      if (collectLeaves(next).length > 1) next = removeLeafFromTree(next, paneId);
      setPaneTree(next || makeLeaf(null));
    },
    [paneTree]
  );

  const closePane = useCallback(
    (paneId) => {
      const next = removeLeafFromTree(paneTree, paneId);
      setPaneTree(next || makeLeaf(null));
    },
    [paneTree]
  );

  const splitPane = useCallback(
    (paneId, direction) => {
      const leaf = findLeaf(paneTree, paneId);
      const activeTab = leaf?.tabs.find((t) => t.id === leaf.activeTabId);
      const newLeaf = makeLeaf(activeTab?.fileId || null, activeTab?.mode || 'edit');
      setPaneTree(splitLeafInTree(paneTree, paneId, direction, newLeaf));
      setActivePaneId(newLeaf.id);
      if (activeTab?.fileId) ensureFileLoaded(activeTab.fileId);
    },
    [paneTree, ensureFileLoaded]
  );

  const splitTabDirect = useCallback(
    (paneId, tabId, direction) => {
      const leaf = findLeaf(paneTree, paneId);
      const tab = leaf?.tabs.find((t) => t.id === tabId);
      const newLeaf = makeLeaf(tab?.fileId || null, tab?.mode || 'edit');
      setPaneTree(splitLeafInTree(paneTree, paneId, direction, newLeaf));
      setActivePaneId(newLeaf.id);
    },
    [paneTree]
  );

  const toggleTabMode = useCallback(
    (paneId, tabId) => {
      setPaneTree(
        updateLeaf(paneTree, paneId, (leaf) => ({
          ...leaf,
          tabs: leaf.tabs.map((t) => (t.id === tabId ? { ...t, mode: t.mode === 'edit' ? 'preview' : 'edit' } : t))
        }))
      );
    },
    [paneTree]
  );

  const navigateHistory = useCallback(
    (paneId, delta) => {
      const leaf = findLeaf(paneTree, paneId);
      const tab = leaf?.tabs.find((t) => t.id === leaf.activeTabId);
      if (!tab) return;
      const idx = tab.historyIndex + delta;
      if (idx < 0 || idx >= tab.history.length) return;
      const fileId = tab.history[idx];
      ensureFileLoaded(fileId);
      setPaneTree(
        updateLeaf(paneTree, paneId, (l) => ({
          ...l,
          tabs: l.tabs.map((t) => (t.id === tab.id ? { ...t, fileId, historyIndex: idx } : t))
        }))
      );
    },
    [paneTree, ensureFileLoaded]
  );

  const resizeSplit = useCallback(
    (splitId, index, deltaPx, containerRef) => {
      const el = containerRef?.current;
      if (!el) return;
      const node = findSplitNode(paneTree, splitId);
      if (!node) return;
      const rect = el.getBoundingClientRect();
      const totalPx = node.direction === 'row' ? rect.width : rect.height;
      if (!totalPx) return;
      const deltaPct = (deltaPx / totalPx) * 100;
      const sizes = node.sizes.slice();
      const a = index;
      const b = index + 1;
      const minPct = 12;
      let newA = sizes[a] + deltaPct;
      let newB = sizes[b] - deltaPct;
      if (newA < minPct) {
        newB -= minPct - newA;
        newA = minPct;
      }
      if (newB < minPct) {
        newA -= minPct - newB;
        newB = minPct;
      }
      sizes[a] = newA;
      sizes[b] = newB;
      setPaneTree(updateSplitSizes(paneTree, splitId, sizes));
    },
    [paneTree]
  );

  const purgeFileEverywhere = useCallback((fileId) => {
    setPaneTree((prev) => collapseEmptyLeaves(purgeFileFromTree(prev, fileId)) || makeLeaf(null));
    setBuffers((prev) => {
      if (!prev[fileId]) return prev;
      const next = { ...prev };
      delete next[fileId];
      return next;
    });
    if (saveTimers.current[fileId]) {
      clearTimeout(saveTimers.current[fileId]);
      delete saveTimers.current[fileId];
    }
  }, []);

  // --- Create / open-by-name / rename / delete / move / upload -------------
  const openNoteByName = useCallback(
    async (name) => {
      const resolution = resolveLinkTarget(name, sync.linkIndex);
      if (resolution.status === 'resolved' && !resolution.file.isImage) {
        openFileInPane(activePaneId, resolution.file.id);
        return;
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
      setBuffers((prev) => ({ ...prev, [created.id]: { content: skeleton, dirty: false, saving: false, loading: false } }));
      vaultIndex.updateBody(created.id, skeleton);
      openFileInPane(activePaneId, created.id);
    },
    [sync, folder, token, activePaneId, openFileInPane, vaultIndex]
  );

  const handleCreateNoteIn = useCallback(
    (parentId) => {
      const name = window.prompt('New note name:');
      if (!name || !name.trim()) return;
      (async () => {
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
          setBuffers((prev) => ({ ...prev, [created.id]: { content: skeleton, dirty: false, saving: false, loading: false } }));
          vaultIndex.updateBody(created.id, skeleton);
          openFileInPane(activePaneId, created.id);
        } catch (err) {
          window.alert(`Couldn't create note: ${err.message}`);
        }
      })();
    },
    [token, sync, activePaneId, openFileInPane, vaultIndex]
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

  const handleUploadFiles = useCallback(
    async (parentId, files) => {
      if (!token) return;
      const results = await mapWithConcurrency(files, 4, (file) => driveUploadBinary(token, parentId, file));
      const failed = [];
      results.forEach((r, i) => {
        if (r.ok) {
          const created = r.value;
          const kind = isImageName(created.name) || IMAGE_MIME_TYPES.includes(created.mimeType) ? 'image' : 'note';
          sync.registerNewFile({
            id: created.id,
            name: created.name,
            modifiedTime: created.modifiedTime || new Date().toISOString(),
            parents: [parentId],
            kind
          });
        } else {
          failed.push(files[i].name);
        }
      });
      if (failed.length) window.alert(`Some files couldn't be uploaded: ${failed.join(', ')}`);
    },
    [token, sync]
  );

  // Shared rename primitive: renames on Drive, then updates local sync state.
  // `kind` is only meaningful for files ('image' vs a note); ignored for folders.
  const performRename = useCallback(
    async (id, type, kind, newName) => {
      try {
        await driveRenameItem(token, id, newName);
        if (type === 'file') {
          sync.renameFile(id, newName);
        } else {
          sync.renameFolder(id, newName);
        }
        return true;
      } catch (err) {
        window.alert(`Couldn't rename: ${err.message}`);
        return false;
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
        const typed = input.trim();
        newName = fileExtension(typed) ? typed : `${typed}.${fileExtension(node.name) || 'png'}`;
      } else {
        newName = input.trim().toLowerCase().endsWith('.md') ? input.trim() : `${input.trim()}.md`;
      }

      performRename(node.id, node.type, node.kind, newName);
    },
    [performRename]
  );

  // Rename driven by the inline title field above the note content (edit or
  // reading view) rather than the tree's context menu. `newDisplayTitle` has
  // no extension — this adds one back based on the file's current kind.
  const handleInlineRenameFile = useCallback(
    (fileId, newDisplayTitle) => {
      const file = filesById.get(fileId);
      if (!file) return;
      const trimmed = (newDisplayTitle || '').trim();
      if (!trimmed) return;
      const isImage = file.kind === 'image';
      const currentDisplayName = isImage ? file.name : file.name.replace(/\.md$/i, '');
      if (trimmed === currentDisplayName) return;
      const newName = isImage
        ? fileExtension(trimmed)
          ? trimmed
          : `${trimmed}.${fileExtension(file.name) || 'png'}`
        : trimmed.toLowerCase().endsWith('.md')
          ? trimmed
          : `${trimmed}.md`;
      performRename(fileId, 'file', file.kind, newName);
    },
    [filesById, performRename]
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
          purgeFileEverywhere(node.id);
          if (bookmarks.has(node.id)) toggleBookmark(node.id);
        } else {
          const removedFileIds = sync.removeFolder(node.id);
          removedFileIds.forEach(purgeFileEverywhere);
          removedFileIds.forEach((id) => {
            if (bookmarks.has(id)) toggleBookmark(id);
          });
        }
      } catch (err) {
        window.alert(`Couldn't delete: ${err.message}`);
      }
    },
    [token, sync, purgeFileEverywhere, bookmarks, toggleBookmark]
  );

  const handleMoveNode = useCallback(
    async (id, type, targetFolderId) => {
      if (id === targetFolderId) return;
      const record = type === 'folder' ? sync.foldersMeta.find((f) => f.id === id) : sync.filesMeta.find((f) => f.id === id);
      if (!record) return;
      const oldParentId = (record.parents && record.parents[0]) || folder.id;
      if (oldParentId === targetFolderId) return;
      if (type === 'folder') {
        const isDescendant = (candidateId) => {
          let cur = sync.foldersMeta.find((f) => f.id === candidateId);
          while (cur) {
            const parentId = (cur.parents && cur.parents[0]) || folder.id;
            if (parentId === id) return true;
            if (parentId === folder.id) return false;
            cur = sync.foldersMeta.find((f) => f.id === parentId);
          }
          return false;
        };
        if (targetFolderId === id || isDescendant(targetFolderId)) return;
      }
      try {
        await driveMoveItem(token, id, targetFolderId, oldParentId);
        if (type === 'folder') sync.moveFolder(id, targetFolderId);
        else sync.moveFile(id, targetFolderId);
      } catch (err) {
        window.alert(err.code === 'proxy-unsupported' ? err.message : `Couldn't move: ${err.message}`);
      }
    },
    [token, sync, folder]
  );

  const handlers = useMemo(
    () => ({
      token,
      onOpenById: (id) => openFileInPane(activePaneId, id),
      onCreateOrOpenByName: (name) => openNoteByName(name),
      onOpenImage: (file) => openImageInNewTab(token, file),
      onRenameFile: (fileId, newDisplayName) => handleInlineRenameFile(fileId, newDisplayName),
      onOpenTag: (tag) => {
        setActiveSideView('search');
        setSearchQuery(`tag:${tag}`);
        setMobileDockOpen(true);
      }
    }),
    [token, openFileInPane, activePaneId, openNoteByName, handleInlineRenameFile]
  );

  const handlePaletteFilePick = useCallback(
    (file, opts) => {
      setPaletteMode(null);
      if (file.kind === 'image') {
        openImageInNewTab(token, file);
        return;
      }
      openFileInPane(activePaneId, file.id, { ...opts, newTab: opts?.newTab || paletteForceNewTabRef.current });
      paletteForceNewTabRef.current = false;
    },
    [activePaneId, openFileInPane, token]
  );

  const commands = useMemo(() => {
    if (!folder) return [];
    return [
      { id: 'new-note', label: 'Create new note', icon: <IconFilePlus size={15} />, run: () => handleCreateNoteIn(folder.id) },
      { id: 'new-folder', label: 'Create new folder', icon: <IconFolderPlus size={15} />, run: () => handleCreateFolderIn(folder.id) },
      { id: 'toggle-sidebar', label: 'Toggle left sidebar', icon: <IconPanelLeft size={15} />, run: () => setMobileDockOpen((v) => !v) },
      { id: 'split-right', label: 'Split pane right', icon: <IconSplitVertical size={15} />, run: () => splitPane(activePaneId, 'row') },
      { id: 'split-down', label: 'Split pane down', icon: <IconSplitHorizontal size={15} />, run: () => splitPane(activePaneId, 'column') },
      {
        id: 'toggle-mode',
        label: 'Toggle edit / reading view',
        icon: <IconEye size={15} />,
        run: () => {
          const leaf = findLeaf(paneTree, activePaneId);
          const tab = leaf?.tabs.find((t) => t.id === leaf.activeTabId);
          if (tab) toggleTabMode(activePaneId, tab.id);
        }
      },
      { id: 'sync', label: 'Sync vault now', icon: <IconRefresh size={15} />, run: () => sync.syncNow() },
      {
        id: 'open-search',
        label: 'Open search',
        icon: <IconSearch size={15} />,
        run: () => {
          setActiveSideView('search');
          setMobileDockOpen(true);
        }
      },
      {
        id: 'open-tags',
        label: 'Open tag pane',
        icon: <IconTag size={15} />,
        run: () => {
          setActiveSideView('tags');
          setMobileDockOpen(true);
        }
      },
      {
        id: 'open-bookmarks',
        label: 'Open bookmarks',
        icon: <IconStar size={15} />,
        run: () => {
          setActiveSideView('bookmarks');
          setMobileDockOpen(true);
        }
      },
      {
        id: 'quick-switcher',
        label: 'Quick switcher: jump to note',
        icon: <IconSearch size={15} />,
        hint: '⌘O',
        run: () => {
          paletteForceNewTabRef.current = false;
          setPaletteMode('switcher');
        }
      },
      { id: 'change-folder', label: 'Change vault folder', icon: <IconFolder size={15} />, run: handlePickFolder },
      { id: 'sign-out', label: 'Sign out', icon: <IconLogOut size={15} />, run: signOut }
    ];
  }, [folder, handleCreateNoteIn, handleCreateFolderIn, activePaneId, splitPane, paneTree, toggleTabMode, sync, handlePickFolder, signOut]);

  const handlePaletteCommand = useCallback((cmd) => {
    setPaletteMode(null);
    cmd.run();
  }, []);

  const showShortcutsHelp = useCallback(() => {
    window.alert(
      [
        'Keyboard shortcuts',
        '',
        '⌘/Ctrl K or P — Command palette',
        '⌘/Ctrl O — Quick switcher (jump to note)',
        '⌘/Ctrl S — Save current note',
        '[[ — Link autocomplete while typing',
        'Middle-click a tab — Close it',
        'Drag a file/folder in the sidebar — Move it'
      ].join('\n')
    );
  }, []);

  if (!token) {
    return <LoginScreen onSignIn={signIn} ready={gisReady} onSignInProxy={signInProxy} />;
  }
  if (folderRestoring) {
    return <VaultLoadingScreen progress={{ phase: 'opening', loaded: 0, total: 0 }} />;
  }
  if (!folder) {
    return (
      <>
        <FolderPrompt onPick={handlePickFolder} />
        {showProxyFolderPicker && (
          <ProxyFolderPicker token={token} onPick={handleProxyFolderPicked} onCancel={() => setShowProxyFolderPicker(false)} />
        )}
      </>
    );
  }
  if (!sync.cacheLoaded) {
    return <VaultLoadingScreen progress={{ phase: 'opening', loaded: 0, total: 0 }} />;
  }
  if (sync.filesMeta.length === 0 && sync.syncing) {
    return <VaultLoadingScreen progress={sync.syncProgress} />;
  }

  const syncPct = sync.syncProgress.total > 0 ? Math.round((sync.syncProgress.loaded / sync.syncProgress.total) * 100) : null;

  const activeLeafForStatus = findLeaf(paneTree, activePaneId);
  const activeTabForStatus = activeLeafForStatus?.tabs.find((t) => t.id === activeLeafForStatus.activeTabId);
  const activeFileForStatus = activeTabForStatus ? filesById.get(activeTabForStatus.fileId) : null;
  const activeContentForStatus = activeTabForStatus ? buffers[activeTabForStatus.fileId]?.content || '' : '';
  const activeBacklinkCount = activeFileForStatus ? (sync.backlinkIndex.get(activeFileForStatus.id) || new Set()).size : 0;
  const currentOpenIds = new Set(collectLeaves(paneTree).flatMap((l) => l.tabs.map((t) => t.fileId)));

  return (
    <div className="app-shell">
      {sync.syncing && syncPct !== null && (
        <div className="topbar-progress">
          <div className="topbar-progress-fill" style={{ width: `${syncPct}%` }} />
        </div>
      )}
      <div className={`workspace ${mobileDockOpen ? 'dock-open' : ''}`}>
        <ActivityBar
          activeView={activeSideView}
          onSetView={(v) => {
            setActiveSideView(v);
            setMobileDockOpen(true);
          }}
          onOpenCommandPalette={() => setPaletteMode('commands')}
          onSync={() => sync.syncNow()}
          syncing={sync.syncing}
          onChangeFolder={handlePickFolder}
          onSignOut={signOut}
          folderName={folder.name}
        />
        <div className="side-dock" style={{ width: sideDockWidth }}>
          <div className="side-dock-panels">
            {activeSideView === 'explorer' && (
              <ExplorerPanel
                tree={tree}
                vaultRootId={folder.id}
                currentIds={currentOpenIds}
                onOpenFile={(id, e) => openFileInPane(activePaneId, id, { newTab: !!(e && (e.metaKey || e.ctrlKey)) })}
                onOpenImage={(file) => openImageInNewTab(token, file)}
                onCreateNote={handleCreateNoteIn}
                onCreateFolder={handleCreateFolderIn}
                onUploadFiles={handleUploadFiles}
                onRename={handleRenameNode}
                onDelete={handleDeleteNode}
                onMoveNode={handleMoveNode}
                canUpload={!isProxy(token)}
                bookmarks={bookmarks}
                onToggleBookmark={toggleBookmark}
              />
            )}
            {activeSideView === 'search' && (
              <SearchPanel
                query={searchQuery}
                setQuery={setSearchQuery}
                filesMeta={sync.filesMeta}
                linkIndex={sync.linkIndex}
                getBody={vaultIndex.getBody}
                tagsByFileId={tagsByFileId}
                onOpenNote={(id) => openFileInPane(activePaneId, id)}
                indexing={vaultIndex}
                ensureIndexed={vaultIndex.ensureIndexed}
                indexVersion={vaultIndex.version}
              />
            )}
            {activeSideView === 'tags' && (
              <TagsPanel
                filesMeta={sync.filesMeta}
                getBody={vaultIndex.getBody}
                onOpenTag={(tag) => {
                  setActiveSideView('search');
                  setSearchQuery(`tag:${tag}`);
                }}
                indexing={vaultIndex}
                ensureIndexed={vaultIndex.ensureIndexed}
                indexVersion={vaultIndex.version}
              />
            )}
            {activeSideView === 'bookmarks' && (
              <BookmarksPanel
                bookmarks={bookmarks}
                filesMeta={sync.filesMeta}
                onOpenFile={(id) => openFileInPane(activePaneId, id)}
                onOpenImage={(file) => openImageInNewTab(token, file)}
                onToggleBookmark={toggleBookmark}
              />
            )}
          </div>
          <div className="vault-footer">
            <span className="vault-footer-name">
              <IconFolder size={13} />
              {folder.name}
            </span>
            <div className="vault-footer-actions">
              <button className="icon-btn" title="Keyboard shortcuts" onClick={showShortcutsHelp}>
                <IconHelp size={15} />
              </button>
              <button className="icon-btn" title="Change vault folder" onClick={handlePickFolder}>
                <IconSettings size={15} />
              </button>
            </div>
          </div>
        </div>
        <ResizeHandle direction="row" onResize={(dx) => setSideDockWidth((w) => Math.min(480, Math.max(200, w + dx)))} />
        <div className="dock-scrim" onClick={() => setMobileDockOpen(false)} />
        <div className="pane-area">
          <PaneNode
            node={paneTree}
            filesById={filesById}
            linkIndex={sync.linkIndex}
            phantomRecords={phantomRecords}
            buffers={buffers}
            activePaneId={activePaneId}
            onFocusPane={setActivePaneId}
            onSelectTab={selectTab}
            onCloseTab={closeTab}
            onNewTab={(paneId) => {
              setActivePaneId(paneId);
              paletteForceNewTabRef.current = true;
              setPaletteMode('switcher');
            }}
            onSplitTab={splitTabDirect}
            onCloseOthers={closeOthers}
            onCloseAll={closeAllTabs}
            onSplit={splitPane}
            onClosePane={closePane}
            canClosePane={collectLeaves(paneTree).length > 1}
            onBack={(paneId) => navigateHistory(paneId, -1)}
            onForward={(paneId) => navigateHistory(paneId, 1)}
            onToggleMode={toggleTabMode}
            onChange={handleContentChange}
            handlers={handlers}
            backlinkIndex={sync.backlinkIndex}
            allFiles={sync.filesMeta}
            getBody={vaultIndex.getBody}
            bookmarks={bookmarks}
            onToggleBookmark={toggleBookmark}
            onResizeSplit={resizeSplit}
            onToggleDock={() => setMobileDockOpen((v) => !v)}
          />
        </div>
      </div>
      <StatusBar
        file={activeFileForStatus}
        content={activeContentForStatus}
        backlinkCount={activeBacklinkCount}
        syncing={sync.syncing}
        syncError={sync.syncError}
        dirty={activeTabForStatus ? !!buffers[activeTabForStatus.fileId]?.dirty : false}
        saving={activeTabForStatus ? !!buffers[activeTabForStatus.fileId]?.saving : false}
      />
      {paletteMode && (
        <PaletteModal
          mode={paletteMode}
          files={sync.filesMeta}
          commands={commands}
          onClose={() => setPaletteMode(null)}
          onPickFile={handlePaletteFilePick}
          onRunCommand={handlePaletteCommand}
        />
      )}
      {showProxyFolderPicker && (
        <ProxyFolderPicker token={token} onPick={handleProxyFolderPicked} onCancel={() => setShowProxyFolderPicker(false)} />
      )}
    </div>
  );
}
