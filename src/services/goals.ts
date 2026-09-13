import { SavingsGoal } from '../types';
import { frTranslate, Translate } from '../i18n/translations';

// ---------------------------------------------------------------------------
// Savings goals — pure helpers shared by the UI and the tests
// ---------------------------------------------------------------------------

export const GOAL_CATEGORIES: SavingsGoal['category'][] = [
  'emergency', 'vacation', 'house', 'kids', 'project',
];

export interface GoalDraft {
  name: string;
  /** Amount to reach, positive. */
  targetAmount: number;
  /** Already put aside; starts at the goal's current value when editing. */
  currentAmount: number;
  /** ISO date 'YYYY-MM-DD', or '' when no deadline is set. */
  deadline: string;
  category: SavingsGoal['category'];
}

export interface GoalDraftError {
  field: keyof GoalDraft;
  message: string;
}

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export const emptyGoalDraft = (): GoalDraft => ({
  name: '',
  targetAmount: 0,
  currentAmount: 0,
  deadline: `${new Date().getFullYear() + 1}-12-31`,
  category: 'project',
});

export function goalToDraft(goal: SavingsGoal): GoalDraft {
  return {
    name: goal.name,
    targetAmount: goal.targetAmount,
    currentAmount: goal.currentAmount,
    deadline: goal.deadline,
    category: goal.category,
  };
}

/** Validates a draft. The deadline is optional but must be a real ISO date. */
export function validateGoalDraft(draft: GoalDraft, t: Translate = frTranslate): GoalDraftError[] {
  const errors: GoalDraftError[] = [];
  if (!draft.name.trim()) {
    errors.push({ field: 'name', message: t('errors.goalNameRequired') });
  }
  if (!Number.isFinite(draft.targetAmount) || draft.targetAmount <= 0) {
    errors.push({ field: 'targetAmount', message: t('errors.goalTargetPositive') });
  }
  if (!Number.isFinite(draft.currentAmount) || draft.currentAmount < 0) {
    errors.push({ field: 'currentAmount', message: t('errors.goalCurrentNegative') });
  }
  if (draft.deadline && !ISO_DATE_RE.test(draft.deadline)) {
    errors.push({ field: 'deadline', message: t('errors.dateInvalid') });
  }
  return errors;
}

export function draftToGoal(draft: GoalDraft, existingId?: string): SavingsGoal {
  return {
    id: existingId ?? generateGoalId(),
    name: draft.name.trim(),
    targetAmount: Math.abs(draft.targetAmount),
    currentAmount: Math.abs(draft.currentAmount),
    deadline: draft.deadline,
    category: draft.category,
  };
}

export interface GoalProgress {
  /** 0–100, clamped: an over-funded goal shows 100 %, never more. */
  pct: number;
  /** Amount still missing (0 once reached). */
  remaining: number;
  reached: boolean;
}

/** Progress is always derived from the stored amounts, never stored itself. */
export function goalProgress(goal: SavingsGoal): GoalProgress {
  const target = Math.abs(goal.targetAmount);
  const saved = Math.abs(goal.currentAmount);
  if (target <= 0) return { pct: saved > 0 ? 100 : 0, remaining: 0, reached: saved > 0 };
  const ratio = saved / target;
  return {
    pct: Math.min(100, Math.max(0, Math.round(ratio * 100))),
    remaining: Math.max(0, target - saved),
    reached: saved >= target,
  };
}

let idCounter = 0;
export function generateGoalId(): string {
  idCounter += 1;
  return `g-${Date.now().toString(36)}-${idCounter.toString(36)}`;
}
