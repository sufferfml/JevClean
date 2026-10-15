/** INPUT: explicit user action and a read-only execution plan. OUTPUT: confirmation and repair controls.
 * POS: presentation only; App owns requests, the core owns identity checks. See ./AGENTS.md. */
import { useEffect, useState } from 'react';
import type { ManualInput, ManualPlan, MailboxInfo, MailRecord } from '../shared/contracts';
import { createTranslator, localizedAction, type Language } from './locale';
import { actionDestination, mailCount, userDiagnostic } from './mail-copy';
import { SelectedMailList } from './SelectedMailList';

interface Props {
  language: Language; action: ManualInput['action']; selectedCount: number; plan: ManualPlan | null;
  records?: MailRecord[]; error?: string;
  target: string; folders: MailboxInfo[]; busy: boolean;
  onTarget: (path: string) => void; onCheck: () => void; onExecute: () => void; onCancel: () => void;
}
export function ManualPanel({ language, action, selectedCount, records = [], error, plan, target, folders, busy, onTarget, onCheck, onExecute, onCancel }: Props) {
  const t = createTranslator(language);
  const [repairingFolder, setRepairingFolder] = useState(false);
  useEffect(() => setRepairingFolder(false), [action]);
  const ready = plan?.checks.filter(check => check.state === 'ready').length ?? 0;
  const noop = plan?.checks.filter(check => check.state === 'noop').length ?? 0;
  const blocked = plan?.checks.filter(check => check.state === 'blocked') ?? [];
  const blockedFolder = blocked.some(check => ['missing_destination', 'ambiguous_destination', 'invalid_destination'].includes(check.code ?? ''));
  useEffect(() => { if (blockedFolder) setRepairingFolder(true); }, [blockedFolder]);
  const needsFolder = action === 'move' || repairingFolder || blockedFolder;
  return <section className="confirmation manual-confirmation" aria-label={t('手动处理')} aria-live="polite">
    <h3>{t('手动处理：{action}', { action: localizedAction(action, undefined, language) })}</h3>
    {error && <p className="error-text" role="alert">{userDiagnostic(error, language)}</p>}
    <p>{t('已选 {emails}。手动处理不调用 Jev。不改变原有分析判断。', { emails: mailCount(selectedCount, language) })}</p>
    {plan && <dl className="manual-check-counts" aria-label={t('检查结果')}>
      <div><dt>{t('准备处理')}</dt><dd>{mailCount(ready, language)}</dd></div>
      <div><dt>{t('无需处理')}</dt><dd>{mailCount(noop, language)}</dd></div>
      <div><dt>{t('无法处理')}</dt><dd>{mailCount(blocked.length, language)}</dd></div>
    </dl>}
    {plan?.ready && <ul className="confirmation-destinations">{plan.destinations.length ? plan.destinations.map(item => <li key={item.path}><strong>{actionDestination(action, item.path, language)}</strong><span>{mailCount(item.count, language)}</span></li>) : <li><strong>{localizedAction(action, undefined, language)}</strong><span>{mailCount(ready, language)}</span></li>}</ul>}
    {noop > 0 && <p className="hint">{t('{emails} 无需重复处理，将跳过。', { emails: mailCount(noop, language) })}</p>}
    {blocked.length > 0 && <div className="error-text">{[...new Set(blocked.map(check => check.reason ?? '这些邮件暂时无法处理。'))].map(reason => <p key={reason}>{userDiagnostic(reason, language)}</p>)}</div>}
    {!!records.length && <SelectedMailList language={language} records={records} checks={plan?.checks} action={action} defaultOpen={blocked.length > 0} />}
    {needsFolder && <label>{t('存放位置')}<select aria-label={t('存放位置')} disabled={busy} value={target} onChange={event => onTarget(event.target.value)}><option value="">{t('选文件夹')}</option>{folders.filter(folder => folder.selectable).map(folder => <option key={folder.path} value={folder.path}>{folder.path}</option>)}</select></label>}
    {!plan && <p className="hint">{busy ? t('检查中') : t('先选文件夹，再检查处理方式。')}</p>}
    {action === 'delete' && plan?.ready && <p className="hint">{t('删除移入上方垃圾箱，不永久删除。')}</p>}
    {plan?.ready && <p className="hint">{t('此次处理后，只能撤销这次整理。')}</p>}
    <div className="inline-actions">
      {plan?.ready ? <button className="primary" disabled={busy} onClick={onExecute}>{t('确认处理', { emails: mailCount(ready, language) })}</button>
        : <button disabled={busy || needsFolder && !target} onClick={onCheck}>{needsFolder && action !== 'move' ? t('保存检查') : t('检查处理')}</button>}
      <button data-dialog-cancel disabled={busy} onClick={onCancel}>{t('取消')}</button>
    </div>
  </section>;
}
