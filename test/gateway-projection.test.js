import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { EVENT_PAGE_LIMIT, GatewayProjection, projectAttempt } from '../src/gateway/projection.js';
import { effectiveUsage, usageMetrics } from '../src/usage-metrics.js';
import { priceCanonical } from '../src/model-pricing.js';
import { compareUtc } from '../src/gateway/schema.js';
import { CostStore } from '../src/cost-store.js';

const sample = JSON.parse(await readFile(new URL('../contracts/fixtures/attempt-valid.json', import.meta.url), 'utf8'));
const usageVectors = JSON.parse(await readFile(new URL('../contracts/fixtures/usage-vectors.json', import.meta.url), 'utf8')).vectors;
const pricingVectors = JSON.parse(await readFile(new URL('../contracts/fixtures/pricing-vectors.json', import.meta.url), 'utf8'));
const price = { model: 'Model/Case-Sensitive', family: 'openai', effectiveFrom: 0, effectiveTo: null,
  maxContextTokens: null, currency: 'USD', rates: { input: 2, cacheRead: 0.2, cacheWrite: 3, cacheWrite1h: 4, cacheWriteUnknown: 5, output: 10 } };
const priceStore = { resolve: (model, timestamp, family) => price.model === model && price.family === family ? price : null,
  snapshot: () => ({ snapshotHash: 'initial-price-version' }) };
let multiplier = 0.3;
const costStore = { resolve: () => ({ id: 'current-rule', revision: 1, multiplier }) };

function attempt(at = '2026-10-25T16:00:00Z', usage = sample.terminal.usage, extra = {}) {
  const value = structuredClone(sample);
  value.intent.request_id = randomUUID();
  value.intent.attempt_id = randomUUID();
  value.intent.started_at = at;
  Object.assign(value.intent, extra);
  value.terminal.attempt_id = value.intent.attempt_id;
  value.terminal.ended_at = new Date(Date.parse(at) + 1000).toISOString();
  value.terminal.usage = structuredClone(usage);
  return value;
}
const event = (seq, value = attempt()) => ({ format_version: 1, seq: String(seq), event_type: 'attempt_terminal', attempt: value });
const page = (events, latest = events.at(-1)?.seq ?? '0', after = '0') => ({ format_version: 1, events,
  next_seq: events.at(-1)?.seq ?? after, latest_seq: String(latest), has_more: BigInt(events.at(-1)?.seq ?? after) < BigInt(latest) });
function source(events) {
  const calls = [];
  return { calls, async events(query) {
    calls.push(query);
    const remaining = events.filter((item) => BigInt(item.seq) > BigInt(query.after_seq));
    return page(remaining.slice(0, query.limit), events.at(-1)?.seq ?? '0', query.after_seq);
  } };
}
async function sandbox(t) {
  const directory = await mkdtemp(path.join(tmpdir(), 'motai-projection-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}
const range = { from: '2026-10-25T00:00:00Z', to: '2026-10-27T00:00:00Z' };

test('attempt pricing and cache metrics share the canonical vector source', () => {
  for (const vector of usageVectors) {
    const item = attempt('2026-10-25T16:00:00Z', vector.expected, { vendor: vector.provider });
    const result = projectAttempt(item, { priceStore, costStore });
    const expected = priceCanonical({ model: item.intent.model_canonical, timestamp: Date.parse(item.intent.started_at) / 1000,
      family: vector.provider, usage: effectiveUsage(vector.expected), externalRecord: priceStore.resolve(item.intent.model_canonical, 0, vector.provider) });
    assert.equal(result.officialCost, expected.officialCost, vector.id);
    assert.equal(result.priceStatus, expected.status, vector.id);
    const metrics = usageMetrics([effectiveUsage(vector.expected)]);
    assert.equal(result.cacheInput, metrics.cacheKnownInput, vector.id);
    assert.equal(result.cacheRead, metrics.cacheKnownRead, vector.id);
  }
});

test('each attempt is priced with the multiplier in effect when it was made, whole days, split days and partial days alike', async (t) => {
  const sec = (iso) => Date.parse(iso) / 1000;
  const channel = sample.intent.channel_id;
  // Shanghai 10-25 (UTC 10-24T16:00 to 10-25T16:00) holds the change from 0.12 to 0.01; Shanghai 10-26 has 0.01 throughout.
  const list = ['2026-10-25T01:00:00Z', '2026-10-25T05:00:00Z', '2026-10-26T06:00:00Z'].map((at) => attempt(at));
  for (const rowRetentionDays of [8, 1]) {
    const directory = await sandbox(t);
    const costs = new CostStore(path.join(directory, 'costs.json'));
    await costs.save([
      { id: 'global', channelId: '*', model: '*', multiplier: 0.3, effectiveFrom: 0 },
      { id: 'old', channelId: channel, model: '*', multiplier: 0.12, effectiveFrom: sec('2026-10-01T00:00:00Z'), revision: 1 },
      { id: 'new', channelId: channel, model: '*', multiplier: 0.01, effectiveFrom: sec('2026-10-25T03:00:00Z'), revision: 2 },
    ], { expectedVersion: 0 });
    const projection = new GatewayProjection({ directory, client: source(list.map((value, index) => event(index + 1, value))),
      priceStore, costStore: costs, rowRetentionDays });
    await projection.catchUp();
    const label = `retention ${rowRetentionDays} day(s)`;
    assert.deepEqual(list.map((value) => projection.detail(value).procurement.multiplier), [0.12, 0.01, 0.01], label);
    const whole = { from: '2026-10-24T16:00:00Z', to: '2026-10-26T16:00:00Z' };
    const overview = projection.overview(whole);
    const unit = overview.currencies[0].officialCost / 3;
    assert.ok(unit > 0, label);
    const near = (actual, expected, message) => assert.ok(Math.abs(actual - expected) < 1e-12, `${message}: ${actual} != ${expected} (${label})`);
    near(overview.currencies[0].procurementCost, 0.14 * unit, 'overview');
    assert.deepEqual(overview.procurementCoverage, { complete: 3, partial: 0, unknown: 0 }, label);
    assert.deepEqual(overview.currencies[0].ruleVersions.sort(), ['new:2', 'old:1'], label);
    near(projection.requestTotals(whole).costs[0].amount, 0.14 * unit, 'request totals');
    const days = projection.timeline(whole, 86_400_000);
    near(days[0].currencies[0].procurementCost, 0.13 * unit, 'split day');
    near(days[1].currencies[0].procurementCost, 0.01 * unit, 'constant day');
    near(projection.overview({ from: '2026-10-25T04:00:00Z', to: '2026-10-26T12:00:00Z' }).currencies[0].procurementCost, 0.02 * unit, 'partial days');
    const window = projection.readWindow(whole, 86_400_000, ['channelId']);
    near(projection.summarize(window.summaries, whole).currencies[0].procurementCost, 0.14 * unit, 'window totals');
  }
});

test('durable contribution pricing does not resolve procurement rules; reads resolve them', async (t) => {
  const directory = await sandbox(t); let resolves = 0;
  const currentCosts = { resolve() { resolves++; return { id: 'current', revision: 1, multiplier: 0.5 }; } };
  const projection = new GatewayProjection({ directory, client: source([event(1)]), priceStore, costStore: currentCosts });
  await projection.catchUp();
  assert.equal(resolves, 0);
  const summary = projection.overview(range);
  assert.ok(resolves > 0);
  assert.equal(summary.currencies[0].procurementCost, summary.currencies[0].officialCost * 0.5);
  const persisted = await readFile(path.join(projection.generationPath(), projection.segments[0].file), 'utf8');
  assert.equal(persisted.includes('procurement'), false);
});

test('catch-up uses the bounded contract event page size', async (t) => {
  const directory = await sandbox(t), client = source([event(1)]);
  const projection = new GatewayProjection({ directory, client });
  await projection.catchUp();
  assert.equal(EVENT_PAGE_LIMIT, 2000);
  assert.equal(client.calls[0].limit, EVENT_PAGE_LIMIT);
});

test('page commit syncs the generation directory once after segment and checkpoint renames', async (t) => {
  const directory = await sandbox(t), syncs = [];
  const events = [event(1), event(2)];
  const client = { async events({ after_seq }) {
    const item = events.find((row) => BigInt(row.seq) > BigInt(after_seq));
    const latest = '2';
    return { format_version: 1, events: item ? [item] : [], next_seq: item?.seq ?? after_seq,
      latest_seq: latest, has_more: item ? item.seq !== latest : false };
  } };
  const directorySync = async (target) => { syncs.push(target); };
  const projection = new GatewayProjection({ directory, client, directorySync });
  await projection.catchUp();
  assert.deepEqual(syncs, [projection.generationPath(), directory, projection.generationPath()]);
  assert.equal(projection.lastSeq, '2');
  const checkpoint = JSON.parse(await readFile(projection.checkpointPath(), 'utf8'));
  assert.equal(checkpoint.lastSeq, '2');
  assert.equal(checkpoint.segments.length, 2);
});

test('generation directory sync failure leaves the rebuild generation unpublished', async (t) => {
  const directory = await sandbox(t);
  const projection = new GatewayProjection({ directory, client: source([event(1)]),
    directorySync: async () => { throw new Error('directory_sync_failed'); } });
  await assert.rejects(projection.catchUp(), (error) => error.code === 'projection_catch_up_failed');
  assert.equal(projection.lastError, 'projection_catch_up_failed');
  assert.equal(projection.lastSeq, '0');
  assert.deepEqual(projection.segments, []);
  await assert.rejects(readFile(path.join(directory, 'current.json')), { code: 'ENOENT' });
});

test('shared pricing vectors assert explicit amounts, TTL, context boundaries and price-independent hit rates', () => {
  for (const vector of pricingVectors.vectors) {
    const usage = usageVectors.find((item) => item.id === vector.usage_vector_id).expected;
    const priced = priceCanonical({ model: 'contract-model', timestamp: pricingVectors.timestamp,
      family: usage.provider, usage, externalRecord: vector.record });
    assert.equal(priced.status, vector.expected.status, vector.id);
    if (vector.expected.official_cost === null) assert.equal(priced.officialCost, null, vector.id);
    else assert.ok(Math.abs(priced.officialCost - vector.expected.official_cost) < 1e-15, vector.id);
    const metrics = usageMetrics([usage]);
    assert.equal(metrics.cacheKnownInput, vector.expected.cache_input, vector.id);
    assert.equal(metrics.cacheKnownRead, vector.expected.cache_read, vector.id);
    assert.equal(metrics.cacheHitRate, vector.expected.cache_hit_rate, vector.id);
  }
});

test('incremental segments, a small atomic checkpoint, restart and current multiplier', async (t) => {
  const directory = await sandbox(t);
  const events = [event(1), event(2)];
  const client = source(events);
  const projection = new GatewayProjection({ directory, client, priceStore, costStore });
  await projection.catchUp();
  const first = projection.overview(range);
  assert.equal(first.attempts, 2);
  assert.equal(first.totals.totalInput, 200);
  assert.equal(first.cacheHitRate, 0.4);
  assert.equal(first.currencies.length, 1);
  assert.equal(first.currencies[0].procurementCost, first.currencies[0].officialCost * multiplier);
  const firstSegment = projection.segments[0];
  const firstBytes = await readFile(path.join(projection.generationPath(), firstSegment.file), 'utf8');
  assert.equal(firstBytes.includes('provider_counts'), false);
  assert.equal(firstBytes.includes('credential'), false);
  assert.equal(firstBytes.includes('CANARY_BODY'), false);
  events.push(event(3));
  await projection.catchUp();
  assert.equal(await readFile(path.join(projection.generationPath(), firstSegment.file), 'utf8'), firstBytes);
  assert.equal(projection.segments.length, 2);
  const checkpoint = JSON.parse(await readFile(projection.checkpointPath(), 'utf8'));
  assert.equal(checkpoint.lastSeq, '3');
  assert.equal(checkpoint.segments.length, 2);
  assert.equal(JSON.stringify(checkpoint).includes('tokens'), false);
  const restartedClient = source(events);
  const restarted = new GatewayProjection({ directory, client: restartedClient, priceStore, costStore });
  await restarted.load();
  assert.equal(restartedClient.calls.length, 0, 'load restores local segments without model/log HTTP');
  assert.equal(restarted.overview(range).attempts, 3);
  await restarted.catchUp();
  assert.equal(restartedClient.calls[0].after_seq, '3');
  multiplier = 0.7;
  assert.equal(restarted.overview(range).currencies[0].procurementCost,
    restarted.overview(range).currencies[0].officialCost * multiplier);
  multiplier = 0.3;
});

test('Shanghai days and partial minutes preserve exact nanosecond half-open boundaries', async (t) => {
  const directory = await sandbox(t);
  const times = ['2026-10-25T15:59:59.999999999Z', '2026-10-25T16:00:00Z', '2026-10-25T16:00:00.000000001Z',
    '2026-10-25T16:00:59Z', '2026-10-25T16:01:00Z', '2026-10-26T16:00:00Z'];
  const events = times.map((time, index) => event(index + 1, attempt(time)));
  const projection = new GatewayProjection({ directory, client: source(events), priceStore });
  await projection.catchUp();
  assert.equal(projection.overview({ from: times[1], to: times[4] }).attempts, 3);
  assert.equal(projection.overview({ from: times[2], to: times[4] }).attempts, 2);
  assert.equal(projection.overview({ from: times[1], to: times[2] }).attempts, 1);
  assert.equal(projection.overview({ from: '2026-10-25T16:00:00Z', to: '2026-10-26T16:00:00Z' }).attempts, 4);
  assert.equal(projection.overview({ from: '2026-10-25T15:59:59Z', to: '2026-10-26T15:59:59Z' }).attempts, 5);
});

test('filters, model/probe success and currencies stay separate', async (t) => {
  const directory = await sandbox(t);
  const usd = attempt();
  const eur = attempt(undefined, undefined, { model_canonical: 'EUR-Model', kind: 'probe', channel_id: 'uuid-channel' });
  const eurPrice = { ...price, model: 'EUR-Model', currency: 'EUR' };
  const prices = { resolve: (model) => model === 'EUR-Model' ? eurPrice : price, snapshot: priceStore.snapshot };
  const projection = new GatewayProjection({ directory, client: source([event(1, usd), event(2, eur)]), priceStore: prices });
  await projection.catchUp();
  const all = projection.overview(range);
  assert.equal(all.attempts, 2);
  assert.equal(all.requests, 1);
  assert.equal(all.probes, 1);
  assert.equal(all.requestsSucceeded, 1);
  assert.equal(all.probesSucceeded, 1);
  assert.deepEqual(all.currencies.map((item) => item.currency).sort(), ['EUR', 'USD']);
  assert.equal(projection.overview({ ...range, source: 'old' }).attempts, 0);
  assert.equal(projection.overview({ ...range, channelId: 'uuid-channel' }).attempts, 1);
  assert.equal(projection.overview({ ...range, kind: 'probe', modelId: 'EUR-Model' }).attempts, 1);
  assert.equal(projection.overview({ ...range, outcomes: ['stream_broken'] }).attempts, 0);
});

test('late probe commits retain stable bounded history after restart and grouped timelines match channel reads', async (t) => {
  const directory = await sandbox(t);
  const values = Array.from({ length: 140 }, (_, index) => attempt(
    new Date(Date.parse('2026-10-25T16:00:00Z') + Math.floor(index / 2) * 1000).toISOString(),
    undefined, { kind: 'probe', channel_id: 'probe-channel' }));
  const events = values.toReversed().map((value, index) => event(index + 1, value));
  const client = source(events);
  const projection = new GatewayProjection({ directory, client, priceStore });
  await projection.catchUp();
  const query = { from: '2026-10-25T16:00:00.000000001Z', to: '2026-10-25T16:01:09Z' };
  const expected = values.filter(({ intent }) => compareUtc(intent.started_at, query.from) >= 0 && compareUtc(intent.started_at, query.to) < 0)
    .sort((left, right) => compareUtc(left.intent.started_at, right.intent.started_at)
      || left.intent.attempt_id.localeCompare(right.intent.attempt_id)).slice(-60).map(({ intent }) => intent.attempt_id);
  for (const current of [projection, new GatewayProjection({ directory, client, priceStore })]) {
    await current.load();
    assert.deepEqual(current.recentProbes({ ...query, channelId: 'probe-channel' }).map((row) => row.attemptId), expected);
    const grouped = current.timeline(query, 3_600_000, ['channelId']);
    const channel = current.timeline({ ...query, channelId: 'probe-channel' }, 3_600_000);
    assert.deepEqual(grouped.map(({ time, attempts, totals, currencies }) => ({ time, attempts, totals, currencies })),
      channel.map(({ time, attempts, totals, currencies }) => ({ time, attempts, totals, currencies })));
    assert.equal(grouped[0].channelId, 'probe-channel');
  }
});

test('concurrent catch-up shares one job and unknown contracts never advance checkpoint', async (t) => {
  const directory = await sandbox(t);
  const events = [event(1)];
  const client = source(events);
  const projection = new GatewayProjection({ directory, client, priceStore });
  const one = projection.catchUp(), two = projection.catchUp();
  assert.equal(one, two);
  await one;
  assert.equal(client.calls.length, 1);
  const invalid = event(2);
  invalid.attempt.terminal.usage.normalizer_version = 'future';
  events.push(invalid);
  await assert.rejects(projection.catchUp());
  assert.equal(projection.state().projectedSeq, '1');
  assert.equal(projection.overview(range).attempts, 1);
  assert.equal(projection.state().stale, true);
  const checkpoint = JSON.parse(await readFile(projection.checkpointPath(), 'utf8'));
  assert.equal(checkpoint.lastSeq, '1');
});

test('window totals reuse chart buckets without changing exact boundaries, grouping or currencies', async (t) => {
  const directory = await sandbox(t);
  const times = ['2026-10-25T15:59:59.999999999Z', '2026-10-25T16:00:00Z',
    '2026-10-25T16:00:00.000000001Z', '2026-10-25T17:00:00Z', '2026-10-26T16:00:00Z'];
  const events = times.map((time, index) => event(index + 1, attempt(time, sample.terminal.usage,
    { channel_id: `channel-${index % 2}` })));
  // staleMs is now() minus asOf; with the wall clock, state() and overview() read it a millisecond apart and the deep-equal flaked.
  const projection = new GatewayProjection({ directory, client: source(events), priceStore, costStore, now: () => Date.parse('2026-10-29T07:36:17.949Z') });
  await projection.catchUp();
  const query = { from: times[1], to: times[4] }, state = projection.state();
  const expected = projection.overview(query);
  for (const bucketMs of [3_600_000, 86_400_000]) {
    const window = projection.readWindow(query, bucketMs, ['channelId'], { state, includeTotal: true });
    const actual = projection.summarize(window.summaries, query, state);
    assert.deepEqual(actual, expected);
    assert.deepEqual(window.timeline, projection.timeline(query, bucketMs, ['channelId'], { state, includeTotal: true }));
  }
});

test('event contribution shortcut retains identity, usage-domain and terminal validation before publication', async (t) => {
  for (const corrupt of [
    (row) => { row.attempt.terminal.attempt_id = randomUUID(); },
    (row) => { row.attempt.terminal.usage.total_input.value += 1; },
    (row) => { row.attempt.terminal.usage.total_input.provenance = 'absent'; },
    (row) => { row.attempt.terminal.ttft_ms = row.attempt.terminal.duration_ms + 1; },
  ]) {
    const directory = await sandbox(t), bad = event(1); corrupt(bad);
    const projection = new GatewayProjection({ directory, client: source([bad]), priceStore });
    await assert.rejects(projection.catchUp(), { code: 'projection_invalid_event' });
    assert.equal(projection.lastSeq, '0');
    assert.equal(projection.overview(range).attempts, 0);
    await assert.rejects(readFile(path.join(directory, 'current.json')), { code: 'ENOENT' });
  }
});

test('bounded prefetch overlaps one read but commits pages in order and never publishes a failed read', async (t) => {
  const directory = await sandbox(t), events = [event(1), event(2)];
  let releaseCommit, secondRead;
  const readStarted = new Promise((resolve) => { secondRead = resolve; });
  const calls = [];
  const client = { async events(query) {
    calls.push(query.after_seq);
    if (query.after_seq === '0') return page([events[0]], '2');
    secondRead(); throw new Error('PRIVATE_READ_FAILED');
  } };
  const projection = new GatewayProjection({ directory, client, priceStore });
  const commit = projection.commitPage.bind(projection);
  projection.commitPage = async (value) => {
    await new Promise((resolve) => { releaseCommit = resolve; });
    return commit(value);
  };
  const pending = projection.catchUp(), rejected = assert.rejects(pending, { code: 'projection_catch_up_failed' });
  await readStarted;
  assert.deepEqual(calls, ['0', '1']); assert.equal(projection.lastSeq, '0');
  releaseCommit(); await rejected;
  assert.equal(projection.lastSeq, '1');
  const checkpoint = JSON.parse(await readFile(projection.checkpointPath(), 'utf8'));
  assert.equal(checkpoint.lastSeq, '1');
  assert.equal(projection.overview(range).attempts, 1);
});

test('prefetched invalid or failed pages cannot mask the current page commit failure', async (t) => {
  const directory = await sandbox(t), first = event(1);
  let calls = 0;
  const projection = new GatewayProjection({ directory, priceStore, client: { async events() {
    calls++;
    if (calls === 1) return page([first], '2');
    throw new Error('PRIVATE_PREFETCH_ERROR');
  } } });
  projection.commitPage = async () => { await new Promise((resolve) => setImmediate(resolve)); throw Object.assign(new Error('write'), { code: 'EIO' }); };
  await assert.rejects(projection.catchUp(), { code: 'EIO' });
  assert.equal(calls, 2); assert.equal(projection.lastSeq, '0');
  await assert.rejects(readFile(path.join(directory, 'current.json')), { code: 'ENOENT' });
});

test('sequence gaps, duplicates and contradictory terminal state fail without partial application', async (t) => {
  for (const mode of ['gap', 'duplicate', 'terminal']) {
    const directory = path.join(await sandbox(t), mode);
    const good = event(1), bad = event(mode === 'gap' ? 3 : 2);
    if (mode === 'duplicate') bad.attempt = good.attempt;
    if (mode === 'terminal') bad.attempt.terminal.protocol_terminal = 'failed';
    const projection = new GatewayProjection({ directory, client: { events: async () => page([good, bad]) }, priceStore });
    await assert.rejects(projection.catchUp());
    assert.equal(projection.state().projectedSeq, '0');
    assert.equal(projection.overview(range).attempts, 0);
  }
});

test('checkpoint failure keeps published in-memory state, retry ignores orphan page files', async (t) => {
  const directory = await sandbox(t);
  const events = [event(1)];
  const projection = new GatewayProjection({ directory, client: source(events), priceStore });
  await projection.catchUp();
  const checkpoint = await readFile(projection.checkpointPath(), 'utf8');
  await rm(projection.checkpointPath());
  await import('node:fs/promises').then(({ mkdir }) => mkdir(projection.checkpointPath()));
  events.push(event(2));
  await assert.rejects(projection.catchUp());
  assert.equal(projection.state().projectedSeq, '1');
  assert.equal(projection.overview(range).attempts, 1);
  await rm(projection.checkpointPath(), { recursive: true });
  await writeFile(projection.checkpointPath(), checkpoint);
  const restarted = new GatewayProjection({ directory, client: source(events), priceStore });
  await restarted.load();
  assert.equal(restarted.overview(range).attempts, 1);
  await restarted.catchUp();
  assert.equal(restarted.overview(range).attempts, 2);
  assert.equal((await readdir(restarted.generationPath())).filter((name) => name.startsWith('segment-')).length, 2);
});

test('pricing revisions require background rebuild and retain old overview during failure', async (t) => {
  const directory = await sandbox(t);
  let version = 'initial-price-version';
  const prices = { ...priceStore, snapshot: () => ({ snapshotHash: version }) };
  const events = [event(1)];
  const projection = new GatewayProjection({ directory, client: source(events), priceStore: prices });
  await projection.catchUp();
  const oldGeneration = projection.generation;
  version = 'new-price-version';
  assert.equal(projection.state().requiresRebuild, true);
  await assert.rejects(projection.catchUp(), /projection_price_version_changed/);
  assert.equal(projection.overview(range).attempts, 1);
  await projection.rebuild();
  assert.notEqual(projection.generation, oldGeneration);
  assert.equal(projection.state().requiresRebuild, false);
  assert.equal(projection.overview(range).attempts, 1);
  const restarted = new GatewayProjection({ directory, client: source(events), priceStore: prices });
  await restarted.load();
  assert.equal(restarted.generation, projection.generation);
  assert.equal(restarted.overview(range).attempts, 1);
});

test('empty initial stream is durably checkpointed and can be rebuilt', async (t) => {
  const directory = await sandbox(t);
  const projection = new GatewayProjection({ directory, client: source([]), priceStore });
  await projection.catchUp();
  assert.equal(projection.state().projectedSeq, '0');
  assert.notEqual(projection.state().asOf, null);
  await projection.rebuild();
  const restarted = new GatewayProjection({ directory, client: source([]), priceStore });
  await restarted.load();
  assert.equal(restarted.overview(range).attempts, 0);
});

test('an unknown event vendor is priced with the vendor configured for the model; known vendors are unchanged', () => {
  const grok = { ...price, model: 'grok-4.7', family: 'xai' };
  const grokPrices = { resolve: (model, at, family) => (model === grok.model && family === grok.family ? grok : null),
    snapshot: () => ({ snapshotHash: 'grok-prices' }) };
  const usage = sample.terminal.usage;
  const event = (vendor) => attempt('2026-10-25T16:00:00Z', usage, { vendor, model_canonical: 'grok-4.7' });
  const configured = (modelId) => (modelId === 'grok-4.7' ? 'xai' : null);
  const known = projectAttempt(event('xai'), { priceStore: grokPrices, costStore });
  assert.notEqual(known.officialCost, null);
  // Without the lookup (or with no configured vendor) the unknown-vendor event is unpriced, as before.
  for (const options of [{}, { modelVendor: () => null }]) {
    const unpriced = projectAttempt(event('unknown'), { priceStore: grokPrices, costStore, ...options });
    assert.equal(unpriced.priceStatus, 'unknown');
    assert.equal(unpriced.priceReason, 'model_not_priced');
    assert.equal(unpriced.officialCost, null);
  }
  const resolved = projectAttempt(event('unknown'), { priceStore: grokPrices, costStore, modelVendor: configured });
  assert.equal(resolved.officialCost, known.officialCost);
  assert.equal(resolved.priceStatus, known.priceStatus);
  assert.equal(resolved.priceVersion, known.priceVersion);
  assert.equal(resolved.vendor, 'unknown', 'the row keeps the event vendor; only the price lookup changes');
  // A vendor other than unknown never consults the lookup, even when the configuration names a different vendor.
  let calls = 0;
  const counting = (modelId) => { calls += 1; return configured(modelId); };
  const other = projectAttempt(event('openai'), { priceStore: grokPrices, costStore, modelVendor: counting });
  assert.equal(other.priceStatus, 'unknown');
  const same = projectAttempt(event('xai'), { priceStore: grokPrices, costStore, modelVendor: counting });
  assert.equal(same.officialCost, known.officialCost);
  assert.equal(calls, 0);
});

test('a calculation-version bump rebuilds an existing projection and re-prices unknown-vendor events', async (t) => {
  const directory = await sandbox(t);
  const events = [event(1, attempt('2026-10-25T16:00:00Z', sample.terminal.usage, { vendor: 'unknown' })), event(2)];
  const before = new GatewayProjection({ directory, client: source(events), priceStore, costStore });
  await before.catchUp();
  assert.equal(before.overview(range).costCoverage.unknown, 1);
  // Simulate the checkpoint written by the previous calculation version.
  const checkpointFile = before.checkpointPath();
  const checkpoint = JSON.parse(await readFile(checkpointFile, 'utf8'));
  checkpoint.calcVersion = '4';
  await writeFile(checkpointFile, JSON.stringify(checkpoint));
  const modelVendor = (modelId) => (modelId === 'Model/Case-Sensitive' ? 'openai' : null);
  const after = new GatewayProjection({ directory, client: source(events), priceStore, costStore, modelVendor });
  const state = await after.load();
  assert.equal(state.requiresRebuild, true, 'the old checkpoint is marked for a rebuild at startup');
  assert.equal(after.overview(range).costCoverage.unknown, 1, 'the old result is served until the rebuild finishes');
  await after.rebuild();
  assert.equal(after.state().requiresRebuild, false);
  assert.equal(after.overview(range).costCoverage.unknown, 0);
  assert.equal(after.overview(range).costCoverage.complete, 2);
  assert.equal(JSON.parse(await readFile(after.checkpointPath(), 'utf8')).calcVersion, '8');
});

test('the publisher answers the configured vendor of a model and follows a config change', async () => {
  const { ConfigPublisher } = await import('../src/gateway/config-publisher.js');
  const publisher = new ConfigPublisher({ directory: tmpdir(), client: {} });
  assert.equal(publisher.modelVendor('grok-4.7'), null, 'no config loaded yet');
  publisher.current = { config: { models: [{ id: 'grok-4.7', vendor: 'xai' }, { id: 'plain' }] } };
  assert.equal(publisher.modelVendor('grok-4.7'), 'xai');
  assert.equal(publisher.modelVendor('plain'), null);
  assert.equal(publisher.modelVendor('missing'), null);
  publisher.current = { config: { models: [{ id: 'grok-4.7', vendor: 'openai' }] } };
  assert.equal(publisher.modelVendor('grok-4.7'), 'openai');
});

test('summarize counts the attempts that tripped a cooldown, not plain failures, successes or probes, and a restart keeps them', async (t) => {
  const directory = await sandbox(t);
  const failed = (at, effect, extra = {}) => {
    const value = attempt(at, sample.terminal.usage, extra);
    Object.assign(value.terminal, { request_outcome: 'failed', attempt_outcome: 'upstream_failed', upstream_status: 524,
      error_class: 'upstream_5xx', channel_effect: effect });
    return value;
  };
  const events = [event(1, failed('2026-10-25T16:00:00Z', 'cooldown')), event(2, failed('2026-10-25T16:01:00Z', 'failure_counted')),
    event(3, attempt('2026-10-25T16:02:00Z')), event(4, failed('2026-10-25T16:03:00Z', 'cooldown', { kind: 'probe' })),
    event(5, failed('2026-10-26T01:00:00Z', 'cooldown'))];
  const projection = new GatewayProjection({ directory, client: source(events), priceStore, costStore });
  await projection.catchUp();
  const summary = projection.overview(range);
  assert.equal(summary.cooldowns, 2);
  assert.equal(summary.requests, 4);
  assert.equal(projection.overview({ from: '2026-10-25T16:00:00Z', to: '2026-10-25T16:02:00Z' }).cooldowns, 1, 'partial day read from the attempts');
  assert.equal(projection.overview({ ...range, channelId: sample.intent.channel_id, outcomes: ['succeeded'] }).cooldowns, 0, 'outcome filters still apply');
  const channels = projection.breakdown(range, ['channelId']);
  assert.equal(channels.reduce((sum, row) => sum + row.cooldowns, 0), 2);
  const restored = new GatewayProjection({ directory, client: source(events), priceStore, costStore });
  await restored.load();
  assert.equal(restored.state().requiresRebuild, false);
  assert.equal(restored.overview(range).cooldowns, 2);
});

test('an attempt whose upstream sent no cache figures is costed as all-uncached input and leaves the cache hit rate alone', async (t) => {
  const directory = await sandbox(t);
  const field = (value) => ({ value, availability: value === null ? 'absent' : 'known', completeness: 'final',
    provenance: value === null ? 'absent' : 'provider' });
  const promptOnly = { ...sample.terminal.usage, total_input: field(47057), input_uncached: field(null), cache_read: field(null),
    output_total: field(2721), reasoning: field(null), issues: ['cache_read_missing'] };
  const projected = projectAttempt(attempt('2026-10-25T16:00:00Z', promptOnly), { priceStore, costStore });
  assert.equal(projected.officialCost, (47057 * 2 + 2721 * 10) / 1_000_000);
  assert.equal(projected.priceStatus, 'partial');
  assert.match(projected.priceReason, /input_uncached_estimated/);
  assert.equal(projected.tokens[1], 47057, 'inputUncached');
  assert.equal(projected.cacheCount, 0);
  const events = [event(1, attempt('2026-10-25T16:00:00Z', promptOnly)), event(2, attempt('2026-10-25T16:01:00Z'))];
  const projection = new GatewayProjection({ directory, client: source(events), priceStore, costStore });
  await projection.catchUp();
  const summary = projection.overview(range);
  assert.equal(summary.totals.inputUncached, 47057 + 60);
  assert.equal(summary.coverage.inputUncached.estimated, 1);
  assert.equal(summary.cacheKnownRequests, 1);
  assert.equal(summary.cacheHitRate, 0.4, 'only the request with a real cache figure counts');
});
