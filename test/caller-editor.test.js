import test from 'node:test';
import assert from 'node:assert/strict';
import { createCallerSession } from '../public/caller-editor/session.js';
import { mountCallerManager } from '../public/caller-editor/editor.js';
import { editorDOM } from './helpers/editor-dom.js';

const config = () => ({ gen: '9007199254740993', pools: [{ id: 'pool', name: '明确池' }], models: [{ id: 'Model/A' }],
  channels: [{ id: '0001', name: '渠道', poolId: 'pool' }, { id: 'other', name: '另一渠道', poolId: 'other' }], callers: [] });
const permissions = () => [{ poolId: 'pool', modelIds: ['Model/A'], channelIds: ['0001'], protocols: ['responses'], groups: ['existing-group'] }];
const caller = () => ({ id: 'caller-exact', name: '现有', enabled: true, subjectEnabled: false, expiresAt: '2027-01-01T00:00:00Z',
  allowedIps: ['127.0.0.1', '::1/128'], permissions: permissions() });
const active = { activated: true, desiredGen: '9007199254740994', committedGen: '9007199254740994', servingGen: '9007199254740994' };
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };

test('caller create defaults disabled and zero permission; exact generation, explicit command and token stays out of app receipt', async () => {
  const calls = [], receipts = [];
  const session = createCallerSession({ config: config(), api: async (path, input) => {
    calls.push({ path, body: JSON.parse(input.body) }); return { ...active, oneTimeToken: 'ONE_TIME_SECRET', callerId: 'created' };
  }, onSaved: (receipt) => receipts.push(receipt) });
  session.edit({ name: '新调用者', enabled: true }); await session.save();
  assert.equal(calls[0].path, '/api/gateway/callers/change'); assert.equal(calls[0].body.baseGen, config().gen);
  assert.deepEqual(calls[0].body.change.caller, { name: '新调用者', enabled: false, subjectEnabled: true, expiresAt: null, allowedIps: [], permissions: [] });
  assert.equal(session.draft.oneTimeToken, 'ONE_TIME_SECRET'); assert.doesNotMatch(JSON.stringify(receipts), /ONE_TIME_SECRET/);
  assert.equal(Object.hasOwn(calls[0].body.change.caller, 'id'), false);
  session.clearToken(); assert.equal(session.draft.oneTimeToken, '');
});

test('caller edit preserves independent subject, expiry, IP and exact permission boundaries; new catalog entries never grant permission', async () => {
  const cfg = config(), original = caller(), calls = [];
  cfg.models.push({ id: 'New/Model' }); cfg.channels.push({ id: 'new-channel', poolId: 'pool' });
  const session = createCallerSession({ config: cfg, caller: original, api: async (_, input) => { calls.push(JSON.parse(input.body)); return active; } });
  session.edit({ name: '已改名' }); await session.save();
  assert.equal(calls[0].change.callerId, original.id);
  assert.deepEqual(calls[0].change.caller.permissions, permissions());
  assert.equal(calls[0].change.caller.subjectEnabled, false); assert.equal(calls[0].change.caller.expiresAt, original.expiresAt);
  assert.deepEqual(calls[0].change.caller.allowedIps, original.allowedIps); assert.equal(original.name, '现有');
});

test('caller validates explicit permission rows without interpreting empty as all', async () => {
  let calls = 0;
  const session = createCallerSession({ config: config(), api: async () => { calls++; return active; } });
  session.edit({ name: 'New', permissions: [{ poolId: 'pool', modelIds: [], channelIds: [], protocols: [], groups: [] }] });
  await session.save(); assert.equal(calls, 0); assert.match(session.draft.error, /明确选择/);
  session.edit({ permissions: [{ ...permissions()[0], channelIds: ['other'] }] }); await session.save(); assert.match(session.draft.error, /属于该分组/);
  session.edit({ permissions: [{ ...permissions()[0], modelIds: ['UNKNOWN'] }] }); await session.save(); assert.match(session.draft.error, /未知模型/);
  session.edit({ permissions: permissions(), expiresAt: 'tomorrow' }); await session.save(); assert.match(session.draft.error, /UTC/);
  assert.equal(calls, 0);
});

test('caller timeout locks drafts and retries identical operation without minting another; unavailable secret is explicit', async () => {
  const calls = [];
  const session = createCallerSession({ config: config(), api: async (_, input) => { calls.push(input.body); if (calls.length === 1) throw new Error('timeout'); return { ...active, callerId: 'created', oneTimeTokenUnavailable: true }; } });
  session.edit({ name: 'New' }); await session.save(); assert.equal(session.draft.status, 'unknown');
  session.edit({ name: 'CHANGED' }); await session.save();
  assert.equal(calls.length, 2); assert.equal(calls[0], calls[1]); assert.equal(session.draft.name, 'New');
  assert.equal(session.draft.tokenUnavailable, true); assert.equal(session.draft.oneTimeToken, '');
});

test('caller duplicate click, pending and activation reconcile retain once-only token until close', async () => {
  const waiting = deferred(), calls = [];
  const session = createCallerSession({ config: config(), api: async (path) => { calls.push(path); return calls.length === 1 ? waiting.promise : active; } });
  session.edit({ name: 'New' }); const first = session.save(); await session.save(); assert.equal(calls.length, 1);
  waiting.resolve({ ...active, servingGen: 'old', activated: false, oneTimeToken: 'ONE_TIME' }); await first;
  assert.equal(session.draft.status, 'pending'); await session.save(); assert.equal(calls.length, 1);
  await session.reconcile(); assert.equal(calls[1], '/api/gateway/reconcile'); assert.equal(session.draft.oneTimeToken, 'ONE_TIME');
  session.close(); assert.equal(session.draft.oneTimeToken, '');
});

test('caller enable/disable/rotate sends action only and never mutates permission payload', async () => {
  for (const action of ['enable', 'disable', 'rotate']) {
    let body;
    const session = createCallerSession({ config: config(), caller: caller(), api: async (_, input) => { body = JSON.parse(input.body); return { ...active, ...(action === 'rotate' ? { oneTimeToken: 'ROTATED' } : {}) }; } });
    await session.save(action);
    assert.deepEqual(body.change, { action, callerId: 'caller-exact' });
    assert.equal(session.draft.oneTimeToken, action === 'rotate' ? 'ROTATED' : '');
  }
});

test('caller close isolates an in-flight result and stale generation keeps the draft for review', async () => {
  const pending = deferred(); let saved = 0;
  const session = createCallerSession({ config: config(), api: () => pending.promise, onSaved: () => { saved++; } });
  session.edit({ name: 'New' }); const save = session.save(); session.close(); pending.resolve({ ...active, oneTimeToken: 'DROP' }); await save;
  assert.equal(saved, 0); assert.equal(session.draft.oneTimeToken, '');
  const stale = createCallerSession({ config: config(), caller: caller(), api: async () => { throw Object.assign(new Error('conflict'), { status: 409 }); } });
  await stale.save(); assert.equal(stale.draft.status, 'failed'); assert.match(stale.draft.error, /配置已变化/);
});

function managerSetup(cfg = config(), api = async () => active, notify) {
  const dom = editorDOM('<template id="gateway-channel-template"></template>');
  globalThis.document = dom.document; globalThis.window = { confirm: () => true };
  const root = dom.document.createElement('section');
  const manager = mountCallerManager({ root, getConfig: () => cfg, api, onSaved: () => {}, notify });
  return { ...dom, root, manager };
}
const findButton = (root, label) => root.querySelectorAll('button').find((node) => node.textContent === label);

test('caller secondary pool lists a shared channel under both groups and saves one all-wildcard grant; foreign channels stay denied', async () => {
  const cfg = config(), original = caller(), calls = [];
  cfg.pools.push({ id: 'secondary', name: '次分组' });
  cfg.channels[0].poolIds = ['pool', 'secondary'];
  original.permissions[0].poolId = 'secondary';
  cfg.callers = [original];
  const ui = managerSetup(cfg, async (_, input) => { calls.push(JSON.parse(input.body)); return active; });
  const session = ui.manager.openEditor(original, ui.trigger);
  const first = ui.root.querySelector('[data-permission-control="group-0"]'), second = ui.root.querySelector('[data-permission-control="group-1"]');
  assert.deepEqual([first.value, first.checked, second.value, second.checked], ['pool', false, 'secondary', true]);
  const hints = ui.root.querySelectorAll('span').filter((node) => node.className.includes('caller-group-channels')).map((node) => node.textContent);
  assert.deepEqual(hints, ['1 个渠道：渠道', '1 个渠道：渠道'], 'the shared channel is a member of both groups, the foreign one of neither');
  await ui.root.querySelector('dialog').querySelector('form').dispatch('submit');
  assert.equal(session.draft.status, 'active');
  assert.deepEqual(calls[0].change.caller.permissions, [{ poolId: 'secondary', channelIds: ['*'], modelIds: ['*'], protocols: ['*'], groups: [] }]);
  const denied = createCallerSession({ config: cfg, caller: original, api: async () => { throw new Error('must not submit'); } });
  denied.edit({ permissions: [{ ...original.permissions[0], channelIds: ['other'] }] });
  await denied.save();
  assert.match(denied.draft.error, /属于该分组/);
  assert.equal(calls.length, 1);
});

test('caller DOM creates native disabled zero-permission draft, updates fields, saves and clears displayed secret on close', async () => {
  let payload;
  const ui = managerSetup(config(), async (_, input) => { payload = JSON.parse(input.body); return { ...active, oneTimeToken: 'DOM_SECRET' }; });
  await findButton(ui.root, '＋ 新增 API 密钥').dispatch('click');
  const dialog = ui.root.querySelector('dialog'); const inputs = dialog.querySelectorAll('input');
  assert.equal(dialog.getAttribute('aria-labelledby'), 'gateway-caller-editor-title');
  const name = inputs.find((node) => node.name === 'name'); name.value = 'DOM New'; await name.dispatch('input');
  assert.equal(inputs.find((node) => node.name === 'enabled').disabled, true);
  await dialog.querySelector('form').dispatch('submit');
  assert.deepEqual(payload.change.caller.permissions, []); assert.equal(payload.change.caller.enabled, false);
  assert.equal(ui.document.activeElement.textContent, '已生效');
  assert.equal(dialog.querySelector('textarea').value, 'DOM_SECRET');
  await findButton(dialog, '取消 / 关闭').dispatch('click'); assert.equal(dialog.children.length, 0);
});

test('caller DOM: the group list has no per-channel / protocol / add-row controls; ticking keeps focus and never mutates the config caller', async () => {
  const cfg = config(); cfg.callers = [caller()]; const ui = managerSetup(cfg);
  const session = ui.manager.openEditor(cfg.callers[0], ui.trigger);
  const dialog = ui.root.querySelector('dialog');
  assert.equal(findButton(ui.root, '添加一条空权限'), undefined); assert.equal(findButton(ui.root, '删除此权限'), undefined);
  assert.equal(dialog.querySelectorAll('select').length, 0, 'no pool dropdown');
  assert.equal(dialog.querySelector('[data-permission-control="0-channel-0"]'), null); assert.equal(dialog.querySelector('[data-permission-control="0-protocol-0"]'), null);
  const group = dialog.querySelector('[data-permission-control="group-0"]'); group.focus(); group.checked = false; await group.dispatch('change');
  assert.deepEqual(session.draft.permissions, []);
  assert.equal(ui.document.activeElement.getAttribute('data-permission-control'), 'group-0');
  assert.deepEqual(cfg.callers[0].permissions, permissions());
});

test('caller DOM explicit rotate confirmation prevents action; accepted rotate uses the caller action endpoint', async () => {
  const cfg = config(); cfg.callers = [caller()]; let calls = 0;
  const ui = managerSetup(cfg, async (_, input) => { calls++; assert.equal(JSON.parse(input.body).change.action, 'rotate'); return { ...active, oneTimeToken: 'ROTATED' }; });
  globalThis.window.confirm = () => false; await findButton(ui.root, '重新签发密钥').dispatch('click'); assert.equal(calls, 0);
  globalThis.window.confirm = () => true; await findButton(ui.root, '重新签发密钥').dispatch('click'); assert.equal(calls, 1);
});

test('caller DOM: an activated save without a one-time token closes the dialog and notifies with the generation', async () => {
  const notes = [], cfg = config(); cfg.callers = [caller()];
  const ui = managerSetup(cfg, async () => active, (message) => notes.push(message));
  const session = ui.manager.openEditor(cfg.callers[0], ui.trigger); const dialog = ui.root.querySelector('dialog');
  await dialog.querySelector('form').dispatch('submit');
  assert.equal(dialog.open, false); assert.equal(session.draft.closed, true); assert.equal(dialog.children.length, 0);
  assert.deepEqual(notes, ['已保存 · gen 9007199254740994']);
});

test('caller DOM: a save that issues a one-time token stays open so the secret remains visible, with no toast', async () => {
  const notes = [];
  const ui = managerSetup(config(), async () => ({ ...active, oneTimeToken: 'DOM_SECRET' }), (message) => notes.push(message));
  await findButton(ui.root, '＋ 新增 API 密钥').dispatch('click');
  const dialog = ui.root.querySelector('dialog'); const name = dialog.querySelectorAll('input').find((node) => node.name === 'name');
  name.value = 'DOM New'; await name.dispatch('input'); await dialog.querySelector('form').dispatch('submit');
  assert.equal(dialog.open, true); assert.equal(dialog.querySelector('textarea').value, 'DOM_SECRET'); assert.deepEqual(notes, []);
});

test('caller DOM: failed save keeps the dialog open with the reason, the typed name and a usable save button', async () => {
  const notes = [];
  const ui = managerSetup(config(), async () => { throw Object.assign(new Error('网关配置字段无效'), { status: 400 }); }, (message) => notes.push(message));
  await findButton(ui.root, '＋ 新增 API 密钥').dispatch('click');
  const dialog = ui.root.querySelector('dialog'); const name = dialog.querySelectorAll('input').find((node) => node.name === 'name');
  name.value = 'DOM New'; await name.dispatch('input'); await dialog.querySelector('form').dispatch('submit');
  assert.equal(dialog.open, true); assert.equal(name.value, 'DOM New');
  assert.equal(dialog.querySelectorAll('p').find((node) => node.getAttribute('role') === 'alert').textContent, '网关配置字段无效');
  const save = findButton(dialog, '保存'); assert.ok(save); assert.equal(save.disabled, false); assert.deepEqual(notes, []);
});

test('caller DOM: saving shows 保存中 and ignores a second submit; enable closes after the one-shot action succeeds', async () => {
  let release, calls = 0; const notes = [];
  const ui = managerSetup(config(), () => { calls++; return new Promise((resolve) => { release = resolve; }); }, (message) => notes.push(message));
  await findButton(ui.root, '＋ 新增 API 密钥').dispatch('click');
  const dialog = ui.root.querySelector('dialog'); const name = dialog.querySelectorAll('input').find((node) => node.name === 'name');
  name.value = 'DOM New'; await name.dispatch('input');
  const first = dialog.querySelector('form').dispatch('submit');
  const busy = findButton(dialog, '保存中'); assert.ok(busy); assert.equal(busy.disabled, true);
  await dialog.querySelector('form').dispatch('submit'); assert.equal(calls, 1);
  release(active); await first; assert.equal(dialog.open, false); assert.deepEqual(notes, ['已保存 · gen 9007199254740994']);
  const cfg = config(); cfg.callers = [{ ...caller(), enabled: false }]; const toggled = [];
  const ui2 = managerSetup(cfg, async () => active, (message) => toggled.push(message));
  await findButton(ui2.root, '启用密钥').dispatch('click'); await new Promise((resolve) => setImmediate(resolve));
  assert.equal(ui2.root.querySelector('dialog').open, false); assert.deepEqual(toggled, ['已保存 · gen 9007199254740994']);
});
