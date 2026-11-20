import { randomUUID } from 'node:crypto';
import { parseModelList } from '../../public/shared/model-list.js';
import { channelPoolIds, channelPriority, orderedPoolChannels, validateConfig } from './schema.js';

function fail(code, statusCode = 400) {
  throw Object.assign(new Error('渠道配置操作无效'), { code, statusCode });
}

function fields(value, allowed) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).some((key) => !allowed.includes(key))) fail('invalid_channel_fields');
}

function mapModels(config, input, existing) {
  if (input.models === undefined) {
    if (!existing) fail('channel_models_required');
    if (input.protocol !== undefined || input.vendor !== undefined) fail('channel_models_required');
    return structuredClone(existing.models);
  }
  if (!Array.isArray(input.models) || input.models.length === 0) fail('channel_models_required');
  const models = input.models.map((value) => {
    const model = typeof value === 'string' ? { modelId: value } : value;
    fields(model, ['modelId', 'upstreamModel', 'capabilities', 'vendor']);
    if (typeof model.modelId !== 'string' || parseModelList([model.modelId]).length !== 1
      || parseModelList([model.modelId])[0] !== model.modelId) fail('invalid_model_id');
    const known = config.models.find((row) => row.id === model.modelId);
    const vendor = model.vendor ?? input.vendor ?? known?.vendor;
    if (!vendor || (known && known.vendor !== vendor)) fail('model_vendor_conflict');
    if (!known) config.models.push({ id: model.modelId, vendor });
    const previous = existing?.models.find((row) => row.model_id === model.modelId);
    const capabilities = model.capabilities ?? (input.protocol === undefined ? previous?.capabilities : [input.protocol]);
    if (!Array.isArray(capabilities)) fail('model_protocol_required');
    return { model_id: model.modelId, upstream_model: model.upstreamModel ?? previous?.upstream_model ?? model.modelId,
      capabilities: [...capabilities] };
  });
  return models;
}

function updateAliases(config, input, channel) {
  if (input.aliases === undefined) return;
  if (!Array.isArray(input.aliases)) fail('invalid_aliases');
  for (const alias of input.aliases) {
    fields(alias, ['alias', 'modelId']);
    if (!channel.models.some((model) => model.model_id === alias.modelId)) fail('alias_outside_channel_models');
    for (const poolId of channelPoolIds(channel)) {
      const existing = config.aliases.find((row) => row.pool_id === poolId && row.alias === alias.alias);
      if (existing && existing.model_id !== alias.modelId) fail('alias_conflict');
      if (!existing) config.aliases.push({ alias: alias.alias, model_id: alias.modelId, pool_id: poolId });
    }
  }
}

function applyCredential(credentials, channel, action, value, fresh) {
  if (!['keep', 'replace', 'clear'].includes(action)) fail('credential_action_required');
  if (action !== 'replace' && value !== undefined) fail('unexpected_credential_value');
  if (action === 'keep') {
    if (fresh) fail('new_channel_credential_required');
    return;
  }
  if (action === 'clear') {
    if (fresh) fail('new_channel_credential_required');
    if (channel.enabled) fail('credential_clear_requires_disabled');
    channel.credential_ref = null;
    channel.credential_version = null;
    return;
  }
  if (typeof value !== 'string' || !value || value.length > 16384) fail('invalid_credential');
  const hadCredential = channel.credential_ref !== null;
  if (!hadCredential) channel.credential_ref = randomUUID();
  let version = BigInt(channel.credential_version ?? '0');
  for (const entry of credentials.entries) if (entry.credential_ref === channel.credential_ref && BigInt(entry.credential_version) > version) {
    version = BigInt(entry.credential_version);
  }
  channel.credential_version = fresh || !hadCredential ? '1' : (version + 1n).toString();
  credentials.entries.push({ credential_ref: channel.credential_ref, credential_version: channel.credential_version, secret: value });
}

function removeUnusedCredentials(config, credentials) {
  credentials.entries = credentials.entries.filter((entry) => config.channels.some((channel) =>
    channel.credential_ref === entry.credential_ref && channel.credential_version === entry.credential_version));
}

function savePoolOrder(poolId, channels) {
  // Unique priorities reuse the core's ordered fallback without changing other pool memberships.
  channels.forEach((channel, index) => {
    channel.pool_priorities = { ...channel.pool_priorities, [poolId]: channels.length - index };
  });
}

// The publisher owns generation, serialization, durable files and activation. This reducer only edits one snapshot.
export function reduceChannelChange(snapshot, change) {
  fields(change, ['action', 'channelId', 'poolId', 'position', 'channel', 'newPools', 'credentialAction', 'credentialValue', 'confirmRetainedCredential']);
  const before = validateConfig(snapshot.config, { credentials: snapshot.credentials });
  if (!before.valid) fail('invalid_contract');
  const { config, credentials } = structuredClone(snapshot);
  const permissionChanges = [];
  const actions = ['create', 'update', 'enable', 'disable', 'delete', 'primary', 'reorder'];
  if (!actions.includes(change.action)) fail('invalid_channel_action');
  if (change.newPools !== undefined && !['create', 'update'].includes(change.action)) fail('unexpected_channel_fields');
  if (change.poolId !== undefined && !['primary', 'reorder'].includes(change.action)) fail('unexpected_channel_fields');
  if (change.position !== undefined && change.action !== 'reorder') fail('unexpected_channel_fields');
  if (change.channelId !== undefined && typeof change.channelId !== 'string') fail('invalid_channel_id');
  let channel = config.channels.find((row) => row.id === change.channelId);
  if (change.action !== 'create' && !channel) fail('channel_not_found', 404);
  if (change.action === 'create' || change.action === 'update') {
    const input = change.channel;
    fields(input, ['name', 'poolId', 'poolIds', 'poolPriorities', 'adapter', 'vendor', 'protocol', 'baseUrl', 'models', 'aliases', 'priority', 'weight', 'enabled', 'accountRef', 'testModel']);
    const existing = channel;
    if (existing && input.baseUrl !== undefined && input.baseUrl !== existing.base_url
      && (change.credentialAction ?? 'keep') === 'keep' && change.confirmRetainedCredential !== true) {
      fail('retained_credential_confirmation_required', 409);
    }
    if (change.action === 'create') {
      if (change.channelId !== undefined) fail('new_channel_id_is_server_owned');
      channel = { id: randomUUID(), name: input.name, pool_id: input.poolId, enabled: false,
        priority: input.priority ?? 0, weight: input.weight ?? 10, base_url: input.baseUrl,
        credential_ref: randomUUID(), credential_version: '0', account_ref: input.accountRef ?? null, models: [] };
      if (input.enabled !== undefined && input.enabled !== false) fail('new_channel_must_be_disabled');
    } else {
      channel = { ...existing,
        name: input.name === undefined ? existing.name : input.name,
        pool_id: input.poolId === undefined ? existing.pool_id : input.poolId,
        base_url: input.baseUrl === undefined ? existing.base_url : input.baseUrl,
        enabled: input.enabled === undefined ? existing.enabled : input.enabled,
        priority: input.priority === undefined ? existing.priority : input.priority,
        weight: input.weight === undefined ? existing.weight : input.weight,
        account_ref: input.accountRef === undefined ? existing.account_ref : input.accountRef };
    }
    if (input.poolIds !== undefined) channel.pool_ids = structuredClone(input.poolIds);
    if (input.poolPriorities !== undefined) channel.pool_priorities = structuredClone(input.poolPriorities);
    if (change.newPools !== undefined) {
      if (!Array.isArray(change.newPools) || change.newPools.length > 1000) fail('invalid_new_pools');
      for (const pool of change.newPools) {
        fields(pool, ['id', 'name']);
        if (typeof pool.id !== 'string' || pool.id.length > 128 || !/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/.test(pool.id)
          || typeof pool.name !== 'string' || !pool.name.trim() || pool.name !== pool.name.trim() || pool.name.length > 120
          || !Array.isArray(channelPoolIds(channel)) || !channelPoolIds(channel).includes(pool.id)) fail('invalid_new_pool');
        if (config.pools.some((row) => row.id === pool.id || row.name.toLowerCase() === pool.name.toLowerCase())) fail('pool_already_exists', 409);
        config.pools.push({ id: pool.id, name: pool.name });
      }
    }
    if (input.adapter === '') delete channel.adapter;
    else if (input.adapter !== undefined) channel.adapter = input.adapter;
    channel.models = mapModels(config, input, existing);
    applyCredential(credentials, channel, change.credentialAction ?? (existing ? 'keep' : undefined), change.credentialValue, !existing);
    if (existing) config.channels[config.channels.indexOf(existing)] = channel;
    else config.channels.push(channel);
    updateAliases(config, input, channel);
    for (const poolId of channelPoolIds(channel)) {
      const peers = orderedPoolChannels(config.channels, poolId);
      if (!existing || !channelPoolIds(existing).includes(poolId)) {
        savePoolOrder(poolId, [...peers.filter((row) => row.id !== channel.id), channel]);
      } else if (channelPriority(channel, poolId) !== channelPriority(existing, poolId)) {
        savePoolOrder(poolId, peers);
      }
    }
  } else {
    if (change.channel !== undefined || change.credentialAction !== undefined || change.credentialValue !== undefined) fail('unexpected_channel_fields');
    if (change.action === 'enable') {
      channel.enabled = true;
      for (const poolId of channelPoolIds(channel)) savePoolOrder(poolId, orderedPoolChannels(config.channels, poolId));
    }
    if (change.action === 'disable') channel.enabled = false;
    if (change.action === 'primary' || change.action === 'reorder') {
      if (!channel.enabled) fail('primary_requires_enabled');
      const poolId = change.poolId ?? (channelPoolIds(channel).length === 1 ? channel.pool_id : null);
      if (!poolId || !channelPoolIds(channel).includes(poolId)) fail('primary_pool_required');
      const peers = orderedPoolChannels(config.channels, poolId);
      const position = change.action === 'primary' ? 1 : change.position;
      if (!Number.isSafeInteger(position) || position < 1 || position > peers.length) fail('invalid_channel_position');
      const ordered = peers.filter((row) => row.id !== channel.id);
      ordered.splice(position - 1, 0, channel);
      savePoolOrder(poolId, ordered);
    }
    if (change.action === 'delete') {
      config.channels = config.channels.filter((row) => row.id !== channel.id);
      for (const caller of config.callers) {
        const affected = caller.permissions.filter((permission) => permission.channel_ids.includes(channel.id));
        if (affected.length) permissionChanges.push({ callerId: caller.id, removedChannelId: channel.id,
          removedPermissions: affected.filter((permission) => permission.channel_ids.length === 1).map((permission) => ({
            poolId: permission.pool_id, modelIds: [...permission.model_ids], channelIds: [...permission.channel_ids],
            protocols: [...permission.protocols], groups: [...permission.groups] })) });
        caller.permissions = caller.permissions.map((permission) => ({ ...permission,
          channel_ids: permission.channel_ids.filter((id) => id !== channel.id) })).filter((permission) => permission.channel_ids.length);
      }
      config.aliases = config.aliases.filter((alias) => config.channels.some((row) => channelPoolIds(row).includes(alias.pool_id)
        && row.models.some((model) => model.model_id === alias.model_id)));
    }
  }
  removeUnusedCredentials(config, credentials);
  const checked = validateConfig(config, { credentials });
  if (!checked.valid) {
    const permissions = checked.errors.some((error) => error.path.startsWith('/callers/'));
    fail(permissions ? 'channel_permission_conflict' : 'invalid_channel_config');
  }
  const result = { config, credentials, channelId: channel.id, permissionChanges };
  if (Object.hasOwn(change.channel || {}, 'testModel')) {
    if (typeof change.channel.testModel !== 'string' || !channel.models.some((model) => model.model_id === change.channel.testModel)) fail('invalid_test_model');
    result.metadataPatch = { channelId: channel.id, testModel: change.channel.testModel };
  }
  return result;
}
