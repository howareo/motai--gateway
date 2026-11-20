import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { GatewayPanel, attemptToPanel } from '../src/gateway/panel.js';
import { GatewayProjection } from '../src/gateway/projection.js';
import { ConfigPublisher } from '../src/gateway/config-publisher.js';
import { CostStore } from '../src/cost-store.js';
import { createApp } from '../src/server.js';
import { validateQuery } from '../src/gateway/schema.js';

const fixture = async (name) => JSON.parse(await readFile(new URL(`../contracts/fixtures/${name}.json`, import.meta.url), 'utf8'));
const sample = await fixture('attempt-valid');
const config = await fixture('config-valid');
const price = { model: sample.intent.model_canonical, family: 'openai', effectiveFrom: 0, effectiveTo: null,
  maxContextTokens: null, currency: 'USD', rates: { input: 2, cacheRead: 0.2, output: 10 } };
const now = Date.parse('2026-10-26T08:00:00Z');

async function setup(t, prepare = () => {}) {
  const directory = await mkdtemp(path.join(tmpdir(), 'motai-panel-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const values = Array.from({ length: 3 }, (_, index) => {
    const value = structuredClone(sample);
    value.intent.request_id = randomUUID(); value.intent.attempt_id = randomUUID();
    value.terminal.attempt_id = value.intent.attempt_id;
    value.intent.channel_id = config.channels[0].id;
    value.intent.pool_id = config.channels[0].pool_id;
    value.intent.started_at = `2026-10-26T0${index}:00:00Z`;
    value.terminal.ended_at = `2026-10-26T0${index}:00:01Z`;
    if (index === 1) value.intent.kind = 'probe';
    if (index === 2) Object.assign(value.terminal, { request_outcome: 'failed', attempt_outcome: 'upstream_failed',
      upstream_status: 524, error_class: 'upstream_5xx', channel_effect: 'failure_counted' });
    return value;
  });
  values.forEach(prepare);
  let requests = [];
  const client = {
    events: async (query) => ({ format_version: 1, events: values.slice(Number(query.after_seq)).map((attempt, index) => ({
      format_version: 1, seq: String(Number(query.after_seq) + index + 1), event_type: 'attempt_terminal', attempt })),
      next_seq: '3', latest_seq: '3', has_more: false }),
    attempts: async (query) => {
      requests.push(query);
      assert.equal(validateQuery('attempts_query', query).valid, true);
      return { format_version: 1, attempts: values, snapshot_seq: '3', has_more: false, next_cursor: null };
    },
  };
  const costStore = new CostStore(path.join(directory, 'costs.json'));
  await costStore.save([{ id: 'procurement', channelId: '*', model: '*', multiplier: 0.5, effectiveFrom: 0, revision: 1 }], { expectedVersion: 0 });
  const priceStore = { resolve: () => price, snapshot: () => ({ snapshotHash: 'price1' }), load: async () => {} };
  const projection = new GatewayProjection({ directory, client, priceStore, costStore, now: () => now });
  await projection.catchUp();
  const publisher = new ConfigPublisher({ directory, client });
  const credentials = await fixture('credentials-valid');
  publisher.current = { config, credentials, metadata: { testModels: {} } };
  const control = { config: () => publisher.snapshot(), client, publisher, load: async () => {}, status: async () => ({ ready: true }) };
  const panel = new GatewayPanel({ control, projection, costStore, now: () => now });
  return { directory, values, client, projection, panel, control, costStore, priceStore, requests };
}

test('overview preserves one channel card and reports independent pool roles', async (t) => {
  const { panel, control } = await setup(t);
  const current = structuredClone(control.publisher.current);
  current.config.pools.push({ id: 'second', name: 'Second' });
  current.config.channels[0].pool_ids = ['pool-main', 'second'];
  current.config.channels[0].pool_priorities = { second: 60 };
  current.config.channels.push({ ...structuredClone(current.config.channels[0]), id: 'peer', priority: 50, pool_priorities: {} });
  control.publisher.current = current;
  const overview = panel.overview(new URLSearchParams());
  assert.equal(overview.channels.length, 2);
  const channel = overview.channels[0];
  assert.deepEqual(channel.poolIds, ['pool-main', 'second']);
  assert.deepEqual(channel.poolRoles.map(({ poolId, priority, routeRole }) => ({ poolId, priority, routeRole })), [
    { poolId: 'pool-main', priority: 27, routeRole: 'fallback' }, { poolId: 'second', priority: 60, routeRole: 'primary' }]);
  assert.equal(channel.routeRole, 'fallback');
  assert.equal(channel.poolRoles[1].isSolePrimary, true);
  assert.deepEqual(channel.poolRoles.map(({ position, poolSize }) => [position, poolSize]), [[2, 2], [1, 2]]);
  assert.equal(channel.position, 2);
  assert.equal(channel.poolSize, 2);
  current.config.channels[1].enabled = false;
  const after = panel.overview(new URLSearchParams()).channels;
  assert.equal(after[0].position, 2, 'disabled channels retain their configured slot');
  assert.equal(after[1].position, 1);
});

test('external Key bills never override gateway request costs or merge probes into totals', async (t) => {
  const { panel, costStore, control } = await setup(t);
  const id = control.config().channels[0].id;
  const baseline = panel.overview(new URLSearchParams('period=today'));
  costStore.upstreamBill = (channel, period) => channel === id && period.key === 'today'
    ? { date: '2026-10-26', actualCost: 95.19, standardCost: 811.3, requests: 6519, observedAt: new Date(now).toISOString() } : null;
  const overview = panel.overview(new URLSearchParams('period=today'));
  assert.deepEqual(overview.channels, baseline.channels);
  assert.deepEqual(overview.metrics, baseline.metrics);
  assert.deepEqual(overview.modelTests, baseline.modelTests);
  assert.equal(overview.channels[0].upstreamBill, undefined);
  assert.notEqual(overview.channels[0].estimatedCost, 95.19);
  assert.equal(overview.metrics.estimatedCost, overview.channels[0].estimatedCost);
  assert.equal(overview.metrics.currencies[0].procurementCost, baseline.metrics.currencies[0].procurementCost);
});

test('panel overview uses canonical counts, keeps failed known usage, and separates probe costs', async (t) => {
  const { panel, projection } = await setup(t);
  const result = panel.overview(new URLSearchParams());
  assert.equal(result.periodKey, 'today');
  assert.equal(result.metrics.totalRequests, 2);
  assert.equal(result.metrics.requests, 1);
  assert.equal(result.metrics.failedRequests, 1);
  assert.equal(result.metrics.totalTokens, 375);
  assert.equal(result.modelTests[0].requests, 1);
  assert.equal(result.trend.length, 2, 'the probe-only hour draws no trend point');
  assert.equal(result.trend[0].cacheHitRate, 0.4);
  assert.equal(result.metrics.avgDurationMs, 1000);
  assert.equal(result.metrics.avgTtftMs, 100);
  assert.equal(result.projection.snapshotSeq, undefined);
  assert.equal(result.projection.projectedSeq, '3');
  const all = projection.overview({ from: result.periodStartAt, to: result.periodEndAt });
  assert.equal(result.channels[0].officialCost, all.currencies[0].officialCost);
  assert.equal(result.metrics.estimatedCost, all.currencies[0].procurementCost);
});

test('channel probe health always covers the last 24 hours, whatever period is selected', async (t) => {
  // now = 2026-10-26T08:00Z. Success 1 hour ago; failures 28 hours ago (inside "yesterday") and 3 days ago.
  const startedAt = ['2026-10-26T07:00:00Z', '2026-10-25T04:00:00Z', '2026-10-23T08:00:00Z'];
  const { panel } = await setup(t, (value, index) => {
    value.intent.kind = 'probe';
    value.intent.started_at = startedAt[index];
    value.terminal.ended_at = startedAt[index].replace(':00Z', ':01Z');
    if (index > 0) Object.assign(value.terminal, { request_outcome: 'failed', attempt_outcome: 'upstream_failed',
      upstream_status: 524, error_class: 'upstream_5xx', channel_effect: 'failure_counted' });
  });
  for (const search of ['period=yesterday', 'period=hours-168&hours=168', 'period=today']) {
    const channel = panel.overview(new URLSearchParams(search)).channels[0];
    assert.equal(channel.probePeriodHours, 24, search);
    assert.deepEqual(channel.recentProbes.map((probe) => probe.checkedAt), [startedAt[0]], search);
    assert.equal(channel.probeAttempts, 1, search);
    assert.equal(channel.probeSuccesses, 1, search);
    assert.equal(channel.probeFailures, 0, search);
    assert.equal(channel.probeSuccessRate, 1, search);
    assert.equal(channel.lastProbeAt, startedAt[0], search);
    assert.equal(channel.state, 'healthy', search);
  }
});

test('overview, channel/model rows and trends preserve absent counts while retaining explicit zero', async (t) => {
  for (const value of [null, 0]) {
    const { panel } = await setup(t, (attempt) => {
      const usage = attempt.terminal.usage;
      const field = () => ({ value, availability: value === null ? 'absent' : 'known',
        completeness: 'final', provenance: value === null ? 'absent' : 'provider' });
      for (const key of ['total_input', 'input_uncached', 'cache_read', 'output_total', 'reasoning']) usage[key] = field();
      for (const key of ['ttl_5m', 'ttl_1h', 'ttl_unknown']) usage.cache_write[key] = field();
      usage.reasoning_relation = value === null ? 'unknown' : 'subset_of_output';
      usage.provider_counts = {};
    });
    const result = panel.overview(new URLSearchParams());
    for (const key of ['totalTokens', 'cacheReadTokens', 'cacheCreateTokens']) assert.equal(result.metrics[key], value, key);
    assert.equal(result.availability.cacheRead, value !== null);
    assert.equal(result.availability.cacheCreate, value !== null);
    for (const row of [...result.channels.filter((row) => row.requests > 0), ...result.models, ...result.modelTests]) {
      assert.equal(row.tokens, value);
    }
    for (const point of result.trend) {
      for (const key of ['input', 'output', 'cacheRead', 'cacheCreate']) assert.equal(point[key], value, key);
    }
  }
});

test('panel detail preserves unknown and partial values and projects only allowed fields', async (t) => {
  const { values, projection } = await setup(t);
  const item = structuredClone(values[0]);
  item.terminal.new_optional_response = 'CANARY_BODY';
  item.terminal.usage.new_optional_secret = 'CANARY_KEY';
  item.intent.new_optional_session = 'CANARY_SESSION';
  const row = attemptToPanel(item, projection);
  assert.equal(row.inputTokens, 60);
  assert.equal(row.rawInputTokens, 100);
  assert.equal(row.cacheReadTokens, 40);
  assert.equal(row.outputTokensPerSecond, 25);
  assert.equal(JSON.stringify(row).includes('CANARY'), false);
  item.terminal.usage.output_total = { value: null, availability: 'absent', completeness: 'final', provenance: 'absent' };
  item.terminal.usage.reasoning = { ...item.terminal.usage.output_total };
  item.terminal.usage.reasoning_relation = 'unknown';
  item.terminal.usage.provider_counts = {};
  const unknown = attemptToPanel(item, projection);
  assert.equal(unknown.outputTokens, null);
  assert.equal(unknown.outputTokensPerSecond, null);
});

test('request filters, cursor and snapshot pass to the Go query without local slicing', async (t) => {
  const { panel, requests } = await setup(t);
  const result = await panel.requests(new URLSearchParams({ period: 'today', status: 'error', stream: 'stream',
    channel: 'channel-uuid', cursor: 'cursor1', snapshotSeq: '3', page: '2',
    from: '2026-10-26T00:00:00Z', to: '2026-10-26T07:00:00Z' }));
  assert.equal(result.total, null);
  assert.equal(result.page, 2);
  assert.equal(result.snapshotSeq, '3');
  assert.equal(requests[0].channel_id, 'channel-uuid');
  assert.equal(requests[0].stream, true);
  assert.equal(requests[0].outcomes.includes('succeeded'), false);
  assert.equal(requests[0].to, '2026-10-26T07:00:00Z');
  await assert.rejects(panel.requests(new URLSearchParams({ page: 'NaN' })), { code: 'invalid_contract' });
});

test('gateway request page size defaults to 50 and accepts only bounded explicit limits', async (t) => {
  const { panel, requests } = await setup(t);
  assert.equal((await panel.requests(new URLSearchParams())).pageSize, 50);
  assert.equal(requests.at(-1).limit, 50);
  assert.equal((await panel.requests(new URLSearchParams({ limit: '100' }))).pageSize, 100);
  assert.equal(requests.at(-1).limit, 100);
  for (const limit of ['0', '-1', '101', 'NaN', '1.5']) {
    await assert.rejects(panel.requests(new URLSearchParams({ limit })), { code: 'invalid_contract' });
  }
});

test('gateway server serves projection and static modules without reading legacy logs or starting its jobs', async (t) => {
  const { directory, projection, control, costStore, priceStore } = await setup(t);
  let legacyCalls = 0;
  const legacy = new Proxy({}, { get: () => () => { legacyCalls += 1; throw new Error('legacy reached'); } });
  const noop = { load: async () => {}, start: async () => {}, stop: async () => {} };
  const app = createApp({ gatewayControl: control, gatewayProjection: projection, client: legacy,
    costStore, modelPricingStore: priceStore, newApiPricingSyncStore: noop,
    walletStore: { ...noop, publicState: () => null }, walletService: noop,
    channelHealthStore: { ...noop, probeIntervalMinutes: 10, channel: () => ({ recentProbes: [] }) },
    logCacheStore: { ...noop, flush: async () => {} } });
  t.after(() => app.close());
  await app.start({ host: '127.0.0.1', port: 0 });
  const origin = `http://127.0.0.1:${app.server.address().port}`;
  for (const module of ['channel-editor/gateway-session.js', 'channel-editor/gateway-editor.js', 'channel-editor/billing.js', 'caller-editor/editor.js', 'caller-editor/session.js']) {
    const response = await fetch(`${origin}/${module}`);
    assert.equal(response.status, 200, module);
  }
  const response = await fetch(`${origin}/api/overview?period=today`);
  assert.equal(response.status, 200);
  assert.equal((await response.json()).source.mode, 'gateway');
  assert.equal((await fetch(`${origin}/api/requests?period=today`)).status, 200);
  assert.equal((await fetch(`${origin}/api/channels`, { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: '{}' })).status, 503);
  assert.equal(legacyCalls, 0);
});

test('gateway discard route requires same-origin JSON write and delegates only the submitted candidate identity', async (t) => {
  const { projection, control, costStore, priceStore } = await setup(t);
  const calls = [];
  control.discard = async (input) => { calls.push(input); return { desiredGen: '1', discardedGen: '2', activated: true }; };
  const noop = { load: async () => {}, start: async () => {}, stop: async () => {}, flush: async () => {} };
  const app = createApp({ gatewayControl: control, gatewayProjection: projection, costStore, modelPricingStore: priceStore,
    newApiPricingSyncStore: noop, walletStore: { ...noop, publicState: () => null }, walletService: noop,
    channelHealthStore: { ...noop, probeIntervalMinutes: 10, channel: () => ({ recentProbes: [] }) }, logCacheStore: noop });
  t.after(() => app.close()); await app.start({ host: '127.0.0.1', port: 0 });
  const origin = `http://127.0.0.1:${app.server.address().port}`, body = JSON.stringify({ gen: '2', manifestSha256: 'a'.repeat(64) });
  const post = (headers) => fetch(`${origin}/api/gateway/discard`, { method: 'POST', headers, body });
  assert.equal((await post({ origin: 'https://other.invalid', 'content-type': 'application/json' })).status, 403);
  assert.equal((await post({ origin, 'content-type': 'text/plain' })).status, 415);
  assert.equal(calls.length, 0);
  const response = await post({ origin, 'content-type': 'application/json' });
  assert.equal(response.status, 200); assert.equal((await response.json()).discardedGen, '2');
  assert.deepEqual(calls, [JSON.parse(body)]);
});

test('channel and model rows count requests without probes; model tests count probes', async (t) => {
  const { panel } = await setup(t);
  const result = panel.overview(new URLSearchParams());
  // The fixture has one succeeded request, one probe and one failed request on the same channel.
  assert.equal(result.metrics.totalRequests, 2);
  assert.equal(result.channels[0].requests, result.metrics.totalRequests);
  assert.equal(result.models.reduce((sum, row) => sum + row.requests, 0), result.metrics.totalRequests);
  assert.equal(result.modelTests.reduce((sum, row) => sum + row.requests, 0), result.metrics.probes);
  assert.equal(result.modelTests[0].requests, 1);
});

test('cost of channels missing from the configuration is reported as removedChannels and the distribution adds up to the metric card', async (t) => {
  const { panel } = await setup(t, (value, index) => { if (index === 2) value.intent.channel_id = 'deleted-channel'; });
  const result = panel.overview(new URLSearchParams());
  assert.equal(result.channels.some((row) => row.id === 'deleted-channel'), false);
  assert.equal(result.removedChannels.length, 1);
  const removed = result.removedChannels[0];
  assert.equal(removed.id, 'deleted-channel');
  assert.equal(removed.name, '渠道 #deleted-channel（已删除）');
  assert.equal(removed.requests, 1);
  for (const key of ['tokens', 'estimatedCost', 'officialCost', 'currencies', 'costCoverage', 'estimatedCostIsLowerBound']) assert.ok(key in removed, key);
  const distributed = [...result.channels, ...result.removedChannels].reduce((sum, row) => sum + (row.estimatedCost ?? 0), 0);
  assert.ok(Math.abs(distributed - result.metrics.estimatedCost) < 1e-9, `${distributed} vs ${result.metrics.estimatedCost}`);
  assert.equal(result.channels.reduce((sum, row) => sum + row.requests, 0) + removed.requests, result.metrics.totalRequests);
});

test('overview without removed channels returns an empty removedChannels list', async (t) => {
  const { panel } = await setup(t);
  assert.deepEqual(panel.overview(new URLSearchParams()).removedChannels, []);
});

test('channel state is recovered when the last probe succeeded but the 24 hour window had a failure', async (t) => {
  const startedAt = ['2026-10-26T05:00:00Z', '2026-10-26T06:00:00Z', '2026-10-26T07:00:00Z'];
  const outcomes = ['succeeded', 'failed', 'succeeded'];
  const { panel } = await setup(t, (value, index) => {
    value.intent.kind = 'probe';
    value.intent.started_at = startedAt[index];
    value.terminal.ended_at = startedAt[index].replace(':00Z', ':01Z');
    if (outcomes[index] === 'failed') Object.assign(value.terminal, { request_outcome: 'failed', attempt_outcome: 'upstream_failed',
      upstream_status: 524, error_class: 'upstream_5xx', channel_effect: 'failure_counted' });
    else Object.assign(value.terminal, Object.fromEntries(['request_outcome', 'attempt_outcome', 'upstream_status', 'error_class', 'channel_effect']
      .map((key) => [key, sample.terminal[key]])));
  });
  const channel = panel.overview(new URLSearchParams()).channels[0];
  assert.equal(channel.lastProbeSuccess, true);
  assert.equal(channel.probeFailures, 1);
  assert.equal(channel.state, 'recovered');
});

test('client-cancelled requests stay in the failed count but are not upstream errors', async (t) => {
  const { panel } = await setup(t, (value, index) => {
    // Order of the fixture rows: 0 = first request, 1 = probe, 2 = failed request. Row 0 becomes a client disconnect.
    if (index === 0) Object.assign(value.terminal, { request_outcome: 'cancelled', attempt_outcome: 'client_gone',
      upstream_status: null, error_class: 'client_cancelled', channel_effect: 'none' });
  });
  const result = panel.overview(new URLSearchParams());
  assert.equal(result.metrics.totalRequests, 2);
  assert.equal(result.metrics.requests, 0);
  assert.equal(result.metrics.failedRequests, 2);
  assert.equal(result.metrics.cancelledRequests, 1);
  assert.equal(result.metrics.errorCount, 1);
  assert.equal(result.channels[0].errorCount, 1);
  const page = await panel.requests(new URLSearchParams('status=error'));
  const cancelled = page.items.find((row) => row.requestOutcome === 'cancelled');
  assert.equal(cancelled.kind, 'error');
  assert.equal(cancelled.errorCode, 'client_cancelled');
  assert.equal(page.latestError.requestOutcome, 'failed');
  // The "failed only" total counts the disconnect and the upstream failure; the successful probe is outside it.
  assert.equal(page.summary.requests, 2);
});

test('a period with only client disconnects reports no upstream error', async (t) => {
  const { panel } = await setup(t, (value, index) => {
    if (index !== 1) Object.assign(value.terminal, { request_outcome: 'cancelled', attempt_outcome: 'client_gone',
      upstream_status: null, error_class: 'client_cancelled', channel_effect: 'none' });
  });
  const result = panel.overview(new URLSearchParams());
  assert.equal(result.metrics.failedRequests, 2);
  assert.equal(result.metrics.cancelledRequests, 2);
  assert.equal(result.metrics.errorCount, 0);
  assert.equal(result.channels[0].errorCount, 0);
  assert.equal((await panel.requests(new URLSearchParams())).latestError, null);
});

test('cooldown-triggering attempts are counted in the overview and the channel row, and flagged on the request row', async (t) => {
  // Fixture rows: 0 = successful request, 1 = probe, 2 = failed request. Row 2 tripped the cooldown; the probe's own cooldown is not counted.
  const { panel, values } = await setup(t, (value, index) => {
    if (index === 2) value.terminal.channel_effect = 'cooldown';
    if (index === 1) Object.assign(value.terminal, { request_outcome: 'failed', attempt_outcome: 'upstream_failed',
      upstream_status: 524, error_class: 'upstream_5xx', channel_effect: 'cooldown' });
  });
  const overview = panel.overview(new URLSearchParams());
  assert.equal(overview.metrics.cooldowns, 1);
  assert.equal(overview.metrics.failovers, 0, 'the old same-request failover count is untouched');
  assert.equal(overview.channels[0].cooldowns, 1);
  const rows = (await panel.requests(new URLSearchParams())).items;
  assert.deepEqual(rows.map((row) => row.cooldownTriggered), [false, true, true]);
  assert.equal(attemptToPanel(values[0], panel.projection).cooldownTriggered, false);
  assert.equal(attemptToPanel(values[2], panel.projection).cooldownTriggered, true);
  const quiet = await setup(t);
  assert.equal(quiet.panel.overview(new URLSearchParams()).metrics.cooldowns, 0);
  assert.equal(quiet.panel.overview(new URLSearchParams()).channels[0].cooldowns, 0);
});

test('a failed request shows the upstream wording when the core kept it, else the error class', async (t) => {
  // Fixture rows: 0 = successful request, 1 = probe, 2 = failed request.
  const { panel, values } = await setup(t, (value, index) => {
    if (index === 2) value.terminal.error_detail = '余额不足，请充值后再试';
    if (index === 0) value.terminal.error_detail = 'ignored on success';
  });
  const failed = attemptToPanel(values[2], panel.projection);
  assert.equal(failed.errorMessage, '余额不足，请充值后再试');
  assert.equal(failed.errorCode, values[2].terminal.error_class, 'the class stays available');
  assert.equal(attemptToPanel(values[0], panel.projection).errorMessage, null);
  const plain = await setup(t);
  assert.equal(attemptToPanel(plain.values[2], plain.panel.projection).errorMessage, plain.values[2].terminal.error_class);
});

test('a request row shows inferred all-uncached input and flags it; a real cache figure is not flagged', async (t) => {
  const { panel, values } = await setup(t);
  const field = (value) => ({ value, availability: value === null ? 'absent' : 'known', completeness: 'final',
    provenance: value === null ? 'absent' : 'provider' });
  const inferred = structuredClone(values[0]);
  Object.assign(inferred.terminal.usage, { total_input: field(47057), input_uncached: field(null), cache_read: field(null),
    output_total: field(2721), reasoning: field(null) });
  const row = attemptToPanel(inferred, panel.projection);
  assert.equal(row.inputTokens, 47057);
  assert.equal(row.rawInputTokens, 47057);
  assert.equal(row.cacheReadTokens, 0);
  assert.equal(row.cacheReadInferred, true);
  assert.equal(inferred.terminal.usage.cache_read.availability, 'absent', 'the stored terminal is untouched');
  const real = attemptToPanel(values[0], panel.projection);
  assert.equal(real.inputTokens, 60);
  assert.equal(real.cacheReadTokens, 40);
  assert.equal(real.cacheReadInferred, false);
});

test('the cache trend charts real requests only; probes stay in the totals and the model-test figures', async (t) => {
  // Fixture rows land in three hours: 00 = successful request, 01 = probe, 02 = failed request.
  const { panel } = await setup(t);
  const overview = panel.overview(new URLSearchParams('period=all'));
  const hours = overview.trend.map((point) => point.time.slice(11, 13));
  assert.ok(!hours.includes('01'), 'the probe-only hour draws no trend point');
  assert.ok(hours.includes('00') && hours.includes('02'));
  for (const channel of overview.channelTrends) assert.ok(!channel.trend.some((point) => point.time.slice(11, 13) === '01'));
  assert.equal(overview.metrics.probes, 1, 'the probe is still counted in the totals');
  assert.equal(overview.modelTests.reduce((sum, row) => sum + row.requests, 0), 1);
});
