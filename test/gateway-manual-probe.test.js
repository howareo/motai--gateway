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
const MODEL = 'Model/Probe';

// A gateway console with a fake core: probes are accepted at once and only become terminal attempts when a test says so.
async function setup(t, { appOptions = {}, missingTestModel = false, countTokensOnly = false } = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), 'motai-manual-probe-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const config = await fixture('config-valid'), credentials = await fixture('credentials-valid');
  config.models = [{ id: MODEL, vendor: 'openai' }];
  config.aliases = []; config.callers = [];
  config.channels = [{ ...config.channels[0], id: 'probe-channel', name: 'probe-channel', enabled: true,
    models: [{ model_id: MODEL, upstream_model: 'Upstream/Probe', capabilities: countTokensOnly ? ['count_tokens'] : ['count_tokens', 'chat_completions'] }] }];
  const state = { committed: null, jobs: [], events: [] };
  const client = {
    status: async () => ({ ...statusSample, serving_gen: state.committed, committed_gen: state.committed }),
    activate: async (input) => { state.committed = input.gen; return { format_version: 1, ...input, serving_gen: input.gen, committed_gen: input.gen }; },
    probe: async (request) => {
      assertContract('probe_request', request);
      const response = assertContract('probe_response', { format_version: 1, client_run_id: request.client_run_id,
        request_id: randomUUID(), attempt_id: randomUUID(), state: 'accepted' });
      state.jobs.push({ request: structuredClone(request), response });
      return response;
    },
    events: async ({ after_seq }) => ({ format_version: 1, events: state.events.filter((event) => BigInt(event.seq) > BigInt(after_seq)),
      next_seq: String(state.events.length), latest_seq: String(state.events.length), has_more: false }),
    attempts: async () => ({ format_version: 1, snapshot_seq: String(state.events.length), has_more: false, next_cursor: null,
      attempts: state.events.map((event) => event.attempt) }),
  };
  const publisher = new ConfigPublisher({ directory: path.join(directory, 'config'), client });
  await publisher.publish({ baseGen: null, config, credentials, testModels: missingTestModel ? {} : { 'probe-channel': MODEL } });
  const control = new GatewayControl({ publisher, client });
  const noop = { load: async () => {}, start: async () => {}, stop: async () => {}, flush: async () => {} };
  const costStore = { ...noop, version: 1, resolve: () => ({ id: 'synthetic', revision: 1, multiplier: 0.25 }),
    channelPricing: () => ({ multiplier: 0.25, source: 'manual' }), snapshot: () => ({ version: 1, rules: [] }) };
  const priceStore = { ...noop, snapshot: () => ({ snapshotHash: 'synthetic-manual-probe-v1' }),
    resolve: (modelId) => ({ model: modelId, family: 'openai', currency: 'USD', effectiveFrom: 0, effectiveTo: null,
      maxContextTokens: null, rates: { input: 2, cacheRead: 0.2, cacheWrite: 2.5, output: 10 } }) };
  const projection = new GatewayProjection({ directory: path.join(directory, 'projection'), client, priceStore, costStore });
  const app = createApp({ gatewayControl: control, gatewayProjection: projection,
    client: new Proxy({}, { get: () => () => { throw new Error('Legacy client must not serve gateway probes'); } }),
    costStore, modelPricingStore: priceStore, newApiPricingSyncStore: noop, walletStore: { ...noop, publicState: () => null },
    walletService: noop, channelHealthStore: { ...noop, probeIntervalMinutes: 60 }, logCacheStore: { ...noop },
    costSyncIntervalMs: 3600000, channelHealthIntervalMs: 3600000, modelPricingSyncIntervalMs: 3600000, ...appOptions });
  t.after(() => app.close());
  await app.start({ host: '127.0.0.1', port: 0 });
  await projection.catchUp();
  const origin = `http://127.0.0.1:${app.server.address().port}`;
  const request = async (pathname, body) => {
    const response = await fetch(`${origin}${pathname}`, body === undefined ? {} : { method: 'POST',
      headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify(body) });
    return { status: response.status, body: await response.json() };
  };
  // Make a job's attempt terminal, as the core would when the upstream answered.
  const finish = async (job, { success = true, durationMs = 3200, status = success ? 200 : 502 } = {}) => {
    const attempt = structuredClone(sample), { request: probe, response } = job;
    const channel = control.config().channels.find((row) => row.id === probe.channel_id);
    const started = Date.now() - durationMs;
    Object.assign(attempt.intent, { kind: 'probe', gen: control.config().gen, request_id: response.request_id,
      attempt_id: response.attempt_id, channel_id: channel.id, channel_name: channel.name,
      model_requested: probe.model_id, model_canonical: probe.model_id, model_upstream: 'Upstream/Probe',
      pool_id: channel.poolId, protocol: probe.protocol, started_at: new Date(started).toISOString() });
    Object.assign(attempt.terminal, { attempt_id: response.attempt_id, ended_at: new Date(started + durationMs).toISOString(),
      duration_ms: durationMs, request_outcome: success ? 'succeeded' : 'failed', attempt_outcome: success ? 'succeeded' : 'upstream_failed',
      upstream_status: status, error_class: success ? null : 'upstream_5xx', channel_effect: success ? 'success_reset' : 'failure_counted' });
    assert.deepEqual(validateRecord('attempt', attempt).errors, []);
    state.events.push({ format_version: 1, seq: String(state.events.length + 1), event_type: 'attempt_terminal', attempt });
    // An overview request may have a refresh in flight that has not seen this event yet; let it end, then read again.
    if (projection.pending) await projection.pending;
    await projection.catchUp();
  };
  const channelOverview = async () => (await request('/api/overview?period=today')).body.channels.find((row) => row.id === 'probe-channel');
  return { app, state, request, finish, channelOverview };
}

const nextJob = async (state, count = 1) => { for (let i = 0; i < 200 && state.jobs.length < count; i++) await new Promise((r) => setTimeout(r, 5)); return state.jobs[count - 1]; };

test('wait=true returns the real outcome with latency, and the result joins the channel history marked manual', async (t) => {
  const { state, request, finish, channelOverview } = await setup(t, { appOptions: { manualProbePollMs: 10 } });
  const pending = request('/api/channels/probe-channel/test', { wait: true });
  await finish(await nextJob(state), { durationMs: 3200 });
  const result = await pending;
  assert.equal(result.status, 200);
  assert.equal(result.body.state, 'completed');
  assert.equal(result.body.success, true);
  assert.equal(result.body.latencyMs, 3200);
  assert.equal(result.body.statusCode, 200);
  assert.equal(result.body.model, MODEL);
  assert.equal(result.body.protocol, 'chat_completions');
  assert.equal(result.body.source, 'manual');
  const channel = await channelOverview();
  assert.equal(channel.probeAttempts, 1); assert.equal(channel.probeSuccesses, 1);
  assert.equal(channel.lastProbeSuccess, true); assert.equal(channel.lastProbeLatencyMs, 3200);
  assert.equal(channel.probeAverageLatencyMs, 3200);
  assert.equal(channel.probePeriodHours, 24, 'the probe column prints "<hours>h 探活", so the period must be present');
  assert.equal(channel.probeModel, MODEL); assert.equal(channel.probeProtocol, 'chat_completions');
  assert.equal(channel.recentProbes[0].attemptId, result.body.attempt_id);
  assert.equal(channel.recentProbes[0].source, 'manual');
  assert.equal(channel.state, 'healthy');
});

test('a failed wait=true probe reports the upstream status and error class and still lands in the history', async (t) => {
  const { state, request, finish, channelOverview } = await setup(t, { appOptions: { manualProbePollMs: 10 } });
  const pending = request('/api/channels/probe-channel/test', { wait: true });
  await finish(await nextJob(state), { success: false, durationMs: 900, status: 502 });
  const result = await pending;
  assert.equal(result.status, 200);
  assert.equal(result.body.state, 'completed'); assert.equal(result.body.success, false);
  assert.equal(result.body.statusCode, 502); assert.equal(result.body.errorClass, 'upstream_5xx');
  assert.equal(result.body.latencyMs, 900);
  const channel = await channelOverview();
  assert.equal(channel.probeFailures, 1); assert.equal(channel.lastProbeSuccess, false); assert.equal(channel.state, 'failing');
});

test('when the wait budget runs out the answer is 202 waitTimedOut and the late result still joins the history', async (t) => {
  const { state, request, finish, channelOverview } = await setup(t, { appOptions: { manualProbeWaitMs: 120, manualProbePollMs: 10 } });
  const result = await request('/api/channels/probe-channel/test', { wait: true });
  assert.equal(result.status, 202);
  assert.equal(result.body.state, 'accepted'); assert.equal(result.body.waitTimedOut, true);
  assert.equal(Object.hasOwn(result.body, 'success'), false);
  assert.equal((await channelOverview()).probeAttempts, 0);
  await finish(state.jobs[0]);
  const channel = await channelOverview();
  assert.equal(channel.probeAttempts, 1); assert.equal(channel.recentProbes[0].source, 'manual');
});

test('without wait the manual probe still answers 202 at once and a non-boolean wait is rejected before anything is sent', async (t) => {
  const { state, request } = await setup(t);
  const accepted = await request('/api/channels/probe-channel/test', {});
  assert.equal(accepted.status, 202); assert.equal(accepted.body.state, 'accepted');
  assert.equal(Object.hasOwn(accepted.body, 'waitTimedOut'), false);
  const invalid = await request('/api/channels/probe-channel/test', { wait: 'yes' });
  assert.equal(invalid.status, 400); assert.equal(invalid.body.error.code, 'invalid_contract');
  assert.equal(state.jobs.length, 1);
});

test('scheduled probes are not marked manual, and manual ones are told apart in the same history', async (t) => {
  const { app, state, request, finish, channelOverview } = await setup(t);
  await app.triggerChannelHealthProbes();
  const manual = await request('/api/channels/probe-channel/test', {});
  assert.equal(state.jobs[0].request.source, 'scheduled'); assert.equal(state.jobs[1].request.source, 'manual');
  assert.equal(manual.body.attempt_id, state.jobs[1].response.attempt_id);
  await finish(state.jobs[0]); await finish(state.jobs[1]);
  const channel = await channelOverview();
  assert.equal(channel.probeAttempts, 2);
  assert.deepEqual(channel.recentProbes.map((probe) => probe.source ?? 'scheduled').sort(), ['manual', 'scheduled']);
});

test('a channel without a test model is probed through its first callable model and the panel says which', async (t) => {
  const { state, request, finish, channelOverview } = await setup(t, { missingTestModel: true, appOptions: { manualProbePollMs: 10 } });
  const before = await channelOverview();
  assert.equal(before.testModel, null); assert.equal(before.probeModel, MODEL); assert.equal(before.probeProtocol, 'chat_completions');
  const pending = request('/api/channels/probe-channel/test', { wait: true });
  await finish(await nextJob(state));
  const result = await pending;
  assert.equal(result.status, 200); assert.equal(result.body.model, MODEL); assert.equal(result.body.protocol, 'chat_completions');
});

test('a channel with nothing a probe can call says so and sends nothing', async (t) => {
  const { state, request, channelOverview } = await setup(t, { missingTestModel: true, countTokensOnly: true });
  const result = await request('/api/channels/probe-channel/test', { wait: true });
  assert.equal(result.status, 409); assert.equal(result.body.error.code, 'probe_model_unavailable');
  assert.match(result.body.error.message, /没有可探测的模型/);
  assert.equal(state.jobs.length, 0);
  const channel = await channelOverview();
  assert.equal(channel.probeModel, null); assert.equal(channel.probeProtocol, null);
});
