import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { normalizeLog, normalizeError } from '../src/analytics.js';

const app = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
const source = app.slice(app.indexOf('function latencyNode('), app.indexOf('function renderRequests('));
class Element {
  children = [];
  append(...children) { this.children.push(...children); }
}
const context = vm.createContext({
  document: { createElement: () => new Element() },
  ttftValue: () => ({ value: '', className: 'unavailable' }),
  latencyTiers: () => ({ ttft: null, duration: null }),
  formatMs: (value) => value == null ? '' : `${value} ms`,
});
vm.runInContext(source, context);

test('shows labelled total-duration throughput beside first-token latency, including non-streaming requests', () => {
  for (const is_stream of [true, false]) {
    const node = context.latencyNode(normalizeLog({ completion_tokens: 600, use_time: 10, is_stream }));
    assert.equal(node.children.length, 3);
    assert.equal(node.children[2].children[0], '输出 TPS ');
    assert.equal(node.children[2].children[1].textContent, '60.0 tok/s');
    assert.match(node.children[2].title, /全请求平均输出速率.*含等待.*推理 Token.*精确到秒/);
  }
});

test('leaves unavailable, interrupted and failed throughput empty', () => {
  for (const log of [
    normalizeLog({ completion_tokens: 600 }),
    normalizeLog({ use_time: 10 }),
    normalizeLog({ completion_tokens: 600, use_time: 10, other: { stream_status: { status: 'error' } } }),
    normalizeError({}),
    { kind: 'error', outputTokensPerSecond: 60 },
  ]) {
    assert.equal(context.latencyNode(log).children[2].children[1].textContent, '');
  }
});

test('prototype table and detail share the same unknown and approximate output-rate rendering', async () => {
  const design = await readFile(new URL('../design/motai-console-v1/app.js', import.meta.url), 'utf8');
  const context = vm.createContext({});
  vm.runInContext(design.slice(design.indexOf('function outputRate('), design.indexOf('function requestRows(')), context);
  assert.equal(context.outputRate({ status: '成功', outputTokensPerSecond: 60 }), '约 60.0 tok/s');
  assert.equal(context.outputRate({ status: '流中断', outputTokensPerSecond: 60 }), '—');
  assert.equal(context.outputRate({ status: '成功', outputTokensPerSecond: null }), '—');
  assert.match(design, /\$\{outputRate\(r\)\}/);
  assert.match(design, /\['平均输出速率', outputRate\(r\)\]/);
});
