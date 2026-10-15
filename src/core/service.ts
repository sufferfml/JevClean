/** INPUT: validated local config, IMAP/Jev providers and clock. OUTPUT: reports and recoverable actions. POS: serialized orchestration; see ./AGENTS.md. */
import { createHash, randomUUID } from 'node:crypto';
import type { ImapFlow } from 'imapflow';
import type { ActionPreflight, ActionCheckResult, ActionResult, AnalysisSettingsInput, AnalysisTrace, Classification, CleanupSummary, EmailMessage, JevAttempt, MailLocation, MailRecord, ManualInput, ManualPlan, MessagePreview, OperationDiagnostic, OperationDiagnosticReason, Progress, SaveInput, ScanReport, Settings } from '../shared/contracts';
import { AppError } from './errors';
import { buildJevRequest, classifyMessage } from './classifier';
import { createEvaluator, JevError, testEvaluator } from './jev';
import { accountIdentity, currentValidity, fetchEmail, fetchMetadata, fetchReceiptTimes, findMatchingMetadata, listMailboxes, requireSafeMove, withConnection } from './mailbox';
import { JEV_MODEL, MIN_PROBABILITY, judgmentHash, mergeRuleActions, policyHash, sameJudgment } from './rules';
import { LocalStore } from './storage';
import { actionLabel, actionIds, canExecute, canSelect, canRetryAnalysis, currentLocation, operationAction, flagAction, isFolderAction } from '../shared/contracts';
import { assessExecution, checkRuleActions, resolveDestination } from './actions';

export const QUARANTINE = 'JevClean - Pending cleanup';
const connectionFailureCodes = new Set(['ETIMEDOUT', 'ETIMEOUT', 'ECONNRESET', 'EPIPE', 'SocketTimeout', 'NoConnection', 'EConnectionClosed', 'CONNECT_TIMEOUT', 'GREETING_TIMEOUT', 'ClosedAfterConnectTLS', 'ClosedAfterConnectText']);
function connectionFailure(error: unknown) {
  return !!error && typeof error === 'object' && 'code' in error && typeof error.code === 'string' && connectionFailureCodes.has(error.code);
}
export function eligibleForMove(record: MailRecord) {
  return canExecute(record);
}
function completeLocation(location: Partial<MailLocation>): location is MailLocation {
  return !!location.mailbox && !!location.uidValidity && Number.isSafeInteger(location.uid) && location.uid! > 0;
}
function sameLocation(left: Partial<MailLocation>, right: Partial<MailLocation>) {
  return completeLocation(left) && completeLocation(right) && left.mailbox === right.mailbox && left.uidValidity === right.uidValidity && left.uid === right.uid;
}
function operationLocations(record: MailRecord): MailLocation[] {
  const locations = [...(record.operationLocations ?? []), { mailbox: record.mailbox, uidValidity: record.uidValidity, uid: record.uid },
    { mailbox: record.destinationPath, uidValidity: record.destinationUidValidity, uid: record.destinationUid }].filter(completeLocation);
  return locations.filter((location, index) => locations.findIndex(other => sameLocation(location, other)) === index);
}
function sameOperationIdentity(record: MailRecord, operation: MailRecord) {
  return record.fingerprint === operation.fingerprint && operationLocations(record).some(location => operationLocations(operation).some(other => sameLocation(location, other)));
}
function affectedByUnknownOperation(message: MailLocation & { fingerprint: string }, record: MailRecord) {
  if (canSelect(record) || message.fingerprint !== record.fingerprint) return false;
  if (operationLocations(record).some(location => sameLocation(location, message))) return true;
  if (!isFolderAction(operationAction(record))) return false;
  // A missing MOVE receipt gives no destination UID. Block only candidates in that operation's
  // expected destination, without treating their fingerprint as a proven identity mapping.
  const restoring = record.lastOperation === 'restore';
  const mailbox = restoring ? record.mailbox : record.destinationPath ?? record.operation?.targetMailbox ?? record.targetMailbox;
  const uidValidity = restoring ? record.uidValidity : record.destinationUidValidity;
  return (restoring || !record.destinationUid) && !!uidValidity && message.mailbox === mailbox && message.uidValidity === uidValidity;
}
export class MailService {
  private controller?: AbortController;
  private busy = false;
  private report: ScanReport | null | undefined;
  private action: ScanReport | null | undefined;
  private preflight?: ActionPreflight;
  private diagnosticsCheckedAt = 0;
  private connectionChecked?: { identity: string; password: string; checkedAt: string };
  private manualPlan?: { value: ManualPlan; reportId: string; account: string; folders: string; snapshots: string; records: MailRecord[] };
  constructor(private store: LocalStore, private emit: (progress: Progress) => void,
    private connect: typeof withConnection = withConnection, private evaluatorFactory = createEvaluator, private clock = () => new Date(),
    private diagnose: (entry: OperationDiagnostic) => void = () => {}) {}
  private operationDiagnostic(event: OperationDiagnostic['event'], details: OperationDiagnostic['details']) {
    try { this.diagnose({ event, details }); } catch { /* Diagnostics cannot change an operation's result. */ }
  }
  private emitAction(progress: Progress, action: ScanReport) {
    const report = progress.report ?? this.report ?? action;
    const operations = new Map<string, MailRecord[]>();
    for (const record of action.records) operations.set(record.fingerprint, [...(operations.get(record.fingerprint) ?? []), record]);
    const operationIds = report.accountIdentity === action.accountIdentity
      ? report.records.filter(row => operations.get(row.fingerprint)?.some(record => sameOperationIdentity(row, record))).map(row => row.id) : [];
    this.emit({ ...progress, report, operationIds });
  }
  ensureIdle() { if (this.busy) throw new AppError('请等待当前任务完成，或先停止分析。'); }
  get isBusy() { return this.busy; }
  async exclusive<T>(task: () => Promise<T>): Promise<T> {
    this.ensureIdle(); this.busy = true;
    try { return await task(); } finally { this.busy = false; }
  }
  private async configured(requireJev = false) {
    const config = await this.store.config();
    if (!config.settings.email || !config.settings.host || !config.secrets.imapPassword) throw new AppError('请先保存邮箱地址、IMAP 服务器和专用密码。');
    if (requireJev && !config.secrets.jevApiKey) throw new AppError('请先保存你的 Jev API key。');
    return config;
  }
  async publicConfig() {
    if (this.clock().getTime() - this.diagnosticsCheckedAt >= 60000) {
      await this.store.purgeExpiredDiagnostics(this.clock()); this.diagnosticsCheckedAt = this.clock().getTime();
    }
    const value = await this.store.publicConfig(); const { secrets } = await this.store.config();
    const checked = this.connectionChecked;
    const connected = !!checked && checked.identity === accountIdentity(value.settings) && checked.password === secrets.imapPassword;
    return { ...value, accountIdentity: accountIdentity(value.settings), mailConnection: { connected, ...(connected ? { checkedAt: checked.checkedAt } : {}) } };
  }
  private async connection<T>(settings: Settings, password: string, operation: (client: ImapFlow) => Promise<T>, signal?: AbortSignal): Promise<T> {
    try {
      return await this.connect(settings, password, async client => {
        this.connectionChecked = { identity: accountIdentity(settings), password, checkedAt: this.clock().toISOString() };
        return operation(client);
      }, signal);
    } catch (error) { this.connectionChecked = undefined; throw error; }
  }
  saveConfig(input: SaveInput) { return this.exclusive(async () => {
    const report = await this.loadReport(); const old = await this.store.config();
    await this.store.saveConfig(input); const current = await this.store.config();
    if (old.settings.detailedDiagnostics && !current.settings.detailedDiagnostics) await this.store.clearDiagnostics();
    const targetsChanged = JSON.stringify(old.settings.actionFolders) !== JSON.stringify(current.settings.actionFolders) ||
      JSON.stringify(old.settings.rules.map(rule => [rule.id, rule.targetMailbox])) !== JSON.stringify(current.settings.rules.map(rule => [rule.id, rule.targetMailbox]));
    if (report && sameJudgment(report, current.settings) && targetsChanged) {
      for (const record of report.records.filter(record => ['pending', 'failed'].includes(record.status))) {
        this.replanTargets(record, current.settings);
        if (record.eligible && isFolderAction(record.action)) record.execution = { state: 'blocked', code: 'needs_check', reason: '操作目标已修改，请检查动作配置。已有 AI 判断可以继续使用。' };
        for (const choice of record.conflicts ?? []) if (isFolderAction(choice.action)) {
          choice.execution = { state: 'blocked', code: 'needs_check', reason: '操作目标已修改，请检查动作配置。' }; choice.error = choice.execution.reason;
        }
      }
      await this.store.saveReport(report);
    }
    if (policyHash(old.settings) !== policyHash(current.settings) || old.secrets.imapPassword !== current.secrets.imapPassword) this.preflight = undefined;
    return this.publicConfig();
  }); }
  forgetCredentials() { return this.exclusive(async () => { this.connectionChecked = undefined; await this.store.forgetCredentials(); return this.publicConfig(); }); }
  saveAnalysisSettings(input: AnalysisSettingsInput) { return this.exclusive(async () => {
    const { settings } = await this.store.config();
    if (input.enabledRules?.some(id => !settings.rules.some(rule => rule.id === id))) throw new AppError('规则列表已改变，请先在设置中保存新增规则，或重新打开页面后再选择。');
    const next = { ...settings,
      ...(input.mailboxes === undefined ? {} : { mailboxes: input.mailboxes }),
      ...(input.scanLimit === undefined ? {} : { scanLimit: input.scanLimit }),
      ...(input.analysisConsent === undefined ? {} : { analysisConsent: input.analysisConsent }),
      ...(input.enabledRules === undefined ? {} : { rules: settings.rules.map(rule => ({ ...rule, enabled: input.enabledRules!.includes(rule.id) })) }),
    };
    await this.store.saveConfig({ settings: next });
    if (policyHash(settings) !== policyHash(next)) this.preflight = undefined;
    return this.publicConfig();
  }); }
  async loadReport() {
    if (this.report === undefined) this.report = await this.store.loadReport();
    return this.report;
  }
  async actionPreflight() { const { settings } = await this.store.config(); return this.preflight?.policyHash === policyHash(settings) ? this.preflight : null; }
  private replanTargets(record: MailRecord, settings: Settings) {
    if (!record.eligible && !record.conflicts?.length) return;
    const ids = new Set(record.conflicts?.flatMap(choice => choice.ruleIds) ?? record.matchedRules);
    const matches = record.verdicts.filter(verdict => ids.has(verdict.id));
    if (matches.length !== ids.size || !matches.length || matches.some(verdict => verdict.decision !== 'match' || verdict.modelAnswer?.choice !== 'match' || !verdict.timeAnswer || verdict.timeAnswer.choice === 'unknown' || verdict.modelAnswer.probability < MIN_PROBABILITY || verdict.timeAnswer.probability < MIN_PROBABILITY)) return;
    const candidates: Parameters<typeof mergeRuleActions>[0] = [];
    for (const verdict of matches) {
      const rule = settings.rules.find(rule => rule.id === verdict.id && rule.enabled);
      if (!rule || !rule.action || rule.action === 'keep' || rule.action !== verdict.action) return;
      candidates.push({ id: verdict.id, action: rule.action, targetMailbox: rule.targetMailbox,
        probability: Math.min(verdict.modelAnswer!.probability, verdict.timeAnswer!.probability),
        confidence: Math.min(verdict.modelAnswer!.confidence, verdict.timeAnswer!.confidence) });
    }
    const choices = mergeRuleActions(candidates);
    record.selectedConflict = undefined; record.execution = undefined;
    if (choices.length === 1) {
      const choice = choices[0]; record.conflicts = undefined;
      Object.assign(record, { category: 'clean', eligible: true, action: choice.action, targetMailbox: choice.targetMailbox, matchedRules: choice.ruleIds, probability: choice.probability, confidence: choice.confidence,
        reason: '命中规则「' + matches.filter(verdict => choice.ruleIds.includes(verdict.id)).map(verdict => verdict.name).join('」「') + '」→ ' + actionLabel(choice.action, choice.targetMailbox) +
          (record.verdicts.some(verdict => verdict.decision === 'match' && verdict.action !== choice.action && verdict.action !== 'keep') ? '；按处理优先级采用此动作。' : '') });
    } else {
      record.conflicts = choices; record.action = undefined; record.targetMailbox = undefined; record.category = 'review'; record.eligible = false;
      record.reason = '动作冲突：' + choices.map(choice => actionLabel(choice.action, choice.targetMailbox)).join('；') + '。请选择一个动作。';
    }
  }
  private async inspectActions(client: ImapFlow, settings: Settings, folders: Awaited<ReturnType<typeof listMailboxes>>): Promise<ActionPreflight> {
    const checks = checkRuleActions(settings, folders, client);
    let sourceError: string | undefined;
    for (const path of new Set([...settings.mailboxes, ...checks.filter(check => check.state === 'ready' && check.targetMailbox).map(check => check.targetMailbox!)])) {
      const source = settings.mailboxes.includes(path);
      try {
        if (!folders.some(folder => folder.path === path && folder.selectable)) throw new AppError('无法打开文件夹。');
        const lock = await client.getMailboxLock(path, { readOnly: true });
        try { currentValidity(client); } finally { lock.release(); }
      } catch {
        if (source) sourceError = '所选分析文件夹不存在或无法打开，请重新读取并选择。';
        for (const check of checks.filter(check => check.targetMailbox === path)) Object.assign(check, { state: 'blocked', code: 'invalid_destination', reason: '所选操作目标不存在或无法打开，请重新读取文件夹并选择。' });
      }
    }
    return this.preflight = { ready: !sourceError && checks.every(check => check.state === 'ready'), checkedAt: this.clock().toISOString(), policyHash: policyHash(settings), folders, checks, ...(sourceError ? { sourceError } : {}) };
  }
  private refreshExecutability(report: ScanReport, settings: Settings, folders: Awaited<ReturnType<typeof listMailboxes>>, client: ImapFlow, check: ActionPreflight) {
    for (const record of report.records.filter(record => ['pending', 'failed'].includes(record.status))) {
      if (record.eligible) {
        const evaluated = assessExecution(record, settings, folders, client);
        const inaccessible = check.checks.find(item => item.action === record.action && item.targetMailbox === (evaluated.targetMailbox ?? record.targetMailbox) && item.state === 'blocked' && item.code === 'invalid_destination');
        record.execution = check.sourceError ? { state: 'blocked', code: 'invalid_source', reason: check.sourceError } : inaccessible ? { state: 'blocked', code: inaccessible.code, reason: inaccessible.reason } : evaluated.execution;
        if (record.execution.state !== 'blocked') record.targetMailbox = evaluated.targetMailbox;
      }
      for (const choice of record.conflicts ?? []) {
        const evaluated = assessExecution({ ...record, ...choice }, settings, folders, client);
        const inaccessible = check.checks.find(item => item.action === choice.action && item.targetMailbox === (evaluated.targetMailbox ?? choice.targetMailbox) && item.state === 'blocked' && item.code === 'invalid_destination');
        choice.execution = check.sourceError ? { state: 'blocked', code: 'invalid_source', reason: check.sourceError } : inaccessible ? { state: 'blocked', code: inaccessible.code, reason: inaccessible.reason } : evaluated.execution;
        choice.error = choice.execution.state === 'ready' ? undefined : choice.execution.reason;
        if (choice.execution.state !== 'blocked') choice.targetMailbox = evaluated.targetMailbox;
      }
    }
  }
  checkActions(): Promise<ActionCheckResult> {
    return this.exclusive(async () => {
      const { settings, secrets } = await this.configured(); const report = await this.loadReport();
      return this.connection(settings, secrets.imapPassword, async client => {
        const folders = await listMailboxes(client); const preflight = await this.inspectActions(client, settings, folders);
        if (report && sameJudgment(report, settings)) {
          this.refreshExecutability(report, settings, folders, client, preflight); await this.store.saveReport(report);
        }
        return { preflight, report };
      });
    });
  }
  private async loadAction() { if (this.action === undefined) this.action = await this.store.loadAction(); return this.action; }
  async cleanupSummary(): Promise<CleanupSummary | null> {
    const action = await this.loadAction(); if (!action) return null;
    const destinations = new Map<string, { action: NonNullable<MailRecord['action']>; path: string; count: number }>();
    for (const record of action.records) {
      const executed = operationAction(record);
      if (record.status !== 'moved' || !executed || !isFolderAction(executed) || !record.destinationPath) continue;
      const key = JSON.stringify([executed, record.destinationPath]);
      const item = destinations.get(key) ?? { action: executed, path: record.destinationPath, count: 0 };
      item.count++; destinations.set(key, item);
    }
    return {
      reportId: action.id, total: action.records.length, moved: action.records.filter(r => r.status === 'moved').length,
      restored: action.records.filter(r => r.status === 'restored').length, failed: action.records.filter(r => ['pending', 'failed'].includes(r.status)).length,
      uncertain: action.records.filter(r => ['uncertain', 'moving', 'restoring'].includes(r.status)).length,
      ...(action.actionCheckedAt ? { checkedAt: action.actionCheckedAt } : {}),
      actions: Object.fromEntries(actionIds.map(id => [id, action.records.filter(r => r.status === 'moved' && operationAction(r) === id).length]).filter(([, count]) => count)),
      destinations: [...destinations.values()],
      issues: action.records.flatMap(record => {
        if (record.status === 'moved' || record.status === 'restored') return [];
        return [{ id: record.id, subject: record.subject, status: record.status,
          reason: record.error || (canSelect(record) ? '操作未完成。' : '邮件位置或标记尚未确认，请先核对操作结果。') }];
      }),
    };
  }
  private async syncAction(action: ScanReport) {
    for (const record of action.records) record.operationLocations = operationLocations(record);
    this.action = action; await this.store.saveAction(action);
    const report = await this.loadReport();
    if (report?.id === action.id) {
      const updates = new Map(action.records.map(record => [record.id, record]));
      report.records = report.records.map(record => updates.has(record.id) ? { ...updates.get(record.id)! } : record);
      report.actionCheckedAt = action.actionCheckedAt;
      await this.store.saveReport(report);
    } else if (report?.accountIdentity === action.accountIdentity) {
      // A fingerprint validates metadata, not a physical message. Link only exact, recorded
      // locations in this account; never merge independent copies after a list reload.
      for (const record of report.records) {
        const matches = action.records.filter(item => sameOperationIdentity(record, item));
        if (matches.length !== 1) continue;
        const verified = matches[0];
        // Until the outcome is known, keep the reloaded row's actual observed position.
        const keys = canSelect(verified)
          ? ['uid', 'uidValidity', 'mailbox', 'status', 'destinationUid', 'destinationUidValidity', 'destinationPath', 'error', 'lastOperation', 'previousFlag', 'operation', 'operationLocations'] as const
          : ['status', 'error', 'lastOperation', 'operation', 'operationLocations'] as const;
        for (const key of keys) Object.assign(record, { [key]: verified[key] });
      }
      await this.store.saveReport(report);
    }
  }
  async canUndo() { return !this.busy && !!(await this.loadAction())?.records.some(record => record.status === 'moved'); }
  testConnection() { return this.exclusive(async () => { const { settings, secrets } = await this.configured(); return this.connection(settings, secrets.imapPassword, listMailboxes); }); }
  testJev() { return this.exclusive(async () => { const { secrets } = await this.store.config(); if (!secrets.jevApiKey) throw new AppError('请先保存 Jev API key。'); return testEvaluator(this.evaluatorFactory(secrets.jevApiKey)); }); }
  cancel() { this.controller?.abort(new AppError('分析已停止。')); }
  private async scope(client: ImapFlow, settings: Settings, signal: AbortSignal) {
    const folders: Array<{ path: string; uidValidity: string; uids: number[] }> = [];
    const recent: Array<{ folderIndex: number; uid: number; received: number }> = [];
    for (const path of settings.mailboxes) {
      signal.throwIfAborted();
      const lock = await client.getMailboxLock(path, { readOnly: true });
      try {
        const found = await client.search({ all: true }, { uid: true });
        if (!Array.isArray(found)) throw new AppError('无法读取邮件列表。');
        folders.push({ path, uidValidity: currentValidity(client), uids: found.sort((a, b) => a - b) });
        if (settings.scanLimit !== null) for (const [uid, received] of await fetchReceiptTimes(client, found, signal)) recent.push({ folderIndex: folders.length - 1, uid, received });
      } finally { lock.release(); }
    }
    if (settings.scanLimit !== null) {
      recent.sort((a, b) => b.received - a.received || a.folderIndex - b.folderIndex || b.uid - a.uid);
      for (const folder of folders) folder.uids = [];
      for (const message of recent.slice(0, settings.scanLimit)) folders[message.folderIndex].uids.push(message.uid);
    }
    return folders;
  }
  readMail(): Promise<ScanReport> {
    return this.exclusive(async () => {
      const { settings, secrets } = await this.configured();
      if (!settings.mailboxes.length) throw new AppError('请至少选择一个文件夹。');
      const prior = await this.loadReport(); const last = await this.loadAction();
      const report: ScanReport = { kind: 'mail', id: randomUUID(), accountIdentity: accountIdentity(settings), startedAt: this.clock().toISOString(), status: 'running',
        mailboxes: [...settings.mailboxes], scanLimit: settings.scanLimit, total: 0, processed: 0, records: [], inputTokens: 0, outputTokens: 0, apiCalls: 0,
        model: '', policyHash: policyHash(settings), judgmentHash: judgmentHash(settings) };
      this.controller = new AbortController(); const signal = this.controller.signal;
      this.emit({ phase: 'reading', processed: 0, total: 0 });
      try {
        await this.connection(settings, secrets.imapPassword, async client => {
          const folders = await this.scope(client, settings, signal);
          report.total = folders.reduce((n, folder) => n + folder.uids.length, 0);
          for (const [index, folder] of folders.entries()) {
            const lock = await client.getMailboxLock(folder.path, { readOnly: true });
            try {
              if (currentValidity(client) !== folder.uidValidity) throw new AppError('文件夹状态已变化，请重新读取邮件。');
              for (const uid of folder.uids) {
                signal.throwIfAborted(); const message = await fetchMetadata(client, uid, folder.path);
                if (message) {
                  const { text: _text, ...metadata } = message;
                  const previous = prior?.accountIdentity === report.accountIdentity ? prior.records.find(record => record.fingerprint === message.fingerprint && currentLocation(record).mailbox === folder.path && currentLocation(record).uid === uid && currentLocation(record).uidValidity === folder.uidValidity) : undefined;
                  const uncertain = last?.accountIdentity === report.accountIdentity ? last.records.find(record => affectedByUnknownOperation(message, record)) : undefined;
                  const id = report.id + ':' + index + ':' + uid;
                  const reusable = previous && prior && sameJudgment(prior, settings) && canSelect(previous) &&
                    ['\\Flagged', '\\Answered', '\\Draft', '\\Deleted', '\\Seen'].every(flag => previous.flags.includes(flag) === message.flags.includes(flag));
                  // Preserve unchanged, current-policy evidence. Loading never grants new AI authorization.
                  report.records.push(reusable ? { ...structuredClone(previous), id } : { ...metadata, category: 'unclassified', eligible: false, reason: '尚未进行 AI 分类。', confidence: 0, probability: 0, matchedRules: [], verdicts: [],
                    id, status: uncertain ? 'uncertain' : 'pending', ...(uncertain ? { error: uncertain.error, operation: uncertain.operation } : {}) });
                  // The latest intent may have persisted before its report update. Reusing old AI
                  // evidence must not turn that exact message back into a selectable pending row.
                  if (uncertain || (previous && !canSelect(previous))) {
                    const record = report.records.at(-1)!; record.status = 'uncertain'; record.error = uncertain?.error ?? previous?.error;
                    if (uncertain) record.operation = uncertain.operation;
                  }
                }
                report.processed++; this.emit({ phase: 'reading', processed: report.processed, total: report.total, ...(report.processed % 100 === 0 ? { report } : {}) });
              }
            } finally { lock.release(); }
          }
        }, signal); report.status = 'complete';
      } catch (error) {
        if (!report.records.length && !signal.aborted) throw error;
        report.status = signal.aborted ? 'cancelled' : 'failed'; report.error = signal.aborted ? undefined : '邮件列表未完整读取，请检查邮箱连接后重试。';
      } finally {
        this.controller = undefined; report.completedAt = this.clock().toISOString();
        if (report.status !== 'running') { this.report = report; await this.store.saveReport(report); }
        this.emit({ phase: 'complete', processed: report.processed, total: report.total, ...(report.status !== 'running' ? { report } : {}) });
      }
      return report;
    });
  }
  scan(consent = false): Promise<ScanReport> {
    if (!consent) return Promise.reject(new AppError('请先确认允许将必要的邮件文本发送给 Jev。'));
    return this.exclusive(async () => {
      const { settings, secrets } = await this.configured(true);
      if (!settings.mailboxes.length) throw new AppError('请至少选择一个文件夹。');
      if (!settings.rules.some(rule => rule.enabled)) throw new AppError('请至少勾选一条规则。');
      await this.loadAction();
      this.controller = new AbortController(); const signal = this.controller.signal; const now = this.clock();
      const report: ScanReport = {
        kind: 'analysis', id: randomUUID(), accountIdentity: accountIdentity(settings), startedAt: now.toISOString(), status: 'running',
        mailboxes: [...settings.mailboxes], scanLimit: settings.scanLimit, total: 0, processed: 0, records: [],
        inputTokens: 0, outputTokens: 0, apiCalls: 0, model: JEV_MODEL, policyHash: policyHash(settings), judgmentHash: judgmentHash(settings),
      };
      let started = false; this.emit({ phase: 'connecting', processed: 0, total: 0 });
      try {
        await this.connection(settings, secrets.imapPassword, async client => {
          const mailboxList = await listMailboxes(client);
          const check = await this.inspectActions(client, settings, mailboxList);
          if (!check.ready) throw new AppError('本次规则的动作尚未准备好。请完成动作配置后再分析，尚未调用 Jev。');
          this.report = report; started = true; await this.store.saveReport(report);
          await this.store.startDiagnostics(report.id, now);
          const folders = await this.scope(client, settings, signal);
          report.total = folders.reduce((total, folder) => total + folder.uids.length, 0);
          let failures = 0;
          for (const [folderIndex, folder] of folders.entries()) {
            signal.throwIfAborted();
            if (!folder.uids.length) continue;
            const lock = await client.getMailboxLock(folder.path, { readOnly: true });
            try {
              if (currentValidity(client) !== folder.uidValidity) throw new AppError('文件夹状态已变化，请重新分析。');
              for (const uid of folder.uids) {
                signal.throwIfAborted();
                const message = await fetchEmail(client, uid, folder.path);
                if (!message) { report.processed++; continue; }
                const { text: _text, ...metadata } = message;
                const record: MailRecord = { ...metadata, id: report.id + ':' + folderIndex + ':' + uid, status: 'pending',
                  category: 'review', eligible: false, confidence: 0, probability: 0, matchedRules: [], verdicts: [], reason: '尚未获得有效的分析结果。' };
                report.records.push(record);
                let fatal: unknown;
                try {
                  const evaluate = this.recordedEvaluator(settings, secrets.jevApiKey, report, record, now);
                  const result = await classifyMessage(message, settings, evaluate, now, signal);
                  Object.assign(record, result.classification);
                  record.analysis ??= { version: 8, model: JEV_MODEL, analyzedAt: now.toISOString(), rules: structuredClone(settings.rules.filter(rule => rule.enabled)), questions: {}, attempts: [], traceStatus: 'disabled' };
                  if (record.analysis) record.analysis.decision = { category: record.category, reason: record.reason, action: record.action, matchedRules: [...record.matchedRules] };
                  if (record.eligible) Object.assign(record, assessExecution(record, settings, mailboxList, client));
                  for (const choice of record.conflicts ?? []) {
                    Object.assign(choice, assessExecution({ ...message, ...choice }, settings, mailboxList, client));
                    choice.error = choice.execution?.state === 'ready' ? undefined : choice.execution?.reason;
                  }
                  if (result.response) { failures = 0; report.apiCalls++; report.inputTokens += result.response.usage.input_tokens; report.outputTokens += result.response.usage.output_tokens; report.model = result.response.model; }
                } catch (error) {
                  failures++;
                  const reason = signal.aborted ? '分析已停止，未收到完整判断。这封邮件尚未处理。' : record.analysis?.traceStatus === 'incomplete' && record.analysis.error ? record.analysis.error : error instanceof JevError || error instanceof AppError ? error.message : '未获得模型回答，这封邮件尚未处理。';
                  Object.assign(record, { category: 'review', eligible: false, confidence: 0, probability: 0, matchedRules: [], verdicts: [], reason });
                  if (record.analysis) record.analysis.error = reason;
                  if (signal.aborted || error instanceof AppError || (error instanceof JevError && error.fatal)) fatal = error;
                }
                report.processed++;
                if (fatal) { await this.store.saveReport(report); throw fatal; }
                if (failures >= 3) throw new JevError('连续三次判断请求失败，分析已停止。已完成的结果仍然保留。', true);
                await this.store.saveReport(report);
                this.emit({ phase: 'scanning', processed: report.processed, total: report.total, mailbox: folder.path, ...(report.processed % 10 === 0 ? { report } : {}) });
              }
            } finally { lock.release(); }
          }
        }, signal);
        report.status = 'complete';
      } catch (error) {
        if (!started) throw error instanceof AppError ? error : new AppError('未能完成分析前检查。请检查邮箱连接后重试，尚未调用 Jev。');
        report.status = signal.aborted ? 'cancelled' : 'failed';
        if (!signal.aborted) report.error = error instanceof JevError || error instanceof AppError ? error.message : '分析未完成。请检查邮箱配置和网络；已完成的结果仍然保留。';
      } finally {
        report.completedAt = this.clock().toISOString(); this.controller = undefined;
        if (started) await this.store.saveReport(report);
        this.emit({ phase: 'complete', processed: report.processed, total: report.total, ...(started ? { report } : {}) });
      }
      return report;
    });
  }
  private recordedEvaluator(settings: Settings, apiKey: string, report: ScanReport, record: MailRecord, now: Date, resume = false): ReturnType<typeof createEvaluator> {
    return async (request, signal) => {
      const createdAt = now.toISOString();
      const previous = resume ? record.analysis : undefined;
      const offset = Math.max(0, ...previous?.attempts.map(attempt => attempt.attempt) ?? []);
      const requestText = JSON.stringify(request);
      const questions = structuredClone(request.questions);
      // Basic evidence retains dates and their meanings, never surrounding mail-body excerpts.
      for (const question of Object.values(questions)) for (const candidate of Object.values(question.criteria ?? {})) {
        if (candidate && typeof candidate === 'object') delete (candidate as { context?: string }).context;
      }
      record.analysis = { version: 8, model: request.model, analyzedAt: previous?.analyzedAt ?? createdAt,
        inputHash: createHash('sha256').update(requestText).digest('hex'),
        rules: structuredClone(previous?.rules ?? settings.rules.filter(rule => rule.enabled)), questions: structuredClone(previous?.questions ?? questions), attempts: structuredClone(previous?.attempts ?? []),
        traceStatus: settings.detailedDiagnostics ? 'saved' : 'disabled' };
      const oldTrace = settings.detailedDiagnostics && resume ? await this.store.loadTrace(report.id, record.id, this.clock()) : undefined;
      const trace: AnalysisTrace | undefined = settings.detailedDiagnostics ? oldTrace ?? {
        reportId: report.id, recordId: record.id, createdAt, expiresAt: new Date(now.getTime() + 7 * 86400000).toISOString(),
        requestText, attempts: structuredClone(previous?.attempts ?? []),
      } : undefined;
      const persist = async (attempt?: JevAttempt) => {
        if (attempt) {
          const value = { ...attempt, attempt: offset + attempt.attempt };
          const { responseText: _response, ...basic } = value;
          const index = record.analysis!.attempts.findIndex(item => item.attempt === basic.attempt);
          if (index < 0) record.analysis!.attempts.push(structuredClone(basic)); else record.analysis!.attempts[index] = structuredClone(basic);
          if (trace) {
            const traceIndex = trace.attempts.findIndex(item => item.attempt === value.attempt);
            if (traceIndex < 0) trace.attempts.push(structuredClone(value)); else trace.attempts[traceIndex] = structuredClone(value);
            trace.truncated ||= value.responseTruncated;
          }
        }
        try { if (trace) await this.store.saveTrace(trace); await this.store.saveReport(report); }
        catch (error) {
          record.analysis!.traceStatus = 'incomplete';
          const message = error instanceof AppError ? error.message + ' 分析已停止，未继续发送请求。' : '无法保存本次调用记录，分析已停止，未继续发送请求。';
          record.analysis!.error = message;
          throw new JevError(message, true, 'diagnostics_write_failed');
        }
      };
      // Save exactly the request object that will be serialized by the evaluator, before sending.
      await persist();
      let observed = false;
      const evaluate = this.evaluatorFactory(apiKey, undefined, async attempt => { observed = true; await persist(attempt); });
      const startedAt = this.clock().toISOString();
      try {
        const response = await evaluate(request, signal);
        // Injected in-process evaluators have no HTTP observer; preserve their returned evidence too.
        if (!observed) await persist({ attempt: 1, startedAt, completedAt: this.clock().toISOString(), status: 'succeeded', usage: response.usage, ...(trace ? { responseText: JSON.stringify(response) } : {}) });
        record.analysis.model = response.model;
        return response;
      } catch (error) {
        if (!observed) await persist({ attempt: 1, startedAt, completedAt: this.clock().toISOString(), status: signal?.aborted ? 'cancelled' : 'failed', errorCode: error instanceof JevError ? error.code : 'unavailable', error: error instanceof JevError ? error.message : '未获得模型回答。' });
        throw error;
      }
    };
  }
  async analysisTrace(reportId: string, id: string): Promise<AnalysisTrace | null> {
    const report = await this.loadReport();
    if (!report || report.id !== reportId || !report.records.some(record => record.id === id)) throw new AppError('找不到这封邮件的分析记录。');
    return this.store.loadTrace(reportId, id, this.clock());
  }
  clearAnalysisTraces() { return this.exclusive(async () => { await this.store.clearDiagnostics(); return null; }); }
  retryAnalysis(reportId: string, ids: string[], consent = false): Promise<ScanReport> {
    if (!consent) return Promise.reject(new AppError('请先确认允许将必要的邮件文本发送给 Jev。'));
    return this.exclusive(async () => {
      const { settings, secrets } = await this.configured(true);
      const report = await this.loadReport();
      if (!report || report.id !== reportId || report.kind === 'mail' || !sameJudgment(report, settings)) throw new AppError('规则、账号或范围已改变，请重新分析。');
      const now = new Date(report.startedAt);
      if (this.clock().getTime() - now.getTime() >= 7 * 86400000) throw new AppError('这份分析记录已超过七天，请重新分析。');
      const records = report.records.filter(record => ids.includes(record.id));
      if (!ids.length || records.length !== ids.length || records.some(record => !canRetryAnalysis(record))) throw new AppError('只能重试本次分析中尚未获得有效判断、且未处理的邮件。');
      this.controller = new AbortController(); const signal = this.controller.signal;
      let processed = 0;
      try {
        await this.connection(settings, secrets.imapPassword, async client => {
          const folders = await listMailboxes(client); const check = await this.inspectActions(client, settings, folders);
          if (!check.ready) throw new AppError('请先完成动作配置，尚未调用 Jev。');
          if (settings.detailedDiagnostics) await this.store.ensureDiagnostics(report.id, now, this.clock());
          report.status = 'running'; delete report.completedAt; delete report.error;
          await this.store.saveReport(report);
          let failures = 0;
          for (const record of records) {
            signal.throwIfAborted();
            const lock = await client.getMailboxLock(record.mailbox, { readOnly: true });
            try {
              if (currentValidity(client) !== record.uidValidity) throw new AppError('邮件身份已改变，请重新分析。');
              const message = await fetchEmail(client, record.uid, record.mailbox);
              if (!message || message.fingerprint !== record.fingerprint || createHash('sha256').update(JSON.stringify(buildJevRequest(message, settings, now))).digest('hex') !== record.analysis?.inputHash) throw new AppError('邮件内容或状态已改变，请重新分析，尚未重试这封邮件。');
              try {
                const result = await classifyMessage(message, settings, this.recordedEvaluator(settings, secrets.jevApiKey, report, record, now, true), now, signal);
                Object.assign(record, result.classification);
                if (record.analysis) record.analysis.decision = { category: record.category, reason: record.reason, action: record.action, matchedRules: [...record.matchedRules] };
                if (record.eligible) Object.assign(record, assessExecution(record, settings, folders, client));
                for (const choice of record.conflicts ?? []) { Object.assign(choice, assessExecution({ ...message, ...choice }, settings, folders, client)); choice.error = choice.execution?.state === 'ready' ? undefined : choice.execution?.reason; }
                if (result.response) { report.apiCalls++; report.inputTokens += result.response.usage.input_tokens; report.outputTokens += result.response.usage.output_tokens; report.model = result.response.model; }
                failures = 0;
              } catch (error) {
                const reason = signal.aborted ? '分析已停止，未收到完整判断。这封邮件尚未处理。' : record.analysis?.traceStatus === 'incomplete' && record.analysis.error ? record.analysis.error : error instanceof JevError || error instanceof AppError ? error.message : '未获得模型回答，这封邮件尚未处理。';
                record.reason = reason; if (record.analysis) record.analysis.error = reason;
                if (signal.aborted || error instanceof AppError || error instanceof JevError && error.fatal || ++failures >= 3) throw error;
              }
              processed++; await this.store.saveReport(report);
              this.emit({ phase: 'scanning', processed, total: records.length, report });
            } finally { lock.release(); }
          }
        }, signal);
        report.status = 'complete';
      } catch (error) {
        report.status = signal.aborted ? 'cancelled' : 'failed';
        report.error = error instanceof JevError || error instanceof AppError ? error.message : '重试未完成，已有记录仍然保留。';
      } finally {
        this.controller = undefined; report.completedAt = this.clock().toISOString(); await this.store.saveReport(report);
        this.emit({ phase: 'complete', processed, total: records.length, report });
      }
      return report;
    });
  }
  preview(id: string): Promise<MessagePreview> {
    return this.exclusive(async () => {
      const report = await this.loadReport(); const record = report?.records.find(item => item.id === id);
      if (!report || !record) throw new AppError('找不到这封邮件的分析记录。');
      if (['uncertain', 'moving', 'restoring'].includes(record.status)) throw new AppError('邮件位置或标记尚未确认，请先核对操作结果。');
      const { settings, secrets } = await this.configured();
      if (accountIdentity(settings) !== report.accountIdentity) throw new AppError('请切回分析时的邮箱账号。');
      const location = currentLocation(record); const path = location.mailbox; const uid = location.uid; const validity = location.uidValidity;
      if (!path || !uid || !validity) throw new AppError('邮件位置未完整记录，请在邮件 App 中查看。');
      return this.connection(settings, secrets.imapPassword, async client => {
        const lock = await client.getMailboxLock(path, { readOnly: true });
        try {
          if (currentValidity(client) !== validity) throw new AppError('邮箱状态已变化，请重新分析。');
          const message = await fetchEmail(client, uid, path);
          if (!message || message.fingerprint !== record.fingerprint) throw new AppError('原邮件已移动或改变，请重新分析。');
          return { subject: message.subject, originalText: message.text, sentToJev: record.category === 'unclassified' ? '' : JSON.stringify(buildJevRequest(message, settings, new Date(report.startedAt)), null, 2), usesCurrentRules: !sameJudgment(report, settings) };
        } finally { lock.release(); }
      });
    });
  }
  move(ids: string[]): Promise<ActionResult> {
    return this.exclusive(async () => {
      const report = await this.loadReport(); if (!report) throw new AppError('请先分析邮件。');
      const { settings } = await this.configured();
      if (!sameJudgment(report, settings)) throw new AppError('邮箱、规则、动作或分析范围已修改，请重新分析后执行。');
      const selected = [...new Set(ids)].map(id => report.records.find(record => record.id === id));
      if (!selected.length || selected.some(record => !record || !eligibleForMove(record) || !record.action)) throw new AppError('所选邮件不符合执行条件，请刷新列表。');
      if (new Set(selected.map(record => record!.fingerprint)).size !== selected.length) throw new AppError('所选列表包含同一邮件的多个副本，请只选择一处。');
      const action = { ...report, records: structuredClone(selected as MailRecord[]) };
      for (const record of action.records) { record.operation = { source: 'rule', action: record.action as ManualInput['action'], targetMailbox: record.targetMailbox }; record.operationLocations = undefined; }
      return this.performMove(action, false);
    });
  }
  saveActionFolders(actionFolders: Settings['actionFolders']) {
    return this.exclusive(async () => { const { settings } = await this.store.config();
      await this.store.saveConfig({ settings: { ...settings, actionFolders } }); this.preflight = undefined; this.manualPlan = undefined;
      const report = await this.loadReport();
      if (report && sameJudgment(report, settings)) {
        for (const record of report.records.filter(record => record.eligible && ['pending', 'failed'].includes(record.status) && isFolderAction(record.action))) record.execution = { state: 'blocked', code: 'needs_check', reason: '存放位置已改变，请重新检查邮箱。之前的分析结果仍可使用。' };
        await this.store.saveReport(report);
      }
      return this.publicConfig();
    });
  }
  checkManual(input: ManualInput): Promise<ManualPlan> {
    return this.exclusive(async () => {
      this.manualPlan = undefined;
      const report = await this.loadReport(); const { settings, secrets } = await this.configured();
      if (!report || report.accountIdentity !== accountIdentity(settings)) throw new AppError('请先读取当前邮箱的邮件列表。');
      const selected = input.ids.map(id => report.records.find(record => record.id === id));
      if (selected.some(record => !record || !canSelect(record))) throw new AppError('所选邮件的位置或处理结果尚未确认，请先刷新结果。');
      if (new Set(selected.map(record => record!.fingerprint)).size !== selected.length) throw new AppError('所选列表包含同一邮件的多个副本，请只选择一处。');
      const last = await this.loadAction();
      if (last?.records.some(record => !canSelect(record))) throw new AppError('上次整理的结果尚未确认，请先刷新结果。确认后才能开始下一批整理。');
      return this.connection(settings, secrets.imapPassword, async client => {
        const folders = await listMailboxes(client); const checks: ManualPlan['checks'] = []; const planned: MailRecord[] = [];
        for (const original of selected as MailRecord[]) {
          const location = currentLocation(original);
          if (!location.mailbox || !location.uid || !location.uidValidity) { checks.push({ id: original.id, state: 'blocked', reason: '缺少邮件位置，请重新读取邮件。' }); continue; }
          const lock = await client.getMailboxLock(location.mailbox, { readOnly: true });
          try {
            const current = await fetchMetadata(client, location.uid, location.mailbox);
            if (currentValidity(client) !== location.uidValidity || !current || current.fingerprint !== original.fingerprint) { checks.push({ id: original.id, state: 'blocked', reason: '邮件位置已变化，请重新读取邮件。' }); continue; }
            const evaluated = assessExecution({ ...current, action: input.action, targetMailbox: input.targetMailbox }, settings, folders, client);
            const check = { id: original.id, ...evaluated.execution, targetMailbox: evaluated.targetMailbox }; checks.push(check);
            if (check.state !== 'ready') continue;
            // Only operational metadata changes. All AI evidence and planned rule actions stay intact.
            planned.push({ ...structuredClone(original), uid: current.uid, uidValidity: current.uidValidity, mailbox: current.mailbox, flags: current.flags,
              status: 'pending', operation: { source: 'manual', action: input.action, targetMailbox: evaluated.targetMailbox },
              destinationUid: undefined, destinationUidValidity: undefined, destinationPath: undefined, lastOperation: undefined, previousFlag: undefined, operationLocations: undefined, error: undefined });
          } finally { lock.release(); }
        }
        // Open every destination before confirmation, without checking unrelated enabled rules.
        for (const path of new Set(planned.map(record => record.operation!.targetMailbox).filter((path): path is string => !!path))) {
          try { const lock = await client.getMailboxLock(path, { readOnly: true }); try { currentValidity(client); } finally { lock.release(); } }
          catch { for (const check of checks.filter(check => check.targetMailbox === path)) Object.assign(check, { state: 'blocked', code: 'invalid_destination', reason: '无法打开所选文件夹，请重新选择。' }); }
        }
        const counts = new Map<string, number>(); for (const record of planned) if (record.operation!.targetMailbox) counts.set(record.operation!.targetMailbox, (counts.get(record.operation!.targetMailbox) ?? 0) + 1);
        const value: ManualPlan = { id: randomUUID(), action: input.action, ready: planned.length > 0 && !checks.some(check => check.state === 'blocked'), checks, destinations: [...counts].map(([path, count]) => ({ path, count })), folders };
        if (value.ready) this.manualPlan = { value, reportId: report.id, account: report.accountIdentity, folders: JSON.stringify(settings.actionFolders),
          snapshots: JSON.stringify(selected), records: planned };
        return value;
      });
    });
  }
  executeManual(planId: string): Promise<ActionResult> {
    return this.exclusive(async () => {
      const plan = this.manualPlan; this.manualPlan = undefined;
      const report = await this.loadReport(); const { settings } = await this.configured();
      if (!plan || plan.value.id !== planId || !report || report.id !== plan.reportId || plan.account !== accountIdentity(settings) || plan.folders !== JSON.stringify(settings.actionFolders)) throw new AppError('处理选项已变化，请重新选择处理方式并确认。');
      const selected = plan.value.checks.map(check => report.records.find(record => record.id === check.id));
      if (JSON.stringify(selected) !== plan.snapshots) throw new AppError('邮件列表已变化，请重新选择并确认。');
      return this.performMove({ ...report, records: plan.records }, false, 'manual');
    });
  }
  resolveConflict(id: string, choiceId: string): Promise<ScanReport> {
    return this.exclusive(async () => {
      const report = await this.loadReport(); const { settings } = await this.configured();
      if (!report || !sameJudgment(report, settings)) throw new AppError('邮箱、规则或分析范围已更新，请重新分析。');
      const record = report.records.find(record => record.id === id);
      const choice = record?.conflicts?.find(choice => choice.id === choiceId);
      if (!record || !['pending', 'failed'].includes(record.status) || !choice || choice.error || choice.action === 'keep' || choice.probability < MIN_PROBABILITY) throw new AppError('所选动作不是这封邮件已确认的匹配结果。');
      Object.assign(record, { action: choice.action, targetMailbox: choice.targetMailbox, execution: choice.execution, probability: choice.probability, confidence: choice.confidence, matchedRules: choice.ruleIds, selectedConflict: choice.id, category: 'clean', eligible: true, reason: '已选择：' + actionLabel(choice.action, choice.targetMailbox) });
      await this.store.saveReport(report); return report;
    });
  }
  undo(): Promise<ActionResult> {
    return this.exclusive(async () => {
      const action = await this.loadAction();
      if (!action?.records.some(record => record.status === 'moved')) throw new AppError('没有可撤销的最近操作。');
      return this.performMove(action, true);
    });
  }
  refreshCleanup(): Promise<ActionResult> {
    return this.exclusive(async () => {
      const action = await this.loadAction(); if (!action) throw new AppError('还没有可核对的操作记录。');
      const { settings, secrets } = await this.configured();
      if (accountIdentity(settings) !== action.accountIdentity) throw new AppError('请切回最近操作时的邮箱账号，再核对结果。');
      await this.loadReport();
      this.emitAction({ phase: 'checking', processed: 0, total: action.records.length, cleanup: await this.cleanupSummary() }, action);
      try {
        await this.connection(settings, secrets.imapPassword, client => this.verifyAction(client, action));
        const cleanup = await this.cleanupSummary();
        return { moved: cleanup!.moved, failed: cleanup!.failed, uncertain: cleanup!.uncertain, report: (await this.loadReport()) ?? action,
          canUndo: action.records.some(r => r.status === 'moved'), cleanup };
      } finally {
        this.emitAction({ phase: 'complete', processed: action.records.length, total: action.records.length,
          report: (await this.loadReport()) ?? action, cleanup: await this.cleanupSummary() }, action);
      }
    });
  }
  private async verifyAction(client: ImapFlow, action: ScanReport, onlyUncertain = false, operationTotal = action.records.length) {
    const records = action.records.filter(r => !onlyUncertain || r.status === 'uncertain');
    const startedAt = Date.now();
    const unresolved = new Map<OperationDiagnosticReason, number>();
    const unresolvedReason = (reason: OperationDiagnosticReason) => unresolved.set(reason, (unresolved.get(reason) ?? 0) + 1);
    this.operationDiagnostic('actions.verification-started', { total: records.length });
    try {
      for (const record of records) record.operationLocations = operationLocations(record);
      this.emitAction({ phase: 'checking', processed: 0, total: records.length, operationTotal, cleanup: await this.cleanupSummary() }, action);
      const folders = await listMailboxes(client);
      const destination = (record: MailRecord) => record.destinationPath ?? record.operation?.targetMailbox ?? record.targetMailbox ?? (!record.action ? QUARANTINE : undefined);
      const locations = new Map<string, { validity: string; matches: Awaited<ReturnType<typeof findMatchingMetadata>> }>();
      const paths = [...new Set(records.flatMap(record => [record.mailbox, ...(isFolderAction(operationAction(record)) && destination(record) ? [destination(record)!] : [])]))];
      const counts = new Map<string, number>();
      for (const record of action.records) counts.set(record.fingerprint, (counts.get(record.fingerprint) ?? 0) + 1);
      const cleanup = await this.cleanupSummary();
      for (const path of paths) {
        if (!folders.some(box => box.path === path && box.selectable)) continue;
        const lock = await client.getMailboxLock(path, { readOnly: true });
        try { locations.set(path, { validity: currentValidity(client), matches: await findMatchingMetadata(client, records, path,
          (processed, total) => this.emitAction({ phase: 'checking', processed: 0, total: records.length, operationTotal,
            folderCheck: { mailbox: path, processed, total }, cleanup }, action)) }); }
        finally { lock.release(); }
      }
      for (const [index, record] of records.entries()) {
        const source = locations.get(record.mailbox); const path = destination(record); const target = path ? locations.get(path) : undefined;
        const original = source?.matches.get(record.fingerprint) ?? []; const pending = target?.matches.get(record.fingerprint) ?? [];
        const effect = flagAction(operationAction(record));
        const validIdentity = record.messageId && record.messageId.length <= 998 && !/[\r\n]/.test(record.messageId) && Number.isFinite(Date.parse(record.date));
        if (!validIdentity || counts.get(record.fingerprint)! > 1 || !source || source.validity !== record.uidValidity ||
          (!effect && record.destinationUidValidity && target?.validity !== record.destinationUidValidity)) {
          unresolvedReason('verification_identity_changed');
          record.status = 'uncertain'; record.error = '邮件身份或文件夹状态无法完整核对，请在邮件 App 中检查。';
        } else if (effect) {
          if (original.length !== 1 || original[0].uid !== record.uid || typeof record.previousFlag !== 'boolean' || record.previousFlag === effect.value) {
            unresolvedReason('verification_flag_unknown');
            record.status = 'uncertain'; record.error = '无法确认邮件标记或原始标记，暂不能恢复。';
          } else if (original[0].flags.includes(effect.flag) === effect.value) {
            record.status = 'moved'; record.error = record.lastOperation === 'restore' ? '标记仍是操作后的状态，撤销未完成。' : undefined;
          } else {
            record.status = record.lastOperation === 'restore' || record.status === 'restored' ? 'restored' : 'failed';
            record.error = record.status === 'failed' ? '标记仍是原始状态，本次操作未完成。' : undefined;
          }
        } else if (original.length === 0 && pending.length === 1) {
          record.status = 'moved'; record.error = record.lastOperation === 'restore' ? '邮件仍在目标文件夹，恢复未完成。' : undefined;
          record.destinationPath = path; record.destinationUid = pending[0].uid; record.destinationUidValidity = target!.validity;
        } else if (original.length === 1 && pending.length === 0) {
          const restoring = record.lastOperation === 'restore' || record.status === 'restored' || !!record.destinationUid;
          record.status = restoring ? 'restored' : 'failed'; record.error = restoring ? undefined : '邮件仍在原文件夹，本次操作未完成。';
          record.uid = original[0].uid; record.uidValidity = source.validity;
        } else {
          unresolvedReason(original.length || pending.length ? 'verification_duplicate_locations' : 'verification_message_missing');
          record.status = 'uncertain'; record.error = original.length || pending.length
            ? '找到重复邮件或多个位置，无法确认本次操作，请在邮件 App 中核对。'
            : '在原文件夹和目标文件夹均未找到这封邮件，请在邮件 App 中核对。';
        }
        this.emitAction({ phase: 'checking', processed: index + 1, total: records.length, operationTotal, report: (await this.loadReport()) ?? action, cleanup: await this.cleanupSummary() }, action);
      }
      action.actionCheckedAt = this.clock().toISOString(); await this.syncAction(action);
      for (const [reasonCode, total] of unresolved) this.operationDiagnostic('actions.verification-unresolved', { reasonCode, total });
      this.operationDiagnostic('actions.verification-finished', { total: records.length, moved: records.filter(record => record.status === 'moved').length, restored: records.filter(record => record.status === 'restored').length, failed: records.filter(record => record.status === 'failed').length, uncertain: records.filter(record => record.status === 'uncertain').length, durationMs: Math.max(0, Date.now() - startedAt) });
    } catch (error) {
      const reasonCode = error instanceof AppError && error.message === '核对时邮件位置发生变化，请再次核对。' ? 'verification_snapshot_changed' : connectionFailure(error) ? 'verification_connection_error' : 'verification_read_error';
      this.operationDiagnostic('actions.verification-failed', { reasonCode, total: records.length, durationMs: Math.max(0, Date.now() - startedAt) });
      throw error;
    }
  }
  private async performMove(action: ScanReport, restore: boolean, authorization: 'rule' | 'manual' = 'rule'): Promise<ActionResult> {
    const { settings, secrets } = await this.configured();
    if (accountIdentity(settings) !== action.accountIdentity) throw new AppError('当前账号与操作账号不同，请切回原邮箱。');
    const report = await this.loadReport(); let moved = 0, failed = 0, uncertain = 0, processed = 0;
    const last = await this.loadAction();
    if (!restore && last?.records.some(record => !canSelect(record))) throw new AppError('上次整理的结果尚未确认，请先刷新结果。确认后才能开始下一批整理。');
    const records = action.records.filter(record => restore ? record.status === 'moved' : authorization === 'manual' ? canSelect(record) : eligibleForMove(record));
    for (const record of records) record.operationLocations = operationLocations(record);
    const sync = async (saveAction: boolean) => {
      if (saveAction) { await this.syncAction(action); return; }
      if (report?.id === action.id) {
        const updates = new Map(action.records.map(record => [record.id, record]));
        report.records = report.records.map(record => updates.has(record.id) ? { ...updates.get(record.id)! } : record);
        await this.store.saveReport(report);
      }
    };
    const confirmationReasons = new Map<OperationDiagnosticReason, number>();
    const confirmationNeeded = (reason: OperationDiagnosticReason) => confirmationReasons.set(reason, (confirmationReasons.get(reason) ?? 0) + 1);
    let initiated = restore;
    const phase = restore ? 'restoring' : 'moving';
    const progress = async () => this.emitAction({ phase, processed, total: records.length, report: report ?? action, cleanup: await this.cleanupSummary() }, action);
    await progress();
    try { await this.connection(settings, secrets.imapPassword, async client => {
      if (records.some(record => isFolderAction(operationAction(record)))) requireSafeMove(client);
      const folders = await listMailboxes(client);
      const targets = new Map<string, string>(); const targetValidities = new Map<string, string>();
      // Resolve every folder before issuing any command. Never create or guess system folders.
      for (const record of records.filter(record => isFolderAction(operationAction(record)))) {
        const intended = record.operation ?? { action: record.action, targetMailbox: record.targetMailbox };
        const target = restore ? record.mailbox : resolveDestination({ ...record, ...intended }, settings, folders, client)!;
        if (!folders.some(folder => folder.path === target && folder.selectable)) throw new AppError('原文件夹或目标文件夹已不存在，未执行操作。');
        if (!restore && target !== intended.targetMailbox) throw new AppError('操作目标已改变，请重新检查并确认处理方式。');
        targets.set(record.id, target);
        if (!targetValidities.has(target)) {
          const lock = await client.getMailboxLock(target, { readOnly: true });
          try { targetValidities.set(target, currentValidity(client)); } finally { lock.release(); }
        }
      }
      for (const record of records) {
        const effect = flagAction(operationAction(record));
        const source = restore && !effect ? record.destinationPath : record.mailbox;
        const uid = restore && !effect ? record.destinationUid : record.uid;
        const validity = restore && !effect ? record.destinationUidValidity : record.uidValidity;
        if (!source || !uid || !validity) { record.error = '缺少恢复需要的邮件位置，请在邮件 App 中恢复。'; failed++; processed++; await progress(); continue; }
        const lock = await client.getMailboxLock(source); let started = false;
        try {
          if (currentValidity(client) !== validity) throw new AppError('邮箱 UIDVALIDITY 已改变，未执行操作。');
          const current = await fetchMetadata(client, uid, source);
          if (!current || current.fingerprint !== record.fingerprint) throw new AppError('原邮件已移动或改变，未执行操作。');
          if (!restore) {
            if (authorization === 'rule' && (!Number.isFinite(record.probability) || record.probability < MIN_PROBABILITY)) throw new AppError('判断结果不足以执行操作。');
            const relevant = ['\\Flagged', '\\Answered', '\\Draft', '\\Deleted', '\\Seen'];
            if (authorization === 'rule' && relevant.some(flag => current.flags.includes(flag) !== record.flags.includes(flag))) throw new AppError('邮件标记已变化，请重新分析。');
          }
          const target = targets.get(record.id);
          if (!effect && source === target) throw new AppError('来源和目标文件夹相同，未执行操作。');
          if (!effect && restore && targetValidities.get(target!) !== record.uidValidity) throw new AppError('原文件夹 UIDVALIDITY 已改变，未执行恢复。');
          if (effect) {
            if (restore && typeof record.previousFlag !== 'boolean') throw new AppError('缺少原始标记，不能撤销。');
            const expected = restore ? effect.value : current.flags.includes(effect.flag);
            if (current.flags.includes(effect.flag) !== expected) throw new AppError('邮件标记已变化，请先核对结果。');
            if (!restore && current.flags.includes(effect.flag) === effect.value) throw new AppError('邮件标记已是目标状态，无需重复处理。');
            if (!restore) record.previousFlag = current.flags.includes(effect.flag);
          } else if (!restore) {
            record.destinationPath = target; record.destinationUidValidity = targetValidities.get(target!);
          }
          record.status = restore ? 'restoring' : 'moving'; record.lastOperation = restore ? 'restore' : 'move'; record.error = undefined; action.actionCheckedAt = undefined;
          initiated = true; await sync(true); await progress(); // Durable intent precedes every mutation.
          started = true;
          if (effect) {
            const value = restore ? record.previousFlag! : effect.value;
            if (value) await client.messageFlagsAdd(String(uid), [effect.flag], { uid: true });
            else await client.messageFlagsRemove(String(uid), [effect.flag], { uid: true });
            const checked = await fetchMetadata(client, uid, source);
            if (!checked || checked.fingerprint !== record.fingerprint || currentValidity(client) !== validity || checked.flags.includes(effect.flag) !== value) throw new AppError('标记结果尚未确认。');
            record.status = restore ? 'restored' : 'moved'; moved++;
          } else {
            const result = await client.messageMove(String(uid), target!, { uid: true });
            const destinationUid = result ? result.uidMap?.get(uid) : undefined;
            if (!result || !Number.isSafeInteger(destinationUid) || destinationUid! <= 0 || !result.uidValidity || result.uidValidity.toString() !== targetValidities.get(target!)) {
              confirmationNeeded(!result ? 'move_receipt_missing' : !result.uidValidity || !Number.isSafeInteger(destinationUid) || destinationUid! <= 0 ? 'move_receipt_incomplete' : 'move_receipt_invalid');
              record.status = 'uncertain'; record.error = '移动结果尚未确认，可点击“核对操作结果”查询。请勿重复执行。'; uncertain++;
            } else {
              if (restore) { record.status = 'restored'; record.uid = destinationUid!; record.uidValidity = result.uidValidity.toString(); }
              else { record.status = 'moved'; record.destinationUid = destinationUid; }
              moved++;
            }
          }
        } catch (error) {
          record.status = started ? 'uncertain' : restore ? 'moved' : 'failed';
          record.error = started ? '操作已发出但未确认，请先核对邮件位置或标记。' : error instanceof AppError ? error.message : '操作未完成，请检查连接后重试。';
          if (started) {
            confirmationNeeded(effect && error instanceof AppError && error.message === '标记结果尚未确认。' ? 'flag_confirmation_failed' : connectionFailure(error) ? 'operation_connection_error' : 'operation_response_error');
            uncertain++;
          } else failed++;
        } finally { lock.release(); await sync(initiated); processed++; await progress(); }
      }
      if (uncertain) {
        for (const [reasonCode, total] of confirmationReasons) this.operationDiagnostic('actions.confirmation-needed', { reasonCode, total });
        try { await this.verifyAction(client, action, true, records.length); }
        catch { throw new AppError('操作已结束，自动核对未完成。请点击“核对操作结果”，请勿重复执行。'); }
        moved = records.filter(r => r.status === (restore ? 'restored' : 'moved')).length;
        uncertain = records.filter(r => r.status === 'uncertain').length; failed = records.length - moved - uncertain;
      }
    }); } finally {
      this.emitAction({ phase: 'complete', processed, total: records.length, report: report ?? action, cleanup: await this.cleanupSummary() }, action);
    }
    return { moved, failed, uncertain, report: report ?? action, canUndo: !!this.action?.records.some(r => r.status === 'moved'), cleanup: await this.cleanupSummary() };
  }
  deleteLocalReport() { return this.exclusive(async () => { await this.store.deleteReports(); this.report = null; this.action = null; }); }
}
