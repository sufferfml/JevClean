/** INPUT: existing judgments and operation records. OUTPUT: plain, localized presentation.
 * POS: UI only; never changes model input, eligibility, thresholds or saved judgments. See ./AGENTS.md. */
import type { CleanupSummary, ExecutionCheck, LogEntry, MailAction, MailRecord, Progress } from '../shared/contracts';
import { isFolderAction, operationAction } from '../shared/contracts';
import { createTranslator, localizedAction, localizeDiagnostic, type Language } from './locale';

export type ResultFilter = 'clean' | 'review' | 'keep' | 'unclassified' | 'all';
const unresolved = (record: MailRecord) => !!record.conflicts?.length && !record.selectedConflict;
export function inResultFilter(record: MailRecord, filter: ResultFilter) {
  if (filter === 'all') return true;
  if (filter === 'unclassified') return record.category === 'unclassified';
  if (filter === 'review') return unresolved(record) || record.category === 'review' || record.category === 'unclassified';
  if (filter === 'keep') return record.category === 'keep' && !unresolved(record);
  return record.category === 'clean' && !unresolved(record);
}
export function mailCount(count: number, language: Language) {
  return language === 'en' ? count + (count === 1 ? ' email' : ' emails') : count + ' 封邮件';
}
export function folderLabel(action: MailAction, language: Language) {
  const t = createTranslator(language);
  return t(action === 'delete' ? '删除去向' : action === 'archive' ? '归档去向' : action === 'junk' ? '垃圾去向' : '移到哪里');
}
export function actionDestination(action: MailAction, path: string | undefined, language: Language) {
  const t = createTranslator(language);
  if (!path || !isFolderAction(action)) return localizedAction(action, undefined, language);
  return t(action === 'delete' ? '删除后移到「{folder}」' : action === 'archive' ? '归档到「{folder}」' : action === 'junk' ? '垃圾邮件移到「{folder}」' : '移动到「{folder}」', { folder: path });
}
export function executionMessage(check: ExecutionCheck | undefined, action: MailAction | undefined, language: Language) {
  const t = createTranslator(language);
  if (!check || check.state === 'ready') return '';
  if (check.state === 'noop') return t('邮件已是所需状态，无需再次处理。');
  const messages: Record<NonNullable<ExecutionCheck['code']>, string> = {
    missing_destination: action === 'move' ? '请选择移动后的文件夹。' : '请选择处理后的存放位置。',
    ambiguous_destination: '找到多个存放位置，请选一个。',
    invalid_destination: '文件夹无法打开，请刷新后重选。',
    unsupported_move: '邮箱暂不支持移动，可改用已读或星标。',
    invalid_source: '文件夹无法打开，请刷新后重选。',
    incompatible_source: '归档仅适用收件箱，也可改用移动。',
    needs_check: '位置已变，请检查邮箱，原分析仍可用。',
  };
  return check.code ? t(messages[check.code]) : userDiagnostic(check.reason ?? '', language);
}

// Match application-authored diagnostics only. User rule names and folder paths are never rewritten.
const diagnosticMessages: [RegExp, string][] = [
  [/^模型无法确认是否符合本条规则或其例外/, '本条判断不明，其他符合规则仍可用。'],
  [/^尚不能明确排除全局保留条件|^全局保留条件尚未确认/, '保留规则尚未确认，暂不整理。'],
  [/^操作未完成，请检查本地服务、邮箱连接和系统凭据库。$/, '操作未完成，请检查邮箱连接。结果未确认时先核对。'],
  [/^命中条件/, '符合规则，时间要求也已满足。'],
  [/^模型识别为本条规则中的保留例外/, '属于这条规则中要保留的邮件。'],
  [/^不符合这条规则/, '不符合这条规则。'],
  [/^保留依据不足/, '是否保留尚不明确，请查看邮件。'],
  [/Jev API key 无效|没有访问权限/, '密钥无法使用，请检查密钥及权限。'],
  [/Jev 账号额度不足/, 'Jev 额度不足，请检查账户。'],
  [/请先保存.*Jev API key/, '请先在分析服务中保存服务密钥。'],
  [/请先保存邮箱地址/, '请先在邮箱设置中保存连接信息。'],
  [/无法连接 Jev/, '无法连接 Jev，请检查网络后重试。'],
  [/Jev 暂时繁忙|Jev 请求失败/, 'Jev 暂未完成请求，请稍后再试。'],
  [/Jev 返回|Jev 响应|Jev 缺少必要判断|判断请求未完成/, '未得到可用分析结果，邮件未处理。'],
  [/UIDVALIDITY 已改变，未执行恢复|缺少原始标记/, '暂无法安全撤销，请在原邮箱中检查。'],
  [/UIDVALIDITY 已改变，未执行操作|原邮件已移动或改变，未执行操作|邮件标记已变化，请重新分析/, '邮件状态已变，未处理，请重新分析。'],
  [/邮箱状态已变化|文件夹状态已变化|原邮件已移动或改变，请重新分析/, '邮件状态已变，请重新分析。'],
  [/^找到重复邮件或多个位置/, '有多个相同邮件，请在原邮箱中检查。'],
  [/^在原文件夹和目标文件夹均未找到/, '两处都未找到邮件，请在原邮箱检查。'],
  [/^邮件身份或文件夹状态无法完整核对/, '无法完整核对，请在原邮箱中检查。'],
  [/尚未确认|自动核对未完成|服务器未返回完整移动凭据|核对时邮件位置发生变化/, '处理结果未确认，请先核对结果。确认前不要重复处理。'],
  [/无法完整核对|不能唯一|无法唯一|多个位置|未能核对|在邮件 App 中.*核对/, '邮件状态无法确认，请在原邮箱检查。'],
  [/邮箱、规则.*重新分析/, '邮箱、规则或范围已变，请重新分析。'],
  [/动作冲突/, '多条规则处理方式不同，请选一种。'],
  [/原文件夹或目标文件夹已不存在/, '原或目标位置无法打开，未处理，请刷新。'],
  [/来源和目标文件夹相同/, '邮件已在这个文件夹，无需移动。'],
  [/操作目标已改变|操作目标已修改|请检查动作配置/, '位置已变，请检查邮箱，原分析仍可用。'],
  [/没有可撤销的最近操作/, '暂无可撤销的整理。'],
  [/还没有可核对的操作记录/, '尚无整理记录，请先处理邮件。'],
  [/请切回.*邮箱|当前账号与操作账号不同/, '请切回整理这些邮件时的邮箱。'],
  [/系统凭据库|加密数据的钥匙|无效的加密文件|解密/, '本机数据无法读取，请查看详情。重新填密码不能解锁旧记录。'],
  [/本地服务连接已中断|会话已失效/, '应用连接中断，请重新打开。'],
  [/找不到.*分析记录/, '找不到分析结果，请重新分析。'],
  [/所选邮件不符合执行条件|所选动作不是/, '暂不能按所选方式处理，请核对后重选。'],
  [/同一邮件的多个副本/, '选中了同一邮件的副本，请只选一个。'],
  [/判断结果不足以执行|选项概率未达到/, '是否符合规则不明确，请查看邮件。'],
  [/缺少可确认的时间依据/, '时间要求是否满足不明确，请查看邮件。'],
  [/时间候选过多/, '邮件中日期较多，无法确定是否过期。'],
  [/尚未达到规则要求的时间/, '尚未达到规则要求的时间。'],
  [/服务器.*MOVE|服务器不支持本工具所需/, '邮箱暂不支持移动，可改用已读或星标。'],
  [/未能识别垃圾箱|未识别到删除的目标/, '请选择删除邮件后的存放位置。'],
  [/未能识别归档/, '请选择归档邮件后的存放位置。'],
  [/未能识别垃圾邮件/, '请选择垃圾邮件的存放位置。'],
  [/多个.*目标|多个相同用途/, '找到多个存放位置，请选一个。'],
  [/所选操作目标不存在/, '文件夹无法打开，请刷新后重选。'],
];
export function userDiagnostic(text: string, language: Language, protectedValues: string[] = []) {
  const diagnosticText = protectedValues.filter(Boolean).reduce((value, name) => value.replaceAll(name, '[user content]'), text);
  const matched = diagnosticMessages.find(([pattern]) => pattern.test(diagnosticText));
  return matched ? createTranslator(language)(matched[1]) : localizeDiagnostic(text, language, protectedValues);
}
export function judgmentMessage(record: MailRecord, language: Language) {
  const t = createTranslator(language);
  const names = (ids: string[]) => record.verdicts.filter(v => ids.includes(v.id)).map(v => '「' + v.name + '」').join(language === 'en' ? ', ' : '、');
  if (record.category === 'unclassified') return t('尚未分析，可选好邮件手动处理。');
  if (unresolved(record)) return t('最优先的规则处理方式不同，请选一种。');
  if (!record.verdicts.length && record.category === 'review') return t('未得到可用分析结果，邮件未处理。');
  if (record.category === 'keep') {
    const protectedBy = record.verdicts.filter(v => v.decision === 'match' && v.action === 'keep');
    if (protectedBy.length) return t('符合保留规则：{rules}。', { rules: names(protectedBy.map(v => v.id)) });
    const exceptions = record.verdicts.filter(v => v.decision === 'keep');
    if (exceptions.length) return t('属于规则中的保留例外：{rules}。', { rules: names(exceptions.map(v => v.id)) });
    return t('不符合本次选择的处理规则。');
  }
  if (record.category === 'clean' && record.matchedRules.length && names(record.matchedRules)) {
    const result = t('符合规则：{rules}。', { rules: names(record.matchedRules) });
    const prioritized = !record.selectedConflict && record.verdicts.some(verdict => verdict.decision === 'match' && verdict.action !== record.action && verdict.action !== 'keep');
    return prioritized ? result + ' ' + t('多条规则符合，优先采用{action}。', { action: localizedAction(record.action, record.targetMailbox, language) }) : result;
  }
  return userDiagnostic(record.reason, language, record.verdicts.map(v => v.name));
}
// These describe AI evidence only. A later manual operation must not recolor or relabel it.
export function judgmentBadge(record: MailRecord) {
  return record.category === 'clean' && ['delete', 'junk'].includes(record.action ?? '') ? 'delete' : record.category;
}
export function judgmentLabel(record: MailRecord, language: Language) {
  const t = createTranslator(language);
  if (record.category === 'clean' && record.action) return localizedAction(record.action, record.targetMailbox, language);
  return t(record.category === 'keep' ? '保留' : record.category === 'unclassified' ? '未分析' : record.verdicts.length ? '待查看' : '未获结果');
}
// Actual outcomes have their own axis, including for AI Keep and unclassified mail.
export function operationPending(record: MailRecord, progress?: Progress) {
  return !!progress && ['moving', 'restoring', 'checking'].includes(progress.phase) && !!progress.operationIds?.includes(record.id) && ['moving', 'restoring', 'uncertain'].includes(record.status);
}
export function operationState(record: MailRecord, language: Language, progress?: Progress) {
  const t = createTranslator(language);
  if (operationPending(record, progress)) return t(progress!.phase === 'checking' ? record.lastOperation === 'restore' ? '核对撤销' : '核对中' : progress!.phase === 'restoring' ? '撤销中' : '处理中');
  if (record.status === 'failed') return t('未成功');
  if (record.status === 'pending') return t('未处理');
  return recordState(record, language);
}
export function recordState(record: MailRecord, language: Language) {
  const t = createTranslator(language);
  if (record.status === 'moved') {
    const action = operationAction(record);
    if (isFolderAction(action)) return record.destinationPath ? t('已移到「{folder}」', { folder: record.destinationPath }) : t('已移动');
    return t(action === 'read' ? '已读' : action === 'unread' ? '未读' : action === 'star' ? '已加星标' : '已去星标');
  }
  if (record.status === 'restored') return t('已撤销');
  if (record.status === 'moving') return t('处理中');
  if (record.status === 'restoring') return t('撤销中');
  if (record.status === 'uncertain') return t('结果待查');
  if (record.category === 'unclassified') return t('未分析');
  if (unresolved(record)) return t('选择方式');
  if (record.category === 'keep') return t('保留');
  if (record.category === 'review') return t(record.verdicts.length ? '待查看' : '未获结果');
  if (!record.action || !record.eligible) return t('重新分析');
  if (record.execution?.state === 'noop') return t('无需处理');
  if (record.execution?.state === 'blocked') return t(['missing_destination', 'ambiguous_destination', 'invalid_destination'].includes(record.execution.code ?? '') ? '待选位置' : record.execution.code === 'needs_check' ? '重新检查' : '无法处理');
  return t(record.status === 'failed' ? '未成功' : '未处理');
}
export function completedMessage(record: MailRecord, language: Language, progress?: Progress) {
  const t = createTranslator(language);
  if (operationPending(record, progress)) return progress!.phase === 'checking' ? t('正在核对邮箱里的结果，请稍候。') : '';
  if (record.status === 'uncertain') return record.error ? userDiagnostic(record.error, language) : t('处理结果未确认，请先核对结果。确认前不要重复处理。');
  if (record.error) return userDiagnostic(record.error, language);
  if (record.status === 'restored') return t(isFolderAction(operationAction(record)) ? '已回到原文件夹。' : '已恢复之前的标记。');
  if (record.status === 'moved') return '';
  if (record.category === 'clean' && (!record.action || !record.eligible)) return t('结果缺少处理信息，请重新分析。');
  if (record.execution?.state === 'noop') {
    if (isFolderAction(record.action)) return t('邮件已在「{folder}」中。', { folder: record.targetMailbox ?? record.mailbox });
    return t(record.action === 'read' ? '邮件已经是已读状态。' : record.action === 'unread' ? '邮件已经是未读状态。' : record.action === 'star' ? '邮件已经有星标。' : '邮件已经没有星标。');
  }
  return executionMessage(record.execution, record.action, language);
}
export function cleanupMessage(summary: CleanupSummary, language: Language) {
  const t = createTranslator(language); const emails = (n: number) => mailCount(n, language);
  if (summary.moved === summary.total && summary.total > 0) {
    const destination = summary.destinations?.length === 1 ? summary.destinations[0] : undefined;
    if (destination?.count === summary.total) return t('已将 {emails} 移到「{folder}」。', { emails: emails(summary.total), folder: destination.path });
    return t('整理完成，已处理 {emails}。', { emails: emails(summary.moved) });
  }
  if (summary.restored === summary.total && summary.total > 0) return t('已撤销最近整理，共 {emails}。', { emails: emails(summary.restored) });
  return [summary.moved && t('已处理 {emails}', { emails: emails(summary.moved) }), summary.restored && t('已撤销 {emails}', { emails: emails(summary.restored) }), summary.failed && t('{emails} 未成功', { emails: emails(summary.failed) }), summary.uncertain && t('{emails} 结果待查', { emails: emails(summary.uncertain) })].filter(Boolean).join(language === 'en' ? '; ' : '，') || t('尚无处理完成的邮件。');
}
export function operationProgressCopy(progress: Progress, language: Language) {
  const t = createTranslator(language);
  const checking = progress.phase === 'checking';
  const folder = checking ? progress.folderCheck : undefined;
  const count = { done: progress.processed, total: progress.total };
  return {
    title: t(checking ? '核对中' : progress.phase === 'restoring' ? '撤销中' : '本次整理'),
    message: checking ? t('正在核对 {emails} 的结果', { emails: mailCount(progress.operationTotal ?? progress.total, language) })
      : t(progress.phase === 'restoring' ? '撤销中，已处理 {done} / {total} 封' : '整理中，已处理 {done} / {total} 封', count),
    detail: checking ? folder ? t('检查「{folder}」：{done} / {total} 条', { folder: folder.mailbox, done: folder.processed, total: folder.total })
      : t('已核对 {done} / {total} 封', count) : undefined,
    hint: checking ? t('只查询结果，不改其他邮件或消耗额度。') : undefined,
    processed: folder?.processed ?? progress.processed,
    total: folder?.total ?? progress.total,
  };
}
export function selectionButton(records: MailRecord[], language: Language, confirmation = false) {
  const t = createTranslator(language); const values = { emails: mailCount(records.length, language) };
  if (!records.length) return t('处理邮件');
  if (confirmation) return t('确认处理', values);
  const actions = [...new Set(records.map(r => r.action))];
  if (actions.length !== 1) return t('处理邮件', values);
  const templates: Partial<Record<MailAction, string>> = { delete: '删除', archive: '归档', move: '移动', junk: '标为垃圾', read: '标为已读', unread: '标为未读', star: '添加星标', unstar: '取消星标' };
  return t(templates[actions[0]!] ?? '处理邮件', values);
}
export function logMessage(entry: LogEntry, language: Language) {
  const t = createTranslator(language);
  const names: Record<string, string> = { 'mail.read': '邮件列表已读取。', 'actions.manual-checked': '手动处理检查完成。', 'actions.manual-finished': '手动处理已结束。', 'config.saved': '设置已保存。', 'mail.connected': '邮箱连接成功。', 'jev.connected': '分析服务检查通过。', 'scan.started': '开始分析邮件。', 'scan.finished': entry.details.status === 'cancelled' ? '分析已停止。' : entry.details.status === 'failed' ? '分析已中断。' : '分析已完成。', 'actions.preflight': entry.details.status === 'ready' ? '邮箱检查通过。' : '邮箱检查发现问题。', 'actions.requested': '开始处理所选邮件。', 'actions.finished': '本次整理已结束。', 'actions.checked': '整理结果已更新。', 'undo.finished': '本次撤销已结束。', 'actions.conflict-resolved': '已选好处理方式。', 'credentials.forgotten': '保存的密码和密钥已清除。', 'reports.deleted': '分析结果和撤销记录已清除。', 'service.started': '应用已启动。', 'service.reopened': '应用已再次打开。', 'operation.rejected': '本次操作未完成。', 'operation.failed': '本次操作未完成。' };
  const reasons: Record<string, string> = {
    move_receipt_missing: '未收到移动确认，开始核对。', move_receipt_incomplete: '移动确认不完整，开始核对。', move_receipt_invalid: '移动位置不一致，开始核对。',
    operation_connection_error: '操作后连接中断，开始核对。', operation_response_error: '未收到明确结果，开始核对。', flag_confirmation_failed: '邮件标记尚未确认，开始核对。',
    verification_connection_error: '核对时连接中断，结果待查。', verification_read_error: '核对信息未读完整，结果待查。', verification_snapshot_changed: '核对时邮件发生变化，结果待查。',
    verification_identity_changed: '邮件信息无法完整核对。', verification_flag_unknown: '无法确认邮件当前或原来的标记。', verification_duplicate_locations: '发现重复邮件或多个位置，结果待查。', verification_message_missing: '原位置及目标位置都未找到邮件。',
  };
  const verification: Record<string, string> = { 'actions.confirmation-needed': '开始自动核对处理结果。', 'actions.verification-started': '开始核对处理结果。', 'actions.verification-finished': entry.details.uncertain ? '核对结束，部分结果待查。' : '处理结果核对完成。', 'actions.verification-failed': '处理结果未核对完成。', 'actions.verification-unresolved': '核对结束，部分结果待查。' };
  const message = t(reasons[String(entry.details.reasonCode)] ?? verification[entry.event] ?? names[entry.event] ?? '使用记录');
  return typeof entry.details.durationMs === 'number' ? t('{message} · 用时 {seconds} 秒', { message, seconds: (entry.details.durationMs / 1000).toFixed(1) }) : message;
}
