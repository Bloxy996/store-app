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
the app never requests broader Drive access). Sign in on first launch;
your notes are read from and written straight to your own Drive, never
to any server this project controls.

### Renaming an existing "vault"-named Cloud/Apps Script project

If you set this up before the app was renamed from "vault" to `store`,
the client-side code (`temp/appscript.gs`, `lib/driveApi.js`) has
already been updated to say "store" instead — but your actual Google
Cloud Console project and Apps Script project names are external
settings this repo can't change for you:

1. **Cloud Console project name:** [console.cloud.google.com](https://console.cloud.google.com)
   → select the project → gear icon (⚙) next to the project name in the
   top bar → **Project settings** → edit **Project name** → Save. This
   is cosmetic only; it doesn't change the project ID or break your
   OAuth client.
2. **Apps Script project name** (if you use the proxy auth mode): open
   the script at [script.google.com](https://script.google.com) →
   click the project name at the top left → type the new name → it
   saves automatically.
3. **If you rename the Apps Script project, redeploy it** so the change
   (and the `listStoreFiles`/`STORE_SECRET` code rename) reaches your
   live URL: **Deploy → Manage deployments → Edit (pencil) → Version:
   New version → Deploy**. See the setup comment at the top of
   `temp/appscript.gs` for the full deploy walkthrough.

## Architecture

See [`CLAUDE.md`](./CLAUDE.md) for the full set of architecture
decisions and conventions (tech stack, the zero-local-note-storage
rule, file layout, performance notes). See [`TODO.md`](./TODO.md) for
open/planned work.

## License

MIT — see [`LICENSE`](./LICENSE).
