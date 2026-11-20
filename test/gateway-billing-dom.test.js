import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { mountGatewayBilling } from '../public/channel-editor/billing.js';
import { openGatewayEditor } from '../public/channel-editor/gateway-editor.js';
import { editorDOM } from './helpers/editor-dom.js';

const html = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');
const app = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
const productionFunction = (name) => {
  const start = app.search(new RegExp(`(?:async )?function ${name}\\(`));
  const tail = app.slice(start); const next = tail.slice(1).search(/\n(?:async )?function /);
  return next === -1 ? tail : tail.slice(0, next + 1);
};

test('estimated request fees and gateway-only totals keep their scope explicit', () => {
  const context = vm.createContext({ formatCost: (value) => String(value) });
  vm.runInContext(productionFunction('costNode'), context);
  assert.equal(context.costNode({ kind: 'success', costStatus: 'complete', estimatedCost: 1.2, costIsEstimate: true }), '约 1.2');
  assert.equal(context.costNode({ kind: 'success', costStatus: 'complete', estimatedCost: 1.2 }), '1.2');
  assert.doesNotMatch(productionFunction('renderModels'), /upstreamBill|上游 Key 真实账单/);
  assert.match(productionFunction('renderModels'), /仅统计经墨台的请求/);
  assert.match(app, /不含直连上游的消费/);
});

test('currency labels preserve original catalog prices and request cost numbers', () => {
  const dom = editorDOM(html);
  const body = dom.document.createElement('tbody');
  const context = vm.createContext({ Intl, Number, Map, document: dom.document,
    state: { overview: { pricingCatalog: [{ model: 'model', family: 'openai', channels: ['channel'],
      channelMultipliers: { channel: 0.1 }, rates: { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 0.3 } }] } },
    elements: { pricingSummary: dom.document.createElement('div'), pricingSyncBody: body, pricingSyncEmpty: dom.document.createElement('div') },
    cell: (value) => { const node = dom.document.createElement('td'); node.textContent = value; return node; },
    decimal: { format: String },
  });
  vm.runInContext(`${app.match(/^const money = .*;$/m)[0]}\n${productionFunction('formatMoney')}\n${productionFunction('formatCost')}\n${productionFunction('formatCurrencyAmount')}\n${productionFunction('renderPricingSync')}`, context);
  context.renderPricingSync();
  assert.deepEqual(body.children[0].children.slice(2, 6).map((node) => node.textContent), ['¥2.00', '¥10.00', '¥0.20', '¥0.30']);
  assert.equal(context.formatCost(6.553266896), '¥6.553267');
  assert.equal(context.formatCurrencyAmount('USD', 6.553266896), '¥6.553267');
  assert.equal(context.formatCurrencyAmount('CNY', 6.553266896), '¥6.553267');
  assert.doesNotMatch(html, /settings-settlement-currency/);
});

test('billing mounts only saved observations, keeps stable actions/focus and exposes explicit stale data', async () => {
  const dom = editorDOM(html), root = dom.document.createElement('section');
  let channel = { id: '0001', costMultiplier: 0.25, wallet: { balance: 12 }, billingStale: true };
  const opened = [], rendered = [];
  const render = (kind) => (value, onOpen) => {
    assert.equal(value, channel); rendered.push(kind);
    const node = dom.document.createElement('button'); node.textContent = kind;
    if (onOpen) node.addEventListener('click', () => onOpen(node));
    return node;
  };
  const view = mountGatewayBilling({ root, channelId: '0001', getChannel: () => channel,
    renderCost: render('cost'), renderPrice: render('price'), renderWallet: render('wallet'),
    openSettings: (...args) => opened.push(args) });
  assert.match(root.children[0].textContent, /待同步.*最近已知值/);
  assert.equal(root.children[0].getAttribute('role'), 'status');
  const summary = root.children[1], actions = root.children[2];
  const focus = summary.children[1]; focus.focus(); view.refresh();
  assert.equal(dom.document.activeElement, focus); assert.equal(summary.children[1], focus);
  assert.equal(rendered.length, 3);
  await actions.children[0].dispatch('click');
  assert.deepEqual(opened[0].slice(0, 2), ['0001', 'config']);
  await summary.children.at(-1).dispatch('click');
  assert.equal(opened[1][2], actions.children[1], 'wallet returns focus to stable action, not replaced summary');
  channel = null; view.refresh();
  assert.equal(actions.hidden, true); assert.equal(summary.children.length, 0);
  await actions.children[0].dispatch('click'); assert.equal(opened.length, 2);
});

test('billing refuses new/unknown channels and editor passes saved ID without connection/key draft', async () => {
  const dom = editorDOM(html); globalThis.document = dom.document; globalThis.window = { confirm: () => true };
  const newRoot = dom.document.createElement('section'); let lookups = 0;
  mountGatewayBilling({ root: newRoot, channelId: null, getChannel: () => { lookups++; }, openSettings: () => assert.fail() });
  assert.equal(lookups, 0); assert.match(newRoot.children[0].textContent, /先保存/);
  const config = { gen: '1', pools: [{ id: 'p', name: 'pool' }], models: [{ id: 'M', vendor: 'openai' }],
    channels: [{ id: '0001', name: 'saved', baseUrl: 'https://saved.invalid', poolId: 'p', enabled: false, priority: 1, weight: 1,
      hasCredential: true, models: [{ modelId: 'M', upstreamModel: 'M', capabilities: ['responses'] }], testModel: 'M' }] };
  const mounts = []; let refreshes = 0;
  const session = openGatewayEditor({ ...dom, config, channel: config.channels[0], api: () => assert.fail('unrelated request'),
    mountBilling: (...args) => { mounts.push(args); return { refresh() { refreshes++; } }; }, tab: 'billing' });
  session.edit({ baseUrl: 'https://unsaved.invalid' }); session.credential('replace', 'DRAFT_SECRET');
  assert.equal(mounts[0].length, 2); assert.equal(mounts[0][1], '0001');
  assert.doesNotMatch(JSON.stringify(mounts[0][1]), /DRAFT_SECRET|unsaved/);
  session.refreshBilling(); assert.equal(refreshes, 1);
  assert.equal(dom.dialog.querySelector('[data-editor-panel="billing"]').hidden, false);
  session.close(); session.refreshBilling(); assert.equal(refreshes, 1);
});

function costHarness({ auto = true, rate = '', api } = {}) {
  const dom = editorDOM(html, 'channel-settings-cost-template');
  const panel = dom.document.createElement('section');
  const state = { settingsBillingOnly: true, settingsChannelId: '0001', settingsEditor: { sessionId: 'session', saving: false },
    settingsDraft: { config: { multiplier: rate, costSyncMode: auto ? 'auto' : 'manual' } }, overview: { costVersion: 7 },
    gatewaySession: { refreshBilling() {} } };
  let closed = false; const calls = [];
  const context = vm.createContext({ state, Number, JSON, encodeURIComponent,
    $: (selector) => selector === '#channel-settings-cost-template' ? dom.template : panel.querySelector(selector),
    elements: { channelSettingsPanel: panel },
    api: async (...args) => { calls.push(args); return api?.(...args); },
    settingsWalletDirty: () => false, hasWalletCredentialInput: () => false,
    confirmSettings: async () => true, closeChannelSettings() { closed = true; },
    showToast() {}, refresh: async () => {}, requestCloseChannelSettings() {},
  });
  vm.runInContext(`${productionFunction('renderSettingsCost')}\n${productionFunction('withSavingLabel')}\n${productionFunction('saveCostSettings')}`, context);
  const channel = { id: '0001', name: 'saved' }; context.renderSettingsCost(channel);
  return { state, panel, calls, context, channel, get closed() { return closed; } };
}

test('real cost DOM auto disables required numeric field and omits unknown multiplier and all unrelated draft values', async () => {
  const ui = costHarness();
  const rate = ui.panel.querySelector('#settings-multiplier');
  assert.equal(rate.disabled, true); assert.equal(rate.required, false); assert.equal(rate.value, '');
  ui.state.settingsDraft.key = 'DRAFT_SECRET'; ui.state.settingsDraft.baseUrl = 'https://unsaved.invalid';
  await ui.panel.querySelector('form').dispatch('submit');
  assert.equal(ui.calls[0][0], '/api/channels/0001/cost');
  assert.deepEqual(JSON.parse(ui.calls[0][1].body), { costSyncMode: 'auto', baseVersion: 7 });
  assert.equal(ui.closed, true);
});

test('real cost DOM rejects blank manual value, accepts explicit zero and locks duplicate save', async () => {
  let release; const ui = costHarness({ auto: false, api: () => new Promise((resolve) => { release = resolve; }) });
  const form = ui.panel.querySelector('form'), rate = ui.panel.querySelector('#settings-multiplier');
  assert.equal(rate.disabled, false); assert.equal(rate.required, true);
  await form.dispatch('submit'); assert.equal(ui.calls.length, 0);
  assert.match(ui.panel.querySelector('#channel-settings-cost-status').textContent, /请填写/);
  rate.value = '0'; await rate.dispatch('input');
  const saveButton = ui.panel.querySelector('#save-channel-settings-cost'); saveButton.textContent = '保存成本设置';
  const saving = form.dispatch('submit'); await form.dispatch('submit');
  assert.equal(ui.calls.length, 1); assert.equal(JSON.parse(ui.calls[0][1].body).multiplier, 0);
  assert.equal(saveButton.disabled, true); assert.equal(saveButton.textContent, '保存中');
  release(); await saving;
  assert.equal(saveButton.textContent, '保存成本设置', 'label is restored once the request settles');
});

test('real cost DOM handles conflict, retains draft, and switching auto never erases manual value', async () => {
  const ui = costHarness({ auto: false, rate: '0.35', api: () => { throw Object.assign(new Error('conflict'), { status: 409 }); } });
  const auto = ui.panel.querySelector('#settings-cost-sync');
  auto.checked = true; await auto.dispatch('change');
  assert.equal(ui.panel.querySelector('#settings-multiplier').disabled, true);
  auto.checked = false; await auto.dispatch('change');
  assert.equal(ui.state.settingsDraft.config.multiplier, '0.35');
  await ui.panel.querySelector('form').dispatch('submit');
  assert.equal(ui.closed, false); assert.equal(ui.state.settingsEditor.saving, false);
  assert.match(ui.panel.querySelector('#channel-settings-cost-status').textContent, /核对后再保存/);
});

test('existing wallet DOM submits only management settings, keeps the typed credential on failure and preserves gateway key draft', async () => {
  const dom = editorDOM(html, 'channel-settings-wallet-template');
  const panel = dom.document.createElement('section');
  const state = { settingsChannelId: '0001', settingsEditor: { sessionId: 'wallet-session', saving: false },
    settingsDraft: { wallet: { adapter: 'newapi', origin: '' } }, walletCredentialCleared: false,
    gatewaySession: { draft: { credentialValue: 'UNSAVED_GATEWAY_KEY', baseUrl: 'https://unsaved.invalid' } } };
  const calls = [];
  const context = vm.createContext({ state, JSON, Boolean,
    $: (selector) => selector === '#channel-settings-wallet-template' ? dom.template : panel.querySelector(selector),
    elements: { channelSettingsPanel: panel },
    Option: function(label, value) { const node = dom.document.createElement('option'); node.textContent = label; node.value = value; return node; },
    walletAdapterNames: { newapi: 'New API', auto: '自动识别', sub2: 'Sub2', rightcode: 'Right Code' },
    formatBalance: () => '12 USD', formatTime: () => 'now', walletStatusDetail: () => '等待同步',
    settingsConfigDirty: () => false, confirmSettings: async () => true,
    api: async (...args) => { calls.push(args); throw new Error('credential rejected'); },
    closeChannelSettings: () => assert.fail('failed save closed settings'), showToast() {}, refresh: async () => {},
    requestCloseChannelSettings() {}, clearWalletSettings() {},
  });
  vm.runInContext(`${productionFunction('renderSettingsWallet')}\n${productionFunction('withSavingLabel')}\n${productionFunction('saveWalletSettings')}`, context);
  const channel = { id: '0001', name: 'saved', wallet: { status: 'ok', configured: true } };
  context.renderSettingsWallet(channel);
  const credential = panel.querySelector('#settings-wallet-credential');
  assert.match(credential.placeholder, /留空保持不变/);
  credential.value = 'MANAGEMENT_SECRET';
  panel.querySelector('#save-channel-settings-wallet').textContent = '保存余额设置';
  const origin = panel.querySelector('#settings-wallet-origin'); origin.value = 'https://management.example'; await origin.dispatch('input');
  await panel.querySelector('form').dispatch('submit');
  assert.equal(calls[0][0], '/api/channels/0001/wallet');
  assert.deepEqual(JSON.parse(calls[0][1].body), { adapter: 'newapi', origin: 'https://management.example', credential: 'MANAGEMENT_SECRET' });
  assert.doesNotMatch(calls[0][1].body, /UNSAVED_GATEWAY_KEY|unsaved.invalid/);
  assert.equal(credential.value, 'MANAGEMENT_SECRET'); assert.equal(state.walletCredentialCleared, false);
  assert.equal(state.gatewaySession.draft.credentialValue, 'UNSAVED_GATEWAY_KEY');
  assert.equal(state.settingsEditor.saving, false);
  assert.match(panel.querySelector('#channel-settings-wallet-status').textContent, /credential rejected/);
  assert.equal(panel.querySelector('#settings-credential-cleared-note').hidden, true);
  assert.equal(panel.querySelector('#save-channel-settings-wallet').textContent, '保存余额设置', 'label is restored after the failed request');
});

test('a dotted request alias keeps the canonical model catalog price instead of guessing from the upstream name', () => {
  const dom = editorDOM(html);
  const state = { channelPriceModels: {}, gatewayConfig: { gen: '1', pools: [{ id: 'pool', name: '明确池' }],
    aliases: [{ alias: 'gpt.5.6', modelId: 'gpt-5.6', poolId: 'pool' }],
    channels: [{ id: '0001', name: 'synthetic', enabled: true, poolId: 'pool', priority: 1,
      models: [{ modelId: 'gpt-5.6', upstreamModel: 'provider.model.2026', capabilities: ['responses'] }] }] },
    overview: { channels: [{ id: '0001', costMultiplier: 0.25 }], pricingCatalog: [
      { model: 'gpt-5.6', channelMultipliers: { '0001': 0.25 }, rates: { input: 2, output: 8, cacheRead: 0.2 } },
      { model: 'gpt.5.6', rates: { input: 999 } }, { model: 'provider.model.2026', rates: { input: 999 } },
    ] } };
  const context = vm.createContext({ state, document: dom.document,
    money: { format: String }, multiplier: { format: String }, decimal: { format: String } });
  vm.runInContext(`${productionFunction('gatewayChannels')}\n${productionFunction('channelModelPrice')}`, context);
  const channel = context.gatewayChannels()[0];
  assert.deepEqual([...channel.models], ['gpt-5.6']);
  const view = context.channelModelPrice(channel);
  assert.equal(view.children[0].textContent, 'gpt-5.6');
  assert.deepEqual(view.querySelectorAll('b').map((node) => node.textContent), ['0.5', '2', '0.05', '—']);
});

test('billing static markup associates its tabpanel and live status labels', () => {
  assert.match(html, /id="gateway-panel-billing"[^>]*role="tabpanel"[^>]*aria-labelledby="gateway-tab-billing"/);
  assert.match(html, /id="channel-settings-cost-status"[^>]*role="status"[^>]*aria-live="polite"/);
});
