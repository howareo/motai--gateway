import assert from 'node:assert/strict';
import {createHash,createHmac,randomUUID} from 'node:crypto';
import {readFile,writeFile,rename} from 'node:fs/promises';

const core = process.env.MOTAI_S6_CORE_URL || 'http://s6-core:3002/internal/v1';
const relay = process.env.MOTAI_S6_RELAY_URL || 'http://s6-core:3001';
const fixture = 'http://s6-fixture:9000';
const management = 'synthetic-s6-management-key-20261027';
const hmac = 'synthetic-s6-hmac-key-20261027-lab-only';
const token = 'sk-motais6syntheticcaller';
const passed = [];
const internal = async (path,body,auth=management) => {
  const response=await fetch(core+path,{method:body?'POST':'GET',headers:{authorization:`Bearer ${auth}`,'content-type':'application/json'},body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(15000)});
  return {status:response.status,body:await response.json()};
};
const file = async(name,value)=>{const data=JSON.stringify(value)+'\n';await writeFile('/config/'+name,data,{mode:0o600});return {file:name,sha256:createHash('sha256').update(data).digest('hex')};};
const models=['general','rate-seconds-model','rate-date-model','rate-invalid-model'];
let config={format_version:1,gen:'1',pools:[{id:'pool',name:'S6 synthetic'},{id:'lone-pool',name:'S6 no backup'},{id:'gemini-pool',name:'S6 Gemini'},{id:'client-pool',name:'S6 real clients'}],
  models:[...models.map(id=>({id,vendor:'openai'})),{id:'lone-model',vendor:'openai'},{id:'gemini-lab',vendor:'google'}],
  channels:['primary','backup'].map((id,index)=>({id,name:'S6 '+id,pool_id:'pool',enabled:true,priority:10-index,weight:0,base_url:fixture,credential_ref:id,credential_version:'1',account_ref:null,models:models.map(model_id=>({model_id,upstream_model:model_id,capabilities:['chat_completions']}))})),
  aliases:[],callers:[{id:'s6-caller',name:'S6 synthetic caller',enabled:true,subject_enabled:true,token_hmac:createHmac('sha256',hmac).update('motai-caller-v1\0').update(token).digest('hex'),expires_at:null,allowed_ips:[],permissions:[{pool_id:'pool',model_ids:models,channel_ids:['primary','backup'],protocols:['chat_completions'],groups:[]},{pool_id:'lone-pool',model_ids:['lone-model'],channel_ids:['lone'],protocols:['chat_completions'],groups:[]}]}],
  affinity:{enabled:true,ttl_seconds:3600,scope_version:1},failure_policy:{max_attempts:1,ordinary_failure_threshold:3,ordinary_failure_window_seconds:300,cooldown_seconds:60,retry_after_max_seconds:60}};
config.channels.push({id:'lone',name:'S6 lone',pool_id:'lone-pool',enabled:true,priority:10,weight:0,base_url:fixture,credential_ref:'lone',credential_version:'1',account_ref:null,models:[{model_id:'lone-model',upstream_model:'lone-model',capabilities:['chat_completions']}]});
config.channels.push({id:'gemini',name:'S6 Gemini',pool_id:'gemini-pool',enabled:true,priority:10,weight:0,base_url:fixture,credential_ref:'gemini',credential_version:'1',account_ref:null,models:[{model_id:'gemini-lab',upstream_model:'gemini-lab',capabilities:['gemini_generate_content']}]});
let credentials={format_version:1,gen:'1',entries:['primary','backup','lone','gemini'].map(credential_ref=>({credential_ref,credential_version:'1',secret:`synthetic-s6-${credential_ref}${credential_ref==='gemini'?'':'-v1'}`}))};
const clients=[{id:'codex',vendor:'openai',protocol:'responses'},{id:'claude',vendor:'anthropic',protocol:'messages'},{id:'grok',vendor:'xai',protocol:'chat_completions'}];
for(const client of clients){
  const id=`client-${client.id}`,model_id=`motai-s6-${client.id}`;
  config.models.push({id:model_id,vendor:client.vendor});
  config.channels.push({id,name:`S6 ${client.id} client`,pool_id:'client-pool',enabled:true,priority:10,weight:0,base_url:'http://s6-client-fixture:9001',credential_ref:id,credential_version:'1',account_ref:null,models:[{model_id,upstream_model:model_id,capabilities:[client.protocol]}]});
  credentials.entries.push({credential_ref:id,credential_version:'1',secret:`synthetic-s6-${id}`});
}
config.callers[0].permissions.push({pool_id:'client-pool',model_ids:clients.map(row=>`motai-s6-${row.id}`),channel_ids:clients.map(row=>`client-${row.id}`),protocols:clients.map(row=>row.protocol),groups:[]});
const publish=async(gen,base,change=()=>{})=>{change(config,credentials);config.gen=credentials.gen=gen;const manifest={format_version:1,gen,base_gen:base,config:await file(`gen-${gen}.config.json`,config),credentials:await file(`gen-${gen}.credentials.json`,credentials)};const reference=await file(`gen-${gen}.manifest.json`,manifest);await file('desired.next.json',{format_version:1,gen,manifest:reference});await rename('/config/desired.next.json','/config/desired.json');return {format_version:1,gen,base_committed_gen:base,manifest_sha256:reference.sha256};};
if(process.argv[2]==='prepare'){
  await writeFile('/config/hmac.key',hmac,{mode:0o600});await writeFile('/config/management.key',management,{mode:0o600});
  await writeFile('/config/client-token.txt',token,{mode:0o600});
  await publish('1',null);console.log(JSON.stringify({prepared:true,synthetic:true}));process.exit(0);
}
const idle=async()=>{const end=Date.now()+10000;while(Date.now()<end){const value=(await internal('/status')).body;if(value.in_flight===0&&value.completion_pending===0)return value;await new Promise(resolve=>setTimeout(resolve,50));}throw Error('S6 completion timeout');};
const state=async()=>{const response=await internal('/channels/health');assert.equal(response.status,200);return response.body;};
const channel=async(id='primary')=>(await state()).channels.find(row=>row.channel_id===id);
const ledger=async()=>(await(await fetch(fixture+'/__s6/state')).json()).requests;
const post=async(caseId,model='general',explicit)=>{const response=await fetch(relay+'/v1/chat/completions',{method:'POST',headers:{authorization:`Bearer ${token}`,'content-type':'application/json','x-motai-session':caseId,...(explicit?{'x-motai-channel':explicit}:{})},body:JSON.stringify({model,stream:false,messages:[{role:'user',content:`LAB:${caseId}`}]}),signal:AbortSignal.timeout(15000)});const body=await response.text();await idle();return {status:response.status,body,attemptId:response.headers.get('x-motai-attempt-id')};};
const probe=async()=>{const response=await internal('/probes',{format_version:1,source:'manual',channel_id:'primary',model_id:'general',protocol:'chat_completions',client_run_id:randomUUID()});assert.equal(response.status,200);const end=Date.now()+10000;while(Date.now()<end){const page=await internal('/events?after_seq=0&limit=1000');const event=page.body.events.find(row=>row.attempt.intent.attempt_id===response.body.attempt_id);if(event){assert.equal(event.attempt.terminal.attempt_outcome,'succeeded');return;}await new Promise(resolve=>setTimeout(resolve,50));}throw Error('probe terminal timeout');};
const reset=async(id='primary',operation_id=randomUUID(),override={})=>{const health=await state();const current=health.channels.find(row=>row.channel_id===id);return internal(`/channels/${id}/health-reset`,{format_version:1,operation_id,expected_gen:health.gen,expected_credential_version:current.credential_version,expected_state_version:current.state_version,...override});};
const desired=JSON.parse(await readFile('/config/desired.json','utf8'));
assert.equal((await fetch(fixture+'/__s6/reset')).status,200);
assert.equal((await internal('/activate',{format_version:1,gen:desired.gen,base_committed_gen:null,manifest_sha256:desired.manifest.sha256})).status,200);
assert.equal((await internal('/channels/health',null,'wrong')).status,401);
assert.equal((await state()).channels.length,7);assert((await state()).channels.every(row=>row.state==='available'&&row.state_version==='0'));
passed.push('health-management-auth-and-complete-config-view');

assert.equal((await post('rate-seconds-first','rate-seconds-model')).status,429);
assert.equal((await post('rate-seconds-next','rate-seconds-model')).status,200);
const rateRows=(await ledger()).filter(row=>row.caseId?.startsWith('rate-seconds'));
assert.deepEqual(rateRows.map(row=>row.role),['primary','backup']);
const countBefore=(await ledger()).length;assert.equal((await post('blocked-explicit','rate-seconds-model','primary')).status,503);assert.equal((await ledger()).length,countBefore);
assert.equal((await post('rate-seconds-lone','lone-model')).status,429);const loneBefore=(await ledger()).length;assert.equal((await post('no-backup-next','lone-model')).status,503);assert.equal((await ledger()).length,loneBefore);
passed.push('legal-seconds-cooldown-single-dispatch-next-backup-explicit-and-no-backup-zero-dispatch');
assert.equal((await post('rate-date-first','rate-date-model')).status,429);assert.equal((await post('after-date','rate-date-model')).status,200);assert.deepEqual((await ledger()).filter(row=>['rate-date-first','after-date'].includes(row.caseId)).map(row=>row.role),['primary','backup']);
passed.push('legal-http-date-cooldown-next-request-only');
assert.equal((await post('rate-invalid-first','rate-invalid-model')).status,429);assert.equal((await post('after-invalid','rate-invalid-model')).status,200);assert.deepEqual((await ledger()).filter(row=>['rate-invalid-first','after-invalid'].includes(row.caseId)).map(row=>row.role),['primary','primary']);
assert.equal((await post('ordinary-403-first')).status,403);assert.equal((await post('after-ordinary-403')).status,200);assert.equal((await channel()).state,'available');
passed.push('invalid-retry-after-and-generic-403-preserve-primary');

assert.equal((await post('funds-first')).status,403);let health=await channel();assert.equal(health.state,'exhausted');assert.equal(health.state_version,'1');
assert.equal((await post('after-funds')).status,200);assert.equal((await ledger()).find(row=>row.caseId==='after-funds').role,'backup');
await probe();
const end=Date.now()+10000;while((await channel()).state!=='available'){if(Date.now()>end)throw Error('probe recovery timeout');await new Promise(resolve=>setTimeout(resolve,50));}
assert.equal((await post('after-probe-recovery')).status,200);assert.equal((await ledger()).find(row=>row.caseId==='after-probe-recovery').role,'primary');
passed.push('funds-text-state-next-request-backup-success-probe-recovery');

assert.equal((await post('invalid-key-first')).status,401);health=await channel();assert.equal(health.state,'auth_invalid');
await probe();await idle();assert.equal((await channel()).state,'auth_invalid');
assert.equal((await reset('primary',randomUUID(),{expected_state_version:'0'})).status,409);
assert.equal((await reset('primary',randomUUID(),{expected_gen:'0'})).body.error.code,'stale_base_generation');
const operation_id=randomUUID();const current=await state();const snapshot=current.channels.find(row=>row.channel_id==='primary');const resetBody={format_version:1,operation_id,expected_gen:current.gen,expected_credential_version:snapshot.credential_version,expected_state_version:snapshot.state_version};
const restored=await internal('/channels/primary/health-reset',resetBody);assert.equal(restored.status,200);assert.equal(restored.body.changed,true);assert.deepEqual((await internal('/channels/primary/health-reset',resetBody)).body,restored.body);assert.equal((await internal('/channels/primary/health-reset',{...resetBody,expected_state_version:restored.body.state_version})).body.error.code,'operation_conflict');
passed.push('auth-invalid-probe-does-not-restore-optimistic-idempotent-manual-reset');

assert.equal((await post('invalid-key-before-disable')).status,401);
assert.equal((await internal('/activate',await publish('2','1',value=>{value.channels.find(row=>row.id==='primary').enabled=false;}))).status,200);assert.equal((await channel()).state,'auth_invalid');
assert.equal((await reset()).status,200);assert.equal((await post('after-reset-disabled')).status,200);assert.equal((await ledger()).find(row=>row.caseId==='after-reset-disabled').role,'backup');
assert.equal((await internal('/activate',await publish('3','2',(value,secrets)=>{const primary=value.channels.find(row=>row.id==='primary');primary.enabled=true;primary.credential_version='2';secrets.entries=secrets.entries.filter(row=>row.credential_ref!=='primary');secrets.entries.push({credential_ref:'primary',credential_version:'2',secret:'synthetic-s6-primary-v2'});}))).status,200);assert.equal((await channel()).state,'available');assert.equal((await channel()).state_version,'0');
assert.equal((await post('after-credential-version')).status,200);assert.equal((await ledger()).find(row=>row.caseId==='after-credential-version').role,'primary');
passed.push('epoch-change-preserves-account-state-reset-keeps-disabled-credential-version-new-state');

const catalog=await internal('/channels/gemini/models',{format_version:1});assert.equal(catalog.status,200);assert.deepEqual(catalog.body.models.map(row=>row.id),['gemini-lab','gemini-next']);assert(catalog.body.models.every(row=>JSON.stringify(row.capabilities)==='["gemini_generate_content"]'));
const preview=await internal('/models/preview',{format_version:1,base_url:fixture,channel_id:null,credential:'synthetic-s6-gemini',capabilities:['gemini_generate_content']});assert.equal(preview.status,200);assert.deepEqual(preview.body.models,catalog.body.models);
const catalogRows=(await ledger()).filter(row=>row.kind==='catalog');assert.equal(catalogRows.length,4);assert(catalogRows.every(row=>row.googAuthorized&&!row.queryKeyPresent));assert.deepEqual(catalogRows.map(row=>row.page),['','page-2','','page-2']);
passed.push('native-gemini-saved-and-preview-http-pagination-filter-dedupe-auth-header');
await idle();const events=await internal('/events?after_seq=0&limit=1000');assert.equal(events.status,200);assert(!JSON.stringify(events.body).includes('CANARY_S6_UPSTREAM_ERROR'));assert(!JSON.stringify(events.body).includes('synthetic-s6-primary'));assert(events.body.events.some(row=>row.attempt.terminal.channel_effect==='exhausted'));assert(events.body.events.some(row=>row.attempt.terminal.channel_effect==='auth_invalid'));assert(events.body.events.some(row=>row.attempt.terminal.channel_effect==='cooldown'));
const generations=(await ledger()).filter(row=>row.kind==='generation');for(const row of generations.filter(row=>row.caseId!=='probe')){assert.equal(generations.filter(other=>other.caseId===row.caseId).length,1,row.caseId+' single dispatch');}
passed.push('terminal-whitelist-privacy-and-every-model-request-single-dispatch');
console.log(JSON.stringify({passed,count:passed.length,servingGen:(await internal('/status')).body.serving_gen,latestSeq:(await internal('/status')).body.latest_seq,events:events.body.events.length,generationDispatches:generations.length,catalogPages:catalogRows.length,productionTouched:false,synthetic:true},null,2));
