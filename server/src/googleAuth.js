import { config } from './config.js';

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';

// 60s safety margin, same reasoning as the old client-side storeToken() in
// useAuth.js: never treat a token as valid in the last moment before
// Google would have expired it anyway.
const EXPIRY_SAFETY_MARGIN_SECONDS = 60;

function buildAuthUrl(state) {
  const params = new URLSearchParams({
    client_id: config.googleClientId,
    redirect_uri: config.googleRedirectUri,
    response_type: 'code',
    scope: config.driveScope,
    access_type: 'offline',
    // Forces Google to hand back a refresh_token even if this browser has
    // consented before — without this, a returning user's second
    // authorization code often comes back with no refresh_token at all,
    // which would silently break re-auth after the access token expires.
    prompt: 'consent',
    state
  });
  return `${AUTH_URL}?${params.toString()}`;
}

async function exchangeCodeForTokens(code) {
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: config.googleClientId,
      client_secret: config.googleClientSecret,
      redirect_uri: config.googleRedirectUri,
      grant_type: 'authorization_code'
    })
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Google token exchange failed (${res.status}): ${body}`);
  }
  return res.json(); // { access_token, refresh_token, expires_in, ... }
}

async function refreshAccessToken(refreshToken) {
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      refresh_token: refreshToken,
      client_id: config.googleClientId,
      client_secret: config.googleClientSecret,
      grant_type: 'refresh_token'
    })
  });
  if (!res.ok) {
    const body = await res.text();
    const err = new Error(`Google token refresh failed (${res.status}): ${body}`);
    // A revoked/expired refresh token means the person has to sign in
    // again — the route layer uses this to clear the session instead of
    // looping forever on a refresh_token Google will never honor again.
    err.code = res.status === 400 || res.status === 401 ? 'invalid_grant' : 'refresh_failed';
    throw err;
  }
  return res.json(); // { access_token, expires_in, ... } — no new refresh_token on this grant type
}

async function revokeToken(token) {
  if (!token) return;
  try {
    await fetch(`https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(token)}`, { method: 'POST' });
  } catch {
    // Best-effort — signOut() should never fail just because Google's
    // revoke endpoint hiccuped. The session is cleared either way.
  }
}

// Ensures req.session has a live access token, refreshing it via the
// stored refresh token if it's missing or past its expiry. Mutates and
// saves the session in place so callers can just read session.accessToken
// afterward.
async function ensureFreshAccessToken(session) {
  if (!session.refreshToken) {
    const err = new Error('Not signed in');
    err.code = 'unauthenticated';
    throw err;
  }
  const isStale = !session.accessToken || !session.accessTokenExpiresAt || Date.now() >= session.accessTokenExpiresAt;
  if (!isStale) return session.accessToken;

  const { access_token, expires_in } = await refreshAccessToken(session.refreshToken);
  session.accessToken = access_token;
  session.accessTokenExpiresAt = Date.now() + Math.max(0, (expires_in || 3600) - EXPIRY_SAFETY_MARGIN_SECONDS) * 1000;
  await session.save();
  return access_token;
}

export { buildAuthUrl, exchangeCodeForTokens, refreshAccessToken, revokeToken, ensureFreshAccessToken };
