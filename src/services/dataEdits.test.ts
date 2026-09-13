/**
 * The contract for every data edit the screens perform — this is the suite that
 * executes what `App.tsx` actually calls. Three properties run through all of
 * it: a save never reorders an existing row, a delete takes its dependents (and
 * only its dependents), and no edit mutates the state it is given.
 */

import { describe, expect, it } from 'vitest';
import * as edits from './dataEdits';
import type { AppData } from './storage';
import type { TontineGroup, TontineMember, TontinePayment, TontineRound, Transaction } from '../types';
import { findPack, templateAllocations } from './packs';

const base = (): AppData => ({
  accounts: [{ id: 'acc-1', name: 'Courant', type: 'checking', holder: 'F', initialBalance: 0, currency: 'XOF', institution: 'B' }],
  transactions: [{ id: 'tx-1', date: '2026-09-01', title: 'Salaire', amount: 1000, type: 'income', category: 'Revenus', accountId: 'acc-1', member: 'F' }],
  budgetCategories: [{ id: 'cat-1', name: 'Courses', type: 'needs', allocated: 100, color: '#10B981' }],
  goals: [{ id: 'g-1', name: 'Fonds', targetAmount: 10, currentAmount: 1, deadline: '2027-01-01', category: 'emergency' }],
});

// The three ledger collections behave identically (they share `upsertById` and
// `without`), so one table drives the contract for all of them.
const LEDGER = [
  {
    name: 'transactions',
    add: edits.upsertTransaction,
    del: edits.deleteTransaction,
    list: (d: AppData) => d.transactions,
    edited: { id: 'tx-1', title: 'Salaire net' } as Partial<Transaction>,
    fresh: { id: 'tx-9', title: 'Taxi' } as Transaction,
  },
  {
    name: 'accounts',
    add: edits.upsertAccount,
    del: edits.deleteAccount,
    list: (d: AppData) => d.accounts,
    edited: { id: 'acc-1', name: 'Courant renommé' },
    fresh: { id: 'acc-9', name: 'Neuf', type: 'cash', holder: 'F', initialBalance: 0, currency: 'XOF', institution: '' },
  },
  {
    name: 'goals',
    add: edits.upsertGoal,
    del: edits.deleteGoal,
    list: (d: AppData) => d.goals,
    edited: { id: 'g-1', name: 'Fonds renommé' },
    fresh: { id: 'g-9', name: 'Neuf', targetAmount: 1, currentAmount: 0, deadline: '2028-01-01', category: 'project' },
  },
] as const;

describe('ledger edits (transactions, accounts, goals)', () => {
  it('appends a new row and replaces an existing one without reordering it', () => {
    for (const { add, list, edited, fresh } of LEDGER) {
      const replaced = add(base(), { ...list(base())[0], ...edited } as never);
      expect(list(replaced)[0]).toMatchObject(edited);
      expect(list(replaced)).toHaveLength(1);

      const appended = add(base(), fresh as never);
      expect(list(appended)).toHaveLength(2);
      expect(list(appended)[1]).toMatchObject({ id: (fresh as { id: string }).id });
    }
  });

  it('deletes by id, keeps the rest, and an unknown id changes nothing', () => {
    for (const { del, list } of LEDGER) {
      const [first] = list(base());
      const kept = del(base(), first.id);
      expect(list(kept)).toHaveLength(0);

      const untouched = del(base(), 'no-such-id');
      expect(list(untouched)).toEqual(list(base()));
    }
  });
});

// ---------------------------------------------------------------------------
// Tontine: one array per entity (see sync/records.ts), so the cascades are
// explicit — and tested.
// ---------------------------------------------------------------------------

const group = (id: string): TontineGroup => ({ id, name: id, contribution: 5000, currency: 'XOF', frequency: 'monthly', startDate: '2026-01-01' });
const member = (id: string, groupId: string, position: number): TontineMember => ({ id, groupId, name: id, shares: 1, position, active: true });
const round = (id: string, groupId: string, beneficiaryId: string, index: number): TontineRound => ({ id, groupId, index, beneficiaryId, dueDate: '2026-02-01' });
const payment = (id: string, groupId: string, roundId: string, memberId: string): TontinePayment => ({ id, groupId, roundId, memberId, amount: 5000, paidAt: '2026-01-05', method: 'cash' });

const tontineData = (): AppData => ({
  ...base(),
  tontineGroups: [group('tg-1'), group('tg-2')],
  tontineMembers: [member('tm-1', 'tg-1', 1), member('tm-2', 'tg-1', 2), member('tm-3', 'tg-2', 1)],
  tontineRounds: [round('tr-1', 'tg-1', 'tm-1', 1), round('tr-2', 'tg-1', 'tm-2', 2), round('tr-3', 'tg-2', 'tm-3', 1)],
  tontinePayments: [payment('tp-1', 'tg-1', 'tr-1', 'tm-1'), payment('tp-2', 'tg-2', 'tr-3', 'tm-3')],
});

describe('tontine edits', () => {
  it('creates the arrays on a fresh install, where every tontine collection is absent', () => {
    const next = edits.upsertTontineGroup(base(), group('tg-1'));
    expect(next.tontineGroups).toEqual([group('tg-1')]);
  });

  it('deleting a group takes its members, rounds and payments — and only its own', () => {
    const next = edits.deleteTontineGroup(tontineData(), 'tg-1');
    expect(next.tontineGroups?.map((g) => g.id)).toEqual(['tg-2']);
    expect(next.tontineMembers?.map((m) => m.id)).toEqual(['tm-3']);
    expect(next.tontineRounds?.map((r) => r.id)).toEqual(['tr-3']);
    expect(next.tontinePayments?.map((p) => p.id)).toEqual(['tp-2']);
  });

  it('removing a member drops their payments but not the group or other members', () => {
    const next = edits.deleteTontineMember(tontineData(), 'tm-1');
    expect(next.tontineMembers?.map((m) => m.id)).toEqual(['tm-2', 'tm-3']);
    expect(next.tontinePayments?.map((p) => p.id)).toEqual(['tp-2']);
    expect(next.tontineGroups).toHaveLength(2);
  });

  it('replanning replaces only that group’s rounds and keeps the others', () => {
    const next = edits.planTontineRounds(tontineData(), 'tg-1', [round('tr-9', 'tg-1', 'tm-2', 1)]);
    expect(next.tontineRounds?.map((r) => r.id)).toEqual(['tr-3', 'tr-9']);
  });

  it('settling stamps paidOutAt on the round, and an absent round is never created', () => {
    const stamped = edits.settleTontineRound(tontineData(), round('tr-1', 'tg-1', 'tm-1', 1), '2026-09-13');
    expect(stamped.tontineRounds?.find((r) => r.id === 'tr-1')?.paidOutAt).toBe('2026-09-13');
    expect(stamped.tontineRounds?.find((r) => r.id === 'tr-2')?.paidOutAt).toBeUndefined();

    const absent = edits.settleTontineRound(tontineData(), round('tr-404', 'tg-1', 'tm-1', 9), '2026-09-13');
    expect(absent.tontineRounds?.some((r) => r.id === 'tr-404')).toBe(false);
  });

  it('two writes in one handler: a member saved, then their rounds planned, survives both', () => {
    // The stale-state shape this module replaces ran the second write against
    // the pre-render data and silently dropped the just-saved member.
    const saved = edits.upsertTontineMember(edits.upsertTontineGroup(base(), group('tg-1')), member('tm-1', 'tg-1', 1));
    const planned = edits.planTontineRounds(saved, 'tg-1', [round('tr-1', 'tg-1', 'tm-1', 1)]);
    expect(planned.tontineMembers?.map((m) => m.id)).toEqual(['tm-1']);
    expect(planned.tontineRounds?.map((r) => r.beneficiaryId)).toEqual(['tm-1']);
  });
});

// ---------------------------------------------------------------------------
// Packs: installing records the choice; a template writes ordinary categories.
// ---------------------------------------------------------------------------

const sn = findPack('sn-2025')!;
const categoryName = (key: string) => `cat-${key}`;

describe('pack edits', () => {
  it('installing a fresh pack records a dated entry with no category claim', () => {
    const next = edits.installPack(base(), sn);
    expect(next.installedPacks).toEqual([
      expect.objectContaining({ id: sn.id, version: sn.version }),
    ]);
    expect(next.installedPacks?.[0].installedAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(next.installedPacks?.[0]).not.toHaveProperty('categoryIds');
  });

  it('re-installing keeps the original date and refreshes the version', () => {
    const seeded: AppData = { ...base(), installedPacks: [{ id: sn.id, version: 1, installedAt: '2026-01-01' }] };
    const next = edits.installPack(seeded, { ...sn, version: sn.version + 1 });
    expect(next.installedPacks?.[0]).toMatchObject({ version: sn.version + 1, installedAt: '2026-01-01' });
  });

  it('uninstalling forgets only that pack', () => {
    const seeded: AppData = { ...base(), installedPacks: [{ id: sn.id, version: 1, installedAt: '2026-01-01' }, { id: 'ci-2025', version: 1, installedAt: '2026-01-02' }] };
    expect(edits.uninstallPack(seeded, sn.id).installedPacks?.map((p) => p.id)).toEqual(['ci-2025']);
  });

  it('applying a template writes the pack’s categories, named by the caller, and records their ids', () => {
    const allocations = templateAllocations(sn, 100_000);
    const next = edits.applyPackTemplate(base(), sn, allocations, categoryName);

    const created = next.budgetCategories.filter((cat) => cat.id.startsWith('pck-'));
    expect(created.map((cat) => cat.name)).toEqual(allocations.map((line) => categoryName(line.key)));
    expect(created.reduce((sum, cat) => sum + cat.allocated, 0)).toBe(100_000);
    expect(next.budgetCategories.some((cat) => cat.id === 'cat-1')).toBe(true); // the user's own stay
    expect(next.installedPacks?.[0].categoryIds).toEqual(created.map((cat) => cat.id));
  });

  it('re-applying a template updates the amounts instead of duplicating categories', () => {
    const first = edits.applyPackTemplate(base(), sn, templateAllocations(sn, 100_000), categoryName);
    const again = edits.applyPackTemplate(first, sn, templateAllocations(sn, 200_000), categoryName);
    expect(again.budgetCategories.filter((cat) => cat.id.startsWith('pck-'))).toHaveLength(sn.budget.length);
    expect(again.budgetCategories.reduce((sum, cat) => sum + cat.allocated, 0)).toBe(200_000 + 100);
  });

  it('removing a template takes back exactly the categories the pack created', () => {
    const withTemplate = edits.applyPackTemplate(base(), sn, templateAllocations(sn, 100_000), categoryName);
    const removed = edits.removePackTemplate(withTemplate, sn);

    expect(removed.budgetCategories.map((cat) => cat.id)).toEqual(['cat-1']);
    expect(removed.installedPacks?.[0]).not.toHaveProperty('categoryIds');
    expect(removed.installedPacks?.[0].installedAt).toBe(withTemplate.installedPacks?.[0].installedAt);
  });
});

describe('whole state', () => {
  it('a backup import replaces everything in one shot, nothing merged', () => {
    const incoming: AppData = { ...base(), accounts: [] };
    expect(edits.replaceData(base(), incoming)).toBe(incoming);
  });
});

describe('purity', () => {
  it('no edit mutates the state it is given', () => {
    const data = tontineData();
    const snapshot = JSON.stringify(data);

    edits.upsertTransaction(data, { id: 'tx-9', date: '2026-09-02', title: 'x', amount: 1, type: 'expense', category: 'c', accountId: 'acc-1', member: '' });
    edits.deleteTontineGroup(data, 'tg-1');
    edits.settleTontineRound(data, data.tontineRounds![0], '2026-09-13');
    edits.applyPackTemplate(data, sn, templateAllocations(sn, 1_000), categoryName);
    edits.replaceData(data, base());

    expect(JSON.stringify(data)).toBe(snapshot);
  });
});
