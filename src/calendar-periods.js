const HOUR_MS = 3_600_000;
const SHANGHAI_OFFSET_MS = 8 * HOUR_MS;

export function shanghaiDay(timestampMs, dayOffset = 0) {
  if (!Number.isFinite(timestampMs) || !Number.isSafeInteger(dayOffset)) throw new TypeError('Invalid calendar time');
  const date = new Date(timestampMs + SHANGHAI_OFFSET_MS);
  date.setUTCDate(date.getUTCDate() + dayOffset);
  return date.toISOString().slice(0, 10);
}

export function shanghaiDayStart(timestampMs, dayOffset = 0) {
  return Date.parse(`${shanghaiDay(timestampMs, dayOffset)}T00:00:00.000Z`) - SHANGHAI_OFFSET_MS;
}

const DEFAULT_ALL_SPAN_SECONDS = 90 * 24 * 3600;

// `allStartTimestamp` is the earliest known record (seconds); without it "all" falls back to the 90-day cap.
export function resolvePeriod({ period = '', hours = 24, nowMs = Date.now(), allStartTimestamp = null } = {}) {
  if (!Number.isFinite(nowMs)) throw new TypeError('Invalid calendar time');
  const requested = String(period || '').trim().toLowerCase();
  const endTimestamp = Math.floor(nowMs / 1000);
  if (requested === 'all') {
    const start = Number.isFinite(allStartTimestamp) && allStartTimestamp < endTimestamp
      ? Math.floor(allStartTimestamp) : endTimestamp - DEFAULT_ALL_SPAN_SECONDS;
    return { key: 'all', cacheKey: 'all', label: '全部', startTimestamp: start, endTimestamp,
      hours: Math.max(1, Math.ceil((endTimestamp - start) / 3600)) };
  }
  if (requested === 'today' || requested === 'yesterday') {
    const offset = requested === 'yesterday' ? -1 : 0;
    return {
      key: requested,
      cacheKey: `${requested}-Asia-Shanghai-${shanghaiDay(nowMs, offset)}`,
      label: offset ? '昨天' : '今天',
      startTimestamp: shanghaiDayStart(nowMs, offset) / 1000,
      endTimestamp: offset ? shanghaiDayStart(nowMs) / 1000 : endTimestamp,
      hours: 24,
    };
  }
  const parsed = Number(hours || 24);
  const bounded = Number.isFinite(parsed) ? Math.max(1, Math.min(24 * 90, Math.round(parsed))) : 24;
  return { key: `hours-${bounded}`, cacheKey: `hours-${bounded}`, label: `${bounded} 小时`,
    startTimestamp: endTimestamp - bounded * 3600, endTimestamp, hours: bounded };
}

export function gatewayPeriod(options = {}) {
  const period = resolvePeriod({ period: 'today', ...options });
  return { ...period, from: new Date(period.startTimestamp * 1000).toISOString(),
    to: new Date(period.endTimestamp * 1000).toISOString(), timezone: 'Asia/Shanghai' };
}
