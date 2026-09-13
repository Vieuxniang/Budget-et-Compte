/**
 * The data edits the screens perform, as pure functions `AppData → AppData`.
 *
 * These rules used to live inline in `App.tsx`'s mutation handlers, where the
 * only thing that could check them was reading them: the app ships no DOM test
 * environment, so a handler was never actually executed by a test. Moving them
 * here makes the code that runs the code that is tested — `App.tsx` keeps only
 * the wiring to the single write path (`mutate` → `persist` → vault + sync).
 *
 * Every function is pure and returns the next `AppData`; none of them mutate
 * their argument, and the optional collections (`tontine*`, `installedPacks`)
 * are absent on a fresh install, which every edit below tolerates.
 */

import type { Account, BudgetCategory, SavingsGoal, TontineMember, TontineGroup, TontinePayment, TontineRound, Transaction } from '../types';
import type { AppData } from './storage';
import {
  addInstalled, installedEntry, packCategoryId, removeInstalled, type CountryPack, type TemplateAllocation,
} from './packs';

/**
 * Insert-or-replace an entity by id. An existing entity keeps its position (so
 * editing a row does not reorder the list); a new one is appended. Shared by
 * every id-keyed collection, which is why the six collections below cannot
 * drift apart in how they save.
 */
export function upsertById<T extends { id: string }>(list: T[], item: T): T[] {
  return list.some((existing) => existing.id === item.id)
    ? list.map((existing) => (existing.id === item.id ? item : existing))
    : [...list, item];
}

/** Drop every entity matching a predicate — by id, by groupId, by memberId… */
export function without<T>(list: T[], match: (item: T) => boolean): T[] {
  return list.filter((item) => !match(item));
}

// ---------------------------------------------------------------------------
// Ledger
// ---------------------------------------------------------------------------

export const upsertTransaction = (data: AppData, tx: Transaction): AppData => ({
  ...data,
  transactions: upsertById(data.transactions, tx),
});

export const deleteTransaction = (data: AppData, id: string): AppData => ({
  ...data,
  transactions: without(data.transactions, (tx) => tx.id === id),
});

export const upsertAccount = (data: AppData, account: Account): AppData => ({
  ...data,
  accounts: upsertById(data.accounts, account),
});

export const deleteAccount = (data: AppData, id: string): AppData => ({
  ...data,
  accounts: without(data.accounts, (account) => account.id === id),
});

export const upsertGoal = (data: AppData, goal: SavingsGoal): AppData => ({
  ...data,
  goals: upsertById(data.goals, goal),
});

export const deleteGoal = (data: AppData, id: string): AppData => ({
  ...data,
  goals: without(data.goals, (goal) => goal.id === id),
});

// ---------------------------------------------------------------------------
// Tontine / association. One array per entity, so each group, member, round and
// payment syncs as its own record (see services/sync/records.ts) — which is why
// the cascades below have to be explicit: PostgreSQL has foreign keys, we have
// this file.
// ---------------------------------------------------------------------------

export const upsertTontineGroup = (data: AppData, group: TontineGroup): AppData => ({
  ...data,
  tontineGroups: upsertById(data.tontineGroups ?? [], group),
});

/** Deleting a group takes its members, rounds and payments with it. */
export const deleteTontineGroup = (data: AppData, id: string): AppData => ({
  ...data,
  tontineGroups: without(data.tontineGroups ?? [], (group) => group.id === id),
  tontineMembers: without(data.tontineMembers ?? [], (member) => member.groupId === id),
  tontineRounds: without(data.tontineRounds ?? [], (round) => round.groupId === id),
  tontinePayments: without(data.tontinePayments ?? [], (payment) => payment.groupId === id),
});

export const upsertTontineMember = (data: AppData, member: TontineMember): AppData => ({
  ...data,
  tontineMembers: upsertById(data.tontineMembers ?? [], member),
});

/** Removing a member also drops what they paid: a payment without a payer is noise. */
export const deleteTontineMember = (data: AppData, id: string): AppData => ({
  ...data,
  tontineMembers: without(data.tontineMembers ?? [], (member) => member.id === id),
  tontinePayments: without(data.tontinePayments ?? [], (payment) => payment.memberId === id),
});

/** The rotation is the plan: recomputing it replaces every round of that group. */
export const planTontineRounds = (data: AppData, groupId: string, rounds: TontineRound[]): AppData => ({
  ...data,
  tontineRounds: [...without(data.tontineRounds ?? [], (round) => round.groupId === groupId), ...rounds],
});

export const upsertTontinePayment = (data: AppData, payment: TontinePayment): AppData => ({
  ...data,
  tontinePayments: upsertById(data.tontinePayments ?? [], payment),
});

export const deleteTontinePayment = (data: AppData, id: string): AppData => ({
  ...data,
  tontinePayments: without(data.tontinePayments ?? [], (payment) => payment.id === id),
});

/**
 * Stamps a round as paid out. An update, never an upsert: a round that is not in
 * the data is not silently created by settling it.
 */
export const settleTontineRound = (data: AppData, round: TontineRound, paidOutAt: string): AppData => ({
  ...data,
  tontineRounds: (data.tontineRounds ?? []).map((existing) =>
    existing.id === round.id ? { ...existing, paidOutAt } : existing
  ),
});

// ---------------------------------------------------------------------------
// Country content packs. Installing only records the choice; applying a template
// writes ordinary budget categories, so a pack needs no storage of its own and
// the vault, the backup and the sync cover it already.
// ---------------------------------------------------------------------------

export const installPack = (data: AppData, pack: CountryPack): AppData => ({
  ...data,
  installedPacks: addInstalled(data.installedPacks, installedEntry(data.installedPacks, pack)),
});

/** Removing a pack only forgets it — its categories are the user's data. */
export const uninstallPack = (data: AppData, packId: string): AppData => ({
  ...data,
  installedPacks: removeInstalled(data.installedPacks, packId),
});

/**
 * Writes the template's lines as budget categories. Idempotent: the ids are
 * derived from the pack and the line key, so re-applying updates the amounts
 * instead of duplicating them, and the pack records which categories it made.
 * `categoryName` is injected because the label is UI text (the current language),
 * not something this module should know about.
 */
export const applyPackTemplate = (
  data: AppData,
  pack: CountryPack,
  allocations: TemplateAllocation[],
  categoryName: (key: string) => string
): AppData => {
  const ids = allocations.map((line) => packCategoryId(pack.id, line.key));
  const created: BudgetCategory[] = allocations.map((line) => ({
    id: packCategoryId(pack.id, line.key),
    name: categoryName(line.key),
    type: line.type,
    allocated: line.allocated,
    color: line.color,
  }));
  return {
    ...data,
    budgetCategories: [...without(data.budgetCategories, (cat) => ids.includes(cat.id)), ...created],
    installedPacks: addInstalled(data.installedPacks, installedEntry(data.installedPacks, pack, ids)),
  };
};

/** Takes back exactly the categories the pack created; the user's own stay. */
export const removePackTemplate = (data: AppData, pack: CountryPack): AppData => {
  const created = (data.installedPacks ?? []).find((item) => item.id === pack.id)?.categoryIds ?? [];
  return {
    ...data,
    budgetCategories: without(data.budgetCategories, (cat) => created.includes(cat.id)),
    installedPacks: addInstalled(data.installedPacks, installedEntry(data.installedPacks, pack)),
  };
};

// ---------------------------------------------------------------------------
// Whole state
// ---------------------------------------------------------------------------

/** A backup import replaces everything in one shot; nothing is merged. */
export const replaceData = (_current: AppData, incoming: AppData): AppData => incoming;
