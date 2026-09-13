/**
 * The sync core is pure, so it is tested without any network, storage or DOM:
 * clock ordering, record flattening, and the three-way merge that decides who
 * wins — including the convergence property that makes multi-device sync safe.
 */

import { describe, expect, it } from 'vitest';
import { compareClocks, highestMs, maxClock, sameClock, tick } from './clock';
import { applyRecords, canonical, diffValues, flatten, recordId, splitRecordId, snapshotValues } from './records';
import { baseFrom, mergeSnapshots, pruneTombstones, restoreConflict } from './merge';
import type { Clock, Snapshot, Stamped } from './types';
import { initialData } from '../storage';
import type { AppData } from '../storage';

const clock = (ms: number, seq = 0, device = 'a'): Clock => ({ ms, seq, device });

function snapshot(device: string, records: Record<string, Stamped>): Snapshot {
  return { v: 1, device, records };
}

function data(overrides: Partial<AppData> = {}): AppData {
  return { ...initialData(), ...overrides };
}

describe('hybrid logical clock', () => {
  it('never goes backwards, even when the local clock does', () => {
    const previous = clock(5_000, 0, 'a');
    const next = tick(1_000, 'a', previous);
    expect(next.ms).toBe(5_000);
    expect(next.seq).toBe(1);
  });

  it('uses wall time and resets the sequence when it moves forward', () => {
    expect(tick(9_000, 'a', clock(5_000, 3, 'a'))).toEqual({ ms: 9_000, seq: 0, device: 'a' });
  });

  it('borrows the highest stamp seen anywhere, so a post-pull edit wins', () => {
    const remote = clock(50_000, 4, 'b');
    const next = tick(1_000, 'a', clock(2_000, 0, 'a'), remote);
    expect(next.ms).toBe(50_000);
    expect(next.seq).toBe(5);
  });

  it('orders by ms, then sequence, then device', () => {
    expect(compareClocks(clock(1), clock(2))).toBeLessThan(0);
    expect(compareClocks(clock(2), clock(2, 1))).toBeLessThan(0);
    expect(compareClocks(clock(2, 0, 'a'), clock(2, 0, 'b'))).toBeLessThan(0);
    expect(compareClocks(clock(2, 0, 'b'), clock(2, 0, 'b'))).toBe(0);
    expect(sameClock(clock(2, 0, 'b'), clock(2, 0, 'b'))).toBe(true);
    expect(sameClock(clock(2, 0, 'b'), undefined)).toBe(false);
  });

  it('is a total, antisymmetric order (a tie-break no device can dispute)', () => {
    const samples = [clock(1, 0, 'a'), clock(1, 1, 'a'), clock(2, 0, 'a'), clock(2, 0, 'z'), clock(2, 1, 'a')];
    for (const a of samples) {
      for (const b of samples) {
        const forward = Math.sign(compareClocks(a, b));
        const backward = Math.sign(compareClocks(b, a));
        expect(forward + backward).toBe(0);
      }
    }
  });

  it('keeps the maximum and reports the highest ms', () => {
    expect(maxClock(clock(1), clock(3))).toEqual(clock(3));
    expect(maxClock(undefined, clock(3))).toEqual(clock(3));
    expect(highestMs([clock(1), undefined, clock(9)])).toBe(9);
  });
});

describe('records', () => {
  it('round-trips AppData through the record map', () => {
    const source = data();
    const rebuilt = applyRecords(
      Object.fromEntries(Object.entries(flatten(source)).map(([id, value]) => [id, { c: clock(1), value }]))
    );
    expect(rebuilt.accounts).toHaveLength(source.accounts.length);
    expect(rebuilt.transactions).toHaveLength(source.transactions.length);
    expect(rebuilt.goals).toHaveLength(source.goals.length);
    expect(rebuilt.budgetCategories).toHaveLength(source.budgetCategories.length);
  });

  // The optional modules (tontine, content packs) have no array in a fresh
  // AppData, so rebuilding one must create the collection on demand — the bug
  // this pins was a throw on the very first pulled tontine record.
  it('round-trips the optional modules that start absent from AppData', () => {
    const source = data({
      tontineGroups: [{
        id: 'grp-1', name: 'Tontine des Mamans', contribution: 25_000, currency: 'XOF',
        frequency: 'monthly', startDate: '2026-01-15',
      }],
      tontineMembers: [
        { id: 'mem-1', groupId: 'grp-1', name: 'Awa', shares: 2, position: 1, active: true },
      ],
      installedPacks: [{ id: 'sn-2025', version: 1, installedAt: '2026-09-12' }],
    });
    const flattened = flatten(source);
    expect(Object.keys(flattened)).toEqual(
      expect.arrayContaining(['tontine:grp-1', 'tontineMember:mem-1', 'pack:sn-2025'])
    );

    const rebuilt = applyRecords(
      Object.fromEntries(Object.entries(flattened).map(([id, value]) => [id, { c: clock(1), value }]))
    );
    expect(rebuilt.tontineGroups?.map((group) => group.id)).toEqual(['grp-1']);
    expect(rebuilt.tontineMembers?.map((member) => member.id)).toEqual(['mem-1']);
    expect(rebuilt.installedPacks?.map((pack) => pack.id)).toEqual(['sn-2025']);
  });

  it('namespaces ids by kind and rejects unknown kinds', () => {
    expect(recordId('goal', 'g-1')).toBe('goal:g-1');
    expect(splitRecordId('goal:g-1')).toEqual({ kind: 'goal', entityId: 'g-1' });
    expect(splitRecordId('unknown:g-1')).toBeNull();
    expect(splitRecordId('nocolon')).toBeNull();
  });

  it('compares content, not property order', () => {
    expect(canonical({ a: 1, b: [1, { d: 2, c: 3 }] })).toBe(canonical({ b: [1, { c: 3, d: 2 }], a: 1 }));
    expect(canonical({ a: 1 })).not.toBe(canonical({ a: 2 }));
  });

  it('reports no change when an equal entity is saved again', () => {
    const previous = flatten(data());
    const same = flatten(data());
    expect(diffValues(previous, same)).toEqual({ changed: [], removed: [] });

    const edited: AppData = {
      ...data(),
      goals: [{ ...initialData().goals[0], currentAmount: 4_300_000 }, initialData().goals[1]],
    };
    expect(diffValues(previous, flatten(edited)).changed).toEqual(['goal:g-1']);
  });

  it('reports removals so they can travel as tombstones', () => {
    const previous = flatten(data());
    const trimmed: AppData = { ...data(), transactions: initialData().transactions.slice(1) };
    expect(diffValues(previous, flatten(trimmed)).removed).toEqual(['transaction:tx-1']);
  });

  it('drops tombstones when rebuilding the data', () => {
    const records = {
      'account:acc-1': { c: clock(1), value: initialData().accounts[0] },
      'account:acc-2': { c: clock(2), deleted: true as const },
    };
    expect(applyRecords(records).accounts.map((a) => a.id)).toEqual(['acc-1']);
  });

  it('ignores values of tombstones', () => {
    expect(snapshotValues({ 'goal:g-1': { c: clock(1), deleted: true } })).toEqual({});
  });
});

describe('three-way merge', () => {
  const account = { ...initialData().accounts[0] };
  const id = 'account:acc-1';

  const local = (stamped: Stamped) => snapshot('a', { [id]: stamped });
  const remote = (stamped: Stamped) => snapshot('b', { [id]: stamped });

  it('pushes when only we moved since the base', () => {
    const base = { [id]: clock(1_000) };
    const outcome = mergeSnapshots({
      base,
      local: local({ c: clock(2_000), value: { ...account, name: 'Modifié ici' } }),
      remote: remote({ c: clock(1_000), value: account }),
    });
    expect(outcome.pushed).toBe(1);
    expect(outcome.conflicts).toHaveLength(0);
    expect((outcome.snapshot.records[id].value as { name: string }).name).toBe('Modifié ici');
  });

  it('adopts when only they moved since the base', () => {
    const outcome = mergeSnapshots({
      base: { [id]: clock(1_000) },
      local: local({ c: clock(1_000), value: account }),
      remote: remote({ c: clock(2_000), value: { ...account, name: 'Modifié ailleurs' } }),
    });
    expect(outcome.pulled).toBe(1);
    expect(outcome.conflicts).toHaveLength(0);
    expect((outcome.snapshot.records[id].value as { name: string }).name).toBe('Modifié ailleurs');
  });

  it('unions records only one side has', () => {
    const outcome = mergeSnapshots({
      base: {},
      local: snapshot('a', { 'goal:g-1': { c: clock(1), value: { id: 'g-1', name: 'Ici' } } }),
      remote: snapshot('b', { 'goal:g-2': { c: clock(1), value: { id: 'g-2', name: 'Ailleurs' } } }),
    });
    expect(Object.keys(outcome.snapshot.records).sort()).toEqual(['goal:g-1', 'goal:g-2']);
    expect(outcome.pushed).toBe(1);
    expect(outcome.pulled).toBe(1);
    expect(outcome.conflicts).toHaveLength(0);
  });

  it('settles a real conflict the same way whichever side asks', () => {
    // Same millisecond, different devices: only the device tie-break can decide.
    const mine: Stamped = { c: clock(5_000, 0, 'a'), value: { ...account, name: 'Chez A' } };
    const theirs: Stamped = { c: clock(5_000, 0, 'b'), value: { ...account, name: 'Chez B' } };
    const base = { [id]: clock(1_000) };

    const atA = mergeSnapshots({ base, local: snapshot('a', { [id]: mine }), remote: snapshot('b', { [id]: theirs }) });
    const atB = mergeSnapshots({ base, local: snapshot('b', { [id]: theirs }), remote: snapshot('a', { [id]: mine }) });

    const winnerA = (atA.snapshot.records[id].value as { name: string }).name;
    const winnerB = (atB.snapshot.records[id].value as { name: string }).name;
    expect(winnerA).toBe('Chez B');
    expect(winnerB).toBe('Chez B');
    expect(atA.snapshot.records[id].c).toEqual(atB.snapshot.records[id].c);
    expect(atA.conflicts).toHaveLength(1);
    expect(atA.conflicts[0].reason).toBe('concurrent');
  });

  it('never discards the losing version', () => {
    const mine: Stamped = { c: clock(1_000, 0, 'a'), value: { ...account, name: 'Perdant' } };
    const theirs: Stamped = { c: clock(9_000, 0, 'b'), value: { ...account, name: 'Gagnant' } };
    const outcome = mergeSnapshots({
      base: { [id]: clock(500) },
      local: snapshot('a', { [id]: mine }),
      remote: snapshot('b', { [id]: theirs }),
    });
    expect(outcome.conflicts[0].winner).toBe('remote');
    expect(outcome.conflicts[0].discarded.value).toEqual(mine.value);
    expect(outcome.conflicts[0].kept.value).toEqual(theirs.value);
  });

  it('adopts the shared copy on a first join and archives the local one', () => {
    const outcome = mergeSnapshots({
      base: {},
      local: snapshot('a', { [id]: { c: clock(9_000, 0, 'a'), value: { ...account, name: 'Démo locale' } } }),
      remote: snapshot('b', { [id]: { c: clock(1_000, 0, 'b'), value: { ...account, name: 'Vraie famille' } } }),
      adoptRemote: true,
    });
    expect((outcome.snapshot.records[id].value as { name: string }).name).toBe('Vraie famille');
    expect(outcome.conflicts[0].reason).toBe('first-join');
    expect(outcome.conflicts[0].discarded.value).toEqual({ ...account, name: 'Démo locale' });
  });

  it('keeps a deletion against a stale copy, and lets a later edit resurrect it', () => {
    const tombstone: Stamped = { c: clock(5_000, 0, 'a'), deleted: true };
    const staleEdit: Stamped = { c: clock(4_000, 0, 'b'), value: account };
    const deleted = mergeSnapshots({
      base: { [id]: clock(1_000) },
      local: snapshot('a', { [id]: tombstone }),
      remote: snapshot('b', { [id]: staleEdit }),
    });
    expect(deleted.snapshot.records[id].deleted).toBe(true);

    const laterEdit: Stamped = { c: clock(6_000, 0, 'b'), value: { ...account, name: 'Ressuscité' } };
    const resurrected = mergeSnapshots({
      base: { [id]: clock(1_000) },
      local: snapshot('a', { [id]: tombstone }),
      remote: snapshot('b', { [id]: laterEdit }),
    });
    expect(resurrected.snapshot.records[id].deleted).toBeUndefined();
    expect(resurrected.conflicts).toHaveLength(1);
  });

  it('is idempotent: re-merging the same state changes nothing', () => {
    const records = { [id]: { c: clock(1_000), value: account } };
    const outcome = mergeSnapshots({
      base: baseFrom(records),
      local: snapshot('a', records),
      remote: snapshot('b', records),
    });
    expect(outcome.pushed).toBe(0);
    expect(outcome.pulled).toBe(0);
    expect(outcome.resolved).toBe(0);
    expect(outcome.conflicts).toHaveLength(0);
    expect(snapshotValues(outcome.snapshot.records)).toEqual(snapshotValues(records));
  });

  it('converges when both devices edit different records, then the same one', () => {
    // A tiny two-device simulation: each device merges against the shared slot
    // and updates its base, in either order — the end states must be identical.
    const start = {
      'goal:g-1': { c: clock(1_000), value: { id: 'g-1', name: 'Fonds', currentAmount: 1 } },
      'goal:g-2': { c: clock(1_000), value: { id: 'g-2', name: 'Terrain', currentAmount: 2 } },
    };
    const base = baseFrom(start);

    let deviceA = { snapshot: snapshot('a', start), base };
    let deviceB = { snapshot: snapshot('b', start), base };

    const editA = {
      ...deviceA.snapshot.records,
      'goal:g-1': { c: clock(2_000, 0, 'a'), value: { id: 'g-1', name: 'Fonds', currentAmount: 11 } },
    };
    deviceA = { ...deviceA, snapshot: snapshot('a', editA) };

    const editB = {
      ...deviceB.snapshot.records,
      'goal:g-2': { c: clock(2_000, 0, 'b'), value: { id: 'g-2', name: 'Terrain', currentAmount: 22 } },
      'goal:g-1': { c: clock(2_000, 0, 'b'), value: { id: 'g-1', name: 'Fonds', currentAmount: 99 } },
    };
    deviceB = { ...deviceB, snapshot: snapshot('b', editB) };

    // A syncs first (blind to B), B then merges A's result, A then merges B's.
    const first = mergeSnapshots({ base: deviceA.base, local: deviceA.snapshot, remote: snapshot('b', {}) });
    deviceA = { snapshot: { ...first.snapshot, device: 'a' }, base: baseFrom(first.snapshot.records) };

    const second = mergeSnapshots({ base: deviceB.base, local: deviceB.snapshot, remote: deviceA.snapshot });
    deviceB = { snapshot: { ...second.snapshot, device: 'b' }, base: baseFrom(second.snapshot.records) };

    const third = mergeSnapshots({ base: deviceA.base, local: deviceA.snapshot, remote: deviceB.snapshot });
    deviceA = { snapshot: { ...third.snapshot, device: 'a' }, base: baseFrom(third.snapshot.records) };

    expect(snapshotValues(deviceA.snapshot.records)).toEqual(snapshotValues(deviceB.snapshot.records));
    // g-2 came from B, and the contested g-1 keeps B's version on both sides.
    expect((deviceA.snapshot.records['goal:g-2'].value as { currentAmount: number }).currentAmount).toBe(22);
    expect((deviceA.snapshot.records['goal:g-1'].value as { currentAmount: number }).currentAmount).toBe(99);
    // …and B's version was not silently dropped: it is in the archive.
    expect(second.conflicts.some((c) => c.target === 'goal:g-1' && c.winner === 'local')).toBe(true);
    expect(third.conflicts).toHaveLength(0);
  });

  it('puts a discarded version back with a stamp that wins everywhere', () => {
    const records = { [id]: { c: clock(9_000, 0, 'a'), value: { ...account, name: 'Gagnant' } } };
    const conflict = {
      target: id,
      reason: 'concurrent' as const,
      winner: 'local' as const,
      at: '2026-09-12T00:00:00.000Z',
      kept: records[id],
      discarded: { c: clock(8_000, 0, 'b'), value: { ...account, name: 'Ressuscité' } },
    };
    const restored = restoreConflict(records, conflict, clock(20_000, 0, 'a'));
    expect((restored[id].value as { name: string }).name).toBe('Ressuscité');
    expect(compareClocks(restored[id].c, records[id].c)).toBeGreaterThan(0);
  });

  it('prunes only old tombstones', () => {
    const now = 1_000 * 24 * 60 * 60 * 1000;
    const records = {
      'goal:old': { c: clock(0), deleted: true as const },
      'goal:new': { c: clock(now - 1_000), deleted: true as const },
      'goal:live': { c: clock(0), value: { id: 'live' } },
    };
    expect(Object.keys(pruneTombstones(records, now)).sort()).toEqual(['goal:live', 'goal:new']);
  });
});
