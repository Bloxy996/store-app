# CLAUDE.md

This file is read automatically by Claude Code at the start of every session
in this repository. It exists so that decisions and conventions don't have
to be re-explained. Treat everything in this file as standing project
context, not suggestions to reconsider.

---

## 1. What this project is

**store** (lowercase, always — see section 10) — a file store that reads and
writes `.md` notes (and `.base` database, `.canvas` board) files directly to
and from the user's Google Drive. It is a client-only React SPA (no backend
server, no database of its own) that runs entirely in the browser, packaged
as an installable PWA and deployed as a static site on GitHub Pages.

The app was originally a single ~10,500-line `App.jsx` + ~4,300-line
`App.css`. It has since been restructured into the module layout described
in section 5, for the reasons in section 3. The restructuring changed *file
organization only* — component behavior, class names, and CSS cascade order
are unchanged (every split file's content, minus incidental blank lines, is
byte-identical to the region it came from in the original file).

---

## 2. Tech stack (decided, not open questions)

- **Framework:** React 18 + Vite. Plain client-rendered SPA — no
  Next.js/Remix/SSR. `vite-plugin-pwa` handles the service worker and
  manifest.
- **Editor:** CodeMirror 6 (`@codemirror/state`, `@codemirror/view`,
  `@codemirror/commands`, `@codemirror/autocomplete`) driving a live
  "WYSIWYG-ish" markdown editor — see `features/editor/`.
- **Storage:** Google Drive REST API (`drive.file` scope) is the *only*
  persistence layer. There is no app backend and no app database.
  IndexedDB and an in-memory `Map` are used purely as caches — see the
  non-negotiable rule in section 3.1.
- **Auth:** Google Identity Services (OAuth token client) loaded via
  `<script>` tag in `index.html`, wrapped by `hooks/useAuth.js`. An
  alternative "proxy" auth mode also exists for the Apps-Script-relay
  deployment path — see `lib/driveApi.js`'s `isProxy`/`proxy*` functions.
- **Hosting:** GitHub Pages via GitHub Actions (`vite.config.js` derives the
  `/<repo>/` base path automatically from `GITHUB_REPOSITORY`).
- **Styling:** plain CSS, one stylesheet per component/feature (see section
  5), no CSS-in-JS, no Tailwind, no CSS modules. Global tokens (`--bg-1`,
  `--accent`, `--font-mono`, etc.) live in `styles/theme.css`.

Do not propose swapping any of the above without a concrete, stated reason.

---

## 3. Non-negotiable architecture principles for all future work

### 3.1 Zero local note storage (the original rule — do not weaken this)
This is the single most important invariant in the app, stated at the top
of the original `App.jsx` and preserved verbatim as a comment at the top of
`lib/indexedDb.js`:

> Note **content** is never written to disk on this device. It lives only
> in React state / in-memory caches for as long as the tab is open, and is
> streamed to/from Drive over the REST API. IndexedDB (`lib/indexedDb.js`)
> is used *exclusively* as a transient cache for (a) file metadata /
> `modifiedTime`, and (b) the derived wikilink graph — never raw note
> bodies. Clearing IndexedDB never loses data, because Drive is the single
> source of truth. Image bytes follow the same rule (`hooks/useDriveImageUrl.js`
> — fetched on demand, kept only as in-memory blob URLs, never persisted).
> The full-text search / tag index (`hooks/useVaultIndex.js`) takes this
> one step further: note bodies live in a RAM-only `Map` at module scope,
> never IndexedDB, and are rebuilt from Drive on every page load.

**Any new feature that touches note content must go through this same
discipline.** If you're tempted to `idbPut` a note body, a rendered
preview, or anything derived from note content "for speed," don't — cache
it in a `useRef`/module-scope `Map` instead (RAM), or don't cache it.
`vite.config.js`'s service-worker config enforces the same rule at the
network layer (`NetworkOnly` for all `googleapis.com` traffic, so Drive
content is never cached by the SW either) — don't add `runtimeCaching`
entries that cache API responses.

### 3.2 Decoupled Drive layer
All Google Drive REST calls are isolated in **`lib/driveApi.js`**. This is
the only file allowed to call `fetch()` against `googleapis.com`/the proxy
endpoint, or use `gapi`/Google Picker directly.

- Everything else — hooks, features, components — calls the plain
  functions this file exports (`driveGetFileContent`, `driveCreateFile`,
  `driveMoveItem`, etc.), never raw `fetch`.
- `hooks/useVaultSync.js`, `hooks/useAuth.js`, and `lib/indexedDb.js` sit
  directly on top of this layer (they're allowed to import it); UI
  components should not — they call the hooks instead.
- Rationale: if this app ever needs a different backend (a different cloud
  drive, a self-hosted sync server), only `lib/driveApi.js` and the two
  hooks above need to change. Every component and every rendering/parsing
  module is unaware Drive exists.

### 3.3 MVC-style separation of concerns
- **Model** = `lib/` (pure functions + the one Drive-access file) and the
  data-shaping half of `hooks/` (`useVaultSync`, `useVaultIndex`,
  `useDriveImageUrl`). Nothing in here renders JSX except
  `lib/markdownRender.jsx`, whose whole job *is* turning markdown text into
  React elements — it's still a pure `(text) -> ReactNode` function, not a
  stateful component.
- **Controller** = the top of `App.jsx` (state, effects, the `handlers`
  object passed down) plus the feature-level hooks (`useAccentColor`,
  `useForceGraph`, `useClickOutside`). This is what wires Model
  functions to View components and owns cross-cutting state (which pane is
  active, which modal is open, the buffers/dirty-tracking map).
- **View** = `components/` (generic, reusable) and `features/*` (one
  feature's UI, may be feature-specific). Views call Model read functions
  only through props/hooks passed down from `App.jsx` — a feature
  component should not reach into `lib/driveApi.js` or `lib/indexedDb.js`
  directly.

### 3.4 One source of truth per calculation
Each of these lives in exactly one file, and every feature that needs it
imports from there — never re-derive it inline:

| Calculation | Lives in |
|---|---|
| Markdown → tags/frontmatter/wikilinks parsing | `lib/markdownParse.js` |
| Markdown → React elements rendering | `lib/markdownRender.jsx` |
| The `\`\`\`query` / `\`\`\`dataview` language | `lib/queryEngine.js` |
| Backlink / wikilink graph | `lib/linkGraph.js` |
| Search matching + ranking | `lib/search.js` |
| Split-pane tree math (splitting, resizing, closing) | `lib/paneTree.js` |
| File-kind classification (`isImageName`, `classifyKind`, ...) | `lib/vaultConfig.js` |

If a future feature needs a new cross-cutting calculation, give it the same
treatment: one new file in `lib/`, imported everywhere it's needed, not
copy-pasted.

### 3.5 Shared UI, not per-feature styling
`components/` (`icons.jsx`'s 60+ `Icon*` set, `StatusBar`,
`PropertiesPanel`, `ResizeHandle`, `LinkEmbeds`, `InlineMentions`) are the
building blocks. **All icons live in `components/icons.jsx`** — don't
inline a new `<svg>` in a feature file; add it there and import it, so
there's one place to keep stroke-width/size/viewBox consistent. For a
floating/toggleable menu, don't hand-roll a new one-off implementation:
follow the inline-panel pattern established across the popup→inline
changelog (sections 15–17) — a local `open`/`menuId` boolean plus a plain
block rendered in normal document flow, closed via `useClickOutside` — or,
if the trigger's scroll position is genuinely unpredictable (arbitrary row
in an `overflow: auto` container), `DbPopover` (`features/database/
DbCells.jsx`) is the one portal-based escape hatch left in the app.
`components/DropdownMenu.css` still holds the shared `.menu-item`/
`.search-options-*` classes those inline panels use, but the
`DropdownMenu` *component* was deleted once its last usage was converted
(section 17) — don't resurrect it for a new case without a concrete reason
inline panels/`DbPopover` don't cover.

### 3.6 Kind-aware, not kind-forked
A note pane's file can be a plain markdown note, a `.base` database, or a
`.canvas` board. This is handled by **one** router
(`features/editor/EditorContent.jsx`) switching on `file.kind` to render
`DatabaseView` / `CanvasView` / the normal markdown editor — not three
separate copy-pasted pane implementations. If a new file kind is ever
added, extend this same switch rather than forking `PaneNode`/`LeafPane`.

### 3.7 File length — keep scripts short
Target **under ~400 lines** per file; **500 is a hard soft-ceiling** you
should stop and split past. This was explicitly requested and applies
going forward, not just to this initial restructuring. When a file
approaches the ceiling:
- If it's a component with sub-pieces only it uses (a modal with an inner
  row/cell/toolbar component), split those into sibling files in the same
  feature folder (see `features/database/` and `features/canvas/` for the
  pattern — cells, views, and modals each got their own file instead of
  living inside `DatabaseView.jsx`).
- If it's a hook or lib file doing two unrelated things, split by
  responsibility, not by size alone.

**Known exceptions** (honest about limits, not hiding them):
- **`App.jsx` (~1,150 lines).** This is the composition root — it owns all
  top-level state (auth, active pane tree, open buffers, every modal's open
  flag) and wires every feature together. Splitting it further means
  extracting custom hooks (`usePaneTreeState`, `useModalState`, etc.) — a
  real follow-up, deliberately not done in this pass because it touches the
  most state-sensitive code in the app and deserves its own careful,
  reviewed change rather than being bundled into a mechanical restructuring.
- **`lib/markdownRender.jsx` (~685 lines)** and **`components/icons.jsx`**
  (~550 lines, but ~60 nearly-identical one-line icon components — genuinely
  low complexity per line, not a candidate for further splitting).
  `markdownRender.jsx` is a reasonable candidate for a future split
  (`renderMarkdownBlocks`, at ~345 lines, is the biggest single piece and
  could become its own file).

---

## 4. Mobile performance & bundle size

Explicitly requested as an ongoing priority: this app should feel fast and
light on a phone, not just on desktop.

- **Code-split anything that isn't the note-editing hot path.** The graph
  view, help modal, command palette, database view, and canvas view are all
  lazy-loaded (`React.lazy` + `Suspense`) from `App.jsx` /
  `EditorContent.jsx` — someone who opens the app to edit a markdown note
  never downloads the force-graph physics code, the Notion-style table
  editor, or the infinite-canvas renderer. If you add another
  large/optional feature (a new file-kind view, a big modal), lazy-load it
  the same way rather than adding it to the main bundle. Verified: a real
  `esbuild --splitting` build of this structure produces a ~159KB main
  chunk plus separate ~3–50KB chunks per lazy feature, instead of one
  monolithic bundle everyone pays for on first load.
- **Respect the RAM-only caching rule (section 3.1).** It's also a mobile
  performance win, not just an architecture nicety: it avoids IndexedDB
  read/write churn (slow on mobile Safari in particular) for anything on
  the typing/scrolling hot path.
- **CodeMirror already virtualizes** (only renders visible lines/decorations
  via `visibleRanges`) — don't add decoration logic that walks the whole
  document on every keystroke; scope work to the visible range the way
  `buildInlinePreviewPlugin` already does.
- **Avoid layout thrash in frequently-updated UI** (status bar, pane
  header, live query blocks): prefer CSS transforms/opacity over
  width/height/top/left animation, and batch DOM reads before writes in any
  new imperative code (canvas dragging, resize handles) the way
  `CanvasView.jsx`'s existing drag handling does.
- **Large lists should stay virtualized or paginated** as the vault grows —
  the file tree and search results are the most likely to need this if a
  future vault has thousands of notes; not an issue at typical vault sizes
  today, but flag it if you're touching `ExplorerPanel.jsx` or
  `SearchPanel.jsx` for a large-vault user.
- **Keep the PWA cache app-shell-only.** `vite.config.js`'s `workbox`
  config only precaches build output (`js,css,html,ico,png,svg,woff2`) and
  explicitly `NetworkOnly`s Drive/auth traffic. Don't widen
  `globPatterns` or add `runtimeCaching` for API responses — that would
  both violate section 3.1 and bloat the installed app's on-disk footprint.

---

## 5. File structure

```
index.html                          — Vite entry HTML; loads Google Identity + gapi <script> tags, mounts src/main.jsx
vite.config.js                      — Vite + vite-plugin-pwa config; derives GitHub Pages base path; NetworkOnly Drive/auth caching
public/
  _nojekyll                         — disables Jekyll processing on GitHub Pages (needed for _-prefixed asset paths)
  (icons, manifest assets — unchanged, not part of this restructuring)

src/
  main.jsx                          — ReactDOM root; imports styles/index.css
  App.jsx                           — composition root: auth state, pane-tree state, open buffers, every
                                       modal's open/closed flag, the `handlers` object passed to every
                                       feature. See section 3.7 for why this stays large.

  lib/                              — Model layer: pure functions + the one Drive-access file. No React
                                       state, no JSX except markdownRender.jsx (see 3.3).
    vaultConfig.js                  — env-derived Drive config, MIME/extension tables, file-kind classification
    concurrency.js                 — mapWithConcurrency, withRetry (generic async helpers)
    indexedDb.js                    — the ONLY file touching IndexedDB; metadata/link-graph cache only (3.1)
    driveApi.js                     — the ONLY file calling the Drive REST API / proxy / Picker (3.2)
    markdownParse.js                — frontmatter, wikilinks, tags, inline fields — parsing only, no rendering
    markdownRender.jsx               — markdown text -> React elements (reading view), tables, callouts, tabs
    queryEngine.js                  — the ```query/```dataview language: tokenizer, parser, evaluator
    linkGraph.js                    — wikilink + backlink index, fuzzy note-title matching
    search.js                       — full-text/tag search parsing and ranking
    paneTree.js                     — split-pane tree math (pure data structure, no rendering)
    mathUtils.js                    — clamp

  hooks/                            — Controller-ish: stateful wrappers around lib/, shared across features.
    useAuth.js                      — useGoogleAuth (Identity Services), useProxyAuth (Apps Script relay mode)
    useVaultSync.js                 — the big one: owns the live file tree, drives Drive polling/diffing
    useVaultIndex.js                — RAM-only search/tag index built from note bodies (3.1)
    useDriveImageUrl.js             — on-demand image byte fetch -> in-memory blob URL cache (3.1)
    useClickOutside.js              — generic "close on outside click" hook used by menus/pickers

  components/                       — Generic, reusable View pieces (3.5). No feature-specific logic.
    icons.jsx                       — every <Icon*/> in the app, plus Svg wrapper and ASSET_KIND_ICONS
    DropdownMenu.css                — shared .menu-item/.search-options-* styles (component deleted, section 17)
    ActivityBar.jsx / .css          — left-most icon ribbon (switch sidebar panel)
    StatusBar.jsx / .css            — footer: word count, sync status, selection info
    PropertiesPanel.jsx / .css      — frontmatter property editor
    InlineMentions.jsx / .css       — linked/unlinked mentions block at the bottom of reading view
    LinkEmbeds.jsx                  — AmbiguousLink, ImageEmbed (inline image rendering in markdown)
    ResizeHandle.jsx                — generic drag-to-resize handle

  features/                         — One folder per feature; may contain multiple files once a feature
                                       grows past ~1 file's worth of reasonable size (3.7).
    onboarding/
      OnboardingFlow.jsx / .css     — sign-in / folder-select / loading shell shown before a vault is open
      ProxyFolderBrowser.jsx        — folder picker for the Apps-Script-proxy auth path
    sidebar/
      ExplorerPanel.jsx / .css      — file tree, drag/drop, add/rename/delete menus
      sidebar.css                  — shared dock container styles (explorer/search/tags/bookmarks)
    search/       SearchPanel.jsx / .css       — vault-wide search UI
    tags/         TagsPanel.jsx / .css         — tag tree browser
    bookmarks/    BookmarksPanel.jsx           — starred notes
    toc/          TocPanel.jsx                 — active note's heading outline
    panes/
      PaneNode.jsx / .css          — recursive split-pane layout + LeafPane (renders one open file)
      TabBar.jsx / .css, PaneHeader.css — tab strip, breadcrumb, back/forward/split/close controls
    editor/                        — CodeMirror integration; the note-editing hot path (see section 4)
      CodeMirrorNoteEditor.jsx      — the CM6 instance: extensions, keymaps, live-preview wiring
      EditorContent.jsx / .css      — reading/editing mode switch; routes to Database/Canvas view by kind (3.6)
      NoteTitleField.jsx            — the note-title input above the editor
      inlinePreviewPlugin.js        — CM6 ViewPlugin: hides markdown syntax around the cursor's line
      wysiwygBlocks.jsx             — block-level live-preview widgets (editable tables, etc.)
      wikilinkCompletion.js         — [[wikilink]] and #tag autocomplete source
      cmIndent.js                   — Tab/Shift-Tab indent, including nested/wrapped-line indent
      TaskCheckboxWidget.js         — CM6 widget: clickable `- [ ]` checkboxes
    query/        QueryBlock.jsx / .css        — renders a ```query block's live results table/list
    assets/       AssetPane.jsx                — image/video/audio/file panes for non-markdown files
    database/                      — Notion-style table view for .base files
      dbState.js                   — row/column model, parse/serialize .base content
      DbCells.jsx                  — per-column-type cell editors (text/number/select/date/attachment/...)
      DbViews.jsx                  — table/board/gallery view renderers
      DbModals.jsx                 — row detail modal, manage-columns modal
      DatabaseView.jsx             — top-level view switcher + view-tab bar
    canvas/                        — infinite-canvas board for .canvas files
      canvasState.js                — node/edge model, hit-testing, parse/serialize .canvas content
      CanvasToolbar.jsx, CanvasFilePickerModal.jsx, CanvasNode.jsx
      CanvasView.jsx                — the interactive canvas itself (pan/zoom/drag) — largest single feature file
    graph/
      useForceGraph.js              — force-directed layout simulation
      GraphViewModal.jsx / .css     — full-vault wikilink graph modal
    palette/      PaletteModal.jsx / .css      — Cmd/Ctrl+K command palette + quick file switcher
    help/         HelpModal.jsx                — in-app shortcuts/markdown/features reference (keep in sync — 6)
    accent/       accentColor.js, AccentColorPicker.jsx — user accent-color theming

  styles/
    index.css                      — imports every other stylesheet, in the exact original cascade order
    theme.css                      — design tokens (colors, fonts, spacing) + base reset
    layout.css                     — app shell grid
    modal.css                      — shared generic modal-overlay look
    responsive.css                 — mobile breakpoints (kept as one file; see note below)
```

A CSS file next to a component/feature file with the same name is that
piece's styles (e.g. `ExplorerPanel.jsx` + `ExplorerPanel.css`). Not every
JS/JSX file has a matching CSS file — some share a feature-level stylesheet
(e.g. everything under `panes/` could later be split further; today
`PaneNode.css`, `TabBar.css`, `PaneHeader.css` already mirror the three
`panes/` component files 1:1).

`styles/responsive.css` intentionally stays one file rather than being
split per-feature: the original cascade relies on it being imported after
the desktop rules it overrides, and `styles/index.css` preserves that exact
original import order — don't reorder the `@import` lines in that file
without checking whether a mobile override depends on the current order.

---

## 6. Keep the in-app help in sync

`features/help/HelpModal.jsx` (`HELP_SHORTCUTS`, `HELP_MARKDOWN`,
`HELP_FEATURES`) is the in-app reference, including the query-engine syntax
guide. Any change to a keyboard shortcut, markdown syntax, or feature
behavior should update the matching entry here in the same piece of work,
not as a deferred follow-up.

---

## 7. When in doubt

- Don't relitigate the stack choices in section 2 without a concrete new
  reason.
- Don't weaken section 3.1 (zero local note-content storage) for a
  performance shortcut — section 4 lists the sanctioned ways to make things
  faster instead (RAM caches, code-splitting, virtualization), all of which
  keep the invariant intact.
- Prefer extending an existing `lib/` module over adding a new one that
  duplicates part of it (section 3.4). If two features need the same small
  calculation, that calculation belongs in `lib/`, not copied into both.
- If you notice a file creeping past ~500 lines while working on it, split
  it as part of that change rather than leaving it for later (section 3.7)
  — unless it's one of the known exceptions in that section, in which case
  leave a comment rather than a silent oversized file.
- If you add a new optional/heavy feature, default to lazy-loading it
  (section 4) rather than adding it to the main bundle.

---

## 8. Changelog — 2026 linking/editing/highlight/sort patch

Fixes and additions made in one pass (see `changes.patch`), plus what's
deliberately left for a follow-up. Read this before touching editor
inline-mark handling, `PropertiesPanel`, `EditorContent`'s selection
effects, or database table sorting — the reasoning below explains *why*
the code looks the way it does now, not just what changed.

**Fixed (real bugs, not just missing features):**
- `PropertiesPanel` rendered `[[wikilink]]` frontmatter values (e.g.
  `related: [[Other Note]]`) as inert text — never resolved/clickable.
  Now parses each comma-split value the same way the note body does.
- Reading view's `renderInline` (`lib/markdownRender.jsx`) had no cases
  for `==highlight==`, `~~strike~~`, `__bold__`, or single-`_` italic —
  they rendered as literal punctuation. All four now render, plus a new
  `++underline++` syntax. `==highlight==` uses `var(--accent-soft)`
  (matches text-selection / drag-over color) instead of hardcoded yellow,
  in both the editor (`.cm-highlight`) and reading view (`.md-highlight`).
- Selection-scoped word/char count in the status bar: `EditorContent`'s
  selection-tracking effects had `handlers` in their dependency array.
  `handlers` (built with `useMemo` in `App.jsx`) gets a new identity on
  most unrelated re-renders (typing, vault-index progress, sync ticks),
  so the effect's cleanup — which nulls the selection — fired almost
  immediately after any real selection, snapping the count back to the
  whole-note numbers. Fixed by keeping `handlers` in a ref and keying the
  effects only on `file?.id`/`mode`. **If you add anything else to those
  effects, don't put `handlers` (or any object rebuilt by that `useMemo`)
  back in the dependency array** — reach into `handlersRef.current`
  inside the effect body instead.
- List soft-wrap in the editor only accounted for leading whitespace, so
  a wrapped line of a bullet/checkbox/numbered item fell back to column 0
  instead of lining up under the item's text. `inlinePreviewPlugin.js`'s
  `listPrefixLen` now measures the full marker prefix (indent + marker +
  following space) for bullet, checkbox, ordered, and lettered lines.

**Added:**
- Ordered lists now accept `1)` as well as `1.`, and preserve a leading
  zero (`01)`, `02)`, …) exactly as typed rather than renumbering it —
  both `inlinePreviewPlugin.js` (editor dimming) and `markdownRender.jsx`
  (reading view) parse this the same way.
- Lettered lists: `a) item` / `A. item` (either case, either delimiter).
  Reading view renders these (and ordered lists) with an explicit marker
  span (`.list-marker`) rather than the browser's native `<ol>` counter,
  specifically so leading zeros and letter case survive — don't switch
  this back to a bare `<ol>` without re-solving that.
- Database table view: click a sortable column header to cycle
  unsorted → ascending → descending → unsorted. Sort state
  (`sortColumnId`/`sortDir`) lives on the view object, same persistence
  path as `groupByColumnId`. Sortability is type-gated via
  `DB_SORTABLE_TYPES` in `dbState.js` — multi-select and the attachment
  types (image/video/audio/file) are excluded on purpose, not an
  oversight; extend that set rather than sorting everything.
- `HelpModal.jsx` updated for all of the above, plus previously-missing
  documentation for existing features (Canvas had no Features-tab entry
  at all).

**Deliberately deferred (each is its own follow-up, not a partial job
buried in this one):**
- ~~**Full markdown editing inside database cells and canvas cards**~~ —
  done for multiline cells and canvas text cards, see section 12. Single-
  line text cells (row titles, short properties) deliberately stay plain
  `<input>` — see that section for why.
- **Site-wide popup → inline conversion.** Touches `DropdownMenu`,
  `PaletteModal`, `GraphViewModal`, the image viewer, `DbModals`,
  `OnboardingFlow`, and the canvas file picker — a UI-architecture
  change across most of `features/`, not a single-file fix.
- **Graph view revamp** (more Obsidian-like force graph). Current
  `features/graph/useForceGraph.js` + `GraphViewModal.jsx` are a
  reasonable starting point but need real research/rework (force
  parameters, local-neighborhood view, node sizing by connection count,
  filters) rather than incremental tweaks.
- ~~**Canvas fixes**: connection-point dots clipped, no nearby-target
  highlight, broken groups, background grid not panning, mobile support~~
  — done, see section 11. Full markdown-in-card editing for canvas text
  nodes is still not done (still tracked in the bullet above — it's the
  same underlying work as database cells).
- **Timeline / calendar / chart (bar/line/pie) views for databases.**
  New view types alongside table/board/gallery in `DbViews.jsx` +
  `dbState.js` — each is a real feature on the scale of the existing
  board/gallery views, not a small addition.

Tackle these in separate passes; don't half-implement one alongside
unrelated work.

---

## 9. Changelog — database row-linking

**Added:** `[[Database.base#Row Title]]` deep-links to a specific row.
- The `[[Target#fragment]]` syntax already existed textually (used for
  note headings, though heading navigation itself was never wired up) —
  `renderInline` (`lib/markdownRender.jsx`) now captures the fragment
  instead of discarding it, and passes it to `handlers.onOpenById(id, {
  rowTarget })` when the resolved file is kind `'database'`. Kept out of
  `resolveLinkTarget`/`linkGraph.js` on purpose: fragment handling is a
  rendering/navigation concern, not a link-resolution one — the file
  still resolves exactly as it did before.
- **Match key is the row's title (first text column), not a stored row
  id** — same "resolve by name" philosophy as every other link in this
  app (see `linkGraph.js`'s header comment). First match wins if two rows
  share a title; there's no row-id syntax. If that becomes a real problem
  for a large vault, revisit — don't add a parallel id-based syntax
  without a concrete case for it.
- New state: `App.jsx`'s `pendingRowOpen` (`{ fileId, rowTarget }`),
  threaded through `PaneNode`/`LeafPane` → `EditorContent` →
  `DatabaseView` as plain props — **deliberately not put inside the
  memoized `handlers` object**, which would churn its identity on every
  row-link click and re-trigger the exact `handlers`-in-deps bug fixed in
  section 8 (`EditorContent`'s selection/nav effects). `DatabaseView`
  reads `initialRowTarget`, opens the matching row's detail modal via the
  existing `setOpenRowId`, then calls `onConsumeRowTarget` — effect is
  keyed only on `[initialRowTarget]`, not `state.rows`, so it doesn't
  re-fire and re-open the row while the user is mid-edit elsewhere in the
  same database.
- `HelpModal.jsx` documents the new syntax (section 6).

**Not done (still applies from the list above):** autocomplete doesn't
suggest row titles after typing `[[Database.base#` — it just stops
suggesting file names at that point, same as it already did for
`#heading`. Worth adding once row-linking sees real use, not bundled in
here since it's a separate, smaller piece (extend
`wikilinkCompletion.js`'s wiki-match branch to detect a `#` in the
already-typed target and switch its candidate pool to that database's row
titles).


---

## 10. Rebrand — "store"

The product name is **store**, lowercase everywhere — page title, PWA
manifest `name`/`short_name`, `package.json` `name`, onboarding heading,
and every UI string that named the product or the user's Drive folder as
"Vault" (`Sync vault now` → `Sync store now`, `Empty vault…` →
`Empty store…`, the Google Picker dialog title, etc.). The previous
description leaned on "markdown notebook" / "note storage" language —
per direct request, taglines (manifest description, `index.html` meta
description, `package.json` description, the onboarding folder-pick
copy) are now written generically as a file store, not scoped to notes
specifically; the app still creates/edits notes, databases, and canvases
exactly as before, only the marketing copy stopped calling that out as
the whole identity.

**Deliberately NOT renamed — internal identifiers, not branding:**
`vaultConfig.js`, `useVaultSync`/`useVaultIndex`, `buildVaultTree`,
`linkGraph.js`'s "vault" comments, the `vaultRootId`/`vault_proxy_url_draft`/
`vault_access_token`/`vault_accent_color`/`vaultFolder` storage keys, the
`application/x-vault-node`/`application/x-vault-db-row` internal DnD MIME
strings, and `driveApi.js`'s `listVaultFiles` proxy action name (a wire
value the Apps Script proxy backend matches on — renaming it would break
every already-deployed proxy). None of these are user-visible; renaming
them is a pure internal-naming refactor across ~15 files with no
functional benefit and real regression risk (especially the storage keys,
which would silently drop an existing user's saved folder/token/accent
choice), so they were left alone. Extend this same rule going forward:
new user-facing copy says "store"; new internal identifiers can keep
using "vault" as an implementation word if that's the clearest name for
what they do — it's not a rule to relitigate per file.

**Not touched:** the actual icon artwork (`public/icon-*.png`,
`apple-touch-icon.png`) and the GitHub repo's own name/URL — both are
outside what a code change can do; regenerate the icons and rename the
repo separately if the "V" mark or the `vault-drive-pwa` slug need to go
too.

---

## 11. Changelog — canvas bug-fix pass (dots/groups/grid/connect)

One pass out of the 5 items deferred in section 8 (`changes.patch`). The
other 4 (markdown-in-cell/card editing, popup→inline conversion, graph
revamp, database timeline/calendar/chart views) are **not** touched here —
see below for why each was left for its own pass.

**Fixed, all in `features/canvas/`:**
- **Groups were rendering with plain-card styling** (opaque background,
  solid border, box-shadow) instead of the dashed/transparent look —
  `canvas.css`'s `.canvas-group` rule targeted a class that was never
  actually applied to the DOM node (`CanvasNode.jsx` only ever added
  `canvas-node-group`). Root cause of "groups are completely broken."
- **Dots and the resize handle were clipped to half-circles/half-squares**
  at a card's edge — they were children of `.canvas-node`, which has
  `overflow: hidden` (needed to clip note/image content to the rounded
  corners). Restructured: `.canvas-node` is now a plain position/size
  wrapper (`overflow: visible`); the border/background/shadow/clipping
  moved to a new inner `.canvas-node-inner` div. Dots, the resize handle,
  and the group label are now siblings of `.canvas-node-inner`, not
  descendants, so none of them get clipped. **If you touch `CanvasNode`
  again: anything meant to visually hang outside the card (a badge, a
  handle) goes on the outer node, not inside `.canvas-node-inner`.**
- **Camera drag didn't move the background dot grid** — `.canvas-surface`'s
  `background-position`/`background-size` were static CSS. `CanvasView`
  now sets both inline every render from `viewport.x/y/zoom`, so the grid
  pans and scales exactly like a node would.
- **No feedback for "nearby" connection targets while dragging an arrow**
  — only the card exactly under the pointer got a highlight
  (`connectTargetId`, unchanged). Added `canvasNodesNear` (`canvasState.js`)
  — screen-radius-constant (divided by zoom) distance-to-rect check — and
  a `nearbyConnectIds` set in `CanvasView`, recomputed every pointer-move
  during a connect drag. Any card in that set gets `connectHighlight`,
  which reveals its 4 dots (same dot-rendering path as hover/selected)
  even before the pointer is exactly over it, so the user can see and
  drag onto a precise anchor point on a card that's merely close by.

**Mobile:** dot/resize-handle hit areas now grow via a `(pointer: coarse)`
media query (an invisible `::after` halo, `inset: -11px`) instead of the
old `max-width: 720px` rule — correctly targets touchscreens regardless of
viewport width (e.g. a touch laptop or tablet in landscape), and doesn't
change the visible dot size, only what you can land a tap on. This is a
real improvement but not the full "make mobile friendly" ask — panning,
pinch-zoom, and touch-vs-pan-mode selection already worked pre-existing;
what's **not** addressed here is the interaction between a single-finger
drag and *scrolling inside* a card's content (a long note embed, an
overflowing text card) — `canvas-surface` claims all touch gestures
(`touch-action: none`) so the app can own pan/select/drag itself, which
means a touch-drag starting inside a scrollable card body pans the canvas
rather than scrolling the card. Fixing that needs a deliberate per-region
touch-action policy (probably `pan-y` on scrollable inner content plus
JS-level gesture disambiguation), which is real interaction-design work,
not a one-line fix — worth its own pass.

**Deliberately not done in this pass (unchanged from section 8):**
- Site-wide popup → inline conversion, the graph-editor revamp, and
  timeline/calendar/chart database views: untouched, still each their own
  pass — see section 8 for scope notes on each. (Markdown-in-card editing
  for canvas text nodes, listed as deferred here originally, is now done
  — see section 12.)

---

## 12. Changelog — markdown editing inside db cells & canvas cards

Second of the 5 items from section 8. New shared component:
**`components/MiniMarkdownEditor.jsx`** (+ `.css`) — a small CodeMirror 6
instance for editing markdown in place inside something that isn't a note
pane. Deliberately not a variant of `CodeMirrorNoteEditor` (that one owns
a whole pane's undo-history-per-file lifecycle and active-pane focus
wiring this doesn't need); instead it directly reuses two pieces of the
real note editor unmodified:
- `buildInlinePreviewPlugin` (`features/editor/inlinePreviewPlugin.js`) —
  already a pure function of the document with no note-pane-specific
  context, so live coloring/formatting (headings, bold/italic/strike/
  highlight, callouts, wikilinks, tags, tables, ...) works identically.
- `wikilinkTagCompletionSource` — its `ctx` only needs 3 of the 5 getters
  the full editor gives it (`getLinkIndex`/`getAllTags`; the other 2,
  `getHandlers`/`getFoldState`, are unused by that source). **Intentional
  gap:** `getPhantomRecords` isn't wired up (returns `null`), so
  `[[wikilink]]` autocomplete here only suggests existing notes, not "new
  note" phantom suggestions — `phantomRecords` isn't threaded down to
  `DatabaseView`/`CanvasView` today and adding that plumbing wasn't worth
  it for an autocomplete nicety; revisit if that gap is actually felt.
- Commits only on blur/Escape, same as the `<textarea>`/`<input>` it
  replaces everywhere — never per keystroke, so editing a cell/card
  doesn't push a Drive save on every character (see section 3.1/4).
- Reuses every `.cm-*` decoration class from `CodeMirrorEditor.css`
  (`.cm-bold`, `.cm-heading-*`, `.cm-wikilink`, ...) unmodified — its own
  `MiniMarkdownEditor.css` only overrides the note-editor's page-sized
  padding/font to fit a small container, via the same class-specificity +
  import-order trick `CodeMirrorEditor.css` itself relies on. **If you
  reorder `styles/index.css`'s imports, keep this one after
  `canvas.css`** or its overrides stop winning.
- Not a manually-declared lazy chunk — it doesn't need to be. It's only
  ever imported from `CanvasNode.jsx` and `DbCells.jsx`, both already
  inside the lazy `CanvasView`/`DatabaseView` chunks (section 4), so Vite
  extracts it into its own small shared chunk automatically (verified:
  `dist/assets/MiniMarkdownEditor-*.js`, ~1.3KB, separate from both).

**Wired up:**
- `CanvasNode.jsx`: a text card's editing mode now renders
  `MiniMarkdownEditor` instead of a plain `<textarea>`, passing
  `handlers.allTags` and the pane's `linkIndex` straight through (both
  already props on `CanvasNode`, no new plumbing needed there).
- `DbCells.jsx`'s `DbTextCell`: the `multiline` case (`text_multiline`
  columns) now renders `MiniMarkdownEditor` in edit mode, and
  `renderMarkdownBlocks` (not raw text) in display mode, so a multiline
  cell reads as formatted markdown when you're not actively editing it,
  matching a note's reading/editing split. **`multiline={false}` (the
  single-line `text` column type, used for row titles and short
  properties) intentionally stays a plain `<input>`, unchanged** — one
  line of plain text has nothing markdown formatting would add, a full CM
  instance per cell would be wasted weight on every row of a table view,
  and row titles (`rowTitle()` in `DatabaseView.jsx`) are matched/rendered
  as plain strings elsewhere (wikilink row-targets, board/gallery card
  titles) — turning them into markdown would ripple well past this pass.
- `linkIndex` is now threaded `DatabaseView` → `DbTableView` → `DbCell`
  (it already reached `DbRowDetailModal`, just needed one more hop to
  `DbCell` there too). `allTags` needed no new plumbing — it was already
  riding along inside `handlers` (`handlers.allTags`, set in `App.jsx`)
  everywhere `DbCell`/`CanvasNode` are called.

**Not done / deliberately left:**
- Board and gallery database views don't render `text_multiline` cells at
  all today (`DbCardPropPreview` only handles select/multi_select/date) —
  nothing to change there, noted so a future pass doesn't assume a gap
  exists.
- `[[wikilink]]` autocomplete's phantom/"create new" suggestions (see the
  `getPhantomRecords` gap above).
- No toolbar/formatting buttons were added — same as the main note editor,
  formatting is typed markdown syntax, not a rich-text toolbar. Don't add
  one here without adding it to the real note editor first (section 3.4:
  one source of truth for how markdown gets authored in this app). (Markdown-in-card editing
  for canvas text nodes, listed as deferred here originally, is now done
  — see section 12.)

---

## 13. Changelog — DB crash fix, remembered sign-in, canvas panning/snap

Fixes and additions made in one pass (see `changes.patch`). Four larger,
explicitly-requested items were **scoped out of this pass** and are listed
at the end rather than half-done — see "Deferred" below.

**Fixed (real bugs, not just missing features):**
- Opening a `.base` database threw `Minified React error #310` ("Rendered
  more hooks than during the previous render") and crashed the pane.
  Cause: `DatabaseView`'s wikilink-row-target `useEffect` was declared
  *after* an `if (loading) return <div className="db-loading">…</div>`
  early return. While a file is loading, that return happens before the
  effect is ever reached, so the loading render calls fewer hooks than the
  loaded render that follows it — React requires the same hooks, in the
  same order, on every render of a component, no exceptions. Fixed by
  moving the effect above the early return (guarded internally by
  `if (loading) return`) and factoring the row-title calculation both it
  and the render body need into a shared `rowTitleFallback()` helper
  (section 3.4 — one calculation, not two copies that could drift).
  **If you add another hook to `DatabaseView`, it must go above the
  `if (loading)` return, full stop** — this is the one file in the app
  where that early return makes the usual "just add a hook" instinct
  unsafe.
- Google sign-in previously had to happen every time the app was opened:
  `useAuth.js` kept the Drive access token in `sessionStorage`, which the
  browser clears whenever the tab/app closes, and tracked no expiry.
  `useGoogleAuth` now stores `{ token, expiresAt }` in `localStorage` (a
  token past its `expiresAt` is treated as absent, same as before) and, on
  load, if there's no live stored token, fires one silent
  `requestAccessToken({ prompt: 'none' })` before ever showing a "Sign in"
  button. Google grants this without any UI as long as the browser still
  has an active Google session and the person previously consented — same
  remembered feel as the vault folder choice, just re-validated once per
  load instead of persisted forever (an access token itself can't be kept
  forever; only the underlying consent can be silently re-used).

**Changed (canvas UX, both explicitly requested):**
- Panning the canvas no longer requires the middle mouse button, which has
  no real equivalent on a trackpad. Plain click-and-drag on the empty
  canvas background now pans by default; box/marquee-select moved to
  Shift+drag on the background instead. Middle-click and space+drag still
  pan too (unchanged, for anyone's existing muscle memory), and two-finger
  trackpad scroll already panned via the existing wheel handler.
- Grid snap is a **new, opt-in** feature, not a fix to existing forced
  snapping — there was no snap-to-grid code anywhere in `CanvasView.jsx`
  before this pass; positions were always raw floats. Added
  `CANVAS_GRID_SIZE`/`canvasSnap()` in `canvasState.js` and a toolbar
  toggle (`CanvasToolbar`'s new grid icon button, `.icon-btn.active` style
  added to `sidebar.css` since that's where the shared `.icon-btn` base
  rule lives) wired to `CanvasView`'s `snapEnabled` state, **default
  off**. Snapping is applied once on drop (inside `commit`), not on every
  live-drag frame, so dragging still feels smooth and only the final
  position/size jumps to the grid — matches how Obsidian's own canvas snap
  feels rather than snapping the live ghost position every frame.
- `HelpModal.jsx`'s Canvas entry updated to describe both changes (section
  6 — keep this in sync going forward same as always).

**Deferred (explicitly requested, each is its own follow-up pass, not
bundled into this bugfix-sized patch):**
1. ~~**Site-wide popup removal → inline menus.**~~ — started, not
   finished; see section 15 for what's done (the database view-tabs case)
   and what's still open (`DropdownMenu.jsx`'s four usages, every
   full-page modal).
2. **Graph editor revamp, Obsidian-style.** Current `features/graph/`
   (`useForceGraph.js` + `GraphViewModal.jsx`) is a single modal with a
   basic force simulation. Matching Obsidian's graph view means: local vs.
   global graph modes, per-node/edge styling by tag/folder, an in-graph
   search/filter bar, adjustable force-simulation parameters (link
   distance/strength, repulsion, gravity/center-force) exposed as UI
   controls, and (per the user's suggestion) treating it as its own
   "file"/pane kind rather than a modal — likely means extending the
   `file.kind` switch in `EditorContent.jsx` (section 3.6) with a virtual
   `graph` kind that opens in a normal tab instead of `GraphViewModal`,
   which also touches `PaneNode.jsx`/tab-bar plumbing. Sizeable — treat as
   its own multi-file pass with real research into Obsidian's actual graph
   settings panel before writing code.
3. **Timeline / calendar / chart views for `.base` databases.** Today
   `DbViews.jsx` has table/board/gallery. Notion-style timeline, calendar,
   and chart (bar/line/pie) views are each a new view type: new entries in
   `DB_VIEW_TYPE_ICONS`/the add-view menu (`DatabaseView.jsx`), a new
   renderer per type in `DbViews.jsx` (or split into sibling files per
   section 3.7 once that file grows), and — for chart specifically — a new
   aggregation step (group/sum/count by column) that doesn't exist in
   `dbState.js` yet. Timeline/calendar also need a date-column requirement
   check similar to board's select-column requirement. Real feature work,
   not a bugfix.
4. ~~**App versioning + auto-update.**~~ — done, see section 14.

Pick which of these four to tackle next; each deserves its own reviewed
pass rather than being rushed alongside the others.

---

## 14. Changelog — app versioning + auto-update (item 4 of section 13)

One of the four items deferred in section 13, done as its own pass (see
`changes.patch`). Items 1–3 from that list (site-wide popup→inline
conversion, the Obsidian-style graph revamp, and database
timeline/calendar/chart views) are **still not done** — each remains its
own real pass, not bundled in here. Same for `useForceGraph`/
`GraphViewModal.jsx`: unchanged by this patch.

**Added:**
- **Build-time version stamp** (`vite.config.js`): `package.json`'s
  `version` plus a short git SHA (`1.0.0+78bb833`), exposed as the
  `__APP_VERSION__` global via Vite's `define`. Falls back to just the bare
  version if `git rev-parse` fails (e.g. building from a source tarball
  with no `.git`) — never fails the build over a missing SHA.
- **`hooks/useAppUpdate.js`**: wraps `vite-plugin-pwa`'s
  `virtual:pwa-register/react` (`useRegisterSW`). `registerType: 'autoUpdate'`
  already downloaded a new service worker silently in the background; this
  hook is what surfaces the moment it's ready (`needRefresh`) instead of
  leaving it invisible until some future full reload. No polling timer was
  added — the browser already re-checks the SW file on normal page loads,
  which is enough for an app that's occasionally reopened, and a background
  poll would cut against the NetworkOnly-for-Drive spirit of section 3.1/4
  for no real benefit.
- **`StatusBar`**: shows `v{version}` in the bottom-right on the far right,
  next to the existing sync dot. When an update is ready, that spot
  becomes an inline "Update available" text button (not a modal/popup —
  consistent with the direction item 1 in section 13 wants everything else
  to move) that calls `updateServiceWorker(true)`, reloading the tab once
  the new worker takes control. Nothing reloads automatically mid-session;
  the user decides when.
- `HelpModal.jsx` documents the status-bar version/update control (section
  6).

**Deliberately not done:**
- No "what's new" changelog surfaced in-app — the version string plus this
  file's changelog sections are considered enough for now; add a
  release-notes popover later only if that's actually requested (and if it
  is, make it inline per item 1, not a new modal).
- No forced/timed update — some PWAs auto-reload a few seconds after
  `needRefresh` fires. Deliberately left as a manual click: this app holds
  in-memory-only state per section 3.1 (open buffers, unsaved edits before
  the Drive save round-trip), so a surprise reload could discard something
  the user hasn't finished typing. Don't add auto-reload without also
  solving that data-loss window.

---

## 15. Changelog — popup→inline pass 1: database view-settings/add-view

First slice of item 1 in section 13 (site-wide popup → inline conversion).
As that section itself warned, this needs a design pass per popup type, not
a mechanical find-replace — so this pass covers exactly one clear case
(the one section 13 named as a good first target) and leaves the rest
explicitly scoped below, not half-done.

**Converted:** `DatabaseView.jsx`'s two view-tab popovers — `DbViewTab`'s
settings menu (rename / group-by / cover / delete view) and
`DbAddViewButton`'s "new view" form. Both used to be a `DbPopover` in its
default portal+fixed mode, anchored under one tab inside `.db-view-tabs`.
That container scrolls horizontally (`overflow-x: auto`, which per the CSS
spec also computes its vertical overflow to `auto`) — the exact clipping
hazard `DropdownMenu.jsx`'s header comment already documents for the tab
bar, so a panel anchored *under a specific tab* would get cut off as that
tab scrolled toward the row's edge. Rather than keep the portal (a real
popup, floating outside the tab row's own box) or ship a panel that
silently clips, both now open **one shared inline panel** (`DbViewPanel`,
new in `DatabaseView.jsx`) rendered once, directly below the whole
`.db-view-tabs` row — genuinely in document flow, pushes the view body
down while open, never clipped, and only one can be open at a time
(`DatabaseView`'s new `viewPanel` state: `{ mode: 'settings', viewId } |
{ mode: 'add' } | null`). `DbViewTab` and `DbAddViewButton` are now plain
buttons that toggle that shared state — no `DbPopover` import left in this
file. CSS: new `.db-view-panel-inline`/`.db-view-panel-row` rules in
`database.css`; the now-unused `.db-add-view-popover`/
`.db-view-settings-popover` selectors were removed from the shared rule
they shared with `.db-select-popover` (which is still a real popover
elsewhere in this file's family — untouched).

**Not converted in this pass (each is a separate, real design decision,
same reasoning CLAUDE.md already gave for why this can't be one
mechanical change):**
- **`DbPopover`'s other portal usages** (`DbCells.jsx`'s attachment-picker
  popover, and the two select/multi-select cell popovers when `dense` is
  true) — these open from inside a table cell, i.e. from *inside*
  `.db-table-scroll` (`overflow: auto`) at arbitrary scroll positions, not
  from a single fixed toolbar row. An inline panel there needs actual
  layout thought (expand the row's height? a fixed side panel keyed to the
  open cell?) rather than reusing the "one panel below a static row"
  pattern that worked for the view tabs.
- **`DropdownMenu.jsx` and its four usages** (`ExplorerPanel`'s new-file
  and per-file context menus, `TabBar`'s tab context menu,
  `SearchPanel`'s options menu). `TabBar`'s own tab strip has the identical
  scrolling-ancestor problem `.db-view-tabs` did, so the same "one shared
  panel below the row" fix likely applies there too — but `ExplorerPanel`'s
  per-file context menu opens from an arbitrary row in a vertically
  scrolling file tree, which doesn't have one fixed place to put an inline
  panel without either pushing the whole tree down oddly or covering
  neighboring rows. Needs its own per-case pass, not folded into this one.
- **The full-page modals** (`PaletteModal`, `GraphViewModal`,
  `DbRowDetailModal`, `DbManageColumnsModal`, `OnboardingFlow`,
  `CanvasFilePickerModal`, the image viewer) — unchanged, still
  `modal.css`'s overlay pattern. CLAUDE.md already called these out as
  needing a different treatment (a slide-over panel, not an inline
  expand section) since they're closer to full pages than to a small menu;
  that's real interaction-design work for its own pass, and `GraphViewModal`
  specifically is already slated to be replaced outright by the graph
  revamp (item 2), so converting its current modal shell first would be
  wasted work.

---

## 16. Changelog — popup→inline pass 2: tab context menu

Second slice of item 1 (section 13/15). Converts the one usage section 15
explicitly predicted would need the same fix: **`TabBar.jsx`'s per-tab
"..." menu**. It was a `DropdownMenu` (portaled, fixed-positioned under the
tab's `IconMoreVertical` trigger). `.tab-bar-scroll` scrolls horizontally
(`overflow-x: auto`) exactly like `.db-view-tabs` did, so a menu anchored
under one tab clipped as that tab scrolled toward the row's edge — same
hazard, same fix: one shared inline panel (`.tab-menu-panel-inline`)
rendered below the whole `.tab-bar` row, outside `.tab-bar-scroll`, never
portaled. `TabBar` now owns `menuTabId` (which tab's menu is open, or
`null`) instead of each tab having its own `DropdownMenu` instance;
`useClickOutside` on a wrapper ref around both the tab row and the panel
closes it. `TabBar.jsx` no longer imports `DropdownMenu` — 3 of its 4
usages remain (`ExplorerPanel` x2, `SearchPanel`), each still deferred for
the reasons already given in section 15.

**Not done in this pass (unchanged from section 15's remaining list):**
`ExplorerPanel`'s two context menus, `SearchPanel`'s options menu, the
`DbPopover` cell-level popovers, and every full-page modal. Also
untouched: the graph-editor revamp and database timeline/calendar/chart
views (items 2 and 3 below) — each still its own pass.

---

## 17. Changelog — popup→inline pass 3: search options, explorer add-menu, tree row menus

Third slice of item 1. Converts every remaining `DropdownMenu` usage, which
means **the `DropdownMenu` component itself has now been deleted** —
`components/DropdownMenu.jsx` is gone. Section 3.5's advice to "extend
`DropdownMenu`/`MenuItem` rather than hand-rolling a new floating menu" no
longer applies to a portal component that doesn't exist; for a new
"floating" menu going forward, follow one of the two inline patterns below
instead (or `DbPopover` in `DbCells.jsx`, if you genuinely need a portal —
see section 18's `DbPopover` note for when that's still justified).
`components/DropdownMenu.css` **stays** (same import position in
`styles/index.css`, cascade order undisturbed) but now only holds the
still-shared `.menu-item`/`.menu-item.danger`/`.search-options-*` rules
that the new inline panels below and `SearchPanel` still use — the
`.dropdown-wrap`/`.dropdown-menu`/`.menu-divider` rules that only the
deleted component used were removed with it.

**Converted:**
- **`SearchPanel.jsx`**'s search-options button (`IconSliders`) now toggles
  a local `showOptions` boolean and renders `.search-options-menu-inline`
  directly below `.search-bar` — genuinely in flow, `useClickOutside` on a
  wrapper around both. Same `SEARCH_HELP` content as before, unchanged.
- **`ExplorerPanel.jsx`**'s header "+" add menu: split into `AddMenuButton`
  (just the trigger, state now owned by `ExplorerPanel`) and `AddMenuPanel`
  (the actual options), with the panel rendered as a full-width block
  **below the whole `.side-panel-header` row** — not tucked under the
  button — matching the `DbViewPanel`/`TabBar`-menu-panel convention of
  pushing content down rather than floating over it. `useClickOutside`
  wraps the header + panel together.
- **`ExplorerPanel.jsx`**'s per-row "..." menu (`TreeItemMenu` before this
  pass): each `TreeNode` now owns its own local `menuOpen` boolean and
  renders `TreeItemMenuPanel` as a plain sibling **immediately below that
  row**, not a shared/global panel. This was a deliberate departure from
  the "one shared panel" pattern used everywhere else in this changelog:
  a file tree can have hundreds of rows at arbitrary scroll offsets, so
  there's no single fixed place to anchor one shared panel without either
  floating (a popup again) or fighting the tree's scroll position. A
  purely local per-row toggle sidesteps both — it's a harmless variation
  on the same "folders show children below them" flow the tree already
  has. **One caveat if you touch `TreeNode` again:** the panel is rendered
  as a sibling *outside* `.tree-row`, never a child of it — `.tree-row` has
  `content-visibility: auto` + `contain-intrinsic-size: 0 28px` for
  large-vault scroll performance (section 4), and stuffing a
  variable-height panel inside that row would fight the browser's cached
  intrinsic size for off-screen rows. Keep it a sibling.

**Result:** all 4 `DropdownMenu` usages named across sections 13/15/16 are
now converted; item 1 from section 13's original deferred list is
**functionally complete for the "small floating menu" category**. What's
still open, unchanged from section 16: `DbCells.jsx`'s `DbPopover`-based
cell popovers (attachment picker, dense select/multi-select — a different,
harder layout problem, arbitrary scroll position inside `.db-table-scroll`)
and every full-page modal (`PaletteModal`, `GraphViewModal`,
`DbRowDetailModal`, `DbManageColumnsModal`, `OnboardingFlow`,
`CanvasFilePickerModal`, the image viewer) — the latter group was always
scoped as its own kind of redesign (slide-over panel, not an inline
expand), not a mechanical popup-to-inline swap, and `GraphViewModal`
specifically is slated for outright replacement by item 2 below rather
than converted in place.

---

## 18. Scoping notes — graph revamp & database chart/timeline/calendar views

Not implemented yet; recorded here so the next pass starts from a plan
instead of a blank slate. Both are sizeable (multi-file, new interaction
design) and were intentionally not rushed alongside the popup→inline slice
above.

**Item 2 — Obsidian-style graph revamp** (`features/graph/`). Obsidian's
actual graph view (both "local" and full "Graph view") is built from:
a force simulation with user-adjustable link distance/strength, central
"repel" force, and gravity toward center; a **Groups** panel that colors
nodes matching a search query; **Filters** for tags/attachments/orphans and
a "existing files only" toggle; per-node sizing by link count; and — the
part the user specifically asked about — hover-highlight of a node's
immediate neighbors while dimming the rest. Concretely, this pass should:
1. Replace `GraphViewModal.jsx`'s modal shell with a real pane/tab: extend
   `EditorContent.jsx`'s `file.kind` switch (section 3.6) with a virtual
   `'graph'` kind, and give `App.jsx`/`PaneNode.jsx` a way to open a graph
   tab that isn't backed by a Drive file id (a synthetic `{ kind: 'graph' }`
   pseudo-file, matching how `TabBar`/`Breadcrumb` already branch on
   `opensInEditorPane`).
2. Rework `useForceGraph.js` to expose tunable force params (not hardcoded
   constants) and a `localNodeId` mode that BFS-limits the rendered set to
   N hops from one note, mirroring Obsidian's local-graph-per-note view.
3. New `GraphControls` panel (inline sidebar within the graph pane, not a
   popup — consistent with item 1's direction): filters, groups
   (tag/folder → color), and force sliders.
4. Node styling by tag/folder color and radius-by-degree; edge styling
   stays simple (Obsidian's are unstyled lines).
Keep `useForceGraph.js`'s simulation itself framework-agnostic (pure
function of nodes/edges/params → positions) so the pane and any future
embed (e.g. a note's local-graph inline block) can share it.

**Item 3 — Timeline / calendar / chart views for `.base` databases**
(`features/database/`, alongside existing table/board/gallery). Notion's
versions:
- **Calendar**: requires a date column (same "pick a required column"
  pattern board already has for its select group-by column, see
  `DB_VIEW_TYPE_ICONS`/`DbViewPanel`'s settings panel); renders a month
  grid, each row's card placed on the day its date column falls on.
- **Timeline**: a horizontal Gantt-style lane per row between a start and
  end date column (two date-column requirement, not one) — this is the one
  genuinely new layout primitive, nothing existing in `DbViews.jsx` is
  close to it.
- **Chart (bar/line/pie)**: needs a real aggregation step that doesn't
  exist in `dbState.js` yet — group rows by one column, then
  count/sum/average another numeric column. This should land as a new
  pure function there (section 3.4: one source of truth), not computed
  inline inside a chart component, so a future "chart block in a note"
  feature could reuse it.
Each of the three is a new entry in `DB_VIEW_TYPE_ICONS` and the add-view
panel (now inline, section 15/16 — don't regress that to a popup), plus its
own renderer file under `features/database/` once `DbViews.jsx` would
otherwise cross the section 3.7 line. Do these one view type at a time,
not all three in one pass — they don't share much beyond the date-column-
requirement UI, and chart specifically depends on the new `dbState.js`
aggregation helper landing first.

---

## 19. Changelog — mobile canvas drag-cancel fix, and scoping for the remaining 2026 request batch

A user request landed asking for six things in one go: (1) finish the
popup→inline conversion, (2) the graph revamp, (3) database
timeline/calendar/chart views, (4) offline support, (5) the mobile canvas
drag bug below, (6) a customizable frontmatter-autocomplete system. Per the
request itself, these don't all land in one pass. This entry fixes #5 (a
real, well-scoped bug) and records where the other five stand so the next
session doesn't start blank.

**Fixed — mobile canvas drag stopping after a split second
(`features/canvas/CanvasView.jsx`, `canvas.css`).** Root cause: `beginMove`/
`beginResize`/`beginConnect` called `e.stopPropagation()` but never
`e.preventDefault()`, and `touch-action: none` was only set on the
`.canvas-surface` ancestor, not on `.canvas-node`/`.canvas-dot`/
`.canvas-resize-handle` themselves. On several mobile WebKit/Blink builds,
an ancestor's `touch-action` isn't reliably honored for a nested pointerdown
target, so the OS's own scroll/long-press gesture recognizer stayed armed
alongside ours: our `pointermove` handler moved the node for the first few
pixels, then the native gesture won, fired `pointercancel`, and
`onContainerPointerUp` cleared `dragRef` — the exact "follows the finger for
a split second, then stops" symptom. Fix is two-part, both needed: (a)
`e.preventDefault()` for non-mouse pointers in all three begin* handlers,
guarded with `e.pointerType !== 'mouse'` so it never touches desktop
click/dblclick behavior; (b) explicit `touch-action: none` (+
`-webkit-touch-callout: none`, blocking iOS's long-press callout from
racing the drag too) directly on the node/dot/handle elements rather than
relying on inheritance from `.canvas-surface`. One carve-out:
`.canvas-node:has(.canvas-text-editor)` resets both back to normal so
selecting/scrolling inside `MiniMarkdownEditor` while a text card is being
edited still works — the lockdown is only needed while the card is an idle
drag surface. See `changes.patch`.

**Scoping for the other five (unstarted, next-session notes):**

- **Popup→inline, remainder.** Section 18 already tracked this as open
  before item 1 was even the popup item's original number — re-confirming
  here: `DbCells.jsx`'s `DbPopover` cell popovers and every full-page modal
  (`PaletteModal`, `GraphViewModal`, `DbRowDetailModal`,
  `DbManageColumnsModal`, `OnboardingFlow`, `CanvasFilePickerModal`, image
  viewer) are still real popups. Modals need a slide-over-panel redesign,
  not a mechanical swap (sections 15/17 already explain why); do that as
  its own pass, one modal type at a time. `GraphViewModal` should be done
  *as part of* item 2 below (it's being replaced, not converted).
- **Graph revamp and DB timeline/calendar/chart** — plan already written in
  section 18 above; unchanged, still not started.
- **Offline support — needs a decision before any code, not just a pass.**
  The request (make files/folders available offline, à la Google Docs) is
  in direct tension with section 3.1's non-negotiable "zero local note
  storage" invariant and the `NetworkOnly` service-worker rule that
  enforces it — genuine offline editing means *something* durable holds
  note bytes on-device across reloads, which today's IndexedDB usage
  (metadata/link-graph cache only) and RAM-only search index deliberately
  don't do. Before implementing: decide (a) whether 3.1 gets a scoped,
  explicit exception for user-opted-in offline files only (content stored
  in IndexedDB, clearly marked as a deliberate exception in 3.1 itself, not
  quietly worked around), (b) the conflict-resolution story for a file
  edited offline and also changed on Drive before reconnecting, and (c)
  per-folder propagation (marking a folder offline must track membership
  changes — files added/moved/deleted inside it — which means it's a live
  rule evaluated against the vault tree, not a one-time flag copied onto
  children). Don't start on the mechanism until those three are answered;
  this is the one item in the batch that changes an architectural
  invariant rather than adding a feature within it.
- **Customizable frontmatter autocomplete.** Maps to existing files:
  `PropertiesPanel.jsx` (where the property editor already lives),
  `features/editor/wikilinkCompletion.js` (existing CM6 autocomplete
  source — a frontmatter-value completion source is the same pattern, not
  a new mechanism), and a new `lib/frontmatterSchema.js` (section 3.4:
  one source of truth) holding: base property definitions, per-property
  value autocomplete lists (editable in a new Settings section), and the
  value→child-properties map (e.g. `type: game` auto-adding the `game`
  template's fields) that `GUIDE.md`'s note types describe. Schema itself
  should be user-data (stored as a note or app-settings file the same way
  other user config is, not hardcoded to `GUIDE.md`'s specific types) so
  it's genuinely customizable rather than a hardcoded reimplementation of
  today's five note types.

---

## 20. Changelog — database calendar view (item 3, first slice)

Smallest well-scoped piece of the item-3 database-views batch from section
18: **Calendar**, done first because (unlike Timeline's two-date-column
Gantt-lane math, or Chart's not-yet-built `dbState.js` aggregation step) it
needed no new data-model primitive — just the same "pick a required column"
pattern Board already established for its group-by Select column.

**Added:**
- `features/database/DbCalendarView.jsx` (new file, per section 3.7 — adding
  this to `DbViews.jsx` would have pushed it past ~450 lines): a month grid
  (42 cells, always 6 full weeks so the grid never reflows height between
  months), rows placed on the day their date column's value falls on.
  Requires a `date`-typed column (`view.dateColumnId`); `DbDateColumnPicker`
  inside the same file mirrors `DbBoardView`'s `DbGroupByPicker` prompt when
  none is picked yet. Clicking a row chip opens its row-detail modal like
  every other view; each day cell has a hover `+` (always visible on touch
  — see the mobile CSS block) that creates a new row preset with that day's
  date, mirroring Board's "add card in this column" pattern. Reuses
  `DbCardPropPreview` from `DbViews.jsx` for one select/multi-select
  preview chip per row card, same as Board/Gallery cards.
- `DatabaseView.jsx`: `calendar` added to `DB_VIEW_TYPE_ICONS` and the
  add-view type list; `DbViewPanel`'s settings mode grew a "Date property"
  section (same shape as Gallery's "Cover" section) that only shows for
  `view.type === 'calendar'`; `addView('calendar', ...)` defaults
  `dateColumnId` to the vault's first `date` column the same way `board`/
  `gallery` default their required column; `deleteColumn` now also clears
  `dateColumnId` off any view when its date column is deleted (joining the
  existing `groupByColumnId`/`coverColumnId`/`sortColumnId` resets there).
- `database.css`: new `.db-cal-*` rules following the existing token/
  spacing conventions from the Board section right above them; a small
  mobile override shrinks row height and makes the per-day `+` always
  visible instead of hover-only (there's no hover on touch).
- `HelpModal.jsx`'s Databases entry now mentions Calendar and its Date-
  property requirement (section 6).

**Not done (deliberately, same reasoning section 18 already gave):**
Timeline (needs the two-date-column Gantt-lane layout, a genuinely new
primitive) and Chart (needs the `dbState.js` group-by/aggregate helper to
land first, so a future chart-block-in-a-note feature can reuse it) are
still open, one view type at a time as section 18 specified. Everything
else from the six-item request in section 19 — popup/modal remainder,
graph revamp, offline support — is unchanged from that entry.

---

## 21. Changelog — customizable frontmatter autocomplete (item 6)

The last easily-scoped item from section 19's six-item batch (offline
support remains blocked on the architecture decision described there;
popup/modal remainder and the graph revamp are unchanged, still their own
passes).

**Added, matching the plan section 19 already wrote:**
- **`lib/frontmatterSchema.js`** (new): the customizable model — a list of
  property definitions, each with an optional `valueOptions` list and an
  optional `childrenByValue` map (value -> properties that value implies,
  e.g. `type: game` -> `aliases`). Ships with `DEFAULT_SCHEMA` mirroring
  every type in GUIDE.md (info/entity/event/game/concept/reference)
  out of the box, including `category: mechanic` -> `mechanic` per that
  guide's "Mechanic is only used if the category is mechanic" rule.
  Persisted to `localStorage` (`vault_frontmatter_schema`), same mechanism
  and same load/save shape as `useAccentColor` — this is user
  configuration, not note content, so it doesn't touch section 3.1's
  Drive-content rule at all. Also exports `frontmatterRangeAt`/`usedKeys`,
  which locate and parse the leading `---` block by reusing
  `markdownParse.js`'s existing frontmatter regex (3.4 — one source of
  truth), and `serialize/parseChildrenByValue`, the compact
  `value: key=default, key2=default2` text format the Settings panel edits
  directly instead of raw JSON.
- **`features/editor/frontmatterCompletion.js`** (new): a CM6
  `CompletionSource`, same ctx-getter shape as `wikilinkCompletion.js`'s
  `wikilinkTagCompletionSource` so it drops into the same
  `autocompletion({ override: [...] })` list (`CodeMirrorNoteEditor.jsx`).
  Only ever active with the cursor inside the leading `---...---` block.
  On a bare line, suggests schema property keys not already present in
  that block; after `key: `, suggests that key's `valueOptions`; picking a
  value that has `childrenByValue` entries also inserts the implied
  child-property lines right below, skipping any already present — this
  is the actual "select `game`, get `aliases` for free" behavior
  GUIDE.md's workflow needs.
- **`features/settings/FrontmatterSchemaSettings.jsx` + `.css`** (new): a
  modal (still `modal.css`'s overlay pattern, like `HelpModal` — a new
  settings surface isn't the popup→inline item from section 8/13, so it
  wasn't worth inventing a bespoke inline layout for a first version; fold
  it into a future modal-redesign pass alongside the others listed in
  section 19 if that's ever done). Lists every schema property as an
  editable row (key, comma-separated value options, and the
  `value: key=default` textarea for child properties), plus "Add property"
  and "Reset to default". Lazy-loaded from `App.jsx` the same way
  `HelpModal`/`PaletteModal`/`GraphViewModal` already are (section 4);
  verified via a real build that it lands in its own ~2.5KB chunk, not the
  main bundle.
- **`hooks/useFrontmatterSchema.js`** (new): thin `useState` + persist
  wrapper, same shape as `useAccentColor`. Threaded into the existing
  `handlers` object in `App.jsx` (`handlers.frontmatterSchema`) rather than
  as a new prop down every layer — same pattern `handlers.allTags` already
  uses to reach `CodeMirrorNoteEditor` through `EditorContent.jsx`.
- New "Frontmatter properties" icon button (`IconSliders`) in the sidebar
  footer, next to the existing Accent color / Help / Change folder buttons.
- `HelpModal.jsx`'s Features tab documents the new autocomplete behavior
  and where to customize it (section 6).

**Deliberately not done:**
- No UI for reordering properties or for a richer child-property editor
  than the compact text format — matches how much surface area GUIDE.md's
  actual workflow needs; a drag-to-reorder list or per-child structured
  form would be a real usability upgrade but wasn't asked for and adds
  meaningfully more component code for a first version.
- Autocomplete only fires on a value already being typed after `key: `
  (or on a bare key) — it doesn't yet handle list-style properties like
  `after:` with an indented `- "[[...]]"` block underneath (section 9's
  existing wikilink autocomplete already covers `[[` inside such a list
  item once the cursor is there; this pass didn't add schema-driven
  suggestions for the list *items* themselves, only for scalar
  `key: value` lines). Worth a follow-up if that gap is felt in practice.
- `MiniMarkdownEditor` (db cells / canvas cards, section 12) doesn't get
  this completion source — neither surface has a frontmatter block to
  autocomplete, so there's nothing to wire up there.

Remaining from the original six-item request (section 19): popup/modal
remainder, the graph revamp, and offline support (still blocked on the
architecture decision that section spells out) — each its own pass.

---

## 22. Changelog — popup→inline pass 4: row-detail modal becomes a slide-over panel

Continues item 1 (sections 13/15/16/17). Converts the first of the
full-page modals sections 15/17 deliberately left alone, pending "a
slide-over panel redesign, not an inline expand section": **`DbRowDetailModal`**
(`DbModals.jsx`, `database.css`). This was the best first candidate — a
Notion-style "open page" already conceptually wants to feel like navigating
to a side view of the row, not a centered dialog floating over the table.

**Converted:** `.db-row-modal-overlay` still dims the page and closes on an
outside click (it's still an overlay in that sense — a slide-over is not
the same ask as the small-menu inline conversions in passes 1-3, and
CLAUDE.md never claimed it would stop dimming the background), but now
docks its content flush to the right edge (`justify-content: flex-end`,
`align-items: stretch`) instead of centering a box with page padding.
`.db-row-modal` itself is now full viewport height, `border-left` instead
of a full border + border-radius, and slides in from the edge with a short
transform/opacity keyframe (skipped under `prefers-reduced-motion`). No
`DbModals.jsx` component logic changed — same props, same `DbCell`
rendering per column, same delete button and preview section; this pass is
the shell/CSS only. Mobile override (`max-width: 100%` at the existing
breakpoint) now reads as "full-screen slide-over on small viewports",
which is the correct mobile treatment for this pattern and didn't need to
change.

**Not converted in this pass (deliberately, same one-modal-type-at-a-time
approach as passes 1-3):**
- **`DbManageColumnsModal`, `PaletteModal`, `OnboardingFlow`,
  `CanvasFilePickerModal`, the image viewer** — still `modal.css`'s
  centered-overlay pattern. None of these are "open this record and look at
  it beside your other work" the way the row-detail panel is; a command
  palette or a first-run wizard don't obviously want a side-panel
  treatment, so each needs its own judgment call rather than the row-detail
  panel's reasoning applied by default. Next candidate worth a look:
  `DbManageColumnsModal` is the most row-detail-like of the remainder (a
  settings-ish list, not a one-shot flow), if this thread continues.
  `FrontmatterSchemaSettings.jsx` (section 21) is also still this same
  centered-modal shape for the same reason it was fine to ship that way
  initially — see that entry.
- **`GraphViewModal`** — unchanged, still slated for outright replacement
  by the graph revamp (item 2) rather than a shell conversion.
- **`DbCells.jsx`'s `DbPopover` in dense/table-cell mode** (attachment
  picker, dense select/multi-select) — looked at this pass and decided
  *not* to force it inline. `.db-table-scroll` clips both axes
  (`overflow: auto`), so an absolutely-positioned inline panel anchored to
  a cell gets cut off near the table's edges — the exact hazard sections
  15/17 already flagged. The only way to avoid that clipping is
  `position: fixed`, which is a floating popup by definition regardless of
  whether it's portaled to `document.body` or rendered as a plain sibling
  — dropping the `createPortal` call there would be a cosmetic change, not
  an actual popup removal, so it wasn't made. This is also the standard
  treatment in Notion/Airtable/Coda's own dense grid views for exactly this
  reason: a floating picker is the only usable pattern once a property
  editor has to open from inside a tightly packed, independently-scrolling
  cell grid. Left as a real, intentional exception rather than pretend-fixed
  — revisit only if a genuinely different layout (e.g. always expanding the
  full row height when any of its cells is being edited) is wanted later,
  which is a bigger interaction change than this pass's scope.

---

## 23. Changelog — popup→inline pass 5: manage-columns modal becomes a slide-over panel

Continues item 1. Converts the modal section 22 named as the next
candidate: **`DbManageColumnsModal`** (`DbModals.jsx`, `database.css`).
Same reasoning as section 22 — this is a live properties list you tweak
while looking at the table, not a one-shot flow, so the row-detail panel's
slide-over treatment fits it too.

**Converted:** `.db-manage-overlay`/`.db-manage-modal` now use the identical
right-docked, full-height, slide-in shell as `.db-row-modal-overlay`/
`.db-row-modal` from section 22 (same `db-row-modal-slide-in` keyframe,
reused rather than duplicated). `.db-manage-modal` is now a flex column so
the property list (`.db-manage-list`, now `flex: 1` instead of a fixed
`max-height: 360px`) scrolls independently while the header and the
"add property" row at the bottom both stay pinned (`flex-shrink: 0`) —
this is a genuine improvement over the old fixed-height list, which is a
side effect of switching to a full-height panel, not something that needed
separate work. No `DbModals.jsx` logic changed.

**Still open (unchanged from section 22's list):** `PaletteModal`,
`OnboardingFlow`, `CanvasFilePickerModal`, the image viewer, and
`FrontmatterSchemaSettings.jsx` remain centered modals — none of them
share the "live list beside your other work" shape that made the row-detail
and manage-columns panels good fits, so converting them needs its own
per-case judgment, not this same shell reused by default. `GraphViewModal`
is still slated for outright replacement by the graph revamp rather than a
shell conversion. `DbCells.jsx`'s dense/table-cell popovers remain the
documented, intentional exception from section 22 — that reasoning is
unchanged.

---

## 24. Changelog — popup→inline pass 6: canvas file picker, and closing out item 1

**Converted:** `CanvasFilePickerModal` — was a centered `modal-overlay`;
`.canvas-toolbar` is an in-flow, non-scrolling top row (`flex-shrink: 0`
inside `.canvas-view`'s flex column, not absolutely positioned), so this is
the exact "one shared panel below a static row" shape as `DbViewPanel`/the
tab-bar menu. It's now rendered by `CanvasView.jsx` as a plain sibling
directly below `CanvasToolbar`, a fixed-width block (`align-self:
flex-start`, un-stretched) with `useClickOutside` instead of an overlay
`onClick`. No search/pick logic changed.

**Item 1 (popup→inline, six-pass total across sections 13/15/16/17/22/23/24)
is now closed, with three deliberate, documented exceptions:**
- **`PaletteModal`** (Cmd+K-style fuzzy switcher/command palette) and
  **`HelpModal`** (reference lookup) stay centered modals. Both are
  "summon from anywhere, look something up or jump somewhere, dismiss"
  interactions with no natural anchor point — a command palette floating
  center-screen is the standard, expected shape for this exact pattern
  (VS Code, Slack, Notion, Linear all do the same), not a popup standing in
  for something that should've been inline.
- **`ProxyFolderBrowser`'s `variant="modal"`** (`App.jsx`'s "Change store
  folder" action, proxy-auth mode) — a rare, deliberate one-off action
  triggered from the sidebar footer, not a live list beside ongoing work.
  Its `variant="inline"` usage (`OnboardingFlow.jsx`) was already inline
  before this changelog even started (see that file's own header comment).
- **`FrontmatterSchemaSettings`** (section 21) — same reasoning as
  `PaletteModal`/`HelpModal`: a settings lookup, summoned and dismissed,
  not something worth a bespoke inline layout for a first version.
- **The "image viewer" named in sections 15/17's original deferred list**
  doesn't currently exist as a separate component in this codebase — no
  `modal-overlay` usage, lightbox, or dedicated asset-preview surface was
  found; `onOpenAsset` just opens the file in an editor pane. Either it
  predates the App.jsx restructure (section 1) and was already removed, or
  the original scoping note was aspirational. Nothing to convert; noting
  this so a future session doesn't go looking for it again.

Also unchanged: `DbCells.jsx`'s dense/table-cell popovers remain the
intentional exception from section 22 (real clipping constraint, not
laziness), and `GraphViewModal` is still slated for outright replacement by
the graph revamp rather than a shell conversion — that item (2) is next.

---

## 25. Changelog — graph view revamp, slice 1: local graph, groups, and forces

Item 2 from section 18's plan. Researched Obsidian's actual Graph view
before starting (its Filters/Groups/Forces panels and local-graph-with-
depth behavior) rather than guessing — see that section's own summary,
confirmed against Obsidian's help docs and independent write-ups of the
same three panels. This pass covers section 18's points 2-4; **point 1
(replacing the modal shell with a real pane/tab) was deliberately not
done** — see "Not done" below for why, and what's now easier because of
this pass if that's picked up next.

**Added (`features/graph/`):**
- **`useForceGraph.js`** now takes a 5th `forces` argument
  (`{ repel, linkStrength, linkDistance, center }`, exported as
  `DEFAULT_FORCES`) instead of hardcoding those four constants. Read via a
  ref updated every render, not a simulation-effect dependency, so dragging
  a slider retunes the *running* simulation instead of restarting/reseeding
  it — same "wake, don't reset" feel as the existing drag/filter-change
  wake calls.
- **`graphSettings.js`** (new): persists Filters/Groups/Forces to
  `localStorage` (`vault_graph_settings`), the same mechanism as accent
  color and the frontmatter schema — Obsidian keeps the equivalent in
  `.obsidian/graph.json` for the same reason (reopening the graph
  shouldn't reset your view). Holds `showAttachments`, `hideOrphans`,
  `localMode`, `localDepth`, `forces`, `groups`.
- **`GraphViewModal.jsx`**, three additions:
  1. **Local graph mode** — a toggle + depth slider (1-5, mirrors
     Obsidian's own range) that BFS-limits the rendered node set to notes
     within N hops of `activeFileId`, computed from the *full* edge list
     before the existing attachment/orphan filters apply (so those still
     compose correctly on top of the local neighborhood).
  2. **Groups** — an editable list of `{ query, color }`; a node's fill is
     the first group whose query is a substring of its name (Obsidian's
     own "first match wins" rule for its regex-based groups, simplified
     here to substring-of-name rather than full query syntax — see "Not
     done"). Reuses `dbState.js`'s `DB_OPTION_COLORS` palette rather than
     inventing a second one.
  3. **Forces panel** — four range sliders (repel/link force/link
     distance/center) bound straight to `useForceGraph`'s new param.
  All three live in a new `.graph-sidebar`, toggled by a sliders-icon
  button in the header and docked left as a genuine in-flow flex child of
  a new `.graph-modal-body` wrapper — not a popup, consistent with item 1's
  direction elsewhere in this doc, and not a new exception to it.
- `HelpModal.jsx`'s Graph view entry documents Local graph/Groups/Forces.

**Not done (scope deliberately narrowed for this pass):**
- **Section 18's point 1 — modal → real pane/tab.** Left as a modal. This
  is a separate, larger change (a virtual non-Drive-file pane kind touching
  `EditorContent.jsx`'s `file.kind` switch, `App.jsx`/`PaneNode.jsx`'s pane-
  opening machinery, `TabBar`/`Breadcrumb`'s `opensInEditorPane` branches)
  that's orthogonal to the graph's own feature set — doing it in the same
  pass as three new UI panels would have conflated "does the graph have
  the right controls" with "does the pane system support a synthetic tab,"
  making either one harder to review or revert independently. The
  simulation itself (`useForceGraph.js`) was already framework-agnostic
  before this pass and stays that way, so a future pane conversion doesn't
  need to touch it — only `GraphViewModal.jsx`'s outer shell would move.
- **Groups use substring-of-name matching, not Obsidian's full query
  syntax** (`tag:`, `path:`, boolean operators). This vault's notes don't
  have a tag index wired into `linkIndex` the way Obsidian's does, and
  building one just to support `tag:#foo` group queries is a bigger,
  separate piece of work than the groups feature itself — substring-of-
  name covers the common case (e.g. grouping by a naming convention) today.
  Worth revisiting if `allTags`/`extractTags` (already in `markdownParse.js`
  for the editor's own tag completion) gets threaded into `linkIndex`
  records for some other reason first.
- **No "existing files only" filter** — every node in `linkIndex.records`
  already corresponds to a real vault file (unresolved links don't get
  their own record), so this Obsidian toggle has no unresolved-link case
  to filter here; not applicable rather than skipped.
- **Tags-as-nodes** (Obsidian's optional "Tags" toggle, showing tag nodes
  connected to notes bearing them) — not added. Same underlying gap as the
  Groups query-syntax limitation above (no tag index in `linkIndex` yet);
  worth doing together if that gap is ever closed.
- Mobile layout for the new sidebar is a rough first pass (stacks above the
  canvas, wraps) — real mobile polish for the graph is item 5's own task
  (mobile canvas/graph work), not folded in here.

Still open from the original batch: DB timeline/chart views (item 3),
offline support (item 4, blocked on the architecture decision in section
19), and the mobile canvas/graph polish just mentioned (item 5) — each its
own pass.

---

## 26. Changelog — graph view revamp, slice 2: pane/tab conversion, tags as nodes, mobile

Finishes item 2 (section 18's point 1, deliberately deferred by slice 1 in
section 25) plus two more items reiterated directly: tags-as-nodes, and
graph-specific mobile layout/perf work.

**Pane/tab conversion (`graphPaneFile.js`, new):**
- The Graph view is a real tab now — split it, close it, Cmd-click it into
  a new tab, same as any note — instead of a modal. Done via a singleton
  pseudo-file (`{ id: '__graph__', kind: 'graph', name: 'Graph view' }')
  injected into `App.jsx`'s `filesById` map, *not* into `sync.filesMeta`.
  That one distinction is what makes this safe to bolt onto the existing
  pane machinery without touching it: `ensureFileLoaded`'s existing
  `sync.filesMeta.find(...)` guard already no-ops for an id it can't find,
  so there's no Drive fetch attempt, no save-buffer, and it never shows up
  in search/vault-index results — all for free, without a single
  Drive-content-path special case. `TabBar`/`PaneHeader`/`Breadcrumb` only
  ever read `file.name`/`file.kind` off a tab's file and gate
  bookmark/edit-mode buttons on `kind === 'note'`, so the pseudo-file just
  renders as a plain, non-bookmarkable, non-editable tab labeled "Graph
  view" with no extra code — confirmed by reading through
  `TabBar.jsx`/`PaneNode.jsx` line by line before writing this, not
  assumed.
- `EditorContent.jsx` gained a `file.kind === 'graph'` branch (same
  lazy-`Suspense` shape as the `database`/`canvas` branches above it),
  rendering the new `features/graph/GraphView.jsx` — `GraphViewModal.jsx`
  is deleted; its CSS stayed in place as `GraphViewModal.css` (still
  imported from `index.css`) since that file has long also held unrelated
  `.editor-preview`/wikilink/callout/table CSS, and renaming it wasn't
  worth the risk of that unrelated content getting mis-migrated for a
  filename-only change — only the graph-specific selectors inside it were
  touched (`.graph-modal` → `.graph-pane`, etc).
- **Local-graph centering across the pane switch:** local graph mode needs
  "the note you were looking at", but once you've switched to the Graph
  tab there is no such note anymore. `App.jsx` now tracks
  `lastNoteFileIdRef`, updated by a small effect that skips the graph kind,
  and exposes it as `handlers.getGraphCenterFileId()`. Simple and correct
  for the common case (open a note, then open Graph view); the edge case
  where you'd opened Graph view once already and jump straight to another
  Graph tab without visiting a note in between just falls back to no
  center note, same as if none had ever been opened this session.
- Opening the pane: `openGraphInPane()` (`App.jsx`) replaces the old
  `setGraphOpen(true)`, wired into both the command palette entry and the
  activity bar's graph icon, going through the exact same
  `openFileInPane(activePaneId, id, opts)` every note uses — Cmd/Ctrl-click
  opens it in a new tab exactly like any other file, for the same reason
  (opts forwarding), not as a special case written for graph specifically.

**Tags as nodes (`GraphView.jsx`):** a new Filters toggle. Each tag used by
a visible note becomes its own node (`tag:<name>` id, hollow-circle style
so it's visually distinct from note/attachment nodes), edged to every note
that carries it — Obsidian's own "Tags" toggle, same idea. Built entirely
on `tagsByFileId`, which already existed at the App level for the
frontmatter-tag search feature (section 6 lineage) and is now also threaded
through `handlers` for this. Clicking a tag node calls the existing
`handlers.onOpenTag(tag)` (opens the sidebar search pre-filtered to that
tag) instead of `onOpenFile`, since a tag isn't a file to navigate to.

**Mobile (`useForceGraph.js`, `GraphView.jsx`, `GraphViewModal.css`):**
- **Pinch-to-zoom** — the graph's zoom was wheel-only (desktop trackpad/
  mouse), unusable on a touch device with no wheel events. Added two-
  finger pinch via a `pointersRef` map layered on top of the existing
  pointer-event handlers (pointer events already unify mouse/touch/pen, so
  this is additive, not a parallel touch-event implementation): a second
  concurrent pointer switches `dragRef`'s mode to `'pinch'`, scaling `view.k`
  around the two fingers' midpoint the same way the wheel handler scales
  around the cursor.
- **Simulation cost** — repulsion is the O(n²) part of every tick; on a
  coarse-pointer device (`matchMedia('(pointer: coarse)')`) with more than
  150 nodes, it's now skipped on alternate frames (springs + centering
  still run every frame, so the layout doesn't visibly change shape — only
  the heaviest term is halved). Below that node count, which is the common
  case, this never engages.
- The sidebar's existing `@media (max-width: 720px)` stacking (from slice
  1) carries over unchanged; still a rough first pass, not full mobile
  layout polish.

**Deliberately not done:**
- No spatial-partitioning (quadtree) rewrite of the repulsion pass — frame-
  skipping is a smaller, lower-risk change that halves the same cost
  without restructuring `useForceGraph.js`'s core loop; worth revisiting
  only if real usage shows graphs large enough that halving isn't enough.
- Groups still substring-of-name only, no tag-query syntax for
  groups/local-graph filtering (unchanged limitation from slice 1) — tags
  are now visualizable as nodes but not yet usable as a groups/filter
  query language; that's a bigger, separate feature.
- Item 1's mobile canvas optimizations (the freeform `.canvas` board, not
  the graph) are untouched — different feature, its own pass.

Still open: DB timeline/chart views, offline support, canvas-specific
mobile work, the vector art editor, and the new "compile vault to XML for
LLM mass-editing" sidebar tool from the latest request — each its own pass.

---

## 27. Changelog — Compile to XML (vault → LLM mass-edit, and back)

New feature from the latest request, picked as the most tractable of the
remaining items — no architecture decision to make first (unlike offline
support) and no new UI paradigm to design (unlike the DB timeline/chart
views); just a clearly-specified format to implement against.

**`features/compile/compileVault.js`** (new, pure logic — no Drive calls,
no React, deliberately, so the matching/parsing rules are easy to reason
about on their own):
- `flattenVaultTree(tree)` walks `buildVaultTree`'s output once into every
  folder's and every `.md` note's full path, rooted at a fixed `vault`
  label rather than the real Drive folder name (so a compiled XML file
  stays valid if the same store is ever reconnected under a different
  folder name) — the single source both the Includes/Excludes autocomplete
  and the apply-XML path→file resolution are built from.
- `resolveIncludedFiles(tree, includes, excludes)` — empty `includes`
  means the whole vault, per the request; otherwise a folder entry covers
  everything nested under it, a file entry covers just itself, and
  excludes are applied the same way after.
- `buildCompiledXml(files)` — the exact `<documents><file path="…">…
  </file></documents>` shape from the request, with each file's content in
  a CDATA section (handling a literal `]]>` inside a note by splitting it
  across two CDATA sections, the standard escape for that one case) so
  wikilinks/HTML/whatever a note contains never needs per-character
  escaping and round-trips byte-for-byte.
- `APPLY_FORMAT_PROMPT` — the mass-editing output-format instructions from
  the request, verbatim, appended after the compiled document in the
  panel's copy/download output (one artifact, both the content and the
  instructions for how to reply to it).
- `parseApplyXml(xmlText)` — parses an LLM's `<update>/<change><search>/
  <replace></change></update>` reply via the browser's native `DOMParser`
  (no XML library pulled in for this). Returns a `parseError` string
  instead of throwing on malformed input, since this is user-pasted
  content, not trusted data.
- `applyFileChanges(content, changes)` — runs each file's changes in
  order (so a later search string can rely on an earlier replace having
  already run), requiring each `search` to match exactly once, matching
  the format prompt's own uniqueness rule — 0 or 2+ matches gets reported
  by index rather than guessed at.

**`features/compile/CompilePanel.jsx` + `.css`** (new) — a sidebar panel
(new activity-bar icon, braces), not a modal, in keeping with item 1's
direction elsewhere in this doc:
- **Compile section:** Includes/Excludes as chip-list inputs with a path
  autocomplete dropdown (`PathChipInput`, shared by both lists) — the
  dropdown is a plain sibling block below the input, closed by
  `useClickOutside`, same "not a portaled popup" pattern as every other
  inline suggestion list in this app, not a new exception to it. Compile
  calls `vaultIndex.ensureIndexed()` first if the search index isn't
  ready yet (same guard `SearchPanel`/`TagsPanel` already use before
  reading note bodies), then `getBody(id)` per included file — this means
  a compile reflects each note's last-*saved* content, not unsaved edits
  sitting in an open buffer; see the Apply section's own note on this for
  why that's the deliberate, safer choice rather than an oversight. Output
  renders in a readonly textarea with Copy-to-clipboard and Download
  buttons.
- **Apply section:** paste or upload the LLM's XML reply, then Apply,
  which calls `App.jsx`'s new `applyCompiledChanges(xmlText)`. **A file's
  changes are all-or-nothing**: every `<change>` for that file must match
  uniquely before anything is written for it — a partially-applied file
  left silently half-edited would be worse than reporting exactly which
  change failed (with its index) and letting the person fix the LLM's
  search text and retry. **Any file with unsaved edits in an open editor
  buffer is skipped, not overwritten** — fetching fresh content from Drive
  and writing back would otherwise silently discard those edits; the
  panel reports this per file so it's obvious rather than a silent no-op.
  Successful writes go through the exact same `saveNow(fileId, content)`
  every normal edit already uses, so an open (non-dirty) buffer for that
  file, the sync index, and the search index all update in place
  identically to a normal save — no separate write path was added for this
  feature to keep in sync with the others.
- New `IconBraces` in `icons.jsx`, same hand-drawn-SVG format as every
  other icon there.

**Deliberately not done:**
- No conflict *resolution* UI (e.g. re-fetch and show a merged diff) for
  the dirty-buffer-skip case — the message just says to save first and
  retry Apply; a full merge UI is a much bigger feature than this pass's
  scope, and "save your note, then retry" is a one-step fix for something
  that should be rare in practice (editing a note while also running a
  bulk XML apply against it).
- Compile doesn't warn if a note is currently open and dirty when
  included in a compile — it silently compiles the last-saved version.
  Flagged here rather than fixed because there's no clearly better default
  short of an "N notes have unsaved changes" banner, which felt like scope
  creep for a first version; worth adding if this turns out to matter in
  practice.
- No `.md`-only restriction is enforced beyond `flattenVaultTree` itself
  only ever collecting `kind === 'note'` files — canvases/databases/
  attachments were never candidates in the first place, matching "selects
  a bunch of `.md` files" from the request.

Still open: DB timeline/chart views, offline support (blocked on the
architecture decision in section 19), canvas-specific mobile
optimizations, and the vector art editor.

---

## 28. Changelog — canvas mobile fix: scrolling inside a note-embed card

Picked as the most tractable remaining item — a real, already-documented
bug (flagged as open back in section 8's mobile entry: "what's not
addressed here is the interaction between a single-finger drag and
*scrolling inside* a card's content"), not a new feature needing a design
decision.

**Root cause:** `touch-action` isn't inherited normally — the browser
computes an element's *used* value as the intersection of its own value
and every ancestor's, and an ancestor's `none` can never be loosened by a
descendant's own more-permissive value, only narrowed further. `.canvas-
node` sets `touch-action: none` (needed so our own drag-to-move survives
on mobile — see section 19's fix), so `.canvas-embed-note-body` — the
actual `overflow: auto` scrollable box inside a note-embed card — stayed
non-scrollable by touch no matter what it declared for itself.

**Fix, `canvas.css` + `CanvasView.jsx`, same trade already accepted for
text-editing cards (`.canvas-node:has(.canvas-text-editor)`):**
- `.canvas-node:has(.canvas-embed-note-body) { touch-action: pan-y; }` —
  the allowance has to live on the ancestor, since that's where the
  restriction lives. `pan-y` rather than `auto`/`manipulation` so native
  pinch-zoom-by-default stays off, consistent with how `.canvas-surface`
  handles its own (JS-driven) pinch-to-zoom. `.canvas-dot`/`.canvas-
  resize-handle` are unaffected — they set their own unconditional
  `touch-action: none`, and a descendant can always narrow an ancestor's
  allowance, just never widen it, so they stay fully protected.
- `beginMove` (`CanvasView.jsx`) now bails out immediately — no
  `stopPropagation`, no `preventDefault`, no pointer capture — when a touch
  pointerdown lands inside a `.canvas-embed-note-body` that actually
  overflows (`scrollHeight > clientHeight`), letting the browser's native
  scroll (now permitted by the CSS above) own the gesture instead of our
  drag-to-move logic fighting it. A card whose embedded content *doesn't*
  overflow is unaffected by either change and keeps dragging normally by
  touch, exactly as before.

**Trade-off, stated plainly rather than glossed over:** a note-embed card
whose preview content overflows can no longer be *moved* by starting a
touch-drag from inside that scrolling content — the same trade already
accepted for cards in text-edit mode. There's no separate drag-handle
region on these cards (the title bar, `.canvas-embed-title`, is a
non-scrolling flex-shrink:0 header above the scrollable body, but
`onPointerDownBody` is wired to the outer wrapper covering both, not the
title specifically) to move such a card by touch, you'd currently need to
either drag from a part of the card where the pointerdown doesn't land on
the overflowing body (there isn't a lot of such space on a small
note-embed card), or resize/select it another way. Wiring the title bar
itself as a dedicated always-draggable handle would close that gap
cleanly — flagged here as the natural next step rather than done in this
pass, since it's a distinct, separately-testable change (touching
`CanvasNode.jsx`'s embed-note markup, not just CSS/one function), and this
pass's job was fixing the scroll-vs-drag bug, not redesigning the card.

**Not touched:** every other canvas mobile item already covered by earlier
passes (pinch-zoom, the drag-cancel bug, bigger dot/resize-handle touch
targets, toolbar wrapping) — this was specifically the one open gap
sections 8/19 had already named and left for "its own pass."

Still open: DB timeline/chart views, offline support (blocked on the
architecture decision in section 19), and the vector art editor.

---

## 29. Changelog — database Chart view (item 3, second slice)

Picked as the most tractable remaining item — Timeline's two-date-column
Gantt-lane layout is a genuinely new UI primitive with no existing
precedent in this codebase to lean on, while Chart mostly needed one new
pure function plus a rendering component, per section 18's own scoping.

**Added:**
- **`dbState.js`**: `aggregateDbRows(rows, groupByColumn, valueColumn,
  aggregateFn)` — the group-by/aggregate step section 18 flagged as
  needing to land here first (one source of truth, section 3.4) rather
  than inline inside the chart component, so a future "chart block
  embedded in a note" feature could reuse it directly. Groups by a Select
  column's option (same constraint Board's own group-by already has, so
  `DbGroupByPicker` — already exported from `DbViews.jsx` — is reusable
  as-is for Chart too, no new picker component needed), reduces each group
  to a count, or a sum/average of a Number column. Every option gets a
  bucket even at zero rows, matching Board's "every option is a column"
  rule, so a bar/slice doesn't vanish the moment its last row is
  re-tagged.
- **`features/database/DbChartView.jsx`** (new file, per section 3.7):
  bar/line/pie over the aggregated data, one view type with a style
  switcher rather than three separate view types — they all read the same
  aggregated array and differ only in how it's drawn, and that's exactly
  how Notion's own Chart view works too. Plain hand-rolled SVG (fixed
  viewBox, `preserveAspectRatio`), no chart library pulled in — same
  approach `GraphView` already takes, and three simple geometries with no
  interaction beyond a legend hover didn't justify one. Also exports
  `DbAggregatePicker`, the count/sum/average column picker used in the
  view's settings panel.
- **`icons.jsx`**: `IconChartBar`/`IconChartLine`/`IconChartPie`, same
  hand-drawn-SVG format as every other icon there.
- **`DatabaseView.jsx`**: `chart` added to `DB_VIEW_TYPE_ICONS` and the
  add-view type list; `addView('chart', ...)` defaults `groupByColumnId`
  to the vault's first Select column (same pattern board/gallery/calendar
  already follow) plus `aggregateFn: 'count'` and `chartStyle: 'bar'`;
  `deleteColumn` now also clears a view's `valueColumnId` (resetting
  `aggregateFn` back to `'count'`) when its aggregated column is deleted,
  joining the existing `groupByColumnId`/`coverColumnId`/`dateColumnId`/
  `sortColumnId` resets there.
- **`DbViewPanel.jsx`** (new file, extracted from `DatabaseView.jsx`):
  adding Chart's settings section (group-by + `DbAggregatePicker`) pushed
  `DatabaseView.jsx` past the ~500-line soft ceiling (section 3.7), so its
  inline add-view/view-settings panel — a self-contained sub-piece only
  `DatabaseView` ever renders, same shape as the `DbCalendarView`/
  `DbChartView` split already — moved to its own file. Pure extraction, no
  behavior change beyond what Chart itself needed; `DatabaseView.jsx` is
  back down to ~375 lines.
- `database.css`: new `.db-chart-*` rules following the existing Board/
  Calendar section's token conventions right above them.
- `HelpModal.jsx`'s Databases entry now mentions Chart, its Select-property
  requirement, and where to switch aggregate/style.

**Not done (deliberately, same reasoning sections 18/20 already gave):**
Timeline — the two-date-column Gantt-lane layout — is still open; it's the
one genuinely new layout primitive of the original three, nothing existing
in `DbViews.jsx`/`DbCalendarView.jsx`/`DbChartView.jsx` is close to it, so
it stays its own pass rather than getting rushed alongside this one.

Still open: Timeline view, offline support (blocked on the architecture
decision in section 19), and the vector art editor.

---

## 30. Changelog — database Timeline view (item 3, third and final slice)

Closes out the item-3 database-views batch from section 18: Table, Board,
Gallery (pre-existing), Calendar (section 20), Chart (section 29), and now
**Timeline** — the one section 18 itself flagged as "the one genuinely new
layout primitive, nothing existing in `DbViews.jsx` is close to it."

**Added:**
- **`features/database/dbDateUtils.jsx`** (new — `.jsx`, not `.js`, since
  `DbDateColumnPicker` returns markup; the two calendar/chart-style helper
  files that only export plain functions stayed `.js`, this one couldn't):
  `pad2`/`isoDate` and `DbDateColumnPicker`, pulled out of
  `DbCalendarView.jsx` once Timeline needed the exact same "pick a Date
  property" pattern twice (Start + End) rather than duplicating it
  (section 3.4). Added `daysBetween(isoA, isoB)` (whole-day difference,
  parsed as local midnight like every other date-string handling in this
  codebase) and two new picker options Calendar's own single-picker case
  never needed: `excludeId` (so the End picker can't offer the column
  already picked as Start, and vice versa — picking the same column for
  both would make every bar a same-day sliver) and `selectedId` (a
  checkmark next to the current pick; Calendar's settings-panel usage
  still inlines its own checkmarked list rather than this component, so it
  didn't need this itself, but Timeline needs two pickers side by side in
  settings and benefits from it). `DbCalendarView.jsx` now imports these
  instead of defining its own copies — behavior unchanged there.
- **`features/database/DbTimelineView.jsx`** (new file, per section 3.7):
  one horizontal bar per row from a Start date column to an End date
  column; a row missing either date, or with end before start, just
  doesn't get a bar — same "doesn't appear" rule Calendar already uses
  for rows with no date, rather than a separate "unscheduled" lane. Range
  is derived from the data itself (min start to max end across valid
  rows, padded by 2 days either side) rather than a fixed window with
  prev/next navigation like Calendar's month view — a Gantt chart's whole
  point is showing the full span at once, not paging through it. Ruler
  and lanes share one scroll container with the ruler `position: sticky;
  top: 0` inside it, so horizontal scroll stays in sync between the two
  without duplicating scroll state. A vertical line marks today when it
  falls inside the visible range.
- **`icons.jsx`**: `IconTimeline`, same hand-drawn-SVG format as every
  other icon there.
- **`DatabaseView.jsx`**: `timeline` added to `DB_VIEW_TYPE_ICONS`;
  `addView('timeline', ...)` defaults to the vault's first two Date
  columns for start/end (falls back to `null`/`null` or `id`/`null` if
  there are fewer than two, same as every other view type's "best guess,
  pick prompts if it can't guess" default); `deleteColumn` now also clears
  a view's `startColumnId`/`endColumnId` when either's column is deleted,
  joining the existing resets there.
- **`DbViewPanel.jsx`**: Timeline's settings section (two
  `DbDateColumnPicker`s, Start and End, each excluding the other's current
  pick) and its add-view list entry.
- `database.css`: new `.db-timeline-*` rules.
- `HelpModal.jsx`'s Databases entry now mentions Timeline and its two-date
  requirement.

**Deliberately not done (stated plainly, per section 18/29's own
precedent of not glossing over scope cuts):**
- **No dragging a bar to move or resize it.** A row's dates only change
  from Properties/the row-detail modal, same as every other column type
  in this app — implementing drag-to-reschedule is a real interaction-
  design and drag-math project on the order of the canvas's own drag
  system (magnetic snapping, live date computation from pixel deltas,
  touch support), not a natural extension of this pass's scope.
- **No frozen title column.** Row titles render inside their own bar
  (truncated with ellipsis if too long) rather than in a separate
  always-visible left column the way most Gantt UIs do it — simpler, and
  fine for short titles, but a title on a short/early bar can get cut off
  more than a frozen column would allow. Worth revisiting if this turns
  out to matter in practice.
- **No zoom control.** `DAY_WIDTH` is a fixed 32px constant; a timeline
  spanning a year would be very wide (and require a lot of horizontal
  scrolling) rather than compressing to fit. A week/month/year zoom toggle
  is a reasonable follow-up but wasn't essential for a first version.

This closes the entire item-3 batch from sections 18/19. Still open
overall: offline support (blocked on the architecture decision in section
19) and the vector art editor.
