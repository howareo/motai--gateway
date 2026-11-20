import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { openGatewayEditor } from '../public/channel-editor/gateway-editor.js';
import { editorDOM } from './helpers/editor-dom.js';

const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
const config = () => ({ gen: '9', pools: [{ id: 'pool', name: '明确池' }], models: [{ id: 'Model/A', vendor: 'openai' }],
  channels: [{ id: '0001', name: '原渠道', baseUrl: 'https://old.invalid', poolId: 'pool', enabled: true, hasCredential: true,
    priority: 4, weight: 1, testModel: 'Model/A', models: [{ modelId: 'Model/A', upstreamModel: 'upstream-a', capabilities: ['responses'] }] }] });
const active = { activated: true, desiredGen: '10', committedGen: '10', servingGen: '10' };
function setup({ create = false, api = async () => active, confirm = () => true, tab, prepare = () => {}, notify, onSaved, mountBilling } = {}) {
  const dom = editorDOM(html), cfg = config(); prepare(cfg); globalThis.document = dom.document; globalThis.window = { confirm };
  let session;
  openGatewayEditor({ ...dom, config: cfg, channel: create ? null : cfg.channels[0], api, tab, notify, onSaved, mountBilling,
    onSession: (next) => { session = next; } });
  const $ = (selector) => dom.dialog.querySelector(selector);
  const input = async (name, value, type = 'input') => { const node = $(`[name="${name}"]`); node.value = value; await node.dispatch(type); return node; };
  return { ...dom, get session() { return session; }, $, input };
}

test('gateway DOM: add a named group in the draft, select it as primary and save it with the channel', async () => {
  const calls = [];
  const ui = setup({ api: async (_, options) => { calls.push(JSON.parse(options.body)); return active; } });
  await ui.input('newPoolName', '  我的 Kimi  ');
  await ui.$('[data-editor-add-pool]').dispatch('click');
  const pool = ui.session.pools.at(-1);
  assert.equal(pool.name, '我的 Kimi');
  assert.equal(ui.$('[name="newPoolName"]').value, '');
  assert.deepEqual(ui.session.draft.poolIds, ['pool', pool.id]);
  assert.equal(ui.$('[data-editor-pools]').querySelectorAll('input').at(-1).checked, true);
  assert.equal(ui.$('[name="poolId"]').querySelectorAll('option').at(-1).textContent, '我的 Kimi');
  assert.equal(ui.session.dirty, true);
  assert.equal(calls.length, 0, 'adding a draft group must not publish before saving');
  await ui.input('poolId', pool.id, 'change');
  await ui.$('form').dispatch('submit');
  assert.deepEqual(calls[0].change.newPools, [pool]);
  assert.equal(calls[0].change.channel.poolId, pool.id);
  assert.deepEqual(calls[0].change.channel.poolIds, ['pool', pool.id]);
});

test('gateway DOM: invalid or duplicate groups are rejected; unchecked draft groups are not created', async () => {
  const ui = setup();
  for (const name of ['', '明确池', 'x'.repeat(121)]) {
    await ui.input('newPoolName', name);
    await ui.$('[data-editor-add-pool]').dispatch('click');
    assert.equal(ui.session.pools.length, 1); assert.ok(ui.$('[data-editor-error]').textContent);
  }
  await ui.input('newPoolName', 'Kimi');
  await ui.$('[data-editor-add-pool]').dispatch('click');
  await ui.input('newPoolName', 'kimi');
  await ui.$('[data-editor-add-pool]').dispatch('click');
  assert.equal(ui.session.pools.length, 2);
  assert.deepEqual(ui.session.command().change.newPools, [ui.session.pools.at(-1)]);
  const box = ui.$('[data-editor-pools]').querySelectorAll('input').at(-1);
  box.checked = false; await box.dispatch('change');
  assert.equal(Object.hasOwn(ui.session.command().change, 'newPools'), false);
  ui.session.close();
  assert.equal(ui.session.addPool('closed'), false);
});

test('gateway DOM: single page anchors keep every section visible and suppress accidental Enter submit', async () => {
  const ui = setup({ tab: 'models' });
  assert.match(html, /<dialog id="gateway-channel-dialog"[^>]*aria-labelledby="gateway-editor-title"[^>]*aria-describedby="gateway-editor-summary"/);
  assert.equal(ui.$('#gateway-editor-title').textContent, '编辑 原渠道');
  assert.match(ui.$('#gateway-editor-summary').textContent, /修改草稿/);
  assert.equal(ui.dialog.open, true);
  assert.equal(ui.$('[data-editor-panel="models"]').hidden, false);
  assert.equal(ui.$('[data-editor-tab]'), null);
  assert.equal(ui.document.activeElement, ui.$('#gateway-heading-models'));
  await ui.$('[data-editor-jump="billing"]').dispatch('click');
  assert.equal(ui.document.activeElement, ui.$('#gateway-heading-billing'));
  assert.ok(ui.dialog.querySelectorAll('[data-editor-panel]').every((node) => !node.hidden));
  assert.match(ui.$('[data-editor-billing]').textContent, /尚未就绪/);
  const enter = await ui.$('form').dispatch('keydown', { key: 'Enter', target: ui.$('[name="name"]') });
  assert.equal(enter.defaultPrevented, true);
});

test('gateway DOM: pool membership and ordinary edits preserve hidden routing values on save', async () => {
  const calls = [];
  const ui = setup({ prepare: (cfg) => {
    cfg.pools.push({ id: 'second', name: '第二池' });
    Object.assign(cfg.channels[0], { poolIds: ['pool', 'second'], poolPriorities: { pool: 70, second: 3 } });
  }, api: async (_, options) => { calls.push(JSON.parse(options.body)); return active; } });
  const boxes = ui.$('[data-editor-pools]').querySelectorAll('input');
  assert.deepEqual(boxes.map((node) => [node.value, node.checked]), [['pool', true], ['second', true]]);
  boxes[1].checked = false; await boxes[1].dispatch('change');
  assert.deepEqual(ui.session.draft.poolIds, ['pool']);
  assert.equal(ui.session.draft.poolPriorities.second, 3, 'temporarily removing a membership keeps its local override until save');
  boxes[1].checked = true; await boxes[1].dispatch('change');
  assert.equal(ui.$('[name="priorityPoolId"]'), null);
  assert.equal(ui.$('[name="priority"]'), null);
  assert.equal(ui.$('[name="weight"]'), null);
  assert.ok(ui.$('[name="testModel"]'));
  await ui.input('name', '仅修改名称');
  await ui.$('form').dispatch('submit');
  assert.deepEqual(calls[0].change.channel.poolIds, ['pool', 'second']);
  assert.deepEqual(calls[0].change.channel.poolPriorities, { pool: 70, second: 3 });
  assert.equal(calls[0].change.channel.priority, 4);
  assert.equal(calls[0].change.channel.weight, 1);
  assert.equal(calls[0].change.channel.poolId, 'pool');
});

test('gateway DOM: name/model/credential events send the exact command; a pending save reconciles through the Node API and then closes', async () => {
  const calls = [], notes = [];
  const ui = setup({ notify: (message) => notes.push(message), api: async (path, options) => { calls.push({ path, options }); return calls.length === 1 ? { ...active, activated: false, servingGen: '9' } : active; } });
  await ui.input('name', '已修改');
  await ui.input('credentialValue', 'SYNTHETIC_SECRET');
  await ui.$('[data-editor-jump="models"]').dispatch('click');
  assert.equal(ui.$('[name="credentialValue"]').value, 'SYNTHETIC_SECRET');
  await ui.$('form').dispatch('submit');
  const payload = JSON.parse(calls[0].options.body);
  assert.equal(payload.change.channel.name, '已修改');
  assert.equal(payload.change.credentialValue, 'SYNTHETIC_SECRET');
  assert.equal(ui.session.draft.saveStatus, 'pending');
  assert.equal(ui.$('[data-editor-save]').disabled, true);
  assert.equal(ui.$('[data-editor-reconcile]').hidden, false);
  assert.ok(ui.dialog.querySelectorAll('fieldset').every((node) => node.disabled));
  await ui.$('[data-editor-reconcile]').dispatch('click');
  assert.equal(calls[1].path, '/api/gateway/reconcile');
  assert.equal(ui.dialog.open, false, 'a successful reconcile closes the dialog like a direct save');
  assert.deepEqual(notes, ['已保存 · gen 10']);
  assert.equal(ui.session.draft.credentialValue, ''); assert.equal(ui.dialog.children.length, 0);
  assert.equal(ui.document.activeElement, ui.trigger);
});

test('gateway DOM: native invalid field scrolls into view; model typing retains caret and resets removed probe', async () => {
  const ui = setup(); const textarea = ui.$('[name="modelsText"]');
  textarea.focus(); await ui.input('modelsText', 'Model/B, ');
  assert.equal(textarea.value, 'Model/B, '); assert.equal(ui.session.draft.testModel, '');
  assert.match(ui.$('[data-editor-probe-note]').textContent, /原探活模型已移除/);
  const testModel = ui.$('[name="testModel"]'); testModel.invalid = true;
  await ui.$('form').dispatch('submit');
  assert.equal(ui.$('[data-editor-panel="models"]').hidden, false);
  assert.equal(testModel.validityReported, true);
  assert.equal(ui.session.draft.saveStatus, 'idle');
});

test('gateway DOM: target confirmation and destructive credential action require explicit confirmation; cancellation preserves draft', async () => {
  let allow = false, prompts = 0; const ui = setup({ confirm: () => { prompts++; return allow; } });
  await ui.input('baseUrl', 'https://new.invalid');
  assert.equal(ui.$('[data-editor-confirm-key]').hidden, false);
  await ui.$('[data-editor-confirm-key]').dispatch('click'); assert.equal(ui.session.draft.credentialConfirmed, false);
  allow = true; await ui.$('[data-editor-confirm-key]').dispatch('click'); assert.equal(ui.session.draft.credentialConfirmed, true);
  await ui.$('[data-editor-clear-key]').dispatch('click'); assert.match(ui.$('[data-editor-error]').textContent, /先停用/);
  const enabled = ui.$('[name="enabled"]'); enabled.checked = false; await enabled.dispatch('change');
  await ui.$('[data-editor-clear-key]').dispatch('click'); assert.equal(ui.session.draft.credentialAction, 'clear');
  allow = false; await ui.$('[data-editor-close]').dispatch('click'); assert.equal(ui.dialog.open, true);
  assert.equal(ui.session.draft.closed, false); assert.ok(prompts >= 4);
  allow = true; let prevented = false; ui.dialog.oncancel({ preventDefault() { prevented = true; } });
  assert.equal(prevented, true); assert.equal(ui.session.draft.closed, true);
});

test('gateway DOM: inline catalog uses 50-row pages and selection updates the same draft without confirmation', async () => {
  const ui = setup({ api: async () => ({ models: Array.from({ length: 120 }, (_, index) => ({ id: `Model/${index}`, capabilities: ['responses'] })), observedAt: 'now' }) });
  const picker = ui.$('[data-editor-picker]');
  assert.ok(picker);
  await ui.$('[data-editor-fetch]').dispatch('click');
  assert.deepEqual(ui.session.draft.selected, ['Model/A']);
  assert.equal(ui.dialog.querySelector('dialog'), null);
  const boxes = () => picker.querySelectorAll('input').filter((node) => node.type === 'checkbox');
  assert.equal(boxes().length, 50);
  const search = picker.querySelector('input'); search.value = 'Model/119'; await search.dispatch('input');
  const checkbox = boxes()[0]; checkbox.checked = true; await checkbox.dispatch('change');
  assert.deepEqual(ui.session.draft.selected, ['Model/A', 'Model/119']);
  assert.ok(ui.$('[name="testModel"]').children.some((node) => node.value === 'Model/119'));
  assert.equal(ui.document.activeElement.value, 'Model/119');
});

test('gateway DOM: protocol changes refresh visible model capabilities and unknown vendor guidance', async () => {
  const ui = setup();
  await ui.input('protocol', 'messages', 'change');
  assert.equal(ui.$('[data-capability-model="Model/A"]').getAttribute('data-capability-values'), 'messages');
  ui.session.select(['custom-model']);
  assert.equal(ui.$('[data-editor-advanced]').open, true);
  assert.match(ui.$('[data-editor-vendor-note]').textContent, /custom-model/);
  await ui.input('vendor', 'openai');
  assert.equal(ui.$('[data-editor-vendor-note]').textContent, '');
  await ui.input('vendor', '');
  assert.match(ui.$('[data-editor-vendor-note]').textContent, /custom-model/);
});

test('gateway DOM: an activated save closes the dialog, clears the key, refreshes through onSaved and notifies with the generation', async () => {
  const notes = [], saved = [];
  const ui = setup({ notify: (message) => notes.push(message), onSaved: (result) => saved.push(result), api: async () => active });
  assert.equal(ui.session.draft.closed, false);
  await ui.input('name', '已修改'); await ui.input('credentialValue', 'SYNTHETIC_SECRET');
  await ui.$('form').dispatch('submit');
  assert.equal(ui.dialog.open, false); assert.equal(ui.session.draft.closed, true);
  assert.equal(ui.session.draft.credentialValue, ''); assert.equal(ui.dialog.children.length, 0);
  assert.deepEqual(saved, [active], 'onSaved (list refresh) runs before the dialog closes');
  assert.deepEqual(notes, ['已保存 · gen 10']); assert.equal(ui.document.activeElement, ui.trigger);
});

test('gateway DOM: failed save keeps the dialog open with the server reason, the typed draft and an enabled save button', async () => {
  const notes = [];
  const ui = setup({ notify: (message) => notes.push(message),
    api: async () => { throw Object.assign(new Error('网关配置字段无效'), { status: 400 }); } });
  await ui.input('name', '已修改'); await ui.input('credentialValue', 'SYNTHETIC_SECRET');
  await ui.$('form').dispatch('submit');
  assert.equal(ui.dialog.open, true); assert.equal(ui.session.draft.closed, false);
  assert.equal(ui.$('[data-editor-error]').textContent, '网关配置字段无效');
  assert.equal(ui.$('[name="name"]').value, '已修改'); assert.equal(ui.session.draft.credentialValue, 'SYNTHETIC_SECRET');
  assert.equal(ui.$('[data-editor-save]').disabled, false); assert.equal(ui.$('[data-editor-save]').textContent, '保存修改');
  assert.ok(ui.dialog.querySelectorAll('fieldset').every((node) => !node.disabled));
  assert.deepEqual(notes, []);
});

test('gateway DOM: 409 conflict explains the stale draft in place and does not close or notify', async () => {
  const notes = [];
  const ui = setup({ notify: (message) => notes.push(message), api: async () => { throw Object.assign(new Error('配置已更新，请刷新后再保存'), { status: 409 }); } });
  await ui.input('name', '已修改'); await ui.$('form').dispatch('submit');
  assert.equal(ui.dialog.open, true); assert.match(ui.$('[data-editor-error]').textContent, /配置已变化/);
  assert.equal(ui.$('[name="name"]').value, '已修改'); assert.deepEqual(notes, []);
});

test('gateway DOM: saving shows 保存中, locks the button, ignores a second submit and closes once on success', async () => {
  let release, calls = 0; const notes = [];
  const ui = setup({ notify: (message) => notes.push(message), api: () => { calls++; return new Promise((resolve) => { release = resolve; }); } });
  await ui.input('name', '已修改');
  const first = ui.$('form').dispatch('submit');
  assert.equal(ui.$('[data-editor-save]').textContent, '保存中'); assert.equal(ui.$('[data-editor-save]').disabled, true);
  await ui.$('form').dispatch('submit'); assert.equal(calls, 1);
  assert.equal(ui.dialog.open, true); assert.deepEqual(notes, []);
  release(active); await first;
  assert.equal(ui.dialog.open, false); assert.equal(calls, 1); assert.deepEqual(notes, ['已保存 · gen 10']);
});

test('gateway DOM: a 202 pending save stays open with the reconcile button and does not notify as saved', async () => {
  const notes = [];
  const ui = setup({ notify: (message) => notes.push(message), api: async () => ({ ...active, activated: false, servingGen: '9' }) });
  await ui.input('name', '已修改'); await ui.$('form').dispatch('submit');
  assert.equal(ui.dialog.open, true); assert.equal(ui.$('[data-editor-reconcile]').hidden, false);
  assert.equal(ui.$('[data-editor-result]').textContent, '已保存，等待生效；当前仍使用原配置。'); assert.deepEqual(notes, []);
});

test('gateway DOM: a network failure keeps the draft and retries the same operation without closing', async () => {
  const bodies = [], notes = [];
  const ui = setup({ notify: (message) => notes.push(message), api: async (_, options) => {
    bodies.push(options.body); if (bodies.length === 1) throw new Error('网络超时'); return active; } });
  await ui.input('name', '已修改'); await ui.$('form').dispatch('submit');
  assert.equal(ui.dialog.open, true); assert.equal(ui.$('[data-editor-save]').textContent, '核对并重试同一操作');
  assert.equal(ui.$('[data-editor-error]').textContent, '网络超时'); assert.deepEqual(notes, []);
  await ui.$('form').dispatch('submit');
  assert.equal(bodies[0], bodies[1]); assert.equal(ui.dialog.open, false); assert.deepEqual(notes, ['已保存 · gen 10']);
});

for (const pending of [false, true]) test(`gateway DOM: new channel ${pending ? 'reconcile' : 'save'} stays open as a fresh saved-channel session`, async () => {
  const calls = [], billingIds = [];
  const cfg = config(); cfg.gen = '10';
  cfg.channels.push({ ...structuredClone(cfg.channels[0]), id: 'created-id', name: '新渠道', enabled: false });
  const ui = setup({ create: true, mountBilling: (_, id) => { billingIds.push(id); return { refresh() {} }; },
    api: async (path, options) => {
      calls.push({ path, body: options?.body && JSON.parse(options.body) });
      if (path === '/api/gateway/models/preview') return { models: [{ id: 'Model/A', capabilities: ['responses'] }], observedAt: 'now' };
      return { ...active, config: cfg, ...(path.endsWith('/change') ? { channelId: 'created-id' } : {}),
        ...(pending && path.endsWith('/change') && calls.at(-1).body.change.action === 'create' ? { activated: false, servingGen: '9' } : {}) };
    } });
  assert.equal(ui.$('[name="testModel"]').disabled, true);
  await ui.input('baseUrl', 'https://upstream.invalid'); await ui.input('credentialValue', 'SYNTHETIC_SECRET');
  await ui.$('[data-editor-fetch]').dispatch('click');
  assert.equal(calls.length, 1, 'connection-only preview needs no name/group save');
  assert.equal(calls[0].path, '/api/gateway/models/preview');
  ui.session.select(['Model/A']); await ui.input('name', '新渠道');
  const firstSession = ui.session, oldOperation = firstSession.draft.operationId;
  await ui.$('form').dispatch('submit');
  assert.equal(calls[1].body.change.channel.enabled, false);
  if (pending) {
    assert.equal(ui.session, firstSession); assert.equal(firstSession.draft.saveStatus, 'pending');
    await ui.$('[data-editor-reconcile]').dispatch('click');
  }
  assert.equal(ui.dialog.open, true); assert.equal(firstSession.draft.closed, true);
  assert.equal(firstSession.draft.credentialValue, '');
  assert.equal(ui.session.draft.channelId, 'created-id'); assert.equal(ui.session.draft.baseGen, '10');
  assert.notEqual(ui.session.draft.operationId, oldOperation);
  assert.equal(ui.session.draft.credentialAction, 'keep'); assert.equal(ui.session.draft.credentialValue, '');
  assert.deepEqual(billingIds, [null, 'created-id']);
  assert.equal(ui.document.activeElement, ui.$('#gateway-heading-billing'));
  assert.match(ui.$('#gateway-editor-title').textContent, /已保存（停用）/);
  await ui.input('name', '更新后'); await ui.$('form').dispatch('submit');
  assert.equal(calls.at(-1).body.change.action, 'update');
  assert.equal(calls.at(-1).body.change.channelId, 'created-id');
  assert.equal(ui.dialog.open, false, 'normal editing keeps its original close-on-success behavior');
});
