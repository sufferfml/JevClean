/** INPUT: saved display language and static copy. OUTPUT: local UI translations.
 * POS: renderer only; never rewrites mail, natural-language rules or Jev requests. See ./AGENTS.md. */
import english from './strings.en.json';
import { actionLabels } from '../shared/contracts';
import type { MailAction, Settings } from '../shared/contracts';
export type Language = 'zh-CN' | 'en';
const catalog: Record<string, string> = english;
// Display aliases only: never write these back to the saved evidence or model input.
const diagnosticCopy: Record<string, string> = {
  "条件判断的选项概率未达到 80%。": "答案分数不足，暂不按规则整理。",
  "时间依据的选项概率未达到 80%。": "时间分数不足，暂不按规则整理。",
  "正文过长或不完整，保留以免遗漏信息。": "正文过长或不完整，暂不整理。",
  "没有可分析的文字，保留。": "没有可分析文字，暂不整理。",
  "连续三次判断请求失败，分析已停止。已完成的结果仍然保留。": "连续三次分析失败，已停止。已有结果保留。",
  "时间候选过多，保留以免遗漏更晚的截止时间。": "日期较多，无法确定是否过期。",
  "没有启用的规则。": "请至少选择一条规则。",
  "草稿或已标记删除的邮件不参与本次操作。": "草稿和已标记删除的邮件本次跳过。",
  "服务器收件时间无法确认，保留。": "收件时间不明确，暂不整理。",
  "规则、账号或范围已改变，请重新分析。": "规则、账号或范围已变，请重新分析。",
  "这份分析记录已超过七天，请重新分析。": "分析已超过七天，请重新分析。",
  "只能重试本次分析中尚未获得有效判断、且未处理的邮件。": "只有本次未获判断且未处理的可重试。",
  "邮件身份已改变，请重新分析。": "邮件信息已变，请重新分析。",
  "邮件内容或状态已改变，请重新分析，尚未重试这封邮件。": "邮件内容或状态已变，未重试。",
  "重试未完成，已有记录仍然保留。": "重试未完成，原记录保留。",
  "无法保存本次调用记录，分析已停止，未继续发送请求。": "记录保存失败，已停止分析和发送。",
  "完整调用记录已达到 50 MiB 上限，分析已停止。请清除记录后再分析。": "记录已满，分析停止。请清除记录后再试。",
  "完整调用记录已超过 7 天保留期限，请重新分析。": "完整记录已过期，请重新分析。",
  "这次分析的完整调用记录已不再保留。": "这次完整记录已不再保留。",
  "已有其他分析的完整调用记录，不能混入本次重试。": "记录属于另一批分析，不能用于重试。",
  "没有保存模型原始回答。": "未保存原始回答。",
  "Jev 请求超时，未收到完整回答。": "Jev 响应太慢，未收到完整回答。",
  "Jev 响应超过保存上限，未采用这次判断。": "回答过长，这次判断未采用。",
  "Jev 响应包含认证信息，已隐藏该信息，未采用这次判断。": "回答含认证信息，已隐藏且未采用。",
  "本地配置格式不正确。": "本机设置无法读取，请查看详情。",
  "扫描记录格式不正确。": "分析记录无法读取，请查看详情。",
  "完整调用记录格式无效。": "完整记录无法读取，请查看详情。",
  "完整调用记录与当前记录标识不一致。": "完整记录不属于本次分析。",
  "完整调用记录的保留信息无效。": "记录保存期限有误，请查看详情。",
  "调用记录标识无效。": "找不到这份记录。",
  "调用记录时间无效。": "记录时间有误，请查看详情。"
};
export const createTranslator = (language: Language) => (text: string, values?: Record<string, string | number>) => {
  const translated = language === 'en' ? catalog[text] ?? text : text;
  return values ? formatMessage(translated, values) : translated;
};
export function localizedAction(action: MailAction | undefined, target: string | undefined, language: Language) {
  const t = createTranslator(language);
  return action === 'move' && target ? t('移动到「{folder}」', { folder: target }) : t(action === 'read' ? '标为已读' : action === 'unread' ? '标为未读' : action ? actionLabels[action] : '处理方式未定');
}
export function policySettings(settings: Settings | null | undefined) {
  if (!settings) return settings;
  const { language: _language, analysisConsent: _consent, actionFolders: _folders, detailedDiagnostics: _diagnostics, ...policy } = settings;
  return { ...policy, rules: policy.rules.map(rule => { const { targetMailbox: _target, ...judgment } = rule; return judgment; }) };
}
export function formatMessage(template: string, values: Record<string, string | number>) {
  return template.replace(/\{(\w+)\}/g, (token, key: string) => values[key] === undefined ? token : String(values[key]));
}
const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const diagnosticPattern = new RegExp(Object.keys(catalog).sort((a, b) => b.length - a.length).map(escape).join('|'), 'g');
// Diagnostics are authored by the app, not by AI. Preserve embedded names/paths byte for byte.
// The original Chinese record remains encrypted; this is a display-only conversion.
export function localizeDiagnostic(text: string, language: Language, protectedValues: string[] = []): string {
  const display = diagnosticCopy[text];
  if (display && !protectedValues.some(value => value && text.includes(value))) return createTranslator(language)(display);
  if (language !== 'en') return text;
  if (catalog[text] && !protectedValues.some(value => value && text.includes(value))) return catalog[text];
  const values = [...new Set(protectedValues.filter(Boolean))].sort((a, b) => b.length - a.length);
  const parts = values.length ? text.split(new RegExp('(' + values.map(escape).join('|') + ')', 'g')) : [text];
  return parts.map((part, index) => values.length && index % 2 ? part : part.replace(diagnosticPattern, matched => catalog[matched])
    .replaceAll('。', '. ').replaceAll('；', '; ').replaceAll('「', '“').replaceAll('」', '”').replaceAll('（', ' (').replaceAll('）', ')')).join('');
}
