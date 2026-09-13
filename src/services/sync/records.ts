/**
 * AppData ⇄ records. The vault keeps its existing shape (`AppData`, four arrays)
 * so backups, migration and the whole UI are untouched by sync; this module is
 * the only place that translates that shape into the record map the engine
 * exchanges.
 *
 * Values are compared with a **canonical stringify** (sorted keys), because a
 * record only counts as changed when its *content* changed: re-saving an equal
 * transaction must not stamp a new clock, otherwise every screen refresh would
 * look like an edit and the two devices would fight over nothing.
 */

import type { Account, BudgetCategory, SavingsGoal, Transaction } from '../../types';
import type { AppData } from '../storage';
import type { RecordId, RecordKind, Stamped } from './types';

/** Kinds that map onto an AppData array. `conflict` deliberately has none. */
const KIND_FIELDS: Partial<Record<RecordKind, keyof AppData>> = {
  account: 'accounts',
  transaction: 'transactions',
  budgetCategory: 'budgetCategories',
  goal: 'goals',
  // The tontine module syncs with no sync-layer code of its own: one entity per
  // record, so two members editing different payments never collide.
  tontine: 'tontineGroups',
  tontineMember: 'tontineMembers',
  tontineRound: 'tontineRounds',
  tontinePayment: 'tontinePayments',
  // Installed content packs: one record per pack, so installing one on a phone
  // shows up on the others without re-downloading anything.
  pack: 'installedPacks',
};

/** Kinds carried in AppData (everything except the conflict archive). */
export const ENTITY_KINDS = Object.keys(KIND_FIELDS) as RecordKind[];

/** Every kind that can appear in a snapshot. */
export const RECORD_KINDS: RecordKind[] = [...ENTITY_KINDS, 'conflict'];

/** Record id of one archived conflict — identity of a ConflictValue. */
export function conflictRecordId(token: string): RecordId {
  return `conflict:${token}`;
}

export function recordId(kind: RecordKind, id: string): RecordId {
  return `${kind}:${id}`;
}

export function splitRecordId(id: RecordId): { kind: RecordKind; entityId: string } | null {
  const at = id.indexOf(':');
  if (at <= 0) return null;
  const kind = id.slice(0, at) as RecordKind;
  if (!RECORD_KINDS.includes(kind)) return null;
  return { kind, entityId: id.slice(at + 1) };
}

/**
 * Deterministic JSON: object keys sorted, so two structurally equal entities
 * always produce the same string regardless of property order.
 */
export function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
}

interface Identified {
  id: string;
}

function entities(data: AppData, kind: RecordKind): Identified[] {
  const field = KIND_FIELDS[kind];
  return field ? ((data[field] ?? []) as Identified[]) : [];
}

/**
 * Flat `RecordId → value` view of the whole app data, conflict archive
 * included: an archived conflict is a record like any other, which is what lets
 * every device see who overwrote what.
 */
export function flatten(data: AppData): Record<RecordId, unknown> {
  const out: Record<RecordId, unknown> = {};
  for (const kind of ENTITY_KINDS) {
    for (const entity of entities(data, kind)) {
      if (!entity || typeof entity.id !== 'string') continue;
      out[recordId(kind, entity.id)] = entity;
    }
  }
  for (const conflict of data.syncConflicts ?? []) {
    // Conflicts carry their record id directly: `conflict:<token>`.
    if (conflict && typeof conflict.id === 'string' && conflict.id.startsWith('conflict:')) {
      out[conflict.id] = conflict;
    }
  }
  return out;
}

/**
 * Rebuilds AppData from records: tombstones and the conflict archive are left
 * out (the engine reads those separately).
 */
export function applyRecords(records: Record<RecordId, Stamped>): AppData {
  const out: AppData = { accounts: [], transactions: [], budgetCategories: [], goals: [] };
  const conflicts: unknown[] = [];
  for (const [id, stamped] of Object.entries(records)) {
    if (stamped.deleted || stamped.value === undefined) continue;
    if (id.startsWith('conflict:')) {
      conflicts.push(stamped.value);
      continue;
    }
    const split = splitRecordId(id);
    if (!split) continue;
    const field = KIND_FIELDS[split.kind];
    if (!field) continue;
    // Optional collections start absent in AppData: create the array on demand,
    // otherwise the first tontine/pack record pulled from a peer would throw.
    const list = (out[field] ??= []) as unknown[];
    list.push(stamped.value);
  }
  if (conflicts.length > 0) out.syncConflicts = conflicts as AppData['syncConflicts'];
  return out;
}

export interface LocalDiff {
  /** Records whose content changed since the last publish. */
  changed: RecordId[];
  /** Records that disappeared from AppData and therefore need a tombstone. */
  removed: RecordId[];
}

/**
 * Compares the current entity values with the last ones this device published.
 * Called on every mutation, so it stays a cheap string comparison per record.
 */
export function diffValues(
  previous: Record<RecordId, unknown>,
  next: Record<RecordId, unknown>
): LocalDiff {
  const changed: RecordId[] = [];
  const removed: RecordId[] = [];
  for (const [id, value] of Object.entries(next)) {
    const before = previous[id];
    if (before === undefined || canonical(before) !== canonical(value)) changed.push(id);
  }
  for (const id of Object.keys(previous)) {
    if (next[id] === undefined) removed.push(id);
  }
  return { changed, removed };
}

/** Counts records still waiting to be sent (a tombstone counts as pending). */
export function pendingCount(
  records: Record<RecordId, Stamped>,
  synced: Record<RecordId, Stamped>
): number {
  let n = 0;
  for (const [id, stamped] of Object.entries(records)) {
    const base = synced[id];
    if (!base || !sameStamp(stamped, base)) n += 1;
  }
  return n;
}

function sameStamp(a: Stamped, b: Stamped): boolean {
  return (
    a.c.ms === b.c.ms && a.c.seq === b.c.seq && a.c.device === b.c.device && Boolean(a.deleted) === Boolean(b.deleted)
  );
}

/** Entity payloads of a snapshot, for tests and for asserting no value leak. */
export function snapshotValues(records: Record<RecordId, Stamped>): Record<RecordId, unknown> {
  const out: Record<RecordId, unknown> = {};
  for (const [id, stamped] of Object.entries(records)) {
    if (!stamped.deleted) out[id] = stamped.value;
  }
  return out;
}

export type { Account, BudgetCategory, SavingsGoal, Transaction };
