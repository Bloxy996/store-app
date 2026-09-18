# TODO / open work

Referenced by `CLAUDE.md` section 7 as the place for open/requested work and
changelog-style notes, so it doesn't bloat the living architecture doc.

## Reload button, popout freshness, vector canvas-bg alpha, multi-axis/polyline snapping (2026-09)

- **Reload button did nothing for already-open files.** `syncNow()`
  refreshed `sync.filesMeta`/IndexedDB/the search index, but
  `ensureFileLoaded` only ever fetches a file's content once and skips it
  forever after (its `buffers[fileId]` guard) — so a file edited
  elsewhere (another device/tab, or directly in Drive) kept showing its
  old content in an open tab even after a manual sync said it was current.
  Fixed: buffers now track the Drive `modifiedTime` they were loaded from;
  a new effect in `App.jsx` force-refetches (via a new `force` option on
  `ensureFileLoaded`) any open file whose remote `modifiedTime` moved,
  skipping anything dirty/saving/loading so it can never clobber unsaved
  edits or race an in-flight save. `saveNow` also now records the fresh
  `modifiedTime` after a successful save, so autosave doesn't look like an
  external edit and trigger a pointless refetch of what was just saved.
- **"Open in new window" had the same staleness problem** — `popOutTab`
  just reused whatever buffer already existed. Now force-refetches (same
  safety check) when popping a tab out, so the popout always shows current
  content.
- **Vector canvas background couldn't be transparent/semi-transparent** —
  it was a bare `<input type="color">`, the one remaining color control in
  `VectorToolbar.jsx` not using the existing `ColorAlphaField` (hue + alpha
  slider) that edge/circle-fill/text colors already had. Confirmed the
  whole pipeline (storage as a plain string, live CSS `background-color`,
  `contrastDotColor`'s luminance calc, and the exported SVG's background
  `<rect fill>`) already handles 8-digit hex / `'transparent'` with zero
  other changes needed, so just swapped the control.
- **Custom snap axes only ever snapped to one at a time** — `snapCandidate`
  in `vectorTopology.js` picked whichever single candidate line was
  nearest. Added a `lineIntersection` helper and changed the axis-line
  branch to snap to where two in-range lines *cross* when both are within
  threshold at once (falling back to the single-nearest-line behavior
  otherwise, or when they're parallel, or when the crossing point itself
  would be further from the pointer than the snap threshold — avoids a
  long jump off a near-parallel pair). The render side now draws both
  guide lines when this happens (`snapLineP1b`/`snapLineP2b`).
- **Polyline placement already snapped** (vertex/edge/custom-axis/
  horizontal-vertical, via the same shared `resolvePlacement`/
  `snapCandidate` every other tool uses) but the *hover preview* — the
  dashed line from the last placed point to the cursor, plus the distance/
  angle label — used the raw unsnapped pointer position, because polyline
  placement is a plain click (no `dragRef` drag), and the snap-preview
  computation in `onContainerPointerMove` only ran during an active drag.
  Added a polyline-specific branch there so hovering while drawing a
  polyline now shows the same guide-line/snap-marker feedback other tools'
  drags already get, and the preview line/label follow the snapped point
  instead of the raw cursor.
- **GitHub Pages**: workflow (`.github/workflows/deploy.yml`) and
  `vite.config.js`'s base-path handling already existed and needed no
  changes — GH Pages only ever hosted the static frontend (via the Apps
  Script proxy auth path, `isProxy()` in `driveApi.js`, since GH Pages
  can't run the Node backend), and nothing in the Python removal or this
  round of fixes touches any of that.

## Fixed a crash opening vector files (React error #310) (2026-09)

- `features/vector/VectorEditorView.jsx` had `if (loading) return <Loading/>;`
  sitting between two hook calls — most of the component's `useState`/
  `useMemo`/`useCallback`/`useEffect` calls came before it, but one more
  `useMemo` (`transformVertexIds`) came after. Fine on the very first render
  if `loading` was already `false` (nothing skipped), but the normal path —
  mount while Drive is still fetching the file's content, then `loading`
  flips to `false` once it arrives — called one *more* hook on that second
  render than the first had recorded, which React disallows regardless of
  how far apart the two hook calls are. Reliably threw "Rendered more hooks
  than during the previous render" (minified as error #310) the moment a
  vector file finished loading.
- Fix: moved the `if (loading)` check down to immediately before the
  component's final JSX return, after every hook call. Confirmed safe to
  compute the (non-hook) derived values in between during a loading render
  too — `parseVectorContent`'s `makeDefaultVectorState()` fallback already
  guarantees `doc` is a well-formed empty document before content arrives,
  which the earlier hooks in this same component were already relying on.
- Also fixed a related but separate bug spotted in the same component:
  `ReferenceImageNode` destructured `{ url, loading: imgLoading }` from
  `useDriveImageUrl`, which actually returns `{ url, error }` — `imgLoading`
  was always `undefined`, so the "Loading…" label over a reference image
  never showed while its blob was being fetched. Now derived locally as
  `!url && !error`.

## Removed the Python backend; Statements now runs entirely client-side (2026-09)

- **Removed `server/python/`** (Flask app, `statements_engine.py`,
  `sentence-transformers`/`torch`/`pyspellchecker` deps) and its Node proxy
  (`server/src/routes/statements.js`, the `/api/statements/*` routes,
  `PYTHON_SERVICE_URL` in `server/src/config.js`/`.env.example`). The
  backend no longer has any compute-heavy route or reason to run a second
  process — just OAuth + Drive proxying.
- **Ported `statements_engine.py` to run in the browser** instead:
  `lib/statementsEngine.js` (the pure scoring/tie-break/dedupe logic,
  hand-translated 1:1), `lib/statementsEmbeddings.js` (`@xenova/
  transformers` running the same `all-MiniLM-L6-v2` model as an ONNX
  build, in place of `sentence-transformers`/PyTorch), and
  `lib/spellcheck.js` (`nspell` + `dictionary-en`'s `.aff`/`.dic` files,
  fetched lazily via Vite `?url` rather than importing `dictionary-en`
  itself — its loader reads via Node's `fs` and doesn't run in a browser
  bundle). `lib/statementsApi.js` keeps the exact same four exported
  functions/signatures/return shapes it always had, so
  `CategorySorterPanel.jsx` didn't need any changes.
- **Not an exact algorithmic match, deliberately**: word/phrase similarity
  ratios now come from `string-similarity-js` (Dice coefficient) instead
  of Python's `difflib.SequenceMatcher` (Ratcliff/Obershelp) —
  `DEFAULT_WEIGHTS` in `statementsEngine.js` were adjusted for the new
  scale. Spellcheck suggestions come from `nspell` (Hunspell-based)
  instead of `pyspellchecker` (Norvig frequency-list based) — different
  dictionary, different suggestions for the same misspelling. Embeddings
  are the same model, converted to ONNX; not bit-identical to the PyTorch
  version but close enough not to matter for similarity ranking.
- **Bundle size tradeoff**: `@xenova/transformers` (onnxruntime-web) adds
  real weight to the single main JS bundle — `vite.config.js`'s
  `rolldownOptions.output.codeSplitting: false` (a workaround for an
  unrelated Rolldown/Vite 8 init-order bug — see its comment) means this
  can't currently be split into a lazy-loaded chunk the way graph/
  database/canvas/vector are, so every user downloads it on first load,
  not just people who use the Statements sorter. Bumped `workbox.
  maximumFileSizeToCacheInBytes` (was hitting the 2 MiB default) so it
  still gets precached for offline use. Revisit splitting it out once the
  Rolldown bug is fixed upstream.
- **Model weights and the dictionary word list are fetched at runtime**,
  not bundled: the `all-MiniLM-L6-v2` ONNX weights come from Hugging
  Face's CDN on first use (cached by `@xenova/transformers` itself via
  Cache Storage, separate from the service worker), and the ~550KB
  `dictionary-en` word list is a separate build asset fetched only if/when
  spellcheck is actually used — neither is precached by the service
  worker, so first use of either needs network once, and (for the model)
  needs `huggingface.co` reachable, a new runtime dependency the old
  Vercel/Render deploy never had.
- **New capability, not just a rewrite**: since sorting/insert/lookup no
  longer depend on a reachable backend once the model's cached, the
  Statements sorter now works fully offline — it didn't before (it
  degraded to a "service unavailable" message if the Python process
  wasn't reachable).

## Removed music downloader; generalized the sorter + Python backend (2026-09)

- **Removed the YouTube-audio music downloader** (`server/python/
  music_downloader.py`, its `/music/download` Flask route,
  `server/src/routes/music.js`, `lib/musicApi.js`, `ToolsPanel.jsx`'s
  `MusicSection`, the `yt-dlp` dependency) — not worth the ffmpeg
  install/deploy story for what it did. `server/python/` now backs one
  feature (statements), though it's still written to host more.
- **Generalized the sorter** off its one hardcoded `statements` category:
  any category can be toggled into similarity-sorted mode from
  `SparksPanel.jsx`'s category tree (new `lib/sortedCategories.js`,
  localStorage-backed), any number at once, each independently. Matching
  is by exact category path, so a category with nested sub-categories
  only ever sorts sparks filed directly under its own name,  never the
  nested ones. `StatementsPanel.jsx` is now `CategorySorterPanel.jsx`,
  taking `category` as a prop instead of a hardcoded constant. A
  fresh/upgraded install defaults to `['statements']` toggled on, so
  existing "statements" data keeps sorting exactly as before with no
  manual step.
- **Generalized the Python backend's naming**, since it's no longer
  framed as "the two features that need Python": `STATEMENTS_SERVICE_URL`
  is now `PYTHON_SERVICE_URL` (`server/.env.example`, `server/src/
  config.js`, `server/README.md`, `server/api/index.js`'s comment) —
  update your `.env` if you had the old name set.
- **Added an embedding cache to `statements_engine.py`**
  (`_EMBEDDING_CACHE`, keyed by exact phrase text) alongside its existing
  word-similarity/alignment/syllable/pairwise-score caches, all now
  capped at `_MAX_CACHE_ENTRIES` with a blunt full-clear past that rather
  than growing unboundedly. Repeated sort/insert/lookup calls over
  phrases the process has already embedded skip the model forward pass
  entirely — the expensive part, versus the cheap pure-Python scoring
  the other caches cover. This matters more now that the sorter isn't
  tied to one category: the same corpus can come back across many calls
  across many categories.

## Hosting: Vercel, verified (2026-09)

Shipped: `server/src/app.js` (Express app factory, wiring up
auth/drive/statements routers) + `server/api/index.js` (Vercel serverless
entrypoint) + root `vercel.json`, so the frontend (static build) and the
Node/Express half of the backend can deploy together as a single Vercel
project. The plain-Node path (`server/src/index.js`, e.g. for an
all-Render deploy) still works unchanged — both entrypoints share
`app.js`, so there's one set of routes/CORS logic, not two. See
`server/README.md`'s "Deploying" section for both paths' env var setup
and how to switch between them (no code changes either way).

**Verified against a real Vercel deployment** — the env var setup in
`server/README.md` (`GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`,
`GOOGLE_REDIRECT_URI`, `SESSION_SECRET`, `FRONTEND_URL`,
`VITE_BACKEND_URL`, plus the OAuth redirect URI in Google Cloud Console)
works end to end on a live `*.vercel.app` domain.

**Still open:**

- **The Python service (`server/python/`) is out of scope for both
  hosting paths and still needs its own persistent host** (small VM,
  Render/Fly/etc.) regardless of what the Node half runs on — `torch`/
  `sentence-transformers` need to stay resident in memory across
  requests (see `python/README.md`), which doesn't fit a serverless
  function's size/cold-start budget. This applies whether the Node
  backend ends up on Render or Vercel; it isn't specific to either.
- **Further backend migration was deliberately NOT done** to editor-hot-path
  logic (markdown parsing/rendering, the query engine, search, link graph,
  pane-tree math). Moving those server-side would add a network round trip
  to work that currently happens instantly against already-loaded content
  — CLAUDE.md section 4 treats that responsiveness as a priority, so this
  would trade speed for... less speed. The `/api/drive/file/:id/blob`
  conditional-GET change (`server/README.md`, `driveClient.js`) is the one
  backend change made in this pass that's a clear, low-risk
  frontend-resource win: unchanged images/audio/video get a small 304
  instead of a full re-download + re-decode on revisit.

## Split-pane resize glitch (2026-09)

Fixed: dragging a split-pane divider (`ResizeHandle.jsx`) visibly resisted
being moved / jittered back toward its start position. Cause: `App.jsx`'s
`resizeSplit` was a `useCallback` closing over the `paneTree` state
directly, memoized with `[paneTree]` as its dependency — but
`ResizeHandle`'s `mousedown` handler only attaches its `window` "mousemove"
listener once, at the start of a drag, capturing whichever `resizeSplit`
closure existed at that instant. Every subsequent `mousemove` in that same
drag kept calling that one stale closure, so each frame's delta was applied
to the pane sizes as they were when the drag *started*, not as they were
after the previous frame's move — frames didn't accumulate. Fixed by
switching `resizeSplit` to the functional `setPaneTree(prev => ...)` form,
so every call — however old its closure — reads/writes current state.

## Performance follow-up (2026-09)

Two concrete backend/mobile-perf gaps found (discussed, not yet patched):

- **No response compression on `server/`.** No `compression` middleware
  anywhere in `server/src/app.js` — every response (Drive listings, note
  content) goes over the wire uncompressed. Text/JSON typically compresses
  70-80%; this is a safe, mechanical, backend-only change with a direct
  mobile-data/load-time payoff.
- **Note bodies aren't persisted locally, so the whole vault gets
  re-downloaded every session.** Per CLAUDE.md 3.1, IndexedDB only caches
  file metadata + the link graph, never body content. `useVaultIndex.js`'s
  RAM-only `noteBodyCache` (used for search + tags) is therefore rebuilt
  from Drive on every page load — even for notes that haven't changed
  since last time, because there's no local copy to diff against. Fix:
  persist bodies in IndexedDB too, diffed by `modifiedTime` the same way
  `useVaultSync.js` already diffs the link graph, so only changed notes
  get re-fetched.

Three items specifically traced to what CLAUDE.md currently documents/
permits, found while answering "what's in CLAUDE.md holding performance
back":

- **CLAUDE.md 3.1's "avoid writing note content to disk" default is the
  direct cause of the re-download above** — same root issue, same fix.
  3.1 already calls this "a design choice, not a hard constraint," so
  nothing here needs CLAUDE.md wording changed, just the code.
- **CLAUDE.md section 4 tells contributors to "keep large lists
  virtualized/paginated as vaults grow," but nothing actually is.**
  Checked `features/sidebar/`, `features/search/`, `features/tags/`: no
  `react-window`/manual virtualization anywhere. `ExplorerPanel.jsx`
  renders the full file tree as real DOM nodes regardless of vault size —
  unbounded DOM/memory growth on scroll for large vaults, worst on
  mobile. The doc states the right target; the code doesn't follow it yet.
- **Section 2's "client-rendered (no SSR)" plus 3.7's tolerance for a
  large, un-split `App.jsx` (~1,538 lines) compound into a large
  unavoidable critical-path bundle** (1.55 MB min per the last build
  output, up from 818 KB before the Statements/Tools features — `jspdf`
  plus the new feature code account for the growth) — `App.jsx` is the
  composition root/entry point, so it can't be `React.lazy`'d away like
  `graph`/`help`/`palette`/`database`/`canvas`/`vector` already are.
  Lowest priority of the three: this app is auth-gated personal Drive
  data, so SSR has little to pre-render anyway; flagging it mainly
  because it's explicitly named in CLAUDE.md, not because it's a
  high-value fix.

## Full CLAUDE.md audit (not yet done)

Everything CLAUDE.md-related in this pass (hosting, the resize fix, the
items above) touched only the files those specific tasks needed — not a
full read of the whole frontend. Still needed: a complete pass over the
whole codebase (every `lib/`, `hooks/`, `features/*` file, not just the
ones a given task happened to touch) to (1) bring CLAUDE.md fully up to
date and accurate against what the code actually does, and (2) file
anything else worth tracking here in TODO.md that pass turns up.

## Sparks (2026-09)

Shipped: `.store/spark.txt` storage, the Sparks side panel + capture form
(category autocomplete, multi-line text-per-line capture, screenshot
attach + caption, note/file linker over title+frontmatter+content), the
note-side "N sparks link here" indicator, and the `#/spark-quick-add` deep
link a native launcher can open to jump straight to the capture form. See
CLAUDE.md 3.8/3.9 for the architecture.

**Deferred, not implemented in this pass:**

- **Share-target screenshot capture** (tapping "Share" on an Android
  screenshot notification, landing directly in the capture form with the
  image attached). This is a real PWA feature (`share_target` in the web
  manifest + a service-worker `fetch` handler for the multipart POST), but
  it requires switching this app's `vite-plugin-pwa` strategy from
  `generateSW` to `injectManifest` to add custom SW code — that's a change
  to the service worker's caching behavior, which CLAUDE.md 3.1/3.2 treats
  as something to touch carefully and deliberately, not as a drive-by
  addition. Left out of this pass; the file picker (Recent tab surfaces
  the latest screenshot in 1-2 taps) covers the same need in the
  meantime.

## Android widget (2026-09)

Shipped: `android/` — three deep-link entry points into
`#/spark-quick-add`, all firing a plain `ACTION_VIEW` intent, none with
native capture logic of their own:

- Home-screen widget — no permission, no running process.
- Quick Settings tile — a plain "open the capture form" shortcut, no
  permission or running process of its own.
- Floating button via Android's own **Accessibility Button** system
  (`SparkAccessibilityService`) — toggled from Settings → Accessibility,
  not from the tile. An earlier version of this built a self-drawn
  `WindowManager` overlay (`SYSTEM_ALERT_WINDOW` + a foreground service +
  a persistent notification) toggled by the tile; replaced with the
  system accessibility-button API instead, which is both closer to what
  was actually asked for ("a floating bubble, like the accessibility
  widget") and lighter — the OS draws/positions the button, so none of
  that permission/service/notification cost applies anymore.

`minSdk` is 26 (`AccessibilityButtonController` needs it, same floor the
earlier overlay design already required). See `android/README.md` for the
full breakdown, what each piece costs, and the real per-OEM variability in
how the accessibility button looks/behaves.

**Caveat:** written without access to an Android SDK/emulator/Google's
Maven repos, so unlike the web-app side of this feature (built and
verified with `npm run build`), this module has **not** been fully
compiled against the real Android framework. Every XML file was validated
well-formed, and every Kotlin file was run through a standalone `kotlinc`
to rule out actual syntax errors — but that's short of a real build.
`SparkAccessibilityService.kt` is the piece to build/test first — it's a
real, standard Android API, but accessibility services are also the part
of the platform most prone to per-OEM quirks. See `android/README.md`'s
last section for specifics.

