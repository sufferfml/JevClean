import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildJevRequest, classifyMessage } from '../src/core/classifier';
import { extractDates, outboundState, TEXT_LIMIT } from '../src/core/privacy';
import { policyHash } from '../src/core/rules';
import { email, evaluator, now, settings } from './helpers';

test('custom natural language enters the same Jev questions as presets; disabled rules do not', async () => {
  const custom = { ...settings, rules: [{ id: 'jobs', name: '职位推荐', enabled: true, description: '清理旧职位推荐，保留正在沟通的职位。' }, { ...settings.rules[0], enabled: false }] };
  let called = false;
  const result = await classifyMessage(email(), custom, async request => {
    called = true; assert.ok(JSON.stringify(request).includes('清理旧职位推荐')); assert.ok(!request.questions.rule_promotions); assert.ok(request.questions.rule_jobs);
    return evaluator()(request);
  }, now);
  assert.ok(called); assert.equal(result.classification.category, 'clean'); assert.deepEqual(result.classification.matchedRules, ['jobs']);
  assert.notEqual(policyHash(settings), policyHash(custom));
});
test('same sender is judged per message, not grouped; attached/starred/replied text reaches Jev', async () => {
  let calls = 0;
  const judge = async (request: Parameters<ReturnType<typeof evaluator>>[0]) => {
    calls++; const state = request.state as ReturnType<typeof outboundState>;
    assert.equal(state.email.senderAddress, 'offers@example.com');
    return evaluator(state.email.subject.includes('receipt') ? 'not_match' : 'match')(request);
  };
  const advert = await classifyMessage(email({ hasAttachment: true, flags: ['\\Flagged'], isReply: true }), settings, judge, now);
  const receipt = await classifyMessage(email({ subject: 'Your receipt', text: 'Paid order confirmation.' }), settings, judge, now);
  assert.equal(calls, 2); assert.equal(advert.classification.category, 'clean'); assert.equal(receipt.classification.category, 'keep');
});
test('local exclusions do not veto a matching rule, and unsupported matches remain non-executable', async () => {
  const matched = await classifyMessage(email(), settings, evaluator('match', { decisions: { verification: 'not_match' } }), now);
  assert.equal(matched.classification.category, 'clean'); assert.deepEqual(matched.classification.matchedRules, ['promotions']);
  assert.equal(matched.classification.verdicts.find(verdict => verdict.id === 'verification')!.decision, 'not_match');
  const uncertain = await classifyMessage(email(), settings, evaluator('match', { probability: 0.7 }), now);
  assert.equal(uncertain.classification.category, 'review'); assert.equal(uncertain.classification.eligible, false);
});
test('future expiration cannot be cleaned even when Jev mistakenly selects match', async () => {
  const result = await classifyMessage(email({ text: '活动结束时间 2026-12-20。' }), settings, evaluator('match', { time: 'content_expiry', expiry: 'date_0' }), now);
  assert.equal(result.classification.eligible, false);
});
test('relative expiration is anchored to server receipt and must have selected evidence', async () => {
  const message = email({ date: '2026-10-02T11:00:00Z', text: 'Your verification code is 123456. Valid for 10 minutes.' });
  const dates = extractDates(message.text, message.date);
  assert.equal(dates[0].endAt, '2026-10-02T11:10:00.000Z');
  const result = await classifyMessage(message, settings, evaluator('match', { time: 'content_expiry', expiry: 'date_0' }), now);
  assert.equal(result.classification.eligible, true); assert.match(result.classification.expiryEvidence!, /11:10/);
  const absent = await classifyMessage(message, settings, evaluator('match', { time: 'content_expiry' }), now);
  assert.equal(absent.classification.category, 'review');
});
test('incomplete, oversized, invalid-time and draft emails do not reach Jev', async () => {
  const never = async () => { throw new Error('must not send'); };
  for (const patch of [{ textTruncated: true }, { text: 'x'.repeat(TEXT_LIMIT + 1) }, { date: '' }, { flags: ['\\Draft'] }, { flags: ['\\Deleted'] }]) {
    const result = await classifyMessage(email(patch), settings, never, now); assert.equal(result.classification.eligible, false);
  }
});
test('outbound state minimizes links and recognizable secrets but preserves custom-rule evidence', () => {
  const state = outboundState(email({ text: '验证码：123456 API key: private-test-key\n订单 87654 来自 recruiting@example.com https://example.com/path?token=private' }), now);
  const text = JSON.stringify(state); assert.ok(!text.includes('private')); assert.ok(!text.includes('123456')); assert.ok(!text.includes('?token'));
  assert.ok(text.includes('87654')); assert.ok(text.includes('recruiting@example.com'));
});
test('calendar candidates reject invalid dates and do not guess yearless dates', () => {
  assert.equal(extractDates('2026-02-30 10月20日', now.toISOString()).length, 0);
  assert.ok(extractDates('October 1, 2026', now.toISOString()).length === 1);
  assert.equal(extractDates('2026年9月20日', now.toISOString()).length, 1);
  assert.equal(extractDates('2026年2月30日', now.toISOString()).length, 0);
});
test('explicit spaced and day-first calendar dates do not become receipt-relative durations', () => {
  const dates = extractDates('活动结束于2025 年 9 月 20 日。 Workshop ends 20 September 2025.', now.toISOString());
  assert.equal(dates.length, 2);
  assert.equal(dates[0].endAt, dates[1].endAt);
  assert.ok(!dates.some(date => /^(9 月|20 日)$/.test(date.value)));
  assert.equal(extractDates('2025 年 2 月 30 日', now.toISOString()).length, 0);
});
test('embedded images never enter Jev text, while visible body evidence remains', () => {
  const text = outboundState(email({ text: 'Invoice: [data:image/png;base64,abcdef123456+/==] Paid on 2026-09-20.' }), now).email.text;
  assert.ok(!text.includes('base64')); assert.ok(!text.includes('abcdef'));
  assert.ok(text.includes('Invoice')); assert.ok(text.includes('2026-09-20'));
});
test('a labelled standalone authentication code is hidden without erasing expiry evidence', () => {
  const text = outboundState(email({ text: 'Please use the following code to verify your identity:\n\n654321\n\nValid until 2026-12-20.' }), now).email.text;
  assert.ok(!text.includes('654321')); assert.ok(text.includes('following code')); assert.ok(text.includes('2026-12-20'));
});
test('code labels with both a verb and colon remain redacted', () => {
  const text = outboundState(email({ text: '您的绑定验证码是：654321。有效期10分钟。 Verification code is: 456789.' }), now).email.text;
  assert.ok(!text.includes('654321')); assert.ok(!text.includes('456789'));
  assert.ok(text.includes('10分钟')); assert.ok(text.includes('[code]'));
});

test('a weak unrelated rule cannot veto or dilute a strongly supported cleanup rule', async () => {
  const result = await classifyMessage(email(), settings, async request => {
    const response = await evaluator()(request);
    response.answers.rule_events = { type: 'choice', choice: 'not_match', confidence: 0.4, probabilities: { not_match: 0.6, match: 0.35, uncertain: 0.05 } };
    response.answers.rule_verification = { type: 'choice', choice: 'match', confidence: 0.1, probabilities: { not_match: 0.3, match: 0.4, uncertain: 0.3 } };
    return response;
  }, now);
  assert.equal(result.classification.category, 'clean');
  assert.equal(result.classification.probability, 0.995);
  const weakNonMatch = result.classification.verdicts.find(v => v.id === 'events')!;
  assert.equal(weakNonMatch.decision, 'uncertain'); assert.equal(weakNonMatch.modelAnswer!.choice, 'not_match');
  assert.equal(weakNonMatch.modelAnswer!.probability, .6);
  const uncertain = result.classification.verdicts.find(v => v.id === 'verification')!;
  assert.equal(uncertain.decision, 'uncertain'); assert.equal(uncertain.modelAnswer!.choice, 'match');
  assert.equal(uncertain.modelAnswer!.probability, 0.4); assert.match(uncertain.reason!, /选项概率/);
});
test('a weak not_match from an explicit global keep rule blocks execution and retains the raw answer', async () => {
  const configured = { ...settings, rules: [...settings.rules, { id: 'protect', name: '保留凭证', description: '付款凭证。', enabled: true, action: 'keep' as const }] };
  const result = await classifyMessage(email(), configured, async request => {
    const response = await evaluator('match', { decisions: { protect: 'not_match' } })(request);
    response.answers.rule_protect = { type: 'choice', choice: 'not_match', confidence: 0.2, probabilities: { not_match: 0.55, match: 0.3, uncertain: 0.15 } };
    return response;
  }, now);
  assert.equal(result.classification.category, 'review'); assert.equal(result.classification.eligible, false);
  assert.match(result.classification.reason, /全局保留条件尚未确认/);
  const verdict = result.classification.verdicts.find(item => item.id === 'protect')!;
  assert.equal(verdict.decision, 'uncertain'); assert.equal(verdict.modelAnswer!.choice, 'not_match');
  assert.equal(verdict.modelAnswer!.probability, .55); assert.match(verdict.reason!, /尚不能明确排除/);
});
test('recommendation uses the selected probability, not an independent confidence gate', async () => {
  assert.equal((await classifyMessage(email(), settings, evaluator('match', { confidence: 0.6, probability: 0.83 }), now)).classification.eligible, true);
  const rejected = await classifyMessage(email(), settings, evaluator('match', { confidence: 0.99, probability: 0.79 }), now);
  assert.equal(rejected.classification.eligible, false); assert.match(rejected.classification.reason, /80%/);
});
test('code compares receipt-age thresholds and preserves mail until the threshold passes', async () => {
  const oneRule = { ...settings, rules: [{ id: 'age', name: '旧邮件', enabled: true, description: '清理收到超过一个月的职位推荐。' }] };
  const older = email({ date: '2026-08-31T12:00:00Z' });
  const request = buildJevRequest(older, oneRule, now);
  assert.equal(Object.keys(request.questions).length, 2);
  assert.equal((request.questions.time_age.criteria!.age_0 as { thresholdAt: string }).thresholdAt, '2026-09-30T12:00:00.000Z');
  assert.equal((await classifyMessage(older, oneRule, evaluator('match', { time: 'received_age' }), now)).classification.eligible, true);
  assert.equal((await classifyMessage(email({ date: '2026-10-01T12:00:00Z' }), oneRule, evaluator('match', { time: 'received_age' }), now)).classification.eligible, false);
});
test('default verification and notification time limits keep their strict boundaries after text upgrades', async () => {
  for (const [id, hours] of [['verification', 24], ['notifications', 30 * 24]] as const) {
    const preset = settings.rules.find(rule => rule.id === id)!;
    const configured = { ...settings, rules: [{ ...preset, enabled: true }] };
    const atThreshold = email({ date: new Date(now.getTime() - hours * 3600000).toISOString() });
    const older = email({ date: new Date(now.getTime() - hours * 3600000 - 1000).toISOString() });
    const request = buildJevRequest(older, configured, now);
    assert.deepEqual(Object.keys(request.questions), ['rule_' + id, 'time_' + id]);
    assert.equal((request.questions['rule_' + id].instructions as { rule: string }).rule, preset.description);
    assert.equal((request.questions['time_' + id].instructions as { rule: string }).rule, preset.description);
    const ages = Object.keys(request.questions['time_' + id].criteria!).filter(key => key.startsWith('age_'));
    assert.equal(ages.length, 1);
    assert.equal((await classifyMessage(atThreshold, configured, evaluator('match', { time: 'received_age' }), now)).classification.eligible, false);
    assert.equal((await classifyMessage(older, configured, evaluator('match', { time: 'received_age' }), now)).classification.eligible, true);
  }
});

test('rule questions share match/not_match/uncertain and do not disclose configured actions or targets', () => {
  const rule = { id: 'custom', name: '自定义规则', enabled: true, description: '职位推荐；排除正在沟通的职位。' };
  const requests = ['delete', 'archive', 'move', 'keep'].map(action => buildJevRequest(email(), { ...settings,
    rules: [{ ...rule, action: action as 'delete' | 'archive' | 'move' | 'keep', ...(action === 'move' ? { targetMailbox: 'PrivateTarget' } : {}) }],
  }, now));
  for (const request of requests) {
    assert.deepEqual(Object.keys(request.questions.rule_custom.criteria!), ['match', 'not_match', 'uncertain']);
    assert.deepEqual(request, requests[0]);
    assert.equal(Object.hasOwn(request.questions.rule_custom.instructions as object, 'action'), false);
    assert.ok(!JSON.stringify(request).includes('PrivateTarget'));
    assert.match(request.questions.rule_custom.criteria!.not_match as string, /只排除本条规则/);
  }
});

test('a resume match survives unrelated local exclusions and uncertainty with original evidence intact', async () => {
  const configured = { ...settings, rules: [
    { id: 'resume', name: '简历', description: '求职者投递的简历。', enabled: true, action: 'delete' as const },
    { id: 'ads', name: '广告', description: '广告推广；保留求职简历。', enabled: true, action: 'delete' as const },
  ] };
  for (const other of ['not_match', 'uncertain']) {
    const result = await classifyMessage(email({ subject: '产品设计师求职简历', text: '您好，我想应聘产品设计师，这是我的经历。' }), configured,
      evaluator('match', { decisions: { resume: 'match', ads: other } }), now);
    assert.equal(result.classification.category, 'clean'); assert.equal(result.classification.action, 'delete');
    assert.deepEqual(result.classification.matchedRules, ['resume']);
    const unrelated = result.classification.verdicts.find(verdict => verdict.id === 'ads')!;
    assert.equal(unrelated.decision, other); assert.equal(unrelated.modelAnswer!.choice, other);
  }
});

test('no complete ordinary match never grants execution, including when global protection is ruled out', async () => {
  const configured = { ...settings, rules: [
    { id: 'cleanup', name: '清理', description: '广告。', enabled: true, action: 'delete' as const },
    { id: 'protect', name: '全局保留', description: '发票。', enabled: true, action: 'keep' as const },
  ] };
  for (const decision of ['not_match', 'uncertain']) {
    const result = await classifyMessage(email(), configured, evaluator(decision, { decisions: { protect: 'not_match' } }), now);
    assert.equal(result.classification.category, decision === 'uncertain' ? 'review' : 'keep');
    assert.equal(result.classification.eligible, false); assert.deepEqual(result.classification.matchedRules, []);
    assert.equal(result.classification.action, undefined);
  }
  const weakNonMatch = await classifyMessage(email(), { ...configured, rules: [configured.rules[0]] }, evaluator('not_match', { probability: .6 }), now);
  assert.equal(weakNonMatch.classification.category, 'review'); assert.equal(weakNonMatch.classification.eligible, false);
  assert.equal(weakNonMatch.classification.verdicts[0].modelAnswer!.choice, 'not_match');
  assert.equal(weakNonMatch.classification.verdicts[0].decision, 'uncertain');
});

test('global keep requires an unambiguous condition and time; a proven non-match does not veto cleanup', async () => {
  const configured = { ...settings, rules: [
    { id: 'cleanup', name: '清理', description: '广告。', enabled: true, action: 'delete' as const },
    { id: 'protect', name: '全局保留', description: '收到超过30天的凭证。', enabled: true, action: 'keep' as const },
  ] };
  for (const scenario of ['match', 'not_match', 'uncertain', 'weak_match', 'weak_time', 'unknown_time', 'future_time']) {
    const message = email(scenario === 'future_time' ? { date: now.toISOString() } : {});
    const result = await classifyMessage(message, configured, async request => {
      const response = await evaluator('match', { decisions: { protect: scenario === 'not_match' ? 'not_match' : scenario === 'uncertain' ? 'uncertain' : 'match' } })(request);
      if (scenario === 'weak_match') response.answers.rule_protect = { type: 'choice', choice: 'match', confidence: .99, probabilities: { match: .6, not_match: .3, uncertain: .1 } };
      if (['weak_time', 'unknown_time', 'future_time'].includes(scenario)) {
        const choice = scenario === 'unknown_time' ? 'unknown' : scenario === 'future_time' ? 'age_0' : 'no_time';
        const options = Object.keys(request.questions.time_protect.criteria!); const probability = scenario === 'weak_time' ? .6 : .995;
        response.answers.time_protect = { type: 'choice', choice, confidence: .99,
          probabilities: Object.fromEntries(options.map(option => [option, option === choice ? probability : (1 - probability) / (options.length - 1)])) };
      }
      return response;
    }, now);
    assert.equal(result.classification.category, scenario === 'match' ? 'keep' : ['not_match', 'future_time'].includes(scenario) ? 'clean' : 'review', scenario);
    assert.equal(result.classification.eligible, ['not_match', 'future_time'].includes(scenario), scenario);
    if (scenario === 'match') assert.equal(result.classification.action, 'keep');
  }
});

test('legacy keep choice cannot authorize or veto a new-version rule evaluation', async () => {
  await assert.rejects(classifyMessage(email(), settings, async request => {
    const response = await evaluator()(request);
    response.answers.rule_promotions = { type: 'choice', choice: 'keep', confidence: 1, probabilities: { keep: 1, match: 0, not_match: 0 } };
    return response;
  }, now), /缺少有效判断/);
});
