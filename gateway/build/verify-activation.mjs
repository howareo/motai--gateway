import assert from 'node:assert/strict';
import { createHash, createHmac } from 'node:crypto';
import { mkdir, writeFile, rename } from 'node:fs/promises';

const directory = '/config';
const hmacKey = 'synthetic-stable-hmac-key-20261027';
const management = 'synthetic-management-key-20261027';
const token = 'sk-motaicandidatelabsynthetictoken';
const hash = (data) => createHash('sha256').update(data).digest('hex');
const tokenHash = createHmac('sha256', hmacKey).update('motai-caller-v1\0').update(token).digest('hex');
const config = {
  format_version: 1, gen: '1', pools: [{ id: 'pool', name: 'Synthetic pool' }],
  models: [{ id: 'gpt-4o-mini', vendor: 'openai' }, { id: 'claude-3-5-sonnet-20240620', vendor: 'anthropic' },
    { id: 'motai-unknown-priced-model', vendor: 'openai' }],
  channels: [{ id: 'channel-openai', name: 'Synthetic OpenAI', pool_id: 'pool', enabled: true, priority: 10, weight: 0,
    base_url: 'http://fixture:9000', credential_ref: 'upstream', credential_version: '1', account_ref: null,
    models: [{ model_id: 'gpt-4o-mini', upstream_model: 'gpt-4o-mini', capabilities: ['responses', 'chat_completions'] },
      { model_id: 'motai-unknown-priced-model', upstream_model: 'gpt-4o-mini', capabilities: ['chat_completions'] }] },
  { id: 'channel-anthropic', name: 'Synthetic Anthropic', pool_id: 'pool', enabled: true, priority: 10, weight: 0,
    base_url: 'http://fixture:9000', credential_ref: 'upstream', credential_version: '1', account_ref: null,
    models: [{ model_id: 'claude-3-5-sonnet-20240620', upstream_model: 'claude-3-5-sonnet-20240620', capabilities: ['messages', 'count_tokens'] }] }],
  aliases: [], callers: [{ id: 'caller', name: 'Synthetic caller', enabled: true, subject_enabled: true, token_hmac: tokenHash,
    expires_at: null, allowed_ips: [], permissions: [{ pool_id: 'pool', model_ids: ['gpt-4o-mini', 'claude-3-5-sonnet-20240620', 'motai-unknown-priced-model'],
      channel_ids: ['channel-openai', 'channel-anthropic'], protocols: ['responses', 'chat_completions', 'messages', 'count_tokens'], groups: [] }] }],
  affinity: { enabled: true, ttl_seconds: 3600, scope_version: 1 }, failure_policy: { max_attempts: 1,
    ordinary_failure_threshold: 3, ordinary_failure_window_seconds: 300, cooldown_seconds: 60, retry_after_max_seconds: 3600 },
};
const credentials = { format_version: 1, gen: '1', entries: [{ credential_ref: 'upstream', credential_version: '1', secret: 'synthetic-upstream-key' }] };
async function publish(gen, previous, change = () => {}) {
  const nextConfig = structuredClone(config), nextCredentials = structuredClone(credentials);
  nextConfig.gen = nextCredentials.gen = gen;
  change(nextConfig, nextCredentials);
  const file = async (name, value) => {
    const data = `${JSON.stringify(value)}\n`;
    await writeFile(`${directory}/${name}`, data, { mode: 0o600 });
    return { file: name, sha256: hash(data) };
  };
  const manifest = { format_version: 1, gen, base_gen: previous,
    config: await file(`gen-${gen}.config.json`, nextConfig), credentials: await file(`gen-${gen}.credentials.json`, nextCredentials) };
  const reference = await file(`gen-${gen}.manifest.json`, manifest);
  await file('desired.pending.json', { format_version: 1, gen, manifest: reference });
  await rename(`${directory}/desired.pending.json`, `${directory}/desired.json`);
  return { format_version: 1, gen, base_committed_gen: previous, manifest_sha256: reference.sha256 };
}
if (process.argv[2] === 'prepare') {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await writeFile(`${directory}/hmac.key`, hmacKey, { mode: 0o600 });
  await writeFile(`${directory}/management.key`, management, { mode: 0o600 });
  await publish('1', null);
  console.log(JSON.stringify({ prepared: true, synthetic: true }));
} else {
  const internal = async (path, body, auth = management) => {
    const response = await fetch(`http://core:3002/internal/v1${path}`, { method: body ? 'POST' : 'GET',
      headers: { authorization: `Bearer ${auth}`, 'content-type': 'application/json' },
      body: body && JSON.stringify(body), signal: AbortSignal.timeout(10000) });
    return { status: response.status, body: await response.json() };
  };
  const passed = [];
  assert.equal((await internal('/status', null, 'wrong')).status, 401);
  const initial = await internal('/status');
  assert.equal(initial.body.committed_gen, null);
  const first = await publish('1', null);
  assert.equal((await internal('/activate', first)).status, 200);
  assert.equal((await internal('/activate', first)).status, 200);
  const status = await internal('/status');
  assert.equal(status.body.ready, true);
  assert.equal(status.body.serving_gen, '1');
  assert.equal((await fetch('http://core:3001/internal/v1/status')).status, 404);
  passed.push('management-auth-separated-listener', 'activate-idempotent-same-gen', 'committed-serving-confirmed');
  const second = await publish('2', '1', (value) => { value.callers[0].permissions = []; });
  assert.equal((await internal('/activate', { ...second, base_committed_gen: null })).status, 409);
  assert.equal((await internal('/activate', second)).status, 200);
  const denied = await fetch('http://core:3001/v1/chat/completions', { method: 'POST', headers: { authorization: `Bearer ${token}`,
    'content-type': 'application/json' }, body: JSON.stringify({ model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'LAB:denied' }] }) });
  assert.equal(denied.status, 403);
  passed.push('stale-base-conflict', 'empty-permissions-deny-without-blocking-activation');
  const third = await publish('3', '2');
  assert.equal((await internal('/activate', third)).status, 200);
  assert.equal((await internal('/status')).body.lkg_gen, '2');
  passed.push('restore-next-generation', 'lkg-reported');
  console.log(JSON.stringify({ passed, count: passed.length, servingGen: '3', synthetic: true }, null, 2));
}
