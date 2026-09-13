/**
 * WCAG 2.1 contrast utilities.
 *
 * Thresholds (AA):
 *  - 1.4.3  normal text (< 18.66px bold / < 24px)  ≥ 4.5:1
 *  - 1.4.3  large text                             ≥ 3:1
 *  - 1.4.11 non-text graphics (bars, slices, icons) ≥ 3:1
 *
 * The maths is duplicated nowhere else: the audit in `contrast.test.ts` and the
 * JS theme palette in `themePalette.ts` both go through this module.
 */

export interface Rgb {
  r: number;
  g: number;
  b: number;
}

/** Parse `#rgb` / `#rrggbb` (case-insensitive). Returns null when unparseable. */
export function parseHex(hex: string): Rgb | null {
  const match = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(hex.trim());
  if (!match) return null;
  let body = match[1];
  if (body.length === 3) body = body.split('').map((ch) => ch + ch).join('');
  return {
    r: parseInt(body.slice(0, 2), 16),
    g: parseInt(body.slice(2, 4), 16),
    b: parseInt(body.slice(4, 6), 16),
  };
}

const clamp255 = (n: number) => Math.max(0, Math.min(255, Math.round(n)));

/** Serialize an RGB triple back to a lowercase `#rrggbb` string. */
export function toHex({ r, g, b }: Rgb): string {
  return `#${[r, g, b].map((n) => clamp255(n).toString(16).padStart(2, '0')).join('')}`;
}

/** WCAG relative luminance: 0 (black) … 1 (white). */
export function relativeLuminance(hex: string): number {
  const rgb = parseHex(hex);
  if (!rgb) return 0;
  const channel = (value: number) => {
    const s = value / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * channel(rgb.r) + 0.7152 * channel(rgb.g) + 0.0722 * channel(rgb.b);
}

/** WCAG contrast ratio between two colors, 1:1 … 21:1. Order-independent. */
export function contrastRatio(a: string, b: string): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  const [hi, lo] = la >= lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}

/** WCAG 2.1 AA minimum contrast ratios, keyed by what the color is used for. */
export const AA = {
  text: 4.5,
  largeText: 3,
  graphic: 3,
} as const;

export type ContrastRole = keyof typeof AA;

/** Fresh ratio + pass/fail verdict, handy for audits and reports. */
export function audit(a: string, b: string, role: ContrastRole) {
  const ratio = contrastRatio(a, b);
  return { ratio, min: AA[role], pass: ratio >= AA[role] };
}

/**
 * Flatten a translucent color over an opaque one, e.g. Tailwind's
 * `bg-emerald-500/15`: needed because translucent tints have no contrast ratio
 * of their own until they are composited on the surface behind them.
 */
export function blendOver(fg: string, bg: string, alpha: number): string {
  const f = parseHex(fg);
  const b = parseHex(bg);
  if (!f || !b) return fg;
  return toHex({
    r: f.r * alpha + b.r * (1 - alpha),
    g: f.g * alpha + b.g * (1 - alpha),
    b: f.b * alpha + b.b * (1 - alpha),
  });
}

/**
 * Darken (on a light background) or lighten (on a dark one) a color just enough
 * to reach `min` contrast against `background`, keeping the hue as close as sRGB
 * proportional scaling allows. Colors that already comply are returned
 * untouched, so this is a no-op wherever the palette is already compliant.
 *
 * Chart fills need this at render time (not in the data): recharts paints plain
 * hex values, and category colors come from user data — seed values plus
 * whatever an existing vault already stored.
 */
export function ensureContrast(color: string, background: string, min: number = AA.graphic): string {
  const base = parseHex(color);
  if (!base || !parseHex(background)) return color;
  if (contrastRatio(color, background) >= min) return color;

  const towardWhite = relativeLuminance(background) < 0.5;
  for (let step = 1; step <= 50; step++) {
    const t = step * 0.02;
    const next = toHex(
      towardWhite
        ? { r: base.r + (255 - base.r) * t, g: base.g + (255 - base.g) * t, b: base.b + (255 - base.b) * t }
        : { r: base.r * (1 - t), g: base.g * (1 - t), b: base.b * (1 - t) }
    );
    if (contrastRatio(next, background) >= min) return next;
  }
  return towardWhite ? '#ffffff' : '#000000';
}
