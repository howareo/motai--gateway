import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { GatewayControl } from '../src/gateway/control.js';
import { ConfigPublisher } from '../src/gateway/config-publisher.js';
import { GatewayClient } from '../src/gateway/client.js';

const fixture = async (name) => JSON.parse(await readFile(new URL(`../contracts/fixtures/${name}`, import.meta.url)));
const config = await fixture('config-valid.json');
const credentials = await fixture('credentials-valid.json');
const samples = (await fixture('internal-api-samples.json')).samples;

async function setup(t, initialConfig = config) {
  const directory = await mkdtemp(path.join(tmpdir(), 'motai-control-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const state = { committed: null, activationCount: 0, previewCount: 0 };
  const client = {
    status: async () => ({ ...samples.status, committed_gen: state.committed, serving_gen: state.committed }),
    activate: async (input) => {
      state.activationCount += 1;
      state.committed = input.gen;
      return { format_version: 1, ...input, committed_gen: input.gen, serving_gen: input.gen };
    },
    preview: async (request) => { state.previewCount += 1; state.previewRequest = request; return samples.models_response; },
  };
  const publisher = new ConfigPublisher({ directory, client });
  await publisher.publish({ baseGen: null, config: initialConfig, credentials });
  return { directory, publisher, client, state, control: new GatewayControl({ client, publisher }) };
}

test('one draft operation creates one disabled channel across concurrent submission and restart, without leaking secrets', async (t) => {
  const { directory, publisher, client, control, state } = await setup(t);
  const payload = { baseGen: '1', operationId: randomUUID(), change: { action: 'create',
    channel: { name: 'New upstream', poolId: config.pools[0].id, vendor: 'openai', protocol: 'responses',
      baseUrl: 'https://new.invalid/v1', models: ['new-model'], testModel: 'new-model' },
    credentialAction: 'replace', credentialValue: 'CANARY_KEY' } };
  const results = await Promise.all([control.change(payload), control.change(payload)]);
  assert.equal(results[0].channelId, results[1].channelId);
  assert.equal(results[0].desiredGen, '2');
  assert.equal(publisher.current.config.channels.length, 2);
  const channel = results[0].config.channels.find((entry) => entry.id === results[0].channelId);
  assert.equal(channel.enabled, false);
  assert.equal(channel.testModel, 'new-model');
  assert.equal(channel.hasCredential, true);
  assert.equal(JSON.stringify(results).includes('CANARY_KEY'), false);
  const restored = new ConfigPublisher({ directory, client });
  await restored.load();
  const replay = await restored.change(payload);
  assert.equal(replay.channelId, channel.id);
  assert.equal(replay.config.channels.length, 2);
  assert.equal(replay.config.channels.find((entry) => entry.id === channel.id).testModel, 'new-model');
  await assert.rejects(restored.change({ ...payload, change: { ...payload.change, credentialValue: 'OTHER_KEY' } }), { code: 'operation_conflict' });
  assert.equal(state.committed, '2');
  const receipt = await readFile(path.join(directory, `operation-${payload.operationId}.json`), 'utf8');
  assert.equal(receipt.includes('CANARY_KEY'), false);
});

test('a receipt survives a crash before desired publication and recovers the same generated channel', async (t) => {
  const { directory, publisher, client, control, state } = await setup(t);
  const oldPointer = await readFile(path.join(directory, 'desired.json'));
  const payload = { baseGen: '1', operationId: randomUUID(), change: { action: 'create',
    channel: { name: 'Crash fixture', poolId: config.pools[0].id, vendor: 'openai', protocol: 'responses',
      baseUrl: 'https://new.invalid', models: ['new-model'] }, credentialAction: 'replace', credentialValue: 'SYNTHETIC_KEY' } };
  const result = await control.change(payload);
  await writeFile(path.join(directory, 'desired.json'), oldPointer);
  state.committed = '1';
  const restored = new ConfigPublisher({ directory, client });
  await restored.load();
  const recovered = await restored.change(payload);
  assert.equal(recovered.channelId, result.channelId);
  assert.equal(recovered.desiredGen, '2');
  assert.equal(recovered.activated, true);
  assert.equal(restored.current.config.channels.length, publisher.current.config.channels.length);
});

test('orphan generation files and stale pending pointers do not block a later publication', async (t) => {
  const { directory, publisher } = await setup(t);
  await writeFile(path.join(directory, 'gen-2.config.json'), 'orphan');
  await writeFile(path.join(directory, 'desired.pending.json'), 'orphan');
  const result = await publisher.publish({ baseGen: '1', config, credentials });
  assert.equal(result.desiredGen, '3');
  assert.equal(result.activated, true);
  assert.equal((await readdir(directory)).some((entry) => /^desired\.[0-9a-f-]+\.pending\.json$/.test(entry)), false);
  await unlink(path.join(directory, 'desired.pending.json'));
});

test('preview and saving require explicit confirmation before reusing stored credentials at a changed address', async (t) => {
  const { control, publisher, state } = await setup(t);
  const preview = { baseGen: '1', channelId: '1022', baseUrl: 'https://changed.invalid/v1',
    capabilities: ['responses'], credentialAction: 'keep' };
  await assert.rejects(control.preview(preview), { code: 'retained_credential_confirmation_required' });
  assert.equal(state.previewCount, 0);
  await control.preview({ ...preview, confirmRetainedCredential: true });
  assert.equal(state.previewCount, 1);
  const change = { action: 'update', channelId: '1022', channel: { baseUrl: preview.baseUrl }, credentialAction: 'keep' };
  await assert.rejects(control.change({ baseGen: '1', operationId: randomUUID(), change }), { code: 'retained_credential_confirmation_required' });
  assert.equal(publisher.current.config.gen, '1');
  const result = await control.change({ baseGen: '1', operationId: randomUUID(), change: { ...change, confirmRetainedCredential: true } });
  assert.equal(result.activated, true);
  assert.equal(result.config.channels[0].baseUrl, preview.baseUrl);
});

test('model preview keeps the saved adapter, honors a draft override and validates it before any upstream request', async (t) => {
  const initial = structuredClone(config); initial.channels[0].adapter = 'deepseek';
  const { control, state } = await setup(t, initial);
  const preview = { baseGen: '1', channelId: '1022', baseUrl: initial.channels[0].base_url,
    capabilities: ['messages'], credentialAction: 'keep' };
  await control.preview(preview); assert.equal(state.previewRequest.adapter, 'deepseek');
  await control.preview({ ...preview, adapter: 'anthropic' }); assert.equal(state.previewRequest.adapter, 'anthropic');
  await control.preview({ ...preview, adapter: '' }); assert.equal(Object.hasOwn(state.previewRequest, 'adapter'), false);
  for (const adapter of [null, 43, 'unknown']) await assert.rejects(control.preview({ ...preview, adapter }), { code: 'invalid_contract' });
  assert.equal(state.previewCount, 3);
});

test('client rejects reversed time queries before issuing an internal HTTP request', async () => {
  let calls = 0;
  const client = new GatewayClient({ baseUrl: 'http://internal.invalid', managementToken: 'SYNTHETIC',
    fetchImpl: async () => { calls += 1; throw new Error('unexpected'); } });
  await assert.rejects(client.attempts({ ...samples.attempts_query, to: samples.attempts_query.from }), { code: 'invalid_contract' });
  assert.equal(calls, 0);
});

test('health boundary preserves decimal versions, strips additions and rejects duplicate identities', async () => {
  const response = { format_version: 1, gen: '9007199254740993', channels: [{ channel_id: '0001',
    credential_version: '9007199254740994', state: 'exhausted', state_version: '9007199254740995',
    observed_at: '2026-10-27T01:00:00Z', secret: 'CANARY_MUST_NOT_REACH_BROWSER' }] };
  const control = new GatewayControl({ client: { channelHealth: async () => response } });
  const result = await control.channelHealth();
  assert.equal(result.channels[0].channelId, '0001');
  assert.equal(result.channels[0].stateVersion, '9007199254740995');
  assert.equal(JSON.stringify(result).includes('CANARY'), false);
  response.channels.push({ ...response.channels[0] });
  await assert.rejects(control.channelHealth(), { code: 'gateway_invalid_response' });
});

test('health identities and reset requests remain scoped to the actual pool', async () => {
  const response = { format_version: 1, gen: '9', channels: ['a', 'b'].map((pool_id) => ({ channel_id: 'shared', pool_id,
    credential_version: '4', state: 'exhausted', state_version: '8', observed_at: null })) };
  const payload = { baseGen: '9', operationId: randomUUID(), credentialVersion: '4', stateVersion: '8', poolId: 'b' };
  const client = { channelHealth: async () => response, resetHealth: async (id, body) => {
    assert.equal(body.pool_id, 'b');
    return { format_version: 1, operation_id: payload.operationId, channel_id: id, pool_id: 'b',
      credential_version: '4', state: 'available', state_version: '9', changed: true };
  } };
  const control = new GatewayControl({ client });
  assert.deepEqual((await control.channelHealth()).channels.map((row) => row.poolId), ['a', 'b']);
  assert.equal((await control.resetHealth('shared', payload)).poolId, 'b');
  client.resetHealth = async () => ({ format_version: 1, operation_id: payload.operationId, channel_id: 'shared', pool_id: 'a',
    credential_version: '4', state: 'available', state_version: '9', changed: true });
  await assert.rejects(control.resetHealth('shared', payload), { code: 'gateway_invalid_response' });
});

test('health reset forwards exact optimistic identity and operation, and rejects mismatched replies', async () => {
  const payload = { baseGen: '9', operationId: randomUUID(), credentialVersion: '4', stateVersion: '8' };
  let calls = 0;
  const client = { resetHealth: async (id, input) => {
    calls++;
    assert.equal(id, '0001');
    assert.deepEqual(input, { format_version: 1, operation_id: payload.operationId,
      expected_gen: '9', expected_credential_version: '4', expected_state_version: '8' });
    return { format_version: 1, operation_id: payload.operationId, channel_id: id,
      credential_version: '4', state: 'available', state_version: '9', changed: true };
  } };
  const control = new GatewayControl({ client });
  assert.equal((await control.resetHealth('0001', payload)).stateVersion, '9');
  await assert.rejects(control.resetHealth('0001', { ...payload, stateVersion: 8 }), { code: 'invalid_contract', statusCode: 400 });
  await assert.rejects(control.resetHealth('0001', { ...payload, credentialValue: 'CANARY' }), { code: 'invalid_contract' });
  assert.equal(calls, 1);
  client.resetHealth = async () => ({ format_version: 1, operation_id: payload.operationId, channel_id: 'other',
    credential_version: '4', state: 'available', state_version: '9', changed: true });
  await assert.rejects(control.resetHealth('0001', payload), { code: 'gateway_invalid_response' });
});
