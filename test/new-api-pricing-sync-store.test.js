import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { NewApiPricingSyncStore } from '../src/new-api-pricing-sync-store.js';

function tables(modelValue = null) {
  const result = {
    model_ratio: { 'existing-model': 2 },
    completion_ratio: { 'existing-model': 4 },
    cache_ratio: { 'existing-model': 0.1 },
    create_cache_ratio: { 'existing-model': 1.25 },
  };
  if (modelValue) {
    result.model_ratio['claude-fable-5'] = modelValue.modelRatio;
    result.completion_ratio['claude-fable-5'] = modelValue.completionRatio;
    result.cache_ratio['claude-fable-5'] = modelValue.cacheRatio;
    result.create_cache_ratio['claude-fable-5'] = modelValue.createCacheRatio;
  }
  return result;
}

function record(rates = { input: 10, output: 50, cacheRead: 1, cacheWrite: 12.5 }) {
  return {
    family: 'anthropic',
    model: 'claude-fable-5',
    rates,
    sourceUrl: 'https://models.dev/api.json',
    sourceLabel: 'models.dev 同步',
    lastSeenAt: '2026-07-27T00:00:00.000Z',
  };
}

function client(initialTables) {
  const state = { tables: structuredClone(initialTables), applies: [] };
  return {
    state,
    pricingSyncConfigured() { return true; },
    async pricingTables() { return structuredClone(state.tables); },
    async applyPricingTables(expected, desired) {
      assert.deepEqual(expected, state.tables);
      state.applies.push({ expected: structuredClone(expected), desired: structuredClone(desired) });
      state.tables = structuredClone(desired);
      return structuredClone(desired);
    },
  };
}

async function setup(t, initialTables = tables()) {
  const directory = await mkdtemp(path.join(tmpdir(), 'new-api-pricing-sync-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  let now = Date.parse('2026-07-27T00:00:00Z');
  const fakeClient = client(initialTables);
  const store = new NewApiPricingSyncStore({
    filePath: path.join(directory, 'state.json'),
    client: fakeClient,
    now: () => now,
    confirmationDelayMs: 5 * 60 * 1000,
  });
  await store.load();
  return { store, client: fakeClient, advance: (milliseconds) => { now += milliseconds; } };
}

test('adds a missing model only after two observations and preserves unrelated New API prices', async (t) => {
  const fixture = await setup(t);
  const first = await fixture.store.synchronize({ records: [record()], observationId: 'first', snapshotHash: 'hash-a' });
  assert.equal(first.counts.pending, 1);
  assert.equal(fixture.client.state.applies.length, 0);

  fixture.advance(5 * 60 * 1000);
  const second = await fixture.store.synchronize({ records: [record()], observationId: 'second', snapshotHash: 'hash-a' });
  assert.equal(second.counts.synced, 1);
  assert.equal(fixture.client.state.applies.length, 1);
  assert.equal(fixture.client.state.tables.model_ratio['existing-model'], 2);
  assert.deepEqual({
    modelRatio: fixture.client.state.tables.model_ratio['claude-fable-5'],
    completionRatio: fixture.client.state.tables.completion_ratio['claude-fable-5'],
    cacheRatio: fixture.client.state.tables.cache_ratio['claude-fable-5'],
    createCacheRatio: fixture.client.state.tables.create_cache_ratio['claude-fable-5'],
  }, { modelRatio: 5, completionRatio: 5, cacheRatio: 0.1, createCacheRatio: 1.25 });
});

test('overwrites an existing New API price from the confirmed third-party source', async (t) => {
  const manual = { modelRatio: 4, completionRatio: 4, cacheRatio: 0.2, createCacheRatio: 1.5 };
  const fixture = await setup(t, tables(manual));
  await fixture.store.synchronize({ records: [record()], observationId: 'first' });
  fixture.advance(5 * 60 * 1000);
  const syncedSnapshot = await fixture.store.synchronize({ records: [record()], observationId: 'second' });
  assert.equal(syncedSnapshot.counts.synced, 1);
  assert.equal(fixture.client.state.applies.length, 1);
  assert.equal(fixture.client.state.tables.model_ratio['claude-fable-5'], 5);
});

test('applies a large third-party price change after confirmation', async (t) => {
  const fixture = await setup(t);
  await fixture.store.synchronize({ records: [record()], observationId: 'first' });
  fixture.advance(5 * 60 * 1000);
  await fixture.store.synchronize({ records: [record()], observationId: 'second' });
  assert.equal(fixture.client.state.applies.length, 1);

  const changed = record({ input: 20, output: 100, cacheRead: 2, cacheWrite: 25 });
  fixture.advance(1);
  await fixture.store.synchronize({ records: [changed], observationId: 'third' });
  fixture.advance(5 * 60 * 1000);
  const synced = await fixture.store.synchronize({ records: [changed], observationId: 'fourth' });
  assert.equal(synced.counts.synced, 1);
  assert.equal(fixture.client.state.applies.length, 2);
  assert.equal(fixture.client.state.tables.model_ratio['claude-fable-5'], 10);
});

test('marks ratios synced immediately when New API already holds them', async (t) => {
  const target = { modelRatio: 5, completionRatio: 5, cacheRatio: 0.1, createCacheRatio: 1.25 };
  const fixture = await setup(t, tables(target));
  const first = await fixture.store.synchronize({ records: [record()], observationId: 'first' });
  assert.equal(first.counts.synced, 1);
  assert.equal(first.counts.pending || 0, 0);
  assert.equal(fixture.client.state.applies.length, 0);
});

test('marks a disappeared or incomplete source model stale without deleting its price', async (t) => {
  const target = { modelRatio: 5, completionRatio: 5, cacheRatio: 0.1, createCacheRatio: 1.25 };
  const fixture = await setup(t, tables(target));
  await fixture.store.synchronize({ records: [record()], observationId: 'first' });
  fixture.advance(5 * 60 * 1000);
  await fixture.store.synchronize({ records: [record()], observationId: 'second' });
  const stale = await fixture.store.synchronize({ records: [], observationId: 'third' });
  assert.equal(stale.counts.stale, 1);
  assert.equal(fixture.client.state.tables.model_ratio['claude-fable-5'], 5);
  assert.equal(fixture.client.state.applies.length, 0);
});
