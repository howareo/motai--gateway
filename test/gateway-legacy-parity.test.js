import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { normalizeError, normalizeLog } from '../src/analytics.js';
import { LegacyImport, normalizeLegacyRow } from '../src/gateway/legacy-import.js';
import { legacyToPanel } from '../src/gateway/panel.js';

// src/analytics.js is unchanged since the old console (f0c8733), so it is the reference for what the old request table showed.
const START = Date.parse('2026-10-20T00:00:00Z') / 1000;
const CHANNELS = [[1, 'Primary'], [2, 'Fallback']];
const oldOptions = { channelNames: new Map(CHANNELS), channelTypes: new Map(CHANNELS.map(([id]) => [id, 'Anthropic'])), quotaPerUnit: 500000 };
const channels = new Map(CHANNELS.map(([id, name]) => [String(id), { name, vendor: 'anthropic' }]));
const models = new Map([['claude-x', { id: 'claude-x', vendor: 'anthropic' }]]);
const legacy = { rowPrice: () => ({ price: { status: 'unknown', reason: 'model_not_priced', officialCost: null, currency: null } }) };

const success = (id, extra = {}, other = {}) => ({ id, created_at: START + id, channel: 1, channel_name: 'Primary', model_name: 'claude-x',
  token_name: 'codex-main', group: 'default', prompt_tokens: 40, completion_tokens: 5, quota: 500, use_time: 3, is_stream: true,
  other: JSON.stringify({ usage_semantic: 'anthropic', cache_tokens: 20, cache_creation_tokens: 10, frt: 180, ...other }), ...extra });
const failure = (id, extra = {}) => ({ id, created_at: START + id, channel: 2, channel_name: 'Fallback', model_name: 'claude-x',
  token_name: 'codex-main', group: 'default', content: 'status_code=429, rate limited by upstream', ...extra });
const panelRow = (input, type) => legacyToPanel(normalizeLegacyRow(input, { sourceInstanceId: 'prod-1', type }), { models, channels, legacy });

const SUCCESS_CASES = {
  'full row with a fallback route': success(1, {}, { reasoning_effort: ' High ', admin_info: { use_channel: [1, 2] } }),
  'route given as a JSON string': success(2, {}, { reasoning_effort: 'xhigh', admin_info: JSON.stringify({ use_channel: ['1', '2'] }) }),
  'no reasoning key, no token name, not a stream': success(3, { token_name: '', group: '', is_stream: false }),
  'reasoning key present but empty': success(4, {}, { reasoning_effort: '' }),
  'reasoning level in capitals': success(5, {}, { reasoning_effort: 'MEDIUM' }),
  'empty route falls back to the final channel': success(6, {}, { admin_info: { use_channel: [] } }),
  'route through a channel that is not configured': success(7, {}, { admin_info: { use_channel: [1, 77] } }),
  'stream that ended with an error status has no rate': success(8, {}, { stream_status: { status: 'error', errors: ['x'] } }),
  'no token_name or group keys at all': (() => { const value = success(9); delete value.token_name; delete value.group; return value; })(),
  'no first-token time': success(10, {}, { frt: undefined }),
  'other is not JSON': success(11, { other: 'not json' }),
};

for (const [name, input] of Object.entries(SUCCESS_CASES)) {
  test(`legacy success row shows what the old console showed: ${name}`, () => {
    const old = normalizeLog(input, oldOptions), now = panelRow(input, 2);
    for (const key of ['tokenName', 'reasoningEffort', 'group', 'model', 'stream', 'createdAt', 'createdTimestamp', 'durationMs', 'ttftMs',
      'failover', 'kind', 'cacheReadTokens', 'cacheCreateTokens']) assert.deepEqual(now[key], old[key], key);
    assert.equal(now.channelName, old.channelName, 'channelName');
    assert.deepEqual(now.channelRoute, old.channelRoute, 'channelRoute');
    assert.deepEqual(now.usedChannelIds.map(String), old.usedChannelIds.map(String), 'usedChannelIds');
    assert.equal(now.outputTokensPerSecond, old.outputTokensPerSecond, 'outputTokensPerSecond');
    assert.equal(now.errorMessage, null);
  });
}

const FAILURE_CASES = {
  'status code in the text': failure(1),
  'bare 5xx in the text': failure(2, { content: 'upstream error 502 bad gateway' }),
  'no content': failure(3, { content: '' }),
  'no token name': failure(4, { token_name: '' }),
  'channel that is no longer configured': failure(5, { channel: 99, channel_name: 'Retired Relay' }),
};

for (const [name, input] of Object.entries(FAILURE_CASES)) {
  test(`legacy failed row shows what the old console showed: ${name}`, () => {
    const old = normalizeError(input, oldOptions), now = panelRow(input, 5);
    for (const key of ['tokenName', 'reasoningEffort', 'group', 'model', 'stream', 'statusCode', 'durationMs', 'ttftMs', 'kind', 'failover'])
      assert.deepEqual(now[key], old[key], key);
    assert.equal(now.channelName, old.channelName, 'channelName');
    assert.deepEqual(now.channelRoute, old.channelRoute, 'channelRoute');
    for (const key of ['inputTokens', 'rawInputTokens', 'outputTokens', 'cacheReadTokens', 'cacheCreateTokens', 'cacheInputTokens', 'totalTokens'])
      assert.equal(now[key], old[key] ?? null, key);
    // The panel leaves an empty message as null and the page then shows its own fallback text.
    assert.equal(now.errorMessage ?? '', old.errorMessage, 'errorMessage');
    assert.equal(now.outputTokensPerSecond, null);
  });
}

test('stored display fields: token, group, reasoning, route and failure text', () => {
  const ok = normalizeLegacyRow(success(1, {}, { reasoning_effort: ' High ', admin_info: { use_channel: [1, 2, 'x', 0, -3] } }), { sourceInstanceId: 'prod-1', type: 2 });
  assert.equal(ok.tokenName, 'codex-main');
  assert.equal(ok.group, 'default');
  assert.equal(ok.channelName, 'Primary');
  assert.equal(ok.reasoningEffort, 'high');
  assert.deepEqual(ok.routeChannelIds, ['1', '2']);
  assert.equal(ok.statusCode, null);
  assert.equal(ok.errorMessage, null);
  assert.equal(ok.transformVersion, '2');
  const bad = normalizeLegacyRow(failure(2), { sourceInstanceId: 'prod-1', type: 5 });
  assert.equal(bad.statusCode, 429);
  assert.equal(bad.errorMessage, 'rate limited by upstream');
  assert.equal(bad.reasoningEffort, null);
  assert.deepEqual(bad.routeChannelIds, []);
  const missing = normalizeLegacyRow(success(3, { token_name: undefined, group: undefined, channel_name: undefined }), { sourceInstanceId: 'prod-1', type: 2 });
  assert.equal(missing.tokenName, '');
  assert.equal(missing.group, '');
  assert.equal(missing.reasoningEffort, null);
});

test('display text is bounded, control characters are removed, and only the status code and message of a failure are kept', () => {
  const noisy = normalizeLegacyRow(success(1, { token_name: `a\nb\u0000${'x'.repeat(400)}`, group: 5 }, { reasoning_effort: 'x'.repeat(100) }),
    { sourceInstanceId: 'prod-1', type: 2 });
  assert.equal(noisy.tokenName.length, 255);
  assert.ok(!/[\x00-\x1f]/.test(noisy.tokenName));
  assert.equal(noisy.group, '');
  assert.equal(noisy.reasoningEffort, null);
  const long = normalizeLegacyRow(failure(2, { content: `status_code=500, ${'e'.repeat(2000)}` }), { sourceInstanceId: 'prod-1', type: 5 });
  assert.equal(long.statusCode, 500);
  assert.equal(long.errorMessage.length, 500);
  const route = normalizeLegacyRow(success(3, {}, { admin_info: { use_channel: Array.from({ length: 40 }, (_, index) => index + 1) } }),
    { sourceInstanceId: 'prod-1', type: 2 });
  assert.equal(route.routeChannelIds.length, 16);
});

test('stored rows are validated: bad display fields, a failure message on a success row, and old-shaped rows are rejected', async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'motai-legacy-parity-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const importer = new LegacyImport({ directory, sourceInstanceId: 'prod-1' });
  await importer.load();
  const good = normalizeLegacyRow(success(1), { sourceInstanceId: 'prod-1', type: 2 });
  const fail = normalizeLegacyRow(failure(2), { sourceInstanceId: 'prod-1', type: 5 });
  const tampered = [
    { ...good, tokenName: 'a\nb' }, { ...good, tokenName: 7 }, { ...good, group: 'g'.repeat(256) }, { ...good, reasoningEffort: '' },
    { ...good, routeChannelIds: ['x'] }, { ...good, errorMessage: 'text' }, { ...good, statusCode: 500 },
    { ...fail, reasoningEffort: 'high' }, { ...fail, routeChannelIds: ['1'] }, { ...fail, statusCode: 99 }, { ...fail, errorMessage: null },
    { ...good, transformVersion: '1' },
  ];
  for (const row of tampered) assert.throws(() => importer.addRows([row]), { code: 'legacy_invalid_store' });
  const { tokenName, ...withoutToken } = good;
  assert.throws(() => importer.addRows([withoutToken]), { code: 'legacy_invalid_store' });
  importer.addRows([good, fail]);
  assert.equal(importer.report().records, 2);
});

test('a store written by transform version 1 does not load; the new version needs an explicit re-import into an empty directory', async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'motai-legacy-version-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const client = { requestLogPage: async () => ({ total: 1, items: [success(1)] }) };
  const first = new LegacyImport({ directory, sourceInstanceId: 'prod-1', client, pageSize: 2 });
  await first.importRange({ from: START, to: START + 60, logTypes: [2] });
  const file = path.join(directory, 'checkpoint.json');
  const checkpoint = JSON.parse(await readFile(file, 'utf8'));
  assert.equal(checkpoint.transformVersion, '2');
  await writeFile(file, JSON.stringify({ ...checkpoint, transformVersion: '1' }));
  await assert.rejects(new LegacyImport({ directory, sourceInstanceId: 'prod-1', client, pageSize: 2 }).load(), { code: 'legacy_invalid_store' });
});
