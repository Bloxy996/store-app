import express, { Router } from 'express';

import * as drive from '../driveClient.js';
import { ensureFreshAccessToken } from '../googleAuth.js';
import { getSession } from '../session.js';

const router = Router();

// Every route here needs a fresh access token; refreshing (and, on a dead
// refresh token, clearing the session) happens in one place instead of
// once per handler.
async function requireAuth(req, res, next) {
  const session = await getSession(req, res);
  try {
    req.accessToken = await ensureFreshAccessToken(session);
    req.session = session;
    next();
  } catch (err) {
    if (err.code === 'invalid_grant') await session.destroy();
    res.status(401).json({ error: 'Not signed in' });
  }
}

// Drive errors carry an HTTP status (see driveClient.js's driveError) —
// forward that instead of collapsing everything to a generic 500, so the
// frontend's existing driveError()-based handling (e.g. treating a 404 as
// "file was deleted elsewhere") keeps working unchanged.
function handleDriveError(res, err, label) {
  if (err.status) {
    res.status(err.status).json({ error: `${label} (${err.status})` });
    return;
  }
  console.error(label, err);
  res.status(502).json({ error: label });
}

router.get('/api/drive/folder-tree', requireAuth, async (req, res) => {
  try {
    const folders = await drive.listFolderTree(req.accessToken, req.query.root);
    res.json({ folders });
  } catch (err) {
    handleDriveError(res, err, 'Drive folder list failed');
  }
});

router.get('/api/drive/vault-content', requireAuth, async (req, res) => {
  try {
    const folderIds = String(req.query.folders || '').split(',').filter(Boolean);
    const files = await drive.listVaultContentInFolders(req.accessToken, folderIds);
    res.json({ files });
  } catch (err) {
    handleDriveError(res, err, 'Drive list failed');
  }
});

router.get('/api/drive/file/:id/content', requireAuth, async (req, res) => {
  try {
    const content = await drive.getFileContent(req.accessToken, req.params.id);
    res.type('text/plain').send(content);
  } catch (err) {
    handleDriveError(res, err, 'Drive fetch failed');
  }
});

router.get('/api/drive/file/:id/metadata', requireAuth, async (req, res) => {
  try {
    const metadata = await drive.getFileMetadata(req.accessToken, req.params.id);
    res.json(metadata);
  } catch (err) {
    handleDriveError(res, err, 'Drive metadata fetch failed');
  }
});

// Streamed straight through with the original content-type — used for
// images/video/audio, which can be arbitrarily large; buffering the whole
// thing into a JS string/base64 (like the Apps-Script proxy mode has to)
// would be wasteful here since this route can just pipe bytes.
router.get('/api/drive/file/:id/blob', requireAuth, async (req, res) => {
  try {
    const upstream = await drive.getFileRaw(req.accessToken, req.params.id);
    res.status(upstream.status);
    const contentType = upstream.headers.get('content-type');
    if (contentType) res.type(contentType);
    const body = Buffer.from(await upstream.arrayBuffer());
    res.send(body);
  } catch (err) {
    handleDriveError(res, err, 'Drive fetch failed');
  }
});

router.patch(
  '/api/drive/file/:id/content',
  requireAuth,
  express.text({ type: '*/*', limit: '25mb' }),
  async (req, res) => {
    try {
      const result = await drive.updateFileContent(req.accessToken, req.params.id, req.body);
      res.json(result);
    } catch (err) {
      handleDriveError(res, err, 'Drive save failed');
    }
  }
);

router.post('/api/drive/file', requireAuth, express.json(), async (req, res) => {
  try {
    const { folderId, name, content = '', mimeType = 'text/markdown' } = req.body || {};
    const result = await drive.createFile(req.accessToken, folderId, name, content, mimeType);
    res.json(result);
  } catch (err) {
    handleDriveError(res, err, 'Drive create failed');
  }
});

// Binary bytes go in the raw request body; metadata rides along as
// headers, since a multipart/form-data parser is more machinery than this
// one route needs.
router.post(
  '/api/drive/file/upload',
  requireAuth,
  express.raw({ type: '*/*', limit: '200mb' }),
  async (req, res) => {
    try {
      const folderId = req.get('X-Folder-Id');
      const name = req.get('X-File-Name');
      const mimeType = req.get('X-Mime-Type') || req.get('Content-Type');
      if (!folderId || !name) {
        res.status(400).json({ error: 'Missing X-Folder-Id or X-File-Name header' });
        return;
      }
      const result = await drive.uploadBinary(req.accessToken, folderId, decodeURIComponent(name), mimeType, req.body);
      res.json(result);
    } catch (err) {
      handleDriveError(res, err, 'Drive upload failed');
    }
  }
);

router.post('/api/drive/folder', requireAuth, express.json(), async (req, res) => {
  try {
    const { parentId, name } = req.body || {};
    const result = await drive.createFolder(req.accessToken, parentId, name);
    res.json(result);
  } catch (err) {
    handleDriveError(res, err, 'Drive folder create failed');
  }
});

router.patch('/api/drive/item/:id/rename', requireAuth, express.json(), async (req, res) => {
  try {
    const { name } = req.body || {};
    const result = await drive.renameItem(req.accessToken, req.params.id, name);
    res.json(result);
  } catch (err) {
    handleDriveError(res, err, 'Drive rename failed');
  }
});

router.patch('/api/drive/item/:id/move', requireAuth, express.json(), async (req, res) => {
  try {
    const { newParentId, oldParentId } = req.body || {};
    const result = await drive.moveItem(req.accessToken, req.params.id, newParentId, oldParentId);
    res.json(result);
  } catch (err) {
    handleDriveError(res, err, 'Drive move failed');
  }
});

router.patch('/api/drive/item/:id/trash', requireAuth, async (req, res) => {
  try {
    const result = await drive.trashItem(req.accessToken, req.params.id);
    res.json(result);
  } catch (err) {
    handleDriveError(res, err, 'Drive delete failed');
  }
});

export { router as driveRouter };
