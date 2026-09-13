import { RefObject, useEffect } from 'react';

/**
 * Dialog keyboard behavior without a dependency:
 * - Escape closes the dialog.
 * - Tab / Shift+Tab cycle focus inside the dialog (focus trap).
 * - On unmount, focus returns to the element that had it before opening.
 * Pair with role="dialog" aria-modal="true" and an aria-labelledby heading.
 */
export function useModalA11y(
  containerRef: RefObject<HTMLElement>,
  onClose: () => void
): void {
  useEffect(() => {
    const node = containerRef.current;
    if (!node) return;
    const previouslyFocused =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;

    const FOCUSABLE =
      'a[href], button:not([disabled]), textarea, input, select, [tabindex]:not([tabindex="-1"])';

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
        return;
      }
      if (e.key !== 'Tab') return;
      const focusables = Array.from(node.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
        (el) => el.offsetParent !== null || el === document.activeElement
      );
      if (focusables.length === 0) return;
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      const active = document.activeElement;
      if (e.shiftKey && (active === first || !(active instanceof Node) || !node.contains(active))) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      }
    };

    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      previouslyFocused?.focus();
    };
  }, [containerRef, onClose]);
}
