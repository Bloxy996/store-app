import { useRegisterSW } from 'virtual:pwa-register/react';

// App version + auto-update surface (CLAUDE.md section 13, item 4).
//
// vite-plugin-pwa's registerType:'autoUpdate' (vite.config.js) already
// downloads a new service worker and, on the *next* navigation, would swap
// it in silently. For a single-page app that's rarely reloaded, "next
// navigation" can be days away, so the user is effectively stuck on a stale
// shell with no way to know a new one is ready. This hook is the missing
// half: it surfaces that moment (`needRefresh`) so StatusBar can show an
// inline "Update available" control, and lets the user apply it on demand
// via `updateServiceWorker(true)` (the `true` forces the tab to reload once
// the new worker takes control, matching how a normal page refresh gets a
// new build).
//
// No polling/interval is added here — the underlying `navigator.serviceWorker`
// register call already re-checks the SW file on every normal page
// (re)load, which is enough for a PWA that's opened at least occasionally;
// a background poll timer would also fight the NetworkOnly-for-Drive
// caching rule's spirit (section 3.1/4) for no real benefit.
function useAppUpdate() {
  const {
    needRefresh: [needRefresh],
    updateServiceWorker
  } = useRegisterSW({
    onRegisterError(error) {
      // Non-fatal: the app works fine without a working SW registration
      // (e.g. local dev without HTTPS, or a browser with SW disabled). Log
      // only, no user-facing error — this must never look like a sync/save
      // problem.
      console.warn('Service worker registration failed:', error);
    }
  });

  return {
    version: typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : 'dev',
    updateAvailable: needRefresh,
    applyUpdate: () => updateServiceWorker(true)
  };
}

export { useAppUpdate };
