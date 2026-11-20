import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { buildOverview, normalizeLog } from '../src/analytics.js';
import { GatewayPanel } from '../src/gateway/panel.js';
import { GatewayProjection } from '../src/gateway/projection.js';
import { ConfigPublisher } from '../src/gateway/config-publisher.js';
import { LegacyOverview } from '../src/gateway/legacy-overview.js';
import { LegacyImport, normalizeLegacyRow } from '../src/gateway/legacy-import.js';

// The old console (src/analytics.js, unchanged since f0c8733) is the reference: for the same old log rows, the token figures
// of every row and the totals / cache hit rate of the overview must come out the same from the imported history.
const fixture = async (name) => JSON.parse(await readFile(new URL(`../contracts/fixtures/${name}.json`, import.meta.url), 'utf8'));
const config = await fixture('config-valid');
const credentials = await fixture('credentials-valid');
const NOW = Date.parse('2026-10-28T12:30:00Z');
const AT = Date.parse('2026-10-28T10:00:00Z') / 1000;
const FROM = AT - 6 * 3600, TO = AT + 3600;

// [channel id, name, old channel type, gateway vendor, models]. Channel 99 is no longer configured.
const CHANNELS = [
  [1, 'Claude Relay', 'Anthropic', 'anthropic', ['claude-sonnet-5']],
  [2, 'Gemini Relay', 'Gemini', 'gemini', ['gemini-3.8-flash']],
  [3, 'DeepSeek Relay', 'DeepSeek', 'deepseek', ['deepseek-v4.1-flash']],
  [4, 'Grok Relay', 'xAI', 'xai', ['grok-4.7']],
  [5, 'GPT Relay', 'OpenAI', 'openai', ['gpt-5.6-sol', 'gpt-6.1-sol']],
];
const MODELS = CHANNELS.flatMap(([, , , vendor, models]) => models.map((id) => ({ id, vendor })));

// The synced price table: resolves a record for any model but one, as the real store does for the families it knows.
const priced = (model, family) => ({ model, family, effectiveFrom: 0, effectiveTo: null, maxContextTokens: null, currency: 'USD',
  promptIncludesCache: ['openai', 'xai', 'deepseek'].includes(family), rates: { input: 2, cacheRead: 0.2, cacheWrite: 3, output: 10 } });
const prices = { resolve: (model, at, family) => (model === 'unpriced-model' ? null : priced(model, family === 'google' ? 'gemini' : family)),
  snapshot: () => ({ snapshotHash: 'p' }), load: async () => {} };
const oldPrices = { resolve: (model, at, family) => (model === 'unpriced-model' ? null : priced(model, family)) };
const costStore = { version: 1, resolve: () => ({ id: 'rule-1', revision: 1, multiplier: 0.5 }) };

const log = (id, channel, model, prompt, completion, other, extra = {}) => ({ id, created_at: AT + id * 60, channel, channel_name: `stored-${channel}`,
  model_name: model, token_name: 'tok', group: 'default', prompt_tokens: prompt, completion_tokens: completion, quota: 1, use_time: 2,
  is_stream: true, other: JSON.stringify(other), ...extra });
// Real shapes: some rows carry usage_semantic, most non-Claude rows do not; cache keys come in different combinations.
const LOGS = [
  log(1, 3, 'deepseek-v4.1-flash', 5, 9, { cache_tokens: 0, cache_creation_tokens: 0, frt: 100 }),
  log(2, 2, 'gemini-3.8-flash', 37531, 2753, { cache_tokens: 1000, cache_creation_tokens: 0 }),
  log(3, 2, 'gemini-3.8-flash', 800, 40, {}),
  log(4, 4, 'grok-4.7', 24000, 600, { cache_tokens: 12000, cache_creation_tokens: 0 }),
  log(5, 4, 'grok-4.7', 900, 30, { cache_tokens: 2000, cache_creation_tokens: 0 }),
  log(6, 5, 'gpt-5.6-sol', 50000, 1200, { cache_tokens: 30000, cache_creation_tokens: 0 }),
  log(7, 5, 'gpt-6.1-sol', 12000, 300, { cache_tokens: 0, cache_creation_tokens: 0 }),
  log(8, 1, 'claude-sonnet-5', 120, 400, { cache_tokens: 3000, cache_creation_tokens: 200 }),
  log(9, 1, 'claude-sonnet-5', 90, 500, { usage_semantic: 'anthropic', cache_tokens: 5000, cache_creation_tokens: 0 }),
  log(10, 5, 'gpt-5.6-sol', 700, 80, { usage_semantic: 'openai', cache_tokens: 100, cache_creation_tokens: 0 }),
  log(11, 99, 'unpriced-model', 300, 20, { usage_semantic: 'openai', cache_tokens: 50, cache_creation_tokens: 0 }),
  log(12, 99, 'unpriced-model', 300, 20, { cache_tokens: 50, cache_creation_tokens: 10 }),
  log(13, 2, 'gemini-3.8-flash', 6000, 90, { cache_tokens: 400, cache_creation_tokens: 25, cache_creation_tokens_5m: 25 }),
];

function oldOptions() {
  return { channelNames: new Map(CHANNELS.map(([id, name]) => [id, name])),
    channelTypes: new Map(CHANNELS.map(([id, , type]) => [id, type])), quotaPerUnit: 500000, costStore, modelPricingStore: oldPrices };
}

async function setup(t) {
  const directory = await mkdtemp(path.join(tmpdir(), 'motai-usage-parity-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const value = structuredClone(config);
  value.models = MODELS;
  value.channels = CHANNELS.map(([id, name, , , models]) => ({ ...structuredClone(config.channels[0]), id: String(id), name,
    models: models.map((model) => ({ model_id: model, upstream_model: model, capabilities: ['responses', 'chat_completions'] })) }));
  value.aliases = [];
  value.callers[0].permissions[0].model_ids = MODELS.map((model) => model.id);
  value.callers[0].permissions[0].channel_ids = value.channels.map((channel) => channel.id);
  const client = { events: async () => ({ format_version: 1, events: [], next_seq: '0', latest_seq: '0', has_more: false }),
    attempts: async () => ({ format_version: 1, attempts: [], snapshot_seq: '1', has_more: false, next_cursor: null }) };
  const projection = new GatewayProjection({ directory, client, priceStore: prices, costStore, now: () => NOW });
  const publisher = new ConfigPublisher({ directory, client });
  publisher.current = { config: value, credentials, metadata: { testModels: {} } };
  const control = { config: () => publisher.snapshot(), client, publisher, load: async () => {}, status: async () => ({ ready: true }) };
  const importer = new LegacyImport({ directory: path.join(directory, 'legacy'), sourceInstanceId: 'prod-1' });
  await importer.load();
  importer.addRows(LOGS.map((entry) => normalizeLegacyRow(entry, { sourceInstanceId: 'prod-1', type: 2 })));
  const legacy = new LegacyOverview({ importer, from: FROM, to: TO, priceStore: prices, costStore });
  return { panel: new GatewayPanel({ control, projection, costStore, legacy, now: () => NOW }) };
}

const unknownSemantics = (entry) => !JSON.parse(entry.other).usage_semantic;

test('each old row shows the old console token figures; rows without usage semantics follow the channel type', async (t) => {
  const { panel } = await setup(t);
  const page = await panel.requests(new URLSearchParams({ hours: '24', limit: '100' }));
  const byId = new Map(page.items.map((row) => [Number(row.id.split(':').pop()), row]));
  const options = oldOptions();
  for (const entry of LOGS) {
    const old = normalizeLog(entry, options), now = byId.get(entry.id);
    assert.ok(now, `row ${entry.id} is listed`);
    for (const key of ['inputTokens', 'rawInputTokens', 'cacheInputTokens', 'totalTokens']) {
      // Rows that carry a usage convention keep their stored figures, which differ from the old ones only in what "raw" means.
      if (!unknownSemantics(entry) && key !== 'totalTokens') continue;
      assert.equal(now[key], old[key], `row ${entry.id} ${key}`);
    }
    for (const key of ['outputTokens', 'cacheReadTokens']) assert.equal(now[key], old[key], `row ${entry.id} ${key}`);
  }
});

test('overview totals and the cache hit rate equal the old console for the same rows', async (t) => {
  const { panel } = await setup(t);
  const expected = buildOverview({ channels: CHANNELS.map(([id, name, type]) => ({ id, name, type, status: 1, weight: 1, priority: 1, models: '' })),
    logs: LOGS, errors: [], status: { quota_per_unit: 500000 }, hours: 24, costStore, modelPricingStore: oldPrices });
  const result = panel.overview(new URLSearchParams({ hours: '24' }));
  assert.equal(result.metrics.inputTokens, expected.metrics.inputTokens, 'input tokens');
  assert.equal(result.metrics.outputTokens, expected.metrics.outputTokens, 'output tokens');
  assert.equal(result.metrics.totalTokens, expected.metrics.totalTokens, 'total tokens');
  assert.equal(result.metrics.cacheReadTokens, expected.metrics.cacheReadTokens, 'cache read tokens');
  const rate = (points) => points.reduce((sum, point) => ({ input: sum.input + point.cacheKnownInput, read: sum.read + point.cacheKnownRead }), { input: 0, read: 0 });
  const total = rate(result.trend), reference = rate(expected.trend);
  assert.deepEqual(total, reference, 'cache input and cache read behind the hit rate');
  assert.ok(total.input > 0);
  const hourly = (points) => points.map((point) => [point.time, point.input, point.output, point.cacheKnownInput, point.cacheKnownRead, point.cacheHitRate]);
  assert.deepEqual(hourly(result.trend), hourly(expected.trend), 'hourly trend');
});

test('an old row that is not priced still gets the old console token figures', async (t) => {
  const { panel } = await setup(t);
  const page = await panel.requests(new URLSearchParams({ hours: '24', limit: '100' }));
  const row = page.items.find((item) => item.id.endsWith(':12'));
  const old = normalizeLog(LOGS[11], oldOptions());
  assert.equal(row.costStatus, 'unknown');
  assert.equal(row.inputTokens, old.inputTokens);
  assert.equal(row.totalTokens, old.totalTokens);
});
