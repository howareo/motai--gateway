const MILLION = 1_000_000;

function categoryCost({ input, cacheRead, writes, output }, rates) {
  const writeCost = writes.reduce((sum, entry) => sum + entry.tokens * entry.rate, 0);
  return (input * rates.input + cacheRead * rates.cacheRead + writeCost + output * rates.output) / MILLION;
}

const OPENAI_SOURCE = 'https://developers.openai.com/api/docs/pricing';
const ANTHROPIC_SOURCE = 'https://platform.claude.com/docs/en/about-claude/pricing';

const PRICE_RECORDS = Object.freeze([
  {
    model: 'gpt-5.6-sol',
    family: 'openai',
    effectiveFrom: 0,
    effectiveTo: null,
    promptIncludesCache: true,
    maxContextTokens: null,
    rates: { input: 5, cacheRead: 0.5, cacheWrite: 6.25, output: 30 },
    sourceUrl: OPENAI_SOURCE,
    capturedAt: '2026-07-25',
  },
  {
    model: 'gpt-5.6-terra',
    family: 'openai',
    effectiveFrom: 0,
    effectiveTo: null,
    promptIncludesCache: true,
    maxContextTokens: null,
    rates: { input: 2.5, cacheRead: 0.25, cacheWrite: 3.125, output: 15 },
    sourceUrl: OPENAI_SOURCE,
    capturedAt: '2026-07-25',
  },
  {
    model: 'gpt-5.6-luna',
    family: 'openai',
    effectiveFrom: 0,
    effectiveTo: null,
    promptIncludesCache: true,
    maxContextTokens: null,
    rates: { input: 1, cacheRead: 0.1, cacheWrite: 1.25, output: 6 },
    sourceUrl: OPENAI_SOURCE,
    capturedAt: '2026-07-25',
  },
  {
    model: 'claude-fable-5',
    family: 'anthropic',
    effectiveFrom: Date.parse('2026-06-07T00:00:00Z') / 1000,
    effectiveTo: null,
    promptIncludesCache: false,
    maxContextTokens: 1_000_000,
    rates: { input: 10, cacheRead: 1, cacheWrite: 12.5, cacheWrite1h: 20, output: 50 },
    sourceUrl: ANTHROPIC_SOURCE,
    capturedAt: '2026-07-26',
    verifiedAt: '2026-07-26',
    tier: 'official',
    sourceLabel: '官方已核对',
    note: 'Assumes the published launch price applies from the model release date.',
  },
  {
    model: 'claude-opus-5',
    family: 'anthropic',
    effectiveFrom: 0,
    effectiveTo: null,
    promptIncludesCache: false,
    maxContextTokens: 200_000,
    rates: { input: 5, cacheRead: 0.5, cacheWrite: 6.25, cacheWrite1h: 10, output: 25 },
    sourceUrl: ANTHROPIC_SOURCE,
    capturedAt: '2026-07-25',
  },
  {
    model: 'claude-sonnet-5',
    family: 'anthropic',
    effectiveFrom: 0,
    effectiveTo: Date.parse('2026-09-01T00:00:00Z') / 1000,
    promptIncludesCache: false,
    maxContextTokens: 200_000,
    rates: { input: 1, cacheRead: 0.1, cacheWrite: 1.25, cacheWrite1h: 2, output: 5 },
    sourceUrl: ANTHROPIC_SOURCE,
    capturedAt: '2026-07-25',
  },
  {
    model: 'claude-sonnet-5',
    family: 'anthropic',
    effectiveFrom: Date.parse('2026-09-01T00:00:00Z') / 1000,
    effectiveTo: null,
    promptIncludesCache: false,
    maxContextTokens: 200_000,
    rates: { input: 1.5, cacheRead: 0.15, cacheWrite: 1.875, cacheWrite1h: 3, output: 7.5 },
    sourceUrl: ANTHROPIC_SOURCE,
    capturedAt: '2026-07-25',
  },
]);

function finiteToken(value) {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

export function resolveOfficialPrice(model, timestamp = Date.now() / 1000) {
  const at = Number(timestamp);
  return PRICE_RECORDS.find((record) => record.model === model
    && record.effectiveFrom <= at
    && (record.effectiveTo === null || at < record.effectiveTo)) || null;
}

function unknown(reason, record = null) {
  return {
    status: 'unknown',
    reason,
    officialCost: null,
    normalizedInputTokens: null,
    record,
  };
}

export function priceUsage({
  model,
  timestamp,
  family,
  inputTokens,
  outputTokens,
  cacheReadTokens,
  cacheCreateTokens,
  cacheCreateTokens5m,
  cacheCreateTokens1h,
  externalRecord = null,
}) {
  const officialRecord = resolveOfficialPrice(model, timestamp);
  let record = officialRecord || externalRecord;
  if (!record) return unknown('model_not_priced');
  if (family !== record.family) return unknown('protocol_mismatch', record);

  const rawInput = finiteToken(inputTokens);
  const output = finiteToken(outputTokens);
  const cacheRead = finiteToken(cacheReadTokens);
  const cacheCreate = finiteToken(cacheCreateTokens);
  const cacheCreate5m = finiteToken(cacheCreateTokens5m);
  const cacheCreate1h = finiteToken(cacheCreateTokens1h);
  if (rawInput === null || output === null) return unknown('base_usage_missing', record);

  const partialReasons = [];
  const pricedCacheRead = cacheRead ?? 0;
  const pricedCacheCreate = cacheCreate ?? 0;
  if (cacheRead === null) partialReasons.push('cache_read_missing');
  if (cacheCreate === null) partialReasons.push('cache_write_missing');

  let normalizedInput = rawInput;
  if (record.promptIncludesCache) {
    normalizedInput = rawInput - pricedCacheRead - pricedCacheCreate;
    if (normalizedInput < 0) return unknown('cache_exceeds_prompt', record);
  }

  const contextTokens = record.promptIncludesCache
    ? rawInput
    : rawInput + pricedCacheRead + pricedCacheCreate;
  if (record.maxContextTokens !== null && contextTokens > record.maxContextTokens) {
    const syncedSupportsContext = externalRecord
      && externalRecord !== record
      && externalRecord.family === family
      && (externalRecord.maxContextTokens === null || contextTokens <= externalRecord.maxContextTokens);
    if (syncedSupportsContext) {
      record = externalRecord;
    } else {
      return unknown('unsupported_context_tier', record);
    }
  }

  const writes = [];
  if (pricedCacheCreate > 0) {
    const cacheWriteRate = Number(record.rates?.cacheWrite);
    if (!Number.isFinite(cacheWriteRate) || cacheWriteRate < 0) {
      partialReasons.push('cache_write_unpriced');
    }
    if (cacheCreate5m !== null || cacheCreate1h !== null) {
      const known5m = cacheCreate5m ?? 0;
      const known1h = cacheCreate1h ?? 0;
      if (known5m + known1h > pricedCacheCreate) return unknown('cache_write_breakdown_invalid', record);
      const unresolved = pricedCacheCreate - known5m - known1h;
      const rawCacheWrite1hRate = record.rates.cacheWrite1h;
      const cacheWrite1hRate = rawCacheWrite1hRate === null || rawCacheWrite1hRate === undefined
        ? null
        : Number(rawCacheWrite1hRate);
      writes.push({ tokens: known5m, rate: Number.isFinite(cacheWriteRate) ? cacheWriteRate : 0 },
        { tokens: known1h, rate: cacheWrite1hRate !== null && Number.isFinite(cacheWrite1hRate) ? cacheWrite1hRate : 0 },
        { tokens: unresolved, rate: Number.isFinite(cacheWriteRate) ? cacheWriteRate : 0 });
      if (known1h > 0 && (cacheWrite1hRate === null || !Number.isFinite(cacheWrite1hRate))) {
        partialReasons.push('cache_write_1h_unpriced');
      }
      if (unresolved > 0 && record.family === 'anthropic') partialReasons.push('cache_write_ttl_missing');
    } else {
      writes.push({ tokens: pricedCacheCreate, rate: Number.isFinite(cacheWriteRate) ? cacheWriteRate : 0 });
      if (record.family === 'anthropic') partialReasons.push('cache_write_ttl_missing');
    }
  }

  const officialCost = categoryCost({ input: normalizedInput, cacheRead: pricedCacheRead, writes, output }, record.rates);

  return {
    status: partialReasons.length ? 'partial' : 'complete',
    reason: partialReasons.join(','),
    officialCost,
    normalizedInputTokens: normalizedInput,
    record,
  };
}

export function priceCanonical({ model, timestamp, family, usage, externalRecord = null }) {
  const at = timestamp ?? Date.now() / 1000;
  const matches = (record) => record && record.model === model && record.family === family
    && record.effectiveFrom <= at && (record.effectiveTo === null || at < record.effectiveTo);
  const official = resolveOfficialPrice(model, at);
  let record = matches(official) ? official : (matches(externalRecord) ? externalRecord : null);
  if (!record) return unknown('model_not_priced');
  const reasons = [];
  const count = (field, name, required = true) => {
    if (!field || !['known', 'estimated'].includes(field.availability)
      || !Number.isSafeInteger(field.value) || field.value < 0) {
      if (required) reasons.push(`${name}_missing`);
      return null;
    }
    if (field.availability === 'estimated') reasons.push(`${name}_estimated`);
    if (field.completeness !== 'final') reasons.push(`${name}_partial`);
    return field.value;
  };
  const context = record.maxContextTokens === null ? null : count(usage?.total_input, 'total_input');
  if (record.maxContextTokens !== null && (context === null || context > record.maxContextTokens)) {
    if (matches(externalRecord) && context !== null
      && (externalRecord.maxContextTokens === null || context <= externalRecord.maxContextTokens)) record = externalRecord;
    else return unknown(context === null ? 'context_usage_missing' : 'unsupported_context_tier', record);
  }
  const rawInput = count(usage?.input_uncached, 'input_uncached');
  const rawRead = count(usage?.cache_read, 'cache_read');
  const rawOutput = count(usage?.output_total, 'output');
  const rawWrites = [
    ['cache_write_5m', usage?.cache_write?.ttl_5m, 'cacheWrite'],
    ['cache_write_1h', usage?.cache_write?.ttl_1h, 'cacheWrite1h'],
    ['cache_write_unknown', usage?.cache_write?.ttl_unknown, 'cacheWriteUnknown'],
  ].map(([name, field, rate]) => ({ name, value: count(field, name), rate }));
  const rate = (name, tokens, reason) => {
    const value = record.rates?.[name];
    if (typeof value === 'number' && Number.isFinite(value) && value >= 0) return value;
    if (tokens > 0) reasons.push(`${reason}_unpriced`);
    return 0;
  };
  const known = [rawInput, rawRead, rawOutput, ...rawWrites.map((entry) => entry.value)];
  if (known.every((value) => value === null)) return unknown('base_usage_missing', record);
  let output = rawOutput ?? 0;
  const reasoning = usage?.reasoning_relation === 'subset_of_output' ? null
    : count(usage?.reasoning, 'reasoning', usage?.reasoning_relation === 'separate');
  if (reasoning !== null && reasoning > 0) {
    if (usage.reasoning_relation === 'separate') {
      if (!Number.isSafeInteger(output + reasoning)) return unknown('usage_overflow', record);
      output += reasoning;
    } else if (usage.reasoning_relation !== 'subset_of_output') reasons.push('reasoning_relation_unknown');
  }
  const rates = { input: rate('input', rawInput, 'input'), cacheRead: rate('cacheRead', rawRead, 'cache_read'),
    output: rate('output', output, 'output') };
  const writes = rawWrites.map(({ name, value, rate: rateName }) => ({ tokens: value ?? 0, rate: rate(rateName, value, name) }));
  const officialCost = categoryCost({ input: rawInput ?? 0, cacheRead: rawRead ?? 0, writes, output }, rates);
  if (!Number.isFinite(officialCost)) return unknown('cost_overflow', record);
  return { status: reasons.length ? 'partial' : 'complete', reason: [...new Set(reasons)].join(','),
    officialCost, normalizedInputTokens: rawInput, record, currency: record.currency || 'USD' };
}

export { PRICE_RECORDS };
