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
`components/` (`DropdownMenu`, `icons.jsx`'s 60+ `Icon*` set, `StatusBar`,
`PropertiesPanel`, `ResizeHandle`, `LinkEmbeds`, `InlineMentions`) are the
building blocks. **All icons live in `components/icons.jsx`** — don't
inline a new `<svg>` in a feature file; add it there and import it, so
there's one place to keep stroke-width/size/viewBox consistent. Same for
dropdown menus: extend `DropdownMenu`/`MenuItem` rather than hand-rolling a
new floating menu.

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
    DropdownMenu.jsx / .css         — the shared floating menu (+ MenuItem, MenuDivider)
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
- **Full markdown editing inside database cells and canvas cards**
  (coloring/formatting/autocomplete "just like a note, but inside the
  cell/card"). This means embedding a real CodeMirror instance per
  multiline cell/card rather than a plain `<textarea>`/`contenteditable`
  — a real architecture change to `DbCells.jsx` and `CanvasNode.jsx`, not
  a styling tweak.
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
- Canvas text cards still use a plain `<textarea>` for editing, not a
  scoped markdown editor with coloring/autocomplete "just like a note, but
  inside the card." Same underlying architecture change as full markdown
  editing in database cells (embedding a real CodeMirror instance per
  card/cell) — not attempted here, don't half-do it as a side effect of
  the bug-fix pass above.
- Site-wide popup → inline conversion, the graph-editor revamp, and
  timeline/calendar/chart database views: untouched, still each their own
  pass — see section 8 for scope notes on each.
