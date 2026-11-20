import test from 'node:test';
import assert from 'node:assert/strict';
import { effectiveUsage, usageMetrics } from '../src/usage-metrics.js';

const field = (value, extra = {}) => ({ value, availability: value === null ? 'absent' : 'known',
  completeness: 'final', provenance: value === null ? 'absent' : 'provider', ...extra });
// What the core reports for an OpenAI-compatible upstream that sends prompt_tokens/completion_tokens only.
const promptOnly = (overrides = {}) => ({ total_input: field(47057), input_uncached: field(null), cache_read: field(null),
  cache_write: { ttl_5m: field(0, { provenance: 'derived' }), ttl_1h: field(0, { provenance: 'derived' }),
    ttl_unknown: field(0, { provenance: 'derived' }) },
  output_total: field(2721), reasoning: field(null), reasoning_relation: 'subset_of_output', ...overrides });

test('a prompt total without cache figures becomes estimated all-uncached input and an estimated zero cache read', () => {
  const result = effectiveUsage(promptOnly());
  assert.deepEqual(result.cache_read, { value: 0, availability: 'estimated', provenance: 'inferred_zero', completeness: 'final' });
  assert.deepEqual(result.input_uncached, { value: 47057, availability: 'estimated', provenance: 'inferred', completeness: 'final' });
  assert.equal(result.total_input.value, 47057);
  assert.equal(result.output_total.value, 2721);
});

test('known cache writes are taken out of the inferred uncached input and a partial total stays partial', () => {
  const result = effectiveUsage(promptOnly({ total_input: field(1000, { completeness: 'partial' }),
    cache_write: { ttl_5m: field(100), ttl_1h: field(50), ttl_unknown: field(0) } }));
  assert.equal(result.input_uncached.value, 850);
  assert.equal(result.input_uncached.completeness, 'partial');
  assert.equal(result.cache_read.completeness, 'partial');
});

test('usage that does not fit the prompt-only shape comes back as the same object', () => {
  const cases = {
    'cache read known': promptOnly({ cache_read: field(10) }),
    'cache read known as zero': promptOnly({ cache_read: field(0) }),
    'uncached input known': promptOnly({ input_uncached: field(500) }),
    'total missing': promptOnly({ total_input: field(null) }),
    'a cache write missing': promptOnly({ cache_write: { ttl_5m: field(0), ttl_1h: field(null), ttl_unknown: field(0) } }),
    'writes exceed the total': promptOnly({ total_input: field(100), cache_write: { ttl_5m: field(80), ttl_1h: field(30), ttl_unknown: field(0) } }),
    'no cache_write object': promptOnly({ cache_write: undefined }),
  };
  for (const [name, usage] of Object.entries(cases)) assert.equal(effectiveUsage(usage), usage, name);
  assert.equal(effectiveUsage(null), null);
  assert.equal(effectiveUsage(undefined), undefined);
});

test('an estimated cache read from an adapter is not overwritten', () => {
  const usage = promptOnly({ cache_read: field(5, { availability: 'estimated', provenance: 'adapter_estimate' }) });
  assert.equal(effectiveUsage(usage), usage);
});

test('effectiveUsage does not change its input', () => {
  const usage = promptOnly();
  const before = structuredClone(usage);
  const result = effectiveUsage(usage);
  assert.notEqual(result, usage);
  assert.deepEqual(usage, before);
  assert.equal(usage.cache_read.availability, 'absent');
  assert.equal(usage.input_uncached.availability, 'absent');
});

test('inferred fields count as input but never enter the cache hit rate', () => {
  const real = { ...promptOnly({ total_input: field(100), cache_read: field(40), input_uncached: field(60) }) };
  const metrics = usageMetrics([effectiveUsage(promptOnly()), effectiveUsage(real)]);
  assert.equal(metrics.totals.inputUncached, 47057 + 60);
  assert.equal(metrics.coverage.inputUncached.estimated, 1);
  assert.equal(metrics.coverage.cacheRead.estimated, 1);
  assert.equal(metrics.cacheKnownRequests, 1);
  assert.equal(metrics.cacheKnownInput, 100);
  assert.equal(metrics.cacheKnownRead, 40);
  assert.equal(metrics.cacheHitRate, 0.4);
  assert.equal(usageMetrics([effectiveUsage(promptOnly())]).cacheHitRate, null);
});
