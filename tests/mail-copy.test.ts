import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fixture } from './fixture';
import { MailService } from '../src/core/service';
import { now } from './helpers';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { MailRecord } from '../src/shared/contracts';
import { MailList } from '../src/renderer/MailList';
import { ManualPanel } from '../src/renderer/ManualPanel';
import { cleanupMessage, completedMessage, inResultFilter, judgmentBadge, judgmentLabel, judgmentMessage, operationPending, operationProgressCopy, operationState, recordState, selectionButton, userDiagnostic } from '../src/renderer/mail-copy';

test('result categories retain AI judgments across processing states and include unclassified mail in review', async () => {
  const f = await fixture(); try {
    const scan = await f.service.scan(true); const record = scan.records[0];
    const original = JSON.stringify(record);
    const blocked = { ...record, execution: { state: 'blocked' as const, code: 'missing_destination' as const } };
    assert.equal(inResultFilter(blocked, 'clean'), true); assert.equal(inResultFilter(blocked, 'review'), false);
    assert.equal(recordState(blocked, 'zh-CN'), '待选位置');
    assert.match(judgmentMessage(blocked, 'zh-CN'), /符合/);
    assert.match(completedMessage(blocked, 'en'), /Choose where/);
    for (const status of ['moved', 'restored', 'uncertain'] as const) assert.equal(inResultFilter({ ...record, status }, 'clean'), true);
    assert.equal(inResultFilter({ ...record, execution: { state: 'noop' } }, 'clean'), true);
    assert.equal(inResultFilter({ ...record, category: 'unclassified' }, 'review'), true);
    const conflict = { ...record, conflicts: [{ id: 'read', action: 'read' as const, ruleIds: [], confidence: .99, probability: .99 }], selectedConflict: undefined };
    assert.equal(inResultFilter(conflict, 'review'), true); assert.equal(inResultFilter(conflict, 'clean'), false);
    const resolved = { ...conflict, selectedConflict: 'read', action: 'read' as const };
    assert.equal(inResultFilter(resolved, 'clean'), true); assert.equal(inResultFilter(resolved, 'review'), false);
    assert.equal(recordState(resolved, 'zh-CN'), '未处理');
    assert.equal(JSON.stringify(record), original);
  } finally { await f.cleanup(); }
});

test('completed summary reads recorded destinations across setting changes and restarts; undo removes completion counts', async () => {
  const f = await fixture(); try {
    const scan = await f.service.scan(true); await f.service.move([scan.records[0].id]);
    const initial = (await f.service.cleanupSummary())!;
    assert.deepEqual(initial.destinations, [{ action: 'delete', path: 'Trash', count: 1 }]);
    assert.equal(cleanupMessage(initial, 'en'), 'Moved 1 email to “Trash”.');
    const config = await f.store.config();
    await f.service.saveConfig({ settings: { ...config.settings, actionFolders: { trash: 'Archive' } } });
    const restarted = new MailService(f.store, () => {}, f.connect, () => { throw new Error('No paid calls'); }, () => now);
    assert.deepEqual((await restarted.cleanupSummary())!.destinations, initial.destinations);
    await restarted.undo();
    assert.equal(cleanupMessage((await restarted.cleanupSummary())!, 'zh-CN'), '已撤销最近整理，共 1 封邮件。');
    assert.deepEqual((await restarted.cleanupSummary())!.destinations, []);
  } finally { await f.cleanup(); }
});

test('unknown outcomes never claim failure or no mailbox change; mixed results omit zero counts', () => {
  const summary = { total: 3, moved: 1, restored: 0, failed: 1, uncertain: 1 };
  const copy = cleanupMessage(summary, 'zh-CN');
  assert.match(copy, /1 封邮件 结果待查/); assert.doesNotMatch(copy, /0 封|全部成功|已删除/);
  assert.match(userDiagnostic('操作已结束，自动核对未完成。请点击“核对操作结果”，请勿重复执行。', 'en'), /before processing again/);
  assert.doesNotMatch(userDiagnostic('操作未完成，请检查本地服务、邮箱连接和系统凭据库。', 'zh-CN'), /无法读取/);
  assert.equal(userDiagnostic('我的规则：无法连接 Jev', 'zh-CN', ['无法连接 Jev']), '我的规则：无法连接 Jev');
});

test('verification copy keeps the operation count distinct from folder entries and preserves literal folder names', () => {
  const progress = { phase: 'checking' as const, processed: 0, total: 2, operationTotal: 9,
    folderCheck: { mailbox: '收件箱/保留', processed: 200, total: 1497 } };
  const original = JSON.stringify(progress);
  const zh = operationProgressCopy(progress, 'zh-CN');
  assert.equal(zh.message, '正在核对 9 封邮件 的结果');
  assert.equal(zh.detail, '检查「收件箱/保留」：200 / 1497 条');
  assert.match(zh.hint!, /不改其他邮件/);
  assert.doesNotMatch(zh.message, /200|1497|已完成/);
  const en = operationProgressCopy(progress, 'en');
  assert.equal(en.message, 'Checking the organization results for 9 emails');
  assert.equal(en.detail, 'Checking the email list in “收件箱/保留”: 200 / 1497 entries');
  assert.equal(operationProgressCopy({ phase: 'checking', processed: 1, total: 2, operationTotal: 9 }, 'en').detail, 'Checked 1 / 2 emails');
  assert.equal(operationProgressCopy({ phase: 'moving', processed: 3, total: 9 }, 'zh-CN').message, '整理中，已处理 3 / 9 封');
  assert.equal(JSON.stringify(progress), original);
});

test('privacy-safe display preserves user names and paths, formats complete English sentences and keeps actions distinct', async () => {
  const f = await fixture(); try {
    const record = (await f.service.scan(true)).records[0];
    record.verdicts[0].name = '保留/「已删除」'; record.matchedRules = [record.verdicts[0].id];
    assert.match(judgmentMessage(record, 'en'), /保留\/「已删除」/);
    assert.equal(selectionButton([record], 'en'), 'Delete');
    assert.equal(selectionButton([record, { ...record, action: 'read' }], 'en'), 'Process emails');
    assert.equal(recordState({ ...record, status: 'moved', destinationPath: '已删除' }, 'zh-CN'), '已移到「已删除」');
    assert.equal(recordState({ ...record, status: 'uncertain' }, 'zh-CN'), '结果待查');
  } finally { await f.cleanup(); }
});

test('AI labels and color never change when manual operations complete, fail or become uncertain', async () => {
  const f = await fixture(); try {
    const source = (await f.service.scan(true)).records[0];
    for (const category of ['clean', 'keep', 'review', 'unclassified'] as const) {
      const record = { ...source, category };
      const label = judgmentLabel(record, 'zh-CN');
      const badge = judgmentBadge(record);
      for (const status of ['moved', 'restored', 'failed', 'uncertain'] as const) {
        const operated = { ...record, status, operation: { source: 'manual' as const, action: 'move' as const }, destinationPath: 'Archive' };
        assert.equal(judgmentLabel(operated, 'zh-CN'), label);
        assert.equal(judgmentBadge(operated), badge);
      }
      assert.equal(operationState({ ...record, status: 'pending' }, 'zh-CN'), '未处理');
      assert.equal(operationState({ ...record, status: 'failed' }, 'zh-CN'), '未成功');
    }
  } finally { await f.cleanup(); }
});

test('mail reading keeps raw email text inert and remains available outside a filtered row collection', async () => {
  const f = await fixture(); try {
    const source = (await f.service.scan(true)).records[0];
    const record: MailRecord = { ...source, subject: '<strong>完整邮件主题</strong>', category: 'review', status: 'moved',
      operation: { source: 'manual', action: 'move' }, destinationPath: 'Archive' };
    const inert = '<script>alert("mail")</script><img src="https://untrusted.example/image">';
    const markup = renderToStaticMarkup(createElement(MailList, {
      records: [], previewRecord: record, selected: [record.id], busy: false, stale: false,
      preview: { id: record.id, value: { subject: record.subject, originalText: inert, sentToJev: 'Original model request' } },
      emptyText: '当前查找没有结果', emptyHint: '修改查找内容',
      onSelect: () => {}, onPreview: () => {}, onClosePreview: () => {}, onConflict: () => {}, onConfigure: () => {}, onRules: () => {}, onRefresh: () => {},
    }));
    assert.match(markup, /mail-preview mail-reading-pane/);
    assert.match(markup, /action-badge review/);
    assert.match(markup, /已移到「Archive」/);
    assert.match(markup, /&lt;script&gt;alert/);
    assert.match(markup, /&lt;strong&gt;完整邮件主题/);
    assert.doesNotMatch(markup, /<script|<img|role="listitem"/);
    assert.match(markup, /判断原因/);
    assert.match(markup, /Original model request/);
    assert.match(markup, /修改查找内容/);
    assert.doesNotMatch(markup, /调整规则后重新分析/);
  } finally { await f.cleanup(); }
});

test('manual confirmation lists actual selected messages and individual server-check outcomes without rewriting AI evidence', async () => {
  const f = await fixture(); try {
    const source = (await f.service.scan(true)).records[0];
    const records: MailRecord[] = [
      { ...source, id: 'ready-mail', subject: '可移动邮件', category: 'keep' },
      { ...source, id: 'noop-mail', subject: '已到目标的邮件' },
      { ...source, id: 'blocked-mail', subject: '位置待检查的邮件', category: 'review' },
    ];
    const before = JSON.stringify(records);
    const markup = renderToStaticMarkup(createElement(ManualPanel, {
      language: 'zh-CN', action: 'move', selectedCount: 3, records, target: 'Archive/保留', folders: [], busy: false,
      plan: { id: 'checked-plan', action: 'move', ready: false, folders: [], destinations: [{ path: 'Archive/保留', count: 1 }],
        checks: [{ id: 'ready-mail', state: 'ready', targetMailbox: 'Archive/保留' },
          { id: 'noop-mail', state: 'noop', reason: '邮件已是所需状态，无需再次处理。' },
          { id: 'blocked-mail', state: 'blocked', reason: '文件夹无法打开，请刷新后重选。' }] },
      onTarget: () => {}, onCheck: () => {}, onExecute: () => {}, onCancel: () => {},
    }));
    for (const record of records) assert.ok(markup.includes(record.subject));
    assert.match(markup, /移动到「Archive\/保留」/);
    assert.match(markup, /准备处理<\/dt><dd>1 封邮件/);
    assert.match(markup, /无需处理<\/dt><dd>1 封邮件/);
    assert.match(markup, /无法处理<\/dt><dd>1 封邮件/);
    assert.match(markup, /无需再次处理/);
    assert.match(markup, /请刷新后重选/);
    assert.doesNotMatch(markup, /确认手动处理 1 封邮件/);
    assert.equal(JSON.stringify(records), before);
  } finally { await f.cleanup(); }
});

// An explicit choice among tied actions must never be described as an automatic priority decision.
test('priority explanation distinguishes automatic ranking from a user-resolved tie', async () => {
  const f = await fixture(); try {
    const record = (await f.service.scan(true)).records[0];
    const multi = { ...record, verdicts: [...record.verdicts, { ...record.verdicts[0], id: 'read-rule', action: 'read' as const, decision: 'match' as const }] };
    assert.match(judgmentMessage(multi, 'zh-CN'), /优先采用删除/);
    assert.match(judgmentMessage(multi, 'en'), /Priority selects: Delete/);
    assert.doesNotMatch(judgmentMessage({ ...multi, selectedConflict: record.matchedRules[0] }, 'zh-CN'), /优先采用/);
  } finally { await f.cleanup(); }
});

test('only unresolved rows in the active operation show neutral progress, with terminal reasons preserved', async () => {
  const f = await fixture(); try {
    const row = { ...(await f.service.scan(true)).records[0], status: 'uncertain' as const, lastOperation: 'move' as const, error: '找到重复邮件或多个位置，无法确认本次操作，请在邮件 App 中核对。' };
    const checking = { phase: 'checking' as const, processed: 0, total: 1, operationIds: [row.id] };
    const original = structuredClone(row);
    assert.equal(operationPending(row, checking), true);
    assert.equal(operationState(row, 'zh-CN', checking), '核对中');
    assert.equal(operationState(row, 'en', checking), 'Checking results');
    assert.equal(completedMessage(row, 'zh-CN', checking), '正在核对邮箱里的结果，请稍候。');
    assert.equal(operationState({ ...row, lastOperation: 'restore' }, 'zh-CN', checking), '核对撤销');
    assert.equal(operationState(row, 'zh-CN', { ...checking, phase: 'moving' }), '处理中');
    assert.equal(operationState(row, 'zh-CN', { ...checking, phase: 'restoring' }), '撤销中');
    assert.equal(operationPending(row, { ...checking, phase: 'scanning' }), false);
    assert.equal(operationPending({ ...row, id: 'another-operation' }, checking), false);
    assert.equal(operationState({ ...row, id: 'another-operation' }, 'zh-CN', checking), '结果待查');
    assert.equal(operationState(row, 'zh-CN', { ...checking, phase: 'complete' }), '结果待查');
    assert.match(completedMessage(row, 'en'), /Duplicate messages or multiple locations/);
    assert.equal(operationState({ ...row, status: 'moved', destinationPath: 'Trash' }, 'zh-CN', checking), '已移到「Trash」');
    assert.deepEqual(row, original);
  } finally { await f.cleanup(); }
});
