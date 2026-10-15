/** INPUT: confirmation content and cancellation state. OUTPUT: a native modal with contained focus.
 * POS: shared presentation for rule and manual actions; App owns execution. See ./AGENTS.md. */
import { useEffect, useRef, type ReactNode } from 'react';

interface Props {
  label: string;
  busy: boolean;
  onCancel: () => void;
  children: ReactNode;
}

export function ConfirmationDialog({ label, busy, onCancel, children }: Props) {
  const dialog = useRef<HTMLDialogElement>(null);
  const focusedCancel = useRef(false);
  useEffect(() => {
    const element = dialog.current!;
    focusedCancel.current = false;
    element.showModal();
    element.focus({ preventScroll: true });
    return () => { element.close(); };
  }, []);
  useEffect(() => {
    // Manual checks can briefly disable buttons; focus the safe action once it is available.
    if (busy || focusedCancel.current) return;
    const cancel = dialog.current?.querySelector<HTMLButtonElement>('[data-dialog-cancel]:not(:disabled)');
    if (cancel) { cancel.focus({ preventScroll: true }); focusedCancel.current = true; }
  }, [busy]);
  return <dialog ref={dialog} className="confirmation-dialog" aria-label={label} tabIndex={-1}
    onCancel={event => { event.preventDefault(); if (!busy) onCancel(); }}
    onKeyDown={event => {
      if (event.key !== 'Tab') return;
      const element = event.currentTarget;
      const controls = [...element.querySelectorAll<HTMLElement>('button, a[href], input, select, textarea, summary, [tabindex]')]
        .filter(control => control.tabIndex >= 0 && !control.matches(':disabled') && control.getClientRects().length > 0);
      const first = controls[0]; const last = controls.at(-1);
      // Native modality makes the page inert, but Tab can still reach browser chrome.
      if (!first || event.shiftKey && document.activeElement === first || !event.shiftKey && document.activeElement === last || document.activeElement === element) {
        event.preventDefault();
        (event.shiftKey ? last : first)?.focus({ preventScroll: true });
      }
    }}>
    {children}
  </dialog>;
}
