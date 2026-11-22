import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createApp } from '../src/server.js';
import { ConfigPublisher } from '../src/gateway/config-publisher.js';
import { GatewayControl } from '../src/gateway/control.js';
import { CallerKeyVault } from '../src/gateway/caller-key-vault.js';
import { hashCallerToken } from '../src/gateway/caller-config.js';
import { CostStore } from '../src/cost-store.js';
import { GatewayProjection } from '../src/gateway/projection.js';

const HASH_KEY = Buffer.from('SYNTHETIC-CALLER-KEY-0123456789abcdef\n');
const fixture = async (name) => JSON.parse(await readFile(new URL(`../contracts/fixtures/${name}-valid.json`, import.meta.url)));
// Fixed synthetic keys: the tests search every response and log line for them.
const OLD_KEY = 'sk-legacy-SYNTHETIC-OLD-KEY-000000000000000000';
const ALIAS_KEY = 'sk-legacy-SYNTHETIC-ALIAS-KEY-11111111111111111';
const WRONG_KEY = 'sk-legacy-SYNTHETIC-WRONG-KEY-2222222222222222';
const CALLER = 'caller-codex';

async function setup(t, { vault, legacy = true, hashKey = HASH_KEY } = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), 'motai-keys-'));
  let committed = null;
  const client = {
    status: async () => ({ serving_gen: committed, committed_gen: committed }),
    activate: async (input) => { committed = input.gen; return { ...input, serving_gen: committed, committed_gen: committed }; },
    events: async () => ({ format_version: 1, events: [], next_seq: '0', latest_seq: '0', has_more: false }),
  };
  const publisher = new ConfigPublisher({ directory: path.join(directory, 'gateway'), client, callerHashKey: HASH_KEY });
  const config = await fixture('config'), credentials = await fixture('credentials');
  if (legacy) {
    // An imported token: the published config has only HMACs, one primary and one alias.
    config.callers[0].token_hmac = hashCallerToken(HASH_KEY, OLD_KEY);
    config.callers[0].token_hmac_aliases = [hashCallerToken(HASH_KEY, ALIAS_KEY)];
  }
  await publisher.publish({ baseGen: null, config, credentials });
  const keyVault = vault ?? new CallerKeyVault({ filePath: path.join(directory, 'state', 'caller-keys.json'), hashKey });
  const costStore = new CostStore(path.join(directory, 'costs.json'));
  const priceStore = { resolve: () => null, snapshot: () => ({ snapshotHash: 'price1' }), load: async () => {} };
  const projection = new GatewayProjection({ directory: path.join(directory, 'projection'), client, priceStore, costStore });
  const noop = { load: async () => {}, start: async () => {}, stop: async () => {}, flush: async () => {} };
  const logs = [];
  const originals = {};
  for (const level of ['log', 'info', 'warn', 'error', 'debug']) {
    originals[level] = console[level];
    console[level] = (...args) => { logs.push(args.map((value) => (value instanceof Error ? `${value.message}\n${value.stack}` : String(value))).join(' ')); };
  }
  const app = createApp({ gatewayControl: new GatewayControl({ client, publisher }), callerKeyVault: keyVault, gatewayProjection: projection,
    costStore, modelPricingStore: priceStore, newApiPricingSyncStore: noop, walletStore: { ...noop, publicState: () => null }, walletService: noop,
    channelHealthStore: { ...noop, probeIntervalMinutes: 10, channel: () => ({ recentProbes: [] }) }, logCacheStore: noop });
  // One hook, in this order: stop the app (its projection timer writes into the directory), restore console, then delete the directory.
  t.after(async () => {
    try { await app.close(); }
    finally {
      for (const [level, original] of Object.entries(originals)) console[level] = original;
      await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });
  await app.start({ host: '127.0.0.1', port: 0 });
  const origin = `http://127.0.0.1:${app.server.address().port}`;
  const send = (route, body = {}, headers = {}) => fetch(`${origin}${route}`, { method: 'POST',
    headers: { origin, 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
  const config$ = async () => (await (await fetch(`${origin}/api/gateway/config`)).json()).config;
  const change = async (action, extra = {}) => {
    const response = await send('/api/gateway/callers/change', { baseGen: (await config$()).gen, operationId: randomUUID(), change: { action, ...extra } });
    return { response, body: await response.json() };
  };
  return { directory, keyVault, publisher, logs, origin, send, config$, change };
}

const keyOf = (id) => `/api/gateway/callers/${encodeURIComponent(id)}/key`;
const keyStored = (config, id) => config.callers.find((caller) => caller.id === id).keyStored;

test('creating a caller stores the key, returns it once in the response, and the list reports keyStored', async (t) => {
  const { send, config$, change, keyVault } = await setup(t);
  const created = await change('create', { caller: { name: 'New client' } });
  assert.equal(created.response.status, 200);
  const token = created.body.oneTimeToken;
  assert.match(token, /^sk-motai-/);
  assert.deepEqual(await keyVault.tokensFor(created.body.callerId), [token]);
  assert.equal(keyStored(created.body.config, created.body.callerId), true, 'the response config already shows the key as stored');
  assert.equal(keyStored(await config$(), created.body.callerId), true);
  assert.equal(keyStored(await config$(), CALLER), false, 'imported callers have no stored key yet');
  const fetched = await send(keyOf(created.body.callerId));
  assert.equal(fetched.status, 200);
  assert.equal(fetched.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await fetched.json(), { token });
});

test('after a rotation only the key that matches the committed hash is returned', async (t) => {
  const { send, config$, change, keyVault } = await setup(t);
  const created = await change('create', { caller: { name: 'Rotating' } });
  const id = created.body.callerId, first = created.body.oneTimeToken;
  const rotated = await change('rotate', { callerId: id });
  const second = rotated.body.oneTimeToken;
  assert.notEqual(first, second);
  assert.deepEqual(await keyVault.tokensFor(id), [second, first], 'both are kept while the new config could still be pending');
  assert.deepEqual(await (await send(keyOf(id))).json(), { token: second });
  assert.equal(keyStored(await config$(), id), true);
  assert.notEqual((await (await send(keyOf(id))).json()).token, first, 'the revoked key is never offered again');
});

test('a stored key that no longer matches the committed hash is not offered', async (t) => {
  const { send, config$, change, keyVault } = await setup(t);
  const created = await change('create', { caller: { name: 'Mismatch' } });
  const id = created.body.callerId;
  await keyVault.remove(id);
  await keyVault.save(id, WRONG_KEY);
  assert.equal(keyStored(await config$(), id), false);
  const response = await send(keyOf(id));
  assert.equal(response.status, 404);
  assert.equal((await response.json()).error.code, 'caller_key_not_stored');
  assert.equal((await send(keyOf('no-such-caller'))).status, 404);
});

test('key routes need a same-origin JSON write and never accept GET', async (t) => {
  const { send, origin, change } = await setup(t);
  const created = await change('create', { caller: { name: 'Guarded' } });
  const route = keyOf(created.body.callerId);
  assert.equal((await send(route, {}, { origin: 'https://other.invalid' })).status, 403);
  assert.equal((await send(`${route}/import`, { token: OLD_KEY }, { origin: 'https://other.invalid' })).status, 403);
  assert.equal((await send(route, {}, { 'content-type': 'text/plain' })).status, 415);
  assert.equal((await send(`${route}/import`, { token: OLD_KEY }, { 'content-type': 'text/plain' })).status, 415);
  assert.equal((await fetch(`${origin}${route}`)).status, 404);
  assert.equal((await send(route, {}, { origin: undefined })).status, 403);
});

test('import stores a legacy key only when it matches the published primary or alias hash', async (t) => {
  const { send, config$, keyVault } = await setup(t);
  assert.equal(keyStored(await config$(), CALLER), false);
  const wrong = await send(`${keyOf(CALLER)}/import`, { token: WRONG_KEY });
  assert.equal(wrong.status, 422);
  assert.equal((await wrong.json()).error.code, 'caller_key_mismatch');
  assert.deepEqual(await keyVault.tokensFor(CALLER), []);
  assert.equal((await send(`${keyOf('no-such-caller')}/import`, { token: OLD_KEY })).status, 422);

  const ok = await send(`${keyOf(CALLER)}/import`, { token: OLD_KEY });
  assert.equal(ok.status, 200);
  assert.equal(ok.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await ok.json(), { keyStored: true });
  assert.equal(keyStored(await config$(), CALLER), true);
  assert.deepEqual(await (await send(keyOf(CALLER))).json(), { token: OLD_KEY });

  assert.equal((await send(`${keyOf(CALLER)}/import`, { token: ALIAS_KEY })).status, 200, 'an imported alias is also a valid spelling');
  assert.deepEqual(await keyVault.tokensFor(CALLER), [ALIAS_KEY, OLD_KEY]);
});

test('import validates the key format before comparing anything', async (t) => {
  const { send, keyVault } = await setup(t);
  const invalid = [{ token: 'motai-no-prefix' }, { token: `sk-${'x'.repeat(254)}` }, { token: 'sk-has space' }, { token: 'sk-has\nnewline' },
    { token: 'sk-' }, { token: '' }, { token: 5 }, { token: null }, {}, { token: OLD_KEY, extra: true }, []];
  for (const body of invalid) {
    const response = await send(`${keyOf(CALLER)}/import`, body);
    assert.equal(response.status, 400, JSON.stringify(body).slice(0, 60));
    // A body that is not an object is a malformed request; every other shape is a bad key.
    assert.equal((await response.json()).error.code, Array.isArray(body) ? 'invalid_caller_key_request' : 'invalid_caller_key');
  }
  assert.equal(`sk-${'x'.repeat(253)}`.length, 256);
  assert.equal((await send(`${keyOf(CALLER)}/import`, { token: `sk-${'x'.repeat(253)}` })).status, 422, 'exactly 256 characters passes the format check');
  assert.deepEqual(await keyVault.tokensFor(CALLER), []);
});

test('without a usable vault the key routes answer 503 while token issuance still works', async (t) => {
  const { send, config$, change } = await setup(t, { hashKey: null });
  const created = await change('create', { caller: { name: 'No vault' } });
  assert.equal(created.response.status, 200);
  assert.match(created.body.oneTimeToken, /^sk-motai-/, 'the one-time key is still returned');
  assert.equal(keyStored(await config$(), created.body.callerId), false);
  for (const route of [keyOf(created.body.callerId), `${keyOf(created.body.callerId)}/import`]) {
    const response = await send(route, { token: OLD_KEY });
    assert.equal(response.status, 503);
    assert.equal((await response.json()).error.code, 'caller_key_vault_unavailable');
  }
});

test('a failing vault write is logged without the key and does not change the create response', async (t) => {
  const failing = { available: true, storedCallerIds: async () => new Set(),
    save: async () => { throw Object.assign(new Error('EACCES: cannot write sk-motai-LEAK-CANARY'), { code: 'EACCES' }); } };
  const { change, logs } = await setup(t, { vault: failing });
  const created = await change('create', { caller: { name: 'Disk full' } });
  assert.equal(created.response.status, 200);
  assert.match(created.body.oneTimeToken, /^sk-motai-/);
  assert.ok(logs.some((line) => line.startsWith('[caller-keys] save failed')));
  assert.equal(logs.some((line) => line.includes('LEAK-CANARY') || line.includes(created.body.oneTimeToken)), false);
});

test('neither responses nor logs outside the key endpoint carry a key, and the config never exposes hashes', async (t) => {
  const { send, config$, change, logs, directory } = await setup(t);
  const created = await change('create', { caller: { name: 'Quiet' } });
  const token = created.body.oneTimeToken;
  await send(`${keyOf(CALLER)}/import`, { token: WRONG_KEY });
  await send(`${keyOf(CALLER)}/import`, { token: OLD_KEY });
  await send(keyOf(created.body.callerId));
  const rotated = await change('rotate', { callerId: created.body.callerId });
  const everything = JSON.stringify([await config$(), { ...created.body, oneTimeToken: undefined }, { ...rotated.body, oneTimeToken: undefined },
    await (await send('/api/gateway/reconcile')).json()]);
  for (const secret of [token, rotated.body.oneTimeToken, OLD_KEY, ALIAS_KEY, WRONG_KEY, HASH_KEY.toString().trim()]) {
    assert.equal(everything.includes(secret), false, 'response leak');
    assert.equal(logs.some((line) => line.includes(secret)), false, 'log leak');
  }
  for (const hash of [hashCallerToken(HASH_KEY, OLD_KEY), hashCallerToken(HASH_KEY, ALIAS_KEY), hashCallerToken(HASH_KEY, token)]) {
    assert.equal(everything.includes(hash), false, 'hash leak');
  }
  assert.equal(everything.includes('token_hmac'), false);
  const config = await config$();
  for (const caller of config.callers) {
    assert.deepEqual(Object.keys(caller).filter((name) => !['id', 'name', 'enabled', 'subjectEnabled', 'expiresAt', 'allowedIps', 'permissions'].includes(name)), ['keyStored', 'keyMasked']);
    if (caller.keyStored) assert.match(caller.keyMasked, /^sk-[^.]+\.\.\..{4}$/);
    else assert.equal(caller.keyMasked, null);
  }
  // The gateway configuration directory is untouched by the vault: no key text or vault file in it.
  for (const name of await readdir(path.join(directory, 'gateway'))) {
    const content = await readFile(path.join(directory, 'gateway', name), 'utf8');
    assert.equal(content.includes(token) || content.includes(OLD_KEY), false, name);
  }
});

test('the clipboard helper module is served with the other caller editor modules', async (t) => {
  const { origin } = await setup(t);
  const response = await fetch(`${origin}/caller-editor/clipboard.js`);
  assert.equal(response.status, 200);
  assert.match(await response.text(), /export async function copyText/);
});
