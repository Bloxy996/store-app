import { getIronSession } from 'iron-session';

import { config } from './config.js';

// The session cookie is the ONLY place the refresh token is stored — never
// sent to the browser as JS-readable data (httpOnly), encrypted+signed at
// rest by iron-session so there's no server-side session store/DB to run.
// This is deliberately the smallest thing that works; if store ever needs
// multi-device session listing or revocation-by-id, swap this for a real
// session table keyed by an opaque id instead of growing this file.
const sessionOptions = {
  cookieName: 'store_session',
  password: config.sessionSecret,
  cookieOptions: {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge: 60 * 60 * 24 * 30 // 30 days — governs the refresh token's cookie lifetime, not the access token's
  }
};

// req/res are Express's; iron-session works directly against the raw
// Node request/response, which Express passes through unchanged.
async function getSession(req, res) {
  return getIronSession(req, res, sessionOptions);
}

export { getSession };
