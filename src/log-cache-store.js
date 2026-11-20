import { randomBytes } from 'node:crypto';
import { chmod, mkdir, open, readFile, rename, stat } from 'node:fs/promises';
import path from 'node:path';

const SCHEMA_VERSION = 2;
const DEFAULT_RETENTION_SECONDS = 35 * 24 * 60 * 60;
const MAX_STORE_BYTES = 256 * 1024 * 1024;
const SNAPSHOT_LOG_LIMIT = 200;

function number(value, fallback = null) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function parseOther(value) {
  if (!value) return {};
  if (typeof value === 'object') return value;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function compactOther(value) {
  const source = parseOther(value);
  const result = {};
  for (const key of [
    'usage_semantic',
    'cache_tokens',
    'cache_creation_tokens',
    'cache_creation_tokens_5m',
    'cache_creation_tokens_1h',
    'cache_write_tokens',
    'reasoning_effort',
    'frt',
    'request_conversion',
    'stream_status',
  ]) {
    if (Object.hasOwn(source, key)) result[key] = source[key];
  }
  const channels = source.admin_info?.use_channel;
  if (Array.isArray(channels)) result.admin_info = { use_channel: channels };
  return Object.keys(result).length ? JSON.stringify(result) : '';
}

function compactLog(input = {}) {
  const createdAt = number(input.created_at);
  if (!createdAt || createdAt < 0) return null;
  return {
    id: input.id ?? null,
    created_at: Math.floor(createdAt),
    channel: number(input.channel ?? input.channel_id, 0),
    channel_name: String(input.channel_name || '').slice(0, 255),
    username: String(input.username || '').slice(0, 255),
    token_name: String(input.token_name || '').slice(0, 255),
    model_name: String(input.model_name || '').slice(0, 255),
    quota: number(input.quota, 0),
    prompt_tokens: number(input.prompt_tokens, 0),
    completion_tokens: number(input.completion_tokens, 0),
    use_time: number(input.use_time, 0),
    is_stream: input.is_stream === true,
    group: String(input.group || '').slice(0, 255),
    request_id: String(input.request_id || '').slice(0, 255),
    content: String(input.content || '').slice(0, 4000),
    other: compactOther(input.other),
  };
}

function logKey(type, log) {
  if (log.request_id) return `${type}:request:${log.request_id}`;
  if (log.id !== null && log.id !== undefined && log.id !== '') return `${type}:id:${log.id}`;
  return `${type}:fallback:${log.created_at}:${log.channel}:${log.model_name}:${log.content}`;
}

function compareLogs(left, right) {
  return right.created_at - left.created_at
    || String(right.request_id || right.id || '').localeCompare(String(left.request_id || left.id || ''));
}

async function atomicWriteJson(filePath, value) {
  if (!filePath) return;
  const directory = path.dirname(filePath);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700).catch(() => {});
  const temporary = path.join(directory, `.${path.basename(filePath)}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`);
  const handle = await open(temporary, 'wx', 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(value)}\n`, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temporary, filePath);
  await chmod(filePath, 0o600).catch(() => {});
}

function emptyTypeState() {
  return { coveredFrom: null, checkedThrough: 0, items: [] };
}

function cachePeriod(input = {}) {
  const startTimestamp = number(input.startTimestamp, 0);
  const endTimestamp = number(input.endTimestamp, 0);
  if (!startTimestamp || !endTimestamp || endTimestamp < startTimestamp) return null;
  return {
    key: String(input.key || ''),
    cacheKey: String(input.cacheKey || input.key || ''),
    label: String(input.label || ''),
    hours: number(input.hours, 24),
    startTimestamp: Math.floor(startTimestamp),
    endTimestamp: Math.floor(endTimestamp),
  };
}

function compactOverview(value) {
  return {
    ...value,
    logs: Array.isArray(value?.logs) ? value.logs.slice(0, SNAPSHOT_LOG_LIMIT) : [],
    errors: Array.isArray(value?.errors) ? value.errors.slice(0, SNAPSHOT_LOG_LIMIT) : [],
  };
}

export class LogCacheStore {
  constructor({ filePath = null, retentionSeconds = DEFAULT_RETENTION_SECONDS, now = () => Date.now(), persistDelayMs = 2000 } = {}) {
    this.filePath = filePath;
    this.retentionSeconds = Math.max(24 * 60 * 60, Math.floor(Number(retentionSeconds) || DEFAULT_RETENTION_SECONDS));
    this.now = now;
    this.persistDelayMs = persistDelayMs;
    this.logTypes = { 2: emptyTypeState(), 5: emptyTypeState() };
    this.overviews = {};
    this.writeQueue = Promise.resolve();
    this.dirty = false;
    this.persistTimer = null;
  }

  trim(referenceTimestamp = Math.floor(this.now() / 1000)) {
    const cutoff = referenceTimestamp - this.retentionSeconds;
    for (const type of ['2', '5']) {
      const state = this.logTypes[type] || emptyTypeState();
      state.items = state.items.filter((item) => item.created_at >= cutoff);
      if (state.coveredFrom !== null && state.coveredFrom < cutoff) state.coveredFrom = cutoff;
      this.logTypes[type] = state;
    }
    this.overviews = Object.fromEntries(Object.entries(this.overviews).filter(([, entry]) =>
      entry?.period?.endTimestamp >= cutoff && entry?.value && Number.isFinite(Number(entry.fetchedAt)),
    ));
  }

  schedulePersist() {
    this.dirty = true;
    if (this.persistTimer) return;
    this.persistTimer = setTimeout(() => {
      this.flush().catch((error) => console.error('[log-cache] persist failed', error));
    }, this.persistDelayMs);
    this.persistTimer.unref?.();
  }

  flush() {
    if (this.persistTimer) {
      clearTimeout(this.persistTimer);
      this.persistTimer = null;
    }
    const task = async () => {
      if (!this.filePath) return;
      if (!this.dirty) return;
      this.dirty = false;
      try {
        await this.persist();
      } catch (error) {
        this.dirty = true;
        throw error;
      }
    };
    const result = this.writeQueue.then(task, task);
    this.writeQueue = result.catch(() => {});
    return result;
  }

  async load() {
    if (!this.filePath) return this.snapshot();
    try {
      const metadata = await stat(this.filePath);
      if (metadata.size > MAX_STORE_BYTES) throw new Error('Log cache store is too large');
      const parsed = JSON.parse(await readFile(this.filePath, 'utf8'));
      if (![1, SCHEMA_VERSION].includes(parsed?.schemaVersion)) throw new Error('Unsupported log cache store schema');
      const legacy = parsed.schemaVersion === 1;
      for (const type of ['2', '5']) {
        const source = parsed.logTypes?.[type] || {};
        const items = Array.isArray(source.items) ? source.items : [];
        this.logTypes[type] = {
          coveredFrom: !legacy && source.coveredFrom != null && Number.isFinite(Number(source.coveredFrom)) ? Math.floor(Number(source.coveredFrom)) : null,
          checkedThrough: legacy ? 0 : Math.max(0, Math.floor(Number(source.checkedThrough) || 0)),
          items: items.map(compactLog).filter(Boolean).sort(compareLogs),
        };
      }
      // Version 1 could mark partial recent pages as complete coverage.
      this.overviews = !legacy && parsed.overviews && typeof parsed.overviews === 'object' ? parsed.overviews : {};
      this.trim();
      if (legacy) await this.persist();
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      await this.persist();
    }
    return this.snapshot();
  }

  snapshot() {
    return {
      logTypes: this.logTypes,
      overviews: this.overviews,
    };
  }

  persist() {
    return atomicWriteJson(this.filePath, {
      schemaVersion: SCHEMA_VERSION,
      logTypes: this.logTypes,
      overviews: this.overviews,
    });
  }

  items(type) {
    return this.logTypes[String(type)]?.items || [];
  }

  coveredFrom(type) {
    return this.logTypes[String(type)]?.coveredFrom ?? null;
  }

  latestTimestamp(type) {
    return this.items(type).reduce((latest, item) => Math.max(latest, item.created_at), 0);
  }

  checkedThrough(type) {
    return this.logTypes[String(type)]?.checkedThrough || 0;
  }

  overviewEntries() {
    return Object.entries(this.overviews)
      .map(([cacheKey, entry]) => ({ cacheKey, ...entry }))
      .filter((entry) => entry.period && entry.value);
  }

  merge(type, records, { coveredFrom = null, checkedThrough = null } = {}) {
    const normalizedType = String(type);
    if (!['2', '5'].includes(normalizedType)) throw new Error('Unsupported log cache type');
    const task = async () => {
      const state = this.logTypes[normalizedType] || emptyTypeState();
      const merged = new Map(state.items.map((item) => [logKey(normalizedType, item), item]));
      for (const input of Array.isArray(records) ? records : []) {
        const item = compactLog(input);
        if (item) merged.set(logKey(normalizedType, item), item);
      }
      state.items = [...merged.values()].sort(compareLogs);
      if (coveredFrom != null && Number.isFinite(Number(coveredFrom))) {
        const nextCoveredFrom = Math.floor(Number(coveredFrom));
        state.coveredFrom = state.coveredFrom === null ? nextCoveredFrom : Math.min(state.coveredFrom, nextCoveredFrom);
      }
      if (checkedThrough != null && Number.isFinite(Number(checkedThrough))) {
        state.checkedThrough = Math.max(state.checkedThrough || 0, Math.floor(Number(checkedThrough)));
      }
      this.logTypes[normalizedType] = state;
      this.trim();
      this.schedulePersist();
      return state.items;
    };
    const result = this.writeQueue.then(task, task);
    this.writeQueue = result.catch(() => {});
    return result;
  }

  saveOverview(period, entry) {
    const normalizedPeriod = cachePeriod(period);
    if (!normalizedPeriod) throw new Error('Overview cache requires a valid period');
    const task = async () => {
      this.overviews[normalizedPeriod.cacheKey] = {
        fetchedAt: Math.max(0, Math.floor(Number(entry?.fetchedAt) || this.now())),
        period: normalizedPeriod,
        value: compactOverview(entry?.value || {}),
      };
      this.trim();
      this.schedulePersist();
      return this.overviews[normalizedPeriod.cacheKey];
    };
    const result = this.writeQueue.then(task, task);
    this.writeQueue = result.catch(() => {});
    return result;
  }
}

export { DEFAULT_RETENTION_SECONDS, MAX_STORE_BYTES, SCHEMA_VERSION };
