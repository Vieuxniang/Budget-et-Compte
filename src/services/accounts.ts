import { Account, AccountType, Transaction } from '../types';
import { frTranslate, Translate } from '../i18n/translations';

// ---------------------------------------------------------------------------
// Draft validation (pure)
// ---------------------------------------------------------------------------

export interface AccountDraft {
  name: string;
  type: AccountType;
  holder: string;
  institution: string;
  initialBalance: number;
  currency: string;
}

export const emptyAccountDraft = (currency = 'FCFA'): AccountDraft => ({
  name: '',
  type: 'wave',
  holder: 'Famille',
  institution: '',
  initialBalance: 0,
  currency,
});

export interface AccountDraftError {
  field: keyof AccountDraft;
  message: string;
}

export function validateAccountDraft(
  draft: AccountDraft,
  t: Translate = frTranslate
): AccountDraftError[] {
  const errors: AccountDraftError[] = [];

  if (!draft.name.trim()) {
    errors.push({ field: 'name', message: t('errors.accountNameRequired') });
  }
  if (draft.initialBalance !== 0 && !Number.isFinite(draft.initialBalance)) {
    errors.push({ field: 'initialBalance', message: t('errors.initialBalanceInvalid') });
  }
  if (draft.type === 'loan' && draft.initialBalance < 0) {
    errors.push({ field: 'initialBalance', message: t('errors.loanPositive') });
  }
  if (draft.type !== 'loan' && draft.initialBalance < 0) {
    errors.push({ field: 'initialBalance', message: t('errors.balanceNonNegative') });
  }
  if (!draft.holder.trim()) {
    errors.push({ field: 'holder', message: t('errors.holderRequired') });
  }
  if (draft.currency.trim().length < 2) {
    errors.push({ field: 'currency', message: t('errors.currencyInvalid') });
  }

  return errors;
}

let accIdCounter = 0;
export function generateAccountId(): string {
  accIdCounter += 1;
  return `acc-${Date.now().toString(36)}-${accIdCounter.toString(36)}`;
}

export function draftToAccount(draft: AccountDraft, existingId?: string): Account {
  return {
    id: existingId ?? generateAccountId(),
    name: draft.name.trim(),
    type: draft.type,
    holder: draft.holder.trim(),
    institution: draft.institution.trim() || draft.name.trim(),
    initialBalance: draft.type === 'loan' ? Math.abs(draft.initialBalance) : draft.initialBalance,
    currency: draft.currency.trim().toUpperCase(),
  };
}

export function accountToDraft(acc: Account): AccountDraft {
  return {
    name: acc.name,
    type: acc.type,
    holder: acc.holder,
    institution: acc.institution,
    // Loans are stored positive (amount owed); edit shows it as a positive due.
    initialBalance: acc.type === 'loan' ? Math.abs(acc.initialBalance) : acc.initialBalance,
    currency: acc.currency,
  };
}

// ---------------------------------------------------------------------------
// Deletion guard (pure — used by SettingsView before confirming)
// ---------------------------------------------------------------------------

/**
 * Deleting an account would orphan its transactions and silently corrupt the
 * ledger. Returns the blocking transactions, empty when deletion is safe.
 */
export function transactionsUsingAccount(
  transactions: Transaction[],
  accountId: string
): Transaction[] {
  return transactions.filter(
    (tx) => tx.accountId === accountId || tx.toAccountId === accountId
  );
}
