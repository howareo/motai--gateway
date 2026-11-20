import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { callerHashKey, hashCallerToken, issueCallerToken, reduceCallerChange } from '../src/gateway/caller-config.js';
import { ConfigPublisher } from '../src/gateway/config-publisher.js';

const fixture = async (name) => JSON.parse(await readFile(new URL(`../contracts/fixtures/${name}-valid.json`, import.meta.url)));
const snapshot = async () => ({ config: await fixture('config'), credentials: await fixture('credentials') });
const KEY = Buffer.from('SYNTHETIC-CALLER-KEY-0123456789abcdef\n');
const HMAC = 'b'.repeat(64);
const permission = () => ({ poolId: 'pool-main', modelIds: ['Model/Case-Sensitive'], channelIds: ['1022'], protocols: ['responses'], groups: [] });

test('shared imported token HMAC vectors preserve exact full spellings', async () => {
  const { authentication: vector } = JSON.parse(await readFile(new URL('../contracts/fixtures/caller-token-alias-vectors.json', import.meta.url)));
  assert.equal(hashCallerToken(vector.hash_key, vector.bare_token), vector.primary_hmac);
  assert.equal(hashCallerToken(vector.hash_key, vector.prefixed_token), vector.alias_hmac);
  for (const token of vector.rejected_tokens) assert(![vector.primary_hmac, vector.alias_hmac].includes(hashCallerToken(vector.hash_key, token)));
});

test('imported aliases survive ordinary edits and are removed on rotation without mutating the source', async () => {
  const before = await snapshot();
  before.config.callers[0].token_hmac_aliases = ['c'.repeat(64)];
  const preserved = structuredClone(before);
  for (const change of [{ action: 'disable', callerId: 'caller-codex' },
    { action: 'enable', callerId: 'caller-codex' },
    { action: 'update', callerId: 'caller-codex', caller: { name: 'Renamed' } }]) {
    const changed = reduceCallerChange(before, change);
    assert.deepEqual(changed.config.callers[0].token_hmac_aliases, before.config.callers[0].token_hmac_aliases);
  }
  const rotated = reduceCallerChange(before, { action: 'rotate', callerId: 'caller-codex' }, { tokenHmac: HMAC });
  assert.equal(Object.hasOwn(rotated.config.callers[0], 'token_hmac_aliases'), false);
  const expected = { ...before.config.callers[0], token_hmac: HMAC };
  delete expected.token_hmac_aliases;
  assert.deepEqual(rotated.config.callers[0], expected);
  assert.deepEqual(before, preserved);
  assert.throws(() => reduceCallerChange(before, { action: 'update', callerId: 'caller-codex', caller: { token_hmac_aliases: [] } }));
  assert.throws(() => reduceCallerChange(before, { action: 'create', caller: { name: 'new', token_hmac_aliases: [] } }, { tokenHmac: HMAC }));
  const collision = structuredClone(before);
  collision.config.callers.push({ ...structuredClone(before.config.callers[0]), id: 'other', token_hmac: HMAC, token_hmac_aliases: ['d'.repeat(64)] });
  assert.throws(() => reduceCallerChange(collision, { action: 'rotate', callerId: 'caller-codex' }, { tokenHmac: 'd'.repeat(64) }));
});

test('publisher management projection and snapshots redact primary and alias hashes while rotation revokes both', async (t) => {
  const { publisher } = await publisherFixture(t);
  const input = structuredClone(publisher.current);
  input.config.gen = '2';
  input.config.callers[0].token_hmac_aliases = ['c'.repeat(64)];
  const published = await publisher.publish({ baseGen: '1', config: input.config, credentials: input.credentials });
  const privateCaller = publisher.current.config.callers[0];
  for (const value of [published, publisher.snapshot()]) {
    const output = JSON.stringify(value);
    assert(!output.includes(privateCaller.token_hmac));
    assert(!output.includes(privateCaller.token_hmac_aliases[0]));
    assert(!output.includes('token_hmac_aliases'));
  }
  const result = await publisher.callerChange({ baseGen: '2', operationId: randomUUID(), change: { action: 'rotate', callerId: privateCaller.id } });
  assert.equal(publisher.current.config.callers[0].token_hmac_aliases, undefined);
  assert.equal(result.config.callers[0].token_hmac_aliases, undefined);
  assert.equal(publisher.current.config.callers[0].token_hmac, hashCallerToken(KEY, result.oneTimeToken));
});

async function publisherFixture(t, callerKey = KEY) {
  const directory = await mkdtemp(path.join(tmpdir(), 'motai-caller-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  let committed = null;
  const activations = [];
  const client = { status: async () => ({ serving_gen: committed, committed_gen: committed }), activate: async (input) => {
    activations.push(input);
    committed = input.gen;
    return { ...input, serving_gen: committed, committed_gen: committed };
  } };
  const publisher = new ConfigPublisher({ directory, client, callerHashKey: callerKey });
  await publisher.publish({ baseGen: null, ...await snapshot() });
  return { publisher, client, directory, activations };
}

test('caller create is server identified, disabled and unprivileged by default without mutating inputs', async () => {
  const before = await snapshot(), preserved = structuredClone(before);
  const result = reduceCallerChange(before, { action: 'create', caller: { name: '  New caller  ' } }, { tokenHmac: HMAC });
  const added = result.config.callers.at(-1);
  assert.match(added.id, /^[0-9a-f-]{36}$/);
  assert.equal(result.callerId, added.id);
  assert.deepEqual({ ...added, id: '' }, { id: '', name: 'New caller', enabled: false, subject_enabled: true,
    token_hmac: HMAC, expires_at: null, allowed_ips: [], permissions: [] });
  assert.deepEqual(before, preserved);
  assert.deepEqual(result.credentials, before.credentials);
});

test('caller update maps exact scope, expiry, subject status and IPs while preserving the token hash', async () => {
  const before = await snapshot();
  const input = { id: 'caller-codex', name: 'Desktop', subjectEnabled: false, expiresAt: '2027-01-01T00:00:00Z',
    allowedIps: ['192.0.2.5', '2001:db8::/64'], permissions: [permission()] };
  const result = reduceCallerChange(before, { action: 'update', callerId: 'caller-codex', caller: input });
  const caller = result.config.callers[0];
  assert.equal(caller.token_hmac, before.config.callers[0].token_hmac);
  assert.equal(caller.subject_enabled, false);
  assert.equal(caller.expires_at, input.expiresAt);
  assert.deepEqual(caller.permissions, before.config.callers[0].permissions);
  input.permissions[0].channelIds.push('unexpected');
  input.allowedIps.push('unexpected');
  assert.deepEqual(caller.permissions[0].channel_ids, ['1022']);
  assert.deepEqual(caller.allowed_ips, ['192.0.2.5', '2001:db8::/64']);
});

test('enable and disable change only enabled; rotation changes only the token hash', async () => {
  const before = await snapshot();
  const disabled = reduceCallerChange(before, { action: 'disable', callerId: 'caller-codex' });
  assert.deepEqual(disabled.config.callers[0], { ...before.config.callers[0], enabled: false });
  const rotated = reduceCallerChange(disabled, { action: 'rotate', callerId: 'caller-codex' }, { tokenHmac: HMAC });
  assert.deepEqual(rotated.config.callers[0], { ...disabled.config.callers[0], token_hmac: HMAC });
  const enabled = reduceCallerChange(rotated, { action: 'enable', callerId: 'caller-codex' });
  assert.deepEqual(enabled.config.callers[0], { ...rotated.config.callers[0], enabled: true });
});

test('caller rejects spoofed secrets, caller IDs, malformed DTOs, expiry, IPs and cross-pool scope', async () => {
  const before = await snapshot();
  before.config.pools.push({ id: 'other', name: 'Other' });
  const cases = [
    { action: 'create', callerId: 'supplied', caller: { name: 'new' } },
    { action: 'create', caller: { id: 'supplied', name: 'new' } },
    { action: 'create', caller: { enabled: true, name: 'new' } },
    { action: 'create', caller: { name: '   ' } },
    { action: 'create', caller: { name: 'new', token: 'SYNTHETIC_SECRET' } },
    { action: 'update', callerId: 'caller-codex', caller: { token_hmac: HMAC } },
    { action: 'update', callerId: 'caller-codex', caller: { id: 'changed' } },
    { action: 'update', callerId: 1, caller: {} },
    { action: 'update', callerId: 'missing', caller: {} },
    { action: 'delete', callerId: 'caller-codex' },
    ...['enable', 'disable', 'rotate'].map((action) => ({ action, callerId: 'caller-codex', caller: {} })),
    ...[{ subjectEnabled: null }, { enabled: 'true' }, { expiresAt: '2026-02-30T00:00:00Z' },
      { expiresAt: '2026-01-01T00:00:00+08:00' }, { allowedIps: ['0.0.0.0/99'] }, { allowedIps: ['*'] },
      { permissions: [{ ...permission(), poolId: 'other' }] }, { permissions: [{ ...permission(), modelIds: ['unknown'] }] },
      { permissions: [{ ...permission(), channelIds: ['unknown'] }] }, { permissions: [{ ...permission(), protocols: ['bogus'] }] },
      { permissions: [{ ...permission(), channelIds: [] }] }, { permissions: [{ ...permission(), token_hmac: HMAC }] },
    ].map((caller) => ({ action: 'update', callerId: 'caller-codex', caller })),
  ];
  const preserved = structuredClone(before);
  for (const change of cases) assert.throws(() => reduceCallerChange(before, change, { tokenHmac: HMAC }));
  assert.throws(() => reduceCallerChange(before, { action: 'rotate', callerId: 'caller-codex' }));
  assert.deepEqual(before, preserved);
});

test('HMAC keeps the Go domain separator and every key byte; key and token do not enter snapshots', () => {
  const key = callerHashKey(KEY);
  assert.equal(hashCallerToken(key, 'SYNTHETIC_TOKEN'), '7c521920dbd35de85b1d6978dbacc67b5f41a4bfe90846cc94909607dee77846');
  assert.notEqual(hashCallerToken(key, 'SYNTHETIC_TOKEN'), hashCallerToken(KEY.toString().trim(), 'SYNTHETIC_TOKEN'));
  key.fill(0);
  assert.notDeepEqual(key, KEY);
  const first = issueCallerToken(KEY), second = issueCallerToken(KEY);
  assert.match(first.token, /^sk-motai-[A-Za-z0-9_-]{43}$/);
  assert.notEqual(first.token, second.token);
  assert.equal(hashCallerToken(KEY, first.token), first.tokenHmac);
  assert.match(first.tokenHmac, /^[0-9a-f]{64}$/);
  for (const invalid of [null, undefined, 1, Buffer.alloc(31), Buffer.alloc(4097)]) {
    assert.throws(() => issueCallerToken(invalid), { code: 'caller_hash_key_unavailable', statusCode: 503 });
  }
  assert.equal(callerHashKey(Buffer.alloc(4096)).length, 4096);
});

test('publisher returns a creation token once, keeps it off disk, and replays the same durable identity after restart', async (t) => {
  const { publisher, client, directory, activations } = await publisherFixture(t);
  const input = { baseGen: '1', operationId: randomUUID(), change: { action: 'create', caller: { name: 'Desktop' } } };
  const created = await publisher.callerChange(input);
  assert.equal(created.activated, true);
  assert.match(created.oneTimeToken, /^sk-motai-/);
  const saved = publisher.current.config.callers.find((caller) => caller.id === created.callerId);
  assert.equal(saved.token_hmac, hashCallerToken(KEY, created.oneTimeToken));
  assert.equal(created.config.callers.at(-1).token_hmac, undefined);
  const replay = await publisher.callerChange(input);
  assert.equal(replay.callerId, created.callerId);
  assert.equal(replay.desiredGen, created.desiredGen);
  assert.equal(replay.oneTimeToken, undefined);
  assert.equal(replay.oneTimeTokenUnavailable, true);
  const restored = new ConfigPublisher({ directory, client, callerHashKey: KEY });
  await restored.load();
  const restarted = await restored.callerChange(input);
  assert.equal(restarted.callerId, created.callerId);
  assert.equal(restarted.oneTimeTokenUnavailable, true);
  assert.equal(restarted.oneTimeToken, undefined);
  assert.equal(restored.current.config.callers.length, 2);
  for (const name of await readdir(directory)) {
    const text = await readFile(path.join(directory, name), 'utf8');
    assert(!text.includes(created.oneTimeToken), name);
    assert(!text.includes(KEY.toString()), name);
  }
  assert(!JSON.stringify(publisher.snapshot()).includes(saved.token_hmac));
  assert.equal(activations.length, 4);
});

test('explicit rotation invalidates the previous hash and preserves permissions and subject state', async (t) => {
  const { publisher } = await publisherFixture(t);
  const before = structuredClone(publisher.current.config.callers[0]);
  const input = { baseGen: '1', operationId: randomUUID(), change: { action: 'rotate', callerId: before.id } };
  const result = await publisher.callerChange(input);
  const after = publisher.current.config.callers[0];
  assert.deepEqual(after, { ...before, token_hmac: hashCallerToken(KEY, result.oneTimeToken) });
  assert.notEqual(after.token_hmac, before.token_hmac);
  assert.equal((await publisher.callerChange(input)).oneTimeTokenUnavailable, true);
});

test('caller and channel mutations share one generation queue and operation namespace', async (t) => {
  const { publisher } = await publisherFixture(t);
  const operationId = randomUUID();
  const input = { baseGen: '1', operationId, change: { action: 'disable', callerId: 'caller-codex' } };
  const outcomes = await Promise.allSettled([
    publisher.callerChange(input),
    publisher.change({ baseGen: '1', operationId: randomUUID(), change: { action: 'disable', channelId: '1022' } }),
  ]);
  assert.equal(outcomes.filter((item) => item.status === 'fulfilled').length, 1);
  assert.equal(outcomes.find((item) => item.status === 'rejected').reason.code, 'stale_generation');
  await assert.rejects(publisher.callerChange({ ...input, change: { action: 'enable', callerId: 'caller-codex' } }), { code: 'operation_conflict' });
  await assert.rejects(publisher.change(input), { code: 'operation_conflict' });
  assert.equal((await publisher.callerChange(input)).oneTimeTokenUnavailable, undefined);
});

test('missing caller hash key permits existing edits and rejects token creation without changing generation', async (t) => {
  const { publisher } = await publisherFixture(t, null);
  await publisher.callerChange({ baseGen: '1', operationId: randomUUID(), change: { action: 'disable', callerId: 'caller-codex' } });
  for (const change of [{ action: 'create', caller: { name: 'new' } }, { action: 'rotate', callerId: 'caller-codex' }]) {
    await assert.rejects(publisher.callerChange({ baseGen: '2', operationId: randomUUID(), change }), { code: 'caller_hash_key_unavailable' });
  }
  assert.equal(publisher.current.config.gen, '2');
});

test('simultaneous duplicate creation returns one token and rejects replay after a later edit', async (t) => {
  const { publisher, directory } = await publisherFixture(t);
  const input = { baseGen: '1', operationId: randomUUID(), change: { action: 'create', caller: { name: 'one' } } };
  const [first, second] = await Promise.all([publisher.callerChange(input), publisher.callerChange(input)]);
  assert.equal(first.callerId, second.callerId);
  assert.equal(first.desiredGen, second.desiredGen);
  assert.match(first.oneTimeToken, /^sk-motai-/);
  assert.equal(second.oneTimeToken, undefined);
  assert.equal(second.oneTimeTokenUnavailable, true);
  assert.equal((await readdir(directory)).filter((name) => name.endsWith('.config.json')).length, 2);
  await publisher.callerChange({ baseGen: '2', operationId: randomUUID(), change: { action: 'enable', callerId: first.callerId } });
  await assert.rejects(publisher.callerChange(input), { code: 'operation_conflict' });
  assert.equal(publisher.current.config.gen, '3');
  assert.equal(publisher.current.config.callers.find((caller) => caller.id === first.callerId).enabled, true);
});

test('pending token activation persists one generation and retries without reissuing a token', async (t) => {
  const { publisher, client } = await publisherFixture(t);
  client.activate = async () => { throw new Error('uncertain'); };
  const input = { baseGen: '1', operationId: randomUUID(), change: { action: 'create', caller: { name: 'pending' } } };
  const first = await publisher.callerChange(input);
  assert.equal(first.activated, false);
  assert.match(first.oneTimeToken, /^sk-motai-/);
  const saved = structuredClone(publisher.current.config.callers.at(-1));
  const second = await publisher.callerChange(input);
  assert.equal(second.desiredGen, '2');
  assert.equal(second.oneTimeToken, undefined);
  assert.equal(second.oneTimeTokenUnavailable, true);
  assert.deepEqual(publisher.current.config.callers.at(-1), saved);
  await assert.rejects(publisher.callerChange({ baseGen: '2', operationId: randomUUID(), change: { action: 'rotate', callerId: first.callerId } }), { code: 'stale_generation' });
  assert.equal(publisher.current.config.gen, '2');
});

test('the caller hash key comes from MOTAI_CALLER_HASH_KEY_FILE as raw bytes, else from MOTAI_CALLER_HASH_KEY', async () => {
  const { callerHashKeyFromEnvironment } = await import('../src/gateway/caller-config.js');
  const raw = Buffer.from([0, 255, 10, 32, ...Array(28).fill(7)]);
  const read = (file) => { assert.equal(file, '/config/hmac.key'); return raw; };
  assert.deepEqual(callerHashKeyFromEnvironment({ MOTAI_CALLER_HASH_KEY_FILE: '/config/hmac.key', MOTAI_CALLER_HASH_KEY: 'ignored' }, read), raw);
  assert.equal(callerHashKeyFromEnvironment({ MOTAI_CALLER_HASH_KEY: 'x'.repeat(32) }, read), 'x'.repeat(32));
  assert.equal(callerHashKeyFromEnvironment({}, read), null);
  const missing = () => { throw Object.assign(new Error('nope'), { code: 'ENOENT' }); };
  assert.equal(callerHashKeyFromEnvironment({ MOTAI_CALLER_HASH_KEY_FILE: '/missing' }, missing), null);
});
