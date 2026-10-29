import test from './helpers/bounded-test.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
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
