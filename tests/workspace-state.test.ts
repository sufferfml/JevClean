import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { MailRecord } from '../src/shared/contracts';
import { deriveWorkspaceSelection, matchesMailSearch } from '../src/renderer/workspace-state';

function row(id: string, patch: Partial<MailRecord> = {}): MailRecord {
  return { id, uid: 1, uidValidity: '100', mailbox: 'INBOX', messageId: '<' + id + '>', fingerprint: id,
    subject: 'Quarterly receipt', sender: 'Design Studio', senderAddress: 'billing@example.com', date: '2026-10-01T10:00:00Z',
    flags: [], hasAttachment: false, isReply: false, textTruncated: false, status: 'pending', category: 'clean', eligible: true,
    action: 'delete', confidence: .99, probability: .99, matchedRules: [], verdicts: [], reason: 'Synthetic rule match', ...patch };
}

test('cross-filter selection keeps hidden mail visible to confirmation but excludes missing and unknown identities', () => {
  const records = [row('shown'), row('hidden', { category: 'keep', eligible: false }), row('unknown', { status: 'uncertain' })];
  const before = structuredClone(records);
  const selection = deriveWorkspaceSelection({ records, visibleRecords: [records[0], records[2]], selectedIds: ['shown', 'shown', 'hidden', 'unknown', 'old-report-id'] });
  assert.deepEqual(selection.selectedRecords.map(record => record.id), ['shown', 'hidden']);
  assert.equal(selection.selectedVisibleCount, 1);
  assert.equal(selection.hiddenSelectedCount, 1);
  assert.deepEqual(selection.visibleSelectable.map(record => record.id), ['shown']);
  assert.equal(selection.allVisibleSelected, true);
  assert.deepEqual(records, before);
});

test('manual selection survives AI review and changed destinations while rule execution keeps its independent gates', () => {
  const records = [row('folder'), row('flag', { action: 'read' }), row('review', { category: 'review', eligible: false }),
    row('blocked', { execution: { state: 'blocked', code: 'missing_destination' } }), row('noop', { execution: { state: 'noop' } }), row('done', { status: 'moved' })];
  const selection = deriveWorkspaceSelection({ records, visibleRecords: records, selectedIds: records.map(record => record.id), targetsChanged: true });
  assert.deepEqual(selection.selectedRecords, records);
  assert.deepEqual(selection.ruleRecords.map(record => record.id), ['flag']);
  assert.equal(selection.hiddenSelectedCount, 0);
  assert.equal(deriveWorkspaceSelection({ records, visibleRecords: [], selectedIds: ['folder'] }).allVisibleSelected, false);
  assert.equal(deriveWorkspaceSelection({ records, visibleRecords: [records[0], records[1]], selectedIds: ['folder'] }).allVisibleSelected, false);
});

test('local search finds subject and sender without matching model explanations or pretending to search folder contents', () => {
  const record = row('search', { subject: 'ＦＹＩ：季度账单', sender: 'Morrow Studio', mailbox: 'Private Archive', reason: 'sensitive-model-output' });
  const before = structuredClone(record);
  assert.equal(matchesMailSearch(record, '  fyi '), true);
  assert.equal(matchesMailSearch(record, '季度账单'), true);
  assert.equal(matchesMailSearch(record, 'MORROW'), true);
  assert.equal(matchesMailSearch(record, 'BILLING@EXAMPLE'), true);
  assert.equal(matchesMailSearch(record, 'Private Archive'), false);
  assert.equal(matchesMailSearch(record, 'sensitive-model-output'), false);
  assert.equal(matchesMailSearch(record, '   '), true);
  assert.deepEqual(record, before);
});
