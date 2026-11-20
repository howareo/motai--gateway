import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createGatewaySession } from '../public/channel-editor/gateway-session.js';
import { openGatewayEditor } from '../public/channel-editor/gateway-editor.js';
import { editorDOM } from './helpers/editor-dom.js';

const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
const FULL = ['chat_completions', 'messages', 'count_tokens'];
// 复现线上渠道 1020：两个模型的能力都是 chat_completions / messages / count_tokens。
const config = (caps = [FULL, FULL]) => ({ gen: '9', pools: [{ id: 'claude', name: 'claude' }],
  models: ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-opus-5.5', 'claude-sonnet-5.5'].map((id) => ({ id, vendor: 'anthropic' })),
  channels: [{ id: '1020', name: '几方 Claude', poolId: 'claude', baseUrl: 'https://old.invalid', enabled: true, priority: 1, weight: 1, hasCredential: true,
    testModel: 'claude-opus-5-5', models: ['claude-opus-5-5', 'claude-sonnet-5-5'].map((modelId, index) => ({ modelId, upstreamModel: modelId, capabilities: [...caps[index]] })) }] });
const edit = (cfg = config()) => createGatewaySession({ config: cfg, channel: cfg.channels[0], api: async () => ({}) });
const saved = (session) => Object.fromEntries(session.command().change.channel.models.map((model) => [model.modelId, model.capabilities]));

test('capabilities: a model added to an existing channel inherits the union; existing models keep theirs', () => {
  const cfg = config([['chat_completions', 'messages'], ['chat_completions', 'count_tokens']]);
  const session = edit(cfg);
  session.select(['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-opus-5.5']);
  assert.deepEqual(saved(session), { 'claude-opus-5-5': ['chat_completions', 'messages'], 'claude-sonnet-5-5': ['chat_completions', 'count_tokens'],
    'claude-opus-5.5': FULL }, 'the union keeps first-seen order; the originals are untouched');
  assert.equal(session.draft.protocolChanged, false);
});

test('capabilities: renaming models keeps the channel capabilities (the gen 9 -> 14 drift)', () => {
  const session = edit();
  assert.equal(session.draft.protocol, 'chat_completions', 'the dropdown starts at the first model\'s first capability');
  session.select(['claude-opus-5.5', 'claude-sonnet-5.5']);
  assert.deepEqual(saved(session), { 'claude-opus-5.5': FULL, 'claude-sonnet-5.5': FULL });
  session.select(['claude-opus-5.5']);
  assert.deepEqual(saved(session), { 'claude-opus-5.5': FULL }, 'dropping every original model does not lose the union');
});

test('capabilities: discovered models in an existing channel use the union, not the single protocol the preview was asked with', async () => {
  const cfg = config(), calls = [];
  const session = createGatewaySession({ config: cfg, channel: cfg.channels[0], api: async (_, input) => {
    calls.push(JSON.parse(input.body)); return { models: [{ id: 'claude-opus-5.5', capabilities: ['chat_completions'] }], observedAt: 'T' }; } });
  await session.discover();
  assert.deepEqual(calls[0].capabilities, ['chat_completions'], 'the preview request still probes the dropdown protocol');
  session.select(['claude-opus-5-5', 'claude-opus-5.5']);
  assert.deepEqual(saved(session)['claude-opus-5.5'], FULL);
});

test('capabilities: only an explicit change of the transport dropdown rewrites them, and choosing the original value again undoes it', () => {
  const session = edit();
  session.select(['claude-opus-5-5', 'claude-opus-5.5']);
  session.edit({ protocol: 'messages' }); session.credential('keep', '', true); // 改协议后沿用已有凭据要重新确认，这是已有规则
  assert.equal(session.draft.protocolChanged, true);
  assert.deepEqual(saved(session), { 'claude-opus-5-5': ['messages'], 'claude-opus-5.5': ['messages'] }, 'existing and new models alike');
  assert.match(session.summary, /传输协议/);
  session.edit({ protocol: 'chat_completions' }); session.credential('keep', '', true);
  assert.equal(session.draft.protocolChanged, false, 'back to the opening value is not a change');
  assert.deepEqual(saved(session), { 'claude-opus-5-5': FULL, 'claude-opus-5.5': FULL });
  assert.doesNotMatch(session.summary, /传输协议/);
  session.edit({ protocol: 'chat_completions' });
  assert.equal(session.draft.protocolChanged, false, 'setting the same value is not a change');
});

test('capabilities: nothing but the dropdown sets protocolChanged', () => {
  const session = edit();
  for (const patch of [{ name: 'x' }, { weight: 3 }, { priority: 2 }, { adapter: 'anthropic' }, { baseUrl: 'https://moved.invalid' }, { vendor: 'anthropic' }, { enabled: false }]) {
    session.edit(patch); assert.equal(session.draft.protocolChanged, false, JSON.stringify(patch));
  }
  session.select(['claude-opus-5.5']); session.credential('keep', '', true);
  assert.equal(session.draft.protocolChanged, false);
  assert.deepEqual(saved(session), { 'claude-opus-5.5': FULL });
});

test('capabilities: a new channel (no models yet) uses the dropdown value', () => {
  const cfg = config();
  const fresh = (patch) => { const session = createGatewaySession({ config: cfg, api: async () => ({}) });
    session.edit({ name: 'N', baseUrl: 'https://new.invalid', vendor: 'anthropic', ...patch }); session.select(['claude-opus-5.5', 'brand-new']);
    session.credential('replace', 'KEY'); return saved(session); };
  assert.deepEqual(fresh({}), { 'claude-opus-5.5': ['responses'], 'brand-new': ['responses'] }, 'untouched dropdown = its default');
  assert.deepEqual(fresh({ protocol: 'messages' }), { 'claude-opus-5.5': ['messages'], 'brand-new': ['messages'] });
  assert.deepEqual(fresh({ protocol: 'responses' }), { 'claude-opus-5.5': ['responses'], 'brand-new': ['responses'] });
});

test('capabilities: the read-only readout is the same function the save command uses', () => {
  const session = edit(config([['chat_completions', 'messages'], ['count_tokens']]));
  session.select(['claude-opus-5-5', 'claude-opus-5.5']);
  const readout = Object.fromEntries(session.capabilities.map((row) => [row.modelId, row.capabilities]));
  assert.deepEqual(readout, saved(session));
  session.edit({ protocol: 'responses' }); session.credential('keep', '', true);
  assert.deepEqual(Object.fromEntries(session.capabilities.map((row) => [row.modelId, row.capabilities])), saved(session));
  assert.deepEqual(session.capabilities.map((row) => row.capabilities), [['responses'], ['responses']]);
});

function setupDom(create = false) {
  const dom = editorDOM(html), cfg = config(); globalThis.document = dom.document; globalThis.window = { confirm: () => true };
  const calls = [];
  const session = openGatewayEditor({ ...dom, config: cfg, channel: create ? null : cfg.channels[0], api: async (path, input) => { calls.push({ path, body: input && JSON.parse(input.body) }); return {
    activated: true, desiredGen: '10', committedGen: '10', servingGen: '10' }; } });
  const $ = (selector) => dom.dialog.querySelector(selector);
  const rows = () => $('[data-editor-capabilities]').children.map((row) => [row.getAttribute('data-capability-model'), row.getAttribute('data-capability-values'),
    row.children.slice(1).map((chip) => chip.textContent).join(',')]);
  const type = async (value) => { const node = $('[name="modelsText"]'); node.value = value; await node.dispatch('input'); };
  return { ...dom, session, $, rows, type, calls };
}

test('capabilities readout: shown per selected model on the 模型与路由 tab, follows typing and the dropdown, hidden with no models', async () => {
  const ui = setupDom();
  const panel = ui.$('[data-editor-panel="models"]');
  assert.ok(panel.querySelector('[data-editor-capabilities]'), 'the readout lives inside the models tab');
  assert.deepEqual(ui.rows(), [['claude-opus-5-5', FULL.join(','), FULL.join(',')], ['claude-sonnet-5-5', FULL.join(','), FULL.join(',')]]);
  assert.equal(ui.$('[data-editor-capabilities]').hidden, false);
  await ui.type('claude-opus-5-5, claude-opus-5.5');
  assert.deepEqual(ui.rows().map((row) => [row[0], row[1]]), [['claude-opus-5-5', FULL.join(',')], ['claude-opus-5.5', FULL.join(',')]], 'a typed new name inherits the union');
  const protocol = ui.$('[name="protocol"]'); protocol.value = 'messages'; await protocol.dispatch('change');
  assert.deepEqual(ui.rows().map((row) => row[1]), ['messages', 'messages']);
  protocol.value = 'chat_completions'; await protocol.dispatch('change');
  assert.deepEqual(ui.rows().map((row) => row[1]), [FULL.join(','), FULL.join(',')]);
  await ui.type('');
  assert.equal(ui.$('[data-editor-capabilities]').hidden, true); assert.deepEqual(ui.rows(), []);
  assert.match(html, /新增或改名的模型沿用本渠道原有模型能力的并集/);
  assert.match(html, /data-editor-capabilities[^>]*role="list"/);
});

test('capabilities readout: what is shown is what the save request carries', async () => {
  const ui = setupDom();
  await ui.type('claude-opus-5.5, claude-sonnet-5.5');
  const shown = Object.fromEntries(ui.rows().map((row) => [row[0], row[1].split(',')]));
  await ui.$('form').dispatch('submit');
  const sent = ui.calls.find((call) => call.path === '/api/gateway/channels/change').body.change.channel.models;
  assert.deepEqual(Object.fromEntries(sent.map((model) => [model.modelId, model.capabilities])), shown);
  assert.deepEqual(shown, { 'claude-opus-5.5': FULL, 'claude-sonnet-5.5': FULL });
  const created = setupDom(true);
  assert.deepEqual(created.rows(), [], 'a new channel starts with an empty readout');
});
