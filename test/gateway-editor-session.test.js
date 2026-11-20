import test from 'node:test';
import assert from 'node:assert/strict';
import { createGatewaySession } from '../public/channel-editor/gateway-session.js';

const config = () => ({ gen: '9007199254740993', pools: [{ id: 'pool', name: '明确池' }], models: [{ id: 'Model/Case', vendor: 'explicit' }],
  channels: [{ id: '0001', name: 'Existing', poolId: 'pool', baseUrl: 'https://old.invalid', enabled: true, priority: 10, weight: 0,
    hasCredential: true, testModel: 'Model/Case', models: [{ modelId: 'Model/Case', upstreamModel: 'UPSTREAM/Case', capabilities: ['responses', 'chat_completions'] }] }] });
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const active = { desiredGen: '9007199254740994', servingGen: '9007199254740994', committedGen: '9007199254740994', activated: true };
const existing = (api, onSaved) => { const value = config(); return createGatewaySession({ config: value, channel: value.channels[0], api, onSaved }); };

test('new channel identifies each model vendor automatically without changing the chosen transport', async () => {
  const models = ['gpt-5.6-sol', 'claude-opus-5.5', 'models/gemini-3-pro', 'grok-4.6', 'deepseek-4.1-flash', 'kimi-k2', 'glm-5', 'qwen3', 'mistral-large'];
  const session = createGatewaySession({ config: config(), api: async () => ({
    models: models.map((id) => ({ id, capabilities: ['chat_completions'] })), observedAt: 'now' }) });
  session.edit({ name: 'Mixed', baseUrl: 'https://new.invalid', protocol: 'chat_completions' });
  session.credential('replace', 'SYNTHETIC_KEY');
  await session.discover(); session.select(session.draft.discovered);
  const saved = session.command().change.channel;
  assert.deepEqual(saved.models.map((model) => model.vendor), ['openai', 'anthropic', 'google', 'xai', 'deepseek', 'moonshot', 'zhipu', 'qwen', 'mistral']);
  assert.ok(saved.models.every((model) => model.capabilities.join(',') === 'chat_completions'));
  assert.equal(saved.enabled, false);
});

test('vendor matching preserves configured vendors and uses manual fallback only for unrecognized names', () => {
  const cfg = config(); cfg.models.push({ id: 'claude-custom', vendor: 'configured_vendor' });
  const session = createGatewaySession({ config: cfg, channel: cfg.channels[0] });
  session.select(['claude-custom', 'claude-sonnet-5.5', 'Custom/Alias']);
  assert.throws(() => session.command(), /厂商标识.*Custom\/Alias/);
  session.edit({ vendor: 'manual_vendor' });
  assert.deepEqual(session.command().change.channel.models.map((model) => model.vendor), ['configured_vendor', 'anthropic', 'manual_vendor']);
});

test('adapter edits preserve per-model protocols and require explicit credential confirmation before save', () => {
  const cfg = config(); cfg.channels[0].adapter = 'deepseek';
  const session = createGatewaySession({ config: cfg, channel: cfg.channels[0] });
  session.edit({ name: 'Renamed' });
  assert.equal(session.command().change.channel.adapter, 'deepseek');
  const models = session.command().change.channel.models;
  session.edit({ adapter: 'anthropic' });
  assert.match(session.summary, /上游适配器/);
  assert.throws(() => session.command(), /确认/);
  session.credential('keep', '', true);
  assert.equal(session.command().change.channel.adapter, 'anthropic');
  assert.deepEqual(session.command().change.channel.models, models);
  session.edit({ adapter: '' }); session.credential('keep', '', true);
  assert.equal(session.command().change.channel.adapter, '');
});

test('model discovery sends the explicit draft adapter and can clear a saved adapter to protocol mode', async () => {
  const cfg = config(), calls = []; cfg.channels[0].adapter = 'deepseek';
  const session = createGatewaySession({ config: cfg, channel: cfg.channels[0], api: async (_, input) => {
    calls.push(JSON.parse(input.body)); return { models: [{ id: 'Model/Case', capabilities: ['responses'] }], observedAt: '2026-10-28T00:00:00Z' };
  } });
  await session.discover(); assert.equal(calls[0].adapter, 'deepseek');
  session.edit({ adapter: '' }); session.credential('keep', '', true);
  await session.discover(); assert.equal(calls[1].adapter, '');
});

test('gateway UI01/04: edit keeps opaque IDs, mappings, multi-protocol capability, empty key and generation exact', async () => {
  const calls = [];
  const session = existing(async (path, input) => { calls.push({ path, body: JSON.parse(input.body) }); return active; });
  session.edit({ name: 'Renamed' });
  await session.save();
  const payload = calls[0].body;
  assert.equal(calls[0].path, '/api/gateway/channels/change');
  assert.equal(payload.baseGen, '9007199254740993');
  assert.equal(payload.change.channelId, '0001');
  assert.equal(payload.change.credentialAction, 'keep');
  assert.equal(Object.hasOwn(payload.change, 'credentialValue'), false);
  assert.deepEqual(payload.change.channel.models, [{ modelId: 'Model/Case', upstreamModel: 'UPSTREAM/Case', capabilities: ['responses', 'chat_completions'], vendor: 'explicit' }]);
  assert.equal(session.draft.saveStatus, 'active');
  assert.match(session.summary, /名称/);
});

test('gateway multi-pool edits preserve memberships and untouched priority overrides without changing caller permissions', () => {
  const cfg = config(); cfg.pools.push({ id: 'second', name: '第二池' });
  Object.assign(cfg.channels[0], { poolIds: ['pool', 'second'], poolPriorities: { pool: 20, second: 8 } });
  const session = createGatewaySession({ config: cfg, channel: cfg.channels[0] });
  session.edit({ name: 'Rename only' });
  assert.deepEqual(session.command().change.channel.poolIds, ['pool', 'second']);
  assert.deepEqual(session.command().change.channel.poolPriorities, { pool: 20, second: 8 });
  session.edit({ poolPriorities: { ...session.draft.poolPriorities, second: 99 } });
  const command = session.command();
  assert.equal(command.change.channel.poolId, 'pool');
  assert.deepEqual(command.change.channel.poolPriorities, { pool: 20, second: 99 });
  assert.equal(Object.hasOwn(command.change.channel, 'permissions'), false);
  session.edit({ poolIds: ['second'] });
  assert.throws(() => session.command(), /主分组/);
});

test('gateway UI04: changed target requires explicit keep confirmation for both preview and save; clearing replacement does not bypass it', async () => {
  const calls = [];
  const session = existing(async (path, input) => { calls.push({ path, body: JSON.parse(input.body) }); return path.endsWith('preview')
    ? { models: [{ id: 'Model/Case', capabilities: ['responses'] }], observedAt: 'now' } : active; });
  session.edit({ baseUrl: 'https://new.invalid' });
  await session.discover(); await session.save();
  assert.equal(calls.length, 0);
  session.credential('replace', 'TEMP_SECRET'); session.credential('keep');
  assert.equal(session.draft.credentialConfirmed, false);
  session.credential('keep', '', true);
  await session.discover(); await session.save();
  assert.equal(calls.length, 2);
  assert.equal(calls[0].body.baseUrl, 'https://new.invalid');
  assert.deepEqual(calls[0].body.capabilities, ['responses']);
  assert.equal(calls[0].body.confirmRetainedCredential, true);
  assert.equal(calls[1].body.change.confirmRetainedCredential, true);
  assert.equal(calls[1].body.change.channel.baseUrl, 'https://new.invalid');
  assert.doesNotMatch(JSON.stringify(calls), /TEMP_SECRET/);
});

test('gateway UI02/03: real preview responses keep selection, empty/failure retain catalog and changed connection rejects old result', async () => {
  const waiting = [];
  const session = existing(() => { const pending = deferred(); waiting.push(pending); return pending.promise; });
  const first = session.discover();
  waiting[0].resolve({ models: [{ id: 'Discovered', capabilities: ['messages'] }], observedAt: 'first' }); await first;
  assert.deepEqual(session.draft.selected, ['Model/Case']);
  assert.deepEqual(session.draft.discovered, ['Discovered']);
  const empty = session.discover(); waiting[1].resolve({ models: [], observedAt: 'empty' }); await empty;
  assert.deepEqual(session.draft.discovered, ['Discovered']);
  const failure = session.discover(); waiting[2].reject(new Error('Key 无效')); await failure;
  assert.deepEqual(session.draft.selected, ['Model/Case']);
  assert.deepEqual(session.draft.discovered, ['Discovered']);
  const stale = session.discover(); session.edit({ baseUrl: 'https://changed.invalid' });
  waiting[3].resolve({ models: [{ id: 'stale', capabilities: ['messages'] }] }); await stale;
  assert.deepEqual(session.draft.discovered, []);
});

test('gateway UI01/02: create sends disabled explicit vendor/protocol and never adds permissions', async () => {
  const calls = [];
  const session = createGatewaySession({ config: config(), api: async (path, input) => { calls.push(JSON.parse(input.body)); return active; } });
  session.edit({ name: 'New', baseUrl: 'https://new.invalid', vendor: 'custom', protocol: 'messages' });
  session.select('New/Case,New/case'); session.edit({ testModel: 'New/Case' }); session.credential('replace', 'SYNTHETIC_KEY');
  await session.save();
  assert.equal(calls[0].change.channel.enabled, false);
  assert.deepEqual(calls[0].change.channel.models.map((model) => [model.modelId, model.vendor, model.capabilities]), [
    ['New/Case', 'custom', ['messages']], ['New/case', 'custom', ['messages']] ]);
  assert.equal(calls[0].change.credentialValue, 'SYNTHETIC_KEY');
  assert.equal(Object.hasOwn(calls[0].change.channel, 'permissions'), false);
  assert.match(calls[0].operationId, /^[0-9a-f-]{36}$/);
});

test('gateway UI05: rapid save submits once; 202 remains pending, locks edits and reconcile checks serving before active', async () => {
  const pending = deferred(), calls = [];
  const session = existing(async (path, input) => { calls.push({ path, input }); return path.endsWith('reconcile') ? active : pending.promise; });
  session.edit({ name: 'Pending' });
  const first = session.save(); await session.save();
  assert.equal(calls.length, 1);
  pending.resolve({ ...active, activated: false, servingGen: '9007199254740993' }); await first;
  assert.equal(session.draft.saveStatus, 'pending');
  session.edit({ name: 'Should stay locked' }); session.credential('replace', 'NO'); session.select(['NO']);
  assert.equal(session.draft.name, 'Pending');
  assert.deepEqual(session.draft.selected, ['Model/Case']);
  await session.save(); assert.equal(calls.length, 1);
  await session.reconcile();
  assert.equal(calls[1].path, '/api/gateway/reconcile');
  assert.equal(calls[1].input.body, undefined);
  assert.equal(session.draft.saveStatus, 'active');
});

test('gateway UI05: timeout retries identical operation/body and retains draft, 409 leaves correctable error without duplicate success', async () => {
  const calls = [];
  const session = existing(async (path, input) => { calls.push(input.body); if (calls.length === 1) throw new Error('网络超时'); return active; });
  session.edit({ name: 'Once' });
  await session.save(); assert.equal(session.draft.saveStatus, 'unknown');
  session.edit({ name: 'Blocked after timeout' });
  assert.equal(session.draft.name, 'Once');
  await session.save();
  assert.equal(calls[0], calls[1]);
  assert.equal(session.draft.saveStatus, 'active');
  const conflict = existing(async () => { throw Object.assign(new Error('stale'), { status: 409 }); });
  conflict.edit({ name: 'Preserved' }); await conflict.save();
  assert.equal(conflict.draft.saveStatus, 'failed');
  assert.equal(conflict.draft.name, 'Preserved');
  assert.match(conflict.draft.error, /重新打开/);
});

test('gateway UI04: clear only saves disabled and never puts literal placeholder/old secret into payload', async () => {
  const calls = [];
  const session = existing(async (path, input) => { calls.push(JSON.parse(input.body)); return active; });
  session.credential('clear'); await session.save(); assert.equal(calls.length, 0);
  session.edit({ enabled: false }); await session.save();
  assert.equal(calls[0].change.credentialAction, 'clear');
  assert.equal(Object.hasOwn(calls[0].change, 'credentialValue'), false);
});

test('gateway UI01/03: close cancels local effects, clears secrets and cannot update another editor after response', async () => {
  const pending = deferred(); let published = 0;
  const session = existing(() => pending.promise, () => published++);
  session.credential('replace', 'MEMORY_ONLY_SECRET');
  const save = session.save(); session.close(); pending.resolve(active); await save;
  assert.equal(session.draft.closed, true);
  assert.equal(session.draft.credentialValue, '');
  assert.deepEqual(session.draft.selected, []);
  assert.equal(published, 0);
});

test('gateway validation rejects unknown vendor and an explicit detection model outside the selection without any API call; empty defaults to the first model', async () => {
  let calls = 0; const bodies = [];
  const session = existing(async (_, input) => { calls++; bodies.push(JSON.parse(input.body)); return active; });
  session.select(['Unknown']);
  await session.save(); assert.equal(calls, 0); assert.match(session.draft.error, /厂商标识/, 'an empty detection model no longer blocks; the vendor check is what stops it');
  session.edit({ testModel: 'Elsewhere' });
  await session.save(); assert.equal(calls, 0); assert.match(session.draft.error, /检测模型/);
  session.edit({ testModel: 'Unknown' });
  await session.save(); assert.equal(calls, 0); assert.match(session.draft.error, /厂商标识/);
  session.edit({ vendor: 'explicit' });
  await session.save(); assert.equal(calls, 1);
  const defaulted = existing(async (_, input) => { bodies.push(JSON.parse(input.body)); return active; });
  defaulted.select(['Other/One', 'Other/Two']); defaulted.edit({ vendor: 'explicit' });
  assert.equal(defaulted.draft.testModel, '', 'replacing the selection clears the previous detection model');
  const before = bodies.length; await defaulted.save();
  assert.equal(bodies.length, before + 1, 'an empty detection model does not block the save');
  assert.equal(bodies.at(-1).change.channel.testModel, 'Other/One', 'the payload carries the effective default, not an empty string');
});
