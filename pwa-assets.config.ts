import { defineConfig } from '@vite-pwa/assets-generator/config';

/**
 * Generates public/icons/*.png from public/icons/icon.svg:
 * pwa-64x64, pwa-192x192, pwa-512x512, maskable-icon-512x512,
 * apple-touch-icon (180) and favicon-96x96.
 * Run via `npm run pwa-assets` whenever the source SVG changes.
 */
export default defineConfig({
  preset: 'minimal-2023',
  images: ['public/icons/icon.svg'],
  output: 'public/icons/',
  background: '#020617',
  themeColor: '#10b981',
});
