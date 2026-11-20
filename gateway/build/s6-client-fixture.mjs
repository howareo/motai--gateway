import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';

export const CLIENT_MODELS = ['motai-s6-codex', 'motai-s6-claude', 'motai-s6-grok'];
export const PURE_TOOL_PROMPT = 'MOTAI_S6_PURE_TOOL', PURE_TOOL_RESULT = 'MOTAI_S6_TOOL_RESULT';
const CONTENT = 'MOTAI_S6_FILE_CONTENT', FINAL = 'MOTAI_S6_CLIENT_OK';
const usage = { input_tokens: 20, output_tokens: 10, total_tokens: 30,
  input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } };

function pickReadTool(body, file) {
  const tools = body.tools || [];
  for (const preferred of ['Read', 'read_file', 'exec_command', 'shell_command', 'run_terminal_cmd', 'shell']) {
    const row = tools.find((item) => (item.function?.name || item.name) === preferred);
    if (!row) continue;
    const tool = row.function || row;
    const schema = tool.parameters || tool.input_schema || {};
    const properties = schema.properties || {};
    let args;
    if (preferred === 'Read' || preferred === 'read_file') {
      const key = ['file_path', 'target_file', 'path'].find((name) => properties[name]);
      if (!key) continue;
      args = { [key]: file };
    } else {
      const key = ['cmd', 'command'].find((name) => properties[name]);
      if (!key) continue;
      const command = `Get-Content -LiteralPath '${file.replaceAll("'", "''")}'`;
      args = { [key]: properties[key].type === 'array' ? ['powershell.exe', '-NoProfile', '-Command', command] : command };
    }
    const safe = { offset: 0, limit: 10, start_line: 1, end_line: 10, should_read_entire_file: true,
      is_background: false, timeout: 10000, timeout_ms: 10000, yield_time_ms: 1000, max_output_tokens: 1000,
      explanation: 'Read the synthetic acceptance marker' };
    for (const key of schema.required || []) {
      if (!(key in args) && key in safe) args[key] = safe[key];
    }
    if ((schema.required || []).some((key) => !(key in args))) continue;
    return { name: tool.name, args };
  }
  throw new Error('No supported safe read tool offered');
}

function toolResults(body, protocol) {
  if (protocol === 'responses') return (Array.isArray(body.input) ? body.input : [])
    .filter((row) => row.type === 'function_call_output').map((row) => ({ callId: row.call_id, output: row.output }));
  return (body.messages || []).flatMap((message) => protocol === 'chat' && message.role === 'tool'
    ? [{ callId: message.tool_call_id, output: message.content }]
    : Array.isArray(message.content) ? message.content.filter((row) => row.type === 'tool_result')
      .map((row) => ({ callId: row.tool_use_id, output: row.is_error ? null : row.content })) : []);
}

function pickPureTool(body) {
  const row = (body.tools || []).find((item) => (item.function?.name || item.name) === 'exec_command');
  const tool = row?.function || row;
  const schema = tool?.parameters || {};
  if (schema.properties?.cmd?.type !== 'string') throw new Error('No supported pure output tool offered');
  const args = { cmd: `Write-Output '${PURE_TOOL_RESULT}'` };
  const safe = { yield_time_ms: 1000, max_output_tokens: 1000, timeout_ms: 10000 };
  for (const key of schema.required || []) {
    if (!(key in args) && key in safe) args[key] = safe[key];
  }
  if ((schema.required || []).some((key) => !(key in args))) throw new Error('Unsupported pure output tool schema');
  return { name: tool.name, args };
}

function isMarkerToolOutput(output, marker) {
  // Denied commands echo their marker in the error: that is not an executed tool result.
  const text = typeof output === 'string' ? output : Array.isArray(output)
    ? output.filter((item) => item.type === 'text').map((item) => item.text).join('\n') : '';
  return !/blocked by policy|rejected|CreateProcess|\bfailed\b|\berror\b|\bexception\b|Process exited with code -?[1-9]\d*/i.test(text)
    && text.split(/\r?\n/).some((line) => line.trim() === marker);
}

export function createClientFixture() {
  const observations = [];
  const pendingCalls = new Map();
  let serial = 0;
  return createServer(async (req, res) => {
    const json = (status, body) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
    if (req.method === 'GET' && req.url === '/__client/state') return json(200, { observations });
    if (req.method === 'GET' && req.url === '/v1/models') return json(200, { object: 'list', data: CLIENT_MODELS.map((id) => ({ id, object: 'model', owned_by: 'motai-synthetic' })) });
    const protocol = { '/v1/responses': 'responses', '/v1/messages': 'messages', '/v1/chat/completions': 'chat' }[req.url];
    if (req.method !== 'POST' || !protocol) return json(404, { error: { message: 'Unknown synthetic route' } });
    try {
      let raw = '';
      for await (const chunk of req) { raw += chunk; if (Buffer.byteLength(raw) > 2 << 20) return json(413, { error: { message: 'Synthetic request limit' } }); }
      const body = JSON.parse(raw);
      if (!CLIENT_MODELS.includes(body.model)) return json(400, { error: { message: 'Synthetic model required' } });
      const outputs = toolResults(body, protocol);
      const matchingCall = outputs.find((item) => {
        const pending = pendingCalls.get(item.callId);
        return pending?.model === body.model && pending.protocol === protocol
          && isMarkerToolOutput(item.output, pending.pureMode ? PURE_TOOL_RESULT : CONTENT);
      });
      const pureMode = protocol === 'responses' && (JSON.stringify(body.input ?? '').includes(PURE_TOOL_PROMPT)
        || outputs.some((item) => pendingCalls.get(item.callId)?.pureMode));
      const continued = outputs.length > 0, markerFound = Boolean(matchingCall);
      let tool = null;
      if (pureMode && !continued) {
        tool = pickPureTool(body);
      } else if (!continued) {
        const encoded = raw.match(/MOTAI_S6_FILE_B64:([A-Za-z0-9_-]+)/)?.[1];
        const file = encoded ? Buffer.from(encoded, 'base64url').toString('utf8') : '';
        if (!/^[A-Za-z]:\\[^\r\n]*[\\/]marker\.txt$/.test(file)) return json(400, { error: { message: 'Synthetic marker path required' } });
        tool = pickReadTool(body, file);
      } else if (!markerFound) return json(422, { error: { message: 'Real marker tool result missing' } });
      if (matchingCall) pendingCalls.delete(matchingCall.callId);
      const row = { client: body.model, protocol, step: continued ? 'final' : 'tool',
        toolMode: pureMode ? 'pure-output' : 'file-read',
        toolName: tool?.name ?? null, toolResultSeen: continued, markerFound, stream: body.stream === true, finished: false, closed: false };
      observations.push(row);
      res.on('finish', () => { row.finished = true; }); res.on('close', () => { row.closed = true; });
      const id = `s6_client_${++serial}`, callId = `call_${id}`;
      if (tool) pendingCalls.set(callId, { model: body.model, protocol, pureMode });
      const emit = (name, value) => res.write(`${protocol === 'chat' ? '' : `event: ${name}\n`}data: ${JSON.stringify(value)}\n\n`);
      if (body.stream) res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      if (protocol === 'responses') {
        const item = tool ? { type: 'function_call', id: `fc_${id}`, call_id: callId, name: tool.name, arguments: JSON.stringify(tool.args), status: 'completed' }
          : { type: 'message', id: `msg_${id}`, role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: FINAL, annotations: [], logprobs: [] }] };
        const response = { id: `resp_${id}`, object: 'response', created_at: 1793070000, model: body.model, status: 'completed', output: [item], usage };
        if (!body.stream) return json(200, response);
        let sequence = 0;
        const event = (type, value) => emit(type, { type, sequence_number: sequence++, ...value });
        event('response.created', { response: { ...response, status: 'in_progress', output: [], usage: null } });
        event('response.output_item.added', { output_index: 0, item: tool ? { ...item, status: 'in_progress', arguments: '' } : { ...item, status: 'in_progress', content: [] } });
        if (tool) {
          event('response.function_call_arguments.delta', { item_id: item.id, output_index: 0, delta: item.arguments });
          event('response.function_call_arguments.done', { item_id: item.id, output_index: 0, arguments: item.arguments });
        } else {
          event('response.content_part.added', { item_id: item.id, output_index: 0, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } });
          event('response.output_text.delta', { item_id: item.id, output_index: 0, content_index: 0, delta: FINAL });
          event('response.output_text.done', { item_id: item.id, output_index: 0, content_index: 0, text: FINAL });
          event('response.content_part.done', { item_id: item.id, output_index: 0, content_index: 0, part: item.content[0] });
        }
        event('response.output_item.done', { output_index: 0, item });
        event('response.completed', { response });
      } else if (protocol === 'messages') {
        const block = tool ? { type: 'tool_use', id: callId, name: tool.name, input: tool.args } : { type: 'text', text: FINAL };
        const message = { id: `msg_${id}`, type: 'message', role: 'assistant', model: body.model, content: [block],
          stop_reason: tool ? 'tool_use' : 'end_turn', stop_sequence: null, usage: { input_tokens: 20, output_tokens: 10 } };
        if (!body.stream) return json(200, message);
        emit('message_start', { type: 'message_start', message: { ...message, content: [], stop_reason: null, usage: { input_tokens: 20, output_tokens: 0 } } });
        emit('content_block_start', { type: 'content_block_start', index: 0, content_block: tool ? { ...block, input: {} } : { type: 'text', text: '' } });
        emit('content_block_delta', { type: 'content_block_delta', index: 0, delta: tool ? { type: 'input_json_delta', partial_json: JSON.stringify(tool.args) } : { type: 'text_delta', text: FINAL } });
        emit('content_block_stop', { type: 'content_block_stop', index: 0 });
        emit('message_delta', { type: 'message_delta', delta: { stop_reason: message.stop_reason, stop_sequence: null }, usage: { output_tokens: 10 } });
        emit('message_stop', { type: 'message_stop' });
      } else {
        const call = tool && { id: callId, type: 'function', function: { name: tool.name, arguments: JSON.stringify(tool.args) } };
        const message = tool ? { role: 'assistant', content: null, tool_calls: [call] } : { role: 'assistant', content: FINAL };
        const base = { id: `chatcmpl_${id}`, created: 1793070000, model: body.model };
        const chatUsage = { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 };
        if (!body.stream) return json(200, { ...base, object: 'chat.completion', choices: [{ index: 0, message, finish_reason: tool ? 'tool_calls' : 'stop' }], usage: chatUsage });
        const chunk = (delta, finish_reason = null) => emit('', { ...base, object: 'chat.completion.chunk', choices: [{ index: 0, delta, finish_reason }] });
        chunk(tool ? { role: 'assistant', tool_calls: [{ index: 0, ...call }] } : { role: 'assistant', content: FINAL });
        chunk({}, tool ? 'tool_calls' : 'stop');
        emit('', { ...base, object: 'chat.completion.chunk', choices: [], usage: chatUsage });
        res.write('data: [DONE]\n\n');
      }
      res.end();
    } catch { json(422, { error: { message: 'Synthetic client fixture rejected request' } }); }
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  createClientFixture().listen(Number(process.env.PORT || 9001), process.env.HOST || '0.0.0.0');
}
