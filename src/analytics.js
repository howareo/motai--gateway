import { channelTypeInfo, channelTypeName, modelProviderPool, routingPoolLabel } from './channel-types.js';
import { ruleAt } from './cost-store.js';
import { priceUsage } from './model-pricing.js';

function number(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function parseOther(value) {
  if (!value) return {};
  if (typeof value === 'object') return value;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function isModelTestLog(log) {
  return String(log.token_name || '').trim() === '模型测试'
    && String(log.content || '').trim() === '模型测试';
}

function asItems(value) {
  if (Array.isArray(value)) return value;
  return Array.isArray(value?.items) ? value.items : [];
}

function money(value) {
  return Math.round(value * 1e9) / 1e9;
}

function bucketTimestamp(timestamp, hours) {
  const interval = hours <= 48 ? 3600 : 86400;
  const offset = 8 * 3600;
  return new Date((Math.floor((timestamp + offset) / interval) * interval - offset) * 1000).toISOString();
}

function addTrendLog(points, bucket, log) {
  const point = points.get(bucket) || {
    time: bucket, input: 0, output: 0, cacheRead: null, cacheCreate: null, requests: 0,
    cacheKnownInput: 0, cacheKnownRead: 0, cacheKnownRequests: 0, cacheHitRate: null,
  };
  point.input += log.inputTokens;
  point.output += log.outputTokens;
  if (log.cacheReadTokens !== null) point.cacheRead = (point.cacheRead || 0) + log.cacheReadTokens;
  if (log.cacheCreateTokens !== null) point.cacheCreate = (point.cacheCreate || 0) + log.cacheCreateTokens;
  point.requests += 1;
  if (log.cacheInputTokens !== null) {
    point.cacheKnownInput += log.cacheInputTokens;
    point.cacheKnownRead += log.cacheReadTokens;
    point.cacheKnownRequests += 1;
  }
  point.cacheHitRate = point.cacheKnownInput > 0 ? point.cacheKnownRead / point.cacheKnownInput : null;
  points.set(bucket, point);
}

function normalizedType(channel) {
  return channelTypeName(channel.type);
}

function channelDefinition(value) {
  if (value && typeof value === 'object') return value;
  return channelTypeInfo(value);
}

export function normalizeLog(log, {
  channelNames = new Map(),
  channelTypes = new Map(),
  quotaPerUnit = 500000,
  costStore,
  modelPricingStore,
} = {}) {
  const other = parseOther(log.other);
  const adminInfo = parseOther(other.admin_info);
  const inputTokens = number(log.prompt_tokens);
  const outputTokens = number(log.completion_tokens);
  const cacheReadAvailable = Object.hasOwn(other, 'cache_tokens');
  const cacheCreateAvailable = ['cache_creation_tokens', 'cache_write_tokens'].some((key) => Object.hasOwn(other, key));
  const cacheReadTokens = cacheReadAvailable ? number(other.cache_tokens) : null;
  const cacheCreateTokens = cacheCreateAvailable
    ? number(other.cache_write_tokens ?? other.cache_creation_tokens)
    : null;
  const cacheCreateTokens5m = Object.hasOwn(other, 'cache_creation_tokens_5m')
    ? number(other.cache_creation_tokens_5m)
    : null;
  const cacheCreateTokens1h = Object.hasOwn(other, 'cache_creation_tokens_1h')
    ? number(other.cache_creation_tokens_1h)
    : null;
  const reasoningEffort = Object.hasOwn(other, 'reasoning_effort')
    ? String(other.reasoning_effort || '').trim().toLowerCase() || null
    : null;
  const rawTtft = number(other.frt, -1);
  const ttftMs = rawTtft >= 0 ? rawTtft : null;
  const durationMs = Number.isFinite(Number(log.use_time)) ? number(log.use_time) * 1000 : null;
  const streamStatus = parseOther(other.stream_status);
  // New API records whole seconds: this is approximate request throughput, including first-token wait.
  const outputTokensPerSecond = outputTokens > 0 && durationMs > 0
    && (!streamStatus.status || streamStatus.status === 'ok') && !streamStatus.errors?.length
    ? outputTokens * 1000 / durationMs : null;
  const usedChannelIds = Array.isArray(adminInfo.use_channel)
    ? adminInfo.use_channel.map((item) => number(item)).filter(Boolean)
    : [];
  const finalChannelId = number(log.channel);
  if (usedChannelIds.length === 0 && finalChannelId) usedChannelIds.push(finalChannelId);
  const channelRoute = usedChannelIds.map((id) => channelNames.get(id) || `#${id}`);
  const billedCost = quotaPerUnit > 0 ? number(log.quota) / quotaPerUnit : null;
  const createdTimestamp = number(log.created_at);
  const rule = ruleAt(costStore, log, createdTimestamp);
  const channelType = channelDefinition(channelTypes.get(finalChannelId));
  const semanticFamily = other.usage_semantic === 'anthropic'
    ? 'anthropic'
    : other.usage_semantic === 'openai'
      ? 'openai'
      : null;
  const providerFamily = channelType?.providerFamily || semanticFamily;
  const usageFamily = channelType?.usageFamily || semanticFamily;
  let pricingFamily = channelType ? channelType.pricingFamily : semanticFamily;
  let externalRecord = modelPricingStore?.resolve?.(log.model_name, createdTimestamp || undefined, pricingFamily) || null;
  if (!externalRecord && typeof modelPricingStore?.resolveOfficial === 'function') {
    externalRecord = modelPricingStore.resolveOfficial(log.model_name, createdTimestamp || undefined);
    if (externalRecord) {
      pricingFamily = externalRecord.family;
      // shortcut: OpenAI-compatible relays include cache in prompt; official Moonshot/GLM records do not. Upgrade if a relay reports them separately.
      if (usageFamily === 'openai' && !externalRecord.promptIncludesCache) {
        externalRecord = { ...externalRecord, promptIncludesCache: true };
      }
    }
  }
  const priced = priceUsage({
    model: log.model_name,
    timestamp: createdTimestamp || undefined,
    family: pricingFamily,
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheCreateTokens,
    cacheCreateTokens5m,
    cacheCreateTokens1h,
    externalRecord,
  });
  const officialCost = priced.officialCost;
  const estimatedCost = officialCost === null || !rule ? null : officialCost * rule.multiplier;
  const costStatus = !rule ? 'unknown' : priced.status;
  const fallbackNormalizedInput = inputTokens - (cacheReadTokens || 0) - (cacheCreateTokens || 0);
  const normalizedInputTokens = priced.normalizedInputTokens
    ?? (usageFamily === 'openai' && fallbackNormalizedInput >= 0 ? fallbackNormalizedInput : inputTokens);
  const totalTokens = usageFamily === 'openai'
    ? inputTokens + outputTokens
    : normalizedInputTokens + outputTokens + (cacheReadTokens || 0) + (cacheCreateTokens || 0);

  // Cache hit rate follows usage semantics, independently of price availability.
  const validToken = (value) => value !== null && value !== undefined && value !== ''
    && Number.isFinite(Number(value)) && Number(value) >= 0;
  const cacheInput = usageFamily === 'openai' ? inputTokens
    : usageFamily === 'anthropic' && validToken(other.cache_write_tokens ?? other.cache_creation_tokens)
      ? inputTokens + (cacheReadTokens || 0) + (cacheCreateTokens || 0) : null;
  const cacheInputTokens = validToken(log.prompt_tokens) && validToken(other.cache_tokens)
    && cacheInput !== null && cacheReadTokens <= cacheInput ? cacheInput : null;

  return {
    id: log.id,
    eventId: `success-${log.id}`,
    kind: 'success',
    success: true,
    statusCode: 200,
    errorMessage: null,
    requestId: log.request_id || '',
    createdAt: createdTimestamp ? new Date(createdTimestamp * 1000).toISOString() : null,
    createdTimestamp,
    channelId: finalChannelId || null,
    channelName: log.channel_name || channelNames.get(finalChannelId) || 'Unknown',
    username: log.username || '',
    tokenName: log.token_name || '',
    isModelTest: isModelTestLog(log),
    model: log.model_name || 'Unknown',
    reasoningEffort,
    group: log.group || '',
    stream: Boolean(log.is_stream),
    inputTokens: normalizedInputTokens,
    rawInputTokens: inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheCreateTokens,
    cacheInputTokens,
    cacheCreateTokens5m,
    cacheCreateTokens1h,
    totalTokens,
    durationMs,
    ttftMs,
    outputTokensPerSecond,
    billedCost: billedCost === null ? null : money(billedCost),
    officialCost: officialCost === null ? null : money(officialCost),
    estimatedCost: estimatedCost === null ? null : money(estimatedCost),
    billingAuditDelta: billedCost === null || officialCost === null ? null : money(billedCost - officialCost),
    costStatus,
    costStatusReason: !rule ? 'cost_multiplier_missing' : priced.reason,
    priceTier: priced.record?.tier || (priced.record ? 'official' : null),
    priceSource: priced.record?.sourceLabel || (priced.record ? '官方已核对' : null),
    priceSourceUrl: priced.record?.sourceUrl || null,
    priceEffectiveFrom: priced.record?.effectiveFrom ?? null,
    priceFirstObservedAt: priced.record?.firstObservedAt || null,
    costMultiplier: rule?.multiplier ?? null,
    costRule: rule?.label || null,
    channelRoute,
    usedChannelIds,
    failover: channelRoute.length > 1,
    conversion: Array.isArray(other.request_conversion) ? other.request_conversion : [],
    usageSemantic: other.usage_semantic || null,
    providerFamily,
  };
}

function parseStatusCode(content) {
  const value = String(content || '');
  const explicit = value.match(/status[_\s-]*code\s*[:=]\s*([1-5]\d{2})/i);
  if (explicit) return number(explicit[1]) || null;
  const generic = value.match(/\b([45]\d{2})\b/);
  return generic ? number(generic[1]) || null : null;
}

function cleanErrorMessage(content) {
  const value = String(content || '').trim();
  return value.replace(/^status[_\s-]*code\s*[:=]\s*[1-5]\d{2}\s*[,;:]?\s*/i, '').trim() || value;
}

export function normalizeError(error, {
  channelNames = new Map(),
  channelTypes = new Map(),
} = {}) {
  const createdTimestamp = number(error.created_at);
  const channelId = number(error.channel ?? error.channel_id) || null;
  const channelType = channelDefinition(channelTypes.get(channelId));
  const family = channelType?.providerFamily || null;
  const content = String(error.content || '').trim();
  const channelName = error.channel_name || channelNames.get(channelId) || (channelId ? `#${channelId}` : 'Unknown');

  return {
    id: error.id,
    eventId: `error-${error.id}`,
    kind: 'error',
    success: false,
    statusCode: parseStatusCode(content),
    errorMessage: cleanErrorMessage(content),
    requestId: error.request_id || '',
    createdAt: createdTimestamp ? new Date(createdTimestamp * 1000).toISOString() : null,
    createdTimestamp,
    channelId,
    channelName,
    username: error.username || '',
    tokenName: error.token_name || '',
    model: error.model_name || 'Unknown',
    reasoningEffort: null,
    group: error.group || '',
    stream: null,
    inputTokens: null,
    rawInputTokens: null,
    outputTokens: null,
    cacheReadTokens: null,
    cacheCreateTokens: null,
    cacheCreateTokens5m: null,
    cacheCreateTokens1h: null,
    totalTokens: null,
    durationMs: null,
    ttftMs: null,
    outputTokensPerSecond: null,
    billedCost: null,
    officialCost: null,
    estimatedCost: null,
    billingAuditDelta: null,
    costStatus: null,
    costStatusReason: null,
    costMultiplier: null,
    costRule: null,
    channelRoute: [channelName],
    usedChannelIds: channelId ? [channelId] : [],
    failover: false,
    conversion: [],
    usageSemantic: null,
    providerFamily: family,
  };
}

export function buildOverview({
  channels,
  logs,
  errors = [],
  status = {},
  hours = 24,
  periodKey = null,
  periodLabel = null,
  costStore,
  modelPricingStore,
}) {
  const channelItems = asItems(channels);
  const logItems = asItems(logs);
  const channelNames = new Map(channelItems.map((channel) => [number(channel.id), channel.name]));
  const channelTypes = new Map(channelItems.map((channel) => [number(channel.id), channelTypeInfo(channel.type)]));
  const quotaPerUnit = number(status.quota_per_unit, 500000);
  const normalizedLogs = logItems.map((log) => normalizeLog(log, {
    channelNames,
    channelTypes,
    quotaPerUnit,
    costStore,
    modelPricingStore,
  }));
  const normalizedErrors = asItems(errors).map((error) => normalizeError(error, { channelNames, channelTypes }));

  const metrics = normalizedLogs.reduce((result, log) => {
    result.requests += 1;
    result.inputTokens += log.inputTokens;
    result.outputTokens += log.outputTokens;
    result.cacheReadTokens += log.cacheReadTokens || 0;
    result.cacheCreateTokens += log.cacheCreateTokens || 0;
    result.totalTokens += log.totalTokens;
    result.billedCost += log.billedCost || 0;
    result.estimatedCost += log.estimatedCost || 0;
    result.costCoverage[log.costStatus] += 1;
    result.durationTotal += log.durationMs || 0;
    if (log.durationMs !== null) result.durationCount += 1;
    if (log.ttftMs !== null) {
      result.ttftTotal += log.ttftMs;
      result.ttftCount += 1;
    }
    if (log.failover) result.failovers += 1;
    return result;
  }, {
    requests: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreateTokens: 0,
    totalTokens: 0,
    billedCost: 0,
    estimatedCost: 0,
    durationTotal: 0,
    durationCount: 0,
    ttftTotal: 0,
    ttftCount: 0,
    failovers: 0,
    costCoverage: { complete: 0, partial: 0, unknown: 0 },
  });
  metrics.billedCost = money(metrics.billedCost);
  metrics.estimatedCost = money(metrics.estimatedCost);
  metrics.avgDurationMs = metrics.durationCount ? Math.round(metrics.durationTotal / metrics.durationCount) : null;
  metrics.avgTtftMs = metrics.ttftCount ? Math.round(metrics.ttftTotal / metrics.ttftCount) : null;
  const successfulRequestIds = new Set(normalizedLogs.map((log) => log.requestId).filter(Boolean));
  const failedRequestKeys = new Set(normalizedErrors
    .filter((error) => !error.requestId || !successfulRequestIds.has(error.requestId))
    .map((error) => error.requestId || `error-${error.id}`));
  metrics.errorCount = normalizedErrors.length;
  metrics.failedRequests = failedRequestKeys.size;
  metrics.totalRequests = metrics.requests + metrics.failedRequests;
  metrics.upstreamAttempts = metrics.requests + metrics.errorCount;
  metrics.upstreamErrorRate = metrics.upstreamAttempts ? metrics.errorCount / metrics.upstreamAttempts : 0;
  metrics.estimatedCostIsLowerBound = metrics.costCoverage.partial > 0 || metrics.costCoverage.unknown > 0;

  const channelStats = new Map(channelItems.map((channel) => [number(channel.id), {
    requests: 0,
    tokens: 0,
    attempts: 0,
    failovers: 0,
    billedCost: 0,
    estimatedCost: 0,
    costCoverage: { complete: 0, partial: 0, unknown: 0 },
    lastUsedAt: null,
    lastSuccessAt: null,
    errorCount: 0,
    lastErrorAt: null,
    lastErrorStatus: null,
    lastErrorMessage: null,
    attemptKeys: new Set(),
    recentResults: [],
  }]));
  for (const log of normalizedLogs) {
    const final = channelStats.get(log.channelId);
    if (final) {
      final.requests += 1;
      final.tokens += log.totalTokens;
      final.billedCost += log.billedCost || 0;
      final.estimatedCost += log.estimatedCost || 0;
      final.costCoverage[log.costStatus] += 1;
      if (!final.lastSuccessAt || log.createdTimestamp > final.lastSuccessAt) {
        final.lastSuccessAt = log.createdTimestamp;
        final.lastUsedAt = log.createdAt;
      }
      final.recentResults.push({
        eventId: log.eventId,
        success: true,
        statusCode: 200,
        model: log.model,
        createdAt: log.createdAt,
        createdTimestamp: log.createdTimestamp,
      });
    }
    const requestKey = log.requestId || `success-${log.id}`;
    for (const id of log.usedChannelIds) {
      const stat = channelStats.get(id);
      if (stat) stat.attemptKeys.add(`${requestKey}:${id}`);
    }
    if (log.failover && final) final.failovers += 1;
  }
  for (const error of normalizedErrors) {
    const stat = channelStats.get(error.channelId);
    if (!stat) continue;
    stat.errorCount += 1;
    stat.attemptKeys.add(`${error.requestId || `error-${error.id}`}:${error.channelId}`);
    stat.recentResults.push({
      eventId: error.eventId,
      success: false,
      statusCode: error.statusCode,
      model: error.model,
      createdAt: error.createdAt,
      createdTimestamp: error.createdTimestamp,
    });
    if (!stat.lastErrorAt || error.createdTimestamp > stat.lastErrorAt) {
      stat.lastErrorAt = error.createdTimestamp;
      stat.lastErrorStatus = error.statusCode;
      stat.lastErrorMessage = error.errorMessage;
    }
  }

  const channelRows = channelItems.map((channel) => {
    const stat = channelStats.get(number(channel.id));
    const enabled = number(channel.status) === 1;
    const models = String(channel.models || '').split(',').map((item) => item.trim()).filter(Boolean);
    const availabilityAttempts = stat.requests + stat.errorCount;
    const recentResults = stat.recentResults
      .slice()
      .sort((left, right) => left.createdTimestamp - right.createdTimestamp || String(left.eventId).localeCompare(String(right.eventId)))
      .slice(-60)
      .map(({ createdTimestamp, eventId, ...result }) => result);
    const pricing = costStore?.channelPricing?.(channel.id) || {
      multiplier: null,
      source: 'missing',
      label: null,
      modelOverrides: [],
    };
    return {
      id: number(channel.id),
      name: channel.name,
      type: normalizedType(channel),
      providerFamily: channelTypeInfo(channel.type)?.providerFamily || null,
      enabled,
      state: !enabled
        ? 'disabled'
        : stat.errorCount === 0
          ? 'healthy'
          : stat.lastSuccessAt && stat.lastSuccessAt > stat.lastErrorAt
            ? 'recovered'
            : 'failing',
      weight: number(channel.weight),
      priority: number(channel.priority),
      responseTimeMs: number(channel.response_time),
      balance: Number.isFinite(Number(channel.balance)) ? number(channel.balance) : null,
      models,
      testModel: String(channel.test_model || '').trim() || models[0] || '',
      requests: stat.requests,
      tokens: stat.tokens,
      attempts: stat.attemptKeys.size,
      availabilitySuccesses: stat.requests,
      availabilityFailures: stat.errorCount,
      availabilityAttempts,
      availabilityRate: availabilityAttempts ? stat.requests / availabilityAttempts : null,
      recentResults,
      failovers: stat.failovers,
      errorCount: stat.errorCount,
      lastErrorAt: stat.lastErrorAt ? new Date(stat.lastErrorAt * 1000).toISOString() : null,
      lastErrorStatus: stat.lastErrorStatus,
      lastErrorMessage: stat.lastErrorMessage,
      billedCost: money(stat.billedCost),
      estimatedCost: money(stat.estimatedCost),
      costCoverage: stat.costCoverage,
      estimatedCostIsLowerBound: stat.costCoverage.partial > 0 || stat.costCoverage.unknown > 0,
      costMultiplier: pricing.multiplier,
      costSource: pricing.source,
      costLabel: pricing.label,
      costModelOverrides: pricing.modelOverrides,
      costSync: pricing.sync,
      lastUsedAt: stat.lastUsedAt,
    };
  });

  const pools = new Map();
  const poolKeyOf = (row) => modelProviderPool(row.models, channelTypeInfo(row.type)?.routingPool) || row.type;
  for (const row of channelRows.filter((channel) => channel.enabled)) {
    const key = poolKeyOf(row);
    const pool = pools.get(key) || { channels: [], requests: 0 };
    pool.channels.push(row);
    pool.requests += row.requests;
    pools.set(key, pool);
  }
  for (const row of channelRows) {
    const poolKey = poolKeyOf(row);
    const pool = pools.get(poolKey) || { channels: [], requests: 0 };
    const maxPriority = Math.max(...pool.channels.map((channel) => channel.priority), row.priority);
    const priorityPeers = pool.channels.filter((channel) => channel.priority === row.priority);
    const primaryPeers = pool.channels.filter((channel) => channel.priority === maxPriority);
    const peerWeight = priorityPeers.reduce((sum, channel) => sum + Math.max(0, channel.weight), 0);
    row.routeRole = !row.enabled ? 'disabled' : row.priority === maxPriority ? 'primary' : 'fallback';
    row.routingPool = routingPoolLabel(poolKey);
    row.poolRequests = pool.requests;
    row.poolTrafficShare = pool.requests ? row.requests / pool.requests : 0;
    row.showPoolTrafficShare = pool.requests >= 5;
    row.configWeightShare = priorityPeers.length > 1 && peerWeight > 0 ? row.weight / peerWeight : null;
    row.priorityPeerCount = row.enabled ? priorityPeers.length : 0;
    row.primaryPeerCount = row.enabled ? primaryPeers.length : 0;
    row.isSolePrimary = row.routeRole === 'primary' && primaryPeers.length === 1;
    row.hasPriorityFallback = pool.channels.some((channel) => channel.priority !== maxPriority);
    row.periodHours = hours;
  }

  const modelMap = new Map();
  const modelTestMap = new Map();
  const trendMap = new Map();
  const channelTrendMaps = new Map(channelItems.map((channel) => [number(channel.id), {
    channelId: number(channel.id), channelName: channel.name, points: new Map(),
  }]));
  for (const log of normalizedLogs) {
    const model = modelMap.get(log.model) || {
      model: log.model,
      requests: 0,
      tokens: 0,
      billedCost: 0,
      estimatedCost: 0,
      costCoverage: { complete: 0, partial: 0, unknown: 0 },
      priceSources: new Set(),
    };
    model.requests += 1;
    model.tokens += log.totalTokens;
    model.billedCost += log.billedCost || 0;
    model.estimatedCost += log.estimatedCost || 0;
    model.costCoverage[log.costStatus] += 1;
    if (log.priceSource) model.priceSources.add(log.priceSource);
    modelMap.set(log.model, model);

    if (log.isModelTest) {
      const key = `${log.channelId}:${log.model}`;
      const modelTest = modelTestMap.get(key) || {
        channelId: log.channelId,
        channelName: log.channelName,
        providerFamily: log.providerFamily,
        model: log.model,
        requests: 0,
        tokens: 0,
        estimatedCost: 0,
        costCoverage: { complete: 0, partial: 0, unknown: 0 },
        priceSources: new Set(),
      };
      modelTest.requests += 1;
      modelTest.tokens += log.totalTokens;
      modelTest.estimatedCost += log.estimatedCost || 0;
      modelTest.costCoverage[log.costStatus] += 1;
      if (log.priceSource) modelTest.priceSources.add(log.priceSource);
      modelTestMap.set(key, modelTest);
    }

    if (log.createdTimestamp) {
      const bucket = bucketTimestamp(log.createdTimestamp, hours);
      addTrendLog(trendMap, bucket, log);
      const channelTrend = channelTrendMaps.get(log.channelId) || {
        channelId: log.channelId, channelName: log.channelName, points: new Map(),
      };
      addTrendLog(channelTrend.points, bucket, log);
      channelTrendMaps.set(log.channelId, channelTrend);
    }
  }

  const models = [...modelMap.values()]
    .map((item) => ({
      ...item,
      billedCost: money(item.billedCost),
      estimatedCost: money(item.estimatedCost),
      estimatedCostIsLowerBound: item.costCoverage.partial > 0 || item.costCoverage.unknown > 0,
      priceSources: [...item.priceSources].sort(),
    }))
    .sort((left, right) => right.estimatedCost - left.estimatedCost || right.requests - left.requests || left.model.localeCompare(right.model));
  const modelTests = [...modelTestMap.values()]
    .map((item) => ({
      ...item,
      estimatedCost: money(item.estimatedCost),
      estimatedCostIsLowerBound: item.costCoverage.partial > 0 || item.costCoverage.unknown > 0,
      priceSources: [...item.priceSources].sort(),
    }))
    .sort((left, right) => right.estimatedCost - left.estimatedCost || right.requests - left.requests || left.channelName.localeCompare(right.channelName) || left.model.localeCompare(right.model));

  const events = normalizedErrors.length === 0
    ? normalizedLogs
    : [...normalizedLogs, ...normalizedErrors]
        .sort((left, right) => right.createdTimestamp - left.createdTimestamp || String(right.eventId).localeCompare(String(left.eventId)));
  const latestError = normalizedErrors
    .slice()
    .sort((left, right) => right.createdTimestamp - left.createdTimestamp || String(right.eventId).localeCompare(String(left.eventId)))[0] || null;

  return {
    generatedAt: new Date().toISOString(),
    source: { baseUrl: status.server_address || null, quotaPerUnit },
    periodHours: hours,
    periodKey,
    periodLabel,
    costVersion: costStore?.version ?? 0,
    metrics,
    availability: {
      cacheRead: normalizedLogs.some((log) => log.cacheReadTokens !== null),
      cacheCreate: normalizedLogs.some((log) => log.cacheCreateTokens !== null),
      ttft: normalizedLogs.some((log) => log.ttftMs !== null),
      routeChain: normalizedLogs.some((log) => log.channelRoute.length > 0),
    },
    channels: channelRows,
    models,
    modelTests,
    trend: [...trendMap.values()].sort((left, right) => left.time.localeCompare(right.time)),
    channelTrends: [...channelTrendMaps.values()].map(({ points, ...channel }) => ({
      ...channel,
      trend: [...points.values()].sort((left, right) => left.time.localeCompare(right.time)),
    })),
    logs: events,
    errors: normalizedErrors,
    latestError,
  };
}

export function filterRequestEvents(events, { channel = '', model = '', status = '', stream = '' } = {}) {
  const channelValue = String(channel || '');
  const modelValue = String(model || '');
  const statusValue = String(status || '');
  const streamValue = String(stream || '');
  return (Array.isArray(events) ? events : []).filter((log) => {
    if (channelValue && String(log.channelId) !== channelValue) return false;
    if (modelValue && log.model !== modelValue) return false;
    if (statusValue && log.kind !== statusValue) return false;
    if (streamValue === 'stream' && (log.kind !== 'success' || !log.stream)) return false;
    if (streamValue === 'nonstream' && (log.kind !== 'success' || log.stream)) return false;
    if (streamValue === 'failover' && (log.kind !== 'success' || !log.failover)) return false;
    return true;
  });
}

export { asItems, parseOther };

