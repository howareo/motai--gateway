import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pricingProvider, pricingSource } from './channel-types.js';

const DEFAULT_SOURCE_URL = 'https://models.dev/api.json';
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
const MODEL_PRICE_ALIASES = new Map([
  ['claude-opus-5.5', 'claude-opus-5-5'],
  ['claude-sonnet-5.5', 'claude-sonnet-5-5'],
]);

function finitePositive(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function finiteTimestamp(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function sameRates(left, right) {
  return ['input', 'output', 'cacheRead', 'cacheWrite', 'cacheWrite1h']
    .every((key) => (left?.[key] ?? null) === (right?.[key] ?? null));
}

function modelAliases(model, entry) {
  const base = String(entry?.canonical_model_id || '').split('/').pop().replace(/-\d{4,8}$/, '');
  return base && base !== model ? [base] : [];
}

function safeRecords(value) {
  if (!Array.isArray(value)) return [];
  return value.filter((record) => {
    if (!record || typeof record !== 'object') return false;
    if (!pricingProvider(record.family) || !String(record.model || '').trim()) return false;
    if (finiteTimestamp(record.effectiveFrom) === null) return false;
    const requiredRates = ['input', 'output', 'cacheRead'];
    if (!requiredRates.every((key) => finitePositive(record.rates?.[key]) !== null)) return false;
    return true;
  });
}

function publicError(error) {
  const value = String(error?.message || error || 'Pricing synchronization failed');
  return value.slice(0, 240);
}

export class ModelPricingStore {
  constructor({
    filePath,
    sourceUrl = DEFAULT_SOURCE_URL,
    fetchImpl = fetch,
    now = () => Date.now(),
  } = {}) {
    this.filePath = filePath;
    this.sourceUrl = sourceUrl;
    this.fetch = fetchImpl;
    this.now = now;
    this.records = [];
    this.lastAttemptAt = null;
    this.lastSuccessAt = null;
    this.lastError = null;
    this.snapshotHash = null;
  }

  async load() {
    if (!this.filePath) return this.snapshot();
    try {
      const parsed = JSON.parse(await readFile(this.filePath, 'utf8'));
      this.records = safeRecords(parsed.records);
      this.lastAttemptAt = parsed.lastAttemptAt || null;
      this.lastSuccessAt = parsed.lastSuccessAt || null;
      this.lastError = parsed.lastError || null;
      this.snapshotHash = parsed.snapshotHash || null;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    return this.snapshot();
  }

  snapshot() {
    return {
      source: 'models.dev',
      sourceUrl: this.sourceUrl,
      lastAttemptAt: this.lastAttemptAt,
      lastSuccessAt: this.lastSuccessAt,
      lastError: this.lastError,
      snapshotHash: this.snapshotHash,
      records: this.records.length,
      models: new Set(this.records.map((record) => `${record.family}:${record.model}`)).size,
    };
  }

  resolve(model, timestamp, family) {
    const at = finiteTimestamp(timestamp) ?? this.now() / 1000;
    const priceModel = MODEL_PRICE_ALIASES.get(model) || model;
    const record = this.records
      .filter((record) => record.model === priceModel
        && record.family === family
        && record.effectiveFrom <= at
        && (record.effectiveTo === null || at < record.effectiveTo))
      .sort((left, right) => right.effectiveFrom - left.effectiveFrom)[0] || null;
    return record && priceModel !== model ? { ...record, model } : record;
  }

  resolveOfficial(model, timestamp) {
    const at = finiteTimestamp(timestamp) ?? this.now() / 1000;
    const priceModel = MODEL_PRICE_ALIASES.get(model) || model;
    const matches = this.records.filter((record) => record.model === priceModel
      && pricingProvider(record.family)
      && record.effectiveFrom <= at
      && (record.effectiveTo === null || at < record.effectiveTo));
    const families = new Set(matches.map((record) => record.family));
    if (families.size !== 1) return null;
    const record = matches.sort((left, right) => right.effectiveFrom - left.effectiveFrom)[0] || null;
    return record && priceModel !== model ? { ...record, model } : record;
  }

  // The one family that has a current price for this model (aliases applied), or null when there is none or more than one.
  resolveFamily(model, timestamp) {
    const at = finiteTimestamp(timestamp) ?? this.now() / 1000;
    const priceModel = MODEL_PRICE_ALIASES.get(model) || model;
    const families = new Set();
    for (const record of this.records) {
      if (record.model === priceModel && record.effectiveFrom <= at && (record.effectiveTo === null || at < record.effectiveTo)) families.add(record.family);
    }
    return families.size === 1 ? [...families][0] : null;
  }

  activeRecords(timestamp = this.now() / 1000) {
    const active = new Map();
    for (const record of this.records) {
      if (record.effectiveFrom > timestamp || (record.effectiveTo !== null && timestamp >= record.effectiveTo)) continue;
      const key = `${record.family}:${record.model}`;
      const existing = active.get(key);
      if (!existing || record.effectiveFrom > existing.effectiveFrom) active.set(key, record);
    }
    return [...active.values()].map((record) => ({ ...record, rates: { ...record.rates } }));
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
      snapshotHash: this.snapshotHash,
      records: this.records,
    }, null, 2);
    await writeFile(temporary, `${body}\n`, { mode: 0o600 });
    await rename(temporary, this.filePath);
  }

  extract(payload, observedAt, snapshotHash) {
    const chosen = new Map();
    const realIds = new Set();
    for (const [providerId, provider] of Object.entries(payload || {})) {
      const family = pricingSource(providerId);
      if (!family || !provider?.models || typeof provider.models !== 'object') continue;
      for (const model of Object.keys(provider.models)) realIds.add(`${family}:${model}`);
    }
    for (const [providerId, provider] of Object.entries(payload || {})) {
      const family = pricingSource(providerId);
      if (!family) continue;
      if (!provider || provider.id !== providerId || !provider.models || typeof provider.models !== 'object') continue;
      for (const [model, entry] of Object.entries(provider.models)) {
        if (!entry || entry.id !== model) continue;
        const input = finitePositive(entry.cost?.input);
        const output = finitePositive(entry.cost?.output);
        const cacheRead = finitePositive(entry.cost?.cache_read);
        const cacheWrite = finitePositive(entry.cost?.cache_write);
        if ([input, output, cacheRead].includes(null)) continue;
        const record = {
          model,
          family,
          effectiveFrom: observedAt / 1000,
          effectiveTo: null,
          promptIncludesCache: ['openai', 'xai', 'deepseek'].includes(family),
          maxContextTokens: finitePositive(entry.limit?.context),
          rates: { input, output, cacheRead, cacheWrite, cacheWrite1h: null },
          sourceUrl: this.sourceUrl,
          sourceLabel: 'models.dev 同步',
          tier: 'synced',
          capturedAt: new Date(observedAt).toISOString().slice(0, 10),
          verifiedAt: null,
          firstObservedAt: new Date(observedAt).toISOString(),
          lastSeenAt: new Date(observedAt).toISOString(),
          sourceSnapshot: snapshotHash,
        };
        const aliases = modelAliases(model, entry)
          .filter((alias) => !realIds.has(`${family}:${alias}`))
          // Aliases are name mappings, not price changes: apply them to historical logs too.
          .map((alias) => ({ ...record, model: alias, effectiveFrom: 0 }));
        for (const variant of [record, ...aliases]) {
          const key = `${family}:${variant.model}`;
          if (chosen.get(key) === null) continue;
          const previous = chosen.get(key);
          if (previous && (!sameRates(previous.rates, variant.rates) || previous.maxContextTokens !== variant.maxContextTokens)) {
            chosen.set(key, null);
            continue;
          }
          if (!previous) chosen.set(key, variant);
        }
      }
    }
    return [...chosen.values()].filter(Boolean);
  }

  merge(observed, observedAt, snapshotHash) {
    const next = this.records.map((record) => ({ ...record, rates: { ...record.rates } }));
    for (const incoming of observed) {
      const active = next
        .filter((record) => record.model === incoming.model && record.family === incoming.family && record.effectiveTo === null)
        .sort((left, right) => right.effectiveFrom - left.effectiveFrom)[0];
      if (active && sameRates(active.rates, incoming.rates) && active.maxContextTokens === incoming.maxContextTokens) {
        active.effectiveFrom = Math.min(active.effectiveFrom, incoming.effectiveFrom);
        active.lastSeenAt = incoming.lastSeenAt;
        continue;
      }
      if (active) {
        active.effectiveTo = observedAt / 1000;
        incoming.effectiveFrom = observedAt / 1000;
      }
      next.push(incoming);
    }
    this.records = next;
    this.snapshotHash = snapshotHash;
  }

  async refresh({ timeoutMs = 15000 } = {}) {
    const attemptedAt = this.now();
    this.lastAttemptAt = new Date(attemptedAt).toISOString();
    try {
      const response = await this.fetch(this.sourceUrl, {
        method: 'GET',
        headers: { accept: 'application/json' },
        redirect: 'error',
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!response.ok) throw new Error(`models.dev returned HTTP ${response.status}`);
      const contentLength = Number(response.headers.get('content-length'));
      if (Number.isFinite(contentLength) && contentLength > MAX_RESPONSE_BYTES) {
        throw new Error('models.dev response is too large');
      }
      const body = await response.text();
      if (Buffer.byteLength(body) > MAX_RESPONSE_BYTES) throw new Error('models.dev response is too large');
      const payload = JSON.parse(body);
      const snapshotHash = createHash('sha256').update(body).digest('hex');
      const observed = this.extract(payload, attemptedAt, snapshotHash);
      if (!observed.length) throw new Error('models.dev returned no trusted provider prices');
      this.merge(observed, attemptedAt, snapshotHash);
      this.lastSuccessAt = this.lastAttemptAt;
      this.lastError = null;
      await this.persist();
      return this.snapshot();
    } catch (error) {
      this.lastError = publicError(error);
      await this.persist().catch(() => {});
      throw error;
    }
  }
}

export { DEFAULT_SOURCE_URL };

