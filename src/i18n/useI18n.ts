import { createContext, useContext } from 'react';
import { DICTIONARIES, Language, translate, Translate } from './translations';

export interface I18nValue {
  /** Current language code ('fr' | 'en' | 'es'). */
  lang: Language;
  /** BCP-47 locale for Intl formatting (e.g. 'fr-FR'). */
  locale: string;
  /** Translate a dot-namespace key with optional {vars}. */
  t: Translate;
  /** Switch language (persisted by the caller via onLanguageChange). */
  setLang: (lang: Language) => void;
}

export const I18nContext = createContext<I18nValue>({
  lang: 'fr',
  locale: 'fr-FR',
  t: (key, vars) => translate(DICTIONARIES.fr, key, vars),
  setLang: () => {},
});

/** Access translations + language controls anywhere under <I18nProvider>. */
export function useI18n(): I18nValue {
  return useContext(I18nContext);
}