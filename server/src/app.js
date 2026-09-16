import cors from 'cors';
import express from 'express';

import { config } from './config.js';
import { authRouter } from './routes/auth.js';
import { driveRouter } from './routes/drive.js';
import { statementsRouter } from './routes/statements.js';

// Factored out of index.js so both the long-running Node entrypoint
// (index.js, for Render/any plain Node host) and the Vercel serverless
// entrypoint (api/index.js) construct the exact same app — no route/CORS
// config duplicated or drifting between the two hosting paths.
//
// Note: this only wraps the Node/Express half. The Python service
// (server/python/) that statementsRouter proxies to is a separate,
// long-running process (sentence-transformers/torch stay resident in
// memory across requests, per its README) — it isn't part of this
// factory and isn't a Vercel serverless candidate either; see
// vercel.json's header comment and TODO.md.
function createApp() {
  const app = express();

  // credentials:true is required for the session cookie to travel with
  // cross-origin fetches from the frontend (e.g. GitHub Pages/Render, two
  // different domains). When frontend and backend are deployed together
  // on Vercel (same origin, see /vercel.json) this is harmless — same-origin
  // requests aren't subject to CORS in the first place.
  app.use(
    cors({
      origin: config.frontendUrls,
      credentials: true
    })
  );

  app.get('/healthz', (req, res) => res.json({ ok: true }));

  app.use(authRouter);
  app.use(driveRouter);
  app.use(statementsRouter);

  app.use((err, req, res, next) => {
    console.error('Unhandled error:', err);
    if (res.headersSent) {
      next(err);
      return;
    }
    res.status(500).json({ error: 'Internal server error' });
  });

  return app;
}

export { createApp };
