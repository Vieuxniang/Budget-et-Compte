import { describe, it, expect } from 'vitest';
import {
  validateAccountDraft, draftToAccount, accountToDraft, emptyAccountDraft,
  transactionsUsingAccount, generateAccountId,
} from './accounts';
import { Transaction } from '../types';

describe('validateAccountDraft', () => {
  it('accepts a valid wallet draft', () => {
    const draft = { ...emptyAccountDraft(), name: 'Wave Papa', institution: 'Wave' };
    expect(validateAccountDraft(draft)).toEqual([]);
  });

  it('requires a name', () => {
    const errs = validateAccountDraft({ ...emptyAccountDraft(), name: '  ' });
    expect(errs.map((e) => e.field)).toContain('name');
  });

  it('rejects negative initial balance for asset accounts', () => {
    const errs = validateAccountDraft({ ...emptyAccountDraft(), name: 'X', initialBalance: -100 });
    expect(errs.map((e) => e.field)).toContain('initialBalance');
  });

  it('allows positive initial balance for loans (amount due)', () => {
    const errs = validateAccountDraft({ ...emptyAccountDraft(), name: 'X', type: 'loan', initialBalance: 500000 });
    expect(validateAccountDraft({ ...emptyAccountDraft(), name: 'X', type: 'loan', initialBalance: 500000 }).length).toBe(0);
    expect(errs.length).toBe(0);
  });

  it('rejects negative initial balance for loans too', () => {
    const errs = validateAccountDraft({ ...emptyAccountDraft(), name: 'X', type: 'loan', initialBalance: -500000 });
    expect(errs.map((e) => e.field)).toContain('initialBalance');
  });

  it('requires a holder', () => {
    const errs = validateAccountDraft({ ...emptyAccountDraft(), name: 'X', holder: '' });
    expect(errs.map((e) => e.field)).toContain('holder');
  });

  it('requires a plausible currency', () => {
    const errs = validateAccountDraft({ ...emptyAccountDraft(), name: 'X', currency: '' });
    expect(errs.map((e) => e.field)).toContain('currency');
  });
});

describe('draft <-> account round-trip', () => {
  it('preserves fields and normalizes currency case', () => {
    const draft = { ...emptyAccountDraft(), name: ' Compte Test ', currency: 'fcfa', initialBalance: 12345 };
    const acc = draftToAccount(draft, 'acc-fixed');
    expect(acc.id).toBe('acc-fixed');
    expect(acc.name).toBe('Compte Test');
    expect(acc.currency).toBe('FCFA');
    expect(acc.institution).toBe('Compte Test'); // falls back to name
    expect(accountToDraft(acc).initialBalance).toBe(12345);
  });

  it('stores loan initialBalance as positive amount due', () => {
    const acc = draftToAccount({ ...emptyAccountDraft(), name: 'Crédit', type: 'loan', initialBalance: 900000 });
    expect(acc.initialBalance).toBe(900000);
  });

  it('keeps non-loan balances signed as entered', () => {
    const acc = draftToAccount({ ...emptyAccountDraft(), name: 'X', initialBalance: 7500 });
    expect(acc.initialBalance).toBe(7500);
  });

  it('generates unique ids', () => {
    const ids = new Set(Array.from({ length: 30 }, () => generateAccountId()));
    expect(ids.size).toBe(30);
  });
});

describe('transactionsUsingAccount (deletion guard)', () => {
  const tx = (id: string, accountId: string, toAccountId?: string): Transaction => ({
    id, date: '2026-09-01', title: id, amount: 1000, type: toAccountId ? 'transfer' : 'expense',
    category: 'Divers', accountId, toAccountId, member: 'Famille',
  });

  it('finds direct transactions and the incoming leg of transfers', () => {
    const txs = [tx('1', 'a'), tx('2', 'b', 'a'), tx('3', 'b')];
    expect(transactionsUsingAccount(txs, 'a').map((t) => t.id)).toEqual(['1', '2']);
  });

  it('returns empty when safe to delete', () => {
    expect(transactionsUsingAccount([tx('1', 'b')], 'a')).toEqual([]);
  });

  it('works for any account type including wallets', () => {
    const txs = [tx('1', 'acc-5')];
    expect(transactionsUsingAccount(txs, 'acc-5').length).toBe(1);
  });
});
