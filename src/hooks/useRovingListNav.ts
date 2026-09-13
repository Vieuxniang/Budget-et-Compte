import React, { useRef, useState } from 'react';

// ---------------------------------------------------------------------------
// Arrow-key navigation for real lists ("roving tabindex")
// ---------------------------------------------------------------------------
//
// The pattern used across the app: every row is a real focusable element, but
// only ONE of them carries the list's tab stop, so Tab enters the list once and
// leaves it once — arrow keys then walk the rows. Because focus really moves,
// screen readers announce each row as it is reached, which is what the chart
// frames in BudgetView cannot do.
//
// Rows keep their own buttons (mouse users lose nothing); Enter / Delete are
// shortcuts layered on top, and they defer to a nested control when one has
// focus so native button behavior is never hijacked.

export type RovingOrientation = 'vertical' | 'horizontal' | 'grid';

/** Keys the list consumes; everything else is left to the browser. */
const NAV_KEYS = ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End'] as const;

const wrap = (i: number, n: number) => ((i % n) + n) % n;

/**
 * Row the keyboard moves to, or null when the key moves nothing. Pure (no DOM)
 * so the navigation rules are unit-testable:
 * - vertical/horizontal lists wrap around the ends (Home/End jump to them);
 * - grid lists move a full visual row with ↑/↓, stay inside the current row
 *   with ←/→, and clamp instead of wrapping (Home/End reach the row's ends).
 */
export function rovingTarget(
  key: string,
  index: number,
  count: number,
  orientation: RovingOrientation = 'vertical',
  columns = 1
): number | null {
  if (count <= 0) return null;
  if (index < 0 || index > count - 1) return null;
  if (!(NAV_KEYS as readonly string[]).includes(key)) return null;

  if (orientation === 'grid') {
    const cols = Math.max(1, Math.floor(columns) || 1);
    const rowStart = index - (index % cols);
    const rowEnd = Math.min(count - 1, rowStart + cols - 1);
    const down = index + cols;
    const lastRowStart = (Math.ceil(count / cols) - 1) * cols;
    switch (key) {
      case 'ArrowRight':
        return Math.min(index + 1, rowEnd);
      case 'ArrowLeft':
        return Math.max(index - 1, rowStart);
      // Moving past the last row lands on the same column, not on a random cell.
      case 'ArrowDown':
        return down > count - 1
          ? lastRowStart + Math.min(index - rowStart, count - 1 - lastRowStart)
          : down;
      case 'ArrowUp':
        return index - cols < 0 ? Math.min(index - rowStart, count - 1) : index - cols;
      case 'Home':
        return rowStart;
      case 'End':
        return rowEnd;
    }
    return null;
  }

  const step = (delta: number) => wrap(index + delta, count);
  if (orientation === 'horizontal') {
    switch (key) {
      case 'ArrowRight':
        return step(1);
      case 'ArrowLeft':
        return step(-1);
      case 'Home':
        return 0;
      case 'End':
        return count - 1;
      default:
        return null;
    }
  }
  switch (key) {
    case 'ArrowDown':
    case 'ArrowRight':
      return step(1);
    case 'ArrowUp':
    case 'ArrowLeft':
      return step(-1);
    case 'Home':
      return 0;
    case 'End':
      return count - 1;
    default:
      return null;
  }
}

/**
 * Focus ring for a roving row: inset, because lists are rendered with
 * `overflow-hidden` (rounded panels) where an outset outline would be clipped.
 * The emerald token resolves per theme, so the indicator stays visible in both.
 * `focus:` (not `focus-visible:`) because the rows are focused programmatically
 * by the arrow keys and a browser may not treat that as keyboard input — the
 * indicator must never be the thing that goes missing.
 */
export const ROVING_ROW_FOCUS =
  'focus:outline-none focus:ring-2 focus:ring-inset focus:ring-emerald-400 focus:bg-emerald-500/10';

export interface RovingListOptions {
  /** Rows currently rendered (filtering can shrink the list). */
  count: number;
  /** Accessible name of the container. */
  label?: string;
  orientation?: RovingOrientation;
  /**
   * 'list' marks the container and its rows as a real list (the rows are divs,
   * so nothing is overridden). 'buttons' leaves the host semantics alone — for
   * a strip of buttons inside a <nav>, where role="listitem" would replace the
   * button role.
   */
  semantics?: 'list' | 'buttons';
  /** id of the visible hint that explains the keys (linked with aria-describedby). */
  hintId?: string;
  /** Arrow navigation also activates the row it lands on (tab bars, menus). */
  activateOnFollow?: boolean;
  /** Enter/Space on a row. */
  onActivate?: (index: number) => void;
  /** Delete/Backspace on a row. */
  onRemove?: (index: number) => void;
  /** Escape while a row has focus. */
  onEscape?: () => void;
}

export interface RovingItemProps {
  role?: 'listitem';
  tabIndex: number;
  onFocus: () => void;
  onKeyDown: React.KeyboardEventHandler<HTMLElement>;
  /** Rows are located by the parent through this attribute (order = DOM order). */
  'data-roving-item': string;
  'aria-label'?: string;
  'aria-keyshortcuts'?: string;
}

export interface RovingListNav<T extends HTMLElement = HTMLDivElement> {
  listProps: {
    ref: React.RefObject<T>;
    role?: 'list';
    'aria-label'?: string;
    'aria-describedby'?: string;
  };
  /** Index that currently owns the list's single tab stop. */
  activeIndex: number;
  /** Move the tab stop (used after a click / programmatic selection). */
  setActiveIndex: (index: number) => void;
  itemProps: (index: number, options?: { label?: string }) => RovingItemProps;
}

const NESTED_CONTROL = 'button, a[href], input, select, textarea, [role="button"]';

export function useRovingListNav<T extends HTMLElement = HTMLDivElement>(
  options: RovingListOptions
): RovingListNav<T> {
  const {
    count, label, orientation = 'vertical', semantics = 'list', hintId, activateOnFollow,
    onActivate, onRemove, onEscape,
  } = options;
  const listRef = useRef<T>(null);
  const [activeIndex, setActiveIndex] = useState(0);

  const rows = () =>
    Array.from(listRef.current?.querySelectorAll<HTMLElement>('[data-roving-item]') ?? []);

  const columns = () => {
    const node = listRef.current;
    if (!node || typeof window === 'undefined') return 1;
    const template = window.getComputedStyle(node).gridTemplateColumns;
    const tracks = template.split(/\s+/).filter(Boolean).length;
    return tracks > 0 ? tracks : 1;
  };

  const handleKeyDown = (index: number): React.KeyboardEventHandler<HTMLElement> => (e) => {
    const target = e.target as HTMLElement;
    const isAction = e.key === 'Enter' || e.key === ' ' || e.key === 'Delete' || e.key === 'Backspace';
    // A focused button/input inside the row keeps its native keys.
    const nested =
      target !== e.currentTarget && target.closest?.(NESTED_CONTROL) !== null;
    if (nested && isAction) return;

    if (e.key === 'Escape') {
      if (onEscape) {
        e.preventDefault();
        onEscape();
      }
      return;
    }
    if (isAction) {
      if (e.key === 'Delete' || e.key === 'Backspace') {
        if (onRemove) {
          e.preventDefault();
          onRemove(index);
        }
        return;
      }
      if (onActivate) {
        e.preventDefault();
        onActivate(index);
      }
      return;
    }

    const next = rovingTarget(e.key, index, count, orientation, columns());
    if (next === null || next === index) return;
    e.preventDefault();
    rows()[next]?.focus();
    if (activateOnFollow) onActivate?.(next);
  };

  const shortcuts = [onActivate ? 'Enter' : null, onRemove ? 'Delete' : null]
    .filter(Boolean)
    .join(' ');
  const tabStop = count > 0 ? Math.min(activeIndex, count - 1) : 0;

  return {
    listProps: {
      ref: listRef,
      ...(semantics === 'list' ? { role: 'list' as const } : {}),
      ...(label ? { 'aria-label': label } : {}),
      ...(hintId ? { 'aria-describedby': hintId } : {}),
    },
    activeIndex: tabStop,
    setActiveIndex,
    itemProps: (index, itemOptions) => ({
      ...(semantics === 'list' ? { role: 'listitem' as const } : {}),
      tabIndex: index === tabStop ? 0 : -1,
      'data-roving-item': '',
      ...(itemOptions?.label ? { 'aria-label': itemOptions.label } : {}),
      ...(shortcuts ? { 'aria-keyshortcuts': shortcuts } : {}),
      onFocus: () => setActiveIndex(index),
      onKeyDown: handleKeyDown(index),
    }),
  };
}
