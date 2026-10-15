import { resolve } from 'node:path';
import { MailService } from '../../src/core/service';
import { startLocalServer } from '../../src/local/server';
import { LocalLogger } from '../../src/local/logger';
import { fixture } from '../fixture';
import { email, evaluator, now } from '../helpers';
import type { Evaluate } from '../../src/core/jev';
// Fictional providers injected through the same HTTP server and core used in production.
const evaluate: Evaluate = request => {
  const subject = (request.state as { email?: { subject: string } }).email?.subject ?? '';
  const decisions = subject.includes('订单') ? { promotions: 'not_match', verification: 'not_match', events: 'not_match' } : subject.includes('未知') ? { promotions: 'not_match', verification: 'not_match', events: 'uncertain' } : subject.includes('验证码') ? { promotions: 'not_match', verification: 'match', events: 'not_match' } : { promotions: 'match', verification: 'not_match', events: 'not_match' };
  const allDecisions: Record<string, string> = { ...decisions };
  for (const id of Object.keys(request.questions).filter(id => id.startsWith('rule_'))) {
    if (!(id.slice(5) in allDecisions)) allDecisions[id.slice(5)] = subject.includes('订单') || subject.includes('未知') ? 'not_match' : 'match';
  }
  return evaluator('not_match', { decisions: allDecisions, time: subject.includes('验证码') ? 'received_age' : 'none' })(request);
};
const f = await fixture(evaluate);
// Synthetic detection failure used to drive real HTTP preflight and manual recovery.
let connectionHost = '';
const list = f.client.list;
f.client.list = async () => (await list()).map(folder => connectionHost === 'missing-target.example.com' && folder.path === 'Trash'
  ? { ...folder, name: 'Personal folder', specialUse: undefined } : folder);
const connect: typeof f.connect = async (settings, password, operation, signal) => {
  connectionHost = settings.host;
  return f.connect(settings, password, operation, signal);
};
// Keep mutation in flight long enough to verify progress and reloading the real HTTP workflow.
const move = f.client.messageMove;
f.client.messageMove = async (uid, path) => { await new Promise(resolve => setTimeout(resolve, 2400)); return move(uid, path); };
await f.store.forgetCredentials();
f.original.clear();
for (const [index, subject] of ['秋季促销，限时优惠', '验证码已经失效', '订单付款成功，请保留', '未知结束时间的活动'].entries()) {
  f.original.set(42 + index, email({ uid: 42 + index, date: '2026-09-0' + (index + 1) + 'T10:00:00Z', messageId: '<' + index + '@example.com>', subject, text: '这是一封用于界面测试的合成邮件，不含真实个人信息。' }));
}
f.archive.set(42, email({ uid: 42, mailbox: 'Archive', uidValidity: '777', date: '2026-09-05T10:00:00Z', messageId: '<archive@example.com>', subject: '存档中的促销邮件', text: '这是一封用于界面测试的合成邮件，不含真实个人信息。' }));
const server = await startLocalServer({ store: f.store, webDirectory: resolve('dist/web'), logger: new LocalLogger(f.dir), port: Number(process.env.JEVCLEAN_UI_PORT ?? 5178), token: 'a'.repeat(64), createService: emit => new MailService(f.store, emit, connect, () => evaluate, () => now) });
console.log('UI test server ready');
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => { void server.close().then(f.cleanup).then(() => process.exit(0)); });
