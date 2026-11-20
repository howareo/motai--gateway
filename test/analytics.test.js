import test from 'node:test';
import assert from 'node:assert/strict';
import { buildOverview, filterRequestEvents, normalizeLog } from '../src/analytics.js';
import { modelProviderPool } from '../src/channel-types.js';

const channels = { items: [
  { id: 1, name: 'Primary', type: 14, status: 1, models: 'claude-sonnet-5', weight: 10, priority: 1 },
  { id: 2, name: 'Fallback', type: 14, status: 1, models: 'claude-sonnet-5', weight: 10, priority: 0 },
] };

test('weights cache hit rates by input tokens and isolates final channels over the whole period', () => {
  const channels = { items: [
    { id: 1, type: 1, name: 'OpenAI' }, { id: 2, type: 14, name: 'Claude' }, { id: 3, type: 48, name: 'Idle' },
  ] };
  const logs = [
    { id: 1, channel: 1, created_at: 1792371600, prompt_tokens: 100, completion_tokens: 10000, other: '{"cache_tokens":90,"admin_info":{"use_channel":[2,1]}}' },
    { id: 2, channel: 1, created_at: 1792371601, prompt_tokens: 900, completion_tokens: 1, other: '{"cache_tokens":0}' },
    { id: 3, channel: 1, created_at: 1792371602, prompt_tokens: 9999, completion_tokens: 0, other: '{}' },
    { id: 4, channel: 2, created_at: 1792371603, prompt_tokens: 20, completion_tokens: 10, other: '{"cache_tokens":60,"cache_creation_tokens":20}' },
    ...Array.from({ length: 201 }, (_, i) => ({ id: 5 + i, channel: 2, created_at: 1792371604, prompt_tokens: 20, completion_tokens: 0, other: '{"cache_tokens":60,"cache_creation_tokens":20}' })),
  ];
  const result = buildOverview({ channels, logs });
  const openai = result.channelTrends.find((c) => c.channelId === 1).trend[0];
  assert.equal(openai.cacheHitRate, 0.09);
  assert.equal(openai.cacheKnownRequests, 2);
  assert.equal(openai.requests, 3);
  assert.equal(openai.cacheKnownInput, 1000);
  assert.equal(openai.cacheCreate, null);
  const claude = result.channelTrends.find((c) => c.channelId === 2).trend[0];
  assert.equal(claude.requests, 202);
  assert.equal(claude.cacheHitRate, 0.6);
  assert.equal(claude.cacheCreate, 4040);
  assert.deepEqual(result.channelTrends.find((c) => c.channelId === 3).trend, []);
  assert.equal(result.trend[0].cacheHitRate, (90 + 60 * 202) / (1000 + 100 * 202));
});

test('splits routing pools by model provider even when channels share the OpenAI protocol type', () => {
  const channels = { items: [
    { id: 1, name: 'A', type: 1, status: 1, models: 'gpt-6-astra', weight: 10, priority: 22 },
    { id: 2, name: 'B', type: 1, status: 1, models: 'gemini-3.8-flash', weight: 10, priority: 23 },
    { id: 3, name: 'C', type: 1, status: 1, models: 'gemini-3.8-flash', weight: 10, priority: 0 },
  ] };
  const rows = buildOverview({ channels, logs: [] }).channels;
  const byId = (id) => rows.find((row) => row.id === id);
  assert.equal(byId(1).routingPool, 'OpenAI');
  assert.equal(byId(1).routeRole, 'primary');
  assert.equal(byId(2).routingPool, 'Gemini');
  assert.equal(byId(2).routeRole, 'primary');
  assert.equal(byId(3).routeRole, 'fallback');
});

test('modelProviderPool picks the majority provider, first on ties, else the fallback', () => {
  assert.equal(modelProviderPool(['gemini-3', 'gpt-5', 'gemini-4']), 'gemini');
  assert.equal(modelProviderPool(['gpt-5', 'gemini-3']), 'openai');
  assert.equal(modelProviderPool(['o3-mini']), 'openai');
  assert.equal(modelProviderPool(['unknown-x'], 'openai'), 'openai');
  assert.equal(modelProviderPool([]), null);
});

test('keeps missing, invalid, and zero-total cache usage out of the hit-rate denominator', () => {
  const logs = [
    { created_at: 1792371600, channel: 1, prompt_tokens: 100, other: '{}' },
    { created_at: 1792375200, channel: 1, prompt_tokens: 100, other: '{"cache_tokens":101}' },
    { created_at: 1792378800, channel: 1, prompt_tokens: 100, other: '{"cache_tokens":null}' },
    { created_at: 1792382400, channel: 1, prompt_tokens: 0, other: '{"cache_tokens":0}' },
    { created_at: 1792386000, channel: 2, prompt_tokens: 10, other: '{"cache_tokens":20}' },
  ];
  const result = buildOverview({ channels: [{ id: 1, type: 1 }, { id: 2, type: 14 }], logs });
  assert.ok(result.trend.every((point) => point.cacheHitRate === null));
  assert.equal(result.trend[0].cacheRead, null);
  assert.equal(result.trend[0].cacheCreate, null);
});

test('daily trend buckets use Beijing midnight independently of the process timezone', () => {
  const result = buildOverview({ channels, hours: 168, logs: [
    { channel: 1, created_at: Date.parse('2026-10-18T16:30:00Z') / 1000, prompt_tokens: 1 },
  ] });
  assert.equal(result.trend[0].time, '2026-10-18T16:00:00.000Z');
});

test('keeps all four token classes and the attempted channel chain', () => {
  const log = normalizeLog({
    id: 1,
    created_at: 100,
    channel: 2,
    model_name: 'claude-x',
    prompt_tokens: 40,
    completion_tokens: 5,
    quota: 500,
    use_time: 3,
    other: JSON.stringify({ cache_tokens: 20, cache_creation_tokens: 10, reasoning_effort: 'high', frt: 180, admin_info: { use_channel: [1, 2] } }),
  }, {
    channelNames: new Map([[1, 'Primary'], [2, 'Fallback']]),
    channelTypes: new Map([[1, 'Anthropic'], [2, 'Anthropic']]),
    quotaPerUnit: 500000,
  });
  assert.equal(log.inputTokens, 40);
  assert.equal(log.outputTokens, 5);
  assert.equal(log.cacheReadTokens, 20);
  assert.equal(log.cacheCreateTokens, 10);
  assert.deepEqual(log.channelRoute, ['Primary', 'Fallback']);
  assert.equal(log.failover, true);
  assert.equal(log.ttftMs, 180);
  assert.equal(log.durationMs, 3000);
  assert.equal(log.reasoningEffort, 'high');
  assert.equal(log.providerFamily, 'anthropic');
});

test('preserves absent optional fields as null instead of zero', () => {
  const log = normalizeLog({ created_at: 100, prompt_tokens: 3, completion_tokens: 1, other: '{}' });
  assert.equal(log.cacheReadTokens, null);
  assert.equal(log.cacheCreateTokens, null);
  assert.equal(log.ttftMs, null);
  assert.equal(log.reasoningEffort, null);
  assert.equal(log.providerFamily, null);
});

test('estimates whole-request output throughput for streaming and non-streaming requests', () => {
  for (const is_stream of [true, false]) {
    for (const other of [{}, { frt: 2000 }, { frt: -1000 }, { stream_status: { status: 'ok', errors: [] } }]) {
      const log = normalizeLog({ completion_tokens: 600, use_time: 10, is_stream, other });
      assert.equal(log.outputTokensPerSecond, 60);
    }
  }
});

test('keeps missing or invalid throughput and interrupted usage unknown instead of zero', () => {
  const valid = { completion_tokens: 600, use_time: 10, is_stream: true };
  const invalid = [undefined, null, '', 0, -1, 'bad', Infinity];
  for (const value of invalid) {
    assert.equal(normalizeLog({ ...valid, completion_tokens: value }).outputTokensPerSecond, null);
    assert.equal(normalizeLog({ ...valid, use_time: value }).outputTokensPerSecond, null);
  }
  for (const stream_status of [
    { status: 'error' }, { status: 'incomplete' }, { status: 'ok', errors: ['interrupted'] },
  ]) {
    assert.equal(normalizeLog({ ...valid, other: { stream_status } }).outputTokensPerSecond, null);
  }
});

test('separates New API model-test logs by channel and model', () => {
  const costStore = {
    resolve() { return { multiplier: 0.1 }; },
    channelPricing() { return { multiplier: 0.1, sync: { mode: 'manual' }, modelOverrides: [] }; },
  };
  const result = buildOverview({
    channels: { items: [{ id: 1, name: 'Probe A', type: 1, status: 1, models: 'gpt-5.6-terra' }] },
    logs: { items: [
      { id: 1, created_at: 100, channel: 1, channel_name: 'Probe A', token_name: '模型测试', content: '模型测试', model_name: 'gpt-5.6-terra', prompt_tokens: 100, completion_tokens: 10 },
      { id: 2, created_at: 101, channel: 1, channel_name: 'Probe A', token_name: 'local-openai', model_name: 'gpt-5.6-terra', prompt_tokens: 100, completion_tokens: 10 },
    ] },
    status: { quota_per_unit: 500000 },
    costStore,
  });
  assert.equal(result.modelTests.length, 1);
  assert.equal(result.modelTests[0].channelName, 'Probe A');
  assert.equal(result.modelTests[0].model, 'gpt-5.6-terra');
  assert.equal(result.modelTests[0].requests, 1);
  assert.equal(result.logs[0].isModelTest, true);
  assert.equal(result.logs[1].isModelTest, false);
});

test('normalizes OpenAI-compatible xAI cache usage even before a price record is available', () => {
  const log = normalizeLog({
    id: 10,
    created_at: 100,
    channel: 10,
    model_name: 'grok-4.5',
    prompt_tokens: 100,
    completion_tokens: 3,
    other: JSON.stringify({ cache_tokens: 80 }),
  }, {
    channelNames: new Map([[10, 'Grok']]),
    channelTypes: new Map([[10, 'xAI']]),
    quotaPerUnit: 500000,
  });
  assert.equal(log.inputTokens, 20);
  assert.equal(log.rawInputTokens, 100);
  assert.equal(log.cacheReadTokens, 80);
  assert.equal(log.totalTokens, 103);
  assert.equal(log.providerFamily, 'xai');
});

test('a cost store with a single rule prices every request with it', () => {
  const costStore = {
    resolve() {
      return { id: 'current', channelId: '*', model: '*', multiplier: 0.1, effectiveFrom: 200 };
    },
  };
  const result = buildOverview({
    channels,
    logs: { items: [
      { id: 1, created_at: 100, channel: 1, model_name: 'claude-sonnet-5', prompt_tokens: 1000, completion_tokens: 0, quota: 500000, other: '{"usage_semantic":"anthropic","cache_tokens":0,"cache_creation_tokens":0}' },
      { id: 2, created_at: 300, channel: 1, model_name: 'claude-sonnet-5', prompt_tokens: 1000, completion_tokens: 0, quota: 500000, other: '{"usage_semantic":"anthropic","cache_tokens":0,"cache_creation_tokens":0}' },
    ] },
    status: { quota_per_unit: 500000 },
    costStore,
  });
  assert.equal(result.logs[0].estimatedCost, 0.0001);
  assert.equal(result.logs[1].estimatedCost, 0.0001);
  assert.equal(result.metrics.estimatedCost, 0.0002);
  assert.equal(result.models[0].estimatedCost, 0.0002);
  assert.equal(result.models[0].requests, 2);
  assert.equal(result.channels[0].estimatedCost, 0.0002);
  assert.equal(result.channels[0].requests, 2);
  assert.equal(result.channels[0].tokens, 2000);
  assert.deepEqual(result.channels[0].costCoverage, { complete: 2, partial: 0, unknown: 0 });
  assert.equal(result.channels[0].estimatedCostIsLowerBound, false);
});

test('prices a newly observed exact model from the synchronized provider catalog', () => {
  const costStore = {
    resolve: () => ({ multiplier: 0.01, label: 'current' }),
    channelPricing: () => ({ multiplier: 0.01, source: 'channel', modelOverrides: [], sync: { mode: 'manual' } }),
  };
  const modelPricingStore = {
    resolve(model, timestamp, family) {
      if (model !== 'claude-future-6' || family !== 'anthropic' || timestamp < 200) return null;
      return {
        model,
        family,
        effectiveFrom: 200,
        effectiveTo: null,
        promptIncludesCache: false,
        maxContextTokens: 1_000_000,
        rates: { input: 10, output: 50, cacheRead: 1, cacheWrite: 12.5, cacheWrite1h: null },
        tier: 'synced',
        sourceLabel: 'models.dev 同步',
        sourceUrl: 'https://models.dev/api.json',
        firstObservedAt: '1970-01-01T00:03:20.000Z',
      };
    },
  };
  const result = buildOverview({
    channels,
    logs: { items: [{
      id: 1,
      created_at: 300,
      channel: 1,
      model_name: 'claude-future-6',
      prompt_tokens: 10,
      completion_tokens: 2,
      other: JSON.stringify({ usage_semantic: 'anthropic', cache_tokens: 20, cache_creation_tokens: 10, cache_creation_tokens_5m: 10 }),
    }] },
    costStore,
    modelPricingStore,
  });
  assert.equal(result.logs[0].officialCost, 0.000345);
  assert.equal(result.logs[0].estimatedCost, 0.00000345);
  assert.equal(result.logs[0].priceSource, 'models.dev 同步');
  assert.deepEqual(result.models[0].priceSources, ['models.dev 同步']);
});

test('keeps New API quota only as an audit value and propagates cost coverage', () => {
  const costStore = {
    version: 1,
    resolve: () => ({ multiplier: 0.3, label: 'test' }),
    channelPricing: () => ({ multiplier: 0.3, source: 'channel', modelOverrides: [], sync: { mode: 'manual' } }),
  };
  const result = buildOverview({
    channels,
    logs: { items: [
      {
        id: 1,
        created_at: 1_785_000_000,
        channel: 1,
        model_name: 'claude-opus-5',
        prompt_tokens: 17,
        completion_tokens: 3297,
        quota: 955547,
        other: JSON.stringify({ usage_semantic: 'anthropic', cache_tokens: 22121, cache_creation_tokens: 37, cache_creation_tokens_5m: 37 }),
      },
      {
        id: 2,
        created_at: 1_785_000_001,
        channel: 2,
        model_name: 'claude-sonnet-5',
        prompt_tokens: 53,
        completion_tokens: 85,
        quota: 5175,
        other: JSON.stringify({ cache_tokens: 158 }),
      },
    ] },
    status: { quota_per_unit: 500000 },
    costStore,
  });
  assert.equal(result.logs[0].billedCost, 1.911094);
  assert.equal(result.logs[0].officialCost, 0.09380175);
  assert.equal(result.logs[0].billingAuditDelta, 1.81729225);
  assert.equal(result.logs[0].estimatedCost, 0.028140525);
  assert.equal(result.logs[0].costStatus, 'complete');
  assert.equal(result.logs[1].costStatus, 'partial');
  assert.deepEqual(result.metrics.costCoverage, { complete: 1, partial: 1, unknown: 0 });
  assert.equal(result.metrics.estimatedCostIsLowerBound, true);
  assert.equal(result.channels[0].estimatedCostIsLowerBound, false);
  assert.equal(result.channels[1].estimatedCostIsLowerBound, true);
});

test('separates routing pools and marks priority routing as primary and fallback', () => {
  const mixedChannels = { items: [
    ...channels.items,
    { id: 3, name: 'OpenAI Primary', type: 1, status: 1, models: 'gpt-5.6-terra', weight: 10, priority: 1 },
    { id: 4, name: 'OpenAI Fallback', type: 1, status: 1, models: 'gpt-5.6-terra', weight: 10, priority: 0 },
  ] };
  const logs = { items: [
    ...Array.from({ length: 6 }, (_, index) => ({ id: index + 1, created_at: 1_785_000_000 + index, channel: 1, model_name: 'claude-sonnet-5', other: '{}' })),
    ...Array.from({ length: 2 }, (_, index) => ({ id: index + 10, created_at: 1_785_000_000 + index, channel: 2, model_name: 'claude-sonnet-5', other: '{}' })),
    ...Array.from({ length: 5 }, (_, index) => ({ id: index + 20, created_at: 1_785_000_000 + index, channel: 3, model_name: 'gpt-5.6-terra', other: '{}' })),
  ] };
  const result = buildOverview({ channels: mixedChannels, logs, hours: 24 });
  const byId = new Map(result.channels.map((channel) => [channel.id, channel]));
  assert.equal(byId.get(1).routingPool, 'Claude');
  assert.equal(byId.get(1).routeRole, 'primary');
  assert.equal(byId.get(1).isSolePrimary, true);
  assert.equal(byId.get(1).primaryPeerCount, 1);
  assert.equal(byId.get(2).routeRole, 'fallback');
  assert.equal(byId.get(1).poolRequests, 8);
  assert.equal(byId.get(1).poolTrafficShare, 0.75);
  assert.equal(byId.get(3).routingPool, 'OpenAI');
  assert.equal(byId.get(3).poolRequests, 5);
  assert.equal(byId.get(4).poolTrafficShare, 0);
});

test('distinguishes a shared primary layer and never marks disabled channels as primary', () => {
  const result = buildOverview({
    channels: { items: [
      { id: 1, name: 'A', type: 14, status: 1, models: 'claude-a', weight: 6, priority: 5 },
      { id: 2, name: 'B', type: 14, status: 1, models: 'claude-b', weight: 4, priority: 5 },
      { id: 3, name: 'Disabled', type: 14, status: 2, models: 'claude-c', weight: 10, priority: 99 },
    ] },
    logs: { items: [] },
  });
  const byId = new Map(result.channels.map((channel) => [channel.id, channel]));
  assert.equal(byId.get(1).routeRole, 'primary');
  assert.equal(byId.get(1).isSolePrimary, false);
  assert.equal(byId.get(1).primaryPeerCount, 2);
  assert.equal(byId.get(1).configWeightShare, 0.6);
  assert.equal(byId.get(3).routeRole, 'disabled');
});

test('keeps every normalized request for 100-row UI pagination', () => {
  const logs = { items: Array.from({ length: 205 }, (_, index) => ({
    id: index + 1,
    created_at: 1_785_000_000 + index,
    channel: 1,
    model_name: 'claude-sonnet-5',
    prompt_tokens: 1,
    completion_tokens: 1,
    other: '{}',
  })) };

  const result = buildOverview({ channels, logs, hours: 24 });

  assert.equal(result.metrics.requests, 205);
  assert.equal(result.logs.length, 205);
});

test('merges every upstream error into the request timeline without charging failed attempts', () => {
  const result = buildOverview({
    channels,
    logs: { items: [{
      id: 10,
      request_id: 'request-recovered',
      created_at: 300,
      channel: 1,
      model_name: 'claude-sonnet-5',
      prompt_tokens: 10,
      completion_tokens: 2,
      other: '{}',
    }] },
    errors: { items: [
      {
        id: 20,
        request_id: 'request-recovered',
        created_at: 200,
        channel: 1,
        model_name: 'claude-sonnet-5',
        content: 'status_code=503, upstream busy',
      },
      {
        id: 21,
        request_id: 'request-failed',
        created_at: 250,
        channel: 1,
        model_name: 'claude-sonnet-5',
        content: 'status code: 429, rate limited',
      },
    ] },
    hours: 24,
  });

  assert.equal(result.metrics.requests, 1);
  assert.equal(result.metrics.failedRequests, 1);
  assert.equal(result.metrics.totalRequests, 2);
  assert.equal(result.metrics.errorCount, 2);
  assert.equal(result.metrics.upstreamAttempts, 3);
  assert.equal(result.metrics.upstreamErrorRate, 2 / 3);
  assert.deepEqual(result.logs.map((event) => event.kind), ['success', 'error', 'error']);
  assert.equal(result.logs[1].statusCode, 429);
  assert.equal(result.logs[1].errorMessage, 'rate limited');
  assert.equal(result.logs[1].estimatedCost, null);
  assert.equal(result.latestError.statusCode, 429);
  assert.equal(result.channels[0].errorCount, 2);
  assert.equal(result.channels[0].state, 'recovered');
  assert.equal(result.channels[0].attempts, 2);
  assert.equal(result.channels[0].availabilitySuccesses, 1);
  assert.equal(result.channels[0].availabilityFailures, 2);
  assert.equal(result.channels[0].availabilityAttempts, 3);
  assert.equal(result.channels[0].availabilityRate, 1 / 3);
  assert.deepEqual(result.channels[0].recentResults.map((event) => [event.success, event.statusCode]), [
    [false, 503],
    [false, 429],
    [true, 200],
  ]);
});

test('keeps only the latest 60 real upstream results per channel', () => {
  const result = buildOverview({
    channels,
    logs: { items: Array.from({ length: 65 }, (_, index) => ({
      id: index + 1,
      created_at: 1_785_000_000 + index,
      channel: 1,
      model_name: 'claude-sonnet-5',
      other: '{}',
    })) },
    hours: 24,
  });

  assert.equal(result.channels[0].availabilityRate, 1);
  assert.equal(result.channels[0].recentResults.length, 60);
  assert.equal(result.channels[0].recentResults[0].createdAt, new Date(1_785_000_005 * 1000).toISOString());
  assert.equal(result.channels[0].recentResults.at(-1).createdAt, new Date(1_785_000_064 * 1000).toISOString());
});

test('prices a relay channel from the official model catalog instead of the relay family', () => {
  const modelPricingStore = {
    resolve() { return null; },
    resolveOfficial(model) {
      if (model !== 'kimi-k3') return null;
      return {
        model,
        family: 'moonshot',
        promptIncludesCache: false,
        maxContextTokens: 1_000_000,
        rates: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3, cacheWrite1h: null },
      };
    },
  };
  const log = normalizeLog({
    id: 9,
    created_at: 100,
    channel: 7,
    model_name: 'kimi-k3',
    prompt_tokens: 1_000_000,
    completion_tokens: 0,
    other: JSON.stringify({ usage_semantic: 'openai', cache_tokens: 0, cache_creation_tokens: 0 }),
  }, {
    channelTypes: new Map([[7, 'OpenAI']]),
    modelPricingStore,
  });
  assert.equal(log.officialCost, 3);
  assert.equal(log.costStatus, 'unknown');
});

test('filterRequestEvents matches channel, model, status, and stream exactly like the removed front-end filter', () => {
  const events = [
    { id: 1, kind: 'success', channelId: 1, model: 'claude-sonnet-5', stream: true, failover: false },
    { id: 2, kind: 'success', channelId: 2, model: 'claude-opus-5', stream: false, failover: false },
    { id: 3, kind: 'success', channelId: 1, model: 'claude-sonnet-5', stream: true, failover: true },
    { id: 4, kind: 'error', channelId: 1, model: 'claude-sonnet-5', stream: null, failover: false },
  ];

  assert.deepEqual(filterRequestEvents(events, {}).map((event) => event.id), [1, 2, 3, 4]);
  assert.deepEqual(filterRequestEvents(events, { channel: '2' }).map((event) => event.id), [2]);
  assert.deepEqual(filterRequestEvents(events, { model: 'claude-opus-5' }).map((event) => event.id), [2]);
  assert.deepEqual(filterRequestEvents(events, { status: 'error' }).map((event) => event.id), [4]);
  assert.deepEqual(filterRequestEvents(events, { status: 'success' }).map((event) => event.id), [1, 2, 3]);
  assert.deepEqual(filterRequestEvents(events, { stream: 'stream' }).map((event) => event.id), [1, 3]);
  assert.deepEqual(filterRequestEvents(events, { stream: 'nonstream' }).map((event) => event.id), [2]);
  assert.deepEqual(filterRequestEvents(events, { stream: 'failover' }).map((event) => event.id), [3]);
  assert.deepEqual(filterRequestEvents([], { channel: '1' }), []);
  assert.deepEqual(filterRequestEvents(undefined, {}), []);
});
