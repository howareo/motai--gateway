import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdir, open, readFile, rename } from 'node:fs/promises';
import path from 'node:path';
import { ruleAt, ruleOver } from '../cost-store.js';
import { PRICE_RECORDS, priceCanonical } from '../model-pricing.js';
import { effectiveUsage, usageMetrics } from '../usage-metrics.js';
import { shanghaiDay } from '../calendar-periods.js';
import { compareUtc, isUtc, validatePage, validateRecord } from './schema.js';

const FORMAT = 1;
// 6: segments carry the time range of their rows, minute buckets are gone and rows are kept for a bounded window only.
// 7: rows and buckets carry `cooldown`, set on the attempt that tripped a channel cooldown.
// 8: usage with a prompt total but no cache-read figure is costed as all-uncached input (effectiveUsage), so history is recosted.
const CALC_VERSION = '8';
// Shanghai calendar days (the newest one included) whose individual attempts stay in memory. Day totals are kept forever.
// 8 covers the rolling 24 hour and 7 day windows even when the newest row is a day old.
export const ROW_RETENTION_DAYS = 8;
const NORMALIZER_VERSION = '1';
export const EVENT_PAGE_LIMIT = 2000;
const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;
const SHANGHAI_OFFSET_MS = 28_800_000;
// recentProbes returns this many probes per channel; the newest of them are kept for good, whatever the row retention is.
const PROBE_LIMIT = 60;
const TOKEN_KEYS = ['totalInput', 'inputUncached', 'cacheRead', 'cacheWrite5m', 'cacheWrite1h', 'cacheWriteUnknown', 'output', 'reasoning'];
const AVAILABILITY = ['absent', 'known', 'estimated'];
const hash = (value) => createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
const failure = (code) => Object.assign(new Error(code), { code });
const decimal = (value) => typeof value === 'string' && /^(0|[1-9][0-9]*)$/.test(value);
const futureVersion = (value, expected) => value != null && value !== expected &&
  (!decimal(String(value)) || BigInt(value) > BigInt(expected));
const projectionDataKeys = ['generation', 'lastSeq', 'latestSeq', 'asOf', 'segments', 'days', 'rowsByHour', 'probesByChannel', 'probeTail', 'attemptIds', 'pricingVersion', 'newestMs'];
const safeAdd = (left, right) => {
  if (!Number.isSafeInteger(left + right)) throw failure('projection_count_overflow');
  return left + right;
};

function utcNs(value) {
  if (!isUtc(value)) throw failure('projection_invalid_interval');
  const fraction = (value.split('.')[1]?.slice(0, -1) ?? '').padEnd(9, '0');
  return BigInt(Date.parse(`${value.slice(0, 19)}Z`)) * 1_000_000n + BigInt(fraction);
}

function pricingVersion(priceStore) {
  return hash({ builtIn: PRICE_RECORDS, external: priceStore?.snapshot?.().snapshotHash ?? null });
}

export function projectAttempt(attempt, { priceStore = null, costStore = null, modelVendor = null } = {}) {
  const checked = validateRecord('attempt', attempt, { mode: 'read' });
  if (!checked.valid) throw failure('projection_invalid_attempt');
  return projectCheckedAttempt(attempt, { priceStore, costStore, modelVendor });
}

// commitPage already checks the complete event, including attempt/usage domains.
// Price vendor: the event's own vendor, except 'unknown', which falls back to the vendor currently configured for the model
// (the same rule the old-history row price uses). Only the price lookup changes; the row keeps the event's vendor.
function projectCheckedAttempt(attempt, { priceStore = null, costStore = null, modelVendor = null } = {}) {
  const { intent, terminal } = attempt;
  const timestamp = Date.parse(intent.started_at) / 1000;
  const priceVendor = intent.vendor === 'unknown' ? modelVendor?.(intent.model_canonical) || intent.vendor : intent.vendor;
  const externalRecord = priceStore?.resolve(intent.model_canonical, timestamp, priceVendor) ?? null;
  const usage = effectiveUsage(terminal.usage);
  const priced = priceCanonical({ model: intent.model_canonical, timestamp, family: priceVendor, usage, externalRecord });
  const metrics = usageMetrics([usage]);
  const recordVersion = priced.record ? hash(priced.record) : null;
  const rule = ruleAt(costStore, { channelId: intent.channel_id, model: intent.model_canonical }, timestamp);
  if (rule && (!Number.isFinite(rule.multiplier) || rule.multiplier < 0)) throw failure('projection_invalid_multiplier');
  const contribution = {
    source: intent.source, requestId: intent.request_id, attemptId: intent.attempt_id, startedAt: intent.started_at,
    channelId: intent.channel_id, poolId: intent.pool_id, modelId: intent.model_canonical, vendor: intent.vendor,
    kind: intent.kind, requestOutcome: terminal.request_outcome, attemptOutcome: terminal.attempt_outcome,
    durationMs: terminal.duration_ms, ttftMs: terminal.ttft_ms, cooldown: terminal.channel_effect === 'cooldown',
    upstreamStatus: terminal.upstream_status, errorClass: terminal.error_class,
    currency: priced.currency ?? priced.record?.currency ?? (priced.record ? 'USD' : null),
    priceVersion: recordVersion, officialCost: priced.officialCost, priceStatus: priced.status, priceReason: priced.reason,
    tokens: TOKEN_KEYS.map((key) => metrics.totals[key]),
    availability: TOKEN_KEYS.map((key) => AVAILABILITY.findIndex((state) => metrics.coverage[key][state] === 1)).join(''),
    partialMask: TOKEN_KEYS.reduce((mask, key, index) => mask | (metrics.coverage[key].partial ? 1 << index : 0), 0),
    cacheInput: metrics.cacheKnownInput, cacheRead: metrics.cacheKnownRead, cacheCount: metrics.cacheKnownRequests,
  };
  return { ...contribution, procurement: { ruleId: rule?.id ?? null, revision: rule?.revision ?? null,
    multiplier: rule?.multiplier ?? null, cost: contribution.officialCost !== null && rule
      ? contribution.officialCost * rule.multiplier : null } };
}

function persistedContribution(attempt, { priceStore, modelVendor }, seq) {
  const { procurement, ...row } = projectCheckedAttempt(attempt, { priceStore, modelVendor });
  return { ...row, seq };
}

// One shared object per distinct bucket identity. Every day, every row and every combined result points at the same meta, and
// meta.key (not enumerable) is its JSON text, so keys are never rebuilt per row.
const metas = new Map();
const strings = new Map();
const share = (value) => {
  if (typeof value !== 'string') return value;
  const known = strings.get(value);
  if (known !== undefined) return known;
  strings.set(value, value);
  return value;
};
function bucketMeta(row) {
  const identity = [row.source, row.channelId, row.poolId, row.modelId, row.vendor, row.kind, row.requestOutcome, row.attemptOutcome,
    row.currency, row.priceVersion, row.cooldown === true].join('\u0000');
  let meta = metas.get(identity);
  if (meta === undefined) {
    meta = { source: share(row.source), channelId: share(row.channelId), poolId: share(row.poolId), modelId: share(row.modelId),
      vendor: share(row.vendor), kind: share(row.kind), requestOutcome: share(row.requestOutcome), attemptOutcome: share(row.attemptOutcome),
      currency: share(row.currency), priceVersion: share(row.priceVersion), cooldown: row.cooldown === true };
    Object.defineProperty(meta, 'key', { value: JSON.stringify(meta) });
    Object.freeze(meta);
    metas.set(identity, meta);
  }
  return meta;
}

// Stored day buckets use typed arrays (a plain array of numbers costs several times more); anything that is combined or handed
// out uses plain arrays so sums over a long window can never wrap.
function emptySummary(meta = {}, packed = false) {
  return { meta, attempts: 0, tokens: packed ? new Float64Array(8) : Array(8).fill(0),
    fieldCoverage: packed ? new Uint32Array(32) : Array(32).fill(0),
    cacheInput: 0, cacheRead: 0, cacheCount: 0, costCoverage: { complete: 0, partial: 0, unknown: 0 },
    officialCost: 0, compensation: 0, durationMs: 0, durationCount: 0, ttftMs: 0, ttftCount: 0 };
}

const probeShape = (row) => ({ attemptId: row.attemptId, checkedAt: row.startedAt, success: row.meta.requestOutcome === 'succeeded',
  latencyMs: row.durationMs, model: row.meta.modelId, statusCode: row.upstreamStatus, message: row.errorClass });

// What reads need from one attempt, and nothing else: no request id, sequence or reason text. Probes keep their status and error.
function slimRow(row) {
  const slim = { meta: bucketMeta(row), attemptId: row.attemptId, startedAt: row.startedAt, ms: Date.parse(row.startedAt), durationMs: row.durationMs, ttftMs: row.ttftMs,
    officialCost: row.officialCost, priceStatus: share(row.priceStatus), tokens: row.tokens, availability: share(row.availability),
    partialMask: row.partialMask, cacheInput: row.cacheInput, cacheRead: row.cacheRead, cacheCount: row.cacheCount };
  if (row.kind === 'probe') { slim.upstreamStatus = row.upstreamStatus; slim.errorClass = row.errorClass; }
  return slim;
}

function moneyAdd(summary, amount) {
  const adjusted = amount - summary.compensation;
  const next = summary.officialCost + adjusted;
  if (!Number.isFinite(next)) throw failure('projection_cost_overflow');
  summary.compensation = (next - summary.officialCost) - adjusted;
  summary.officialCost = next;
}

function addRow(summary, row) {
  summary.attempts = safeAdd(summary.attempts, 1);
  for (let index = 0; index < 8; index += 1) {
    summary.tokens[index] = safeAdd(summary.tokens[index], row.tokens[index]);
    const state = Number(row.availability[index]);
    summary.fieldCoverage[index * 4 + state] += 1;
    if (row.partialMask & (1 << index)) summary.fieldCoverage[index * 4 + 3] += 1;
  }
  for (const key of ['cacheInput', 'cacheRead', 'cacheCount']) summary[key] = safeAdd(summary[key], row[key]);
  summary.costCoverage[row.priceStatus] += 1;
  if (row.durationMs !== null) { summary.durationMs = safeAdd(summary.durationMs, row.durationMs); summary.durationCount += 1; }
  if (row.ttftMs !== null) { summary.ttftMs = safeAdd(summary.ttftMs, row.ttftMs); summary.ttftCount += 1; }
  if (row.officialCost !== null) moneyAdd(summary, row.officialCost);
  return summary;
}

function addSummary(target, source) {
  target.attempts = safeAdd(target.attempts, source.attempts);
  for (let index = 0; index < 8; index += 1) target.tokens[index] = safeAdd(target.tokens[index], source.tokens[index]);
  for (let index = 0; index < 32; index += 1) target.fieldCoverage[index] = safeAdd(target.fieldCoverage[index], source.fieldCoverage[index]);
  for (const key of ['cacheInput', 'cacheRead', 'cacheCount']) target[key] = safeAdd(target[key], source[key]);
  for (const key of ['complete', 'partial', 'unknown']) target.costCoverage[key] = safeAdd(target.costCoverage[key], source.costCoverage[key]);
  for (const key of ['durationMs', 'durationCount', 'ttftMs', 'ttftCount']) target[key] = safeAdd(target[key], source[key]);
  moneyAdd(target, source.officialCost);
  if (target.procurement) mergeProcurement(target.procurement, source.procurement ?? unpricedProcurement(source.attempts));
  return target;
}

function cloneSummary(summary, packed = false) {
  return { ...summary, tokens: packed ? Float64Array.from(summary.tokens) : Array.from(summary.tokens),
    fieldCoverage: packed ? Uint32Array.from(summary.fieldCoverage) : Array.from(summary.fieldCoverage), costCoverage: { ...summary.costCoverage },
    ...(summary.procurement && { procurement: cloneProcurement(summary.procurement) }) };
}

// Procurement cost of a summary: official cost times the multiplier in effect when each attempt was made. Stored buckets do not
// carry it (a rule change must not need a rebuild); reads attach it. `coverage` counts the attempts priced with a rule, as the
// official cost coverage does; `unpriced` counts the attempts no rule covered.
export function emptyProcurement() {
  return { cost: 0, compensation: 0, coverage: { complete: 0, partial: 0, unknown: 0 }, unpriced: 0, rules: new Set() };
}

export function unpricedProcurement(attempts) {
  const result = emptyProcurement();
  result.unpriced = attempts;
  return result;
}

function procurementAdd(procurement, amount) {
  const adjusted = amount - procurement.compensation;
  const next = procurement.cost + adjusted;
  if (!Number.isFinite(next)) throw failure('projection_cost_overflow');
  procurement.compensation = (next - procurement.cost) - adjusted;
  procurement.cost = next;
}

const usableRule = (rule) => rule && Number.isFinite(rule.multiplier) && rule.multiplier >= 0;

// One attempt (or old-history row) priced with the rule in effect at its time.
export function addProcurement(procurement, rule, status, officialCost) {
  if (!usableRule(rule)) { procurement.unpriced += 1; return; }
  procurement.coverage[status] += 1;
  if (officialCost !== null && status !== 'unknown') procurementAdd(procurement, officialCost * rule.multiplier);
  procurement.rules.add(`${rule.id}:${rule.revision}`);
}

// A whole summary priced with one rule (the rule did not change over the time the summary covers).
export function summaryProcurement(summary, rule) {
  if (!usableRule(rule)) return unpricedProcurement(summary.attempts);
  const result = emptyProcurement();
  result.coverage = { ...summary.costCoverage };
  procurementAdd(result, summary.officialCost * rule.multiplier);
  result.rules.add(`${rule.id}:${rule.revision}`);
  return result;
}

function mergeProcurement(target, source) {
  for (const key of ['complete', 'partial', 'unknown']) target.coverage[key] += source.coverage[key];
  target.unpriced += source.unpriced;
  procurementAdd(target, source.cost);
  for (const rule of source.rules) target.rules.add(rule);
}

function cloneProcurement(procurement) {
  return { ...procurement, coverage: { ...procurement.coverage }, rules: new Set(procurement.rules) };
}

export { TOKEN_KEYS };

// Build a read-side summary from counts aggregated outside the event stream (legacy history).
// It has the same shape as an internal bucket, so summarize/breakdown treat it like any other bucket.
export function externalSummary(meta, { attempts, tokens, fieldCoverage, costCoverage, officialCost = null }) {
  const summary = emptySummary(meta);
  summary.attempts = attempts;
  summary.tokens = [...tokens];
  summary.fieldCoverage = [...fieldCoverage];
  summary.costCoverage = { complete: 0, partial: 0, unknown: 0, ...costCoverage };
  if (officialCost !== null && Number.isFinite(officialCost) && officialCost !== 0) moneyAdd(summary, officialCost);
  return summary;
}

function stageBucket(changes, existing, period, key, meta, row) {
  if (!changes.has(period)) changes.set(period, new Map());
  const buckets = changes.get(period);
  if (!buckets.has(key)) buckets.set(key, existing.get(period)?.has(key)
    ? cloneSummary(existing.get(period).get(key), true) : emptySummary(meta, true));
  addRow(buckets.get(key), row);
}

function matches(meta, filter) {
  return (filter.source == null || meta.source === filter.source)
    && (filter.channelId == null || meta.channelId === filter.channelId)
    && (filter.poolId == null || meta.poolId === filter.poolId)
    && (filter.modelId == null || meta.modelId === filter.modelId)
    && (filter.kind == null || meta.kind === filter.kind)
    && (!filter.outcomes?.length || filter.outcomes.includes(meta.attemptOutcome));
}

async function syncDirectory(directory) {
  if (process.platform === 'win32') return;
  const handle = await open(directory, 'r');
  try { await handle.sync(); } finally { await handle.close(); }
}

async function atomicJson(file, value, { syncParent = true, directorySync = syncDirectory } = {}) {
  await atomicBytes(file, `${JSON.stringify(value)}\n`, { syncParent, directorySync });
}

async function atomicBytes(file, bytes, { syncParent = true, directorySync = syncDirectory } = {}) {
  const temporary = `${file}.${randomUUID()}.tmp`;
  const handle = await open(temporary, 'wx', 0o600);
  try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
  await rename(temporary, file);
  if (syncParent) await directorySync(path.dirname(file));
}

const probeOrder = (left, right) => compareUtc(left.startedAt, right.startedAt) || left.attemptId.localeCompare(right.attemptId);
function insertSorted(list, row) {
  if (!list.length || probeOrder(list.at(-1), row) <= 0) { list.push(row); return; }
  let low = 0, high = list.length;
  while (low < high) { const middle = (low + high) >>> 1; if (probeOrder(list[middle], row) <= 0) low = middle + 1; else high = middle; }
  list.splice(low, 0, row);
}

// A row is inside [from, to) when its instant is; the millisecond value decides all but the two boundary milliseconds.
function inRange(row, range) {
  if (row.ms > range.fromMs && row.ms < range.toMs) return true;
  if (row.ms < range.fromMs || row.ms > range.toMs) return false;
  const at = utcNs(row.startedAt);
  return at >= range.fromNs && at < range.toNs;
}

export class GatewayProjection {
  // modelVendor(modelId) returns the vendor currently configured for a model, or null; it is only used for events whose vendor is 'unknown'.
  constructor({ directory, client, priceStore = null, costStore = null, modelVendor = null, rowRetentionDays = ROW_RETENTION_DAYS,
    now = () => Date.now(), directorySync = syncDirectory }) {
    if (!Number.isInteger(rowRetentionDays) || rowRetentionDays < 1) throw new TypeError('rowRetentionDays must be a positive integer');
    this.rowRetentionDays = rowRetentionDays;
    if (!directory || !client?.events) throw new TypeError('Projection directory and event client required');
    this.directory = directory;
    this.client = client;
    this.modelVendor = modelVendor;
    this.priceStore = priceStore;
    this.costStore = costStore;
    this.now = now;
    this.directorySync = directorySync;
    this.generation = randomUUID();
    this.lastSeq = '0';
    this.latestSeq = '0';
    this.asOf = null;
    this.segments = [];
    // Day totals (Shanghai days) are kept for good. Individual attempts, probes and the duplicate check only for the retention window.
    this.days = new Map();
    this.rowsByHour = new Map();
    this.attemptIds = new Set();
    this.probesByChannel = new Map();
    this.probeTail = new Map();
    this.newestMs = 0;
    this.pending = null;
    this.lastError = null;
    this.pricingVersion = pricingVersion(priceStore);
    this.loaded = false;
    this.recoveryRequired = false;
    this.writeBlocked = false;
  }

  state() {
    const versionsMatch = this.pricingVersion === pricingVersion(this.priceStore);
    return { schemaVersion: FORMAT, calcVersion: CALC_VERSION, normalizerVersion: NORMALIZER_VERSION,
      projectedSeq: this.lastSeq, latestSeq: this.latestSeq, asOf: this.asOf,
      stale: this.asOf === null || this.lastSeq !== this.latestSeq || this.lastError !== null || !versionsMatch || !!this.rebuildPending,
      staleMs: this.asOf === null ? null : Math.max(0, this.now() - Date.parse(this.asOf)),
      rebuilding: !!this.rebuildPending, catchingUp: !!this.pending, lastError: this.lastError,
      requiresRebuild: this.recoveryRequired || !versionsMatch, writeBlocked: this.writeBlocked, pricingVersion: this.pricingVersion };
  }

  async load() {
    if (this.loaded) return this.state();
    if (this.loadPending) return this.loadPending;
    this.loadPending = this.restore().finally(() => { this.loadPending = null; });
    return this.loadPending;
  }

  async restore() {
    let pointerFound = false;
    try {
      const pointer = JSON.parse(await readFile(path.join(this.directory, 'current.json'), 'utf8'));
      pointerFound = true;
      if (futureVersion(pointer.schemaVersion, FORMAT)) throw failure('projection_future_version');
      if (pointer.schemaVersion !== FORMAT || !/^[a-f0-9-]{36}$/.test(pointer.generation)) throw failure('projection_incompatible_checkpoint');
      const restored = new GatewayProjection({ directory: this.directory, client: this.client, priceStore: this.priceStore, costStore: this.costStore,
        modelVendor: this.modelVendor, rowRetentionDays: this.rowRetentionDays, now: this.now, directorySync: this.directorySync });
      restored.generation = pointer.generation;
      const checkpoint = JSON.parse(await readFile(restored.checkpointPath(), 'utf8'));
      if (futureVersion(checkpoint.schemaVersion, FORMAT) || futureVersion(checkpoint.calcVersion, CALC_VERSION)
        || futureVersion(checkpoint.normalizerVersion, NORMALIZER_VERSION)) throw failure('projection_future_version');
      if (checkpoint.schemaVersion !== FORMAT || !decimal(checkpoint.lastSeq) || !decimal(checkpoint.latestSeq)
        || BigInt(checkpoint.latestSeq) < BigInt(checkpoint.lastSeq) || !isUtc(checkpoint.asOf)
        || typeof checkpoint.pricingVersion !== 'string' || !Array.isArray(checkpoint.segments)) throw failure('projection_incompatible_checkpoint');
      restored.pricingVersion = checkpoint.pricingVersion;
      let previous = '0';
      for (const segment of checkpoint.segments) {
        if (!/^segment-[0-9]+-[0-9]+-[a-f0-9]{64}\.json$/.test(segment.file)) throw failure('projection_corrupt_segment');
        if (segment.fromSeq !== previous || !decimal(segment.toSeq) || !Number.isSafeInteger(segment.count) || segment.count < 0) throw failure('projection_corrupt_segment');
        const bytes = await readFile(path.join(restored.generationPath(), segment.file), 'utf8');
        if (hash(bytes) !== segment.sha256) throw failure('projection_corrupt_segment');
        const data = JSON.parse(bytes);
        if (futureVersion(data.schemaVersion, FORMAT)) throw failure('projection_future_version');
        if (data.schemaVersion !== FORMAT || data.fromSeq !== previous || data.toSeq !== segment.toSeq
          || !Array.isArray(data.contributions) || data.contributions.length !== segment.count
          || BigInt(data.toSeq) - BigInt(previous) !== BigInt(segment.count)) throw failure('projection_corrupt_segment');
        for (const [index, row] of data.contributions.entries()) {
          if (row.seq !== (BigInt(previous) + BigInt(index) + 1n).toString() || !isUtc(row.startedAt)
            || !['old', 'motai'].includes(row.source) || !['model', 'probe'].includes(row.kind)
            || !['complete', 'partial', 'unknown'].includes(row.priceStatus)
            || typeof row.attemptId !== 'string' || !row.attemptId || typeof row.channelId !== 'string'
            || typeof row.poolId !== 'string' || typeof row.modelId !== 'string'
            || !Array.isArray(row.tokens) || row.tokens.length !== 8 || row.tokens.some((value) => !Number.isSafeInteger(value) || value < 0)
            || typeof row.availability !== 'string' || !/^[012]{8}$/.test(row.availability)
            || !Number.isInteger(row.partialMask) || row.partialMask < 0 || row.partialMask > 255
            || ['cacheInput', 'cacheRead', 'cacheCount'].some((key) => !Number.isSafeInteger(row[key]) || row[key] < 0)
            || ['durationMs', 'ttftMs'].some((key) => row[key] !== null && (!Number.isSafeInteger(row[key]) || row[key] < 0))
            || (row.officialCost !== null && (!Number.isFinite(row.officialCost) || row.officialCost < 0))
            || (row.currency !== null && (typeof row.currency !== 'string' || !/^[A-Z]{3}$/.test(row.currency)))) throw failure('projection_corrupt_segment');
        }
        // One segment at a time: its day totals are added and only the rows inside the retention window stay in memory.
        const staged = restored.stage(data.contributions);
        if (checkpoint.calcVersion === CALC_VERSION) {
          const range = (value) => value === null || (typeof value === 'string' && isUtc(value));
          if (!range(segment.minStartedAt) || !range(segment.maxStartedAt) || (segment.minStartedAt === null) !== (segment.count === 0)
            || (segment.minStartedAt !== null && (Date.parse(segment.minStartedAt) !== Date.parse(staged.range.min)
              || Date.parse(segment.maxStartedAt) !== Date.parse(staged.range.max)))) throw failure('projection_corrupt_segment');
        } else {
          // An older checkpoint is only served until the rebuild replaces it; its ranges are worked out here, in memory.
          segment.minStartedAt = staged.range.min;
          segment.maxStartedAt = staged.range.max;
        }
        restored.install(staged);
        previous = data.toSeq;
      }
      if (previous !== checkpoint.lastSeq) throw failure('projection_corrupt_checkpoint');
      restored.lastSeq = checkpoint.lastSeq;
      restored.latestSeq = checkpoint.latestSeq;
      restored.asOf = checkpoint.asOf;
      restored.segments = checkpoint.segments;
      for (const key of projectionDataKeys) this[key] = restored[key];
      this.recoveryRequired = checkpoint.calcVersion !== CALC_VERSION || checkpoint.normalizerVersion !== NORMALIZER_VERSION;
      this.lastError = this.recoveryRequired ? 'projection_calculation_version_changed' : null;
    } catch (error) {
      if (error.code === 'ENOENT' && !pointerFound) { this.loaded = true; return this.state(); }
      this.writeBlocked = error.code === 'projection_future_version';
      this.recoveryRequired = !this.writeBlocked;
      this.lastError = this.writeBlocked ? 'projection_future_version' : error.code?.startsWith('projection_') ? error.code : 'projection_corrupt_checkpoint';
    }
    this.loaded = true;
    return this.state();
  }

  generationPath() { return path.join(this.directory, this.generation); }
  checkpointPath() { return path.join(this.generationPath(), 'checkpoint.json'); }

  stage(contributions) {
    const days = new Map(), identities = new Set(), dayNames = new Map(), times = [];
    let min = null, max = null;
    for (const row of contributions) {
      const identity = `${row.source}:${row.attemptId}`;
      // Duplicates are only detected among the rows of the retention window: older attempts are not remembered. The core hands out
      // strictly consecutive sequence numbers and every page is checked for that, so a repeated attempt is not expected there.
      if (this.attemptIds.has(identity) || identities.has(identity)) throw failure('projection_duplicate_attempt');
      identities.add(identity);
      const timestamp = Date.parse(row.startedAt);
      const dayNumber = Math.floor((timestamp + SHANGHAI_OFFSET_MS) / DAY_MS);
      if (!dayNames.has(dayNumber)) dayNames.set(dayNumber, shanghaiDay(timestamp));
      const meta = bucketMeta(row);
      stageBucket(days, this.days, dayNames.get(dayNumber), meta.key, meta, row);
      times.push(timestamp);
      if (min === null || timestamp < min.ms) min = { ms: timestamp, text: row.startedAt };
      if (max === null || timestamp > max.ms) max = { ms: timestamp, text: row.startedAt };
    }
    return { days, contributions, identities, times, range: { min: min?.text ?? null, max: max?.text ?? null } };
  }

  // Start of the oldest Shanghai day whose attempts are kept in memory (the newest row's day and the days before it).
  retentionCutoff() {
    if (!this.newestMs) return 0;
    const newestDay = Math.floor((this.newestMs + SHANGHAI_OFFSET_MS) / DAY_MS);
    return (newestDay - (this.rowRetentionDays - 1)) * DAY_MS - SHANGHAI_OFFSET_MS;
  }

  install(staged) {
    for (const [period, buckets] of staged.days) {
      if (!this.days.has(period)) this.days.set(period, new Map());
      for (const [key, summary] of buckets) this.days.get(period).set(key, summary);
    }
    for (const time of staged.times) if (time > this.newestMs) this.newestMs = time;
    const cutoff = this.retentionCutoff();
    for (const [index, row] of staged.contributions.entries()) {
      const timestamp = staged.times[index], probe = row.kind === 'probe';
      if (timestamp < cutoff && !probe) continue;
      const kept = slimRow(row);
      if (probe) {
        // The newest probes of a channel stay whatever their age, so the usual "latest probes" read never needs the disk.
        if (!this.probeTail.has(kept.meta.channelId)) this.probeTail.set(kept.meta.channelId, []);
        const tail = this.probeTail.get(kept.meta.channelId);
        insertSorted(tail, kept);
        if (tail.length > PROBE_LIMIT) tail.shift();
      }
      if (timestamp < cutoff) continue;
      const hour = Math.floor(timestamp / HOUR_MS);
      if (!this.rowsByHour.has(hour)) this.rowsByHour.set(hour, []);
      this.rowsByHour.get(hour).push(kept);
      this.attemptIds.add(`${kept.meta.source}:${kept.attemptId}`);
      if (probe) {
        if (!this.probesByChannel.has(kept.meta.channelId)) this.probesByChannel.set(kept.meta.channelId, []);
        insertSorted(this.probesByChannel.get(kept.meta.channelId), kept);
      }
    }
    this.evict(cutoff);
  }

  evict(cutoff = this.retentionCutoff()) {
    const cutoffHour = Math.floor(cutoff / HOUR_MS);
    for (const [hour, rows] of this.rowsByHour) {
      if (hour >= cutoffHour) continue;
      for (const row of rows) this.attemptIds.delete(`${row.meta.source}:${row.attemptId}`);
      this.rowsByHour.delete(hour);
    }
    for (const [channelId, probes] of this.probesByChannel) {
      let drop = 0;
      while (drop < probes.length && probes[drop].ms < cutoff) drop += 1;
      if (drop) probes.splice(0, drop);
      if (!probes.length) this.probesByChannel.delete(channelId);
    }
  }

  // The rows of one segment, read from disk and checked against the hash in the checkpoint. A failure is an error, never an empty result.
  readSegmentRows(segment) {
    let bytes;
    try { bytes = readFileSync(path.join(this.generationPath(), segment.file), 'utf8'); } catch { throw failure('projection_segment_unreadable'); }
    if (hash(bytes) !== segment.sha256) throw failure('projection_corrupt_segment');
    let data;
    try { data = JSON.parse(bytes); } catch { throw failure('projection_corrupt_segment'); }
    if (!Array.isArray(data.contributions) || data.contributions.length !== segment.count) throw failure('projection_corrupt_segment');
    return data.contributions;
  }

  // One Shanghai day that is no longer in memory, as hour -> rows. The caller's scope keeps it for the duration of one query only.
  diskDay(dayNumber, scope) {
    if (scope.has(dayNumber)) return scope.get(dayNumber);
    const startMs = dayNumber * DAY_MS - SHANGHAI_OFFSET_MS, endMs = startMs + DAY_MS;
    const hours = new Map();
    for (const segment of this.segments) {
      if (segment.minStartedAt === null || Date.parse(segment.minStartedAt) >= endMs || Date.parse(segment.maxStartedAt) < startMs) continue;
      for (const row of this.readSegmentRows(segment)) {
        const at = Date.parse(row.startedAt);
        if (at < startMs || at >= endMs) continue;
        const hour = Math.floor(at / HOUR_MS);
        if (!hours.has(hour)) hours.set(hour, []);
        hours.get(hour).push(slimRow(row));
      }
    }
    scope.set(dayNumber, hours);
    return hours;
  }

  rowsOfHour(hour, scope) {
    if (hour * HOUR_MS >= this.retentionCutoff()) return this.rowsByHour.get(hour) ?? [];
    return this.diskDay(Math.floor((hour * HOUR_MS + SHANGHAI_OFFSET_MS) / DAY_MS), scope).get(hour) ?? [];
  }

  // The stored buckets of one whole Shanghai day that pass `filter`, each as a copy carrying its procurement cost. A bucket whose
  // rule did not change during the day is priced as a whole; one whose rule changed is priced from its attempts, each with the
  // rule in effect when it was made. Attempts no longer found count as unpriced rather than being priced with another rule.
  pricedDay(day, startMs, filter, scope) {
    const buckets = this.days.get(day);
    if (!buckets) return [];
    const from = startMs / 1000, to = (startMs + DAY_MS) / 1000;
    const result = [], split = new Map();
    for (const [key, summary] of buckets) {
      if (!matches(summary.meta, filter)) continue;
      const target = { channelId: summary.meta.channelId, model: summary.meta.modelId };
      const over = ruleOver(this.costStore, target, from, to);
      if (!over.changes) { result.push({ ...summary, procurement: summaryProcurement(summary, over.rule) }); continue; }
      const entry = { summary, target, procurement: emptyProcurement(), seen: 0 };
      split.set(key, entry);
    }
    if (split.size) {
      for (let hour = startMs / HOUR_MS; hour < (startMs + DAY_MS) / HOUR_MS; hour += 1) {
        for (const row of this.rowsOfHour(hour, scope)) {
          const entry = split.get(row.meta.key);
          if (!entry) continue;
          entry.seen += 1;
          addProcurement(entry.procurement, ruleAt(this.costStore, entry.target, row.ms / 1000), row.priceStatus, row.officialCost);
        }
      }
      for (const { summary, procurement, seen } of split.values()) {
        procurement.unpriced += Math.max(0, summary.attempts - seen);
        result.push({ ...summary, procurement });
      }
    }
    return result;
  }

  // Procurement of a summary built elsewhere (old history, callers' own buckets) over the period it covers. Only a period with one
  // rule can be priced as a whole; otherwise it is left unpriced instead of being priced with the wrong rule.
  spanProcurement(summary, { from, to }) {
    const over = ruleOver(this.costStore, { channelId: summary.meta.channelId, model: summary.meta.modelId },
      Date.parse(from) / 1000, Date.parse(to) / 1000);
    return over.changes ? unpricedProcurement(summary.attempts) : summaryProcurement(summary, over.rule);
  }

  catchUp() {
    if (this.rebuildPending) return this.rebuildPending;
    if (this.pending) return this.pending;
    const run = async () => {
      await this.load();
      if (this.writeBlocked) throw failure('projection_future_version');
      if (this.recoveryRequired) throw failure('projection_rebuild_required');
      if (this.state().requiresRebuild) throw failure('projection_price_version_changed');
      // One bounded read may overlap the previous page's fsync. Only commitPage
      // advances sequence/state, in order; a prefetched failure is always handled.
      const fetchPage = (after) => Promise.resolve().then(() => this.client.events({ after_seq: after, limit: EVENT_PAGE_LIMIT }))
        .then((page) => ({ page }), (error) => ({ error }));
      let fetched = await fetchPage(this.lastSeq);
      while (true) {
        if (fetched.error) throw fetched.error;
        const { page } = fetched;
        const next = page.has_more && decimal(page.next_seq) && BigInt(page.next_seq) > BigInt(this.lastSeq)
          ? fetchPage(page.next_seq) : null;
        await this.commitPage(page);
        if (!page.has_more) break;
        if (!next) throw failure('projection_invalid_sequence');
        fetched = await next;
      }
      this.lastError = null;
      return this.state();
    };
    this.pending = run().catch((error) => { this.lastError = error.code ?? 'projection_catch_up_failed'; throw failure(this.lastError); })
      .finally(() => { this.pending = null; });
    return this.pending;
  }

  async commitPage(page) {
    if (this.writeBlocked) throw failure('projection_future_version');
    if (this.recoveryRequired) throw failure('projection_rebuild_required');
    const checked = validatePage('events_page', page, { mode: 'read' });
    if (!checked.valid) throw failure(checked.errors.some(({ code }) => code.startsWith('schema_'))
      ? 'invalid_contract' : 'projection_invalid_event');
    if (BigInt(page.latest_seq) < BigInt(this.lastSeq) || BigInt(page.next_seq) > BigInt(page.latest_seq)) throw failure('projection_invalid_sequence');
    let seq = BigInt(this.lastSeq);
    const contributions = [];
    for (const event of page.events) {
      if (BigInt(event.seq) !== seq + 1n) throw failure('projection_invalid_event');
      contributions.push(persistedContribution(event.attempt, this, event.seq));
      seq += 1n;
    }
    if (seq.toString() !== page.next_seq || page.has_more !== (BigInt(page.next_seq) < BigInt(page.latest_seq))) throw failure('projection_invalid_sequence');
    if (contributions.length === 0 && this.segments.length > 0) {
      const asOf = new Date(this.now()).toISOString();
      await atomicJson(this.checkpointPath(), { schemaVersion: FORMAT, calcVersion: CALC_VERSION,
        normalizerVersion: NORMALIZER_VERSION, pricingVersion: this.pricingVersion, lastSeq: this.lastSeq,
        latestSeq: page.latest_seq, asOf, segments: this.segments }, { directorySync: this.directorySync });
      this.latestSeq = page.latest_seq;
      this.asOf = asOf;
      return;
    }
    const staged = this.stage(contributions);
    const data = { schemaVersion: FORMAT, fromSeq: this.lastSeq, toSeq: page.next_seq, contributions };
    const segmentBytes = `${JSON.stringify(data)}\n`, segmentHash = hash(segmentBytes);
    const file = `segment-${this.lastSeq}-${page.next_seq}-${segmentHash}.json`;
    const segment = { file, sha256: segmentHash, fromSeq: this.lastSeq, toSeq: page.next_seq, count: contributions.length,
      minStartedAt: staged.range.min, maxStartedAt: staged.range.max };
    const segments = [...this.segments, segment];
    const asOf = new Date(this.now()).toISOString();
    await mkdir(this.generationPath(), { recursive: true, mode: 0o700 });
    await atomicBytes(path.join(this.generationPath(), file), segmentBytes, { syncParent: false, directorySync: this.directorySync });
    await atomicJson(this.checkpointPath(), { schemaVersion: FORMAT, calcVersion: CALC_VERSION,
      normalizerVersion: NORMALIZER_VERSION, pricingVersion: this.pricingVersion, lastSeq: page.next_seq,
      latestSeq: page.latest_seq, asOf, segments }, { syncParent: false, directorySync: this.directorySync });
    await this.directorySync(this.generationPath());
    if (this.segments.length === 0) {
      await atomicJson(path.join(this.directory, 'current.json'), { schemaVersion: FORMAT, generation: this.generation },
        { directorySync: this.directorySync });
    }
    this.install(staged);
    this.segments = segments;
    this.lastSeq = page.next_seq;
    this.latestSeq = page.latest_seq;
    this.asOf = asOf;
  }

  detail(attempt) { return projectAttempt(attempt, this); }

  // Start time (ms) of the newest probe of this channel, or null when it has none.
  latestProbeMs(channelId) { return this.probeTail.get(channelId)?.at(-1)?.ms ?? null; }

  // The terminal probe attempt with this id, or null while it has not reached a terminal state yet.
  probeResult(channelId, attemptId) {
    const row = (this.probeTail.get(channelId) ?? []).find((entry) => entry.attemptId === attemptId)
      ?? (this.probesByChannel.get(channelId) ?? []).find((entry) => entry.attemptId === attemptId);
    return row ? probeShape(row) : null;
  }

  recentProbes({ channelId, from, to }) {
    const shape = probeShape;
    const lowerBound = (list, time) => {
      let low = 0, high = list.length;
      while (low < high) { const middle = (low + high) >>> 1; if (compareUtc(list[middle].startedAt, time) < 0) low = middle + 1; else high = middle; }
      return low;
    };
    // Up to now: the newest probes of the channel are always at hand, whatever their age.
    const tail = this.probeTail.get(channelId) ?? [];
    if (!tail.length) return [];
    if (compareUtc(tail.at(-1).startedAt, to) < 0) return tail.slice(lowerBound(tail, from)).slice(-PROBE_LIMIT).map(shape);
    const probes = this.probesByChannel.get(channelId) ?? [];
    const memory = probes.slice(lowerBound(probes, from), lowerBound(probes, to));
    const cutoff = this.retentionCutoff(), need = PROBE_LIMIT - memory.length;
    if (need <= 0 || Date.parse(from) >= cutoff) return memory.slice(-PROBE_LIMIT).map(shape);
    // The window reaches back past the retained rows and memory alone has fewer than the limit: read the older probes from disk,
    // newest segment first, and stop once the segments left cannot hold anything newer than what is already collected.
    const fromMs = Date.parse(from), toMs = Date.parse(to);
    const segments = this.segments.filter((segment) => segment.minStartedAt !== null && Date.parse(segment.maxStartedAt) >= fromMs
      && Date.parse(segment.minStartedAt) <= toMs).sort((left, right) => Date.parse(right.maxStartedAt) - Date.parse(left.maxStartedAt));
    let older = [];
    for (const segment of segments) {
      if (older.length >= need && Date.parse(segment.maxStartedAt) < older[older.length - need].ms) break;
      for (const row of this.readSegmentRows(segment)) {
        if (row.kind !== 'probe' || row.channelId !== channelId) continue;
        const kept = slimRow(row);
        if (kept.ms < cutoff && compareUtc(kept.startedAt, from) >= 0 && compareUtc(kept.startedAt, to) < 0) older.push(kept);
      }
      older.sort(probeOrder);
    }
    return [...older.slice(-need), ...memory].map(shape);
  }

  overview({ from, to, ...filter }) {
    const summaries = this.summaries({ from, to, ...filter });
    return this.summarize(summaries, { from, to });
  }

  // Combined buckets of [from, to). Whole Shanghai days come from the day totals; the partial days at the two ends are added up from
  // the attempts themselves, which are in memory for the retention window and read from the segments (and dropped again) before it.
  // `scope` keeps the days read from disk for the duration of one query.
  summaries({ from, to, ...filter }, scope = new Map()) {
    const fromNs = utcNs(from), toNs = utcNs(to);
    if (compareUtc(from, to) >= 0) throw failure('projection_invalid_interval');
    const range = { fromMs: Date.parse(from), toMs: Date.parse(to), fromNs, toNs };
    const combined = new Map(), edge = new Map();
    const merge = (summary, key = summary.meta.key ?? JSON.stringify(summary.meta)) => {
      if (!matches(summary.meta, filter)) return;
      if (!combined.has(key)) combined.set(key, { ...cloneSummary(summary), compensation: 0 });
      else addSummary(combined.get(key), summary);
    };
    for (const [day, buckets] of this.days) {
      const startMs = Date.parse(`${day}T00:00:00Z`) - SHANGHAI_OFFSET_MS, endMs = startMs + DAY_MS;
      const startNs = BigInt(startMs) * 1_000_000n, endNs = BigInt(endMs) * 1_000_000n;
      if (endNs <= fromNs || startNs >= toNs) continue;
      if (startNs >= fromNs && endNs <= toNs) {
        for (const summary of this.pricedDay(day, startMs, filter, scope)) merge(summary);
        continue;
      }
      const firstHour = Math.floor(Math.max(startMs, range.fromMs) / HOUR_MS), lastHour = Math.floor(Math.min(endMs - 1, range.toMs) / HOUR_MS);
      for (let hour = firstHour; hour <= lastHour; hour += 1) {
        for (const row of this.rowsOfHour(hour, scope)) {
          if (!matches(row.meta, filter) || !inRange(row, range)) continue;
          if (!edge.has(row.meta.key)) edge.set(row.meta.key, { ...emptySummary(row.meta), procurement: emptyProcurement() });
          const summary = edge.get(row.meta.key);
          addRow(summary, row);
          addProcurement(summary.procurement, ruleAt(this.costStore, { channelId: row.meta.channelId, model: row.meta.modelId }, row.ms / 1000),
            row.priceStatus, row.officialCost);
        }
      }
    }
    for (const [key, summary] of edge) merge(summary, key);
    return [...combined.values()];
  }

  // Attempts, known procurement cost per currency and cost coverage of the succeeded attempts, for the same filter summaries() takes.
  // Procurement cost is the official price times the multiplier that was in effect when each attempt was made.
  requestTotals(query) {
    const costs = new Map();
    const coverage = { complete: 0, partial: 0, unknown: 0 };
    let requests = 0;
    for (const summary of this.summaries(query)) {
      requests += summary.attempts;
      const { procurement } = summary;
      if (summary.meta.requestOutcome === 'succeeded') {
        for (const key of ['complete', 'partial', 'unknown']) coverage[key] += procurement.coverage[key];
        coverage.unknown += procurement.unpriced;
      }
      if (summary.meta.currency === null || procurement.coverage.complete + procurement.coverage.partial === 0) continue;
      if (!costs.has(summary.meta.currency)) costs.set(summary.meta.currency, { currency: summary.meta.currency, amount: 0, compensation: 0 });
      const entry = costs.get(summary.meta.currency);
      const adjusted = procurement.cost - entry.compensation, next = entry.amount + adjusted;
      if (!Number.isFinite(next)) throw failure('projection_cost_overflow');
      entry.compensation = (next - entry.amount) - adjusted;
      entry.amount = next;
    }
    return { requests, costs: [...costs.values()].map(({ currency, amount }) => ({ currency, amount })), coverage };
  }

  // Group the already combined buckets; never re-read attempt history for a chart.
  breakdown(query, keys, summaries = this.summaries(query), state = this.state()) {
    if (!Array.isArray(keys) || keys.some((key) => !['source', 'channelId', 'poolId', 'modelId', 'kind'].includes(key))) {
      throw failure('projection_invalid_group');
    }
    const groups = new Map();
    for (const summary of summaries) {
      // A plain joined key: the grouped values are ids or null, so no text is built per summary beyond this.
      let key = '';
      for (const name of keys) key += `${summary.meta[name] ?? '\u0001'}\u0000`;
      let group = groups.get(key);
      if (!group) { group = { identity: Object.fromEntries(keys.map((name) => [name, summary.meta[name]])), summaries: [] }; groups.set(key, group); }
      group.summaries.push(summary);
    }
    return [...groups.values()].map(({ identity, summaries }) => ({ ...identity, ...this.summarize(summaries, query, state) }));
  }

  timeline(query, bucketMs, keys = [], { state = this.state(), includeTotal = false } = {}) {
    return this.readWindow(query, bucketMs, keys, { state, includeTotal, collectSummaries: false }).timeline;
  }

  // `timelineFilter` narrows only the timeline rows (e.g. { kind: 'model' } keeps probes out of the trend); the summaries
  // returned for totals are always the unfiltered window.
  readWindow(query, bucketMs, keys = [], { state = this.state(), includeTotal = false, collectSummaries = true, timelineFilter = null } = {}) {
    if (![3_600_000, DAY_MS].includes(bucketMs)) throw failure('projection_invalid_bucket');
    const fromMs = Date.parse(query.from), toMs = Date.parse(query.to);
    const offset = bucketMs === DAY_MS ? 28_800_000 : 0;
    const rows = [], combined = new Map(), scope = new Map();
    for (let at = Math.floor((fromMs + offset) / bucketMs) * bucketMs - offset; at < toMs; at += bucketMs) {
      const period = { ...query, from: new Date(Math.max(at, fromMs)).toISOString(),
        to: new Date(Math.min(at + bucketMs, toMs)).toISOString() };
      const { from, to, ...filter } = period;
      const completeDay = bucketMs === DAY_MS && Date.parse(from) === at && Date.parse(to) === at + DAY_MS;
      // A full Shanghai day is already one immutable read-side bucket set; its priced copies share the stored arrays.
      // Consumers below only read them; combined window summaries remain copies.
      const summaries = completeDay ? this.pricedDay(shanghaiDay(at), at, filter, scope) : this.summaries(period, scope);
      // Totals and charts share this read; no second scan of partial-day minutes.
      if (collectSummaries) for (const summary of summaries) {
        const key = summary.meta.key ?? JSON.stringify(summary.meta);
        if (!combined.has(key)) combined.set(key, { ...cloneSummary(summary), compensation: 0 });
        else addSummary(combined.get(key), summary);
      }
      const charted = timelineFilter ? summaries.filter((summary) => matches(summary.meta, timelineFilter)) : summaries;
      const results = this.breakdown(period, keys, charted, state);
      if (includeTotal && keys.length) results.push(this.summarize(charted, period, state));
      for (const result of results) {
        if (result.attempts > 0) rows.push({ time: new Date(at).toISOString(), ...result });
      }
    }
    return { timeline: rows, summaries: [...combined.values()] };
  }

  summarize(summaries, { from, to }, state = this.state()) {
    const total = emptySummary();
    const currencies = new Map();
    const procurementCoverage = { complete: 0, partial: 0, unknown: 0 };
    let requestsSucceeded = 0, probes = 0, probesSucceeded = 0, cooldowns = 0;
    for (const summary of summaries) {
      addSummary(total, summary);
      if (summary.meta.kind === 'probe') { probes += summary.attempts; if (summary.meta.requestOutcome === 'succeeded') probesSucceeded += summary.attempts; }
      else if (summary.meta.requestOutcome === 'succeeded') requestsSucceeded += summary.attempts;
      if (summary.meta.kind !== 'probe' && summary.meta.cooldown) cooldowns += summary.attempts;
      const procurement = summary.procurement ?? this.spanProcurement(summary, { from, to });
      for (const key of ['complete', 'partial', 'unknown']) procurementCoverage[key] += procurement.coverage[key];
      procurementCoverage.unknown += procurement.unpriced;
      if (summary.meta.currency === null) continue;
      if (!currencies.has(summary.meta.currency)) currencies.set(summary.meta.currency, { currency: summary.meta.currency,
        officialCost: 0, compensation: 0, procurementCost: 0, procurementCompensation: 0, procurementUnknown: 0, ruleVersions: new Set() });
      const currency = currencies.get(summary.meta.currency);
      moneyAdd(currency, summary.officialCost);
      currency.procurementUnknown += procurement.unpriced;
      const adjusted = procurement.cost - currency.procurementCompensation;
      const next = currency.procurementCost + adjusted;
      if (!Number.isFinite(next)) throw failure('projection_cost_overflow');
      currency.procurementCompensation = (next - currency.procurementCost) - adjusted;
      currency.procurementCost = next;
      for (const rule of procurement.rules) currency.ruleVersions.add(rule);
    }
    return { ...state, from, to, snapshotSeq: this.lastSeq, attempts: total.attempts,
      requests: total.attempts - probes, requestsSucceeded, probes, probesSucceeded, cooldowns,
      durationMs: total.durationMs, durationCount: total.durationCount, ttftMs: total.ttftMs, ttftCount: total.ttftCount,
      totals: Object.fromEntries(TOKEN_KEYS.map((key, index) => [key, total.tokens[index]])),
      coverage: Object.fromEntries(TOKEN_KEYS.map((key, index) => [key, { absent: total.fieldCoverage[index * 4],
        known: total.fieldCoverage[index * 4 + 1], estimated: total.fieldCoverage[index * 4 + 2], partial: total.fieldCoverage[index * 4 + 3] }])),
      costCoverage: total.costCoverage, procurementCoverage, cacheKnownInput: total.cacheInput, cacheKnownRead: total.cacheRead,
      cacheKnownRequests: total.cacheCount, cacheHitRate: total.cacheInput > 0 ? total.cacheRead / total.cacheInput : null,
      currencies: [...currencies.values()].map(({ compensation, procurementCompensation, ruleVersions, ...currency }) => ({ ...currency, ruleVersions: [...ruleVersions] })) };
  }

  rebuild() {
    if (this.rebuildPending) return this.rebuildPending;
    const run = async () => {
      if (this.pending) await this.pending.catch(() => {});
      await this.load();
      if (this.writeBlocked) throw failure('projection_future_version');
      const replacement = new GatewayProjection({ directory: this.directory, client: this.client,
        priceStore: this.priceStore, costStore: this.costStore, modelVendor: this.modelVendor, rowRetentionDays: this.rowRetentionDays,
        now: this.now, directorySync: this.directorySync });
      replacement.loaded = true;
      // Publish the generation only after the complete replacement has caught up.
      replacement.commitPage = async (page) => {
        const originalDirectory = replacement.directory;
        replacement.directory = path.join(this.directory, '.rebuild', replacement.generation);
        try { await GatewayProjection.prototype.commitPage.call(replacement, page); }
        finally { replacement.directory = originalDirectory; }
      };
      await replacement.catchUp();
      const stagingDirectory = path.join(this.directory, '.rebuild', replacement.generation);
      await rename(path.join(stagingDirectory, replacement.generation), path.join(this.directory, replacement.generation));
      await this.directorySync(this.directory);
      // Another binary may have published a future format while this background
      // rebuild was running. Never replace its pointer, even after staging data.
      try {
        const pointer = JSON.parse(await readFile(path.join(this.directory, 'current.json'), 'utf8'));
        if (futureVersion(pointer.schemaVersion, FORMAT)) throw failure('projection_future_version');
        if (/^[a-f0-9-]{36}$/.test(pointer.generation)) {
          const checkpoint = JSON.parse(await readFile(path.join(this.directory, pointer.generation, 'checkpoint.json'), 'utf8'));
          if (futureVersion(checkpoint.schemaVersion, FORMAT) || futureVersion(checkpoint.calcVersion, CALC_VERSION)
            || futureVersion(checkpoint.normalizerVersion, NORMALIZER_VERSION)) throw failure('projection_future_version');
        }
      } catch (error) {
        if (error.code === 'projection_future_version') { this.writeBlocked = true; throw error; }
        if (!(error instanceof SyntaxError) && error.code !== 'ENOENT') throw error;
      }
      await atomicJson(path.join(this.directory, 'current.json'), { schemaVersion: FORMAT, generation: replacement.generation },
        { directorySync: this.directorySync });
      for (const key of projectionDataKeys) this[key] = replacement[key];
      this.loaded = true;
      this.recoveryRequired = false;
      this.lastError = null;
      return this.state();
    };
    this.rebuildPending = run().catch((error) => { this.lastError = error.code ?? 'projection_rebuild_failed'; throw failure(this.lastError); })
      .finally(() => { this.rebuildPending = null; });
    return this.rebuildPending;
  }
}
