import { Preferences } from './preferences';
import { AA, blendOver, ensureContrast } from './contrast';

export type ChartTheme = Preferences['theme'];

/*
 * The JS half of the theme palette.
 *
 * Plain markup (badges, chips, buttons, progress fills, focus rings) needs
 * nothing here: it uses Tailwind accent utilities, which are CSS-variable driven
 * per theme — see index.css and tailwind.config.js. Everything in this module
 * covers the colors CSS cannot reach: recharts paints plain hex, and category /
 * wallet colors come from stored data, so both have to be resolved in JS.
 */

/**
 * The card surface they are painted on (`bg-slate-900` per theme) — charts,
 * wallet badges and category dots all sit on it, so it is what their contrast is
 * measured against (never the page background).
 */
export const PANEL_SURFACE: Record<ChartTheme, string> = {
  dark: '#0f172a',
  light: '#ffffff',
};

/**
 * Chart palette per theme. recharts takes plain hex, so these cannot be CSS
 * variables — which is also why they must be audited per theme
 * (see `contrast.test.ts`).
 */
export const CHART_COLORS: Record<
  ChartTheme,
  { grid: string; axisTick: string; barAllocated: string; barSpent: string }
> = {
  dark: {
    grid: '#1e293b', // decorative gridlines — exempt from 1.4.11
    axisTick: '#94a3b8', // 6.96:1 on the panel
    barAllocated: '#64748b', // 3.75:1 — WCAG 1.4.11 graphics
    barSpent: '#f43f5e', // 4.86:1
  },
  light: {
    grid: '#e2e8f0', // decorative gridlines — exempt from 1.4.11
    axisTick: '#475569', // 7.58:1 on the white panel
    barAllocated: '#64748b', // 4.76:1
    barSpent: '#f43f5e', // 3.67:1
  },
};

/**
 * Legend *labels* are painted in the theme ink, not in the series color: small
 * colored text on the panel fails 4.5:1 for most brand hues (emerald and lime
 * sit near 2:1 on white). The colored swatch beside the label already carries
 * the color↔series mapping, so nothing is lost.
 */
export const LEGEND_INK: Record<ChartTheme, string> = {
  dark: '#e2e8f0',
  light: '#1e293b',
};

/**
 * Mirror of the `--sky-500` accent token (index.css). The JS side only needs it
 * to know the surface behind the wallet badge label, which sits on a
 * `bg-sky-500/10` tint; `contrast.test.ts` asserts both stay in sync.
 */
export const SKY_500: Record<ChartTheme, string> = {
  dark: '#0ea5e9',
  light: '#0284c7',
};

/** Surface behind a wallet badge label: the sky-500/10 tint over the panel. */
export function badgeSurface(theme: ChartTheme): string {
  return blendOver(SKY_500[theme], PANEL_SURFACE[theme], 0.1);
}

/**
 * Chart tooltips: one dark bubble in every theme, so the same colors are used
 * whether the page is light or dark.
 */
export const TOOLTIP = {
  background: '#0f172a',
  // The bubble keeps the same fill in both themes, so its outline is what
  // separates it from the surface — hence a border that clears 3:1 on the dark
  // panel too (a slate-700 border only managed 1.72:1 there).
  border: '#64748b',
  text: '#e2e8f0',
  label: '#f8fafc',
} as const;

/**
 * Data fill for a category color. Category colors are stored brand values
 * (`#10B981`, `#84CC16`, …) that do not reach 3:1 on the white panel, and they
 * live in user data (existing vaults, and any future custom color), so the
 * correction happens at render time instead of in the data: darken just enough,
 * only where the background demands it.
 */
export function chartFill(color: string, theme: ChartTheme): string {
  return ensureContrast(color, PANEL_SURFACE[theme], AA.graphic);
}
