import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import http from 'node:http';
import path from 'node:path';
import { gzip } from 'node:zlib';
import { buildOverview, filterRequestEvents } from './analytics.js';
import { resolvePeriod } from './calendar-periods.js';
import { gatewayControlFromEnvironment } from './gateway/control.js';
import { callerKeyVaultFromEnvironment } from './gateway/caller-key-vault.js';
import { GatewayProjection } from './gateway/projection.js';
import { GatewayPanel } from './gateway/panel.js';
import { LegacyBackfill, LegacyOverview, legacyConfigFromEnvironment } from './gateway/legacy-overview.js';
import { GatewayUpstreamClient } from './gateway/upstream-client.js';
import { channelPoolIds } from './gateway/schema.js';
import { probeTarget } from './gateway/probe-target.js';
import { randomUUID } from 'node:crypto';
import {
  ChannelHealthStore,
  DEFAULT_PROBE_INTERVAL_MINUTES,
  MAX_PROBE_INTERVAL_MINUTES,
  MIN_PROBE_INTERVAL_MINUTES,
  normalizeProbeIntervalMinutes,
} from './channel-health-store.js';
import { CostStore, DEFAULT_COST_SYNC_INTERVAL_MINUTES, MIN_COST_SYNC_INTERVAL_MINUTES, MAX_COST_SYNC_INTERVAL_MINUTES, requireCostSyncIntervalMinutes } from './cost-store.js';
import { ModelPricingStore } from './model-pricing-store.js';
import { NewApiClient } from './new-api-client.js';
import { NewApiPricingSyncStore } from './new-api-pricing-sync-store.js';
import { LogCacheStore } from './log-cache-store.js';
import { WalletStore } from './wallet-store.js';
import { WalletService, channelOrigin } from './wallet-service.js';
import { channelRoutingPool, channelTypeInfo, routingPoolLabel, supportedChannelType } from './channel-types.js';

const PROJECT_ROOT = fileURLToPath(new URL('..', import.meta.url));
const PUBLIC_ROOT = path.join(PROJECT_ROOT, 'public');
const DEFAULT_COST_FILE = path.join(PROJECT_ROOT, 'data', 'cost-rules.json');
const DEFAULT_MODEL_PRICING_FILE = path.join(PROJECT_ROOT, 'data', 'model-pricing.json');
const DEFAULT_NEW_API_PRICING_SYNC_FILE = path.join(PROJECT_ROOT, 'data', 'new-api-pricing-sync.json');
const DEFAULT_WALLET_STATE_FILE = path.join(PROJECT_ROOT, 'data', 'wallet-state.json');
const DEFAULT_WALLET_CREDENTIALS_FILE = path.join(PROJECT_ROOT, 'data', 'wallet-credentials.json');
const DEFAULT_CHANNEL_HEALTH_FILE = path.join(PROJECT_ROOT, 'data', 'channel-health.json');
const DEFAULT_LOG_CACHE_FILE = path.join(PROJECT_ROOT, 'data', 'log-cache.json');
const DEFAULT_COST_SYNC_INTERVAL_MS = DEFAULT_COST_SYNC_INTERVAL_MINUTES * 60_000;
const DEFAULT_CHANNEL_HEALTH_INTERVAL_MS = DEFAULT_PROBE_INTERVAL_MINUTES * 60 * 1000;
const DEFAULT_CHANNEL_HEALTH_STARTUP_DELAY_MS = 10 * 1000;
// A manual probe the console waits for: total budget, and how often the projection is re-read while waiting.
const DEFAULT_MANUAL_PROBE_WAIT_MS = 60 * 1000;
const DEFAULT_MANUAL_PROBE_POLL_MS = 500;
const MANUAL_PROBE_MEMORY = 500;
// Gateway mode: one probe round this long after start, unless every probeable channel was probed less than one interval ago.
const DEFAULT_GATEWAY_PROBE_STARTUP_DELAY_MS = 30 * 1000;
const DEFAULT_MODEL_PRICING_SYNC_INTERVAL_MS = 24 * 60 * 60 * 1000;
const DEFAULT_MODEL_PRICING_CONFIRMATION_DELAY_MS = 10 * 60 * 1000;
const DEFAULT_OVERVIEW_CACHE_TTL_MS = 10 * 60 * 1000;
const DEFAULT_OVERVIEW_STALE_MAX_AGE_MS = 10 * 60 * 1000;
const TODAY_OVERVIEW_CACHE_TTL_MS = 2 * 60 * 1000;
const YESTERDAY_OVERVIEW_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const WEEK_OVERVIEW_CACHE_TTL_MS = 30 * 60 * 1000;
const MONTH_OVERVIEW_CACHE_TTL_MS = 2 * 60 * 60 * 1000;
const WEEK_OVERVIEW_STALE_MAX_AGE_MS = 60 * 60 * 1000;
const MONTH_OVERVIEW_STALE_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const RECENT_LOG_LIMIT = 100;
const RECENT_LOG_CACHE_TTL_MS = 5 * 1000;
const CHANNEL_LIST_CACHE_TTL_MS = 3000;
const RECENT_LOG_STALE_MAX_AGE_MS = 60 * 1000;
const LOG_SYNC_OVERLAP_SECONDS = 5 * 60;
const STATIC_FILES = new Map([
  ['/', 'index.html'],
  ['/index.html', 'index.html'],
  ['/app.js', 'app.js'],
  ['/styles.css', 'styles.css'],
  ['/motai-mark.svg', 'motai-mark.svg'],
  ['/shared/model-list.js', 'shared/model-list.js'],
  ['/channel-editor/state.js', 'channel-editor/state.js'],
  ['/channel-editor/model-picker.js', 'channel-editor/model-picker.js'],
  ['/channel-editor/gateway-session.js', 'channel-editor/gateway-session.js'],
  ['/channel-editor/gateway-editor.js', 'channel-editor/gateway-editor.js'],
  ['/channel-editor/billing.js', 'channel-editor/billing.js'],
  ['/caller-editor/session.js', 'caller-editor/session.js'],
  ['/caller-editor/editor.js', 'caller-editor/editor.js'],
  ['/caller-editor/clipboard.js', 'caller-editor/clipboard.js'],
]);
const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
};

function json(res, status, payload, headers = {}) {
  const body = JSON.stringify(payload);
  const send = (value, encoding = {}) => {
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
      ...headers,
      vary: [headers.vary, 'Accept-Encoding'].filter(Boolean).join(', '),
      ...encoding,
      'content-length': Buffer.byteLength(value),
    });
    res.end(value);
  };
  const encodings = new Map(String(res.req.headers['accept-encoding'] || '').split(',').map((entry) => {
    const [name, ...parameters] = entry.toLowerCase().split(';');
    const quality = parameters.find((parameter) => /^\s*q\s*=/.test(parameter));
    return [name.trim(), quality === undefined ? 1 : Number(quality.split('=')[1])];
  }));
  const gzipQuality = encodings.get('gzip') ?? encodings.get('*') ?? 0;
  if (Buffer.byteLength(body) >= 64 * 1024 && gzipQuality > 0 && gzipQuality <= 1) {
    gzip(body, { level: 1 }, (error, compressed) => {
      if (error) send(body);
      else send(compressed, { 'content-encoding': 'gzip' });
    });
  } else send(body);
}

function failure(res, status, message, code) {
  json(res, status, { error: { message, ...(code ? { code } : {}) } });
}

async function readJson(req, maxBytes = 256 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBytes) throw Object.assign(new Error('Request body is too large'), { statusCode: 413 });
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
  } catch {
    throw Object.assign(new Error('Request body must be valid JSON'), { statusCode: 400 });
  }
}

function channelId(pathname, action, opaque = false) {
  const match = pathname.match(new RegExp(`^/api/channels/(${opaque ? '[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}' : '\\d+'})/${action}$`));
  return match ? (opaque ? match[1] : Number(match[1])) : null;
}

function items(value) {
  if (Array.isArray(value)) return value;
  return Array.isArray(value?.items) ? value.items : [];
}

function requestOrigin(req, { allowRemote = false } = {}) {
  const host = String(req.headers.host || '');
  let parsed;
  try {
    parsed = new URL(`http://${host}`);
  } catch {
    throw Object.assign(new Error('Invalid Host header'), { statusCode: 400 });
  }
  if (!host || parsed.username || parsed.password || parsed.pathname !== '/' || parsed.search || parsed.hash) {
    throw Object.assign(new Error('Invalid Host header'), { statusCode: 400 });
  }
  if (!allowRemote && !['127.0.0.1', 'localhost', '::1', '[::1]'].includes(parsed.hostname)) {
    throw Object.assign(new Error('Host is not allowed'), { statusCode: 403 });
  }
  return `http://${parsed.host}`;
}

function requireJsonWrite(req, options = {}) {
  const expected = requestOrigin(req, options);
  if (req.headers.origin !== expected) {
    throw Object.assign(new Error('Write request origin is not allowed'), { statusCode: 403 });
  }
  const contentType = String(req.headers['content-type'] || '').split(';', 1)[0].trim().toLowerCase();
  if (contentType !== 'application/json') {
    throw Object.assign(new Error('Write requests require application/json'), { statusCode: 415 });
  }
}

function normalizeModels(value) {
  const source = Array.isArray(value) ? value : String(value || '').split(',');
  return [...new Set(source.map((model) => String(model).trim()).filter(Boolean))];
}

function routingPool(channel) {
  return channelRoutingPool(channel);
}

function affinityRuleForPool(pool) {
  if (pool === 'claude') return 'claude cli trace';
  if (pool === 'openai' || pool === 'xai') return 'codex cli trace';
  return null;
}

function boundedInteger(value, label, minimum, maximum) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw Object.assign(new Error(`${label} must be an integer between ${minimum} and ${maximum}`), { statusCode: 400 });
  }
  return parsed;
}

function normalizeChannelInput(payload) {
  const name = String(payload.name || '').trim();
  if (!name || name.length > 100) throw Object.assign(new Error('Channel name is required and must be at most 100 characters'), { statusCode: 400 });
  const type = Number(payload.type);
  if (!supportedChannelType(type)) throw Object.assign(new Error('Unsupported channel type'), { statusCode: 400 });
  const key = String(payload.key || '').trim();
  if (!key) throw Object.assign(new Error('API key is required'), { statusCode: 400 });
  let baseUrl;
  try {
    baseUrl = new URL(String(payload.baseUrl || '').trim());
  } catch {
    throw Object.assign(new Error('A valid upstream URL is required'), { statusCode: 400 });
  }
  if (baseUrl.protocol !== 'https:') throw Object.assign(new Error('Upstream URL must use HTTPS'), { statusCode: 400 });
  baseUrl.search = '';
  baseUrl.hash = '';
  baseUrl.pathname = baseUrl.pathname.replace(/\/+$/, '');
  const models = normalizeModels(payload.models);
  if (!models.length) throw Object.assign(new Error('At least one model is required'), { statusCode: 400 });
  const multiplier = Number(payload.multiplier);
  if (!Number.isFinite(multiplier) || multiplier < 0 || multiplier > 100) {
    throw Object.assign(new Error('Cost multiplier must be between 0 and 100'), { statusCode: 400 });
  }
  return {
    name,
    type,
    key,
    baseUrl: baseUrl.toString().replace(/\/$/, ''),
    models,
    priority: boundedInteger(payload.priority ?? 0, 'Priority', 0, 100000),
    weight: boundedInteger(payload.weight ?? 10, 'Weight', 0, 100000),
    multiplier,
    baseVersion: boundedInteger(payload.baseVersion, 'Cost version', 0, Number.MAX_SAFE_INTEGER),
  };
}

function normalizeChannelSettings(payload) {
  const multiplier = Number(payload.multiplier);
  if (!Number.isFinite(multiplier) || multiplier < 0 || multiplier > 100) {
    throw Object.assign(new Error('Cost multiplier must be between 0 and 100'), { statusCode: 400 });
  }
  const models = Object.hasOwn(payload, 'models') ? normalizeModels(payload.models) : null;
  if (models !== null && !models.length) {
    throw Object.assign(new Error('At least one model is required'), { statusCode: 400 });
  }
  if (models?.some((model) => model.length > 255)) {
    throw Object.assign(new Error('Model names must be at most 255 characters'), { statusCode: 400 });
  }
  return {
    weight: boundedInteger(payload.weight, 'Weight', 0, 100000),
    priority: boundedInteger(payload.priority, 'Priority', 0, 100000),
    multiplier,
    costSyncMode: payload.costSyncMode === 'auto' ? 'auto' : 'manual',
    models,
    testModel: Object.hasOwn(payload, 'testModel') ? String(payload.testModel || '').trim() : null,
    baseVersion: boundedInteger(payload.baseVersion, 'Cost version', 0, Number.MAX_SAFE_INTEGER),
  };
}

export function createApp({
  gatewayControl = gatewayControlFromEnvironment(),
  callerKeyVault,
  gatewayProjection,
  legacyConfig = gatewayControl ? legacyConfigFromEnvironment() : null,
  legacyClient,
  client,
  costStore,
  modelPricingStore,
  newApiPricingSyncStore,
  walletStore,
  walletService,
  channelHealthStore,
  logCacheStore,
  publicRoot = PUBLIC_ROOT,
  costSyncIntervalMs,
  channelHealthIntervalMs = DEFAULT_CHANNEL_HEALTH_INTERVAL_MS,
  channelHealthStartupDelayMs = DEFAULT_CHANNEL_HEALTH_STARTUP_DELAY_MS,
  modelPricingSyncIntervalMs = DEFAULT_MODEL_PRICING_SYNC_INTERVAL_MS,
  modelPricingConfirmationDelayMs = DEFAULT_MODEL_PRICING_CONFIRMATION_DELAY_MS,
  overviewCacheTtlMs = DEFAULT_OVERVIEW_CACHE_TTL_MS,
  overviewStaleMaxAgeMs = DEFAULT_OVERVIEW_STALE_MAX_AGE_MS,
  manualProbeWaitMs = DEFAULT_MANUAL_PROBE_WAIT_MS,
  manualProbePollMs = DEFAULT_MANUAL_PROBE_POLL_MS,
  gatewayProbeStartupDelayMs = DEFAULT_GATEWAY_PROBE_STARTUP_DELAY_MS,
} = {}) {
  const requestedProbeIntervalMinutes = Number.isInteger(Number(process.env.CHANNEL_HEALTH_INTERVAL_MINUTES))
    ? Number(process.env.CHANNEL_HEALTH_INTERVAL_MINUTES)
    : Math.round(Number(channelHealthIntervalMs) / 60_000) || DEFAULT_PROBE_INTERVAL_MINUTES;
  const configuredProbeIntervalMinutes = normalizeProbeIntervalMinutes(requestedProbeIntervalMinutes);
  const upstreamAutomation = gatewayControl ? process.env.MOTAI_GATEWAY_UPSTREAM_AUTOMATION ?? 'enabled' : 'enabled';
  if (!['enabled', 'disabled'].includes(upstreamAutomation)) {
    throw new TypeError('MOTAI_GATEWAY_UPSTREAM_AUTOMATION must be enabled or disabled');
  }
  const automaticUpstreamTasksEnabled = upstreamAutomation === 'enabled';
  const activeClient = gatewayControl ? new GatewayUpstreamClient({ client: gatewayControl.client,
    getConfig: () => gatewayControl.config(), baseUrl: process.env.MOTAI_GATEWAY_MODEL_URL || '' }) : client || new NewApiClient({
    baseUrl: process.env.NEW_API_BASE_URL || 'http://localhost:3001',
    adminToken: process.env.NEW_API_ADMIN_TOKEN,
    pricingSyncSecret: process.env.MODEL_PRICING_SYNC_SECRET,
    logPageIntervalMs: process.env.NEW_API_LOG_PAGE_INTERVAL_MS,
  });
  const activeCostStore = costStore || new CostStore(process.env.COST_RULES_FILE || DEFAULT_COST_FILE);
  const activeModelPricingStore = modelPricingStore || new ModelPricingStore({
    filePath: process.env.MODEL_PRICING_FILE || DEFAULT_MODEL_PRICING_FILE,
  });
  const activeNewApiPricingSyncStore = newApiPricingSyncStore || new NewApiPricingSyncStore({
    filePath: process.env.NEW_API_PRICING_SYNC_FILE || (client ? null : DEFAULT_NEW_API_PRICING_SYNC_FILE),
    client: activeClient,
    confirmationDelayMs: modelPricingConfirmationDelayMs,
  });
  const activeWalletStore = walletStore || new WalletStore({
    statePath: process.env.WALLET_STATE_FILE || DEFAULT_WALLET_STATE_FILE,
    credentialsPath: process.env.WALLET_CREDENTIALS_FILE || DEFAULT_WALLET_CREDENTIALS_FILE,
  });
  const activeWalletService = walletService || new WalletService({ client: activeClient, store: activeWalletStore });
  const activeChannelHealthStore = channelHealthStore || new ChannelHealthStore({
    filePath: process.env.CHANNEL_HEALTH_FILE || DEFAULT_CHANNEL_HEALTH_FILE,
    probeIntervalMinutes: configuredProbeIntervalMinutes,
  });
  const activeLogCacheStore = logCacheStore || new LogCacheStore({
    filePath: process.env.LOG_CACHE_FILE || (client ? null : DEFAULT_LOG_CACHE_FILE),
  });
  const activeCallerKeyVault = gatewayControl
    ? callerKeyVault === undefined ? callerKeyVaultFromEnvironment(process.env, { defaultCredentialsFile: DEFAULT_WALLET_CREDENTIALS_FILE }) : callerKeyVault
    : null;
  const activeGatewayProjection = gatewayControl ? gatewayProjection || new GatewayProjection({
    directory: process.env.MOTAI_GATEWAY_PROJECTION_DIR || path.join(gatewayControl.publisher.directory, 'projection'),
    client: gatewayControl.client, priceStore: activeModelPricingStore, costStore: activeCostStore,
    modelVendor: (modelId) => gatewayControl.publisher?.modelVendor?.(modelId) ?? null,
  }) : null;
  // Old New API history (read-only import) is only enabled in gateway mode with MOTAI_LEGACY_NEWAPI_BASE_URL set.
  const legacyBackfill = gatewayControl && legacyConfig ? new LegacyBackfill({ directory: legacyConfig.directory,
    sourceInstanceId: legacyConfig.sourceInstanceId, from: legacyConfig.from, to: legacyConfig.to,
    backoffMs: legacyConfig.backoffMs,
    client: legacyClient || new NewApiClient({ baseUrl: legacyConfig.baseUrl, adminToken: legacyConfig.adminToken,
      logPageIntervalMs: legacyConfig.pageIntervalMs }) }) : null;
  const legacyOverview = legacyBackfill ? new LegacyOverview({ importer: legacyBackfill.importer, from: legacyConfig.from,
    to: legacyConfig.to, priceStore: activeModelPricingStore, costStore: activeCostStore }) : null;
  // Attempt ids this console submitted as manual probes (newest MANUAL_PROBE_MEMORY). Kept in memory only: after a restart older
  // manual probes are shown like scheduled ones, the history itself is unaffected.
  const manualProbeIds = new Set();
  const rememberManualProbe = (attemptId) => {
    if (typeof attemptId !== 'string') return;
    manualProbeIds.add(attemptId);
    if (manualProbeIds.size > MANUAL_PROBE_MEMORY) manualProbeIds.delete(manualProbeIds.values().next().value);
  };
  const gatewayPanel = gatewayControl ? new GatewayPanel({ control: gatewayControl, projection: activeGatewayProjection,
    costStore: activeCostStore, healthStore: activeChannelHealthStore, walletStore: activeWalletStore, legacy: legacyOverview,
    isManualProbe: (attemptId) => manualProbeIds.has(attemptId) }) : null;
  let closing = false;
  let gatewayProjectionTimer = null;
  const routeChannelId = (pathname, action) => channelId(pathname, action, !!gatewayPanel);
  let started = false;
  let allowRemoteRequests = false;
  let activeChannelHealthIntervalMs = Math.max(1, configuredProbeIntervalMinutes) * 60_000;
  let costSyncTimer = null;
  let activeCostSyncIntervalMs = costSyncIntervalMs ?? DEFAULT_COST_SYNC_INTERVAL_MS;
  let costSyncPromise = null;
  let modelPricingSyncTimer = null;
  let modelPricingConfirmationTimer = null;
  let modelPricingSyncPromise = null;
  let channelHealthTimer = null;
  let channelHealthStartupTimer = null;
  let channelHealthPromise = null;
  const overviewCache = new Map();
  const overviewPromises = new Map();
  let overviewFetchQueue = Promise.resolve();
  const recentLogCache = new Map();
  const recentLogPromises = new Map();
  const routingPoolMutations = new Map();

  function channelHealthSettings() {
    const intervalMinutes = Number(activeChannelHealthStore.probeIntervalMinutes) || Math.round(activeChannelHealthIntervalMs / 60_000);
    return {
      probeIntervalMinutes: intervalMinutes,
      minProbeIntervalMinutes: MIN_PROBE_INTERVAL_MINUTES,
      maxProbeIntervalMinutes: MAX_PROBE_INTERVAL_MINUTES,
    };
  }

  function costSyncSettings() {
    return activeCostStore.settings?.() || { costSyncIntervalMinutes: DEFAULT_COST_SYNC_INTERVAL_MINUTES,
      minCostSyncIntervalMinutes: MIN_COST_SYNC_INTERVAL_MINUTES, maxCostSyncIntervalMinutes: MAX_COST_SYNC_INTERVAL_MINUTES };
  }

  function scheduleCostSyncTimer() {
    if (costSyncTimer) clearInterval(costSyncTimer);
    costSyncTimer = null;
    if (!automaticUpstreamTasksEnabled || closing) return;
    costSyncTimer = setInterval(() => { triggerCostSync().catch(() => {}); }, activeCostSyncIntervalMs);
    costSyncTimer.unref?.();
  }

  function overviewCacheTtl(period) {
    if (period?.key === 'today') return TODAY_OVERVIEW_CACHE_TTL_MS;
    if (period?.key === 'yesterday') return YESTERDAY_OVERVIEW_CACHE_TTL_MS;
    const hours = Number(period?.hours || period || 24);
    if (hours >= 720) return Math.max(overviewCacheTtlMs, MONTH_OVERVIEW_CACHE_TTL_MS);
    if (hours >= 168) return Math.max(overviewCacheTtlMs, WEEK_OVERVIEW_CACHE_TTL_MS);
    return overviewCacheTtlMs;
  }

  function overviewStaleMaxAge(hours) {
    if (hours >= 720) return Math.max(overviewStaleMaxAgeMs, MONTH_OVERVIEW_STALE_MAX_AGE_MS);
    if (hours >= 168) return Math.max(overviewStaleMaxAgeMs, WEEK_OVERVIEW_STALE_MAX_AGE_MS);
    return overviewStaleMaxAgeMs;
  }

  function queueOverviewFetch(period, force = false) {
    const pending = overviewFetchQueue.catch(() => {}).then(() => fetchOverview(period, force));
    overviewFetchQueue = pending.catch(() => {});
    return pending;
  }

  function markOverviewStale() {
    for (const entry of overviewCache.values()) entry.stale = true;
  }

  let channelListCache = null;
  let channelListPromise = null;
  let channelListGeneration = 0;

  function readChannels() {
    if (channelListCache && Date.now() - channelListCache.fetchedAt < CHANNEL_LIST_CACHE_TTL_MS) return Promise.resolve(channelListCache.value);
    if (channelListPromise) return channelListPromise;
    const generation = channelListGeneration;
    channelListPromise = activeClient.channels()
      .then((value) => {
        if (generation === channelListGeneration) channelListCache = { value, fetchedAt: Date.now() };
        return value;
      })
      .finally(() => { if (generation === channelListGeneration) channelListPromise = null; });
    return channelListPromise;
  }

  function invalidateChannelList() {
    channelListGeneration += 1;
    channelListCache = null;
    channelListPromise = null;
  }

  function withRoutingPoolLock(pool, operation) {
    const previous = routingPoolMutations.get(pool) || Promise.resolve();
    const current = previous.catch(() => {}).then(operation);
    routingPoolMutations.set(pool, current);
    return current.finally(() => {
      if (routingPoolMutations.get(pool) === current) routingPoolMutations.delete(pool);
    });
  }

  async function updateChannelPriority(channel, priority, group = null) {
    await activeClient.updateChannelRouting(
      Number(channel.id),
      Number(channel.weight) || 0,
      priority,
      String(channel.test_model || '').trim(),
      normalizeModels(channel.models),
      group,
    );
  }

  async function normalizeRoutingPriorities(pool, channels) {
    const distinct = [...new Set(channels.map((channel) => Number(channel.priority) || 0))].sort((a, b) => a - b);
    if (distinct.length >= 100000) {
      throw Object.assign(new Error('Routing priority space is exhausted'), { statusCode: 409 });
    }
    const normalized = new Map(distinct.map((priority, index) => [priority, index]));
    for (const channel of channels) {
      const priority = normalized.get(Number(channel.priority) || 0);
      if (priority !== Number(channel.priority)) await updateChannelPriority(channel, priority);
      channel.priority = priority;
    }
    return Math.max(...channels.map((channel) => Number(channel.priority) || 0));
  }

  async function makeChannelPrimary(channelId, expectedPool) {
    const channels = items(await activeClient.channels());
    const target = channels.find((channel) => Number(channel.id) === channelId);
    if (!target) throw Object.assign(new Error('Channel not found'), { statusCode: 404 });
    if (Number(target.status) !== 1) {
      throw Object.assign(new Error('Disabled channels cannot be set as primary'), { statusCode: 409 });
    }
    const pool = routingPool(target);
    if (!pool || pool !== expectedPool) {
      throw Object.assign(new Error('Channel routing pool changed; refresh and try again'), { statusCode: 409 });
    }
    const requiredGroup = channelTypeInfo(target.type)?.upstreamGroup || '';
    const currentGroups = normalizeModels(target.group);
    const groupAdded = Boolean(requiredGroup && !currentGroups.includes(requiredGroup) && !currentGroups.includes('*'));
    const targetGroup = groupAdded ? [...currentGroups, requiredGroup].join(',') : null;
    const poolChannels = channels.filter((channel) => Number(channel.status) === 1 && routingPool(channel) === pool);
    let maxPriority = Math.max(...poolChannels.map((channel) => Number(channel.priority) || 0));
    const primaryChannels = poolChannels.filter((channel) => Number(channel.priority) === maxPriority);
    if (Number(target.priority) === maxPriority && primaryChannels.length === 1 && !groupAdded) {
      return {
        changed: false,
        channel: { id: channelId, name: target.name },
        pool,
        poolLabel: routingPoolLabel(pool),
        priority: maxPriority,
      };
    }
    if (maxPriority >= 100000) maxPriority = await normalizeRoutingPriorities(pool, poolChannels);
    const priority = Number(target.priority) === maxPriority && primaryChannels.length === 1
      ? maxPriority
      : maxPriority + 1;
    await updateChannelPriority(target, priority, targetGroup);
    const affinityRule = affinityRuleForPool(pool);
    let affinityReset = null;
    if (affinityRule && typeof activeClient.clearChannelAffinity === 'function') {
      try {
        const result = await activeClient.clearChannelAffinity(affinityRule);
        affinityReset = {
          status: 'cleared',
          rule: affinityRule,
          deleted: Number(result?.deleted) || 0,
        };
      } catch (error) {
        affinityReset = {
          status: 'failed',
          rule: affinityRule,
          message: String(error?.message || 'Affinity cache reset failed'),
        };
      }
    }
    overviewCache.clear();
    return {
      changed: true,
      channel: { id: channelId, name: target.name },
      pool,
      poolLabel: routingPoolLabel(pool),
      priority,
      groupAdded: groupAdded ? requiredGroup : null,
      affinityReset,
      previousPrimaryIds: primaryChannels.map((channel) => Number(channel.id)),
    };
  }

  function cachedLogItems(type, period) {
    return activeLogCacheStore.items(type).filter((log) =>
      Number(log.created_at) >= period.startTimestamp && Number(log.created_at) <= period.endTimestamp,
    );
  }

  async function syncCachedLogs(type, period) {
    const coveredFrom = activeLogCacheStore.coveredFrom(type);
    if (coveredFrom === null || coveredFrom > period.startTimestamp) {
      const endTimestamp = coveredFrom === null
        ? period.endTimestamp
        : coveredFrom - 1;
      if (endTimestamp >= period.startTimestamp) {
        const response = await activeClient.logs({
          type,
          startTimestamp: period.startTimestamp,
          endTimestamp,
          pageSize: 100,
        });
        if (response?.truncated) throw Object.assign(new Error('Log sync returned incomplete pages'), { status: 502 });
        await activeLogCacheStore.merge(type, items(response), {
          coveredFrom: period.startTimestamp,
          checkedThrough: endTimestamp,
        });
      }
    }

    const cursor = activeLogCacheStore.checkedThrough(type);
    if (cursor > 0 && cursor < period.endTimestamp) {
      const response = await activeClient.logs({
        type,
        startTimestamp: Math.max(period.startTimestamp, cursor - LOG_SYNC_OVERLAP_SECONDS),
        endTimestamp: period.endTimestamp,
        pageSize: 100,
      });
      if (response?.truncated) throw Object.assign(new Error('Log sync returned incomplete pages'), { status: 502 });
      await activeLogCacheStore.merge(type, items(response), { checkedThrough: period.endTimestamp });
    }

    const records = cachedLogItems(type, period);
    return { items: records, total: records.length };
  }

  async function fetchOverview(period, force = false) {
    const [channels, status] = await Promise.all([
      force ? activeClient.channels() : readChannels(),
      activeClient.status(),
    ]);
    const logs = await syncCachedLogs(2, period);
    const errors = await syncCachedLogs(5, period);
    const upstreamChannels = items(channels);
    await Promise.all([
      activeCostStore.reconcileChannels(upstreamChannels),
      activeWalletStore.reconcileChannels(upstreamChannels),
    ]);
    const result = buildOverview({
      channels,
      logs,
      errors,
      status,
      hours: period.hours,
      periodKey: period.key,
      periodLabel: period.label,
      costStore: activeCostStore,
      modelPricingStore: activeModelPricingStore,
    });
    result.modelPricing = activeModelPricingStore.snapshot?.() || null;
    result.newApiPricingSync = activeNewApiPricingSyncStore.snapshot?.() || null;
    result.pricingCatalog = pricingCatalog(upstreamChannels);
    result.channels = result.channels.map((channel) => {
      const storedHealth = activeChannelHealthStore.channel(channel.id, period.hours);
      const health = channel.enabled ? storedHealth : {
        ...storedHealth,
        probeSuccesses: 0,
        probeFailures: 0,
        probeAttempts: 0,
        probeSuccessRate: null,
        probeAverageLatencyMs: null,
        lastProbeAt: null,
        lastProbeSuccess: null,
        lastProbeLatencyMs: null,
        lastProbeMessage: null,
        recentProbes: [],
      };
      const state = !channel.enabled
        ? 'disabled'
        : health.lastProbeSuccess === null
          ? 'unknown'
          : health.lastProbeSuccess
            ? (health.probeFailures ? 'recovered' : 'healthy')
            : 'failing';
      return {
        ...channel,
        state,
        ...health,
        availabilitySuccesses: health.probeSuccesses,
        availabilityFailures: health.probeFailures,
        availabilityAttempts: health.probeAttempts,
        availabilityRate: health.probeSuccessRate,
        recentResults: health.recentProbes.map((probe) => ({
          ...probe,
          createdAt: probe.checkedAt,
        })),
        probeIntervalMinutes: channelHealthSettings().probeIntervalMinutes,
        wallet: activeWalletStore.publicState(channel.id),
      };
    });
    result.probeSettings = channelHealthSettings();
    result.costSyncSettings = costSyncSettings();
    result.periodStartAt = new Date(period.startTimestamp * 1000).toISOString();
    result.periodEndAt = new Date(period.endTimestamp * 1000).toISOString();
    return result;
  }

  function pricingCatalog(channels) {
    const byModel = new Map();
    for (const channel of channels) {
      const type = channelTypeInfo(channel.type);
      for (const model of normalizeModels(channel.models)) {
        const entry = byModel.get(model) || {
          model,
          family: type?.pricingFamily || null,
          pools: new Set(),
          channels: [],
          channelMultipliers: {},
        };
        if (type?.routingPoolLabel) entry.pools.add(type.routingPoolLabel);
        entry.channels.push(channel.name || `#${channel.id}`);
        entry.channelMultipliers[channel.id] = activeCostStore.resolve({ channelId: channel.id, model })?.multiplier ?? null;
        byModel.set(model, entry);
      }
    }
    const rows = [];
    for (const entry of byModel.values()) {
      const record = activeModelPricingStore.resolve(entry.model, undefined, entry.family)
        || activeModelPricingStore.resolveOfficial?.(entry.model)
        || null;
      rows.push({
        model: entry.model,
        family: record?.family || entry.family,
        pools: [...entry.pools],
        channels: entry.channels,
        channelMultipliers: entry.channelMultipliers,
        rates: record?.rates || null,
        maxContextTokens: record?.maxContextTokens ?? null,
        priceSource: record?.sourceLabel || null,
      });
    }
    return rows.sort((left, right) => left.model.localeCompare(right.model));
  }

  async function recentLogs(options) {
    if (typeof activeClient.recentLogs === 'function') return activeClient.recentLogs(options);
    return activeClient.logs({ ...options, pageSize: RECENT_LOG_LIMIT, maxPages: 1, priority: 10 });
  }

  async function fetchRecentRequests(period) {
    const [channels, status, logs, errors] = await Promise.all([
      readChannels(),
      activeClient.status(),
      recentLogs({ type: 2, startTimestamp: period.startTimestamp, endTimestamp: period.endTimestamp, limit: RECENT_LOG_LIMIT }),
      recentLogs({ type: 5, startTimestamp: period.startTimestamp, endTimestamp: period.endTimestamp, limit: RECENT_LOG_LIMIT }),
    ]);
    const partial = buildOverview({
      channels,
      logs,
      errors,
      status,
      hours: period.hours,
      periodKey: period.key,
      periodLabel: period.label,
      costStore: activeCostStore,
      modelPricingStore: activeModelPricingStore,
    });
    await Promise.all([
      activeLogCacheStore.merge(2, items(logs)),
      activeLogCacheStore.merge(5, items(errors)),
    ]);
    return {
      generatedAt: partial.generatedAt,
      periodKey: period.key,
      periodLabel: period.label,
      periodHours: period.hours,
      periodStartAt: new Date(period.startTimestamp * 1000).toISOString(),
      periodEndAt: new Date(period.endTimestamp * 1000).toISOString(),
      logs: partial.logs,
      errors: partial.errors,
      latestError: partial.latestError,
      totals: {
        requests: Number(logs?.total) || partial.metrics.requests,
        errors: Number(errors?.total) || partial.metrics.errorCount,
      },
      truncated: Boolean(logs?.truncated || errors?.truncated),
    };
  }

  async function submitGatewayProbe(channel, source, poolId) {
    const configured = gatewayControl.config().channels.find((row) => row.id === String(channel.id));
    if (!configured) throw Object.assign(new Error('渠道已移除，请刷新后检测'), { statusCode: 404, code: 'channel_not_found' });
    const poolIds = channelPoolIds(configured);
    if (poolIds.length > 1 && !poolId) throw Object.assign(new Error('请选择要检测的池'), { statusCode: 400, code: 'pool_required' });
    if (poolId !== undefined && !poolIds.includes(poolId)) throw Object.assign(new Error('渠道不属于所选池'), { statusCode: 400, code: 'invalid_pool' });
    const target = probeTarget(configured);
    if (!target) {
      throw Object.assign(new Error(configured.testModel ? '检测模型尚无可调用协议' : '渠道没有可探测的模型（只有 count_tokens 能力）'),
        { statusCode: 409, code: 'probe_model_unavailable' });
    }
    const { modelId, protocol } = target;
    const response = await gatewayControl.client.probe({ format_version: 1, source, channel_id: configured.id,
      ...(poolIds.length > 1 ? { pool_id: poolId } : {}),
      model_id: modelId, protocol, client_run_id: randomUUID() });
    return { response, channelId: configured.id, modelId, protocol };
  }

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  // Manual probes: the core answers "accepted" at once and the outcome arrives later as a terminal attempt in the projection.
  // Re-read the projection until this attempt shows up, the budget is spent, or the app closes.
  async function awaitProbeResult(channelId, attemptId, startedAt) {
    const deadline = startedAt + manualProbeWaitMs;
    for (;;) {
      await refreshGatewayProjection().catch(() => {});
      const result = activeGatewayProjection.probeResult(channelId, attemptId);
      if (result) {
        // The overview window ends at the last whole second and excludes its end, so a probe that began in the current second is
        // not visible yet. Wait that second out so the refresh the page does next already shows this result.
        const visibleAt = (Math.floor(Date.parse(result.checkedAt) / 1000) + 1) * 1000;
        if (Number.isFinite(visibleAt) && visibleAt > Date.now()) await sleep(Math.min(1000, visibleAt - Date.now()));
        return result;
      }
      if (closing || Date.now() >= deadline) return null;
      await sleep(Math.min(manualProbePollMs, Math.max(1, deadline - Date.now())));
    }
  }

  async function probeChannelHealth(channel, source = 'scheduled', poolId) {
    if (gatewayPanel) return (await submitGatewayProbe(channel, source, poolId)).response;
    const startedAt = Date.now();
    let result;
    let statusCode = null;
    try {
      result = await activeClient.testChannel(channel.id);
    } catch (error) {
      const responseStatus = Number(error.status || error.statusCode);
      statusCode = responseStatus >= 400 ? responseStatus : null;
      result = {
        success: false,
        message: error.message,
        error_code: error.code || null,
      };
    }
    const reportedLatency = Number(result?.time) * 1000;
    const event = await activeChannelHealthStore.record(channel.id, {
      checkedAt: new Date().toISOString(),
      success: result?.success === true,
      latencyMs: Number.isFinite(reportedLatency) && reportedLatency >= 0
        ? reportedLatency
        : Date.now() - startedAt,
      model: String(channel.test_model || '').trim() || normalizeModels(channel.models)[0] || '',
      statusCode,
      errorCode: result?.error_code || null,
      message: result?.message || null,
    });
    return { channelId: Number(channel.id), ...event };
  }

  async function runChannelHealthProbes() {
    const canProbe = gatewayPanel ? typeof gatewayControl.client.probe === 'function' : typeof activeClient.testChannel === 'function';
    if (!activeClient.configured?.() || !canProbe) {
      return { status: 'skipped', attempted: 0 };
    }
    const channels = items(await activeClient.channels());
    const targets = channels.filter((channel) => Number(channel.status) === 1).flatMap((channel) =>
      gatewayPanel ? channelPoolIds(channel).map((poolId) => ({ channel, poolId })) : [{ channel }]);
    const results = [];
    for (const { channel, poolId } of targets) {
      try { results.push(await probeChannelHealth(channel, 'scheduled', poolId)); }
      catch (error) {
        if (!gatewayPanel) throw error;
        const code = ['probe_model_unavailable', 'channel_not_found', 'gateway_unavailable', 'gateway_invalid_response', 'gateway_log_unavailable'].includes(error.code)
          ? error.code : 'probe_not_accepted';
        results.push({ channelId: String(channel.id), ...(channel.poolIds?.length > 1 ? { poolId } : {}), state: 'rejected', code });
      }
    }
    markOverviewStale();
    return { status: 'completed', attempted: targets.length, results };
  }

  function triggerChannelHealthProbes() {
    if (channelHealthPromise) return channelHealthPromise;
    channelHealthPromise = runChannelHealthProbes().finally(() => {
      channelHealthPromise = null;
    });
    return channelHealthPromise;
  }

  // After a (re)start the interval timer would wait a whole interval before the first round. Run one round shortly after start,
  // but not when every probeable channel already has a probe newer than one interval (frequent restarts must not re-probe).
  async function startupGatewayProbes() {
    await refreshGatewayProjection().catch(() => {});
    const interval = activeChannelHealthIntervalMs, now = Date.now();
    const due = (gatewayControl.config()?.channels ?? []).filter((channel) => channel.enabled && probeTarget(channel))
      .some((channel) => {
        const last = activeGatewayProjection.latestProbeMs?.(channel.id) ?? null;
        return last === null || now - last >= interval;
      });
    if (due) await triggerChannelHealthProbes();
  }

  function scheduleChannelHealthTimer() {
    if (channelHealthTimer) clearInterval(channelHealthTimer);
    channelHealthTimer = null;
    if (!automaticUpstreamTasksEnabled) return;
    channelHealthTimer = setInterval(() => {
      triggerChannelHealthProbes().catch(() => {});
    }, activeChannelHealthIntervalMs);
    channelHealthTimer.unref?.();
  }

  function cachedOverview(entry, cacheStatus, error = null) {
    const { logs, errors, ...rest } = entry.value;
    return {
      ...rest,
      requestTotal: Array.isArray(logs) ? logs.length : 0,
      requestModels: [...new Set((logs || []).map((log) => log.model).filter(Boolean))].sort(),
      cacheStatus,
      cacheAgeMs: Math.max(0, Date.now() - entry.fetchedAt),
      cacheError: error?.message || null,
    };
  }

  function cachedRecentLogs(entry, cacheStatus, error = null) {
    return {
      ...entry.value,
      cacheStatus,
      cacheAgeMs: Math.max(0, Date.now() - entry.fetchedAt),
      cacheError: error?.message || null,
    };
  }

  function refreshOverview(period, force = false) {
    const promiseKey = force ? `${period.cacheKey}:force` : period.cacheKey;
    if (overviewPromises.has(promiseKey)) return overviewPromises.get(promiseKey);
    const promise = queueOverviewFetch(period, force)
      .then((value) => {
        const entry = { value, fetchedAt: Date.now(), period };
        overviewCache.set(period.cacheKey, entry);
        return activeLogCacheStore.saveOverview(period, entry).then(() => entry);
      })
      .finally(() => {
        overviewPromises.delete(promiseKey);
      });
    overviewPromises.set(promiseKey, promise);
    return promise;
  }

  async function overview(url) {
    const period = resolvePeriod({
      period: url.searchParams.get('period'),
      hours: url.searchParams.get('hours'),
    });
    const force = url.searchParams.get('force') === '1';
    const entry = overviewCache.get(period.cacheKey);
    if (entry && !force) {
      const needsRefresh = entry.stale || Date.now() - entry.fetchedAt >= overviewCacheTtl(period);
      if (needsRefresh) refreshOverview(period).catch(() => {});
      return cachedOverview(entry, needsRefresh ? 'refreshing' : 'cached');
    }
    try {
      const nextEntry = await refreshOverview(period, force);
      return cachedOverview(nextEntry, 'fresh');
    } catch (error) {
      const staleEntry = overviewCache.get(period.cacheKey);
      const canUseStale = staleEntry
        && Date.now() - staleEntry.fetchedAt <= overviewStaleMaxAge(period.hours)
        && [429, 502, 503, 504].includes(Number(error.status || error.statusCode));
      if (canUseStale) return cachedOverview(staleEntry, 'stale', error);
      if (error.status && !error.statusCode) error.statusCode = error.status;
      throw error;
    }
  }

  async function recentRequests(url) {
    const period = resolvePeriod({
      period: url.searchParams.get('period'),
      hours: url.searchParams.get('hours'),
    });
    const force = url.searchParams.get('force') === '1';
    const entry = recentLogCache.get(period.cacheKey);
    if (!force && entry && Date.now() - entry.fetchedAt < RECENT_LOG_CACHE_TTL_MS) {
      return cachedRecentLogs(entry, 'cached');
    }
    if (recentLogPromises.has(period.cacheKey)) return recentLogPromises.get(period.cacheKey);
    const promise = (async () => {
      try {
        const value = await fetchRecentRequests(period);
        const nextEntry = { value, fetchedAt: Date.now(), period };
        recentLogCache.set(period.cacheKey, nextEntry);
        return cachedRecentLogs(nextEntry, 'fresh');
      } catch (error) {
        const staleEntry = recentLogCache.get(period.cacheKey) || entry;
        const canUseStale = staleEntry
          && Date.now() - staleEntry.fetchedAt <= RECENT_LOG_STALE_MAX_AGE_MS
          && [429, 502, 503, 504].includes(Number(error.status || error.statusCode));
        if (canUseStale) return cachedRecentLogs(staleEntry, 'stale', error);
        if (error.status && !error.statusCode) error.statusCode = error.status;
        throw error;
      } finally {
        recentLogPromises.delete(period.cacheKey);
      }
    })();
    recentLogPromises.set(period.cacheKey, promise);
    return promise;
  }

  const REQUEST_PAGE_SIZE = 100;

  function eventKey(log) {
    return String(log.eventId || `${log.kind || 'event'}-${log.id || ''}`);
  }

  function sortRequestEvents(events) {
    return events.sort((left, right) => {
      const rightTime = Number(right.createdTimestamp) || Date.parse(right.createdAt || '') || 0;
      const leftTime = Number(left.createdTimestamp) || Date.parse(left.createdAt || '') || 0;
      return rightTime - leftTime || String(right.eventId || '').localeCompare(String(left.eventId || ''));
    });
  }

  async function requests(url) {
    const period = resolvePeriod({
      period: url.searchParams.get('period'),
      hours: url.searchParams.get('hours'),
    });
    const fresh = url.searchParams.get('fresh') === '1';

    let recentCacheStatus = null;
    if (fresh) {
      const forcedUrl = new URL(url);
      forcedUrl.searchParams.set('force', '1');
      const recentPayload = await recentRequests(forcedUrl);
      recentCacheStatus = recentPayload.cacheStatus;
    }

    let entry = overviewCache.get(period.cacheKey);
    let overviewCacheStatus;
    if (entry) {
      const needsRefresh = entry.stale || Date.now() - entry.fetchedAt >= overviewCacheTtl(period);
      if (needsRefresh) refreshOverview(period).catch(() => {});
      overviewCacheStatus = needsRefresh ? 'refreshing' : 'cached';
    } else {
      try {
        entry = await refreshOverview(period);
        overviewCacheStatus = 'fresh';
      } catch (error) {
        const staleEntry = overviewCache.get(period.cacheKey);
        const canUseStale = staleEntry
          && Date.now() - staleEntry.fetchedAt <= overviewStaleMaxAge(period.hours)
          && [429, 502, 503, 504].includes(Number(error.status || error.statusCode));
        if (canUseStale) {
          entry = staleEntry;
          overviewCacheStatus = 'stale';
        } else {
          if (error.status && !error.statusCode) error.statusCode = error.status;
          throw error;
        }
      }
    }

    let mergedLogs = entry.value.logs || [];
    const recentEntry = recentLogCache.get(period.cacheKey);
    if (recentEntry && recentEntry.fetchedAt > entry.fetchedAt) {
      const merged = new Map(mergedLogs.map((log) => [eventKey(log), log]));
      for (const log of recentEntry.value.logs || []) merged.set(eventKey(log), log);
      mergedLogs = sortRequestEvents([...merged.values()]);
    }

    const filtered = filterRequestEvents(mergedLogs, {
      channel: url.searchParams.get('channel') || '',
      model: url.searchParams.get('model') || '',
      status: url.searchParams.get('status') || '',
      stream: url.searchParams.get('stream') || '',
    });
    const total = filtered.length;
    const pageCount = Math.max(1, Math.ceil(total / REQUEST_PAGE_SIZE));
    const requestedPage = Number(url.searchParams.get('page')) || 1;
    const page = Math.min(Math.max(1, Math.round(requestedPage) || 1), pageCount);
    const start = (page - 1) * REQUEST_PAGE_SIZE;
    const pageItems = filtered.slice(start, start + REQUEST_PAGE_SIZE);

    const overviewLatestError = entry.value.latestError;
    const recentLatestError = recentEntry?.value.latestError;
    const overviewLatestErrorTime = Date.parse(overviewLatestError?.createdAt || '') || 0;
    const recentLatestErrorTime = Date.parse(recentLatestError?.createdAt || '') || 0;
    const latestError = recentLatestErrorTime > overviewLatestErrorTime ? recentLatestError : overviewLatestError;

    return {
      items: pageItems,
      page,
      pageSize: REQUEST_PAGE_SIZE,
      total,
      pageCount,
      generatedAt: entry.value.generatedAt,
      cacheStatus: overviewCacheStatus,
      latestError: latestError || null,
      recentCacheStatus,
    };
  }

  async function syncCostChannels({ onlyId = null } = {}) {
    if (!activeClient.configured?.() || typeof activeClient.probeSub2Billing !== 'function') {
      return { status: 'skipped', attempted: 0 };
    }
    const channels = items(await activeClient.channels());
    await activeCostStore.reconcileChannels(channels);
    // Gateway mode: the channel list is the active gateway config, so a sync entry whose channel
    // is not in it can never be probed and would keep showing a stale "synced". Drop only the
    // sync state; the channel's cost rules stay for pricing requests logged while it existed.
    // An empty list is never pruned against: it would wipe every channel's state on a transient empty read.
    if (gatewayPanel && channels.length) await activeCostStore.pruneChannelSync?.(channels);
    const targets = channels.filter((channel) =>
      (!onlyId || String(channel.id) === String(onlyId))
      && activeCostStore.syncState(channel.id).mode === 'auto');
    const results = await Promise.all(targets.map(async (channel) => {
      let result;
      try {
        result = await activeClient.probeSub2Billing(channel.id);
      } catch (error) {
        const status = Number(error.status || error.statusCode);
        result = {
          status: 'failed',
          error_class: status === 429
            ? 'probe_rate_limited'
            : error.code
              ? String(error.code).toLowerCase()
              : 'probe_request_failed',
        };
      }
      await activeCostStore.recordProbe(channel, result);
      const state = activeCostStore.syncState(channel.id);
      // One line per failed channel, none on success. Only local values: the channel's id and
      // name, the error class, and the source/group of the last success. No key, no upstream text.
      if (result?.status !== 'ok' && state.errorClass !== 'probe_rate_limited') {
        console.warn(`[cost-sync] failed ${JSON.stringify({ channel: String(channel.id), name: String(channel.name ?? ''),
          error_class: state.errorClass || String(result?.error_class || 'probe_failed'),
          last_group: state.upstreamGroup, last_source: state.upstreamSource })}`);
      }
      return { channelId: channel.id, status: state.status };
    }));
    return { status: 'completed', attempted: targets.length, results };
  }

  function triggerCostSync(options) {
    if (costSyncPromise) return costSyncPromise;
    costSyncPromise = syncCostChannels(options).finally(() => {
      costSyncPromise = null;
    });
    return costSyncPromise;
  }

  function refreshGatewayProjection() {
    const state = activeGatewayProjection.state();
    if (state.writeBlocked) return Promise.resolve(state);
    return state.requiresRebuild ? activeGatewayProjection.rebuild() : activeGatewayProjection.catchUp();
  }

  function triggerModelPricingSync() {
    if (modelPricingSyncPromise) return modelPricingSyncPromise;
    modelPricingSyncPromise = activeModelPricingStore.refresh()
      .then(async (result) => {
        if (gatewayPanel) {
          await refreshGatewayProjection();
          return { modelPricing: result, newApiPricingSync: null };
        }
        const newApiSync = await activeNewApiPricingSyncStore.synchronize({
          records: activeModelPricingStore.activeRecords?.() || [],
          models: new Set(items(await activeClient.channels()).flatMap((channel) => normalizeModels(channel.models))),
          observationId: result.lastSuccessAt,
          snapshotHash: result.snapshotHash,
        });
        overviewCache.clear();
        if (newApiSync.needsConfirmation && !modelPricingConfirmationTimer) {
          modelPricingConfirmationTimer = setTimeout(() => {
            modelPricingConfirmationTimer = null;
            triggerModelPricingSync().catch(() => {});
          }, modelPricingConfirmationDelayMs);
          modelPricingConfirmationTimer.unref?.();
        }
        return { modelPricing: result, newApiPricingSync: newApiSync };
      })
      .finally(() => {
        modelPricingSyncPromise = null;
      });
    return modelPricingSyncPromise;
  }

  async function manuallyRefreshCostChannel(channelId) {
    if (costSyncPromise) await costSyncPromise;
    const result = await triggerCostSync({ onlyId: channelId });
    return {
      ...result,
      costVersion: activeCostStore.version,
      pricing: activeCostStore.channelPricing(channelId),
    };
  }

  async function fetchChannelModels(req, res) {
    const payload = await readJson(req);
    const type = Number(payload.type);
    if (!supportedChannelType(type)) throw Object.assign(new Error('Unsupported channel type'), { statusCode: 400 });
    const key = String(payload.key || '').trim();
    if (!key) throw Object.assign(new Error('API key is required to fetch models'), { statusCode: 400 });
    let baseUrl;
    try {
      baseUrl = new URL(String(payload.baseUrl || '').trim());
    } catch {
      throw Object.assign(new Error('A valid upstream URL is required'), { statusCode: 400 });
    }
    if (baseUrl.protocol !== 'https:') throw Object.assign(new Error('Upstream URL must use HTTPS'), { statusCode: 400 });
    let result;
    try {
      result = await activeClient.fetchModels({ type, baseUrl: baseUrl.toString().replace(/\/$/, ''), key });
    } catch {
      throw Object.assign(new Error('Unable to fetch models from the upstream'), { statusCode: 502 });
    } finally {
      payload.key = '';
    }
    const models = normalizeModels(Array.isArray(result) ? result.map((item) => item?.id || item) : result?.data || result?.models || []);
    json(res, 200, { models });
  }

  async function createChannel(req, res) {
    const payload = await readJson(req);
    const input = normalizeChannelInput(payload);
    const before = items(await activeClient.channels());
    const normalizedName = input.name.toLocaleLowerCase();
    if (before.some((channel) => String(channel.name || '').trim().toLocaleLowerCase() === normalizedName)) {
      throw Object.assign(new Error('A channel with this name already exists'), { statusCode: 409 });
    }
    const beforeIds = new Set(before.map((channel) => Number(channel.id)));
    const upstreamChannel = {
      name: input.name,
      type: input.type,
      key: input.key,
      base_url: input.baseUrl,
      models: input.models.join(','),
      group: channelTypeInfo(input.type).upstreamGroup,
      priority: input.priority,
      weight: input.weight,
      status: 2,
      auto_ban: 1,
      other: '',
      setting: '{}',
      settings: '{}',
      remark: 'Created by local operations console',
    };
    let createFailed = false;
    try {
      await activeClient.createChannel(upstreamChannel);
    } catch {
      createFailed = true;
    } finally {
      upstreamChannel.key = '';
      input.key = '';
      payload.key = '';
    }
    let after;
    try {
      after = items(await activeClient.channels());
    } catch {
      throw Object.assign(new Error('Channel creation status is unknown; verify it in New API before trying again'), { statusCode: 502 });
    }
    const created = after.filter((channel) =>
      !beforeIds.has(Number(channel.id)) &&
      String(channel.name || '').trim().toLocaleLowerCase() === normalizedName,
    );
    if (created.length !== 1) {
      const message = createFailed
        ? 'Channel creation failed or is uncertain; verify it in New API before trying again'
        : 'Channel was submitted but the created record could not be identified; verify it in New API';
      throw Object.assign(new Error(message), { statusCode: 409 });
    }
    let pricingSaved = true;
    try {
      await activeCostStore.setChannelMultiplier(created[0].id, input.multiplier, input.baseVersion);
    } catch {
      pricingSaved = false;
    }
    json(res, 201, {
      channel: { id: Number(created[0].id), name: created[0].name, status: Number(created[0].status) },
      pricingSaved,
      message: pricingSaved
        ? 'Channel created in disabled state'
        : 'Channel created in disabled state, but cost pricing was not saved; set it in the channel row',
    });
  }

  // The committed token HMACs stay inside the server; responses only carry keyStored and a masked preview (never the full key).
  const callerHashes = (callerId) => gatewayControl.publisher?.callerTokenHashes?.(callerId) ?? [];
  async function withKeyStored(config) {
    if (!config?.callers) return config;
    const hashesByCaller = new Map(config.callers.map((caller) => [caller.id, callerHashes(caller.id)]));
    let masks = new Map();
    if (activeCallerKeyVault?.available) {
      if (typeof activeCallerKeyVault.storedCallerMasks === 'function') {
        masks = await activeCallerKeyVault.storedCallerMasks(hashesByCaller);
      } else {
        const stored = await activeCallerKeyVault.storedCallerIds(hashesByCaller);
        masks = new Map([...stored].map((id) => [id, null]));
      }
    }
    return {
      ...config,
      callers: config.callers.map((caller) => ({
        ...caller,
        keyStored: masks.has(caller.id),
        keyMasked: masks.get(caller.id) ?? null,
      })),
    };
  }
  const withKeyStoredResult = async (result) => (result?.config ? { ...result, config: await withKeyStored(result.config) } : result);

  async function handleCallerKey(req, res, match) {
    let callerId;
    try { callerId = decodeURIComponent(match[1]); }
    catch { throw Object.assign(new Error('调用令牌 ID 无效'), { statusCode: 400, code: 'invalid_caller_id' }); }
    const body = await readJson(req);
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      throw Object.assign(new Error('请求内容无效'), { statusCode: 400, code: 'invalid_caller_key_request' });
    }
    if (!activeCallerKeyVault?.available) {
      throw Object.assign(new Error('调用令牌密钥库不可用'), { statusCode: 503, code: 'caller_key_vault_unavailable' });
    }
    const hashes = callerHashes(callerId);
    if (!match[2]) {
      const token = await activeCallerKeyVault.currentToken(callerId, hashes);
      if (token === null) throw Object.assign(new Error('这个令牌没有保存密钥'), { statusCode: 404, code: 'caller_key_not_stored' });
      json(res, 200, { token });
      return;
    }
    const names = Object.keys(body);
    if (names.length !== 1 || names[0] !== 'token' || typeof body.token !== 'string'
      || body.token.length > 256 || !/^sk-\S+$/.test(body.token)) {
      throw Object.assign(new Error('密钥格式不正确'), { statusCode: 400, code: 'invalid_caller_key' });
    }
    if (!activeCallerKeyVault.verify(body.token, hashes)) {
      throw Object.assign(new Error('密钥和这个令牌不匹配'), { statusCode: 422, code: 'caller_key_mismatch' });
    }
    try { await activeCallerKeyVault.save(callerId, body.token); }
    catch { throw Object.assign(new Error('密钥保存失败'), { statusCode: 500, code: 'caller_key_save_failed' }); }
    json(res, 200, { keyStored: true });
  }

  async function handleApi(req, res, url) {
    const requireWrite = () => requireJsonWrite(req, { allowRemote: allowRemoteRequests });
    if (url.pathname === '/api/gateway/status' && req.method === 'GET') {
      json(res, 200, gatewayControl ? { mode: 'gateway', ...await gatewayControl.status(),
        upstreamAutomation: { enabled: automaticUpstreamTasksEnabled } } : { mode: 'legacy' });
      return;
    }
    if (url.pathname.startsWith('/api/gateway/')) {
      if (!gatewayControl) throw Object.assign(new Error('网关候选尚未配置'), { statusCode: 503, code: 'gateway_not_ready' });
      if (url.pathname === '/api/gateway/config' && req.method === 'GET') {
        json(res, 200, { config: await withKeyStored(gatewayControl.config()) }); return;
      }
      if (url.pathname === '/api/gateway/channels/health' && req.method === 'GET') {
        json(res, 200, await gatewayControl.channelHealth()); return;
      }
      if (req.method === 'POST') {
        requireWrite();
        if (url.pathname === '/api/gateway/channels/change') {
          const result = await gatewayControl.change(await readJson(req));
          json(res, result.activated ? 200 : 202, await withKeyStoredResult(result)); return;
        }
        if (url.pathname === '/api/gateway/callers/change') {
          const result = await gatewayControl.callerChange(await readJson(req));
          if (result.oneTimeToken && result.callerId && activeCallerKeyVault) {
            // A failed save never blocks the response: the key is still returned once, as before. Never log the key itself.
            try { await activeCallerKeyVault.save(result.callerId, result.oneTimeToken); }
            catch (error) { console.warn(`[caller-keys] save failed (${error?.code ?? 'error'})`); }
          }
          json(res, result.activated ? 200 : 202, await withKeyStoredResult(result)); return;
        }
        const callerKey = /^\/api\/gateway\/callers\/([^/]+)\/key(\/import)?$/.exec(url.pathname);
        if (callerKey) { await handleCallerKey(req, res, callerKey); return; }
        if (url.pathname === '/api/gateway/reconcile') {
          json(res, 200, await withKeyStoredResult(await gatewayControl.reconcile())); return;
        }
        if (url.pathname === '/api/gateway/discard') {
          json(res, 200, await withKeyStoredResult(await gatewayControl.discard(await readJson(req)))); return;
        }
        if (url.pathname === '/api/gateway/models/preview') {
          json(res, 200, await gatewayControl.preview(await readJson(req))); return;
        }
        const healthReset = /^\/api\/gateway\/channels\/([^/]+)\/health-reset$/.exec(url.pathname);
        if (healthReset) {
          json(res, 200, await gatewayControl.resetHealth(decodeURIComponent(healthReset[1]), await readJson(req))); return;
        }
      }
      failure(res, 404, 'Route not found'); return;
    }
    if (url.pathname === '/api/healthz' && req.method === 'GET') {
      if (gatewayPanel) {
        try {
          const status = await gatewayControl.status();
          json(res, status.ready ? 200 : 503, { ok: status.ready, mode: 'gateway', projection: activeGatewayProjection.state(),
            ...(legacyBackfill ? { legacy: legacyBackfill.status() } : {}) });
        } catch { json(res, 503, { ok: false, mode: 'gateway' }); }
        return;
      }
      const recentOverview = [...overviewCache.values()]
        .some((entry) => Date.now() - entry.fetchedAt < overviewCacheTtl(entry.period) * 2);
      if (recentOverview) {
        json(res, 200, { ok: true, newApi: true, cached: true });
        return;
      }
      try {
        await activeClient.status();
        json(res, 200, { ok: true, newApi: true });
      } catch (error) {
        if (Number(error.status || error.statusCode) === 429) {
          json(res, 200, { ok: true, newApi: true, rateLimited: true });
        } else {
          json(res, 503, { ok: false, newApi: false });
        }
      }
      return;
    }

    if (url.pathname === '/api/settings/cost-sync' && req.method === 'GET') {
      json(res, 200, costSyncSettings());
      return;
    }
    if (url.pathname === '/api/settings/cost-sync' && req.method === 'PUT') {
      requireWrite();
      const payload = await readJson(req, 16 * 1024);
      const intervalMinutes = requireCostSyncIntervalMinutes(payload?.costSyncIntervalMinutes);
      const settings = await activeCostStore.setCostSyncIntervalMinutes(intervalMinutes);
      activeCostSyncIntervalMs = settings.costSyncIntervalMinutes * 60_000;
      if (started) scheduleCostSyncTimer();
      overviewCache.clear();
      json(res, 200, settings);
      return;
    }

    if (url.pathname === '/api/settings/probes' && req.method === 'GET') {
      json(res, 200, channelHealthSettings());
      return;
    }
    if (url.pathname === '/api/settings/probes' && req.method === 'PUT') {
      requireWrite();
      const payload = await readJson(req, 16 * 1024);
      const intervalMinutes = boundedInteger(
        payload.probeIntervalMinutes ?? payload.intervalMinutes,
        'Probe interval',
        MIN_PROBE_INTERVAL_MINUTES,
        MAX_PROBE_INTERVAL_MINUTES,
      );
      const settings = await activeChannelHealthStore.setProbeIntervalMinutes(intervalMinutes);
      activeChannelHealthIntervalMs = settings.probeIntervalMinutes * 60_000;
      if (started) scheduleChannelHealthTimer();
      overviewCache.clear();
      json(res, 200, settings);
      return;
    }

    if (url.pathname === '/api/overview' && req.method === 'GET') {
      if (gatewayPanel) {
        refreshGatewayProjection().catch(() => {});
        const result = gatewayPanel.overview(url.searchParams);
        result.modelPricing = activeModelPricingStore.snapshot?.() || null;
        result.pricingCatalog = pricingCatalog(items(await activeClient.channels()));
        result.probeSettings = channelHealthSettings();
        result.costSyncSettings = costSyncSettings();
        json(res, 200, result); return;
      }
      json(res, 200, { ...await overview(url), costSyncSettings: costSyncSettings() });
      return;
    }
    if (url.pathname === '/api/recent-requests' && req.method === 'GET') {
      if (gatewayPanel) { json(res, 200, await gatewayPanel.requests(url.searchParams)); return; }
      json(res, 200, await recentRequests(url));
      return;
    }
    if (url.pathname === '/api/requests' && req.method === 'GET') {
      if (gatewayPanel) { json(res, 200, await gatewayPanel.requests(url.searchParams)); return; }
      json(res, 200, await requests(url));
      return;
    }
    if (url.pathname === '/api/cost-rules' && req.method === 'GET') {
      json(res, 200, activeCostStore.snapshot());
      return;
    }
    if (gatewayPanel && !['/api/cost-sync', '/api/model-pricing-sync', '/api/wallet-refresh'].includes(url.pathname)
      && !/^\/api\/channels\/[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}\/(?:wallet|wallet-refresh|cost-sync|cost|test)$/.test(url.pathname)) {
      throw Object.assign(new Error('此入口尚未接入网关候选'), { statusCode: 503, code: 'gateway_feature_pending' });
    }
    if (url.pathname === '/api/cost-sync' && req.method === 'POST') {
      requireWrite();
      json(res, 200, await triggerCostSync());
      return;
    }
    if (url.pathname === '/api/model-pricing-sync' && req.method === 'POST') {
      requireWrite();
      json(res, 200, await triggerModelPricingSync());
      return;
    }
    if (url.pathname === '/api/wallet-refresh' && req.method === 'POST') {
      requireWrite();
      json(res, 200, await activeWalletService.manualRefreshAll());
      return;
    }
    const walletId = routeChannelId(url.pathname, 'wallet');
    if (walletId && req.method === 'PUT') {
      requireWrite();
      const payload = await readJson(req, 16 * 1024);
      try {
        const channels = items(await activeClient.channels());
        const channel = channels.find((item) => String(item.id) === String(walletId));
        if (!channel) throw Object.assign(new Error('Channel not found'), { statusCode: 404 });
        const adapter = String(payload.adapter || 'auto').toLowerCase();
        const credential = String(payload.credential || '');
        if (credential && !['newapi', 'sub2', 'rightcode'].includes(adapter)) {
          throw Object.assign(new Error('已输入管理凭据，请先把识别方式选择为 New API、Sub2 或 Right Code'), { statusCode: 400 });
        }
        const origin = ['newapi', 'sub2', 'rightcode'].includes(adapter) && (adapter !== 'newapi' || Boolean(credential))
          ? (payload.origin ? String(payload.origin) : channelOrigin(channel, adapter))
          : null;
        await activeWalletStore.configure(channel, {
          adapter,
          origin,
          credential,
        });
        const refreshed = await activeWalletService.refreshAll({ manual: true });
        const wallet = refreshed?.channels?.[String(walletId)];
        if (wallet?.status === 'needs_reauth') {
          throw Object.assign(
            new Error(adapter === 'newapi'
              ? 'New API 访问令牌无效或已失效，请在个人设置里重新生成'
              : 'Sub2 refresh token 无效、已过期或已被轮换，请使用独立登录会话生成新的 token'),
            { statusCode: 422 },
          );
        }
        json(res, 200, refreshed);
      } finally {
        payload.credential = '';
      }
      return;
    }
    if (walletId && req.method === 'DELETE') {
      requireWrite();
      json(res, 200, await activeWalletStore.clear(walletId));
      return;
    }
    const walletRefreshId = routeChannelId(url.pathname, 'wallet-refresh');
    if (walletRefreshId && req.method === 'POST') {
      requireWrite();
      json(res, 200, await activeWalletService.manualRefresh(walletRefreshId));
      return;
    }
    const costSyncId = routeChannelId(url.pathname, 'cost-sync');
    if (costSyncId && req.method === 'POST') {
      requireWrite();
      const channels = items(await activeClient.channels());
      if (!channels.some((channel) => String(channel.id) === String(costSyncId))) {
        throw Object.assign(new Error('Channel not found'), { statusCode: 404 });
      }
      if (activeCostStore.syncState(costSyncId).mode !== 'auto') {
        throw Object.assign(new Error('Automatic cost synchronization is not enabled'), { statusCode: 409 });
      }
      json(res, 200, await manuallyRefreshCostChannel(costSyncId));
      return;
    }
    if (costSyncId && req.method === 'PUT') {
      requireWrite();
      const payload = await readJson(req);
      const channels = items(await activeClient.channels());
      const channel = channels.find((item) => String(item.id) === String(costSyncId));
      if (!channel) throw Object.assign(new Error('Channel not found'), { statusCode: 404 });
      await activeCostStore.setChannelMode(channel, String(payload.mode || ''), payload.baseVersion);
      if (payload.mode === 'auto') await triggerCostSync({ onlyId: costSyncId });
      json(res, 200, {
        costVersion: activeCostStore.version,
        pricing: activeCostStore.channelPricing(costSyncId),
      });
      return;
    }
    const costId = routeChannelId(url.pathname, 'cost');
    if (costId && req.method === 'PUT') {
      requireWrite();
      const payload = await readJson(req);
      const channels = items(await activeClient.channels());
      const channel = channels.find((channel) => String(channel.id) === String(costId));
      if (!channel) {
        throw Object.assign(new Error('Channel not found'), { statusCode: 404 });
      }
      if (payload.costSyncMode !== undefined) {
        if (!['auto', 'manual'].includes(payload.costSyncMode)) {
          throw Object.assign(new Error('Sync mode must be auto or manual'), { statusCode: 400 });
        }
        if (payload.costSyncMode === 'auto') {
          await activeCostStore.setChannelMode(channel, 'auto', payload.baseVersion);
          await triggerCostSync({ onlyId: costId });
        } else {
          if (typeof payload.multiplier !== 'number' || !Number.isFinite(payload.multiplier)
            || payload.multiplier < 0 || payload.multiplier > 100) {
            throw Object.assign(new Error('Cost multiplier must be between 0 and 100'), { statusCode: 400 });
          }
          await activeCostStore.setChannelConfiguration(channel, { multiplier: payload.multiplier, mode: 'manual' }, payload.baseVersion);
        }
      } else await activeCostStore.setChannelMultiplier(costId, payload.multiplier, payload.baseVersion);
      json(res, 200, { ...activeCostStore.snapshot(), costVersion: activeCostStore.version, pricing: activeCostStore.channelPricing(costId) });
      return;
    }
    const settingsId = channelId(url.pathname, 'settings');
    if (settingsId && req.method === 'PUT') {
      requireWrite();
      const input = normalizeChannelSettings(await readJson(req));
      const channels = items(await activeClient.channels());
      const channel = channels.find((item) => Number(item.id) === settingsId);
      if (!channel) throw Object.assign(new Error('Channel not found'), { statusCode: 404 });
      const channelModels = normalizeModels(channel.models);
      const models = input.models === null ? channelModels : input.models;
      const testModel = input.testModel === null
        ? String(channel.test_model || '').trim()
        : input.testModel;
      if (testModel && !models.includes(testModel)) {
        throw Object.assign(new Error('Test model must be in the channel model list'), { statusCode: 400 });
      }
      if (input.baseVersion !== activeCostStore.version) {
        throw Object.assign(new Error('Cost rules changed; refresh and try again'), { statusCode: 409 });
      }
      const currentPricing = activeCostStore.channelPricing(settingsId);
      const multiplierChanged = Math.abs(Number(currentPricing.multiplier) - input.multiplier) > 1e-9;
      const modeChanged = currentPricing.sync.mode !== input.costSyncMode;
      await activeClient.updateChannelRouting(settingsId, input.weight, input.priority, testModel, models);
      let snapshot = activeCostStore.snapshot();
      try {
        if (multiplierChanged || modeChanged) {
          snapshot = await activeCostStore.setChannelConfiguration(channel, {
            multiplier: input.multiplier,
            mode: input.costSyncMode,
          }, input.baseVersion);
        }
      } catch (error) {
        try {
          await activeClient.updateChannelRouting(
            settingsId,
            Number(channel.weight) || 0,
            Number(channel.priority) || 0,
            String(channel.test_model || '').trim(),
            channelModels,
          );
        } catch {
          throw Object.assign(new Error('Routing changed but cost pricing failed; refresh and verify the channel'), { statusCode: 502 });
        }
        throw error;
      }
      if (input.costSyncMode === 'auto' && (multiplierChanged || modeChanged)) {
        await triggerCostSync({ onlyId: settingsId });
      }
      json(res, 200, {
        routing: { id: settingsId, weight: input.weight, priority: input.priority, testModel, models },
        costVersion: activeCostStore.version,
        pricing: activeCostStore.channelPricing(settingsId),
      });
      return;
    }
    const primaryId = channelId(url.pathname, 'primary');
    if (primaryId && req.method === 'POST') {
      requireWrite();
      const channels = items(await activeClient.channels());
      const channel = channels.find((item) => Number(item.id) === primaryId);
      if (!channel) throw Object.assign(new Error('Channel not found'), { statusCode: 404 });
      const pool = routingPool(channel);
      if (!pool) throw Object.assign(new Error('Unsupported channel routing pool'), { statusCode: 400 });
      json(res, 200, await withRoutingPoolLock(pool, () => makeChannelPrimary(primaryId, pool)));
      return;
    }
    const modelsId = channelId(url.pathname, 'models');
    if (modelsId && req.method === 'POST') {
      requireWrite();
      const channels = items(await activeClient.channels());
      if (!channels.some((channel) => Number(channel.id) === modelsId)) {
        throw Object.assign(new Error('Channel not found'), { statusCode: 404 });
      }
      let result;
      try {
        result = await activeClient.fetchSavedChannelModels(modelsId);
      } catch {
        throw Object.assign(new Error('Unable to fetch models from the saved upstream channel'), { statusCode: 502 });
      }
      const models = normalizeModels(Array.isArray(result) ? result.map((item) => item?.id || item) : result?.data || result?.models || []);
      json(res, 200, { models });
      return;
    }
    if (url.pathname === '/api/channels/fetch-models' && req.method === 'POST') {
      requireWrite();
      await fetchChannelModels(req, res);
      return;
    }
    if (url.pathname === '/api/channels' && req.method === 'POST') {
      requireWrite();
      await createChannel(req, res);
      return;
    }
    const testId = routeChannelId(url.pathname, 'test');
    if (testId && req.method === 'POST') {
      requireWrite();
      const channels = items(await activeClient.channels());
      const channel = channels.find((item) => String(item.id) === String(testId));
      if (!channel) throw Object.assign(new Error('Channel not found'), { statusCode: 404 });
      const payload = gatewayPanel ? await readJson(req) : {};
      if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw Object.assign(new Error('检测参数格式错误'), { statusCode: 400, code: 'invalid_contract' });
      if (gatewayPanel && payload.wait !== undefined && typeof payload.wait !== 'boolean') {
        throw Object.assign(new Error('检测参数格式错误'), { statusCode: 400, code: 'invalid_contract' });
      }
      if (gatewayPanel) {
        const startedAt = Date.now();
        const { response: probe, channelId: configuredId, modelId, protocol } = await submitGatewayProbe(channel, 'manual', payload.poolId);
        rememberManualProbe(probe.attempt_id);
        const pending = probe.state === 'accepted' || probe.state === 'running';
        if (!payload.wait || !pending || typeof probe.attempt_id !== 'string') { json(res, pending ? 202 : 200, probe); return; }
        const result = await awaitProbeResult(configuredId, probe.attempt_id, startedAt);
        // A timeout is not a failure: the probe is still running and its result lands in the history when it ends.
        if (!result) { json(res, 202, { ...probe, waitTimedOut: true, waitedMs: Date.now() - startedAt }); return; }
        json(res, 200, { ...probe, state: 'completed', success: result.success, latencyMs: result.latencyMs,
          statusCode: result.statusCode, errorClass: result.message, model: modelId, protocol, source: 'manual',
          checkedAt: result.checkedAt, waitedMs: Date.now() - startedAt });
        return;
      }
      const probe = await probeChannelHealth(channel, 'manual', payload.poolId);
      overviewCache.clear();
      json(res, 200, {
        id: testId,
        success: probe.success,
        time: probe.latencyMs === null ? 0 : probe.latencyMs / 1000,
        message: probe.message || '',
        error_code: probe.errorCode,
      });
      return;
    }
    const statusId = channelId(url.pathname, 'status');
    if (statusId && req.method === 'POST') {
      requireWrite();
      const payload = await readJson(req);
      const status = Number(payload.status);
      if (![1, 2].includes(status)) throw Object.assign(new Error('Channel status must be enabled or disabled'), { statusCode: 400 });
      json(res, 200, await activeClient.updateChannelStatus(statusId, status));
      return;
    }
    failure(res, 404, 'API route not found');
  }

  async function handle(req, res) {
    const url = new URL(req.url, 'http://localhost');
    requestOrigin(req, { allowRemote: allowRemoteRequests });
    if (url.pathname.startsWith('/api/')) {
      const isWriteRequest = !['GET', 'HEAD'].includes(req.method);
      try {
        await handleApi(req, res, url);
      } finally {
        if (isWriteRequest) invalidateChannelList();
      }
      return;
    }
    const staticName = STATIC_FILES.get(url.pathname);
    if (!staticName || req.method !== 'GET') {
      failure(res, 404, 'Route not found');
      return;
    }
    try {
      const content = await readFile(path.join(publicRoot, staticName));
      res.writeHead(200, {
        'content-type': CONTENT_TYPES[path.extname(staticName)] || 'application/octet-stream',
        'cache-control': 'no-cache',
        'x-content-type-options': 'nosniff',
        'content-security-policy': "default-src 'self'; style-src 'self'; script-src 'self'; img-src 'self' data:; connect-src 'self'",
      });
      res.end(content);
    } catch {
      failure(res, 404, 'Static file not found');
    }
  }

  const server = http.createServer((req, res) => {
    handle(req, res).catch((error) => failure(res, error.statusCode || error.status || 502, error.message, error.code));
  });

  return {
    server,
    client: activeClient,
    costStore: activeCostStore,
    modelPricingStore: activeModelPricingStore,
    newApiPricingSyncStore: activeNewApiPricingSyncStore,
    walletStore: activeWalletStore,
    walletService: activeWalletService,
    channelHealthStore: activeChannelHealthStore,
    logCacheStore: activeLogCacheStore,
    gatewayProjection: activeGatewayProjection,
    triggerChannelHealthProbes,
    channelHealthSettings,
    // 启动快照只存 200 条明细，日志多的周期恢复不了；启动后在后台把默认周期算好
    // 启动时的价格同步结束会清空 overview 缓存，所以要等它跑完再预热
    async warmOverview(periodKey = 'today') {
      if (gatewayPanel) return refreshGatewayProjection();
      if (modelPricingSyncPromise) await modelPricingSyncPromise.catch(() => {});
      const period = resolvePeriod({ period: periodKey });
      if (overviewCache.has(period.cacheKey)) return null;
      return refreshOverview(period);
    },
    async start({ host = process.env.HOST || '127.0.0.1', port = Number(process.env.PORT || 8787) } = {}) {
      if (started) return;
      closing = false;
      if (gatewayControl) await gatewayControl.load();
      await activeCostStore.load();
      activeCostSyncIntervalMs = costSyncIntervalMs ?? costSyncSettings().costSyncIntervalMinutes * 60_000;
      await activeModelPricingStore.load();
      await activeNewApiPricingSyncStore.load();
      await activeWalletStore.load();
      await activeChannelHealthStore.load();
      if (gatewayPanel) await activeGatewayProjection.load();
      if (legacyBackfill) await legacyBackfill.load();
      if (!gatewayPanel) {
        await activeLogCacheStore.load();
        for (const entry of activeLogCacheStore.overviewEntries()) {
          if (Number(entry.value.metrics?.upstreamAttempts) > (entry.value.logs?.length || 0)
            || Number(entry.value.metrics?.errorCount) > (entry.value.errors?.length || 0)) continue;
          overviewCache.set(entry.cacheKey, {
            value: entry.value,
            fetchedAt: entry.fetchedAt,
            period: entry.period,
          });
        }
      }
      activeChannelHealthIntervalMs = channelHealthSettings().probeIntervalMinutes * 60_000;
      allowRemoteRequests = !['127.0.0.1', 'localhost', '::1'].includes(String(host).trim().toLowerCase());
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, host, resolve);
      });
      started = true;
      if (gatewayPanel) {
        console.info(`[gateway] upstream automation: ${upstreamAutomation}; manual operations remain available`);
        refreshGatewayProjection().catch(() => {});
        gatewayProjectionTimer = setInterval(() => { refreshGatewayProjection().catch(() => {}); }, 1000);
        gatewayProjectionTimer.unref?.();
        legacyBackfill?.start();
        if (automaticUpstreamTasksEnabled) {
          scheduleCostSyncTimer();
          scheduleChannelHealthTimer();
          channelHealthStartupTimer = setTimeout(() => {
            channelHealthStartupTimer = null;
            startupGatewayProbes().catch(() => {});
          }, gatewayProbeStartupDelayMs);
          channelHealthStartupTimer.unref?.();
          modelPricingSyncTimer = setInterval(() => { triggerModelPricingSync().catch(() => {}); }, modelPricingSyncIntervalMs);
          modelPricingSyncTimer.unref?.();
          await activeWalletService.start();
        }
        return;
      }
      scheduleCostSyncTimer();
      scheduleChannelHealthTimer();
      modelPricingSyncTimer = setInterval(() => {
        triggerModelPricingSync().catch(() => {});
      }, modelPricingSyncIntervalMs);
      modelPricingSyncTimer.unref?.();
      await activeWalletService.start();
      triggerModelPricingSync().catch(() => {});
      if (activeClient.configured?.()) {
        channelHealthStartupTimer = setTimeout(() => {
          channelHealthStartupTimer = null;
          triggerChannelHealthProbes().catch(() => {});
        }, channelHealthStartupDelayMs);
        channelHealthStartupTimer.unref?.();
        triggerCostSync().catch(() => {});
        activeWalletService.refreshAll().catch(() => {});
      }
    },
    async close() {
      closing = true;
      if (gatewayProjectionTimer) { clearInterval(gatewayProjectionTimer); gatewayProjectionTimer = null; }
      if (legacyBackfill) await legacyBackfill.stop();
      if (activeGatewayProjection?.rebuildPending) await activeGatewayProjection.rebuildPending.catch(() => {});
      if (activeGatewayProjection?.pending) await activeGatewayProjection.pending.catch(() => {});
      if (costSyncTimer) {
        clearInterval(costSyncTimer);
        costSyncTimer = null;
      }
      if (channelHealthTimer) {
        clearInterval(channelHealthTimer);
        channelHealthTimer = null;
      }
      if (channelHealthStartupTimer) {
        clearTimeout(channelHealthStartupTimer);
        channelHealthStartupTimer = null;
      }
      if (modelPricingSyncTimer) {
        clearInterval(modelPricingSyncTimer);
        modelPricingSyncTimer = null;
      }
      if (modelPricingConfirmationTimer) {
        clearTimeout(modelPricingConfirmationTimer);
        modelPricingConfirmationTimer = null;
      }
      if (costSyncPromise) await costSyncPromise.catch(() => {});
      if (modelPricingSyncPromise) await modelPricingSyncPromise.catch(() => {});
      if (channelHealthPromise) await channelHealthPromise.catch(() => {});
      await activeWalletService.stop();
      if (!server.listening) {
        allowRemoteRequests = false;
        started = false;
        return;
      }
      server.closeIdleConnections?.();
      await new Promise((resolve) => server.close(resolve));
      // 日志缓存是延迟批量落盘的，退出前把未写的部分写完
      await activeLogCacheStore.flush?.().catch((error) => console.error('[log-cache] flush on close failed', error));
      overviewCache.clear();
      overviewPromises.clear();
      recentLogCache.clear();
      recentLogPromises.clear();
      allowRemoteRequests = false;
      started = false;
    },
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  const app = createApp();
  app.start().then(() => {
    const address = app.server.address();
    console.log(`new-api-ops-console listening on http://${address.address}:${address.port}`);
    app.warmOverview().catch((error) => console.error(`[warm] ${error.message}`));
  }).catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
  // 容器里是 PID 1，不处理 SIGTERM 的话 docker stop 要等超时强杀
  let shuttingDown = false;
  for (const signal of ['SIGTERM', 'SIGINT']) {
    process.on(signal, () => {
      if (shuttingDown) return;
      shuttingDown = true;
      const forceExit = setTimeout(() => process.exit(1), 8000);
      forceExit.unref();
      app.close()
        .catch((error) => console.error(`[shutdown] ${error.message}`))
        .finally(() => process.exit(0));
    });
  }
}
