import test from 'node:test';
import assert from 'node:assert/strict';
import { PRICE_RECORDS, priceUsage, resolveOfficialPrice } from '../src/model-pricing.js';

test('prices GPT-5.6 cached input with mutually exclusive token classes', () => {
  const priced = priceUsage({
    model: 'gpt-5.6-terra',
    timestamp: 1_785_000_000,
    family: 'openai',
    inputTokens: 4387,
    outputTokens: 12,
    cacheReadTokens: 3840,
    cacheCreateTokens: 0,
  });
  assert.equal(priced.status, 'complete');
  assert.equal(priced.normalizedInputTokens, 547);
  assert.equal(priced.officialCost, 0.0025075);
});

test('prices GPT-5.6 cache writes as a mutually exclusive input class', () => {
  const priced = priceUsage({
    model: 'gpt-5.6-terra',
    timestamp: 1_785_000_000,
    family: 'openai',
    inputTokens: 2000,
    outputTokens: 0,
    cacheReadTokens: 500,
    cacheCreateTokens: 1000,
  });
  assert.equal(priced.status, 'complete');
  assert.equal(priced.normalizedInputTokens, 500);
  assert.equal(priced.officialCost, 0.0045);
});

test('prices Anthropic input independently from cache read and 5m writes', () => {
  const priced = priceUsage({
    model: 'claude-opus-5',
    timestamp: 1_785_000_000,
    family: 'anthropic',
    inputTokens: 17,
    outputTokens: 3297,
    cacheReadTokens: 22121,
    cacheCreateTokens: 37,
    cacheCreateTokens5m: 37,
  });
  assert.equal(priced.status, 'complete');
  assert.equal(priced.normalizedInputTokens, 17);
  assert.equal(priced.officialCost, 0.09380175);
});

test('prices Claude Fable 5 with the verified launch price', () => {
  const priced = priceUsage({
    model: 'claude-fable-5',
    timestamp: Date.parse('2026-07-26T00:00:00Z') / 1000,
    family: 'anthropic',
    inputTokens: 2,
    outputTokens: 4107,
    cacheReadTokens: 0,
    cacheCreateTokens: 134996,
    cacheCreateTokens5m: 134996,
    cacheCreateTokens1h: 0,
  });
  assert.equal(priced.status, 'complete');
  assert.equal(priced.officialCost, 1.89282);
  assert.equal(priced.record.tier, 'official');
  assert.equal(priced.record.rates.cacheWrite1h, 20);
});

test('keeps an externally synced Anthropic 1h cache-write component partial', () => {
  const priced = priceUsage({
    model: 'claude-future-model',
    timestamp: Date.parse('2026-07-26T00:00:00Z') / 1000,
    family: 'anthropic',
    inputTokens: 10,
    outputTokens: 2,
    cacheReadTokens: 20,
    cacheCreateTokens: 30,
    cacheCreateTokens5m: 10,
    cacheCreateTokens1h: 20,
    externalRecord: {
      model: 'claude-future-model',
      family: 'anthropic',
      effectiveFrom: 0,
      effectiveTo: null,
      promptIncludesCache: false,
      maxContextTokens: 1_000_000,
      rates: { input: 10, output: 50, cacheRead: 1, cacheWrite: 12.5, cacheWrite1h: null },
      tier: 'synced',
    },
  });
  assert.equal(priced.status, 'partial');
  assert.match(priced.reason, /cache_write_1h_unpriced/);
  assert.equal(priced.officialCost, 0.000345);
});

test('uses the synced context tier when the static record is too narrow', () => {
  const priced = priceUsage({
    model: 'claude-opus-5',
    timestamp: Date.parse('2026-08-04T12:00:00Z') / 1000,
    family: 'anthropic',
    inputTokens: 20_000,
    outputTokens: 780,
    cacheReadTokens: 199_596,
    cacheCreateTokens: 2_091,
    cacheCreateTokens5m: 2_091,
    externalRecord: {
      model: 'claude-opus-5',
      family: 'anthropic',
      effectiveFrom: Date.parse('2026-08-02T14:00:00Z') / 1000,
      effectiveTo: null,
      promptIncludesCache: false,
      maxContextTokens: 1_000_000,
      rates: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25, cacheWrite1h: null },
      tier: 'synced',
      sourceLabel: 'models.dev 同步',
    },
  });
  assert.equal(priced.status, 'complete');
  assert.equal(priced.record.tier, 'synced');
  assert.equal(priced.record.maxContextTokens, 1_000_000);
  assert.equal(priced.officialCost, 0.23236675);
});

test('keeps missing Anthropic cache writes partial and rejects invalid bases', () => {
  const partial = priceUsage({
    model: 'claude-sonnet-5',
    timestamp: 1_785_000_000,
    family: 'anthropic',
    inputTokens: 53,
    outputTokens: 85,
    cacheReadTokens: 158,
    cacheCreateTokens: null,
  });
  assert.equal(partial.status, 'partial');
  assert.match(partial.reason, /cache_write_missing/);
  assert.equal(partial.officialCost, 0.0004938);

  const invalid = priceUsage({
    model: 'gpt-5.6-sol',
    timestamp: 1_785_000_000,
    family: 'openai',
    inputTokens: 10,
    outputTokens: 1,
    cacheReadTokens: 20,
    cacheCreateTokens: 0,
  });
  assert.equal(invalid.status, 'unknown');
  assert.equal(invalid.reason, 'cache_exceeds_prompt');
});

test('applies the announced Sonnet 5 price change at a UTC boundary', () => {
  const before = resolveOfficialPrice('claude-sonnet-5', Date.parse('2026-08-31T23:59:59Z') / 1000);
  const after = resolveOfficialPrice('claude-sonnet-5', Date.parse('2026-09-01T00:00:00Z') / 1000);
  assert.equal(before.rates.input, 1);
  assert.equal(before.rates.output, 5);
  assert.equal(after.rates.input, 1.5);
  assert.equal(after.rates.output, 7.5);
});

test('has non-overlapping price records and no fallback for unknown models', () => {
  for (const model of new Set(PRICE_RECORDS.map((record) => record.model))) {
    const records = PRICE_RECORDS.filter((record) => record.model === model)
      .sort((left, right) => left.effectiveFrom - right.effectiveFrom);
    for (let index = 1; index < records.length; index += 1) {
      assert.equal(records[index - 1].effectiveTo, records[index].effectiveFrom);
    }
  }
  assert.equal(resolveOfficialPrice('unknown-model', 1_785_000_000), null);
});
