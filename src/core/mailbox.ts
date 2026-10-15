import { AppError } from './errors';
import { ImapFlow } from 'imapflow';
import type { MessageStructureObject, FetchMessageObject } from 'imapflow';
import { simpleParser } from 'mailparser';
import { createHash } from 'node:crypto';
import type { EmailMessage, MailboxInfo, Settings } from '../shared/contracts';
import { fingerprint } from './privacy';

const BODY_LIMIT = 128 * 1024;
export function accountIdentity(settings: Settings): string {
  return createHash('sha256').update(settings.host.toLowerCase() + ':' + settings.port + ':' + settings.email.toLowerCase()).digest('hex');
}
export function makeClient(settings: Settings, password: string): ImapFlow {
  const client = new ImapFlow({
    host: settings.host, port: settings.port, secure: true,
    auth: { user: settings.email, pass: password },
    tls: { rejectUnauthorized: true, minVersion: 'TLSv1.2' },
    logger: false, logRaw: false, emitLogs: false, disableAutoIdle: true,
    connectionTimeout: 20000, greetingTimeout: 15000, socketTimeout: 60000,
    maxLiteralSize: 512 * 1024, maxResponseSize: 1024 * 1024,
    clientInfo: { name: 'JevClean', version: '0.2.0' },
  });
  // The operation's promise handles failures. An unhandled EventEmitter error must not crash the app.
  client.on('error', () => {});
  return client;
}
export async function withConnection<T>(settings: Settings, password: string, operation: (client: ImapFlow) => Promise<T>, signal?: AbortSignal): Promise<T> {
  const client = makeClient(settings, password);
  const onAbort = () => client.close();
  signal?.addEventListener('abort', onAbort, { once: true });
  try {
    signal?.throwIfAborted();
    await client.connect();
    return await operation(client);
  } finally {
    signal?.removeEventListener('abort', onAbort);
    if (client.usable) await client.logout().catch(() => client.close());
    else client.close();
  }
}
export function currentValidity(client: ImapFlow): string {
  if (!client.mailbox) throw new AppError('邮箱未打开。');
  return client.mailbox.uidValidity.toString();
}
export async function listMailboxes(client: ImapFlow): Promise<MailboxInfo[]> {
  return (await client.list()).map((item) => ({
    path: item.path, name: item.name,
    selectable: !item.flags.has('\\Noselect'), specialUse: item.specialUse, specialUseSource: item.specialUseSource,
  }));
}
// Only fetch UID and server receipt time to choose recent messages, without reading any bodies.
// The caller owns a read-only mailbox lock. Bound each FETCH so large mailboxes stay cancellable.
export async function fetchReceiptTimes(client: ImapFlow, uids: number[], signal?: AbortSignal): Promise<Map<number, number>> {
  const times = new Map<number, number>();
  for (let offset = 0; offset < uids.length; offset += 1000) {
    signal?.throwIfAborted();
    const batch = uids.slice(offset, offset + 1000); const requested = new Set(batch);
    const messages = await client.fetchAll(batch, { uid: true, internalDate: true }, { uid: true });
    signal?.throwIfAborted();
    for (const message of messages) {
      if (!requested.has(message.uid)) continue;
      const received = message.internalDate ? new Date(message.internalDate).getTime() : NaN;
      if (!Number.isFinite(received)) throw new AppError('无法确认邮件的收件时间，不能选择最近的邮件。请重试或选择全部邮件。');
      times.set(message.uid, received);
    }
  }
  return times;
}
export function bodyParts(node?: MessageStructureObject, attached = false): { text?: MessageStructureObject; hasAttachment: boolean } {
  if (!node) return { hasAttachment: false };
  const isAttachment = attached || node.disposition === 'attachment' ||
    Boolean(node.dispositionParameters?.filename || node.parameters?.name);
  if (isAttachment) return { hasAttachment: true };
  if (node.childNodes?.length) {
    const parts = node.childNodes.map((child) => bodyParts(child));
    return {
      text: parts.map((part) => part.text).find((part) => part?.type === 'text/plain') ?? parts.map((part) => part.text).find(Boolean),
      hasAttachment: parts.some((part) => part.hasAttachment),
    };
  }
  if (node.type === 'message/rfc822') return { hasAttachment: true };
  if (node.type === 'text/plain' || node.type === 'text/html') return { text: node, hasAttachment: false };
  return { hasAttachment: node.disposition !== 'inline' && node.type !== 'image' && !node.type.startsWith('image/') };
}
export function metadataFromFetch(item: FetchMessageObject, mailbox: string, uidValidity: string): EmailMessage {
  const envelope = item.envelope;
  const senderAddress = envelope?.from?.[0]?.address ?? '';
  const subject = (envelope?.subject ?? '(无主题)').slice(0, 1000);
  const received = item.internalDate ? new Date(item.internalDate) : null;
  // Never use the sender-controlled Date header to decide that a code has expired.
  const date = received && Number.isFinite(received.getTime()) ? received.toISOString() : '';
  const messageId = envelope?.messageId ?? '';
  return {
    uid: item.uid, uidValidity, mailbox, messageId,
    fingerprint: fingerprint(messageId, date, subject, senderAddress),
    subject, sender: (envelope?.from?.[0]?.name || senderAddress || '未知发件人').slice(0, 254),
    senderAddress, date, flags: [...(item.flags ?? [])],
    hasAttachment: bodyParts(item.bodyStructure).hasAttachment,
    isReply: Boolean(envelope?.inReplyTo || item.headers?.toString().match(/^(?:in-reply-to|references):\s*\S/im)),
    text: '', textTruncated: false,
  };
}
export async function fetchMetadata(client: ImapFlow, uid: number, mailbox: string): Promise<EmailMessage | null> {
  const item = await client.fetchOne(String(uid), {
    envelope: true, flags: true, internalDate: true, bodyStructure: true,
    headers: ['references', 'in-reply-to'],
  }, { uid: true });
  return item ? metadataFromFetch(item, mailbox, currentValidity(client)) : null;
}
/** Find exact identities after a missing MOVE receipt. Only headers and receipt dates, never bodies. */
export async function findMatchingMetadata(client: ImapFlow, records: Pick<EmailMessage, 'messageId' | 'fingerprint'>[], mailbox: string, progress: (processed: number, total: number) => void = () => {}): Promise<Map<string, EmailMessage[]>> {
  const identities = new Set(records.map(record => record.fingerprint));
  const matches = new Map<string, EmailMessage[]>();
  // Some providers return false negatives for SEARCH HEADER Message-ID. Enumerate all UIDs
  // and compare local fingerprints so a failed header search never proves source absence.
  const found = await client.search({ all: true }, { uid: true });
  if (!Array.isArray(found) || new Set(found).size !== found.length) throw new AppError('邮箱返回的匹配结果无法完整核对，请在邮件 App 中检查位置。');
  progress(0, found.length);
  for (let start = 0; start < found.length; start += 100) {
      const batch = found.slice(start, start + 100); const requested = new Set(batch);
      const messages = await client.fetchAll(batch, { uid: true, envelope: true, internalDate: true, flags: true }, { uid: true });
      // A vanished candidate could be an external move during verification. Do not infer absence.
      if (messages.length !== batch.length || new Set(messages.map(message => message.uid)).size !== batch.length ||
        messages.some(message => !requested.has(message.uid) || !Number.isSafeInteger(message.uid) || message.uid < 1)) throw new AppError('核对时邮件位置发生变化，请再次核对。');
      for (const item of messages) {
        const message = metadataFromFetch(item, mailbox, currentValidity(client));
        if (identities.has(message.fingerprint)) matches.set(message.fingerprint, [...(matches.get(message.fingerprint) ?? []), message]);
      }
      progress(Math.min(start + 100, found.length), found.length);
  }
  return matches;
}
export async function fetchEmail(client: ImapFlow, uid: number, mailbox: string): Promise<EmailMessage | null> {
  const item = await client.fetchOne(String(uid), {
    envelope: true, flags: true, internalDate: true, bodyStructure: true,
    headers: ['references', 'in-reply-to'],
  }, { uid: true });
  if (!item) return null;
  const email = metadataFromFetch(item, mailbox, currentValidity(client));
  const part = bodyParts(item.bodyStructure).text;
  if (!part) return email;
  const download = await client.download(String(uid), part.part || 'TEXT', { uid: true, maxBytes: BODY_LIMIT, chunkSize: 32768 });
  if (!download.content) return email;
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of download.content) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    chunks.push(buffer);
  }
  const charset = (download.meta.charset || part.parameters?.charset || 'utf-8').replace(/[^a-zA-Z0-9_-]/g, '');
  const contentType = part.type === 'text/html' ? 'text/html' : 'text/plain';
  // download() decodes transfer encoding. A synthetic MIME wrapper gives mailparser charset/HTML handling.
  const raw = Buffer.concat([
    Buffer.from('Content-Type: ' + contentType + '; charset="' + charset + '"\r\nContent-Transfer-Encoding: 8bit\r\n\r\n'),
    ...chunks,
  ]);
  const parsed = await simpleParser(raw, { skipImageLinks: true, skipTextToHtml: true });
  email.text = (parsed.text ?? '').replace(/\0/g, '').trim();
  email.textTruncated = size >= BODY_LIMIT || (part.size ?? 0) > BODY_LIMIT;
  return email;
}
export function requireSafeMove(client: Pick<ImapFlow, 'capabilities'>): void {
  if (!client.capabilities.has('MOVE') || !client.capabilities.has('UIDPLUS')) {
    throw new AppError('邮箱服务器需要支持 MOVE 和 UIDPLUS 才能执行移动类动作并提供可靠撤销。当前仍可分析和使用标记动作。');
  }
}
