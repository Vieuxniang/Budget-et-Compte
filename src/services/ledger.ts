/**
 * Ledger engine — the single source of truth for money math.
 *
 * Design principles:
 * - 100% pure: no React, no localStorage, no Date.now(). Everything derives
 *   from (accounts, transactions), so it is trivially unit-testable.
 * - Single book of record: account balances are always DERIVED from
 *   initialBalance + signed sum of transactions, never stored.
 * - Transfers are double-entry: money leaves A and arrives in B. A transfer
 *   must never change net worth.
 */

import { Account, AccountType, Transaction } from '../types';

/** Sign convention: income +, expense −, transfer 0 (net) — it only moves money. */
export function signedAmount(tx: Transaction): number {
  switch (tx.type) {
    case 'income':
      return Math.abs(tx.amount);
    case 'expense':
      return -Math.abs(tx.amount);
    case 'transfer':
      return 0; // net effect lives in the two legs, not the headline amount
  }
}

/** The other side of a transfer (the account receiving money). */
export function counterpartyAccountId(tx: Transaction): string | undefined {
  return tx.type === 'transfer' ? tx.toAccountId : undefined;
}

/** Sort helper: chronological, with id as a stable tiebreaker. */
function byDateThenId(a: Transaction, b: Transaction): number {
  if (a.date !== b.date) return a.date < b.date ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * Balance of one account as of `asOf` (exclusive upper bound, ISO date —
 * e.g. '2026-10-01' means "through September 30"). Transactions may come in
 * any order; we sort internally so results are deterministic.
 */
export function balanceOf(
  accounts: Account[],
  txs: Transaction[],
  accountId: string,
  asOf?: string
): number {
  const account = accounts.find((a) => a.id === accountId);
  if (!account) throw new Error(`Compte inconnu: ${accountId}`);

  return txs
    .filter((tx) => tx.accountId === accountId || tx.toAccountId === accountId)
    .filter((tx) => (asOf ? tx.date < asOf : true))
    .sort(byDateThenId)
    .reduce((bal, tx) => {
      if (tx.type === 'transfer') {
        if (tx.accountId === accountId) return bal - Math.abs(tx.amount); // outgoing leg
        return bal + Math.abs(tx.amount); // incoming leg (toAccountId)
      }
      return bal + signedAmount(tx);
    }, account.initialBalance);
}

/** Loans (and other debt accounts) reduce net worth instead of increasing it. */
export function isLiability(type: AccountType): boolean {
  return type === 'loan';
}

/** Assets minus liabilities. The number that matters — loans count negatively. */
export function netWorth(accounts: Account[], txs: Transaction[], asOf?: string): number {
  return netWorthBreakdown(accounts, txs, asOf).net;
}

export interface NetWorthBreakdown {
  assets: number;
  liabilities: number; // positive number = what is owed
  net: number;
  liabilityAccountIds: string[];
}

export function netWorthBreakdown(
  accounts: Account[],
  txs: Transaction[],
  asOf?: string
): NetWorthBreakdown {
  let assets = 0;
  let liabilities = 0;
  const liabilityAccountIds: string[] = [];

  for (const acc of accounts) {
    const bal = balanceOf(accounts, txs, acc.id, asOf);
    if (isLiability(acc.type)) {
      liabilities += Math.abs(bal);
      liabilityAccountIds.push(acc.id);
    } else {
      assets += bal;
    }
  }

  return { assets, liabilities, net: assets - liabilities, liabilityAccountIds };
}

/** All balances keyed by account id — the sanctioned way for the UI to read balances. */
export function balancesByAccountId(
  accounts: Account[],
  txs: Transaction[],
  asOf?: string
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const acc of accounts) {
    out[acc.id] = balanceOf(accounts, txs, acc.id, asOf);
  }
  return out;
}

export interface LedgerIssue {
  code:
    | 'account_missing_id'
    | 'duplicate_account_id'
    | 'non_finite_number'
    | 'unknown_account'
    | 'transfer_missing_target'
    | 'self_transfer'
    | 'non_positive_amount'
    | 'duplicate_tx_id';
  message: string;
  accountId?: string;
  txId?: string;
}

/**
 * Data-integrity check, run on every load.
 * Catches: unknown account references, transfers without a valid destination,
 * self-transfers, non-positive/non-finite amounts, duplicate ids.
 */
export function validateLedger(accounts: Account[], txs: Transaction[]): LedgerIssue[] {
  const issues: LedgerIssue[] = [];

  const accountIds = new Set<string>();
  for (const acc of accounts) {
    if (!acc.id) {
      issues.push({ code: 'account_missing_id', message: 'Compte sans identifiant' });
      continue;
    }
    if (accountIds.has(acc.id)) {
      issues.push({ code: 'duplicate_account_id', message: `Identifiant de compte dupliqué: ${acc.id}` });
    }
    accountIds.add(acc.id);

    if (typeof acc.initialBalance !== 'number' || !Number.isFinite(acc.initialBalance)) {
      issues.push({
        code: 'non_finite_number',
        message: `Solde initial invalide sur « ${acc.name} »`,
        accountId: acc.id,
      });
    }
  }

  const txIds = new Set<string>();
  for (const tx of txs) {
    if (!accountIds.has(tx.accountId)) {
      issues.push({
        code: 'unknown_account',
        message: `Transaction « ${tx.title} » référence un compte inconnu`,
        txId: tx.id,
      });
    }
    if (tx.type === 'transfer') {
      if (!tx.toAccountId) {
        issues.push({
          code: 'transfer_missing_target',
          message: `Virement « ${tx.title} » sans compte de destination`,
          txId: tx.id,
        });
      } else if (tx.toAccountId === tx.accountId) {
        issues.push({ code: 'self_transfer', message: `Virement vers lui-même: « ${tx.title} »`, txId: tx.id });
      } else if (!accountIds.has(tx.toAccountId)) {
        issues.push({
          code: 'unknown_account',
          message: `Virement « ${tx.title} » référence un compte de destination inconnu`,
          txId: tx.id,
        });
      }
    }
    if (typeof tx.amount !== 'number' || !Number.isFinite(tx.amount) || tx.amount <= 0) {
      issues.push({ code: 'non_positive_amount', message: `Montant invalide sur « ${tx.title} »`, txId: tx.id });
    }
    if (txIds.has(tx.id)) {
      issues.push({ code: 'duplicate_tx_id', message: `Identifiant de transaction dupliqué: ${tx.id}` });
    }
    txIds.add(tx.id);
  }

  return issues;
}
