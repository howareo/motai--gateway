import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { CostStore } from '../src/cost-store.js';

test('upstream daily bill survives group discounts and reload without repricing history', async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'cost-bill-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new CostStore(path.join(directory, 'rules.json'));
  await store.load();
  const channel = { id: '4', type: 1, base_url: 'https://vvvvvip.tststs.shop', name: 'TokenShop' };
  await store.reconcileChannels([channel]);
  await store.setChannelMode(channel, 'auto', store.version);
  const days = [{ date: '2026-11-15', actualCost: 1, standardCost: 10, requests: 20 },
    { date: '2026-11-16', actualCost: 43.27461468, standardCost: 393.405588, requests: 2091 }];
  await store.recordProbe(channel, { status: 'ok', effective_rate_multiplier: 0.11, dailyCosts: days, observed_at: '2026-11-16T14:00:00Z' });
  await store.recordProbe(channel, { status: 'ok', effective_rate_multiplier: 0.2, dailyCosts: days });
  const restored = new CostStore(store.filePath);
  await restored.load();
  const bill = restored.upstreamBill('4', { key: 'today', from: '2026-11-15T16:00:00.000Z' });
  assert.equal(bill.actualCost, 43.27461468);
  assert.equal(restored.upstreamBill('4', { key: 'yesterday', from: '2026-11-14T16:00:00.000Z' }).actualCost, 1);
  assert.equal(restored.upstreamBill('4', { key: 'hours-24', from: '2026-11-15T16:00:00.000Z' }), null);
  assert.equal(restored.upstreamBill('1012', { key: 'today', from: '2026-11-15T16:00:00.000Z' }), null);
  await restored.reconcileChannels([{ ...channel, base_url: 'https://different.example' }]);
  assert.equal(restored.upstreamBill('4', { key: 'today', from: '2026-11-15T16:00:00.000Z' }), null);
});

test('resolve gives the most specific current rule, for showing a channel multiplier', async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'cost-store-'));
  const store = new CostStore(path.join(directory, 'rules.json'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await store.save([
    { id: 'global', channelId: '*', model: '*', multiplier: 0.3, effectiveFrom: 0 },
    { id: 'channel', channelId: '2', model: '*', multiplier: 0.2, effectiveFrom: 10 },
    { id: 'model', channelId: '2', model: 'claude-x', multiplier: 0.1, effectiveFrom: 20 },
    { id: 'future', channelId: '2', model: 'claude-x', multiplier: 0.05, effectiveFrom: 1000 },
  ]);
  assert.equal(store.resolve({ channel: 2, model_name: 'claude-x', created_at: 100 }).id, 'future');
  assert.equal(store.resolve({ channel: 2, model_name: 'other', created_at: 100 }).id, 'channel');
  assert.equal(store.resolve({ channel: 3, model_name: 'other', created_at: 100 }).id, 'global');
});

test('resolveAt prices a request with the rule in effect when it was made', async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'cost-store-'));
  const store = new CostStore(path.join(directory, 'rules.json'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await store.save([
    { id: 'global', channelId: '*', model: '*', multiplier: 0.3, effectiveFrom: 0 },
    { id: 'c12', channelId: '2', model: '*', multiplier: 0.12, effectiveFrom: 100, revision: 1 },
    { id: 'model', channelId: '2', model: 'claude-x', multiplier: 0.5, effectiveFrom: 150, revision: 2 },
    { id: 'c01', channelId: '2', model: '*', multiplier: 0.01, effectiveFrom: 200, revision: 3 },
    { id: 'same-later-revision', channelId: '3', model: '*', multiplier: 0.4, effectiveFrom: 50, revision: 5 },
    { id: 'same-earlier-revision', channelId: '3', model: '*', multiplier: 0.6, effectiveFrom: 50, revision: 4 },
    // Less specific and later: never beats a channel rule already in effect.
    { id: 'global-late', channelId: '*', model: '*', multiplier: 0.9, effectiveFrom: 300, revision: 6 },
  ]);
  const at = (channel, model, time) => store.resolveAt({ channel, model_name: model }, time)?.id ?? null;
  assert.equal(at(2, 'other', 99), 'global');
  assert.equal(at(2, 'other', 100), 'c12');
  assert.equal(at(2, 'other', 199.999), 'c12');
  assert.equal(at(2, 'other', 200), 'c01');
  assert.equal(at(2, 'other', 400), 'c01');
  assert.equal(at(2, 'claude-x', 120), 'c12');
  assert.equal(at(2, 'claude-x', 150), 'model');
  assert.equal(at(2, 'claude-x', 400), 'model', 'a channel+model rule outranks a later channel rule, as in resolve()');
  assert.equal(at(3, 'other', 49), 'global');
  assert.equal(at(3, 'other', 50), 'same-later-revision');
  assert.equal(at(4, 'other', 299), 'global');
  assert.equal(at(4, 'other', 300), 'global-late');
  assert.equal(store.resolveAt({ channel: 2, model_name: 'other' }, Number.NaN), null);
  for (const [channel, model] of [[2, 'other'], [2, 'claude-x'], [3, 'other'], [4, 'other']]) {
    assert.equal(store.resolveAt({ channel, model_name: model }, 1e12).id, store.resolve({ channel, model_name: model }).id);
  }

  assert.deepEqual(store.ruleOver({ channel: 2, model: 'other' }, 100, 200), { changes: false, rule: store.resolveAt({ channel: 2 }, 100) });
  assert.equal(store.ruleOver({ channel: 2, model: 'other' }, 100, 200.001).changes, true);
  assert.equal(store.ruleOver({ channel: 2, model: 'other' }, 0, 100).rule.id, 'global');
  const empty = new CostStore(path.join(directory, 'none.json'));
  await empty.save([]);
  assert.deepEqual(empty.ruleOver({ channel: 2, model: 'other' }, 0, 10), { changes: false, rule: null });

  // A new rule replaces the rules array, so the cached schedule is rebuilt.
  await store.setChannelMultiplier(4, 0.07, store.version);
  assert.equal(store.resolveAt({ channel: 4, model_name: 'other' }, Date.now() / 1000 + 1).multiplier, 0.07);
});

test('a manual channel multiplier becomes the current rule and rejects stale writes', async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'cost-store-'));
  const store = new CostStore(path.join(directory, 'rules.json'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await store.load();
  const initialVersion = store.version;
  const updated = await store.setChannelMultiplier(2, 0.2, initialVersion);
  assert.equal(updated.version, initialVersion + 1);
  assert.equal(store.channelPricing(2).multiplier, 0.2);
  assert.equal(store.channelPricing(3).multiplier, 0.3);
  await assert.rejects(
    () => store.setChannelMultiplier(2, 0.1, initialVersion),
    (error) => error.statusCode === 409,
  );
  assert.equal(store.resolve({ channel: 2, model_name: 'claude-x', created_at: 1 }).multiplier, 0.2);
  assert.equal(store.resolve({ channel: 2, model_name: 'claude-x' }).multiplier, 0.2);
});

test('auto sync applies one valid observation as the current rule', async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'cost-store-'));
  const store = new CostStore(path.join(directory, 'rules.json'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await store.load();
  const channel = { id: 2, name: 'TokenShop', type: 14, base_url: 'https://upstream.example' };
  await store.setChannelMultiplier(2, 0.1, store.version);
  await store.setChannelMode(channel, 'auto', store.version);

  const beforeChange = Date.now() / 1000;
  await store.recordProbe(channel, {
    status: 'ok', effective_rate_multiplier: 0.12, observed_at: '2026-07-25T00:00:00Z',
    source: 'newapi.group_ratio', upstream_group: '专用gpt',
  });
  assert.equal(store.channelPricing(2).multiplier, 0.12);
  assert.equal(store.syncState(2).status, 'synced');
  assert.equal(store.syncState(2).upstreamGroup, '专用gpt');
  assert.equal(store.syncState(2).upstreamSource, 'newapi.group_ratio');
  assert.equal(store.syncState(2).pending, null);
  assert.equal(store.resolve({ channel: 2, model_name: 'claude-x', created_at: beforeChange }).multiplier, 0.12);
});

test('auto sync keeps failures but applies a large valid change immediately', async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'cost-store-'));
  const store = new CostStore(path.join(directory, 'rules.json'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await store.load();
  const channel = { id: 3, name: 'zzz', type: 1, base_url: 'https://upstream.example/v1' };
  await store.setChannelMultiplier(3, 0.06, store.version);
  await store.setChannelMode(channel, 'auto', store.version);

  await store.recordProbe(channel, { status: 'failed', error_class: 'timeout' });
  assert.equal(store.channelPricing(3).multiplier, 0.06);
  assert.equal(store.syncState(3).errorClass, 'timeout');

  await store.recordProbe(channel, {
    status: 'ok', effective_rate_multiplier: 0.5, observed_at: '2026-07-25T01:00:00Z',
  });
  assert.equal(store.channelPricing(3).multiplier, 0.5);
  assert.equal(store.syncState(3).status, 'synced');
  assert.equal(store.syncState(3).pending, null);
});

test('rate limiting preserves a recently synchronized multiplier', async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'cost-store-'));
  const store = new CostStore(path.join(directory, 'rules.json'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await store.load();
  const channel = { id: 5, name: 'TokenShop', type: 1, base_url: 'https://upstream.example' };
  await store.setChannelMode(channel, 'auto', store.version);
  await store.recordProbe(channel, { status: 'ok', effective_rate_multiplier: 0.07 });
  await store.recordProbe(channel, { status: 'failed', error_class: 'probe_rate_limited' });
  assert.equal(store.channelPricing(5).multiplier, 0.07);
  assert.equal(store.syncState(5).status, 'synced');
  assert.equal(store.syncState(5).errorClass, 'probe_rate_limited');
});

async function identityStore(t) {
  const directory = await mkdtemp(path.join(tmpdir(), 'cost-store-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const filePath = path.join(directory, 'rules.json');
  const store = new CostStore(filePath);
  await store.load();
  return { store, filePath };
}
const upstream = { id: 4, name: 'TokenShop', type: 1, base_url: 'https://upstream.example' };

test('changing the base URL disables auto sync and remembers the identity it had', async (t) => {
  const { store } = await identityStore(t);
  await store.setChannelMode(upstream, 'auto', store.version);
  await store.reconcileChannels([{ ...upstream, base_url: 'https://changed.example' }]);
  assert.equal(store.syncState(4).mode, 'manual');
  assert.equal(store.syncState(4).status, 'identity_changed');
  assert.deepEqual(store.syncState(4).previousIdentity, { name: 'TokenShop', type: 1, baseUrl: 'https://upstream.example' });
  assert.equal(store.syncState(4).identity.baseUrl, 'https://changed.example');
});

test('changing the channel type disables auto sync too', async (t) => {
  const { store } = await identityStore(t);
  await store.setChannelMode(upstream, 'auto', store.version);
  await store.reconcileChannels([{ ...upstream, type: 14 }]);
  assert.equal(store.syncState(4).status, 'identity_changed');
  assert.equal(store.syncState(4).previousIdentity.type, 1);
});

test('the probe path applies the same identity rule as reconcile', async (t) => {
  const { store } = await identityStore(t);
  await store.setChannelMode(upstream, 'auto', store.version);
  // Renamed: still probed and recorded.
  await store.recordProbe({ ...upstream, name: 'TokenShop Codex' }, { status: 'ok', effective_rate_multiplier: 0.2 });
  assert.equal(store.syncState(4).mode, 'auto');
  assert.equal(store.syncState(4).status, 'synced');
  assert.equal(store.channelPricing(4).multiplier, 0.2);
  // Moved: not recorded, switched to manual, previous identity kept.
  await store.recordProbe({ ...upstream, base_url: 'https://elsewhere.example' }, { status: 'ok', effective_rate_multiplier: 0.9 });
  assert.equal(store.syncState(4).status, 'identity_changed');
  assert.equal(store.channelPricing(4).multiplier, 0.2);
  assert.equal(store.syncState(4).previousIdentity.baseUrl, 'https://upstream.example');
});

test('renaming a channel keeps automatic sync on and only refreshes the stored label', async (t) => {
  const { store } = await identityStore(t);
  await store.setChannelMode(upstream, 'auto', store.version);
  await store.recordProbe(upstream, { status: 'ok', effective_rate_multiplier: 0.07 });
  const before = store.syncState(4);
  await store.reconcileChannels([{ ...upstream, name: 'TokenShop Codex' }]);
  const after = store.syncState(4);
  assert.equal(after.mode, 'auto');
  assert.equal(after.status, 'synced');
  assert.equal(after.errorClass, null);
  assert.equal(after.previousIdentity, null);
  assert.equal(after.identity.name, 'TokenShop Codex');
  assert.equal(after.lastSuccessAt, before.lastSuccessAt);
  assert.equal(after.lastConfirmedMultiplier, 0.07);
  assert.equal(store.channelPricing(4).multiplier, 0.07);
  // And the next probe still records.
  await store.recordProbe({ ...upstream, name: 'TokenShop Codex' }, { status: 'ok', effective_rate_multiplier: 0.08 });
  assert.equal(store.channelPricing(4).multiplier, 0.08);
});

test('a channel misjudged as changed, whose type and base URL are what they were, gets automatic sync back', async (t) => {
  const { store, filePath } = await identityStore(t);
  await store.setChannelMode(upstream, 'auto', store.version);
  await store.reconcileChannels([{ ...upstream, base_url: 'https://changed.example' }]);
  assert.equal(store.syncState(4).status, 'identity_changed');
  // The state as an older version wrote it for a rename: previousIdentity differs from the current channel only by name.
  const saved = JSON.parse(await readFile(filePath, 'utf8'));
  saved.channelSync['4'].previousIdentity = { name: 'TokenShoop OpenAI', type: 1, baseUrl: 'https://changed.example' };
  await writeFile(filePath, JSON.stringify(saved));
  const reloaded = new CostStore(filePath);
  await reloaded.load();
  assert.equal(reloaded.syncState(4).status, 'identity_changed');
  const multiplierBefore = reloaded.channelPricing(4).multiplier;
  await reloaded.reconcileChannels([{ ...upstream, name: 'TokenShop Codex', base_url: 'https://changed.example' }]);
  const state = reloaded.syncState(4);
  assert.equal(state.mode, 'auto');
  assert.equal(state.status, 'stale', 'cleared, ready for the next round');
  assert.equal(state.errorClass, null);
  assert.equal(state.previousIdentity, null);
  assert.equal(state.identity.name, 'TokenShop Codex');
  assert.equal(reloaded.channelPricing(4).multiplier, multiplierBefore, 'the multiplier is not touched');
  // The next probe records normally.
  await reloaded.recordProbe({ ...upstream, name: 'TokenShop Codex', base_url: 'https://changed.example' }, { status: 'ok', effective_rate_multiplier: 0.11 });
  assert.equal(reloaded.syncState(4).status, 'synced');
  assert.equal(reloaded.channelPricing(4).multiplier, 0.11);
});

test('a real change that has not been reverted stays manual, and so does a record without previousIdentity', async (t) => {
  const { store, filePath } = await identityStore(t);
  await store.setChannelMode(upstream, 'auto', store.version);
  await store.reconcileChannels([{ ...upstream, base_url: 'https://changed.example' }]);
  // Still different from what it was: nothing to undo, repeated rounds change nothing.
  const version = store.version;
  await store.reconcileChannels([{ ...upstream, base_url: 'https://changed.example' }]);
  assert.equal(store.syncState(4).status, 'identity_changed');
  assert.equal(store.syncState(4).mode, 'manual');
  assert.equal(store.version, version);
  // Same shape older versions wrote: identity_changed, no previousIdentity, current channel differs only by name.
  const saved = JSON.parse(await readFile(filePath, 'utf8'));
  delete saved.channelSync['4'].previousIdentity;
  saved.channelSync['4'].identity = { name: 'tokenshoop deepseek', type: 1, baseUrl: 'https://changed.example' };
  await writeFile(filePath, JSON.stringify(saved));
  const legacy = new CostStore(filePath);
  await legacy.load();
  assert.equal(legacy.syncState(4).previousIdentity, null);
  const legacyVersion = legacy.version;
  await legacy.reconcileChannels([{ ...upstream, name: 'tokenshop deepseek', base_url: 'https://changed.example' }]);
  assert.equal(legacy.syncState(4).mode, 'manual');
  assert.equal(legacy.syncState(4).status, 'identity_changed');
  assert.equal(legacy.syncState(4).errorClass, 'identity_changed');
  assert.equal(legacy.version, legacyVersion, 'nothing was rewritten');
});

test('setting the multiplier by hand ends an identity_changed state and its recovery', async (t) => {
  const { store } = await identityStore(t);
  await store.setChannelMode(upstream, 'auto', store.version);
  await store.reconcileChannels([{ ...upstream, base_url: 'https://changed.example' }]);
  await store.setChannelMultiplier(4, 0.5, store.version);
  assert.equal(store.syncState(4).status, 'manual');
  assert.equal(store.syncState(4).previousIdentity, null, 'only kept while identity_changed');
  // Even if the channel is back at its old address, a deliberate manual setting is not undone.
  await store.reconcileChannels([upstream]);
  assert.equal(store.syncState(4).mode, 'manual');
  assert.equal(store.channelPricing(4).multiplier, 0.5);
});
