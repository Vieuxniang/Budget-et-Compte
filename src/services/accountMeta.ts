import { AccountType } from '../types';
import { isLiability } from './ledger';
import { AA, ensureContrast } from './contrast';
import { ChartTheme, badgeSurface } from './themePalette';

export interface AccountTypeMeta {
  label: string;
  badgeClass: string;
  balanceClass: string;
  isLiability: boolean;
  isMobileMoney: boolean;
}

const BANK_BADGE = 'bg-slate-800 text-slate-300';
const WALLET_BADGE = 'bg-sky-500/10 text-sky-300 border border-sky-500/30';
const LOAN_BADGE = 'bg-red-500/10 text-red-400 border border-red-500/20';

/** Small builders so each type is a one-liner — no room for copy drift. */
const META = {
  bank: (label: string): AccountTypeMeta => ({
    label,
    badgeClass: BANK_BADGE,
    balanceClass: 'text-emerald-400',
    isLiability: false,
    isMobileMoney: false,
  }),
  wallet: (label: string): AccountTypeMeta => ({
    label,
    badgeClass: WALLET_BADGE,
    balanceClass: 'text-emerald-400',
    isLiability: false,
    isMobileMoney: true,
  }),
  loan: (): AccountTypeMeta => ({
    label: 'Crédit',
    badgeClass: LOAN_BADGE,
    balanceClass: 'text-red-400',
    isLiability: true,
    isMobileMoney: false,
  }),
};

export const ACCOUNT_TYPE_META: Record<AccountType, AccountTypeMeta> = {
  checking:      META.bank('Compte courant'),
  savings:       META.bank('Épargne'),
  investment:    META.bank('Investissement'),
  cash:          META.bank('Espèces'),
  wave:          META.wallet('Wave'),
  orange_money:  META.wallet('Orange Money'),
  mtn_momo:      META.wallet('MTN MoMo'),
  loan:          META.loan(),
};

/** Ordered list for pickers: banks first, then wallets, then credit. */
export const ACCOUNT_TYPE_ORDER: AccountType[] = [
  'checking', 'savings', 'investment', 'cash', 'wave', 'orange_money', 'mtn_momo', 'loan',
];

/** i18n key for an account type label: 'orange_money' → 'meta.orangeMoney'. */
export function accountTypeLabelKey(type: AccountType): string {
  return `meta.${type.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase())}`;
}

export function isLiabilityType(type: AccountType): boolean {
  // The money rule lives in the ledger; metadata only adds presentation.
  return isLiability(type);
}

export function isMobileMoneyType(type: AccountType): boolean {
  return ACCOUNT_TYPE_META[type].isMobileMoney;
}

/** Brand hue for wallet accents (Wave deep blue, Orange, MTN yellow). */
export const WALLET_BRAND_COLOR: Partial<Record<AccountType, string>> = {
  wave: '#1DC1F2',
  orange_money: '#FF7900',
  mtn_momo: '#FFCC00',
};

/**
 * Theme-aware wallet badge hue. These hues are as bright as the real logos —
 * #FFCC00 is 1.5:1 on a white panel — so the light theme darkens them just
 * enough to keep the badge label legible (4.5:1) while preserving the brand hue.
 * The dark theme uses the brand color untouched (all three clear 6:1 there).
 */
export function walletBrandColor(
  type: AccountType,
  theme: ChartTheme
): string | undefined {
  const brand = WALLET_BRAND_COLOR[type];
  // Measured against the badge's own tint, not the panel: the 10% sky tint is
  // enough to drop a color tuned for white below 4.5:1.
  return brand ? ensureContrast(brand, badgeSurface(theme), AA.text) : undefined;
}
