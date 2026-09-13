/**
 * WCAG AA contrast audit for the app's colored UI — the measuring tool behind
 * the palette rules.
 *
 * Run alone:  npx vitest run src/services/contrast.test.ts
 *
 * Two palettes are measured, because the app has two:
 *   - the CSS half (src/index.css): surface, text and accent tokens that Tailwind
 *     turns into utilities — read straight out of the file so the audit measures
 *     what the browser applies, and fails if a token is removed or drifts;
 *   - the JS half (src/services/themePalette.ts): what CSS cannot reach —
 *     recharts colors, category colors and wallet brand hues, which come from
 *     stored data or from third-party brand palettes.
 *
 * Each color is measured against the surface it is actually painted on, with the
 * threshold that matches its role:
 *   - text            ≥ 4.5:1   (WCAG 1.4.3)
 *   - large text      ≥ 3:1     (WCAG 1.4.3)
 *   - graphic / UI    ≥ 3:1     (WCAG 1.4.11)
 *   - decorative      exempt     (gridlines, borders, tracks, tints)
 */
import { describe, expect, it } from 'vitest';
import {
  AA, audit, blendOver, contrastRatio, ensureContrast, parseHex,
  type ContrastRole,
} from './contrast';
import {
  LEGEND_INK, PANEL_SURFACE, SKY_500, TOOLTIP, chartFill, badgeSurface,
  type ChartTheme,
} from './themePalette';
import { CHART_COLORS } from './themePalette';
import { INITIAL_BUDGET_CATEGORIES } from './storage';
import { walletBrandColor } from './accountMeta';
import { AccountType } from '../types';

const THEMES: ChartTheme[] = ['light', 'dark'];

// ---------------------------------------------------------------------------
// Theme tokens, straight out of index.css
// ---------------------------------------------------------------------------

// Read from disk, not through the bundler: Vite's CSS plugin swallows `?raw`
// imports of .css files (they come back empty), and the whole point of this
// audit is to measure the tokens as authored in the file.
// The project deliberately ships no @types/node, so the import is the exact
// boundary of that choice — the runtime (vitest) is Node.
// @ts-expect-error node builtin, available in the test runtime only
import { readFileSync } from 'node:fs';

const css = readFileSync(new URL('../index.css', import.meta.url), 'utf8');

/**
 * Body of the first *rule* whose selector matches. Anchored to a line start so
 * a selector merely mentioned in a comment (`:root`, `html.light`) is ignored.
 */
function ruleBody(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(`^\\s*${escaped}\\s*\\{`, 'm').exec(css);
  if (!match) return '';
  const open = match.index + match[0].length - 1;
  let depth = 0;
  for (let i = open; i < css.length; i++) {
    if (css[i] === '{') depth++;
    else if (css[i] === '}' && --depth === 0) return css.slice(open + 1, i);
  }
  return '';
}

/** `--emerald-400: 4 120 87;` → `{ 'emerald-400': '#047857' }` */
function tokens(body: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of body.matchAll(/--([a-z0-9-]+):\s*(\d+)\s+(\d+)\s+(\d+)\s*;/g)) {
    out[m[1]] = '#' + [m[2], m[3], m[4]]
      .map((n) => Number(n).toString(16).padStart(2, '0'))
      .join('');
  }
  return out;
}

const DARK_TOKENS = tokens(ruleBody(':root'));
const THEME_TOKENS: Record<ChartTheme, Record<string, string>> = {
  dark: DARK_TOKENS,
  // html.light overrides a subset; the rest inherits from :root.
  light: { ...DARK_TOKENS, ...tokens(ruleBody('html.light')) },
};

const token = (theme: ChartTheme, name: string) => THEME_TOKENS[theme][name];

// ---------------------------------------------------------------------------
// Probes
// ---------------------------------------------------------------------------

interface Probe {
  /** Where the color shows up, in user terms. */
  area: string;
  fg: string;
  bg: string;
  role: ContrastRole | 'decorative';
}

/** Surface and shape tokens shared by every probe: panels, page, borders. */
function surfaces(theme: ChartTheme) {
  return {
    panel: PANEL_SURFACE[theme],
    page: token(theme, 'slate-950'),
    track: token(theme, 'slate-800'),
    ink: token(theme, 'slate-950'),
  };
}

/**
 * Accent scales as used by the views: career figures and Care Guide headings,
 * transaction amounts and type rings, alerts, badges and the focus ring.
 */
function accentProbes(theme: ChartTheme): Probe[] {
  const { panel, track, ink } = surfaces(theme);
  const probes: Probe[] = [];

  // Text steps.
  for (const name of [
    'emerald-300', 'emerald-400', 'red-300', 'red-400',
    'sky-300', 'sky-400', 'amber-300', 'amber-400',
  ]) {
    probes.push({ area: `text-${name} sur le panneau`, fg: token(theme, name), bg: panel, role: 'text' });
  }

  // Chips and alerts: a 300/400 label on its own 10% tint.
  for (const hue of ['emerald', 'red', 'sky', 'amber']) {
    probes.push({
      area: `text-${hue}-300 sur teinte ${hue}-500/10`,
      fg: token(theme, `${hue}-300`),
      bg: blendOver(token(theme, `${hue}-500`), panel, 0.1),
      role: 'text',
    });
  }

  // Solid fills, indicators and state markers.
  probes.push({ area: 'bg-emerald-500 (onglet actif, bouton) sur panneau', fg: token(theme, 'emerald-500'), bg: panel, role: 'graphic' });
  probes.push({ area: 'text-slate-950 sur bg-emerald-500 (bouton)', fg: ink, bg: token(theme, 'emerald-500'), role: 'text' });
  probes.push({ area: 'progression « ok » (bg-emerald-500) sur la piste', fg: token(theme, 'emerald-500'), bg: track, role: 'graphic' });
  probes.push({ area: 'progression « warning » (bg-amber-400) sur la piste', fg: token(theme, 'amber-400'), bg: track, role: 'graphic' });
  probes.push({ area: 'progression « over » (bg-red-500) sur la piste', fg: token(theme, 'red-500'), bg: track, role: 'graphic' });
  probes.push({ area: 'anneau de focus (emerald-400) sur le panneau', fg: token(theme, 'emerald-400'), bg: panel, role: 'graphic' });

  // Decorative (reported for reference, exempt from 1.4.11).
  probes.push({ area: 'teinte emerald-500/10 sur le panneau', fg: blendOver(token(theme, 'emerald-500'), panel, 0.1), bg: panel, role: 'decorative' });
  probes.push({ area: 'bordure slate-800 (séparateurs, champs)', fg: token(theme, 'slate-800'), bg: panel, role: 'decorative' });
  probes.push({ area: 'bordure red-500/30 (alerte)', fg: blendOver(token(theme, 'red-500'), panel, 0.3), bg: panel, role: 'decorative' });
  probes.push({ area: 'bordure amber-800/40 (carte non budgétée)', fg: blendOver(token(theme, 'amber-800'), panel, 0.4), bg: panel, role: 'decorative' });
  probes.push({ area: 'bordure red-900/40 (carte crédit)', fg: blendOver(token(theme, 'red-900'), panel, 0.4), bg: panel, role: 'decorative' });

  return probes;
}

/** The Badge/Chip text of the Mobile Money wallets (App.tsx dashboard). */
function walletProbes(theme: ChartTheme): Probe[] {
  const bg = badgeSurface(theme);
  return (['wave', 'orange_money', 'mtn_momo'] as AccountType[]).map((type) => ({
    area: `badge ${type} (${walletBrandColor(type, theme)})`,
    fg: walletBrandColor(type, theme) as string,
    bg,
    role: 'text' as const,
  }));
}

/** The Budget charts (recharts paints hex, so these live in JS). */
function chartProbes(theme: ChartTheme): Probe[] {
  const surface = PANEL_SURFACE[theme];
  const c = CHART_COLORS[theme];
  const ink = LEGEND_INK[theme];

  const probes: Probe[] = [
    { area: 'Axes X/Y, étiquettes (10 px)', fg: c.axisTick, bg: surface, role: 'text' },
    { area: 'Légende des barres, libellés', fg: ink, bg: surface, role: 'text' },
    { area: 'Légende du donut, libellés', fg: ink, bg: surface, role: 'text' },
    { area: 'Info-bulle, valeur', fg: TOOLTIP.text, bg: TOOLTIP.background, role: 'text' },
    { area: 'Info-bulle, nom de série', fg: TOOLTIP.label, bg: TOOLTIP.background, role: 'text' },
    { area: 'Barres « Alloué » + pastille de légende', fg: c.barAllocated, bg: surface, role: 'graphic' },
    { area: 'Barres « Dépensé », couleur de base', fg: c.barSpent, bg: surface, role: 'graphic' },
    { area: 'Info-bulle, contour sur le panneau', fg: TOOLTIP.border, bg: surface, role: 'graphic' },
    { area: 'Grille (tirets)', fg: c.grid, bg: surface, role: 'decorative' },
    { area: 'Info-bulle, fond sur le panneau', fg: TOOLTIP.background, bg: surface, role: 'decorative' },
    { area: 'Info-bulle, contour sur son fond', fg: TOOLTIP.border, bg: TOOLTIP.background, role: 'decorative' },
  ];

  for (const cat of INITIAL_BUDGET_CATEGORIES) {
    probes.push({
      area: `Catégorie « ${cat.name} » — segment/barre/pastille`,
      fg: chartFill(cat.color, theme),
      bg: surface,
      role: 'graphic',
    });
  }

  return probes;
}

const ROLE_LABEL: Record<Probe['role'], string> = {
  text: 'texte ≥ 4.5:1',
  largeText: 'grand texte ≥ 3:1',
  graphic: 'graphique ≥ 3:1',
  decorative: 'décoratif (exempté)',
};

/** Prints one row per color and returns the measurements. */
function report(title: string, probes: Probe[]) {
  const rows = probes.map((p) => {
    const role: ContrastRole = p.role === 'decorative' ? 'graphic' : p.role;
    return { ...p, ...audit(p.fg, p.bg, role) };
  });

  const width = Math.max(...rows.map((r) => r.area.length));
  console.log(`\n${title}`);
  for (const r of rows) {
    const status = r.role === 'decorative' ? 'info' : r.pass ? 'OK' : 'ÉCHEC';
    console.log(
      `  ${r.area.padEnd(width)}  ${r.fg} / ${r.bg}  ` +
      `${r.ratio.toFixed(2).padStart(6)}:1  ${ROLE_LABEL[r.role].padEnd(21)} ${status}`
    );
  }
  return rows;
}

/** Every color must reach its threshold — one assertion, all failures listed. */
function expectNoFailures(rows: ReturnType<typeof report>) {
  const failures = rows
    .filter((r) => r.role !== 'decorative' && !r.pass)
    .map((r) => `${r.area} → ${r.fg} sur ${r.bg} = ${r.ratio.toFixed(2)}:1 (minimum ${r.min}:1)`);
  expect(failures).toEqual([]);
}

// ---------------------------------------------------------------------------

describe('WCAG AA — échelles d\'accents (index.css)', () => {
  for (const theme of THEMES) {
    it(`thème ${theme} : chaque accent atteint son seuil`, () => {
      const probes = accentProbes(theme);
      // Guard: a renamed or deleted token would silently produce NaN ratios.
      for (const p of probes.filter((x) => x.role !== 'decorative')) {
        expect(p.fg, `${p.area} : jeton manquant dans index.css`).toMatch(/^#[0-9a-f]{6}$/);
        expect(p.bg, `${p.area} : fond manquant dans index.css`).toMatch(/^#[0-9a-f]{6}$/);
      }
      expectNoFailures(report(`Contraste WCAG AA — accents, thème ${theme}`, probes));
    });
  }

  it('les jetons JS des accents reflètent index.css', () => {
    // Guard: if index.css stopped being read, every ratio above would be NaN
    // and this audit would pass vacuously.
    expect(css).toContain('--emerald-400');
    expect(DARK_TOKENS['emerald-400']).toMatch(/^#[0-9a-f]{6}$/);
    // The only accent the JS side needs is sky-500: it tints the wallet badge
    // surface that the brand hues are measured against.
    expect(SKY_500.dark).toBe(token('dark', 'sky-500'));
    expect(SKY_500.light).toBe(token('light', 'sky-500'));
  });
});

describe('WCAG AA — badges Mobile Money', () => {
  for (const theme of THEMES) {
    it(`thème ${theme} : les trois badges restent lisibles`, () => {
      expectNoFailures(report(`Contraste WCAG AA — badges portefeuille, thème ${theme}`, walletProbes(theme)));
    });
  }

  it('le thème sombre garde les couleurs de marque intactes', () => {
    expect(walletBrandColor('mtn_momo', 'dark')).toBe('#FFCC00');
    expect(walletBrandColor('checking', 'dark')).toBeUndefined();
  });
});

describe('WCAG AA — graphiques du Budget', () => {
  for (const theme of THEMES) {
    it(`thème ${theme} : chaque couleur atteint son seuil`, () => {
      expectNoFailures(report(`Contraste WCAG AA — graphiques du Budget, thème ${theme}`, chartProbes(theme)));
    });
  }

  it('segments du donut : séparés par des trous, donc mesurés face au panneau', () => {
    // The donut uses paddingAngle=3 and no stroke, so neighbouring slices are
    // separated by a panel-colored gap: the boundary that must reach 3:1 is
    // slice-vs-panel (asserted above), not slice-vs-slice. This logs the
    // slice-vs-slice ratios so the distinction stays visible in the report.
    const fills = INITIAL_BUDGET_CATEGORIES.map((c) => chartFill(c.color, 'light'));
    const pairs = fills.map(
      (fill, i) => `${fill} ↔ ${fills[(i + 1) % fills.length]} = ${contrastRatio(fill, fills[(i + 1) % fills.length]).toFixed(2)}:1`
    );
    console.log(`\n  Paires adjacentes (informatif) : ${pairs.join(', ')}`);
    expect(fills).toHaveLength(INITIAL_BUDGET_CATEGORIES.length);
  });
});

describe('ensureContrast() — correction au rendu', () => {
  it('corrige une couleur de marque trop claire sur fond blanc', () => {
    const before = contrastRatio('#10B981', '#ffffff');
    const after = ensureContrast('#10B981', '#ffffff', AA.graphic);
    expect(before).toBeLessThan(AA.graphic);
    expect(contrastRatio(after, '#ffffff')).toBeGreaterThanOrEqual(AA.graphic);
    expect(after).not.toBe('#10B981');
  });

  it('assombrit le jaune MTN jusqu\'à le rendre lisible sur le panneau clair', () => {
    const safe = ensureContrast('#FFCC00', '#ffffff', AA.text);
    expect(contrastRatio('#FFCC00', '#ffffff')).toBeLessThan(2);
    expect(contrastRatio(safe, '#ffffff')).toBeGreaterThanOrEqual(AA.text);
  });

  it('préserve la teinte dominante de la couleur corrigée', () => {
    const rgb = parseHex(ensureContrast('#84CC16', '#ffffff', AA.graphic))!;
    expect(rgb.g).toBeGreaterThan(rgb.r);
    expect(rgb.g).toBeGreaterThan(rgb.b);
  });

  it('laisse intacte une couleur déjà conforme', () => {
    expect(ensureContrast('#64748b', '#ffffff', AA.graphic)).toBe('#64748b');
  });

  it('ne touche à rien sur le thème sombre, où la palette passe déjà', () => {
    for (const cat of INITIAL_BUDGET_CATEGORIES) {
      expect(chartFill(cat.color, 'dark')).toBe(cat.color);
    }
  });
});

describe('contrast.ts — justesse des mesures', () => {
  it('donne les ratios WCAG de référence', () => {
    expect(contrastRatio('#ffffff', '#000000')).toBeCloseTo(21, 5);
    expect(contrastRatio('#777777', '#ffffff')).toBeCloseTo(4.478, 2);
    expect(contrastRatio('#ffffff', '#ffffff')).toBeCloseTo(1, 5);
  });

  it('composite les teintes translucides pour les mesurer', () => {
    expect(blendOver('#000000', '#ffffff', 0.5)).toBe('#808080');
    expect(blendOver('#10b981', '#ffffff', 0)).toBe('#ffffff');
  });

  it('rejette les valeurs non-hexadécimales sans planter', () => {
    expect(parseHex('rgb(1,2,3)')).toBeNull();
    expect(ensureContrast('rebeccapurple', '#ffffff')).toBe('rebeccapurple');
  });
});
