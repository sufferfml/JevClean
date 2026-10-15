import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MailService } from '../src/core/service';
import { canSelect, currentLocation } from '../src/shared/contracts';
import { fixture } from './fixture';
import { email, now, settings } from './helpers';

test('undo updates only the moved physical message; selecting a same-fingerprint copy still changes that copy', async () => {
  const f = await fixture(); try {
    const scan = await f.service.scan(true);
    await f.service.move([scan.records[0].id]);
    f.original.set(43, email({ uid: 43 }));
    f.quarantine.set(102, email({ uid: 102 }));
    f.archive.set(42, email({ uid: 42 }));
    await f.service.saveConfig({ settings: { ...settings, mailboxes: ['INBOX', 'Trash', 'Archive'] } });
    const listed = await f.service.readMail();
    const sourceCopy = listed.records.find(record => record.mailbox === 'INBOX')!;
    const movedRow = listed.records.find(record => record.mailbox === 'Trash' && record.uid === 101)!;
    const otherCopies = listed.records.filter(record => record !== sourceCopy && record !== movedRow);
    const untouched = otherCopies.map(record => structuredClone(record));

    const restored = await f.service.undo();
    assert.deepEqual([...f.original.keys()], [43, 142]);
    assert.deepEqual(currentLocation(restored.report.records.find(record => record.id === sourceCopy.id)!), { mailbox: 'INBOX', uidValidity: '999', uid: 43 });
    assert.equal(restored.report.records.find(record => record.id === sourceCopy.id)!.status, 'pending');
    assert.deepEqual(currentLocation(restored.report.records.find(record => record.id === movedRow.id)!), { mailbox: 'INBOX', uidValidity: '999', uid: 142 });
    for (const copy of untouched) assert.deepEqual(restored.report.records.find(record => record.id === copy.id), copy);

    const restarted = new MailService(f.store, () => {}, f.connect, () => { throw new Error('No Jev'); }, () => now);
    const plan = await restarted.checkManual({ ids: [sourceCopy.id], action: 'read' });
    assert.equal(plan.ready, true);
    await restarted.executeManual(plan.id);
    assert.equal(f.original.get(43)!.flags.includes('\\Seen'), true);
    assert.equal(f.original.get(142)!.flags.includes('\\Seen'), false);
    assert.equal(f.quarantine.get(102)!.flags.includes('\\Seen'), false);
    assert.equal(f.archive.get(42)!.flags.includes('\\Seen'), false);
  } finally { await f.cleanup(); }
});

test('a changed UIDVALIDITY cannot inherit an older operation through the same UID and fingerprint', async () => {
  const f = await fixture(); try {
    const listed = await f.service.readMail();
    const plan = await f.service.checkManual({ ids: [listed.records[0].id], action: 'read' });
    await f.service.executeManual(plan.id);
    f.changeValidity();
    f.original.get(42)!.flags = [];
    const replacement = await f.service.readMail();
    const before = structuredClone(replacement.records[0]);
    assert.equal(before.uidValidity, '123');
    const refreshed = await f.service.refreshCleanup();
    assert.equal(refreshed.uncertain, 1);
    assert.deepEqual(refreshed.report.records[0], before);
    assert.equal(canSelect(refreshed.report.records[0]), true);
    assert.equal(f.flagCalls, 1);
  } finally { await f.cleanup(); }
});

test('a different account does not inherit uncertain operations with identical location and fingerprint', async () => {
  const f = await fixture(); try {
    const listed = await f.service.readMail();
    const plan = await f.service.checkManual({ ids: [listed.records[0].id], action: 'read' });
    await f.service.executeManual(plan.id);
    const action = (await f.store.loadAction())!;
    action.records[0].status = 'moving';
    await f.store.saveAction(action);
    await f.service.saveConfig({ settings: { ...settings, email: 'other@example.com' }, imapPassword: 'other-test-password' });
    const restarted = new MailService(f.store, () => {}, f.connect, () => { throw new Error('No Jev'); }, () => now);
    const otherAccount = await restarted.readMail();
    assert.equal(otherAccount.records[0].status, 'pending');
    assert.equal(otherAccount.records[0].operation, undefined);
    await assert.rejects(restarted.refreshCleanup(), /切回/);
    assert.equal(f.flagCalls, 1);
  } finally { await f.cleanup(); }
});

test('a missing MOVE receipt blocks destination candidates without claiming unrelated copies as the operated message', async () => {
  const f = await fixture(); try {
    const listed = await f.service.readMail();
    const plan = await f.service.checkManual({ ids: [listed.records[0].id], action: 'delete' });
    f.omitReceipt();
    const search = f.client.search;
    f.client.search = async () => { throw new Error('Synthetic interrupted lookup'); };
    await assert.rejects(f.service.executeManual(plan.id), /自动核对未完成/);
    f.client.search = search;
    f.original.set(43, email({ uid: 43 }));
    f.archive.set(42, email({ uid: 42 }));
    f.quarantine.set(102, email({ uid: 102 }));
    await f.service.saveConfig({ settings: { ...settings, mailboxes: ['INBOX', 'Trash', 'Archive'] } });
    const reloaded = await f.service.readMail();
    for (const copy of reloaded.records.filter(record => record.mailbox !== 'Trash')) {
      assert.equal(copy.status, 'pending');
      assert.equal(copy.operation, undefined);
    }
    for (const candidate of reloaded.records.filter(record => record.mailbox === 'Trash')) {
      assert.equal(candidate.status, 'uncertain');
      assert.equal(candidate.operationLocations, undefined);
    }
    const before = reloaded.records.map(record => currentLocation(record));
    const refreshed = await f.service.refreshCleanup();
    assert.equal(refreshed.uncertain, 1);
    assert.deepEqual(refreshed.report.records.map(record => currentLocation(record)), before);
    await assert.rejects(f.service.checkManual({ ids: [reloaded.records[0].id], action: 'read' }), /上次整理/);
    assert.equal(f.moveCalls, 1);
  } finally { await f.cleanup(); }
});

test('a separately persisted unknown flag intent blocks its exact row even when the old report can reuse AI evidence', async () => {
  const f = await fixture(); try {
    f.original.set(43, email({ uid: 43 }));
    const scanned = await f.service.scan(true);
    const oldReport = structuredClone(scanned);
    const selected = scanned.records.find(record => record.uid === 42)!;
    const plan = await f.service.checkManual({ ids: [selected.id], action: 'read' });
    const search = f.client.search;
    f.client.messageFlagsAdd = async () => { throw new Error('Synthetic lost flag response'); };
    f.client.search = async () => { throw new Error('Synthetic interrupted lookup'); };
    await assert.rejects(f.service.executeManual(plan.id), /自动核对未完成/);
    f.client.search = search;
    // Model the two persisted files after the intent succeeded but the report update was lost.
    await f.store.saveReport(oldReport);
    const restarted = new MailService(f.store, () => {}, f.connect, () => { throw new Error('No Jev'); }, () => now);
    const reloaded = await restarted.readMail();
    const actual = reloaded.records.find(record => record.uid === 42)!;
    const copy = reloaded.records.find(record => record.uid === 43)!;
    assert.equal(actual.category, 'clean');
    assert.equal(actual.status, 'uncertain');
    assert.equal(copy.category, 'clean');
    assert.equal(copy.status, 'pending');
    assert.equal(copy.operation, undefined);
    assert.equal(f.downloads.length, 2);
    await assert.rejects(restarted.checkManual({ ids: [actual.id], action: 'star' }), /尚未确认/);
  } finally { await f.cleanup(); }
});

test('legacy receipts remain undoable after reread and restart without linking same-fingerprint copies', async () => {
  const f = await fixture(); try {
    const listed = await f.service.readMail();
    const plan = await f.service.checkManual({ ids: [listed.records[0].id], action: 'delete' });
    await f.service.executeManual(plan.id);
    const action = (await f.store.loadAction())!;
    for (const record of action.records) delete record.operationLocations;
    await f.store.saveAction(action);
    f.original.set(43, email({ uid: 43 }));
    await f.service.saveConfig({ settings: { ...settings, mailboxes: ['INBOX', 'Trash'] } });
    const reloaded = await f.service.readMail();
    const sourceCopy = structuredClone(reloaded.records.find(record => record.mailbox === 'INBOX')!);
    const restarted = new MailService(f.store, () => {}, f.connect, () => { throw new Error('No Jev'); }, () => now);
    const result = await restarted.undo();
    assert.equal(result.moved, 1);
    assert.deepEqual(result.report.records.find(record => record.id === sourceCopy.id), sourceCopy);
    assert.equal(result.report.records.find(record => record.id !== sourceCopy.id)!.uid, 142);
    assert.equal(f.moveCalls, 2);
  } finally { await f.cleanup(); }
});

test('an interrupted restore retains exact location links across restart and read-only reconciliation', async () => {
  const f = await fixture(); try {
    const listed = await f.service.readMail();
    const plan = await f.service.checkManual({ ids: [listed.records[0].id], action: 'delete' });
    await f.service.executeManual(plan.id);
    await f.service.saveConfig({ settings: { ...settings, mailboxes: ['Trash'] } });
    const reloaded = await f.service.readMail();
    f.omitReceipt();
    const search = f.client.search;
    f.client.search = async () => { throw new Error('Synthetic interrupted lookup'); };
    await assert.rejects(f.service.undo(), /自动核对未完成/);
    f.client.search = search;
    const persisted = (await f.store.loadReport())!;
    assert.equal(persisted.records[0].uid, 101);
    assert.equal(persisted.records[0].mailbox, 'Trash');
    assert.equal(persisted.records[0].status, 'uncertain');
    const restarted = new MailService(f.store, () => {}, f.connect, () => { throw new Error('No Jev'); }, () => now);
    const refreshed = await restarted.refreshCleanup();
    assert.equal(refreshed.report.id, reloaded.id);
    assert.equal(refreshed.report.records[0].status, 'restored');
    assert.deepEqual(currentLocation(refreshed.report.records[0]), { mailbox: 'INBOX', uidValidity: '999', uid: 142 });
    assert.equal(f.moveCalls, 2);
    assert.equal(f.downloads.length, 0);
  } finally { await f.cleanup(); }
});

test('unique source-only reconciliation keeps the previous UID link when an interrupted operation reappears under a new UID', async () => {
  const f = await fixture(); try {
    const listed = await f.service.readMail();
    const plan = await f.service.checkManual({ ids: [listed.records[0].id], action: 'delete' });
    const search = f.client.search;
    f.client.messageMove = async () => { throw new Error('Synthetic lost MOVE response'); };
    f.client.search = async () => { throw new Error('Synthetic interrupted lookup'); };
    await assert.rejects(f.service.executeManual(plan.id), /自动核对未完成/);
    f.client.search = search;
    const reloaded = await f.service.readMail();
    assert.equal(reloaded.records[0].uid, 42);
    assert.equal(reloaded.records[0].status, 'uncertain');

    // Another mail client moves the unique message out and back, assigning a new source UID.
    const message = f.original.get(42)!;
    f.original.delete(42);
    f.original.set(142, { ...message, uid: 142 });
    const restarted = new MailService(f.store, () => {}, f.connect, () => { throw new Error('No Jev'); }, () => now);
    const checked = await restarted.refreshCleanup();
    assert.equal(checked.failed, 1);
    assert.equal(checked.uncertain, 0);
    assert.equal(checked.report.id, reloaded.id);
    assert.equal(checked.report.records[0].status, 'failed');
    assert.deepEqual(currentLocation(checked.report.records[0]), { mailbox: 'INBOX', uidValidity: '999', uid: 142 });
    assert.equal((await restarted.checkManual({ ids: [reloaded.records[0].id], action: 'read' })).ready, true);
  } finally { await f.cleanup(); }
});
