import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import ts from 'typescript';
import { fixture } from './fixture';
import { email, settings, now } from './helpers';
import { MailService } from '../src/core/service';
import { settingsSchema } from '../src/shared/contracts';
import { policyHash } from '../src/core/rules';
import { buildJevRequest } from '../src/core/classifier';
import { createTranslator, localizedAction, localizeDiagnostic } from '../src/renderer/locale';
import english from '../src/renderer/strings.en.json';

test('language is persisted without rewriting credentials, Jev requests or analysis eligibility', async () => {
  const f = await fixture(); try {
    const report = await f.service.scan(true);
    const before = await f.store.config();
    const next = { ...before.settings, language: 'en' as const };
    await f.service.saveConfig({ settings: next });
    const after = await f.store.config();
    assert.equal(after.settings.language, 'en'); assert.deepEqual(after.secrets, before.secrets);
    assert.equal(policyHash(next), report.policyHash);
    assert.deepEqual(buildJevRequest(email(), next, now), buildJevRequest(email(), before.settings, now));
    assert.equal((await f.service.move([report.records[0].id])).moved, 1);
    assert.equal(settingsSchema.safeParse({ ...settings, language: 'fr' }).success, false);
  } finally { await f.cleanup(); }
});

test('connection badge requires a successful check, survives page refresh, and invalidates on credentials or identity changes', async () => {
  const f = await fixture(); try {
    assert.equal((await f.service.publicConfig()).mailConnection.connected, false);
    await f.service.testConnection();
    let state = await f.service.publicConfig(); assert.equal(state.mailConnection.connected, true);
    assert.equal(state.mailConnection.checkedAt, now.toISOString());
    assert.ok(!JSON.stringify(state).includes('test-password'));
    await f.service.saveConfig({ settings: { ...state.settings, language: 'en' } });
    assert.equal((await f.service.publicConfig()).mailConnection.connected, true);
    await f.service.saveConfig({ settings: state.settings, imapPassword: 'new-test-password' });
    assert.equal((await f.service.publicConfig()).mailConnection.connected, false);
    await f.service.testConnection();
    assert.equal((await f.service.publicConfig()).mailConnection.connected, true);
    await f.service.saveConfig({ settings: { ...state.settings, email: 'new@example.com' } });
    assert.equal((await f.service.publicConfig()).mailConnection.connected, false);
    await f.service.forgetCredentials();
    assert.equal((await f.service.publicConfig()).mailConnection.connected, false);
  } finally { await f.cleanup(); }
});

test('failed connection clears verification, and restarting does not claim an old connection is live', async () => {
  const f = await fixture(); try {
    let fail = false;
    const connect: typeof f.connect = async (config, password, operation, signal) => {
      if (fail) throw new Error('private provider detail must not become status');
      return f.connect(config, password, operation, signal);
    };
    const service = new MailService(f.store, () => {}, connect);
    await service.testConnection(); assert.equal((await service.publicConfig()).mailConnection.connected, true);
    const restarted = new MailService(f.store, () => {}, connect);
    assert.equal((await restarted.publicConfig()).mailConnection.connected, false);
    fail = true; await assert.rejects(service.testConnection());
    assert.deepEqual((await service.publicConfig()).mailConnection, { connected: false });
  } finally { await f.cleanup(); }
});

test('display translations preserve embedded user rule names and paths, and never translate the source content', () => {
  const t = createTranslator('en');
  assert.equal(t('停止本机运行'), 'Stop local service');
  assert.equal(createTranslator('zh-CN')('停止本机运行'), '停止本机运行');
  const name = '需要保留的广告推广'; const path = '归档/保留/邮件';
  assert.equal(localizedAction('move', path, 'en'), 'Move to “' + path + '”');
  assert.equal(localizeDiagnostic('命中规则「' + name + '」→ 删除', 'en', [name]), 'Matched rule “' + name + '”→ Delete');
  assert.equal(localizeDiagnostic('已移入 ' + path + '，可撤销。', 'en', [path]), 'Moved to ' + path + '. Can be undone.');
  assert.equal(t('这是我的自然语言规则，保留邮件。'), '这是我的自然语言规则，保留邮件。');
  assert.match(localizeDiagnostic('条件判断的选项概率未达到 80%。', 'en'), /score is too low/);
});

test('plain diagnostic copy only changes display and preserves protected source wording', () => {
  const raw = '条件判断的选项概率未达到 80%。';
  const saved = { reason: raw, rule: raw, request: { rule: raw }, response: { choice: 'uncertain' } };
  const original = JSON.stringify(saved);
  assert.equal(localizeDiagnostic(saved.reason, 'zh-CN'), '答案分数不足，暂不按规则整理。');
  assert.equal(localizeDiagnostic(saved.reason, 'zh-CN', [saved.rule]), raw);
  assert.equal(localizeDiagnostic(saved.reason, 'en', [saved.rule]), raw);
  assert.equal(JSON.stringify(saved), original);
});

test('every literal UI translation has an English catalog entry', async () => {
  const keys = new Set(Object.keys(english)); const missing: string[] = [];
  for (const file of ['App.tsx', 'MailList.tsx', 'AnalysisDetails.tsx', 'ManualPanel.tsx', 'WorkspacePanels.tsx', 'mail-copy.ts']) {
    const source = ts.createSourceFile(file, await readFile(join('src/renderer', file), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const visit = (node: ts.Node) => {
      if (ts.isCallExpression(node) && node.expression.getText(source) === 't' && ts.isStringLiteral(node.arguments[0])) {
        const key = node.arguments[0].text; if (/[\u3400-\u9fff]/.test(key) && !keys.has(key)) missing.push(key);
      }
      // The copy module also keeps complete templates in action/issue dictionaries.
      if (file === 'mail-copy.ts' && ts.isStringLiteral(node) && /[\u3400-\u9fff]/.test(node.text) && node.text.trim() !== '封邮件' && !keys.has(node.text)) missing.push(node.text);
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  assert.deepEqual(missing, []);
});
