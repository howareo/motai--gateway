import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { createApp } from '../src/server.js';
import { GatewayControl } from '../src/gateway/control.js';
import { ConfigPublisher } from '../src/gateway/config-publisher.js';
import { GatewayProjection } from '../src/gateway/projection.js';
import { assertContract, validateRecord } from '../src/gateway/schema.js';

const fixture = async (name) => JSON.parse(await readFile(new URL(`../contracts/fixtures/${name}.json`, import.meta.url), 'utf8'));
const sample = await fixture('attempt-valid');
const statusSample = (await fixture('internal-api-samples')).samples.status;
const FIRST = 'Model/First', SELECTED = 'Model/Selected';

async function setup(t, { missingTestModel = false, onlyCountTokens = false, multiPool = false } = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), 'motai-probe-integration-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const config = await fixture('config-valid'), credentials = await fixture('credentials-valid');
  config.models = [FIRST, SELECTED].map((id) => ({ id, vendor: 'openai' }));
  config.aliases = []; config.callers = [];
  if (multiPool) config.pools.push({ id: 'pool-second', name: '第二个池' });
  config.channels = ['enabled-channel', 'disabled-channel'].map((id, index) => ({ ...config.channels[0],
    id, name: id, enabled: index === 0,
    ...(multiPool ? { pool_ids: ['pool-main', 'pool-second'] } : {}),
    models: [FIRST, SELECTED].map((modelId) => ({ model_id: modelId, upstream_model: `Upstream/${modelId}`,
      capabilities: onlyCountTokens === true || (Array.isArray(onlyCountTokens) && onlyCountTokens.includes(id))
        ? ['count_tokens'] : ['count_tokens', modelId === FIRST ? 'responses' : 'chat_completions'] })) }));
  const state = { committed: null, jobs: [], submissions: [], probeErrors: new Map(), events: [],
    legacyCalls: 0, healthReads: 0, healthWrites: 0, attemptsQueries: [] };
  const client = {
    status: async () => ({ ...statusSample, serving_gen: state.committed, committed_gen: state.committed }),
    activate: async (input) => { state.committed = input.gen; return { format_version: 1, ...input,
      serving_gen: input.gen, committed_gen: input.gen }; },
    probe: async (request) => {
      assertContract('probe_request', request);
      state.submissions.push(structuredClone(request));
      if (state.probeErrors.has(request.channel_id)) throw state.probeErrors.get(request.channel_id);
      const response = assertContract('probe_response', { format_version: 1, client_run_id: request.client_run_id,
        request_id: randomUUID(), attempt_id: randomUUID(), state: 'accepted' });
      state.jobs.push({ request: structuredClone(request), response });
      return response;
    },
    events: async ({ after_seq }) => ({ format_version: 1,
      events: state.events.filter((event) => BigInt(event.seq) > BigInt(after_seq)),
      next_seq: String(state.events.length), latest_seq: String(state.events.length), has_more: false }),
    attempts: async (query) => {
      state.attemptsQueries.push(query);
      return { format_version: 1, snapshot_seq: String(state.events.length), has_more: false, next_cursor: null,
        attempts: state.events.map((event) => event.attempt).filter(({ intent, terminal }) =>
          (!query.channel_id || intent.channel_id === query.channel_id)
          && (!query.model_id || intent.model_canonical === query.model_id)
          && (!query.kind || intent.kind === query.kind)
          && (!query.outcomes.length || query.outcomes.includes(terminal.attempt_outcome))) };
    },
  };
  const publisher = new ConfigPublisher({ directory: path.join(directory, 'config'), client });
  await publisher.publish({ baseGen: null, config, credentials,
    testModels: Object.fromEntries(config.channels.filter((channel) => !missingTestModel || channel.id !== 'enabled-channel')
      .map((channel) => [channel.id, SELECTED])) });
  const control = new GatewayControl({ publisher, client });
  const noop = { load: async () => {}, start: async () => {}, stop: async () => {}, flush: async () => {} };
  const costStore = { ...noop, version: 1, resolve: () => ({ id: 'synthetic-procurement', revision: 1, multiplier: 0.25 }),
    channelPricing: () => ({ multiplier: 0.25, source: 'manual' }), snapshot: () => ({ version: 1, rules: [] }) };
  const priceStore = { ...noop, snapshot: () => ({ snapshotHash: 'synthetic-probe-price-v1' }),
    resolve: (modelId) => ({ model: modelId, family: 'openai', currency: 'USD', effectiveFrom: 0,
      effectiveTo: null, maxContextTokens: null, rates: { input: 2, cacheRead: 0.2, cacheWrite: 2.5, output: 10 } }) };
  const projection = new GatewayProjection({ directory: path.join(directory, 'projection'), client,
    priceStore, costStore });
  const app = createApp({ gatewayControl: control, gatewayProjection: projection,
    client: new Proxy({}, { get: () => () => { state.legacyCalls++; throw new Error('Legacy client must not serve gateway probes'); } }),
    costStore, modelPricingStore: priceStore, newApiPricingSyncStore: noop,
    walletStore: { ...noop, publicState: () => null }, walletService: noop,
    channelHealthStore: { ...noop, probeIntervalMinutes: 60,
      channel: () => { state.healthReads++; throw new Error('Probe health must come from projection'); },
      record: () => { state.healthWrites++; throw new Error('Accepted jobs are not terminal health events'); } },
    logCacheStore: { ...noop, overviewEntries: () => { throw new Error('Legacy log cache must not serve gateway probes'); } },
    costSyncIntervalMs: 3600000, channelHealthIntervalMs: 3600000, modelPricingSyncIntervalMs: 3600000 });
  t.after(() => app.close());
  await app.start({ host: '127.0.0.1', port: 0 });
  await projection.catchUp();
  const origin = `http://127.0.0.1:${app.server.address().port}`;
  const request = async (pathname, body) => {
    const response = await fetch(`${origin}${pathname}`, body === undefined ? {} : { method: 'POST',
      headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify(body) });
    return { status: response.status, body: await response.json() };
  };
  const completeFailedProbe = async (job) => {
    if (projection.pending) await projection.pending;
    const attempt = structuredClone(sample), { request: probe, response } = job;
    const channel = control.config().channels.find((row) => row.id === probe.channel_id);
    const started = Date.now() - 10000;
    Object.assign(attempt.intent, { kind: 'probe', gen: control.config().gen, request_id: response.request_id,
      attempt_id: response.attempt_id, channel_id: channel.id, channel_name: channel.name,
      model_requested: probe.model_id, model_canonical: probe.model_id,
      model_upstream: channel.models.find((model) => model.modelId === probe.model_id).upstreamModel,
      pool_id: probe.pool_id ?? channel.poolId, protocol: probe.protocol, started_at: new Date(started).toISOString() });
    Object.assign(attempt.terminal, { attempt_id: response.attempt_id, ended_at: new Date(started + 1000).toISOString(),
      request_outcome: 'failed', attempt_outcome: 'upstream_failed', upstream_status: 502,
      error_class: 'upstream_5xx', channel_effect: 'failure_counted' });
    assert.deepEqual(validateRecord('attempt', attempt).errors, []);
    state.events.push({ format_version: 1, seq: String(state.events.length + 1), event_type: 'attempt_terminal', attempt });
    await projection.catchUp();
    return attempt;
  };
  return { app, control, projection, state, request, completeFailedProbe };
}

test('channel health HTTP is redacted and manual recovery enforces same-origin JSON writes', async (t) => {
  const { app, control, request } = await setup(t);
  const channelId = control.config().channels[0].id;
  let resets = 0;
  control.client.channelHealth = async () => ({ format_version: 1, gen: control.config().gen, channels: [{
    channel_id: channelId, credential_version: '1', state: 'exhausted', state_version: '7',
    observed_at: '2026-10-27T01:00:00Z', secret: 'CANARY_UPSTREAM_SECRET' }] });
  control.client.resetHealth = async (id, body) => {
    resets++;
    assert.equal(id, channelId);
    assert.equal(body.expected_state_version, '7');
    return { format_version: 1, channel_id: id, operation_id: body.operation_id,
      credential_version: '1', state: 'available', state_version: '8', changed: true };
  };
  const health = await request('/api/gateway/channels/health');
  assert.equal(health.status, 200); assert.equal(health.body.channels[0].state, 'exhausted');
  assert.equal(JSON.stringify(health.body).includes('CANARY'), false);
  const body = { baseGen: control.config().gen, operationId: randomUUID(), credentialVersion: '1', stateVersion: '7' };
  const path = `/api/gateway/channels/${encodeURIComponent(channelId)}/health-reset`;
  const origin = `http://127.0.0.1:${app.server.address().port}`;
  const denied = await fetch(origin + path, { method: 'POST', headers: { origin: 'http://foreign.invalid',
    'content-type': 'application/json' }, body: JSON.stringify(body) });
  assert.equal(denied.status, 403); assert.equal(resets, 0);
  const ok = await request(path, body);
  assert.equal(ok.status, 200); assert.equal(ok.body.stateVersion, '8'); assert.equal(resets, 1);
});

test('gateway scheduled probes dispatch enabled channels and skip manually disabled channels', async (t) => {
  const { app, state, control } = await setup(t);
  const run = await app.triggerChannelHealthProbes();
  assert.equal(run.attempted, 1, 'candidate scheduling must reach core.probe rather than require legacy testChannel');
  assert.equal(state.jobs.length, 1);
  assert.deepEqual(state.jobs.map(({ request }) => [request.source, request.channel_id, request.model_id, request.protocol]),
    [['scheduled', 'enabled-channel', SELECTED, 'chat_completions']]);
  assert.equal(run.results[0].state, 'accepted');
  assert.equal(Object.hasOwn(run.results[0], 'success'), false);
  assert.equal(control.config().channels.find((row) => row.id === 'disabled-channel').enabled, false);
  assert.equal(state.legacyCalls, 0); assert.equal(state.healthWrites, 0);
});

test('multi-pool manual probes require explicit membership and forward only the selected pool', async (t) => {
  const { request, state, control } = await setup(t, { multiPool: true });
  const before = control.config();
  const path = '/api/channels/enabled-channel/test';
  for (const [body, code] of [[{}, 'pool_required'], [{ poolId: 'foreign-pool' }, 'invalid_pool'], [null, 'invalid_contract']]) {
    const result = await request(path, body);
    assert.equal(result.status, 400);
    assert.equal(result.body.error.code, code);
  }
  assert.equal(state.submissions.length, 0);
  const result = await request(path, { poolId: 'pool-second' });
  assert.equal(result.status, 202);
  assert.equal(state.submissions.length, 1);
  assert.equal(state.submissions[0].pool_id, 'pool-second');
  assert.equal(state.submissions[0].channel_id, 'enabled-channel');
  assert.deepEqual(control.config(), before);
});

test('multi-pool scheduling records a distinct probe per pool without enabling disabled channels', async (t) => {
  const { app, state } = await setup(t, { multiPool: true });
  const run = await app.triggerChannelHealthProbes();
  assert.equal(run.attempted, 2);
  assert.deepEqual(state.submissions.map((row) => [row.channel_id, row.pool_id]),
    [['enabled-channel', 'pool-main'], ['enabled-channel', 'pool-second']]);
  assert.notEqual(state.submissions[0].client_run_id, state.submissions[1].client_run_id);
  assert.equal(state.healthWrites, 0);
  assert.equal(state.legacyCalls, 0);
});

test('multi-pool recovery selects the matching pool health version and keeps other pool state', async (t) => {
  const { control, request } = await setup(t, { multiPool: true });
  control.client.channelHealth = async () => ({ format_version: 1, gen: control.config().gen,
    channels: ['pool-main', 'pool-second'].map((pool_id, index) => ({ channel_id: 'enabled-channel', pool_id,
      credential_version: '1', state: 'exhausted', state_version: String(7 + index), observed_at: '2026-10-27T01:00:00Z' })) });
  const health = await request('/api/gateway/channels/health');
  assert.deepEqual(health.body.channels.map((row) => [row.poolId, row.stateVersion]), [['pool-main', '7'], ['pool-second', '8']]);
  let submitted;
  control.client.resetHealth = async (channelId, body) => {
    submitted = body;
    return { format_version: 1, channel_id: channelId, pool_id: body.pool_id, operation_id: body.operation_id,
      credential_version: '1', state: 'available', state_version: '9', changed: true };
  };
  const result = await request('/api/gateway/channels/enabled-channel/health-reset', { baseGen: control.config().gen,
    operationId: randomUUID(), poolId: 'pool-second', credentialVersion: '1', stateVersion: '8' });
  assert.equal(result.status, 200);
  assert.equal(submitted.pool_id, 'pool-second');
  assert.equal(submitted.expected_state_version, '8');
  assert.equal(result.body.poolId, 'pool-second');
});

test('manual probe accepts a disabled channel without enabling it or publishing a new generation', async (t) => {
  const { request, control, state } = await setup(t), before = control.config();
  const result = await request('/api/channels/disabled-channel/test', {});
  assert.equal(result.status, 202);
  assert.equal(result.body.state, 'accepted');
  assert.equal(Object.hasOwn(result.body, 'success'), false);
  assert.deepEqual(state.jobs[0].request, { format_version: 1, source: 'manual', channel_id: 'disabled-channel',
    model_id: SELECTED, protocol: 'chat_completions', client_run_id: result.body.client_run_id });
  assert.deepEqual(control.config(), before);
  assert.equal(state.healthWrites, 0); assert.equal(state.legacyCalls, 0);
});

test('an empty test model falls back to the first selected model that a probe can call, like New API', async (t) => {
  const { request, state } = await setup(t, { missingTestModel: true });
  const result = await request('/api/channels/enabled-channel/test', {});
  assert.equal(result.status, 202);
  assert.equal(state.jobs.length, 1);
  assert.deepEqual([state.jobs[0].request.model_id, state.jobs[0].request.protocol], [FIRST, 'responses']);
});

test('an empty test model with no callable model is rejected with a clear error', async (t) => {
  const { request, state } = await setup(t, { missingTestModel: true, onlyCountTokens: ['enabled-channel'] });
  const result = await request('/api/channels/enabled-channel/test', {});
  assert.equal(result.status, 409);
  assert.equal(result.body.error.code, 'probe_model_unavailable');
  assert.equal(state.jobs.length, 0);
});

test('a test model with only count_tokens capability is rejected before core submission', async (t) => {
  const { request, state } = await setup(t, { onlyCountTokens: true });
  const result = await request('/api/channels/enabled-channel/test', {});
  assert.equal(result.status, 409);
  assert.equal(result.body.error.code, 'probe_model_unavailable');
  assert.equal(state.jobs.length, 0);
});

test('scheduling probes a channel without a test model through its first callable model', async (t) => {
  const { app, state } = await setup(t, { missingTestModel: true });
  const run = await app.triggerChannelHealthProbes();
  assert.equal(run.results[0].state, 'accepted');
  assert.deepEqual(state.submissions.map((row) => [row.source, row.channel_id, row.model_id, row.protocol]),
    [['scheduled', 'enabled-channel', FIRST, 'responses']]);
});

test('one scheduled channel with nothing callable is rejected while the next channel is still dispatched', async (t) => {
  const { app, request, control, state } = await setup(t, { missingTestModel: true, onlyCountTokens: ['enabled-channel'] });
  const enabled = await request('/api/gateway/channels/change', { baseGen: control.config().gen, operationId: randomUUID(),
    change: { action: 'enable', channelId: 'disabled-channel' } });
  assert.equal(enabled.status, 200);
  const run = await app.triggerChannelHealthProbes();
  assert.equal(run.attempted, 2, 'attempted counts targets, including locally rejected targets');
  assert.deepEqual(run.results[0], { channelId: 'enabled-channel', state: 'rejected', code: 'probe_model_unavailable' });
  assert.equal(run.results[1].state, 'accepted');
  assert.equal(state.submissions.length, 1); assert.equal(state.jobs.length, 1);
  assert.equal(state.jobs[0].request.channel_id, 'disabled-channel');
  assert.equal(state.healthWrites, 0);
});

test('scheduled core errors stay local and sanitized without aborting other channels or inventing health events', async (t) => {
  const { app, request, control, state } = await setup(t);
  const enabled = await request('/api/gateway/channels/change', { baseGen: control.config().gen, operationId: randomUUID(),
    change: { action: 'enable', channelId: 'disabled-channel' } });
  assert.equal(enabled.status, 200);
  state.probeErrors.set('enabled-channel', Object.assign(new Error('SYNTHETIC_UPSTREAM_BODY_SECRET'),
    { code: 'SYNTHETIC_UPSTREAM_CODE_SECRET', statusCode: 502 }));
  const run = await app.triggerChannelHealthProbes();
  assert.equal(run.attempted, 2); assert.equal(state.submissions.length, 2); assert.equal(state.jobs.length, 1);
  assert.deepEqual(run.results[0], { channelId: 'enabled-channel', state: 'rejected', code: 'probe_not_accepted' });
  assert.equal(run.results[1].state, 'accepted');
  assert.doesNotMatch(JSON.stringify(run), /SYNTHETIC_UPSTREAM/);
  const overview = await request('/api/overview?period=today');
  assert.equal(overview.status, 200); assert.equal(overview.body.metrics.probes, 0);
  assert.equal(state.healthWrites, 0); assert.equal(state.legacyCalls, 0);
});

test('channel removal between listing and manual submission returns 404 without probing stale configuration', async (t) => {
  const { app, request, control, state } = await setup(t);
  const list = app.client.channels.bind(app.client);
  app.client.channels = async () => {
    const channels = await list();
    await control.change({ baseGen: control.config().gen, operationId: randomUUID(),
      change: { action: 'delete', channelId: 'enabled-channel' } });
    return channels;
  };
  const result = await request('/api/channels/enabled-channel/test', {});
  assert.equal(result.status, 404); assert.equal(result.body.error.code, 'channel_not_found');
  assert.equal(state.submissions.length, 0); assert.equal(state.jobs.length, 0);
  assert.equal(control.config().channels.some((channel) => channel.id === 'enabled-channel'), false);
});

test('a channel added through gateway config probes its selected model and scheduling reads the new configuration', async (t) => {
  const { request, control, state, app } = await setup(t);
  const selected = 'New/Selected';
  const created = await request('/api/gateway/channels/change', { baseGen: control.config().gen, operationId: randomUUID(),
    change: { action: 'create', channel: { name: 'New synthetic channel', poolId: 'pool-main', vendor: 'openai',
      protocol: 'responses', baseUrl: 'https://new-upstream.invalid/v1', models: ['New/First', selected], testModel: selected },
    credentialAction: 'replace', credentialValue: 'SYNTHETIC_NOT_A_REAL_KEY' } });
  assert.equal(created.status, 200);
  const channelId = created.body.channelId;
  assert.equal(created.body.config.channels.find((row) => row.id === channelId).enabled, false);
  const manual = await request(`/api/channels/${channelId}/test`, {});
  assert.equal(manual.status, 202);
  assert.equal(state.jobs.at(-1).request.model_id, selected);
  assert.equal(state.jobs.at(-1).request.protocol, 'responses');
  const enabled = await request('/api/gateway/channels/change', { baseGen: control.config().gen, operationId: randomUUID(),
    change: { action: 'enable', channelId } });
  assert.equal(enabled.status, 200);
  state.jobs.length = 0;
  const scheduled = await app.triggerChannelHealthProbes();
  assert.equal(scheduled.attempted, 2);
  assert.deepEqual(state.jobs.map(({ request: probe }) => [probe.channel_id, probe.model_id]),
    [['enabled-channel', SELECTED], [channelId, selected]]);
});

test('gateway overview rebuilds changed prices in the background and preserves results while refusing future-format writes', async (t) => {
  const { app, projection, request, state, completeFailedProbe } = await setup(t);
  await request('/api/channels/enabled-channel/test', {});
  await completeFailedProbe(state.jobs[0]);
  const generation = projection.generation;
  projection.priceStore = { ...projection.priceStore, snapshot: () => ({ snapshotHash: 'new-price-version' }) };
  let release, markStarted;
  const blocked = new Promise((resolve) => { release = resolve; });
  const started = new Promise((resolve) => { markStarted = resolve; });
  const events = projection.client.events;
  projection.client.events = async (query) => { markStarted(); await blocked; return events(query); };
  try {
    const overview = await request('/api/overview?period=today');
    await started;
    assert.equal(overview.status, 200);
    assert.equal(overview.body.metrics.probes, 1);
    assert.equal(overview.body.projection.stale, true);
    assert.equal(projection.generation, generation);
  } finally { release(); }
  await projection.rebuildPending;
  assert.notEqual(projection.generation, generation);
  assert.equal(projection.state().requiresRebuild, false);
  const rebuilt = projection.generation;
  await app.warmOverview();
  assert.equal(projection.generation, rebuilt, 'unchanged prices use incremental catch-up');
  projection.writeBlocked = true;
  projection.client.events = async () => { throw new Error('future projection must stay read-only'); };
  assert.equal((await app.warmOverview()).writeBlocked, true);
  assert.equal(projection.generation, rebuilt);
});

test('accepted jobs stay uncounted until terminal projection supplies failed probe health, cost and records', async (t) => {
  const { request, state, completeFailedProbe } = await setup(t);
  const accepted = await request('/api/channels/enabled-channel/test', {});
  assert.equal(accepted.status, 202); assert.equal(accepted.body.state, 'accepted');
  const pending = await request('/api/overview?period=today');
  assert.equal(pending.status, 200);
  const pendingChannel = pending.body.channels.find((row) => row.id === 'enabled-channel');
  assert.equal(pendingChannel.probeAttempts, 0); assert.equal(pendingChannel.lastProbeSuccess, null);
  assert.equal(pendingChannel.state, 'unknown'); assert.deepEqual(pending.body.modelTests, []);
  assert.equal(pending.body.metrics.probes, 0);
  assert.deepEqual((await request('/api/requests?period=today')).body.items, []);
  const terminal = await completeFailedProbe(state.jobs[0]);
  const completed = await request('/api/overview?period=today');
  assert.equal(completed.status, 200);
  const channel = completed.body.channels.find((row) => row.id === 'enabled-channel');
  assert.equal(channel.probeAttempts, 1); assert.equal(channel.probeSuccesses, 0); assert.equal(channel.probeFailures, 1);
  assert.equal(channel.lastProbeSuccess, false); assert.equal(channel.state, 'failing');
  assert.equal(channel.recentProbes[0].attemptId, terminal.intent.attempt_id);
  assert.equal(completed.body.metrics.totalRequests, 0); assert.equal(completed.body.metrics.probes, 1);
  const probeCost = completed.body.modelTests.find((row) => row.channelId === channel.id);
  assert.equal(probeCost.requests, 1); assert.equal(probeCost.model, SELECTED);
  assert.ok(Math.abs(probeCost.officialCost - 0.000378) < 1e-12);
  assert.ok(Math.abs(probeCost.estimatedCost - 0.0000945) < 1e-12);
  const records = await request('/api/requests?period=today&channel=enabled-channel');
  assert.equal(records.status, 200); assert.equal(records.body.items.length, 1);
  const row = records.body.items[0];
  assert.equal(row.id, terminal.intent.attempt_id); assert.equal(row.source, 'motai');
  assert.equal(row.isModelTest, true); assert.equal(row.requestKind, 'probe');
  assert.equal(row.kind, 'error'); assert.equal(row.errorCode, 'upstream_5xx');
  assert.equal(row.inputTokens, 60); assert.equal(row.outputTokens, 25);
  assert.ok(Math.abs(row.estimatedCost - probeCost.estimatedCost) < 1e-12);
  assert.equal(state.attemptsQueries.at(-1).channel_id, 'enabled-channel');
  assert.equal(state.healthReads, 0); assert.equal(state.healthWrites, 0); assert.equal(state.legacyCalls, 0);
});
