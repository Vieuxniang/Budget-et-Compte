import { describe, expect, it } from 'vitest';
import {
  DICTIONARIES, detectLanguage, fr, frTranslate, localeOf, translate,
} from './translations';
import { CURRENCY_OPTIONS } from '../services/currency';

describe('dictionary completeness the key scanner cannot see', () => {
  it('translates every currency the picker offers', () => {
    // The picker builds `currencies.<CODE>` from the code, so the scanner in
    // scripts/check-i18n.mjs treats the whole namespace as used and cannot tell
    // that one member is missing. Without this, adding a currency to
    // CURRENCY_OPTIONS without its three labels would print the raw key on
    // screen — the exact defect the picker was just fixed for.
    for (const { code } of CURRENCY_OPTIONS) {
      for (const [lang, dict] of Object.entries(DICTIONARIES)) {
        expect(dict[`currencies.${code}`], `currencies.${code} missing in ${lang}`).toBeTruthy();
        expect(dict[`currencies.${code}`]).not.toContain('currencies.');
      }
    }
  });
});

describe('translate', () => {
  it('resolves keys across all languages', () => {
    expect(translate(DICTIONARIES.en, 'app.tagline')).toBe('Family finance — accounts, budget & savings');
    expect(translate(DICTIONARIES.es, 'app.tagline')).toBe('Finanzas familiares — cuentas, presupuesto y ahorro');
    expect(translate(DICTIONARIES.fr, 'app.tagline')).toBe('Gestion financière familiale — comptes, budget & épargne');
  });

  it('interpolates {vars}', () => {
    expect(translate(DICTIONARIES.fr, 'lock.passwordTooShort', { min: 6 }))
      .toBe('Le mot de passe doit contenir au moins 6 caractères.');
    expect(translate(DICTIONARIES.en, 'backup.summary', { accounts: 3, s: 's', txs: 12, cats: 6, goals: 2, groups: 1, groupsPlural: '', packs: 2, packsPlural: 's' }))
      .toBe('3 accounts · 12 transactions · 6 categories · 2 goals · 1 tontine group · 2 packs');
  });

  it('falls back to French, then the key itself, when a key is missing', () => {
    expect(translate(DICTIONARIES.en, 'months.1')).toBe('January'); // present
    expect(translate({}, 'fr.only.key')).toBe(fr['fr.only.key'] ?? 'fr.only.key');
  });
});

describe('detectLanguage', () => {
  it('matches the language prefix from browser languages', () => {
    expect(detectLanguage(['fr-FR', 'en-US'])).toBe('fr');
    expect(detectLanguage(['en-GB'])).toBe('en');
    expect(detectLanguage(['es-419'])).toBe('es');
  });

  it('defaults to French for unknown languages', () => {
    expect(detectLanguage(['de-DE'])).toBe('fr');
    expect(detectLanguage([])).toBe('fr');
  });
});

describe('localeOf', () => {
  it('maps each language to a BCP-47 locale', () => {
    expect(localeOf('fr')).toBe('fr-FR');
    expect(localeOf('en')).toBe('en-US');
    expect(localeOf('es')).toBe('es-ES');
  });
});

describe('frTranslate', () => {
  it('is the French translator used by services outside React', () => {
    expect(frTranslate('errors.amountPositive')).toBe('Le montant doit être supérieur à zéro.');
  });
});