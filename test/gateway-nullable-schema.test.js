import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {validateContract} from '../src/gateway/schema.js';

const fixture=JSON.parse(readFileSync(new URL('../contracts/fixtures/attempt-valid.json',import.meta.url)));
test('nullable schema hot paths keep strict types, bounds and required properties',()=>{
  for(const [name,field,base,targetKey,valid,invalid] of [
    ['usage','value',fixture.terminal.usage,'total_input',[null,0,Number.MAX_SAFE_INTEGER],['1',-1,0.5,Number.MAX_SAFE_INTEGER+1]],
    ['terminal','upstream_status',fixture.terminal,null,[null,100,599],['200',99,600,200.5]],
    ['intent','value',fixture.intent,'effort',[null,'medium'],['','bad space',true]],
  ]){
    const value=structuredClone(base),target=targetKey?value[targetKey]:value;
    for(const item of valid){target[field]=item;assert.equal(validateContract(name,value).valid,true,`${name} accepts ${item}`);}
    for(const item of invalid){target[field]=item;assert.equal(validateContract(name,value).valid,false,`${name} rejects ${item}`);}
    delete target[field];assert.equal(validateContract(name,value).valid,false,`${name} requires ${field}`);
  }
});
