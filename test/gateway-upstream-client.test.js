import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { GatewayUpstreamClient } from '../src/gateway/upstream-client.js';
import { GatewayClient } from '../src/gateway/client.js';
import { CostStore } from '../src/cost-store.js';
import { WalletStore, accountKey } from '../src/wallet-store.js';
import { WalletService } from '../src/wallet-service.js';

const observed = '2026-10-27T01:00:00Z';
const config = () => ({ models: [{ id: 'Opaque-A', vendor: 'google' }, { id: 'Opaque-B', vendor: 'zai' },
  { id: 'Opaque-C', vendor: 'moonshotai' }, { id: 'Opaque-D', vendor: 'arbitrary' }], pools: [{ id: 'explicit-any-pool', name: 'Custom' }],
  channels: ['Opaque-A', 'Opaque-B', 'Opaque-C', 'Opaque-D'].map((modelId, index) => ({ id: index ? `channel-${index}` : '0001',
    name: `Channel ${index}`, enabled: index !== 3, poolId: 'explicit-any-pool', baseUrl: 'https://upstream.invalid/v1',
    priority: 4, weight: 1, testModel: modelId, models: [{ modelId, upstreamModel: `wire-${index}`, capabilities: ['responses'] }],
    key: 'DO_NOT_COPY_MODEL_SECRET', credentialRef: 'DO_NOT_COPY_REF' })) });
const billing = (overrides = {}) => ({ format_version: 1, channel_id: '0001', state: 'known', multiplier: 0.12, source: 'management_api', observed_at: observed, ...overrides });
const wallet = (overrides = {}) => ({ format_version: 1, channel_id: '0001', state: 'known', balance: 0, currency: null, source: 'account_wallet', observed_at: observed, ...overrides });
const facade = (client, cfg = config()) => new GatewayUpstreamClient({ client, getConfig: () => cfg });

test('upstream daily bill passes the narrow contract without exposing other fields', async () => {
  const days = [{ date: '2026-11-16', actualCost: 43.27461468, standardCost: 393.405588, requests: 2091 }];
  const client = facade({ billingProbe: async () => billing({ daily_costs: days, private_extra: 'PRIVATE' }) });
  const result = await client.probeSub2Billing('0001');
  assert.deepEqual(result.dailyCosts, days);
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE/);
});

test('explicit transport adapter wins over model vendor when presenting a saved channel type', async () => {
  const cfg = config(); cfg.channels[0].adapter = 'openai'; cfg.channels[1].adapter = 'deepseek';
  const rows = await facade({}, cfg).channels();
  assert.equal(rows[0].type, 1);
  assert.equal(rows[1].type, 43);
});

test('facade lists exact string IDs, explicit arbitrary pool and every vendor, without exposing model credentials', async () => {
  const client = facade({}); const rows = await client.channels();
  assert.equal(client.configured(), true); assert.equal(rows.length, 4);
  assert.deepEqual(rows.map((row) => row.type), [24, 26, 25, 0]);
  assert.deepEqual(rows.map((row) => row.status), [1, 1, 1, 2]);
  assert.equal(rows[0].id, '0001'); assert.equal(rows[0].models, 'Opaque-A');
  assert.ok(rows.every((row) => row.poolId === 'explicit-any-pool' && row.group === row.poolId));
  assert.doesNotMatch(JSON.stringify(rows), /DO_NOT_COPY|credentialRef|"key"/);
  const empty = new GatewayUpstreamClient({ client: {}, getConfig: () => null });
  assert.equal(empty.configured(), false); assert.deepEqual(await empty.channels(), []);
});

test('mixed or unknown vendors remain type0 and do not infer provider from model spelling', async () => {
  const cfg = config(); cfg.channels[0].models.push(cfg.channels[1].models[0]);
  cfg.models[3].id = 'gpt-sounding-but-explicit-vendor'; cfg.channels[3].models[0].modelId = cfg.models[3].id;
  const rows = await facade({}, cfg).channels(); assert.equal(rows[0].type, 0); assert.equal(rows[3].type, 0);
});

test('gateway narrow probes send only management auth and version envelope, validate responses and never target upstream', async () => {
  const requests = [];
  const client = new GatewayClient({ baseUrl: 'http://internal.invalid:3002', managementToken: 'MANAGEMENT_ONLY', fetchImpl: async (url, options) => {
    requests.push({ url: String(url), ...options }); return Response.json(String(url).endsWith('billing-probe') ? billing() : wallet());
  } });
  const upstream = facade(client); const cost = await upstream.probeSub2Billing('0001'), balance = await upstream.probeWallet('0001');
  assert.equal(cost.effective_rate_multiplier, 0.12); assert.equal(balance.balance, 0); assert.equal(balance.currency, null);
  assert.deepEqual(requests.map((row) => row.url), ['http://internal.invalid:3002/internal/v1/channels/0001/billing-probe', 'http://internal.invalid:3002/internal/v1/channels/0001/wallet-probe']);
  assert.ok(requests.every((row) => row.method === 'POST' && row.redirect === 'manual' && row.body === '{"format_version":1}' && row.headers.authorization === 'Bearer MANAGEMENT_ONLY'));
  assert.doesNotMatch(JSON.stringify(requests), /DO_NOT_COPY|upstream.invalid/);
  client.fetch = async () => Response.json({ ...wallet(), balance: '0' });
  await assert.rejects(upstream.probeWallet('0001'), { code: 'gateway_invalid_response' });
});

test('unknown and unsupported probe results never become known zero or successful cost values', async () => {
  for (const state of ['unknown', 'unsupported']) {
    const client = facade({ billingProbe: async () => billing({ state, multiplier: null, source: state === 'unknown' ? 'unavailable' : 'unsupported' }),
      walletProbe: async () => wallet({ state, balance: null, source: state === 'unknown' ? 'unavailable' : 'unsupported' }) });
    const cost = await client.probeSub2Billing('0001'), balance = await client.probeWallet('0001');
    assert.equal(cost.status, state === 'unsupported' ? 'unsupported' : 'failed');
    assert.equal(balance.status, cost.status); assert.equal(Object.hasOwn(cost, 'effective_rate_multiplier'), false);
    assert.equal(Object.hasOwn(balance, 'balance'), false);
  }
  const inconsistent = facade({ billingProbe: async () => billing({ multiplier: null }), walletProbe: async () => wallet({ source: 'unsupported' }) });
  assert.equal((await inconsistent.probeSub2Billing('0001')).error_class, 'schema_invalid');
  assert.equal((await inconsistent.probeWallet('0001')).error_class, 'schema_invalid');
});

test('billing probe passes the core error_class and upstream_group through; older cores without them behave as before', async () => {
  const unknown = (extra) => billing({ state: 'unknown', multiplier: null, source: 'unavailable', ...extra });
  const unsupported = (extra) => billing({ state: 'unsupported', multiplier: null, source: 'unsupported', ...extra });
  let response = unknown({ error_class: 'group_unresolved' });
  const client = facade({ billingProbe: async () => response });
  let cost = await client.probeSub2Billing('0001');
  assert.equal(cost.status, 'failed'); assert.equal(cost.error_class, 'group_unresolved');
  response = unknown({ error_class: 'unauthorized' });
  assert.equal((await client.probeSub2Billing('0001')).error_class, 'unauthorized');
  response = unsupported({ error_class: 'channel_type_unsupported' });
  cost = await client.probeSub2Billing('0001');
  assert.equal(cost.status, 'unsupported'); assert.equal(cost.error_class, 'channel_type_unsupported');
  // Old core: no error_class, previous generic values.
  response = unknown(); assert.equal((await client.probeSub2Billing('0001')).error_class, 'probe_failed');
  response = unsupported(); assert.equal((await client.probeSub2Billing('0001')).error_class, 'endpoint_unsupported');
  // Known results carry the group when present and omit it when absent.
  response = billing({ upstream_group: '国模' });
  cost = await client.probeSub2Billing('0001');
  assert.equal(cost.status, 'ok'); assert.equal(cost.upstream_group, '国模'); assert.equal(cost.source, 'management_api');
  response = billing(); assert.equal(Object.hasOwn(await client.probeSub2Billing('0001'), 'upstream_group'), false);
  // Forward compatibility: a still newer core may add fields; known values are not lost.
  response = billing({ upstream_group: 'g', future_optional: true });
  assert.equal((await client.probeSub2Billing('0001')).upstream_group, 'g');
});

test('billing responses with an out-of-contract error_class or upstream_group are rejected, wallet never trusts error_class', async () => {
  const unknown = (extra) => billing({ state: 'unknown', multiplier: null, source: 'unavailable', ...extra });
  let response = unknown({ error_class: 'text copied from the upstream' });
  const client = facade({ billingProbe: async () => response, walletProbe: async () => wallet({ state: 'unknown', balance: null, source: 'unavailable', error_class: 'unauthorized' }) });
  await assert.rejects(client.probeSub2Billing('0001'), { code: 'invalid_contract' });
  for (const upstream_group of ['', 'a\nb', 'g'.repeat(129), 7]) {
    response = billing({ upstream_group });
    await assert.rejects(client.probeSub2Billing('0001'), { code: 'invalid_contract' });
  }
  assert.equal((await client.probeWallet('0001')).error_class, 'probe_failed');
});

test('CostStore records the upstream group a newer core reports, and a failure keeps the confirmed multiplier and its class', async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'motai-upstream-cost-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new CostStore(path.join(directory, 'cost.json')); await store.load();
  let response = billing({ upstream_group: 'gemini_group' });
  const client = facade({ billingProbe: async () => response }); const [channel] = await client.channels();
  await store.setChannelMode(channel, 'auto', store.version);
  await store.recordProbe(channel, await client.probeSub2Billing(channel.id));
  assert.equal(store.syncState('0001').upstreamGroup, 'gemini_group'); assert.equal(store.syncState('0001').status, 'synced');
  response = billing({ state: 'unknown', multiplier: null, source: 'unavailable', error_class: 'group_unresolved' });
  await store.recordProbe(channel, await client.probeSub2Billing(channel.id));
  assert.equal(store.channelPricing('0001').multiplier, 0.12);
  assert.equal(store.syncState('0001').status, 'error'); assert.equal(store.syncState('0001').errorClass, 'group_unresolved');
});

test('facade rejects invalid/missing IDs before probe and rejects cross-channel result', async () => {
  let calls = 0;
  const client = facade({ billingProbe: async () => { calls++; return billing({ channel_id: '1' }); }, walletProbe: async () => wallet({ channel_id: '1' }) });
  await assert.rejects(client.probeWallet('../oops'), { code: 'invalid_channel_id' });
  await assert.rejects(client.probeSub2Billing('1'), { code: 'channel_not_found' }); assert.equal(calls, 0);
  await assert.rejects(client.probeSub2Billing('0001'), { code: 'gateway_invalid_response' });
  await assert.rejects(client.probeWallet('0001'), { code: 'gateway_invalid_response' });
});

test('existing CostStore consumes facade result and retains confirmed multiplier after unknown or unsupported', async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'motai-upstream-cost-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new CostStore(path.join(directory, 'cost.json')); await store.load();
  let response = billing(); const client = facade({ billingProbe: async () => response }); const [channel] = await client.channels();
  await store.setChannelMode(channel, 'auto', store.version);
  await store.recordProbe(channel, await client.probeSub2Billing(channel.id));
  assert.equal(store.channelPricing('0001').multiplier, 0.12); assert.equal(store.syncState('0001').status, 'synced');
  response = billing({ state: 'unknown', multiplier: null, source: 'unavailable' });
  await store.recordProbe(channel, await client.probeSub2Billing(channel.id));
  assert.equal(store.channelPricing('0001').multiplier, 0.12); assert.equal(store.syncState('0001').status, 'error');
  response = billing({ state: 'unsupported', multiplier: null, source: 'unsupported' });
  await store.recordProbe(channel, await client.probeSub2Billing(channel.id));
  assert.equal(store.channelPricing('0001').multiplier, 0.12); assert.equal(store.syncState('0001').status, 'unsupported');
});

async function walletFixture(t, client, request) {
  const directory = await mkdtemp(path.join(tmpdir(), 'motai-upstream-wallet-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new WalletStore({ statePath: path.join(directory, 'wallet.json'), credentialsPath: path.join(directory, 'credentials.json') });
  await store.load(); return { store, service: new WalletService({ client, store, request }) };
}

test('existing WalletService consumes Go narrow wallet probe without model keys or account HTTP requests', async (t) => {
  const cfg = config(); cfg.channels = [cfg.channels[0]]; let probes = 0, accountRequests = 0;
  const client = facade({ walletProbe: async () => { probes++; return wallet(); } }, cfg);
  const { store, service } = await walletFixture(t, client, async () => { accountRequests++; throw new Error('unexpected account request'); });
  await service.refreshAll(); assert.equal(probes, 1); assert.equal(accountRequests, 0);
  assert.equal(store.publicState('0001').balance, 0); assert.equal(store.publicState('0001').status, 'ok');
  assert.equal(store.publicState('0001').currency, null);
});

test('HTTP channel with an unknown Go wallet returns unsupported and retains its last confirmed balance', async (t) => {
  const cfg = config(); cfg.channels = [{ ...cfg.channels[0], baseUrl: 'http://synthetic.invalid:9001/v1' }];
  let probes = 0, accountRequests = 0;
  const client = facade({ walletProbe: async () => { probes++; return wallet({ state: 'unknown', balance: null, source: 'unavailable' }); } }, cfg);
  const { store, service } = await walletFixture(t, client, async () => { accountRequests++; throw new Error('HTTP account request must not run'); });
  await store.reconcileChannels(await client.channels());
  const unknown = await service.manualRefresh('0001');
  assert.equal(unknown.channels['0001'].status, 'unsupported');
  assert.equal(unknown.channels['0001'].balance, null);
  await store.updateChannel('0001', { detectedAdapter: null, status: 'ok', balance: 0, currency: 'USD', fetchedAt: observed });
  await service.refreshAll({ manual: true });
  const current = store.publicState('0001');
  assert.equal(current.status, 'unsupported');
  assert.equal(current.balance, 0);
  assert.equal(current.currency, 'USD');
  assert.equal(current.fetchedAt, observed);
  assert.equal(current.errorClass, null);
  assert.equal(probes, 2);
  assert.equal(accountRequests, 0);
});

test('existing WalletService keeps account credential rotation in Node and shares one refresh for multiple explicit-pool channels', async (t) => {
  const cfg = config(); cfg.channels = cfg.channels.slice(0, 2).map((row) => ({ ...row, baseUrl: 'https://api.ej2075.com/v1' }));
  let rotations = 0; const client = facade({ walletProbe: async () => { throw new Error('model probe should not run for configured account'); } }, cfg);
  const { store, service } = await walletFixture(t, client, async ({ pathname, body }) => {
    if (pathname === '/api/v1/auth/refresh') { rotations++; assert.equal(body.refresh_token, 'ACCOUNT_OLD'); return { code: 0, data: { access_token: 'ACCOUNT_ACCESS', refresh_token: 'ACCOUNT_NEXT', expires_in: 3600 } }; }
    if (pathname.startsWith('/api/v1/auth/me')) return { code: 0, data: { balance: 4.25 } };
    throw new Error('unexpected account endpoint');
  });
  const rows = await client.channels(); await store.reconcileChannels(rows);
  await store.configure(rows[0], { adapter: 'sub2', origin: 'https://api.ej2075.com', credential: 'ACCOUNT_OLD' });
  await store.configure(rows[1], { adapter: 'sub2', origin: 'https://api.ej2075.com', credential: 'ACCOUNT_OLD' });
  await service.refreshAll(); assert.equal(rotations, 1);
  assert.equal(store.publicState('0001').balance, 4.25); assert.equal(store.publicState('channel-1').balance, 4.25);
  assert.equal(store.credential(accountKey('sub2', 'https://api.ej2075.com', 'ACCOUNT_OLD')).current, 'ACCOUNT_NEXT');
  assert.doesNotMatch(JSON.stringify(store.snapshot()), /ACCOUNT_/);
});
