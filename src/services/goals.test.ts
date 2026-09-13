import { describe, expect, it } from 'vitest';
import { SavingsGoal } from '../types';
import {
  draftToGoal, emptyGoalDraft, goalProgress, goalToDraft, validateGoalDraft,
} from './goals';

const goal = (overrides: Partial<SavingsGoal> = {}): SavingsGoal => ({
  id: 'g-1',
  name: 'Fonds de Sécurité',
  targetAmount: 1000000,
  currentAmount: 250000,
  deadline: '2026-12-31',
  category: 'emergency',
  ...overrides,
});

describe('validateGoalDraft', () => {
  it('accepts a complete draft', () => {
    expect(validateGoalDraft({
      name: 'Terrain', targetAmount: 500000, currentAmount: 0, deadline: '2027-06-30', category: 'house',
    })).toEqual([]);
  });

  it('requires a name and a positive target', () => {
    const errors = validateGoalDraft({ ...emptyGoalDraft(), name: '   ', targetAmount: 0 });
    expect(errors.map((e) => e.field)).toEqual(['name', 'targetAmount']);
  });

  it('refuses a negative amount already put aside', () => {
    const errors = validateGoalDraft({ ...emptyGoalDraft(), name: 'X', targetAmount: 100, currentAmount: -5 });
    expect(errors.map((e) => e.field)).toEqual(['currentAmount']);
  });

  it('treats the deadline as optional but checks its format', () => {
    const base = { ...emptyGoalDraft(), name: 'X', targetAmount: 100 };
    expect(validateGoalDraft({ ...base, deadline: '' })).toEqual([]);
    expect(validateGoalDraft({ ...base, deadline: '31/12/2027' }).map((e) => e.field)).toEqual(['deadline']);
  });
});

describe('draftToGoal / goalToDraft', () => {
  it('round-trips through the draft without losing anything', () => {
    const draft = goalToDraft(goal());
    expect(draft).toEqual({
      name: 'Fonds de Sécurité', targetAmount: 1000000, currentAmount: 250000,
      deadline: '2026-12-31', category: 'emergency',
    });
    expect(draftToGoal(draft, 'g-1')).toEqual(goal());
  });

  it('keeps the existing id when editing and mints one otherwise', () => {
    const draft = goalToDraft(goal());
    expect(draftToGoal(draft, 'g-9').id).toBe('g-9');
    const created = draftToGoal(draft);
    expect(created.id).not.toBe('g-1');
    expect(created.id.startsWith('g-')).toBe(true);
  });

  it('trims the name and stores absolute amounts', () => {
    const saved = draftToGoal({ ...goalToDraft(goal()), name: '  Terrain  ', currentAmount: -50 }, 'g-2');
    expect(saved.name).toBe('Terrain');
    expect(saved.currentAmount).toBe(50);
  });
});

describe('goalProgress', () => {
  it('derives the percentage and what is left to save', () => {
    expect(goalProgress(goal())).toEqual({ pct: 25, remaining: 750000, reached: false });
  });

  it('clamps an over-funded goal to 100 % and flags it as reached', () => {
    expect(goalProgress(goal({ targetAmount: 100, currentAmount: 250 })))
      .toEqual({ pct: 100, remaining: 0, reached: true });
  });

  it('handles an untouched goal and a zero target without dividing by zero', () => {
    expect(goalProgress(goal({ currentAmount: 0 }))).toEqual({ pct: 0, remaining: 1000000, reached: false });
    expect(goalProgress(goal({ targetAmount: 0, currentAmount: 0 })))
      .toEqual({ pct: 0, remaining: 0, reached: false });
    expect(goalProgress(goal({ targetAmount: 0, currentAmount: 10 })))
      .toEqual({ pct: 100, remaining: 0, reached: true });
  });
});
