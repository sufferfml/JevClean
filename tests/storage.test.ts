import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, open, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DIAGNOSTICS_MAX_BYTES, DIAGNOSTICS_RETENTION_MS, DiagnosticsStorageError, LocalStore } from '../src/core/storage';
import { email, settings, testCipher } from './helpers';
import { canRetryAnalysis, settingsSchema } from '../src/shared/contracts';
import type { AnalysisTrace, MailRecord, ScanReport } from '../src/shared/contracts';
import { policyHash } from '../src/core/rules';

test('keys persist encrypted, are not returned to the UI, and files are private', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'jevclean-store-'));
  try {
    const store = new LocalStore(dir, testCipher());
    const result = await store.saveConfig({ settings, imapPassword: 'imap-test-only-secret', jevApiKey: 'jev-test-only-secret' });
    const saved = await readFile(join(dir, 'settings.enc'));
    assert.ok(!saved.includes(Buffer.from('imap-test-only-secret'))); assert.ok(!saved.includes(Buffer.from('jev-test-only-secret')));
    assert.ok(!JSON.stringify(result).includes('test-only-secret'));
    assert.equal((await store.config()).secrets.jevApiKey, 'jev-test-only-secret');
    assert.equal((await stat(join(dir, 'settings.enc'))).mode & 0o777, 0o600);
    await store.saveConfig({ settings: { ...settings, mailboxes: ['INBOX', 'Archive'] } });
    assert.equal((await store.config()).secrets.imapPassword, 'imap-test-only-secret');
    await store.forgetCredentials(); assert.equal((await store.publicConfig()).hasJevApiKey, false);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
test('saved rule text and ordering are retained exactly without preset upgrades', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'jevclean-rules-'));
  try {
    const cipher = testCipher(); const store = new LocalStore(dir, cipher);
    const rules = [
      { id: 'promotions', name: '广告推广', enabled: false, action: 'delete' as const, description: '清理以促销、推销为主要目的的广告邮件；保留订单确认、付款记录和需要处理的售后邮件。' },
      { id: 'custom_jobs', name: '职位推荐', enabled: true, action: 'archive' as const, description: '归档旧的职位推荐。' },
    ];
    await store.saveConfig({ settings: { ...settings, rules } });
    const before = await readFile(join(dir, 'settings.enc'));
    assert.deepEqual((await store.config()).settings.rules, rules);
    assert.deepEqual(await readFile(join(dir, 'settings.enc')), before);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
test('empty and duplicate folder selections are rejected', () => {
  assert.equal(settingsSchema.safeParse({ ...settings, mailboxes: [] }).success, true); // A saved empty selection is valid; starting analysis still requires a folder.
  assert.equal(settingsSchema.safeParse({ ...settings, mailboxes: ['INBOX', 'INBOX'] }).success, false);
});
test('scan count accepts all or a positive safe integer and defaults to 100', () => {
  for (const scanLimit of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, Infinity, '100']) {
    assert.equal(settingsSchema.safeParse({ ...settings, scanLimit }).success, false);
  }
  for (const scanLimit of [null, 1, 100, 1500]) assert.equal(settingsSchema.parse({ ...settings, scanLimit }).scanLimit, scanLimit);
  const { scanLimit: _limit, ...withoutLimit } = settings;
  assert.equal(settingsSchema.parse(withoutLimit).scanLimit, 100);
});
test('changing account never reuses another account IMAP password', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'jevclean-store-'));
  try {
    const store = new LocalStore(dir, testCipher());
    await store.saveConfig({ settings, imapPassword: 'fake-password', jevApiKey: 'fake-key' });
    await store.saveConfig({ settings: { ...settings, email: 'another@example.com' } });
    assert.equal((await store.config()).secrets.imapPassword, '');
    assert.equal((await store.config()).secrets.jevApiKey, 'fake-key');
  } finally { await rm(dir, { recursive: true, force: true }); }
});
test('unavailable OS encryption refuses to persist instead of falling back to plaintext', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'jevclean-store-'));
  try {
    const store = new LocalStore(dir, { ...testCipher(), available: async () => false });
    await assert.rejects(store.saveConfig({ settings, imapPassword: 'fake', jevApiKey: 'fake' }), /不会明文/);
    assert.deepEqual(await readdir(dir), []);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

const diagnosticsReportId = '12345678-1234-4234-8234-123456789abc';
const diagnosticsNow = new Date('2026-10-08T00:00:00Z');
function trace(reportId = diagnosticsReportId, suffix = '0:123'): AnalysisTrace {
  return { reportId, recordId: reportId + ':' + suffix, createdAt: diagnosticsNow.toISOString(),
    expiresAt: new Date(diagnosticsNow.getTime() + DIAGNOSTICS_RETENTION_MS).toISOString(),
    requestText: '{"state":"private synthetic mail text"}',
    attempts: [{ attempt: 1, startedAt: diagnosticsNow.toISOString(), status: 'succeeded', responseText: '{"private":"synthetic answer"}' }] };
}
test('full traces remain encrypted, private and readable offline after restarting the store', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'jevclean-diagnostics-'));
  try {
    const cipher = testCipher(); const store = new LocalStore(dir, cipher); const value = trace();
    await store.startDiagnostics(value.reportId, diagnosticsNow); await store.saveTrace(value);
    const files = await readdir(join(dir, 'diagnostics')); assert.equal(files.length, 2);
    for (const file of files) {
      const saved = await readFile(join(dir, 'diagnostics', file));
      assert.ok(!saved.includes(Buffer.from('private synthetic mail text'))); assert.ok(!saved.includes(Buffer.from('synthetic answer')));
      assert.equal((await stat(join(dir, 'diagnostics', file))).mode & 0o777, 0o600);
    }
    assert.equal((await stat(join(dir, 'diagnostics'))).mode & 0o777, 0o700);
    assert.deepEqual(await new LocalStore(dir, cipher).loadTrace(value.reportId, value.recordId, diagnosticsNow), value);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
test('only the latest batch is retained, expired traces disappear and undo evidence survives both', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'jevclean-diagnostics-'));
  try {
    const cipher = testCipher(); const store = new LocalStore(dir, cipher); const first = trace();
    const undo = await cipher.encrypt('synthetic undo evidence'); await writeFile(join(dir, 'last-action.enc'), undo);
    await store.startDiagnostics(first.reportId, diagnosticsNow); await store.saveTrace(first);
    const second = trace('87654321-1234-4234-8234-123456789abc');
    await store.startDiagnostics(second.reportId, diagnosticsNow); await store.saveTrace(second);
    assert.equal(await store.loadTrace(first.reportId, first.recordId, diagnosticsNow), null);
    await assert.rejects(store.saveTrace(first), error => error instanceof DiagnosticsStorageError && error.code === 'diagnostics_batch');
    assert.deepEqual(await store.loadTrace(second.reportId, second.recordId, new Date(diagnosticsNow.getTime() + DIAGNOSTICS_RETENTION_MS - 1)), second);
    assert.equal(await store.loadTrace(second.reportId, second.recordId, new Date(diagnosticsNow.getTime() + DIAGNOSTICS_RETENTION_MS)), null);
    assert.deepEqual(await readFile(join(dir, 'last-action.enc')), undo);
    assert.deepEqual(await readdir(dir), ['last-action.enc']);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
test('trace updates do not extend retention or replace other messages and clearing details preserves reports', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'jevclean-diagnostics-'));
  try {
    const store = new LocalStore(dir, testCipher()); const first = trace(); const second = trace(diagnosticsReportId, '0:124');
    await writeFile(join(dir, 'report.enc'), 'untouched report'); await writeFile(join(dir, 'last-action.enc'), 'untouched undo');
    await store.startDiagnostics(first.reportId, diagnosticsNow);
    await Promise.all([store.saveTrace(first), store.saveTrace(second)]);
    await store.saveTrace({ ...first, expiresAt: '2099-01-01T00:00:00Z', attempts: [...first.attempts, { attempt: 2, startedAt: diagnosticsNow.toISOString(), status: 'sending' }] });
    const loaded = await store.loadTrace(first.reportId, first.recordId, diagnosticsNow);
    assert.equal(loaded?.expiresAt, first.expiresAt); assert.equal(loaded?.attempts.length, 2);
    assert.deepEqual(await store.loadTrace(second.reportId, second.recordId, diagnosticsNow), second);
    await store.clearDiagnostics();
    assert.deepEqual((await readdir(dir)).sort(), ['last-action.enc', 'report.enc']);
    assert.equal(await readFile(join(dir, 'last-action.enc'), 'utf8'), 'untouched undo');
    assert.equal(await readFile(join(dir, 'report.enc'), 'utf8'), 'untouched report');
  } finally { await rm(dir, { recursive: true, force: true }); }
});
test('capacity exhaustion is explicit and does not overwrite existing trace evidence', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'jevclean-diagnostics-'));
  try {
    const store = new LocalStore(dir, testCipher()); const value = trace();
    await store.startDiagnostics(value.reportId, diagnosticsNow); await store.saveTrace(value);
    const padding = await open(join(dir, 'diagnostics', 'reserved.enc'), 'w');
    try { await padding.truncate(DIAGNOSTICS_MAX_BYTES); } finally { await padding.close(); }
    await assert.rejects(store.saveTrace({ ...value, requestText: 'new text' }), error => error instanceof DiagnosticsStorageError && error.code === 'diagnostics_capacity');
    assert.deepEqual(await store.loadTrace(value.reportId, value.recordId, diagnosticsNow), value);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
test('diagnostic identifiers cannot escape their private directory and expiry cleanup is independent of undo', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'jevclean-diagnostics-'));
  try {
    const store = new LocalStore(dir, testCipher()); const value = trace();
    await assert.rejects(store.startDiagnostics('../settings.enc', diagnosticsNow), /标识无效/);
    await store.startDiagnostics(value.reportId, diagnosticsNow);
    for (const recordId of ['../settings', 'a/b', '/tmp/example', 'a\\b', '', 'a'.repeat(257)]) {
      await assert.rejects(store.saveTrace({ ...value, recordId }), /标识无效/);
      await assert.rejects(store.loadTrace(value.reportId, recordId, diagnosticsNow), /标识无效/);
    }
    await store.saveTrace(value); await writeFile(join(dir, 'last-action.enc'), 'undo');
    await store.purgeExpiredDiagnostics(new Date(diagnosticsNow.getTime() + DIAGNOSTICS_RETENTION_MS));
    assert.deepEqual(await readdir(dir), ['last-action.enc']);
    await store.startDiagnostics(value.reportId, diagnosticsNow); await store.saveTrace(value);
    await store.deleteReports(); assert.deepEqual(await readdir(dir), []);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
test('failed encryption never falls back to plain trace files or overwrites previous evidence', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'jevclean-diagnostics-'));
  try {
    let available = true; const cipher = { ...testCipher(), available: async () => available };
    const store = new LocalStore(dir, cipher); const value = trace();
    await store.startDiagnostics(value.reportId, diagnosticsNow); await store.saveTrace(value);
    const files = await readdir(join(dir, 'diagnostics')); const before = await Promise.all(files.map(file => readFile(join(dir, 'diagnostics', file))));
    available = false;
    await assert.rejects(store.saveTrace({ ...value, requestText: 'new private text' }), /不会明文/);
    await assert.rejects(store.startDiagnostics('87654321-1234-4234-8234-123456789abc', diagnosticsNow), /不会明文/);
    assert.deepEqual(await Promise.all(files.map(file => readFile(join(dir, 'diagnostics', file)))), before);
    assert.deepEqual(await readdir(join(dir, 'diagnostics')), files);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
test('continuing a current batch retains other traces and recreates only within its original retention window', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'jevclean-diagnostics-'));
  try {
    const store = new LocalStore(dir, testCipher()); const value = trace();
    const later = new Date(diagnosticsNow.getTime() + 24 * 60 * 60 * 1000);
    await store.ensureDiagnostics(value.reportId, diagnosticsNow, later); await store.saveTrace(value);
    await store.ensureDiagnostics(value.reportId, diagnosticsNow, later);
    assert.deepEqual(await store.loadTrace(value.reportId, value.recordId, later), value);
    await assert.rejects(store.ensureDiagnostics('87654321-1234-4234-8234-123456789abc', diagnosticsNow, later), error => error instanceof DiagnosticsStorageError && error.code === 'diagnostics_batch');
    assert.deepEqual(await store.loadTrace(value.reportId, value.recordId, later), value);
    await store.clearDiagnostics(); await store.ensureDiagnostics(value.reportId, diagnosticsNow, later); await store.saveTrace(value);
    assert.equal((await store.loadTrace(value.reportId, value.recordId, later))?.expiresAt, value.expiresAt);
    await store.clearDiagnostics();
    await assert.rejects(store.ensureDiagnostics(value.reportId, diagnosticsNow, new Date(diagnosticsNow.getTime() + DIAGNOSTICS_RETENTION_MS)), /超过 7 天/);
    assert.deepEqual(await readdir(dir), []);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
test('interrupted analysis with a received response but no saved judgment remains explicitly retryable', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'jevclean-interrupted-analysis-'));
  try {
    const cipher = testCipher(); const store = new LocalStore(dir, cipher);
    const { text: _text, ...metadata } = email();
    const row: MailRecord = { ...metadata, id: diagnosticsReportId + ':0:42', status: 'pending', category: 'review', eligible: false,
      reason: '尚未获得有效的分析结果。', probability: 0, confidence: 0, matchedRules: [], verdicts: [],
      analysis: { version: 8, model: 'jev-1.13.0', analyzedAt: diagnosticsNow.toISOString(), rules: [], questions: {}, inputHash: 'synthetic-request-hash',
        attempts: [{ attempt: 1, startedAt: diagnosticsNow.toISOString(), completedAt: diagnosticsNow.toISOString(), status: 'succeeded', usage: { input_tokens: 123, output_tokens: 45 } }] } };
    const report: ScanReport = { id: diagnosticsReportId, kind: 'analysis', accountIdentity: 'synthetic-account', startedAt: diagnosticsNow.toISOString(),
      status: 'running', mailboxes: ['INBOX'], total: 1, processed: 0, records: [row], inputTokens: 0, outputTokens: 0, apiCalls: 0,
      model: 'jev-1.13.0', policyHash: 'synthetic-policy' };
    const attempts = structuredClone(row.analysis!.attempts);
    await store.saveReport(report);
    const restored = (await new LocalStore(dir, cipher).loadReport())!;
    assert.equal(restored.status, 'cancelled'); assert.equal(restored.records[0].category, 'review'); assert.equal(restored.records[0].eligible, false);
    assert.match(restored.records[0].analysis!.error!, /未保存完整判断/); assert.match(restored.records[0].reason, /可能已消耗额度/);
    assert.deepEqual(restored.records[0].analysis!.attempts, attempts); assert.ok(canRetryAnalysis(restored.records[0]));
    assert.deepEqual(await new LocalStore(dir, cipher).loadReport(), restored);

    for (const scenario of ['completed', 'no-ai', 'mail-only', 'already-failed', 'has-judgment']) {
      const untouched = structuredClone(report);
      if (scenario === 'completed') untouched.status = 'complete';
      if (scenario === 'no-ai') delete untouched.records[0].analysis;
      if (scenario === 'mail-only') untouched.kind = 'mail';
      if (scenario === 'already-failed') untouched.records[0].analysis!.error = 'Jev 账号额度不足。';
      if (scenario === 'has-judgment') untouched.records[0].verdicts = [{ id: 'synthetic-rule', name: 'Synthetic', decision: 'not_match', confidence: 0.99 }];
      const original = structuredClone(untouched.records[0]);
      await store.saveReport(untouched);
      assert.deepEqual((await new LocalStore(dir, cipher).loadReport())!.records[0], original, scenario);
    }
  } finally { await rm(dir, { recursive: true, force: true }); }
});
