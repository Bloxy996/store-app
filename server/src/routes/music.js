import express, { Router } from 'express';

import { config } from '../config.js';
import * as drive from '../driveClient.js';
import { requireAuth } from './drive.js';

const router = Router();

// Downloads happen in the Python service (yt-dlp + ffmpeg — see
// server/python/README.md), which has no Drive access of its own; this
// route is the one place that both talks to it AND holds a Drive access
// token, so it's also the one place responsible for landing the results in
// the user's vault — same driveClient.uploadBinary the /api/drive/file/
// upload route uses for any other binary upload.
router.post('/api/music/download', requireAuth, express.json(), async (req, res) => {
  const { links, folderId, embedIcon = true, workers } = req.body || {};
  if (!folderId) {
    res.status(400).json({ error: 'Missing folderId — pick a vault folder to save downloads into' });
    return;
  }
  if (!Array.isArray(links) || !links.filter((l) => String(l || '').trim()).length) {
    res.status(400).json({ error: 'No links provided' });
    return;
  }

  let upstream;
  try {
    upstream = await fetch(`${config.statementsServiceUrl}/music/download`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ links, embedIcon, workers })
    });
  } catch (err) {
    console.error('Music service unreachable:', err);
    res.status(502).json({ error: 'Music download service is not running (see server/python/README.md)' });
    return;
  }
  const data = await upstream.json().catch(() => ({}));
  if (!upstream.ok) {
    res.status(upstream.status).json(data.error ? data : { error: 'Music download failed' });
    return;
  }

  const uploaded = [];
  const failed = [...(data.errors || [])];
  for (const file of data.files || []) {
    try {
      const bytes = Buffer.from(file.dataBase64, 'base64');
      const result = await drive.uploadBinary(req.accessToken, folderId, file.filename, file.mimeType, bytes);
      uploaded.push({ url: file.sourceUrl, title: file.title, artist: file.artist, driveFileId: result.id, name: result.name });
    } catch (err) {
      failed.push({ url: file.sourceUrl, error: err.message || 'Drive upload failed' });
    }
  }
  res.json({ uploaded, failed });
});

export { router as musicRouter };
