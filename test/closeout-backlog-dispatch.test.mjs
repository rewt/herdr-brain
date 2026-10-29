import test from './helpers/bounded-test.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {setup,events,selectCurrentCleanup} from './helpers/closeout-fixture.mjs';
import {gitProject} from '../lib/project.mjs';
import {fold} from '../lib/state.mjs';
import {reconcileCloseoutBacklog} from '../lib/closeout-backlog.mjs';
import {currentCloseoutEntries} from '../lib/closeout.mjs';
import {closeoutWaitId,closeoutWaitState} from '../lib/closeout-status.mjs';
import {obsoleteOutcomeDecision} from '../line-service/outcome-decision.mjs';
import {createLineService} from '../line-service/line-service.mjs';

test('held closeout classification preserves its queued resolver and the line open-unknown count',t=>{
  const f=setup(t,{direct:true,bound:true});selectCurrentCleanup(f);f.report();
  const entry=currentCloseoutEntries(f.common,f.org,events(f))[0];
  const [evaluation]=f.append([{type:'closeout.evaluated',identity:f.common,key:entry.key,source:entry.source,
    run:entry.run,item:entry.item,revision:entry.source.seq,completed:false,
    reason:'original native refusal; owner evidence required',failure:{kind:'fence',code:'EPERM'}}]);
  const [wait]=f.append([{type:'closeout.waiting',identity:f.common,key:entry.key,source:entry.source,
    run:entry.run,item:entry.item,revision:evaluation.revision,wait_id:closeoutWaitId(entry,evaluation),
    waiting:{owner:'line-service',defect:'Recorded native refusal has stopped this effect',producers:[]}}]);
  f.append([{type:'item.added',id:'DEC-1',role:'decision',title:'Resolve the original cleanup refusal',
    meta:{queue_selected:true,route:'unblock',uncertain_outcome:{check:{key:`closeout:${entry.key}`,
      subject:{key:entry.key,source:entry.source,item:entry.item}}}}}]);
  const before=events(f),bytes=fs.readFileSync(f.eventFile),calls=f.herdrCalls(),gitCalls=f.gitCalls(),actions=f.read().actions;
  const rows=reconcileCloseoutBacklog({project:gitProject(f.repo),org:f.org,events:before,guard:()=>{}});
  assert.equal(rows.length,1);const [held]=rows;assert.equal(held.disposition,'held');
  const all=events(f),item=fold(all).items.get('DEC-1'),view={events:all,entries:[entry],evaluations:new Map([[entry.key,evaluation]])};
  assert.equal(closeoutWaitState(wait,all),'defect');assert.equal(obsoleteOutcomeDecision(item,view),null);
  // Only settled/owned-stage dispositions may suppress the old defect. Latest
  // matching evidence wins, including when a continuation becomes held again.
  const evaluated={...held,disposition:'evaluated'},continuation={...held,disposition:'continuation',continuation:{kind:'owned-stage'}};
  for(const classified of [evaluated,continuation]){
    const events=[...all,classified];assert.equal(closeoutWaitState(wait,events),'classified');
    assert.match(obsoleteOutcomeDecision(item,{...view,events}),/no current defect or failure/);
    assert.equal(closeoutWaitState(wait,[...events,held]),'defect');
  }
  assert.equal(closeoutWaitState(wait,[...all,{...held,disposition:'continuation'}]),'defect','an owner-evidence continuation is still held');
  const commands=[],service=createLineService({repo:f.repo,org:f.org,to:'supervisor-test',env:f.env,
    maxStarts:0,haltAfter:100,closeoutMeasure:()=>{},recordNotice:d=>({id:d.id,state:'record-only'}),
    command:(exe,args)=>{commands.push({exe,args});return{status:0,stdout:'{"created":[]}',stderr:''};}});
  assert.equal(service.pass().result,'pass-complete');
  const log=fs.readFileSync(path.join(service.directory,'passes.jsonl'),'utf8').trim().split('\n').map(JSON.parse);
  const pass=log.findLast(e=>e.action==='pass-complete');
  assert.equal(pass.unknown_open,1);assert.equal(pass.unknown_settled,0);assert.equal(pass.classified_retained,0);
  assert.equal(pass.starts,0);assert.ok(commands.every(({exe,args})=>exe===process.execPath&&args[0].endsWith('/supervisor/closeout.mjs')&&args[1]==='refresh'),JSON.stringify(commands));
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(service.directory,'closeout-turn.json'),'utf8')).errors,[]);
  assert.deepEqual(fs.readFileSync(f.eventFile).subarray(0,bytes.length),bytes,'all original rows remain byte-identical');
  assert.deepEqual(events(f).slice(0,before.length),before);
  assert.deepEqual(f.herdrCalls(),calls);assert.deepEqual(f.gitCalls(),gitCalls);assert.deepEqual(f.read().actions,actions);
  assert.equal(events(f).slice(before.length).some(e=>['closeout.effect','run.started','run.abandoned','run.session_bound'].includes(e.type)),false);
});

test('unreported backlog retains the exact original dispatch error and missing SID without finalizing or rebinding',t=>{
  const f=setup(t,{direct:true,bound:true});selectCurrentCleanup(f);
  const run=events(f).find(e=>e.type==='run.started'),token='original',journal=path.join(f.org,'dispatch',token+'.json');
  // The bound fixture has a later worker metadata event. Use the real fold's
  // update path so that event cannot overwrite this case's original journal.
  f.append([{type:'run.updated',id:run.id,meta:{dispatch_project:f.common,dispatch_attempt:token,dispatch_journal:journal}}]);
  const saved=fold(events(f)).runs.get(run.id);
  fs.mkdirSync(path.dirname(journal),{recursive:true});
  const job={token,run:run.id,repo:f.repo,org:f.org,common:f.common,ownership:{generation:saved.owner_generation,owner:saved.owner},stage:'watch',
    worker:{agentSessionId:null},native_launch_attempted:true,error:'original watcher exited during startup',failure:{kind:'unknown',code:'OUTCOME_UNKNOWN'}};
  fs.writeFileSync(journal,JSON.stringify(job)+'\n');const bytes=fs.readFileSync(journal),before=events(f),calls=f.herdrCalls();
  const args={project:gitProject(f.repo),org:f.org,events:before,guard:()=>{}};
  const rows=reconcileCloseoutBacklog(args);assert.equal(rows.length,1);
  assert.equal(rows[0].disposition,'dispatch-error-unreported');assert.equal(rows[0].dispatch.native_session_bound,false);
  assert.equal(rows[0].dispatch.error,job.error);assert.equal(rows[0].dispatch.failure.kind,'unknown');
  assert.deepEqual(fs.readFileSync(journal),bytes);assert.deepEqual(f.herdrCalls(),calls);assert.deepEqual(f.read().actions,[]);
  assert.equal(events(f).slice(before.length).some(e=>e.type==='run.abandoned'||e.type==='run.session_bound'),false);
  assert.deepEqual(events(f).slice(0,before.length),before);assert.deepEqual(reconcileCloseoutBacklog({...args,events:events(f)}),[]);
});

function allocationFixture(t,{alias=false}={}) {
  const f=setup(t,{direct:true,bound:true}),run=fold(events(f)).runs.get('R-1');
  const org=alias?path.join(f.scratch,'record-alias'):f.org;
  if(alias)fs.symlinkSync(f.org,org);
  const token='allocation',journal=path.join(org,'dispatch',token+'.json');
  f.append([{type:'run.updated',id:run.id,meta:{dispatch_project:f.common,dispatch_attempt:token,dispatch_journal:journal}}]);
  fs.mkdirSync(path.dirname(journal),{recursive:true});
  const job={token,run:run.id,repo:f.repo,org:f.org,common:f.common,
    ownership:{generation:run.owner_generation,owner:run.owner},stage:'launch',native_launch_attempted:false};
  const save=()=>fs.writeFileSync(journal,JSON.stringify(job)+'\n');save();
  const before=fs.readFileSync(f.eventFile),calls=f.herdrCalls(),gitCalls=f.gitCalls(),actions=f.read().actions;
  const reconcile=(observation=events(f))=>reconcileCloseoutBacklog({project:gitProject(f.repo),org,events:observation,guard:()=>{}});
  const preserved=()=>{
    assert.deepEqual(fs.readFileSync(f.eventFile).subarray(0,before.length),before);
    assert.deepEqual(f.herdrCalls(),calls);assert.deepEqual(f.gitCalls(),gitCalls);assert.deepEqual(f.read().actions,actions);
    const added=fs.readFileSync(f.eventFile).subarray(before.length).toString().trim().split('\n').filter(Boolean).map(JSON.parse);
    assert.ok(added.every(e=>e.type==='closeout.allocation-kept'),'classification issues no native, Git, completion or allocation effects');
  };
  return{f,job,journal,save,reconcile,preserved};
}

test('allocation backlog ignores healthy journal churn at planning and commit while retaining changed errors',t=>{
  const {f,job,journal,save,reconcile,preserved}=allocationFixture(t),stale=events(f);
  const [first]=reconcile();assert.equal(first.disposition,'active-unreported');
  for(const stage of ['started','prompted','watch']){
    Object.assign(job,{stage,native_launch_attempted:true,worker:{agentSessionId:'original-session'},sessionBinding:{status:'bound'},updated_at:stage});save();
    assert.notEqual(createHash('sha256').update(fs.readFileSync(journal)).digest('hex'),first.dispatch.sha256);
    assert.deepEqual(reconcile(),[],'latest observed allocation ignores healthy progress');
    assert.deepEqual(reconcile(stale),[],'commit filter also ignores healthy progress from stale observations');
  }
  Object.assign(job,{error:'original watcher failed',failure:{kind:'unknown',code:'OUTCOME_UNKNOWN'}});save();
  const [failed]=reconcile();assert.equal(failed.disposition,'dispatch-error-unreported');assert.equal(failed.dispatch.error,job.error);
  job.failure={kind:'fence',code:'EPERM'};save();assert.equal(reconcile()[0].dispatch.failure.code,'EPERM');
  delete job.error;delete job.failure;save();assert.equal(reconcile()[0].disposition,'active-unreported','return to active must replace latest error classification');
  job.error='original watcher failed';job.failure={kind:'unknown',code:'OUTCOME_UNKNOWN'};save();
  assert.equal(reconcile()[0].dispatch.error,job.error,'recurring error must not be hidden by its historical match');
  assert.deepEqual(reconcile(),[]);preserved();
});

test('allocation backlog preserves original dispatch evidence through a symlinked org ancestor',t=>{
  const {job,journal,save,reconcile,preserved}=allocationFixture(t,{alias:true});
  Object.assign(job,{error:'original watcher failed',failure:{kind:'unknown',code:'OUTCOME_UNKNOWN'},worker:{agentSessionId:null}});save();
  assert.notEqual(fs.realpathSync(journal),journal);
  const bytes=fs.readFileSync(journal),[row]=reconcile();
  assert.equal(row.disposition,'dispatch-error-unreported');assert.equal(row.dispatch.evidence_error,undefined);
  assert.equal(row.dispatch.journal,journal);assert.equal(row.dispatch.error,job.error);assert.deepEqual(row.dispatch.failure,job.failure);
  assert.equal(row.dispatch.native_session_bound,false);assert.equal(row.dispatch.sha256,createHash('sha256').update(bytes).digest('hex'));
  assert.deepEqual(fs.readFileSync(journal),bytes);assert.deepEqual(reconcile(),[]);preserved();
});

test('allocation backlog rejects redirected journals and foreign dispatch bindings under an org alias',t=>{
  const {f,job,journal,save,reconcile,preserved}=allocationFixture(t,{alias:true});
  assert.equal(reconcile()[0].dispatch.evidence_error,undefined);
  const reject=pattern=>{const [row]=reconcile();assert.match(row.dispatch.evidence_error,pattern);assert.equal(row.dispatch.sha256,undefined);};
  const restore=()=>{save();assert.equal(reconcile()[0].dispatch.evidence_error,undefined);};
  const redirected=path.join(f.scratch,'redirected.json');fs.copyFileSync(journal,redirected);
  fs.unlinkSync(journal);fs.symlinkSync(redirected,journal);reject(/foreign or redirected/);
  fs.unlinkSync(journal);restore();
  const dispatch=path.dirname(journal),foreign=path.join(f.scratch,'foreign-dispatch');
  fs.renameSync(dispatch,foreign);fs.symlinkSync(foreign,dispatch);reject(/foreign or redirected/);
  fs.unlinkSync(dispatch);fs.renameSync(foreign,dispatch);restore();
  for(const field of ['run','common','repo','org','token','ownership']){
    const original=job[field];job[field]=field==='ownership'?{...original,generation:original.generation+1}:field==='org'?f.scratch:'foreign';save();
    reject(/original dispatch\/run\/project\/claim differs/);job[field]=original;restore();
  }
  assert.deepEqual(reconcile(),[]);preserved();
});
