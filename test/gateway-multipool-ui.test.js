import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { editorDOM } from './helpers/editor-dom.js';

const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
const app = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
const source = (name) => {
  const tail = app.slice(app.search(new RegExp(`(?:async )?function ${name}\\(`)));
  return tail.slice(0, tail.indexOf('\n}') + 2);
};

function setup({ confirm = async () => true } = {}) {
  const dom = editorDOM(html), requests = [], renders = [], confirms = [];
  const channel = { id: 'shared', name: '双池渠道', poolId: 'a', poolIds: ['a', 'b'], poolPriorities: { a: 10, b: 1 }, priority: 10,
    enabled: true, weight: 1, models: [{ modelId: 'M', upstreamModel: 'M', capabilities: ['responses'] }] };
  const state = { gatewayMode: 'gateway', gatewayMutation: false, routingChannelId: null, routingPool: null, gatewayProbing: new Set(), gatewayHealthPending: new Map(),
    gatewayConfig: { gen: '1', pools: [{ id: 'a', name: '甲池' }, { id: 'b', name: '乙池' }], channels: [channel,
      { ...channel, id: 'other', poolId: 'b', poolIds: ['b'], poolPriorities: { b: 5 } }] },
    gatewayHealth: { gen: '1', channels: [
      { channelId: 'shared', poolId: 'a', state: 'available' }, { channelId: 'shared', poolId: 'b', state: 'exhausted' }] } };
  const context = vm.createContext({ state, document: dom.document, decimal: { format: String }, AbortSignal,
    renderChannels: () => renders.push([state.routingChannelId, state.routingPool]),
    confirmUnhealthyPrimary: (channel) => { confirms.push(channel.id); return confirm(channel); },
    createEditorDraft: () => ({ operationId: 'once' }), gatewaySaved: async () => {}, showToast() {}, refresh: async () => {},
    api: async (path, options) => { requests.push({ path, body: JSON.parse(options.body) }); return { activated: true }; } });
  for (const name of ['gatewayChannels', 'routeMetrics', 'setPrimaryChannel', 'setChannelPosition', 'gatewayChannelAction', 'probeDuration', 'probeFailureReason', 'probeGatewayChannel']) vm.runInContext(source(name), context);
  return { context, state, requests, renders, confirms };
}

test('one shared channel displays independent positions and its selector targets only the named pool', async () => {
  const ui = setup(), channel = ui.context.gatewayChannels()[0];
  assert.deepEqual(Array.from(channel.poolRoles, (role) => [role.poolId, role.routeRole, role.isSolePrimary]), [
    ['a', 'primary', true], ['b', 'fallback', false] ]);
  assert.equal(channel.runtimeHealthByPool.length, 2);
  assert.equal(channel.runtimeHealth.state, 'available');
  const view = ui.context.routeMetrics(channel);
  assert.equal(view.children[0].children[0].textContent, '主用');
  assert.equal(view.children[1].children[0].textContent, '第2');
  const selects = view.querySelectorAll('select'); assert.equal(selects.length, 2);
  assert.equal(selects[0].getAttribute('aria-label'), '双池渠道在甲池分组的顺位');
  assert.deepEqual(selects.map((select) => select.value), ['1', '2']);
  selects[1].value = '1'; await selects[1].dispatch('change');
  assert.equal(ui.requests.length, 1);
  assert.equal(ui.requests[0].body.change.poolId, 'b');
  assert.equal(ui.requests[0].body.change.action, 'primary');
});

test('a pool selector moves its current primary directly to second and clears the busy state', async () => {
  const ui = setup(), channel = ui.context.gatewayChannels()[1];
  const view = ui.context.routeMetrics(channel), select = view.querySelector('select');
  select.value = '2'; await select.dispatch('change');
  assert.equal(ui.requests.length, 1);
  assert.deepEqual(ui.requests[0].body.change, { action: 'reorder', channelId: 'other', poolId: 'b', position: 2 });
  assert.equal(ui.confirms.length, 0);
  assert.equal(ui.state.routingChannelId, null);
  assert.equal(ui.state.routingPool, null);
});

test('positions include disabled members, use ASCII ID ties, and ignore weights; disabled or busy controls never reorder', async () => {
  const ui = setup(), original = ui.state.gatewayConfig.channels[0];
  ui.state.gatewayConfig.channels = [
    { ...original, id: '2', poolIds: ['a'], priority: 20, poolPriorities: { a: 20 }, enabled: false },
    { ...original, id: '10', poolIds: ['a'], priority: 10, poolPriorities: { a: 10 }, weight: 0 },
    { ...original, id: '1', poolIds: ['a'], priority: 10, poolPriorities: { a: 10 }, weight: 999 },
  ];
  const channels = ui.context.gatewayChannels();
  assert.deepEqual(Array.from(channels, (channel) => [channel.id, channel.position, channel.poolSize]), [['2', 1, 3], ['10', 3, 3], ['1', 2, 3]]);
  vm.runInContext(source('groupChannelsByProvider'), ui.context);
  assert.deepEqual(Array.from(ui.context.groupChannelsByProvider(channels)[0].channels, (channel) => channel.id), ['2', '1', '10']);
  const disabled = ui.context.routeMetrics(channels[0]);
  assert.match(disabled.children[0].children[0].textContent, /已禁用/);
  assert.equal(disabled.querySelector('select').disabled, true);
  await ui.context.setChannelPosition(channels[0], 'a', 2);
  ui.state.gatewayMutation = true;
  assert.equal(ui.context.routeMetrics(channels[1]).querySelector('select').disabled, true);
  await ui.context.setChannelPosition(channels[1], 'a', 1);
  ui.state.gatewayMutation = false; ui.state.gatewayPendingOperation = { state: 'pending' };
  assert.equal(ui.context.routeMetrics(channels[1]).querySelector('select').disabled, true);
  assert.equal(ui.requests.length, 0);
});

test('Claude position controls describe manual switching without automatic fallback', () => {
  const ui = setup();
  const view = ui.context.routeMetrics({ ...ui.context.gatewayChannels()[0], poolRoles: null, poolId: 'claude', routingPool: 'Claude' });
  assert.match(view.children[2].title, /失败直接返回错误.*手动切换/);
  assert.equal(view.children[0].textContent, '主用');
});

test('failed reorder resets the selection and a concurrent reorder sends nothing', async () => {
  const ui = setup(), channel = ui.context.gatewayChannels()[1];
  const select = ui.context.routeMetrics(channel).querySelector('select');
  ui.context.api = async () => { throw Object.assign(new Error('stale generation'), { status: 409 }); };
  select.value = '2'; await select.dispatch('change');
  assert.equal(select.value, '1');
  assert.equal(ui.state.routingChannelId, null);
  ui.state.routingChannelId = 'shared';
  await ui.context.setChannelPosition(channel, 'b', 2);
  assert.equal(ui.requests.length, 0);
});

test('manual probe always carries the explicit membership and missing/foreign pools dispatch nothing', async () => {
  const ui = setup(), channel = ui.context.gatewayChannels()[0], button = { disabled: false, isConnected: true };
  await ui.context.probeGatewayChannel(channel, undefined, button);
  await ui.context.probeGatewayChannel(channel, 'outside', button);
  await ui.context.gatewayChannelAction('primary', channel);
  assert.equal(ui.requests.length, 0);
  await ui.context.probeGatewayChannel(channel, 'b', button);
  assert.equal(ui.requests[0].path, '/api/channels/shared/test');
  assert.equal(ui.requests[0].body.poolId, 'b');
  assert.equal(button.disabled, false);
});

test('gateway set-primary confirms a failing channel first, shows the busy state while saving and clears it afterwards', async () => {
  const ui = setup(), channel = { ...ui.context.gatewayChannels()[0], state: 'failing', routingPool: '乙池' };
  const busy = [];
  ui.context.gatewaySaved = async () => { busy.push([ui.state.routingChannelId, ui.state.routingPool]); };
  await ui.context.setPrimaryChannel(channel, 'b');
  assert.deepEqual(ui.confirms, ['shared']);
  assert.equal(ui.requests.length, 1);
  assert.deepEqual(busy, [['shared', '乙池']]);
  assert.deepEqual(ui.renders.at(0), ['shared', '乙池']);
  assert.deepEqual(ui.renders.at(-1), [null, null]);
  assert.equal(ui.state.routingChannelId, null);
  assert.equal(ui.state.routingPool, null);
});

test('gateway set-primary on a failing channel sends nothing when the confirmation is declined', async () => {
  const ui = setup({ confirm: async () => false }), channel = { ...ui.context.gatewayChannels()[0], state: 'failing' };
  await ui.context.setPrimaryChannel(channel, 'b');
  assert.equal(ui.confirms.length, 1);
  assert.equal(ui.requests.length, 0);
  assert.equal(ui.renders.length, 0);
  assert.equal(ui.state.routingChannelId, null);
});

test('gateway set-primary on a healthy channel skips the confirmation and clears the busy state even when the save fails', async () => {
  const ui = setup(), channel = ui.context.gatewayChannels()[0];
  ui.context.api = async () => { throw Object.assign(new Error('rejected'), { status: 409 }); };
  await ui.context.setPrimaryChannel(channel, 'b');
  assert.equal(ui.confirms.length, 0);
  assert.equal(ui.state.routingChannelId, null);
  assert.equal(ui.state.routingPool, null);
  assert.deepEqual(ui.renders.at(-1), [null, null]);
});

test('a second set-primary while one is in flight is ignored', async () => {
  const ui = setup(), channel = ui.context.gatewayChannels()[0];
  ui.state.routingChannelId = 'other';
  await ui.context.setPrimaryChannel(channel, 'b');
  assert.equal(ui.requests.length, 0);
  assert.equal(ui.confirms.length, 0);
});

test('channel ids of equal rank sort numerically when both are numbers, otherwise as strings', () => {
  const context = vm.createContext({});
  vm.runInContext(source('compareChannelIds'), context);
  const sort = (ids) => ids.slice().sort(context.compareChannelIds);
  assert.deepEqual(sort(['1012', '2', '33', '1']), ['1', '2', '33', '1012']);
  assert.deepEqual(sort(['b', 'a', 'c']), ['a', 'b', 'c']);
  assert.deepEqual(sort(['gw-2', 'gw-10']), ['gw-10', 'gw-2']);
  assert.ok(app.includes('compareChannelIds(left.id, right.id)'));
});

test('request summary line shows the number of requests before the amount', () => {
  const context = vm.createContext({ decimal: { format: String }, formatCurrencyAmount: (currency, amount) => `$${amount}`, currencyFormats: new Map() });
  vm.runInContext(source('requestSummaryText'), context);
  assert.equal(context.requestSummaryText({ requests: 1234, costs: [{ currency: 'USD', amount: 5 }], lowerBound: false }), '合计 1234 条 · $5');
  assert.equal(context.requestSummaryText({ requests: 3, costs: [{ currency: 'USD', amount: 5 }], lowerBound: true }), '合计 3 条 · ≥ $5');
  assert.equal(context.requestSummaryText({ costs: [{ currency: 'USD', amount: 5 }], lowerBound: false }), '合计 $5');
  assert.equal(context.requestSummaryText(null, true), '合计 …');
});

test('gateway request pagination shows range, total and page count from the first-page summary, and falls back to the page alone', () => {
  const start = app.indexOf("if (data?.mode === 'gateway') {", app.indexOf('function renderRequests()'));
  const branch = app.slice(start, app.indexOf('return;', start));
  for (const piece of ['state.requestSummary?.requests', '`${range} / ${decimal.format(exactTotal)} 条`',
    '`第 ${page} / 共 ${Math.max(page, Math.ceil(exactTotal / size))} 页`', 'data.pageSize || requestPageSize',
    'elements.requestPageNext.disabled = !data.hasMore', 'exactTotal === null ? `第 ${page} 页`']) {
    assert.ok(branch.includes(piece), piece);
  }
});

test('channel summary line is built the same way in gateway mode and old mode', () => {
  const start = app.indexOf('const autoCount'), body = app.slice(start, app.indexOf('function renderModels()'));
  assert.ok(body.includes('分钟探活 · ${errorCount} 次上游错误 / ${affectedChannels} 个渠道 · ${walletCount} 个余额已同步 · ${autoCount} 个自动同步成本'));
  assert.equal(body.includes("gatewayMode === 'gateway'"), false);
});

test('channel cost distribution takes removed channels too and keeps probe-only cost', () => {
  const start = app.indexOf('function renderModels()'), body = app.slice(start, app.indexOf('const totalCost = items.reduce', start));
  assert.ok(body.includes('...(state.overview?.removedChannels || [])'));
  assert.ok(body.includes('channel.requests > 0 || channel.estimatedCost > 0'));
});

test('group filter options come from the loaded gateway pools (name shown, id as value) in both the desktop bar and the phone sheet', () => {
  const sync = source('syncFilters');
  assert.ok(sync.includes("new Option('全部分组', '')"));
  assert.ok(sync.includes('state.gatewayConfig?.pools'));
  assert.ok(sync.includes('new Option(pool.name || pool.id, pool.id)'));
  assert.ok(sync.includes("elements.poolFilter.hidden = state.gatewayMode !== 'gateway'"));
  // The phone sheet is the same #request-filters container, so one select serves both layouts.
  const filters = html.slice(html.indexOf('id="request-filters"'), html.indexOf('id="request-refresh-button"'));
  assert.ok(filters.includes('id="pool-filter"'));
  assert.ok(filters.indexOf('id="pool-filter"') > filters.indexOf('id="channel-filter"') && filters.indexOf('id="pool-filter"') < filters.indexOf('id="model-filter"'));
  assert.ok(app.includes("[elements.poolFilter, '分组']"));
  assert.ok(app.includes('for (const filter of [elements.channelFilter, elements.poolFilter,'));
});

test('a client disconnect reads as 客户端断开 in the row, the error cell and the detail, never as an upstream error', () => {
  const context = vm.createContext({ decimal: { format: String }, formatTime: () => 't', formatCost: () => '', formatMs: () => '',
    latencyTiers: () => ({}) });
  vm.runInContext([source('isClientCancelled'), source('requestDetailFields')].join('\n'), context);
  assert.equal(context.isClientCancelled({ requestOutcome: 'cancelled' }), true);
  assert.equal(context.isClientCancelled({ requestOutcome: 'failed', statusCode: 502 }), false);
  assert.equal(context.isClientCancelled({ source: 'legacy', kind: 'error' }), false);
  assert.equal(context.isClientCancelled(null), false);
  const fields = (log) => Object.fromEntries(context.requestDetailFields({ createdAt: 'x', channelName: 'C', channelRoute: ['C'], ...log }));
  const cancelled = fields({ kind: 'error', requestOutcome: 'cancelled', statusCode: 200, errorMessage: 'client_cancelled' });
  assert.equal(cancelled['结果'], '客户端断开');
  assert.equal(cancelled['错误摘要'], '客户端断开');
  assert.equal(fields({ kind: 'error', requestOutcome: 'failed', statusCode: 502, errorMessage: 'upstream_5xx' })['结果'], '失败 · HTTP 502');
  const row = app.slice(app.indexOf('const caller = log.isModelTest'), app.indexOf('const caller = log.isModelTest') + 600);
  assert.ok(row.includes("isClientCancelled(log) ? '客户端断开'"));
  const grid = source('tokenGrid');
  assert.ok(grid.includes("cancelled ? '客户端断开'"));
});

test('upstream alert and request note leave client disconnects out of the upstream error figures', () => {
  const alert = source('renderUpstreamAlert');
  assert.ok(alert.includes('metrics.failedRequests - (metrics.cancelledRequests || 0)'));
  assert.ok(alert.includes('metrics.errorCount === 0'));
  const metrics = source('renderMetrics');
  assert.ok(metrics.includes('客户端断开 ${metrics.cancelledRequests}'));
  assert.ok(metrics.includes('冷却换渠道 ${decimal.format(cooldowns)} · 旧 New API 同请求换渠道 ${decimal.format(metrics.failovers)}'));
  assert.equal(metrics.includes('次请求中触发'), false);
});
