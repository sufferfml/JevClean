import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { LogEntry } from '../shared/contracts';
import { operationDiagnosticReasons } from '../shared/contracts';

const allowed = new Set(['processed', 'total', 'moved', 'failed', 'uncertain', 'apiCalls', 'inputTokens', 'outputTokens', 'model', 'status', 'ruleCount', 'durationMs', 'reasonCode', 'restored']);
/** Only application-authored event names and allowlisted aggregate fields enter the local log. */
export class LocalLogger {
  private queue: Promise<void> = Promise.resolve();
  constructor(private directory: string, private limit = 512 * 1024) {}
  record(event: string, details: LogEntry['details'] = {}) {
    const entry: LogEntry = { time: new Date().toISOString(), event, details: Object.fromEntries(Object.entries(details).filter(([key, value]) => allowed.has(key) && (key !== 'durationMs' || typeof value === 'number' && Number.isFinite(value) && value >= 0) && (key !== 'reasonCode' || operationDiagnosticReasons.some(reason => reason === value)))) };
    this.queue = this.queue.then(async () => {
      await mkdir(this.directory, { recursive: true, mode: 0o700 }); const file = join(this.directory, 'operations.log');
      if ((await stat(file).catch(() => null))?.size! >= this.limit) await rename(file, file + '.1');
      await writeFile(file, JSON.stringify(entry) + '\n', { flag: 'a', mode: 0o600 });
    }).catch(() => {}); // Logging must never change a mailbox operation's outcome.
  }
  async entries(): Promise<LogEntry[]> {
    await this.queue;
    const data = await readFile(join(this.directory, 'operations.log'), 'utf8').catch(() => '');
    return data.split('\n').filter(Boolean).slice(-100).map(line => JSON.parse(line) as LogEntry);
  }
}
