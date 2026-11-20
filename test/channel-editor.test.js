import test from 'node:test';
import assert from 'node:assert/strict';
import { parseModelList } from '../public/shared/model-list.js';
import { createEditorDraft, setConnection, setCredential, setSelectedModels, addManualModels, matchingModels,
  selectFilteredModels, modelPage, beginDiscovery, finishDiscovery, previewInput, beginSave, finishSave, closeEditorDraft } from '../public/channel-editor/state.js';
import { mountModelPicker } from '../public/channel-editor/model-picker.js';

const draft = (channel = null) => createEditorDraft(channel, { operationId: 'operation-1', sessionId: 'editor-1' });
const discover = (value, models) => {
  const started = beginDiscovery(value);
  return finishDiscovery(started.draft, started.token, { models, observedAt: '2026-10-27T00:00:00Z' });
};

test('shared parser trims exact duplicates, supports arrays/newlines, and preserves opaque ID case', () => {
  assert.deepEqual(parseModelList(' GPT-5,\ngpt-5\r\nGPT-5,, custom/model '), ['GPT-5', 'gpt-5', 'custom/model']);
  assert.deepEqual(parseModelList(['GPT-5', 'gpt-5,custom/model']), ['GPT-5', 'gpt-5', 'custom/model']);
  assert.deepEqual(parseModelList(null), []);
  assert.throws(() => parseModelList([123]), TypeError);
});

test('UI08: opening on LAN HTTP works when randomUUID is absent but getRandomValues is available', () => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis.crypto, 'randomUUID');
  Object.defineProperty(globalThis.crypto, 'randomUUID', { configurable: true, value: undefined });
  try {
    const current = createEditorDraft();
    assert.match(current.operationId, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    assert.notEqual(current.operationId, current.sessionId);
  } finally {
    if (descriptor) Object.defineProperty(globalThis.crypto, 'randomUUID', descriptor);
    else delete globalThis.crypto.randomUUID;
  }
});

test('UI01: new and edit drafts share fields, default new disabled, preserve string IDs and never hydrate old secrets', () => {
  const original = { id: '084', name: '渠道', models: ['GPT-5'], baseUrl: 'https://old.example', key: 'OLD_SECRET', credentialValue: 'OLD_SECRET' };
  const edit = draft(original), fresh = draft();
  assert.equal(fresh.enabled, false);
  assert.deepEqual(Object.keys(edit), Object.keys(fresh));
  assert.equal(edit.channelId, '084');
  assert.equal(edit.credentialAction, 'keep');
  assert.equal(edit.credentialValue, '');
  assert.doesNotMatch(JSON.stringify(edit), /OLD_SECRET/);
  const changed = setSelectedModels(edit, ['other']);
  assert.deepEqual(original.models, ['GPT-5']);
  assert.deepEqual(edit.selected, ['GPT-5']);
  assert.deepEqual(changed.selected, ['other']);
});

for (const size of [1000, 5000]) {
  test(`UI02: all ${size} discovered model IDs are reachable with at most 50 rendered rows per page`, () => {
    const models = Array.from({ length: size }, (_, i) => `vendor/model-${i}`);
    const current = discover(draft(), models), seen = [];
    for (let page = 0; page < size / 50; page++) {
      const result = modelPage(current, '', 'all', page);
      assert.equal(result.items.length, 50);
      seen.push(...result.items.map(({ id }) => id));
    }
    assert.deepEqual(seen, models);
    assert.deepEqual(current.selected, []);
    assert.equal(current.enabled, false);
    assert.equal(modelPage(current, '', 'all', 9999).page, size / 50 - 1);
  });
}

test('UI02: discovery and repeated discovery preserve selected/manual IDs and report additions/missing separately', () => {
  let current = draft({ id: 'channel', models: ['retired', 'GPT-5'], testModel: 'retired' });
  current = addManualModels(current, 'custom/model, GPT-5, gpt-5');
  current = discover(current, ['GPT-5', 'new-model']);
  assert.deepEqual(current.selected, ['retired', 'GPT-5', 'custom/model', 'gpt-5']);
  assert.deepEqual(matchingModels(current, '', 'missing'), ['retired', 'custom/model', 'gpt-5']);
  current = discover(current, ['GPT-5', 'second-model']);
  assert.deepEqual(matchingModels(current, '', 'added'), ['second-model']);
  assert.equal(current.testModel, 'retired');
  assert.equal(current.enabled, false);
});

test('UI02: select/deselect operates on every filtered result and retains IDs outside the filter', () => {
  let current = discover(draft({ id: 'c', models: ['outside'] }), ['GPT-5', 'gpt-5', 'other']);
  current = selectFilteredModels(current, 'GpT', 'all', true);
  assert.deepEqual(current.selected, ['outside', 'GPT-5', 'gpt-5']);
  current = selectFilteredModels(current, 'gpt', 'selected', false);
  assert.deepEqual(current.selected, ['outside']);
  assert.deepEqual(modelPage(current, 'no-match').items, []);
});

test('UI03: invalid key, empty catalog, and network failures retain previous catalog and selections', () => {
  const initial = discover(draft({ id: 'c', models: ['manual'] }), ['old']);
  for (const result of [{ models: [] }, { error: 'Key 无效' }, { error: '网络失败' }]) {
    const started = beginDiscovery(initial);
    const current = finishDiscovery(started.draft, started.token, result);
    assert.deepEqual(current.discovered, ['old']);
    assert.deepEqual(current.selected, ['manual']);
    assert.equal(current.discoveryStatus, 'error');
    assert.equal(current.observedAt, initial.observedAt);
  }
});

test('UI03/04: connection or credential change clears observation/test results and invalidates older responses', () => {
  for (const change of [
    (current) => setConnection(current, { baseUrl: 'https://new.example' }),
    (current) => setConnection(current, { protocol: 'messages' }),
    (current) => setCredential(current, 'replace', 'NEW_SECRET'),
    (current) => setCredential(current, 'clear'),
  ]) {
    const initial = { ...discover(draft({ id: 'c', models: ['chosen'] }), ['old']), testResult: { success: true } };
    const pending = beginDiscovery(initial), changed = change(pending.draft);
    assert.deepEqual(changed.discovered, []);
    assert.deepEqual(changed.selected, ['chosen']);
    assert.equal(changed.testResult, null);
    assert.equal(changed.observedAt, null);
    assert.equal(finishDiscovery(changed, pending.token, { models: ['stale'] }), changed);
  }
});

test('UI03: newest request wins and closed/other-channel drafts reject pending responses', () => {
  const first = beginDiscovery(draft({ id: 'first', models: ['chosen'] }));
  const second = beginDiscovery(first.draft);
  assert.equal(finishDiscovery(second.draft, first.token, { models: ['stale'] }), second.draft);
  assert.deepEqual(finishDiscovery(second.draft, second.token, { models: ['fresh'] }).discovered, ['fresh']);
  const closed = closeEditorDraft(second.draft);
  assert.equal(finishDiscovery(closed, second.token, { models: ['stale'] }), closed);
  const other = createEditorDraft({ id: 'other', models: ['other'] }, { operationId: 'operation-2', sessionId: 'editor-2' });
  assert.equal(finishDiscovery(other, second.token, { models: ['stale'] }), other);
});

test('UI04: preview sends current target and explicit credential intent, keep requires confirmation for changed target', () => {
  const initial = draft({ id: 'c', baseUrl: 'https://old.example', protocol: 'responses' });
  assert.deepEqual(previewInput(initial, '9007199254740993'), { channelId: 'c', baseGen: '9007199254740993', baseUrl: 'https://old.example', protocol: 'responses', credentialAction: 'keep' });
  const changed = setConnection(initial, { baseUrl: 'https://new.example' });
  assert.throws(() => previewInput(changed), /确认/);
  assert.equal(beginDiscovery(changed).token, null);
  const confirmed = setCredential(changed, 'keep');
  assert.equal(previewInput(confirmed).baseUrl, 'https://new.example');
  const replaced = setCredential(changed, 'replace', 'NEW_SECRET');
  assert.equal(previewInput(replaced).credentialValue, 'NEW_SECRET');
  assert.deepEqual(previewInput(setCredential(replaced, 'clear')), { channelId: 'c', baseUrl: 'https://new.example', protocol: 'responses', credentialAction: 'clear' });
  assert.throws(() => setCredential(draft(), 'keep'), /新渠道/);
  assert.throws(() => previewInput(draft()), /API Key/);
});

test('removing current detection model requires explicit reselection and never substitutes a different model', () => {
  const current = setSelectedModels({ ...draft({ id: 'c', models: ['cheap', 'expensive'], testModel: 'cheap' }), testResult: { success: true } }, ['expensive']);
  assert.equal(current.testModel, '');
  assert.equal(current.testResult, null);
});

test('UI01/05: cancel discards mutable draft without altering source; retry retains operation ID and save state is explicit', () => {
  const source = { id: 'c', models: ['original'] };
  const current = setCredential(setSelectedModels(draft(source), ['changed']), 'replace', 'TEMP_SECRET');
  const saving = beginSave(current);
  assert.equal(beginSave(saving), saving);
  const timeout = finishSave(saving, 'unknown');
  assert.equal(timeout.credentialValue, 'TEMP_SECRET');
  assert.equal(beginSave(timeout).operationId, saving.operationId);
  assert.equal(finishSave(saving, 'pending').saveStatus, 'pending');
  assert.equal(finishSave(saving, 'failed').saveStatus, 'failed');
  assert.equal(finishSave(saving, 'active').saveStatus, 'active');
  const closed = closeEditorDraft(current);
  assert.equal(closed.credentialValue, '');
  assert.deepEqual(closed.selected, []);
  assert.deepEqual(source.models, ['original']);
});

function domHarness() {
  const document = { activeElement: null, createElement(tag) { return new Element(tag); } };
  class Element {
    constructor(tag) { this.tagName = tag; this.ownerDocument = document; this.children = []; this.listeners = {}; this.value = ''; this.attributes = {}; }
    append(...children) { this.children.push(...children); if (this.tagName === 'select' && !this.value) this.value = children[0]?.value || ''; }
    replaceChildren(...children) { this.children = children; }
    addEventListener(name, fn) { this.listeners[name] = fn; }
    setAttribute(name, value) { this.attributes[name] = value; }
    querySelectorAll(tag) { return this.children.flatMap((child) => [...(child.tagName === tag ? [child] : []), ...child.querySelectorAll(tag)]); }
    focus() { document.activeElement = this; }
    emit(name, event = {}) { return this.listeners[name]?.(event); }
  }
  return { document, root: document.createElement('div') };
}

test('UI02/08: picker handlers on simulated DOM search 1000 IDs, select filtered pages, deselect, and navigate controls', () => {
  const { root } = domHarness();
  let current = discover(draft(), Array.from({ length: 1000 }, (_, i) => `model-${i}`));
  let changes = 0;
  mountModelPicker(root, { getDraft: () => current, setDraft: (next) => { current = next; }, onChange: () => changes++ });
  const [toolbar, actions, summary, list, pages] = root.children;
  const search = toolbar.children[0].children[0];
  assert.equal(list.children.length, 50);
  assert.equal(list.attributes['aria-label'], '模型选择');
  search.value = 'model-9'; search.emit('input');
  actions.children[0].emit('click');
  assert.equal(current.selected.length, 111, 'filter selection includes results beyond the rendered page');
  assert.match(summary.textContent, /已选 111 个/);
  pages.children[2].emit('click');
  assert.match(pages.children[1].textContent, /^2 \/ 3$/);
  actions.children[1].emit('click');
  assert.equal(current.selected.length, 0);
  assert.equal(changes, 2);
  assert.equal(search.type, 'search');
  let prevented = false;
  search.emit('keydown', { key: 'Enter', preventDefault() { prevented = true; } });
  assert.equal(prevented, true, 'search Enter cannot implicitly save a channel');
  for (const control of [...actions.children, ...pages.children.filter((child) => child.tagName === 'button')]) assert.equal(control.type, 'button');
});

test('UI08: checkbox handler preserves full hostile model IDs as text and returns focus after removal in selected filter', () => {
  const { root, document } = domHarness();
  const hostile = '<img src=x onerror=alert(1)>';
  let current = draft({ id: 'c', models: [hostile, 'other'] });
  mountModelPicker(root, { getDraft: () => current, setDraft: (next) => { current = next; } });
  const [toolbar, , , list] = root.children;
  const filter = toolbar.children[1].children[0];
  filter.value = 'selected'; filter.emit('change');
  assert.equal(list.children[0].children[1].textContent, hostile);
  assert.equal(list.children[0].children[1].title, hostile);
  const checkbox = list.children[0].children[0];
  checkbox.checked = false; checkbox.emit('change');
  assert.deepEqual(current.selected, ['other']);
  assert.equal(list.children.length, 1);
  assert.equal(document.activeElement, toolbar.children[0].children[0]);
});
