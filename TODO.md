# TODO

Workflow: see `CLAUDE.md` section 9. Sections: Backlog → Pending → Active → Verify.
A task lives in exactly one section; verified tasks are deleted.

## Backlog

- **Vector editor: frame-by-frame animation + onion skinning.** The
  `.vec` format/editor (`features/vector/`) currently holds one static
  document. Add a way to define a sequence of frames and play/step
  through them, with onion skinning (previous/next frame(s) shown faint,
  behind the current one, while editing) as the drawing aid while doing
  it. Needs a real design pass before starting, not just a straight
  build — in particular: how a frame relates to the current single-`doc`
  model (each frame a full `parseVectorContent`-shaped snapshot? a diff
  against the previous frame? a new top-level array alongside
  `layers`?), how onion-skinning is rendered (how many frames back/
  forward, opacity falloff, toggle vs. always-on), how this interacts
  with existing layers/groups, and whether frame data changes the `.vec`
  JSON schema in a way that needs a version field for backward
  compatibility with existing saved files.
- **Vector files: embeddable "linked" view with an edit button.** When a
  vector (`.vec`) file is referenced/embedded for *viewing* (as opposed
  to opened directly in the vector editor), show it as a rendered image
  (presumably from `compileVectorSvg`'s SVG output — see `vectorState.js`)
  with an edit button pinned to the bottom-right corner of the image that
  jumps to opening the actual file in the vector editor. Needs scoping:
  where this view lives (a new embed type inside markdown notes,
  alongside however `LinkEmbeds.jsx` handles other embedded file kinds
  today? a reusable component other features could also use?), and
  whether it's live (re-renders if the source file changes) or a
  point-in-time snapshot.
- **Sparks: search/edit existing sparks through the Android accessibility
  interface, plus live near-duplicate suggestions.** Two related pieces:
  (1) the Android accessibility service
  (`android/.../SparkAccessibilityService.kt`) currently only captures
  new sparks (3.9/3.10-adjacent) — extend it to also search and edit
  existing ones from wherever it's invoked, not just add new ones. (2)
  While typing a new spark (both there and in the web app's
  `SparkCaptureForm.jsx`), show the ~5 most similar existing sparks live
  as a duplicate-avoidance aid — this reuses `lib/statementsEngine.js`'s
  `lookupSimilar` (already built for exactly this kind of "rank stored
  phrases by similarity to a query" query, see `statementsApi.js`'s
  `lookupStatements`), so the web side is mostly wiring + a debounced
  UI, not new matching logic. The Android side needs its own design pass
  first — how much of the existing web matching logic it can reach (is
  there any bridge between the Kotlin accessibility service and the web
  app's JS, or does it need its own separate implementation/API call?).
- **MIDI DAW editor for melodies/drum sequences.** Record voice input and
  store the audio file; convert recorded audio to MIDI. Instruments:
  piano, drum, synth (customizable), bass. Sequences are built as blocks
  placed on a timeline and repeated; per-block markers on the timeline
  adjust volume, reverb, etc. for that block. Needs a design pass:
  audio-to-MIDI approach (library vs. hand-rolled pitch detection),
  timeline/block data model, and audio-engine choice (Web Audio API
  scheduling, latency).
- **Image utility app.** View images; on mobile, capture photos of paper
  documents directly in-app. Square-select a region to save as its own
  image file with increased contrast applied (paper-to-PDF-style
  cleanup) — likely extends `ToolsPanel.jsx`'s existing images→PDF
  pipeline (`lib/imagesToPdf.js`) rather than a new one. A drawing-pen
  tool (color from a color picker) to draw/erase on the selection. OCR
  so any text on the page can be copied out. Also wants some kind of
  screenshot extractor — undecided/unscoped, needs the user's decision
  before design starts.
- **Store-scoped chatbot.** Answers questions using only this vault's
  own content (files + sparks), citing which file/spark each answer
  draws from. Needs scoping: retrieval approach (likely reuses/extends
  the Statements embeddings pipeline — `lib/statementsEngine.js`/
  `statementsEmbeddings.js` — rather than building a new one), where it
  runs (client-side like Statements, or a `server/` route), and UI
  placement.
- **General audit: convert hand-rolled logic to libraries where
  reasonable.** Not scoped to one feature — a pass across the codebase
  looking for hand-written implementations of things a well-maintained
  library already does well (parsing, diffing, layout math, etc.),
  the same kind of tradeoff already made deliberately for the Statements
  engine (`lib/statementsEngine.js`'s header: `string-similarity-js`
  over hand-rolled Ratcliff/Obershelp, `@xenova/transformers` over a
  from-scratch embedding model, `nspell`/`dictionary-en` over a
  hand-rolled spellchecker). Needs its own pass to identify candidates
  (e.g. `vectorTopology.js`'s geometry helpers, `markdownParse.js`/
  `markdownRender.jsx`'s hand-rolled parsing, `queryEngine.js`) and weigh
  each one's bundle-size cost against what it'd actually replace, rather
  than converting anything sight-unseen.
- **Share-target screenshot capture for sparks.** Tapping "Share" on an
  Android screenshot notification should land in the capture form with the
  image attached. Needs `share_target` in the manifest plus a service-worker
  `fetch` handler for the multipart POST, which means switching
  `vite-plugin-pwa` from `generateSW` to `injectManifest` — a caching-behavior
  change to make deliberately (CLAUDE.md 3.1/3.2). The file picker's Recent
  tab covers the need meanwhile.
- **Compress `server/` responses.** No `compression` middleware in
  `server/src/app.js`; JSON/text typically shrinks 70-80%. Mechanical,
  backend-only, direct mobile-data win.
- **Persist note bodies in IndexedDB.** `useVaultIndex.js`'s RAM-only
  `noteBodyCache` is rebuilt from Drive every page load because only
  metadata/link graph are cached locally (CLAUDE.md 3.1 permits more).
  Persist bodies diffed by `modifiedTime`, as `useVaultSync.js` does for
  the link graph, so only changed notes are refetched.
- **Virtualize the file tree and other large lists.** CLAUDE.md section 4
  asks for it, but `ExplorerPanel.jsx` (and `features/search/`,
  `features/tags/`) render every node as real DOM, so DOM/memory grow with
  vault size, worst on mobile.
- **Trim the critical-path bundle (lowest priority).** The main bundle is
  large (~1.5 MB+ min; jspdf, `@xenova/transformers`) and can't be split
  while `vite.config.js` has code splitting disabled (Rolldown bug).
  Revisit splitting once fixed upstream.
- **Full CLAUDE.md audit.** Read every `lib/`, `hooks/`, `features/*` file
  (not just ones touched by a task) to bring CLAUDE.md fully up to date
  and file anything else found here.
- **Vector editor: free-draw tool + edge tool that creates its own
  vertices.** (1) Add a freehand draw tool to the vector editor. Decision:
  build it as a new tool inside `features/vector/`, not a separate app,
  since it needs the same layers, colors/weight, snapping, undo/redo, and
  `.vec` save/export. Design points to settle: how the freehand stroke is
  stored (sampled points simplified into vertices + edges, e.g. curve
  fitting/smoothing, vs. a new stroke primitive that would change the
  `.vec` schema), a smoothing/simplification-strength setting, and whether
  it snaps its start/end to existing vertices/axes. (2) Let the Edge tool
  draw an edge between two empty spots without pre-existing vertices, the
  way `polyline` already creates vertices as you click: drag or click from
  empty canvas to empty canvas and both endpoint vertices plus the edge
  are created in one undoable step, still snapping to vertices/edges/axes
  when near them.

## Pending

_(none)_

## Active

_(none)_

## Verify

- **Android quick-add sheet: widget, Quick Settings tile, accessibility button.**
  1. Install the latest APK from the Releases page (uninstall the old one this one time: it's the first build with the fixed signing key; later builds update in place). Open the Store Sparks icon once.
  2. Long-press home screen → Widgets → Store Sparks and add the "Add a spark…" bar; add the "Add spark" Quick Settings tile; turn on Settings → Accessibility → Store Sparks and its button.
  3. From inside another app, tap each of the three. Each should slide a sheet up over that app with the add-spark form (signed in, your categories autocomplete).
  4. Add a text spark and a screenshot spark, tap Done (sheet closes back to the app you were in), and confirm both appear on the laptop.
  5. Open the sheet again and tap Open app: the full PWA opens.
  Note: Android build is only compiled by CI (no SDK where it was written); sheet behavior (partial Custom Tab, closing via `storesparks://`) is untested on a device. Opening the sheet runs the app's normal vault sync, so the form's Add button waits for sparks to load.
- **Statements: sorted insert, dedupe, lookup, spellcheck (client-side).**
  1. Toggle a category into sorted mode in the Sparks category tree and open its sorter panel.
  2. Paste multiple phrases (one per line) into the multi-line input and insert: each lands before/after its closest phrase, and exact/near duplicates are reported instead of added.
  3. Run lookup mode with a few phrases and change N: you get that many most-similar stored phrases per query.
  4. Enter a misspelled phrase: misspellings are flagged with suggestions.
  5. Try it offline after first use: it should still work.
  Note: First use needs network once to fetch the MiniLM model and dictionary.
- **Tools: local-disk reader (`reader.py` port).**
  1. Open Tools and pick a folder on your drive (File System Access API: Chromium browsers only).
  2. It produces the XML export like Compile does, and applying edited XML writes back to that folder.
  3. Confirm `/temp/processing` no longer exists in the repo.
- **GitHub Pages deploy.**
  1. Push to the deploy branch and confirm the Actions workflow succeeds.
  2. Open the Pages URL: the app loads with correct asset paths and installs as a PWA.
  3. Sign in through the Apps Script proxy option (Pages can't run the Node backend).
