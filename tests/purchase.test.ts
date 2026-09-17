import { describe, expect, it } from 'vitest';
import { COUNTRIES, PLANS, resolvePlan, isValidEmail, maskEmail } from '../purchase/core.js';

describe('Stripe subscription catalogue', () => {
  it('defines the supported Pro billing periods', () => {
    expect(PLANS['pro-monthly']).toMatchObject({ price: 500, months: 1, recurring: true });
    expect(PLANS['pro-yearly']).toMatchObject({ price: 5000, months: 12, recurring: true });
  });

  it('resolves plans using the country currency', () => {
    expect(resolvePlan('pro-monthly', 'SN')).toMatchObject({ currency: 'XOF', price: 500 });
    expect(resolvePlan('pro-yearly', 'CI')).toMatchObject({ currency: 'XOF', price: 5000 });
    expect(resolvePlan('pro-monthly', 'XX')).toBeNull();
    expect(resolvePlan('unknown', 'SN')).toBeNull();
  });

  it('keeps the supported country catalogue intact', () => {
    expect(COUNTRIES.SN.currency).toBe('XOF');
    expect(COUNTRIES.CM.currency).toBe('XAF');
  });
});

describe('purchase input safety', () => {
  it('validates and masks customer data', () => {
    expect(isValidEmail('kofi@example.com')).toBe(true);
    expect(isValidEmail('not-an-email')).toBe(false);
    expect(maskEmail('kofi@example.com')).toBe('k**i@example.com');
  });
});
