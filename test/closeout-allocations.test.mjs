import test from './helpers/bounded-test.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {setup,events,selectCurrentCleanup} from './helpers/closeout-fixture.mjs';
import {disposeStoppedAllocations} from '../lib/closeout-allocations.mjs';
import {fold} from '../lib/state.mjs';
import {currentCloseoutEntries} from '../lib/closeout.mjs';

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
  const result=f.dispose();assert.equal(result.results[0].disposition,'removed',JSON.stringify(result));
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
