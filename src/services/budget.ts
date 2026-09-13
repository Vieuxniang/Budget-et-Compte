import { BudgetCategory, Transaction } from '../types';
import { frTranslate, Translate } from '../i18n/translations';

/**
 * Budget math for one month ('YYYY-MM').
 *
 * Semantics:
 * - Spending = expenses whose date falls in the month, grouped by category name.
 *   Transfers are excluded (they move money, they don't consume it).
 * - Income is reported for context (can the family fund the budget?).
 * - Spending in a category with no budget line shows up as "unbudgeted"
 *   instead of vanishing silently.
 */

export interface CategoryBudgetStatus {
  category: BudgetCategory;
  spent: number;
  remaining: number; // allocated − spent (negative when over)
  /** spent/allocated in %, null when the category allocates nothing. */
  usagePct: number | null;
  isOver: boolean;
}

export interface UnbudgetedSpend {
  name: string;
  spent: number;
}

export interface BudgetMonthSummary {
  month: string; // 'YYYY-MM'
  allocated: number;
  spent: number; // total across budgeted categories
  income: number;
  remaining: number; // allocated − spent
  overCount: number;
  /** Budgeted categories, over-budget first, then by usage descending. */
  statuses: CategoryBudgetStatus[];
  /** Spending in categories without a budget line, biggest first. */
  unbudgeted: UnbudgetedSpend[];
}

export function expensesForMonth(txs: Transaction[], month: string): Transaction[] {
  return txs.filter((tx) => tx.type === 'expense' && tx.date.startsWith(month));
}

export function incomeForMonth(txs: Transaction[], month: string): number {
  return txs
    .filter((tx) => tx.type === 'income' && tx.date.startsWith(month))
    .reduce((sum, tx) => sum + Math.abs(tx.amount), 0);
}

export function budgetSummary(
  categories: BudgetCategory[],
  txs: Transaction[],
  month: string
): BudgetMonthSummary {
  const monthExpenses = expensesForMonth(txs, month);

  const spendByName = new Map<string, number>();
  for (const tx of monthExpenses) {
    spendByName.set(tx.category, (spendByName.get(tx.category) ?? 0) + Math.abs(tx.amount));
  }

  const statuses: CategoryBudgetStatus[] = categories.map((category) => {
    const spent = spendByName.get(category.name) ?? 0;
    spendByName.delete(category.name); // remainder = unbudgeted
    return {
      category,
      spent,
      remaining: category.allocated - spent,
      usagePct: category.allocated > 0 ? (spent / category.allocated) * 100 : null,
      isOver: spent > category.allocated,
    };
  });

  // Over budget first (worst first), then highest usage, then untouched lines.
  statuses.sort((a, b) => {
    if (a.isOver !== b.isOver) return a.isOver ? -1 : 1;
    const pa = a.usagePct ?? -1;
    const pb = b.usagePct ?? -1;
    if (pa !== pb) return pb - pa;
    return a.category.name.localeCompare(b.category.name, 'fr');
  });

  const unbudgeted: UnbudgetedSpend[] = Array.from(spendByName.entries())
    .map(([name, spent]) => ({ name, spent }))
    .sort((a, b) => b.spent - a.spent);

  const allocated = categories.reduce((sum, c) => sum + c.allocated, 0);
  const spent = statuses.reduce((sum, s) => sum + s.spent, 0);

  return {
    month,
    allocated,
    spent,
    income: incomeForMonth(txs, month),
    remaining: allocated - spent,
    overCount: statuses.filter((s) => s.isOver).length,
    statuses,
    unbudgeted,
  };
}

/** '2026-09' → 'Septembre 2026' (localized). Falls back to the raw value when malformed. */
export function monthLabel(month: string, t: Translate = frTranslate): string {
  const match = /^(\d{4})-(\d{2})$/.exec(month);
  if (!match) return month;
  const idx = Number(match[2]) - 1;
  if (idx < 0 || idx > 11) return month;
  const name = t(`months.${idx + 1}`);
  return `${name.charAt(0).toUpperCase()}${name.slice(1)} ${match[1]}`;
}

/** Convenience for the UI default selection. Not used by pure functions. */
export function currentMonthIso(): string {
  return new Date().toISOString().slice(0, 7);
}
