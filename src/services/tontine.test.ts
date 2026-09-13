/**
 * Tontine domain tests. The money a group collects is the most consequential
 * number in the app, so the rules are pinned here: who pays what, who receives
 * when, what is overdue, and how a receipt is identified — all pure functions.
 */

import { describe, expect, it } from 'vitest';
import { frTranslate } from '../i18n/translations';
import {
  activeMembers, addPeriods, buildReceipt, buildRounds, emptyGroupDraft, emptyMemberDraft,
  emptyPaymentDraft, expectedAmount, groupSummary, memberLedgers, paidByMember, plannedRoundId,
  receiptNumber, receiptText, replanRounds, rotationOrder, roundPot, roundProgress, todayIso,
  totalShares, validateGroupDraft, validateMemberDraft, validatePaymentDraft,
} from './tontine';
import type { TontineGroup, TontineMember, TontinePayment, TontineRound } from '../types';

const group: TontineGroup = {
  id: 'grp-1', name: 'Tontine des Mamans', contribution: 25_000, currency: 'XOF',
  frequency: 'monthly', startDate: '2026-01-15',
};

function member(position: number, overrides: Partial<TontineMember> = {}): TontineMember {
  return {
    id: `m-${position}`, groupId: group.id, name: `Membre ${position}`,
    shares: 1, position, active: true, ...overrides,
  };
}

function round(index: number, dueDate: string, beneficiaryId = `m-${index}`): TontineRound {
  return { id: `r-${index}`, groupId: group.id, index, beneficiaryId, dueDate };
}

function payment(roundId: string, memberId: string, amount: number, paidAt = '2026-01-15'): TontinePayment {
  return { id: `p-${roundId}-${memberId}`, groupId: group.id, roundId, memberId, amount, paidAt, method: 'cash' };
}

describe('replanning the rotation after the roster changes', () => {
  const three = [member(1), member(2), member(3)];
  const build = (members: TontineMember[]) => buildRounds(group, members, (n) => plannedRoundId(group.id, n));

  it('is exactly buildRounds while nothing is settled', () => {
    expect(replanRounds(group, three, [])).toEqual(build(three));
    expect(replanRounds(group, three, build(three))).toEqual(build(three));
  });

  it('never re-points a settled round at another beneficiary', () => {
    // The failure this rule exists for: a member joins ahead in the rotation, so
    // a naive rebuild re-aims round 1 — the pot amadou already received would be
    // recorded as paid to zainab.
    const settled = build(three).map((r) => (r.index === 1 ? { ...r, paidOutAt: '2026-02-01' } : r));
    const joined = [member(0, { id: 'm-0' }), ...three];

    // What the naive approach would do, to show the guard has teeth:
    expect(build(joined)[0].beneficiaryId).toBe('m-0');

    const replanned = replanRounds(group, joined, settled);
    expect(replanned[0].beneficiaryId).toBe('m-1');
    expect(replanned[0].paidOutAt).toBe('2026-02-01');
    expect(replanned[0].id).toBe(settled[0].id);
  });

  it('keeps every settled round and only rebuilds what follows the last one', () => {
    const existing = build(three).map((r) =>
      r.index <= 2 ? { ...r, paidOutAt: `2026-0${r.index}-01` } : r
    );
    const joined = [...three, member(4)];
    const replanned = replanRounds(group, joined, existing);

    expect(replanned.map((r) => r.index)).toEqual([1, 2, 3, 4]);
    expect(replanned[0]).toEqual(existing[0]);
    expect(replanned[1]).toEqual(existing[1]);
    // Round 3 was not settled, so it is re-derived for the longer roster.
    expect(replanned[2].paidOutAt).toBeUndefined();
    expect(replanned[3].beneficiaryId).toBe('m-4');
  });

  it('keeps the settled round of a member who has since left, and stops paying them', () => {
    const existing = build(three).map((r) => (r.index === 1 ? { ...r, paidOutAt: '2026-02-01' } : r));
    // m-1 already got the pot, then left the group.
    const replanned = replanRounds(group, [member(2), member(3)], existing);

    expect(replanned[0].beneficiaryId).toBe('m-1'); // history stays
    expect(replanned[0].paidOutAt).toBe('2026-02-01');
    // …but they are never due a round again.
    expect(replanned.slice(1).map((r) => r.beneficiaryId)).toEqual(['m-2', 'm-3']);
    expect(replanned.slice(1).every((r) => r.paidOutAt === undefined)).toBe(true);
  });

  it('still pays every remaining member after the one who received the pot is deleted', () => {
    // The bug this guards (reachable from the member list's delete button): with
    // round 1 settled to the *first* member, removing them used to slice the new
    // plan by index and silently drop m-2 from the rotation — the group would
    // collect a round nobody was due.
    const existing = build(three).map((r) => (r.index === 1 ? { ...r, paidOutAt: '2026-02-01' } : r));
    const replanned = replanRounds(group, [member(2), member(3)], existing);

    expect(replanned.map((r) => r.beneficiaryId)).toEqual(['m-1', 'm-2', 'm-3']);
    expect(replanned.map((r) => r.index)).toEqual([1, 2, 3]);
  });

  it('never shows the same member receiving two pots', () => {
    const existing = build(three).map((r) => (r.index === 1 ? { ...r, paidOutAt: '2026-02-01' } : r));
    // A member joining at the top of the rotation used to duplicate m-1 (kept as
    // history *and* first in the rebuilt slice) while never paying the newcomer.
    const replanned = replanRounds(group, [member(0, { id: 'm-0' }), ...three], existing);
    const beneficiaries = replanned.map((r) => r.beneficiaryId);

    expect(new Set(beneficiaries).size).toBe(beneficiaries.length);
    expect(beneficiaries).toContain('m-0');
    expect(replanned.map((r) => r.index)).toEqual([1, 2, 3, 4]);
  });

  it('is idempotent: replanning an unchanged roster changes nothing', () => {
    const existing = build(three).map((r) => (r.index === 1 ? { ...r, paidOutAt: '2026-02-01' } : r));
    const once = replanRounds(group, three, existing);
    expect(replanRounds(group, three, once)).toEqual(once);
  });

  it('extends the rotation by one round per joining member', () => {
    const existing = build(three);
    const joined = replanRounds(group, [...three, member(4), member(5)], existing);
    expect(joined.map((r) => r.index)).toEqual([1, 2, 3, 4, 5]);
    expect(joined.map((r) => r.dueDate)).toEqual([
      '2026-01-15', '2026-02-15', '2026-03-15', '2026-04-15', '2026-05-15',
    ]);
  });

  it('recomputes dates for rounds nobody has been paid for yet', () => {
    // A member joining at the front shifts who is due when — but only for the
    // rounds that are still ahead.
    const settled = build(three).map((r) => (r.index === 1 ? { ...r, paidOutAt: '2026-02-01' } : r));
    const replanned = replanRounds(group, [member(0, { id: 'm-0' }), ...three], settled);
    expect(replanned.map((r) => r.index)).toEqual([1, 2, 3, 4]);
    expect(replanned[1].beneficiaryId).toBe('m-0');
  });

  it('copes with an inactive member joining the roster', () => {
    const withInactive = [...three, member(4, { active: false })];
    const replanned = replanRounds(group, withInactive, build(three));
    // activeMembers filters the inactive one, so the plan is unchanged.
    expect(replanned.map((r) => r.beneficiaryId)).toEqual(['m-1', 'm-2', 'm-3']);
  });
});

describe('periods and dates', () => {
  it('steps weeks and calendar months', () => {
    expect(addPeriods('2026-01-15', 'weekly', 2)).toBe('2026-01-29');
    expect(addPeriods('2026-01-15', 'biweekly', 1)).toBe('2026-01-29');
    expect(addPeriods('2026-01-15', 'monthly', 3)).toBe('2026-04-15');
  });

  it('clamps to the end of a shorter month', () => {
    // 31 Jan + 1 month is not 31 Feb.
    expect(addPeriods('2026-01-31', 'monthly', 1)).toBe('2026-02-28');
    expect(addPeriods('2024-01-31', 'monthly', 1)).toBe('2024-02-29');
    expect(addPeriods('2026-08-31', 'monthly', 1)).toBe('2026-09-30');
  });

  it('leaves a malformed date untouched rather than inventing one', () => {
    expect(addPeriods('pas-une-date', 'monthly', 1)).toBe('pas-une-date');
  });

  it('formats today as an ISO day', () => {
    expect(todayIso(new Date('2026-09-12T22:00:00.000Z'))).toBe('2026-09-12');
  });
});

describe('rotation and amounts', () => {
  it('follows the agreed order, not the insertion order', () => {
    const members = [member(3), member(1), member(2)];
    expect(rotationOrder(members).map((m) => m.position)).toEqual([1, 2, 3]);
    expect(activeMembers([member(1, { active: false }), member(2)]).map((m) => m.id)).toEqual(['m-2']);
  });

  it('charges by the number of parts held', () => {
    expect(expectedAmount(group, member(1, { shares: 3 }))).toBe(75_000);
    expect(totalShares([member(1, { shares: 2 }), member(2), member(3, { shares: 4, active: false })])).toBe(3);
  });

  it('adds up the pot of a round', () => {
    expect(roundPot(group, [member(1), member(2, { shares: 2 }), member(3, { active: false })])).toBe(75_000);
  });

  it('plans one round per active member, spaced by the frequency, in rotation order', () => {
    const rounds = buildRounds(group, [member(2), member(1), member(3, { active: false })], (n) => `r-${n}`);
    expect(rounds).toEqual([
      { id: 'r-1', groupId: 'grp-1', index: 1, beneficiaryId: 'm-1', dueDate: '2026-01-15' },
      { id: 'r-2', groupId: 'grp-1', index: 2, beneficiaryId: 'm-2', dueDate: '2026-02-15' },
    ]);
  });
});

describe('round progress', () => {
  const members = [member(1), member(2), member(3)];
  const first = round(1, '2026-01-15');

  it('is pending before the due date with nothing collected', () => {
    expect(roundProgress(group, members, first, [], '2026-01-10')).toMatchObject({
      expected: 75_000, collected: 0, outstanding: 75_000, paidMembers: 0, state: 'pending',
    });
  });

  it('is overdue after the due date with nothing collected', () => {
    expect(roundProgress(group, members, first, [], '2026-02-01').state).toBe('overdue');
  });

  it('is partial as soon as something came in', () => {
    const progress = roundProgress(group, members, first, [payment('r-1', 'm-1', 25_000)], '2026-02-01');
    expect(progress).toMatchObject({ collected: 25_000, outstanding: 50_000, paidMembers: 1, state: 'partial' });
  });

  it('is paid once the whole pot is in, even before the due date', () => {
    const payments = members.map((m) => payment('r-1', m.id, 25_000));
    expect(roundProgress(group, members, first, payments, '2026-01-01').state).toBe('paid');
  });

  it('adds up several partial payments from one member', () => {
    const payments = [payment('r-1', 'm-1', 10_000), payment('r-1', 'm-1', 15_000)];
    expect(paidByMember(payments, 'r-1', 'm-1')).toBe(25_000);
    expect(paidByMember(payments, 'r-2', 'm-1')).toBe(0);
  });
});

describe('member ledgers and group summary', () => {
  const members = [member(1, { name: 'Awa' }), member(2, { name: 'Bineta', shares: 2 })];
  const rounds = [round(1, '2026-01-15', 'm-1'), round(2, '2026-02-15', 'm-2')];

  it('shows who owes what over the whole plan and which rounds are short', () => {
    const payments = [
      payment('r-1', 'm-1', 25_000), payment('r-1', 'm-2', 50_000),
      payment('r-2', 'm-1', 10_000),
    ];
    const ledgers = memberLedgers(group, members, rounds, payments);
    expect(ledgers.map((l) => [l.member.name, l.due, l.paid, l.remaining, l.missingRounds])).toEqual([
      ['Awa', 50_000, 35_000, 15_000, [2]],
      ['Bineta', 100_000, 50_000, 50_000, [2]],
    ]);
  });

  it('counts only what is due so far, and names the overdue rounds', () => {
    const summary = groupSummary(group, members, rounds, [payment('r-1', 'm-1', 25_000)], '2026-03-01');
    expect(summary.pot).toBe(75_000);
    expect(summary.shares).toBe(3);
    expect(summary.expectedToDate).toBe(150_000); // two rounds of 75 000
    expect(summary.collected).toBe(25_000);
    expect(summary.outstandingToDate).toBe(125_000);
    expect(summary.overdueRounds).toEqual([1, 2]);
    expect(summary.nextRound?.index).toBe(1);
  });

  it('ignores rounds that have not started yet when summing what is due', () => {
    const summary = groupSummary(group, members, rounds, [], '2026-01-20');
    expect(summary.expectedToDate).toBe(75_000);
    expect(summary.overdueRounds).toEqual([1]);
    expect(summary.nextRound?.index).toBe(1);
  });

  it('reports nothing overdue once every started round is settled', () => {
    const payments = [1, 2].flatMap((index) => members.map((m) => payment(`r-${index}`, m.id, expectedAmount(group, m))));
    const summary = groupSummary(group, members, rounds, payments, '2026-03-01');
    expect(summary.outstandingToDate).toBe(0);
    expect(summary.overdueRounds).toEqual([]);
    expect(summary.nextRound).toBeNull();
  });
});

describe('receipts', () => {
  const members = [member(1), member(2)];
  const first = round(1, '2026-01-15');

  it('numbers a receipt deterministically from group, round and member', () => {
    // Prefix = first four letters of the group name, then round, then position.
    const number = receiptNumber(group, members[0], first);
    expect(number).toBe('TONT-R01-M01');
    expect(receiptNumber(group, members[0], first)).toBe(number);
    expect(receiptNumber(group, members[1], first)).toBe('TONT-R01-M02');
    expect(receiptNumber(group, members[0], round(2, '2026-02-15'))).toBe('TONT-R02-M01');
  });

  it('falls back to the group id when the name has no usable letters', () => {
    const odd: TontineGroup = { ...group, name: '«»', id: 'grp-ab12' };
    expect(receiptNumber(odd, members[0], first)).toBe('AB12-R01-M01');
  });

  it('flags a complete payment and keeps the remaining amount otherwise', () => {
    const partial = buildReceipt(group, members[0], first, payment('r-1', 'm-1', 10_000), [payment('r-1', 'm-1', 10_000)]);
    expect(partial).toMatchObject({ amount: 10_000, complete: false, remaining: 15_000, roundIndex: 1, shares: 1 });

    const full = buildReceipt(group, members[0], first, payment('r-1', 'm-1', 25_000), [payment('r-1', 'm-1', 25_000)]);
    expect(full).toMatchObject({ complete: true, remaining: 0 });
  });

  it('renders a copy-pasteable text, mentioning what is left only when partial', () => {
    const strings = {
      amount: '10 000 F CFA', remaining: '15 000 F CFA', date: '15/01/2026', title: 'REÇU TONTINE',
      lines: {
        number: 'N°', member: 'Membre', round: 'Tour', shares: 'Parts', amount: 'Versement',
        date: 'Date', method: 'Moyen', remaining: 'Reste à payer', 'method.cash': 'Espèces',
      },
    };
    const text = receiptText(buildReceipt(group, members[0], first, payment('r-1', 'm-1', 10_000), [payment('r-1', 'm-1', 10_000)]), strings);
    expect(text).toContain('REÇU TONTINE');
    expect(text).toContain('N°: TONT-R01-M01');
    expect(text).toContain('10 000 F CFA');
    expect(text).toContain('Espèces');
    expect(text).toContain('Reste à payer: 15 000 F CFA');

    const complete = receiptText(buildReceipt(group, members[0], first, payment('r-1', 'm-1', 25_000), [payment('r-1', 'm-1', 25_000)]), strings);
    expect(complete).not.toContain('Reste à payer');
  });
});

describe('validation', () => {
  const members = [member(1)];

  it('accepts a well-formed group and rejects the empty one', () => {
    expect(validateGroupDraft({ ...emptyGroupDraft('XOF', '2026-01-15'), name: 'Tontine', contribution: '25000' })).toEqual([]);
    const errors = validateGroupDraft(emptyGroupDraft('XOF', '2026-01-15'));
    expect(errors).toContain(frTranslate('errors.tontine.nameRequired'));
    expect(errors).toContain(frTranslate('errors.tontine.contributionPositive'));
    expect(validateGroupDraft({ ...emptyGroupDraft('XOF', '15/01/2026'), name: 'x', contribution: '0' }))
      .toContain(frTranslate('errors.tontine.startDate'));
    expect(validateGroupDraft({ ...emptyGroupDraft('XOF', '2026-01-15'), name: 'x', contribution: '1000', frequency: 'daily' as never }))
      .toContain(frTranslate('errors.tontine.frequency'));
  });

  it('rejects a member whose rotation position is taken', () => {
    expect(validateMemberDraft({ ...emptyMemberDraft(2), name: 'Nouvelle' }, members)).toEqual([]);
    expect(validateMemberDraft({ ...emptyMemberDraft(1), name: 'Nouvelle' }, members)).toContain(frTranslate('errors.tontine.positionTaken'));
    expect(validateMemberDraft({ ...emptyMemberDraft(3), name: '' }, members)).toContain(frTranslate('errors.tontine.memberNameRequired'));
    expect(validateMemberDraft({ ...emptyMemberDraft(3), shares: '0' }, members)).toContain(frTranslate('errors.tontine.sharesRange'));
    expect(validateMemberDraft({ ...emptyMemberDraft(3), shares: '2.5' }, members)).toContain(frTranslate('errors.tontine.sharesRange'));
    expect(validateMemberDraft({ ...emptyMemberDraft(3), phone: 'abc' }, members)).toContain(frTranslate('errors.tontine.phone'));
    expect(validateMemberDraft({ ...emptyMemberDraft(1), name: 'Membre 1', position: '1' }, members)).toEqual(
      expect.arrayContaining([frTranslate('errors.tontine.positionTaken')])
    );
  });

  it('rejects an impossible payment', () => {
    const context = { group, member: members[0], round: round(1, '2026-01-15'), roundPayments: [] };
    expect(validatePaymentDraft(emptyPaymentDraft('m-1', 25_000, '2026-01-15'), context)).toEqual([]);
    expect(validatePaymentDraft(emptyPaymentDraft('', 25_000, '2026-01-15'), context)).toContain(frTranslate('errors.tontine.memberRequired'));
    expect(validatePaymentDraft(emptyPaymentDraft('m-1', 0, '2026-01-15'), context)).toContain(frTranslate('errors.tontine.amountPositive'));
    expect(validatePaymentDraft(emptyPaymentDraft('m-1', 25_000, '2026-01-14'), context)).toContain(frTranslate('errors.tontine.dateBeforeStart'));
    expect(validatePaymentDraft(emptyPaymentDraft('m-1', 25_000, '2950'), context)).toContain(frTranslate('errors.tontine.dateInvalid'));
  });

  it('refuses more than what the round is worth', () => {
    const context = {
      group, member: members[0], round: round(1, '2026-01-15'),
      roundPayments: [payment('r-1', 'm-1', 20_000)],
    };
    const draft = emptyPaymentDraft('m-1', 10_000, '2026-01-15');
    expect(validatePaymentDraft(draft, context)).toContain(frTranslate('errors.tontine.overpaid'));
    expect(validatePaymentDraft({ ...draft, amount: '5000' }, context)).toEqual([]);
  });

  it('flags a payment dated in the future', () => {
    const context = { group, member: members[0], round: round(1, '2026-01-15'), roundPayments: [] };
    const tomorrow = todayIso(new Date(Date.now() + 86_400_000));
    expect(validatePaymentDraft(emptyPaymentDraft('m-1', 5_000, tomorrow), context)).toContain(frTranslate('errors.tontine.dateFuture'));
  });
});
