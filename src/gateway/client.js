import { assertContract, validateQuery } from './schema.js';

const MESSAGES = Object.freeze({
  gateway_unavailable: '网关内部服务暂不可用',
  gateway_timeout: '等待网关核心响应超时',
  gateway_invalid_response: '网关返回的数据不符合合同',
  gateway_log_unavailable: '网关日志存储暂不可用，本次未发送',
  stale_generation: '配置已更新，请刷新后再保存',
  stale_base_generation: '配置已更新，请刷新后再操作',
  channel_state_conflict: '渠道状态或凭据已变化，请刷新后重新确认',
  invalid_contract: '网关配置字段无效',
  invalid_config: '网关拒绝了待生效配置',
  desired_sync_failed: '配置指针已写入，但目录同步失败；尚未请求生效，请重试核对',
  discard_not_confirmed: '尚未确认该配置被拒绝，保留待核对配置',
  discard_initial_generation: '初始配置没有可恢复的基础代，请修复初始化配置',
});

export class GatewayError extends Error {
  constructor(code, statusCode = 502, retryable = false) {
    super(MESSAGES[code] || '网关操作失败');
    this.code = code;
    this.statusCode = statusCode;
    this.retryable = retryable;
  }
}

export class GatewayClient {
  constructor({ baseUrl, managementToken, fetchImpl = fetch, timeoutMs = 10_000, maxResponseBytes = 8 * 1024 * 1024 }) {
    const url = new URL(baseUrl);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash
      || !['/', '/internal/v1', '/internal/v1/'].includes(url.pathname)) throw new TypeError('Invalid gateway internal URL');
    if (typeof managementToken !== 'string' || !managementToken || /[\r\n]/.test(managementToken)) {
      throw new TypeError('Gateway management credential required');
    }
    this.origin = url.origin;
    this.token = managementToken;
    this.fetch = fetchImpl;
    this.timeoutMs = timeoutMs;
    this.maxResponseBytes = maxResponseBytes;
  }

  async request(method, pathname, { body, query, requestContract, responseContract, timeoutMs = this.timeoutMs }) {
    if (requestContract) assertContract(requestContract, body ?? query, { mode: 'write' });
    if (['attempts_query', 'stats_query'].includes(requestContract) && !validateQuery(requestContract, query).valid) {
      throw new GatewayError('invalid_contract', 400);
    }
    const url = new URL(`/internal/v1${pathname}`, this.origin);
    if (query) for (const [name, value] of Object.entries(query)) {
      if (value !== null) url.searchParams.set(name, Array.isArray(value) ? value.join(',') : String(value));
    }
    const signal = AbortSignal.timeout(timeoutMs);
    let response;
    try {
      response = await this.fetch(url, { method, redirect: 'manual', signal,
        headers: { authorization: `Bearer ${this.token}`, ...(body ? { 'content-type': 'application/json' } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}) });
    } catch { throw new GatewayError(signal.aborted ? 'gateway_timeout' : 'gateway_unavailable', signal.aborted ? 504 : 502); }
    let data;
    try {
      let size = 0;
      const chunks = [];
      for await (const chunk of response.body || []) {
        size += chunk.length;
        if (size > this.maxResponseBytes) throw new Error('response_limit');
        chunks.push(chunk);
      }
      data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      assertContract(response.ok ? responseContract : 'error_response', data, { mode: 'read' });
    } catch { throw new GatewayError(signal.aborted ? 'gateway_timeout' : 'gateway_invalid_response', signal.aborted ? 504 : 502); }
    if (!response.ok) throw new GatewayError(data.error.code, response.status, data.error.retryable);
    return data;
  }

  status() { return this.request('GET', '/status', { responseContract: 'status' }); }
  activate(body) { return this.request('POST', '/activate', { body, requestContract: 'activate_request', responseContract: 'activate_response' }); }
  events(query = { after_seq: '0', limit: 500 }) {
    return this.request('GET', '/events', { query, requestContract: 'events_query', responseContract: 'events_page' });
  }
  attempts(query) { return this.request('GET', '/attempts', { query, requestContract: 'attempts_query', responseContract: 'attempts_page' }); }
  stats(query) { return this.request('GET', '/stats', { query, requestContract: 'stats_query', responseContract: 'stats_response' }); }
  models(channelId) { return this.request('POST', `/channels/${encodeURIComponent(channelId)}/models`,
    { body: { format_version: 1 }, requestContract: 'models_request', responseContract: 'models_response' }); }
  preview(body) { return this.request('POST', '/models/preview', { body, requestContract: 'preview_request', responseContract: 'models_response' }); }
  probe(body) { return this.request('POST', '/probes', { body, requestContract: 'probe_request', responseContract: 'probe_response' }); }
  billingProbe(channelId) { return this.request('POST', `/channels/${encodeURIComponent(channelId)}/billing-probe`,
    // The core has a 10-second account probe budget; allow time for its error response to arrive.
    { body: { format_version: 1 }, requestContract: 'models_request', responseContract: 'billing_probe_response', timeoutMs: Math.max(this.timeoutMs, 15_000) }); }
  walletProbe(channelId) { return this.request('POST', `/channels/${encodeURIComponent(channelId)}/wallet-probe`,
    { body: { format_version: 1 }, requestContract: 'models_request', responseContract: 'wallet_probe_response', timeoutMs: Math.max(this.timeoutMs, 15_000) }); }
  resetAffinity(poolId, body) { return this.request('POST', `/pools/${encodeURIComponent(poolId)}/affinity-reset`,
    { body, requestContract: 'operation_request', responseContract: 'affinity_reset_response' }); }
  channelHealth() { return this.request('GET', '/channels/health', { responseContract: 'channel_health_response' }); }
  resetHealth(channelId, body) { return this.request('POST', `/channels/${encodeURIComponent(channelId)}/health-reset`,
    { body, requestContract: 'health_reset_request', responseContract: 'health_reset_response' }); }
  drain(body) { return this.request('POST', '/drain', { body, requestContract: 'operation_request', responseContract: 'drain_response' }); }
  resume(body) { return this.request('POST', '/resume', { body, requestContract: 'operation_request', responseContract: 'drain_response' }); }
}

export function publicGatewayStatus(status) {
  assertContract('status', status, { mode: 'read' });
  return { ready: status.ready, buildId: status.build_id, desiredGen: status.desired_gen,
    committedGen: status.committed_gen, servingGen: status.serving_gen, lkgGen: status.lkg_gen,
    degradedReasons: status.degraded_reasons, inFlight: status.in_flight,
    completionPending: status.completion_pending, probeCompletionQuarantined: status.probe_completion_quarantined ?? 0,
    latestSeq: status.latest_seq };
}
