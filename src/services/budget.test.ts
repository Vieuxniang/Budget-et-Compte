import { describe, it, expect } from 'vitest';
import {
  budgetSummary, expensesForMonth, incomeForMonth, monthLabel, currentMonthIso,
} from './budget';
import { BudgetCategory, Transaction } from '../types';

const cat = (id: string, name: string, allocated: number, color = '#3B82F6'): BudgetCategory => ({
  id, name, type: 'needs', allocated, color,
});

let seq = 0;
const tx = (overrides: Partial<Transaction> = {}): Transaction => ({
  id: `tx-${(seq += 1)}`,
  date: '2026-09-05',
  title: `Op ${seq}`,
  amount: 10000,
  type: 'expense',
  category: 'Divers',
  accountId: 'a',
  member: 'Famille',
  ...overrides,
});

const categories = [
  cat('c1', 'Alimentation & Ration', 400000),
  cat('c2', 'Logement & Loyer', 350000),
  cat('c3', 'Loisirs & Sorties', 150000),
];

describe('expensesForMonth / incomeForMonth', () => {
  it('groups by YYYY-MM prefix and excludes other months', () => {
    const txs = [
      tx({ date: '2026-09-01' }),
      tx({ date: '2026-08-31' }),
      tx({ date: '2026-09-30' }),
      tx({ date: '2026-10-01' }),
    ];
    expect(expensesForMonth(txs, '2026-09').length).toBe(2);
  });

  it('excludes income and transfers from expenses', () => {
    const txs = [
      tx({ type: 'expense' }),
      tx({ type: 'income' }),
      tx({ type: 'transfer', toAccountId: 'b' }),
    ];
    expect(expensesForMonth(txs, '2026-09').length).toBe(1);
  });

  it('sums income only', () => {
    const txs = [
      tx({ type: 'income', amount: 500000 }),
      tx({ type: 'expense', amount: 100000 }),
      tx({ type: 'transfer', amount: 999999, toAccountId: 'b' }),
    ];
    expect(incomeForMonth(txs, '2026-09')).toBe(500000);
  });
});

describe('budgetSummary', () => {
  it('computes spent, remaining and usage per category', () => {
    const txs = [
      tx({ category: 'Alimentation & Ration', amount: 250000 }),
      tx({ category: 'Alimentation & Ration', amount: 50000 }),
      tx({ category: 'Logement & Loyer', amount: 350000 }),
    ];
    const s = budgetSummary(categories, txs, '2026-09');

    const alim = s.statuses.find((st) => st.category.name === 'Alimentation & Ration')!;
    expect(alim.spent).toBe(300000);
    expect(alim.remaining).toBe(100000);
    expect(alim.usagePct).toBeCloseTo(75, 5);
    expect(alim.isOver).toBe(false);

    const logement = s.statuses.find((st) => st.category.name === 'Logement & Loyer')!;
    expect(logement.isOver).toBe(false); // spent exactly allocated is not over
    expect(logement.remaining).toBe(0);
  });

  it('marks exactly-equal spend as not over budget', () => {
    const txs = [tx({ category: 'Logement & Loyer', amount: 350000 })];
    const s = budgetSummary(categories, txs, '2026-09');
    const logement = s.statuses.find((st) => st.category.name === 'Logement & Loyer')!;
    expect(logement.isOver).toBe(false);
    expect(logement.remaining).toBe(0);
  });

  it('sorts over-budget categories first, then by usage', () => {
    const txs = [
      tx({ category: 'Logement & Loyer', amount: 400000 }), // 114% over
      tx({ category: 'Alimentation & Ration', amount: 380000 }), // 95%
      tx({ category: 'Loisirs & Sorties', amount: 0 }), // 0%
    ];
    const s = budgetSummary(categories, txs, '2026-09');
    expect(s.statuses[0].category.name).toBe('Logement & Loyer');
    expect(s.statuses[1].category.name).toBe('Alimentation & Ration');
    expect(s.statuses[2].category.name).toBe('Loisirs & Sorties');
    expect(s.overCount).toBe(1);
  });

  it('collects unbudgeted spending, biggest first', () => {
    const txs = [
      tx({ category: 'Cadeaux', amount: 20000 }),
      tx({ category: 'Santé', amount: 45000 }),
      tx({ category: 'Alimentation & Ration', amount: 100000 }),
    ];
    const s = budgetSummary(categories, txs, '2026-09');
    expect(s.unbudgeted.map((u) => u.name)).toEqual(['Santé', 'Cadeaux']);
    expect(s.unbudgeted[0].spent).toBe(45000);
  });

  it('excludes transfers and income from spending', () => {
    const txs = [
      tx({ type: 'transfer', amount: 500000, toAccountId: 'b', category: 'Alimentation & Ration' }),
      tx({ type: 'income', amount: 999999, category: 'Alimentation & Ration' }),
    ];
    const s = budgetSummary(categories, txs, '2026-09');
    const alim = s.statuses.find((st) => st.category.name === 'Alimentation & Ration')!;
    expect(alim.spent).toBe(0);
  });

  it('totals allocated and spent across categories', () => {
    const txs = [
      tx({ category: 'Alimentation & Ration', amount: 100000 }),
      tx({ category: 'Loisirs & Sorties', amount: 50000 }),
    ];
    const s = budgetSummary(categories, txs, '2026-09');
    expect(s.allocated).toBe(900000);
    expect(s.spent).toBe(150000);
    expect(s.remaining).toBe(750000);
    expect(s.income).toBe(0);
  });

  it('handles categories with zero allocation (usagePct null)', () => {
    const zeroCats = [cat('z', 'Gratuit', 0)];
    const s = budgetSummary(zeroCats, [tx({ category: 'Gratuit', amount: 5000 })], '2026-09');
    expect(s.statuses[0].usagePct).toBeNull();
    expect(s.statuses[0].isOver).toBe(true);
  });
});

describe('monthLabel', () => {
  it('formats YYYY-MM in French', () => {
    expect(monthLabel('2026-09')).toBe('Septembre 2026');
    expect(monthLabel('2026-01')).toBe('Janvier 2026');
    expect(monthLabel('2026-12')).toBe('Décembre 2026');
  });

  it('falls back for malformed input', () => {
    expect(monthLabel('all')).toBe('all');
    expect(monthLabel('2026-13')).toBe('2026-13');
  });
});

describe('currentMonthIso', () => {
  it('returns a YYYY-MM string', () => {
    expect(currentMonthIso()).toMatch(/^\d{4}-\d{2}$/);
  });
});
