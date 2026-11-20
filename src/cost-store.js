import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { normalizeChannelId, normalizeChannelIdentity as normalizeIdentity, sameChannelIdentity as sameIdentity } from './channel-id.js';

const AUTO_MIN_MULTIPLIER = 0.001;
const AUTO_MAX_MULTIPLIER = 10;
export const DEFAULT_COST_SYNC_INTERVAL_MINUTES = 30;
export const MIN_COST_SYNC_INTERVAL_MINUTES = 1;
export const MAX_COST_SYNC_INTERVAL_MINUTES = 1440;

export function requireCostSyncIntervalMinutes(value) {
  if (!Number.isInteger(value) || value < MIN_COST_SYNC_INTERVAL_MINUTES || value > MAX_COST_SYNC_INTERVAL_MINUTES) {
    throw Object.assign(new Error(`Cost sync interval must be an integer between ${MIN_COST_SYNC_INTERVAL_MINUTES} and ${MAX_COST_SYNC_INTERVAL_MINUTES} minutes`), { statusCode: 400 });
  }
  return value;
}

const DEFAULT_RULES = Object.freeze([
  {
    id: 'default-030',
    channelId: '*',
    model: '*',
    multiplier: 0.3,
    effectiveFrom: 0,
    label: 'Default procurement discount',
  },
]);

function normalizeRule(input, previous = {}) {
  const channelId = input.channelId === undefined ? previous.channelId ?? '*' : input.channelId;
  const multiplier = Number(input.multiplier ?? previous.multiplier);
  const effectiveFrom = Number(input.effectiveFrom ?? previous.effectiveFrom ?? 0);
  const revision = Number(input.revision ?? previous.revision ?? 0);
  if (!Number.isFinite(multiplier) || multiplier < 0 || multiplier > 100) {
    throw new Error('Cost multiplier must be between 0 and 100');
  }
  if (!Number.isFinite(effectiveFrom) || effectiveFrom < 0) throw new Error('effectiveFrom must be a Unix timestamp');
  if (!Number.isInteger(revision) || revision < 0) throw new Error('revision must be a non-negative integer');
  return {
    id: String(input.id || previous.id || randomUUID()),
    channelId: channelId === '*'
      ? '*'
      : normalizeChannelId(channelId),
    model: String(input.model ?? previous.model ?? '*').trim() || '*',
    multiplier,
    effectiveFrom,
    revision,
    label: String(input.label ?? previous.label ?? '').trim(),
  };
}

function finiteOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function sameMultiplier(left, right) {
  if (!Number.isFinite(left) || !Number.isFinite(right)) return false;
  return Math.abs(left - right) <= Math.max(1e-9, Math.abs(right) * 1e-6);
}

function normalizeObservation(input) {
  if (!input || typeof input !== 'object') return null;
  const value = finiteOrNull(input.value);
  const count = Number(input.count);
  if (value === null || !Number.isInteger(count) || count < 1) return null;
  return {
    value,
    count,
    observedAt: input.observedAt ? String(input.observedAt) : null,
    receivedAt: input.receivedAt ? String(input.receivedAt) : null,
  };
}

function normalizeSyncState(input = {}) {
  const mode = input.mode === 'auto' ? 'auto' : 'manual';
  const identity = normalizeIdentity(input.identity || {});
  const status = String(input.status || (mode === 'auto' ? 'stale' : 'manual'));
  const pending = input.pending && typeof input.pending === 'object'
    ? {
        value: finiteOrNull(input.pending.value),
        reason: String(input.pending.reason || ''),
        observations: Math.max(1, Number(input.pending.observations) || 1),
        observedAt: input.pending.observedAt ? String(input.pending.observedAt) : null,
        receivedAt: input.pending.receivedAt ? String(input.pending.receivedAt) : null,
      }
    : null;
  return {
    mode,
    identity,
    humanAnchorMultiplier: finiteOrNull(input.humanAnchorMultiplier),
    lastConfirmedMultiplier: finiteOrNull(input.lastConfirmedMultiplier),
    lastConfirmedAt: input.lastConfirmedAt ? String(input.lastConfirmedAt) : null,
    lastAttemptAt: input.lastAttemptAt ? String(input.lastAttemptAt) : null,
    lastSuccessAt: input.lastSuccessAt ? String(input.lastSuccessAt) : null,
    status,
    errorClass: input.errorClass ? String(input.errorClass) : null,
    // Only meaningful while status is identity_changed: the identity from before the change, so a
    // later look at the record can tell what changed (and reconcileChannels can undo a change that
    // has since been reverted). Any other status drops it.
    previousIdentity: status === 'identity_changed' && input.previousIdentity && typeof input.previousIdentity === 'object'
      ? normalizeIdentity(input.previousIdentity)
      : null,
    upstreamGroup: input.upstreamGroup ? String(input.upstreamGroup).trim() : null,
    upstreamSource: input.upstreamSource ? String(input.upstreamSource).trim() : null,
    dailyCosts: Array.isArray(input.dailyCosts) ? input.dailyCosts.filter((day) =>
      day && /^\d{4}-\d{2}-\d{2}$/.test(day.date) && Number.isFinite(Date.parse(day.date))
      && new Date(day.date).toISOString().slice(0, 10) === day.date
      && Number.isFinite(day.actualCost) && day.actualCost >= 0
      && Number.isFinite(day.standardCost) && day.standardCost >= 0
      && Number.isSafeInteger(day.requests) && day.requests >= 0)
      .map(({ date, actualCost, standardCost, requests }) => ({ date, actualCost, standardCost, requests })) : [],
    billingObservedAt: input.billingObservedAt || null,
    observation: normalizeObservation(input.observation),
    pending: pending?.value === null ? null : pending,
  };
}

function conflict(message = 'Cost rules changed; refresh and try again') {
  return Object.assign(new Error(message), { statusCode: 409 });
}

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

export class CostStore {
  constructor(filePath) {
    this.filePath = filePath;
    this.rules = [];
    this.channelSync = Object.create(null);
    this.version = 0;
    this.costSyncIntervalMinutes = DEFAULT_COST_SYNC_INTERVAL_MINUTES;
    this.writeQueue = Promise.resolve();
  }

  async load() {
    try {
      const parsed = JSON.parse(await readFile(this.filePath, 'utf8'));
      this.rules = (Array.isArray(parsed.rules) ? parsed.rules : []).map((item) => normalizeRule(item));
      this.channelSync = Object.assign(Object.create(null), Object.fromEntries(Object.entries(parsed.channelSync || {})
        .map(([id, state]) => [normalizeChannelId(id), normalizeSyncState(state)])));
      this.version = Number.isInteger(parsed.version) && parsed.version >= 0 ? parsed.version : 1;
      this.costSyncIntervalMinutes = requireCostSyncIntervalMinutes(parsed.settings?.costSyncIntervalMinutes ?? DEFAULT_COST_SYNC_INTERVAL_MINUTES);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      this.rules = DEFAULT_RULES.map((item) => normalizeRule(item));
      this.channelSync = Object.create(null);
      this.version = 0;
      await this.save(this.rules, { expectedVersion: 0 });
    }
    return this.snapshot();
  }

  list() {
    return this.rules.map((item) => ({ ...item }));
  }

  snapshot() {
    return { version: this.version, rules: this.list(), channelSync: clone(this.channelSync) };
  }

  queueWrite(task) {
    const result = this.writeQueue.then(task, task);
    this.writeQueue = result.catch(() => {});
    return result;
  }

  async persist(rules, channelSync, expectedVersion, costSyncIntervalMinutes = this.costSyncIntervalMinutes) {
    if (Number(expectedVersion) !== this.version) throw conflict();
    const normalizedRules = rules.map((item) => normalizeRule(item));
    const ids = new Set();
    for (const rule of normalizedRules) {
      if (ids.has(rule.id)) throw new Error(`Duplicate cost rule id: ${rule.id}`);
      ids.add(rule.id);
    }
    const normalizedSync = Object.assign(Object.create(null), Object.fromEntries(Object.entries(channelSync)
      .map(([id, state]) => [normalizeChannelId(id), normalizeSyncState(state)])));
    await mkdir(path.dirname(this.filePath), { recursive: true });
    const temporary = `${this.filePath}.tmp`;
    const nextVersion = this.version + 1;
    await writeFile(temporary, `${JSON.stringify({ version: nextVersion, rules: normalizedRules, channelSync: normalizedSync,
      settings: { costSyncIntervalMinutes } }, null, 2)}\n`, { mode: 0o600 });
    await rename(temporary, this.filePath);
    this.rules = normalizedRules;
    this.channelSync = normalizedSync;
    this.version = nextVersion;
    this.costSyncIntervalMinutes = costSyncIntervalMinutes;
    return this.snapshot();
  }

  async save(input, { expectedVersion = this.version } = {}) {
    return this.queueWrite(() => this.persist(input, this.channelSync, expectedVersion));
  }

  settings() {
    return { costSyncIntervalMinutes: this.costSyncIntervalMinutes,
      minCostSyncIntervalMinutes: MIN_COST_SYNC_INTERVAL_MINUTES,
      maxCostSyncIntervalMinutes: MAX_COST_SYNC_INTERVAL_MINUTES };
  }

  setCostSyncIntervalMinutes(value) {
    const intervalMinutes = requireCostSyncIntervalMinutes(value);
    return this.queueWrite(async () => {
      await this.persist(this.rules, this.channelSync, this.version, intervalMinutes);
      return this.settings();
    });
  }

  syncState(channelId, now = Date.now()) {
    const state = this.channelSync[normalizeChannelId(channelId)];
    if (!state) return normalizeSyncState();
    const result = clone(state);
    if (result.mode === 'auto' && result.status === 'synced') {
      const lastSuccess = Date.parse(result.lastSuccessAt || '');
      if (!Number.isFinite(lastSuccess) || now - lastSuccess > (this.costSyncIntervalMinutes * 2 + 5) * 60_000) result.status = 'stale';
    }
    return result;
  }

  channelPricing(channelId) {
    const id = normalizeChannelId(channelId);
    const channelRules = this.rules
      .filter((rule) => rule.channelId === id && rule.model === '*')
      .sort((left, right) => right.effectiveFrom - left.effectiveFrom || right.revision - left.revision);
    const globalRules = this.rules
      .filter((rule) => rule.channelId === '*' && rule.model === '*')
      .sort((left, right) => right.effectiveFrom - left.effectiveFrom || right.revision - left.revision);
    const rule = channelRules[0] || globalRules[0] || null;
    const modelOverrides = new Set(this.rules
      .filter((item) => item.channelId === id && item.model !== '*')
      .map((item) => item.model));
    return {
      multiplier: rule?.multiplier ?? null,
      source: channelRules[0] ? 'channel' : rule ? 'global' : 'missing',
      label: rule?.label || null,
      modelOverrides: [...modelOverrides].sort(),
      sync: this.syncState(channelId),
    };
  }

  upstreamBill(channelId, period) {
    // Daily upstream bills include probes. Rolling-hour windows stay explicitly estimated.
    if (!['today', 'yesterday'].includes(period.key)) return null;
    const state = this.syncState(channelId);
    if (!['4', '1012'].includes(String(channelId)) || state.status === 'identity_changed') return null;
    const date = new Date(Date.parse(period.from) + 8 * 3600_000).toISOString().slice(0, 10);
    const day = state.dailyCosts.find((entry) => entry.date === date);
    return day ? { ...day, observedAt: state.billingObservedAt, source: 'upstream_bill' } : null;
  }

  async setChannelMultiplier(channelId, multiplier, expectedVersion) {
    return this.queueWrite(async () => {
      const id = normalizeChannelId(channelId);
      const value = Number(multiplier);
      if (!Number.isFinite(value) || value < 0 || value > 100) {
        throw new Error('Cost multiplier must be between 0 and 100');
      }
      if (Number(expectedVersion) !== this.version) throw conflict();
      const previousTimes = this.rules
        .filter((rule) => rule.channelId === id && rule.model === '*')
        .map((rule) => rule.effectiveFrom);
      const now = Date.now() / 1000;
      const effectiveFrom = Math.max(now, previousTimes.length ? Math.max(...previousTimes) + 0.001 : now);
      const rule = normalizeRule({
        id: randomUUID(),
        channelId: id,
        model: '*',
        multiplier: value,
        effectiveFrom,
        revision: this.version + 1,
        label: 'Manual channel procurement multiplier',
      });
      const timestamp = new Date().toISOString();
      const previousState = normalizeSyncState(this.channelSync[id]);
      const nextState = {
        ...previousState,
        mode: 'manual',
        humanAnchorMultiplier: value,
        lastConfirmedMultiplier: value,
        lastConfirmedAt: timestamp,
        status: 'manual',
        errorClass: null,
        upstreamGroup: null,
        upstreamSource: null,
        observation: null,
        pending: null,
      };
      return this.persist([...this.rules, rule], { ...this.channelSync, [id]: nextState }, expectedVersion);
    });
  }

  async setChannelConfiguration(channel, { multiplier, mode }, expectedVersion) {
    return this.queueWrite(async () => {
      const id = normalizeChannelId(channel.id);
      const value = Number(multiplier);
      if (!Number.isFinite(value) || value < 0 || value > 100) {
        throw new Error('Cost multiplier must be between 0 and 100');
      }
      if (!['auto', 'manual'].includes(mode)) throw new Error('Sync mode must be auto or manual');
      if (Number(expectedVersion) !== this.version) throw conflict();

      const current = this.channelPricing(id).multiplier;
      const nextRules = [...this.rules];
      if (!sameMultiplier(current, value)) {
        const previousTimes = this.rules
          .filter((rule) => rule.channelId === id && rule.model === '*')
          .map((rule) => rule.effectiveFrom);
        const now = Date.now() / 1000;
        const effectiveFrom = Math.max(now, previousTimes.length ? Math.max(...previousTimes) + 0.001 : now);
        nextRules.push(normalizeRule({
          id: randomUUID(),
          channelId: id,
          model: '*',
          multiplier: value,
          effectiveFrom,
          revision: this.version + 1,
          label: 'Manual channel procurement multiplier',
        }));
      }

      const timestamp = new Date().toISOString();
      const previous = normalizeSyncState(this.channelSync[id]);
      const next = {
        ...previous,
        mode,
        identity: normalizeIdentity(channel),
        humanAnchorMultiplier: value,
        lastConfirmedMultiplier: value,
        lastConfirmedAt: timestamp,
        status: mode === 'auto' ? 'stale' : 'manual',
        errorClass: null,
        ...(mode === 'manual' ? { upstreamGroup: null, upstreamSource: null } : {}),
        observation: null,
        pending: null,
      };
      return this.persist(nextRules, { ...this.channelSync, [id]: next }, expectedVersion);
    });
  }

  async setChannelMode(channel, mode, expectedVersion) {
    return this.queueWrite(async () => {
      if (!['auto', 'manual'].includes(mode)) throw new Error('Sync mode must be auto or manual');
      if (Number(expectedVersion) !== this.version) throw conflict();
      const id = normalizeChannelId(channel.id);
      const pricing = this.channelPricing(id);
      if (pricing.multiplier === null) throw new Error('A current multiplier is required before enabling synchronization');
      const timestamp = new Date().toISOString();
      const previous = normalizeSyncState(this.channelSync[id]);
      const next = {
        ...previous,
        mode,
        identity: normalizeIdentity(channel),
        humanAnchorMultiplier: pricing.multiplier,
        lastConfirmedMultiplier: pricing.multiplier,
        lastConfirmedAt: previous.lastConfirmedAt || timestamp,
        status: mode === 'auto' ? 'stale' : 'manual',
        errorClass: null,
        ...(mode === 'manual' ? { upstreamGroup: null, upstreamSource: null } : {}),
        observation: null,
        pending: null,
      };
      return this.persist(this.rules, { ...this.channelSync, [id]: next }, expectedVersion);
    });
  }

  async reconcileChannels(channels) {
    return this.queueWrite(async () => {
      const identified = channels.map((channel) => ({ channel, id: normalizeChannelId(channel.id) }));
      const nextSync = Object.assign(Object.create(null), clone(this.channelSync));
      let changed = false;
      for (const { channel, id } of identified) {
        const identity = normalizeIdentity(channel);
        const previous = this.channelSync[id];
        if (!previous) {
          nextSync[id] = { ...normalizeSyncState(), identity };
          changed = true;
          continue;
        }
        // A channel that was switched to manual because its identity changed, and whose current
        // type and base URL equal what they were before that change, was never really changed
        // (an older version also compared the name). Give it its automatic sync back; the sync
        // round that called us probes it next. Records without previousIdentity are left alone.
        if (previous.status === 'identity_changed' && previous.previousIdentity
          && sameIdentity(previous.previousIdentity, identity)) {
          nextSync[id] = {
            ...normalizeSyncState(previous),
            mode: 'auto',
            identity,
            previousIdentity: null,
            status: 'stale',
            errorClass: null,
            upstreamGroup: null,
            upstreamSource: null,
            observation: null,
            pending: null,
          };
          changed = true;
          continue;
        }
        if (sameIdentity(previous.identity, identity)) {
          // Renamed only: keep the stored label current, nothing else changes.
          if (previous.identity.name !== identity.name && previous.status !== 'identity_changed') {
            nextSync[id] = { ...normalizeSyncState(previous), identity };
            changed = true;
          }
          continue;
        }
        nextSync[id] = {
          ...normalizeSyncState(previous),
          mode: 'manual',
          identity,
          previousIdentity: previous.mode === 'auto' ? previous.identity : null,
          status: previous.mode === 'auto' ? 'identity_changed' : 'manual',
          errorClass: previous.mode === 'auto' ? 'identity_changed' : null,
          upstreamGroup: null,
          upstreamSource: null,
          observation: null,
          pending: null,
        };
        changed = true;
      }
      if (!changed) return this.snapshot();
      return this.persist(this.rules, nextSync, this.version);
    });
  }

  // Drops the sync state of channels that are no longer in `channels`. Only channelSync is
  // touched: the cost rules of those channels stay, because requests logged while the channel
  // existed are still priced from them. Persists (and bumps the version) only if something went.
  async pruneChannelSync(channels) {
    return this.queueWrite(async () => {
      const present = new Set(channels.map((channel) => normalizeChannelId(channel.id)));
      const nextSync = Object.assign(Object.create(null), clone(this.channelSync));
      let removed = 0;
      for (const id of Object.keys(nextSync)) {
        if (present.has(id)) continue;
        delete nextSync[id];
        removed += 1;
      }
      if (!removed) return this.snapshot();
      return this.persist(this.rules, nextSync, this.version);
    });
  }

  async recordProbe(channel, result) {
    return this.queueWrite(async () => {
      const id = normalizeChannelId(channel.id);
      const previous = this.channelSync[id];
      if (!previous || previous.mode !== 'auto') return this.snapshot();
      const identity = normalizeIdentity(channel);
      if (!sameIdentity(previous.identity, identity)) {
        const next = {
          ...normalizeSyncState(previous),
          mode: 'manual',
          identity,
          previousIdentity: previous.identity,
          status: 'identity_changed',
          errorClass: 'identity_changed',
          upstreamGroup: null,
          upstreamSource: null,
          observation: null,
          pending: null,
        };
        return this.persist(this.rules, { ...this.channelSync, [id]: next }, this.version);
      }

      const receivedAt = new Date().toISOString();
      const next = { ...normalizeSyncState(previous), lastAttemptAt: receivedAt };
      if (result?.status !== 'ok') {
        const errorClass = String(result?.error_class || result?.errorClass || 'probe_failed');
        next.status = errorClass === 'probe_rate_limited' && next.lastSuccessAt
          ? 'synced'
          : result?.status === 'unsupported'
            ? 'unsupported'
            : errorClass === 'probe_rate_limited'
              ? 'stale'
              : 'error';
        next.errorClass = errorClass;
        return this.persist(this.rules, { ...this.channelSync, [id]: next }, this.version);
      }

      const value = Number(result.effective_rate_multiplier ?? result.effectiveRateMultiplier);
      if (!Number.isFinite(value) || value < AUTO_MIN_MULTIPLIER || value > AUTO_MAX_MULTIPLIER) {
        next.status = 'error';
        next.errorClass = 'value_out_of_band';
        return this.persist(this.rules, { ...this.channelSync, [id]: next }, this.version);
      }
      next.lastSuccessAt = receivedAt;
      next.errorClass = null;
      if (Array.isArray(result.dailyCosts)) {
        next.dailyCosts = normalizeSyncState({ dailyCosts: result.dailyCosts }).dailyCosts;
        next.billingObservedAt = result.observed_at || receivedAt;
      }
      if (Object.hasOwn(result || {}, 'upstream_group') || Object.hasOwn(result || {}, 'upstreamGroup')) {
        next.upstreamGroup = String(result.upstream_group ?? result.upstreamGroup ?? '').trim() || null;
        next.upstreamSource = String(result.source || result.upstream_source || '').trim() || null;
      } else if (Object.hasOwn(result || {}, 'source')) {
        next.upstreamGroup = null;
        next.upstreamSource = String(result.source || '').trim() || null;
      } else {
        next.upstreamGroup = null;
        next.upstreamSource = null;
      }
      next.observation = null;
      next.pending = null;

      if (sameMultiplier(value, next.lastConfirmedMultiplier)) {
        next.status = 'synced';
        return this.persist(this.rules, { ...this.channelSync, [id]: next }, this.version);
      }

      const previousTimes = this.rules
        .filter((rule) => rule.channelId === id && rule.model === '*')
        .map((rule) => rule.effectiveFrom);
      const now = Date.now() / 1000;
      const effectiveFrom = Math.max(now, previousTimes.length ? Math.max(...previousTimes) + 0.001 : now);
      const rule = normalizeRule({
        id: randomUUID(),
        channelId: id,
        model: '*',
        multiplier: value,
        effectiveFrom,
        revision: this.version + 1,
        label: 'Auto-synced upstream procurement multiplier',
      });
      next.lastConfirmedMultiplier = value;
      next.lastConfirmedAt = receivedAt;
      next.status = 'synced';
      next.observation = null;
      next.pending = null;
      return this.persist([...this.rules, rule], { ...this.channelSync, [id]: next }, this.version);
    });
  }

  // The rules in effect for one channel and model over time: [{ from, rule }] in time order, each entry holding until the next.
  // At any time the rule in effect is the one resolve() would pick among the rules started by then, and that set only grows,
  // so a sweep in start order that keeps the best rule so far finds every change. Rebuilt when the rules array is replaced.
  ruleSchedule(log) {
    const { channelId, model } = ruleTarget(log);
    if (this.scheduleRules !== this.rules) { this.scheduleRules = this.rules; this.schedules = new Map(); }
    const key = JSON.stringify([channelId, model]);
    if (this.schedules.has(key)) return this.schedules.get(key);
    const schedule = [];
    let current = null;
    for (const rule of matchingRules(this.rules, channelId, model).sort((left, right) => left.effectiveFrom - right.effectiveFrom)) {
      if (current && compareRules(rule, current) >= 0) continue;
      if (schedule.at(-1)?.from === rule.effectiveFrom) schedule.at(-1).rule = rule;
      else schedule.push({ from: rule.effectiveFrom, rule });
      current = rule;
    }
    this.schedules.set(key, schedule);
    return schedule;
  }

  // The rule in effect at `timestamp` (Unix seconds): the most specific, latest rule started by then, or null before any.
  resolveAt(log, timestamp) {
    if (!Number.isFinite(timestamp)) return null;
    const schedule = this.ruleSchedule(log);
    let low = 0, high = schedule.length;
    while (low < high) {
      const middle = (low + high) >> 1;
      if (schedule[middle].from <= timestamp) low = middle + 1; else high = middle;
    }
    return low ? schedule[low - 1].rule : null;
  }

  // Whether one rule is in effect for the whole of [from, to) (Unix seconds); `rule` is that rule (or null) when it is.
  ruleOver(log, from, to) {
    const changes = this.ruleSchedule(log).some((entry) => entry.from > from && entry.from < to);
    return { changes, rule: changes ? null : this.resolveAt(log, from) };
  }

  // The rule in effect now, ignoring when a request was made; for showing a channel's current multiplier.
  resolve(log) {
    const { channelId, model } = ruleTarget(log);
    return matchingRules(this.rules, channelId, model).sort(compareRules)[0] || null;
  }
}

function ruleTarget(log) {
  const value = log.channel ?? log.channelId;
  return { channelId: value === null || value === undefined ? null : normalizeChannelId(value),
    model: String(log.model_name ?? log.model ?? '') };
}

function matchingRules(rules, channelId, model) {
  return rules.filter((rule) => (rule.channelId === '*' || rule.channelId === channelId) && (rule.model === '*' || rule.model === model));
}

// Negative when `left` wins: more specific first (channel beats model), then the later start, then the higher revision.
function compareRules(left, right) {
  const specificity = (rule) => (rule.channelId === '*' ? 0 : 2) + (rule.model === '*' ? 0 : 1);
  return specificity(right) - specificity(left) || right.effectiveFrom - left.effectiveFrom || right.revision - left.revision;
}

// The rule in effect at `timestamp` (Unix seconds). A cost store without a rule history (a test double) has one rule for all time.
export function ruleAt(costStore, target, timestamp) {
  if (!costStore) return null;
  return (costStore.resolveAt ? costStore.resolveAt(target, timestamp) : costStore.resolve?.(target)) ?? null;
}

// Whether one rule is in effect over [from, to) (Unix seconds), and which.
export function ruleOver(costStore, target, from, to) {
  if (!costStore) return { changes: false, rule: null };
  return costStore.ruleOver ? costStore.ruleOver(target, from, to) : { changes: false, rule: costStore.resolve?.(target) ?? null };
}

export {
  AUTO_MAX_MULTIPLIER,
  AUTO_MIN_MULTIPLIER,
  DEFAULT_RULES,
  normalizeIdentity,
  normalizeRule,
};
