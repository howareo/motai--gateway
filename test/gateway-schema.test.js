import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { assertContract, validateContract, validateConfig, validateUsage, validateRecord, validatePage, validateQuery, compareUtc, permissionNamesChannel, permissionNamesModel, permissionNamesProtocol, WILDCARD_MODEL } from '../src/gateway/schema.js';
import { publicGatewayStatus } from '../src/gateway/client.js';

const fixture = (name) => JSON.parse(readFileSync(new URL(`../contracts/fixtures/${name}`, import.meta.url), 'utf8'));
const vectors = fixture('contract-vectors.json').vectors;

test('quarantined probe count stays visible without closing business admission', () => {
  const status = fixture('internal-api-samples.json').samples.status;
  status.ready = true;
  status.degraded_reasons = [];
  status.probe_completion_quarantined = 2;
  for (const mode of ['read', 'write']) assert.equal(validateContract('status', status, { mode }).valid, true);
  assert.equal(publicGatewayStatus(status).ready, true);
  assert.equal(publicGatewayStatus(status).probeCompletionQuarantined, 2);
  status.probe_completion_quarantined = -1;
  for (const mode of ['read', 'write']) assert.equal(validateContract('status', status, { mode }).valid, false);
  delete status.probe_completion_quarantined;
  assert.equal(publicGatewayStatus(status).probeCompletionQuarantined, 0);
});

test('gateway status accepts runtime degradation and rejects duplicate reasons', () => {
  const status = fixture('internal-api-samples.json').samples.status;
  status.ready = false;
  status.degraded_reasons = ['completion_wait_exceeded', 'runtime_lease_lost', 'in_flight_limit'];
  for (const mode of ['read', 'write']) assert.equal(validateContract('status', status, { mode }).valid, true);
  status.degraded_reasons.push('storage_unavailable', 'storage_unavailable');
  for (const mode of ['read', 'write']) assert.equal(validateContract('status', status, { mode }).valid, false);
});

test('Node validates the shared bounded caller HMAC identity namespace without mutation', async (t) => {
  for (const vector of fixture('caller-token-alias-vectors.json').vectors) await t.test(vector.id, () => {
    const config = fixture('config-valid.json');
    const template = config.callers[0];
    config.callers = vector.callers.map((identity, index) => ({ ...structuredClone(template), id: `caller-${index}`, ...identity }));
    const before = structuredClone(config);
    assert.equal(validateConfig(config).valid, vector.valid);
    assert.deepEqual(config, before);
  });
});

test('Node validates shared optional channel adapter vectors without guessing a default', async (t) => {
  for (const vector of fixture('channel-adapter-vectors.json').vectors) await t.test(vector.id, () => {
    const config = fixture('config-valid.json');
    if (Object.hasOwn(vector, 'adapter')) config.channels[0].adapter = vector.adapter;
    const before = structuredClone(config);
    assert.equal(validateConfig(config).valid, vector.valid);
    assert.deepEqual(config, before);
  });
});

test('complete page validation preserves nested schema and domain decisions', () => {
  const cases = vectors.filter((row) => row.domain === 'record');
  const original = fixture('attempt-valid.json');
  for (const row of fixture('usage-vectors.json').vectors) {
    const value = structuredClone(original);
    value.intent.vendor = row.provider;
    value.terminal.usage = row.expected;
    cases.push({ contract: 'attempt', value });
  }
  for (const mode of ['read', 'write']) for (const { contract, value } of cases) {
    const attempt = contract === 'event' ? value.attempt : value;
    for (const name of ['events_page', 'attempts_page']) {
      const eventPage = name === 'events_page';
      const record = eventPage ? { format_version: 1, seq: '1', event_type: 'attempt_terminal', attempt } : attempt;
      const page = { format_version: 1, [eventPage ? 'events' : 'attempts']: [record],
        ...(eventPage ? { next_seq: '1', latest_seq: '1', has_more: false }
          : { snapshot_seq: '1', next_cursor: null, has_more: false }) };
      const before = JSON.stringify(page);
      const expected = validateContract(name, page, { mode }).valid
        && validateRecord(eventPage ? 'event' : 'attempt', record, { mode }).valid;
      assert.equal(validatePage(name, page, { mode }).valid, expected, `${mode}/${name}`);
      assert.equal(JSON.stringify(page), before);
    }
  }
  const event = { format_version: 1, seq: '1', event_type: 'attempt_terminal', attempt: structuredClone(original) };
  event.attempt.terminal.usage.provider_counts.unrecognized_secret = 1;
  const page = { format_version: 1, events: [event], next_seq: '1', latest_seq: '1', has_more: false };
  assert.equal(validatePage('events_page', page, { mode: 'read' }).valid, false);
});

test('Node validates shared contract vectors without mutating their input', async (t) => {
  for (const vector of vectors) await t.test(vector.id, () => {
    const before = JSON.stringify(vector.value);
    const options = { mode: vector.mode };
    let result;
    if (vector.domain === 'config') result = validateConfig(vector.value, vector.options);
    else if (vector.domain === 'usage') result = validateUsage(vector.value, options);
    else if (vector.domain === 'record') result = validateRecord(vector.contract, vector.value, options);
    else result = validateContract(vector.contract, vector.value, options);
    assert.equal(result.valid, vector.valid, JSON.stringify(result.errors));
    assert.equal(JSON.stringify(vector.value), before, 'validation must not coerce, default or remove fields');
  });
});

test('normalizer expectation fixtures conform to the usage schema', async (t) => {
  for (const vector of fixture('usage-vectors.json').vectors) await t.test(vector.id, () => {
    const result = validateUsage(vector.expected);
    assert.equal(result.valid, true, JSON.stringify(result.errors));
  });
});

test('read compatibility never relaxes configuration or mutation requests', () => {
  assert.throws(() => validateContract('config', fixture('config-valid.json'), { mode: 'read' }), /Invalid contract mode/);
  assert.throws(() => validateContract('activate_request', {}, { mode: 'read' }), /Invalid contract mode/);
  const config = fixture('config-valid.json');
  config.callers[0].permissions[0].superuser = true;
  assert.equal(validateConfig(config).valid, false);
});

test('invalid errors contain local classifications, without supplied field values', () => {
  const data = fixture('config-valid.json');
  data.channels[0].base_url = 'CANARY_SECRET_BODY';
  assert.throws(() => assertContract('config', data), (error) => {
    assert.equal(error.code, 'invalid_contract');
    assert.equal(JSON.stringify(error).includes('CANARY_SECRET_BODY'), false);
    return true;
  });
});

test('time comparisons preserve nanoseconds and queries use half-open nonempty intervals', () => {
  assert.equal(compareUtc('2026-10-25T16:00:00.000000001Z', '2026-10-25T16:00:00Z'), 1);
  assert.equal(compareUtc('2026-10-25T16:00:00.1Z', '2026-10-25T16:00:00.100000000Z'), 0);
  const query = fixture('internal-api-samples.json').samples.attempts_query;
  assert.equal(validateQuery('attempts_query', query).valid, true);
  assert.equal(validateQuery('attempts_query', { ...query, to: query.from }).valid, false);
  assert.equal(validateQuery('attempts_query', { ...query, cursor: 'opaque' }).valid, false);
  assert.equal(validateQuery('attempts_query', { ...query, cursor: 'opaque', snapshot_seq: '9007199254740993' }).valid, true);
});

test('nanosecond ordering also guards terminal records', () => {
  const attempt = fixture('attempt-valid.json');
  attempt.intent.started_at = '2026-10-25T16:00:00.000000002Z';
  attempt.terminal.ended_at = '2026-10-25T16:00:00.000000001Z';
  assert.equal(validateRecord('attempt', attempt).valid, false);
});

test('Gemini auto thinking budget is intent metadata and does not relax unsigned usage', () => {
  const attempt = fixture('attempt-valid.json');
  Object.assign(attempt.intent, { vendor: 'gemini', protocol: 'gemini_generate_content' });
  attempt.terminal.usage.provider = 'gemini';
  attempt.terminal.usage.provider_counts = {};
  for (const thinking_budget of [-1, 0, null, Number.MAX_SAFE_INTEGER]) {
    attempt.intent.thinking_budget = thinking_budget;
    assert.equal(validateRecord('attempt', attempt).valid, true, String(thinking_budget));
    assert.equal(validateRecord('attempt', attempt, { mode: 'read' }).valid, true, String(thinking_budget));
  }
  for (const thinking_budget of [-2, -0.5, '-1', Number.MAX_SAFE_INTEGER + 1]) {
    attempt.intent.thinking_budget = thinking_budget;
    assert.equal(validateRecord('attempt', attempt).valid, false, String(thinking_budget));
  }
  attempt.intent.thinking_budget = -1;
  attempt.terminal.usage.output_total.value = -1;
  assert.equal(validateUsage(attempt.terminal.usage).valid, false);
});

test('schemas use only bundled local references and fixed Draft 7', () => {
  const directory = new URL('../contracts/v1/', import.meta.url);
  for (const name of readdirSync(directory)) {
    const schema = JSON.parse(readFileSync(new URL(name, directory), 'utf8'));
    assert.equal(schema.$schema, 'http://json-schema.org/draft-07/schema#');
    const visit = (node) => {
      if (!node || typeof node !== 'object') return;
      if (node.$ref) assert.match(node.$ref, /^(?:#|(?:common|config|usage|records|internal-api)\.schema\.json#)/);
      for (const value of Object.values(node)) visit(value);
    };
    visit(schema);
  }
});

test('contract validator imports stay below business and transport modules', () => {
  const source = readFileSync(new URL('../src/gateway/schema.js', import.meta.url), 'utf8');
  const imports = [...source.matchAll(/(?:from\s+|import\s*\()(['"])([^'"]+)\1/g)].map((match) => match[2]);
  assert.deepEqual(imports.sort(), ['ajv', 'node:fs', 'node:net']);
});

test('a sole "*" permission is valid and "*" mixed with any model id is rejected with one stable code', () => {
  const withModels = (modelIds, mutate = () => {}) => {
    const config = fixture('config-valid.json');
    config.callers[0].permissions[0].model_ids = modelIds;
    mutate(config);
    return validateConfig(config);
  };
  assert.equal(withModels([WILDCARD_MODEL]).valid, true);
  for (const modelIds of [[WILDCARD_MODEL, 'Model/Case-Sensitive'], ['Model/Case-Sensitive', WILDCARD_MODEL], [WILDCARD_MODEL, 'not-a-configured-model']]) {
    const result = withModels(modelIds);
    assert.equal(result.valid, false);
    assert.deepEqual(result.errors.map((error) => error.code), ['permission_wildcard_mixed']);
  }
  assert.equal(withModels([]).valid, false, 'an empty list is still rejected by the schema');
  assert.equal(withModels(['not-a-configured-model']).errors.some((error) => error.code === 'unknown_permission_model'), true);
  // "*" widens models only: pool and channel membership are still checked.
  const outside = withModels([WILDCARD_MODEL], (config) => { config.pools.push({ id: 'wildcard-other-pool', name: 'x' }); config.callers[0].permissions[0].pool_id = 'wildcard-other-pool'; });
  assert.deepEqual(outside.errors.map((error) => error.code), ['permission_channel_outside_pool']);
});

test('permissionNamesModel treats "*" as the sole element only', () => {
  assert.equal(permissionNamesModel({ model_ids: [WILDCARD_MODEL] }, 'anything'), true);
  assert.equal(permissionNamesModel({ model_ids: ['a', 'b'] }, 'b'), true);
  assert.equal(permissionNamesModel({ model_ids: ['a', 'b'] }, 'c'), false);
  assert.equal(permissionNamesModel({ model_ids: [WILDCARD_MODEL, 'a'] }, 'c'), false);
  assert.equal(permissionNamesModel({ model_ids: [] }, 'c'), false);
});

test('"*" is accepted as the sole element of channel_ids and protocols and rejected next to any other value', () => {
  const withPermission = (fields, mutate = () => {}) => {
    const config = fixture('config-valid.json');
    Object.assign(config.callers[0].permissions[0], fields);
    mutate(config);
    return validateConfig(config);
  };
  for (const fields of [{ channel_ids: ['*'] }, { protocols: ['*'] }, { model_ids: ['*'], channel_ids: ['*'], protocols: ['*'] }]) {
    assert.equal(withPermission(fields).valid, true, JSON.stringify(fields));
  }
  const channelId = fixture('config-valid.json').callers[0].permissions[0].channel_ids[0];
  for (const fields of [{ channel_ids: ['*', channelId] }, { channel_ids: [channelId, '*'] }, { channel_ids: ['*', 'not-a-channel'] },
    { protocols: ['*', 'responses'] }, { protocols: ['count_tokens', '*'] }]) {
    const result = withPermission(fields);
    assert.equal(result.valid, false, JSON.stringify(fields));
    assert.deepEqual(result.errors.map((error) => error.code), ['permission_wildcard_mixed'], JSON.stringify(fields));
  }
  // Only the literal "*" is a wildcard; look-alikes and unknown protocols stay schema errors.
  for (const fields of [{ protocols: ['**'] }, { protocols: ['not-a-protocol'] }, { channel_ids: ['1022*'] }, { channel_ids: [] }, { protocols: [] }]) {
    assert.equal(withPermission(fields).valid, false, JSON.stringify(fields));
  }
  assert.equal(withPermission({ channel_ids: ['not-a-channel'] }).errors.some((error) => error.code === 'permission_channel_outside_pool'), true);
  // "*" as channel_ids skips the pool membership check, but the pool itself must still exist.
  const otherPool = withPermission({ channel_ids: ['*'] }, (config) => { config.pools.push({ id: 'wildcard-other-pool', name: 'x' }); config.callers[0].permissions[0].pool_id = 'wildcard-other-pool'; });
  assert.equal(otherPool.valid, true);
  assert.deepEqual(withPermission({ channel_ids: ['*'] }, (config) => { config.callers[0].permissions[0].pool_id = 'no-such-pool'; }).errors.map((error) => error.code), ['unknown_permission_pool']);
});

test('permissionNamesChannel and permissionNamesProtocol treat "*" as the sole element only', () => {
  assert.equal(permissionNamesChannel({ channel_ids: [WILDCARD_MODEL] }, 'anything'), true);
  assert.equal(permissionNamesChannel({ channel_ids: ['a', 'b'] }, 'b'), true);
  assert.equal(permissionNamesChannel({ channel_ids: ['a', 'b'] }, 'c'), false);
  assert.equal(permissionNamesChannel({ channel_ids: [WILDCARD_MODEL, 'a'] }, 'c'), false);
  assert.equal(permissionNamesChannel({ channel_ids: [] }, 'c'), false);
  assert.equal(permissionNamesProtocol({ protocols: [WILDCARD_MODEL] }, 'count_tokens'), true);
  assert.equal(permissionNamesProtocol({ protocols: ['responses', 'messages'] }, 'messages'), true);
  assert.equal(permissionNamesProtocol({ protocols: ['responses', 'messages'] }, 'count_tokens'), false);
  assert.equal(permissionNamesProtocol({ protocols: [WILDCARD_MODEL, 'responses'] }, 'messages'), false);
  assert.equal(permissionNamesProtocol({ protocols: [] }, 'responses'), false);
});
