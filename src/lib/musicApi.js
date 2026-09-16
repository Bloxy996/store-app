import { BACKEND_URL } from './vaultConfig.js';

// /api/music/download (server/src/routes/music.js) does the download (via
// the Python service — server/python/README.md) AND the Drive upload
// server-side in one request, since it already needs a fresh Drive access
// token for the upload half — see that route for why. Returns
// { uploaded: [{url,title,artist,driveFileId,name}], failed: [{url,error}] }.
async function downloadMusic({ links, folderId, embedIcon = true, workers }) {
  const res = await fetch(`${BACKEND_URL}/api/music/download`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ links, folderId, embedIcon, workers })
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Music download failed (${res.status})`);
  return data;
}

export { downloadMusic };
