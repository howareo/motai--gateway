import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ModelPricingStore } from '../src/model-pricing-store.js';
import { normalizeLog } from '../src/analytics.js';
import { priceCanonical } from '../src/model-pricing.js';

test('Claude 5.5 aliases reuse canonical price intervals and preserve requested model names', () => {
  const store = new ModelPricingStore();
  for (const name of ['opus', 'sonnet']) {
    const model = `claude-${name}-5-5`;
    const base = { model, family: 'anthropic', promptIncludesCache: false, maxContextTokens: 1_000_000,
      sourceUrl: 'https://models.dev/api.json' };
    store.records.push({ ...base, effectiveFrom: 100, effectiveTo: 200,
      rates: { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 } },
    { ...base, effectiveFrom: 200, effectiveTo: null,
      rates: { input: 2, output: 10, cacheRead: 0.1, cacheWrite: 2.5 } });
  }
  const original = structuredClone(store.records);
  for (const name of ['opus', 'sonnet']) {
    const model = `claude-${name}-5.5`, canonical = `claude-${name}-5-5`;
    assert.equal(store.resolve(model, 99, 'anthropic'), null);
    assert.equal(store.resolveOfficial(model, 99), null);
    assert.equal(store.resolve(model, 200, 'openai'), null);
    for (const timestamp of [100, 199, 200, 300]) {
      const expected = { ...store.resolve(canonical, timestamp, 'anthropic'), model };
      assert.deepEqual(store.resolve(model, timestamp, 'anthropic'), expected);
      assert.deepEqual(store.resolveOfficial(model, timestamp), expected);
    }
  }
  assert.equal(store.resolveOfficial('claude-opus-5.50', 300), null);
  assert.equal(store.resolveOfficial('claude-haiku-5.5', 300), null);
  assert.deepEqual(store.records, original);
});

test('Claude dotted aliases price cached legacy logs and canonical usage from the same rates', () => {
  const store = new ModelPricingStore();
  const field = (value) => ({ value, availability: 'known', completeness: 'final', provenance: 'provider' });
  for (const [name, input] of [['opus', 4], ['sonnet', 2]]) {
    const canonical = `claude-${name}-5-5`, model = `claude-${name}-5.5`;
    store.records.push({ model: canonical, family: 'anthropic', effectiveFrom: 0, effectiveTo: null,
      promptIncludesCache: false, maxContextTokens: 1_000_000,
      rates: { input, output: input * 5, cacheRead: input / 20, cacheWrite: input * 1.25 } });
    const raw = { created_at: 300, model_name: model, channel: 1, prompt_tokens: 1000, completion_tokens: 10,
      other: { usage_semantic: 'anthropic', cache_tokens: 2000, cache_creation_tokens: 100, cache_creation_tokens_5m: 100 } };
    const log = normalizeLog(raw, { modelPricingStore: store, costStore: { resolve: () => ({ multiplier: 0.22 }) } });
    const expected = (1000 * input + 10 * input * 5 + 2000 * input / 20 + 100 * input * 1.25) / 1_000_000;
    assert.equal(log.model, model);
    assert.equal(log.officialCost, expected);
    assert.equal(log.estimatedCost, Math.round(expected * 0.22 * 1e9) / 1e9);
    assert.equal(log.costStatus, 'complete');
    const result = priceCanonical({ model, timestamp: 300, family: 'anthropic',
      externalRecord: store.resolve(model, 300, 'anthropic'), usage: {
        total_input: field(3100), input_uncached: field(1000), cache_read: field(2000),
        cache_write: { ttl_5m: field(100), ttl_1h: field(0), ttl_unknown: field(0) },
        output_total: field(10), reasoning: field(0), reasoning_relation: 'subset_of_output',
      } });
    assert.equal(result.status, 'complete');
    assert.equal(result.officialCost, expected);
  }
});

function catalog(output = 50) {
  return {
    anthropic: {
      id: 'anthropic',
      models: {
        'claude-future-6': {
          id: 'claude-future-6',
          limit: { context: 1_000_000 },
          cost: { input: 10, output, cache_read: 1, cache_write: 12.5 },
        },
      },
    },
    openai: {
      id: 'openai',
      models: {
        'gpt-6': {
          id: 'gpt-6',
          limit: { context: 1_000_000 },
          cost: { input: 4, output: 24, cache_read: 0.4, cache_write: 5 },
        },
        'gpt-incomplete': {
          id: 'gpt-incomplete',
          cost: { input: 1, output: 2 },
        },
      },
    },
    xai: {
      id: 'xai',
      models: {
        'grok-4.5': {
          id: 'grok-4.5',
          limit: { context: 500_000 },
          cost: { input: 2, output: 6, cache_read: 0.3 },
        },
      },
    },
    deepseek: {
      id: 'deepseek',
      models: {
        'deepseek-v4-flash': {
          id: 'deepseek-v4-flash',
          canonical_model_id: 'deepseek/deepseek-v4.1-flash-1017',
          limit: { context: 1_000_000 },
          cost: { input: 0.15, output: 0.6, cache_read: 0.003 },
        },
      },
    },
    reseller: {
      id: 'reseller',
      models: {
        'reseller-only': {
          id: 'reseller-only',
          cost: { input: 1, output: 2, cache_read: 0.1, cache_write: 1.25 },
        },
      },
    },
  };
}

test('syncs only exact official-provider model prices and keeps history forward-only', async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'model-pricing-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  let now = Date.parse('2026-07-26T00:00:00Z');
  let payload = catalog();
  const store = new ModelPricingStore({
    filePath: path.join(directory, 'pricing.json'),
    now: () => now,
    fetchImpl: async () => new Response(JSON.stringify(payload), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }),
  });

  await store.load();
  await store.refresh();
  assert.equal(store.snapshot().models, 5);
  assert.equal(store.resolve('claude-future-6', now / 1000 - 1, 'anthropic'), null);
  assert.equal(store.resolve('claude-future-6', now / 1000, 'anthropic').rates.output, 50);
  assert.equal(store.resolve('gpt-6', now / 1000, 'openai').promptIncludesCache, true);
  assert.equal(store.resolve('gpt-incomplete', now / 1000, 'openai'), null);
  assert.equal(store.resolve('grok-4.5', now / 1000, 'xai').rates.input, 2);
  assert.equal(store.resolve('grok-4.5', now / 1000, 'xai').rates.cacheWrite, null);
  assert.equal(store.resolve('grok-4.5', now / 1000, 'xai').promptIncludesCache, true);
  assert.equal(store.resolve('deepseek-v4-flash', now / 1000, 'deepseek').rates.cacheWrite, null);
  assert.equal(store.resolve('deepseek-v4.1-flash', now / 1000, 'deepseek').rates.input, 0.15);
  assert.equal(store.resolve('deepseek-v4.1-flash', now / 1000, 'deepseek').promptIncludesCache, true);
  assert.equal(store.resolve('deepseek-v4.1-flash', 1, 'deepseek').rates.input, 0.15);
  assert.equal(store.resolve('reseller-only', now / 1000, 'anthropic'), null);

  now += 24 * 60 * 60 * 1000;
  payload = catalog(60);
  await store.refresh();
  const oldRecord = store.resolve('claude-future-6', now / 1000 - 1, 'anthropic');
  const newRecord = store.resolve('claude-future-6', now / 1000, 'anthropic');
  assert.equal(oldRecord.rates.output, 50);
  assert.equal(newRecord.rates.output, 60);
  assert.equal(oldRecord.effectiveTo, now / 1000);
});

test('keeps the last successful pricing snapshot when synchronization fails', async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'model-pricing-failure-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  let fail = false;
  const now = Date.parse('2026-07-26T00:00:00Z');
  const store = new ModelPricingStore({
    filePath: path.join(directory, 'pricing.json'),
    now: () => now,
    fetchImpl: async () => {
      if (fail) throw new Error('offline');
      return new Response(JSON.stringify(catalog()), { status: 200 });
    },
  });

  await store.refresh();
  const before = store.resolve('gpt-6', now / 1000, 'openai');
  fail = true;
  await assert.rejects(store.refresh(), /offline/);
  const after = store.resolve('gpt-6', now / 1000, 'openai');
  assert.equal(after.rates.output, before.rates.output);
  assert.match(store.snapshot().lastError, /offline/);
});

test('returns one active record per provider and model for New API synchronization', async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'pricing-active-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new ModelPricingStore({ filePath: path.join(directory, 'pricing.json') });
  store.records = [
    { family: 'anthropic', model: 'claude-a', effectiveFrom: 0, effectiveTo: 10, rates: { input: 1 } },
    { family: 'anthropic', model: 'claude-a', effectiveFrom: 10, effectiveTo: null, rates: { input: 2 } },
    { family: 'openai', model: 'gpt-a', effectiveFrom: 0, effectiveTo: null, rates: { input: 3 } },
  ];
  const active = store.activeRecords(20);
  assert.deepEqual(active.map((item) => `${item.family}:${item.model}:${item.rates.input}`).sort(), [
    'anthropic:claude-a:2',
    'openai:gpt-a:3',
  ]);
  active[0].rates.input = 999;
  assert.notEqual(store.records[1].rates.input, 999);
});

test('pulls official Kimi and GLM prices and drops conflicting or relay prices', async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'model-pricing-official-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const now = Date.parse('2026-10-18T00:00:00Z');
  const payload = {
    moonshotai: {
      id: 'moonshotai',
      models: {
        'kimi-k3': { id: 'kimi-k3', cost: { input: 3, output: 15, cache_read: 0.3, cache_write: 3 } },
      },
    },
    'moonshotai-cn': {
      id: 'moonshotai-cn',
      models: {
        'kimi-k3': { id: 'kimi-k3', cost: { input: 3, output: 15, cache_read: 0.3, cache_write: 3 } },
      },
    },
    zai: {
      id: 'zai',
      models: {
        'glm-5': { id: 'glm-5', cost: { input: 1, output: 3.2, cache_read: 0.2 } },
        'glm-5v-turbo': { id: 'glm-5v-turbo', cost: { input: 1.2, output: 4, cache_read: 0.24 } },
      },
    },
    zhipuai: {
      id: 'zhipuai',
      models: {
        'glm-5': { id: 'glm-5', cost: { input: 1, output: 3.2, cache_read: 0.2 } },
        'glm-5v-turbo': { id: 'glm-5v-turbo', cost: { input: 5, output: 22, cache_read: 1.2 } },
      },
    },
    'kimi-code-plan-cn': {
      id: 'kimi-code-plan-cn',
      models: {
        'kimi-k3': { id: 'kimi-k3', cost: { input: 0.1, output: 0.2, cache_read: 0.01 } },
      },
    },
    openrouter: {
      id: 'openrouter',
      models: {
        'kimi-k3': { id: 'kimi-k3', cost: { input: 9, output: 9, cache_read: 1 } },
      },
    },
  };
  const store = new ModelPricingStore({
    filePath: path.join(directory, 'pricing.json'),
    now: () => now,
    fetchImpl: async () => new Response(JSON.stringify(payload), { status: 200 }),
  });
  await store.refresh();
  assert.equal(store.resolve('kimi-k3', now / 1000, 'moonshot').rates.input, 3);
  assert.equal(store.resolve('kimi-k3', now / 1000, 'moonshotai'), null);
  assert.equal(store.resolve('glm-5', now / 1000, 'zhipu').rates.output, 3.2);
  assert.equal(store.resolve('glm-5v-turbo', now / 1000, 'zhipu'), null);
  assert.equal(store.resolveOfficial('kimi-k3', now / 1000).family, 'moonshot');
  assert.equal(store.resolveOfficial('glm-5v-turbo', now / 1000), null);
  assert.equal(store.snapshot().models, 2);
});
