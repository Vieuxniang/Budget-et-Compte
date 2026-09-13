/**
 * Country content packs — payroll rules, school fees and budget templates.
 *
 * A pack is **data, not code**: it ships with the app but does nothing until the
 * user installs it, and what an install *creates* is ordinary app data (budget
 * categories) — so packs need no storage of their own, and they inherit the
 * vault, the backup and the sync for free.
 *
 * Two honesty rules, both visible in the UI:
 *
 * 1. **The figures are indicative templates, not legal advice.** Rates and fees
 *    change with every finance law, so each pack carries the year it was
 *    transcribed (`asOf`) and the screen says so out loud. The point is to plan
 *    a household budget, not to issue a payslip.
 * 2. **Nothing is deleted behind the user's back.** Installing a template
 *    creates categories; the app never removes them on its own, and uninstalling
 *    a pack only forgets the pack.
 *
 * The whole module is pure (no React, no storage), so the maths is tested
 * directly — see packs.test.ts.
 */

import type { BudgetCategory, Transaction } from '../types';
import type { Plan } from './license';

// ---------------------------------------------------------------------------
// Shapes
// ---------------------------------------------------------------------------

/** One line of the payslip: a rate, sometimes capped at a monthly ceiling. */
export interface PayrollContribution {
  key: string;
  /** Share of the gross salary (0.056 = 5.6 %). */
  rate: number;
  /** Monthly ceiling the rate applies to, when the scheme has one. */
  ceiling?: number;
}

/** A progressive income-tax band. `upTo: null` is the top band. */
export interface PayrollBracket {
  /** Upper bound of the band, in the pack's currency, per month. */
  upTo: number | null;
  rate: number;
}

export interface PayrollRules {
  /** Year the figures were transcribed — shown next to the result. */
  asOf: string;
  /** Contributions withheld from the employee. */
  employee: PayrollContribution[];
  /** Progressive bands applied to the taxable base. */
  brackets: PayrollBracket[];
  /**
   * Share of the gross treated as professional expenses before tax (0.3 = 30 %).
   * Many francophone systems abate the base this way.
   */
  professionalAllowance?: number;
  /** Monthly tax relief per dependent, subtracted from the taxable base. */
  dependentRelief?: number;
}

/** One school level, in the pack's currency, per year and per child. */
export interface SchoolLevel {
  key: 'primary' | 'junior' | 'senior' | 'university';
  publicFee: number;
  privateFee: number;
  /** Books, uniforms, supplies — the part families forget to budget. */
  supplies: number;
}

/** One line of a budget template: a share of the monthly income. */
export interface TemplateLine {
  key: string;
  type: BudgetCategory['type'];
  /** Share of the monthly income (the template sums to 1). */
  share: number;
  color: string;
}

export interface CountryPack {
  id: string;
  /** ISO country code, e.g. 'SN'. */
  country: string;
  /** Proper noun — never translated. */
  name: string;
  currency: string;
  /** Bumped when the figures change; shown so a user can spot an old install. */
  version: number;
  asOf: string;
  payroll?: PayrollRules;
  schoolFees?: SchoolLevel[];
  /** Always present: every pack ships at least a budget template. */
  budget: TemplateLine[];
}

/** An installed pack, as stored in AppData (and therefore encrypted + synced). */
export interface InstalledPack {
  id: string;
  version: number;
  installedAt: string;
  /** Budget categories this pack created, so it can offer to remove them. */
  categoryIds?: string[];
}

// ---------------------------------------------------------------------------
// Catalog
// ---------------------------------------------------------------------------

const COLORS = {
  housing: '#3B82F6',
  food: '#10B981',
  transport: '#84CC16',
  school: '#F59E0B',
  health: '#EF4444',
  savings: '#14B8A6',
  tontine: '#8B5CF6',
  leisure: '#EC4899',
  phone: '#06B6D4',
};

/**
 * Indicative monthly bands. These are *templates* to plan a household budget:
 * the sales copy and the screen both say the figures must be checked against
 * the current finance law, and the catalog is the single place to update them.
 */
export const PACKS: CountryPack[] = [
  {
    id: 'sn-2025',
    country: 'SN',
    name: 'Sénégal',
    currency: 'XOF',
    version: 1,
    asOf: '2025',
    payroll: {
      asOf: '2025',
      employee: [
        { key: 'retirement', rate: 0.056, ceiling: 432_000 },
        { key: 'health', rate: 0.03 },
      ],
      brackets: [
        { upTo: 50_000, rate: 0 },
        { upTo: 116_667, rate: 0.2 },
        { upTo: 233_333, rate: 0.3 },
        { upTo: 466_667, rate: 0.35 },
        { upTo: 1_000_000, rate: 0.4 },
        { upTo: null, rate: 0.43 },
      ],
      professionalAllowance: 0.3,
      dependentRelief: 5_000,
    },
    schoolFees: [
      { key: 'primary', publicFee: 25_000, privateFee: 350_000, supplies: 45_000 },
      { key: 'junior', publicFee: 50_000, privateFee: 450_000, supplies: 60_000 },
      { key: 'senior', publicFee: 75_000, privateFee: 600_000, supplies: 80_000 },
      { key: 'university', publicFee: 25_000, privateFee: 1_500_000, supplies: 150_000 },
    ],
    budget: [
      { key: 'housing', type: 'needs', share: 0.3, color: COLORS.housing },
      { key: 'food', type: 'needs', share: 0.25, color: COLORS.food },
      { key: 'transport', type: 'needs', share: 0.1, color: COLORS.transport },
      { key: 'school', type: 'needs', share: 0.1, color: COLORS.school },
      { key: 'health', type: 'needs', share: 0.05, color: COLORS.health },
      { key: 'tontine', type: 'savings', share: 0.1, color: COLORS.tontine },
      { key: 'savings', type: 'savings', share: 0.05, color: COLORS.savings },
      { key: 'phone', type: 'wants', share: 0.05, color: COLORS.phone },
    ],
  },
  {
    id: 'ci-2025',
    country: 'CI',
    name: "Côte d'Ivoire",
    currency: 'XOF',
    version: 1,
    asOf: '2025',
    payroll: {
      asOf: '2025',
      employee: [
        { key: 'retirement', rate: 0.063, ceiling: 1_647_315 },
        { key: 'health', rate: 0.01 },
      ],
      brackets: [
        { upTo: 75_000, rate: 0 },
        { upTo: 240_000, rate: 0.16 },
        { upTo: 600_000, rate: 0.21 },
        { upTo: null, rate: 0.32 },
      ],
      professionalAllowance: 0.2,
      dependentRelief: 5_500,
    },
    schoolFees: [
      { key: 'primary', publicFee: 30_000, privateFee: 400_000, supplies: 50_000 },
      { key: 'junior', publicFee: 60_000, privateFee: 500_000, supplies: 65_000 },
      { key: 'senior', publicFee: 90_000, privateFee: 700_000, supplies: 85_000 },
      { key: 'university', publicFee: 30_000, privateFee: 1_600_000, supplies: 160_000 },
    ],
    budget: [
      { key: 'housing', type: 'needs', share: 0.32, color: COLORS.housing },
      { key: 'food', type: 'needs', share: 0.24, color: COLORS.food },
      { key: 'transport', type: 'needs', share: 0.12, color: COLORS.transport },
      { key: 'school', type: 'needs', share: 0.1, color: COLORS.school },
      { key: 'health', type: 'needs', share: 0.05, color: COLORS.health },
      { key: 'tontine', type: 'savings', share: 0.08, color: COLORS.tontine },
      { key: 'savings', type: 'savings', share: 0.05, color: COLORS.savings },
      { key: 'phone', type: 'wants', share: 0.04, color: COLORS.phone },
    ],
  },
  {
    id: 'cm-2025',
    country: 'CM',
    name: 'Cameroun',
    currency: 'XAF',
    version: 1,
    asOf: '2025',
    payroll: {
      asOf: '2025',
      employee: [{ key: 'retirement', rate: 0.042, ceiling: 750_000 }],
      brackets: [
        { upTo: 166_667, rate: 0.11 },
        { upTo: 250_000, rate: 0.165 },
        { upTo: 416_667, rate: 0.275 },
        { upTo: null, rate: 0.385 },
      ],
      professionalAllowance: 0.3,
      dependentRelief: 5_000,
    },
    schoolFees: [
      { key: 'primary', publicFee: 25_000, privateFee: 350_000, supplies: 50_000 },
      { key: 'junior', publicFee: 50_000, privateFee: 450_000, supplies: 65_000 },
      { key: 'senior', publicFee: 75_000, privateFee: 650_000, supplies: 85_000 },
      { key: 'university', publicFee: 50_000, privateFee: 1_200_000, supplies: 150_000 },
    ],
    budget: [
      { key: 'housing', type: 'needs', share: 0.3, color: COLORS.housing },
      { key: 'food', type: 'needs', share: 0.25, color: COLORS.food },
      { key: 'transport', type: 'needs', share: 0.12, color: COLORS.transport },
      { key: 'school', type: 'needs', share: 0.12, color: COLORS.school },
      { key: 'health', type: 'needs', share: 0.05, color: COLORS.health },
      { key: 'tontine', type: 'savings', share: 0.08, color: COLORS.tontine },
      { key: 'leisure', type: 'wants', share: 0.04, color: COLORS.leisure },
      { key: 'phone', type: 'wants', share: 0.04, color: COLORS.phone },
    ],
  },
  {
    id: 'bf-2025',
    country: 'BF',
    name: 'Burkina Faso',
    currency: 'XOF',
    version: 1,
    asOf: '2025',
    payroll: {
      asOf: '2025',
      employee: [{ key: 'retirement', rate: 0.055, ceiling: 600_000 }],
      brackets: [
        { upTo: 30_000, rate: 0 },
        { upTo: 50_000, rate: 0.121 },
        { upTo: 160_000, rate: 0.135 },
        { upTo: 300_000, rate: 0.235 },
        { upTo: null, rate: 0.28 },
      ],
      professionalAllowance: 0.25,
      dependentRelief: 5_000,
    },
    schoolFees: [
      { key: 'primary', publicFee: 12_000, privateFee: 250_000, supplies: 40_000 },
      { key: 'junior', publicFee: 25_000, privateFee: 350_000, supplies: 55_000 },
      { key: 'senior', publicFee: 40_000, privateFee: 500_000, supplies: 75_000 },
      { key: 'university', publicFee: 20_000, privateFee: 1_000_000, supplies: 120_000 },
    ],
    budget: [
      { key: 'housing', type: 'needs', share: 0.28, color: COLORS.housing },
      { key: 'food', type: 'needs', share: 0.28, color: COLORS.food },
      { key: 'transport', type: 'needs', share: 0.1, color: COLORS.transport },
      { key: 'school', type: 'needs', share: 0.12, color: COLORS.school },
      { key: 'health', type: 'needs', share: 0.05, color: COLORS.health },
      { key: 'tontine', type: 'savings', share: 0.1, color: COLORS.tontine },
      { key: 'savings', type: 'savings', share: 0.04, color: COLORS.savings },
      { key: 'phone', type: 'wants', share: 0.03, color: COLORS.phone },
    ],
  },
  {
    id: 'ml-2025',
    country: 'ML',
    name: 'Mali',
    currency: 'XOF',
    version: 1,
    asOf: '2025',
    payroll: {
      asOf: '2025',
      employee: [{ key: 'retirement', rate: 0.056, ceiling: 500_000 }],
      brackets: [
        { upTo: 33_333, rate: 0 },
        { upTo: 83_333, rate: 0.11 },
        { upTo: 166_667, rate: 0.18 },
        { upTo: 333_333, rate: 0.26 },
        { upTo: null, rate: 0.37 },
      ],
      professionalAllowance: 0.2,
      dependentRelief: 5_000,
    },
    schoolFees: [
      { key: 'primary', publicFee: 15_000, privateFee: 250_000, supplies: 40_000 },
      { key: 'junior', publicFee: 30_000, privateFee: 350_000, supplies: 55_000 },
      { key: 'senior', publicFee: 45_000, privateFee: 550_000, supplies: 75_000 },
      { key: 'university', publicFee: 25_000, privateFee: 1_200_000, supplies: 130_000 },
    ],
    budget: [
      { key: 'housing', type: 'needs', share: 0.28, color: COLORS.housing },
      { key: 'food', type: 'needs', share: 0.27, color: COLORS.food },
      { key: 'transport', type: 'needs', share: 0.12, color: COLORS.transport },
      { key: 'school', type: 'needs', share: 0.11, color: COLORS.school },
      { key: 'health', type: 'needs', share: 0.05, color: COLORS.health },
      { key: 'tontine', type: 'savings', share: 0.1, color: COLORS.tontine },
      { key: 'savings', type: 'savings', share: 0.04, color: COLORS.savings },
      { key: 'phone', type: 'wants', share: 0.03, color: COLORS.phone },
    ],
  },
];

export function findPack(id: string): CountryPack | null {
  return PACKS.find((pack) => pack.id === id) ?? null;
}

// ---------------------------------------------------------------------------
// Feature gate
// ---------------------------------------------------------------------------

/**
 * How many packs a plan may install. The free offer keeps **one** pack — the
 * one for your own country is the whole point of the module, so locking it
 * entirely would make the feature invisible; Pro/association lift the limit, so
 * a family that moved, or an NGO working in two countries, can keep both.
 * Installed packs are never hidden when a plan lapses.
 */
export function packLimit(plan: Plan): number {
  return plan === 'free' ? 1 : PACKS.length;
}

export function canInstall(plan: Plan, installedCount: number): boolean {
  return installedCount < packLimit(plan);
}

// ---------------------------------------------------------------------------
// Payroll estimate
// ---------------------------------------------------------------------------

export interface PayrollResult {
  gross: number;
  contributions: Array<{ key: string; amount: number }>;
  contributionTotal: number;
  /** Base the bands are applied to, after the professional allowance. */
  taxableBase: number;
  /** Tax before the dependent relief is taken off the base. */
  tax: number;
  relief: number;
  net: number;
}

/**
 * Monthly net-pay estimate. Deliberately simple and explicit: contributions are
 * withheld from the gross (each capped when the scheme has a ceiling), the
 * professional allowance abates the base, dependents reduce it, and the bands
 * apply progressively. Nothing is hidden in a constant.
 */
export function computePayroll(gross: number, rules: PayrollRules, dependents = 0): PayrollResult {
  const safeGross = Math.max(0, Math.round(gross));
  const contributions = rules.employee.map((contribution) => ({
    key: contribution.key,
    amount: Math.round(
      Math.min(safeGross, contribution.ceiling ?? Number.POSITIVE_INFINITY) * contribution.rate
    ),
  }));
  const contributionTotal = contributions.reduce((total, line) => total + line.amount, 0);

  const allowance = rules.professionalAllowance ?? 0;
  const relief = Math.max(0, Math.round(dependents)) * (rules.dependentRelief ?? 0);
  const taxableBase = Math.max(0, Math.round(safeGross * (1 - allowance)) - relief);

  let tax = 0;
  let lower = 0;
  for (const bracket of rules.brackets) {
    if (taxableBase <= lower) break;
    const upper = bracket.upTo ?? Number.POSITIVE_INFINITY;
    const slice = Math.min(taxableBase, upper) - lower;
    if (slice > 0) tax += slice * bracket.rate;
    lower = upper;
  }
  tax = Math.round(tax);

  return {
    gross: safeGross,
    contributions,
    contributionTotal,
    taxableBase,
    tax,
    relief,
    net: Math.max(0, safeGross - contributionTotal - tax),
  };
}

/** Effective rate of everything withheld, as a share of the gross. */
export function withholdingRate(result: PayrollResult): number {
  if (result.gross <= 0) return 0;
  return (result.contributionTotal + result.tax) / result.gross;
}

// ---------------------------------------------------------------------------
// Budget templates
// ---------------------------------------------------------------------------

/** A template line turned into a concrete, allocatable category. */
export interface TemplateAllocation {
  key: string;
  type: BudgetCategory['type'];
  allocated: number;
  color: string;
}

/**
 * Expands a template against a monthly income. The rounding residue is given to
 * the first line, so the allocations always add up to exactly the income — a
 * budget that does not balance is the first thing a user notices.
 */
export function templateAllocations(pack: CountryPack, monthlyIncome: number): TemplateAllocation[] {
  const income = Math.max(0, Math.round(monthlyIncome));
  const allocations = pack.budget.map((line) => ({
    key: line.key,
    type: line.type,
    color: line.color,
    allocated: Math.round(income * line.share),
  }));
  const total = allocations.reduce((sum, line) => sum + line.allocated, 0);
  const residue = income - total;
  if (residue !== 0 && allocations.length > 0) allocations[0].allocated += residue;
  return allocations;
}

/** Deterministic id: installing twice can never create a duplicate category. */
export function packCategoryId(packId: string, key: string): string {
  return `pck-${packId}-${key}`;
}

/**
 * Average monthly income of the last complete months, used as the starting
 * value of the template's income field. Reading real transactions beats asking
 * the user to guess, and it stays 0 when the ledger holds no income yet.
 */
export function monthlyIncomeBaseline(
  transactions: Transaction[],
  today: string,
  months = 3
): number {
  const days = months * 31;
  const limit = new Date(`${today}T00:00:00Z`);
  limit.setUTCDate(limit.getUTCDate() - days);
  const floor = limit.toISOString().slice(0, 10);
  const total = transactions
    .filter((tx) => tx.type === 'income' && tx.date >= floor && tx.date <= today)
    .reduce((sum, tx) => sum + tx.amount, 0);
  return Math.round(total / months);
}

// ---------------------------------------------------------------------------
// Install bookkeeping (pure helpers over the AppData list)
// ---------------------------------------------------------------------------

export function installedPackIds(installed: InstalledPack[] | undefined): Set<string> {
  return new Set((installed ?? []).map((entry) => entry.id));
}

export function isInstalled(installed: InstalledPack[] | undefined, id: string): boolean {
  return installedPackIds(installed).has(id);
}

/** Installs (or re-installs after removal) without ever duplicating an entry. */
export function addInstalled(
  installed: InstalledPack[] | undefined,
  entry: InstalledPack
): InstalledPack[] {
  const list = installed ?? [];
  const exists = list.some((item) => item.id === entry.id);
  return exists ? list.map((item) => (item.id === entry.id ? entry : item)) : [...list, entry];
}

export function removeInstalled(
  installed: InstalledPack[] | undefined,
  id: string
): InstalledPack[] {
  return (installed ?? []).filter((item) => item.id !== id);
}

/**
 * The record of an installed pack — the only shape a caller has to know.
 * Installing a pack that is already there keeps its original date (history is
 * not rewritten) and refreshes the version and the categories it created.
 */
export function installedEntry(
  installed: InstalledPack[] | undefined,
  pack: CountryPack,
  categoryIds?: string[],
  today: string = new Date().toISOString().slice(0, 10)
): InstalledPack {
  const existing = (installed ?? []).find((item) => item.id === pack.id);
  return {
    id: pack.id,
    version: pack.version,
    installedAt: existing?.installedAt ?? today,
    ...(categoryIds && categoryIds.length > 0 ? { categoryIds } : {}),
  };
}
