import { createHash, randomUUID } from 'node:crypto';
import { chmod, mkdir, open, readFile, rename, stat, unlink } from 'node:fs/promises';
import path from 'node:path';
import { normalizeChannelId } from '../channel-id.js';
import { shanghaiDay, shanghaiDayStart } from '../calendar-periods.js';

const FORMAT = 1;
const TRANSFORM = '2';
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const TEXT_MAX = 255;
const EFFORT_MAX = 64;
const MESSAGE_MAX = 500;
const ROUTE_MAX = 16;
const CONTROL = /[\x00-\x1f\x7f]/;
const COUNTERS = ['rawInput', 'output', 'cacheRead', 'cacheCreation', 'cacheWrite', 'cacheWrite5m', 'cacheWrite1h',
  'totalInput', 'inputUncached', 'cacheWriteTotal', 'cacheWriteUnknown', 'quota', 'durationMs', 'ttftMs'];
const digest = (value) => createHash('sha256').update(value).digest('hex');
const bytes = (value) => Buffer.from(`${JSON.stringify(value)}\n`);
const fail = (code) => { throw Object.assign(new Error('旧源候选导入失败'), { code }); };
const clone = (value) => structuredClone(value);
// Parsed JSON gives every row its own copy of each repeated string; stored rows share one instance per value instead.
const pool = new Map();
const share = (value) => {
  if (typeof value !== 'string') return value;
  const known = pool.get(value);
  if (known !== undefined) return known;
  pool.set(value, value);
  return value;
};
const EMPTY = Object.freeze([]);
const SHARED = ['transformVersion', 'source', 'sourceInstanceId', 'channelId', 'model', 'tokenName', 'group', 'channelName', 'reasoningEffort',
  'outcome', 'protocolOutcome', 'semantics', 'completeness', 'costReason'];
function compact(row) {
  for (const key of SHARED) row[key] = share(row[key]);
  if (!row.issues.length) row.issues = EMPTY;
  if (!row.routeChannelIds.length) row.routeChannelIds = EMPTY;
  return row;
}
// Stored rows keep no fingerprint (64 characters per row); one is computed only when a duplicate has to be compared.
const fingerprintOf = (entry) => entry.fingerprint ?? digest(bytes(entry.row));
const safe = (value) => {
  if (typeof value === 'string' && /^(0|[1-9][0-9]*)$/.test(value)) value = Number(value);
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
};
const sum = (values) => values.every((value) => value !== null) && Number.isSafeInteger(values.reduce((a, b) => a + b, 0))
  ? values.reduce((a, b) => a + b, 0) : null;

function instanceId(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(value)) fail('legacy_invalid_instance');
  return value;
}

function interval(from, to) {
  if (safe(from) !== from || safe(to) !== to || from >= to || to > 8_640_000_000_000) fail('legacy_invalid_interval');
}

function types(input) {
  if (!Array.isArray(input) || !input.length || input.some((type) => ![2, 5].includes(type)) || new Set(input).size !== input.length) fail('legacy_invalid_type');
  return [...input].sort();
}

function parseOther(input) {
  if (typeof input === 'string') {
    if (Buffer.byteLength(input) > MAX_FILE_BYTES) fail('legacy_invalid_row');
    try { input = JSON.parse(input); } catch { return {}; }
  }
  return input && typeof input === 'object' && !Array.isArray(input) ? input : {};
}

// Display text from the old log: control characters become spaces, the length is capped. Anything that is not text is empty.
const text = (value, max) => typeof value === 'string' ? value.replace(/[\x00-\x1f\x7f]/g, ' ').trim().slice(0, max) : '';

// Same rule as the old console (analytics.js normalizeLog): only a present key counts; the value is stringified, trimmed and lower-cased.
// A value that cannot be stored as a short plain label is treated as absent.
function reasoningEffort(other) {
  if (!Object.hasOwn(other, 'reasoning_effort')) return null;
  const value = String(other.reasoning_effort || '').trim().toLowerCase();
  return value && value.length <= EFFORT_MAX && !CONTROL.test(value) ? value : null;
}

// The channels the request went through, from other.admin_info.use_channel (old console: usedChannelIds).
// Without it the old console used the final channel alone; that case is left to the caller (empty list here).
function routeChannelIds(other) {
  const list = parseOther(other.admin_info).use_channel;
  if (!Array.isArray(list)) return [];
  const ids = [];
  for (const item of list) {
    const id = Number(item);
    if (Number.isSafeInteger(id) && id > 0) ids.push(String(id));
    if (ids.length >= ROUTE_MAX) break;
  }
  return ids;
}

// Old console parseStatusCode / cleanErrorMessage for failed (type 5) rows. Only these two derived values are kept, never the raw content.
function failure(content) {
  const value = typeof content === 'string' ? content.slice(0, 4000) : '';
  const explicit = value.match(/status[_\s-]*code\s*[:=]\s*([1-5]\d{2})/i) ?? value.match(/\b([45]\d{2})\b/);
  const trimmed = value.trim();
  const message = trimmed.replace(/^status[_\s-]*code\s*[:=]\s*[1-5]\d{2}\s*[,;:]?\s*/i, '').trim() || trimmed;
  return { statusCode: explicit ? Number(explicit[1]) : null, errorMessage: text(message, MESSAGE_MAX) };
}

export function normalizeLegacyRow(input, { sourceInstanceId, type }) {
  instanceId(sourceInstanceId);
  if (![2, 5].includes(type) || !input || typeof input !== 'object' || Array.isArray(input)) fail('legacy_invalid_row');
  const id = typeof input.id === 'number' && Number.isSafeInteger(input.id) && input.id > 0 ? String(input.id) : input.id;
  const at = safe(input.created_at);
  if (typeof id !== 'string' || !/^[1-9][0-9]{0,39}$/.test(id) || at === null || at > 8_640_000_000_000
    || (input.type !== undefined && input.type !== type)) fail('legacy_invalid_row');
  const other = parseOther(input.other);
  const issues = new Set();
  const count = (value) => {
    const result = safe(value);
    if (result === null && value !== undefined && value !== null && value !== '') issues.add('counter_invalid');
    return result;
  };
  const counters = {
    rawInput: count(input.prompt_tokens), output: count(input.completion_tokens), cacheRead: count(other.cache_tokens),
    cacheCreation: count(other.cache_creation_tokens), cacheWrite: count(other.cache_write_tokens),
    cacheWrite5m: count(other.cache_creation_tokens_5m), cacheWrite1h: count(other.cache_creation_tokens_1h),
    totalInput: null, inputUncached: null, cacheWriteTotal: null, cacheWriteUnknown: null,
    quota: count(input.quota), durationMs: null, ttftMs: count(other.frt),
  };
  const seconds = count(input.use_time);
  if (seconds !== null) counters.durationMs = Number.isSafeInteger(seconds * 1000) ? seconds * 1000 : null;
  if (counters.cacheWrite !== null && counters.cacheCreation !== null && counters.cacheWrite !== counters.cacheCreation) {
    issues.add('cache_write_conflict');
  } else counters.cacheWriteTotal = counters.cacheWrite ?? counters.cacheCreation;
  const parts = sum([counters.cacheWrite5m, counters.cacheWrite1h]);
  if (counters.cacheWriteTotal === null && parts !== null && !issues.has('cache_write_conflict')) counters.cacheWriteTotal = parts;
  if (counters.cacheWriteTotal !== null) {
    const known = (counters.cacheWrite5m ?? 0) + (counters.cacheWrite1h ?? 0);
    if (Number.isSafeInteger(known) && known <= counters.cacheWriteTotal) counters.cacheWriteUnknown = counters.cacheWriteTotal - known;
    else issues.add('cache_write_breakdown_invalid');
  }
  const semantics = ['openai', 'anthropic'].includes(other.usage_semantic) ? other.usage_semantic : 'unknown';
  if (semantics === 'openai') {
    counters.totalInput = counters.rawInput;
    if ([counters.rawInput, counters.cacheRead, counters.cacheWriteTotal].every((value) => value !== null)) {
      const uncached = counters.rawInput - counters.cacheRead - counters.cacheWriteTotal;
      if (uncached >= 0) counters.inputUncached = uncached;
      else issues.add('cache_exceeds_input');
    }
  } else if (semantics === 'anthropic') {
    counters.inputUncached = counters.rawInput;
    counters.totalInput = sum([counters.rawInput, counters.cacheRead, counters.cacheWriteTotal]);
  } else issues.add('input_relation_unknown');
  let channelId = null;
  try { channelId = normalizeChannelId(input.channel ?? input.channel_id); } catch { issues.add('channel_unknown'); }
  const model = typeof input.model_name === 'string' && input.model_name.length > 0 && input.model_name.length <= 256
    && !/[\x00-\x1f\x7f]/.test(input.model_name) ? input.model_name : null;
  const streamStatus = other.stream_status && typeof other.stream_status === 'object' ? other.stream_status : {};
  const partial = type === 5 || (typeof streamStatus.status === 'string' && streamStatus.status !== 'ok')
    || (Array.isArray(streamStatus.errors) && streamStatus.errors.length > 0);
  const failed = type === 5 ? failure(input.content) : null;
  return { formatVersion: FORMAT, transformVersion: TRANSFORM, source: 'newapi', sourceInstanceId,
    sourceRowId: `${type}:${id}`, recordId: `newapi:${sourceInstanceId}:${type}:${id}`, type,
    createdAt: new Date(at * 1000).toISOString(), createdTimestamp: at, channelId, model,
    stream: typeof input.is_stream === 'boolean' ? input.is_stream : null,
    tokenName: text(input.token_name, TEXT_MAX), group: text(input.group, TEXT_MAX), channelName: text(input.channel_name, TEXT_MAX),
    reasoningEffort: type === 2 ? reasoningEffort(other) : null, routeChannelIds: type === 2 ? routeChannelIds(other) : [],
    statusCode: failed?.statusCode ?? null, errorMessage: failed?.errorMessage ?? null,
    outcome: type === 2 ? 'legacy_recorded' : 'legacy_error', protocolOutcome: 'unknown', semantics,
    completeness: partial ? 'partial' : 'unknown', counters, issues: [...issues].sort(),
    officialCost: null, procurementCost: null, billedCost: null, costReason: 'legacy_not_repriced' };
}

async function syncDirectory(directory) {
  if (process.platform === 'win32') return;
  const handle = await open(directory, 'r');
  try { await handle.sync(); } finally { await handle.close(); }
}

async function privateWrite(file, content, exclusive = true) {
  const handle = await open(file, exclusive ? 'wx' : 'w', 0o600);
  try { await handle.writeFile(content); await handle.sync(); } finally { await handle.close(); }
}

async function readJson(file) {
  if ((await stat(file)).size > MAX_FILE_BYTES) fail('legacy_invalid_store');
  try { return JSON.parse(await readFile(file, 'utf8')); } catch { fail('legacy_invalid_store'); }
}

function emptyBucket(identity) {
  return { ...identity, records: 0, legacyRecorded: 0, legacyErrors: 0, partial: 0,
    counters: Object.fromEntries(COUNTERS.map((key) => [key, { sum: 0, known: 0, unknown: 0 }])),
    costs: { officialKnown: 0, procurementKnown: 0, billedKnown: 0, unknown: 0 } };
}

function mergeBucket(target, incoming) {
  for (const key of ['records', 'legacyRecorded', 'legacyErrors', 'partial']) target[key] += incoming[key];
  for (const key of COUNTERS) for (const field of ['sum', 'known', 'unknown']) {
    const value = target.counters[key][field] + incoming.counters[key][field];
    if (!Number.isSafeInteger(value)) fail('legacy_counter_overflow');
    target.counters[key][field] = value;
  }
  for (const key of Object.keys(target.costs)) target.costs[key] += incoming.costs[key];
  return target;
}

function rowBucket(row) {
  const bucket = emptyBucket({ day: shanghaiDay(row.createdTimestamp * 1000), channelId: row.channelId, model: row.model, type: row.type });
  bucket.records = 1;
  bucket.legacyRecorded = Number(row.type === 2);
  bucket.legacyErrors = Number(row.type === 5);
  bucket.partial = Number(row.completeness === 'partial');
  bucket.costs.unknown = 1;
  for (const key of COUNTERS) {
    const value = row.counters[key];
    bucket.counters[key] = { sum: value ?? 0, known: Number(value !== null), unknown: Number(value === null) };
  }
  return bucket;
}

const validText = (value, max) => typeof value === 'string' && value.length <= max && !CONTROL.test(value);

function validateStoredRow(row, sourceInstanceId) {
  const fields = ['formatVersion', 'transformVersion', 'source', 'sourceInstanceId', 'sourceRowId', 'recordId', 'type',
    'createdAt', 'createdTimestamp', 'channelId', 'model', 'stream', 'tokenName', 'group', 'channelName', 'reasoningEffort',
    'routeChannelIds', 'statusCode', 'errorMessage', 'outcome', 'protocolOutcome', 'semantics',
    'completeness', 'counters', 'issues', 'officialCost', 'procurementCost', 'billedCost', 'costReason'];
  const issues = ['counter_invalid', 'cache_write_conflict', 'cache_write_breakdown_invalid', 'cache_exceeds_input',
    'input_relation_unknown', 'channel_unknown'];
  if (!row || typeof row !== 'object' || Object.keys(row).length !== fields.length || Object.keys(row).some((key) => !fields.includes(key))
    || row.formatVersion !== FORMAT || row.transformVersion !== TRANSFORM || row.source !== 'newapi'
    || row.sourceInstanceId !== sourceInstanceId || ![2, 5].includes(row.type)
    || typeof row.sourceRowId !== 'string' || !new RegExp(`^${row.type}:[1-9][0-9]{0,39}$`).test(row.sourceRowId)
    || row.recordId !== `newapi:${sourceInstanceId}:${row.sourceRowId}` || typeof row.createdTimestamp !== 'number'
    || safe(row.createdTimestamp) !== row.createdTimestamp
    || row.createdTimestamp > 8_640_000_000_000 || new Date(row.createdTimestamp * 1000).toISOString() !== row.createdAt
    || row.outcome !== (row.type === 2 ? 'legacy_recorded' : 'legacy_error') || row.protocolOutcome !== 'unknown'
    || !['openai', 'anthropic', 'unknown'].includes(row.semantics) || !['partial', 'unknown'].includes(row.completeness)
    || !['tokenName', 'group', 'channelName'].every((key) => validText(row[key], TEXT_MAX))
    || !(row.reasoningEffort === null || (row.type === 2 && validText(row.reasoningEffort, EFFORT_MAX) && row.reasoningEffort))
    || !Array.isArray(row.routeChannelIds) || row.routeChannelIds.length > (row.type === 2 ? ROUTE_MAX : 0)
    || row.routeChannelIds.some((id) => typeof id !== 'string' || !/^[1-9][0-9]{0,15}$/.test(id))
    || !(row.type === 2 ? row.statusCode === null && row.errorMessage === null
      : (row.statusCode === null || (Number.isInteger(row.statusCode) && row.statusCode >= 100 && row.statusCode <= 599))
        && validText(row.errorMessage, MESSAGE_MAX))
    || (row.stream !== null && typeof row.stream !== 'boolean') || row.officialCost !== null || row.procurementCost !== null
    || row.billedCost !== null || row.costReason !== 'legacy_not_repriced' || !Array.isArray(row.issues)
    || row.issues.some((value) => !issues.includes(value)) || !row.counters || Object.keys(row.counters).length !== COUNTERS.length
    || Object.keys(row.counters).some((key) => !COUNTERS.includes(key))
    || Object.values(row.counters).some((value) => value !== null && (typeof value !== 'number' || safe(value) !== value))
    || (row.model !== null && (typeof row.model !== 'string' || !row.model || row.model.length > 256 || /[\x00-\x1f\x7f]/.test(row.model)))) fail('legacy_invalid_store');
  if (row.channelId !== null) {
    try { normalizeChannelId(row.channelId); } catch { fail('legacy_invalid_store'); }
  }
}

export class LegacyImport {
  constructor({ directory, sourceInstanceId, client = null, pageSize = 100 }) {
    this.directory = path.resolve(directory);
    this.sourceInstanceId = instanceId(sourceInstanceId);
    this.client = client;
    if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 100) fail('legacy_invalid_page_size');
    this.pageSize = pageSize;
    this.checkpoint = { formatVersion: FORMAT, transformVersion: TRANSFORM, source: 'newapi', sourceInstanceId,
      pageSize, head: null, windows: {} };
    this.rows = new Map();
    this.days = new Map();
    this.dayStarts = new Map();
    this.dayIndex = null;
    this.loaded = false;
    this.pending = Promise.resolve();
  }

  planRows(rows) {
    const additions = new Map(), buckets = new Map();
    for (const row of rows) {
      validateStoredRow(row, this.sourceInstanceId);
      const fingerprint = digest(bytes(row));
      const previous = this.rows.get(row.recordId) ?? additions.get(row.recordId);
      if (previous) {
        if (fingerprintOf(previous) !== fingerprint) fail('legacy_row_conflict');
        continue;
      }
      additions.set(row.recordId, { row, fingerprint });
      const bucket = rowBucket(row), identity = JSON.stringify([bucket.day, bucket.channelId, bucket.model, bucket.type]);
      if (!buckets.has(identity)) buckets.set(identity, this.days.has(identity) ? clone(this.days.get(identity))
        : emptyBucket({ day: bucket.day, channelId: bucket.channelId, model: bucket.model, type: bucket.type }));
      mergeBucket(buckets.get(identity), bucket);
    }
    return { additions, buckets };
  }

  applyRows({ additions, buckets }) {
    for (const [id, { row }] of additions) this.rows.set(id, { row: compact(row) });
    for (const [id, bucket] of buckets) this.days.set(id, bucket);
    this.dayIndex = null;
  }

  // The buckets grouped by Shanghai day, rebuilt after an import changed them: a read looks at a few dozen days, not every bucket.
  bucketsByDay() {
    if (this.dayIndex) return this.dayIndex;
    const index = new Map();
    for (const bucket of this.days.values()) {
      if (!index.has(bucket.day)) index.set(bucket.day, []);
      index.get(bucket.day).push(bucket);
    }
    this.dayIndex = index;
    return index;
  }

  addRows(rows) {
    this.applyRows(this.planRows(rows));
  }

  async load() {
    if (this.loaded) return this.report();
    let checkpoint;
    try { checkpoint = await readJson(path.join(this.directory, 'checkpoint.json')); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (checkpoint) {
      if (checkpoint.formatVersion !== FORMAT || checkpoint.transformVersion !== TRANSFORM || checkpoint.source !== 'newapi'
        || checkpoint.sourceInstanceId !== this.sourceInstanceId || checkpoint.pageSize !== this.pageSize
        || !checkpoint.windows || typeof checkpoint.windows !== 'object' || Array.isArray(checkpoint.windows)) fail('legacy_invalid_store');
      for (const [key, window] of Object.entries(checkpoint.windows)) {
        if (!window || Object.keys(window).length !== 3 || Object.keys(window).some((name) => !['from', 'to', 'types'].includes(name))
          || key !== `${window.from}:${window.to}` || !window.types || typeof window.types !== 'object' || Array.isArray(window.types)) fail('legacy_invalid_store');
        try { interval(window.from, window.to); } catch { fail('legacy_invalid_store'); }
        for (const [type, progress] of Object.entries(window.types)) {
          if (!['2', '5'].includes(type) || !progress || !Number.isSafeInteger(progress.nextPage) || progress.nextPage < 1
            || Object.keys(progress).some((name) => !['nextPage', 'total', 'received', 'stableTotal', 'complete', 'paginationFinished', 'uniqueRecords'].includes(name))
            || safe(progress.received) !== progress.received || (progress.total !== null && safe(progress.total) !== progress.total)
            || typeof progress.stableTotal !== 'boolean' || typeof progress.complete !== 'boolean'
            || (progress.complete && (!progress.stableTotal || progress.total === null || progress.uniqueRecords !== progress.total
              || progress.paginationFinished !== true))) fail('legacy_invalid_store');
        }
      }
      // The chain is walked twice: first only to validate it and collect the hashes, then oldest first to add the rows.
      // That keeps one parsed segment in memory at a time instead of the whole history.
      const readSegment = async (hash) => {
        const segment = await readJson(path.join(this.directory, `segment-${hash}.json`));
        if (digest(bytes(segment)) !== hash || segment.formatVersion !== FORMAT || segment.sourceInstanceId !== this.sourceInstanceId
          || !Array.isArray(segment.rows) || segment.rows.length > this.pageSize) fail('legacy_invalid_store');
        return segment;
      };
      const order = [], seen = new Set();
      let head = checkpoint.head;
      while (head !== null) {
        if (typeof head !== 'string' || !/^[a-f0-9]{64}$/.test(head) || seen.has(head)) fail('legacy_invalid_store');
        seen.add(head);
        order.push(head);
        head = (await readSegment(head)).previous;
      }
      for (const hash of order.reverse()) this.addRows((await readSegment(hash)).rows);
      this.checkpoint = checkpoint;
    }
    this.loaded = true;
    return this.report();
  }

  async commit(rows, windows) {
    const planned = this.planRows(rows);
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    await chmod(this.directory, 0o700).catch(() => {});
    const segment = { formatVersion: FORMAT, sourceInstanceId: this.sourceInstanceId, previous: this.checkpoint.head, rows };
    const content = bytes(segment), head = digest(content), segmentFile = path.join(this.directory, `segment-${head}.json`);
    if (content.length > MAX_FILE_BYTES) fail('legacy_page_too_large');
    try { await privateWrite(segmentFile, content); }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      if (!(await readFile(segmentFile)).equals(content)) fail('legacy_invalid_store');
    }
    await syncDirectory(this.directory);
    const checkpoint = { ...this.checkpoint, head, windows };
    const temporary = path.join(this.directory, `checkpoint-${randomUUID()}.pending.json`);
    try {
      await privateWrite(temporary, bytes(checkpoint));
      await rename(temporary, path.join(this.directory, 'checkpoint.json'));
      this.applyRows(planned);
      this.checkpoint = checkpoint;
      await syncDirectory(this.directory);
    } finally { await unlink(temporary).catch((error) => { if (error.code !== 'ENOENT') throw error; }); }
  }

  importRange(input) {
    const run = this.pending.then(() => this.importSerial(input));
    this.pending = run.catch(() => {});
    return run;
  }

  async importSerial({ from, to, logTypes = [2, 5], maxPages = 20 }) {
    interval(from, to);
    const selected = types(logTypes);
    if (!Number.isInteger(maxPages) || maxPages < 1 || maxPages > 10000) fail('legacy_invalid_page_limit');
    await this.load();
    if (!this.client?.requestLogPage) fail('legacy_client_required');
    const key = `${from}:${to}`, windows = clone(this.checkpoint.windows);
    const window = windows[key] ?? { from, to, types: {} };
    let pages = 0;
    for (const type of selected) {
      const progress = window.types[type] ?? { nextPage: 1, total: null, received: 0, stableTotal: true, complete: false };
      while (!progress.complete && !progress.paginationFinished && pages < maxPages) {
        const query = new URLSearchParams({ p: String(progress.nextPage), page_size: String(this.pageSize), type: String(type),
          start_timestamp: String(from), end_timestamp: String(to - 1) });
        let response;
        try { response = await this.client.requestLogPage(`/api/log/?${query}`, { priority: -10 }); }
        catch { fail('legacy_source_unavailable'); }
        if (!response || !Array.isArray(response.items) || response.items.length > this.pageSize) fail('legacy_invalid_page');
        const rows = response.items.map((row) => normalizeLegacyRow(row, { sourceInstanceId: this.sourceInstanceId, type }));
        if (rows.some((row) => row.createdTimestamp < from || row.createdTimestamp >= to)) fail('legacy_row_outside_interval');
        const pageRows = new Map();
        for (const row of rows) {
          const fingerprint = digest(bytes(row)), known = this.rows.get(row.recordId) ?? pageRows.get(row.recordId);
          if (known && fingerprintOf(known) !== fingerprint) fail('legacy_row_conflict');
          pageRows.set(row.recordId, { row, fingerprint });
        }
        const total = safe(response.total);
        if (progress.nextPage === 1) progress.total = total;
        else if (progress.total !== total) progress.stableTotal = false;
        progress.received += rows.length;
        progress.nextPage += 1;
        const finished = rows.length < this.pageSize || (total !== null && progress.received >= total);
        if (finished) {
          const existing = [...this.rows.values()].filter(({ row }) => row.type === type && row.createdTimestamp >= from && row.createdTimestamp < to).map(({ row }) => row.recordId);
          const knownCount = new Set([...existing, ...pageRows.keys()]).size;
          progress.complete = total !== null && progress.stableTotal && knownCount === total;
          progress.paginationFinished = true;
          progress.uniqueRecords = knownCount;
        }
        window.types[type] = progress;
        windows[key] = window;
        await this.commit([...pageRows.values()].filter(({ row }) => !this.rows.has(row.recordId)).map(({ row }) => row), clone(windows));
        pages += 1;
        if (finished) break;
      }
    }
    return { ...this.report(), pagesRead: pages, requestedWindow: { from, to, logTypes: selected,
      complete: selected.every((type) => window.types[type]?.complete === true) } };
  }

  // Read-only walk over the committed rows in [from, to). The row objects are shared with the store: callers must not modify them.
  forEachRow({ from, to, logTypes = [2, 5] }, visit) {
    interval(from, to);
    if (!this.loaded) fail('legacy_not_loaded');
    const selected = types(logTypes);
    for (const { row } of this.rows.values()) {
      if (selected.includes(row.type) && row.createdTimestamp >= from && row.createdTimestamp < to) visit(row);
    }
  }

  readBuckets({ from, to, logTypes = [2, 5] }) {
    interval(from, to);
    if (!this.loaded) fail('legacy_not_loaded');
    const selected = types(logTypes), buckets = new Map();
    const include = (bucket) => {
      const key = JSON.stringify([bucket.day, bucket.channelId, bucket.model, bucket.type]);
      if (!buckets.has(key)) buckets.set(key, emptyBucket({ day: bucket.day, channelId: bucket.channelId, model: bucket.model, type: bucket.type }));
      mergeBucket(buckets.get(key), bucket);
    };
    const wholeDays = new Set();
    for (const [day, dayBuckets] of this.bucketsByDay()) {
      let start = this.dayStarts.get(day);
      if (start === undefined) {
        start = shanghaiDayStart(Date.parse(`${day}T12:00:00Z`)) / 1000;
        this.dayStarts.set(day, start);
      }
      if (start < from || start + 86400 > to) continue;
      for (const bucket of dayBuckets) {
        if (!selected.includes(bucket.type)) continue;
        include(bucket);
        wholeDays.add(day);
      }
    }
    // Every Shanghai day inside [wholeFrom, wholeTo) lies completely in the window, so its rows are already counted through the
    // day buckets above and need no per-row day lookup. Only the partial days at the two edges are read row by row.
    let wholeFrom = shanghaiDayStart(from * 1000) / 1000;
    if (wholeFrom < from) wholeFrom += 86400;
    const wholeTo = shanghaiDayStart(to * 1000) / 1000;
    for (const { row } of this.rows.values()) {
      const at = row.createdTimestamp;
      if (at < from || at >= to || (at >= wholeFrom && at < wholeTo) || !selected.includes(row.type)) continue;
      if (!wholeDays.has(shanghaiDay(at * 1000))) include(rowBucket(row));
    }
    return { source: 'newapi', sourceInstanceId: this.sourceInstanceId, from, to,
      sourceCoverage: this.coverage(from, to, selected), buckets: [...buckets.values()].sort((a, b) =>
        a.day.localeCompare(b.day) || String(a.channelId).localeCompare(String(b.channelId)) || String(a.model).localeCompare(String(b.model)) || a.type - b.type) };
  }

  coverage(from, to, selected) {
    const result = {};
    for (const type of selected) {
      const ranges = Object.values(this.checkpoint.windows).filter((window) => window.types[type]?.complete)
        .map((window) => [Math.max(from, window.from), Math.min(to, window.to)]).filter(([start, end]) => start < end).sort((a, b) => a[0] - b[0]);
      let cursor = from;
      for (const [start, end] of ranges) { if (start > cursor) break; cursor = Math.max(cursor, end); }
      result[type] = { complete: cursor >= to, coveredThrough: cursor, snapshotConsistency: 'not_proven' };
    }
    return { source: 'newapi', sourceInstanceId: this.sourceInstanceId, types: result,
      complete: selected.every((type) => result[type].complete), migrationComplete: false };
  }

  report() {
    const all = emptyBucket({});
    for (const bucket of this.days.values()) mergeBucket(all, bucket);
    return { formatVersion: FORMAT, transformVersion: TRANSFORM, source: 'newapi', sourceInstanceId: this.sourceInstanceId,
      ...all, windows: clone(this.checkpoint.windows), migrationComplete: false, snapshotConsistency: 'not_proven' };
  }
}

export { COUNTERS as LEGACY_COUNTERS };
