import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const app = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
const source = app.slice(app.indexOf('async function resetGatewayHealth('), app.indexOf('async function loadGatewayConfiguration('));

function setup(responses) {
  const payloads = [], messages = [];
  let confirms = 0, refreshes = 0;
  const state = { gatewayMutation: false, gatewayConfig: { gen: '9' }, gatewayHealthStale: false, gatewayHealthPending: new Map() };
  const context = vm.createContext({ state, window: { confirm: () => { confirms++; return true; } },
    createEditorDraft: () => ({ operationId: 'stable-operation' }),
    api: async (_, options) => { payloads.push(JSON.parse(options.body)); const response = responses.shift(); if (response) throw response; },
    showToast: (text) => messages.push(text), refreshGatewayHealth: async () => { refreshes++; } });
  vm.runInContext(source, context);
  const channel = { id: '0001', name: '渠道', poolId: 'primary', poolIds: ['primary', 'second'], runtimeHealthByPool: [
    { poolId: 'primary', state: 'available', credentialVersion: '4', stateVersion: '1' },
    { poolId: 'second', state: 'exhausted', credentialVersion: '4', stateVersion: '7' }] };
  const button = { disabled: false, isConnected: true };
  return { state, payloads, messages, button, channel, reset: (poolId = 'second') => context.resetGatewayHealth(channel, button, poolId),
    confirms: () => confirms, refreshes: () => refreshes };
}

test('health UI preserves the same operation after 5xx and permits checking it while state is stale', async () => {
  const ui = setup([Object.assign(new Error('upstream'), { status: 503 }), null]);
  await ui.reset();
  assert.equal(ui.state.gatewayHealthPending.has(JSON.stringify(['0001', 'second'])), true);
  assert.equal(ui.payloads[0].poolId, 'second');
  assert.equal(ui.payloads[0].stateVersion, '7');
  assert.equal(ui.state.gatewayMutation, false); assert.equal(ui.button.disabled, false);
  ui.state.gatewayHealthStale = true;
  ui.channel.runtimeHealthByPool = [];
  await ui.reset();
  assert.deepEqual(ui.payloads[1], ui.payloads[0]);
  assert.equal(ui.confirms(), 1); assert.equal(ui.refreshes(), 2);
  assert.equal(ui.state.gatewayHealthPending.has(JSON.stringify(['0001', 'second'])), false);
});

test('health recovery rejects missing/unknown pools and keeps separate pending operations for two memberships', async () => {
  const ui = setup([Object.assign(new Error('unknown second'), { status: 503 }), Object.assign(new Error('unknown primary'), { status: 503 })]);
  await ui.reset(''); await ui.reset('outside');
  assert.equal(ui.payloads.length, 0);
  await ui.reset('second'); await ui.reset('primary');
  assert.equal(ui.state.gatewayHealthPending.size, 2);
  assert.deepEqual(ui.payloads.map((item) => [item.poolId, item.stateVersion]), [['second', '7'], ['primary', '1']]);
});

test('health UI clears a rejected stale operation and requires fresh status before a new recovery', async () => {
  const ui = setup([Object.assign(new Error('stale'), { status: 409 })]);
  await ui.reset();
  assert.equal(ui.state.gatewayHealthPending.size, 0);
  assert.match(ui.messages.at(-1), /状态已变化/);
  ui.state.gatewayHealthStale = true;
  await ui.reset();
  assert.equal(ui.payloads.length, 1);
  ui.state.gatewayHealthStale = false; ui.state.gatewayMutation = true;
  await ui.reset();
  assert.equal(ui.payloads.length, 1);
});
