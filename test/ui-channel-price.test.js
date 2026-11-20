import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const app = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
const source = app.slice(app.indexOf('function channelModelPrice('), app.indexOf('function costSummary('));

class Element {
  children = [];
  attributes = {};
  listeners = {};
  append(...children) { this.children.push(...children); }
  add(child) { this.append(child); }
  replaceChildren(...children) { this.children = children; }
  setAttribute(name, value) { this.attributes[name] = value; }
  addEventListener(name, callback) { this.listeners[name] = callback; }
}

function setup(pricingCatalog = []) {
  const context = vm.createContext({
    state: { channelPriceModels: {}, overview: { pricingCatalog } },
    document: { createElement: () => new Element() },
    Option: class { constructor(label, value) { this.textContent = label; this.value = value; } },
    money: new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 6 }),
    decimal: new Intl.NumberFormat('zh-CN'),
    multiplier: new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 4 }),
  });
  vm.runInContext(source, context);
  return context;
}

const values = (wrapper) => wrapper.children[1].children[1].children.map((rate) => rate.children[1].textContent);

test('switches channel models, applies model-specific multipliers and retains selection on refresh', () => {
  const context = setup([
    { model: 'first', rates: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 }, channelMultipliers: { 4: 0.2 } },
    { model: 'second', rates: { input: 3, output: 15, cacheRead: 0, cacheWrite: null }, channelMultipliers: { 4: 0.5 } },
    { model: 'not-on-channel', rates: { input: 999 } },
  ]);
  const channel = { id: 4, name: 'Example', models: ['first', 'second'], costMultiplier: 0.3 };
  const wrapper = context.channelModelPrice(channel);
  const select = wrapper.children[0];
  assert.deepEqual(select.children.map((option) => option.value), ['first', 'second']);
  assert.equal(select.attributes['aria-label'], 'Example 折算价格模型');
  assert.deepEqual(values(wrapper), ['$1.00', '$5.00', '$0.10', '$1.25']);
  select.value = 'second';
  select.listeners.change();
  assert.deepEqual(values(wrapper), ['$1.50', '$7.50', '$0.00', '—']);
  assert.match(wrapper.children[1].children[0].textContent, /USD \/ 百万 Token · 0.5×/);
  assert.equal(context.channelModelPrice(channel).children[0].value, 'second');
  channel.models = ['first'];
  assert.deepEqual(values(context.channelModelPrice(channel)), ['$1.00', '$5.00', '$0.10', '$1.25']);
  assert.equal(context.state.channelPriceModels[4], 'first');
});

test('distinguishes unknown prices from zero and does not invent model prices', () => {
  const context = setup([{ model: 'known', rates: { input: 5 }, channelMultipliers: { 1: null, 2: 0 } }]);
  assert.deepEqual(values(context.channelModelPrice({ id: 1, models: ['known'], costMultiplier: 0.3 })), ['—', '—', '—', '—']);
  assert.deepEqual(values(context.channelModelPrice({ id: 2, models: ['known'] })), ['$0.00', '—', '—', '—']);
  assert.deepEqual(values(context.channelModelPrice({ id: 3, models: ['missing'], costMultiplier: 0.3 })), ['—', '—', '—', '—']);
  assert.equal(context.channelModelPrice({ id: 4, models: [] }).textContent, '未配置模型');
});
