/**
 * Shop link tests.
 *
 * `SHOP_URL` is read from `VITE_SHOP_URL` **at module load**, so each case stubs
 * the variable and re-imports the module — that is the only honest way to test
 * the two deployments (with and without a shop) in one process.
 *
 * What matters here is not the URL shape but the guarantee behind it: with no
 * shop configured the app must produce **nothing** (no broken link, no request),
 * and the country pre-fill must never invent a market we cannot settle.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

async function withShop(url?: string) {
  if (url === undefined) vi.stubEnv('VITE_SHOP_URL', '');
  else vi.stubEnv('VITE_SHOP_URL', url);
  vi.resetModules();
  return import('./shop');
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe('without a shop configured', () => {
  it('reports no shop and produces no link', async () => {
    const shop = await withShop('');
    expect(shop.hasShop()).toBe(false);
    expect(shop.SHOP_URL).toBe('');
    expect(shop.shopLink({ plan: 'pro', currency: 'XOF' })).toBe('');
  });

  it('treats a whitespace-only value as unset', async () => {
    const shop = await withShop('   ');
    expect(shop.hasShop()).toBe(false);
  });
});

describe('with a shop configured', () => {
  it('normalizes the origin and links to the checkout', async () => {
    const shop = await withShop('  https://licence.example.com/  ');
    expect(shop.hasShop()).toBe(true);
    expect(shop.SHOP_URL).toBe('https://licence.example.com');
    expect(shop.shopLink()).toBe('https://licence.example.com/');
  });

  it('pre-fills the country from the currency preference', async () => {
    const shop = await withShop('https://licence.example.com');
    expect(shop.shopLink({ plan: 'pro', currency: 'XOF' })).toBe('https://licence.example.com/?pays=SN&offre=pro');
    expect(shop.shopLink({ plan: 'association', currency: 'XAF' })).toBe(
      'https://licence.example.com/?pays=CM&offre=association',
    );
    // Case-insensitive, because the preference is stored by the user's choice.
    expect(shop.shopLink({ currency: 'xof' })).toBe('https://licence.example.com/?pays=SN');
  });

  it('never invents a country it does not sell in', async () => {
    const shop = await withShop('https://licence.example.com');
    expect(shop.shopCountryForCurrency('EUR')).toBe('');
    expect(shop.shopCountryForCurrency('USD')).toBe('');
    expect(shop.shopCountryForCurrency('GNF')).toBe('');
    expect(shop.shopLink({ plan: 'pro', currency: 'EUR' })).toBe('https://licence.example.com/?offre=pro');
  });

  it('carries the e-mail when the app knows it', async () => {
    const shop = await withShop('https://licence.example.com');
    expect(shop.shopLink({ plan: 'pro', currency: 'XOF', email: 'kofi@example.com' })).toBe(
      'https://licence.example.com/?pays=SN&offre=pro&email=kofi%40example.com',
    );
  });
});
