/**
 * The one support channel a 100%-offline app can honestly offer: an e-mail.
 *
 * A `mailto:` link opens the buyer's own mail client — nothing in the app
 * calls a server, so the offline promise (see `license.ts`) survives contact
 * with support. The address comes from `VITE_SUPPORT_EMAIL` at build time. Unset builds use
 * the publisher's inbox; an override set to an empty string removes the contact (the kill
 * switch for repackaged builds that carry their own support channel).
 *
 * The current use is a revoked key (see `OfferView`): revocation is by ID and
 * propagates with app updates, so a wrongly-revoked buyer must be able to
 * contest it in one tap — the subject line carries the key's ID to make the
 * exchange unambiguous.
 */

const RAW_SUPPORT_EMAIL = import.meta.env.VITE_SUPPORT_EMAIL as string | undefined;

/** The support inbox, without `mailto:`. Empty when the build disables it. */
export const SUPPORT_EMAIL =
  (RAW_SUPPORT_EMAIL === undefined ? 'vieuxn33@gmail.com' : RAW_SUPPORT_EMAIL).trim();

/** True when a support address is configured (unset builds use the default). */
export function hasSupport(): boolean {
  return SUPPORT_EMAIL.length > 0;
}

/**
 * A `mailto:` link to support. Returns `''` when no address is configured, so
 * callers can render conditionally with `hasSupport()` — never a broken link.
 */
export function supportLink(subject: string): string {
  if (!hasSupport()) return '';
  return `mailto:${SUPPORT_EMAIL}?subject=${encodeURIComponent(subject)}`;
}
