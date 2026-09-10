// Server-side counterpart to src/lib/driveApi.js's old direct-OAuth
// branch. Logic is intentionally a straight port — same query shapes, same
// pagination, same supportsAllDrives handling — so behavior doesn't shift
// as part of moving where it runs. See driveApi.js for the reasoning
// comments on DRIVE_ALL_DRIVES / the folder-tree BFS / etc.; not repeated
// here to avoid the two copies drifting out of sync in wording only.

const DRIVE_FILES_URL = 'https://www.googleapis.com/drive/v3/files';
const DRIVE_UPLOAD_URL = 'https://www.googleapis.com/upload/drive/v3/files';
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

function authHeaders(accessToken, extra = {}) {
  return { Authorization: `Bearer ${accessToken}`, ...extra };
}

async function listFolderTree(accessToken, rootFolderId) {
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
          const res = await fetch(url, { headers: authHeaders(accessToken) });
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

async function listVaultContentInFolders(accessToken, folderIds) {
  const chunks = chunkArray(folderIds, 10);
  const chunkResults = await Promise.all(
    chunks.map(async (chunk) => {
      const parentClauses = chunk.map((id) => `'${id}' in parents`).join(' or ');
      const q = encodeURIComponent(`(${parentClauses}) and trashed = false and not mimeType contains 'vnd.google-apps'`);
      const fields = encodeURIComponent('files(id,name,modifiedTime,parents,mimeType,size),nextPageToken');
      let pageToken = '';
      const found = [];
      do {
        const url = `${DRIVE_FILES_URL}?q=${q}&fields=${fields}&pageSize=1000&orderBy=name&${DRIVE_ALL_DRIVES}${
          pageToken ? `&pageToken=${pageToken}` : ''
        }`;
        const res = await fetch(url, { headers: authHeaders(accessToken) });
        if (!res.ok) throw driveError(res, 'Drive list failed');
        const data = await res.json();
        found.push(...(data.files || []));
        pageToken = data.nextPageToken || '';
      } while (pageToken);
      return found;
    })
  );
  return chunkResults.flat();
}

async function getFileContent(accessToken, fileId) {
  const res = await fetch(`${DRIVE_FILES_URL}/${fileId}?alt=media&${DRIVE_ALL_DRIVES}`, { headers: authHeaders(accessToken) });
  if (!res.ok) throw driveError(res, 'Drive fetch failed');
  return res.text();
}

async function getFileMetadata(accessToken, fileId) {
  const fields = encodeURIComponent('id,name,modifiedTime,parents');
  const res = await fetch(`${DRIVE_FILES_URL}/${fileId}?fields=${fields}&${DRIVE_ALL_DRIVES}`, { headers: authHeaders(accessToken) });
  if (!res.ok) throw driveError(res, 'Drive metadata fetch failed');
  return res.json();
}

// Returns the raw Response so the route can stream bytes + content-type
// straight through without buffering the whole file in memory twice.
async function getFileRaw(accessToken, fileId) {
  const res = await fetch(`${DRIVE_FILES_URL}/${fileId}?alt=media&${DRIVE_ALL_DRIVES}`, { headers: authHeaders(accessToken) });
  if (!res.ok) throw driveError(res, 'Drive fetch failed');
  return res;
}

async function updateFileContent(accessToken, fileId, content) {
  const res = await fetch(`${DRIVE_UPLOAD_URL}/${fileId}?uploadType=media&${DRIVE_ALL_DRIVES}`, {
    method: 'PATCH',
    headers: authHeaders(accessToken, { 'Content-Type': 'text/markdown' }),
    body: content
  });
  if (!res.ok) throw driveError(res, 'Drive save failed');
  return res.json();
}

async function createFile(accessToken, folderId, name, content, mimeType) {
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
    headers: authHeaders(accessToken, { 'Content-Type': `multipart/related; boundary=${boundary}` }),
    body
  });
  if (!res.ok) throw driveError(res, 'Drive create failed');
  return res.json();
}

// bytes: a Buffer/Uint8Array of the raw file contents.
async function uploadBinary(accessToken, folderId, name, mimeType, bytes) {
  const metadata = { name, parents: [folderId], mimeType: mimeType || 'application/octet-stream' };
  const boundary = `vault-${Date.now()}`;
  const head = Buffer.from(
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n--${boundary}\r\nContent-Type: ${
      metadata.mimeType
    }\r\n\r\n`
  );
  const tail = Buffer.from(`\r\n--${boundary}--`);
  const body = Buffer.concat([head, Buffer.from(bytes), tail]);
  const res = await fetch(`${DRIVE_UPLOAD_URL}?uploadType=multipart&fields=id,name,modifiedTime,parents,mimeType&${DRIVE_ALL_DRIVES}`, {
    method: 'POST',
    headers: authHeaders(accessToken, { 'Content-Type': `multipart/related; boundary=${boundary}` }),
    body
  });
  if (!res.ok) throw driveError(res, 'Drive upload failed');
  return res.json();
}

async function createFolder(accessToken, parentId, name) {
  const res = await fetch(`${DRIVE_FILES_URL}?fields=id,name,parents&${DRIVE_ALL_DRIVES}`, {
    method: 'POST',
    headers: authHeaders(accessToken, { 'Content-Type': 'application/json' }),
    body: JSON.stringify({ name, parents: [parentId], mimeType: 'application/vnd.google-apps.folder' })
  });
  if (!res.ok) throw driveError(res, 'Drive folder create failed');
  return res.json();
}

async function renameItem(accessToken, id, newName) {
  const res = await fetch(`${DRIVE_FILES_URL}/${id}?fields=id,name&${DRIVE_ALL_DRIVES}`, {
    method: 'PATCH',
    headers: authHeaders(accessToken, { 'Content-Type': 'application/json' }),
    body: JSON.stringify({ name: newName })
  });
  if (!res.ok) throw driveError(res, 'Drive rename failed');
  return res.json();
}

async function moveItem(accessToken, id, newParentId, oldParentId) {
  const res = await fetch(
    `${DRIVE_FILES_URL}/${id}?addParents=${newParentId}&removeParents=${oldParentId}&fields=id,parents&${DRIVE_ALL_DRIVES}`,
    { method: 'PATCH', headers: authHeaders(accessToken) }
  );
  if (!res.ok) throw driveError(res, 'Drive move failed');
  return res.json();
}

async function trashItem(accessToken, id) {
  const res = await fetch(`${DRIVE_FILES_URL}/${id}?${DRIVE_ALL_DRIVES}`, {
    method: 'PATCH',
    headers: authHeaders(accessToken, { 'Content-Type': 'application/json' }),
    body: JSON.stringify({ trashed: true })
  });
  if (!res.ok) throw driveError(res, 'Drive delete failed');
  return res.json();
}

export {
  listFolderTree,
  listVaultContentInFolders,
  getFileContent,
  getFileMetadata,
  getFileRaw,
  updateFileContent,
  createFile,
  uploadBinary,
  createFolder,
  renameItem,
  moveItem,
  trashItem
};
