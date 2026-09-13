import { describe, it, expect } from 'vitest';
import {
  signedAmount,
  balanceOf,
  netWorth,
  netWorthBreakdown,
  balancesByAccountId,
  validateLedger,
} from './ledger';
import { Account, Transaction } from '../types';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

let accSeq = 0;
function makeAccount(overrides: Partial<Account> = {}): Account {
  accSeq += 1;
  return {
    id: `acc-${accSeq}`,
    name: `Compte ${accSeq}`,
    type: 'checking',
    holder: 'Famille',
    initialBalance: 0,
    currency: 'FCFA',
    institution: 'Banque Test',
    ...overrides,
  };
}

let txSeq = 0;
function makeTx(overrides: Partial<Transaction> = {}): Transaction {
  txSeq += 1;
  return {
    id: `tx-${txSeq}`,
    date: '2026-09-01',
    title: `Transaction ${txSeq}`,
    amount: 10000,
    type: 'expense',
    category: 'Divers',
    accountId: 'a',
    member: 'Famille',
    ...overrides,
  };
}

const accounts = [makeAccount({ id: 'a' }), makeAccount({ id: 'b', type: 'savings' })];

// ---------------------------------------------------------------------------
// signedAmount
// ---------------------------------------------------------------------------

describe('signedAmount', () => {
  it('income is positive, expense negative, transfer nets to zero', () => {
    expect(signedAmount(makeTx({ type: 'income', amount: 5000 }))).toBe(5000);
    expect(signedAmount(makeTx({ type: 'expense', amount: 5000 }))).toBe(-5000);
    expect(signedAmount(makeTx({ type: 'transfer', amount: 7000 }))).toBe(0);
  });

  it('normalizes negative input amounts to the correct sign', () => {
    expect(signedAmount(makeTx({ type: 'income', amount: -5000 }))).toBe(5000);
    expect(signedAmount(makeTx({ type: 'expense', amount: -5000 }))).toBe(-5000);
  });
});

// ---------------------------------------------------------------------------
// balanceOf — derived balances
// ---------------------------------------------------------------------------

describe('balanceOf', () => {
  it('starts from initialBalance with no transactions', () => {
    const accs = [makeAccount({ id: 'a', initialBalance: 750000 })];
    expect(balanceOf(accs, [], 'a')).toBe(750000);
  });

  it('throws on unknown account', () => {
    expect(() => balanceOf([makeAccount({ id: 'a' })], [], 'ghost')).toThrow(/inconnu/i);
  });

  it('applies income and expenses to the correct account only', () => {
    const txs = [
      makeTx({ accountId: 'a', type: 'income', amount: 30000 }),
      makeTx({ accountId: 'b', type: 'expense', amount: 5000 }),
    ];
    expect(balanceOf(accounts, txs, 'a')).toBe(30000);
    expect(balanceOf(accounts, txs, 'b')).toBe(-5000);
  });

  it('moves money for transfers: out of source, into destination, zero net', () => {
    const txs = [
      makeTx({ accountId: 'a', toAccountId: 'b', type: 'transfer', amount: 40000 }),
    ];
    expect(balanceOf(accounts, txs, 'a')).toBe(-40000);
    expect(balanceOf(accounts, txs, 'b')).toBe(40000);
    expect(netWorth(accounts, txs)).toBe(0);
  });

  it('ignores transactions on or after the asOf cutoff (exclusive)', () => {
    const txs = [
      makeTx({ id: 't1', date: '2026-08-31', type: 'income', amount: 10000 }),
      makeTx({ id: 't2', date: '2026-09-30', type: 'income', amount: 20000 }),
      makeTx({ id: 't3', date: '2026-10-01', type: 'income', amount: 40000 }),
    ];
    // Through September: includes t1 and t2 (2026-10-01 excluded).
    expect(balanceOf(accounts, txs, 'a', '2026-10-01')).toBe(30000);
    // Full history (no cutoff).
    expect(balanceOf(accounts, txs, 'a')).toBe(70000);
  });

  it('is order-independent: same balance whichever way txs are sorted', () => {
    const txs = [
      makeTx({ id: 't1', date: '2026-09-10', type: 'expense', amount: 5000 }),
      makeTx({ id: 't2', date: '2026-09-01', type: 'income', amount: 50000 }),
      makeTx({ id: 't3', date: '2026-09-20', type: 'expense', amount: 20000 }),
    ];
    const forward = balanceOf(accounts, txs, 'a');
    const reversed = balanceOf(accounts, [...txs].reverse(), 'a');
    expect(forward).toBe(reversed);
    expect(forward).toBe(25000);
  });

  it('handles an incoming transfer leg whose accountId belongs to another account', () => {
    const txs = [
      makeTx({ accountId: 'a', toAccountId: 'b', type: 'transfer', amount: 12000 }),
    ];
    // 'b' receives even though tx.accountId is 'a'.
    expect(balanceOf(accounts, txs, 'b')).toBe(12000);
  });
});

// ---------------------------------------------------------------------------
// Net worth & loans
// ---------------------------------------------------------------------------

describe('netWorth and liabilities', () => {
  it('counts loan accounts negatively in net worth', () => {
    const accs = [
      makeAccount({ id: 'cash', initialBalance: 5000000 }),
      makeAccount({ id: 'loan', type: 'loan', initialBalance: 1800000 }),
    ];
    expect(netWorth(accs, [])).toBe(3200000);
  });

  it('loan repayments reduce the remaining debt', () => {
    const accs = [
      makeAccount({ id: 'cash', initialBalance: 1000000 }),
      makeAccount({ id: 'loan', type: 'loan', initialBalance: 1800000 }),
    ];
    // Repayment: money leaves cash; loan balance itself only changes if you
    // book the principal portion against the loan account directly.
    const txs = [makeTx({ accountId: 'cash', type: 'expense', amount: 125000 })];
    expect(balanceOf(accs, txs, 'loan')).toBe(1800000);
    expect(balanceOf(accs, txs, 'cash')).toBe(875000);
  });

  it('booking principal repayment against the loan reduces the liability', () => {
    const accs = [
      makeAccount({ id: 'cash', initialBalance: 1000000 }),
      makeAccount({ id: 'loan', type: 'loan', initialBalance: 1800000 }),
    ];
    // Principal leg booked directly on the loan account (expense against debt).
    const txs = [makeTx({ accountId: 'loan', type: 'expense', amount: 100000 })];
    expect(balanceOf(accs, txs, 'loan')).toBe(1700000);
    const b = netWorthBreakdown(accs, txs);
    expect(b.liabilities).toBe(1700000);
    expect(b.net).toBe(1000000 - 1700000);
  });

  it('netWorthBreakdown splits assets, liabilities and net correctly', () => {
    const accs = [
      makeAccount({ id: 'cash', initialBalance: 2000000 }),
      makeAccount({ id: 'save', type: 'savings', initialBalance: 3000000 }),
      makeAccount({ id: 'debt', type: 'loan', initialBalance: 1200000 }),
    ];
    const b = netWorthBreakdown(accs, []);
    expect(b.assets).toBe(5000000);
    expect(b.liabilities).toBe(1200000);
    expect(b.net).toBe(3800000);
    expect(b.liabilityAccountIds).toEqual(['debt']);
  });

  it('net worth is transfer-invariant: any series of transfers keeps it constant', () => {
    const accs = [
      makeAccount({ id: 'cash', initialBalance: 1000000 }),
      makeAccount({ id: 'save', type: 'savings', initialBalance: 250000 }),
      makeAccount({ id: 'debt', type: 'loan', initialBalance: 800000 }),
    ];
    const before = netWorth(accs, []);
    const txs = [
      makeTx({ id: 'x1', accountId: 'cash', toAccountId: 'save', type: 'transfer', amount: 300000 }),
      makeTx({ id: 'x2', accountId: 'save', toAccountId: 'cash', type: 'transfer', amount: 75000 }),
    ];
    expect(netWorth(accs, txs)).toBe(before);
    expect(before).toBe(1000000 + 250000 - 800000);
  });

  it('supports asOf snapshots: past net worth excludes future transactions', () => {
    const accs = [makeAccount({ id: 'cash', initialBalance: 0 })];
    const txs = [
      makeTx({ id: 't1', date: '2026-01-10', type: 'income', amount: 100000, accountId: 'cash' }),
      makeTx({ id: 't2', date: '2026-06-15', type: 'expense', amount: 40000, accountId: 'cash' }),
      makeTx({ id: 't3', date: '2027-01-01', type: 'income', amount: 999999, accountId: 'cash' }),
    ];
    expect(netWorth(accs, txs, '2026-07-01')).toBe(60000);
    expect(netWorth(accs, txs, '2026-02-01')).toBe(100000);
  });
});

// ---------------------------------------------------------------------------
// balancesByAccountId
// ---------------------------------------------------------------------------

describe('balancesByAccountId', () => {
  it('returns a balance for every account', () => {
    const accs = [makeAccount({ id: 'a', initialBalance: 100 }), makeAccount({ id: 'b', type: 'savings', initialBalance: 200 })];
    const map = balancesByAccountId(accs, []);
    expect(map).toEqual({ a: 100, b: 200 });
  });
});

// ---------------------------------------------------------------------------
// validateLedger
// ---------------------------------------------------------------------------

describe('validateLedger', () => {
  it('accepts a healthy ledger with no issues', () => {
    const txs = [makeTx({ accountId: 'a', type: 'income', amount: 1000 })];
    expect(validateLedger(accounts, txs)).toEqual([]);
  });

  it('flags transactions referencing an unknown account', () => {
    const txs = [makeTx({ accountId: 'ghost' })];
    expect(validateLedger(accounts, txs).map((i) => i.code)).toContain('unknown_account');
  });

  it('flags transfers missing a destination', () => {
    const txs = [makeTx({ accountId: 'a', type: 'transfer', amount: 1000 })];
    expect(validateLedger(accounts, txs).map((i) => i.code)).toContain('transfer_missing_target');
  });

  it('flags self-transfers', () => {
    const txs = [makeTx({ accountId: 'a', toAccountId: 'a', type: 'transfer', amount: 1000 })];
    expect(validateLedger(accounts, txs).map((i) => i.code)).toContain('self_transfer');
  });

  it('flags transfers to an unknown destination account', () => {
    const txs = [makeTx({ accountId: 'a', toAccountId: 'ghost', type: 'transfer', amount: 1000 })];
    expect(validateLedger(accounts, txs).map((i) => i.code)).toContain('unknown_account');
  });

  it('flags zero, negative and non-finite amounts', () => {
    const txs = [
      makeTx({ id: 'z', amount: 0 }),
      makeTx({ id: 'n', amount: -5000 }),
      makeTx({ id: 'f', amount: Number.NaN }),
    ];
    const codes = validateLedger(accounts, txs).map((i) => i.code);
    expect(codes.filter((c) => c === 'non_positive_amount').length).toBe(3);
  });

  it('flags duplicate transaction ids', () => {
    const txs = [makeTx({ id: 'dup' }), makeTx({ id: 'dup' })];
    expect(validateLedger(accounts, txs).map((i) => i.code)).toContain('duplicate_tx_id');
  });

  it('flags duplicate account ids', () => {
    const accs = [makeAccount({ id: 'x' }), makeAccount({ id: 'x' })];
    expect(validateLedger(accs, []).map((i) => i.code)).toContain('duplicate_account_id');
  });
});
