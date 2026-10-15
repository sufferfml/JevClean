import { createHash } from 'node:crypto';
import type { ActionChoice, MailAction, Settings } from '../shared/contracts';
import { ruleSchema } from '../shared/contracts';

export const JEV_MODEL = 'jev-1.13.0';
// This candidate gate precedes explicit human confirmation and a recorded, reversible action.
// Choice confidence is derived from probability; it is not an independent accuracy test.
// Limited, labelled experiments informed the existing cleanup gate; new action questions need live validation.
// It still requires user selection, confirmation and recorded recovery; it is not an accuracy guarantee.
export const MIN_PROBABILITY = 0.8;
type MatchedRuleAction = {
  id: string; action: Exclude<MailAction, 'keep'>; targetMailbox?: string; probability: number; confidence: number;
};
const actionPriority: Record<MatchedRuleAction['action'], number> = {
  delete: 5, junk: 4, move: 3, archive: 2, read: 1, unread: 1, star: 1, unstar: 1,
};
// Call only after preservation checks. A lower-ranked action cannot settle a highest-rank tie.
export function mergeRuleActions(matches: MatchedRuleAction[]): ActionChoice[] {
  const highest = Math.max(...matches.map(match => actionPriority[match.action]));
  const groups = new Map<string, MatchedRuleAction[]>();
  for (const match of matches.filter(match => actionPriority[match.action] === highest)) {
    const key = JSON.stringify([match.action, match.targetMailbox]);
    groups.set(key, [...(groups.get(key) ?? []), match]);
  }
  return [...groups.values()].map(group => {
    const best = group.reduce((a, b) => a.probability >= b.probability ? a : b);
    return { id: group[0].id, action: best.action, targetMailbox: best.targetMailbox, ruleIds: group.map(match => match.id),
      probability: best.probability, confidence: best.confidence };
  });
}
export function policyHash(settings: Settings): string {
  // Preferences do not alter classification; version 8 defines the rule semantics.
  return createHash('sha256').update(JSON.stringify({ version: 8, model: JEV_MODEL, probability: MIN_PROBABILITY, account: [settings.email.toLowerCase(), settings.host.toLowerCase(), settings.port], mailboxes: [...settings.mailboxes].sort(), scanLimit: settings.scanLimit, folders: settings.actionFolders, rules: settings.rules.filter(r => r.enabled) })).digest('hex');
}
// Folder mappings affect execution, not Jev's already-paid semantic judgment.
export function judgmentHash(settings: Settings): string {
  const { actionFolders: _folders, ...rest } = settings;
  return policyHash({ ...rest, rules: rest.rules.map(rule => { const { targetMailbox: _target, ...judgment } = ruleSchema.parse(rule); return judgment; }), actionFolders: {} });
}
export function sameJudgment(report: { judgmentHash?: string; policyHash: string }, settings: Settings) {
  return report.judgmentHash === judgmentHash(settings);
}
