import { describe, expect, it, vi, afterEach } from 'vitest';
import { idleCallback } from './startup';

// The suite runs in the project's node environment — no real `window`. The
// module reads `typeof window` and `window.requestIdleCallback` dynamically, so
// the tests install a fake window object on globalThis to cover each path.
type Ric = (cb: () => void, opts?: { timeout: number }) => number;
type Cir = (id: number) => void;

let idleCbs: Array<() => void> = [];
let cancelledIds: number[] = [];

function installFakeWindow(): void {
  idleCbs = [];
  cancelledIds = [];
  const ric: Ric = (cb) => {
    idleCbs.push(cb);
    return idleCbs.length - 1;
  };
  const cir: Cir = (id) => {
    cancelledIds.push(id);
    // Mirror real semantics: a cancelled callback is never invoked.
    delete idleCbs[id];
  };
  (globalThis as unknown as { window: object }).window = {
    requestIdleCallback: ric,
    cancelIdleCallback: cir,
  };
}

function removeFakeWindow(): void {
  delete (globalThis as unknown as { window?: object }).window;
}

const fireIdle = (i: number) => idleCbs[i]?.();

describe('idleCallback', () => {
  afterEach(removeFakeWindow);

  it('schedules via requestIdleCallback and runs when idle fires', () => {
    installFakeWindow();
    const cb = vi.fn();
    const cancel = idleCallback(cb);
    expect(cb).not.toHaveBeenCalled();
    fireIdle(0);
    expect(cb).toHaveBeenCalledTimes(1);
    expect(cancel).toBeTypeOf('function');
  });

  it('cancel is a no-op after the callback already ran', () => {
    installFakeWindow();
    const cb = vi.fn();
    const cancel = idleCallback(cb);
    fireIdle(0);
    expect(() => cancel()).not.toThrow();
    expect(cb).toHaveBeenCalledTimes(1);
    expect(cancelledIds).toEqual([0]);
  });

  it('cancel before firing prevents the callback', () => {
    installFakeWindow();
    const cb = vi.fn();
    const cancel = idleCallback(cb);
    cancel();
    fireIdle(0);
    expect(cb).not.toHaveBeenCalled();
    expect(cancelledIds).toEqual([0]);
  });

  it('falls back to setTimeout when requestIdleCallback is missing', () => {
    vi.useFakeTimers();
    try {
      installFakeWindow();
      delete (globalThis as unknown as { window: { requestIdleCallback?: Ric } }).window
        .requestIdleCallback;
      const cb = vi.fn();
      idleCallback(cb);
      expect(cb).not.toHaveBeenCalled();
      vi.advanceTimersByTime(5);
      expect(cb).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('runs synchronously without any window (node/SSR)', () => {
    const cb = vi.fn();
    const cancel = idleCallback(cb);
    expect(cb).toHaveBeenCalledTimes(1);
    expect(() => cancel()).not.toThrow();
  });
});
