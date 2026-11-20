import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { migrateConfig } from '../src/gateway/migrate-config.js';

const headers = ['Originator', 'Session_id', 'Thread_id', 'Session-Id', 'Thread-Id', 'X-Client-Request-Id', 'User-Agent',
  'X-Codex-Beta-Features', 'X-Codex-Turn-State', 'X-Codex-Turn-Metadata', 'X-Codex-Window-Id',
  'X-Codex-Parent-Thread-Id', 'X-OpenAI-Subagent', 'X-OpenAI-Memgen-Request',
  'X-ResponsesAPI-Include-Timing-Metrics', 'X-OpenAI-Internal-Codex-Responses-Lite'];
const key = Buffer.from('SYNTHETIC-POLICY-HASH-KEY-0123456789abcdef');
const convert = (input) => migrateConfig(input, { sourceId: input.source_id, callerHashKey: key });
const codes = (result) => result.report.blockers.map((row) => row.code);
const denied = (result) => {
  assert.equal(result.report.ready, false);
  assert.equal(result.config, undefined);
  assert.equal(result.credentials, undefined);
};
async function fixture() {
  const input = JSON.parse(await readFile(new URL('../docs/motai-config-migration.example.json', import.meta.url), 'utf8'));
  input.source.channels[0].models[0].model_id = 'gpt-policy-test';
  input.source.channels[0].models[0].upstream_model = 'gpt-policy-test';
  input.plan.callers[0].permissions[0].model_ids = ['gpt-policy-test'];
  input.evidence.features = ['conditional_affinity_rules', 'conditional_header_passthrough'];
  const common = { user_agent_include: [], value_regex: '', ttl_seconds: 0, skip_retry_on_failure: true,
    include_using_group: true, include_model_name: false, include_rule_name: true };
  input.evidence.affinity = { profile: 'new_api_conditional_rules_v1', observed_at: '2026-10-28T00:00:00Z',
    enabled: true, default_ttl_seconds: 3600, switch_on_success: true, keep_on_channel_disabled: false, max_entries: 100000,
    rules: [{ ...structuredClone(common), name: 'codex cli trace', model_regex: ['^gpt-.*$', '^grok-.*$'],
      path_regex: ['/v1/responses'], key_sources: [{ type: 'gjson', path: 'prompt_cache_key' }], passthrough_headers: [...headers] },
    { ...structuredClone(common), name: 'claude cli trace', model_regex: ['^claude-.*$'], path_regex: ['/v1/messages'],
      key_sources: [{ type: 'gjson', path: 'metadata.user_id' }], include_model_name: true, passthrough_headers: ['X-App'] }] };
  input.evidence.failure_policy = { profile: 'new_api_native_retry_v1', observed_at: '2026-10-28T00:00:00Z',
    retry_times: 2, automatic_disable_channel_enabled: false, channel_disable_threshold: 5,
    affinity_rules_skip_retry: [{ rule_name: 'codex cli trace', skip_retry_on_failure: true },
      { rule_name: 'claude cli trace', skip_retry_on_failure: true }] };
  input.plan.accept_changes = ['affinity_semantics_changed', 'failure_policy_changed'];
  return input;
}

test('native policy facts retain per-rule inheritance and require known Codex core compatibility', async () => {
  const input = await fixture(), before = structuredClone(input);
  const result = convert(input);
  assert.deepEqual(codes(result), []);
  assert.equal(result.report.ready, true);
  assert.equal(result.report.migration_complete, false);
  assert.equal(result.report.evidence_verified_live, false);
  assert.deepEqual(result.report.required_core_compatibility, ['codex_trace_headers_v1']);
  assert.deepEqual(result.report.policy_rule_coverage.map((row) => [row.effective_ttl_seconds, row.header_compatibility]),
    [[3600, 'codex_trace_headers_v1'], [3600, 'deferred_outside_enabled_scope']]);
  const change = result.report.changes.find((row) => row.code === 'affinity_semantics_changed');
  assert.equal(change.previous.rules[0].ttl_seconds, 0);
  assert.equal(change.previous.rules[1].include_model_name, true);
  assert.equal(change.proposed.model_isolated, true);
  assert.deepEqual(input, before);
});

test('native profiles never imply acceptance or a scalar-equivalent legacy failure policy', async () => {
  const input = await fixture(); input.plan.accept_changes = [];
  const result = convert(input); denied(result);
  assert.ok(codes(result).includes('change_not_accepted:affinity_semantics_changed'));
  assert.ok(codes(result).includes('change_not_accepted:failure_policy_changed'));
  const change = result.report.changes.find((row) => row.code === 'failure_policy_changed');
  assert.equal(change.previous.profile, 'new_api_native_retry_v1');
  assert.equal(change.previous.retry_times, 2);
  assert.equal(Object.hasOwn(change.previous, 'ordinary_failure_threshold'), false);
});

test('unknown and unsafe active header templates stay blocked despite accept_changes', async () => {
  for (const header of ['Authorization', 'X-Api-Key', 'Cookie', 'X-Unlisted-Trace']) {
    const input = await fixture(); input.evidence.affinity.rules[0].passthrough_headers.push(header);
    input.plan.accept_changes.push('conditional_header_passthrough_unsupported');
    const result = convert(input); denied(result);
    assert.ok(codes(result).includes('conditional_header_passthrough_unsupported'));
  }
});

test('out-of-scope legacy header rules become blockers when their routes are enabled', async () => {
  const input = await fixture();
  input.source.channels[0].models[0].model_id = 'claude-policy-test';
  input.source.channels[0].models[0].upstream_model = 'claude-policy-test';
  input.source.channels[0].models[0].capabilities.push('messages');
  input.plan.callers[0].permissions[0].model_ids = ['claude-policy-test'];
  input.plan.callers[0].permissions[0].protocols.push('messages');
  const result = convert(input); denied(result);
  assert.ok(codes(result).includes('conditional_header_passthrough_unsupported'));
  assert.equal(result.report.policy_rule_coverage[1].active_in_candidate, true);
});

test('the measured Claude CLI header rule is recognized only with the exact source header set', async () => {
  const claudeHeaders = ['X-Stainless-Arch', 'X-Stainless-Lang', 'X-Stainless-Os', 'X-Stainless-Package-Version',
    'X-Stainless-Retry-Count', 'X-Stainless-Runtime', 'X-Stainless-Runtime-Version', 'X-Stainless-Timeout',
    'User-Agent', 'X-App', 'Anthropic-Beta', 'Anthropic-Dangerous-Direct-Browser-Access', 'Anthropic-Version'];
  const claudeInput = async (passthroughHeaders) => {
    const input = await fixture();
    input.source.channels[0].models[0].model_id = 'claude-policy-test';
    input.source.channels[0].models[0].upstream_model = 'claude-policy-test';
    input.source.channels[0].models[0].capabilities.push('messages');
    input.plan.callers[0].permissions[0].model_ids = ['claude-policy-test'];
    input.plan.callers[0].permissions[0].protocols.push('messages');
    input.evidence.affinity.rules[1].passthrough_headers = passthroughHeaders;
    return input;
  };
  const exact = convert(await claudeInput([...claudeHeaders]));
  assert.equal(exact.report.policy_rule_coverage[1].active_in_candidate, true);
  assert.equal(exact.report.policy_rule_coverage[1].header_compatibility, 'claude_cli_trace_headers_v1');
  assert.equal(codes(exact).includes('conditional_header_passthrough_unsupported'), false);
  assert.ok(exact.report.required_core_compatibility.includes('claude_cli_trace_headers_v1'));
  const partial = convert(await claudeInput(['X-App'])); denied(partial);
  assert.equal(partial.report.policy_rule_coverage[1].header_compatibility, 'unsupported');
  assert.ok(codes(partial).includes('conditional_header_passthrough_unsupported'));
});

test('unknown features, incomplete facts, duplicate names, and invalid regex remain blockers', async () => {
  const incomplete = await fixture(); incomplete.evidence.complete = false;
  assert.ok(codes(convert(incomplete)).includes('evidence_complete_missing'));
  const feature = await fixture(); feature.evidence.features.push('unmeasured_override');
  assert.ok(codes(convert(feature)).includes('unsupported_feature:unmeasured_override'));
  const duplicate = await fixture(); duplicate.evidence.affinity.rules[1].name = duplicate.evidence.affinity.rules[0].name;
  assert.ok(codes(convert(duplicate)).includes('duplicate_legacy_rule_name'));
  const invalid = await fixture(); invalid.evidence.affinity.rules[0].model_regex = ['['];
  assert.ok(codes(convert(invalid)).includes('legacy_rule_regex_invalid'));
});

test('profile imports preserve quota audit and never let NoCharge waive finite tokens', async () => {
  const input = await fixture(); input.source.users[0].quota_enforced = true;
  input.source.users[0].quota_balance = '9007199254740993';
  input.source.callers[0].remain_quota = -123;
  input.plan.no_charge = { mode: 'disable_local_commercial_charge', user_ids: [input.source.users[0].id] };
  input.plan.accept_changes.push('user_commercial_quota_removed');
  const result = convert(input); assert.deepEqual(codes(result), []);
  assert.equal(result.report.user_quota_audit[0].quota_balance, '9007199254740993');
  assert.equal(result.report.user_quota_audit[0].callers[0].remain_quota, -123);
  input.source.callers[0].unlimited_quota = false;
  const finite = convert(input); denied(finite); assert.ok(codes(finite).includes('token_quota_unsupported'));
});

test('a plan permission of ["*"] migrates exactly like the explicit list of the channel models it replaces', async () => {
  const explicit = await fixture();
  const wildcard = await fixture();
  wildcard.plan.callers[0].permissions[0].model_ids = ['*'];
  const a = convert(explicit), b = convert(wildcard);
  assert.deepEqual(codes(b), codes(a));
  assert.equal(b.report.ready, a.report.ready);
  assert.deepEqual(b.report.policy_rule_coverage, a.report.policy_rule_coverage);
  assert.deepEqual(b.report.reachable_tuple_diffs.map((row) => [row.old_count, row.new_count, row.added.length, row.removed.length]),
    a.report.reachable_tuple_diffs.map((row) => [row.old_count, row.new_count, row.added.length, row.removed.length]));
});

test('plan permissions of ["*"] for channels and protocols migrate exactly like the explicit lists they replace', async () => {
  const explicit = await fixture();
  for (const [label, mutate] of [
    ['channel_ids', (permission) => { permission.channel_ids = ['*']; }],
    ['protocols', (permission) => { permission.protocols = ['*']; }],
  ]) {
    const wildcard = await fixture();
    mutate(wildcard.plan.callers[0].permissions[0]);
    const a = convert(explicit), b = convert(wildcard);
    assert.deepEqual(codes(b), codes(a), label);
    assert.equal(b.report.ready, a.report.ready);
    assert.deepEqual(b.report.policy_rule_coverage, a.report.policy_rule_coverage);
    assert.deepEqual(b.report.reachable_tuple_diffs.map((row) => [row.old_count, row.new_count, row.added.length, row.removed.length]),
      a.report.reachable_tuple_diffs.map((row) => [row.old_count, row.new_count, row.added.length, row.removed.length]));
  }
});

test('a plan permission of ["*"] in all three lists also makes every conditional rule reachable', async () => {
  // Reachability is judged on the permission, not on what the channels offer: with model and protocol both open, the
  // claude /v1/messages rule can apply, so its header passthrough is reported unsupported (the explicit list is not).
  const explicit = convert(await fixture());
  const wildcard = await fixture();
  Object.assign(wildcard.plan.callers[0].permissions[0], { model_ids: ['*'], channel_ids: ['*'], protocols: ['*'] });
  const result = convert(wildcard);
  assert.deepEqual(codes(result), [...codes(explicit), 'conditional_header_passthrough_unsupported']);
  assert.deepEqual(result.report.reachable_tuple_diffs.map((row) => [row.old_count, row.new_count, row.added.length, row.removed.length]),
    explicit.report.reachable_tuple_diffs.map((row) => [row.old_count, row.new_count, row.added.length, row.removed.length]));
});

test('a plan permission mixing "*" with a concrete channel or protocol is not migrated', async () => {
  for (const mutate of [
    (permission) => { permission.channel_ids = ['*', '007']; },
    (permission) => { permission.protocols = ['*', 'responses']; },
  ]) {
    const input = await fixture();
    mutate(input.plan.callers[0].permissions[0]);
    const result = convert(input);
    assert.equal(result.report.ready, false);
    assert.equal(result.config, undefined);
    assert.ok(codes(result).length > 0);
  }
});
