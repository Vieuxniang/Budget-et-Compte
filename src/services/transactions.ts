import { Transaction, TransactionType } from '../types';
import { frTranslate, Translate } from '../i18n/translations';

// ---------------------------------------------------------------------------
// Validation & mutation helpers (pure — used by the UI and testable directly)
// ---------------------------------------------------------------------------

export interface TransactionDraft {
  date: string;
  title: string;
  amount: number;
  type: TransactionType;
  category: string;
  accountId: string;
  toAccountId?: string;
  member: string;
}

export interface DraftError {
  field: keyof TransactionDraft | '_';
  message: string;
}

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export const emptyDraft = (): TransactionDraft => ({
  date: new Date().toISOString().slice(0, 10),
  title: '',
  amount: 0,
  type: 'expense',
  category: '',
  accountId: '',
  member: 'Famille',
});

/** Validates a draft. Transfers must have a distinct, non-empty destination. */
export function validateDraft(
  draft: TransactionDraft,
  accountIds: ReadonlySet<string>,
  t: Translate = frTranslate
): DraftError[] {
  const errors: DraftError[] = [];

  if (!ISO_DATE_RE.test(draft.date)) {
    errors.push({ field: 'date', message: t('errors.dateInvalid') });
  }
  if (!draft.title.trim()) {
    errors.push({ field: 'title', message: t('errors.titleRequired') });
  }
  if (!Number.isFinite(draft.amount) || draft.amount <= 0) {
    errors.push({ field: 'amount', message: t('errors.amountPositive') });
  }
  if (!draft.category.trim()) {
    errors.push({ field: 'category', message: t('errors.categoryRequired') });
  }
  if (!accountIds.has(draft.accountId)) {
    errors.push({ field: 'accountId', message: t('errors.accountRequired') });
  }
  if (draft.type === 'transfer') {
    if (!draft.toAccountId) {
      errors.push({ field: 'toAccountId', message: t('errors.destinationRequired') });
    } else if (draft.toAccountId === draft.accountId) {
      errors.push({ field: 'toAccountId', message: t('errors.destinationDifferent') });
    } else if (!accountIds.has(draft.toAccountId)) {
      errors.push({ field: 'toAccountId', message: t('errors.destinationUnknown') });
    }
  }
  if (!draft.member.trim()) {
    errors.push({ field: 'member', message: t('errors.memberRequired') });
  }

  return errors;
}

export function draftToTransaction(draft: TransactionDraft, existingId?: string): Transaction {
  const tx: Transaction = {
    id: existingId ?? generateTxId(),
    date: draft.date,
    title: draft.title.trim(),
    amount: Math.abs(draft.amount),
    type: draft.type,
    category: draft.category.trim(),
    accountId: draft.accountId,
    member: draft.member.trim(),
  };
  if (draft.type === 'transfer' && draft.toAccountId) {
    tx.toAccountId = draft.toAccountId;
  }
  return tx;
}

export function transactionToDraft(tx: Transaction): TransactionDraft {
  return {
    date: tx.date,
    title: tx.title,
    amount: tx.amount,
    type: tx.type,
    category: tx.category,
    accountId: tx.accountId,
    toAccountId: tx.toAccountId,
    member: tx.member,
  };
}

let idCounter = 0;
export function generateTxId(): string {
  idCounter += 1;
  return `tx-${Date.now().toString(36)}-${idCounter.toString(36)}`;
}

// ---------------------------------------------------------------------------
// Filtering & sorting
// ---------------------------------------------------------------------------

export interface TxFilters {
  type: TransactionType | 'all';
  accountId: string; // 'all' or account id (matches either side of transfers)
  member: string; // 'all' or member name
  category: string; // 'all' or category name
  month: string; // 'all' or 'YYYY-MM'
  search: string;
}

export const emptyFilters = (): TxFilters => ({
  type: 'all',
  accountId: 'all',
  member: 'all',
  category: 'all',
  month: 'all',
  search: '',
});

export function applyFilters(txs: Transaction[], f: TxFilters): Transaction[] {
  const q = f.search.trim().toLowerCase();
  return txs.filter((tx) => {
    if (f.type !== 'all' && tx.type !== f.type) return false;
    if (f.accountId !== 'all' && tx.accountId !== f.accountId && tx.toAccountId !== f.accountId) return false;
    if (f.member !== 'all' && tx.member !== f.member) return false;
    if (f.category !== 'all' && tx.category !== f.category) return false;
    if (f.month !== 'all' && !tx.date.startsWith(f.month)) return false;
    if (q && !tx.title.toLowerCase().includes(q) && !tx.category.toLowerCase().includes(q)) return false;
    return true;
  });
}

/** Newest first; id as a deterministic tiebreaker. */
export function sortByDateDesc(txs: Transaction[]): Transaction[] {
  return [...txs].sort((a, b) => {
    if (a.date !== b.date) return a.date > b.date ? -1 : 1;
    return a.id > b.id ? -1 : a.id < b.id ? 1 : 0;
  });
}

/** Distinct values for the filter dropdowns, from the data itself. */
export function distinctValues(txs: Transaction[], key: 'member' | 'category'): string[] {
  return Array.from(new Set(txs.map((tx) => tx[key]))).sort((a, b) => a.localeCompare(b, 'fr'));
}

export function distinctMonths(txs: Transaction[]): string[] {
  return Array.from(new Set(txs.map((tx) => tx.date.slice(0, 7)))).sort().reverse();
}

/** Signed flow: income +, expense −, transfers excluded (they are not flows). */
export function flowOf(tx: Transaction): number {
  switch (tx.type) {
    case 'income':
      return Math.abs(tx.amount);
    case 'expense':
      return -Math.abs(tx.amount);
    case 'transfer':
      return 0;
  }
}

export interface FlowSummary {
  income: number;
  expenses: number;
  transfers: number; // count
  net: number;
}

export function summarize(txs: Transaction[]): FlowSummary {
  let income = 0;
  let expenses = 0;
  let transfers = 0;
  for (const tx of txs) {
    if (tx.type === 'income') income += Math.abs(tx.amount);
    else if (tx.type === 'expense') expenses += Math.abs(tx.amount);
    else transfers += 1;
  }
  return { income, expenses, transfers, net: income - expenses };
}

// ---------------------------------------------------------------------------
// CSV export (semicolon — the French Excel convention)
// ---------------------------------------------------------------------------

const CSV_HEADERS = ['id', 'date', 'titre', 'montant', 'type', 'categorie', 'compte', 'versCompte', 'membre'] as const;

function csvCell(value: string | number | undefined): string {
  const s = value === undefined ? '' : String(value);
  return /[";\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(txs: Transaction[], accountName: (id: string) => string): string {
  const rows = txs.map((tx) =>
    [
      tx.id,
      tx.date,
      tx.title,
      tx.amount,
      tx.type,
      tx.category,
      accountName(tx.accountId),
      tx.toAccountId ? accountName(tx.toAccountId) : '',
      tx.member,
    ]
      .map(csvCell)
      .join(';')
  );
  return [CSV_HEADERS.join(';'), ...rows].join('\n');
}
