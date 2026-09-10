import { getIronSession } from 'iron-session';

import { config } from './config.js';

// The session cookie is the ONLY place the refresh token is stored — never
// sent to the browser as JS-readable data (httpOnly), encrypted+signed at
// rest by iron-session so there's no server-side session store/DB to run.
// This is deliberately the smallest thing that works; if store ever needs
// multi-device session listing or revocation-by-id, swap this for a real
// session table keyed by an opaque id instead of growing this file.
const isProd = process.env.NODE_ENV === 'production';

const sessionOptions = {
  cookieName: 'store_session',
  password: config.sessionSecret,
  cookieOptions: {
    httpOnly: true,
    // 'none' is required for the cookie to be sent on cross-site fetch()
    // calls (e.g. bloxy996.github.io -> store-app-yu8w.onrender.com —
    // different sites, not just different origins). 'lax' only survives
    // top-level navigations (which is why the OAuth redirect itself
    // worked) — the very next fetch('/auth/status', {credentials:
    // 'include'}) is what silently dropped the cookie. 'none' requires
    // secure:true, which is fine since Render is always HTTPS; kept as
    // 'lax'/false in dev since localhost:5173 <-> localhost:8787 is
    // same-site (differs only by port) and doesn't need it, and dev
    // usually isn't served over HTTPS.
    secure: isProd,
    sameSite: isProd ? 'none' : 'lax',
    maxAge: 60 * 60 * 24 * 30 // 30 days — governs the refresh token's cookie lifetime, not the access token's
  }
};

// req/res are Express's; iron-session works directly against the raw
// Node request/response, which Express passes through unchanged.
async function getSession(req, res) {
  return getIronSession(req, res, sessionOptions);
}

export { getSession };