import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createEvaluator, JevError, MAX_JEV_RESPONSE_BYTES, type JevRequest } from '../src/core/jev';
import type { JevAttempt } from '../src/shared/contracts';
const request: JevRequest = { model: 'jev-1.13.0', state: 'Synthetic test.', questions: { rule: { type: 'choice', instructions: 'Is it a test?', criteria: { yes: 'It is a test', no: 'It is not' } } } };
const valid = { model: 'jev-1.13.0', answers: { rule: { type: 'choice', choice: 'yes', confidence: 0.99, probabilities: { yes: 0.99, no: 0.01 } } }, usage: { input_tokens: 10, output_tokens: 5 } };
test('direct API uses only fixed HTTPS vendor endpoint and rejects redirects', async () => {
  const evaluate = createEvaluator('test-only-secret', async (url, init) => {
    assert.equal(url, 'https://api.typesafe.ai/v1/systemone'); assert.equal(init?.redirect, 'error');
    assert.equal((init?.headers as Record<string, string>).Authorization, 'Bearer test-only-secret'); assert.ok(!(init?.body as string).includes('test-only-secret'));
    return Response.json(valid);
  }); assert.equal((await evaluate(request)).model, 'jev-1.13.0');
});
test('authentication failure stops a batch without echoing vendor response or key', async () => {
  const evaluate = createEvaluator('private-key', async () => new Response('private-key submitted mail text', { status: 401 }));
  await assert.rejects(evaluate(request), error => { assert.ok(error instanceof JevError); assert.equal(error.fatal, true); assert.ok(!error.message.includes('private-key')); return true; });
});
test('malformed, incomplete, out-of-set, non-normalized and inconsistent answers fail closed', async () => {
  for (const invalid of [{ answers: {} }, { ...valid, answers: {} }, ...[
    { choice: 'delete_everything', confidence: 1, probabilities: { delete_everything: 1 } },
    { choice: 'yes', confidence: 1, probabilities: { yes: 1 } },
    { choice: 'yes', confidence: 1, probabilities: { yes: 0.1, no: 0.9 } },
    { choice: 'yes', confidence: 1, probabilities: { yes: 0.9, no: 0.9 } },
  ].map(answer => ({ ...valid, answers: { rule: { type: 'choice', ...answer } } }))]) {
    await assert.rejects(createEvaluator('fake', async () => Response.json(invalid))(request), JevError);
  }
});
test('cancelled operation performs no network request', async () => {
  let calls = 0; const controller = new AbortController(); controller.abort();
  await assert.rejects(createEvaluator('fake', async () => { calls++; throw new Error('unexpected'); })(request, controller.signal)); assert.equal(calls, 0);
});
test('each request is observed before dispatch and preserves actual received text and usage', async () => {
  const attempts: JevAttempt[] = [];
  const raw = JSON.stringify(valid, null, 2) + '\n';
  const evaluate = createEvaluator('not-a-real-key', async () => {
    assert.equal(attempts.length, 1); assert.equal(attempts[0].status, 'sending');
    return new Response(raw, { status: 200 });
  }, async attempt => { attempts.push(attempt); });
  await evaluate(request);
  assert.equal(attempts.length, 2);
  assert.equal(attempts[1].attempt, 1); assert.equal(attempts[1].status, 'succeeded');
  assert.equal(attempts[1].responseText, raw); assert.deepEqual(attempts[1].usage, valid.usage);
  assert.equal(attempts[1].httpStatus, 200); assert.ok(attempts[1].completedAt); assert.ok(attempts[1].durationMs! >= 0);
  assert.equal(attempts[0].responseText, undefined);
  assert.ok(!JSON.stringify(attempts).includes('not-a-real-key'));
});
test('invalid responses retain their text without turning vendor key echoes into logs or public errors', async () => {
  const attempts: JevAttempt[] = [];
  const raw = 'unreadable reply with secret-test-key and private mail';
  await assert.rejects(createEvaluator('secret-test-key', async () => new Response(raw), async attempt => { attempts.push(attempt); })(request),
    error => error instanceof JevError && error.code === 'invalid_response' && !error.message.includes('private mail'));
  assert.equal(attempts[1].status, 'failed'); assert.equal(attempts[1].errorCode, 'invalid_response');
  assert.equal(attempts[1].responseText, 'unreadable reply with [API key removed] and private mail');
  assert.equal(attempts[1].credentialsRedacted, true);
  assert.ok(!JSON.stringify(attempts).includes('secret-test-key'));
  assert.equal(attempts[1].usage, undefined);
});
test('credential echoes in valid or escaped JSON cannot leak into accepted model results', async () => {
  const key = 'secret-test-key';
  for (const raw of [JSON.stringify({ ...valid, model: key }), JSON.stringify({ ...valid, model: key }).replace('secret-test-key', 'secret-\\u0074est-key')]) {
    const attempts: JevAttempt[] = [];
    await assert.rejects(createEvaluator(key, async () => new Response(raw), async attempt => { attempts.push(attempt); })(request),
      error => error instanceof JevError && error.code === 'invalid_response');
    assert.equal(attempts[1].credentialsRedacted, true); assert.equal(attempts[1].status, 'failed');
    assert.ok(!JSON.stringify(attempts).includes(key));
    assert.equal(JSON.parse(attempts[1].responseText!).model, '[API key removed]');
  }
});
test('HTTP retries preserve separate attempts and unknown usage stays missing', async () => {
  let calls = 0; const attempts: JevAttempt[] = [];
  await createEvaluator('fake', async () => ++calls === 1 ? new Response('temporarily unavailable', { status: 503 }) : Response.json(valid),
    async attempt => { attempts.push(attempt); })(request);
  assert.equal(calls, 2);
  assert.deepEqual(attempts.map(item => [item.attempt, item.status]), [[1, 'sending'], [1, 'failed'], [2, 'sending'], [2, 'succeeded']]);
  assert.equal(attempts[1].httpStatus, 503); assert.equal(attempts[1].usage, undefined);
  assert.equal(attempts[1].errorCode, 'http'); assert.deepEqual(attempts[3].usage, valid.usage);
});
test('record persistence failure stops before sending or before retrying and never echoes storage errors', async () => {
  for (const failAt of ['sending', 'failed']) {
    let calls = 0;
    await assert.rejects(createEvaluator('fake', async () => { calls++; return new Response('busy', { status: 503 }); }, async attempt => {
      if (attempt.status === failAt) throw new Error('private storage detail');
    })(request), error => error instanceof JevError && error.fatal && error.code === 'diagnostics_write_failed' && !error.message.includes('private storage detail'));
    assert.equal(calls, failAt === 'sending' ? 0 : 1);
  }
});
test('network failures, timeout and in-flight cancellation have distinct safe recorded states', async () => {
  for (const kind of ['network', 'timeout', 'cancelled']) {
    const attempts: JevAttempt[] = []; const controller = new AbortController();
    await assert.rejects(createEvaluator('private-test-key', async () => {
      if (kind === 'cancelled') controller.abort();
      if (kind === 'timeout') throw new DOMException('private-test-key', 'TimeoutError');
      throw new Error('private-test-key');
    }, async attempt => { attempts.push(attempt); })(request, controller.signal));
    assert.equal(attempts.length, 2); assert.equal(attempts[1].errorCode, kind);
    assert.equal(attempts[1].status, kind === 'cancelled' ? 'cancelled' : 'failed');
    assert.equal(attempts[1].usage, undefined); assert.ok(!JSON.stringify(attempts).includes('private-test-key'));
  }
});
test('a complete response received while stopping keeps its evidence and does not issue another request', async () => {
  const attempts: JevAttempt[] = []; const controller = new AbortController(); let calls = 0;
  const result = await createEvaluator('fake-key', async () => {
    calls++; controller.abort(); return Response.json(valid);
  }, async attempt => { attempts.push(attempt); })(request, controller.signal);
  assert.equal(result.model, valid.model); assert.equal(calls, 1);
  assert.equal(attempts[1].status, 'succeeded'); assert.deepEqual(attempts[1].usage, valid.usage);
});
test('oversized responses are marked incomplete and never become valid judgments', async () => {
  const attempts: JevAttempt[] = [];
  await assert.rejects(createEvaluator('fake-key', async () => new Response('x'.repeat(MAX_JEV_RESPONSE_BYTES + 1)), async attempt => { attempts.push(attempt); })(request),
    error => error instanceof JevError && error.code === 'invalid_response');
  assert.equal(attempts[1].responseTruncated, true);
  assert.equal(Buffer.byteLength(attempts[1].responseText!), MAX_JEV_RESPONSE_BYTES);
  assert.equal(attempts[1].status, 'failed');
});
