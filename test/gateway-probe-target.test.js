import test from 'node:test';
import assert from 'node:assert/strict';
import { probeTarget, PROBE_PROTOCOL_ORDER } from '../src/gateway/probe-target.js';

const model = (modelId, ...capabilities) => ({ modelId, capabilities });
const protocolOf = (...capabilities) => probeTarget({ testModel: 'M', models: [model('M', ...capabilities)] })?.protocol ?? null;

test('the protocol follows New API: chat_completions, then messages, responses, gemini; count_tokens never', () => {
  assert.deepEqual([...PROBE_PROTOCOL_ORDER], ['chat_completions', 'messages', 'responses', 'gemini_generate_content']);
  assert.equal(protocolOf('responses'), 'responses', 'only responses');
  assert.equal(protocolOf('responses', 'chat_completions'), 'chat_completions', 'chat wins over responses');
  assert.equal(protocolOf('responses', 'messages', 'chat_completions', 'gemini_generate_content'), 'chat_completions');
  assert.equal(protocolOf('messages'), 'messages', 'only messages');
  assert.equal(protocolOf('responses', 'messages'), 'messages', 'messages wins over responses');
  assert.equal(protocolOf('gemini_generate_content'), 'gemini_generate_content', 'only gemini');
  assert.equal(protocolOf('gemini_generate_content', 'responses'), 'responses', 'responses wins over gemini');
  assert.equal(protocolOf('count_tokens'), null, 'only count_tokens');
  assert.equal(protocolOf('count_tokens', 'messages'), 'messages');
  assert.equal(protocolOf(), null);
});

test('the order of the capability list does not change the choice', () => {
  assert.equal(protocolOf('gemini_generate_content', 'responses', 'messages', 'chat_completions', 'count_tokens'), 'chat_completions');
  assert.equal(protocolOf('count_tokens', 'chat_completions'), 'chat_completions');
});

test('Claude probes prefer native messages without changing the selected model or other protocol fallbacks', () => {
  const claude = model('claude-probe', 'chat_completions', 'messages', 'responses');
  assert.deepEqual(probeTarget({ models: [claude] }), { modelId: 'claude-probe', protocol: 'messages', explicit: false });
  assert.deepEqual(probeTarget({ testModel: claude.modelId, models: [model('M', 'chat_completions'), claude] }),
    { modelId: 'claude-probe', protocol: 'messages', explicit: true });
  assert.deepEqual(probeTarget({ testModel: 'M', models: [claude, model('M', 'chat_completions', 'messages')] }),
    { modelId: 'M', protocol: 'chat_completions', explicit: true });
  assert.deepEqual(probeTarget({ models: [model('claude-chat-only', 'chat_completions')] }),
    { modelId: 'claude-chat-only', protocol: 'chat_completions', explicit: false });
  assert.equal(probeTarget({ testModel: 'claude-local-only', models: [claude, model('claude-local-only', 'count_tokens')] }), null);
});

test('an explicit test model is used with the protocol chosen by that rule', () => {
  const channel = { testModel: 'B', models: [model('A', 'responses'), model('B', 'count_tokens', 'responses', 'messages')] };
  assert.deepEqual(probeTarget(channel), { modelId: 'B', protocol: 'messages', explicit: true });
});

test('an explicit test model that nothing can call is not replaced by another model', () => {
  const channel = { testModel: 'B', models: [model('A', 'responses'), model('B', 'count_tokens')] };
  assert.equal(probeTarget(channel), null);
  assert.equal(probeTarget({ testModel: 'gone', models: [model('A', 'responses')] }), null);
});

test('an empty test model falls back to the first model with a callable protocol, skipping count_tokens-only models', () => {
  const channel = { testModel: null, models: [model('A', 'count_tokens'), model('B', 'count_tokens', 'responses', 'chat_completions'), model('C', 'responses')] };
  assert.deepEqual(probeTarget(channel), { modelId: 'B', protocol: 'chat_completions', explicit: false });
  assert.deepEqual(probeTarget({ models: [model('A', 'responses')] }), { modelId: 'A', protocol: 'responses', explicit: false });
  assert.deepEqual(probeTarget({ testModel: '', models: [model('A', 'responses')] }), { modelId: 'A', protocol: 'responses', explicit: false });
});

test('no model, or only count_tokens, means no target', () => {
  assert.equal(probeTarget({ testModel: null, models: [] }), null);
  assert.equal(probeTarget({ testModel: null, models: [model('A', 'count_tokens')] }), null);
  assert.equal(probeTarget({}), null);
  assert.equal(probeTarget(null), null);
});
