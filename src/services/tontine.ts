/**
 * Tontine / association — the group savings logic, kept pure.
 *
 * Model: a group collects a fixed amount every round (weekly, fortnightly or
 * monthly). Each member holds one or more *parts* (`shares`), pays
 * `contribution × shares` every round, and each round one member receives the
 * whole pot. The rotation is explicit (`position`), because a real tontine
 * agrees on an order — often by lottery or seniority — that is not alphabetical.
 *
 * Two deliberate choices:
 *
 * 1. **No accounting table.** What a member owes is *derived* from the group,
 *    the round and their shares; what they paid is the payments. Nothing is
 *    stored twice, so the numbers can never disagree with themselves.
 * 2. **No stored receipts.** A receipt is a formatted view of one payment, with
 *    a number derived from (group, round, member) — stable across devices and
 *    re-generatable years later, without a second source of truth.
 *
 * Every function here is pure, so the group maths is tested without any UI.
 */

import type {
  TontineFrequency, TontineGroup, TontineMember, TontinePayment, TontinePaymentMethod,
  TontineReceipt, TontineRound,
} from '../types';
import { frTranslate, Translate } from '../i18n/translations';

// ---------------------------------------------------------------------------
// Drafts (what the forms hold before validation)
// ---------------------------------------------------------------------------

export interface GroupDraft {
  name: string;
  contribution: string;
  currency: string;
  frequency: TontineFrequency;
  startDate: string;
  note: string;
}

export interface MemberDraft {
  name: string;
  phone: string;
  shares: string;
  position: string;
  active: boolean;
}

export interface PaymentDraft {
  memberId: string;
  amount: string;
  paidAt: string;
  method: TontinePaymentMethod;
  note: string;
}

export function emptyGroupDraft(currency: string, today: string): GroupDraft {
  return { name: '', contribution: '', currency, frequency: 'monthly', startDate: today, note: '' };
}

export function emptyMemberDraft(position: number): MemberDraft {
  return { name: '', phone: '', shares: '1', position: String(position), active: true };
}

export function emptyPaymentDraft(memberId: string, amount: number, today: string): PaymentDraft {
  return { memberId, amount: String(amount), paidAt: today, method: 'cash', note: '' };
}

export const FREQUENCIES: TontineFrequency[] = ['weekly', 'biweekly', 'monthly'];

export const PAYMENT_METHODS: TontinePaymentMethod[] = [
  'cash', 'wave', 'orange_money', 'mtn_momo', 'bank', 'other',
];

/** Months per period — the calendar step used to date the rounds. */
const PERIOD_MONTHS: Record<TontineFrequency, number> = { weekly: 0, biweekly: 0, monthly: 1 };
const PERIOD_DAYS: Record<TontineFrequency, number> = { weekly: 7, biweekly: 14, monthly: 0 };

// ---------------------------------------------------------------------------
// Dates
// ---------------------------------------------------------------------------

export function todayIso(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}

/** `startDate` shifted by `steps` periods; ISO 'YYYY-MM-DD'. */
export function addPeriods(startDate: string, frequency: TontineFrequency, steps: number): string {
  const date = new Date(`${startDate}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime())) return startDate;
  const months = PERIOD_MONTHS[frequency] * steps;
  if (months > 0) {
    // Calendar months, clamped to the end of a shorter month (31 Jan + 1 → 28/29 Feb).
    const day = date.getUTCDate();
    date.setUTCDate(1);
    date.setUTCMonth(date.getUTCMonth() + months);
    const lastDay = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)).getUTCDate();
    date.setUTCDate(Math.min(day, lastDay));
  } else {
    date.setUTCDate(date.getUTCDate() + PERIOD_DAYS[frequency] * steps);
  }
  return date.toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------
// Rotation and amounts
// ---------------------------------------------------------------------------

/** Members in payout order: by agreed position, then name for a stable tie-break. */
export function rotationOrder(members: TontineMember[]): TontineMember[] {
  return [...members].sort((a, b) => {
    if (a.position !== b.position) return a.position - b.position;
    return a.name.localeCompare(b.name);
  });
}

/** Active members, in rotation order. Inactive members are skipped by the plan. */
export function activeMembers(members: TontineMember[]): TontineMember[] {
  return rotationOrder(members.filter((member) => member.active));
}

/** What one member owes per round: contribution × parts. */
export function expectedAmount(group: TontineGroup, member: TontineMember): number {
  return Math.round(group.contribution * Math.max(0, member.shares));
}

/** The whole pot of a round: every active member's expected amount. */
export function roundPot(group: TontineGroup, members: TontineMember[]): number {
  return activeMembers(members).reduce((total, member) => total + expectedAmount(group, member), 0);
}

export function totalShares(members: TontineMember[]): number {
  return activeMembers(members).reduce((total, member) => total + member.shares, 0);
}

/**
 * The plan: one round per active member, in rotation order, each due one period
 * after the previous. Round 1 is due on the start date.
 */
export function buildRounds(
  group: TontineGroup,
  members: TontineMember[],
  idFor: (round: number) => string
): TontineRound[] {
  return activeMembers(members).map((member, index) => ({
    id: idFor(index + 1),
    groupId: group.id,
    index: index + 1,
    beneficiaryId: member.id,
    dueDate: addPeriods(group.startDate, group.frequency, index),
  }));
}

/** The id a planned round is created under — deterministic from group + index. */
export function plannedRoundId(groupId: string, index: number): string {
  return `rnd-${groupId}-${index}`;
}

/**
 * Recomputes the rotation after the roster changes, **without rewriting what has
 * already happened**.
 *
 * This is the rule the whole module's history depends on: a round that has been
 * paid out recorded who received the pot. Rebuilding the rotation naively after
 * someone joins ahead of them would silently re-point that round at a different
 * beneficiary — the books would claim a pot nobody agreed to. So every round up
 * to the last settled index is kept **verbatim** (id, beneficiary, paid-out
 * stamp).
 *
 * The rounds that follow are the rotation of the members who have **not yet
 * received** a pot, in position order, numbered from just after the settled
 * prefix. That is deliberately not `planned.filter(index > settled)`: slicing
 * the new plan by index assumes the old and new rosters line up, and the moment
 * one does not — a member deleted from the front, a member added at the top —
 * the slice both skips a member who is still due and repeats one who was already
 * paid (the same person could then be shown receiving two pots, while the
 * newcomer is never due anything).
 *
 * With nothing settled the result is exactly `buildRounds`, and applying it twice
 * to an unchanged roster changes nothing.
 */
export function replanRounds(
  group: TontineGroup,
  members: TontineMember[],
  existing: TontineRound[]
): TontineRound[] {
  const settled = existing.filter((round) => round.paidOutAt);
  const maxSettledIndex = settled.reduce((max, round) => Math.max(max, round.index), 0);
  const kept = existing.filter((round) => round.index <= maxSettledIndex);

  // Nobody is paid twice, and nobody still in the group is skipped: the coming
  // rounds are the rotation of those who have not received the pot yet.
  const alreadyReceived = new Set(settled.map((round) => round.beneficiaryId));
  const stillDue = activeMembers(members).filter((member) => !alreadyReceived.has(member.id));

  const rebuilt = stillDue.map((member, offset) => {
    const index = maxSettledIndex + 1 + offset;
    return {
      id: plannedRoundId(group.id, index),
      groupId: group.id,
      index,
      beneficiaryId: member.id,
      dueDate: addPeriods(group.startDate, group.frequency, index - 1),
    };
  });
  return [...kept, ...rebuilt];
}

// ---------------------------------------------------------------------------
// Status and progress
// ---------------------------------------------------------------------------

export type RoundState = 'paid' | 'partial' | 'pending' | 'overdue';

export interface RoundProgress {
  expected: number;
  collected: number;
  outstanding: number;
  paidMembers: number;
  totalMembers: number;
  state: RoundState;
}

export function paymentsFor(payments: TontinePayment[], roundId: string): TontinePayment[] {
  return payments.filter((payment) => payment.roundId === roundId);
}

/** Everything one member has paid for a round (partial payments add up). */
export function paidByMember(payments: TontinePayment[], roundId: string, memberId: string): number {
  return paymentsFor(payments, roundId)
    .filter((payment) => payment.memberId === memberId)
    .reduce((total, payment) => total + payment.amount, 0);
}

export function roundProgress(
  group: TontineGroup,
  members: TontineMember[],
  round: TontineRound,
  payments: TontinePayment[],
  today: string = todayIso()
): RoundProgress {
  const roster = activeMembers(members);
  const expected = roster.reduce((total, member) => total + expectedAmount(group, member), 0);
  const collected = paymentsFor(payments, round.id).reduce((total, payment) => total + payment.amount, 0);
  const outstanding = Math.max(0, expected - collected);
  const paidMembers = roster.filter((member) => paidByMember(payments, round.id, member.id) > 0).length;
  const state: RoundState =
    collected >= expected && expected > 0
      ? 'paid'
      : collected > 0
        ? 'partial'
        : round.dueDate < today
          ? 'overdue'
          : 'pending';
  return { expected, collected, outstanding, paidMembers, totalMembers: roster.length, state };
}

export interface MemberLedger {
  member: TontineMember;
  due: number;
  paid: number;
  remaining: number;
  /** Rounds where this member is short of their expected amount. */
  missingRounds: number[];
}

/**
 * One line per member: what they owe over the *whole* plan, what they paid, and
 * which rounds they are short on. This is the sheet a treasurer reads out loud.
 */
export function memberLedgers(
  group: TontineGroup,
  members: TontineMember[],
  rounds: TontineRound[],
  payments: TontinePayment[]
): MemberLedger[] {
  return rotationOrder(members).map((member) => {
    const due = expectedAmount(group, member) * rounds.length;
    const paid = payments
      .filter((payment) => payment.memberId === member.id)
      .reduce((total, payment) => total + payment.amount, 0);
    const missingRounds = rounds
      .filter((round) => paidByMember(payments, round.id, member.id) < expectedAmount(group, member))
      .map((round) => round.index);
    return { member, due, paid, remaining: Math.max(0, due - paid), missingRounds };
  });
}

export interface GroupSummary {
  /** One full round, with every member paying. */
  pot: number;
  shares: number;
  rounds: TontineRound[];
  /** The plan so far (rounds that have started, due date reached). */
  expectedToDate: number;
  collected: number;
  outstandingToDate: number;
  overdueRounds: number[];
  /** Next round still short, by due date. */
  nextRound: TontineRound | null;
}

export function groupSummary(
  group: TontineGroup,
  members: TontineMember[],
  rounds: TontineRound[],
  payments: TontinePayment[],
  today: string = todayIso()
): GroupSummary {
  const ordered = [...rounds].sort((a, b) => a.index - b.index);
  const started = ordered.filter((round) => round.dueDate <= today);
  const expectedToDate = started.reduce(
    (total, round) => total + roundProgress(group, members, round, payments, today).expected,
    0
  );
  const collected = payments
    .filter((payment) => ordered.some((round) => round.id === payment.roundId))
    .reduce((total, payment) => total + payment.amount, 0);
  const overdueRounds = started
    .filter((round) => roundProgress(group, members, round, payments, today).state !== 'paid')
    .map((round) => round.index);
  const nextRound = ordered.find((round) => roundProgress(group, members, round, payments, today).state !== 'paid') ?? null;

  return {
    pot: roundPot(group, members),
    shares: totalShares(members),
    rounds: ordered,
    expectedToDate,
    collected,
    outstandingToDate: Math.max(0, expectedToDate - collected),
    overdueRounds,
    nextRound,
  };
}

/** The beneficiary of a round, when that member still exists. */
export function beneficiaryOf(round: TontineRound, members: TontineMember[]): TontineMember | null {
  return members.find((member) => member.id === round.beneficiaryId) ?? null;
}

// ---------------------------------------------------------------------------
// Receipts (derived, never stored)
// ---------------------------------------------------------------------------

function groupPrefix(group: TontineGroup): string {
  const letters = group.name.replace(/[^A-Za-z0-9]/g, '').slice(0, 4).toUpperCase();
  return letters || group.id.replace(/[^A-Za-z0-9]/g, '').slice(-4).toUpperCase();
}

/** Stable across devices and re-generatable: derived, not stored. */
export function receiptNumber(group: TontineGroup, member: TontineMember, round: TontineRound): string {
  return `${groupPrefix(group)}-R${String(round.index).padStart(2, '0')}-M${String(member.position).padStart(2, '0')}`;
}

export function buildReceipt(
  group: TontineGroup,
  member: TontineMember,
  round: TontineRound,
  payment: TontinePayment,
  payments: TontinePayment[]
): TontineReceipt {
  const expected = expectedAmount(group, member);
  const paid = paidByMember(payments, round.id, member.id);
  return {
    number: receiptNumber(group, member, round),
    groupName: group.name,
    memberName: member.name,
    roundIndex: round.index,
    shares: member.shares,
    amount: payment.amount,
    paidAt: payment.paidAt,
    method: payment.method,
    complete: paid >= expected,
    remaining: Math.max(0, expected - paid),
  };
}

/**
 * Plain-text receipt — what gets copied into a WhatsApp message, which is how a
 * tontine actually sends a receipt. The caller supplies the already-formatted
 * amount and date strings so the receipt follows the app's locale and currency.
 */
export function receiptText(
  receipt: TontineReceipt,
  strings: { amount: string; remaining: string; date: string; title: string; lines: Record<string, string> }
): string {
  const lines = [
    strings.title,
    `${receipt.groupName}`,
    `${strings.lines.number}: ${receipt.number}`,
    `${strings.lines.member}: ${receipt.memberName}`,
    `${strings.lines.round}: ${receipt.roundIndex}`,
    `${strings.lines.shares}: ${receipt.shares}`,
    `${strings.lines.amount}: ${strings.amount}`,
    `${strings.lines.date}: ${strings.date}`,
    `${strings.lines.method}: ${strings.lines[`method.${receipt.method}`] ?? receipt.method}`,
  ];
  if (!receipt.complete) lines.push(`${strings.lines.remaining}: ${strings.remaining}`);
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Validation — returns i18n error keys, never sentences
// ---------------------------------------------------------------------------

function isPositiveNumber(value: string): boolean {
  const parsed = Number(value.replace(',', '.'));
  return Number.isFinite(parsed) && parsed > 0;
}

function isNonNegativeInteger(value: string): boolean {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0;
}

//
// Validation returns *localized messages* (never keys), matching the other
// services: the caller injects the live translator, tests use the French default.
//

export function validateGroupDraft(draft: GroupDraft, t: Translate = frTranslate): string[] {
  const errors: string[] = [];
  if (!draft.name.trim()) errors.push(t('errors.tontine.nameRequired'));
  if (!isPositiveNumber(draft.contribution)) errors.push(t('errors.tontine.contributionPositive'));
  if (!/^\d{4}-\d{2}-\d{2}$/.test(draft.startDate)) errors.push(t('errors.tontine.startDate'));
  if (!FREQUENCIES.includes(draft.frequency)) errors.push(t('errors.tontine.frequency'));
  return errors;
}

export function validateMemberDraft(
  draft: MemberDraft,
  others: TontineMember[],
  t: Translate = frTranslate
): string[] {
  const errors: string[] = [];
  if (!draft.name.trim()) errors.push(t('errors.tontine.memberNameRequired'));
  const shares = Number(draft.shares);
  if (!Number.isInteger(shares) || shares < 1 || shares > 20) errors.push(t('errors.tontine.sharesRange'));
  const position = Number(draft.position);
  if (!Number.isInteger(position) || position < 1 || position > 200) errors.push(t('errors.tontine.positionRange'));
  else if (others.some((member) => member.position === position)) errors.push(t('errors.tontine.positionTaken'));
  if (draft.phone.trim() && !/^[+0-9 ().-]{6,20}$/.test(draft.phone.trim())) {
    errors.push(t('errors.tontine.phone'));
  }
  return errors;
}

export interface PaymentContext {
  group: TontineGroup;
  member: TontineMember;
  round: TontineRound;
  /** Payments already recorded for this round. */
  roundPayments: TontinePayment[];
}

export function validatePaymentDraft(
  draft: PaymentDraft,
  context: PaymentContext,
  t: Translate = frTranslate
): string[] {
  const errors: string[] = [];
  if (!draft.memberId) errors.push(t('errors.tontine.memberRequired'));
  if (!isPositiveNumber(draft.amount)) errors.push(t('errors.tontine.amountPositive'));
  if (!/^\d{4}-\d{2}-\d{2}$/.test(draft.paidAt)) errors.push(t('errors.tontine.dateInvalid'));
  else if (draft.paidAt > todayIso()) errors.push(t('errors.tontine.dateFuture'));
  if (draft.paidAt && draft.paidAt < context.group.startDate) errors.push(t('errors.tontine.dateBeforeStart'));
  if (!PAYMENT_METHODS.includes(draft.method)) errors.push(t('errors.tontine.methodInvalid'));
  if (isPositiveNumber(draft.amount) && isNonNegativeInteger(String(Math.round(Number(draft.amount))))) {
    const already = context.roundPayments
      .filter((payment) => payment.memberId === draft.memberId)
      .reduce((total, payment) => total + payment.amount, 0);
    const expected = expectedAmount(context.group, context.member);
    if (already + Number(draft.amount) > expected) errors.push(t('errors.tontine.overpaid'));
  }
  return errors;
}
