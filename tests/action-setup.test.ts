import assert from 'node:assert/strict';
import { test } from 'node:test';
import { resolveDestination, systemDestination } from '../src/core/actions';
import { MailService } from '../src/core/service';
import { canExecute, type MailboxInfo } from '../src/shared/contracts';
import { judgmentHash, policyHash } from '../src/core/rules';
import { fixture } from './fixture';
import { email, evaluator, now, settings } from './helpers';

const folder = (name: string, patch: Partial<MailboxInfo> = {}): MailboxInfo => ({ name, path: name, selectable: true, ...patch });
const client = { capabilities: new Map([['MOVE', true], ['UIDPLUS', true]]) };

test('exact folder aliases cover 已删除 and namespaces; standard markers win and ambiguous guesses need a choice', () => {
  assert.equal(systemDestination('trash', [folder('已删除', { path: '个人/已删除' })]), '个人/已删除');
  assert.equal(systemDestination('trash', [folder('　已删除　')]), '　已删除　');
  assert.equal(systemDestination('trash', [folder('垃圾邮件', { specialUse: '\\Junk' }), folder('已删除')]), '已删除');
  assert.equal(systemDestination('trash', [folder('重要/已删除的项目')]), undefined);
  assert.equal(systemDestination('trash', [folder('已删除', { selectable: false })]), undefined);
  assert.equal(systemDestination('trash', [folder('Trash', { specialUse: '\\Trash', specialUseSource: 'extension' }), folder('已删除')]), 'Trash');
  assert.throws(() => systemDestination('trash', [folder('Trash', { specialUse: '\\Trash', specialUseSource: 'name' }), folder('已删除')]), /多个/);
  assert.throws(() => systemDestination('trash', [folder('已删除'), folder('废纸篓')]), /多个/);
  assert.equal(resolveDestination({ action: 'delete', mailbox: 'INBOX' }, { ...settings, actionFolders: { trash: 'Custom' } }, [folder('Custom'), folder('已删除')], client), 'Custom');
  assert.throws(() => resolveDestination({ action: 'delete', mailbox: 'INBOX' }, { ...settings, actionFolders: { trash: 'Missing' } }, [folder('已删除')], client), /不存在/);
});

test('preflight validates all enabled actions before Jev, and missing configuration preserves the previous report', async () => {
  let calls = 0; const f = await fixture(async request => { calls++; return evaluator()(request); });
  try {
    const original = await f.service.scan(true); const count = calls; const downloads = f.downloads.length;
    f.folders.delete('Trash');
    const checked = await f.service.checkActions();
    assert.equal(checked.preflight.ready, false); assert.equal(checked.preflight.checks[0].code, 'missing_destination');
    assert.equal(checked.report!.records[0].category, 'clean'); assert.equal(checked.report!.records[0].eligible, true);
    assert.equal(checked.report!.records[0].reason, original.records[0].reason);
    assert.equal(canExecute(checked.report!.records[0]), false);
    await assert.rejects(f.service.scan(true), /尚未调用 Jev/);
    assert.equal((await f.service.loadReport())!.id, original.id); assert.equal(calls, count); assert.equal(f.downloads.length, downloads);
    assert.equal(f.moveCalls, 0); assert.equal(f.flagCalls, 0); assert.ok(f.locks.every(lock => lock.readOnly));
    const mapping = { ...settings, actionFolders: { trash: 'Archive' } };
    await f.service.saveConfig({ settings: mapping });
    assert.equal(judgmentHash(mapping), original.judgmentHash); assert.notEqual(policyHash(mapping), original.policyHash);
    const repaired = await f.service.checkActions(); const row = repaired.report!.records[0];
    assert.equal(repaired.preflight.ready, true); assert.equal(row.targetMailbox, 'Archive'); assert.equal(canExecute(row), true);
    assert.equal(calls, count); assert.equal(f.downloads.length, downloads); assert.equal(f.moveCalls, 0);
    assert.equal((await f.service.move([row.id])).moved, 1);
  } finally { await f.cleanup(); }
});

test('automatic detection works with 已删除 without writing manual configuration', async () => {
  const f = await fixture(); try {
    f.folders.delete('Trash'); f.folders.set('已删除', f.quarantine);
    const result = await f.service.checkActions(); assert.equal(result.preflight.ready, true);
    assert.equal(result.preflight.checks[0].targetMailbox, '已删除');
    assert.deepEqual((await f.store.config()).settings.actionFolders, {});
    const report = await f.service.scan(true); assert.equal(report.records[0].targetMailbox, '已删除');
    assert.equal(report.records[0].execution!.state, 'ready'); assert.equal(f.moveCalls, 0);
  } finally { await f.cleanup(); }
});

test('unsupported movement blocks analysis; disabling that rule permits flag actions without MOVE', async () => {
  let calls = 0; const f = await fixture(async request => { calls++; return evaluator()(request); });
  try {
    f.client.capabilities.clear();
    await assert.rejects(f.service.scan(true), /尚未调用 Jev/); assert.equal(calls, 0);
    assert.equal((await f.service.checkActions()).preflight.checks[0].code, 'unsupported_move');
    await f.service.saveConfig({ settings: { ...settings, rules: [{ ...settings.rules[0], action: 'read' }, { ...settings.rules[1], action: 'delete', enabled: false }] } });
    assert.equal((await f.service.checkActions()).preflight.ready, true);
    const report = await f.service.scan(true); assert.equal(report.records[0].action, 'read'); assert.equal(canExecute(report.records[0]), true);
  } finally { await f.cleanup(); }
});

test('an inaccessible target and an incompatible Gmail source fail the read-only preflight', async () => {
  const f = await fixture(); try {
    const getLock = f.client.getMailboxLock;
    f.client.getMailboxLock = async (path, options) => { if (path === 'Trash') throw new Error('private server diagnostic'); return getLock(path, options); };
    const result = await f.service.checkActions(); assert.equal(result.preflight.ready, false); assert.equal(result.preflight.checks[0].code, 'invalid_destination');
    assert.ok(!JSON.stringify(result).includes('private server diagnostic'));
    await assert.rejects(f.service.scan(true), /尚未调用 Jev/); assert.equal(f.downloads.length, 0);
    f.client.getMailboxLock = getLock; f.client.capabilities.set('X-GM-EXT-1', true);
    const list = f.client.list;
    f.client.list = async () => (await list()).map(item => item.path === 'Archive' ? { ...item, specialUse: '\\All' } : item);
    await f.service.saveConfig({ settings: { ...settings, mailboxes: ['Archive'], rules: [{ ...settings.rules[0], action: 'archive' }] } });
    const gmail = await f.service.checkActions(); assert.equal(gmail.preflight.ready, false); assert.equal(gmail.preflight.checks[0].code, 'incompatible_source');
  } finally { await f.cleanup(); }
});

test('already-set flags stay an AI action with a separate non-executable status', async () => {
  const f = await fixture(); try {
    f.original.set(42, email({ flags: ['\\Seen'] }));
    await f.service.saveConfig({ settings: { ...settings, rules: [{ ...settings.rules[0], action: 'read' }] } });
    const report = await f.service.scan(true); const row = report.records[0];
    assert.equal(row.category, 'clean'); assert.equal(row.eligible, true); assert.equal(row.action, 'read');
    assert.equal(row.execution!.state, 'noop'); assert.equal(canExecute(row), false);
    await assert.rejects(f.service.move([row.id]), /不符合执行/); assert.equal(f.flagCalls, 0);
  } finally { await f.cleanup(); }
});

test('a report without its judgment hash is never promoted or authorized from its policy hash', async () => {
  const f = await fixture(); try {
    const report = structuredClone(await f.service.scan(true)); delete report.judgmentHash;
    const row = report.records[0]; row.category = 'review'; row.eligible = false;
    row.reason = '未识别到删除的目标文件夹';
    await f.store.saveReport(report);
    const service = new MailService(f.store, () => {}, f.connect, () => { throw new Error('No paid Jev call'); }, () => now);
    const loaded = await service.loadReport();
    assert.equal(loaded!.judgmentHash, undefined); assert.equal(loaded!.records[0].category, 'review');
    await service.checkActions();
    await assert.rejects(service.move([row.id]), /重新分析/); assert.equal(f.moveCalls, 0);
  } finally { await f.cleanup(); }
});

test('changing only a mapping blocks execution until checked; new rule text still invalidates the judgment', async () => {
  const f = await fixture(); try {
    const report = await f.service.scan(true); const before = structuredClone(report.records[0].verdicts);
    await f.service.saveConfig({ settings: { ...settings, actionFolders: { trash: 'Archive' } } });
    assert.equal(report.records[0].execution!.code, 'needs_check'); await assert.rejects(f.service.move([report.records[0].id]), /不符合执行/);
    assert.equal((await f.service.checkActions()).report!.records[0].targetMailbox, 'Archive');
    assert.deepEqual(report.records[0].verdicts, before);
    await f.service.saveConfig({ settings: { ...settings, rules: settings.rules.map(rule => ({ ...rule, description: rule.description + ' 新条件' })) } });
    await f.service.checkActions(); await assert.rejects(f.service.move([report.records[0].id]), /重新分析/); assert.equal(f.moveCalls, 0);
  } finally { await f.cleanup(); }
});

test('changing move destinations reuses judgments and rebuilds newly split or merged action conflicts', async () => {
  let calls = 0; const f = await fixture(async request => { calls++; return evaluator('match', { decisions: { also: 'match' } })(request); });
  try {
    const rules = [{ ...settings.rules[0], action: 'move' as const, targetMailbox: 'Archive' }, { ...settings.rules[0], id: 'also', action: 'move' as const, targetMailbox: 'Archive' }];
    await f.service.saveConfig({ settings: { ...settings, rules } });
    const report = await f.service.scan(true); const row = report.records[0]; const count = calls;
    assert.equal(row.category, 'clean'); assert.equal(row.targetMailbox, 'Archive');
    const split = rules.map(rule => rule.id === 'also' ? { ...rule, targetMailbox: 'Junk' } : rule);
    await f.service.saveConfig({ settings: { ...settings, rules: split } });
    assert.equal(row.eligible, false); assert.equal(row.conflicts!.length, 2);
    await f.service.checkActions(); assert.deepEqual(row.conflicts!.map(choice => choice.targetMailbox), ['Archive', 'Junk']);
    await f.service.resolveConflict(row.id, 'also'); assert.equal(row.targetMailbox, 'Junk');
    const merged = split.map(rule => ({ ...rule, targetMailbox: 'Trash' }));
    await f.service.saveConfig({ settings: { ...settings, rules: merged } });
    await f.service.checkActions(); assert.equal(row.category, 'clean'); assert.equal(row.targetMailbox, 'Trash');
    assert.equal(row.conflicts, undefined); assert.equal(canExecute(row), true); assert.equal(calls, count); assert.equal(f.moveCalls, 0);
    assert.equal((await f.service.move([row.id])).moved, 1);
  } finally { await f.cleanup(); }
});
