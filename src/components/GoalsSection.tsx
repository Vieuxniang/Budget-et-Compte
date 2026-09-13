import React, { useId, useMemo, useRef, useState } from 'react';
import { PiggyBank, Plus, Pencil, Trash2, X, Lock, Check, Target } from 'lucide-react';
import { SavingsGoal } from '../types';
import { formatMoney } from '../services/currency';
import { useI18n } from '../i18n/useI18n';
import { useModalA11y } from '../hooks/useModalA11y';
import { ROVING_ROW_FOCUS, useRovingListNav } from '../hooks/useRovingListNav';
import { useLicense } from '../hooks/useLicense';
import { savingsGoalLimit } from '../services/license';
import {
  GOAL_CATEGORIES, GoalDraft, GoalDraftError, draftToGoal, emptyGoalDraft,
  goalProgress, goalToDraft, validateGoalDraft,
} from '../services/goals';

interface GoalsSectionProps {
  goals: SavingsGoal[];
  /** ISO 4217 code from the Réglages currency preference. */
  currency: string;
  onUpsert: (goal: SavingsGoal) => void;
  onDelete: (id: string) => void;
  /** Sends the user to the offer (Réglages → Offre & licence). */
  onSeeOffer: () => void;
}

/**
 * Savings goals. The offer is honest about the gate: existing goals are never
 * hidden or locked, only *adding* beyond the free limit asks for Pro.
 */
export const GoalsSection: React.FC<GoalsSectionProps> = ({
  goals, currency, onUpsert, onDelete, onSeeOffer,
}) => {
  const { t, locale } = useI18n();
  const { plan } = useLicense();
  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState<SavingsGoal | null>(null);
  const [armedId, setArmedId] = useState<string | null>(null);
  const [showUpsell, setShowUpsell] = useState(false);
  const modalRef = useRef<HTMLFormElement>(null);

  const limit = savingsGoalLimit(plan);
  const atLimit = goals.length >= limit;

  const rows = useMemo(
    () => goals.map((goal) => {
      const progress = goalProgress(goal);
      const saved = formatMoney(goal.currentAmount, currency, locale);
      const target = formatMoney(goal.targetAmount, currency, locale);
      const deadline = goal.deadline
        ? t('goals.deadline', {
            date: new Date(`${goal.deadline}T00:00:00`).toLocaleDateString(locale, {
              day: '2-digit', month: 'short', year: 'numeric',
            }),
          })
        : t('goals.noDeadline');
      return {
        goal,
        progress,
        saved,
        target,
        deadline,
        // Same convention as the other lists: the focused row also announces
        // the pending deletion while it is armed.
        label: t('goals.rowAria', { name: goal.name, saved, target, pct: progress.pct, deadline })
          + (armedId === goal.id ? ` — ${t('goals.deleteConfirm')}` : ''),
      };
    }),
    [goals, currency, locale, t, armedId]
  );

  const openCreate = () => {
    if (atLimit) {
      setShowUpsell(true);
      return;
    }
    setEditing(null);
    setModalOpen(true);
  };
  const openEdit = (goal: SavingsGoal) => { setEditing(goal); setModalOpen(true); };

  const hintId = useId();
  const nav = useRovingListNav({
    count: rows.length,
    label: t('goals.listAria'),
    hintId: rows.length > 0 ? hintId : undefined,
    onActivate: (i) => {
      const row = rows[i];
      if (!row) return;
      if (armedId === row.goal.id) {
        onDelete(row.goal.id);
        setArmedId(null);
        return;
      }
      openEdit(row.goal);
    },
    onRemove: (i) => {
      const row = rows[i];
      if (row) setArmedId(row.goal.id);
    },
    onEscape: () => setArmedId(null),
  });

  return (
    <section className="bg-slate-900 border border-slate-800 rounded-2xl p-5 space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold text-emerald-400 uppercase tracking-wider flex items-center gap-2">
            <PiggyBank className="h-4 w-4" aria-hidden="true" /> {t('goals.title')}
          </h2>
          <p className="text-[11px] text-slate-400 mt-1">{t('goals.subtitle')}</p>
        </div>
        <button
          onClick={openCreate}
          className="px-3 py-2 rounded-xl bg-emerald-500 hover:bg-emerald-600 text-slate-950 text-xs font-bold flex items-center gap-1.5 transition"
        >
          {atLimit ? <Lock className="h-3.5 w-3.5" aria-hidden="true" /> : <Plus className="h-3.5 w-3.5" aria-hidden="true" />}
          {t('goals.new')}
        </button>
      </div>

      {goals.length === 0 ? (
        <p className="text-sm text-slate-400">{t('goals.empty')}</p>
      ) : (
        <div className="space-y-2">
          {rows.length > 0 && (
            <p id={hintId} className="text-[11px] text-slate-400 px-1">{t('a11y.listActionsHint')}</p>
          )}
          <div {...nav.listProps} className="divide-y divide-slate-800 border border-slate-800 rounded-xl overflow-hidden">
            {rows.map((row, index) => (
              <div
                key={row.goal.id}
                {...nav.itemProps(index, { label: row.label })}
                className={`px-4 py-3 space-y-2 ${ROVING_ROW_FOCUS}`}
              >
                <div className="flex items-center gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <h3 className="text-sm font-semibold text-white truncate">{row.goal.name}</h3>
                      <span className="text-[10px] px-1.5 py-0.5 bg-slate-800 text-slate-400 rounded shrink-0">
                        {t(`goals.category.${row.goal.category}`)}
                      </span>
                      {row.progress.reached && (
                        <span className="text-[10px] px-1.5 py-0.5 rounded bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 shrink-0 flex items-center gap-1">
                          <Check className="h-3 w-3" aria-hidden="true" /> {t('goals.reached')}
                        </span>
                      )}
                    </div>
                    <p className="text-[11px] text-slate-400 truncate">
                      {t('goals.saved')} {row.saved} / {row.target} · {row.deadline}
                    </p>
                  </div>
                  {armedId === row.goal.id ? (
                    <div className="flex items-center gap-1 shrink-0">
                      <button
                        onClick={() => { onDelete(row.goal.id); setArmedId(null); }}
                        className="px-2 py-1 rounded-lg bg-red-500/20 border border-red-500/30 text-red-300 text-[10px] font-bold"
                      >
                        {t('goals.deleteConfirm')}
                      </button>
                      <button
                        onClick={() => setArmedId(null)}
                        className="p-1 text-slate-400 hover:text-white"
                        title={t('common.cancel')}
                        aria-label={t('common.cancel')}
                      >
                        <X className="h-3.5 w-3.5" aria-hidden="true" />
                      </button>
                    </div>
                  ) : (
                    <div className="flex items-center gap-1 shrink-0">
                      <button
                        onClick={() => openEdit(row.goal)}
                        className="p-1.5 text-slate-400 hover:text-white"
                        title={t('common.edit')}
                        aria-label={`${t('common.edit')} ${row.goal.name}`}
                      >
                        <Pencil className="h-3.5 w-3.5" aria-hidden="true" />
                      </button>
                      <button
                        onClick={() => setArmedId(row.goal.id)}
                        className="p-1.5 text-slate-400 hover:text-red-400"
                        title={t('common.delete')}
                        aria-label={`${t('common.delete')} ${row.goal.name}`}
                      >
                        <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                      </button>
                    </div>
                  )}
                </div>

                <div className="space-y-1">
                  <div
                    className="h-2 bg-slate-800 rounded-full overflow-hidden"
                    role="progressbar"
                    aria-valuenow={row.progress.pct}
                    aria-valuemin={0}
                    aria-valuemax={100}
                    aria-label={t('goals.progressAria', { name: row.goal.name, pct: row.progress.pct })}
                  >
                    <div
                      className={`h-full rounded-full ${row.progress.reached ? 'bg-emerald-400' : 'bg-emerald-500'}`}
                      style={{ width: `${row.progress.pct}%` }}
                    />
                  </div>
                  <p className="text-[10px] text-slate-400 text-right tabular-nums">
                    {row.progress.reached
                      ? t('goals.reached')
                      : t('goals.remaining', { amount: formatMoney(row.progress.remaining, currency, locale) })}
                  </p>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {showUpsell && atLimit && (
        <div className="p-4 bg-emerald-500/10 border border-emerald-500/30 rounded-xl space-y-2">
          <p className="text-xs font-bold text-emerald-300 flex items-center gap-2">
            <Target className="h-3.5 w-3.5" aria-hidden="true" /> {t('goals.upgradeTitle')}
          </p>
          <p className="text-[11px] text-slate-300">{t('goals.freeLimit')}</p>
          <button
            onClick={onSeeOffer}
            className="px-3 py-1.5 rounded-lg bg-emerald-500 hover:bg-emerald-600 text-slate-950 text-xs font-bold transition"
          >
            {t('goals.upgrade')}
          </button>
        </div>
      )}

      {modalOpen && (
        <GoalModal
          modalRef={modalRef}
          currency={currency}
          editing={editing}
          onCancel={() => setModalOpen(false)}
          onSubmit={(draft) => {
            onUpsert(draftToGoal(draft, editing?.id));
            setModalOpen(false);
          }}
        />
      )}
    </section>
  );
};

// ---------------------------------------------------------------------------
// Add / edit modal
// ---------------------------------------------------------------------------

const GoalModal: React.FC<{
  modalRef: React.RefObject<HTMLFormElement>;
  currency: string;
  editing: SavingsGoal | null;
  onCancel: () => void;
  onSubmit: (draft: GoalDraft) => void;
}> = ({ modalRef, currency, editing, onCancel, onSubmit }) => {
  const { t } = useI18n();
  const [draft, setDraft] = useState<GoalDraft>(() =>
    editing ? goalToDraft(editing) : emptyGoalDraft()
  );
  const [submitted, setSubmitted] = useState(false);
  useModalA11y(modalRef, onCancel);

  const errors: GoalDraftError[] = validateGoalDraft(draft, t);
  const errorFor = (field: GoalDraftError['field']) =>
    errors.find((e) => e.field === field)?.message;
  const show = (field: GoalDraftError['field']) => (submitted ? errorFor(field) : undefined);

  const set = <K extends keyof GoalDraft>(key: K, value: GoalDraft[K]) =>
    setDraft((d) => ({ ...d, [key]: value }));

  const inputCls = (field: GoalDraftError['field']) =>
    `w-full rounded-xl bg-slate-800 border px-3 py-2.5 text-sm text-white focus:outline-none transition ${
      submitted && errorFor(field) ? 'border-red-500/60' : 'border-slate-700 focus:border-emerald-500'
    }`;

  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/70 p-0 sm:p-4" onClick={onCancel}>
      <form
        ref={modalRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="goal-modal-title"
        onSubmit={(e) => {
          e.preventDefault();
          setSubmitted(true);
          if (errors.length === 0) onSubmit(draft);
        }}
        onClick={(e) => e.stopPropagation()}
        className="w-full sm:max-w-lg bg-slate-900 border border-slate-700 rounded-t-2xl sm:rounded-2xl p-5 space-y-4 max-h-[92vh] overflow-y-auto"
      >
        <div className="flex items-center justify-between">
          <h3 id="goal-modal-title" className="text-base font-bold text-white">
            {editing ? t('goals.modalEdit') : t('goals.modalNew')}
          </h3>
          <button type="button" onClick={onCancel} aria-label={t('common.close')} className="p-1.5 text-slate-400 hover:text-white rounded-lg hover:bg-slate-800">
            <X className="h-4 w-4" aria-hidden="true" />
          </button>
        </div>

        <label className="block">
          <span className="block text-xs font-medium text-slate-300 mb-1">{t('goals.nameField')}</span>
          <input
            value={draft.name}
            onChange={(e) => set('name', e.target.value)}
            placeholder={t('goals.namePlaceholder')}
            className={inputCls('name')}
            autoFocus
          />
          {show('name') && <p role="alert" className="mt-1 text-[11px] text-red-400">{show('name')}</p>}
        </label>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <label className="block">
            <span className="block text-xs font-medium text-slate-300 mb-1">
              {t('goals.targetField', { cur: currency })}
            </span>
            <input
              type="number"
              min={1}
              step={1}
              value={draft.targetAmount || ''}
              onChange={(e) => set('targetAmount', Number(e.target.value))}
              placeholder="0"
              className={inputCls('targetAmount')}
            />
            {show('targetAmount') && <p role="alert" className="mt-1 text-[11px] text-red-400">{show('targetAmount')}</p>}
          </label>
          <label className="block">
            <span className="block text-xs font-medium text-slate-300 mb-1">
              {t('goals.currentField', { cur: currency })}
            </span>
            <input
              type="number"
              min={0}
              step={1}
              value={draft.currentAmount || ''}
              onChange={(e) => set('currentAmount', Number(e.target.value))}
              placeholder="0"
              className={inputCls('currentAmount')}
            />
            {show('currentAmount') && <p role="alert" className="mt-1 text-[11px] text-red-400">{show('currentAmount')}</p>}
          </label>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <label className="block">
            <span className="block text-xs font-medium text-slate-300 mb-1">{t('goals.categoryField')}</span>
            <select
              value={draft.category}
              onChange={(e) => set('category', e.target.value as GoalDraft['category'])}
              className={inputCls('category')}
            >
              {GOAL_CATEGORIES.map((category) => (
                <option key={category} value={category}>{t(`goals.category.${category}`)}</option>
              ))}
            </select>
          </label>
          <label className="block">
            <span className="block text-xs font-medium text-slate-300 mb-1">{t('goals.deadlineField')}</span>
            <input
              type="date"
              value={draft.deadline}
              onChange={(e) => set('deadline', e.target.value)}
              className={inputCls('deadline')}
            />
            {show('deadline') && <p role="alert" className="mt-1 text-[11px] text-red-400">{show('deadline')}</p>}
          </label>
        </div>

        {submitted && errors.length > 0 && (
          <div role="alert" className="p-3 bg-red-500/10 border border-red-500/30 rounded-xl text-xs text-red-300">
            {errors.map((e, i) => <p key={i}>{e.message}</p>)}
          </div>
        )}

        <div className="flex gap-2 pt-1">
          <button
            type="button"
            onClick={onCancel}
            className="flex-1 py-2.5 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-200 text-sm font-semibold transition"
          >
            {t('common.cancel')}
          </button>
          <button
            type="submit"
            className="flex-1 py-2.5 rounded-xl bg-emerald-500 hover:bg-emerald-600 text-slate-950 text-sm font-bold transition"
          >
            {editing ? t('common.save') : t('common.add')}
          </button>
        </div>
      </form>
    </div>
  );
};
