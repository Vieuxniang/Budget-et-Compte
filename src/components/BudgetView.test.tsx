/**
 * BudgetView is the one place where the palette cannot come from CSS: recharts
 * takes plain hex props, so the component receives the theme and picks the
 * colors itself. These tests pin that contract — it must read the theme it is
 * given and paint that theme's palette.
 *
 * No DOM is needed: recharts is stubbed with a recorder (so the real component
 * code still runs and the props it passes are observable) and the component is
 * rendered server-side. The project ships no jsdom / testing-library, and this
 * keeps the test honest about what it checks — the props, which is what
 * determines what the user sees.
 */
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BudgetView } from './BudgetView';
import { BudgetCategory, Transaction } from '../types';
import {
  CHART_COLORS, LEGEND_INK, PANEL_SURFACE, TOOLTIP, chartFill, type ChartTheme,
} from '../services/themePalette';
import { contrastRatio, AA } from '../services/contrast';

interface Recorded {
  component: string;
  props: Record<string, any>;
}

const recorded = vi.hoisted(() => ({ nodes: [] as Recorded[] }));

vi.mock('recharts', () => {
  // Records the props and keeps rendering children, so nested elements (axes,
  // grid, bars, cells, tooltip, legend) are invoked and observable too.
  const record = (component: string) => ({ children, ...props }: Record<string, any>) => {
    recorded.nodes.push({ component, props });
    return <>{children}</>;
  };
  return {
    // Renders its children so the chart elements below are actually invoked.
    ResponsiveContainer: ({ children }: { children?: unknown }) => <>{children}</>,
    BarChart: record('BarChart'),
    PieChart: record('PieChart'),
    Bar: record('Bar'),
    Pie: record('Pie'),
    Cell: record('Cell'),
    XAxis: record('XAxis'),
    YAxis: record('YAxis'),
    CartesianGrid: record('CartesianGrid'),
    Tooltip: record('Tooltip'),
    Legend: record('Legend'),
  };
});

const THEMES: ChartTheme[] = ['light', 'dark'];

// Fixtures cover the three progress tones: on track (50%), near the limit (90%)
// and over budget (250%). Categories are matched to spending by name.
const MONTH = new Date().toISOString().slice(0, 7);
const CATEGORIES: BudgetCategory[] = [
  { id: 'c-ok', name: 'Discipline', type: 'needs', allocated: 100000, color: '#10B981' },
  { id: 'c-warn', name: 'Transport', type: 'needs', allocated: 100000, color: '#F59E0B' },
  { id: 'c-over', name: 'Loisirs', type: 'wants', allocated: 10000, color: '#3B82F6' },
];
const expense = (category: string, amount: number): Transaction => ({
  id: category, date: `${MONTH}-05`, title: category, amount,
  type: 'expense', category, accountId: 'acc-1', member: 'Famille',
});
const TRANSACTIONS: Transaction[] = [
  expense('Discipline', 50000),
  expense('Transport', 90000),
  expense('Loisirs', 25000),
];

function render(theme: ChartTheme, categories = CATEGORIES, transactions = TRANSACTIONS) {
  recorded.nodes.length = 0;
  const html = renderToStaticMarkup(
    <BudgetView categories={categories} transactions={transactions} currency="XOF" theme={theme} />
  );
  return { html, nodes: recorded.nodes };
}

const propsOf = (nodes: Recorded[], component: string) =>
  nodes.filter((n) => n.component === component).map((n) => n.props);

const barByKey = (nodes: Recorded[], dataKey: string) =>
  propsOf(nodes, 'Bar').find((p) => p.dataKey === dataKey);

describe('BudgetView — palette par thème', () => {
  beforeEach(() => {
    recorded.nodes.length = 0;
  });

  it.each(THEMES)('thème %s : grille, axes et barres suivent CHART_COLORS', (theme) => {
    const { nodes } = render(theme);
    const palette = CHART_COLORS[theme];

    expect(propsOf(nodes, 'CartesianGrid')[0].stroke).toBe(palette.grid);
    for (const axis of ['XAxis', 'YAxis']) {
      expect(propsOf(nodes, axis)[0].tick.fill).toBe(palette.axisTick);
    }
    expect(barByKey(nodes, 'Alloué')?.fill).toBe(palette.barAllocated);
    expect(barByKey(nodes, 'Dépensé')?.fill).toBe(palette.barSpent);
  });

  it.each(THEMES)('thème %s : les libellés de légende sont peints dans l\'encre du thème', (theme) => {
    const legends = propsOf(render(theme).nodes, 'Legend');
    expect(legends).toHaveLength(2); // bar chart + donut

    for (const legend of legends) {
      const label = legend.formatter('Alloué');
      expect(label.props.style.color).toBe(LEGEND_INK[theme]);
    }
  });

  it.each(THEMES)('thème %s : chaque segment passe par chartFill et reste ≥ 3:1', (theme) => {
    const { nodes } = render(theme);
    const surface = PANEL_SURFACE[theme];
    const fills = propsOf(nodes, 'Cell').map((p) => p.fill);
    const expected = CATEGORIES.map((c) => chartFill(c.color, theme));

    // Bar cells (Dépensé) + donut slices, in the summary's order.
    expect(fills).toHaveLength(CATEGORIES.length * 2);
    expect(new Set(fills)).toEqual(new Set(expected));
    for (const fill of fills) {
      expect(contrastRatio(fill, surface)).toBeGreaterThanOrEqual(AA.graphic);
    }
  });

  it.each(THEMES)('thème %s : l\'info-bulle garde ses couleurs dédiées', (theme) => {
    for (const tooltip of propsOf(render(theme).nodes, 'Tooltip')) {
      expect(tooltip.contentStyle.background).toBe(TOOLTIP.background);
      expect(tooltip.contentStyle.color).toBe(TOOLTIP.text);
      expect(tooltip.labelStyle.color).toBe(TOOLTIP.label);
      expect(tooltip.itemStyle.color).toBe(TOOLTIP.text);
    }
  });

  it('un changement de thème change réellement les couleurs peintes', () => {
    // A component that ignored its `theme` prop would render the same palette
    // twice; this pins that the prop is read, not just accepted.
    const fingerprint = (theme: ChartTheme) => {
      const { nodes } = render(theme);
      const legend = propsOf(nodes, 'Legend')[0];
      return JSON.stringify({
        grid: propsOf(nodes, 'CartesianGrid')[0].stroke,
        tick: propsOf(nodes, 'XAxis')[0].tick.fill,
        allocated: barByKey(nodes, 'Alloué')?.fill,
        cells: propsOf(nodes, 'Cell').map((p) => p.fill),
        legend: legend.formatter('Dépensé').props.style.color,
      });
    };

    const light = fingerprint('light');
    const dark = fingerprint('dark');
    expect(light).not.toBe(dark);

    const cellsOf = (fp: string) => JSON.parse(fp).cells as string[];
    // On the dark panel the stored category colors are already compliant, so
    // chartFill returns them untouched; on white the pale ones get darkened.
    expect(cellsOf(dark)).toEqual(expect.arrayContaining(CATEGORIES.map((c) => c.color)));

    const pale = CATEGORIES.filter((c) => contrastRatio(c.color, PANEL_SURFACE.light) < AA.graphic);
    expect(pale.length).toBeGreaterThan(0);
    for (const category of pale) {
      expect(cellsOf(light)).not.toContain(category.color);
      expect(cellsOf(light)).toContain(chartFill(category.color, 'light'));
    }
  });

  it('les tons des barres de progression suivent l\'usage réel', () => {
    const { html } = render('dark');
    // Exact classes, including the closing quote so `bg-emerald-500/15` (the
    // keyboard row highlight) can't be mistaken for the fill.
    expect(html.match(/rounded-full bg-emerald-500"/g)).toHaveLength(1); // 50% → on track
    expect(html.match(/rounded-full bg-amber-400"/g)).toHaveLength(1); // 90% → near the limit
    expect(html.match(/rounded-full bg-red-500"/g)).toHaveLength(1); // 250% → over budget
    expect(html.match(/bg-slate-800 rounded-full/g)).toHaveLength(3); // the tracks
  });

  it('ne met dans le donut que les catégories qui portent des dépenses', () => {
    const categories = [
      ...CATEGORIES,
      { id: 'c-idle', name: 'Épargne', type: 'savings' as const, allocated: 50000, color: '#14B8A6' },
    ];
    const { html, nodes } = render('light', categories);

    expect(propsOf(nodes, 'Pie')[0].data).toHaveLength(3); // spending only
    expect(html).toContain('Épargne'); // still budgeted in the detail list
    expect(html.match(/role="progressbar"/g)).toHaveLength(4);
  });
});
