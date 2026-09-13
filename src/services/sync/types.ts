/**
 * Multi-device sync — shared vocabulary.
 *
 * The unit of synchronization is a *record*: one entity (account, transaction,
 * budget category, goal) identified by `kind:entityId`. A record carries a
 * **hybrid logical clock** stamp instead of a wall-clock date, because devices
 * disagree on time and a family phone may sit offline for days: the clock is
 * `max(local time, last stamped time)` plus a per-device sequence, which makes
 * concurrent edits comparable without trusting any clock.
 *
 * Nothing here knows about encryption or transport — this module is pure data.
 */

/**
 * Record kinds. The first four mirror AppData; `conflict` carries the archive of
 * overwritten versions. Conflicts travel as ordinary records on purpose: the
 * device that *loses* an edit would otherwise never learn that it happened.
 */
export type RecordKind =
  | 'account'
  | 'transaction'
  | 'budgetCategory'
  | 'goal'
  | 'tontine'
  | 'tontineMember'
  | 'tontineRound'
  | 'tontinePayment'
  | 'pack'
  | 'conflict';

/** `kind:entityId` — namespacing keeps ids from colliding across kinds. */
export type RecordId = string;

export interface Clock {
  /** Milliseconds on the stamping device's clock (informational on others). */
  ms: number;
  /** Per-device sequence, incremented when several edits share the same ms. */
  seq: number;
  /** Device that stamped the change — the deterministic tie-break. */
  device: string;
}

/**
 * One record as it travels. A deletion is NOT an absence: it is a *tombstone*
 * (same id, `deleted: true`). Without it a device that was offline during the
 * deletion would resurrect the record on its next sync.
 */
export interface Stamped {
  c: Clock;
  deleted?: true;
  /** Entity payload; absent on tombstones. */
  value?: unknown;
}

export interface Snapshot {
  v: 1;
  /** Device that produced this snapshot. */
  device: string;
  records: Record<RecordId, Stamped>;
}

/** Why two versions of the same record both survived to be compared. */
export type ConflictReason =
  /** Both devices changed the record since the last shared exchange. */
  | 'concurrent'
  /** First exchange on this device: the shared copy replaced the local one. */
  | 'first-join';

/**
 * A discarded version, kept so nothing disappears silently: the user can put it
 * back from Réglages → Synchronisation, and that choice then syncs like any
 * other edit — every device ends up with the same archive.
 *
 * Stored as the value of a `conflict:<uuid>` record, so the identity of an entry
 * is its record id and the contested record is `target`.
 */
export interface ConflictValue {
  /** The record this conflict is about. */
  target: RecordId;
  reason: ConflictReason;
  /** Which side was kept. */
  winner: 'local' | 'remote';
  at: string;
  kept: Stamped;
  discarded: Stamped;
}

/**
 * An archived conflict as it is stored in AppData (`syncConflicts`): its own
 * `id` is the record id (`conflict:<token>`), which is what makes it durable —
 * the envelope stays in the encrypted vault, so the archive is readable offline
 * and survives a relay that vanished.
 */
export interface ConflictRecord extends ConflictValue {
  id: RecordId;
}

export interface MergeOutcome {
  snapshot: Snapshot;
  conflicts: ConflictValue[];
  /** Records only this device had (sent to the relay). */
  pushed: number;
  /** Records only the other device had (adopted here). */
  pulled: number;
  /** Records both had, resolved in favour of one side. */
  resolved: number;
}

/** Raw remote slot, before decryption. The relay only ever sees this shape. */
export interface RemoteSlot {
  /** Monotonic version; 0 means "channel never written". */
  version: number;
  /** Opaque revision token; `null` while the channel is empty. */
  etag: string | null;
  /** AES-GCM ciphertext — the only thing the server stores. */
  blob: CipherBlob | null;
}

/** Ciphertext + IV, base64. Contains no readable field, not even an id. */
export interface CipherBlob {
  v: 1;
  iv: string;
  ct: string;
}

export interface PushResult {
  ok: boolean;
  /** Present on success: the new revision token. */
  etag?: string;
  /** Present on refusal (409): the slot as it stands, to merge and retry. */
  current?: RemoteSlot;
}

/**
 * Any store able to hold one opaque, versioned blob per channel. The relay is
 * intentionally stupid: it cannot decrypt, cannot merge, and cannot invent a
 * version. Swap it for S3/R2/Supabase later without touching the engine.
 */
export interface SyncTransport {
  pull(): Promise<RemoteSlot>;
  /** `expectEtag` null means "the channel must still be empty". */
  push(expectEtag: string | null, version: number, blob: CipherBlob): Promise<PushResult>;
}

/**
 * Non-transient failures, as codes: the UI translates them (fr/en/es), which is
 * why the engine never formats a user-facing sentence itself.
 */
export type SyncProblem =
  /** The relay answered, but refused the write for another reason than a race. */
  | 'relay'
  /** The slot could not be decrypted: wrong code, or the blob was altered. */
  | 'corrupt'
  /** The relay offered an older version than one already seen (replay). */
  | 'rollback'
  /** Sync is enabled but the vault is locked, so the keys are not available. */
  | 'locked';

/** Result of one synchronization attempt, for the UI and for the tests. */
export type SyncStatus =
  | { kind: 'off' }
  | { kind: 'locked' }
  | { kind: 'idle'; pending: number }
  | { kind: 'syncing'; pending: number }
  | { kind: 'synced'; at: string; version: number; pending: number }
  /** Network unreachable — transient; changes stay local and are retried. */
  | { kind: 'offline'; pending: number }
  | { kind: 'problem'; problem: SyncProblem; pending: number };

export interface SyncReport {
  status: SyncStatus;
  outcome: MergeOutcome | null;
}
