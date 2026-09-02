import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

// Vault — Google Drive-backed markdown notebook.
// PWA config enforces app-shell-only caching: Drive API traffic and note
// content are explicitly excluded from the service worker's cache (NetworkOnly),
// satisfying the 0MB permanent local note storage constraint.

// GitHub Pages "project sites" are served from https://<user>.github.io/<repo>/,
// so every asset URL needs that /<repo>/ prefix. This derives it automatically
// from GITHUB_REPOSITORY inside GitHub Actions, and falls back to '/' for local
// dev and for "user/organization" pages (repo named <user>.github.io).
const repoName = process.env.GITHUB_REPOSITORY?.split('/')[1];
const isUserOrgPage = repoName?.endsWith('.github.io');
const base = process.env.GITHUB_ACTIONS && repoName && !isUserOrgPage ? `/${repoName}/` : '/';

export default defineConfig({
  base,
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      injectRegister: 'auto',
      includeAssets: ['icon-192.png', 'icon-512.png', 'icon-512-maskable.png', 'apple-touch-icon.png'],
      manifest: {
        name: 'Vault',
        short_name: 'Vault',
        description: 'A minimalist markdown notebook that reads and writes directly to your Google Drive. No local note storage.',
        theme_color: '#1a1a1e',
        background_color: '#1a1a1e',
        display: 'standalone',
        display_override: ['window-controls-overlay', 'standalone'],
        orientation: 'portrait-primary',
        // start_url / scope / id intentionally omitted: vite-plugin-pwa
        // derives them from `base` above, so this works at both '/' (local
        // dev) and '/<repo>/' (GitHub Pages project site) without edits.
        categories: ['productivity', 'utilities'],
        icons: [
          // Icon `src` here is NOT automatically base-prefixed by
          // vite-plugin-pwa (long-standing upstream gap — see
          // github.com/vite-pwa/vite-plugin-pwa/issues/713), unlike
          // start_url/scope above. On a GitHub Pages *project* site
          // (base === '/<repo>/') an un-prefixed 'icon-192.png' resolves to
          // https://<user>.github.io/icon-192.png instead of
          // https://<user>.github.io/<repo>/icon-192.png — a 404. Chrome's
          // installability check silently fails when it can't fetch a
          // qualifying icon, so the browser falls back to a plain
          // "Add to Home Screen" bookmark shortcut (generic browser icon,
          // opens in a tab, removed like a bookmark rather than uninstalled
          // like an app) instead of a real install — which matches exactly
          // what's being reported. Prefixing with `base` here works for
          // both '/' and '/<repo>/' and costs nothing either way.
          { src: `${base}icon-192.png`, sizes: '192x192', type: 'image/png', purpose: 'any' },
          { src: `${base}icon-512.png`, sizes: '512x512', type: 'image/png', purpose: 'any' },
          // A maskable icon needs its own artwork, not the transparent
          // 'any' icon reused: the OS crops maskable icons to an arbitrary
          // shape (circle, squircle, ...), so it needs real fill behind the
          // mark and the mark inset within the ~80% "safe zone" — a
          // transparent background there shows as a transparent/black gap
          // wherever the crop shape extends past the artwork.
          { src: `${base}icon-512-maskable.png`, sizes: '512x512', type: 'image/png', purpose: 'maskable' }
        ]
      },
      workbox: {
        // Only the app shell (build output) is precached. Never precache
        // API responses or note bodies.
        globPatterns: ['**/*.{js,css,html,ico,png,svg,woff2}'],
        navigateFallback: `${base}index.html`,
        navigateFallbackDenylist: [/^\/api\//],
        cleanupOutdatedCaches: true,
        runtimeCaching: [
          {
            // Drive REST + upload endpoints: always hit the network,
            // never cache file lists, metadata, or file content.
            urlPattern: ({ url }) =>
              url.origin === 'https://www.googleapis.com' ||
              url.origin === 'https://content.googleapis.com',
            handler: 'NetworkOnly'
          },
          {
            // Auth + Identity + Picker: always network.
            urlPattern: ({ url }) =>
              url.origin === 'https://accounts.google.com' ||
              url.origin === 'https://apis.google.com',
            handler: 'NetworkOnly'
          }
        ]
      },
      devOptions: {
        enabled: true,
        type: 'module'
      }
    })
  ],
  server: {
    port: 5173,
    host: true
  },
  build: {
    target: 'esnext',
    sourcemap: false,
    outDir: 'dist'
  }
});
