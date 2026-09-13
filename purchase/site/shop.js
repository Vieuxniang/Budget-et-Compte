/**
 * Shared bits of the shop pages. Plain ES module, no build step, no dependency:
 * these pages must load on a 3G phone with 200 ms of latency, and nothing here
 * is worth a bundler.
 *
 * `API` is same-origin by default — the Worker serves these pages, so the pages
 * can talk to it without knowing a hostname. `?api=https://…` overrides it, which
 * is how the pages are exercised locally against `wrangler dev`.
 */

const params = new URLSearchParams(location.search);

export const API = (params.get('api') || '').replace(/\/$/, '');

/** The URL parameters the app uses to pre-fill the form. */
export const prefill = {
  country: (params.get('pays') || params.get('country') || '').toUpperCase(),
  plan: (params.get('offre') || params.get('plan') || '').toLowerCase(),
  email: params.get('email') || '',
};

/** The countries we settle payments in. */
const SOLD_COUNTRIES = ['SN', 'CI', 'BF', 'ML', 'CM'];

/**
 * A country read from the browser's own region, when it is one we sell in — the
 * fallback for a buyer who arrives without the app's `?pays=` hint. `fr-SN` →
 * `SN`; anything else is left blank so the list decides, because guessing a
 * market we cannot settle is worse than asking.
 */
export function detectedCountry() {
  const region = (navigator.language || '').split('-')[1]?.toUpperCase() || '';
  return SOLD_COUNTRIES.includes(region) ? region : '';
}

export async function api(path, options = {}) {
  let response;
  try {
    response = await fetch(`${API}${path}`, {
      headers: { 'Content-Type': 'application/json' },
      ...options,
    });
  } catch {
    throw new Error('reseau');
  }
  let payload = null;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }
  if (!response.ok || !payload?.ok) {
    const error = new Error(payload?.error || payload?.reason || `http-${response.status}`);
    error.status = response.status;
    error.payload = payload;
    throw error;
  }
  return payload;
}

/** `5 000 F CFA`, `500 000 GNF`, `5 $US`. */
export function formatMoney(amount, currency) {
  const grouped = String(Math.round(Number(amount) || 0)).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
  if (currency === 'XOF' || currency === 'XAF') return `${grouped} F CFA`;
  if (currency === 'USD') return `${grouped} $US`;
  return `${grouped} ${currency}`;
}

/**
 * The order is remembered **on the buyer's device**, keyed by its reference, so
 * the confirmation page can read its status without a login. The status token is
 * what makes that safe: it is unguessable and grants access to nothing else.
 */
const STORE_KEY = 'bec_orders';

export function rememberOrder(reference, statusToken) {
  try {
    const all = JSON.parse(localStorage.getItem(STORE_KEY) || '{}');
    all[reference] = { statusToken, at: Date.now() };
    // Keep only the last ten orders; this is a shopping-cart memory, not a log.
    const entries = Object.entries(all).sort((a, b) => b[1].at - a[1].at).slice(0, 10);
    localStorage.setItem(STORE_KEY, JSON.stringify(Object.fromEntries(entries)));
  } catch {
    /* private mode — the confirmation is still reachable by e-mail */
  }
}

export function orderToken(reference) {
  try {
    return JSON.parse(localStorage.getItem(STORE_KEY) || '{}')?.[reference]?.statusToken || '';
  } catch {
    return '';
  }
}

export function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export const texts = {
  reseau: "Connexion impossible. Vérifiez votre réseau, puis réessayez : rien n'a été débité.",
  'plan-not-sellable': "Cette formule n'est pas disponible dans ce pays pour le moment.",
  'email-invalid': 'Vérifiez votre adresse e-mail : c’est là que la clé sera envoyée.',
  'payment-init-failed': "Le paiement n'a pas pu démarrer. Réessayez dans un instant — si le problème persiste, écrivez-nous.",
  'order-not-found': 'Commande introuvable. Vérifiez le lien reçu par e-mail.',
  'token-mismatch': 'Ce lien ne correspond pas à la commande. Ouvrez-le depuis le même appareil, ou écrivez-nous.',
  'server-error': "Erreur temporaire de notre côté. Réessayez dans quelques minutes.",
};

export function messageFor(error) {
  const code = error?.message || '';
  return texts[code] || texts['server-error'];
}
