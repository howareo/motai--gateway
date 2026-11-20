import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { validateConfig } from './schema.js';

function fail(code, statusCode = 400) {
  throw Object.assign(new Error('调用令牌配置操作无效'), { code, statusCode });
}

function fields(value, allowed, code = 'invalid_caller_fields') {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).some((key) => !allowed.includes(key))) fail(code);
}

export function callerHashKey(value) {
  if (typeof value !== 'string' && !Buffer.isBuffer(value)) fail('caller_hash_key_unavailable', 503);
  const key = Buffer.from(value);
  if (key.length < 32 || key.length > 4096) fail('caller_hash_key_unavailable', 503);
  return key;
}

// The key comes from MOTAI_CALLER_HASH_KEY_FILE (raw bytes, the same file the core reads as MOTAI_HMAC_KEY_FILE, never trimmed)
// or from MOTAI_CALLER_HASH_KEY. A file that cannot be read leaves the key unavailable, as if it were not configured.
export function callerHashKeyFromEnvironment(env = process.env, readFile = readFileSync) {
  if (env.MOTAI_CALLER_HASH_KEY_FILE) {
    try { return readFile(env.MOTAI_CALLER_HASH_KEY_FILE); }
    catch (error) { console.warn(`[caller-keys] hash key file unreadable (${error?.code ?? 'error'})`); return null; }
  }
  return env.MOTAI_CALLER_HASH_KEY ?? null;
}

export function hashCallerToken(key, token) {
  return createHmac('sha256', callerHashKey(key)).update('motai-caller-v1\0').update(token).digest('hex');
}

export function issueCallerToken(key) {
  const checked = callerHashKey(key);
  const token = `sk-motai-${randomBytes(32).toString('base64url')}`;
  return { token, tokenHmac: hashCallerToken(checked, token) };
}

function permissions(input) {
  if (!Array.isArray(input)) fail('invalid_caller_permissions');
  return input.map((permission) => {
    fields(permission, ['poolId', 'modelIds', 'channelIds', 'protocols', 'groups'], 'invalid_caller_permissions');
    return structuredClone({ pool_id: permission.poolId, model_ids: permission.modelIds, channel_ids: permission.channelIds,
      protocols: permission.protocols, groups: permission.groups === undefined ? [] : permission.groups });
  });
}

// Publication, generation checks, token issuance and one-time delivery belong to the publisher.
export function reduceCallerChange(snapshot, change, { tokenHmac } = {}) {
  fields(change, ['action', 'callerId', 'caller']);
  if (!['create', 'update', 'enable', 'disable', 'rotate'].includes(change.action)) fail('invalid_caller_action');
  if (!validateConfig(snapshot.config, { credentials: snapshot.credentials }).valid) fail('invalid_contract');
  const { config, credentials } = structuredClone(snapshot);
  if (change.callerId !== undefined && typeof change.callerId !== 'string') fail('invalid_caller_id');
  let caller = config.callers.find((row) => row.id === change.callerId);
  if (change.action !== 'create' && !caller) fail('caller_not_found', 404);
  if (change.action === 'create' || change.action === 'update') {
    const input = change.caller;
    fields(input, ['id', 'name', 'enabled', 'subjectEnabled', 'expiresAt', 'allowedIps', 'permissions']);
    if (change.action === 'create') {
      if (change.callerId !== undefined || input.id !== undefined) fail('new_caller_id_is_server_owned');
      if (input.enabled !== undefined && input.enabled !== false) fail('new_caller_must_be_disabled');
      caller = { id: randomUUID(), name: input.name, enabled: false, subject_enabled: true,
        token_hmac: tokenHmac, expires_at: null, allowed_ips: [], permissions: [] };
      config.callers.push(caller);
    } else if (input.id !== undefined && input.id !== caller.id) fail('caller_id_mismatch');
    for (const [from, to] of [['name', 'name'], ['enabled', 'enabled'], ['subjectEnabled', 'subject_enabled'],
      ['expiresAt', 'expires_at'], ['allowedIps', 'allowed_ips']]) {
      if (input[from] !== undefined) caller[to] = structuredClone(input[from]);
    }
    if (typeof caller.name === 'string') caller.name = caller.name.trim();
    if (input.permissions !== undefined) caller.permissions = permissions(input.permissions);
  } else {
    if (change.caller !== undefined) fail('unexpected_caller_fields');
    if (change.action === 'enable') caller.enabled = true;
    if (change.action === 'disable') caller.enabled = false;
    if (change.action === 'rotate') {
      caller.token_hmac = tokenHmac;
      delete caller.token_hmac_aliases;
    }
  }
  if (!validateConfig(config, { credentials }).valid) fail('invalid_caller_config');
  return { config, credentials, callerId: caller.id };
}
