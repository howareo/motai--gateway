import Ajv from 'ajv';
import { readFileSync } from 'node:fs';
import { isIP } from 'node:net';

const schemaNames = ['common', 'config', 'usage', 'records', 'internal-api'];
const schemas = schemaNames.map((name) => JSON.parse(readFileSync(new URL(`../../contracts/v1/${name}.schema.json`, import.meta.url), 'utf8')));
const prefix = 'https://motai.local/contracts/v1/';
// A permission list (model_ids, channel_ids or protocols) that is exactly ["*"] names everything that list can name:
// every model, every channel of the permission pool, every protocol.
export const WILDCARD_MODEL = '*';
const isWildcardList = (list) => list.length === 1 && list[0] === WILDCARD_MODEL;
export const permissionNamesModel = (permission, modelId) => isWildcardList(permission.model_ids) || permission.model_ids.includes(modelId);
export const permissionNamesChannel = (permission, channelId) => isWildcardList(permission.channel_ids) || permission.channel_ids.includes(channelId);
export const permissionNamesProtocol = (permission, protocol) => isWildcardList(permission.protocols) || permission.protocols.includes(protocol);
const contracts = {
  config: ['config', 'config'], manifest: ['config', 'manifest'], credentials: ['config', 'credentials'], desired_pointer: ['config', 'desired_pointer'],
  usage: ['usage', 'usage'], intent: ['records', 'intent'], terminal: ['records', 'terminal'],
  attempt: ['records', 'attempt'], event: ['records', 'event'],
  ...Object.fromEntries(Object.keys(schemas[4].definitions).map((name) => [name, ['internal-api', name]])),
};
const readable = new Set(['usage', 'intent', 'terminal', 'attempt', 'event', 'status', 'activate_response', 'events_page', 'attempts_page', 'stats_response', 'models_response', 'probe_response', 'affinity_reset_response', 'drain_response', 'billing_probe_response', 'wallet_probe_response', 'channel_health_response', 'health_reset_response', 'error_response']);

export function isUtc(value) {
  const parts = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?Z$/.exec(value);
  if (!parts) return false;
  const [, year, month, day, hour, minute, second] = parts.map(Number);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return year >= 1 && month >= 1 && month <= 12 && day >= 1 && day <= days[month - 1]
    && hour < 24 && minute < 60 && second < 60;
}

function isHttpUrl(value) {
  try {
    const url = new URL(value);
    return value.trim() === value && !/[\s\x00-\x1f\x7f\\]/.test(value)
      && ['http:', 'https:'].includes(url.protocol) && !!url.hostname
      && !url.username && !url.password && !url.hash && !url.search;
  } catch { return false; }
}

function isIpCidr(value) {
  const [address, mask, extra] = value.split('/');
  const family = isIP(address);
  return !!family && extra === undefined && (mask === undefined
    || (/^(0|[1-9][0-9]*)$/.test(mask) && Number(mask) <= (family === 4 ? 32 : 128)));
}

function allowReadAdditions(schema) {
  if (Array.isArray(schema)) return schema.map(allowReadAdditions);
  if (!schema || typeof schema !== 'object') return schema;
  return Object.fromEntries(Object.entries(schema).map(([key, value]) => [key,
    key === 'additionalProperties' && value === false ? true : allowReadAdditions(value)]));
}

function createValidator(read) {
  const ajv = new Ajv({ allErrors: true, strict: true, strictNumbers: true });
  ajv.addFormat('motai-utc', { type: 'string', validate: isUtc });
  ajv.addFormat('motai-http-url', { type: 'string', validate: isHttpUrl });
  ajv.addFormat('motai-ip-cidr', { type: 'string', validate: isIpCidr });
  for (const schema of schemas) {
    const copy = read && !['common', 'config'].some((name) => schema.$id === `${prefix}${name}.schema.json`)
      ? allowReadAdditions(schema) : schema;
    // Provider counters remain a persistence whitelist even when API DTOs gain optional fields.
    if (read && schema.$id === `${prefix}usage.schema.json`) copy.definitions.provider_counts = schema.definitions.provider_counts;
    ajv.addSchema(copy);
  }
  return ajv;
}

const validators = { write: createValidator(false), read: createValidator(true) };

export function validateContract(name, value, { mode = 'write' } = {}) {
  if (!Object.hasOwn(contracts, name)) throw new TypeError(`Unknown contract: ${name}`);
  if (!Object.hasOwn(validators, mode) || (mode === 'read' && !readable.has(name))) throw new TypeError(`Invalid contract mode: ${mode}/${name}`);
  const [file, definition] = contracts[name];
  const validate = validators[mode].getSchema(`${prefix}${file}.schema.json#/definitions/${definition}`);
  const valid = validate(value);
  // Never retain instance values or Ajv's additionalProperty parameter in public errors.
  return { valid, errors: valid ? [] : validate.errors.map(({ instancePath, keyword }) => ({ path: instancePath, code: `schema_${keyword}` })) };
}

export function assertContract(name, value, options) {
  const result = validateContract(name, value, options);
  if (!result.valid) {
    const error = new TypeError(`Invalid gateway contract: ${name}`);
    error.code = 'invalid_contract';
    error.validationErrors = result.errors;
    throw error;
  }
  return value;
}

function domainError(errors, path, code) { errors.push({ path, code }); }

export const channelPoolIds = (channel) => channel.pool_ids ?? channel.poolIds ?? [channel.pool_id ?? channel.poolId];
export const channelPriority = (channel, poolId) => {
  const priorities = channel.pool_priorities ?? channel.poolPriorities ?? {};
  return Object.hasOwn(priorities, poolId) ? priorities[poolId] : channel.priority;
};
export const orderedPoolChannels = (channels, poolId) => channels.filter((channel) => channelPoolIds(channel).includes(poolId))
  .sort((left, right) => channelPriority(right, poolId) - channelPriority(left, poolId)
    || (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));

export function validateUsage(usage, options) {
  const result = validateContract('usage', usage, options);
  if (!result.valid) return result;
  return usageRelations(usage, result.errors);
}

function usageRelations(usage, errors) {
  const counts = ['total_input', 'input_uncached', 'cache_read', 'output_total', 'reasoning']
    .map((key) => [key, usage[key]])
    .concat(Object.entries(usage.cache_write).filter(([key]) => ['ttl_5m', 'ttl_1h', 'ttl_unknown'].includes(key)).map(([key, count]) => [`cache_write/${key}`, count]));
  for (const [path, count] of counts) {
    if ((count.availability === 'absent') !== (count.value === null)
      || (count.provenance === 'absent') !== (count.availability === 'absent')
      || (count.availability === 'known' && count.provenance === 'adapter_estimate')
      || (count.availability === 'estimated' && count.provenance === 'provider')) {
      domainError(errors, `/${path}`, 'count_availability_mismatch');
    }
  }
  const input = [usage.input_uncached, usage.cache_read, usage.cache_write.ttl_5m, usage.cache_write.ttl_1h, usage.cache_write.ttl_unknown];
  if (usage.total_input.value !== null && input.every((count) => count.value !== null)
    && input.reduce((sum, count) => sum + BigInt(count.value), 0n) !== BigInt(usage.total_input.value)) {
    domainError(errors, '/total_input', 'input_breakdown_mismatch');
  }
  const caches = input.slice(1);
  if (usage.total_input.value !== null && caches.every((count) => count.value !== null)
    && caches.reduce((sum, count) => sum + BigInt(count.value), 0n) > BigInt(usage.total_input.value)
    && (usage.input_uncached.value !== null || !usage.issues.includes('cache_exceeds_input'))) {
    domainError(errors, '/input_uncached', 'cache_contradiction_unmarked');
  }
  if (usage.reasoning_relation === 'subset_of_output' && usage.reasoning.value !== null
    && usage.output_total.value !== null && usage.reasoning.value > usage.output_total.value) {
    domainError(errors, '/reasoning', 'reasoning_exceeds_output');
  }
  const providerPrefix = usage.provider === 'unknown' ? null : `${usage.provider}_`;
  if (Object.keys(usage.provider_counts).some((key) => !providerPrefix || !key.startsWith(providerPrefix))) {
    domainError(errors, '/provider_counts', 'provider_count_mismatch');
  }
  return { valid: errors.length === 0, errors };
}

export function validateConfig(config, { credentials, forbiddenTargets = [] } = {}) {
  const result = validateContract('config', config);
  if (!result.valid) return result;
  const { errors } = result;
  const unique = (rows, key, path) => {
    const seen = new Set();
    for (const [index, row] of rows.entries()) {
      if (seen.has(row[key])) domainError(errors, `/${path}/${index}/${key}`, 'duplicate_identity');
      seen.add(row[key]);
    }
    return seen;
  };
  const pools = unique(config.pools, 'id', 'pools');
  const models = unique(config.models, 'id', 'models');
  unique(config.channels, 'id', 'channels');
  unique(config.callers, 'id', 'callers');
  const callerTokens = new Set();
  for (const [callerIndex, caller] of config.callers.entries()) {
    for (const [index, tokenHmac] of [caller.token_hmac, ...(caller.token_hmac_aliases ?? [])].entries()) {
      const path = `/callers/${callerIndex}/${index === 0 ? 'token_hmac' : `token_hmac_aliases/${index - 1}`}`;
      if (callerTokens.has(tokenHmac)) domainError(errors, path, 'duplicate_identity');
      callerTokens.add(tokenHmac);
    }
  }
  const channels = new Map(config.channels.map((channel) => [channel.id, channel]));
  const targets = new Set(forbiddenTargets.map((target) => new URL(target).origin));
  for (const [index, channel] of config.channels.entries()) {
    if (!pools.has(channel.pool_id)) domainError(errors, `/channels/${index}/pool_id`, 'unknown_pool');
    if (!channelPoolIds(channel).includes(channel.pool_id)) domainError(errors, `/channels/${index}/pool_ids`, 'primary_pool_missing');
    for (const pool of channelPoolIds(channel)) if (!pools.has(pool)) domainError(errors, `/channels/${index}/pool_ids`, 'unknown_pool');
    for (const pool of Object.keys(channel.pool_priorities ?? {})) if (!channelPoolIds(channel).includes(pool)) domainError(errors, `/channels/${index}/pool_priorities`, 'priority_pool_outside_membership');
    if (targets.has(new URL(channel.base_url).origin)) domainError(errors, `/channels/${index}/base_url`, 'loop_target');
    unique(channel.models, 'model_id', `channels/${index}/models`);
    for (const model of channel.models) if (!models.has(model.model_id)) domainError(errors, `/channels/${index}/models`, 'unknown_model');
    if ((channel.credential_ref === null) !== (channel.credential_version === null)
      || (channel.enabled && channel.credential_ref === null)) domainError(errors, `/channels/${index}/credential_ref`, 'credential_state_invalid');
  }
  const aliases = new Set();
  for (const [index, alias] of config.aliases.entries()) {
    const identity = JSON.stringify([alias.pool_id, alias.alias]);
    if (aliases.has(identity) || models.has(alias.alias)) domainError(errors, `/aliases/${index}/alias`, 'alias_collision');
    aliases.add(identity);
    if (!pools.has(alias.pool_id) || !models.has(alias.model_id)) domainError(errors, `/aliases/${index}`, 'unknown_alias_target');
  }
  for (const [callerIndex, caller] of config.callers.entries()) {
    for (const [index, permission] of caller.permissions.entries()) {
      const path = `/callers/${callerIndex}/permissions/${index}`;
      if (!pools.has(permission.pool_id)) domainError(errors, path, 'unknown_permission_pool');
      // "*" in model_ids, channel_ids or protocols is valid only as the sole element of that list (same rule as the Go core).
      const wildcard = (list) => list.includes(WILDCARD_MODEL);
      const mixed = [permission.model_ids, permission.channel_ids, permission.protocols].some((list) => wildcard(list) && list.length !== 1);
      if (mixed) domainError(errors, path, 'permission_wildcard_mixed');
      else {
        if (!wildcard(permission.model_ids)) for (const model of permission.model_ids) if (!models.has(model)) domainError(errors, path, 'unknown_permission_model');
        if (!wildcard(permission.channel_ids)) for (const id of permission.channel_ids) {
          const channel = channels.get(id);
          if (!channel || !channelPoolIds(channel).includes(permission.pool_id)) domainError(errors, path, 'permission_channel_outside_pool');
        }
      }
    }
  }
  if (credentials !== undefined) {
    const checked = validateContract('credentials', credentials);
    errors.push(...checked.errors);
    if (checked.valid) {
      if (credentials.gen !== config.gen) domainError(errors, '/gen', 'credential_generation_mismatch');
      const refs = new Set();
      for (const [index, entry] of credentials.entries.entries()) {
        const key = JSON.stringify([entry.credential_ref, entry.credential_version]);
        if (refs.has(key)) domainError(errors, `/entries/${index}`, 'duplicate_credential');
        refs.add(key);
      }
      for (const [index, channel] of config.channels.entries()) if (channel.credential_ref !== null && !refs.has(JSON.stringify([channel.credential_ref, channel.credential_version]))) {
        domainError(errors, `/channels/${index}/credential_ref`, 'credential_reference_missing');
      }
    }
  }
  return { valid: errors.length === 0, errors };
}

export function validateRecord(name, record, options) {
  if (!['attempt', 'event'].includes(name)) throw new TypeError(`Invalid record contract: ${name}`);
  const result = validateContract(name, record, options);
  if (!result.valid) return result;
  return recordRelations(name, record, options, result.errors);
}

// A page schema already covers every nested event, attempt and usage schema.
// Run only their domain relations after that complete structural check.
export function validatePage(name, page, options) {
  if (!['events_page', 'attempts_page'].includes(name)) throw new TypeError(`Invalid page contract: ${name}`);
  const result = validateContract(name, page, options);
  if (!result.valid) return result;
  const eventPage = name === 'events_page';
  for (const record of page[eventPage ? 'events' : 'attempts']) {
    recordRelations(eventPage ? 'event' : 'attempt', record, options, result.errors);
    if (result.errors.length) return { valid: false, errors: result.errors };
  }
  return result;
}

function recordRelations(name, record, options, errors) {
  const attempt = name === 'event' ? record.attempt : record;
  const { intent, terminal } = attempt;
  usageRelations(terminal.usage, errors);
  if (intent.attempt_id !== terminal.attempt_id) domainError(errors, '/terminal/attempt_id', 'attempt_identity_mismatch');
  if (compareUtc(terminal.ended_at, intent.started_at) < 0) domainError(errors, '/terminal/ended_at', 'terminal_before_intent');
  if (terminal.ttft_ms !== null && terminal.ttft_ms > terminal.duration_ms) domainError(errors, '/terminal/ttft_ms', 'ttft_exceeds_duration');
  const localCount = options?.mode === 'read' && intent.protocol === 'count_tokens' && !intent.stream && terminal.upstream_status === null
    && terminal.send_certainty === 'none' && terminal.protocol_terminal === 'not_applicable';
  const completed = intent.stream ? terminal.protocol_terminal === 'completed'
    : ['completed', 'not_applicable'].includes(terminal.protocol_terminal);
  if (terminal.attempt_outcome === 'succeeded' && (terminal.request_outcome !== 'succeeded' || terminal.error_class !== null
    || !completed || (!localCount && (terminal.upstream_status === null || terminal.upstream_status < 200 || terminal.upstream_status > 299)))) {
    domainError(errors, '/terminal/attempt_outcome', 'success_semantics_mismatch');
  }
  if (terminal.attempt_outcome !== 'succeeded' && terminal.request_outcome === 'succeeded') domainError(errors, '/terminal/request_outcome', 'success_semantics_mismatch');
  if (terminal.attempt_outcome === 'not_sent' && terminal.send_certainty !== 'none') domainError(errors, '/terminal/send_certainty', 'not_sent_semantics_mismatch');
  return { valid: errors.length === 0, errors };
}

export function compareUtc(left, right) {
  const instant = (value) => {
    if (!isUtc(value)) throw new TypeError('Invalid UTC instant');
    const nanoseconds = (value.split('.')[1]?.slice(0, -1) ?? '').padEnd(9, '0');
    return BigInt(Date.parse(`${value.slice(0, 19)}Z`)) * 1000000n + BigInt(nanoseconds);
  };
  const a = instant(left);
  const b = instant(right);
  return a < b ? -1 : a > b ? 1 : 0;
}

export function validateQuery(name, query) {
  if (!['attempts_query', 'stats_query'].includes(name)) throw new TypeError(`Invalid query contract: ${name}`);
  const result = validateContract(name, query);
  if (!result.valid) return result;
  if (compareUtc(query.from, query.to) >= 0) domainError(result.errors, '/to', 'empty_or_reversed_interval');
  if (name === 'attempts_query' && query.cursor !== null && query.snapshot_seq === null) domainError(result.errors, '/snapshot_seq', 'cursor_requires_snapshot');
  return { valid: result.errors.length === 0, errors: result.errors };
}
