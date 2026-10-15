import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MailService } from '../src/core/service';
import { email, evaluator, now, settings } from './helpers';
import { fixture } from './fixture';

async function legacyUncertain(f: Awaited<ReturnType<typeof fixture>>) {
  const scan = await f.service.scan(true); await f.service.move([scan.records[0].id]);
  const action = (await f.store.loadAction())!;
  for (const record of action.records) {
    record.status = 'uncertain'; record.error = 'legacy missing receipt';
    delete record.destinationUid; delete record.destinationUidValidity; delete record.destinationPath; delete record.lastOperation;
  }
  await f.store.saveAction(action); await f.store.saveReport(action);
  return new MailService(f.store, () => {}, f.connect, () => { throw new Error('Verification must not use Jev'); }, () => now);
}

test('a missing MOVE receipt is confirmed by read-only identities and the new UID also supports undo', async () => {
  const f = await fixture(); try {
    const scan = await f.service.scan(true); f.omitReceipt();
    const moved = await f.service.move([scan.records[0].id]);
    assert.equal(moved.moved, 1); assert.equal(moved.uncertain, 0); assert.equal(moved.canUndo, true);
    assert.equal(moved.report.records[0].destinationUid, 101);
    assert.equal(f.moveCalls, 1); assert.equal(f.downloads.length, 1);
    const restored = await f.service.undo();
    assert.equal(restored.moved, 1); assert.equal(restored.report.records[0].uid, 142);
    assert.equal(restored.cleanup!.restored, 1); assert.equal(restored.canUndo, false);
    assert.equal(f.moveCalls, 2); assert.equal(f.downloads.length, 1);
  } finally { await f.cleanup(); }
});
test('refresh confirms legacy uncertainty after restart, without new moves, bodies, or model calls', async () => {
  const f = await fixture(); try {
    const restarted = await legacyUncertain(f); const before = f.locks.length;
    const value = await restarted.refreshCleanup();
    assert.equal(value.moved, 1); assert.equal(value.uncertain, 0); assert.equal(value.canUndo, true);
    assert.equal(value.cleanup!.checkedAt, now.toISOString());
    assert.ok(f.locks.slice(before).every(lock => lock.readOnly));
    assert.ok(f.receiptFetches.filter(fetch => 'envelope' in fetch.query).every(fetch => !('source' in fetch.query) && !('bodyParts' in fetch.query)));
    assert.equal(f.moveCalls, 1); assert.equal(f.downloads.length, 1);
    const again = new MailService(f.store, () => {}, f.connect, () => evaluator(), () => now);
    assert.equal((await again.cleanupSummary())!.moved, 1); assert.equal(await again.canUndo(), true);
    assert.equal((await again.undo()).moved, 1);
  } finally { await f.cleanup(); }
});
test('verification uses complete batched metadata even when header searches return false negatives', async () => {
  const f = await fixture(); try {
    const restarted = await legacyUncertain(f); const search = f.client.search;
    f.client.search = async (query?: object) => query && 'all' in query ? search() : [];
    for (let uid = 200; uid < 351; uid++) f.original.set(uid, email({ uid, messageId: '<unrelated-' + uid + '@example.com>' }));
    f.receiptFetches.length = 0;
    const value = await restarted.refreshCleanup();
    assert.equal(value.moved, 1); assert.equal(value.uncertain, 0); assert.equal(f.moveCalls, 1); assert.equal(f.downloads.length, 1);
    assert.deepEqual(f.receiptFetches.map(fetch => fetch.uids.length), [100, 51, 1]);
  } finally { await f.cleanup(); }
});
test('a candidate disappearing during metadata FETCH cannot be treated as proof of absence', async () => {
  const f = await fixture(); try {
    const restarted = await legacyUncertain(f);
    f.client.fetchAll = async () => [];
    await assert.rejects(restarted.refreshCleanup(), /位置发生变化/);
    assert.equal((await restarted.cleanupSummary())!.uncertain, 1); assert.equal(await restarted.canUndo(), false);
    assert.equal(f.moveCalls, 1);
  } finally { await f.cleanup(); }
});
test('failed automatic verification leaves a saved uncertain intent, without retrying a sent MOVE', async () => {
  const f = await fixture(); try {
    const scan = await f.service.scan(true); f.omitReceipt();
    f.client.search = async () => { throw new Error('metadata lookup failed'); };
    await assert.rejects(f.service.move([scan.records[0].id]), /自动核对未完成/);
    assert.equal((await f.store.loadAction())!.records[0].status, 'uncertain');
    assert.equal(f.moveCalls, 1); assert.equal(await f.service.canUndo(), false);
    await assert.rejects(f.service.move([scan.records[0].id]), /不符合/);
  } finally { await f.cleanup(); }
});
for (const location of ['both', 'duplicates', 'neither', 'changed-validity'] as const) {
  test('refresh never confirms an ambiguous or changed location: ' + location, async () => {
    const f = await fixture(); try {
      const restarted = await legacyUncertain(f); const original = [...f.quarantine.values()][0];
      if (location === 'both') f.original.set(42, { ...original, uid: 42 });
      if (location === 'duplicates') f.quarantine.set(102, { ...original, uid: 102 });
      if (location === 'neither') f.quarantine.clear();
      if (location === 'changed-validity') f.changeValidity();
      const result = await restarted.refreshCleanup();
      assert.equal(result.moved, 0); assert.equal(result.uncertain, 1); assert.equal(result.canUndo, false);
      assert.equal(f.moveCalls, 1); assert.equal(f.downloads.length, 1);
      await assert.rejects(restarted.move([result.report.records[0].id]), /不符合/);
    } finally { await f.cleanup(); }
  });
}
test('a verified source-only message is shown as not cleaned, without retrying MOVE', async () => {
  const f = await fixture(); try {
    const restarted = await legacyUncertain(f); const message = [...f.quarantine.values()][0];
    f.quarantine.clear(); f.original.set(42, { ...message, uid: 42 });
    const result = await restarted.refreshCleanup();
    assert.equal(result.failed, 1); assert.equal(result.uncertain, 0); assert.equal(result.canUndo, false);
    assert.equal(result.report.records[0].status, 'failed'); assert.equal(f.moveCalls, 1);
  } finally { await f.cleanup(); }
});
test('rules and later scans do not erase the independently verified latest cleanup batch', async () => {
  const f = await fixture(); try {
    const restarted = await legacyUncertain(f);
    await restarted.saveConfig({ settings: { ...settings, scanLimit: 1 } });
    const later = new MailService(f.store, () => {}, f.connect, () => evaluator(), () => now);
    const scan = await later.scan(true); assert.equal(scan.records.length, 0);
    const value = await later.refreshCleanup();
    assert.equal(value.report.id, scan.id); assert.equal(value.report.records.length, 0);
    assert.equal(value.cleanup!.moved, 1); assert.equal(value.canUndo, true);
    assert.equal((await f.store.loadReport())!.id, scan.id);
    assert.equal((await later.undo()).moved, 1);
  } finally { await f.cleanup(); }
});
test('latest-batch issue details exclude earlier failures and survive a different current report and restart', async () => {
  const f = await fixture(); try {
    f.original.set(43, email({ uid: 43, messageId: '<latest@example.com>', subject: 'Latest batch message' }));
    f.original.set(44, email({ uid: 44, messageId: '<completed@example.com>', subject: 'Earlier completed message' }));
    const scan = await f.service.scan(true);
    const earlier = scan.records.find(record => record.uid === 42)!;
    const latest = scan.records.find(record => record.uid === 43)!;
    const completed = scan.records.find(record => record.uid === 44)!;
    f.original.get(42)!.flags.push('\\Flagged');
    const first = await f.service.move([earlier.id, completed.id]);
    assert.equal(first.failed, 1);
    assert.deepEqual(first.cleanup!.issues!.map(issue => issue.id), [earlier.id]);

    f.omitReceipt();
    const search = f.client.search;
    f.client.search = async () => { throw new Error('Synthetic interrupted lookup'); };
    await assert.rejects(f.service.move([latest.id]), /自动核对未完成/);
    f.client.search = search;
    const current = (await f.service.loadReport())!;
    assert.deepEqual(new Set(current.records.filter(record => ['failed', 'uncertain'].includes(record.status)).map(record => record.id)), new Set([earlier.id, latest.id]));
    const summary = (await f.service.cleanupSummary())!;
    assert.equal(summary.uncertain, 1);
    assert.deepEqual(summary.issues, [{ id: latest.id, subject: latest.subject, status: 'uncertain', reason: '移动结果尚未确认，可点击“核对操作结果”查询。请勿重复执行。' }]);

    const reloaded = await f.service.readMail();
    assert.notEqual(reloaded.id, scan.id);
    assert.ok(!reloaded.records.some(record => record.messageId === latest.messageId));
    const restarted = new MailService(f.store, () => {}, f.connect, () => { throw new Error('No Jev'); }, () => now);
    assert.deepEqual((await restarted.cleanupSummary())!.issues, summary.issues);
    const checked = await restarted.refreshCleanup();
    assert.equal(checked.moved, 1);
    assert.deepEqual(checked.cleanup!.issues, []);
    assert.equal(f.moveCalls, 2);
  } finally { await f.cleanup(); }
});
test('legacy issue summaries use execution state when no error was saved, never the AI classification reason', async () => {
  const f = await fixture(); try {
    const scan = await f.service.scan(true);
    const action = structuredClone(scan);
    action.records[0].status = 'failed';
    action.records[0].reason = 'Synthetic AI classification: delete';
    delete action.records[0].error;
    await f.store.saveAction(action);
    const restarted = new MailService(f.store, () => {}, f.connect, () => { throw new Error('No Jev'); }, () => now);
    assert.deepEqual((await restarted.cleanupSummary())!.issues, [{ id: action.records[0].id, subject: action.records[0].subject, status: 'failed', reason: '操作未完成。' }]);
    assert.equal(f.moveCalls, 0);
  } finally { await f.cleanup(); }
});
test('refresh rejects a different account before opening a mailbox connection', async () => {
  const f = await fixture(); try {
    const restarted = await legacyUncertain(f);
    await restarted.saveConfig({ settings: { ...settings, email: 'other@example.com' }, imapPassword: 'other-test' });
    const locks = f.locks.length;
    await assert.rejects(restarted.refreshCleanup(), /切回/);
    assert.equal(f.locks.length, locks); assert.equal(f.moveCalls, 1);
  } finally { await f.cleanup(); }
});
test('cleanup publishes per-message progress and finishes even when the mailbox connection fails', async () => {
  const f = await fixture(); try {
    const events: import('../src/shared/contracts').Progress[] = [];
    const service = new MailService(f.store, value => events.push(structuredClone(value)), f.connect, () => evaluator(), () => now);
    f.original.set(43, email({ uid: 43, messageId: '<second@example.com>' }));
    const scan = await service.scan(true); events.length = 0;
    await service.move(scan.records.map(r => r.id));
    assert.ok(events.some(e => e.phase === 'moving' && e.processed === 1 && e.total === 2));
    assert.equal(events.at(-1)!.phase, 'complete'); assert.equal(events.at(-1)!.cleanup!.moved, 2);
    const failed = new MailService(f.store, value => events.push(value), async () => { throw new Error('connection'); });
    await assert.rejects(failed.refreshCleanup());
    assert.equal(events.at(-1)!.phase, 'complete'); assert.equal(f.moveCalls, 2);
  } finally { await f.cleanup(); }
});

test('automatic verification of nine selected messages reports 1497 folder entries separately without extra mutations or model calls', async () => {
  let calls = 0;
  const evaluate = evaluator();
  const counted: typeof evaluate = request => { calls++; return evaluate(request); };
  const f = await fixture(counted); try {
    for (let index = 1; index < 9; index++) f.original.set(42 + index, email({ uid: 42 + index, messageId: '<selected-' + index + '@example.com>' }));
    const events: import('../src/shared/contracts').Progress[] = [];
    const service = new MailService(f.store, value => events.push(structuredClone(value)), f.connect, () => counted, () => now);
    const scan = await service.scan(true); assert.equal(scan.processed, 9);
    const before = calls;
    // These unrelated messages are only added after analysis, to prove they are never classified or changed.
    for (let index = 0; index < 1497; index++) f.original.set(1000 + index, email({ uid: 1000 + index, messageId: '<unrelated-' + index + '@example.com>' }));
    f.omitReceipt(); events.length = 0;
    const result = await service.move(scan.records.map(record => record.id));
    const enumeration = events.find(event => event.folderCheck?.processed === 200 && event.folderCheck.total === 1497)!;
    assert.ok(enumeration);
    assert.equal(enumeration.phase, 'checking'); assert.equal(enumeration.operationTotal, 9);
    assert.equal(enumeration.processed, 0); assert.equal(enumeration.total, 9);
    assert.equal(enumeration.folderCheck!.mailbox, 'INBOX');
    assert.ok(events.every(event => event.processed <= event.total && event.total <= 9));
    assert.ok(events.some(event => event.phase === 'checking' && !event.folderCheck && event.processed === 9 && event.total === 9));
    assert.equal(result.moved, 9); assert.equal(result.uncertain, 0); assert.equal(result.cleanup!.total, 9);
    await service.refreshCleanup();
    assert.equal(f.original.size, 1497); assert.equal(f.moveCalls, 9); assert.equal(f.flagCalls, 0);
    assert.equal(f.downloads.length, 9); assert.equal(calls, before);
  } finally { await f.cleanup(); }
});

test('missing receipts and lost operation responses have separate private-free diagnostics and never cause a second move', async () => {
  for (const lostConnection of [false, true]) {
    const f = await fixture(); try {
      f.omitReceipt();
      if (lostConnection) {
        const move = f.client.messageMove;
        f.client.messageMove = async (...args) => { await move(...args); throw Object.assign(new Error('PRIVATE provider payload and account'), { code: 'ETIMEOUT' }); };
      }
      const diagnostics: import('../src/shared/contracts').OperationDiagnostic[] = [];
      const events: import('../src/shared/contracts').Progress[] = [];
      const service = new MailService(f.store, value => events.push(structuredClone(value)), f.connect, () => evaluator(), () => now, entry => { diagnostics.push(entry); throw new Error('diagnostic sink unavailable'); });
      f.archive.set(43, email({ uid: 43, mailbox: 'Archive', uidValidity: '777' }));
      await f.store.saveConfig({ settings: { ...settings, mailboxes: ['INBOX', 'Archive'] } });
      const scan = await service.scan(true); const row = scan.records[0];
      const result = await service.move([row.id]);
      assert.equal(result.moved, 1); assert.equal(result.uncertain, 0); assert.equal(f.moveCalls, 1);
      assert.equal(diagnostics.find(entry => entry.event === 'actions.confirmation-needed')!.details.reasonCode, lostConnection ? 'operation_connection_error' : 'move_receipt_incomplete');
      assert.ok(diagnostics.some(entry => entry.event === 'actions.verification-started'));
      const finished = diagnostics.find(entry => entry.event === 'actions.verification-finished')!;
      assert.equal(finished.details.moved, 1); assert.equal(finished.details.uncertain, 0); assert.ok(finished.details.durationMs! >= 0);
      const checking = events.find(event => event.phase === 'checking')!;
      assert.deepEqual(checking.operationIds, [row.id]);
      assert.equal(scan.records.length, 2); // The same-fingerprint copy in Archive is outside this operation.
      for (const privateValue of [row.subject, row.senderAddress, row.messageId, row.fingerprint, 'test-password', 'test-key', 'PRIVATE']) assert.ok(!JSON.stringify(diagnostics).includes(privateValue));
    } finally { await f.cleanup(); }
  }
});

test('a failed verification preserves the unknown result and records its cause without provider payloads', async () => {
  const f = await fixture(); try {
    f.omitReceipt();
    const diagnostics: import('../src/shared/contracts').OperationDiagnostic[] = [];
    const service = new MailService(f.store, () => {}, f.connect, () => evaluator(), () => now, entry => diagnostics.push(entry));
    const row = (await service.scan(true)).records[0];
    f.client.search = async () => { throw new Error('PRIVATE email and server response'); };
    await assert.rejects(service.move([row.id]), /自动核对未完成/);
    assert.equal((await f.store.loadAction())!.records[0].status, 'uncertain');
    assert.equal(diagnostics.at(-1)!.event, 'actions.verification-failed');
    assert.equal(diagnostics.at(-1)!.details.reasonCode, 'verification_read_error');
    assert.ok(!JSON.stringify(diagnostics).includes('PRIVATE')); assert.equal(f.moveCalls, 1);
  } finally { await f.cleanup(); }
});
