/** INPUT: derived scope/selection facts and parent callbacks. OUTPUT: compact review controls.
 * POS: presentation only; App owns requests and the core validates every action. See ./AGENTS.md. */
import { Archive, FolderSimple, Trash } from '@phosphor-icons/react';
import type { ManualInput } from '../shared/contracts';
import { createTranslator, localizedAction, type Language } from './locale';
import { mailCount } from './mail-copy';

export interface ScopeSummaryProps {
  language: Language;
  mailboxes: readonly string[];
  scanLimit: number | null;
}

export function ScopeSummary({ language, mailboxes, scanLimit }: ScopeSummaryProps) {
  const t = createTranslator(language);
  const folders = mailboxes.length === 0 ? t('未选位置')
    : mailboxes.length === 1 ? mailboxes[0]
      : t('{folder} 等 {count} 个文件夹', { folder: mailboxes[0], count: mailboxes.length });
  const range = scanLimit === null ? t('全部邮件') : t('最近 {emails}', { emails: mailCount(scanLimit, language) });
  return <div className="scope-summary"><FolderSimple size={16} aria-hidden="true" /><span className="scope-summary-folders" title={mailboxes.join(' · ')}>{folders}</span><span className="scope-summary-range">{range}</span></div>;
}

export interface ActionSelectionBarProps {
  language: Language;
  hasAiSuggestions?: boolean;
  ruleTabActive?: boolean;
  selectedCount: number;
  ruleCount: number;
  busy: boolean;
  accountChanged: boolean;
  ruleBlocked: boolean;
  onManualAction: (action: ManualInput['action']) => void;
  onRuleAction: () => void;
}

export function ActionSelectionBar({ language, hasAiSuggestions = true, ruleTabActive = false, selectedCount, ruleCount,
  busy, accountChanged, ruleBlocked, onManualAction, onRuleAction }: ActionSelectionBarProps) {
  const t = createTranslator(language);
  const disabled = busy || accountChanged || !selectedCount;
  const ruleDisabled = disabled || !hasAiSuggestions || !ruleTabActive || ruleBlocked || !ruleCount;
  const ruleHint = !ruleTabActive ? t('请在「符合规则」中选好邮件再整理。') : t('核对邮件和处理方式，再确认。');
  return <section className="selection-bar" aria-label={t('处理邮件')}>
    <div className="selection-action-row">
      <div className="manual-toolbar" role="group" aria-label={t('手动处理')}>
        <button disabled={disabled} onClick={() => onManualAction('delete')}><Trash size={16} aria-hidden="true" />{localizedAction('delete', undefined, language)}</button>
        <button disabled={disabled} onClick={() => onManualAction('move')}><FolderSimple size={16} aria-hidden="true" />{t('移动')}</button>
        <button disabled={disabled} onClick={() => onManualAction('archive')}><Archive size={16} aria-hidden="true" />{localizedAction('archive', undefined, language)}</button>
        <button disabled={disabled} onClick={() => onManualAction('junk')}>{t('标为垃圾')}</button>
        <button disabled={disabled} onClick={() => onManualAction('read')}>{t('标为已读')}</button>
        <button disabled={disabled} onClick={() => onManualAction('unread')}>{t('标为未读')}</button>
        <button disabled={disabled} onClick={() => onManualAction('star')}>{t('添加星标')}</button>
        <button disabled={disabled} onClick={() => onManualAction('unstar')}>{t('取消星标')}</button>
      </div>
      <button className="primary rule-action" disabled={ruleDisabled} title={ruleHint} onClick={onRuleAction}>{t('整理')}</button>
    </div>
    <div className="selection-overview">
      <div className="selection-counts" role="status"><span>{t('已选 {emails}', { emails: mailCount(selectedCount, language) })}</span></div>
    </div>
  </section>;
}
