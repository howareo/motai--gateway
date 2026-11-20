import { createServer } from 'node:http';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export const OPENAI_MODEL = 'gpt-4o-mini';
export const CLAUDE_MODEL = 'claude-3-5-sonnet-20240620';
export const GEMINI_MODEL = 'gemini-lab';
export const TOOL = { name: 'lab_weather', description: 'Synthetic weather fixture', parameters: {
  type: 'object', properties: { city: { type: 'string' } }, required: ['city'], additionalProperties: false,
} };
export const SIGNATURE = 'motai-lab-synthetic-thinking-signature';
export const CACHE_KEY = 'motai-lab-synthetic-cache';
export const BACKUP_UPSTREAM_KEY = 'synthetic-upstream-backup';

const argumentsText = '{"city":"Paris"}';
const responseUsage = { input_tokens: 10, output_tokens: 5, total_tokens: 15,
  input_tokens_details: { cached_tokens: 4 }, output_tokens_details: { reasoning_tokens: 2 } };
const messageUsage = { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 4, cache_creation_input_tokens: 2 };
const functionItem = { type: 'function_call', id: 'fc_lab', call_id: 'call_lab', name: TOOL.name,
  arguments: argumentsText, status: 'completed' };

function responseObject(body, status = 'completed') {
  return { id: 'resp_lab', object: 'response', created_at: 1760000000, model: body.model, status,
    output: status === 'completed' ? [functionItem] : [], usage: status === 'completed' ? responseUsage : null };
}

function messageObject(body) {
  return { id: 'msg_lab', type: 'message', role: 'assistant', model: body.model,
    content: [{ type: 'thinking', thinking: 'Synthetic reasoning.', signature: SIGNATURE },
      { type: 'tool_use', id: 'toolu_lab', name: TOOL.name, input: { city: 'Paris' } }],
    stop_reason: 'tool_use', stop_sequence: null, usage: messageUsage };
}

export function createFixtureServer() {
  const requests = [];
  const held = new Map();
  const server = createServer(async (req, res) => {
    const json = (status, body) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
    const url = new URL(req.url, 'http://fixture:9000');
    if (req.url === '/__lab/state' && req.method === 'GET') return json(200, { requests });
    if (url.pathname === '/__lab/release' && req.method === 'POST') {
      const release = held.get(url.searchParams.get('case'));
      if (!release) return json(404, { error: 'No held synthetic case' });
      release();
      return json(200, { ok: true });
    }
    if (req.url === '/__lab/reset' && req.method === 'POST') {
      if (requests.some((row) => !row.finished && !row.closed)) return json(409, { error: 'Requests still active' });
      requests.length = 0;
      return json(200, { ok: true });
    }
    if (req.url === '/v1/models' && req.method === 'GET') return json(200, { object: 'list', data:
      [OPENAI_MODEL, CLAUDE_MODEL].map((id) => ({ id, object: 'model', owned_by: 'motai-lab' })) });
    const gemini = url.pathname.match(/^\/v1beta\/models\/([^/:]+):(generateContent|streamGenerateContent)$/);
    if ((!['/v1/responses', '/v1/chat/completions', '/v1/messages'].includes(req.url) && !gemini) || req.method !== 'POST') {
      return json(404, { error: 'Unknown lab route' });
    }
    let raw = '';
    try {
      for await (const chunk of req) {
        raw += chunk;
        if (raw.length > 65536) return json(413, { error: 'Synthetic request too large' });
      }
      const body = JSON.parse(raw);
      const caseId = raw.match(/LAB:([a-z-]+)/)?.[1];
      const model = gemini ? gemini[1] : body.model;
      if (!caseId || ![OPENAI_MODEL, CLAUDE_MODEL, GEMINI_MODEL].includes(model)) return json(400, { error: 'Synthetic cases only' });
      const row = { caseId, path: req.url, model, stream: gemini ? gemini[2] === 'streamGenerateContent' || url.searchParams.get('alt') === 'sse' : body.stream === true,
        upstreamRole: req.headers.authorization === `Bearer ${BACKUP_UPSTREAM_KEY}` ? 'backup' : 'primary',
        tools: body.tools, reasoning: body.reasoning, prompt_cache_key: body.prompt_cache_key,
        thinking: body.thinking, messages: body.messages, body, finished: false, closed: false };
      requests.push(row);
      res.on('finish', () => { row.finished = true; });
      let timer;
      res.on('close', () => { row.closed = true; clearInterval(timer); held.delete(caseId); });
      if (gemini) {
        const result = { candidates: [{ content: { role: 'model', parts: [{ text: 'Synthetic Gemini result.' }] }, finishReason: 'STOP', index: 0 }],
          usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5, totalTokenCount: 15 }, modelVersion: GEMINI_MODEL };
        if (!row.stream) return json(200, result);
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
        res.end(`data: ${JSON.stringify(result)}\n\n`);
        return;
      }
      if (caseId === 'chat-drain-held') {
        held.set(caseId, () => {
          held.delete(caseId);
          json(200, { id: 'chatcmpl_drain', object: 'chat.completion', created: 1760000000, model,
            choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: 'Synthetic drain completed.' } }],
            usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } });
        });
        return;
      }
      if (req.url === '/v1/chat/completions' && caseId.startsWith('chat-timeout-') && row.upstreamRole === 'primary') {
        return json(524, { error: { type: 'upstream_timeout', message: 'Synthetic upstream timeout' } });
      }
      if (req.url === '/v1/chat/completions' && caseId.startsWith('chat-gateway-timeout-') && row.upstreamRole === 'primary') {
        return json(504, { error: { type: 'upstream_timeout', message: 'Synthetic gateway timeout' } });
      }
      for (const [prefix, status] of [['chat-bad-gateway-', 502], ['chat-unavailable-', 503], ['chat-rate-limit-', 429]]) {
        if (req.url === '/v1/chat/completions' && caseId.startsWith(prefix) && row.upstreamRole === 'primary') {
          return json(status, { error: { type: 'synthetic_upstream_failure', message: 'Synthetic upstream failure' } });
        }
      }
      if (!body.stream) {
        if (req.url === '/v1/responses') return json(200, responseObject(body));
        if (req.url === '/v1/messages') return json(200, messageObject(body));
        return json(200, { id: 'chatcmpl_lab', object: 'chat.completion', created: 1760000000, model: body.model,
          choices: [{ index: 0, finish_reason: 'tool_calls', message: { role: 'assistant', content: null,
            tool_calls: [{ id: 'call_lab', type: 'function', function: { name: TOOL.name, arguments: argumentsText } }] } }],
          usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15, prompt_tokens_details: { cached_tokens: 4 } } });
      }
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      const event = (name, data) => res.write(`${name ? `event: ${name}\n` : ''}data: ${JSON.stringify(data)}\n\n`);
      if (req.url === '/v1/responses') {
        let sequence = 0;
        const emit = (name, data) => event(name, { type: name, sequence_number: sequence++, ...data });
        emit('response.created', { response: responseObject(body, 'in_progress') });
        emit('response.output_item.added', { output_index: 0, item: { ...functionItem, arguments: '', status: 'in_progress' } });
        emit('response.function_call_arguments.delta', { output_index: 0, item_id: 'fc_lab', delta: argumentsText });
        if (caseId === 'responses-disconnect') {
          timer = setTimeout(() => res.destroy(), 150);
          return;
        }
        if (caseId === 'responses-cancel') {
          timer = setInterval(() => res.write(': lab keepalive\n\n'), 100);
          return;
        }
        emit('response.function_call_arguments.done', { output_index: 0, item_id: 'fc_lab', arguments: argumentsText });
        emit('response.output_item.done', { output_index: 0, item: functionItem });
        emit('response.completed', { response: responseObject(body) });
      } else if (req.url === '/v1/messages') {
        event('message_start', { type: 'message_start', message: { ...messageObject(body), content: [],
          stop_reason: null, usage: { ...messageUsage, output_tokens: 0 } } });
        event('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } });
        event('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'Synthetic reasoning.' } });
        event('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: SIGNATURE } });
        event('content_block_stop', { type: 'content_block_stop', index: 0 });
        event('content_block_start', { type: 'content_block_start', index: 1,
          content_block: { type: 'tool_use', id: 'toolu_lab', name: TOOL.name, input: {} } });
        event('content_block_delta', { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: argumentsText } });
        event('content_block_stop', { type: 'content_block_stop', index: 1 });
        event('message_delta', { type: 'message_delta', delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { output_tokens: 5 } });
        event('message_stop', { type: 'message_stop' });
      } else {
        const chunk = (choices, usage) => event('', { id: 'chatcmpl_lab', object: 'chat.completion.chunk',
          created: 1760000000, model: body.model, choices, ...(usage ? { usage } : {}) });
        chunk([{ index: 0, delta: { role: 'assistant', tool_calls: [{ index: 0, id: 'call_lab', type: 'function',
          function: { name: TOOL.name, arguments: '{"city":' } }] }, finish_reason: null }]);
        chunk([{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '"Paris"}' } }] }, finish_reason: null }]);
        chunk([{ index: 0, delta: {}, finish_reason: 'tool_calls' }]);
        chunk([], { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15, prompt_tokens_details: { cached_tokens: 4 } });
        res.write('data: [DONE]\n\n');
      }
      res.end();
    } catch {
      if (!res.headersSent) json(400, { error: 'Invalid synthetic JSON request' });
      else res.destroy();
    }
  });
  return server;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  createFixtureServer().listen(9000, '0.0.0.0', () => console.log('Synthetic upstream listening on :9000'));
}
