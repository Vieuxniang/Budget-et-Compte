/**
 * Hybrid logical clock — the ordering primitive behind conflict resolution.
 *
 * A device that has been offline for a week still needs its edits to sort after
 * changes it *did* see and before changes made afterwards elsewhere. Wall-clock
 * time alone cannot do that (phones drift, users change the date), and a purely
 * logical counter cannot do it either (two devices' counters are unrelated).
 * The hybrid clock takes the best of both:
 *
 *   ms  = max(wall clock now, the highest ms this device has ever seen)
 *   seq = 0 when ms moved forward, otherwise previous seq + 1
 *
 * Ordering is then `ms`, then `seq`, then `device` — and the device tie-break is
 * what makes the comparison **total and deterministic**, so two devices that
 * receive the same pair in either order pick the same winner. That is the whole
 * convergence guarantee of the sync engine, and it is why this file has no I/O.
 */

import type { Clock } from './types';

/** Orders two stamps; 0 means "the very same change" (same device, same tick). */
export function compareClocks(a: Clock, b: Clock): number {
  if (a.ms !== b.ms) return a.ms < b.ms ? -1 : 1;
  if (a.seq !== b.seq) return a.seq < b.seq ? -1 : 1;
  if (a.device === b.device) return 0;
  return a.device < b.device ? -1 : 1;
}

export function sameClock(a: Clock, b: Clock | undefined): boolean {
  return b !== undefined && compareClocks(a, b) === 0;
}

/** The later of two stamps (b when they are identical). */
export function maxClock(a: Clock | undefined, b: Clock | undefined): Clock | undefined {
  if (!a) return b;
  if (!b) return a;
  return compareClocks(a, b) >= 0 ? a : b;
}

/**
 * Stamps a local change. `previous` is the record's current stamp when it is
 * being edited (undefined for a creation), `observed` the highest stamp this
 * device has seen anywhere — including from the remote side, so that an edit
 * made after a pull always outranks what was pulled.
 */
export function tick(
  now: number,
  device: string,
  previous?: Clock,
  observed?: Clock
): Clock {
  const highest = maxClock(previous, observed);
  const ms = Math.max(now, highest?.ms ?? 0);
  const seq = highest && highest.ms === ms ? highest.seq + 1 : 0;
  return { ms, seq, device };
}

/** Highest `ms` in a snapshot — used to keep the local clock ahead of remote. */
export function highestMs(clocks: Iterable<Clock | undefined>): number {
  let max = 0;
  for (const c of clocks) {
    if (c && c.ms > max) max = c.ms;
  }
  return max;
}
