import { z } from 'zod';

export const actionIds = ['delete', 'archive', 'move', 'junk', 'read', 'unread', 'star', 'unstar', 'keep'] as const;
export type MailAction = typeof actionIds[number];
export const actionLabels: Record<MailAction, string> = { delete: '删除', archive: '归档', move: '移动', junk: '标为垃圾', read: '标为已读', unread: '标为未读', star: '添加星标', unstar: '取消星标', keep: '保留' };
export function actionLabel(action?: MailAction, targetMailbox?: string): string {
  return action === 'move' && targetMailbox ? '移动到 ' + targetMailbox : action ? actionLabels[action] : '未处理';
}
export const isFolderAction = (action?: MailAction) => !action || ['delete', 'archive', 'move', 'junk'].includes(action);
export function flagAction(action?: MailAction): { flag: string; value: boolean } | undefined {
  if (action === 'read' || action === 'unread') return { flag: '\\Seen', value: action === 'read' };
  if (action === 'star' || action === 'unstar') return { flag: '\\Flagged', value: action === 'star' };
}

export const ruleSchema = z.object({
  id: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/),
  name: z.string().trim().min(1).max(80),
  description: z.string().trim().min(1).max(2000),
  enabled: z.boolean(),
  action: z.enum(actionIds).default('delete'),
  targetMailbox: z.string().trim().min(1).max(256).optional(),
}).strict().superRefine((rule, context) => {
  if (rule.enabled && rule.action === 'move' && !rule.targetMailbox) context.addIssue({ code: 'custom', path: ['targetMailbox'], message: '请选择移动的目标文件夹' });
  if (rule.action !== 'move' && rule.targetMailbox) context.addIssue({ code: 'custom', path: ['targetMailbox'], message: '只有移动动作需要目标文件夹' });
});
// Rules created without an explicit action use the default delete action.
export type Rule = Omit<z.infer<typeof ruleSchema>, 'action'> & { action?: MailAction };
export const defaultRules: Rule[] = [
  { id: 'promotions', name: '广告推广', enabled: true, description: '清理以推广商品、服务或品牌为主要用途的群发邮件，包括促销、试用推荐、厂商公开课或峰会的营销邀请，不设置时间限制。保留订单、付款、账单、物流、售后记录、报名成功凭证和正在进行的个人业务沟通；这些邮件附带优惠或推荐，不改变其主要用途。' },
  { id: 'verification', name: '验证码', enabled: true, description: '清理已经失效的一次性登录、注册或身份验证的验证码邮件。以正文明确的有效期或截止时间为准；未注明时，仅清理收到超过24小时的邮件。附带可疑登录、修改密码等安全提醒的验证码邮件仍按验证码处理。保留恢复码、长期有效的激活码，以及不以提供一次性验证码为主要用途的独立账号安全告警。' },
  { id: 'events', name: '过期活动', enabled: true, description: '清理已过期的活动介绍、推广、报名邀请或报名提醒。活动介绍以最后一场活动的结束时间为准；仅用于报名的邀请或提醒，以最终报名截止时间为准。无法确认适用时间时不清理。保留门票、报名成功凭证、证书、个人会议或预约安排，以及需要处理的变更通知；这些记录附带活动推荐，不改变其主要用途。' },
  { id: 'notifications', name: '旧通知', enabled: false, description: '清理收到超过30天的点赞、关注、内容推荐和社交动态汇总等自动通知。保留真实的私信、评论回复、提及我、个人业务沟通，以及明确需要我处理的任务、审批、交易或独立安全告警。通用的“查看详情”等按钮不代表需要回应；邮件里提到私信或任务，也不等于它本身就是此类消息。' },
].map(rule => ({ ...rule, action: 'delete' as const }));
export const settingsSchema = z.object({
  email: z.union([z.email().max(254), z.literal('')]),
  host: z.string().trim().max(253).regex(/^[a-zA-Z0-9.-]*$/, '请填写 IMAP 服务器域名'),
  port: z.number().int().min(1).max(65535),
  mailboxes: z.array(z.string().trim().min(1).max(256)).max(100)
    .refine(paths => new Set(paths).size === paths.length, '文件夹不能重复'),
  scanLimit: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).nullable().default(100),
  rules: z.array(ruleSchema).max(30).refine(rules => new Set(rules.map(r => r.id)).size === rules.length, '规则标识不能重复'),
  actionFolders: z.object({ trash: z.string().trim().min(1).max(256).optional(), archive: z.string().trim().min(1).max(256).optional(), junk: z.string().trim().min(1).max(256).optional() }).strict().default({}),
  language: z.enum(['zh-CN', 'en']).optional(),
  analysisConsent: z.boolean().optional(),
  detailedDiagnostics: z.boolean().optional(),
}).strict();
export type Settings = Omit<z.infer<typeof settingsSchema>, 'rules'> & { rules: Rule[] };
export const defaultSettings: Settings = { email: '', host: '', port: 993, mailboxes: ['INBOX'], scanLimit: 100, rules: defaultRules, actionFolders: {}, detailedDiagnostics: false };
export const saveInputSchema = z.object({
  settings: settingsSchema, imapPassword: z.string().max(4096).optional(), jevApiKey: z.string().max(4096).optional(),
}).strict();
export type SaveInput = Omit<z.infer<typeof saveInputSchema>, 'settings'> & { settings: Settings };
// Only discrete analysis preferences can be saved without committing settings-page drafts.
export const analysisSettingsSchema = z.object({
  mailboxes: settingsSchema.shape.mailboxes.optional(),
  scanLimit: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).nullable().optional(),
  enabledRules: z.array(z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/)).max(30).refine(ids => new Set(ids).size === ids.length).optional(),
  analysisConsent: z.boolean().optional(),
}).strict();
export type AnalysisSettingsInput = z.infer<typeof analysisSettingsSchema>;
export interface Secrets { imapPassword: string; jevApiKey: string }
export interface PublicConfig { settings: Settings; hasImapPassword: boolean; hasJevApiKey: boolean; secureStorage: boolean; policyHash: string; judgmentHash?: string; accountIdentity?: string; mailConnection?: { connected: boolean; checkedAt?: string } }
export interface MailboxInfo { path: string; name: string; selectable: boolean; specialUse?: string; specialUseSource?: string }
export type ExecutionIssue = 'missing_destination' | 'ambiguous_destination' | 'invalid_destination' | 'unsupported_move' | 'invalid_source' | 'incompatible_source' | 'needs_check';
export interface ExecutionCheck { state: 'ready' | 'blocked' | 'noop'; code?: ExecutionIssue; reason?: string }
export interface ActionCheck extends ExecutionCheck { action: MailAction; targetMailbox?: string; ruleNames: string[] }
export interface ActionPreflight { ready: boolean; checkedAt: string; policyHash: string; folders: MailboxInfo[]; checks: ActionCheck[]; sourceError?: string }
export interface EmailMessage {
  uid: number; uidValidity: string; mailbox: string; messageId: string; fingerprint: string;
  subject: string; sender: string; senderAddress: string; date: string;
  flags: string[]; hasAttachment: boolean; isReply: boolean; text: string; textTruncated: boolean;
}
export type Category = 'clean' | 'keep' | 'review' | 'unclassified';
export const categoryLabels: Record<Category, string> = { clean: '未处理', keep: '保留', review: '不确定', unclassified: '未分类' };
export interface DecisionEvidence { choice: string; confidence: number; probability: number; probabilities: Record<string, number> }
export interface JevAttempt {
  attempt: number; startedAt: string; completedAt?: string; durationMs?: number;
  status: 'sending' | 'succeeded' | 'failed' | 'cancelled';
  httpStatus?: number; errorCode?: string; error?: string;
  usage?: { input_tokens: number; output_tokens: number };
  // Only the opt-in, separately encrypted trace may contain response bodies.
  responseText?: string; responseTruncated?: boolean; credentialsRedacted?: boolean;
}
export interface AnalysisSnapshot {
  version: 8; model: string; analyzedAt: string; rules: Rule[];
  questions: Record<string, unknown>; attempts: JevAttempt[]; error?: string;
  inputHash?: string;
  decision?: Pick<Classification, 'category' | 'reason' | 'action' | 'matchedRules'>;
  traceStatus?: 'saved' | 'disabled' | 'incomplete';
}
export interface AnalysisTrace {
  reportId: string; recordId: string; createdAt: string; expiresAt: string;
  requestText: string; attempts: JevAttempt[]; truncated?: boolean;
}
export interface RuleVerdict {
  id: string; name: string; decision: 'match' | 'not_match' | 'keep' | 'uncertain'; confidence: number;
  // Optional for reports written before diagnostics existed. Original answers are never overwritten.
  modelAnswer?: DecisionEvidence; timeAnswer?: DecisionEvidence; reason?: string;
  action?: MailAction; targetMailbox?: string;
}
export interface ActionChoice { id: string; action: MailAction; targetMailbox?: string; ruleIds: string[]; probability: number; confidence: number; error?: string; execution?: ExecutionCheck }
export interface Classification {
  category: Category; eligible: boolean; reason: string; confidence: number; probability: number;
  matchedRules: string[]; verdicts: RuleVerdict[]; expiryEvidence?: string;
  action?: MailAction; targetMailbox?: string;
  conflicts?: ActionChoice[]; selectedConflict?: string;
  // AI eligibility and execution readiness are independent. Operational errors never rewrite category/reason.
  execution?: ExecutionCheck;
}
export interface MailLocation { mailbox: string; uidValidity: string; uid: number }
export interface MailRecord extends Omit<EmailMessage, 'text'>, Classification {
  analysis?: AnalysisSnapshot;
  id: string; status: 'pending' | 'moving' | 'moved' | 'restoring' | 'restored' | 'failed' | 'uncertain';
  destinationUid?: number; destinationUidValidity?: string; destinationPath?: string; error?: string;
  lastOperation?: 'move' | 'restore';
  previousFlag?: boolean;
  // The executed action is independent of the original AI classification and its planned action.
  operation?: { source: 'manual' | 'rule'; action: Exclude<MailAction, 'keep'>; targetMailbox?: string };
  // Verified locations belonging to this operation. Retain old UIDs when undo assigns a new one.
  // Optional for older encrypted records; their source and complete destination receipts still apply.
  operationLocations?: MailLocation[];
}
export interface ScanReport {
  kind?: 'mail' | 'analysis';
  id: string; accountIdentity: string; startedAt: string; completedAt?: string;
  status: 'running' | 'complete' | 'cancelled' | 'failed'; mailboxes: string[];
  scanLimit?: number | null;
  total: number; processed: number; inputTokens: number; outputTokens: number; apiCalls: number;
  records: MailRecord[]; error?: string; model: string; policyHash: string;
  actionCheckedAt?: string;
  judgmentHash?: string;
}
export interface CleanupSummary {
  total: number; moved: number; restored: number; failed: number; uncertain: number; checkedAt?: string; reportId?: string;
  actions?: Partial<Record<MailAction, number>>;
  // Confirmed destinations from the latest operation, never inferred from current settings.
  destinations?: { action: MailAction; path: string; count: number }[];
  // Actual latest-batch issues, independent of the current report and earlier operations.
  issues?: { id: string; subject: string; status: 'pending' | 'failed' | 'uncertain' | 'moving' | 'restoring'; reason: string }[];
}
export interface Progress {
  phase: 'idle' | 'connecting' | 'reading' | 'scanning' | 'moving' | 'restoring' | 'checking' | 'complete';
  // Counts for this stage's selected messages, never the size of a folder being searched.
  processed: number; total: number; mailbox?: string; report?: ScanReport; cleanup?: CleanupSummary | null;
  operationTotal?: number;
  // IDs in the displayed report that belong to the active operation; never execution authorization.
  operationIds?: string[];
  folderCheck?: { mailbox: string; processed: number; total: number };
}
export const operationDiagnosticReasons = ['move_receipt_missing', 'move_receipt_incomplete', 'move_receipt_invalid', 'operation_connection_error', 'operation_response_error', 'flag_confirmation_failed', 'verification_connection_error', 'verification_read_error', 'verification_snapshot_changed', 'verification_identity_changed', 'verification_flag_unknown', 'verification_duplicate_locations', 'verification_message_missing'] as const;
export type OperationDiagnosticReason = typeof operationDiagnosticReasons[number];
export interface OperationDiagnostic {
  event: 'actions.confirmation-needed' | 'actions.verification-started' | 'actions.verification-finished' | 'actions.verification-failed' | 'actions.verification-unresolved';
  details: { total?: number; moved?: number; restored?: number; failed?: number; uncertain?: number; reasonCode?: OperationDiagnosticReason; durationMs?: number };
}
export interface RuntimeStatus { phase: Progress['phase']; processed: number; total: number; busy: boolean; language: 'zh-CN' | 'en' }
export interface ActionResult { moved: number; failed: number; uncertain: number; report: ScanReport; canUndo: boolean; cleanup: CleanupSummary | null }
export interface MessagePreview { subject: string; originalText: string; sentToJev: string; usesCurrentRules?: boolean }
export interface Bootstrap { config: PublicConfig; report: ScanReport | null; canUndo: boolean; cleanup: CleanupSummary | null; progress: Progress; preflight?: ActionPreflight | null }
export interface ActionCheckResult { preflight: ActionPreflight; report: ScanReport | null }
export const canExecute = (record: MailRecord) => record.eligible && record.category === 'clean' && record.action !== 'keep' && ['pending', 'failed'].includes(record.status) && (!record.execution || record.execution.state === 'ready');
export const canSelect = (record: MailRecord) => !['uncertain', 'moving', 'restoring'].includes(record.status);
export const canRetryAnalysis = (record: MailRecord) => record.status === 'pending' && !record.operation && !record.verdicts.length &&
  record.analysis?.version === 8 && !!record.analysis.inputHash &&
  (!!record.analysis.error || record.analysis.attempts.some(attempt => attempt.status === 'sending' || attempt.status === 'failed' || attempt.status === 'cancelled'));
export const operationAction = (record: MailRecord) => record.operation?.action ?? record.action;
export function currentLocation(record: MailRecord) {
  const moved = record.status === 'moved' && isFolderAction(operationAction(record));
  return { mailbox: moved ? record.destinationPath : record.mailbox, uid: moved ? record.destinationUid : record.uid,
    uidValidity: moved ? record.destinationUidValidity : record.uidValidity };
}
export const manualActionIds = ['delete', 'archive', 'move', 'junk', 'read', 'unread', 'star', 'unstar'] as const;
export const manualInputSchema = z.object({
  ids: z.array(z.string().min(1).max(100)).min(1).max(10000).refine(ids => new Set(ids).size === ids.length),
  action: z.enum(manualActionIds), targetMailbox: z.string().trim().min(1).max(256).optional(),
}).strict();
export type ManualInput = z.infer<typeof manualInputSchema>;
export interface ManualPlan {
  id: string; action: ManualInput['action']; ready: boolean;
  checks: (ExecutionCheck & { id: string; targetMailbox?: string })[];
  destinations: { path: string; count: number }[];
  folders: MailboxInfo[];
}
export interface LogEntry { time: string; event: string; details: Record<string, string | number | boolean> }
export const providers = [
  { name: 'Gmail', host: 'imap.gmail.com', note: '通常需开启两步验证。再生成应用专用密码。有些账号无法使用这种连接方式。' },
  { name: 'QQ 邮箱', host: 'imap.qq.com', note: '开启第三方邮箱访问，填写授权码。' },
  { name: '163 邮箱', host: 'imap.163.com', note: '开启第三方邮箱访问，填写授权密码。' },
  { name: '126 邮箱', host: 'imap.126.com', note: '开启第三方邮箱访问，填写授权密码。' },
  { name: 'iCloud', host: 'imap.mail.me.com', note: '填写 Apple 账户生成的专用密码。' },
  { name: '飞书', host: 'imap.feishu.cn', note: '开启第三方邮箱访问，填写专用密码。' },
];
