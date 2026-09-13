import { describe, it, expect } from 'vitest';
import {
  ACCOUNT_TYPE_META, ACCOUNT_TYPE_ORDER, isLiabilityType, isMobileMoneyType, WALLET_BRAND_COLOR,
} from './accountMeta';
import { AccountType } from '../types';

describe('ACCOUNT_TYPE_META', () => {
  it('covers every account type in the union', () => {
    const expected: AccountType[] = [
      'checking', 'savings', 'investment', 'loan', 'cash', 'wave', 'orange_money', 'mtn_momo',
    ];
    for (const t of expected) {
      const meta = ACCOUNT_TYPE_META[t];
      expect(meta, `missing metadata for ${t}`).toBeDefined();
      expect(meta.label.length).toBeGreaterThan(0);
      expect(meta.badgeClass.length).toBeGreaterThan(0);
      expect(meta.balanceClass.length).toBeGreaterThan(0);
    }
  });

  it('marks only loans as liabilities', () => {
    for (const t of Object.keys(ACCOUNT_TYPE_META) as AccountType[]) {
      expect(isLiabilityType(t), `${t} liability flag`).toBe(t === 'loan');
    }
  });

  it('marks exactly the three Mobile Money wallets', () => {
    const wallets = (Object.keys(ACCOUNT_TYPE_META) as AccountType[]).filter(isMobileMoneyType);
    expect(wallets.sort()).toEqual(['mtn_momo', 'orange_money', 'wave']);
  });

  it('keeps the ledger as the authority on liabilities', () => {
    // Guards against metadata and money rules drifting apart.
    expect(isLiabilityType('loan')).toBe(true);
    expect(isLiabilityType('wave')).toBe(false);
    expect(isLiabilityType('checking')).toBe(false);
  });

  it('orders wallets before credit in pickers', () => {
    expect(ACCOUNT_TYPE_ORDER.indexOf('mtn_momo')).toBeLessThan(ACCOUNT_TYPE_ORDER.indexOf('loan'));
    expect(ACCOUNT_TYPE_ORDER.indexOf('wave')).toBeLessThan(ACCOUNT_TYPE_ORDER.indexOf('loan'));
  });

  it('gives brand colors to all wallets', () => {
    for (const t of ['wave', 'orange_money', 'mtn_momo'] as AccountType[]) {
      expect(WALLET_BRAND_COLOR[t]).toMatch(/^#[0-9a-f]{6}$/i);
    }
    expect(WALLET_BRAND_COLOR.checking).toBeUndefined();
  });
});
