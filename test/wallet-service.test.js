import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  WalletError,
  WalletService,
  isEdgeChallengeResponse,
  isPublicAddress,
  safeJsonRequest,
} from '../src/wallet-service.js';
import { WalletStore, accountKey } from '../src/wallet-store.js';

async function fixture(t, channels, probeWallet, request) {
  const directory = await mkdtemp(path.join(tmpdir(), 'wallet-service-'));
  const store = new WalletStore({
    statePath: path.join(directory, 'state.json'),
    credentialsPath: path.join(directory, 'credentials.json'),
  });
  await store.load();
  const client = { async channels() { return { items: channels }; }, probeWallet };
  const service = new WalletService({ client, store, request, refreshIntervalMs: 1000 });
  t.after(() => rm(directory, { recursive: true, force: true }));
  return { store, service };
}

test('preserves a real zero balance and an absent currency', async (t) => {
  const channel = { id: 1, name: 'New API', type: 14, status: 1, base_url: 'https://gateway.example.com' };
  const { store, service } = await fixture(t, [channel], async () => ({ status: 'ok', balance: 0, currency: null }));
  await service.refreshAll();
  const wallet = store.publicState(1);
  assert.equal(wallet.status, 'ok');
  assert.equal(wallet.balance, 0);
  assert.equal(wallet.currency, null);
});

test('shares a rotating Sub2 account only after each channel explicitly supplies that credential', async (t) => {
  const channels = [
    { id: 2, name: 'Sub2 A', type: 14, status: 1, base_url: 'https://api.ej2075.com' },
    { id: 3, name: 'Sub2 B', type: 1, status: 1, base_url: 'https://api.ej2075.com' },
    { id: 4, name: 'Unconfigured', type: 1, status: 1, base_url: 'https://api.ej2075.com' },
  ];
  let refreshCalls = 0;
  const request = async ({ pathname }) => {
    if (pathname === '/api/v1/auth/refresh') {
      refreshCalls += 1;
      return { code: 0, data: { access_token: 'access-secret', refresh_token: 'rotated-secret', expires_in: 3600 } };
    }
    if (pathname.startsWith('/api/v1/auth/me')) return { code: 0, data: { balance: 4.25 } };
    throw new Error('unexpected request');
  };
  const { store, service } = await fixture(t, channels, async () => { throw new Error('not newapi'); }, request);
  await store.reconcileChannels(channels);
  await store.configure(channels[0], { adapter: 'sub2', origin: 'https://api.ej2075.com', credential: 'original-secret' });
  await store.configure(channels[1], { adapter: 'sub2', origin: 'https://api.ej2075.com', credential: 'original-secret' });

  await service.refreshAll();
  assert.equal(refreshCalls, 1);
  assert.equal(store.publicState(2).balance, 4.25);
  assert.equal(store.publicState(3).balance, 4.25);
  assert.equal(store.publicState(3).configured, true);
  assert.equal(store.publicState(4).configured, false);
  assert.equal(store.publicState(4).status, 'unconfigured');
  assert.equal(store.publicState(4).balance, null);
  const credential = store.credential(accountKey('sub2', 'https://api.ej2075.com', 'original-secret'));
  assert.equal(credential.current, 'rotated-secret');
  assert.equal(credential.previous, 'original-secret');
  await store.configure(channels[1], { adapter: 'sub2', origin: 'https://api.ej2075.com', credential: 'original-secret' });
  assert.equal(store.credential(store.state(3).accountKey).current, 'rotated-secret', 'explicit reuse must not undo refresh-token rotation');
  assert.equal(JSON.stringify(store.snapshot()).includes('secret'), false);
});

test('refreshes different same-site Sub2 accounts with separate tokens and balances', async (t) => {
  const channels = [
    { id: 'codex', name: 'Codex', type: 1, status: 1, base_url: 'https://tokenshop.homes' },
    { id: 'gemini', name: 'Gemini', type: 1, status: 1, base_url: 'https://tokenshop.homes' },
  ];
  const refreshed = [];
  const { store, service } = await fixture(t, channels, async () => { throw new Error('not newapi'); }, async ({ pathname, body, headers }) => {
    if (pathname === '/api/v1/auth/refresh') {
      refreshed.push(body.refresh_token);
      return { code: 0, data: { access_token: `access-${body.refresh_token}`, refresh_token: `next-${body.refresh_token}`, expires_in: 3600 } };
    }
    if (pathname.startsWith('/api/v1/auth/me')) {
      return { code: 0, data: { balance: headers.authorization === 'Bearer access-account-a' ? 9.68 : 2.34 } };
    }
    throw new Error('unexpected request');
  });
  await store.reconcileChannels(channels);
  await store.configure(channels[0], { adapter: 'sub2', origin: channels[0].base_url, credential: 'account-a' });
  await store.configure(channels[1], { adapter: 'sub2', origin: channels[1].base_url, credential: 'account-b' });
  await service.refreshAll();
  assert.deepEqual(refreshed.sort(), ['account-a', 'account-b']);
  assert.equal(store.publicState('codex').balance, 9.68);
  assert.equal(store.publicState('gemini').balance, 2.34);
  assert.equal(store.credential(store.state('codex').accountKey).current, 'next-account-a');
  assert.equal(store.credential(store.state('gemini').accountKey).current, 'next-account-b');
});

test('persists a rotated Sub2 cookie when JSON refresh succeeds without a token in the body', async (t) => {
  const channel = { id: 5, name: 'SevnX', type: 1, status: 1, base_url: 'https://www.sevnx.one' };
  let refreshCalls = 0;
  const request = async (options) => {
    if (options.pathname === '/api/v1/auth/refresh') {
      refreshCalls += 1;
      assert.deepEqual(options.body, { refresh_token: 'json-cookie-secret' });
      assert.equal(options.returnMeta, true);
      return {
        payload: { code: 0, data: { access_token: 'json-cookie-access', expires_in: 3600 } },
        headers: { 'set-cookie': ['refresh_token=rotated-json-cookie-secret; Path=/api/v1/auth/refresh; HttpOnly; Secure'] },
      };
    }
    if (options.pathname.startsWith('/api/v1/auth/me')) {
      assert.equal(options.headers.authorization, 'Bearer json-cookie-access');
      return { code: 0, data: { balance: 8.25 } };
    }
    throw new Error('unexpected request');
  };
  const { store, service } = await fixture(t, [channel], async () => { throw new Error('not newapi'); }, request);
  await store.reconcileChannels([channel]);
  await store.configure(channel, {
    adapter: 'sub2',
    origin: 'https://www.sevnx.one',
    credential: 'json-cookie-secret',
  });

  await service.refreshAll({ manual: true });

  assert.equal(refreshCalls, 1);
  assert.equal(store.publicState(5).status, 'ok');
  assert.equal(store.publicState(5).balance, 8.25);
  const credential = store.credential(accountKey('sub2', 'https://www.sevnx.one', 'json-cookie-secret'));
  assert.equal(credential.current, 'rotated-json-cookie-secret');
  assert.equal(credential.previous, 'json-cookie-secret');
});

test('supports Sub2 HttpOnly refresh cookies and persists the rotated cookie', async (t) => {
  const channel = { id: 5, name: 'SevnX', type: 1, status: 1, base_url: 'https://www.sevnx.one' };
  const refreshRequests = [];
  const request = async (options) => {
    if (options.pathname === '/api/v1/auth/refresh') {
      refreshRequests.push(options);
      if (options.body?.refresh_token) throw new WalletError('unauthorized', 401);
      assert.deepEqual(options.body, {});
      assert.equal(options.headers.cookie, 'refresh_token=cookie-secret');
      assert.equal(options.returnMeta, true);
      return {
        payload: { code: 0, data: { access_token: 'cookie-access', expires_in: 3600 } },
        headers: { 'set-cookie': ['refresh_token=rotated-cookie-secret; Path=/api/v1/auth/refresh; HttpOnly; Secure'] },
      };
    }
    if (options.pathname.startsWith('/api/v1/auth/me')) {
      assert.equal(options.headers.authorization, 'Bearer cookie-access');
      return { code: 0, data: { balance: 7.5 } };
    }
    throw new Error('unexpected request');
  };
  const { store, service } = await fixture(t, [channel], async () => { throw new Error('not newapi'); }, request);
  await store.reconcileChannels([channel]);
  await store.configure(channel, {
    adapter: 'sub2',
    origin: 'https://www.sevnx.one',
    credential: 'refresh_token=cookie-secret; Path=/',
  });

  await service.refreshAll({ manual: true });

  assert.equal(refreshRequests.length, 2);
  assert.equal(store.publicState(5).status, 'ok');
  assert.equal(store.publicState(5).balance, 7.5);
  const credential = store.credential(accountKey('sub2', 'https://www.sevnx.one', 'refresh_token=cookie-secret; Path=/'));
  assert.equal(credential.current, 'rotated-cookie-secret');
  assert.equal(credential.previous, 'cookie-secret');
  assert.equal(JSON.stringify(store.snapshot()).includes('secret'), false);
});

test('prefers verified panel fingerprints over misleading generic billing endpoints', async (t) => {
  const channel = { id: 4, name: 'Right Code', type: 14, status: 1, base_url: 'https://www.rightapi.ai/claude-aws' };
  let genericProbeCalls = 0;
  const { store, service } = await fixture(t, [channel], async () => {
    genericProbeCalls += 1;
    return { status: 'ok', balance: 99_999_999, currency: 'USD' };
  });

  await service.refreshAll();
  const wallet = store.publicState(4);
  assert.equal(genericProbeCalls, 0);
  assert.equal(wallet.detectedAdapter, 'rightcode');
  assert.equal(wallet.status, 'unconfigured');
  assert.equal(wallet.balance, null);
});

test('reports an upstream edge challenge separately from an invalid refresh token', async (t) => {
  const channel = { id: 6, name: 'Jarvis', type: 1, status: 1, base_url: 'https://api.aijws.com' };
  const request = async () => { throw new WalletError('edge_blocked', 403); };
  const { store, service } = await fixture(t, [channel], async () => { throw new Error('not newapi'); }, request);
  await store.reconcileChannels([channel]);
  await store.configure(channel, {
    adapter: 'sub2',
    origin: 'https://api.aijws.com',
    credential: 'refresh-secret',
  });

  await service.refreshAll({ manual: true });

  const wallet = store.publicState(6);
  assert.equal(wallet.status, 'error');
  assert.equal(wallet.errorClass, 'edge_blocked');
  assert.equal(wallet.configured, true);
});

test('recognizes HTML Cloudflare and WAF challenges without misclassifying JSON API errors', () => {
  assert.equal(isEdgeChallengeResponse(403, { 'content-type': 'text/html; charset=UTF-8', 'cf-ray': 'test' }), true);
  assert.equal(isEdgeChallengeResponse(403, { 'content-type': 'text/html', server: 'generic-waf' }), true);
  assert.equal(isEdgeChallengeResponse(403, { 'content-type': 'application/json', 'cf-ray': 'test' }), false);
  assert.equal(isEdgeChallengeResponse(401, { 'content-type': 'text/html', 'cf-ray': 'test' }), false);
});

test('blocks literal, private, documentation and mapped private targets', async () => {
  assert.equal(isPublicAddress('8.8.8.8'), true);
  assert.equal(isPublicAddress('10.0.0.1'), false);
  assert.equal(isPublicAddress('203.0.113.1'), false);
  assert.equal(isPublicAddress('::1'), false);
  assert.equal(isPublicAddress('::ffff:127.0.0.1'), false);
  await assert.rejects(safeJsonRequest({ origin: 'https://127.0.0.1', pathname: '/api/test' }), { code: 'target_blocked' });
});

test('reads a New API relay quota and does not use the local gateway balance', async (t) => {
  const channel = {
    id: 8,
    name: 'JBB',
    type: 1,
    status: 1,
    base_url: 'https://relay.example.com/v1',
    key: 'sk-relay-secret',
  };
  let probeCalls = 0;
  const request = async ({ origin, pathname, headers }) => {
    assert.equal(origin, 'https://relay.example.com');
    assert.equal(JSON.stringify(headers || {}).includes('sk-relay-secret') || pathname === '/api/status', true);
    if (pathname === '/api/usage/token/') {
      assert.equal(headers.authorization, 'Bearer sk-relay-secret');
      return { code: true, data: { total_available: 250000, unlimited_quota: false } };
    }
    if (pathname === '/api/status') return { data: { quota_per_unit: 500000 } };
    throw new WalletError('endpoint_unsupported');
  };
  const { store, service } = await fixture(t, [channel], async () => {
    probeCalls += 1;
    return { status: 'ok', balance: 999, currency: 'USD', source: 'local' };
  }, request);
  service.client.baseUrl = 'http://127.0.0.1:3001';
  await service.refreshAll();
  const wallet = store.publicState(8);
  assert.equal(probeCalls, 0);
  assert.equal(wallet.detectedAdapter, 'newapi');
  assert.equal(wallet.status, 'ok');
  assert.equal(wallet.balance, 0.5);
  assert.equal(JSON.stringify(store.snapshot()).includes('sk-relay-secret'), false);
});

test('does not treat the self-hosted gateway as a channel balance', async (t) => {
  const channel = { id: 9, name: 'Local', type: 1, status: 1, base_url: 'http://127.0.0.1:3001', key: 'sk-local-secret' };
  let probeCalls = 0;
  const { store, service } = await fixture(t, [channel], async () => {
    probeCalls += 1;
    return { status: 'ok', balance: 999, currency: 'USD' };
  }, async () => { throw new Error('should not query local gateway'); });
  service.client.baseUrl = 'http://127.0.0.1:3001';
  await service.refreshAll();
  const wallet = store.publicState(9);
  assert.equal(probeCalls, 0);
  assert.equal(wallet.detectedAdapter, 'none');
  assert.equal(wallet.balance, null);
});
test('reads the New API account balance from a user access token instead of the token quota', async (t) => {
  const channel = {
    id: 12,
    name: 'sudobug',
    type: 43,
    status: 1,
    base_url: 'https://sudobug.example',
    key: 'sk-channel-key',
  };
  const request = async ({ origin, pathname, headers }) => {
    assert.equal(origin, 'https://sudobug.example');
    if (pathname === '/api/usage/token/') {
      assert.equal(headers.authorization, 'Bearer sk-channel-key');
      return { code: true, data: { total_available: -66, total_used: 66, unlimited_quota: true } };
    }
    if (pathname === '/api/user/self') {
      assert.equal(headers.authorization, 'Bearer user-access-token');
      return { success: true, data: { quota: 4840000, used_quota: 1000 } };
    }
    if (pathname === '/api/status') return { data: { quota_per_unit: 500000 } };
    throw new WalletError('endpoint_unsupported');
  };
  const { store, service } = await fixture(t, [channel], async () => {
    throw new Error('probe should not be needed when a user access token is configured');
  }, request);
  await store.reconcileChannels([channel]);
  await store.configure(channel, { adapter: 'newapi', origin: 'https://sudobug.example', credential: 'user-access-token' });
  await service.refreshAll();
  const wallet = store.publicState(12);
  assert.equal(wallet.status, 'ok');
  assert.equal(wallet.balance, 9.68);
  assert.equal(wallet.currency, null);
  assert.equal(JSON.stringify(store.snapshot()).includes('user-access-token'), false);
});
