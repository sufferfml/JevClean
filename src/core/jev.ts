import { z } from 'zod';
import { JEV_MODEL } from './rules';
import type { JevAttempt } from '../shared/contracts';

const probability = z.number().min(0).max(1);
const choiceSchema = z.object({
  type: z.literal('choice'), choice: z.string(),
  confidence: probability, probabilities: z.record(z.string(), probability),
});
export interface JevRequest {
  model: string; state: unknown;
  questions: Record<string, { type: 'choice' | 'noul'; instructions: string | object; criteria?: Record<string, unknown> }>;
}
export interface JevResponse {
  model: string;
  answers: Record<string, z.infer<typeof choiceSchema> | { type: 'noul'; noul: number }>;
  usage: { input_tokens: number; output_tokens: number };
}
const responseSchema = z.object({
  model: z.string(),
  answers: z.record(z.string(), z.union([choiceSchema, z.object({ type: z.literal('noul'), noul: probability })])),
  usage: z.object({ input_tokens: z.number().int().nonnegative(), output_tokens: z.number().int().nonnegative() }),
});
export class JevError extends Error {
  constructor(message: string, public readonly fatal: boolean = false, public readonly code = 'unknown') { super(message); this.name = 'JevError'; }
}
export type Evaluate = (request: JevRequest, signal?: AbortSignal) => Promise<JevResponse>;
export type AttemptObserver = (attempt: JevAttempt) => Promise<void>;
export const MAX_JEV_RESPONSE_BYTES = 1024 * 1024;

// Keep the received text, including invalid JSON, without accepting an unbounded vendor body.
async function responseText(response: Response): Promise<{ text: string; truncated: boolean }> {
  if (!response.body) return { text: '', truncated: false };
  const reader = response.body.getReader(); const decoder = new TextDecoder();
  let bytes = 0; let text = ''; let truncated = false;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      const remaining = MAX_JEV_RESPONSE_BYTES - bytes;
      text += decoder.decode(next.value.subarray(0, remaining), { stream: true });
      bytes += Math.min(remaining, next.value.byteLength);
      if (next.value.byteLength > remaining) { truncated = true; await reader.cancel(); break; }
    }
    text += decoder.decode();
    return { text, truncated };
  } finally { reader.releaseLock(); }
}
function hideKey(text: string, apiKey: string): string {
  if (!apiKey) return text;
  const escaped = JSON.stringify(apiKey).slice(1, -1);
  return [apiKey, escaped].reduce((value, key) => value.split(key).join('[API key removed]'), text);
}
function knownUsage(json: unknown): JevAttempt['usage'] {
  if (!json || typeof json !== 'object' || !('usage' in json)) return undefined;
  const result = responseSchema.shape.usage.safeParse(json.usage);
  return result.success ? result.data : undefined;
}
export function createEvaluator(apiKey: string, transport: typeof fetch = fetch, observer?: AttemptObserver): Evaluate {
  const observe = async (attempt: JevAttempt) => {
    if (!observer) return;
    try { await observer(structuredClone(attempt)); }
    catch { throw new JevError('无法保存本次调用记录，分析已停止，未继续发送请求。', true, 'diagnostics_write_failed'); }
  };
  return async (request, signal) => {
    for (let attempt = 0; attempt < 3; attempt++) {
      signal?.throwIfAborted();
      const started = Date.now();
      const entry: JevAttempt = { attempt: attempt + 1, startedAt: new Date(started).toISOString(), status: 'sending' };
      await observe(entry);
      const finish = async (status: JevAttempt['status'], error?: JevError) => {
        entry.status = status; entry.completedAt = new Date().toISOString(); entry.durationMs = Math.max(0, Date.now() - started);
        if (error) { entry.errorCode = error.code; entry.error = error.message; }
        await observe(entry);
      };
      const timeout = AbortSignal.timeout(30000);
      const requestSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
      let response: Response; let received: { text: string; truncated: boolean };
      try {
        signal?.throwIfAborted();
        response = await transport('https://api.typesafe.ai/v1/systemone', {
          method: 'POST', redirect: 'error',
          headers: { Authorization: 'Bearer ' + apiKey, 'Content-Type': 'application/json' },
          body: JSON.stringify(request),
          signal: requestSignal,
        });
        entry.httpStatus = response.status;
        received = await responseText(response);
      } catch (error) {
        const cancelled = signal?.aborted;
        const timedOut = !cancelled && (timeout.aborted || (error instanceof Error && error.name === 'TimeoutError'));
        const failure = new JevError(cancelled ? '本次分析已停止，未收到完整回答。' : timedOut ? 'Jev 请求超时，未收到完整回答。' : '无法连接 Jev。请检查网络后重试。', false,
          cancelled ? 'cancelled' : timedOut ? 'timeout' : 'network');
        await finish(cancelled ? 'cancelled' : 'failed', failure);
        if (cancelled) throw signal.reason;
        throw failure;
      }
      if (received.truncated) entry.responseTruncated = true;
      let json: unknown;
      if (!received.truncated) { try { json = JSON.parse(received.text); } catch { /* A failed parse is recorded below, without echoing the body. */ } }
      const safeText = hideKey(received.text, apiKey);
      const normalizedJson = json === undefined ? undefined : JSON.stringify(json);
      const safeJson = normalizedJson === undefined ? undefined : hideKey(normalizedJson, apiKey);
      // JSON escapes can conceal a literal credential in the wire text. Detect decoded JSON too.
      const credentialsRedacted = safeText !== received.text || safeJson !== normalizedJson;
      if (credentialsRedacted) entry.credentialsRedacted = true;
      if (observer) entry.responseText = safeJson !== normalizedJson ? safeJson : safeText;
      entry.usage = knownUsage(json);
      if (!response.ok) {
        const failure = response.status === 401 || response.status === 403 ? new JevError('Jev API key 无效或没有访问权限。', true, 'http') :
          response.status === 402 ? new JevError('Jev 账号额度不足。', true, 'http') :
            new JevError('Jev 请求失败（HTTP ' + response.status + '）。', response.status === 400, 'http');
        await finish('failed', failure);
        if (!((response.status === 429 || response.status >= 500) && attempt < 2)) throw failure;
      }
      if ((response.status === 429 || response.status >= 500) && attempt < 2) {
        const retryAfter = Number(response.headers.get('retry-after'));
        const delay = Math.min(10000, Math.max(1000, (Number.isFinite(retryAfter) ? retryAfter * 1000 : 0), 1000 * 2 ** attempt));
        signal?.throwIfAborted();
        await new Promise<void>((resolve, reject) => {
          const onAbort = () => { clearTimeout(timer); reject(signal?.reason); };
          const timer = setTimeout(() => { signal?.removeEventListener('abort', onAbort); resolve(); }, delay);
          signal?.addEventListener('abort', onAbort, { once: true });
        });
        continue;
      }
      const invalid = async (message: string): Promise<never> => {
        const failure = new JevError(message, false, 'invalid_response'); await finish('failed', failure); throw failure;
      };
      if (credentialsRedacted) return invalid('Jev 响应包含认证信息，已隐藏该信息，未采用这次判断。');
      if (received.truncated) return invalid('Jev 响应超过保存上限，未采用这次判断。');
      if (json === undefined) return invalid('Jev 返回了无法读取的响应。');
      const parsed = responseSchema.safeParse(json);
      if (!parsed.success) return invalid('Jev 响应不符合接口结构，相关邮件已保留。');
      for (const [key, question] of Object.entries(request.questions)) {
        const answer = parsed.data.answers[key];
        if (!answer || answer.type !== question.type) return invalid('Jev 缺少必要判断，相关邮件已保留。');
        if (answer.type === 'choice') {
          const options = Object.keys(question.criteria ?? {});
          const entries = Object.keys(answer.probabilities);
          if (!options.includes(answer.choice) || options.some((key) => !(key in answer.probabilities)) ||
              entries.some((key) => !options.includes(key)) ||
              Math.abs(Object.values(answer.probabilities).reduce((sum, value) => sum + value, 0) - 1) > 0.025 ||
              Object.values(answer.probabilities).some((value) => value > answer.probabilities[answer.choice] + 0.001)) {
            return invalid('Jev 返回了无效分类，相关邮件已保留。');
          }
        }
      }
      await finish('succeeded');
      return parsed.data;
    }
    throw new JevError('Jev 暂时繁忙，请稍后重试。');
  };
}
export async function testEvaluator(evaluate: Evaluate): Promise<string> {
  const result = await evaluate({
    model: JEV_MODEL, state: 'JevClean connection test. No email content.',
    questions: { connection: { type: 'noul', instructions: 'Does this text identify itself as a connection test?' } },
  });
  return result.model;
}
