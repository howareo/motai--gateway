import { GatewayClient, GatewayError } from './client.js';
import { ConfigPublisher } from './config-publisher.js';
import { callerHashKeyFromEnvironment } from './caller-config.js';
import { assertContract } from './schema.js';

function exactObject(value, names) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).some((key) => !names.includes(key))) throw new GatewayError('invalid_contract', 400);
}

export class GatewayControl {
  constructor({ client, publisher }) { this.client = client; this.publisher = publisher; }

  load() { return this.publisher.load(); }
  status() { return this.publisher.status(); }
  config() { return this.publisher.snapshot(); }
  change(payload) {
    exactObject(payload, ['baseGen', 'operationId', 'change']);
    return this.publisher.change(payload);
  }
  callerChange(payload) {
    exactObject(payload, ['baseGen', 'operationId', 'change']);
    return this.publisher.callerChange(payload);
  }
  reconcile() { return this.publisher.activateDesired(); }
  discard(payload) {
    exactObject(payload, ['gen', 'manifestSha256']);
    if (typeof payload.gen !== 'string' || !/^(0|[1-9][0-9]*)$/.test(payload.gen) || payload.gen.length > 80
      || typeof payload.manifestSha256 !== 'string' || !/^[0-9a-f]{64}$/.test(payload.manifestSha256)) {
      throw new GatewayError('invalid_contract', 400);
    }
    return this.publisher.discardDesired(payload);
  }

  async channelHealth() {
    const response = await this.client.channelHealth();
    assertContract('channel_health_response', response, { mode: 'read' });
    const ids = new Set();
    for (const channel of response.channels) {
      const identity = JSON.stringify([channel.channel_id, channel.pool_id ?? null]);
      if (ids.has(identity)) throw new GatewayError('gateway_invalid_response');
      ids.add(identity);
    }
    return { gen: response.gen, channels: response.channels.map((channel) => ({ channelId: channel.channel_id,
      ...(channel.pool_id === undefined ? {} : { poolId: channel.pool_id }),
      credentialVersion: channel.credential_version, state: channel.state, stateVersion: channel.state_version,
      observedAt: channel.observed_at })) };
  }

  async resetHealth(channelId, payload) {
    exactObject(payload, ['baseGen', 'operationId', 'credentialVersion', 'stateVersion', 'poolId']);
    const body = { format_version: 1, operation_id: payload.operationId, expected_gen: payload.baseGen,
      ...(payload.poolId === undefined ? {} : { pool_id: payload.poolId }),
      expected_credential_version: payload.credentialVersion, expected_state_version: payload.stateVersion };
    try { assertContract('health_reset_request', body); } catch { throw new GatewayError('invalid_contract', 400); }
    const response = await this.client.resetHealth(channelId, body);
    assertContract('health_reset_response', response, { mode: 'read' });
    if (response.channel_id !== channelId || response.operation_id !== payload.operationId
      || (payload.poolId !== undefined && response.pool_id !== payload.poolId)
      || response.credential_version !== payload.credentialVersion) throw new GatewayError('gateway_invalid_response');
    return { channelId, ...(response.pool_id === undefined ? {} : { poolId: response.pool_id }), credentialVersion: response.credential_version, state: response.state,
      stateVersion: response.state_version, changed: response.changed };
  }

  async preview(payload) {
    exactObject(payload, ['channelId', 'baseGen', 'baseUrl', 'capabilities', 'adapter', 'credentialAction', 'credentialValue', 'confirmRetainedCredential']);
    if (payload.adapter !== undefined && typeof payload.adapter !== 'string') throw new GatewayError('invalid_contract', 400);
    const snapshot = this.publisher.current;
    if (payload.baseGen !== (snapshot?.config.gen ?? null)) throw new GatewayError('stale_generation', 409);
    if (!['keep', 'replace'].includes(payload.credentialAction)) throw new GatewayError('invalid_contract', 400);
    const channel = snapshot?.config.channels.find((row) => row.id === payload.channelId);
    let credential;
    if (payload.credentialAction === 'keep') {
      if (!channel || payload.credentialValue !== undefined) throw new GatewayError('invalid_contract', 400);
      if (payload.baseUrl !== channel.base_url && payload.confirmRetainedCredential !== true) {
        throw new GatewayError('retained_credential_confirmation_required', 409);
      }
      credential = snapshot.credentials.entries.find((entry) => entry.credential_ref === channel.credential_ref
        && entry.credential_version === channel.credential_version)?.secret;
      if (!credential) throw new GatewayError('invalid_contract', 400);
    } else {
      credential = payload.credentialValue;
      if (typeof credential !== 'string' || !credential) throw new GatewayError('invalid_contract', 400);
    }
    const adapter = payload.adapter ?? channel?.adapter;
    const request = { format_version: 1, base_url: payload.baseUrl, credential,
      channel_id: null, capabilities: payload.capabilities, ...(adapter ? { adapter } : {}) };
    assertContract('preview_request', request);
    const response = await this.client.preview(request);
    return { models: response.models.map((entry) => ({ id: entry.id, capabilities: [...entry.capabilities] })),
      observedAt: response.observed_at };
  }
}

export function gatewayControlFromEnvironment(env = process.env) {
  if (!env.MOTAI_GATEWAY_INTERNAL_URL) return null;
  if (!env.MOTAI_GATEWAY_CONFIG_DIR) throw new TypeError('MOTAI_GATEWAY_CONFIG_DIR required');
  const client = new GatewayClient({ baseUrl: env.MOTAI_GATEWAY_INTERNAL_URL, managementToken: env.MOTAI_GATEWAY_MANAGEMENT_TOKEN });
  const forbiddenTargets = [env.MOTAI_GATEWAY_INTERNAL_URL, ...(env.MOTAI_GATEWAY_MODEL_URL ? [env.MOTAI_GATEWAY_MODEL_URL] : [])];
  return new GatewayControl({ client, publisher: new ConfigPublisher({ directory: env.MOTAI_GATEWAY_CONFIG_DIR, client, forbiddenTargets,
    callerHashKey: callerHashKeyFromEnvironment(env) }) });
}
