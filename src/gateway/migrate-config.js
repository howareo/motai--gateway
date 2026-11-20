import Ajv from 'ajv';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { callerHashKey, hashCallerToken } from './caller-config.js';
import { channelPoolIds, isUtc, permissionNamesChannel, permissionNamesModel, permissionNamesProtocol, validateConfig, WILDCARD_MODEL } from './schema.js';

const id = { type: 'string', pattern: '^[A-Za-z0-9][A-Za-z0-9_.:-]*$', maxLength: 128 };
const text = { type: 'string', minLength: 1, maxLength: 256 };
const integer = { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER };
const signedInteger = { type: 'integer', minimum: Number.MIN_SAFE_INTEGER, maximum: Number.MAX_SAFE_INTEGER };
const bool = { type: 'boolean' };
const array = (items, maxItems = 10000) => ({ type: 'array', items, maxItems, uniqueItems: true });
const object = (properties, required = Object.keys(properties)) => ({ type: 'object', properties, required, additionalProperties: false });
const protocols = { enum: ['responses', 'chat_completions', 'messages', 'count_tokens', 'gemini_generate_content'] };
const adapter = { enum: ['openai', 'anthropic', 'deepseek', 'xai', 'gemini', 'moonshot'] };
const model = object({ model_id: text, upstream_model: text, vendor: text, capabilities: { ...array(protocols, 5), minItems: 1 } });
// channel_ids and protocols may also be exactly ["*"] (checked by validateConfig); model_ids is free text and already admits it.
const wildcard = { const: WILDCARD_MODEL };
const permission = object({ pool_id: id, model_ids: { ...array(text), minItems: 1 },
  channel_ids: { ...array({ anyOf: [id, wildcard] }), minItems: 1 }, protocols: { ...array({ anyOf: [protocols, wildcard] }, 5), minItems: 1 }, groups: array(id, 1000) });
const failure = object({ max_attempts: integer, ordinary_failure_threshold: integer,
  ordinary_failure_window_seconds: integer, cooldown_seconds: integer, retry_after_max_seconds: integer });
const utc = { type: 'string', format: 'utc' };
const headerName = { type: 'string', pattern: '^[A-Za-z0-9!#$%&\'`+.^_~-]+$', maxLength: 128 };
const legacyRule = object({ name: text, model_regex: array(text, 100), path_regex: array(text, 100),
  user_agent_include: array(text, 100), key_sources: { ...array(object({ type: { const: 'gjson' }, path: text }), 20), minItems: 1 },
  value_regex: { type: 'string', maxLength: 256 }, ttl_seconds: signedInteger,
  skip_retry_on_failure: bool, include_using_group: bool, include_model_name: bool, include_rule_name: bool,
  passthrough_headers: array(headerName, 64) });
const legacyAffinity = object({ profile: { const: 'new_api_conditional_rules_v1' }, observed_at: utc,
  enabled: bool, default_ttl_seconds: integer, switch_on_success: bool, keep_on_channel_disabled: bool,
  max_entries: integer, rules: { ...array(legacyRule, 1000), minItems: 1 } });
const legacyFailure = object({ profile: { const: 'new_api_native_retry_v1' }, observed_at: utc,
  retry_times: integer, automatic_disable_channel_enabled: bool, channel_disable_threshold: integer,
  affinity_rules_skip_retry: array(object({ rule_name: text, skip_retry_on_failure: bool }), 1000) });
const noCharge = object({ mode: { const: 'disable_local_commercial_charge' },
  user_ids: { ...array(id, 10000), minItems: 1 } });
const channelMapping = object({ source_id: id, pool_id: id, enabled: bool,
  credential_ref: id, credential_version: { type: 'string', pattern: '^(0|[1-9][0-9]*)$', maxLength: 80 },
  account_ref: { anyOf: [id, { type: 'null' }] } });
const inputSchema = object({
  format_version: { const: 1 }, source_id: id, snapshot_at: { type: 'string', format: 'utc' },
  evidence: object({ complete: bool, snapshot_consistent: bool, feature_inventory_complete: bool,
    permissions_complete: bool, capabilities_complete: bool, group_resolution_complete: bool,
    features: array(id, 1000),
    affinity: { anyOf: [object({ enabled: bool, ttl_seconds: integer, model_isolated: bool,
      coverage: { enum: ['all_channels', 'partial'] }, fallback: { enum: ['session_or_caller', 'session_only'] } }), legacyAffinity] },
    failure_policy: { anyOf: [failure, legacyFailure] } }),
  source: object({
    channels: array(object({ id, name: text, status: integer, base_url: text, priority: integer, weight: integer,
      key: { type: 'string', minLength: 1, maxLength: 16384 }, groups: { ...array(id, 1000), minItems: 1 },
      models: { ...array(model), minItems: 1 }, features: array(id, 1000), adapter },
    ['id', 'name', 'status', 'base_url', 'priority', 'weight', 'key', 'groups', 'models', 'features'])),
    users: array(object({ id, status: integer, group: id, quota_enforced: bool,
      quota_balance: { anyOf: [{ type: 'string', pattern: '^(0|[1-9][0-9]*)$', maxLength: 80 }, { type: 'null' }] },
      features: array(id, 1000) }, ['id', 'status', 'group', 'quota_enforced', 'features'])),
    callers: array(object({ id, name: text, user_id: id, status: integer,
      key: { type: 'string', minLength: 1, maxLength: 128 },
      wire_token: { type: 'string', minLength: 1, maxLength: 4096 },
      expired_time: { type: 'integer', minimum: -1, maximum: 253402300799 },
      unlimited_quota: bool, remain_quota: signedInteger, model_limits_enabled: bool,
      model_limits: { type: 'string', maxLength: 1000000 }, allow_ips: { type: ['string', 'null'], maxLength: 100000 },
      group: { type: 'string', maxLength: 128 }, cross_group_retry: bool, auto_groups: array(id, 1000),
      effective_groups: array(id, 1000), features: array(id, 1000) },
    ['id', 'name', 'user_id', 'status', 'key', 'expired_time', 'unlimited_quota', 'remain_quota',
      'model_limits_enabled', 'model_limits', 'allow_ips', 'group', 'cross_group_retry', 'auto_groups', 'effective_groups', 'features'])),
  }),
  plan: object({ gen: { type: 'string', pattern: '^(0|[1-9][0-9]*)$', maxLength: 80 },
    pools: { ...array(object({ id, name: text, group: id })), minItems: 1 },
    channels: array({ ...channelMapping, properties: { ...channelMapping.properties,
      pool_ids: { ...array(id, 1000), minItems: 1 } } }),
    callers: array(object({ source_id: id, id, enabled: bool, permissions: array(permission) })),
    no_charge: noCharge,
    affinity: object({ enabled: { const: true }, ttl_seconds: integer, scope_version: { const: 1 } }),
    failure_policy: failure, accept_changes: array(id, 1000),
  }, ['gen', 'pools', 'channels', 'callers', 'affinity', 'failure_policy', 'accept_changes']),
});
const ajv = new Ajv({ allErrors: true, strict: true, allowUnionTypes: true });
ajv.addFormat('utc', isUtc);
const checkInput = ajv.compile(inputSchema);
const MAX_ROUTES = 100000;

// The strict profile deliberately does not reinterpret New API's wildcard/model families.
function normalizedFamily(modelId) {
  return modelId.includes('*') || /^gpt-4o?-gizmo/.test(modelId)
    || (/^gemini-2\.5-(flash|pro)/.test(modelId) && modelId.includes('-thinking-'));
}

function ipLimits(raw) {
  return [...new Set((raw ?? '').replaceAll(' ', '').split('\n').map((ip) => ip.trim().replaceAll(',', '')).filter(Boolean))];
}

function route(group, modelId, channelId, protocol) {
  return { group, model_id: modelId, channel_id: channelId, protocol };
}
const routeKey = (row) => JSON.stringify([row.group, row.model_id, row.channel_id, row.protocol]);
function addRoute(rows, row, budget) {
  const identity = routeKey(row);
  if (rows.has(identity)) return;
  if (++budget.used > MAX_ROUTES) throw Object.assign(new Error('Route matrix limit'), { code: 'route_matrix_too_large' });
  rows.set(identity, row);
}

const codexTraceHeaders = [
  'Originator', 'Session_id', 'Thread_id', 'Session-Id', 'Thread-Id', 'X-Client-Request-Id', 'User-Agent',
  'X-Codex-Beta-Features', 'X-Codex-Turn-State', 'X-Codex-Turn-Metadata', 'X-Codex-Window-Id',
  'X-Codex-Parent-Thread-Id', 'X-OpenAI-Subagent', 'X-OpenAI-Memgen-Request',
  'X-ResponsesAPI-Include-Timing-Metrics', 'X-OpenAI-Internal-Codex-Responses-Lite',
];
const claudeCliTraceHeaders = [
  'X-Stainless-Arch', 'X-Stainless-Lang', 'X-Stainless-Os', 'X-Stainless-Package-Version',
  'X-Stainless-Retry-Count', 'X-Stainless-Runtime', 'X-Stainless-Runtime-Version', 'X-Stainless-Timeout',
  'User-Agent', 'X-App', 'Anthropic-Beta', 'Anthropic-Dangerous-Direct-Browser-Access', 'Anthropic-Version',
];
const sameItems = (a, b) => a.length === b.length && a.every((value) => b.includes(value));
const protocolPaths = { responses: '/v1/responses', chat_completions: '/v1/chat/completions',
  messages: '/v1/messages', count_tokens: '/v1/messages/count_tokens', gemini_generate_content: '/v1beta/models/model:generateContent' };
const pointerSegment = (value) => String(value).replaceAll('~', '~0').replaceAll('/', '~1');

// This recognizes only the two measured legacy header rules (Codex Responses and
// Claude CLI messages). It does not grant an accept_changes escape hatch for
// arbitrary overrides or unknown features.
function legacyPolicyCoverage(affinity, plan, block) {
  const coverage = [];
  const activePermissions = plan.callers.filter((caller) => caller.enabled).flatMap((caller) => caller.permissions);
  const names = new Set();
  for (const [index, rule] of affinity.rules.entries()) {
    const path = `/evidence/affinity/rules/${index}`;
    if (names.has(rule.name)) block('duplicate_legacy_rule_name', path);
    names.add(rule.name);
    let modelRegex, pathRegex;
    try {
      modelRegex = rule.model_regex.map((value) => new RegExp(value));
      pathRegex = rule.path_regex.map((value) => new RegExp(value));
      if (rule.value_regex) new RegExp(rule.value_regex);
    } catch { block('legacy_rule_regex_invalid', path); continue; }
    const active = affinity.enabled && activePermissions.some((permission) =>
      permission.model_ids.some((modelId) => !modelRegex.length || modelId === WILDCARD_MODEL || modelRegex.some((regex) => regex.test(modelId)))
      && permission.protocols.some((protocol) => !pathRegex.length
        || (protocol === WILDCARD_MODEL ? Object.values(protocolPaths) : [protocolPaths[protocol]]).some((path) => pathRegex.some((regex) => regex.test(path)))));
    const codex = sameItems(rule.model_regex, ['^gpt-.*$', '^grok-.*$'])
      && sameItems(rule.path_regex, ['/v1/responses']) && !rule.user_agent_include.length && rule.value_regex === ''
      && rule.key_sources.length === 1 && rule.key_sources[0].type === 'gjson' && rule.key_sources[0].path === 'prompt_cache_key'
      && sameItems(rule.passthrough_headers.map((value) => value.toLowerCase()), codexTraceHeaders.map((value) => value.toLowerCase()));
    const claude = sameItems(rule.model_regex, ['^claude-.*$'])
      && sameItems(rule.path_regex, ['/v1/messages']) && !rule.user_agent_include.length && rule.value_regex === ''
      && rule.key_sources.length === 1 && rule.key_sources[0].type === 'gjson' && rule.key_sources[0].path === 'metadata.user_id'
      && sameItems(rule.passthrough_headers.map((value) => value.toLowerCase()), claudeCliTraceHeaders.map((value) => value.toLowerCase()));
    const headerCompatibility = !rule.passthrough_headers.length ? 'none'
      : !active ? 'deferred_outside_enabled_scope' : codex ? 'codex_trace_headers_v1'
        : claude ? 'claude_cli_trace_headers_v1' : 'unsupported';
    if (headerCompatibility === 'unsupported') block('conditional_header_passthrough_unsupported', path);
    coverage.push({ rule_name: rule.name, active_in_candidate: active,
      effective_ttl_seconds: rule.ttl_seconds > 0 ? rule.ttl_seconds : affinity.default_ttl_seconds || 3600,
      header_count: rule.passthrough_headers.length, header_compatibility: headerCompatibility });
  }
  return coverage;
}

/** Pure, offline and fail closed. Source evidence is supplied by the exporter, never inferred from channel type. */
export function migrateConfig(input, { sourceId, callerHashKey: rawHashKey } = {}) {
  const report = { format_version: 1, source_id: null, snapshot_at: null, mode: 'offline',
    ready: false, readiness_scope: 'offline_candidate_only', migration_complete: false, evidence_verified_live: false,
    field_evidence: { missing: [], unknown: [] },
    blockers: [], changes: [], channel_mappings: [], caller_mappings: [], permissions: [], reachable_tuple_diffs: [] };
  const fieldEvidence = (kind, path, reason) => {
    if (!path || report.field_evidence[kind].some((item) => item.path === path && item.reason === reason)) return;
    report.field_evidence[kind].push({ path, reason });
  };
  const block = (code, path = '') => report.blockers.push({ code, path });
  const change = (code, path = '', details = {}) => report.changes.push({ code, path, ...details });
  if (!checkInput(input)) {
    // Paths and reasons only: neither invalid values nor unknown field names reach the report.
    for (const error of checkInput.errors) {
      const path = error.keyword === 'required'
        ? `${error.instancePath}/${pointerSegment(error.params.missingProperty)}` : error.instancePath;
      block(`input_${error.keyword}`, path);
      if (error.keyword === 'required') fieldEvidence('missing', path, 'required');
      if (error.keyword === 'additionalProperties') {
        const unknownPath = `${error.instancePath}/${pointerSegment(error.params.additionalProperty)}`;
        fieldEvidence('unknown', unknownPath, 'additional_property');
      }
    }
    return { report };
  }
  if (typeof sourceId !== 'string' || sourceId !== input.source_id) block('source_id_mismatch', '/source_id');
  report.source_id = input.source_id;
  report.snapshot_at = input.snapshot_at;
  const { source, plan, evidence } = input;
  const legacyAffinityProfile = evidence.affinity.profile === 'new_api_conditional_rules_v1';
  if (legacyAffinityProfile) {
    report.policy_rule_coverage = legacyPolicyCoverage(evidence.affinity, plan, block);
    report.required_core_compatibility = [...new Set(report.policy_rule_coverage
      .filter((row) => ['codex_trace_headers_v1', 'claude_cli_trace_headers_v1'].includes(row.header_compatibility))
      .map((row) => row.header_compatibility))];
  }
  report.no_charge_policy = plan.no_charge ? structuredClone(plan.no_charge) : null;
  for (const flag of ['complete', 'snapshot_consistent', 'feature_inventory_complete', 'permissions_complete', 'capabilities_complete', 'group_resolution_complete']) {
    if (!evidence[flag]) {
      const path = `/evidence/${flag}`;
      block(`evidence_${flag}_missing`, path);
      fieldEvidence('unknown', path, 'evidence_not_verified');
    }
  }
  const inventory = (features, path) => {
    for (const feature of features) {
      if (path === '/evidence' && legacyAffinityProfile
        && ['conditional_affinity_rules', 'conditional_header_passthrough'].includes(feature)) continue;
      block(`unsupported_feature:${feature}`, `${path}/features`);
      fieldEvidence('unknown', `${path}/features`, 'unsupported_feature');
    }
  };
  inventory(evidence.features, '/evidence');
  const indexed = (rows, path) => {
    const result = new Map();
    for (const [index, row] of rows.entries()) {
      if (result.has(row.id)) block('duplicate_source_identity', `${path}/${index}/id`);
      result.set(row.id, row);
      inventory(row.features, `${path}/${index}`);
    }
    return result;
  };
  const channels = indexed(source.channels, '/source/channels');
  const users = indexed(source.users, '/source/users');
  const callers = indexed(source.callers, '/source/callers');
  const noChargeUserIds = new Set(plan.no_charge?.user_ids ?? []);
  report.user_quota_audit = source.users.filter((user) => source.callers.some((caller) => caller.user_id === user.id))
    .map((user) => ({ source_user_id: user.id, quota_enforced: user.quota_enforced,
      quota_balance: user.quota_balance ?? null,
      callers: source.callers.filter((caller) => caller.user_id === user.id)
        .map(({ id: callerId, status, unlimited_quota, remain_quota }) =>
          ({ source_caller_id: callerId, status, unlimited_quota, remain_quota })) }));
  for (const [index, userId] of (plan.no_charge?.user_ids ?? []).entries()) {
    const user = users.get(userId), affected = source.callers.filter((caller) => caller.user_id === userId);
    if (!user) block('unknown_nocharge_source_user', `/plan/no_charge/user_ids/${index}`);
    else if (!user.quota_enforced) block('nocharge_user_quota_not_enforced', `/plan/no_charge/user_ids/${index}`);
    else if (user.quota_balance === null || user.quota_balance === undefined) block('nocharge_user_balance_unknown', `/source/users/${source.users.indexOf(user)}/quota_balance`);
    else if (!affected.length) block('nocharge_user_without_callers', `/plan/no_charge/user_ids/${index}`);
    else change('user_commercial_quota_removed', `/plan/no_charge/user_ids/${index}`,
      { source_user_id: user.id, affected_caller_ids: affected.map((caller) => caller.id),
        admission_change: 'User commercial quota is no longer enforced locally; bounded token quota remains enforced.' });
  }
  let key;
  try { key = callerHashKey(rawHashKey); } catch { block('caller_hash_key_missing_or_invalid'); }
  const config = { format_version: 1, gen: plan.gen,
    pools: plan.pools.map(({ id: poolId, name }) => ({ id: poolId, name })), models: [], channels: [], aliases: [], callers: [],
    affinity: structuredClone(plan.affinity), failure_policy: structuredClone(plan.failure_policy) };
  const credentials = { format_version: 1, gen: plan.gen, entries: [] };
  const poolGroups = new Map(plan.pools.map((pool) => [pool.id, pool.group]));
  const routeBudget = { used: 0 };
  const mappedChannels = new Set(), mappedCallers = new Set(), models = new Map(), credentialValues = new Map();
  for (const [index, mapping] of plan.channels.entries()) {
    const path = `/plan/channels/${index}`, old = channels.get(mapping.source_id);
    if (!old) { block('unknown_source_channel', path); continue; }
    if (mappedChannels.has(old.id)) block('duplicate_channel_mapping', path);
    mappedChannels.add(old.id);
    const group = poolGroups.get(mapping.pool_id);
    if (!channelPoolIds(mapping).includes(mapping.pool_id)) block('primary_pool_missing', path);
    for (const poolId of channelPoolIds(mapping)) {
      if (!poolGroups.has(poolId) || !old.groups.includes(poolGroups.get(poolId))) block('channel_pool_group_mismatch', path);
    }
    if (mapping.enabled && old.status !== 1) block('disabled_channel_expansion', path);
    if (!mapping.enabled && old.status === 1) change('channel_disabled', path);
    for (const model of old.models) {
      if (normalizedFamily(model.model_id)) block('model_normalization_unsupported', path);
      if (models.has(model.model_id) && models.get(model.model_id) !== model.vendor) block('model_vendor_conflict', path);
      models.set(model.model_id, model.vendor);
    }
    config.channels.push({ id: old.id, name: old.name, pool_id: mapping.pool_id, enabled: mapping.enabled,
      ...(mapping.pool_ids === undefined ? {} : { pool_ids: [...mapping.pool_ids] }),
      ...(old.adapter === undefined ? {} : { adapter: old.adapter }),
      priority: old.priority, weight: old.weight, base_url: old.base_url, credential_ref: mapping.credential_ref,
      credential_version: mapping.credential_version, account_ref: mapping.account_ref,
      models: old.models.map(({ vendor, ...model }) => structuredClone(model)) });
    const credentialKey = JSON.stringify([mapping.credential_ref, mapping.credential_version]);
    if (credentialValues.has(credentialKey) && credentialValues.get(credentialKey) !== old.key) block('credential_reference_collision', path);
    if (!credentialValues.has(credentialKey)) credentials.entries.push({ credential_ref: mapping.credential_ref,
      credential_version: mapping.credential_version, secret: old.key });
    credentialValues.set(credentialKey, old.key);
    report.channel_mappings.push({ source_id: old.id, target_id: old.id, pool_id: mapping.pool_id, group,
      pool_ids: [...channelPoolIds(mapping)], groups: channelPoolIds(mapping).map((poolId) => poolGroups.get(poolId)),
      ...(old.adapter === undefined ? {} : { adapter: old.adapter }),
      credential_ref: mapping.credential_ref, credential_version: mapping.credential_version,
      priority: old.priority, weight: old.weight });
  }
  for (const old of source.channels) if (!mappedChannels.has(old.id)) block('source_channel_unmapped', '/plan/channels');
  config.models = [...models].map(([modelId, vendor]) => ({ id: modelId, vendor }));
  for (const [index, mapping] of plan.callers.entries()) {
    const path = `/plan/callers/${index}`, old = callers.get(mapping.source_id);
    if (!old) { block('unknown_source_caller', path); continue; }
    if (mappedCallers.has(old.id)) block('duplicate_caller_mapping', path);
    mappedCallers.add(old.id);
    const user = users.get(old.user_id);
    if (!user) { block('subject_missing', path); continue; }
    if (user.quota_enforced && !noChargeUserIds.has(user.id)) block('quota_enforcement_unsupported', path);
    if (!old.unlimited_quota) block('token_quota_unsupported', path);
    if (old.group === 'auto' || old.cross_group_retry || old.auto_groups.length) block('auto_group_unsupported', path);
    if (old.effective_groups.length !== 1 || old.effective_groups[0] !== (old.group || user.group)) block('effective_group_unproven', path);
    if (mapping.enabled && old.status !== 1) block('disabled_caller_expansion', path);
    if (!mapping.enabled && old.status === 1) change('caller_disabled', path);
    // This importer alone preserves New API's two unambiguous full spellings.
    // Runtime authentication and newly issued tokens remain exact byte identities.
    if (old.key.includes('-')) block('legacy_key_identity_ambiguous', path);
    if (old.wire_token !== undefined) {
      const legacyKey = old.wire_token.startsWith('sk-') ? old.wire_token.slice(3) : old.wire_token;
      if (legacyKey.includes('-')) block('token_suffix_routing_unsupported', path);
      if (old.wire_token !== old.key && old.wire_token !== `sk-${old.key}`) block('wire_token_identity_mismatch', path);
    }
    if (old.expired_time !== -1) change('expiry_boundary_stricter', path);
    const caller = { id: mapping.id, name: old.name, enabled: mapping.enabled,
      subject_enabled: user.status === 1, token_hmac: key ? hashCallerToken(key, old.key) : '0'.repeat(64),
      token_hmac_aliases: [key ? hashCallerToken(key, `sk-${old.key}`) : '1'.repeat(64)],
      expires_at: old.expired_time === -1 ? null : new Date(old.expired_time * 1000).toISOString(),
      allowed_ips: ipLimits(old.allow_ips), permissions: structuredClone(mapping.permissions) };
    config.callers.push(caller);
    report.caller_mappings.push({ source_id: old.id, target_id: mapping.id, subject_id: user.id,
      effective_groups: [...old.effective_groups], enabled: caller.enabled, subject_enabled: caller.subject_enabled,
      expires_at: caller.expires_at, ip_limit_count: caller.allowed_ips.length });
    const before = new Map(), after = new Map();
    try {
      const limits = new Set(old.model_limits === '' ? [] : old.model_limits.split(','));
      for (const channel of source.channels) {
        if (channel.status !== 1) continue;
        for (const model of channel.models) {
          if (normalizedFamily(model.model_id)) block('model_normalization_unsupported', path);
          if (old.model_limits_enabled && !limits.has(model.model_id)) continue;
          for (const group of old.effective_groups) if (channel.groups.includes(group)) {
            for (const protocol of model.capabilities) addRoute(before, route(group, model.model_id, channel.id, protocol), routeBudget);
          }
        }
      }
      const poolChoices = new Map();
      for (const permission of caller.permissions) {
        // Empty groups matches the old token-bound group independently of the request body.
        if (permission.groups.length) block('request_group_filter_unsupported', path);
        for (const channel of config.channels) {
          if (!channel.enabled || !channelPoolIds(channel).includes(permission.pool_id) || !permissionNamesChannel(permission, channel.id)) continue;
          for (const model of channel.models) if (permissionNamesModel(permission, model.model_id)) {
            for (const protocol of model.capabilities) if (permissionNamesProtocol(permission, protocol)) {
              addRoute(after, route(poolGroups.get(permission.pool_id), model.model_id, channel.id, protocol), routeBudget);
              const choice = JSON.stringify([model.model_id, protocol]);
              if (!poolChoices.has(choice)) poolChoices.set(choice, new Set());
              poolChoices.get(choice).add(permission.pool_id);
            }
          }
        }
      }
      if ([...poolChoices.values()].some((pools) => pools.size > 1)) block('ambiguous_pool_without_header', path);
      const added = [...after].filter(([identity]) => !before.has(identity)).map(([, row]) => row);
      const removed = [...before].filter(([identity]) => !after.has(identity)).map(([, row]) => row);
      if (added.length) block('permission_expansion', path);
      if (removed.length) change('permission_narrowed', path);
      const tupleDiff = { source_caller_id: old.id, target_caller_id: caller.id,
        old_count: before.size, new_count: after.size, added, removed };
      report.permissions.push(tupleDiff);
      report.reachable_tuple_diffs.push({ ...tupleDiff,
        status: added.length ? 'expanded' : removed.length ? 'narrowed' : 'equal' });
    } catch (error) {
      if (error.code !== 'route_matrix_too_large') throw error;
      block(error.code, path);
    }
  }
  for (const old of source.callers) if (!mappedCallers.has(old.id)) block('source_caller_unmapped', '/plan/callers');
  const oldAffinity = evidence.affinity;
  const newAffinity = { enabled: true, ttl_seconds: plan.affinity.ttl_seconds,
    model_isolated: true, coverage: 'all_channels', fallback: 'session_or_caller' };
  const affinityChanges = legacyAffinityProfile ? ['conditional_rules_replaced', 'scope', 'fallback']
    : Object.keys(newAffinity).filter((field) => oldAffinity[field] !== newAffinity[field]);
  if (affinityChanges.length) {
    change('affinity_semantics_changed', '/plan/affinity',
      { changed_fields: affinityChanges, previous: oldAffinity, proposed: newAffinity,
        ...(legacyAffinityProfile ? { rule_coverage: report.policy_rule_coverage } : {}) });
  }
  if (evidence.failure_policy.profile === 'new_api_native_retry_v1'
    || Object.keys(plan.failure_policy).some((field) => plan.failure_policy[field] !== evidence.failure_policy[field])) {
    change('failure_policy_changed', '/plan/failure_policy', { previous: evidence.failure_policy, proposed: plan.failure_policy });
  }
  const checked = validateConfig(config, { credentials });
  for (const error of checked.errors) block(`target_${error.code}`, error.path);
  for (const item of report.changes) if (!plan.accept_changes.includes(item.code)) block(`change_not_accepted:${item.code}`, item.path);
  report.ready = report.blockers.length === 0;
  // No draft secrets or usable token hashes escape a blocked conversion.
  return report.ready ? { report, config, credentials } : { report };
}

export async function runMigrationCli(argv) {
  const args = {};
  const allowed = new Set(['--input', '--source-id', '--key-file', '--report', '--output-dir']);
  for (let index = 0; index < argv.length; index += 2) {
    if (!allowed.has(argv[index]) || !argv[index + 1] || Object.hasOwn(args, argv[index])) {
      throw Object.assign(new Error('Invalid arguments'), { code: 'migration_arguments_invalid' });
    }
    args[argv[index]] = argv[index + 1];
  }
  if (!args['--input'] || !args['--source-id'] || !args['--report']) throw Object.assign(new Error('Missing arguments'), { code: 'migration_arguments_invalid' });
  const inputPath = resolve(args['--input']), reportPath = resolve(args['--report']);
  if (inputPath === reportPath || (args['--key-file'] && resolve(args['--key-file']) === reportPath)) {
    throw Object.assign(new Error('Output overlaps input'), { code: 'migration_paths_overlap' });
  }
  const bytes = await readFile(inputPath);
  if (bytes.length > 16 * 1024 * 1024) throw Object.assign(new Error('Input limit'), { code: 'migration_input_too_large' });
  let input;
  try { input = JSON.parse(bytes.toString('utf8')); } catch { throw Object.assign(new Error('Invalid JSON'), { code: 'migration_json_invalid' }); }
  const result = migrateConfig(input, { sourceId: args['--source-id'],
    callerHashKey: args['--key-file'] ? await readFile(args['--key-file']) : undefined });
  await writeFile(reportPath, `${JSON.stringify(result.report, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  let outputsWritten = false;
  if (args['--output-dir'] && result.report.ready) {
    const directory = resolve(args['--output-dir']);
    await mkdir(directory, { mode: 0o700 });
    await writeFile(resolve(directory, 'config.json'), `${JSON.stringify(result.config, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
    await writeFile(resolve(directory, 'credentials.json'), `${JSON.stringify(result.credentials, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
    outputsWritten = true;
  }
  return { exitCode: result.report.ready ? 0 : 2, summary: { ready: result.report.ready,
    migration_complete: false, blocker_count: result.report.blockers.length, change_count: result.report.changes.length,
    report_written: true, outputs_written: outputsWritten } };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const { exitCode, summary } = await runMigrationCli(process.argv.slice(2));
    process.stdout.write(`${JSON.stringify(summary)}\n`);
    process.exitCode = exitCode;
  } catch (error) {
    const code = typeof error.code === 'string' && error.code.startsWith('migration_') ? error.code : 'migration_io_error';
    process.stderr.write(`${JSON.stringify({ error: code })}\n`);
    process.exitCode = 1;
  }
}
