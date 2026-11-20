import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFile, writeFile, rename } from 'node:fs/promises';
import { TOOL, OPENAI_MODEL, CLAUDE_MODEL, GEMINI_MODEL, CACHE_KEY } from '../lab/fixture.mjs';

const origin = 'http://core:3001';
const token = 'sk-motaicandidatelabsynthetictoken';
const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'anthropic-version': '2023-06-01' };
const passed = [];
const fetchCore = (path, options = {}) => fetch(`${origin}${path}`, { ...options, redirect: 'error',
  signal: options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(15000)]) : AbortSignal.timeout(15000) });
const post = (path, body, signal) => fetchCore(path, { method: 'POST', headers, body: JSON.stringify(body), signal });
const state = async () => (await (await fetch('http://fixture:9000/__lab/state')).json()).requests;
const bodyFor = (protocol, stream, id) => {
  if (protocol === 'responses') return { model: OPENAI_MODEL, input: `LAB:${id}`, stream, reasoning: { effort: 'xhigh' },
    prompt_cache_key: CACHE_KEY, tools: [{ type: 'function', ...TOOL, strict: true }] };
  if (protocol === 'messages') return { model: CLAUDE_MODEL, stream, max_tokens: 2048,
    messages: [{ role: 'user', content: `LAB:${id}` }],
    tools: [{ name: TOOL.name, description: TOOL.description, input_schema: TOOL.parameters }] };
  return { model: OPENAI_MODEL, stream, messages: [{ role: 'user', content: `LAB:${id}` }],
    tools: [{ type: 'function', function: TOOL }], ...(stream ? { stream_options: { include_usage: true } } : {}) };
};
const pathFor = (protocol) => `/v1/${protocol === 'chat' ? 'chat/completions' : protocol}`;
const waitFor = async (predicate, timeout = 5000) => {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('Candidate lab condition timed out');
};
const internal = async (path, body) => {
  const response = await fetch(`http://core:3002/internal/v1${path}`, { method: body ? 'POST' : 'GET',
    headers: { authorization: 'Bearer synthetic-management-key-20261027', 'content-type': 'application/json' },
    body: body && JSON.stringify(body), signal: AbortSignal.timeout(15000) });
  assert.equal(response.status, 200, `management ${path}`);
  return response.json();
};
const idle = async () => waitFor(async () => {
  const status = await internal('/status');
  return status.in_flight === 0 && status.completion_pending === 0;
});
const finalMode = process.argv[2];
if (['final-ready', 'final-protocol', 'final-rejections', 'final-recovery', 'drain-hold', 'drain-release'].includes(finalMode)) {
  if (finalMode === 'final-ready') {
    await waitFor(async () => { try { return (await fetchCore('/healthz')).ok; } catch { return false; } }, 45000);
    passed.push('http-listener-ready');
  } else if (finalMode === 'final-protocol') {
    await idle();
    const serving = (await internal('/status')).serving_gen;
    const gen = String(BigInt(serving) + 1n);
    const config = JSON.parse(await readFile(`/config/gen-${serving}.config.json`, 'utf8'));
    const credentials = JSON.parse(await readFile(`/config/gen-${serving}.credentials.json`, 'utf8'));
    config.gen = credentials.gen = gen;
    config.models.push({ id: GEMINI_MODEL, vendor: 'google' });
    config.channels.push({ ...structuredClone(config.channels[0]), id: 'channel-gemini',
      name: 'Synthetic Gemini', models: [{ model_id: GEMINI_MODEL, upstream_model: GEMINI_MODEL, capabilities: ['gemini_generate_content'] }] });
    config.callers[0].permissions[0].model_ids.push(GEMINI_MODEL);
    config.callers[0].permissions[0].channel_ids.push('channel-gemini');
    config.callers[0].permissions[0].protocols.push('gemini_generate_content');
    for (const suffix of ['alpha', 'beta']) {
      const pool = `alias-${suffix}`, model = `canonical-${suffix}`, channel = `channel-${suffix}`;
      config.pools.push({ id: pool, name: `Synthetic ${suffix}` });
      config.models.push({ id: model, vendor: 'openai' });
      config.channels.push({ ...structuredClone(config.channels[0]), id: channel, name: `Synthetic alias ${suffix}`, pool_id: pool,
        models: [{ model_id: model, upstream_model: OPENAI_MODEL, capabilities: ['chat_completions'] }] });
      config.aliases.push({ alias: 'shared-lab-alias', model_id: model, pool_id: pool });
      config.callers[0].permissions.push({ pool_id: pool, model_ids: [model], channel_ids: [channel], protocols: ['chat_completions'], groups: [] });
    }
    const file = async (name, value) => {
      const text = `${JSON.stringify(value)}\n`;
      await writeFile(`/config/${name}`, text, { mode: 0o600 });
      return { file: name, sha256: createHash('sha256').update(text).digest('hex') };
    };
    const manifest = { format_version: 1, gen, base_gen: serving,
      config: await file(`gen-${gen}.config.json`, config), credentials: await file(`gen-${gen}.credentials.json`, credentials) };
    const reference = await file(`gen-${gen}.manifest.json`, manifest);
    await file('desired.final.json', { format_version: 1, gen, manifest: reference });
    await rename('/config/desired.final.json', '/config/desired.json');
    await internal('/activate', { format_version: 1, gen, base_committed_gen: serving, manifest_sha256: reference.sha256 });
    const verify = async (id, path, body, expected, extraHeaders = {}) => {
      const response = await fetchCore(path, { method: 'POST', headers: { ...headers, ...extraHeaders }, body: JSON.stringify(body) });
      const text = await response.text();
      assert.equal(response.status, 200, `${id}: ${text}`);
      const attempt = response.headers.get('x-motai-attempt-id');
      assert(attempt, `${id}: attempt header`);
      await idle();
      const rows = (await state()).filter(row => row.caseId === id);
      assert.equal(rows.length, 1, `${id}: single dispatch`);
      const mapped = structuredClone(body);
      if ('model' in mapped) mapped.model = expected.model_upstream;
      for (const [key, value] of Object.entries(mapped)) assert.deepEqual(rows[0].body[key], value, `${id}: body.${key}`);
      const event = (await internal('/events?after_seq=0&limit=1000')).events.find(row => row.attempt.intent.attempt_id === attempt);
      assert(event, `${id}: terminal committed`);
      assert.equal(event.attempt.terminal.attempt_outcome, 'succeeded', id);
      for (const [key, value] of Object.entries(expected)) assert.deepEqual(event.attempt.intent[key], value, `${id}: intent.${key}`);
      passed.push(id);
    };
    await verify('delta-chat-effort', '/v1/chat/completions', { model: OPENAI_MODEL, stream: false,
      messages: [{ role: 'user', content: 'LAB:delta-chat-effort' }], reasoning_effort: 'medium', tools: [{ type: 'function', function: TOOL }] },
    { model_upstream: OPENAI_MODEL, effort: { value: 'medium', source: 'request' }, thinking_budget: null, stream: false });
    await verify('delta-responses-effort', '/v1/responses', { model: OPENAI_MODEL, input: 'LAB:delta-responses-effort', stream: false,
      reasoning: { effort: 'low' }, prompt_cache_key: CACHE_KEY, tools: [{ type: 'function', ...TOOL, strict: true }] },
    { model_upstream: OPENAI_MODEL, effort: { value: 'low', source: 'request' }, thinking_budget: null, stream: false });
    await verify('delta-messages-effort', '/v1/messages', { model: CLAUDE_MODEL, stream: false, max_tokens: 4096,
      messages: [{ role: 'user', content: 'LAB:delta-messages-effort' }], output_config: { effort: 'high' },
      thinking: { type: 'enabled', budget_tokens: 2048 }, tools: [{ name: TOOL.name, description: TOOL.description, input_schema: TOOL.parameters }] },
    { model_upstream: CLAUDE_MODEL, effort: { value: 'high', source: 'request' }, thinking_budget: 2048, stream: false });
    for (const [id, action, query, budget] of [
      ['delta-gemini-auto', 'generateContent', '', -1],
      ['delta-gemini-stream', 'streamGenerateContent', '', 0],
      ['delta-gemini-alt', 'generateContent', '?alt=sse', 1024],
    ]) {
      await verify(id, `/v1beta/models/${GEMINI_MODEL}:${action}${query}`, {
        contents: [{ role: 'user', parts: [{ text: `LAB:${id}` }] }],
        generationConfig: { temperature: 0.25, thinkingConfig: { thinkingBudget: budget, thinkingLevel: 'HIGH' } },
      }, { model_upstream: GEMINI_MODEL, effort: { value: 'HIGH', source: 'request' }, thinking_budget: budget,
        stream: action === 'streamGenerateContent' || query !== '' });
    }
    for (const suffix of ['alpha', 'beta']) await verify(`delta-alias-${suffix}`, '/v1/chat/completions', {
      model: 'shared-lab-alias', stream: false, messages: [{ role: 'user', content: `LAB:delta-alias-${suffix}` }], reasoning_effort: 'low',
    }, { pool_id: `alias-${suffix}`, model_requested: 'shared-lab-alias', model_canonical: `canonical-${suffix}`,
      model_upstream: OPENAI_MODEL, stream: false }, { 'x-motai-pool': `alias-${suffix}` });
  } else if (finalMode === 'final-rejections') {
    await idle();
    const before = await internal('/status'), dispatches = (await state()).length;
    for (const action of ['countTokens', 'embedContent', 'unknownAction']) {
      const response = await post(`/v1beta/models/${GEMINI_MODEL}:${action}`, { contents: [{ role: 'user', parts: [{ text: 'LAB:rejected-action' }] }] });
      assert.equal(response.status, 400, action);
      assert.equal((await response.json()).error.code, 'invalid_contract');
      assert.equal(response.headers.get('x-motai-attempt-id'), null);
      passed.push(`reject-${action}`);
    }
    const message = { model: CLAUDE_MODEL, max_tokens: 1024, messages: [{ role: 'user', content: 'LAB:invalid-metadata' }] };
    const chat = { model: OPENAI_MODEL, messages: [{ role: 'user', content: 'LAB:invalid-metadata' }] };
    for (const [id, path, body] of [
      ['gemini-negative-budget', `/v1beta/models/${GEMINI_MODEL}:generateContent`, { contents: [{ parts: [{ text: 'LAB:invalid-metadata' }] }], generationConfig: { thinkingConfig: { thinkingBudget: -2 } } }],
      ['messages-negative-budget', '/v1/messages', { ...message, thinking: { type: 'enabled', budget_tokens: -5 } }],
      ['non-gemini-auto-budget', '/v1/messages', { ...message, thinking: { type: 'enabled', budget_tokens: -1 } }],
      ['effort-too-long', '/v1/chat/completions', { ...chat, reasoning_effort: 'a'.repeat(65) }],
      ['effort-invalid-character', '/v1/chat/completions', { ...chat, reasoning_effort: 'high!' }],
      ['effort-empty', '/v1/chat/completions', { ...chat, reasoning_effort: '' }],
      ['budget-over-safe-integer', '/v1/messages', { ...message, thinking: { type: 'enabled', budget_tokens: 9007199254740992 } }],
    ]) {
      const response = await post(path, body);
      assert.equal(response.status, 400, id);
      assert.equal((await response.json()).error.code, 'invalid_contract', id);
      assert.equal(response.headers.get('retry-after'), null, id);
      assert.equal(response.headers.get('x-motai-attempt-id'), null, id);
      passed.push(id);
    }
    const ambiguous = await post('/v1/chat/completions', { model: 'shared-lab-alias', messages: [{ role: 'user', content: 'LAB:ambiguous-alias' }] });
    assert.equal(ambiguous.status, 403);
    await ambiguous.text();
    assert.equal(ambiguous.headers.get('x-motai-attempt-id'), null);
    await idle();
    assert.equal((await state()).length, dispatches, 'rejections dispatch nothing');
    assert.equal((await internal('/status')).latest_seq, before.latest_seq, 'rejections append no terminal');
    passed.push('ambiguous-alias-zero-dispatch');
  } else if (finalMode === 'final-recovery') {
    const response = await post('/v1/chat/completions', { model: OPENAI_MODEL, messages: [{ role: 'user', content: 'LAB:chat-after-metadata-rejections' }] });
    assert.equal(response.status, 200);
    await response.text();
    await idle();
    assert.equal((await state()).filter(row => row.caseId === 'chat-after-metadata-rejections').length, 1);
    passed.push('valid-request-after-invalid-metadata');
  } else if (finalMode === 'drain-hold') {
    const response = post('/v1/chat/completions', { model: OPENAI_MODEL, messages: [{ role: 'user', content: 'LAB:chat-drain-held' }] });
    await waitFor(async () => (await state()).some(row => row.caseId === 'chat-drain-held' && !row.finished && !row.closed));
    await writeFile('/config/final-drain-ready.json', JSON.stringify({ ready: true }), { mode: 0o600 });
    const completed = await response;
    assert.equal(completed.status, 200);
    assert((await completed.text()).includes('Synthetic drain completed.'));
    passed.push('sigterm-held-request-completes');
  } else {
    await waitFor(async () => {
      const response = await fetchCore('/healthz');
      return response.status === 503 && (await response.json()).draining === true;
    });
    const before = (await state()).length;
    const response = await post('/v1/chat/completions', { model: OPENAI_MODEL, messages: [{ role: 'user', content: 'LAB:chat-during-drain' }] });
    assert.equal(response.status, 503);
    assert.equal((await response.json()).error.code, 'gateway_draining');
    assert.equal(response.headers.get('retry-after'), '1');
    assert.equal(response.headers.get('x-motai-attempt-id'), null);
    assert.equal((await state()).length, before);
    assert((await internal('/status')).degraded_reasons.includes('draining'));
    assert.equal((await fetch('http://fixture:9000/__lab/release?case=chat-drain-held', { method: 'POST' })).status, 200);
    passed.push('sigterm-health-503-draining-retry-after-zero-dispatch');
  }
  console.log(JSON.stringify({ mode: finalMode, passed, count: passed.length, synthetic: true, productionTouched: false }, null, 2));
  process.exit(0);
}
await waitFor(async () => { try { return (await fetchCore('/healthz')).ok; } catch { return false; } }, 45000);
assert.equal((await fetch('http://fixture:9000/__lab/reset', { method: 'POST' })).status, 200);
assert.equal((await fetchCore('/api/channel/')).status, 404);
assert.equal((await fetchCore('/')).status, 404);
const anonymous = await fetchCore('/v1/responses', { method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify(bodyFor('responses', false, 'anonymous')) });
assert.equal(anonymous.status, 401);
passed.push('headless-management-absent', 'headless-ui-absent', 'anonymous-denied');
for (const protocol of ['responses', 'chat', 'messages']) {
  for (const stream of [false, true]) {
    const id = `${protocol}-${stream ? 'stream' : 'json'}`;
    const body = bodyFor(protocol, stream, id);
    const response = await post(pathFor(protocol), body);
    assert.equal(response.status, 200, id);
    const text = await response.text();
    assert(text.includes(protocol === 'responses' ? 'call_lab' : protocol === 'messages' ? 'toolu_lab' : 'call_lab'), `${id}: tool ID`);
    assert(text.includes(protocol === 'messages' ? 'input_tokens' : protocol === 'chat' ? 'prompt_tokens' : 'input_tokens'), `${id}: usage`);
    const rows = (await state()).filter((row) => row.caseId === id);
    assert.equal(rows.length, 1, `${id}: exactly one dispatch`);
    assert.deepEqual(rows[0].tools, body.tools);
    if (protocol === 'responses') {
      assert.equal(rows[0].prompt_cache_key, CACHE_KEY);
      assert.deepEqual(rows[0].reasoning, body.reasoning);
    }
    passed.push(`${id}-tool-usage-single-dispatch`);
  }
}
const unknown = bodyFor('chat', false, 'chat-unknown-price');
unknown.model = 'motai-unknown-priced-model';
const unknownResponse = await post('/v1/chat/completions', unknown);
assert.equal(unknownResponse.status, 200);
await unknownResponse.text();
assert.equal((await state()).filter((row) => row.caseId === 'chat-unknown-price').length, 1);
passed.push('unknown-price-zero-user-quota-forwarded');
const partialResponse = await post('/v1/responses', bodyFor('responses', true, 'responses-disconnect'));
await partialResponse.text().catch(() => '');
await new Promise((resolve) => setTimeout(resolve, 1000));
assert.equal((await state()).filter((row) => row.caseId === 'responses-disconnect').length, 1);
passed.push('partial-stream-single-dispatch');
const abort = new AbortController();
const cancelResponse = await post('/v1/responses', bodyFor('responses', true, 'responses-cancel'), abort.signal);
const reader = cancelResponse.body.getReader();
await reader.read();
abort.abort();
await reader.cancel().catch(() => {});
await waitFor(async () => (await state()).some((row) => row.caseId === 'responses-cancel' && row.closed));
assert.equal((await state()).filter((row) => row.caseId === 'responses-cancel').length, 1);
passed.push('cancel-closes-upstream-single-dispatch');
const count = await post('/v1/messages/count_tokens', { model: CLAUDE_MODEL, messages: [{ role: 'user', content: 'synthetic count' }] });
assert.equal(count.status, 200);
assert(Number.isSafeInteger((await count.json()).input_tokens));
passed.push('count-tokens-local');
console.log(JSON.stringify({ passed, count: passed.length, synthetic: true,
  billingMutatorProbe: process.env.MOTAI_MUTATOR_PROBE === '1' ? 'panic-on-entry' : 'not-enabled', productionTouched: false }, null, 2));
