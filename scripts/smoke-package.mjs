import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { access, mkdtemp, readFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as pause } from 'node:timers/promises';
const app = resolve(process.argv[2] || 'release/JevClean.app'); const resources = join(app, 'Contents/Resources');
const node = join(resources, 'node'); const script = join(resources, 'server.cjs');
const directory = await mkdtemp(join(tmpdir(), 'jevclean-production-'));
const env = { ...process.env, JEVCLEAN_DATA_DIR: directory };
let child; let launchedPid; let launcherPid;
async function until(check, message) {
  for (let attempt = 0; attempt < 100; attempt++) { if (await check()) return; await pause(100); }
  throw new Error(message);
}
function alive(pid) { try { process.kill(pid, 0); return true; } catch { return false; } }
async function start() {
  child = spawn(node, [script, '--no-open'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  const url = await new Promise((accept, reject) => {
    const timeout = setTimeout(() => reject(new Error('Startup timeout')), 10000);
    child.stdout.on('data', data => { output += data; const found = output.match(/http:\/\/127\.0\.0\.1:\d+\/#session=[a-f0-9]{64}/); if (found) { clearTimeout(timeout); accept(found[0]); } });
    child.on('exit', code => { clearTimeout(timeout); reject(new Error('Startup exited ' + code)); });
  }); return new URL(url);
}
async function stop() {
  if (!child || child.exitCode !== null) return;
  const exit = new Promise(accept => child.once('exit', accept)); child.kill('SIGTERM'); await exit;
}
try {
  execFileSync('codesign', ['--verify', '--deep', '--strict', app], { stdio: 'pipe' });
  const linked = execFileSync('otool', ['-L', node], { encoding: 'utf8' }); assert.ok(!linked.includes('/opt/homebrew'));
  const launcherLinked = execFileSync('otool', ['-L', join(app, 'Contents/MacOS/JevClean')], { encoding: 'utf8' });
  assert.ok(launcherLinked.includes('/AppKit.framework/'), 'System launcher must run an AppKit event loop');
  let url = await start();
  const token = new URLSearchParams(url.hash.slice(1)).get('session'); const origin = url.origin;
  const request = (route, input) => fetch(origin + '/api/' + route, { method: input === undefined ? 'GET' : 'POST', headers: { 'X-JevClean-Token': token, ...(input === undefined ? {} : { 'Content-Type': 'application/json' }) }, ...(input === undefined ? {} : { body: JSON.stringify(input) }) });
  const initial = (await (await request('bootstrap')).json()).value; assert.equal(initial.config.secureStorage, true);
  await request('config', { settings: { ...initial.config.settings, email: 'synthetic@example.com', host: 'imap.example.com' }, imapPassword: 'synthetic-only-imap', jevApiKey: 'synthetic-only-jev' });
  const ciphertext = await readFile(join(directory, 'settings.enc')); assert.ok(!ciphertext.includes(Buffer.from('synthetic-only')));
  const second = execFileSync(node, [script, '--no-open'], { env, encoding: 'utf8', timeout: 10000 }); assert.ok(second.includes(origin));
  const crashed = new Promise(accept => child.once('exit', accept)); child.kill('SIGKILL'); await crashed; url = await start();
  const restarted = await fetch(url.origin + '/api/bootstrap', { headers: { 'X-JevClean-Token': new URLSearchParams(url.hash.slice(1)).get('session') } });
  const value = (await restarted.json()).value;
  assert.equal(value.config.hasJevApiKey, true); assert.ok(!JSON.stringify(value).includes('synthetic-only'));
  assert.equal((await fetch(url.origin + '/api/bootstrap')).status, 401);
  await stop();
  execFileSync('open', ['-n', '-g', '--env', 'JEVCLEAN_DATA_DIR=' + directory, app, '--args', '--no-open'], { stdio: 'pipe' });
  let launched;
  await until(async () => {
    try { const value = JSON.parse(await readFile(join(directory, 'instance.json'), 'utf8')); if (value.url) { launched = value; return true; } } catch {}
    return false;
  }, 'LaunchServices application startup failed');
  assert.ok(launched?.url, 'LaunchServices application startup failed'); launchedPid = launched.pid;
  launcherPid = Number(execFileSync('ps', ['-o', 'ppid=', '-p', String(launchedPid)], { encoding: 'utf8' }).trim());
  assert.ok(execFileSync('ps', ['-o', 'command=', '-p', String(launcherPid)], { encoding: 'utf8' }).includes(join(app, 'Contents/MacOS/JevClean')));
  const launchUrl = new URL(launched.url); const launchToken = new URLSearchParams(launchUrl.hash.slice(1)).get('session');
  const launchConfig = await fetch(launchUrl.origin + '/api/bootstrap', { headers: { 'X-JevClean-Token': launchToken } });
  assert.equal((await launchConfig.json()).value.config.hasJevApiKey, true);
  const logs = async () => (await (await fetch(launchUrl.origin + '/api/logs', { headers: { 'X-JevClean-Token': launchToken } })).json()).value;
  let reopened = (await logs()).filter(entry => entry.event === 'service.reopened').length;
  for (let attempt = 0; attempt < 2; attempt++) {
    // Ordinary open must reach the running app's reopen handler, not force a second app.
    execFileSync('open', ['-g', app], { stdio: 'pipe', timeout: 10000 });
    await until(async () => (await logs()).filter(entry => entry.event === 'service.reopened').length > reopened, 'System reopen did not reach the service');
    reopened = (await logs()).filter(entry => entry.event === 'service.reopened').length;
    assert.equal(JSON.parse(await readFile(join(directory, 'instance.json'), 'utf8')).pid, launchedPid, 'Reopening must preserve the service PID');
  }
  await fetch(launchUrl.origin + '/api/shutdown', { method: 'POST', headers: { 'X-JevClean-Token': launchToken, 'Content-Type': 'application/json' }, body: '{}' });
  await until(async () => !alive(launcherPid) && !(await access(join(directory, 'instance.json')).then(() => true, () => false)), 'Shutdown must stop both service and launcher');
  execFileSync('open', ['-g', '--env', 'JEVCLEAN_DATA_DIR=' + directory, app, '--args', '--no-open'], { stdio: 'pipe', timeout: 10000 });
  await until(async () => {
    try { const value = JSON.parse(await readFile(join(directory, 'instance.json'), 'utf8')); if (value.url) { launched = value; return true; } } catch {}
    return false;
  }, 'System application must start again after shutdown');
  launchedPid = launched.pid;
  launcherPid = Number(execFileSync('ps', ['-o', 'ppid=', '-p', String(launchedPid)], { encoding: 'utf8' }).trim());
  const finalUrl = new URL(launched.url);
  const finalToken = new URLSearchParams(finalUrl.hash.slice(1)).get('session');
  const finalConfig = await fetch(finalUrl.origin + '/api/bootstrap', { headers: { 'X-JevClean-Token': finalToken } });
  assert.equal((await finalConfig.json()).value.config.hasJevApiKey, true);
  await fetch(finalUrl.origin + '/api/shutdown', { method: 'POST', headers: { 'X-JevClean-Token': finalToken, 'Content-Type': 'application/json' }, body: '{}' });
  await until(() => !alive(launcherPid), 'Relaunched system app must exit after shutdown');
  console.log('生产应用通过：独立运行时、实际钥匙串加密与重启解密、单实例复用、异常退出后重启、系统应用连续再次打开、服务退出后系统重新启动、本地 HTTP 令牌和签名校验。没有连接真实邮箱或调用 Jev。');
} finally {
  await stop();
  if (launchedPid) { try { process.kill(launchedPid, 'SIGTERM'); } catch {} }
  if (launcherPid && alive(launcherPid)) { try { process.kill(launcherPid, 'SIGTERM'); } catch {} }
  const account = createHash('sha256').update(directory).digest('hex');
  execFileSync(node, ['-e', "const { AsyncEntry } = require('@napi-rs/keyring'); new AsyncEntry('org.jevclean.local-vault', process.argv[1]).deleteCredential().catch(() => { process.exitCode = 1 });", account], { cwd: resources, stdio: 'pipe' });
  await rm(directory, { recursive: true, force: true });
}
