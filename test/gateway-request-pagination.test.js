import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const source = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
const load = source.slice(source.indexOf('async function loadRequests('), source.indexOf('async function saveChannelSettings('));

function harness() {
  const calls = [], scrolls = [], clicks = {};
  const state = { gatewayMode: 'gateway', periodKey: 'today', requestPage: 1, requestToken: 0,
    requestCursors: [], requestCursorQuery: null, overview: {} };
  const elements = { requestRefresh: {}, channelFilter: { value: '' }, poolFilter: { value: '' }, modelFilter: { value: '' },
    statusFilter: { value: '' }, streamFilter: { value: '' } };
  for (const key of ['requestPageFirst', 'requestPagePrev', 'requestPageNext', 'requestPageLast']) elements[key] = {
    addEventListener: (_event, callback) => { clicks[key] = callback; },
  };
  let paginationTop = 600;
  elements.requestPagination = { getBoundingClientRect: () => ({ top: paginationTop }) };
  let cursor = 0;
  const context = vm.createContext({ state, elements, URLSearchParams, Date,
    window: { scrollY: 800, scrollBy: (options) => scrolls.push(options.top) },
    periodQuery: () => new URLSearchParams({ period: 'today' }), renderRequests: () => { paginationTop = 360; }, renderRequestSummary: () => {}, renderUpstreamAlert: () => {},
    showToast: (text) => { throw new Error(text); },
    api: async (url) => {
      const query = new URL(url, 'http://local.test').searchParams;
      calls.push(query);
      const page = query.get('last') === '1' ? 3 : Number(query.get('page'));
      return { mode: 'gateway', page, items: [], hasMore: page < 3, nextCursor: `opaque-${++cursor}`,
        ...(query.has('last') || query.has('reverse') ? { reverse: true, previousCursor: page > 1 ? `tail-${page - 1}` : null, total: 120 } : {}),
        snapshotSeq: query.get('snapshotSeq') || '9007199254740993',
        periodStartAt: query.get('from') || '2026-10-26T16:00:00Z',
        periodEndAt: query.get('to') || '2026-10-27T03:00:00Z' };
    } });
  vm.runInContext(load, context);
  vm.runInContext(source.slice(source.indexOf('elements.requestPageFirst.addEventListener'), source.indexOf("$('#add-channel-button').addEventListener")), context);
  return { state, elements, calls, clicks, scrolls, setPaginationTop: (top) => { paginationTop = top; }, load: context.loadRequests };
}

test('gateway next/previous pages pin query cutoff and uint64 snapshot with opaque cursors', async () => {
  const h = harness();
  await h.load();
  h.state.requestPage = 2;
  await h.load();
  assert.equal(h.calls[1].get('cursor'), 'opaque-1');
  assert.equal(h.calls[1].get('snapshotSeq'), '9007199254740993');
  assert.equal(h.calls[1].get('to'), '2026-10-27T03:00:00Z');
  h.state.requestPage = 1;
  await h.load();
  assert.equal(h.calls[2].get('cursor'), null);
  assert.equal(h.calls[2].get('snapshotSeq'), '9007199254740993');
});

test('changing filters or requesting fresh resets the cursor and snapshot', async () => {
  const h = harness();
  await h.load(); h.state.requestPage = 2; await h.load();
  h.elements.channelFilter.value = 'uuid-channel';
  await h.load();
  assert.equal(h.calls[2].get('page'), '1');
  assert.equal(h.calls[2].get('cursor'), null);
  assert.equal(h.calls[2].get('snapshotSeq'), null);
  h.state.requestPage = 2;
  await h.load({ fresh: true });
  assert.equal(h.calls[3].get('page'), '1');
  assert.equal(h.calls[3].get('from'), null);
});

test('the group filter is sent as pool, resets the cursor when it changes, and is not sent outside gateway mode', async () => {
  const h = harness();
  await h.load(); h.state.requestPage = 2; await h.load();
  assert.equal(h.calls[0].get('pool'), null);
  h.elements.poolFilter.value = 'pool-main';
  await h.load();
  assert.equal(h.calls[2].get('pool'), 'pool-main');
  assert.equal(h.calls[2].get('page'), '1');
  assert.equal(h.calls[2].get('cursor'), null);
  assert.equal(h.calls[2].get('snapshotSeq'), null);
  h.state.requestPage = 1;
  await h.load();
  assert.equal(h.calls[3].get('pool'), 'pool-main');
  h.state.gatewayMode = 'newapi';
  await h.load();
  assert.equal(h.calls[4].get('pool'), null);
});

test('last/previous/next/first keep the snapshot and direct cursors without scrolling to the page header', async () => {
  const h = harness();
  await h.load();
  h.setPaginationTop(600);
  await h.load({ last: true, preserveScroll: true });
  assert.equal(h.calls[1].get('last'), '1');
  assert.equal(h.calls[1].get('cursor'), null);
  assert.equal(h.calls[1].get('snapshotSeq'), '9007199254740993');
  assert.equal(h.state.requestPage, 3);
  await h.load({ page: 2, preserveScroll: true });
  assert.equal(h.calls[2].get('cursor'), 'tail-2');
  assert.equal(h.calls[2].get('reverse'), '1');
  await h.load({ page: 3 });
  assert.equal(h.calls[3].get('reverse'), '1');
  assert.equal(h.calls[3].get('cursor'), null);
  await h.load({ page: 1 });
  assert.equal(h.calls[4].get('reverse'), null);
  assert.equal(h.calls[4].get('cursor'), null);
  assert.equal(h.calls[4].get('snapshotSeq'), '9007199254740993');
  assert.deepEqual(h.scrolls, [-240, 0]);
  const handlers = source.slice(source.indexOf('elements.requestPageFirst.addEventListener'), source.indexOf("$('#add-channel-button').addEventListener"));
  assert.doesNotMatch(handlers, /scrollIntoView/);
});
