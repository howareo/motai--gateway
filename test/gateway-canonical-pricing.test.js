import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { priceCanonical, priceUsage } from '../src/model-pricing.js';
import { validateUsage } from '../src/gateway/schema.js';
import { effectiveUsage } from '../src/usage-metrics.js';

const field = (value, extra = {}) => ({ value, availability: value === null ? 'absent' : 'known',
  completeness: 'final', provenance: value === null ? 'absent' : 'provider', ...extra });
const usage = (overrides = {}) => ({ total_input: field(2000), input_uncached: field(1000), cache_read: field(1000),
  cache_write: { ttl_5m: field(0), ttl_1h: field(0), ttl_unknown: field(0) },
  output_total: field(10), reasoning: field(5), reasoning_relation: 'subset_of_output', ...overrides });
const price = (value, extras = {}) => priceCanonical({ model: 'gpt-5.6-terra', timestamp: 1_785_000_000,
  family: 'openai', usage: value, ...extras });

test('canonical categories do not subtract cache again and share the legacy cost formula', () => {
  const result = price(usage());
  assert.equal(result.status, 'complete');
  assert.equal(result.normalizedInputTokens, 1000);
  assert.equal(result.officialCost, priceUsage({ model: 'gpt-5.6-terra', timestamp: 1_785_000_000,
    family: 'openai', inputTokens: 2000, cacheReadTokens: 1000, cacheCreateTokens: 0, outputTokens: 10 }).officialCost);
});

test('unknown TTL writes remain unpriced and independent output survives contradictory input', () => {
  const value = usage({ input_uncached: field(null), cache_read: field(2500),
    cache_write: { ttl_5m: field(0), ttl_1h: field(0), ttl_unknown: field(20) } });
  const result = price(value);
  assert.equal(result.status, 'partial');
  assert.equal(result.normalizedInputTokens, null);
  assert.equal(result.officialCost, (2500 * 0.25 + 10 * 15) / 1_000_000);
  assert.match(result.reason, /cache_write_unknown_unpriced/);
});

test('canonical Anthropic TTLs and context tiers keep known costs and original price behavior', () => {
  const value = usage({ total_input: field(40), input_uncached: field(10), cache_read: field(0),
    cache_write: { ttl_5m: field(10), ttl_1h: field(20), ttl_unknown: field(0) } });
  const result = price(value, { family: 'anthropic', model: 'claude-opus-5' });
  assert.equal(result.status, 'complete');
  assert.equal(result.officialCost, (10 * 5 + 10 * 6.25 + 20 * 10 + 10 * 25) / 1_000_000);
  value.total_input = field(300000);
  const large = price(value, { family: 'anthropic', model: 'claude-opus-5', externalRecord: {
    model: 'claude-opus-5', family: 'anthropic', effectiveFrom: 0, effectiveTo: null,
    maxContextTokens: 1_000_000, rates: { input: 6, output: 30, cacheRead: 0.6, cacheWrite: 7.5, cacheWrite1h: 12 } } });
  assert.equal(large.record.rates.input, 6);
});

test('provider identity, absent zero, partial usage and reasoning do not become invented charges', () => {
  assert.equal(price(usage(), { family: 'xai' }).status, 'unknown');
  const value = usage({ output_total: field(0), reasoning_relation: 'unknown', reasoning: field(0),
    input_uncached: field(null), cache_read: field(0) });
  assert.equal(price(value).officialCost, 0);
  assert.equal(price(value).status, 'partial');
  value.output_total = field(10, { completeness: 'partial' });
  value.reasoning = field(5);
  const uncertain = price(value);
  assert.match(uncertain.reason, /output_partial/);
  assert.match(uncertain.reason, /reasoning_relation_unknown/);
  assert.equal(uncertain.officialCost, 0.00015);
});

test('flat prices ignore missing, partial and estimated total input when all billed categories are exact', () => {
  const exact = price(usage());
  for (const total_input of [field(null), field(2000, { completeness: 'partial' }),
    field(2000, { availability: 'estimated', provenance: 'adapter_estimate' })]) {
    const result = price(usage({ total_input }));
    assert.equal(result.status, 'complete');
    assert.equal(result.reason, '');
    assert.equal(result.officialCost, exact.officialCost);
  }
});

test('context-tier prices still require total input and preserve its estimation/completeness', () => {
  const extras = { family: 'anthropic', model: 'claude-opus-5' };
  const missing = price(usage({ total_input: field(null) }), extras);
  assert.equal(missing.status, 'unknown');
  assert.equal(missing.reason, 'context_usage_missing');
  assert.equal(missing.officialCost, null);
  for (const [total_input, reason] of [[field(2000, { completeness: 'partial' }), 'total_input_partial'],
    [field(2000, { availability: 'estimated', provenance: 'adapter_estimate' }), 'total_input_estimated']]) {
    const result = price(usage({ total_input }), extras);
    assert.equal(result.status, 'partial');
    assert.match(result.reason, new RegExp(reason));
  }
});

test('domain-valid separate reasoning absence makes the known cost partial; explicit zero is complete', async () => {
  const attempt = JSON.parse(await readFile(new URL('../contracts/fixtures/attempt-valid.json', import.meta.url), 'utf8'));
  const value = { ...attempt.terminal.usage, reasoning_relation: 'separate', reasoning: field(null) };
  assert.equal(validateUsage(value).valid, true);
  const missing = price(value);
  assert.equal(missing.status, 'partial');
  assert.match(missing.reason, /reasoning_missing/);
  const zero = price({ ...value, reasoning: field(0) });
  assert.equal(zero.status, 'complete');
  assert.equal(zero.officialCost, missing.officialCost);
  const separate = price({ ...value, reasoning: field(5) });
  assert.equal(separate.status, 'complete');
  assert.ok(Math.abs(separate.officialCost - zero.officialCost - 5 * 15 / 1_000_000) < 1e-15);
});

test('domain-valid subset reasoning uncertainty does not downgrade exact cost, while unknown relation stays partial', async () => {
  const attempt = JSON.parse(await readFile(new URL('../contracts/fixtures/attempt-valid.json', import.meta.url), 'utf8'));
  const base = attempt.terminal.usage, exact = price(base);
  for (const extra of [{ availability: 'estimated', provenance: 'adapter_estimate' }, { completeness: 'partial' }]) {
    const value = { ...base, reasoning: { ...base.reasoning, ...extra } };
    assert.equal(validateUsage(value).valid, true);
    const subset = price(value);
    assert.equal(subset.status, 'complete');
    assert.equal(subset.reason, '');
    assert.equal(subset.officialCost, exact.officialCost);
    const unknown = { ...value, reasoning_relation: 'unknown', reasoning: { ...value.reasoning, value: 0 } };
    assert.equal(validateUsage(unknown).valid, true);
    const uncertain = price(unknown);
    assert.equal(uncertain.status, 'partial');
    assert.match(uncertain.reason, /reasoning_(estimated|partial)/);
    assert.equal(uncertain.officialCost, exact.officialCost);
  }
});

test('prompt-only usage without cache figures is costed as all-uncached input, flagged as estimated', () => {
  const promptOnly = usage({ total_input: field(47057), input_uncached: field(null), cache_read: field(null),
    output_total: field(2721), reasoning: field(null) });
  const before = price(promptOnly);
  assert.equal(before.status, 'partial');
  assert.match(before.reason, /input_uncached_missing/);
  assert.equal(before.officialCost, (2721 * 15) / 1_000_000, 'raw usage prices the output only');
  const result = price(effectiveUsage(promptOnly));
  assert.equal(result.status, 'partial');
  assert.equal(result.officialCost, (47057 * 2.5 + 2721 * 15) / 1_000_000);
  assert.equal(result.normalizedInputTokens, 47057);
  assert.match(result.reason, /input_uncached_estimated/);
  assert.match(result.reason, /cache_read_estimated/);
  assert.doesNotMatch(result.reason, /_missing/);
});
