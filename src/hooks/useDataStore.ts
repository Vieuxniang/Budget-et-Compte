/**
 * The app's write path as a testable store — extracted from `App.tsx`, where it
 * was a handful of closures guarded only by a typecheck: the suite never ran
 * them, because the app ships no DOM test environment.
 *
 * The invariant it encodes is the one that once dropped data: **one reader, one
 * writer.** All state lives in the store's single `current`; `mutate` reads it
 * synchronously, so a handler can perform several writes in a row and the
 * second sees what the first stored — even though nothing has re-rendered in
 * between. `set` replaces the whole state (unlock, a sync pull), `clear` drops
 * it (lock), and `onPersist` is the single side-effect seam (sync publish +
 * vault write in `App.tsx`) — called once per real write, never when the store
 * was empty (unlocking is population, not a mutation).
 *
 * The factory is plain TypeScript on purpose: its tests run with no React and
 * no DOM. The React binding is the three lines of `useDataStore` below, which
 * hand `subscribe`/`getData` to `useSyncExternalStore`.
 */

import { useSyncExternalStore } from 'react';

export interface DataStore<D> {
  /** Current data, or null while locked. A stable reference between writes. */
  getData: () => D | null;
  /** Subscribe to writes; returns the unsubscribe function. */
  subscribe: (listener: () => void) => () => void;
  /** Replace the whole state — unlock, a sync pull, a backup restore. */
  set: (next: D) => void;
  /** Drop the state — locking the session. */
  clear: () => void;
  /**
   * The only reader of the current data. The change sees exactly what the last
   * write stored — including one made earlier in the same tick — and is a
   * no-op while the store is empty (locked).
   */
  mutate: (change: (current: D) => D) => void;
  /** Bind a pure edit `(data, ...args) => data` to `mutate` — how App.tsx wires services/dataEdits.ts. */
  bindEdit: <Args extends unknown[]>(edit: (data: D, ...args: Args) => D) => (...args: Args) => void;
}

export function createDataStore<D>(options: {
  /** Side effects of a real write; `previous` is the state being replaced. */
  onPersist?: (next: D, previous: D) => void;
} = {}): DataStore<D> {
  const { onPersist } = options;
  let current: D | null = null;
  const listeners = new Set<() => void>();

  const write = (next: D | null) => {
    const previous = current;
    current = next;
    // A write from empty is population (unlock), not a mutation: there is
    // nothing to publish or encrypt — sync and the vault take over after.
    if (next !== null && previous !== null) onPersist?.(next, previous);
    for (const listener of listeners) listener();
  };

  const store: DataStore<D> = {
    getData: () => current,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    set: (next) => write(next),
    clear: () => write(null),
    mutate: (change) => {
      if (current !== null) write(change(current));
    },
    bindEdit: (edit) =>
      (...args) => {
        store.mutate((current) => edit(current, ...args));
      },
  };
  return store;
}

/**
 * React binding: data from the store, re-rendering on every write. The getter
 * is stable (a closure over the store), so React only resubscribes on remount.
 */
export function useDataStore<D>(store: DataStore<D>): D | null {
  return useSyncExternalStore(store.subscribe, store.getData, store.getData);
}
