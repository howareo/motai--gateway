import dns from 'node:dns';
import https from 'node:https';
import net from 'node:net';
import { normalizeOrigin } from './wallet-store.js';
import { normalizeChannelId } from './channel-id.js';

const MAX_BODY_BYTES = 64 * 1024;
const REQUEST_TIMEOUT_MS = 8000;
const MANUAL_MIN_INTERVAL_MS = 60 * 1000;
const DEFAULT_REFRESH_INTERVAL_MS = 15 * 60 * 1000;
const MAX_CONCURRENCY = 3;

const KNOWN_PANELS = new Map([
  ['api.ej2075.com', { adapter: 'sub2', origin: 'https://api.ej2075.com' }],
  ['api.tokenshop.homes', { adapter: 'sub2', origin: 'https://tokenshop.homes' }],
  ['tokenshop.homes', { adapter: 'sub2', origin: 'https://tokenshop.homes' }],
  ['www.sevnx.one', { adapter: 'sub2', origin: 'https://www.sevnx.one' }],
  ['sevnx.one', { adapter: 'sub2', origin: 'https://www.sevnx.one' }],
  ['api.aijws.com', { adapter: 'sub2', origin: 'https://api.aijws.com' }],
  ['www.rightapi.ai', { adapter: 'rightcode', origin: 'https://www.rightapi.ai' }],
  ['rightapi.ai', { adapter: 'rightcode', origin: 'https://www.rightapi.ai' }],
]);
const KNOWN_CURRENCIES = new Map([
  ['api.ej2075.com', 'USD'],
  ['api.tokenshop.homes', 'USD'],
  ['tokenshop.homes', 'USD'],
  ['www.sevnx.one', 'USD'],
  ['sevnx.one', 'USD'],
  ['api.aijws.com', 'USD'],
  ['www.rightapi.ai', 'USD'],
  ['rightapi.ai', 'USD'],
  ['downstream.jbbtoken.cn', 'USD'],
]);

class WalletError extends Error {
  constructor(code, status = null) {
    super(code);
    this.name = 'WalletError';
    this.code = code;
    this.status = status;
  }
}

function ipv4Number(address) {
  const parts = address.split('.').map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return null;
  return (((parts[0] * 256 + parts[1]) * 256 + parts[2]) * 256 + parts[3]) >>> 0;
}

function inV4Range(value, base, bits) {
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return (value & mask) === (ipv4Number(base) & mask);
}

function isPublicAddress(address) {
  const family = net.isIP(address);
  if (family === 4) {
    const value = ipv4Number(address);
    return ![
      ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
      ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24],
      ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24],
      ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
    ].some(([base, bits]) => inV4Range(value, base, bits));
  }
  if (family === 6) {
    const lower = address.toLowerCase();
    if (lower.startsWith('::ffff:')) return isPublicAddress(lower.slice(7));
    return lower !== '::' && lower !== '::1'
      && !lower.startsWith('fc') && !lower.startsWith('fd')
      && !/^fe[89ab]/.test(lower) && !lower.startsWith('ff')
      && !lower.startsWith('2001:db8:');
  }
  return false;
}

function strictLookup(hostname, options, callback) {
  if (net.isIP(hostname)) {
    callback(new WalletError('target_blocked'));
    return;
  }
  dns.lookup(hostname, { all: true, verbatim: true }, (error, addresses) => {
    if (error) {
      callback(new WalletError('dns_error'));
      return;
    }
    if (!addresses.length || addresses.some((entry) => !isPublicAddress(entry.address))) {
      callback(new WalletError('target_blocked'));
      return;
    }
    if (options?.all) callback(null, addresses);
    else callback(null, addresses[0].address, addresses[0].family);
  });
}

function classifyNetworkError(error) {
  if (error instanceof WalletError) return error;
  const code = String(error?.code || '').toUpperCase();
  if (code.includes('TIMEOUT') || code === 'ABORT_ERR') return new WalletError('timeout');
  if (code.includes('CERT') || code.includes('TLS') || code.includes('SSL')) return new WalletError('tls_error');
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return new WalletError('dns_error');
  return new WalletError('network_error');
}

function isEdgeChallengeResponse(status, headers = {}) {
  const contentType = String(headers['content-type'] || '').toLowerCase();
  const server = String(headers.server || '').toLowerCase();
  const cloudflare = Boolean(headers['cf-ray'])
    || String(headers['cf-mitigated'] || '').toLowerCase() === 'challenge'
    || server.includes('cloudflare');
  const html = contentType.includes('text/html');
  return html && (Number(status) === 403 || (cloudflare && [429, 503].includes(Number(status))));
}

function safeJsonRequest({ origin, pathname, method = 'GET', headers = {}, body, timeoutMs = REQUEST_TIMEOUT_MS, returnMeta = false }) {
  const base = new URL(normalizeOrigin(origin));
  const literalHost = base.hostname.replace(/^\[|\]$/g, '');
  if (net.isIP(literalHost)) return Promise.reject(new WalletError('target_blocked'));
  if (!pathname.startsWith('/') || pathname.startsWith('//')) return Promise.reject(new WalletError('invalid_path'));
  const target = new URL(pathname, base);
  if (target.origin !== base.origin) return Promise.reject(new WalletError('invalid_target'));
  const payload = body === undefined ? null : Buffer.from(JSON.stringify(body));
  return new Promise((resolve, reject) => {
    const request = https.request(target, {
      method,
      headers: {
        accept: 'application/json',
        ...(payload ? { 'content-type': 'application/json', 'content-length': String(payload.length) } : {}),
        ...headers,
      },
      lookup: strictLookup,
      timeout: timeoutMs,
      maxHeaderSize: 16 * 1024,
    }, (response) => {
      const status = Number(response.statusCode) || 0;
      if (isEdgeChallengeResponse(status, response.headers)) {
        response.resume();
        reject(new WalletError('edge_blocked', status));
        return;
      }
      if (status >= 300 && status < 400) {
        response.resume();
        reject(new WalletError('redirect_blocked', status));
        return;
      }
      if (status === 401 || status === 403) {
        response.resume();
        reject(new WalletError('unauthorized', status));
        return;
      }
      if (status === 404 || status === 405) {
        response.resume();
        reject(new WalletError('endpoint_unsupported', status));
        return;
      }
      if (status < 200 || status >= 300) {
        response.resume();
        reject(new WalletError(status >= 500 ? 'http_5xx' : 'http_4xx', status));
        return;
      }
      const contentType = String(response.headers['content-type'] || '').split(';', 1)[0].trim().toLowerCase();
      if (contentType !== 'application/json' && !contentType.endsWith('+json')) {
        response.resume();
        reject(new WalletError('bad_content_type', status));
        return;
      }
      const declared = Number(response.headers['content-length']);
      if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
        response.resume();
        reject(new WalletError('response_too_large', status));
        return;
      }
      const chunks = [];
      let size = 0;
      response.on('data', (chunk) => {
        size += chunk.length;
        if (size > MAX_BODY_BYTES) response.destroy(new WalletError('response_too_large', status));
        else chunks.push(chunk);
      });
      response.on('error', (error) => reject(classifyNetworkError(error)));
      response.on('end', () => {
        try {
          const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          resolve(returnMeta ? { payload: parsed, headers: response.headers } : parsed);
        } catch {
          reject(new WalletError('schema_invalid', status));
        }
      });
    });
    request.on('timeout', () => request.destroy(new WalletError('timeout')));
    request.on('error', (error) => reject(classifyNetworkError(error)));
    if (payload) request.write(payload);
    request.end();
  });
}

function channelOrigin(channel, adapter = 'auto') {
  const base = new URL(String(channel.base_url || channel.baseUrl || ''));
  if (base.protocol !== 'https:') throw new WalletError('invalid_target');
  const known = KNOWN_PANELS.get(base.hostname.toLowerCase());
  if (known && (adapter === 'auto' || adapter === known.adapter)) return known.origin;
  return base.origin;
}

function knownPanel(channel) {
  try {
    return KNOWN_PANELS.get(new URL(String(channel.base_url || '')).hostname.toLowerCase()) || null;
  } catch {
    return null;
  }
}

function balanceResult(value, currency, adapter) {
  const balance = Number(value);
  if (!Number.isFinite(balance)) throw new WalletError('schema_invalid');
  return { balance, currency: currency || null, adapter, fetchedAt: new Date().toISOString() };
}

function normalizeSub2RefreshToken(value) {
  const trimmed = String(value || '').trim();
  const cookie = trimmed.match(/(?:^|;\s*)refresh_token=([^;]+)/i);
  if (!cookie) return trimmed;
  try {
    return decodeURIComponent(cookie[1].trim());
  } catch {
    return cookie[1].trim();
  }
}

function refreshTokenFromHeaders(headers) {
  const values = headers?.['set-cookie'];
  const cookies = Array.isArray(values) ? values : values ? [values] : [];
  for (const value of cookies) {
    const match = String(value).match(/(?:^|,\s*)refresh_token=([^;,\s]+)/i);
    if (!match) continue;
    try {
      return decodeURIComponent(match[1]);
    } catch {
      return match[1];
    }
  }
  return null;
}

function refreshCredentialError(error) {
  return ['unauthorized', 'http_4xx', 'schema_invalid'].includes(error?.code);
}

async function mapConcurrent(values, limit, worker) {
  const queue = [...values];
  const results = [];
  await Promise.all(Array.from({ length: Math.min(limit, queue.length) }, async () => {
    while (queue.length) {
      const value = queue.shift();
      results.push(await worker(value));
    }
  }));
  return results;
}

export class WalletService {
  constructor({ client, store, refreshIntervalMs = DEFAULT_REFRESH_INTERVAL_MS, request = safeJsonRequest } = {}) {
    this.client = client;
    this.store = store;
    this.refreshIntervalMs = refreshIntervalMs;
    this.request = request;
    this.timer = null;
    this.refreshPromise = null;
    this.accountFlights = new Map();
    this.manualAttempts = new Map();
    this.lastManualAllAt = 0;
  }

  async start() {
    if (this.timer) return;
    const schedule = () => {
      const jitter = Math.floor(this.refreshIntervalMs * (0.9 + Math.random() * 0.2));
      this.timer = setTimeout(async () => {
        try {
          await this.refreshAll();
        } catch {
          // A scheduled probe must not terminate the console process.
        } finally {
          schedule();
        }
      }, jitter);
      this.timer.unref?.();
    };
    schedule();
  }

  async stop() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (this.refreshPromise) await this.refreshPromise.catch(() => {});
  }

  async channels() {
    const value = await this.client.channels();
    return Array.isArray(value) ? value : Array.isArray(value?.items) ? value.items : [];
  }

  async refreshAll({ onlyId = null, manual = false } = {}) {
    const targetId = onlyId === null ? null : normalizeChannelId(onlyId);
    if (this.refreshPromise && targetId === null) return this.refreshPromise;
    const run = async () => {
      const channels = await this.channels();
      await this.store.reconcileChannels(channels);
      const targets = channels.filter((channel) => (targetId === null || normalizeChannelId(channel.id) === targetId) && (manual || Number(channel.status) === 1));
      await mapConcurrent(targets, MAX_CONCURRENCY, (channel) => this.refreshChannel(channel, { manual }));
      return this.store.snapshot();
    };
    if (targetId !== null) return run();
    this.refreshPromise = run().finally(() => { this.refreshPromise = null; });
    return this.refreshPromise;
  }

  async manualRefresh(channelId) {
    const id = normalizeChannelId(channelId);
    const last = this.manualAttempts.get(id) || 0;
    if (Date.now() - last < MANUAL_MIN_INTERVAL_MS) throw Object.assign(new Error('Wallet refresh is rate limited'), { statusCode: 429 });
    this.manualAttempts.set(id, Date.now());
    return this.refreshAll({ onlyId: id, manual: true });
  }

  async manualRefreshAll() {
    if (Date.now() - this.lastManualAllAt < MANUAL_MIN_INTERVAL_MS) {
      throw Object.assign(new Error('Wallet refresh is rate limited'), { statusCode: 429 });
    }
    this.lastManualAllAt = Date.now();
    return this.refreshAll({ manual: true });
  }

  async detect(channel) {
    const known = knownPanel(channel);
    if (known) return { adapter: known.adapter, result: null };
    if (ownGateway(channel, this.client?.baseUrl)) return { adapter: 'none', result: null };
    try {
      const relay = await this.readRelayBalance(channel);
      if (relay) return { adapter: 'newapi', result: relay };
    } catch (error) {
      if (error?.code && error.code !== 'endpoint_unsupported') return { adapter: 'newapi', result: null, error };
    }
    try {
      const result = await this.client.probeWallet(channel.id);
      if (result?.status === 'ok' && result.source !== 'local') return { adapter: 'newapi', result: balanceResult(result.balance, result.currency || channelCurrency(channel), 'newapi') };
    } catch {}

    let origin;
    try {
      origin = channelOrigin(channel);
    } catch {
      return { adapter: 'none', result: null };
    }
    try {
      const payload = await this.request({ origin, pathname: '/api/v1/announcements' });
      if (payload && typeof payload === 'object' && ('code' in payload || 'data' in payload)) return { adapter: 'sub2', result: null };
    } catch {}
    try {
      const payload = await this.request({ origin, pathname: '/configs' });
      if (payload && typeof payload === 'object') return { adapter: 'rightcode', result: null };
    } catch {}
    return { adapter: 'none', result: null };
  }

  async refreshChannel(channel, { manual = false } = {}) {
    const id = normalizeChannelId(channel.id);
    let state = this.store.state(id);
    if (!manual && state.status === 'needs_reauth') return this.store.publicState(id);
    if (!manual && state.nextAttemptAt && Date.parse(state.nextAttemptAt) > Date.now()) return this.store.publicState(id);
    await this.store.updateChannel(id, { lastAttemptAt: new Date().toISOString() });
    state = this.store.state(id);
    let adapter = state.adapter === 'auto' ? state.detectedAdapter : state.adapter;
    const known = state.adapter === 'auto' ? knownPanel(channel) : null;
    if (known && adapter !== known.adapter) {
      adapter = known.adapter;
      await this.store.updateChannel(id, {
        detectedAdapter: adapter,
        status: 'stale',
        balance: null,
        currency: null,
        fetchedAt: null,
        errorClass: null,
      });
      state = this.store.state(id);
    }
    let prefetched = null;
    let relayError = null;
    if (!adapter) {
      const detected = await this.detect(channel);
      adapter = detected.adapter;
      prefetched = detected.result;
      relayError = detected.error || null;
      await this.store.updateChannel(id, { detectedAdapter: adapter, status: adapter === 'none' ? 'unsupported' : 'stale' });
    }
    if (adapter === 'none') return this.store.updateChannel(id, { status: 'unsupported', errorClass: null });

    try {
      if (relayError) throw relayError;
      let result = prefetched;
      if (!result && adapter === 'newapi') {
        if (ownGateway(channel, this.client?.baseUrl)) throw new WalletError('invalid_target');
        const credential = state.accountKey ? this.store.credential(state.accountKey) : null;
        if (credential?.current) {
          result = await this.readNewAPIUserBalance(credential.origin, credential.current);
        } else {
          const relay = await this.readRelayBalance(channel);
          if (relay) result = relay;
        }
      }
      if (!result && adapter === 'newapi') {
        const payload = await this.client.probeWallet(channel.id);
        if (payload?.status !== 'ok' || payload.source === 'local') throw new WalletError(payload?.error_class || 'probe_failed');
        result = balanceResult(payload.balance, payload.currency || channelCurrency(channel), 'newapi');
      } else if (!result && (adapter === 'sub2' || adapter === 'rightcode')) {
        if (!state.accountKey || !this.store.credential(state.accountKey)) {
          return this.store.updateChannel(id, { status: 'unconfigured', balance: null, currency: null, errorClass: null });
        }
        result = await this.refreshAccount(state.accountKey, adapter);
      }
      return this.store.updateChannel(id, {
        detectedAdapter: adapter,
        status: 'ok',
        balance: result.balance,
        currency: result.currency,
        fetchedAt: result.fetchedAt,
        errorClass: null,
        failureCount: 0,
        nextAttemptAt: null,
      });
    } catch (error) {
      const current = this.store.state(id);
      const failureCount = current.failureCount + 1;
      const unauthorized = error?.code === 'unauthorized' || error?.code === 'needs_reauth';
      const delay = Math.min(this.refreshIntervalMs * (2 ** Math.min(failureCount - 1, 4)), 6 * 60 * 60 * 1000);
      return this.store.updateChannel(id, {
        status: unauthorized ? 'needs_reauth' : 'error',
        errorClass: String(error?.code || 'probe_failed'),
        failureCount,
        nextAttemptAt: new Date(Date.now() + delay).toISOString(),
      });
    }
  }

  refreshAccount(key, adapter) {
    if (this.accountFlights.has(key)) return this.accountFlights.get(key);
    const flight = (adapter === 'sub2' ? this.refreshSub2(key) : this.refreshRightCode(key))
      .finally(() => this.accountFlights.delete(key));
    this.accountFlights.set(key, flight);
    return flight;
  }

  async refreshRightCode(key) {
    const credential = this.store.credential(key);
    const payload = await this.request({
      origin: credential.origin,
      pathname: '/auth/me',
      headers: { authorization: `Bearer ${credential.current}` },
    });
    return balanceResult(payload?.balance, knownCurrency(credential.origin), 'rightcode');
  }

  async refreshSub2(key) {
    let credential = this.store.credential(key);
    const expiresAt = Date.parse(credential.accessExpiresAt || '');
    if (credential.accessToken && Number.isFinite(expiresAt) && expiresAt - Date.now() > 60 * 1000) {
      try {
        return await this.readSub2Balance(credential.origin, credential.accessToken);
      } catch (error) {
        if (error?.code !== 'unauthorized') throw error;
      }
    }

    await this.store.updateAccount(key, { pendingRefresh: true });
    credential = this.store.credential(key);
    const candidates = [...new Set([credential.current, credential.previous]
      .map(normalizeSub2RefreshToken)
      .filter(Boolean))];
    let refreshed = null;
    let usedRefreshToken = null;
    for (const candidate of candidates) {
      try {
        const response = await this.request({
          origin: credential.origin,
          pathname: '/api/v1/auth/refresh',
          method: 'POST',
          body: { refresh_token: candidate },
          returnMeta: true,
        });
        const payload = response?.payload ?? response;
        const data = payload?.data;
        const rotatedToken = data?.refresh_token || refreshTokenFromHeaders(response?.headers);
        if (Number(payload?.code) !== 0 || !data?.access_token || !rotatedToken || !Number.isFinite(Number(data.expires_in))) {
          throw new WalletError('schema_invalid');
        }
        refreshed = { ...data, refresh_token: rotatedToken };
        usedRefreshToken = candidate;
        break;
      } catch (error) {
        if (!refreshCredentialError(error)) throw error;
      }

      try {
        const response = await this.request({
          origin: credential.origin,
          pathname: '/api/v1/auth/refresh',
          method: 'POST',
          headers: { cookie: `refresh_token=${encodeURIComponent(candidate)}` },
          body: {},
          returnMeta: true,
        });
        const payload = response?.payload ?? response;
        const data = payload?.data;
        const rotatedToken = data?.refresh_token || refreshTokenFromHeaders(response?.headers);
        if (Number(payload?.code) !== 0 || !data?.access_token || !rotatedToken || !Number.isFinite(Number(data.expires_in))) {
          throw new WalletError('schema_invalid');
        }
        refreshed = { ...data, refresh_token: rotatedToken };
        usedRefreshToken = candidate;
        break;
      } catch (error) {
        if (!refreshCredentialError(error)) throw error;
      }
    }
    if (!refreshed) throw new WalletError('needs_reauth');
    const accessExpiresAt = new Date(Date.now() + Number(refreshed.expires_in) * 1000).toISOString();
    await this.store.updateAccount(key, {
      current: refreshed.refresh_token,
      previous: usedRefreshToken,
      accessToken: refreshed.access_token,
      accessExpiresAt,
      pendingRefresh: false,
    });
    return this.readSub2Balance(credential.origin, refreshed.access_token);
  }

  async readRelayBalance(channel) {
    if (knownPanel(channel) || ownGateway(channel, this.client?.baseUrl)) return null;
    const key = usableRelayKey(channel);
    if (!key) return null;
    let origin;
    try {
      origin = channelOrigin(channel);
    } catch (error) {
      if (error?.code === 'invalid_target') return null;
      throw error;
    }
    const headers = { authorization: `Bearer ${key}` };
    let usage;
    try {
      usage = await this.request({ origin, pathname: '/api/usage/token/', headers });
    } catch (error) {
      if (error?.code === 'endpoint_unsupported') return null;
      throw error;
    }
    const status = await this.request({ origin, pathname: '/api/status' });
    return balanceResult(relayQuotaBalance(usage, status), channelCurrency(channel) || 'USD', 'newapi');
  }

  async readNewAPIUserBalance(origin, accessToken) {
    const headers = { authorization: `Bearer ${accessToken}` };
    const [self, status] = await Promise.all([
      this.request({ origin, pathname: '/api/user/self', headers }),
      this.request({ origin, pathname: '/api/status' }),
    ]);
    const quota = Number(self?.data?.quota);
    const unit = Number(status?.data?.quota_per_unit);
    if (self?.success !== true || !Number.isFinite(quota) || quota < 0 || !Number.isFinite(unit) || unit <= 0) {
      throw new WalletError('schema_invalid');
    }
    return balanceResult(quota / unit, null, 'newapi');
  }

  async readSub2Balance(origin, accessToken) {
    const timezone = encodeURIComponent('Asia/Shanghai');
    const payload = await this.request({
      origin,
      pathname: `/api/v1/auth/me?timezone=${timezone}`,
      headers: { authorization: `Bearer ${accessToken}`, 'x-user-ui-request': 'true' },
    });
    if (Number(payload?.code) !== 0) throw new WalletError('schema_invalid');
    return balanceResult(payload?.data?.balance, knownCurrency(origin), 'sub2');
  }
}

function knownCurrency(origin) {
  try {
    return KNOWN_CURRENCIES.get(new URL(origin).hostname.toLowerCase()) || null;
  } catch {
    return null;
  }
}

function usableRelayKey(channel) {
  const key = String(channel?.key || '').trim();
  if (key.length < 8 || key.includes('*')) return '';
  return key;
}

function ownGateway(channel, baseUrl) {
  try {
    const target = new URL(String(channel?.base_url || channel?.baseUrl || ''));
    const targetHost = target.hostname.replace(/^\[|\]$/g, '').toLowerCase();
    if (targetHost === 'localhost' || targetHost === '127.0.0.1' || targetHost === '::1') return true;
    const own = new URL(String(baseUrl || ''));
    return own.hostname.replace(/^\[|\]$/g, '').toLowerCase() === targetHost;
  } catch {
    return false;
  }
}

function relayQuotaBalance(usage, status) {
  const data = usage?.data;
  if (!usage || usage.code !== true || !data || typeof data !== 'object') throw new WalletError('schema_invalid');
  let remaining = Number(data.total_available);
  const userRemaining = Number(data.user_quota?.total_available);
  if (data.unlimited_quota) {
    if (!Number.isFinite(userRemaining)) throw new WalletError('unlimited_quota');
    remaining = userRemaining;
  } else if (Number.isFinite(userRemaining)) {
    remaining = Math.min(remaining, userRemaining);
  }
  const unit = Number(status?.data?.quota_per_unit);
  if (!Number.isFinite(remaining) || remaining < 0 || !Number.isFinite(unit) || unit <= 0) throw new WalletError('schema_invalid');
  const balance = remaining / unit;
  if (!Number.isFinite(balance) || Math.abs(balance) > 1e12) throw new WalletError('schema_invalid');
  return balance;
}
function channelCurrency(channel) {
  try {
    return KNOWN_CURRENCIES.get(new URL(String(channel.base_url || channel.baseUrl || '')).hostname.toLowerCase()) || null;
  } catch {
    return null;
  }
}

export {
  DEFAULT_REFRESH_INTERVAL_MS,
  KNOWN_CURRENCIES,
  KNOWN_PANELS,
  MANUAL_MIN_INTERVAL_MS,
  MAX_BODY_BYTES,
  WalletError,
  channelOrigin,
  isEdgeChallengeResponse,
  isPublicAddress,
  safeJsonRequest,
};


