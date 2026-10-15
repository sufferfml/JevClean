/** INPUT: immutable saved evidence and an on-demand local trace reader. OUTPUT: readable analysis history.
 * POS: renderer only; never fetches a mailbox, calls Jev, or changes execution eligibility. See ./AGENTS.md. */
import { useEffect, useRef, useState } from 'react';
import type { AnalysisTrace, DecisionEvidence, MailRecord } from '../shared/contracts';
import { createTranslator, localizedAction, localizeDiagnostic, type Language } from './locale';

const choices: Record<string, string> = { match: '符合规则', not_match: '不符合', uncertain: '判断不明', no_time: '不限时间', unknown: '时间不明' };
const attempts: Record<string, string> = { sending: '结果未到', succeeded: '已有结果', failed: '请求失败', cancelled: '已停止' };

// Deliberately allowlist fields: no subjects, senders, folders, rule text, errors or vendor bodies.
export function diagnosticSummary(record: MailRecord) {
  return { format: 'JevClean diagnostic summary v1', version: record.analysis?.version,
    category: record.category, eligible: record.eligible, action: record.action, operationStatus: record.status,
    verdicts: record.verdicts.map((verdict, index) => ({ rule: index + 1, action: verdict.action, decision: verdict.decision,
      modelAnswer: verdict.modelAnswer, timeAnswer: verdict.timeAnswer })),
    attempts: record.analysis?.attempts.map(attempt => ({ attempt: attempt.attempt, status: attempt.status, durationMs: attempt.durationMs,
      httpStatus: attempt.httpStatus, errorCode: attempt.errorCode, usage: attempt.usage })) };
}

export function AnalysisDetails({ record, reportId, language, loadTrace }: {
  record: MailRecord; reportId?: string; language: Language; loadTrace?: () => Promise<AnalysisTrace | null>;
}) {
  const t = createTranslator(language);
  const [open, setOpen] = useState(false);
  const [trace, setTrace] = useState<AnalysisTrace | null | undefined>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [copied, setCopied] = useState(false);
  const generation = useRef(0);
  const snapshot = record.analysis;
  const protectedValues = record.verdicts.map(verdict => verdict.name);
  const diagnostic = (value: string) => localizeDiagnostic(value, language, protectedValues);
  useEffect(() => { generation.current++; setOpen(false); setTrace(undefined); setLoading(false); setError(''); setCopied(false); return () => { generation.current++; }; }, [reportId, record.id, record.analysis?.attempts.length, record.analysis?.attempts.at(-1)?.status, record.analysis?.attempts.at(-1)?.completedAt, record.analysis?.error]);

  async function readTrace() {
    if (!loadTrace || loading) return;
    const current = ++generation.current; setLoading(true); setError('');
    try { const value = await loadTrace(); if (current === generation.current) setTrace(value); }
    catch (cause) { if (current === generation.current) setError((cause as Error).message); }
    finally { if (current === generation.current) setLoading(false); }
  }
  function downloadSummary() {
    const url = URL.createObjectURL(new Blob([JSON.stringify(diagnosticSummary(record), null, 2)], { type: 'application/json' }));
    const link = document.createElement('a'); link.href = url; link.download = 'jevclean-diagnostic-summary.json'; link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  function criteria(questionId: string): Record<string, unknown> {
    const value = snapshot?.questions[questionId];
    return value && typeof value === 'object' && 'criteria' in value && value.criteria && typeof value.criteria === 'object' ? value.criteria as Record<string, unknown> : {};
  }
  function meaning(choice: string, questionId: string) {
    const candidate = criteria(questionId)[choice];
    if (choices[choice]) return t(choices[choice]);
    if (candidate && typeof candidate === 'object' && 'verbatim' in candidate) return String(candidate.verbatim);
    return t('未保存这个选项的含义。');
  }
  function evidence(value: DecisionEvidence | undefined, questionId: string) {
    if (!value) return <p className="hint">{t('未保存原始回答。')}</p>;
    const candidate = criteria(questionId)[value.choice];
    const dateEvidence = candidate && typeof candidate === 'object' ? candidate as Record<string, unknown> : undefined;
    return <><p><strong>{meaning(value.choice, questionId)}</strong> <code>{value.choice}</code><span className="hint"> · {t('答案分数：{probability}%', { probability: Math.round(value.probability * 100) })}</span></p>
      {dateEvidence && <dl className="analysis-time-evidence">{typeof dateEvidence.context === 'string' && <><dt>{t('原文依据')}</dt><dd>{dateEvidence.context}</dd></>}{typeof (dateEvidence.thresholdAt ?? dateEvidence.endAt) === 'string' && <><dt>{t('对应时间')}</dt><dd>{new Date(String(dateEvidence.thresholdAt ?? dateEvidence.endAt)).toLocaleString(language)}</dd></>}{typeof dateEvidence.satisfied === 'boolean' && <><dt>{t('时间要求')}</dt><dd>{t(dateEvidence.satisfied ? '已满足' : '未满足')}</dd></>}</dl>}
      <table className="probability-table"><caption>{t('选项分数')}</caption><thead><tr><th>{t('选项')}</th><th>{t('分数')}</th></tr></thead><tbody>{Object.entries(value.probabilities).map(([choice, probability]) => <tr key={choice} className={choice === value.choice ? 'chosen' : ''}><td>{meaning(choice, questionId)} <code>{choice}</code>{choice === value.choice && <span> · {t('选择结果')}</span>}</td><td>{Math.round(probability * 100)}%</td></tr>)}</tbody></table>
      <p className="hint">{t('参考分数：{confidence}。仅供参考。不是准确率。不用于决定是否处理。', { confidence: value.confidence })}</p></>;
  }
  const savedAttempts = snapshot?.attempts ?? trace?.attempts ?? [];
  const knownTokens = savedAttempts.reduce((sum, attempt) => sum + (attempt.usage ? attempt.usage.input_tokens + attempt.usage.output_tokens : 0), 0);
  const unknownUsage = savedAttempts.filter(attempt => !attempt.usage).length;
  return <div className="analysis-history">
    <button className="subtle" aria-expanded={open} onClick={() => { setOpen(!open); if (!open && trace === undefined) void readTrace(); }}>{t(open ? '收起记录' : '分析记录')}</button>
    {open && <section className="analysis-details" aria-label={t('分析记录')}>
      <div className="analysis-record-heading"><div><h4>{t('分析记录')}</h4><p className="hint">{t('只读本机记录，不连接邮箱或 Jev。')}</p></div><button className="subtle" onClick={downloadSummary}>{t('导出摘要')}</button></div>
      <p className="hint">{t('不含邮件内容、地址及规则原文。')}</p>
      {!snapshot && <p className="analysis-notice">{t('仅显示已有记录，不补造缺失内容。')}</p>}
      {snapshot && <p className="hint">{snapshot.model} · {new Date(snapshot.analyzedAt).toLocaleString(language)}</p>}
      <h4>{t('整理判断')}</h4><p>{diagnostic(snapshot?.decision?.reason ?? record.reason)}</p>{record.expiryEvidence && <p>{t('时间依据：{evidence}', { evidence: record.expiryEvidence })}</p>}{snapshot?.error && <p className="error-text">{diagnostic(snapshot.error)}</p>}
      <h4>{t('原始回答')}</h4><p className="hint">{t('显示 Jev 原始回答与分数。是否处理由应用判断。分数不代表准确率。')}</p>
      {record.verdicts.length ? record.verdicts.map(verdict => <section className="analysis-rule" key={verdict.id}><h5>{verdict.name}</h5><p className="hint">{localizedAction(verdict.action, verdict.targetMailbox, language)}</p>
        <div className="analysis-answer"><h6>{t('内容判断')}</h6>{evidence(verdict.modelAnswer, 'rule_' + verdict.id)}</div><div className="analysis-answer"><h6>{t('时间判断')}</h6>{evidence(verdict.timeAnswer, 'time_' + verdict.id)}</div>
        <p className="analysis-program-result"><strong>{t('本条结果')}</strong>{diagnostic(verdict.reason ?? verdict.decision)}</p></section>) : <p>{t('未收到可用答案，请查看请求记录。')}</p>}
      {snapshot && <><details><summary>{t('当时设置')}</summary><p className="hint">{t('保留当时设置，不随之后的修改变化。')}</p><p className="hint">{t('基本记录不含完整正文。完整提交内容请看完整记录。')}</p>{snapshot.rules.map(rule => <div className="analysis-rule" key={rule.id}><h5>{rule.name}</h5><p>{rule.description}</p><p>{localizedAction(rule.action, rule.targetMailbox, language)}</p></div>)}<pre className="request-preview" tabIndex={0}>{JSON.stringify(snapshot.questions, null, 2)}</pre></details>
      <h4>{t('请求记录')}</h4><p>{t('请求 {count} 次，已知用量 {tokens}。', { count: savedAttempts.length, tokens: knownTokens })}</p>{unknownUsage > 0 && <p className="hint">{t('{count} 次未收到用量，消耗未知。', { count: unknownUsage })}</p>}
      {!savedAttempts.length && <p className="hint">{t('这封邮件未向 Jev 发送请求。')}</p>}
      {savedAttempts.map(attempt => <div className="analysis-attempt" key={attempt.attempt}><h5>{t('第 {attempt} 次：{status}', { attempt: attempt.attempt, status: t(attempts[attempt.status]) })}</h5><p className="hint">{new Date(attempt.startedAt).toLocaleString(language)}{attempt.durationMs !== undefined ? ' · ' + t('用时 {seconds} 秒', { seconds: (attempt.durationMs / 1000).toFixed(1) }) : ''}{attempt.httpStatus ? ' · HTTP ' + attempt.httpStatus : ''}</p>{attempt.error && <p className="error-text">{diagnostic(attempt.error)}</p>}{attempt.usage && <p>{t('发送用量 {input}／返回用量 {output}', { input: attempt.usage.input_tokens, output: attempt.usage.output_tokens })}</p>}</div>)}</>}
      <h4>{t('完整记录')}</h4>
      {loading && <p role="status">{t('读取中')}</p>}{error && <p role="alert" className="error-text">{diagnostic(error)} <button className="link-button" onClick={() => { void readTrace(); }}>{t('重新读取')}</button></p>}
      {!loading && !error && !trace && <p className="hint">{t(snapshot?.traceStatus === 'disabled' ? '本次未开启，只能记录开启后的请求。' : snapshot?.traceStatus === 'incomplete' ? '完整记录未存全，基本记录仍可看。' : '可能未保存、已到期或已清除。')}</p>}
      {trace && <><p className="analysis-notice">{t('含邮件及个人信息，分享前请检查。')}{(trace.truncated || snapshot?.traceStatus === 'incomplete') && ' ' + t('已达保存上限，记录不完整。')}</p><p className="hint">{t('到期时间：{date}', { date: new Date(trace.expiresAt).toLocaleString(language) })}</p>
      <details><summary>{t('提交内容')}</summary><pre className="request-preview" tabIndex={0}>{trace.requestText}</pre></details>
      {trace.attempts.map(attempt => <details key={attempt.attempt}><summary>{t('第 {attempt} 次返回', { attempt: attempt.attempt })}</summary>{attempt.credentialsRedacted && <p className="hint">{t('认证信息已隐藏，这里非逐字原件。')}</p>}{attempt.responseTruncated && <p className="hint">{t('返回内容过长，记录不完整。')}</p>}<pre className="request-preview" tabIndex={0}>{attempt.responseText ?? t('未收到返回内容。')}</pre></details>)}
      <button className="subtle" onClick={() => { void navigator.clipboard.writeText(JSON.stringify(trace, null, 2)).then(() => setCopied(true)).catch(() => setError(t('复制失败，请展开后手动复制。'))); }}>{t(copied ? '已复制' : '复制记录')}</button></>}
    </section>}
  </div>;
}
