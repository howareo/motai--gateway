import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const app = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
const html = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');
const functionSource = (name) => {
  const source = app.slice(app.indexOf(`function ${name}(`));
  const end = source.slice(1).search(/\n(?:async )?function /);
  return end < 0 ? source : source.slice(0, end + 1);
};

test('configuration status exposes discard only for the current explicitly rejected pending candidate', () => {
  const nodes = Object.fromEntries(['status', 'status-text', 'discard'].map((name) => [`#gateway-config-${name}`, { hidden: true, textContent: '' }]));
  const state = { gatewayStatus: { desiredGen: '2', committedGen: '1', servingGen: '1',
    desiredManifestSha256: 'a'.repeat(64), discardAvailable: true } };
  const context = vm.createContext({ state, $: (id) => nodes[id] });
  vm.runInContext(functionSource('renderGatewayConfigStatus'), context);
  context.renderGatewayConfigStatus();
  assert.equal(nodes['#gateway-config-discard'].hidden, false);
  assert.match(nodes['#gateway-config-status-text'].textContent, /明确拒绝/);
  for (const status of [
    { discardAvailable: false, activationErrorCode: 'invalid_contract' },
    { discardAvailable: true, desiredManifestSha256: null },
    { discardAvailable: false, activationErrorCode: 'gateway_unavailable' },
    { discardAvailable: false, activationErrorCode: 'desired_sync_failed' },
    { desiredGen: '1', discardAvailable: true },
  ]) {
    state.gatewayStatus = { desiredGen: '2', committedGen: '1', servingGen: '1', desiredManifestSha256: 'a'.repeat(64), ...status };
    context.renderGatewayConfigStatus();
    assert.equal(nodes['#gateway-config-discard'].hidden, true);
  }
  assert.match(html, /id="gateway-config-discard"[^>]*type="button"[^>]*hidden/);
});

test('discard UI confirms token invalidation, sends exact generation/hash and clears stale editor operations', async () => {
  const start = app.indexOf("$('#gateway-config-discard').addEventListener");
  const end = app.indexOf('\nfunction openChannelDialog', start);
  const nodes = { '#gateway-config-discard': { disabled: false }, '#gateway-callers dialog[open]': { close() { callerClosed++; } } };
  let handler, confirmed = false, callerClosed = 0, channelClosed = 0, saved;
  const requests = [];
  const state = { gatewayMutation: false, gatewayStatus: { desiredGen: '2', desiredManifestSha256: 'b'.repeat(64), discardAvailable: true },
    gatewayPendingOperation: { state: 'pending' }, gatewaySession: { draft: { closed: false }, close() { channelClosed++; } } };
  nodes['#gateway-config-discard'].addEventListener = (_event, callback) => { handler = callback; };
  const context = vm.createContext({ state, $: (id) => nodes[id], window: { confirm(text) {
    assert.match(text, /令牌将作废/);
    assert.match(text, /本次渠道启停\/删除及令牌变更均撤销，旧状态保持/);
    return confirmed;
  } },
    api: async (...args) => { requests.push(args); return { desiredGen: '1', activated: true }; },
    gatewaySaved: async (result) => { saved = result; }, showToast() {}, loadGatewayConfiguration: async () => {} });
  vm.runInContext(app.slice(start, end), context);
  await handler(); assert.equal(requests.length, 0);
  confirmed = true; await handler();
  assert.deepEqual(JSON.parse(requests[0][1].body), { gen: '2', manifestSha256: 'b'.repeat(64) });
  assert.equal(requests[0][0], '/api/gateway/discard');
  assert.equal(state.gatewayPendingOperation, null); assert.equal(channelClosed, 1); assert.equal(callerClosed, 1);
  assert.equal(saved.activated, true); assert.equal(state.gatewayMutation, false); assert.equal(nodes['#gateway-config-discard'].disabled, false);
});
