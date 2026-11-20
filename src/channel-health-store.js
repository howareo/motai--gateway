import { randomBytes } from 'node:crypto';
import { chmod, mkdir, open, readFile, rename, stat } from 'node:fs/promises';
import path from 'node:path';
import { normalizeChannelId } from './channel-id.js';

const SCHEMA_VERSION = 1;
const DEFAULT_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_STORE_BYTES = 2 * 1024 * 1024;
const DEFAULT_PROBE_INTERVAL_MINUTES = 15;
const MIN_PROBE_INTERVAL_MINUTES = 1;
const MAX_PROBE_INTERVAL_MINUTES = 24 * 60;

function normalizeProbeIntervalMinutes(value, fallback = DEFAULT_PROBE_INTERVAL_MINUTES) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < MIN_PROBE_INTERVAL_MINUTES || parsed > MAX_PROBE_INTERVAL_MINUTES) {
    return fallback;
  }
  return parsed;
}

function requireProbeIntervalMinutes(value) {
  const normalized = normalizeProbeIntervalMinutes(value, null);
  if (normalized === null) {
    throw Object.assign(
      new Error(`Probe interval must be an integer between ${MIN_PROBE_INTERVAL_MINUTES} and ${MAX_PROBE_INTERVAL_MINUTES} minutes`),
      { code: 'invalid_probe_interval' },
    );
  }
  return normalized;
}

function text(value, maximum = 500) {
  const normalized = String(value || '').trim();
  return normalized ? normalized.slice(0, maximum) : null;
}

function normalizeEvent(input = {}) {
  const checkedAt = new Date(input.checkedAt || input.checked_at || 0);
  if (!Number.isFinite(checkedAt.getTime())) return null;
  const latency = Number(input.latencyMs ?? input.latency_ms);
  const status = Number(input.statusCode ?? input.status_code);
  return {
    checkedAt: checkedAt.toISOString(),
    success: input.success === true,
    latencyMs: Number.isFinite(latency) && latency >= 0 ? Math.round(latency) : null,
    model: text(input.model, 255),
    statusCode: Number.isInteger(status) && status >= 100 && status <= 599 ? status : null,
    errorCode: text(input.errorCode ?? input.error_code, 120),
    message: text(input.message),
  };
}

async function atomicWriteJson(filePath, value) {
  const directory = path.dirname(filePath);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700).catch(() => {});
  const temporary = path.join(directory, `.${path.basename(filePath)}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`);
  const handle = await open(temporary, 'wx', 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temporary, filePath);
  await chmod(filePath, 0o600).catch(() => {});
}

export class ChannelHealthStore {
  constructor({
    filePath,
    retentionMs = DEFAULT_RETENTION_MS,
    now = () => Date.now(),
    probeIntervalMinutes = DEFAULT_PROBE_INTERVAL_MINUTES,
  } = {}) {
    this.filePath = filePath;
    this.retentionMs = retentionMs;
    this.now = now;
    this.probeIntervalMinutes = normalizeProbeIntervalMinutes(probeIntervalMinutes);
    this.channels = Object.create(null);
    this.writeQueue = Promise.resolve();
  }

  trim(referenceTime = this.now()) {
    const cutoff = referenceTime - this.retentionMs;
    const next = Object.create(null);
    for (const [id, events] of Object.entries(this.channels)) {
      normalizeChannelId(id);
      const retained = (Array.isArray(events) ? events : [])
        .map(normalizeEvent)
        .filter((event) => event && new Date(event.checkedAt).getTime() >= cutoff)
        .sort((left, right) => left.checkedAt.localeCompare(right.checkedAt));
      if (retained.length) next[id] = retained;
    }
    this.channels = next;
  }

  async load() {
    try {
      const metadata = await stat(this.filePath);
      if (metadata.size > MAX_STORE_BYTES) throw new Error('Channel health store is too large');
      const parsed = JSON.parse(await readFile(this.filePath, 'utf8'));
      if (parsed?.schemaVersion !== SCHEMA_VERSION) throw new Error('Unsupported channel health store schema');
      this.probeIntervalMinutes = normalizeProbeIntervalMinutes(
        parsed?.settings?.probeIntervalMinutes ?? parsed?.probeIntervalMinutes,
        this.probeIntervalMinutes,
      );
      this.channels = parsed.channels && typeof parsed.channels === 'object' ? parsed.channels : {};
      this.trim();
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      this.channels = Object.create(null);
      await this.persist();
    }
    return this.snapshot();
  }

  persist() {
    return atomicWriteJson(this.filePath, {
      schemaVersion: SCHEMA_VERSION,
      settings: { probeIntervalMinutes: this.probeIntervalMinutes },
      channels: this.channels,
    });
  }

  settings() {
    return {
      probeIntervalMinutes: this.probeIntervalMinutes,
      minProbeIntervalMinutes: MIN_PROBE_INTERVAL_MINUTES,
      maxProbeIntervalMinutes: MAX_PROBE_INTERVAL_MINUTES,
    };
  }

  setProbeIntervalMinutes(value) {
    const normalized = requireProbeIntervalMinutes(value);
    const task = async () => {
      this.probeIntervalMinutes = normalized;
      await this.persist();
      return this.settings();
    };
    const result = this.writeQueue.then(task, task);
    this.writeQueue = result.catch(() => {});
    return result;
  }

  record(channelId, event) {
    const normalized = normalizeEvent(event);
    if (!normalized) throw new Error('Channel health event requires a valid timestamp');
    const id = normalizeChannelId(channelId);
    const task = async () => {
      this.channels[id] = [...(this.channels[id] || []), normalized];
      this.trim();
      await this.persist();
      return normalized;
    };
    const result = this.writeQueue.then(task, task);
    this.writeQueue = result.catch(() => {});
    return result;
  }

  channel(channelId, hours = 24) {
    const periodHours = Math.max(1, Math.min(24 * 7, Math.round(Number(hours) || 24)));
    const cutoff = this.now() - periodHours * 60 * 60 * 1000;
    const events = (this.channels[normalizeChannelId(channelId)] || [])
      .filter((event) => new Date(event.checkedAt).getTime() >= cutoff);
    const successes = events.filter((event) => event.success).length;
    const failures = events.length - successes;
    const latencies = events.map((event) => event.latencyMs).filter(Number.isFinite);
    const latest = events.at(-1) || null;
    return {
      probePeriodHours: periodHours,
      probeSuccesses: successes,
      probeFailures: failures,
      probeAttempts: events.length,
      probeSuccessRate: events.length ? successes / events.length : null,
      probeAverageLatencyMs: latencies.length
        ? Math.round(latencies.reduce((sum, value) => sum + value, 0) / latencies.length)
        : null,
      lastProbeAt: latest?.checkedAt || null,
      lastProbeSuccess: latest?.success ?? null,
      lastProbeLatencyMs: latest?.latencyMs ?? null,
      lastProbeMessage: latest?.message || null,
      recentProbes: events.slice(-60),
    };
  }

  snapshot(hours = 24) {
    return Object.fromEntries(Object.keys(this.channels).map((id) => [id, this.channel(id, hours)]));
  }
}

export {
  DEFAULT_PROBE_INTERVAL_MINUTES,
  DEFAULT_RETENTION_MS,
  MAX_PROBE_INTERVAL_MINUTES,
  MAX_STORE_BYTES,
  MIN_PROBE_INTERVAL_MINUTES,
  SCHEMA_VERSION,
  normalizeEvent,
  normalizeProbeIntervalMinutes,
};
