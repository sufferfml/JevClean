import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { vaultCipher } from '../src/local/cipher';

test('vault authenticates ciphertext; missing or inaccessible system keys never regenerate over existing data', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'jevclean-vault-')); let key: Uint8Array | undefined; let writes = 0;
  const cipher = vaultCipher(dir, { read: async () => key, write: async value => { key = value; writes++; } });
  try {
    const data = await cipher.encrypt('a test secret'); assert.equal(writes, 1); assert.equal(await cipher.decrypt(data), 'a test secret');
    const changed = Buffer.from(data); changed[changed.length - 1] ^= 1; await assert.rejects(cipher.decrypt(changed));
    await writeFile(join(dir, 'settings.enc'), data); key = undefined;
    await assert.rejects(cipher.encrypt('new secret'), /丢失/); await assert.rejects(cipher.decrypt(data)); assert.equal(writes, 1);
    const locked = vaultCipher(dir, { read: async () => { throw new Error('locked'); }, write: async () => { writes++; } });
    assert.equal(await locked.available(), false); await assert.rejects(locked.encrypt('secret')); assert.equal(writes, 1);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
