import test from './helpers/bounded-test.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {performance} from 'node:perf_hooks';
import {setup,events,effects} from './helpers/closeout-fixture.mjs';
import {claimRetirementOwner,claimLegacyRetirement,closeoutDirectory,retirementOwnerLock} from '../lib/closeout.mjs';
import {retirementLock} from '../lib/retire-lock.mjs';
import {tidyFinishedTabs} from '../housekeeping/housekeeping.mjs';
import {finishCleanup,drain,queueFor} from '../promote/promote.mjs';

const pause=ms=>Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,ms);
const assertNeverSent=f=>{
  assert.deepEqual(f.read().actions,[]);
  assert.deepEqual(effects(f).map(e=>e.action),['report-evidence','agent-exit-requested']);
  const unsent=events(f).filter(e=>e.type==='closeout.command-not-started');
  assert.equal(unsent.length,1);assert.equal(unsent[0].native_started,false);
  assert.equal(unsent[0].action,'agent-exit-requested');
  assert.ok(fs.existsSync(f.lane));
};

for(const kind of ['live','unknown','deadline'])test(`bounded admission preserves ${kind} owner refusal`,t=>{
  const f=setup(t,{occupied:false}),lock=retirementOwnerLock(f.common);let release;
  if(kind==='unknown'){
    fs.mkdirSync(lock,{recursive:true});fs.writeFileSync(path.join(lock,'owner.json'),'{}');
  }else release=claimRetirementOwner(f.common);
  const bytes=fs.readFileSync(path.join(lock,'owner.json')),before=events(f);
  try{
    assert.throws(()=>f.drain(kind==='deadline'?{retirementOptions:{...f.options,deadline:Date.now()+80}}:{}),
      kind==='deadline'?/retirement deadline reached/:/owner is live or unknown/);
    assert.deepEqual(fs.readFileSync(path.join(lock,'owner.json')),bytes);
    assert.deepEqual(events(f),before);assert.deepEqual(f.read().actions,[]);
    assert.equal(fs.existsSync(path.join(closeoutDirectory(f.common),'consumer.lock')),false);
  }finally{release?.();}
});

test('a mid-batch guard waits for a different process holding owner.lock and finishes in the same turn',async t=>{
  const f=setup(t,{direct:true,bound:true,merged:true});f.report();
  const command=f.options.command,lock=retirementOwnerLock(f.common),ready=path.join(f.scratch,'owner-ready'),
    waiting=path.join(f.scratch,'guard-waiting');
  let launched=false,childDone,waitAt,releasedAt;
  const read=fs.readFileSync;
  t.mock.method(fs,'readFileSync',function(file,...args){
    if(launched&&file===path.join(lock,'owner.json')&&!fs.existsSync(waiting)){
      waitAt=performance.now();fs.writeFileSync(waiting,'guard observed contention');
    }
    return read.call(fs,file,...args);
  });
  f.options.command=(exe,args,options)=>{
    if(!launched&&exe===f.job.herdr&&args[0]==='workspace'&&args[1]==='list'){
      const child=spawn(process.execPath,['--input-type=module','-e',`
        import fs from 'node:fs';
        import {retirementLock} from ${JSON.stringify(new URL('../lib/retire-lock.mjs',import.meta.url).href)};
        const release=retirementLock(${JSON.stringify(lock)}),until=Date.now()+10000;
        const pause=ms=>Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,ms);
        try{
          fs.writeFileSync(${JSON.stringify(ready)},'ready');
          while(!fs.existsSync(${JSON.stringify(waiting)})){if(Date.now()>until)throw Error('guard never observed lock');pause(5);}
          pause(150);
        }finally{release();}
      `],{env:f.env,stdio:['ignore','pipe','pipe']});
      let stderr='';child.stderr.on('data',d=>{stderr+=d;});
      childDone=new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',status=>resolve({status,stderr}));});
      const until=Date.now()+10000;
      while(!fs.existsSync(ready)){assert.ok(Date.now()<until,'owner child did not become ready');pause(5);}
      launched=true;
    }
    return command(exe,args,options);
  };
  const result=f.drain();releasedAt=performance.now();
  assert.equal(launched,true);assert.ok(fs.existsSync(waiting));assert.ok(releasedAt-waitAt>=150);
  const exited=await childDone;assert.equal(exited.status,0,exited.stderr);
  assert.ok(result.evaluated.some(e=>e.completed),JSON.stringify(result));
  assert.equal(result.evaluated.some(e=>/locked:/.test(e.reason??'')),false);
  assert.equal(fs.existsSync(f.lane),false);
});

test('sustained mid-batch owner contention preserves never-sent intent and recovers after release',t=>{
  const f=setup(t,{direct:true,bound:true,merged:true});f.report();
  const command=f.options.command;let release,entered=false;
  f.options.command=(exe,args,options)=>{
    if(!entered&&exe===f.job.herdr&&args[0]==='workspace'&&args[1]==='list'){
      entered=true;release=claimRetirementOwner(f.common);
    }
    return command(exe,args,options);
  };
  let result;
  try{result=f.drain();}finally{release?.();}
  assert.ok(result.evaluated.some(e=>/locked:.*owner.lock/.test(e.reason??'')),JSON.stringify(result));
  assertNeverSent(f);
  const recovered=f.drain({retrySafe:true});
  assert.ok(recovered.evaluated.some(e=>e.completed),JSON.stringify(recovered));
  assert.equal(fs.existsSync(f.lane),false);
});

test('rollback during a queue effect excludes legacy tidy and promotion until the consumer releases',t=>{
  const f=setup(t,{direct:true,bound:true,merged:true});f.report();
  f.append([{type:'item.closed',id:'ENG-1',as:'done'}]);
  const command=f.options.command,queue=queueFor(f.repo),log=[];let rolledBack=false;
  f.options.command=(exe,args,options)=>{
    if(!rolledBack&&exe===f.job.herdr&&args[0]==='workspace'&&args[1]==='list'){
      rolledBack=true;
      fs.writeFileSync(path.join(f.repo,'.lane.json'),JSON.stringify({retirement:{closeout_queue:false}}));
      const calls=f.herdrCalls();
      const tidy=tidyFinishedTabs({cwd:f.repo,org:f.org,herdr:f.job.herdr,
        command:()=>assert.fail('legacy tidy overlapped queue effect'),log:row=>log.push(row)});
      assert.equal(tidy,false);assert.match(log.at(-1).why,/locked:.*closeout\/consumer.lock/);
      const result=finishCleanup(f.job,{outcome:'promoted',tip:f.head,workspace:f.lane},queue);
      assert.equal(result.cleanup.state,'pending');assert.match(result.cleanup.last_refusal,/locked:.*closeout\/consumer.lock/);
      assert.deepEqual(f.herdrCalls(),calls);
      // Dispatch admission remains free even while legacy cleanup is excluded.
      const release=claimRetirementOwner(f.common);release();
    }
    return command(exe,args,options);
  };
  const result=f.drain();assert.equal(rolledBack,true);
  assert.ok(result.evaluated.some(e=>/queue retirement policy disabled; keep original allocation/.test(e.reason??'')),JSON.stringify(result));
  assertNeverSent(f);
  assert.equal(fs.existsSync(path.join(closeoutDirectory(f.common),'consumer.lock')),false);
  const after=finishCleanup(f.job,{outcome:'promoted',tip:f.head,workspace:f.lane},queue);
  assert.equal(after.cleanup.state,'complete',JSON.stringify(after));assert.equal(fs.existsSync(f.lane),false);
});

test('legacy catch-up and nested retirement share the consumer fence and release failed admissions',async t=>{
  const f=setup(t,{occupied:false});fs.writeFileSync(path.join(f.repo,'.lane.json'),'{"retirement":{"closeout_queue":false}}');
  const consumer=path.join(closeoutDirectory(f.common),'consumer.lock'),queue=queueFor(f.repo),release=retirementLock(consumer);
  let stderr='';
  t.mock.method(process.stderr,'write',function(chunk,...rest){stderr+=String(chunk);return true;});
  try{await drain(queue);}finally{release();}
  assert.match(stderr,/retirement discovery: locked:.*closeout\/consumer.lock/);
  assert.deepEqual(f.read().actions,[]);
  const owner=retirementLock(retirementOwnerLock(f.common));
  try{assert.throws(()=>claimLegacyRetirement(f.common),/locked:.*owner.lock/);assert.equal(fs.existsSync(consumer),false);}finally{owner();}
  const first=claimLegacyRetirement(f.common),second=claimLegacyRetirement(f.common);
  first();assert.ok(fs.existsSync(consumer));second();assert.equal(fs.existsSync(consumer),false);
  assert.equal(fs.existsSync(retirementOwnerLock(f.common)),false);
});
