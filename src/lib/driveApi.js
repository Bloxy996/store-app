import { API_KEY, APP_ID, DRIVE_FILES_URL, DRIVE_UPLOAD_URL, classifyKind } from './vaultConfig.js';


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
      .setTitle('Select your store folder')
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

export { DRIVE_ALL_DRIVES, isProxy, proxyGet, proxyPost, driveBrowseFolders, driveResolveFolder, extractDriveFolderId, chunkArray, driveError, driveListFolderTree, driveListVaultContentInFolders, driveListVaultFiles, driveGetFileContent, driveGetFileBlob, driveUpdateFileContent, driveCreateFile, driveUploadBinary, driveCreateFolder, driveRenameItem, driveMoveItem, driveTrashItem, loadScriptOnce, ensurePickerLoaded, openFolderPicker };
