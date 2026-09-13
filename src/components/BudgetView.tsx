import React, { useId, useMemo, useState } from 'react';
import {
  PieChart, Pie, Cell, BarChart, Bar, XAxis, YAxis, Tooltip, Legend,
  ResponsiveContainer, CartesianGrid,
} from 'recharts';
import { PiggyBank, AlertTriangle, TrendingUp, Wallet } from 'lucide-react';
import { BudgetCategory, Transaction } from '../types';
import { formatMoney } from '../services/currency';
import {
  budgetSummary, monthLabel, currentMonthIso, type CategoryBudgetStatus,
} from '../services/budget';
import { useI18n } from '../i18n/useI18n';
import { Preferences } from '../services/preferences';
import { CHART_COLORS, LEGEND_INK, TOOLTIP, chartFill } from '../services/themePalette';
import { ROVING_ROW_FOCUS, useRovingListNav } from '../hooks/useRovingListNav';

interface BudgetViewProps {
  categories: BudgetCategory[];
  transactions: Transaction[];
  /** ISO 4217 code from the Réglages currency preference. */
  currency: string;
  /** Current theme — recharts colors are theme-aware (raw hex doesn't flip via CSS). */
  theme: Preferences['theme'];
}

export const BudgetView: React.FC<BudgetViewProps> = ({ categories, transactions, currency, theme }) => {
  const c = CHART_COLORS[theme];
  const { t, locale } = useI18n();
  const [month, setMonth] = useState<string>(currentMonthIso);
  // Keyboard-focus state per chart: null = not focused, else active row index.
  const [barIdx, setBarIdx] = useState<number | null>(null);
  const [donutIdx, setDonutIdx] = useState<number | null>(null);

  const availableMonths = useMemo(() => {
    const set = new Set(transactions.map((tx) => tx.date.slice(0, 7)));
    set.add(currentMonthIso());
    return Array.from(set).sort().reverse();
  }, [transactions]);

  const summary = useMemo(
    () => budgetSummary(categories, transactions, month),
    [categories, transactions, month]
  );

  const chartData = summary.statuses.map((s) => ({
    name: s.category.name,
    Alloué: s.category.allocated,
    Dépensé: s.spent,
    // Stored brand colors rarely clear 3:1 on the white panel — chartFill only
    // adjusts them where the theme demands it (see services/themePalette.ts).
    color: chartFill(s.category.color, theme),
  }));

  const donutData = summary.statuses
    .filter((s) => s.spent > 0)
    .map((s) => ({ name: s.category.name, value: s.spent, color: chartFill(s.category.color, theme) }));

  return (
    <div className="space-y-6 max-w-5xl">
      {/* Header + month picker */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-xl font-bold text-white flex items-center gap-2">
            <PiggyBank className="h-5 w-5 text-emerald-400" />
            {t('budget.title', { month: monthLabel(month, t) })}
          </h2>
          <p className="text-xs text-slate-400">{t('budget.subtitle')}</p>
        </div>
        <select
          value={month}
          onChange={(e) => setMonth(e.target.value)}
          aria-label={t('budget.selectMonth')}
          className="rounded-xl bg-slate-800 border border-slate-700 px-3 py-2 text-sm text-white focus:outline-none focus:border-emerald-500"
        >
          {availableMonths.map((m) => (
            <option key={m} value={m}>{monthLabel(m, t)}</option>
          ))}
        </select>
      </div>

      {/* Summary cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <SummaryCard label={t('budget.allocated')} value={formatMoney(summary.allocated, currency, locale)} tone="text-white" />
        <SummaryCard label={t('budget.spent')} value={formatMoney(summary.spent, currency, locale)} tone="text-red-300" />
        <SummaryCard
          label={summary.remaining >= 0 ? t('budget.remaining') : t('budget.over')}
          value={formatMoney(summary.remaining, currency, locale)}
          tone={summary.remaining >= 0 ? 'text-emerald-300' : 'text-red-300'}
        />
        <SummaryCard label={t('budget.income')} value={formatMoney(summary.income, currency, locale)} tone="text-emerald-400" />
      </div>

      {summary.overCount > 0 && (
        <div className="p-3 bg-red-500/10 border border-red-500/30 rounded-xl text-xs text-red-300 flex items-center gap-2">
          <AlertTriangle className="h-4 w-4 shrink-0" />
          {t('budget.overCount', { n: summary.overCount, s: summary.overCount > 1 ? 's' : '' })}
        </div>
      )}

      {/* Charts — the SVG renderings are decorative (aria-hidden); the data is
          fully exposed in the summary cards, the per-category detail below, and
          the focusable keyboard views (arrow keys browse) — all screen-reader friendly. */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <ChartCard title={t('budget.allocVsSpent')}>
          <div aria-hidden="true">
          <ResponsiveContainer width="100%" height={320}>
            <BarChart data={chartData} margin={{ top: 8, right: 8, left: -10, bottom: 30 }}>
              <CartesianGrid strokeDasharray="3 3" stroke={c.grid} />
              <XAxis
                dataKey="name"
                tick={{ fill: c.axisTick, fontSize: 10 }}
                interval={0}
                angle={-20}
                textAnchor="end"
                height={60}
              />
              <YAxis
                tick={{ fill: c.axisTick, fontSize: 10 }}
                tickFormatter={(v) => `${Math.round(v / 1000)}k`}
              />
              <Tooltip
                formatter={(value: number) => formatMoney(value, currency, locale)}
                contentStyle={{ background: TOOLTIP.background, border: `1px solid ${TOOLTIP.border}`, borderRadius: 12, fontSize: 12, color: TOOLTIP.text }}
                labelStyle={{ color: TOOLTIP.label, fontWeight: 600 }}
                itemStyle={{ color: TOOLTIP.text }}
              />
              {/* Legend labels use the theme ink so they always clear 4.5:1; the
                  colored swatch keeps the series↔color mapping. */}
              <Legend
                wrapperStyle={{ fontSize: 12 }}
                formatter={(value) => <span style={{ color: LEGEND_INK[theme] }}>{value}</span>}
              />
              <Bar dataKey="Alloué" fill={c.barAllocated} radius={[6, 6, 0, 0]} />
              <Bar dataKey="Dépensé" fill={c.barSpent} radius={[6, 6, 0, 0]}>
                {chartData.map((entry) => (
                  <Cell key={entry.name} fill={entry.color} />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
          </div>
          <KeyboardChartData
            label={t('budget.chartAria')}
            hint={t('budget.chartHint')}
            rows={chartData.map((d) => ({
              name: d.name,
              values: [formatMoney(d.Alloué, currency, locale), formatMoney(d.Dépensé, currency, locale)],
            }))}
            active={barIdx}
            onActiveChange={setBarIdx}
          />
        </ChartCard>

        <ChartCard title={t('budget.spendingSplit')}>
          {donutData.length === 0 ? (
            <EmptyChart />
          ) : (
            <>
              <div aria-hidden="true">
              <ResponsiveContainer width="100%" height={320}>
                <PieChart>
                  <Pie
                    data={donutData}
                    dataKey="value"
                    nameKey="name"
                    innerRadius={70}
                    outerRadius={110}
                    paddingAngle={3}
                    stroke="none"
                  >
                    {donutData.map((entry) => (
                      <Cell key={entry.name} fill={entry.color} />
                    ))}
                  </Pie>
                  <Tooltip
                    formatter={(value: number) => formatMoney(value, currency, locale)}
                    contentStyle={{ background: TOOLTIP.background, border: `1px solid ${TOOLTIP.border}`, borderRadius: 12, fontSize: 12, color: TOOLTIP.text }}
                    labelStyle={{ color: TOOLTIP.label, fontWeight: 600 }}
                    itemStyle={{ color: TOOLTIP.text }}
                  />
                <Legend
                  wrapperStyle={{ fontSize: 12 }}
                  formatter={(value) => <span style={{ color: LEGEND_INK[theme] }}>{value}</span>}
                />
              </PieChart>
              </ResponsiveContainer>
              </div>              <KeyboardChartData
                label={t('budget.chartAria')}
                hint={t('budget.chartHint')}
                rows={donutData.map((d) => ({
              name: d.name,
              values: [formatMoney(d.value, currency, locale)],
            }))}
            active={donutIdx}
                onActiveChange={setDonutIdx}
              />
            </>
          )}
        </ChartCard>
      </div>

      {/* Per-category progress — keyboard-browsable rows (own component so the
          list can own its focus state) */}
      <CategoryBreakdown statuses={summary.statuses} currency={currency} theme={theme} />

      {/* Unbudgeted spending */}
      {summary.unbudgeted.length > 0 && (
        <div className="bg-slate-900 border border-amber-800/40 rounded-2xl p-5 space-y-3">
          <h3 className="text-sm font-semibold text-amber-300 uppercase tracking-wider flex items-center gap-2">
            <TrendingUp className="h-4 w-4" /> {t('budget.unbudgeted')}
          </h3>
          <p className="text-[11px] text-slate-400">
            {t('budget.unbudgetedHint')}
          </p>
          <ul className="divide-y divide-slate-800 border border-slate-800 rounded-xl overflow-hidden">
            {summary.unbudgeted.map((u) => (
              <li key={u.name} className="px-4 py-2.5 flex justify-between items-center text-sm">
                <span className="text-slate-200">{u.name}</span>
                <span className="font-bold text-amber-300">{formatMoney(u.spent, currency, locale)}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
};

// ---------------------------------------------------------------------------
// Small pieces
// ---------------------------------------------------------------------------

const SummaryCard: React.FC<{ label: string; value: string; tone: string }> = ({ label, value, tone }) => (
  <div className="p-3.5 bg-slate-900 border border-slate-800 rounded-xl">
    <span className="text-[10px] uppercase tracking-wider text-slate-400 block">{label}</span>
    <span className={`text-base font-bold ${tone}`}>{value}</span>
  </div>
);

const ChartCard: React.FC<{ title: string; children: React.ReactNode }> = ({ title, children }) => (
  <div className="bg-slate-900 border border-slate-800 rounded-2xl p-4">
    <h3 className="text-sm font-semibold text-white mb-2">{title}</h3>
    {children}
  </div>
);

const EmptyChart: React.FC = () => {
  const { t } = useI18n();
  return (
    <div className="h-[320px] flex items-center justify-center text-sm text-slate-400">
      {t('budget.empty')}
    </div>
  );
};

/**
 * Per-category progress panel. It lives in its own component so the rows can
 * own the keyboard list: one tab stop for the whole panel, arrow keys walk the
 * categories, and each focused row announces its allocation, spending and
 * usage (the progress bars themselves are decorative to assistive tech).
 */
const CategoryBreakdown: React.FC<{
  statuses: CategoryBudgetStatus[];
  currency: string;
  theme: Preferences['theme'];
}> = ({ statuses, currency, theme }) => {
  const { t, locale } = useI18n();
  const hintId = useId();
  const nav = useRovingListNav({
    count: statuses.length,
    label: t('budget.detailAria'),
    hintId,
  });

  return (
    <div className="bg-slate-900 border border-slate-800 rounded-2xl p-5 space-y-4">
      <h3 className="text-sm font-semibold text-emerald-400 uppercase tracking-wider flex items-center gap-2">
        <Wallet className="h-4 w-4" aria-hidden="true" /> {t('budget.detail')}
      </h3>
      <p id={hintId} className="text-[11px] text-slate-400">
        {t('a11y.listNavHint')}
      </p>
      <div {...nav.listProps} className="space-y-4">
        {statuses.map((s, index) => {
          const pct = s.usagePct ?? 0;
          // Accent classes are theme-aware: the emerald/red/amber scales are
          // CSS variables, so these fills clear 3:1 on both panels.
          const barColor = s.isOver ? 'bg-red-500' : pct > 85 ? 'bg-amber-400' : 'bg-emerald-500';
          return (
            <div
              key={s.category.id}
              {...nav.itemProps(index, {
                label: t('budget.categoryRowAria', {
                  name: s.category.name,
                  spent: formatMoney(s.spent, currency, locale),
                  allocated: formatMoney(s.category.allocated, currency, locale),
                  pct: Math.round(pct),
                }),
              })}
              className={`space-y-1.5 rounded-lg ${ROVING_ROW_FOCUS}`}
            >
              <div className="flex items-center justify-between text-xs">
                <span className="flex items-center gap-2 text-slate-200">
                  <span className="h-2.5 w-2.5 rounded-full shrink-0" style={{ background: chartFill(s.category.color, theme) }} />
                  {s.category.name}
                  {s.isOver && <AlertTriangle className="h-3 w-3 text-red-400" />}
                </span>
                <span className="text-slate-400 tabular-nums">
                  {formatMoney(s.spent, currency, locale)} / {formatMoney(s.category.allocated, currency, locale)}
                  {s.usagePct !== null && (
                    <strong className={`ml-2 ${s.isOver ? 'text-red-400' : 'text-slate-300'}`}>
                      {Math.round(pct)}%
                    </strong>
                  )}
                </span>
              </div>
              <div
                className="h-2 bg-slate-800 rounded-full overflow-hidden"
                role="progressbar"
                aria-valuenow={Math.round(pct)}
                aria-valuemin={0}
                aria-valuemax={100}
                aria-label={t('budget.usedAria', { name: s.category.name, pct: Math.round(pct) })}
              >
                <div className={`h-full rounded-full ${barColor}`} style={{ width: `${Math.min(100, pct)}%` }} />
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
};

/**
 * Focusable keyboard view for a chart: the data list appears on focus and the
 * arrow keys (←/→, ↑/↓, Home/End) move a highlighted row — no mouse required.
 */
const KeyboardChartData: React.FC<{
  label: string;
  hint: string;
  rows: { name: string; values: string[] }[];
  active: number | null;
  onActiveChange: (i: number | null) => void;
}> = ({ label, hint, rows, active, onActiveChange }) => {
  const open = active !== null && rows.length > 0;
  return (
    <div
      tabIndex={0}
      role="group"
      aria-label={label}
      onFocus={() => onActiveChange(active === null ? 0 : active)}
      onBlur={(e) => {
        // Keep the list open while focus stays inside this frame.
        if (e.relatedTarget instanceof Node && e.currentTarget.contains(e.relatedTarget)) return;
        onActiveChange(null);
      }}
      onKeyDown={(e) => {
        if (rows.length === 0) return;
        let next: number | null = null;
        if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
          next = ((active ?? 0) + 1) % rows.length;
        } else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
          next = ((active ?? 0) - 1 + rows.length) % rows.length;
        } else if (e.key === 'Home') {
          next = 0;
        } else if (e.key === 'End') {
          next = rows.length - 1;
        }
        if (next !== null) {
          e.preventDefault();
          onActiveChange(next);
        }
      }}
      className="mt-3 -mx-1 rounded-xl p-1 outline-none focus:ring-2 focus:ring-emerald-500 focus:bg-slate-800/40"
    >
      <p className="text-[11px] text-slate-400">{hint}</p>
      {open && (
        <ul className="mt-2 border border-slate-700 rounded-xl divide-y divide-slate-800 overflow-hidden">
          {rows.map((r, i) => (
            <li
              key={r.name}
              className={`flex items-center justify-between gap-3 border-l-2 px-3 py-1.5 text-xs ${
                i === active
                  ? 'border-emerald-500 bg-emerald-500/15 text-white'
                  : 'border-transparent text-slate-300'
              }`}
            >
              <span className="font-medium">{r.name}</span>
              <span className="tabular-nums text-slate-200">{r.values.join(' · ')}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
};