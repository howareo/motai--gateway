import { createCipheriv, createDecipheriv, hkdfSync, randomBytes, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { atomicWriteJson } from '../wallet-store.js';
import { callerHashKey, callerHashKeyFromEnvironment, hashCallerToken } from './caller-config.js';

const SCHEMA_VERSION = 1;
const KEEP_PER_CALLER = 2;
const MAX_FILE_BYTES = 4 * 1024 * 1024;
const HKDF_INFO = 'motai-caller-vault-v1';
const TAG_BYTES = 16;
const IV_BYTES = 12;

function unavailable() {
  return Object.assign(new Error('调用令牌密钥库不可用'), { code: 'caller_key_vault_unavailable', statusCode: 503 });
}

function sameHex(left, right) {
  const a = Buffer.from(String(left), 'hex'), b = Buffer.from(String(right), 'hex');
  return a.length > 0 && a.length === b.length && timingSafeEqual(a, b);
}

// Encrypted store of the plain caller keys, so the console can show them again (same trade-off as New API).
// The gateway never reads this file: it only authenticates against token_hmac in the published config.
export class CallerKeyVault {
  #hashKey = null;
  #cipherKey = null;
  #queue = Promise.resolve();

  constructor({ filePath, hashKey = null }) {
    this.filePath = path.resolve(filePath);
    try {
      if (hashKey !== null && hashKey !== undefined) {
        this.#hashKey = callerHashKey(hashKey);
        this.#cipherKey = Buffer.from(hkdfSync('sha256', this.#hashKey, Buffer.alloc(0), HKDF_INFO, 32));
      }
    } catch {
      this.#hashKey = null; this.#cipherKey = null;
    }
  }

  get available() { return this.#cipherKey !== null; }

  // Read errors and damaged content count as an empty vault; they must never reach startup or publish flows.
  async #read() {
    const callers = new Map();
    let parsed;
    try {
      const bytes = await readFile(this.filePath);
      if (bytes.length > MAX_FILE_BYTES) return callers;
      parsed = JSON.parse(bytes.toString('utf8'));
    } catch { return callers; }
    if (!parsed || typeof parsed !== 'object' || parsed.schemaVersion !== SCHEMA_VERSION
      || !parsed.callers || typeof parsed.callers !== 'object' || Array.isArray(parsed.callers)) return callers;
    for (const [callerId, rows] of Object.entries(parsed.callers)) {
      if (!Array.isArray(rows)) continue;
      const valid = rows.filter((row) => row && typeof row === 'object' && typeof row.iv === 'string'
        && typeof row.tag === 'string' && typeof row.data === 'string');
      if (valid.length) callers.set(callerId, valid);
    }
    return callers;
  }

  #seal(token) {
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv('aes-256-gcm', this.#cipherKey, iv, { authTagLength: TAG_BYTES });
    const data = Buffer.concat([cipher.update(token, 'utf8'), cipher.final()]);
    return { iv: iv.toString('base64url'), tag: cipher.getAuthTag().toString('base64url'),
      data: data.toString('base64url'), savedAt: new Date().toISOString() };
  }

  #open(row) {
    try {
      const iv = Buffer.from(row.iv, 'base64url'), tag = Buffer.from(row.tag, 'base64url');
      if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES) return null;
      const decipher = createDecipheriv('aes-256-gcm', this.#cipherKey, iv, { authTagLength: TAG_BYTES });
      decipher.setAuthTag(tag);
      return Buffer.concat([decipher.update(Buffer.from(row.data, 'base64url')), decipher.final()]).toString('utf8');
    } catch { return null; }
  }

  #tokens(rows) { return (rows ?? []).map((row) => this.#open(row)).filter((token) => token !== null); }

  async #write(callers) {
    await atomicWriteJson(this.filePath, { schemaVersion: SCHEMA_VERSION, callers: Object.fromEntries(callers) });
  }

  #exclusive(action) {
    const operation = this.#queue.then(action);
    this.#queue = operation.catch(() => {});
    return operation;
  }

  // Newest first. Rows that no longer decrypt (for example after the hash key changed) are skipped.
  async tokensFor(callerId) {
    if (!this.available) throw unavailable();
    return this.#tokens((await this.#read()).get(String(callerId)));
  }

  save(callerId, token) {
    if (!this.available) return Promise.reject(unavailable());
    if (typeof token !== 'string' || !token) return Promise.reject(Object.assign(new Error('密钥无效'), { code: 'invalid_caller_key', statusCode: 400 }));
    return this.#exclusive(async () => {
      const callers = await this.#read(), id = String(callerId);
      const kept = this.#tokens(callers.get(id)).filter((existing) => existing !== token);
      const rows = [token, ...kept].slice(0, KEEP_PER_CALLER);
      // Rows are re-sealed (fresh IV each time) so the stored list is always readable with the current key.
      callers.set(id, rows.map((value) => this.#seal(value)));
      await this.#write(callers);
    });
  }

  remove(callerId) {
    if (!this.available) return Promise.reject(unavailable());
    return this.#exclusive(async () => {
      const callers = await this.#read();
      if (callers.delete(String(callerId))) await this.#write(callers);
    });
  }

  // The newest stored key whose HMAC equals one of `hashes` (the caller's current token_hmac and aliases).
  async currentToken(callerId, hashes) {
    for (const token of await this.tokensFor(callerId)) {
      if (this.#matches(token, hashes)) return token;
    }
    return null;
  }

  // True when `token` authenticates against one of `hashes`; nothing is stored or returned.
  verify(token, hashes) {
    if (!this.available) throw unavailable();
    return this.#matches(token, hashes);
  }

  // Caller ids that have a stored key matching their current hashes. One file read for the whole config.
  async storedCallerIds(hashesByCaller) {
    if (!this.available) return new Set();
    const callers = await this.#read(), result = new Set();
    for (const [callerId, hashes] of hashesByCaller) {
      if (this.#tokens(callers.get(callerId)).some((token) => this.#matches(token, hashes))) result.add(callerId);
    }
    return result;
  }

  #matches(token, hashes) {
    if (!Array.isArray(hashes) || !hashes.length) return false;
    const actual = hashCallerToken(this.#hashKey, token);
    return hashes.some((hash) => sameHex(actual, hash));
  }
}

export function callerKeyVaultFromEnvironment(env = process.env, { defaultCredentialsFile } = {}) {
  const credentials = env.WALLET_CREDENTIALS_FILE || defaultCredentialsFile;
  const filePath = env.CALLER_KEYS_FILE || (credentials ? path.join(path.dirname(credentials), 'caller-keys.json') : null);
  if (!filePath) return null;
  return new CallerKeyVault({ filePath, hashKey: callerHashKeyFromEnvironment(env) });
}
