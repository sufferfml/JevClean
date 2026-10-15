import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { MailService } from '../src/core/service';
import { canSelect, currentLocation, type MailRecord } from '../src/shared/contracts';
import { fixture } from './fixture';
import { email, evaluator, now, settings } from './helpers';

const evidence = (record: MailRecord) => JSON.stringify(Object.fromEntries(['category', 'eligible', 'reason', 'confidence', 'probability', 'matchedRules', 'verdicts', 'expiryEvidence', 'action', 'targetMailbox', 'conflicts', 'selectedConflict', 'execution'].map(key => [key, record[key as keyof MailRecord]])));

test('list refresh retains unchanged AI evidence, while changed flags or rules cannot inherit rule authorization', async () => {
  const f = await fixture(); try {
    const scan = await f.service.scan(true); const before = evidence(scan.records[0]); const reads = f.downloads.length;
    const refreshed = await f.service.readMail(); assert.equal(evidence(refreshed.records[0]), before); assert.equal(refreshed.apiCalls, 0); assert.equal(f.downloads.length, reads);
    f.original.get(42)!.flags.push('\\Seen');
    const changed = await f.service.readMail(); assert.equal(changed.records[0].category, 'unclassified'); assert.equal(changed.records[0].eligible, false);
    await f.service.saveConfig({ settings: { ...settings, rules: settings.rules.map(rule => ({ ...rule, description: '全新的条件' })) } });
    assert.equal((await f.service.readMail()).records[0].category, 'unclassified'); assert.equal(f.downloads.length, reads);
  } finally { await f.cleanup(); }
});

test('loading recent mail needs no Jev key, consent, rules or destination and reads headers only', async () => {
  const f = await fixture(); try {
    await f.service.forgetCredentials();
    await f.service.saveConfig({ settings: { ...settings, rules: [], mailboxes: ['INBOX', 'Archive'], scanLimit: 2 }, imapPassword: 'mail-only' });
    f.folders.delete('Trash');
    f.original.set(43, email({ uid: 43, messageId: '<recent@example.com>', date: '2026-10-01T10:00:00Z' }));
    f.archive.set(51, email({ uid: 51, messageId: '<archive@example.com>', date: '2026-10-02T10:00:00Z' }));
    const events: import('../src/shared/contracts').Progress[] = [];
    const service = new MailService(f.store, event => events.push(event), f.connect, () => { throw new Error('No Jev'); }, () => now);
    const report = await service.readMail();
    assert.equal(report.records.length, 2); assert.deepEqual(report.records.map(record => record.uid), [43, 51]);
    assert.ok(report.records.every(record => record.category === 'unclassified' && !record.eligible && canSelect(record)));
    assert.equal(report.apiCalls, 0); assert.equal(f.downloads.length, 0); assert.equal(f.moveCalls, 0); assert.equal(f.flagCalls, 0);
    assert.ok(f.locks.every(lock => lock.readOnly)); assert.ok(events.some(event => event.phase === 'reading'));
    const plan = await service.checkManual({ ids: [report.records[0].id], action: 'archive' });
    assert.equal(plan.ready, true); assert.deepEqual(plan.destinations, [{ path: 'Archive', count: 1 }]);
    assert.equal((await service.executeManual(plan.id)).moved, 1); assert.equal(f.downloads.length, 0);
    assert.ok(!(await readFile(join(f.dir, 'report.enc'))).includes(Buffer.from('Save 20%')));
  } finally { await f.cleanup(); }
});

for (const [decision, options] of [['keep', {}], ['match', { probability: .6 }]] as const) {
  test('manual deletion preserves original AI evidence for ' + decision, async () => {
    const f = await fixture(evaluator(decision, options)); try {
      const report = await f.service.scan(true); const row = report.records[0]; const original = evidence(row);
      assert.equal(row.category, decision === 'keep' ? 'keep' : 'review'); assert.equal(canSelect(row), true);
      await assert.rejects(f.service.move([row.id]), /不符合/);
      const downloads = f.downloads.length;
      const plan = await f.service.checkManual({ ids: [row.id], action: 'delete' });
      assert.equal(f.moveCalls, 0); assert.equal(plan.ready, true);
      const done = await f.service.executeManual(plan.id);
      assert.equal(done.moved, 1); assert.equal(done.cleanup!.actions!.delete, 1); assert.equal(evidence(done.report.records[0]), original);
      assert.equal(done.report.records[0].operation!.source, 'manual'); assert.equal(done.report.records[0].operation!.action, 'delete');
      const restarted = new MailService(f.store, () => {}, f.connect, () => { throw new Error('No model'); }, () => now);
      assert.equal((await restarted.preview(row.id)).subject, row.subject);
      assert.equal((await restarted.refreshCleanup()).moved, 1);
      assert.equal(evidence((await restarted.loadReport())!.records[0]), original);
      assert.equal((await restarted.undo()).moved, 1); assert.equal(f.original.size, 1); assert.equal(f.downloads.length, downloads + 1);
      await assert.rejects(restarted.executeManual(plan.id), /处理选项/);
    } finally { await f.cleanup(); }
  });
}

test('a stale rule result remains manually usable and only the selected action is preflighted', async () => {
  const f = await fixture(); try {
    const report = await f.service.scan(true); const original = evidence(report.records[0]);
    await f.service.saveConfig({ settings: { ...settings, rules: settings.rules.map(rule => ({ ...rule, description: '全新的自然语言规则' })), scanLimit: 1 } });
    f.folders.delete('Trash');
    assert.equal((await f.service.checkActions()).preflight.ready, false);
    await assert.rejects(f.service.move([report.records[0].id]), /重新分析/);
    const plan = await f.service.checkManual({ ids: [report.records[0].id], action: 'archive' });
    assert.equal(plan.ready, true); assert.equal((await f.service.executeManual(plan.id)).moved, 1);
    assert.equal(evidence((await f.service.loadReport())!.records[0]), original);
  } finally { await f.cleanup(); }
});

test('unresolved AI conflicts can be handled manually without resolving or rewriting the AI conflict', async () => {
  const f = await fixture(evaluator('match', { decisions: { promotions: 'match', also: 'match' } })); try {
    await f.service.saveConfig({ settings: { ...settings, rules: [{ ...settings.rules[0], action: 'move', targetMailbox: 'Trash' }, { ...settings.rules[0], id: 'also', action: 'move', targetMailbox: 'Archive' }] } });
    const scan = await f.service.scan(true); const row = scan.records[0]; const before = evidence(row);
    assert.equal(row.conflicts!.length, 2);
    const plan = await f.service.checkManual({ ids: [row.id], action: 'star' });
    assert.equal((await f.service.executeManual(plan.id)).moved, 1); assert.equal(evidence(row), before);
    assert.equal(evidence((await f.service.loadReport())!.records[0]), before); assert.equal(f.flagCalls, 1); assert.equal(f.moveCalls, 0);
  } finally { await f.cleanup(); }
});

for (const [action, flag, before] of [['read', '\\Seen', false], ['unread', '\\Seen', true], ['star', '\\Flagged', false], ['unstar', '\\Flagged', true]] as const) {
  test('manual ' + action + ' captures and restores actual flags without requiring MOVE or AI', async () => {
    const f = await fixture(); try {
      const report = await f.service.readMail(); const row = report.records[0]; const ai = evidence(row);
      f.client.capabilities.clear();
      f.original.get(42)!.flags = ['\\Answered', ...(before ? [flag] : [])];
      const plan = await f.service.checkManual({ ids: [row.id], action }); assert.equal(plan.ready, true);
      const result = await f.service.executeManual(plan.id); assert.equal(result.moved, 1);
      assert.equal((await f.store.loadAction())!.records[0].previousFlag, before);
      assert.equal(evidence(result.report.records[0]), ai);
      assert.equal((await f.service.refreshCleanup()).moved, 1); assert.equal((await f.service.undo()).moved, 1);
      assert.equal(f.original.get(42)!.flags.includes(flag), before); assert.ok(f.original.get(42)!.flags.includes('\\Answered'));
      assert.equal(f.moveCalls, 0); assert.equal(f.flagCalls, 2); assert.equal(f.downloads.length, 0);
    } finally { await f.cleanup(); }
  });
}

test('a second manual action uses the known current location and undoes only the latest action', async () => {
  const f = await fixture(evaluator('keep')); try {
    const scan = await f.service.scan(true); const id = scan.records[0].id; const original = evidence(scan.records[0]);
    const first = await f.service.checkManual({ ids: [id], action: 'delete' }); await f.service.executeManual(first.id);
    const second = await f.service.checkManual({ ids: [id], action: 'move', targetMailbox: 'Archive' });
    assert.deepEqual(second.destinations, [{ path: 'Archive', count: 1 }]);
    const done = await f.service.executeManual(second.id); assert.equal(done.moved, 1);
    assert.equal(currentLocation(done.report.records[0]).mailbox, 'Archive'); assert.equal(evidence(done.report.records[0]), original);
    const undo = await f.service.undo(); assert.equal(undo.moved, 1); assert.equal(f.archive.size, 0); assert.equal(f.quarantine.size, 1); assert.equal(f.original.size, 0);
    assert.equal(evidence(undo.report.records[0]), original);
  } finally { await f.cleanup(); }
});
test('undo after loading a new list updates the current location while retaining its independent classification', async () => {
  const f = await fixture(evaluator('keep')); try {
    const scan = await f.service.scan(true); const plan = await f.service.checkManual({ ids: [scan.records[0].id], action: 'delete' });
    await f.service.executeManual(plan.id);
    await f.service.saveConfig({ settings: { ...settings, mailboxes: ['Trash'] } });
    const listed = await f.service.readMail(); assert.equal(listed.records[0].category, 'unclassified');
    const done = await f.service.undo(); assert.equal(done.report.id, listed.id); assert.equal(done.report.records[0].status, 'restored');
    assert.equal(done.report.records[0].category, 'unclassified'); assert.equal(currentLocation(done.report.records[0]).mailbox, 'INBOX');
    assert.equal((await f.service.checkManual({ ids: [listed.records[0].id], action: 'star' })).ready, true);
  } finally { await f.cleanup(); }
});

test('manual preflight skips satisfied flags and requires repair for missing destinations', async () => {
  const f = await fixture(); try {
    f.original.set(43, email({ uid: 43, messageId: '<seen@example.com>', flags: ['\\Seen'] }));
    const report = await f.service.readMail(); const ids = report.records.map(record => record.id);
    const flags = await f.service.checkManual({ ids, action: 'read' });
    assert.equal(flags.ready, true); assert.equal(flags.checks.filter(check => check.state === 'noop').length, 1);
    const result = await f.service.executeManual(flags.id); assert.equal(result.cleanup!.total, 1); assert.equal(f.flagCalls, 1);
    f.folders.delete('Trash');
    const blocked = await f.service.checkManual({ ids, action: 'delete' }); assert.equal(blocked.ready, false); assert.equal(blocked.checks[0].code, 'missing_destination');
    await assert.rejects(f.service.executeManual(blocked.id), /处理选项/); assert.equal(f.moveCalls, 0);
    const old = await f.store.config(); await f.service.saveActionFolders({ trash: 'Archive' });
    assert.deepEqual((await f.store.config()).secrets, old.secrets); assert.deepEqual((await f.store.config()).settings.rules, old.settings.rules);
    const repaired = await f.service.checkManual({ ids, action: 'delete' }); assert.equal(repaired.ready, true);
    assert.equal((await f.service.executeManual(repaired.id)).moved, 2);
  } finally { await f.cleanup(); }
});

test('manual execution rechecks account, target and message identity; a plan cannot be replayed', async () => {
  for (const change of ['account', 'target', 'identity', 'validity'] as const) {
    const f = await fixture(); try {
      const report = await f.service.readMail(); const plan = await f.service.checkManual({ ids: [report.records[0].id], action: 'delete' });
      if (change === 'account') await f.service.saveConfig({ settings: { ...settings, email: 'other@example.com' }, imapPassword: 'other' });
      if (change === 'target') await f.service.saveActionFolders({ trash: 'Archive' });
      if (change === 'identity') f.changeIdentity();
      if (change === 'validity') f.changeValidity();
      if (change === 'account' || change === 'target') await assert.rejects(f.service.executeManual(plan.id), /处理选项/);
      else assert.equal((await f.service.executeManual(plan.id)).failed, 1);
      assert.equal(f.moveCalls, 0); assert.equal(f.flagCalls, 0);
      await assert.rejects(f.service.executeManual(plan.id), /处理选项/);
    } finally { await f.cleanup(); }
  }
});

test('lost manual MOVE responses are reconciled, persisted and undoable without retry or Jev', async () => {
  const f = await fixture(); try {
    const report = await f.service.readMail(); const plan = await f.service.checkManual({ ids: [report.records[0].id], action: 'delete' });
    f.omitReceipt(); assert.equal((await f.service.executeManual(plan.id)).moved, 1); assert.equal(f.moveCalls, 1);
    const restarted = new MailService(f.store, () => {}, f.connect, () => { throw new Error('No Jev'); }, () => now);
    assert.equal((await restarted.refreshCleanup()).moved, 1); assert.equal(f.moveCalls, 1);
    assert.equal((await restarted.undo()).moved, 1); assert.equal(f.original.size, 1); assert.equal(f.moveCalls, 2);
  } finally { await f.cleanup(); }
});

test('unknown manual results remain blocked across list reload until read-only verification confirms them', async () => {
  const f = await fixture(); try {
    const report = await f.service.readMail(); const plan = await f.service.checkManual({ ids: [report.records[0].id], action: 'delete' });
    f.omitReceipt(); const search = f.client.search; f.client.search = async () => { throw new Error('interrupted lookup'); };
    await assert.rejects(f.service.executeManual(plan.id), /自动核对未完成/); assert.equal(f.moveCalls, 1);
    f.client.search = search;
    await f.service.saveConfig({ settings: { ...settings, mailboxes: ['Trash'] } });
    const reloaded = await f.service.readMail(); assert.equal(reloaded.records[0].status, 'uncertain');
    await assert.rejects(f.service.checkManual({ ids: [reloaded.records[0].id], action: 'star' }), /尚未确认/);
    const refreshed = await f.service.refreshCleanup(); assert.equal(refreshed.report.records[0].status, 'moved'); assert.equal(refreshed.report.records[0].category, 'unclassified');
    assert.equal(currentLocation(refreshed.report.records[0]).mailbox, 'Trash'); assert.equal(f.moveCalls, 1);
    assert.equal((await f.service.checkManual({ ids: [reloaded.records[0].id], action: 'star' })).ready, true);
  } finally { await f.cleanup(); }
});
