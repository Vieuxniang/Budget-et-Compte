import React, { useState } from 'react';
import { BadgeCheck, KeyRound, Lock, Check, Sparkles, ShieldCheck, CreditCard, MailCheck } from 'lucide-react';
import { useI18n } from '../i18n/useI18n';
import { useLicense } from '../hooks/useLicense';
import { hasShop, shopLink } from '../services/shop';

interface OfferViewProps {
  /**
   * The Réglages currency preference, used only to open the checkout on the
   * right country. Absent in tests and in builds without a shop.
   */
  currency?: string;
}

/**
 * Offer & license. The whole flow is offline: the key is verified by signature
 * on the device (see services/license.ts), so there is nothing to log into and
 * nothing to phone home about.
 *
 * Buying is the one place that needs a network — and even that is a plain link
 * out to the shop (`services/shop.ts`), which does its own talking. The app has
 * no code path to a server, which is what keeps the offline promise honest.
 */
export const OfferView: React.FC<OfferViewProps> = ({ currency }) => {
  const { t } = useI18n();
  const { state, isPro, checking, activate, deactivate } = useLicense();
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [activated, setActivated] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // A key can also be rejected at load time (stored earlier, tampered with, or
  // simply from another publisher) — the screen must say so instead of looking
  // like no key was ever entered.
  const storedProblem = error
    ?? (state.status === 'invalid' ? t(`settings.license.error.${state.reason}`) : null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy || !key.trim()) return;
    setBusy(true);
    setActivated(false);
    setError(null);
    const next = await activate(key);
    setBusy(false);
    if (next.status === 'active') {
      setKey('');
      setActivated(true);
      return;
    }
    setError(
      next.status === 'invalid'
        ? t(`settings.license.error.${next.reason}`)
        : t('settings.license.error.format')
    );
  };

  return (
    <section className="bg-slate-900 border border-slate-800 rounded-2xl p-5 space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold text-emerald-400 uppercase tracking-wider flex items-center gap-2">
            <KeyRound className="h-4 w-4" aria-hidden="true" /> {t('settings.license.title')}
          </h3>
          <p className="text-[11px] text-slate-400 mt-1">{t('settings.license.subtitle')}</p>
        </div>
        <span
          className={`shrink-0 whitespace-nowrap text-[10px] uppercase font-bold px-2 py-1 rounded flex items-center gap-1 border ${
            isPro
              ? 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20'
              : 'bg-slate-800 text-slate-300 border-slate-700'
          }`}
        >
          {isPro ? <BadgeCheck className="h-3 w-3" aria-hidden="true" /> : <Lock className="h-3 w-3" aria-hidden="true" />}
          {isPro ? t('settings.license.planPro') : t('settings.license.planFree')}
        </span>
      </div>

      {checking && <p className="text-[11px] text-slate-400">{t('settings.license.checking')}</p>}

      {isPro && state.status === 'active' && (
        <div className="space-y-1 text-xs text-slate-300">
          {state.payload.name && (
            <p className="font-bold text-white">{t('settings.license.licensedTo', { name: state.payload.name })}</p>
          )}
          <p className="text-[11px] text-slate-400">
            {t('settings.license.reference', { id: state.payload.id, date: state.payload.issued })}
          </p>
          <p className="text-[11px] text-slate-400">
            {state.payload.expires
              ? t('settings.license.expires', { date: state.payload.expires })
              : t('settings.license.perpetual')}
          </p>
        </div>
      )}

      {!isPro && (
        <ul className="space-y-1.5 text-xs text-slate-300">
          <li className="flex items-start gap-2">
            <Check className="h-3.5 w-3.5 text-emerald-400 shrink-0 mt-0.5" aria-hidden="true" />
            {t('settings.license.benefitGoals')}
          </li>
          <li className="flex items-start gap-2">
            <ShieldCheck className="h-3.5 w-3.5 text-emerald-400 shrink-0 mt-0.5" aria-hidden="true" />
            {t('settings.license.benefitNoTrack')}
          </li>
          <li className="flex items-start gap-2">
            <Sparkles className="h-3.5 w-3.5 text-emerald-400 shrink-0 mt-0.5" aria-hidden="true" />
            {t('settings.license.benefitPro')}
          </li>
        </ul>
      )}

      {!isPro && hasShop() && (
        <div className="rounded-xl border border-emerald-500/30 bg-emerald-500/5 p-3 space-y-2">
          <p className="text-xs font-semibold text-emerald-300 flex items-center gap-1.5">
            <CreditCard className="h-3.5 w-3.5" aria-hidden="true" />
            {t('settings.license.buyTitle')}
          </p>
          <a
            href={shopLink({ plan: 'pro', currency })}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center justify-center gap-2 w-full px-3 py-2 rounded-xl bg-emerald-500 hover:bg-emerald-600 text-slate-950 text-xs font-bold transition"
          >
            <CreditCard className="h-3.5 w-3.5" aria-hidden="true" />
            {t('settings.license.buyCta')}
          </a>
          <p className="text-[11px] text-slate-400 flex items-start gap-1.5">
            <MailCheck className="h-3.5 w-3.5 text-emerald-400 shrink-0 mt-0.5" aria-hidden="true" />
            {t('settings.license.buyHint')}
          </p>
        </div>
      )}

      {!isPro && (
        <form onSubmit={submit} className="space-y-2">
          <label className="block">
            <span className="block text-[10px] uppercase tracking-wider text-slate-400 mb-1">
              {t('settings.license.keyLabel')}
            </span>
            <input
              value={key}
              onChange={(e) => { setKey(e.target.value); setError(null); setActivated(false); }}
              placeholder={t('settings.license.keyPlaceholder')}
              spellCheck={false}
              autoComplete="off"
              className="w-full rounded-lg bg-slate-800 border border-slate-700 px-3 py-2 text-xs text-white font-mono focus:outline-none focus:border-emerald-500"
            />
          </label>

          {storedProblem && <p role="alert" className="text-[11px] text-red-400">{storedProblem}</p>}
          {activated && (
            <p className="text-[11px] text-emerald-400 flex items-center gap-1.5">
              <BadgeCheck className="h-3.5 w-3.5" aria-hidden="true" /> {t('settings.license.activated')}
            </p>
          )}

          <div className="flex flex-wrap items-center gap-2">
            <button
              type="submit"
              disabled={busy || !key.trim()}
              className="px-3 py-2 rounded-xl bg-emerald-500 hover:bg-emerald-600 disabled:opacity-40 disabled:cursor-not-allowed text-slate-950 text-xs font-bold transition"
            >
              {busy ? t('settings.license.activating') : t('settings.license.activate')}
            </button>
            <span className="text-[11px] text-slate-400">{t('settings.license.howToGet')}</span>
          </div>
        </form>
      )}

      {state.status !== 'free' && (
        <button
          onClick={() => { deactivate(); setActivated(false); setError(null); }}
          className="text-[11px] text-slate-400 hover:text-red-400 underline"
        >
          {t('settings.license.remove')}
        </button>
      )}

      <p className="text-[11px] text-slate-400 flex items-start gap-1.5">
        <ShieldCheck className="h-3.5 w-3.5 text-emerald-400 shrink-0 mt-0.5" aria-hidden="true" />
        {t('settings.license.offline')}
      </p>
    </section>
  );
};
