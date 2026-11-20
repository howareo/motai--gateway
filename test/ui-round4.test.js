import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { conflictMessage } from '../public/channel-editor/state.js';

const css = await readFile(new URL('../public/styles.css', import.meta.url), 'utf8');
const app = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
const html = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');

const root = css.slice(css.indexOf(':root'), css.indexOf('}', css.indexOf(':root')));
const tokens = Object.fromEntries([...root.matchAll(/--([a-z0-9-]+):\s*(#[0-9a-fA-F]{6})\s*;/g)].map((m) => [m[1], m[2].toLowerCase()]));
const aliases = Object.fromEntries([...root.matchAll(/--([a-z0-9-]+):\s*var\(--([a-z0-9-]+)\)\s*;/g)].map((m) => [m[1], m[2]]));
const rgb = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
const distance = (a, b) => Math.hypot(...rgb(a).map((v, i) => v - rgb(b)[i]));
const hsl = (hex) => {
  const [r, g, b] = rgb(hex).map((v) => v / 255); const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min, l = (max + min) / 2;
  return { s: d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1)), l, h: d === 0 ? 0 : (max === r ? ((g - b) / d + 6) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4) * 60 };
};
const linear = (v) => { const s = v / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; };
const luminance = (c) => 0.2126 * linear(c[0]) + 0.7152 * linear(c[1]) + 0.0722 * linear(c[2]);
const contrast = (a, b) => { const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x); return (hi + 0.05) / (lo + 0.05); };
const mix = (fg, alpha, bg) => fg.map((v, i) => v * alpha + bg[i] * (1 - alpha));
const palettes = () => {
  const block = app.slice(app.indexOf('const channelColors = {'), app.indexOf('};', app.indexOf('const channelColors = {')));
  return Object.fromEntries([...block.matchAll(/(\w+):\s*\[([^\]]*)\]/g)].map((m) => [m[1], [...m[2].matchAll(/#[0-9a-fA-F]{6}/g)].map((x) => x[0].toLowerCase())]));
};
const vendors = ['claude', 'openai', 'gemini', 'xai', 'deepseek', 'moonshot', 'zhipu'];
// 用户自己指定的同色：缓存写入的黄 = 延迟的黄（--warning），金额的绿 = 状态的绿（--healthy）。
const exempt = new Set(['cache-write|warning', 'money|healthy']);
const requestRowFixed = ['cache-write', 'cache-read', 'money', 'healthy', 'warning', 'danger'];

test('缓存写入黄色、缓存读取蓝色、金额绿色，三档延迟复用状态色并各有独立 token', () => {
  assert.ok(hsl(tokens['cache-write']).h >= 40 && hsl(tokens['cache-write']).h <= 60, '--cache-write 不是黄色');
  assert.ok(hsl(tokens['cache-read']).h >= 195 && hsl(tokens['cache-read']).h <= 225, '--cache-read 不是蓝色');
  for (const name of ['money', 'money-fill']) assert.ok(hsl(tokens[name]).h >= 85 && hsl(tokens[name]).h <= 140, `--${name} 不是绿色`);
  assert.deepEqual({ ok: aliases['latency-ok'], slow: aliases['latency-slow'], timeout: aliases['latency-timeout'] }, { ok: 'healthy', slow: 'warning', timeout: 'danger' });
  // 耗时强调色（平均总耗时卡片、探活均值、耗时小条）不能和缓存读的蓝撞色
  assert.equal(aliases.latency, 'accent');
  assert.ok(distance(tokens.accent, tokens['cache-read']) >= 40, '--latency 与 --cache-read 太近');
});

test('请求行的颜色两两距离 >= 40（用户指定的同色对除外）：固定色、厂商模型色、渠道色条（推理徽章单独检查）', () => {
  const check = (a, b, x, y) => assert.ok(distance(x, y) >= 40, `${a} ${x} 与 ${b} ${y} 太近（${distance(x, y).toFixed(1)}）`);
  for (let i = 0; i < requestRowFixed.length; i++) for (let j = i + 1; j < requestRowFixed.length; j++) {
    const [a, b] = [requestRowFixed[i], requestRowFixed[j]];
    if (!exempt.has(`${a}|${b}`) && !exempt.has(`${b}|${a}`)) check(`--${a}`, `--${b}`, tokens[a], tokens[b]);
  }
  for (const vendor of vendors) for (const name of requestRowFixed) check(`--${vendor}`, `--${name}`, tokens[vendor], tokens[name]);
  const family = { claude: 'anthropic', openai: 'openai', gemini: 'gemini', xai: 'xai', deepseek: 'deepseek' };
  for (const [name, list] of Object.entries(palettes())) for (const color of list) {
    for (const fixed of requestRowFixed) check(`${name} 色条`, `--${fixed}`, color, tokens[fixed]);
    for (const vendor of vendors) if (family[vendor] !== name) check(`${name} 色条`, `--${vendor}`, color, tokens[vendor]);
  }
});

test('渠道行的厂商色、金额、状态色和强调色两两距离 >= 40（金额与状态绿除外）', () => {
  const row = ['money', 'healthy', 'warning', 'danger', 'accent'];
  for (let i = 0; i < row.length; i++) for (let j = i + 1; j < row.length; j++) {
    if (exempt.has(`${row[i]}|${row[j]}`)) continue;
    assert.ok(distance(tokens[row[i]], tokens[row[j]]) >= 40, `--${row[i]} 与 --${row[j]} 太近`);
  }
  for (const vendor of vendors) for (const name of row) assert.ok(distance(tokens[vendor], tokens[name]) >= 40, `--${vendor} 与 --${name} 太近`);
});

test('新颜色饱和度 <= .75、亮度 .60 到 .82，文字在 canvas 与各 surface 上对比度 >= 4.5', () => {
  const surfaces = ['canvas', 'surface-1', 'surface-2', 'surface-3'].map((name) => rgb(tokens[name]));
  for (const name of ['cache-write', 'cache-read', 'money', 'healthy', 'claude', 'gemini', 'deepseek', 'moonshot']) {
    const { s, l } = hsl(tokens[name]);
    assert.ok(s <= 0.75 && l >= 0.6 && l <= 0.82, `--${name} 偏荧光或亮度越界`);
    for (const surface of [...surfaces, mix(rgb(tokens[name]), 0.1, rgb(tokens['surface-2']))]) assert.ok(contrast(rgb(tokens[name]), surface) >= 4.5, `--${name} 对比度不足`);
  }
  const fill = hsl(tokens['money-fill']); assert.ok(fill.s <= 0.75 && fill.l >= 0.5, '--money-fill 偏荧光');
});

test('推理强度徽章：七档各有色相，互相距离 >= 40，避开金额、缓存和状态色，文字对比度 >= 4.5', () => {
  const levels = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
  const rules = levels.map((level) => css.match(new RegExp(`\\.reasoning-${level} \\{([^}]*)\\}`))[1]);
  const colors = rules.map((rule) => rule.match(/color: (#[0-9a-fA-F]{6})/)?.[1].toLowerCase());
  for (const [i, level] of levels.entries()) {
    assert.ok(colors[i], `reasoning-${level} 缺少文字色`);
    assert.match(rules[i], new RegExp(`border-color: rgba\\(${rgb(colors[i]).join(', ')}, \\.\\d+\\); background: rgba\\(${rgb(colors[i]).join(', ')}, \\.(\\d+)\\)`), `reasoning-${level} 边框和底色要用同一色相`);
  }
  for (let i = 0; i < levels.length; i++) for (let j = i + 1; j < levels.length; j++) {
    assert.ok(distance(colors[i], colors[j]) >= 40, `${levels[i]} 与 ${levels[j]} 太近`);
  }
  for (const [i, level] of levels.entries()) for (const name of requestRowFixed) {
    assert.ok(distance(colors[i], tokens[name]) >= 40, `${level} ${colors[i]} 与 --${name} 太近`);
  }
  for (const [i, level] of levels.entries()) {
    const fill = Number(rules[i].match(/background: rgba\([^)]*, (\.\d+)\)/)[1]);
    for (const surface of ['surface-1', 'surface-2', 'surface-3']) {
      assert.ok(contrast(rgb(colors[i]), mix(rgb(colors[i]), fill, rgb(tokens[surface]))) >= 4.5, `徽章 ${level} 文字在 ${surface} 上对比度不足`);
    }
  }
  assert.match(rules[6], /font-weight: 700/);
  for (const rule of rules.slice(0, 6)) assert.doesNotMatch(rule, /font-weight/);
});

test('耗时小条、平均总耗时、探活均值用 --latency，TPS 用 --ink，渠道行成本倍率不是金额', () => {
  assert.match(css, /\.latency-waterfall \.wf-gen \{[^}]*background: var\(--latency\)/);
  assert.match(css, /\.latency-waterfall \.wf-ttft \{[^}]*background: var\(--latency\)/);
  assert.match(css, /\.metric-latency strong \{ color: var\(--latency\); \}/);
  assert.match(css, /\.quality-cell \.availability-heading strong \{[^}]*color: var\(--latency\)/);
  assert.match(css, /\.latency-cell b \{ color: var\(--ink\)/);
  assert.match(css, /\.cost-summary strong \{ color: var\(--ink\)/);
  for (const selector of ['\\.model-amount', '\\.panel-total', '\\.estimate', '\\.wallet-summary strong', '\\.channel-price-rates b', '\\.metric-money strong']) {
    assert.match(css, new RegExp(`${selector}[^{]*\\{[^}]*color: var\\(--money\\)`), `${selector} 应为金额绿`);
  }
});

test('输出 TPS：标签与数值分开，一位小数，不带“约”，缺失时留空', async () => {
  const start = app.indexOf('function latencyNode('), end = app.indexOf('// 延迟瀑布');
  assert.doesNotMatch(app.slice(start, end), /约/);
  assert.match(app, /rate\.append\('输出 TPS '/);
  assert.match(app, /`\$\{log\.outputTokensPerSecond\.toFixed\(1\)\} tok\/s`/);
  assert.match(app, /\['输出 TPS', rate\]/);
});

test('合计金额：USD 沿用页面金额格式，lowerBound 加 ≥，多币种用 · 连接，加载中与无 summary 的显示', () => {
  const source = app.slice(app.indexOf('const currencyFormats'), app.indexOf('function renderRequestSummary'));
  const decimal = new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 2 });
  const money = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 6 });
  const context = vm.createContext({ Intl, Map, decimal, formatMoney: (value) => (value === null || value === undefined ? '' : money.format(value)) });
  vm.runInContext(source, context);
  const text = (summary, loading) => context.requestSummaryText(summary, loading);
  assert.equal(text({ costs: [{ currency: 'USD', amount: 12.34 }], lowerBound: false }), '合计 $12.34');
  assert.equal(text({ costs: [{ currency: 'USD', amount: 12.34 }], lowerBound: true }), '合计 ≥ $12.34');
  assert.equal(text({ costs: [{ currency: 'USD', amount: 1.5 }, { currency: 'CNY', amount: 8 }], lowerBound: false }), '合计 $1.50 · CN¥8.00');
  assert.equal(text({ costs: [{ currency: 'USD', amount: 1.5 }, { currency: 'CNY', amount: 8 }], lowerBound: true }), '合计 ≥ $1.50 · CN¥8.00');
  assert.equal(text({ costs: [], lowerBound: true }), '合计 ≥ $0.00');
  assert.equal(text({ costs: [{ currency: 'XXZ', amount: 3 }], lowerBound: false }), `合计 ${new Intl.NumberFormat('en-US', { style: 'currency', currency: 'XXZ', maximumFractionDigits: 6 }).format(3)}`, '格式合法的其他币种交给 Intl（币种代码后是不换行空格）');
  assert.equal(text({ costs: [{ currency: 'x!', amount: 3 }], lowerBound: false }), '合计 3 x!', '非法币种代码退回数字加代码，不抛异常');
  assert.equal(text(null, true), '合计 …');
  assert.equal(text(null, false), '');
  assert.equal(text(undefined, false), '');
});

test('合计金额的数据流：筛选签名变化时进入加载中，翻页保留，旧 New API 模式隐藏', async () => {
  const start = app.indexOf('async function loadRequests('), end = app.indexOf('async function saveChannelSettings(');
  const rendered = [];
  const state = { gatewayMode: 'gateway', periodKey: 'today', requestPage: 1, requestToken: 0, requestCursors: [], requestCursorQuery: null,
    requestSummary: null, requestSummaryLoading: false, overview: {} };
  const elements = { requestRefresh: {}, channelFilter: { value: '' }, poolFilter: { value: '' }, modelFilter: { value: '' }, statusFilter: { value: '' }, streamFilter: { value: '' } };
  let mode = 'gateway';
  const summary = (amount) => ({ requests: 3, costs: [{ currency: 'USD', amount }], lowerBound: false, coverage: { complete: 3, partial: 0, unknown: 0 } });
  const context = vm.createContext({ state, elements, URLSearchParams, Date, periodQuery: () => new URLSearchParams({ period: 'today' }),
    renderRequests() {}, renderUpstreamAlert() {}, showToast() {},
    renderRequestSummary() { rendered.push({ loading: state.requestSummaryLoading, summary: state.requestSummary }); },
    api: async (url) => {
      const query = new URL(url, 'http://local.test').searchParams, page = Number(query.get('page'));
      if (mode === 'legacy') return { mode: 'legacy', page: 1, items: [] };
      return { mode: 'gateway', page, items: [], hasMore: true, nextCursor: 'c', snapshotSeq: '1', periodStartAt: 'a', periodEndAt: 'b',
        ...(page === 1 ? { summary: summary(query.get('channel') === '2' ? 7 : 12.34) } : {}) };
    } });
  vm.runInContext(app.slice(start, end), context);
  await context.loadRequests();
  assert.equal(state.requestSummary.costs[0].amount, 12.34);
  assert.equal(rendered[0].loading, true, '第一次加载先显示 合计 …');
  state.requestPage = 2; await context.loadRequests();
  assert.equal(state.requestSummary.costs[0].amount, 12.34, '翻页响应没有 summary，保留第一页的合计');
  elements.channelFilter.value = '2'; state.requestPage = 1;
  const pending = context.loadRequests();
  assert.equal(state.requestSummary, null); assert.equal(state.requestSummaryLoading, true, '筛选变了，旧合计作废并显示加载中');
  await pending; assert.equal(state.requestSummary.costs[0].amount, 7); assert.equal(state.requestSummaryLoading, false);
  mode = 'legacy'; elements.channelFilter.value = ''; await context.loadRequests();
  assert.equal(state.requestSummary, null, '响应里没有 summary 时整块隐藏');
});

test('请求页冻结：桌面周期条、标题行、表头 sticky 且表格外框不裁出滚动容器；手机只冻结标题行', () => {
  assert.match(css, /@media \(min-width: 720px\) \{[\s\S]*?body\[data-page="requests"\] \.period-bar \{ position: sticky; top: var\(--topbar-h/);
  assert.match(css, /body\[data-page="requests"\] \.requests-heading \{ position: sticky; top: calc\(var\(--topbar-h, 56px\) \+ var\(--period-h, 0px\)\)/);
  assert.match(css, /body\[data-page="requests"\] \.request-table th \{ position: sticky; top: calc\(var\(--topbar-h, 56px\) \+ var\(--period-h, 0px\) \+ var\(--request-heading-h, 0px\)\)/);
  assert.match(css, /body\[data-page="requests"\] \.requests-section \.table-frame \{ overflow: clip; \}/);
  assert.match(css, /@media \(max-width: 719px\) \{\s*html \{ scroll-padding-top: calc\(var\(--topbar-h, 56px\) \+ var\(--request-heading-h, 0px\)\)/);
  assert.match(css, /body\[data-page="requests"\] \.requests-heading \{ position: sticky; top: var\(--topbar-h, 56px\)/);
  assert.match(css, /\.requests-heading\.is-sheet-open \{ z-index: 70; \}/);
  assert.match(app, /root\.setProperty\('--topbar-h'/); assert.match(app, /getBoundingClientRect\(\)\.height/);
  assert.match(app, /new ResizeObserver\(syncStickyOffsets\)/);
});

test('筛选面板里的周期按钮从周期条克隆（单一来源），筛选或周期变化回到顶部；合计金额紧跟标题', () => {
  assert.match(html, /<div id="request-sheet-periods" class="period-control sheet-periods"/);
  assert.match(app, /document\.querySelectorAll\('\.period-bar \[data-period\]'\)/);
  assert.match(app, /copy\.addEventListener\('click', \(\) => source\.click\(\)\)/);
  assert.equal([...html.matchAll(/data-period="/g)].length, 7, '静态周期按钮仍只有一份');
  assert.match(html, /<h2>最近请求与上游错误<\/h2><strong id="request-summary" class="request-summary"[^>]*hidden><\/strong>/);
  const periodHandler = app.slice(app.indexOf("for (const button of document.querySelectorAll('[data-period]'))"), app.indexOf("for (const button of document.querySelectorAll('[data-cost-distribution]'))"));
  assert.match(periodHandler, /window\.scrollTo\(\{ top: 0/);
  assert.match(periodHandler, /item\.dataset\.period === state\.periodKey/, '选中态按周期值同步，克隆按钮也一并高亮');
  assert.match(app, /filter\.addEventListener\('change', \(\) => \{\s*state\.requestPage = 1;\s*window\.scrollTo\(\{ top: 0/);
});

test('409 提示：operation_conflict 用专用文案，其他 409 保持原文案，非 409 用服务端消息', () => {
  const fallback = '配置已变化，请关闭后重新打开；草稿仍保留供核对';
  assert.equal(conflictMessage({ status: 409, code: 'operation_conflict', message: 'x' }, fallback), '这次保存已用不同内容提交过，请关闭后重新打开再改');
  assert.equal(conflictMessage({ status: 409, code: 'stale_generation', message: 'x' }, fallback), fallback);
  assert.equal(conflictMessage({ status: 409, message: 'x' }, fallback), fallback);
  assert.equal(conflictMessage({ status: 400, message: '网关配置字段无效' }, fallback), '网关配置字段无效');
  assert.match(app, /if \(payload\.error\?\.code\) error\.code = payload\.error\.code;/);
});

const tierSource = () => app.match(/const latencyThresholds = Object\.freeze\(\{[\s\S]*?\}\);/)[0]
  + ['ttftTier', 'durationTier', 'latencyTiers', 'ttftValue'].map((name) => {
    const start = app.indexOf(`function ${name}(`); const tail = app.slice(start); const next = tail.slice(1).search(/\n(?:async )?function |\n\/\/ /);
    return tail.slice(0, next + 1);
  }).join('\n');
const tierContext = () => { const context = vm.createContext({ Number, formatMs: (value) => `${value} ms` }); vm.runInContext(tierSource(), context); return context; };

test('首字分档边界（New API rc25）：4.999 秒正常，5 秒延迟，9.999 秒延迟，10 秒超时；缺失或 ≤ 0 不分档', () => {
  const { ttftTier } = tierContext();
  assert.equal(ttftTier(4999), 'ok'); assert.equal(ttftTier(5000), 'slow');
  assert.equal(ttftTier(9999), 'slow'); assert.equal(ttftTier(10000), 'timeout');
  assert.equal(ttftTier(0), null); assert.equal(ttftTier(-5), null);
  assert.equal(ttftTier(null), null); assert.equal(ttftTier(undefined), null);
});

test('总耗时分档边界：输出 < 100 token 按时间（9.999 / 10 / 29.999 / 30 秒）', () => {
  const { durationTier } = tierContext();
  assert.equal(durationTier(9999, 50), 'ok'); assert.equal(durationTier(10000, 50), 'slow');
  assert.equal(durationTier(29999, 50), 'slow'); assert.equal(durationTier(30000, 50), 'timeout');
});

test('总耗时分档边界：99 与 100 token 走不同规则；速度 29.9 / 30 / 14.9 / 15 tok/s', () => {
  const { durationTier } = tierContext();
  assert.equal(durationTier(20000, 99), 'slow', '99 token 按时间：20 秒是延迟');
  assert.equal(durationTier(20000, 100), 'timeout', '100 token 按速度：5 tok/s 是超时');
  assert.equal(durationTier(5000, 99), 'ok'); assert.equal(durationTier(5000, 100), 'slow', '100 token / 5 秒 = 20 tok/s');
  assert.equal(durationTier(10000, 299), 'slow', '29.9 tok/s'); assert.equal(durationTier(10000, 300), 'ok', '30 tok/s');
  assert.equal(durationTier(10000, 149), 'timeout', '14.9 tok/s'); assert.equal(durationTier(10000, 150), 'slow', '15 tok/s');
});

test('总耗时为 0 按时间判断为正常，缺失不分档，输出 token 缺失按时间判断', () => {
  const { durationTier } = tierContext();
  assert.equal(durationTier(0, 5000), 'ok', '耗时 ≤ 0 走时间规则，不会除以 0');
  assert.equal(durationTier(null, 500), null); assert.equal(durationTier(undefined, 500), null);
  assert.equal(durationTier(12000, null), 'slow'); assert.equal(durationTier(40000, undefined), 'timeout');
});

test('失败行不上色；首字缺失、非流式、0 显示 N/A 且不带分档 class；有值时带分档 class', () => {
  const context = tierContext();
  assert.deepEqual({ ...context.latencyTiers({ kind: 'error', ttftMs: 500, durationMs: 90000, outputTokens: 900 }) }, { ttft: null, duration: null });
  assert.deepEqual({ ...context.latencyTiers({ kind: 'success', ttftMs: 12000, durationMs: 40000, outputTokens: 50 }) }, { ttft: 'timeout', duration: 'timeout' });
  const value = (log) => ({ ...context.ttftValue({ kind: 'success', stream: true, ...log }) });
  assert.deepEqual(value({ ttftMs: null }), { value: 'N/A', className: 'unavailable' });
  assert.deepEqual(value({ ttftMs: 0 }), { value: 'N/A', className: 'unavailable' });
  assert.deepEqual(value({ stream: false, ttftMs: 700 }), { value: 'N/A', className: 'unavailable' });
  assert.deepEqual(value({ ttftMs: 4999 }), { value: '4999 ms', className: 'numeric latency-ok' });
  assert.deepEqual(value({ ttftMs: 5000 }), { value: '5000 ms', className: 'numeric latency-slow' });
  assert.deepEqual({ ...context.ttftValue({ kind: 'error', stream: true, ttftMs: 700 }) }, { value: '', className: 'unavailable' });
});

test('阈值只在 latencyThresholds 一处定义，三档 class 用延迟 token，应用到桌面单元格、手机卡片与请求详情', () => {
  assert.equal(app.split('const latencyThresholds').length, 2);
  assert.match(app, /出处：New API rc25 usage-logs\/lib\/format\.ts/);
  const tiers = app.slice(app.indexOf('function ttftTier('), app.indexOf('function ttftValue('));
  assert.doesNotMatch(tiers.replace(/\/\/.*/g, '').replace(/latencyThresholds\.\w+/g, ''), /\b(?:5|10|30|15|100)\b/, '分档函数里不应再有裸阈值数字（注释除外）');
  for (const tier of ['ok', 'slow', 'timeout']) assert.match(css, new RegExp(`\\.latency-cell b\\.latency-${tier}, \\.request-detail-fields dd\\.latency-${tier} \\{ color: var\\(--latency-${tier}\\); \\}`));
  assert.match(app, /className: durationTone \? `latency-\$\{durationTone\}` : ''/);
  assert.match(app, /if \(tier\) description\.classList\.add\(`latency-\$\{tier\}`\)/);
  assert.match(app, /\['首字延迟', log\.stream \? known\(formatMs\(log\.ttftMs\)\) : unknown, latencyTiers\(log\)\.ttft\]/);
  assert.match(app, /\['总耗时', known\(formatMs\(log\.durationMs\)\), latencyTiers\(log\)\.duration\]/);
  assert.match(css, /\.latency-cell \.unavailable, \.latency-cell \.not-applicable \{ color: var\(--faint\); \}/, 'N/A 用中性色 --faint');
});

test('“未定价”标签用 --warning 黄：虚线边框、底色、文字都是黄色系，不再用金额绿', () => {
  const rule = css.match(/\.unpriced-tag \{([^}]*)\}/)[1];
  assert.match(rule, /color: var\(--warning\)/);
  assert.doesNotMatch(rule, /--money/);
  const [r, g, b] = rgb(tokens.warning);
  assert.match(rule, new RegExp(`border: 1px dashed rgba\\(${r}, ${g}, ${b}, \\.55\\)`));
  assert.match(rule, new RegExp(`background: rgba\\(${r}, ${g}, ${b}, \\.08\\)`));
});

test('不是金额的文字不用 --money：未定价提醒用 --warning，缺失占位符与加载中用 --faint，不限额用 --ink', () => {
  for (const selector of ['\\.metric-money strong\\.is-unpriced', '\\.panel-total\\.is-unpriced', '\\.model-amount\\.is-unpriced']) {
    assert.match(css, new RegExp(`${selector}[^{]*\\{ color: var\\(--warning\\); \\}`), `${selector} 应为 --warning`);
  }
  assert.match(css, /\.channel-price-rates b\.is-none, \.pricing-table td\.is-none, \.request-summary\.is-loading \{ color: var\(--faint\); \}/);
  assert.match(css, /\.wallet-summary strong\.is-neutral, \.wallet-current-card strong\.is-neutral \{ color: var\(--ink\); \}/);
  assert.match(app, /\$\('#metric-cost'\)\.classList\.toggle\('is-unpriced', allUnpriced\)/);
  assert.match(app, /elements\.modelTotal\.classList\.toggle\('is-unpriced', allUnpriced\)/);
  assert.match(app, /if \(isUnpriced\(model\)\) amount\.classList\.add\('is-unpriced'\)/);
  assert.match(app, /if \(value\.textContent === '—'\) value\.className = 'is-none'/);
  assert.match(app, /elements\.requestSummary\.classList\.toggle\('is-loading', state\.requestSummaryLoading\)/);
  assert.match(app, /if \(wallet\.errorClass === 'unlimited_quota'\) value\.className = 'is-neutral'/);
});

test('吸顶背景：默认透明，只有 .is-stuck 才有不透明底色；桌面周期条与标题行、手机标题行都有哨兵', () => {
  assert.doesNotMatch(css.match(/body\[data-page="requests"\] \.period-bar \{[^}]*\}/)[0], /background/);
  assert.doesNotMatch(css.match(/@media \(min-width: 720px\) \{[\s\S]*?body\[data-page="requests"\] \.requests-heading \{[^}]*\}/)[0].match(/\.requests-heading \{[^}]*\}/)[0], /background/);
  assert.match(css, /body\[data-page="requests"\] \.period-bar\.is-stuck, body\[data-page="requests"\] \.requests-heading\.is-stuck \{ background: var\(--canvas\); \}/);
  const mobile = css.slice(css.indexOf('@media (max-width: 719px) {\n  html { scroll-padding-top: calc(var(--topbar-h, 56px) + var(--request-heading-h'));
  assert.doesNotMatch(mobile.match(/body\[data-page="requests"\] \.requests-heading \{[^}]*\}/)[0], /background/);
  assert.match(mobile, /body\[data-page="requests"\] \.requests-heading\.is-stuck \{ background: var\(--canvas\); \}/);
  assert.match(css, /\.sticky-sentinel \{ display: block; height: 0;[^}]*visibility: hidden; pointer-events: none; \}/);
  assert.match(html, /<i class="sticky-sentinel" data-sticky-sentinel="period" aria-hidden="true"><\/i>\s*<div class="period-bar"/);
  assert.match(html, /<i class="sticky-sentinel" data-sticky-sentinel="heading" aria-hidden="true"><\/i>\s*<div class="section-heading requests-heading"/);
});

test('吸顶监听：桌面监听周期条和标题行，手机只监听标题行；偏移不变不重建，偏移变了先断开再重建，stop 断开全部', () => {
  const source = app.slice(app.indexOf('const stickyTargets'), app.indexOf('if (typeof ResizeObserver'));
  const created = []; let desktop = true; const vars = { '--topbar-h': '56', '--period-h': '42' };
  const classes = new Map(); const element = (name) => ({ name, classList: { toggle: (cls, on) => classes.set(`${name}:${cls}`, on) } });
  const nodes = { '.period-bar': element('period'), '.requests-heading': element('heading') };
  const sentinels = { period: { getClientRects: () => [{}] }, heading: { getClientRects: () => [{}] } };
  class FakeObserver { constructor(callback, options) { this.callback = callback; this.options = options; this.disconnected = false; this.targets = []; created.push(this); }
    observe(node) { this.targets.push(node); } disconnect() { this.disconnected = true; } }
  const context = vm.createContext({ IntersectionObserver: FakeObserver, Math, JSON, parseFloat,
    window: { matchMedia: () => ({ get matches() { return desktop; } }) },
    getComputedStyle: () => ({ getPropertyValue: (name) => vars[name] }),
    document: { documentElement: {}, querySelector: (selector) => selector.startsWith('[data-sticky-sentinel') ? sentinels[selector.match(/"(\w+)"/)[1]] : nodes[selector] } });
  vm.runInContext(`${source}\nthis.watchStickyState = watchStickyState; this.stopStickyWatch = stopStickyWatch; this.count = () => stickyObservers.length;`, context);

  context.watchStickyState();
  assert.equal(created.length, 2, '桌面：周期条 + 标题行');
  assert.deepEqual(created.map((o) => o.options.rootMargin), ['-56px 0px 0px 0px', '-98px 0px 0px 0px'], '吸顶线 = 顶栏高度；标题行再加周期条高度');
  context.watchStickyState();
  assert.equal(created.length, 2, '偏移没变，不重建');

  // 哨兵滚到吸顶线以上才算吸顶；回到线以下去掉 is-stuck
  const [period] = created;
  period.callback([{ isIntersecting: false, boundingClientRect: { bottom: 40 } }]); assert.equal(classes.get('period:is-stuck'), true);
  period.callback([{ isIntersecting: true, boundingClientRect: { bottom: 60 } }]); assert.equal(classes.get('period:is-stuck'), false);
  sentinels.period.getClientRects = () => []; // 页面隐藏时哨兵没有盒子
  period.callback([{ isIntersecting: false, boundingClientRect: { bottom: -500 } }]); assert.equal(classes.get('period:is-stuck'), false, '隐藏页面不算吸顶');

  vars['--period-h'] = '60'; // 周期条换行变高：旧观察器全部断开，按新偏移重建
  context.watchStickyState();
  assert.equal(created.length, 4); assert.ok(created.slice(0, 2).every((o) => o.disconnected)); assert.equal(created[3].options.rootMargin, '-116px 0px 0px 0px');

  desktop = false; // 手机：只有标题行，吸顶线 = 顶栏高度
  context.watchStickyState();
  assert.equal(created.length, 5); assert.ok(created.slice(2, 4).every((o) => o.disconnected)); assert.equal(created[4].options.rootMargin, '-56px 0px 0px 0px');
  assert.equal(context.count(), 1);

  context.stopStickyWatch(); // 清理路径：pagehide 调用
  assert.ok(created.every((o) => o.disconnected)); assert.equal(context.count(), 0);
  context.watchStickyState(); assert.equal(created.length, 6, 'stop 之后（如 bfcache 恢复）可以重新建立');
});

test('吸顶监听的清理路径：pagehide 断开 ResizeObserver、IntersectionObserver 并移除 resize 监听；bfcache 恢复后重新建立', () => {
  assert.match(app, /window\.addEventListener\('pagehide', \(\) => \{ resizeObserver\.disconnect\(\); stopStickyWatch\(\); window\.removeEventListener\('resize', syncStickyOffsets\); \}\)/);
  assert.match(app, /window\.addEventListener\('pageshow', \(event\) => \{\s*if \(!event\.persisted\) return;/);
  assert.match(app, /function syncStickyOffsets\(\) \{[\s\S]*?watchStickyState\(\);\s*\}/, '偏移变了就重新评估哨兵观察器');
});
