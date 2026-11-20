import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createCallerSession } from '../public/caller-editor/session.js';
import { mountCallerManager } from '../public/caller-editor/editor.js';
import { createGatewaySession } from '../public/channel-editor/gateway-session.js';
import { editorDOM } from './helpers/editor-dom.js';

const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
const css = readFileSync(new URL('../public/styles.css', import.meta.url), 'utf8');
const appSource = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
const config = () => ({ gen: '9', pools: [{ id: 'pool', name: '明确池' }],
  models: [{ id: 'Model/A', vendor: 'openai' }, { id: 'Model/B', vendor: 'openai' }],
  channels: [{ id: '0001', name: '渠道', poolId: 'pool' }, { id: '0002', name: '次渠道', poolId: 'pool' }], callers: [] });
const explicit = () => ({ poolId: 'pool', modelIds: ['Model/A', 'Model/B'], channelIds: ['0001'], protocols: ['responses'], groups: [] });
const caller = (permissions = [explicit()]) => ({ id: 'caller-1', name: '现有', enabled: true, subjectEnabled: true, expiresAt: null, allowedIps: [], permissions });
const active = { activated: true, desiredGen: '10', committedGen: '10', servingGen: '10' };

function setup(cfg = config(), api = async () => active, confirm = () => true) {
  const dom = editorDOM('<template id="gateway-channel-template"></template>');
  globalThis.document = dom.document; globalThis.window = { confirm };
  const root = dom.document.createElement('section');
  const manager = mountCallerManager({ root, getConfig: () => cfg, api, onSaved: () => {}, notify: () => {} });
  return { ...dom, root, manager, cfg };
}
const buttons = (node) => node.querySelectorAll('button');
const byLabel = (node, label) => buttons(node).find((item) => item.getAttribute('aria-label') === label);
const alertText = (dialog) => dialog.querySelectorAll('p').find((node) => node.getAttribute('role') === 'alert').textContent;
// Three groups: claude (2 enabled channels), openai (1 enabled + 1 disabled), gemini (no channels).
const groupConfig = () => ({ gen: '9', pools: [{ id: 'claude', name: 'claude' }, { id: 'openai', name: 'openai' }, { id: 'gemini', name: 'gemini' }],
  models: [{ id: 'Model/A', vendor: 'openai' }],
  channels: [{ id: 'c1', name: 'TokenShop Claude', poolId: 'claude', enabled: true }, { id: 'c2', name: '几方 Claude', poolId: 'claude', poolIds: ['claude'], enabled: true },
    { id: 'o1', name: 'OpenAI 主线', poolId: 'openai', enabled: true }, { id: 'o2', name: 'OpenAI 旧线', poolId: 'openai', enabled: false }], callers: [] });
const grant = (poolId) => ({ poolId, channelIds: ['*'], modelIds: ['*'], protocols: ['*'], groups: [] });
const groupBox = (dialog, index) => dialog.querySelector(`[data-permission-control="group-${index}"]`);
const ticked = (dialog) => [0, 1, 2].map((index) => groupBox(dialog, index).checked);
const hintTexts = (dialog) => dialog.querySelectorAll('span').filter((node) => node.className.includes('caller-group-channels')).map((node) => node.textContent);
const noteOf = (dialog, name) => dialog.querySelector(`[${name}]`);
const named = (dialog) => dialog.querySelectorAll('input').find((node) => node.name === 'name');

test('token list displays custom group names, refreshes renamed groups and preserves permission IDs', () => {
  const cfg = config(), id = 'group-18a7ffad-6f29-444d-ade2-409bc5189c50-1';
  cfg.pools = [{ id, name: 'Gemini 4 自定义分组' }];
  cfg.callers = [caller([{ ...explicit(), poolId: id }, { ...explicit(), poolId: id }, { ...explicit(), poolId: 'unknown' }])];
  const before = structuredClone(cfg.callers);
  const ui = setup(cfg);
  const summary = () => ui.root.querySelectorAll('span').filter((node) => node.className === 'caller-group-chip').map((node) => node.textContent);
  assert.deepEqual(summary(), ['Gemini 4 自定义分组', 'unknown']);
  cfg.pools[0].name = '已改名分组'; ui.manager.render();
  assert.deepEqual(summary(), ['已改名分组', 'unknown']);
  assert.deepEqual(cfg.callers, before);
});
const fill = async (dialog, value) => { const node = named(dialog); node.value = value; await node.dispatch('input'); };
const allText = (node) => [node.textContent, node.getAttribute('aria-label') ?? '', ...node.children.flatMap(allText)];

test('API key list filters by name and group without losing the filter after refresh', async () => {
  const cfg = groupConfig();
  cfg.callers = [caller([grant('claude')]), { ...caller([grant('openai')]), id: 'codex', name: '家里 Codex' }];
  const before = structuredClone(cfg.callers), ui = setup(cfg);
  const search = ui.root.querySelector('[aria-label="搜索 API 密钥"]');
  const filter = ui.root.querySelector('[aria-label="按分组筛选 API 密钥"]');
  search.value = 'CODEX'; await search.dispatch('input');
  assert.deepEqual(ui.root.querySelectorAll('article').map((row) => row.getAttribute('data-caller-id')), ['codex']);
  ui.manager.render();
  assert.equal(search.value, 'CODEX'); assert.equal(ui.root.querySelectorAll('article').length, 1);
  search.value = ''; await search.dispatch('input');
  filter.value = 'claude'; await filter.dispatch('change');
  assert.deepEqual(ui.root.querySelectorAll('article').map((row) => row.getAttribute('data-caller-id')), ['caller-1']);
  cfg.pools[0].name = 'Claude 新分组'; ui.manager.render();
  assert.equal(filter.value, 'claude');
  assert.equal(ui.root.querySelectorAll('article')[0].querySelectorAll('span').some((node) => node.textContent === 'Claude 新分组'), true);
  search.value = '不存在'; await search.dispatch('input');
  assert.equal(ui.root.querySelectorAll('article').length, 0);
  assert.deepEqual(cfg.callers, before);
});

test('group switching opens the existing key, searches without discarding selection, and saves only on submit', async () => {
  const cfg = groupConfig(), calls = []; cfg.callers = [caller([grant('claude')])];
  const ui = setup(cfg, async (path, input) => { calls.push([path, JSON.parse(input.body)]); return active; });
  await ui.root.querySelector('[aria-label="现有：更改可用分组"]').dispatch('click');
  const dialog = ui.root.querySelector('dialog');
  const search = dialog.querySelector('[aria-label="搜索可用分组"]');
  assert.equal(ui.document.activeElement, search);
  const first = groupBox(dialog, 0);
  search.value = 'OpenAI 主线'; await search.dispatch('input');
  assert.equal(first.parentNode.hidden, true); assert.equal(groupBox(dialog, 1).parentNode.hidden, false);
  const second = groupBox(dialog, 1); second.checked = true; await second.dispatch('change');
  assert.equal(groupBox(dialog, 0), first, 'selection does not remount controls');
  assert.deepEqual(ticked(dialog), [true, true, false]);
  await byLabel(dialog, '移除 claude 分组').dispatch('click');
  assert.deepEqual(ticked(dialog), [false, true, false]);
  assert.equal(ui.document.activeElement, search, 'removing a filtered-out group does not focus a hidden row');
  search.value = 'NO_MATCH'; await search.dispatch('input');
  assert.deepEqual(ticked(dialog), [false, true, false]);
  assert.equal(calls.length, 0, 'choosing groups does not mutate the running configuration');
  await dialog.querySelector('form').dispatch('submit');
  assert.equal(calls.length, 1);
  assert.equal(calls[0][1].change.action, 'update');
  assert.equal(calls[0][1].change.callerId, 'caller-1');
  assert.deepEqual(calls[0][1].change.caller.permissions, [grant('openai')]);
  assert.deepEqual(cfg.callers[0].permissions, [grant('claude')]);
});

test('group list: one checkbox row per group in config order, with channel count, names and disabled marks under the name', () => {
  const cfg = groupConfig(), ui = setup(cfg); ui.manager.openEditor(null, ui.trigger);
  const dialog = ui.root.querySelector('dialog');
  assert.deepEqual([0, 1, 2].map((index) => groupBox(dialog, index).value), ['claude', 'openai', 'gemini']);
  assert.deepEqual([0, 1, 2].map((index) => groupBox(dialog, index).getAttribute('aria-label')), ['claude', 'openai', 'gemini']);
  assert.deepEqual(ticked(dialog), [false, false, false], 'a new token starts with no group');
  assert.deepEqual(hintTexts(dialog), ['2 个渠道：TokenShop Claude、几方 Claude', '2 个渠道：OpenAI 主线、OpenAI 旧线（已停用）', '暂无渠道']);
  assert.equal(dialog.querySelectorAll('legend').some((node) => node.textContent === '可用分组'), true);
  assert.equal(dialog.querySelectorAll('legend').some((node) => node.textContent === '显式权限'), false);
  const hints = dialog.querySelectorAll('p').map((node) => node.textContent);
  assert.ok(hints.includes('支持多选。更改后点保存生效，密钥不变；分组新增渠道、渠道新增模型后自动可用。'));
  assert.ok(hints.includes('未选择分组，这把密钥没有模型调用权限。'));
  assert.equal(noteOf(dialog, 'data-group-empty-hint').hidden, false, 'nothing ticked: the hint is visible');
  assert.equal(noteOf(dialog, 'data-group-legacy-note').hidden, true, 'a new token has no legacy note');
});

test('ticking groups saves one all-wildcard permission per group in config order; ticking none saves an empty list', async () => {
  const calls = [], ui = setup(groupConfig(), async (_, input) => { calls.push(JSON.parse(input.body)); return active; });
  ui.manager.openEditor(null, ui.trigger);
  const dialog = ui.root.querySelector('dialog'); await fill(dialog, 'T');
  for (const index of [2, 0]) { const box = groupBox(dialog, index); box.checked = true; await box.dispatch('change'); }
  assert.equal(noteOf(dialog, 'data-group-empty-hint').hidden, true);
  await dialog.querySelector('form').dispatch('submit');
  assert.deepEqual(calls[0].change.caller.permissions, [grant('claude'), grant('gemini')], 'config order, not click order');
  assert.deepEqual(Object.keys(calls[0].change.caller.permissions[0]).sort(), ['channelIds', 'groups', 'modelIds', 'poolId', 'protocols']);

  const empty = setup(groupConfig(), async (_, input) => { calls.push(JSON.parse(input.body)); return active; });
  empty.manager.openEditor(null, empty.trigger);
  const box = empty.root.querySelector('dialog'); await fill(box, 'E');
  const claude = groupBox(box, 0); claude.checked = true; await claude.dispatch('change');
  claude.checked = false; await claude.dispatch('change');
  assert.equal(noteOf(box, 'data-group-empty-hint').hidden, false);
  await box.querySelector('form').dispatch('submit');
  assert.deepEqual(calls[1].change.caller.permissions, []);
});

test('opening a token pre-ticks every group its permissions name; opening is not an edit and saving converts the permissions to group grants', async () => {
  const calls = [], cfg = groupConfig();
  cfg.callers = [caller([{ ...explicit(), poolId: 'openai', channelIds: ['o1'], modelIds: ['Model/A'] }, grant('claude'), { ...explicit(), poolId: 'openai', channelIds: ['o2'] }])];
  const ui = setup(cfg, async (_, input) => { calls.push(JSON.parse(input.body)); return active; });
  const session = ui.manager.openEditor(cfg.callers[0], ui.trigger); const dialog = ui.root.querySelector('dialog');
  assert.deepEqual(ticked(dialog), [true, true, false], 'claude and openai, whatever the permission order');
  assert.equal(session.dirty, false);
  await dialog.querySelector('form').dispatch('submit');
  assert.deepEqual(calls[0].change.caller.permissions, [grant('claude'), grant('openai')]);
  assert.equal(cfg.callers[0].permissions.length, 3, 'the config object is not mutated');
});

test('the fine-grained note shows only for tokens whose permissions are not all-wildcard; it stays after a failed save and goes once saved', async () => {
  const note = '此密钥原来按渠道或协议细分授权，保存后改为按分组授权：可用所选分组的全部渠道和全部模型';
  const visible = (dialog) => noteOf(dialog, 'data-group-legacy-note').hidden === false && noteOf(dialog, 'data-group-legacy-note').textContent === note;
  const open = (permissions, api) => {
    const cfg = groupConfig(); cfg.callers = [caller(permissions)];
    const ui = setup(cfg, api); ui.manager.openEditor(cfg.callers[0], ui.trigger); return ui.root.querySelector('dialog');
  };
  assert.equal(visible(open([grant('claude'), grant('openai')])), false, 'group grants only: no note');
  assert.equal(visible(open([])), false);
  assert.equal(visible(open([grant('claude'), { ...grant('openai'), channelIds: ['o1'] }])), true, 'one channel-limited row');
  assert.equal(visible(open([{ ...grant('claude'), protocols: ['responses'] }])), true, 'protocol-limited row');
  assert.equal(visible(open([{ ...grant('claude'), modelIds: ['Model/A'] }])), true, 'model-limited row');
  assert.equal(visible(open([{ ...grant('claude'), groups: ['vip'] }])), true, 'a legacy group restriction is dropped by the conversion, so it is announced too');

  const failing = open([explicit()], async () => { throw Object.assign(new Error('网关配置字段无效'), { status: 400 }); });
  assert.equal(visible(failing), true);
  await failing.querySelector('form').dispatch('submit');
  assert.equal(visible(failing), true, 'nothing was persisted, so the note stays');
  const pending = open([explicit()], async () => ({ ...active, activated: false, servingGen: '9' }));
  await pending.querySelector('form').dispatch('submit');
  assert.equal(pending.open, true); assert.equal(noteOf(pending, 'data-group-legacy-note').hidden, true, 'saved: the permissions are already group grants');
});

test('terminology: the caller editor, the channel editor template and the channel list no longer say 路由池 / 主池 / 所属池 / 池优先级', () => {
  const cfg = groupConfig(); cfg.callers = [caller([explicit()])];
  const ui = setup(cfg); ui.manager.openEditor(cfg.callers[0], ui.trigger);
  const rendered = allText(ui.root.querySelector('dialog')).join('\n');
  assert.doesNotMatch(rendered, /池/, 'rendered DOM of the caller editor');
  const template = html.match(/<template id="gateway-channel-template">([\s\S]*?)<\/template>/)[1].replace(/<[^>]*>/g, ' ');
  assert.doesNotMatch(template, /路由池|主池|所属池|池优先级|该池/);
  for (const text of ['主分组', '所属分组（可多选）', '主分组必须属于已选分组', '在渠道列表调整各分组顺位', '厂商、协议与分组分别配置', '与模型厂商、分组分别配置']) assert.ok(template.includes(text), text);
  assert.match(appSource, /\$\{channel\.routingPool\} 分组 ·/); assert.doesNotMatch(appSource, /\$\{channel\.routingPool\} 池/);
  assert.doesNotMatch(appSource, /\$\{poolId\} 池/);
  for (const file of ['../public/channel-editor/gateway-session.js', '../public/caller-editor/session.js', '../public/caller-editor/editor.js']) {
    const text = readFileSync(new URL(file, import.meta.url), 'utf8').split('\n').filter((line) => !/^\s*\/\//.test(line)).join('\n');
    assert.doesNotMatch(text, /路由池|主池|所属池|池优先级/, file);
  }
  const cfgChannel = { pools: [{ id: 'a', name: 'a' }, { id: 'b', name: 'b' }], models: [{ id: 'Model/A', vendor: 'openai' }],
    channels: [{ id: '1', name: 'N', poolId: 'a', baseUrl: 'https://x.invalid', enabled: true, hasCredential: true, priority: 1, weight: 1, testModel: 'Model/A',
      models: [{ modelId: 'Model/A', upstreamModel: 'Model/A', capabilities: ['responses'] }] }] };
  const channelSession = createGatewaySession({ config: { gen: '1', ...cfgChannel }, channel: null });
  assert.throws(() => channelSession.command(), /请填写名称、分组、上游地址并选择模型/);
  const existing = createGatewaySession({ config: { gen: '1', ...cfgChannel }, channel: cfgChannel.channels[0] });
  existing.edit({ poolIds: ['b'] }); assert.match(existing.summary, /所属分组/);
  assert.throws(() => existing.command(), /请至少选择一个有效所属分组，并保留主分组/);
});

test('session: a draft opened on an explicit model list is not dirty, and wildcardModels still writes ["*"] without mutating the config', async () => {
  const cfg = config(); cfg.callers = [caller([explicit(), { ...explicit(), modelIds: ['*'] }])];
  const session = createCallerSession({ config: cfg, caller: cfg.callers[0], wildcardModels: true, api: async () => active });
  assert.equal(session.dirty, false, 'opening an explicit-list row is not an edit');
  await session.save();
  assert.deepEqual(session.draft.permissions.map((row) => row.modelIds), [['*'], ['*']]);
  assert.deepEqual(cfg.callers[0].permissions[0], explicit());
});

test('session: channel_ids and protocols accept exactly ["*"]; a mixed list is still validated as an explicit list', async () => {
  const calls = [], cfg = config();
  const run = async (patch) => {
    const session = createCallerSession({ config: cfg, api: async (_, input) => { calls.push(JSON.parse(input.body)); return active; } });
    session.edit({ name: 'N', permissions: [{ ...explicit(), ...patch }] }); await session.save(); return session;
  };
  assert.equal((await run({ channelIds: ['*'], modelIds: ['*'], protocols: ['*'] })).draft.error, '');
  assert.deepEqual(calls[0].change.caller.permissions, [{ poolId: 'pool', channelIds: ['*'], modelIds: ['*'], protocols: ['*'], groups: [] }]);
  assert.equal((await run({ channelIds: ['*'] })).draft.error, '', 'each field is a wildcard on its own');
  assert.equal((await run({ protocols: ['*'] })).draft.error, '');
  assert.match((await run({ channelIds: ['*', '0001'] })).draft.error, /属于该分组/);
  assert.match((await run({ protocols: ['*', 'responses'] })).draft.error, /未知协议/);
  assert.match((await run({ channelIds: [] })).draft.error, /明确选择模型、渠道和协议/);
  assert.match((await run({ protocols: ['nope'] })).draft.error, /未知协议/);
  assert.match((await run({ poolId: 'gone' })).draft.error, /请选择有效的权限分组/);
  assert.equal(calls.length, 3);
});


test('session: wildcard accepted as the only model entry; explicit-list validation is unchanged', async () => {
  const calls = [], cfg = config();
  const run = async (modelIds, extra = {}) => {
    const session = createCallerSession({ config: cfg, api: async (_, input) => { calls.push(JSON.parse(input.body)); return active; }, ...extra });
    session.edit({ name: 'N', permissions: [{ ...explicit(), modelIds }] }); await session.save(); return session;
  };
  assert.equal((await run(['*'])).draft.error, '', 'default session accepts ["*"]');
  assert.deepEqual(calls[0].change.caller.permissions[0].modelIds, ['*']);
  assert.match((await run(['*', 'Model/A'])).draft.error, /未知模型/, 'a mixed list is not a wildcard');
  assert.match((await run(['UNKNOWN'])).draft.error, /未知模型/);
  assert.match((await run([])).draft.error, /明确选择模型/);
  const blank = createCallerSession({ config: cfg, wildcardModels: true, api: async () => active });
  blank.edit({ name: 'N', permissions: [{ poolId: 'pool', modelIds: [], channelIds: [], protocols: [], groups: [] }] }); await blank.save();
  assert.match(blank.draft.error, /明确选择渠道和协议/);
  assert.equal(calls.length, 1);
});

test('close paths: the × button, the backdrop and Esc share one path (confirm on edits, never while saving)', async () => {
  const asked = [];
  let answer = false;
  const ui = setup(config(), async () => active, (message) => { asked.push(message); return answer; });
  const open = () => { ui.manager.openEditor(null, ui.trigger); return ui.root.querySelector('dialog'); };
  const edit = async (dialog, value) => { const name = dialog.querySelectorAll('input').find((node) => node.name === 'name'); name.value = value; await name.dispatch('input'); };
  const backdrop = async (dialog, target = dialog) => { await dialog.dispatch('mousedown', { target }); await dialog.dispatch('click', { target }); };

  let dialog = open();
  assert.ok(byLabel(dialog, '关闭 API 密钥编辑器'), 'header has a × button');
  await byLabel(dialog, '关闭 API 密钥编辑器').dispatch('click');
  assert.equal(dialog.open, false); assert.deepEqual(asked, [], 'clean draft closes without asking');

  for (const [name, close] of [['×', (d) => byLabel(d, '关闭 API 密钥编辑器').dispatch('click')], ['遮罩', (d) => backdrop(d)],
    ['Esc', (d) => d.oncancel({ preventDefault() {} })]]) {
    asked.length = 0; answer = false; dialog = open(); await edit(dialog, name);
    await close(dialog);
    assert.equal(dialog.open, true, `${name}: refused confirm keeps the dialog`); assert.deepEqual(asked, ['放弃未保存的 API 密钥设置？']);
    answer = true; await close(dialog);
    assert.equal(dialog.open, false, `${name}: accepted confirm closes`);
  }

  dialog = open(); answer = true; asked.length = 0;
  const form = dialog.querySelector('form');
  await dialog.dispatch('mousedown', { target: form }); await dialog.dispatch('click', { target: dialog });
  assert.equal(dialog.open, true, 'a drag that starts inside the card and ends on the backdrop does not close');
  await dialog.dispatch('click', { target: form }); assert.equal(dialog.open, true, 'clicks inside the card never close');
  await dialog.dispatch('click', { target: dialog }); assert.equal(dialog.open, true, 'a click without a matching press does not close');
  await backdrop(dialog); assert.equal(dialog.open, false);
  await backdrop(dialog); // a closed editor ignores late backdrop events

  let release;
  const slow = setup(config(), () => new Promise((resolve) => { release = resolve; }), () => true);
  slow.manager.openEditor(null, slow.trigger); const saving = slow.root.querySelector('dialog'); await edit(saving, 'S');
  const pending = saving.querySelector('form').dispatch('submit');
  await byLabel(saving, '关闭 API 密钥编辑器').dispatch('click'); await saving.dispatch('mousedown', { target: saving }); await saving.dispatch('click', { target: saving });
  saving.oncancel({ preventDefault() {} });
  assert.equal(saving.open, true); assert.equal(alertText(saving), '正在保存，请等待结果后关闭');
  release(active); await pending;
});

test('layout: the shared editor shell is a column whose footer never leaves the viewport (caller and channel editors)', () => {
  const rule = (selector) => css.match(new RegExp(`^${selector.replace(/[.>*]/g, '\\$&')} \\{([^}]*)\\}`, 'm'))?.[1] ?? '';
  const shell = rule('.gateway-editor-shell');
  assert.match(shell, /display: flex/); assert.match(shell, /flex-direction: column/); assert.match(shell, /min-height: 0/);
  assert.doesNotMatch(css, /\.gateway-editor-shell \{[^}]*grid-template-rows/, 'the fixed four-row grid caused the hidden footer');
  assert.match(rule('.gateway-editor-shell > *'), /flex: none/, 'header, tabs, token box and footer keep their own height');
  assert.match(rule('.gateway-editor-shell > .gateway-editor-body'), /flex: 1 1 0/);
  const body = rule('.gateway-editor-body'); assert.match(body, /min-height: 0/); assert.match(body, /overflow-y: auto/);
  assert.match(css, /\.gateway-channel-dialog \{[^}]*overflow: hidden/);
  assert.match(css, /@media \(max-width: 719px\) \{[^@]*\.gateway-channel-dialog \{ max-width: none; \}/, 'phone drawer must override the <dialog> default max-width');

  const ui = setup(); ui.manager.openEditor(null, ui.trigger);
  const form = ui.root.querySelector('dialog').querySelector('form');
  assert.deepEqual(form.children.map((node) => node.tagName), ['HEADER', 'DIV', 'SECTION', 'FOOTER']);
  assert.equal(form.children.at(-1).hidden, false); assert.equal(form.children[2].hidden, true, 'the token box is hidden until a token exists');
  assert.ok(form.children[3].querySelectorAll('button').some((node) => node.textContent === '取消 / 关闭'));
  const channelForm = editorDOM(html).template.content.children[0];
  assert.deepEqual(channelForm.children.map((node) => node.tagName), ['HEADER', 'NAV', 'DIV', 'FOOTER']);
  assert.equal([...html.matchAll(/class="gateway-editor-shell/g)].length, 1, 'the channel template is the only other user of the shell class');
});

test('copy and channel list: new semantics text, and the list no longer carries a 选择模型 entry', () => {
  const ui = setup(); ui.manager.openEditor(null, ui.trigger);
  const hints = ui.root.querySelector('dialog').querySelectorAll('p').map((node) => node.textContent).join('\n');
  assert.match(hints, /分组新增渠道、渠道新增模型后自动可用/);
  assert.doesNotMatch(hints, /新增渠道和模型不会自动授权/);
  assert.doesNotMatch(appSource, /选择模型/); assert.doesNotMatch(appSource, /openGatewayChannel\([^)]*'models'/);
  assert.doesNotMatch(appSource, /tab === 'models'/);
  assert.match(appSource, /cell\(modelPills\(channel\.models\), 'channel-models'\)/, 'read-only model pills stay');
  assert.match(html, /data-editor-tab="models"[^>]*>模型与路由</, 'the settings tab stays');
  assert.doesNotMatch(html, /data-editor-picker/); assert.match(html, /data-editor-fetch>拉取上游模型</);
});

test('the one-time key has a copy button that works on the plain-http console and falls back to selecting the text', async () => {
  const issued = { ...active, oneTimeToken: 'sk-motai-ONE_TIME', callerId: 'created' };
  const original = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  const run = async ({ secure, clipboardFails = false, execResult = true }) => {
    const notes = [], dom = editorDOM('<template id="gateway-channel-template"></template>');
    const copied = [];
    globalThis.document = dom.document; dom.document.execCommand = (name) => { copied.push(['exec', name]); return execResult; };
    globalThis.window = { confirm: () => true, isSecureContext: secure };
    Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { clipboard: { writeText: async (value) => { if (clipboardFails) throw new Error('denied'); copied.push(['clipboard', value]); } } } });
    const root = dom.document.createElement('section');
    const manager = mountCallerManager({ root, getConfig: groupConfig, api: async () => issued, onSaved: () => {}, notify: (text, tone) => notes.push([text, tone]) });
    manager.openEditor(null, dom.trigger);
    const dialog = root.querySelector('dialog'); await fill(dialog, 'K');
    await dialog.querySelector('form').dispatch('submit');
    const box = dialog.querySelector('textarea');
    box.select = () => copied.push(['select']); box.setSelectionRange = () => {};
    assert.equal(box.value, 'sk-motai-ONE_TIME');
    const copy = buttons(dialog).find((node) => node.textContent === '复制密钥');
    assert.ok(copy, 'copy button next to the key');
    await copy.dispatch('click');
    return { copied, notes, copy };
  };
  const secure = await run({ secure: true });
  assert.deepEqual(secure.copied, [['clipboard', 'sk-motai-ONE_TIME']]);
  assert.deepEqual(secure.notes.at(-1), ['密钥已复制到剪贴板', 'normal']);
  assert.equal(secure.copy.textContent, '已复制');
  const plain = await run({ secure: false });
  assert.deepEqual(plain.copied, [['select'], ['exec', 'copy']], 'http page: select the text and use execCommand');
  const denied = await run({ secure: true, clipboardFails: true, execResult: false });
  assert.deepEqual(denied.notes.at(-1), ['浏览器拒绝了复制，请在文本框里手动选中复制', 'error']);
  Object.defineProperty(globalThis, 'navigator', original);
});
