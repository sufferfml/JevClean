/** INPUT: selected mail snapshots and optional server-checked manual plan. OUTPUT: inspectable selection details.
 * POS: renderer presentation; does not infer execution eligibility or change selection. See ./AGENTS.md. */
import type { MailRecord, ManualInput, ManualPlan } from '../shared/contracts';
import { currentLocation } from '../shared/contracts';
import { createTranslator, type Language } from './locale';
import { actionDestination, judgmentLabel, userDiagnostic } from './mail-copy';

interface Props {
  language?: Language;
  records: MailRecord[];
  checks?: ManualPlan['checks'];
  action?: ManualInput['action'];
  defaultOpen?: boolean;
  summary?: string;
  reasons?: Record<string, string>;
}

export function SelectedMailList({ language = 'zh-CN', records, checks, action, defaultOpen = false, summary, reasons }: Props) {
  const t = createTranslator(language);
  const checksById = new Map(checks?.map(check => [check.id, check]));
  return <details className="selected-mail-list" open={defaultOpen || undefined}>
    <summary>{summary ?? t('所选邮件（{count}）', { count: records.length })}</summary>
    <ul className="selected-mail-items" aria-label={t('所选邮件')}>
      {records.map(record => {
        const check = checksById.get(record.id);
        const folder = currentLocation(record).mailbox ?? record.mailbox;
        const protectedValues = [folder, check?.targetMailbox ?? '', ...record.verdicts.map(verdict => verdict.name)];
        const state = check ? t(check.state === 'ready' ? '准备处理' : check.state === 'noop' ? '无需处理' : '无法处理') : undefined;
        const actionText = action && check?.state === 'ready'
          ? actionDestination(action, check.targetMailbox, language)
          : checks ? '' : judgmentLabel(record, language);
        return <li className={'selected-mail-item' + (check ? ' is-' + check.state : '')} key={record.id}>
          <div className="selected-mail-identity">
            <strong>{record.subject || t('无主题')}</strong>
            <span className="selected-mail-meta">{record.sender || record.senderAddress}<span aria-hidden="true"> · </span>{folder}</span>
          </div>
          <div className="selected-mail-check">
            {state && <span className={'selection-check-state ' + check!.state}>{state}</span>}
            {actionText && <span>{actionText}</span>}{reasons?.[record.id] && <p>{reasons[record.id]}</p>}
            {check?.state === 'noop' && <p>{check.reason ? userDiagnostic(check.reason, language, protectedValues) : t('邮件已是所需状态，无需再次处理。')}</p>}
            {check?.state === 'blocked' && <p>{userDiagnostic(check.reason ?? '这些邮件暂时无法处理。', language, protectedValues)}</p>}
            {checks && !check && <p>{t('这封邮件尚未完成检查。')}</p>}
          </div>
        </li>;
      })}
    </ul>
  </details>;
}
