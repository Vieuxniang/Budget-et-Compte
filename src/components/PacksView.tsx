import React, { useId, useMemo, useState } from 'react';
import {
  Check, Download, GraduationCap, Landmark, Lock, PieChart, Sparkles, Trash2, Wallet,
} from 'lucide-react';
import { useI18n } from '../i18n/useI18n';
import { useLicense } from '../hooks/useLicense';
import { formatMoney } from '../services/currency';
import { ROVING_ROW_FOCUS, useRovingListNav } from '../hooks/useRovingListNav';
import {
  CountryPack, InstalledPack, PACKS, canInstall, computePayroll, packLimit, templateAllocations,
  withholdingRate,
} from '../services/packs';
import type { TemplateAllocation } from '../services/packs';

/**
 * Country content packs — installable payroll rules, school fees and budget
 * templates.
 *
 * The screen is built around one idea: a pack is **inert until installed**, and
 * installing it only *offers* concrete things (categories, an estimate). Nothing
 * is created, deleted or overwritten without the user pressing a button, so the
 * paid unlock stays a convenience rather than a hostage: the free offer keeps one
 * pack, and a pack already installed is never hidden when a licence lapses.
 */
interface PacksViewProps {
  installed: InstalledPack[];
  currency: string;
  /** Starting value of the template's income field, derived from the ledger. */
  suggestedIncome: number;
  onInstall: (pack: CountryPack) => void;
  onUninstall: (packId: string) => void;
  /** Turns the template into real budget categories (idempotent). */
  onApplyTemplate: (pack: CountryPack, allocations: TemplateAllocation[]) => void;
  onRemoveTemplate: (pack: CountryPack) => void;
  onSeeOffer: () => void;
}

function parseAmount(value: string): number {
  return Math.round(Number(value.replace(/\s/g, '').replace(',', '.')) || 0);
}

export const PacksView: React.FC<PacksViewProps> = ({
  installed, currency, suggestedIncome, onInstall, onUninstall, onApplyTemplate, onRemoveTemplate,
  onSeeOffer,
}) => {
  const { t } = useI18n();
  const { plan } = useLicense();
  const limit = packLimit(plan);
  const room = canInstall(plan, installed.length);
  const installedIds = useMemo(() => new Set(installed.map((entry) => entry.id)), [installed]);

  const hintId = useId();
  const nav = useRovingListNav<HTMLUListElement>({
    count: PACKS.length,
    label: t('packs.title'),
    hintId,
  });

  return (
    <div className="space-y-6">
      <section className="bg-slate-900 border border-slate-800 rounded-2xl p-5 space-y-3">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="text-sm font-semibold text-emerald-400 uppercase tracking-wider flex items-center gap-2">
              <Landmark className="h-4 w-4" aria-hidden="true" /> {t('packs.title')}
            </h2>
            <p className="text-[11px] text-slate-400 mt-1 max-w-2xl">{t('packs.subtitle')}</p>
          </div>
          <span className="text-[11px] text-slate-400 whitespace-nowrap">
            {t('packs.planLine', { used: installed.length, limit })}
          </span>
        </div>
        {!room && (
          <div className="rounded-xl bg-emerald-500/10 border border-emerald-500/25 p-3 space-y-2">
            <p className="text-[11px] text-emerald-200 font-bold flex items-center gap-1.5">
              <Lock className="h-3.5 w-3.5" aria-hidden="true" /> {t('packs.lockedTitle')}
            </p>
            <p className="text-[11px] text-slate-300">{t('packs.lockedBody')}</p>
            <button
              onClick={onSeeOffer}
              className="px-3 py-2 rounded-xl bg-emerald-500 hover:bg-emerald-600 text-slate-950 text-xs font-bold transition flex items-center gap-1.5"
            >
              <Sparkles className="h-3.5 w-3.5" aria-hidden="true" /> {t('packs.lockedCta')}
            </button>
          </div>
        )}
      </section>

      <ul {...nav.listProps} className="space-y-4">
        {PACKS.map((pack, index) => {
          const entry = installed.find((item) => item.id === pack.id);
          const isInstalled = installedIds.has(pack.id);
          const canInstallNow = isInstalled || room;
          return (
            <li
              key={pack.id}
              {...nav.itemProps(index, { label: `${pack.name} — ${pack.currency}` })}
              className={`${ROVING_ROW_FOCUS} bg-slate-900 border border-slate-800 rounded-2xl p-5 space-y-4`}
            >
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <p className="text-sm font-bold text-white flex items-center gap-2">
                    <span className="text-[10px] font-bold px-2 py-0.5 rounded bg-slate-800 border border-slate-700 text-slate-300">
                      {pack.country}
                    </span>
                    {pack.name}
                    {isInstalled && (
                      <span className="text-[10px] uppercase font-bold text-emerald-400 flex items-center gap-1">
                        <Check className="h-3 w-3" aria-hidden="true" /> {t('packs.installed')}
                      </span>
                    )}
                  </p>
                  <p className="text-[11px] text-slate-400 mt-1 flex flex-wrap items-center gap-x-2 gap-y-1">
                    <span>{pack.currency}</span>
                    <span aria-hidden="true">·</span>
                    <span>{t('packs.asOf', { year: pack.asOf })}</span>
                    {pack.payroll && (
                      <span className="flex items-center gap-1">
                        <span aria-hidden="true">·</span>
                        <Wallet className="h-3 w-3" aria-hidden="true" /> {t('packs.included.payroll')}
                      </span>
                    )}
                    {pack.schoolFees && (
                      <span className="flex items-center gap-1">
                        <span aria-hidden="true">·</span>
                        <GraduationCap className="h-3 w-3" aria-hidden="true" /> {t('packs.included.school')}
                      </span>
                    )}
                    <span className="flex items-center gap-1">
                      <span aria-hidden="true">·</span>
                      <PieChart className="h-3 w-3" aria-hidden="true" /> {t('packs.included.budget')}
                    </span>
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  {isInstalled ? (
                    <button
                      onClick={() => onUninstall(pack.id)}
                      className="px-3 py-2 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs font-bold border border-slate-700 transition flex items-center gap-1.5"
                    >
                      <Trash2 className="h-3.5 w-3.5" aria-hidden="true" /> {t('packs.remove')}
                    </button>
                  ) : (
                    <button
                      onClick={() => onInstall(pack)}
                      disabled={!canInstallNow}
                      title={canInstallNow ? undefined : t('packs.locked')}
                      className="px-3 py-2 rounded-xl bg-emerald-500 hover:bg-emerald-600 disabled:opacity-40 disabled:cursor-not-allowed text-slate-950 text-xs font-bold transition flex items-center gap-1.5"
                    >
                      {canInstallNow
                        ? <Download className="h-3.5 w-3.5" aria-hidden="true" />
                        : <Lock className="h-3.5 w-3.5" aria-hidden="true" />}
                      {t('packs.install')}
                    </button>
                  )}
                </div>
              </div>

              {isInstalled && (
                <div className="space-y-4 border-t border-slate-800 pt-4">
                  {pack.payroll && <PayrollTool pack={pack} currency={pack.currency} />}
                  {pack.schoolFees && <SchoolFeesTool pack={pack} />}
                  <BudgetTemplateTool
                    pack={pack}
                    currency={currency}
                    suggestedIncome={suggestedIncome}
                    applied={Boolean(entry?.categoryIds?.length)}
                    onApply={onApplyTemplate}
                    onRemove={onRemoveTemplate}
                  />
                </div>
              )}
            </li>
          );
        })}
      </ul>

      <p id={hintId} className="text-[11px] text-slate-400">{t('packs.keyboardHint')}</p>
    </div>
  );
};

// ---------------------------------------------------------------------------
// Payroll estimator
// ---------------------------------------------------------------------------

const PayrollTool: React.FC<{ pack: CountryPack; currency: string }> = ({ pack, currency }) => {
  const { t, locale } = useI18n();
  const rules = pack.payroll!;
  const [gross, setGross] = useState('250000');
  const [dependents, setDependents] = useState('0');

  const result = useMemo(
    () => computePayroll(parseAmount(gross), rules, parseAmount(dependents)),
    [gross, dependents, rules]
  );
  const ratio = withholdingRate(result);

  return (
    <div className="rounded-xl bg-slate-800/50 border border-slate-700 p-4 space-y-3">
      <h3 className="text-[11px] uppercase tracking-wider text-emerald-400 font-bold flex items-center gap-1.5">
        <Wallet className="h-3.5 w-3.5" aria-hidden="true" /> {t('packs.tools.payroll.title')}
      </h3>
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="block">
          <span className="block text-[10px] uppercase tracking-wider text-slate-400 mb-1">
            {t('packs.tools.payroll.gross')}
          </span>
          <input
            value={gross}
            inputMode="numeric"
            onChange={(e) => setGross(e.target.value)}
            className="w-full rounded-lg bg-slate-800 border border-slate-700 px-3 py-2 text-xs text-white focus:outline-none focus:border-emerald-500"
          />
        </label>
        <label className="block">
          <span className="block text-[10px] uppercase tracking-wider text-slate-400 mb-1">
            {t('packs.tools.payroll.dependents')}
          </span>
          <input
            value={dependents}
            inputMode="numeric"
            onChange={(e) => setDependents(e.target.value)}
            className="w-full rounded-lg bg-slate-800 border border-slate-700 px-3 py-2 text-xs text-white focus:outline-none focus:border-emerald-500"
          />
        </label>
      </div>

      <dl className="grid gap-x-4 gap-y-1 text-[11px] sm:grid-cols-2">
        {result.contributions.map((line) => (
          <React.Fragment key={line.key}>
            <dt className="text-slate-400">{t(`packs.contrib.${line.key}`)}</dt>
            <dd className="text-slate-200 text-right sm:text-left">
              − {formatMoney(line.amount, currency, locale)}
            </dd>
          </React.Fragment>
        ))}
        <dt className="text-slate-400">{t('packs.tools.payroll.taxable')}</dt>
        <dd className="text-slate-200 text-right sm:text-left">{formatMoney(result.taxableBase, currency, locale)}</dd>
        <dt className="text-slate-400">{t('packs.tools.payroll.tax')}</dt>
        <dd className="text-slate-200 text-right sm:text-left">− {formatMoney(result.tax, currency, locale)}</dd>
        <dt className="text-slate-300 font-bold border-t border-slate-700 pt-1">
          {t('packs.tools.payroll.net')}
        </dt>
        <dd className="text-emerald-400 font-bold text-right sm:text-left border-t border-slate-700 pt-1">
          {formatMoney(result.net, currency, locale)}
        </dd>
      </dl>

      <p className="text-[11px] text-slate-400">
        {t('packs.tools.payroll.withholding', { rate: `${(ratio * 100).toFixed(1)} %` })}
      </p>
      <p className="text-[10px] text-amber-400/90">{t('packs.tools.payroll.disclaimer', { year: pack.asOf })}</p>
    </div>
  );
};

// ---------------------------------------------------------------------------
// School fees
// ---------------------------------------------------------------------------

const SchoolFeesTool: React.FC<{ pack: CountryPack }> = ({ pack }) => {
  const { t, locale } = useI18n();
  const levels = pack.schoolFees!;
  return (
    <div className="rounded-xl bg-slate-800/50 border border-slate-700 p-4 space-y-3">
      <h3 className="text-[11px] uppercase tracking-wider text-emerald-400 font-bold flex items-center gap-1.5">
        <GraduationCap className="h-3.5 w-3.5" aria-hidden="true" /> {t('packs.tools.school.title')}
      </h3>
      <p className="text-[11px] text-slate-400">{t('packs.tools.school.hint', { year: pack.asOf })}</p>
      <ul className="space-y-2">
        {levels.map((level) => (
          <li
            key={level.key}
            className="rounded-lg bg-slate-900/60 border border-slate-700 p-2.5 flex flex-wrap items-center justify-between gap-2 text-[11px]"
          >
            <span className="font-bold text-slate-100">{t(`packs.level.${level.key}`)}</span>
            <span className="flex flex-wrap items-center gap-x-3 gap-y-1 text-slate-300">
              <span>
                {t('packs.tools.school.public')} :{' '}
                <strong className="text-slate-100">{formatMoney(level.publicFee, pack.currency, locale)}</strong>
              </span>
              <span>
                {t('packs.tools.school.private')} :{' '}
                <strong className="text-slate-100">{formatMoney(level.privateFee, pack.currency, locale)}</strong>
              </span>
              <span>
                {t('packs.tools.school.supplies')} :{' '}
                <strong className="text-slate-100">{formatMoney(level.supplies, pack.currency, locale)}</strong>
              </span>
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
};

// ---------------------------------------------------------------------------
// Budget template
// ---------------------------------------------------------------------------

const BudgetTemplateTool: React.FC<{
  pack: CountryPack;
  currency: string;
  suggestedIncome: number;
  applied: boolean;
  onApply: (pack: CountryPack, allocations: TemplateAllocation[]) => void;
  onRemove: (pack: CountryPack) => void;
}> = ({ pack, currency, suggestedIncome, applied, onApply, onRemove }) => {
  const { t, locale } = useI18n();
  const [income, setIncome] = useState(String(suggestedIncome));
  const allocations = useMemo(
    () => templateAllocations(pack, parseAmount(income)),
    [pack, income]
  );

  return (
    <div className="rounded-xl bg-slate-800/50 border border-slate-700 p-4 space-y-3">
      <h3 className="text-[11px] uppercase tracking-wider text-emerald-400 font-bold flex items-center gap-1.5">
        <PieChart className="h-3.5 w-3.5" aria-hidden="true" /> {t('packs.tools.budget.title')}
      </h3>
      <label className="block max-w-xs">
        <span className="block text-[10px] uppercase tracking-wider text-slate-400 mb-1">
          {t('packs.tools.budget.income')}
        </span>
        <input
          value={income}
          inputMode="numeric"
          onChange={(e) => setIncome(e.target.value)}
          className="w-full rounded-lg bg-slate-800 border border-slate-700 px-3 py-2 text-xs text-white focus:outline-none focus:border-emerald-500"
        />
      </label>

      <ul className="grid gap-x-4 gap-y-1 text-[11px] sm:grid-cols-2">
        {allocations.map((line) => (
          <li key={line.key} className="flex items-center justify-between gap-2">
            <span className="text-slate-300 flex items-center gap-1.5">
              <span
                className="inline-block h-2.5 w-2.5 rounded-full"
                style={{ backgroundColor: line.color }}
                aria-hidden="true"
              />
              {t(`packs.category.${line.key}`)}
              <span className="text-slate-500">{Math.round((line.allocated / Math.max(1, parseAmount(income))) * 100)} %</span>
            </span>
            <span className="text-slate-200">{formatMoney(line.allocated, currency, locale)}</span>
          </li>
        ))}
      </ul>

      <div className="flex flex-wrap items-center gap-2">
        <button
          onClick={() => onApply(pack, allocations)}
          className="px-3 py-2 rounded-xl bg-emerald-500 hover:bg-emerald-600 text-slate-950 text-xs font-bold transition flex items-center gap-1.5"
        >
          <Check className="h-3.5 w-3.5" aria-hidden="true" />
          {applied ? t('packs.tools.budget.reapply') : t('packs.tools.budget.apply')}
        </button>
        {applied && (
          <button
            onClick={() => onRemove(pack)}
            className="px-3 py-2 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs font-bold border border-slate-700 transition flex items-center gap-1.5"
          >
            <Trash2 className="h-3.5 w-3.5" aria-hidden="true" /> {t('packs.tools.budget.remove')}
          </button>
        )}
      </div>
      <p className="text-[11px] text-slate-400">{applied ? t('packs.tools.budget.applied') : t('packs.tools.budget.hint')}</p>
    </div>
  );
};
