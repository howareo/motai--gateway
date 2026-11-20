import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { GatewayProjection } from '../src/gateway/projection.js';

const sample = JSON.parse(await readFile(new URL('../contracts/fixtures/attempt-valid.json', import.meta.url), 'utf8'));
const range = { from: '2026-10-25T00:00:00Z', to: '2026-10-27T00:00:00Z' };
const digest = (value) => createHash('sha256').update(value).digest('hex');
const event = (seq) => {
  const attempt = structuredClone(sample); attempt.intent.attempt_id = randomUUID(); attempt.intent.request_id = randomUUID();
  attempt.terminal.attempt_id = attempt.intent.attempt_id;
  return { format_version: 1, seq: String(seq), event_type: 'attempt_terminal', attempt };
};
const source = (events) => ({ calls: 0, async events({ after_seq, limit }) {
  this.calls++; const rows = events.filter((row) => BigInt(row.seq) > BigInt(after_seq)).slice(0, limit);
  const next = rows.at(-1)?.seq ?? after_seq, latest = events.at(-1)?.seq ?? '0';
  return { format_version: 1, events: rows, next_seq: next, latest_seq: latest, has_more: BigInt(next) < BigInt(latest) };
} });
async function sandbox(t) {
  const directory = await mkdtemp(path.join(tmpdir(), 'motai-projection-recovery-'));
  t.after(() => rm(directory, { recursive: true, force: true })); return directory;
}
async function fixture(t) {
  const directory = await sandbox(t), events = [event(1)], client = source(events);
  const original = new GatewayProjection({ directory, client }); await original.catchUp();
  events.push(event(2)); await original.catchUp();
  return { directory, events, client, original, pointer: path.join(directory, 'current.json'), checkpoint: original.checkpointPath() };
}
async function editJson(file, edit) { const value = JSON.parse(await readFile(file, 'utf8')); edit(value); await writeFile(file, JSON.stringify(value)); return value; }

test('future pointer/checkpoint schema, calculation and normalizer versions remain read-only even when rebuild is called first', async (t) => {
  for (const [target, key, value] of [['pointer', 'schemaVersion', 2], ['checkpoint', 'schemaVersion', 2],
    ['checkpoint', 'calcVersion', '999'], ['checkpoint', 'normalizerVersion', 'future']]) {
    const context = await fixture(t); await editJson(context[target], (record) => { record[key] = value; });
    const beforePointer = await readFile(context.pointer), beforeCheckpoint = await readFile(context.checkpoint);
    const client = source(context.events), restored = new GatewayProjection({ directory: context.directory, client });
    await assert.rejects(restored.rebuild(), { code: 'projection_future_version' });
    assert.equal(restored.state().writeBlocked, true); assert.equal(restored.state().stale, true);
    await assert.rejects(restored.catchUp(), { code: 'projection_future_version' });
    assert.equal(client.calls, 0); assert.deepEqual(await readFile(context.pointer), beforePointer);
    assert.deepEqual(await readFile(context.checkpoint), beforeCheckpoint);
  }
});

test('a corrupted late segment does not install a partial prefix or retry network inside reads; explicit background rebuild recovers', async (t) => {
  const context = await fixture(t); const badFile = path.join(context.original.generationPath(), context.original.segments[1].file);
  await writeFile(badFile, 'BROKEN_PRIVATE_BODY');
  const pointerBefore = await readFile(context.pointer), client = source(context.events);
  const restored = new GatewayProjection({ directory: context.directory, client });
  const state = await restored.load(); assert.equal(state.requiresRebuild, true); assert.equal(state.writeBlocked, false);
  assert.equal(state.lastError, 'projection_corrupt_segment'); assert.equal(state.projectedSeq, '0');
  for (let index = 0; index < 10; index++) { assert.equal(restored.overview(range).attempts, 0); await restored.load(); }
  await assert.rejects(restored.catchUp(), { code: 'projection_rebuild_required' }); assert.equal(client.calls, 0);
  assert.deepEqual(await readFile(context.pointer), pointerBefore);
  await restored.rebuild(); assert.equal(restored.overview(range).attempts, 2); assert.equal(restored.state().requiresRebuild, false);
  assert.notEqual(restored.generation, context.original.generation);
  assert.equal(await readFile(badFile, 'utf8'), 'BROKEN_PRIVATE_BODY', 'original evidence remains untouched');
});

test('a future segment format remains untouched even with a matching integrity hash', async (t) => {
  const context = await fixture(t), descriptor = context.original.segments[1];
  const file = path.join(context.original.generationPath(), descriptor.file);
  const value = JSON.parse(await readFile(file, 'utf8')); value.schemaVersion = 99;
  const bytes = JSON.stringify(value); await writeFile(file, bytes);
  await editJson(context.checkpoint, (checkpoint) => { checkpoint.segments[1].sha256 = digest(bytes); });
  const before = await readFile(context.pointer), client = source(context.events);
  const restored = new GatewayProjection({ directory: context.directory, client }); await restored.load();
  assert.equal(restored.state().writeBlocked, true); assert.equal(restored.overview(range).attempts, 0);
  await assert.rejects(restored.rebuild(), { code: 'projection_future_version' });
  assert.equal(client.calls, 0); assert.deepEqual(await readFile(context.pointer), before); assert.equal(await readFile(file, 'utf8'), bytes);
});

test('malformed pointer, missing generation and invalid persisted numeric rows are recoverable rather than interpreted as future', async (t) => {
  for (const mode of ['malformed', 'empty-object', 'missing', 'row']) {
    const context = await fixture(t);
    if (mode === 'malformed') await writeFile(context.pointer, '{');
    if (mode === 'empty-object') await writeFile(context.pointer, '{}');
    if (mode === 'missing') await rm(context.checkpoint);
    if (mode === 'row') {
      const descriptor = context.original.segments[0], file = path.join(context.original.generationPath(), descriptor.file);
      const data = JSON.parse(await readFile(file, 'utf8')); data.contributions[0].tokens[0] = -1;
      const bytes = JSON.stringify(data); await writeFile(file, bytes);
      await editJson(context.checkpoint, (checkpoint) => { checkpoint.segments[0].sha256 = digest(bytes); });
    }
    const restored = new GatewayProjection({ directory: context.directory, client: source(context.events) });
    const state = await restored.load(); assert.equal(state.requiresRebuild, true, mode); assert.equal(state.writeBlocked, false, mode);
    assert.equal(restored.overview(range).attempts, 0, mode); await restored.rebuild(); assert.equal(restored.overview(range).attempts, 2, mode);
  }
});

test('older calculation version serves its complete old result as stale until a successful explicit background rebuild', async (t) => {
  for (const previousVersion of ['1', '2', '3', '4', '5', '6', '7']) {
    const context = await fixture(t);
    await editJson(context.checkpoint, (checkpoint) => { checkpoint.calcVersion = previousVersion; });
    const restored = new GatewayProjection({ directory: context.directory, client: source(context.events) });
    const state = await restored.load(); assert.equal(state.requiresRebuild, true); assert.equal(state.writeBlocked, false);
    assert.equal(state.calcVersion, '8');
    assert.equal(restored.overview(range).attempts, 2); assert.equal(restored.state().stale, true);
    await assert.rejects(restored.catchUp(), { code: 'projection_rebuild_required' });
    assert.equal(JSON.parse(await readFile(context.checkpoint, 'utf8')).calcVersion, previousVersion);
    await restored.rebuild(); assert.equal(restored.overview(range).attempts, 2); assert.equal(restored.state().stale, false);
    assert.equal(JSON.parse(await readFile(restored.checkpointPath(), 'utf8')).calcVersion, '8');
  }
});

test('failed background rebuild retains published values and pointer; overview does not await or start the job', async (t) => {
  const context = await fixture(t); const before = await readFile(context.pointer); let reject;
  context.original.client = { events: () => new Promise((_, no) => { reject = no; }) };
  const pending = context.original.rebuild(); const rejected = assert.rejects(pending, /projection_catch_up_failed/);
  while (!reject) await new Promise((resolve) => setImmediate(resolve));
  assert.equal(context.original.state().rebuilding, true);
  for (let index = 0; index < 25; index++) assert.equal(context.original.overview(range).attempts, 2);
  reject(new Error('PRIVATE_UPSTREAM_ERROR')); await rejected;
  assert.equal(context.original.overview(range).attempts, 2); assert.equal(context.original.state().stale, true);
  assert.deepEqual(await readFile(context.pointer), before);
  assert.doesNotMatch(JSON.stringify(context.original.state()), /PRIVATE/);
});

test('future pointer published while background rebuild is pending is never replaced', async (t) => {
  const context = await fixture(t); const originalSource = source(context.events); let release;
  context.original.client = { events: async (query) => { await new Promise((resolve) => { release = resolve; }); return originalSource.events(query); } };
  const pending = context.original.rebuild(); const rejected = assert.rejects(pending, { code: 'projection_future_version' });
  while (!release) await new Promise((resolve) => setImmediate(resolve));
  await editJson(context.pointer, (pointer) => { pointer.schemaVersion = 2; }); const future = await readFile(context.pointer);
  release(); await rejected; assert.deepEqual(await readFile(context.pointer), future);
  assert.equal(context.original.overview(range).attempts, 2); assert.equal(context.original.state().writeBlocked, true);
});

test('empty store loads without creating files or consuming events; concurrent loads install a complete checkpoint only once', async (t) => {
  const directory = await sandbox(t), client = source([]), empty = new GatewayProjection({ directory, client });
  await empty.load(); assert.equal(client.calls, 0); assert.equal(empty.state().requiresRebuild, false);
  await assert.rejects(readFile(path.join(directory, 'current.json')), { code: 'ENOENT' });
  const context = await fixture(t), restored = new GatewayProjection({ directory: context.directory, client: source(context.events) });
  await Promise.all([restored.load(), restored.load(), restored.load()]); assert.equal(restored.overview(range).attempts, 2);
});
