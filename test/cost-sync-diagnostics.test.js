import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { createApp } from '../src/server.js';
import { CostStore } from '../src/cost-store.js';

const SETTING = 'MOTAI_GATEWAY_UPSTREAM_AUTOMATION';
const noop = { load: async () => {}, flush: async () => {} };
const SECRET = 'sk-SECRET-must-not-appear';

async function costStore(t) {
  const directory = await mkdtemp(path.join(tmpdir(), 'motai-cost-diag-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new CostStore(path.join(directory, 'cost.json'));
  await store.load();
  return store;
}

const channelRow = (id, name) => ({ id, name, type: 1, base_url: `https://${name}.invalid` });

// Gateway-mode app: one live channel in the gateway config, a real CostStore, and a billing
// probe whose answer the test controls. Automation is disabled so only explicit syncs run.
async function gatewayApp(t, store, billingProbe) {
  const config = { gen: '1', models: [{ id: 'Synthetic/Model', vendor: 'openai' }],
    pools: [{ id: 'synthetic-pool', name: 'Synthetic' }], aliases: [], callers: [],
    channels: [{ id: '1001', name: 'live', enabled: true, adapter: 'openai', baseUrl: 'https://live.invalid',
      poolId: 'synthetic-pool', priority: 1, weight: 1, testModel: 'Synthetic/Model',
      models: [{ modelId: 'Synthetic/Model', capabilities: ['responses'] }] }] };
  const control = { load: async () => {}, config: () => config, status: async () => ({ ready: true }),
    client: { probe: async () => ({ state: 'accepted' }), billingProbe } };
  const projection = { ...noop, state: () => ({ requiresRebuild: false, writeBlocked: false }), catchUp: async () => {} };
  const previous = process.env[SETTING];
  process.env[SETTING] = 'disabled';
  let app;
  try {
    app = createApp({ gatewayControl: control, gatewayProjection: projection, costStore: store,
      modelPricingStore: { ...noop, refresh: async () => ({ snapshotHash: 'x' }) }, newApiPricingSyncStore: noop,
      walletStore: noop, logCacheStore: noop, walletService: { start: async () => {}, stop: async () => {} },
      channelHealthStore: { ...noop, probeIntervalMinutes: 1 } });
  } finally { if (previous === undefined) delete process.env[SETTING]; else process.env[SETTING] = previous; }
  t.after(() => app.close());
  await app.start({ host: '127.0.0.1', port: 0 });
  return app;
}

async function sync(app) {
  const origin = `http://127.0.0.1:${app.server.address().port}`;
  const response = await fetch(`${origin}/api/cost-sync`, { method: 'POST',
    headers: { origin, 'content-type': 'application/json' }, body: '{}' });
  return { status: response.status, body: await response.json() };
}

const known = (extra = {}) => ({ format_version: 1, channel_id: '1001', state: 'known', multiplier: 0.5,
  source: 'management_api', observed_at: '2026-10-30T00:00:00Z', ...extra });
const failedProbe = (error_class) => ({ format_version: 1, channel_id: '1001', state: 'unknown', multiplier: null,
  source: 'unavailable', observed_at: '2026-10-30T00:00:00Z', ...(error_class ? { error_class } : {}) });

async function seed(store, app) {
  const [live] = await app.client.channels();
  await store.setChannelConfiguration(live, { multiplier: 0.4, mode: 'auto' }, store.version);
  await store.setChannelConfiguration(channelRow('2002', 'gone'), { multiplier: 0.7, mode: 'auto' }, store.version);
}

test('a failed sync writes one warning line with local values only, a successful one writes none', async (t) => {
  const store = await costStore(t);
  const warnings = []; t.mock.method(console, 'warn', (...args) => warnings.push(args.join(' ')));
  let answer = known({ upstream_group: 'grp' });
  const app = await gatewayApp(t, store, async () => { if (answer instanceof Error) throw answer; return answer; });
  await seed(store, app);

  await sync(app);
  assert.deepEqual(warnings, [], 'success does not log');

  answer = failedProbe('group_unresolved');
  await sync(app);
  assert.equal(warnings.length, 1);
  const line = warnings[0];
  assert.match(line, /^\[cost-sync\] failed /);
  const fields = JSON.parse(line.slice(line.indexOf('{')));
  assert.deepEqual(fields, { channel: '1001', name: 'live', error_class: 'group_unresolved',
    last_group: 'grp', last_source: 'management_api' });

  // The core being unreachable: the thrown error's message may carry anything, only its code is used.
  answer = Object.assign(new Error(`Bearer ${SECRET} upstream said: boom`), { code: 'GATEWAY_UNAVAILABLE' });
  await sync(app);
  assert.equal(warnings.length, 2);
  assert.equal(JSON.parse(warnings[1].slice(warnings[1].indexOf('{'))).error_class, 'gateway_unavailable');
  assert.doesNotMatch(warnings.join('\n'), new RegExp(`${SECRET}|boom|Bearer`));
});

test('a rate-limited retry after a good sync is not a failure and is not logged', async (t) => {
  const store = await costStore(t);
  const warnings = []; t.mock.method(console, 'warn', (...args) => warnings.push(args.join(' ')));
  let answer = known();
  const app = await gatewayApp(t, store, async () => { if (answer instanceof Error) throw answer; return answer; });
  await seed(store, app);
  await sync(app);
  answer = Object.assign(new Error('slow down'), { status: 429 });
  await sync(app);
  assert.equal(store.syncState('1001').status, 'synced');
  assert.deepEqual(warnings, []);
});

test('gateway mode drops the sync state of channels outside the gateway config and keeps their cost rules', async (t) => {
  const store = await costStore(t);
  t.mock.method(console, 'warn', () => {});
  const app = await gatewayApp(t, store, async () => known());
  await seed(store, app);
  assert.equal(store.syncState('2002').mode, 'auto');
  const rulesBefore = store.list().filter((rule) => rule.channelId === '2002');
  assert.equal(rulesBefore.length, 1);

  assert.equal((await sync(app)).status, 200);

  assert.equal(Object.hasOwn(store.snapshot().channelSync, '2002'), false, 'stale sync state removed');
  assert.equal(store.syncState('2002').mode, 'manual', 'reads back as the empty default');
  assert.deepEqual(store.list().filter((rule) => rule.channelId === '2002'), rulesBefore, 'cost rules untouched');
  assert.equal(store.channelPricing('2002').multiplier, 0.7, 'old requests are still priced');
  assert.equal(store.syncState('1001').mode, 'auto');
  assert.equal(store.syncState('1001').status, 'synced');
  // It is persisted, not only in memory.
  const onDisk = JSON.parse(await readFile(store.filePath, 'utf8'));
  assert.equal(Object.hasOwn(onDisk.channelSync, '2002'), false);
  assert.equal(onDisk.rules.some((rule) => rule.channelId === '2002' && rule.multiplier === 0.7), true);
});

test('pruneChannelSync changes nothing, and does not bump the version, when every entry is still present', async (t) => {
  const store = await costStore(t);
  const live = channelRow('1001', 'live');
  await store.setChannelConfiguration(live, { multiplier: 0.4, mode: 'auto' }, store.version);
  const before = { version: store.version, sync: JSON.stringify(store.snapshot().channelSync) };
  await store.pruneChannelSync([live]);
  assert.equal(store.version, before.version);
  assert.equal(JSON.stringify(store.snapshot().channelSync), before.sync);
  await store.pruneChannelSync([]);
  assert.deepEqual(store.snapshot().channelSync, {});
  assert.equal(store.channelPricing('1001').multiplier, 0.4);
});

test('legacy (non-gateway) mode never prunes: its channel list is not the gateway config', async (t) => {
  const store = await costStore(t);
  let pruned = 0;
  const original = store.pruneChannelSync.bind(store);
  store.pruneChannelSync = async (...args) => { pruned += 1; return original(...args); };
  const live = channelRow(1, 'live');
  const client = { configured: () => true, channels: async () => ({ items: [live] }),
    probeSub2Billing: async () => ({ status: 'ok', effective_rate_multiplier: 0.5, observed_at: new Date().toISOString() }) };
  await store.setChannelConfiguration(channelRow('2002', 'elsewhere'), { multiplier: 0.7, mode: 'auto' }, store.version);
  const app = createApp({ client, costStore: store, modelPricingStore: { ...noop, refresh: async () => ({ snapshotHash: 'x' }) },
    newApiPricingSyncStore: { ...noop, synchronize: async () => ({}) }, walletStore: noop, logCacheStore: { ...noop, overviewEntries: () => [] },
    walletService: { start: async () => {}, stop: async () => {}, refreshAll: async () => ({ channels: {} }) },
    channelHealthStore: { ...noop, probeIntervalMinutes: 1 }, costSyncIntervalMs: 3_600_000, modelPricingSyncIntervalMs: 3_600_000 });
  t.after(() => app.close());
  await app.start({ host: '127.0.0.1', port: 0 });
  assert.equal((await sync(app)).status, 200);
  assert.equal(pruned, 0);
  assert.equal(store.syncState('2002').mode, 'auto');
});

// ---- the browser side: error_class names and the group note, run against the production source ----

const appSource = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
const schema = JSON.parse(await readFile(new URL('../contracts/v1/internal-api.schema.json', import.meta.url), 'utf8'));
const fn = (name) => {
  const start = appSource.search(new RegExp(`(?:async )?function ${name}\\(`));
  const tail = appSource.slice(start); const next = tail.slice(1).search(/\n(?:async )?function /);
  return next === -1 ? tail : tail.slice(0, next + 1);
};
const namesSource = appSource.slice(appSource.indexOf('const costSyncErrorNames'), appSource.indexOf('function costSyncErrorDetail'));

class Node {
  constructor(tag) { this.tag = tag; this.children = []; this.dataset = {}; this.attributes = {}; this.textContent = ''; this.className = ''; this.title = '';
    this.classList = { add: () => {} }; }
  append(...nodes) { this.children.push(...nodes); }
  setAttribute(name, value) { this.attributes[name] = value; }
  addEventListener() {}
}

function ui() {
  const context = vm.createContext({ document: { createElement: (tag) => new Node(tag) }, window: { addEventListener() {} }, multiplier: { format: (v) => String(v) },
    formatTime: (value) => (value ? `T(${value})` : ''), showOverflowTooltip() {}, hideFloatingTooltip() {}, refreshCostMultiplier() {} });
  vm.runInContext(`${namesSource}\n${fn('costSyncErrorName')}\n${fn('costSyncErrorDetail')}\n${fn('enableOverflowTooltip')}\n${fn('costSummary')}
    globalThis.api = { costSyncErrorNames, costSyncErrorDetail, costSummary };`, context);
  return context.api;
}
const noteOf = (api, sync) => {
  const wrapper = api.costSummary({ id: '1', name: 'c', costMultiplier: 0.5, costSync: sync });
  return wrapper.children[0].children[1];
};

test('every error_class the core can report has a Chinese name; unknown values read as a plain sync failure', () => {
  const api = ui();
  const classes = schema.definitions.billing_probe_response.properties.error_class.enum;
  assert.equal(classes.length, 22);
  for (const errorClass of classes) {
    const name = api.costSyncErrorNames[errorClass];
    assert.ok(name && /[一-鿿]/.test(name), `${errorClass} has no Chinese name`);
    assert.equal(api.costSyncErrorDetail({ errorClass }), name);
  }
  assert.equal(api.costSyncErrorNames.unauthorized, '上游拒绝凭据');
  assert.equal(api.costSyncErrorNames.group_unresolved, '未能识别分组');
  assert.equal(api.costSyncErrorNames.timeout, '查询上游超时');
  assert.equal(api.costSyncErrorDetail({ errorClass: 'gateway_timeout' }), '等待核心查询结果超时');
  assert.equal(api.costSyncErrorDetail({ errorClass: 'gateway_unavailable' }), '网关核心不可用');
  assert.equal(api.costSyncErrorNames.http_5xx, '上游 5xx');
  for (const errorClass of ['', null, undefined, 'something_new', '__proto__', 'constructor']) {
    assert.equal(api.costSyncErrorDetail({ errorClass }), '同步失败');
  }
  assert.equal(api.costSyncErrorDetail(), '同步失败');
});

test('the cost row shows the real failure reason, the group on success, and the raw code on hover', () => {
  const api = ui();
  const failed = noteOf(api, { mode: 'auto', status: 'error', errorClass: 'unauthorized', lastAttemptAt: '2026-10-30T13:03:47Z' });
  assert.equal(failed.textContent, '上游拒绝凭据 · 保留当前值');
  assert.match(failed.title, /错误码：unauthorized/); assert.match(failed.title, /最近尝试：/);
  assert.equal(failed.dataset.fullText, failed.title);
  const unresolved = noteOf(api, { mode: 'auto', status: 'error', errorClass: 'group_unresolved' });
  assert.equal(unresolved.textContent, '未能识别分组 · 保留当前值');
  const unsupported = noteOf(api, { mode: 'auto', status: 'unsupported', errorClass: 'channel_type_unsupported' });
  assert.equal(unsupported.textContent, '该渠道类型不支持 · 保留当前值');
  assert.equal(noteOf(api, { mode: 'auto', status: 'unsupported' }).textContent, '上游不支持 · 保留当前值');
  assert.equal(noteOf(api, { mode: 'auto', status: 'error' }).textContent, '同步失败 · 保留当前值');
  // The failed note has no raw-code hover when there is no class to show.
  assert.doesNotMatch(noteOf(api, { mode: 'auto', status: 'error' }).title, /错误码/);

  const withGroup = noteOf(api, { mode: 'auto', status: 'synced', upstreamGroup: '国模', lastSuccessAt: '2026-10-30T13:03:47Z' });
  assert.equal(withGroup.textContent, '自动同步 · 分组：国模 · T(2026-10-30T13:03:47Z)');
  const noGroup = noteOf(api, { mode: 'auto', status: 'synced', lastSuccessAt: '2026-10-30T13:03:47Z' });
  assert.equal(noGroup.textContent, '自动同步 · T(2026-10-30T13:03:47Z)');
  assert.equal(noteOf(api, { mode: 'auto', status: 'synced', errorClass: 'probe_rate_limited', upstreamGroup: 'x' }).textContent, '刚刚已探测 · 当前值未变');
  assert.equal(noteOf(api, { mode: 'manual', status: 'manual' }).textContent, '手动倍率');
});
