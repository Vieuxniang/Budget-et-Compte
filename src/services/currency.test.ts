import { describe, expect, it } from 'vitest';
import {
  CURRENCY_OPTIONS, DEFAULT_CURRENCY, currencyChoices, currencyDisplayName, detectCurrency,
  formatMoney, normalizeCurrencyCode, resolveCurrency,
} from './currency';

describe('detectCurrency', () => {
  it('maps the resolved locale region to the right currency', () => {
    expect(detectCurrency('fr-SN')).toBe('XOF');
    expect(detectCurrency('en-US')).toBe('USD');
    expect(detectCurrency('fr-FR')).toBe('EUR');
    expect(detectCurrency('en-GB')).toBe('GBP');
    expect(detectCurrency('ar-MA')).toBe('MAD');
    expect(detectCurrency('en-NG')).toBe('NGN');
  });

  it('falls back to the app default when the region is unknown or missing', () => {
    expect(detectCurrency('xx-XX')).toBe(DEFAULT_CURRENCY);
    expect(detectCurrency('fr')).toBe(DEFAULT_CURRENCY);
    expect(detectCurrency('')).toBe(DEFAULT_CURRENCY);
  });
});

describe('formatMoney', () => {
  it('formats XOF with the CFA symbol (whole units)', () => {
    // fr-FR renders XOF as "F CFA".
    expect(formatMoney(1234567, 'XOF')).toContain('CFA');
    expect(formatMoney(1234567, 'XOF')).toMatch(/1\s*234\s*567/);
  });

  it('formats common currencies with their symbol', () => {
    expect(formatMoney(1234, 'USD')).toContain('$');
    expect(formatMoney(1234, 'EUR')).toContain('€');
    expect(formatMoney(1234, 'GBP')).toContain('£');
    expect(formatMoney(1234, 'NGN')).toContain('₦');
  });

  it('normalizes lowercase codes', () => {
    expect(formatMoney(1234, 'usd')).toContain('$');
  });

  it('falls back to XOF for unknown or empty codes', () => {
    expect(formatMoney(1234, 'ZZZ')).toContain('CFA');
    expect(formatMoney(1234, '')).toContain('CFA');
    expect(formatMoney(1234, '  ')).toContain('CFA');
  });
});

describe('currency options & labels', () => {
  it('offers the expected currency set with unique codes', () => {
    const codes = CURRENCY_OPTIONS.map((o) => o.code);
    expect(new Set(codes).size).toBe(codes.length);
    expect(codes).toContain('XOF');
    expect(codes).toContain('USD');
    expect(codes).toContain('EUR');
  });

  it('labels known codes from the dictionary and uncurated ones from the OS', () => {
    expect(currencyDisplayName('USD')).toBe('Dollar américain');
    expect(currencyDisplayName('nok')).toMatch(/couronne/i); // not curated: named, not a key
    expect(currencyDisplayName('ZZZ')).toBe('ZZZ');
  });
});

describe('currency picker choices', () => {
  it('returns the curated list untouched when the current code is in it', () => {
    const choices = currencyChoices('XOF');
    expect(choices).toHaveLength(CURRENCY_OPTIONS.length);
    expect(choices.every((c) => c.curated)).toBe(true);
    expect(choices.some((c) => c.code === 'XOF')).toBe(true);
  });

  it('appends the current code when it is not curated, with a real name', () => {
    // Detection understands ~130 regions; the curated list holds 20. A code it
    // can produce must still be offered, or the <select> shows the first option.
    const choices = currencyChoices('NOK');
    expect(choices).toHaveLength(CURRENCY_OPTIONS.length + 1);
    const last = choices[choices.length - 1];
    expect(last.code).toBe('NOK');
    expect(last.curated).toBe(false);
    expect(last.label).not.toBe('NOK');
    expect(last.label.length).toBeGreaterThan(0);
  });

  it('never appends a duplicate, whatever the input casing or padding', () => {
    for (const input of ['xof', ' XOF ', 'Xof']) {
      expect(currencyChoices(input)).toHaveLength(CURRENCY_OPTIONS.length);
    }
  });

  it('degrades safely on an empty or missing code', () => {
    expect(currencyChoices(undefined)).toHaveLength(CURRENCY_OPTIONS.length);
    expect(currencyChoices('')).toHaveLength(CURRENCY_OPTIONS.length);
    expect(currencyChoices('   ')).toHaveLength(CURRENCY_OPTIONS.length);
  });

  it('covers every code detection can produce — the two lists must agree', () => {
    // The defect this guards: a region whose currency is not offered. Detection
    // is derived from the same map the picker now always satisfies.
    const regions = ['nb-NO', 'no-NO', 'es-MX', 'en-AU', 'pl-PL', 'ar-EG', 'en-NZ', 'tr-TR'];
    for (const locale of regions) {
      const detected = detectCurrency(locale);
      const offered = currencyChoices(detected).map((c) => c.code);
      expect(offered, `${locale} → ${detected}`).toContain(detected);
    }
  });

  it('is the identity it promises: the resolved code is always among the choices', () => {
    // The invariant the picker depends on, over the shapes a stored preference
    // can actually take (hand-edited localStorage, an older version, empty).
    const inputs = [
      'XOF', 'xof', ' XOF ', 'NOK', 'nok', 'mxn', 'AUD', '', '   ', undefined, null,
      'ZZZ', 'X', 'XX', 'eur', 42 as unknown as string,
    ];
    for (const input of inputs) {
      const resolved = resolveCurrency(input, 'XOF');
      expect(resolved, `resolved(${JSON.stringify(input)})`).toMatch(/^[A-Z]{3}$/);
      expect(currencyChoices(resolved).map((c) => c.code), `choices(${resolved})`).toContain(resolved);
    }
  });

  it('does not crash, or invent garbage, on a malformed stored value', () => {
    // The preference is JSON-parsed from storage, so a hand-edited file can put
    // a number or an object there; the Settings screen must show a currency.
    expect(normalizeCurrencyCode(42 as unknown as string)).toBe('42');
    expect(resolveCurrency(42 as unknown as string, 'EUR')).toBe('EUR');
    expect(resolveCurrency({} as unknown as string, 'EUR')).toBe('EUR');
    expect(resolveCurrency('X', 'EUR')).toBe('EUR');
    expect(resolveCurrency('X', undefined)).toBe(DEFAULT_CURRENCY);
  });

  it('falls back to the detected default, then the app default, never to an empty string', () => {
    expect(resolveCurrency(undefined, 'EUR')).toBe('EUR');
    expect(resolveCurrency('', 'eur')).toBe('EUR');
    expect(resolveCurrency('  ', undefined)).toBe(DEFAULT_CURRENCY);
    expect(resolveCurrency('nok', 'XOF')).toBe('NOK');
    expect(normalizeCurrencyCode('  xaf ')).toBe('XAF');
    expect(normalizeCurrencyCode(undefined)).toBe('');
  });

  it('names a currency for every code detection can return', () => {
    const regions = ['nb-NO', 'es-MX', 'en-AU', 'pl-PL', 'ar-EG', 'ja-JP', 'en-ZA'];
    for (const locale of regions) {
      const detected = detectCurrency(locale);
      const name = currencyDisplayName(detected);
      expect(name, `${detected} must have a name`).not.toMatch(/^currencies\./);
      // An unknown code is still echoed rather than dropped.
      expect(currencyDisplayName('ZZZ')).toBe('ZZZ');
      expect(name.length).toBeGreaterThan(0);
    }
  });
});