import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { CallerKeyVault, callerKeyVaultFromEnvironment } from '../src/gateway/caller-key-vault.js';
import { hashCallerToken } from '../src/gateway/caller-config.js';

const KEY = Buffer.from('SYNTHETIC-VAULT-KEY-0123456789abcdef-xyz');
const OTHER_KEY = Buffer.from('ANOTHER-SYNTHETIC-KEY-0123456789abcdef-xyz');
const TOKEN_A = 'sk-test-vault-AAAAAAAAAAAAAAAAAAAAAAAA', TOKEN_B = 'sk-test-vault-BBBBBBBBBBBBBBBBBBBBBBBB', TOKEN_C = 'sk-test-vault-CCCCCCCCCCCCCCCCCCCCCCCC';

async function fixture(t, ...given) {
  // An explicit undefined must reach the vault unchanged, so a default parameter cannot be used here.
  const hashKey = given.length ? given[0] : KEY;
  const directory = await mkdtemp(path.join(tmpdir(), 'motai-vault-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const filePath = path.join(directory, 'state', 'caller-keys.json');
  return { directory, filePath, vault: new CallerKeyVault({ filePath, hashKey }) };
}

test('keys round-trip through AES-GCM, the file holds only ciphertext and the documented shape', async (t) => {
  const { vault, filePath } = await fixture(t);
  await vault.save('caller-1', TOKEN_A);
  assert.deepEqual(await vault.tokensFor('caller-1'), [TOKEN_A]);
  assert.deepEqual(await vault.tokensFor('unknown'), []);
  const text = await readFile(filePath, 'utf8');
  assert.equal(text.includes(TOKEN_A), false);
  assert.equal(text.includes(KEY.toString()), false);
  const file = JSON.parse(text);
  assert.equal(file.schemaVersion, 1);
  const [row] = file.callers['caller-1'];
  assert.deepEqual(Object.keys(row).sort(), ['data', 'iv', 'savedAt', 'tag']);
  assert.equal(Buffer.from(row.iv, 'base64url').length, 12);
  assert.equal(Buffer.from(row.tag, 'base64url').length, 16);
  assert.match(row.iv + row.tag + row.data, /^[A-Za-z0-9_-]+$/);
  assert.notEqual(Number.isNaN(Date.parse(row.savedAt)), true);
});

test('each caller keeps the newest two keys, newest first, without duplicating a repeated key', async (t) => {
  const { vault } = await fixture(t);
  await vault.save('caller-1', TOKEN_A);
  await vault.save('caller-1', TOKEN_A);
  assert.deepEqual(await vault.tokensFor('caller-1'), [TOKEN_A]);
  await vault.save('caller-1', TOKEN_B);
  assert.deepEqual(await vault.tokensFor('caller-1'), [TOKEN_B, TOKEN_A]);
  await vault.save('caller-1', TOKEN_C);
  assert.deepEqual(await vault.tokensFor('caller-1'), [TOKEN_C, TOKEN_B]);
  await vault.save('caller-1', TOKEN_B);
  assert.deepEqual(await vault.tokensFor('caller-1'), [TOKEN_B, TOKEN_C]);
  await vault.save('caller-2', TOKEN_A);
  assert.deepEqual(await vault.tokensFor('caller-2'), [TOKEN_A]);
});

test('every stored row uses its own IV', async (t) => {
  const { vault, filePath } = await fixture(t);
  await vault.save('caller-1', TOKEN_A); await vault.save('caller-1', TOKEN_B);
  const rows = JSON.parse(await readFile(filePath, 'utf8')).callers['caller-1'];
  assert.equal(new Set(rows.map((row) => row.iv)).size, 2);
});

test('state directory is 0700 and the vault file 0600', { skip: process.platform === 'win32' }, async (t) => {
  const { vault, filePath } = await fixture(t);
  await vault.save('caller-1', TOKEN_A);
  assert.equal((await stat(filePath)).mode & 0o777, 0o600);
  assert.equal((await stat(path.dirname(filePath))).mode & 0o777, 0o700);
});

test('a missing, damaged or foreign file reads as an empty vault and the next save repairs it', async (t) => {
  const { vault, filePath } = await fixture(t);
  assert.deepEqual(await vault.tokensFor('caller-1'), []);
  await vault.save('caller-1', TOKEN_A);
  for (const content of ['not json {', '', '[]', JSON.stringify({ schemaVersion: 2, callers: {} }),
    JSON.stringify({ schemaVersion: 1, callers: [] }), JSON.stringify({ schemaVersion: 1, callers: { 'caller-1': 'bad' } }),
    JSON.stringify({ schemaVersion: 1, callers: { 'caller-1': [{ iv: 1 }, null] } })]) {
    await writeFile(filePath, content);
    assert.deepEqual(await vault.tokensFor('caller-1'), [], content);
    assert.equal((await vault.storedCallerIds(new Map([['caller-1', ['a'.repeat(64)]]]))).size, 0);
  }
  await vault.save('caller-1', TOKEN_B);
  assert.deepEqual(await vault.tokensFor('caller-1'), [TOKEN_B]);
});

test('rows that fail authentication are skipped: another hash key, tampered data, tampered tag', async (t) => {
  const { vault, filePath } = await fixture(t);
  await vault.save('caller-1', TOKEN_A);
  assert.deepEqual(await new CallerKeyVault({ filePath, hashKey: OTHER_KEY }).tokensFor('caller-1'), []);
  const file = JSON.parse(await readFile(filePath, 'utf8'));
  const row = file.callers['caller-1'][0];
  const flipped = Buffer.from(row.data, 'base64url'); flipped[0] ^= 1;
  await writeFile(filePath, JSON.stringify({ ...file, callers: { 'caller-1': [{ ...row, data: flipped.toString('base64url') }] } }));
  assert.deepEqual(await vault.tokensFor('caller-1'), []);
  await writeFile(filePath, JSON.stringify({ ...file, callers: { 'caller-1': [{ ...row, tag: Buffer.alloc(16).toString('base64url') }] } }));
  assert.deepEqual(await vault.tokensFor('caller-1'), []);
  await writeFile(filePath, JSON.stringify({ ...file, callers: { 'caller-1': [{ ...row, iv: 'AA' }] } }));
  assert.deepEqual(await vault.tokensFor('caller-1'), []);
});

test('without a usable hash key the vault is unavailable and never touches the disk', async (t) => {
  for (const hashKey of [null, undefined, '', 'short', Buffer.alloc(31), 12]) {
    const { vault, filePath } = await fixture(t, hashKey);
    assert.equal(vault.available, false, String(hashKey));
    for (const action of [() => vault.save('caller-1', TOKEN_A), () => vault.tokensFor('caller-1'), () => vault.remove('caller-1'),
      () => vault.currentToken('caller-1', ['a'.repeat(64)])]) {
      await assert.rejects(action(), { code: 'caller_key_vault_unavailable', statusCode: 503 });
    }
    assert.throws(() => vault.verify(TOKEN_A, ['a'.repeat(64)]), { code: 'caller_key_vault_unavailable' });
    assert.equal((await vault.storedCallerIds(new Map([['caller-1', ['a'.repeat(64)]]]))).size, 0);
    await assert.rejects(stat(filePath), { code: 'ENOENT' });
  }
});

test('save rejects an empty or non-string key', async (t) => {
  const { vault } = await fixture(t);
  for (const value of ['', null, undefined, 5]) await assert.rejects(vault.save('caller-1', value), { code: 'invalid_caller_key' });
});

test('remove drops one caller and keeps the rest', async (t) => {
  const { vault } = await fixture(t);
  await vault.save('caller-1', TOKEN_A); await vault.save('caller-2', TOKEN_B);
  await vault.remove('caller-1'); await vault.remove('never-stored');
  assert.deepEqual(await vault.tokensFor('caller-1'), []);
  assert.deepEqual(await vault.tokensFor('caller-2'), [TOKEN_B]);
});

test('concurrent saves are serialized and none is lost; odd caller ids stay plain data', async (t) => {
  const { vault } = await fixture(t);
  const ids = ['a', 'b', 'c', 'd', 'e', '__proto__'];
  await Promise.all(ids.map((id, index) => vault.save(id, `sk-test-concurrent-${index}`)));
  for (const [index, id] of ids.entries()) assert.deepEqual(await vault.tokensFor(id), [`sk-test-concurrent-${index}`], id);
  assert.equal({}.iv, undefined);
});

test('matching uses the caller HMAC list, including imported aliases, and never the key text', async (t) => {
  const { vault } = await fixture(t);
  const hashA = hashCallerToken(KEY, TOKEN_A), hashB = hashCallerToken(KEY, TOKEN_B);
  await vault.save('caller-1', TOKEN_A); await vault.save('caller-1', TOKEN_B);
  assert.equal(await vault.currentToken('caller-1', [hashA]), TOKEN_A, 'older key still wins when it is the published one');
  assert.equal(await vault.currentToken('caller-1', [hashB]), TOKEN_B);
  assert.equal(await vault.currentToken('caller-1', ['c'.repeat(64), hashA]), TOKEN_A, 'alias position');
  assert.equal(await vault.currentToken('caller-1', ['c'.repeat(64)]), null);
  assert.equal(await vault.currentToken('caller-1', []), null);
  assert.equal(await vault.currentToken('caller-1', undefined), null);
  assert.equal(vault.verify(TOKEN_C, [hashA, hashB]), false);
  assert.equal(vault.verify(TOKEN_B, [hashA, hashB]), true);
  assert.equal(vault.verify(TOKEN_B, ['not-hex', 'zz']), false);
  const stored = await vault.storedCallerIds(new Map([['caller-1', [hashB]], ['caller-2', [hashA]], ['caller-3', []]]));
  assert.deepEqual([...stored], ['caller-1']);
});

test('environment: CALLER_KEYS_FILE wins, otherwise the file sits next to the wallet credentials, and the hash key comes from the environment', async () => {
  const env = { MOTAI_CALLER_HASH_KEY: KEY.toString(), WALLET_CREDENTIALS_FILE: path.join(path.sep, 'state', 'wallet-credentials.json') };
  assert.equal(callerKeyVaultFromEnvironment(env).filePath, path.resolve(path.sep, 'state', 'caller-keys.json'));
  assert.equal(callerKeyVaultFromEnvironment({ ...env, CALLER_KEYS_FILE: path.join(path.sep, 'x', 'keys.json') }).filePath, path.resolve(path.sep, 'x', 'keys.json'));
  assert.equal(callerKeyVaultFromEnvironment({ MOTAI_CALLER_HASH_KEY: KEY.toString() },
    { defaultCredentialsFile: path.join(path.sep, 'data', 'wallet-credentials.json') }).filePath, path.resolve(path.sep, 'data', 'caller-keys.json'));
  assert.equal(callerKeyVaultFromEnvironment(env).available, true);
  assert.equal(callerKeyVaultFromEnvironment({ WALLET_CREDENTIALS_FILE: env.WALLET_CREDENTIALS_FILE }).available, false);
  assert.equal(callerKeyVaultFromEnvironment({}), null);
});
