import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig({
  // GitHub Pages serves a project site from /<repo>/ — the base is set at
  // build time (VITE_BASE, set in CI's Build step) so a local build stays
  // at '/'. vite-plugin-pwa derives the SW scope and the manifest's
  // start_url from this, so the PWA stays installable under the subpath.
  base: process.env.VITE_BASE || '/',
  plugins: [
    react(),
    VitePWA({
      strategies: 'generateSW',
      // 'prompt': a new service worker waits until the user accepts the
      // in-app update toast (see PwaUpdateToast) — never a silent mid-session swap.
      registerType: 'prompt',
      // We call registerSW ourselves from src/services/pwa.ts.
      injectRegister: null,
      includeAssets: ['icons/icon.svg'],
      manifest: {
        // The brand is a French proper name: identical in the fr/en/es UIs, and
        // identical here, so an installed app is named the same in every locale.
        name: 'Budget et Compte',
        short_name: 'Budget et Compte',
        description:
          'Gestion financière familiale 100% locale — comptes, budget et Mobile Money.',
        lang: 'fr',
        start_url: './',
        scope: './',
        display: 'standalone',
        orientation: 'portrait-primary',
        background_color: '#020617',
        theme_color: '#0f172a',
        categories: ['finance'],
        icons: [
          { src: 'icons/pwa-64x64.png', sizes: '64x64', type: 'image/png' },
          { src: 'icons/pwa-192x192.png', sizes: '192x192', type: 'image/png' },
          { src: 'icons/pwa-512x512.png', sizes: '512x512', type: 'image/png' },
          {
            src: 'icons/maskable-icon-512x512.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'maskable',
          },
          { src: 'icons/icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' },
        ],
      },
      workbox: {
        // Everything hashed by Vite plus static images/icons gets precached.
        globPatterns: ['**/*.{js,css,html,svg,png,ico,webmanifest}'],
        // SPA fallback: unknown navigations serve the cached app shell.
        navigateFallback: 'index.html',
        cleanupOutdatedCaches: true,
      },
      devOptions: {
        // Service worker is a production concern; dev stays clean.
        enabled: false,
      },
    }),
  ],
});
