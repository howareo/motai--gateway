import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';

const origin=process.env.MOTAI_CONSOLE_TEST_ORIGIN || 'http://s6-console:8787';
const relay=process.env.MOTAI_GATEWAY_MODEL_URL || 'http://s6-core:3001';
const token=await readFile('/config/client-token.txt','utf8');
const checks=[];
const request=async(path,body,method=body?'POST':'GET',withOrigin=true)=>{
  const response=await fetch(origin+path,{method,headers:{'content-type':'application/json',...(withOrigin?{origin}:{})},body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(15000)});
  return {status:response.status,body:await response.json()};
};
const deadline=Date.now()+10000;
while(true){try{if((await request('/api/gateway/status')).status===200)break;}catch{}assert(Date.now()<deadline,'console startup');await new Promise(resolve=>setTimeout(resolve,100));}
const initial=await request('/api/gateway/config');assert.equal(initial.status,200);const gen=initial.body.config.gen;
let health=await request('/api/gateway/channels/health');assert.equal(health.status,200);assert.equal(health.body.gen,gen);assert.equal(health.body.channels.length,7);
checks.push('current-node-console-to-s6-health-read');
const beforeEnabled=initial.body.config.channels.map(row=>[row.id,row.enabled]);
const failed=await fetch(relay+'/v1/chat/completions',{method:'POST',headers:{authorization:`Bearer ${token}`,'content-type':'application/json','x-motai-session':'s6-console-fault-'+randomUUID()},body:JSON.stringify({model:'general',stream:false,messages:[{role:'user',content:'LAB:invalid-key-console'}]}),signal:AbortSignal.timeout(15000)});await failed.arrayBuffer();assert.equal(failed.status,401);
const blockedBy=Date.now()+10000;let row;
while(true){health=await request('/api/gateway/channels/health');assert.equal(health.status,200);row=health.body.channels.find(value=>value.channelId==='primary');if(row.state==='auth_invalid')break;assert(Date.now()<blockedBy,'console observed block');await new Promise(resolve=>setTimeout(resolve,50));}
assert(row.observedAt.endsWith('Z'));assert.equal(typeof row.stateVersion,'string');
const payload={baseGen:gen,operationId:randomUUID(),credentialVersion:row.credentialVersion,stateVersion:row.stateVersion};
assert.equal((await request('/api/gateway/channels/primary/health-reset',payload,'POST',false)).status,403);
assert.equal((await request('/api/gateway/channels/primary/health-reset',{...payload,operationId:randomUUID(),stateVersion:'0'})).status,409);
const restored=await request('/api/gateway/channels/primary/health-reset',payload);assert.equal(restored.status,200);assert.equal(restored.body.changed,true);assert.equal(restored.body.state,'available');
assert.deepEqual((await request('/api/gateway/channels/primary/health-reset',payload)).body,restored.body);
health=await request('/api/gateway/channels/health');assert.equal(health.body.channels.find(value=>value.channelId==='primary').state,'available');
const afterConfig=await request('/api/gateway/config');assert.equal(afterConfig.body.config.gen,gen);assert.deepEqual(afterConfig.body.config.channels.map(value=>[value.id,value.enabled]),beforeEnabled);
checks.push('node-health-reset-origin-optimism-idempotency-and-enabled-state');
const rules=await request('/api/cost-rules');assert.equal(rules.status,200);
const manual=await request('/api/channels/primary/cost',{baseVersion:rules.body.costVersion ?? rules.body.version,multiplier:0.37,costSyncMode:'manual'},'PUT');assert.equal(manual.status,200);assert.equal(manual.body.pricing.multiplier,0.37);
const automatic=await request('/api/channels/primary/cost-sync',{baseVersion:manual.body.costVersion,mode:'auto'},'PUT');assert.equal(automatic.status,200);assert.equal(automatic.body.pricing.multiplier,0.37);
checks.push('node-manual-price-and-real-go-billing-probe-preserve-confirmed-price');
const wallet=await request('/api/channels/primary/wallet-refresh',{});assert.equal(wallet.status,200);assert.equal(wallet.body.channels.primary.balance,null);assert.equal(wallet.body.channels.primary.status,'unsupported');assert(!JSON.stringify(wallet.body).includes(token));
checks.push('node-wallet-refresh-to-go-unknown-is-not-zero');
const overview=await request('/api/overview?period=today');assert.equal(overview.status,200);assert.equal(overview.body.source.mode,'gateway');
for(const value of [health,restored,manual,automatic,wallet,overview])assert(!/CANARY_S6_UPSTREAM_ERROR|synthetic-s6-primary|token_hmac|credential_ref/.test(JSON.stringify(value)));
checks.push('node-overview-and-new-route-responses-redacted');
console.log(JSON.stringify({checks,passed:checks.length,servingGen:gen,price:automatic.body.pricing,wallet:wallet.body,productionTouched:false,synthetic:true}));
