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

## Deploying

Two supported paths, both running the exact same route/middleware code
(`src/app.js` — `src/index.js` and `api/index.js` are just two thin
entrypoints onto it, so behavior can't drift between them). Switching
between them is purely a matter of where things are deployed and which
env vars point where — no code changes either way.

- **Vercel (frontend + this Node backend together, one project):**
  the root `/vercel.json` builds the Vite frontend as a static site and
  `server/api/index.js` as one Node serverless function in the same
  project, so both deploy from a single `vercel push`/Git-connected
  deploy. Set as Vercel project env vars: `GOOGLE_REDIRECT_URI` to
  `https://<your-app>.vercel.app/auth/callback`, `FRONTEND_URL` to
  `https://<your-app>.vercel.app`, and `VITE_BACKEND_URL` to an empty
  string (frontend and backend share one origin, so calls are relative).
  Verified against a real deployment.
- **All on Render (two separate services in one workspace):**
  - Frontend: a Render **Static Site** pointing at the repo root, build
    command `npm install && npm run build`, publish directory `dist`.
  - Backend: a Render **Web Service** pointing at `server/`, build
    command `npm install`, start command `npm start` (runs
    `src/index.js`).
  - Frontend and backend land on two different `*.onrender.com`
    subdomains, so unlike the Vercel path this is cross-origin: set
    `GOOGLE_REDIRECT_URI` to
    `https://<your-backend>.onrender.com/auth/callback`, `FRONTEND_URL`
    to the static site's `https://<your-frontend>.onrender.com`, and the
    frontend build's `VITE_BACKEND_URL` to
    `https://<your-backend>.onrender.com` (a Vite env var, so it has to
    be set at build time on the static site's service, not read at
    runtime). The cross-origin session cookie already works
    (`sameSite: 'none'` in production — `src/session.js`); CORS just
    needs `FRONTEND_URL` set correctly on the backend service.

**Switching from one to the other later** is the same handful of steps
either direction: point `GOOGLE_REDIRECT_URI`/`FRONTEND_URL`/
`VITE_BACKEND_URL` at the new domain(s), add the new redirect URI to the
OAuth client in Google Cloud Console (old one can stay too, multiple are
allowed), and redeploy on the new host. `src/app.js` and everything it
wires up stays untouched.

There used to be a third piece here — a separate Python process
(`server/python/`) that needed its own persistent host regardless of
which path above was in use, since its embedding model had to stay
loaded in memory across requests. That's gone: the Statements spark
category now runs entirely client-side (`src/lib/statementsEngine.js`
and friends, on the frontend) instead of calling out to a Python
service, so there's nothing left that needs a long-running host outside
the two paths above.
