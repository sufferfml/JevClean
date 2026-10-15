import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';

test('quality runner caps request attempts and never retries provider failures', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'jevclean-quality-budget-'));
  const preload = join(directory, 'transport.mjs');
  const counter = join(directory, 'calls.txt');
  await writeFile(preload, `import { appendFileSync } from 'node:fs';
globalThis.fetch = async (_url, init) => {
  appendFileSync(process.env.TEST_CALL_COUNTER, 'attempt\n');
  if (process.env.TEST_PROVIDER_FAILURE === 'yes') return new Response(null, { status: 503 });
  const request = JSON.parse(init.body);
  const answers = Object.fromEntries(Object.entries(request.questions).map(([id, q]) => {
    const options = Object.keys(q.criteria); const choice = options[0];
    return [id, { type: 'choice', choice, confidence: 1, probabilities: Object.fromEntries(options.map(option => [option, Number(option === choice)])) }];
  }));
  return new Response(JSON.stringify({ model: request.model, answers, usage: { input_tokens: 1, output_tokens: 1 } }));
};`.replace("'attempt\n'", "'attempt\\n'"));
  try {
    for (const failure of ['no', 'yes']) {
      await writeFile(counter, '');
      const result = spawnSync(process.execPath, ['--import', 'tsx', '--import', preload, 'scripts/check-quality.ts'], {
        cwd: process.cwd(), encoding: 'utf8', timeout: 10000,
        env: { ...process.env, JEVCLEAN_JEV_KEY: 'synthetic-test-key', JEVCLEAN_MAX_CALLS: failure === 'yes' ? '100' : '1', TEST_CALL_COUNTER: counter, TEST_PROVIDER_FAILURE: failure },
      });
      assert.equal(result.status, 1, 'an incomplete or failed check cannot pass');
      assert.equal((await readFile(counter, 'utf8')).trim(), 'attempt');
      const summary = JSON.parse(result.stdout.trim().split('\n').at(-1)!);
      assert.equal(summary.requests, 1);
      assert.equal(summary.failed, failure === 'yes' ? 1 : 0);
      assert.ok(summary.processed < summary.cases);
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});
