import { useCallback, useEffect, useState } from 'react';
import { onUpdateAvailable, onOfflineReady, applyUpdate, checkForUpdates } from '../services/pwa';

/**
 * Exposes the vite-plugin-pwa update lifecycle for the toast UI:
 * - needRefresh: a new service worker is waiting — "Mettre à jour" applies it.
 * - offlineReady: the app is fully cached and works offline (shown once).
 */
export function usePwaUpdate() {
  const [needRefresh, setNeedRefresh] = useState(false);
  const [offlineReady, setOfflineReady] = useState(false);

  useEffect(() => {
    const offUpdate = onUpdateAvailable(setNeedRefresh);
    const offOffline = onOfflineReady(setOfflineReady);
    // Catch a version that shipped while the tab sat open in the background.
    void checkForUpdates();
    return () => {
      offUpdate();
      offOffline();
    };
  }, []);

  const acceptUpdate = useCallback(() => {
    setNeedRefresh(false);
    // SKIP_WAITING → controllerchange → single reload (handled in services/pwa.ts).
    void applyUpdate();
  }, []);

  const dismiss = useCallback(() => {
    setNeedRefresh(false);
    setOfflineReady(false);
  }, []);

  return { needRefresh, offlineReady, acceptUpdate, dismiss };
}
