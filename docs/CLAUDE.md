# CLAUDE.md

This file is read automatically by Claude Code at the start of every session
in this repository. It exists so that decisions and conventions don't have
to be re-explained. Treat everything in this file as standing project
context, not suggestions to reconsider. Historical changelog entries have
been moved out of this file (see `TODO.md` for open work) — this file now
holds only durable, still-true architecture facts.

## 1. What this project is

**store** (lowercase, always) — a file store that reads and writes `.md`
notes (and `.base` database, `.canvas` board) files directly to and from
the user's Google Drive. Client-only React SPA (no backend server, no
database of its own), runs entirely in the browser, packaged as an
installable PWA, deployed as a static site on GitHub Pages.

## 2. Tech stack (decided, not open questions)

- **Framework:** React 18 + Vite. Plain client-rendered SPA — no
  Next.js/Remix/SSR. `vite-plugin-pwa` handles the service worker and
  manifest.
- **Editor:** CodeMirror 6 (`@codemirror/state`, `@codemirror/view`,
  `@codemirror/commands`, `@codemirror/autocomplete`) driving a live
  "WYSIWYG-ish" markdown editor — see `features/editor/`.
- **Storage:** Google Drive REST API (`drive.file` scope) is the *only*
  persistence layer. No app backend, no app database. IndexedDB and an
  in-memory `Map` are used purely as caches (section 3.1).
- **Auth:** Google Identity Services (OAuth token client) loaded via
  `<script>` in `index.html`, wrapped by `hooks/useAuth.js`. An
  alternative "proxy" auth mode also exists for an Apps-Script-relay
  deployment path — see `lib/driveApi.js`'s `isProxy`/`proxy*` functions.
- **Hosting:** GitHub Pages via GitHub Actions (`vite.config.js` derives
  the `/<repo>/` base path from `GITHUB_REPOSITORY`).
- **Styling:** plain CSS, one stylesheet per component/feature (section
  5), no CSS-in-JS, no Tailwind, no CSS modules. Global tokens (`--bg-1`,
  `--accent`, `--font-mono`, etc.) live in `styles/theme.css`.

Don't propose swapping any of the above without a concrete, stated reason.

## 3. Non-negotiable architecture principles

### 3.1 Zero local note storage (do not weaken this)

Note **content** is never written to disk on this device. It lives only in
React state / in-memory caches for as long as the tab is open, and is
streamed to/from Drive over the REST API. IndexedDB (`lib/indexedDb.js`) is
used *exclusively* as a transient cache for (a) file metadata /
`modifiedTime`, and (b) the derived wikilink graph — never raw note
bodies. Clearing IndexedDB never loses data, because Drive is the single
source of truth. Image bytes follow the same rule
(`hooks/useDriveImageUrl.js` — fetched on demand, kept only as in-memory
blob URLs, never persisted). The full-text search/tag index
(`hooks/useVaultIndex.js`) takes this further: note bodies live in a
RAM-only `Map` at module scope, never IndexedDB, rebuilt from Drive on
every page load.

**Any new feature that touches note content must go through this same
discipline.** Cache derived-from-content data in a `useRef`/module-scope
`Map` (RAM), or don't cache it — never `idbPut` a note body or anything
derived from one. `vite.config.js`'s service-worker config enforces the
same rule at the network layer (`NetworkOnly` for all `googleapis.com`
traffic) — don't add `runtimeCaching` entries that cache API responses.

App settings/config that are *not* note content (accent color, the
frontmatter schema, graph view settings) are fine in `localStorage` — that
is a separate, sanctioned exception to this rule, not a loophole in it.

### 3.2 Decoupled Drive layer

All Google Drive REST calls are isolated in **`lib/driveApi.js`**. This is
the only file allowed to call `fetch()` against `googleapis.com`/the proxy
endpoint, or use `gapi`/Google Picker directly.

- Everything else — hooks, features, components — calls the plain
  functions this file exports (`driveGetFileContent`, `driveCreateFile`,
  `driveMoveItem`, etc.), never raw `fetch`.
- `hooks/useVaultSync.js`, `hooks/useAuth.js`, and `lib/indexedDb.js` sit
  directly on top of this layer; UI components should not — they call the
  hooks instead.
- Rationale: if this app ever needs a different backend, only
  `lib/driveApi.js` and the two hooks above need to change.

### 3.3 MVC-style separation of concerns

- **Model** = `lib/` (pure functions + the one Drive-access file) and the
  data-shaping half of `hooks/` (`useVaultSync`, `useVaultIndex`,
  `useDriveImageUrl`). Nothing here renders JSX except
  `lib/markdownRender.jsx`, a pure `(text) -> ReactNode` function.
- **Controller** = the top of `App.jsx` (state, effects, the `handlers`
  object passed down) plus feature-level hooks (`useAccentColor`,
  `useForceGraph`, `useClickOutside`, `useFrontmatterSchema`,
  `useAppUpdate`). Wires Model functions to View components; owns
  cross-cutting state (active pane, open modals, dirty-tracking).
- **View** = `components/` (generic, reusable) and `features/*`
  (feature-specific UI). Views call Model read functions only through
  props/hooks from `App.jsx` — a feature component should not reach into
  `lib/driveApi.js` or `lib/indexedDb.js` directly.

### 3.4 One source of truth per calculation

Each of these lives in exactly one file, and every feature that needs it
imports from there — never re-derive it inline:

| Calculation                                          | Lives in                  |
| ----------------------------------------------------- | -------------------------- |
| Markdown → tags/frontmatter/wikilinks parsing         | `lib/markdownParse.js`     |
| Markdown → React elements rendering                   | `lib/markdownRender.jsx`   |
| The ```query/```dataview language                     | `lib/queryEngine.js`       |
| Backlink / wikilink graph                             | `lib/linkGraph.js`         |
| Search matching + ranking                             | `lib/search.js`            |
| Split-pane tree math                                  | `lib/paneTree.js`          |
| File-kind classification                              | `lib/vaultConfig.js`       |
| DB row group-by/aggregate (count/sum/average)         | `dbState.js`'s `aggregateDbRows` |
| Frontmatter schema (properties, value options, child-properties) | `lib/frontmatterSchema.js` |

If a future feature needs a new cross-cutting calculation, give it the
same treatment: one new file in `lib/`, imported everywhere it's needed,
not copy-pasted.

### 3.5 Shared UI, floating menus

`components/` (`icons.jsx`'s `Icon*` set, `StatusBar`, `PropertiesPanel`,
`ResizeHandle`, `LinkEmbeds`, `InlineMentions`, `MiniMarkdownEditor`) are
the building blocks. **All icons live in `components/icons.jsx`** — add
new ones there rather than inlining a new `<svg>` in a feature file.

There is no generic `DropdownMenu` component anymore (deleted once its
last usage was converted). For a floating/toggleable menu, default to an
**inline panel**: a local `open`/`menuId` boolean plus a plain block
rendered in normal document flow, closed via `useClickOutside`. If the
trigger's scroll position is genuinely unpredictable (an arbitrary row
inside an `overflow: auto` container), `DbPopover`
(`features/database/DbCells.jsx`) is the one portal-based escape hatch
left in the app — a deliberate, documented exception for that specific
layout constraint, not a pattern to reach for by default.
`components/DropdownMenu.css` still holds shared `.menu-item`/
`.search-options-*` classes used by inline panels and `SearchPanel`.

A few floating surfaces are intentionally *not* inline: `PaletteModal`
(Cmd/Ctrl+K command palette) and `HelpModal` stay centered modals — a
"summon from anywhere, look something up, dismiss" interaction has no
natural anchor point, so a centered modal is the right shape, not a
workaround. Same for `FrontmatterSchemaSettings` (a settings lookup) and
`ProxyFolderBrowser`'s modal variant (a rare one-off action). Two
full-page modals were converted to right-docked slide-over panels instead
of inline expansion — `DbRowDetailModal` and `DbManageColumnsModal` —
since each is a "live list beside your other work," not a small menu;
`OnboardingFlow`, `CanvasFilePickerModal`, and `DbCells.jsx`'s
dense/table-cell popovers remain their original shapes for reasons
specific to each (see inline code comments before changing them).

### 3.6 Kind-aware, not kind-forked

A note pane's file can be a plain markdown note, a `.base` database, a
`.canvas` board, or the virtual graph view. This is handled by **one**
router (`features/editor/EditorContent.jsx`) switching on `file.kind` to
render `DatabaseView` / `CanvasView` / `GraphView` / the normal markdown
editor — not separate copy-pasted pane implementations. The graph view is
a real tab backed by a singleton pseudo-file (`graphPaneFile.js`, id
`__graph__`, injected into `filesById` but never into `sync.filesMeta`, so
it never triggers a Drive fetch or shows up in search). If a new file kind
is ever added, extend this same switch and follow that pseudo-file pattern
for anything not backed by a real Drive file, rather than forking
`PaneNode`/`LeafPane`.

### 3.7 File length — keep scripts short

Target **under ~400 lines** per file; **500 is a hard soft-ceiling** you
should stop and split past. When a file approaches the ceiling:

- If it's a component with sub-pieces only it uses, split those into
  sibling files in the same feature folder (see `features/database/`'s
  `DbCalendarView.jsx`/`DbChartView.jsx`/`DbTimelineView.jsx`/
  `DbViewPanel.jsx` split out of `DatabaseView.jsx` for the pattern).
- If it's a hook or lib file doing two unrelated things, split by
  responsibility, not by size alone.

**Known exceptions** (honest about limits, not hiding them): `App.jsx` is
the composition root (auth, pane tree, open buffers, every modal's open
flag, the `handlers` object) and has grown well past a comfortable size —
splitting it means extracting custom hooks (`usePaneTreeState`,
`useModalState`, etc.), a real future refactor deliberately not done
piecemeal. `lib/markdownRender.jsx` and `components/icons.jsx` are also
oversized by line count but low complexity per line (icons.jsx is ~60
near-identical one-line icon components); `markdownRender.jsx`'s
`renderMarkdownBlocks` is the best candidate if it's ever split.

## 4. Mobile performance & bundle size

Ongoing priority: this app should feel fast and light on a phone, not
just on desktop.

- **Code-split anything that isn't the note-editing hot path.** Graph
  view, help modal, command palette, database view, and canvas view are
  all lazy-loaded (`React.lazy` + `Suspense`) from `App.jsx` /
  `EditorContent.jsx`. Lazy-load any new large/optional feature the same
  way.
- **Respect the RAM-only caching rule (3.1).** Also a mobile win: avoids
  IndexedDB read/write churn (slow on mobile Safari) on the
  typing/scrolling hot path.
- **CodeMirror already virtualizes** (only renders visible
  lines/decorations). Don't add decoration logic that walks the whole
  document on every keystroke.
- **Avoid layout thrash** in frequently-updated UI (status bar, pane
  header, live query blocks): prefer CSS transforms/opacity over
  width/height/top/left animation; batch DOM reads before writes in
  imperative code (canvas dragging, resize handles).
- **Large lists should stay virtualized or paginated** as a vault grows —
  watch `ExplorerPanel.jsx`/`SearchPanel.jsx` if a large-vault user shows
  up.
- **Keep the PWA cache app-shell-only.** `vite.config.js`'s `workbox`
  config only precaches build output and explicitly `NetworkOnly`s
  Drive/auth traffic. Don't widen `globPatterns` or add `runtimeCaching`
  for API responses.
- **Touch-action is not inherited loosely** — an ancestor's
  `touch-action: none` can only be *narrowed* by a descendant, never
  loosened. Where a scrollable region sits inside a `touch-action: none`
  drag surface (canvas cards), the allowance (`pan-y`) has to be declared
  on the ancestor via `:has()`, and the drag-start handler must bail out
  when the pointerdown lands on genuinely overflowing content — see
  `canvas.css`/`CanvasView.jsx`'s `beginMove` for the pattern before
  copying it elsewhere.
- **On-screen keyboard can hide content with nowhere to scroll it to.**
  CodeMirror only lets you scroll as far as its own content height, so on
  a short note the last lines can end up permanently behind the mobile
  keyboard. Fix is a bounded (not infinite) extra bottom pad on the
  scroller, mobile-breakpoint-only — see `.cm-editor-host .cm-scroller`'s
  `@media (max-width: 720px)` rule in `features/editor/
  CodeMirrorEditor.css`. Apply the same pattern to any other
  text-input surface that can be focused on mobile (e.g. `DbTextCell`'s
  multiline editor) if the same complaint comes up there.

## 5. File structure

```
index.html                          — Vite entry HTML; loads Google Identity + gapi <script> tags, mounts src/main.jsx
vite.config.js                      — Vite + vite-plugin-pwa config; derives GitHub Pages base path; NetworkOnly Drive/auth caching; build-time __APP_VERSION__ stamp
public/                             — PWA icons, _nojekyll

src/
  main.jsx                          — ReactDOM root
  App.jsx                           — composition root: auth state, pane-tree state, open buffers, every
                                       modal's open/closed flag, the `handlers` object passed to every
                                       feature (see 3.7 for size)

  lib/                              — Model layer: pure functions + the one Drive-access file (3.3)
    vaultConfig.js                  — env-derived Drive config, MIME/extension tables, file-kind classification
    concurrency.js                  — mapWithConcurrency, withRetry
    indexedDb.js                    — the ONLY file touching IndexedDB; metadata/link-graph cache only (3.1)
    driveApi.js                     — the ONLY file calling the Drive REST API / proxy / Picker (3.2)
    markdownParse.js                — frontmatter, wikilinks, tags, inline fields — parsing only
    markdownRender.jsx              — markdown text -> React elements (reading view)
    queryEngine.js                  — the ```query/```dataview language
    linkGraph.js                    — wikilink + backlink index, fuzzy note-title matching
    search.js                       — full-text/tag search parsing and ranking
    paneTree.js                     — split-pane tree math
    frontmatterSchema.js            — customizable frontmatter property schema (3.4)
    mathUtils.js                    — clamp

  hooks/
    useAuth.js                      — useGoogleAuth (Identity Services, remembered sign-in via localStorage), useProxyAuth
    useVaultSync.js                 — owns the live file tree, drives Drive polling/diffing
    useVaultIndex.js                — RAM-only search/tag index built from note bodies (3.1)
    useDriveImageUrl.js             — on-demand image byte fetch -> in-memory blob URL cache (3.1)
    useClickOutside.js              — generic "close on outside click" hook
    useFrontmatterSchema.js         — persisted frontmatter schema state
    useAppUpdate.js                 — wraps vite-plugin-pwa's useRegisterSW; surfaces "update available"

  components/                       — Generic, reusable View pieces (3.5)
    icons.jsx                       — every <Icon*/> in the app
    DropdownMenu.css                — shared .menu-item/.search-options-* styles (component itself deleted)
    ActivityBar.jsx / .css          — left-most icon ribbon
    StatusBar.jsx / .css            — footer: word count, sync status, version/update control
    PropertiesPanel.jsx / .css      — frontmatter property editor
    InlineMentions.jsx / .css       — linked/unlinked mentions block
    LinkEmbeds.jsx                  — AmbiguousLink, ImageEmbed
    ImageViewer.css                 — inline image rendering styles
    MiniMarkdownEditor.jsx / .css   — small CM6 instance for db cells / canvas cards (3.5)
    ResizeHandle.jsx                — generic drag-to-resize handle

  features/
    onboarding/     OnboardingFlow.jsx / .css, ProxyFolderBrowser.jsx
    sidebar/        ExplorerPanel.jsx / .css, sidebar.css
    search/         SearchPanel.jsx / .css
    tags/           TagsPanel.jsx / .css
    bookmarks/      BookmarksPanel.jsx
    toc/            TocPanel.jsx
    panes/          PaneNode.jsx / .css (recursive split-pane + LeafPane), TabBar.jsx / .css, PaneHeader.css
    editor/                         — CodeMirror integration; the note-editing hot path (section 4)
      CodeMirrorNoteEditor.jsx      — the CM6 instance: extensions, keymaps, live-preview wiring
      EditorContent.jsx / .css      — reading/editing mode switch; routes by file.kind (3.6)
      NoteTitleField.jsx
      inlinePreviewPlugin.js        — CM6 ViewPlugin: hides markdown syntax around the cursor's line
      wysiwygBlocks.jsx             — block-level live-preview widgets
      wikilinkCompletion.js         — [[wikilink]] and #tag autocomplete
      frontmatterCompletion.js      — schema-driven frontmatter key/value autocomplete (only inside --- blocks)
      cmIndent.js                   — Tab/Shift-Tab indent
      TaskCheckboxWidget.js         — clickable `- [ ]` checkboxes
    query/          QueryBlock.jsx / .css
    assets/         AssetPane.jsx
    database/                       — Notion-style views for .base files
      dbState.js                    — row/column model, parse/serialize, aggregateDbRows (3.4)
      DbCells.jsx                   — per-column-type cell editors; also owns the DbPopover portal exception (3.5)
      DbViews.jsx                   — table/board/gallery view renderers
      DbCalendarView.jsx, DbChartView.jsx, DbTimelineView.jsx — calendar/chart/timeline views (3.7 split)
      dbDateUtils.jsx                — shared date-column picker + date math for calendar/timeline
      DbViewPanel.jsx                — add-view / view-settings inline panel (extracted from DatabaseView, 3.7)
      DbModals.jsx                   — row detail + manage-columns panels (slide-over shells, 3.5)
      DatabaseView.jsx               — top-level view switcher + view-tab bar
    canvas/                         — infinite-canvas board for .canvas files
      canvasState.js                 — node/edge model, hit-testing, parse/serialize
      CanvasToolbar.jsx, CanvasFilePickerModal.jsx, CanvasNode.jsx
      CanvasView.jsx                 — pan/zoom/drag, touch-action handling (section 4)
    graph/
      useForceGraph.js               — force-directed layout simulation (framework-agnostic; tunable forces)
      graphSettings.js                — persisted Filters/Groups/Forces (localStorage)
      graphPaneFile.js                — the `__graph__` pseudo-file (3.6)
      GraphView.jsx                   — the graph pane itself (local graph, groups, forces, tags-as-nodes)
      GraphViewModal.css              — graph pane styles (filename predates the modal->pane conversion)
    compile/                        — vault <-> XML for LLM mass-editing
      compileVault.js                 — flatten/include-exclude/build XML/parse+apply XML, incl. <create>/<delete> (pure logic)
      CompilePanel.jsx / .css         — sidebar panel: compile (copy/download) and apply (paste/upload)
    palette/        PaletteModal.jsx / .css
    help/           HelpModal.jsx      — in-app shortcuts/markdown/features reference (keep in sync — section 6)
    settings/       FrontmatterSchemaSettings.jsx / .css
    accent/         accentColor.js, AccentColorPicker.jsx

  styles/
    index.css                      — imports every other stylesheet, in cascade order (don't reorder without checking mobile overrides)
    theme.css                      — design tokens + base reset
    layout.css                     — app shell grid
    modal.css                      — shared centered-modal-overlay look (still used by Palette/Help/Onboarding/FrontmatterSchemaSettings/CanvasFilePickerModal)
    responsive.css                 — mobile breakpoints (kept as one file; import order matters, see index.css)
```

A CSS file next to a component/feature file with the same name is that
piece's styles. Not every JS/JSX file has a matching CSS file — some share
a feature-level stylesheet (`canvas.css`, `database.css`, `sidebar.css`).

## 6. Keep the in-app help in sync

`features/help/HelpModal.jsx` (`HELP_SHORTCUTS`, `HELP_MARKDOWN`,
`HELP_FEATURES`) is the in-app reference, including the query-engine
syntax guide. Any change to a keyboard shortcut, markdown syntax, or
feature behavior should update the matching entry here in the same piece
of work, not as a deferred follow-up.

## 7. When in doubt

- Don't relitigate the stack choices in section 2 without a concrete new
  reason.
- Don't weaken section 3.1 (zero local note-content storage) for a
  performance shortcut — section 4 lists the sanctioned ways to make
  things faster instead, all of which keep the invariant intact.
- Prefer extending an existing `lib/` module over adding a new one that
  duplicates part of it (section 3.4).
- If you notice a file creeping past ~500 lines while working on it,
  split it as part of that change rather than leaving it for later
  (section 3.7) — unless it's one of the known exceptions, in which case
  leave a comment rather than a silent oversized file.
- If you add a new optional/heavy feature, default to lazy-loading it
  (section 4).
- For a new floating menu, default to an inline panel; only reach for a
  portal (`DbPopover`) when the trigger's scroll position is genuinely
  unpredictable (section 3.5).
- See `TODO.md` for open/requested work and its current status.
