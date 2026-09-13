import React, { useId, useMemo, useRef, useState } from 'react';
import {
  Plus, Pencil, Trash2, Download, Search, X, ArrowLeftRight,
  ArrowDownLeft, ArrowUpRight, ListFilter,
} from 'lucide-react';
import { Account, BudgetCategory, Transaction, TransactionType } from '../types';
import { formatMoney } from '../services/currency';
import { useI18n } from '../i18n/useI18n';
import {
  TransactionDraft, DraftError, TxFilters, emptyFilters, applyFilters,
  sortByDateDesc, distinctValues, distinctMonths, summarize,
  validateDraft, draftToTransaction, transactionToDraft, emptyDraft, toCsv,
} from '../services/transactions';
import { useModalA11y } from '../hooks/useModalA11y';
import { ROVING_ROW_FOCUS, RovingListNav, useRovingListNav } from '../hooks/useRovingListNav';

// ---------------------------------------------------------------------------
// Public component
// ---------------------------------------------------------------------------

interface TransactionsViewProps {
  accounts: Account[];
  transactions: Transaction[];
  categories: BudgetCategory[];
  /** ISO 4217 code from the Réglages currency preference. */
  currency: string;
  onUpsert: (tx: Transaction) => void;
  onDelete: (id: string) => void;
}

export const TransactionsView: React.FC<TransactionsViewProps> = ({
  accounts, transactions, categories, currency, onUpsert, onDelete,
}) => {
  const { t, locale } = useI18n();
  const [filters, setFilters] = useState<TxFilters>(emptyFilters);
  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState<Transaction | null>(null);
  const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null);
  const modalRef = useRef<HTMLFormElement>(null);

  const accountById = useMemo(
    () => new Map(accounts.map((a) => [a.id, a])),
    [accounts]
  );
  const accountName = (id: string) => accountById.get(id)?.name ?? id;

  const visible = useMemo(
    () => sortByDateDesc(applyFilters(transactions, filters)),
    [transactions, filters]
  );
  const summary = useMemo(() => summarize(visible), [visible]);

  const memberOptions = useMemo(() => distinctValues(transactions, 'member'), [transactions]);
  const categoryOptions = useMemo(() => distinctValues(transactions, 'category'), [transactions]);
  const monthOptions = useMemo(() => distinctMonths(transactions), [transactions]);

  const openCreate = () => { setEditing(null); setModalOpen(true); };
  const openEdit = (tx: Transaction) => { setEditing(tx); setModalOpen(true); };

  // Arrow keys walk the rows (one tab stop for the whole list): Enter opens the
  // row for editing — or confirms its pending deletion — Suppr arms it and
  // Escape disarms it. The buttons stay clickable for mouse users.
  const hintId = useId();
  const nav = useRovingListNav({
    count: visible.length,
    label: t('tx.listAria'),
    hintId,
    onActivate: (i) => {
      const tx = visible[i];
      if (!tx) return;
      if (pendingDeleteId === tx.id) {
        onDelete(tx.id);
        setPendingDeleteId(null);
        return;
      }
      openEdit(tx);
    },
    onRemove: (i) => {
      const tx = visible[i];
      if (tx) setPendingDeleteId(tx.id);
    },
    onEscape: () => setPendingDeleteId(null),
  });

  const exportCsv = () => {
    const csv = toCsv(visible, accountName);
    const blob = new Blob([`\uFEFF${csv}`], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `transactions-budget-et-compte-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const activeFilterCount = [
    filters.type !== 'all', filters.accountId !== 'all', filters.member !== 'all',
    filters.category !== 'all', filters.month !== 'all', filters.search.trim() !== '',
  ].filter(Boolean).length;

  return (
    <div className="space-y-6">
      {/* Header row */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-xl font-bold text-white flex items-center gap-2">
            <ListFilter className="h-5 w-5 text-emerald-400" />
            {t('tx.title')}
          </h2>
          <p className="text-xs text-slate-400">
            {t('tx.count', { n: visible.length, s: visible.length > 1 ? 's' : '' })}
            {activeFilterCount > 0 && t('tx.filterCount', { n: activeFilterCount, s: activeFilterCount > 1 ? 's' : '' })}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={exportCsv}
            disabled={visible.length === 0}
            className="px-3 py-2 rounded-xl bg-slate-800 hover:bg-slate-700 disabled:opacity-40 disabled:cursor-not-allowed text-slate-200 text-xs font-medium flex items-center gap-2 transition"
            title={t('tx.exportCsv')}
            aria-label={t('tx.exportCsv')}
          >
            <Download className="h-4 w-4" /> CSV
          </button>
          <button
            onClick={openCreate}
            className="px-4 py-2 rounded-xl bg-emerald-500 hover:bg-emerald-600 text-slate-950 text-xs font-bold flex items-center gap-2 transition"
          >
            <Plus className="h-4 w-4" /> {t('tx.new')}
          </button>
        </div>
      </div>

      {/* Summary of the filtered set */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">        <SummaryCard label={t('tx.income')} value={formatMoney(summary.income, currency, locale)} tone="text-emerald-400" />
        <SummaryCard label={t('tx.expenses')} value={formatMoney(summary.expenses, currency, locale)} tone="text-red-400" />
        <SummaryCard label={t('tx.net')} value={formatMoney(summary.net, currency, locale)} tone={summary.net >= 0 ? 'text-emerald-300' : 'text-red-300'} />
        <SummaryCard label={t('tx.transfers')} value={String(summary.transfers)} tone="text-sky-300" />
      </div>

      {/* Filters */}
      <div className="p-4 bg-slate-900 border border-slate-800 rounded-2xl grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
        <FilterSelect
          label={t('tx.filterType')}
          value={filters.type}
          onChange={(v) => setFilters({ ...filters, type: v as TxFilters['type'] })}
          options={[
            ['all', t('tx.allTypes')],
            ['expense', t('tx.type.expense')],
            ['income', t('tx.type.income')],
            ['transfer', t('tx.type.transfer')],
          ]}
        />
        <FilterSelect
          label={t('tx.filterAccount')}
          value={filters.accountId}
          onChange={(v) => setFilters({ ...filters, accountId: v })}
          options={[['all', t('tx.allAccounts')], ...accounts.map((a) => [a.id, a.name] as [string, string])]}
        />
        <FilterSelect
          label={t('tx.filterMember')}
          value={filters.member}
          onChange={(v) => setFilters({ ...filters, member: v })}
          options={[['all', t('tx.allMembers')], ...memberOptions.map((m) => [m, m] as [string, string])]}
        />
        <FilterSelect
          label={t('tx.filterCategory')}
          value={filters.category}
          onChange={(v) => setFilters({ ...filters, category: v })}
          options={[['all', t('tx.allCategories')], ...categoryOptions.map((c) => [c, c] as [string, string])]}
        />
        <FilterSelect
          label={t('tx.filterMonth')}
          value={filters.month}
          onChange={(v) => setFilters({ ...filters, month: v })}
          options={[['all', t('tx.allMonths')], ...monthOptions.map((m) => [m, m] as [string, string])]}
        />
        <label className="block">
          <span className="block text-[10px] uppercase tracking-wider text-slate-400 mb-1">{t('tx.search')}</span>
          <div className="relative">
            <Search className="h-3.5 w-3.5 text-slate-400 absolute left-2.5 top-2.5" aria-hidden="true" />
            <input
              value={filters.search}
              onChange={(e) => setFilters({ ...filters, search: e.target.value })}
              type="search"
              aria-label={t('tx.searchAria')}
              placeholder={t('tx.searchPlaceholder')}
              className="w-full rounded-lg bg-slate-800 border border-slate-700 pl-8 pr-2 py-1.5 text-xs text-white focus:outline-none focus:border-emerald-500"
            />
          </div>
        </label>
      </div>

      {/* Transaction list */}
      {visible.length === 0 ? (
        <div className="p-10 bg-slate-900 border border-dashed border-slate-800 rounded-2xl text-center">
          <p className="text-sm text-slate-400">{t('tx.noResults')}</p>
          {activeFilterCount > 0 && (
            <button
              onClick={() => setFilters(emptyFilters())}
              className="mt-3 text-xs text-emerald-400 hover:text-emerald-300 underline"
            >
              {t('tx.resetFilters')}
            </button>
          )}
        </div>
      ) : (
        <div className="space-y-2">
          <p id={hintId} className="text-[11px] text-slate-400 px-1">
            {t('a11y.listActionsHint')}
          </p>
          <div
            {...nav.listProps}
            className="bg-slate-900 border border-slate-800 rounded-2xl divide-y divide-slate-800 overflow-hidden"
          >
            {visible.map((tx, index) => (
              <TxRow
                key={tx.id}
                tx={tx}
                index={index}
                nav={nav}
                currency={currency}
                accountName={accountName}
                onEdit={() => openEdit(tx)}
                onRequestDelete={() => setPendingDeleteId(tx.id)}
                confirmDelete={() => { onDelete(tx.id); setPendingDeleteId(null); }}
                cancelDelete={() => setPendingDeleteId(null)}
                deleteArmed={pendingDeleteId === tx.id}
              />
            ))}
          </div>
        </div>
      )}

      {/* Modal */}
      {modalOpen && (
        <TxModal
          modalRef={modalRef}
          accounts={accounts}
          categorySuggestions={Array.from(new Set([...categories.map((c) => c.name), ...categoryOptions]))}
          memberSuggestions={memberOptions}
          currency={currency}
          editing={editing}
          onCancel={() => setModalOpen(false)}
          onSubmit={(draft) => {
            onUpsert(draftToTransaction(draft, editing?.id));
            setModalOpen(false);
          }}
        />
      )}
    </div>
  );
};

// ---------------------------------------------------------------------------
// Row
// ---------------------------------------------------------------------------

const TYPE_STYLE: Record<TransactionType, { icon: React.ReactNode; ring: string; sign: string; amount: string }> = {
  expense: { icon: <ArrowDownLeft className="h-4 w-4" />, ring: 'bg-red-500/10 text-red-400 border-red-500/20', sign: '−', amount: 'text-red-400' },
  income: { icon: <ArrowUpRight className="h-4 w-4" />, ring: 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20', sign: '+', amount: 'text-emerald-400' },
  transfer: { icon: <ArrowLeftRight className="h-4 w-4" />, ring: 'bg-sky-500/10 text-sky-400 border-sky-500/20', sign: '', amount: 'text-sky-300' },
};

const TxRow: React.FC<{
  tx: Transaction;
  /** Position in the filtered list — drives the roving tab stop. */
  index: number;
  nav: RovingListNav;
  currency: string;
  accountName: (id: string) => string;
  onEdit: () => void;
  onRequestDelete: () => void;
  confirmDelete: () => void;
  cancelDelete: () => void;
  deleteArmed: boolean;
}> = ({ tx, index, nav, currency, accountName, onEdit, onRequestDelete, confirmDelete, cancelDelete, deleteArmed }) => {
  const { t, locale } = useI18n();
  const style = TYPE_STYLE[tx.type];
  const dateLabel = new Date(`${tx.date}T00:00:00`).toLocaleDateString(locale, {
    day: '2-digit', month: 'short', year: 'numeric',
  });
  const amountLabel = `${style.sign}${formatMoney(tx.amount, currency, locale)}`;
  // A focused row carries the announced summary itself, so a screen reader
  // hears the operation instead of an unlabelled group of buttons.
  const rowLabel =
    t('tx.rowAria', {
      title: tx.title,
      amount: amountLabel,
      date: dateLabel,
      member: tx.member,
      account: tx.type === 'transfer' && tx.toAccountId
        ? `${accountName(tx.accountId)} → ${accountName(tx.toAccountId)}`
        : accountName(tx.accountId),
      category: tx.category,
    }) + (deleteArmed ? ` — ${t('tx.deleteConfirm')}` : '');

  return (
    <div
      {...nav.itemProps(index, { label: rowLabel })}
      className={`px-4 py-3 flex items-center gap-3 hover:bg-slate-800/40 transition group ${ROVING_ROW_FOCUS}`}
    >
      <div className={`p-2 rounded-xl border shrink-0 ${style.ring}`}>
        {style.icon}
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <h4 className="text-sm font-semibold text-white truncate">{tx.title}</h4>
          <span className="text-[10px] px-1.5 py-0.5 bg-slate-800 text-slate-400 rounded shrink-0">{tx.category}</span>
        </div>
        <p className="text-[11px] text-slate-400 truncate">
          {dateLabel} · {tx.member} · {accountName(tx.accountId)}
          {tx.type === 'transfer' && tx.toAccountId && ` → ${accountName(tx.toAccountId)}`}
        </p>
      </div>
      <span className={`text-sm font-bold shrink-0 ${style.amount}`}>
        {amountLabel}
      </span>
      {deleteArmed ? (
        <div className="flex items-center gap-1 shrink-0">
          <button onClick={confirmDelete} className="px-2 py-1 rounded-lg bg-red-500/20 border border-red-500/30 text-red-300 text-[10px] font-bold">
            {t('tx.deleteConfirm')}
          </button>
          <button onClick={cancelDelete} className="p-1 text-slate-400 hover:text-white" title={t('common.cancel')} aria-label={t('common.cancel')}>
            <X className="h-3.5 w-3.5" aria-hidden="true" />
          </button>
        </div>
      ) : (
        <div className="flex items-center gap-1 shrink-0 md:opacity-0 md:group-hover:opacity-100 md:group-focus:opacity-100 md:focus-within:opacity-100 transition">
          <button onClick={onEdit} className="p-1.5 text-slate-400 hover:text-white" title={t('common.edit')} aria-label={`${t('common.edit')} ${tx.title}`}>
            <Pencil className="h-3.5 w-3.5" aria-hidden="true" />
          </button>
          <button onClick={onRequestDelete} className="p-1.5 text-slate-400 hover:text-red-400" title={t('common.delete')} aria-label={`${t('common.delete')} ${tx.title}`}>
            <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
          </button>
        </div>
      )}
    </div>
  );
};

// ---------------------------------------------------------------------------
// Modal (create / edit)
// ---------------------------------------------------------------------------

const TYPE_LABELS: Array<[TransactionType, string]> = [
  ['expense', 'tx.type.expense'],
  ['income', 'tx.type.income'],
  ['transfer', 'tx.type.transfer'],
];

const TxModal: React.FC<{
  modalRef: React.RefObject<HTMLFormElement>;
  accounts: Account[];
  categorySuggestions: string[];
  memberSuggestions: string[];
  currency: string;
  editing: Transaction | null;
  onCancel: () => void;
  onSubmit: (draft: TransactionDraft) => void;
}> = ({ modalRef, accounts, categorySuggestions, memberSuggestions, currency, editing, onCancel, onSubmit }) => {
  const { t } = useI18n();
  const [draft, setDraft] = useState<TransactionDraft>(() =>
    editing ? transactionToDraft(editing) : emptyDraft()
  );
  const [submitted, setSubmitted] = useState(false);
  useModalA11y(modalRef, onCancel);

  const accountIds = useMemo(() => new Set(accounts.map((a) => a.id)), [accounts]);
  const errors: DraftError[] = validateDraft(draft, accountIds, t);
  const errorFor = (field: DraftError['field']) =>
    errors.find((e) => e.field === field)?.message;

  const set = <K extends keyof TransactionDraft>(key: K, value: TransactionDraft[K]) =>
    setDraft((d) => ({ ...d, [key]: value }));

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitted(true);
    if (errors.length === 0) onSubmit(draft);
  };

  const show = (field: DraftError['field']) => submitted ? errorFor(field) : undefined;

  const inputCls = (field: DraftError['field']) =>
    `w-full rounded-xl bg-slate-800 border px-3 py-2.5 text-sm text-white focus:outline-none transition ${
      submitted && errorFor(field) ? 'border-red-500/60' : 'border-slate-700 focus:border-emerald-500'
    }`;

  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/70 p-0 sm:p-4" onClick={onCancel}>
      <form
        ref={modalRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="tx-modal-title"
        onSubmit={handleSubmit}
        onClick={(e) => e.stopPropagation()}
        className="w-full sm:max-w-lg bg-slate-900 border border-slate-700 rounded-t-2xl sm:rounded-2xl p-5 space-y-4 max-h-[92vh] overflow-y-auto"
      >
        <div className="flex items-center justify-between">
          <h3 id="tx-modal-title" className="text-base font-bold text-white">
            {editing ? t('tx.modalEdit') : t('tx.modalNew')}
          </h3>
          <button type="button" onClick={onCancel} aria-label={t('common.close')} className="p-1.5 text-slate-400 hover:text-white rounded-lg hover:bg-slate-800">
            <X className="h-4 w-4" aria-hidden="true" />
          </button>
        </div>

        {/* Type switch — a real radiogroup for assistive tech */}
        <div role="radiogroup" aria-label={t('tx.typeLabel')} className="grid grid-cols-3 gap-1 p-1 bg-slate-800 rounded-xl">
          {TYPE_LABELS.map(([type, labelKey]) => (
            <button
              key={type}
              type="button"
              role="radio"
              aria-checked={draft.type === type}
              onClick={() => set('type', type)}
              className={`py-1.5 rounded-lg text-xs font-bold transition ${
                draft.type === type
                  ? type === 'expense' ? 'bg-red-500/20 text-red-300'
                    : type === 'income' ? 'bg-emerald-500/20 text-emerald-300'
                    : 'bg-sky-500/20 text-sky-300'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              {t(labelKey)}
            </button>
          ))}
        </div>

        <Field label={t('tx.titleField')} error={show('title')}>
          <input
            value={draft.title}
            onChange={(e) => set('title', e.target.value)}
            placeholder={t('tx.titlePlaceholder')}
            className={inputCls('title')}
            autoFocus
          />
        </Field>

        <div className="grid grid-cols-2 gap-3">
          <Field label={`${t('tx.amount')} (${currency})`} error={show('amount')}>
            <input
              type="number"
              min={1}
              step={1}
              value={draft.amount || ''}
              onChange={(e) => set('amount', Number(e.target.value))}
              placeholder="0"
              className={inputCls('amount')}
            />
          </Field>
          <Field label={t('tx.date')} error={show('date')}>
            <input
              type="date"
              value={draft.date}
              onChange={(e) => set('date', e.target.value)}
              className={inputCls('date')}
            />
          </Field>
        </div>

        <Field label={t('tx.category')} error={show('category')}>
          <input
            value={draft.category}
            onChange={(e) => set('category', e.target.value)}
            list="tx-category-suggestions"
            placeholder={t('tx.categoryPlaceholder')}
            className={inputCls('category')}
          />
          <datalist id="tx-category-suggestions">
            {categorySuggestions.map((c) => <option key={c} value={c} />)}
          </datalist>
        </Field>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <Field label={draft.type === 'transfer' ? t('tx.fromAccount') : t('tx.account')} error={show('accountId')}>
            <select
              value={draft.accountId}
              onChange={(e) => set('accountId', e.target.value)}
              className={inputCls('accountId')}
            >
              <option value="">{t('tx.choose')}</option>
              {accounts.map((a) => (
                <option key={a.id} value={a.id}>{a.name}</option>
              ))}
            </select>
          </Field>

          {draft.type === 'transfer' ? (
            <Field label={t('tx.toAccount')} error={show('toAccountId')}>
              <select
                value={draft.toAccountId ?? ''}
                onChange={(e) => set('toAccountId', e.target.value)}
                className={inputCls('toAccountId')}
              >
                <option value="">{t('tx.choose')}</option>
                {accounts.filter((a) => a.id !== draft.accountId).map((a) => (
                  <option key={a.id} value={a.id}>{a.name}</option>
                ))}
              </select>
            </Field>
          ) : (
            <Field label={t('tx.member')} error={show('member')}>
              <input
                value={draft.member}
                onChange={(e) => set('member', e.target.value)}
                list="tx-member-suggestions"
                placeholder={t('tx.memberPlaceholder')}
                className={inputCls('member')}
              />
              <datalist id="tx-member-suggestions">
                {memberSuggestions.map((m) => <option key={m} value={m} />)}
              </datalist>
            </Field>
          )}
        </div>

        {draft.type === 'transfer' && (
          <Field label={t('tx.member')} error={show('member')}>
            <input
              value={draft.member}
              onChange={(e) => set('member', e.target.value)}
              list="tx-member-suggestions-modal"
              placeholder={t('tx.memberPlaceholder')}
              className={inputCls('member')}
            />
            <datalist id="tx-member-suggestions-modal">
              {memberSuggestions.map((m) => <option key={m} value={m} />)}
            </datalist>
          </Field>
        )}

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

// ---------------------------------------------------------------------------
// Small shared pieces
// ---------------------------------------------------------------------------

const Field: React.FC<{ label: string; error?: string; children: React.ReactNode }> = ({ label, error, children }) => (
  // Wrapping the control makes the label an implicit accessible name for it.
  <label className="block">
    <span className="block text-xs font-medium text-slate-300 mb-1">{label}</span>
    {children}
    {error && <p role="alert" className="mt-1 text-[11px] text-red-400">{error}</p>}
  </label>
);

const SummaryCard: React.FC<{ label: string; value: string; tone: string }> = ({ label, value, tone }) => (
  <div className="p-3.5 bg-slate-900 border border-slate-800 rounded-xl">
    <span className="text-[10px] uppercase tracking-wider text-slate-400 block">{label}</span>
    <span className={`text-base font-bold ${tone}`}>{value}</span>
  </div>
);

const FilterSelect: React.FC<{
  label: string;
  value: string;
  onChange: (v: string) => void;
  options: Array<[string, string]>;
}> = ({ label, value, onChange, options }) => (
  <label className="block">
    <span className="block text-[10px] uppercase tracking-wider text-slate-400 mb-1">{label}</span>
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className="w-full rounded-lg bg-slate-800 border border-slate-700 px-2 py-1.5 text-xs text-white focus:outline-none focus:border-emerald-500"
    >
      {options.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
    </select>
  </label>
);
