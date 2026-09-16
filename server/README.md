# store backend

Holds the Google OAuth refresh token server-side and proxies Drive REST
calls for the frontend, replacing the old client-side Google Identity
Services token-client flow (see `CLAUDE.md` section 2 for why).

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
  zero-local-storage rule in `CLAUDE.md` section 3.1. This server has
  no database; the only thing it persists is the session cookie
  (encrypted, held in the browser) containing the refresh token.

## Setup

1. In the Google Cloud project already used for the OAuth client ID
   (`CLAUDE.md` / README's "Getting started" section), open that
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

## Optional: the Python service

A general-purpose Python process backs the Statements spark category (and
is where future Python-only features would live) — see `python/README.md`.
Everything else in this server works fine without it.

## Deploying

Two supported paths for the Node/Express half, both using the exact same
route/middleware code (`src/app.js` — `src/index.js` and `api/index.js`
are just two thin entrypoints onto it, so behavior can't drift between
them):

- **Plain Node host (Render etc.):** any host that runs a long-lived
  Node process works — `npm start` runs `src/index.js`. Whichever domain
  you deploy to becomes both `GOOGLE_REDIRECT_URI`'s host and the value
  the frontend's `VITE_BACKEND_URL` points at. Frontend and backend are
  different origins in this setup, so the session cookie needs
  `sameSite: 'none'` (already the case in production — see
  `src/session.js`) and CORS needs `FRONTEND_URL` set correctly.
- **Vercel (frontend + this Node backend together):** the root
  `/vercel.json` builds the Vite frontend as a static site and
  `server/api/index.js` as one Node serverless function in the same
  project, so both deploy from a single `vercel push`/Git-connected
  deploy — no separate Render/Node host needed for this half. Set
  `GOOGLE_REDIRECT_URI` to `https://<your-app>.vercel.app/auth/callback`,
  `FRONTEND_URL` to `https://<your-app>.vercel.app`, and
  `VITE_BACKEND_URL` to an empty string (same-origin relative calls) as
  Vercel project env vars.

**The Python service is NOT part of either path above and still needs its
own persistent host regardless** (a small VM, Render/Fly/etc. — anything
that keeps one process warm). Its embedding model has to stay loaded in
memory across requests (see `python/README.md`), and its dependencies
(`torch`, `sentence-transformers`) are well past what a serverless
function's size/cold-start budget can reasonably absorb — that's true
whether the rest of the backend is on Render or on Vercel. Point
`PYTHON_SERVICE_URL` at wherever it ends up running.

Not yet done: no live Vercel deployment of the Node half has actually
been exercised against this config (no Vercel account/project available
in this pass) — see `TODO.md`.
