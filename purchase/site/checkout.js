/**
 * The payment form. Kept out of the HTML so it can be syntax- and bundle-checked
 * (`esbuild site/checkout.js --bundle`) and cached separately from the markup.
 *
 * It does three things and nothing else: load the catalogue, keep the plan
 * prices in the selected country's currency, and start a checkout. It never
 * decides a price — `POST /api/checkout` does, from the Worker's own catalogue.
 */

import { api, detectedCountry, escapeHtml, formatMoney, messageFor, prefill, rememberOrder } from './shop.js';

const plansEl = document.getElementById('plans');
const countryEl = document.getElementById('country');
const operatorsEl = document.getElementById('operators');
const messageEl = document.getElementById('message');
const payEl = document.getElementById('pay');
const form = document.getElementById('checkout');

let catalog = null;

function showError(text) {
  messageEl.className = text ? 'alert' : '';
  messageEl.textContent = text || '';
}

function currentCountry() {
  return catalog.countries.find((country) => country.code === countryEl.value);
}

/** Every operator we sell through settles in the country's own currency. */
function currentCurrency() {
  return currentCountry()?.currency || 'XOF';
}

function renderPlans() {
  const checked = plansEl.querySelector('input[name=plan]:checked')?.value;
  plansEl.innerHTML = catalog.plans.map((plan, index) => `
    <label class="choice">
      <input type="radio" name="plan" value="${escapeHtml(plan.id)}" ${(checked ? checked === plan.id : index === 0) ? 'checked' : ''}>
      <span>
        <strong>${escapeHtml(plan.label)} — <span class="price">${formatMoney(plan.price, currentCurrency())}</span></strong>
        <span class="meta">${escapeHtml(plan.blurb)}</span>
      </span>
    </label>`).join('');
}

function renderCountries() {
  countryEl.innerHTML = catalog.countries
    .map((country) => `<option value="${escapeHtml(country.code)}">${escapeHtml(country.label)}</option>`)
    .join('');
}

function renderOperators() {
  operatorsEl.innerHTML = (currentCountry()?.methods || [])
    .map((method) => `<span class="badge">${escapeHtml(method.name)}</span>`)
    .join('');
  // The price is stated in the selected country's currency, so re-render it.
  renderPlans();
}

countryEl.addEventListener('change', renderOperators);

async function start() {
  try {
    catalog = await api('/api/catalog');
  } catch (error) {
    showError(messageFor(error));
    payEl.disabled = true;
    return;
  }
  renderCountries();
  // The app's hint wins; otherwise the browser's region, when it is a market we
  // actually settle in.
  const wanted = prefill.country || detectedCountry();
  if (wanted && catalog.countries.some((country) => country.code === wanted)) {
    countryEl.value = wanted;
  }
  renderPlans();
  renderOperators();

  if (prefill.plan) {
    const radio = plansEl.querySelector(`input[value="${CSS.escape(prefill.plan)}"]`);
    if (radio) radio.checked = true;
  }
  if (prefill.email) document.getElementById('email').value = prefill.email;
}

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  const email = document.getElementById('email').value.trim();
  const name = document.getElementById('name').value.trim();
  const phone = document.getElementById('phone').value.trim();
  const plan = form.querySelector('input[name=plan]:checked')?.value;

  if (!email.includes('@')) {
    showError('Vérifiez votre adresse e-mail : c’est là que la clé sera envoyée.');
    document.getElementById('email').focus();
    return;
  }

  showError('');
  payEl.disabled = true;
  payEl.textContent = 'Ouverture du paiement…';

  try {
    const order = await api('/api/checkout', {
      method: 'POST',
      body: JSON.stringify({ plan, country: countryEl.value, email, name, phone }),
    });
    // Remember the order *before* leaving the page: the confirmation reads the
    // reference from the query string and the token back from localStorage.
    rememberOrder(order.reference, order.statusToken);
    document.getElementById('redirect-card').hidden = false;
    document.getElementById('redirect-link').href = order.paymentUrl;
    location.href = order.paymentUrl;
  } catch (error) {
    showError(messageFor(error));
    payEl.disabled = false;
    payEl.textContent = 'Continuer vers le paiement';
  }
});

start();
