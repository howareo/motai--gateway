import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const app = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
const source = (name) => {
  const tail = app.slice(app.search(new RegExp(`(?:async )?function ${name}\\(`)));
  return tail.slice(0, tail.indexOf('\n}') + 2);
};

function setup() {
  const toasts = [], calls = [], refreshes = [];
  const pending = [];
  const channel = { id: 'c1', name: '几方 Claude', poolId: 'claude', poolIds: ['claude'], poolRoles: [{ poolId: 'claude', routingPool: 'Claude' }] };
  const state = { gatewayProbing: new Set() };
  const button = { disabled: false, isConnected: true, textContent: '检测 Claude' };
  const context = vm.createContext({ state, AbortSignal,
    showToast: (...args) => toasts.push(args),
    refresh: async (options) => { refreshes.push({ options, busyDuringRefresh: state.gatewayProbing.size, label: button.textContent }); },
    api: (path, options) => new Promise((resolve, reject) => {
      calls.push({ path, body: JSON.parse(options.body), signal: options.signal });
      pending.push({ resolve, reject });
    }) });
  for (const name of ['probeDuration', 'probeFailureReason', 'probeGatewayChannel']) vm.runInContext(source(name), context);
  const click = () => context.probeGatewayChannel(channel, 'claude', button);
  const settle = async () => { for (let i = 0; i < 5; i++) await new Promise(setImmediate); };
  return { state, button, channel, toasts, calls, refreshes, pending, click, settle };
}

const completed = (extra = {}) => ({ state: 'completed', success: true, latencyMs: 3200, waitedMs: 4100, model: 'claude-sonnet-5.5',
  protocol: 'chat_completions', statusCode: 200, errorClass: null, ...extra });

test('click shows the busy state at once, asks the server to wait, and a success toast carries the duration', async () => {
  const ui = setup();
  const running = ui.click();
  assert.equal(ui.button.disabled, true); assert.equal(ui.button.textContent, '检测中…');
  assert.equal(ui.state.gatewayProbing.has(JSON.stringify(['c1', 'claude'])), true);
  assert.equal(ui.calls.length, 1);
  assert.equal(ui.calls[0].path, '/api/channels/c1/test');
  assert.deepEqual(ui.calls[0].body, { poolId: 'claude', wait: true });
  assert.ok(ui.calls[0].signal, 'the request has its own client-side time limit');
  assert.equal(ui.toasts.length, 0, 'nothing is announced before the real outcome');
  ui.pending[0].resolve(completed());
  await running;
  assert.equal(ui.toasts.length, 1);
  assert.equal(ui.toasts[0][0], '几方 Claude 检测成功，耗时 3.2 秒 · claude-sonnet-5.5 · chat_completions');
  assert.equal(ui.toasts[0][1], 'normal');
  assert.equal(ui.button.disabled, false); assert.equal(ui.button.textContent, '检测 Claude');
  assert.equal(ui.state.gatewayProbing.size, 0);
  assert.equal(ui.refreshes.length, 1); assert.deepEqual({ ...ui.refreshes[0].options }, { quiet: true, force: true });
  assert.equal(ui.refreshes[0].busyDuringRefresh, 0, 'the list is refreshed after the busy state ended');
});

test('sub-second results are shown in milliseconds', async () => {
  const ui = setup();
  const running = ui.click();
  ui.pending[0].resolve(completed({ latencyMs: 640 }));
  await running;
  assert.match(ui.toasts[0][0], /检测成功，耗时 640 毫秒/);
});

test('a failed probe toast gives the upstream status, the reason and the duration', async () => {
  const ui = setup();
  const running = ui.click();
  ui.pending[0].resolve(completed({ success: false, statusCode: 502, errorClass: 'upstream_5xx', latencyMs: 900 }));
  await running;
  assert.equal(ui.toasts[0][0], '几方 Claude 检测失败，HTTP 502 · 上游服务错误，耗时 900 毫秒');
  assert.equal(ui.toasts[0][1], 'error');
  assert.equal(ui.button.disabled, false);
  assert.equal(ui.refreshes.length, 1, 'a failed probe is part of the history too, so the list refreshes');
});

test('a failure without any upstream answer still says what is known', async () => {
  const ui = setup();
  const running = ui.click();
  ui.pending[0].resolve(completed({ success: false, statusCode: null, errorClass: 'connect_failed', latencyMs: 1500 }));
  await running;
  assert.equal(ui.toasts[0][0], '几方 Claude 检测失败，连接上游失败，耗时 1.5 秒');
});

test('when the server stopped waiting the toast says the result will appear in the probe history', async () => {
  const ui = setup();
  const running = ui.click();
  ui.pending[0].resolve({ state: 'accepted', waitTimedOut: true });
  await running;
  assert.equal(ui.toasts[0][0], '几方 Claude 检测超时，结果稍后会出现在探活记录里');
  assert.equal(ui.toasts[0][1], 'error');
  assert.equal(ui.button.disabled, false); assert.equal(ui.refreshes.length, 1);
});

test('the client-side time limit gives the same timeout message and releases the button', async () => {
  const ui = setup();
  const running = ui.click();
  ui.pending[0].reject(Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' }));
  await running;
  assert.equal(ui.toasts[0][0], '几方 Claude 检测超时，结果稍后会出现在探活记录里');
  assert.equal(ui.button.disabled, false); assert.equal(ui.state.gatewayProbing.size, 0);
});

test('a rejected request shows its reason and releases the button', async () => {
  const ui = setup();
  const running = ui.click();
  ui.pending[0].reject(Object.assign(new Error('未设置检测模型，请在渠道设置里选择检测模型后保存'), { status: 409 }));
  await running;
  assert.equal(ui.toasts[0][0], '几方 Claude 检测失败：未设置检测模型，请在渠道设置里选择检测模型后保存');
  assert.equal(ui.toasts[0][1], 'error');
  assert.equal(ui.button.disabled, false); assert.equal(ui.button.textContent, '检测 Claude');
  assert.equal(ui.refreshes.length, 0);
});

test('a second click while the first probe runs is ignored, and the button works again afterwards', async () => {
  const ui = setup();
  const first = ui.click();
  await ui.click();
  await ui.click();
  assert.equal(ui.calls.length, 1, 'repeated clicks send nothing');
  ui.pending[0].resolve(completed());
  await first;
  const again = ui.click();
  assert.equal(ui.calls.length, 2, 'after the first probe ended the button works again');
  ui.pending[1].resolve(completed());
  await again;
});

test('a channel row keeps the busy state when the list is rendered again during a probe', () => {
  const channelActions = app.slice(app.indexOf('function channelActions('), app.indexOf('const channelGroupOrder'));
  assert.match(channelActions, /state\.gatewayProbing\.has\(JSON\.stringify\(\[channel\.id, role\.poolId\]\)\)/);
  assert.match(channelActions, /probe\.disabled = true; probe\.textContent = '检测中…'/);
  assert.doesNotMatch(source('probeGatewayChannel'), /gatewayMutation/, 'a probe does not take the configuration-change lock');
});

test('the probe column explains a channel with nothing to probe and no longer calls the gateway probe a New API test', () => {
  const quality = app.slice(app.indexOf('function channelQuality('), app.indexOf('function currentChannelHealthSettings('));
  assert.match(quality, /channel\.probeModel === null\s*\n?\s*\? '没有可探测的模型 · 不会自动探活'/);
  assert.doesNotMatch(app, /未设检测模型/);
  assert.match(quality, /state\.gatewayMode === 'gateway'\s*\n?\s*\? `后台每 \$\{channel\.probeIntervalMinutes\} 分钟经网关向上游发一次最小请求`\s*\n?\s*: `后台每 \$\{channel\.probeIntervalMinutes\} 分钟调用一次 New API 渠道检测`/);
  assert.match(quality, /未设置，取第一个可探测模型/);
});

test('the probe tooltip names the protocol the probe uses and says it is not streaming', () => {
  const quality = app.slice(app.indexOf('function channelQuality('), app.indexOf('function currentChannelHealthSettings('));
  assert.match(quality, /channel\.probeProtocol \? ` · \$\{channel\.probeProtocol\} · 非流式` : ''/);
});
