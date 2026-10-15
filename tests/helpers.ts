import { randomBytes } from 'node:crypto';
import type { EmailMessage, Settings } from '../src/shared/contracts';
import { defaultSettings } from '../src/shared/contracts';
import type { Evaluate, JevResponse } from '../src/core/jev';
import { fingerprint } from '../src/core/privacy';
import { vaultCipher } from '../src/local/cipher';
export const now = new Date('2026-10-02T12:00:00Z');
export const settings: Settings = { ...structuredClone(defaultSettings), email: 'user@example.com', host: 'imap.example.com' };
export function email(patch: Partial<EmailMessage> = {}): EmailMessage {
  const message = { uid: 42, uidValidity: '999', mailbox: 'INBOX', messageId: '<42@example.com>',
    subject: 'A special offer', sender: 'Offers', senderAddress: 'offers@example.com', date: '2026-09-01T10:00:00Z',
    flags: [], hasAttachment: false, isReply: false, text: 'Save 20% on our seasonal sale. Unsubscribe at https://example.com/unsubscribe?id=secret', textTruncated: false, fingerprint: '', ...patch };
  message.fingerprint = fingerprint(message.messageId, message.date, message.subject, message.senderAddress); return message;
}
export function evaluator(decision = 'match', options: { confidence?: number; probability?: number; time?: string; expiry?: string; decisions?: Record<string, string> } = {}): Evaluate {
  return async request => {
    const answers: JevResponse['answers'] = {};
    for (const [id, question] of Object.entries(request.questions)) {
      if (question.type === 'noul') { answers[id] = { type: 'noul', noul: 0.99 }; continue; }
      const choices = Object.keys(question.criteria!);
      let choice = id.startsWith('rule_') ? options.decisions?.[id.slice(5)] ?? (id === 'rule_promotions' || !request.questions.rule_promotions ? decision : 'not_match') : options.time === 'content_expiry' ? options.expiry ?? 'unknown' : options.time === 'received_age' ? choices.find(c => c.startsWith('age_')) ?? 'unknown' : options.time === 'none' ? 'no_time' : options.time ?? 'no_time';
      // Older manual-operation fixtures ask for an excluded message via "keep". The new rule answer is not_match;
      // global protection is tested with a real action=keep rule, never with this compatibility alias.
      if (choice === 'keep' && !choices.includes('keep')) choice = 'not_match';
      const probability = choices.length === 1 ? 1 : options.probability ?? 0.995;
      answers[id] = { type: 'choice', choice, confidence: options.confidence ?? 0.99, probabilities: Object.fromEntries(choices.map(c => [c, c === choice ? probability : (1 - probability) / (choices.length - 1)])) };
    }
    return { model: 'jev-1.13.0', answers, usage: { input_tokens: 800, output_tokens: 80 } };
  };
}
export function testCipher() { const key = randomBytes(32); return vaultCipher('/unused-test-directory', { read: async () => key, write: async () => {} }); }
