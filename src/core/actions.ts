/** INPUT: rule action, folder list and provider capabilities. OUTPUT: validated execution destination. POS: generic action planning; see ./AGENTS.md. */
import type { ImapFlow } from 'imapflow';
import type { ActionCheck, ExecutionCheck, ExecutionIssue, MailboxInfo, MailRecord, Settings } from '../shared/contracts';
import { flagAction, isFolderAction } from '../shared/contracts';
import { AppError } from './errors';

export class ActionSetupError extends AppError {
  constructor(public code: ExecutionIssue, message: string) { super(message); }
}
// Exact folder aliases only. This extends ImapFlow's names without classifying mail or guessing substrings.
const aliases = {
  trash: ['trash', 'bin', 'deleted', 'deleted items', 'deleted messages', '已删除', '已刪除', '已删除邮件', '已刪除郵件', '删除邮件', '刪除郵件', '废纸篓', '廢紙簍', '回收站', '垃圾桶'],
  archive: ['archive', 'archives', '归档', '歸檔', '归档邮件', '存档', '封存'],
  junk: ['junk', 'spam', 'junk email', 'junk mail', '垃圾邮件', '垃圾郵件'],
};
const normalizeName = (value: string) => value.normalize('NFKC').trim().toLowerCase();
export function systemDestination(kind: keyof typeof aliases, folders: MailboxInfo[]): string | undefined {
  const special = kind === 'trash' ? '\\Trash' : kind === 'archive' ? '\\Archive' : '\\Junk';
  const selectable = folders.filter(folder => folder.selectable);
  const authoritative = selectable.filter(folder => folder.specialUse === special && folder.specialUseSource !== 'name');
  if (authoritative.length > 1) throw new ActionSetupError('ambiguous_destination', '邮箱返回了多个相同用途的文件夹，请选择一个操作目标。');
  if (authoritative.length === 1) return authoritative[0].path;
  const matches = selectable.filter(folder => folder.specialUse === special || (!folder.specialUse && aliases[kind].includes(normalizeName(folder.name))));
  if (matches.length > 1) throw new ActionSetupError('ambiguous_destination', '找到多个可能的操作目标，请选择一个文件夹。');
  return matches[0]?.path;
}

export function resolveDestination(record: Pick<MailRecord, 'action' | 'targetMailbox' | 'mailbox'>, settings: Settings, folders: MailboxInfo[], client: Pick<ImapFlow, 'capabilities'>): string | undefined {
  if (!isFolderAction(record.action)) return;
  const action = record.action ?? 'delete';
  const kind = action === 'delete' ? 'trash' : action === 'archive' ? 'archive' : 'junk';
  let destination = action === 'move' ? record.targetMailbox : settings.actionFolders[kind] || systemDestination(kind, folders);
  if (!destination && action === 'archive' && client.capabilities.has('X-GM-EXT-1')) {
    const all = folders.filter(folder => folder.selectable && folder.specialUse === '\\All');
    if (all.length === 1) {
      if (record.mailbox.toUpperCase() !== 'INBOX') throw new ActionSetupError('incompatible_source', 'Gmail 的全部邮件归档只适用于收件箱。请选择收件箱，或把规则改为移动到指定文件夹。');
      destination = all[0].path;
    }
  }
  if (!destination) throw new ActionSetupError('missing_destination', action === 'move' ? '请选择移动邮件的目标文件夹。' : '未能识别' + (kind === 'trash' ? '垃圾箱' : kind === 'archive' ? '归档文件夹' : '垃圾邮件文件夹') + '。请选择邮箱中用于此动作的文件夹。');
  if (!folders.some(folder => folder.path === destination && folder.selectable)) throw new ActionSetupError('invalid_destination', '所选操作目标不存在或无法打开，请重新读取文件夹并选择。');
  if (action === 'archive' && client.capabilities.has('X-GM-EXT-1') && folders.find(folder => folder.path === destination)?.specialUse === '\\All' && record.mailbox.toUpperCase() !== 'INBOX') throw new ActionSetupError('incompatible_source', 'Gmail 的全部邮件归档只适用于收件箱。请选择收件箱，或把规则改为移动到指定文件夹。');
  return destination;
}

const blocked = (error: unknown): ExecutionCheck => ({ state: 'blocked', code: error instanceof ActionSetupError ? error.code : 'needs_check', reason: error instanceof AppError ? error.message : '未能检查操作目标，请重新检查。' });
export function assessExecution(record: Pick<MailRecord, 'action' | 'targetMailbox' | 'mailbox' | 'flags'>, settings: Settings, folders: MailboxInfo[], client: Pick<ImapFlow, 'capabilities'>): { execution: ExecutionCheck; targetMailbox?: string } {
  try {
    if (!folders.some(folder => folder.path === record.mailbox && folder.selectable)) throw new ActionSetupError('invalid_source', '分析文件夹不存在或无法打开，请重新选择。');
    if (isFolderAction(record.action)) {
      if (!client.capabilities.has('MOVE') || !client.capabilities.has('UIDPLUS')) throw new ActionSetupError('unsupported_move', '邮箱服务器不支持本工具所需的安全移动与撤销。请取消这些规则，或改用已读、星标等标记动作。');
      const targetMailbox = resolveDestination(record, settings, folders, client);
      return { targetMailbox, execution: targetMailbox === record.mailbox ? { state: 'noop', reason: '邮件已在目标文件夹，无需重复操作。' } : { state: 'ready' } };
    }
    const effect = flagAction(record.action);
    return { execution: effect && record.flags.includes(effect.flag) === effect.value ? { state: 'noop', reason: '邮件标记已是目标状态，无需重复操作。' } : { state: 'ready' } };
  } catch (error) { return { execution: blocked(error) }; }
}
export function checkRuleActions(settings: Settings, folders: MailboxInfo[], client: Pick<ImapFlow, 'capabilities'>): ActionCheck[] {
  const checks = new Map<string, ActionCheck>();
  for (const rule of settings.rules.filter(rule => rule.enabled)) {
    const action = rule.action ?? 'delete'; const key = JSON.stringify([action, rule.targetMailbox]);
    const existing = checks.get(key);
    if (existing) { existing.ruleNames.push(rule.name); continue; }
    let targetMailbox = rule.targetMailbox; let execution: ExecutionCheck = { state: 'ready' };
    try {
      if (isFolderAction(action)) {
        if (!client.capabilities.has('MOVE') || !client.capabilities.has('UIDPLUS')) throw new ActionSetupError('unsupported_move', '邮箱服务器不支持本工具所需的安全移动与撤销。请取消这些规则，或改用已读、星标等标记动作。');
        for (const mailbox of settings.mailboxes) targetMailbox = resolveDestination({ action, targetMailbox: rule.targetMailbox, mailbox }, settings, folders, client);
      }
    } catch (error) { execution = blocked(error); }
    checks.set(key, { ...execution, action, targetMailbox, ruleNames: [rule.name] });
  }
  return [...checks.values()];
}
