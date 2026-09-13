/**
 * Deferred startup — non-critical work scheduled off the critical path.
 *
 * The app is interactive before any of this matters: the sync engine cannot
 * do anything until the vault is unlocked (its first real work is open(),
 * which happens after unlock and is handed the key explicitly), and the
 * service worker only gates *later* loads. Both wait for the browser to go
 * idle, so the first paint never pays for them.
 */

type RequestIdle = (cb: () => void, opts?: { timeout: number }) => number;
type CancelIdle = (id: number) => void;

/**
 * Runs `cb` when the browser goes idle (or after `timeoutMs` at the latest —
 * the API's starvation guard). Returns a cancel function: a no-op once `cb`
 * has run, so callers can use it as a React effect cleanup. Without a window
 * (node/SSR) `cb` runs immediately; without requestIdleCallback (older
 * Safari) a setTimeout(1) stands in.
 */
export function idleCallback(cb: () => void, timeoutMs = 2_000): () => void {
  if (typeof window === 'undefined') {
    cb();
    return () => {};
  }
  const w = window as unknown as {
    requestIdleCallback?: RequestIdle;
    cancelIdleCallback?: CancelIdle;
  };
  const ric = w.requestIdleCallback;
  const cir = w.cancelIdleCallback;
  if (ric && cir) {
    const id = ric.call(window, cb, { timeout: timeoutMs });
    return () => cir.call(window, id);
  }
  const id = setTimeout(cb, 1);
  return () => clearTimeout(id);
}
