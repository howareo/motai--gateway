export function knownCount(field) {
  return field && ['known', 'estimated'].includes(field.availability)
    && Number.isSafeInteger(field.value) && field.value >= 0 ? field.value : null;
}

// Some upstreams (OpenAI-compatible ones that omit prompt_tokens_details.cached_tokens) report only the prompt total. The old
// New API billed that whole total as input, so costing and the request row treat it as "nothing was a cache hit":
// cache_read becomes an estimated 0 and input_uncached the total minus the known cache writes. Both are `estimated`, so the
// price stays `partial` with an `_estimated` reason and the cache hit rate (known fields only) is not dragged down by the zero.
// Returns a new object; any usage that does not fit this exact shape comes back unchanged.
export function effectiveUsage(usage) {
  if (knownCount(usage?.cache_read) !== null || knownCount(usage?.input_uncached) !== null) return usage;
  const total = knownCount(usage?.total_input);
  const writes = [usage?.cache_write?.ttl_5m, usage?.cache_write?.ttl_1h, usage?.cache_write?.ttl_unknown].map(knownCount);
  if (total === null || writes.some((value) => value === null)) return usage;
  const uncached = total - writes.reduce((sum, value) => sum + value, 0);
  if (uncached < 0) return usage;
  const { completeness } = usage.total_input;
  return { ...usage,
    cache_read: { value: 0, availability: 'estimated', provenance: 'inferred_zero', completeness },
    input_uncached: { value: uncached, availability: 'estimated', provenance: 'inferred', completeness } };
}

export function usageMetrics(usages) {
  const totals = { totalInput: 0, inputUncached: 0, cacheRead: 0, cacheWrite5m: 0,
    cacheWrite1h: 0, cacheWriteUnknown: 0, output: 0, reasoning: 0 };
  const paths = { totalInput: ['total_input'], inputUncached: ['input_uncached'], cacheRead: ['cache_read'],
    cacheWrite5m: ['cache_write', 'ttl_5m'], cacheWrite1h: ['cache_write', 'ttl_1h'],
    cacheWriteUnknown: ['cache_write', 'ttl_unknown'], output: ['output_total'], reasoning: ['reasoning'] };
  const coverage = Object.fromEntries(Object.keys(totals).map((key) => [key, { known: 0, absent: 0, estimated: 0, partial: 0 }]));
  let requests = 0, cacheKnownInput = 0, cacheKnownRead = 0, cacheKnownRequests = 0;
  for (const usage of usages) {
    requests += 1;
    for (const [key, path] of Object.entries(paths)) {
      const field = path.reduce((value, part) => value?.[part], usage);
      const value = knownCount(field);
      if (value === null) { coverage[key].absent += 1; continue; }
      if (!Number.isSafeInteger(totals[key] + value)) throw new RangeError('Usage sum exceeds safe integer range');
      totals[key] += value;
      coverage[key][field.availability] += 1;
      if (field.completeness === 'partial') coverage[key].partial += 1;
    }
    const input = knownCount(usage?.total_input), read = knownCount(usage?.cache_read);
    if (input > 0 && read !== null && read <= input
      && usage.total_input.availability === 'known' && usage.cache_read.availability === 'known'
      && usage.total_input.completeness === 'final' && usage.cache_read.completeness === 'final') {
      if (!Number.isSafeInteger(cacheKnownInput + input) || !Number.isSafeInteger(cacheKnownRead + read)) {
        throw new RangeError('Usage sum exceeds safe integer range');
      }
      cacheKnownInput += input;
      cacheKnownRead += read;
      cacheKnownRequests += 1;
    }
  }
  return { totals, coverage, requests, cacheKnownInput, cacheKnownRead, cacheKnownRequests,
    cacheHitRate: cacheKnownInput > 0 ? cacheKnownRead / cacheKnownInput : null };
}
