import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { classifyMessage } from '../src/core/classifier';
import { judgmentHash, policyHash } from '../src/core/rules';
import { MailService } from '../src/core/service';
import { ruleSchema, type MailAction, type ScanReport, type Settings } from '../src/shared/contracts';
import { fixture } from './fixture';
import { email, evaluator, now, settings } from './helpers';

const rule = (id: string, action: MailAction, targetMailbox?: string) => ({
  id, name: id, description: '符合用户指定用途的邮件。', enabled: true, action, ...(targetMailbox ? { targetMailbox } : {}),
});

test('all action pairs follow the confirmed priority regardless of rule order; distinct flags remain a choice', async () => {
  const levels: MailAction[][] = [['delete'], ['junk'], ['move'], ['archive'], ['read', 'unread', 'star', 'unstar']];
  for (const [leftLevel, leftActions] of levels.entries()) for (const left of leftActions) {
    for (const [rightLevel, rightActions] of levels.entries()) for (const right of rightActions) {
      const config = { ...settings, rules: [rule('left', left, left === 'move' ? 'Archive' : undefined), rule('right', right, right === 'move' ? 'Archive' : undefined)] };
      const result = (await classifyMessage(email(), config, evaluator('match'), now)).classification;
      const context = left + ' + ' + right;
      assert.ok(result.verdicts.every(verdict => verdict.decision === 'match'), context);
      if (leftLevel === rightLevel && left !== right) {
        assert.equal(result.category, 'review', context); assert.equal(result.eligible, false, context);
        assert.deepEqual(new Set(result.conflicts!.map(choice => choice.action)), new Set([left, right]), context);
      } else {
        const winner = leftLevel <= rightLevel ? left : right;
        assert.equal(result.category, 'clean', context); assert.equal(result.action, winner, context);
        assert.deepEqual(result.matchedRules, config.rules.filter(item => item.action === winner).map(item => item.id), context);
        assert.equal(result.conflicts, undefined, context);
        assert.equal(result.reason.includes('按处理优先级'), left !== right, context);
      }
    }
  }
});

test('a lower action cannot inflate the selected score, and an unproven stricter action cannot win', async () => {
  const config = { ...settings, rules: [rule('strict', 'delete'), rule('lower', 'archive')] };
  for (const probability of [.81, .79]) {
    const result = (await classifyMessage(email(), config, async request => {
      const response = await evaluator('match')(request);
      response.answers.rule_strict = { type: 'choice', choice: 'match', confidence: probability, probabilities: { match: probability, not_match: 1 - probability, uncertain: 0 } };
      return response;
    }, now)).classification;
    assert.equal(result.action, probability >= .8 ? 'delete' : 'archive');
    assert.equal(result.probability, probability >= .8 ? probability : .995);
    assert.deepEqual(result.matchedRules, [probability >= .8 ? 'strict' : 'lower']);
  }
});

test('only highest-level ties need confirmation, while lower-level conflicts do not defeat a stricter match', async () => {
  const rules = [rule('a', 'move', 'Archive'), rule('b', 'move', 'Junk'), rule('lower', 'archive')];
  const tied = (await classifyMessage(email(), { ...settings, rules }, evaluator('match'), now)).classification;
  assert.equal(tied.category, 'review'); assert.deepEqual(tied.conflicts!.map(choice => choice.id), ['a', 'b']);
  assert.ok(!tied.reason.includes('「lower」')); assert.equal(tied.verdicts.length, 3);
  const strict = (await classifyMessage(email(), { ...settings, rules: [...rules, rule('strict', 'delete')] }, evaluator('match'), now)).classification;
  assert.equal(strict.action, 'delete'); assert.deepEqual(strict.matchedRules, ['strict']);
  assert.equal(strict.conflicts, undefined); assert.equal(strict.verdicts.length, 4);
});

test('only explicit global keep or its uncertainty overrides ranked actions; local exclusion does not', async () => {
  for (const [action, decision, probability, category] of [
    ['keep', 'match', .995, 'keep'], ['archive', 'not_match', .995, 'clean'],
    ['keep', 'match', .6, 'review'], ['archive', 'uncertain', .995, 'clean'],
    ['keep', 'not_match', .6, 'review'], ['keep', 'not_match', .995, 'clean'],
    ['keep', 'uncertain', .995, 'review'],
  ] as const) {
    const config = { ...settings, rules: [rule('strict', 'delete'), rule('protect', action)] };
    const result = (await classifyMessage(email(), config, async request => {
      const response = await evaluator('match')(request);
      response.answers.rule_protect = { type: 'choice', choice: decision, confidence: probability,
        probabilities: Object.fromEntries(['match', 'not_match', 'uncertain'].map(choice => [choice, choice === decision ? probability : (1 - probability) / 2])) };
      return response;
    }, now)).classification;
    assert.equal(result.category, category); assert.equal(result.eligible, category === 'clean');
    if (category === 'clean') { assert.equal(result.action, 'delete'); assert.deepEqual(result.matchedRules, ['strict']); }
    assert.ok(result.verdicts.some(verdict => verdict.id === 'strict' && verdict.decision === 'match'));
  }
});

test('target changes preserve priority and rebuild only the highest-level target choices without Jev', async () => {
  let calls = 0; const f = await fixture(async request => { calls++; return evaluator('match')(request); });
  try {
    const rules = [rule('a', 'move', 'Archive'), rule('b', 'move', 'Archive'), rule('lower', 'archive')];
    await f.service.saveConfig({ settings: { ...settings, rules } });
    const report = await f.service.scan(true); const row = report.records[0]; const before = structuredClone(row.verdicts); const paid = calls;
    assert.equal(row.action, 'move'); assert.deepEqual(row.matchedRules, ['a', 'b']);
    const split = rules.map(item => item.id === 'b' ? { ...item, targetMailbox: 'Junk' } : item);
    await f.service.saveConfig({ settings: { ...settings, rules: split } }); await f.service.checkActions();
    assert.deepEqual(row.conflicts!.map(choice => [choice.action, choice.targetMailbox]), [['move', 'Archive'], ['move', 'Junk']]);
    await assert.rejects(f.service.resolveConflict(row.id, 'lower'), /不是/);
    await f.service.resolveConflict(row.id, 'b');
    await f.service.saveConfig({ settings: { ...settings, rules: split.map(item => item.action === 'move' ? { ...item, targetMailbox: 'Trash' } : item) } });
    await f.service.checkActions();
    assert.equal(row.action, 'move'); assert.equal(row.targetMailbox, 'Trash'); assert.equal(row.selectedConflict, undefined); assert.equal(row.conflicts, undefined);
    assert.deepEqual(row.verdicts, before); assert.equal(calls, paid); assert.equal(f.moveCalls, 0);
    assert.equal((await f.service.move([row.id])).moved, 1); assert.equal(f.quarantine.size, 1); assert.equal(f.archive.size, 0);
  } finally { await f.cleanup(); }
});

// Reproduce older persisted formats, independently of the current policy version/model constants.
function legacyPolicyHash(config: Settings, version: 6 | 7 = 6) {
  return createHash('sha256').update(JSON.stringify({ version, model: 'jev-1.13.0', probability: .8,
    account: [config.email.toLowerCase(), config.host.toLowerCase(), config.port], mailboxes: [...config.mailboxes].sort(),
    scanLimit: config.scanLimit, folders: config.actionFolders, rules: config.rules.filter(item => item.enabled) })).digest('hex');
}
function legacyReport(report: ScanReport, config: Settings, hasJudgmentHash = true, version: 6 | 7 = 6) {
  const old = structuredClone(report); old.policyHash = legacyPolicyHash(config, version);
  if (hasJudgmentHash) old.judgmentHash = legacyPolicyHash({ ...config, actionFolders: {}, rules: config.rules.map(item => {
    const { targetMailbox: _target, ...judgment } = ruleSchema.parse(item); return judgment;
  }) }, version);
  else delete old.judgmentHash;
  return old;
}

test('v6 and v7 reports remain readable but cannot be promoted, executed, resolved or reused as new AI evidence', async () => {
  for (const version of [6, 7] as const) for (const hasJudgmentHash of [true, false]) for (const conflict of [false, true]) {
    const f = await fixture(evaluator('match'));
    try {
      if (conflict) await f.service.saveConfig({ settings: { ...settings, rules: [rule('a', 'move', 'Archive'), rule('b', 'move', 'Junk')] } });
      const original = await f.service.scan(true); const config = (await f.store.config()).settings;
      const old = legacyReport(original, config, hasJudgmentHash, version); const id = old.records[0].id; const downloads = f.downloads.length;
      assert.notEqual(old.policyHash, policyHash(config)); assert.notEqual(old.judgmentHash, judgmentHash(config));
      await f.store.saveReport(old);
      const restarted = new MailService(f.store, () => {}, f.connect, () => { throw new Error('No Jev for old evidence'); }, () => now);
      const loaded = await restarted.loadReport(); assert.equal(loaded!.policyHash, old.policyHash); assert.equal(loaded!.judgmentHash, old.judgmentHash);
      assert.deepEqual(loaded!.records, JSON.parse(JSON.stringify(old.records)));
      await assert.rejects(restarted.move([id]), /重新分析/);
      await assert.rejects(restarted.resolveConflict(id, conflict ? 'a' : 'forged'), /重新分析/);
      await restarted.checkActions(); await assert.rejects(restarted.move([id]), /重新分析/);
      const reread = await restarted.readMail(); assert.equal(reread.records[0].category, 'unclassified'); assert.equal(reread.records[0].eligible, false);
      assert.deepEqual(reread.records[0].verdicts, []); assert.equal(reread.apiCalls, 0); assert.equal(f.downloads.length, downloads); assert.equal(f.moveCalls + f.flagCalls, 0);
    } finally { await f.cleanup(); }
  }
});

test('v6 and v7 last-action receipts can still be verified and undone after restart without renewing old rule authority', async () => {
  for (const version of [6, 7] as const) for (const hasJudgmentHash of [true, false]) {
    const f = await fixture();
    try {
      const report = await f.service.scan(true); await f.service.move([report.records[0].id]);
      const config = (await f.store.config()).settings;
      const old = legacyReport((await f.store.loadAction())!, config, hasJudgmentHash, version);
      await f.store.saveAction(old); await f.store.saveReport(old);
      const restarted = new MailService(f.store, () => {}, f.connect, () => { throw new Error('No Jev for historical operations'); }, () => now);
      assert.equal((await restarted.refreshCleanup()).moved, 1);
      const restored = await restarted.undo(); assert.equal(restored.moved, 1); assert.equal(restored.report.records[0].status, 'restored');
      assert.equal(f.original.size, 1); assert.equal(f.quarantine.size, 0); assert.equal(restored.report.policyHash, old.policyHash);
      await assert.rejects(restarted.move([restored.report.records[0].id]), /重新分析/);
    } finally { await f.cleanup(); }
  }
});

test('diagnostic preferences do not change policy or semantic hashes', () => {
  const configured = { ...settings, detailedDiagnostics: true };
  assert.equal(policyHash(configured), policyHash(settings));
  assert.equal(judgmentHash(configured), judgmentHash(settings));
  assert.notEqual(policyHash(settings), legacyPolicyHash(settings, 7));
});
