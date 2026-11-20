import { shanghaiDay } from '../calendar-periods.js';
import { channelTypeInfo } from '../channel-types.js';
import { priceUsage, resolveOfficialPrice } from '../model-pricing.js';
import { LegacyImport } from './legacy-import.js';
import { ruleAt } from '../cost-store.js';
import { TOKEN_KEYS, addProcurement, emptyProcurement, externalSummary, unpricedProcurement } from './projection.js';

// The cost rule target of an old-history row (or bucket): its channel id as text, null when the log had none.
const ruleTarget = (channelId, model) => ({ channelId: channelId === null ? null : String(channelId), model });

const LEGACY_TYPES = [2, 5];
const PAGE_SIZE = 100;
const MAX_PAGES = 20;
const BACKOFF_MS = 60_000;
const DEFAULT_PAGE_INTERVAL_MS = 1000;
const HOUR_MS = 3_600_000;
const SHANGHAI_OFFSET_MS = 28_800_000;
const DEFAULT_READ_CACHE = 0;
const STATUS = ['', 'unknown', 'partial', 'complete'];
const REQUIRED = ['MOTAI_LEGACY_NEWAPI_ADMIN_TOKEN', 'MOTAI_LEGACY_SOURCE_INSTANCE_ID', 'MOTAI_LEGACY_DIR',
  'MOTAI_LEGACY_FROM', 'MOTAI_LEGACY_TO'];
const iso = (seconds) => new Date(seconds * 1000).toISOString();
// Only a short identifier is exposed; messages may carry paths or upstream text.
const codeOf = (error) => typeof error?.code === 'string' && /^[A-Za-z0-9_]{1,64}$/.test(error.code) ? error.code : 'legacy_failed';

// Returns null unless MOTAI_LEGACY_NEWAPI_BASE_URL is set; once set, every required value must be valid.
export function legacyConfigFromEnvironment(env = process.env) {
  const baseUrl = String(env.MOTAI_LEGACY_NEWAPI_BASE_URL ?? '').trim();
  if (!baseUrl) return null;
  const missing = REQUIRED.filter((name) => !String(env[name] ?? '').trim());
  if (missing.length) throw new TypeError(`Legacy import requires ${missing.join(', ')}`);
  const integer = (name, fallback = null) => {
    const raw = String(env[name] ?? '').trim();
    if (!raw && fallback !== null) return fallback;
    if (!/^(0|[1-9][0-9]{0,15})$/.test(raw)) throw new TypeError(`${name} must be a non-negative integer`);
    return Number(raw);
  };
  const from = integer('MOTAI_LEGACY_FROM'), to = integer('MOTAI_LEGACY_TO');
  if (from >= to || to > 8_640_000_000_000) throw new TypeError('MOTAI_LEGACY_FROM must be earlier than MOTAI_LEGACY_TO');
  return { baseUrl, adminToken: String(env.MOTAI_LEGACY_NEWAPI_ADMIN_TOKEN).trim(),
    sourceInstanceId: String(env.MOTAI_LEGACY_SOURCE_INSTANCE_ID).trim(), directory: String(env.MOTAI_LEGACY_DIR).trim(),
    from, to, pageIntervalMs: integer('MOTAI_LEGACY_PAGE_INTERVAL_MS', DEFAULT_PAGE_INTERVAL_MS) };
}

// Background import of [from, to). Resumes from the importer checkpoint, so restarts and a larger `to` only fetch what is missing.
export class LegacyBackfill {
  constructor({ directory, sourceInstanceId, client, from, to, backoffMs = BACKOFF_MS }) {
    this.stopping = false;
    this.from = from; this.to = to; this.backoffMs = backoffMs;
    this.lastError = null; this.running = null; this.wake = null;
    // The gate lets the page already in flight finish and commit, and refuses the next one.
    const gated = { requestLogPage: (...args) => this.stopping
      ? Promise.reject(Object.assign(new Error('stopped'), { code: 'legacy_stopped' })) : client.requestLogPage(...args) };
    this.importer = new LegacyImport({ directory, sourceInstanceId, client: gated, pageSize: PAGE_SIZE });
  }

  load() { return this.importer.load(); }

  coveredThrough() {
    const { types } = this.importer.coverage(this.from, this.to, LEGACY_TYPES);
    return Math.min(...LEGACY_TYPES.map((type) => types[type].coveredThrough));
  }

  complete() { return this.coveredThrough() >= this.to; }

  status() {
    const through = Math.min(this.to, Math.max(this.from, this.coveredThrough()));
    return { enabled: true, from: this.from, to: this.to, coveredSeconds: through - this.from,
      complete: through >= this.to, lastError: this.lastError };
  }

  // One batch per incomplete type, starting at that type's proven coverage.
  async cycle() {
    const { types } = this.importer.coverage(this.from, this.to, LEGACY_TYPES);
    for (const type of LEGACY_TYPES) {
      if (this.stopping || types[type].complete) continue;
      const result = await this.importer.importRange({ from: types[type].coveredThrough, to: this.to, logTypes: [type], maxPages: MAX_PAGES });
      // A finished window that cannot be proven complete needs an operator; do not spin on it.
      if (result.pagesRead === 0 && !result.requestedWindow.complete) {
        throw Object.assign(new Error('window unproven'), { code: 'legacy_window_unproven' });
      }
    }
  }

  sleep(ms) {
    return new Promise((resolve) => {
      const timer = setTimeout(() => { this.wake = null; resolve(); }, ms);
      this.wake = () => { clearTimeout(timer); this.wake = null; resolve(); };
    });
  }

  async run() {
    try { await this.load(); } catch (error) { this.lastError = codeOf(error); return; }
    while (!this.stopping && !this.complete()) {
      try {
        await this.cycle();
        if (!this.stopping) this.lastError = null;
      } catch (error) {
        if (this.stopping) break;
        this.lastError = codeOf(error);
        await this.sleep(this.backoffMs);
        continue;
      }
      // Let HTTP handlers run between batches.
      await new Promise((resolve) => setImmediate(resolve));
    }
  }

  start() {
    if (this.running) return this.running;
    this.stopping = false;
    this.running = this.run().finally(() => { this.running = null; });
    return this.running;
  }

  async stop() {
    this.stopping = true;
    this.wake?.();
    const running = this.running;
    if (running) await running.catch(() => {});
  }
}

const unknownPrice = (reason) => ({ status: 'unknown', reason, officialCost: null, currency: null, normalizedInput: null });

// Usage convention of an old row, decided the way the old console did (analytics.js normalizeLog): by channel type, where every
// channel except Claude counts as openai. The log's own usage_semantic only matters when the channel type is not known.
export function usageFamily(row, vendor) {
  const channel = vendor ? channelTypeInfo(vendor)?.usageFamily ?? null : null;
  if (channel) return channel;
  return row.semantics === 'openai' || row.semantics === 'anthropic' ? row.semantics : null;
}

// The token figures the old console showed for a succeeded row (analytics.js normalizeLog), from the stored counters.
// normalizedInput is the priced result's normalizedInputTokens, or null when the row could not be priced.
export function inferredUsage(row, family, normalizedInput) {
  const { counters } = row;
  const raw = counters.rawInput ?? 0, output = counters.output ?? 0, read = counters.cacheRead ?? 0;
  const create = counters.cacheWrite ?? counters.cacheCreation ?? 0;
  const fallback = raw - read - create;
  const input = normalizedInput ?? (family === 'openai' && fallback >= 0 ? fallback : raw);
  const total = family === 'openai' ? raw + output : input + output + read + create;
  const cacheTotal = family === 'openai' ? raw
    : family === 'anthropic' && (counters.cacheWrite !== null || counters.cacheCreation !== null) ? raw + read + create : null;
  const cacheInput = counters.rawInput !== null && counters.cacheRead !== null && cacheTotal !== null && read <= cacheTotal ? cacheTotal : null;
  return { input, raw, total, cacheInput, cacheRead: read, totalInput: total - output };
}
const rowKey = (day, channelId, model, type) => `${day}\u0000${channelId ?? ''}\u0000${model ?? ''}\u0000${type}`;

// The vendor from the current config wins; otherwise the built-in price table, then the synced table, when exactly one family prices the model.
function vendorOf(row, configured, priceStore) {
  if (configured) return configured;
  if (!row.model) return null;
  return resolveOfficialPrice(row.model, row.createdTimestamp)?.family
    ?? priceStore?.resolveFamily?.(row.model, row.createdTimestamp) ?? null;
}

// One legacy row, priced by the same function and inputs as the old console. Missing counts follow priceUsage's own null rules.
function priceRow(row, vendor, priceStore) {
  if (!vendor || !row.model) return unknownPrice('model_not_configured');
  const { counters } = row, at = row.createdTimestamp;
  const result = priceUsage({ model: row.model, timestamp: at, family: vendor, inputTokens: counters.rawInput,
    outputTokens: counters.output, cacheReadTokens: counters.cacheRead, cacheCreateTokens: counters.cacheWriteTotal,
    cacheCreateTokens5m: counters.cacheWrite5m, cacheCreateTokens1h: counters.cacheWrite1h,
    externalRecord: priceStore?.resolve?.(row.model, at, vendor) ?? null });
  if (result.status === 'unknown') return unknownPrice(result.reason);
  return { status: result.status, reason: result.reason, officialCost: result.officialCost, currency: result.record?.currency ?? 'USD',
    normalizedInput: result.normalizedInputTokens ?? null };
}

// Cost and per-row coverage of one bucket come from its rows; the token columns still come from the bucket sums.
// Procurement is priced per row in costsFor. A failed bucket is never costed: with a cost rule during the slot [from, to)
// (seconds) it adds nothing, without one its rows count as unpriced, as they did when the current rule was applied.
function bucketSummary(bucket, { models, costs, costStore, from, to }) {
  const vendor = (bucket.model && models.get(bucket.model)?.vendor) || null;
  const price = bucket.type !== 2 ? { officialCost: null, currency: null, coverage: {} }
    : costs.get(rowKey(bucket.day, bucket.channelId, bucket.model, bucket.type))
      ?? { officialCost: null, currency: null, coverage: { unknown: bucket.records } };
  const counters = bucket.counters, usage = price.usage;
  const keys = { totalInput: 'totalInput', inputUncached: 'inputUncached', cacheRead: 'cacheRead', cacheWrite5m: 'cacheWrite5m',
    cacheWrite1h: 'cacheWrite1h', cacheWriteUnknown: 'cacheWriteUnknown', output: 'output' };
  const tokens = [], fieldCoverage = [];
  for (const key of TOKEN_KEYS) {
    const counter = counters[keys[key]];
    tokens.push(counter ? counter.sum : 0);
    // Rows with a value are "known", rows without are "absent": unknown rows never look like zeros.
    fieldCoverage.push(counter ? counter.unknown : bucket.records, counter ? counter.known : 0, 0, 0);
  }
  // Rows without a recorded usage convention get the old console's figures; their input counts move from absent to known.
  if (usage?.unknown > 0) {
    for (const [key, sum] of [['totalInput', usage.totalInput], ['inputUncached', usage.uncached]]) {
      const slot = TOKEN_KEYS.indexOf(key);
      tokens[slot] += sum;
      fieldCoverage[slot * 4] -= usage.unknown;
      fieldCoverage[slot * 4 + 1] += usage.unknown;
    }
  }
  const succeeded = bucket.type === 2;
  const meta = { source: 'newapi', channelId: bucket.channelId, poolId: null, modelId: bucket.model, vendor,
    kind: 'request', requestOutcome: succeeded ? 'succeeded' : 'failed', attemptOutcome: succeeded ? 'succeeded' : 'upstream_failed',
    currency: price.currency, priceVersion: null };
  const summary = externalSummary(meta, { attempts: bucket.records, tokens, fieldCoverage,
    costCoverage: price.coverage, officialCost: price.officialCost });
  if (usage) Object.assign(summary, { cacheInput: usage.cacheInput, cacheRead: usage.cacheRead, cacheCount: usage.cacheCount });
  if (price.procurement) summary.procurement = { ...price.procurement, coverage: { ...price.procurement.coverage }, rules: new Set(price.procurement.rules) };
  else {
    const target = ruleTarget(bucket.channelId, bucket.model);
    const ruled = ruleAt(costStore, target, from) || ruleAt(costStore, target, to - 1);
    summary.procurement = !ruled ? unpricedProcurement(bucket.records) : succeeded ? unknownCoverage(bucket.records) : emptyProcurement();
  }
  return summary;
}

// A succeeded bucket without priced rows: with a rule its rows are unknown, as its official cost coverage says.
function unknownCoverage(records) {
  const result = emptyProcurement();
  result.coverage.unknown = records;
  return result;
}

const sumBy = (left, right, keys, make) => Object.fromEntries(keys.map((key) => [key, make(left[key], right[key])]));

// Only the fields the trend points read; everything else comes from the base row.
function mergeRow(base, extra) {
  const cacheKnownInput = base.cacheKnownInput + extra.cacheKnownInput;
  const cacheKnownRead = base.cacheKnownRead + extra.cacheKnownRead;
  return { ...base, attempts: base.attempts + extra.attempts, requests: base.requests + extra.requests,
    requestsSucceeded: base.requestsSucceeded + extra.requestsSucceeded,
    totals: sumBy(base.totals, extra.totals, TOKEN_KEYS, (a, b) => a + b),
    coverage: sumBy(base.coverage, extra.coverage, TOKEN_KEYS, (a, b) => sumBy(a, b, ['absent', 'known', 'estimated', 'partial'], (x, y) => x + y)),
    cacheKnownInput, cacheKnownRead, cacheKnownRequests: base.cacheKnownRequests + extra.cacheKnownRequests,
    cacheHitRate: cacheKnownInput > 0 ? cacheKnownRead / cacheKnownInput : null };
}

export class LegacyOverview {
  constructor({ importer, from, to, priceStore = null, costStore = null, readCacheLimit = DEFAULT_READ_CACHE }) {
    this.importer = importer; this.from = from; this.to = to; this.priceStore = priceStore; this.costStore = costStore;
    this.readCacheLimit = readCacheLimit;
    this.cache = new Map();
    this.index = null;
    this.table = null;
  }

  // Row prices depend on the price table and the cost rules, never on the import head, so a growing import keeps its cached prices.
  priceStamp() {
    return [this.priceStore, this.priceStore?.records ?? null, this.priceStore?.snapshotHash ?? null, this.costStore?.version ?? null];
  }

  // Row prices sit in flat arrays aligned with the sorted row index (state 0 = not computed yet), valid for one price stamp
  // and one set of configured model vendors. A new object per row would cost far more memory than the numbers it holds.
  priceTable(rows, models) {
    const vendors = [...models].map(([id, model]) => `${id}:${model?.vendor ?? ''}`).join('|');
    const stamp = [...this.priceStamp(), vendors];
    if (!this.table || this.table.rows !== rows || stamp.some((value, position) => value !== this.table.stamp[position])) {
      this.table = { stamp, rows, state: new Uint8Array(rows.length), cost: new Float64Array(rows.length),
        norm: new Float64Array(rows.length), currency: new Uint8Array(rows.length), currencies: [] };
    }
    return this.table;
  }

  // The row index is rebuilt when the import head moves; prices of rows that are still there move with them.
  carryPrices(rows) {
    const old = this.table;
    if (!old) return;
    const order = (left, right) => left.createdTimestamp - right.createdTimestamp || (left.recordId < right.recordId ? -1 : left.recordId > right.recordId ? 1 : 0);
    const table = { stamp: old.stamp, rows, state: new Uint8Array(rows.length), cost: new Float64Array(rows.length),
      norm: new Float64Array(rows.length), currency: new Uint8Array(rows.length), currencies: old.currencies };
    for (let before = 0, now = 0; before < old.rows.length && now < rows.length;) {
      if (old.rows[before] === rows[now]) {
        table.state[now] = old.state[before]; table.cost[now] = old.cost[before]; table.norm[now] = old.norm[before]; table.currency[now] = old.currency[before];
        before += 1; now += 1;
      } else if (order(rows[now], old.rows[before]) < 0) now += 1;
      else before += 1;
    }
    this.table = table;
  }

  // All committed rows ordered by time; rebuilt only when the checkpoint head moves.
  rowIndex() {
    const head = this.importer.checkpoint.head;
    if (this.index?.head !== head) {
      const rows = [];
      this.importer.forEachRow({ from: this.from, to: this.to, logTypes: LEGACY_TYPES }, (row) => rows.push(row));
      // Same-second rows need a fixed order so request paging can resume from a (time, id) key.
      rows.sort((left, right) => left.createdTimestamp - right.createdTimestamp || (left.recordId < right.recordId ? -1 : left.recordId > right.recordId ? 1 : 0));
      this.index = { head, rows, days: new Map() };
      this.carryPrices(rows);
    }
    return this.index;
  }

  // One row's official price. Not cached: the request page prices one page of rows, the overview uses the price table.
  rowPrice(row, models) {
    const configured = (row.model && models.get(row.model)?.vendor) || null;
    return { configured, price: priceRow(row, vendorOf(row, configured, this.priceStore), this.priceStore) };
  }

  // Old requests that changed channel inside one request (a route of more than one channel) in [from, to) seconds. The sorted times
  // of those rows are collected once per row index, so a count is two binary searches, never a scan of the whole history.
  failoverCount({ from, to }) {
    if (!this.importer.loaded) return 0;
    const index = this.rowIndex();
    if (!index.failoverTimes) {
      index.failoverTimes = [];
      for (const row of index.rows) if (row.routeChannelIds?.length > 1) index.failoverTimes.push(row.createdTimestamp);
    }
    const times = index.failoverTimes;
    const lowerBound = (value) => {
      let low = 0, high = times.length;
      while (low < high) { const middle = (low + high) >> 1; if (times[middle] < value) low = middle + 1; else high = middle; }
      return low;
    };
    return Math.max(0, lowerBound(to) - lowerBound(from));
  }

  // Earliest second the legacy window covers; null when the import is not loaded.
  earliest() { return this.importer.loaded ? this.from : null; }

  // Legacy keyset rows in [from, to) seconds; reverse walks strictly newer than `after`, oldest first.
  // `accept` filters rows; callers request one extra row to detect whether more exist.
  rowsBefore({ from, to, after = null, accept = () => true, limit, reverse = false }) {
    if (!this.importer.loaded) return [];
    const { rows } = this.rowIndex(), out = [];
    if (reverse) {
      let low = 0, high = rows.length;
      while (low < high) {
        const middle = (low + high) >> 1, row = rows[middle];
        const skip = after ? row.createdTimestamp < after.at || (row.createdTimestamp === after.at && row.recordId <= after.id)
          : row.createdTimestamp < from;
        if (skip) low = middle + 1; else high = middle;
      }
      for (let index = low; index < rows.length && out.length < limit; index += 1) {
        const row = rows[index];
        if (row.createdTimestamp >= to) break;
        if (row.createdTimestamp < from || !accept(row)) continue;
        out.push(row);
      }
      return out;
    }
    let position = rows.length;
    if (after) {
      let low = 0, high = rows.length;
      while (low < high) {
        const middle = (low + high) >> 1, row = rows[middle];
        const older = row.createdTimestamp < after.at || (row.createdTimestamp === after.at && row.recordId < after.id);
        if (older) low = middle + 1; else high = middle;
      }
      position = low;
    }
    for (let index = position - 1; index >= 0 && out.length < limit; index -= 1) {
      const row = rows[index];
      if (row.createdTimestamp < from) break;
      if (row.createdTimestamp >= to || !accept(row)) continue;
      out.push(row);
    }
    return out;
  }

  // Price of the row at `position` into the flat price table, once per price stamp.
  fillPrice(table, position, row, models) {
    if (table.state[position] !== 0) return;
    const configured = (row.model && models.get(row.model)?.vendor) || null;
    const computed = priceRow(row, vendorOf(row, configured, this.priceStore), this.priceStore);
    table.state[position] = STATUS.indexOf(computed.status);
    table.cost[position] = computed.officialCost ?? 0;
    table.norm[position] = computed.normalizedInput ?? -1;
    if (computed.currency !== null) {
      let at = table.currencies.indexOf(computed.currency);
      if (at < 0) at = table.currencies.push(computed.currency) - 1;
      table.currency[position] = at + 1;
    }
  }

  // Number of rows, known procurement cost per currency and cost coverage of the succeeded rows that `accept` takes in [from, to)
  // (seconds, as rowsBefore). Same per-row rules as the request list: failed rows are never costed, and a row costs official price
  // times the multiplier in effect for its channel and model when it was made, or nothing when there was none. Reads the price
  // table; no new cache.
  requestTotals({ from, to, accept, models }) {
    const totals = { requests: 0, coverage: { complete: 0, partial: 0, unknown: 0 }, costs: new Map() };
    if (!this.importer.loaded) return totals;
    const { rows } = this.rowIndex(), table = this.priceTable(rows, models);
    let low = 0, high = rows.length;
    while (low < high) {
      const middle = (low + high) >> 1;
      if (rows[middle].createdTimestamp < from) low = middle + 1; else high = middle;
    }
    for (let position = low; position < rows.length && rows[position].createdTimestamp < to; position += 1) {
      const row = rows[position];
      if (!accept(row)) continue;
      totals.requests += 1;
      if (row.type !== 2) continue;
      this.fillPrice(table, position, row, models);
      const rule = row.channelId !== null && row.model ? ruleAt(this.costStore, ruleTarget(row.channelId, row.model), row.createdTimestamp) : null;
      const multiplier = rule && Number.isFinite(rule.multiplier) ? rule.multiplier : null;
      const state = STATUS[table.state[position]];
      totals.coverage[multiplier === null ? 'unknown' : state] += 1;
      if (multiplier === null || state === 'unknown' || !table.currency[position]) continue;
      const currency = table.currencies[table.currency[position] - 1];
      if (!totals.costs.has(currency)) totals.costs.set(currency, { amount: 0, compensation: 0 });
      const entry = totals.costs.get(currency);
      const adjusted = table.cost[position] * multiplier - entry.compensation, next = entry.amount + adjusted;
      entry.compensation = (next - entry.amount) - adjusted;
      entry.amount = next;
    }
    return totals;
  }

  // Official cost and per-row coverage for every (day, channel, model, type) group with rows in [from, to).
  costsFor(from, to, models, channels = new Map()) {
    const { rows, days } = this.rowIndex(), groups = new Map(), table = this.priceTable(rows, models), families = new Map();
    let low = 0, high = rows.length;
    while (low < high) {
      const middle = (low + high) >> 1;
      if (rows[middle].createdTimestamp < from) low = middle + 1; else high = middle;
    }
    for (let position = low; position < rows.length && rows[position].createdTimestamp < to; position += 1) {
      const row = rows[position];
      // Only succeeded requests carry cost; failed attempts (type 5) are not priced and not counted in the cost coverage.
      if (row.type !== 2) continue;
      const slot =Math.floor((row.createdTimestamp + SHANGHAI_OFFSET_MS / 1000) / 86_400);
      let day = days.get(slot);
      if (day === undefined) { day = shanghaiDay(row.createdTimestamp * 1000); days.set(slot, day); }
      this.fillPrice(table, position, row, models);
      const key = rowKey(day, row.channelId, row.model, row.type);
      let group = groups.get(key);
      if (!group) {
        group = { officialCost: 0, currency: null, coverage: { complete: 0, partial: 0, unknown: 0 },
          usage: { unknown: 0, totalInput: 0, uncached: 0, cacheInput: 0, cacheRead: 0, cacheCount: 0 }, procurement: emptyProcurement() };
        groups.set(key, group);
      }
      // Old console figures from the channel's usage convention. They replace the missing inputs of semantics-unknown rows
      // and give every succeeded row its share of the cache hit rate.
      let channelFamily = families.get(row.channelId);
      if (channelFamily === undefined) {
        channelFamily = usageFamily({ semantics: null }, channels.get(String(row.channelId))?.vendor ?? null);
        families.set(row.channelId, channelFamily);
      }
      const used = inferredUsage(row, channelFamily ?? usageFamily(row, null), table.norm[position] < 0 ? null : table.norm[position]);
      if (row.semantics === 'unknown') { group.usage.unknown += 1; group.usage.totalInput += used.totalInput; group.usage.uncached += used.input; }
      if (used.cacheInput !== null) { group.usage.cacheInput += used.cacheInput; group.usage.cacheRead += used.cacheRead; group.usage.cacheCount += 1; }
      const price = { status: STATUS[table.state[position]], officialCost: table.cost[position],
        currency: table.currency[position] ? table.currencies[table.currency[position] - 1] : null };
      // A group never mixes currencies: a row in another currency than the first priced row is unknown, not converted.
      const status = price.status !== 'unknown' && group.currency !== null && group.currency !== price.currency ? 'unknown' : price.status;
      if (status === 'unknown') group.coverage.unknown += 1;
      else {
        group.currency = price.currency;
        group.officialCost += price.officialCost;
        group.coverage[status] += 1;
      }
      // Procurement uses the multiplier in effect when the request was made.
      addProcurement(group.procurement, ruleAt(this.costStore, ruleTarget(row.channelId, row.model), row.createdTimestamp), status, price.officialCost);
    }
    return groups;
  }

  // Raw buckets are cached per checkpoint head; prices and multipliers are applied fresh on every read.
  read(from, to) {
    if (this.readCacheLimit === 0) return this.importer.readBuckets({ from, to, logTypes: LEGACY_TYPES }).buckets;
    const key = `${this.importer.checkpoint.head}:${from}:${to}`;
    if (!this.cache.has(key)) {
      if (this.cache.size >= this.readCacheLimit) this.cache.delete(this.cache.keys().next().value);
      this.cache.set(key, this.importer.readBuckets({ from, to, logTypes: LEGACY_TYPES }).buckets);
    }
    return this.cache.get(key);
  }

  // Legacy contribution to one overview period, one entry per hour (or Shanghai day) slot; null when there is nothing to merge.
  overview(query, bucketMs, models, channels = new Map()) {
    if (!this.importer.loaded) return null;
    const fromMs = Date.parse(query.from), toMs = Date.parse(query.to);
    const lo = Math.max(Math.ceil(fromMs / 1000), this.from), hi = Math.min(Math.floor(toMs / 1000), this.to);
    if (lo >= hi) return null;
    const { types } = this.importer.coverage(lo, hi, LEGACY_TYPES);
    const through = Math.min(...LEGACY_TYPES.map((type) => types[type].coveredThrough));
    const offset = bucketMs === 86_400_000 ? SHANGHAI_OFFSET_MS : 0;
    const slots = [], summaries = [];
    for (let at = Math.floor((fromMs + offset) / bucketMs) * bucketMs - offset; at < toMs; at += bucketMs) {
      const from = Math.max(Math.ceil(at / 1000), lo), to = Math.min(Math.floor((at + bucketMs) / 1000), hi);
      if (from >= to) continue;
      const buckets = this.read(from, to);
      if (!buckets.length) continue;
      const costs = this.costsFor(from, to, models, channels);
      const slot = buckets.map((bucket) => bucketSummary(bucket, { models, costs, costStore: this.costStore, from, to }));
      slots.push({ time: new Date(at).toISOString(), from: iso(from), to: iso(to), summaries: slot });
      summaries.push(...slot);
    }
    return { info: { from: iso(this.from), to: iso(this.to), mergedFrom: iso(lo), mergedTo: iso(hi),
      coveredThrough: iso(Math.min(hi, Math.max(lo, through))), complete: through >= hi }, slots, summaries };
  }

  // Add the slot summaries to the projection timeline rows (same row shape: per channel plus one total row).
  mergeTimeline(timeline, legacy, projection, state) {
    if (!legacy) return timeline;
    const rowKey = (row) => `${row.time}|${row.channelId === undefined ? '*' : `c:${row.channelId}`}`;
    const rows = new Map(timeline.map((row) => [rowKey(row), row]));
    for (const slot of legacy.slots) {
      const period = { from: slot.from, to: slot.to };
      const extra = [...projection.breakdown(period, ['channelId'], slot.summaries, state), projection.summarize(slot.summaries, period, state)];
      for (const result of extra) {
        if (result.attempts === 0) continue;
        const row = { time: slot.time, ...result }, key = rowKey(row);
        rows.set(key, rows.has(key) ? mergeRow(rows.get(key), row) : row);
      }
    }
    return [...rows.values()].sort((a, b) => Date.parse(a.time) - Date.parse(b.time));
  }
}
