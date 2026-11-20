import test from 'node:test';
import assert from 'node:assert/strict';
import { createClientFixture, CLIENT_MODELS, PURE_TOOL_PROMPT, PURE_TOOL_RESULT } from '../gateway/build/s6-client-fixture.mjs';

test('synthetic CLI fixture uses offered safe tools and requires real marker result before final response', async (t) => {
  const server = createClientFixture();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve)); t.after(() => new Promise((resolve) => server.close(resolve)));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const prompt = `MOTAI_S6_FILE_B64:${Buffer.from('C:\\Temp\\motai\\marker.txt').toString('base64url')}`;
  const cases = [
    { protocol: 'responses', path: '/v1/responses', model: CLIENT_MODELS[0],
      tool: { type: 'function', name: 'exec_command', parameters: { type: 'object', properties: { cmd: { type: 'string' } }, required: ['cmd'] } },
      input: { input: prompt }, continued: (callId, output) => ({ input: [{ type: 'function_call_output', call_id: callId, output }] }), expected: 'exec_command' },
    { protocol: 'messages', path: '/v1/messages', model: CLIENT_MODELS[1],
      tool: { name: 'Read', input_schema: { type: 'object', properties: { file_path: { type: 'string' } }, required: ['file_path'] } },
      input: { messages: [{ role: 'user', content: prompt }] }, continued: (callId, output) => ({ messages: [{ role: 'user', content: [{ type: 'tool_result', tool_use_id: callId, content: output }] }] }), expected: 'Read' },
    { protocol: 'chat', path: '/v1/chat/completions', model: CLIENT_MODELS[2],
      tool: { type: 'function', function: { name: 'read_file', parameters: { type: 'object', properties: { target_file: { type: 'string' }, should_read_entire_file: { type: 'boolean' } }, required: ['target_file', 'should_read_entire_file'] } } },
      input: { messages: [{ role: 'user', content: prompt }] }, continued: (callId, output) => ({ messages: [{ role: 'tool', tool_call_id: callId, content: output }] }), expected: 'read_file' },
  ];
  for (const sample of cases) {
    const post = (body) => fetch(`${origin}${sample.path}`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer SYNTHETIC_SECRET' }, body: JSON.stringify({ model: sample.model, stream: true, tools: [sample.tool], ...body }) });
    const first = await post(sample.input); assert.equal(first.status, 200);
    const body = await first.text(); assert(body.includes(sample.expected)); assert(body.includes('marker.txt'));
    const events = body.split('\n').filter((line) => line.startsWith('data: ') && !line.includes('[DONE]')).map((line) => JSON.parse(line.slice(6)));
    const callId = sample.protocol === 'responses' ? events.find((item) => item.type === 'response.output_item.done').item.call_id
      : sample.protocol === 'messages' ? events.find((item) => item.type === 'content_block_start').content_block.id
        : events.flatMap((item) => item.choices || []).flatMap((item) => item.delta?.tool_calls || [])[0].id;
    for (const output of ["Get-Content 'MOTAI_S6_FILE_CONTENT' rejected: blocked by policy", 'rejected: blocked by policy\nMOTAI_S6_FILE_CONTENT', 'Error: synthetic tool failure\nMOTAI_S6_FILE_CONTENT']) {
      const rejected = await post(sample.continued(callId, output));
      assert.equal(rejected.status, 422); await rejected.text();
    }
    const mismatched = await post(sample.continued('wrong-call', 'MOTAI_S6_FILE_CONTENT'));
    assert.equal(mismatched.status, 422); await mismatched.text();
    const final = await post(sample.continued(callId, 'MOTAI_S6_FILE_CONTENT'));
    assert.equal(final.status, 200); assert((await final.text()).includes('MOTAI_S6_CLIENT_OK'));
  }
  const state = await (await fetch(`${origin}/__client/state`)).json();
  assert.equal(state.observations.length, 6);
  assert.equal(state.observations.filter((row) => row.step === 'final' && row.markerFound).length, 3);
  assert.doesNotMatch(JSON.stringify(state), /SYNTHETIC_SECRET|marker.txt|FILE_B64|Temp/);
});

test('pure output Responses fixture verifies a matching two-turn tool result without a file operation', async (t) => {
  const server = createClientFixture();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const tools = [{ type: 'function', name: 'exec_command', parameters: { type: 'object',
    properties: { cmd: { type: 'string' }, yield_time_ms: { type: 'integer' } }, required: ['cmd', 'yield_time_ms'] } }];
  const events = (text) => text.split('\n').filter((line) => line.startsWith('data: ')).map((line) => JSON.parse(line.slice(6)));
  const post = (input, stream, offeredTools = tools) => fetch(`${origin}/v1/responses`, { method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer SYNTHETIC_PURE_SECRET' },
    body: JSON.stringify({ model: CLIENT_MODELS[0], tools: offeredTools, stream, input }) });
  for (const stream of [false, true]) {
    const first = await post(`${PURE_TOOL_PROMPT} ${PURE_TOOL_RESULT}`, stream);
    assert.equal(first.status, 200);
    const firstText = await first.text();
    const response = stream ? events(firstText).find((item) => item.type === 'response.completed').response : JSON.parse(firstText);
    const call = response.output[0];
    assert.equal(call.type, 'function_call');
    assert.equal(call.name, 'exec_command');
    assert.deepEqual(JSON.parse(call.arguments), { cmd: `Write-Output '${PURE_TOOL_RESULT}'`, yield_time_ms: 1000 });
    assert.doesNotMatch(firstText, /Get-Content|marker\.txt|FILE_B64|powershell\.exe/);
    for (const input of [
      [{ role: 'user', content: PURE_TOOL_PROMPT }, { type: 'function_call_output', call_id: 'wrong', output: PURE_TOOL_RESULT }],
      [{ type: 'function_call_output', call_id: call.call_id, output: 'rejected: blocked by policy' }],
      [{ type: 'function_call_output', call_id: call.call_id,
        output: `exec_command failed: CreateProcess { message: "Write-Output '${PURE_TOOL_RESULT}' rejected: blocked by policy" }` }],
      [{ type: 'function_call_output', call_id: call.call_id, output: `Write-Output '${PURE_TOOL_RESULT}'` }],
      [{ type: 'function_call_output', call_id: call.call_id, output: `rejected: blocked by policy\n${PURE_TOOL_RESULT}` }],
      [{ type: 'function_call_output', call_id: call.call_id, output: `Process exited with code 1\n${PURE_TOOL_RESULT}` }],
    ]) {
      const rejected = await post(input, stream);
      assert.equal(rejected.status, 422);
      await rejected.text();
    }
    // This is a protocol regression: the output is simulated here, not a real CLI tool execution.
    const final = await post([{ type: 'function_call_output', call_id: call.call_id,
      output: `Process exited with code 0\nFinal output:\n${PURE_TOOL_RESULT}\n` }], stream);
    assert.equal(final.status, 200);
    const finalText = await final.text();
    const completed = stream ? events(finalText).find((item) => item.type === 'response.completed').response : JSON.parse(finalText);
    assert.equal(completed.output[0].type, 'message');
    assert.equal(completed.output[0].content[0].text, 'MOTAI_S6_CLIENT_OK');
  }
  for (const offeredTools of [[], [{ type: 'function', name: 'read_file', parameters: { type: 'object', properties: { path: { type: 'string' } } } }]]) {
    const response = await post(PURE_TOOL_PROMPT, true, offeredTools);
    assert.equal(response.status, 422);
    await response.text();
  }
  const state = await (await fetch(`${origin}/__client/state`)).json();
  assert.equal(state.observations.length, 4);
  assert.deepEqual(state.observations.map((item) => [item.step, item.markerFound]), [['tool', false], ['final', true], ['tool', false], ['final', true]]);
  assert(state.observations.every((item) => item.toolMode === 'pure-output'));
  assert.doesNotMatch(JSON.stringify(state), /Write-Output|MOTAI_S6_TOOL_RESULT|SYNTHETIC_PURE_SECRET|function_call_output/);
});
