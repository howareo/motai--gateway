import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, writeFile, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { migrateConfig, runMigrationCli } from '../src/gateway/migrate-config.js';
import { hashCallerToken } from '../src/gateway/caller-config.js';
import { validateConfig } from '../src/gateway/schema.js';

const KEY = Buffer.from('SYNTHETIC-CALLER-KEY-0123456789abcdef\n');
const SOURCE = 'synthetic-newapi-01';
const fixture = async () => JSON.parse(await readFile(new URL('../docs/motai-config-migration.example.json', import.meta.url), 'utf8'));
const convert = (input, options = {}) => migrateConfig(input, { sourceId: SOURCE, callerHashKey: KEY, ...options });
const codes = (result) => result.report.blockers.map((item) => item.code);
const noOutput = (result) => { assert.equal(result.report.ready, false); assert.equal(result.config, undefined); assert.equal(result.credentials, undefined); };

test('migration preserves explicit source adapters and rejects unknown or guessed adapter fields', async () => {
  for (const adapter of ['openai', 'anthropic', 'deepseek', 'xai', 'gemini', 'moonshot']) {
    const input = await fixture();
    input.source.channels[0].adapter = adapter;
    const result = convert(input);
    assert.deepEqual(codes(result), []);
    assert.equal(result.config.channels[0].adapter, adapter);
    assert.equal(result.report.channel_mappings[0].adapter, adapter);
  }
  const omitted = convert(await fixture());
  assert.equal(Object.hasOwn(omitted.config.channels[0], 'adapter'), false);
  for (const adapter of ['', null, 43, 'vendor-guess']) {
    const input = await fixture(); input.source.channels[0].adapter = adapter;
    noOutput(convert(input));
  }
  const planOverride = await fixture(); planOverride.plan.channels[0].adapter = 'openai';
  noOutput(convert(planOverride));
});

test('signed historical token balance is preserved for unlimited callers without permitting finite quota', async () => {
  const input = await fixture();
  input.source.callers[0].remain_quota = -123;
  const result = convert(input);
  assert.deepEqual(codes(result), []);
  assert.equal(result.report.user_quota_audit[0].callers[0].remain_quota, -123);
  assert.equal(input.source.callers[0].remain_quota, -123);
  input.source.callers[0].unlimited_quota = false;
  const finite = convert(input);
  noOutput(finite);
  assert.ok(codes(finite).includes('token_quota_unsupported'));
  for (const value of [Number.MIN_SAFE_INTEGER - 1, Number.MAX_SAFE_INTEGER + 1]) {
    input.source.callers[0].remain_quota = value;
    noOutput(convert(input));
  }
});

test('multi-group channel stays one identity and one credential with exact caller pool tuples', async () => {
  const input = await fixture();
  input.source.channels[0].groups.push('second-group');
  input.plan.pools.push({ id: 'second-pool', name: 'Second', group: 'second-group' });
  input.plan.channels[0].pool_ids = [input.plan.channels[0].pool_id, 'second-pool'];
  const second = structuredClone(input.source.callers[0]);
  second.id = 'second-caller'; second.key = 'secondkey'; second.wire_token = 'sk-secondkey';
  second.group = 'second-group'; second.effective_groups = ['second-group'];
  input.source.callers.push(second);
  input.plan.callers.push({ source_id: second.id, id: 'caller-second', enabled: true,
    permissions: input.plan.callers[0].permissions.map((row) => ({ ...structuredClone(row), pool_id: 'second-pool' })) });
  const result = convert(input);
  assert.deepEqual(codes(result), []);
  assert.equal(result.config.channels.length, 1);
  assert.equal(result.credentials.entries.length, 1);
  assert.deepEqual(result.config.channels[0].pool_ids, input.plan.channels[0].pool_ids);
  assert.ok(result.report.permissions.every((row) => row.added.length === 0 && row.removed.length === 0));
  const ambiguous = structuredClone(input);
  ambiguous.plan.callers[0].permissions.push(...ambiguous.plan.callers[1].permissions);
  const rejected = convert(ambiguous);
  assert.ok(codes(rejected).includes('permission_expansion'));
  assert.ok(codes(rejected).includes('ambiguous_pool_without_header'));
  noOutput(rejected);
  for (const poolIds of [[], ['second-pool'], ['second-pool', 'second-pool'], [input.plan.channels[0].pool_id, 'unknown']]) {
    const invalid = structuredClone(input); invalid.plan.channels[0].pool_ids = poolIds;
    noOutput(convert(invalid));
  }
});

test('synthetic documented evidence generates exact IDs, case, mapping, zero weight and dual legacy HMACs without mutation', async () => {
  const input = await fixture(), before = structuredClone(input), result = convert(input);
  assert.deepEqual(codes(result), []);
  assert.equal(result.report.ready, true);
  assert.equal(result.report.migration_complete, false);
  assert.equal(result.report.evidence_verified_live, false);
  assert.equal(result.config.channels[0].id, '007');
  assert.equal(result.config.channels[0].weight, 0);
  assert.equal(result.config.channels[0].priority, 27);
  assert.equal(result.config.models[0].id, 'Model/Case-Sensitive');
  assert.equal(result.config.channels[0].models[0].upstream_model, 'Provider/Model');
  assert.equal(result.config.callers[0].token_hmac, hashCallerToken(KEY, input.source.callers[0].key));
  assert.deepEqual(result.config.callers[0].token_hmac_aliases, [hashCallerToken(KEY, `sk-${input.source.callers[0].key}`)]);
  assert.equal(result.credentials.entries[0].secret, input.source.channels[0].key);
  assert.equal(validateConfig(result.config, { credentials: result.credentials }).valid, true);
  assert.deepEqual(input, before);
  const report = JSON.stringify(result.report);
  for (const secret of [KEY.toString(), input.source.callers[0].key, input.source.callers[0].wire_token,
    input.source.channels[0].key, result.config.callers[0].token_hmac, ...result.config.callers[0].token_hmac_aliases]) assert.equal(report.includes(secret), false);
  assert.deepEqual(result.report.permissions[0], { source_caller_id: '1004', target_caller_id: 'caller-main',
    old_count: 2, new_count: 2, added: [], removed: [] });
  assert.deepEqual(result.report.reachable_tuple_diffs[0], { source_caller_id: '1004', target_caller_id: 'caller-main',
    old_count: 2, new_count: 2, status: 'equal', added: [], removed: [] });
});

test('baseline-shaped or incomplete exports name missing fields and produce no config', async () => {
  const baseline = convert({ channels: [], callerPermissions: [] });
  noOutput(baseline);
  assert.ok(codes(baseline).includes('input_required'));
  for (const field of ['user_id', 'expired_time', 'allow_ips', 'effective_groups', 'auto_groups']) {
    const input = await fixture();
    delete input.source.callers[0][field];
    const result = convert(input);
    noOutput(result);
    assert.ok(codes(result).includes('input_required'), field);
    assert.ok(result.report.blockers.some((item) => item.path.endsWith(`/${field}`)));
    assert.ok(result.report.field_evidence.missing.some((item) => item.path.endsWith(`/${field}`)));
  }
  const unknown = await fixture();
  unknown.source.callers[0].private_note = 'SYNTHETIC_SHOULD_NOT_BE_REPORTED';
  const unknownResult = convert(unknown);
  noOutput(unknownResult);
  assert.ok(unknownResult.report.field_evidence.unknown.some((item) =>
    item.path === '/source/callers/0/private_note' && item.reason === 'additional_property'));
  assert.equal(JSON.stringify(unknownResult.report).includes('SYNTHETIC_SHOULD_NOT_BE_REPORTED'), false);
});

test('source binding, evidence completeness and hash key are required independently', async () => {
  const input = await fixture();
  assert.ok(codes(convert(input, { sourceId: 'other-source' })).includes('source_id_mismatch'));
  noOutput(convert(input, { callerHashKey: undefined }));
  for (const flag of ['complete', 'snapshot_consistent', 'feature_inventory_complete', 'permissions_complete', 'capabilities_complete', 'group_resolution_complete']) {
    const next = structuredClone(input); next.evidence[flag] = false;
    const result = convert(next); noOutput(result);
    assert.ok(codes(result).includes(`evidence_${flag}_missing`));
  }
});

test('header/parameter overrides, multikey and unknown features block instead of disappearing', async () => {
  for (const feature of ['header_overrides', 'parameter_overrides', 'multikey', 'oauth_refresh', 'unknown_feature']) {
    const input = await fixture(); input.source.channels[0].features.push(feature);
    const result = convert(input); noOutput(result);
    assert.ok(codes(result).includes(`unsupported_feature:${feature}`));
  }
  const input = await fixture(); input.source.channels[0].headers = { authorization: 'SYNTHETIC_HIDDEN_KEY' };
  const result = convert(input); noOutput(result);
  assert.equal(JSON.stringify(result.report).includes('SYNTHETIC_HIDDEN_KEY'), false);
});

test('caller and user status, finite expiry, and exact old IP parsing remain constrained', async () => {
  const input = await fixture();
  input.source.callers[0].status = 2; input.plan.callers[0].enabled = false;
  input.source.users[0].status = 2; input.source.callers[0].expired_time = 1800000000;
  input.source.callers[0].allow_ips = ' 127.0.0.1, \n 10.10.0.0/16,\n::1/128\n';
  input.plan.accept_changes.push('expiry_boundary_stricter');
  const result = convert(input); assert.deepEqual(codes(result), []);
  assert.equal(result.config.callers[0].enabled, false);
  assert.equal(result.config.callers[0].subject_enabled, false);
  assert.equal(result.config.callers[0].expires_at, new Date(1800000000000).toISOString());
  assert.deepEqual(result.config.callers[0].allowed_ips, ['127.0.0.1', '10.10.0.0/16', '::1/128']);
  input.plan.callers[0].enabled = true;
  assert.ok(codes(convert(input)).includes('disabled_caller_expansion'));
});

test('malformed IPs never collapse to an unrestricted caller', async () => {
  for (const raw of ['NOT_AN_IP', '127.0.0.1,10.10.0.1', '10.0.0.0/99']) {
    const input = await fixture(); input.source.callers[0].allow_ips = raw;
    const result = convert(input); noOutput(result);
    assert.ok(codes(result).some((code) => code.startsWith('target_schema_')));
  }
});

test('automatic groups, quota enforcement, missing subject and unresolved groups block', async () => {
  const edits = [
    (input) => { input.source.callers[0].group = 'auto'; },
    (input) => { input.source.callers[0].auto_groups = ['private']; },
    (input) => { input.source.callers[0].cross_group_retry = true; },
    (input) => { input.source.callers[0].unlimited_quota = false; },
    (input) => { input.source.users[0].quota_enforced = true; },
    (input) => { input.source.users = []; },
    (input) => { input.source.callers[0].effective_groups = []; },
    (input) => { input.source.callers[0].effective_groups = ['different']; },
    (input) => { input.plan.callers[0].permissions[0].groups = ['private']; },
  ];
  for (const edit of edits) { const input = await fixture(); edit(input); noOutput(convert(input)); }
});

test('named NoCharge user policy audits exact source balances and requires explicit change acceptance', async () => {
  const input = await fixture();
  input.source.users[0].quota_enforced = true;
  input.source.users[0].quota_balance = '9223372036854775807';
  input.source.callers[0].remain_quota = 765432;
  input.plan.no_charge = { mode: 'disable_local_commercial_charge', user_ids: ['1'] };
  const before = structuredClone(input);

  const unaccepted = convert(input);
  assert.ok(codes(unaccepted).includes('change_not_accepted:user_commercial_quota_removed'));
  assert.deepEqual(unaccepted.report.user_quota_audit, [{ source_user_id: '1', quota_enforced: true,
    quota_balance: '9223372036854775807', callers: [{ source_caller_id: '1004', status: 1,
      unlimited_quota: true, remain_quota: 765432 }] }]);
  assert.equal(JSON.stringify(unaccepted.report).includes(input.source.callers[0].wire_token), false);
  assert.equal(unaccepted.config, undefined);

  input.plan.accept_changes.push('user_commercial_quota_removed');
  const accepted = convert(input);
  assert.deepEqual(codes(accepted), []);
  assert.equal(accepted.report.ready, true);
  assert.deepEqual(input.source, before.source, 'policy evaluation must not rewrite source quota or balance');
});

test('NoCharge policy rejects unknown or unverified users and never waives finite token quota', async () => {
  const input = await fixture();
  input.source.users[0].quota_enforced = true;
  input.source.users[0].quota_balance = null;
  input.plan.no_charge = { mode: 'disable_local_commercial_charge', user_ids: ['1'] };
  assert.ok(codes(convert(input)).includes('nocharge_user_balance_unknown'));

  input.source.users[0].quota_balance = '10';
  input.plan.no_charge.user_ids = ['unknown-user'];
  assert.ok(codes(convert(input)).includes('unknown_nocharge_source_user'));

  input.plan.no_charge.user_ids = ['1'];
  input.source.callers[0].unlimited_quota = false;
  const finiteToken = convert(input);
  assert.ok(codes(finiteToken).includes('token_quota_unsupported'));
  assert.equal(finiteToken.config, undefined);

  input.source.callers[0].unlimited_quota = true;
  input.source.users[0].quota_enforced = false;
  assert.ok(codes(convert(input)).includes('nocharge_user_quota_not_enforced'));
});

test('exact model limits and pool group comparison reject expanded route tuples', async () => {
  const input = await fixture(); input.source.callers[0].model_limits_enabled = true;
  input.source.callers[0].model_limits = 'model/case-sensitive';
  const result = convert(input); noOutput(result);
  assert.ok(codes(result).includes('permission_expansion'));
  assert.equal(result.report.permissions[0].old_count, 0);
  assert.equal(result.report.permissions[0].added.length, 2);
  input.source.callers[0].model_limits = 'Model/Case-Sensitive';
  assert.equal(convert(input).report.ready, true);
  input.plan.pools[0].group = 'different';
  const wrongGroup = convert(input); noOutput(wrongGroup);
  assert.ok(codes(wrongGroup).includes('channel_pool_group_mismatch'));
  assert.ok(codes(wrongGroup).includes('permission_expansion'));
});

test('narrowing is enumerated and needs explicit acknowledgement', async () => {
  const input = await fixture(); input.plan.callers[0].permissions[0].protocols = ['responses'];
  const result = convert(input); noOutput(result);
  assert.ok(codes(result).includes('change_not_accepted:permission_narrowed'));
  assert.deepEqual(result.report.permissions[0].removed, [{ group: 'private', model_id: 'Model/Case-Sensitive',
    channel_id: '007', protocol: 'chat_completions' }]);
  assert.equal(result.report.reachable_tuple_diffs[0].status, 'narrowed');
  input.plan.accept_changes.push('permission_narrowed');
  assert.equal(convert(input).report.ready, true);
});

test('affinity isolation, inherited TTL/coverage/fallback and failure changes are explicit', async () => {
  const input = await fixture(); Object.assign(input.evidence.affinity,
    { model_isolated: false, ttl_seconds: 3600, coverage: 'partial', fallback: 'session_only' });
  input.plan.affinity.ttl_seconds = 1800; input.evidence.failure_policy.max_attempts = 3;
  const result = convert(input); noOutput(result);
  assert.ok(codes(result).includes('change_not_accepted:affinity_semantics_changed'));
  assert.ok(codes(result).includes('change_not_accepted:failure_policy_changed'));
  const affinity = result.report.changes.find((item) => item.code === 'affinity_semantics_changed');
  assert.deepEqual(affinity.changed_fields, ['ttl_seconds', 'model_isolated', 'coverage', 'fallback']);
  assert.equal(affinity.proposed.model_isolated, true);
  input.plan.accept_changes.push('affinity_semantics_changed', 'failure_policy_changed');
  assert.equal(convert(input).report.ready, true);
});

test('channel status, credential collisions, omitted source objects, duplicates and model families fail closed', async () => {
  const edits = [
    (input) => { input.source.channels[0].status = 2; },
    (input) => { input.plan.channels = []; },
    (input) => { input.plan.callers = []; },
    (input) => { input.source.callers.push(structuredClone(input.source.callers[0])); },
    (input) => { input.source.channels[0].models[0].model_id = 'gemini-2.5-flash-thinking-1024'; },
    (input) => { input.source.channels[0].models[0].capabilities = []; },
    (input) => {
      input.source.channels.push({ ...structuredClone(input.source.channels[0]), id: '008', key: 'SYNTHETIC_OTHER_KEY' });
      input.plan.channels.push({ ...input.plan.channels[0], source_id: '008' });
    },
  ];
  for (const edit of edits) { const input = await fixture(); edit(input); noOutput(convert(input)); }
});

test('optional observed legacy wire identity must match the two DB-proven forms and suffix routing blocks', async () => {
  const input = await fixture(); input.source.callers[0].wire_token = 'sk-DIFFERENT_KEY';
  assert.ok(codes(convert(input)).includes('wire_token_identity_mismatch'));
  input.source.callers[0].wire_token = `sk-${input.source.callers[0].key}-007`;
  assert.ok(codes(convert(input)).includes('token_suffix_routing_unsupported'));
});

test('New API import derives stable bare and prefixed identities without a client spelling prerequisite', async () => {
  const input = await fixture();
  input.plan.accept_changes = input.plan.accept_changes.filter((code) => code !== 'legacy_token_variants_narrowed');
  const expected = convert(input);
  assert.deepEqual(codes(expected), []);
  assert(!expected.report.changes.some((row) => row.code === 'legacy_token_variants_narrowed'));
  for (const wireToken of [undefined, input.source.callers[0].key, `sk-${input.source.callers[0].key}`]) {
    const next = structuredClone(input);
    if (wireToken === undefined) delete next.source.callers[0].wire_token;
    else next.source.callers[0].wire_token = wireToken;
    const result = convert(next);
    assert.deepEqual(codes(result), []);
    assert.deepEqual(result.config.callers, expected.config.callers);
  }
  for (const key of ['sk-AMBIGUOUS', 'AMBIGUOUS-KEY', 'AMBIGUOUS-007']) {
    const next = structuredClone(input); next.source.callers[0].key = key; delete next.source.callers[0].wire_token;
    const result = convert(next); noOutput(result);
    assert(codes(result).includes('legacy_key_identity_ambiguous'));
  }
  for (const wireToken of ['different', `sk-sk-${input.source.callers[0].key}`, ` ${input.source.callers[0].key}`, `${input.source.callers[0].key} `]) {
    const next = structuredClone(input); next.source.callers[0].wire_token = wireToken;
    const result = convert(next); noOutput(result);
    assert(codes(result).includes('wire_token_identity_mismatch'));
  }
  const duplicate = structuredClone(input);
  duplicate.source.callers.push({ ...structuredClone(duplicate.source.callers[0]), id: 'duplicate' });
  duplicate.plan.callers.push({ ...structuredClone(duplicate.plan.callers[0]), source_id: 'duplicate', id: 'duplicate' });
  const result = convert(duplicate); noOutput(result);
  assert(codes(result).includes('target_duplicate_identity'));
});

test('two eligible pools are blocked even when each tuple is within the old group scope', async () => {
  const input = await fixture();
  input.source.channels.push({ ...structuredClone(input.source.channels[0]), id: '008' });
  input.plan.pools.push({ id: 'pool-second', name: 'Second', group: 'private' });
  input.plan.channels.push({ ...input.plan.channels[0], source_id: '008', pool_id: 'pool-second' });
  input.plan.callers[0].permissions.push({ ...structuredClone(input.plan.callers[0].permissions[0]),
    pool_id: 'pool-second', channel_ids: ['008'] });
  assert.ok(codes(convert(input)).includes('ambiguous_pool_without_header'));
});

test('CLI defaults to a report, emits private files only when ready, and never overwrites', async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'motai-migration-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const input = await fixture(), inputPath = path.join(directory, 'input.json'), keyPath = path.join(directory, 'hash.key');
  await writeFile(inputPath, JSON.stringify(input)); await writeFile(keyPath, KEY);
  const args = ['--input', inputPath, '--source-id', SOURCE, '--key-file', keyPath];
  const result = await runMigrationCli([...args, '--report', path.join(directory, 'dry-run.json')]);
  assert.equal(result.exitCode, 0); assert.equal(result.summary.outputs_written, false);
  assert.equal((await readdir(directory)).includes('config.json'), false);
  const output = path.join(directory, 'candidate');
  const written = await runMigrationCli([...args, '--report', path.join(directory, 'ready.json'), '--output-dir', output]);
  assert.equal(written.summary.outputs_written, true);
  const config = JSON.parse(await readFile(path.join(output, 'config.json')));
  const credentials = JSON.parse(await readFile(path.join(output, 'credentials.json')));
  assert.equal(validateConfig(config, { credentials }).valid, true);
  if (process.platform !== 'win32') assert.equal((await stat(path.join(output, 'credentials.json'))).mode & 0o777, 0o600);
  await assert.rejects(runMigrationCli([...args, '--report', path.join(directory, 'ready.json')]));
  const blockedPath = path.join(directory, 'blocked-candidate');
  const blocked = await runMigrationCli(['--input', inputPath, '--source-id', SOURCE,
    '--report', path.join(directory, 'blocked.json'), '--output-dir', blockedPath]);
  assert.equal(blocked.exitCode, 2); assert.equal(blocked.summary.outputs_written, false);
  assert.equal((await readdir(directory)).includes('blocked-candidate'), false);
  const cli = fileURLToPath(new URL('../src/gateway/migrate-config.js', import.meta.url));
  const child = spawnSync(process.execPath, [cli, ...args, '--report', path.join(directory, 'stdout.json')], { encoding: 'utf8' });
  assert.equal(child.status, 0); assert.equal(JSON.parse(child.stdout).ready, true); assert.equal(child.stderr, '');
  for (const secret of [input.source.channels[0].key, input.source.callers[0].wire_token, KEY.toString()]) {
    assert.equal(`${child.stdout}${child.stderr}`.includes(secret), false);
  }
});
