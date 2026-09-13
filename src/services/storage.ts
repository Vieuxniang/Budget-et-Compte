import {
  Account, Transaction, BudgetCategory, SavingsGoal, SecurityConfig,
  TontineGroup, TontineMember, TontinePayment, TontineRound,
} from '../types';
import type { ConflictRecord } from './sync/types';
import type { InstalledPack } from './packs';
import { formatMoney } from './currency';

const STORAGE_KEY = 'patrifamille_fcfa_data_v2';
const LEGACY_STORAGE_KEY = 'patrifamille_fcfa_data_v1';
const SECURITY_KEY = 'patrifamille_sec_v1';

export interface AppData {
  accounts: Account[];
  transactions: Transaction[];    budgetCategories: BudgetCategory[];
  goals: SavingsGoal[];
  /**
   * Multi-device sync: versions that lost a conflict, kept so nothing vanishes
   * silently. Optional — absent on installs that never sync. It lives here (and
   * not in a side file) so it is encrypted with the rest and can be synced like
   * any other record.
   */
  syncConflicts?: ConflictRecord[];
  /**
   * Tontine / association module. Optional so installs that never open it keep
   * their payload unchanged; separate arrays (rather than nesting) so every
   * group, member, round and payment is one independently-synced record.
   */
  tontineGroups?: TontineGroup[];
  tontineMembers?: TontineMember[];
  tontineRounds?: TontineRound[];
  tontinePayments?: TontinePayment[];
  /**
   * Country content packs the user installed. Only the *installation* is data:
   * a pack's rules ship with the app, and what an install creates (budget
   * categories) lives in its own array. Optional, like the tontine module.
   */
  installedPacks?: InstalledPack[];
}

export const INITIAL_ACCOUNTS: Account[] = [
  { id: 'acc-1', name: 'Compte Courant Principal', type: 'checking', holder: 'Compte Familial', initialBalance: 1000000, currency: 'FCFA', institution: 'Banque Locale' },
  { id: 'acc-2', name: 'Épargne de Secours', type: 'savings', holder: 'Famille', initialBalance: 4000000, currency: 'FCFA', institution: "Banque D'Épargne" },
  { id: 'acc-3', name: 'Wave Famille', type: 'wave', holder: 'Famille', initialBalance: 125000, currency: 'FCFA', institution: 'Wave' },
  { id: 'acc-4', name: 'Orange Money Famille', type: 'orange_money', holder: 'Famille', initialBalance: 75000, currency: 'FCFA', institution: 'Orange' },
  { id: 'acc-5', name: 'MTN MoMo Tontine', type: 'mtn_momo', holder: 'Famille', initialBalance: 50000, currency: 'FCFA', institution: 'MTN' },
  { id: 'acc-6', name: 'Crédit Scolarité', type: 'loan', holder: 'Compte Familial', initialBalance: 1800000, currency: 'FCFA', institution: 'Banque Locale' },
];

export const INITIAL_BUDGET_CATEGORIES: BudgetCategory[] = [
  { id: 'cat-1', name: 'Logement & Loyer', type: 'needs', allocated: 350000, color: '#3B82F6' },
  { id: 'cat-2', name: 'Alimentation & Ration', type: 'needs', allocated: 400000, color: '#10B981' },
  { id: 'cat-3', name: 'Scolarité & Enfants', type: 'needs', allocated: 200000, color: '#F59E0B' },
  { id: 'cat-4', name: 'Transport & Carburant', type: 'needs', allocated: 150000, color: '#84CC16' },
  { id: 'cat-5', name: 'Loisirs & Sorties', type: 'wants', allocated: 150000, color: '#EC4899' },
  { id: 'cat-6', name: 'Épargne & Projets', type: 'savings', allocated: 300000, color: '#14B8A6' },
];

export const INITIAL_GOALS: SavingsGoal[] = [
  { id: 'g-1', name: 'Fonds de Sécurité', targetAmount: 6000000, currentAmount: 4200000, deadline: '2026-12-31', category: 'emergency' },
  { id: 'g-2', name: 'Achat Terrain / Projet', targetAmount: 15000000, currentAmount: 5500000, deadline: '2027-12-31', category: 'house' },
];

export const INITIAL_TRANSACTIONS: Transaction[] = [
  { id: 'tx-1', date: todayIso(), title: 'Ration Mensuelle Alimentation', amount: 250000, type: 'expense', category: 'Alimentation & Ration', accountId: 'acc-1', member: 'Famille' },
  { id: 'tx-2', date: todayIso(), title: 'Virement Salaire', amount: 1850000, type: 'income', category: 'Revenus', accountId: 'acc-1', member: 'Famille' },
  { id: 'tx-3', date: todayIso(), title: 'Épargne mensuelle vers réserve', amount: 150000, type: 'transfer', category: 'Épargne & Projets', accountId: 'acc-1', toAccountId: 'acc-3', member: 'Famille' },
  { id: 'tx-4', date: todayIso(), title: 'Remboursement mensuel crédit', amount: 125000, type: 'expense', category: 'Scolarité & Enfants', accountId: 'acc-1', member: 'Famille' },
  { id: 'tx-5', date: todayIso(), title: 'Recharge Orange Money depuis Wave', amount: 25000, type: 'transfer', category: 'Transferts Mobile Money', accountId: 'acc-3', toAccountId: 'acc-4', member: 'Famille' },
  { id: 'tx-6', date: todayIso(), title: 'Facture eau via Orange Money', amount: 15000, type: 'expense', category: 'Logement & Loyer', accountId: 'acc-4', member: 'Famille' },
];

/** v1 kept a stored `balance` per account; v2 derives everything from the ledger. */
function migrateLegacy(raw: string): AppData | null {
  try {
    const old = JSON.parse(raw) as Partial<AppData> & { accounts?: Array<Record<string, unknown>> };
    if (!old || !Array.isArray(old.accounts)) return null;

    const accounts: Account[] = old.accounts.map((acc) => {
      const { balance: _staleBalance, ...rest } = acc as unknown as Record<string, unknown>;
      return {
        initialBalance: 0,
        currency: 'FCFA',
        holder: 'Famille',
        institution: '',
        name: 'Compte',
        type: 'checking',
        ...(rest as object),
      } as Account;
    });

    return {
      accounts,
      transactions: Array.isArray(old.transactions) ? old.transactions : [],
      budgetCategories: Array.isArray(old.budgetCategories) ? old.budgetCategories : INITIAL_BUDGET_CATEGORIES,
      goals: Array.isArray(old.goals) ? old.goals : INITIAL_GOALS,
    };
  } catch {
    return null;
  }
}

export function initialData(): AppData {
  return {
    accounts: INITIAL_ACCOUNTS,
    transactions: INITIAL_TRANSACTIONS,
    budgetCategories: INITIAL_BUDGET_CATEGORIES,
    goals: INITIAL_GOALS,
  };
}

/**
 * Legacy plaintext loaders, used only by the vault migration (services/vault.ts).
 * Accepts the v2 key directly, or a v1 payload via the same v1→v2 field migration
 * as before. Returns null when nothing (or nothing valid) is stored.
 */
export function loadLegacyPlaintextData(): AppData | null {
  const v2 = localStorage.getItem(STORAGE_KEY);
  if (v2) {
    try {
      const parsed = JSON.parse(v2) as AppData;
      return {
        accounts: Array.isArray(parsed.accounts) ? parsed.accounts : [],
        transactions: Array.isArray(parsed.transactions) ? parsed.transactions : [],
        budgetCategories: Array.isArray(parsed.budgetCategories) ? parsed.budgetCategories : INITIAL_BUDGET_CATEGORIES,
        goals: Array.isArray(parsed.goals) ? parsed.goals : INITIAL_GOALS,
      };
    } catch {
      return null; // corrupt plaintext: nothing worth migrating
    }
  }

  const v1 = localStorage.getItem(LEGACY_STORAGE_KEY);
  if (v1) {
    return migrateLegacy(v1);
  }
  return null;
}

export function clearLegacyPlaintextData(): void {
  localStorage.removeItem(STORAGE_KEY);
  localStorage.removeItem(LEGACY_STORAGE_KEY);
}

export function getSecurityConfig(): SecurityConfig {
  const raw = localStorage.getItem(SECURITY_KEY);
  if (!raw) return { isPasswordSet: false, autoLockMinutes: 5 };
  const parsed = JSON.parse(raw) as SecurityConfig;
  return {
    isPasswordSet: Boolean(parsed.isPasswordSet),
    autoLockMinutes: typeof parsed.autoLockMinutes === 'number' ? parsed.autoLockMinutes : 5,
    ...(typeof parsed.currency === 'string' ? { currency: parsed.currency } : {}),
    ...(typeof parsed.passwordRecord === 'string' ? { passwordRecord: parsed.passwordRecord } : {}),
    ...(typeof parsed.passwordHash === 'string' ? { passwordHash: parsed.passwordHash } : {}),
  };
}

export function saveSecurityConfig(config: SecurityConfig): void {
  localStorage.setItem(SECURITY_KEY, JSON.stringify(config));
}

/**
 * @deprecated Use formatMoney(amount, currency) from services/currency.ts so
 * the displayed currency follows the Réglages preference.
 */
export function formatFCFA(amount: number): string {
  return formatMoney(amount, 'XOF');
}

function todayIso(): string {
  // Import-time helper only used for seed data; runtime code stays pure.
  return new Date().toISOString().slice(0, 10);
}
