# TODO / open work

Referenced by `CLAUDE.md` section 7 as the place for open/requested work and
changelog-style notes, so it doesn't bloat the living architecture doc.

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

## Known documentation drift (pre-existing, unrelated to Sparks)

`server/README.md` references a `docs/CLAUDE.md` that doesn't exist —
there's only the root `CLAUDE.md`. Worth reconciling at some point.
