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

See [`appscript.js`](./google/appscript.gs)'s doc comment to set up the
apps script proxy.

## Architecture

See [`CLAUDE.md`](./docs/CLAUDE.md) for the full set of architecture
decisions and conventions (tech stack, the zero-local-note-storage
rule, file layout, performance notes). See [`TODO.md`](./docs/TODO.md) for
open/planned work.

## License

MIT — see [`LICENSE`](./LICENSE).
