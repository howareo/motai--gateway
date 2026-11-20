import { channelTypeInfo, CHANNEL_TYPE_DEFINITIONS } from '../channel-types.js';
import { normalizeChannelId } from '../channel-id.js';
import { assertContract, channelPoolIds } from './schema.js';

const VENDOR_TYPES = Object.freeze({ gemini: 'google', moonshotai: 'moonshot', 'moonshotai-cn': 'moonshot',
  kimi: 'moonshot', zai: 'zhipu', zhipuai: 'zhipu', glm: 'zhipu' });

function numericType(config, channel) {
  const vendors = new Set(channel.models.map((model) => config.models.find((row) => row.id === model.modelId)?.vendor).filter(Boolean));
  // Explicit vendor/pool metadata is a display hint, never an eligibility allowlist.
  const vendor = channel.adapter || (vendors.size === 1 ? [...vendors][0] : null);
  const info = vendor ? channelTypeInfo(VENDOR_TYPES[vendor] || vendor)
    : vendors.size === 0 ? channelTypeInfo(channel.poolId) : null;
  return Number(Object.entries(CHANNEL_TYPE_DEFINITIONS).find(([, value]) => value === info)?.[0] || 0);
}

// Only the billing contract enumerates error_class. The wallet contract does not, so its
// responses keep the generic class even if a newer core adds extra fields there.
const failed = (response, { billing = false } = {}) => ({ status: response.state === 'unsupported' ? 'unsupported' : 'failed',
  error_class: (billing && response.error_class)
    || (response.state === 'unsupported' ? 'endpoint_unsupported' : 'probe_failed'),
  observed_at: response.observed_at, source: response.source });

// Compatibility boundary for the existing CostStore and WalletService. Account
// management credentials and adapter requests remain in WalletService; model
// credentials are resolved exclusively by Go's narrow channel probe endpoints.
export class GatewayUpstreamClient {
  constructor({ client, getConfig, baseUrl = '' }) {
    if (!client || typeof getConfig !== 'function') throw new TypeError('Gateway client and public configuration provider required');
    this.client = client;
    this.getConfig = getConfig;
    this.baseUrl = baseUrl;
  }

  configured() { return Boolean(this.getConfig()); }

  async channels() {
    const config = this.getConfig();
    if (!config) return [];
    return config.channels.map((channel) => ({ id: normalizeChannelId(channel.id), name: channel.name,
      type: numericType(config, channel), status: channel.enabled ? 1 : 2, base_url: channel.baseUrl,
      models: channel.models.map((model) => model.modelId).join(','), test_model: channel.testModel || '',
      group: channelPoolIds(channel).join(','), pool_id: channel.poolId, poolId: channel.poolId,
      pool_ids: [...channelPoolIds(channel)], poolIds: [...channelPoolIds(channel)], poolPriorities: { ...channel.poolPriorities },
      priority: channel.priority, weight: channel.weight }));
  }

  channelId(value) {
    const id = normalizeChannelId(value);
    if (!this.getConfig()?.channels.some((channel) => channel.id === id)) {
      throw Object.assign(new Error('网关渠道不存在'), { code: 'channel_not_found', statusCode: 404 });
    }
    return id;
  }

  async probeSub2Billing(value) {
    const id = this.channelId(value);
    const response = await this.client.billingProbe(id);
    assertContract('billing_probe_response', response, { mode: 'read' });
    if (response.channel_id !== id) throw Object.assign(new Error('网关渠道响应不匹配'), { code: 'gateway_invalid_response', statusCode: 502 });
    if (response.state !== 'known') return failed(response, { billing: true });
    if (response.multiplier === null || response.source !== 'management_api') return { ...failed(response, { billing: true }), error_class: 'schema_invalid' };
    // upstream_group is optional: an older core omits it, and CostStore then keeps its previous behavior.
    return { status: 'ok', effective_rate_multiplier: response.multiplier, source: response.source, observed_at: response.observed_at,
      ...(Array.isArray(response.daily_costs) ? { dailyCosts: response.daily_costs } : {}),
      ...(typeof response.upstream_group === 'string' ? { upstream_group: response.upstream_group } : {}) };
  }

  async probeWallet(value) {
    const id = this.channelId(value);
    const response = await this.client.walletProbe(id);
    assertContract('wallet_probe_response', response, { mode: 'read' });
    if (response.channel_id !== id) throw Object.assign(new Error('网关渠道响应不匹配'), { code: 'gateway_invalid_response', statusCode: 502 });
    if (response.state !== 'known') return failed(response);
    if (response.balance === null || response.source !== 'account_wallet') return { ...failed(response), error_class: 'schema_invalid' };
    return { status: 'ok', balance: response.balance, currency: response.currency,
      source: response.source, observed_at: response.observed_at };
  }
}
