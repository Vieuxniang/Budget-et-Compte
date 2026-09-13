import { useCallback, useEffect, useState } from 'react';
import {
  getStoredLicense, saveLicense, subscribeLicense, verifyLicenseKey,
  type LicenseState, type Plan,
} from '../services/license';

export interface LicenseController {
  /** Verified state of the stored license (never trusted from storage as-is). */
  state: LicenseState;
  plan: Plan;
  isPro: boolean;
  /** True until the first verification settles — stops the upsell flashing. */
  checking: boolean;
  /**
   * Verifies a key and stores it only when it is valid. A rejected key leaves
   * any license already on the device untouched.
   */
  activate: (key: string) => Promise<LicenseState>;
  /** Forgets the license on this device (the key can be re-entered later). */
  deactivate: () => void;
}

/**
 * Reads, verifies and persists the Pro license. Every component that calls it
 * stays in sync: the store notifies its subscribers whenever the key changes.
 */
export function useLicense(): LicenseController {
  const [state, setState] = useState<LicenseState>({ status: 'free' });
  const [checking, setChecking] = useState(true);

  useEffect(() => {
    let live = true;
    const check = async () => {
      const next = await verifyLicenseKey(getStoredLicense());
      if (!live) return;
      setState(next);
      setChecking(false);
    };
    void check();
    const unsubscribe = subscribeLicense(() => void check());
    return () => {
      live = false;
      unsubscribe();
    };
  }, []);

  const activate = useCallback(async (key: string) => {
    const next = await verifyLicenseKey(key);
    if (next.status === 'active') saveLicense(key);
    return next;
  }, []);

  const deactivate = useCallback(() => saveLicense(null), []);

  const isPro = state.status === 'active';
  return { state, plan: isPro ? 'pro' : 'free', isPro, checking, activate, deactivate };
}
