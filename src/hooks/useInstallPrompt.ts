import { useEffect, useState } from 'react';
import { onInstallAvailable, promptInstall, isStandalone } from '../services/pwa';

/** Exposes whether the app can be installed and triggers the native dialog. */
export function useInstallPrompt(): { canInstall: boolean; installed: boolean; install: () => void } {
  const [canInstall, setCanInstall] = useState(false);
  const [installed, setInstalled] = useState(isStandalone);

  useEffect(() => {
    const off = onInstallAvailable(setCanInstall);
    const onInstalled = () => setInstalled(true);
    window.addEventListener('appinstalled', onInstalled);
    return () => {
      off();
      window.removeEventListener('appinstalled', onInstalled);
    };
  }, []);

  const install = () => {
    promptInstall();
  };

  return { canInstall, installed, install };
}
