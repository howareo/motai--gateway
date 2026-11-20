import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const app = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
const css = await readFile(new URL('../public/styles.css', import.meta.url), 'utf8');

const HINT = '同一渠道 5 分钟内第 3 次失败，之后 60 秒新请求改走备用渠道';
const productionFunction = (name) => {
  const start = app.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, name);
  const tail = app.slice(start), next = tail.slice(1).search(/\n(?:async )?function /);
  return next === -1 ? tail : tail.slice(0, next + 1);
};

class FakeNode {
  constructor(tag) { this.tag = tag; this.children = []; this.className = ''; this.textContent = ''; this.title = ''; this.dataset = {};
    this.classList = { add: (name) => { this.className = `${this.className} ${name}`.trim(); }, toggle() {} }; }
  append(...nodes) { this.children.push(...nodes); }
  setAttribute() {}
}
const walk = (node, found = []) => { found.push(node); for (const child of node.children || []) if (typeof child === 'object') walk(child, found); return found; };
const withClass = (node, name) => walk(node).filter((item) => item.className?.split(' ').includes(name));

function metricsText(metrics) {
  const nodes = new Map();
  const context = vm.createContext({ state: { overview: { channels: [], availability: { cacheRead: false, cacheCreate: false },
    metrics: { totalRequests: 1, requests: 1, failedRequests: 0, errorCount: 0, totalTokens: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0,
      cacheCreateTokens: 0, estimatedCost: null, costCoverage: { complete: 0, partial: 0, unknown: 1 }, ttftCount: 0, ...metrics } } },
    compact: new Intl.NumberFormat('en'), decimal: new Intl.NumberFormat('en'),
    $: (selector) => { if (!nodes.has(selector)) nodes.set(selector, new FakeNode('x')); return nodes.get(selector); },
    formatCost: () => '', formatMs: () => '', formatTime: () => '' });
  vm.runInContext(`const COOLDOWN_HINT = ${JSON.stringify(HINT)};\n${productionFunction('formatTokens')}\n${productionFunction('renderMetrics')}\nrenderMetrics();`, context);
  return { value: nodes.get('#metric-failover').textContent, note: nodes.get('#metric-failover-note').textContent };
}

test('the auto switch card adds cooldown switches to the old same-request failovers and explains both', () => {
  assert.deepEqual(metricsText({ cooldowns: 17, failovers: 3 }), { value: '20', note: '冷却换渠道 17 · 旧 New API 同请求换渠道 3' });
  assert.deepEqual(metricsText({ cooldowns: 0, failovers: 0 }), { value: '0', note: '冷却换渠道 0 · 旧 New API 同请求换渠道 0' });
  assert.deepEqual(metricsText({ failovers: 2 }), { value: '2', note: '冷却换渠道 0 · 旧 New API 同请求换渠道 2' }, 'an older server without the figure');
});

function routeLabel(log) {
  const context = vm.createContext({ document: { createElement: (tag) => new FakeNode(tag) }, applyChannelColor: () => {}, callerName: (id) => id,
    Object });
  vm.runInContext(`const COOLDOWN_HINT = ${JSON.stringify(HINT)};\n${productionFunction('isClientCancelled')}\n${productionFunction('routeNode')}`, context);
  return context.routeNode({ channelName: 'C', channelRoute: ['C'], stream: true, tokenName: 'tok', providerFamily: 'openai', channelId: '1',
    kind: 'error', statusCode: 524, source: 'motai', ...log });
}

test('a request row that tripped a cooldown carries a 触发冷却 tag with the explanation; other rows do not', () => {
  const tagged = withClass(routeLabel({ cooldownTriggered: true }), 'cooldown-tag');
  assert.equal(tagged.length, 1);
  assert.equal(tagged[0].textContent, '触发冷却');
  assert.equal(tagged[0].title, HINT);
  assert.equal(withClass(routeLabel({ cooldownTriggered: false }), 'cooldown-tag').length, 0);
  assert.equal(withClass(routeLabel({}), 'cooldown-tag').length, 0);
  const small = walk(routeLabel({ cooldownTriggered: true })).find((item) => item.tag === 'small');
  assert.equal(small.textContent, 'HTTP 524 · 上游错误', 'the existing label is kept in front of the tag');
  assert.equal(small.children[0], ' · ');
  assert.match(css, /\.route-cell \.cooldown-tag \{[^}]*color: var\(--warning\)/);
});

test('the detail field tells a same-request failover, a cooldown trigger and an ordinary request apart', () => {
  const context = vm.createContext({ decimal: { format: String }, formatTime: () => 't', formatCost: () => '', formatMs: () => '', latencyTiers: () => ({}) });
  vm.runInContext([productionFunction('isClientCancelled'), productionFunction('requestDetailFields')].join('\n'), context);
  const field = (log) => Object.fromEntries(context.requestDetailFields({ createdAt: 'x', channelName: 'C', channelRoute: ['C'], ...log }))['自动切换'];
  assert.equal(field({ failover: true }), '是（同一请求换渠道）');
  assert.equal(field({ cooldownTriggered: true }), '触发冷却（之后 60 秒新请求走备用渠道）');
  assert.equal(field({ failover: false, cooldownTriggered: false }), '否');
  assert.equal(field({}), '否');
});

function qualityNode(channel) {
  const context = vm.createContext({ state: { gatewayMode: 'gateway' }, decimal: new Intl.NumberFormat('en'), formatMs: () => '', formatTime: () => 't',
    document: { createElement: (tag) => new FakeNode(tag) } });
  vm.runInContext(`const COOLDOWN_HINT = ${JSON.stringify(HINT)};\n${productionFunction('channelQuality')}`, context);
  return context.channelQuality({ enabled: true, recentProbes: [], probeSuccessRate: null, probeAttempts: 0, probeIntervalMinutes: 15, probePeriodHours: 24,
    probeModel: 'm', ...channel });
}

test('a channel that tripped a cooldown shows 冷却 N 次 above the probe strip, and one that did not shows nothing extra', () => {
  const node = qualityNode({ cooldowns: 4 });
  const [tag] = withClass(node, 'availability-cooldown');
  assert.equal(tag.textContent, '冷却 4 次');
  assert.equal(tag.title, HINT);
  const kinds = node.children.map((child) => child.className.split(' ')[0]);
  assert.deepEqual(kinds, ['availability-heading', 'availability-summary', 'availability-cooldown', 'availability-strip']);
  for (const channel of [{ cooldowns: 0 }, {}]) {
    assert.equal(withClass(qualityNode(channel), 'availability-cooldown').length, 0);
    assert.deepEqual(qualityNode(channel).children.map((child) => child.className.split(' ')[0]), ['availability-heading', 'availability-summary', 'availability-strip']);
  }
  assert.match(css, /\.quality-cell \.availability-cooldown[^{]*\{[^}]*color: var\(--warning\)/);
});
