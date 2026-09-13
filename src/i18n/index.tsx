import React, { useMemo } from 'react';
import { DICTIONARIES, Language, localeOf, translate } from './translations';
import { I18nContext, I18nValue } from './useI18n';

interface I18nProviderProps {
  language: Language;
  onLanguageChange: (lang: Language) => void;
  children: React.ReactNode;
}

export const I18nProvider: React.FC<I18nProviderProps> = ({
  language, onLanguageChange, children,
}) => {
  const value = useMemo<I18nValue>(() => {
    const dict = DICTIONARIES[language] ?? DICTIONARIES.fr;
    return {
      lang: language,
      locale: localeOf(language),
      t: (key, vars) => translate(dict, key, vars),
      setLang: onLanguageChange,
    };
  }, [language, onLanguageChange]);

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
};