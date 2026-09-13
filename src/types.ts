export type AccountType =
  | 'checking'
  | 'savings'
  | 'investment'
  | 'loan'
  | 'cash'
  /** Wave — portefeuille mobile (Sénégal et zone UEMOA). */
  | 'wave'
  /** Orange Money — portefeuille mobile. */
  | 'orange_money'
  /** MTN Mobile Money — portefeuille mobile. */
  | 'mtn_momo';

export interface Account {
  id: string;
  name: string;
  type: AccountType;
  holder: string;
  /** Opening balance; current balance is always derived from transactions (see ledger.ts). */
  initialBalance: number;
  currency: string;
  institution: string;
}

export type TransactionType = 'expense' | 'income' | 'transfer';

export interface Transaction {
  id: string;
  date: string; // ISO date 'YYYY-MM-DD'
  title: string;
  /** Always positive; direction comes from `type` (and toAccountId for transfers). */
  amount: number;
  type: TransactionType;
  category: string;
  accountId: string;
  /** Required for transfers: the account receiving the money. */
  toAccountId?: string;
  member: string;
}

export interface BudgetCategory {
  id: string;
  name: string;
  type: 'needs' | 'wants' | 'savings';
  allocated: number;
  color: string;
}

export interface SavingsGoal {
  id: string;
  name: string;
  targetAmount: number;
  currentAmount: number;
  deadline: string;
  category: 'emergency' | 'vacation' | 'house' | 'kids' | 'project';
}

// ---------------------------------------------------------------------------
// Tontine / association (paid module for groups)
// ---------------------------------------------------------------------------

/** How often a tontine collects. */
export type TontineFrequency = 'weekly' | 'biweekly' | 'monthly';

/**
 * A rotating savings group. Members each hold `shares` (a member can hold more
 * than one part), everyone pays `contribution × shares` every round, and each
 * round one member receives the whole pot — the rotation order is the plan.
 */
export interface TontineGroup {
  id: string;
  name: string;
  /** Amount of one share per round, in the group's currency. */
  contribution: number;
  currency: string;
  frequency: TontineFrequency;
  /** ISO date of the first round. */
  startDate: string;
  /** Free-form note (rules, penalties, meeting place…). */
  note?: string;
}

export interface TontineMember {
  id: string;
  groupId: string;
  name: string;
  phone?: string;
  /** Number of parts held; a member with 2 shares pays (and may receive) double. */
  shares: number;
  /** Order in the payout rotation, 1-based. Kept explicit so a group can agree
   * on an order that is not alphabetical. */
  position: number;
  active: boolean;
}

/** One collection round: who receives the pot, and when it is due. */
export interface TontineRound {
  id: string;
  groupId: string;
  /** 1-based round number. */
  index: number;
  beneficiaryId: string;
  dueDate: string;
  /** Set when the pot was handed over; the money side is the payments. */
  paidOutAt?: string;
}

export type TontinePaymentMethod = 'cash' | 'wave' | 'orange_money' | 'mtn_momo' | 'bank' | 'other';

/** One member's payment for one round. */
export interface TontinePayment {
  id: string;
  groupId: string;
  roundId: string;
  memberId: string;
  amount: number;
  paidAt: string;
  method: TontinePaymentMethod;
  note?: string;
}

/**
 * A receipt is *derived* from a payment, never stored: two sources of truth for
 * the same money is how a group ends up arguing. The number is stable because it
 * is computed from the group, the round and the member (see services/tontine.ts).
 */
export interface TontineReceipt {
  number: string;
  groupName: string;
  memberName: string;
  roundIndex: number;
  shares: number;
  amount: number;
  paidAt: string;
  method: TontinePaymentMethod;
  /** True when the payment covers the full expected amount for the round. */
  complete: boolean;
  remaining: number;
}

export interface SecurityConfig {
  isPasswordSet: boolean;
  /** Modern record: `pbkdf2$<iterations>$<saltHex>$<hashHex>` (see services/crypto.ts). */
  passwordRecord?: string;
  /** Legacy unsalted SHA-256 hex digest; migrated to `passwordRecord` on next unlock. */
  passwordHash?: string;
  /** Idle minutes after which the session locks itself; 0 disables. */
  autoLockMinutes: number;
  /** ISO 4217 code chosen in Réglages; detected from the browser region when unset. */
  currency?: string;
}
