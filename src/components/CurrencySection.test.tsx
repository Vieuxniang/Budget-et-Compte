/**
 * The display-currency picker's contract: **every code the app can end up with
 * must be offered, and named.** Detection understands ~130 regions while the
 * curated list holds 20, so a picker that only rendered the curated list would
 * be handed a code with no matching <option> — and a <select> whose value
 * matches nothing falls back to showing the *first* option, so the screen would
 * claim XOF while every amount was formatted in the detected currency.
 *
 * No jsdom in the project (see BudgetView.test.tsx): the real component is
 * rendered server-side and the markup is read, which is exactly what the user
 * is shown.
 */
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { CurrencySection } from './SettingsView';
import type { SecurityConfig } from '../types';

const security = (currency?: string): SecurityConfig => ({
  isPasswordSet: true,
  autoLockMinutes: 5,
  ...(currency ? { currency } : {}),
});

/** Codes detection produces from a region but the curated list does not hold. */
const OFF_LIST = [
  ['NOK', 'nb-NO'],
  ['MXN', 'es-MX'],
  ['AUD', 'en-AU'],
  ['PLN', 'pl-PL'],
] as const;

function render(currency?: string, defaultCurrency = 'XOF') {
  return renderToStaticMarkup(
    <CurrencySection security={security(currency)} defaultCurrency={defaultCurrency} onChange={() => {}} />
  );
}

describe('display-currency picker', () => {
  it.each(OFF_LIST)('offers an option for %s (detected in %s)', (code) => {
    const html = render(code);
    expect(html, `${code} must have a matching <option>`).toContain(`value="${code}"`);
  });

  it.each(OFF_LIST)('never prints the raw key `currencies.%s`', (code) => {
    expect(render(code)).not.toContain(`currencies.${code}`);
  });

  it('names an off-list currency instead of echoing its code', () => {
    const html = render('NOK');
    const option = html.match(/value="NOK"[^>]*>([^<]*)</)?.[1] ?? '';
    expect(option).toMatch(/NOK — \S/);
    expect(option).not.toBe('NOK — NOK');
  });

  it('keeps the curated list when the current code is already in it', () => {
    const html = render('XOF');
    // 20 curated options, and XOF is one of them (no duplicate appended).
    expect(html.match(/<option/g) ?? []).toHaveLength(20);
  });

  it('still selects the code the app is actually using', () => {
    // The fallback must not be a "display-only" trick: the option has to exist so
    // the <select> shows the real currency rather than the first one in the list.
    const html = render('MXN');
    const options = [...html.matchAll(/value="([A-Z]{3})"/g)].map((m) => m[1]);
    expect(options).toContain('MXN');
    expect(options[0]).not.toBe('MXN'); // appended after the curated ones
  });

  it('normalizes the stored code, so the value and the options agree', () => {
    // A lowercase preference (hand-edited storage, or an older build) used to be
    // handed to a <select> whose only options are upper-case: no option matched,
    // so the control showed XOF while the amounts were formatted in the real
    // currency.
    for (const stored of ['mxn', ' nok ', 'aud']) {
      const html = render(stored);
      expect(html, `${stored} must still match an option`).toContain(`value="${stored.trim().toUpperCase()}"`);
    }
  });

  it('falls back to the detected default when nothing is stored', () => {
    const html = render(undefined, 'MXN');
    expect(html).toContain('value="MXN"');
  });

  it('degrades to the app currency when neither the stored choice nor the default is usable', () => {
    const html = render('', '   ');
    const options = [...html.matchAll(/value="([A-Z0-9]{3})"/g)].map((m) => m[1]);
    expect(options).toContain('XOF');
    expect(new Set(options).size).toBe(options.length);
  });

  it('survives a tampered preference without inventing markup', () => {
    const hostile = '"><script>alert(1)</script>';
    const html = render(hostile);
    expect(html).not.toContain('<script>');
    // The option still exists (a code-shaped placeholder), so the select matches.
    expect(html).toContain('<option value=');
  });
});
