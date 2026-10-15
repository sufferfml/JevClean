import { useEffect, useRef, useState } from 'react';
import { ArrowLeft, ArrowRight, ArrowCounterClockwise, ArrowsClockwise, CaretDown, CheckCircle, DotsThree, EnvelopeSimple, Gear, Plus, ShieldCheck, WarningCircle, X } from '@phosphor-icons/react';
import type { AnalysisTrace, ActionPreflight, ActionCheckResult, ActionResult, AnalysisSettingsInput, Bootstrap, CleanupSummary, LogEntry, MailAction, MailboxInfo, ManualInput, ManualPlan, MessagePreview, Progress, PublicConfig, Rule, ScanReport, Settings } from '../shared/contracts';
import { actionIds, canExecute, providers } from '../shared/contracts';
import { api } from './api';
import { MailList } from './MailList';
import { ManualPanel } from './ManualPanel';
import { ConfirmationDialog } from './ConfirmationDialog';
import { SelectedMailList } from './SelectedMailList';
import { ActionSelectionBar, ScopeSummary } from './WorkspacePanels';
import { deriveWorkspaceSelection, matchesMailSearch } from './workspace-state';
import { createTranslator, localizedAction, policySettings } from './locale';
import { actionDestination, cleanupMessage, judgmentMessage, recordState, executionMessage, folderLabel, inResultFilter, logMessage, mailCount, operationProgressCopy, selectionButton, userDiagnostic } from './mail-copy';

const mailboxReady = (config: PublicConfig | null) => !!(config?.settings.email && config.settings.host && config.hasImapPassword && config.secureStorage);
const ready = (config: PublicConfig | null) => !!(config?.settings.email && config.settings.host && config.hasImapPassword && config.hasJevApiKey && config.secureStorage);
const busyPhase = (phase: Progress['phase']) => phase === 'reading' ? 'reading' : ['connecting', 'scanning'].includes(phase) ? 'scanning' : ['moving', 'restoring', 'checking'].includes(phase) ? phase : '';


// INPUT: authenticated local API and shared contracts. OUTPUT: settings, review and explicit actions.
// POS: renderer state and workflow owner; see ./AGENTS.md. MailList renders the controlled rows.
export function App() {
  const requestRunning = useRef(false);
  const pendingAnalysis = useRef<AnalysisSettingsInput>({});
  const analysisSave = useRef<Promise<void> | null>(null);
  const analysisTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [autoSaving, setAutoSaving] = useState(false);
  const [autoError, setAutoError] = useState('');
  const selectAll = useRef<HTMLInputElement>(null);
  const confirmationReturn = useRef<HTMLElement | null>(null);
  const [config, setConfig] = useState<PublicConfig | null>(null);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [limitText, setLimitText] = useState('100');
  const [password, setPassword] = useState(''); const [key, setKey] = useState('');
  const [setup, setSetup] = useState(false); const [mailboxes, setMailboxes] = useState<MailboxInfo[]>([]);
  const [activityOpen, setActivityOpen] = useState(false);
  const [search, setSearch] = useState('');
  const [folderSearch, setFolderSearch] = useState('');
  const [expandedRules, setExpandedRules] = useState<string[]>([]);
  const [settingsTab, setSettingsTab] = useState<'api' | 'mail' | 'language' | 'rules' | 'privacy'>('api');
  const [showLogs, setShowLogs] = useState(false);
  const [showPrivacyDetails, setShowPrivacyDetails] = useState(false);
  const [report, setReport] = useState<ScanReport | null>(null); const [canUndo, setCanUndo] = useState(false);
  const [cleanup, setCleanup] = useState<CleanupSummary | null>(null);
  const [preflight, setPreflight] = useState<ActionPreflight | null>(null);
  const [busy, setBusy] = useState(''); const [progress, setProgress] = useState<Progress>({ phase: 'idle', processed: 0, total: 0 });
  const [error, setError] = useState('');
  const [notice, setNoticeValue] = useState<{ text: string; persistent?: boolean; warning?: boolean } | null>(null);
  const [consent, setConsent] = useState(false);
  const [toast, setToast] = useState<{ text: string } | null>(null);
  const [newTitle, setNewTitle] = useState('');
  const language = settings?.language ?? 'zh-CN';
  const t = createTranslator(language);
  const [editing, setEditing] = useState<string | null>(null); const [newRule, setNewRule] = useState(''); const [adding, setAdding] = useState(false);
  const [newAction, setNewAction] = useState<MailAction>('delete'); const [newTarget, setNewTarget] = useState('');
  const [selected, setSelected] = useState<string[]>([]); const [filter, setFilter] = useState<'clean' | 'review' | 'keep' | 'unclassified' | 'all'>('clean');
  const [manualAction, setManualAction] = useState<ManualInput['action'] | null>(null);
  const [manualTarget, setManualTarget] = useState('');
  const [manualPlan, setManualPlan] = useState<ManualPlan | null>(null);
  const [confirm, setConfirm] = useState(false); const [preview, setPreview] = useState<{ id: string; value?: MessagePreview; loading?: boolean; error?: string } | null>(null);
  const previewGeneration = useRef(0);
  const [retryId, setRetryId] = useState<string | null>(null);
  const [logs, setLogs] = useState<LogEntry[] | null>(null); const [closed, setClosed] = useState(false);
  const invalidLimit = !!settings && settings.scanLimit !== null && (!limitText.trim() || !Number.isSafeInteger(Number(limitText)) || Number(limitText) < 1);
  const dirty = !!settings && (invalidLimit || !!password || !!key || JSON.stringify(settings) !== JSON.stringify(config?.settings));
  const invalidRules = !!settings?.rules.some(rule => !rule.name.trim() || !rule.description.trim() || (rule.enabled && rule.action === 'move' && !rule.targetMailbox));
  const policyDirty = !!settings && (invalidLimit || !!password || !!key || JSON.stringify(policySettings(settings)) !== JSON.stringify(policySettings(config?.settings)));
  const foldersDirty = JSON.stringify(settings?.actionFolders) !== JSON.stringify(config?.settings.actionFolders) ||
    JSON.stringify(settings?.rules.map(rule => [rule.id, rule.targetMailbox])) !== JSON.stringify(config?.settings.rules.map(rule => [rule.id, rule.targetMailbox]));
  const stale = !!report && (policyDirty || (!report.judgmentHash || report.judgmentHash !== config?.judgmentHash) || settings?.email !== config?.settings.email);
  const accountDirty = !!settings && (!!password || settings.email !== config?.settings.email || settings.host !== config?.settings.host || settings.port !== config?.settings.port);
  const accountMismatch = accountDirty || !!(report && config?.accountIdentity && report.accountIdentity !== config.accountIdentity);
  const visible = report?.records.filter(r => inResultFilter(r, filter) && matchesMailSearch(r, search)) ?? [];
  const selection = deriveWorkspaceSelection({ records: report?.records ?? [], visibleRecords: visible, selectedIds: selected, targetsChanged: foldersDirty });
  const { selectedRecords: currentSelection, ruleRecords: ruleSelection, visibleSelectable: visibleCandidates } = selection;
  const blockedCount = report?.records.filter(record => ['pending', 'failed'].includes(record.status) && (record.eligible && record.execution?.state === 'blocked' || record.conflicts?.some(choice => choice.execution?.state === 'blocked' || !!choice.error))).length ?? 0;
  const actionBusy = ['moving', 'restoring', 'checking'].includes(busy);
  const operationProgress = operationProgressCopy(['moving', 'restoring', 'checking'].includes(progress.phase) ? progress : { ...progress, phase: busy as Progress['phase'] }, language);
  const folderOptions = [...new Map([
    ...['INBOX', ...(config?.settings.mailboxes ?? []), ...(settings?.mailboxes ?? [])].map(path => [path, { path, name: path }] as const),
    ...mailboxes.map(box => [box.path, box] as const),
  ]).values()];
  const targetOptions = [...new Map([
    ...[...(settings?.rules.map(rule => rule.targetMailbox).filter(Boolean) ?? []), ...Object.values(settings?.actionFolders ?? {})].map(path => [path!, { path: path!, name: path! }] as const),
    ...mailboxes.map(box => [box.path, box] as const),
  ]).values()];
  const selectedCounts = new Map<string, number>();
  for (const record of ruleSelection) {
    const label = actionDestination(record.action!, record.targetMailbox, language);
    selectedCounts.set(label, (selectedCounts.get(label) ?? 0) + 1);
  }
  const selectedActions = [...selectedCounts].map(([label, count]) => ({ label, count }));


  function useConfig(value: PublicConfig) { setConfig(value); setSettings(structuredClone(value.settings)); setLimitText(String(value.settings.scanLimit ?? 100)); setConsent(value.settings.analysisConsent ?? false); setPassword(''); setKey(''); }
  async function flushAnalysis() {
    if (analysisTimer.current) { clearTimeout(analysisTimer.current); analysisTimer.current = null; }
    if (analysisSave.current) return analysisSave.current;
    if (!Object.keys(pendingAnalysis.current).length) return;
    setAutoSaving(true); setAutoError('');
    const saving = (async () => {
      while (Object.keys(pendingAnalysis.current).length) {
        const input = pendingAnalysis.current; pendingAnalysis.current = {};
        try {
          const value = await api<PublicConfig>('analysis-settings', input, { timeoutMs: 10000 });
          setConfig(value);
          setPreflight(old => old?.policyHash === value.policyHash ? old : null);
        } catch (error) {
          // Later clicks take precedence; retrying these idempotent preferences is safe.
          pendingAnalysis.current = { ...input, ...pendingAnalysis.current };
          setAutoError((error as Error).message); throw error;
        }
      }
    })();
    analysisSave.current = saving;
    try { await saving; }
    finally { analysisSave.current = null; setAutoSaving(false); }
  }
  function changeAnalysis(input: AnalysisSettingsInput) {
    setSettings(old => old ? { ...old,
      ...(input.mailboxes === undefined ? {} : { mailboxes: input.mailboxes }),
      ...(input.scanLimit === undefined ? {} : { scanLimit: input.scanLimit }),
      ...(input.analysisConsent === undefined ? {} : { analysisConsent: input.analysisConsent }),
      ...(input.enabledRules === undefined ? {} : { rules: old.rules.map(rule => ({ ...rule, enabled: input.enabledRules!.includes(rule.id) })) }),
    } : old);
    if (input.analysisConsent !== undefined) setConsent(input.analysisConsent);
    // Draft rules stay local until the full settings save; the preference endpoint only accepts saved rule IDs.
    const persisted = input.enabledRules === undefined ? input : { ...input, enabledRules: input.enabledRules.filter(id => config?.settings.rules.some(rule => rule.id === id)) };
    pendingAnalysis.current = { ...pendingAnalysis.current, ...persisted };
    setAutoSaving(true); setAutoError('');
    if (analysisTimer.current) clearTimeout(analysisTimer.current);
    analysisTimer.current = setTimeout(() => { void flushAnalysis().catch(() => {}); }, 150);
  }
  useEffect(() => () => { if (analysisTimer.current) clearTimeout(analysisTimer.current); }, []);
  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => { if (autoSaving || autoError) event.preventDefault(); };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [autoSaving, autoError]);
  useEffect(() => {
    let active = true;
    api<Bootstrap>('bootstrap').then(value => {
      if (!active) return; useConfig(value.config); setReport(value.report); setCanUndo(value.canUndo); setCleanup(value.cleanup); setSetup(!ready(value.config)); if (value.report && value.report.kind !== 'mail' && (!!value.report.judgmentHash && value.report.judgmentHash === value.config.judgmentHash) && value.report.accountIdentity === value.config.accountIdentity) setSelected(value.report.records.filter(canExecute).map(record => record.id));
      setPreflight(value.preflight ?? null);
      setMailboxes(value.preflight?.folders.filter(folder => folder.selectable) ?? []);
      setProgress(value.progress); setBusy(busyPhase(value.progress.phase));
    }).catch(e => { if (active) setError(e.message); });
    return () => { active = false; };
  }, []);
  useEffect(() => {
    if (!['reading', 'scanning', 'moving', 'restoring', 'checking'].includes(busy)) return;
    let active = true;
    let polling = false;
    const poll = async () => {
      if (polling) return; polling = true;
      try {
        const value = await api<Progress>('status'); if (!active) return;
        if (['complete', 'idle'].includes(value.phase) && requestRunning.current) return;
        setProgress(value); if (value.report) setReport(value.report);
        if (value.cleanup !== undefined) setCleanup(value.cleanup);
        if (['complete', 'idle'].includes(value.phase) && !requestRunning.current) {
          const state = await api<Bootstrap>('bootstrap'); if (!active) return;
          setReport(state.report); setCanUndo(state.canUndo); setCleanup(state.cleanup); setBusy(busyPhase(state.progress.phase));
          if (busy === 'scanning' && state.report) {
            setFilter('clean'); setSelected(state.report.records.filter(canExecute).map(record => record.id));
            showAnalysisCompletion(state.report);
          } else if (['moving', 'restoring', 'checking'].includes(busy) && state.cleanup) {
            showActionCompletion(state.cleanup, busy === 'restoring' || state.cleanup.total > 0 && state.cleanup.restored === state.cleanup.total);
          }
        }
      } catch (e) { if (active) setError((e as Error).message); }
      finally { polling = false; }
    };
    const interval = setInterval(() => { void poll(); }, 1200); void poll();
    return () => { active = false; clearInterval(interval); };
  }, [busy]);
  useEffect(() => {
    document.documentElement.lang = language;
    document.title = 'JevClean';
  }, [language]);
  useEffect(() => {
    if (!toast) return;
    const timeout = setTimeout(() => setToast(null), 5000);
    return () => clearTimeout(timeout);
  }, [toast]);
  useEffect(() => {
    if (!notice || notice.persistent) return;
    const timeout = setTimeout(() => setNotice(''), 5000);
    return () => clearTimeout(timeout);
  }, [notice]);
  useEffect(() => { setConfirm(false); setManualAction(null); setManualPlan(null); }, [selected]);
  useEffect(() => { setConfirm(false); }, [dirty]);
  useEffect(() => { if (accountMismatch) { setSelected([]); setManualAction(null); setManualPlan(null); } }, [accountMismatch]);
  useEffect(() => {
    if (selectAll.current) selectAll.current.indeterminate = visibleCandidates.some(r => selected.includes(r.id)) && !visibleCandidates.every(r => selected.includes(r.id));
  }, [selected, visibleCandidates]);


  function cancelConfirmation() {
    setConfirm(false); setManualAction(null); setManualPlan(null); setRetryId(null);
    requestAnimationFrame(() => confirmationReturn.current?.focus({ preventScroll: true }));
  }

  useEffect(() => { previewGeneration.current++; setPreview(null); }, [report?.id]);
  function openPreview(id?: string) { previewGeneration.current++; setPreview(id ? { id } : null); }
  async function loadBody(id: string) {
    const generation = ++previewGeneration.current; setPreview(old => old?.id === id ? { ...old, loading: true, error: undefined } : old);
    try { const value = await api<MessagePreview>('preview', { id }); if (generation === previewGeneration.current) setPreview({ id, value }); }
    catch (cause) { if (generation === previewGeneration.current) setPreview(old => old?.id === id ? { ...old, loading: false, error: (cause as Error).message } : old); }
  }

  function openSettings(tab: typeof settingsTab = 'api') { setSettingsTab(tab); setSetup(true); setConfirm(false); }
  function returnToMail() { setSetup(false); setEditing(null); }
  function setNotice(text: string, options: { persistent?: boolean; warning?: boolean } = {}) {
    setNoticeValue(text ? { text, ...options } : null);
  }
  function showAnalysisCompletion(value: ScanReport) {
    const incomplete = value.records.filter(record => !record.verdicts.length).length;
    const text = value.status === 'cancelled'
      ? t('分析已停止，{emails} 的结果仍可看。', { emails: mailCount(value.records.length, language) })
      : value.status === 'failed' ? t('分析中断，结果保留，邮件未改变。')
        : t('分析完成，共 {emails}。', { emails: mailCount(value.records.length, language) }) + ' ' +
          (incomplete ? t('{emails} 判断不明，请看「待查看」。', { emails: mailCount(incomplete, language) }) : t('查看结果，选好邮件后点击「整理」。'));
    setNotice(text, { persistent: true, warning: value.status !== 'complete' || incomplete > 0 });
  }
  function showActionCompletion(summary: CleanupSummary | null, restore = false) {
    if (restore) { setNotice(t('撤销已结束，请查看最近整理。')); return; }
    const complete = !!summary && summary.total > 0 && summary.moved === summary.total && !summary.failed && !summary.uncertain;
    setNotice(complete ? t('整理完成，共处理 {emails}。', { emails: mailCount(summary.total, language) })
      : t('整理已结束。') + ' ' + (summary ? cleanupMessage(summary, language) + ' ' : '') + t('请查看处理结果。'),
      { persistent: true, warning: !complete });
  }

  async function run<T>(name: string, task: () => Promise<T>): Promise<T | undefined> {
    if (requestRunning.current) return undefined; requestRunning.current = true;
    setBusy(name); setError(''); setNotice('');
    try {
      if (name === 'saving') {
        // Explicit settings save can publish a newly added rule before its selection exists on disk.
        if (analysisTimer.current) { clearTimeout(analysisTimer.current); analysisTimer.current = null; }
        await analysisSave.current?.catch(() => {});
      } else await flushAnalysis();
      return await task();
    } catch (e) { setError((e as Error).message); return undefined; }
    finally {
      if (name !== 'exiting') {
        try { const state = await api<Bootstrap>('bootstrap'); setConfig(state.config); setReport(state.report); setPreflight(state.preflight ?? null); } catch { /* Preserve the original task error when the service is unavailable. */ }
      }
      requestRunning.current = false; setBusy('');
    }
  }
  async function save(override?: Partial<Settings>) {
    if (!settings) throw new Error(t("设置尚未加载，请稍后再试。"));
    if (invalidLimit) throw new Error(t("邮件数量请填大于零的整数。"));
    if (invalidRules) throw new Error(t("请补全规则，并选择移动后的文件夹。"));
    const value = await api<PublicConfig>('config', { settings: { ...settings, ...override }, ...(password ? { imapPassword: password } : {}), ...(key ? { jevApiKey: key } : {}) });
    pendingAnalysis.current = {}; setAutoSaving(false); setAutoError('');
    useConfig(value); return value;
  }
  const patch = (value: Partial<Settings>) => setSettings(old => old ? { ...old, ...value } : old);
  function updateRule(id: string, value: Partial<Rule>) { if (settings) patch({ rules: settings.rules.map(r => r.id === id ? { ...r, ...value } : r) }); }
  async function loadFolders(saveFirst = true) {
    if (saveFirst && dirty && !invalidRules) await save();
    else if (saveFirst && dirty && (settings?.email !== config?.settings.email || settings?.host !== config?.settings.host || settings?.port !== config?.settings.port || password || key)) throw new Error(t("请补全规则并保存邮箱，再刷新列表。"));
    const values = await api<MailboxInfo[]>('test-mail', {});
    setMailboxes(values.filter(v => v.selectable));
    const state = await api<Bootstrap>('bootstrap'); setConfig(state.config); setToast({ text: '邮箱连接成功。' });
  }
  async function checkActions(saveFirst = true) {
    if (saveFirst && dirty) await save();
    const value = await api<ActionCheckResult>('check-actions', {});
    setPreflight(value.preflight); setMailboxes(value.preflight.folders.filter(folder => folder.selectable)); setReport(value.report); setSelected([]); setConfirm(false);
    return value.preflight;
  }
  function actionFields(action: MailAction, target: string | undefined, name: string, change: (value: Partial<Rule>) => void) {
    return <div className="action-fields">
      <label>{t("处理方式")}<select aria-label={t('处理方式：{name}', { name })} disabled={!!busy} value={action} onChange={event => change({ action: event.target.value as MailAction, targetMailbox: undefined })}>{actionIds.map(id => <option key={id} value={id}>{localizedAction(id, undefined, language)}</option>)}</select></label>
      {action === 'move' && <label>{t("移到哪里")}<select aria-label={t('移动位置：{name}', { name })} disabled={!!busy} value={target ?? ''} onChange={event => change({ targetMailbox: event.target.value || undefined })}><option value="">{t("选文件夹")}</option>{targetOptions.map(folder => <option key={folder.path} value={folder.path}>{folder.path}</option>)}</select></label>}
      {action === 'move' && <button className="subtle" disabled={!!busy} onClick={() => { void run('testing', loadFolders); }}>{t("刷新列表")}</button>}
      {action === 'keep' && <p className="hint">{t('符合此规则时，其他规则不能整理。仍可手动处理。')}</p>}
    </div>;
  }
  function addRule() {
    const description = newRule.trim(); if (!description || !newTitle.trim() || !settings) return;
    patch({ rules: [{ id: 'custom_' + crypto.randomUUID().replaceAll('-', ''), name: newTitle.trim(), description, action: newAction, ...(newAction === 'move' ? { targetMailbox: newTarget } : {}), enabled: true }, ...settings.rules] });
    setNewTitle(''); setNewRule(''); setNewAction('delete'); setNewTarget(''); setAdding(false);
  }
  async function scan() {
    if (invalidLimit) { setError(t("邮件数量请填大于零的整数。")); return; }
    openPreview(); setConfirm(false); setSelected([]); setSearch(''); setManualAction(null); setManualPlan(null);
    await run('preparing', async () => {
      if (dirty) await save();
      const check = await checkActions(false);
      if (!check.ready) { setError(t('请在管理规则中设置处理方式和去向。')); openSettings('rules'); return; }
      setFilter('clean'); setBusy('scanning'); setProgress({ phase: 'connecting', processed: 0, total: 0 });
      const value = await api<ScanReport>('scan', { consent }); setReport(value);
      setSelected(value.records.filter(canExecute).map(record => record.id));
      showAnalysisCompletion(value);
      const state = await api<Bootstrap>('bootstrap'); setConfig(state.config); setCanUndo(state.canUndo); setCleanup(state.cleanup);
    });
  }
  function changeFilter(value: typeof filter) {
    setFilter(value); setSearch(''); openPreview();
    setSelected(value === 'clean' && !stale && !accountMismatch ? report?.records.filter(canExecute).map(record => record.id) ?? [] : []);
  }
  async function prepareManual(action: ManualInput['action'], target = '', saveFolder = false) {
    if (!manualAction) confirmationReturn.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setConfirm(false); setManualAction(action); setManualTarget(target); setManualPlan(null);
    if (action === 'move' && !target) {
      await run('manual-checking', async () => { setMailboxes((await api<MailboxInfo[]>('test-mail', {})).filter(folder => folder.selectable)); });
      return;
    }
    await run('manual-checking', async () => {
      if (saveFolder && action !== 'move' && settings) {
        const kind = action === 'delete' ? 'trash' : action === 'archive' ? 'archive' : 'junk';
        const value = await api<PublicConfig>('action-folders', { ...config!.settings.actionFolders, [kind]: target });
        setConfig(value); setSettings(old => old ? { ...old, actionFolders: { ...old.actionFolders, [kind]: target } } : old);
      }
      const value = await api<ManualPlan>('manual-check', { ids: currentSelection.map(record => record.id), action, ...(action === 'move' ? { targetMailbox: target } : {}) });
      setManualPlan(value); setMailboxes(value.folders.filter(folder => folder.selectable));
    });
  }
  const setupNeeded = !preflight?.ready || foldersDirty || blockedCount > 0;
  const setupBody = <>
    <div className="action-setup-heading"><div>{setupNeeded && <p>{report && !stale ? t('完成设置后，原分析仍可用。') : t('请先解决设置问题，未调用 Jev。')}</p>}</div>
      <button disabled={!!busy || invalidLimit || invalidRules || !settings?.mailboxes.length} onClick={() => { void run('preparing', async () => { const check = await checkActions(); if (check.ready) { returnToMail(); setNotice(report && !stale ? t('检查完成，可继续处理原分析中的邮件。') : t('检查完成，可开始分析，未调用 Jev。')); } }); }}><ArrowsClockwise size={16} aria-hidden="true" />{busy === 'preparing' ? t('检查中') : dirty ? t('保存检查') : t('检查邮箱')}</button></div>
    {preflight?.sourceError && <p className="error-text">{userDiagnostic(preflight.sourceError, language)}<button className="link-button" disabled={!!busy} onClick={() => { void run('testing', loadFolders); }}>{t('刷新列表')}</button></p>}
    {preflight && <div className="action-checks">{preflight.checks.map((check, index) => {
      const kind = check.action === 'delete' ? 'trash' : check.action === 'archive' ? 'archive' : 'junk';
      const chooseFolder = ['missing_destination', 'ambiguous_destination', 'invalid_destination'].includes(check.code ?? '') && check.action !== 'move';
      const label = folderLabel(check.action, language);
      return <div className="action-check" key={index}><div><strong>{actionDestination(check.action, check.targetMailbox, language)}</strong>
        {check.state === 'blocked' && <p>{executionMessage(check, check.action, language)}</p>}
        {chooseFolder && <label>{label}<select aria-label={label} disabled={!!busy} value={settings?.actionFolders[kind] ?? ''} onChange={event => patch({ actionFolders: { ...settings!.actionFolders, [kind]: event.target.value || undefined } })}><option value="">{t('选文件夹')}</option>{targetOptions.map(folder => <option key={folder.path} value={folder.path}>{folder.path}</option>)}</select></label>}
        {check.state === 'blocked' && (check.action === 'move' || ['unsupported_move', 'incompatible_source'].includes(check.code ?? '')) && <button className="link-button" disabled={!!busy} onClick={() => openSettings('rules')}>{t('修改规则')}</button>}</div>
        {check.state === 'blocked' && <span className="action-check-status blocked">{t(chooseFolder ? '待选位置' : '调整设置')}</span>}</div>;
    })}</div>}
    <p className="hint">{t('只检查信息，不修改邮件或调用 Jev。')}</p>
  </>;
  const repairSetup = setupNeeded && (preflight || blockedCount > 0 || foldersDirty) && <section id="action-setup" className="action-setup needs-setup" aria-labelledby="action-setup-title" aria-live="polite"><h3 id="action-setup-title">{blockedCount && !stale ? t('{emails} 暂不能处理，请完成设置。', { emails: mailCount(blockedCount, language) }) : t('请选择存放位置或更改处理方式。')}</h3>{setupBody}</section>;
  const destinationHints = !stale && preflight?.ready && !foldersDirty
    ? [...new Set(preflight.checks.filter(check => check.state === 'ready').map(check => actionDestination(check.action, check.targetMailbox, language)))] : [];
  const actionSetup = !!destinationHints.length && <div className="action-setup ready">{destinationHints.map(hint => <span key={hint}>{hint}</span>)}</div>;
  function showSetup() {
    openSettings('rules');
    requestAnimationFrame(() => {
      const panel = document.getElementById('action-setup');
      panel?.scrollIntoView({ block: 'center', behavior: 'auto' });
      (panel?.querySelector<HTMLSelectElement>('select') ?? panel?.querySelector<HTMLButtonElement>('button'))?.focus({ preventScroll: true });
    });
  }
  function applyAction(value: ActionResult, restore = false, checked = false) {
    setReport(value.report); setCanUndo(value.canUndo); setCleanup(value.cleanup); setSelected([]); setConfirm(false); setManualAction(null); setManualPlan(null); openPreview();
    if (checked) { setNotice(value.uncertain ? t('仍有 {emails} 结果待核对。请在原邮箱应用中检查。', { emails: mailCount(value.uncertain, language) }) : t('整理结果已更新。')); return; }
    showActionCompletion(value.cleanup, restore);
  }
  const operationNeedsAttention = !actionBusy && !!(cleanup?.uncertain || cleanup?.failed);
  const operationSummary = (cleanup || actionBusy || canUndo) && <section className={'cleanup-result ' + (actionBusy ? 'is-active' : operationNeedsAttention ? 'needs-attention' : '')} aria-labelledby="cleanup-title" aria-live="polite">
    <div className="operation-icon" aria-hidden="true">{actionBusy ? <ArrowsClockwise size={18} /> : operationNeedsAttention ? <WarningCircle size={18} /> : <CheckCircle size={18} />}</div>
    <div className="operation-copy"><button className="activity-toggle subtle" aria-expanded={activityOpen || actionBusy || !!cleanup?.uncertain || !!cleanup?.failed} onClick={() => setActivityOpen(!activityOpen)}><h2 id="cleanup-title">{actionBusy ? operationProgress.title : t('最近整理')}</h2><CaretDown size={14} aria-hidden="true" /></button>
      {actionBusy ? <div role="status">{operationProgress.detail && <p className="operation-counts">{operationProgress.message}</p>}
        <div className="progress"><progress aria-label={operationProgress.detail ?? operationProgress.message} value={operationProgress.processed} max={Math.max(operationProgress.total, 1)} /><span>{operationProgress.detail ?? operationProgress.message}</span></div>
        {operationProgress.hint && <p className="operation-hint">{operationProgress.hint}</p>}</div>
        : <>{cleanup && <p className="operation-counts">{cleanupMessage(cleanup, language)}</p>}
          {(activityOpen || !!cleanup?.uncertain || !!cleanup?.failed) && <p className="operation-hint">{cleanup?.uncertain ? t('请先核对结果，暂勿重复处理。') : cleanup?.failed ? t(cleanup.reportId === report?.id ? '失败原因可在「全部邮件」中查看。' : '部分邮件未成功，请在原邮箱中检查。') : ''}{cleanup?.checkedAt && <span>{t('更新于 {time}', { time: new Date(cleanup.checkedAt).toLocaleString(language) })}</span>}</p>}</>}
    </div>
    {!actionBusy && <div className="operation-actions"><button disabled={!!busy} title={t('只查询结果，不处理或调用 Jev。')} onClick={() => { setProgress({ phase: 'checking', processed: 0, total: cleanup?.total ?? 0, operationIds: cleanup?.reportId === report?.id ? cleanup?.issues?.map(issue => issue.id) : [] }); void run('checking', async () => applyAction(await api<ActionResult>('refresh-actions', {}), false, true)); }}><ArrowsClockwise size={16} aria-hidden="true" />{busy === 'checking' ? t('核对中') : t('核对结果')}</button><button disabled={!!busy || !canUndo} onClick={() => { setProgress({ phase: 'restoring', processed: 0, total: cleanup?.moved ?? 0 }); void run('restoring', async () => applyAction(await api<ActionResult>('undo', {}), true)); }}><ArrowCounterClockwise size={16} aria-hidden="true" />{t('撤销整理')}</button></div>}
    {!actionBusy && (cleanup?.uncertain || cleanup?.failed) ? <div className="operation-issues">
      {cleanup.issues?.length ? <ul>{cleanup.issues.map(issue => <li key={issue.id}><strong>{issue.subject}</strong><span>{userDiagnostic(issue.reason, language)}</span></li>)}</ul> : <p>{t('当前列表没有本批完整明细。请核对结果，或在原邮箱中查看。')}</p>}

    </div> : null}
  </section>;
  if (closed) return <main className="closed"><div className="brand-mark">J</div><h1>{t("已退出")}</h1><p>{t("本机设置和撤销记录保留，重开可继续。")}</p></main>;
  return <div className={'app-shell' + (setup ? ' settings-shell' : '')}>
    <header className="app-header"><div className="header-inner">
      <div className="brand"><span className="brand-mark" aria-hidden="true">J</span><span className="brand-name">JevClean</span></div>
      <div className="header-actions"><details className="runtime-menu" onKeyDown={event => { if (event.key === 'Escape') { event.currentTarget.open = false; event.currentTarget.querySelector('summary')?.focus(); } }}><summary aria-label={t("应用菜单")}><DotsThree size={20} aria-hidden="true" /></summary><div className="runtime-controls"><span className="local-indicator"><i aria-hidden="true" />{t("本机运行")}</span><button className="subtle" aria-label={t("退出应用")} title={busy || autoSaving ? t("请先停止分析，或等整理完成。") : t("退出应用")} disabled={!!busy || autoSaving || !!autoError} onClick={() => { void run('exiting', async () => { await api('shutdown', {}); setClosed(true); }); }}><X size={16} aria-hidden="true" />{t("退出应用")}</button></div></details>
        <span className={'mail-connection ' + (config?.mailConnection?.connected ? 'connected' : '')} title={config?.mailConnection?.checkedAt ? t("上次连接：{time}。处理时会再次连接。", { time: new Date(config.mailConnection.checkedAt).toLocaleString(language) }) : t("连接邮箱后显示上次连接结果。")}><CheckCircle size={15} aria-hidden="true" />{config?.mailConnection?.connected ? t("连接成功") : config?.hasImapPassword ? t("待检查") : t("未连接")}</span>
        {config?.settings.email && <span className="account-label" title={config.settings.email}>{config.settings.email}</span>}
        <button disabled={!!busy} onClick={() => setup ? returnToMail() : openSettings()}>
          {setup ? <ArrowLeft size={17} aria-hidden="true" /> : <Gear size={17} aria-hidden="true" />}{setup ? t("返回邮件") : t("设置")}
        </button>
      </div>
    </div></header>
    {toast && <div className="toast message" role="status"><CheckCircle size={20} aria-hidden="true" /><span>{t(toast.text)}</span><button className="icon-button" aria-label={t("关闭提示")} onClick={() => setToast(null)}><X size={18} aria-hidden="true" /></button></div>}
    <main className={'workspace ' + (setup ? 'settings-workspace' : 'mail-workspace')}>
      <div aria-live="polite" className="messages">
        {error && <div className="message error" role="alert"><WarningCircle size={20} aria-hidden="true" /><div><span>{userDiagnostic(error, language)}</span>{userDiagnostic(error, language) !== error && <details className="error-details"><summary>{t("详细信息")}</summary><p>{error}</p></details>}</div><button className="icon-button" aria-label={t("关闭提示")} onClick={() => setError('')}><X size={18} aria-hidden="true" /></button></div>}
        {notice && <div className={'message' + (notice.warning ? ' warning' : '')} role="status">{notice.warning ? <WarningCircle size={20} aria-hidden="true" /> : <CheckCircle size={20} aria-hidden="true" />}<span>{notice.text}</span><button className="icon-button" aria-label={t("关闭提示")} onClick={() => setNotice('')}><X size={18} aria-hidden="true" /></button></div>}
      </div>
      {!settings && <div className="loading" role="status"><p>{error ? t("请重新打开应用以恢复连接。") : t("加载中")}</p><div className="loading-lines" aria-hidden="true"><span /><span /><span /></div></div>}
      {settings && <>
        {setup ? <div className="settings-content">
          <div className="page-heading"><h1>{t('设置')}</h1><p>{t('设置分析服务、邮箱和语言。')}</p></div>
          <nav className="settings-tabs" aria-label={t('设置分类')}>
            {([['api', t('分析服务')], ['mail', t('邮箱设置')], ['language', t('显示语言')], ['rules', t('管理规则')], ['privacy', t('隐私记录')]] as const).map(([tab, label]) => <button key={tab} aria-current={settingsTab === tab ? 'page' : undefined} onClick={() => setSettingsTab(tab)}>{label}</button>)}
          </nav>
          {settingsTab === 'api' && <section className="setup-section api-settings" aria-labelledby="api-title"><div className="section-heading"><div><h2 id="api-title">{t("分析服务")}</h2></div></div><p>{t("使用自己的服务密钥和账户额度分析。")}</p>
              <fieldset disabled={!!busy} className="api-fields"><label>{t("服务密钥")}<input type="password" autoComplete="new-password" aria-label={t("服务密钥")} aria-describedby={config?.hasJevApiKey ? "saved-key-hint" : undefined} value={key} placeholder={config?.hasJevApiKey ? t("已保存，无需重填。") : t("粘贴 Jev 提供的密钥。")} onChange={event => setKey(event.target.value)} />{config?.hasJevApiKey && <span className="hint" id="saved-key-hint">{t("填写新密钥可替换原密钥。")}</span>}</label>
                <button disabled={!!busy} onClick={() => { void run('testing', async () => { if (dirty) await save(); await api<string>('test-jev', {}); setNotice(t("服务可用，未使用邮件内容测试。")); }); }}>{t("检查服务")}</button>
              </fieldset><p className="hint">{t("发送少量测试文字，会消耗账户额度。")}</p>
            </section>}
          {settingsTab === 'language' && <section className="setup-section" aria-labelledby="general-title"><div className="section-heading"><div><h2 id="general-title">{t("显示语言")}</h2><p>{t("只改显示语言，不改邮件或规则。")}</p></div></div><label className="language-field">{t("显示语言")}<select disabled={!!busy} aria-label={t("显示语言")} value={language} onChange={event => patch({ language: event.target.value as 'zh-CN' | 'en' })}><option value="zh-CN">{t("中文")}</option><option value="en">English</option></select></label></section>}
          {settingsTab === 'mail' && <section className="setup-section" aria-labelledby="setup-title">
            <div className="section-heading"><div><h2 id="setup-title">{t("邮箱设置")}</h2><p>{t("邮箱密码在本机加密保存。有些邮箱需授权码或专用密码。")}</p></div></div>
            <fieldset disabled={!!busy} className="config-grid">
              <label>{t("邮箱服务")}<select value={providers.some(p => p.host === settings.host) ? settings.host : 'custom'} onChange={event => { if (event.target.value !== 'custom') patch({ host: event.target.value, port: 993, actionFolders: {} }); else patch({ host: '', actionFolders: {} }); setMailboxes([]); }}>
                <option value="custom">{t("其他邮箱")}</option>{providers.map(provider => <option key={provider.host} value={provider.host}>{t(provider.name)}</option>)}
              </select></label>
              <label>{t("邮箱地址")}<input type="email" autoComplete="off" value={settings.email} placeholder="you@example.com" onChange={event => { patch({ email: event.target.value.trim(), actionFolders: {} }); setMailboxes([]); }} /></label>
              <label>{t("邮箱密码")}<input type="password" autoComplete="new-password" aria-label={t("邮箱密码")} aria-describedby={config?.hasImapPassword ? "saved-password-hint" : undefined} value={password} placeholder={config?.hasImapPassword ? t("已保存，无需重填。") : t("填写邮箱密码、授权码或专用密码。")} onChange={event => setPassword(event.target.value)} />{config?.hasImapPassword && <span className="hint" id="saved-password-hint">{t("填写新密码可替换原密码。")}</span>}</label>
              <details className="manual-connection" open={!providers.some(provider => provider.host === settings.host)}><summary>{t('手动设置')}</summary><div className="config-grid">              <label>{t("连接地址")}<input autoComplete="off" value={settings.host} placeholder="imap.example.com" onChange={event => patch({ host: event.target.value.trim() })} /></label>
              <label>{t("连接编号")}<input type="number" min="1" max="65535" value={settings.port} onChange={event => patch({ port: Number(event.target.value) })} /></label>
</div><p className="hint">{t('填写邮箱提供的地址和端口。连接始终加密。')}</p></details>
            </fieldset>
            <p className="hint provider-hint">{t(providers.find(provider => provider.host === settings.host)?.note || '填写收件地址，用密码或授权码连接。')}</p>
            <div className="connection-actions"><button disabled={!!busy || autoSaving} onClick={() => { void run('testing', loadFolders); }}><ArrowsClockwise size={16} aria-hidden="true" />{t("检查邮箱")}</button><span className="hint">{t("连接成功后更新文件夹列表。")}</span></div>
            {!config?.secureStorage && <p role="alert" className="error-text">{t('密码和密钥无法安全保存。')}<button className="link-button" onClick={() => { setShowPrivacyDetails(true); openSettings('privacy'); }}>{t('隐私说明')}</button></p>}
          </section>}
          {settingsTab === 'rules' && <section className="rules-section" aria-labelledby="rules-title">
            <div className="section-heading"><div><h2 id="rules-title">{t("管理规则")}</h2><p>{t("写清要处理的邮件，再选处理方式。")}</p></div><button disabled={!!busy || settings.rules.length >= 30} onClick={() => setAdding(!adding)}><Plus size={17} aria-hidden="true" />{t("添加规则")}</button></div>
            <p className="hint">{t('例外只排除当前规则。要阻止其他规则，请另加保留规则。')}</p>
            {repairSetup}
            {adding && <div className="new-rule"><h3>{t("添加规则")}</h3><label htmlFor="new-title">{t("规则名称")}</label><input id="new-title" disabled={!!busy} autoFocus maxLength={80} value={newTitle} placeholder={t("例如：旧招聘邮件")} onChange={event => setNewTitle(event.target.value)} /><label htmlFor="new-rule">{t("处理条件")}</label><textarea id="new-rule" disabled={!!busy} rows={4} maxLength={2000} value={newRule} placeholder={t("例如：收到超过一个月的招聘推荐，但保留正在沟通的职位。")} onChange={event => setNewRule(event.target.value)} />
              {actionFields(newAction, newTarget, t("新规则"), value => { if (value.action) setNewAction(value.action); setNewTarget(value.targetMailbox ?? ''); })}
              <div className="inline-actions"><button className="primary" disabled={!!busy || !newTitle.trim() || !newRule.trim() || (newAction === 'move' && !newTarget)} onClick={addRule}>{t("添加")}</button><button disabled={!!busy} className="subtle" onClick={() => setAdding(false)}>{t("取消")}</button></div>
            </div>}
            <div className="rule-list">{settings.rules.map(rule => <div key={rule.id} className={'rule-row management-rule ' + (rule.enabled ? 'enabled' : '') + (editing === rule.id ? ' editing' : '')}>
              <div className="rule-content">{editing === rule.id ? <div className="rule-editor">
                <label>{t("规则名称")}<input value={rule.name} maxLength={80} disabled={!!busy} onChange={event => updateRule(rule.id, { name: event.target.value })} /></label>
                <label>{t("处理条件")}<textarea aria-label={t("处理条件")} value={rule.description} maxLength={2000} rows={5} disabled={!!busy} onChange={event => updateRule(rule.id, { description: event.target.value })} /></label>
                {actionFields(rule.action ?? 'delete', rule.targetMailbox, rule.name, value => updateRule(rule.id, value))}
                <div className="inline-actions"><button className="primary" onClick={() => setEditing(null)} disabled={!!busy || !rule.name.trim() || !rule.description.trim() || (rule.enabled && rule.action === 'move' && !rule.targetMailbox)}>{t("完成编辑")}</button><button className="subtle text-danger" disabled={!!busy} onClick={() => { patch({ rules: settings.rules.filter(r => r.id !== rule.id) }); setEditing(null); }}>{t("删除规则")}</button></div>
              </div> : <><h3>{rule.name}</h3><p className="rule-description">{rule.description}</p></>}</div>
              {editing !== rule.id && <div className="rule-controls">{actionFields(rule.action ?? 'delete', rule.targetMailbox, rule.name, value => updateRule(rule.id, value))}<button className="rule-edit" aria-label={t("编辑规则：{name}", { name: rule.name })} disabled={!!busy} onClick={() => setEditing(rule.id)}>{t("编辑")}</button></div>}
            </div>)}</div>
            {!settings.rules.length && <p className="empty-rules">{t("还没有规则，请添加一条。")}</p>}
            {invalidRules && <p className="error-text" role="alert">{t("补全名称和条件，移动还需选文件夹。")}</p>}
            <details className="action-folder-settings"><summary>{t("存放位置")}</summary><p className="hint">{t("删除移入邮箱垃圾箱。通常自动选择，也可手动设置。归档和垃圾邮件也可设置。")}</p>
              <button disabled={!!busy} onClick={() => { void run('testing', loadFolders); }}><ArrowsClockwise size={16} aria-hidden="true" />{t("刷新列表")}</button>
              <div className="action-fields">{([['trash', t("删除去向")], ['archive', t("归档去向")], ['junk', t("垃圾去向")]] as const).map(([id, label]) => <label key={id}>{label}<select disabled={!!busy} value={settings.actionFolders[id] ?? ''} onChange={event => patch({ actionFolders: { ...settings.actionFolders, [id]: event.target.value || undefined } })}><option value="">{t("自动选择")}</option>{targetOptions.map(folder => <option key={folder.path} value={folder.path}>{folder.path}</option>)}</select></label>)}</div>
              <button disabled={!!busy || invalidRules || invalidLimit} onClick={() => { void run('preparing', async () => { const check = await checkActions(); if (check.ready) returnToMail(); }); }}>{t('保存检查')}</button>
            </details>
          </section>}
          {settingsTab === 'privacy' && <section className="privacy-section" aria-labelledby="privacy-title"><div className="section-heading"><div><h2 id="privacy-title">{t("隐私记录")}</h2><p>{t("密码记录存在本机，分析文字交给 Jev。")}</p></div></div>
            <div className="privacy-copy"><ul><li>{t('邮箱密码与服务密钥在本机加密保存。')}</li><li>{t('分析向 Jev 发送必要邮件文字。不下载附件或远程图片。')}</li><li>{t('分析和撤销记录在本机加密保存。开启完整记录后暂存提交的文字。')}</li></ul>
              <details open={showPrivacyDetails} onToggle={event => setShowPrivacyDetails(event.currentTarget.open)}><summary>{t('隐私说明')}</summary><p>{t('密码与密钥在本机加密保存。解锁钥匙由系统保管。网页无法读回保存的密钥。无云端、统计追踪或远程网页资源。')}</p><p>{t('Jev 会收到必要文字及发件人地址。尽量隐藏链接路径和口令。无法保证去除所有敏感内容。数据处理遵循 Jev 的政策。')}</p><p>{t('完整记录关闭时不保存完整正文。基本记录保留规则、问题和时间依据。清除完整记录不影响撤销。清除分析及撤销记录会失去撤销能力。')}</p><p>{t('Mac 用钥匙串保护解锁钥匙。Linux 需系统密码保管服务。系统保管失败时不改用明文。重填密码不能解锁已有记录。')}</p></details>
            </div>
            <div className="data-controls"><div><h3>{t('完整记录')}</h3><label className="consent"><input type="checkbox" checked={settings.detailedDiagnostics ?? false} disabled={!!busy} onChange={event => patch({ detailedDiagnostics: event.target.checked })} /><span>{t('保存原文')}</span></label><p>{t('只记录开启后的请求。含发送的邮件文字及返回内容。在本机加密保存。只保留最近一批，最多七天。保存大小最多 50 MiB。')}</p><p className="hint">{t('可能含个人信息，不保存密码和密钥。清除完整记录不影响撤销。')}</p></div><button disabled={!!busy} onClick={() => { void run('clearing-traces', async () => { await api('clear-analysis-traces', {}); openPreview(); setNotice(t('完整记录已清除，分析与撤销记录保留。')); }); }}>{t('清除原文')}</button></div>
            <div className="data-controls"><div><h3>{t("保存密码")}</h3><p>{t("清除本机的邮箱密码和服务密钥。邮箱和规则设置保留。")}</p></div><button disabled={!!busy} onClick={() => { if (window.confirm(t("清除保存的密码和服务密钥？之后需重新填写。保留邮箱与规则，不删除邮箱账号。"))) void run('forgetting', async () => { useConfig(await api<PublicConfig>('forget', {})); openSettings('mail'); setNotice(t("保存的密码和服务密钥已清除。")); }); }}>{t("清除密码")}</button></div>
            <div className="data-controls"><div><h3>{t("整理记录")}</h3><p>{t("清除后无法撤销，邮箱邮件不改变。")}</p></div><button className="text-danger" disabled={!!busy} onClick={() => { if (window.confirm(t("清除分析结果和撤销记录？之后无法撤销此前整理。邮箱中的邮件不会改变。"))) void run('deleting', async () => { await api('delete-reports', {}); setReport(null); setCanUndo(false); setCleanup(null); setSelected([]); openPreview(); }); }}>{t("清除记录")}</button></div>
            <details className="log-section" open={showLogs} onToggle={event => { setShowLogs(event.currentTarget.open); if (event.currentTarget.open) void api<LogEntry[]>('logs').then(setLogs).catch(error => setError(error.message)); }}><summary>{t('使用记录')}</summary><p className="hint">{t('只记录操作与数量，不含密码或正文。')}</p><div className="activity-records">{logs?.length ? logs.slice().reverse().map((entry, index) => <div className="activity-record" key={index}><time dateTime={entry.time}>{new Date(entry.time).toLocaleString(language)}</time><span>{logMessage(entry, language)}</span><details><summary>{t('详细信息')}</summary><pre className="logs">{entry.event + '\n' + JSON.stringify(entry.details, null, 2)}</pre></details></div>) : <p>{t('还没有使用记录。')}</p>}</div></details>
          </section>}
          {<div className="settings-savebar"><div><ShieldCheck size={18} aria-hidden="true" /><span>{dirty ? t("修改尚未保存，分析前会自动保存。") : t("设置在这台电脑加密保存。")}</span></div><button className="primary" disabled={!!busy || !dirty || invalidLimit || invalidRules || !config?.secureStorage} onClick={() => { void run('saving', async () => { await save(); setNotice(foldersDirty && !policyDirty ? t("存放位置已保存，检查后原分析可用。") : settingsTab !== 'rules' ? t("设置已保存。") : t("修改已保存，请重新分析。")); }); }}>{busy === 'saving' ? t("保存中") : settingsTab !== 'rules' ? t("保存设置") : t("保存修改")}</button></div>}
        </div> : <div className="mail-workspace-grid">
          <aside id="scope-panel" className="analysis-sidebar" aria-label={t("分析范围")}>
          <div className="analysis-sidebar-content">
          <section className="scan-section" aria-label={t("邮件范围")}>
            <div className="scan-top">
              <div className="scope-field"><div className="folder-heading"><span id="folder-title" className="field-label sidebar-section-title">{t("选文件夹")}</span><button className="link-button" disabled={!!busy || autoSaving} onClick={() => { void run('testing', loadFolders); }}>{t("刷新列表")}</button></div>
                <input className="folder-search" type="search" aria-label={t("找文件夹")} placeholder={t("找文件夹")} value={folderSearch} onChange={event => setFolderSearch(event.target.value)} /><div className="folder-list" role="group" aria-labelledby="folder-title">{folderOptions.filter(box => box.name.toLowerCase().includes(folderSearch.toLowerCase())).map(box => <label key={box.path} title={box.name}><input type="checkbox" disabled={!!busy} checked={settings.mailboxes.includes(box.path)} onChange={event => changeAnalysis({ mailboxes: event.target.checked ? [...settings.mailboxes, box.path] : settings.mailboxes.filter(path => path !== box.path) })} aria-label={t('分析位置：{name}', { name: box.name })} /><span>{box.name}</span></label>)}</div>
                <span className="hint">{t("已选 {count} 个文件夹", { count: settings.mailboxes.length })}</span>
              </div>
              <div className="scope-field"><span id="scope-title" className="field-label sidebar-section-title">{t("邮件范围")}</span><div className="segmented-control" role="group" aria-labelledby="scope-title"><button disabled={!!busy} aria-pressed={settings.scanLimit !== null} onClick={() => { const limit = Number(limitText); const next = Number.isSafeInteger(limit) && limit > 0 ? limit : 100; setLimitText(String(next)); changeAnalysis({ scanLimit: next }); }}>{t("最近邮件")}</button><button disabled={!!busy} aria-pressed={settings.scanLimit === null} onClick={() => changeAnalysis({ scanLimit: null })}>{t("全部邮件")}</button></div></div>
              {settings.scanLimit !== null && <label className="scope-field count-field">{t("邮件数量")}<input type="number" disabled={!!busy} min="1" step="1" max={Number.MAX_SAFE_INTEGER} value={limitText} aria-invalid={invalidLimit} aria-describedby="scan-range-hint" onChange={event => {
                const value = event.target.value; setLimitText(value); const limit = Number(value); if (value.trim() && Number.isSafeInteger(limit) && limit > 0) changeAnalysis({ scanLimit: limit });
              }} /></label>}

            </div>
            <p className="scan-range-hint" id="scan-range-hint">{settings.scanLimit === null ? t("分析所选文件夹中的全部邮件。") : t("分析最近 {count} 封，不足时分析全部。", { count: settings.scanLimit })}</p>
            {!settings.mailboxes.length && <p className="error-text">{t("请至少选择一个文件夹。")}</p>}
            {invalidLimit && <p className="error-text" role="alert">{t("邮件数量请填大于零的整数。")}</p>}
            {invalidRules && <p className="error-text" role="alert">{t("请补全规则。移动邮件还需选择文件夹。")}<button className="link-button" onClick={() => openSettings('rules')}>{t("管理规则")}</button></p>}
            {autoSaving && <p className="hint" role="status">{t("保存中")}</p>}
            {autoError && <div className="autosave-error" role="alert"><p>{t("修改未保存，请重试。")}</p><button className="link-button" disabled={!!busy || autoSaving} onClick={() => { void flushAnalysis().catch(() => {}); }}>{t("重新保存")}</button><details><summary>{t("详细信息")}</summary><p>{userDiagnostic(autoError, language)}</p></details></div>}
            {dirty && !autoSaving && !autoError && <p className="hint">{t("有未保存修改，分析前会保存。")}</p>}
          </section>
          <section className="sidebar-rules" aria-label={t('整理规则')}>
            <div className="scan-rules">
              <div className="folder-heading"><span id="rules-select-title" className="field-label sidebar-section-title">{t('整理规则')}</span><button className="subtle" disabled={!!busy} onClick={() => openSettings('rules')}>{t('管理规则')}</button></div>
              <div className="rule-selection-list" role="group" aria-labelledby="rules-select-title">{settings.rules.map(rule => {
                const expanded = expandedRules.includes(rule.id);
                const descriptionId = 'rule-details-' + rule.id;
                return <div key={rule.id} className={'rule-selection-item' + (rule.enabled ? ' enabled' : '')}>
                  <div className="rule-selection-heading">
                    <label><input type="checkbox" checked={rule.enabled} disabled={!!busy} onChange={event => changeAnalysis({ enabledRules: settings.rules.filter(item => item.id === rule.id ? event.target.checked : item.enabled).map(item => item.id) })} aria-label={t('使用规则：{name}', { name: rule.name })} /><strong>{rule.name}</strong></label>
                    <small>{localizedAction(rule.action ?? 'delete', rule.targetMailbox, language)}</small>
                    <button className="rule-description-toggle subtle" aria-expanded={expanded} aria-controls={descriptionId} aria-label={t(expanded ? '收起规则：{name}' : '展开规则：{name}', { name: rule.name })} onClick={() => setExpandedRules(old => expanded ? old.filter(id => id !== rule.id) : [...old, rule.id])}>{t(expanded ? '收起' : '展开')}<CaretDown size={12} aria-hidden="true" /></button>
                  </div>
                  <p id={descriptionId} className="rule-selection-description" hidden={!expanded}>{rule.description}</p>
                </div>;
              })}</div>
              {!settings.rules.length && <p className="hint">{t("请至少选择一条规则。")}</p>}<span className="hint">{t("已选 {count} 条规则", { count: settings.rules.filter(rule => rule.enabled).length })}</span>
            </div>
            <div className="scan-meta"><label className="consent"><input type="checkbox" checked={consent} disabled={!!busy} onChange={event => changeAnalysis({ analysisConsent: event.target.checked })} /><span>{t("同意向 Jev 发送邮件文字。包括主题、发件人和正文。")}</span></label><p className="hint">{t("不下载附件或远程图片，不修改邮件。")}</p></div>

          </section>
          </div>
          <div className="analysis-start">
            {!ready(config) && <p className="hint">{t('请先设置分析服务和邮箱。')}<button className="link-button" onClick={() => openSettings()}>{t('开始设置')}</button></p>}
            {ready(config) && (!consent || !settings.rules.some(rule => rule.enabled)) && <p className="hint">{t('请选规则，再同意发送邮件文字。')}</p>}
            <button className="primary analyze" disabled={!!busy || autoSaving || !!autoError || invalidLimit || invalidRules || (!ready(config) && !dirty) || !consent || !settings.mailboxes.length || !settings.rules.some(rule => rule.enabled) || !!editing} onClick={() => { void scan(); }}>{busy === 'preparing' ? t('检查中') : t('开始分析')}</button>
            <p className="hint">{t('只分析所选范围，确认后才处理。')}</p>
            {['reading', 'scanning'].includes(busy) && <div className="preparation-progress"><div className="progress" role="status"><progress value={progress.processed} max={Math.max(progress.total, 1)} /><span>{progress.phase === 'connecting' ? t('读取中') : t('已分析 {done} / {total} 封', { done: progress.processed, total: progress.total })}</span></div><button onClick={() => { void api('cancel', {}).catch(error => setError(error.message)); }}>{t('停止分析')}</button></div>}
          </div>
          </aside>
          <div className="mail-results-workspace">
          <ActionSelectionBar hasAiSuggestions={!!report && report.kind !== 'mail'} ruleTabActive={filter === 'clean'} language={language} selectedCount={currentSelection.length} ruleCount={ruleSelection.length} busy={!!busy || confirm || !!manualAction} accountChanged={accountMismatch} ruleBlocked={stale}
            onManualAction={action => { void prepareManual(action); }} onRuleAction={() => { if (filter !== 'clean' || stale || accountMismatch || !ruleSelection.length) return; confirmationReturn.current = document.activeElement instanceof HTMLElement ? document.activeElement : null; setManualAction(null); setManualPlan(null); setConfirm(true); }} />
          {report ? <section className="results-section" aria-labelledby="results-title">
            <div className="results-heading"><h2 id="results-title">{t('邮件')} <span className="count">{report.records.length}</span></h2>
              <label className="mail-search"><input type="search" aria-label={t("搜索主题或发件人")} placeholder={t("搜索邮件")} title={t("只搜索当前列表，不搜索整个邮箱。")} value={search} onChange={event => {
                const query = event.target.value; setSearch(query);
                // Only visible selections remain actionable after narrowing the list.
                setSelected(old => old.filter(id => report.records.some(record => record.id === id && inResultFilter(record, filter) && matchesMailSearch(record, query))));
              }} /></label>
              <div className="results-filterbar"><div className="result-filters" aria-label={t('查看结果')}>{([['clean', t('符合规则')], ['review', t('待查看')], ['keep', t('暂不整理')], ['all', t('全部邮件')]] as const).map(([value, label]) => <button key={value} aria-label={label} aria-pressed={filter === value} disabled={!!busy || confirm || !!manualAction} onClick={() => changeFilter(value)}>{label}<span aria-hidden="true">{report.records.filter(record => inResultFilter(record, value)).length}</span></button>)}</div></div>
            </div>
            <div className="analysis-meta"><time dateTime={report.startedAt}>{t('分析时间：{time}', { time: new Date(report.startedAt).toLocaleString(language) })}</time><span title={t('只统计已记录的有效回答用量。失败用量请看分析记录。未收到用量的消耗未知。')}>{t('服务用量：{tokens}', { tokens: (report.inputTokens + report.outputTokens).toLocaleString(language) })}</span></div>
            {actionSetup}
            {report.error && <p role="alert" className="error-text">{userDiagnostic(report.error, language)}</p>}
            {stale && (report.kind !== 'mail' || accountMismatch) && <div className="message warning"><WarningCircle size={19} aria-hidden="true" /><span>{t(accountMismatch ? '邮箱已更换，请重新分析。' : '规则或范围已变，请重新分析。仍可手动处理这些邮件。')}</span></div>}
            <div className="result-toolbar"><label className="select-all"><input ref={selectAll} type="checkbox" title={t('可选择位置已确认的邮件。')} disabled={!!busy || accountMismatch || !visibleCandidates.length} checked={visibleCandidates.length > 0 && visibleCandidates.every(record => selected.includes(record.id))} onChange={event => setSelected(old => event.target.checked ? [...new Set([...old, ...visibleCandidates.map(record => record.id)])] : old.filter(id => !visibleCandidates.some(record => record.id === id)))} />{t('选择本页')}</label><span className="hint">{t('选好邮件后，使用上方按钮。')}</span></div>
            {retryId && <ConfirmationDialog label={t('重试分析')} busy={!!busy} onCancel={cancelConfirmation}><div className="confirmation"><h3>{t('只重新分析这一封邮件？')}</h3><p>{t('会消耗额度，不改邮箱或重分析已完成项。')}</p><p className="hint">{t('只可重试七天内的同一次分析。邮件、规则或账号变更后需重分析。')}</p><div className="inline-actions"><button className="primary" disabled={!!busy || stale || accountMismatch || !consent} onClick={() => { const id = retryId; setRetryId(null); setProgress({ phase: 'scanning', processed: 0, total: 1 }); void run('scanning', async () => { const value = await api<ScanReport>('retry-analysis', { reportId: report.id, ids: [id], consent: true }); setReport(value); const retried = value.records.find(record => record.id === id); const answered = !!retried?.verdicts.length && !retried.analysis?.error; const nextFilter = answered && retried.category === 'clean' ? 'clean' : answered && retried.category === 'keep' ? 'keep' : 'review'; setFilter(nextFilter); setSelected(nextFilter === 'clean' ? value.records.filter(canExecute).map(record => record.id) : []); setNotice(t(value.status === 'cancelled' ? '重试已停止，已有结果仍可看。' : !answered ? '仍未收到可用回答，请看请求记录。' : nextFilter === 'review' ? '已收到新结果，这封邮件仍待查看。' : '重试完成，请查看最新判断。')); openPreview(id); }); }}>{t('确认重试')}</button><button data-dialog-cancel disabled={!!busy} onClick={cancelConfirmation}>{t('取消')}</button></div></div></ConfirmationDialog>}
            {manualAction && <ConfirmationDialog label={t("确认处理")} busy={!!busy} onCancel={cancelConfirmation}><ManualPanel language={language} action={manualAction} selectedCount={currentSelection.length} records={currentSelection} error={error} plan={manualPlan} target={manualTarget} folders={mailboxes} busy={!!busy} onTarget={path => { setManualTarget(path); setManualPlan(null); }}
              onCheck={() => { void prepareManual(manualAction, manualTarget, manualAction !== 'move' && !!manualTarget); }}
              onExecute={() => { if (!manualPlan?.ready) return; const planId = manualPlan.id; const count = manualPlan.checks.filter(check => check.state === 'ready').length; setManualAction(null); setManualPlan(null); setProgress({ phase: 'moving', processed: 0, total: count, operationIds: manualPlan.checks.filter(check => check.state === 'ready').map(check => check.id) }); void run('moving', async () => applyAction(await api<ActionResult>('manual-execute', { planId }))); }}
              onCancel={cancelConfirmation} /></ConfirmationDialog>}
            {!busy && !stale && !!visible.length && !visibleCandidates.length && <p className="hint">{visible.length ? t('暂无可处理邮件，请查看原因。') : t('这里没有邮件，可看「全部邮件」。')}</p>}
            {confirm && <ConfirmationDialog label={t("确认整理")} busy={!!busy} onCancel={cancelConfirmation}><div className="confirmation"><h3>{t('{action}？', { action: selectionButton(ruleSelection, language) })}</h3><p>{t('核对数量、方式和去向，再确认。')}</p><ul>{selectedActions.map(item => <li key={item.label}><strong>{item.label}</strong><span>{mailCount(item.count, language)}</span></li>)}</ul>
              {currentSelection.length > ruleSelection.length && <div className="excluded-selection"><p>{t('其余 {count} 封本次不会按规则处理。', { count: currentSelection.length - ruleSelection.length })}</p><SelectedMailList language={language} records={currentSelection.filter(record => !ruleSelection.includes(record))} summary={t('跳过原因')} reasons={Object.fromEntries(currentSelection.filter(record => !ruleSelection.includes(record)).map(record => [record.id, foldersDirty && ['delete', 'archive', 'move', 'junk'].includes(record.action ?? '') ? t('存放位置未保存，请保存并检查。') : recordState(record, language) + ' · ' + judgmentMessage(record, language)]))} /></div>}
              {ruleSelection.some(record => record.action === 'delete') && <p className="hint">{t('删除移入上方文件夹，不永久删除。')}</p>}
              <p className="hint">{canUndo ? t('此次处理后，只能撤销这次整理。') : t('可撤销最近整理。邮箱设置或其他应用可能影响撤销。')}</p>
              <div className="inline-actions"><button className="primary" disabled={!!busy || stale || filter !== 'clean' || !ruleSelection.length} onClick={() => { if (filter !== 'clean' || stale || accountMismatch || !ruleSelection.length) return; const ids = ruleSelection.map(record => record.id); setConfirm(false); setProgress({ phase: 'moving', processed: 0, total: ids.length, operationIds: ids }); void run('moving', async () => applyAction(await api<ActionResult>('execute', { ids }))); }}>{selectionButton(ruleSelection, language, true)}</button><button data-dialog-cancel disabled={!!busy} onClick={cancelConfirmation}>{t('取消')}</button></div></div></ConfirmationDialog>}
            <MailList operationProgress={actionBusy ? progress : undefined} showAiJudgment={report.kind !== 'mail'} language={language} records={visible} selected={selected} busy={!!busy} accountChanged={accountMismatch} stale={stale} targetsChanged={foldersDirty} preview={preview} reportId={report.id} loadTrace={id => api<AnalysisTrace | null>('analysis-trace', { reportId: report.id, id })} onLoadBody={id => { void loadBody(id); }} onRetry={id => { confirmationReturn.current = document.activeElement instanceof HTMLElement ? document.activeElement : null; setRetryId(id); }} retryAllowed={!!consent && !stale && !accountMismatch && !busy} previewRecord={report.records.find(record => record.id === preview?.id)}
              onSelect={(id, checked) => setSelected(old => checked ? [...new Set([...old, id])] : old.filter(value => value !== id))}
              onPreview={id => openPreview(preview?.id === id ? undefined : id)}
              onConfigure={showSetup} onRules={() => openSettings('rules')} onRefresh={() => { setProgress({ phase: 'checking', processed: 0, total: cleanup?.total ?? 0, operationIds: cleanup?.reportId === report?.id ? cleanup?.issues?.map(issue => issue.id) : [] }); void run('checking', async () => applyAction(await api<ActionResult>('refresh-actions', {}), false, true)); }} onClosePreview={() => openPreview()} onConflict={(id, choiceId) => { void run('resolving', async () => { const value = await api<ScanReport>('resolve-conflict', { id, choiceId }); setReport(value); setSelected(value.records.filter(canExecute).map(record => record.id)); setSearch(''); setFilter('clean'); }); }}
              emptyHint={!report.records.length ? t('调整左侧范围，再开始分析。') : search ? t('换个主题或发件人试试。') : t('可切换分类查看邮件。')}
              emptyAction={!report.records.length ? undefined : { label: t(search ? '清空搜索' : '全部邮件'), onClick: () => { setSearch(''); changeFilter('all'); } }}
              emptyText={!report.records.length ? t('尚未分析') : search ? t('没有找到相关邮件。') : filter === 'clean' ? t('没有符合规则的邮件。') : filter === 'review' ? t('没有待查看的邮件。') : filter === 'keep' ? t('没有暂不整理的邮件。') : t('还没有邮件。')} />
          </section> : <>{actionSetup}<section className="welcome-results"><EnvelopeSimple size={38} weight="light" aria-hidden="true" /><h2>{ready(config) ? t('开始整理') : t('开始设置')}</h2><p>{ready(config) ? t('选好文件夹、范围和规则，再分析。') : t('先设置服务、语言和邮箱，再选规则。')}</p><ScopeSummary language={language} mailboxes={settings.mailboxes} scanLimit={settings.scanLimit} />{!ready(config) && <button onClick={() => openSettings()}>{t('开始设置')}<ArrowRight size={16} aria-hidden="true" /></button>}</section></>}
          {operationSummary}
          </div>
        </div>}
      </>}
    </main>
  </div>;
}
