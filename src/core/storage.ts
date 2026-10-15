import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { defaultSettings, saveInputSchema, settingsSchema } from '../shared/contracts';
import type { AnalysisTrace, PublicConfig, SaveInput, ScanReport, Secrets, Settings } from '../shared/contracts';
import { AppError } from './errors';
import { judgmentHash, policyHash } from './rules';

export interface Cipher { available(): Promise<boolean>; encrypt(text: string): Promise<Buffer>; decrypt(ciphertext: Buffer): Promise<string> }
interface SavedConfig { settings: Settings; secrets: Secrets }
interface DiagnosticsBatch { reportId: string; createdAt: string; expiresAt: string }
export const DIAGNOSTICS_MAX_BYTES = 50 * 1024 * 1024;
export const DIAGNOSTICS_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
export class DiagnosticsStorageError extends AppError {
  constructor(message: string, public readonly code: 'diagnostics_capacity' | 'diagnostics_batch' | 'diagnostics_invalid') { super(message); this.name = 'DiagnosticsStorageError'; }
}
const reportIdPattern = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
function diagnosticIds(reportId: string, recordId?: string) {
  if (!reportIdPattern.test(reportId) || (recordId !== undefined && !/^[A-Za-z0-9:_-]{1,256}$/.test(recordId))) {
    throw new DiagnosticsStorageError('调用记录标识无效。', 'diagnostics_invalid');
  }
}
export class LocalStore {
  private diagnosticsQueue: Promise<unknown> = Promise.resolve();
  constructor(private directory: string, private cipher: Cipher) {}
  secure() { return this.cipher.available(); }
  private async read<T>(file: string): Promise<T | null> {
    let encrypted: Buffer;
    try { encrypted = await readFile(join(this.directory, file)); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
    try { return JSON.parse(await this.cipher.decrypt(encrypted)) as T; }
    catch { throw new AppError('本地加密数据无法解锁。请使用原系统用户及钥匙串；应用不会覆盖现有密钥。'); }
  }
  private async write(file: string, value: unknown, maxBytes = Infinity) {
    if (!(await this.secure())) throw new AppError('系统凭据库不可用，请解锁钥匙串。应用不会明文保存数据。');
    const destination = join(this.directory, file);
    await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
    let encrypted: Buffer;
    try { encrypted = await this.cipher.encrypt(JSON.stringify(value)); }
    catch { throw new AppError('无法加密本地数据。请检查系统凭据库，现有数据未被覆盖。'); }
    if (encrypted.byteLength > maxBytes) throw new DiagnosticsStorageError('完整调用记录已达到 50 MiB 上限，分析已停止。请清除记录后再分析。', 'diagnostics_capacity');
    const temporary = join(dirname(destination), '.' + randomUUID() + '.tmp');
    try { await writeFile(temporary, encrypted, { mode: 0o600 }); await rename(temporary, destination); }
    finally { await rm(temporary, { force: true }); }
  }
  async config(): Promise<SavedConfig> {
    const saved = await this.read<SavedConfig>('settings.enc');
    if (!saved) return { settings: structuredClone(defaultSettings), secrets: { imapPassword: '', jevApiKey: '' } };
    const parsed = settingsSchema.safeParse(saved.settings);
    if (!parsed.success || typeof saved.secrets?.imapPassword !== 'string' || typeof saved.secrets?.jevApiKey !== 'string') throw new AppError('本地配置格式不正确。');
    return { settings: parsed.data, secrets: saved.secrets };
  }
  async publicConfig(): Promise<PublicConfig> {
    const { settings, secrets } = await this.config();
    return { settings, hasImapPassword: !!secrets.imapPassword, hasJevApiKey: !!secrets.jevApiKey, secureStorage: await this.secure(), policyHash: policyHash(settings), judgmentHash: judgmentHash(settings) };
  }
  async saveConfig(input: SaveInput): Promise<PublicConfig> {
    const parsed = saveInputSchema.safeParse(input);
    if (!parsed.success) throw new AppError('配置格式不正确，请检查邮箱、服务器和规则。');
    input = parsed.data;
    const old = await this.config();
    const changed = old.settings.email.toLowerCase() !== input.settings.email.toLowerCase() || old.settings.host.toLowerCase() !== input.settings.host.toLowerCase() || old.settings.port !== input.settings.port;
    await this.write('settings.enc', { settings: input.settings, secrets: {
      imapPassword: input.imapPassword || (changed ? '' : old.secrets.imapPassword),
      jevApiKey: input.jevApiKey?.trim() || old.secrets.jevApiKey,
    } });
    return this.publicConfig();
  }
  async forgetCredentials() {
    const saved = await this.config();
    await this.write('settings.enc', { settings: saved.settings, secrets: { imapPassword: '', jevApiKey: '' } });
    return this.publicConfig();
  }
  private async report(file: string): Promise<ScanReport | null> {
    const report = await this.read<ScanReport>(file);
    if (!report) return null;
    if (!Array.isArray(report.records) || !Array.isArray(report.mailboxes) || !/^[a-f0-9-]{36}$/.test(report.id)) throw new AppError('扫描记录格式不正确。');
    let changed = false;
    for (const record of report.records) {
      if (record.status === 'moving' || record.status === 'restoring') {
        record.status = 'uncertain'; record.error = '上次操作未完整记录。请核对邮件位置或标记，勿重复执行。'; changed = true;
      }
      if (report.status === 'running' && report.kind !== 'mail' && record.status === 'pending' && !record.operation &&
          !record.verdicts.length && record.analysis?.attempts.length && !record.analysis.error) {
        // A response can be durable before classification finishes. Preserve its true status/usage;
        // it is still an incomplete judgment, not permission to act or proof the request was free.
        record.analysis.error = '上次分析未保存完整判断，可以只重试这封邮件。之前的调用可能已消耗额度。';
        record.reason = record.analysis.error; record.category = 'review'; record.eligible = false; changed = true;
      }
    }
    if (report.status === 'running') { report.status = 'cancelled'; changed = true; }
    if (changed) await this.write(file, report);
    return report;
  }
  loadReport() { return this.report('report.enc'); }
  loadAction() { return this.report('last-action.enc'); }
  saveReport(report: ScanReport) { return this.write('report.enc', report); }
  saveAction(report: ScanReport) { return this.write('last-action.enc', report); }
  private diagnosticsTask<T>(task: () => Promise<T>): Promise<T> {
    const pending = this.diagnosticsQueue.then(task);
    this.diagnosticsQueue = pending.catch(() => {});
    return pending;
  }
  private async diagnosticsBatch(): Promise<DiagnosticsBatch | null> {
    const batch = await this.read<DiagnosticsBatch>('diagnostics/batch.enc');
    if (!batch) return null;
    if (!reportIdPattern.test(batch.reportId) || !Number.isFinite(Date.parse(batch.createdAt)) ||
        Date.parse(batch.expiresAt) !== Date.parse(batch.createdAt) + DIAGNOSTICS_RETENTION_MS) {
      throw new DiagnosticsStorageError('完整调用记录的保留信息无效。', 'diagnostics_invalid');
    }
    return batch;
  }
  private async removeDiagnostics() { await rm(join(this.directory, 'diagnostics'), { recursive: true, force: true }); }
  private traceFile(recordId: string) { return 'diagnostics/trace-' + createHash('sha256').update(recordId).digest('hex') + '.enc'; }
  private async initializeDiagnostics(reportId: string, now: Date): Promise<void> {
    diagnosticIds(reportId);
    if (!Number.isFinite(now.getTime())) throw new DiagnosticsStorageError('调用记录时间无效。', 'diagnostics_invalid');
    if (!(await this.secure())) throw new AppError('系统凭据库不可用，请解锁钥匙串。应用不会明文保存数据。');
    const staged = '.diagnostics-' + randomUUID() + '.enc';
    try {
      // Verify encryption and persistence before discarding the previous batch.
      await this.write(staged, { reportId, createdAt: now.toISOString(), expiresAt: new Date(now.getTime() + DIAGNOSTICS_RETENTION_MS).toISOString() });
      await this.removeDiagnostics();
      await mkdir(join(this.directory, 'diagnostics'), { recursive: true, mode: 0o700 });
      await rename(join(this.directory, staged), join(this.directory, 'diagnostics', 'batch.enc'));
    } finally { await rm(join(this.directory, staged), { force: true }); }
  }
  /** Full request/response bodies are opt-in and live separately from reports and undo receipts. */
  startDiagnostics(reportId: string, now: Date): Promise<void> {
    return this.diagnosticsTask(() => this.initializeDiagnostics(reportId, now));
  }
  ensureDiagnostics(reportId: string, startedAt: Date, now = new Date()): Promise<void> {
    return this.diagnosticsTask(async () => {
      diagnosticIds(reportId);
      if (!Number.isFinite(startedAt.getTime()) || !Number.isFinite(now.getTime()) || startedAt.getTime() > now.getTime()) {
        throw new DiagnosticsStorageError('调用记录时间无效。', 'diagnostics_invalid');
      }
      if (now.getTime() >= startedAt.getTime() + DIAGNOSTICS_RETENTION_MS) throw new DiagnosticsStorageError('完整调用记录已超过 7 天保留期限，请重新分析。', 'diagnostics_batch');
      const batch = await this.diagnosticsBatch();
      if (batch) {
        if (batch.reportId !== reportId || batch.createdAt !== startedAt.toISOString()) throw new DiagnosticsStorageError('已有其他分析的完整调用记录，不能混入本次重试。', 'diagnostics_batch');
        return;
      }
      await this.initializeDiagnostics(reportId, startedAt);
    });
  }
  saveTrace(trace: AnalysisTrace): Promise<void> {
    return this.diagnosticsTask(async () => {
      diagnosticIds(trace.reportId, trace.recordId);
      const batch = await this.diagnosticsBatch();
      if (!batch || trace.reportId !== batch.reportId) throw new DiagnosticsStorageError('这次分析的完整调用记录已不再保留。', 'diagnostics_batch');
      if (typeof trace.requestText !== 'string' || !Array.isArray(trace.attempts) ||
          !Number.isFinite(Date.parse(trace.createdAt)) || Date.parse(trace.createdAt) < Date.parse(batch.createdAt) || Date.parse(trace.createdAt) >= Date.parse(batch.expiresAt)) {
        throw new DiagnosticsStorageError('完整调用记录格式无效。', 'diagnostics_invalid');
      }
      const file = this.traceFile(trace.recordId); const destination = join(this.directory, file);
      const files = await readdir(join(this.directory, 'diagnostics'), { withFileTypes: true });
      let usedBytes = 0;
      for (const entry of files) {
        if (!entry.isFile() || !entry.name.endsWith('.enc')) continue;
        const path = join(this.directory, 'diagnostics', entry.name);
        if (path !== destination) usedBytes += (await stat(path)).size;
      }
      // Updates replace one encrypted file; a growing response can never silently evict earlier evidence.
      await this.write(file, { ...trace, expiresAt: batch.expiresAt }, Math.max(0, DIAGNOSTICS_MAX_BYTES - usedBytes));
    });
  }
  loadTrace(reportId: string, recordId: string, now: Date): Promise<AnalysisTrace | null> {
    return this.diagnosticsTask(async () => {
      diagnosticIds(reportId, recordId);
      if (!Number.isFinite(now.getTime())) throw new DiagnosticsStorageError('调用记录时间无效。', 'diagnostics_invalid');
      const batch = await this.diagnosticsBatch();
      if (!batch) return null;
      if (now.getTime() >= Date.parse(batch.expiresAt)) { await this.removeDiagnostics(); return null; }
      if (batch.reportId !== reportId) return null;
      const trace = await this.read<AnalysisTrace>(this.traceFile(recordId));
      if (trace && (trace.reportId !== reportId || trace.recordId !== recordId || trace.expiresAt !== batch.expiresAt)) {
        throw new DiagnosticsStorageError('完整调用记录与当前记录标识不一致。', 'diagnostics_invalid');
      }
      return trace;
    });
  }
  purgeExpiredDiagnostics(now: Date): Promise<void> {
    return this.diagnosticsTask(async () => {
      if (!Number.isFinite(now.getTime())) throw new DiagnosticsStorageError('调用记录时间无效。', 'diagnostics_invalid');
      const batch = await this.diagnosticsBatch();
      if (!batch || now.getTime() >= Date.parse(batch.expiresAt)) await this.removeDiagnostics();
    });
  }
  clearDiagnostics(): Promise<void> { return this.diagnosticsTask(() => this.removeDiagnostics()); }
  async deleteReports() {
    await Promise.all(['report.enc', 'last-action.enc'].map(file => rm(join(this.directory, file), { force: true })));
    await this.clearDiagnostics();
  }
}
