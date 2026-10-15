import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MailService } from '../src/core/service';
import { accountIdentity } from '../src/core/mailbox';
import { JevError, type Evaluate } from '../src/core/jev';
import { email, evaluator, now, settings } from './helpers';
import { fixture } from './fixture';

test('full workflow scans, moves only selected UID, and restores using new UID receipt', async () => {
  const f = await fixture();
  try {
    const report = await f.service.scan(true);
    assert.equal(report.status, 'complete'); assert.equal(report.records.length, 1);
    const id = report.records[0].id;
    const moved = await f.service.move([id]);
    assert.equal(moved.moved, 1); assert.equal(moved.report.records[0].destinationUid, 101);
    assert.equal(f.original.size, 0); assert.equal(f.quarantine.size, 1);
    const restored = await f.service.undo();
    assert.equal(restored.moved, 1); assert.equal(restored.report.records[0].status, 'restored');
    assert.equal(restored.report.records[0].uid, 142); assert.equal(f.quarantine.size, 0); assert.equal(f.original.size, 1);
    assert.equal(f.moveCalls, 2);
  } finally { await f.cleanup(); }
});
for (const action of ['flag', 'changeIdentity', 'changeValidity'] as const) {
  test('a changed server state prevents mutation: ' + action, async () => {
    const f = await fixture();
    try {
      const report = await f.service.scan(true); f[action]();
      const result = await f.service.move([report.records[0].id]);
      assert.equal(result.moved, 0); assert.equal(result.failed, 1); assert.equal(f.moveCalls, 0);
    } finally { await f.cleanup(); }
  });
}
test('missing move receipt without a stable message ID stays uncertain and cannot be retried blindly', async () => {
  const f = await fixture();
  try {
    f.original.set(42, email({ messageId: '' }));
    const report = await f.service.scan(true); f.omitReceipt();
    const id = report.records[0].id;
    assert.equal((await f.service.move([id])).uncertain, 1);
    await assert.rejects(f.service.move([id]), /不符合/); assert.equal(f.moveCalls, 1);
  } finally { await f.cleanup(); }
});
test('scan requires explicit data consent and selection cannot forge arbitrary message IDs', async () => {
  const f = await fixture();
  try {
    await assert.rejects(f.service.scan(false), /允许/);
    const report = await f.service.scan(true);
    await assert.rejects(f.service.move([report.id + ':9999']), /不符合/);
    assert.equal(f.moveCalls, 0);
  } finally { await f.cleanup(); }
});
test('an interrupted movement receipt is reconciled as uncertain after restart', async () => {
  const f = await fixture();
  try {
    const report = await f.service.scan(true);
    report.records[0].status = 'moving'; await f.store.saveReport(report);
    const loaded = [await f.store.loadReport()];
    assert.equal(loaded[0]!.records[0].status, 'uncertain');
    assert.equal(loaded[0]!.accountIdentity, accountIdentity(settings));
    assert.ok(!JSON.stringify(loaded).includes('Unsubscribe at'));
  } finally { await f.cleanup(); }
});
test('three consecutive API failures stop the batch and retain completed review records', async () => {
  let requests = 0;
  const f = await fixture(async () => { requests++; throw new JevError('Classification unavailable.'); });
  try {
    for (const uid of [43, 44, 45]) f.original.set(uid, email({ uid }));
    const report = await f.service.scan(true);
    assert.equal(report.status, 'failed');
    assert.equal(report.processed, 3);
    assert.equal(requests, 3);
    assert.equal(f.moveCalls, 0);
    assert.match(report.error!, /连续三次/);
    assert.ok(report.records.every((record) => record.category === 'review' && !record.eligible));
    const persisted = [await f.store.loadReport()];
    assert.equal(persisted[0]!.records.length, 3);
  } finally { await f.cleanup(); }
});

test('changing natural-language rule blocks stale results', async () => {
  const f = await fixture(); try {
    const report = await f.service.scan(true);
    await f.service.saveConfig({ settings: { ...settings, rules: settings.rules.map(r => ({ ...r, description: r.description + ' 新条件' })) } });
    await assert.rejects(f.service.move([report.records[0].id]), /重新分析/); assert.equal(f.moveCalls, 0);
  } finally { await f.cleanup(); }
});
test('undo receipts survive a later scan and process restart', async () => {
  const f = await fixture(); try {
    const first = await f.service.scan(true); await f.service.move([first.records[0].id]);
    await f.service.scan(true);
    const restarted = new MailService(f.store, () => {}, f.connect, () => evaluator(), () => now);
    assert.equal(await restarted.canUndo(), true); assert.equal((await restarted.undo()).moved, 1);
    assert.equal(await restarted.canUndo(), false); assert.equal(f.original.size, 1);
  } finally { await f.cleanup(); }
});
test('all-mail scope processes every message without the recent-mail limit', async () => {
  const f = await fixture(); try {
    await f.service.saveConfig({ settings: { ...settings, scanLimit: null } });
    for (let uid = 43; uid < 163; uid++) f.original.set(uid, email({ uid }));
    const report = await f.service.scan(true); assert.equal(report.total, 121); assert.equal(report.processed, 121);
    assert.equal(report.scanLimit, null); assert.equal(f.receiptFetches.length, 0);
  } finally { await f.cleanup(); }
});

test('recent-mail limit uses receipt time across folders and never downloads or evaluates excluded mail', async () => {
  let calls = 0;
  const f = await fixture(async request => { calls++; return evaluator()(request); });
  try {
    f.original.set(42, email({ uid: 42, date: '2026-10-01T10:00:00Z' }));
    // A higher UID is older: importing mail can break any UID-as-recency assumption.
    f.original.set(99, email({ uid: 99, date: '2026-01-01T10:00:00Z' }));
    f.archive.set(42, email({ uid: 42, mailbox: 'Archive', uidValidity: '777', date: '2026-10-02T10:00:00Z' }));
    f.archive.set(43, email({ uid: 43, mailbox: 'Archive', uidValidity: '777', date: '2026-08-01T10:00:00Z' }));
    await f.service.saveConfig({ settings: { ...settings, mailboxes: ['INBOX', 'Archive'], scanLimit: 2 } });
    const report = await f.service.scan(true);
    assert.equal(report.status, 'complete'); assert.equal(report.scanLimit, 2);
    assert.equal(report.total, 2); assert.equal(report.processed, 2); assert.equal(calls, 2);
    assert.deepEqual(report.records.map(r => [r.mailbox, r.uid]), [['INBOX', 42], ['Archive', 42]]);
    assert.equal(new Set(report.records.map(r => r.id)).size, 2);
    assert.deepEqual(f.downloads, [{ path: 'INBOX', uid: 42 }, { path: 'Archive', uid: 42 }]);
    assert.ok(f.locks.every(lock => lock.readOnly)); assert.equal(f.moveCalls, 0);
    for (const fetch of f.receiptFetches) {
      assert.deepEqual(fetch.query, { uid: true, internalDate: true }); assert.deepEqual(fetch.options, { uid: true });
    }
  } finally { await f.cleanup(); }
});
test('recent count greater than available mail analyzes all available mail', async () => {
  const f = await fixture(); try {
    await f.service.saveConfig({ settings: { ...settings, scanLimit: 500 } });
    const report = await f.service.scan(true);
    assert.equal(report.status, 'complete'); assert.equal(report.total, 1); assert.equal(report.apiCalls, 1);
  } finally { await f.cleanup(); }
});
test('recent selection with missing receipt time fails before any body download or model call', async () => {
  const f = await fixture(); try {
    f.original.set(43, email({ uid: 43, date: '' }));
    await f.service.saveConfig({ settings: { ...settings, scanLimit: 1 } });
    const report = await f.service.scan(true);
    assert.equal(report.status, 'failed'); assert.match(report.error!, /收件时间/);
    assert.equal(report.apiCalls, 0); assert.equal(f.downloads.length, 0); assert.equal(f.moveCalls, 0);
    await f.service.saveConfig({ settings: { ...settings, scanLimit: null } });
    const all = await f.service.scan(true);
    assert.equal(all.status, 'complete'); assert.equal(all.total, 2);
    assert.equal(all.records.find(r => r.uid === 43)?.eligible, false);
  } finally { await f.cleanup(); }
});
test('changing the scan limit invalidates cleanup while preserving existing undo receipts', async () => {
  const f = await fixture(); try {
    const report = await f.service.scan(true);
    await f.service.saveConfig({ settings: { ...settings, scanLimit: 1 } });
    await assert.rejects(f.service.move([report.records[0].id]), /分析范围/); assert.equal(f.moveCalls, 0);
    await f.service.saveConfig({ settings }); await f.service.move([report.records[0].id]);
    await f.service.saveConfig({ settings: { ...settings, scanLimit: null } });
    assert.equal((await f.service.undo()).moved, 1); assert.equal(f.original.size, 1);
  } finally { await f.cleanup(); }
});

test('stopping an in-flight model call releases the mailbox and blocks concurrent configuration changes', async () => {
  let entered!: () => void;
  const started = new Promise<void>(accept => { entered = accept; });
  const evaluate: Evaluate = async (_request, signal) => {
    entered(); return new Promise((_accept, reject) => { signal!.addEventListener('abort', () => reject(signal!.reason), { once: true }); });
  };
  const f = await fixture(evaluate); try {
    const scan = f.service.scan(true); await started;
    await assert.rejects(f.service.saveConfig({ settings }), /等待/);
    f.service.cancel(); const report = await scan;
    assert.equal(report.status, 'cancelled'); assert.equal(f.moveCalls, 0);
    await f.service.saveConfig({ settings });
  } finally { await f.cleanup(); }
});
test('a multi-message batch restores every selected UID without touching unselected messages', async () => {
  const f = await fixture(); try {
    f.original.set(43, email({ uid: 43, messageId: '<43@example.com>' }));
    f.original.set(44, email({ uid: 44, messageId: '<44@example.com>' }));
    const report = await f.service.scan(true);
    assert.equal((await f.service.move(report.records.slice(0, 2).map(r => r.id))).moved, 2);
    assert.equal(f.original.size, 1); assert.equal(f.quarantine.size, 2);
    assert.equal((await f.service.undo()).moved, 2); assert.equal(f.original.size, 3); assert.equal(f.quarantine.size, 0);
  } finally { await f.cleanup(); }
});

test('multi-folder scans distinguish equal UIDs and restore each message to its own source', async () => {
  const f = await fixture(); try {
    f.archive.set(42, email({ uid: 42, mailbox: 'Archive', uidValidity: '777', messageId: '<archive@example.com>', subject: 'Archived offer' }));
    await f.service.saveConfig({ settings: { ...settings, mailboxes: ['INBOX', 'Archive'] } });
    const report = await f.service.scan(true);
    assert.equal(report.total, 2); assert.equal(report.processed, 2);
    assert.deepEqual(report.mailboxes, ['INBOX', 'Archive']);
    assert.equal(new Set(report.records.map(r => r.id)).size, 2);
    assert.deepEqual(report.records.map(r => [r.mailbox, r.uid, r.uidValidity]), [['INBOX', 42, '999'], ['Archive', 42, '777']]);
    assert.ok(f.locks.every(lock => lock.readOnly));
    for (const record of report.records) assert.ok((await f.service.preview(record.id)).originalText);
    assert.equal((await f.service.move(report.records.map(r => r.id))).moved, 2);
    assert.equal(f.quarantine.size, 2); assert.equal(f.original.size + f.archive.size, 0);
    assert.equal((await f.service.undo()).moved, 2);
    assert.equal(f.original.size, 1); assert.equal(f.archive.size, 1); assert.equal(f.quarantine.size, 0);
    assert.equal([...f.archive.values()][0].subject, 'Archived offer');
  } finally { await f.cleanup(); }
});
test('changing selected folders blocks old cleanup without losing undo receipts', async () => {
  const f = await fixture(); try {
    const report = await f.service.scan(true);
    await f.service.saveConfig({ settings: { ...settings, mailboxes: ['Archive'] } });
    await assert.rejects(f.service.move([report.records[0].id]), /重新分析/);
    await f.service.saveConfig({ settings });
    await f.service.move([report.records[0].id]);
    // Undo uses recorded operation identity, independently of the current selected folders.
    const action = (await f.store.loadAction())!;
    await f.service.saveConfig({ settings: { ...settings, mailboxes: ['Archive'] } });
    assert.deepEqual(action.mailboxes, ['INBOX']);
    const restarted = new MailService(f.store, () => {}, f.connect, () => evaluator(), () => now);
    assert.equal((await restarted.undo()).moved, 1); assert.equal(f.original.size, 1);
  } finally { await f.cleanup(); }
});
