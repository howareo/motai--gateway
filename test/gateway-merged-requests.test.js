import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { GatewayPanel } from '../src/gateway/panel.js';
import { GatewayProjection } from '../src/gateway/projection.js';
import { ConfigPublisher } from '../src/gateway/config-publisher.js';
import { LegacyOverview } from '../src/gateway/legacy-overview.js';
import { LegacyImport, normalizeLegacyRow } from '../src/gateway/legacy-import.js';
import { resolvePeriod } from '../src/calendar-periods.js';

const fixture = async (name) => JSON.parse(await readFile(new URL(`../contracts/fixtures/${name}.json`, import.meta.url), 'utf8'));
const sample = await fixture('attempt-valid');
const config = await fixture('config-valid');
const MODEL = config.models[0].id;
const CHANNEL = config.channels[0].id;
const sec = (iso) => Date.parse(iso) / 1000;
const now = Date.parse('2026-10-28T12:00:00Z');
const FROM = sec('2026-10-20T00:00:00Z'), TO = sec('2026-10-28T10:00:00Z');
const record = { model: MODEL, family: 'openai', effectiveFrom: 0, effectiveTo: null, promptIncludesCache: true,
  maxContextTokens: null, currency: 'USD', rates: { input: 2, cacheRead: 0.2, output: 10 } };
const prices = { resolve: (model, at, family) => ({ ...record, model, family }), snapshot: () => ({ snapshotHash: 'p' }), load: async () => {} };
const costStore = { version: 1, resolve: () => ({ id: 'rule-1', revision: 1, multiplier: 0.5 }) };

const legacyRow = (id, at, extra = {}) => ({ id, created_at: at, channel: Number(CHANNEL), model_name: MODEL, prompt_tokens: 100,
  completion_tokens: 20, quota: 0, use_time: 2, is_stream: true,
  other: { usage_semantic: 'openai', cache_tokens: 10, cache_creation_tokens: 0, frt: 500 }, ...extra });

function gatewayAttempt(startedAt, { failed = false, stream = true, cooldown = false } = {}) {
  const value = structuredClone(sample);
  value.intent.request_id = randomUUID(); value.intent.attempt_id = randomUUID();
  value.terminal.attempt_id = value.intent.attempt_id;
  value.intent.channel_id = CHANNEL; value.intent.pool_id = config.channels[0].pool_id; value.intent.stream = stream;
  value.intent.started_at = startedAt; value.terminal.ended_at = new Date(Date.parse(startedAt) + 1000).toISOString().replace('.000Z', 'Z');
  if (failed) Object.assign(value.terminal, { request_outcome: 'failed', attempt_outcome: 'upstream_failed',
    upstream_status: 524, error_class: 'upstream_5xx', channel_effect: cooldown ? 'cooldown' : 'failure_counted' });
  return value;
}

// Fake core: filtered attempts newest first; the cursor is just the offset into that list.
function fakeClient(attempts) {
  const calls = [];
  return { calls, events: async () => ({ format_version: 1, events: [], next_seq: '0', latest_seq: '0', has_more: false }),
    attempts: async (query) => {
      calls.push(query);
      // Compare as instants (the real core orders by time, not by string): fractional seconds sort after the whole second.
      const at = (row) => Date.parse(row.intent.started_at.replace(/\.(\d{3})\d*Z$/, '.$1Z'));
      const list = attempts.filter((row) => at(row) >= Date.parse(query.from) && at(row) < Date.parse(query.to)
        && (!query.channel_id || row.intent.channel_id === query.channel_id)
        && (!query.pool_id || row.intent.pool_id === query.pool_id)
        && (!query.model_id || row.intent.model_canonical === query.model_id)
        && (!query.cooldown_only || row.terminal.channel_effect === 'cooldown')
        && (!query.outcomes.length || query.outcomes.includes(row.terminal.attempt_outcome))
        && (query.stream === null || row.intent.stream === query.stream))
        .sort((a, b) => at(b) - at(a) || (a.intent.attempt_id < b.intent.attempt_id ? 1 : -1));
      if (query.reverse) list.reverse();
      const offset = query.cursor ? Number(query.cursor) : 0;
      const page = list.slice(offset, offset + query.limit);
      const more = offset + query.limit < list.length;
      return { format_version: 1, attempts: page, snapshot_seq: '7', has_more: more, next_cursor: more ? String(offset + query.limit) : null,
        ...(query.reverse && !query.cursor && { total: list.length }) };
    } };
}

async function setup(t, { gateway, legacy, enabled = true }) {
  const directory = await mkdtemp(path.join(tmpdir(), 'motai-merged-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const client = fakeClient(gateway);
  const projection = new GatewayProjection({ directory, client, priceStore: prices, costStore, now: () => now });
  const publisher = new ConfigPublisher({ directory, client });
  publisher.current = { config, credentials: await fixture('credentials-valid'), metadata: { testModels: {} } };
  const control = { config: () => publisher.snapshot(), client, publisher, load: async () => {}, status: async () => ({ ready: true }) };
  let overview = null;
  if (enabled) {
    const importer = new LegacyImport({ directory: path.join(directory, 'legacy'), sourceInstanceId: 'prod-1' });
    await importer.load();
    importer.addRows([...legacy[2].map((row) => normalizeLegacyRow(row, { sourceInstanceId: 'prod-1', type: 2 })),
      ...(legacy[5] ?? []).map((row) => normalizeLegacyRow(row, { sourceInstanceId: 'prod-1', type: 5 }))]);
    overview = new LegacyOverview({ importer, from: FROM, to: TO, priceStore: prices, costStore });
  }
  const panel = new GatewayPanel({ control, projection, costStore, legacy: overview, now: () => now });
  return { panel, client };
}

const params = (values = {}) => new URLSearchParams({ hours: '2160', ...values });
async function walk(panel, values, limit) {
  const pages = [];
  let cursor = null;
  do {
    const query = params({ ...values, limit: String(limit), ...(cursor ? { cursor } : {}) });
    const page = await panel.requests(query);
    pages.push(page);
    cursor = page.hasMore ? page.nextCursor : null;
    assert.ok(pages.length < 50, 'paging must terminate');
  } while (cursor);
  return pages;
}

const GATEWAY = [
  gatewayAttempt('2026-10-28T09:00:00.500000000Z'), gatewayAttempt('2026-10-28T08:00:00Z', { failed: true }),
  gatewayAttempt('2026-10-27T10:00:00Z', { stream: false }), gatewayAttempt('2026-10-27T10:00:00.900000000Z'),
];
const LEGACY = {
  2: [legacyRow(11, sec('2026-10-28T08:30:00Z')), legacyRow(12, sec('2026-10-27T10:00:00Z')), legacyRow(13, sec('2026-10-27T10:00:00Z')),
    legacyRow(14, sec('2026-10-26T10:00:00Z'), { is_stream: false }), legacyRow(15, sec('2026-10-21T10:00:00Z'), { model_name: 'other-model' }),
    legacyRow(16, sec('2026-10-21T09:00:00Z'), { channel: 999 })],
  5: [legacyRow(21, sec('2026-10-28T08:00:00Z')), legacyRow(22, sec('2026-10-25T10:00:00Z'))],
};

test('merged request list is newest first and page boundaries never duplicate or drop a row', async (t) => {
  const { panel } = await setup(t, { gateway: GATEWAY, legacy: LEGACY });
  const whole = (await walk(panel, {}, 100))[0];
  assert.equal(whole.items.length, GATEWAY.length + 8);
  assert.equal(whole.hasMore, false);
  assert.equal(whole.nextCursor, null);
  const times = whole.items.map((row) => Date.parse(row.createdAt));
  assert.deepEqual(times, [...times].sort((a, b) => b - a));
  assert.deepEqual([...new Set(whole.items.map((row) => row.source))].sort(), ['legacy', 'motai']);
  for (const limit of [1, 2, 3, 5]) {
    const pages = await walk(panel, {}, limit);
    assert.deepEqual(pages.flatMap((page) => page.items.map((row) => row.id)), whole.items.map((row) => row.id), `limit ${limit}`);
    assert.ok(pages.slice(0, -1).every((page) => page.items.length === limit));
  }
});

test('rows in the same millisecond keep a fixed order: gateway first, old rows by id descending', async (t) => {
  const { panel } = await setup(t, { gateway: GATEWAY, legacy: LEGACY });
  const items = (await walk(panel, {}, 100))[0].items;
  const tie = items.filter((row) => Date.parse(row.createdAt) === sec('2026-10-27T10:00:00Z') * 1000);
  assert.deepEqual(tie.map((row) => row.source), ['motai', 'legacy', 'legacy']);
  assert.deepEqual(tie.slice(1).map((row) => row.id), ['newapi:prod-1:2:13', 'newapi:prod-1:2:12']);
});

test('filters apply to old rows too and unmatched fields never raise', async (t) => {
  const { panel } = await setup(t, { gateway: GATEWAY, legacy: LEGACY });
  const ids = async (values) => (await walk(panel, values, 2)).flatMap((page) => page.items);
  const errors = await ids({ status: 'error' });
  assert.deepEqual(errors.map((row) => row.source).sort(), ['legacy', 'legacy', 'motai']);
  assert.ok(errors.every((row) => row.kind === 'error'));
  assert.equal((await ids({ status: 'success' })).filter((row) => row.source === 'legacy').length, 6);
  assert.equal((await ids({ model: 'other-model' })).length, 1);
  assert.equal((await ids({ channel: '999' })).length, 1);
  const nonStream = await ids({ stream: 'nonstream' });
  assert.deepEqual(nonStream.map((row) => row.stream), [false, false]);
  assert.equal((await ids({ pool: config.channels[0].pool_id })).every((row) => row.source === 'motai'), true);
  assert.deepEqual((await panel.requests(params({ stream: 'failover' }))).items, []);
});

test('old rows carry the panel shape; failed old requests are not costed and successes use the channel multiplier', async (t) => {
  const { panel } = await setup(t, { gateway: GATEWAY, legacy: LEGACY });
  const items = (await walk(panel, {}, 100))[0].items;
  const gateway = items.find((row) => row.source === 'motai');
  const ok = items.find((row) => row.id === 'newapi:prod-1:2:11'), failed = items.find((row) => row.id === 'newapi:prod-1:5:21');
  assert.deepEqual(Object.keys(ok).sort(), Object.keys(gateway).sort());
  assert.equal(ok.channelName, config.channels[0].name);
  assert.equal(ok.providerFamily, 'openai');
  assert.equal(ok.kind, 'success');
  assert.equal(ok.costStatus, 'complete');
  assert.ok(ok.officialCost > 0);
  assert.ok(Math.abs(ok.estimatedCost - ok.officialCost * 0.5) < 1e-12);
  assert.equal(ok.costMultiplier, 0.5);
  assert.equal(ok.durationMs, 2000);
  assert.equal(failed.kind, 'error');
  assert.equal(failed.estimatedCost, null);
  assert.equal(failed.officialCost, null);
  assert.equal(failed.costStatus, 'unknown');
});

test('without legacy history the request list is exactly the gateway list', async (t) => {
  const { panel, client } = await setup(t, { gateway: GATEWAY, legacy: LEGACY, enabled: false });
  const page = await panel.requests(params({ limit: '2' }));
  assert.equal(page.items.length, 2);
  assert.equal(page.nextCursor, '2');
  assert.equal(client.calls[0].limit, 2);
});

test('last page jumps directly to the oldest matching rows; reverse pages reconstruct the same filtered list', async (t) => {
  for (const enabled of [true, false]) {
    const { panel, client } = await setup(t, { gateway: GATEWAY, legacy: LEGACY, enabled });
    for (const filter of [{}, { status: 'error' }, { stream: 'nonstream' }, { channel: '999' }, { pool: config.channels[0].pool_id }, { model: 'other-model' }]) {
      const whole = (await walk(panel, filter, 100))[0].items.map((row) => row.id);
      for (const limit of [1, 3, 5]) {
        const countBefore = client.calls.length;
        let page = await panel.requests(params({ ...filter, limit: String(limit), last: '1' }));
        assert.equal(client.calls.length - countBefore, 1, 'last page reads one core chunk, not all earlier pages');
        assert.equal(page.page, Math.max(1, Math.ceil(whole.length / limit)));
        assert.equal(page.total, whole.length);
        assert.equal(page.hasMore, false);
        assert.deepEqual(page.items.map((row) => row.id), whole.slice(Math.floor(Math.max(0, whole.length - 1) / limit) * limit));
        let rows = page.items;
        while (page.previousCursor) {
          page = await panel.requests(params({ ...filter, limit: String(limit), reverse: '1', page: String(page.page - 1),
            cursor: page.previousCursor, snapshotSeq: page.snapshotSeq, from: page.periodStartAt, to: page.periodEndAt }));
          rows = [...page.items, ...rows];
        }
        assert.deepEqual(rows.map((row) => row.id), whole);
      }
    }
  }
});

test('a malformed cursor is a contract error, not a crash', async (t) => {
  const { panel } = await setup(t, { gateway: GATEWAY, legacy: LEGACY });
  const bad = [Buffer.from('{"v":1}').toString('base64url'), '!!', Buffer.from('{"v":1,"s":null,"g":{"c":null,"o":-1,"d":false},"l":null}').toString('base64url')];
  for (const cursor of bad) await assert.rejects(panel.requests(params({ cursor })), { code: 'invalid_contract' });
});

test('last page also filters cooldown attempts and legacy failovers before counting', async (t) => {
  const gateway = GATEWAY.map((row) => structuredClone(row));
  gateway[1].terminal.channel_effect = 'cooldown';
  const { panel } = await setup(t, { gateway, legacy: FAILOVER_LEGACY });
  const whole = (await walk(panel, { stream: 'failover' }, 100))[0].items;
  let page = await panel.requests(params({ stream: 'failover', limit: '2', last: '1' }));
  assert.equal(page.total, whole.length);
  let items = page.items;
  while (page.previousCursor) {
    page = await panel.requests(params({ stream: 'failover', limit: '2', reverse: '1', page: String(page.page - 1),
      cursor: page.previousCursor, snapshotSeq: page.snapshotSeq, from: page.periodStartAt, to: page.periodEndAt }));
    items = [...page.items, ...items];
  }
  assert.deepEqual(items.map((row) => row.id), whole.map((row) => row.id));
});

test('period all starts at the old history, then the first gateway day, then 90 days back', async (t) => {
  const withLegacy = await setup(t, { gateway: GATEWAY, legacy: LEGACY });
  const all = await withLegacy.panel.requests(new URLSearchParams({ period: 'all' }));
  assert.equal(all.periodKey, 'all');
  assert.equal(all.periodLabel, '全部');
  assert.equal(Date.parse(all.periodStartAt) / 1000, FROM);
  assert.equal(Date.parse(all.periodEndAt), now);
  const overview = withLegacy.panel.overview(new URLSearchParams({ period: 'all' }));
  assert.equal(overview.periodKey, 'all');
  assert.equal(overview.periodStartAt, new Date(FROM * 1000).toISOString());
  assert.equal(overview.source.legacy.mergedFrom, new Date(FROM * 1000).toISOString());
  const without = await setup(t, { gateway: [], legacy: LEGACY, enabled: false });
  assert.equal(Date.parse(without.panel.overview(new URLSearchParams({ period: 'all' })).periodStartAt), now - 90 * 86_400_000);
  assert.deepEqual(resolvePeriod({ period: 'all', nowMs: now, allStartTimestamp: now / 1000 + 5 }).startTimestamp, now / 1000 - 90 * 86_400);
  assert.equal(resolvePeriod({ hours: 2160, nowMs: now }).hours, 2160);
  assert.equal(resolvePeriod({ hours: 99999, nowMs: now }).hours, 2160);
});

const routed = (id, at, route) => legacyRow(id, at, { other: { usage_semantic: 'openai', cache_tokens: 10, cache_creation_tokens: 0, frt: 500,
  admin_info: { use_channel: route } } });
const FAILOVER_LEGACY = {
  2: [routed(31, sec('2026-10-28T08:30:00Z'), [2, 3]), routed(32, sec('2026-10-27T10:00:00Z'), [2, 3, 4]),
    routed(33, sec('2026-10-22T10:00:00Z'), [5, 6]), routed(34, sec('2026-10-27T11:00:00Z'), [2]), legacyRow(35, sec('2026-10-27T12:00:00Z'))],
};

test('the failover filter lists old rows that changed channel, pages without a gateway read, and keeps the other filters', async (t) => {
  const { panel, client } = await setup(t, { gateway: GATEWAY, legacy: FAILOVER_LEGACY });
  const pages = await walk(panel, { stream: 'failover' }, 2);
  const items = pages.flatMap((page) => page.items);
  assert.deepEqual(items.map((row) => row.id), ['newapi:prod-1:2:31', 'newapi:prod-1:2:32', 'newapi:prod-1:2:33']);
  assert.ok(items.every((row) => row.source === 'legacy' && row.failover === true));
  assert.deepEqual(pages.map((page) => page.items.length), [2, 1]);
  assert.equal(pages.at(-1).hasMore, false);
  // The gateway side is read too, but only for failed attempts and with no transport filter; none of them tripped a cooldown here.
  assert.ok(client.calls.length > 0);
  assert.ok(client.calls.every((call) => call.stream === null && !call.outcomes.includes('succeeded') && call.outcomes.length > 0));
  const none = await walk(panel, { stream: 'failover', status: 'error' }, 2);
  assert.deepEqual(none.flatMap((page) => page.items), []);
  const narrowed = await walk(panel, { stream: 'failover', channel: CHANNEL }, 2);
  assert.deepEqual(narrowed.flatMap((page) => page.items.map((row) => row.id)), ['newapi:prod-1:2:31', 'newapi:prod-1:2:32', 'newapi:prod-1:2:33']);
  assert.deepEqual((await walk(panel, { stream: 'failover', channel: '999' }, 2)).flatMap((page) => page.items), []);
});

test('overview failovers counts the old rows that changed channel in the selected period; the gateway adds none', async (t) => {
  const { panel } = await setup(t, { gateway: GATEWAY, legacy: FAILOVER_LEGACY });
  assert.equal(panel.overview(new URLSearchParams({ hours: '2160' })).metrics.failovers, 3);
  assert.equal(panel.overview(new URLSearchParams({ hours: '24' })).metrics.failovers, 1);
  assert.equal(panel.overview(new URLSearchParams({ hours: '2160' })).metrics.totalRequests, FAILOVER_LEGACY[2].length);
  const { panel: plain } = await setup(t, { gateway: GATEWAY, legacy: FAILOVER_LEGACY, enabled: false });
  assert.equal(plain.overview(new URLSearchParams({ hours: '2160' })).metrics.failovers, 0);
});

test('failover counting reads the row index once, not the whole history per call', async (t) => {
  const { panel } = await setup(t, { gateway: GATEWAY, legacy: FAILOVER_LEGACY });
  let reads = 0;
  const original = panel.legacy.importer.forEachRow.bind(panel.legacy.importer);
  panel.legacy.importer.forEachRow = (...args) => { reads += 1; return original(...args); };
  for (const hours of ['2160', '24', '168']) panel.overview(new URLSearchParams({ hours }));
  assert.ok(reads <= 1, `row scans: ${reads}`);
});

// Gateway rows that tripped a cooldown (c1..c3), a plain failure between them, a success, and one on another model.
const cooled = (at, extra = {}) => gatewayAttempt(at, { failed: true, cooldown: true, ...extra });
const COOLDOWN_GATEWAY = [
  cooled('2026-10-28T09:30:00Z'), gatewayAttempt('2026-10-28T09:15:00Z', { failed: true }), gatewayAttempt('2026-10-28T09:10:00Z'),
  cooled('2026-10-27T11:30:00Z'), gatewayAttempt('2026-10-27T09:00:00Z', { failed: true }), cooled('2026-10-22T10:00:00Z'),
];
COOLDOWN_GATEWAY[3].intent.model_canonical = 'other-model';
const ids = (items) => items.map((row) => row.id);

test('the auto switch filter lists gateway cooldown rows and old failover rows together, newest first, whatever the page size', async (t) => {
  const { panel, client } = await setup(t, { gateway: COOLDOWN_GATEWAY, legacy: FAILOVER_LEGACY });
  const whole = (await walk(panel, { stream: 'failover' }, 100))[0].items;
  // Old failover rows: 31 (10-28 08:30), 32 (10-27 10:00), 33 (10-22 10:00).
  assert.deepEqual(whole.map((row) => [row.source, row.createdAt.slice(0, 16)]), [
    ['motai', '2026-10-28T09:30'], ['legacy', '2026-10-28T08:30'], ['motai', '2026-10-27T11:30'],
    ['legacy', '2026-10-27T10:00'], ['motai', '2026-10-22T10:00'], ['legacy', '2026-10-22T10:00']]);
  assert.ok(whole.every((row) => (row.source === 'motai' ? row.cooldownTriggered === true : row.failover === true)));
  assert.ok(client.calls.every((call) => call.stream === null && call.outcomes.length > 0 && !call.outcomes.includes('succeeded')));
  for (const limit of [1, 2, 3, 4]) {
    const pages = await walk(panel, { stream: 'failover' }, limit);
    assert.deepEqual(ids(pages.flatMap((page) => page.items)), ids(whole), `limit ${limit}`);
    assert.ok(pages.slice(0, -1).every((page) => page.items.length === limit && page.hasMore));
    assert.equal(pages.at(-1).hasMore, false);
    assert.equal(pages.at(-1).nextCursor, null);
  }
});

test('the auto switch filter combines with channel, model and status filters on both sources', async (t) => {
  const { panel } = await setup(t, { gateway: COOLDOWN_GATEWAY, legacy: FAILOVER_LEGACY });
  const sources = async (values) => (await walk(panel, { stream: 'failover', ...values }, 2)).flatMap((page) => page.items.map((row) => row.source));
  assert.deepEqual(await sources({ channel: CHANNEL }), ['motai', 'legacy', 'motai', 'legacy', 'motai', 'legacy']);
  assert.deepEqual(await sources({ channel: '999' }), []);
  assert.deepEqual(await sources({ model: 'other-model' }), ['motai']);
  // The 10-27 gateway row is on the other model, so only two gateway rows remain next to the three old rows.
  assert.deepEqual(await sources({ model: MODEL }), ['motai', 'legacy', 'legacy', 'motai', 'legacy']);
  // A cooldown is a failure; old failover rows are successes, so each status keeps one side.
  assert.deepEqual(await sources({ status: 'error' }), ['motai', 'motai', 'motai']);
  assert.deepEqual(await sources({ status: 'success' }), ['legacy', 'legacy', 'legacy']);
  assert.deepEqual(await sources({ pool: config.channels[0].pool_id }), ['motai', 'motai', 'motai']);
});

test('the auto switch filter keeps reading gateway chunks until a cooldown row turns up, and stops when they run out', async (t) => {
  // 250 newer plain failures (three full chunks of 100) hide the only cooldown row, which is older than all of them.
  const plain = Array.from({ length: 250 }, (_, index) => gatewayAttempt(new Date(Date.parse('2026-10-28T09:00:00Z') - index * 60_000).toISOString(), { failed: true }));
  const hidden = cooled('2026-10-23T10:00:00Z');
  const { panel, client } = await setup(t, { gateway: [...plain, hidden], legacy: FAILOVER_LEGACY });
  const pages = await walk(panel, { stream: 'failover' }, 2);
  assert.deepEqual(pages.flatMap((page) => page.items.map((row) => row.source)), ['legacy', 'legacy', 'motai', 'legacy']);
  assert.ok(client.calls.length >= 3, 'chunks were read past the plain failures');
  assert.ok(client.calls.every((call) => call.limit === 100));
  const only = await setup(t, { gateway: [...plain, hidden], legacy: { 2: [] } });
  const sparse = await walk(only.panel, { stream: 'failover' }, 1);
  assert.equal(sparse.length, 1);
  assert.deepEqual(ids(sparse[0].items), [hidden.intent.attempt_id]);
  assert.equal(sparse[0].hasMore, false);
  const none = await setup(t, { gateway: plain, legacy: { 2: [] } });
  const empty = await none.panel.requests(params({ stream: 'failover' }));
  assert.deepEqual(empty.items, []);
  assert.equal(empty.hasMore, false);
});

test('without old history the auto switch filter still lists the gateway cooldown rows', async (t) => {
  const { panel } = await setup(t, { gateway: COOLDOWN_GATEWAY, legacy: FAILOVER_LEGACY, enabled: false });
  const pages = await walk(panel, { stream: 'failover' }, 2);
  assert.deepEqual(pages.flatMap((page) => page.items.map((row) => row.cooldownTriggered)), [true, true, true]);
  assert.equal(pages.length, 2);
  assert.equal(pages.at(-1).hasMore, false);
  assert.equal('summary' in pages[0], false);
});
