import test from './helpers/bounded-test.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {setup,events,selectCurrentCleanup} from './helpers/closeout-fixture.mjs';
import {currentCloseoutEntries,directCloseoutObservation} from '../lib/closeout.mjs';
import {refreshCloseouts} from '../lib/closeout-consumer.mjs';
import {disposeStoppedAllocations} from '../lib/closeout-allocations.mjs';
import {fold} from '../lib/state.mjs';
import {gitProject} from '../lib/project.mjs';
import {runCloseoutTurn} from '../line-service/closeout-turn.mjs';

function older(t,kind){
  const f=setup(t,{direct:true,bound:true,merged:true});selectCurrentCleanup(f);
  const lane=f.lane+'-successor';f.git(['worktree','add','-qb','lane/successor',lane,f.head]);
  const shared=kind==='lane',meta=kind==='pane'?{pane:'w:p'}:{};
  f.append([{type:'run.started',id:'R-2',item:'ENG-1',workspace:shared?f.lane:lane,meta}]);
  f.report();const entry=currentCloseoutEntries(f.common,f.org,events(f))[0];
  const [prior]=f.append([{type:'closeout.evaluated',identity:f.common,key:entry.key,source:entry.source,
    run:'R-1',item:'ENG-1',revision:entry.source.seq,completed:false,condition:{kind:'safety-hold'},
    reason:'original report allocation/current run/claim changed; keep'}]);
  return{...f,entry,prior,successor:lane};
}

test('a late ingested older report closes only its separate original allocation while its successor works',t=>{
  const f=older(t),before=fs.readFileSync(f.eventFile);
  assert.equal(directCloseoutObservation(f.entry,f.prior,events(f)),true);
  // Exercise admission in the existing finite line turn, then its real closer.
  const result=runCloseoutTurn({project:gitProject(f.repo),org:f.org,env:f.env,guard:()=>{},measure:()=>{},
    cli:(_file,args)=>args[0]==='refresh'?'{}':JSON.stringify(f.drain({keys:JSON.parse(args[args.indexOf('--keys')+1]),retrySafe:true}))});
  assert.deepEqual(result.errors,[]);assert.equal(result.steps,1);
  assert.equal(fs.existsSync(f.lane),false);assert.ok(fs.existsSync(f.successor));
  assert.equal(f.git(['branch','--list','lane/topic']),'');
  assert.equal(fold(events(f)).runs.get('R-2').abandoned,null);
  assert.deepEqual(fs.readFileSync(f.eventFile).subarray(0,before.length),before);
});

for(const kind of ['lane','pane','claim','worker','UNKNOWN','refusal','HOLD'])test(`older allocation keeps ${kind}`,t=>{
  const f=older(t,kind);
  if(kind==='claim')f.append([{type:'run.claimed',run:'R-1',record:f.org,project:f.common,owner:{controller:'foreign',legacy:true}}]);
  if(kind==='worker')f.append([{type:'run.updated',id:'R-1',meta:{terminal_id:'replacement'}}]);
  if(kind==='UNKNOWN')f.append([{type:'closeout.effect',key:f.entry.key,identity:f.common,source:f.entry.source,effect:'original',
    producer:'native-closeout/v2',outcome:{action:'agent-exit-requested',pane:'w:p'}}]);
  if(kind==='refusal')f.append([{type:'closeout.evaluated',identity:f.common,key:f.entry.key,source:f.entry.source,run:'R-1',
    completed:false,reason:'EPERM native refusal',failure:{kind:'fence'}}]);
  if(kind==='HOLD')fs.mkdirSync(path.join(f.repo,'.lane/supervisor/HOLD'),{recursive:true});
  const before=fs.readFileSync(f.eventFile),calls=f.herdrCalls();
  f.drain({keys:[f.entry.key],retrySafe:true});
  assert.ok(fs.existsSync(f.lane));assert.deepEqual(f.read().actions,[]);
  assert.deepEqual(fs.readFileSync(f.eventFile).subarray(0,before.length),before);
  if(['UNKNOWN','refusal','claim','worker','lane','pane'].includes(kind))assert.deepEqual(f.herdrCalls(),calls);
});

test('finite refresh gives a finished unbound allocation its first physical target without fabricating a session',t=>{
  const f=setup(t,{direct:true,bound:true,merged:true});selectCurrentCleanup(f);
  fs.writeFileSync(f.eventFile,events(f).filter(e=>e.type!=='run.session_bound').map(e=>JSON.stringify(e)+'\n').join(''));
  f.state.agents=[];f.state.tabs=[];f.state.panes=[];f.save();f.report();
  const legacy=events(f);delete legacy.find(e=>e.type==='report.ingested').closeout_targets;
  fs.writeFileSync(f.eventFile,legacy.map(e=>JSON.stringify(e)+'\n').join(''));
  const before=fs.readFileSync(f.eventFile);
  const result=refreshCloseouts({cwd:f.repo,org:f.org,env:f.env,retirementOptions:f.options});
  assert.equal(result.created.length,1,JSON.stringify(result));
  const [entry]=currentCloseoutEntries(f.common,f.org,events(f));
  assert.deepEqual(entry.panes,[]);assert.equal(entry.reportCloseout,true);
  const row=f.drain({keys:[entry.key],retrySafe:true}).evaluated[0];
  assert.equal(row.completed,true,JSON.stringify(row));assert.equal(row.resources.session.completion,'UNKNOWN');
  assert.equal(fs.existsSync(f.lane),false);assert.equal(events(f).some(e=>e.type==='run.session_bound'),false);
  assert.deepEqual(fs.readFileSync(f.eventFile).subarray(0,before.length),before);
});

function stopped(t,{unprompted=false,session='session'}={}){
  const f=setup(t,{direct:true,bound:false,occupied:unprompted,merged:true});selectCurrentCleanup(f);
  const journal=path.join(f.org,'dispatch/attempt.json');fs.mkdirSync(path.dirname(journal),{recursive:true});
  const meta={lane:'topic',dispatch_journal:journal,dispatch_attempt:'attempt',dispatch_project:f.common,dispatch_record:f.org};
  const worker=unprompted?{agentName:'worker',pane:'w:p',workspaceId:'w',agentSessionId:session,terminalId:'term',cwd:f.lane}:null;
  if(unprompted&&!session){f.state.agents[0].agent_session=null;f.save();}
  fs.writeFileSync(f.eventFile,JSON.stringify({type:'item.added',id:'ENG-1',role:'engineer',seq:1,at:'2026-01-01T00:00:00Z'})+'\n');
  if(unprompted)f.append([{type:'run.started',id:'R-1',item:'ENG-1',workspace:f.lane,meta},
    {type:'run.claimed',run:'R-1',record:f.org,project:f.common,owner:{controller:'brain',legacy:false,release:{id:'source',root:process.cwd(),commit:null,identity:f.common}}},
    {type:'run.updated',id:'R-1',meta:{agent:worker.agentName,pane:worker.pane,worker_workspace:worker.workspaceId,terminal_id:worker.terminalId,agent_session_id:worker.agentSessionId}}]);
  const run=fold(events(f)).runs.get('R-1'),job={token:'attempt',repo:f.repo,common:f.common,org:f.org,lane:'topic',workspace:f.lane,base:f.head,
    item:'ENG-1',run:run?.id??null,stage:unprompted?'watch':'start',native_launch_attempted:unprompted,
    ...(run?{ownership:{owner:run.owner,generation:run.owner_generation},worker,launchProcess:{pid:2,identity:'native'}}:{}),
    error:unprompted?'watcher stopped before its receipt was recorded':'admission wait exhausted',
    failure:{code:unprompted?'OUTCOME_UNKNOWN':'DISPATCH_SESSION_CAP_LOCKED',kind:'unknown',stage:unprompted?'watch':'start',native_launch_attempted:unprompted}};
  const save=()=>fs.writeFileSync(journal,JSON.stringify(job)+'\n');
  const complete=()=>{save();f.append([{type:'dispatch.completed',project:f.common,journal,attempt:job.token,item:job.item,run:job.run,
    stage:job.stage,exit_code:1,native_launch_attempted:job.native_launch_attempted,failure:job.failure,
    request_sha256:createHash('sha256').update(fs.readFileSync(journal)).digest('hex')}]);};
  complete();
  return{...f,journal,job,saveJob:save,complete,dispose:()=>disposeStoppedAllocations({cwd:f.repo,org:f.org,env:f.env,retirementOptions:f.options})};
}

test('a completed pre-native capacity-lock failure releases its no-run folder once',t=>{
  const f=stopped(t),bytes=fs.readFileSync(f.journal);
  assert.equal(f.dispose().results[0].disposition,'removed');assert.equal(fs.existsSync(f.lane),false);
  assert.deepEqual(f.dispose().results,[]);assert.deepEqual(fs.readFileSync(f.journal),bytes);
});

test('a failed original dispatcher at watch abandons its verified unprompted worker and ordinary closeout finishes it',t=>{
  const f=stopped(t,{unprompted:true}),bytes=fs.readFileSync(f.journal),before=fs.readFileSync(f.eventFile);
  const result=f.dispose();assert.equal(result.results[0].disposition,'NOT_PROMPTED',JSON.stringify(result));
  const receipt=events(f).find(e=>e.type==='dispatch.allocation-finalized');assert.equal(receipt.native_completion,false);
  assert.equal(receipt.proof.process.identity,'native');assert.deepEqual(f.read().actions,[]);
  const [entry]=currentCloseoutEntries(f.common,f.org,events(f));
  const row=f.drain({keys:[entry.key],retrySafe:true}).evaluated[0];assert.equal(row.completed,true,JSON.stringify(row));
  assert.equal(fs.existsSync(f.lane),false);assert.deepEqual(fs.readFileSync(f.journal),bytes);
  assert.deepEqual(fs.readFileSync(f.eventFile).subarray(0,before.length),before);
});

// R-1347 shape: Codex has no native session until its first prompt, and the
// prompt-boundary guard refused delivery, so stage stays 'prompt'.
test('a never-prompted Codex worker without a native session is finalized once with its typed receipt',t=>{
  const f=stopped(t,{unprompted:true,session:null});
  Object.assign(f.job,{stage:'prompt',error:'dispatch launch input changed: item/ancestor G-1 is closed/held/reserved'});
  f.job.failure={code:'DISPATCH_INPUT_CHANGED',kind:'unknown',stage:'prompt',native_launch_attempted:true};f.complete();
  const result=f.dispose();assert.equal(result.results[0].disposition,'NOT_PROMPTED',JSON.stringify(result));
  const receipt=events(f).find(e=>e.type==='dispatch.allocation-finalized');assert.equal(receipt.proof.session,null);
  assert.ok(fold(events(f)).runs.get('R-1').abandoned);assert.deepEqual(f.dispose().results,[]);
});
test('a session-less unprompted worker that gained a native session is retained',t=>{
  const f=stopped(t,{unprompted:true,session:null});f.state.agents[0].agent_session={value:'later'};f.save();
  f.dispose();assert.equal(fold(events(f)).runs.get('R-1').abandoned,null);assert.ok(fs.existsSync(f.lane));
});
for(const kind of ['launch-UNKNOWN','prompting','binding','working','birth','dirty','refusal','claim','request-live','HOLD'])test(`unprompted finality retains ${kind}`,t=>{
  const f=stopped(t,{unprompted:true});
  if(kind==='launch-UNKNOWN'){f.job.stage='launching';delete f.job.worker;delete f.job.launchProcess;f.job.failure.stage='launching';f.complete();}
  if(kind==='prompting'){f.job.stage='prompting';f.job.failure.stage='prompting';f.complete();}
  if(kind==='binding'){f.job.sessionBinding={status:'observing'};f.complete();}
  if(kind==='working'){f.state.agents[0].agent_status='working';f.save();}
  if(kind==='birth'){f.state.info.process_tree[1].identity='replacement';f.save();}
  if(kind==='dirty')fs.writeFileSync(path.join(f.lane,'unsaved'),'keep');
  if(kind==='refusal'){f.job.error='EPERM native refusal';f.job.failure.kind='fence';f.complete();}
  if(kind==='claim')f.append([{type:'run.claimed',run:'R-1',record:f.org,project:f.common,owner:{controller:'foreign',legacy:true}}]);
  if(kind==='request-live')fs.writeFileSync(f.journal+'.lock',String(process.pid));
  if(kind==='HOLD')fs.mkdirSync(path.join(f.repo,'.lane/supervisor/HOLD'),{recursive:true});
  const before=fs.readFileSync(f.eventFile),bytes=fs.readFileSync(f.journal);
  if(kind==='HOLD')assert.throws(f.dispose,/STOP\/HOLD/);else f.dispose();
  assert.equal(fold(events(f)).runs.get('R-1').abandoned,null);assert.ok(fs.existsSync(f.lane));
  assert.deepEqual(f.read().actions,[]);assert.deepEqual(fs.readFileSync(f.journal),bytes);
  assert.deepEqual(fs.readFileSync(f.eventFile).subarray(0,before.length),before);
});
