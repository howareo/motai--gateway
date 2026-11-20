import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const app = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
const productionFunction = (name) => {
  const start = app.indexOf(`function ${name}(`);
  assert.notEqual(start, -1);
  const tail = app.slice(start), next = tail.slice(1).search(/\n(?:async )?function /);
  return next === -1 ? tail : tail.slice(0, next + 1);
};
const element = () => ({ children: [], textContent: '', style: { setProperty() {} }, classList: { toggle() {} },
  append(...nodes) { this.children.push(...nodes); }, replaceChildren(...nodes) { this.children = nodes; }, setAttribute() {} });

test('overview metric callers display absent tokens as blank and explicit zero as zero', () => {
  for (const value of [null, 0]) {
    const nodes = new Map();
    const state = { overview: { channels: [], availability: { cacheRead: value !== null, cacheCreate: value !== null },
      metrics: { totalRequests: 1, requests: 1, failedRequests: 0, errorCount: 0, totalTokens: value,
        inputTokens: value, outputTokens: value, cacheReadTokens: value, cacheCreateTokens: value,
        estimatedCost: null, costCoverage: { complete: 0, partial: 0, unknown: 1 }, failovers: 0, ttftCount: 0 } } };
    const context = vm.createContext({ state, compact: new Intl.NumberFormat('en'), decimal: new Intl.NumberFormat('en'),
      $: (selector) => { if (!nodes.has(selector)) nodes.set(selector, element()); return nodes.get(selector); },
      formatCost: () => '', formatMs: () => '', formatTime: () => '' });
    vm.runInContext(`${productionFunction('formatTokens')}\n${productionFunction('renderMetrics')}\nrenderMetrics();`, context);
    for (const selector of ['#metric-tokens', '#metric-cache-read', '#metric-cache-create']) {
      assert.equal(nodes.get(selector).textContent, value === null ? '' : '0', selector);
    }
  }
});

test('other channel/model-test token totals keep all-absent blank and sum only known values', () => {
  for (const mode of ['channel', 'model-test']) {
    for (const [tail, expected] of [[[null, null], ''], [[0, null], '0'], [[null, 7], '7']]) {
      const rows = Array.from({ length: 7 }, (_, index) => ({ id: String(index), channelName: `C${index}`,
        name: `C${index}`, model: 'M', requests: 1, tokens: index < 5 ? null : tail[index - 5], estimatedCost: 100 - index }));
      const elements = { modelList: element(), modelTotal: element() };
      const context = vm.createContext({ state: { costDistributionMode: mode, overview: { channels: rows, modelTests: rows } },
        elements, document: { createElement: element }, $: element, providerFamilyOf: () => 'openai', applyChannelColor() {},
        compact: new Intl.NumberFormat('en'), decimal: new Intl.NumberFormat('en'), formatCost: (value) => String(value) });
      vm.runInContext(`${productionFunction('formatTokens')}\n${productionFunction('renderModels')}\nrenderModels();`, context);
      assert.equal(elements.modelList.children.length, 6);
      const meta = elements.modelList.children.at(-1).children.at(-1).children.at(-1);
      assert.equal(meta.textContent, `2 次 · ${expected} Token`, `${mode}: ${JSON.stringify(tail)}`);
    }
  }
});
