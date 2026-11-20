import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { openGatewayEditor } from '../public/channel-editor/gateway-editor.js';
import { modelCategory, vendorLabel, groupModelsByVendor, fetchModelSets, defaultFetchTab, resolveFetchTab, toggleModelGroup } from '../public/channel-editor/state.js';
import { editorDOM } from './helpers/editor-dom.js';

const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
const css = readFileSync(new URL('../public/styles.css', import.meta.url), 'utf8');
const config = () => ({ gen: '9', pools: [{ id: 'pool', name: '明确池' }],
  models: [{ id: 'Model/A', vendor: 'openai' }, { id: 'retired-model', vendor: 'xai' }, { id: 'gpt-5-mini', vendor: 'openai' }],
  channels: [{ id: '0001', name: '原渠道', baseUrl: 'https://old.invalid', poolId: 'pool', enabled: true, hasCredential: true,
    priority: 4, weight: 1, testModel: 'Model/A', models: ['Model/A', 'retired-model', 'gpt-5-mini'].map((modelId) =>
      ({ modelId, upstreamModel: modelId, capabilities: ['responses'] })) }] });
// 126 个上游模型：Model/A、gpt-5-mini 是已有；retired-model 不在其中（上游未返回）；其余 123 个是新增。
const catalog = () => {
  const ids = ['Model/A', 'gpt-5-mini'];
  for (let i = 0; i < 30; i++) ids.push(`gpt-5-${i}`);
  for (let i = 0; i < 30; i++) ids.push(`claude-sonnet-${i}`);
  for (let i = 0; i < 30; i++) ids.push(`gemini-2-${i}`);
  for (let i = 0; i < 20; i++) ids.push(`grok-${i}`);
  for (let i = 0; i < 14; i++) ids.push(`zeta-custom-${i}`);
  return ids;
};
const active = { activated: true, desiredGen: '10', committedGen: '10', servingGen: '10' };
const flush = () => new Promise((resolve) => setImmediate(resolve));

function setup({ api, models = catalog(), confirm = () => true, prepare = () => {} } = {}) {
  const dom = editorDOM(html), cfg = config(); prepare(cfg); globalThis.document = dom.document; globalThis.window = { confirm };
  const calls = [];
  const fakeApi = api || (async () => ({ models: models.map((id) => ({ id, capabilities: ['responses'] })), observedAt: 'T' }));
  const session = openGatewayEditor({ ...dom, config: cfg, channel: cfg.channels[0], api: async (...args) => { calls.push(args[0]); return fakeApi(...args); } });
  const fetchDialog = dom.dialog.children.find((node) => node.tagName === 'DIALOG');
  const $ = (selector) => fetchDialog.querySelector(selector), $$ = (selector) => fetchDialog.querySelectorAll(selector);
  const tabs = () => Object.fromEntries($$('[data-fetch-tab]').map((node) => [node.getAttribute('data-fetch-tab'), node]));
  const label = (name) => tabs()[name].textContent;
  const groups = () => $$('[data-fetch-group]').map((node) => node.getAttribute('data-fetch-group'));
  const group = (name) => $$('[data-fetch-group]').find((node) => node.getAttribute('data-fetch-group') === name);
  const models_ = (name) => group(name).querySelectorAll('[data-fetch-model]').map((node) => node.getAttribute('data-fetch-model'));
  const headText = (name) => group(name).querySelectorAll('button')[0].textContent;
  const picked = (name) => group(name).querySelectorAll('span').find((node) => /^已选 \d+ \/ \d+$/.test(node.textContent)).textContent;
  const groupBox = (name) => group(name).querySelector('[data-fetch-group-check]');
  const type = async (value) => { const search = $('[data-fetch-search]'); search.value = value; await search.dispatch('input'); };
  const open = async () => { await dom.dialog.querySelector('[data-editor-fetch]').dispatch('click'); await flush(); };
  const count = () => $('[aria-live]').textContent;
  return { ...dom, cfg, session, calls, fetchDialog, $, $$, tabs, label, groups, group, models_, headText, picked, groupBox, type, open, count };
}

test('vendor rules ported from New API: keyword order, regex rules, Other, and config vendor wins for known models', () => {
  const cases = { 'claude-3-5-sonnet': 'Anthropic', 'gpt-4o': 'OpenAI', 'o3-mini': 'OpenAI', 'sonar-pro': 'Perplexity', 'nvidia/llama-3': 'NVIDIA',
    'gemini-2.5-pro': 'Gemini', 'grok-4': 'xAI', 'deepseek-chat': 'DeepSeek', 'qwen3-max': 'Qwen', 'glm-4.6': 'Zhipu', 'kimi-k2': 'Moonshot',
    'meta-llama/llama-3': 'Meta', 'totally-unknown': 'Other', 'Model/A': 'Other' };
  for (const [id, vendor] of Object.entries(cases)) assert.equal(modelCategory(id), vendor, id);
  assert.equal(modelCategory('  GPT-5  '), 'OpenAI', 'trim and case-insensitive');
  assert.equal(vendorLabel('google'), 'Gemini'); assert.equal(vendorLabel('anthropic'), 'Anthropic'); assert.equal(vendorLabel('acme'), 'acme'); assert.equal(vendorLabel(''), '');
  const vendors = new Map([['Model/A', 'openai'], ['grok-x', 'google']]);
  assert.deepEqual(groupModelsByVendor(['zzz', 'grok-x', 'claude-1', 'gpt-1', 'Model/A', 'claude-0'], vendors),
    [{ vendor: 'Anthropic', models: ['claude-1', 'claude-0'] }, { vendor: 'Gemini', models: ['grok-x'] }, { vendor: 'OpenAI', models: ['gpt-1', 'Model/A'] }, { vendor: 'Other', models: ['zzz'] }],
    'A→Z between groups, Other last, upstream order inside a group, config vendor beats the keyword rules');
});

test('tab sets: new / existing / not returned, case-insensitive search, default tab rule, fallback when search empties a tab', () => {
  const draft = { selected: ['keep', 'old', 'Gone'], discovered: ['keep', 'Fresh', 'old', 'NEWER'], observedAt: 'T', added: [] };
  assert.deepEqual(fetchModelSets(draft), { new: ['Fresh', 'NEWER'], existing: ['keep', 'old'], removed: ['Gone'] });
  assert.deepEqual(fetchModelSets(draft, 'newer'), { new: ['NEWER'], existing: [], removed: [] });
  assert.deepEqual(fetchModelSets(draft, 'ne'), { new: ['NEWER'], existing: [], removed: ['Gone'] }, 'substring, not prefix');
  assert.deepEqual(fetchModelSets(draft, ' GONE '), { new: [], existing: [], removed: ['Gone'] });
  assert.deepEqual(fetchModelSets({ ...draft, observedAt: null }).removed, [], 'nothing is "not returned" before a successful fetch');
  assert.equal(defaultFetchTab({ new: [1], existing: [1], removed: [1] }), 'new');
  assert.equal(defaultFetchTab({ new: [], existing: [1], removed: [1] }), 'removed');
  assert.equal(defaultFetchTab({ new: [], existing: [1], removed: [] }), 'existing');
  assert.equal(defaultFetchTab({ new: [], existing: [], removed: [] }), 'existing');
  assert.equal(resolveFetchTab({ new: [1], existing: [1], removed: [] }, 'existing'), 'existing', 'a tab the user chose stays');
  assert.equal(resolveFetchTab({ new: [1], existing: [], removed: [] }, 'existing'), 'new', 'an emptied tab falls back to the default rule');
  assert.deepEqual(toggleModelGroup(['a', 'b'], ['b', 'c'], true), ['a', 'b', 'c']);
  assert.deepEqual(toggleModelGroup(['a', 'b', 'c'], ['b', 'x'], false), ['a', 'c']);
});

test('fetch dialog: opens after the credential gate, auto-fetches 126 models, shows tab counts and the default tab, no pagination', async () => {
  const ui = setup();
  assert.equal(ui.fetchDialog.open ?? false, false);
  assert.equal(ui.$('h2').textContent, '获取模型');
  await ui.open();
  assert.equal(ui.fetchDialog.open, true); assert.equal(ui.calls.filter((path) => path === '/api/gateway/models/preview').length, 1);
  assert.equal(ui.session.draft.discovered.length, 126);
  assert.deepEqual([ui.label('new'), ui.label('existing'), ui.label('removed')], ['新增 (124)', '已有 (2)', '上游未返回 (1)']);
  assert.equal(ui.tabs().new.getAttribute('aria-selected'), 'true', 'new models exist, so the default is 新增');
  assert.deepEqual(ui.groups(), ['Anthropic', 'Gemini', 'OpenAI', 'xAI', 'Other']);
  assert.equal(ui.headText('OpenAI'), '▾ OpenAI (30)'); assert.equal(ui.headText('Other'), '▾ Other (14)');
  assert.equal(ui.$$('[data-fetch-model]').length, 124, 'every new model is in the DOM at once');
  assert.equal(ui.models_('OpenAI')[0], 'gpt-5-0', 'upstream order inside a group');
  assert.equal(ui.count(), '已选 3 个模型', 'initial ticks = draft.selected');
  assert.equal(ui.$$('button').some((node) => /全选|取消筛选|上一页|下一页/.test(node.textContent)), false);
  assert.equal(ui.$$('[data-fetch-model]').every((node) => !node.checked), true, 'new models start unticked');
  await ui.tabs().existing.dispatch('click');
  assert.deepEqual(ui.groups(), ['OpenAI']);
  assert.deepEqual(ui.models_('OpenAI'), ['Model/A', 'gpt-5-mini'], 'Model/A has no keyword match but its config vendor is openai');
  await ui.tabs().removed.dispatch('click');
  assert.deepEqual(ui.groups(), ['xAI']); assert.deepEqual(ui.models_('xAI'), ['retired-model'], 'config vendor puts retired-model under xAI');
  assert.equal(ui.$$('[data-fetch-model]')[0].checked, true, 'already selected models are ticked');
});

test('fetch dialog: default tab falls to 上游未返回, then 已有, when there is nothing newer', async () => {
  const onlyKnown = setup({ models: ['Model/A', 'gpt-5-mini'] }); await onlyKnown.open();
  assert.deepEqual([onlyKnown.label('new'), onlyKnown.label('existing'), onlyKnown.label('removed')], ['新增 (0)', '已有 (2)', '上游未返回 (1)']);
  assert.equal(onlyKnown.tabs().new.disabled, true, 'an empty tab is disabled'); assert.equal(onlyKnown.tabs().existing.disabled, false);
  assert.equal(onlyKnown.tabs().removed.getAttribute('aria-selected'), 'true');
  const all = setup({ models: ['Model/A', 'gpt-5-mini', 'retired-model'] }); await all.open();
  assert.deepEqual([all.label('new'), all.label('existing'), all.label('removed')], ['新增 (0)', '已有 (3)', '上游未返回 (0)']);
  assert.equal(all.tabs().existing.getAttribute('aria-selected'), 'true'); assert.equal(all.tabs().removed.disabled, true);
});

test('fetch dialog: search is a case-insensitive substring match, counts follow it live, emptied tabs disable and the view moves', async () => {
  const ui = setup(); await ui.open();
  await ui.type('GPT-5-1');
  assert.deepEqual([ui.label('new'), ui.label('existing'), ui.label('removed')], ['新增 (11)', '已有 (0)', '上游未返回 (0)']);
  assert.equal(ui.tabs().existing.disabled, true); assert.equal(ui.tabs().removed.disabled, true);
  assert.deepEqual(ui.groups(), ['OpenAI']); assert.equal(ui.models_('OpenAI').length, 11);
  await ui.type('RETIRED');
  assert.deepEqual([ui.label('new'), ui.label('existing'), ui.label('removed')], ['新增 (0)', '已有 (0)', '上游未返回 (1)']);
  assert.equal(ui.tabs().removed.getAttribute('aria-selected'), 'true', 'the emptied 新增 tab hands over to the default rule');
  await ui.type('nothing-matches');
  assert.equal(ui.$$('[data-fetch-tab]').every((node) => node.disabled), true);
  assert.match(ui.$('[role="tabpanel"]').querySelector('p').textContent, /没有匹配/);
  await ui.type('');
  assert.equal(ui.label('new'), '新增 (124)');
});

test('fetch dialog: group checkbox acts on the current search result only, with 已选 x / y and a tri-state box', async () => {
  const ui = setup(); await ui.open();
  assert.equal(ui.picked('OpenAI'), '已选 0 / 30');
  await ui.type('gpt-5-1');
  assert.equal(ui.picked('OpenAI'), '已选 0 / 11');
  const box = ui.groupBox('OpenAI'); box.checked = true; await box.dispatch('change');
  assert.equal(ui.picked('OpenAI'), '已选 11 / 11'); assert.equal(ui.count(), '已选 14 个模型');
  assert.equal(ui.groupBox('OpenAI').checked, true);
  await ui.type('');
  assert.equal(ui.picked('OpenAI'), '已选 11 / 30', 'the other 19 gpt-5 models were not touched');
  assert.equal(ui.groupBox('OpenAI').checked, false); assert.equal(ui.groupBox('OpenAI').indeterminate, true);
  await ui.type('gpt-5-2');
  const again = ui.groupBox('OpenAI'); again.checked = true; await again.dispatch('change');
  await ui.type('gpt-5-1');
  const off = ui.groupBox('OpenAI'); off.checked = false; await off.dispatch('change');
  assert.equal(ui.count(), '已选 14 个模型', '+11 (gpt-5-2x) -11 (gpt-5-1x, incl. the ones ticked earlier)');
  await ui.type('');
  assert.equal(ui.picked('OpenAI'), '已选 11 / 30');
  assert.deepEqual(ui.session.draft.selected, ['Model/A', 'retired-model', 'gpt-5-mini'], 'the draft is untouched until 确认');
});

test('fetch dialog: groups collapse and re-expand, and a single tick updates the footer count', async () => {
  const ui = setup(); await ui.open();
  const toggle = () => ui.group('xAI').querySelectorAll('button')[0];
  assert.equal(toggle().getAttribute('aria-expanded'), 'true', 'groups start expanded');
  await toggle().dispatch('click');
  assert.equal(ui.group('xAI').querySelectorAll('[data-fetch-model]').length, 0); assert.equal(ui.headText('xAI'), '▸ xAI (20)');
  assert.equal(ui.groupBox('xAI') !== null, true, 'the group tick stays usable while collapsed');
  await toggle().dispatch('click'); assert.equal(ui.models_('xAI').length, 20);
  const one = ui.group('Other').querySelector('[data-fetch-model]'); one.checked = true; await one.dispatch('change');
  assert.equal(ui.count(), '已选 4 个模型'); assert.equal(ui.picked('Other'), '已选 1 / 14');
});

test('fetch dialog: 确认 writes the draft once through setSelectedModels; 取消 / Esc / 遮罩 / × all discard', async () => {
  const ui = setup(); await ui.open();
  const before = [...ui.session.draft.selected];
  const tick = async () => { const box = ui.$$('[data-fetch-model]')[0]; box.checked = true; await box.dispatch('change'); };
  const reopen = async () => { await ui.open(); assert.equal(ui.count(), `已选 ${before.length} 个模型`, 'a reopened dialog starts from the draft again'); };

  await tick(); await ui.$('[data-fetch-cancel]').dispatch('click');
  assert.equal(ui.fetchDialog.open, false); assert.deepEqual(ui.session.draft.selected, before);
  await reopen(); await tick(); ui.fetchDialog.oncancel({ preventDefault() {} });
  assert.equal(ui.fetchDialog.open, false); assert.deepEqual(ui.session.draft.selected, before, 'Esc');
  await reopen(); await tick(); await ui.fetchDialog.dispatch('mousedown', { target: ui.fetchDialog }); await ui.fetchDialog.dispatch('click', { target: ui.fetchDialog });
  assert.equal(ui.fetchDialog.open, false); assert.deepEqual(ui.session.draft.selected, before, 'backdrop');
  await reopen(); await tick(); await ui.$('[data-fetch-close]').dispatch('click');
  assert.equal(ui.fetchDialog.open, false); assert.deepEqual(ui.session.draft.selected, before, '×');
  assert.equal(ui.dialog.open, true, 'the channel editor stays open under it');

  await reopen(); await ui.tabs().removed.dispatch('click');
  const retired = ui.$$('[data-fetch-model]')[0]; retired.checked = false; await retired.dispatch('change');
  await ui.tabs().new.dispatch('click'); await tick();
  assert.equal(ui.count(), '已选 3 个模型');
  let writes = 0; const original = ui.session.replaceDraft; ui.session.replaceDraft = (next) => { writes++; return original(next); };
  await ui.$('[data-fetch-confirm]').dispatch('click');
  assert.equal(ui.fetchDialog.open, false); assert.equal(writes, 1);
  assert.deepEqual(ui.session.draft.selected, ['Model/A', 'gpt-5-mini', 'claude-sonnet-0'], 'kept order first, newly ticked appended, unticked removed');
  assert.equal(ui.dialog.querySelector('[data-editor-selected-summary]').textContent, '已选 3 个模型：Model/A、gpt-5-mini、claude-sonnet-0');
  assert.equal(ui.dialog.querySelector('[name="modelsText"]').value, 'Model/A, gpt-5-mini, claude-sonnet-0');
  assert.equal(ui.session.dirty, true, 'saving the channel is what writes it; the draft is just dirty');
  assert.equal(ui.calls.includes('/api/gateway/channels/change'), false, 'confirm never saves the channel');
  const clean = setup(); await clean.open(); await clean.$('[data-fetch-confirm]').dispatch('click');
  assert.equal(clean.session.dirty, false, 'confirming an untouched selection changes nothing');
});

test('fetch dialog: the credential gate runs first; loading, failure and empty results offer 重试', async () => {
  const gated = setup({ confirm: () => false });
  const url = gated.dialog.querySelector('[name="baseUrl"]'); url.value = 'https://new.invalid'; await url.dispatch('input');
  await gated.open();
  assert.equal(gated.fetchDialog.open ?? false, false, 'unconfirmed credential target: no dialog');
  assert.equal(gated.calls.includes('/api/gateway/models/preview'), false);
  assert.match(gated.dialog.querySelector('[data-editor-error]').textContent, /确认沿用凭据的目标/);
  await gated.dialog.querySelector('[data-editor-confirm-key]').dispatch('click');
  assert.equal(gated.session.draft.credentialConfirmed, false);

  const confirmed = setup(); const target = confirmed.dialog.querySelector('[name="baseUrl"]'); target.value = 'https://new.invalid'; await target.dispatch('input');
  globalThis.window.confirm = () => true; await confirmed.dialog.querySelector('[data-editor-confirm-key]').dispatch('click');
  await confirmed.open(); assert.equal(confirmed.fetchDialog.open, true, 'after confirming the target the dialog opens and fetches');
  assert.equal(confirmed.calls.filter((path) => path === '/api/gateway/models/preview').length, 1);

  let release, attempt = 0;
  // 第 1 次挂起后返回空目录，第 2 次网络失败，第 3 次成功。
  const slow = setup({ api: () => { attempt++; if (attempt === 1) return new Promise((resolve) => { release = resolve; });
    if (attempt === 2) return Promise.reject(new Error('上游 502')); return Promise.resolve({ models: [{ id: 'gpt-9', capabilities: ['responses'] }], observedAt: 'T' }); } });
  await slow.dialog.querySelector('[data-editor-fetch]').dispatch('click');
  assert.equal(slow.$('[role="status"]').textContent, '正在拉取上游模型…', 'loading state while the request is pending');
  assert.equal(slow.$('[data-fetch-confirm]').disabled, true); assert.equal(slow.$('[data-fetch-search]').parentNode.hidden, true);
  release({ models: [], observedAt: 'T' }); await flush();
  assert.ok(slow.$('[data-fetch-retry]'), 'an empty result shows 重试'); assert.match(slow.$('[role="tabpanel"]').textContent || slow.session.draft.discoveryError, /没有返回可用模型/);
  await slow.$('[data-fetch-retry]').dispatch('click'); await flush();
  assert.ok(slow.$('[data-fetch-retry]'), 'a failed request shows 重试 too'); assert.equal(slow.session.draft.discoveryError, '上游 502');
  await slow.$('[data-fetch-retry]').dispatch('click'); await flush();
  assert.equal(slow.$('[data-fetch-retry]'), null); assert.equal(slow.label('new'), '新增 (1)');
});

test('fetch dialog: closing the channel editor closes the nested dialog; layout rules for desktop and a 390px phone', async () => {
  const ui = setup(); await ui.open();
  await ui.dialog.querySelector('[data-editor-close]').dispatch('click');
  assert.equal(ui.fetchDialog.open, false); assert.equal(ui.dialog.open, false);

  const rule = (selector) => css.match(new RegExp(`^${selector.replace(/[.>*"[\]=]/g, '\\$&')} \\{([^}]*)\\}`, 'm'))?.[1] ?? '';
  assert.match(rule('.fetch-models-shell'), /flex-direction: column/);
  assert.match(rule('.fetch-models-shell > .fetch-models-body'), /overflow-y: auto/); assert.match(rule('.fetch-models-shell > .fetch-models-body'), /overflow-x: hidden/);
  assert.match(rule('.fetch-models-shell > .fetch-models-body'), /min-height: 0/);
  const phone = css.match(/@media \(max-width: 760px\) \{\s*\.fetch-models-dialog \{([^}]*)\}([\s\S]*?)\n\}/);
  assert.ok(phone, 'phone rules exist'); assert.match(phone[1], /width: 100vw/); assert.match(phone[1], /height: 100dvh/);
  assert.match(phone[2], /\.fetch-models-grid \{ grid-template-columns: minmax\(0, 1fr\); \}/, 'one column on a phone');
  assert.match(rule('.model-picker-id'), /overflow-wrap: anywhere/, 'long ids wrap instead of scrolling sideways');
});
