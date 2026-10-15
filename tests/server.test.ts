import assert from 'node:assert/strict';
import { test } from 'node:test';
import { request as httpRequest } from 'node:http';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { startLocalServer } from '../src/local/server';
import { LocalLogger } from '../src/local/logger';
import { MailService } from '../src/core/service';
import { fixture } from './fixture';
import { evaluator, now, settings } from './helpers';

async function start(onShutdown?: () => void) {
  const f = await fixture(); const web = join(f.dir, 'web'); await mkdir(web); await writeFile(join(web, 'index.html'), '<h1>JevClean</h1>');
  const logger = new LocalLogger(f.dir);
  const server = await startLocalServer({ store: f.store, webDirectory: web, logger, onShutdown, createService: (emit, diagnose) => new MailService(f.store, emit, f.connect, () => evaluator(), () => now, diagnose) });
  const request = (route: string, data?: unknown, headers: Record<string, string> = {}) => fetch(server.origin + '/api/' + route, { method: data === undefined ? 'GET' : 'POST', headers: { 'X-JevClean-Token': server.token, ...(data === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers }, ...(data === undefined ? {} : { body: JSON.stringify(data) }) });
  return { ...f, ...server, logger, request, get moveCalls() { return f.moveCalls; }, cleanup: async () => { await server.close(); await logger.entries(); await f.cleanup(); } };
}
test('local HTTP rejects wrong tokens, cross-origin pages, hosts, methods and oversized inputs', async () => {
  const f = await start(); try {
    assert.equal((await f.request('bootstrap', undefined, { 'X-JevClean-Token': '' })).status, 401);
    assert.equal((await f.request('config', { settings }, { Origin: 'https://evil.example' })).status, 403);
    const wrongHost = await new Promise<number | undefined>((accept, reject) => { const req = httpRequest(f.origin + '/api/bootstrap', { headers: { Host: 'evil.example', 'X-JevClean-Token': f.token } }, res => { res.resume(); accept(res.statusCode); }); req.on('error', reject); req.end(); });
    assert.equal(wrongHost, 403);
    assert.equal((await f.request('config', { settings, extra: 'bad' })).status, 400);
    assert.equal((await f.request('config', { text: 'x'.repeat(300000) })).status, 413);
    assert.equal((await fetch(f.origin + '/api/bootstrap', { method: 'OPTIONS' })).status, 401);
    assert.equal((await fetch(f.origin + '/settings.enc')).status, 404);
    assert.equal((await fetch(f.origin + '/%2e%2e%2fsettings.enc')).status, 404);
    const page = await fetch(f.origin); assert.equal(page.status, 200); assert.match(page.headers.get('content-security-policy')!, /frame-ancestors 'none'/);
  } finally { await f.cleanup(); }
});
test('HTTP boundary carries full scan, preview, selection, move and undo without returning credentials', async () => {
  const f = await start(); try {
    const bootstrap = await (await f.request('bootstrap')).text(); assert.ok(!bootstrap.includes('test-password')); assert.ok(!bootstrap.includes('test-key'));
    const report = (await (await f.request('scan', { consent: true })).json()).value;
    assert.equal(report.records.length, 1); const id = report.records[0].id;
    const preview = (await (await f.request('preview', { id })).json()).value;
    assert.ok(preview.originalText.includes('Save 20%')); assert.ok(!preview.sentToJev.includes('?id=secret'));
    assert.equal((await f.request('execute', { ids: ['invented'] })).status, 400);
    const move = (await (await f.request('execute', { ids: [id] })).json()).value; assert.equal(move.moved, 1); assert.equal(move.canUndo, true);
    const checked = (await (await f.request('refresh-actions', {})).json()).value;
    assert.equal(checked.cleanup.moved, 1); assert.equal(checked.cleanup.checkedAt, now.toISOString());
    assert.equal(f.moveCalls, 1); assert.equal(f.downloads.length, 2); // scan and explicit preview only
    assert.equal((await f.request('refresh-actions', { ids: [id] })).status, 400);
    const latest = (await (await f.request('bootstrap')).json()).value;
    assert.equal(latest.cleanup.moved, 1); assert.equal(latest.progress.phase, 'complete');
    const restored = (await (await f.request('undo', {})).json()).value; assert.equal(restored.moved, 1); assert.equal(restored.canUndo, false);
    const logs = await f.logger.entries(); assert.ok(logs.some(log => log.event === 'actions.finished'));
    const text = JSON.stringify(logs); for (const privateValue of ['test-password', 'test-key', 'Save 20%', 'offers@example.com']) assert.ok(!text.includes(privateValue));
    const encrypted = await readFile(join(f.dir, 'report.enc')); assert.ok(!encrypted.includes(Buffer.from('A special offer')));
  } finally { await f.cleanup(); }
});
test('authenticated action preflight returns folder choices and refreshes execution state without exposing secrets', async () => {
  const f = await start(); try {
    const scanned = (await (await f.request('scan', { consent: true })).json()).value;
    f.folders.delete('Trash');
    assert.equal((await f.request('check-actions', { extra: true })).status, 400);
    assert.equal((await f.request('check-actions', {}, { 'X-JevClean-Token': '' })).status, 401);
    const response = await f.request('check-actions', {}); assert.equal(response.status, 200);
    const text = await response.text(); assert.ok(!text.includes('test-password')); assert.ok(!text.includes('test-key'));
    const value = JSON.parse(text).value;
    assert.equal(value.preflight.ready, false); assert.equal(value.preflight.checks[0].code, 'missing_destination');
    assert.equal(value.report.id, scanned.id); assert.equal(value.report.records[0].category, 'clean');
    assert.equal(value.report.records[0].execution.state, 'blocked'); assert.equal(value.report.apiCalls, scanned.apiCalls);
    assert.equal(f.moveCalls, 0);
  } finally { await f.cleanup(); }
});
test('manual HTTP routes require a checked explicit action and never accept AI evidence or arbitrary commands', async () => {
  const f = await start(); try {
    await f.service.forgetCredentials(); await f.service.saveConfig({ settings, imapPassword: 'mail-only' });
    assert.equal((await f.request('read-mail', { url: 'https://example.com' })).status, 400);
    const read = (await (await f.request('read-mail', {})).json()).value; const id = read.records[0].id;
    assert.equal(read.records[0].category, 'unclassified'); assert.equal(read.apiCalls, 0); assert.equal(f.downloads.length, 0);
    for (const input of [{ ids: [id], action: 'keep' }, { ids: [id], action: 'expunge' }, { ids: [id], action: 'delete', probability: 1 }, { ids: [id, id], action: 'read' }, { ids: ['forged'], action: 'delete' }]) assert.equal((await f.request('manual-check', input)).status, 400);
    assert.equal((await f.request('manual-check', { ids: [id], action: 'read' }, { 'X-JevClean-Token': '' })).status, 401);
    assert.equal((await f.request('manual-execute', { ids: [id], action: 'read' })).status, 400);
    assert.equal((await f.request('action-folders', { trash: 'Trash', url: 'http://evil.example' })).status, 400);
    const plan = (await (await f.request('manual-check', { ids: [id], action: 'delete' })).json()).value;
    assert.equal(plan.ready, true); assert.equal(f.moveCalls, 0);
    const done = (await (await f.request('manual-execute', { planId: plan.id })).json()).value;
    assert.equal(done.moved, 1); assert.equal(done.report.records[0].category, 'unclassified'); assert.equal(done.report.records[0].operation.source, 'manual');
    assert.equal((await f.request('manual-execute', { planId: plan.id })).status, 400);
    assert.equal(f.moveCalls, 1); assert.equal(f.downloads.length, 0);
    assert.equal((await f.request('undo', {})).status, 200);
    const log = JSON.stringify(await f.logger.entries()); for (const value of ['mail-only', 'test-key', 'offers@example.com', 'Save 20%']) assert.ok(!log.includes(value));
  } finally { await f.cleanup(); }
});
test('logs cap their size and exclude non-allowlisted data', async () => {
  const f = await start(); try {
    const logger = new LocalLogger(f.dir, 100);
    for (let i = 0; i < 6; i++) logger.record('test.synthetic', { processed: i, password: 'do-not-save', subject: 'private-mail' });
    await logger.entries();
    const content = await readFile(join(f.dir, 'operations.log'), 'utf8'); assert.ok(content.length < 300); assert.ok(!content.includes('do-not-save'));
    assert.ok(!(await readFile(join(f.dir, 'operations.log.1'), 'utf8')).includes('private-mail'));
  } finally { await f.cleanup(); }
});
test('shutdown invokes the process lifecycle only when idle and refuses to interrupt a running operation', async () => {
  let called = 0; const f = await start(() => { called++; });
  try {
    let release!: () => void;
    const operation = f.service.exclusive(() => new Promise<void>(resolve => { release = resolve; }));
    assert.equal((await f.request('shutdown', {})).status, 400);
    assert.equal(called, 0);
    release(); await operation;
    assert.equal((await f.request('shutdown', {})).status, 200);
    await new Promise(resolve => setTimeout(resolve, 150));
    assert.equal(called, 1);
  } finally { await f.cleanup(); }
});

test('analysis autosave persists only preferences, preserves credentials and rejects unknown rules and extra fields', async () => {
  const f = await start(); try {
    const before = await f.store.config();
    const original = await f.store.publicConfig();
    assert.equal((await f.request('analysis-settings', { email: 'other@example.com' })).status, 400);
    assert.equal((await f.request('analysis-settings', { enabledRules: ['unknown_rule'] })).status, 400);
    assert.equal((await f.request('analysis-settings', { scanLimit: 0 })).status, 400);
    assert.equal((await f.request('analysis-settings', {}, { 'X-JevClean-Token': '' })).status, 401);
    const saved = (await (await f.request('analysis-settings', { analysisConsent: true })).json()).value;
    assert.equal(saved.policyHash, original.policyHash);
    assert.equal(saved.judgmentHash, original.judgmentHash);
    const next = await f.request('analysis-settings', { mailboxes: [], enabledRules: [before.settings.rules[0].id], scanLimit: 1 });
    assert.equal(next.status, 200);
    const after = await f.store.config();
    assert.equal(after.settings.analysisConsent, true); assert.deepEqual(after.settings.mailboxes, []);
    assert.equal(after.settings.scanLimit, 1); assert.equal(after.settings.rules.filter(r => r.enabled).length, 1);
    assert.deepEqual(after.settings.rules.map(r => r.description), before.settings.rules.map(r => r.description));
    assert.deepEqual(after.secrets, before.secrets); assert.equal(after.settings.email, before.settings.email);
    assert.equal((await f.request('scan', { consent: true })).status, 400);
    assert.equal(f.downloads.length, 0); assert.equal(f.moveCalls, 0);
    await f.request('analysis-settings', { analysisConsent: false });
    assert.equal((await f.store.config()).settings.analysisConsent, false);
  } finally { await f.cleanup(); }
});

test('menu runtime returns sanitized state and the live lock even before a task emits progress', async () => {
  const f = await start(); try {
    assert.equal((await f.request('runtime', undefined, { 'X-JevClean-Token': '' })).status, 401);
    let release!: () => void;
    const running = f.service.exclusive(() => new Promise<void>(resolve => { release = resolve; }));
    const value = (await (await f.request('runtime')).json()).value;
    assert.deepEqual(value, { phase: 'idle', processed: 0, total: 0, busy: true, language: 'zh-CN' });
    assert.equal((await f.request('shutdown', {})).status, 400);
    release(); await running;
    const idle = await (await f.request('runtime')).text();
    assert.equal(JSON.parse(idle).value.busy, false);
    for (const secret of ['test-password', 'test-key', settings.email, 'records', 'report', 'subject']) assert.ok(!idle.includes(secret));
  } finally { await f.cleanup(); }
});

test('analysis trace routes are authenticated, scoped to a saved record and do not read mail or clear undo', async () => {
  const f = await start(); try {
    await f.request('config', { settings: { ...settings, detailedDiagnostics: true } });
    const report = (await (await f.request('scan', { consent: true })).json()).value;
    const id = report.records[0].id; const downloads = f.downloads.length;
    assert.equal((await f.request('analysis-trace', { reportId: report.id, id }, { 'X-JevClean-Token': '' })).status, 401);
    assert.equal((await f.request('analysis-trace', { reportId: '../settings.enc', id })).status, 400);
    assert.equal((await f.request('analysis-trace', { reportId: report.id, id: 'unknown' })).status, 400);
    const trace = (await (await f.request('analysis-trace', { reportId: report.id, id })).json()).value;
    assert.ok(trace.requestText); assert.ok(trace.attempts[0].responseText);
    assert.equal(f.downloads.length, downloads);
    const bootstrap = await (await f.request('bootstrap')).text();
    assert.ok(!bootstrap.includes('requestText')); assert.ok(!bootstrap.includes('responseText'));
    assert.equal((await f.request('retry-analysis', { reportId: report.id, ids: [id], consent: true })).status, 400);
    await f.request('execute', { ids: [id] });
    assert.equal((await f.request('clear-analysis-traces', { extra: true })).status, 400);
    assert.equal((await f.request('clear-analysis-traces', {})).status, 200);
    assert.equal((await (await f.request('analysis-trace', { reportId: report.id, id })).json()).value, null);
    assert.equal((await (await f.request('bootstrap')).json()).value.canUndo, true);
    assert.equal((await f.request('undo', {})).status, 200);
  } finally { await f.cleanup(); }
});

test('operation diagnostics explain automatic verification using only fixed reasons, counts and timing', async () => {
  const f = await start(); try {
    const scan = (await (await f.request('scan', { consent: true })).json()).value;
    f.omitReceipt();
    const result = (await (await f.request('execute', { ids: [scan.records[0].id] })).json()).value;
    assert.equal(result.moved, 1); assert.equal(result.uncertain, 0); assert.equal(f.moveCalls, 1);
    const logs = await f.logger.entries();
    assert.equal(logs.find(entry => entry.event === 'actions.confirmation-needed')!.details.reasonCode, 'move_receipt_incomplete');
    assert.equal(logs.find(entry => entry.event === 'actions.verification-finished')!.details.uncertain, 0);
    f.logger.record('actions.verification-failed', { reasonCode: 'PRIVATE subject', durationMs: 'PRIVATE key', subject: 'PRIVATE body' });
    assert.deepEqual((await f.logger.entries()).at(-1)!.details, {});
    const text = JSON.stringify(await f.logger.entries());
    for (const secret of ['PRIVATE', 'test-password', 'test-key', 'offers@example.com', 'Save 20%']) assert.ok(!text.includes(secret));
  } finally { await f.cleanup(); }
});
