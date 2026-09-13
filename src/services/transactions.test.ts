import { describe, it, expect } from 'vitest';
import {
  validateDraft, draftToTransaction, transactionToDraft, emptyDraft,
  applyFilters, emptyFilters, sortByDateDesc, distinctValues, distinctMonths,
  flowOf, summarize, toCsv, generateTxId,
} from './transactions';
import { Transaction } from '../types';

const accountIds = new Set(['a', 'b', 'c']);

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

describe('validateDraft', () => {
  const base = {
    date: '2026-09-05',
    title: 'Courses',
    amount: 25000,
    type: 'expense' as const,
    category: 'Alimentation',
    accountId: 'a',
    member: 'Papa',
  };

  it('accepts a valid expense', () => {
    expect(validateDraft(base, accountIds)).toEqual([]);
  });

  it('requires a destination account for transfers', () => {
    const errs = validateDraft({ ...base, type: 'transfer' }, accountIds);
    expect(errs.map((e) => e.field)).toContain('toAccountId');
  });

  it('rejects self-transfers', () => {
    const errs = validateDraft({ ...base, type: 'transfer', toAccountId: 'a' }, accountIds);
    expect(errs.map((e) => e.field)).toContain('toAccountId');
  });

  it('rejects unknown destination accounts', () => {
    const errs = validateDraft({ ...base, toAccountId: 'ghost', type: 'transfer' }, accountIds);
    expect(errs.map((e) => e.field)).toContain('toAccountId');
  });

  it('rejects zero and negative amounts', () => {
    expect(validateDraft({ ...base, amount: 0 }, accountIds).map((e) => e.field)).toContain('amount');
    expect(validateDraft({ ...base, amount: -100 }, accountIds).map((e) => e.field)).toContain('amount');
  });

  it('rejects missing title, category, account, member', () => {
    const errs = validateDraft({ ...base, title: '  ', category: '', accountId: '', member: '' }, accountIds);
    const fields = errs.map((e) => e.field);
    expect(fields).toContain('title');
    expect(fields).toContain('category');
    expect(fields).toContain('accountId');
    expect(fields).toContain('member');
  });

  it('rejects malformed dates', () => {
    expect(validateDraft({ ...base, date: '05/09/2026' }, accountIds).map((e) => e.field)).toContain('date');
  });
});

describe('draft <-> transaction round-trip', () => {
  it('keeps all fields', () => {
    const draft = { ...emptyDraft(), title: 'Test', amount: 1000, category: 'Divers', accountId: 'a' };
    const t = draftToTransaction(draft);
    expect(transactionToDraft(t)).toEqual({ ...draft, amount: 1000 });
  });

  it('strips whitespace from title, category and member', () => {
    const t = draftToTransaction({ ...emptyDraft(), title: '  X ', category: ' C ', accountId: 'a', member: ' M ' });
    expect(t.title).toBe('X');
  });

  it('omits toAccountId for non-transfers and keeps it for transfers', () => {
    const expense = draftToTransaction({ ...emptyDraft(), title: 'X', category: 'D', accountId: 'a', toAccountId: 'b' });
    expect(expense.toAccountId).toBeUndefined();

    const transfer = draftToTransaction({ ...emptyDraft(), title: 'X', category: 'D', accountId: 'a', toAccountId: 'b', type: 'transfer' });
    expect(transfer.toAccountId).toBe('b');
  });

  it('preserves the id when updating an existing transaction', () => {
    const t = draftToTransaction({ ...emptyDraft(), title: 'X', category: 'D', accountId: 'a' }, 'tx-fixed');
    expect(t.id).toBe('tx-fixed');
  });
});

describe('filters', () => {
  const txs = [
    tx({ id: '1', date: '2026-09-01', type: 'income', amount: 100000, category: 'Revenus', member: 'Maman' }),
    tx({ id: '2', date: '2026-08-20', type: 'expense', category: 'Transport', member: 'Papa', accountId: 'b' }),
    tx({ id: '3', date: '2026-09-10', type: 'transfer', accountId: 'a', toAccountId: 'b' }),
    tx({ id: '4', date: '2026-09-15', type: 'expense', title: 'Marché central', member: 'Papa' }),
  ];

  it('filters by type', () => {
    expect(applyFilters(txs, { ...emptyFilters(), type: 'income' }).map((t) => t.id)).toEqual(['1']);
  });

  it('matches either leg of transfers when filtering by account', () => {
    const out = applyFilters(txs, { ...emptyFilters(), accountId: 'b' });
    expect(out.map((t) => t.id).sort()).toEqual(['2', '3']);
  });

  it('filters by member', () => {
    expect(applyFilters(txs, { ...emptyFilters(), member: 'Papa' }).map((t) => t.id).sort()).toEqual(['2', '4']);
  });

  it('filters by month (YYYY-MM prefix)', () => {
    expect(applyFilters(txs, { ...emptyFilters(), month: '2026-08' }).map((t) => t.id)).toEqual(['2']);
  });

  it('searches title and category case-insensitively', () => {
    expect(applyFilters(txs, { ...emptyFilters(), search: 'marché' }).map((t) => t.id)).toEqual(['4']);
    expect(applyFilters(txs, { ...emptyFilters(), search: 'REVENUS' }).map((t) => t.id)).toEqual(['1']);
  });

  it('combines filters with AND logic', () => {
    const out = applyFilters(txs, { ...emptyFilters(), type: 'expense', member: 'Papa' });
    expect(out.map((t) => t.id).sort()).toEqual(['2', '4']);
  });

  it('returns everything with empty filters', () => {
    expect(applyFilters(txs, emptyFilters()).length).toBe(txs.length);
  });
});

describe('sorting and distinct values', () => {
  const txs = [
    tx({ id: '1', date: '2026-09-10' }),
    tx({ id: '2', date: '2026-09-01' }),
    tx({ id: '3', date: '2026-09-10' }),
  ];

  it('sorts newest first with id tiebreaker', () => {
    expect(sortByDateDesc(txs).map((t) => t.id)).toEqual(['3', '1', '2']);
  });

  it('does not mutate the input array', () => {
    const copy = [...txs];
    sortByDateDesc(txs);
    expect(txs).toEqual(copy);
  });

  it('lists distinct members and categories', () => {
    const txs = [
      tx({ member: 'Papa', category: 'Transport' }),
      tx({ member: 'Maman', category: 'Alimentation' }),
      tx({ member: 'Papa', category: 'Alimentation' }),
    ];
    expect(distinctValues(txs, 'member')).toEqual(['Maman', 'Papa']);
    expect(distinctValues(txs, 'category')).toEqual(['Alimentation', 'Transport']);
  });

  it('lists distinct months newest first', () => {
    const txs = [
      tx({ date: '2026-09-01' }),
      tx({ date: '2026-08-31' }),
      tx({ date: '2026-09-15' }),
    ];
    expect(distinctMonths(txs)).toEqual(['2026-09', '2026-08']);
  });
});

describe('summarize', () => {
  it('computes income, expenses, net and transfer count', () => {
    const txs = [
      tx({ type: 'income', amount: 500000 }),
      tx({ type: 'expense', amount: 120000 }),
      tx({ type: 'expense', amount: 30000 }),
      tx({ type: 'transfer', amount: 50000 }),
    ];
    const s = summarize(txs);
    expect(s.income).toBe(500000);
    expect(s.expenses).toBe(150000);
    expect(s.net).toBe(350000);
    expect(s.transfers).toBe(1);
  });

  it('counts transfers as zero flow', () => {
    expect(flowOf(tx({ type: 'transfer', amount: 999999 }))).toBe(0);
  });
});

describe('toCsv', () => {
  it('produces semicolon-separated rows with account names', () => {
    const csv = toCsv([tx({ title: 'Courses; urgent', accountId: 'a', toAccountId: 'b', type: 'transfer' })], (id) => `Nom ${id}`);
    const lines = csv.split('\n');
    expect(lines[0]).toBe('id;date;titre;montant;type;categorie;compte;versCompte;membre');
    expect(lines[1]).toContain('"Courses; urgent"');
    expect(lines[1]).toContain('Nom a');
    expect(lines[1]).toContain('Nom b');
  });
});

describe('generateTxId', () => {
  it('generates unique ids', () => {
    const ids = new Set(Array.from({ length: 50 }, () => generateTxId()));
    expect(ids.size).toBe(50);
  });
});
