import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import { createFixtureServer, OPENAI_MODEL, TOOL, BACKUP_UPSTREAM_KEY } from '../gateway/lab/fixture.mjs';
import { assertLabUrl, labFetch, bootstrap } from '../gateway/lab/verify.mjs';

test('lab bootstrap synchronously refreshes routing after creating channels before reading a model token', async () => {
  const channels = [];
  const updates = [];
  const client = {
    login: async () => {},
    channels: async () => ({ items: channels }),
    createChannel: async (channel) => { channels.push({ ...channel, id: channels.length + 1 }); },
    updateChannelRouting: async (...args) => { updates.push(args); },
    request: async (path) => {
      if (path === '/api/setup') return { status: true };
      assert.equal(updates.length, 2, 'Both routing caches must be updated before using the token');
      if (path.startsWith('/api/token/?')) return { items: [{ id: 1, name: 'motai-lab-client' }] };
      if (path === '/api/token/1/key') return { key: 'synthetic-key' };
      assert.fail(`Unexpected bootstrap request: ${path}`);
    },
  };
  assert.equal(await bootstrap(client), 'sk-synthetic-key');
  assert.equal(channels.length, 2);
  assert.deepEqual(updates, channels.map((row) => [row.id, 10, 10, row.models, row.models, 'default']));
  updates.length = 0;
  assert.equal(await bootstrap(client), 'sk-synthetic-key');
  assert.equal(channels.length, 2, 'Repeated bootstrap must not duplicate its channels');
});

test('lab verifier rejects production and redirects before making a request', async () => {
  for (const target of ['http://10.10.0.188:3001', 'http://localhost:3001', 'http://localhost:13001', 'http://127.0.0.1:13001', 'https://core:3001',
    'http://core:3001/api', 'http://user:pass@core:3001', 'http://core:3001?next=production']) {
    assert.throws(() => assertLabUrl(target));
  }
  assert.equal(assertLabUrl('http://core:3001'), 'http://core:3001');
  let called = false;
  const guarded = labFetch('http://core:3001', async (_url, options) => { called = true; assert.equal(options.redirect, 'error'); });
  assert.throws(() => guarded('http://10.10.0.188:3001/api/channel/'));
  assert.equal(called, false);
  await guarded('http://core:3001/api/status');
  assert.equal(called, true);
});

test('synthetic upstream returns tools and usage without recording authorization', async (t) => {
  const server = createFixtureServer().listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const response = await fetch(`${origin}/v1/responses`, { method: 'POST', headers: { authorization: 'synthetic-not-to-record' },
    body: JSON.stringify({ model: OPENAI_MODEL, input: 'LAB:responses-json', stream: false, tools: [{ type: 'function', ...TOOL }] }) });
  const body = await response.json();
  assert.equal(body.output[0].arguments, '{"city":"Paris"}');
  assert.equal(body.usage.input_tokens_details.cached_tokens, 4);
  const state = await (await fetch(`${origin}/__lab/state`)).json();
  assert.equal(state.requests.length, 1);
  assert.equal(state.requests[0].caseId, 'responses-json');
  assert(!JSON.stringify(state).includes('synthetic-not-to-record'));
  const denied = await fetch(`${origin}/v1/responses`, { method: 'POST', body: JSON.stringify({ model: 'production-model', input: 'real request' }) });
  assert.equal(denied.status, 400);
});

test('timeout fixture distinguishes synthetic primary and backup without retaining credentials', async (t) => {
  const server = createFixtureServer().listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }));
  const origin = `http://127.0.0.1:${server.address().port}`;
  for (const [key, status] of [['synthetic-upstream-key', 524], [BACKUP_UPSTREAM_KEY, 200]]) {
    const response = await fetch(`${origin}/v1/chat/completions`, { method: 'POST',
      headers: { authorization: `Bearer ${key}` },
      body: JSON.stringify({ model: OPENAI_MODEL, messages: [{ role: 'user', content: 'LAB:chat-timeout-one' }] }) });
    assert.equal(response.status, status);
    await response.text();
  }
  const timeout = await fetch(`${origin}/v1/chat/completions`, { method: 'POST',
    body: JSON.stringify({ model: OPENAI_MODEL, messages: [{ role: 'user', content: 'LAB:chat-gateway-timeout-one' }] }) });
  assert.equal(timeout.status, 504);
  await timeout.text();
  for (const [prefix, status] of [['chat-bad-gateway', 502], ['chat-unavailable', 503], ['chat-rate-limit', 429]]) {
    const response = await fetch(`${origin}/v1/chat/completions`, { method: 'POST',
      body: JSON.stringify({ model: OPENAI_MODEL, messages: [{ role: 'user', content: `LAB:${prefix}-one` }] }) });
    assert.equal(response.status, status);
    await response.text();
  }
  const state = await (await fetch(`${origin}/__lab/state`)).json();
  assert.deepEqual(state.requests.map((row) => row.upstreamRole), ['primary', 'backup', 'primary', 'primary', 'primary', 'primary']);
  assert(!JSON.stringify(state).includes(BACKUP_UPSTREAM_KEY));
});

test('synthetic cancellation closes a live fixture response', async (t) => {
  const server = createFixtureServer().listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const controller = new AbortController();
  const response = await fetch(`${origin}/v1/responses`, { method: 'POST', signal: controller.signal,
    body: JSON.stringify({ model: OPENAI_MODEL, input: 'LAB:responses-cancel', stream: true }) });
  const reader = response.body.getReader();
  assert.equal((await reader.read()).done, false);
  controller.abort();
  await reader.cancel().catch(() => {});
  await new Promise((resolve) => setTimeout(resolve, 100));
  const state = await (await fetch(`${origin}/__lab/state`)).json();
  assert.equal(state.requests[0].closed, true);
  assert.equal(state.requests[0].finished, false);
});

test('all fixture protocols produce valid terminal tools/usage and disconnect remains partial', async (t) => {
  const server = createFixtureServer().listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }));
  const origin = `http://127.0.0.1:${server.address().port}`;
  for (const path of ['responses', 'chat/completions', 'messages']) {
    for (const stream of [false, true]) {
      const response = await fetch(`${origin}/v1/${path}`, { method: 'POST', body: JSON.stringify({
        model: OPENAI_MODEL, input: 'LAB:matrix', stream,
      }) });
      const text = await response.text();
      assert.equal(response.status, 200);
      if (!stream) {
        const body = JSON.parse(text);
        assert(body.usage);
        assert(text.includes(TOOL.name));
      } else {
        const events = text.split('\n').filter((line) => line.startsWith('data: ') && !line.includes('[DONE]'))
          .map((line) => JSON.parse(line.slice(6)));
        assert(events.length > 0);
        assert(text.includes(TOOL.name));
        assert(text.includes(path === 'responses' ? 'response.completed' : path === 'messages' ? 'message_stop' : '[DONE]'));
      }
    }
  }
  const response = await fetch(`${origin}/v1/responses`, { method: 'POST', body: JSON.stringify({
    model: OPENAI_MODEL, input: 'LAB:responses-disconnect', stream: true,
  }) });
  const reader = response.body.getReader();
  let partial = '';
  await assert.rejects(async () => {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return;
      partial += new TextDecoder().decode(value);
    }
  });
  assert(partial.includes('response.function_call_arguments.delta'));
  assert(!partial.includes('response.completed'));
});

test('lab compose pins the running image and isolates network, database and mounts without host ports', async () => {
  const compose = await readFile(new URL('../gateway/lab/compose.yaml', import.meta.url), 'utf8');
  assert.match(compose, /image: sha256:d1f5375c018e0f105ec856459102bdccc38752726a9025c26a73601f602d28e9/);
  assert(!/^\s*ports:/m.test(compose), 'Internal lab must not publish host ports');
  assert.match(compose, /internal: true/);
  assert.match(compose, /lab-postgres:/);
  assert.match(compose, /image: postgres:16\r?\n/);
  assert.match(compose, /image: redis:7\r?\n/);
  assert.equal((compose.match(/pull_policy: never/g) ?? []).length, 4);
  for (const limit of ['512m', '256m', '96m', '128m']) assert(compose.includes(`mem_limit: ${limit}`));
  assert(!compose.includes('external:') && !compose.includes('network_mode:') && !compose.includes('config.json'));
});
