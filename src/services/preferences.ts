import { detectLanguage, Language } from '../i18n/translations';

export type Theme = 'dark' | 'light';

export interface Preferences {
  language: Language;
  theme: Theme;
}

const PREFS_KEY = 'patrifamille_prefs_v1';

const isLanguage = (v: unknown): v is Language => v === 'fr' || v === 'en' || v === 'es';
const isTheme = (v: unknown): v is Theme => v === 'dark' || v === 'light';

/** Follow the OS preference; the app itself defaults to dark. */
export function detectTheme(): Theme {
  if (typeof window !== 'undefined' && window.matchMedia?.('(prefers-color-scheme: light)').matches) {
    return 'light';
  }
  return 'dark';
}

export function getPreferences(): Preferences {
  const fallback: Preferences = {
    language: detectLanguage(),
    theme: detectTheme(),
  };
  try {
    const raw = localStorage.getItem(PREFS_KEY);
    if (!raw) return fallback;
    const parsed = JSON.parse(raw) as Partial<Preferences>;
    return {
      language: isLanguage(parsed.language) ? parsed.language : fallback.language,
      theme: isTheme(parsed.theme) ? parsed.theme : fallback.theme,
    };
  } catch {
    return fallback;
  }
}

export function savePreferences(prefs: Preferences): void {
  localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
}