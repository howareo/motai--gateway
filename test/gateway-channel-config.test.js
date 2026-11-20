import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { reduceChannelChange } from '../src/gateway/channel-config.js';
import { validateConfig } from '../src/gateway/schema.js';
import { publicGatewayConfig } from '../src/gateway/config-publisher.js';

const fixture = (name) => JSON.parse(readFileSync(new URL(`../contracts/fixtures/${name}-valid.json`, import.meta.url), 'utf8'));
const snapshot = () => ({ config: fixture('config'), credentials: fixture('credentials') });
const creation = (channel = {}) => ({ action: 'create', credentialAction: 'replace', credentialValue: 'SYNTHETIC_NEW_SECRET',
  channel: { name: 'New synthetic', poolId: 'pool-main', baseUrl: 'https://new.invalid',
    models: ['New/Case-ID'], vendor: 'explicit_vendor', protocol: 'messages', ...channel } });
const valid = (result) => assert.equal(validateConfig(result.config, { credentials: result.credentials }).valid, true);

test('custom pools publish atomically with channel creation or membership edits without granting caller access', () => {
  for (const action of ['create', 'update']) {
    const before = snapshot(), copy = structuredClone(before);
    const newPools = [{ id: 'custom-pool', name: '我的 Kimi' }];
    const change = action === 'create' ? creation({ poolId: 'custom-pool' })
      : { action: 'update', channelId: before.config.channels[0].id, channel: { poolIds: ['pool-main', 'custom-pool'] } };
    const result = reduceChannelChange(before, { ...change, newPools });
    assert.deepEqual(result.config.pools.at(-1), newPools[0]);
    assert.deepEqual(result.config.callers, before.config.callers);
    const channel = result.config.channels.find((row) => row.id === result.channelId);
    assert.ok((channel.pool_ids || [channel.pool_id]).includes('custom-pool'));
    assert.deepEqual(before, copy); valid(result);
  }
});

test('custom pool validation rejects duplicate, unused and malformed groups without mutating the snapshot', () => {
  const before = snapshot(), copy = structuredClone(before);
  for (const newPools of [null, {}, [null], [{ id: 'custom-pool', name: '' }],
    [{ id: 'custom-pool', name: 'x'.repeat(121) }], [{ id: 'bad id', name: 'Bad' }],
    [{ id: 'custom-pool', name: ' Custom ' }], [{ id: 'custom-pool', name: 'Custom', extra: true }],
    [{ id: 'unused', name: 'Unused' }], [{ id: 'pool-main', name: 'New name' }],
    [{ id: 'custom-pool', name: before.config.pools[0].name.toUpperCase() }],
    [{ id: 'custom-pool', name: 'Custom' }, { id: 'another', name: 'custom' }]]) {
    assert.throws(() => reduceChannelChange(before, { ...creation({ poolId: 'custom-pool', poolIds: ['custom-pool', 'another'] }), newPools }));
    assert.deepEqual(before, copy);
  }
  assert.throws(() => reduceChannelChange(before, { action: 'disable', channelId: before.config.channels[0].id, newPools: [] }), { code: 'unexpected_channel_fields' });
  assert.throws(() => reduceChannelChange(before, { ...creation({ poolIds: 42 }), newPools: [{ id: 'custom-pool', name: 'Custom' }] }), { code: 'invalid_new_pool' });
});

test('explicit upstream adapters survive edits and the public snapshot; only an explicit empty choice removes one', () => {
  for (const adapter of ['openai', 'anthropic', 'deepseek', 'xai', 'gemini', 'moonshot']) {
    const created = reduceChannelChange(snapshot(), creation({ adapter }));
    assert.equal(created.config.channels.at(-1).adapter, adapter); valid(created);
  }
  const before = snapshot(); before.config.channels[0].adapter = 'deepseek';
  const channelId = before.config.channels[0].id;
  const kept = reduceChannelChange(before, { action: 'update', channelId, channel: { name: 'Renamed' } });
  assert.equal(kept.config.channels[0].adapter, 'deepseek');
  assert.equal(publicGatewayConfig(kept.config, () => true).channels[0].adapter, 'deepseek');
  const removed = reduceChannelChange(kept, { action: 'update', channelId, channel: { adapter: '' } });
  assert.equal(Object.hasOwn(removed.config.channels[0], 'adapter'), false); valid(removed);
  assert.throws(() => reduceChannelChange(before, { action: 'update', channelId, channel: { adapter: 'unknown' } }));
  assert.deepEqual(before.config.channels[0].adapter, 'deepseek');
});

test('one channel joins multiple pools without credentials or permission copies, and primary changes only the named pool', () => {
  const before = snapshot();
  before.config.pools.push({ id: 'pool-second', name: 'Second' });
  const target = before.config.channels[0];
  target.pool_ids = ['pool-main', 'pool-second'];
  before.config.channels.push({ ...structuredClone(target), id: 'peer', priority: 50 });
  assert.throws(() => reduceChannelChange(before, { action: 'primary', channelId: target.id }), { code: 'primary_pool_required' });
  const result = reduceChannelChange(before, { action: 'primary', channelId: target.id, poolId: 'pool-second' });
  assert.equal(result.config.channels[0].priority, 27);
  assert.deepEqual(result.config.channels[0].pool_priorities, { 'pool-second': 2 });
  assert.deepEqual(result.config.channels[1], { ...before.config.channels[1], pool_priorities: { 'pool-second': 1 } });
  assert.deepEqual(result.config.callers, before.config.callers);
  assert.deepEqual(result.credentials, before.credentials);
  assert.deepEqual(reduceChannelChange(result, { action: 'primary', channelId: target.id, poolId: 'pool-second' }).config, result.config);
  const added = reduceChannelChange(before, creation({ poolIds: ['pool-main', 'pool-second'], poolPriorities: { 'pool-second': 7 } }));
  assert.deepEqual(added.config.channels.at(-1).pool_ids, ['pool-main', 'pool-second']);
  assert.deepEqual(added.config.channels.at(-1).pool_priorities, { 'pool-main': 1, 'pool-second': 1 });
  assert.equal(added.config.channels.length, 3);
  assert.equal(added.credentials.entries.length, 2);
  valid(result); valid(added);
});

test('manual primary promotion ranks above disabled channels and leaves other pools unchanged', () => {
  for (const poolId of ['claude', 'pool-main']) {
    const before = snapshot();
    if (poolId === 'claude') before.config.pools.push({ id: poolId, name: 'Claude' });
    const target = before.config.channels[0];
    if (poolId === 'claude') target.pool_ids = ['pool-main', 'claude'];
    target.enabled = true;
    target.priority = 10;
    before.config.channels.push({ ...structuredClone(target), id: 'old-primary', priority: 100, enabled: false });
    const result = reduceChannelChange(before, { action: 'primary', channelId: target.id, poolId });
    const selected = result.config.channels[0];
    assert.equal(selected.pool_priorities[poolId], 2);
    assert.equal(selected.priority, 10);
    assert.deepEqual(result.config.channels[1], { ...before.config.channels[1], pool_priorities: { [poolId]: 1 } });
    assert.deepEqual(result.credentials, before.credentials);
  }
});

test('create maps explicit DTO fields, generates UUIDs, defaults disabled and never grants caller permissions', () => {
  const before = snapshot(), preserved = structuredClone(before);
  const result = reduceChannelChange(before, creation({ testModel: 'New/Case-ID' }));
  const added = result.config.channels.at(-1);
  assert.match(added.id, /^[0-9a-f-]{36}$/);
  assert.equal(result.channelId, added.id);
  assert.equal(added.enabled, false);
  assert.equal(added.pool_id, 'pool-main');
  assert.equal(added.credential_version, '1');
  assert.deepEqual(added.models, [{ model_id: 'New/Case-ID', upstream_model: 'New/Case-ID', capabilities: ['messages'] }]);
  assert.deepEqual(result.config.models.at(-1), { id: 'New/Case-ID', vendor: 'explicit_vendor' });
  assert.deepEqual(result.config.callers, before.config.callers);
  assert.deepEqual(result.metadataPatch, { channelId: added.id, testModel: 'New/Case-ID' });
  assert.equal(Object.hasOwn(added, 'testModel'), false);
  assert.equal(result.config.gen, before.config.gen, 'publisher alone advances the generation');
  assert.equal(result.credentials.entries.at(-1).secret, 'SYNTHETIC_NEW_SECRET');
  assert.deepEqual(before, preserved, 'a pure reduction cannot mutate input snapshots');
  valid(result);
});

test('update preserves opaque IDs, existing credential and per-model capabilities unless explicitly changed', () => {
  const before = snapshot();
  before.config.channels[0].id = '0001022';
  before.config.callers[0].permissions[0].channel_ids = ['0001022'];
  const result = reduceChannelChange(before, { action: 'update', channelId: '0001022', credentialAction: 'keep', confirmRetainedCredential: true,
    channel: { name: 'Renamed', baseUrl: 'https://changed.invalid/v1' } });
  assert.equal(result.config.channels[0].id, '0001022');
  assert.equal(result.config.channels[0].base_url, 'https://changed.invalid/v1');
  assert.deepEqual(result.config.channels[0].models, before.config.channels[0].models);
  assert.deepEqual(result.credentials, before.credentials);
  assert.deepEqual(result.config.callers, before.config.callers);
  valid(result);
});

test('replace increments decimal version exactly and preserves a credential shared by another channel', () => {
  const before = snapshot();
  before.config.channels[0].credential_version = '9007199254740993';
  before.credentials.entries[0].credential_version = '9007199254740993';
  before.config.channels.push({ ...structuredClone(before.config.channels[0]), id: 'second' });
  const result = reduceChannelChange(before, { action: 'update', channelId: '1022', channel: {}, credentialAction: 'replace', credentialValue: 'SYNTHETIC_REPLACED_SECRET' });
  assert.equal(result.config.channels[0].credential_version, '9007199254740994');
  assert.equal(result.config.channels[1].credential_version, '9007199254740993');
  assert.deepEqual(result.credentials.entries.map((entry) => entry.credential_version), ['9007199254740993', '9007199254740994']);
  assert.equal(before.credentials.entries.length, 1);
  valid(result);
});

test('clear requires a disabled channel, uses paired null references, removes unused secret and blocks enable until replace', () => {
  const before = snapshot();
  assert.throws(() => reduceChannelChange(before, { action: 'update', channelId: '1022', channel: {}, credentialAction: 'clear' }), { code: 'credential_clear_requires_disabled' });
  const cleared = reduceChannelChange(before, { action: 'update', channelId: '1022', channel: { enabled: false }, credentialAction: 'clear' });
  assert.equal(cleared.config.channels[0].credential_ref, null);
  assert.equal(cleared.config.channels[0].credential_version, null);
  assert.deepEqual(cleared.credentials.entries, []);
  valid(cleared);
  assert.throws(() => reduceChannelChange(cleared, { action: 'enable', channelId: '1022' }), { code: 'invalid_channel_config' });
  const replaced = reduceChannelChange(cleared, { action: 'update', channelId: '1022', channel: {}, credentialAction: 'replace', credentialValue: 'SYNTHETIC_RESTORED_SECRET' });
  assert.equal(replaced.config.channels[0].credential_version, '1');
  const enabled = reduceChannelChange(replaced, { action: 'enable', channelId: '1022' });
  assert.equal(enabled.config.channels[0].enabled, true);
  valid(enabled);
});

test('enable/disable only changes availability and preserves the caller restrictions byte-for-byte', () => {
  const before = snapshot();
  const disabled = reduceChannelChange(before, { action: 'disable', channelId: '1022' });
  assert.equal(disabled.config.channels[0].enabled, false);
  const enabled = reduceChannelChange(disabled, { action: 'enable', channelId: '1022' });
  assert.deepEqual(enabled.config.channels[0], { ...before.config.channels[0], pool_priorities: { 'pool-main': 1 } });
  assert.deepEqual(enabled.config.callers, before.config.callers);
  assert.deepEqual(enabled.credentials, before.credentials);
  valid(disabled); valid(enabled);
});

test('delete removes only the channel, its unused secret, unreachable aliases and exact permission references', () => {
  const before = snapshot();
  const result = reduceChannelChange(before, { action: 'delete', channelId: '1022' });
  assert.deepEqual(result.config.channels, []);
  assert.deepEqual(result.credentials.entries, []);
  assert.deepEqual(result.config.aliases, []);
  assert.deepEqual(result.config.callers[0].permissions, []);
  assert.deepEqual(result.config.models, before.config.models, 'historical canonical model identity remains');
  assert.equal(result.permissionChanges[0].callerId, 'caller-codex');
  assert.equal(result.permissionChanges[0].removedChannelId, '1022');
  const original = before.config.callers[0].permissions[0];
  assert.deepEqual(result.permissionChanges[0].removedPermissions, [{ poolId: original.pool_id, modelIds: original.model_ids,
    channelIds: original.channel_ids, protocols: original.protocols, groups: original.groups }]);
  valid(result);
});

test('delete retains remaining permission model/protocol restrictions even when currently unreachable', () => {
  const before = snapshot();
  before.config.models.push({ id: 'Other', vendor: 'other' });
  before.config.channels.push({ ...structuredClone(before.config.channels[0]), id: 'second',
    models: [{ model_id: 'Other', upstream_model: 'Other', capabilities: ['messages'] }] });
  before.config.callers[0].permissions[0].channel_ids.push('second');
  const result = reduceChannelChange(before, { action: 'delete', channelId: '1022' });
  const remaining = result.config.callers[0].permissions[0];
  assert.deepEqual(remaining.channel_ids, ['second']);
  assert.deepEqual(remaining.model_ids, ['Model/Case-Sensitive']);
  assert.deepEqual(remaining.protocols, ['responses']);
  assert.equal(result.credentials.entries.length, 1, 'a still-referenced secret must survive');
  valid(result);
});

test('primary moves the enabled target to first without priority overflow and is idempotent', () => {
  const before = snapshot();
  before.config.channels.push({ ...structuredClone(before.config.channels[0]), id: 'second', priority: 50 });
  before.config.pools.push({ id: 'unrelated', name: 'Other' });
  before.config.channels.push({ ...structuredClone(before.config.channels[0]), id: 'unrelated', pool_id: 'unrelated', priority: 99 });
  const result = reduceChannelChange(before, { action: 'primary', channelId: '1022' });
  assert.deepEqual(result.config.channels.map((channel) => channel.pool_priorities?.['pool-main']), [2, 1, undefined]);
  assert.deepEqual(result.config.channels[2], before.config.channels[2]);
  assert.deepEqual(result.config.callers, before.config.callers);
  assert.deepEqual(reduceChannelChange(result, { action: 'primary', channelId: '1022' }).config, result.config);
  before.config.channels[0].enabled = false;
  assert.throws(() => reduceChannelChange(before, { action: 'primary', channelId: '1022' }), { code: 'primary_requires_enabled' });
  before.config.channels[0].enabled = true;
  before.config.channels[1].priority = 2147483647;
  assert.deepEqual(reduceChannelChange(before, { action: 'primary', channelId: '1022' }).config.channels
    .slice(0, 2).map((channel) => channel.pool_priorities['pool-main']), [2, 1]);
});

test('reorder chooses the exact second channel, shifts its peers and isolates other memberships', () => {
  const before = snapshot();
  before.config.pools.push({ id: 'other', name: 'Other' });
  const template = before.config.channels[0];
  before.config.channels = ['first', 'second', 'third', 'fourth'].map((id, index) => ({
    ...structuredClone(template), id, priority: 40 - index * 10, weight: index === 1 ? 1000000 : 0,
    pool_ids: ['pool-main', 'other'], pool_priorities: { other: index }, enabled: index !== 2,
  }));
  before.config.callers[0].permissions[0].channel_ids = ['*'];
  const saved = structuredClone(before);
  const result = reduceChannelChange(before, { action: 'reorder', channelId: 'fourth', poolId: 'pool-main', position: 2 });
  assert.deepEqual(result.config.channels.map((channel) => channel.pool_priorities['pool-main']), [4, 2, 1, 3]);
  assert.deepEqual(result.config.channels.map((channel) => channel.pool_priorities.other), [0, 1, 2, 3]);
  assert.deepEqual(result.config.channels.map((channel) => channel.weight), [0, 1000000, 0, 0]);
  assert.deepEqual(result.credentials, before.credentials);
  assert.deepEqual(result.config.callers, before.config.callers);
  assert.deepEqual(before, saved);
  assert.deepEqual(reduceChannelChange(result, { action: 'reorder', channelId: 'fourth', poolId: 'pool-main', position: 2 }).config, result.config);
  const last = reduceChannelChange(result, { action: 'reorder', channelId: 'fourth', poolId: 'pool-main', position: 4 });
  assert.deepEqual(last.config.channels.map((channel) => channel.pool_priorities['pool-main']), [4, 3, 2, 1]);
  valid(result); valid(last);
});

test('reorder rejects missing, fractional, coercible and out-of-range positions without changing the snapshot', () => {
  const before = snapshot(), saved = structuredClone(before);
  for (const position of [undefined, 0, -1, 1.5, '1', 2]) {
    assert.throws(() => reduceChannelChange(before, { action: 'reorder', channelId: '1022', position }), { code: 'invalid_channel_position' });
  }
  assert.throws(() => reduceChannelChange(before, { action: 'reorder', channelId: '1022', position: 1, poolId: 'foreign' }), { code: 'primary_pool_required' });
  assert.throws(() => reduceChannelChange(before, { action: 'disable', channelId: '1022', position: 1 }), { code: 'unexpected_channel_fields' });
  assert.deepEqual(before, saved);
});

test('a newly joined group appends the channel and leaves its existing group order intact', () => {
  const before = snapshot();
  before.config.pools.push({ id: 'other', name: 'Other' });
  before.config.channels[0].pool_priorities = { 'pool-main': 5 };
  before.config.channels.push({ ...structuredClone(before.config.channels[0]), id: 'peer', pool_id: 'other', pool_priorities: { other: 0 } });
  const result = reduceChannelChange(before, { action: 'update', channelId: '1022',
    channel: { poolIds: ['pool-main', 'other'], poolPriorities: { 'pool-main': 5, other: 999 } } });
  assert.deepEqual(result.config.channels[0].pool_priorities, { 'pool-main': 5, other: 1 });
  assert.deepEqual(result.config.channels[1].pool_priorities, { other: 2 });
  valid(result);
});

test('explicit structured model mappings and aliases preserve case and do not infer vendor from names', () => {
  const result = reduceChannelChange(snapshot(), creation({ vendor: undefined, protocol: undefined,
    models: [{ modelId: 'GPT/Case', upstreamModel: 'provider/Exact', capabilities: ['messages', 'count_tokens'], vendor: 'custom' }],
    aliases: [{ alias: 'user-facing', modelId: 'GPT/Case' }] }));
  assert.deepEqual(result.config.channels.at(-1).models, [{ model_id: 'GPT/Case', upstream_model: 'provider/Exact', capabilities: ['messages', 'count_tokens'] }]);
  assert.deepEqual(result.config.models.at(-1), { id: 'GPT/Case', vendor: 'custom' });
  assert.deepEqual(result.config.aliases.at(-1), { alias: 'user-facing', model_id: 'GPT/Case', pool_id: 'pool-main' });
  valid(result);
});

test('invalid fields, secrets, vendors, alias targets, protocols, IDs and cross-pool permissions are rejected without mutation', () => {
  const commands = [
    { ...creation(), channelId: 'supplied' },
    { ...creation(), credentialAction: 'keep' },
    { ...creation(), credentialValue: '' },
    creation({ enabled: true }),
    creation({ models: ['Unknown'], vendor: undefined }),
    creation({ protocol: 'invented' }),
    creation({ aliases: [{ alias: 'bad', modelId: 'not-selected' }] }),
    creation({ testModel: 'not-selected' }),
    creation({ testModel: null }),
    creation({ models: ['space in model'] }),
    { action: 'update', channelId: 1022, channel: {} },
    { action: 'update', channelId: 'missing', channel: {} },
    { action: 'update', channelId: '1022', channel: { secret: 'SENSITIVE_CANARY' } },
    { action: 'update', channelId: '1022', channel: {}, credentialAction: 'keep', credentialValue: 'SENSITIVE_CANARY' },
    { action: 'update', channelId: '1022', channel: { models: ['Model/Case-Sensitive'], vendor: 'wrong', protocol: 'responses' } },
    { action: 'enable', channelId: '1022', channel: {} },
  ];
  for (const command of commands) {
    const before = snapshot(), copy = structuredClone(before);
    assert.throws(() => reduceChannelChange(before, command), (error) => {
      assert.equal(typeof error.code, 'string');
      assert.doesNotMatch(JSON.stringify(error), /SENSITIVE_CANARY/);
      return true;
    });
    assert.deepEqual(before, copy);
  }
  const before = snapshot();
  before.config.pools.push({ id: 'other-pool', name: 'Other' });
  assert.throws(() => reduceChannelChange(before, { action: 'update', channelId: '1022', channel: { poolId: 'other-pool' } }), { code: 'channel_permission_conflict' });
});
