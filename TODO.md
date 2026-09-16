# TODO / open work

Referenced by `CLAUDE.md` section 7 as the place for open/requested work and
changelog-style notes, so it doesn't bloat the living architecture doc.

## Hosting: Vercel + repo privacy (2026-09)

Shipped: `server/src/app.js` (Express app factory, now wiring up
auth/drive/statements/music routers) + `server/api/index.js` (Vercel
serverless entrypoint) + root `vercel.json`, so the frontend (static
build) and the Node/Express half of the backend can deploy together as a
single Vercel project instead of GitHub Pages + Render. The Render/
plain-Node path (`server/src/index.js`) still works unchanged — both
entrypoints share `app.js`, so there's one set of routes/CORS logic, not
two. See `server/README.md`'s "Deploying" section for env var
differences between the two paths.

**Not done in this pass / needs a person with Vercel + GitHub access:**

- **No real Vercel deployment has been exercised against this config** —
  no Vercel account/project was available to test against. Treat
  `vercel.json` as a starting point to verify against, not a
  guaranteed-working deploy: watch for env var setup (`GOOGLE_CLIENT_ID`,
  `GOOGLE_CLIENT_SECRET`, `GOOGLE_REDIRECT_URI`, `SESSION_SECRET`,
  `FRONTEND_URL`, `VITE_BACKEND_URL`) and the OAuth redirect URI needing
  to be added in Google Cloud Console for the real `*.vercel.app` domain.
- **The Python service (`server/python/`) is out of scope for the Vercel
  path and still needs its own persistent host** (small VM, Render/Fly/
  etc.) regardless of what the Node half runs on — `torch`/
  `sentence-transformers` need to stay resident in memory across
  requests (see `python/README.md`), which doesn't fit a serverless
  function's size/cold-start budget. This applies whether the Node
  backend ends up on Render or Vercel; it isn't specific to either.
- **Making the GitHub repo private, if the GitHub Pages hosting path is
  kept:** GitHub Pages from a **private** repo requires GitHub Pro/
  Team/Enterprise — it doesn't work on the free plan. This wasn't
  something a code change could resolve either way, but it's worth
  knowing before flipping the repo to private: either move fully to the
  Vercel path above (works fine from a private repo, no plan
  requirement), or confirm the GitHub plan supports private-repo Pages
  first. Flipping repo visibility itself is a GitHub Settings action, not
  something a patch can do.
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

