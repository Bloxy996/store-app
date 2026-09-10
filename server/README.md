# store backend

Holds the Google OAuth refresh token server-side and proxies Drive REST
calls for the frontend, replacing the old client-side Google Identity
Services token-client flow (see `docs/CLAUDE.md` section 2 for why).

## What this does (and doesn't) change

- The frontend no longer talks to `googleapis.com` directly, and no longer
  holds any Google token in `localStorage`. It calls this server's
  `/api/drive/*` routes with `credentials: 'include'`; the session cookie
  (set by `/auth/callback`) is what authorizes those calls.
- The Apps Script proxy mode (`isProxy`/`proxy*` in `driveApi.js`) is
  untouched — it's a separate, still-supported way to run store without
  standing up this server at all.
- Note **content** still never touches this server's disk — requests are
  proxied through in memory (or streamed, for `/blob`), matching the
  zero-local-storage rule in `docs/CLAUDE.md` section 3.1. This server has
  no database; the only thing it persists is the session cookie
  (encrypted, held in the browser) containing the refresh token.

## Setup

1. In the Google Cloud project already used for the OAuth client ID
   (`docs/CLAUDE.md` / README's "Getting started" section), open that
   OAuth client's settings and add this server's `/auth/callback` URL
   under **Authorized redirect URIs** (e.g.
   `http://localhost:8787/auth/callback` for local dev). You'll also need
   the client secret now, since this is a server-side (authorization code)
   flow rather than the old browser-only implicit flow — grab it from the
   same OAuth client page.
2. `cp .env.example .env` and fill in `GOOGLE_CLIENT_ID`,
   `GOOGLE_CLIENT_SECRET`, `GOOGLE_REDIRECT_URI`, `FRONTEND_URL`, and a
   random `SESSION_SECRET`.
3. `npm install`
4. `npm run dev` (or `npm start`)

## Frontend wiring

Set `VITE_BACKEND_URL` in the frontend's `.env` (e.g.
`http://localhost:8787` for local dev) — see `src/lib/vaultConfig.js`.

## Deploying

Any host that runs a plain Node/Express process works (Render's free tier
is a straightforward fit — see the `npm start` script above). Whichever
domain you deploy to becomes both `GOOGLE_REDIRECT_URI`'s host and the
value the frontend's `VITE_BACKEND_URL` points at.
