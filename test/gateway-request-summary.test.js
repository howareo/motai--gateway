import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { GatewayPanel } from '../src/gateway/panel.js';
import { GatewayProjection } from '../src/gateway/projection.js';
import { ConfigPublisher } from '../src/gateway/config-publisher.js';
import { LegacyOverview } from '../src/gateway/legacy-overview.js';
import { LegacyImport, normalizeLegacyRow } from '../src/gateway/legacy-import.js';

const fixture = async (name) => JSON.parse(await readFile(new URL(`../contracts/fixtures/${name}.json`, import.meta.url), 'utf8'));
const sample = await fixture('attempt-valid');
const baseConfig = await fixture('config-valid');
const credentials = await fixture('credentials-valid');
const sec = (iso) => Date.parse(iso) / 1000;
const NOW = Date.parse('2026-10-28T12:00:00Z');
const FROM = sec('2026-10-20T00:00:00Z'), TO = sec('2026-10-28T10:00:00Z');
const FULL = 'Model/Case-Sensitive', PARTIAL = 'partial-model', EURO = 'euro-model', UNPRICED = 'unpriced-model';

const rates = { input: 2, cacheRead: 0.2, cacheWrite: 3, cacheWrite1h: 4, cacheWriteUnknown: 5, output: 10 };
const records = { [FULL]: { currency: 'USD', rates }, [PARTIAL]: { currency: 'USD', rates: { ...rates, input: null } },
  [EURO]: { currency: 'EUR', rates } };
const prices = { snapshot: () => ({ snapshotHash: 's' }), load: async () => {}, resolve: (model, at, family) => records[model]
  ? { model, family, effectiveFrom: 0, effectiveTo: null, maxContextTokens: null, promptIncludesCache: true, ...records[model] } : null };
const MULTIPLIERS = { 1022: 0.5, 1023: 0.25, 1024: null };
const costStore = { version: 1, resolve: ({ channelId }) => (MULTIPLIERS[channelId] == null ? null : { id: `rule-${channelId}`, revision: 1, multiplier: MULTIPLIERS[channelId] }) };

const config = structuredClone(baseConfig);
config.models = [FULL, PARTIAL, EURO, UNPRICED].map((id) => ({ id, vendor: 'openai' }));
config.pools = [{ id: 'pool-main', name: 'Main' }, { id: 'pool-two', name: 'Two' }];
config.channels = ['1022', '1023', '1024'].map((id, index) => ({ ...structuredClone(baseConfig.channels[0]), id, name: `Channel ${id}`,
  pool_id: index === 1 ? 'pool-two' : 'pool-main', models: config.models.map((model) => ({ model_id: model.id, upstream_model: model.id, capabilities: ['responses'] })) }));
config.aliases = [];
config.callers[0].permissions[0].model_ids = config.models.map((model) => model.id);
config.callers[0].permissions[0].channel_ids = config.channels.map((channel) => channel.id);

function gatewayAttempt(index) {
  const value = structuredClone(sample);
  const at = Date.parse('2026-10-20T01:00:00Z') + index * 5_400_000;
  const channel = config.channels[index % 3];
  Object.assign(value.intent, { request_id: randomUUID(), attempt_id: randomUUID(), channel_id: channel.id, pool_id: channel.pool_id,
    model_canonical: [FULL, FULL, PARTIAL, EURO, UNPRICED][index % 5], started_at: new Date(at).toISOString().replace('.000Z', '.123456789Z'),
    stream: index % 4 !== 0 });
  value.terminal.attempt_id = value.intent.attempt_id;
  value.terminal.ended_at = new Date(at + 1000).toISOString().replace('.000Z', 'Z');
  if (index % 6 === 5) Object.assign(value.terminal, { request_outcome: 'failed', attempt_outcome: 'upstream_failed', upstream_status: 524,
    error_class: 'upstream_5xx', channel_effect: 'failure_counted' });
  return value;
}
const GATEWAY = Array.from({ length: 90 }, (_, index) => gatewayAttempt(index));

const legacyRow = (id, extra = {}) => ({ id, created_at: sec('2026-10-20T00:30:00Z') + id * 4000, channel: [1022, 1023, 1024][id % 3],
  model_name: [FULL, PARTIAL, EURO, UNPRICED][id % 4], prompt_tokens: 1000, completion_tokens: 50, quota: 0, use_time: 2, is_stream: id % 2 === 0,
  other: { usage_semantic: 'openai', cache_tokens: 100, cache_creation_tokens: 0 }, ...extra });
const LEGACY = { 2: Array.from({ length: 60 }, (_, index) => legacyRow(index + 1)), 5: Array.from({ length: 12 }, (_, index) => legacyRow(index + 101)) };

function fakeClient() {
  return { events: async (query) => {
      const after = Number(query.after_seq), events = GATEWAY.slice(after, after + query.limit).map((attempt, offset) => ({ format_version: 1,
        seq: String(after + offset + 1), event_type: 'attempt_terminal', attempt }));
      const next = events.length ? events.at(-1).seq : String(after);
      return { format_version: 1, events, next_seq: next, latest_seq: String(GATEWAY.length), has_more: Number(next) < GATEWAY.length };
    },
    attempts: async (query) => {
      const at = (row) => Date.parse(row.intent.started_at.replace(/\.(\d{3})\d*Z$/, '.$1Z'));
      const list = GATEWAY.filter((row) => at(row) >= Date.parse(query.from) && at(row) < Date.parse(query.to)
        && (!query.channel_id || row.intent.channel_id === query.channel_id) && (!query.pool_id || row.intent.pool_id === query.pool_id)
        && (!query.model_id || row.intent.model_canonical === query.model_id)
        && (!query.outcomes.length || query.outcomes.includes(row.terminal.attempt_outcome))
        && (query.stream === null || row.intent.stream === query.stream)).sort((a, b) => at(b) - at(a));
      const offset = query.cursor ? Number(query.cursor) : 0, more = offset + query.limit < list.length;
      return { format_version: 1, attempts: list.slice(offset, offset + query.limit), snapshot_seq: '7', has_more: more, next_cursor: more ? String(offset + query.limit) : null };
    } };
}

async function setup(t, { legacy = true } = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), 'motai-summary-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const client = fakeClient();
  const projection = new GatewayProjection({ directory, client, priceStore: prices, costStore, now: () => NOW });
  await projection.catchUp();
  const publisher = new ConfigPublisher({ directory, client });
  publisher.current = { config, credentials, metadata: { testModels: {} } };
  const control = { config: () => publisher.snapshot(), client, publisher, load: async () => {}, status: async () => ({ ready: true }) };
  let overview = null;
  if (legacy) {
    const importer = new LegacyImport({ directory: path.join(directory, 'legacy'), sourceInstanceId: 'prod-1' });
    await importer.load();
    importer.addRows([...LEGACY[2].map((row) => normalizeLegacyRow(row, { sourceInstanceId: 'prod-1', type: 2 })),
      ...LEGACY[5].map((row) => normalizeLegacyRow(row, { sourceInstanceId: 'prod-1', type: 5 }))]);
    overview = new LegacyOverview({ importer, from: FROM, to: TO, priceStore: prices, costStore });
  }
  return { panel: new GatewayPanel({ control, projection, costStore, legacy: overview, now: () => NOW }) };
}

const params = (values = {}) => new URLSearchParams({ hours: '2160', limit: '17', ...values });
async function walk(panel, values) {
  const items = [];
  let first = null, cursor = null, pages = 0;
  do {
    const page = await panel.requests(params({ ...values, ...(cursor ? { cursor } : {}) }));
    if (!first) first = page;
    else assert.equal('summary' in page, false, 'only the first page carries a summary');
    items.push(...page.items);
    cursor = page.hasMore ? page.nextCursor : null;
    pages += 1;
    assert.ok(pages < 60);
  } while (cursor);
  return { first, items };
}
const close = (a, b) => Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(a), Math.abs(b));

function expected(items) {
  const costs = new Map(), coverage = { complete: 0, partial: 0, unknown: 0 };
  for (const item of items) {
    if (item.estimatedCost !== null) costs.set(item.currency, (costs.get(item.currency) ?? 0) + item.estimatedCost);
    if (item.kind === 'success') coverage[item.costStatus] += 1;
  }
  return { requests: items.length, costs, coverage };
}

const FILTERS = {
  none: {}, channel: { channel: '1022' }, 'channel without a multiplier': { channel: '1024' }, model: { model: FULL }, 'model in two currencies': { model: EURO },
  pool: { pool: 'pool-two' }, success: { status: 'success' }, error: { status: 'error' }, 'channel and model': { channel: '1023', model: PARTIAL },
  'model and success': { model: UNPRICED, status: 'success' }, 'pool, model and error': { pool: 'pool-main', model: FULL, status: 'error' },
  'explicit window': { from: '2026-10-22T00:00:00Z', to: '2026-10-25T06:30:00Z' }, 'window and channel': { from: '2026-10-22T00:00:00Z', to: '2026-10-25T06:30:00Z', channel: '1022' },
};

for (const withLegacy of [true, false]) {
  test(`summary equals the sum over every page of the filtered list (${withLegacy ? 'gateway and old history' : 'gateway only'})`, async (t) => {
    const { panel } = await setup(t, { legacy: withLegacy });
    let multiCurrency = false, lowerBound = 0, exact = 0;
    for (const [name, filter] of Object.entries(FILTERS)) {
      const { first, items } = await walk(panel, filter), want = expected(items), summary = first.summary;
      assert.ok(summary, `${name}: first page has a summary`);
      assert.equal(summary.requests, want.requests, `${name}: requests`);
      assert.deepEqual(summary.coverage, want.coverage, `${name}: coverage`);
      assert.deepEqual(summary.costs.map((entry) => entry.currency), [...want.costs.keys()].sort(), `${name}: currencies`);
      for (const entry of summary.costs) assert.ok(close(entry.amount, want.costs.get(entry.currency)), `${name}: ${entry.currency} ${entry.amount} vs ${want.costs.get(entry.currency)}`);
      assert.equal(summary.lowerBound, want.coverage.partial + want.coverage.unknown > 0, `${name}: lower bound`);
      if (summary.costs.length > 1) multiCurrency = true;
      if (summary.lowerBound) lowerBound += 1; else exact += 1;
    }
    assert.ok(multiCurrency, 'at least one filter spans two currencies');
    assert.ok(lowerBound > 0 && exact > 0, 'both exact and lower-bound totals are covered');
  });
}

test('failed rows change neither the coverage nor the lower bound, and unpriced successes do', async (t) => {
  const { panel } = await setup(t, { legacy: false });
  const failed = (await panel.requests(params({ status: 'error' }))).summary;
  assert.deepEqual(failed.coverage, { complete: 0, partial: 0, unknown: 0 });
  assert.equal(failed.lowerBound, false);
  assert.ok(failed.requests > 0);
  const full = (await panel.requests(params({ model: FULL, channel: '1022', status: 'success' }))).summary;
  assert.equal(full.lowerBound, false);
  assert.ok(full.coverage.complete > 0 && full.costs[0].amount > 0);
  const partial = (await panel.requests(params({ model: PARTIAL, channel: '1022', status: 'success' }))).summary;
  assert.equal(partial.lowerBound, true);
  assert.ok(partial.coverage.partial > 0);
});

test('the summary is left out of later pages, of stream-filtered requests and of an empty failover filter', async (t) => {
  const { panel } = await setup(t);
  const first = await panel.requests(params());
  assert.ok(first.summary && first.hasMore);
  assert.equal('summary' in await panel.requests(params({ cursor: first.nextCursor })), false);
  assert.equal('summary' in await panel.requests(params({ stream: 'stream' })), false);
  assert.equal('summary' in await panel.requests(params({ stream: 'nonstream' })), false);
  assert.equal('summary' in await panel.requests(params({ stream: 'failover' })), false);
});

test('a filter that matches nothing has an empty exact summary', async (t) => {
  const { panel } = await setup(t);
  const { summary } = await panel.requests(params({ channel: 'no-such-channel' }));
  assert.deepEqual(summary, { requests: 0, costs: [], lowerBound: false, coverage: { complete: 0, partial: 0, unknown: 0 } });
});
