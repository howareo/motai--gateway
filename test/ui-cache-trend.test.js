import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const app = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
const trendSource = app.slice(app.indexOf('function cacheTrendSummary('), app.indexOf('function routeNode('));
const refreshSource = app.slice(app.indexOf('async function refresh('), app.indexOf('async function loadRequests('));

class Element {
  children = [];
  attributes = {};
  className = '';
  classList = { add: () => {}, remove: () => {} };
  constructor(tagName) { this.tagName = tagName; }
  append(...children) { this.children.push(...children); }
  add(child) { this.append(child); }
  replaceChildren(...children) { this.children = children; }
  setAttribute(name, value) { this.attributes[name] = value; }
  removeAttribute(name) { delete this.attributes[name]; }
}

function trendContext(overview, trendChannelId = '') {
  const context = vm.createContext({
    state: { overview, trendChannelId, hours: 24 },
    elements: { trendChannel: new Element('select'), trendSummary: new Element('div'), trendChart: new Element('div') },
    document: { createElement: (tag) => new Element(tag), createElementNS: (_, tag) => new Element(tag) },
    Option: class extends Element {
      constructor(label, value) { super('option'); this.textContent = label; this.value = value; }
    },
    formatTokens: (value) => value === null ? '' : String(value),
    formatTime: (value) => value,
    decimal: new Intl.NumberFormat('en-US'),
  });
  vm.runInContext(trendSource, context);
  return context;
}

test('weights cache hit rate by known input tokens and excludes missing usage from the denominator', () => {
  const context = trendContext({});
  const summary = context.cacheTrendSummary([
    { input: 1, output: 100, cacheRead: 9, cacheCreate: 0, cacheKnownInput: 10, cacheKnownRead: 9 },
    { input: 90, output: 2, cacheRead: 0, cacheCreate: 0, cacheKnownInput: 90, cacheKnownRead: 0 },
    { input: 500, output: 10, cacheRead: null, cacheCreate: null, cacheKnownInput: 0, cacheKnownRead: 0 },
  ]);
  assert.equal(summary.cacheHitRate, 0.09);
  assert.equal(summary.total, 712);
  assert.equal(context.cacheTrendSummary([]).cacheHitRate, null);
  const missing = context.cacheTrendSummary([{ input: 7, output: 3, cacheRead: null, cacheCreate: null, cacheKnownInput: 0, cacheKnownRead: 0 }]);
  assert.equal(missing.cacheRead, null);
  assert.equal(missing.cacheCreate, null);
  assert.equal(missing.cacheHitRate, null);
});

test('selects channel aggregates and draws zero rates while leaving unknown intervals disconnected', () => {
  const point = (time, rate, input, read) => ({
    time, input, output: 5, cacheRead: read, cacheCreate: 2,
    cacheHitRate: rate, cacheKnownInput: rate === null ? 0 : 100, cacheKnownRead: rate === null ? 0 : rate * 100,
    cacheKnownRequests: rate === null ? 0 : 1, requests: 3,
  });
  const context = trendContext({
    trend: [point('all', 1, 999, 999)],
    channelTrends: [{ channelId: 42, channelName: 'Selected', trend: [
      point('2026-10-19T00:00:00Z', 0, 10, 0), point('2026-10-19T01:00:00Z', null, 20, null),
      point('2026-10-19T02:00:00Z', 0.75, 30, 75), point('2026-10-19T03:00:00Z', 1, 40, 100),
    ] }],
  }, '42');
  context.renderTrend();
  assert.equal(context.elements.trendChannel.value, '42');
  assert.equal(context.elements.trendSummary.children[0].children[1].textContent, '100');
  assert.equal(context.elements.trendSummary.children[5].children[1].textContent, '58.3%');
  assert.match(context.elements.trendSummary.children[5].children[1].title, /命中率覆盖 3 \/ 12 个请求/);
  const [yAxis, svg] = context.elements.trendChart.children;
  assert.deepEqual(yAxis.children.map((item) => item.textContent), ['100%', '50%', '0%']);
  const dots = svg.children.filter((item) => item.tagName === 'circle');
  const lines = svg.children.filter((item) => item.tagName === 'polyline');
  assert.equal(dots.length, 3);
  assert.equal(dots[0].attributes.cy, '142.00');
  assert.equal(dots[2].attributes.cy, '4.00');
  assert.equal(lines.length, 1);
  assert.equal(lines[0].attributes.points, '666.67,38.50 1000.00,4.00');
});

test('spaces points by elapsed time and leaves hours without requests disconnected', () => {
  const context = trendContext({
    periodHours: 24,
    trend: [0, 1, 9, 10].map((hour) => ({ time: `2026-10-19T${String(hour).padStart(2, '0')}:00:00Z`, cacheHitRate: 0.5 })),
  });
  context.renderTrend();
  const svg = context.elements.trendChart.children[1];
  assert.deepEqual(svg.children.filter((item) => item.tagName === 'circle').map((item) => item.attributes.cx), ['0.00', '100.00', '900.00', '1000.00']);
  assert.deepEqual(svg.children.filter((item) => item.tagName === 'polyline').map((item) => item.attributes.points), [
    '0.00,73.00 100.00,73.00', '900.00,73.00 1000.00,73.00',
  ]);
  context.state.overview.periodHours = 168;
  context.state.overview.trend = [19, 20].map((day) => ({ time: `2026-10-${day}T00:00:00Z`, cacheHitRate: 0.5 }));
  context.renderTrend();
  assert.equal(context.elements.trendChart.children[1].children.filter((item) => item.tagName === 'polyline').length, 1);
});

test('draws a single known period as one dot instead of refusing to plot', () => {
  const context = trendContext({
    periodHours: 24,
    trend: [{ time: '2026-10-19T00:00:00Z', cacheHitRate: 0.4, input: 60, output: 5, cacheRead: 40, cacheCreate: 0 }],
  });
  context.renderTrend();
  const chart = context.elements.trendChart;
  assert.doesNotMatch(String(chart.textContent ?? ''), /至少需要 2 个时段/);
  const svg = chart.children[1];
  const dots = svg.children.filter((item) => item.tagName === 'circle');
  assert.equal(dots.length, 1);
  assert.equal(dots[0].attributes.cx, '500.00');
  assert.equal(dots[0].children[0].textContent, '2026-10-19T00:00:00Z · 40.0%');
  assert.equal(svg.children.filter((item) => item.tagName === 'polyline').length, 0);
});

test('keeps empty channel metrics blank and retains the selected channel across refreshes', () => {
  const context = trendContext({
    trend: [{ input: 999, cacheHitRate: 1 }],
    channelTrends: [{ channelId: 7, channelName: 'Empty', trend: [] }],
  }, '7');
  context.renderTrend();
  context.renderTrend();
  assert.equal(context.state.trendChannelId, '7');
  assert.ok(context.elements.trendSummary.children.every((item) => item.children[1].textContent === ''));
  assert.equal(context.elements.trendChart.textContent, '暂无趋势数据');
});

test('discards an old period response and refreshes the latest selected period after an in-flight request', async () => {
  const requests = [];
  const renders = [];
  const context = vm.createContext({
    state: { periodKey: 'today', loading: false, pendingRefresh: null, rateLimitedUntil: 0, renderedPeriodKey: null, lastRefreshAt: 0 },
    elements: { refresh: {}, connection: {}, detail: {}, overview: new Element('main') },
    api: (path) => new Promise((resolve) => requests.push({ path, resolve })),
    periodQuery: (key) => new URLSearchParams({ period: key }),
    periodDefinition: () => ({ hours: 24 }),
    render: () => renders.push(context.state.overview),
    showToast: () => {},
  });
  vm.runInContext(refreshSource, context);
  const pending = context.refresh();
  context.state.periodKey = 'yesterday';
  await context.refresh();
  requests[0].resolve({ generatedAt: 'old' });
  await new Promise(setImmediate);
  assert.equal(requests.length, 2);
  assert.deepEqual(requests.map((request) => request.path), ['/api/overview?period=today', '/api/overview?period=yesterday']);
  assert.equal(renders.length, 0);
  requests[1].resolve({ generatedAt: 'current' });
  await pending;
  assert.equal(renders.length, 1);
  assert.equal(context.state.overview.generatedAt, 'current');
  assert.equal(context.state.loading, false);
});

test('period switches reuse cached aggregates and global refresh avoids a second forced log request', () => {
  const periodHandler = app.slice(app.indexOf("for (const button of document.querySelectorAll('[data-period]'))"), app.indexOf("for (const button of document.querySelectorAll('[data-cost-distribution]'))"));
  assert.match(periodHandler, /refresh\(\)/);
  assert.doesNotMatch(periodHandler, /force: true/);
  assert.match(app, /elements\.refresh\.addEventListener\('click', \(\) => refresh\(\{ force: true \}\)\)/);
});
