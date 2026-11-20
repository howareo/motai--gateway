import { readFileSync } from 'node:fs';
import { gatewayPeriod } from '../calendar-periods.js';
import { channelTypeInfo } from '../channel-types.js';
import { effectiveUsage, knownCount } from '../usage-metrics.js';
import { GatewayError } from './client.js';
import { assertContract, channelPoolIds, channelPriority, orderedPoolChannels } from './schema.js';
import { DEFAULT_PROBE_INTERVAL_MINUTES } from '../channel-health-store.js';
import { probeTarget } from './probe-target.js';
import { inferredUsage, usageFamily } from './legacy-overview.js';
import { ruleAt } from '../cost-store.js';

const failedOutcomes = JSON.parse(readFileSync(new URL('../../contracts/v1/common.schema.json', import.meta.url), 'utf8'))
  .definitions.attempt_outcome.enum.filter((value) => value !== 'succeeded');
const cacheWriteKeys = ['cacheWrite5m', 'cacheWrite1h', 'cacheWriteUnknown'];
const allKnown = (summary, keys) => keys.some((key) => summary.coverage[key].known + summary.coverage[key].estimated > 0);
const tokenTotal = (summary) => allKnown(summary, ['totalInput', 'output']) ? summary.totals.totalInput + summary.totals.output : null;
const knownTotal = (summary, key) => allKnown(summary, [key]) ? summary.totals[key] : null;
const costUnknown = (summary) => summary.costCoverage.unknown > 0 || summary.costCoverage.partial > 0
  || summary.currencies.length > 1 || summary.currencies.some((item) => item.procurementUnknown > 0);
const amount = (summary, key) => summary.currencies.length > 1 ? null
  : (key === 'procurementCost' ? summary.procurementCoverage : summary.costCoverage).unknown === summary.attempts && summary.attempts > 0 ? null
  : summary.currencies.length ? summary.currencies[0][key] : summary.attempts ? null : 0;

function trendPoint(summary) {
  return { time: summary.time, input: knownTotal(summary, 'inputUncached'), output: knownTotal(summary, 'output'),
    cacheRead: allKnown(summary, ['cacheRead']) ? summary.totals.cacheRead : null,
    cacheCreate: allKnown(summary, cacheWriteKeys) ? cacheWriteKeys.reduce((sum, key) => sum + summary.totals[key], 0) : null,
    requests: summary.requests, cacheKnownInput: summary.cacheKnownInput, cacheKnownRead: summary.cacheKnownRead,
    cacheKnownRequests: summary.cacheKnownRequests, cacheHitRate: summary.cacheHitRate };
}

// `count` is what the row's "次" shows: requests by default (probes excluded, as in the request-count card), probes for model tests.
function costRow(summary, count = summary.requests) {
  return { requests: count, tokens: tokenTotal(summary),
    estimatedCost: amount(summary, 'procurementCost'), officialCost: amount(summary, 'officialCost'),
    currencies: summary.currencies, costCoverage: summary.procurementCoverage, officialCostCoverage: summary.costCoverage,
    estimatedCostIsLowerBound: costUnknown(summary), priceSources: [] };
}

export function attemptToPanel(attempt, projection) {
  const row = projection.detail(attempt);
  const { intent, terminal } = attempt;
  const successful = terminal.request_outcome === 'succeeded';
  const usage = effectiveUsage(terminal.usage);
  const cacheFields = Object.values(terminal.usage.cache_write);
  const cacheValues = cacheFields.map(knownCount);
  const write = cacheValues.every((value) => value === null) ? null : cacheValues.reduce((sum, value) => sum + (value ?? 0), 0);
  return {
    id: intent.attempt_id, eventId: `${intent.source}:${intent.attempt_id}`, requestId: intent.request_id,
    source: intent.source, kind: successful ? 'success' : 'error', requestKind: intent.kind,
    createdAt: intent.started_at, createdTimestamp: Date.parse(intent.started_at) / 1000,
    channelId: intent.channel_id, channelName: intent.channel_name, providerFamily: intent.vendor,
    tokenName: intent.caller_id, model: intent.model_requested, canonicalModel: intent.model_canonical,
    reasoningEffort: intent.effort.value, thinkingBudget: intent.thinking_budget, group: intent.pool_id,
    stream: intent.stream, isModelTest: intent.kind === 'probe', inputTokens: knownCount(usage.input_uncached),
    rawInputTokens: knownCount(terminal.usage.total_input), outputTokens: knownCount(terminal.usage.output_total),
    cacheReadTokens: knownCount(usage.cache_read), cacheReadInferred: usage !== terminal.usage, cacheCreateTokens: write,
    cacheCreateTokens5m: knownCount(terminal.usage.cache_write.ttl_5m),
    cacheCreateTokens1h: knownCount(terminal.usage.cache_write.ttl_1h),
    cacheCreateTokensUnknown: knownCount(terminal.usage.cache_write.ttl_unknown),
    cacheInputTokens: row.cacheCount ? row.cacheInput : null,
    totalTokens: knownCount(terminal.usage.total_input) === null && knownCount(terminal.usage.output_total) === null
      ? null : row.tokens[0] + row.tokens[6],
    usageCoverage: row.availability, durationMs: terminal.duration_ms, ttftMs: terminal.ttft_ms,
    outputTokensPerSecond: successful && terminal.duration_ms > 0 && knownCount(terminal.usage.output_total) !== null
      ? terminal.usage.output_total.value / (terminal.duration_ms / 1000) : null,
    officialCost: row.officialCost, estimatedCost: row.procurement.cost, billedCost: null,
    costIsEstimate: Boolean(projection.costStore?.syncState?.(intent.channel_id)?.dailyCosts?.length),
    costStatus: row.procurement.multiplier === null ? 'unknown' : row.priceStatus,
    costStatusReason: row.procurement.multiplier === null ? 'cost_multiplier_missing' : row.priceReason,
    costMultiplier: row.procurement.multiplier, costRule: row.procurement.ruleId, currency: row.currency,
    costCoverage: row.priceStatus, channelRoute: [intent.channel_id], usedChannelIds: [intent.channel_id],
    failover: intent.attempt_no > 1, conversion: [], statusCode: terminal.upstream_status,
    errorCode: terminal.error_class,
    // The upstream's own words when the core kept them (sanitized, at most 512 runes); older attempts only have the class.
    errorMessage: successful ? null : (terminal.error_detail || terminal.error_class || terminal.attempt_outcome),
    requestOutcome: terminal.request_outcome, attemptOutcome: terminal.attempt_outcome,
    cooldownTriggered: terminal.channel_effect === 'cooldown',
  };
}

const GATEWAY_CHUNK = 100;
const PROBE_WINDOW_MS = 24 * 3_600_000;
const TOKEN_ORDER = ['totalInput', 'inputUncached', 'cacheRead', 'cacheWrite5m', 'cacheWrite1h', 'cacheWriteUnknown', 'output', 'reasoning'];
const invalidContract = () => new GatewayError('invalid_contract', 400);

// The merged cursor is opaque to the browser: it carries the gateway chunk cursor plus how many rows of that chunk are used,
// and the (time, id) key of the last old-history row shown. Nothing in it is trusted before the shape check below.
const encodeCursor = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
function decodeCursor(text) {
  if (!text) return null;
  let value;
  try { value = JSON.parse(Buffer.from(String(text), 'base64url').toString('utf8')); } catch { throw invalidContract(); }
  const { g, l } = value ?? {};
  const valid = value?.v === 1 && (value.s === null || typeof value.s === 'string') && g && typeof g === 'object'
    && (g.c === null || typeof g.c === 'string') && Number.isSafeInteger(g.o) && g.o >= 0 && typeof g.d === 'boolean'
    && (l === null || (l && typeof l === 'object' && Number.isSafeInteger(l.at) && typeof l.id === 'string'))
    && (value.r === undefined || (value.r === true && Number.isSafeInteger(value.n) && value.n >= 0));
  if (!valid) throw invalidContract();
  return value;
}

// One old-history row in the same shape attemptToPanel produces. Cost reuses the legacy overview's per-row price;
// failed old requests are never costed (03cb7e5).
export function legacyToPanel(row, { models, channels, legacy, costStore }) {
  const { counters } = row, ok = row.type === 2;
  const channelId = row.channelId === null ? null : String(row.channelId);
  const configured = (row.model && models.get(row.model)?.vendor) || null;
  const price = ok ? legacy.rowPrice(row, models).price : { status: 'unknown', reason: 'legacy_failed_not_costed', officialCost: null, currency: null };
  const rule = ok && channelId !== null && row.model ? ruleAt(costStore, { channelId, model: row.model }, row.createdTimestamp) : null;
  const multiplier = rule && Number.isFinite(rule.multiplier) ? rule.multiplier : null;
  const official = price.status === 'unknown' ? null : price.officialCost;
  const known = (key) => counters[key] !== null && counters[key] !== undefined;
  const value = (key) => known(key) ? counters[key] : null;
  let total = value('totalInput') === null && value('output') === null ? null : (value('totalInput') ?? 0) + (value('output') ?? 0);
  // A row without a recorded usage convention gets the figures the old console computed from the channel type.
  const channelVendor = channelId === null ? null : channels.get(channelId)?.vendor ?? null;
  const inferred = ok && row.semantics === 'unknown'
    ? inferredUsage(row, usageFamily(row, channelVendor), price.normalizedInput ?? null) : null;
  if (inferred) total = inferred.total;
  const coverage = TOKEN_ORDER.map((key) => (key !== 'reasoning' && (known(key) || (inferred && ['totalInput', 'inputUncached'].includes(key))) ? '1' : '0')).join('');
  const costKnown = ok && multiplier !== null && price.status !== 'unknown';
  // Old console (analytics.js): the route is admin_info.use_channel resolved to names (#id when unknown); without it, the final channel.
  const route = row.routeChannelIds?.length ? row.routeChannelIds : channelId === null ? [] : [channelId];
  // The old console showed the channel name stored in the log when the channel is no longer configured.
  const channelName = channelId === null ? null : channels.get(channelId)?.name ?? (row.channelName || `#${channelId}`);
  // A failed row's path is its own channel name; a succeeded row's path maps every channel id to a name (#id when unknown).
  const routeNames = ok ? route.map((id) => channels.get(String(id))?.name ?? `#${id}`) : channelName === null ? [] : [channelName];
  // Failed rows had no reasoning effort, transport or timings in the old console.
  const durationMs = ok ? value('durationMs') : null, ttftMs = ok ? value('ttftMs') : null;
  // Failed rows showed their error text instead of tokens in the old console.
  const failedNull = (number) => (ok ? number : null);
  return {
    id: row.recordId, eventId: row.recordId, requestId: row.recordId, source: 'legacy', kind: ok ? 'success' : 'error',
    requestKind: 'model', createdAt: row.createdAt, createdTimestamp: row.createdTimestamp, channelId,
    channelName,
    providerFamily: configured ?? (channelId !== null ? channels.get(channelId)?.vendor : null) ?? 'unknown', tokenName: row.tokenName ?? '',
    model: row.model, canonicalModel: row.model, reasoningEffort: row.reasoningEffort ?? null, thinkingBudget: null,
    group: row.group ?? '', stream: ok ? row.stream : null,
    isModelTest: false, inputTokens: failedNull(inferred ? inferred.input : value('inputUncached')),
    rawInputTokens: failedNull(inferred ? inferred.raw : value('totalInput')), outputTokens: failedNull(value('output')),
    cacheReadTokens: failedNull(value('cacheRead')), cacheReadInferred: false, cacheCreateTokens: failedNull(value('cacheWriteTotal')),
    cacheCreateTokens5m: failedNull(value('cacheWrite5m')), cacheCreateTokens1h: failedNull(value('cacheWrite1h')),
    cacheCreateTokensUnknown: failedNull(value('cacheWriteUnknown')),
    cacheInputTokens: failedNull(inferred ? inferred.cacheInput : known('cacheRead') ? value('totalInput') : null),
    totalTokens: failedNull(total), usageCoverage: coverage,
    durationMs, ttftMs,
    // Old console: no rate for a stream that ended with an error status (completeness 'partial').
    outputTokensPerSecond: ok && row.completeness !== 'partial' && counters.durationMs > 0 && counters.output > 0
      ? counters.output / (counters.durationMs / 1000) : null,
    officialCost: official, estimatedCost: costKnown ? official * multiplier : null, billedCost: null,
    costStatus: !ok || multiplier === null ? 'unknown' : price.status,
    costStatusReason: !ok ? price.reason : multiplier === null ? 'cost_multiplier_missing' : price.reason,
    costMultiplier: multiplier, costRule: rule?.id ?? null, currency: price.currency,
    costCoverage: !ok ? 'unknown' : price.status, channelRoute: routeNames,
    usedChannelIds: route, failover: route.length > 1, conversion: [], statusCode: ok ? null : row.statusCode ?? null, errorCode: null,
    errorMessage: ok ? null : row.errorMessage || null, requestOutcome: ok ? 'succeeded' : 'failed', attemptOutcome: ok ? 'succeeded' : 'upstream_failed',
    cooldownTriggered: false,
  };
}

// Which old-history rows a request filter takes; the list and the totals above it must agree, so both use this.
function legacyAccept({ channel, model, pool, status, stream }) {
  return (row) => !pool && (!channel || String(row.channelId) === channel) && (!model || row.model === model)
    && (!status || (status === 'success') === (row.type === 2))
    && (!stream || (stream === 'failover' ? (row.routeChannelIds?.length ?? 0) > 1 : row.stream === (stream === 'stream')));
}

// Old channel ids as they appear in the configuration: the name and the vendor of the channel's first model.
function legacyChannels(config, models) {
  return new Map(config.channels.map((row) => [String(row.id), { name: row.name, vendor: models.get(row.models[0]?.modelId)?.vendor ?? null }]));
}

export class GatewayPanel {
  constructor({ control, projection, costStore, healthStore, walletStore, legacy = null, now = () => Date.now(),
    isManualProbe = () => false }) {
    this.control = control; this.projection = projection; this.costStore = costStore;
    this.healthStore = healthStore; this.walletStore = walletStore; this.legacy = legacy; this.now = now;
    this.isManualProbe = isManualProbe;
  }

  // Start of "all": the old history window, else the first gateway day, else null (the 90-day fallback applies).
  earliestTimestamp() {
    const legacy = this.legacy?.earliest?.();
    if (Number.isFinite(legacy)) return legacy;
    let first = null;
    for (const day of this.projection.days?.keys?.() ?? []) {
      const at = Date.parse(`${day}T00:00:00+08:00`) / 1000;
      if (Number.isFinite(at) && (first === null || at < first)) first = at;
    }
    return first;
  }

  period(search) {
    const period = search.get('period') || (search.has('hours') ? '' : 'today');
    return gatewayPeriod({ period, hours: search.get('hours') || 24, nowMs: this.now(),
      allStartTimestamp: period.trim().toLowerCase() === 'all' ? this.earliestTimestamp() : null });
  }

  overview(search) {
    const period = this.period(search);
    const query = { from: period.from, to: period.to };
    const config = this.control.config();
    const state = this.projection.state();
    const bucketMs = period.hours <= 48 ? 3_600_000 : 86_400_000;
    // The trend charts real requests only: a probe every 15 minutes would otherwise draw cache hits into idle hours.
    const window = this.projection.readWindow(query, bucketMs, ['channelId'], { state, includeTotal: true, timelineFilter: { kind: 'model' } });
    const models = new Map(config.models.map((row) => [row.id, row]));
    // Old New API history is merged as extra buckets, so totals, channels, models and trends share one code path.
    const legacy = this.legacy?.overview(query, bucketMs, models, legacyChannels(config, models)) ?? null;
    const summaries = legacy ? [...window.summaries, ...legacy.summaries] : window.summaries;
    const timeline = this.legacy ? this.legacy.mergeTimeline(window.timeline, legacy, this.projection, state) : window.timeline;
    const totals = this.projection.summarize(summaries, query, state);
    const byChannel = new Map(this.projection.breakdown(query, ['channelId'], summaries, state).map((row) => [row.channelId, row]));
    const probeSummaries = summaries.filter((row) => row.meta.kind === 'probe');
    // Channel health is always the last 24 hours, whatever period the page shows; old New API history has no probes.
    const healthTo = this.now();
    const healthQuery = { from: new Date(healthTo - PROBE_WINDOW_MS).toISOString(), to: new Date(healthTo).toISOString() };
    const healthProbes = this.projection.summaries({ ...healthQuery, kind: 'probe' });
    const probesByChannel = new Map(this.projection.breakdown(healthQuery, ['channelId'], healthProbes, state).map((row) => [row.channelId, row]));
    const pools = new Map(config.pools.map((row) => [row.id, row]));
    // Requests the client abandoned (request_outcome "cancelled") did not succeed, so they stay in the failed counts, but they are
    // not upstream errors. Old New API summaries carry "failed"/"succeeded" only, so they never land here.
    const cancelledByChannel = new Map();
    let cancelled = 0;
    for (const row of summaries) {
      if (row.meta.kind === 'probe' || row.meta.requestOutcome !== 'cancelled') continue;
      cancelled += row.attempts;
      cancelledByChannel.set(row.meta.channelId, (cancelledByChannel.get(row.meta.channelId) ?? 0) + row.attempts);
    }
    const channelTrends = new Map(), trend = [];
    for (const row of timeline) {
      if (row.channelId === undefined) { trend.push(trendPoint(row)); continue; }
      if (!channelTrends.has(row.channelId)) channelTrends.set(row.channelId, []);
      channelTrends.get(row.channelId).push(trendPoint(row));
    }
    const channels = config.channels.map((channel) => {
      const summary = byChannel.get(channel.id) ?? this.projection.summarize([], query, state);
      const poolIds = channelPoolIds(channel);
      const poolRoles = poolIds.map((poolId) => {
        const ordered = orderedPoolChannels(config.channels, poolId);
        const peers = config.channels.filter((row) => channelPoolIds(row).includes(poolId) && row.enabled);
        const maximum = peers.length ? Math.max(...peers.map((row) => channelPriority(row, poolId))) : null;
        const priority = channelPriority(channel, poolId);
        return { poolId, routingPool: pools.get(poolId)?.name ?? poolId,
          priority, position: ordered.findIndex((row) => row.id === channel.id) + 1, poolSize: ordered.length,
          routeRole: !channel.enabled ? 'disabled' : priority === maximum ? 'primary' : 'fallback',
          isSolePrimary: channel.enabled && priority === maximum && peers.filter((row) => channelPriority(row, poolId) === maximum).length === 1 };
      });
      const pricing = this.costStore?.channelPricing?.(channel.id);
      const probes = probesByChannel.get(channel.id) ?? this.projection.summarize([], healthQuery, state);
      // Manual runs are told apart from scheduled ones by the ids this console submitted; the core does not record who asked.
      const recentProbes = channel.enabled ? this.projection.recentProbes({ ...healthQuery, channelId: channel.id })
        .map((probe) => this.isManualProbe(probe.attemptId) ? { ...probe, source: 'manual' } : probe) : [];
      const latest = recentProbes.at(-1);
      const health = { recentProbes, probePeriodHours: PROBE_WINDOW_MS / 3_600_000, probeSuccesses: channel.enabled ? probes.probesSucceeded : 0,
        probeFailures: channel.enabled ? probes.probes - probes.probesSucceeded : 0,
        probeAttempts: channel.enabled ? probes.probes : 0,
        probeSuccessRate: channel.enabled && probes.probes ? probes.probesSucceeded / probes.probes : null,
        probeAverageLatencyMs: channel.enabled && probes.durationCount ? probes.durationMs / probes.durationCount : null,
        lastProbeAt: latest?.checkedAt ?? null, lastProbeSuccess: latest?.success ?? null,
        lastProbeLatencyMs: latest?.latencyMs ?? null, lastProbeMessage: latest?.message ?? null,
        probeIntervalMinutes: this.healthStore?.probeIntervalMinutes ?? DEFAULT_PROBE_INTERVAL_MINUTES };
      const vendor = models.get(channel.models[0]?.modelId)?.vendor ?? null;
      return { id: channel.id, name: channel.name, enabled: channel.enabled, state: !channel.enabled ? 'disabled'
        : latest ? (latest.success ? (health.probeFailures > 0 ? 'recovered' : 'healthy') : 'failing') : 'unknown',
        type: channelTypeInfo(vendor)?.name ?? vendor, providerFamily: vendor,
        poolId: channel.poolId, poolIds: [...poolIds], poolPriorities: { ...channel.poolPriorities }, poolRoles, routingPool: pools.get(channel.poolId)?.name ?? channel.poolId,
        models: channel.models.map((row) => row.modelId), testModel: channel.testModel,
        probeModel: probeTarget(channel)?.modelId ?? null, probeProtocol: probeTarget(channel)?.protocol ?? null,
        priority: channel.priority, weight: channel.weight,
        position: poolRoles.find((row) => row.poolId === channel.poolId).position,
        poolSize: poolRoles.find((row) => row.poolId === channel.poolId).poolSize,
        routeRole: poolRoles.find((row) => row.poolId === channel.poolId).routeRole,
        isSolePrimary: poolRoles.find((row) => row.poolId === channel.poolId).isSolePrimary, configWeightShare: null,
        ...costRow(summary), attempts: summary.attempts, cooldowns: summary.cooldowns,
        errorCount: summary.requests - summary.requestsSucceeded - (cancelledByChannel.get(channel.id) ?? 0),
        costMultiplier: pricing?.multiplier ?? null, costSource: pricing?.source ?? 'missing',
        costLabel: pricing?.label ?? null, costModelOverrides: pricing?.modelOverrides ?? [], costSync: pricing?.sync ?? null,
        ...health, availabilitySuccesses: health.probeSuccesses, availabilityFailures: health.probeFailures,
        availabilityAttempts: health.probeAttempts, availabilityRate: health.probeSuccessRate,
        wallet: this.walletStore?.publicState(channel.id) ?? null };
    });
    // Cost of channels the configuration no longer has (deleted channels, channels of the old New API history). They stay out of
    // `channels` so the channel list gains no rows, but the cost distribution needs them to add up to the metric card.
    const configured = new Set(config.channels.map((channel) => String(channel.id)));
    const removedChannels = [...byChannel].filter(([id]) => id !== null && !configured.has(String(id)))
      .map(([id, summary]) => ({ id, name: `渠道 #${id}（已删除）`, providerFamily: null, ...costRow(summary) }));
    const currencies = totals.currencies.map((currency) => ({ ...currency }));
    return { generatedAt: new Date(this.now()).toISOString(), source: legacy ? { mode: 'gateway', legacy: legacy.info } : { mode: 'gateway' },
      periodKey: period.key, periodLabel: period.label, periodHours: period.hours,
      periodStartAt: period.from, periodEndAt: period.to, costVersion: this.costStore?.version ?? 0,
      projection: state, cacheStatus: totals.stale ? 'stale' : 'cached', cacheAgeMs: totals.staleMs,
      cacheError: totals.lastError, requestTotal: totals.requests, requestModels: [...models.keys()],
      metrics: { totalRequests: totals.requests, requests: totals.requestsSucceeded,
        failedRequests: totals.requests - totals.requestsSucceeded, cancelledRequests: cancelled,
        errorCount: totals.requests - totals.requestsSucceeded - cancelled,
        upstreamAttempts: totals.requests, inputTokens: knownTotal(totals, 'inputUncached'), outputTokens: knownTotal(totals, 'output'),
        totalTokens: tokenTotal(totals), cacheReadTokens: knownTotal(totals, 'cacheRead'),
        cacheCreateTokens: allKnown(totals, cacheWriteKeys) ? cacheWriteKeys.reduce((sum, key) => sum + totals.totals[key], 0) : null,
        estimatedCost: amount(totals, 'procurementCost'), officialCost: amount(totals, 'officialCost'),
        // `failovers`: only the old New API history changes channel inside one request; a gateway request is sent once.
        // `cooldowns`: attempts that tripped a channel cooldown, after which new requests use another channel.
        currencies, billedCost: null, cooldowns: totals.cooldowns,
        failovers: this.legacy?.failoverCount?.({ from: Math.ceil(Date.parse(period.from) / 1000), to: Math.ceil(Date.parse(period.to) / 1000) }) ?? 0,
        costCoverage: totals.procurementCoverage,
        officialCostCoverage: totals.costCoverage, usageCoverage: totals.coverage,
        estimatedCostIsLowerBound: costUnknown(totals), avgDurationMs: totals.durationCount ? totals.durationMs / totals.durationCount : null,
        avgTtftMs: totals.ttftCount ? totals.ttftMs / totals.ttftCount : null, ttftCount: totals.ttftCount,
        probes: totals.probes, probesSucceeded: totals.probesSucceeded },
      availability: { cacheRead: allKnown(totals, ['cacheRead']), cacheCreate: allKnown(totals, cacheWriteKeys),
        ttft: totals.ttftCount > 0, routeChain: false }, channels,
      models: this.projection.breakdown(query, ['modelId'], summaries, state).filter((row) => row.modelId !== null)
        .map((row) => ({ model: row.modelId, ...costRow(row) })),
      modelTests: this.projection.breakdown(query, ['channelId', 'modelId'], probeSummaries, state).map((row) => ({
        channelId: row.channelId, channelName: channels.find((channel) => channel.id === row.channelId)?.name ?? row.channelId,
        model: row.modelId, ...costRow(row, row.probes) })),
      removedChannels,
      trend,
      channelTrends: channels.map((channel) => ({ channelId: channel.id, channelName: channel.name,
        trend: channelTrends.get(channel.id) ?? [] })),
      latestError: null, logs: [], errors: [] };
  }

  // The first page also carries the total of the whole filtered result. Not with a stream filter: the projection does not keep
  // the transport of an attempt, and an inexact total is worse than none.
  async requests(search) {
    const page = await this.requestsPage(search);
    if (search.get('cursor') || search.get('stream')) return page;
    return { ...page, summary: this.requestSummary(search) };
  }

  requestSummary(search) {
    const period = this.period(search), status = search.get('status') || '';
    const channel = search.get('channel') || '', model = search.get('model') || '', pool = search.get('pool') || '';
    const from = search.get('from') || period.from, to = search.get('to') || period.to;
    const gateway = this.projection.requestTotals({ from, to, ...(channel && { channelId: channel }), ...(pool && { poolId: pool }),
      ...(model && { modelId: model }), outcomes: status === 'success' ? ['succeeded'] : status === 'error' ? failedOutcomes : [] });
    const costs = new Map(gateway.costs.map(({ currency, amount }) => [currency, amount]));
    const coverage = { ...gateway.coverage };
    let requests = gateway.requests;
    if (this.legacy) {
      const models = new Map(this.control.config().models.map((row) => [row.id, row]));
      const old = this.legacy.requestTotals({ from: Math.ceil(Date.parse(from) / 1000), to: Math.ceil(Date.parse(to) / 1000), models,
        accept: legacyAccept({ channel, model, pool, status, stream: '' }) });
      requests += old.requests;
      for (const key of Object.keys(coverage)) coverage[key] += old.coverage[key];
      for (const [currency, { amount }] of old.costs) costs.set(currency, (costs.get(currency) ?? 0) + amount);
    }
    return { requests, costs: [...costs].sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0)).map(([currency, amount]) => ({ currency, amount })),
      lowerBound: coverage.partial > 0 || coverage.unknown > 0, coverage };
  }

  async requestsPage(search) {
    const period = this.period(search);
    const status = search.get('status') || '';
    const stream = search.get('stream') || '';
    if (!['', 'success', 'error'].includes(status) || !['', 'stream', 'nonstream', 'failover'].includes(stream)) {
      throw new GatewayError('invalid_contract', 400);
    }
    const page = Number(search.get('page') || 1);
    if (!Number.isSafeInteger(page) || page < 1) throw new GatewayError('invalid_contract', 400);
    const limit = Number(search.get('limit') || 50);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new GatewayError('invalid_contract', 400);
    const reverse = search.get('last') === '1' || search.get('reverse') === '1';
    // "Auto switch" lists the old-history rows that changed channel inside one request, and the gateway attempts that tripped a
    // channel cooldown. Those are failed attempts, so the core is only asked for failed outcomes and the rest is filtered here.
    const query = { from: search.get('from') || period.from, to: search.get('to') || period.to, channel_id: search.get('channel') || null,
      pool_id: search.get('pool') || null, model_id: search.get('model') || null, kind: stream === 'failover' ? 'model' : null,
      outcomes: status === 'success' ? ['succeeded'] : status === 'error' || stream === 'failover' ? failedOutcomes : [],
      stream: stream === 'stream' || stream === 'nonstream' ? stream === 'stream' : null, snapshot_seq: search.get('snapshotSeq') || null,
      cursor: search.get('cursor') || null, limit, ...(reverse && { reverse: true, cooldown_only: stream === 'failover' }) };
    if (reverse || this.legacy || stream === 'failover') return this.mergedRequests({ search, period, page, limit, status, stream, query });
    assertContract('attempts_query', query);
    const response = await this.control.client.attempts(query);
    const items = response.attempts.map((attempt) => attemptToPanel(attempt, this.projection));
    return { generatedAt: new Date(this.now()).toISOString(), periodKey: period.key, periodLabel: period.label,
      periodStartAt: query.from, periodEndAt: query.to, mode: 'gateway', items, page, pageSize: limit,
      total: null, pageCount: null, hasMore: response.has_more, nextCursor: response.next_cursor,
      snapshotSeq: response.snapshot_seq, cacheStatus: 'fresh', recentCacheStatus: 'fresh',
      latestError: items.find((row) => row.kind === 'error' && row.requestOutcome !== 'cancelled') ?? null };
  }

  // Gateway attempts and old-history rows, newest first. Ties on the millisecond go to the gateway row; inside each source the
  // order is the source's own (gateway cursor order, old rows by time then id), so a page boundary never moves a row.
  async mergedRequests({ search, period, page, limit, status, stream, query }) {
    const state = decodeCursor(search.get('cursor'));
    const reverse = query.reverse === true;
    if (Boolean(state?.r) !== reverse && state) throw invalidContract();
    const config = this.control.config();
    const models = new Map(config.models.map((row) => [row.id, row]));
    const channels = legacyChannels(config, models);
    const gatewayQuery = { ...query, limit: GATEWAY_CHUNK };
    let snapshot = state?.s ?? search.get('snapshotSeq') ?? null;
    // A cooldown is always on a failed attempt, so "auto switch" together with "success only" leaves nothing on the gateway side.
    const onlyCooldown = stream === 'failover';
    let position = state ? { ...state.g } : { c: null, o: 0, d: onlyCooldown && status === 'success' }, chunk = null;
    const fetchChunk = async () => {
      const request = { ...gatewayQuery, cursor: position.c, snapshot_seq: snapshot };
      assertContract('attempts_query', request);
      chunk = await this.control.client.attempts(request);
      snapshot ??= chunk.snapshot_seq;
    };
    // Rows the cooldown filter drops are stepped over, so a sparse match keeps reading chunks until a row is found or the core runs out.
    const gatewayHead = async () => {
      while (!position.d) {
        if (!chunk) await fetchChunk();
        while (position.o >= chunk.attempts.length) {
          if (!chunk.has_more || !chunk.next_cursor) { position.d = true; return null; }
          position = { c: chunk.next_cursor, o: 0, d: false };
          await fetchChunk();
        }
        const head = chunk.attempts[position.o];
        if (!onlyCooldown || head.terminal.channel_effect === 'cooldown') return head;
        position.o += 1;
      }
      return null;
    };
    const accept = legacyAccept({ channel: search.get('channel') || '', model: search.get('model') || '', pool: search.get('pool') || '', status, stream });
    const legacyQuery = { from: Math.ceil(Date.parse(query.from) / 1000), to: Math.ceil(Date.parse(query.to) / 1000), accept };
    let total = state?.n ?? null, take = limit;
    if (reverse && !state) {
      if (!position.d) await fetchChunk();
      const gatewayTotal = position.d ? 0 : chunk.total;
      if (!Number.isSafeInteger(gatewayTotal) || gatewayTotal < 0) throw new GatewayError('gateway_invalid_response');
      total = gatewayTotal + (this.legacy?.requestTotals({ ...legacyQuery, models }).requests ?? 0);
      page = Math.max(1, Math.ceil(total / limit));
      take = total % limit || limit;
    }
    const legacyRows = this.legacy ? this.legacy.rowsBefore({ ...legacyQuery, after: state?.l ?? null, limit: take + 1, reverse }) : [];
    const items = [];
    let cursorLegacy = state?.l ?? null, used = 0;
    while (items.length < take) {
      const head = await gatewayHead(), old = legacyRows[used];
      if (!head && !old) break;
      if (head && (!old || (reverse ? Date.parse(head.intent.started_at) < old.createdTimestamp * 1000
        : Date.parse(head.intent.started_at) >= old.createdTimestamp * 1000))) {
        items.push(attemptToPanel(head, this.projection));
        position.o += 1;
      } else {
        items.push(legacyToPanel(old, { models, channels, legacy: this.legacy, costStore: this.costStore }));
        cursorLegacy = { at: old.createdTimestamp, id: old.recordId };
        used += 1;
      }
    }
    const hasMore = Boolean(await gatewayHead()) || used < legacyRows.length;
    const cursor = hasMore ? encodeCursor({ v: 1, s: snapshot, g: position, l: cursorLegacy, ...(reverse && { r: true, n: total }) }) : null;
    if (reverse) items.reverse();
    return { generatedAt: new Date(this.now()).toISOString(), periodKey: period.key, periodLabel: period.label,
      periodStartAt: query.from, periodEndAt: query.to, mode: 'gateway', items, page, pageSize: limit,
      total, pageCount: reverse ? Math.max(1, Math.ceil(total / limit)) : null, hasMore: reverse ? page < Math.ceil(total / limit) : hasMore,
      nextCursor: reverse ? null : cursor, ...(reverse && { reverse: true, previousCursor: cursor }),
      snapshotSeq: snapshot ?? this.projection.lastSeq, cacheStatus: 'fresh', recentCacheStatus: 'fresh',
      latestError: items.find((row) => row.kind === 'error' && row.source !== 'legacy' && row.requestOutcome !== 'cancelled') ?? null };
  }
}
