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

- **Vector: reference (tracing) image.**
  1. Click the reference-image button in the toolbar and pick an image from the vault.
  2. It appears faded and behind every layer, including when layers are hidden/reordered.
  3. Draw over it, save, reopen: the image is still there. It should not appear in the SVG export.
  4. Switch to view mode: the reference image should not be visible there.
- **Vector: proportional scaling toggle.**
  1. Select one object, then several. Turn proportional scaling on and drag a corner handle: aspect ratio is kept.
  2. Turn it off and drag again: width/height scale independently.
- **Vector: Description and Layers as right-side sidebars.**
  1. Click Description: a full-height sidebar opens right of the canvas.
  2. Click Layers: a second sidebar opens. Both are visible at once.
  3. Toggle each button off independently; the canvas resizes to fit.
- **Vector: move selection up/down layers.**
  1. Select an object and use the move up/down layer control.
  2. It moves to the adjacent layer, keeps its position, and stays selected. Undo/redo reverts it.
- **Vector: custom snap axes, full snapping.**
  1. Create a custom snap axis, then draw/move points, edges, circles near it: they snap to it.
  2. Drag one of the axis's points: the other point and the axis stay visible the whole drag.
  3. Place a point near where two axes cross: it snaps to the crossing and both guide lines show.
  4. Draw a polyline near vertices/axes: the hover preview line and its label follow the snapped point, and clicks land on it.
- **Vector: clicking points inside a selection.**
  1. Select several objects, then click/drag a point inside the selection box: that point is picked/moved, not the whole selection.
  2. Drag the move handle at the bottom of the selection: the whole selection moves.
- **Vector: measurement labels (offsets, ratios, lengths, angles).**
  1. Labels use a transparent background and the snap-axis colors.
  2. They show while creating axes, vertices, edges, circles, and polylines, and while selecting, not only during selection.
  3. They show for every relevant axis/vertex/edge, not just the one in focus.
  4. Circles show position stats.
- **Vector: selecting thin things.**
  1. Try clicking a thin custom snap axis, a zero-weight edge, and a hairline edge at different zoom levels: each is easy to hit without pixel-perfect aim.
- **Vector: RGBA color picker.**
  1. Open the edge color, circle fill, text color, and canvas background controls.
  2. Each has hue plus an opacity slider; dragging opacity to 0 gives transparent.
  3. The canvas shows the alpha live, and the SVG export's colors/background match.
- **Reload button and new-window freshness.**
  1. Open a note in the app, then edit the same file elsewhere (another tab/device or Drive).
  2. Click Sync in the activity bar: the open tab updates to the new content (a tab with unsaved edits is left untouched).
  3. Edit it elsewhere again, then use "Open in new window": the new window shows the current content.
- **Sparks: create, browse, link, delete.**
  1. Open the Sparks panel and click New spark. Type text on several lines: each line becomes its own spark in the same category.
  2. Category autocomplete suggests existing nested categories (e.g. `vehicles/boat/small`). Also try a screenshot plus caption.
  3. Link a spark to 1+ notes/files using the search (matches title, frontmatter, and content), then add.
  4. Browse sparks by category. Open a linked note: it shows an indicator that sparks link to it, and the spark shows its linked files.
  5. Delete a spark from the panel: it disappears and the note's indicator updates.
  Note: Sparks are stored in `.store/spark.txt`, which should not appear in the file tree.
- **Android quick-capture widget and accessibility button.**
  1. Build `android/` in Android Studio and install it; add the home-screen widget and Quick Settings tile, enable the accessibility service, and turn on its button.
  2. Each entry point opens the PWA's spark capture form (`#/spark-quick-add`); capture a text spark and a screenshot spark from it.
  3. Confirm the same sparks are visible and creatable from the laptop web app.
  Note: The Android module has never been compiled against the real SDK, so expect to fix build errors first (`android/README.md`).
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
