import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { LegacyImport, normalizeLegacyRow } from '../src/gateway/legacy-import.js';

const START = Date.parse('2026-10-25T15:59:00Z') / 1000;
const row = (id, extra = {}) => ({ id, created_at: START + id, channel: 12, model_name: 'Model/Case',
  prompt_tokens: 100, completion_tokens: 20, quota: 0, use_time: 2, is_stream: true, ...extra });
const normalize = (input, type = 2) => normalizeLegacyRow(input, { sourceInstanceId: 'production-1', type });

async function fixture(t, rows, pageSize = 2) {
  const directory = await mkdtemp(path.join(tmpdir(), 'motai-legacy-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const calls = [];
  const client = { requestLogPage: async (pathname, options) => {
    const query = new URL(pathname, 'http://legacy.invalid').searchParams;
    calls.push({ pathname, options });
    const type = Number(query.get('type')), page = Number(query.get('p')), size = Number(query.get('page_size'));
    const data = rows[type] ?? [];
    return { total: data.length, items: data.slice((page - 1) * size, page * size) };
  } };
  const importer = new LegacyImport({ directory, sourceInstanceId: 'production-1', client, pageSize });
  return { importer, client, directory, calls };
}

test('legacy normalization preserves missing, explicit zero, unknown semantics and unpriced TTL', () => {
  const missing = normalize(row(1, { prompt_tokens: undefined, completion_tokens: undefined, quota: undefined, use_time: undefined }));
  assert.equal(missing.counters.rawInput, null);
  assert.equal(missing.counters.output, null);
  assert.equal(missing.counters.quota, null);
  assert.equal(missing.counters.durationMs, null);
  assert.equal(missing.counters.totalInput, null);
  assert.equal(missing.protocolOutcome, 'unknown');
  assert.equal(missing.officialCost, null);
  const zero = normalize(row(1, { prompt_tokens: 0, completion_tokens: '0', other: { usage_semantic: 'anthropic',
    cache_tokens: 0, cache_creation_tokens: 0, cache_creation_tokens_5m: 0, cache_creation_tokens_1h: 0 } }));
  assert.equal(zero.counters.totalInput, 0);
  assert.equal(zero.counters.cacheRead, 0);
  assert.equal(zero.counters.cacheWriteUnknown, 0);
  const ttl = normalize(row(1, { other: { usage_semantic: 'anthropic', cache_tokens: 30, cache_creation_tokens: 70 } }));
  assert.equal(ttl.counters.inputUncached, 100);
  assert.equal(ttl.counters.totalInput, 200);
  assert.equal(ttl.counters.cacheWrite5m, null);
  assert.equal(ttl.counters.cacheWrite1h, null);
  assert.equal(ttl.counters.cacheWriteUnknown, 70);
  const unknown = normalize(row(1, { other: { cache_tokens: 30, cache_creation_tokens: 70 } }));
  assert.equal(unknown.counters.totalInput, null);
  assert.equal(unknown.counters.inputUncached, null);
  assert.equal(unknown.counters.rawInput, 100);
  assert.equal(unknown.counters.output, 20);
});

test('contradictions and malformed counters keep independent output and explicit source metadata', () => {
  const bad = normalize(row(1, { prompt_tokens: 5, other: { usage_semantic: 'openai', cache_tokens: 6,
    cache_creation_tokens: 9, cache_creation_tokens_5m: 10, cache_write_tokens: 11, reasoning_tokens: 8 } }));
  assert.equal(bad.counters.output, 20);
  assert.equal(bad.counters.totalInput, 5);
  assert.equal(bad.counters.inputUncached, null);
  assert.equal(bad.counters.cacheWriteTotal, null);
  assert(bad.issues.includes('cache_write_conflict'));
  const invalid = normalize(row(1, { prompt_tokens: -1, completion_tokens: Number.MAX_SAFE_INTEGER + 1,
    other: { cache_tokens: {}, frt: 'NaN', stream_status: { status: 'error', errors: ['SECRET_CANARY'] } } }));
  assert.equal(invalid.counters.rawInput, null);
  assert.equal(invalid.counters.output, null);
  assert.equal(invalid.counters.cacheRead, null);
  assert.equal(invalid.completeness, 'partial');
  assert(!JSON.stringify(invalid).includes('SECRET_CANARY'));
  assert.equal(normalize(row(1), 5).outcome, 'legacy_error');
  assert.equal(normalize(row(1)).outcome, 'legacy_recorded');
  for (const bad of [row(0), row(1, { id: Number.MAX_SAFE_INTEGER + 1 }), row(1, { id: '../1' }), row(1, { created_at: '' })]) {
    assert.throws(() => normalize(bad), { code: 'legacy_invalid_row' });
  }
});

test('chunked import resumes page checkpoints, isolates type IDs and ignores client request IDs', async (t) => {
  const source = { 2: [row(1, { request_id: 'same-client-id' }), row(2, { request_id: 'same-client-id' }), row(3)], 5: [row(1)] };
  const { importer, client, directory, calls } = await fixture(t, source);
  const first = await importer.importRange({ from: START, to: START + 120, maxPages: 1 });
  assert.equal(first.records, 2);
  assert.equal(first.requestedWindow.complete, false);
  const restored = new LegacyImport({ directory, sourceInstanceId: 'production-1', client, pageSize: 2 });
  await restored.load();
  const done = await restored.importRange({ from: START, to: START + 120 });
  assert.equal(done.records, 4);
  assert.equal(done.legacyRecorded, 3);
  assert.equal(done.legacyErrors, 1);
  assert.equal(done.requestedWindow.complete, true);
  assert.equal(done.migrationComplete, false);
  assert.equal(done.snapshotConsistency, 'not_proven');
  assert.equal(calls.length, 3);
  const repeated = await restored.importRange({ from: START, to: START + 120 });
  assert.equal(repeated.pagesRead, 0);
  assert.equal(repeated.records, 4);
  assert.equal(new URL(calls[1].pathname, 'http://x').searchParams.get('p'), '2');
  for (const call of calls) {
    const query = new URL(call.pathname, 'http://x').searchParams;
    assert.equal(query.get('start_timestamp'), String(START));
    assert.equal(query.get('end_timestamp'), String(START + 119));
    assert.equal(call.options.priority, -10);
  }
});

test('candidate artifacts contain only allowlisted values and no free text or authentication data', async (t) => {
  const secret = 'DO_NOT_PERSIST_CANARY';
  // token_name is a display field the old console showed, so it is stored on purpose (checked below); every other free-text field is not.
  const source = { 2: [row(1, { content: secret, username: secret, token_name: 'visible-token', request_id: secret, key: secret,
    other: JSON.stringify({ usage_semantic: 'openai', cache_tokens: 4, cache_creation_tokens: 0,
      prompt: secret, error: secret, authorization: secret, stream_status: { status: 'failed', errors: [secret] },
      admin_info: { use_channel: [secret] } }) })] };
  const { importer, directory } = await fixture(t, source);
  await importer.importRange({ from: START, to: START + 60 });
  for (const name of await readdir(directory)) assert(!(await readFile(path.join(directory, name), 'utf8')).includes(secret));
  assert(!JSON.stringify(importer.report()).includes(secret));
  assert(!JSON.stringify(importer.readBuckets({ from: START, to: START + 60 })).includes(secret));
  // Aggregates never carry the display fields; only the row segments do.
  assert(!JSON.stringify(importer.report()).includes('visible-token'));
  assert(!JSON.stringify(importer.readBuckets({ from: START, to: START + 60 })).includes('visible-token'));
  const segments = (await readdir(directory)).filter((name) => name.startsWith('segment-'));
  assert((await readFile(path.join(directory, segments[0]), 'utf8')).includes('visible-token'));
});

test('duplicate rows are idempotent, conflicting same identities stop before checkpoint advancement', async (t) => {
  const { importer, client, directory } = await fixture(t, { 2: [row(1), row(1)] });
  const duplicate = await importer.importRange({ from: START, to: START + 60, logTypes: [2] });
  assert.equal(duplicate.records, 1);
  assert.equal(duplicate.requestedWindow.complete, false);
  const before = await readFile(path.join(directory, 'checkpoint.json'), 'utf8');
  client.requestLogPage = async () => ({ total: 1, items: [row(1, { prompt_tokens: 101 })] });
  await assert.rejects(importer.importRange({ from: START, to: START + 61, logTypes: [2] }), { code: 'legacy_row_conflict' });
  assert.equal(await readFile(path.join(directory, 'checkpoint.json'), 'utf8'), before);
  assert.equal(importer.report().records, 1);
});

test('changing totals and missing totals leave source coverage explicitly incomplete', async (t) => {
  const { importer, client } = await fixture(t, {});
  let page = 0;
  client.requestLogPage = async () => ++page === 1 ? { total: 3, items: [row(1), row(2)] } : { total: 4, items: [row(3)] };
  const changed = await importer.importRange({ from: START, to: START + 60, logTypes: [2] });
  assert.equal(changed.requestedWindow.complete, false);
  assert.equal(changed.windows[`${START}:${START + 60}`].types[2].stableTotal, false);
  client.requestLogPage = async () => ({ items: [] });
  const unknown = await importer.importRange({ from: START, to: START + 61, logTypes: [5] });
  assert.equal(unknown.requestedWindow.complete, false);
  assert.equal(importer.readBuckets({ from: START, to: START + 61 }).sourceCoverage.complete, false);
  assert.equal((await importer.importRange({ from: START, to: START + 61, logTypes: [5] })).pagesRead, 0);
});

test('Shanghai day buckets and exact half-open edges export independent known and unknown coverage', async (t) => {
  const boundary = START + 60;
  const { importer } = await fixture(t, { 2: [row(1), row(2, { created_at: boundary, prompt_tokens: 0,
    other: { usage_semantic: 'openai', cache_tokens: 0, cache_creation_tokens: 0 } })] });
  await importer.importRange({ from: START, to: boundary + 1 });
  const first = importer.readBuckets({ from: START, to: boundary });
  assert.equal(first.buckets.length, 1);
  assert.equal(first.buckets[0].day, '2026-10-25');
  assert.equal(first.buckets[0].records, 1);
  assert.equal(first.buckets[0].counters.rawInput.sum, 100);
  assert.equal(first.buckets[0].counters.totalInput.unknown, 1);
  const second = importer.readBuckets({ from: boundary, to: boundary + 1 });
  assert.equal(second.buckets[0].day, '2026-10-26');
  assert.equal(second.buckets[0].counters.rawInput.sum, 0);
  assert.equal(second.buckets[0].counters.rawInput.known, 1);
  assert.equal(second.buckets[0].counters.totalInput.known, 1);
  assert.equal(second.buckets[0].costs.unknown, 1);
  assert.equal(second.sourceCoverage.complete, true);
  const full = importer.readBuckets({ from: boundary, to: boundary + 86400 });
  assert.equal(full.buckets[0].records, 1);
  assert.equal(full.sourceCoverage.complete, false);
});

test('page errors and invalid rows preserve committed progress and suppress upstream error strings', async (t) => {
  const { importer, client, directory } = await fixture(t, { 2: [row(1), row(2), row(3)] });
  await importer.importRange({ from: START, to: START + 60, maxPages: 1 });
  const before = await readFile(path.join(directory, 'checkpoint.json'), 'utf8');
  client.requestLogPage = async () => { throw new Error('SECRET_CANARY_TOKEN'); };
  await assert.rejects(importer.importRange({ from: START, to: START + 60 }), (error) => error.code === 'legacy_source_unavailable' && !error.message.includes('CANARY'));
  assert.equal(await readFile(path.join(directory, 'checkpoint.json'), 'utf8'), before);
  client.requestLogPage = async () => ({ total: 3, items: [row(3, { created_at: START + 60 })] });
  await assert.rejects(importer.importRange({ from: START, to: START + 60 }), { code: 'legacy_row_outside_interval' });
  assert.equal(await readFile(path.join(directory, 'checkpoint.json'), 'utf8'), before);
});

test('orphan segments are ignored on restart and altered linked segments stop loading', async (t) => {
  const { importer, client, directory } = await fixture(t, { 2: [row(1)] });
  await importer.importRange({ from: START, to: START + 60 });
  await writeFile(path.join(directory, `segment-${'f'.repeat(64)}.json`), '{"orphan":true}');
  const restored = new LegacyImport({ directory, sourceInstanceId: 'production-1', client, pageSize: 2 });
  assert.equal((await restored.load()).records, 1);
  const checkpoint = JSON.parse(await readFile(path.join(directory, 'checkpoint.json'), 'utf8'));
  await writeFile(path.join(directory, `segment-${checkpoint.head}.json`), '{}');
  await assert.rejects(new LegacyImport({ directory, sourceInstanceId: 'production-1', client, pageSize: 2 }).load(), { code: 'legacy_invalid_store' });
  await assert.rejects(new LegacyImport({ directory, sourceInstanceId: 'different', client, pageSize: 2 }).load(), { code: 'legacy_invalid_store' });
});

test('overlapping import windows deduplicate row IDs and merge coverage without widening gaps', async (t) => {
  const { importer, client } = await fixture(t, {});
  const data = [row(1), row(2, { created_at: START + 70 })];
  client.requestLogPage = async (pathname) => {
    const query = new URL(pathname, 'http://legacy.invalid').searchParams;
    if (query.get('type') === '5') return { total: 0, items: [] };
    const from = Number(query.get('start_timestamp')), to = Number(query.get('end_timestamp'));
    const items = data.filter((item) => item.created_at >= from && item.created_at <= to);
    return { total: items.length, items };
  };
  await importer.importRange({ from: START, to: START + 60 });
  await importer.importRange({ from: START + 50, to: START + 120 });
  assert.equal(importer.report().records, 2);
  assert.equal(importer.readBuckets({ from: START, to: START + 120 }).sourceCoverage.complete, true);
  assert.equal(importer.readBuckets({ from: START - 1, to: START + 120 }).sourceCoverage.complete, false);
  assert.equal(importer.readBuckets({ from: START, to: START + 120 }).buckets.reduce((sum, item) => sum + item.records, 0), 2);
});

test('request work shares one importer queue and configuration identity is fixed on restart', async (t) => {
  const { importer, client, directory, calls } = await fixture(t, { 2: [row(1)] });
  const input = { from: START, to: START + 60 };
  const [first, second] = await Promise.all([importer.importRange(input), importer.importRange(input)]);
  assert.equal(first.records, 1);
  assert.equal(second.records, 1);
  assert.equal(second.pagesRead, 0);
  assert.equal(calls.length, 2);
  await assert.rejects(new LegacyImport({ directory, sourceInstanceId: 'production-1', client, pageSize: 3 }).load(), { code: 'legacy_invalid_store' });
  for (const value of ['../bad', '', 'source:unsafe']) assert.throws(() => new LegacyImport({ directory, sourceInstanceId: value }));
  for (const value of [0, 101, 1.5]) assert.throws(() => new LegacyImport({ directory, sourceInstanceId: 'production-1', pageSize: value }));
  await assert.rejects(importer.importRange({ from: START, to: START }), { code: 'legacy_invalid_interval' });
  await assert.rejects(importer.importRange({ ...input, logTypes: [2, 2] }), { code: 'legacy_invalid_type' });
});

test('counter overflow rejects a whole page before durable checkpoint or partial in-memory updates', async (t) => {
  const { importer, directory } = await fixture(t, { 2: [row(1, { prompt_tokens: Number.MAX_SAFE_INTEGER }), row(2)] });
  await assert.rejects(importer.importRange({ from: START, to: START + 60, logTypes: [2] }), { code: 'legacy_counter_overflow' });
  assert.equal(importer.report().records, 0);
  await assert.rejects(readFile(path.join(directory, 'checkpoint.json')), { code: 'ENOENT' });
});
