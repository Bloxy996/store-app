import crypto from 'node:crypto';

import { Router } from 'express';

import { config } from '../config.js';
import { buildAuthUrl, ensureFreshAccessToken, exchangeCodeForTokens, revokeToken } from '../googleAuth.js';
import { getSession } from '../session.js';

const router = Router();

// state ties the callback back to where the browser should return to
// (support running the frontend from more than one origin, e.g. local dev
// vs GitHub Pages) and guards against CSRF on the OAuth redirect. It's
// short-lived and single-use, so an in-memory Map is fine — losing it on a
// server restart just means an in-flight sign-in has to be retried.
const pendingStates = new Map(); // state -> { returnTo, createdAt }
const STATE_TTL_MS = 10 * 60 * 1000;

function cleanupExpiredStates() {
  const now = Date.now();
  for (const [state, entry] of pendingStates) {
    if (now - entry.createdAt > STATE_TTL_MS) pendingStates.delete(state);
  }
}

function isAllowedReturnTo(returnTo) {
  try {
    const url = new URL(returnTo);
    return config.frontendUrls.some((f) => new URL(f).origin === url.origin);
  } catch {
    return false;
  }
}

router.get('/auth/login', (req, res) => {
  cleanupExpiredStates();
  const requested = typeof req.query.returnTo === 'string' ? req.query.returnTo : '';
  const returnTo = isAllowedReturnTo(requested) ? requested : config.frontendUrls[0];
  const state = crypto.randomBytes(16).toString('hex');
  pendingStates.set(state, { returnTo, createdAt: Date.now() });
  res.redirect(buildAuthUrl(state));
});

router.get('/auth/callback', async (req, res) => {
  const { code, state, error } = req.query;
  const pending = typeof state === 'string' ? pendingStates.get(state) : null;
  if (pending) pendingStates.delete(state);
  const returnTo = pending?.returnTo || config.frontendUrls[0];

  if (error || !code || !pending) {
    res.redirect(`${returnTo}?auth=error`);
    return;
  }

  try {
    const tokens = await exchangeCodeForTokens(code);
    if (!tokens.refresh_token) {
      // Shouldn't happen given prompt=consent+access_type=offline, but if
      // Google ever omits it there's nothing useful this session can do
      // later than re-auth immediately, so fail loudly here rather than
      // storing a session that will 401 on first token refresh.
      res.redirect(`${returnTo}?auth=error`);
      return;
    }
    const session = await getSession(req, res);
    session.refreshToken = tokens.refresh_token;
    session.accessToken = tokens.access_token;
    session.accessTokenExpiresAt = Date.now() + Math.max(0, (tokens.expires_in || 3600) - 60) * 1000;
    await session.save();
    res.redirect(`${returnTo}?auth=success`);
  } catch (err) {
    console.error('OAuth callback failed:', err);
    res.redirect(`${returnTo}?auth=error`);
  }
});

router.get('/auth/status', async (req, res) => {
  const session = await getSession(req, res);
  res.json({ authenticated: !!session.refreshToken });
});

router.post('/auth/logout', async (req, res) => {
  const session = await getSession(req, res);
  await revokeToken(session.refreshToken);
  session.destroy();
  res.json({ ok: true });
});

// Google Picker (used for the "pick your store folder" onboarding step)
// runs entirely in the browser and needs its own real bearer token — it
// can't go through our /api/drive proxy since it's Google's own widget
// making the calls, not our frontend code. This mints one on demand from
// the refresh token so the browser only ever holds a short-lived token,
// and only while the Picker is actually open.
router.get('/auth/picker-token', async (req, res) => {
  const session = await getSession(req, res);
  try {
    const accessToken = await ensureFreshAccessToken(session);
    res.json({ accessToken });
  } catch (err) {
    if (err.code === 'unauthenticated' || err.code === 'invalid_grant') {
      if (err.code === 'invalid_grant') session.destroy();
      res.status(401).json({ error: 'Not signed in' });
      return;
    }
    console.error('Picker token mint failed:', err);
    res.status(502).json({ error: 'Could not reach Google' });
  }
});

export { router as authRouter };
