import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { classifyMessage } from '../src/core/classifier';
import { MailService, QUARANTINE } from '../src/core/service';
import { actionIds, ruleSchema, settingsSchema, type MailAction } from '../src/shared/contracts';
import { policyHash } from '../src/core/rules';
import { fixture } from './fixture';
import { email, evaluator, now, settings, testCipher } from './helpers';
import { LocalStore } from '../src/core/storage';
import { resolveDestination } from '../src/core/actions';

const oneRule = (action: MailAction, targetMailbox?: string) => ({ ...settings, rules: [{ ...settings.rules[0], action, ...(targetMailbox ? { targetMailbox } : {}) }] });

for (const [action, target] of [['delete', 'Trash'], ['archive', 'Archive'], ['junk', 'Junk'], ['move', 'Archive']] as const) {
  test(action + ' uses the correct destination, verifies results and restores after restart', async () => {
    const f = await fixture(); try {
      await f.service.saveConfig({ settings: oneRule(action, action === 'move' ? target : undefined) });
      const report = await f.service.scan(true); const row = report.records[0];
      assert.equal(row.action, action); assert.equal(row.targetMailbox, target);
      const result = await f.service.move([row.id]);
      assert.equal(result.moved, 1); assert.equal(result.report.records[0].destinationPath, target);
      assert.equal(f.folders.get(target)!.size, 1); assert.equal(f.flagCalls, 0);
      assert.equal(result.cleanup!.actions![action], 1);
      const restarted = new MailService(f.store, () => {}, f.connect, () => { throw new Error('No model call for verification or undo'); }, () => now);
      assert.equal((await restarted.refreshCleanup()).moved, 1);
      assert.equal((await restarted.undo()).moved, 1); assert.equal(f.original.size, 1);
      assert.equal(f.folders.get(target)!.size, 0);
    } finally { await f.cleanup(); }
  });
}
for (const [action, flag, before, after] of [['read', '\\Seen', false, true], ['unread', '\\Seen', true, false], ['star', '\\Flagged', false, true], ['unstar', '\\Flagged', true, false]] as const) {
  test(action + ' changes only its flag, persists original state, verifies and undoes without MOVE', async () => {
    const f = await fixture(); try {
      f.original.set(42, email({ flags: ['\\Answered', ...(before ? [flag] : [])] }));
      await f.service.saveConfig({ settings: oneRule(action) });
      f.client.capabilities.clear(); // STORE actions must not require MOVE or UIDPLUS.
      const report = await f.service.scan(true); assert.equal(report.records[0].eligible, true);
      const result = await f.service.move([report.records[0].id]); assert.equal(result.moved, 1);
      assert.equal(f.original.get(42)!.flags.includes(flag), after); assert.ok(f.original.get(42)!.flags.includes('\\Answered'));
      assert.equal((await f.store.loadAction())!.records[0].previousFlag, before);
      const restarted = new MailService(f.store, () => {}, f.connect, () => { throw new Error('No model call'); }, () => now);
      const preview = await restarted.preview(report.records[0].id);
      assert.equal(preview.subject, f.original.get(42)!.subject); // Flag actions keep the original location.
      assert.equal((await restarted.refreshCleanup()).moved, 1);
      assert.equal((await restarted.undo()).moved, 1);
      assert.equal(f.original.get(42)!.flags.includes(flag), before); assert.ok(f.original.get(42)!.flags.includes('\\Answered'));
      assert.equal(f.moveCalls, 0); assert.equal(f.flagCalls, 2);
      assert.equal(f.downloads.length, 2);
    } finally { await f.cleanup(); }
  });
}
test('an explicit keep action takes precedence over a fully matched delete action', async () => {
  const config = { ...settings, rules: [{ ...settings.rules[0] }, { id: 'protect', name: '保护凭证', description: '付款凭证。', enabled: true, action: 'keep' as const }] };
  const result = await classifyMessage(email(), config, evaluator('match', { decisions: { promotions: 'match', protect: 'match' } }), now);
  assert.equal(result.classification.action, 'keep'); assert.equal(result.classification.eligible, false);
  assert.match(result.classification.reason, /保护凭证/);
});
test('stricter actions win, different move targets conflict, and identical actions merge', async () => {
  for (const [first, second, conflict] of [
    [{ action: 'delete' }, { action: 'archive' }, false],
    [{ action: 'move', targetMailbox: 'A' }, { action: 'move', targetMailbox: 'B' }, true],
    [{ action: 'delete' }, { action: 'delete' }, false],
  ] as const) {
    const config = { ...settings, rules: [{ ...settings.rules[0], ...first }, { ...settings.rules[0], id: 'another', ...second }] };
    const result = await classifyMessage(email(), config, evaluator('match', { decisions: { promotions: 'match', another: 'match' } }), now);
    assert.equal(result.classification.category, conflict ? 'review' : 'clean');
    assert.equal(result.classification.eligible, !conflict);
    if (conflict) assert.match(result.classification.reason, /动作冲突/);
    else assert.equal(result.classification.action, first.action);
  }
});
test('a conflict can only be resolved using a verified option, stays local and survives reload', async () => {
  const evaluate = evaluator('match', { decisions: { promotions: 'match', archive_rule: 'match' } });
  const f = await fixture(evaluate); try {
    await f.service.saveConfig({ settings: { ...settings, rules: [{ ...settings.rules[0], action: 'move', targetMailbox: 'Trash' }, { ...settings.rules[0], id: 'archive_rule', action: 'move', targetMailbox: 'Archive' }] } });
    const report = await f.service.scan(true); const row = report.records[0];
    assert.equal(row.eligible, false); assert.equal(row.conflicts!.length, 2);
    await assert.rejects(f.service.move([row.id]), /不符合执行/);
    await assert.rejects(f.service.resolveConflict(row.id, 'forged'), /不是/);
    const selected = await f.service.resolveConflict(row.id, 'archive_rule');
    assert.equal(selected.records[0].action, 'move'); assert.equal(selected.records[0].targetMailbox, 'Archive');
    assert.equal(f.moveCalls, 0); assert.equal(f.downloads.length, 1);
    const restarted = new MailService(f.store, () => {}, f.connect, () => { throw new Error('No Jev'); }, () => now);
    assert.equal((await restarted.loadReport())!.records[0].selectedConflict, 'archive_rule');
    assert.equal((await restarted.move([row.id])).moved, 1);
    assert.equal(f.archive.size, 1); assert.equal(f.quarantine.size, 0);
  } finally { await f.cleanup(); }
});
test('a keep rule must meet its time condition and weak protection is uncertain', async () => {
  const config = oneRule('keep'); config.rules[0].description = '收到超过30天的通知。';
  const future = await classifyMessage(email({ date: now.toISOString() }), config, evaluator('match', { time: 'received_age' }), now);
  assert.equal(future.classification.matchedRules.length, 0);
  const weak = await classifyMessage(email(), config, evaluator('match', { probability: .6 }), now);
  assert.equal(weak.classification.category, 'review'); assert.equal(weak.classification.eligible, false);
});
test('flags already in the requested state are non-executable and changing a rule action invalidates reports', async () => {
  const result = await classifyMessage(email({ flags: ['\\Seen'] }), oneRule('read'), evaluator(), now);
  assert.equal(result.classification.eligible, true); assert.equal(result.classification.category, 'clean');
  const f = await fixture(); try {
    const report = await f.service.scan(true); await f.service.saveConfig({ settings: oneRule('archive') });
    await assert.rejects(f.service.move([report.records[0].id]), /重新分析/); assert.equal(f.moveCalls, 0);
  } finally { await f.cleanup(); }
});
test('unknown and missing destinations cannot mutate mail; explicit mappings resolve nonstandard names', async () => {
  const f = await fixture(); try {
    f.folders.delete('Trash');
    await assert.rejects(f.service.scan(true), /尚未调用 Jev/);
    assert.equal((await f.service.checkActions()).preflight.ready, false);
    await f.service.saveConfig({ settings: { ...oneRule('delete'), actionFolders: { trash: 'Archive' } } });
    const next = await f.service.scan(true); assert.equal(next.records[0].targetMailbox, 'Archive');
    f.folders.delete('Archive'); await assert.rejects(f.service.move([next.records[0].id]), /不存在/);
    assert.equal(f.moveCalls, 0);
  } finally { await f.cleanup(); }
});
test('ambiguous special folders are never chosen by name guessing, and Gmail archive uses its All mailbox', () => {
  const client = { capabilities: new Map([['X-GM-EXT-1', true]]) };
  const folders = [{ path: '[Gmail]/All Mail', name: 'All Mail', selectable: true, specialUse: '\\All' }];
  assert.equal(resolveDestination({ action: 'archive', mailbox: 'INBOX' }, settings, folders, client), '[Gmail]/All Mail');
  assert.throws(() => resolveDestination({ action: 'archive', mailbox: 'Custom label' }, settings, folders, client), /收件箱/);
  assert.throws(() => resolveDestination({ action: 'delete', mailbox: 'INBOX' }, settings, [{ ...folders[0], specialUse: '\\Trash' }, { ...folders[0], path: 'Other', specialUse: '\\Trash' }], client), /多个/);
});
test('flag commands that reach the server but lose their response are reconciled without retries', async () => {
  const f = await fixture(); try {
    await f.service.saveConfig({ settings: oneRule('read') }); const report = await f.service.scan(true);
    const add = f.client.messageFlagsAdd;
    f.client.messageFlagsAdd = async (...args) => { await add(...args); throw new Error('response lost'); };
    const result = await f.service.move([report.records[0].id]); assert.equal(result.moved, 1); assert.equal(result.uncertain, 0);
    assert.equal(f.flagCalls, 1); assert.equal(result.canUndo, true);
  } finally { await f.cleanup(); }
});
test('undo cannot overwrite a changed message identity, source validity or missing original flag', async () => {
  for (const change of ['identity', 'validity', 'receipt'] as const) {
    const f = await fixture(); try {
      await f.service.saveConfig({ settings: oneRule('star') }); const report = await f.service.scan(true);
      await f.service.move([report.records[0].id]);
      if (change === 'identity') f.changeIdentity();
      if (change === 'validity') f.changeValidity();
      if (change === 'receipt') {
        const saved = (await f.store.loadAction())!; delete saved.records[0].previousFlag; await f.store.saveAction(saved);
      }
      const restarted = new MailService(f.store, () => {}, f.connect, () => evaluator(), () => now);
      const result = await restarted.undo(); assert.equal(result.failed, 1); assert.equal(f.flagCalls, 1);
    } finally { await f.cleanup(); }
  }
});
test('legacy rules normalize actions without rewriting credentials and old undo receipts still work', async () => {
  const f = await fixture(); try {
    const cipher = testCipher(); const store = new LocalStore(f.dir, cipher);
    const legacySettings = { ...settings, rules: settings.rules.map(({ action: _action, ...rule }) => rule) };
    const encrypted = await cipher.encrypt(JSON.stringify({ settings: legacySettings, secrets: { imapPassword: 'legacy-password', jevApiKey: 'legacy-key' } }));
    await writeFile(join(f.dir, 'settings.enc'), encrypted);
    assert.ok((await store.config()).settings.rules.every(rule => rule.action === 'delete'));
    assert.deepEqual(await readFile(join(f.dir, 'settings.enc')), encrypted);
  } finally { await f.cleanup(); }
  const f2 = await fixture(); try {
    const scan = await f2.service.scan(true); await f2.service.move([scan.records[0].id]);
    const action = (await f2.store.loadAction())!; const row = action.records[0];
    const message = f2.quarantine.get(row.destinationUid!)!; f2.quarantine.clear(); f2.legacy.set(row.destinationUid!, message);
    delete row.action; delete row.targetMailbox; row.destinationPath = QUARANTINE;
    await f2.store.saveAction(action);
    const restarted = new MailService(f2.store, () => {}, f2.connect, () => evaluator(), () => now);
    assert.equal((await restarted.refreshCleanup()).moved, 1); assert.equal((await restarted.undo()).moved, 1);
  } finally { await f2.cleanup(); }
});
test('a rule has exactly one known action and move is the only action accepting a target', () => {
  for (const action of actionIds) assert.equal(ruleSchema.safeParse({ ...settings.rules[0], action, ...(action === 'move' ? { targetMailbox: 'Archive' } : {}) }).success, true);
  assert.equal(ruleSchema.safeParse({ ...settings.rules[0], action: ['read', 'move'] }).success, false);
  assert.equal(ruleSchema.safeParse({ ...settings.rules[0], action: 'move' }).success, false);
  assert.equal(ruleSchema.safeParse({ ...settings.rules[0], action: 'delete', targetMailbox: 'Archive' }).success, false);
  assert.equal(settingsSchema.safeParse({ ...settings, actionFolders: { arbitrary: 'Archive' } }).success, false);
  assert.notEqual(policyHash(settings), policyHash({ ...settings, actionFolders: { trash: 'Other' } }));
});
