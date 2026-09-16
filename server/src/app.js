import cors from 'cors';
import express from 'express';

import { config } from './config.js';
import { authRouter } from './routes/auth.js';
import { driveRouter } from './routes/drive.js';

// Factored out of index.js so both the long-running Node entrypoint
// (index.js, for Render/any plain Node host) and the Vercel serverless
// entrypoint (api/index.js) construct the exact same app — no route/CORS
// config duplicated or drifting between the two hosting paths.
//
// There used to be a third router here (statementsRouter) proxying to a
// separate Python process for phrase-similarity/spellcheck. That's gone —
// see TODO.md — the Statements spark category now runs entirely
// client-side (src/lib/statementsEngine.js and friends), so this backend
// no longer has any compute-heavy route, just auth + Drive proxying.
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
