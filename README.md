# store

A minimalist, Notion/Obsidian-hybrid file store that reads and writes
`.md` notes (plus `.base` database and `.canvas` board files) directly
to and from your own Google Drive. Client-only React SPA — no backend
server and no database of its own; everything runs in the browser and
is packaged as an installable PWA.

## Features

- Markdown notes with a live "WYSIWYG-ish" CodeMirror 6 editor
  (wikilinks, tags, columns, callouts, toggles, tables)
- Notion-style `.base` databases (table/board/gallery views, typed
  columns, filtering/sorting)
- `.canvas` boards and an Obsidian-style local/full graph view
- Full-text search and a wikilink-based backlink index
- Multi-pane/tab editing with split panes
- Installable as a PWA; works offline for the app shell (note content
  itself always lives on Drive — see `CLAUDE.md` section 3.1)

## Getting started

```bash
npm install
npm run dev       # start the dev server
npm run build     # production build
npm run preview   # preview a production build locally
```

You'll need a Google Cloud project with the Drive API enabled and an
OAuth client ID for the app's Google sign-in (`drive.file` scope only —
the app never requests broader Drive access). Alternatively, you can
use the included Apps Script proxy to avoid setting up OAuth entirely.

## Apps Script proxy setup

If you prefer not to manage OAuth client credentials, you can deploy
the included Google Apps Script as a proxy. It runs under your own
Google identity, so visitors never need their own OAuth grant.

1. Open `google/appscript.gs` in the Apps Script editor.
2. In the left sidebar, click Services (+) and add the **Drive API**
   (version 3). Enable it in the linked Cloud project when prompted.
3. Replace `YOUR_SECRET_HERE` in the `setSecret()` function with a
   long random string (e.g., from `uuidgenerator.net` or run
   `openssl rand -hex 24` locally). Select the `setSecret` function
   in the toolbar dropdown and click **Run** once. This stores the
   secret in Script Properties.
4. Deploy the script as a **Web App** (Execute as: Me, Who has access:
   Anyone). Copy the deployment URL (ends in `/exec`).
5. In the app’s sign-in screen, choose “Use Apps Script proxy” and
   enter the URL and your secret. Test by visiting
   `<WebAppURL>?action=ping&secret=<your secret>` – you should see
   `{"ok":true}`.

Whenever you edit `appscript.gs`, you must push a new version of the
deployment for changes to take effect.

## Architecture

See [`CLAUDE.md`](./docs/CLAUDE.md) for the full set of architecture
decisions and conventions (tech stack, the zero-local-note-storage
rule, file layout, performance notes). See [`TODO.md`](./docs/TODO.md) for
open/planned work.

## License

MIT — see [`LICENSE`](./LICENSE).
