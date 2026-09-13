// ---------------------------------------------------------------------------
// Currency preferences — detected from the browser region, overridable in
// Réglages, and used everywhere money is displayed.
// ---------------------------------------------------------------------------

export interface CurrencyOption {
  code: string;
  /** Short human label, e.g. "Dollar américain". */
  label: string;
}

/** Currencies offered in the Réglages picker (symbols come from Intl). */
export const CURRENCY_OPTIONS: CurrencyOption[] = [
  { code: 'XOF', label: 'Franc CFA (UEMOA) — Afrique de l’Ouest' },
  { code: 'XAF', label: 'Franc CFA (CEMAC) — Afrique centrale' },
  { code: 'USD', label: 'Dollar américain' },
  { code: 'EUR', label: 'Euro' },
  { code: 'GBP', label: 'Livre sterling' },
  { code: 'MAD', label: 'Dirham marocain' },
  { code: 'DZD', label: 'Dinar algérien' },
  { code: 'TND', label: 'Dinar tunisien' },
  { code: 'NGN', label: 'Naira nigérian' },
  { code: 'GHS', label: 'Cedi ghanéen' },
  { code: 'KES', label: 'Shilling kényan' },
  { code: 'TZS', label: 'Shilling tanzanien' },
  { code: 'UGX', label: 'Shilling ougandais' },
  { code: 'RWF', label: 'Franc rwandais' },
  { code: 'ZAR', label: 'Rand sud-africain' },
  { code: 'CAD', label: 'Dollar canadien' },
  { code: 'CHF', label: 'Franc suisse' },
  { code: 'CNY', label: 'Yuan chinois' },
  { code: 'JPY', label: 'Yen japonais' },
  { code: 'INR', label: 'Roupie indienne' },
];

/** ISO 3166-1 alpha-2 region → ISO 4217 currency (best-effort). */
const REGION_TO_CURRENCY: Record<string, string> = {
  // UEMOA — Franc CFA
  SN: 'XOF', CI: 'XOF', BF: 'XOF', ML: 'XOF', NE: 'XOF', TG: 'XOF', BJ: 'XOF', GW: 'XOF',
  // CEMAC — Franc CFA
  CM: 'XAF', GA: 'XAF', CG: 'XAF', TD: 'XAF', CF: 'XAF', GQ: 'XAF',
  // Europe
  FR: 'EUR', DE: 'EUR', IT: 'EUR', ES: 'EUR', PT: 'EUR', BE: 'EUR', NL: 'EUR', LU: 'EUR',
  AT: 'EUR', IE: 'EUR', FI: 'EUR', GR: 'EUR', EE: 'EUR', LV: 'EUR', LT: 'EUR', SK: 'EUR',
  SI: 'EUR', CY: 'EUR', MT: 'EUR', HR: 'EUR', MC: 'EUR', AD: 'EUR', SM: 'EUR', VA: 'EUR',
  GB: 'GBP', CH: 'CHF', NO: 'NOK', SE: 'SEK', DK: 'DKK', PL: 'PLN', CZ: 'CZK', HU: 'HUF',
  RO: 'RON', BG: 'BGN', UA: 'UAH', RU: 'RUB', TR: 'TRY', RS: 'RSD', AL: 'ALL', BA: 'BAM',
  MK: 'MKD', MD: 'MDL', BY: 'BYN', GE: 'GEL', AM: 'AMD', AZ: 'AZN', KZ: 'KZT',
  // Afrique du Nord
  MA: 'MAD', DZ: 'DZD', TN: 'TND', EG: 'EGP', LY: 'LYD', MR: 'MRU', SD: 'SDG',
  // Afrique de l'Ouest et centrale (hors CFA)
  NG: 'NGN', GH: 'GHS', LR: 'LRD', GM: 'GMD', GN: 'GNF', SL: 'SLE', CV: 'CVE', ST: 'STN',
  CD: 'CDF', AO: 'AOA', MZ: 'MZN', ZM: 'ZMW', MW: 'MWK', ZW: 'ZWL', BW: 'BWP', NA: 'NAD',
  // Afrique de l'Est et australe
  KE: 'KES', TZ: 'TZS', UG: 'UGX', RW: 'RWF', BI: 'BIF', ET: 'ETB', SO: 'SOS', DJ: 'DJF',
  ER: 'ERN', MG: 'MGA', MU: 'MUR', SC: 'SCR', KM: 'KMF', ZA: 'ZAR', LS: 'LSL', SZ: 'SZL',
  // Amériques
  US: 'USD', CA: 'CAD', MX: 'MXN', BR: 'BRL', AR: 'ARS', CL: 'CLP', CO: 'COP', PE: 'PEN',
  VE: 'VES', UY: 'UYU', PY: 'PYG', BO: 'BOB', EC: 'USD', PA: 'PAB', CR: 'CRC', GT: 'GTQ',
  HN: 'HNL', NI: 'NIO', SV: 'USD', DO: 'DOP', CU: 'CUP', HT: 'HTG', JM: 'JMD', TT: 'TTD',
  // Asie et Océanie
  CN: 'CNY', JP: 'JPY', IN: 'INR', KR: 'KRW', HK: 'HKD', TW: 'TWD', SG: 'SGD', MY: 'MYR',
  TH: 'THB', VN: 'VND', ID: 'IDR', PH: 'PHP', PK: 'PKR', BD: 'BDT', LK: 'LKR', NP: 'NPR',
  MM: 'MMK', KH: 'KHR', LA: 'LAK', MN: 'MNT', UZ: 'UZS', SA: 'SAR', AE: 'AED', QA: 'QAR',
  KW: 'KWD', BH: 'BHD', OM: 'OMR', JO: 'JOD', LB: 'LBP', IL: 'ILS', IQ: 'IQD', IR: 'IRR',
  AF: 'AFN', AU: 'AUD', NZ: 'NZD', FJ: 'FJD', PG: 'PGK', SB: 'SBD', VU: 'VUV', WS: 'WST',
  TO: 'TOP',
};

/** Fallback when the region is unknown — the app's native currency. */
export const DEFAULT_CURRENCY = 'XOF';

/**
 * Best-effort currency from the user's region. `locale` is injectable for
 * tests; at runtime it is the browser's resolved locale (e.g. "fr-SN" → XOF).
 */
export function detectCurrency(locale = Intl.DateTimeFormat().resolvedOptions().locale): string {
  // Only a language-region form (e.g. "fr-SN") carries a region; a bare
  // language code like "fr" must not be mistaken for the region "FR".
  if (locale.includes('-')) {
    const region = locale.split('-').pop()?.toUpperCase() ?? '';
    if (region.length === 2 && REGION_TO_CURRENCY[region]) {
      return REGION_TO_CURRENCY[region];
    }
  }
  return DEFAULT_CURRENCY;
}

/**
 * The OS's own name for a currency, e.g. `NOK` → « couronne norvégienne ».
 * Guarded like `Intl.supportedValuesOf` below: the API is recent, and `of()`
 * throws on a code it does not know, so this must never be the only path.
 */
function systemCurrencyName(code: string, locale: string): string | null {
  try {
    const DisplayNames = (Intl as { DisplayNames?: new (l: string, o: { type: string }) => { of(c: string): string | undefined } }).DisplayNames;
    if (!DisplayNames) return null;
    const name = new DisplayNames(locale, { type: 'currency' }).of(code);
    return name && name !== code ? name : null;
  } catch {
    return null;
  }
}

/**
 * A readable name for **any** ISO 4217 code: the curated, translated-in-French
 * label when we have one, otherwise the OS's name for it. The app can hold codes
 * it does not curate — detection maps ~130 regions to currencies while the list
 * above holds 20 — so a name must exist for all of them; falling back to the raw
 * code is the last resort, never a printed i18n key.
 */
export function currencyDisplayName(code: string, locale = 'fr-FR'): string {
  const upper = normalizeCurrencyCode(code);
  const curated = CURRENCY_OPTIONS.find((o) => o.code === upper);
  if (curated) return curated.label;
  return systemCurrencyName(upper, locale) ?? upper;
}

/**
 * Canonical form of a currency code: trimmed, upper-cased, `''` when absent.
 * `String()` rather than `code.trim()` because the value comes back out of
 * JSON-parsed storage, where a hand-edited file can hold a number or an object.
 */
export function normalizeCurrencyCode(code?: string | null): string {
  return String(code ?? '').trim().toUpperCase();
}

/** ISO 4217 as it is actually written: three letters, nothing else. */
const CODE_SHAPE = /^[A-Z]{3}$/;

/**
 * The code the UI should actually show: the stored choice when it is a real
 * code, else the detected default, else the app's own currency.
 *
 * Normalizing here (not only inside the picker) is what keeps a `<select>`'s
 * `value` and its options speaking the same language: a stored `'mxn'` must not
 * be handed to a select whose options are `'MXN'`, or the control silently
 * falls back to its first option while every amount is formatted in the other
 * currency. The shape check throws away what is not a currency at all — the
 * preference is JSON-parsed storage, so a hand-edited file can hold `'X'`, a
 * number or an object, and the screen must show a currency rather than garbage.
 */
export function resolveCurrency(chosen?: string | null, fallback?: string | null): string {
  for (const candidate of [normalizeCurrencyCode(chosen), normalizeCurrencyCode(fallback)]) {
    if (CODE_SHAPE.test(candidate)) return candidate;
  }
  return DEFAULT_CURRENCY;
}

export interface CurrencyChoice {
  code: string;
  /**
   * True for the currencies we ship a translated label for: the picker then
   * renders `t(\`currencies.${code}\`)`. False for anything else, where `label`
   * (the OS's name) is used instead — which is what keeps a code we do not
   * curate from printing a raw key.
   */
  curated: boolean;
  /** Name to use when the currency is not curated (already localized). */
  label: string;
}

/**
 * The options a currency picker should offer: the curated list, **plus the
 * current code when it is not in it**.
 *
 * This is what keeps the `<select>` honest. A `<select value=…>` whose value
 * matches no `<option>` silently displays the *first* option, so a detected NOK
 * would show « XOF — franc CFA » while every amount on screen was in kroner;
 * and a label built as `t(\`currencies.${code}\`)` would print the raw key
 * `currencies.NOK`. Offering the code fixes both, and no per-currency dictionary
 * entry is needed for the long tail.
 */
export function currencyChoices(current?: string, locale = 'fr-FR'): CurrencyChoice[] {
  const curated: CurrencyChoice[] = CURRENCY_OPTIONS.map((o) => ({
    code: o.code,
    curated: true,
    label: o.label,
  }));
  const code = normalizeCurrencyCode(current);
  if (!code || curated.some((choice) => choice.code === code)) return curated;
  return [...curated, { code, curated: false, label: systemCurrencyName(code, locale) ?? code }];
}

/**
 * Formats an amount in the given currency, French locale, whole units —
 * matching the app's integer data model. Invalid codes fall back to XOF.
 */
/** ISO 4217 codes this runtime can actually format (cached). */
let supportedCurrencies: Set<string> | null = null;
function isSupportedCurrency(code: string): boolean {
  if (!supportedCurrencies) {
    try {
      const api = (Intl as { supportedValuesOf?: (key: 'currency') => string[] }).supportedValuesOf;
      supportedCurrencies = api ? new Set(api('currency')) : new Set();
    } catch {
      supportedCurrencies = new Set();
    }
  }
  return supportedCurrencies.has(code);
}

/**
 * Formats an amount in the given currency, whole units — matching the app's
 * integer data model. `locale` follows the app language (fr-FR by default).
 * Unknown codes fall back to XOF.
 */
export function formatMoney(amount: number, currency: string, locale = 'fr-FR'): string {
  const code = (currency || DEFAULT_CURRENCY).trim().toUpperCase();
  if (!isSupportedCurrency(code)) {
    return formatMoney(amount, DEFAULT_CURRENCY, locale);
  }
  try {
    return new Intl.NumberFormat(locale, {
      style: 'currency',
      currency: code,
      currencyDisplay: 'narrowSymbol',
      maximumFractionDigits: 0,
    }).format(amount);
  } catch {
    return formatMoney(amount, DEFAULT_CURRENCY, locale);
  }
}