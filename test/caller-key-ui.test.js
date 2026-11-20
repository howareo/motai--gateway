import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mountCallerManager } from '../public/caller-editor/editor.js';
import { copyText } from '../public/caller-editor/clipboard.js';
import { editorDOM } from './helpers/editor-dom.js';

const SECRET = 'sk-motai-UI-SYNTHETIC-KEY-0123456789';
const callers = () => [
  { id: 'with-key', name: '有密钥', enabled: true, subjectEnabled: true, expiresAt: null, allowedIps: [], permissions: [], keyStored: true },
  { id: 'old one/1', name: '旧令牌', enabled: true, subjectEnabled: true, expiresAt: null, allowedIps: [], permissions: [], keyStored: false },
  { id: 'older', name: '更旧', enabled: false, subjectEnabled: true, expiresAt: null, allowedIps: [], permissions: [] },
];
const labels = (root) => root.querySelectorAll('button').map((node) => node.textContent);
const find = (root, label) => root.querySelectorAll('button').find((node) => node.textContent === label);

// The shared fake DOM has no body, select(), setSelectionRange() or remove(); add just those for the clipboard paths.
function setup({ secure = true, clipboard, exec = true, api, config = { callers: callers(), pools: [], channels: [], models: [] }, refresh } = {}) {
  const dom = editorDOM('<template id="gateway-channel-template"></template>');
  const events = [], notes = [];
  const create = dom.document.createElement;
  dom.document.createElement = (tag) => {
    const node = create(tag);
    node.select = () => events.push(['select', tag]);
    node.setSelectionRange = () => {};
    node.remove = () => { events.push(['remove', tag]); node.parentNode.children = node.parentNode.children.filter((child) => child !== node); };
    return node;
  };
  dom.document.body = dom.document.createElement('body');
  dom.document.execCommand = (name) => { events.push(['exec', name, dom.document.body.children.at(-1)?.value]); return exec; };
  globalThis.document = dom.document;
  globalThis.window = { confirm: () => true, isSecureContext: secure };
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: clipboard ? { clipboard } : {} });
  const calls = [];
  const root = dom.document.createElement('section');
  const manager = mountCallerManager({ root, getConfig: () => config, notify: (text, tone) => notes.push([text, tone]),
    onSaved: () => {}, refreshConfig: refresh ?? (async () => {}),
    api: async (path, init) => { calls.push([path, init?.method, init?.body ? JSON.parse(init.body) : undefined]); return api ? api(path, init) : {}; } });
  return { ...dom, root, manager, events, notes, calls, config };
}
const navigatorOriginal = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
test.afterEach(() => { if (navigatorOriginal) Object.defineProperty(globalThis, 'navigator', navigatorOriginal); else delete globalThis.navigator; });

test('rows show 复制密钥 when the key is stored and 导入旧密钥 otherwise, never both', () => {
  const ui = setup();
  const rows = ui.root.querySelectorAll('article');
  assert.equal(rows.length, 3);
  const [stored, legacy, unknown] = rows.map((row) => row.querySelectorAll('button').filter((node) => node.textContent).map((node) => node.textContent));
  assert.deepEqual(stored, ['复制密钥', '编辑', '停用密钥', '重新签发密钥']);
  assert.deepEqual(legacy.slice(0, 2), ['导入旧密钥', '编辑']);
  assert.ok(legacy.includes('保存') && !legacy.includes('复制密钥'));
  assert.ok(unknown.includes('导入旧密钥') && !unknown.includes('复制密钥'), 'a missing keyStored counts as not stored');
});

test('copy on a secure page: fetches the key, writes it to the clipboard, toasts, and leaves no key in the DOM', async () => {
  const written = [];
  const ui = setup({ clipboard: { writeText: async (value) => { written.push(value); } }, api: () => ({ token: SECRET }) });
  await find(ui.root, '复制密钥').dispatch('click');
  assert.deepEqual(ui.calls, [['/api/gateway/callers/with-key/key', 'POST', {}]]);
  assert.deepEqual(written, [SECRET]);
  assert.deepEqual(ui.notes, [['密钥已复制', undefined]]);
  assert.equal(find(ui.root, '复制密钥').disabled, false, 'button usable again');
  assert.equal(JSON.stringify(ui.root.querySelectorAll('textarea').map((node) => node.value)).includes(SECRET), false);
});

test('copy on a plain-http page: temporary textarea is selected, copied with execCommand and removed again', async () => {
  const ui = setup({ secure: false, api: () => ({ token: SECRET }) });
  await find(ui.root, '复制密钥').dispatch('click');
  assert.deepEqual(ui.events, [['select', 'textarea'], ['exec', 'copy', SECRET], ['remove', 'textarea']]);
  assert.equal(ui.document.body.children.length, 0, 'scratch field removed');
  assert.deepEqual(ui.notes, [['密钥已复制', undefined]]);
});

test('when the browser refuses to copy, a box shows the key selected with a Ctrl+C hint, and closing it clears the key', async () => {
  const ui = setup({ secure: false, exec: false, api: () => ({ token: SECRET }) });
  await find(ui.root, '复制密钥').dispatch('click');
  assert.deepEqual(ui.notes, [], 'no success toast');
  const dialog = ui.root.querySelectorAll('dialog').find((node) => node.className === 'caller-key-dialog');
  assert.equal(dialog.open, true);
  const box = dialog.querySelector('textarea');
  assert.equal(box.value, SECRET); assert.equal(box.readOnly, true);
  assert.ok(ui.events.some((event) => event[0] === 'select' && event[1] === 'textarea'));
  assert.ok(dialog.querySelectorAll('p').some((node) => node.textContent.includes('Ctrl+C')));
  await find(dialog, '关闭').dispatch('click');
  assert.equal(dialog.open, false); assert.equal(dialog.children.length, 0); assert.equal(box.value, '');
});

test('a stale 404 refreshes the list and explains, without copying anything', async () => {
  let refreshed = 0;
  const ui = setup({ refresh: async () => { refreshed += 1; ui.config.callers[0].keyStored = false; },
    api: () => { throw Object.assign(new Error('这个令牌没有保存密钥'), { status: 404 }); } });
  await find(ui.root, '复制密钥').dispatch('click');
  assert.equal(refreshed, 1);
  assert.equal(ui.notes[0][1], 'error'); assert.match(ui.notes[0][0], /密钥未保存/);
  assert.equal(labels(ui.root).filter((text) => text === '复制密钥').length, 0, 'row switched to import');
});

test('other read failures toast the reason', async () => {
  const ui = setup({ api: () => { throw Object.assign(new Error('密钥库不可用'), { status: 503 }); } });
  await find(ui.root, '复制密钥').dispatch('click');
  assert.deepEqual(ui.notes, [['读取密钥失败：密钥库不可用', 'error']]);
});

test('import: the panel opens on demand, sends the pasted key, refreshes and the row becomes copyable', async () => {
  let refreshed = 0;
  const ui = setup({ refresh: async () => { refreshed += 1; ui.config.callers[1].keyStored = true; }, api: () => ({ keyStored: true }) });
  const panel = ui.root.querySelectorAll('div').find((node) => node.className === 'caller-key-import');
  assert.equal(panel.hidden, true);
  assert.match(panel.querySelectorAll('p').map((node) => node.textContent).join('\n'), /旧记录没有保存密钥，粘贴你手里的旧密钥即可/);
  assert.match(panel.querySelectorAll('p').map((node) => node.textContent).join('\n'), /重新签发新密钥/);
  await ui.root.querySelectorAll('button').filter((node) => node.textContent === '导入旧密钥')[0].dispatch('click');
  assert.equal(panel.hidden, false);
  const input = panel.querySelector('input'); assert.equal(input.type, 'password');
  input.value = `  ${SECRET}  `;
  await find(panel, '保存').dispatch('click');
  assert.deepEqual(ui.calls, [['/api/gateway/callers/old%20one%2F1/key/import', 'POST', { token: SECRET }]]);
  assert.equal(refreshed, 1);
  assert.deepEqual(ui.notes, [['密钥已保存，可以复制了', undefined]]);
  assert.equal(labels(ui.root).filter((text) => text === '复制密钥').length, 2, 'both rows copyable now');
  assert.equal(JSON.stringify(ui.root.querySelectorAll('input').map((node) => node.value)).includes(SECRET), false, 'field cleared');
});

test('import: a mismatching key shows the mismatch message and the button works again; bad format and empty input are handled', async () => {
  const outcomes = [Object.assign(new Error('x'), { status: 422 }), Object.assign(new Error('x'), { status: 400 }), Object.assign(new Error('磁盘错误'), { status: 500 })];
  const ui = setup({ api: () => { throw outcomes.shift(); } });
  const panel = ui.root.querySelectorAll('div').find((node) => node.className === 'caller-key-import');
  const input = panel.querySelector('input'), save = find(panel, '保存');
  const message = () => panel.querySelectorAll('p').find((node) => node.getAttribute('role') === 'alert').textContent;
  await save.dispatch('click');
  assert.equal(ui.calls.length, 0, 'empty input never reaches the server'); assert.equal(message(), '请先粘贴旧密钥');
  input.value = 'sk-wrong';
  await save.dispatch('click');
  assert.equal(message(), '密钥和此记录不匹配'); assert.equal(save.disabled, false); assert.equal(input.value, 'sk-wrong', 'typed text kept for a fix');
  await save.dispatch('click'); assert.equal(message(), '密钥格式不正确');
  await save.dispatch('click'); assert.equal(message(), '保存失败：磁盘错误');
  assert.deepEqual(ui.notes, []);
});

test('copyText: secure pages use the async clipboard, others select a field and use execCommand, failures return false', async () => {
  const ui = setup({ secure: true, clipboard: { writeText: async () => { throw new Error('denied'); } } });
  assert.equal(await copyText('abc', ui.document), true, 'denied async clipboard falls back to execCommand');
  assert.deepEqual(ui.events.map((event) => event[0]), ['select', 'exec', 'remove']);
  assert.equal(await copyText('', ui.document), false);
  const refused = setup({ secure: false, exec: false });
  assert.equal(await copyText('abc', refused.document), false);
  assert.equal(refused.document.body.children.length, 0);
  const field = refused.document.createElement('textarea');
  refused.events.length = 0;
  await copyText('abc', refused.document, field);
  assert.deepEqual(refused.events.map((event) => event[0]), ['select', 'exec'], 'a supplied field is selected and not removed');
});

test('the dialog copy button and the list share one clipboard implementation', () => {
  const editor = readFileSync(new URL('../public/caller-editor/editor.js', import.meta.url), 'utf8');
  assert.match(editor, /import \{ copyText \} from '\.\/clipboard\.js'/);
  assert.doesNotMatch(editor, /execCommand|navigator\.clipboard/);
  const styles = readFileSync(new URL('../public/styles.css', import.meta.url), 'utf8');
  assert.match(styles, /\.clipboard-scratch \{/);
  assert.doesNotMatch(readFileSync(new URL('../public/caller-editor/clipboard.js', import.meta.url), 'utf8'), /\.style\b|cssText/, 'no inline styles under the CSP');
});

test('the import panel stays collapsed until 导入旧密钥 is clicked: its display rule does not override [hidden]', async () => {
  const { readFile } = await import('node:fs/promises');
  const css = await readFile(new URL('../public/styles.css', import.meta.url), 'utf8');
  assert.match(css, /\.caller-key-import\[hidden\] \{ display: none; \}/);
});
