/**
 * Three-way merge — the heart of "no edit is silently lost".
 *
 * Inputs: the device's own records, the remote records, and the **base** — the
 * stamps as of the last successful exchange. Comparing each side against the
 * base is what separates "the other device edited this" from "we both did":
 *
 *   local == base            → the remote version wins (nothing local to lose)
 *   remote == base           → the local version wins (local edit, plain push)
 *   both moved since base    → genuine conflict
 *   never exchanged (no base)→ first join: the shared copy wins the collision
 *
 * Genuine conflicts are resolved by `compareClocks`, which is a *total order*
 * (ms, then seq, then device id). Every device therefore picks the same winner
 * from the same pair, whatever the arrival order — that is the convergence
 * proof, and it is why this function is pure and order-independent.
 *
 * The losing version is never thrown away: it comes back as a ConflictEntry so
 * the UI can offer it, and the user's choice re-stamps the record and syncs.
 */

import { compareClocks, sameClock } from './clock';
import { canonical } from './records';
import type { Clock, ConflictRecord, ConflictValue, MergeOutcome, RecordId, Snapshot, Stamped } from './types';

export interface MergeInput {
  /** Stamps as of the last successful exchange with this channel. */
  base: Record<RecordId, Clock>;
  local: Snapshot;
  remote: Snapshot;
  /**
   * True when this device has never exchanged with this channel: an install
   * joining an existing family budget should adopt the shared data instead of
   * flooding the user with conflicts against its own demo seed.
   */
  adoptRemote?: boolean;
  /** ISO timestamp recorded on conflict entries ('now' by default). */
  at?: string;
}

function entry(
  target: RecordId,
  winner: 'local' | 'remote',
  kept: Stamped,
  discarded: Stamped,
  reason: ConflictValue['reason'],
  at: string
): ConflictValue {
  return { target, reason, winner, at, kept, discarded };
}

export function mergeSnapshots(input: MergeInput): MergeOutcome {
  const { base, local, remote } = input;
  const at = input.at ?? new Date().toISOString();
  const ids = new Set([...Object.keys(local.records), ...Object.keys(remote.records)]);
  const records: Record<RecordId, Stamped> = {};
  const conflicts: ConflictValue[] = [];
  let pushed = 0;
  let pulled = 0;
  let resolved = 0;

  for (const id of ids) {
    const L = local.records[id];
    const R = remote.records[id];
    const B = base[id];

    // Only one side knows the record: union, no question to ask.
    if (L && !R) {
      records[id] = L;
      pushed += 1;
      continue;
    }
    if (!L && R) {
      records[id] = R;
      pulled += 1;
      continue;
    }
    if (!L || !R) continue;

    // Identical stamp: the very same change, seen twice (idempotent retry).
    if (compareClocks(L.c, R.c) === 0) {
      records[id] = L;
      continue;
    }

    // Different stamps but identical content — two installs that happen to hold
    // the same record (a shared seed, or the same edit typed twice). Nothing was
    // overwritten, so this is NOT a conflict. Adopting the *remote* stamp (rather
    // than the newer of the two) aligns this device's merge base with the relay,
    // so a join costs no write and the next merge cannot mistake the untouched
    // copy for a local edit.
    if (sameContent(L, R)) {
      records[id] = R;
      continue;
    }

    const localMoved = B !== undefined && !sameClock(L.c, B);
    const remoteMoved = B !== undefined && !sameClock(R.c, B);

    if (B !== undefined && !localMoved) {
      records[id] = R;
      pulled += 1;
      continue;
    }
    if (B !== undefined && !remoteMoved) {
      records[id] = L;
      pushed += 1;
      continue;
    }

    // Both sides moved (or this is the first exchange and B is unknown).
    if (input.adoptRemote && B === undefined) {
      records[id] = R;
      resolved += 1;
      conflicts.push(entry(id, 'remote', R, L, 'first-join', at));
      continue;
    }

    const localWins = compareClocks(L.c, R.c) > 0;
    records[id] = localWins ? L : R;
    if (localWins) pushed += 1;
    else pulled += 1;
    resolved += 1;
    conflicts.push(
      entry(id, localWins ? 'local' : 'remote', localWins ? L : R, localWins ? R : L, 'concurrent', at)
    );
  }

  return {
    snapshot: { v: 1, device: local.device, records },
    conflicts,
    pushed,
    pulled,
    resolved,
  };
}

/**
 * Applies a user's choice on a conflict: puts the discarded version back and
 * stamps it with a fresh clock so it wins the next exchange everywhere.
 */
export function restoreConflict(
  records: Record<RecordId, Stamped>,
  conflict: ConflictValue,
  stamp: Clock
): Record<RecordId, Stamped> {
  return { ...records, [conflict.target]: { ...conflict.discarded, c: stamp } };
}

function sameContent(a: Stamped, b: Stamped): boolean {
  if (Boolean(a.deleted) !== Boolean(b.deleted)) return false;
  return canonical(a.value) === canonical(b.value);
}

/**
 * Two devices that both detect the same conflict each archive it, and a record
 * can be contested more than once. The archive is therefore **one row per
 * contested record**, keeping the most recent entry: that is what the user can
 * act on, and what makes "restore" unambiguous.
 */
export function dedupeConflicts(entries: ConflictRecord[]): ConflictRecord[] {
  const byTarget = new Map<RecordId, ConflictRecord>();
  for (const entry of entries) {
    const known = byTarget.get(entry.target);
    if (!known || entry.at > known.at) byTarget.set(entry.target, entry);
  }
  // ISO timestamps sort chronologically as strings: newest entry first.
  return [...byTarget.values()].sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
}

/** Records the base after a successful exchange — the new merge reference. */
export function baseFrom(records: Record<RecordId, Stamped>): Record<RecordId, Clock> {
  const base: Record<RecordId, Clock> = {};
  for (const [id, stamped] of Object.entries(records)) base[id] = stamped.c;
  return base;
}

/** Drops tombstones older than `maxAgeDays` (kept otherwise — see Snapshot). */
export function pruneTombstones(
  records: Record<RecordId, Stamped>,
  now: number,
  maxAgeDays = 180
): Record<RecordId, Stamped> {
  const cutoff = now - maxAgeDays * 24 * 60 * 60 * 1000;
  const out: Record<RecordId, Stamped> = {};
  for (const [id, stamped] of Object.entries(records)) {
    if (stamped.deleted && stamped.c.ms < cutoff) continue;
    out[id] = stamped;
  }
  return out;
}
