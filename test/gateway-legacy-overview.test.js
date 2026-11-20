import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { GatewayPanel } from '../src/gateway/panel.js';
import { GatewayProjection } from '../src/gateway/projection.js';
import { ConfigPublisher } from '../src/gateway/config-publisher.js';
import { LegacyBackfill, LegacyOverview, legacyConfigFromEnvironment } from '../src/gateway/legacy-overview.js';
import { CostStore } from '../src/cost-store.js';
import { LegacyImport, normalizeLegacyRow } from '../src/gateway/legacy-import.js';
import { ModelPricingStore } from '../src/model-pricing-store.js';
import { priceUsage } from '../src/model-pricing.js';
import { createApp } from '../src/server.js';

const fixture = async (name) => JSON.parse(await readFile(new URL(`../contracts/fixtures/${name}.json`, import.meta.url), 'utf8'));
const sample = await fixture('attempt-valid');
const config = await fixture('config-valid');
const MODEL = config.models[0].id;
const now = Date.parse('2026-10-26T08:00:00Z');
const sec = (iso) => Date.parse(iso) / 1000;
const FROM = sec('2026-10-25T16:00:00Z'), SWITCH = sec('2026-10-26T00:00:00Z');
const T17 = sec('2026-10-25T17:00:00Z'), T20 = sec('2026-10-25T20:00:00Z');
const HOUR = 3_600_000;
const closeTo = (a, b) => assert.ok(Math.abs(a - b) < 1e-9, `${a} != ${b}`);
const rates = { input: 2, cacheRead: 0.2, output: 10 };
const record = (extra = {}) => ({ model: MODEL, family: 'openai', effectiveFrom: 0, effectiveTo: null,
  promptIncludesCache: true, maxContextTokens: null, currency: 'USD', rates, ...extra });
const legacyPrices = (make = () => record()) => ({ resolve: (model, at, family) => (make(at) ? { ...make(at), model, family } : null) });
const until = async (check) => {
  for (let index = 0; index < 200; index += 1) { const value = await check(); if (value) return value; await new Promise((resolve) => setTimeout(resolve, 10)); }
  throw new Error('condition not reached');
};
const models = new Map([[MODEL, { id: MODEL, vendor: 'openai' }]]);

const legacyRow = (id, at, extra = {}) => ({ id, created_at: at, channel: 1022, model_name: MODEL, prompt_tokens: 100,
  completion_tokens: 20, quota: 0, use_time: 1, is_stream: true,
  other: { usage_semantic: 'openai', cache_tokens: 0, cache_creation_tokens: 0 }, ...extra });
// Old log rows: A+B share a bucket, D is on a channel that is not configured, E on a model that is not configured.
const rows = () => ({
  2: [legacyRow(1, T17 + 10), legacyRow(2, T17 + 1200, { prompt_tokens: 50, completion_tokens: 10, other: { usage_semantic: 'openai', cache_tokens: 10, cache_creation_tokens: 0 } }),
    legacyRow(3, T17 + 2400, { channel: 999, prompt_tokens: 30, completion_tokens: 5 }),
    legacyRow(4, T17 + 3000, { model_name: 'other-model', prompt_tokens: 20, completion_tokens: 4 })],
  5: [legacyRow(1, T20 + 30, { prompt_tokens: 50, completion_tokens: 5 })],
});

function fakeClient(source, { failAt = 0 } = {}) {
  const calls = [];
  return { calls, requestLogPage: async (pathname) => {
    const query = new URL(pathname, 'http://legacy.invalid').searchParams;
    calls.push({ type: Number(query.get('type')), page: Number(query.get('p')), start: Number(query.get('start_timestamp')) });
    if (failAt && calls.length >= failAt) throw new Error('offline');
    const data = (source[Number(query.get('type'))] ?? []).filter((row) => row.created_at >= Number(query.get('start_timestamp'))
      && row.created_at <= Number(query.get('end_timestamp')));
    const size = Number(query.get('page_size')), page = Number(query.get('p'));
    return { total: data.length, items: data.slice((page - 1) * size, page * size) };
  } };
}

async function setup(t) {
  const directory = await mkdtemp(path.join(tmpdir(), 'motai-legacy-overview-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const values = Array.from({ length: 3 }, (_, index) => {
    const value = structuredClone(sample);
    value.intent.request_id = randomUUID(); value.intent.attempt_id = randomUUID();
    value.terminal.attempt_id = value.intent.attempt_id;
    value.intent.channel_id = config.channels[0].id; value.intent.pool_id = config.channels[0].pool_id;
    value.intent.started_at = `2026-10-26T0${index}:00:00Z`; value.terminal.ended_at = `2026-10-26T0${index}:00:01Z`;
    if (index === 1) value.intent.kind = 'probe';
    if (index === 2) Object.assign(value.terminal, { request_outcome: 'failed', attempt_outcome: 'upstream_failed',
      upstream_status: 524, error_class: 'upstream_5xx', channel_effect: 'failure_counted' });
    return value;
  });
  const client = { events: async (query) => ({ format_version: 1, events: values.slice(Number(query.after_seq)).map((attempt, index) => ({
    format_version: 1, seq: String(Number(query.after_seq) + index + 1), event_type: 'attempt_terminal', attempt })),
  next_seq: '3', latest_seq: '3', has_more: false }) };
  const costStore = new CostStore(path.join(directory, 'costs.json'));
  await costStore.save([{ id: 'procurement', channelId: '*', model: '*', multiplier: 0.5, effectiveFrom: 0, revision: 1 }], { expectedVersion: 0 });
  const priceStore = { resolve: () => record({ model: sample.intent.model_canonical }), snapshot: () => ({ snapshotHash: 'price1' }), load: async () => {} };
  const projection = new GatewayProjection({ directory, client, priceStore, costStore, now: () => now });
  await projection.catchUp();
  const publisher = new ConfigPublisher({ directory, client });
  publisher.current = { config, credentials: await fixture('credentials-valid'), metadata: { testModels: {} } };
  const control = { config: () => publisher.snapshot(), client, publisher, load: async () => {}, status: async () => ({ ready: true }) };
  return { directory, control, projection, costStore, priceStore };
}

async function backfilled(t, directory, source = rows(), options = {}) {
  const client = options.client ?? fakeClient(source);
  const backfill = new LegacyBackfill({ directory: path.join(directory, 'legacy'), sourceInstanceId: 'prod-1', client,
    from: FROM, to: options.to ?? SWITCH, backoffMs: options.backoffMs ?? 5 });
  t.after(() => backfill.stop());
  return { backfill, client };
}

const environment = { MOTAI_LEGACY_NEWAPI_BASE_URL: 'http://old.invalid', MOTAI_LEGACY_NEWAPI_ADMIN_TOKEN: 'token',
  MOTAI_LEGACY_SOURCE_INSTANCE_ID: 'prod-1', MOTAI_LEGACY_DIR: '/private/legacy', MOTAI_LEGACY_FROM: '100', MOTAI_LEGACY_TO: '200' };

test('legacy import is off without a base URL and every required variable is enforced when it is on', () => {
  assert.equal(legacyConfigFromEnvironment({}), null);
  assert.equal(legacyConfigFromEnvironment({ ...environment, MOTAI_LEGACY_NEWAPI_BASE_URL: ' ' }), null);
  const parsed = legacyConfigFromEnvironment(environment);
  assert.deepEqual([parsed.from, parsed.to, parsed.pageIntervalMs, parsed.sourceInstanceId], [100, 200, 1000, 'prod-1']);
  assert.equal(legacyConfigFromEnvironment({ ...environment, MOTAI_LEGACY_PAGE_INTERVAL_MS: '250' }).pageIntervalMs, 250);
  for (const name of Object.keys(environment).filter((key) => key !== 'MOTAI_LEGACY_NEWAPI_BASE_URL')) {
    assert.throws(() => legacyConfigFromEnvironment({ ...environment, [name]: '' }), { name: 'TypeError', message: new RegExp(name) });
  }
  assert.throws(() => legacyConfigFromEnvironment({ ...environment, MOTAI_LEGACY_FROM: '200' }), TypeError);
  assert.throws(() => legacyConfigFromEnvironment({ ...environment, MOTAI_LEGACY_TO: 'abc' }), TypeError);
  assert.throws(() => new LegacyBackfill({ directory: '/x', sourceInstanceId: 'bad id!', client: {}, from: 1, to: 2 }), { code: 'legacy_invalid_instance' });
});

test('createApp refuses to start in gateway mode when the legacy variables are incomplete', async (t) => {
  const { control, projection } = await setup(t);
  process.env.MOTAI_LEGACY_NEWAPI_BASE_URL = 'http://old.invalid';
  t.after(() => { delete process.env.MOTAI_LEGACY_NEWAPI_BASE_URL; });
  assert.throws(() => createApp({ gatewayControl: control, gatewayProjection: projection }), { name: 'TypeError', message: /MOTAI_LEGACY_NEWAPI_ADMIN_TOKEN/ });
});

test('without legacy import the overview is identical to the plain gateway overview', async (t) => {
  const { control, projection, costStore } = await setup(t);
  const plain = new GatewayPanel({ control, projection, costStore, now: () => now }).overview(new URLSearchParams());
  const disabled = new GatewayPanel({ control, projection, costStore, legacy: null, now: () => now }).overview(new URLSearchParams());
  assert.deepEqual(disabled, plain);
  assert.deepEqual(plain.source, { mode: 'gateway' });
});

async function panels(t, options = {}) {
  const { directory, control, projection, costStore } = await setup(t);
  if (options.rules) await costStore.save([...costStore.list(), ...options.rules]);
  const base = new GatewayPanel({ control, projection, costStore, now: () => now }).overview(new URLSearchParams());
  const { backfill, client } = await backfilled(t, directory, options.source);
  await backfill.start();
  const legacy = new LegacyOverview({ importer: backfill.importer, from: FROM, to: SWITCH, priceStore: options.prices ?? legacyPrices(), costStore });
  const merged = new GatewayPanel({ control, projection, costStore, legacy, now: () => now }).overview(new URLSearchParams());
  return { base, merged, backfill, client, legacy, directory, control, projection, costStore };
}

test('a period crossing the switch adds old buckets to the new projection for totals', async (t) => {
  const { base, merged, backfill } = await panels(t);
  assert.equal(backfill.status().complete, true);
  const delta = (key) => merged.metrics[key] - base.metrics[key];
  assert.deepEqual([delta('totalRequests'), delta('requests'), delta('failedRequests'), delta('errorCount')], [5, 4, 1, 1]);
  assert.deepEqual([delta('inputTokens'), delta('outputTokens'), delta('cacheReadTokens'), delta('totalTokens')], [240, 44, 10, 294]);
  assert.deepEqual(merged.source.legacy, { from: new Date(FROM * 1000).toISOString(), to: new Date(SWITCH * 1000).toISOString(),
    mergedFrom: new Date(FROM * 1000).toISOString(), mergedTo: new Date(SWITCH * 1000).toISOString(),
    coveredThrough: new Date(SWITCH * 1000).toISOString(), complete: true });
  assert.equal(merged.source.mode, 'gateway');
});

test('channels and models match by id; unconfigured legacy channels count only in totals', async (t) => {
  const { base, merged } = await panels(t);
  assert.equal(merged.channels.length, base.channels.length);
  assert.equal(merged.channels.some((row) => row.id === '999'), false);
  const channel = (view) => view.channels.find((row) => row.id === '1022');
  assert.equal(channel(merged).requests - channel(base).requests, 4);
  assert.equal(channel(merged).errorCount - channel(base).errorCount, 1);
  // 4 legacy requests on 1022 (A, B, C, E): total input 100 + 50 + 50 + 20, output 20 + 10 + 5 + 4.
  assert.equal(channel(merged).tokens - channel(base).tokens, 220 + 39);
  const model = (view, id) => view.models.find((row) => row.model === id);
  assert.equal(model(merged, MODEL).requests - (model(base, MODEL)?.requests ?? 0), 4);
  assert.equal(model(merged, 'other-model').requests, 1);
  assert.equal(model(merged, 'other-model').tokens, 24);
  // No vendor, no price: unknown, not zero.
  assert.equal(model(merged, 'other-model').officialCost, null);
  assert.equal(model(merged, 'other-model').costCoverage.unknown, 1);
});

test('hourly trends land in the right hour slots and merge with projection points', async (t) => {
  const { base, merged } = await panels(t);
  assert.equal(base.trend.length, 2, 'the probe-only hour draws no trend point');
  assert.deepEqual(merged.trend.map((row) => row.time), ['2026-10-25T17:00:00.000Z', '2026-10-25T20:00:00.000Z',
    ...base.trend.map((row) => row.time)]);
  const pick = (row) => [row.requests, row.input, row.output, row.cacheRead];
  assert.deepEqual(pick(merged.trend[0]), [4, 190, 39, 10]);
  assert.deepEqual(pick(merged.trend[1]), [1, 50, 5, 0]);
  assert.deepEqual(merged.trend.slice(2), base.trend);
  const trendOf = (id) => merged.channelTrends.find((row) => row.channelId === id).trend;
  assert.deepEqual(trendOf('1022').slice(0, 2).map(pick), [[3, 160, 34, 10], [1, 50, 5, 0]]);
  assert.deepEqual(trendOf('1022').slice(2), base.channelTrends.find((row) => row.channelId === '1022').trend);
});

test('priceable rows cost price x counts x multiplier; failed requests carry no cost (same as the old console)', async (t) => {
  const { base, merged } = await panels(t);
  // Failed requests (type 5) are not priced: 692e-6 is A+B (582e-6) plus the unconfigured channel's row (110e-6) only.
  closeTo(merged.metrics.officialCost - base.metrics.officialCost, 692e-6);
  closeTo(merged.metrics.estimatedCost - base.metrics.estimatedCost, 346e-6);
  const channel = (view) => view.channels.find((row) => row.id === '1022');
  closeTo(channel(merged).officialCost - channel(base).officialCost, 582e-6);
  // A, B and the unconfigured channel's row are priced; E (model not in config) is unknown and also lifts the lower-bound flag.
  assert.equal(merged.metrics.officialCostCoverage.complete - base.metrics.officialCostCoverage.complete, 3);
  assert.equal(merged.metrics.officialCostCoverage.unknown - base.metrics.officialCostCoverage.unknown, 1);
  assert.equal(merged.metrics.estimatedCostIsLowerBound, true);
});

test('an old row costs the multiplier in effect when it was made, in totals, channel rows and the filtered request total', async (t) => {
  // Rows A (T17+10, 400e-6) and B (T17+1200, 182e-6) are on channel 1022; its own rule of 0.1 starts between them. The global
  // rule (0.5) prices A and the unconfigured channel's row D (110e-6).
  const rules = [{ id: 'later', channelId: '1022', model: '*', multiplier: 0.1, effectiveFrom: T17 + 600, revision: 2 }];
  const { base, merged, control, projection, costStore, legacy } = await panels(t, { rules });
  closeTo(merged.metrics.estimatedCost - base.metrics.estimatedCost, 400e-6 * 0.5 + 182e-6 * 0.1 + 110e-6 * 0.5);
  const channel = (view) => view.channels.find((row) => row.id === '1022');
  closeTo(channel(merged).estimatedCost - channel(base).estimatedCost, 400e-6 * 0.5 + 182e-6 * 0.1);
  const panel = new GatewayPanel({ control, projection, costStore, legacy, now: () => now });
  const search = new URLSearchParams({ from: new Date(FROM * 1000).toISOString(), to: new Date(SWITCH * 1000).toISOString(), channel: '1022' });
  closeTo(panel.requestSummary(search).costs.find((row) => row.currency === 'USD').amount, 400e-6 * 0.5 + 182e-6 * 0.1);
});

const costOf = (result) => result.summaries.reduce((all, summary) => all + (summary.officialCost ?? 0), 0);
const coverageOf = (result) => result.summaries.reduce((all, summary) => {
  for (const key of ['complete', 'partial', 'unknown']) all[key] += summary.costCoverage[key];
  return all;
}, { complete: 0, partial: 0, unknown: 0 });

async function legacyFor(t, { prices, source, models: configured = models }) {
  const { directory, costStore } = await setup(t);
  const { backfill } = await backfilled(t, directory, source);
  await backfill.start();
  const legacy = new LegacyOverview({ importer: backfill.importer, from: FROM, to: SWITCH, priceStore: prices, costStore });
  return legacy.overview({ from: new Date(FROM * 1000).toISOString(), to: new Date(SWITCH * 1000).toISOString() }, HOUR, models);
}

test('tiered prices, missing prices, mid-bucket price changes and unknown counters are unknown, never zero', async (t) => {
  const priced = await legacyFor(t, { prices: legacyPrices() });
  assert.deepEqual(coverageOf(priced), { complete: 3, partial: 0, unknown: 1 });
  // The failed request is counted as an attempt but never enters the cost coverage.
  assert.equal(priced.summaries.reduce((all, summary) => all + summary.attempts, 0), 5);
  assert.equal(priced.summaries.filter((summary) => summary.meta.requestOutcome === 'failed')
    .every((summary) => summary.costCoverage.complete + summary.costCoverage.partial + summary.costCoverage.unknown === 0), true);
  // A request above the price's context limit has no tier to be priced in (every sample request is larger than 10 tokens).
  const tiered = await legacyFor(t, { prices: legacyPrices(() => record({ maxContextTokens: 10 })) });
  assert.deepEqual(coverageOf(tiered), { complete: 0, partial: 0, unknown: 4 });
  assert.equal(tiered.summaries.every((summary) => summary.officialCost === 0), true);
  const missing = await legacyFor(t, { prices: legacyPrices(() => null) });
  assert.deepEqual(coverageOf(missing), { complete: 0, partial: 0, unknown: 4 });
  // The rate changes half an hour into the 17:00 slot; every row is priced at its own time, so no row is lost to the change.
  const change = T17 + 1800;
  const changed = await legacyFor(t, { prices: legacyPrices((at) => at < change ? record({ effectiveTo: change })
    : record({ effectiveFrom: change, rates: { ...rates, input: 3 } })) });
  assert.deepEqual(coverageOf(changed), { complete: 3, partial: 0, unknown: 1 });
  assert.ok(costOf(changed) > costOf(priced), 'rows after the change cost more');
  // A change between two slots straddles no bucket, so it prices exactly like a constant price.
  const lateChange = await legacyFor(t, { prices: legacyPrices((at) => at < T17 + 7200 ? record({ effectiveTo: T17 + 7200 })
    : record({ effectiveFrom: T17 + 7200 })) });
  assert.deepEqual(coverageOf(lateChange), { complete: 3, partial: 0, unknown: 1 });
  // A row without a prompt count is unknown on its own; its neighbours in the same bucket stay priced.
  const source = rows();
  source[2].push(legacyRow(5, T17 + 60, { prompt_tokens: undefined }));
  const gap = await legacyFor(t, { prices: legacyPrices(), source });
  assert.deepEqual(coverageOf(gap), { complete: 3, partial: 0, unknown: 2 });
});

// Old OpenAI-style rows: prompt_tokens (cache included) and cache reads only, no usage_semantic and no cache write counts.
const oldRows = (first, second) => ({ 2: [
  legacyRow(1, T17 + 10, { prompt_tokens: first.prompt, completion_tokens: 20, other: { cache_tokens: first.read } }),
  legacyRow(2, T17 + 1200, { prompt_tokens: second.prompt, completion_tokens: 10, other: { cache_tokens: second.read } })] });

test('row prices equal the sum of priceUsage per row, each row choosing its own context tier', async (t) => {
  const ext = { model: 'claude-opus-5', family: 'anthropic', effectiveFrom: 0, effectiveTo: null, promptIncludesCache: false,
    maxContextTokens: 1_000_000, currency: 'USD', rates: { input: 10, cacheRead: 1, cacheWrite: 12.5, output: 50 } };
  const claude = new Map([['claude-opus-5', { id: 'claude-opus-5', vendor: 'anthropic' }]]);
  const anthropic = { usage_semantic: 'anthropic' };
  const source = { 2: [
    legacyRow(1, T17 + 10, { model_name: 'claude-opus-5', prompt_tokens: 1000, completion_tokens: 100, other: { ...anthropic, cache_tokens: 200, cache_creation_tokens: 50 } }),
    // Above the built-in 200k limit: only the synced 1M price can price this request.
    legacyRow(2, T17 + 1200, { model_name: 'claude-opus-5', prompt_tokens: 300_000, completion_tokens: 100, other: { ...anthropic, cache_tokens: 0, cache_creation_tokens: 0 } })] };
  const result = await legacyFor(t, { source, models: claude, prices: { resolve: () => ext } });
  const direct = (at, args) => priceUsage({ model: 'claude-opus-5', timestamp: at, family: 'anthropic', externalRecord: ext, ...args }).officialCost;
  const small = direct(T17 + 10, { inputTokens: 1000, outputTokens: 100, cacheReadTokens: 200, cacheCreateTokens: 50 });
  const large = direct(T17 + 1200, { inputTokens: 300_000, outputTokens: 100, cacheReadTokens: 0, cacheCreateTokens: 0 });
  closeTo(large, (300_000 * 10 + 100 * 50) / 1e6);
  closeTo(costOf(result), small + large);
  // The first row has no cache write TTL, so it is partial; the second is complete. Both share one bucket.
  assert.deepEqual(coverageOf(result), { complete: 1, partial: 1, unknown: 0 });
});

test('a request above the single price tier limit is unknown while its neighbours are priced', async (t) => {
  const result = await legacyFor(t, { prices: legacyPrices(() => record({ maxContextTokens: 60 })) });
  // A (prompt 100) is over the limit; B and the unconfigured channel's row fit; E has no vendor; the failed row is not priced.
  assert.deepEqual(coverageOf(result), { complete: 2, partial: 0, unknown: 2 });
  closeTo(costOf(result), (40 * 2 + 10 * 0.2 + 10 * 10 + 30 * 2 + 5 * 10) / 1e6);
});

test('cache handling follows promptIncludesCache; rows without cache writes are partial, never complete', async (t) => {
  const source = oldRows({ prompt: 100, read: 0 }, { prompt: 50, read: 10 });
  const included = await legacyFor(t, { source, prices: legacyPrices(() => record({ promptIncludesCache: true })) });
  assert.deepEqual(coverageOf(included), { complete: 0, partial: 2, unknown: 0 });
  closeTo(costOf(included), (140 * 2 + 10 * 0.2 + 30 * 10) / 1e6);
  const separate = await legacyFor(t, { source, prices: legacyPrices(() => record({ promptIncludesCache: false })) });
  assert.deepEqual(coverageOf(separate), { complete: 0, partial: 2, unknown: 0 });
  // The prompt count is the input as it is; the cache read is billed on top.
  closeTo(costOf(separate), (150 * 2 + 10 * 0.2 + 30 * 10) / 1e6);
  const exceeds = await legacyFor(t, { source: oldRows({ prompt: 5, read: 10 }, { prompt: 8, read: 10 }),
    prices: legacyPrices(() => record({ promptIncludesCache: true })) });
  assert.deepEqual(coverageOf(exceeds), { complete: 0, partial: 0, unknown: 2 });
  assert.equal(costOf(exceeds), 0);
});

test('a model missing from the config gets its vendor from the price table, aliases included', async (t) => {
  const store = new ModelPricingStore();
  const base = { effectiveFrom: 0, effectiveTo: null, maxContextTokens: null, currency: 'USD' };
  store.records = [
    { ...base, model: 'derived-model', family: 'openai', promptIncludesCache: true, rates: { input: 2, cacheRead: 0.2, output: 10 } },
    { ...base, model: 'claude-opus-5-5', family: 'anthropic', promptIncludesCache: false, rates: { input: 5, cacheRead: 0.5, cacheWrite: 6.25, output: 25 } },
    { ...base, model: 'dual', family: 'openai', promptIncludesCache: true, rates: { input: 1, cacheRead: 1, output: 1 } },
    { ...base, model: 'dual', family: 'anthropic', promptIncludesCache: false, rates: { input: 1, cacheRead: 1, cacheWrite: 1, output: 1 } }];
  const named = (id, model, prompt) => legacyRow(id, T17 + id, { model_name: model, prompt_tokens: prompt, completion_tokens: 100 });
  const source = { 2: [named(1, 'derived-model', 100), named(2, 'claude-opus-5.5', 1000), named(3, 'ghost', 10), named(4, 'dual', 10)] };
  const result = await legacyFor(t, { source, prices: store, models: new Map() });
  // 'ghost' has no price and 'dual' is priced by two families: both stay unknown.
  assert.deepEqual(coverageOf(result), { complete: 2, partial: 0, unknown: 2 });
  closeTo(costOf(result), (100 * 2 + 100 * 10 + 1000 * 5 + 100 * 25) / 1e6);
});

test('row prices are recomputed when the price table or cost rules change, not when only the import head moves', async (t) => {
  const { directory, costStore } = await setup(t);
  const { backfill } = await backfilled(t, directory);
  await backfill.start();
  let calls = 0;
  const prices = { snapshotHash: 'a', resolve: (model, at, family) => { calls += 1; return record({ model, family }); } };
  const legacy = new LegacyOverview({ importer: backfill.importer, from: FROM, to: SWITCH, priceStore: prices, costStore });
  const period = { from: new Date(FROM * 1000).toISOString(), to: new Date(SWITCH * 1000).toISOString() };
  const first = legacy.overview(period, HOUR, models);
  const cold = calls;
  assert.ok(cold > 0);
  legacy.overview(period, HOUR, models);
  assert.equal(calls, cold, 'unchanged inputs reuse the cached prices');
  prices.snapshotHash = 'b';
  legacy.overview(period, HOUR, models);
  assert.equal(calls, cold * 2, 'a new price snapshot reprices');
  costStore.version += 1;
  legacy.overview(period, HOUR, models);
  assert.equal(calls, cold * 3, 'a new cost version reprices');
  prices.records = [];
  legacy.overview(period, HOUR, models);
  assert.equal(calls, cold * 4, 'a replaced record list reprices');
  backfill.importer.checkpoint.head = 'f'.repeat(64);
  const again = legacy.overview(period, HOUR, models);
  assert.equal(calls, cold * 4, 'a new import head rebuilds the row index but keeps row prices');
  assert.deepEqual(again.summaries, first.summaries);
});

test('about 200k legacy rows price within seconds cold and faster once cached', async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'motai-legacy-perf-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const importer = new LegacyImport({ directory, sourceInstanceId: 'prod-1' });
  importer.loaded = true;
  const total = 200_000, span = 3 * 86_400, names = ['gpt-a', 'gpt-b', 'claude-opus-5', 'gpt-5.6-sol', 'x-synced', 'ghost'];
  for (let start = 0; start < total; start += 1000) {
    const chunk = [];
    for (let index = start; index < Math.min(total, start + 1000); index += 1) {
      chunk.push(normalizeLegacyRow({ id: index + 1, created_at: FROM + Math.floor(index * span / total), channel: 1000 + (index % 5),
        model_name: names[index % names.length], prompt_tokens: 100 + (index % 50), completion_tokens: 10 + (index % 7), quota: 0, use_time: 1,
        is_stream: true, other: { usage_semantic: index % 2 ? 'openai' : 'anthropic', cache_tokens: index % 11, cache_creation_tokens: index % 3 } },
      { sourceInstanceId: 'prod-1', type: 2 }));
    }
    importer.addRows(chunk);
  }
  const store = new ModelPricingStore();
  const base = { family: 'openai', effectiveFrom: 0, effectiveTo: null, promptIncludesCache: true, maxContextTokens: null, currency: 'USD',
    rates: { input: 2, cacheRead: 0.2, cacheWrite: 2.5, output: 10 } };
  store.records = ['gpt-a', 'gpt-b', 'x-synced'].map((model) => ({ ...base, model }));
  // The cache only skips per-row pricing; both runs still walk all 200k rows, so cold and cached wall-clock times differ by
  // noise-sized margins. Count price-store lookups instead: that is exactly the work the cache removes.
  const resolveLookups = store.resolve.bind(store);
  let lookups = 0;
  store.resolve = (...args) => { lookups += 1; return resolveLookups(...args); };
  const configured = new Map([['gpt-a', { vendor: 'openai' }], ['gpt-b', { vendor: 'openai' }], ['claude-opus-5', { vendor: 'anthropic' }]]);
  const legacy = new LegacyOverview({ importer, from: FROM, to: FROM + span, priceStore: store, costStore: null });
  const period = { from: new Date(FROM * 1000).toISOString(), to: new Date((FROM + span) * 1000).toISOString() };
  const run = () => { const began = performance.now(); const result = legacy.overview(period, HOUR, configured); return { result, ms: performance.now() - began }; };
  const cold = run(), coldLookups = lookups, hot = run(), hotLookups = lookups - coldLookups;
  t.diagnostic(`rows ${total}: cold ${cold.ms.toFixed(0)} ms (${coldLookups} price lookups), cached ${hot.ms.toFixed(0)} ms (${hotLookups} price lookups)`);
  const counted = cold.result.summaries.reduce((all, summary) => all + summary.costCoverage.complete + summary.costCoverage.partial + summary.costCoverage.unknown, 0);
  assert.equal(counted, total);
  assert.ok(cold.result.summaries.some((summary) => summary.costCoverage.unknown > 0) && costOf(cold.result) > 0);
  assert.equal(costOf(hot.result), costOf(cold.result));
  assert.ok(cold.ms < 5000, `cold overview took ${cold.ms} ms`);
  assert.ok(coldLookups > 0 && coldLookups <= total, `each row is priced at most once cold, got ${coldLookups} lookups for ${total} rows`);
  assert.equal(hotLookups, 0, 'the cached run must not price any row again');
});

test('restart resumes from the checkpoint without double counting, and a larger TO only fetches the new tail', async (t) => {
  const { directory } = await setup(t);
  const first = await backfilled(t, directory);
  await first.backfill.start();
  assert.equal(first.backfill.importer.report().records, 5);
  // Same range after a restart: nothing left to fetch.
  const again = await backfilled(t, directory);
  await again.backfill.start();
  assert.equal(again.client.calls.length, 0);
  assert.equal(again.backfill.importer.report().records, 5);
  // Larger TO plus one new row after the old end: only [SWITCH, newTo) is requested.
  const source = rows();
  source[2].push(legacyRow(6, SWITCH + 100));
  const wider = await backfilled(t, directory, source, { to: SWITCH + 3600 });
  await wider.backfill.start();
  assert.ok(wider.client.calls.length > 0);
  assert.equal(wider.client.calls.every((call) => call.start === SWITCH), true);
  assert.equal(wider.backfill.importer.report().records, 6);
  const status = wider.backfill.status();
  assert.deepEqual([status.complete, status.coveredSeconds, status.lastError], [true, SWITCH + 3600 - FROM, null]);
});

test('a failure mid-import records only an error code and the next run continues on the failed page', async (t) => {
  const { directory } = await setup(t);
  const source = { 2: Array.from({ length: 150 }, (_, index) => legacyRow(index + 1, T17 + index)), 5: [] };
  const broken = await backfilled(t, directory, source, { client: fakeClient(source, { failAt: 2 }), backoffMs: 60_000 });
  broken.backfill.start();
  await until(() => broken.backfill.status().lastError);
  assert.equal(broken.backfill.status().lastError, 'legacy_source_unavailable');
  assert.equal(broken.backfill.status().complete, false);
  await broken.backfill.stop();
  assert.equal(broken.backfill.importer.report().records, 100);
  const healthy = await backfilled(t, directory, source);
  await healthy.backfill.start();
  assert.deepEqual(healthy.client.calls[0], { type: 2, page: 2, start: FROM });
  assert.equal(healthy.backfill.importer.report().records, 150);
  assert.equal(healthy.backfill.status().complete, true);
});

test('a transient failure backs off and then completes; stop wakes a sleeping backoff and ends the loop', async (t) => {
  const { directory } = await setup(t);
  const inner = fakeClient(rows());
  let failures = 1;
  const flaky = { calls: inner.calls, requestLogPage: async (...args) => { if (failures-- > 0) throw new Error('offline'); return inner.requestLogPage(...args); } };
  const retry = await backfilled(t, directory, rows(), { client: flaky, backoffMs: 5 });
  await retry.backfill.start();
  assert.deepEqual([retry.backfill.status().complete, retry.backfill.status().lastError], [true, null]);
  assert.equal(retry.backfill.importer.report().records, 5);
  const offline = await backfilled(t, await mkdtemp(path.join(tmpdir(), 'motai-legacy-stop-')), rows(), {
    client: { calls: [], requestLogPage: async () => { throw new Error('offline'); } }, backoffMs: 3_600_000 });
  const running = offline.backfill.start();
  await until(() => offline.backfill.status().lastError);
  const started = Date.now();
  await offline.backfill.stop();
  await running;
  assert.ok(Date.now() - started < 2000);
  assert.equal(offline.backfill.running, null);
});

async function appFor(t, extra) {
  const { control, projection, costStore, priceStore } = await setup(t);
  const noop = { load: async () => {}, start: async () => {}, stop: async () => {}, flush: async () => {} };
  const app = createApp({ gatewayControl: control, gatewayProjection: projection, costStore, modelPricingStore: priceStore,
    newApiPricingSyncStore: noop, walletStore: { ...noop, publicState: () => null }, walletService: noop,
    channelHealthStore: { ...noop, probeIntervalMinutes: 10, channel: () => ({ recentProbes: [] }) }, logCacheStore: noop, ...extra });
  t.after(() => app.close());
  await app.start({ host: '127.0.0.1', port: 0 });
  return { app, origin: `http://127.0.0.1:${app.server.address().port}` };
}

test('healthz and overview report legacy progress with numbers and error codes only; app.close stops the import', async (t) => {
  const { directory } = await setup(t);
  const end = Math.floor(Date.now() / 1000) - 60, begin = end - 3000;
  const source = { 2: [legacyRow(1, begin + 10), legacyRow(2, begin + 20)], 5: [] };
  const legacyConfig = { baseUrl: 'http://old.invalid', adminToken: 'token', sourceInstanceId: 'prod-1',
    directory: path.join(directory, 'app-legacy'), from: begin, to: end, pageIntervalMs: 0, backoffMs: 5 };
  const { origin } = await appFor(t, { legacyConfig, legacyClient: fakeClient(source) });
  const health = await until(async () => { const body = await (await fetch(`${origin}/api/healthz`)).json(); return body.legacy?.complete && body; });
  assert.deepEqual(Object.keys(health.legacy).sort(), ['complete', 'coveredSeconds', 'enabled', 'from', 'lastError', 'to']);
  assert.deepEqual([health.legacy.enabled, health.legacy.coveredSeconds, health.legacy.lastError], [true, end - begin, null]);
  const overview = await (await fetch(`${origin}/api/overview?hours=24`)).json();
  assert.equal(overview.source.legacy.complete, true);
  assert.ok(overview.metrics.totalRequests >= 2);
  const plain = await appFor(t, { legacyConfig: null });
  assert.equal('legacy' in await (await fetch(`${plain.origin}/api/healthz`)).json(), false);
  assert.deepEqual((await (await fetch(`${plain.origin}/api/overview?hours=24`)).json()).source, { mode: 'gateway' });

  const failing = fakeClient(source, { failAt: 1 });
  const broken = await appFor(t, { legacyConfig: { ...legacyConfig, directory: path.join(directory, 'app-broken'), backoffMs: 3_600_000 }, legacyClient: failing });
  const body = await until(async () => { const value = await (await fetch(`${broken.origin}/api/healthz`)).json(); return value.legacy?.lastError && value; });
  assert.deepEqual([body.legacy.lastError, body.legacy.complete], ['legacy_source_unavailable', false]);
  await broken.app.close();
  const calls = failing.calls.length;
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(failing.calls.length, calls);
});
