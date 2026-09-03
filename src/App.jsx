import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { createRoot } from 'react-dom/client';
import { EditorState, RangeSetBuilder } from '@codemirror/state';
import { EditorView, Decoration, WidgetType, keymap, drawSelection, ViewPlugin, placeholder as cmPlaceholder } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap, undo as cmUndo, redo as cmRedo } from '@codemirror/commands';
import { autocompletion, completionKeymap } from '@codemirror/autocomplete';

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

// Video/audio get their own kinds (dedicated <video>/<audio> embeds), and
// everything else with a real extension falls back to a generic 'file' kind
// (download/open chip). Anything left over — no extension, or a known text
// extension — is treated as a note, same as before this was generalized.
const VIDEO_EXTENSIONS = new Set(['mp4', 'webm', 'ogv', 'mov', 'm4v']);
const VIDEO_MIME_TYPES = ['video/mp4', 'video/webm', 'video/ogg', 'video/quicktime'];
const AUDIO_EXTENSIONS = new Set(['mp3', 'wav', 'ogg', 'oga', 'm4a', 'flac', 'aac']);
const AUDIO_MIME_TYPES = ['audio/mpeg', 'audio/wav', 'audio/ogg', 'audio/mp4', 'audio/flac', 'audio/aac', 'audio/x-m4a'];
const NOTE_EXTENSIONS = new Set(['md', 'markdown', 'txt', '']);
// Databases (Notion-style tables) are stored as JSON, one object per file,
// under their own extension so classifyKind can tell them apart from a
// plain note at a glance. Content still round-trips through the exact same
// "text file on Drive, debounced-save" pipeline notes use — only the shape
// of the JSON and the pane that renders it differ.
const DATABASE_EXTENSIONS = new Set(['base']);
// Canvas boards (Obsidian-style infinite canvas) are stored the same way
// databases are — JSON, one object per file — under their own extension so
// classifyKind can tell them apart. See the Canvas section below (search
// "CANVAS BOARD") for the node/edge schema and the CanvasView renderer.
const CANVAS_EXTENSIONS = new Set(['canvas']);

function fileExtension(name) {
  const m = /\.([a-z0-9]+)$/i.exec(name || '');
  return m ? m[1].toLowerCase() : '';
}

function isImageName(name) {
  return IMAGE_EXTENSIONS.has(fileExtension(name));
}

function isVideoName(name) {
  return VIDEO_EXTENSIONS.has(fileExtension(name));
}

function isAudioName(name) {
  return AUDIO_EXTENSIONS.has(fileExtension(name));
}

// True for any filename whose extension marks it as a non-note asset (i.e.
// it should keep its extension for [[link]] matching/display, the way image
// links always have). Notes (.md/.markdown/.txt/no extension) are the only
// names this returns false for.
function isAssetName(name) {
  return !NOTE_EXTENSIONS.has(fileExtension(name));
}

// Single source of truth for what a synced Drive file "is". Order matters:
// image/video/audio are checked first by extension+mimeType, then anything
// with a note-like extension (or no extension) is a note, and everything
// else is a generic file (pdf, zip, docx, whatever the user drops in).
function classifyKind(name, mimeType) {
  if (isImageName(name) || IMAGE_MIME_TYPES.includes(mimeType)) return 'image';
  if (isVideoName(name) || VIDEO_MIME_TYPES.includes(mimeType)) return 'video';
  if (isAudioName(name) || AUDIO_MIME_TYPES.includes(mimeType)) return 'audio';
  if (DATABASE_EXTENSIONS.has(fileExtension(name))) return 'database';
  if (CANVAS_EXTENSIONS.has(fileExtension(name))) return 'canvas';
  if (NOTE_EXTENSIONS.has(fileExtension(name)) || mimeType === 'text/markdown' || mimeType === 'text/plain') return 'note';
  return 'file';
}

// Kinds that open in the normal tabbed editor pane (vs. the standalone
// image/asset viewer). Notes, databases, and canvases are all "pages" —
// they get a tab, a title field, and live in the pane tree like any note.
function opensInEditorPane(kind) {
  return kind === 'note' || kind === 'database' || kind === 'canvas';
}
// File extension to use when a "page" kind is created or renamed without
// one — mirrors how notes always end up ".md".
function extensionForKind(kind) {
  if (kind === 'database') return 'base';
  if (kind === 'canvas') return 'canvas';
  return 'md';
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

// ===========================================================================
// Frontmatter query engine — a small Dataview-style layer over the vault.
//
// Every note becomes a "page" object: its YAML frontmatter properties, plus
// any `key:: value` inline fields found in the body (the other real Dataview
// convention — this is what actually makes frontmatter *queryable* the way
// the person asked for, since most notes put ad hoc facts inline rather
// than in the frontmatter block), plus a reserved `file.*` namespace
// (name/path/folder/link/tags/ctime/mtime). A ```query fenced code block
// (```query or ```dataview, either works) is parsed as a small query
// language — TABLE / LIST / TASK, with FROM / WHERE / SORT / LIMIT — and
// rendered live wherever it appears, in both reading view and the
// CodeMirror live-preview block widgets.
// ===========================================================================

// Dataview's other core convention: a bare `key:: value` line anywhere in
// a note's body (optionally as a list item, `- key:: value`) is a field on
// that page, same as a frontmatter property. Skips fenced code so a code
// sample containing "foo:: bar" doesn't leak into the index.
function extractInlineFields(body) {
  if (!body) return [];
  const withoutFences = body.replace(/```[\s\S]*?```/g, (m) => m.replace(/[^\n]/g, ' '));
  const out = [];
  const re = /^\s*(?:[-*]\s+)?\[?([A-Za-z_][\w \-]*?)\]?::\s*(.+)$/gm;
  let m2;
  while ((m2 = re.exec(withoutFences))) {
    out.push({ key: m2[1].trim(), value: m2[2].trim() });
  }
  return out;
}

// Turns a raw frontmatter/inline-field string into a typed JS value so
// queries can compare numbers as numbers, dates as dates, etc., rather
// than doing string comparison on everything. `[[Link]]` values become a
// small `{ type: 'link', target, display }` record that both the renderer
// and the query comparators know how to unwrap.
function coercePropertyValue(raw) {
  const value = typeof raw === 'string' ? raw.trim() : raw;
  if (value === '' || value == null) return null;
  if (typeof value !== 'string') return value;
  const wikilink = value.match(/^\[\[([^\]|]+)(\|([^\]]+))?\]\]$/);
  if (wikilink) return { type: 'link', target: wikilink[1].trim(), display: (wikilink[3] || wikilink[1]).trim() };
  if (/^\[.*\]$/.test(value)) {
    const items = splitListValue(value);
    if (items.length) return items.map((i) => coercePropertyValue(i));
  }
  if (/^(true|false)$/i.test(value)) return /^true$/i.test(value);
  if (/^-?\d+(\.\d+)?$/.test(value)) return Number(value);
  if (/^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2})?)?$/.test(value)) {
    const d = new Date(value);
    if (!isNaN(d.getTime())) return { type: 'date', value: d, raw: value };
  }
  if (/^["'].*["']$/.test(value)) return value.slice(1, -1);
  return value;
}

// One "page" per note: reserved `file.*` metadata plus every frontmatter
// property and inline field, lowercased for case-insensitive lookup
// (frontmatter wins on a key collision with an inline field — the more
// deliberate, structured source). Rebuilt whenever the vault's indexed
// note bodies change (`getBody`'s backing cache version), same dependency
// pattern the existing tag index already uses.
function buildPagesIndex(filesMeta, linkIndex, getBody) {
  const pages = [];
  const byId = new Map();
  const recordById = new Map(linkIndex.records.map((r) => [r.id, r]));
  for (const f of filesMeta) {
    if (f.kind !== 'note') continue;
    const record = recordById.get(f.id) || f;
    const raw = getBody(f.id) || '';
    const { properties, body } = parseFrontmatter(raw);
    const props = {};
    const setProp = (key, rawVal) => {
      const k = String(key || '').trim().toLowerCase();
      if (!k || k === 'file' || k in props) return;
      if (/^(tags?|aliases?)$/.test(k)) props[k] = splitListValue(rawVal).map((v) => v.replace(/^#/, ''));
      else props[k] = coercePropertyValue(rawVal);
    };
    properties.forEach((p) => setProp(p.key, p.value));
    extractInlineFields(body).forEach((p) => setProp(p.key, p.value));
    const page = {
      ...props,
      file: {
        id: f.id,
        name: record.baseName || f.name,
        path: record.relativePath || f.name,
        folder: record.dir || '',
        link: { type: 'link', target: record.relativePath || record.baseName || f.name, display: record.baseName || f.name },
        tags: extractTags(raw),
        ctime: f.createdTime ? { type: 'date', value: new Date(f.createdTime), raw: f.createdTime } : null,
        mtime: f.modifiedTime ? { type: 'date', value: new Date(f.modifiedTime), raw: f.modifiedTime } : null
      }
    };
    pages.push(page);
    byId.set(f.id, page);
  }
  return { pages, byId };
}

// ---------------------------------------------------------------------------
// Query expression parser — a small recursive-descent boolean expression
// grammar shared by both FROM (source selection: #tags, "folders", AND/OR/-)
// and WHERE (field comparisons: =, !=, <, <=, >, >=, contains(), exists()).
// Same AST either way; FROM and WHERE differ only in how a bare string/
// field atom is *evaluated* (folder-prefix match vs. truthiness) — see
// evalSourceNode vs evalNode below.
// ---------------------------------------------------------------------------
function tokenizeQueryExpr(src) {
  const tokens = [];
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    if (/\s/.test(c)) { i++; continue; }
    if (c === '(' || c === ')' || c === ',') { tokens.push({ type: c }); i++; continue; }
    if (c === '-') { tokens.push({ type: 'NOT' }); i++; continue; }
    if (c === '"' || c === "'") {
      const quote = c;
      let j = i + 1;
      let s = '';
      while (j < n && src[j] !== quote) { s += src[j]; j++; }
      tokens.push({ type: 'string', value: s });
      i = j + 1;
      continue;
    }
    if (c === '#') {
      let j = i + 1;
      while (j < n && /[\w/-]/.test(src[j])) j++;
      tokens.push({ type: 'tag', value: src.slice(i + 1, j) });
      i = j;
      continue;
    }
    if (src.startsWith('[[', i)) {
      let j = src.indexOf(']]', i + 2);
      if (j === -1) j = n;
      tokens.push({ type: 'link', value: src.slice(i + 2, j) });
      i = j + 2;
      continue;
    }
    if (/[<>=!]/.test(c)) {
      let op = c;
      if (src[i + 1] === '=') { op += '='; i += 2; } else { i += 1; }
      tokens.push({ type: 'op', value: op });
      continue;
    }
    if (/[0-9]/.test(c)) {
      let j = i + 1;
      while (j < n && /[0-9.]/.test(src[j])) j++;
      tokens.push({ type: 'number', value: Number(src.slice(i, j)) });
      i = j;
      continue;
    }
    if (/[A-Za-z_]/.test(c)) {
      let j = i + 1;
      while (j < n && /[\w./-]/.test(src[j])) j++;
      const word = src.slice(i, j);
      const upper = word.toUpperCase();
      if (upper === 'AND' || upper === 'OR' || upper === 'NOT') tokens.push({ type: upper });
      else if (upper === 'TRUE') tokens.push({ type: 'bool', value: true });
      else if (upper === 'FALSE') tokens.push({ type: 'bool', value: false });
      else if (['CONTAINS', 'ICONTAINS', 'EXISTS'].includes(upper)) tokens.push({ type: 'func', value: upper.toLowerCase() });
      else tokens.push({ type: 'field', value: word });
      i = j;
      continue;
    }
    i++;
  }
  return tokens;
}

function parseQueryExprTokens(tokens) {
  let pos = 0;
  const peek = () => tokens[pos];
  const next = () => tokens[pos++];
  function parseOr() {
    let left = parseAnd();
    while (peek() && peek().type === 'OR') { next(); left = { type: 'or', left, right: parseAnd() }; }
    return left;
  }
  function parseAnd() {
    let left = parseNot();
    while (peek() && peek().type === 'AND') { next(); left = { type: 'and', left, right: parseNot() }; }
    return left;
  }
  function parseNot() {
    if (peek() && peek().type === 'NOT') { next(); return { type: 'not', expr: parseNot() }; }
    return parseComparison();
  }
  function parseComparison() {
    const left = parseAtomOrCall();
    if (peek() && peek().type === 'op') {
      const op = next().value;
      return { type: 'cmp', op, left, right: parseAtomOrCall() };
    }
    return left;
  }
  function parseAtomOrCall() {
    const t = peek();
    if (!t) return { type: 'lit', value: null };
    if (t.type === '(') {
      next();
      const inner = parseOr();
      if (peek() && peek().type === ')') next();
      return inner;
    }
    if (t.type === 'func') {
      next();
      const args = [];
      if (peek() && peek().type === '(') {
        next();
        while (peek() && peek().type !== ')') {
          args.push(parseAtomOrCall());
          if (peek() && peek().type === ',') next();
        }
        if (peek() && peek().type === ')') next();
      }
      return { type: 'call', fn: t.value, args };
    }
    if (t.type === 'string') { next(); return { type: 'lit', value: t.value }; }
    if (t.type === 'number') { next(); return { type: 'lit', value: t.value }; }
    if (t.type === 'bool') { next(); return { type: 'lit', value: t.value }; }
    if (t.type === 'tag') { next(); return { type: 'tag', value: t.value }; }
    if (t.type === 'link') { next(); return { type: 'link', value: t.value }; }
    if (t.type === 'field') { next(); return { type: 'field', path: t.value }; }
    next();
    return { type: 'lit', value: null };
  }
  return parseOr();
}

function parseQueryExpr(src) {
  if (!src || !src.trim()) return null;
  return parseQueryExprTokens(tokenizeQueryExpr(src));
}

function getFieldValue(page, path) {
  const parts = String(path || '').split('.');
  let cur = page;
  for (const part of parts) {
    if (cur == null) return undefined;
    const key = part.toLowerCase();
    cur = cur[key] !== undefined ? cur[key] : cur[part];
  }
  return cur;
}

function coerceForCompare(v) {
  if (v && typeof v === 'object' && v.type === 'date') return v.value.getTime();
  if (v && typeof v === 'object' && v.type === 'link') return v.display || v.target;
  return v;
}

function valuesEqual(a, b) {
  const ca = coerceForCompare(a);
  const cb = coerceForCompare(b);
  if (typeof ca === 'string' && typeof cb === 'string') return ca.toLowerCase() === cb.toLowerCase();
  return ca === cb;
}

function compareValues(a, b) {
  const ca = coerceForCompare(a);
  const cb = coerceForCompare(b);
  if (ca == null || cb == null) return null;
  if (typeof ca === 'number' && typeof cb === 'number') return ca < cb ? -1 : ca > cb ? 1 : 0;
  const sa = String(ca).toLowerCase();
  const sb = String(cb).toLowerCase();
  return sa < sb ? -1 : sa > sb ? 1 : 0;
}

function resolveOperand(node, page) {
  if (!node) return undefined;
  if (node.type === 'field') return getFieldValue(page, node.path);
  if (node.type === 'lit' || node.type === 'tag' || node.type === 'link') return node.value;
  return evalNode(node, page);
}

// WHERE evaluation: a bare field is truthy-checked, everything else is a
// normal boolean-expression tree.
function evalNode(node, page) {
  if (!node) return true;
  switch (node.type) {
    case 'and': return !!(evalNode(node.left, page) && evalNode(node.right, page));
    case 'or': return !!(evalNode(node.left, page) || evalNode(node.right, page));
    case 'not': return !evalNode(node.expr, page);
    case 'cmp': {
      const left = resolveOperand(node.left, page);
      const right = resolveOperand(node.right, page);
      if (node.op === '=') return valuesEqual(left, right);
      if (node.op === '!=') return !valuesEqual(left, right);
      const c = compareValues(left, right);
      if (c === null) return false;
      if (node.op === '<') return c < 0;
      if (node.op === '<=') return c <= 0;
      if (node.op === '>') return c > 0;
      if (node.op === '>=') return c >= 0;
      return false;
    }
    case 'call': {
      if (node.fn === 'exists') {
        const v = resolveOperand(node.args[0], page);
        return v !== undefined && v !== null && v !== '';
      }
      if (node.fn === 'contains' || node.fn === 'icontains') {
        const hay = resolveOperand(node.args[0], page);
        const needle = resolveOperand(node.args[1], page);
        if (Array.isArray(hay)) return hay.some((h) => valuesEqual(h, needle));
        if (hay == null) return false;
        return String(coerceForCompare(hay)).toLowerCase().includes(String(coerceForCompare(needle)).toLowerCase());
      }
      return false;
    }
    case 'tag': {
      const q = node.value.toLowerCase();
      return (page.file?.tags || []).some((t) => t.toLowerCase() === q || t.toLowerCase().startsWith(`${q}/`));
    }
    case 'link': return (page.file?.path || '').toLowerCase() === node.value.toLowerCase();
    case 'field': {
      const v = getFieldValue(page, node.path);
      return v !== undefined && v !== null && v !== false && v !== '';
    }
    case 'lit': return !!node.value;
    default: return true;
  }
}

// FROM evaluation: a bare string/field atom means "this page's path is
// under this folder" (Dataview's `FROM "Projects"` convention) rather than
// a truthiness check — the one place FROM and WHERE actually diverge.
function evalSourceNode(node, page) {
  if (!node) return true;
  const path = (page.file?.path || '').toLowerCase();
  switch (node.type) {
    case 'and': return evalSourceNode(node.left, page) && evalSourceNode(node.right, page);
    case 'or': return evalSourceNode(node.left, page) || evalSourceNode(node.right, page);
    case 'not': return !evalSourceNode(node.expr, page);
    case 'tag': {
      const q = node.value.toLowerCase();
      return (page.file?.tags || []).some((t) => t.toLowerCase() === q || t.toLowerCase().startsWith(`${q}/`));
    }
    case 'link':
      return path === node.value.toLowerCase() || (page.file?.name || '').toLowerCase() === node.value.toLowerCase();
    case 'lit': {
      const folder = String(node.value || '').replace(/\/$/, '').toLowerCase();
      return path === folder || path.startsWith(`${folder}/`);
    }
    case 'field': {
      const folder = String(node.path || '').replace(/\/$/, '').toLowerCase();
      return path === folder || path.startsWith(`${folder}/`);
    }
    default: return true;
  }
}

// Splits a TABLE column spec ("file.name AS \"Note\", status, due") on
// top-level commas (respecting quotes) and pulls out any "AS <label>".
function parseQueryColumnList(text) {
  const parts = [];
  let cur = '';
  let inQuote = null;
  for (const ch of text) {
    if (inQuote) {
      cur += ch;
      if (ch === inQuote) inQuote = null;
      continue;
    }
    if (ch === '"' || ch === "'") { inQuote = ch; cur += ch; continue; }
    if (ch === ',') { parts.push(cur); cur = ''; continue; }
    cur += ch;
  }
  if (cur.trim()) parts.push(cur);
  return parts.map((p) => {
    const m = p.trim().match(/^(.+?)\s+AS\s+(.+)$/i);
    if (m) return { field: m[1].trim(), label: m[2].trim().replace(/^["']|["']$/g, '') };
    return { field: p.trim(), label: p.trim() };
  });
}

// Parses the whole fenced block's text: line 1 is `TABLE <cols>` / `LIST` /
// `TASK`; every following line is its own `FROM` / `WHERE` / `SORT` /
// `LIMIT` clause. One clause per line, matching how these queries are
// written in practice (and in every Dataview example the person is likely
// to already know).
function parseQueryBlock(raw) {
  const lines = (raw || '').split('\n').map((l) => l.trim()).filter(Boolean);
  if (!lines.length) return { error: 'Empty query.' };
  const typeMatch = lines[0].match(/^(TABLE|LIST|TASK)\b(.*)$/i);
  if (!typeMatch) return { error: 'Query must start with TABLE, LIST, or TASK.' };
  const type = typeMatch[1].toUpperCase();
  const columns = type === 'TABLE' && typeMatch[2].trim() ? parseQueryColumnList(typeMatch[2].trim()) : [];
  let from = null;
  let where = null;
  let sort = [];
  let limit = null;
  for (const line of lines.slice(1)) {
    const m = line.match(/^(FROM|WHERE|SORT|LIMIT)\b(.*)$/i);
    if (!m) continue;
    const kw = m[1].toUpperCase();
    const val = m[2].trim();
    if (kw === 'FROM') from = val;
    else if (kw === 'WHERE') where = val;
    else if (kw === 'LIMIT') limit = parseInt(val, 10) || null;
    else if (kw === 'SORT') {
      sort = val
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
        .map((s) => {
          const sm = s.match(/^(.+?)\s+(ASC|DESC)$/i);
          return sm ? { field: sm[1].trim(), dir: sm[2].toUpperCase() } : { field: s, dir: 'ASC' };
        });
    }
  }
  return { type, columns, from, where, sort, limit, error: null };
}

function runVaultQuery(queryText, pagesIndex) {
  const q = parseQueryBlock(queryText);
  if (q.error) return { error: q.error };
  let fromNode;
  let whereNode;
  try {
    fromNode = q.from ? parseQueryExpr(q.from) : null;
    whereNode = q.where ? parseQueryExpr(q.where) : null;
  } catch {
    return { error: 'Could not parse FROM/WHERE.' };
  }
  let rows = pagesIndex.pages.filter((p) => (fromNode ? evalSourceNode(fromNode, p) : true));
  if (whereNode) rows = rows.filter((p) => evalNode(whereNode, p));
  if (q.sort.length) {
    rows = rows.slice().sort((a, b) => {
      for (const s of q.sort) {
        const c = compareValues(getFieldValue(a, s.field), getFieldValue(b, s.field)) ?? 0;
        if (c !== 0) return s.dir === 'DESC' ? -c : c;
      }
      return 0;
    });
  } else {
    rows = rows.slice().sort((a, b) => (a.file.name || '').localeCompare(b.file.name || ''));
  }
  if (q.limit) rows = rows.slice(0, q.limit);
  return { query: q, rows };
}

// Renders one resolved field value — links become clickable (and reuse the
// same "missing → dashed, click to create" affordance as inline [[links]]
// elsewhere), arrays join with commas, dates show their original text.
function QueryValue({ value, linkIndex, onOpenById, onCreateOrOpenByName }) {
  if (value == null) return null;
  if (Array.isArray(value)) {
    return (
      <>
        {value.map((v, i) => (
          <React.Fragment key={i}>
            {i > 0 && ', '}
            <QueryValue value={v} linkIndex={linkIndex} onOpenById={onOpenById} onCreateOrOpenByName={onCreateOrOpenByName} />
          </React.Fragment>
        ))}
      </>
    );
  }
  if (typeof value === 'object' && value.type === 'link') {
    const res = resolveLinkTarget(value.target, linkIndex);
    if (res.status === 'resolved') {
      return (
        <span className="wikilink" onClick={() => onOpenById?.(res.file.id)} title={`Open ${res.file.baseName}`}>
          {value.display}
        </span>
      );
    }
    return (
      <span
        className="wikilink wikilink-new"
        onClick={() => onCreateOrOpenByName?.(value.target)}
        title={`Create "${value.target}"`}
      >
        {value.display}
      </span>
    );
  }
  if (typeof value === 'object' && value.type === 'date') return <>{value.raw}</>;
  if (typeof value === 'boolean') return <>{value ? 'true' : 'false'}</>;
  return <>{String(value)}</>;
}

// A rendered ```query / ```dataview block. `handlers.pagesIndex` is built
// once at the app root (see the `pagesIndex` useMemo near the top-level
// `handlers` object) and only needs a background full-vault index — the
// same one Search/Tags already trigger — so a query works even the very
// first time it's added to a note, not just after every note happens to
// have already been opened once.
function QueryBlock({ raw, handlers, linkIndex }) {
  const ensureVaultIndexed = handlers?.ensureVaultIndexed;
  useEffect(() => {
    ensureVaultIndexed?.();
  }, [ensureVaultIndexed]);

  const pagesIndex = handlers?.pagesIndex;
  const result = useMemo(() => (pagesIndex ? runVaultQuery(raw, pagesIndex) : null), [raw, pagesIndex]);

  if (!pagesIndex || !handlers?.vaultIndexReady) {
    const progress = handlers?.vaultIndexProgress;
    return (
      <div className="query-block query-block-loading muted">
        Indexing vault for queries{progress?.total ? ` — ${progress.loaded}/${progress.total}` : '…'}
      </div>
    );
  }
  if (result.error) {
    return <div className="query-block query-block-error">Query error: {result.error}</div>;
  }
  const { query, rows } = result;
  if (!rows.length) {
    return <div className="query-block query-block-empty muted">No results.</div>;
  }

  if (query.type === 'TABLE') {
    const cols = query.columns.length ? query.columns : [{ field: 'file.name', label: 'File' }];
    return (
      <table className="md-table query-table">
        <thead>
          <tr>
            {cols.map((c, i) => (
              <th key={i}>{c.label}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((page) => (
            <tr key={page.file.id}>
              {cols.map((c, i) => (
                <td key={i}>
                  <QueryValue
                    value={getFieldValue(page, c.field)}
                    linkIndex={linkIndex}
                    onOpenById={handlers?.onOpenById}
                    onCreateOrOpenByName={handlers?.onCreateOrOpenByName}
                  />
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    );
  }

  if (query.type === 'TASK') {
    const taskLineRe = /^\s*[-*]\s+\[( |x|X)\]\s+(.*)$/;
    const groups = rows
      .map((page) => {
        const body = handlers?.getBody ? handlers.getBody(page.file.id) : '';
        const tasks = (body || '')
          .split('\n')
          .map((l) => l.match(taskLineRe))
          .filter(Boolean)
          .map((m) => ({ checked: /[xX]/.test(m[1]), text: m[2] }));
        return { page, tasks };
      })
      .filter((g) => g.tasks.length);
    if (!groups.length) return <div className="query-block query-block-empty muted">No results.</div>;
    return (
      <div className="query-tasklist">
        {groups.map(({ page, tasks }) => (
          <div key={page.file.id} className="query-task-group">
            <div className="query-task-source">
              <QueryValue value={page.file.link} linkIndex={linkIndex} onOpenById={handlers?.onOpenById} />
            </div>
            {tasks.map((t, i) => (
              <div className="task-line" key={i}>
                <input type="checkbox" checked={t.checked} readOnly />
                <span className={t.checked ? 'task-done' : ''}>{t.text}</span>
              </div>
            ))}
          </div>
        ))}
      </div>
    );
  }

  return (
    <ul className="query-list">
      {rows.map((page) => (
        <li key={page.file.id}>
          <QueryValue value={page.file.link} linkIndex={linkIndex} onOpenById={handlers?.onOpenById} />
        </li>
      ))}
    </ul>
  );
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
    const kind = f.kind || 'note';
    const isAsset = !opensInEditorPane(kind);
    const isImage = kind === 'image';
    const baseName = isAsset ? f.name : f.name.replace(/\.[^.]+$/i, '');
    const relativePath = dir ? `${dir}/${baseName}` : baseName;
    return { ...f, kind, isAsset, isImage, baseName, relativePath, dir };
  });

  const byBasenameKey = new Map();
  const byRelativePath = new Map();
  records.forEach((r) => {
    const key = `${r.isAsset ? 'asset' : 'note'}:${r.baseName.toLowerCase()}`;
    if (!byBasenameKey.has(key)) byBasenameKey.set(key, []);
    byBasenameKey.get(key).push(r);
    byRelativePath.set(r.relativePath.toLowerCase(), r);
  });

  return { records, byBasenameKey, byRelativePath, folderPath };
}

// Resolves the text inside a [[...]] (already stripped of any |alias or
// #heading) against the current vault. One of:
//   { status: 'resolved', file }
//   { status: 'missing', isAsset }                  -- no such file (yet)
//   { status: 'ambiguous', isAsset, candidates }      -- name matches 2+ files
// `isAsset` (any non-note file: image/video/audio/other) is kept alongside
// the old `isImage` name so existing callers that only cared about images
// still work unchanged for that subset.
function resolveLinkTarget(rawTarget, linkIndex) {
  const target = String(rawTarget || '').trim();
  const isAsset = isAssetName(target);
  const isImage = isImageName(target);
  const cleaned = isAsset ? target : target.replace(/\.md$/i, '');

  if (cleaned.includes('/')) {
    const hit = linkIndex.byRelativePath.get(cleaned.toLowerCase());
    return hit ? { status: 'resolved', file: hit } : { status: 'missing', isAsset, isImage };
  }

  const key = `${isAsset ? 'asset' : 'note'}:${cleaned.toLowerCase()}`;
  const matches = linkIndex.byBasenameKey.get(key) || [];
  if (matches.length === 1) return { status: 'resolved', file: matches[0] };
  if (matches.length === 0) return { status: 'missing', isAsset, isImage };
  return {
    status: 'ambiguous',
    isAsset,
    isImage,
    candidates: matches.slice().sort((a, b) => a.relativePath.localeCompare(b.relativePath))
  };
}

// The link text to insert when autocomplete (or a "resolve this" action)
// picks `file` — the bare name if that's unambiguous vault-wide, otherwise
// the full path from the vault root. This is the other half of the smart
// linking behavior: it's what keeps typed links short by default.
function bestLinkTextFor(file, linkIndex) {
  const key = `${file.isAsset ? 'asset' : 'note'}:${file.baseName.toLowerCase()}`;
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
  // Any real file (notes, images, video, audio, PDFs, zips, whatever) syncs
  // now — only Google's native app types (Docs/Sheets/Slides/etc, which
  // have no downloadable bytes via alt=media in the format this app wants)
  // and folders (handled by the separate folder-tree listing) are excluded.
  const chunks = chunkArray(folderIds, 10);
  const chunkResults = await Promise.all(
    chunks.map(async (chunk) => {
      const parentClauses = chunk.map((id) => `'${id}' in parents`).join(' or ');
      const q = encodeURIComponent(
        `(${parentClauses}) and trashed = false and not mimeType contains 'vnd.google-apps'`
      );
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
    kind: classifyKind(f.name, f.mimeType)
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

// `ext`/`mimeType` default to plain markdown notes; database creation passes
// ext='base', mimeType='application/json' so the same multipart-upload
// plumbing (and the same proxy action) can create either page kind.
async function driveCreateFile(token, folderId, rawName, content = '', ext = 'md', mimeType = 'text/markdown') {
  const suffix = `.${ext}`;
  const name = rawName.toLowerCase().endsWith(suffix) ? rawName : `${rawName}${suffix}`;
  if (isProxy(token)) {
    return proxyPost(token, { action: 'createFile', folderId, name, content });
  }
  const metadata = { name, parents: [folderId], mimeType };
  const boundary = `vault-${Date.now()}`;
  const body =
    `--${boundary}\r\n` +
    `Content-Type: application/json; charset=UTF-8\r\n\r\n` +
    `${JSON.stringify(metadata)}\r\n` +
    `--${boundary}\r\n` +
    `Content-Type: ${mimeType}\r\n\r\n` +
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

// Turns the flat tag list above into a nested-tag tree for display: every
// prefix of a nested tag ("project" and "project/alpha" for a note tagged
// #project/alpha) becomes its own row, with `depth` for indentation and
// `count` aggregating every distinct note tagged with it or any descendant.
// Clicking a parent row still works with search's existing `tag:` semantics
// (a tag search already matches descendants of the given prefix).
function buildTagTree(tagRows) {
  const filesByPath = new Map(); // full path -> Set(fileId)
  tagRows.forEach(({ tag, files }) => {
    const parts = tag.split('/');
    let path = '';
    parts.forEach((part) => {
      path = path ? `${path}/${part}` : part;
      if (!filesByPath.has(path)) filesByPath.set(path, new Set());
      files.forEach((f) => filesByPath.get(path).add(f.id));
    });
  });
  return Array.from(filesByPath.keys())
    .sort((a, b) => a.localeCompare(b))
    .map((path) => {
      const parts = path.split('/');
      return { path, name: parts[parts.length - 1], depth: parts.length - 1, count: filesByPath.get(path).size };
    });
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
const IconListTree = (p) => (
  <Svg {...p}>
    <line x1="9" y1="6" x2="20" y2="6" />
    <line x1="12" y1="12" x2="20" y2="12" />
    <line x1="12" y1="18" x2="20" y2="18" />
    <circle cx="5" cy="6" r="1.5" />
    <line x1="5" y1="7.5" x2="5" y2="10.5" />
    <line x1="5" y1="10.5" x2="8" y2="12" />
    <line x1="5" y1="10.5" x2="5" y2="16.5" />
    <line x1="5" y1="16.5" x2="8" y2="18" />
  </Svg>
);
const IconPalette = (p) => (
  <Svg {...p}>
    <path d="M12 3a9 9 0 1 0 0 18c1.1 0 2-.9 2-2 0-.5-.2-1-.5-1.4-.3-.4-.5-.9-.5-1.4 0-1.1.9-2 2-2h1.5c1.9 0 3.5-1.6 3.5-3.5C20 6.6 16.4 3 12 3z" />
    <circle cx="7.5" cy="10.5" r="1.1" fill="currentColor" stroke="none" />
    <circle cx="11" cy="7" r="1.1" fill="currentColor" stroke="none" />
    <circle cx="15.5" cy="8" r="1.1" fill="currentColor" stroke="none" />
  </Svg>
);
const IconPlus = (p) => (
  <Svg {...p}>
    <line x1="12" y1="5" x2="12" y2="19" />
    <line x1="5" y1="12" x2="19" y2="12" />
  </Svg>
);
const IconGraph = (p) => (
  <Svg {...p}>
    <line x1="7" y1="7.2" x2="10.2" y2="10.6" />
    <line x1="16.8" y1="7.2" x2="13.6" y2="10.6" />
    <line x1="10.8" y1="13.8" x2="7.4" y2="17.4" />
    <line x1="13.4" y1="13.8" x2="16.6" y2="16.8" />
    <circle cx="5" cy="6" r="2.2" />
    <circle cx="19" cy="6" r="2.2" />
    <circle cx="12" cy="12" r="2.2" />
    <circle cx="6" cy="19" r="2.2" />
    <circle cx="18" cy="18" r="2.2" />
  </Svg>
);
const IconMaximize = (p) => (
  <Svg {...p}>
    <polyline points="8 3 3 3 3 8" />
    <polyline points="16 3 21 3 21 8" />
    <polyline points="3 16 3 21 8 21" />
    <polyline points="21 16 21 21 16 21" />
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
const IconVideo = (p) => (
  <Svg {...p}>
    <rect x="2" y="5" width="14" height="14" rx="2" />
    <path d="m16 9 6-3v12l-6-3" />
  </Svg>
);
const IconAudio = (p) => (
  <Svg {...p}>
    <path d="M9 18V5l12-2v13" />
    <circle cx="6" cy="18" r="3" />
    <circle cx="18" cy="16" r="3" />
  </Svg>
);
const IconFile = (p) => (
  <Svg {...p}>
    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
    <polyline points="14 2 14 8 20 8" />
  </Svg>
);
const IconDownload = (p) => (
  <Svg {...p}>
    <path d="M12 3v12" />
    <polyline points="7 11 12 16 17 11" />
    <path d="M5 20h14" />
  </Svg>
);
const IconDatabase = (p) => (
  <Svg {...p}>
    <ellipse cx="12" cy="5" rx="8" ry="3" />
    <path d="M4 5v6c0 1.7 3.6 3 8 3s8-1.3 8-3V5" />
    <path d="M4 11v6c0 1.7 3.6 3 8 3s8-1.3 8-3v-6" />
  </Svg>
);
const IconTable = (p) => (
  <Svg {...p}>
    <rect x="3" y="4" width="18" height="16" rx="2" />
    <line x1="3" y1="10" x2="21" y2="10" />
    <line x1="9" y1="4" x2="9" y2="20" />
  </Svg>
);
const IconKanban = (p) => (
  <Svg {...p}>
    <rect x="3" y="4" width="18" height="16" rx="2" />
    <line x1="9" y1="4" x2="9" y2="20" />
    <line x1="15" y1="4" x2="15" y2="20" />
    <line x1="5.5" y1="8" x2="6.5" y2="8" />
    <line x1="11.5" y1="8" x2="12.5" y2="8" />
    <line x1="17.5" y1="8" x2="18.5" y2="8" />
  </Svg>
);
const IconLayoutGrid = (p) => (
  <Svg {...p}>
    <rect x="3" y="3" width="7" height="7" rx="1.3" />
    <rect x="14" y="3" width="7" height="7" rx="1.3" />
    <rect x="3" y="14" width="7" height="7" rx="1.3" />
    <rect x="14" y="14" width="7" height="7" rx="1.3" />
  </Svg>
);
const IconCalendar = (p) => (
  <Svg {...p}>
    <rect x="3" y="4.5" width="18" height="16" rx="2" />
    <line x1="3" y1="9.5" x2="21" y2="9.5" />
    <line x1="8" y1="2.5" x2="8" y2="6.5" />
    <line x1="16" y1="2.5" x2="16" y2="6.5" />
  </Svg>
);
const IconHash = (p) => (
  <Svg {...p}>
    <line x1="5" y1="9" x2="19" y2="9" />
    <line x1="5" y1="15" x2="19" y2="15" />
    <line x1="9.5" y1="4" x2="7" y2="20" />
    <line x1="16" y1="4" x2="13.5" y2="20" />
  </Svg>
);
const IconType = (p) => (
  <Svg {...p}>
    <polyline points="4 6 4 4 20 4 20 6" />
    <line x1="12" y1="4" x2="12" y2="20" />
    <line x1="9" y1="20" x2="15" y2="20" />
  </Svg>
);
const IconAlignLeft = (p) => (
  <Svg {...p}>
    <line x1="4" y1="6" x2="20" y2="6" />
    <line x1="4" y1="12" x2="15" y2="12" />
    <line x1="4" y1="18" x2="18" y2="18" />
  </Svg>
);
const IconCheckSquare = (p) => (
  <Svg {...p}>
    <rect x="3" y="3" width="18" height="18" rx="3" />
    <polyline points="7.5 12 10.5 15 16.5 9" />
  </Svg>
);
const IconChevronsUpDown = (p) => (
  <Svg {...p}>
    <polyline points="7 15 12 20 17 15" />
    <polyline points="7 9 12 4 17 9" />
  </Svg>
);
const IconGripVertical = (p) => (
  <Svg {...p} fill="currentColor" stroke="none">
    <circle cx="9" cy="5" r="1.4" />
    <circle cx="9" cy="12" r="1.4" />
    <circle cx="9" cy="19" r="1.4" />
    <circle cx="15" cy="5" r="1.4" />
    <circle cx="15" cy="12" r="1.4" />
    <circle cx="15" cy="19" r="1.4" />
  </Svg>
);
const IconPaperclip = (p) => (
  <Svg {...p}>
    <path d="M21 12.5 12.5 21a5 5 0 0 1-7-7L14 5.5a3.5 3.5 0 0 1 5 5L10.5 19a2 2 0 0 1-3-3L15 8.5" />
  </Svg>
);
const IconLink2 = (p) => (
  <Svg {...p}>
    <path d="M9 17H7A5 5 0 0 1 7 7h2" />
    <path d="M15 7h2a5 5 0 1 1 0 10h-2" />
    <line x1="8" y1="12" x2="16" y2="12" />
  </Svg>
);
const IconTags = (p) => (
  <Svg {...p}>
    <path d="M17.6 12.6 9.4 20.8a2 2 0 0 1-2.8 0l-4.4-4.4a2 2 0 0 1 0-2.8L10.4 5.4A2 2 0 0 1 11.8 5H18a2 2 0 0 1 2 2v6.2a2 2 0 0 1-.4 1.4Z" />
    <circle cx="14.5" cy="9.5" r="1.2" fill="currentColor" stroke="none" />
  </Svg>
);
// Small kind -> icon lookup for non-note tree rows. Images get no override
// (they already read clearly from the filename/thumbnail elsewhere), so
// only video/audio/generic-file/database/canvas get a distinguishing glyph
// in the sidebar. Defined after the icon consts below it (ASSET_KIND_ICONS
// references IconCanvasKind, so it must come after that const is declared).
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
// Canvas icons — used for the sidebar/kind icon, the toolbar, and the
// per-node context menu. Kept near the rest of the icon set.
const IconCanvasKind = (p) => (
  <Svg {...p}>
    <rect x="3" y="4" width="8" height="6" rx="1" />
    <rect x="13" y="3" width="8" height="5" rx="1" />
    <rect x="13" y="12" width="8" height="9" rx="1" />
    <rect x="3" y="14" width="8" height="7" rx="1" />
    <line x1="11" y1="7" x2="13" y2="6" />
    <line x1="17" y1="8" x2="17" y2="12" />
    <line x1="11" y1="17" x2="13" y2="17" />
  </Svg>
);
const IconZoomIn = (p) => (
  <Svg {...p}>
    <circle cx="10.5" cy="10.5" r="6.5" />
    <line x1="10.5" y1="7.5" x2="10.5" y2="13.5" />
    <line x1="7.5" y1="10.5" x2="13.5" y2="10.5" />
    <line x1="20" y1="20" x2="15.5" y2="15.5" />
  </Svg>
);
const IconZoomOut = (p) => (
  <Svg {...p}>
    <circle cx="10.5" cy="10.5" r="6.5" />
    <line x1="7.5" y1="10.5" x2="13.5" y2="10.5" />
    <line x1="20" y1="20" x2="15.5" y2="15.5" />
  </Svg>
);
const IconFrame = (p) => (
  <Svg {...p}>
    <line x1="4" y1="2" x2="4" y2="22" />
    <line x1="20" y1="2" x2="20" y2="22" />
    <line x1="2" y1="4" x2="22" y2="4" />
    <line x1="2" y1="20" x2="22" y2="20" />
  </Svg>
);
const IconStickyNote = (p) => (
  <Svg {...p}>
    <path d="M4 4h13l3 3v13a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1Z" />
    <path d="M16 4v4h4" />
  </Svg>
);
const ASSET_KIND_ICONS = { video: IconVideo, audio: IconAudio, file: IconFile, database: IconDatabase, canvas: IconCanvasKind };

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

      if (resolution.status === 'resolved' && resolution.file.kind === 'image') {
        nodes.push(
          <ImageEmbed
            key={key}
            token={handlers.token}
            fileId={resolution.file.id}
            name={resolution.file.name}
            caption={rawAlias ? label : null}
            onOpen={() => handlers.onOpenAsset(resolution.file)}
          />
        );
      } else if (resolution.status === 'resolved' && resolution.file.kind === 'video') {
        nodes.push(
          <VideoEmbed key={key} token={handlers.token} fileId={resolution.file.id} name={resolution.file.name} />
        );
      } else if (resolution.status === 'resolved' && resolution.file.kind === 'audio') {
        nodes.push(
          <AudioEmbed key={key} token={handlers.token} fileId={resolution.file.id} name={resolution.file.name} />
        );
      } else if (resolution.status === 'resolved' && resolution.file.kind === 'file') {
        nodes.push(
          <FileChip
            key={key}
            name={resolution.file.name}
            label={rawAlias ? label : null}
            onOpen={() => handlers.onOpenAsset(resolution.file)}
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
            onPick={(file) => (opensInEditorPane(file.kind) ? handlers.onOpenById(file.id) : handlers.onOpenAsset(file))}
          />
        );
      } else if (resolution.isAsset) {
        nodes.push(
          <span key={key} className="wikilink wikilink-missing-image" title={`File not found: ${rawTarget}`}>
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

// Cell splitter/detector for GFM-style pipe tables: `| a | b |` rows plus a
// `| --- | :--: |` alignment row directly under the header.
function splitTableRow(line) {
  let l = line.trim();
  if (l.startsWith('|')) l = l.slice(1);
  if (l.endsWith('|')) l = l.slice(0, -1);
  return l.split('|').map((c) => c.trim());
}
function isTableSeparatorRow(line) {
  const cells = splitTableRow(line);
  return cells.length > 0 && cells.every((c) => /^:?-{1,}:?$/.test(c));
}
function tableColAlign(cell) {
  if (!cell) return null;
  const left = cell.startsWith(':');
  const right = cell.endsWith(':');
  if (left && right) return 'center';
  if (right) return 'right';
  if (left) return 'left';
  return null;
}

// Obsidian-style callout icon per `[!type]`. Unrecognized types still
// render fine — they just fall back to the plain info glyph.
const CALLOUT_ICONS = {
  note: IconInfo,
  info: IconInfo,
  abstract: IconInfo,
  summary: IconInfo,
  tip: IconCheck,
  hint: IconCheck,
  success: IconCheck,
  check: IconCheck,
  done: IconCheck,
  question: IconHelp,
  help: IconHelp,
  faq: IconHelp,
  warning: IconAlertTriangle,
  caution: IconAlertTriangle,
  attention: IconAlertTriangle,
  danger: IconAlertTriangle,
  error: IconAlertTriangle,
  failure: IconAlertTriangle,
  bug: IconAlertTriangle,
  quote: IconInfo,
  example: IconInfo
};

// A `> [!type] Title` blockquote — Obsidian's callout syntax. `lines` are
// the remaining (already `>`-stripped) lines of the same blockquote, which
// render as nested markdown so lists/links/etc still work inside a callout.
function Callout({ type, title, lines, handlers, linkIndex, keyBase }) {
  const Icon = CALLOUT_ICONS[type] || IconInfo;
  return (
    <div className={`callout callout-${type}`}>
      <div className="callout-title">
        <Icon size={15} className="callout-icon" />
        <span>{renderInline(title, `${keyBase}t`, handlers, linkIndex)}</span>
      </div>
      {lines.length > 0 && <div className="callout-body">{renderMarkdownBlocks(lines.join('\n'), handlers, linkIndex, keyBase)}</div>}
    </div>
  );
}

// A Notion-style in-note tab block: `:::tabs` ... one or more `:::tab Name`
// sections ... `:::`. Unlike columns/toggles this block is mutable from
// reading view (add/rename/delete tabs), so it round-trips through a
// parse/serialize pair rather than only ever being read.
function parseTabsBlock(innerLines) {
  const tabs = [];
  let current = null;
  innerLines.forEach((l) => {
    const m = l.match(/^:::tab\s+(.*)$/);
    if (m) {
      current = { name: m[1].trim() || `Tab ${tabs.length + 1}`, lines: [] };
      tabs.push(current);
    } else if (current) {
      current.lines.push(l);
    }
    // Any lines before the first `:::tab` marker are stray/preamble and
    // dropped, same as columns silently drops content before the first
    // `:::column` marker.
  });
  if (!tabs.length) tabs.push({ name: 'Tab 1', lines: innerLines.slice() });
  return tabs;
}
function serializeTabsBlock(tabs) {
  const body = tabs.map((t) => `:::tab ${t.name}\n${t.lines.join('\n')}`).join('\n');
  return `:::tabs\n${body}\n:::`;
}

// Renders a parsed tabs block plus its own tab bar. `rawBlockText` is this
// block's exact source text (from the opening `:::tabs` line to the closing
// `:::` line, inclusive) — edits are applied by asking `handlers.onMutateBlock`
// to swap that exact substring for a freshly-serialized one, so this
// component never needs to know its own position in the wider document.
function TabsBlockView({ tabs, rawBlockText, handlers, linkIndex, foldState, keyBase }) {
  const [active, setActive] = useState(0);
  const safeActive = Math.min(active, tabs.length - 1);
  const [renamingIdx, setRenamingIdx] = useState(null);
  const [draft, setDraft] = useState('');

  const commit = (newTabs, newActive) => {
    handlers.onMutateBlock?.(rawBlockText, serializeTabsBlock(newTabs));
    if (newActive !== undefined) setActive(newActive);
  };

  const addTab = () => {
    const newTabs = [...tabs, { name: `Tab ${tabs.length + 1}`, lines: [''] }];
    commit(newTabs, newTabs.length - 1);
  };

  const deleteTab = (i) => {
    if (tabs.length <= 1) return;
    const newTabs = tabs.filter((_, idx) => idx !== i);
    let newActive = safeActive;
    if (i === safeActive) newActive = Math.max(0, i - 1);
    else if (i < safeActive) newActive = safeActive - 1;
    commit(newTabs, newActive);
  };

  const renameTab = (i, name) => {
    const trimmed = name.trim();
    if (!trimmed || trimmed === tabs[i].name) return;
    commit(tabs.map((t, idx) => (idx === i ? { ...t, name: trimmed } : t)));
  };

  return (
    <div className="tabs-block">
      <div className="tabs-block-bar">
        {tabs.map((t, i) => (
          <div
            key={i}
            className={`tabs-block-tab ${i === safeActive ? 'active' : ''}`}
            onClick={() => setActive(i)}
            onDoubleClick={(e) => {
              e.stopPropagation();
              setRenamingIdx(i);
              setDraft(t.name);
            }}
          >
            {renamingIdx === i ? (
              <input
                className="tabs-block-rename-input"
                autoFocus
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onClick={(e) => e.stopPropagation()}
                onBlur={() => {
                  setRenamingIdx(null);
                  renameTab(i, draft);
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') e.currentTarget.blur();
                  if (e.key === 'Escape') setRenamingIdx(null);
                }}
              />
            ) : (
              <span className="tabs-block-tab-label">{t.name}</span>
            )}
            {tabs.length > 1 && (
              <button
                className="tabs-block-tab-close"
                title="Delete tab"
                onClick={(e) => {
                  e.stopPropagation();
                  deleteTab(i);
                }}
              >
                <IconX size={11} />
              </button>
            )}
          </div>
        ))}
        <button className="tabs-block-add" title="Add tab" onClick={addTab}>
          <IconPlus size={13} />
        </button>
      </div>
      <div className="tabs-block-body">
        {renderMarkdownBlocks((tabs[safeActive]?.lines || []).join('\n'), handlers, linkIndex, `${keyBase}-${safeActive}-`, foldState)}
      </div>
    </div>
  );
}

// `foldState` (optional) enables Obsidian-style heading fold/collapse in
// reading view: { collapsed: Set<headingId>, onToggle: (headingId) => void,
// collapsedToggles: Set<toggleId>, onToggleToggle: (toggleId) => void }.
// Headings whose id is in `collapsed` render with their content (down to the
// next heading of equal-or-shallower level) hidden. Purely a reading-view
// affordance — the underlying markdown/content is never mutated, so it's
// safe to leave out entirely (edit mode, or any caller that omits
// foldState) and get the old unfolded behavior (toggle blocks default open
// when there's no state to remember a collapse).
function renderMarkdownBlocks(content, handlers, linkIndex, keyBase = '', foldState = null) {
  const lines = content.split('\n');
  const blocks = [];
  let listBuffer = [];
  let listType = null;
  let codeBuffer = null;
  let codeLang = null;
  let quoteBuffer = [];
  // While set, we're inside a collapsed heading's section: everything is
  // parsed (to keep fence/list state consistent) but nothing is pushed to
  // `blocks`, until a heading at this level or shallower closes it.
  let hiddenUntilLevel = null;
  // Index of the last line already consumed by a multi-line block (table,
  // toggle, columns) that scanned ahead — lines up to and including this
  // index are skipped by the main loop.
  let skipUntil = -1;

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

  const flushQuote = () => {
    if (!quoteBuffer.length) return;
    const calloutMatch = quoteBuffer[0].match(/^\[!([a-zA-Z]+)\]([+-]?)\s*(.*)$/);
    if (calloutMatch) {
      const type = calloutMatch[1].toLowerCase();
      const titleText = calloutMatch[3].trim() || type.charAt(0).toUpperCase() + type.slice(1);
      const key = `${keyBase}callout-${blocks.length}-`;
      blocks.push(
        <Callout
          key={key}
          type={type}
          title={titleText}
          lines={quoteBuffer.slice(1)}
          handlers={handlers}
          linkIndex={linkIndex}
          keyBase={key}
        />
      );
    } else {
      blocks.push(
        <blockquote key={`${keyBase}q-${blocks.length}`}>
          {quoteBuffer.map((l, i) => (
            <p key={i}>{renderInline(l, `${keyBase}q-${blocks.length}-${i}`, handlers, linkIndex)}</p>
          ))}
        </blockquote>
      );
    }
    quoteBuffer = [];
  };

  lines.forEach((line, idx) => {
    if (idx <= skipUntil) return;
    if (codeBuffer !== null) {
      if (/^```/.test(line.trim())) {
        if (hiddenUntilLevel === null) {
          if (codeLang === 'query' || codeLang === 'dataview') {
            blocks.push(
              <QueryBlock key={`${keyBase}query-${idx}`} raw={codeBuffer.join('\n')} handlers={handlers} linkIndex={linkIndex} />
            );
          } else {
            blocks.push(
              <pre key={`${keyBase}code-${idx}`}>
                <code>{codeBuffer.join('\n')}</code>
              </pre>
            );
          }
        }
        codeBuffer = null;
        codeLang = null;
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
    const toggleOpen = line.match(/^\+\+\+\s?(.*)$/);
    const columnsOpen = line.trim().match(/^:::columns-([234])\s*$/);
    const tabsOpen = line.trim().match(/^:::tabs\s*$/);
    const isTableStart =
      !fence &&
      !heading &&
      !hr &&
      line.includes('|') &&
      line.trim() !== '' &&
      idx + 1 < lines.length &&
      isTableSeparatorRow(lines[idx + 1]);

    if (heading) {
      const level = Math.min(heading[1].length, 6);
      if (hiddenUntilLevel !== null) {
        if (level <= hiddenUntilLevel) {
          hiddenUntilLevel = null;
        } else {
          // Nested inside a collapsed ancestor — stays hidden entirely.
          return;
        }
      }
      flushList();
      flushQuote();
      const headingId = heading[2].trim().toLowerCase().replace(/[^a-z0-9]+/g, '-');
      const fullId = `${keyBase}${headingId}`;
      const isCollapsed = !!foldState?.collapsed?.has(fullId);
      blocks.push(
        React.createElement(
          `h${level}`,
          { key: `${keyBase}h-${idx}`, id: fullId },
          foldState && (
            <span
              className={`heading-fold-toggle ${isCollapsed ? 'collapsed' : ''}`}
              onClick={(e) => {
                e.stopPropagation();
                foldState.onToggle(fullId);
              }}
              role="button"
              aria-label={isCollapsed ? 'Expand section' : 'Collapse section'}
            >
              <IconChevronDown size={12} />
            </span>
          ),
          renderInline(heading[2], `${keyBase}h-${idx}`, handlers, linkIndex)
        )
      );
      if (isCollapsed) hiddenUntilLevel = level;
      return;
    }

    if (hiddenUntilLevel !== null) {
      // Inside a collapsed section: still track fence-open so line
      // interpretation downstream (once we exit) stays correct, but don't
      // render anything.
      if (fence) {
        codeBuffer = [];
        codeLang = line.trim().slice(3).trim().toLowerCase();
      }
      return;
    }

    if (toggleOpen) {
      flushList();
      flushQuote();
      let j = idx + 1;
      while (j < lines.length && lines[j].trim() !== '+++') j++;
      const innerLines = lines.slice(idx + 1, j);
      const toggleId = `${keyBase}toggle-${idx}`;
      const isCollapsed = !!foldState?.collapsedToggles?.has(toggleId);
      blocks.push(
        <div className={`toggle-block ${isCollapsed ? 'collapsed' : ''}`} key={toggleId}>
          <div
            className="toggle-header"
            onClick={() => foldState?.onToggleToggle?.(toggleId)}
            role="button"
            aria-label={isCollapsed ? 'Expand toggle' : 'Collapse toggle'}
          >
            <span className="toggle-caret">
              <IconChevronRight size={12} />
            </span>
            <span className="toggle-title">
              {renderInline(toggleOpen[1] || 'Toggle', `${toggleId}-t`, handlers, linkIndex)}
            </span>
          </div>
          {!isCollapsed && (
            <div className="toggle-body">{renderMarkdownBlocks(innerLines.join('\n'), handlers, linkIndex, `${toggleId}-`, foldState)}</div>
          )}
        </div>
      );
      skipUntil = j;
      return;
    }

    if (columnsOpen) {
      flushList();
      flushQuote();
      const colCount = parseInt(columnsOpen[1], 10);
      let j = idx + 1;
      while (j < lines.length && lines[j].trim() !== ':::') j++;
      const innerLines = lines.slice(idx + 1, j);
      const chunks = [];
      let current = [];
      innerLines.forEach((l) => {
        if (l.trim() === ':::column') {
          chunks.push(current);
          current = [];
        } else {
          current.push(l);
        }
      });
      chunks.push(current);
      const colsKey = `${keyBase}cols-${idx}`;
      blocks.push(
        <div className="md-columns" style={{ '--col-count': colCount }} key={colsKey}>
          {chunks.map((chunkLines, ci) => (
            <div className="md-column" key={`${colsKey}-${ci}`}>
              {renderMarkdownBlocks(chunkLines.join('\n'), handlers, linkIndex, `${colsKey}-${ci}-`, foldState)}
            </div>
          ))}
        </div>
      );
      skipUntil = j;
      return;
    }

    if (tabsOpen) {
      flushList();
      flushQuote();
      let j = idx + 1;
      while (j < lines.length && lines[j].trim() !== ':::') j++;
      const innerLines = lines.slice(idx + 1, j);
      const rawBlockText = lines.slice(idx, Math.min(j + 1, lines.length)).join('\n');
      const tabsKey = `${keyBase}tabs-${idx}`;
      blocks.push(
        <TabsBlockView
          key={tabsKey}
          keyBase={tabsKey}
          tabs={parseTabsBlock(innerLines)}
          rawBlockText={rawBlockText}
          handlers={handlers}
          linkIndex={linkIndex}
          foldState={foldState}
        />
      );
      skipUntil = j;
      return;
    }

    if (isTableStart) {
      flushList();
      flushQuote();
      const headerCells = splitTableRow(line);
      const aligns = splitTableRow(lines[idx + 1]).map(tableColAlign);
      let j = idx + 2;
      const bodyRows = [];
      while (j < lines.length && lines[j].includes('|') && lines[j].trim() !== '') {
        bodyRows.push(splitTableRow(lines[j]));
        j++;
      }
      const tKey = `${keyBase}table-${idx}`;
      blocks.push(
        <table className="md-table" key={tKey}>
          <thead>
            <tr>
              {headerCells.map((c, ci) => (
                <th key={ci} style={aligns[ci] ? { textAlign: aligns[ci] } : undefined}>
                  {renderInline(c, `${tKey}-h-${ci}`, handlers, linkIndex)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {bodyRows.map((row, ri) => (
              <tr key={ri}>
                {row.map((c, ci) => (
                  <td key={ci} style={aligns[ci] ? { textAlign: aligns[ci] } : undefined}>
                    {renderInline(c, `${tKey}-${ri}-${ci}`, handlers, linkIndex)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      );
      skipUntil = j - 1;
      return;
    }

    if (fence) {
      flushList();
      flushQuote();
      codeBuffer = [];
      codeLang = line.trim().slice(3).trim().toLowerCase();
    } else if (taskUl) {
      flushList();
      flushQuote();
      const checked = taskUl[1].toLowerCase() === 'x';
      blocks.push(
        <div className="task-line" key={`${keyBase}task-${idx}`}>
          <input type="checkbox" checked={checked} readOnly />
          <span className={checked ? 'task-done' : ''}>{renderInline(taskUl[2], `${keyBase}t-${idx}`, handlers, linkIndex)}</span>
        </div>
      );
    } else if (hr) {
      flushList();
      flushQuote();
      blocks.push(<hr key={`${keyBase}hr-${idx}`} />);
    } else if (quote) {
      flushList();
      quoteBuffer.push(quote[1]);
    } else if (ul) {
      flushQuote();
      listType = 'ul';
      listBuffer.push(ul[1]);
    } else if (ol) {
      flushQuote();
      listType = 'ol';
      listBuffer.push(ol[1]);
    } else if (line.trim() === '') {
      flushList();
      flushQuote();
    } else {
      flushList();
      flushQuote();
      blocks.push(<p key={`${keyBase}p-${idx}`}>{renderInline(line, `${keyBase}p-${idx}`, handlers, linkIndex)}</p>);
    }
  });
  flushList();
  flushQuote();
  if (codeBuffer !== null && hiddenUntilLevel === null) {
    if (codeLang === 'query' || codeLang === 'dataview') {
      blocks.push(<QueryBlock key={`${keyBase}query-end`} raw={codeBuffer.join('\n')} handlers={handlers} linkIndex={linkIndex} />);
    } else {
      blocks.push(
        <pre key={`${keyBase}code-end`}>
          <code>{codeBuffer.join('\n')}</code>
        </pre>
      );
    }
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
// UI: onboarding — sign in, pick a vault folder, wait for the first sync.
//
// This used to be four separate components (LoginScreen / FolderPrompt /
// ProxyFolderPicker-as-modal / VaultLoadingScreen), each swapping in as a
// full "page" with its own icon, and the proxy folder browser popping up as
// a dark modal on top of FolderPrompt. It's now one shell (OnboardingFlow)
// that stays mounted across steps and just swaps its inner content, so
// picking a folder over the Apps Script proxy reads as the next step of the
// same page rather than a dialog stacked on another page.
// ---------------------------------------------------------------------------

// The folder-browsing UI for proxy mode (no OAuth token to hand the native
// Google Picker, so this browses via the Apps Script proxy's "browse"
// action instead). Used two places: inline as an onboarding step here, and
// as a modal later for "change vault folder" from within an open vault —
// `variant` controls which chrome wraps it.
function ProxyFolderBrowser({ token, onPick, onCancel, variant = 'inline' }) {
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

  const content = (
    <>
      {variant === 'modal' && <h3>Select vault folder</h3>}
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
          <button className="btn btn-neutral" disabled={!manualInput.trim() || resolving} onClick={handleUseManualId}>
            {resolving ? 'Checking…' : 'Use'}
          </button>
        </div>
        {resolveError && <p className="error-text">{resolveError}</p>}
      </div>
      <div className="modal-actions">
        {onCancel && (
          <button className="btn" onClick={onCancel}>
            Cancel
          </button>
        )}
        <button className="btn btn-neutral" onClick={() => onPick(current)}>
          Use "{current.name}"
        </button>
      </div>
    </>
  );

  if (variant === 'modal') {
    return (
      <div className="modal-overlay">
        <div className="modal">{content}</div>
      </div>
    );
  }
  return <div className="inline-folder-browser">{content}</div>;
}

// Derives the human label + percent for the loading step from a sync
// progress object — shared between the "opening" and "fetching content"
// moments so both go through the same OnboardingFlow step.
function loadingStepProps(progress) {
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
  return { label, pct };
}

// The single onboarding shell. `step` selects which content renders inside
// it; the shell itself (background, heading) never unmounts between steps.
function OnboardingFlow({
  step,
  onSignIn,
  ready,
  onSignInProxy,
  onPickFolder,
  proxyToken,
  onProxyFolderPick,
  loadingLabel,
  loadingPct
}) {
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
      <h1>Vault</h1>

      {step === 'signin' && (
        <>
          <button className="btn btn-neutral" disabled={!ready} onClick={onSignIn}>
            {ready ? 'Sign in with Google' : 'Loading…'}
          </button>
          {!showProxyForm ? (
            <button className="btn-secondary" onClick={() => setShowProxyForm(true)}>
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
              <button type="submit" className="btn btn-neutral">
                Connect
              </button>
            </form>
          )}
        </>
      )}

      {step === 'folder' && (
        <>
          <p className="muted">Pick the Google Drive folder that holds (or will hold) your notes.</p>
          <button className="btn btn-neutral" onClick={onPickFolder}>
            Select Drive folder
          </button>
        </>
      )}

      {step === 'proxy-folder' && (
        <ProxyFolderBrowser token={proxyToken} onPick={onProxyFolderPick} variant="inline" />
      )}

      {step === 'loading' && (
        <>
          <p className="muted">{loadingLabel}</p>
          <div className="progress-bar">
            <div
              className={`progress-bar-fill neutral ${loadingPct === null ? 'indeterminate' : ''}`}
              style={loadingPct !== null ? { width: `${loadingPct}%` } : undefined}
            />
          </div>
          {loadingPct !== null && <p className="muted small">{loadingPct}%</p>}
        </>
      )}
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
const ActivityBar = React.memo(function ActivityBar({ activeView, onSetView, onOpenGraph, onOpenCommandPalette, onSync, syncing, onChangeFolder, onSignOut, folderName }) {
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
        {item('toc', IconListTree, 'Outline')}
        {item('tags', IconTag, 'Tags')}
        {item('bookmarks', IconStar, 'Bookmarks')}
        <button className="activity-btn" onClick={onOpenGraph} title="Graph view" aria-label="Graph view">
          <IconGraph size={19} />
        </button>
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
});

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
        {tree.length === 0 && <p className="muted small empty-hint">Empty vault — use + to add a note.</p>}
        <div className={`root-drop-zone ${dragState.overId === vaultRootId ? 'drag-over' : ''}`} />
      </div>
    </div>
  );
});

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

const SearchPanel = React.memo(function SearchPanel({ query, setQuery, filesMeta, linkIndex, getBody, tagsByFileId, onOpenNote, indexing, ensureIndexed, indexVersion }) {
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [collapsed, setCollapsed] = useState(new Set());
  const [showHelp, setShowHelp] = useState(false);
  const [sortDesc, setSortDesc] = useState(false);
  const inputRef = useRef(null);

  // The heavy work here is runVaultSearch scanning every note body in the
  // vault — expensive enough on a large vault that running it on every
  // single keystroke causes visible input lag on mobile. The input itself
  // stays fully responsive (it's bound to `query`, updated synchronously by
  // the parent on every keystroke); only the actual search execution lags
  // ~150ms behind typing, which is imperceptible as "lag" but cuts the
  // number of full-vault scans for a fast typist by an order of magnitude.
  const [debouncedQuery, setDebouncedQuery] = useState(query);
  useEffect(() => {
    const t = setTimeout(() => setDebouncedQuery(query), 150);
    return () => clearTimeout(t);
  }, [query]);

  useEffect(() => {
    ensureIndexed();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const results = useMemo(() => {
    if (!debouncedQuery.trim()) return [];
    const effectiveGetBody = caseSensitive ? getBody : (id) => getBody(id);
    const r = runVaultSearch(debouncedQuery, filesMeta, linkIndex, effectiveGetBody, tagsByFileId);
    return sortDesc ? r.slice().reverse() : r;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debouncedQuery, filesMeta, linkIndex, getBody, tagsByFileId, sortDesc, caseSensitive, indexVersion]);

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
});

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
const TagsPanel = React.memo(function TagsPanel({ filesMeta, getBody, onOpenTag, indexing, ensureIndexed, indexVersion }) {
  useEffect(() => {
    ensureIndexed();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const tags = useMemo(() => buildTagIndex(filesMeta, getBody), [filesMeta, getBody, indexVersion]);
  const tagTree = useMemo(() => buildTagTree(tags), [tags]);

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
        {tagTree.length === 0 && (
          <p className="muted small empty-hint">No tags yet. Use #tag (or #parent/child for nested tags) anywhere in a note.</p>
        )}
        {tagTree.map(({ path, name, depth, count }) => (
          <button
            key={path}
            className="tag-row"
            style={{ paddingLeft: 10 + depth * 16 }}
            title={path}
            onClick={() => onOpenTag(path)}
          >
            <IconTag size={13} className="tag-row-icon" />
            <span className="tag-row-name">{name}</span>
            <span className="tag-row-count">{count}</span>
          </button>
        ))}
      </div>
    </div>
  );
});

// ---------------------------------------------------------------------------
// Bookmarks panel — a lightweight take on Obsidian's Bookmarks core plugin.
// ---------------------------------------------------------------------------
const BookmarksPanel = React.memo(function BookmarksPanel({ bookmarks, filesMeta, onOpenFile, onOpenImage, onToggleBookmark }) {
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
          const isAsset = !opensInEditorPane(f.kind);
          const AssetIcon = ASSET_KIND_ICONS[f.kind] || null;
          return (
            <div className="tree-row" key={f.id}>
              <button
                className="tree-item tree-file"
                onClick={() => (isAsset ? onOpenImage(f) : onOpenFile(f.id))}
              >
                <IconStarFilled size={12} className="bookmark-dot" />
                {AssetIcon && <AssetIcon className="tree-kind-icon" size={13} />}
                <span className="tree-label">{isAsset ? f.name : f.name.replace(/\.[^.]+$/i, '')}</span>
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
});

// ---------------------------------------------------------------------------
// Table of contents / outline panel — Obsidian-style, lists the active
// note's headings, indented by level, click to jump to that heading. Works
// in both edit and reading view via `onNavigate` (see EditorContent /
// App-level `activeEditorNav` for how the actual scrolling happens
// differently in each mode).
// ---------------------------------------------------------------------------
function extractHeadings(content) {
  const { body } = parseFrontmatter(content || '');
  const lines = body.split('\n');
  const headings = [];
  lines.forEach((line, lineIndex) => {
    const m = line.match(/^(#{1,6})\s+(.*)$/);
    if (!m) return;
    const level = Math.min(m[1].length, 6);
    const text = m[2].trim();
    const id = text.toLowerCase().replace(/[^a-z0-9]+/g, '-');
    headings.push({ level, text, id, lineIndex });
  });
  return headings;
}

const TocPanel = React.memo(function TocPanel({ file, content, onNavigate }) {
  const headings = useMemo(() => extractHeadings(content), [content]);
  if (!file) {
    return (
      <div className="side-panel">
        <div className="side-panel-header">
          <span className="side-panel-title">Outline</span>
        </div>
        <div className="side-panel-body">
          <p className="muted small empty-hint">Open a note to see its outline.</p>
        </div>
      </div>
    );
  }
  return (
    <div className="side-panel">
      <div className="side-panel-header">
        <span className="side-panel-title">Outline</span>
      </div>
      <div className="side-panel-body toc-panel-body">
        {headings.length === 0 && <p className="muted small empty-hint">No headings in this note yet.</p>}
        {headings.map((h, idx) => (
          <button
            key={`${h.id}-${idx}`}
            className="toc-row"
            style={{ paddingLeft: `${10 + (h.level - 1) * 14}px` }}
            onClick={() => onNavigate(h.lineIndex, h.id)}
            title={h.text}
          >
            {h.text || <span className="muted">Untitled heading</span>}
          </button>
        ))}
      </div>
    </div>
  );
});

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
          const label = file ? file.name.replace(/\.[^.]+$/i, '') : 'Untitled';
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
  const label = opensInEditorPane(file.kind) ? file.name.replace(/\.[^.]+$/i, '') : file.name;
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
        {file && file.kind === 'note' && (
          <button className="icon-btn" onClick={onToggleBookmark} title={isBookmarked ? 'Remove bookmark' : 'Bookmark note'}>
            {isBookmarked ? <IconStarFilled size={15} /> : <IconStar size={15} />}
          </button>
        )}
        {file && file.kind === 'note' && (
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
// Editor content — the CodeMirror 6 live-preview editor (source) or rendered
// preview for a single open tab. Mode is a per-tab property now, toggled
// from PaneHeader.
//
// ===========================================================================
// CodeMirror 6 live-preview editor
// ===========================================================================
// Replaces the old hand-rolled <textarea> + syntax-highlight overlay. Two
// layers of "WYSIWYG" live here:
//
//  1. Inline marks (**bold**, *italic*, [[wikilinks]], #tags, ==highlight==,
//     `code`) are decorated in place by `buildInlinePreviewPlugin`. Marker
//     characters are hidden on every line except the one the cursor is
//     currently on, so a token always drops back to raw, editable markdown
//     the moment you touch it — the same "line reveals its own source"
//     model Obsidian's Live Preview uses. Only `view.visibleRanges` are
//     scanned per update (not the whole note), so cost no longer scales
//     with note length the way the old full-note overlay did.
//
//  2. Block constructs that already have a full React renderer — callouts,
//     +++ toggles +++, :::columns-N:::, :::tabs:::, and pipe tables — are
//     swapped for an actual rendered block via `buildBlockWidgetPlugin`
//     whenever the cursor is outside them, reusing `renderMarkdownBlocks`
//     (same component reading view uses) rather than a second parser.
//     Tables get real inline-editable cells (`EditableMarkdownTable`);
//     everything else keeps its existing interactive bits (tab-switching,
//     toggle expand/collapse) because it's the *same* component tree
//     reading view already uses, just mounted as a widget. Clicking any
//     non-interactive part of a rendered block drops it back to raw
//     markdown for editing.
//
// Requires: codemirror, @codemirror/state, @codemirror/view,
// @codemirror/commands, @codemirror/autocomplete (all pulled in by the
// `codemirror` meta-package) — see the install note at the end of this file.
// ---------------------------------------------------------------------------
// Tab / Shift-Tab: indent-outdent whole lines touched by the selection.
// Ported 1:1 from the old textarea implementation's line-based indent so
// list nesting behaves identically.
function cmIndentSelection(view, outdent) {
  const { state } = view;
  const changes = [];
  const seenLines = new Set();
  for (const range of state.selection.ranges) {
    const startLine = state.doc.lineAt(range.from).number;
    const endLine = state.doc.lineAt(range.to).number;
    for (let ln = startLine; ln <= endLine; ln++) {
      if (seenLines.has(ln)) continue;
      seenLines.add(ln);
      const line = state.doc.line(ln);
      if (outdent) {
        const m = /^( {1,2}|\t)/.exec(line.text);
        if (m) changes.push({ from: line.from, to: line.from + m[0].length, insert: '' });
      } else {
        changes.push({ from: line.from, to: line.from, insert: '  ' });
      }
    }
  }
  if (changes.length) view.dispatch({ changes, scrollIntoView: true });
  return true;
}

// `- [ ]` / `- [x]` task checkboxes render as a real, always-clickable
// checkbox (not just on the cursor's line — Obsidian keeps these live at
// all times), toggling the underlying text directly.
class TaskCheckboxWidget extends WidgetType {
  constructor(checked) {
    super();
    this.checked = checked;
  }
  eq(other) {
    return other.checked === this.checked;
  }
  toDOM(view) {
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.checked = this.checked;
    box.className = 'cm-task-checkbox';
    box.setAttribute('data-cm-interactive', 'true');
    box.onmousedown = (e) => {
      e.preventDefault();
      const pos = view.posAtDOM(box);
      view.dispatch({ changes: { from: pos, to: pos + 1, insert: this.checked ? ' ' : 'x' } });
    };
    return box;
  }
  ignoreEvent() {
    return false;
  }
}

// Per-line inline decorations: heading sizing, marker-hiding for bold /
// italic / strike / highlight / code / wikilinks / tags / md-links, and the
// live checkbox widget above. Runs only over visible lines.
function buildInlinePreviewPlugin() {
  const MARK_RULES = [
    { re: /\*\*([^*\n]+)\*\*/g, markLen: 2, cls: 'cm-bold' },
    { re: /__([^_\n]+)__/g, markLen: 2, cls: 'cm-bold' },
    { re: /~~([^~\n]+)~~/g, markLen: 2, cls: 'cm-strike' },
    { re: /==([^=\n]+)==/g, markLen: 2, cls: 'cm-highlight' },
    { re: /`([^`\n]+)`/g, markLen: 1, cls: 'cm-inline-code' },
    { re: /(?<![*_\w])\*([^*\s][^*\n]*?)\*(?!\*)/g, markLen: 1, cls: 'cm-italic' },
    { re: /(?<![\w_])_([^_\s][^_\n]*?)_(?![\w_])/g, markLen: 1, cls: 'cm-italic' }
  ];

  // Every call pushes {from, to, deco, lineDeco} entries into `out` rather
  // than adding to the RangeSetBuilder directly — the builder requires
  // strictly ascending `from` across the *whole* document, but the several
  // regex passes below (wikilinks, md-links, tags, bold/italic/...) each
  // produce their own ascending-within-themselves sequence that isn't
  // ascending relative to each other. Collecting into a flat array and
  // sorting once before adding (see build(), below) satisfies the
  // builder's ordering requirement regardless of which rule fires where.
  function decorateLine(out, line, isActiveLine) {
    const text = line.text;

    // Heading: size the whole line, dim the leading hashes.
    const heading = /^(#{1,6})\s+/.exec(text);
    if (heading) {
      out.push({ from: line.from, to: line.from, deco: Decoration.line({ class: `cm-heading cm-heading-${heading[1].length}` }) });
      out.push({ from: line.from, to: line.from + heading[1].length + 1, deco: Decoration.mark({ class: 'cm-mark-dim' }) });
    }

    // Blockquote / callout marker.
    const quote = /^>\s?/.exec(text);
    if (quote) {
      out.push({ from: line.from, to: line.from + quote[0].length, deco: Decoration.mark({ class: 'cm-mark-dim' }) });
    }

    // Task checkbox — always live, regardless of cursor line.
    const task = /^(\s*(?:[-*+]\s+))\[( |x|X)\]/.exec(text);
    if (task) {
      const boxFrom = line.from + task[1].length;
      out.push({ from: boxFrom, to: boxFrom + 3, deco: Decoration.replace({ widget: new TaskCheckboxWidget(/[xX]/.test(task[2])) }) });
    }

    // Wikilinks / tags / md-links / bold / italic / etc. Hide marker chars
    // unless this is the active line, in which case just style them.
    const inlineFrom = task ? line.from + task[0].length : line.from;
    const inlineText = text.slice(inlineFrom - line.from);

    const wikiRe = /\[\[([^\]|\n]+)(\|([^\]\n]+))?\]\]/g;
    let m;
    while ((m = wikiRe.exec(inlineText))) {
      const from = inlineFrom + m.index;
      const targetLen = m[1].length;
      if (!isActiveLine) {
        out.push({ from, to: from + 2, deco: Decoration.replace({}) });
        out.push({ from: from + 2 + targetLen, to: from + m[0].length, deco: Decoration.replace({}) });
      } else {
        out.push({ from, to: from + 2, deco: Decoration.mark({ class: 'cm-mark-dim' }) });
        out.push({ from: from + m[0].length - 2, to: from + m[0].length, deco: Decoration.mark({ class: 'cm-mark-dim' }) });
      }
      out.push({ from: from + 2, to: from + 2 + targetLen, deco: Decoration.mark({ class: 'cm-wikilink' }) });
      if (m[2]) out.push({ from: from + 2 + targetLen + 1, to: from + m[0].length - 2, deco: Decoration.mark({ class: 'cm-wikilink' }) });
    }

    const mdLinkRe = /(?<!!)\[([^\]\n]+)\]\(([^)\n]+)\)/g;
    while ((m = mdLinkRe.exec(inlineText))) {
      const from = inlineFrom + m.index;
      const labelLen = m[1].length;
      if (!isActiveLine) {
        out.push({ from, to: from + 1, deco: Decoration.replace({}) });
        out.push({ from: from + 1 + labelLen, to: from + m[0].length, deco: Decoration.replace({}) });
      } else {
        out.push({ from, to: from + 1, deco: Decoration.mark({ class: 'cm-mark-dim' }) });
        out.push({ from: from + 1 + labelLen, to: from + m[0].length, deco: Decoration.mark({ class: 'cm-mark-dim' }) });
      }
      out.push({ from: from + 1, to: from + 1 + labelLen, deco: Decoration.mark({ class: 'cm-wikilink' }) });
    }

    const tagRe = /(^|[\s(])#([\w/-]+)/g;
    while ((m = tagRe.exec(inlineText))) {
      const from = inlineFrom + m.index + m[1].length;
      out.push({ from, to: from + 1 + m[2].length, deco: Decoration.mark({ class: 'cm-tag' }) });
    }

    for (const rule of MARK_RULES) {
      rule.re.lastIndex = 0;
      while ((m = rule.re.exec(inlineText))) {
        const from = inlineFrom + m.index;
        const to = from + m[0].length;
        if (!isActiveLine) {
          out.push({ from, to: from + rule.markLen, deco: Decoration.replace({}) });
          out.push({ from: to - rule.markLen, to, deco: Decoration.replace({}) });
        } else {
          out.push({ from, to: from + rule.markLen, deco: Decoration.mark({ class: 'cm-mark-dim' }) });
          out.push({ from: to - rule.markLen, to, deco: Decoration.mark({ class: 'cm-mark-dim' }) });
        }
        out.push({ from: from + rule.markLen, to: to - rule.markLen, deco: Decoration.mark({ class: rule.cls }) });
      }
    }
  }

  return ViewPlugin.fromClass(
    class {
      constructor(view) {
        this.decorations = this.build(view);
      }
      update(update) {
        if (update.docChanged || update.selectionSet || update.viewportChanged) {
          this.decorations = this.build(update.view);
        }
      }
      build(view) {
        const cursorLine = view.state.doc.lineAt(view.state.selection.main.head).number;
        const lines = [];
        for (const { from, to } of view.visibleRanges) {
          let pos = from;
          while (pos <= to) {
            const line = view.state.doc.lineAt(pos);
            lines.push(line);
            pos = line.to + 1;
          }
        }
        lines.sort((a, b) => a.from - b.from);
        const entries = [];
        for (const line of lines) {
          decorateLine(entries, line, line.number === cursorLine);
        }
        entries.sort((a, b) => a.from - b.from || a.to - b.to);
        const builder = new RangeSetBuilder();
        for (const e of entries) builder.add(e.from, e.to, e.deco);
        return builder.finish();
      }
    },
    { decorations: (v) => v.decorations }
  );
}

// ---------------------------------------------------------------------------
// Block-level WYSIWYG: tables, callouts, toggles, columns, tabs.
// ---------------------------------------------------------------------------

// Mirrors the block-detection rules in `renderMarkdownBlocks` (see the
// heading/quote/toggleOpen/columnsOpen/tabsOpen/isTableStart checks above)
// so a range found here always self-renders correctly when its raw text is
// handed to that function standalone.
function findWysiwygBlockRanges(lines) {
  const ranges = [];
  let i = 0;
  let inFence = false;
  while (i < lines.length) {
    const line = lines[i];
    const trimmed = line.trim();
    if (/^```/.test(trimmed)) {
      const lang = trimmed.slice(3).trim().toLowerCase();
      if (!inFence && (lang === 'query' || lang === 'dataview')) {
        let j = i + 1;
        while (j < lines.length && !/^```/.test(lines[j].trim())) j++;
        ranges.push({ startLine: i, endLine: Math.min(j, lines.length - 1), kind: 'query' });
        i = j + 1;
        continue;
      }
      inFence = !inFence;
      i++;
      continue;
    }
    if (inFence) {
      i++;
      continue;
    }
    if (/^>/.test(line)) {
      let j = i;
      while (j < lines.length && /^>/.test(lines[j])) j++;
      const first = lines[i].replace(/^>\s?/, '');
      if (/^\[![a-zA-Z]+\]/.test(first)) ranges.push({ startLine: i, endLine: j - 1, kind: 'callout' });
      i = j;
      continue;
    }
    if (/^\+\+\+\s?/.test(line) && trimmed !== '+++') {
      let j = i + 1;
      while (j < lines.length && lines[j].trim() !== '+++') j++;
      if (j < lines.length) {
        ranges.push({ startLine: i, endLine: j, kind: 'toggle' });
        i = j + 1;
        continue;
      }
    }
    const columnsOpen = trimmed.match(/^:::columns-([234])\s*$/);
    if (columnsOpen) {
      let j = i + 1;
      while (j < lines.length && lines[j].trim() !== ':::') j++;
      ranges.push({ startLine: i, endLine: Math.min(j, lines.length - 1), kind: 'columns' });
      i = j + 1;
      continue;
    }
    if (trimmed === ':::tabs') {
      let j = i + 1;
      while (j < lines.length && lines[j].trim() !== ':::') j++;
      ranges.push({ startLine: i, endLine: Math.min(j, lines.length - 1), kind: 'tabs' });
      i = j + 1;
      continue;
    }
    const isTableStart =
      !/^#{1,6}\s/.test(line) &&
      line.includes('|') &&
      trimmed !== '' &&
      i + 1 < lines.length &&
      isTableSeparatorRow(lines[i + 1]);
    if (isTableStart) {
      let j = i + 2;
      while (j < lines.length && lines[j].includes('|') && lines[j].trim() !== '') j++;
      ranges.push({ startLine: i, endLine: j - 1, kind: 'table' });
      i = j;
      continue;
    }
    i++;
  }
  return ranges;
}

function parseMarkdownTableRaw(raw) {
  const lines = raw.split('\n');
  const header = splitTableRow(lines[0]);
  const aligns = splitTableRow(lines[1] || '').map(tableColAlign);
  const rows = lines.slice(2).filter((l) => l.trim() !== '').map(splitTableRow);
  return { header, aligns, rows };
}

function buildMarkdownTableRaw({ header, aligns, rows }) {
  const alignMark = (a) => (a === 'center' ? ':---:' : a === 'right' ? '---:' : a === 'left' ? ':---' : '---');
  const escape = (s) => (s || '').replace(/\|/g, '\\|').replace(/\n/g, ' ');
  const headerLine = `| ${header.map(escape).join(' | ')} |`;
  const sepLine = `| ${header.map((_, i) => alignMark(aligns[i])).join(' | ')} |`;
  const bodyLines = rows.map((r) => `| ${header.map((_, i) => escape(r[i])).join(' | ')} |`);
  return [headerLine, sepLine, ...bodyLines].join('\n');
}

// Real inline-editable table — the flagship "WYSIWYG" ask. Every cell is a
// contentEditable span; on blur the whole table's markdown is rebuilt from
// the DOM and swapped into the document via `onCommit`, which the widget
// wires straight to a CodeMirror transaction (see MarkdownBlockWidget).
function EditableMarkdownTable({ raw, onCommit }) {
  const parsed = useMemo(() => parseMarkdownTableRaw(raw), [raw]);
  const commit = (next) => onCommit(buildMarkdownTableRaw(next));
  const setCell = (ri, ci, text) => {
    const rows = parsed.rows.map((r) => r.slice());
    while (rows[ri].length < parsed.header.length) rows[ri].push('');
    rows[ri][ci] = text;
    commit({ ...parsed, rows });
  };
  const setHeader = (ci, text) => {
    const header = parsed.header.slice();
    header[ci] = text;
    commit({ ...parsed, header });
  };
  const addRow = () => commit({ ...parsed, rows: [...parsed.rows, parsed.header.map(() => '')] });
  const addCol = () =>
    commit({
      header: [...parsed.header, 'Column'],
      aligns: [...parsed.aligns, null],
      rows: parsed.rows.map((r) => [...r, ''])
    });
  const delRow = (ri) => commit({ ...parsed, rows: parsed.rows.filter((_, i) => i !== ri) });
  const delCol = (ci) =>
    commit({
      header: parsed.header.filter((_, i) => i !== ci),
      aligns: parsed.aligns.filter((_, i) => i !== ci),
      rows: parsed.rows.map((r) => r.filter((_, i) => i !== ci))
    });
  const cycleAlign = (ci) => {
    const order = [null, 'center', 'right', 'left'];
    const next = order[(order.indexOf(parsed.aligns[ci] || null) + 1) % order.length];
    const aligns = parsed.aligns.slice();
    aligns[ci] = next;
    commit({ ...parsed, aligns });
  };
  const stopEnter = (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      e.currentTarget.blur();
    }
  };
  return (
    <table className="md-table cm-editable-table" data-cm-interactive="true">
      <thead>
        <tr>
          {parsed.header.map((h, ci) => (
            <th key={ci} style={parsed.aligns[ci] ? { textAlign: parsed.aligns[ci] } : undefined}>
              <span
                contentEditable
                suppressContentEditableWarning
                className="cm-table-cell-edit"
                onBlur={(e) => setHeader(ci, e.currentTarget.textContent)}
                onKeyDown={stopEnter}
              >
                {h}
              </span>
              <span className="cm-table-col-btns">
                <button type="button" title="Cycle alignment" onMouseDown={(e) => { e.preventDefault(); cycleAlign(ci); }}>
                  ⇔
                </button>
                <button type="button" title="Delete column" onMouseDown={(e) => { e.preventDefault(); delCol(ci); }}>
                  ×
                </button>
              </span>
            </th>
          ))}
          <th className="cm-table-add-col">
            <button type="button" title="Add column" onMouseDown={(e) => { e.preventDefault(); addCol(); }}>
              +
            </button>
          </th>
        </tr>
      </thead>
      <tbody>
        {parsed.rows.map((row, ri) => (
          <tr key={ri}>
            {parsed.header.map((_, ci) => (
              <td key={ci} style={parsed.aligns[ci] ? { textAlign: parsed.aligns[ci] } : undefined}>
                <span
                  contentEditable
                  suppressContentEditableWarning
                  className="cm-table-cell-edit"
                  onBlur={(e) => setCell(ri, ci, e.currentTarget.textContent)}
                  onKeyDown={stopEnter}
                >
                  {row[ci] ?? ''}
                </span>
              </td>
            ))}
            <td className="cm-table-row-btn">
              <button type="button" title="Delete row" onMouseDown={(e) => { e.preventDefault(); delRow(ri); }}>
                ×
              </button>
            </td>
          </tr>
        ))}
      </tbody>
      <tfoot>
        <tr>
          <td colSpan={parsed.header.length + 1}>
            <button type="button" className="cm-table-add-row" onMouseDown={(e) => { e.preventDefault(); addRow(); }}>
              + Add row
            </button>
          </td>
        </tr>
      </tfoot>
    </table>
  );
}

// A single rendered block, mounted as a CodeMirror block widget. Non-table
// blocks reuse `renderMarkdownBlocks` verbatim (the reading-view renderer),
// so toggle expand/collapse and tab-switching already work — their
// `onMutateBlock` calls are translated from block-relative text offsets
// into an absolute CodeMirror transaction here. Clicking anywhere that
// isn't itself interactive (`[data-cm-interactive]`) drops the block back
// to raw markdown for editing.
class MarkdownBlockWidget extends WidgetType {
  constructor(raw, from, to, keyBase, ctx, kind) {
    super();
    this.raw = raw;
    this.from = from;
    this.to = to;
    this.keyBase = keyBase;
    this.ctx = ctx;
    this.kind = kind;
  }
  eq(other) {
    return other.raw === this.raw && other.from === this.from && other.to === this.to && other.kind === this.kind;
  }
  toDOM() {
    const dom = document.createElement('div');
    dom.className = `cm-wysiwyg-block cm-wysiwyg-${this.kind}`;
    const root = createRoot(dom);
    this._root = root;

    const replaceRange = (from, to, insert) => {
      const view = this.ctx.getView();
      if (!view) return;
      view.dispatch({ changes: { from, to, insert } });
    };
    const onMutateBlock = (oldBlockText, newBlockText) => {
      const at = this.raw.indexOf(oldBlockText);
      if (at === -1) return;
      replaceRange(this.from + at, this.from + at + oldBlockText.length, newBlockText);
    };
    const revealRaw = (evt) => {
      if (evt.target.closest && evt.target.closest('[data-cm-interactive]')) return;
      const view = this.ctx.getView();
      if (!view) return;
      evt.preventDefault();
      view.dispatch({ selection: { anchor: this.from } });
      view.focus();
    };

    if (this.kind === 'table') {
      root.render(<EditableMarkdownTable raw={this.raw} onCommit={(newRaw) => replaceRange(this.from, this.to, newRaw)} />);
    } else {
      root.render(
        <div onMouseDown={revealRaw} className="cm-block-generic">
          {renderMarkdownBlocks(
            this.raw,
            { ...this.ctx.getHandlers(), onMutateBlock },
            this.ctx.getLinkIndex(),
            this.keyBase,
            this.ctx.getFoldState()
          )}
        </div>
      );
    }
    return dom;
  }
  destroy(dom) {
    const root = this._root;
    // Unmounting synchronously from inside CodeMirror's own DOM-update pass
    // triggers a React "cannot update a component while rendering" warning;
    // deferring one tick sidesteps it without any visible flicker.
    setTimeout(() => root && root.unmount(), 0);
  }
  ignoreEvent() {
    return true;
  }
}

function buildBlockWidgetPlugin(ctx) {
  return ViewPlugin.fromClass(
    class {
      constructor(view) {
        this.cachedText = null;
        this.cachedRanges = [];
        this.decorations = this.build(view);
      }
      update(update) {
        if (update.docChanged || update.selectionSet) {
          this.decorations = this.build(update.view);
        }
      }
      build(view) {
        const doc = view.state.doc;
        const text = doc.toString();
        if (text !== this.cachedText) {
          this.cachedText = text;
          this.cachedRanges = findWysiwygBlockRanges(text.split('\n'));
        }
        const sel = view.state.selection.main;
        const selStartLine = doc.lineAt(sel.from).number - 1;
        const selEndLine = doc.lineAt(sel.to).number - 1;
        const builder = new RangeSetBuilder();
        for (const r of this.cachedRanges) {
          if (selEndLine >= r.startLine && selStartLine <= r.endLine) continue; // cursor inside: show raw source
          const fromLine = doc.line(r.startLine + 1);
          const toLine = doc.line(r.endLine + 1);
          const raw = doc.sliceString(fromLine.from, toLine.to);
          const widget = new MarkdownBlockWidget(raw, fromLine.from, toLine.to, `cmblk-${r.startLine}-`, ctx, r.kind);
          builder.add(fromLine.from, toLine.to, Decoration.replace({ widget, block: true }));
        }
        return builder.finish();
      }
    },
    { decorations: (v) => v.decorations }
  );
}

// ---------------------------------------------------------------------------
// [[wikilink and #tag autocomplete, ported from the old textarea hooks onto
// CodeMirror's native completion API (handles positioning, keyboard nav,
// and dismissal for us — no more manual caret-coordinate math).
// ---------------------------------------------------------------------------
function wikilinkTagCompletionSource(ctx) {
  return (context) => {
    const wiki = context.matchBefore(/\[\[[^\]\n|]*$/);
    if (wiki) {
      const query = wiki.text.slice(2).toLowerCase();
      const pool = ctx.getLinkIndex().records.concat(ctx.getPhantomRecords() || []);
      const scoreOf = (hay) => (query ? hay.indexOf(query) : 0);
      let scored = pool.map((r) => ({ r, score: scoreOf(r.baseName.toLowerCase()) })).filter((s) => s.score !== -1);
      if (!scored.length) scored = pool.map((r) => ({ r, score: scoreOf(r.relativePath.toLowerCase()) })).filter((s) => s.score !== -1);
      const options = scored
        .sort((a, b) => a.score - b.score || a.r.baseName.localeCompare(b.r.baseName))
        .slice(0, 8)
        .map((s) => ({
          label: s.r.baseName,
          detail: s.r.isPhantom ? 'new' : s.r.relativePath !== s.r.baseName ? s.r.dir : undefined,
          apply: (view, completion, from, to) => {
            const insertText = bestLinkTextFor(s.r, ctx.getLinkIndex());
            const after = view.state.sliceDoc(to, to + 2) === ']]' ? to + 2 : to;
            view.dispatch({
              changes: { from, to: after, insert: `[[${insertText}]]` },
              selection: { anchor: from + insertText.length + 4 }
            });
          }
        }));
      if (!options.length) return null;
      return { from: wiki.from + 2, options, filter: false };
    }
    const tag = context.matchBefore(/(^|[\s(])#[\w/-]*$/);
    if (tag) {
      const hashIdx = tag.text.lastIndexOf('#');
      const query = tag.text.slice(hashIdx + 1).toLowerCase();
      const options = (ctx.getAllTags() || [])
        .filter((t) => t.toLowerCase().includes(query))
        .sort((a, b) => {
          const aStarts = a.toLowerCase().startsWith(query) ? 0 : 1;
          const bStarts = b.toLowerCase().startsWith(query) ? 0 : 1;
          return aStarts - bStarts || a.localeCompare(b);
        })
        .slice(0, 8)
        .map((t) => ({ label: `#${t}`, apply: `#${t}` }));
      if (!options.length) return null;
      return { from: tag.from + hashIdx, options, filter: false };
    }
    return null;
  };
}

// ---------------------------------------------------------------------------
// The editor component. Recreates its EditorState (and undo history) only
// when the open file changes — same page-per-note undo boundary the old
// custom undo hook had — and treats `content` as an externally-controlled
// value: doc replaces only happen when `content` changed for a reason other
// than this editor's own last edit, so external updates (initial load,
// rename-triggered reload) never fight the user's cursor.
// ---------------------------------------------------------------------------
function CodeMirrorNoteEditor({ fileId, content, onChange, linkIndex, phantomRecords, allTags, handlers, foldState, onSelectionChange, isActivePane, registerNav }) {
  const hostRef = useRef(null);
  const viewRef = useRef(null);
  const lastEmittedRef = useRef(content);
  const ctxRef = useRef(null);

  if (!ctxRef.current) {
    ctxRef.current = {
      getView: () => viewRef.current,
      getLinkIndex: () => linkIndex,
      getPhantomRecords: () => phantomRecords,
      getAllTags: () => allTags,
      getHandlers: () => handlers,
      getFoldState: () => foldState
    };
  }
  ctxRef.current.getLinkIndex = () => linkIndex;
  ctxRef.current.getPhantomRecords = () => phantomRecords;
  ctxRef.current.getAllTags = () => allTags;
  ctxRef.current.getHandlers = () => handlers;
  ctxRef.current.getFoldState = () => foldState;

  // (Re)create the editor whenever the open file changes.
  useEffect(() => {
    if (!hostRef.current) return undefined;
    const ctx = ctxRef.current;
    const state = EditorState.create({
      doc: content,
      extensions: [
        history(),
        drawSelection(),
        EditorView.lineWrapping,
        cmPlaceholder(
          'Start writing… [[Note Name]] to link, #tag to tag, > [!tip] for callouts, | tables |, +++ toggles +++, :::columns-2 for columns, :::tabs for a tab block.'
        ),
        autocompletion({ override: [wikilinkTagCompletionSource(ctx)], activateOnTyping: true }),
        buildBlockWidgetPlugin(ctx),
        buildInlinePreviewPlugin(),
        keymap.of([
          { key: 'Mod-z', run: cmUndo },
          { key: 'Mod-y', mac: 'Mod-Shift-z', run: cmRedo },
          { key: 'Tab', run: (v) => cmIndentSelection(v, false) },
          { key: 'Shift-Tab', run: (v) => cmIndentSelection(v, true) },
          ...completionKeymap,
          ...historyKeymap,
          ...defaultKeymap
        ]),
        EditorView.updateListener.of((update) => {
          if (update.docChanged) {
            const text = update.state.doc.toString();
            lastEmittedRef.current = text;
            onChange(text);
          }
          if (update.selectionSet) {
            const sel = update.state.selection.main;
            onSelectionChange?.(sel.from !== sel.to ? update.state.sliceDoc(sel.from, sel.to) : null);
          }
        }),
        EditorView.theme({
          '&': { height: '100%', fontSize: 'var(--editor-font-size, 15px)' },
          '.cm-scroller': { fontFamily: 'var(--editor-font-family, inherit)', lineHeight: '1.6' },
          '.cm-content': { padding: '0 0 40vh 0' }
        })
      ]
    });
    const view = new EditorView({ state, parent: hostRef.current });
    viewRef.current = view;

    if (registerNav) {
      registerNav({
        scrollToLine: (lineIndex) => {
          const ln = Math.min(view.state.doc.lines, lineIndex + 1);
          const line = view.state.doc.line(ln);
          view.dispatch({ selection: { anchor: line.from, head: line.to }, scrollIntoView: true });
          view.focus();
        }
      });
    }

    return () => {
      registerNav?.(null);
      view.destroy();
      viewRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fileId]);

  // External content changes (not originating from this editor's own last
  // dispatch) — e.g. switching tabs to a note whose content just finished
  // loading — get pushed in as a doc replace without touching undo history
  // semantics beyond what CodeMirror already does for a full-doc change.
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    if (content === lastEmittedRef.current) return;
    lastEmittedRef.current = content;
    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: content }
    });
  }, [content]);

  useEffect(() => {
    if (isActivePane) viewRef.current?.focus();
  }, [isActivePane, fileId]);

  return <div ref={hostRef} className="cm-editor-host" />;
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

function EditorContent({ file, content, onChange, linkIndex, phantomRecords, handlers, mode, loadingNote, backlinkIndex, allFiles, getBody, isActivePane }) {
  // Heading fold state (reading-view only), keyed by heading id, reset per
  // note so collapsing a section in one note doesn't leak into another.
  const [collapsedHeadings, setCollapsedHeadings] = useState(() => new Set());
  const collapsedHeadingsFileRef = useRef(file?.id);
  if (collapsedHeadingsFileRef.current !== file?.id) {
    collapsedHeadingsFileRef.current = file?.id;
    // Reset synchronously on file change (avoids a stale-collapse flash).
    if (collapsedHeadings.size) setCollapsedHeadings(new Set());
  }
  // Toggle-block collapse state (`+++ Title` ... `+++`), same per-note reset
  // rule and same "absent = expanded" convention as heading folds above.
  const [collapsedToggles, setCollapsedToggles] = useState(() => new Set());
  const collapsedTogglesFileRef = useRef(file?.id);
  if (collapsedTogglesFileRef.current !== file?.id) {
    collapsedTogglesFileRef.current = file?.id;
    if (collapsedToggles.size) setCollapsedToggles(new Set());
  }
  const foldState = useMemo(
    () => ({
      collapsed: collapsedHeadings,
      onToggle: (headingId) =>
        setCollapsedHeadings((prev) => {
          const next = new Set(prev);
          if (next.has(headingId)) next.delete(headingId);
          else next.add(headingId);
          return next;
        }),
      collapsedToggles,
      onToggleToggle: (toggleId) =>
        setCollapsedToggles((prev) => {
          const next = new Set(prev);
          if (next.has(toggleId)) next.delete(toggleId);
          else next.add(toggleId);
          return next;
        })
    }),
    [collapsedHeadings, collapsedToggles]
  );

  // Selection-based word/char count (status bar) only makes sense while
  // there's an actual editor selection to reflect — clear it whenever we
  // leave edit mode or switch notes, so the status bar doesn't keep
  // showing counts for a selection that no longer exists on screen.
  useEffect(() => {
    return () => handlers.onEditorSelectionChange?.(null);
  }, [file?.id, mode, handlers]);

  // Table-of-contents navigation bridge — registers a scroll-to-heading
  // function for this pane while it's the active one, so the Outline panel
  // can jump to a heading regardless of whether this pane is currently in
  // edit or reading view.
  const cmNavRef = useRef(null);
  useEffect(() => {
    if (!isActivePane || !file) return undefined;
    const scrollToHeading = (lineIndex, headingId) => {
      if (mode === 'edit') {
        cmNavRef.current?.scrollToLine(lineIndex);
      } else {
        const el = document.getElementById(headingId);
        el?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }
    };
    handlers.registerActiveEditorNav?.(scrollToHeading);
    return () => handlers.registerActiveEditorNav?.(null);
  }, [isActivePane, file, mode, handlers]);

  if (!file) {
    return (
      <div className="editor-empty">
        <p className="muted">Select a note, or click a [[wikilink]] to create one.</p>
      </div>
    );
  }

  if (file.kind === 'database') {
    return (
      <DatabaseView
        file={file}
        content={content}
        onChange={(value) => onChange(value)}
        handlers={handlers}
        linkIndex={linkIndex}
        loading={loadingNote}
      />
    );
  }

  if (file.kind === 'canvas') {
    return (
      <CanvasView
        file={file}
        content={content}
        onChange={(value) => onChange(value)}
        handlers={handlers}
        linkIndex={linkIndex}
        loading={loadingNote}
        allFiles={allFiles}
      />
    );
  }

  if (file.kind !== 'note') {
    return <AssetPane token={handlers.token} file={file} />;
  }

  const { properties, body } = parseFrontmatter(content);

  // Lets a block rendered from `body` (currently just the tabs block) push
  // an edit back to disk without knowing its own absolute position: it
  // hands back its exact original source text and its replacement, and
  // this finds-and-swaps that one substring within `body`, then reattaches
  // the untouched frontmatter prefix before saving. `body` is always the
  // tail of `content` (see parseFrontmatter), so slicing by length is safe.
  const onMutateBlock = (oldBlockText, newBlockText) => {
    const at = body.indexOf(oldBlockText);
    if (at === -1) return;
    const newBody = body.slice(0, at) + newBlockText + body.slice(at + oldBlockText.length);
    const prefixLen = content.length - body.length;
    onChange(content.slice(0, prefixLen) + newBody);
  };
  const readingHandlers = { ...handlers, onMutateBlock, getBody };

  return (
    <div className="editor-panes">
      {loadingNote && <div className="note-loading-bar" aria-hidden="true" />}
      {mode === 'edit' ? (
        <div className="editor-textarea-wrap">
          <NoteTitleField file={file} onRename={handlers.onRenameFile} />
          <CodeMirrorNoteEditor
            fileId={file.id}
            content={content}
            onChange={onChange}
            linkIndex={linkIndex}
            phantomRecords={phantomRecords}
            allTags={handlers.allTags || []}
            handlers={readingHandlers}
            foldState={foldState}
            isActivePane={isActivePane}
            onSelectionChange={handlers.onEditorSelectionChange}
            registerNav={(api) => {
              cmNavRef.current = api;
            }}
          />
        </div>
      ) : (
        <div className="editor-preview">
          <NoteTitleField file={file} onRename={handlers.onRenameFile} />
          <PropertiesPanel properties={properties} handlers={handlers} />
          {renderMarkdownBlocks(body, readingHandlers, linkIndex, '', foldState)}
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

function formatFileSize(bytes) {
  const n = Number(bytes);
  if (!n || Number.isNaN(n)) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

// Reading-view / tab-content pane for any non-note file, dispatching on
// kind. Video and audio get a real <video>/<audio> player; anything else
// (pdf, zip, docx, ...) gets a download prompt — Drive bytes are only ever
// pulled on demand here, same rule as images.
function AssetPane({ token, file }) {
  if (file.kind === 'image') return <EmbeddedImagePane token={token} file={file} />;
  const { url, error } = useDriveImageUrl(token, file.id);
  return (
    <div className="editor-preview image-pane">
      <h1 className="preview-title">{file.name}</h1>
      {error && <p className="muted small">{error}</p>}
      {!error && !url && <p className="muted small">Loading…</p>}
      {url && file.kind === 'video' && (
        <video src={url} controls className="asset-pane-video" />
      )}
      {url && file.kind === 'audio' && (
        <audio src={url} controls className="asset-pane-audio" />
      )}
      {url && file.kind === 'file' && (
        <div className="asset-pane-file">
          <IconFile size={40} />
          <p className="muted small">{formatFileSize(file.size)}</p>
          <a className="asset-download-btn" href={url} download={file.name}>
            <IconDownload size={14} /> Download
          </a>
        </div>
      )}
    </div>
  );
}

// ============================================================================
// Databases — Notion-style tables, stored as JSON inside a ".base" file.
// State shape is plain data (columns / rows / views); persistence is just
// "call onChange with a new JSON string", which flows through the exact
// same debounced Drive-save pipeline a note's textarea already uses (see
// ensureFileLoaded / saveNow in App). Nothing here ever touches IndexedDB
// directly — a database's body is just another buffer.
// ============================================================================
const DB_ROW_DND_MIME = 'application/x-vault-db-row';

const IconImage = (p) => (
  <Svg {...p}>
    <rect x="3" y="3" width="18" height="18" rx="2" />
    <circle cx="8.5" cy="8.5" r="1.5" />
    <path d="m21 15-5-5L5 21" />
  </Svg>
);
const IconExpand = (p) => (
  <Svg {...p}>
    <polyline points="15 3 21 3 21 9" />
    <polyline points="9 21 3 21 3 15" />
    <line x1="21" y1="3" x2="14" y2="10" />
    <line x1="3" y1="21" x2="10" y2="14" />
  </Svg>
);

function dbId(prefix) {
  return `${prefix}_${Math.random().toString(36).slice(2, 8)}${Date.now().toString(36).slice(-4)}`;
}

// Column type registry. `number_int`/`number_float` are kept as two
// distinct types (rather than one "Number" type with a format toggle) per
// SQL convention; `image`/`video`/`audio`/`file` are dedicated attachment
// types (each stores an array of {id, name} Drive file references) rather
// than one generic "file" type, so a Gallery view can tell an image column
// apart from a PDF column when picking a cover.
const DB_COLUMN_TYPES = {
  text: { label: 'Text', icon: IconType },
  text_multiline: { label: 'Multi-line text', icon: IconAlignLeft },
  number_int: { label: 'Number (integer)', icon: IconHash },
  number_float: { label: 'Number (decimal)', icon: IconHash },
  select: { label: 'Select', icon: IconChevronsUpDown },
  multi_select: { label: 'Multi-select / tags', icon: IconTags },
  date: { label: 'Date', icon: IconCalendar },
  checkbox: { label: 'Checkbox', icon: IconCheckSquare },
  url: { label: 'URL', icon: IconLink2 },
  image: { label: 'Image', icon: IconImage },
  video: { label: 'Video', icon: IconVideo },
  audio: { label: 'Audio', icon: IconAudio },
  file: { label: 'File', icon: IconPaperclip }
};
const DB_ATTACHMENT_TYPES = new Set(['image', 'video', 'audio', 'file']);
const DB_OPTION_COLORS = ['#8875e0', '#e0685f', '#e0a63d', '#6fcf97', '#4fa3e0', '#e07fc0', '#b0b0b0', '#5fc9c9'];

function dbEmptyValue(type) {
  if (type === 'checkbox') return false;
  if (type === 'multi_select' || DB_ATTACHMENT_TYPES.has(type)) return [];
  return null;
}

function dbMakeRow(columns) {
  const values = {};
  columns.forEach((c) => {
    values[c.id] = dbEmptyValue(c.type);
  });
  return { id: dbId('row'), values, createdAt: Date.now() };
}

function makeDefaultDatabaseState(title) {
  const nameCol = dbId('col');
  const statusCol = dbId('col');
  const tagsCol = dbId('col');
  const dueCol = dbId('col');
  const tableView = dbId('view');
  const boardView = dbId('view');
  const galleryView = dbId('view');
  const columns = [
    { id: nameCol, name: 'Name', type: 'text' },
    {
      id: statusCol,
      name: 'Status',
      type: 'select',
      options: [
        { id: dbId('opt'), label: 'Not started', color: '#b0b0b0' },
        { id: dbId('opt'), label: 'In progress', color: '#e0a63d' },
        { id: dbId('opt'), label: 'Done', color: '#6fcf97' }
      ]
    },
    { id: tagsCol, name: 'Tags', type: 'multi_select', options: [] },
    { id: dueCol, name: 'Due', type: 'date' }
  ];
  return {
    version: 1,
    title: title || 'Untitled database',
    columns,
    rows: [],
    views: [
      { id: tableView, name: 'Table', type: 'table' },
      { id: boardView, name: 'Board', type: 'board', groupByColumnId: statusCol },
      { id: galleryView, name: 'Gallery', type: 'gallery', coverColumnId: null }
    ],
    activeViewId: tableView
  };
}

// Tolerant parse: any malformed/foreign JSON just yields a fresh default
// database rather than crashing the pane — a `.base` file is never load-
// bearing enough to be worth a hard error screen.
function parseDatabaseContent(content) {
  if (!content || !content.trim()) return makeDefaultDatabaseState();
  try {
    const p = JSON.parse(content);
    if (!p || typeof p !== 'object' || !Array.isArray(p.columns)) return makeDefaultDatabaseState();
    const views = Array.isArray(p.views) && p.views.length ? p.views : [{ id: dbId('view'), name: 'Table', type: 'table' }];
    return {
      version: 1,
      title: p.title || 'Untitled database',
      columns: p.columns,
      rows: Array.isArray(p.rows) ? p.rows : [],
      views,
      activeViewId: p.activeViewId && views.some((v) => v.id === p.activeViewId) ? p.activeViewId : views[0].id
    };
  } catch {
    return makeDefaultDatabaseState();
  }
}

function serializeDatabaseState(state) {
  return JSON.stringify(state, null, 2);
}

// A dropdown-style popover, like DropdownMenu, but the panel does NOT close
// itself on every inner click — DropdownMenu's wrapper closes on any click
// bubble, which is right for a plain menu of buttons but wrong here, where
// panels contain text inputs (typing/clicking to focus would immediately
// dismiss them). Children get an explicit `close()` to call when a pick is
// actually made.
function DbPopover({ trigger, children, align = 'left', width }) {
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

  const toggle = useCallback((e) => {
    e?.stopPropagation();
    setOpen((v) => !v);
  }, []);
  const close = useCallback(() => setOpen(false), []);

  return (
    <span className="db-popover-wrap" ref={anchorRef}>
      {trigger(toggle, open)}
      {open &&
        pos &&
        createPortal(
          <div
            ref={menuRef}
            className="db-popover portal"
            style={{
              top: pos.top,
              ...(align === 'right' ? { right: pos.right } : { left: pos.left }),
              ...(width ? { width } : {})
            }}
            onClick={(e) => e.stopPropagation()}
          >
            {children(close)}
          </div>,
          document.body
        )}
    </span>
  );
}

// --- Per-type cell value editors --------------------------------------------

function DbTextCell({ value, onChange, multiline, dense }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value || '');
  const ref = useRef(null);
  useEffect(() => {
    if (!editing) setDraft(value || '');
  }, [value, editing]);
  useEffect(() => {
    if (editing) ref.current?.focus();
  }, [editing]);
  const commit = () => {
    setEditing(false);
    if (draft !== (value || '')) onChange(draft || null);
  };
  if (editing) {
    return multiline ? (
      <textarea
        ref={ref}
        className="db-cell-input db-cell-textarea"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            setDraft(value || '');
            setEditing(false);
          }
        }}
        rows={dense ? 2 : 6}
      />
    ) : (
      <input
        ref={ref}
        className="db-cell-input"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            commit();
          }
          if (e.key === 'Escape') {
            setDraft(value || '');
            setEditing(false);
          }
        }}
      />
    );
  }
  return (
    <div
      className={`db-cell-text ${!value ? 'empty' : ''} ${multiline ? 'multiline' : ''}`}
      onClick={(e) => {
        e.stopPropagation();
        setEditing(true);
      }}
    >
      {value || ''}
    </div>
  );
}

function DbNumberCell({ value, onChange, integer }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value === null || value === undefined ? '' : String(value));
  const ref = useRef(null);
  useEffect(() => {
    if (!editing) setDraft(value === null || value === undefined ? '' : String(value));
  }, [value, editing]);
  useEffect(() => {
    if (editing) ref.current?.focus();
  }, [editing]);
  const commit = () => {
    setEditing(false);
    const trimmed = draft.trim();
    if (trimmed === '') {
      if (value !== null) onChange(null);
      return;
    }
    const num = integer ? parseInt(trimmed, 10) : parseFloat(trimmed);
    if (Number.isNaN(num)) {
      setDraft(value === null || value === undefined ? '' : String(value));
      return;
    }
    if (num !== value) onChange(num);
  };
  if (editing) {
    return (
      <input
        ref={ref}
        type="number"
        step={integer ? '1' : 'any'}
        className="db-cell-input db-cell-number"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            commit();
          }
          if (e.key === 'Escape') setEditing(false);
        }}
      />
    );
  }
  return (
    <div
      className={`db-cell-text db-cell-number-display ${value === null || value === undefined ? 'empty' : ''}`}
      onClick={(e) => {
        e.stopPropagation();
        setEditing(true);
      }}
    >
      {value === null || value === undefined ? '' : value}
    </div>
  );
}

function DbCheckboxCell({ value, onChange }) {
  return (
    <button
      className={`db-checkbox ${value ? 'checked' : ''}`}
      onClick={(e) => {
        e.stopPropagation();
        onChange(!value);
      }}
    >
      {value && <IconCheck size={12} />}
    </button>
  );
}

function DbUrlCell({ value, onChange }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value || '');
  const ref = useRef(null);
  useEffect(() => {
    if (!editing) setDraft(value || '');
  }, [value, editing]);
  useEffect(() => {
    if (editing) ref.current?.focus();
  }, [editing]);
  const commit = () => {
    setEditing(false);
    if (draft !== (value || '')) onChange(draft || null);
  };
  if (editing) {
    return (
      <input
        ref={ref}
        className="db-cell-input"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            commit();
          }
          if (e.key === 'Escape') setEditing(false);
        }}
        placeholder="https://"
      />
    );
  }
  return (
    <div className="db-cell-url">
      {value ? (
        <>
          <a href={value} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()} className="db-url-link">
            {value}
          </a>
          <button
            className="db-cell-edit-btn"
            onClick={(e) => {
              e.stopPropagation();
              setEditing(true);
            }}
          >
            <IconEdit size={11} />
          </button>
        </>
      ) : (
        <div
          className="db-cell-text empty"
          onClick={(e) => {
            e.stopPropagation();
            setEditing(true);
          }}
        />
      )}
    </div>
  );
}

function DbDateCell({ value, onChange }) {
  return (
    <input
      type="date"
      className="db-cell-date"
      value={value || ''}
      onClick={(e) => e.stopPropagation()}
      onChange={(e) => onChange(e.target.value || null)}
    />
  );
}

function DbSelectCell({ value, onChange, column }) {
  const options = column.options || [];
  const current = options.find((o) => o.id === value) || null;
  return (
    <DbPopover
      trigger={(toggle) => (
        <button className="db-select-trigger" onClick={toggle}>
          {current ? (
            <span className="db-option-chip" style={{ '--chip-color': current.color }}>
              {current.label}
            </span>
          ) : (
            <span className="db-cell-text empty" />
          )}
        </button>
      )}
      width={200}
    >
      {(close) => (
        <div className="db-select-popover">
          {current && (
            <button
              className="db-popover-item db-clear-item"
              onClick={() => {
                onChange(null);
                close();
              }}
            >
              Clear
            </button>
          )}
          {options.map((o) => (
            <button
              key={o.id}
              className="db-popover-item"
              onClick={() => {
                onChange(o.id);
                close();
              }}
            >
              <span className="db-option-chip" style={{ '--chip-color': o.color }}>
                {o.label}
              </span>
              {o.id === value && <IconCheck size={12} />}
            </button>
          ))}
          {options.length === 0 && <div className="muted small db-popover-empty">No options yet — add some from Properties.</div>}
        </div>
      )}
    </DbPopover>
  );
}

function DbMultiSelectCell({ value, onChange, column, onCreateOption }) {
  const [filter, setFilter] = useState('');
  const options = column.options || [];
  const selected = new Set(value);
  const filtered = options.filter((o) => o.label.toLowerCase().includes(filter.toLowerCase()));
  const exactExists = options.some((o) => o.label.toLowerCase() === filter.trim().toLowerCase());
  return (
    <DbPopover
      trigger={(toggle) => (
        <button className="db-multiselect-trigger" onClick={toggle}>
          {value.length === 0 && <span className="db-cell-text empty" />}
          {options
            .filter((o) => selected.has(o.id))
            .map((o) => (
              <span key={o.id} className="db-option-chip" style={{ '--chip-color': o.color }}>
                {o.label}
              </span>
            ))}
        </button>
      )}
      width={220}
    >
      {() => (
        <div className="db-select-popover">
          <input
            className="db-popover-filter"
            placeholder="Search or create tag…"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            autoFocus
            onKeyDown={(e) => {
              if (e.key === 'Enter' && filter.trim() && !exactExists) {
                e.preventDefault();
                onCreateOption(filter.trim());
                setFilter('');
              }
            }}
          />
          <div className="db-popover-list">
            {filtered.map((o) => {
              const isSel = selected.has(o.id);
              return (
                <button
                  key={o.id}
                  className="db-popover-item"
                  onClick={() => onChange(isSel ? value.filter((id) => id !== o.id) : [...value, o.id])}
                >
                  <span className="db-option-chip" style={{ '--chip-color': o.color }}>
                    {o.label}
                  </span>
                  {isSel && <IconCheck size={12} />}
                </button>
              );
            })}
            {filter.trim() && !exactExists && (
              <button
                className="db-popover-item db-create-item"
                onClick={() => {
                  onCreateOption(filter.trim());
                  setFilter('');
                }}
              >
                <IconPlus size={12} /> Create "{filter.trim()}"
              </button>
            )}
            {options.length === 0 && !filter.trim() && (
              <div className="muted small db-popover-empty">Type to create the vault's first tag here.</div>
            )}
          </div>
        </div>
      )}
    </DbPopover>
  );
}

function DbAttachmentThumb({ fileId, token }) {
  const { url, error } = useDriveImageUrl(token, fileId);
  if (error) {
    return (
      <span className="db-attachment-thumb-error">
        <IconImageMissing size={12} />
      </span>
    );
  }
  return url ? <img src={url} className="db-attachment-thumb" alt="" /> : <span className="db-attachment-thumb loading" />;
}

function DbAttachmentCell({ value, onChange, type, dbFile, handlers }) {
  const inputRef = useRef(null);
  const accept = type === 'image' ? 'image/*' : type === 'video' ? 'video/*' : type === 'audio' ? 'audio/*' : undefined;
  const parentId = dbFile?.parents?.[0];
  const [busy, setBusy] = useState(false);
  const typeLabel = DB_COLUMN_TYPES[type]?.label.toLowerCase() || 'file';

  const handleFiles = async (files) => {
    if (!files.length || !parentId) return;
    setBusy(true);
    try {
      const uploaded = [];
      for (const f of files) {
        const rec = await handlers.uploadAttachment(parentId, f);
        uploaded.push({ id: rec.id, name: rec.name });
      }
      onChange([...value, ...uploaded]);
    } catch (err) {
      window.alert(`Couldn't upload: ${err.message}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <DbPopover
      trigger={(toggle) => (
        <button className="db-attachment-trigger" onClick={toggle}>
          {value.length === 0 ? (
            <span className="db-cell-text empty" />
          ) : type === 'image' ? (
            <span className="db-attachment-thumbs">
              {value.slice(0, 3).map((att) => (
                <DbAttachmentThumb key={att.id} fileId={att.id} token={handlers.token} />
              ))}
              {value.length > 3 && <span className="db-attachment-more">+{value.length - 3}</span>}
            </span>
          ) : (
            <span className="db-attachment-chips">
              {value.slice(0, 2).map((att) => (
                <span key={att.id} className="db-file-chip-mini">
                  <IconPaperclip size={10} /> {att.name}
                </span>
              ))}
              {value.length > 2 && <span className="db-attachment-more">+{value.length - 2}</span>}
            </span>
          )}
        </button>
      )}
      width={240}
    >
      {() => (
        <div className="db-attachment-popover">
          {value.map((att) => (
            <div key={att.id} className="db-attachment-row">
              {type === 'image' && <DbAttachmentThumb fileId={att.id} token={handlers.token} />}
              <span className="db-attachment-name" onClick={() => handlers.onOpenAsset({ id: att.id, name: att.name })}>
                {att.name}
              </span>
              <button className="db-attachment-remove" onClick={() => onChange(value.filter((a) => a.id !== att.id))}>
                <IconX size={12} />
              </button>
            </div>
          ))}
          {value.length === 0 && <div className="muted small db-popover-empty">No {typeLabel} attached yet.</div>}
          <button className="db-attachment-add" disabled={busy || !parentId} onClick={() => inputRef.current?.click()}>
            {busy ? <IconLoader size={13} /> : <IconUpload size={13} />} Upload {typeLabel}
          </button>
          <input
            ref={inputRef}
            type="file"
            multiple
            accept={accept}
            style={{ display: 'none' }}
            onChange={(e) => {
              const files = Array.from(e.target.files || []);
              e.target.value = '';
              handleFiles(files);
            }}
          />
        </div>
      )}
    </DbPopover>
  );
}

// Single dispatcher used by both the dense table cell and the full-width
// row-detail panel — same editing UI, just different container CSS (see
// `dense`).
function DbCell({ column, value, onChange, dbFile, handlers, dense, onCreateOption }) {
  switch (column.type) {
    case 'text':
      return <DbTextCell value={value} onChange={onChange} multiline={false} dense={dense} />;
    case 'text_multiline':
      return <DbTextCell value={value} onChange={onChange} multiline dense={dense} />;
    case 'number_int':
      return <DbNumberCell value={value} onChange={onChange} integer />;
    case 'number_float':
      return <DbNumberCell value={value} onChange={onChange} />;
    case 'select':
      return <DbSelectCell value={value} onChange={onChange} column={column} />;
    case 'multi_select':
      return <DbMultiSelectCell value={value || []} onChange={onChange} column={column} onCreateOption={onCreateOption} />;
    case 'date':
      return <DbDateCell value={value} onChange={onChange} />;
    case 'checkbox':
      return <DbCheckboxCell value={!!value} onChange={onChange} />;
    case 'url':
      return <DbUrlCell value={value} onChange={onChange} />;
    case 'image':
    case 'video':
    case 'audio':
    case 'file':
      return <DbAttachmentCell value={value || []} onChange={onChange} type={column.type} dbFile={dbFile} handlers={handlers} />;
    default:
      return <span className="db-cell-empty">—</span>;
  }
}

// --- Card property previews (Board / Gallery) -------------------------------

function DbCardPropPreview({ column, value }) {
  if (column.type === 'select') {
    const opt = (column.options || []).find((o) => o.id === value);
    if (!opt) return null;
    return (
      <span className="db-option-chip small" style={{ '--chip-color': opt.color }}>
        {opt.label}
      </span>
    );
  }
  if (column.type === 'multi_select') {
    const opts = (column.options || []).filter((o) => (value || []).includes(o.id));
    if (!opts.length) return null;
    return (
      <span className="db-card-prop-tags">
        {opts.map((o) => (
          <span key={o.id} className="db-option-chip small" style={{ '--chip-color': o.color }}>
            {o.label}
          </span>
        ))}
      </span>
    );
  }
  if (column.type === 'date') {
    if (!value) return null;
    return (
      <span className="db-card-prop-date">
        <IconCalendar size={10} /> {value}
      </span>
    );
  }
  return null;
}

// --- Table view --------------------------------------------------------------

function DbTableView({ state, updateRowValue, addRow, deleteRow, onOpenRow, onCreateOption, dbFile, handlers, onManageColumns }) {
  return (
    <div className="db-table-scroll">
      <table className="db-table">
        <thead>
          <tr>
            <th className="db-th-expand" />
            {state.columns.map((col) => {
              const Icon = DB_COLUMN_TYPES[col.type]?.icon;
              return (
                <th key={col.id} className="db-th">
                  {Icon && <Icon size={12} className="db-th-icon" />}
                  <span>{col.name}</span>
                </th>
              );
            })}
            <th className="db-th-add">
              <button className="db-add-col-btn" onClick={onManageColumns} title="Add property">
                <IconPlus size={14} />
              </button>
            </th>
          </tr>
        </thead>
        <tbody>
          {state.rows.map((row) => (
            <tr key={row.id} className="db-tr">
              <td className="db-td-expand">
                <button className="db-expand-btn" onClick={() => onOpenRow(row.id)} title="Open">
                  <IconExpand size={11} />
                </button>
              </td>
              {state.columns.map((col) => (
                <td key={col.id} className="db-td">
                  <DbCell
                    column={col}
                    value={row.values[col.id]}
                    onChange={(v) => updateRowValue(row.id, col.id, v)}
                    dbFile={dbFile}
                    handlers={handlers}
                    dense
                    onCreateOption={(label) => onCreateOption(col.id, row.id, label, col.type === 'multi_select')}
                  />
                </td>
              ))}
              <td className="db-td-actions">
                <button className="db-row-delete" onClick={() => deleteRow(row.id)} title="Delete row">
                  <IconTrash size={12} />
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <button className="db-add-row-btn" onClick={addRow}>
        <IconPlus size={13} /> New
      </button>
      {state.rows.length === 0 && <p className="muted small db-empty-hint">No rows yet.</p>}
    </div>
  );
}

// --- Board view ----------------------------------------------------------------

function DbGroupByPicker({ columns, onPick }) {
  const selectCols = columns.filter((c) => c.type === 'select');
  if (!selectCols.length) return <p className="muted small">Add a Select property first, from Properties.</p>;
  return (
    <div className="db-groupby-pick-list">
      {selectCols.map((c) => (
        <button key={c.id} className="db-popover-item" onClick={() => onPick(c.id)}>
          {c.name}
        </button>
      ))}
    </div>
  );
}

function DbCardCover({ fileId, token }) {
  return (
    <div className="db-card-cover">
      <DbAttachmentThumb fileId={fileId} token={token} />
    </div>
  );
}

function DbBoardColumn({ bucket, rows, groupColId, columns, rowTitle, onOpenRow, onDropRow, onAddRow, onDeleteRow, coverColumn, token }) {
  const [dragOver, setDragOver] = useState(false);
  const previewCols = columns.filter((c) => c.id !== groupColId && (c.type === 'multi_select' || c.type === 'select' || c.type === 'date')).slice(0, 3);
  return (
    <div
      className={`db-board-col ${dragOver ? 'drag-over' : ''}`}
      onDragOver={(e) => {
        e.preventDefault();
        setDragOver(true);
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDragOver(false);
        const rowId = e.dataTransfer.getData(DB_ROW_DND_MIME);
        if (rowId) onDropRow(rowId);
      }}
    >
      <div className="db-board-col-header">
        <span className="db-option-chip" style={{ '--chip-color': bucket.color }}>
          {bucket.label}
        </span>
        <span className="db-board-col-count">{rows.length}</span>
      </div>
      <div className="db-board-col-body">
        {rows.map((row) => (
          <div
            key={row.id}
            className="db-board-card"
            draggable
            onDragStart={(e) => {
              e.dataTransfer.setData(DB_ROW_DND_MIME, row.id);
              e.dataTransfer.effectAllowed = 'move';
            }}
            onClick={() => onOpenRow(row.id)}
          >
            {coverColumn && (row.values[coverColumn.id] || [])[0] && (
              <DbCardCover fileId={row.values[coverColumn.id][0].id} token={token} />
            )}
            <div className="db-board-card-title">{rowTitle(row)}</div>
            <div className="db-board-card-props">
              {previewCols.map((c) => (
                <DbCardPropPreview key={c.id} column={c} value={row.values[c.id]} />
              ))}
            </div>
            <button
              className="db-board-card-delete"
              onClick={(e) => {
                e.stopPropagation();
                onDeleteRow(row.id);
              }}
            >
              <IconX size={11} />
            </button>
          </div>
        ))}
        <button className="db-board-add-card" onClick={onAddRow}>
          <IconPlus size={12} /> New
        </button>
      </div>
    </div>
  );
}

function DbBoardView({ state, view, updateRowValue, addRow, onOpenRow, rowTitle, deleteRow, onChangeGroupBy, token }) {
  const groupCol = state.columns.find((c) => c.id === view.groupByColumnId && c.type === 'select');
  if (!groupCol) {
    return (
      <div className="db-board-empty">
        <p className="muted small">Pick a Select property to group this board by.</p>
        <DbGroupByPicker columns={state.columns} onPick={onChangeGroupBy} />
      </div>
    );
  }
  const buckets = [{ id: null, label: 'No status', color: '#767676' }, ...groupCol.options.map((o) => ({ id: o.id, label: o.label, color: o.color }))];
  const rowsByBucket = new Map(buckets.map((b) => [b.id, []]));
  state.rows.forEach((row) => {
    const v = row.values[groupCol.id] || null;
    if (!rowsByBucket.has(v)) rowsByBucket.set(v, []);
    rowsByBucket.get(v).push(row);
  });
  const coverColumn = state.columns.find((c) => c.id === view.coverColumnId && c.type === 'image');

  return (
    <div className="db-board">
      {buckets.map((bucket) => (
        <DbBoardColumn
          key={String(bucket.id)}
          bucket={bucket}
          rows={rowsByBucket.get(bucket.id) || []}
          groupColId={groupCol.id}
          columns={state.columns}
          rowTitle={rowTitle}
          onOpenRow={onOpenRow}
          onDropRow={(rowId) => updateRowValue(rowId, groupCol.id, bucket.id)}
          onAddRow={() => onOpenRow(addRow({ [groupCol.id]: bucket.id }))}
          onDeleteRow={deleteRow}
          coverColumn={coverColumn}
          token={token}
        />
      ))}
    </div>
  );
}

// --- Gallery view --------------------------------------------------------------

function DbGalleryView({ state, view, onOpenRow, rowTitle, addRow, handlers }) {
  const coverColumn = state.columns.find((c) => c.id === view.coverColumnId && c.type === 'image');
  const previewCols = state.columns.filter((c) => c.type === 'select' || c.type === 'multi_select').slice(0, 2);
  return (
    <div className="db-gallery">
      <div className="db-gallery-grid">
        {state.rows.map((row) => {
          const cover = coverColumn ? (row.values[coverColumn.id] || [])[0] : null;
          return (
            <div key={row.id} className="db-gallery-card" onClick={() => onOpenRow(row.id)}>
              <div className="db-gallery-cover">
                {cover ? (
                  <DbAttachmentThumb fileId={cover.id} token={handlers.token} />
                ) : (
                  <div className="db-gallery-cover-placeholder">
                    <IconDatabase size={22} />
                  </div>
                )}
              </div>
              <div className="db-gallery-title">{rowTitle(row)}</div>
              <div className="db-gallery-props">
                {previewCols.map((c) => (
                  <DbCardPropPreview key={c.id} column={c} value={row.values[c.id]} />
                ))}
              </div>
            </div>
          );
        })}
        <button className="db-gallery-add" onClick={addRow}>
          <IconPlus size={16} /> New
        </button>
      </div>
      {!coverColumn && state.columns.some((c) => c.type === 'image') && (
        <p className="muted small db-empty-hint">Pick an Image property as the cover from this view's menu.</p>
      )}
    </div>
  );
}

// --- Row detail panel (Notion-style "open page") --------------------------

function DbRowDetailModal({ row, columns, onClose, onChangeValue, onDelete, handlers, linkIndex, dbFile, onCreateOption }) {
  const previewCol = columns.find((c) => c.type === 'text_multiline');
  return (
    <div className="modal-overlay db-row-modal-overlay" onClick={onClose}>
      <div className="db-row-modal" onClick={(e) => e.stopPropagation()}>
        <div className="db-row-modal-header">
          <button className="icon-btn" onClick={onClose} title="Close">
            <IconX size={16} />
          </button>
          <button className="db-row-delete-btn" onClick={onDelete}>
            <IconTrash size={13} /> Delete
          </button>
        </div>
        <div className="db-row-modal-body">
          {columns.map((col) => {
            const Icon = DB_COLUMN_TYPES[col.type]?.icon;
            return (
              <div key={col.id} className="db-row-prop">
                <div className="db-row-prop-label">
                  {Icon && <Icon size={12} />}
                  <span>{col.name}</span>
                </div>
                <div className="db-row-prop-value">
                  <DbCell
                    column={col}
                    value={row.values[col.id]}
                    onChange={(v) => onChangeValue(col.id, v)}
                    dbFile={dbFile}
                    handlers={handlers}
                    onCreateOption={(label) => onCreateOption(col.id, row.id, label, col.type === 'multi_select')}
                  />
                </div>
              </div>
            );
          })}
        </div>
        {previewCol && (
          <div className="db-row-modal-preview">
            <div className="db-row-prop-label">
              <IconEye size={12} />
              <span>Preview</span>
            </div>
            <div className="db-row-preview-body">{renderInline(row.values[previewCol.id] || '', 'dbprev', handlers, linkIndex)}</div>
          </div>
        )}
      </div>
    </div>
  );
}

// --- Property (column) management modal -------------------------------------

function DbOptionsEditor({ options, onChange }) {
  const [draft, setDraft] = useState('');
  const addOption = () => {
    const label = draft.trim();
    if (!label) return;
    onChange([...options, { id: dbId('opt'), label, color: DB_OPTION_COLORS[options.length % DB_OPTION_COLORS.length] }]);
    setDraft('');
  };
  return (
    <div className="db-options-editor">
      {options.map((o) => (
        <div key={o.id} className="db-option-editor-row">
          <span className="db-option-chip" style={{ '--chip-color': o.color }}>
            {o.label}
          </span>
          <span className="db-option-color-swatches">
            {DB_OPTION_COLORS.map((c) => (
              <button
                key={c}
                className={`db-color-swatch ${o.color === c ? 'active' : ''}`}
                style={{ '--swatch-color': c }}
                onClick={() => onChange(options.map((opt) => (opt.id === o.id ? { ...opt, color: c } : opt)))}
              />
            ))}
          </span>
          <button className="db-option-remove" onClick={() => onChange(options.filter((opt) => opt.id !== o.id))}>
            <IconX size={11} />
          </button>
        </div>
      ))}
      <div className="db-option-add-row">
        <input
          className="db-popover-filter"
          placeholder="Add option"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              addOption();
            }
          }}
        />
        <button className="db-option-add-btn" onClick={addOption}>
          <IconPlus size={12} />
        </button>
      </div>
    </div>
  );
}

function DbColumnEditorRow({ column, onUpdate, onDelete, onMoveUp, onMoveDown }) {
  const [name, setName] = useState(column.name);
  useEffect(() => setName(column.name), [column.name]);
  const Icon = DB_COLUMN_TYPES[column.type]?.icon;
  const hasOptions = column.type === 'select' || column.type === 'multi_select';
  return (
    <div className="db-column-editor-row">
      <div className="db-column-editor-main">
        <span className="db-reorder-btns">
          <button disabled={!onMoveUp} onClick={onMoveUp} title="Move up">
            <IconChevronDown size={11} style={{ transform: 'rotate(180deg)' }} />
          </button>
          <button disabled={!onMoveDown} onClick={onMoveDown} title="Move down">
            <IconChevronDown size={11} />
          </button>
        </span>
        {Icon && <Icon size={13} className="db-column-editor-icon" />}
        <input
          className="db-column-name-input"
          value={name}
          onChange={(e) => setName(e.target.value)}
          onBlur={() => {
            const t = name.trim();
            if (t && t !== column.name) onUpdate({ name: t });
            else setName(column.name);
          }}
        />
        <span className="db-column-type-label">{DB_COLUMN_TYPES[column.type]?.label}</span>
        <button className="db-column-delete-btn" onClick={onDelete} title="Delete property">
          <IconTrash size={13} />
        </button>
      </div>
      {hasOptions && <DbOptionsEditor options={column.options || []} onChange={(options) => onUpdate({ options })} />}
    </div>
  );
}

function DbManageColumnsModal({ columns, onClose, onAdd, onUpdate, onDelete, onReorder }) {
  const [newName, setNewName] = useState('');
  const [newType, setNewType] = useState('text');
  return (
    <div className="modal-overlay db-manage-overlay" onClick={onClose}>
      <div className="db-manage-modal" onClick={(e) => e.stopPropagation()}>
        <div className="db-manage-header">
          <span>Properties</span>
          <button className="icon-btn" onClick={onClose}>
            <IconX size={15} />
          </button>
        </div>
        <div className="db-manage-list">
          {columns.map((col, i) => (
            <DbColumnEditorRow
              key={col.id}
              column={col}
              onUpdate={(patch) => onUpdate(col.id, patch)}
              onDelete={() => {
                if (window.confirm(`Delete property "${col.name}"? This removes it from every row.`)) onDelete(col.id);
              }}
              onMoveUp={i > 0 ? () => onReorder(col.id, -1) : null}
              onMoveDown={i < columns.length - 1 ? () => onReorder(col.id, 1) : null}
            />
          ))}
        </div>
        <div className="db-manage-add">
          <input
            className="db-popover-filter"
            placeholder="New property name"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && newName.trim()) {
                const col = { id: dbId('col'), name: newName.trim(), type: newType };
                if (newType === 'select' || newType === 'multi_select') col.options = [];
                onAdd(col);
                setNewName('');
              }
            }}
          />
          <select className="db-type-select" value={newType} onChange={(e) => setNewType(e.target.value)}>
            {Object.entries(DB_COLUMN_TYPES).map(([type, meta]) => (
              <option key={type} value={type}>
                {meta.label}
              </option>
            ))}
          </select>
          <button
            className="db-manage-add-btn"
            onClick={() => {
              if (!newName.trim()) return;
              const col = { id: dbId('col'), name: newName.trim(), type: newType };
              if (newType === 'select' || newType === 'multi_select') col.options = [];
              onAdd(col);
              setNewName('');
            }}
          >
            <IconPlus size={13} /> Add property
          </button>
        </div>
      </div>
    </div>
  );
}

// --- View tabs / title -------------------------------------------------------

function DbTitleField({ title, onRename }) {
  const [draft, setDraft] = useState(title);
  useEffect(() => setDraft(title), [title]);
  return (
    <input
      className="db-title-input"
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => {
        const t = draft.trim() || 'Untitled database';
        setDraft(t);
        if (t !== title) onRename(t);
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter') e.currentTarget.blur();
      }}
      placeholder="Untitled database"
    />
  );
}

const DB_VIEW_TYPE_ICONS = { table: IconTable, board: IconKanban, gallery: IconLayoutGrid };

function DbViewTab({ view, active, onSelect, onRename, onDelete, columns, onChangeGroupBy, onChangeCover }) {
  const ViewIcon = DB_VIEW_TYPE_ICONS[view.type] || IconTable;
  const [renaming, setRenaming] = useState(false);
  const [draft, setDraft] = useState(view.name);
  return (
    <div className={`db-view-tab ${active ? 'active' : ''}`}>
      <button className="db-view-tab-btn" onClick={onSelect}>
        <ViewIcon size={13} />
        {renaming ? (
          <input
            className="db-view-rename-input"
            autoFocus
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onClick={(e) => e.stopPropagation()}
            onBlur={() => {
              setRenaming(false);
              const t = draft.trim();
              if (t && t !== view.name) onRename(t);
              else setDraft(view.name);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') e.currentTarget.blur();
            }}
          />
        ) : (
          <span>{view.name}</span>
        )}
      </button>
      <DbPopover
        trigger={(toggle) => (
          <button
            className="db-view-tab-menu"
            onClick={(e) => {
              e.stopPropagation();
              toggle(e);
            }}
          >
            <IconChevronDown size={11} />
          </button>
        )}
        width={200}
      >
        {(close) => (
          <div className="db-view-settings-popover">
            <button
              className="db-popover-item"
              onClick={() => {
                setRenaming(true);
                close();
              }}
            >
              <IconEdit size={13} /> Rename
            </button>
            {view.type === 'board' && (
              <>
                <div className="db-popover-section-label">Group by</div>
                {columns
                  .filter((c) => c.type === 'select')
                  .map((c) => (
                    <button
                      key={c.id}
                      className="db-popover-item"
                      onClick={() => {
                        onChangeGroupBy(c.id);
                        close();
                      }}
                    >
                      {c.name} {c.id === view.groupByColumnId && <IconCheck size={12} />}
                    </button>
                  ))}
                {columns.filter((c) => c.type === 'select').length === 0 && (
                  <div className="muted small db-popover-empty">No Select properties yet.</div>
                )}
              </>
            )}
            {view.type === 'gallery' && (
              <>
                <div className="db-popover-section-label">Cover image</div>
                <button
                  className="db-popover-item"
                  onClick={() => {
                    onChangeCover(null);
                    close();
                  }}
                >
                  None {!view.coverColumnId && <IconCheck size={12} />}
                </button>
                {columns
                  .filter((c) => c.type === 'image')
                  .map((c) => (
                    <button
                      key={c.id}
                      className="db-popover-item"
                      onClick={() => {
                        onChangeCover(c.id);
                        close();
                      }}
                    >
                      {c.name} {c.id === view.coverColumnId && <IconCheck size={12} />}
                    </button>
                  ))}
              </>
            )}
            {onDelete && (
              <button
                className="db-popover-item danger"
                onClick={() => {
                  onDelete();
                  close();
                }}
              >
                <IconTrash size={13} /> Delete view
              </button>
            )}
          </div>
        )}
      </DbPopover>
    </div>
  );
}

function DbAddViewButton({ onAdd }) {
  const [name, setName] = useState('');
  return (
    <DbPopover
      trigger={(toggle) => (
        <button className="db-add-view-btn" onClick={toggle} title="Add view">
          <IconPlus size={13} />
        </button>
      )}
      width={200}
    >
      {(close) => (
        <div className="db-add-view-popover">
          <input className="db-popover-filter" placeholder="View name" value={name} onChange={(e) => setName(e.target.value)} autoFocus />
          {[
            { type: 'table', label: 'Table', icon: IconTable },
            { type: 'board', label: 'Board', icon: IconKanban },
            { type: 'gallery', label: 'Gallery', icon: IconLayoutGrid }
          ].map((opt) => (
            <button
              key={opt.type}
              className="db-popover-item"
              onClick={() => {
                onAdd(opt.type, name.trim() || opt.label);
                setName('');
                close();
              }}
            >
              <opt.icon size={13} /> {opt.label}
            </button>
          ))}
        </div>
      )}
    </DbPopover>
  );
}

// --- Top-level database pane -------------------------------------------------

function DatabaseView({ file, content, onChange, handlers, linkIndex, loading }) {
  // Parsed/edited locally (like a form), not re-derived from `content` on
  // every render — LeafPane remounts this component (key={file.id}) on file
  // switch, so `content` is only ever read here at mount. Every mutation
  // pushes a fresh JSON string up through `onChange`, which flows into the
  // same buffer + debounced-save pipeline a note's textarea uses.
  const [state, setState] = useState(() => parseDatabaseContent(content));
  const [openRowId, setOpenRowId] = useState(null);
  const [managePropsOpen, setManagePropsOpen] = useState(false);

  const commit = useCallback(
    (updater) => {
      setState((prev) => {
        const next = typeof updater === 'function' ? updater(prev) : updater;
        onChange(serializeDatabaseState(next));
        return next;
      });
    },
    [onChange]
  );

  if (loading) {
    return (
      <div className="db-loading">
        <IconLoader size={18} /> Loading database…
      </div>
    );
  }

  const activeView = state.views.find((v) => v.id === state.activeViewId) || state.views[0];

  const addColumn = (col) => commit((s) => ({ ...s, columns: [...s.columns, col] }));
  const updateColumn = (colId, patch) => commit((s) => ({ ...s, columns: s.columns.map((c) => (c.id === colId ? { ...c, ...patch } : c)) }));
  const deleteColumn = (colId) =>
    commit((s) => ({
      ...s,
      columns: s.columns.filter((c) => c.id !== colId),
      rows: s.rows.map((r) => {
        const v = { ...r.values };
        delete v[colId];
        return { ...r, values: v };
      }),
      views: s.views.map((v) =>
        v.groupByColumnId === colId ? { ...v, groupByColumnId: null } : v.coverColumnId === colId ? { ...v, coverColumnId: null } : v
      )
    }));
  const reorderColumn = (colId, dir) =>
    commit((s) => {
      const idx = s.columns.findIndex((c) => c.id === colId);
      const swapWith = idx + dir;
      if (idx === -1 || swapWith < 0 || swapWith >= s.columns.length) return s;
      const cols = s.columns.slice();
      const tmp = cols[idx];
      cols[idx] = cols[swapWith];
      cols[swapWith] = tmp;
      return { ...s, columns: cols };
    });

  const addRow = (presetValues) => {
    const row = dbMakeRow(state.columns);
    if (presetValues) Object.assign(row.values, presetValues);
    commit((s) => ({ ...s, rows: [...s.rows, row] }));
    return row.id;
  };
  const updateRowValue = (rowId, colId, value) =>
    commit((s) => ({
      ...s,
      rows: s.rows.map((r) => (r.id === rowId ? { ...r, values: { ...r.values, [colId]: value }, updatedAt: Date.now() } : r))
    }));
  const deleteRow = (rowId) => commit((s) => ({ ...s, rows: s.rows.filter((r) => r.id !== rowId) }));
  const addOptionAndSetValue = (colId, rowId, label, multi) =>
    commit((s) => {
      const col = s.columns.find((c) => c.id === colId);
      if (!col) return s;
      const newOpt = { id: dbId('opt'), label, color: DB_OPTION_COLORS[(col.options || []).length % DB_OPTION_COLORS.length] };
      const columns = s.columns.map((c) => (c.id === colId ? { ...c, options: [...(c.options || []), newOpt] } : c));
      const rows = s.rows.map((r) => {
        if (r.id !== rowId) return r;
        const prevVal = r.values[colId];
        const nextVal = multi ? [...(prevVal || []), newOpt.id] : newOpt.id;
        return { ...r, values: { ...r.values, [colId]: nextVal } };
      });
      return { ...s, columns, rows };
    });

  const addView = (type, name) =>
    commit((s) => {
      const view = { id: dbId('view'), name, type };
      if (type === 'board') view.groupByColumnId = s.columns.find((c) => c.type === 'select')?.id || null;
      if (type === 'gallery') view.coverColumnId = s.columns.find((c) => c.type === 'image')?.id || null;
      return { ...s, views: [...s.views, view], activeViewId: view.id };
    });
  const updateView = (viewId, patch) => commit((s) => ({ ...s, views: s.views.map((v) => (v.id === viewId ? { ...v, ...patch } : v)) }));
  const deleteView = (viewId) =>
    commit((s) => {
      if (s.views.length <= 1) return s;
      const views = s.views.filter((v) => v.id !== viewId);
      return { ...s, views, activeViewId: s.activeViewId === viewId ? views[0].id : s.activeViewId };
    });
  const setActiveView = (viewId) => commit((s) => ({ ...s, activeViewId: viewId }));
  const renameTitle = (title) => commit((s) => ({ ...s, title }));

  const firstTextColumnId = (state.columns.find((c) => c.type === 'text') || state.columns[0])?.id;
  const rowTitle = (row) => {
    const v = firstTextColumnId ? row.values[firstTextColumnId] : null;
    return (v && String(v).trim()) || 'Untitled';
  };

  const openRow = state.rows.find((r) => r.id === openRowId) || null;

  return (
    <div className="db-view">
      <div className="db-header">
        <IconDatabase size={20} className="db-header-icon" />
        <DbTitleField title={state.title} onRename={renameTitle} />
      </div>
      <div className="db-view-tabs">
        {state.views.map((v) => (
          <DbViewTab
            key={v.id}
            view={v}
            active={v.id === activeView.id}
            onSelect={() => setActiveView(v.id)}
            onRename={(name) => updateView(v.id, { name })}
            onDelete={state.views.length > 1 ? () => deleteView(v.id) : null}
            columns={state.columns}
            onChangeGroupBy={(colId) => updateView(v.id, { groupByColumnId: colId })}
            onChangeCover={(colId) => updateView(v.id, { coverColumnId: colId })}
          />
        ))}
        <DbAddViewButton onAdd={addView} />
        <div className="db-toolbar-spacer" />
        <button className="db-manage-btn" onClick={() => setManagePropsOpen(true)}>
          <IconSliders size={13} /> Properties
        </button>
        <button className="db-new-row-btn" onClick={() => setOpenRowId(addRow())}>
          <IconPlus size={14} /> New
        </button>
      </div>

      {activeView.type === 'table' && (
        <DbTableView
          state={state}
          updateRowValue={updateRowValue}
          addRow={() => addRow()}
          deleteRow={deleteRow}
          onOpenRow={setOpenRowId}
          onCreateOption={addOptionAndSetValue}
          dbFile={file}
          handlers={handlers}
          onManageColumns={() => setManagePropsOpen(true)}
        />
      )}
      {activeView.type === 'board' && (
        <DbBoardView
          state={state}
          view={activeView}
          updateRowValue={updateRowValue}
          addRow={addRow}
          onOpenRow={setOpenRowId}
          rowTitle={rowTitle}
          deleteRow={deleteRow}
          onChangeGroupBy={(colId) => updateView(activeView.id, { groupByColumnId: colId })}
          token={handlers.token}
        />
      )}
      {activeView.type === 'gallery' && (
        <DbGalleryView state={state} view={activeView} onOpenRow={setOpenRowId} rowTitle={rowTitle} addRow={() => addRow()} handlers={handlers} />
      )}

      {managePropsOpen && (
        <DbManageColumnsModal
          columns={state.columns}
          onClose={() => setManagePropsOpen(false)}
          onAdd={addColumn}
          onUpdate={updateColumn}
          onDelete={deleteColumn}
          onReorder={reorderColumn}
        />
      )}

      {openRow && (
        <DbRowDetailModal
          row={openRow}
          columns={state.columns}
          onClose={() => setOpenRowId(null)}
          onChangeValue={(colId, value) => updateRowValue(openRow.id, colId, value)}
          onDelete={() => {
            deleteRow(openRow.id);
            setOpenRowId(null);
          }}
          handlers={handlers}
          linkIndex={linkIndex}
          dbFile={file}
          onCreateOption={addOptionAndSetValue}
        />
      )}
    </div>
  );
}

// ============================================================================
// CANVAS BOARD — an Obsidian-style infinite canvas, stored as JSON inside a
// ".canvas" file. Same "just JSON through the debounced Drive-save pipeline"
// approach as the Database section above (see the file-format note at
// CANVAS_EXTENSIONS near the top of this file). Schema:
//
//   { nodes: [
//       { id, type:'text',  x,y,width,height, color, text },
//       { id, type:'file',  x,y,width,height, color, file: <driveFileId> },
//       { id, type:'link',  x,y,width,height, color, url },
//       { id, type:'group', x,y,width,height, color, label }
//     ],
//     edges: [ { id, fromNode, fromSide, toNode, toSide, color, label } ] }
//
// Performance notes (see also the mobile/perf pass elsewhere in this file):
//  - Node drag/resize never calls `onChange` per pixel. Live movement is
//    tracked in a `liveOverrides` Map, batched to one state update per
//    animation frame (see scheduleLiveOverrides), and only merged into the
//    real (persisted) state — one single onChange/save — on pointer-up.
//  - A plain click (pointerdown+up with no real movement) never touches
//    state at all, so opening a canvas and clicking around doesn't spam
//    Drive with saves.
// ============================================================================
const CANVAS_MIN_W = 120;
const CANVAS_MIN_H = 60;
const CANVAS_COLORS = ['#e0555a', '#e0a63d', '#d8c34a', '#6fcf97', '#4fb0c6', '#9b7fd1'];
const CANVAS_ZOOM_MIN = 0.1;
const CANVAS_ZOOM_MAX = 3;
const CANVAS_MOVE_THRESHOLD = 3; // world px before a pointerdown counts as a drag, not a click

function makeDefaultCanvasState() {
  return { nodes: [], edges: [] };
}

// Tolerant parse: malformed/foreign JSON just yields a fresh empty canvas
// rather than crashing the pane, same convention as parseDatabaseContent.
function parseCanvasContent(content) {
  if (!content || !content.trim()) return makeDefaultCanvasState();
  try {
    const p = JSON.parse(content);
    const nodes = Array.isArray(p?.nodes)
      ? p.nodes.filter((n) => n && n.id && n.type).map((n) => ({
          width: CANVAS_MIN_W,
          height: CANVAS_MIN_H,
          x: 0,
          y: 0,
          ...n
        }))
      : [];
    const edges = Array.isArray(p?.edges) ? p.edges.filter((e) => e && e.id && e.fromNode && e.toNode) : [];
    return { nodes, edges };
  } catch {
    return makeDefaultCanvasState();
  }
}

function serializeCanvasState(state) {
  return JSON.stringify({ nodes: state.nodes, edges: state.edges }, null, 2);
}

function canvasNodeRect(node) {
  return {
    left: node.x,
    top: node.y,
    right: node.x + node.width,
    bottom: node.y + node.height,
    cx: node.x + node.width / 2,
    cy: node.y + node.height / 2
  };
}

function canvasSideAnchor(node, side) {
  const r = canvasNodeRect(node);
  if (side === 'top') return { x: r.cx, y: r.top };
  if (side === 'bottom') return { x: r.cx, y: r.bottom };
  if (side === 'left') return { x: r.left, y: r.cy };
  return { x: r.right, y: r.cy };
}

function canvasOppositeSide(side) {
  return side === 'top' ? 'bottom' : side === 'bottom' ? 'top' : side === 'left' ? 'right' : 'left';
}

// Whichever side of `node` is closest to world point `pt` — used when an
// edge is dropped onto a node's body rather than one of its 4 dots.
function canvasNearestSide(node, pt) {
  const r = canvasNodeRect(node);
  const d = { top: Math.abs(pt.y - r.top), bottom: Math.abs(pt.y - r.bottom), left: Math.abs(pt.x - r.left), right: Math.abs(pt.x - r.right) };
  return Object.keys(d).reduce((a, b) => (d[a] <= d[b] ? a : b));
}

function canvasHitTest(nodes, pt, excludeId) {
  for (let i = nodes.length - 1; i >= 0; i--) {
    const n = nodes[i];
    if (n.id === excludeId || n.type === 'group') continue;
    if (pt.x >= n.x && pt.x <= n.x + n.width && pt.y >= n.y && pt.y <= n.y + n.height) return n;
  }
  return null;
}

// A gently-curved connector (Obsidian-style): control points are pulled
// straight out from each anchor along its side's normal, so the curve
// always leaves/arrives perpendicular to the card it's attached to.
function canvasEdgePath(from, fromSide, to, toSide) {
  const pull = Math.max(30, Math.min(140, Math.hypot(to.x - from.x, to.y - from.y) / 2));
  const off = (side) => (side === 'top' ? { x: 0, y: -pull } : side === 'bottom' ? { x: 0, y: pull } : side === 'left' ? { x: -pull, y: 0 } : { x: pull, y: 0 });
  const o1 = off(fromSide);
  const o2 = off(toSide);
  return `M ${from.x} ${from.y} C ${from.x + o1.x} ${from.y + o1.y}, ${to.x + o2.x} ${to.y + o2.y}, ${to.x} ${to.y}`;
}

function CanvasToolbar({ zoom, onZoomIn, onZoomOut, onZoomReset, onFitToContent, onAddText, onAddFile, onAddLink, onAddGroup }) {
  return (
    <div className="canvas-toolbar">
      <div className="canvas-toolbar-group">
        <button className="icon-btn" title="Add text card" onClick={onAddText}>
          <IconStickyNote size={15} />
        </button>
        <button className="icon-btn" title="Embed a vault file" onClick={onAddFile}>
          <IconFile size={15} />
        </button>
        <button className="icon-btn" title="Add web link card" onClick={onAddLink}>
          <IconLink2 size={15} />
        </button>
        <button className="icon-btn" title="Add group" onClick={onAddGroup}>
          <IconFrame size={15} />
        </button>
      </div>
      <div className="canvas-toolbar-group">
        <button className="icon-btn" title="Zoom out" onClick={onZoomOut}>
          <IconZoomOut size={15} />
        </button>
        <button className="canvas-zoom-pct" onClick={onZoomReset} title="Reset zoom to 100%">
          {Math.round(zoom * 100)}%
        </button>
        <button className="icon-btn" title="Zoom in" onClick={onZoomIn}>
          <IconZoomIn size={15} />
        </button>
        <button className="icon-btn" title="Zoom to fit" onClick={onFitToContent}>
          <IconMaximize size={15} />
        </button>
      </div>
    </div>
  );
}

// A vault-file search/pick list, reused for "embed a file" — deliberately
// tiny (no fuzzy scoring) since PaletteModal already owns the fuzzy switcher.
function CanvasFilePickerModal({ files, onPick, onClose }) {
  const [q, setQ] = useState('');
  const filtered = useMemo(() => {
    const query = q.trim().toLowerCase();
    const list = query ? files.filter((f) => f.name.toLowerCase().includes(query)) : files;
    return list.slice(0, 200);
  }, [files, q]);
  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal canvas-file-picker" onClick={(e) => e.stopPropagation()}>
        <div className="help-modal-header">
          <h3>Embed a file</h3>
          <button className="icon-btn" onClick={onClose} aria-label="Close">
            <IconX size={16} />
          </button>
        </div>
        <input autoFocus className="canvas-file-picker-input" placeholder="Search vault files…" value={q} onChange={(e) => setQ(e.target.value)} />
        <div className="canvas-file-picker-list">
          {filtered.map((f) => {
            const Icon = ASSET_KIND_ICONS[f.kind] || IconFile;
            return (
              <button key={f.id} className="canvas-file-picker-row" onClick={() => onPick(f)}>
                <Icon size={14} />
                <span>{opensInEditorPane(f.kind) ? f.name.replace(/\.[^.]+$/i, '') : f.name}</span>
              </button>
            );
          })}
          {!filtered.length && (
            <div className="muted small" style={{ padding: '10px 12px' }}>
              No files found.
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// Live content for a `file`-type node — dispatches on the embedded file's
// kind, reusing the exact same on-demand-fetch components notes already use
// for inline embeds (ImageEmbed / VideoEmbed / AudioEmbed), so a canvas
// never duplicates that fetch/caching logic.
function CanvasFileNodeContent({ node, allFilesById, handlers, linkIndex }) {
  const meta = allFilesById.get(node.file);
  if (!meta) return <div className="canvas-embed-missing muted small">Missing or deleted file</div>;
  if (meta.kind === 'image') {
    return (
      <div className="canvas-embed canvas-embed-image">
        <ImageEmbed token={handlers.token} fileId={meta.id} name={meta.name} onOpen={() => handlers.onOpenById(meta.id)} />
      </div>
    );
  }
  if (meta.kind === 'video') {
    return (
      <div className="canvas-embed canvas-embed-media">
        <VideoEmbed token={handlers.token} fileId={meta.id} name={meta.name} />
      </div>
    );
  }
  if (meta.kind === 'audio') {
    return (
      <div className="canvas-embed canvas-embed-media">
        <AudioEmbed token={handlers.token} fileId={meta.id} name={meta.name} />
      </div>
    );
  }
  if (meta.kind === 'note') {
    const body = handlers.getBody ? handlers.getBody(meta.id) : '';
    const parsed = parseFrontmatter(body || '');
    return (
      <div className="canvas-embed canvas-embed-note">
        <div className="canvas-embed-title">{meta.name.replace(/\.[^.]+$/i, '')}</div>
        <div className="canvas-embed-note-body">
          {parsed.body ? renderMarkdownBlocks(parsed.body, handlers, linkIndex, node.id) : <span className="muted small">Empty note</span>}
        </div>
      </div>
    );
  }
  return (
    <div className="canvas-embed canvas-embed-file" onDoubleClick={() => handlers.onOpenAsset?.(meta)}>
      <IconFile size={26} />
      <span className="muted small">{meta.name}</span>
    </div>
  );
}

function CanvasEdgesLayer({ nodes, edges, selectedEdgeId, connecting, onSelectEdge, onDoubleClickEdge }) {
  const nodesById = useMemo(() => new Map(nodes.map((n) => [n.id, n])), [nodes]);
  return (
    <svg className="canvas-edges-svg">
      <defs>
        <marker id="canvas-arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
          <path d="M 0 0 L 10 5 L 0 10 z" className="canvas-arrowhead" />
        </marker>
      </defs>
      {edges.map((e) => {
        const from = nodesById.get(e.fromNode);
        const to = nodesById.get(e.toNode);
        if (!from || !to) return null;
        const fromSide = e.fromSide || 'right';
        const toSide = e.toSide || 'left';
        const fromPt = canvasSideAnchor(from, fromSide);
        const toPt = canvasSideAnchor(to, toSide);
        const d = canvasEdgePath(fromPt, fromSide, toPt, toSide);
        return (
          <g key={e.id} className="canvas-edge-group">
            <path
              d={d}
              className="canvas-edge-hit"
              onClick={(ev) => {
                ev.stopPropagation();
                onSelectEdge(e.id);
              }}
              onDoubleClick={(ev) => {
                ev.stopPropagation();
                onDoubleClickEdge(e.id);
              }}
            />
            <path
              d={d}
              className={`canvas-edge ${selectedEdgeId === e.id ? 'selected' : ''}`}
              style={e.color ? { stroke: e.color } : undefined}
              markerEnd="url(#canvas-arrow)"
            />
            {e.label && (
              <text x={(fromPt.x + toPt.x) / 2} y={(fromPt.y + toPt.y) / 2 - 6} textAnchor="middle" className="canvas-edge-label">
                {e.label}
              </text>
            )}
          </g>
        );
      })}
      {connecting && (
        <path
          d={canvasEdgePath(connecting.fromPt, connecting.fromSide, connecting.toPt, canvasOppositeSide(connecting.fromSide))}
          className="canvas-edge canvas-edge-preview"
        />
      )}
    </svg>
  );
}

// Memoized: CanvasView re-renders on every pan/zoom/hover-state change, but
// individual card props are usually unchanged, so most nodes should bail
// out of re-rendering rather than re-diff their (sometimes note-preview-
// rendering) contents on every frame of an unrelated node's drag.
const CanvasNode = React.memo(function CanvasNode({
  node,
  selected,
  hovered,
  editing,
  allFilesById,
  handlers,
  linkIndex,
  onPointerDownBody,
  onPointerDownResize,
  onPointerDownDot,
  onDoubleClick,
  onHoverChange,
  onCommitEdit
}) {
  const isGroup = node.type === 'group';
  const style = { left: node.x, top: node.y, width: node.width, height: node.height };
  if (node.color) style.borderColor = node.color;
  return (
    <div
      className={`canvas-node canvas-node-${node.type} ${selected ? 'selected' : ''}`}
      style={style}
      onPointerEnter={() => onHoverChange(node.id)}
      onPointerLeave={() => onHoverChange(null)}
      onDoubleClick={(e) => onDoubleClick(e, node)}
    >
      {isGroup ? (
        <div className="canvas-group-label" style={node.color ? { color: node.color } : undefined} onPointerDown={(e) => onPointerDownBody(e, node)}>
          {node.label || 'Group'}
        </div>
      ) : (
        <div className="canvas-node-body" onPointerDown={(e) => onPointerDownBody(e, node)}>
          {node.type === 'text' &&
            (editing ? (
              <textarea
                autoFocus
                className="canvas-text-editor"
                defaultValue={node.text || ''}
                placeholder="Type markdown…"
                onPointerDown={(e) => e.stopPropagation()}
                onFocus={(e) => {
                  const v = e.target.value;
                  e.target.value = '';
                  e.target.value = v;
                }}
                onBlur={(e) => onCommitEdit(node.id, e.target.value)}
                onKeyDown={(e) => {
                  e.stopPropagation();
                  if (e.key === 'Escape') e.target.blur();
                }}
              />
            ) : (
              <div className="canvas-text-render">
                {node.text ? renderMarkdownBlocks(node.text, handlers, linkIndex, node.id) : <span className="muted small">Double-click to edit</span>}
              </div>
            ))}
          {node.type === 'file' && <CanvasFileNodeContent node={node} allFilesById={allFilesById} handlers={handlers} linkIndex={linkIndex} />}
          {node.type === 'link' && (
            <a className="canvas-link-card" href={node.url} target="_blank" rel="noreferrer" draggable={false}>
              <IconLink2 size={14} />
              <span>{node.url}</span>
            </a>
          )}
        </div>
      )}
      {!isGroup && (selected || hovered) && !editing && (
        <>
          <span className="canvas-dot canvas-dot-top" onPointerDown={(e) => onPointerDownDot(e, node, 'top')} />
          <span className="canvas-dot canvas-dot-right" onPointerDown={(e) => onPointerDownDot(e, node, 'right')} />
          <span className="canvas-dot canvas-dot-bottom" onPointerDown={(e) => onPointerDownDot(e, node, 'bottom')} />
          <span className="canvas-dot canvas-dot-left" onPointerDown={(e) => onPointerDownDot(e, node, 'left')} />
        </>
      )}
      {selected && <span className="canvas-resize-handle" onPointerDown={(e) => onPointerDownResize(e, node)} />}
    </div>
  );
});

function CanvasView({ file, content, onChange, handlers, linkIndex, loading, allFiles }) {
  const [state, setState] = useState(() => parseCanvasContent(content));
  const [viewport, setViewport] = useState({ x: 0, y: 0, zoom: 1 });
  const [selectedIds, setSelectedIds] = useState(() => new Set());
  const [selectedEdgeId, setSelectedEdgeId] = useState(null);
  const [hoveredId, setHoveredId] = useState(null);
  const [editingId, setEditingId] = useState(null);
  const [liveOverrides, setLiveOverrides] = useState(null);
  const [marquee, setMarquee] = useState(null);
  const [connecting, setConnecting] = useState(null);
  const [filePickerOpen, setFilePickerOpen] = useState(false);
  const [spaceDown, setSpaceDown] = useState(false);
  const [isPanning, setIsPanning] = useState(false);

  const containerRef = useRef(null);
  const dragRef = useRef(null);
  const rafRef = useRef(null);
  const pendingOverridesRef = useRef(null);
  const pointersRef = useRef(new Map());
  const loadedOnceRef = useRef(!loading);

  // The buffer starts empty while Drive is still fetching content (see
  // ensureFileLoaded in App) — this component mounts once per open tab, so
  // it re-syncs its local state the first time real content actually
  // arrives, then leaves local edits alone from then on (same "local state
  // is the source of truth once loaded" rule DatabaseView uses).
  useEffect(() => {
    if (!loading && !loadedOnceRef.current) {
      loadedOnceRef.current = true;
      setState(parseCanvasContent(content));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loading]);

  const commit = useCallback(
    (updater) => {
      setState((prev) => {
        const next = typeof updater === 'function' ? updater(prev) : updater;
        onChange(serializeCanvasState(next));
        return next;
      });
    },
    [onChange]
  );

  const allFilesById = useMemo(() => new Map((allFiles || []).map((f) => [f.id, f])), [allFiles]);

  const nodesForRender = useMemo(() => {
    if (!liveOverrides) return state.nodes;
    return state.nodes.map((n) => (liveOverrides.has(n.id) ? { ...n, ...liveOverrides.get(n.id) } : n));
  }, [state.nodes, liveOverrides]);

  const scheduleLiveOverrides = useCallback((map) => {
    pendingOverridesRef.current = map;
    if (rafRef.current) return;
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = null;
      setLiveOverrides(pendingOverridesRef.current);
    });
  }, []);

  useEffect(() => () => rafRef.current && cancelAnimationFrame(rafRef.current), []);

  const screenToWorld = useCallback(
    (sx, sy) => {
      const rect = containerRef.current.getBoundingClientRect();
      return { x: (sx - rect.left - viewport.x) / viewport.zoom, y: (sy - rect.top - viewport.y) / viewport.zoom };
    },
    [viewport]
  );

  const zoomBy = useCallback((factor, centerScreen) => {
    setViewport((v) => {
      const nextZoom = clamp(v.zoom * factor, CANVAS_ZOOM_MIN, CANVAS_ZOOM_MAX);
      const rect = containerRef.current.getBoundingClientRect();
      const cx = centerScreen ? centerScreen.x - rect.left : rect.width / 2;
      const cy = centerScreen ? centerScreen.y - rect.top : rect.height / 2;
      const worldX = (cx - v.x) / v.zoom;
      const worldY = (cy - v.y) / v.zoom;
      return { x: cx - worldX * nextZoom, y: cy - worldY * nextZoom, zoom: nextZoom };
    });
  }, []);

  const fitToContent = useCallback(() => {
    if (!containerRef.current) return;
    if (!state.nodes.length) {
      setViewport({ x: 0, y: 0, zoom: 1 });
      return;
    }
    const xs = state.nodes.flatMap((n) => [n.x, n.x + n.width]);
    const ys = state.nodes.flatMap((n) => [n.y, n.y + n.height]);
    const minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys), maxY = Math.max(...ys);
    const rect = containerRef.current.getBoundingClientRect();
    const pad = 60;
    const zoom = clamp(
      Math.min((rect.width - pad * 2) / Math.max(1, maxX - minX), (rect.height - pad * 2) / Math.max(1, maxY - minY)),
      CANVAS_ZOOM_MIN,
      1.5
    );
    setViewport({ x: rect.width / 2 - ((minX + maxX) / 2) * zoom, y: rect.height / 2 - ((minY + maxY) / 2) * zoom, zoom });
  }, [state.nodes]);

  useEffect(() => {
    const raf = requestAnimationFrame(() => fitToContent());
    return () => cancelAnimationFrame(raf);
    // Only re-fit when a different canvas file is opened.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [file.id]);

  // Space bar toggles pan-drag mode (Obsidian convention): plain click-drag
  // on empty canvas draws a selection box; hold Space (or use a middle-
  // mouse / one-finger touch drag) to pan instead.
  useEffect(() => {
    const kd = (e) => {
      if (e.code === 'Space' && !e.repeat && document.activeElement?.tagName !== 'TEXTAREA') setSpaceDown(true);
    };
    const ku = (e) => {
      if (e.code === 'Space') setSpaceDown(false);
    };
    window.addEventListener('keydown', kd);
    window.addEventListener('keyup', ku);
    return () => {
      window.removeEventListener('keydown', kd);
      window.removeEventListener('keyup', ku);
    };
  }, []);

  // Wheel is attached natively (not passive) so preventDefault actually
  // stops the page from scrolling/zooming underneath the canvas.
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return undefined;
    const onWheel = (e) => {
      e.preventDefault();
      if (e.ctrlKey || e.metaKey) {
        zoomBy(Math.exp(-e.deltaY * 0.012), { x: e.clientX, y: e.clientY });
      } else {
        setViewport((v) => ({ ...v, x: v.x - e.deltaX, y: v.y - e.deltaY }));
      }
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [zoomBy]);

  const deleteSelection = useCallback(() => {
    if (selectedEdgeId) {
      commit((s) => ({ ...s, edges: s.edges.filter((e) => e.id !== selectedEdgeId) }));
      setSelectedEdgeId(null);
      return;
    }
    if (!selectedIds.size) return;
    commit((s) => ({
      ...s,
      nodes: s.nodes.filter((n) => !selectedIds.has(n.id)),
      edges: s.edges.filter((e) => !selectedIds.has(e.fromNode) && !selectedIds.has(e.toNode))
    }));
    setSelectedIds(new Set());
  }, [selectedIds, selectedEdgeId, commit]);

  const setSelectionColor = (color) => {
    if (!selectedIds.size) return;
    commit((s) => ({ ...s, nodes: s.nodes.map((n) => (selectedIds.has(n.id) ? { ...n, color } : n)) }));
  };

  const commitTextEdit = useCallback(
    (id, text) => {
      setEditingId(null);
      commit((s) => ({ ...s, nodes: s.nodes.map((n) => (n.id === id ? { ...n, text } : n)) }));
    },
    [commit]
  );

  const onBgPointerDown = useCallback(
    (e) => {
      containerRef.current.focus();
      containerRef.current.setPointerCapture(e.pointerId);
      pointersRef.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pointersRef.current.size >= 2) {
        const pts = Array.from(pointersRef.current.values());
        dragRef.current = {
          mode: 'pinch',
          startDist: Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y) || 1,
          startMid: { x: (pts[0].x + pts[1].x) / 2, y: (pts[0].y + pts[1].y) / 2 },
          startViewport: viewport
        };
        return;
      }
      const panMode = e.pointerType === 'touch' || e.button === 1 || spaceDown;
      if (panMode) {
        setIsPanning(true);
        dragRef.current = { mode: 'pan', startClient: { x: e.clientX, y: e.clientY }, startViewport: viewport };
      } else {
        const world = screenToWorld(e.clientX, e.clientY);
        setSelectedIds(new Set());
        setSelectedEdgeId(null);
        dragRef.current = { mode: 'marquee', startWorld: world };
        setMarquee({ x0: world.x, y0: world.y, x1: world.x, y1: world.y });
      }
    },
    [viewport, spaceDown, screenToWorld]
  );

  const onBackgroundDoubleClick = useCallback(
    (e) => {
      const world = screenToWorld(e.clientX, e.clientY);
      const newNode = { id: uid('node'), type: 'text', x: world.x - 90, y: world.y - 30, width: 200, height: 80, text: '' };
      commit((s) => ({ ...s, nodes: [...s.nodes, newNode] }));
      setSelectedIds(new Set([newNode.id]));
      setEditingId(newNode.id);
    },
    [screenToWorld, commit]
  );

  const beginMove = useCallback(
    (e, node) => {
      if (editingId === node.id) return;
      e.stopPropagation();
      containerRef.current.focus();
      containerRef.current.setPointerCapture(e.pointerId);
      let ids;
      if (e.shiftKey) {
        ids = new Set(selectedIds);
        ids.has(node.id) ? ids.delete(node.id) : ids.add(node.id);
        setSelectedIds(ids);
      } else if (selectedIds.has(node.id)) {
        ids = selectedIds;
      } else {
        ids = new Set([node.id]);
        setSelectedIds(ids);
      }
      setSelectedEdgeId(null);
      let dragIds = Array.from(ids);
      if (node.type === 'group') {
        const r = canvasNodeRect(node);
        const contained = state.nodes
          .filter((n) => n.id !== node.id && n.type !== 'group' && n.x >= r.left && n.y >= r.top && n.x + n.width <= r.right && n.y + n.height <= r.bottom)
          .map((n) => n.id);
        dragIds = Array.from(new Set([...dragIds, ...contained]));
      }
      const startPositions = new Map(state.nodes.filter((n) => dragIds.includes(n.id)).map((n) => [n.id, { x: n.x, y: n.y }]));
      dragRef.current = { mode: 'move', ids: dragIds, startPositions, startWorld: screenToWorld(e.clientX, e.clientY), moved: false };
    },
    [editingId, selectedIds, state.nodes, screenToWorld]
  );

  const beginResize = useCallback(
    (e, node) => {
      e.stopPropagation();
      containerRef.current.setPointerCapture(e.pointerId);
      dragRef.current = { mode: 'resize', id: node.id, startW: node.width, startH: node.height, startWorld: screenToWorld(e.clientX, e.clientY), moved: false };
    },
    [screenToWorld]
  );

  const beginConnect = useCallback((e, node, side) => {
    e.stopPropagation();
    containerRef.current.setPointerCapture(e.pointerId);
    const pt = canvasSideAnchor(node, side);
    dragRef.current = { mode: 'connect', fromNodeId: node.id, fromSide: side, startClient: { x: e.clientX, y: e.clientY } };
    setConnecting({ fromNodeId: node.id, fromSide: side, fromPt: pt, toPt: pt });
  }, []);

  const onNodeDoubleClick = useCallback(
    (e, node) => {
      e.stopPropagation();
      if (node.type === 'text') {
        setSelectedIds(new Set([node.id]));
        setEditingId(node.id);
      } else if (node.type === 'group') {
        const label = window.prompt('Group name:', node.label || '');
        if (label != null) commit((s) => ({ ...s, nodes: s.nodes.map((n) => (n.id === node.id ? { ...n, label } : n)) }));
      } else if (node.type === 'file') {
        const meta = allFilesById.get(node.file);
        if (meta) (opensInEditorPane(meta.kind) ? handlers.onOpenById(meta.id) : handlers.onOpenAsset(meta));
      } else if (node.type === 'link') {
        window.open(node.url, '_blank', 'noreferrer');
      }
    },
    [commit, allFilesById, handlers]
  );

  const onEdgeDoubleClick = useCallback(
    (edgeId) => {
      const edge = state.edges.find((e) => e.id === edgeId);
      const label = window.prompt('Edge label:', edge?.label || '');
      if (label != null) commit((s) => ({ ...s, edges: s.edges.map((e) => (e.id === edgeId ? { ...e, label } : e)) }));
    },
    [state.edges, commit]
  );

  const onContainerPointerMove = (e) => {
    if (pointersRef.current.has(e.pointerId)) pointersRef.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const drag = dragRef.current;
    if (!drag) return;
    if (drag.mode === 'pan') {
      const dx = e.clientX - drag.startClient.x;
      const dy = e.clientY - drag.startClient.y;
      setViewport({ ...drag.startViewport, x: drag.startViewport.x + dx, y: drag.startViewport.y + dy });
    } else if (drag.mode === 'pinch') {
      const pts = Array.from(pointersRef.current.values());
      if (pts.length < 2) return;
      const dist = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y) || 1;
      const mid = { x: (pts[0].x + pts[1].x) / 2, y: (pts[0].y + pts[1].y) / 2 };
      const nextZoom = clamp(drag.startViewport.zoom * (dist / drag.startDist), CANVAS_ZOOM_MIN, CANVAS_ZOOM_MAX);
      const rect = containerRef.current.getBoundingClientRect();
      const worldX = (drag.startMid.x - rect.left - drag.startViewport.x) / drag.startViewport.zoom;
      const worldY = (drag.startMid.y - rect.top - drag.startViewport.y) / drag.startViewport.zoom;
      setViewport({ x: mid.x - rect.left - worldX * nextZoom, y: mid.y - rect.top - worldY * nextZoom, zoom: nextZoom });
    } else if (drag.mode === 'marquee') {
      const world = screenToWorld(e.clientX, e.clientY);
      setMarquee({ x0: drag.startWorld.x, y0: drag.startWorld.y, x1: world.x, y1: world.y });
    } else if (drag.mode === 'move') {
      const world = screenToWorld(e.clientX, e.clientY);
      const dx = world.x - drag.startWorld.x;
      const dy = world.y - drag.startWorld.y;
      if (drag.moved || Math.abs(dx) > CANVAS_MOVE_THRESHOLD || Math.abs(dy) > CANVAS_MOVE_THRESHOLD) {
        drag.moved = true;
        const overrides = new Map();
        drag.ids.forEach((id) => {
          const base = drag.startPositions.get(id);
          if (base) overrides.set(id, { x: base.x + dx, y: base.y + dy });
        });
        scheduleLiveOverrides(overrides);
      }
    } else if (drag.mode === 'resize') {
      const world = screenToWorld(e.clientX, e.clientY);
      const w = Math.max(CANVAS_MIN_W, drag.startW + (world.x - drag.startWorld.x));
      const h = Math.max(CANVAS_MIN_H, drag.startH + (world.y - drag.startWorld.y));
      if (w !== drag.startW || h !== drag.startH) drag.moved = true;
      scheduleLiveOverrides(new Map([[drag.id, { width: w, height: h }]]));
    } else if (drag.mode === 'connect') {
      setConnecting((c) => c && { ...c, toPt: screenToWorld(e.clientX, e.clientY) });
    }
  };

  const onContainerPointerUp = (e) => {
    pointersRef.current.delete(e.pointerId);
    const drag = dragRef.current;
    dragRef.current = null;
    setIsPanning(false);
    if (!drag) return;
    if (drag.mode === 'marquee') {
      const m = marquee;
      setMarquee(null);
      if (m) {
        const box = { x0: Math.min(m.x0, m.x1), y0: Math.min(m.y0, m.y1), x1: Math.max(m.x0, m.x1), y1: Math.max(m.y0, m.y1) };
        const ids = state.nodes.filter((n) => n.x < box.x1 && n.x + n.width > box.x0 && n.y < box.y1 && n.y + n.height > box.y0).map((n) => n.id);
        if (ids.length) setSelectedIds(new Set(ids));
      }
    } else if (drag.mode === 'move' || drag.mode === 'resize') {
      if (drag.moved && pendingOverridesRef.current) {
        const overrides = pendingOverridesRef.current;
        commit((s) => ({ ...s, nodes: s.nodes.map((n) => (overrides.has(n.id) ? { ...n, ...overrides.get(n.id) } : n)) }));
      }
      setLiveOverrides(null);
      pendingOverridesRef.current = null;
    } else if (drag.mode === 'connect') {
      const world = screenToWorld(e.clientX, e.clientY);
      const dist = Math.hypot(e.clientX - (drag.startClient?.x ?? e.clientX), e.clientY - (drag.startClient?.y ?? e.clientY));
      const target = canvasHitTest(state.nodes, world, drag.fromNodeId);
      if (target) {
        const toSide = canvasNearestSide(target, world);
        commit((s) => ({ ...s, edges: [...s.edges, { id: uid('edge'), fromNode: drag.fromNodeId, fromSide: drag.fromSide, toNode: target.id, toSide }] }));
      } else if (dist > 12) {
        const newNode = { id: uid('node'), type: 'text', x: world.x - 90, y: world.y - 30, width: 180, height: 60, text: '' };
        const toSide = canvasOppositeSide(drag.fromSide);
        commit((s) => ({
          ...s,
          nodes: [...s.nodes, newNode],
          edges: [...s.edges, { id: uid('edge'), fromNode: drag.fromNodeId, fromSide: drag.fromSide, toNode: newNode.id, toSide }]
        }));
        setSelectedIds(new Set([newNode.id]));
        setEditingId(newNode.id);
      }
      setConnecting(null);
    }
  };

  const onKeyDown = (e) => {
    if (editingId) return;
    if (e.key === 'Delete' || e.key === 'Backspace') {
      e.preventDefault();
      deleteSelection();
    } else if (e.key === 'Escape') {
      setSelectedIds(new Set());
      setSelectedEdgeId(null);
      setConnecting(null);
    } else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'a') {
      e.preventDefault();
      setSelectedIds(new Set(state.nodes.map((n) => n.id)));
    } else if ((e.metaKey || e.ctrlKey) && (e.key === '=' || e.key === '+')) {
      e.preventDefault();
      zoomBy(1.2);
    } else if ((e.metaKey || e.ctrlKey) && e.key === '-') {
      e.preventDefault();
      zoomBy(1 / 1.2);
    } else if ((e.metaKey || e.ctrlKey) && e.key === '0') {
      e.preventDefault();
      setViewport((v) => ({ ...v, zoom: 1 }));
    }
  };

  const centerWorld = useCallback(() => {
    const rect = containerRef.current.getBoundingClientRect();
    return screenToWorld(rect.left + rect.width / 2, rect.top + rect.height / 2);
  }, [screenToWorld]);

  const addTextNodeAtCenter = () => {
    const world = centerWorld();
    const newNode = { id: uid('node'), type: 'text', x: world.x - 100, y: world.y - 40, width: 200, height: 90, text: '' };
    commit((s) => ({ ...s, nodes: [...s.nodes, newNode] }));
    setSelectedIds(new Set([newNode.id]));
    setEditingId(newNode.id);
  };
  const addLinkNodeAtCenter = () => {
    const url = window.prompt('URL to embed:');
    if (!url || !url.trim()) return;
    const world = centerWorld();
    const newNode = { id: uid('node'), type: 'link', x: world.x - 110, y: world.y - 30, width: 240, height: 56, url: url.trim() };
    commit((s) => ({ ...s, nodes: [...s.nodes, newNode] }));
    setSelectedIds(new Set([newNode.id]));
  };
  const addGroupAtCenter = () => {
    const world = centerWorld();
    const newNode = { id: uid('node'), type: 'group', x: world.x - 160, y: world.y - 110, width: 320, height: 220, label: 'Group' };
    commit((s) => ({ ...s, nodes: [newNode, ...s.nodes] }));
    setSelectedIds(new Set([newNode.id]));
  };
  const addFileNodeFromPicker = (fileMeta) => {
    setFilePickerOpen(false);
    const world = centerWorld();
    const isMedia = fileMeta.kind === 'image' || fileMeta.kind === 'video' || fileMeta.kind === 'audio';
    const newNode = {
      id: uid('node'),
      type: 'file',
      x: world.x - 150,
      y: world.y - 100,
      width: 300,
      height: isMedia ? 220 : 260,
      file: fileMeta.id
    };
    commit((s) => ({ ...s, nodes: [...s.nodes, newNode] }));
    setSelectedIds(new Set([newNode.id]));
  };

  if (loading) {
    return (
      <div className="db-loading">
        <IconLoader size={18} /> Loading canvas…
      </div>
    );
  }

  const selectionBounds =
    selectedIds.size > 0
      ? (() => {
          const nodes = nodesForRender.filter((n) => selectedIds.has(n.id));
          if (!nodes.length) return null;
          const minX = Math.min(...nodes.map((n) => n.x));
          const minY = Math.min(...nodes.map((n) => n.y));
          return { x: minX * viewport.zoom + viewport.x, y: minY * viewport.zoom + viewport.y };
        })()
      : null;

  return (
    <div className="canvas-view">
      <CanvasToolbar
        zoom={viewport.zoom}
        onZoomIn={() => zoomBy(1.2)}
        onZoomOut={() => zoomBy(1 / 1.2)}
        onZoomReset={() => setViewport((v) => ({ ...v, zoom: 1 }))}
        onFitToContent={fitToContent}
        onAddText={addTextNodeAtCenter}
        onAddFile={() => setFilePickerOpen(true)}
        onAddLink={addLinkNodeAtCenter}
        onAddGroup={addGroupAtCenter}
      />
      <div
        className={`canvas-surface ${isPanning || spaceDown ? 'panning' : ''}`}
        ref={containerRef}
        tabIndex={0}
        onPointerDown={(e) => {
          if (e.target === containerRef.current || e.target.classList.contains('canvas-world')) onBgPointerDown(e);
        }}
        onPointerMove={onContainerPointerMove}
        onPointerUp={onContainerPointerUp}
        onPointerCancel={onContainerPointerUp}
        onDoubleClick={(e) => {
          if (e.target === containerRef.current || e.target.classList.contains('canvas-world')) onBackgroundDoubleClick(e);
        }}
        onKeyDown={onKeyDown}
      >
        <div className="canvas-world" style={{ transform: `translate(${viewport.x}px, ${viewport.y}px) scale(${viewport.zoom})` }}>
          <CanvasEdgesLayer
            nodes={nodesForRender}
            edges={state.edges}
            selectedEdgeId={selectedEdgeId}
            connecting={connecting}
            onSelectEdge={setSelectedEdgeId}
            onDoubleClickEdge={onEdgeDoubleClick}
          />
          {nodesForRender.map((node) => (
            <CanvasNode
              key={node.id}
              node={node}
              selected={selectedIds.has(node.id)}
              hovered={hoveredId === node.id}
              editing={editingId === node.id}
              allFilesById={allFilesById}
              handlers={handlers}
              linkIndex={linkIndex}
              onPointerDownBody={beginMove}
              onPointerDownResize={beginResize}
              onPointerDownDot={beginConnect}
              onDoubleClick={onNodeDoubleClick}
              onHoverChange={setHoveredId}
              onCommitEdit={commitTextEdit}
            />
          ))}
          {marquee && (
            <div
              className="canvas-marquee"
              style={{
                left: Math.min(marquee.x0, marquee.x1),
                top: Math.min(marquee.y0, marquee.y1),
                width: Math.abs(marquee.x1 - marquee.x0),
                height: Math.abs(marquee.y1 - marquee.y0)
              }}
            />
          )}
        </div>
        {selectionBounds && (
          <div className="canvas-selection-toolbar" style={{ left: Math.max(4, selectionBounds.x), top: Math.max(4, selectionBounds.y - 40) }}>
            {CANVAS_COLORS.map((c) => (
              <button key={c} className="canvas-color-swatch" style={{ background: c }} onClick={() => setSelectionColor(c)} title="Set color" />
            ))}
            <button className="canvas-color-swatch canvas-color-none" onClick={() => setSelectionColor(null)} title="Clear color">
              ×
            </button>
            <button className="icon-btn" onClick={deleteSelection} title="Delete">
              <IconTrash size={14} />
            </button>
          </div>
        )}
      </div>
      {filePickerOpen && <CanvasFilePickerModal files={allFiles || []} onPick={addFileNodeFromPicker} onClose={() => setFilePickerOpen(false)} />}
    </div>
  );
}

// Inline `![[video.mp4]]` embed within note content — fetches the blob only
// once the note containing it is actually being read (same on-demand rule
// as ImageEmbed below).
function VideoEmbed({ token, fileId, name }) {
  const { url, error } = useDriveImageUrl(token, fileId);
  if (error) return <span className="wikilink wikilink-missing-image">{name}</span>;
  if (!url) return <span className="muted small embed-loading">Loading {name}…</span>;
  return <video src={url} controls className="video-embed" />;
}

// Inline `![[audio.mp3]]` embed.
function AudioEmbed({ token, fileId, name }) {
  const { url, error } = useDriveImageUrl(token, fileId);
  if (error) return <span className="wikilink wikilink-missing-image">{name}</span>;
  if (!url) return <span className="muted small embed-loading">Loading {name}…</span>;
  return (
    <span className="audio-embed-wrap">
      <audio src={url} controls className="audio-embed" />
      <span className="audio-embed-name">{name}</span>
    </span>
  );
}

// Inline chip for any other linked file (pdf, zip, docx, ...) — click opens
// it in a new tab / downloads it, same as the sidebar's file rows.
function FileChip({ name, label, onOpen }) {
  return (
    <span className="file-chip" onClick={onOpen} title={`Open ${name}`}>
      <IconFile size={13} />
      {label || name}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Status bar — global footer reflecting the currently focused pane's file:
// word count, character count, backlink count, property count, plus a
// small live sync indicator on the far right.
// ---------------------------------------------------------------------------
function StatusBar({ file, content, backlinkCount, syncing, syncError, dirty, saving, selectionText }) {
  const { properties, body } = parseFrontmatter(content || '');
  const hasSelection = !!selectionText && selectionText.trim().length > 0;
  const countSource = hasSelection ? selectionText : body;
  const words = countSource.trim() ? countSource.trim().split(/\s+/).length : 0;
  const chars = countSource.length;

  return (
    <footer className="status-bar">
      <div className="status-bar-left">
        {file && (
          <>
            <span>{backlinkCount} backlink{backlinkCount === 1 ? '' : 's'}</span>
            <span>{properties.length} propert{properties.length === 1 ? 'y' : 'ies'}</span>
            <span>{hasSelection ? 'Selected: ' : ''}{words} word{words === 1 ? '' : 's'}</span>
            <span>{chars} character{chars === 1 ? '' : 's'}</span>
            {file.kind === 'note' && (
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
// ---------------------------------------------------------------------------
// Help — replaces the old single window.alert() shortcut list with a proper
// modal: keyboard shortcuts, a markdown syntax reference, and a plain-
// language tour of the app's features. Content is static, so it lives right
// in this component rather than as separate data.
// ---------------------------------------------------------------------------
const HELP_SHORTCUTS = [
  { keys: '⌘/Ctrl K or P', desc: 'Open the command palette' },
  { keys: '⌘/Ctrl O', desc: 'Quick switcher — jump to any note by name' },
  { keys: '⌘/Ctrl S', desc: 'Save the note in the focused pane' },
  { keys: '⌘/Ctrl Z', desc: 'Undo (⇧ for redo)' },
  { keys: 'Tab / ⇧Tab', desc: 'Indent / outdent the current line while editing' },
  { keys: 'Middle-click a tab', desc: 'Close that tab' },
  { keys: 'Drag a file or folder', desc: 'Move it in the sidebar' },
  { keys: '⌘/Ctrl-click a note or file', desc: 'Open it in a new tab instead of the current one' }
];

const HELP_MARKDOWN = [
  { syntax: '# / ## / ###', desc: 'Headings (levels 1–6). Click the caret next to a heading in reading view to fold its section.' },
  { syntax: '**bold**, *italic*, `code`', desc: 'Standard inline formatting.' },
  { syntax: '[[Note Name]]', desc: 'Link to another note. Start typing after [[ for autocomplete; unmatched names become "phantom" links you can create by clicking.' },
  { syntax: '[[image.png]] / [[clip.mp4]] / [[song.mp3]]', desc: 'Embed an image, video, or audio file inline by filename.' },
  { syntax: '#tag or #parent/child', desc: 'Tag a note. Autocomplete suggests existing tags as you type; nested tags (parent/child) group and roll up counts in the Tags panel.' },
  { syntax: '> [!tip] Title', desc: 'Callout block. Recognized types: note, info, abstract, summary, tip, hint, success, check, done, question, help, faq, warning, caution, attention, danger, error, failure, bug, quote, example.' },
  { syntax: '| a | b |\\n|---|---|\\n| 1 | 2 |', desc: 'Tables, standard markdown pipe syntax.' },
  { syntax: '+++ Toggle title\\n…content…\\n+++', desc: 'Collapsible toggle block — click the header to expand or collapse.' },
  { syntax: ':::columns-2\\n…\\n:::column\\n…\\n:::', desc: 'Side-by-side columns. Use columns-2, columns-3, or columns-4, and separate columns with a line containing only :::column.' },
  { syntax: ':::tabs\\n:::tab First\\n…\\n:::tab Second\\n…\\n:::', desc: 'A paginated tab block, like a Notion tab widget. Click a tab to switch pages, double-click a tab to rename it, use the × to delete it, and the + to add a new one — all directly from reading view.' },
  { syntax: '- [ ] / - [x]', desc: 'Task checkboxes.' },
  { syntax: '---\\nkey: value\\n---', desc: 'Frontmatter at the top of a note — shown as a Properties panel, and matched by [key] / [key:value] in search.' }
];

const HELP_FEATURES = [
  { title: 'Tabs & panes', desc: 'Every note, database, or file opens in a tab. Split a pane right or down from the pane header to view two things side by side; drag the divider to resize.' },
  { title: 'Reading vs. editing view', desc: 'Toggle with the eye icon in a note\'s pane header. Editing view keeps the raw markdown fully editable while still styling it — same fonts and sizes as reading view, just with the syntax characters dimmed instead of hidden.' },
  { title: 'Backlinks', desc: 'Every note tracks what links to it. Linked/unlinked mentions show at the bottom of reading view.' },
  { title: 'Search', desc: 'path:, file:, and tag: filter by location, filename, or tag (tag: also matches nested descendants). line:(a b) and section:(a b) require terms on the same line or under the same heading. [key] or [key:value] matches frontmatter. "exact phrase" for literal text; anything else is a plain term.' },
  { title: 'Tags panel', desc: 'Every tag in the vault, nested tags shown as an indented tree with counts that roll up to their parent. Click any tag to search it.' },
  { title: 'Databases', desc: 'Notion-style structured tables stored as a .base file — table, board, and gallery views, with typed columns (text, select, multi-select, date, image, etc).' },
  { title: 'Bookmarks', desc: 'Star any note or file to pin it in the Bookmarks panel for quick access.' },
  { title: 'Command palette & quick switcher', desc: '⌘/Ctrl K for commands (new note, split pane, toggle sidebar, etc), ⌘/Ctrl O to jump straight to a note by name.' },
  { title: 'Images & files', desc: 'Open in their own tab just like notes — video/audio get inline players, other files get a download link — rather than a new browser tab.' },
  { title: 'Graph view', desc: 'The network icon in the activity bar (or ⌘/Ctrl K → "Open graph view") opens a full map of every wikilink in the vault. Drag nodes, scroll to zoom, hover to see a note\'s connections, and click a node to jump straight to it. Toggle attachments and orphans on or off from the toolbar.' }
];

function HelpModal({ onClose }) {
  const [tab, setTab] = useState('shortcuts');
  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal help-modal" onClick={(e) => e.stopPropagation()}>
        <div className="help-modal-header">
          <h3>Help</h3>
          <button className="icon-btn" onClick={onClose} aria-label="Close help">
            <IconX size={16} />
          </button>
        </div>
        <div className="help-modal-tabs">
          <button className={`help-tab ${tab === 'shortcuts' ? 'active' : ''}`} onClick={() => setTab('shortcuts')}>
            Shortcuts
          </button>
          <button className={`help-tab ${tab === 'markdown' ? 'active' : ''}`} onClick={() => setTab('markdown')}>
            Markdown syntax
          </button>
          <button className={`help-tab ${tab === 'features' ? 'active' : ''}`} onClick={() => setTab('features')}>
            Features
          </button>
        </div>
        <div className="help-modal-body">
          {tab === 'shortcuts' && (
            <div className="help-rows">
              {HELP_SHORTCUTS.map((s) => (
                <div className="help-row" key={s.keys}>
                  <code className="help-row-key">{s.keys}</code>
                  <span className="help-row-desc">{s.desc}</span>
                </div>
              ))}
            </div>
          )}
          {tab === 'markdown' && (
            <div className="help-rows">
              {HELP_MARKDOWN.map((s) => (
                <div className="help-row" key={s.syntax}>
                  <code className="help-row-key help-row-syntax">{s.syntax}</code>
                  <span className="help-row-desc">{s.desc}</span>
                </div>
              ))}
            </div>
          )}
          {tab === 'features' && (
            <div className="help-rows">
              {HELP_FEATURES.map((f) => (
                <div className="help-row help-row-feature" key={f.title}>
                  <span className="help-row-title">{f.title}</span>
                  <span className="help-row-desc">{f.desc}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function clamp(v, min, max) {
  return Math.min(max, Math.max(min, v));
}

// Lightweight force-directed layout for Graph View — no external physics or
// graph library is pulled in; nodes repel each other, linked pairs attract
// along a spring, and everything is nudged gently toward the center so the
// graph doesn't drift off-canvas. It's a damped simulation (alpha decays
// every tick, same idea as d3-force) so it settles and stops burning CPU on
// its own a couple of seconds after opening, rather than running forever.
// Positions/velocities/pinned-state live in a ref (not React state) since
// they update every animation frame; `bump` below is the only piece of
// this that touches React state, purely to trigger a re-render per tick.
function useForceGraph(nodeIds, edgeList, width, height) {
  const stateRef = useRef({ pos: new Map(), vel: new Map(), pinned: new Set() });
  const alphaRef = useRef(1);
  const rafRef = useRef(null);
  const stepRef = useRef(null);
  const [, bump] = useState(0);

  // Seed any node that doesn't have a position yet in a ring around the
  // center (so new nodes don't all stack at the origin and fling apart on
  // the first tick), and drop stale entries for nodes that no longer exist.
  useEffect(() => {
    const { pos, vel, pinned } = stateRef.current;
    const idSet = new Set(nodeIds);
    nodeIds.forEach((id, i) => {
      if (!pos.has(id)) {
        const angle = (i / Math.max(1, nodeIds.length)) * Math.PI * 2;
        const r = Math.min(width, height) * 0.32;
        pos.set(id, { x: width / 2 + Math.cos(angle) * r, y: height / 2 + Math.sin(angle) * r });
        vel.set(id, { x: 0, y: 0 });
      }
    });
    Array.from(pos.keys()).forEach((id) => {
      if (!idSet.has(id)) {
        pos.delete(id);
        vel.delete(id);
        pinned.delete(id);
      }
    });
    alphaRef.current = 1;
  }, [nodeIds, width, height]);

  useEffect(() => {
    let cancelled = false;
    const { pos, vel, pinned } = stateRef.current;
    const REPULSION = 2400;
    const SPRING = 0.02;
    const SPRING_LEN = 95;
    const CENTER_PULL = 0.012;
    const DAMPING = 0.8;

    function step() {
      if (cancelled) return;
      if (alphaRef.current > 0.008) {
        const alpha = alphaRef.current;
        // Pairwise repulsion — O(n²), fine at the node counts a single
        // vault's graph realistically reaches; spatial partitioning would
        // be the next lever if that stops being true for very large vaults.
        for (let i = 0; i < nodeIds.length; i++) {
          const a = pos.get(nodeIds[i]);
          if (!a) continue;
          for (let j = i + 1; j < nodeIds.length; j++) {
            const b = pos.get(nodeIds[j]);
            if (!b) continue;
            let dx = a.x - b.x;
            let dy = a.y - b.y;
            const distSq = Math.max(dx * dx + dy * dy, 25);
            const dist = Math.sqrt(distSq);
            const force = (REPULSION * alpha) / distSq;
            dx /= dist;
            dy /= dist;
            const va = vel.get(nodeIds[i]);
            const vb = vel.get(nodeIds[j]);
            va.x += dx * force;
            va.y += dy * force;
            vb.x -= dx * force;
            vb.y -= dy * force;
          }
        }
        edgeList.forEach(([s, t]) => {
          const a = pos.get(s);
          const b = pos.get(t);
          if (!a || !b) return;
          const dx = b.x - a.x;
          const dy = b.y - a.y;
          const dist = Math.sqrt(dx * dx + dy * dy) || 0.01;
          const force = (dist - SPRING_LEN) * SPRING * alpha;
          const fx = (dx / dist) * force;
          const fy = (dy / dist) * force;
          const va = vel.get(s);
          const vb = vel.get(t);
          va.x += fx;
          va.y += fy;
          vb.x -= fx;
          vb.y -= fy;
        });
        nodeIds.forEach((id) => {
          const p = pos.get(id);
          const v = vel.get(id);
          if (!p || !v) return;
          v.x += (width / 2 - p.x) * CENTER_PULL * alpha;
          v.y += (height / 2 - p.y) * CENTER_PULL * alpha;
        });
        nodeIds.forEach((id) => {
          const p = pos.get(id);
          const v = vel.get(id);
          if (!p || !v) return;
          if (pinned.has(id)) {
            v.x = 0;
            v.y = 0;
          } else {
            v.x *= DAMPING;
            v.y *= DAMPING;
            p.x += v.x;
            p.y += v.y;
          }
        });
        alphaRef.current *= 0.985;
        bump((n) => n + 1);
        rafRef.current = requestAnimationFrame(step);
      } else {
        rafRef.current = null;
      }
    }
    stepRef.current = step;
    rafRef.current = requestAnimationFrame(step);
    return () => {
      cancelled = true;
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
      stepRef.current = null;
    };
  }, [nodeIds, edgeList, width, height]);

  // Raises the simulation's temperature and (re)starts the animation loop
  // if it had already settled — called on drag, filter changes, and the
  // manual "re-run layout" button.
  const wake = useCallback((amount = 0.3) => {
    alphaRef.current = Math.max(alphaRef.current, amount);
    if (!rafRef.current && stepRef.current) rafRef.current = requestAnimationFrame(stepRef.current);
  }, []);

  return { pos: stateRef.current.pos, pinned: stateRef.current.pinned, wake };
}

// Full-screen Graph View — a force-directed map of every wikilink in the
// vault, in the spirit of Obsidian's Graph View. Deliberately built as a
// self-contained modal (like Help/Palette) rather than a pane-tree tab:
// the pane/tab system is wired tightly around real Drive files (rename,
// save, sync), and a synthetic non-file "tab" would need to fight that
// machinery for little benefit — a modal gets the same "see the whole
// vault, click through to a note" experience with far less risk.
function GraphViewModal({ onClose, linkIndex, linksByFileId, onOpenFile, activeFileId }) {
  const containerRef = useRef(null);
  const svgRef = useRef(null);
  const [size, setSize] = useState({ width: 800, height: 600 });
  const [showAttachments, setShowAttachments] = useState(false);
  const [hideOrphans, setHideOrphans] = useState(false);
  const [query, setQuery] = useState('');
  const [hoveredId, setHoveredId] = useState(null);
  const [view, setView] = useState({ x: 0, y: 0, k: 1 });
  const dragRef = useRef({ mode: null });

  useEffect(() => {
    const el = containerRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (entry) setSize({ width: entry.contentRect.width, height: entry.contentRect.height });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const nodes = useMemo(
    () => linkIndex.records.filter((r) => showAttachments || !r.isAsset),
    [linkIndex, showAttachments]
  );
  const edges = useMemo(() => {
    const nodeIdSet = new Set(nodes.map((n) => n.id));
    const seen = new Set();
    const out = [];
    for (const [sourceId, links] of linksByFileId.entries()) {
      if (!nodeIdSet.has(sourceId)) continue;
      for (const link of links) {
        const res = resolveLinkTarget(link.target, linkIndex);
        if (res.status !== 'resolved' || res.file.id === sourceId || !nodeIdSet.has(res.file.id)) continue;
        const key = sourceId < res.file.id ? `${sourceId}|${res.file.id}` : `${res.file.id}|${sourceId}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push([sourceId, res.file.id]);
      }
    }
    return out;
  }, [nodes, linksByFileId, linkIndex]);

  const degree = useMemo(() => {
    const map = new Map();
    nodes.forEach((n) => map.set(n.id, 0));
    edges.forEach(([a, b]) => {
      map.set(a, (map.get(a) || 0) + 1);
      map.set(b, (map.get(b) || 0) + 1);
    });
    return map;
  }, [nodes, edges]);

  const visibleNodes = useMemo(
    () => (hideOrphans ? nodes.filter((n) => (degree.get(n.id) || 0) > 0) : nodes),
    [nodes, degree, hideOrphans]
  );
  const visibleIdSet = useMemo(() => new Set(visibleNodes.map((n) => n.id)), [visibleNodes]);
  const visibleEdges = useMemo(
    () => edges.filter(([a, b]) => visibleIdSet.has(a) && visibleIdSet.has(b)),
    [edges, visibleIdSet]
  );
  const nodeIds = useMemo(() => visibleNodes.map((n) => n.id), [visibleNodes]);

  const { pos, pinned, wake } = useForceGraph(nodeIds, visibleEdges, size.width || 800, size.height || 600);

  const neighborSet = useMemo(() => {
    if (!hoveredId) return null;
    const set = new Set([hoveredId]);
    visibleEdges.forEach(([a, b]) => {
      if (a === hoveredId) set.add(b);
      if (b === hoveredId) set.add(a);
    });
    return set;
  }, [hoveredId, visibleEdges]);

  const matchSet = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return null;
    return new Set(visibleNodes.filter((n) => n.baseName.toLowerCase().includes(q)).map((n) => n.id));
  }, [query, visibleNodes]);

  const toWorld = (clientX, clientY) => {
    const rect = svgRef.current.getBoundingClientRect();
    return { x: (clientX - rect.left - view.x) / view.k, y: (clientY - rect.top - view.y) / view.k };
  };

  const onNodePointerDown = (e, id) => {
    e.stopPropagation();
    e.currentTarget.setPointerCapture?.(e.pointerId);
    const w = toWorld(e.clientX, e.clientY);
    const p = pos.get(id);
    pinned.add(id);
    wake(0.4);
    dragRef.current = {
      mode: 'node',
      id,
      startClientX: e.clientX,
      startClientY: e.clientY,
      moved: false,
      offsetX: (p?.x ?? w.x) - w.x,
      offsetY: (p?.y ?? w.y) - w.y
    };
  };
  const onBackgroundPointerDown = (e) => {
    dragRef.current = { mode: 'pan', startClientX: e.clientX, startClientY: e.clientY, startViewX: view.x, startViewY: view.y };
  };
  const onPointerMove = (e) => {
    const d = dragRef.current;
    if (!d.mode) return;
    if (d.mode === 'node') {
      const dx = e.clientX - d.startClientX;
      const dy = e.clientY - d.startClientY;
      if (Math.abs(dx) > 3 || Math.abs(dy) > 3) d.moved = true;
      const w = toWorld(e.clientX, e.clientY);
      const p = pos.get(d.id);
      if (p) {
        p.x = w.x + d.offsetX;
        p.y = w.y + d.offsetY;
      }
      wake(0.3);
    } else if (d.mode === 'pan') {
      setView((v) => ({ ...v, x: d.startViewX + (e.clientX - d.startClientX), y: d.startViewY + (e.clientY - d.startClientY) }));
    }
  };
  const onPointerUp = () => {
    const d = dragRef.current;
    if (d.mode === 'node') {
      pinned.delete(d.id);
      wake(0.4);
      if (!d.moved) {
        onOpenFile(d.id);
        onClose();
      }
    }
    dragRef.current = { mode: null };
  };
  const onWheel = (e) => {
    e.preventDefault();
    const rect = svgRef.current.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    const scaleBy = e.deltaY < 0 ? 1.1 : 1 / 1.1;
    setView((v) => {
      const newK = clamp(v.k * scaleBy, 0.15, 4);
      const worldX = (mx - v.x) / v.k;
      const worldY = (my - v.y) / v.k;
      return { x: mx - worldX * newK, y: my - worldY * newK, k: newK };
    });
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal graph-modal" onClick={(e) => e.stopPropagation()}>
        <div className="graph-modal-header">
          <h3>Graph view</h3>
          <div className="graph-modal-tools">
            <input className="graph-search" placeholder="Find a note…" value={query} onChange={(e) => setQuery(e.target.value)} />
            <label className="graph-toggle">
              <input type="checkbox" checked={showAttachments} onChange={(e) => setShowAttachments(e.target.checked)} />
              Attachments
            </label>
            <label className="graph-toggle">
              <input type="checkbox" checked={hideOrphans} onChange={(e) => setHideOrphans(e.target.checked)} />
              Hide orphans
            </label>
            <button className="icon-btn" title="Re-run layout" onClick={() => wake(1)}>
              <IconRefresh size={15} />
            </button>
            <button className="icon-btn" title="Reset view" onClick={() => setView({ x: 0, y: 0, k: 1 })}>
              <IconMaximize size={15} />
            </button>
            <button className="icon-btn" onClick={onClose} aria-label="Close graph view">
              <IconX size={16} />
            </button>
          </div>
        </div>
        <div className="graph-canvas-wrap" ref={containerRef}>
          <svg
            ref={svgRef}
            className="graph-svg"
            onPointerDown={onBackgroundPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerLeave={onPointerUp}
            onWheel={onWheel}
          >
            <g transform={`translate(${view.x},${view.y}) scale(${view.k})`}>
              {visibleEdges.map(([a, b], i) => {
                const pa = pos.get(a);
                const pb = pos.get(b);
                if (!pa || !pb) return null;
                const dim = neighborSet && !(neighborSet.has(a) && neighborSet.has(b));
                return <line key={i} x1={pa.x} y1={pa.y} x2={pb.x} y2={pb.y} className={`graph-edge ${dim ? 'dim' : ''}`} />;
              })}
              {visibleNodes.map((n) => {
                const p = pos.get(n.id);
                if (!p) return null;
                const deg = degree.get(n.id) || 0;
                const r = clamp(4 + Math.sqrt(deg) * 2.4, 4, 15);
                const dim = (neighborSet && !neighborSet.has(n.id)) || (matchSet && !matchSet.has(n.id));
                const showLabel =
                  visibleNodes.length <= 60 ||
                  hoveredId === n.id ||
                  (neighborSet && neighborSet.has(n.id)) ||
                  (matchSet && matchSet.has(n.id));
                return (
                  <g
                    key={n.id}
                    className={`graph-node ${dim ? 'dim' : ''} ${n.id === activeFileId ? 'current' : ''} ${n.isAsset ? 'attachment' : ''}`}
                    transform={`translate(${p.x},${p.y})`}
                    onPointerDown={(e) => onNodePointerDown(e, n.id)}
                    onPointerEnter={() => setHoveredId(n.id)}
                    onPointerLeave={() => setHoveredId((h) => (h === n.id ? null : h))}
                  >
                    <circle r={r} />
                    {showLabel && (
                      <text x={r + 4} y={4} className="graph-node-label">
                        {n.baseName}
                      </text>
                    )}
                  </g>
                );
              })}
            </g>
          </svg>
        </div>
        <div className="graph-modal-footer">
          {visibleNodes.length} notes · {visibleEdges.length} links
        </div>
      </div>
    </div>
  );
}

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
        .map((f) => ({ f, score: fuzzyScore(query, opensInEditorPane(f.kind) ? f.name.replace(/\.[^.]+$/i, '') : f.name) }))
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
                  <span className="palette-result-name">{opensInEditorPane(f.kind) ? f.name.replace(/\.[^.]+$/i, '') : f.name}</span>
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
// ---------------------------------------------------------------------------
// Accent color — user-customizable, persisted to localStorage, applied as
// CSS custom properties on the document root. Every accent-derived color in
// App.css (--accent-hover, --accent-soft, --link-color, --tag-bg,
// --tag-color) is computed from the one base hex here rather than being a
// second hardcoded value, so picking a new accent recolors links, tags,
// active states, and the selection highlight consistently in one place.
// ---------------------------------------------------------------------------
const ACCENT_STORAGE_KEY = 'vault_accent_color';
const DEFAULT_ACCENT = '#8875e0';
const ACCENT_PRESETS = ['#8875e0', '#4f8ef7', '#3fb27f', '#e0a23f', '#e0685f', '#e85d9c', '#5fc3e0', '#9e9e9e'];

function hexToRgbArr(hex) {
  const clean = (hex || DEFAULT_ACCENT).replace('#', '');
  const full = clean.length === 3 ? clean.split('').map((c) => c + c).join('') : clean;
  const n = parseInt(full, 16);
  if (Number.isNaN(n)) return hexToRgbArr(DEFAULT_ACCENT);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
function rgbArrToHex([r, g, b]) {
  const clamp = (v) => Math.max(0, Math.min(255, Math.round(v)));
  return '#' + [r, g, b].map((v) => clamp(v).toString(16).padStart(2, '0')).join('');
}
function lightenRgb(rgb, amount) {
  return rgb.map((v) => v + (255 - v) * amount);
}

function applyAccentColor(hex) {
  const rgb = hexToRgbArr(hex);
  const hoverHex = rgbArrToHex(lightenRgb(rgb, 0.12));
  const linkHex = rgbArrToHex(lightenRgb(rgb, 0.3));
  const root = document.documentElement.style;
  root.setProperty('--accent', hex);
  root.setProperty('--accent-hover', hoverHex);
  root.setProperty('--accent-soft', `rgba(${rgb.join(', ')}, 0.16)`);
  root.setProperty('--link-color', linkHex);
  root.setProperty('--tag-bg', `rgba(${rgb.join(', ')}, 0.14)`);
  root.setProperty('--tag-color', linkHex);
}

function useAccentColor() {
  const [accent, setAccentState] = useState(() => {
    try {
      return localStorage.getItem(ACCENT_STORAGE_KEY) || DEFAULT_ACCENT;
    } catch {
      return DEFAULT_ACCENT;
    }
  });
  useEffect(() => {
    applyAccentColor(accent);
  }, [accent]);
  const setAccent = useCallback((hex) => {
    setAccentState(hex);
    try {
      localStorage.setItem(ACCENT_STORAGE_KEY, hex);
    } catch {
      // localStorage unavailable (private mode, quota) — color still
      // applies for this session via state, just won't persist.
    }
  }, []);
  return [accent, setAccent];
}

function AccentColorPicker({ accent, onChange, onClose, anchorRef, pickerRef }) {
  const [pos, setPos] = useState(null);
  useLayoutEffect(() => {
    const anchor = anchorRef?.current;
    if (!anchor) return;
    const rect = anchor.getBoundingClientRect();
    setPos({ left: rect.left, bottom: window.innerHeight - rect.top + 8 });
  }, [anchorRef]);
  useEffect(() => {
    const onKeyDown = (e) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [onClose]);
  // Portaled to <body> with fixed positioning computed from the anchor's
  // rect — this is what keeps it drawn in front of an open note's editor
  // pane (which otherwise clips an absolutely-positioned popover via its
  // own stacking context) instead of relying on ever-larger z-index values
  // inside that pane's tree.
  if (!pos) return null;
  return createPortal(
    <div
      ref={pickerRef}
      className="accent-picker accent-picker-portal"
      style={{ left: pos.left, bottom: pos.bottom }}
      onClick={(e) => e.stopPropagation()}
    >
      <div className="accent-picker-title">Accent color</div>
      <div className="accent-picker-swatches">
        {ACCENT_PRESETS.map((hex) => (
          <button
            key={hex}
            className={`accent-swatch ${accent.toLowerCase() === hex.toLowerCase() ? 'active' : ''}`}
            style={{ background: hex }}
            title={hex}
            aria-label={`Use accent color ${hex}`}
            onClick={() => onChange(hex)}
          />
        ))}
      </div>
      <label className="accent-picker-custom">
        Custom
        <input type="color" value={accent} onChange={(e) => onChange(e.target.value)} />
      </label>
      {accent !== DEFAULT_ACCENT && (
        <button className="accent-picker-reset" onClick={() => onChange(DEFAULT_ACCENT)}>
          Reset to default
        </button>
      )}
    </div>,
    document.body
  );
}

export default function App() {
  const { token: googleToken, gisReady, signIn, signOut: signOutGoogle } = useGoogleAuth();
  const { proxyToken, signInProxy, signOutProxy } = useProxyAuth();
  const token = googleToken || proxyToken;
  const signOut = useCallback(() => {
    signOutGoogle();
    signOutProxy();
  }, [signOutGoogle, signOutProxy]);

  const [showProxyFolderPicker, setShowProxyFolderPicker] = useState(false);
  const [accentColor, setAccentColor] = useAccentColor();
  const [accentPickerOpen, setAccentPickerOpen] = useState(false);
  const accentPickerAnchorRef = useRef(null);
  // The picker itself now renders through a portal into <body> (see
  // AccentColorPicker), so it's no longer a DOM descendant of the anchor —
  // the outside-click check below needs its own ref too, or clicking a
  // swatch would register as "outside" and close the picker instantly.
  const accentPickerPortalRef = useRef(null);
  useEffect(() => {
    if (!accentPickerOpen) return undefined;
    const onDocMouseDown = (e) => {
      const inAnchor = accentPickerAnchorRef.current && accentPickerAnchorRef.current.contains(e.target);
      const inPortal = accentPickerPortalRef.current && accentPickerPortalRef.current.contains(e.target);
      if (!inAnchor && !inPortal) {
        setAccentPickerOpen(false);
      }
    };
    document.addEventListener('mousedown', onDocMouseDown);
    return () => document.removeEventListener('mousedown', onDocMouseDown);
  }, [accentPickerOpen]);
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
  const [helpOpen, setHelpOpen] = useState(false);
  const [graphOpen, setGraphOpen] = useState(false);
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

  // Flat, deduped, sorted list of every tag used anywhere in the vault —
  // powers the #tag autocomplete dropdown in the editor.
  const allTags = useMemo(() => {
    const set = new Set();
    tagsByFileId.forEach((tags) => tags.forEach((t) => set.add(t)));
    return Array.from(set).sort((a, b) => a.localeCompare(b));
  }, [tagsByFileId]);

  // Every note's frontmatter + inline `key:: value` fields, indexed once
  // for ```query blocks (see QueryBlock/buildPagesIndex above). Same
  // dependency shape as tagsByFileId/allTags: rebuilds only when the set of
  // notes or their indexed bodies actually changes.
  const pagesIndex = useMemo(
    () => buildPagesIndex(sync.filesMeta, sync.linkIndex, vaultIndex.getBody),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [sync.filesMeta, sync.linkIndex, vaultIndex.getBody, vaultIndex.version]
  );

  // --- Content loading (per open tab) --------------------------------------
  const ensureFileLoaded = useCallback(
    (fileId) => {
      if (!fileId || !token) return;
      if (buffers[fileId] || loadingFileIds.current.has(fileId)) return;
      const meta = sync.filesMeta.find((f) => f.id === fileId);
      if (!meta || !opensInEditorPane(meta.kind)) return;
      loadingFileIds.current.add(fileId);
      setBuffers((prev) => ({ ...prev, [fileId]: { content: '', dirty: false, saving: false, loading: true } }));
      driveGetFileContent(token, fileId)
        .then((text) => {
          // Databases aren't part of the note search/tag index — only
          // notes' bodies get indexed for full-text search.
          if (meta.kind === 'note') vaultIndex.updateBody(fileId, text);
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

  // Stable wrappers around openFileInPane for the always-mounted sidebar
  // panels (Explorer/Bookmarks) and the Graph modal. Perf note: without
  // these, the inline `(id) => openFileInPane(...)` arrows written directly
  // in JSX get a new identity every time App re-renders — which happens on
  // every keystroke, since note content lives in App-level `buffers` state.
  // A new function identity defeats React.memo on ExplorerPanel/TreeNode/
  // BookmarksPanel, so the entire sidebar tree was re-rendering per
  // keystroke even though nothing in it actually changed. These two
  // references only change when the active pane does.
  const handleSidebarOpenFile = useCallback(
    (id, e) => openFileInPane(activePaneId, id, { newTab: !!(e && (e.metaKey || e.ctrlKey)) }),
    [activePaneId, openFileInPane]
  );
  const handleSidebarOpenImage = useCallback(
    (file, e) => openFileInPane(activePaneId, file.id, { newTab: !!(e && (e.metaKey || e.ctrlKey)) }),
    [activePaneId, openFileInPane]
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

  const handleCreateDatabaseIn = useCallback(
    (parentId) => {
      const name = window.prompt('New database name:');
      if (!name || !name.trim()) return;
      (async () => {
        try {
          const skeleton = serializeDatabaseState(makeDefaultDatabaseState(name.trim()));
          const created = await driveCreateFile(token, parentId, name.trim(), skeleton, 'base', 'application/json');
          const fileRecord = {
            id: created.id,
            name: created.name,
            modifiedTime: created.modifiedTime || new Date().toISOString(),
            parents: [parentId],
            kind: 'database'
          };
          sync.registerNewFile(fileRecord);
          setBuffers((prev) => ({ ...prev, [created.id]: { content: skeleton, dirty: false, saving: false, loading: false } }));
          openFileInPane(activePaneId, created.id);
        } catch (err) {
          window.alert(`Couldn't create database: ${err.message}`);
        }
      })();
    },
    [token, sync, activePaneId, openFileInPane]
  );

  const handleCreateCanvasIn = useCallback(
    (parentId) => {
      const name = window.prompt('New canvas name:');
      if (!name || !name.trim()) return;
      (async () => {
        try {
          const skeleton = serializeCanvasState(makeDefaultCanvasState());
          const created = await driveCreateFile(token, parentId, name.trim(), skeleton, 'canvas', 'application/json');
          const fileRecord = {
            id: created.id,
            name: created.name,
            modifiedTime: created.modifiedTime || new Date().toISOString(),
            parents: [parentId],
            kind: 'canvas'
          };
          sync.registerNewFile(fileRecord);
          setBuffers((prev) => ({ ...prev, [created.id]: { content: skeleton, dirty: false, saving: false, loading: false } }));
          openFileInPane(activePaneId, created.id);
        } catch (err) {
          window.alert(`Couldn't create canvas: ${err.message}`);
        }
      })();
    },
    [token, sync, activePaneId, openFileInPane]
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
          const kind = classifyKind(created.name, created.mimeType);
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

  // Uploads a single binary file for a database attachment cell (image/
  // video/audio/file column types), registering it in the vault the same
  // way a sidebar upload would — so it's a real Drive file, not something
  // hidden inside the database's JSON.
  const uploadAttachmentFile = useCallback(
    async (parentId, file) => {
      if (!token) throw new Error('Uploading requires Google sign-in.');
      const created = await driveUploadBinary(token, parentId, file);
      const kind = classifyKind(created.name, created.mimeType);
      sync.registerNewFile({
        id: created.id,
        name: created.name,
        modifiedTime: created.modifiedTime || new Date().toISOString(),
        parents: [parentId],
        kind
      });
      return { id: created.id, name: created.name, kind };
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
      const isPage = node.type === 'file' && opensInEditorPane(node.kind);
      const isAsset = node.type === 'file' && !isPage;
      const currentDisplayName = node.type === 'file' && isPage ? node.name.replace(/\.[^.]+$/i, '') : node.name;
      const input = window.prompt('Rename to:', currentDisplayName);
      if (!input || !input.trim() || input.trim() === currentDisplayName) return;

      let newName;
      if (node.type !== 'file') {
        newName = input.trim();
      } else if (isAsset) {
        const typed = input.trim();
        newName = fileExtension(typed) ? typed : `${typed}.${fileExtension(node.name) || 'bin'}`;
      } else {
        const suffix = `.${extensionForKind(node.kind)}`;
        newName = input.trim().toLowerCase().endsWith(suffix) ? input.trim() : `${input.trim()}${suffix}`;
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
      const isPage = opensInEditorPane(file.kind);
      const currentDisplayName = isPage ? file.name.replace(/\.[^.]+$/i, '') : file.name;
      if (trimmed === currentDisplayName) return;
      let newName;
      if (isPage) {
        const suffix = `.${extensionForKind(file.kind)}`;
        newName = trimmed.toLowerCase().endsWith(suffix) ? trimmed : `${trimmed}${suffix}`;
      } else {
        newName = fileExtension(trimmed) ? trimmed : `${trimmed}.${fileExtension(file.name) || 'bin'}`;
      }
      performRename(fileId, 'file', file.kind, newName);
    },
    [filesById, performRename]
  );

  const handleDeleteNode = useCallback(
    async (node) => {
      const isPage = node.type === 'file' && opensInEditorPane(node.kind);
      const label = node.type === 'file' && isPage ? node.name.replace(/\.[^.]+$/i, '') : node.name;
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

  // Selected text in the active editor, so the status bar can show
  // selection-scoped word/char counts instead of the whole note's — null
  // when nothing's selected.
  const [editorSelectionText, setEditorSelectionText] = useState(null);

  // Bridge for the Outline panel: the currently-active pane's EditorContent
  // registers its scroll-to-heading function here (see the comment in
  // EditorContent), and onNavigateToHeading below just forwards to whatever
  // is currently registered. A ref, not state — this changes on every pane
  // focus / mode toggle and doesn't need to trigger a re-render itself.
  const activeEditorNavRef = useRef(null);

  const handlers = useMemo(
    () => ({
      token,
      onOpenById: (id) => openFileInPane(activePaneId, id),
      onCreateOrOpenByName: (name) => openNoteByName(name),
      onOpenImage: (file) => openFileInPane(activePaneId, file.id),
      onOpenAsset: (file) => openFileInPane(activePaneId, file.id),
      onRenameFile: (fileId, newDisplayName) => handleInlineRenameFile(fileId, newDisplayName),
      onOpenTag: (tag) => {
        setActiveSideView('search');
        setSearchQuery(`tag:${tag}`);
        setMobileDockOpen(true);
      },
      onEditorSelectionChange: setEditorSelectionText,
      registerActiveEditorNav: (fn) => {
        activeEditorNavRef.current = fn;
      },
      onNavigateToHeading: (lineIndex, headingId) => {
        activeEditorNavRef.current?.(lineIndex, headingId);
        setMobileDockOpen(false);
      },
      uploadAttachment: uploadAttachmentFile,
      allTags,
      pagesIndex,
      ensureVaultIndexed: vaultIndex.ensureIndexed,
      vaultIndexReady: vaultIndex.ready,
      vaultIndexProgress: vaultIndex.progress,
      getBody: vaultIndex.getBody
    }),
    [
      token,
      openFileInPane,
      activePaneId,
      openNoteByName,
      handleInlineRenameFile,
      uploadAttachmentFile,
      allTags,
      pagesIndex,
      vaultIndex.ensureIndexed,
      vaultIndex.ready,
      vaultIndex.progress,
      vaultIndex.getBody
    ]
  );

  const handlePaletteFilePick = useCallback(
    (file, opts) => {
      setPaletteMode(null);
      openFileInPane(activePaneId, file.id, { ...opts, newTab: opts?.newTab || paletteForceNewTabRef.current });
      paletteForceNewTabRef.current = false;
    },
    [activePaneId, openFileInPane]
  );

  const commands = useMemo(() => {
    if (!folder) return [];
    return [
      { id: 'new-note', label: 'Create new note', icon: <IconFilePlus size={15} />, run: () => handleCreateNoteIn(folder.id) },
      { id: 'new-canvas', label: 'Create new canvas', icon: <IconCanvasKind size={15} />, run: () => handleCreateCanvasIn(folder.id) },
      { id: 'new-database', label: 'Create new database', icon: <IconDatabase size={15} />, run: () => handleCreateDatabaseIn(folder.id) },
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
      { id: 'open-graph', label: 'Open graph view', icon: <IconGraph size={15} />, run: () => setGraphOpen(true) },
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
  }, [folder, handleCreateNoteIn, handleCreateDatabaseIn, handleCreateCanvasIn, handleCreateFolderIn, activePaneId, splitPane, paneTree, toggleTabMode, sync, handlePickFolder, signOut]);

  const handlePaletteCommand = useCallback((cmd) => {
    setPaletteMode(null);
    cmd.run();
  }, []);

  if (!token) {
    return <OnboardingFlow step="signin" onSignIn={signIn} ready={gisReady} onSignInProxy={signInProxy} />;
  }
  if (folderRestoring) {
    const { label, pct } = loadingStepProps({ phase: 'opening', loaded: 0, total: 0 });
    return <OnboardingFlow step="loading" loadingLabel={label} loadingPct={pct} />;
  }
  if (!folder) {
    if (showProxyFolderPicker) {
      return <OnboardingFlow step="proxy-folder" proxyToken={token} onProxyFolderPick={handleProxyFolderPicked} />;
    }
    return <OnboardingFlow step="folder" onPickFolder={handlePickFolder} />;
  }
  if (!sync.cacheLoaded) {
    const { label, pct } = loadingStepProps({ phase: 'opening', loaded: 0, total: 0 });
    return <OnboardingFlow step="loading" loadingLabel={label} loadingPct={pct} />;
  }
  if (sync.filesMeta.length === 0 && sync.syncing) {
    const { label, pct } = loadingStepProps(sync.syncProgress);
    return <OnboardingFlow step="loading" loadingLabel={label} loadingPct={pct} />;
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
          onOpenGraph={() => setGraphOpen(true)}
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
                onOpenFile={handleSidebarOpenFile}
                onOpenImage={handleSidebarOpenImage}
                onCreateNote={handleCreateNoteIn}
                onCreateDatabase={handleCreateDatabaseIn}
                onCreateCanvas={handleCreateCanvasIn}
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
            {activeSideView === 'toc' && (
              <TocPanel
                file={activeFileForStatus}
                content={activeContentForStatus}
                onNavigate={handlers.onNavigateToHeading}
              />
            )}
            {activeSideView === 'bookmarks' && (
              <BookmarksPanel
                bookmarks={bookmarks}
                filesMeta={sync.filesMeta}
                onOpenFile={handleSidebarOpenFile}
                onOpenImage={handleSidebarOpenImage}
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
              <div className="accent-picker-anchor" ref={accentPickerAnchorRef}>
                <button
                  className="icon-btn"
                  title="Accent color"
                  onClick={() => setAccentPickerOpen((v) => !v)}
                >
                  <IconPalette size={15} />
                </button>
                {accentPickerOpen && (
                  <AccentColorPicker
                    accent={accentColor}
                    onChange={setAccentColor}
                    onClose={() => setAccentPickerOpen(false)}
                    anchorRef={accentPickerAnchorRef}
                    pickerRef={accentPickerPortalRef}
                  />
                )}
              </div>
              <button className="icon-btn" title="Keyboard shortcuts" onClick={() => setHelpOpen(true)}>
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
        selectionText={editorSelectionText}
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
      {helpOpen && <HelpModal onClose={() => setHelpOpen(false)} />}
      {graphOpen && (
        <GraphViewModal
          onClose={() => setGraphOpen(false)}
          linkIndex={sync.linkIndex}
          linksByFileId={sync.linksByFileId}
          onOpenFile={handleSidebarOpenFile}
          activeFileId={activeFileForStatus?.id}
        />
      )}
      {showProxyFolderPicker && (
        <ProxyFolderBrowser
          token={token}
          onPick={handleProxyFolderPicked}
          onCancel={() => setShowProxyFolderPicker(false)}
          variant="modal"
        />
      )}
    </div>
  );
}
