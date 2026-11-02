import test from './helpers/bounded-test.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {setup,events,selectCurrentCleanup} from './helpers/closeout-fixture.mjs';
import {disposeStoppedAllocations} from '../lib/closeout-allocations.mjs';
import {fold} from '../lib/state.mjs';
import {currentCloseoutEntries} from '../lib/closeout.mjs';
import {runCloseoutTurn} from '../line-service/closeout-turn.mjs';
import {gitProject} from '../lib/project.mjs';
import {performance} from 'node:perf_hooks';
import {claimRetirementAllocation,claimLegacyRetirement,retirementOwnerLock,retirementAllocationLock} from '../lib/closeout.mjs';
import {dispatchAllocationEffect} from '../dispatch/allocation-effect.mjs';

function stopped(t,{run=false,occupied=false}={}){
  const f=setup(t,{occupied,merged:true,direct:true,bound:occupied});selectCurrentCleanup(f);
  const journal=path.join(f.org,'dispatch/attempt.json');fs.mkdirSync(path.dirname(journal),{recursive:true});
  const start={type:'run.started',id:'R-1',item:'ENG-1',workspace:f.lane,meta:{lane:'topic',dispatch_journal:journal,
    dispatch_attempt:'attempt',dispatch_project:f.common,dispatch_record:f.org}};
  fs.writeFileSync(f.eventFile,JSON.stringify({type:'item.added',id:'ENG-1',role:'engineer',seq:1,at:'2026-01-01T00:00:00Z'})+'\n');
  if(run)f.append([start,{type:'run.claimed',run:'R-1',record:f.org,project:f.common,
    owner:{controller:'brain',legacy:false,release:{id:'source',root:process.cwd(),commit:null,identity:f.common}}}]);
  const owned=fold(events(f)).runs.get('R-1');
  const job={token:'attempt',repo:f.repo,common:f.common,org:f.org,lane:'topic',workspace:f.lane,base:f.head,
    item:'ENG-1',run:run?'R-1':null,stage:run?'worker':'start',native_launch_attempted:false,
    ...(run?{ownership:{owner:owned.owner,generation:owned.owner_generation}}:{}),
    error:'dispatch launch input changed: item/ancestor ENG-1 is closed/held/reserved'};
  job.failure={code:'DISPATCH_INPUT_CHANGED',native_launch_attempted:false,stage:job.stage,
    launch_input:{journal,token:'attempt',item:'ENG-1',run:job.run,project:f.common}};
  const save=()=>fs.writeFileSync(journal,JSON.stringify(job)+'\n');save();
  const hash=createHash('sha256').update(fs.readFileSync(journal)).digest('hex');
  f.append([{type:'dispatch.completed',project:f.common,journal,attempt:'attempt',item:'ENG-1',run:job.run,
    stage:job.stage,exit_code:1,native_launch_attempted:false,request_sha256:hash,failure:job.failure}]);
  const dispose=()=>disposeStoppedAllocations({cwd:f.repo,org:f.org,env:f.env,retirementOptions:f.options});
  return{...f,journal,hash,job,save,dispose};
}

test('line removes a never-launched folder with no run and immutable typed Git receipts',t=>{
  const f=stopped(t),journal=fs.readFileSync(f.journal),before=fs.readFileSync(f.eventFile);
  const command=f.options.command,holds=[],rows=[];
  const rename=fs.renameSync,rmdir=fs.rmdirSync;let acquired;
  t.mock.method(fs,'renameSync',function(a,b,...rest){
    const out=rename.call(fs,a,b,...rest);if(b===retirementOwnerLock(f.common))acquired=performance.now();return out;
  });
  t.mock.method(fs,'rmdirSync',function(a,...rest){
    const out=rmdir.call(fs,a,...rest);if(a===retirementOwnerLock(f.common))holds.push(performance.now()-acquired);return out;
  });
  f.options.command=(exe,args,options)=>{
    if(exe==='git'&&args[2]==='worktree'&&args[3]==='remove'){
      const at=performance.now();
      assert.equal(fs.existsSync(retirementOwnerLock(f.common)),false);
      const allocation=retirementAllocationLock(f.common,'lane/topic'),bytes=fs.readFileSync(path.join(allocation,'owner.json'));
      assert.throws(()=>claimRetirementAllocation(f.common,'lane/topic'),/locked:/);
      assert.deepEqual(fs.readFileSync(path.join(allocation,'owner.json')),bytes);
      assert.throws(()=>claimLegacyRetirement(f.common),/locked:.*consumer.lock/);
      let admitted=false;
      dispatchAllocationEffect({project:gitProject(f.repo),org:f.org,branch:'lane/unrelated',waitMs:0},()=>{admitted=true;});
      assert.equal(admitted,true);
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,250);
      const result=command(exe,args,options);
      rows.push({git_ms:performance.now()-at,owner_lock_present:fs.existsSync(retirementOwnerLock(f.common)),unrelated_admitted:admitted});return result;
    }
    return command(exe,args,options);
  };
  const result=f.dispose();assert.equal(result.results[0].disposition,'removed',JSON.stringify(result));
  assert.equal(rows.length,1);assert.ok(holds.length>1);
  assert.equal(fs.existsSync(retirementAllocationLock(f.common,'lane/topic')),false);
  assert.equal(fs.existsSync(path.join(f.common,'closeout/consumer.lock')),false);
  if(process.env.CLOSEOUT_FIX_EVIDENCE_DIR){
    fs.mkdirSync(process.env.CLOSEOUT_FIX_EVIDENCE_DIR,{recursive:true});
    fs.writeFileSync(path.join(process.env.CLOSEOUT_FIX_EVIDENCE_DIR,'after.json'),JSON.stringify({holds_ms:holds,
      total_owner_hold_ms:holds.reduce((a,b)=>a+b,0),max_owner_hold_ms:Math.max(...holds),rows,
      qualification:'Offline fixture; 250 ms injected Git latency, actual lock edges; unrelated dispatch admission completes inside removal.'},null,2)+'\n');
  }
  assert.equal(fs.existsSync(f.lane),false);assert.equal(f.git(['branch','--list','lane/topic']),'');
  assert.deepEqual(fs.readFileSync(f.journal),journal);assert.deepEqual(fs.readFileSync(f.eventFile).subarray(0,before.length),before);
  const actions=events(f).filter(e=>e.type==='closeout.allocation-effect').map(e=>e.outcome.action);
  for(const action of ['lane-preflight','git-removal-started','git-removal-finished','worktree-removed','branch-removed','lane-removed'])assert.ok(actions.includes(action),action);
  const calls=f.herdrCalls();assert.deepEqual(f.dispose().results,[]);assert.deepEqual(f.herdrCalls(),calls);
});

test('line finalizes only its exact pre-native run and the ordinary closer removes its folder',t=>{
  const f=stopped(t,{run:true}),journal=fs.readFileSync(f.journal),before=fs.readFileSync(f.eventFile);
  const result=f.dispose();assert.equal(result.results[0].disposition,'NOT_STARTED',JSON.stringify(result));
  assert.ok(fold(events(f)).runs.get('R-1').abandoned);assert.equal(fs.existsSync(f.lane),true);
  const entry=currentCloseoutEntries(f.common,f.org,events(f))[0];assert.equal(entry.source.type,'run.abandoned');
  const removed=f.drain({keys:[entry.key],retrySafe:true});assert.equal(removed.evaluated[0].completed,true,JSON.stringify(removed));
  assert.equal(fs.existsSync(f.lane),false);assert.deepEqual(fs.readFileSync(f.journal),journal);
  assert.deepEqual(fs.readFileSync(f.eventFile).subarray(0,before.length),before);
});

for(const session of [null,'session'])test(`typed STOP between launch and prompt finalizes its exact allocation; session=${session}`,t=>{
  const f=stopped(t,{run:true,occupied:true});
  const worker={agentName:'worker',pane:'w:p',workspaceId:'w',terminalId:'term',agentSessionId:session,cwd:f.lane};
  f.append([{type:'run.updated',id:'R-1',meta:{agent:'worker',pane:'w:p',worker_workspace:'w',terminal_id:'term',agent_session_id:session}}]);
  f.state.agents[0].agent_session=session?{value:session}:null;f.save();
  Object.assign(f.job,{worker,launchProcess:{pid:2,identity:'native'},stage:'prompt',native_launch_attempted:true,
    error:'STOP/HOLD prevents native dispatch effect',failure:{code:'DISPATCH_STOPPED',kind:'fence',stage:'prompt',native_launch_attempted:true}});
  f.save();
  f.append([{type:'dispatch.completed',project:f.common,journal:f.journal,attempt:'attempt',item:'ENG-1',run:'R-1',stage:'prompt',
    exit_code:0,native_launch_attempted:true,request_sha256:createHash('sha256').update(fs.readFileSync(f.journal)).digest('hex'),failure:f.job.failure}]);
  const stop=path.join(f.repo,'.lane/supervisor/STOP');fs.mkdirSync(path.dirname(stop),{recursive:true});fs.writeFileSync(stop,'stop');
  assert.throws(f.dispose,/STOP\/HOLD/);assert.deepEqual(f.read().actions,[]);
  fs.unlinkSync(stop);
  const original=fs.readFileSync(f.eventFile),journal=fs.readFileSync(f.journal),result=f.dispose();
  assert.equal(result.results[0].disposition,'NOT_PROMPTED',JSON.stringify(result));
  const entry=currentCloseoutEntries(f.common,f.org,events(f))[0];
  assert.equal(fold(events(f)).runs.get('R-1').abandoned.authorization.kind,'positive-unprompted-stopped-allocation');
  if(!session){
    assert.equal(f.drain({keys:[entry.key],retrySafe:true}).evaluated[0].completed,false);
    assert.deepEqual(f.read().actions,[]);assert.equal(fs.existsSync(f.lane),true);
    // The original occupant departs independently. No SID is reconstructed,
    // and the finite closer uses its existing active-process observation path.
    f.state.agents=[];f.state.panes=[];f.state.tabs=[];f.save();
  }
  const final=f.drain({keys:[entry.key],retrySafe:true});
  assert.equal(final.evaluated[0].completed,true,JSON.stringify(final));assert.equal(fs.existsSync(f.lane),false);
  assert.equal(events(f).some(e=>e.type==='run.session_bound'),false);
  assert.equal(f.read().actions.some(a=>a[0]==='agent'&&a[1]==='prompt'),Boolean(session));
  assert.deepEqual(fs.readFileSync(f.journal),journal);assert.deepEqual(fs.readFileSync(f.eventFile).subarray(0,original.length),original);
});

test('line wake invokes stopped allocation disposal with a viable original turn allowance',t=>{
  const f=stopped(t),{directory}=selectCurrentCleanup(f);
  fs.writeFileSync(path.join(directory,'closeout-turn.json'),JSON.stringify({schema:'line-closeout-turn/v1',identity:f.common,
    org:f.org,attempt:0,ingest:{},targets:{},turn:3}));
  let calls=0;
  const result=runCloseoutTurn({project:gitProject(f.repo),org:f.org,env:f.env,guard:()=>{},measure:()=>{},cli:(_file,args)=>{
    if(args[0]==='refresh')return '{}';
    assert.equal(args[0],'allocations');calls++;
    const deadline=Number(args[args.indexOf('--deadline')+1]);assert.ok(deadline-Date.now()>120000);
    return JSON.stringify(disposeStoppedAllocations({cwd:f.repo,org:f.org,env:f.env,retirementOptions:f.options,deadline}));
  }});
  assert.deepEqual(result.errors,[]);assert.equal(calls,1);assert.equal(fs.existsSync(f.lane),false);
});

test('stopped allocation resumes only the known partial Git result on a fresh allowance',t=>{
  const f=stopped(t),realNow=Date.now(),command=f.options.command;let elapsed=0,removals=0;
  t.mock.method(Date,'now',()=>realNow+elapsed);
  f.options.command=(exe,args,options)=>{
    const result=command(exe,args,options);
    if(exe==='git'&&args[2]==='worktree'&&args[3]==='remove'){elapsed+=175000;removals++;}
    return result;
  };
  assert.equal(f.dispose().results[0].disposition,'kept');assert.equal(fs.existsSync(f.lane),false);
  assert.ok(f.git(['branch','--list','lane/topic']));
  const result=f.dispose();assert.equal(result.results[0].disposition,'removed',JSON.stringify(result));
  assert.equal(f.git(['branch','--list','lane/topic']),'');assert.equal(removals,1);
});

test('stopped allocation fairness advances past a kept request without replacing it',t=>{
  const f=stopped(t);fs.writeFileSync(path.join(f.lane,'unsaved'),'keep');
  const second=f.lane+'-second';f.git(['worktree','add','-qb','lane/second',second,f.head]);
  const journal=path.join(f.org,'dispatch/z-second.json'),job=structuredClone(f.job);
  Object.assign(job,{token:'z-second',lane:'second',workspace:second});
  Object.assign(job.failure.launch_input,{journal,token:'z-second'});
  fs.writeFileSync(journal,JSON.stringify(job)+'\n');
  const hash=createHash('sha256').update(fs.readFileSync(journal)).digest('hex');
  f.append([{type:'dispatch.completed',project:f.common,journal,attempt:job.token,item:'ENG-1',run:null,
    stage:'start',exit_code:1,native_launch_attempted:false,request_sha256:hash,failure:job.failure}]);
  assert.equal(f.dispose().results[0].disposition,'kept');
  assert.equal(f.dispose().results[0].disposition,'removed');assert.equal(fs.existsSync(second),false);
  assert.equal(fs.readFileSync(path.join(f.lane,'unsaved'),'utf8'),'keep');
});

test('stopped allocation native refusal is durable and makes no later native observation',t=>{
  const f=stopped(t),command=f.options.command;let calls=0;
  f.options.command=(exe,args,options)=>{
    if(exe===f.options.herdr){calls++;return{status:null,error:Object.assign(Error('operation not permitted'),{code:'EPERM'}),stdout:'',stderr:'EPERM native refusal'};}
    return command(exe,args,options);
  };
  assert.equal(f.dispose().results[0].disposition,'kept');assert.ok(calls>0);const prior=calls;
  assert.deepEqual(f.dispose().results,[]);assert.equal(calls,prior);assert.ok(fs.existsSync(f.lane));
});

for(const kind of ['occupied','dirty','changed-head','UNKNOWN-launch','UNKNOWN-Git','live-request','HOLD','claim'])test(`stopped allocation retains ${kind}`,t=>{
  const f=stopped(t,{occupied:kind==='occupied',run:kind==='claim'});
  if(kind==='dirty')fs.writeFileSync(path.join(f.lane,'unsaved'),'unique');
  if(kind==='changed-head')f.git(['commit','--allow-empty','-m','another owner'],f.lane);
  if(kind==='UNKNOWN-launch'){f.job.native_launch_attempted=true;f.save();}
  if(kind==='live-request')fs.writeFileSync(f.journal+'.lock',String(process.pid));
  if(kind==='HOLD')fs.mkdirSync(path.join(f.repo,'.lane/supervisor/HOLD'),{recursive:true});
  if(kind==='claim')f.append([{type:'run.claimed',run:'R-1',record:f.org,project:f.common,owner:{controller:'foreign',legacy:true}}]);
  if(kind==='UNKNOWN-Git'){
    const key=createHash('sha256').update(JSON.stringify([f.common,f.journal,f.hash,'stopped-allocation'])).digest('hex');
    f.append([{type:'closeout.allocation-effect',key,identity:f.common,journal:f.journal,request_sha256:f.hash,
      outcome:{action:'git-removal-started',attempt:'original'}}]);
  }
  const before=fs.readFileSync(f.eventFile),journal=fs.readFileSync(f.journal),calls=f.herdrCalls();
  if(kind==='HOLD')assert.throws(f.dispose,/STOP\/HOLD/);else f.dispose();
  assert.ok(fs.existsSync(f.lane));assert.deepEqual(f.read().actions,[]);
  assert.deepEqual(fs.readFileSync(f.eventFile).subarray(0,before.length),before);assert.deepEqual(fs.readFileSync(f.journal),journal);
  if(['UNKNOWN-launch','UNKNOWN-Git','live-request','claim'].includes(kind))assert.deepEqual(f.herdrCalls(),calls);
});
