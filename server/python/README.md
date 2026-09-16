# store's Python service

An optional second backend process, alongside `server/`'s Node/Express one.
It's a general-purpose home for backend logic that benefits from real Python
libraries with no good browser or lightweight-Node equivalent — currently
one feature lives here, with the app structured so more can be added
alongside it without needing a separate process each:

- **Statements** (the "statements" spark category — see `CLAUDE.md` 3.9 and
  `src/features/sparks/CategorySorterPanel.jsx`): semantic phrase sorting,
  sorted-insertion, similarity lookup, and spellcheck, via
  `sentence-transformers`/`torch` and `pyspellchecker`. Results (embeddings
  and pairwise scores) are cached in-process — see `statements_engine.py`'s
  module-level caches — so repeated sorts/lookups over phrases it's already
  seen skip re-embedding and re-scoring.

This feature doesn't work without this process running; it degrades to a
clear "service unavailable" message in the UI if it isn't. Everything else
in the app works fine without it.

## Setup

1. `cd server/python`
2. `python -m venv .venv && source .venv/bin/activate` (or your usual
   virtualenv flow)
3. `pip install -r requirements.txt`
4. `python app.py` — listens on `127.0.0.1:8788` by default (`PORT` env var
   to change it). First `/statements/*` request downloads the
   `all-MiniLM-L6-v2` embedding model (~90MB) and is slow; every request
   after that is fast.
5. Point the Node backend at it: set `PYTHON_SERVICE_URL` in
   `server/.env` (defaults to `http://127.0.0.1:8788`, so only needed if
   you're running it elsewhere).

## Why a separate process instead of Python-in-Node

The sentence-transformer model takes a few seconds to load and needs to
stay resident in memory across requests (reloading it per-request is too
slow to be usable) — that's naturally a long-running process, not a
subprocess-per-call. Keeping it a separate small Flask app rather than
trying to run Python from inside the Express process keeps each backend in
its own normal deploy/restart lifecycle.

## Adding a new feature here

Give it its own module (next to `statements_engine.py`), import it in
`app.py`, and register its route(s) there next to the `/statements/*` ones
— same pattern the statements engine follows. Only reach for this process
when a feature genuinely needs a Python library with no good Node/browser
equivalent (per `CLAUDE.md` section 2); it's not a general rule that new
backend work should be Python.

## What it doesn't do

- No auth of its own — only `server/`'s Express routes are meant to call
  it, and those already gate access behind a signed-in session. Don't
  expose this process's port to the internet directly.
- No database, no disk persistence — same "holds no data of its own" rule
  as the Node backend (`server/README.md`). In-memory caches (see above)
  are the one exception, and they hold derived data (embeddings/scores),
  not anything that couldn't be recomputed from what the frontend already
  stores in Drive.
