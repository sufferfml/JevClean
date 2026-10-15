import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:tls';
import type { TLSSocket } from 'node:tls';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { ImapFlow } from 'imapflow';
import { bodyParts, fetchEmail, fetchMetadata, fetchReceiptTimes, findMatchingMetadata, requireSafeMove } from '../src/core/mailbox';

test('real IMAP protocol: read-only scan uses PEEK, INTERNALDATE, and UID STORE verifies flags and UID MOVE returns undo mapping', { timeout: 20000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'jevclean-imap-'));
  execFileSync('openssl', [
    'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
    '-subj', '/CN=localhost', '-keyout', join(dir, 'key.pem'), '-out', join(dir, 'cert.pem'),
    '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1',
  ], { stdio: 'ignore' });
  const cert = await readFile(join(dir, 'cert.pem'));
  const body = Buffer.from('Your verification code is 123456. Valid for 10 minutes.\r\n');
  const commands: string[] = []; const storedFlags = new Set<string>();
  const sockets = new Set<TLSSocket>();
  const server = createServer({ key: await readFile(join(dir, 'key.pem')), cert }, (socket) => {
    sockets.add(socket); socket.on('close', () => sockets.delete(socket)); socket.on('error', () => {});
    socket.write('* OK [CAPABILITY IMAP4rev1 AUTH=PLAIN SASL-IR UIDPLUS MOVE] test server\r\n');
    let buffer = '';
    socket.on('data', (data) => {
      buffer += data.toString();
      while (buffer.includes('\r\n')) {
        const end = buffer.indexOf('\r\n'); const line = buffer.slice(0, end); buffer = buffer.slice(end + 2);
        const separator = line.indexOf(' '); const tag = line.slice(0, separator); const command = line.slice(separator + 1);
        commands.push(command.startsWith('AUTHENTICATE') || command.startsWith('LOGIN') ? 'AUTH' : command);
        const ok = () => socket.write(tag + ' OK complete\r\n');
        if (command.startsWith('CAPABILITY')) { socket.write('* CAPABILITY IMAP4rev1 AUTH=PLAIN SASL-IR UIDPLUS MOVE\r\n'); ok(); }
        else if (/^(AUTHENTICATE|LOGIN)/.test(command)) ok();
        else if (/^(LIST|LSUB)/.test(command)) { socket.write('* LIST () "/" "INBOX"\r\n'); ok(); }
        else if (/^(EXAMINE|SELECT)/.test(command)) {
          socket.write('* FLAGS (\\Seen \\Flagged \\Answered \\Deleted)\r\n* 1 EXISTS\r\n* 0 RECENT\r\n* OK [UIDVALIDITY 999] valid\r\n* OK [UIDNEXT 43] next\r\n');
          socket.write(tag + ' OK [' + (command.startsWith('EXAMINE') ? 'READ-ONLY' : 'READ-WRITE') + '] selected\r\n');
        } else if (/^UID FETCH/.test(command) && /BODY\.PEEK\[(?:TEXT|1)\]/.test(command)) {
          const part = command.includes('[TEXT]') ? 'TEXT' : '1';
          socket.write('* 1 FETCH (UID 42 BODY[' + part + ']<0> {' + body.length + '}\r\n');
          socket.write(body); socket.write(')\r\n'); ok();
        } else if (/^UID FETCH/.test(command) && /BODY\.PEEK\[(?:HEADER|TEXT\.MIME|1\.MIME)\]/.test(command)) {
          const header = Buffer.from('Content-Type: text/plain; charset=utf-8\r\nContent-Transfer-Encoding: 7bit\r\n\r\n');
          const part = command.includes('[HEADER]') ? 'HEADER' : command.includes('[TEXT.MIME]') ? 'TEXT.MIME' : '1.MIME';
          socket.write('* 1 FETCH (UID 42 BODY[' + part + '] {' + header.length + '}\r\n'); socket.write(header); socket.write(')\r\n'); ok();
        } else if (/^UID FETCH/.test(command)) {
          // An attacker-controlled Date is years old; INTERNALDATE says it just arrived.
          socket.write('* 1 FETCH (UID 42 FLAGS (' + [...storedFlags].join(' ') + ') INTERNALDATE "02-Oct-2026 11:59:00 +0000" ENVELOPE ("Mon, 01 Jan 2001 00:00:00 +0000" "Verification code" (("Example" NIL "auth" "example.com")) NIL NIL NIL NIL NIL NIL "<one@example.com>") BODYSTRUCTURE ("TEXT" "PLAIN" ("CHARSET" "UTF-8") NIL NIL "7BIT" ' + body.length + ' 1) BODY[HEADER.FIELDS (REFERENCES IN-REPLY-TO)] {2}\r\n\r\n)\r\n');
          ok();
        } else if (/^UID SEARCH/.test(command)) { socket.write('* SEARCH 42\r\n'); ok();
        } else if (/^UID STORE/.test(command)) {
          const flags = command.match(/\\(?:Seen|Flagged)/g) ?? [];
          for (const flag of flags) { if (/\+FLAGS/.test(command)) storedFlags.add(flag); else storedFlags.delete(flag); }
          socket.write('* 1 FETCH (UID 42 FLAGS (' + [...storedFlags].join(' ') + '))\r\n'); ok();
        } else if (/^UID MOVE/.test(command)) {
          socket.write('* OK [COPYUID 888 42 101] moved\r\n* 1 EXPUNGE\r\n'); ok();
        } else if (command === 'LOGOUT') { socket.write('* BYE goodbye\r\n'); ok(); socket.end(); }
        else if (/^(NOOP|UNSELECT|CREATE|SUBSCRIBE)/.test(command)) ok();
        else socket.write(tag + ' BAD unsupported test command\r\n');
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const client = new ImapFlow({ host: '127.0.0.1', port: address.port, secure: true, tls: { ca: cert, rejectUnauthorized: true }, auth: { user: 'test@example.com', pass: 'test-only-password' }, logger: false, disableAutoIdle: true, socketTimeout: 5000, connectionTimeout: 5000 });
  client.on('error', () => {});
  try {
    await client.connect();
    const lock = await client.getMailboxLock('INBOX', { readOnly: true });
    const countCommands = commands.length;
    const times = await fetchReceiptTimes(client, [42]);
    assert.equal(times.get(42), Date.parse('2026-10-02T11:59:00Z'));
    const selectionCommands = commands.slice(countCommands);
    assert.ok(selectionCommands.some(command => /^UID FETCH 42 \(UID INTERNALDATE\)$/.test(command)));
    assert.ok(selectionCommands.every(command => !command.includes('BODY')));
    const message = await fetchEmail(client, 42, 'INBOX');
    assert.ok(message); assert.ok(message.text.includes('123456')); assert.equal(message.date, '2026-10-02T11:59:00.000Z');
    assert.equal(message.flags.includes('\\Seen'), false); assert.equal(message.uidValidity, '999');
    assert.equal((await fetchMetadata(client, 42, 'INBOX'))?.fingerprint, message.fingerprint);
    const beforeCheck = commands.length;
    const matches = await findMatchingMetadata(client, [message], 'INBOX');
    assert.equal(matches.get(message.fingerprint)?.[0].uid, 42);
    assert.ok(commands.slice(beforeCheck).some(command => /^UID SEARCH ALL$/.test(command)));
    assert.ok(commands.slice(beforeCheck).every(command => !command.includes('BODY')));
    lock.release();
    const beforeMutation = commands.length;
    const writable = await client.getMailboxLock('INBOX', { readOnly: false });
    assert.equal(await client.messageFlagsAdd('42', ['\\Seen', '\\Flagged'], { uid: true }), true);
    assert.ok((await fetchMetadata(client, 42, 'INBOX'))!.flags.includes('\\Seen'));
    assert.equal(await client.messageFlagsRemove('42', ['\\Seen'], { uid: true }), true);
    const flagState = (await fetchMetadata(client, 42, 'INBOX'))!;
    assert.ok(!flagState.flags.includes('\\Seen')); assert.ok(flagState.flags.includes('\\Flagged'));
    requireSafeMove(client);
    const result = await client.messageMove('42', 'JevClean - Pending cleanup', { uid: true });
    assert.ok(result); assert.equal(result.uidMap?.get(42), 101); assert.equal(result.uidValidity?.toString(), '888');
    writable.release();
    assert.ok(commands.some((command) => command.startsWith('EXAMINE')));
    assert.ok(commands.some((command) => command.startsWith('UID MOVE 42')));
    assert.ok(commands.slice(0, beforeMutation).every((command) => !/^UID STORE/.test(command)) && commands.every(command => !/^UID (?:COPY|EXPUNGE)|^EXPUNGE/.test(command)));
    assert.ok(commands.filter((command) => command.includes('BODY[') || command.includes('BODY.PEEK[')).every((command) => !command.includes('BODY[')));
  } finally {
    if (client.usable) await client.logout().catch(() => client.close()); else client.close();
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(dir, { recursive: true, force: true });
  }
});
test('servers lacking MOVE or UIDPLUS are refused before any destructive fallback', () => {
  for (const capabilities of [new Map([['UIDPLUS', true]]), new Map([['MOVE', true]]), new Map()]) {
    assert.throws(() => requireSafeMove({ capabilities }), /MOVE 和 UIDPLUS/);
  }
});
test('receipt selection batches large mailboxes and cancellation stops before the next batch', async () => {
  const controller = new AbortController(); const batches: number[][] = [];
  const client = {
    fetchAll: async (uids: number[]) => {
      batches.push(uids);
      if (batches.length === 2) controller.abort();
      return uids.map(uid => ({ uid, internalDate: new Date('2026-10-01') }));
    },
  } as unknown as ImapFlow;
  const uids = Array.from({ length: 2500 }, (_, index) => index + 1);
  await assert.rejects(fetchReceiptTimes(client, uids, controller.signal), { name: 'AbortError' });
  assert.deepEqual(batches.map(batch => batch.length), [1000, 1000]);
});
test('MIME selection avoids attachment contents and detects PDFs', () => {
  const parts = bodyParts({ type: 'multipart/mixed', childNodes: [
    { type: 'text/plain', part: '1', size: 80 },
    { type: 'application/pdf', part: '2', disposition: 'attachment', size: 5000000 },
  ] });
  assert.equal(parts.text?.part, '1'); assert.equal(parts.hasAttachment, true);
});

test('multipart messages download only their text body even when an attachment is present', async () => {
  const downloads: string[] = [];
  const client = {
    mailbox: { uidValidity: 1n },
    fetchOne: async () => ({ uid: 42, internalDate: new Date('2026-10-01'), envelope: { subject: 'Attachment mail' }, flags: new Set(), bodyStructure: { type: 'multipart/mixed', childNodes: [
      { type: 'text/plain', part: '1', size: 30 }, { type: 'application/pdf', part: '2', disposition: 'attachment', size: 500000 },
    ] } }),
    download: async (_uid: string, part: string) => { downloads.push(part); return { meta: { charset: 'utf-8' }, content: Readable.from(['Only the mail text.']) }; },
  } as unknown as ImapFlow;
  const message = await fetchEmail(client, 42, 'INBOX');
  assert.equal(message?.hasAttachment, true); assert.equal(message?.text, 'Only the mail text.'); assert.deepEqual(downloads, ['1']);
});
