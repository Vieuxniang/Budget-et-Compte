/**
 * The confirmation page. It watches one order until the key has been e-mailed.
 *
 * The reference comes from the URL (`?ref=…`, put there by CinetPay's
 * `return_url`), the status token from this device's localStorage — written by
 * `checkout.js` before the buyer left for the payment page. Both are needed: the
 * token is what proves the visitor is the buyer, and it unlocks nothing else.
 */

import { api, escapeHtml, formatMoney, messageFor, orderToken } from './shop.js';

const params = new URLSearchParams(location.search);
const reference = (params.get('ref') || '').toUpperCase();
const token = params.get('token') || orderToken(reference);

const statusEl = document.getElementById('status');
const messageEl = document.getElementById('message');
const spinnerEl = document.getElementById('spinner');
const detailsEl = document.getElementById('details');

function setStatus(text, busy) {
  statusEl.textContent = text;
  spinnerEl.hidden = !busy;
}

function showError(text) {
  messageEl.className = text ? 'alert' : '';
  messageEl.textContent = text || '';
}

function showOrder(order) {
  document.getElementById('reference').textContent = order.reference;
  document.getElementById('plan').textContent = order.planLabel;
  document.getElementById('amount').textContent = formatMoney(order.amount, order.currency);
  document.getElementById('email').textContent = order.email;
  detailsEl.hidden = false;
}

function showSupport(contact) {
  document.getElementById('support').innerHTML = contact
    ? `Un souci ? Écrivez à <a href="mailto:${escapeHtml(contact)}?subject=${encodeURIComponent(`Licence ${reference}`)}">${escapeHtml(contact)}</a> en indiquant la référence ci-dessus.`
    : 'Un souci ? Répondez à l’e-mail de confirmation en indiquant la référence ci-dessus.';
}

/** Poll until delivered, refused, or the buyer is told we will e-mail them. */
const MAX_ATTEMPTS = 24; // 24 × 5 s ≈ 2 minutes
let attempts = 0;

async function poll() {
  attempts += 1;
  try {
    const { order, support } = await api(`/api/order?ref=${encodeURIComponent(reference)}&token=${encodeURIComponent(token)}`);
    showOrder(order);

    if (order.status === 'delivered') {
      document.getElementById('heading').textContent = 'Commande confirmée';
      document.getElementById('lead').textContent = 'Paiement reçu. Votre clé de licence a été envoyée par e-mail.';
      setStatus(`Clé envoyée à ${order.email}.`, false);
      document.getElementById('next-steps').hidden = false;
      showSupport(support);
      return;
    }
    if (order.status === 'refused') {
      document.getElementById('lead').textContent = 'Le paiement n’a pas abouti.';
      setStatus('Le paiement a été refusé ou annulé : vous n’avez pas été débité.', false);
      showError('Vous pouvez relancer un paiement avec le même e-mail, ou en choisir un autre.');
      document.getElementById('next-steps').hidden = false;
      showSupport(support);
      return;
    }
    setStatus('Paiement en cours de vérification…', true);
  } catch (error) {
    showError(messageFor(error));
    setStatus('Statut indisponible pour le moment.', false);
    if (error?.status === 403 || error?.status === 404) return;
  }

  if (attempts >= MAX_ATTEMPTS) {
    setStatus('Nous n’avons pas encore la confirmation du paiement.', false);
    showError('Inutile de payer une seconde fois : dès que l’opérateur confirme, votre clé part par e-mail. Si l’argent a été débité sans que vous receviez rien, écrivez-nous avec la référence.');
    document.getElementById('next-steps').hidden = false;
    return;
  }
  setTimeout(poll, 5000);
}

if (!reference) {
  document.getElementById('heading').textContent = 'Aucune commande à afficher';
  setStatus('Cette page affiche une commande précise.', false);
  showError('Ouvrez le lien reçu par e-mail (il contient la référence), ou recommencez le paiement.');
} else if (!token) {
  setStatus('Commande introuvable sur cet appareil.', false);
  showError('Ouvrez cette page depuis l’appareil utilisé pour payer, ou depuis le lien reçu par e-mail. Sinon, écrivez-nous avec la référence.');
} else {
  poll();
}
