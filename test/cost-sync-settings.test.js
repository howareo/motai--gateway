import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { CostStore } from '../src/cost-store.js';
import { LogCacheStore } from '../src/log-cache-store.js';
import { createApp } from '../src/server.js';

const settle = async () => { for (let i = 0; i < 3; i++) await new Promise(setImmediate); };

async function fixture(t, options = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), 'cost-sync-settings-'));
  const costStore = new CostStore(path.join(directory, 'costs.json'));
  let channelReads = 0;
  let configured = false;
  const noop = { load: async () => {} };
  const app = createApp({ gatewayControl: null, costStore,
    client: { configured: () => configured, channels: async () => { channelReads++; return { items: [] }; },
      status: async () => ({}), logs: async () => ({ items: [] }), probeSub2Billing: async () => ({}) },
    modelPricingStore: { ...noop, snapshot: () => ({}), refresh: async () => ({}), resolve: () => null },
    newApiPricingSyncStore: { ...noop, snapshot: () => null, synchronize: async () => ({}) }, walletStore: { ...noop, reconcileChannels: async () => {} },
    walletService: { start: async () => {}, stop: async () => {} },
    channelHealthStore: { ...noop, probeIntervalMinutes: 15 },
    logCacheStore: new LogCacheStore({ filePath: path.join(directory, 'logs.json') }), ...options });
  t.after(async () => { await app.close(); await rm(directory, { recursive: true, force: true }); });
  const start = async () => {
    configured = false;
    await app.start({ host: '127.0.0.1', port: 0 });
    await settle();
    configured = true;
  };
  const request = async (method = 'GET', value, headers) => {
    const origin = `http://127.0.0.1:${app.server.address().port}`;
    return fetch(`${origin}/api/settings/cost-sync`, method === 'GET' ? {} : {
      method, headers: headers ?? { origin, 'content-type': 'application/json' },
      body: JSON.stringify({ costSyncIntervalMinutes: value }),
    });
  };
  return { app, costStore, start, request, reads: () => channelReads };
}

test('cost sync settings API validates writes, persists and reschedules immediately across cold starts', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const f = await fixture(t);
  await f.start();
  let baseline = f.reads();
  assert.equal((await (await f.request()).json()).costSyncIntervalMinutes, 30);
  for (const value of [0, 1441, 1.5, null, 'invalid', true, [1], '1']) assert.equal((await f.request('PUT', value)).status, 400);
  assert.equal((await f.request('PUT', 1, { 'content-type': 'application/json' })).status, 403);
  assert.equal((await f.request('PUT', 1)).status, 200);
  t.mock.timers.tick(59_999); await settle();
  assert.equal(f.reads(), baseline);
  t.mock.timers.tick(1); await settle();
  assert.equal(f.reads(), baseline + 1, 'the new one-minute interval replaces the original thirty-minute timer');
  assert.equal((await f.request('PUT', 2)).status, 200);
  t.mock.timers.tick(60_000); await settle();
  assert.equal(f.reads(), baseline + 1, 'the old timer was cleared');
  t.mock.timers.tick(60_000); await settle();
  assert.equal(f.reads(), baseline + 2);
  await f.app.close();
  await f.start();
  baseline = f.reads();
  assert.equal((await (await f.request()).json()).costSyncIntervalMinutes, 2);
  t.mock.timers.tick(120_000); await settle();
  assert.equal(f.reads(), baseline + 1, 'restart loads the persisted two-minute interval');
  const origin = `http://127.0.0.1:${f.app.server.address().port}`;
  const overview = await fetch(`${origin}/api/overview?hours=24`);
  assert.equal(overview.status, 200);
  assert.equal((await overview.json()).costSyncSettings.costSyncIntervalMinutes, 2);
});

test('cost store interval changes preserve queued cost history and scale stale status, including failed persistence', async (t) => {
  const f = await fixture(t);
  const store = f.costStore;
  await store.load();
  const channel = { id: '1', type: 14, base_url: 'https://synthetic.invalid' };
  await store.setChannelMode(channel, 'auto', store.version);
  const probe = store.recordProbe(channel, { status: 'ok', effective_rate_multiplier: 0.2 });
  const setting = store.setCostSyncIntervalMinutes(1440);
  await Promise.all([probe, setting]);
  assert.equal(store.channelPricing('1').multiplier, 0.2);
  const lastSuccess = Date.parse(store.syncState('1').lastSuccessAt);
  assert.equal(store.syncState('1', lastSuccess + 66 * 60_000).status, 'synced');
  assert.equal(store.syncState('1', lastSuccess + (2 * 1440 + 5) * 60_000 + 1).status, 'stale');
  const disk = JSON.parse(await readFile(store.filePath, 'utf8'));
  assert.equal(disk.settings.costSyncIntervalMinutes, 1440);
  assert.equal(disk.version, store.version);
  assert.deepEqual(disk.rules, store.list());
  const reloaded = new CostStore(store.filePath); await reloaded.load();
  assert.equal(reloaded.settings().costSyncIntervalMinutes, 1440);
  assert.deepEqual(reloaded.snapshot(), store.snapshot());
  await store.setCostSyncIntervalMinutes(30);
  assert.equal(store.syncState('1', lastSuccess + 65 * 60_000).status, 'synced');
  assert.equal(store.syncState('1', lastSuccess + 65 * 60_000 + 1).status, 'stale');
  const beforeFailure = store.snapshot();
  const originalPath = store.filePath;
  const blocker = path.join(path.dirname(originalPath), 'not-a-directory');
  await writeFile(blocker, 'block'); store.filePath = path.join(blocker, 'costs.json');
  await assert.rejects(store.setCostSyncIntervalMinutes(1));
  assert.equal(store.settings().costSyncIntervalMinutes, 30);
  assert.deepEqual(store.snapshot(), beforeFailure);
  store.filePath = originalPath;
  await store.setCostSyncIntervalMinutes(10);
  assert.equal(store.settings().costSyncIntervalMinutes, 10, 'a failed save does not poison the write queue');
  delete disk.settings;
  await writeFile(originalPath, JSON.stringify(disk));
  await reloaded.load();
  assert.equal(reloaded.settings().costSyncIntervalMinutes, 30, 'older stores retain the previous default');
});

test('cost sync settings form loads overview values, validates input, saves and reports server errors', async () => {
  const source = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  const html = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');
  assert.match(html, /id="cost-sync-settings-form"/);
  assert.match(source, /\$\('#cost-sync-settings-form'\)\.addEventListener\('submit', saveCostSyncSettings\)/);
  const settings = { costSyncIntervalMinutes: 30, minCostSyncIntervalMinutes: 1, maxCostSyncIntervalMinutes: 1440 };
  const state = { overview: { costSyncSettings: settings } };
  const input = {}, status = {}, button = {};
  const nodes = { '#cost-sync-interval': input, '#cost-sync-settings-status': status, '#save-cost-sync-settings': button };
  let calls = 0, failure;
  const context = vm.createContext({ state, document: {}, $: (id) => nodes[id], showToast: () => {},
    api: async (url, options) => { calls++; assert.equal(url, '/api/settings/cost-sync');
      assert.equal(options.method, 'PUT'); if (failure) throw failure;
      return { ...settings, ...JSON.parse(options.body) }; } });
  vm.runInContext(source.slice(source.indexOf('function syncCostSyncSettingsForm('), source.indexOf('// Keys are the error_class')), context);
  context.syncCostSyncSettingsForm(); assert.equal(input.value, '30');
  context.document.activeElement = input; input.value = '90'; context.syncCostSyncSettingsForm();
  assert.equal(input.value, '90', 'background renders preserve an active edit');
  const event = { preventDefault() {} };
  input.value = '1.5'; await context.saveCostSyncSettings(event); assert.equal(calls, 0);
  input.value = '90'; await context.saveCostSyncSettings(event);
  assert.equal(state.overview.costSyncSettings.costSyncIntervalMinutes, 90);
  assert.equal(input.value, '90'); assert.equal(button.disabled, false);
  failure = new Error('disk unavailable'); input.value = '60'; await context.saveCostSyncSettings(event);
  assert.equal(status.textContent, 'disk unavailable'); assert.equal(button.disabled, false);
  assert.equal(state.costSyncSettings.costSyncIntervalMinutes, 90);
});
