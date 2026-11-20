import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { GatewayProjection, ROW_RETENTION_DAYS, TOKEN_KEYS } from '../src/gateway/projection.js';
import { END, START, CHANNELS, attempts, costStore, multiplierOf, naiveBuckets, priceStore, referenceRows, select, source } from './helpers/projection-fixture.js';

const DAY = 86_400_000, HOUR = 3_600_000;
const RETENTION = 3;
const iso = (ms) => new Date(ms).toISOString();
const nanos = (ms, fraction) => `${iso(ms).slice(0, 19)}.${fraction}Z`;
const dayStart = (ms) => Math.floor((ms + 28_800_000) / DAY) * DAY - 28_800_000;
const close = (a, b) => Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(a), Math.abs(b));

const list = attempts();
const rows = referenceRows(list);
const today = dayStart(END);
const WINDOWS = {
  today: [iso(today), iso(END + HOUR)], yesterday: [iso(today - DAY), iso(today)], '24h': [iso(END - DAY), iso(END + HOUR)],
  '7d': [iso(END - 7 * DAY), iso(END + HOUR)], '30d': [iso(END - 30 * DAY), iso(END + HOUR)], '90d': [iso(END - 90 * DAY), iso(END + HOUR)],
  all: [iso(START - DAY), iso(END + HOUR)],
  'sub-minute recent': [nanos(END - 2 * HOUR, '123456789'), nanos(END - 2 * HOUR + 45_000, '987654321')],
  'sub-minute old': [nanos(START + 10 * DAY + 6 * HOUR, '000000001'), nanos(START + 10 * DAY + 6 * HOUR + 61_000, '500000000')],
  'old rolling start, half day outside the retained rows': [iso(START + 5 * DAY + 3 * HOUR + 13 * 60_000), iso(START + 9 * DAY + 11 * HOUR)],
  'edges on row instants': [rows[1200].startedAt, rows[1800].startedAt],
};
const FILTERS = {
  none: {}, channel: { channelId: 'c1' }, model: { modelId: 'Model/Case-Sensitive' }, 'pool and success': { poolId: 'pool-b', outcomes: ['succeeded'] },
  failed: { outcomes: ['upstream_failed'] }, probes: { kind: 'probe' }, 'unpriced model on a channel': { channelId: 'c2', modelId: 'unpriced-model' },
  'channel, pool and kind': { kind: 'model', channelId: 'c4', poolId: 'pool-a' },
};

async function build(t, { retention = RETENTION, pageSize = 100, items = list } = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), 'motai-retention-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const make = (client) => new GatewayProjection({ directory, client, priceStore, costStore, rowRetentionDays: retention, now: () => END });
  const projection = make(source(items, pageSize));
  await projection.catchUp();
  return { projection, directory, make, client: source(items, pageSize) };
}

function sameBuckets(actual, expected, label) {
  const byKey = new Map(actual.map((summary) => [summary.meta.key, summary]));
  assert.deepEqual([...byKey.keys()].sort(), [...expected.keys()].sort(), `${label}: bucket identities`);
  for (const [key, naive] of expected) {
    const summary = byKey.get(key);
    for (const name of ['attempts', 'cacheInput', 'cacheRead', 'cacheCount', 'durationMs', 'durationCount', 'ttftMs', 'ttftCount']) {
      assert.equal(summary[name], naive[name], `${label}: ${name}`);
    }
    assert.deepEqual(Array.from(summary.tokens), naive.tokens, `${label}: tokens`);
    assert.deepEqual(Array.from(summary.fieldCoverage), naive.fieldCoverage, `${label}: field coverage`);
    assert.deepEqual(summary.costCoverage, naive.costCoverage, `${label}: cost coverage`);
    assert.ok(close(summary.officialCost, naive.officialCost), `${label}: official cost ${summary.officialCost} vs ${naive.officialCost}`);
  }
}

function naiveOverview(selected) {
  const probes = selected.filter((row) => row.kind === 'probe');
  const result = { attempts: selected.length, probes: probes.length, requests: selected.length - probes.length,
    probesSucceeded: probes.filter((row) => row.requestOutcome === 'succeeded').length,
    requestsSucceeded: selected.filter((row) => row.kind !== 'probe' && row.requestOutcome === 'succeeded').length,
    totals: Object.fromEntries(TOKEN_KEYS.map((key, slot) => [key, selected.reduce((sum, row) => sum + row.tokens[slot], 0)])),
    costCoverage: { complete: 0, partial: 0, unknown: 0 }, procurementCoverage: { complete: 0, partial: 0, unknown: 0 }, currencies: new Map() };
  for (const row of selected) {
    result.costCoverage[row.priceStatus] += 1;
    const multiplier = multiplierOf(row);
    if (multiplier === null) result.procurementCoverage.unknown += 1; else result.procurementCoverage[row.priceStatus] += 1;
    if (row.currency === null) continue;
    if (!result.currencies.has(row.currency)) result.currencies.set(row.currency, { officialCost: 0, procurementCost: 0, procurementUnknown: 0 });
    const entry = result.currencies.get(row.currency);
    entry.officialCost += row.officialCost ?? 0;
    if (multiplier === null) entry.procurementUnknown += 1; else entry.procurementCost += (row.officialCost ?? 0) * multiplier;
  }
  return result;
}

function naiveTotals(selected) {
  const coverage = { complete: 0, partial: 0, unknown: 0 }, costs = new Map();
  for (const row of selected) {
    const multiplier = multiplierOf(row);
    if (row.requestOutcome === 'succeeded') { if (multiplier === null) coverage.unknown += 1; else coverage[row.priceStatus] += 1; }
    if (multiplier === null || row.currency === null || row.priceStatus === 'unknown') continue;
    costs.set(row.currency, (costs.get(row.currency) ?? 0) + row.officialCost * multiplier);
  }
  return { requests: selected.length, coverage, costs };
}

function compareAll(projection, label) {
  let combinations = 0;
  for (const [windowName, [from, to]] of Object.entries(WINDOWS)) for (const [filterName, filter] of Object.entries(FILTERS)) {
    const name = `${label} / ${windowName} / ${filterName}`, query = { from, to, ...filter };
    const selected = select(rows, query);
    sameBuckets(projection.summaries(query), naiveBuckets(selected), name);
    const overview = projection.overview(query), expected = naiveOverview(selected);
    for (const key of ['attempts', 'probes', 'requests', 'probesSucceeded', 'requestsSucceeded']) assert.equal(overview[key], expected[key], `${name}: ${key}`);
    assert.deepEqual(overview.totals, expected.totals, `${name}: totals`);
    assert.deepEqual(overview.costCoverage, expected.costCoverage, `${name}: cost coverage`);
    assert.deepEqual(overview.procurementCoverage, expected.procurementCoverage, `${name}: procurement coverage`);
    assert.deepEqual(overview.currencies.map((entry) => entry.currency).sort(), [...expected.currencies.keys()].sort(), `${name}: currencies`);
    for (const entry of overview.currencies) {
      const naive = expected.currencies.get(entry.currency);
      assert.ok(close(entry.officialCost, naive.officialCost), `${name}: official cost`);
      assert.ok(close(entry.procurementCost, naive.procurementCost), `${name}: procurement cost`);
      assert.equal(entry.procurementUnknown, naive.procurementUnknown, `${name}: procurement unknown`);
    }
    const totals = projection.requestTotals(query), naive = naiveTotals(selected);
    assert.equal(totals.requests, naive.requests, `${name}: request count`);
    assert.deepEqual(totals.coverage, naive.coverage, `${name}: summary coverage`);
    assert.deepEqual(totals.costs.map((entry) => entry.currency).sort(), [...naive.costs.keys()].sort(), `${name}: summary currencies`);
    for (const entry of totals.costs) assert.ok(close(entry.amount, naive.costs.get(entry.currency)), `${name}: summary amount`);
    combinations += 1;
  }
  return combinations;
}

test('window and filter combinations equal a naive in-memory reference, with rows kept for three days only', async (t) => {
  const { projection } = await build(t);
  assert.ok(compareAll(projection, 'built') >= 50);
  assert.equal(compareAll(projection, 'built'), Object.keys(WINDOWS).length * Object.keys(FILTERS).length);
});

test('a restart gives the same answers and keeps only the retention window in memory', async (t) => {
  const { projection, make } = await build(t);
  const restored = make(source(list));
  await restored.load();
  assert.equal(restored.state().requiresRebuild, false);
  compareAll(restored, 'restored');
  const cutoffHour = Math.floor(restored.retentionCutoff() / HOUR);
  for (const loaded of [projection, restored]) {
    assert.ok([...loaded.rowsByHour.keys()].every((hour) => hour >= cutoffHour), 'no row older than the window stays in memory');
    const kept = [...loaded.rowsByHour.values()].reduce((sum, items) => sum + items.length, 0);
    assert.equal(loaded.attemptIds.size, kept, 'the duplicate check holds exactly the retained rows');
    assert.ok(kept > 0 && kept < list.length / 4);
    assert.ok(loaded.days.size >= 40, 'day totals are kept for every day');
  }
});

test('the default retention is eight Shanghai days and covers the 24 hour and 7 day rolling windows', async (t) => {
  assert.equal(ROW_RETENTION_DAYS, 8);
  const { projection } = await build(t, { retention: ROW_RETENTION_DAYS });
  const cutoff = projection.retentionCutoff();
  assert.ok(Date.parse(WINDOWS['24h'][0]) >= cutoff && Date.parse(WINDOWS['7d'][0]) >= cutoff);
  const scope = new Map();
  projection.summaries({ from: WINDOWS['7d'][0], to: WINDOWS['7d'][1] }, scope);
  assert.equal(scope.size, 0, 'a 7 day window never reads the disk');
  assert.equal(compareAll(projection, 'eight days'), Object.keys(WINDOWS).length * Object.keys(FILTERS).length);
});

test('recent probes equal the reference for windows up to now and for windows that end in the past', async (t) => {
  const { projection } = await build(t);
  const probes = (channelId) => rows.filter((row) => row.kind === 'probe' && row.channelId === channelId);
  const order = (a, b) => (a.startedAt < b.startedAt ? -1 : a.startedAt > b.startedAt ? 1 : a.attemptId.localeCompare(b.attemptId));
  let checked = 0;
  for (const channelId of CHANNELS) for (const [from, to] of [WINDOWS.all, WINDOWS['7d'], WINDOWS.today, [iso(START), iso(START + 20 * DAY)],
    [iso(START + 12 * DAY), iso(START + 18 * DAY)], [iso(END - 5 * DAY), iso(END - 4 * DAY)], [iso(START - DAY), iso(START + HOUR)]]) {
    const expected = select(probes(channelId), { from, to }).sort(order).slice(-60).map((row) => row.attemptId);
    assert.deepEqual(projection.recentProbes({ channelId, from, to }).map((entry) => entry.attemptId), expected, `${channelId} ${from} ${to}`);
    checked += 1;
  }
  assert.equal(checked, 28);
});

test('every segment records the time range of its rows, and a wrong range is a corrupt checkpoint', async (t) => {
  const { projection, directory, make } = await build(t);
  const checkpoint = JSON.parse(await readFile(projection.checkpointPath(), 'utf8'));
  assert.equal(checkpoint.calcVersion, '8');
  assert.ok(checkpoint.segments.length > 10);
  checkpoint.segments.forEach((segment, index) => {
    const slice = rows.slice(index * 100, index * 100 + segment.count).map((row) => Date.parse(row.startedAt));
    assert.equal(Date.parse(segment.minStartedAt), Math.min(...slice));
    assert.equal(Date.parse(segment.maxStartedAt), Math.max(...slice));
  });
  checkpoint.segments[2].maxStartedAt = iso(END + 10 * DAY);
  await writeFile(projection.checkpointPath(), JSON.stringify(checkpoint));
  const restored = make(source(list));
  const state = await restored.load();
  assert.equal(state.lastError, 'projection_corrupt_segment');
  assert.equal(state.requiresRebuild, true);
  assert.ok(directory);
});

test('a read of a day that is only on disk fails loudly when its segment is damaged', async (t) => {
  const { projection } = await build(t);
  const checkpoint = JSON.parse(await readFile(projection.checkpointPath(), 'utf8'));
  await writeFile(path.join(projection.generationPath(), checkpoint.segments[0].file), '{"damaged":true}\n');
  const old = { from: iso(START), to: iso(START + DAY) };
  assert.throws(() => projection.summaries(old), { code: 'projection_corrupt_segment' });
  assert.throws(() => projection.requestTotals(old), { code: 'projection_corrupt_segment' });
  assert.ok(projection.summaries({ from: WINDOWS.today[0], to: WINDOWS.today[1] }).length > 0, 'days inside the retention window do not touch the disk');
  assert.equal(projection.summaries({ from: iso(START - 4 * DAY), to: iso(START - 2 * DAY) }).length, 0, 'days without data are never read');
});

test('a checkpoint from the previous format is served as stale, then rebuilt into the new format', async (t) => {
  const { projection, make } = await build(t);
  const checkpoint = JSON.parse(await readFile(projection.checkpointPath(), 'utf8'));
  checkpoint.calcVersion = '5';
  for (const segment of checkpoint.segments) { delete segment.minStartedAt; delete segment.maxStartedAt; }
  await writeFile(projection.checkpointPath(), JSON.stringify(checkpoint));
  const old = make(source(list));
  const state = await old.load();
  assert.equal(state.requiresRebuild, true);
  assert.equal(state.writeBlocked, false);
  assert.equal(old.state().stale, true);
  sameBuckets(old.summaries({ from: WINDOWS.all[0], to: WINDOWS.all[1] }), naiveBuckets(rows), 'stale');
  sameBuckets(old.summaries({ from: WINDOWS['old rolling start, half day outside the retained rows'][0], to: WINDOWS['old rolling start, half day outside the retained rows'][1] }),
    naiveBuckets(select(rows, { from: WINDOWS['old rolling start, half day outside the retained rows'][0], to: WINDOWS['old rolling start, half day outside the retained rows'][1] })), 'stale old edge');
  await assert.rejects(old.catchUp(), { code: 'projection_rebuild_required' });
  await old.rebuild();
  assert.equal(old.state().requiresRebuild, false);
  const rebuilt = JSON.parse(await readFile(old.checkpointPath(), 'utf8'));
  assert.equal(rebuilt.calcVersion, '8');
  assert.ok(rebuilt.segments.every((segment) => segment.minStartedAt && segment.maxStartedAt));
  compareAll(old, 'rebuilt');
});

test('a repeated attempt inside the retention window is rejected, an evicted one is not remembered', async (t) => {
  const recent = structuredClone(list[2300]);
  const evicted = structuredClone(list[10]);
  const { projection } = await build(t, { items: list });
  projection.client = source([...list, recent]);
  await assert.rejects(projection.catchUp(), { code: 'projection_duplicate_attempt' });
  const other = await build(t, { items: list });
  other.projection.client = source([...list, evicted]);
  await other.projection.catchUp();
  assert.equal(other.projection.lastSeq, String(list.length + 1));
  assert.ok(randomUUID());
});

test('a retention shorter than one day is refused', async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'motai-retention-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  assert.throws(() => new GatewayProjection({ directory, client: source(list), rowRetentionDays: 0 }), TypeError);
});
