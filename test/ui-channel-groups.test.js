import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const css = await readFile(new URL('../public/styles.css', import.meta.url), 'utf8');
const app = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');

const rootBlock = css.slice(css.indexOf(':root'), css.indexOf('}', css.indexOf(':root')));
const tokens = Object.fromEntries([...rootBlock.matchAll(/--([a-z0-9-]+):\s*(#[0-9a-fA-F]{6})\s*;/g)].map((m) => [m[1], m[2]]));

const rgb = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
const linear = (v) => { const s = v / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; };
const luminance = (c) => 0.2126 * linear(c[0]) + 0.7152 * linear(c[1]) + 0.0722 * linear(c[2]);
const contrast = (a, b) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};
const mix = (fg, alpha, bg) => fg.map((v, i) => v * alpha + bg[i] * (1 - alpha));

const poolTokens = { Claude: 'claude', OpenAI: 'openai', Gemini: 'gemini', xAI: 'xai', DeepSeek: 'deepseek', Moonshot: 'moonshot', Zhipu: 'zhipu' };

test('每个厂商池都有 --group-color 映射，且大小写不敏感', () => {
  for (const [pool, token] of Object.entries(poolTokens)) {
    assert.ok(tokens[token], `缺少 --${token} token`);
    assert.ok(
      css.includes(`.channel-group-row[data-pool="${pool}" i] { --group-color: var(--${token}); }`),
      `${pool} 缺少属性选择器映射`,
    );
  }
  assert.match(css, /\.channel-group-row \{ --group-color: var\(--faint\); \}/, '未知池应回落 --faint');
});

test('分组头色条 4px、取 --group-color，池名文字取 --group-color', () => {
  assert.match(css, /\.channel-table \.channel-group-row td \{[^}]*box-shadow: inset 4px 0 0 var\(--group-color\)/);
  assert.match(css, /\.channel-group-row td strong \{[^}]*color: var\(--group-color\)/);
  assert.doesNotMatch(css, /inset 3px 0 0 var\(--accent\)/);
});

test('分组头背景是 --group-color 的低透明度叠加（<= 12%），并用 @supports 包住', () => {
  const m = css.match(/@supports \(background: color-mix\([^)]*\)\) \{\s*\.channel-table \.channel-group-row td \{ background: color-mix\(in srgb, var\(--group-color\) (\d+)%, var\(--surface-2\)\); \}\s*\}/);
  assert.ok(m, '缺少 color-mix 叠加规则');
  assert.ok(Number(m[1]) <= 12, `叠加比例 ${m[1]}% 超过 12%`);
});

test('池名和计数文字在叠加背景上对比度 >= 4.5', () => {
  const percent = css.match(/background: color-mix\(in srgb, var\(--group-color\) (\d+)%, var\(--surface-2\)\)/)[1];
  const alpha = Number(percent) / 100;
  const surface = rgb(tokens['surface-2']);
  for (const token of [...Object.values(poolTokens), 'faint']) {
    const color = rgb(tokens[token]);
    const background = mix(color, alpha, surface);
    assert.ok(contrast(color, background) >= 4.5, `${token} 池名对比度不足`);
    assert.ok(contrast(rgb(tokens.faint), background) >= 4.5, `${token} 背景上的计数文字对比度不足`);
  }
});

test('非首组分组头在桌面表格上方有 12px 画布色粗边，不插入空行', () => {
  assert.match(css, /\.channel-table \.channel-group-row:not\(:first-child\) td \{[^}]*border-top: 12px solid var\(--canvas\)/);
  assert.doesNotMatch(app, /spacer|channel-group-gap/);
});

test('窄屏表格和 channel-cards 两套布局都给非首组分组头留出间隔', () => {
  assert.match(css, /\.channel-table tr\.channel-group-row:not\(:first-child\) \{ margin-top: 10px; \}/);
  assert.match(css, /\.channel-table tr\.channel-group-row:not\(:first-child\) td \{ height: auto; border-top: 1px solid var\(--line-strong\); \}/);
  assert.match(css, /\.channel-cards tr\.channel-group-row:not\(:first-child\) \{ margin-top: 10px; \}/);
  assert.match(css, /\.channel-cards tr\.channel-group-row:not\(:first-child\) td \{ height: auto; border-top: 1px solid var\(--line-strong\); \}/);
});

test('分组头 DOM 结构不变：colSpan 8、data-pool、池名与计数文案', () => {
  assert.match(app, /row\.className = 'channel-group-row';/);
  assert.match(app, /row\.dataset\.pool = pool;/);
  assert.match(app, /td\.colSpan = 8;/);
  assert.match(app, /`\$\{channels\.length\} 个渠道 · \$\{enabledCount\} 启用`/);
});

test('分组排序不区分大小写，小写池名也按厂商顺序，"其他"排最后，显示名保持原样', () => {
  const start = app.indexOf('const channelGroupOrder');
  const end = app.indexOf('function channelGroupRow(');
  assert.ok(start !== -1 && end > start);
  const context = vm.createContext({});
  vm.runInContext(`${app.slice(start, end)}\nthis.groupChannelsByProvider = groupChannelsByProvider;`, context);
  const channels = ['xai', '其他', 'deepseek', 'openai', 'gemini', 'claude']
    .map((routingPool, id) => ({ id: String(id), routingPool, enabled: true, priority: 1, weight: 1 }));
  const groups = context.groupChannelsByProvider(channels);
  assert.deepEqual(Array.from(groups, (group) => group.pool), ['claude', 'openai', 'gemini', 'xai', 'deepseek', '其他']);
  const mixed = context.groupChannelsByProvider(['xAI', 'Claude', 'DeepSeek', 'openai']
    .map((routingPool, id) => ({ id: String(id), routingPool, enabled: true, priority: 1, weight: 1 })));
  assert.deepEqual(Array.from(mixed, (group) => group.pool), ['Claude', 'openai', 'xAI', 'DeepSeek']);
});

test('Claude route labels describe manual switching instead of weighted failover', () => {
  assert.ok(app.includes("channel.routingPool === 'claude' ? 'Claude 固定主用，失败直接返回错误，仅手动切换'"));
  assert.ok(app.includes("channel.routingPool === 'claude' ? '主用层（仅手动切换）'"));
  assert.ok(app.includes("channel.routingPool === 'claude' ? 'Claude 备用渠道仅供手动切换，不参与自动故障转移'"));
});

const distance = (a, b) => Math.hypot(...rgb(a).map((v, i) => v - rgb(b)[i]));
const hsl = (hexColor) => {
  const [r, g, b] = rgb(hexColor).map((v) => v / 255);
  const max = Math.max(r, g, b); const min = Math.min(r, g, b); const d = max - min;
  const l = (max + min) / 2;
  const s = d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1));
  const h = d === 0 ? 0 : (max === r ? ((g - b) / d + 6) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4) * 60;
  return { h, s, l };
};
const surfaces = () => ['canvas', 'surface-1', 'surface-2', 'surface-3'].map((name) => rgb(tokens[name]));
const channelPalettes = () => {
  const block = app.slice(app.indexOf('const channelColors = {'), app.indexOf('};', app.indexOf('const channelColors = {')));
  return Object.fromEntries([...block.matchAll(/(\w+):\s*\[([^\]]*)\]/g)].map((m) => [m[1], [...m[2].matchAll(/#[0-9a-fA-F]{6}/g)].map((x) => x[0].toLowerCase())]));
};

test('缓存写/读、OpenAI 新色：只和会同时出现的颜色拉开 RGB 距离 >= 40', () => {
  const apart = (name, others) => {
    for (const other of others) assert.ok(distance(tokens[name], tokens[other]) >= 40, `--${name} 与 --${other} 太近`);
  };
  // 缓存写入的黄和 --warning（延迟的黄）是用户指定的同色，不要求拉开；--latency 已移除，三档延迟复用 healthy/warning/danger。
  apart('cache-write', ['claude', 'danger', 'money', 'cache-read']);
  apart('cache-read', ['gemini', 'cache-write', 'healthy', 'accent', 'money', 'danger']);
  apart('openai', ['accent', 'healthy', 'cache-read', 'xai']);
});

test('缓存读不是绿色，新 token 饱和度 <= .75、亮度 .62 到 .82，文字对比度 >= 4.5', () => {
  const cacheRead = hsl(tokens['cache-read']);
  assert.ok(cacheRead.h < 70 || cacheRead.h > 170, '--cache-read 落在绿色色相');
  for (const name of ['cache-write', 'cache-read', 'openai']) {
    const { s, l } = hsl(tokens[name]);
    assert.ok(s <= 0.75 && l >= 0.62 && l <= 0.82, `--${name} 偏荧光或亮度越界`);
    const color = rgb(tokens[name]);
    for (const surface of [...surfaces(), mix(color, 0.1, rgb(tokens['surface-2']))]) assert.ok(contrast(color, surface) >= 4.5, `--${name} 对比度不足`);
  }
});

test('channelColors 每个色值都避开 danger 和 warning（距离 >= 40），换掉的色保持各自色相族', () => {
  const palettes = channelPalettes();
  assert.deepEqual(Object.keys(palettes).sort(), ['anthropic', 'deepseek', 'gemini', 'openai', 'unknown', 'xai']);
  for (const [family, colors] of Object.entries(palettes)) {
    assert.equal(colors.length, 5, `${family} 色板条数变了`);
    for (const color of colors) for (const name of ['danger', 'warning']) assert.ok(distance(color, tokens[name]) >= 40, `${family} ${color} 与 --${name} 太近`);
  }
  const [claudeSlot, apricot, sand] = palettes.anthropic;
  for (const color of [claudeSlot, apricot, sand]) { const { h, l } = hsl(color); assert.ok(h >= 15 && h <= 45 && l >= 0.62, `anthropic ${color} 不在暖色族`); }
  for (const color of palettes.openai) { const { h, s, l } = hsl(color); assert.ok(h >= 165 && h <= 200 && s <= 0.75 && l >= 0.62 && l <= 0.82, `openai ${color} 不在青色族或偏荧光`); }
  for (const color of palettes.unknown) assert.ok(hsl(color).s <= 0.25, `unknown ${color} 不是低饱和中性色`);
  for (const color of palettes.unknown.slice(1)) for (const name of ['healthy', 'cache-read']) assert.ok(distance(color, tokens[name]) >= 40, `unknown ${color} 与 --${name} 太近`);
});

test('starmap 图例的颜色跟 token 走，价格页立柱已整体删除', () => {
  assert.doesNotMatch(css, /\.pillar|\.face-front|pricing-pillars/);
  assert.doesNotMatch(app, /renderPricingPillars|pricing-pillars/);
  assert.match(css, /\.legend-healthy::before \{ color: var\(--accent\); \} \.legend-failing::before \{ color: var\(--danger\); \}/);
});

test('请求表推理强度 none 徽章在悬停底色 surface-3 上对比度 >= 4.5', () => {
  const rule = css.match(/\.reasoning-none \{([^}]*)\}/)?.[1] ?? '';
  const hex = rule.match(/color: (#[0-9a-fA-F]{6})/)?.[1];
  const alpha = Number(rule.match(/background: rgba\([^)]*, (\.\d+)\)/)?.[1]);
  assert.ok(hex && alpha >= 0, 'reasoning-none 缺少文字色或底色');
  const color = rgb(hex.toLowerCase());
  const hover = rgb(tokens['surface-3']).map((v, i) => color[i] * alpha + v * (1 - alpha));
  assert.ok(contrast(color, hover) >= 4.5);
});
