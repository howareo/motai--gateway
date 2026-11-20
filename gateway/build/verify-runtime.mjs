import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {readFile,writeFile,rename} from 'node:fs/promises';

const management='synthetic-management-key-20261027';
const token='sk-motaicandidatelabsynthetictoken';
const passed=[];
const internal=async(path,body)=>{
 const response=await fetch(`http://core:3002/internal/v1${path}`,{method:body?'POST':'GET',headers:{authorization:`Bearer ${management}`,'content-type':'application/json'},body:body&&JSON.stringify(body),signal:AbortSignal.timeout(15000)});
 return {status:response.status,body:await response.json()};
};
const waitFor=async(predicate)=>{const end=Date.now()+10000;while(Date.now()<end){if(await predicate())return;await new Promise(resolve=>setTimeout(resolve,50));}throw Error('runtime condition timed out');};
const post=async(id,{stream=false,session,channel}={})=>{
 const response=await fetch('http://core:3001/v1/chat/completions',{method:'POST',headers:{authorization:`Bearer ${token}`,'content-type':'application/json',...(session?{'X-Motai-Session':session}:{}),...(channel?{'X-Motai-Channel':channel}:{})},body:JSON.stringify({model:'gpt-4o-mini',stream,messages:[{role:'user',content:`LAB:${id}`}]})});
 const body=await response.text();return {status:response.status,attemptId:response.headers.get('x-motai-attempt-id'),body};
};
await waitFor(async()=>{try{return(await internal('/status')).body.ready}catch{return false}});
const before=(await internal('/status')).body;
const gen=String(BigInt(before.serving_gen)+1n);
const config=JSON.parse(await readFile(`/config/gen-${before.serving_gen}.config.json`,'utf8'));
const creds=JSON.parse(await readFile(`/config/gen-${before.serving_gen}.credentials.json`,'utf8'));
config.gen=creds.gen=gen;
const primary=config.channels.find(row=>row.id==='channel-openai');
if(!config.channels.some(row=>row.id==='channel-backup')){
 config.channels.push({...structuredClone(primary),id:'channel-backup',name:'Synthetic backup',priority:9,credential_ref:'backup'});
 creds.entries.push({credential_ref:'backup',credential_version:'1',secret:'synthetic-upstream-backup'});
 config.callers[0].permissions[0].channel_ids.push('channel-backup');
}
const file=async(name,value)=>{const data=`${JSON.stringify(value)}\n`;await writeFile(`/config/${name}`,data,{mode:0o600});return{file:name,sha256:createHash('sha256').update(data).digest('hex')}};
const manifest={format_version:1,gen,base_gen:before.serving_gen,config:await file(`gen-${gen}.config.json`,config),credentials:await file(`gen-${gen}.credentials.json`,creds)};
const reference=await file(`gen-${gen}.manifest.json`,manifest);
await file('desired.next.json',{format_version:1,gen,manifest:reference});await rename('/config/desired.next.json','/config/desired.json');
assert.equal((await internal('/activate',{format_version:1,gen,base_committed_gen:before.serving_gen,manifest_sha256:reference.sha256})).status,200);
assert.equal((await fetch('http://fixture:9000/__lab/reset',{method:'POST'})).status,200);
let seq=before.latest_seq;
const flush=async()=>{await waitFor(async()=>{const status=(await internal('/status')).body;return status.in_flight===0&&status.completion_pending===0});};
for(const session of [undefined,`session-${randomUUID()}`]){
 assert.equal((await internal('/pools/pool/affinity-reset',{format_version:1,operation_id:randomUUID()})).status,200);
 const prefix=session?'session':'caller';
 for(const suffix of ['one','two','three']){const response=await post(`chat-timeout-${prefix}-${suffix}`,{session});assert.equal(response.status,524);await flush();}
 const fourth=await post(`chat-timeout-${prefix}-four`,{session});assert.equal(fourth.status,200);await flush();
 const rows=(await(await fetch('http://fixture:9000/__lab/state')).json()).requests.filter(row=>row.caseId.startsWith(`chat-timeout-${prefix}-`));
 assert.equal(rows.length,4);assert.deepEqual(rows.map(row=>row.upstreamRole),['primary','primary','primary','backup']);
 const explicit=await post(`chat-timeout-${prefix}-explicit`,{session,channel:'channel-openai'});assert.equal(explicit.status,503);
 passed.push(`${prefix}-three-failures-fourth-new-request-backup-single-dispatch`);
}
const page=await internal(`/events?after_seq=${seq}&limit=1`);assert.equal(page.status,200);assert.equal(page.body.events.length,1);assert.equal(page.body.has_more,true);
const next=await internal(`/events?after_seq=${page.body.next_seq}&limit=1000`);assert.equal(next.status,200);const events=[...page.body.events,...next.body.events];
assert(events.every(event=>event.attempt.terminal.usage.format_version===1));
assert(!JSON.stringify(events).includes('synthetic-upstream-key'));assert(!JSON.stringify(events).includes('LAB:'));assert(!JSON.stringify(events).includes('session-'));
passed.push('commit-ordered-events-pagination-and-privacy');
const query=new URLSearchParams({from:'2026-01-01T00:00:00Z',to:'2027-01-01T00:00:00Z',limit:'1',outcomes:'',stream:'false'});
let attempts=await internal(`/attempts?${query}`);assert.equal(attempts.status,200);assert.equal(attempts.body.attempts.length,1);assert(attempts.body.attempts.every(row=>!row.intent.stream));
query.set('snapshot_seq',attempts.body.snapshot_seq);query.set('cursor',attempts.body.next_cursor);
const second=await internal(`/attempts?${query}`);assert.equal(second.status,200);assert.notEqual(second.body.attempts[0].intent.attempt_id,attempts.body.attempts[0].intent.attempt_id);
query.set('stream','true');assert.equal((await internal(`/attempts?${query}`)).status,400);
passed.push('attempts-snapshot-cursor-bound-to-stream-filter');
const stats=await internal('/stats?'+new URLSearchParams({from:'2026-01-01T00:00:00Z',to:'2027-01-01T00:00:00Z',outcomes:''}));assert.equal(stats.status,200);assert(stats.body.counts.attempts>=8);assert.equal(stats.body.counts.attempts,stats.body.coverage.attempts);
passed.push('sql-stats-same-snapshot-coverage');
const models=await internal('/channels/channel-openai/models',{format_version:1});assert.equal(models.status,200);assert(models.body.models.length>=2);
const preview=await internal('/models/preview',{format_version:1,base_url:'http://fixture:9000',channel_id:'channel-openai',credential:null,capabilities:['chat_completions']});assert.equal(preview.status,200);
for(const type of ['billing','wallet']){const probe=await internal(`/channels/channel-openai/${type}-probe`,{format_version:1});assert.equal(probe.status,200);assert(['unknown','unsupported'].includes(probe.body.state));}
passed.push('models-preview-and-explicit-unknown-probes');
const probeRequest={format_version:1,source:'manual',channel_id:'channel-openai',model_id:'gpt-4o-mini',protocol:'chat_completions',client_run_id:randomUUID()};
const probe=await internal('/probes',probeRequest);assert.equal(probe.status,200);assert.equal(probe.body.state,'accepted');
assert.equal((await internal('/probes',probeRequest)).body.attempt_id,probe.body.attempt_id);
await waitFor(async()=>{const page=await internal('/events?after_seq=0&limit=1000');return page.body.events.some(event=>event.attempt.intent.attempt_id===probe.body.attempt_id&&event.attempt.intent.kind==='probe'&&event.attempt.terminal.attempt_outcome==='succeeded')});
passed.push('probe-idempotent-existing-relay-kind-probe-terminal');
const drain=await internal('/drain',{format_version:1,operation_id:randomUUID()});assert.equal(drain.status,200);assert.equal(drain.body.accepting,false);
assert.equal((await post('chat-drained',{session:'drain'})).status,503);
assert((await internal('/status')).body.degraded_reasons.includes('draining'));
const resume=await internal('/resume',{format_version:1,operation_id:randomUUID()});assert.equal(resume.status,200);assert.equal(resume.body.accepting,true);
passed.push('drain-zero-dispatch-resume');
console.log(JSON.stringify({passed,count:passed.length,latestSeq:(await internal('/status')).body.latest_seq,synthetic:true},null,2));
