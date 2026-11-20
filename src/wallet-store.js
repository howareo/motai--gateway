import { createHash, randomBytes } from 'node:crypto';
import { chmod, mkdir, open, readFile, rename, stat } from 'node:fs/promises';
import path from 'node:path';
import { normalizeChannelId, normalizeChannelIdentity as normalizeIdentity, sameChannelIdentity as sameIdentity } from './channel-id.js';

const SCHEMA_VERSION = 1;
const MAX_STORE_BYTES = 256 * 1024;
const ADAPTERS = new Set(['auto', 'newapi', 'sub2', 'rightcode', 'none']);

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function normalizeOrigin(value) {
  const url = new URL(String(value || ''));
  if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443')) {
    throw new Error('Wallet origin must use HTTPS on port 443');
  }
  return url.origin;
}

function finiteOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function normalizeChannelState(input = {}) {
  const adapter = ADAPTERS.has(input.adapter) ? input.adapter : 'auto';
  const detectedAdapter = ADAPTERS.has(input.detectedAdapter) ? input.detectedAdapter : null;
  return {
    identity: normalizeIdentity(input.identity || {}),
    adapter,
    detectedAdapter: detectedAdapter === 'auto' ? null : detectedAdapter,
    accountKey: input.accountKey ? String(input.accountKey) : null,
    status: String(input.status || 'unknown'),
    balance: finiteOrNull(input.balance),
    currency: input.currency ? String(input.currency).toUpperCase() : null,
    fetchedAt: input.fetchedAt ? String(input.fetchedAt) : null,
    lastAttemptAt: input.lastAttemptAt ? String(input.lastAttemptAt) : null,
    errorClass: input.errorClass ? String(input.errorClass) : null,
    failureCount: Math.max(0, Number(input.failureCount) || 0),
    nextAttemptAt: input.nextAttemptAt ? String(input.nextAttemptAt) : null,
  };
}

function normalizeCredential(input = {}) {
  const adapter = ['newapi', 'sub2', 'rightcode'].includes(input.adapter) ? input.adapter : null;
  if (!adapter) return null;
  return {
    adapter,
    origin: normalizeOrigin(input.origin),
    current: String(input.current || ''),
    previous: input.previous ? String(input.previous) : null,
    accessToken: input.accessToken ? String(input.accessToken) : null,
    accessExpiresAt: input.accessExpiresAt ? String(input.accessExpiresAt) : null,
    pendingRefresh: Boolean(input.pendingRefresh),
    updatedAt: input.updatedAt ? String(input.updatedAt) : null,
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
  const directoryHandle = await open(directory, 'r').catch(() => null);
  if (directoryHandle) {
    try {
      await directoryHandle.sync().catch((error) => {
        if (error.code !== 'EINVAL' && error.code !== 'EPERM') throw error;
      });
    } finally {
      await directoryHandle.close();
    }
  }
}

async function readStoreJson(filePath) {
  const metadata = await stat(filePath);
  if (metadata.size > MAX_STORE_BYTES) throw new Error('Wallet store is too large');
  const parsed = JSON.parse(await readFile(filePath, 'utf8'));
  if (parsed?.schemaVersion !== SCHEMA_VERSION) throw new Error('Unsupported wallet store schema');
  return parsed;
}

function accountKey(adapter, origin, credential) {
  return createHash('sha256').update(`${adapter}\0${normalizeOrigin(origin)}\0${credential}`).digest('hex');
}

export class WalletStore {
  constructor({ statePath, credentialsPath }) {
    this.statePath = statePath;
    this.credentialsPath = credentialsPath;
    this.channels = Object.create(null);
    this.credentials = {};
    this.writeQueue = Promise.resolve();
  }

  queueWrite(task) {
    const result = this.writeQueue.then(task, task);
    this.writeQueue = result.catch(() => {});
    return result;
  }

  async load() {
    try {
      const parsed = await readStoreJson(this.statePath);
      this.channels = Object.assign(Object.create(null), Object.fromEntries(Object.entries(parsed.channels || {})
        .map(([id, state]) => [normalizeChannelId(id), normalizeChannelState(state)])));
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      this.channels = Object.create(null);
      await this.persistState();
    }
    try {
      const parsed = await readStoreJson(this.credentialsPath);
      this.credentials = Object.fromEntries(Object.entries(parsed.accounts || {})
        .map(([key, credential]) => [String(key), normalizeCredential(credential)])
        .filter(([, credential]) => credential?.current));
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      this.credentials = {};
      await this.persistCredentials();
    }
    return this.snapshot();
  }

  persistState() {
    return atomicWriteJson(this.statePath, { schemaVersion: SCHEMA_VERSION, channels: this.channels });
  }

  persistCredentials() {
    return atomicWriteJson(this.credentialsPath, { schemaVersion: SCHEMA_VERSION, accounts: this.credentials });
  }

  snapshot() {
    return {
      schemaVersion: SCHEMA_VERSION,
      channels: Object.fromEntries(Object.entries(this.channels).map(([id, state]) => [id, this.publicState(id, state)])),
    };
  }

  publicState(channelId, providedState = null) {
    const id = normalizeChannelId(channelId);
    const state = normalizeChannelState(providedState || this.channels[id] || {});
    return {
      adapter: state.adapter,
      detectedAdapter: state.detectedAdapter,
      configured: Boolean(state.accountKey && this.credentials[state.accountKey]?.current),
      status: state.status,
      balance: state.balance,
      currency: state.currency,
      fetchedAt: state.fetchedAt,
      lastAttemptAt: state.lastAttemptAt,
      errorClass: state.errorClass,
    };
  }

  state(channelId) {
    return clone(normalizeChannelState(this.channels[normalizeChannelId(channelId)] || {}));
  }

  credential(account) {
    return account ? clone(this.credentials[String(account)] || null) : null;
  }

  async reconcileChannels(channels) {
    return this.queueWrite(async () => {
      const identified = channels.map((channel) => ({ channel, id: normalizeChannelId(channel.id) }));
      const activeIds = new Set(identified.map(({ id }) => id));
      let changed = false;
      const next = Object.create(null);
      for (const { channel, id } of identified) {
        const identity = normalizeIdentity(channel);
        const previous = normalizeChannelState(this.channels[id] || { identity });
        if (!sameIdentity(previous.identity, identity)) {
          next[id] = {
            ...previous,
            identity,
            detectedAdapter: null,
            accountKey: null,
            status: 'unknown',
            balance: null,
            currency: null,
            fetchedAt: null,
            errorClass: 'identity_changed',
          };
          changed = true;
        } else {
          // Same account (a rename at most): keep every observation, refresh the stored label.
          next[id] = { ...previous, identity };
          if (!this.channels[id] || this.channels[id].identity?.name !== identity.name) changed = true;
        }
      }
      if (Object.keys(this.channels).some((id) => !activeIds.has(id))) changed = true;
      this.channels = next;
      const usedAccounts = new Set(Object.values(this.channels).map((state) => state.accountKey).filter(Boolean));
      const orphanedAccounts = Object.keys(this.credentials).filter((key) => !usedAccounts.has(key));
      if (orphanedAccounts.length) {
        for (const key of orphanedAccounts) delete this.credentials[key];
        await this.persistCredentials();
      }
      if (changed) await this.persistState();
      return this.snapshot();
    });
  }

  async configure(channel, { adapter, credential = '', origin = null }) {
    return this.queueWrite(async () => {
      if (!ADAPTERS.has(adapter)) throw new Error('Unsupported wallet adapter');
      if (String(credential).length > 8192) throw new Error('Wallet credential is too large');
      const id = normalizeChannelId(channel.id);
      const previous = normalizeChannelState(this.channels[id] || { identity: normalizeIdentity(channel) });
      let key = null;
      if (['newapi', 'sub2', 'rightcode'].includes(adapter)) {
        const saved = this.credentials[previous.accountKey];
        const targetOrigin = origin ? normalizeOrigin(origin) : null;
        if (credential) {
          if (!targetOrigin) throw new Error('Wallet origin is required');
          // Reuse only an explicitly supplied credential, including a token already rotated by this store.
          const existing = Object.entries(this.credentials).find(([, entry]) => entry.adapter === adapter
            && entry.origin === targetOrigin && [entry.current, entry.previous].includes(credential));
          key = existing?.[0] ?? accountKey(adapter, targetOrigin, credential);
          if (!existing) {
            this.credentials[key] = normalizeCredential({
              adapter,
              origin: targetOrigin,
              current: credential,
              updatedAt: new Date().toISOString(),
            });
            await this.persistCredentials();
          }
        } else if (saved?.current && saved.adapter === adapter && sameIdentity(previous.identity, normalizeIdentity(channel))
          && (!targetOrigin || saved.origin === targetOrigin)) {
          key = previous.accountKey;
        } else if (adapter !== 'newapi') {
          throw new Error('Wallet credential is required');
        }
      }
      this.channels[id] = normalizeChannelState({
        ...previous,
        identity: normalizeIdentity(channel),
        adapter,
        detectedAdapter: adapter === 'auto' ? previous.detectedAdapter : adapter,
        accountKey: key,
        balance: key === previous.accountKey ? previous.balance : null,
        currency: key === previous.accountKey ? previous.currency : null,
        fetchedAt: key === previous.accountKey ? previous.fetchedAt : null,
        status: adapter === 'none' ? 'unsupported' : 'stale',
        errorClass: null,
        lastAttemptAt: null,
        nextAttemptAt: null,
        failureCount: 0,
      });
      const usedAccounts = new Set(Object.values(this.channels).map((state) => state.accountKey).filter(Boolean));
      const orphanedAccounts = Object.keys(this.credentials).filter((account) => !usedAccounts.has(account));
      if (orphanedAccounts.length) {
        for (const account of orphanedAccounts) delete this.credentials[account];
        await this.persistCredentials();
      }
      await this.persistState();
      return this.publicState(id);
    });
  }

  async clear(channelId) {
    return this.queueWrite(async () => {
      const id = normalizeChannelId(channelId);
      const previous = normalizeChannelState(this.channels[id] || {});
      const oldKey = previous.accountKey;
      this.channels[id] = normalizeChannelState({
        identity: previous.identity,
        adapter: 'auto',
        status: 'unknown',
      });
      if (oldKey && !Object.entries(this.channels).some(([otherId, state]) => otherId !== id && state.accountKey === oldKey)) {
        delete this.credentials[oldKey];
        await this.persistCredentials();
      }
      await this.persistState();
      return this.publicState(id);
    });
  }

  async updateChannel(channelId, patch) {
    return this.queueWrite(async () => {
      const id = normalizeChannelId(channelId);
      this.channels[id] = normalizeChannelState({ ...this.channels[id], ...patch });
      await this.persistState();
      return this.publicState(id);
    });
  }

  async updateAccount(key, patch) {
    return this.queueWrite(async () => {
      const previous = this.credentials[String(key)];
      if (!previous) throw new Error('Wallet credential is not configured');
      this.credentials[String(key)] = normalizeCredential({ ...previous, ...patch, updatedAt: new Date().toISOString() });
      await this.persistCredentials();
    });
  }
}

export { ADAPTERS, MAX_STORE_BYTES, SCHEMA_VERSION, accountKey, atomicWriteJson, normalizeIdentity, normalizeOrigin };
