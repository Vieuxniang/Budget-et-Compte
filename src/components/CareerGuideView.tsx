import React, { useState } from 'react';
import { Briefcase, Calculator } from 'lucide-react';
import { formatMoney } from '../services/currency';
import { useI18n } from '../i18n/useI18n';

export const CareerGuideView: React.FC<{ currency: string }> = ({ currency }) => {
  const { t, locale } = useI18n();
  const [currentSalary, setCurrentSalary] = useState<number>(600000);
  const [targetIncreasePct, setTargetIncreasePct] = useState<number>(15);

  const monthlyGain = currentSalary * (targetIncreasePct / 100);
  const newSalary = currentSalary + monthlyGain;
  const annualGain = monthlyGain * 12;

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-xl font-bold text-white flex items-center gap-2">
          <Briefcase className="h-5 w-5 text-emerald-400" />
          {t('career.title', { cur: currency })}
        </h2>
        <p className="text-xs text-slate-400">
          {t('career.subtitle')}
        </p>
      </div>

      <div className="rounded-2xl bg-slate-900 border border-slate-800 p-5 space-y-4">
        <h3 className="text-sm font-semibold text-emerald-400 uppercase tracking-wider flex items-center gap-2">
          <Calculator className="h-4 w-4" />
          {t('career.simulator')}
        </h3>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <label className="block">
            <span className="block text-xs font-medium text-slate-300 mb-1">{t('career.currentSalary', { cur: currency })}</span>
            <input
              type="number"
              value={currentSalary}
              onChange={(e) => setCurrentSalary(Number(e.target.value))}
              className="w-full rounded-xl bg-slate-800 border border-slate-700 px-3 py-2 text-sm text-white focus:outline-none focus:border-emerald-500"
            />
          </label>

          <label className="block">
            <span className="block text-xs font-medium text-slate-300 mb-1">{t('career.targetIncrease')}</span>
            <input
              type="number"
              min={1}
              max={100}
              value={targetIncreasePct}
              onChange={(e) => setTargetIncreasePct(Number(e.target.value))}
              className="w-full rounded-xl bg-slate-800 border border-slate-700 px-3 py-2 text-sm text-white focus:outline-none focus:border-emerald-500"
            />
          </label>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 bg-slate-950 p-4 rounded-xl border border-slate-800">
          <div>
            <span className="text-xs text-slate-400 block">{t('career.newSalary')}</span>
            <span className="text-lg font-bold text-white">{formatMoney(newSalary, currency, locale)}</span>
          </div>
          <div>
            <span className="text-xs text-slate-400 block">{t('career.monthlyGain')}</span>
            <span className="text-lg font-bold text-emerald-400">+{formatMoney(monthlyGain, currency, locale)}</span>
          </div>
          <div>
            <span className="text-xs text-emerald-300 block">{t('career.annualSaving')}</span>
            <span className="text-lg font-bold text-emerald-300">+{formatMoney(annualGain, currency, locale)}</span>
          </div>
        </div>
      </div>
    </div>
  );
};