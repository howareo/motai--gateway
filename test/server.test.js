import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { gunzipSync } from 'node:zlib';
import { ChannelHealthStore } from '../src/channel-health-store.js';
import { CostStore } from '../src/cost-store.js';
import { LogCacheStore } from '../src/log-cache-store.js';
import { createApp } from '../src/server.js';
import { WalletStore } from '../src/wallet-store.js';

function fakeClient() {
  const state = {
    configured: false,
    creates: 0,
    routingUpdates: 0,
    affinityClears: [],
    savedModelFetches: 0,
    probes: 0,
    channelTests: 0,
    statusCalls: 0,
    channelCalls: 0,
    logCalls: 0,
    activeLogCalls: 0,
    maxConcurrentLogCalls: 0,
    logDelayMs: 0,
    recentLogRequests: [],
    logTimeRanges: [],
    errorItems: [],
    failLogsWithStatus: null,
    truncatedLogs: false,
    failStatusWithStatus: null,
    probeError: null,
    probeMultiplier: 0.1,
    nowTimestamp: Math.floor(Date.now() / 1000),
    fetchModelsInput: null,
    channels: [{ id: 1, name: 'Claude A', type: 14, status: 1, weight: 10, priority: 0, response_time: 120, models: 'claude-sonnet-5,claude-opus-5', test_model: 'claude-sonnet-5', balance: 2 }],
  };
  return {
    state,
    baseUrl: 'http://new-api.test',
    configured() { return state.configured; },
    async status() {
      state.statusCalls += 1;
      if (state.failStatusWithStatus) throw Object.assign(new Error('status limited'), { status: state.failStatusWithStatus });
      return { server_address: 'http://new-api.test', quota_per_unit: 500000 };
    },
    async channels() {
      state.channelCalls += 1;
      return { items: state.channels.map((channel) => ({ ...channel })) };
    },
    async logs({ type, startTimestamp = 0, endTimestamp = 0, maxPages = null, priority = 0 } = {}) {
      state.logCalls += 1;
      state.recentLogRequests.push({ type, maxPages, priority });
      state.logTimeRanges.push({ type, startTimestamp, endTimestamp });
      state.activeLogCalls += 1;
      state.maxConcurrentLogCalls = Math.max(state.maxConcurrentLogCalls, state.activeLogCalls);
      try {
        if (state.logDelayMs) await new Promise((resolve) => setTimeout(resolve, state.logDelayMs));
        if (state.failLogsWithStatus) throw Object.assign(new Error('logs limited'), { status: state.failLogsWithStatus });
        if (type === 5) return { items: state.errorItems, total: state.errorItems.length, truncated: state.truncatedLogs };
        return { items: [{
          id: 7,
          created_at: state.nowTimestamp,
          channel: 1,
          channel_name: 'Claude A',
          username: 'admin',
          token_name: 'local-claude',
          model_name: 'claude-sonnet-5',
          prompt_tokens: 100,
          completion_tokens: 20,
          quota: 1000,
          use_time: 2,
          is_stream: true,
          other: JSON.stringify({ usage_semantic: 'anthropic', cache_tokens: 30, cache_creation_tokens: 10, cache_creation_tokens_5m: 10, reasoning_effort: 'high', frt: 240, admin_info: { use_channel: [2, 1] } }),
        }], total: 1, truncated: state.truncatedLogs };
      } finally {
        state.activeLogCalls -= 1;
      }
    },
    async testChannel(id) {
      state.channelTests += 1;
      return { success: true, id, time: 0.2 };
    },
    async fetchModels(input) {
      state.fetchModelsInput = { ...input, key: input?.key ? '[redacted]' : '' };
      return [{ id: 'claude-x' }, { id: 'claude-y' }];
    },
    async fetchSavedChannelModels(id) {
      state.savedModelFetches += 1;
      return id === 1 ? ['claude-sonnet-5', 'claude-fable-5'] : [];
    },
    async createChannel(channel) {
      state.creates += 1;
      const id = Math.max(0, ...state.channels.map((item) => Number(item.id) || 0)) + 1;
      state.channels.push({ ...channel, id, status: 2, response_time: 0, balance: 0 });
      return { success: true };
    },
    async updateChannelStatus(id, status) {
      const channel = state.channels.find((item) => item.id === id);
      channel.status = status;
      return { success: true, id, status };
    },
    async updateChannelRouting(id, weight, priority, testModel, models = null, group = null) {
      const channel = state.channels.find((item) => item.id === id);
      channel.weight = weight;
      channel.priority = priority;
      channel.test_model = testModel;
      if (models !== null) channel.models = models.join(',');
      if (group !== null) channel.group = group;
      state.routingUpdates += 1;
      return { success: true, id, weight, priority };
    },
    async clearChannelAffinity(ruleName) {
      state.affinityClears.push(ruleName);
      return { deleted: 3 };
    },
    async probeSub2Billing() {
      state.probes += 1;
      if (state.probeError) throw state.probeError;
      return {
        status: 'ok',
        effective_rate_multiplier: state.probeMultiplier,
        observed_at: new Date().toISOString(),
      };
    },
    async probeWallet() {
      return { status: 'ok', balance: 12.34, currency: 'USD', fetched_at: new Date().toISOString() };
    },
  };
}

async function setup(t, appOptions = {}) {
  const { startHost = '127.0.0.1', ...createAppOptions } = appOptions;
  const directory = await mkdtemp(path.join(tmpdir(), 'new-api-console-'));
  const costs = new CostStore(path.join(directory, 'costs.json'));
  const wallets = new WalletStore({
    statePath: path.join(directory, 'wallet-state.json'),
    credentialsPath: path.join(directory, 'wallet-credentials.json'),
  });
  const channelHealth = new ChannelHealthStore({ filePath: path.join(directory, 'channel-health.json') });
  const logCache = new LogCacheStore({ filePath: path.join(directory, 'log-cache.json') });
  const client = fakeClient();
  const modelPricingStore = appOptions.modelPricingStore || {
    async load() {},
    async refresh() { return this.snapshot(); },
    resolve() { return null; },
    snapshot() { return { source: 'test', lastSuccessAt: null, lastError: null, records: 0, models: 0 }; },
  };
  const app = createApp({ client, costStore: costs, walletStore: wallets, channelHealthStore: channelHealth, logCacheStore: logCache, modelPricingStore, ...createAppOptions });
  await app.start({ host: startHost, port: 0 });
  client.state.configured = true;
  t.after(async () => {
    await app.close();
    await rm(directory, { recursive: true, force: true });
  });
  const port = app.server.address().port;
  const origin = `http://127.0.0.1:${port}`;
  return { app, client, costs, wallets, channelHealth, logCache, modelPricingStore, port, origin };
}

function headers(origin, write = false) {
  return write ? { origin, 'content-type': 'application/json' } : {};
}

test('exposes the actual model-specific multiplier for each channel in the price catalog', async (t) => {
  const { origin, costs, client } = await setup(t);
  await costs.save([
    ...costs.list(),
    { channelId: '1', model: '*', multiplier: 0.4, effectiveFrom: 1 },
    { channelId: '1', model: 'claude-sonnet-5', multiplier: 0.125, effectiveFrom: 1 },
  ]);
  client.state.channels.push({ ...client.state.channels[0], id: 2, name: 'Claude B', models: 'claude-opus-5' });
  const response = await fetch(`${origin}/api/overview?hours=24`);
  assert.equal(response.status, 200);
  const { pricingCatalog } = await response.json();
  assert.deepEqual(pricingCatalog.find((row) => row.model === 'claude-sonnet-5').channelMultipliers, { 1: 0.125 });
  assert.deepEqual(pricingCatalog.find((row) => row.model === 'claude-opus-5').channelMultipliers, { 1: 0.4, 2: 0.3 });
});

test('serves loopback analytics without a browser session and keeps model proxy routes absent', async (t) => {
  const { origin } = await setup(t);
  const overviewResponse = await fetch(`${origin}/api/overview?hours=24`);
  const overview = await overviewResponse.json();
  assert.equal(overviewResponse.status, 200);
  assert.equal(overview.metrics.requests, 1);
  assert.equal(overview.logs, undefined);
  assert.equal(overview.errors, undefined);
  assert.equal(overview.requestTotal, 1);
  assert.deepEqual(overview.requestModels, ['claude-sonnet-5']);
  assert.deepEqual(overview.pricingCatalog.map((row) => row.model), ['claude-opus-5', 'claude-sonnet-5']);
  assert.deepEqual(overview.pricingCatalog[0].channels, ['Claude A']);
  assert.deepEqual(overview.pricingCatalog[0].channelMultipliers, { 1: 0.3 });

  const requestsResponse = await fetch(`${origin}/api/requests?hours=24`);
  const requests = await requestsResponse.json();
  assert.equal(requestsResponse.status, 200);
  assert.equal(requests.items[0].ttftMs, 240);
  assert.equal(requests.items[0].outputTokensPerSecond, 10);
  assert.equal(requests.items[0].reasoningEffort, 'high');
  assert.equal(requests.items[0].failover, true);
  assert.equal(requests.items[0].estimatedCost, 0.000096975);

  const proxyResponse = await fetch(`${origin}/v1/messages`, { method: 'POST', body: '{}' });
  assert.equal(proxyResponse.status, 404);

  const obsoleteSessionRoute = await fetch(`${origin}/api/session`);
  assert.equal(obsoleteSessionRoute.status, 404);
});

test('negotiates gzip for large JSON responses without truncating logs and leaves small responses plain', async (t) => {
  const { client, origin } = await setup(t);
  const records = Array.from({ length: 250 }, (_, index) => ({
    id: index + 1, channel: 1, created_at: client.state.nowTimestamp - index, model_name: 'claude-sonnet-5',
    username: 'gzip-test', prompt_tokens: index + 1, completion_tokens: 2,
  }));
  client.logs = async ({ type }) => ({ items: type === 5 ? [] : records });
  const request = (pathname, acceptEncoding) => new Promise((resolve, reject) => {
    const req = http.get(`${origin}${pathname}`, { headers: acceptEncoding === undefined ? {} : { 'accept-encoding': acceptEncoding } }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('error', reject);
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
  });
  const compressed = await request('/api/requests?hours=24', 'br, GZip; q=0.5');
  assert.equal(compressed.status, 200);
  assert.equal(compressed.headers['content-encoding'], 'gzip');
  assert.equal(compressed.headers.vary, 'Accept-Encoding');
  assert.equal(Number(compressed.headers['content-length']), compressed.body.length);
  const decoded = gunzipSync(compressed.body);
  assert.ok(decoded.length > 64 * 1024);
  assert.ok(compressed.body.length < decoded.length);
  const payload = JSON.parse(decoded);
  assert.equal(payload.total, 250);
  assert.equal(payload.items.length, 100);
  assert.deepEqual(payload.items.map((log) => log.id), records.slice(0, 100).map((log) => log.id));

  for (const encoding of [undefined, 'identity', 'br', 'gzip;q=0', 'gzip; q = 0, *;q=1', '*;q=0']) {
    const plain = await request('/api/requests?hours=24', encoding);
    assert.equal(plain.status, 200);
    assert.equal(plain.headers['content-encoding'], undefined, String(encoding));
    assert.equal(plain.headers.vary, 'Accept-Encoding');
    assert.equal(Number(plain.headers['content-length']), plain.body.length);
    const plainPayload = JSON.parse(plain.body);
    assert.deepEqual(plainPayload.items, payload.items);
    assert.equal(plainPayload.total, payload.total);
  }
  const wildcard = await request('/api/requests?hours=24', '*;q=0.5');
  assert.equal(wildcard.headers['content-encoding'], 'gzip');
  assert.equal(JSON.parse(gunzipSync(wildcard.body)).items.length, 100);

  const small = await request('/api/healthz', 'gzip');
  assert.equal(small.status, 200);
  assert.equal(small.headers['content-encoding'], undefined);
  assert.equal(Number(small.headers['content-length']), small.body.length);
  assert.deepEqual(JSON.parse(small.body), { ok: true, newApi: true, cached: true });
  const error = await request('/api/does-not-exist', 'gzip');
  assert.equal(error.status, 404);
  assert.equal(error.headers['content-encoding'], undefined);
  assert.equal(JSON.parse(error.body).error.message, 'API route not found');
});

test('coalesces overview loads, caches repeated tabs, and waits for an explicit refresh', async (t) => {
  const originalNow = Date.now;
  let now = originalNow();
  Date.now = () => now;
  t.after(() => { Date.now = originalNow; });
  const { client, logCache, origin } = await setup(t, { overviewCacheTtlMs: 60_000, overviewStaleMaxAgeMs: 600_000 });
  const request = (suffix = '') => fetch(`${origin}/api/overview?hours=24${suffix}`);
  const beforeLogs = client.state.logCalls;
  const concurrent = await Promise.all([request(), request(), request()]);
  assert.deepEqual(concurrent.map((response) => response.status), [200, 200, 200]);
  assert.equal(client.state.logCalls - beforeLogs, 2);

  const cached = await request();
  assert.equal(cached.status, 200);
  assert.equal((await cached.json()).cacheStatus, 'cached');
  assert.equal(client.state.logCalls - beforeLogs, 2);

  const checkedThrough = logCache.checkedThrough(2);
  await logCache.merge(2, [{ id: 99, created_at: checkedThrough + 3600 }]);
  now += 1000;
  const refreshed = await request('&force=1');
  assert.equal((await refreshed.json()).cacheStatus, 'fresh');
  assert.equal(client.state.logCalls - beforeLogs, 4);
  assert.deepEqual(client.state.logTimeRanges.slice(-2).map(({ startTimestamp }) => startTimestamp), [
    checkedThrough - 5 * 60,
    checkedThrough - 5 * 60,
  ]);

  client.state.failStatusWithStatus = 429;
  const stale = await request('&force=1');
  const stalePayload = await stale.json();
  assert.equal(stale.status, 200);
  assert.equal(stalePayload.cacheStatus, 'stale');
  assert.equal(stalePayload.metrics.requests, 1);
  assert.equal(client.state.logCalls - beforeLogs, 4);
});

test('refreshes recent requests through bounded log pages without rebuilding the full overview', async (t) => {
  const { client, logCache, origin } = await setup(t);
  client.state.errorItems = [{
    id: 8,
    created_at: client.state.nowTimestamp + 10,
    channel: 1,
    channel_name: 'Claude A',
    model_name: 'claude-sonnet-5',
    request_id: 'request-error-8',
    content: 'status_code=503, upstream busy',
  }];
  const before = client.state.logCalls;
  const started = Date.now();
  const response = await fetch(`${origin}/api/recent-requests?hours=24&force=1`);
  const payload = await response.json();
  assert.equal(response.status, 200);
  assert.ok(Date.now() - started < 500);
  assert.deepEqual(payload.logs.map((event) => event.kind), ['error', 'success']);
  assert.equal(payload.totals.errors, 1);
  assert.equal(client.state.logCalls - before, 2);
  assert.ok(client.state.recentLogRequests.slice(-2).every((request) => request.maxPages === 1 && request.priority === 10));
  assert.equal(logCache.checkedThrough(2), 0);
  assert.equal(logCache.checkedThrough(5), 0);

  const cached = await fetch(`${origin}/api/recent-requests?hours=24`);
  assert.equal(cached.status, 200);
  assert.equal((await cached.json()).cacheStatus, 'cached');
  assert.equal(client.state.logCalls - before, 2);
});

test('shares one channel list fetch between concurrent overview and recent-requests reads', async (t) => {
  const { client, origin } = await setup(t);
  const before = client.state.channelCalls;
  const [overviewResponse, recentResponse] = await Promise.all([
    fetch(`${origin}/api/overview?hours=24`),
    fetch(`${origin}/api/recent-requests?hours=24`),
  ]);
  assert.equal(overviewResponse.status, 200);
  assert.equal(recentResponse.status, 200);
  assert.equal(client.state.channelCalls - before, 1);
});

test('invalidates the shared channel list cache after a write so a forced overview sees the change', async (t) => {
  const { client, origin } = await setup(t);
  client.state.channels.push({ id: 2, name: 'Claude B', type: 14, status: 1, weight: 20, priority: 0, group: 'default', models: 'claude-opus-5', test_model: 'claude-opus-5' });

  const warm = await fetch(`${origin}/api/overview?hours=24&force=1`);
  assert.equal(warm.status, 200);
  const warmPayload = await warm.json();
  const warmChannel = warmPayload.channels.find((channel) => channel.id === 2);
  assert.equal(warmChannel.priority, 0);

  const primaryResponse = await fetch(`${origin}/api/channels/2/primary`, {
    method: 'POST',
    headers: headers(origin, true),
    body: '{}',
  });
  assert.equal(primaryResponse.status, 200);

  const after = await fetch(`${origin}/api/overview?hours=24&force=1`);
  assert.equal(after.status, 200);
  const afterPayload = await after.json();
  const afterChannel = afterPayload.channels.find((channel) => channel.id === 2);
  assert.equal(afterChannel.priority, 1);
});

test('serializes uncached overview periods and keeps the 30-day result cached', async (t) => {
  const { client, origin } = await setup(t, { overviewCacheTtlMs: 0 });
  client.state.logDelayMs = 10;
  const responses = await Promise.all([
    fetch(`${origin}/api/overview?hours=24`),
    fetch(`${origin}/api/overview?hours=720`),
  ]);
  assert.deepEqual(responses.map((response) => response.status), [200, 200]);
  assert.equal(client.state.maxConcurrentLogCalls, 1);
  const logCalls = client.state.logCalls;

  const cached = await fetch(`${origin}/api/overview?hours=720`);
  assert.equal(cached.status, 200);
  assert.equal((await cached.json()).cacheStatus, 'cached');
  assert.equal(client.state.logCalls, logCalls);
});

test('resolves today and yesterday as separate calendar periods for overview and recent requests', async (t) => {
  const originalNow = Date.now;
  Date.now = () => Date.parse('2026-10-18T17:00:00Z');
  t.after(() => { Date.now = originalNow; });
  const { client, origin } = await setup(t);
  const todayStart = Date.parse('2026-10-18T16:00:00Z') / 1000;
  const yesterdayStart = Date.parse('2026-10-17T16:00:00Z') / 1000;

  const todayResponse = await fetch(`${origin}/api/overview?period=today`);
  const today = await todayResponse.json();
  assert.equal(todayResponse.status, 200);
  assert.equal(today.periodKey, 'today');
  assert.equal(today.periodLabel, '今天');
  assert.equal(Date.parse(today.periodStartAt) / 1000, todayStart);
  assert.ok(today.periodEndAt);
  const todayRanges = client.state.logTimeRanges.slice(-2);
  assert.deepEqual(todayRanges.map(({ startTimestamp }) => startTimestamp), [todayStart, todayStart]);
  assert.ok(todayRanges.every(({ endTimestamp }) => endTimestamp >= todayStart && endTimestamp <= Math.floor(Date.now() / 1000)));
  assert.equal(todayRanges[0].endTimestamp, todayRanges[1].endTimestamp);

  const yesterdayResponse = await fetch(`${origin}/api/recent-requests?period=yesterday`);
  const yesterday = await yesterdayResponse.json();
  assert.equal(yesterdayResponse.status, 200);
  assert.equal(yesterday.periodKey, 'yesterday');
  assert.equal(yesterday.periodLabel, '昨天');
  assert.equal(Date.parse(yesterday.periodStartAt) / 1000, yesterdayStart);
  assert.equal(Date.parse(yesterday.periodEndAt) / 1000, todayStart);
  assert.deepEqual(client.state.logTimeRanges.slice(-2).map(({ startTimestamp, endTimestamp }) => [startTimestamp, endTimestamp]), [
    [yesterdayStart, todayStart],
    [yesterdayStart, todayStart],
  ]);
});

test('fills history and the recent gap during the same overview refresh', async (t) => {
  const originalNow = Date.now;
  let now = Date.parse('2026-10-19T04:00:00Z');
  Date.now = () => now;
  t.after(() => { Date.now = originalNow; });
  const { client, logCache, origin } = await setup(t);
  const endTimestamp = Math.floor(now / 1000);
  await fetch(`${origin}/api/overview?hours=1`);
  now += 3600_000;
  const response = await fetch(`${origin}/api/overview?hours=24`);
  assert.equal(response.status, 200);
  const requests = client.state.logTimeRanges.slice(2);
  assert.equal(requests.length, 4);
  for (const type of [2, 5]) {
    assert.deepEqual(requests.filter((entry) => entry.type === type), [
      { type, startTimestamp: endTimestamp - 23 * 3600, endTimestamp: endTimestamp - 3600 - 1 },
      { type, startTimestamp: endTimestamp - 5 * 60, endTimestamp: endTimestamp + 3600 },
    ]);
    assert.equal(logCache.checkedThrough(type), endTimestamp + 3600);
  }
});

test('connects disjoint historical periods without declaring a gap covered', async (t) => {
  const originalNow = Date.now;
  Date.now = () => Date.parse('2026-10-19T04:00:00Z');
  t.after(() => { Date.now = originalNow; });
  const { client, origin } = await setup(t);
  await fetch(`${origin}/api/overview?hours=1`);
  const response = await fetch(`${origin}/api/overview?period=yesterday`);
  assert.equal(response.status, 200);
  assert.deepEqual(client.state.logTimeRanges.slice(-2).map(({ startTimestamp, endTimestamp }) => [startTimestamp, endTimestamp]), [
    [Date.parse('2026-10-17T16:00:00Z') / 1000, Date.parse('2026-10-19T03:00:00Z') / 1000 - 1],
    [Date.parse('2026-10-17T16:00:00Z') / 1000, Date.parse('2026-10-19T03:00:00Z') / 1000 - 1],
  ]);
});

test('a recent-only fetch still requires a full first overview sync', async (t) => {
  const { client, logCache, origin } = await setup(t);
  await fetch(`${origin}/api/recent-requests?period=today`);
  assert.equal(logCache.coveredFrom(2), null);
  assert.equal(logCache.coveredFrom(5), null);
  const response = await fetch(`${origin}/api/overview?period=today`);
  const payload = await response.json();
  assert.equal(response.status, 200);
  assert.equal(client.state.logCalls, 4);
  assert.equal(logCache.coveredFrom(2), Date.parse(payload.periodStartAt) / 1000);
});

test('rejects incomplete overview sync pages without advancing cache coverage', async (t) => {
  const { client, logCache, origin } = await setup(t);
  client.state.truncatedLogs = true;
  const response = await fetch(`${origin}/api/overview?period=today`);
  assert.equal(response.status, 502);
  assert.equal(logCache.coveredFrom(2), null);
  assert.equal(logCache.checkedThrough(2), 0);
});

test('recent request caches expire at the Beijing calendar day boundary', async (t) => {
  const originalNow = Date.now;
  let now = Date.parse('2026-10-18T15:59:59Z');
  Date.now = () => now;
  t.after(() => { Date.now = originalNow; });
  const { client, origin } = await setup(t);
  await fetch(`${origin}/api/recent-requests?period=today`);
  now += 2000;
  const response = await fetch(`${origin}/api/recent-requests?period=today`);
  const payload = await response.json();
  assert.equal(response.status, 200);
  assert.equal(payload.cacheStatus, 'fresh');
  assert.equal(client.state.logCalls, 4);
  assert.equal(payload.periodStartAt, '2026-10-18T16:00:00.000Z');
});

test('rebuilds a truncated startup overview snapshot from complete raw cache logs', async (t) => {
  const originalNow = Date.now;
  Date.now = () => Date.parse('2026-10-19T04:00:00Z');
  t.after(() => { Date.now = originalNow; });
  const endTimestamp = Math.floor(Date.now() / 1000);
  const startTimestamp = endTimestamp - 24 * 3600;
  const cache = new LogCacheStore();
  const records = Array.from({ length: 250 }, (_, index) => ({
    id: index + 1, channel: 1, created_at: endTimestamp - index, model_name: 'claude-sonnet-5',
  }));
  await cache.merge(2, records, { coveredFrom: startTimestamp, checkedThrough: endTimestamp });
  await cache.merge(5, [], { coveredFrom: startTimestamp, checkedThrough: endTimestamp });
  await cache.saveOverview({ key: 'hours-24', cacheKey: 'hours-24', startTimestamp, endTimestamp, hours: 24 }, {
    fetchedAt: Date.now(), value: { metrics: { requests: 250, upstreamAttempts: 250, errorCount: 0 }, logs: records, errors: [] },
  });
  assert.equal(cache.overviewEntries()[0].value.logs.length, 200);
  const { client, origin } = await setup(t, { logCacheStore: cache });
  const response = await fetch(`${origin}/api/overview?hours=24`);
  const payload = await response.json();
  assert.equal(response.status, 200);
  assert.equal(payload.cacheStatus, 'fresh');
  assert.equal(payload.metrics.requests, 250);
  assert.equal(payload.requestTotal, 250);
  const requestsResponse = await fetch(`${origin}/api/requests?hours=24`);
  assert.equal((await requestsResponse.json()).total, 250);
  assert.equal(client.state.logCalls, 0);
});

test('warms the default overview period so the first page load is served from cache', async (t) => {
  const { app, client, origin } = await setup(t);
  await app.warmOverview();
  const logCallsAfterWarm = client.state.logCalls;
  assert.ok(logCallsAfterWarm > 0);

  const response = await fetch(`${origin}/api/overview?period=today`);
  const payload = await response.json();
  assert.equal(response.status, 200);
  assert.equal(payload.cacheStatus, 'cached');
  assert.equal(client.state.logCalls, logCallsAfterWarm);
  assert.equal(await app.warmOverview(), null);
});

test('waits for the startup pricing sync before warming so its cache clear cannot discard the warm entry', async (t) => {
  let releasePricing;
  const pricingGate = new Promise((resolve) => { releasePricing = resolve; });
  const modelPricingStore = {
    async load() {},
    async refresh() {
      await pricingGate;
      return this.snapshot();
    },
    resolve() { return null; },
    snapshot() { return { source: 'test', lastSuccessAt: null, lastError: null, records: 0, models: 0 }; },
  };
  const { app, client, origin } = await setup(t, { modelPricingStore });
  const logCallsBeforeWarm = client.state.logCalls;
  const warming = app.warmOverview();
  try {
    // 价格同步未结束时预热不能开始拉日志，否则同步结束的 clear 会冲掉预热结果
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(client.state.logCalls, logCallsBeforeWarm);
  } finally {
    releasePricing();
  }
  await warming;
  const logCallsAfterWarm = client.state.logCalls;

  const response = await fetch(`${origin}/api/overview?period=today`);
  const payload = await response.json();
  assert.equal(response.status, 200);
  assert.equal(payload.cacheStatus, 'cached');
  assert.equal(client.state.logCalls, logCallsAfterWarm);
});

test('treats an upstream health-check 429 as reachable but rate limited', async (t) => {
  const { client, origin } = await setup(t);
  client.state.failStatusWithStatus = 429;
  const response = await fetch(`${origin}/api/healthz`);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true, newApi: true, rateLimited: true });
});

test('automatically probes only enabled channels without overlap and exposes probe availability', async (t) => {
  const { app, client, channelHealth, origin } = await setup(t);
  client.state.channels.push({
    id: 2,
    name: 'Disabled OpenAI',
    type: 1,
    status: 2,
    weight: 10,
    priority: 0,
    response_time: 0,
    models: 'gpt-5.6-sol',
    test_model: 'gpt-5.6-sol',
  });
  await channelHealth.record(2, {
    checkedAt: new Date().toISOString(),
    success: true,
    latencyMs: 120,
    model: 'gpt-5.6-sol',
    statusCode: 200,
    message: 'historical success',
  });

  const first = app.triggerChannelHealthProbes();
  const overlapping = app.triggerChannelHealthProbes();
  assert.equal(first, overlapping);
  const run = await first;
  assert.equal(run.attempted, 1);
  assert.equal(client.state.channelTests, 1);

  const response = await fetch(`${origin}/api/overview?hours=24&force=1`);
  const overview = await response.json();
  assert.equal(response.status, 200);
  assert.equal(overview.channels[0].probeAttempts, 1);
  assert.equal(overview.channels[0].probeSuccessRate, 1);
  assert.equal(overview.channels[0].probeAverageLatencyMs, 200);
  assert.equal(overview.channels[0].probeIntervalMinutes, 15);
  assert.equal(overview.channels[0].recentProbes[0].model, 'claude-sonnet-5');
  assert.equal(overview.channels[1].probeAttempts, 0);
  assert.equal(overview.channels[1].probeSuccesses, 0);
  assert.equal(overview.channels[1].probeFailures, 0);
  assert.equal(overview.channels[1].probeSuccessRate, null);
  assert.equal(overview.channels[1].probeAverageLatencyMs, null);
  assert.equal(overview.channels[1].lastProbeAt, null);
  assert.equal(overview.channels[1].lastProbeSuccess, null);
  assert.equal(overview.channels[1].lastProbeLatencyMs, null);
  assert.equal(overview.channels[1].lastProbeMessage, null);
  assert.deepEqual(overview.channels[1].recentProbes, []);
  assert.equal(overview.channels[1].availabilityAttempts, 0);
  assert.equal(overview.channels[1].availabilitySuccesses, 0);
  assert.equal(overview.channels[1].availabilityFailures, 0);
  assert.equal(overview.channels[1].availabilityRate, null);
  assert.deepEqual(overview.channels[1].recentResults, []);
  assert.equal(overview.channels[1].state, 'disabled');
});

test('serves the cached overview while refreshing in the background after channel probes', async (t) => {
  const { app, client, origin } = await setup(t);
  const warm = await fetch(`${origin}/api/overview?hours=24`);
  const warmPayload = await warm.json();
  assert.equal(warm.status, 200);
  assert.equal(warmPayload.cacheStatus, 'fresh');
  assert.equal(warmPayload.channels[0].probeAttempts, 0);

  await app.triggerChannelHealthProbes();
  // 让后台刷新的日志拉取变慢：若请求同步等待刷新，则状态会是 fresh 而不是 refreshing。
  client.state.logDelayMs = 20;
  const afterProbe = await fetch(`${origin}/api/overview?hours=24`);
  const afterProbePayload = await afterProbe.json();
  assert.equal(afterProbe.status, 200);
  assert.equal(afterProbePayload.cacheStatus, 'refreshing');
  assert.equal(afterProbePayload.channels[0].probeAttempts, 0);

  let settled = null;
  for (let attempt = 0; attempt < 200 && !settled; attempt += 1) {
    const response = await fetch(`${origin}/api/overview?hours=24`);
    const payload = await response.json();
    assert.equal(response.status, 200);
    if (payload.cacheStatus === 'cached') settled = payload;
    else await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.ok(settled, 'background refresh should settle back to cached');
  assert.equal(settled.channels[0].probeAttempts, 1);
});

test('updates and persists the automatic probe interval without a full refresh', async (t) => {
  const { app, channelHealth, origin } = await setup(t);
  const initial = await fetch(`${origin}/api/settings/probes`);
  assert.equal(initial.status, 200);
  assert.equal((await initial.json()).probeIntervalMinutes, 15);

  const update = await fetch(`${origin}/api/settings/probes`, {
    method: 'PUT',
    headers: headers(origin, true),
    body: JSON.stringify({ probeIntervalMinutes: 15 }),
  });
  assert.equal(update.status, 200);
  assert.equal((await update.json()).probeIntervalMinutes, 15);
  assert.equal(app.channelHealthSettings().probeIntervalMinutes, 15);

  const overview = await fetch(`${origin}/api/overview?hours=24&force=1`);
  const payload = await overview.json();
  assert.equal(payload.probeSettings.probeIntervalMinutes, 15);
  assert.equal(payload.channels[0].probeIntervalMinutes, 15);

  const reloaded = new ChannelHealthStore({ filePath: channelHealth.filePath });
  await reloaded.load();
  assert.equal(reloaded.settings().probeIntervalMinutes, 15);
});

test('allows same-origin writes on a non-primary address when the console binds to all interfaces', async (t) => {
  const { costs, origin } = await setup(t, { startHost: '0.0.0.0' });
  const port = new URL(origin).port;
  const alternateOrigin = `http://127.0.0.2:${port}`;
  const update = await fetch(`${alternateOrigin}/api/channels/1/cost`, {
    method: 'PUT',
    headers: {
      origin: alternateOrigin,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ multiplier: 0.25, baseVersion: costs.version }),
  });
  assert.equal(update.status, 200);

  const crossSite = await fetch(`${alternateOrigin}/api/channels/1/cost`, {
    method: 'PUT',
    headers: {
      origin: 'http://127.0.0.3:9999',
      'content-type': 'application/json',
    },
    body: JSON.stringify({ multiplier: 0.3, baseVersion: costs.version + 1 }),
  });
  assert.equal(crossSite.status, 403);
});

test('protects writes with origin checks and rejects stale cost versions', async (t) => {
  const { client, costs, origin } = await setup(t);

  const missingOrigin = await fetch(`${origin}/api/channels/1/cost`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ multiplier: 0.2, baseVersion: costs.version }),
  });
  assert.equal(missingOrigin.status, 403);

  const baseVersion = costs.version;
  const update = await fetch(`${origin}/api/channels/1/cost`, {
    method: 'PUT',
    headers: headers(origin, true),
    body: JSON.stringify({ multiplier: 0.2, baseVersion }),
  });
  assert.equal(update.status, 200);
  assert.equal((await update.json()).pricing.multiplier, 0.2);

  const stale = await fetch(`${origin}/api/channels/1/cost`, {
    method: 'PUT',
    headers: headers(origin, true),
    body: JSON.stringify({ multiplier: 0.1, baseVersion }),
  });
  assert.equal(stale.status, 409);

  const testResponse = await fetch(`${origin}/api/channels/1/test`, {
    method: 'POST',
    headers: headers(origin, true),
    body: '{}',
  });
  assert.equal(testResponse.status, 200);
  assert.equal((await testResponse.json()).id, 1);

  const settingsVersion = costs.version;
  const settingsResponse = await fetch(`${origin}/api/channels/1/settings`, {
    method: 'PUT',
    headers: headers(origin, true),
    body: JSON.stringify({ weight: 25, priority: 3, models: ['claude-opus-5', 'claude-fable-5'], testModel: 'claude-opus-5', multiplier: 0.12, baseVersion: settingsVersion }),
  });
  assert.equal(settingsResponse.status, 200);
  assert.deepEqual((await settingsResponse.json()).routing, { id: 1, weight: 25, priority: 3, testModel: 'claude-opus-5', models: ['claude-opus-5', 'claude-fable-5'] });
  assert.equal(client.state.channels[0].weight, 25);
  assert.equal(client.state.channels[0].priority, 3);
  assert.equal(client.state.channels[0].test_model, 'claude-opus-5');
  assert.equal(client.state.channels[0].models, 'claude-opus-5,claude-fable-5');
  assert.equal(costs.channelPricing(1).multiplier, 0.12);

  const invalidTestModel = await fetch(`${origin}/api/channels/1/settings`, {
    method: 'PUT',
    headers: headers(origin, true),
    body: JSON.stringify({ weight: 25, priority: 3, models: ['claude-opus-5'], testModel: 'not-on-channel', multiplier: 0.12, baseVersion: costs.version }),
  });
  assert.equal(invalidTestModel.status, 400);
  assert.equal(client.state.routingUpdates, 1);

  const staleSettings = await fetch(`${origin}/api/channels/1/settings`, {
    method: 'PUT',
    headers: headers(origin, true),
    body: JSON.stringify({ weight: 10, priority: 0, multiplier: 0.2, baseVersion: settingsVersion }),
  });
  assert.equal(staleSettings.status, 409);
  assert.equal(client.state.routingUpdates, 1);
});

test('sets a channel as the sole primary inside its protocol pool and serializes concurrent switches', async (t) => {
  const { client, origin } = await setup(t);
  client.state.channels.push(
    { id: 2, name: 'Claude B', type: 14, status: 1, weight: 20, priority: 0, group: 'default', models: 'claude-opus-5', test_model: 'claude-opus-5' },
    { id: 3, name: 'Claude C', type: 14, status: 1, weight: 30, priority: 0, group: 'claude', models: 'claude-fable-5', test_model: 'claude-fable-5' },
    { id: 4, name: 'OpenAI A', type: 1, status: 1, weight: 10, priority: 50, models: 'gpt-5.6-sol', test_model: 'gpt-5.6-sol' },
  );
  const request = (id) => fetch(`${origin}/api/channels/${id}/primary`, {
    method: 'POST',
    headers: headers(origin, true),
    body: '{}',
  });

  const [first, second] = await Promise.all([request(2), request(3)]);
  const firstPayload = await first.json();
  const secondPayload = await second.json();

  assert.equal(first.status, 200);
  assert.equal(second.status, 200);
  assert.equal(firstPayload.pool, 'claude');
  assert.equal(secondPayload.poolLabel, 'Claude');
  assert.equal(firstPayload.groupAdded, 'claude');
  assert.deepEqual(firstPayload.affinityReset, { status: 'cleared', rule: 'claude cli trace', deleted: 3 });
  assert.equal(client.state.channels.find((channel) => channel.id === 2).priority, 1);
  assert.equal(client.state.channels.find((channel) => channel.id === 2).group, 'default,claude');
  assert.equal(client.state.channels.find((channel) => channel.id === 3).priority, 2);
  assert.equal(client.state.channels.find((channel) => channel.id === 4).priority, 50);
  assert.deepEqual(client.state.affinityClears, ['claude cli trace', 'claude cli trace']);
});

test('sets a Gemini channel as primary inside the Gemini pool without touching GPT channels or affinity', async (t) => {
  const { client, origin } = await setup(t);
  client.state.channels.push(
    { id: 2, name: 'GPT A', type: 1, status: 1, weight: 10, priority: 50, group: 'openai', models: 'gpt-6-astra', test_model: 'gpt-6-astra' },
    { id: 3, name: 'Gemini A', type: 1, status: 1, weight: 10, priority: 0, group: 'openai', models: 'gemini-3.8-flash', test_model: 'gemini-3.8-flash' },
    { id: 4, name: 'Gemini B', type: 1, status: 1, weight: 10, priority: 0, group: 'openai', models: 'gemini-3.8-flash', test_model: 'gemini-3.8-flash' },
  );
  const response = await fetch(`${origin}/api/channels/3/primary`, {
    method: 'POST',
    headers: headers(origin, true),
    body: '{}',
  });
  const payload = await response.json();

  assert.equal(response.status, 200);
  assert.equal(payload.pool, 'gemini');
  assert.equal(payload.poolLabel, 'Gemini');
  assert.equal(payload.affinityReset, null);
  assert.equal(client.state.channels.find((channel) => channel.id === 3).priority, 1);
  assert.equal(client.state.channels.find((channel) => channel.id === 2).priority, 50);
  assert.deepEqual(client.state.affinityClears, []);
});

test('rejects setting a disabled channel as primary', async (t) => {
  const { client, origin } = await setup(t);
  client.state.channels.push({ id: 2, name: 'Disabled', type: 14, status: 2, weight: 10, priority: 9, models: 'claude-opus-5' });
  const response = await fetch(`${origin}/api/channels/2/primary`, {
    method: 'POST',
    headers: headers(origin, true),
    body: '{}',
  });
  assert.equal(response.status, 409);
  assert.match((await response.json()).error.message, /Disabled channels/);
});

test('fetches models for an existing channel without exposing its key', async (t) => {
  const { client, origin } = await setup(t);

  const response = await fetch(`${origin}/api/channels/1/models`, {
    method: 'POST',
    headers: headers(origin, true),
    body: '{}',
  });

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { models: ['claude-sonnet-5', 'claude-fable-5'] });
  assert.equal(client.state.savedModelFetches, 1);
});

test('creates only a disabled native channel and never returns its key', async (t) => {
  const { client, costs, origin } = await setup(t);

  const modelResponse = await fetch(`${origin}/api/channels/fetch-models`, {
    method: 'POST',
    headers: headers(origin, true),
    body: JSON.stringify({ type: 14, baseUrl: 'https://upstream.example/v1', key: 'sk-sensitive' }),
  });
  assert.deepEqual((await modelResponse.json()).models, ['claude-x', 'claude-y']);
  const xaiModelResponse = await fetch(`${origin}/api/channels/fetch-models`, {
    method: 'POST',
    headers: headers(origin, true),
    body: JSON.stringify({ type: 48, baseUrl: 'https://xai.example/v1', key: 'xai-sensitive' }),
  });
  assert.equal(xaiModelResponse.status, 200);
  assert.deepEqual((await xaiModelResponse.json()).models, ['claude-x', 'claude-y']);
  assert.equal(client.state.fetchModelsInput.type, 48);

  const createResponse = await fetch(`${origin}/api/channels`, {
    method: 'POST',
    headers: headers(origin, true),
    body: JSON.stringify({
      name: 'Claude B',
      type: 14,
      baseUrl: 'https://upstream.example/v1',
      key: 'sk-sensitive',
      models: ['claude-x'],
      priority: 0,
      weight: 10,
      multiplier: 0.25,
      baseVersion: costs.version,
    }),
  });
  const raw = await createResponse.text();
  assert.equal(createResponse.status, 201);
  assert.equal(raw.includes('sk-sensitive'), false);
  assert.equal(JSON.parse(raw).channel.status, 2);
  assert.equal(client.state.creates, 1);
  assert.equal(client.state.channels.find((channel) => channel.id === 2).group, 'claude');

  const duplicate = await fetch(`${origin}/api/channels`, {
    method: 'POST',
    headers: headers(origin, true),
    body: JSON.stringify({ name: ' claude b ', type: 14, baseUrl: 'https://upstream.example/v1', key: 'another', models: ['claude-x'], priority: 0, weight: 10, multiplier: 0.2, baseVersion: costs.version }),
  });
  assert.equal(duplicate.status, 409);
  assert.equal(client.state.creates, 1);

  const openAi = await fetch(`${origin}/api/channels`, {
    method: 'POST',
    headers: headers(origin, true),
    body: JSON.stringify({ name: 'OpenAI B', type: 1, baseUrl: 'https://openai.example/v1', key: 'openai-sensitive', models: ['gpt-5.6-sol'], priority: 0, weight: 10, multiplier: 0.1, baseVersion: costs.version }),
  });
  assert.equal(openAi.status, 201);
  assert.equal(client.state.channels.find((channel) => channel.name === 'OpenAI B').group, 'openai');

  const xai = await fetch(`${origin}/api/channels`, {
    method: 'POST',
    headers: headers(origin, true),
    body: JSON.stringify({ name: 'Grok B', type: 48, baseUrl: 'https://xai.example/v1', key: 'xai-sensitive', models: ['grok-4.5'], priority: 0, weight: 10, multiplier: 0.1, baseVersion: costs.version }),
  });
  assert.equal(xai.status, 201);
  assert.equal(client.state.channels.find((channel) => channel.name === 'Grok B').group, 'openai');

  const enable = await fetch(`${origin}/api/channels/2/status`, {
    method: 'POST',
    headers: headers(origin, true),
    body: JSON.stringify({ status: 1 }),
  });
  assert.equal(enable.status, 200);
  assert.equal(client.state.channels.find((channel) => channel.id === 2).status, 1);

  const forbiddenDelete = await fetch(`${origin}/api/channels/2`, {
    method: 'DELETE',
    headers: headers(origin, true),
    body: '{}',
  });
  assert.equal(forbiddenDelete.status, 404);
});

test('auto cost sync applies a changed multiplier after one valid observation', async (t) => {
  const { client, costs, origin } = await setup(t);

  const enable = await fetch(`${origin}/api/channels/1/cost-sync`, {
    method: 'PUT',
    headers: headers(origin, true),
    body: JSON.stringify({ mode: 'auto', baseVersion: costs.version }),
  });
  const first = await enable.json();
  assert.equal(enable.status, 200);
  assert.equal(first.pricing.multiplier, 0.1);
  assert.equal(first.pricing.sync.status, 'synced');
  assert.equal(client.state.probes, 1);

  const synchronize = await fetch(`${origin}/api/cost-sync`, {
    method: 'POST',
    headers: headers(origin, true),
    body: '{}',
  });
  assert.equal(synchronize.status, 200);
  assert.equal(costs.channelPricing(1).multiplier, 0.1);
  assert.equal(costs.syncState(1).status, 'synced');
  assert.equal(client.state.probes, 2);

  const manual = await fetch(`${origin}/api/channels/1/cost`, {
    method: 'PUT',
    headers: headers(origin, true),
    body: JSON.stringify({ multiplier: 0.2, baseVersion: costs.version }),
  });
  assert.equal(manual.status, 200);
  assert.equal(costs.syncState(1).mode, 'manual');
  assert.equal(costs.syncState(1).humanAnchorMultiplier, 0.2);
});

test('cost-only settings atomically select auto mode without inventing a multiplier and preserve version conflicts', async (t) => {
  const { client, costs, origin } = await setup(t);
  client.probeSub2Billing = async () => ({ status: 'unsupported', error_class: 'endpoint_unsupported' });
  const update = (payload) => fetch(`${origin}/api/channels/1/cost`, { method: 'PUT',
    headers: headers(origin, true), body: JSON.stringify(payload) });
  const baseVersion = costs.version, before = costs.channelPricing(1).multiplier;
  const auto = await update({ costSyncMode: 'auto', baseVersion });
  assert.equal(auto.status, 200);
  const result = await auto.json();
  assert.equal(result.pricing.sync.mode, 'auto');
  assert.equal(result.pricing.multiplier, before);
  assert.equal(result.costVersion, costs.version);
  assert.equal((await update({ costSyncMode: 'manual', multiplier: 0.3, baseVersion })).status, 409);
  const manualVersion = costs.version;
  const manual = await update({ costSyncMode: 'manual', multiplier: 0.3, baseVersion: manualVersion });
  assert.equal(manual.status, 200);
  assert.equal(costs.version, manualVersion + 1);
  assert.equal(costs.channelPricing(1).sync.mode, 'manual');
  assert.equal(costs.channelPricing(1).multiplier, 0.3);
  assert.equal((await update({ costSyncMode: 'manual', multiplier: null, baseVersion: costs.version })).status, 400);
  assert.equal((await update({ costSyncMode: 'typo', multiplier: 0.2, baseVersion: costs.version })).status, 400);
});

test('manual channel cost refresh performs one probe per click', async (t) => {
  const { client, costs, origin } = await setup(t);

  const disabled = await fetch(`${origin}/api/channels/1/cost-sync`, {
    method: 'POST',
    headers: headers(origin, true),
    body: '{}',
  });
  assert.equal(disabled.status, 409);
  assert.equal(client.state.probes, 0);

  const enable = await fetch(`${origin}/api/channels/1/cost-sync`, {
    method: 'PUT',
    headers: headers(origin, true),
    body: JSON.stringify({ mode: 'auto', baseVersion: costs.version }),
  });
  assert.equal(enable.status, 200);
  assert.equal(client.state.probes, 1);

  const initialRefresh = await fetch(`${origin}/api/channels/1/cost-sync`, {
    method: 'POST',
    headers: headers(origin, true),
    body: '{}',
  });
  const initialPayload = await initialRefresh.json();
  assert.equal(initialRefresh.status, 200);
  assert.equal(initialPayload.pricing.multiplier, 0.1);
  assert.equal(initialPayload.pricing.sync.status, 'synced');
  assert.equal(client.state.probes, 2);

  client.state.probeMultiplier = 0.2;
  const changedRefresh = await fetch(`${origin}/api/channels/1/cost-sync`, {
    method: 'POST',
    headers: headers(origin, true),
    body: '{}',
  });
  const changedPayload = await changedRefresh.json();
  assert.equal(changedRefresh.status, 200);
  assert.equal(changedPayload.pricing.multiplier, 0.2);
  assert.equal(changedPayload.pricing.sync.status, 'synced');
  assert.equal(client.state.probes, 3);

  client.state.probeError = Object.assign(new Error('probe rate limited'), { status: 429 });
  const rateLimitedRefresh = await fetch(`${origin}/api/channels/1/cost-sync`, {
    method: 'POST',
    headers: headers(origin, true),
    body: '{}',
  });
  const rateLimitedPayload = await rateLimitedRefresh.json();
  assert.equal(rateLimitedRefresh.status, 200);
  assert.equal(rateLimitedPayload.pricing.multiplier, 0.2);
  assert.equal(rateLimitedPayload.pricing.sync.status, 'synced');
  assert.equal(rateLimitedPayload.pricing.sync.errorClass, 'probe_rate_limited');
  assert.equal(client.state.probes, 4);
});

test('manual channel cost refresh applies a large valid change without confirmation', async (t) => {
  const { client, costs, origin } = await setup(t);

  const enable = await fetch(`${origin}/api/channels/1/cost-sync`, {
    method: 'PUT',
    headers: headers(origin, true),
    body: JSON.stringify({ mode: 'auto', baseVersion: costs.version }),
  });
  assert.equal(enable.status, 200);

  const initialRefresh = await fetch(`${origin}/api/channels/1/cost-sync`, {
    method: 'POST',
    headers: headers(origin, true),
    body: '{}',
  });
  assert.equal(initialRefresh.status, 200);
  assert.equal(costs.channelPricing(1).multiplier, 0.1);

  client.state.probeMultiplier = 0.01;
  const changedRefresh = await fetch(`${origin}/api/channels/1/cost-sync`, {
    method: 'POST',
    headers: headers(origin, true),
    body: '{}',
  });
  const changedPayload = await changedRefresh.json();
  assert.equal(changedRefresh.status, 200);
  assert.equal(changedPayload.pricing.multiplier, 0.01);
  assert.equal(changedPayload.pricing.sync.status, 'synced');
  assert.equal(client.state.probes, 3);
});

test('configures and refreshes a New API wallet without credential input', async (t) => {
  const { origin } = await setup(t);

  const configure = await fetch(`${origin}/api/channels/1/wallet`, {
    method: 'PUT',
    headers: headers(origin, true),
    body: JSON.stringify({ adapter: 'newapi' }),
  });
  const raw = await configure.text();
  assert.equal(configure.status, 200);
  assert.equal(raw.includes('credential'), false);

  const overview = await fetch(`${origin}/api/overview?hours=24`);
  const payload = await overview.json();
  assert.equal(payload.channels[0].wallet.balance, 12.34);
  assert.equal(payload.channels[0].wallet.currency, 'USD');
  assert.equal(JSON.stringify(payload).includes('credential'), false);

  const missingOrigin = await fetch(`${origin}/api/channels/1/wallet-refresh`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}',
  });
  assert.equal(missingOrigin.status, 403);
});

test('reports an invalid Sub2 refresh token without leaking it', async (t) => {
  const walletService = {
    async start() {},
    async stop() {},
    async refreshAll() {
      return {
        schemaVersion: 1,
        channels: {
          1: {
            adapter: 'sub2',
            configured: true,
            status: 'needs_reauth',
            errorClass: 'needs_reauth',
          },
        },
      };
    },
  };
  const { origin, wallets } = await setup(t, { walletService });
  const secret = 'invalid-sub2-refresh-token';

  const configure = await fetch(`${origin}/api/channels/1/wallet`, {
    method: 'PUT',
    headers: headers(origin, true),
    body: JSON.stringify({ adapter: 'sub2', origin: 'https://sub2.test', credential: secret }),
  });
  const raw = await configure.text();

  assert.equal(configure.status, 422);
  assert.match(raw, /refresh token/);
  assert.equal(raw.includes(secret), false);
  assert.equal(wallets.publicState(1).configured, true);
  assert.equal(JSON.stringify(wallets.snapshot()).includes(secret), false);
});

test('does not silently discard a wallet credential when no credential adapter is selected', async (t) => {
  const { origin, wallets } = await setup(t);
  const secret = 'credential-that-must-not-be-discarded';

  const configure = await fetch(`${origin}/api/channels/1/wallet`, {
    method: 'PUT',
    headers: headers(origin, true),
    body: JSON.stringify({ adapter: 'none', credential: secret }),
  });
  const raw = await configure.text();

  assert.equal(configure.status, 400);
  assert.match(raw, /Sub2|Right Code/);
  assert.equal(raw.includes(secret), false);
  assert.equal(wallets.publicState(1).configured, false);
});

test('paginates /api/requests with 250 records across 3 pages and clamps an out-of-range page', async (t) => {
  const { client, origin } = await setup(t);
  const records = Array.from({ length: 250 }, (_, index) => ({
    id: index + 1, channel: 1, created_at: client.state.nowTimestamp - index, model_name: 'claude-sonnet-5',
    username: 'page-test', prompt_tokens: index + 1, completion_tokens: 2,
  }));
  client.logs = async ({ type }) => ({ items: type === 5 ? [] : records });

  const first = await fetch(`${origin}/api/requests?hours=24`);
  const firstPayload = await first.json();
  assert.equal(first.status, 200);
  assert.equal(firstPayload.total, 250);
  assert.equal(firstPayload.pageCount, 3);
  assert.equal(firstPayload.page, 1);
  assert.equal(firstPayload.items.length, 100);
  assert.deepEqual(firstPayload.items.map((log) => log.id), records.slice(0, 100).map((log) => log.id));

  const third = await fetch(`${origin}/api/requests?hours=24&page=3`);
  const thirdPayload = await third.json();
  assert.equal(thirdPayload.page, 3);
  assert.equal(thirdPayload.items.length, 50);
  assert.deepEqual(thirdPayload.items.map((log) => log.id), records.slice(200, 250).map((log) => log.id));

  const outOfRange = await fetch(`${origin}/api/requests?hours=24&page=99`);
  const outOfRangePayload = await outOfRange.json();
  assert.equal(outOfRangePayload.page, 3);
  assert.deepEqual(outOfRangePayload.items.map((log) => log.id), thirdPayload.items.map((log) => log.id));
});

test('filters /api/requests by channel, model, status, and stream', async (t) => {
  const { client, origin } = await setup(t);
  client.state.channels.push({ ...client.state.channels[0], id: 2, name: 'Claude B', models: 'claude-opus-5' });
  const records = [
    { id: 1, channel: 1, created_at: client.state.nowTimestamp, model_name: 'claude-sonnet-5', is_stream: true, other: JSON.stringify({ admin_info: { use_channel: [2, 1] } }) },
    { id: 2, channel: 2, created_at: client.state.nowTimestamp - 1, model_name: 'claude-opus-5', is_stream: false },
  ];
  client.logs = async ({ type }) => {
    if (type === 5) {
      return { items: [{
        id: 9, channel: 1, created_at: client.state.nowTimestamp - 2, model_name: 'claude-sonnet-5',
        request_id: 'request-error-9', content: 'status_code=502, bad gateway',
      }] };
    }
    return { items: records };
  };

  const byChannel = await fetch(`${origin}/api/requests?hours=24&channel=2`);
  const byChannelPayload = await byChannel.json();
  assert.equal(byChannelPayload.total, 1);
  assert.equal(byChannelPayload.items[0].channelId, 2);

  const byModel = await fetch(`${origin}/api/requests?hours=24&model=claude-opus-5`);
  const byModelPayload = await byModel.json();
  assert.equal(byModelPayload.total, 1);
  assert.equal(byModelPayload.items[0].model, 'claude-opus-5');

  const byStatus = await fetch(`${origin}/api/requests?hours=24&status=error`);
  const byStatusPayload = await byStatus.json();
  assert.equal(byStatusPayload.total, 1);
  assert.equal(byStatusPayload.items[0].kind, 'error');

  const byStreamOnly = await fetch(`${origin}/api/requests?hours=24&stream=stream`);
  assert.equal((await byStreamOnly.json()).total, 1);

  const byNonstream = await fetch(`${origin}/api/requests?hours=24&stream=nonstream`);
  assert.equal((await byNonstream.json()).total, 1);

  const byFailover = await fetch(`${origin}/api/requests?hours=24&stream=failover`);
  const byFailoverPayload = await byFailover.json();
  assert.equal(byFailoverPayload.total, 1);
  assert.equal(byFailoverPayload.items[0].id, 1);
});

test('merges a newer recent-requests log into /api/requests without duplicating it', async (t) => {
  const { client, origin } = await setup(t);
  await fetch(`${origin}/api/overview?hours=24`);

  client.logs = async ({ type }) => {
    if (type === 5) return { items: [] };
    return { items: [{
      id: 42,
      created_at: client.state.nowTimestamp + 50,
      channel: 1,
      channel_name: 'Claude A',
      username: 'admin',
      token_name: 'local-claude',
      model_name: 'claude-sonnet-5',
      prompt_tokens: 10,
      completion_tokens: 5,
      quota: 100,
      use_time: 1,
      is_stream: false,
    }] };
  };

  const forced = await fetch(`${origin}/api/recent-requests?hours=24&force=1`);
  assert.equal(forced.status, 200);

  const after = await fetch(`${origin}/api/requests?hours=24`);
  const afterPayload = await after.json();
  assert.equal(afterPayload.items[0].id, 42);
  assert.equal(afterPayload.items.filter((log) => log.id === 42).length, 1);

  const fresh = await fetch(`${origin}/api/requests?hours=24&fresh=1`);
  const freshPayload = await fresh.json();
  assert.equal(freshPayload.items[0].id, 42);
  assert.equal(freshPayload.recentCacheStatus, 'fresh');
});
