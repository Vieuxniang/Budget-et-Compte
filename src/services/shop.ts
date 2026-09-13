/**
 * The licence shop — a **separate deployment** (see `purchase/`): static pages
 * plus a Cloudflare Worker that takes the mobile-money payment and e-mails the
 * signed key.
 *
 * The app only ever *links* to it. It never calls it, never checks in, and works
 * exactly as before when no shop is configured — which is the point: the offline
 * promise is kept by there being no code path from the app to a server.
 *
 * The URL comes from `VITE_SHOP_URL` at build time. Unset (the default, and the
 * case for a self-hosted or unreleased build) simply hides the buy button and
 * leaves the "paste your key" form, which is how licences sold by hand work.
 */

const RAW_SHOP_URL = (import.meta.env.VITE_SHOP_URL as string | undefined) || '';

/** The shop's origin, without a trailing slash. Empty when not configured. */
export const SHOP_URL = RAW_SHOP_URL.trim().replace(/\/+$/, '');

export function hasShop(): boolean {
  return SHOP_URL.length > 0;
}

/**
 * Which country to open the checkout on, given the app's currency preference.
 * Only the countries CinetPay settles for us are listed; anything else lets the
 * shop page decide (it reads the browser's region as a fallback).
 */
const COUNTRY_BY_CURRENCY: Record<string, string> = {
  XOF: 'SN', // UEMOA — Sénégal is the reference market
  XAF: 'CM', // CEMAC
};

export function shopCountryForCurrency(currency: string): string {
  return COUNTRY_BY_CURRENCY[currency.toUpperCase()] || '';
}

/**
 * A link to the checkout, pre-filled so the buyer does not retype what the app
 * already knows. Returns `''` when no shop is configured, so callers can render
 * conditionally with `hasShop()` — never a broken link.
 */
export function shopLink(options: { plan?: 'pro' | 'association'; currency?: string; email?: string } = {}): string {
  if (!hasShop()) return '';
  const params = new URLSearchParams();
  const country = options.currency ? shopCountryForCurrency(options.currency) : '';
  if (country) params.set('pays', country);
  if (options.plan) params.set('offre', options.plan);
  if (options.email) params.set('email', options.email);
  const query = params.toString();
  return query ? `${SHOP_URL}/?${query}` : `${SHOP_URL}/`;
}
