import test from './helpers/bounded-test.mjs';
import assert from 'node:assert/strict';
import {nativeProcess,observeSessionBinding} from '../dispatch/session-bind.mjs';

for(const outcome of ['recovers','expires','replacement','refusal'])test(`original session observation ${outcome} after temporary shell foreground`,async()=>{
  let clock=100000,reads=0,commits=0;
  const original={pid:2,identity:'original'},job={sessionBinding:{status:'observing',process:original,deadline:new Date(clock+60000).toISOString()}};
  const unavailable=()=>nativeProcess({agent:'codex'},{shell_pid:1,foreground_processes:[{pid:1,name:'zsh'}]});
  await observeSessionBinding({job,save:()=>{},now:()=>clock,monotonic:()=>clock,pause:async ms=>{clock+=ms;},record:()=>commits++,
    observe:()=>{
      if(++reads===1||outcome==='expires')return unavailable();
      if(outcome==='refusal')throw Object.assign(Error('native refusal'),{code:'EPERM'});
      return{process:outcome==='replacement'?{pid:2,identity:'replacement'}:original,session:'original-session'};
    }});
  assert.equal(commits,outcome==='recovers'?1:0);
  assert.equal(job.sessionBinding.status,outcome==='recovers'?'bound':'unbound');
  if(outcome==='expires')assert.equal(clock,160000);
  else assert.equal(reads,2);
});
