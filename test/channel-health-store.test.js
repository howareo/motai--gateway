import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ChannelHealthStore } from '../src/channel-health-store.js';

test('persists normalized probe history and trims expired events', async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'channel-health-'));
  const filePath = path.join(directory, 'health.json');
  const current = Date.parse('2026-07-29T00:00:00.000Z');
  t.after(() => rm(directory, { recursive: true, force: true }));

  const store = new ChannelHealthStore({ filePath, retentionMs: 7 * 24 * 60 * 60 * 1000, now: () => current });
  await store.load();
  await store.record(4, { checkedAt: '2026-07-21T23:59:59.000Z', success: false, message: 'expired' });
  await store.record(4, { checkedAt: '2026-07-28T23:30:00.000Z', success: true, latencyMs: 120.4, model: 'gpt-5.6-sol' });
  await store.record(4, { checkedAt: '2026-07-28T23:45:00.000Z', success: false, statusCode: 502, message: 'upstream failed' });

  const reloaded = new ChannelHealthStore({ filePath, now: () => current });
  await reloaded.load();
  assert.deepEqual(reloaded.channel(4, 24), {
    probePeriodHours: 24,
    probeSuccesses: 1,
    probeFailures: 1,
    probeAttempts: 2,
    probeSuccessRate: 0.5,
    probeAverageLatencyMs: 120,
    lastProbeAt: '2026-07-28T23:45:00.000Z',
    lastProbeSuccess: false,
    lastProbeLatencyMs: null,
    lastProbeMessage: 'upstream failed',
    recentProbes: [
      {
        checkedAt: '2026-07-28T23:30:00.000Z',
        success: true,
        latencyMs: 120,
        model: 'gpt-5.6-sol',
        statusCode: null,
        errorCode: null,
        message: null,
      },
      {
        checkedAt: '2026-07-28T23:45:00.000Z',
        success: false,
        latencyMs: null,
        model: null,
        statusCode: 502,
        errorCode: null,
        message: 'upstream failed',
      },
    ],
  });
});

test('persists a configurable probe interval with bounded values', async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'channel-health-settings-'));
  const filePath = path.join(directory, 'health.json');
  t.after(() => rm(directory, { recursive: true, force: true }));

  const store = new ChannelHealthStore({ filePath });
  await store.load();
  const updated = await store.setProbeIntervalMinutes(15);
  assert.deepEqual(updated, {
    probeIntervalMinutes: 15,
    minProbeIntervalMinutes: 1,
    maxProbeIntervalMinutes: 1440,
  });
  assert.throws(() => store.setProbeIntervalMinutes(0), /between 1 and 1440/);

  const reloaded = new ChannelHealthStore({ filePath });
  await reloaded.load();
  assert.equal(reloaded.settings().probeIntervalMinutes, 15);
});
