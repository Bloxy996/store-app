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
      includeAssets: ['icon-192.png', 'icon-512.png'],
      manifest: {
        name: 'Vault — Notes on Drive',
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
          { src: 'icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
          { src: 'icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
          { src: 'icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' }
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
