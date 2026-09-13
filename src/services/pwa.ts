/**
 * PWA plumbing built on vite-plugin-pwa.
 *
 * - Service worker registration (production builds only; the plugin injects
 *   a no-op stub for `virtual:pwa-register` in dev).
 * - `registerType: 'prompt'` in vite.config.ts means a new worker WAITS until
 *   the user accepts the in-app update toast — never a silent mid-session swap.
 * - Install-prompt capture (beforeinstallprompt) unchanged.
 */

import type { RegisterSWOptions } from 'vite-plugin-pwa/types';

export interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

type RegisterSW = (options?: RegisterSWOptions) => (reloadPage?: boolean) => Promise<void>;

let applyUpdateFn: (() => Promise<void>) | null = null;
let updatePending = false;
const updateListeners = new Set<(available: boolean) => void>();
const offlineReadyListeners = new Set<(ready: boolean) => void>();

function emitUpdate(available: boolean) {
  updateListeners.forEach((cb) => cb(available));
}

function emitOfflineReady(ready: boolean) {
  offlineReadyListeners.forEach((cb) => cb(ready));
}

/**
 * Registers the service worker on window load. Idempotent; call once from main.tsx.
 * Also used by checkForUpdates() to re-check for a waiting worker.
 */
export function registerPwa(): void {
  if (typeof window === 'undefined' || !('serviceWorker' in navigator)) return;
  window.addEventListener('load', () => {
    import('virtual:pwa-register')
      .then(({ registerSW }) => {
        const options: RegisterSWOptions = {
          immediate: true,
          onNeedRefresh() {
            updatePending = true;
            emitUpdate(true);
          },
          onOfflineReady() {
            emitOfflineReady(true);
          },
          onRegisteredSW(_url, registration) {
            // Remember how to activate the waiting worker once one exists.
            if (registration?.waiting) {
              applyUpdateFn = () => {
                registration.waiting?.postMessage({ type: 'SKIP_WAITING' });
                return Promise.resolve();
              };
            }
          },
        };
        const update = (registerSW as RegisterSW)(options);
        applyUpdateFn = async () => {
          await update(false);
          // Fallback for the brief window before onRegisteredSW ran.
          const reg = await navigator.serviceWorker.getRegistration();
          reg?.waiting?.postMessage({ type: 'SKIP_WAITING' });
        };
      })
      .catch(() => {
        // Offline support is a progressive enhancement; ignore failures.
      });
  });
}

/** Subscribes to "a new version is ready to apply". Returns an unsubscribe fn. */
export function onUpdateAvailable(cb: (available: boolean) => void): () => void {
  updateListeners.add(cb);
  return () => updateListeners.delete(cb);
}

/** Subscribes to "app is cached and works offline". Returns an unsubscribe fn. */
export function onOfflineReady(cb: (ready: boolean) => void): () => void {
  offlineReadyListeners.add(cb);
  return () => offlineReadyListeners.delete(cb);
}

/** Activates the waiting service worker; the controllerchange reload brings the new version up. */
export function applyUpdate(): Promise<void> {
  return applyUpdateFn ? applyUpdateFn() : Promise.resolve();
}

/** Ask the browser to re-check for a newer worker right now. */
export async function checkForUpdates(): Promise<void> {
  if (!('serviceWorker' in navigator)) return;
  const reg = await navigator.serviceWorker.getRegistration();
  await reg?.update();
}

// ---------------------------------------------------------------------------
// Install prompt (unchanged behavior)
// ---------------------------------------------------------------------------

let deferredPrompt: BeforeInstallPromptEvent | null = null;
const installListeners = new Set<(available: boolean) => void>();

export function onInstallAvailable(cb: (available: boolean) => void): () => void {
  installListeners.add(cb);
  cb(deferredPrompt !== null);
  return () => installListeners.delete(cb);
}

function setDeferredPrompt(event: BeforeInstallPromptEvent | null) {
  deferredPrompt = event;
  installListeners.forEach((cb) => cb(event !== null));
}

if (typeof window !== 'undefined') {
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    setDeferredPrompt(e as BeforeInstallPromptEvent);
  });
  window.addEventListener('appinstalled', () => setDeferredPrompt(null));
  // After the user accepts an update, the new worker takes over on
  // controllerchange — reload once so the new version is actually shown.
  navigator.serviceWorker?.addEventListener('controllerchange', () => {
    if (updatePending) {
      updatePending = false;
      window.location.reload();
    }
  });
}

/** Shows the native install dialog; resolves true when the user accepts. */
export async function promptInstall(): Promise<boolean> {
  if (!deferredPrompt) return false;
  await deferredPrompt.prompt();
  const { outcome } = await deferredPrompt.userChoice;
  setDeferredPrompt(null);
  return outcome === 'accepted';
}

/** True when running as an installed app (standalone display). */
export function isStandalone(): boolean {
  return (
    typeof window !== 'undefined' &&
    (window.matchMedia('(display-mode: standalone)').matches ||
      (window.navigator as Navigator & { standalone?: boolean }).standalone === true)
  );
}
