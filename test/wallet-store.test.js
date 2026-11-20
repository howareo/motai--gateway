import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { WalletStore, accountKey } from '../src/wallet-store.js';

async function storeFixture(t) {
  const directory = await mkdtemp(path.join(tmpdir(), 'wallet-store-'));
  const statePath = path.join(directory, 'state.json');
  const credentialsPath = path.join(directory, 'credentials.json');
  const store = new WalletStore({ statePath, credentialsPath });
  await store.load();
  t.after(() => rm(directory, { recursive: true, force: true }));
  return { store, statePath, credentialsPath };
}

test('keeps credentials outside sanitized wallet snapshots', async (t) => {
  const { store, statePath, credentialsPath } = await storeFixture(t);
  const channel = { id: 7, name: 'Sub2', type: 14, base_url: 'https://api.example.com' };
  const secret = 'refresh-token-secret';
  await store.reconcileChannels([channel]);
  const snapshot = await store.configure(channel, { adapter: 'sub2', origin: 'https://panel.example.com', credential: secret });

  assert.equal(snapshot.configured, true);
  assert.equal(JSON.stringify(store.snapshot()).includes(secret), false);
  assert.equal((await readFile(statePath, 'utf8')).includes(secret), false);
  assert.equal((await readFile(credentialsPath, 'utf8')).includes(secret), true);
});

test('cleans orphan credentials after channel identity changes', async (t) => {
  const { store } = await storeFixture(t);
  const channel = { id: 8, name: 'Right', type: 14, base_url: 'https://right.example.com' };
  const key = accountKey('rightcode', 'https://right.example.com', 'token');
  await store.reconcileChannels([channel]);
  await store.configure(channel, { adapter: 'rightcode', origin: 'https://right.example.com', credential: 'token' });
  assert.ok(store.credential(key));

  await store.reconcileChannels([{ ...channel, base_url: 'https://changed.example.com' }]);
  assert.equal(store.credential(key), null);
  assert.equal(store.publicState(8).balance, null);
});

async function walletWithBalance(t) {
  const { store, statePath } = await storeFixture(t);
  const channel = { id: 8, name: 'Right', type: 14, base_url: 'https://right.example.com' };
  const key = accountKey('rightcode', 'https://right.example.com', 'token');
  await store.reconcileChannels([channel]);
  await store.configure(channel, { adapter: 'rightcode', origin: 'https://right.example.com', credential: 'token' });
  await store.updateChannel(8, { status: 'ok', balance: 12.5, currency: 'USD', fetchedAt: '2026-10-30T00:00:00.000Z' });
  return { store, statePath, channel, key };
}

test('renaming a channel keeps its adapter, account link, credential and balance', async (t) => {
  const { store, statePath, channel, key } = await walletWithBalance(t);
  const before = store.state(8);
  await store.reconcileChannels([{ ...channel, name: 'Right Code renamed' }]);
  const after = store.state(8);
  assert.equal(after.identity.name, 'Right Code renamed', 'the stored label follows the rename');
  assert.equal(after.detectedAdapter, 'rightcode');
  assert.equal(after.accountKey, key);
  assert.equal(after.status, 'ok');
  assert.equal(after.balance, 12.5);
  assert.equal(after.currency, 'USD');
  assert.equal(after.fetchedAt, before.fetchedAt);
  assert.equal(after.errorClass, null);
  assert.ok(store.credential(key), 'the credential is not orphaned');
  assert.equal(store.publicState(8).configured, true);
  // The new label is persisted, and a reload sees an unchanged wallet.
  assert.equal(JSON.parse(await readFile(statePath, 'utf8')).channels['8'].identity.name, 'Right Code renamed');
  const reloaded = new WalletStore({ statePath, credentialsPath: store.credentialsPath });
  await reloaded.load();
  await reloaded.reconcileChannels([{ ...channel, name: 'Right Code renamed' }]);
  assert.equal(reloaded.publicState(8).balance, 12.5);
});

test('a rename alone does not rewrite the wallet state file', async (t) => {
  const { store, statePath, channel } = await walletWithBalance(t);
  const bytes = await readFile(statePath, 'utf8');
  await store.reconcileChannels([channel]);
  assert.equal(await readFile(statePath, 'utf8'), bytes);
});

test('same-origin accounts stay separate across replacement, blank saves, reload and clear', async (t) => {
  const { store, statePath, credentialsPath } = await storeFixture(t);
  const a = { id: 'codex', name: 'Codex', type: 1, base_url: 'https://panel.example.com' };
  const b = { ...a, id: 'gemini', name: 'Gemini' };
  await store.reconcileChannels([a, b]);
  for (const [channel, credential] of [[a, 'account-a'], [b, 'account-b']]) {
    await store.configure(channel, { adapter: 'sub2', origin: a.base_url, credential });
  }
  const aKey = store.state(a.id).accountKey, bKey = store.state(b.id).accountKey;
  assert.notEqual(aKey, bKey);
  assert.equal(store.credential(aKey).current, 'account-a');
  assert.equal(store.credential(bKey).current, 'account-b');
  await store.updateChannel(a.id, { balance: 10, currency: 'USD', fetchedAt: '2026-11-10T00:00:00Z' });
  await store.configure(a, { adapter: 'sub2', origin: a.base_url });
  assert.equal(store.state(a.id).accountKey, aKey);
  assert.equal(store.publicState(a.id).balance, 10);
  await store.configure(a, { adapter: 'sub2', origin: a.base_url, credential: 'replacement-a' });
  assert.equal(store.publicState(a.id).balance, null, 'old account balance is not shown for a new account');
  assert.equal(store.publicState(a.id).currency, null);
  assert.equal(store.publicState(a.id).fetchedAt, null);
  assert.equal(store.credential(bKey).current, 'account-b');
  const reloaded = new WalletStore({ statePath, credentialsPath });
  await reloaded.load();
  assert.equal(reloaded.credential(reloaded.state(a.id).accountKey).current, 'replacement-a');
  assert.equal(reloaded.credential(reloaded.state(b.id).accountKey).current, 'account-b');
  await reloaded.clear(a.id);
  assert.equal(reloaded.publicState(b.id).configured, true);
  assert.equal(reloaded.credential(bKey).current, 'account-b');
});

test('a blank New API credential preserves this channel account instead of falling back to token quota', async (t) => {
  const { store } = await storeFixture(t);
  const channel = { id: 12, name: 'New API', type: 1, base_url: 'https://relay.example.com' };
  await store.reconcileChannels([channel]);
  await store.configure(channel, { adapter: 'newapi', origin: channel.base_url, credential: 'user-access-token' });
  const key = store.state(channel.id).accountKey;
  await store.configure(channel, { adapter: 'newapi' });
  assert.equal(store.state(channel.id).accountKey, key);
  assert.equal(store.publicState(channel.id).configured, true);
});

test('changing the base URL or the type still clears the wallet and marks identity_changed', async (t) => {
  for (const change of [{ base_url: 'https://moved.example.com' }, { type: 1 }]) {
    const { store, channel, key } = await walletWithBalance(t);
    await store.reconcileChannels([{ ...channel, name: 'also renamed', ...change }]);
    const state = store.state(8);
    assert.equal(state.errorClass, 'identity_changed');
    assert.equal(state.status, 'unknown');
    assert.equal(state.balance, null);
    assert.equal(state.currency, null);
    assert.equal(state.fetchedAt, null);
    assert.equal(state.detectedAdapter, null);
    assert.equal(state.accountKey, null);
    assert.equal(state.identity.name, 'also renamed');
    if (change.base_url) assert.equal(store.credential(key), null, 'the credential of the old address is dropped');
  }
});
