/** INPUT: current mail rows and local review controls. OUTPUT: derived search and selection state.
 * POS: renderer-only helpers; never change judgments or grant execution permission. See ./AGENTS.md. */
import type { MailRecord } from '../shared/contracts';
import { canExecute, canSelect, isFolderAction } from '../shared/contracts';

/** Search only the locally loaded subject and sender; this never queries the mailbox or Jev. */
export function matchesMailSearch(record: MailRecord, query: string): boolean {
  const term = query.trim().normalize('NFKC').toLowerCase();
  if (!term) return true;
  return [record.subject, record.sender, record.senderAddress]
    .some(value => value.normalize('NFKC').toLowerCase().includes(term));
}

export interface WorkspaceSelectionInput {
  records: readonly MailRecord[];
  visibleRecords: readonly MailRecord[];
  selectedIds: readonly string[];
  targetsChanged?: boolean;
}

/** Current report rows are authoritative; obsolete IDs and unknown locations cannot be selected. */
export function deriveWorkspaceSelection({ records, visibleRecords, selectedIds, targetsChanged = false }: WorkspaceSelectionInput) {
  const selected = new Set(selectedIds);
  const visible = new Set(visibleRecords.map(record => record.id));
  const selectedRecords = records.filter(record => selected.has(record.id) && canSelect(record));
  const visibleSelectable = records.filter(record => visible.has(record.id) && canSelect(record));
  const selectedVisibleCount = selectedRecords.filter(record => visible.has(record.id)).length;
  return {
    selectedRecords,
    ruleRecords: selectedRecords.filter(record => canExecute(record) && !(targetsChanged && isFolderAction(record.action))),
    visibleSelectable,
    selectedVisibleCount,
    hiddenSelectedCount: selectedRecords.length - selectedVisibleCount,
    allVisibleSelected: visibleSelectable.length > 0 && visibleSelectable.every(record => selected.has(record.id)),
    someVisibleSelected: visibleSelectable.some(record => selected.has(record.id)),
  };
}
