import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, readdir, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
import { assertContract, channelPoolIds, validateConfig } from './schema.js';
import { GatewayError, publicGatewayStatus } from './client.js';
import { reduceChannelChange } from './channel-config.js';
import { callerHashKey as normalizeCallerHashKey, issueCallerToken, reduceCallerChange } from './caller-config.js';

const bytes = (value) => Buffer.from(`${JSON.stringify(value)}\n`);
const hash = (value) => createHash('sha256').update(value).digest('hex');
const operationIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function parse(content) {
  try { return JSON.parse(content); }
  catch { throw new GatewayError('invalid_contract', 503); }
}

async function syncDirectory(directory) {
  // shortcut: Windows has no directory fsync here; publish durability is verified on the Linux deployment host.
  if (process.platform === 'win32') return;
  const handle = await open(directory, 'r');
  try { await handle.sync(); } finally { await handle.close(); }
}

async function syncedWrite(filePath, content) {
  const handle = await open(filePath, 'wx', 0o600);
  try { await handle.writeFile(content); await handle.sync(); } finally { await handle.close(); }
}

async function immutableFile(directory, name, content) {
  const target = path.join(directory, name);
  try { await syncedWrite(target, content); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    if (!(await readFile(target)).equals(content)) throw new GatewayError('operation_conflict', 409);
  }
  return { file: name, sha256: hash(content) };
}

async function replacePointer(directory, pointer, directorySync) {
  const temporary = path.join(directory, `desired.${randomUUID()}.pending.json`);
  let renamed = false;
  try {
    await syncedWrite(temporary, bytes(pointer));
    await rename(temporary, path.join(directory, 'desired.json'));
    renamed = true;
    await directorySync(directory);
  } catch (error) {
    if (renamed) throw Object.assign(new GatewayError('desired_sync_failed', 503), { pointerRenamed: true });
    throw error;
  } finally {
    if (!renamed) await unlink(temporary).catch((error) => { if (error.code !== 'ENOENT') throw error; });
  }
}

export function publicGatewayConfig(config, hasCredential) {
  return { gen: config.gen,
    pools: config.pools.map(({ id, name }) => ({ id, name })),
    models: config.models.map(({ id, vendor }) => ({ id, vendor })),
    aliases: config.aliases.map(({ alias, model_id: modelId, pool_id: poolId }) => ({ alias, modelId, poolId })),
    channels: config.channels.map((channel) => ({ id: channel.id, name: channel.name, poolId: channel.pool_id, poolIds: [...channelPoolIds(channel)],
      poolPriorities: { ...channel.pool_priorities },
      ...(channel.adapter ? { adapter: channel.adapter } : {}),
      enabled: channel.enabled, priority: channel.priority, weight: channel.weight, baseUrl: channel.base_url,
      accountRef: channel.account_ref, hasCredential: hasCredential(channel),
      models: channel.models.map(({ model_id: modelId, upstream_model: upstreamModel, capabilities }) =>
        ({ modelId, upstreamModel, capabilities: [...capabilities] })) })),
    callers: config.callers.map((caller) => ({ id: caller.id, name: caller.name, enabled: caller.enabled,
      subjectEnabled: caller.subject_enabled, expiresAt: caller.expires_at, allowedIps: [...caller.allowed_ips],
      permissions: caller.permissions.map((permission) => ({ poolId: permission.pool_id,
        modelIds: [...permission.model_ids], channelIds: [...permission.channel_ids],
        protocols: [...permission.protocols], groups: [...permission.groups] })) })),
    affinity: { enabled: config.affinity.enabled, ttlSeconds: config.affinity.ttl_seconds },
    failurePolicy: { maxAttempts: config.failure_policy.max_attempts,
      threshold: config.failure_policy.ordinary_failure_threshold,
      windowSeconds: config.failure_policy.ordinary_failure_window_seconds,
      cooldownSeconds: config.failure_policy.cooldown_seconds } };
}

export class ConfigPublisher {
  #callerHashKey;

  constructor({ directory, client, forbiddenTargets = [], callerHashKey = null, directorySync = syncDirectory }) {
    this.directory = path.resolve(directory);
    this.client = client;
    this.forbiddenTargets = forbiddenTargets;
    this.pendingWrite = Promise.resolve();
    this.current = null;
    this.directorySync = directorySync;
    this.activationRejection = null;
    this.#callerHashKey = callerHashKey === null ? null : normalizeCallerHashKey(callerHashKey);
  }

  async loadGeneration(pointer) {
    assertContract('desired_pointer', pointer);
    const manifestBytes = await readFile(path.join(this.directory, pointer.manifest.file));
    if (hash(manifestBytes) !== pointer.manifest.sha256) throw new GatewayError('invalid_contract', 503);
    const manifest = assertContract('manifest', parse(manifestBytes));
    const configBytes = await readFile(path.join(this.directory, manifest.config.file));
    const credentialBytes = await readFile(path.join(this.directory, manifest.credentials.file));
    if (hash(configBytes) !== manifest.config.sha256 || hash(credentialBytes) !== manifest.credentials.sha256) {
      throw new GatewayError('invalid_contract', 503);
    }
    const config = parse(configBytes), credentials = parse(credentialBytes);
    const checked = validateConfig(config, { credentials, forbiddenTargets: this.forbiddenTargets });
    if (!checked.valid || pointer.gen !== manifest.gen || config.gen !== pointer.gen || credentials.gen !== pointer.gen) {
      throw new GatewayError('invalid_contract', 503);
    }
    let metadata = { formatVersion: 1, gen: pointer.gen, testModels: {} };
    try { metadata = parse(await readFile(path.join(this.directory, `gen-${pointer.gen}.panel.json`))); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (metadata.formatVersion !== 1 || metadata.gen !== pointer.gen || !metadata.testModels
      || typeof metadata.testModels !== 'object' || Array.isArray(metadata.testModels)
      || Object.keys(metadata).some((name) => !['formatVersion', 'gen', 'testModels'].includes(name))
      || Object.entries(metadata.testModels).some(([id, model]) => !config.channels.some((channel) =>
        channel.id === id && channel.models.some((entry) => entry.model_id === model)))) {
      throw new GatewayError('invalid_contract', 503);
    }
    return { pointer, manifest, config, credentials, metadata };
  }

  load() { return this.serialize(() => this.loadSerial()); }

  async loadSerial() {
    let pointerBytes;
    try { pointerBytes = await readFile(path.join(this.directory, 'desired.json')); }
    catch (error) { if (error.code === 'ENOENT') return null; throw error; }
    this.current = await this.loadGeneration(parse(pointerBytes));
    this.activationRejection = null;
    if (await this.abandoned(this.current)) await this.restoreBase(this.current);
    return this.snapshot();
  }

  async abandoned(candidate) {
    let marker;
    try { marker = parse(await readFile(path.join(this.directory, `gen-${candidate.pointer.gen}.abandoned.json`))); }
    catch (error) { if (error.code === 'ENOENT') return false; throw error; }
    const expected = { formatVersion: 1, gen: candidate.pointer.gen,
      manifestSha256: candidate.pointer.manifest.sha256, baseGen: candidate.manifest.base_gen };
    if (JSON.stringify(marker) !== JSON.stringify(expected)) throw new GatewayError('invalid_contract', 503);
    return true;
  }

  async installPointer(pointer, loaded) {
    try { await replacePointer(this.directory, pointer, this.directorySync); }
    catch (error) {
      if (!error.pointerRenamed) throw error;
      // rename already committed the visible pointer. Keep memory aligned even when its durability sync failed.
      this.current = loaded;
      this.activationRejection = null;
      return false;
    }
    this.current = loaded;
    this.activationRejection = null;
    return true;
  }

  async restoreBase(candidate) {
    const base = candidate.manifest.base_gen;
    if (base === null) throw new GatewayError('discard_initial_generation', 409);
    const content = await readFile(path.join(this.directory, `gen-${base}.manifest.json`));
    const pointer = assertContract('desired_pointer', { format_version: 1, gen: base,
      manifest: { file: `gen-${base}.manifest.json`, sha256: hash(content) } });
    const restored = await this.loadGeneration(pointer);
    if (await this.abandoned(restored)) throw new GatewayError('invalid_contract', 503);
    const status = await this.client.status();
    if (status.serving_gen !== base || status.committed_gen !== base) throw new GatewayError('discard_not_confirmed', 409);
    await this.directorySync(this.directory);
    return this.installPointer(pointer, restored);
  }

  pendingResult(code, status = null) {
    return { desiredGen: this.current.pointer.gen, desiredManifestSha256: this.current.pointer.manifest.sha256,
      committedGen: status?.committed_gen ?? null, servingGen: status?.serving_gen ?? null,
      activated: false, activationErrorCode: code, discardAvailable: false, config: this.snapshot() };
  }

  // Vendor currently configured for a model id, or null. Cheap enough to call per event: the lookup table is rebuilt only when the config object changes.
  modelVendor(modelId) {
    const config = this.current?.config;
    if (!config) return null;
    if (this.vendorIndex?.config !== config) {
      this.vendorIndex = { config, vendors: new Map((config.models ?? []).map((model) => [model.id, model.vendor ?? null])) };
    }
    return this.vendorIndex.vendors.get(modelId) ?? null;
  }

  snapshot() {
    if (!this.current) return null;
    const { config, credentials } = this.current;
    const result = publicGatewayConfig(config, (channel) => credentials.entries.some((entry) =>
      entry.credential_ref === channel.credential_ref && entry.credential_version === channel.credential_version));
    for (const channel of result.channels) channel.testModel = this.current.metadata?.testModels[channel.id] ?? null;
    return result;
  }

  // Server-side only: the committed token HMACs (primary and imported aliases) of one caller. Never put this in a response.
  callerTokenHashes(callerId) {
    const caller = this.current?.config.callers.find((row) => row.id === callerId);
    return caller ? [caller.token_hmac, ...(caller.token_hmac_aliases ?? [])] : [];
  }

  serialize(action) {
    const operation = this.pendingWrite.then(action);
    this.pendingWrite = operation.catch(() => {});
    return operation;
  }

  publish(input) { return this.serialize(() => this.publishSerial(input)); }

  change({ baseGen, operationId, change }) {
    return this.serialize(() => this.changeSerial({ baseGen, operationId, change }, 'channel'));
  }

  callerChange({ baseGen, operationId, change }) {
    return this.serialize(() => this.changeSerial({ baseGen, operationId, change }, 'caller'));
  }

  async changeSerial({ baseGen, operationId, change }, kind) {
    if (typeof operationId !== 'string' || !operationIdPattern.test(operationId)) throw new GatewayError('invalid_contract', 400);
    const digest = hash(bytes(change));
    const operationPath = path.join(this.directory, `operation-${operationId}.json`);
    let previous;
    try { previous = parse(await readFile(operationPath)); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (previous) {
      if (previous.formatVersion !== 1 || previous.operationId !== operationId || previous.digest !== digest
        || (previous.kind ?? 'channel') !== kind) {
        throw new GatewayError('operation_conflict', 409);
      }
      const candidate = await this.loadGeneration(previous.pointer);
      if (await this.abandoned(candidate)) throw new GatewayError('operation_conflict', 409);
      if (this.current?.config.gen !== previous.pointer.gen) {
        if ((this.current?.config.gen ?? null) !== candidate.manifest.base_gen) {
          // A later edit won; never recreate an entity or overwrite that edit on an old retry.
          throw new GatewayError('operation_conflict', 409);
        }
        const status = await this.client.status();
        if (status.serving_gen !== candidate.manifest.base_gen || status.committed_gen !== candidate.manifest.base_gen) {
          throw new GatewayError('stale_generation', 409);
        }
        if (!await this.installPointer(previous.pointer, candidate)) return { ...this.pendingResult('desired_sync_failed'), operationId,
          ...(kind === 'caller' ? { callerId: previous.callerId, ...(previous.tokenIssued ? { oneTimeTokenUnavailable: true } : {}) }
            : { channelId: previous.channelId, permissionChanges: previous.permissionChanges }) };
      }
      const result = { ...await this.activateCurrent(), operationId };
      if (kind === 'caller') return { ...result, callerId: previous.callerId,
        ...(previous.tokenIssued ? { oneTimeTokenUnavailable: true } : {}) };
      return { ...result, channelId: previous.channelId, permissionChanges: previous.permissionChanges };
    }
    if (!this.current) throw new GatewayError('invalid_contract', 409);
    if (baseGen !== this.current.config.gen) throw new GatewayError('stale_generation', 409);
    const issued = kind === 'caller' && ['create', 'rotate'].includes(change?.action) ? issueCallerToken(this.#callerHashKey) : null;
    const next = kind === 'caller'
      ? reduceCallerChange(this.current, change, { tokenHmac: issued?.tokenHmac })
      : reduceChannelChange(this.current, change);
    const testModels = Object.fromEntries(Object.entries(this.current.metadata?.testModels ?? {})
      .filter(([id, model]) => next.config.channels.some((channel) => channel.id === id
        && channel.models.some((entry) => entry.model_id === model))));
    if (next.metadataPatch) testModels[next.channelId] = next.metadataPatch.testModel;
    const receipt = kind === 'caller' ? { kind, callerId: next.callerId, tokenIssued: Boolean(issued) }
      : { kind, channelId: next.channelId, permissionChanges: next.permissionChanges };
    const result = await this.publishSerial({ baseGen, config: next.config, credentials: next.credentials,
      testModels, operation: { formatVersion: 1, operationId, digest, ...receipt } });
    if (kind === 'caller') return { ...result, operationId, callerId: next.callerId,
      ...(issued ? { oneTimeToken: issued.token } : {}) };
    return { ...result, operationId, channelId: next.channelId, permissionChanges: next.permissionChanges };
  }

  async publishSerial({ baseGen, config, credentials, testModels = {}, operation = null }) {
    if (this.current && await this.abandoned(this.current)) throw new GatewayError('operation_conflict', 409);
    const before = this.current?.config.gen ?? null;
    if (baseGen !== before) throw new GatewayError('stale_generation', 409);
    const status = await this.client.status();
    if (status.serving_gen !== before || status.committed_gen !== before) throw new GatewayError('stale_generation', 409);
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    let maximum = BigInt(before ?? '0');
    for (const name of await readdir(this.directory)) {
      const match = /^gen-([0-9]+)\./.exec(name);
      if (match && BigInt(match[1]) > maximum) maximum = BigInt(match[1]);
    }
    const gen = (maximum + 1n).toString();
    const nextConfig = { ...structuredClone(config), gen }, nextCredentials = { ...structuredClone(credentials), gen };
    const checked = validateConfig(nextConfig, { credentials: nextCredentials, forbiddenTargets: this.forbiddenTargets });
    if (!checked.valid) throw new GatewayError('invalid_contract', 400);
    const configRef = await immutableFile(this.directory, `gen-${gen}.config.json`, bytes(nextConfig));
    const credentialRef = await immutableFile(this.directory, `gen-${gen}.credentials.json`, bytes(nextCredentials));
    const metadata = { formatVersion: 1, gen, testModels };
    await immutableFile(this.directory, `gen-${gen}.panel.json`, bytes(metadata));
    const manifest = assertContract('manifest', { format_version: 1, gen, base_gen: before,
      config: configRef, credentials: credentialRef });
    const manifestRef = await immutableFile(this.directory, `gen-${gen}.manifest.json`, bytes(manifest));
    await this.directorySync(this.directory);
    const pointer = assertContract('desired_pointer', { format_version: 1, gen, manifest: manifestRef });
    if (operation) {
      await immutableFile(this.directory, `operation-${operation.operationId}.json`, bytes({ ...operation, pointer }));
      await this.directorySync(this.directory);
    }
    const loaded = await this.loadGeneration(pointer);
    if (!await this.installPointer(pointer, loaded)) return this.pendingResult('desired_sync_failed');
    return this.activateCurrent();
  }

  activateDesired() { return this.serialize(() => this.activateCurrent()); }

  async activateCurrent() {
    if (!this.current) throw new GatewayError('invalid_contract', 409);
    if (await this.abandoned(this.current)) throw new GatewayError('operation_conflict', 409);
    const { pointer, manifest } = this.current;
    this.activationRejection = null;
    try { await this.directorySync(this.directory); }
    catch { return this.pendingResult('desired_sync_failed'); }
    try {
      const result = await this.client.activate({ format_version: 1, gen: pointer.gen,
        manifest_sha256: pointer.manifest.sha256, base_committed_gen: manifest.base_gen });
      if (result.serving_gen !== pointer.gen || result.committed_gen !== pointer.gen || result.manifest_sha256 !== pointer.manifest.sha256) {
        throw new GatewayError('gateway_invalid_response');
      }
      return { desiredGen: pointer.gen, desiredManifestSha256: pointer.manifest.sha256,
        committedGen: result.committed_gen, servingGen: result.serving_gen,
        activated: true, discardAvailable: false, config: this.snapshot() };
    } catch (error) {
      let status = null;
      try { status = await this.client.status(); } catch { /* Persisted desired remains available for explicit reconciliation. */ }
      // Go rejects invalid_config before opening the activation transaction or publishing the serving view.
      const discardAvailable = error instanceof GatewayError && ['invalid_contract', 'invalid_config'].includes(error.code) && error.statusCode === 400
        && manifest.base_gen !== null && status?.serving_gen === manifest.base_gen && status?.committed_gen === manifest.base_gen;
      if (discardAvailable) this.activationRejection = { gen: pointer.gen, hash: pointer.manifest.sha256 };
      return { desiredGen: pointer.gen, committedGen: status?.committed_gen ?? null,
        servingGen: status?.serving_gen ?? null, activated: status?.serving_gen === pointer.gen && status?.committed_gen === pointer.gen,
        desiredManifestSha256: pointer.manifest.sha256, discardAvailable,
        activationErrorCode: error instanceof GatewayError ? error.code : 'gateway_unavailable', config: this.snapshot() };
    }
  }

  discardDesired({ gen, manifestSha256 }) { return this.serialize(async () => {
    const candidate = this.current;
    if (!candidate || gen !== candidate.pointer.gen || manifestSha256 !== candidate.pointer.manifest.sha256) {
      throw new GatewayError('stale_generation', 409);
    }
    if (candidate.manifest.base_gen === null) throw new GatewayError('discard_initial_generation', 409);
    if (!await this.abandoned(candidate)) {
      // A historical rejection is insufficient: revalidate the exact candidate immediately before abandoning it.
      const result = await this.activateCurrent();
      if (!result.discardAvailable) throw new GatewayError('discard_not_confirmed', 409);
      await immutableFile(this.directory, `gen-${gen}.abandoned.json`, bytes({ formatVersion: 1, gen,
        manifestSha256, baseGen: candidate.manifest.base_gen }));
    }
    const synced = await this.restoreBase(candidate);
    if (!synced) return { ...this.pendingResult('desired_sync_failed'), discardedGen: gen };
    const status = await this.client.status();
    return { desiredGen: this.current.pointer.gen, desiredManifestSha256: this.current.pointer.manifest.sha256,
      committedGen: status.committed_gen, servingGen: status.serving_gen, discardedGen: gen,
      activated: status.committed_gen === this.current.pointer.gen && status.serving_gen === this.current.pointer.gen,
      discardAvailable: false, config: this.snapshot() };
  }); }

  async status() {
    const status = await this.client.status(), candidate = this.current;
    const discardAvailable = Boolean(candidate && this.activationRejection?.gen === candidate.pointer.gen
      && this.activationRejection.hash === candidate.pointer.manifest.sha256 && candidate.manifest.base_gen !== null
      && status.serving_gen === candidate.manifest.base_gen && status.committed_gen === candidate.manifest.base_gen);
    return { ...publicGatewayStatus(status), desiredGen: candidate?.pointer.gen ?? null,
      desiredManifestSha256: candidate?.pointer.manifest.sha256 ?? null, discardAvailable };
  }
}
