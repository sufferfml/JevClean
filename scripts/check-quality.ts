import { classifyMessage } from '../src/core/classifier';
import { createEvaluator, JevError } from '../src/core/jev';
import { defaultSettings } from '../src/shared/contracts';
import { fingerprint } from '../src/core/privacy';
import type { EmailMessage } from '../src/shared/contracts';
import { qualityCases as cases } from '../tests/quality-cases';
const key = process.env.JEVCLEAN_JEV_KEY;
if (!key) { console.log('未运行真实 Jev 质量检查：请显式提供 JEVCLEAN_JEV_KEY。此命令只发送预先标注的合成邮件，会使用账户额度。'); process.exit(0); }
const requestLimit = Number(process.env.JEVCLEAN_MAX_CALLS ?? cases.length);
if (!Number.isInteger(requestLimit) || requestLimit < 1) throw new Error('JEVCLEAN_MAX_CALLS 必须是正整数。');
let requests = 0, dangerous = 0, matched = 0, processed = 0, failed = 0, inputTokens = 0, outputTokens = 0;
const boundedTransport: typeof fetch = async (input, init) => {
  if (requests >= requestLimit) throw new JevError('已达到本次 Jev 调用上限。', true);
  requests++; // Count attempts before sending, including failures.
  const response = await fetch(input, init);
  // A quality experiment must not hide additional requests inside automatic retries.
  return response.status === 429 || response.status >= 500 ? new Response(null, { status: 400 }) : response;
};
const evaluate = createEvaluator(key, boundedTransport);
const now = new Date('2026-10-02T12:00:00Z');
for (const [index, item] of cases.entries()) {
  if (requests >= requestLimit) break;
  const date = item.date || '2026-09-01T10:00:00Z'; const sender = 'synthetic@example.com';
  const message: EmailMessage = { uid: index + 1, uidValidity: '1', mailbox: 'INBOX', messageId: '<synthetic-' + index + '>', fingerprint: fingerprint(String(index), date, item.subject, sender), subject: item.subject, sender, senderAddress: sender, date, flags: [], hasAttachment: false, isReply: false, text: item.text, textTruncated: false };
  const settings = item.custom ? { ...defaultSettings, rules: [{ id: 'custom', name: '自定义规则', description: item.custom, enabled: true }] }
    : item.enabledRules ? { ...defaultSettings, rules: defaultSettings.rules.map(rule => ({ ...rule, enabled: item.enabledRules!.includes(rule.id) })) } : defaultSettings;
  let result: Awaited<ReturnType<typeof classifyMessage>>;
  try { result = await classifyMessage(message, settings, evaluate, now); }
  catch { failed++; console.log(item.name + ': 请求未完成，停止检查。'); break; }
  processed++;
  // A conservative review for a keep-labelled example is safe, but is still a semantic mismatch.
  if (result.classification.category === item.expected) matched++;
  if (item.expected !== 'clean' && result.classification.eligible) dangerous++;
  inputTokens += result.response?.usage.input_tokens ?? 0; outputTokens += result.response?.usage.output_tokens ?? 0;
  console.log(item.name + ': ' + result.classification.category + ' (expected ' + item.expected + ')');
}
console.log(JSON.stringify({ cases: cases.length, processed, requests, requestLimit, failed, exactMatches: matched, falseCleanup: dangerous, inputTokens, outputTokens }));
if (dangerous || failed || matched !== cases.length) process.exitCode = 1;
