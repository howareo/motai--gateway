import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ConfigPublisher } from '../src/gateway/config-publisher.js';
import { GatewayControl } from '../src/gateway/control.js';
import { GatewayClient, GatewayError } from '../src/gateway/client.js';

const config = JSON.parse(await readFile(new URL('../contracts/fixtures/config-valid.json', import.meta.url)));
const credentials = JSON.parse(await readFile(new URL('../contracts/fixtures/credentials-valid.json', import.meta.url)));
const samples = JSON.parse(await readFile(new URL('../contracts/fixtures/internal-api-samples.json', import.meta.url))).samples;
const KEY = Buffer.from('SYNTHETIC-CALLER-KEY-0123456789abcdef\n');
const change = () => ({ baseGen: '1', operationId: randomUUID(), change: { action: 'disable', channelId: '1022' } });

async function setup(t, { directorySync, realClient = false } = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), 'motai-publisher-recovery-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const state = { committed: null, serving: null, rejection: null, statusError: false, calls: [], syncs: 0 };
  const client = realClient ? new GatewayClient({ baseUrl: 'http://motai-internal:3002', managementToken: 'SYNTHETIC-MANAGEMENT-TOKEN',
    fetchImpl: async (url, options) => {
      if (url.pathname === '/internal/v1/status') return Response.json({ ...samples.status,
        committed_gen: state.committed, serving_gen: state.serving });
      assert.equal(url.pathname, '/internal/v1/activate');
      assert.equal(options.method, 'POST');
      const input = JSON.parse(options.body);
      state.calls.push({ ...input, syncs: state.syncs });
      if (state.rejection) return Response.json({ ...samples.error_response, error: {
        ...samples.error_response.error, code: state.rejection.code, retryable: false,
        message: 'CANARY-UPSTREAM-SECRET private configuration path',
      } }, { status: state.rejection.statusCode });
      state.committed = state.serving = input.gen;
      return Response.json({ ...samples.activate_response, gen: input.gen, manifest_sha256: input.manifest_sha256,
        serving_gen: input.gen, committed_gen: input.gen });
    } }) : {
    status: async () => {
      if (state.statusError) throw new GatewayError('gateway_unavailable');
      return { ...samples.status, committed_gen: state.committed, serving_gen: state.serving };
    },
    activate: async (input) => {
      state.calls.push({ ...input, syncs: state.syncs });
      if (state.rejection) throw state.rejection;
      state.committed = state.serving = input.gen;
      return { ...input, serving_gen: input.gen, committed_gen: input.gen };
    },
  };
  const options = { directory, client, callerHashKey: KEY, directorySync: async () => {
    state.syncs++;
    await directorySync?.(directory, state);
  } };
  const publisher = new ConfigPublisher(options);
  await publisher.publish({ baseGen: null, config, credentials });
  const control = new GatewayControl({ publisher, client });
  return { directory, publisher, client, state, options, control };
}

const identity = (result) => ({ gen: result.desiredGen, manifestSha256: result.desiredManifestSha256 });
const desired = async (directory) => JSON.parse(await readFile(path.join(directory, 'desired.json')));

test('real GatewayClient invalid_config/400 rejection permits fresh same-candidate discard and keeps old operations dead', async (t) => {
  const { directory, publisher, client, state, options, control } = await setup(t, { realClient: true });
  state.rejection = { code: 'invalid_config', statusCode: 400 };
  await assert.rejects(client.activate(samples.activate_request), (error) => {
    assert.ok(error instanceof GatewayError);
    assert.equal(error.code, 'invalid_config');
    assert.equal(error.statusCode, 400);
    assert.equal(error.retryable, false);
    assert.equal(error.message, '网关拒绝了待生效配置');
    assert.equal(error.message.includes('CANARY'), false);
    return true;
  });
  const input = change(), pending = await control.change(input);
  assert.equal(pending.activated, false);
  assert.equal(pending.activationErrorCode, 'invalid_config');
  assert.equal(pending.discardAvailable, true);
  assert.equal(JSON.stringify(pending).includes('CANARY'), false);
  const activations = state.calls.length;
  const discarded = await control.discard(identity(pending));
  assert.equal(state.calls.length, activations + 1);
  assert.equal(state.calls.at(-1).gen, pending.desiredGen);
  assert.equal(state.calls.at(-1).manifest_sha256, pending.desiredManifestSha256);
  assert.equal(state.calls.at(-1).base_committed_gen, '1');
  assert.equal(discarded.discardedGen, '2');
  assert.equal(discarded.activated, true);
  assert.equal((await desired(directory)).gen, '1');
  assert.equal(publisher.current.config.gen, '1');
  assert.deepEqual([state.committed, state.serving], ['1', '1']);
  assert.equal(JSON.parse(await readFile(path.join(directory, 'gen-2.abandoned.json'))).manifestSha256, pending.desiredManifestSha256);
  await assert.rejects(control.change(input), { code: 'operation_conflict', statusCode: 409 });
  const restored = new ConfigPublisher(options);
  assert.equal((await restored.load()).gen, '1');
  await assert.rejects(restored.change(input), { code: 'operation_conflict', statusCode: 409 });
});

test('real GatewayClient keeps invalid_config 503/409 and unknown 400 candidates pending after a historical valid rejection', async (t) => {
  for (const rejection of [{ code: 'invalid_config', statusCode: 503 }, { code: 'invalid_config', statusCode: 409 },
    { code: 'unknown_rejection', statusCode: 400 }]) {
    await t.test(`${rejection.code}-${rejection.statusCode}`, async (t) => {
      const { directory, publisher, state } = await setup(t, { realClient: true });
      state.rejection = { code: 'invalid_config', statusCode: 400 };
      const pending = await publisher.change(change());
      assert.equal(pending.discardAvailable, true);
      state.rejection = rejection;
      await assert.rejects(publisher.discardDesired(identity(pending)), { code: 'discard_not_confirmed', statusCode: 409 });
      assert.equal((await publisher.status()).discardAvailable, false);
      assert.equal((await desired(directory)).gen, '2');
      assert.deepEqual([state.committed, state.serving], ['1', '1']);
      assert.equal((await readdir(directory)).some((name) => name.endsWith('.abandoned.json')), false);
    });
  }
});

test('fresh deterministic rejection can be discarded, old channel operation stays dead and next generation skips it', async (t) => {
  const { directory, publisher, state, options, control } = await setup(t);
  state.rejection = new GatewayError('invalid_contract', 400);
  const input = change(), pending = await control.change(input);
  assert.equal(pending.discardAvailable, true);
  assert.equal(pending.desiredGen, '2');
  assert.equal((await control.status()).desiredManifestSha256, pending.desiredManifestSha256);
  const activations = state.calls.length;
  const result = await control.discard(identity(pending));
  assert.equal(state.calls.length, activations + 1, 'discard obtains a fresh rejection for this exact gen/hash');
  assert.deepEqual(state.calls.at(-1).manifest_sha256, pending.desiredManifestSha256);
  assert.equal(result.discardedGen, '2');
  assert.equal(result.activated, true);
  assert.equal(publisher.current.config.gen, '1');
  assert.equal((await desired(directory)).gen, '1');
  assert.equal(JSON.parse(await readFile(path.join(directory, 'gen-2.abandoned.json'))).manifestSha256, pending.desiredManifestSha256);
  await assert.rejects(control.change(input), { code: 'operation_conflict', statusCode: 409 });
  const restored = new ConfigPublisher(options); assert.equal((await restored.load()).gen, '1');
  await assert.rejects(restored.change(input), { code: 'operation_conflict' });
  state.rejection = null;
  const next = await restored.change(change());
  assert.equal(next.desiredGen, '3');
  assert.equal(next.activated, true);
  await assert.rejects(restored.change(input), { code: 'operation_conflict' });
});

test('discarded caller issue returns its token only once and never resurrects it after restart', async (t) => {
  const { directory, publisher, state, options } = await setup(t);
  state.rejection = new GatewayError('invalid_contract', 400);
  const input = { baseGen: '1', operationId: randomUUID(), change: { action: 'create', caller: { name: 'rejected token' } } };
  const first = await publisher.callerChange(input);
  assert.match(first.oneTimeToken, /^sk-motai-/);
  const replay = await publisher.callerChange(input);
  assert.equal(replay.oneTimeToken, undefined); assert.equal(replay.oneTimeTokenUnavailable, true);
  const discarded = await publisher.discardDesired(identity(first));
  assert.equal(discarded.oneTimeToken, undefined);
  assert.equal(discarded.config.callers.some((row) => row.id === first.callerId), false);
  const restored = new ConfigPublisher(options); await restored.load();
  await assert.rejects(restored.callerChange(input), { code: 'operation_conflict' });
  for (const file of await readdir(directory)) assert.equal((await readFile(path.join(directory, file), 'utf8')).includes(first.oneTimeToken), false);
});

test('discard refuses unknown, 503, stale identities and historical rejection without a new matching Go 400', async (t) => {
  for (const rejection of [new Error('timeout'), new GatewayError('invalid_contract', 503), new GatewayError('gateway_unavailable'),
    new GatewayError('stale_generation', 409)]) {
    await t.test(`${rejection.code ?? 'timeout'}-${rejection.statusCode ?? 'unknown'}`, async (t) => {
      const { directory, publisher, state } = await setup(t);
      state.rejection = new GatewayError('invalid_contract', 400);
      const pending = await publisher.change(change());
      state.rejection = rejection;
      await assert.rejects(publisher.discardDesired(identity(pending)), { code: 'discard_not_confirmed' });
      assert.equal((await desired(directory)).gen, '2');
      assert.equal((await readdir(directory)).some((name) => name.endsWith('.abandoned.json')), false);
    });
  }
  const { publisher, state } = await setup(t);
  state.rejection = new GatewayError('invalid_contract', 400);
  const pending = await publisher.change(change()), count = state.calls.length;
  await assert.rejects(publisher.discardDesired({ ...identity(pending), manifestSha256: '0'.repeat(64) }), { code: 'stale_generation' });
  assert.equal(state.calls.length, count);
  state.serving = '2';
  await assert.rejects(publisher.discardDesired(identity(pending)), { code: 'discard_not_confirmed' });
});

test('a retry that succeeds activates the candidate instead of abandoning it', async (t) => {
  const { directory, publisher, state } = await setup(t);
  state.rejection = new GatewayError('invalid_contract', 400);
  const pending = await publisher.change(change()); state.rejection = null;
  await assert.rejects(publisher.discardDesired(identity(pending)), { code: 'discard_not_confirmed' });
  assert.equal(state.serving, '2'); assert.equal((await desired(directory)).gen, '2');
  assert.equal((await readdir(directory)).some((name) => name.endsWith('.abandoned.json')), false);
});

test('startup resumes an abandoned pointer only after checking Go base state and marker identity', async (t) => {
  const { directory, publisher, state, options } = await setup(t);
  state.rejection = new GatewayError('invalid_contract', 400);
  const pending = await publisher.change(change()), pendingBytes = await readFile(path.join(directory, 'desired.json'));
  await publisher.discardDesired(identity(pending));
  // Crash after the durable abandoned marker but before replacing desired.
  await writeFile(path.join(directory, 'desired.json'), pendingBytes);
  state.statusError = true;
  const blocked = new ConfigPublisher(options);
  await assert.rejects(blocked.load(), { code: 'gateway_unavailable' });
  assert.equal((await desired(directory)).gen, '2');
  await assert.rejects(blocked.change({ ...change(), baseGen: '2' }), { code: 'operation_conflict' });
  await assert.rejects(blocked.activateDesired(), { code: 'operation_conflict' });
  state.statusError = false; state.serving = '2';
  await assert.rejects(new ConfigPublisher(options).load(), { code: 'discard_not_confirmed' });
  state.committed = '2';
  await assert.rejects(blocked.change({ ...change(), baseGen: '2' }), { code: 'operation_conflict' });
  state.committed = '1';
  state.serving = '1';
  assert.equal((await new ConfigPublisher(options).load()).gen, '1');
  await writeFile(path.join(directory, 'desired.json'), pendingBytes);
  const marker = path.join(directory, 'gen-2.abandoned.json');
  await writeFile(marker, JSON.stringify({ formatVersion: 1, gen: '2', manifestSha256: '0'.repeat(64), baseGen: '1' }));
  await assert.rejects(new ConfigPublisher(options).load(), { code: 'invalid_contract' });
  assert.equal((await desired(directory)).gen, '2');
});

test('generation read EIO during publish and operation replay leaves desired and non-null memory at the base', async (t) => {
  const { directory, publisher, state, options } = await setup(t);
  const before = publisher.current, input = change(), pointerBytes = await readFile(path.join(directory, 'desired.json'));
  const loadGeneration = publisher.loadGeneration.bind(publisher);
  let reads = 0;
  publisher.loadGeneration = async (pointer) => {
    if (pointer.gen === '2') { reads++; throw Object.assign(new Error('injected generation read failure'), { code: 'EIO' }); }
    return loadGeneration(pointer);
  };
  await assert.rejects(publisher.change(input), { code: 'EIO' });
  assert.deepEqual(await readFile(path.join(directory, 'desired.json')), pointerBytes);
  assert.equal(publisher.current, before);
  await assert.rejects(publisher.change(input), { code: 'EIO' });
  assert.equal(reads, 2, 'both publication and replay load before changing the pointer');
  assert.deepEqual(await readFile(path.join(directory, 'desired.json')), pointerBytes);
  assert.equal(publisher.current, before);
  assert.equal(state.calls.length, 1);
  assert.equal((await new ConfigPublisher(options).load()).gen, '1');
  publisher.loadGeneration = async (pointer) => {
    assert.equal((await desired(directory)).gen, '1', 'replay loads its generation before rename');
    return loadGeneration(pointer);
  };
  assert.equal((await publisher.change(input)).activated, true);
  assert.equal(publisher.current.config.gen, '2');
  assert.deepEqual(publisher.current.pointer, await desired(directory));
});

test('discard base-generation read EIO leaves the candidate pointer and non-null memory intact for restart recovery', async (t) => {
  const { directory, publisher, state, options } = await setup(t);
  state.rejection = new GatewayError('invalid_config', 400);
  const pending = await publisher.change(change()), before = publisher.current;
  const pointerBytes = await readFile(path.join(directory, 'desired.json'));
  const loadGeneration = publisher.loadGeneration.bind(publisher);
  publisher.loadGeneration = async (pointer) => {
    if (pointer.gen === '1') throw Object.assign(new Error('injected base read failure'), { code: 'EIO' });
    return loadGeneration(pointer);
  };
  await assert.rejects(publisher.discardDesired(identity(pending)), { code: 'EIO' });
  assert.deepEqual(await readFile(path.join(directory, 'desired.json')), pointerBytes);
  assert.equal(publisher.current, before);
  assert.equal(publisher.current.config.gen, '2');
  assert.equal((await new ConfigPublisher(options).load()).gen, '1');
});

test('discard installs the preloaded base with no post-rename reads even when directory sync fails', async (t) => {
  for (const syncFailure of [false, true]) {
    await t.test(`directory-sync-${syncFailure ? 'failure' : 'success'}`, async (t) => {
      let armed = false, blockReads = false;
      const { directory, publisher, state, options } = await setup(t, { directorySync: async (directory) => {
        if (armed && (await desired(directory)).gen === '1') {
          blockReads = true;
          if (syncFailure) throw Object.assign(new Error('injected restore sync failure'), { code: 'EIO' });
        }
      } });
      state.rejection = new GatewayError('invalid_config', 400);
      const pending = await publisher.change(change());
      const loadGeneration = publisher.loadGeneration.bind(publisher);
      publisher.loadGeneration = async (pointer) => {
        if (blockReads) throw Object.assign(new Error('generation read after rename'), { code: 'EIO' });
        assert.equal((await desired(directory)).gen, '2', 'base is read before restoring the pointer');
        return loadGeneration(pointer);
      };
      armed = true;
      const result = await publisher.discardDesired(identity(pending));
      assert.equal(blockReads, true);
      assert.equal(result.activated, !syncFailure);
      assert.equal(result.activationErrorCode, syncFailure ? 'desired_sync_failed' : undefined);
      assert.equal(publisher.current.config.gen, '1');
      assert.deepEqual(publisher.current.pointer, await desired(directory));
      assert.equal((await new ConfigPublisher(options).load()).gen, '1');
    });
  }
});

test('rename followed by directory fsync failure aligns memory with disk and never activates until a synced replay', async (t) => {
  let armed = false, blockReads = false;
  const { directory, publisher, state, options } = await setup(t, { directorySync: async (directory) => {
    if (armed && (await desired(directory)).gen === '2') {
      blockReads = true;
      throw Object.assign(new Error('injected directory failure'), { code: 'EIO' });
    }
  } });
  const loadGeneration = publisher.loadGeneration.bind(publisher);
  publisher.loadGeneration = async (pointer) => {
    if (blockReads) throw Object.assign(new Error('generation read after rename'), { code: 'EIO' });
    return loadGeneration(pointer);
  };
  armed = true;
  const input = { baseGen: '1', operationId: randomUUID(), change: { action: 'rotate', callerId: 'caller-codex' } };
  const first = await publisher.callerChange(input);
  assert.equal(first.activated, false); assert.equal(first.activationErrorCode, 'desired_sync_failed');
  assert.match(first.oneTimeToken, /^sk-motai-/);
  assert.deepEqual(publisher.current.pointer, await desired(directory)); assert.equal(publisher.current.config.gen, '2');
  assert.equal(state.calls.length, 1);
  const restored = new ConfigPublisher(options); assert.equal((await restored.load()).gen, '2');
  assert.equal((await publisher.activateDesired()).activationErrorCode, 'desired_sync_failed');
  assert.equal(state.calls.length, 1);
  armed = false; const syncsBefore = state.syncs;
  const replay = await restored.callerChange(input);
  assert.equal(replay.activated, true); assert.equal(replay.oneTimeToken, undefined); assert.equal(replay.oneTimeTokenUnavailable, true);
  assert.equal(state.calls.length, 2); assert.ok(state.calls.at(-1).syncs > syncsBefore);
  assert.equal(publisher.current.config.callers[0].token_hmac, restored.current.config.callers[0].token_hmac);
});

test('abandoned marker sync fails before base pointer replacement and restart completes the same discard', async (t) => {
  let failMarkerSync = false;
  const { directory, publisher, state, options } = await setup(t, { directorySync: async (directory) => {
    if (failMarkerSync && (await readdir(directory)).includes('gen-2.abandoned.json')) throw new Error('injected marker sync');
  } });
  state.rejection = new GatewayError('invalid_contract', 400);
  const pending = await publisher.change(change()); failMarkerSync = true;
  await assert.rejects(publisher.discardDesired(identity(pending)), /injected marker sync/);
  assert.equal((await desired(directory)).gen, '2');
  await assert.rejects(publisher.activateDesired(), { code: 'operation_conflict' });
  failMarkerSync = false;
  assert.equal((await new ConfigPublisher(options).load()).gen, '1');
});

test('discard endpoint control rejects extra or malformed input and initial generations have no discard target', async (t) => {
  const { control, publisher, state } = await setup(t);
  for (const input of [{ gen: 2, manifestSha256: 'a'.repeat(64) }, { gen: '2', manifestSha256: 'x' },
    { gen: '2', manifestSha256: 'a'.repeat(64), activationErrorCode: 'invalid_contract' }]) {
    assert.throws(() => control.discard(input), { code: 'invalid_contract', statusCode: 400 });
  }
  state.rejection = new GatewayError('invalid_contract', 400);
  await assert.rejects(publisher.discardDesired({ gen: '1', manifestSha256: publisher.current.pointer.manifest.sha256 }), { code: 'discard_initial_generation' });
});
