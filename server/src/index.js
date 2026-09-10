import cors from 'cors';
import express from 'express';

import { config } from './config.js';
import { authRouter } from './routes/auth.js';
import { driveRouter } from './routes/drive.js';

const app = express();

// credentials:true is required for the session cookie to travel with
// cross-origin fetches from the frontend (a different domain in
// production — GitHub Pages/static host vs this server).
app.use(
  cors({
    origin: config.frontendUrls,
    credentials: true
  })
);

app.get('/healthz', (req, res) => res.json({ ok: true }));

app.use(authRouter);
app.use(driveRouter);

app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  if (res.headersSent) {
    next(err);
    return;
  }
  res.status(500).json({ error: 'Internal server error' });
});

app.listen(config.port, () => {
  console.log(`store backend listening on :${config.port}`);
});
