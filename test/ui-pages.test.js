import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const app = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
const html = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');

const productionFunction = (name) => {
  const start = app.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, name);
  const tail = app.slice(start);
  const next = tail.slice(1).search(/\n(?:async )?function /);
  return next === -1 ? tail : tail.slice(0, next + 1);
};
const pageNamesSource = app.match(/const pageNames = \[[^\]]*\];/)[0];
const pages = ['overview', 'channels', 'requests', 'settings'];

function routerHarness(initialHash = '') {
  const panels = pages.map((name) => ({ dataset: { pagePanel: name }, hidden: name !== 'overview' }));
  const links = pages.map((name) => {
    const attributes = name === 'overview' ? { 'aria-current': 'page' } : {};
    return { dataset: { page: name }, setAttribute(key, value) { attributes[key] = value; }, removeAttribute(key) { delete attributes[key]; }, attributes };
  });
  const scrolls = [];
  const rendered = [];
  const window = { scrollY: 0, location: { hash: initialHash }, scrollTo: (options) => scrolls.push(options),
    history: { replaced: [], replaceState(_state, _title, url) { this.replaced.push(url); window.location.hash = url; } } };
  const document = { body: { dataset: {} },
    querySelectorAll: (selector) => (selector === '[data-page-panel]' ? panels : selector === '.page-nav [data-page]' ? links : []) };
  const state = { page: null, pageScroll: {}, pageVisited: new Set() };
  const context = vm.createContext({ state, window, document, renderPage: (name) => rendered.push(name),
    refreshGatewayHealth: async () => {} });
  vm.runInContext([pageNamesSource, productionFunction('pageFromHash'), productionFunction('showPage'), productionFunction('routeFromHash')].join('\n'), context);
  const visible = () => panels.filter((panel) => !panel.hidden).map((panel) => panel.dataset.pagePanel);
  return { context, window, panels, links, state, scrolls, rendered, visible };
}

test('each hash shows only its own page and marks one nav link current', () => {
  for (const name of pages) {
    const h = routerHarness(`#${name}`);
    h.context.routeFromHash();
    assert.deepEqual(h.visible(), [name], name);
    assert.deepEqual(h.links.filter((link) => link.attributes['aria-current']).map((link) => link.dataset.page), [name], name);
    assert.equal(h.context.document.body.dataset.page, name);
    assert.equal(h.window.history.replaced.length, 0);
  }
});

test('an unknown hash falls back to the overview page and rewrites the address', () => {
  const h = routerHarness('#nope');
  h.context.routeFromHash();
  assert.deepEqual(h.visible(), ['overview']);
  assert.deepEqual(h.window.history.replaced, ['#overview']);
  const empty = routerHarness('');
  empty.context.routeFromHash();
  assert.deepEqual(empty.visible(), ['overview']);
  assert.equal(empty.window.history.replaced.length, 0);
});

test('switching pages keeps each page scroll position and works for back/forward', () => {
  const h = routerHarness('#overview');
  h.context.routeFromHash();
  h.window.scrollY = 320;
  h.window.location.hash = '#requests';
  h.context.routeFromHash();
  assert.equal(h.scrolls.at(-1).top, 0);
  h.window.scrollY = 90;
  h.window.location.hash = '#overview';
  h.context.routeFromHash();
  assert.deepEqual(h.visible(), ['overview']);
  assert.equal(h.scrolls.at(-1).top, 320);
  h.window.location.hash = '#requests';
  h.context.routeFromHash();
  assert.equal(h.scrolls.at(-1).top, 90);
  assert.equal(h.panels.find((panel) => panel.dataset.pagePanel === 'requests').dataset.enter, 'revisit');
});

test('route changes render only the page being shown', () => {
  const h = routerHarness('#settings');
  h.context.routeFromHash();
  h.window.location.hash = '#settings';
  h.context.routeFromHash();
  assert.deepEqual(h.rendered, ['settings']);
});

test('the retired #pricing route is an unknown page and falls back to the overview', () => {
  const h = routerHarness('#pricing');
  h.context.routeFromHash();
  assert.deepEqual(h.visible(), ['overview']);
  assert.deepEqual(h.window.history.replaced, ['#overview']);
  assert.equal(h.context.pageFromHash('#pricing'), null);
});

test('index.html has one container per page and a hash link for each', () => {
  for (const name of pages) {
    assert.match(html, new RegExp(`id="page-${name}" class="page" data-page-panel="${name}"`));
    assert.match(html, new RegExp(`<a href="#${name}" data-page="${name}"`));
  }
  assert.equal([...html.matchAll(/data-page-panel="/g)].length, 4);
  assert.match(html, /viewport-fit=cover/);
});

class FakeNode { constructor(tag) { this.tag = tag; this.children = []; this.className = ''; this.textContent = ''; this.hidden = false; }
  append(...nodes) { this.children.push(...nodes); } replaceChildren(...nodes) { this.children = nodes; } }

function pricingSyncContext(overview) {
  const body = new FakeNode('tbody'); const empty = new FakeNode('div'); const summary = new FakeNode('span');
  const context = vm.createContext({ state: { overview }, Node: FakeNode, document: { createElement: (tag) => new FakeNode(tag) },
    money: new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 6 }),
    cell: (value) => { const td = new FakeNode('td'); td.textContent = value === null || value === undefined ? '' : String(value); return td; },
    elements: { pricingSyncBody: body, pricingSyncEmpty: empty, pricingSummary: summary } });
  vm.runInContext(productionFunction('renderPricingSync'), context);
  return { context, body, empty, summary };
}

test('pricing page renders one row per model with the eight old-console columns', () => {
  const { context, body, empty, summary } = pricingSyncContext({
    newApiPricingSync: { lastError: null },
    pricingCatalog: [
      { model: 'm1', family: 'anthropic', rates: { input: 2, output: 8, cacheRead: 0.5, cacheWrite: 2.5 }, channels: ['A', 'B'], priceSource: '官方' },
      { model: 'm2', family: 'openai', rates: { input: 1, output: 4 }, channels: ['C'] },
      { model: 'm3', family: null, rates: null, channels: ['D'] }] });
  context.renderPricingSync();
  assert.equal(body.children.length, 3);
  const cells = (row) => row.children.map((node) => node.textContent);
  assert.deepEqual(cells(body.children[0]), ['m1', 'anthropic', '$2.00', '$8.00', '$0.50', '$2.50', 'A、B', '官方']);
  assert.deepEqual(cells(body.children[1]), ['m2', 'openai', '$1.00', '$4.00', '—', '—', 'C', 'models.dev']);
  assert.deepEqual(cells(body.children[2]), ['m3', '—', '—', '—', '—', '—', 'D', '未定价']);
  assert.equal(summary.textContent, '已配置模型 3 个 · 已定价 2 个 · 未定价 1 个');
  assert.equal(empty.hidden, true);
  const emptyCase = pricingSyncContext({ pricingCatalog: [] });
  emptyCase.context.renderPricingSync();
  assert.equal(emptyCase.body.children.length, 0);
  assert.equal(emptyCase.empty.hidden, false);
});

test('navigation has exactly four items and no pricing page exists', () => {
  const nav = html.slice(html.indexOf('<nav class="page-nav"'), html.indexOf('</nav>'));
  assert.deepEqual([...nav.matchAll(/data-page="(\w+)"/g)].map((m) => m[1]), ['overview', 'channels', 'requests', 'settings']);
  assert.deepEqual([...nav.matchAll(/<span>([^<]*)<\/span>/g)].map((m) => m[1]), ['概览', '渠道', '请求', '设置']);
  assert.doesNotMatch(html, /page-pricing|data-page-panel="pricing"|href="#pricing"|data-page="pricing"/);
  assert.doesNotMatch(app, /name === 'pricing'|'pricing'/);
  assert.match(app, /const pageNames = \['overview', 'channels', 'requests', 'settings'\];/);
});

test('the settings page holds the settings cards and the 模型价格 table, both full width', () => {
  const page = html.slice(html.indexOf('id="page-settings"'), html.indexOf('</main>'));
  assert.match(page, /<h2>设置<\/h2>/);
  assert.match(page, /<h2>模型价格<\/h2>/);
  assert.ok(page.indexOf('<h2>设置</h2>') < page.indexOf('<h2>模型价格</h2>'), '设置在上，模型价格在下');
  assert.match(page, /class="settings-columns"/);
  assert.match(page, /id="settings-callers-slot"/);
  assert.match(app.slice(app.indexOf('function renderSettingsPage('), app.indexOf('function renderPage(')), /renderPricingSync\(\)/);
});

test('model price table markup is a single table with the old column headers and no dropdowns, pillars or dialog', () => {
  const page = html.slice(html.indexOf('id="page-settings"'), html.indexOf('</main>'));
  const headers = [...page.matchAll(/<th>([^<]*)<\/th>/g)].map((m) => m[1]);
  assert.deepEqual(headers, ['模型', '协议', '输入 $/M', '输出 $/M', '缓存读 $/M', '缓存写 $/M', '渠道', '价格来源']);
  assert.match(page, /id="pricing-sync-body"/);
  assert.match(page, /id="pricing-page-summary"/);
  assert.doesNotMatch(html, /pricing-channel|pricing-model|pricing-pillars|pricing-detail|pricing-sync-dialog|全部模型价格表/);
});

test('request detail only exposes whitelisted summary fields and never body-like data', () => {
  const context = vm.createContext({ decimal: new Intl.NumberFormat('en'), formatTime: () => '10-28 12:00:00',
    formatCost: (value) => (value === null || value === undefined ? '' : `$${value}`), formatMs: (value) => (value === null || value === undefined ? '' : `${value} ms`) });
  const thresholds = app.match(/const latencyThresholds = Object\.freeze\(\{[\s\S]*?\}\);/)[0];
  vm.runInContext([thresholds, productionFunction('ttftTier'), productionFunction('durationTier'), productionFunction('latencyTiers'), productionFunction('isClientCancelled'), productionFunction('requestDetailFields')].join('\n'), context);
  const secret = 'BODY-SENTINEL-DO-NOT-RENDER';
  const log = { kind: 'success', createdAt: 'x', channelName: 'C', channelRoute: ['C'], tokenName: 'tok', model: 'm', reasoningEffort: 'high', stream: true,
    failover: false, inputTokens: 10, outputTokens: 5, cacheReadTokens: null, cacheCreateTokens: 0, estimatedCost: 0.5, costStatus: 'complete',
    ttftMs: 120, durationMs: 900, outputTokensPerSecond: 12.34, content: secret, body: secret, requestBody: secret, responseBody: secret,
    prompt: secret, response: secret, messages: [{ content: secret }], errorBody: secret, rawRequest: secret };
  const fields = context.requestDetailFields(log);
  assert.ok(!JSON.stringify(fields).includes(secret));
  const labels = fields.map(([label]) => label);
  for (const forbidden of ['正文', '请求体', '响应体', '内容', 'prompt', 'body']) assert.ok(!labels.some((label) => label.includes(forbidden)), forbidden);
  const by = Object.fromEntries(fields);
  assert.equal(by['缓存读取 Token'], '未知');
  assert.equal(by['缓存写入 Token'], '0');
  assert.equal(by['输出 TPS'], '12.3 tok/s');
  const failed = Object.fromEntries(context.requestDetailFields({ ...log, kind: 'error', statusCode: 502, errorMessage: 'upstream bad gateway' }));
  assert.equal(failed['结果'], '失败 · HTTP 502');
  assert.equal(failed['错误摘要'], 'upstream bad gateway');
  assert.equal(failed['输入 Token'], '未知');
  assert.doesNotMatch(app.slice(app.indexOf('function openRequestDetail('), app.indexOf('function syncFilters(')), /\.(content|body|prompt|messages)\b/);
});
