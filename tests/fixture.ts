import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import type { ImapFlow } from 'imapflow';
import { MailService, QUARANTINE } from '../src/core/service';
import { LocalStore } from '../src/core/storage';
import { type Evaluate } from '../src/core/jev';
import { email, evaluator, now, settings, testCipher } from './helpers';

export async function fixture(evaluate: Evaluate = evaluator()) {
  const dir = await mkdtemp(join(tmpdir(), 'jevclean-actions-'));
  const store = new LocalStore(dir, testCipher());
  await store.saveConfig({ settings, imapPassword: 'test-password', jevApiKey: 'test-key' });
  const mail = email();
  let flagged = false, wrongIdentity = false, wrongValidity = false, omitReceipt = false, moveCalls = 0, flagCalls = 0;
  let currentPath = 'INBOX';
  const original = new Map([[42, mail]]);
  const quarantine = new Map<number, typeof mail>();
  const archive = new Map<number, typeof mail>();
  const junk = new Map<number, typeof mail>(); const legacy = new Map<number, typeof mail>();
  const folders = new Map([['INBOX', original], ['Trash', quarantine], [QUARANTINE, legacy], ['Archive', archive], ['Junk', junk]]);
  const validity = (path: string) => path === 'INBOX' ? 999n : path === 'Trash' || path === QUARANTINE ? 888n : 777n;
  const locks: Array<{ path: string; readOnly: boolean }> = [];
  const downloads: Array<{ path: string; uid: number }> = [];
  const receiptFetches: Array<{ path: string; uids: number[]; query: object; options: object }> = [];
  const client = {
    capabilities: new Map([['MOVE', true], ['UIDPLUS', true]]),
    mailbox: { uidValidity: 999n },
    getMailboxLock: async (path: string, options?: { readOnly?: boolean }) => {
      currentPath = path;
      locks.push({ path, readOnly: options?.readOnly === true });
      client.mailbox = { uidValidity: wrongValidity ? 123n : validity(path) };
      return { release: () => {} };
    },
    search: async () => [...folders.get(currentPath)!.keys()],
    list: async () => [...folders.keys()].map(path => ({ path, name: path, flags: new Set(), specialUse: path === 'Trash' ? '\\Trash' : path === 'Archive' ? '\\Archive' : path === 'Junk' ? '\\Junk' : undefined })),
    fetchAll: async (uids: number[], query: { envelope?: boolean }, options: object) => {
      receiptFetches.push({ path: currentPath, uids, query, options });
      return uids.flatMap(uid => {
        const message = folders.get(currentPath)!.get(uid);
        return message ? [{ uid, internalDate: message.date, flags: new Set(message.flags), ...(query.envelope ? { envelope: {
          subject: message.subject, messageId: message.messageId, from: [{ name: message.sender, address: message.senderAddress }],
        } } : {}) }] : [];
      });
    },
    fetchOne: async (value: string) => {
      const message = folders.get(currentPath)!.get(Number(value));
      if (!message) return false;
      return {
        uid: Number(value), seq: 1, internalDate: message.date,
        envelope: { subject: wrongIdentity ? 'different email' : message.subject, messageId: message.messageId, from: [{ name: message.sender, address: message.senderAddress }] },
        flags: new Set(flagged ? [...message.flags, '\\Flagged'] : message.flags),
        bodyStructure: { type: 'text/plain', part: '1', size: 80 },
      };
    },
    download: async (uid: string) => {
      downloads.push({ path: currentPath, uid: Number(uid) });
      return { meta: { charset: 'utf-8' }, content: Readable.from([Buffer.from(folders.get(currentPath)!.get(Number(uid))?.text || '')]) };
    },
    messageMove: async (value: string, destination: string) => {
      moveCalls++;
      const source = folders.get(currentPath)!;
      const target = folders.get(destination)!;
      const message = source.get(Number(value));
      if (!message) return false;
      source.delete(Number(value));
      let uid = destination === QUARANTINE || destination === 'Trash' ? Number(value) + 59 : Number(value) + 41;
      while (target.has(uid)) uid++;
      target.set(uid, { ...message, uid });
      return omitReceipt ? { destination } : { uidMap: new Map([[Number(value), uid]]), uidValidity: validity(destination) };
    },
    messageFlagsAdd: async (value: string, flags: string[]) => {
      flagCalls++; const message = folders.get(currentPath)!.get(Number(value)); if (!message) return false;
      message.flags = [...new Set([...message.flags, ...flags])]; return true;
    },
    messageFlagsRemove: async (value: string, flags: string[]) => {
      flagCalls++; const message = folders.get(currentPath)!.get(Number(value)); if (!message) return false;
      message.flags = message.flags.filter(flag => !flags.includes(flag)); return true;
    },
  };
  const service = new MailService(store, () => {}, async (_settings, _password, operation) => operation(client as unknown as ImapFlow), () => evaluate, () => now);
  return {
    dir, store, service, client, original, quarantine, archive, junk, legacy, folders, locks, downloads, receiptFetches, connect: (async (_settings, _password, operation) => operation(client as unknown as ImapFlow)) as typeof import('../src/core/mailbox').withConnection,
    get moveCalls() { return moveCalls; },
    get flagCalls() { return flagCalls; },
    flag: () => { flagged = true; }, changeIdentity: () => { wrongIdentity = true; },
    changeValidity: () => { wrongValidity = true; }, omitReceipt: () => { omitReceipt = true; },
    cleanup: () => rm(dir, { recursive: true, force: true }),
  };
}
