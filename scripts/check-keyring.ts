import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AsyncEntry } from '@napi-rs/keyring';
import { LocalStore } from '../src/core/storage';
import { vaultCipher } from '../src/local/cipher';
import { defaultSettings } from '../src/shared/contracts';
const directory = await mkdtemp(join(tmpdir(), 'jevclean-native-'));
const entry = new AsyncEntry('org.jevclean.native-test', randomUUID(), { linux: { store: 'secret-service' } });
try {
  const backend = { read: () => entry.getSecret(), write: (key: Uint8Array) => entry.setSecret(key) };
  const store = new LocalStore(directory, vaultCipher(directory, backend));
  await store.saveConfig({ settings: defaultSettings, imapPassword: 'synthetic-imap-value', jevApiKey: 'synthetic-jev-value' });
  const restarted = new LocalStore(directory, vaultCipher(directory, backend));
  assert.equal((await restarted.config()).secrets.jevApiKey, 'synthetic-jev-value');
  await restarted.forgetCredentials(); assert.equal((await restarted.publicConfig()).hasJevApiKey, false);
  console.log('系统凭据库读写、本地加密、重启解密与凭据清除通过。仅使用临时测试条目。');
} finally { await entry.deleteCredential(); await rm(directory, { recursive: true, force: true }); }
