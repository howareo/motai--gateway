import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

const origin = process.env.MOTAI_CONSOLE_TEST_ORIGIN || 'http://127.0.0.1:8787';
const managementOrigin = process.env.MOTAI_GATEWAY_INTERNAL_URL;
const tests = [];
async function check(name, action) { await action(); tests.push(name); }
async function request(endpoint, body, method = 'POST') {
  const response = await fetch(`${origin}${endpoint}`, body === undefined ? {} : { method,
    headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const result = await response.json();
  assert.ok(response.ok, `${endpoint}: ${response.status} ${result.code ?? ''}`);
  return result;
}
const readyBy = Date.now() + 10_000;
while (true) {
  try {
    const response = await fetch(`${origin}/api/gateway/status`);
    if (response.ok) break;
  } catch (error) {
    if (Date.now() >= readyBy) throw error;
  }
  assert.ok(Date.now() < readyBy, 'Candidate console did not become ready');
  await new Promise((resolve) => setTimeout(resolve, 250));
}
let config = (await request('/api/gateway/config')).config;
const status = await request('/api/gateway/status');
await check('gateway/config/status', () => { assert.equal(status.mode, 'gateway'); assert.equal(status.ready, true); assert.equal(status.servingGen, config.gen); });
await check('static modules', async () => {
  for (const file of ['/', '/app.js', '/channel-editor/gateway-editor.js', '/channel-editor/gateway-session.js', '/caller-editor/editor.js', '/caller-editor/session.js']) {
    const response = await fetch(`${origin}${file}`); assert.equal(response.status, 200);
  }
});
await check('canonical overview and raw stats at the same sequence', async () => {
  let overview = await request('/api/overview?period=today');
  if (overview.projection.projectedSeq !== status.latestSeq) {
    const next = await request('/api/overview?period=today');
    if (BigInt(next.projection.projectedSeq) > BigInt(overview.projection.projectedSeq)) overview = next;
  }
  assert.equal(overview.source.mode, 'gateway');
  const token = await readFile(path.join(process.env.MOTAI_GATEWAY_CONFIG_DIR, 'management.key'), 'utf8');
  const url = new URL(`${managementOrigin.replace(/\/$/, '')}/stats`);
  for (const [key, value] of Object.entries({ from: overview.periodStartAt, to: overview.periodEndAt,
    snapshot_seq: overview.projection.projectedSeq, bucket: 'day' })) url.searchParams.set(key, value);
  const response = await fetch(url, { headers: { authorization: `Bearer ${token}` } });
  assert.equal(response.status, 200);
  const stats = await response.json();
  assert.equal(overview.metrics.totalRequests, stats.counts.requests);
  assert.equal(overview.metrics.probes, stats.counts.probes);
  assert.equal(overview.metrics.totalTokens, stats.tokens.total_input + stats.tokens.output_total);
});
await check('attempt cursor pagination and filters', async () => {
  const result = await request('/api/requests?period=today');
  assert.equal(result.mode, 'gateway'); assert.equal(result.total, null);
  assert.ok(typeof result.snapshotSeq === 'string');
  const filtered = await request('/api/requests?period=today&status=error');
  assert.ok(filtered.items.every((row) => row.kind === 'error'));
  assert.equal(JSON.stringify(result).includes('credential_ref'), false);
});
await check('same origin write protection', async () => {
  const response = await fetch(`${origin}/api/gateway/reconcile`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  assert.equal(response.status, 403);
});
if (process.env.MOTAI_CONSOLE_TEST_MUTATE === '1') {
  const channel = config.channels[0]; assert.ok(channel);
  const change = { action: 'create', channel: { name: 'Console synthetic verification', poolId: channel.poolId,
    baseUrl: channel.baseUrl, models: channel.models, testModel: channel.models[0].modelId },
    credentialAction: 'replace', credentialValue: 'synthetic-console-verification-key' };
  const payload = { baseGen: config.gen, operationId: randomUUID(), change };
  let created;
  await check('Node publisher to Go activation and fixed-operation replay', async () => {
    created = await request('/api/gateway/channels/change', payload);
    assert.equal(created.activated, true); config = created.config;
    assert.equal(config.channels.find((row) => row.id === created.channelId).enabled, false);
    const repeated = await request('/api/gateway/channels/change', payload);
    assert.equal(repeated.channelId, created.channelId); assert.equal(repeated.desiredGen, created.desiredGen);
    assert.equal(JSON.stringify(created).includes(change.credentialValue), false);
  });
  await check('channel cleanup after candidate verification', async () => {
    const result = await request('/api/gateway/channels/change', { baseGen: config.gen, operationId: randomUUID(),
      change: { action: 'delete', channelId: created.channelId } });
    assert.equal(result.activated, true); config = result.config;
  });
  await check('one-time caller token, hash privacy, explicit rotation and disable', async () => {
    const payload = { baseGen: config.gen, operationId: randomUUID(), change: { action: 'create', caller: { name: 'Console synthetic caller' } } };
    let result = await request('/api/gateway/callers/change', payload);
    assert.equal(result.activated, true); assert.ok(result.oneTimeToken); config = result.config;
    const originalToken = result.oneTimeToken;
    const callerId = result.callerId;
    assert.equal(config.callers.find((row) => row.id === callerId).enabled, false);
    assert.equal(JSON.stringify(config).includes(result.oneTimeToken), false);
    assert.equal(JSON.stringify(config).includes('token_hmac'), false);
    result = await request('/api/gateway/callers/change', payload);
    assert.equal(result.oneTimeToken, undefined); assert.equal(result.oneTimeTokenUnavailable, true);
    result = await request('/api/gateway/callers/change', { baseGen: config.gen, operationId: randomUUID(), change: { action: 'rotate', callerId } });
    assert.ok(result.oneTimeToken); config = result.config;
    const rotatedToken = result.oneTimeToken;
    const channel = config.channels.find((row) => row.enabled && row.models.some((model) => model.capabilities.includes('chat_completions')));
    assert.ok(channel, 'Synthetic Chat channel required for token verification');
    const model = channel.models.find((row) => row.capabilities.includes('chat_completions'));
    result = await request('/api/gateway/callers/change', { baseGen: config.gen, operationId: randomUUID(),
      change: { action: 'update', callerId, caller: { enabled: true, permissions: [{ poolId: channel.poolId,
        modelIds: [model.modelId], channelIds: [channel.id], protocols: ['chat_completions'], groups: [] }] } } });
    assert.equal(result.activated, true); config = result.config;
    const invoke = async (token) => {
      const response = await fetch(`${process.env.MOTAI_GATEWAY_MODEL_URL}/v1/chat/completions`, {
        method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ model: model.modelId, messages: [{ role: 'user', content: 'LAB:console-token-rotated' }], stream: false }),
        signal: AbortSignal.timeout(15_000) });
      await response.arrayBuffer();
      return response;
    };
    assert.ok([401, 403].includes((await invoke(originalToken)).status));
    const authorized = await invoke(rotatedToken);
    assert.equal(authorized.status, 200);
    assert.ok(authorized.headers.get('x-motai-attempt-id'));
    result = await request('/api/gateway/callers/change', { baseGen: config.gen, operationId: randomUUID(), change: { action: 'disable', callerId } });
    config = result.config;
    assert.equal(config.callers.find((row) => row.id === callerId).enabled, false);
    assert.ok([401, 403].includes((await invoke(rotatedToken)).status));
  });
}
console.log(JSON.stringify({ phase: 'S6-console-integration', passed: tests.length, tests, production_touched: false,
  servingGen: (await request('/api/gateway/status')).servingGen, limitations: ['synthetic upstream only', 'no browser or phone visual acceptance'] }));
