import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { createApp } from '../src/server.js';
import { ChannelHealthStore } from '../src/channel-health-store.js';

const SETTING = 'MOTAI_GATEWAY_UPSTREAM_AUTOMATION';
const MINUTE = 60_000;
const settle = async () => { for (let i = 0; i < 5; i++) await new Promise(setImmediate); };

// A freshly started gateway console with the real health store on a real state file: nothing is clicked or saved after start.
// lastProbeAgoMs: how long ago the newest probe of every channel started (null: never probed). The default "just now" keeps
// the one-off startup round out of the interval tests; the startup tests set it explicitly.
async function coldStart(t, { stateFile, automation, startup = false, lastProbeAgoMs = 0, channels } = {}) {
  t.mock.timers.enable({ apis: startup ? ['setInterval', 'setTimeout'] : ['setInterval'] });
  t.mock.method(console, 'info', () => {});
  const directory = await mkdtemp(path.join(tmpdir(), 'motai-cold-start-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const filePath = path.join(directory, 'channel-health.json');
  if (stateFile) await writeFile(filePath, JSON.stringify(stateFile));
  const calls = { probes: 0 };
  const channel = (id, extra = {}) => ({ id, name: id, enabled: true, adapter: 'openai',
    baseUrl: 'http://synthetic.invalid', poolId: 'pool', priority: 1, weight: 1, testModel: 'Synthetic/Model',
    models: [{ modelId: 'Synthetic/Model', capabilities: ['responses'] }], ...extra });
  const config = { gen: '1', models: [{ id: 'Synthetic/Model', vendor: 'openai' }], pools: [{ id: 'pool', name: 'Pool' }],
    aliases: [], callers: [], channels: (channels ?? [{ id: 'synthetic-channel' }]).map(({ id, ...extra }) => channel(id, extra)) };
  const lastProbe = typeof lastProbeAgoMs === 'function' ? lastProbeAgoMs : () => lastProbeAgoMs;
  const noop = { load: async () => {}, flush: async () => {} };
  const control = { load: async () => {}, config: () => config, status: async () => ({ ready: true }),
    client: { probe: async () => { calls.probes++; return { state: 'accepted' }; } } };
  const previous = process.env[SETTING];
  if (automation === undefined) delete process.env[SETTING]; else process.env[SETTING] = automation;
  let app;
  try {
    app = createApp({ gatewayControl: control,
      gatewayProjection: { ...noop, state: () => ({ requiresRebuild: false, writeBlocked: false }), catchUp: async () => {},
        latestProbeMs: (id) => { const ago = lastProbe(id); return ago === null ? null : Date.now() - ago; } },
      costStore: { ...noop, reconcileChannels: async () => {}, syncState: () => ({ mode: 'auto', status: 'known' }),
        recordProbe: async () => {}, snapshot: () => ({ version: 1, rules: [] }) },
      modelPricingStore: { ...noop, refresh: async () => ({ snapshotHash: 'synthetic' }) },
      newApiPricingSyncStore: noop, walletStore: noop, logCacheStore: noop,
      walletService: { start: async () => {}, stop: async () => {} },
      channelHealthStore: new ChannelHealthStore({ filePath }),
      costSyncIntervalMs: 24 * 60 * MINUTE, modelPricingSyncIntervalMs: 24 * 60 * MINUTE });
  } finally { if (previous === undefined) delete process.env[SETTING]; else process.env[SETTING] = previous; }
  t.after(() => app.close());
  await app.start({ host: '127.0.0.1', port: 0 });
  const tick = async (ms) => { t.mock.timers.tick(ms); await settle(); };
  return { app, calls, tick, filePath };
}

test('cold start with a saved interval probes on that interval without any save', async (t) => {
  const { calls, tick } = await coldStart(t, { stateFile: { schemaVersion: 1, settings: { probeIntervalMinutes: 15 }, channels: {} } });
  await tick(14 * MINUTE);
  assert.equal(calls.probes, 0, 'not before the saved interval');
  await tick(1 * MINUTE);
  assert.equal(calls.probes, 1, 'first probe at the saved interval');
  await tick(15 * MINUTE);
  assert.equal(calls.probes, 2);
});

test('cold start without a state file probes on the 15 minute default', async (t) => {
  const { calls, tick, filePath } = await coldStart(t, {});
  assert.ok(filePath);
  await tick(14 * MINUTE);
  assert.equal(calls.probes, 0);
  await tick(1 * MINUTE);
  assert.equal(calls.probes, 1);
  await tick(15 * MINUTE);
  assert.equal(calls.probes, 2);
});

test('cold start with a state file that holds no interval falls back to the default', async (t) => {
  const { calls, tick } = await coldStart(t, { stateFile: { schemaVersion: 1, channels: {} } });
  await tick(14 * MINUTE);
  assert.equal(calls.probes, 0);
  await tick(1 * MINUTE);
  assert.equal(calls.probes, 1);
});

test('the default interval is one shared value, 15 minutes, and the browser fallback equals it', async () => {
  const { DEFAULT_PROBE_INTERVAL_MINUTES } = await import('../src/channel-health-store.js');
  assert.equal(DEFAULT_PROBE_INTERVAL_MINUTES, 15);
  const app = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  assert.equal(Number(/^const DEFAULT_PROBE_INTERVAL_MINUTES = (\d+);/m.exec(app)?.[1]), DEFAULT_PROBE_INTERVAL_MINUTES);
  assert.doesNotMatch(app, /probeIntervalMinutes\)\s*\|\|\s*\d/, 'no second literal default in the browser');
  const panel = await readFile(new URL('../src/gateway/panel.js', import.meta.url), 'utf8');
  assert.match(panel, /probeIntervalMinutes \?\? DEFAULT_PROBE_INTERVAL_MINUTES/);
});

test('a saved interval is not touched by the new default', async (t) => {
  const { app } = await coldStart(t, { stateFile: { schemaVersion: 1, settings: { probeIntervalMinutes: 7 }, channels: {} } });
  assert.equal(app.channelHealthSettings().probeIntervalMinutes, 7);
});

test('startup: one round 30 seconds after start when the channel was never probed, then the normal interval', async (t) => {
  const { calls, tick } = await coldStart(t, { startup: true, lastProbeAgoMs: null });
  await tick(29_000);
  assert.equal(calls.probes, 0, 'not before 30 seconds');
  await tick(1_000);
  assert.equal(calls.probes, 1, 'startup round');
  await tick(15 * MINUTE);
  assert.equal(calls.probes, 2, 'the interval timer keeps running on its own schedule');
});

test('startup: a probe older than one interval also triggers the round', async (t) => {
  const { calls, tick } = await coldStart(t, { startup: true, lastProbeAgoMs: 16 * MINUTE });
  await tick(30_000);
  assert.equal(calls.probes, 1);
});

test('startup: no round when every probeable channel was probed less than one interval ago', async (t) => {
  const { calls, tick } = await coldStart(t, { startup: true, lastProbeAgoMs: 5 * MINUTE });
  await tick(60_000);
  assert.equal(calls.probes, 0, 'frequent restarts do not probe again');
  await tick(14 * MINUTE);
  assert.equal(calls.probes, 1, 'the interval timer still fires');
});

test('startup: one stale channel is enough, and the round probes every enabled channel', async (t) => {
  const { calls, tick } = await coldStart(t, { startup: true, channels: [{ id: 'fresh' }, { id: 'stale' }],
    lastProbeAgoMs: (id) => (id === 'stale' ? 40 * MINUTE : 2 * MINUTE) });
  await tick(30_000);
  assert.equal(calls.probes, 2);
});

test('startup: channels that are disabled or have nothing callable do not make a round due', async (t) => {
  const { calls, tick } = await coldStart(t, { startup: true, lastProbeAgoMs: (id) => (id === 'fresh' ? 1 * MINUTE : null),
    channels: [{ id: 'fresh' }, { id: 'off', enabled: false }, { id: 'nothing', testModel: null,
      models: [{ modelId: 'Synthetic/Model', capabilities: ['count_tokens'] }] }] });
  await tick(60_000);
  assert.equal(calls.probes, 0);
});

test('startup: a channel without a test model counts when it has a callable model', async (t) => {
  const { calls, tick } = await coldStart(t, { startup: true, lastProbeAgoMs: null, channels: [{ id: 'blank', testModel: null }] });
  await tick(30_000);
  assert.ok(calls.probes >= 1);
});

test('startup: automation disabled sends nothing even for a never-probed channel', async (t) => {
  const { calls, tick } = await coldStart(t, { startup: true, automation: 'disabled', lastProbeAgoMs: null });
  await tick(2 * MINUTE);
  assert.equal(calls.probes, 0);
});

test('cold start with automation disabled never probes, whatever the saved interval', async (t) => {
  const { calls, tick } = await coldStart(t, { automation: 'disabled',
    stateFile: { schemaVersion: 1, settings: { probeIntervalMinutes: 1 }, channels: {} } });
  await tick(30 * MINUTE);
  assert.equal(calls.probes, 0);
});

test('changing the interval after a cold start re-arms the schedule with the new interval', async (t) => {
  const { app, calls, tick } = await coldStart(t, { stateFile: { schemaVersion: 1, settings: { probeIntervalMinutes: 15 }, channels: {} } });
  const origin = `http://127.0.0.1:${app.server.address().port}`;
  const response = await fetch(`${origin}/api/settings/probes`, { method: 'PUT',
    headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify({ probeIntervalMinutes: 5 }) });
  assert.equal(response.status, 200);
  await tick(5 * MINUTE);
  assert.equal(calls.probes, 1, 'the new interval applies from the change');
});
