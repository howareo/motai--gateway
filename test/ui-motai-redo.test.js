import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const app = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
const css = await readFile(new URL('../public/styles.css', import.meta.url), 'utf8');
const html = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');

const productionFunction = (name) => {
  const start = app.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, name);
  const tail = app.slice(start);
  const next = tail.slice(1).search(/\n(?:async )?function /);
  return next === -1 ? tail : tail.slice(0, next + 1);
};

class Node {
  children = [];
  textContent = '';
  className = '';
  title = '';
  props = {};
  style = { setProperty: (name, value) => { this.props[name] = value; } };
  classList = { add: (name) => { this.className += ` ${name}`; }, toggle() {} };
  append(...nodes) { this.children.push(...nodes); }
  replaceChildren(...nodes) { this.children = nodes; }
  setAttribute() {}
}
const makeNode = () => new Node();

function metricsContext(channels) {
  const nodes = new Map();
  const context = vm.createContext({
    state: { overview: { channels, availability: { cacheRead: true, cacheCreate: true },
      metrics: { totalRequests: 1, requests: 1, failedRequests: 0, errorCount: 0, totalTokens: 1, inputTokens: 1, outputTokens: 1,
        cacheReadTokens: 1, cacheCreateTokens: 1, estimatedCost: 0, costCoverage: { complete: 0, partial: 0, unknown: 1 },
        failovers: 0, ttftCount: 0 } } },
    compact: new Intl.NumberFormat('en'), decimal: new Intl.NumberFormat('en'),
    $: (selector) => { if (!nodes.has(selector)) nodes.set(selector, makeNode()); return nodes.get(selector); },
    formatCost: (value) => `$${value}`, formatMs: () => '', formatTime: () => '' });
  vm.runInContext(`${productionFunction('formatTokens')}\n${productionFunction('renderMetrics')}\nrenderMetrics();`, context);
  return { nodes };
}

test('A: the available-channel note lists every vendor pool dynamically', () => {
  const pool = (routingPool, count) => Array.from({ length: count }, (_, index) => ({ id: `${routingPool}${index}`, enabled: true, routingPool, type: routingPool }));
  const { nodes } = metricsContext([...pool('Gemini', 5), ...pool('Claude', 2), ...pool('DeepSeek', 2), ...pool('OpenAI', 3), ...pool('xAI', 2)]);
  assert.equal(nodes.get('#metric-channel-note').textContent, '2 Claude · 3 OpenAI · 2 xAI · 2 DeepSeek · 5 Gemini');
  assert.equal(nodes.get('#metric-channels').textContent, '14/14');
});

test('J: an all-unpriced overview shows 未定价 and falls back to Token share instead of $0.00', () => {
  const rows = [
    { id: '1', name: 'A', requests: 10, tokens: 900, estimatedCost: 0, estimatedCostIsLowerBound: true },
    { id: '2', name: 'B', requests: 5, tokens: 100, estimatedCost: 0, estimatedCostIsLowerBound: true },
  ];
  const elements = { modelList: makeNode(), modelTotal: makeNode() };
  const context = vm.createContext({ state: { costDistributionMode: 'channel', overview: { channels: rows, modelTests: [] } }, elements,
    document: { createElement: makeNode }, $: makeNode, providerFamilyOf: () => 'openai', applyChannelColor() {},
    compact: new Intl.NumberFormat('en'), decimal: new Intl.NumberFormat('en'), formatCost: (value) => `$${value}` });
  vm.runInContext(`${productionFunction('formatTokens')}\n${productionFunction('renderModels')}\nrenderModels();`, context);
  assert.equal(elements.modelTotal.textContent, '未定价');
  const [first, second, note] = elements.modelList.children;
  const amountOf = (row) => row.children[2].children[0];
  assert.equal(amountOf(first).textContent, '未定价');
  assert.equal(amountOf(second).textContent, '未定价');
  assert.equal(first.children[1].props['--model-share'], '100%');
  assert.equal(second.children[1].props['--model-share'], '11.11111111111111%');
  assert.match(note.textContent, /成本未知.*Token/);
});

test('J: priced overviews keep dollar amounts and cost-based bars', () => {
  const rows = [
    { id: '1', name: 'A', requests: 10, tokens: 900, estimatedCost: 2, estimatedCostIsLowerBound: false },
    { id: '2', name: 'B', requests: 5, tokens: 100, estimatedCost: 1, estimatedCostIsLowerBound: true },
  ];
  const elements = { modelList: makeNode(), modelTotal: makeNode() };
  const context = vm.createContext({ state: { costDistributionMode: 'channel', overview: { channels: rows, modelTests: [] } }, elements,
    document: { createElement: makeNode }, $: makeNode, providerFamilyOf: () => 'openai', applyChannelColor() {},
    compact: new Intl.NumberFormat('en'), decimal: new Intl.NumberFormat('en'), formatCost: (value) => `$${value}` });
  vm.runInContext(`${productionFunction('formatTokens')}\n${productionFunction('renderModels')}\nrenderModels();`, context);
  assert.equal(elements.modelTotal.textContent, '$3');
  assert.equal(elements.modelList.children[0].children[2].children[0].textContent, '$2');
  assert.equal(elements.modelList.children.length, 2);
});

test('C: unpriced successful requests get a visible 未定价 tag; priced ones keep the dollar text', () => {
  const context = vm.createContext({ document: { createElement: makeNode }, formatCost: (value) => `$${value}` });
  vm.runInContext(productionFunction('costNode'), context);
  const tag = context.costNode({ kind: 'success', costStatus: 'unknown', estimatedCost: null });
  assert.equal(tag.textContent, '未定价');
  assert.equal(tag.className, 'unpriced-tag');
  assert.equal(context.costNode({ kind: 'success', costStatus: 'complete', estimatedCost: 0.5 }), '$0.5');
  assert.equal(context.costNode({ kind: 'error' }), '');
  assert.match(app, /cell\(costNode\(log\), 'estimate request-cost'\)/);
  assert.match(css, /@media \(max-width: 760px\)[\s\S]*?\.request-table \.request-cost::before \{[^}]*content: "采购真实成本"/);
});

test('D: request sub-labels map caller IDs to names and fall back to the ID', () => {
  const state = { gatewayConfig: { callers: [{ id: '2', name: 'local-openai' }] } };
  const context = vm.createContext({ state, document: { createElement: makeNode }, applyChannelColor() {} });
  vm.runInContext(`${productionFunction('routeNode')}\n${productionFunction('callerName')}`, context);
  const labelOf = (tokenName) => context.routeNode({ kind: 'success', channelId: 1, channelName: 'C', channelRoute: ['C'], stream: true, tokenName }).children[1].textContent;
  assert.equal(labelOf('2'), '流式 · local-openai');
  assert.equal(labelOf('9'), '流式 · 9');
  state.gatewayConfig = null;
  assert.equal(labelOf('2'), '流式 · 2');
  // Old rows whose New API log has no token name: just the transport, never "· null".
  for (const missing of [null, undefined, '']) assert.equal(labelOf(missing), '流式');
  const nonStream = (tokenName) => context.routeNode({ kind: 'success', channelId: 1, channelName: 'C', channelRoute: ['C'], stream: false, tokenName }).children[1].textContent;
  assert.equal(nonStream(null), '非流式');
  assert.equal(nonStream('9'), '非流式 · 9');
});

test('B: gateway mode shows 网关已连接 with the serving gen and legacy mode keeps the New API text', async () => {
  const source = app.slice(app.indexOf('async function refresh('), app.indexOf('async function loadRequests('));
  for (const [mode, expected] of [['gateway', '网关已连接 · gen 7'], ['legacy', 'New API 已连接']]) {
    const elements = { refresh: {}, connection: {}, detail: {}, overview: { classList: { remove() {} }, removeAttribute() {} } };
    const context = vm.createContext({ state: { periodKey: 'today', loading: false, pendingRefresh: null, rateLimitedUntil: 0, renderedPeriodKey: null,
      lastRefreshAt: 0, gatewayMode: mode, gatewayStatus: { servingGen: '7' }, page: 'overview' }, elements,
    api: async () => ({ generatedAt: 'x' }), periodQuery: () => new URLSearchParams(), periodDefinition: () => ({ hours: 24 }),
    render() {}, showToast() {}, refreshGatewayHealth() {} });
    vm.runInContext(source, context);
    await context.refresh();
    assert.equal(elements.connection.textContent, expected, mode);
  }
  assert.match(app, /status\.mode === 'gateway' \? '墨台网关' : 'New API Ops · Local'/);
});

function starEnvironment({ reduced, visible = true, active = true }) {
  const calls = { draw: 0, frames: 0, cancelled: 0 };
  const ctx = new Proxy({}, { get: (_target, name) => {
    if (name === 'createRadialGradient') return () => ({ addColorStop() {} });
    return () => { calls.draw += 1; };
  }, set: () => true });
  const env = { canvas: {}, ctx, size: () => ({ width: 600, height: 320, dpr: 3 }), particleCap: () => 300,
    requestFrame: () => { calls.frames += 1; return calls.frames; }, cancelFrame: () => { calls.cancelled += 1; },
    reduced: () => reduced, isVisible: () => visible, isActive: () => active, navigate() {}, showTip() {}, hideTip() {} };
  return { env, calls };
}

function starContext(env) {
  const source = app.slice(app.indexOf('const starColors'), app.indexOf('const starState = '));
  const context = vm.createContext({ providerFamilyOf: () => 'openai', channelColors: { openai: ['#74d4a8'], unknown: ['#ccc'] }, formatCost: (value) => `$${value}`, Math });
  vm.runInContext(source, context);
  return context;
}

const starChannels = [
  { id: '1', name: 'Alpha', enabled: true, state: 'healthy', routingPool: 'OpenAI', requests: 30, estimatedCost: 3 },
  { id: '2', name: 'Beta', enabled: true, state: 'failing', routingPool: 'Claude', requests: 10, estimatedCost: 0 },
  { id: '3', name: 'Gamma', enabled: false, state: 'disabled', routingPool: 'Claude', requests: 0, estimatedCost: 0 },
];

test('star map: reduced motion draws one static frame and never requests an animation frame', () => {
  const { env, calls } = starEnvironment({ reduced: true });
  const context = starContext(env);
  const map = context.createStarMap(env);
  map.resize();
  map.setModel(context.buildStarModel(starChannels));
  map.start();
  assert.equal(calls.frames, 0);
  assert.equal(map.isRunning(), false);
  assert.ok(calls.draw > 0, 'a static frame was painted');
  assert.equal(map.view.dpr, 2, 'device pixel ratio is capped at 2');
});

test('star map: animates only while visible and on the overview page, and stops on demand', () => {
  for (const options of [{ visible: false }, { active: false }]) {
    const { env, calls } = starEnvironment({ reduced: false, ...options });
    const context = starContext(env);
    const map = context.createStarMap(env);
    map.resize();
    map.setModel(context.buildStarModel(starChannels));
    map.start();
    assert.equal(calls.frames, 0, JSON.stringify(options));
  }
  const { env, calls } = starEnvironment({ reduced: false });
  const context = starContext(env);
  const map = context.createStarMap(env);
  map.resize();
  map.setModel(context.buildStarModel(starChannels));
  map.start();
  assert.equal(calls.frames, 1);
  assert.equal(map.isRunning(), true);
  map.stop();
  assert.equal(calls.cancelled, 1);
  assert.equal(map.isRunning(), false);
});

test('star map: groups channels into pools, colours health, and summarises for screen readers', () => {
  const context = starContext(starEnvironment({ reduced: true }).env);
  const model = context.buildStarModel(starChannels);
  // 数组来自 vm 上下文，原型不同，先转成本领域数组再比较。
  assert.deepEqual(Array.from(model.pools, (pool) => pool.name), ['Claude', 'OpenAI']);
  const claude = model.pools[0];
  assert.deepEqual(Array.from(claude.channels, (channel) => channel.health), ['failing', 'disabled']);
  assert.equal(model.totalRequests, 40);
  const summary = context.starSummary(model);
  assert.match(summary, /2 个厂商池/);
  assert.match(summary, /Claude 池 2 个渠道.*成本未定价/);
  assert.match(summary, /OpenAI 池 1 个渠道，30 次请求，成本\$3/);
  assert.match(html, /<canvas id="starmap-canvas" aria-hidden="true">/);
  assert.match(html, /id="starmap-summary" class="sr-only"/);
});

test('G: the channel page uses card classes at 1099px and below', () => {
  assert.match(html, /<table class="data-table channel-table channel-cards">/);
  assert.match(css, /@media \(max-width: 1099px\) \{\s*\.channel-cards, \.channel-cards tbody \{ display: block; \}/);
  assert.match(css, /\.channel-cards tr\.channel-row \{[^}]*display: grid;/);
  assert.match(css, /\.channel-cards tbody \{ display: grid; grid-template-columns: repeat\(2, minmax\(0, 1fr\)\);/);
  assert.match(css, /@media \(max-width: 719px\) \{\s*\.channel-cards tbody \{ grid-template-columns: minmax\(0, 1fr\);/);
});

test('H: model chips show every model in one column without breaking model names on desktop or mobile', () => {
  const context = vm.createContext({ document: { createElement: makeNode } });
  vm.runInContext(productionFunction('modelPills'), context);
  const list = context.modelPills(['claude-opus-5-5', 'm2', 'm3', 'm4']);
  assert.deepEqual(list.children.map((chip) => chip.textContent), ['claude-opus-5-5', 'm2', 'm3', 'm4']);
  assert.deepEqual(list.children.map((chip) => chip.title), ['claude-opus-5-5', 'm2', 'm3', 'm4']);
  assert.equal(context.modelPills([]).children.length, 0);
  assert.match(css, /\.pill-list \{[^}]*flex-direction: column;[^}]*align-items: flex-start;/);
  assert.doesNotMatch(css, /\.pill-list \{[^}]*flex-direction: row;/);
  assert.doesNotMatch(css, /\.channel-cards \.pill-list \{[^}]*flex-wrap: nowrap;/);
  const chipRule = [...css.matchAll(/\.pill-list span \{([^}]*)\}/g)].at(-1)?.[1] || '';
  assert.match(chipRule, /white-space: nowrap;/);
  assert.match(chipRule, /text-overflow: ellipsis;/);
  assert.match(chipRule, /overflow-wrap: normal;/);
});

test('E: the mobile request filters collapse into a bottom sheet with removable chips', () => {
  for (const id of ['request-filter-toggle', 'request-filters', 'active-filters', 'filter-backdrop', 'request-filter-done']) assert.match(html, new RegExp(`id="${id}"`));
  for (const id of ['channel-filter', 'model-filter', 'status-filter', 'stream-filter', 'request-refresh-button']) assert.match(html, new RegExp(`id="${id}"`));
  assert.match(css, /@media \(max-width: 719px\) \{\s*\.request-tools \{ width: 100%; \}/);
  assert.match(css, /\.request-tools \.filters \{ position: fixed;[^}]*transform: translateY\(105%\)/);
  assert.match(app, /function renderActiveFilters\(\)/);
});

test('motion: rolling numbers, trend drawing and tilt are all gated by reduced motion', () => {
  assert.match(productionFunction('rollNumber'), /motionReduced\(\) \|\| document\.hidden/);
  assert.match(productionFunction('tiltCard'), /motionReduced\(\)/);
  assert.match(css, /:root\[data-motion="reduce"\] \*,/);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)/);
  assert.match(css, /@media \(pointer: coarse\) \{ \.metric \{ transform: none !important; \}/);
});
