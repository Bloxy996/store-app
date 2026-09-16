# store's Python service

An optional second backend process, alongside `server/`'s Node/Express one.
It exists because two features benefit from real Python libraries with no
good browser or lightweight-Node equivalent:

- **Statements** (the "statements" spark category — see `CLAUDE.md` 3.9 and
  `src/features/sparks/StatementsPanel.jsx`): semantic phrase sorting,
  sorted-insertion, similarity lookup, and spellcheck, via
  `sentence-transformers`/`torch` and `pyspellchecker`.
- **Music downloader** (`src/features/tools/ToolsPanel.jsx`): pulls audio
  from YouTube links via `yt-dlp`, tags it with `ffmpeg`.

Neither feature works without this process running; both degrade to a
clear "service unavailable" message in the UI if it isn't. Everything else
in the app works fine without it.

## Setup

1. `cd server/python`
2. `python -m venv .venv && source .venv/bin/activate` (or your usual
   virtualenv flow)
3. `pip install -r requirements.txt`
4. Install `ffmpeg` and make sure it's on `PATH` (needed by the music
   downloader; not needed for statements).
5. `python app.py` — listens on `127.0.0.1:8788` by default (`PORT` env var
   to change it). First `/statements/*` request downloads the
   `all-MiniLM-L6-v2` embedding model (~90MB) and is slow; every request
   after that is fast.
6. Point the Node backend at it: set `STATEMENTS_SERVICE_URL` in
   `server/.env` (defaults to `http://127.0.0.1:8788`, so only needed if
   you're running it elsewhere).

## Why a separate process instead of Python-in-Node

The sentence-transformer model takes a few seconds to load and needs to
stay resident in memory across requests (reloading it per-request is too
slow to be usable) — that's naturally a long-running process, not a
subprocess-per-call. Keeping it a separate small Flask app rather than
trying to run Python from inside the Express process keeps each backend in
its own normal deploy/restart lifecycle.

## What it doesn't do

- No auth of its own — only `server/`'s Express routes are meant to call
  it, and those already gate access behind a signed-in session. Don't
  expose this process's port to the internet directly.
- No database, no disk persistence beyond a download's own temp
  directory (cleaned up after each `/music/download` request) — same
  "holds no data of its own" rule as the Node backend (`server/README.md`).
