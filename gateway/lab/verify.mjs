import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { NewApiClient } from '../../src/new-api-client.js';
import { OPENAI_MODEL, CLAUDE_MODEL, TOOL, SIGNATURE, CACHE_KEY, BACKUP_UPSTREAM_KEY } from './fixture.mjs';

const FIXTURE = 'http://fixture:9000';
const USERNAME = 'motailab';
const PASSWORD = 'synthetic-motai-lab-password';

export function assertLabUrl(value = 'http://core:3001') {
  const url = new URL(value);
  assert.equal(url.origin, 'http://core:3001', 'Only the internal lab core is allowed');
  assert(!url.username && !url.password && url.pathname === '/' && !url.search && !url.hash, 'Expected a bare lab origin');
  return url.origin;
}

export function labFetch(baseUrl, fetchImpl = fetch) {
  const origin = assertLabUrl(baseUrl);
  return (value, options = {}) => {
    assert.equal(new URL(value).origin, origin, 'Cross-origin lab request rejected');
    const deadline = AbortSignal.timeout(15000);
    return fetchImpl(value, { ...options, redirect: 'error', signal: options.signal ? AbortSignal.any([options.signal, deadline]) : deadline });
  };
}

function requestBody(protocol, stream, caseId) {
  if (protocol === 'responses') return { model: OPENAI_MODEL, stream, input: `LAB:${caseId}`,
    reasoning: { effort: 'medium' }, prompt_cache_key: CACHE_KEY,
    tools: [{ type: 'function', ...TOOL, strict: true }], tool_choice: 'auto' };
  if (protocol === 'messages') return { model: CLAUDE_MODEL, stream, max_tokens: 2048,
    thinking: { type: 'enabled', budget_tokens: 1024 },
    messages: [{ role: 'user', content: [{ type: 'text', text: `LAB:${caseId}`, cache_control: { type: 'ephemeral' } }] }],
    tools: [{ name: TOOL.name, description: TOOL.description, input_schema: TOOL.parameters }], tool_choice: { type: 'auto' } };
  return { model: OPENAI_MODEL, stream, messages: [{ role: 'user', content: `LAB:${caseId}` }],
    tools: [{ type: 'function', function: TOOL }], tool_choice: 'auto', ...(stream ? { stream_options: { include_usage: true } } : {}) };
}

function sse(text) {
  return text.split(/\r?\n\r?\n/).flatMap((block) => block.split(/\r?\n/)
    .filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trim()))
    .filter((data) => data && data !== '[DONE]').map((data) => JSON.parse(data));
}

async function fixtureState() {
  const response = await fetch(`${FIXTURE}/__lab/state`, { redirect: 'error', signal: AbortSignal.timeout(3000) });
  assert.equal(response.status, 200);
  return (await response.json()).requests;
}

async function waitFor(predicate, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  throw new Error('Lab condition timed out');
}

const items = (data) => Array.isArray(data) ? data : data?.items ?? [];

export async function bootstrap(client) {
  const setup = await client.request('/api/setup', { auth: false });
  if (!setup.status) await client.request('/api/setup', { auth: false, method: 'POST', body: {
    username: USERNAME, password: PASSWORD, confirmPassword: PASSWORD, SelfUseModeEnabled: true, DemoSiteEnabled: false,
  } });
  await client.login();
  let channels = items(await client.channels());
  assert(channels.every((row) => ['motai-lab-openai', 'motai-lab-claude', 'motai-lab-fallback'].includes(row.name)
    && row.base_url === FIXTURE), 'Refusing a core containing non-lab channels');
  const expectedChannels = [{ name: 'motai-lab-openai', type: 1, models: OPENAI_MODEL },
    { name: 'motai-lab-claude', type: 14, models: CLAUDE_MODEL }];
  for (const channel of expectedChannels) {
    if (!channels.some((row) => row.name === channel.name)) await client.createChannel({ ...channel,
      key: 'synthetic-upstream-key', base_url: FIXTURE, group: 'default', status: 1, priority: 10, weight: 10, auto_ban: 0 });
  }
  channels = items(await client.channels());
  for (const expected of expectedChannels) {
    const channel = channels.find((row) => row.name === expected.name);
    assert(channel?.id && channel.type === expected.type && channel.base_url === FIXTURE && channel.status === 1,
      `Lab channel missing or incorrectly configured: ${expected.name}`);
    // New API's create path only writes DB; its update path synchronously rebuilds the routing cache.
    await client.updateChannelRouting(channel.id, 10, 10, expected.models, expected.models, 'default');
  }
  let tokens = items(await client.request('/api/token/?p=0&page_size=100'));
  if (!tokens.some((row) => row.name === 'motai-lab-client')) {
    await client.request('/api/token/', { method: 'POST', body: { name: 'motai-lab-client',
      expired_time: -1, unlimited_quota: true, model_limits_enabled: false, group: 'default' } });
    tokens = items(await client.request('/api/token/?p=0&page_size=100'));
  }
  const token = tokens.find((row) => row.name === 'motai-lab-client');
  assert(token?.id, 'Created lab token not returned by list');
  const result = await client.request(`/api/token/${token.id}/key`, { method: 'POST' });
  assert(result.key, 'Dedicated token key route did not return a key');
  return result.key.startsWith('sk-') ? result.key : `sk-${result.key}`;
}

async function assertDenied(fetchCore, url, options = {}) {
  const response = await fetchCore(url, options);
  const payload = await response.json().catch(() => ({}));
  assert(response.status >= 400 || payload.success === false, 'Anonymous request unexpectedly accepted');
}

export async function verify(baseUrl = 'http://core:3001') {
  const origin = assertLabUrl(baseUrl);
  const fetchCore = labFetch(origin);
  const client = new NewApiClient({ baseUrl: origin, username: USERNAME, password: PASSWORD, fetchImpl: fetchCore });
  await waitFor(async () => {
    try { return (await fetchCore(`${origin}/api/status`, { signal: AbortSignal.timeout(2000) })).ok; }
    catch { return false; }
  }, 45000);
  const token = await bootstrap(client);
  const passed = [];
  await assertDenied(fetchCore, `${origin}/api/channel/`);
  await assertDenied(fetchCore, `${origin}/v1/responses`, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify(requestBody('responses', false, 'anonymous')) });
  passed.push('anonymous-management-denied', 'anonymous-model-denied');
  const reset = await fetch(`${FIXTURE}/__lab/reset`, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(3000) });
  assert.equal(reset.status, 200);
  const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'anthropic-version': '2023-06-01' };
  const post = (protocol, body, signal) => fetchCore(`${origin}/v1/${protocol === 'chat' ? 'chat/completions' : protocol}`,
    { method: 'POST', headers, body: JSON.stringify(body), ...(signal ? { signal } : {}) });
  for (const protocol of ['responses', 'chat', 'messages']) {
    for (const stream of [false, true]) {
      const caseId = `${protocol}-${stream ? 'stream' : 'json'}`;
      const body = requestBody(protocol, stream, caseId);
      const response = await post(protocol, body);
      assert.equal(response.status, 200, `${caseId}: HTTP status`);
      const text = await response.text();
      const output = stream ? sse(text) : JSON.parse(text);
      const rows = (await fixtureState()).filter((row) => row.caseId === caseId);
      assert.equal(rows.length, 1, `${caseId}: exactly one upstream attempt`);
      assert.equal(rows[0].stream, stream);
      assert.deepEqual(rows[0].tools, body.tools, `${caseId}: tool schema changed`);
      if (protocol === 'responses') {
        assert.deepEqual(rows[0].reasoning, body.reasoning);
        assert.equal(rows[0].prompt_cache_key, CACHE_KEY);
        const complete = stream ? output.find((row) => row.type === 'response.completed')?.response : output;
        assert.equal(complete?.status, 'completed');
        assert.equal(complete?.output[0]?.call_id, 'call_lab');
        assert.equal(complete?.output[0]?.arguments, '{"city":"Paris"}');
        assert.equal(complete?.usage?.input_tokens, 10);
        assert.equal(complete?.usage?.output_tokens, 5);
        assert.equal(complete?.usage?.input_tokens_details?.cached_tokens, 4);
      } else if (protocol === 'messages') {
        assert.deepEqual(rows[0].thinking, body.thinking);
        assert.deepEqual(rows[0].messages[0].content[0].cache_control, { type: 'ephemeral' });
        if (stream) {
          assert(output.some((row) => row.type === 'message_stop'));
          assert.equal(output.find((row) => row.delta?.signature)?.delta.signature, SIGNATURE);
          assert.equal(output.find((row) => row.content_block?.type === 'tool_use')?.content_block.id, 'toolu_lab');
          assert.equal(output.find((row) => row.delta?.partial_json)?.delta.partial_json, '{"city":"Paris"}');
          assert.equal(output.find((row) => row.type === 'message_start')?.message.usage.cache_read_input_tokens, 4);
          assert.equal(output.find((row) => row.type === 'message_delta')?.usage.output_tokens, 5);
        } else {
          assert.equal(output.content[0].signature, SIGNATURE);
          assert.deepEqual(output.content[1].input, { city: 'Paris' });
          assert.equal(output.stop_reason, 'tool_use');
          assert.equal(output.usage.cache_creation_input_tokens, 2);
          assert.equal(output.usage.output_tokens, 5);
        }
      } else if (stream) {
        const calls = output.flatMap((row) => row.choices ?? []).flatMap((row) => row.delta?.tool_calls ?? []);
        assert.equal(calls[0]?.id, 'call_lab');
        assert.equal(calls.map((row) => row.function?.arguments ?? '').join(''), '{"city":"Paris"}');
        assert.equal(output.find((row) => row.usage)?.usage.total_tokens, 15);
        assert(text.includes('data: [DONE]'));
      } else {
        assert.equal(output.choices[0].message.tool_calls[0].id, 'call_lab');
        assert.equal(output.choices[0].message.tool_calls[0].function.arguments, '{"city":"Paris"}');
        assert.equal(output.usage.total_tokens, 15);
      }
      passed.push(caseId);
    }
  }
  const broken = await post('responses', requestBody('responses', true, 'responses-disconnect'));
  assert.equal(broken.status, 200);
  let partial = '';
  try {
    const reader = broken.body.getReader();
    const decoder = new TextDecoder();
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      partial += decoder.decode(value, { stream: true });
    }
  } catch { /* A socket termination is an expected outcome of this fixture. */ }
  assert(partial.includes('response.function_call_arguments.delta'), 'Disconnect fixture produced no partial output');
  assert(!partial.includes('response.completed'), 'Broken stream marked complete');
  await new Promise((resolveWait) => setTimeout(resolveWait, 1000));
  assert.equal((await fixtureState()).filter((row) => row.caseId === 'responses-disconnect').length, 1, 'Broken stream replayed');
  passed.push('partial-stream-no-replay');
  const controller = new AbortController();
  const cancelled = await post('responses', requestBody('responses', true, 'responses-cancel'), controller.signal);
  assert.equal(cancelled.status, 200);
  const reader = cancelled.body.getReader();
  const first = await reader.read();
  assert(!first.done && first.value.length > 0, 'Cancel fixture produced no output');
  controller.abort();
  await reader.cancel().catch(() => {});
  await waitFor(async () => (await fixtureState()).some((row) => row.caseId === 'responses-cancel' && row.closed && !row.finished));
  assert.equal((await fixtureState()).filter((row) => row.caseId === 'responses-cancel').length, 1, 'Cancelled stream replayed');
  passed.push('client-cancel-closes-upstream');
  return { passed, limitations: ['Synthetic protocol fragments; no real client or executed tool round trip.',
    'Does not prove production source/image correspondence, routing migration, or failed-stream log classification.'] };
}

export async function verifyTimeoutRouting(baseUrl = 'http://core:3001', expectCooldown = false, genericFailures = false) {
  const origin = assertLabUrl(baseUrl);
  const fetchCore = labFetch(origin);
  const client = new NewApiClient({ baseUrl: origin, username: USERNAME, password: PASSWORD, fetchImpl: fetchCore });
  await waitFor(async () => {
    try { return (await fetchCore(`${origin}/api/status`, { signal: AbortSignal.timeout(2000) })).ok; }
    catch { return false; }
  }, 45000);
  const token = await bootstrap(client);
  let channels = items(await client.channels());
  if (!channels.some((row) => row.name === 'motai-lab-fallback')) {
    await client.createChannel({ name: 'motai-lab-fallback', type: 1, models: OPENAI_MODEL,
      key: BACKUP_UPSTREAM_KEY, base_url: FIXTURE, group: 'default', status: 1, priority: 10, weight: 10, auto_ban: 0 });
  }
  channels = items(await client.channels());
  const primary = channels.find((row) => row.name === 'motai-lab-openai');
  const backup = channels.find((row) => row.name === 'motai-lab-fallback');
  assert(backup?.id && backup.type === 1 && backup.base_url === FIXTURE && backup.status === 1, 'Unexpected lab fallback');
  await client.updateChannelRouting(primary.id, 10, 20, OPENAI_MODEL, OPENAI_MODEL, 'default');
  await client.updateChannelRouting(backup.id, 10, 10, OPENAI_MODEL, OPENAI_MODEL, 'default');
  await client.request('/api/option/', { method: 'PUT', body: { key: 'RetryTimes', value: '2' } });
  await client.request('/api/option/', { method: 'PUT', body: { key: 'channel_affinity_setting.enabled', value: 'false' } });
  const reset = await fetch(`${FIXTURE}/__lab/reset`, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(3000) });
  assert.equal(reset.status, 200);
  const observations = [];
  const postCase = async (caseId, expectedStatus, role, specific = false) => {
    const authorization = `Bearer ${token}${specific ? `-${primary.id}` : ''}`;
    const response = await fetchCore(`${origin}/v1/chat/completions`, { method: 'POST',
      headers: { authorization, 'content-type': 'application/json' },
      body: JSON.stringify(requestBody('chat', false, caseId)) });
    await response.text();
    const rows = (await fixtureState()).filter((row) => row.caseId === caseId);
    observations.push({ caseId, status: response.status, attempts: rows.length, roles: rows.map((row) => row.upstreamRole) });
    assert.equal(response.status, expectedStatus, `${caseId}: HTTP status`);
    assert.equal(rows.length, 1, `${caseId}: current request must not replay`);
    assert.equal(rows[0].upstreamRole, role, `${caseId}: selected route`);
  };
  for (const suffix of ['one', 'two', 'three', 'four']) {
    const fallback = expectCooldown && suffix === 'four';
    await postCase(`chat-timeout-${suffix}`, fallback ? 200 : 524, fallback ? 'backup' : 'primary');
  }
  if (expectCooldown) {
    await postCase('chat-gateway-timeout-specific', 504, 'primary', true);
    await postCase('chat-timeout-specific', 524, 'primary', true);
    await postCase('chat-recover-specific', 200, 'primary', true);
    await postCase('chat-gateway-timeout-reset', 504, 'primary');
  }
  if (genericFailures) {
    for (const [prefix, status] of [['chat-bad-gateway', 502], ['chat-unavailable', 503], ['chat-rate-limit', 429]]) {
      await postCase(`chat-recover-${prefix}`, 200, 'primary', true);
      for (const suffix of ['one', 'two', 'three', 'four']) {
        await postCase(`${prefix}-${suffix}`, suffix === 'four' ? 200 : status, suffix === 'four' ? 'backup' : 'primary');
      }
    }
  }
  return { passed: expectCooldown
    ? ['first-three-524-single-dispatch', 'fourth-new-request-backup-success', 'explicit-channel-keeps-primary',
      '504-and-524-no-replay', 'primary-success-clears-cooldown', ...(genericFailures ? ['502-503-429-single-dispatch-and-fourth-request-failover'] : [])]
    : ['four-separate-524-requests-single-dispatch', 'locked-core-does-not-cool-down-primary'], observations,
    notRun: ['Existing ten protocol cases were not repeated.', ...(!expectCooldown
      ? ['Future core fix: fourth new request uses backup; not implemented or passed.'] : [])],
    limitations: ['Synthetic immediate 524 reproduces selection behavior, not real upstream timeout latency.',
      'No affinity, production credentials, production database or external upstream.'] };
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const timeoutMode = ['--timeout-routing', '--timeout-cooldown', '--failure-cooldown'].includes(process.argv[2]);
  const result = timeoutMode ? verifyTimeoutRouting(process.argv[3], process.argv[2] !== '--timeout-routing', process.argv[2] === '--failure-cooldown') : verify(process.argv[2]);
  result.then((result) => console.log(JSON.stringify(result, null, 2))).catch((error) => {
    console.error(`LAB FAILED: ${error.message}`);
    process.exitCode = 1;
  });
}
