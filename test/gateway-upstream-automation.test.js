import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/server.js';

const SETTING = 'MOTAI_GATEWAY_UPSTREAM_AUTOMATION';
const settle = async () => { for (let i = 0; i < 3; i++) await new Promise(setImmediate); };

function createWithSetting(value, options) {
  const previous = process.env[SETTING];
  if (value === undefined) delete process.env[SETTING]; else process.env[SETTING] = value;
  try { return createApp(options); }
  finally { if (previous === undefined) delete process.env[SETTING]; else process.env[SETTING] = previous; }
}

function fixture(value) {
  const calls = { probes: 0, billing: 0, prices: 0, walletStarts: 0, wallets: 0, projections: 0 };
  const config = { gen: '1', models: [{ id: 'Synthetic/Model', vendor: 'openai' }],
    pools: [{ id: 'synthetic-pool', name: 'Synthetic' }], aliases: [], callers: [],
    channels: [{ id: 'synthetic-channel', name: 'Synthetic', enabled: true, adapter: 'openai',
      baseUrl: 'http://synthetic.invalid', poolId: 'synthetic-pool', priority: 1, weight: 1,
      testModel: 'Synthetic/Model', models: [{ modelId: 'Synthetic/Model', capabilities: ['responses'] }] }] };
  const noop = { load: async () => {}, flush: async () => {} };
  let walletTimer;
  let costSyncIntervalMinutes = 30;
  const control = { load: async () => {}, config: () => config, status: async () => ({ ready: true }),
    client: {
      probe: async () => { calls.probes++; return { state: 'accepted' }; },
      billingProbe: async (id) => { calls.billing++; return { format_version: 1, channel_id: id,
        state: 'known', multiplier: 0.5, source: 'management_api', observed_at: '2026-10-28T00:00:00Z' }; },
    } };
  const projection = { ...noop, state: () => ({ requiresRebuild: false, writeBlocked: false }),
    catchUp: async () => { calls.projections++; } };
  const app = createWithSetting(value, { gatewayControl: control, gatewayProjection: projection,
    costStore: { ...noop, reconcileChannels: async () => {}, syncState: () => ({ mode: 'auto', status: 'known' }),
      recordProbe: async () => {}, snapshot: () => ({ version: 1, rules: [] }),
      settings: () => ({ costSyncIntervalMinutes, minCostSyncIntervalMinutes: 1, maxCostSyncIntervalMinutes: 1440 }),
      setCostSyncIntervalMinutes: async (minutes) => ({ costSyncIntervalMinutes: costSyncIntervalMinutes = minutes,
        minCostSyncIntervalMinutes: 1, maxCostSyncIntervalMinutes: 1440 }) },
    modelPricingStore: { ...noop, refresh: async () => { calls.prices++; return { snapshotHash: 'synthetic' }; } },
    newApiPricingSyncStore: noop, walletStore: noop, logCacheStore: noop,
    walletService: { start: async () => { calls.walletStarts++; walletTimer = setInterval(() => { calls.wallets++; }, 1000); },
      stop: async () => { if (walletTimer) clearInterval(walletTimer); },
      manualRefreshAll: async () => { calls.wallets++; return { channels: {} }; } },
    channelHealthStore: { ...noop, probeIntervalMinutes: 1,
      setProbeIntervalMinutes: async (minutes) => ({ probeIntervalMinutes: minutes }) },
    costSyncIntervalMs: 1000, modelPricingSyncIntervalMs: 1000 });
  return { app, calls };
}

async function request(app, pathname, method = 'GET', body = {}) {
  const origin = `http://127.0.0.1:${app.server.address().port}`;
  const response = await fetch(origin + pathname, method === 'GET' ? {} : { method,
    headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { status: response.status, body: await response.json() };
}

test('gateway disabled automation makes no background upstream calls, preserves projection and explicit manual operations', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const logs = []; t.mock.method(console, 'info', (message) => logs.push(message));
  const { app, calls } = fixture('disabled');
  try {
    await app.start({ host: '127.0.0.1', port: 0 });
    t.mock.timers.tick(61_000); await settle();
    assert.deepEqual({ ...calls, projections: 0 }, { probes: 0, billing: 0, prices: 0, walletStarts: 0, wallets: 0, projections: 0 });
    assert(calls.projections > 1, 'local ledger projection still catches up');
    assert(logs.some((line) => line.includes('upstream automation: disabled')));
    assert.equal((await request(app, '/api/gateway/status')).body.upstreamAutomation.enabled, false);
    assert.equal((await request(app, '/api/settings/probes', 'PUT', { probeIntervalMinutes: 1 })).status, 200);
    assert.equal((await request(app, '/api/settings/cost-sync', 'PUT', { costSyncIntervalMinutes: 1 })).status, 200);
    t.mock.timers.tick(61_000); await settle();
    assert.equal(calls.probes, 0, 'editing a probe interval must not rearm disabled automation');
    assert.equal(calls.billing + calls.prices + calls.wallets, 0);
    assert.equal((await request(app, '/api/settings/cost-sync')).body.costSyncIntervalMinutes, 1);
    assert.equal((await request(app, '/api/cost-sync', 'POST')).status, 200);
    assert.equal((await request(app, '/api/model-pricing-sync', 'POST')).status, 200);
    assert.equal((await request(app, '/api/wallet-refresh', 'POST')).status, 200);
    assert.equal((await request(app, '/api/channels/synthetic-channel/test', 'POST')).status, 202);
    assert.equal(calls.billing, 1); assert.equal(calls.prices, 1); assert.equal(calls.wallets, 1); assert.equal(calls.probes, 1);
    assert.equal(calls.walletStarts, 0);
    t.mock.timers.tick(61_000); await settle();
    assert.equal(calls.billing + calls.prices + calls.wallets + calls.probes, 4, 'manual requests do not enable recurring jobs');
  } finally { await app.close(); }
});

test('gateway automation remains enabled by default and runs each existing upstream scheduler', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const logs = []; t.mock.method(console, 'info', (message) => logs.push(message));
  const { app, calls } = fixture(undefined);
  try {
    await app.start({ host: '127.0.0.1', port: 0 });
    assert.equal(calls.walletStarts, 1);
    t.mock.timers.tick(61_000); await settle();
    for (const key of ['probes', 'billing', 'prices', 'wallets', 'projections']) assert(calls[key] > 0, `${key} default scheduler runs`);
    assert(logs.some((line) => line.includes('upstream automation: enabled')));
    assert.equal((await request(app, '/api/gateway/status')).body.upstreamAutomation.enabled, true);
  } finally { await app.close(); }
});

test('gateway automation rejects unknown settings while legacy mode keeps its existing default', () => {
  for (const value of ['', '0', 'false', 'TRUE', 'off', ' enabled ']) {
    assert.throws(() => createWithSetting(value, { gatewayControl: {} }), /must be enabled or disabled/);
  }
  assert.doesNotThrow(() => createWithSetting('enabled', { gatewayControl: { client: {} }, gatewayProjection: {} }));
  assert.doesNotThrow(() => createWithSetting('disabled', { client: { configured: () => false } }));
  assert.doesNotThrow(() => createWithSetting('0', { client: { configured: () => false } }));
});
