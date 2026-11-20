import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { parseModels, matchingModels, modelPage } from './model-state.mjs';

test('manual IDs trim and deduplicate without merging case', () => {
  assert.deepEqual(parseModels(' GPT-5,\ngpt-5\nGPT-5,  ,custom/model '), ['GPT-5', 'gpt-5', 'custom/model']);
});

for (const size of [1000, 5000]) {
  test(`${size} candidates remain reachable in pages of at most 50`, () => {
    const catalog = Array.from({ length: size }, (_, i) => `model-${i}`);
    const seen = [];
    for (let page = 0; page < size / 50; page++) {
      const result = modelPage(catalog, new Set(), '', false, page);
      assert.equal(result.items.length, 50);
      assert.equal(result.total, size);
      assert.equal(result.page, page);
      seen.push(...result.items.map(({ id }) => id));
    }
    assert.deepEqual(seen, catalog);
    assert.equal(modelPage(catalog, new Set(), '', false, 9999).page, size / 50 - 1);
  });
}

test('filter-wide selection preserves other and missing IDs, including case variants', () => {
  const selected = new Set(['outside', 'upstream-removed']);
  const catalog = ['GPT-5', 'gpt-5', 'unrelated'];
  matchingModels(catalog, selected, 'GPT').forEach((id) => selected.add(id));
  assert.deepEqual([...selected], ['outside', 'upstream-removed', 'GPT-5', 'gpt-5']);
  const result = modelPage(catalog, selected, '', true);
  assert.equal(result.total, 4);
  assert.equal(result.items.find(({ id }) => id === 'upstream-removed').missing, true);
  assert.equal(result.items.find(({ id }) => id === 'GPT-5').missing, false);
  assert.equal(modelPage(catalog, selected, 'no-match', false, 5).page, 0);
  assert.deepEqual(modelPage(catalog, selected, 'no-match').items, []);
});

// Run the actual app handlers with only the DOM surface they need; no browser or network dependency.
async function appHarness() {
  const listeners = new Map(), elements = new Map(), timers = new Map(), clearedTimers = new Set();
  let nextTimer = 0;
  const element = (selector) => {
    if (!elements.has(selector)) {
      const ownListeners = new Map();
      elements.set(selector, {
        id: selector.slice(1), value: '', innerHTML: '', textContent: '', dataset: {}, open: false,
        disabled: false, isConnected: true, classList: { toggle() {}, add() {}, remove() {} },
        addEventListener(type, fn) { ownListeners.set(type, fn); },
        dispatch(type, event) { return ownListeners.get(type)?.(event); },
        matches(selector) { return selector.toUpperCase() === this.tagName; },
        setAttribute() {}, toggleAttribute() {}, focus() { document.activeElement = this; }, reportValidity: () => true, querySelector: () => null,
        showModal() { this.open = true; },
        animate() { return { finished: Promise.resolve(), cancel() {} }; },
        close() { this.open = false; ownListeners.get('close')?.(); },
        closest(selector) { return selector === 'button' ? this : selector === '#editor-form' ? element('#editor-form') : null; },
      });
    }
    return elements.get(selector);
  };
  const document = {
    documentElement: { dataset: { motion: 'reduce' }, classList: { toggle() {} } },
    activeElement: element('#opener'), querySelector: element,
    querySelectorAll(selector) {
      if (selector !== '[data-tab]') return [];
      return ['basic', 'models', 'billing'].map((tab) => {
        const button = element(`#tab-${tab}`); button.dataset.tab = tab; return button;
      });
    },
    addEventListener(type, fn) { listeners.set(type, [...(listeners.get(type) || []), fn]); },
  };
  const context = vm.createContext({
    document, matchMedia: () => ({ matches: true }), window: { scrollTo() {}, addEventListener() {} }, location: { hash: '' },
    parseModels, matchingModels, modelPage, crypto: { randomUUID: () => 'new-channel' },
    setTimeout(fn) { const id = ++nextTimer; timers.set(id, fn); return id; },
    clearTimeout(id) { timers.delete(id); clearedTimers.add(id); },
    get localStorage() { throw new Error('Storage access is forbidden for this prototype'); },
    get sessionStorage() { throw new Error('Storage access is forbidden for this prototype'); },
  });
  const source = await readFile(new URL('./app.js', import.meta.url), 'utf8');
  const importLine = /^import \{ parseModels, matchingModels, modelPage \} from '\.\/model-state\.mjs';\r?\n/;
  assert.match(source, importLine);
  vm.runInContext(source.replace(importLine, ''), context);
  return {
    element, run: (code) => vm.runInContext(code, context),
    async emit(type, target) {
      await Promise.all((listeners.get(type) || []).map((fn) => fn({ target, preventDefault() {} })));
    },
    emitOn(selector, type, event) { return elements.get(selector).dispatch(type, event); },
    tick() { const [id, fn] = timers.entries().next().value; timers.delete(id); fn(); },
    timerCount: () => timers.size, clearedTimerCount: () => clearedTimers.size,
  };
}

test('a pending catalog response cannot overwrite a different editor draft', async () => {
  const app = await appHarness();
  app.run("openEditor('aster', 'models')");
  const pending = app.emit('click', app.element('#fetch-models'));
  app.run("openEditor('north', 'models')");
  const draft = app.run('state.editor');
  app.tick(); await pending;
  assert.equal(app.run('state.editor'), draft);
  assert.deepEqual([...draft.selected], ['claude-opus-5', 'claude-sonnet-5']);
  assert.ok(draft.catalog.length < 1000);
});

test('connection edits invalidate a pending response and a fresh fetch keeps selection', async () => {
  const app = await appHarness();
  app.run("openEditor('aster', 'models'); state.editor.selected.add('retired-custom')");
  const pending = app.emit('click', app.element('#fetch-models'));
  await app.emit('input', app.element('#channel-url'));
  app.tick(); await pending;
  assert.ok(app.run('state.editor.catalog.length') < 1000);
  assert.match(app.element('#catalog-status').textContent, /连接参数已变化/);
  const fresh = app.emit('click', app.element('#fetch-models'));
  app.tick(); await fresh;
  assert.equal(app.run('state.editor.catalog.length'), 1000);
  assert.equal(app.run("state.editor.selected.has('retired-custom')"), true);
  assert.equal(app.run('state.editor.selected.size'), 3);
});

test('unselecting in only-selected view removes the row and preserves the remaining selection', async () => {
  const app = await appHarness();
  app.run("openEditor('aster', 'models')");
  app.element('#only-selected').checked = true;
  await app.emit('change', app.element('#only-selected'));
  const checkbox = app.element('#unchecked-model');
  checkbox.dataset.model = 'gpt-5.6'; checkbox.checked = false;
  await app.emit('change', checkbox);
  assert.deepEqual([...app.run('state.editor.selected')], ['gpt-5.6-mini']);
  assert.doesNotMatch(app.element('#model-list').innerHTML, /data-model="gpt-5\.6"/);
  assert.match(app.element('#model-list').innerHTML, /data-model="gpt-5\.6-mini"/);
});

test('an invalid priority reveals its tab before native validation and leaves the draft unsaved', async () => {
  const app = await appHarness();
  app.run("openEditor('aster', 'basic')");
  const form = app.element('#editor-form'), priority = app.element('#channel-priority');
  priority.value = '-1'; priority.closest = () => app.element('#panel-models');
  form.querySelector = (selector) => selector === ':invalid' ? priority : null;
  let reports = 0;
  form.reportValidity = () => {
    reports++;
    assert.equal(app.element('#panel-models').hidden, false, 'validation error must be visible');
    return false;
  };
  await app.run('saveChannel({ preventDefault() {} })');
  assert.equal(reports, 1);
  assert.equal(app.run('state.editor.saving'), false);
  assert.equal(app.run("channels.find(c => c.id === 'aster').priority"), 100);
  assert.equal(app.element('#editor').open, true);
});

test('dismiss closes and clears its deadline even when animation completion never settles', { timeout: 2000 }, async () => {
  const app = await appHarness();
  app.run("openEditor('aster'); matchMedia = () => ({ matches: false }); document.documentElement.dataset.motion = 'normal'");
  let cancellations = 0;
  app.element('#editor').animate = () => ({ finished: new Promise(() => {}), cancel() { cancellations++; } });
  const pending = app.run("dismiss(document.querySelector('#editor'))");
  assert.equal(app.element('#editor').open, true);
  assert.equal(app.timerCount(), 1);
  app.tick(); await pending;
  assert.equal(app.element('#editor').open, false);
  assert.equal(app.run('state.editor'), null);
  assert.equal(app.element('#editor').dataset.closing, undefined);
  assert.equal(cancellations, 1);
  assert.equal(app.timerCount(), 0);
  assert.equal(app.clearedTimerCount(), 1);
});

test('channel and request text is escaped in all rendered views, with safe CSS color fallback', async () => {
  const app = await appHarness();
  const payload = '\"><img src=x onerror=alert(1)>';
  app.run(`Object.assign(channels[0], ${JSON.stringify({ name: payload, pool: payload, models: [payload], color: 'url(javascript:alert(1))' })})`);
  app.run(`Object.assign(requests[0], ${JSON.stringify(Object.fromEntries(['channel', 'model', 'effort', 'time', 'status', 'input', 'output', 'read', 'write', 'cost', 'latency'].map((key) => [key, payload])))})`);
  for (const view of ['overview()', 'costBars()', 'channelRows()', 'pricingPage()', 'requestRows()']) {
    const html = app.run(view);
    assert.doesNotMatch(html, /<img\b/, view);
    assert.match(html, /&lt;img/, view);
    assert.doesNotMatch(html, /url\(javascript:/, view);
    for (const [, color] of html.matchAll(/--channel:([^;"\s]+)/g)) assert.match(color, /^var\(--(?:openai|openai-secondary|claude|xai|deepseek|gemini|danger|muted)\)$/);
  }
  const detail = app.element('#request-detail-button'); detail.dataset.detail = '0';
  await app.emit('click', detail);
  assert.doesNotMatch(app.element('#detail-body').innerHTML, /<img\b/);
  assert.match(app.element('#detail-body').innerHTML, /&lt;img/);
});

test('Enter in model search does not implicitly save, while a submit button keeps keyboard activation', async () => {
  const app = await appHarness();
  app.run("openEditor('aster', 'models')");
  const input = app.element('#model-search'); input.tagName = 'INPUT';
  input.closest = (selector) => selector === 'button' ? null : app.element('#editor-form');
  let prevented = false;
  app.emitOn('#editor-form', 'keydown', { key: 'Enter', isComposing: false, target: input, preventDefault() { prevented = true; } });
  assert.equal(prevented, true, 'search Enter must not submit the form');
  assert.equal(app.run('state.editor.saving'), false);
  const button = app.element('#save-channel'); button.tagName = 'BUTTON';
  prevented = false;
  app.emitOn('#editor-form', 'keydown', { key: 'Enter', isComposing: false, target: button, preventDefault() { prevented = true; } });
  assert.equal(prevented, false, 'the focused save button must retain Enter activation');
});

test('save and close clear the password without storing it in channel data or Storage', async () => {
  const app = await appHarness();
  app.run("openEditor('aster')");
  app.element('#channel-key').value = 'test-secret-not-a-real-key';
  app.element('#channel-name').value = 'Renamed channel';
  app.element('#channel-pool').value = 'OpenAI';
  app.element('#channel-priority').value = '100';
  app.element('#channel-url').value = 'https://example.test/v1';
  app.element('#channel-protocol').value = 'OpenAI Chat';
  app.element('#channel-weight').value = '7';
  const pending = app.run('saveChannel({ preventDefault() {} })');
  assert.equal(app.run('state.editor.saving'), true);
  app.run('requestClose()');
  assert.equal(app.element('#editor').open, true);
  app.tick(); await pending;
  assert.equal(app.element('#channel-key').value, '');
  assert.equal(app.run('state.editor'), null);
  assert.equal(app.run("channels.find(c => c.id === 'aster').name"), 'Renamed channel');
  assert.equal(app.run("channels.find(c => c.id === 'aster').url"), 'https://example.test/v1');
  assert.equal(app.run("channels.find(c => c.id === 'aster').protocol"), 'OpenAI Chat');
  assert.equal(app.run("channels.find(c => c.id === 'aster').weight"), 7);
  assert.doesNotMatch(app.run('JSON.stringify(channels)'), /test-secret-not-a-real-key/);
  app.run("openEditor('north')");
  app.element('#channel-key').value = 'another-test-secret';
  app.element('#editor').close();
  assert.equal(app.element('#channel-key').value, '');
});
