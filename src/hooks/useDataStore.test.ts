/**
 * The executable contract of the write path itself. Everything `App.tsx` used
 * to do inline — `dataRef`, `persist`, `mutate`, `update` — now runs here for
 * real, with no React and no DOM: the stale-state bug these closures once hid
 * (a second write in the same handler silently undoing the first) is pinned
 * where it can never come back.
 */

import { describe, expect, it, vi } from 'vitest';
import { createDataStore } from './useDataStore';
import * as edits from '../services/dataEdits';
import type { AppData } from '../services/storage';
import type { TontineGroup, TontineMember, TontineRound } from '../types';

const base = (): AppData => ({
  accounts: [{ id: 'acc-1', name: 'Courant', type: 'checking', holder: 'F', initialBalance: 0, currency: 'XOF', institution: 'B' }],
  transactions: [],
  budgetCategories: [],
  goals: [],
});

const group = (): TontineGroup => ({ id: 'tg-1', name: 'G', contribution: 5000, currency: 'XOF', frequency: 'monthly', startDate: '2026-01-01' });
const member = (): TontineMember => ({ id: 'tm-1', groupId: 'tg-1', name: 'Awa', shares: 1, position: 1, active: true });
const round = (): TontineRound => ({ id: 'tr-1', groupId: 'tg-1', index: 1, beneficiaryId: 'tm-1', dueDate: '2026-02-01' });

describe('createDataStore — the write path', () => {
  it('starts empty (locked) and mutate is a no-op until populated', () => {
    const store = createDataStore<AppData>();
    expect(store.getData()).toBeNull();
    expect(() => store.mutate((d) => d)).not.toThrow();
    expect(store.getData()).toBeNull();
  });

  it('set populates without firing the persist side effects (unlock is not a mutation)', () => {
    const onPersist = vi.fn();
    const store = createDataStore<AppData>({ onPersist });

    store.set(base());
    expect(store.getData()).not.toBeNull();
    expect(onPersist).not.toHaveBeenCalled();
  });

  it('every mutate goes through onPersist exactly once, with the replaced state', () => {
    const onPersist = vi.fn();
    const store = createDataStore<AppData>({ onPersist });
    store.set(base());

    const upsert = store.bindEdit(edits.upsertAccount);
    upsert({ id: 'acc-9', name: 'Cash', type: 'cash', holder: 'F', initialBalance: 0, currency: 'XOF', institution: '' });

    expect(onPersist).toHaveBeenCalledTimes(1);
    const [next, previous] = onPersist.mock.calls[0] as [AppData, AppData];
    expect(next.accounts.map((a) => a.id)).toEqual(['acc-1', 'acc-9']);
    expect(previous.accounts).toHaveLength(1); // previous is the pre-write state
  });

  it('two writes in one handler: the second sees what the first stored', () => {
    // The exact stale-state shape that once dropped a saved tontine member:
    // save the member, then recompute the rounds, in the same tick.
    const store = createDataStore<AppData>();
    store.set(base());
    const saveMemberThenPlanRounds = store.bindEdit((data: AppData) =>
      edits.planTontineRounds(edits.upsertTontineMember(edits.upsertTontineGroup(data, group()), member()), 'tg-1', [round()])
    );

    saveMemberThenPlanRounds();
    const data = store.getData()!;
    expect(data.tontineMembers?.map((m) => m.id)).toEqual(['tm-1']);
    expect(data.tontineRounds?.map((r) => r.beneficiaryId)).toEqual(['tm-1']);
  });

  it('notifies subscribers on every write and stops after unsubscribe', () => {
    const store = createDataStore<AppData>();
    const listener = vi.fn();
    const unsubscribe = store.subscribe(listener);

    store.set(base());
    expect(listener).toHaveBeenCalledTimes(1);

    unsubscribe();
    store.mutate((d) => ({ ...d, goals: [] }));
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('clear drops the state and mutate stays inert afterwards (lock session)', () => {
    const store = createDataStore<AppData>();
    store.set(base());
    store.clear();
    expect(store.getData()).toBeNull();
    store.mutate((d) => ({ ...d, goals: [] }));
    expect(store.getData()).toBeNull();
  });

  it('set over existing data is a real write (a sync pull or backup restore)', () => {
    const onPersist = vi.fn();
    const store = createDataStore<AppData>({ onPersist });
    store.set(base());
    store.set({ ...base(), goals: [{ id: 'g-1', name: 'F', targetAmount: 1, currentAmount: 0, deadline: '2027-01-01', category: 'project' }] });
    expect(onPersist).toHaveBeenCalledTimes(1);
    expect(store.getData()!.goals).toHaveLength(1);
  });
});
