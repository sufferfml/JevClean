import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { Cipher } from '../core/storage';
import { AppError } from '../core/errors';

export interface KeyBackend { read(): Promise<Uint8Array | null | undefined>; write(key: Uint8Array): Promise<void> }
export function vaultCipher(directory: string, backend: KeyBackend): Cipher {
  const key = async (create: boolean) => {
    let bytes = await backend.read();
    if (!bytes && create) {
      const files = await readdir(directory).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return []; throw error; });
      if (files.some(file => file.endsWith('.enc'))) throw new AppError('现有加密数据的钥匙已丢失，不能生成新钥匙覆盖。');
      bytes = randomBytes(32); await backend.write(bytes);
    }
    if (!bytes || bytes.length !== 32) throw new AppError('系统凭据库中缺少有效的解密钥匙。');
    return Buffer.from(bytes);
  };
  return {
    available: async () => { try { await backend.read(); return true; } catch { return false; } },
    encrypt: async text => {
      const iv = randomBytes(12); const cipher = createCipheriv('aes-256-gcm', await key(true), iv);
      const data = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
      return Buffer.concat([Buffer.from('JVC1'), iv, cipher.getAuthTag(), data]);
    },
    decrypt: async data => {
      if (data.length < 32 || data.subarray(0, 4).toString() !== 'JVC1') throw new AppError('无效的加密文件。');
      const cipher = createDecipheriv('aes-256-gcm', await key(false), data.subarray(4, 16));
      cipher.setAuthTag(data.subarray(16, 32));
      return Buffer.concat([cipher.update(data.subarray(32)), cipher.final()]).toString('utf8');
    },
  };
}
export function systemCipher(directory: string): Cipher {
  let entry: Promise<import('@napi-rs/keyring').AsyncEntry> | undefined;
  const get = () => entry ??= import('@napi-rs/keyring').then(({ AsyncEntry }) => new AsyncEntry(
    'org.jevclean.local-vault', createHash('sha256').update(resolve(directory)).digest('hex'),
    { linux: { store: 'secret-service' } },
  ));
  return vaultCipher(directory, { read: async () => (await get()).getSecret(), write: async key => (await get()).setSecret(key) });
}
