/**
 * Sync engine — local-first by construction, and never in the way of an edit.
 *
 * The rules it will not break, each one covered by a test:
 *
 * 1. **A mutation never waits for the network.** The edit goes to the vault
 *    first; the engine only *notices* it (by diffing against the values it
 *    published last) and marks the record pending. Offline is a status, never a
 *    failure of the edit.
 * 2. **Nothing is lost.** A change only leaves the pending set once the relay
 *    has accepted a snapshot *containing* it.
 * 3. **The relay cannot revert a device.** Versions must advance by exactly one
 *    and a blob is bound by AES-GCM AAD to its channel *and* version, so an
 *    older version comes back as a replay refusal instead of quietly restoring
 *    old data.
 * 4. **No secret at rest.** Only stamps (record ids + clocks), the slot version
 *    and a passphrase sealed with the vault key are stored; the record *values*
 *    stay in the encrypted vault, and the sync key exists in memory only while
 *    the vault is unlocked.
 */

import { decryptString, encryptString, fromBase64, toBase64 } from '../crypto';
import type { AppData } from '../storage';
import { compareClocks, highestMs, sameClock, tick } from './clock';
import {
  deriveSyncKeys,
  formatSyncCode,
  newSyncSalt,
  openSnapshot,
  parseSyncCode,
  randomPassphrase,
  sealSnapshot,
  type SyncKeys,
} from './crypto';
import { dedupeConflicts, mergeSnapshots } from './merge';
import { applyRecords, canonical, conflictRecordId, diffValues, flatten, snapshotValues } from './records';
import { httpTransport } from './transport';
import type {
  Clock,
  CipherBlob,
  ConflictRecord,
  MergeOutcome,
  RecordId,
  RemoteSlot,
  Snapshot,
  Stamped,
  SyncProblem,
  SyncStatus,
  SyncTransport,
} from './types';

const STORAGE_KEY = 'patrifamille_sync_v1';
/** How many conflicted versions are kept around (newest first). */
export const ARCHIVE_LIMIT = 50;
const MAX_PUSH_ROUNDS = 3;

/** Stamp without its value — all we persist for a record. */
interface StampOnly {
  c: Clock;
  d?: 1;
}

interface StoredSync {
  v: 1;
  enabled: boolean;
  relayUrl: string;
  saltB64: string;
  /** The sync passphrase, AES-GCM sealed with the vault key. */
  sealed: { iv: string; ct: string } | null;
  device: string;
  version: number;
  etag: string | null;
  remoteVersion: number;
  hasSynced: boolean;
  lastSyncedAt: string | null;
  stamps: Record<RecordId, StampOnly>;
  synced: Record<RecordId, StampOnly>;
}

export interface SyncStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface SyncEngineDeps {
  storage?: SyncStorage;
  now?: () => number;
  transportFor?: (relayUrl: string, keys: SyncKeys) => SyncTransport;
  /** Timers off in tests; on in the app (debounced push, periodic pull). */
  autoSync?: boolean;
  syncDebounceMs?: number;
  syncIntervalMs?: number;
  newDeviceId?: () => string;
}

export interface SyncPublicState {
  status: SyncStatus;
  enabled: boolean;
  relayUrl: string;
  device: string;
  /** Version currently accepted by the relay (0 = nothing pushed yet). */
  version: number;
  channelId: string | null;
  lastSyncedAt: string | null;
  /** Sync is on but the passphrase must be re-entered (vault password changed). */
  needsCode: boolean;
  /** A channel already exists on this device (turning sync back on reuses it). */
  hasSetup: boolean;
  /** Archived conflicts, newest first (deduplicated across devices). */
  archive: ConflictRecord[];
  /** The sync key is in memory: a sync can run. */
  unlocked: boolean;
}

/**
 * `data` is the state to apply locally after the first exchange — joining a
 * channel replaces the local seed with the shared family data, and the caller is
 * the only one allowed to write that to the vault.
 */
export type EnableResult =
  | { ok: true; code: string; data: AppData | null }
  | { ok: false; problem: SyncProblem };

export interface SyncReport {
  status: SyncStatus;
  outcome: MergeOutcome | null;
  /** Non-null only when the local data actually changed (caller applies it). */
  data: AppData | null;
}

function emptySnapshot(device: string): Snapshot {
  return { v: 1, device, records: {} };
}

function stampOnly(stamped: Stamped): StampOnly {
  return stamped.deleted ? { c: stamped.c, d: 1 } : { c: stamped.c };
}

function freshDeviceId(): string {
  return freshToken(6);
}

/** Random hexadecimal token — device ids and conflict record ids. */
function freshToken(bytes = 8): string {
  const random = crypto.getRandomValues(new Uint8Array(bytes));
  return Array.from(random)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/** True when the merged snapshot holds something the relay does not have yet. */
function needsPush(merged: Snapshot, remote: Snapshot): boolean {
  for (const [id, stamped] of Object.entries(merged.records)) {
    const other = remote.records[id];
    if (!other || compareClocks(other.c, stamped.c) !== 0) return true;
  }
  return false;
}

function memoryStorage(): SyncStorage {
  const map = new Map<string, string>();
  return {
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => void map.set(key, value),
    removeItem: (key) => void map.delete(key),
  };
}

export class SyncEngine {
  private storage: SyncStorage;
  private now: () => number;
  private transportFor: (relayUrl: string, keys: SyncKeys) => SyncTransport;
  private autoSync: boolean;
  private syncDebounceMs: number;
  private syncIntervalMs: number;
  private newDeviceId: () => string;

  private config: StoredSync | null = null;
  private deviceId: string;
  private keys: SyncKeys | null = null;
  private passphrase: string | null = null;
  private vaultKey: CryptoKey | null = null;
  private values: Record<RecordId, unknown> = {};
  private observedMs = 0;
  private status: SyncStatus = { kind: 'off' };
  private needsCode = false;
  private listeners = new Set<() => void>();
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private intervalTimer: ReturnType<typeof setInterval> | null = null;
  private syncing: Promise<SyncReport> | null = null;

  constructor(deps: SyncEngineDeps = {}) {
    this.storage = deps.storage ?? (typeof localStorage === 'undefined' ? memoryStorage() : localStorage);
    this.now = deps.now ?? (() => Date.now());
    this.transportFor = deps.transportFor ?? ((relayUrl, keys) => httpTransport({
      url: relayUrl,
      channelId: keys.channelId,
      writeToken: keys.writeToken,
    }));
    this.autoSync = deps.autoSync ?? true;
    this.syncDebounceMs = deps.syncDebounceMs ?? 1_500;
    this.syncIntervalMs = deps.syncIntervalMs ?? 45_000;
    this.newDeviceId = deps.newDeviceId ?? freshDeviceId;
    this.config = this.readConfig();
    this.deviceId = this.config?.device ?? this.newDeviceId();
    this.observedMs = highestMs(Object.values(this.config?.stamps ?? {}).map((s) => s.c));
  }

  // -------------------------------------------------------------------------
  // Persisted configuration
  // -------------------------------------------------------------------------

  private readConfig(): StoredSync | null {
    const raw = this.storage.getItem(STORAGE_KEY);
    if (!raw) return null;
    try {
      const parsed = JSON.parse(raw) as StoredSync;
      if (!parsed || parsed.v !== 1 || typeof parsed.relayUrl !== 'string') return null;
      return {
        ...parsed,
        device: typeof parsed.device === 'string' && parsed.device ? parsed.device : this.newDeviceId(),
        stamps: parsed.stamps ?? {},
        synced: parsed.synced ?? {},
        version: typeof parsed.version === 'number' ? parsed.version : 0,
        remoteVersion: typeof parsed.remoteVersion === 'number' ? parsed.remoteVersion : 0,
        etag: typeof parsed.etag === 'string' ? parsed.etag : null,
        hasSynced: Boolean(parsed.hasSynced),
        lastSyncedAt: typeof parsed.lastSyncedAt === 'string' ? parsed.lastSyncedAt : null,
      };
    } catch {
      return null;
    }
  }

  private persist(): void {
    if (!this.config) {
      this.storage.removeItem(STORAGE_KEY);
      return;
    }
    this.storage.setItem(STORAGE_KEY, JSON.stringify({ ...this.config, device: this.deviceId }));
  }

  private blankConfig(): StoredSync {
    return {
      v: 1,
      enabled: false,
      relayUrl: '',
      saltB64: '',
      sealed: null,
      device: this.deviceId,
      version: 0,
      etag: null,
      remoteVersion: 0,
      hasSynced: false,
      lastSyncedAt: null,
      stamps: {},
      synced: {},
    };
  }

  // -------------------------------------------------------------------------
  // Subscriptions
  // -------------------------------------------------------------------------

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private notify(): void {
    this.listeners.forEach((listener) => listener());
  }

  private setStatus(status: SyncStatus): void {
    this.status = status;
    this.notify();
  }

  private setProblem(problem: SyncProblem): void {
    this.setStatus({ kind: 'problem', problem, pending: this.pending() });
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  /**
   * Called on unlock: unseals the passphrase with the vault key and takes the
   * first snapshot of the data. Sync stays inert ('locked') until then. Returns
   * the report of the first exchange, if one ran.
   */
  async open(input: { vaultKey: CryptoKey; data: AppData }): Promise<SyncReport | null> {
    this.vaultKey = input.vaultKey;
    this.values = flatten(input.data);
    const config = this.config;

    if (config) {
      if (config.enabled && config.sealed) {
        try {
          this.passphrase = await decryptString(this.vaultKey, {
            iv: fromBase64(config.sealed.iv),
            ciphertext: fromBase64(config.sealed.ct),
          });
          this.keys = await deriveSyncKeys(this.passphrase, config.saltB64);
          this.needsCode = false;
        } catch {
          // The vault password changed: the sealed passphrase cannot be opened
          // any more. Ask for the sync code again instead of failing forever.
          this.passphrase = null;
          this.keys = null;
          this.needsCode = true;
        }
      } else if (config.enabled) {
        this.keys = null;
        this.needsCode = true;
      }
      // Records with no stamp yet (first run on this device) are new here.
      if (Object.keys(this.values).some((id) => !config.stamps[id])) {
        this.stampMissing();
        this.persist();
      }
    }

    if (config?.enabled) {
      this.startTimers();
      if (this.keys) {
        const report = await this.sync();
        this.notify();
        return report;
      }
      this.status = { kind: 'locked' };
    } else {
      this.status = { kind: 'off' };
    }
    this.notify();
    return null;
  }

  /** Called on lock: the sync key, the passphrase and the snapshot leave memory. */
  close(): void {
    this.stopTimers();
    this.keys = null;
    this.passphrase = null;
    this.vaultKey = null;
    this.values = {};
    this.status = this.config?.enabled ? { kind: 'locked' } : { kind: 'off' };
    this.notify();
  }

  private startTimers(): void {
    if (!this.autoSync || this.intervalTimer) return;
    this.intervalTimer = setInterval(() => {
      if (this.config?.enabled && this.keys && !this.syncing) void this.sync();
    }, this.syncIntervalMs);
  }

  private stopTimers(): void {
    if (this.intervalTimer) clearInterval(this.intervalTimer);
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.intervalTimer = null;
    this.debounceTimer = null;
  }

  // -------------------------------------------------------------------------
  // Local changes
  // -------------------------------------------------------------------------

  /**
   * Called on every mutation (App.persist). Never touches the network: it
   * stamps what changed and schedules a background sync.
   */
  publish(data: AppData): void {
    const next = flatten(data);
    const { changed, removed } = diffValues(this.values, next);
    const config = this.config;
    if (!config) {
      // Sync was never set up: just remember the values, so that enabling it
      // later does not look like every record changed at once.
      this.values = next;
      return;
    }
    if (changed.length === 0 && removed.length === 0) return;

    const now = this.now();
    for (const id of changed) {
      const stamp = tick(now, this.deviceId, config.stamps[id]?.c, this.observed());
      config.stamps[id] = { c: stamp };
      this.observedMs = Math.max(this.observedMs, stamp.ms);
    }
    for (const id of removed) {
      const stamp = tick(now, this.deviceId, config.stamps[id]?.c, this.observed());
      config.stamps[id] = { c: stamp, d: 1 };
      this.observedMs = Math.max(this.observedMs, stamp.ms);
    }
    this.values = next;
    this.persist();
    this.setStatus({ kind: 'idle', pending: this.pending() });
    this.scheduleSync();
  }

  /** Stamps records that have no stamp yet (first setup on this device). */
  private stampMissing(): void {
    const config = this.config;
    if (!config) return;
    const now = this.now();
    for (const id of Object.keys(this.values)) {
      if (config.stamps[id]) continue;
      const stamp = tick(now, this.deviceId, undefined, this.observed());
      config.stamps[id] = { c: stamp };
      this.observedMs = Math.max(this.observedMs, stamp.ms);
    }
  }

  private scheduleSync(): void {
    if (!this.autoSync || !this.config?.enabled || !this.keys) return;
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      void this.sync();
    }, this.syncDebounceMs);
  }

  private observed(): Clock | undefined {
    return this.observedMs > 0 ? { ms: this.observedMs, seq: 0, device: this.deviceId } : undefined;
  }

  /** Records still waiting to be accepted by the relay. */
  pending(): number {
    const config = this.config;
    if (!config) return 0;
    let n = 0;
    for (const [id, stamp] of Object.entries(config.stamps)) {
      const base = config.synced[id];
      if (
        !base ||
        base.c.ms !== stamp.c.ms ||
        base.c.seq !== stamp.c.seq ||
        base.c.device !== stamp.c.device ||
        Boolean(base.d) !== Boolean(stamp.d)
      ) {
        n += 1;
      }
    }
    return n;
  }

  private localSnapshot(): Snapshot {
    const records: Record<RecordId, Stamped> = {};
    for (const [id, stamp] of Object.entries(this.config?.stamps ?? {})) {
      if (stamp.d) records[id] = { c: stamp.c, deleted: true };
      else if (this.values[id] !== undefined) records[id] = { c: stamp.c, value: this.values[id] };
    }
    return { v: 1, device: this.deviceId, records };
  }

  private baseClocks(): Record<RecordId, Clock> {
    const base: Record<RecordId, Clock> = {};
    for (const [id, stamp] of Object.entries(this.config?.synced ?? {})) base[id] = stamp.c;
    return base;
  }

  // -------------------------------------------------------------------------
  // Setup: create or join a channel
  // -------------------------------------------------------------------------

  /**
   * Turns sync on. Three cases, in order:
   *   - a `code` was given      → join that channel;
   *   - a setup already exists  → resume it (the sealed phrase is reused, so the
   *     device keeps its channel and its pending changes);
   *   - otherwise               → create a new channel and return its code.
   */
  async enable(input: { relayUrl: string; code?: string; fresh?: boolean }): Promise<EnableResult> {
    if (!this.vaultKey) {
      this.setStatus({ kind: 'locked' });
      return { ok: false, problem: 'locked' };
    }
    const relayUrl = input.relayUrl.trim().replace(/\/+$/, '');
    if (!/^https?:\/\/.+/i.test(relayUrl)) {
      this.setProblem('relay');
      return { ok: false, problem: 'relay' };
    }

    if (!input.code?.trim() && !input.fresh && this.config?.sealed) {
      return this.resume(relayUrl);
    }

    let saltB64: string;
    let passphrase: string;
    if (input.code && input.code.trim()) {
      const parsed = parseSyncCode(input.code);
      if (!parsed) {
        this.setProblem('corrupt');
        return { ok: false, problem: 'corrupt' };
      }
      saltB64 = parsed.saltB64;
      passphrase = parsed.passphrase;
    } else {
      saltB64 = newSyncSalt();
      passphrase = randomPassphrase();
    }

    const sealed = await encryptString(this.vaultKey, passphrase);
    this.config = {
      ...(this.config ?? this.blankConfig()),
      enabled: true,
      relayUrl,
      saltB64,
      sealed: { iv: toBase64(sealed.iv), ct: toBase64(sealed.ciphertext) },
      // No history on a fresh channel: every record is stamped and pushed, and
      // the first exchange adopts whatever the relay already holds.
      version: 0,
      etag: null,
      remoteVersion: 0,
      hasSynced: false,
      synced: {},
    };
    this.keys = await deriveSyncKeys(passphrase, saltB64);
    this.passphrase = passphrase;
    this.needsCode = false;
    this.stampMissing();
    this.persist();
    this.setStatus({ kind: 'idle', pending: this.pending() });
    this.startTimers();
    const report = await this.sync();
    return { ok: true, code: formatSyncCode(saltB64, passphrase), data: report.data };
  }

  /**
   * Turns sync back on with the channel already on this device — no code to
   * re-enter, and any local change made while it was off is still pending.
   */
  private async resume(relayUrl: string): Promise<EnableResult> {
    const config = this.config;
    if (!config?.sealed || !this.vaultKey) return { ok: false, problem: 'locked' };
    try {
      const passphrase = await decryptString(this.vaultKey, {
        iv: fromBase64(config.sealed.iv),
        ciphertext: fromBase64(config.sealed.ct),
      });
      this.passphrase = passphrase;
      this.keys = await deriveSyncKeys(passphrase, config.saltB64);
    } catch {
      this.needsCode = true;
      this.setStatus({ kind: 'locked' });
      return { ok: false, problem: 'locked' };
    }
    config.relayUrl = relayUrl;
    config.enabled = true;
    this.needsCode = false;
    this.persist();
    this.setStatus({ kind: 'idle', pending: this.pending() });
    this.startTimers();
    const report = await this.sync();
    return { ok: true, code: formatSyncCode(config.saltB64, this.passphrase), data: report.data };
  }

  /** Stops syncing but keeps the setup (re-enabling needs no code re-entry). */
  disable(): void {
    if (!this.config) return;
    this.config.enabled = false;
    this.keys = null;
    this.passphrase = null;
    this.stopTimers();
    this.persist();
    this.status = { kind: 'off' };
    this.notify();
  }

  /** Forgets the channel entirely (code, stamps, version, archive). */
  forget(): void {
    this.keys = null;
    this.passphrase = null;
    this.config = null;
    this.needsCode = false;
    this.stopTimers();
    this.persist();
    this.status = { kind: 'off' };
    this.notify();
  }

  /** The sync code, to carry to another device. Null until unlocked. */
  revealCode(): string | null {
    const config = this.config;
    if (!config?.sealed || !this.passphrase) return null;
    return formatSyncCode(config.saltB64, this.passphrase);
  }

  // -------------------------------------------------------------------------
  // The synchronization itself
  // -------------------------------------------------------------------------

  state(): SyncPublicState {
    return {
      status: this.status,
      enabled: Boolean(this.config?.enabled),
      relayUrl: this.config?.relayUrl ?? '',
      device: this.deviceId,
      version: this.config?.version ?? 0,
      channelId: this.keys?.channelId ?? null,
      lastSyncedAt: this.config?.lastSyncedAt ?? null,
      needsCode: this.needsCode,
      hasSetup: Boolean(this.config?.sealed),
      archive: this.conflicts(),
      unlocked: Boolean(this.keys),
    };
  }

  /**
   * Pull → merge → push. Concurrent calls share one run. A 409 (another device
   * pushed first) is not an error: re-pull, re-merge, retry, bounded.
   */
  sync(): Promise<SyncReport> {
    if (this.syncing) return this.syncing;
    this.syncing = this.runSync().finally(() => {
      this.syncing = null;
    });
    return this.syncing;
  }

  private async runSync(): Promise<SyncReport> {
    const config = this.config;
    if (!config?.enabled) {
      this.setStatus({ kind: 'off' });
      return { status: this.status, outcome: null, data: null };
    }
    if (!this.keys) {
      this.setStatus({ kind: 'locked' });
      return { status: this.status, outcome: null, data: null };
    }

    const transport = this.transportFor(config.relayUrl, this.keys);
    this.setStatus({ kind: 'syncing', pending: this.pending() });

    let remote: RemoteSlot;
    try {
      remote = await transport.pull();
    } catch {
      this.setStatus({ kind: 'offline', pending: this.pending() });
      return { status: this.status, outcome: null, data: null };
    }

    for (let round = 0; round < MAX_PUSH_ROUNDS; round += 1) {
      let remoteSnapshot = emptySnapshot(this.deviceId);
      if (remote.blob) {
        const opened = await openSnapshot(this.keys, remote.version, remote.blob);
        if (!opened) {
          // Wrong code, or the blob was altered in transit or at rest.
          this.setProblem('corrupt');
          return { status: this.status, outcome: null, data: null };
        }
        remoteSnapshot = opened;
      } else if (remote.version > config.remoteVersion) {
        // A newer version with no payload: the relay lost the blob.
        this.setProblem('corrupt');
        return { status: this.status, outcome: null, data: null };
      }
      if (remote.version < config.remoteVersion) {
        // Replay of an older version: refuse rather than revert this device.
        this.setProblem('rollback');
        return { status: this.status, outcome: null, data: null };
      }

      const outcome = this.archiveConflicts(
        mergeSnapshots({
          base: this.baseClocks(),
          local: this.localSnapshot(),
          remote: remoteSnapshot,
          adoptRemote: !config.hasSynced,
          at: new Date(this.now()).toISOString(),
        })
      );
      this.observedMs = Math.max(
        this.observedMs,
        highestMs(Object.values(outcome.snapshot.records).map((r) => r.c))
      );
      const locallyChanged = this.wouldChangeLocally(outcome.snapshot);

      if (!needsPush(outcome.snapshot, remoteSnapshot)) {
        await this.commit(outcome, remote.version, remote.etag);
        return this.finish(outcome, locallyChanged);
      }

      const version = remote.version + 1;
      let blob: CipherBlob;
      try {
        blob = await sealSnapshot(this.keys, version, outcome.snapshot);
      } catch {
        this.setProblem('relay');
        return { status: this.status, outcome: null, data: null };
      }

      let result;
      try {
        result = await transport.push(remote.etag, version, blob);
      } catch {
        // Local-first: the stamps stay pending and the next attempt retries.
        this.setStatus({ kind: 'offline', pending: this.pending() });
        return { status: this.status, outcome: null, data: null };
      }
      if (result.ok) {
        await this.commit(outcome, version, result.etag ?? `rev-${version}`);
        return this.finish(outcome, locallyChanged);
      }
      if (!result.current) {
        this.setProblem('relay');
        return { status: this.status, outcome: null, data: null };
      }
      // Another device won the race: merge against what it wrote, then retry.
      remote = result.current;
    }

    this.setProblem('relay');
    return { status: this.status, outcome: null, data: null };
  }

  private wouldChangeLocally(snapshot: Snapshot): boolean {
    const next = snapshotValues(snapshot.records);
    for (const [id, value] of Object.entries(next)) {
      if (canonical(value) !== canonical(this.values[id])) return true;
    }
    return Object.keys(this.values).some((id) => next[id] === undefined);
  }

  /** Records the exchange: stamps, base, version, and the conflict archive. */
  private async commit(outcome: MergeOutcome, version: number, etag: string | null): Promise<void> {
    const config = this.config;
    if (!config) return;
    const stamps: Record<RecordId, StampOnly> = {};
    for (const [id, stamped] of Object.entries(outcome.snapshot.records)) {
      stamps[id] = stampOnly(stamped);
    }
    config.stamps = stamps;
    config.synced = { ...stamps };
    config.version = Math.max(config.version, version);
    config.etag = etag;
    config.remoteVersion = Math.max(config.remoteVersion, version);
    config.hasSynced = true;
    config.lastSyncedAt = new Date(this.now()).toISOString();
    this.values = snapshotValues(outcome.snapshot.records);
    this.persist();
    this.status = {
      kind: 'synced',
      at: config.lastSyncedAt,
      version: config.version,
      pending: this.pending(),
    };
  }

  private finish(outcome: MergeOutcome, locallyChanged: boolean): SyncReport {
    this.notify();
    return {
      status: this.status,
      outcome,
      data: locallyChanged ? applyRecords(outcome.snapshot.records) : null,
    };
  }

  // -------------------------------------------------------------------------
  // Conflict archive
  //
  // A conflict that both devices detect would be archived twice (each side mints
  // its own record id), so the archive is deduplicated by target + discarded
  // stamp. Entries are ordinary records: they sync, they survive a wipe of the
  // relay, and every device sees whose edit was overwritten.
  // -------------------------------------------------------------------------

  /** New conflicts are inserted into the snapshot that is about to be pushed. */
  private archiveConflicts(outcome: MergeOutcome): MergeOutcome {
    if (outcome.conflicts.length === 0) return outcome;
    const snapshot: Snapshot = { ...outcome.snapshot, records: { ...outcome.snapshot.records } };
    const known = dedupeConflicts(
      Object.values(snapshot.records)
        .filter((stamped) => stamped.value && (stamped.value as ConflictRecord).target)
        .map((stamped) => stamped.value as ConflictRecord)
    );
    for (const conflict of outcome.conflicts) {
      const duplicate = known.some(
        (entry) => entry.target === conflict.target && sameClock(entry.discarded.c, conflict.discarded.c)
      );
      if (duplicate) continue;
      const id = conflictRecordId(freshToken());
      const stamp = tick(this.now(), this.deviceId, undefined, this.observed());
      snapshot.records[id] = { c: stamp, value: { id, ...conflict } };
      this.observedMs = Math.max(this.observedMs, stamp.ms);
    }
    return { ...outcome, snapshot };
  }

  /** Archived conflicts, newest first. */
  private conflicts(): ConflictRecord[] {
    const entries: ConflictRecord[] = [];
    for (const [id, value] of Object.entries(this.values)) {
      if (!id.startsWith('conflict:')) continue;
      const record = value as ConflictRecord;
      if (record && typeof record.target === 'string') entries.push(record);
    }
    return dedupeConflicts(entries);
  }

  /** Keeps only what the UI shows, dropping the oldest entries for good. */
  async trimConflicts(limit: number = ARCHIVE_LIMIT): Promise<void> {
    const entries = this.conflicts();
    if (entries.length <= limit) return;
    for (const entry of entries.slice(limit)) await this.tombstone(entry.id);
  }

  /** Marks a record as deleted, locally, and schedules the push. */
  private async tombstone(id: RecordId): Promise<void> {
    const config = this.config;
    if (!config) return;
    config.stamps[id] = {
      c: tick(this.now(), this.deviceId, config.stamps[id]?.c, this.observed()),
      d: 1,
    };
    delete this.values[id];
    this.persist();
    this.setStatus({ kind: 'idle', pending: this.pending() });
    this.scheduleSync();
  }

  /**
   * Puts a discarded version back — stamped with a fresh clock so it wins
   * everywhere — and retires the archive entry. Returns the new AppData for the
   * caller to persist (null when nothing was restored).
   */
  async restore(id: RecordId): Promise<AppData | null> {
    const config = this.config;
    const record = this.values[id] as ConflictRecord | undefined;
    if (!config || !record || !id.startsWith('conflict:')) return null;
    const stamp = tick(this.now(), this.deviceId, config.stamps[record.target]?.c, this.observed());
    this.observedMs = Math.max(this.observedMs, stamp.ms);
    if (record.discarded.deleted) {
      // The discarded side was a deletion: honour it as a real one.
      config.stamps[record.target] = { c: stamp, d: 1 };
      delete this.values[record.target];
    } else {
      config.stamps[record.target] = { c: stamp };
      this.values[record.target] = record.discarded.value;
    }
    await this.resolveConflict(record.target);
    await this.sync();
    return applyRecords(this.localSnapshot().records);
  }

  /** Drops the archived conflict about `target`, without restoring anything. */
  async dismiss(id: RecordId): Promise<void> {
    const record = this.values[id] as ConflictRecord | undefined;
    if (!record) return;
    await this.resolveConflict(record.target);
  }

  /** Empties the archive (the kept versions are already in place). */
  async clearConflicts(): Promise<void> {
    for (const entry of this.conflicts()) await this.tombstone(entry.id);
  }

  /**
   * Retires every archive entry about one record. There can be several — each
   * device archives the clash it resolves, and a record can be contested more
   * than once — but they all describe the same decision, so they go together.
   */
  private async resolveConflict(target: RecordId): Promise<void> {
    for (const [id, value] of Object.entries(this.values)) {
      if (!id.startsWith('conflict:')) continue;
      if ((value as ConflictRecord)?.target === target) await this.tombstone(id);
    }
  }

  /**
   * Escape hatch for a relay that lost its data (or a deliberate reset): forget
   * the version tracking so the next sync re-publishes everything.
   */
  async resetRemote(): Promise<void> {
    const config = this.config;
    if (!config) return;
    config.version = 0;
    config.etag = null;
    config.remoteVersion = 0;
    config.synced = {};
    this.persist();
    await this.sync();
  }
}
