import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MailService } from '../src/core/service';
import { createEvaluator, JevError } from '../src/core/jev';
import { canRetryAnalysis } from '../src/shared/contracts';
import { fixture } from './fixture';
import { email, evaluator, now, settings } from './helpers';

test('analysis records retain immutable basic evidence without body context; full traces are opt-in and offline', async () => {
  const f = await fixture();
  try {
    const privateText = 'PRIVATE body context outside selected calendar evidence';
    f.original.set(42, email({ text: privateText + ' 2026-09-15 ' + privateText }));
    const first = await f.service.scan(true);
    assert.equal(first.records[0].analysis?.version, 8);
    assert.ok(!JSON.stringify(first).includes(privateText));
    assert.equal(await f.service.analysisTrace(first.id, first.records[0].id), null);
    await f.service.saveConfig({ settings: { ...settings, detailedDiagnostics: true } });
    const report = await f.service.scan(true); const row = report.records[0];
    const evidence = structuredClone(row.analysis);
    const trace = await f.service.analysisTrace(report.id, row.id);
    assert.ok(trace?.requestText.includes(privateText));
    assert.ok(trace?.attempts[0].responseText);
    assert.ok(!JSON.stringify(report).includes(privateText));
    assert.ok(!JSON.stringify(report).includes('responseText'));
    await f.service.saveConfig({ settings: { ...settings, detailedDiagnostics: true, rules: settings.rules.map(rule => ({ ...rule, description: 'Changed rule' })) } });
    assert.deepEqual((await f.service.loadReport())!.records[0].analysis, evidence);
    const offline = new MailService(f.store, () => {}, async () => { throw new Error('must not connect'); }, () => { throw new Error('must not call Jev'); }, () => now);
    assert.deepEqual(await offline.analysisTrace(report.id, row.id), trace);
    await offline.clearAnalysisTraces();
    assert.equal(await offline.analysisTrace(report.id, row.id), null);
    assert.deepEqual((await offline.loadReport())!.records[0].analysis, evidence);
  } finally { await f.cleanup(); }
});

test('configured rules can start analysis without a migration acknowledgement', async () => {
  let calls = 0; const f = await fixture(async request => { calls++; return evaluator()(request); });
  try {
    await f.store.saveConfig({ settings });
    assert.equal((await f.service.scan(true)).records[0].category, 'clean');
    assert.equal(calls, 1); assert.ok(f.downloads.length > 0);
    assert.equal(Object.hasOwn((await f.store.config()).settings, 'ruleSemantics'), false);
  } finally { await f.cleanup(); }
});

test('fatal and invalid Jev responses remain available without leaking raw bodies into bootstrap records', async () => {
  const f = await fixture();
  try {
    await f.store.saveConfig({ settings: { ...settings, detailedDiagnostics: true } });
    const privateResponse = 'private provider response';
    const factory: typeof createEvaluator = (key, _transport, observer) => createEvaluator(key, async () => new Response(privateResponse, { status: 402 }), observer);
    const service = new MailService(f.store, () => {}, f.connect, factory, () => now);
    const report = await service.scan(true); const row = report.records[0];
    assert.equal(report.status, 'failed'); assert.equal(row.category, 'review');
    assert.equal(row.analysis!.attempts[0].httpStatus, 402);
    assert.equal(row.analysis!.attempts[0].status, 'failed');
    assert.ok(canRetryAnalysis(row));
    assert.ok(!JSON.stringify(report).includes(privateResponse));
    assert.equal((await service.analysisTrace(report.id, row.id))!.attempts[0].responseText, privateResponse);
    assert.equal(f.moveCalls, 0);
  } finally { await f.cleanup(); }
});

test('only failed unchanged mail can be retried and attempts are appended without another success call', async () => {
  let fail = true; let calls = 0;
  const f = await fixture(async request => { calls++; if (fail && (request.state as { email: { subject: string } }).email.subject === 'retry-me') throw new JevError('无法连接 Jev。', false, 'network'); return evaluator()(request); });
  try {
    f.original.set(43, email({ uid: 43, messageId: '<43@example.com>', subject: 'retry-me' }));
    await f.service.saveConfig({ settings: { ...settings, detailedDiagnostics: true } });
    const report = await f.service.scan(true); const row = report.records.find(record => record.subject === 'retry-me')!;
    assert.equal(calls, 2); assert.ok(canRetryAnalysis(row));
    const successful = structuredClone(report.records.find(record => record.id !== row.id)!);
    fail = false;
    const retried = await f.service.retryAnalysis(report.id, [row.id], true);
    assert.equal(calls, 3); assert.equal(retried.records.find(record => record.id === row.id)!.category, 'clean');
    assert.equal(row.analysis!.attempts.length, 2);
    assert.deepEqual(row.analysis!.attempts.map(attempt => attempt.status), ['failed', 'succeeded']);
    assert.deepEqual(row.analysis!.attempts.map(attempt => attempt.attempt), [1, 2]);
    assert.deepEqual(retried.records.find(record => record.id === successful.id), successful);
    assert.equal((await f.service.analysisTrace(report.id, row.id))!.attempts.length, 2);
    await assert.rejects(f.service.retryAnalysis(report.id, [row.id], true), /只能重试/);
    assert.equal(f.moveCalls, 0); assert.equal(f.flagCalls, 0);
  } finally { await f.cleanup(); }
});

test('changed mail body and changed rules cannot reuse failed analysis authorization', async () => {
  let calls = 0; const f = await fixture(async () => { calls++; throw new JevError('无法连接 Jev。', false, 'network'); });
  try {
    const report = await f.service.scan(true); const row = report.records[0];
    f.original.get(42)!.text = 'Changed body under the same headers';
    const rejected = await f.service.retryAnalysis(report.id, [row.id], true);
    assert.match(rejected.error!, /内容或状态已改变/); assert.equal(calls, 1);
    await f.service.saveConfig({ settings: { ...settings, scanLimit: 99 } });
    await assert.rejects(f.service.retryAnalysis(report.id, [row.id], true), /规则、账号或范围/);
    assert.equal(calls, 1);
  } finally { await f.cleanup(); }
});

test('failure to persist the initial evidence prevents all Jev calls', async () => {
  let calls = 0; const f = await fixture(async request => { calls++; return evaluator()(request); });
  try {
    const save = f.store.saveReport.bind(f.store);
    let count = 0;
    f.store.saveReport = report => { if (++count === 2) return Promise.reject(new Error('disk full')); return save(report); };
    const report = await f.service.scan(true);
    assert.equal(report.status, 'failed'); assert.equal(calls, 0);
    assert.match(report.error!, /保存本次调用记录/);
  } finally { await f.cleanup(); }
});

test('retry after destination change preserves original rule snapshot but plans the newly configured target', async () => {
  let fail = true; const f = await fixture(async request => { if (fail) throw new JevError('无法连接 Jev。', false, 'network'); return evaluator()(request); });
  try {
    const initial = { ...settings, rules: [{ ...settings.rules[0], action: 'move' as const, targetMailbox: 'Archive' }] };
    await f.service.saveConfig({ settings: initial });
    const report = await f.service.scan(true); const row = report.records[0]; const snapshot = structuredClone(row.analysis!);
    await f.service.saveConfig({ settings: { ...initial, rules: [{ ...initial.rules[0], targetMailbox: 'Junk' }] } });
    fail = false;
    await f.service.retryAnalysis(report.id, [row.id], true);
    assert.equal(row.targetMailbox, 'Junk');
    assert.deepEqual(row.analysis!.rules, snapshot.rules); assert.deepEqual(row.analysis!.questions, snapshot.questions);
    assert.equal(row.analysis!.attempts.length, 2);
  } finally { await f.cleanup(); }
});

test('enabling detailed traces after a failed call captures only the retry without discarding basic history', async () => {
  let fail = true; const f = await fixture(async request => { if (fail) throw new JevError('无法连接 Jev。', false, 'network'); return evaluator()(request); });
  try {
    const report = await f.service.scan(true); const row = report.records[0];
    await f.service.clearAnalysisTraces();
    await f.service.saveConfig({ settings: { ...settings, detailedDiagnostics: true } });
    fail = false;
    await f.service.retryAnalysis(report.id, [row.id], true);
    const trace = (await f.service.analysisTrace(report.id, row.id))!;
    assert.equal(trace.attempts.length, 2);
    assert.equal(trace.attempts[0].responseText, undefined);
    assert.ok(trace.attempts[1].responseText);
    assert.equal(trace.expiresAt, new Date(now.getTime() + 7 * 86400000).toISOString());
  } finally { await f.cleanup(); }
});
