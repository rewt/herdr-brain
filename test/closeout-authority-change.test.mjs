import test from './helpers/bounded-test.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {setup,events,selectCurrentCleanup} from './helpers/closeout-fixture.mjs';
import {currentCloseoutEntries} from '../lib/closeout.mjs';
import {SCOPED_REMOVAL_AUTHORITY_CHANGED} from '../lib/retire-local.mjs';
import {LANE_REMOVAL_AUTHORITY_CHANGED} from '../lib/retire.mjs';

for(const reason of [SCOPED_REMOVAL_AUTHORITY_CHANGED,LANE_REMOVAL_AUTHORITY_CHANGED])
test(`authority-change wait replans its original untouched source: ${reason}`,t=>{
  const f=setup(t,{direct:true,bound:true,merged:true});selectCurrentCleanup(f);f.report();
  const entry=currentCloseoutEntries(f.common,f.org,events(f))[0];
  f.append([{type:'closeout.evaluated',identity:f.common,key:entry.key,run:entry.run,item:entry.item,source:entry.source,
    revision:entry.source.seq,completed:false,reason,condition:{kind:'owner-evidence-required',continuation:{kind:'owner-evidence'}}}]);
  const before=fs.readFileSync(f.eventFile),result=f.drain({keys:[entry.key],retrySafe:true});
  assert.equal(result.evaluated[0].completed,true,JSON.stringify(result));assert.equal(fs.existsSync(f.lane),false);
  assert.deepEqual(fs.readFileSync(f.eventFile).subarray(0,before.length),before);
});

for(const kind of ['UNKNOWN','refusal','head'])test(`authority-change wait retains ${kind} at the fresh boundary`,t=>{
  const f=setup(t,{direct:true,bound:true,merged:true});selectCurrentCleanup(f);f.report();
  const entry=currentCloseoutEntries(f.common,f.org,events(f))[0];
  f.append([{type:'closeout.evaluated',identity:f.common,key:entry.key,run:entry.run,item:entry.item,source:entry.source,
    revision:entry.source.seq,completed:false,reason:SCOPED_REMOVAL_AUTHORITY_CHANGED}]);
  if(kind==='UNKNOWN')f.append([{type:'closeout.effect',identity:f.common,key:entry.key,run:entry.run,source:entry.source,
    effect:'original',producer:'native-closeout/v2',outcome:{action:'agent-exit-requested',pane:'w:p'}}]);
  if(kind==='refusal')f.append([{type:'closeout.evaluated',identity:f.common,key:entry.key,run:entry.run,source:entry.source,
    completed:false,reason:'EPERM native refusal',failure:{kind:'fence',code:'EPERM'}}]);
  if(kind==='head')f.git(['commit','--allow-empty','-m','another source generation'],f.lane);
  const calls=f.herdrCalls();f.drain({keys:[entry.key],retrySafe:true});
  assert.equal(fs.existsSync(f.lane),true);assert.deepEqual(f.herdrCalls(),calls);assert.deepEqual(f.read().actions,[]);
});
