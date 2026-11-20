import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

const RATE_KEYS = Object.freeze(['modelRatio', 'completionRatio', 'cacheRatio', 'createCacheRatio']);

function positive(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function sameTarget(left, right) {
  return RATE_KEYS.every((key) => (left?.[key] ?? null) === (right?.[key] ?? null));
}

function targetFromRecord(record) {
  const input = positive(record?.rates?.input);
  const output = positive(record?.rates?.output);
  const cacheRead = positive(record?.rates?.cacheRead);
  const cacheWrite = positive(record?.rates?.cacheWrite);
  if ([input, output, cacheRead].includes(null)) return null;
  return {
    modelRatio: input / 2,
    completionRatio: output / input,
    cacheRatio: cacheRead / input,
    createCacheRatio: cacheWrite === null ? null : cacheWrite / input,
  };
}

function currentTarget(tables, model) {
  return {
    modelRatio: Object.hasOwn(tables.model_ratio || {}, model) ? Number(tables.model_ratio[model]) : null,
    completionRatio: Object.hasOwn(tables.completion_ratio || {}, model) ? Number(tables.completion_ratio[model]) : null,
    cacheRatio: Object.hasOwn(tables.cache_ratio || {}, model) ? Number(tables.cache_ratio[model]) : null,
    createCacheRatio: Object.hasOwn(tables.create_cache_ratio || {}, model) ? Number(tables.create_cache_ratio[model]) : null,
  };
}

function safeEntries(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value).filter(([key, entry]) => key && entry && typeof entry === 'object'));
}

export class NewApiPricingSyncStore {
  constructor({ filePath, client, now = () => Date.now(), confirmationDelayMs = 5 * 60 * 1000 } = {}) {
    this.filePath = filePath;
    this.client = client;
    this.now = now;
    this.confirmationDelayMs = confirmationDelayMs;
    this.entries = {};
    this.lastAttemptAt = null;
    this.lastSuccessAt = null;
    this.lastError = null;
  }

  async load() {
    if (!this.filePath) return this.snapshot();
    try {
      const parsed = JSON.parse(await readFile(this.filePath, 'utf8'));
      this.entries = safeEntries(parsed.entries);
      this.lastAttemptAt = parsed.lastAttemptAt || null;
      this.lastSuccessAt = parsed.lastSuccessAt || null;
      this.lastError = parsed.lastError || null;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    return this.snapshot();
  }

  async persist() {
    if (!this.filePath) return;
    await mkdir(path.dirname(this.filePath), { recursive: true });
    const temporary = `${this.filePath}.${process.pid}.tmp`;
    const body = JSON.stringify({
      version: 1,
      lastAttemptAt: this.lastAttemptAt,
      lastSuccessAt: this.lastSuccessAt,
      lastError: this.lastError,
      entries: this.entries,
    }, null, 2);
    await writeFile(temporary, `${body}\n`, { mode: 0o600 });
    await rename(temporary, this.filePath);
  }

  snapshot() {
    const entries = Object.values(this.entries)
      .map((entry) => ({
        family: entry.family,
        model: entry.model,
        status: entry.status,
        source: entry.source,
        rates: entry.rates || null,
        lastSeenAt: entry.lastSeenAt || null,
        lastAppliedAt: entry.lastAppliedAt || null,
        message: entry.message || null,
      }))
      .sort((left, right) => `${left.family}:${left.model}`.localeCompare(`${right.family}:${right.model}`));
    const counts = entries.reduce((result, entry) => {
      result[entry.status] = (result[entry.status] || 0) + 1;
      return result;
    }, {});
    return {
      configured: Boolean(this.client?.pricingSyncConfigured?.()),
      lastAttemptAt: this.lastAttemptAt,
      lastSuccessAt: this.lastSuccessAt,
      lastError: this.lastError,
      counts,
      entries,
      needsConfirmation: (counts.pending || 0) > 0,
    };
  }

  async synchronize({ records, models, observationId, snapshotHash } = {}) {
    this.lastAttemptAt = new Date(this.now()).toISOString();
    if (!this.client?.pricingSyncConfigured?.()) {
      this.lastError = 'New API pricing synchronization is not configured';
      await this.persist();
      return this.snapshot();
    }

    try {
      const current = await this.client.pricingTables();
      const desired = clone(current);
      const observedKeys = new Set();
      const mutations = [];
      const observedAt = this.now();

      for (const record of Array.isArray(records) ? records : []) {
        if (!record?.family) continue;
        const model = String(record?.model || '').trim();
        if (models && !models.has(model)) continue;
        const target = targetFromRecord(record);
        if (!model || !target) continue;
        const key = `${record.family}:${model}`;
        observedKeys.add(key);
        const entry = this.entries[key] || { family: record.family, model, lastApplied: null, pending: null };
        delete entry.remanage;
        entry.source = {
          label: record.sourceLabel || 'models.dev 同步',
          url: record.sourceUrl || null,
          snapshotHash: snapshotHash || null,
        };
        entry.lastSeenAt = record.lastSeenAt || this.lastAttemptAt;
        entry.rates = record.rates ? { ...record.rates } : null;
        entry.message = null;

        // New API already holds the desired ratios: no confirmation round needed.
        const currentValue = currentTarget(current, model);
        if (sameTarget(currentValue, target)) {
          entry.lastApplied = target;
          entry.lastAppliedAt ||= this.lastAttemptAt;
          entry.status = 'synced';
          entry.pending = null;
          this.entries[key] = entry;
          continue;
        }

        if (!entry.pending || !sameTarget(entry.pending.target, target)) {
          entry.pending = { target, observationId, firstObservedAt: observedAt };
          entry.status = 'pending';
          entry.message = '等待第二次一致观测';
          this.entries[key] = entry;
          continue;
        }

        const secondObservation = observationId
          && entry.pending.observationId
          && observationId !== entry.pending.observationId
          && observedAt - Number(entry.pending.firstObservedAt || 0) >= this.confirmationDelayMs;
        if (!secondObservation) {
          entry.status = 'pending';
          entry.message = '等待第二次一致观测';
          this.entries[key] = entry;
          continue;
        }

        for (const [table, key] of [['model_ratio', 'modelRatio'], ['completion_ratio', 'completionRatio'], ['cache_ratio', 'cacheRatio'], ['create_cache_ratio', 'createCacheRatio']]) {
          if (target[key] !== null) desired[table][model] = target[key];
        }
        mutations.push({ key, entry, target });
        this.entries[key] = entry;
      }

      for (const [key, entry] of Object.entries(this.entries)) {
        if (models && !models.has(entry.model)) {
          delete this.entries[key];
          continue;
        }
        if (!observedKeys.has(key)) {
          entry.status = 'stale';
          entry.message = '价格源本次未返回完整价格，已保留旧值';
          entry.pending = null;
        }
      }

      if (mutations.length) {
        await this.client.applyPricingTables(current, desired);
        for (const { entry, target } of mutations) {
          entry.lastApplied = target;
          entry.lastAppliedAt = this.lastAttemptAt;
          entry.status = 'synced';
          entry.message = null;
          entry.pending = null;
        }
      }

      this.lastSuccessAt = this.lastAttemptAt;
      this.lastError = null;
      await this.persist();
      return this.snapshot();
    } catch (error) {
      this.lastError = String(error?.message || error || 'New API pricing synchronization failed').slice(0, 240);
      await this.persist().catch(() => {});
      throw error;
    }
  }
}
