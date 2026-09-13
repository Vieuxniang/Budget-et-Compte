/**
 * Content packs tests. The payroll estimate feeds real household decisions, so
 * the invariants are pinned here: bands are progressive, contributions respect
 * their ceiling, a template always balances to the income, and the plan gate
 * never hides a pack that is already installed.
 */

import { describe, expect, it } from 'vitest';
import {
  PACKS, addInstalled, canInstall, computePayroll, findPack, installedEntry, installedPackIds,
  isInstalled,
  monthlyIncomeBaseline, packCategoryId, packLimit, removeInstalled, templateAllocations,
  withholdingRate,
} from './packs';
import type { InstalledPack } from './packs';
import type { Transaction } from '../types';

const senegal = findPack('sn-2025')!;

function tx(date: string, amount: number, type: Transaction['type']): Transaction {
  return { id: `t-${date}-${amount}`, date, title: 'x', amount, type, category: 'c', accountId: 'a', member: '' };
}

describe('catalog', () => {
  it('ships packs whose budget templates each balance to 100 %', () => {
    expect(PACKS.length).toBeGreaterThan(0);
    for (const pack of PACKS) {
      const sum = pack.budget.reduce((total, line) => total + line.share, 0);
      expect(Math.abs(sum - 1)).toBeLessThan(1e-9);
      expect(pack.budget.every((line) => line.share > 0)).toBe(true);
      expect(pack.currency).toMatch(/^[A-Z]{3}$/);
      expect(pack.asOf).toMatch(/^\d{4}$/);
    }
  });

  it('gives every pack a unique id and at least one budget line', () => {
    const ids = PACKS.map((pack) => pack.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const pack of PACKS) {
      expect(pack.budget.length).toBeGreaterThan(0);
      expect(pack.id).toContain(pack.country.toLowerCase());
    }
  });

  it('exposes payroll bands ordered by increasing upper bound, top band open', () => {
    for (const pack of PACKS) {
      const brackets = pack.payroll?.brackets ?? [];
      const bounds = brackets.map((bracket) => bracket.upTo);
      expect(bounds[bounds.length - 1]).toBeNull();
      for (let i = 1; i < bounds.length; i += 1) {
        const previous = bounds[i - 1] ?? Number.POSITIVE_INFINITY;
        expect(bounds[i] === null || bounds[i]! > previous).toBe(true);
      }
    }
  });

  it('exposes school levels that cost more in private than in public', () => {
    for (const pack of PACKS) {
      for (const level of pack.schoolFees ?? []) {
        expect(level.privateFee).toBeGreaterThan(level.publicFee);
        expect(level.supplies).toBeGreaterThan(0);
      }
    }
  });
});

describe('plan gate', () => {
  it('lets the free offer install exactly one pack', () => {
    expect(packLimit('free')).toBe(1);
    expect(canInstall('free', 0)).toBe(true);
    expect(canInstall('free', 1)).toBe(false);
  });

  it('gives the paid plans the whole catalog', () => {
    expect(packLimit('pro')).toBe(PACKS.length);
    expect(packLimit('association')).toBe(PACKS.length);
    expect(canInstall('pro', PACKS.length)).toBe(false);
    expect(canInstall('pro', PACKS.length - 1)).toBe(true);
  });
});

describe('payroll estimate', () => {
  it('withholds nothing on a zero salary', () => {
    const result = computePayroll(0, senegal.payroll!);
    expect(result).toMatchObject({ gross: 0, contributionTotal: 0, tax: 0, net: 0 });
    expect(withholdingRate(result)).toBe(0);
  });

  it('keeps every band below the first taxable one free of income tax', () => {
    // 50 000 is the top of Senegal's 0 % band; the professional allowance only
    // lowers the base further, so the income tax must be zero there.
    expect(computePayroll(50_000, senegal.payroll!).tax).toBe(0);
    expect(computePayroll(120_000, senegal.payroll!).tax).toBeGreaterThan(0);
  });

  it('caps a contribution at its ceiling instead of taxing the whole salary', () => {
    const rules = senegal.payroll!;
    const capped = rules.employee.find((line) => line.ceiling)!;
    const result = computePayroll(2_000_000, rules);
    const line = result.contributions.find((item) => item.key === capped.key)!;
    expect(line.amount).toBe(Math.round(capped.ceiling! * capped.rate));
  });

  it('is progressive: the tax never drops when the salary rises', () => {
    const rules = senegal.payroll!;
    let previous = -1;
    for (let gross = 0; gross <= 1_500_000; gross += 50_000) {
      const { tax } = computePayroll(gross, rules);
      expect(tax).toBeGreaterThanOrEqual(previous);
      previous = tax;
    }
  });

  it('reduces the tax with dependents, never below zero', () => {
    const rules = senegal.payroll!;
    const alone = computePayroll(300_000, rules, 0);
    const family = computePayroll(300_000, rules, 4);
    expect(family.tax).toBeLessThan(alone.tax);
    expect(family.relief).toBe(4 * (rules.dependentRelief ?? 0));
    expect(computePayroll(60_000, rules, 40).tax).toBe(0);
  });

  it('balances: net is the gross minus everything withheld', () => {
    const result = computePayroll(450_000, senegal.payroll!, 2);
    expect(result.net).toBe(result.gross - result.contributionTotal - result.tax);
    expect(result.taxableBase).toBeLessThanOrEqual(result.gross);
    expect(withholdingRate(result)).toBeGreaterThan(0);
    expect(withholdingRate(result)).toBeLessThan(1);
  });

  it('is deterministic — the same salary always gives the same estimate', () => {
    expect(computePayroll(275_000, senegal.payroll!, 3)).toEqual(computePayroll(275_000, senegal.payroll!, 3));
  });
});

describe('budget templates', () => {
  it('allocates exactly the monthly income, whatever the rounding', () => {
    for (const pack of PACKS) {
      for (const income of [0, 1, 999, 250_000, 333_333, 1_000_001]) {
        const lines = templateAllocations(pack, income);
        expect(lines.reduce((sum, line) => sum + line.allocated, 0)).toBe(income);
        expect(lines.every((line) => line.allocated >= 0)).toBe(true);
      }
    }
  });

  it('gives a zero income zeroed lines rather than negative ones', () => {
    expect(templateAllocations(senegal, 0).every((line) => line.allocated === 0)).toBe(true);
  });

  it('derives category ids that cannot collide across packs or installs', () => {
    expect(packCategoryId('sn-2025', 'food')).toBe('pck-sn-2025-food');
    expect(packCategoryId('ci-2025', 'food')).not.toBe(packCategoryId('sn-2025', 'food'));
  });

  it('suggests a monthly income from the ledger, ignoring expenses and stale income', () => {
    const transactions = [
      tx('2026-07-05', 300_000, 'income'),
      tx('2026-08-05', 300_000, 'income'),
      tx('2026-09-05', 300_000, 'income'),
      tx('2026-08-06', 80_000, 'expense'),
      tx('2025-01-05', 900_000, 'income'),
    ];
    expect(monthlyIncomeBaseline(transactions, '2026-09-12')).toBe(300_000);
    expect(monthlyIncomeBaseline([], '2026-09-12')).toBe(0);
  });
});

describe('install bookkeeping', () => {
  const entry = (id: string, version = 1): InstalledPack => ({
    id,
    version,
    installedAt: '2026-09-12',
  });

  it('adds a pack once and updates it in place afterwards', () => {
    const once = addInstalled([], entry('sn-2025'));
    const twice = addInstalled(once, entry('sn-2025'));
    expect(twice).toHaveLength(1);
    expect(addInstalled(once, entry('sn-2025', 2))[0].version).toBe(2);
  });

  it('treats a missing list as empty, so a fresh install needs no migration', () => {
    expect(installedPackIds(undefined).size).toBe(0);
    expect(isInstalled(undefined, 'sn-2025')).toBe(false);
    expect(addInstalled(undefined, entry('ci-2025'))).toHaveLength(1);
  });

  it('removes only the requested pack', () => {
    const list = [entry('sn-2025'), entry('ci-2025')];
    const left = removeInstalled(list, 'sn-2025');
    expect(left.map((item) => item.id)).toEqual(['ci-2025']);
    expect(removeInstalled(left, 'unknown')).toHaveLength(1);
  });

  it('builds the entry a fresh install records, dated today', () => {
    const pack = findPack('sn-2025')!;
    expect(installedEntry(undefined, pack, undefined, '2026-09-13')).toEqual({
      id: 'sn-2025',
      version: pack.version,
      installedAt: '2026-09-13',
    });
  });

  it('re-installing keeps the original date and refreshes the version and categories', () => {
    const pack = findPack('sn-2025')!;
    const first = installedEntry(undefined, pack, ['a'], '2026-01-01');
    const again = installedEntry([first], { ...pack, version: pack.version + 1 }, ['a', 'b'], '2026-09-13');

    expect(again.installedAt).toBe('2026-01-01'); // history is not rewritten
    expect(again.version).toBe(pack.version + 1);
    expect(again.categoryIds).toEqual(['a', 'b']);
  });

  it('omits the categories field when a pack created none', () => {
    const pack = findPack('sn-2025')!;
    expect(installedEntry(undefined, pack, [], '2026-09-13')).not.toHaveProperty('categoryIds');
  });
});
