import http from 'node:http';

const requests = [];
const send = (response, status, body, headers = {}) => {
  response.writeHead(status, {'content-type':'application/json', ...headers});
  response.end(JSON.stringify(body));
};
const server = http.createServer(async (request, response) => {
  const url = new URL(request.url, 'http://s6-fixture:9000');
  if (url.pathname === '/__s6/state') return send(response, 200, {requests});
  if (url.pathname === '/__s6/reset') { requests.length = 0; return send(response, 200, {ok:true}); }
  if (url.pathname.endsWith('/v1beta/models')) {
    const page = url.searchParams.get('pageToken') || '';
    requests.push({kind:'catalog',page,googAuthorized:request.headers['x-goog-api-key'] === 'synthetic-s6-gemini',queryKeyPresent:url.searchParams.has('key')});
    if (page === 'page-2') return send(response, 200, {models:[
      {name:'models/gemini-lab',supportedGenerationMethods:['generateContent']},
      {name:'models/gemini-next',supportedGenerationMethods:['generateContent']},
    ]});
    return send(response, 200, {models:[
      {name:'models/gemini-lab',supportedGenerationMethods:['generateContent','countTokens']},
      {name:'models/embed-only',supportedGenerationMethods:['embedContent']},
    ],nextPageToken:'page-2'});
  }
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  let body;
  try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { return send(response,400,{error:{message:'fixture invalid body'}}); }
  const text = body.messages?.[0]?.content || body.input || '';
  const caseId = text.startsWith('LAB:') ? text.slice(4) : 'unmarked';
  const authorization = request.headers.authorization || '';
  const role = authorization.includes('synthetic-s6-backup') ? 'backup' : authorization.includes('synthetic-s6-lone') ? 'lone' : 'primary';
  requests.push({kind:'generation',caseId,role,path:url.pathname,stream:body.stream === true});
  if ((role === 'primary' || role === 'lone') && caseId.startsWith('rate-seconds')) return send(response,429,{error:{type:'rate_limit_error',message:'Synthetic rate limit'}},{'retry-after':'120'});
  if (role === 'primary' && caseId.startsWith('rate-date')) return send(response,429,{error:{type:'rate_limit_error',message:'Synthetic rate limit'}},{'retry-after':new Date(Date.now()+120000).toUTCString()});
  if (role === 'primary' && caseId.startsWith('rate-invalid')) return send(response,429,{error:{type:'rate_limit_error',message:'Synthetic rate limit'}},{'retry-after':'-1'});
  if (role === 'primary' && caseId.startsWith('funds')) return send(response,403,{error:{type:'provider_error',code:'synthetic_unknown',message:'账户余额已耗尽 CANARY_S6_UPSTREAM_ERROR'}});
  if (role === 'primary' && caseId.startsWith('invalid-key')) return send(response,401,{error:{type:'invalid_request_error',code:'invalid_api_key',message:'CANARY_S6_UPSTREAM_ERROR'}});
  if (role === 'primary' && caseId.startsWith('ordinary-403')) return send(response,403,{error:{type:'permission_error',message:'Model permission denied'}});
  return send(response,200,{id:'chatcmpl-s6',object:'chat.completion',created:1793084400,model:body.model,
    choices:[{index:0,message:{role:'assistant',content:'synthetic ok'},finish_reason:'stop'}],usage:{prompt_tokens:5,completion_tokens:2,total_tokens:7}});
});
server.listen(9000,'0.0.0.0');
