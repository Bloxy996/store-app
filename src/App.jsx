import React, { useCallback, useEffect, useRef, useState } from 'react';

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
const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.file';

const DRIVE_FILES_URL = 'https://www.googleapis.com/drive/v3/files';
const DRIVE_UPLOAD_URL = 'https://www.googleapis.com/upload/drive/v3/files';

const DB_NAME = 'vault-cache-db';
const DB_VERSION = 1;
const STORE_FILES = 'files'; // { id, name, modifiedTime, parents }  -- metadata only
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
// Google Drive REST wrapper (drive.file scope)
// ---------------------------------------------------------------------------
async function driveListMarkdownFiles(token, folderId) {
  const q = encodeURIComponent(
    `'${folderId}' in parents and trashed = false and (mimeType = 'text/markdown' or mimeType = 'text/plain' or fileExtension = 'md')`
  );
  const fields = encodeURIComponent('files(id,name,modifiedTime,parents),nextPageToken');
  let files = [];
  let pageToken = '';
  do {
    const url = `${DRIVE_FILES_URL}?q=${q}&fields=${fields}&pageSize=1000&orderBy=name${
      pageToken ? `&pageToken=${pageToken}` : ''
    }`;
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) throw new Error(`Drive list failed (${res.status})`);
    const data = await res.json();
    files = files.concat(data.files || []);
    pageToken = data.nextPageToken || '';
  } while (pageToken);
  return files;
}

async function driveGetFileContent(token, fileId) {
  const res = await fetch(`${DRIVE_FILES_URL}/${fileId}?alt=media`, {
    headers: { Authorization: `Bearer ${token}` }
  });
  if (!res.ok) throw new Error(`Drive fetch failed (${res.status})`);
  return res.text();
}

async function driveUpdateFileContent(token, fileId, content) {
  const res = await fetch(`${DRIVE_UPLOAD_URL}/${fileId}?uploadType=media`, {
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
  const res = await fetch(`${DRIVE_UPLOAD_URL}?uploadType=multipart&fields=id,name,modifiedTime,parents`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': `multipart/related; boundary=${boundary}` },
    body
  });
  if (!res.ok) throw new Error(`Drive create failed (${res.status})`);
  return res.json();
}

// ---------------------------------------------------------------------------
// Google Picker (folder selection under drive.file scope)
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
      // Source of truth: live Drive listing (id + modifiedTime).
      const remoteFiles = await driveListMarkdownFiles(token, folder.id);

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
      const staleIds = cachedFiles.map((f) => f.id).filter((id) => !remoteIds.has(id));

      // Persist ONLY metadata + link graph. Content is discarded here.
      await Promise.all([
        idbPutMany(STORE_FILES, remoteFiles),
        idbPutMany(STORE_LINKS, freshLinkRecords),
        idbDeleteMany(STORE_FILES, staleIds),
        idbDeleteMany(STORE_LINKS, staleIds)
      ]);

      setFilesMeta(remoteFiles);
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

  return { filesMeta, linksByFileId, backlinkIndex, syncing, syncError, lastSyncedAt, syncNow, applyLocalEdit, registerNewFile };
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

function TopBar({ folderName, syncing, syncError, onSync, onNewNote, onSignOut, onToggleSidebar, dirty, saving }) {
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
        <button className="icon-btn" onClick={onSync} title="Sync now" disabled={syncing}>
          {syncing ? '…' : '⟳'}
        </button>
        <button className="icon-btn" onClick={onSignOut} title="Sign out">⏻</button>
      </div>
    </header>
  );
}

function Sidebar({ files, currentId, onOpenFile, search, setSearch, backlinks }) {
  const filtered = files.filter((f) => f.name.toLowerCase().includes(search.toLowerCase()));
  return (
    <aside className="sidebar">
      <input
        className="search-input"
        placeholder="Search notes…"
        value={search}
        onChange={(e) => setSearch(e.target.value)}
      />
      <nav className="file-list">
        {filtered.map((f) => (
          <button
            key={f.id}
            className={`file-item ${f.id === currentId ? 'active' : ''}`}
            onClick={() => onOpenFile(f.id)}
          >
            {f.name.replace(/\.md$/i, '')}
          </button>
        ))}
        {filtered.length === 0 && <p className="muted small">No notes match.</p>}
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

  const handlePickFolder = useCallback(async () => {
    if (!token) return;
    const picked = await openFolderPicker(token);
    if (picked) {
      setFolder(picked);
      idbPut(STORE_META, { key: 'vaultFolder', value: picked });
    }
  }, [token]);

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

  const handleNewNote = useCallback(() => {
    const name = window.prompt('New note name:');
    if (name && name.trim()) navigateTo(() => openNoteByName(name.trim()));
  }, [navigateTo, openNoteByName]);

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
        onNewNote={handleNewNote}
        onSignOut={signOut}
        onToggleSidebar={() => setSidebarOpen((v) => !v)}
        dirty={dirty}
        saving={saving}
      />
      <div className={`workspace ${sidebarOpen ? 'sidebar-open' : ''}`}>
        <Sidebar
          files={sync.filesMeta}
          currentId={currentFile?.id}
          onOpenFile={(id) => navigateTo(() => openNoteById(id))}
          search={search}
          setSearch={setSearch}
          backlinks={backlinksForCurrent}
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
