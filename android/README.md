# Store Sparks companion (Android)

Three ways to jump straight into the Sparks quick-capture form
(`#/spark-quick-add`, App.jsx's own deep-link handler) without opening the
app normally. None of them have their own capture logic, auth, or Drive
access — every one of them just opens the same web app, in the same
signed-in session, to the same form as using the app normally.

| | Where | Toggled from |
|---|---|---|
| **Home-screen widget** | Your home screen, one tap | The widget picker (long-press home screen) |
| **Quick Settings tile** | Two swipes down, from inside any app | The Quick Settings editor |
| **Floating accessibility button** | Drawn on top of whatever app you're in | Settings → Accessibility |

There's no Activity anywhere in this app and no app-drawer icon — you add
each piece from wherever Android surfaces that kind of component, not by
"opening" an app.

## 1. The widget

Long-press your home screen → Widgets → Store Sparks. Tap it, it opens the
capture form. `SparkWidgetProvider.kt` — the whole thing is one
`AppWidgetProvider` firing a plain `ACTION_VIEW` intent.

## 2. The Quick Settings tile

Pull down the notification shade twice → pencil/edit icon → drag "Add
spark" into your active tiles. Same idea as the widget, just reachable
from inside any app instead of the home screen. `SparkTileService.kt`.

## 3. The floating accessibility button

This is Android's own **Accessibility Button** system, not a hand-drawn
overlay — turn it on in **Settings → Accessibility → Store Sparks**, and
the OS itself draws a floating (or nav-bar, depending on your navigation
mode) button system-wide; tap it and it opens the capture form.
`SparkAccessibilityService.kt`.

Using the real accessibility-button API instead of a self-managed
`WindowManager` overlay turned out to be both closer to what was asked for
("a floating bubble, like the accessibility widget") *and* lighter:

- No `SYSTEM_ALERT_WINDOW` permission — the system draws the button, not
  this app.
- No foreground service, no persistent notification — the accessibility
  button doesn't need either.
- No touch/drag-handling code to get right — the system positions the
  button.

The trade-off is less control over exactly how it looks and behaves,
which genuinely varies by Android version and manufacturer skin:

- **Gesture navigation** (most modern phones' default): a small floating
  button, usually draggable to the screen edge — closest to a classic
  "chat head" bubble.
- **3-button navigation**: a fixed icon next to the nav buttons instead of
  a floating one.
- If you ever enable more than one accessibility service that requests
  this button, tapping it shows a small picker instead of triggering
  directly.
- Some OEM skins (Samsung's One UI, for instance) route this through
  their own "Assistant menu" / accessibility menu UI rather than Google's
  stock button — same on/off switch in Settings → Accessibility, slightly
  different visual.

`accessibility_service_config.xml` requests only
`flagRequestAccessibilityButton` and sets
`canRetrieveWindowContent="false"` — this service never reads anything on
your screen, it only listens for the button being tapped.

## Before building

Open `app/src/main/kotlin/com/bloxy996/storesparks/SparkConfig.kt` and
check `SPARK_CAPTURE_URL` matches where the PWA is actually deployed —
it's currently set to `https://bloxy996.github.io/store-app/#/spark-quick-add`,
matching `vite.config.js`'s GitHub Pages base-path derivation (all three
pieces above read this one constant). Change it if you're on a custom
domain.

## Building

This is a normal, standalone Gradle project — it does not touch the Vite
build and isn't wired into `.github/workflows/deploy.yml`, so adding it
doesn't affect the existing web deploy at all.

You'll need Android Studio (simplest — File → Open → this `android/`
folder, let it sync, Build → Build APK) **or** the command line with a
local Android SDK installed:

```bash
cd android
echo "sdk.dir=/path/to/your/Android/sdk" > local.properties
./gradlew assembleDebug
```

(There's no committed Gradle wrapper jar in this patch — Android Studio
generates one on first open, or run `gradle wrapper` once if you're
CLI-only and have a system Gradle install.)

The output APK lands at `app/build/outputs/apk/debug/app-debug.apk`.

## Installing (personal use — this is the recommended path)

The debug build is signed with Gradle's auto-generated debug keystore,
which is perfectly fine for sideloading onto your own phone — there's no
reason to set up release signing unless you want to share this with
someone else or publish it. Copy `app-debug.apk` to your phone (ADB,
email, Drive, whatever) and open it; you'll need to allow "install unknown
apps" for whichever app you used to open it. Then set up whichever of the
three pieces above you want.

If you do want a real release build later (`./gradlew assembleRelease`),
you'll need to generate a keystore and configure signing in
`app/build.gradle.kts` — not set up here since it's a one-person tool.

## What I could not verify

I don't have an Android SDK, an emulator, or network access to Google's
Maven repositories in the environment that wrote this, so unlike the
web-app half of this feature (which I actually built with `npm run
build`), **I was not able to fully compile this module against the real
Android framework.** What I *could* do, and did: validated every XML file
is well-formed, and ran every Kotlin file through a standalone `kotlinc`
to confirm there are no actual syntax errors (the only errors it reports
are "unresolved reference: android.*", expected without the real SDK
stubs available, not a sign of a bug).

`SparkAccessibilityService.kt` is the piece I'd test first if you only
test one thing — `AccessibilityButtonController` is a real, standard API
(added in API 26, matching this project's `minSdk`), but accessibility
services are also the part of Android most prone to per-OEM quirks, per
the variability notes above.
