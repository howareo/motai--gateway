import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { NewApiClient } from '../src/new-api-client.js';

async function listen(server) {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return server.address().port;
}

test('uses a persistent administrator token without creating a login session', async (t) => {
  let requests = 0;
  const server = http.createServer((req, res) => {
    requests += 1;
    assert.equal(req.url, '/api/channel/?p=0&page_size=100');
    assert.equal(req.headers.authorization, 'Bearer local-admin-token');
    assert.equal(req.headers.cookie, undefined);
    assert.equal(req.headers['new-api-user'], undefined);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ success: true, data: { items: [{ id: 4 }] } }));
  });
  const port = await listen(server);
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const client = new NewApiClient({
    baseUrl: `http://127.0.0.1:${port}`,
    adminToken: 'local-admin-token',
  });

  assert.equal(client.configured(), true);
  assert.deepEqual((await client.channels()).items, [{ id: 4 }]);
  assert.equal(requests, 1);
});

test('logs in once and sends the New-Api-User session headers', async (t) => {
  let logins = 0;
  let routingUpdate = null;
  let savedModelsPath = null;
  let probeAuthorization = null;
  let walletProbeAuthorization = null;
  const server = http.createServer(async (req, res) => {
    if (req.url === '/api/user/login') {
      logins += 1;
      res.writeHead(200, { 'content-type': 'application/json', 'set-cookie': 'session=abc; Path=/; HttpOnly' });
      res.end(JSON.stringify({ success: true, data: { id: 9 } }));
      return;
    }
    if (req.url === '/api/channel/' && req.method === 'PUT') {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      routingUpdate = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    }
    if (req.url === '/api/channel/fetch_models/4' && req.method === 'GET') {
      savedModelsPath = req.url;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ success: true, data: ['gpt-5.6-sol', 'gpt-5.6-terra'] }));
      return;
    }
    if (req.url === '/api/channel/4/sub2-billing-probe' && req.method === 'POST') {
      probeAuthorization = req.headers.authorization || null;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ success: true, data: { status: 'ok', effective_rate_multiplier: 0.1 } }));
      return;
    }
    if (req.url === '/api/channel/4/wallet-probe' && req.method === 'POST') {
      walletProbeAuthorization = req.headers.authorization || null;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ success: true, data: { status: 'ok', balance: 2.5, currency: 'USD' } }));
      return;
    }
    assert.equal(req.headers.cookie, 'session=abc');
    assert.equal(req.headers['new-api-user'], '9');
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ success: true, data: { items: [] } }));
  });
  const port = await listen(server);
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const client = new NewApiClient({ baseUrl: `http://127.0.0.1:${port}`, username: 'admin', password: 'secret' });
  await client.channels();
  await client.channels();
  await client.updateChannelRouting(4, 25, 2, 'gpt-5.6-sol', ['gpt-5.6-sol', 'gpt-5.6-terra']);
  const savedModels = await client.fetchSavedChannelModels(4);
  const probe = await client.probeSub2Billing(4);
  const walletProbe = await client.probeWallet(4);
  client.setCredentials('admin', 'secret');
  assert.deepEqual(await client.login(), { id: 9 });
  assert.equal(logins, 1);
  assert.deepEqual(routingUpdate, { id: 4, weight: 25, priority: 2, test_model: 'gpt-5.6-sol', models: 'gpt-5.6-sol,gpt-5.6-terra' });
  assert.equal(savedModelsPath, '/api/channel/fetch_models/4');
  assert.deepEqual(savedModels, ['gpt-5.6-sol', 'gpt-5.6-terra']);
  assert.equal(probe.effective_rate_multiplier, 0.1);
  assert.equal(probeAuthorization, null);
  assert.equal(walletProbe.balance, 2.5);
  assert.equal(walletProbeAuthorization, null);
});

test('preserves upstream login error metadata', async (t) => {
  const server = http.createServer((req, res) => {
    assert.equal(req.url, '/api/user/login');
    res.writeHead(429, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ success: false, code: 'AUTH_SESSION_ISSUANCE_LIMIT', message: 'Too Many Requests' }));
  });
  const port = await listen(server);
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const client = new NewApiClient({ baseUrl: `http://127.0.0.1:${port}`, username: 'admin', password: 'secret' });

  await assert.rejects(client.login(), (error) => {
    assert.equal(error.status, 429);
    assert.equal(error.code, 'AUTH_SESSION_ISSUANCE_LIMIT');
    return true;
  });
});

test('refreshes an access-token session after a 401 without creating another login session', async (t) => {
  let logins = 0;
  let refreshes = 0;
  let channelRequests = 0;
  const authorizationHeaders = [];
  const userHeaders = [];
  const server = http.createServer((req, res) => {
    if (req.url === '/api/user/login') {
      logins += 1;
      res.writeHead(200, {
        'content-type': 'application/json',
        'set-cookie': `new-api-refresh=session-${logins}; Path=/api/user/auth; HttpOnly`,
      });
      res.end(JSON.stringify({
        success: true,
        data: {
          access_token: `access-${logins}`,
          access_expires_at: 1700000000,
          token_type: 'Bearer',
          user: { id: 9, username: 'admin', role: 10 },
          session: { sid: `session-${logins}` },
        },
      }));
      return;
    }

    if (req.url === '/api/user/auth/refresh') {
      refreshes += 1;
      assert.equal(req.method, 'POST');
      assert.equal(req.headers.cookie, 'new-api-refresh=session-1');
      assert.equal(req.headers['x-auth-session'], 'session-1');
      res.writeHead(200, {
        'content-type': 'application/json',
        'set-cookie': 'new-api-refresh=rotated-session-1; Path=/api/user/auth; HttpOnly',
      });
      res.end(JSON.stringify({
        success: true,
        data: {
          access_token: 'access-refreshed',
          access_expires_at: 1700000900,
          token_type: 'Bearer',
          user: { id: 9, username: 'admin', role: 10 },
          session: { sid: 'session-1' },
        },
      }));
      return;
    }

    assert.equal(req.url, '/api/channel/?p=0&page_size=100');
    channelRequests += 1;
    authorizationHeaders.push(req.headers.authorization);
    userHeaders.push(req.headers['new-api-user']);
    if (channelRequests === 1) {
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ success: false, code: 'AUTH_TOKEN_EXPIRED', message: 'Unauthorized' }));
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ success: true, data: { items: [{ id: 4 }] } }));
  });
  const port = await listen(server);
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const client = new NewApiClient({ baseUrl: `http://127.0.0.1:${port}`, username: 'admin', password: 'secret' });

  const user = await client.login();
  const channels = await client.channels();

  assert.deepEqual(user, { id: 9, username: 'admin', role: 10 });
  assert.deepEqual(channels.items, [{ id: 4 }]);
  assert.equal(logins, 1);
  assert.equal(refreshes, 1);
  assert.equal(channelRequests, 2);
  assert.deepEqual(authorizationHeaders, ['Bearer access-1', 'Bearer access-refreshed']);
  assert.deepEqual(userHeaders, ['9', '9']);
});

test('paginates all logs within the requested time window', async (t) => {
  const requestedPages = [];
  const server = http.createServer((req, res) => {
    if (req.url === '/api/user/login') {
      res.writeHead(200, { 'content-type': 'application/json', 'set-cookie': 'session=abc; Path=/; HttpOnly' });
      res.end(JSON.stringify({ success: true, data: { id: 9 } }));
      return;
    }

    const url = new URL(req.url, 'http://127.0.0.1');
    assert.equal(url.pathname, '/api/log/');
    assert.equal(url.searchParams.get('page_size'), '100');
    assert.equal(url.searchParams.get('start_timestamp'), '1000');
    assert.equal(url.searchParams.get('end_timestamp'), '2000');
    const page = Number(url.searchParams.get('p'));
    requestedPages.push(page);
    const start = (page - 1) * 100;
    const items = Array.from({ length: Math.max(0, Math.min(100, 205 - start)) }, (_, index) => ({ id: 205 - start - index }));
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ success: true, data: { page, page_size: 100, total: 205, items } }));
  });
  const port = await listen(server);
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const client = new NewApiClient({ baseUrl: `http://127.0.0.1:${port}`, username: 'admin', password: 'secret', logPageIntervalMs: 0 });

  const logs = await client.logs({ type: 2, startTimestamp: 1000, endTimestamp: 2000, pageSize: 500 });

  assert.deepEqual(requestedPages, [1, 2, 3]);
  assert.equal(logs.total, 205);
  assert.equal(logs.items.length, 205);
  assert.equal(logs.items[0].id, 205);
  assert.equal(logs.items.at(-1).id, 1);
});

test('limits recent log reads and prioritizes them between full-history pages', async (t) => {
  const order = [];
  let firstFullPageSeen;
  const firstFullPage = new Promise((resolve) => { firstFullPageSeen = resolve; });
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    assert.equal(url.pathname, '/api/log/');
    const type = Number(url.searchParams.get('type'));
    const page = Number(url.searchParams.get('p'));
    order.push(`${type}:${page}`);
    if (type === 2 && page === 1) {
      firstFullPageSeen();
      setTimeout(() => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ success: true, data: { total: 300, items: Array.from({ length: 100 }, (_, index) => ({ id: 300 - index })) } }));
      }, 20);
      return;
    }
    if (type === 2) {
      const start = (page - 1) * 100;
      const length = Math.max(0, Math.min(100, 300 - start));
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ success: true, data: { total: 300, items: Array.from({ length }, (_, index) => ({ id: 300 - start - index })) } }));
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ success: true, data: { total: 150, items: Array.from({ length: 100 }, (_, index) => ({ id: 150 - index })) } }));
  });
  const port = await listen(server);
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const client = new NewApiClient({ baseUrl: `http://127.0.0.1:${port}`, adminToken: 'local-admin-token', logPageIntervalMs: 0 });

  const full = client.logs({ type: 2, pageSize: 100 });
  await firstFullPage;
  const recent = client.recentLogs({ type: 5, limit: 100 });
  const [fullResult, recentResult] = await Promise.all([full, recent]);

  assert.deepEqual(order, ['2:1', '5:1', '2:2', '2:3']);
  assert.equal(fullResult.items.length, 300);
  assert.equal(recentResult.items.length, 100);
  assert.equal(recentResult.truncated, true);
});

test('serializes concurrent log page reads', async (t) => {
  let activeLogRequests = 0;
  let maxConcurrentLogRequests = 0;
  const server = http.createServer((req, res) => {
    if (req.url === '/api/user/login') {
      res.writeHead(200, { 'content-type': 'application/json', 'set-cookie': 'session=abc; Path=/; HttpOnly' });
      res.end(JSON.stringify({ success: true, data: { id: 9 } }));
      return;
    }
    activeLogRequests += 1;
    maxConcurrentLogRequests = Math.max(maxConcurrentLogRequests, activeLogRequests);
    setTimeout(() => {
      activeLogRequests -= 1;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ success: true, data: { items: [] } }));
    }, 10);
  });
  const port = await listen(server);
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const client = new NewApiClient({ baseUrl: `http://127.0.0.1:${port}`, username: 'admin', password: 'secret', logPageIntervalMs: 0 });

  await Promise.all([client.logs({ type: 2 }), client.logs({ type: 5 })]);

  assert.equal(maxConcurrentLogRequests, 1);
});

test('reads and writes New API pricing tables through the admin option API', async (t) => {
  const current = {
    ModelRatio: JSON.stringify({ a: 1 }),
    CompletionRatio: JSON.stringify({ a: 2 }),
    CacheRatio: JSON.stringify({ a: 0.1 }),
    CreateCacheRatio: JSON.stringify({ a: 1.25 }),
  };
  const requests = [];
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    requests.push({
      method: req.method,
      authorization: req.headers.authorization || null,
      cookie: req.headers.cookie || null,
      user: req.headers['new-api-user'] || null,
      body: chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : null,
    });
    res.writeHead(200, { 'content-type': 'application/json' });
    if (req.method === 'GET') {
      res.end(JSON.stringify({ success: true, data: Object.entries(current).map(([key, value]) => ({ key, value })) }));
      return;
    }
    res.end(JSON.stringify({ success: true }));
  });
  const port = await listen(server);
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const client = new NewApiClient({
    baseUrl: `http://127.0.0.1:${port}`,
    adminToken: 'admin-token',
  });
  const tables = await client.pricingTables();
  assert.deepEqual(tables, {
    model_ratio: { a: 1 },
    completion_ratio: { a: 2 },
    cache_ratio: { a: 0.1 },
    create_cache_ratio: { a: 1.25 },
  });
  const desired = { ...tables, model_ratio: { a: 3 } };
  await client.applyPricingTables(tables, desired);
  assert.deepEqual(requests.map((request) => request.method), ['GET', 'GET', 'PUT']);
  assert.equal(requests.every((request) => request.authorization === 'Bearer admin-token'), true);
  assert.deepEqual(requests[2].body, { key: 'ModelRatio', value: JSON.stringify({ a: 3 }) });
});
