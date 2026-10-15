import { execFile } from 'node:child_process';
import { chmod, mkdir, open, readFile, rm, writeFile } from 'node:fs/promises';
import { setTimeout as pause } from 'node:timers/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { LocalStore } from '../core/storage';
import { systemCipher } from './cipher';
import { LocalLogger } from './logger';
import { startLocalServer } from './server';

function openBrowser(url: string) {
  const [command, args] = process.platform === 'darwin' ? ['open', [url]] : process.platform === 'win32' ? ['rundll32', ['url.dll,FileProtocolHandler', url]] : ['xdg-open', [url]];
  execFile(command, args, error => { if (error) console.error('请在浏览器打开上方的本地地址。'); });
}
const defaultDirectory = process.platform === 'darwin' ? join(homedir(), 'Library', 'Application Support', 'JevClean') : process.platform === 'win32' ? join(process.env.APPDATA || homedir(), 'JevClean') : join(process.env.XDG_DATA_HOME || join(homedir(), '.local', 'share'), 'JevClean');
async function main() {
  const directory = resolve(process.env.JEVCLEAN_DATA_DIR || defaultDirectory); await mkdir(directory, { recursive: true, mode: 0o700 }); await chmod(directory, 0o700);
  const instanceFile = join(directory, 'instance.json');
  for (let attempt = 0; attempt < 10; attempt++) {
    try {
      const handle = await open(instanceFile, 'wx', 0o600);
      await handle.writeFile(JSON.stringify({ pid: process.pid }));
      let running: Awaited<ReturnType<typeof startLocalServer>> | undefined;
      const close = async () => { await running?.close(); await handle.close(); await rm(instanceFile, { force: true }); };
      try {
        const logger = new LocalLogger(directory);
        running = await startLocalServer({ store: new LocalStore(directory, systemCipher(directory)), webDirectory: join(dirname(resolve(process.argv[1])), 'web'), logger,
          onShutdown: () => { void close().then(() => process.exit(0)); } });
        await writeFile(instanceFile, JSON.stringify({ pid: process.pid, url: running.url }), { mode: 0o600 });
        console.log('JevClean 已启动，仅在本机运行：\n' + running.url);
        logger.record('service.started');
        if (!process.argv.includes('--no-open')) openBrowser(running.url);
        for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => { void close().then(() => process.exit(0)); });
        return;
      } catch (error) { await close(); throw error; }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      let instance: { pid: number; url?: string };
      try { instance = JSON.parse(await readFile(instanceFile, 'utf8')); } catch { await pause(100); continue; }
      if (!Number.isInteger(instance.pid) || instance.pid <= 0) throw new Error('invalid instance');
      let alive = true; try { process.kill(instance.pid, 0); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') alive = false; else throw error; }
      if (alive && !instance.url) { await pause(100); continue; }
      if (alive && !/^http:\/\/127\.0\.0\.1:\d+\/#session=[a-f0-9]{64}$/.test(instance.url!)) throw new Error('invalid instance');
      if (alive) {
        const logger = new LocalLogger(directory); logger.record('service.reopened'); await logger.entries();
        console.log('JevClean 已在运行：\n' + instance.url); if (!process.argv.includes('--no-open')) openBrowser(instance.url!); return;
      }
      await rm(instanceFile, { force: true });
    }
  }
  throw new Error('cannot acquire instance');
}
void main().catch(() => { console.error('JevClean 启动失败。请检查数据目录权限、系统凭据库和是否已有实例运行。'); process.exitCode = 1; });
