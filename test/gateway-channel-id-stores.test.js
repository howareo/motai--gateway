import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { normalizeChannelId } from '../src/channel-id.js';
import { CostStore, normalizeRule } from '../src/cost-store.js';
import { ChannelHealthStore } from '../src/channel-health-store.js';
import { WalletStore, accountKey } from '../src/wallet-store.js';
import { WalletService } from '../src/wallet-service.js';

const UUID_A = '1e3df401-9c97-44fc-9db1-708f077ab91d';
const UUID_B = '2e3df401-9c97-44fc-9db1-708f077ab91d';
const IDS = [UUID_A, UUID_B, '001', 1, 'constructor', 'toString'];
const INVALID_IDS = ['', ' ', ' x', 'x ', '../x', 'x/y', 'x\\y', 'x?y', 'x%2fy', '__proto__',
  'a'.repeat(129), null, undefined, {}, [], true, 0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1];
const channel = (id) => ({ id, name: `channel-${id}`, type: 1, status: 1, base_url: 'https://upstream.invalid' });

async function fixture(t) {
  const directory = await mkdtemp(path.join(tmpdir(), 'gateway-channel-id-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const costPath = path.join(directory, 'cost.json');
  const healthPath = path.join(directory, 'health.json');
  const statePath = path.join(directory, 'wallet.json');
  const credentialsPath = path.join(directory, 'credentials.json');
  const stores = {
    cost: new CostStore(costPath),
    health: new ChannelHealthStore({ filePath: healthPath }),
    wallet: new WalletStore({ statePath, credentialsPath }),
  };
  await Promise.all(Object.values(stores).map((store) => store.load()));
  return { ...stores, costPath, healthPath, statePath, credentialsPath };
}

test('opaque IDs preserve exact strings and accept only safe positive legacy numbers', () => {
  for (const id of [...IDS, '0', 'NaN', 'A-Z_9.0:channel', 'a'.repeat(128)]) assert.equal(normalizeChannelId(id), String(id));
  assert.equal(normalizeChannelId(Number.MAX_SAFE_INTEGER), '9007199254740991');
  assert.notEqual(normalizeChannelId('001'), normalizeChannelId(1));
  for (const id of INVALID_IDS) assert.throws(() => normalizeChannelId(id), { code: 'invalid_channel_id' });
  assert.throws(() => normalizeRule({ multiplier: 0.3, channelId: null }), { code: 'invalid_channel_id' });
});

test('cost rules, automatic probes and reload keep UUID and numeric-looking channels isolated', async (t) => {
  const { cost, costPath } = await fixture(t);
  for (const [index, id] of IDS.entries()) {
    await cost.setChannelConfiguration(channel(id), { multiplier: (index + 1) / 10, mode: 'auto' }, cost.version);
  }
  for (const [index, id] of IDS.entries()) {
    await cost.recordProbe(channel(id), { status: 'ok', effective_rate_multiplier: (index + 1) / 100 });
  }
  for (const [index, id] of IDS.entries()) {
    assert.equal(cost.resolve({ channelId: id, model: 'model' }).multiplier, (index + 1) / 100);
    assert.equal(cost.syncState(id).status, 'synced');
  }
  assert.equal(cost.channelPricing('1').multiplier, cost.channelPricing(1).multiplier);
  assert.equal(cost.resolve({ channelId: null, model: 'model' }).multiplier, 0.3);
  const bytes = await readFile(costPath, 'utf8');
  const reloaded = new CostStore(costPath);
  await reloaded.load();
  assert.deepEqual(reloaded.snapshot(), cost.snapshot());
  assert.equal(await readFile(costPath, 'utf8'), bytes);
  await reloaded.setChannelMultiplier(UUID_A, 0.77, reloaded.version);
  assert.equal(reloaded.channelPricing(UUID_B).multiplier, 0.02);
  await reloaded.setChannelMode(channel(UUID_A), 'auto', reloaded.version);
  // Rule change: a rename no longer counts as an identity change (type and base URL do).
  // Old: reconcile with name 'changed'                 -> syncState(UUID_A).status === 'identity_changed'
  // New: reconcile with base_url 'https://moved.invalid' -> 'identity_changed', and a rename alone keeps it auto
  await reloaded.reconcileChannels([channel(UUID_B), { ...channel(UUID_A), name: 'renamed only' }]);
  assert.equal(reloaded.syncState(UUID_A).mode, 'auto');
  assert.notEqual(reloaded.syncState(UUID_A).status, 'identity_changed');
  await reloaded.reconcileChannels([channel(UUID_B), { ...channel(UUID_A), base_url: 'https://moved.invalid' }]);
  assert.equal(reloaded.syncState(UUID_A).status, 'identity_changed');
  assert.equal(reloaded.syncState(UUID_B).status, 'synced');
});

test('health history handles UUID, legacy numbers and inherited object names independently', async (t) => {
  const { health, healthPath } = await fixture(t);
  assert.equal(health.channel('constructor').probeAttempts, 0);
  for (const [index, id] of IDS.entries()) {
    await health.record(id, { checkedAt: new Date().toISOString(), success: index % 2 === 0, latencyMs: index + 1 });
  }
  for (const [index, id] of IDS.entries()) {
    assert.equal(health.channel(id).probeAttempts, 1);
    assert.equal(health.channel(id).lastProbeLatencyMs, index + 1);
  }
  assert.deepEqual(health.channel('1'), health.channel(1));
  const bytes = await readFile(healthPath, 'utf8');
  const reloaded = new ChannelHealthStore({ filePath: healthPath });
  await reloaded.load();
  assert.deepEqual(reloaded.snapshot(), health.snapshot());
  assert.equal(await readFile(healthPath, 'utf8'), bytes);
});

test('wallet identities, shared accounts, balances and clear preserve opaque ID isolation after reload', async (t) => {
  const { wallet, statePath, credentialsPath } = await fixture(t);
  await wallet.reconcileChannels(IDS.map(channel));
  for (const [index, id] of IDS.entries()) {
    await wallet.configure(channel(id), { adapter: 'rightcode', origin: 'https://panel.invalid', credential: 'SYNTHETIC_SECRET' });
    await wallet.updateChannel(id, { status: 'ok', balance: index + 1, currency: 'USD' });
  }
  for (const [index, id] of IDS.entries()) assert.equal(wallet.publicState(id).balance, index + 1);
  assert.equal(wallet.publicState('1').balance, wallet.publicState(1).balance);
  const stateBytes = await readFile(statePath, 'utf8');
  const credentialBytes = await readFile(credentialsPath, 'utf8');
  const reloaded = new WalletStore({ statePath, credentialsPath });
  await reloaded.load();
  assert.deepEqual(reloaded.snapshot(), wallet.snapshot());
  assert.equal(await readFile(statePath, 'utf8'), stateBytes);
  assert.equal(await readFile(credentialsPath, 'utf8'), credentialBytes);
  await reloaded.clear(UUID_A);
  assert.equal(reloaded.publicState(UUID_A).balance, null);
  assert.equal(reloaded.publicState(UUID_B).balance, 2);
  assert.ok(reloaded.credential(accountKey('rightcode', 'https://panel.invalid', 'SYNTHETIC_SECRET')));
  // Rule change: a rename no longer clears the wallet (type and base URL do).
  // Old: reconcile with UUID_B named 'changed'            -> publicState(UUID_B).errorClass === 'identity_changed'
  // New: reconcile with UUID_B named 'renamed only'       -> balance 2 kept, errorClass stays null
  //      reconcile with UUID_B at 'https://moved.invalid' -> errorClass === 'identity_changed', balance cleared
  await reloaded.reconcileChannels(IDS.map((id) => id === UUID_B ? { ...channel(id), name: 'renamed only' } : channel(id)));
  assert.equal(reloaded.publicState(UUID_B).errorClass, null);
  assert.equal(reloaded.publicState(UUID_B).balance, 2);
  await reloaded.reconcileChannels(IDS.map((id) => id === UUID_B ? { ...channel(id), base_url: 'https://moved.invalid' } : channel(id)));
  assert.equal(reloaded.publicState(UUID_B).errorClass, 'identity_changed');
  assert.equal(reloaded.publicState(UUID_B).balance, null);
  assert.equal(reloaded.publicState('001').balance, 3);
});

test('manual wallet refresh targets only the exact ID and rate limits each ID separately', async (t) => {
  const { wallet } = await fixture(t);
  const channels = IDS.map(channel);
  const calls = [];
  await wallet.reconcileChannels(channels);
  for (const item of channels) await wallet.configure(item, { adapter: 'newapi' });
  const service = new WalletService({ store: wallet, client: {
    async channels() { return channels; },
    async probeWallet(id) { calls.push(String(id)); return { status: 'ok', balance: calls.length, currency: 'USD' }; },
  } });
  for (const id of IDS) await service.manualRefresh(id);
  assert.deepEqual(calls, IDS.map(String));
  for (const id of IDS) await assert.rejects(service.manualRefresh(id), { statusCode: 429 });
  await assert.rejects(service.manualRefresh('1'), { statusCode: 429 });
  assert.equal(service.manualAttempts.size, IDS.length);
  service.manualAttempts.clear();
  await service.refreshAll({ onlyId: 1, manual: true });
  assert.deepEqual(calls, [...IDS.map(String), '1']);
  for (const id of INVALID_IDS.filter((value) => value !== null && value !== undefined)) {
    await assert.rejects(service.refreshAll({ onlyId: id, manual: true }), { code: 'invalid_channel_id' });
    await assert.rejects(service.manualRefresh(id), { code: 'invalid_channel_id' });
  }
  assert.equal(service.manualAttempts.size, 0);
});

test('invalid IDs reject all store entry points without changing state or credentials', async (t) => {
  const { cost, health, wallet, costPath, healthPath, statePath, credentialsPath } = await fixture(t);
  await wallet.configure(channel(UUID_A), { adapter: 'rightcode', origin: 'https://panel.invalid', credential: 'SYNTHETIC_SECRET' });
  const paths = [costPath, healthPath, statePath, credentialsPath];
  const before = await Promise.all(paths.map((file) => readFile(file, 'utf8')));
  for (const id of INVALID_IDS) {
    for (const call of [
      () => cost.setChannelMultiplier(id, 0.5, cost.version),
      () => cost.setChannelConfiguration(channel(id), { multiplier: 0.5, mode: 'manual' }, cost.version),
      () => cost.setChannelMode(channel(id), 'manual', cost.version),
      () => cost.recordProbe(channel(id), { status: 'ok' }),
      () => cost.reconcileChannels([channel(UUID_B), channel(id)]),
      () => wallet.reconcileChannels([channel(UUID_B), channel(id)]),
      () => wallet.configure(channel(id), { adapter: 'none' }),
      () => wallet.clear(id),
      () => wallet.updateChannel(id, { balance: 5 }),
    ]) await assert.rejects(call, { code: 'invalid_channel_id' });
    for (const call of [() => cost.channelPricing(id), () => cost.syncState(id), () => wallet.state(id),
      () => wallet.publicState(id), () => health.channel(id),
      () => health.record(id, { checkedAt: new Date().toISOString(), success: true })]) {
      assert.throws(call, { code: 'invalid_channel_id' });
    }
  }
  assert.deepEqual(await Promise.all(paths.map((file) => readFile(file, 'utf8'))), before);
  assert.equal(wallet.publicState(UUID_A).configured, true);
});

test('loading malformed persisted ID keys rejects without rewriting either store file', async (t) => {
  const { costPath, healthPath, statePath, credentialsPath } = await fixture(t);
  for (const id of ['__proto__', '../bad', '']) {
    const rows = Object.fromEntries([[id, {}]]);
    const samples = [
      [costPath, { version: 1, rules: [], channelSync: rows }, () => new CostStore(costPath).load()],
      [healthPath, { schemaVersion: 1, channels: rows }, () => new ChannelHealthStore({ filePath: healthPath }).load()],
      [statePath, { schemaVersion: 1, channels: rows }, () => new WalletStore({ statePath, credentialsPath }).load()],
    ];
    for (const [file, value, load] of samples) {
      const bytes = `${JSON.stringify(value)}\n`;
      await writeFile(file, bytes);
      await assert.rejects(load, { code: 'invalid_channel_id' });
      assert.equal(await readFile(file, 'utf8'), bytes);
    }
  }
});
