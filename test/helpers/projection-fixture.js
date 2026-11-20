import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { projectAttempt } from '../../src/gateway/projection.js';

// Shared by the projection retention tests: a deterministic stream of attempts over many days, a fake core that serves it in small
// pages (so there are many segments), and a naive reference that keeps every row in memory and just adds things up.
const fixture = async (name) => JSON.parse(await readFile(new URL(`../../contracts/fixtures/${name}.json`, import.meta.url), 'utf8'));
const sample = await fixture('attempt-valid');
const vectors = (await fixture('usage-vectors')).vectors.filter((vector) => ['openai', 'anthropic'].includes(vector.provider));

export const END = Date.parse('2026-10-29T10:17:33.123Z');
export const START = END - 40 * 86_400_000;
export const CHANNELS = ['c1', 'c2', 'c3', 'c4'];
const POOLS = ['pool-a', 'pool-b'];
const MODELS = ['Model/Case-Sensitive', 'Model/Case-Sensitive', 'unpriced-model'];
const MULTIPLIERS = { c1: 0.5, c2: 0.25, c3: null, c4: 0.75 };

export const record = { model: 'Model/Case-Sensitive', effectiveFrom: 0, effectiveTo: null, maxContextTokens: null, currency: 'USD',
  rates: { input: 2, cacheRead: 0.2, cacheWrite: 3, cacheWrite1h: 4, cacheWriteUnknown: 5, output: 10 } };
export const priceStore = { snapshot: () => ({ snapshotHash: 'fixture' }),
  resolve: (model, at, family) => (model === record.model && ['openai', 'anthropic'].includes(family) ? { ...record, family } : null) };
export const costStore = { version: 1, resolve: ({ channelId }) => (MULTIPLIERS[channelId] == null ? null
  : { id: `rule-${channelId}`, revision: 1, multiplier: MULTIPLIERS[channelId] }) };

const fraction = (index) => String((index * 7919) % 1_000_000_000).padStart(9, '0');
const instant = (ms, index) => `${new Date(ms).toISOString().slice(0, 19)}.${fraction(index)}Z`;

export function attempts(count = 2400) {
  const list = [];
  for (let index = 0; index < count; index += 1) {
    const value = structuredClone(sample), vector = vectors[index % vectors.length];
    const ms = START + Math.floor(index * (END - START) / count) + (index * 37) % 5000;
    Object.assign(value.intent, { request_id: randomUUID(), attempt_id: randomUUID(), started_at: instant(ms, index),
      channel_id: CHANNELS[(index * 5) % 4], pool_id: POOLS[(index * 3) % 2], model_canonical: MODELS[(index * 7) % 3],
      model_requested: 'm', vendor: vector.provider, kind: index % 7 === 3 ? 'probe' : 'model' });
    value.terminal.attempt_id = value.intent.attempt_id;
    value.terminal.ended_at = instant(ms + 1500, index);
    value.terminal.usage = structuredClone(vector.expected);
    if (index % 9 === 0) Object.assign(value.terminal, { request_outcome: 'failed', attempt_outcome: 'upstream_failed',
      upstream_status: 524, error_class: 'upstream_5xx', channel_effect: 'failure_counted' });
    list.push(value);
  }
  // Rows that arrive long after their time: they sit in the last segments but belong to old days.
  for (let late = 0; late < 12; late += 1) {
    const value = structuredClone(list[late * 3]);
    Object.assign(value.intent, { attempt_id: randomUUID(), request_id: randomUUID(), started_at: instant(START + late * 3_600_000 + 777, late) });
    value.terminal.attempt_id = value.intent.attempt_id;
    value.terminal.ended_at = instant(START + late * 3_600_000 + 2277, late);
    list.push(value);
  }
  return list;
}

export function source(list, pageSize = 100) {
  return { async events(query) {
    const after = Number(query.after_seq), events = list.slice(after, after + Math.min(query.limit, pageSize))
      .map((attempt, offset) => ({ format_version: 1, seq: String(after + offset + 1), event_type: 'attempt_terminal', attempt }));
    const next = events.length ? events.at(-1).seq : String(after);
    return { format_version: 1, events, next_seq: next, latest_seq: String(list.length), has_more: Number(next) < list.length };
  } };
}

// Reference rows: the same per-attempt pricing, kept in one array.
export function referenceRows(list) {
  return list.map((attempt) => projectAttempt(attempt, { priceStore, costStore }));
}

const ns = (text) => {
  const [head, fraction = ''] = text.split('.');
  return BigInt(Date.parse(`${head.slice(0, 19)}Z`)) * 1_000_000n + BigInt(fraction.replace('Z', '').padEnd(9, '0'));
};
export const metaKey = (row) => JSON.stringify({ source: row.source, channelId: row.channelId, poolId: row.poolId, modelId: row.modelId,
  vendor: row.vendor, kind: row.kind, requestOutcome: row.requestOutcome, attemptOutcome: row.attemptOutcome, currency: row.currency, priceVersion: row.priceVersion, cooldown: row.cooldown === true });

export function select(rows, { from, to, ...filter }) {
  const low = ns(from), high = ns(to);
  return rows.filter((row) => {
    const at = ns(row.startedAt);
    return at >= low && at < high && (filter.channelId == null || row.channelId === filter.channelId)
      && (filter.poolId == null || row.poolId === filter.poolId) && (filter.modelId == null || row.modelId === filter.modelId)
      && (filter.kind == null || row.kind === filter.kind) && (!filter.outcomes?.length || filter.outcomes.includes(row.attemptOutcome));
  });
}

// Plain sums per bucket identity, written independently of the projection's own aggregation.
export function naiveBuckets(rows) {
  const groups = new Map();
  for (const row of rows) {
    const key = metaKey(row);
    if (!groups.has(key)) groups.set(key, { attempts: 0, tokens: Array(8).fill(0), fieldCoverage: Array(32).fill(0), cacheInput: 0, cacheRead: 0,
      cacheCount: 0, costCoverage: { complete: 0, partial: 0, unknown: 0 }, officialCost: 0, durationMs: 0, durationCount: 0, ttftMs: 0, ttftCount: 0 });
    const group = groups.get(key);
    group.attempts += 1;
    for (let slot = 0; slot < 8; slot += 1) {
      group.tokens[slot] += row.tokens[slot];
      group.fieldCoverage[slot * 4 + Number(row.availability[slot])] += 1;
      if (row.partialMask & (1 << slot)) group.fieldCoverage[slot * 4 + 3] += 1;
    }
    group.cacheInput += row.cacheInput; group.cacheRead += row.cacheRead; group.cacheCount += row.cacheCount;
    group.costCoverage[row.priceStatus] += 1;
    if (row.durationMs !== null) { group.durationMs += row.durationMs; group.durationCount += 1; }
    if (row.ttftMs !== null) { group.ttftMs += row.ttftMs; group.ttftCount += 1; }
    if (row.officialCost !== null) group.officialCost += row.officialCost;
  }
  return groups;
}

export const multiplierOf = (row) => costStore.resolve({ channelId: row.channelId, model: row.modelId })?.multiplier ?? null;
