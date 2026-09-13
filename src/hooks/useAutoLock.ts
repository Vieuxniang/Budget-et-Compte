import { useEffect, useRef } from 'react';

const ACTIVITY_EVENTS = ['mousemove', 'mousedown', 'keydown', 'touchstart', 'wheel'] as const;

interface AutoLockOptions {
  /** When true, the timer is suspended (lock screen already up). */
  isLocked: boolean;
  lock: () => void;
  /** Idle minutes before auto-lock; 0 disables the feature. */
  timeoutMinutes: number;
}

/**
 * Locks the session after `timeoutMinutes` without user input.
 * Activity = mouse, keys, touch, scroll, or window focus. While the tab is
 * hidden the timer keeps running, so coming back to a long-idle tab locks
 * immediately instead of exposing data for another full cycle.
 */
export function useAutoLock({ isLocked, lock, timeoutMinutes }: AutoLockOptions): void {
  const lastActivityRef = useRef<number>(Date.now());
  const lockRef = useRef(lock);
  lockRef.current = lock;

  useEffect(() => {
    if (isLocked || timeoutMinutes <= 0) return;

    const timeoutMs = timeoutMinutes * 60_000;
    lastActivityRef.current = Date.now();

    const markActivity = () => {
      lastActivityRef.current = Date.now();
    };
    const checkIdle = () => {
      if (Date.now() - lastActivityRef.current >= timeoutMs) {
        lockRef.current();
      }
    };

    ACTIVITY_EVENTS.forEach((event) =>
      window.addEventListener(event, markActivity, { passive: true })
    );
    window.addEventListener('focus', markActivity);

    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        checkIdle(); // been away too long? lock right away
      } else {
        markActivity(); // baseline at hide; hidden time then counts as idle
      }
    };
    document.addEventListener('visibilitychange', onVisibilityChange);

    const interval = window.setInterval(checkIdle, 15_000);

    return () => {
      ACTIVITY_EVENTS.forEach((event) => window.removeEventListener(event, markActivity));
      window.removeEventListener('focus', markActivity);
      document.removeEventListener('visibilitychange', onVisibilityChange);
      window.clearInterval(interval);
    };
  }, [isLocked, timeoutMinutes]);
}
