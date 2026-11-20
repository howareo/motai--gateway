import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ConfigPublisher } from '../src/gateway/config-publisher.js';
import { GatewayClient, publicGatewayStatus } from '../src/gateway/client.js';

const config = JSON.parse(await readFile(new URL('../contracts/fixtures/config-valid.json', import.meta.url)));
const credentials = JSON.parse(await readFile(new URL('../contracts/fixtures/credentials-valid.json', import.meta.url)));
const samples = JSON.parse(await readFile(new URL('../contracts/fixtures/internal-api-samples.json', import.meta.url))).samples;

test('account probes wait beyond the core budget without slowing status or shortening an explicit timeout', async (t) => {
  const deadlines = [], original = AbortSignal.timeout.bind(AbortSignal);
  t.mock.method(AbortSignal, 'timeout', (ms) => { deadlines.push(ms); return original(ms); });
  let answer = samples.status;
  const client = new GatewayClient({ baseUrl: 'http://motai-internal:3002', managementToken: 'CANARY_KEY',
    fetchImpl: async () => Response.json(answer) });
  await client.status();
  answer = { ...samples.billing_probe_response, state: 'unknown', source: 'unavailable', multiplier: null, error_class: 'timeout' };
  assert.equal((await client.billingProbe('1')).error_class, 'timeout');
  answer = samples.wallet_probe_response; await client.walletProbe('1');
  client.timeoutMs = 20_000;
  answer = samples.billing_probe_response; await client.billingProbe('1');
  assert.deepEqual(deadlines, [10_000, 15_000, 15_000, 20_000]);
});

test('core timeouts during headers or body are distinct from connection failures and expose no upstream text', async (t) => {
  const controller = new AbortController();
  t.mock.method(AbortSignal, 'timeout', () => controller.signal);
  const failure = new Error('CANARY_KEY CANARY_BODY');
  const client = new GatewayClient({ baseUrl: 'http://motai-internal:3002', managementToken: 'CANARY_KEY',
    fetchImpl: async () => { throw failure; } });
  await assert.rejects(client.status(), { code: 'gateway_unavailable', statusCode: 502 });
  controller.abort();
  await assert.rejects(client.billingProbe('1'), (error) => error.code === 'gateway_timeout' && error.statusCode === 504 && !error.message.includes('CANARY'));
  client.fetch = async () => new Response(new ReadableStream({ start(stream) { stream.error(failure); } }));
  await assert.rejects(client.walletProbe('1'), { code: 'gateway_timeout', statusCode: 504 });
});

test('internal client validates writes and required response fields, forbids redirects and sanitizes upstream messages', async () => {
  const requests = [];
  const client = new GatewayClient({ baseUrl: 'http://motai-internal:3002', managementToken: 'CANARY_KEY',
    fetchImpl: async (url, options) => {
      requests.push({ url: String(url), ...options });
      return Response.json({ ...samples.status, future_optional: 'extra' });
    } });
  assert.equal((await client.status()).latest_seq, samples.status.latest_seq);
  assert.equal(requests[0].redirect, 'manual');
  assert.equal(requests[0].url, 'http://motai-internal:3002/internal/v1/status');
  assert.equal(publicGatewayStatus({ ...samples.status, injected: 'CANARY_BODY' }).injected, undefined);
  await assert.rejects(client.activate({ ...samples.activate_request, secret: 'CANARY_BODY' }), /Invalid gateway contract/);
  assert.equal(requests.length, 1);
  client.fetch = async () => Response.json({ ...samples.status, latest_seq: 1 });
  await assert.rejects(client.status(), { code: 'gateway_invalid_response' });
  client.fetch = async () => Response.json({ ...samples.error_response,
    error: { ...samples.error_response.error, code: 'gateway_log_unavailable', message: 'CANARY_KEY CANARY_BODY' } }, { status: 503 });
  await assert.rejects(client.status(), (error) => error.code === 'gateway_log_unavailable' && !error.message.includes('CANARY'));
  client.fetch = async () => Response.json({ body: 'CANARY_BODY' }, { status: 302, headers: { location: 'http://elsewhere/' } });
  await assert.rejects(client.status(), { code: 'gateway_invalid_response' });
});

test('configuration publication activates one immutable generation, preserves opaque IDs and hides all credentials', async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'motai-publish-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  let committed = null;
  const calls = [];
  const client = { status: async () => ({ ...samples.status, committed_gen: committed, serving_gen: committed }),
    activate: async (input) => {
      calls.push(input);
      committed = input.gen;
      return { format_version: 1, ...input, committed_gen: committed, serving_gen: committed };
    } };
  const publisher = new ConfigPublisher({ directory, client });
  assert.equal(await publisher.load(), null);
  const result = await publisher.publish({ baseGen: null, config, credentials });
  assert.equal(result.activated, true);
  assert.equal(result.servingGen, '1');
  assert.equal(result.config.channels[0].id, '1022');
  assert(!JSON.stringify(result).includes('SYNTHETIC_NOT_A_REAL_CREDENTIAL'));
  assert(!JSON.stringify(result).includes(config.callers[0].token_hmac));
  assert(!JSON.stringify(result).includes('credential_ref'));
  const restored = new ConfigPublisher({ directory, client });
  assert.equal((await restored.load()).gen, '1');
  await assert.rejects(restored.publish({ baseGen: null, config, credentials }), { statusCode: 409 });
  const simultaneous = await Promise.allSettled([1, 2].map(() => publisher.publish({ baseGen: '1', config, credentials })));
  assert.equal(simultaneous.filter((value) => value.status === 'fulfilled').length, 1);
  assert.equal(calls.length, 2);
  assert.equal(JSON.parse(await readFile(path.join(directory, 'gen-1.config.json'))).gen, '1');
  await writeFile(path.join(directory, 'gen-2.config.json'), '{}');
  await assert.rejects(new ConfigPublisher({ directory, client }).load(), { code: 'invalid_contract' });
});

test('an uncertain activation checks status and keeps the exact desired generation for reconciliation', async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'motai-pending-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  let committed = null, activations = 0;
  const client = { status: async () => ({ ...samples.status, committed_gen: committed, serving_gen: committed }),
    activate: async () => { activations += 1; throw new Error('timeout'); } };
  const publisher = new ConfigPublisher({ directory, client });
  const pending = await publisher.publish({ baseGen: null, config, credentials });
  assert.equal(pending.activated, false);
  assert.equal(pending.desiredGen, '1');
  await assert.rejects(publisher.publish({ baseGen: '1', config, credentials }), { statusCode: 409 });
  committed = '1';
  assert.equal((await publisher.activateDesired()).activated, true);
  assert.equal(publisher.current.pointer.gen, '1');
  assert.equal(activations, 2);
});
