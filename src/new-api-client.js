const DEFAULT_LOG_PAGE_INTERVAL_MS = 600;

function trimBaseUrl(value) {
  const url = new URL(value || "http://localhost:3001");
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('New API URL must use http or https');
  url.pathname = url.pathname.replace(/\/+$/, '');
  url.search = '';
  url.hash = '';
  return url.toString().replace(/\/$/, '');
}

function cookieFrom(response) {
  if (typeof response.headers.getSetCookie === 'function') {
    return response.headers.getSetCookie().map((item) => item.split(';', 1)[0]).join('; ');
  }
  const value = response.headers.get('set-cookie');
  return value ? value.split(';', 1)[0] : '';
}

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export class NewApiClient {
  constructor({ baseUrl, adminToken, username, password, pricingSyncSecret, fetchImpl = fetch, logPageIntervalMs = DEFAULT_LOG_PAGE_INTERVAL_MS } = {}) {
    this.baseUrl = trimBaseUrl(baseUrl);
    this.adminToken = String(adminToken || '');
    this.username = username || '';
    this.password = password || '';
	this.pricingSyncSecret = pricingSyncSecret || '';
    this.fetch = fetchImpl;
    this.cookie = '';
    this.accessToken = '';
    this.accessExpiresAt = 0;
    this.sessionId = '';
    this.userId = null;
    this.currentUser = null;
    this.loginPromise = null;
    const requestedLogPageInterval = Number(logPageIntervalMs);
    this.logPageIntervalMs = Number.isFinite(requestedLogPageInterval)
      ? Math.max(0, requestedLogPageInterval)
      : DEFAULT_LOG_PAGE_INTERVAL_MS;
    this.logPageQueue = [];
    this.logPageWorker = null;
    this.logPageSequence = 0;
    this.lastLogPageAt = 0;
  }

  configured() {
    return Boolean(this.adminToken || (this.username && this.password));
  }

  pricingSyncConfigured() {
    return Boolean(this.adminToken);
  }

  setCredentials(username, password) {
    const nextUsername = String(username || '');
    const nextPassword = String(password || '');
    const unchanged = this.username === nextUsername && this.password === nextPassword;
    this.username = nextUsername;
    this.password = nextPassword;
    if (unchanged) return;
    this.resetAuth();
  }

  resetAuth() {
    this.cookie = '';
    this.accessToken = '';
    this.accessExpiresAt = 0;
    this.sessionId = '';
    this.userId = null;
    this.currentUser = null;
  }

  clearCredentials() {
    this.username = '';
    this.password = '';
    this.resetAuth();
  }

  async login() {
    if (!this.configured()) throw new Error('NEW_API_ADMIN_TOKEN is required');
    if (this.currentUser && this.userId && (this.cookie || this.accessToken)) return this.currentUser;
    if (this.loginPromise) return this.loginPromise;
    this.loginPromise = (async () => {
      const response = await this.fetch(`${this.baseUrl}/api/user/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ username: this.username, password: this.password }),
      });
      const payload = await response.json().catch(() => ({}));
      const userId = payload.data?.user?.id ?? payload.data?.id;
      if (!response.ok || !payload.success || !userId) {
        throw Object.assign(new Error(payload.message || `New API login failed with HTTP ${response.status}`), {
          status: response.status,
          code: payload.code || null,
        });
      }
      this.cookie = cookieFrom(response);
      this.accessToken = String(payload.data?.access_token || '');
      this.accessExpiresAt = Number(payload.data?.access_expires_at || 0);
      this.sessionId = String(payload.data?.session?.sid || payload.data?.session?.id || '');
      this.userId = userId;
      this.currentUser = payload.data?.user ?? payload.data;
      return this.currentUser;
    })();
    try {
      return await this.loginPromise;
    } finally {
      this.loginPromise = null;
    }
  }

  async refreshAuth() {
    if (!this.cookie || !this.sessionId) throw new Error('New API refresh session is unavailable');
    const response = await this.fetch(`${this.baseUrl}/api/user/auth/refresh`, {
      method: 'POST',
      headers: {
        accept: 'application/json',
        cookie: this.cookie,
        'x-auth-session': this.sessionId,
      },
      signal: AbortSignal.timeout(20000),
    });
    const payload = await response.json().catch(() => ({}));
    const userId = payload.data?.user?.id ?? this.userId;
    if (!response.ok || !payload.success || !payload.data?.access_token || !userId) {
      throw Object.assign(new Error(payload.message || `New API refresh failed with HTTP ${response.status}`), {
        status: response.status,
        code: payload.code || null,
      });
    }
    this.cookie = cookieFrom(response) || this.cookie;
    this.accessToken = String(payload.data.access_token);
    this.accessExpiresAt = Number(payload.data.access_expires_at || 0);
    this.sessionId = String(payload.data?.session?.sid || payload.data?.session?.id || this.sessionId);
    this.userId = userId;
    this.currentUser = payload.data?.user ?? this.currentUser;
    return this.currentUser;
  }

  async request(pathname, { method = 'GET', body, auth = true, retry = true, timeoutMs = 20000, headers: extraHeaders = {} } = {}) {
    const useAdminToken = auth && Boolean(this.adminToken);
    if (auth && !useAdminToken && (!this.userId || (!this.cookie && !this.accessToken))) await this.login();
    const headers = { accept: 'application/json' };
	Object.assign(headers, extraHeaders);
    if (body !== undefined) headers['content-type'] = 'application/json';
    if (useAdminToken) {
      headers.authorization = `Bearer ${this.adminToken}`;
    } else if (auth) {
      headers['new-api-user'] = String(this.userId);
      if (this.cookie) headers.cookie = this.cookie;
      if (this.accessToken) headers.authorization = `Bearer ${this.accessToken}`;
    }
    const response = await this.fetch(`${this.baseUrl}${pathname}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (auth && !useAdminToken && response.status === 401 && retry) {
      try {
        await this.refreshAuth();
      } catch {
        this.resetAuth();
        await this.login();
      }
      return this.request(pathname, { method, body, auth, retry: false, timeoutMs, headers: extraHeaders });
    }
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || payload.success === false) {
      const error = new Error(payload.message || `New API returned HTTP ${response.status}`);
      error.status = response.status;
      error.code = payload.code || null;
      throw error;
    }
    return payload.data ?? payload;
  }

  status() {
    return this.request('/api/status', { auth: false });
  }

  channels() {
    return this.request('/api/channel/?p=0&page_size=100');
  }

  requestLogPage(pathname, { priority = 0 } = {}) {
    return new Promise((resolve, reject) => {
      this.logPageQueue.push({
        pathname,
        priority: Number.isFinite(Number(priority)) ? Number(priority) : 0,
        sequence: this.logPageSequence++,
        resolve,
        reject,
      });
      this.drainLogPageQueue();
    });
  }

  drainLogPageQueue() {
    if (this.logPageWorker) return this.logPageWorker;
    this.logPageWorker = (async () => {
      while (this.logPageQueue.length) {
        this.logPageQueue.sort((left, right) => right.priority - left.priority || left.sequence - right.sequence);
        const job = this.logPageQueue.shift();
        try {
          const remaining = this.logPageIntervalMs - (Date.now() - this.lastLogPageAt);
          if (remaining > 0) await wait(remaining);
          job.resolve(await this.request(job.pathname));
        } catch (error) {
          job.reject(error);
        } finally {
          this.lastLogPageAt = Date.now();
        }
      }
    })().finally(() => {
      this.logPageWorker = null;
      if (this.logPageQueue.length) this.drainLogPageQueue();
    });
    return this.logPageWorker;
  }

  async logs({ type = 2, startTimestamp = 0, endTimestamp = 0, pageSize = 100, maxPages = null, priority = 0 } = {}) {
    const effectivePageSize = Math.max(1, Math.min(100, Math.floor(Number(pageSize) || 100)));
    const effectiveMaxPages = maxPages === null || maxPages === undefined
      ? Infinity
      : Math.max(1, Math.floor(Number(maxPages) || 1));
    const items = [];
    let page = 1;
    let firstPage = null;
    let truncated = false;

    while (true) {
      const query = new URLSearchParams({ p: String(page), page_size: String(effectivePageSize), type: String(type) });
      if (startTimestamp) query.set('start_timestamp', String(startTimestamp));
      if (endTimestamp) query.set('end_timestamp', String(endTimestamp));
      const result = await this.requestLogPage(`/api/log/?${query}`, { priority });
      const pageItems = Array.isArray(result?.items) ? result.items : [];
      firstPage ||= result;
      items.push(...pageItems);

      const total = Number(result?.total);
      const hasMore = pageItems.length >= effectivePageSize
        && (!Number.isFinite(total) || items.length < total);
      if (!hasMore) break;
      if (page >= effectiveMaxPages) {
        truncated = true;
        break;
      }
      page += 1;
    }

    return {
      ...(firstPage && typeof firstPage === 'object' ? firstPage : {}),
      page: 1,
      page_size: items.length,
      total: Number.isFinite(Number(firstPage?.total)) ? Number(firstPage.total) : items.length,
      page_count: page,
      truncated,
      items,
    };
  }

  recentLogs({ type = 2, startTimestamp = 0, endTimestamp = 0, limit = 100 } = {}) {
    const effectiveLimit = Math.max(1, Math.min(200, Math.floor(Number(limit) || 100)));
    const pageSize = Math.min(100, effectiveLimit);
    return this.logs({
      type,
      startTimestamp,
      endTimestamp,
      pageSize,
      maxPages: Math.ceil(effectiveLimit / pageSize),
      priority: 10,
    });
  }

  perfMetrics(model, hours, group = '') {
    const query = new URLSearchParams({ model, hours: String(hours) });
    if (group) query.set('group', group);
    return this.request(`/api/perf-metrics?${query}`);
  }

  testChannel(id) {
    return this.request(`/api/channel/test/${encodeURIComponent(id)}`);
  }

  fetchModels({ type, baseUrl, key }) {
    return this.request('/api/channel/fetch_models', {
      method: 'POST',
      body: { type, base_url: baseUrl, key },
      timeoutMs: 30000,
    });
  }

  fetchSavedChannelModels(id) {
    return this.request(`/api/channel/fetch_models/${encodeURIComponent(id)}`, {
      timeoutMs: 30000,
    });
  }

  createChannel(channel) {
    return this.request('/api/channel/', {
      method: 'POST',
      body: { mode: 'single', channel },
      timeoutMs: 30000,
    });
  }

  updateChannelStatus(id, status) {
    return this.request(`/api/channel/${encodeURIComponent(id)}/status`, {
      method: 'POST',
      body: { status },
    });
  }

  updateChannelRouting(id, weight, priority, testModel = '', models = null, group = null) {
    const body = { id, weight, priority, test_model: testModel };
    if (models !== null) body.models = Array.isArray(models) ? models.join(',') : String(models);
    if (group !== null) body.group = Array.isArray(group) ? group.join(',') : String(group);
    return this.request('/api/channel/', {
      method: 'PUT',
      body,
    });
  }

  clearChannelAffinity(ruleName) {
    const query = new URLSearchParams({ rule_name: String(ruleName || '') });
    return this.request(`/api/option/channel_affinity_cache?${query}`, { method: 'DELETE' });
  }

  updateBalance(id) {
    return this.request(`/api/channel/update_balance/${encodeURIComponent(id)}`);
  }

  probeSub2Billing(id) {
    return this.request(`/api/channel/${encodeURIComponent(id)}/sub2-billing-probe`, {
      method: 'POST',
      body: {},
      timeoutMs: 15000,
    });
  }

  probeWallet(id) {
    return this.request(`/api/channel/${encodeURIComponent(id)}/wallet-probe`, {
      method: 'POST',
      body: {},
      timeoutMs: 15000,
    });
  }

  pricingTables() {
    if (!this.pricingSyncConfigured()) throw new Error('NEW_API_ADMIN_TOKEN is required');
    return this.request('/api/option/').then(pricingTablesFromOptions);
  }

  async applyPricingTables(expected, desired) {
    if (!this.pricingSyncConfigured()) throw new Error('NEW_API_ADMIN_TOKEN is required');
    const current = await this.pricingTables();
    for (const [key, option] of Object.entries(PRICING_OPTIONS)) {
      if (JSON.stringify(current[key]) !== JSON.stringify(expected[key])) {
        throw new Error('New API pricing tables changed; retry');
      }
    }
    for (const [key, option] of Object.entries(PRICING_OPTIONS)) {
      if (JSON.stringify(current[key]) === JSON.stringify(desired[key])) continue;
      await this.request('/api/option/', {
        method: 'PUT',
        body: { key: option, value: JSON.stringify(desired[key]) },
      });
    }
    return desired;
  }
}

const PRICING_OPTIONS = Object.freeze({
  model_ratio: 'ModelRatio',
  completion_ratio: 'CompletionRatio',
  cache_ratio: 'CacheRatio',
  create_cache_ratio: 'CreateCacheRatio',
});

function pricingTablesFromOptions(options) {
  const values = new Map((Array.isArray(options) ? options : []).map((item) => [item.key, item.value]));
  const table = {};
  for (const [key, option] of Object.entries(PRICING_OPTIONS)) {
    const raw = values.get(option);
    if (raw === undefined || raw === '') table[key] = {};
    else table[key] = typeof raw === 'string' ? JSON.parse(raw) : raw;
  }
  return table;
}

export { trimBaseUrl, PRICING_OPTIONS, pricingTablesFromOptions };
