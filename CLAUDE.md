# CLAUDE.md

Read automatically by Claude Code at the start of every session here.
Holds durable architecture facts so they don't need re-explaining.
Historical changelog entries live in `TODO.md`, not here.

## 1. What this project is

**store** (lowercase) — a note/file app that reads and writes `.md` notes
(and `.base` database, `.canvas` board, `.vec` vector art files) to the
user's Google Drive. React SPA + PWA, deployed to GitHub Pages, backed by
a real Node/Express server (`server/`). The backend is not limited to
being an OAuth relay — it's a normal app server and fair game for new
routes, server-side logic, caching, or anything else that's a better fit
there than in the browser.

## 2. Tech stack

- **Frontend:** React 18 + Vite, client-rendered (no SSR).
  `vite-plugin-pwa` handles the service worker/manifest.
- **Editor:** CodeMirror 6, driving a live "WYSIWYG-ish" markdown editor
  (`features/editor/`).
- **Storage:** Google Drive REST API (`drive.file` scope) holds vault
  content. IndexedDB and an in-memory `Map` are used as caches (3.1).
- **Backend (`server/`):** Node/Express. Currently holds the OAuth
  refresh token server-side and proxies `/api/drive/*` calls for the
  frontend (session-cookie authed — see `server/README.md`). This is its
  current job, not a ceiling on its job — extend it for anything that
  benefits from running server-side.
- **Auth:** Google Identity Services via the backend's authorization-code
  flow (`hooks/useAuth.js`). An older client-only "proxy" mode (Apps
  Script relay) also still exists — `lib/driveApi.js`'s
  `isProxy`/`proxy*` functions.
- **Hosting:** Frontend on GitHub Pages via GitHub Actions; backend on
  any Node host (Render etc., see `server/README.md`).
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

## 4. Mobile performance

Priority, not just a desktop app: code-split anything outside the
note-editing hot path (graph, help modal, palette, database, canvas are
already `React.lazy`); CodeMirror already virtualizes; prefer CSS
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
    sparkStore.js, mathUtils.js

  hooks/
    useAuth.js, useVaultSync.js, useVaultIndex.js, useDriveImageUrl.js,
    useClickOutside.js, useFrontmatterSchema.js, useAppUpdate.js,
    useOfflineSync.js, useSparks.js

  components/                       — generic View pieces: icons.jsx, DropdownMenu.css,
    ActivityBar, StatusBar, PropertiesPanel, InlineMentions, LinkEmbeds,
    ImageViewer.css, MiniMarkdownEditor, ResizeHandle

  features/
    onboarding/, sidebar/, search/, tags/, sparks/, bookmarks/, toc/
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
  src/index.js, config.js, session.js, googleAuth.js, driveClient.js
  src/routes/auth.js, drive.js
  README.md                          — setup/deploy

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
- See `TODO.md` for open/requested work and status.
- Token-budget passes (trimming file size for `compile/`'s LLM export,
  not just humans): `components/icons.jsx` is done. Largest remaining,
  if it's ever worth doing: `features/vector/VectorEditorView.jsx`
  (~2375), `App.jsx` (~1538), `features/vector/vectorState.js` (~1013),
  `lib/markdownRender.jsx` (~768), `features/vector/vectorTopology.js`
  (~689).
