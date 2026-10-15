import { useEffect, useId, useRef } from 'react';
import { CaretDown, X } from '@phosphor-icons/react';
import type { AnalysisTrace, MailRecord, MessagePreview, Progress } from '../shared/contracts';
import { canExecute, canSelect, canRetryAnalysis, currentLocation, operationAction } from '../shared/contracts';
import { createTranslator, localizedAction } from './locale';
import { completedMessage, judgmentBadge, judgmentLabel, judgmentMessage, operationPending, operationState, recordState, userDiagnostic } from './mail-copy';

import { AnalysisDetails } from './AnalysisDetails';

export const actionable = canExecute;
const decisions: Record<string, string> = { match: '符合规则', not_match: '不符合', keep: '属于例外', uncertain: '待查看' };

interface Props {
  language?: 'zh-CN' | 'en'; records: MailRecord[]; selected: string[]; busy: boolean; stale: boolean; targetsChanged?: boolean; accountChanged?: boolean;
  showAiJudgment?: boolean;
  operationProgress?: Progress;
  preview: { id: string; value?: MessagePreview; loading?: boolean; error?: string } | null;
  onRetry?: (id: string) => void; retryAllowed?: boolean;
  reportId?: string; onLoadBody?: (id: string) => void; loadTrace?: (id: string) => Promise<AnalysisTrace | null>;
  previewRecord?: MailRecord | null;
  onSelect: (id: string, checked: boolean) => void;
  onPreview: (id: string) => void; onClosePreview: () => void;
  onConflict: (id: string, choiceId: string) => void;
  onConfigure: () => void; onRules: () => void; onRefresh: () => void;
  emptyText: string;
  emptyHint?: string;
  emptyAction?: { label: string; onClick: () => void };
}

/** INPUT: unchanged judgments and actual operation states. OUTPUT: controlled mail rows and one reading pane.
 * POS: renderer; fetches and mutations remain owned by App. See ./AGENTS.md. */
export function MailList({ language = 'zh-CN', records, selected, busy, stale, targetsChanged = false, accountChanged = false, showAiJudgment = true, operationProgress, preview, previewRecord, reportId, onLoadBody, loadTrace, onRetry, retryAllowed, onSelect, onPreview, onClosePreview, onConflict, onConfigure, onRules, onRefresh, emptyText, emptyHint, emptyAction }: Props) {
  const t = createTranslator(language);
  const listId = useId();
  const paneId = listId + '-reading';
  const paneRef = useRef<HTMLElement>(null);
  const openButtons = useRef(new Map<string, HTMLButtonElement>());
  const returnPosition = useRef<{ container: HTMLElement | null; top: number }>({ container: null, top: 0 });
  const activeRecord = preview ? previewRecord?.id === preview.id ? previewRecord : records.find(record => record.id === preview.id) : undefined;
  const activeId = activeRecord?.id;
  const selectedIds = new Set(selected);

  useEffect(() => {
    if (!activeId) return;
    const pane = paneRef.current;
    if (pane) { pane.focus({ preventScroll: true }); revealInMailPane(pane, true); }
  }, [activeId]);

  function revealInMailPane(target: HTMLElement, alignStart = false) {
    const container = target.closest<HTMLElement>('.mail-results-workspace');
    if (!container) { target.scrollIntoView({ block: 'nearest', behavior: 'auto' }); return; }
    const viewport = container.getBoundingClientRect();
    const toolbar = container.querySelector<HTMLElement>('.selection-bar')?.getBoundingClientRect();
    const top = Math.max(viewport.top, toolbar?.bottom ?? viewport.top) + 12;
    const bottom = viewport.bottom - 12;
    const bounds = target.getBoundingClientRect();
    if (alignStart || bounds.height > bottom - top) container.scrollTop += bounds.top - top;
    else if (bounds.bottom > bottom) container.scrollTop += bounds.bottom - bottom;
    else if (bounds.top < top) container.scrollTop += bounds.top - top;
  }

  function closePreview() {
    const trigger = preview ? openButtons.current.get(preview.id) : undefined;
    onClosePreview();
    requestAnimationFrame(() => {
      const { container, top } = returnPosition.current;
      if (container?.isConnected) container.scrollTo({ top, behavior: 'auto' });
      trigger?.focus({ preventScroll: true });
    });
  }

  const activeProtectedValues = activeRecord ? [activeRecord.targetMailbox ?? '', activeRecord.destinationPath ?? '', activeRecord.mailbox, ...activeRecord.verdicts.map(verdict => verdict.name)] : [];
  // Reading can reuse old AI evidence; only actual outcomes belong in the manual-only view.
  const operationReason = (record: MailRecord) => showAiJudgment || record.error || ['uncertain', 'moved', 'restored'].includes(record.status)
    ? completedMessage(record, language, operationProgress) : '';

  return <div className="mail-list">
    <div className={'mail-table' + (showAiJudgment ? '' : ' without-ai')}>
      <div className="mail-columns" aria-hidden="true"><span /><span>{t('邮件')}</span><span>{t('发件人')}</span><span>{t('日期位置')}</span>{showAiJudgment && <span>{t('分析判断')}</span>}<span>{t('处理结果')}</span></div>
      <div role="list" aria-label={t('邮件列表')}>
        {records.map(record => {
          const expanded = preview?.id === record.id;
          const location = currentLocation(record).mailbox;
          const protectedValues = [record.targetMailbox ?? '', record.destinationPath ?? '', record.mailbox, ...record.verdicts.map(verdict => verdict.name)];
          const label = judgmentLabel(record, language);
          const state = operationState(record, language, operationProgress);
          const confirming = operationPending(record, operationProgress);
          const readiness = showAiJudgment && record.status === 'pending' ? recordState(record, language) : '';
          const date = record.date ? new Date(record.date).toLocaleDateString(language, { month: 'short', day: 'numeric' }) : t('日期未知');
          const subject = record.subject || t('无主题');
          const reason = judgmentMessage(record, language);
          const executionReason = operationReason(record);
          const targetDirty = showAiJudgment && targetsChanged && ['delete', 'archive', 'move', 'junk'].includes(record.action ?? '');
          const disabledReason = busy ? t('请等当前任务完成。') : accountChanged ? t('邮箱已更换，请重新分析。') : executionReason || (showAiJudgment ? reason : state);
          const pending = ['pending', 'failed'].includes(record.status);
          const blocked = showAiJudgment && pending && record.execution?.state === 'blocked';
          const needsFolder = blocked && ['missing_destination', 'ambiguous_destination', 'invalid_destination', 'needs_check'].includes(record.execution?.code ?? '');
          const reasonId = listId + '-reason-' + record.id;
          const executionId = listId + '-execution-' + record.id;
          return <article role="listitem" className={'mail-row' + (selectedIds.has(record.id) ? ' selected' : '') + (expanded ? ' expanded' : '')} key={record.id}>
            <label className="mail-select-hit" title={!canSelect(record) || busy || accountChanged ? disabledReason : t('选择邮件')}>
              <input type="checkbox" checked={selectedIds.has(record.id)} disabled={busy || accountChanged || !canSelect(record)}
                aria-describedby={showAiJudgment ? reasonId + ' ' + executionId : executionId}
                onChange={event => onSelect(record.id, event.target.checked)} aria-label={t('选择邮件：{subject}', { subject })} />
            </label>
            <button className="mail-open" ref={element => { if (element) openButtons.current.set(record.id, element); else openButtons.current.delete(record.id); }}
              onClick={event => { if (expanded) closePreview(); else { const container = event.currentTarget.closest<HTMLElement>('.mail-results-workspace'); returnPosition.current = { container, top: container?.scrollTop ?? 0 }; onPreview(record.id); } }} aria-expanded={expanded} aria-controls={paneId} title={subject}>
              <span className="mail-subject">{subject}</span><span className="mobile-mail-meta">{record.sender} · {date}</span><CaretDown size={14} className="preview-caret" aria-hidden="true" />
            </button>
            <span className="mail-sender" title={record.sender}>{record.sender}</span>
            <span className="mail-location"><time dateTime={record.date} title={record.date ? new Date(record.date).toLocaleString(language) : ''}>{date}</time><span title={location}>{record.status === 'uncertain' ? t('原位置：{folder}', { folder: record.mailbox }) : location}</span></span>
            {showAiJudgment && <div className="mail-verdict" aria-label={t('分析判断')}>
              <span className="mail-axis-label">{t('分析判断')}</span>
              <span className={'action-badge ' + judgmentBadge(record)}>{label}</span>
              <div className="mail-reason" id={reasonId}><p>{reason}</p></div>
              {!!record.conflicts?.length && pending && <select aria-label={t('处理方式：{subject}', { subject })} disabled={busy || stale} value={record.selectedConflict ?? ''} onChange={event => { if (event.target.value) onConflict(record.id, event.target.value); }}>
                <option value="">{t('处理方式')}</option>{record.conflicts.map(choice => <option key={choice.id} value={choice.id} disabled={!!choice.error}>{localizedAction(choice.action, choice.targetMailbox, language)}{choice.error ? ' (' + userDiagnostic(choice.error, language, protectedValues) + ')' : ''}</option>)}
              </select>}
            </div>}
            <div className="mail-operation" id={executionId} aria-label={t('处理结果')}>
              <span className="mail-axis-label">{t('处理结果')}</span>
              <span className={'execution-state status-' + (confirming ? 'checking' : record.status)}>{state}</span>
              {record.operation && <span className="operation-source">{t(record.operation.source === 'manual' ? '手动处理：{action}' : '按规则：{action}', { action: localizedAction(operationAction(record), undefined, language) })}</span>}
              {readiness && readiness !== state && readiness !== label && <span className="execution-readiness">{readiness}</span>}
              {executionReason && <p className={confirming ? 'confirmation-reason' : ['moved', 'restored'].includes(record.status) ? 'completed-reason' : 'execution-reason'}>{executionReason}</p>}
              {targetDirty && <p className="execution-reason">{t('存放位置未保存，请保存并检查。')}</p>}
              {!stale && (blocked || targetDirty) && <button className="link-button" disabled={busy} onClick={needsFolder || targetDirty ? onConfigure : onRules}>{t(needsFolder || targetDirty ? '存放位置' : '处理方式')}</button>}
              {record.status === 'uncertain' && !confirming && <button className="link-button" disabled={busy} onClick={onRefresh}>{t('核对结果')}</button>}
            </div>
          </article>;
        })}
      </div>
      {!records.length && <div className="empty-results"><h3>{emptyText}</h3>{emptyHint && <p>{emptyHint}</p>}{emptyAction && <button onClick={emptyAction.onClick}>{emptyAction.label}</button>}</div>}
    </div>
    {preview && activeRecord && <section className="mail-preview mail-reading-pane" id={paneId} ref={paneRef} tabIndex={-1} aria-label={t('邮件内容')}
      onFocusCapture={event => {
        if (event.target === event.currentTarget) return;
        const target = event.target;
        requestAnimationFrame(() => {
          if (!target.isConnected) return;
          // Keep keyboard focus below the persistent toolbar without moving the left pane.
          revealInMailPane(target);
        });
      }}
      onKeyDown={event => { if (event.key === 'Escape') { event.preventDefault(); closePreview(); } }}>
      <div className="preview-heading"><div><span className="preview-eyebrow">{t('邮件内容')}</span><h3>{activeRecord.subject || t('无主题')}</h3></div><button className="icon-button subtle" aria-label={t('关闭邮件')} onClick={closePreview}><X size={18} aria-hidden="true" /></button></div>
      <p className="preview-meta">{activeRecord.sender}{activeRecord.senderAddress && activeRecord.senderAddress !== activeRecord.sender ? ' <' + activeRecord.senderAddress + '>' : ''}<span aria-hidden="true"> · </span>{activeRecord.date ? new Date(activeRecord.date).toLocaleString(language) : t('日期未知')}<span aria-hidden="true"> · </span>{currentLocation(activeRecord).mailbox ?? activeRecord.mailbox}</p>
      <div className="preview-state-summary">
        {showAiJudgment && <><div><span className="mail-axis-label">{t('分析判断')}</span><strong>{activeRecord.verdicts.some(verdict => verdict.decision === 'match') ? t('已找到符合的规则。') : activeRecord.verdicts.length ? t('尚未确定是否符合。') : t('尚未收到可用回答。')}</strong><span>{activeRecord.verdicts.filter(verdict => verdict.decision === 'match').map(verdict => verdict.name).join('、')}</span></div>
        <div><span className="mail-axis-label">{t('整理判断')}</span><strong className={'action-badge ' + judgmentBadge(activeRecord)}>{judgmentLabel(activeRecord, language)}</strong><span>{judgmentMessage(activeRecord, language)}</span></div></>}
        <div><span className="mail-axis-label">{t('处理结果')}</span><strong>{operationState(activeRecord, language, operationProgress)}</strong>{operationReason(activeRecord) && <span>{operationReason(activeRecord)}</span>}</div>
      </div>
      {showAiJudgment && canRetryAnalysis(activeRecord) && <button className="subtle" disabled={!retryAllowed} onClick={() => onRetry?.(activeRecord.id)}>{t('重试分析')}</button>}
      {showAiJudgment && <AnalysisDetails key={reportId + ':' + activeRecord.id} reportId={reportId} record={activeRecord} language={language} loadTrace={loadTrace ? () => loadTrace(activeRecord.id) : undefined} />}
      {showAiJudgment && <details><summary>{t('判断原因')}</summary><div className="judgments">{activeRecord.verdicts.length ? activeRecord.verdicts.map(verdict => <div key={verdict.id}><strong>{verdict.name}</strong><p>{t(decisions[verdict.decision])}</p>{verdict.reason && <p>{userDiagnostic(verdict.reason, language, activeProtectedValues)}</p>}</div>) : <p>{t('未得到可用分析结果，邮件未处理。')}</p>}</div></details>}
      <div className="current-mail-body"><button className="subtle" disabled={busy || accountChanged} aria-busy={preview.loading || undefined} onClick={() => { if (!preview.loading) onLoadBody?.(activeRecord.id); }}>{t(preview.loading ? '读取中' : preview.value ? '刷新正文' : '查看正文')}</button>
        <p className="hint">{t('读取正文需连接邮箱。不改变已读状态，不调用 Jev。')}</p>
        {preview.error && <p role="alert" className="error-text">{userDiagnostic(preview.error, language, activeProtectedValues)}</p>}
        {preview.value && <><pre className="mail-body">{preview.value.originalText || t('这封邮件没有正文文字。')}</pre><details className="technical-details"><summary>{t('当前预览')}</summary><p className="hint">{t('根据当前内容生成，可能与当时不同。')}{preview.value.usesCurrentRules && t('规则已更改，此处使用新规则。')}</p><pre className="request-preview">{preview.value.sentToJev}</pre></details></>}
      </div>
    </section>}
  </div>;
}
