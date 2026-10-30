import test from './helpers/bounded-test.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {performance} from 'node:perf_hooks';
import {setup,events,selectCurrentCleanup} from './helpers/closeout-fixture.mjs';
import {fixture as dispatchFixture} from '../dispatch/test/dispatch-fixture.mjs';
import {gitProject} from '../lib/project.mjs';
import {loadTimeout} from '../lib/deadline.mjs';
import {runCloseoutTurn} from '../line-service/closeout-turn.mjs';
import {claimRetirementOwner,claimRetirementAllocation,retirementOwnerLock,retirementAllocationLock} from '../lib/closeout.mjs';

function evidence(name,value){
  if(!process.env.B9_EVIDENCE_DIR)return;
  fs.mkdirSync(process.env.B9_EVIDENCE_DIR,{recursive:true});
  fs.writeFileSync(path.join(process.env.B9_EVIDENCE_DIR,name+'.json'),JSON.stringify(value,null,2)+'\n');
}
function missingBacklog(f,count=24){
  f.append(Array.from({length:count},(_,i)=>i+100).flatMap(i=>[
    {type:'item.added',id:`ENG-${i}`,role:'engineer',title:'Historical missing binding'},
    {type:'run.started',id:`R-${i}`,item:`ENG-${i}`,meta:{dispatch_project:f.common}},
    {type:'report.ingested',run:`R-${i}`,sha256:`report-${i}`,report:{outcome:'done'}},
  ]));
  // Model the old writer's immutable sources without any target or diagnostic.
  const all=events(f).filter(e=>!(e.type==='closeout.binding-kept'&&Number(e.run?.slice(2))>=100));
  for(const e of all)if(e.type==='report.ingested'&&Number(e.run?.slice(2))>=100){delete e.closeout_targets;delete e.closeout_binding_errors;}
  fs.writeFileSync(f.eventFile,all.map(e=>JSON.stringify(e)+'\n').join(''));
}
function dispatcher(t,f){
  const file=path.join(f.repo,'.lane.json'),config=JSON.parse(fs.readFileSync(file));
  config.routes={engineer:{kind:'codex',model:'offline-fixture',effort:'high'}};
  fs.writeFileSync(file,JSON.stringify(config));
  return dispatchFixture(t,{sourceEntry:true,project:{cwd:f.repo,bundle:process.cwd(),env:{...f.env,HERDR_DISPATCH_RETIREMENT_WAIT_MS:'0'}}});
}

test('an unrelated lane open and dispatch finish while a drain with missing bindings is still in native observation',t=>{
  const f=setup(t,{direct:true,bound:true,merged:true});missingBacklog(f);f.report();
  const d=dispatcher(t,f),command=f.options.command,wait=new Int32Array(new SharedArrayBuffer(4));
  let launch,blockedMs,nativeMs,entered=false;
  f.options.command=(exe,args,options)=>{
    if(!entered&&exe===f.job.herdr&&args[0]==='workspace'&&args[1]==='list'){
      entered=true;const started=performance.now();
      assert.ok(events(f).filter(e=>e.type==='report.ingested'&&Number(e.run?.slice(2))>=100).length===24);
      assert.ok(fs.existsSync(retirementAllocationLock(f.common,'lane/topic')));
      assert.equal(fs.existsSync(retirementOwnerLock(f.common)),false);
      // A causal latch: the slow original observation cannot return until the
      // independent real dispatcher has opened its Git lane and bound a worker.
      const launchStarted=performance.now();
      launch=d.dispatch([d.item,'--lane','parallel','--route','engineer','--brief',d.brief]);
      blockedMs=performance.now()-launchStarted;
      assert.equal(launch.status,0,launch.stdout+launch.stderr);
      assert.ok(d.calls().some(c=>c.type==='lane'&&c.a[0]==='open'));
      assert.ok(d.calls().some(c=>c.type==='lane'&&c.a[0]==='dispatch'));
      assert.ok(d.state().runs.size>1);
      assert.ok(blockedMs<loadTimeout(15000),`launch took ${blockedMs}ms`);
      Atomics.wait(wait,0,0,250);
      nativeMs=performance.now()-started;
    }
    return command(exe,args,options);
  };
  const started=performance.now(),result=f.drain();
  assert.equal(entered,true);assert.ok(result.evaluated.some(e=>e.completed),JSON.stringify(result));
  assert.ok(result.owner_lock.max_hold_ms<loadTimeout(2000),JSON.stringify(result.owner_lock));
  assert.equal(fs.existsSync(retirementAllocationLock(f.common,'lane/topic')),false);
  evidence('launch',{backlog:24,launch_ms:blockedMs,slow_native_ms:nativeMs,drain_ms:performance.now()-started,
    owner_lock:result.owner_lock,launch_status:launch.status,launch_stdout:launch.stdout,
    before_lock_hold_lower_bound_ms:nativeMs,
    before_qualification:'At the parent source revision owner.lock spans this entire native call; lower bound inferred from the identical blocked-call interval, not a replayed baseline suite.',
    qualification:'Real dispatch controller and Git worktree open; offline native/watcher/lane adapters. Installed consumer and live native acceptance remain unrun.'});
});

test('a retirement of the same allocation refuses dispatch without holding the project owner lock',t=>{
  const f=setup(t,{direct:true,bound:true}),d=dispatcher(t,f),release=claimRetirementAllocation(f.common,'lane/topic');
  const before=events(f),lock=retirementAllocationLock(f.common,'lane/topic'),bytes=fs.readFileSync(path.join(lock,'owner.json'));
  try{
    const result=d.start();assert.notEqual(result.status,0);assert.match(result.stderr,/locked:.*retirement\/allocations\//);
    assert.deepEqual(fs.readFileSync(path.join(lock,'owner.json')),bytes);
    assert.equal(fs.existsSync(retirementOwnerLock(f.common)),false);
    assert.equal(d.calls().some(c=>c.type==='lane'&&['open','prepare','dispatch'].includes(c.a[0])),false);
    assert.equal(events(f).slice(before.length).some(e=>e.type==='run.started'),false);
    assert.ok(fs.existsSync(f.lane));
  }finally{release();}
});

test('unchanged missing-binding backlog adds zero observations after its first finite classification',t=>{
  const f=setup(t,{direct:true,bound:true});selectCurrentCleanup(f);missingBacklog(f);
  const args={project:gitProject(f.repo),org:f.org,env:f.env,guard:()=>{},measure:()=>{},maxSteps:64,cli:()=> '{}'};
  const counts=()=>events(f).filter(e=>e.type==='closeout.binding-kept').length;
  const before=counts();runCloseoutTurn(args);const first=counts();
  runCloseoutTurn(args);const second=counts();
  f.append([{type:'note.added',id:'ENG-1',text:'unrelated record activity'}]);
  runCloseoutTurn(args);const third=counts();
  assert.equal(first-before,24);assert.equal(second-first,0);assert.equal(third-second,0);
  assert.equal(new Set(events(f).filter(e=>e.type==='closeout.binding-kept').map(e=>e.key)).size,first);
  assert.deepEqual(f.read().actions,[]);
  evidence('observations',{backlog:24,first:first-before,unchanged:second-first,unrelated_churn:third-second});
});

for(const kind of ['live','unknown','dead'])test(`drain admission preserves ${kind} owner semantics`,t=>{
  const f=setup(t,{direct:true,bound:true}),lock=retirementOwnerLock(f.common);
  let release;
  if(kind==='live')release=claimRetirementOwner(f.common);
  else{
    fs.mkdirSync(lock,{recursive:true});
    fs.writeFileSync(path.join(lock,'owner.json'),JSON.stringify(kind==='dead'?{pid:2147483647,identity:'original-dead-birth',token:'dead'}:{}));
  }
  const bytes=fs.readFileSync(path.join(lock,'owner.json')),before=events(f);
  try{
    if(kind==='dead'){
      const result=f.drain();assert.deepEqual(result.evaluated,[]);assert.equal(fs.existsSync(lock),false);
    }else{
      assert.throws(()=>f.drain(),/owner is live or unknown/);
      assert.deepEqual(fs.readFileSync(path.join(lock,'owner.json')),bytes);
    }
    assert.deepEqual(events(f),before);assert.deepEqual(f.read().actions,[]);
  }finally{release?.();}
});
