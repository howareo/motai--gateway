import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { LogCacheStore } from '../src/log-cache-store.js';

async function fileExists(filePath) {
  try {
    await stat(filePath);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

test('persists compact logs, coverage, and a bounded overview snapshot', async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'new-api-log-cache-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const filePath = path.join(directory, 'log-cache.json');
  const now = () => 1_700_000_200_000;
  const cache = new LogCacheStore({ filePath, now });
  await cache.load();
  await cache.merge(2, [{
    id: 7,
    created_at: 1_700_000_100,
    channel: 4,
    model_name: 'gpt-5.6-terra',
    request_id: 'request-7',
    prompt_tokens: 12,
    completion_tokens: 3,
    other: JSON.stringify({
      cache_tokens: 8,
      reasoning_effort: 'high',
      stream_status: { status: 'error', errors: ['stream interrupted'] },
      ignored: 'not persisted',
      admin_info: { use_channel: [3, 4], ignored: 'not persisted' },
    }),
  }], { coveredFrom: 1_699_000_000, checkedThrough: 1_700_000_150 });
  await cache.saveOverview({
    key: 'today',
    cacheKey: 'today-2023-11-14',
    label: '今天',
    hours: 24,
    startTimestamp: 1_699_913_600,
    endTimestamp: 1_700_000_150,
  }, {
    fetchedAt: 1_700_000_150_000,
    value: { logs: Array.from({ length: 250 }, (_, index) => ({ id: index })), errors: [] },
  });
  await cache.flush();

  const reloaded = new LogCacheStore({ filePath, now });
  await reloaded.load();
  assert.equal(reloaded.coveredFrom(2), 1_699_000_000);
  assert.equal(reloaded.checkedThrough(2), 1_700_000_150);
  assert.equal(reloaded.items(2).length, 1);
  assert.deepEqual(JSON.parse(reloaded.items(2)[0].other), {
    cache_tokens: 8,
    reasoning_effort: 'high',
    stream_status: { status: 'error', errors: ['stream interrupted'] },
    admin_info: { use_channel: [3, 4] },
  });
  assert.equal(reloaded.overviewEntries()[0].value.logs.length, 200);
});

test('partial recent pages never claim coverage before or after reloading', async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'new-api-log-cache-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const filePath = path.join(directory, 'log-cache.json');
  const now = () => 1_700_000_200_000;
  const cache = new LogCacheStore({ filePath, now });
  await cache.merge(2, [{ id: 1, created_at: 1_700_000_100 }]);
  assert.equal(cache.coveredFrom(2), null);
  assert.equal(cache.checkedThrough(2), 0);
  await cache.flush();

  const reloaded = new LogCacheStore({ filePath, now });
  await reloaded.load();
  assert.equal(reloaded.coveredFrom(2), null);
  await reloaded.merge(2, [], { coveredFrom: 1_699_000_000, checkedThrough: 1_700_000_150 });
  await reloaded.merge(2, [{ id: 2, created_at: 1_700_000_160 }]);
  assert.equal(reloaded.coveredFrom(2), 1_699_000_000);
  assert.equal(reloaded.checkedThrough(2), 1_700_000_150);
});

test('migrates legacy coverage and snapshots while retaining compact logs', async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'new-api-log-cache-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const filePath = path.join(directory, 'log-cache.json');
  await writeFile(filePath, JSON.stringify({
    schemaVersion: 1,
    logTypes: { 2: { coveredFrom: 1_699_000_000, checkedThrough: 1_700_000_150, items: [{ id: 7, created_at: 1_700_000_100 }] } },
    overviews: { 'today-2023-11-14': { period: { endTimestamp: 1_700_000_150 }, fetchedAt: 1_700_000_150_000, value: {} } },
  }));
  const cache = new LogCacheStore({ filePath, now: () => 1_700_000_200_000 });
  await cache.load();
  assert.equal(cache.items(2).length, 1);
  assert.equal(cache.coveredFrom(2), null);
  assert.equal(cache.checkedThrough(2), 0);
  assert.deepEqual(cache.overviewEntries(), []);
  assert.equal(JSON.parse(await readFile(filePath, 'utf8')).schemaVersion, 2);
});

test('batches merge and saveOverview writes into a single flush', async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'new-api-log-cache-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const filePath = path.join(directory, 'log-cache.json');
  const now = () => 1_700_000_200_000;
  const cache = new LogCacheStore({ filePath, now, persistDelayMs: 24 * 60 * 60 * 1000 });
  await cache.load();
  assert.equal(await fileExists(filePath), true, 'load() writes the initial empty store immediately');
  const afterLoad = JSON.parse(await readFile(filePath, 'utf8'));

  let writeCount = 0;
  const originalPersist = cache.persist.bind(cache);
  cache.persist = async (...args) => {
    writeCount += 1;
    return originalPersist(...args);
  };

  await cache.merge(2, [{ id: 7, created_at: 1_700_000_100 }]);
  await cache.merge(5, [{ id: 8, created_at: 1_700_000_110 }]);
  await cache.saveOverview({
    key: 'today',
    cacheKey: 'today-2023-11-14',
    label: '今天',
    hours: 24,
    startTimestamp: 1_699_913_600,
    endTimestamp: 1_700_000_150,
  }, { fetchedAt: 1_700_000_150_000, value: { logs: [], errors: [] } });

  assert.deepEqual(JSON.parse(await readFile(filePath, 'utf8')), afterLoad, 'file is unchanged before flush');
  assert.equal(cache.dirty, true);
  assert.equal(writeCount, 0, 'no write has happened before flush');

  await cache.flush();

  assert.equal(writeCount, 1, 'all three pending changes are coalesced into a single write');
  assert.equal(cache.dirty, false);
  const onDisk = JSON.parse(await readFile(filePath, 'utf8'));
  assert.equal(onDisk.logTypes['2'].items.length, 1);
  assert.equal(onDisk.logTypes['5'].items.length, 1);
  assert.ok(onDisk.overviews['today-2023-11-14']);
});

test('flush failure keeps dirty true so a later flush retries', async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'new-api-log-cache-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  // Point filePath at a path whose "file" is actually an existing directory, so writes fail.
  const blockedPath = path.join(directory, 'log-cache.json');
  await mkdir(blockedPath);
  const now = () => 1_700_000_200_000;
  const cache = new LogCacheStore({ filePath: blockedPath, now, persistDelayMs: 24 * 60 * 60 * 1000 });
  cache.logTypes = { 2: { coveredFrom: null, checkedThrough: 0, items: [] }, 5: { coveredFrom: null, checkedThrough: 0, items: [] } };
  cache.schedulePersist();

  await assert.rejects(() => cache.flush());
  assert.equal(cache.dirty, true, 'dirty stays true after a failed flush');
});

test('flush persists merge and saveOverview so a reload sees the same in-memory data', async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'new-api-log-cache-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const filePath = path.join(directory, 'log-cache.json');
  const now = () => 1_700_000_200_000;
  const cache = new LogCacheStore({ filePath, now, persistDelayMs: 24 * 60 * 60 * 1000 });
  await cache.load();
  await cache.merge(2, [
    { id: 1, created_at: 1_700_000_100 },
    { id: 2, created_at: 1_700_000_160 },
    { id: 3, created_at: 1_700_000_130 },
  ], { coveredFrom: 1_699_000_000, checkedThrough: 1_700_000_150 });
  await cache.saveOverview({
    key: 'today',
    cacheKey: 'today-2023-11-14',
    label: '今天',
    hours: 24,
    startTimestamp: 1_699_913_600,
    endTimestamp: 1_700_000_150,
  }, { fetchedAt: 1_700_000_150_000, value: { logs: [{ id: 1 }], errors: [] } });

  await cache.flush();

  const reloaded = new LogCacheStore({ filePath, now });
  await reloaded.load();
  assert.deepEqual(reloaded.items(2), cache.items(2));
  assert.deepEqual(reloaded.items(2).map((item) => item.id), [2, 3, 1], 'order (newest first) is preserved across reload');
  assert.equal(reloaded.coveredFrom(2), cache.coveredFrom(2));
  assert.equal(reloaded.checkedThrough(2), cache.checkedThrough(2));
  assert.deepEqual(reloaded.overviewEntries(), cache.overviewEntries());
});
