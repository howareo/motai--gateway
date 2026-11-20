import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
const directory='/config';
const headers={authorization:'Bearer sk-motaicandidatelabsynthetictoken','content-type':'application/json'};
const management='synthetic-management-key-20261027';
const internal=async(path,body)=>{const response=await fetch(`http://core:3002/internal/v1${path}`,{method:body?'POST':'GET',headers:{authorization:`Bearer ${management}`,'content-type':'application/json'},body:body&&JSON.stringify(body)});return{status:response.status,body:await response.json()}};
const state=async()=>(await(await fetch('http://fixture:9000/__lab/state')).json()).requests;
const post=async(id,protocol='chat')=>fetch(`http://core:3001/v1/${protocol==='chat'?'chat/completions':'responses'}`,{method:'POST',headers:{...headers,'X-Motai-Session':randomUUID()},body:JSON.stringify(protocol==='chat'?{model:'gpt-4o-mini',messages:[{role:'user',content:`LAB:${id}`}]}:{model:'gpt-4o-mini',input:`LAB:${id}`,stream:true})});
const waitFor=async(fn)=>{const end=Date.now()+15000;while(Date.now()<end){if(await fn())return;await new Promise(resolve=>setTimeout(resolve,100))}throw Error('fault condition timed out')};
const mode=process.argv[2];
if(mode==='start-interrupt'){
 const response=await post('responses-cancel','responses');assert.equal(response.status,200);
 const attempt=response.headers.get('x-motai-attempt-id');assert(attempt);
 await writeFile(`${directory}/fault-interrupt.json`,JSON.stringify({attempt,count:(await state()).filter(row=>row.caseId==='responses-cancel').length}),{mode:0o600});
 await response.text().catch(()=>{});
}else if(mode==='verify-interrupt'){
 const saved=JSON.parse(await readFile(`${directory}/fault-interrupt.json`));
 let event;await waitFor(async()=>{const page=(await internal('/events?after_seq=0&limit=1000')).body;event=page.events.find(event=>event.attempt.intent.attempt_id===saved.attempt);return Boolean(event)});
 assert.equal(event.attempt.terminal.attempt_outcome,'interrupted');assert.equal(event.attempt.terminal.send_certainty,'unknown');assert.equal(event.attempt.terminal.usage.total_input.value,null);
 assert.equal((await state()).filter(row=>row.caseId==='responses-cancel').length,saved.count);
 console.log(JSON.stringify({passed:'kill-restart-interrupted-unknown-no-replay',attempt:saved.attempt}));
}else if(mode==='admission-failure'){
 const before=(await state()).length;const response=await post('chat-admission-failure');assert.equal(response.status,503);await response.text();assert.equal((await state()).length,before);console.log(JSON.stringify({passed:'intent-failure-zero-upstream-dispatch'}));
}else if(mode==='completion-failure'){
 const response=await post('chat-completion-failure');assert.equal(response.status,200);await response.text();
 const attempt=response.headers.get('x-motai-attempt-id');await writeFile(`${directory}/fault-completion.json`,JSON.stringify({attempt}),{mode:0o600});
 await waitFor(async()=>(await internal('/status')).body.degraded_reasons.includes('completion_write_failed'));
 const before=(await state()).length;const rejected=await post('chat-degraded-admission');assert.equal(rejected.status,503);await rejected.text();assert.equal((await state()).length,before);assert.equal((await state()).filter(row=>row.caseId==='chat-completion-failure').length,1);
 console.log(JSON.stringify({passed:'completion-failure-blocks-admission-without-replay',attempt}));
}else if(mode==='completion-recover'){
 assert.equal((await internal('/resume',{format_version:1,operation_id:randomUUID()})).status,200);
 await waitFor(async()=>(await internal('/status')).body.completion_pending===0);
 const saved=JSON.parse(await readFile(`${directory}/fault-completion.json`));const events=(await internal('/events?after_seq=0&limit=1000')).body.events.filter(event=>event.attempt.intent.attempt_id===saved.attempt);assert.equal(events.length,1);assert.equal((await state()).filter(row=>row.caseId==='chat-completion-failure').length,1);
 console.log(JSON.stringify({passed:'completion-resume-idempotent-single-terminal-zero-replay'}));
}else{throw Error('unknown fault mode')}
