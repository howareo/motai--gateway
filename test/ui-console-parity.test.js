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

class FakeNode {
  constructor(tag) { this.tag = tag; this.children = []; this.className = ''; this.textContent = ''; this.title = ''; this.dataset = {};
    this.classList = { add: (name) => { this.className = `${this.className} ${name}`.trim(); } }; }
  append(...nodes) { this.children.push(...nodes); }
}

function routeContext() {
  const context = vm.createContext({ document: { createElement: (tag) => new FakeNode(tag) }, applyChannelColor: () => {}, callerName: (id) => id });
  vm.runInContext([productionFunction('isClientCancelled'), productionFunction('routeNode')].join('\n'), context);
  return context;
}
const walk = (node, found = []) => { found.push(node); for (const child of node.children || []) walk(child, found); return found; };
const legacyBadges = (node) => walk(node).filter((item) => item.className?.split(' ').includes('legacy-badge'));
const baseLog = { channelName: 'Old Relay', channelRoute: ['Old Relay'], stream: true, tokenName: 'tok', providerFamily: 'anthropic', channelId: '9', kind: 'success' };

test('任务3：周期定义含 90 天和全部，按钮、网格列数同步', () => {
  const block = app.slice(app.indexOf('const periodDefinitions = Object.freeze({'), app.indexOf('});', app.indexOf('const periodDefinitions')) + 3);
  const definitions = vm.runInNewContext(`${block.replace('const periodDefinitions =', 'result =')}; result`);
  assert.deepEqual(JSON.parse(JSON.stringify(definitions['hours-2160'])), { label: '90 天', query: { hours: 2160 }, hours: 2160 });
  assert.deepEqual(JSON.parse(JSON.stringify(definitions.all)), { label: '全部', query: { period: 'all' }, hours: 2160 });
  assert.deepEqual(Object.keys(definitions), ['today', 'yesterday', 'hours-24', 'hours-168', 'hours-720', 'hours-2160', 'all']);
  assert.match(html, /data-period="hours-2160">90 天</);
  assert.match(html, /data-period="all">全部</);
  assert.equal([...html.matchAll(/<button type="button" data-period=/g)].length, 7);
  assert.match(css, /\.period-control \{ display: grid; grid-template-columns: repeat\(7, minmax\(62px, 1fr\)\)/);
});

test('任务3：手机 390 宽周期条改为 4 列换行，最后一个按钮跨两列，不横向溢出', () => {
  const mobile = css.slice(css.indexOf('.period-control { width: 100%; grid-template-columns: repeat(4,'));
  assert.ok(mobile.length > 0);
  assert.match(css, /\.period-control \{ width: 100%; grid-template-columns: repeat\(4, minmax\(0, 1fr\)\); \}/);
  assert.match(css, /\.period-control button:last-child \{ grid-column: span 2; \}/);
});

test('任务3：旧历史行（含成功和失败）在渠道单元格里有“旧 New API”标签，网关行没有', () => {
  const context = routeContext();
  const legacyOk = context.routeNode({ ...baseLog, source: 'legacy' });
  const legacyFail = context.routeNode({ ...baseLog, source: 'legacy', kind: 'error', statusCode: 502 });
  const gateway = context.routeNode({ ...baseLog, source: 'motai' });
  const untagged = context.routeNode({ ...baseLog });
  for (const node of [legacyOk, legacyFail]) {
    const badges = legacyBadges(node);
    assert.equal(badges.length, 1);
    assert.equal(badges[0].textContent, '旧 New API');
    assert.ok(walk(node).some((item) => item.tag === 'strong' && item.textContent === 'Old Relay'), '渠道名照常渲染');
  }
  assert.ok(walk(legacyFail).some((item) => item.tag === 'small' && item.textContent === 'HTTP 502 · 上游错误'));
  assert.equal(legacyBadges(gateway).length, 0);
  assert.equal(legacyBadges(untagged).length, 0);
  assert.match(css, /\.legacy-badge \{[^}]*border: 1px solid var\(--line-strong\)[^}]*color: var\(--muted\)/);
});

test('任务3：分页游标原样回传，前端不解析也不拼接', () => {
  const loader = productionFunction('loadRequests').replace(/^function/, 'async function');
  assert.ok(loader.length > 200, 'loadRequests 源码提取为空');
  assert.match(loader, /for \(const key of \['cursor', 'snapshotSeq', 'from', 'to'\]\) if \(cursor\[key\]\) query\.set\(key, cursor\[key\]\)/);
  assert.match(loader, /cursor: data\.nextCursor/);
  assert.doesNotMatch(loader, /atob|btoa|JSON\.parse\(.*[cC]ursor|split\(.*[cC]ursor|[cC]ursor\.(slice|substring|replace)/);
});

test('任务2：勾选框统一 18px 主题色，规则在通用 input 规则之后且覆盖其 min-height', () => {
  const generic = css.indexOf('.settings-group input, .settings-group select, .settings-group textarea {');
  const rule = css.indexOf('.settings-group input[type="checkbox"], input[type="checkbox"] { width: 18px; height: 18px; min-height: 0; padding: 0; accent-color: var(--accent); }');
  assert.ok(generic !== -1 && rule > generic, '勾选框规则要排在 .settings-group input 规则之后');
  assert.match(css, /label:has\(> input\[type="checkbox"\]\):not\(\.sync-toggle\):not\(\.model-picker-row\) \{ display: flex; align-items: center; gap: 8px; \}/);
  assert.match(css, /> input\[type="checkbox"\] \{ order: -1; flex: none; margin: 0; \}/);
  assert.match(css, /\.sync-toggle input\[type="checkbox"\] \{ width: 1px; height: 1px; \}/);
  assert.doesNotMatch(css, /\.settings-check input \{[^}]*width: 20px/);
});

test('任务2：五类勾选框都落在统一规则内（同一行、勾选框在前）', () => {
  assert.match(html, /<label class="settings-check"><input id="settings-reduce-motion" type="checkbox">减少动态<\/label>/);
  assert.match(html, /<label class="wide gateway-enabled" data-editor-enabled><input type="checkbox" name="enabled">保存时启用此渠道<\/label>/);
  assert.match(html, /<label class="sync-toggle settings-sync-toggle"><input id="settings-cost-sync" type="checkbox"><span class="toggle-track">/);
});

test('任务4：缓存趋势空态占满整格，设置页不再限制 760px', () => {
  assert.match(css, /\.trend-chart\.empty-chart \{ grid-template-columns: minmax\(0, 1fr\); grid-template-rows: minmax\(0, 1fr\);/);
  assert.match(css, /\.settings-page \{ display: grid; gap: 12px; \}/);
  assert.doesNotMatch(css, /\.settings-page \{[^}]*max-width/);
});

test('任务1：价格页窄屏变卡片，渠道换行不截断', () => {
  assert.match(css, /\.pricing-table td \{ height: 52px; overflow-wrap: anywhere; \}/);
  assert.match(css, /@media \(max-width: 760px\) \{\s*\.pricing-table tr \{ display: grid;/);
  assert.doesNotMatch(css.slice(css.indexOf('.pricing-table td {'), css.indexOf('.pricing-table td {') + 1800), /text-overflow: ellipsis|white-space: nowrap/);
});

test('合并页：手机底栏 4 个按钮等分（flex: 1 1 0），设置页两列在 1099px 以下折成单列', () => {
  assert.match(css, /\.page-nav a \{ flex: 1 1 0; min-width: 44px;/);
  assert.match(css, /\.settings-columns \{ display: grid; grid-template-columns: repeat\(2, minmax\(0, 1fr\)\);/);
  assert.match(css, /@media \(max-width: 1099px\) \{\s*\.settings-columns \{ grid-template-columns: minmax\(0, 1fr\); \}/);
  assert.doesNotMatch(css, /pricing-page|data-page="pricing"/);
});

test('上游适配器下拉：moonshot 在 xAI 和 Gemini 之间，提示文案提到智谱，没有智谱选项', () => {
  const label = html.slice(html.indexOf('<select name="adapter">'), html.indexOf('</label>', html.indexOf('<select name="adapter">')));
  const options = [...label.matchAll(/<option value="([^"]*)">([^<]*)<\/option>/g)].map((m) => [m[1], m[2]]);
  assert.deepEqual(options.map(([value]) => value), ['', 'openai', 'anthropic', 'deepseek', 'xai', 'moonshot', 'gemini']);
  assert.deepEqual(options.find(([value]) => value === 'moonshot'), ['moonshot', 'Kimi / Moonshot']);
  assert.match(label, /智谱 GLM 等中转站请选 OpenAI 兼容/);
  assert.doesNotMatch(label, /value="zhipu"|value="glm"/);
});

test('the overview alert takes a fetched latest error even when none was known before', () => {
  const context = vm.createContext({});
  vm.runInContext(productionFunction('newerError'), context);
  const at = (createdAt) => ({ createdAt });
  assert.equal(context.newerError(at('2026-10-31T01:00:00Z'), null), true);
  assert.equal(context.newerError(at('2026-10-31T01:00:00Z'), at('2026-10-31T00:00:00Z')), true);
  assert.equal(context.newerError(at('2026-10-31T00:00:00Z'), at('2026-10-31T01:00:00Z')), false);
  assert.equal(context.newerError(at(''), null), false);
  assert.equal(context.newerError(null, null), false);
});
