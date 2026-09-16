import express, { Router } from 'express';

import { config } from '../config.js';
import { getSession } from '../session.js';

const router = Router();
const jsonBody = express.json();

// These routes don't touch Drive (no accessToken needed, unlike drive.js's
// requireAuth) — this just gates the Python service's compute-heavy
// endpoints behind a signed-in session instead of leaving them open to
// anyone who finds the URL.
async function requireSession(req, res, next) {
  const session = await getSession(req, res);
  if (!session.refreshToken) {
    res.status(401).json({ error: 'Not signed in' });
    return;
  }
  next();
}

async function forward(res, path, body) {
  try {
    const upstream = await fetch(`${config.pythonServiceUrl}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {})
    });
    const data = await upstream.json().catch(() => ({}));
    if (!upstream.ok) {
      res.status(upstream.status).json(data.error ? data : { error: 'Statements service error' });
      return;
    }
    res.json(data);
  } catch (err) {
    console.error('Statements service unreachable:', err);
    res.status(502).json({ error: 'Statements service is not running (see server/python/README.md)' });
  }
}

router.post('/api/statements/sort', jsonBody, requireSession, (req, res) => forward(res, '/statements/sort', req.body));
router.post('/api/statements/insert', jsonBody, requireSession, (req, res) => forward(res, '/statements/insert', req.body));
router.post('/api/statements/lookup', jsonBody, requireSession, (req, res) => forward(res, '/statements/lookup', req.body));
router.post('/api/statements/spellcheck', jsonBody, requireSession, (req, res) => forward(res, '/statements/spellcheck', req.body));

export { router as statementsRouter };
