# CLAUDE.md

Read automatically by Claude Code at the start of every session here.
Holds durable architecture facts so they don't need re-explaining.
Task tracking lives in `TODO.md` (workflow: section 9), not here.

## 1. What this project is

**store** (lowercase) — a note/file app that reads and writes `.md` notes
(and `.base` database, `.canvas` board, `.vec` vector art files) to the
user's Google Drive. React SPA + PWA, backed by a real Node/Express
server (`server/`) — see section 2's "Hosting" bullet for where it
deploys. The backend is not limited to being an OAuth relay — it's a
normal app server and fair game for new routes, server-side logic,
caching, or anything else that's a better fit there than in the browser.

## 2. Tech stack

- **Frontend:** React 18 + Vite, client-rendered (no SSR).
  `vite-plugin-pwa` handles the service worker/manifest.
- **Editor:** CodeMirror 6, driving a live "WYSIWYG-ish" markdown editor
  (`features/editor/`).
- **Storage:** Google Drive REST API (`drive.file` scope) holds vault
  content. IndexedDB and an in-memory `Map` are used as caches (3.1).
- **Backend (`server/`):** Node/Express. Holds the OAuth refresh token
  server-side and proxies `/api/drive/*` calls for the frontend
  (session-cookie authed — see `server/README.md`). This is its current
  job, not a ceiling on its job — extend it for anything that benefits
  from running server-side. There used to be a second, optional Python
  process (`server/python/`) behind `/api/statements/*` for phrase
  similarity/spellcheck (sentence-transformers/torch) — that's gone; the
  Statements spark category (3.9) now runs entirely client-side instead
  (`lib/statementsEngine.js`, `lib/statementsEmbeddings.js`,
  `lib/spellcheck.js` — `@xenova/transformers` running the same
  all-MiniLM-L6-v2 model as an ONNX build in-browser, plus
  `string-similarity-js` and `nspell`/`dictionary-en`). Scoring differs
  from the old Python version (Dice vs Ratcliff/Obershelp, Hunspell vs
  frequency-list suggestions; see `statementsEngine.js`'s header). The
  MiniLM weights (Hugging Face CDN) and dictionary word list load at
  runtime on first use, not precached, so first use needs network once.
  `@xenova/transformers` sits in the single main bundle because
  `vite.config.js` disables code splitting (Rolldown init-order bug, see
  its comment); revisit once fixed upstream. This backend has no
  compute-heavy route anymore, and no reason to reach for Python again
  unless something genuinely needs a library with no JS/browser
  equivalent.
- **Auth:** Google Identity Services via the backend's authorization-code
  flow (`hooks/useAuth.js`). An older client-only "proxy" mode (Apps
  Script relay) also still exists — `lib/driveApi.js`'s
  `isProxy`/`proxy*` functions.
- **Hosting:** Two supported paths for the frontend + Node/Express half,
  sharing the same Express app (`server/src/app.js`) so they can't drift
  apart, and switching between them needs no code changes — see
  `server/README.md`'s "Deploying" section for the env var specifics:
  (1) Vercel — frontend as a static build + backend as one serverless
  function (`server/api/index.js`) in the same project, via the root
  `vercel.json`; or (2) all on Render — frontend as a Render Static Site,
  backend as a Render Web Service (`server/src/index.js`). No third
  persistent host needed now that the Python service is gone (see the
  Backend bullet above).
- **Styling:** plain CSS, one stylesheet per component/feature (section
  5). Global tokens in `styles/theme.css`.
- **Android companion:** `android/` — standalone Gradle project, three
  deep-link entry points (home-screen widget, Quick Settings tile,
  accessibility-button floating button) into the same PWA. Not a native
  rewrite.

## 3. Architecture notes

### 3.1 Local storage of note content

Historically this app avoided writing note content to disk except when a
file/folder is marked "Available offline" (`hooks/useOfflineSync.js`,
`lib/offlineRules.js`, the `STORE_OFFLINE_NOTES`/`STORE_OFFLINE_ASSETS`
IndexedDB stores). That's still the default behavior, but it's a design
choice, not a hard constraint — if a feature benefits from caching more
(content-derived data, prefetching, offline-first behavior beyond the
current opt-in, server-side caching in `server/`) go ahead, just keep
`hooks/useOfflineSync.js`'s unsynced-edit warning working for offline
files so people don't silently lose local edits. App settings
(accent color, frontmatter schema, graph view settings) live in
`localStorage`.

### 3.2 Drive access layer

Frontend Drive REST calls go through `lib/driveApi.js`; backend Drive
calls go through `server/src/driveClient.js`. Keeping Drive calls
centralized in those two files (rather than scattered `fetch`s) makes it
easy to see everywhere Drive is touched — worth keeping as a pattern,
not a rule to route around.

### 3.3 MVC-ish separation

- **Model** = `lib/` (pure functions + `driveApi.js`) and the
  data-shaping hooks (`useVaultSync`, `useVaultIndex`,
  `useDriveImageUrl`).
- **Controller** = the top of `App.jsx` (state, effects, the `handlers`
  object) plus feature-level hooks.
- **View** = `components/` (generic) and `features/*` (feature-specific).
  Views reach Model functions through props/hooks from `App.jsx`.

### 3.4 One source of truth per calculation

| Calculation | Lives in |
|---|---|
| Markdown → tags/frontmatter/wikilinks parsing | `lib/markdownParse.js` |
| Markdown → React elements rendering | `lib/markdownRender.jsx` |
| `query`/`dataview` language | `lib/queryEngine.js` |
| Backlink/wikilink graph | `lib/linkGraph.js` |
| Search matching + ranking | `lib/search.js` |
| Split-pane tree math | `lib/paneTree.js` |
| File-kind classification | `lib/vaultConfig.js` |
| Offline root expansion / conflict-copy names | `lib/offlineRules.js` |
| DB row group-by/aggregate | `dbState.js`'s `aggregateDbRows` |
| Frontmatter schema | `lib/frontmatterSchema.js` |

New cross-cutting calculations: one file in `lib/`, imported where
needed, rather than copy-pasted.

### 3.5 Shared UI, floating menus

Icons live in `components/icons.jsx`. Floating/toggleable menus are
usually a local `open` boolean + a block in normal document flow, closed
via `useClickOutside`; `DbPopover` (`features/database/DbCells.jsx`) is a
portal-based approach used where an anchor's scroll position is
unpredictable — a reasonable pattern to reuse, not a one-off to avoid
copying. `PaletteModal` and `HelpModal` are centered modals (summon
from anywhere); `FrontmatterSchemaSettings` and `DbRowDetailModal`/
`DbManageColumnsModal` (right-docked slide-overs) follow the shape that
fits their interaction, not a fixed rule.

### 3.6 Kind-aware routing

`features/editor/EditorContent.jsx` switches on `file.kind` to render
`DatabaseView`/`CanvasView`/`VectorEditorView`/`GraphView`/the markdown
editor. `GraphView` is backed by a singleton pseudo-file
(`graphPaneFile.js`, id `__graph__`) that's injected into `filesById` but
not `sync.filesMeta`. New file kinds: extend this switch; anything not
backed by a real Drive file can follow the same pseudo-file pattern.

### 3.7 File length

Large files (`App.jsx` ~1500 lines, `VectorEditorView.jsx` ~2200,
`markdownRender.jsx` ~770) exist because splitting them means extracting
stateful hooks by hand with no test suite yet — real work, not a "must
never grow" line. Split when it's convenient or when a section is
genuinely reusable elsewhere; don't block a feature on a refactor first.

### 3.8 Internal (non-vault) data: `.store/`

A root-level Drive folder, `.store` (`lib/sparkStore.js`'s
`SPARK_FOLDER_NAME`), holds app-internal data (currently sparks, 3.9)
that shouldn't show up as a browsable note. `useVaultSync.js`'s
`splitInternalVaultData` strips it from `foldersMeta`/`filesMeta` in one
place. New internal data: a subfolder under `.store/` keeps that single
strip point working.

### 3.9 Sparks

A "spark" is a one-line quick-capture (optional screenshot + caption),
filed under a nested category, optionally linked to vault files — not a
full vault note. Stored tab-separated in `.store/spark.txt`
(`lib/sparkStore.js`); screenshots go to `.store/spark-attachments/` as
normal Drive image uploads. `hooks/useSparks.js` handles its own
load/save outside the main sync loop. UI:
`features/sparks/SparksPanel.jsx` (browse) + `SparkCaptureForm.jsx`
(capture — also behind the `#/spark-quick-add` deep link every Android
entry point opens). See `android/README.md` for the three Android entry
points.

Any category can be made order-sensitive — the user toggles it on per
category (an icon next to it in `SparksPanel.jsx`'s category tree), and
any number of categories can be toggled on at once, independently.
`lib/sortedCategories.js` tracks the toggled set in `localStorage`
(3.1). A toggled-on category's sparks' array order in `spark.txt` *is*
their similarity-sorted order, maintained client-side by
`lib/statementsEngine.js` (sort/sorted-insert/lookup, embeddings via
`lib/statementsEmbeddings.js`) and `lib/spellcheck.js`, both called
through `lib/statementsApi.js` — matched by *exact* category path, so a
category with nested sub-categories under it only sorts the
sparks filed directly under its own name, never the nested ones (those
are separate categories with their own independent toggle).
`SparksPanel.jsx` renders `CategorySorterPanel.jsx` instead of the
normal browse list for whichever category is both active and toggled
on. (Before this was generalized, exactly one hardcoded category,
`statements`, had this behavior — `lib/sortedCategories.js` defaults a
fresh/upgraded install's toggled set to just `['statements']` so
existing data keeps sorting the same way with no manual step.)

### 3.10 Tools panel (local-disk + media utilities)

`features/tools/ToolsPanel.jsx` — three utilities that operate outside the
Drive vault: a local-folder counterpart to Compile/Apply
(`lib/localFs.js`, File System Access API, reuses `compile/
compileVault.js`'s XML format rather than having its own), images→PDF
(`lib/imagesToPdf.js`, client-side via jsPDF), and extracting embedded
base64 images out of the open note (`lib/embeddedImages.js`). (A fourth,
a YouTube-audio-to-vault downloader via yt-dlp/ffmpeg, was removed.)

## 4. Mobile performance

Priority, not just a desktop app: code-split anything outside the
note-editing hot path (graph, help modal, palette, database, canvas, and
vector are already `React.lazy`); CodeMirror already virtualizes; prefer CSS
transforms over layout-triggering properties in hot UI (status bar, pane
header, query blocks); keep large lists virtualized/paginated as vaults
grow. Touch-action on drag surfaces (canvas) only narrows, never loosens,
down the tree — see `canvas.css`/`CanvasView.jsx`'s `beginMove`. On
short notes the on-screen keyboard can cover the last lines — see the
bottom-pad fix in `CodeMirrorEditor.css`'s mobile breakpoint; apply the
same pattern to other mobile text-input surfaces if needed.

## 5. File structure

```
index.html                          — Vite entry; loads Google Identity script, mounts src/main.jsx
vite.config.js                      — Vite + vite-plugin-pwa; GitHub Pages base path; build-time __APP_VERSION__
public/                             — PWA icons, _nojekyll

src/
  main.jsx, App.jsx                 — root + composition root (auth, pane tree, buffers, modals, handlers — 3.7)

  lib/                              — pure functions + driveApi.js (3.2, 3.3)
    vaultConfig.js, concurrency.js, indexedDb.js, driveApi.js,
    markdownParse.js, markdownRender.jsx, queryEngine.js, linkGraph.js,
    search.js, paneTree.js, frontmatterSchema.js, offlineRules.js,
    sparkStore.js, sortedCategories.js, mathUtils.js, localFs.js,
    imagesToPdf.js, embeddedImages.js, statementsApi.js,
    statementsEngine.js, statementsEmbeddings.js, spellcheck.js

  hooks/
    useAuth.js, useVaultSync.js, useVaultIndex.js, useDriveImageUrl.js,
    useClickOutside.js, useFrontmatterSchema.js, useAppUpdate.js,
    useOfflineSync.js, useSparks.js

  components/                       — generic View pieces: icons.jsx, DropdownMenu.css,
    ActivityBar, StatusBar, PropertiesPanel, InlineMentions, LinkEmbeds,
    ImageViewer.css, MiniMarkdownEditor, ResizeHandle

  features/
    onboarding/, sidebar/, search/, tags/, bookmarks/, toc/
    sparks/         sparkStore-backed SparksPanel.jsx, SparkCaptureForm.jsx,
                     CategorySorterPanel.jsx — sorter-enabled categories (3.9)
    tools/          ToolsPanel.jsx — local-folder/PDF/image utilities (3.10)
    panes/          PaneNode.jsx (recursive split-pane), TabBar.jsx
    editor/         CodeMirrorNoteEditor, EditorContent (3.6), NoteTitleField,
                     inlinePreviewPlugin, wysiwygBlocks, wikilinkCompletion,
                     frontmatterCompletion, cmIndent, TaskCheckboxWidget
    query/          QueryBlock.jsx
    assets/         AssetPane.jsx
    database/       dbState.js (3.4), DbCells.jsx, DbViews.jsx,
                     DbCalendarView/DbChartView/DbTimelineView, dbDateUtils,
                     DbViewPanel, DbModals, DatabaseView
    canvas/         canvasState.js, CanvasToolbar, CanvasFilePickerModal,
                     CanvasNode, CanvasView
    vector/         vectorState.js, vectorTopology.js, vectorGeometry.jsx,
                     VectorToolbar, VectorEditorView (3.7)
    graph/          useForceGraph.js, graphSettings.js, graphPaneFile.js (3.6),
                     GraphView.jsx
    compile/        compileVault.js (vault <-> XML for LLM mass-editing), CompilePanel.jsx
    palette/        PaletteModal.jsx
    help/           HelpModal.jsx — keep in sync, section 6
    offline/        OfflineConflictsPanel.jsx
    settings/       FrontmatterSchemaSettings.jsx
    accent/         accentColor.js, AccentColorPicker.jsx

  styles/           index.css (import order matters), theme.css, layout.css,
                     modal.css, responsive.css

server/                              — Node/Express backend (2)
  src/app.js                         — Express app factory (routes/CORS), shared by both entrypoints below
  src/index.js                       — long-running entrypoint (Render/plain Node host)
  api/index.js                       — Vercel serverless entrypoint (no .listen())
  src/config.js, session.js, googleAuth.js, driveClient.js
  src/routes/auth.js, drive.js
  README.md                          — setup/deploy

vercel.json                          — Vercel build+rewrite config for hosting frontend + the Node
                                        backend half together (2)

android/                             — separate Gradle project (3.9)
  README.md
  app/src/main/kotlin/.../SparkConfig.kt, SparkWidgetProvider.kt,
    SparkTileService.kt, SparkAccessibilityService.kt
  app/src/main/res/                  — widget layout, icon, strings
```

A CSS file next to a component/feature file with the same name is that
piece's styles; some features share one stylesheet instead
(`canvas.css`, `vector.css`, `database.css`, `sidebar.css`).

## 6. Keep the in-app help in sync

`features/help/HelpModal.jsx` (`HELP_SHORTCUTS`, `HELP_MARKDOWN`,
`HELP_FEATURES`) is the in-app reference. Update it in the same piece of
work when a shortcut, markdown syntax, or feature behavior changes.

## 7. Notes

- Prefer extending an existing `lib/` module over duplicating part of it
  (3.4).
- `TODO.md` holds all open work; follow section 9 for how tasks move.
- Token-budget passes (trimming file size for `compile/`'s LLM export,
  not just humans): `components/icons.jsx` is done. Largest remaining,
  if it's ever worth doing: `features/vector/VectorEditorView.jsx`
  (~2375), `App.jsx` (~1538), `features/vector/vectorState.js` (~1013),
  `lib/markdownRender.jsx` (~768), `features/vector/vectorTopology.js`
  (~689).

## 8. Standing audits

Apply on every pass through touched code, making major/minor changes as
needed:

- Remove bugs and logic errors.
- Performance/UI optimizations, for both desktop and mobile.
- Keep the app as lightweight as possible.
- Keep code as concise as possible: remove dead code, avoid repetition.
- Keep documentation concise and up to date, in both `CLAUDE.md` and
  in-script comments.

**Important:** favor reducing token usage in everything above.

## 9. Task workflow (`TODO.md`)

`TODO.md` has exactly four sections, in this order: **Backlog**, **Pending**,
**Active**, **Verify**. It is a live queue, not a changelog: no completed-work
logs, no "moved to ___" stubs, no leftover markers. A task exists in exactly
one section at a time.

- **Backlog:** when the user requests work, add it here. Flesh out the
  wording as needed, but never cut functionality the user specified.
- **Pending:** only when the user asks, move the named/suggested backlog
  tasks here. Order matters: top tasks are done first.
- **Active:** when the user says to start, move the first few Pending tasks
  here and work on them.
- **Verify:** once a task is fully complete and self-checked (build, logic
  review), move it here with numbered steps the user can follow in the app
  to confirm it. Note anything not machine-checked (e.g. uncompiled Android).
- **Done:** when asked, walk the user through the Verify steps. Only when
  the user says a task is verified, delete it from `TODO.md` entirely.

Moves cut the whole entry from one section and paste it into the next,
leaving nothing behind. Durable facts learned along the way (architecture,
constraints, tradeoffs) go into the relevant `CLAUDE.md` section, not
`TODO.md`.

