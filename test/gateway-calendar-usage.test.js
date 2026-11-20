import test from 'node:test';
import assert from 'node:assert/strict';
import { gatewayPeriod, resolvePeriod, shanghaiDay } from '../src/calendar-periods.js';
import { usageMetrics } from '../src/usage-metrics.js';

const field = (value, availability = value === null ? 'absent' : 'known', completeness = 'final') =>
  ({ value, availability, completeness, provenance: value === null ? 'absent' : 'provider' });
const usage = (input, read) => ({ total_input: field(input), cache_read: field(read), output_total: field(2) });

test('Shanghai periods share UTC half-open intervals over month and year changes', () => {
  const nowMs = Date.parse('2027-01-01T00:04:05.999Z');
  const today = gatewayPeriod({ nowMs });
  assert.equal(today.from, '2026-12-31T16:00:00.000Z');
  assert.equal(today.to, '2027-01-01T00:04:05.000Z');
  const yesterday = gatewayPeriod({ nowMs, period: 'yesterday' });
  assert.equal(yesterday.from, '2026-12-30T16:00:00.000Z');
  assert.equal(yesterday.to, today.from);
  assert.equal(shanghaiDay(Date.parse('2026-10-26T16:00:00Z')), '2026-10-27');
  assert.equal(resolvePeriod({ nowMs, hours: 720 }).endTimestamp - resolvePeriod({ nowMs, hours: 720 }).startTimestamp, 720 * 3600);
});

test('cache hit rate weights only final known valid input and preserves other known usage', () => {
  const partial = usage(100, 80);
  partial.cache_read.completeness = 'partial';
  const estimated = usage(100, 99);
  estimated.total_input.availability = 'estimated';
  const result = usageMetrics([usage(100, 50), usage(900, 900), usage(0, 0), usage(10, 20), usage(null, null), partial, estimated]);
  assert.equal(result.cacheHitRate, 0.95);
  assert.equal(result.cacheKnownRequests, 2);
  assert.equal(result.totals.output, 14);
  assert.equal(result.coverage.totalInput.absent, 1);
  assert.equal(result.coverage.totalInput.estimated, 1);
  assert.equal(result.coverage.cacheRead.partial, 1);
  assert.equal(usageMetrics([usage(null, null)]).cacheHitRate, null);
});

test('usage totals reject overflow instead of rounding', () => {
  assert.throws(() => usageMetrics([usage(Number.MAX_SAFE_INTEGER, 1), usage(1, 0)]), RangeError);
});
