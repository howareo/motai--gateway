// Match the gateway contract while accepting legacy numeric IDs at the boundary.
export function normalizeChannelId(value) {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) return String(value);
  if (typeof value === 'string' && value.length <= 128 && /^[A-Za-z0-9][A-Za-z0-9_.:-]*$/.test(value)) return value;
  throw Object.assign(new Error('Invalid channel id'), { code: 'invalid_channel_id', statusCode: 400 });
}

export function normalizeChannelIdentity(channel = {}) {
  return {
    name: String(channel.name || '').trim(),
    type: Number(channel.type) || 0,
    baseUrl: String(channel.base_url ?? channel.baseUrl ?? '').trim().replace(/\/+$/, ''),
  };
}

// What the upstream account is: its channel type and base URL. The name is a display label that
// the operator can change freely, so it is stored with the identity but not compared: renaming a
// channel must not turn off its cost sync or clear its detected adapter, account link or balance.
export function sameChannelIdentity(left, right) {
  return Boolean(left && right)
    && left.type === right.type
    && left.baseUrl === right.baseUrl;
}
