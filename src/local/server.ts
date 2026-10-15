/** INPUT: local store, static assets and core service. OUTPUT: authenticated loopback API. POS: browser/process boundary; see ./AGENTS.md. */
import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readFile, realpath } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import { z } from 'zod';
import { analysisSettingsSchema, manualInputSchema, saveInputSchema, settingsSchema } from '../shared/contracts';
import type { OperationDiagnostic, Progress } from '../shared/contracts';
import { MailService } from '../core/service';
import { LocalStore } from '../core/storage';
import { AppError } from '../core/errors';
import { JevError } from '../core/jev';
import { LocalLogger } from './logger';

interface Options { store: LocalStore; webDirectory: string; logger: LocalLogger; port?: number; token?: string; createService?: (emit: (progress: Progress) => void, diagnose: (entry: OperationDiagnostic) => void) => MailService; onShutdown?: () => void }
class HttpError extends AppError { constructor(message: string, public status: number) { super(message); } }
const maxBody = 256 * 1024;
const mime: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.ico': 'image/x-icon' };
function body(req: IncomingMessage): Promise<unknown> {
  if (!req.headers['content-type']?.startsWith('application/json')) return Promise.reject(new HttpError('需要 JSON 请求。', 415));
  if (Number(req.headers['content-length']) > maxBody) { req.resume(); return Promise.reject(new HttpError('请求过大。', 413)); }
  return new Promise((accept, reject) => {
    const chunks: Buffer[] = []; let size = 0; let failed = false;
    req.on('data', chunk => { size += chunk.length; if (size > maxBody) { failed = true; reject(new HttpError('请求过大。', 413)); } else if (!failed) chunks.push(chunk); });
    req.on('end', () => { if (failed) return; try { accept(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch { reject(new HttpError('无效的 JSON。', 400)); } });
    req.on('error', () => reject(new HttpError('请求未完成。', 400)));
  });
}
function parsed<T>(schema: z.ZodType<T>, value: unknown): T { const result = schema.safeParse(value); if (!result.success) throw new HttpError('请求参数不正确。', 400); return result.data; }
export async function startLocalServer(options: Options) {
  await options.store.purgeExpiredDiagnostics(new Date());
  const token = options.token ?? randomBytes(32).toString('hex'); const secret = Buffer.from(token);
  let progress: Progress = { phase: 'idle', processed: 0, total: 0 };
  const diagnose = (entry: OperationDiagnostic) => options.logger.record(entry.event, entry.details);
  const service = options.createService?.(value => { progress = value; }, diagnose) ?? new MailService(options.store, value => { progress = value; }, undefined, undefined, undefined, diagnose);
  const webRoot = await realpath(options.webDirectory); let origin = '';
  const json = (res: ServerResponse, value: unknown, status = 200) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(value)); };
  const server = createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store'); res.setHeader('X-Content-Type-Options', 'nosniff'); res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'");
    try {
      if (req.headers.host !== new URL(origin).host) throw new HttpError('不允许的主机。', 403);
      if (req.headers.origin && req.headers.origin !== origin) throw new HttpError('不允许的来源。', 403);
      const url = new URL(req.url ?? '/', origin);
      if (url.pathname.startsWith('/api/')) {
        const provided = Buffer.from(typeof req.headers['x-jevclean-token'] === 'string' ? req.headers['x-jevclean-token'] : '');
        if (provided.length !== secret.length || !timingSafeEqual(secret, provided)) throw new HttpError('会话已失效，请重新打开 JevClean。', 401);
        const method = req.method;
        let value: unknown;
        if (method === 'GET') {
          if (url.pathname === '/api/bootstrap') value = { config: await service.publicConfig(), report: await service.loadReport(), canUndo: await service.canUndo(), cleanup: await service.cleanupSummary(), progress, preflight: await service.actionPreflight() };
          else if (url.pathname === '/api/status') value = progress;
          else if (url.pathname === '/api/runtime') {
            const config = await service.publicConfig();
            const busy = service.isBusy;
            value = { phase: busy ? progress.phase : 'idle', processed: busy ? progress.processed : 0, total: busy ? progress.total : 0, busy, language: config.settings.language ?? 'zh-CN' };
          }
          else if (url.pathname === '/api/logs') value = await options.logger.entries();
          else throw new HttpError('接口不存在。', 404);
        } else if (method === 'POST') {
          const data = await body(req);
          switch (url.pathname) {
            case '/api/config': {
              value = await service.saveConfig(parsed(saveInputSchema, data));
              options.logger.record('config.saved', { ruleCount: (value as Awaited<ReturnType<MailService['publicConfig']>>).settings.rules.filter(r => r.enabled).length }); break;
            }
            case '/api/analysis-settings': {
              value = await service.saveAnalysisSettings(parsed(analysisSettingsSchema, data));
              options.logger.record('config.saved', { ruleCount: (value as Awaited<ReturnType<MailService['publicConfig']>>).settings.rules.filter(r => r.enabled).length }); break;
            }
            case '/api/analysis-trace': {
              const input = parsed(z.object({ reportId: z.uuid(), id: z.string().min(1).max(100) }).strict(), data);
              value = await service.analysisTrace(input.reportId, input.id); break;
            }
            case '/api/clear-analysis-traces': parsed(z.object({}).strict(), data); value = await service.clearAnalysisTraces(); break;
            case '/api/retry-analysis': {
              const input = parsed(z.object({ reportId: z.uuid(), ids: z.array(z.string().min(1).max(100)).min(1).max(10000).refine(ids => new Set(ids).size === ids.length), consent: z.boolean() }).strict(), data);
              value = await service.retryAnalysis(input.reportId, input.ids, input.consent); break;
            }
            case '/api/test-mail': parsed(z.object({}).strict(), data); value = await service.testConnection(); options.logger.record('mail.connected'); break;
            case '/api/read-mail': parsed(z.object({}).strict(), data); value = await service.readMail(); options.logger.record('mail.read', { total: (value as Awaited<ReturnType<MailService['readMail']>>).records.length }); break;
            case '/api/action-folders': value = await service.saveActionFolders(parsed(settingsSchema.shape.actionFolders, data)); options.logger.record('config.saved'); break;
            case '/api/manual-check': value = await service.checkManual(parsed(manualInputSchema, data)); options.logger.record('actions.manual-checked'); break;
            case '/api/manual-execute': {
              const input = parsed(z.object({ planId: z.uuid() }).strict(), data); value = await service.executeManual(input.planId);
              const action = value as Awaited<ReturnType<MailService['executeManual']>>;
              options.logger.record('actions.manual-finished', { moved: action.moved, failed: action.failed, uncertain: action.uncertain }); break;
            }
            case '/api/check-actions': parsed(z.object({}).strict(), data); value = await service.checkActions(); options.logger.record('actions.preflight', { status: (value as Awaited<ReturnType<MailService['checkActions']>>).preflight.ready ? 'ready' : 'blocked' }); break;
            case '/api/test-jev': parsed(z.object({}).strict(), data); value = await service.testJev(); options.logger.record('jev.connected', { model: value as string }); break;
            case '/api/scan': {
              const input = parsed(z.object({ consent: z.literal(true) }).strict(), data); options.logger.record('scan.started');
              value = await service.scan(input.consent); const report = value as Awaited<ReturnType<MailService['scan']>>;
              options.logger.record('scan.finished', { processed: report.processed, total: report.total, apiCalls: report.apiCalls, inputTokens: report.inputTokens, outputTokens: report.outputTokens, model: report.model, status: report.status }); break;
            }
            case '/api/cancel': parsed(z.object({}).strict(), data); service.cancel(); value = null; break;
            case '/api/preview': value = await service.preview(parsed(z.object({ id: z.string().max(100) }).strict(), data).id); break;
            case '/api/resolve-conflict': {
              const input = parsed(z.object({ id: z.string().max(100), choiceId: z.string().max(64) }).strict(), data);
              value = await service.resolveConflict(input.id, input.choiceId); options.logger.record('actions.conflict-resolved'); break;
            }
            case '/api/execute': {
              options.logger.record('actions.requested');
              value = await service.move(parsed(z.object({ ids: z.array(z.string().max(100)).min(1).max(10000) }).strict(), data).ids);
              const action = value as Awaited<ReturnType<MailService['move']>>; options.logger.record('actions.finished', { moved: action.moved, failed: action.failed, uncertain: action.uncertain }); break;
            }
            case '/api/refresh-actions': {
              parsed(z.object({}).strict(), data); value = await service.refreshCleanup();
              const action = value as Awaited<ReturnType<MailService['refreshCleanup']>>;
              options.logger.record('actions.checked', { moved: action.moved, failed: action.failed, uncertain: action.uncertain }); break;
            }
            case '/api/undo': {
              parsed(z.object({}).strict(), data); value = await service.undo(); const action = value as Awaited<ReturnType<MailService['undo']>>;
              options.logger.record('undo.finished', { moved: action.moved, failed: action.failed, uncertain: action.uncertain }); break;
            }
            case '/api/forget': parsed(z.object({}).strict(), data); value = await service.forgetCredentials(); options.logger.record('credentials.forgotten'); break;
            case '/api/delete-reports': parsed(z.object({}).strict(), data); await service.deleteLocalReport(); progress = { phase: 'idle', total: 0, processed: 0 }; value = null; options.logger.record('reports.deleted'); break;
            case '/api/shutdown': parsed(z.object({}).strict(), data); service.ensureIdle(); json(res, { ok: true, value: null }); setTimeout(() => options.onShutdown?.(), 100); return;
            default: throw new HttpError('接口不存在。', 404);
          }
        } else throw new HttpError('不支持的请求方法。', 405);
        json(res, { ok: true, value }); return;
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError('不支持的请求方法。', 405);
      const path = decodeURIComponent(url.pathname); const candidate = resolve(webRoot, '.' + (path === '/' ? '/index.html' : path));
      if (!candidate.startsWith(webRoot + sep)) throw new HttpError('文件不存在。', 404);
      const file = await realpath(candidate).catch(() => null);
      if (!file || !file.startsWith(webRoot + sep) || !mime[extname(file)]) throw new HttpError('文件不存在。', 404);
      const content = await readFile(file); res.writeHead(200, { 'Content-Type': mime[extname(file)] }); res.end(req.method === 'HEAD' ? undefined : content);
    } catch (error) {
      const safe = error instanceof AppError || error instanceof JevError;
      json(res, { ok: false, error: safe ? error.message : '操作未完成，请检查本地服务、邮箱连接和系统凭据库。' }, error instanceof HttpError ? error.status : safe ? 400 : 500);
      options.logger.record(safe ? 'operation.rejected' : 'operation.failed');
    }
  });
  server.requestTimeout = 30000; server.headersTimeout = 10000;
  await new Promise<void>((accept, reject) => { server.once('error', reject); server.listen(options.port ?? 0, '127.0.0.1', () => { server.off('error', reject); accept(); }); });
  const address = server.address(); if (!address || typeof address === 'string') throw new AppError('无法启动本地服务。');
  origin = 'http://127.0.0.1:' + address.port;
  return { server, service, origin, token, url: origin + '/#session=' + token, close: async () => { service.cancel(); server.closeIdleConnections(); await new Promise<void>(accept => server.close(() => accept())); } };
}
