import test from '../../test/helpers/bounded-test.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {transact,loadRecord} from '../../lib/store.mjs';
import {ownerIdentity} from '../../lib/process-owner.mjs';
import {herdrSocketPath} from '../../lanes/board/herdr-client.mjs';
import {sessionBindFact} from '../../test/helpers/session-bind.mjs';
import {gitProject} from '../../lib/project.mjs';
import {outstandingEffects,readOwnedRun} from '../../lib/run-owner.mjs';
import {registrationFile,stepFile,readWatchSubject} from '../shared.mjs';

import {fixture,reportText} from './step-fixture.mjs';
import {EventEmitter} from 'node:events';
import {createObserver} from '../observer.mjs';
import {enqueueSupervisor,readInbox} from '../../supervisor/prompt-supervisor.mjs';
function ok(f){const r=f.step();assert.equal(r.status,0,r.stderr||r.stdout);return r;}

test('finite watcher validates a working report without final delivery, then hands the stopped report off once',t=>{
  const f=fixture(t);fs.writeFileSync(f.report,reportText());ok(f);
  assert.equal(f.state().phase,'waiting');assert.equal(f.notices().length,0);assert.equal(loadRecord(f.org).events.filter(e=>e.type==='report.available').length,1);
  assert.ok(outstandingEffects(f.org,{...readOwnedRun(f.org,'R-1'),report:{}},gitProject(f.repo).identity).includes('watch:shared-pending'),'report ingestion alone cannot drop shared observation duty');
  f.setNative({...f.native,agent_status:'done',state_change_seq:2,completion_seq:2});ok(f);
  assert.equal(f.state().phase,'complete');assert.ok(!outstandingEffects(f.org,{...readOwnedRun(f.org,'R-1'),report:{}},gitProject(f.repo).identity).includes('watch:shared-pending'));assert.equal(f.notices().length,1);assert.match(f.notices()[0].text,/org-report/);
  const nativeCalls=fs.readFileSync(f.calls,'utf8');assert.doesNotMatch(nativeCalls,/"wait"/,'finite consumer never spawns a native wait process');
});

test('blocked, invalid, idle and resumed work retain their distinct notices and dedup across finite restarts',t=>{
  const f=fixture(t);ok(f);const oldCheckpoint=fs.readFileSync(stepFile(f.org,'R-1'));
  f.setNative({...f.native,agent_status:'blocked',state_change_seq:2});ok(f);
  fs.writeFileSync(stepFile(f.org,'R-1'),oldCheckpoint);ok(f);
  assert.equal(f.notices().length,1);assert.match(f.notices()[0].text,/watch-blocked/);
  fs.writeFileSync(f.report,'---\nrun: R-1\noutcome: invalid\n---');ok(f);assert.equal(f.notices().length,2);assert.match(f.notices()[1].text,/watch-invalid-report/);
  fs.unlinkSync(f.report);f.setNative({...f.native,agent_status:'idle',state_change_seq:3});ok(f);ok(f);assert.equal(f.notices().length,3);
  f.setNative({...f.native,agent_status:'working',state_change_seq:4});ok(f);
  f.setNative({...f.native,agent_status:'idle',state_change_seq:5});ok(f);assert.equal(f.notices().length,4);
});

test('startup and idle grace retain their original deadlines across finite consumers',t=>{
  const f=fixture(t,{startGrace:'60',idleGrace:'90'});f.setNative({...f.native,agent_status:'idle'});ok(f);
  const start=f.state();ok(f);assert.equal(f.state().state.armedAt,start.state.armedAt);assert.ok(f.state().next_at<=start.next_at+10);assert.equal(f.notices().length,0);
  f.setNative(f.native);ok(f);f.setNative({...f.native,agent_status:'idle',state_change_seq:3});ok(f);
  const idle=f.state();ok(f);assert.equal(f.state().state.idleGraceUntil,idle.state.idleGraceUntil);assert.equal(f.notices().length,0);
});

test('long-run notification is one original logical event across finite consumers',t=>{
  const f=fixture(t,{longAfter:'0'});ok(f);ok(f);assert.equal(f.notices().length,1);assert.match(f.notices()[0].text,/watch-long-running/);assert.equal(f.state().state.longNotified,true);
});

test('definite vanished worker preserves the no-report exception and exact native replacement stays unavailable',t=>{
  const f=fixture(t);f.setNative({...f.native,agent_status:'done',agent_session:{value:'replacement-session'}});fs.writeFileSync(f.report,reportText());ok(f);
  assert.equal(f.state().phase,'waiting');assert.equal(f.notices().length,0);assert.match(f.state().state.pendingUnavailable,/original native occupant changed/);
  fs.unlinkSync(f.report);f.setNative(null);ok(f);assert.equal(f.state().phase,'complete');ok(f);
  assert.ok(f.notices().some(n=>/state=gone/.test(n.text)));
});

test('changed claim stops the original finite duty before a notice and retains its registration',t=>{
  const f=fixture(t);ok(f);
  transact(f.org,()=>({add:[{type:'run.claimed',run:'R-1',record:f.org,project:gitProject(f.repo).identity,owner:{...loadRecord(f.org).state.runs.get('R-1').owner,controller:'other'}}]}));
  const r=f.step();assert.equal(r.status,1);assert.match(r.stderr,/RUN_OWNED_ELSEWHERE/);assert.equal(f.notices().length,0);assert.ok(fs.existsSync(registrationFile(f.org,'R-1')));
});

test('finite compact reads retain a late native session and reject conflicting binding facts',t=>{
  const f=fixture(t,{lateSession:true});
  const state=loadRecord(f.org).state,run=state.runs.get('R-1');
  const fact=sessionBindFact(run,state,{session:f.native.agent_session.value});
  transact(f.org,()=>({add:[fact]}));
  const subject=readWatchSubject(f.org,'R-1');assert.equal(subject.meta.agent_session_id,f.native.agent_session.value);assert.equal(subject.meta.identity_conflict,false);
  ok(f);
  transact(f.org,()=>({add:[{...fact,session:'conflicting-session'}]}));
  assert.equal(readWatchSubject(f.org,'R-1').meta.identity_conflict,true);
  const result=f.step();assert.equal(result.status,1);assert.match(result.stderr,/original record\/native worker binding changed/);assert.equal(f.state().phase,'failed');assert.equal(f.notices().length,0);
});

for(const existing of [false,true])test(`shared registration ${existing?'refuses a pre-existing per-run watcher':'uses the matching live host and preserves its original duty on retry'}`,t=>{
  const f=fixture(t),file=registrationFile(f.org,'R-1');fs.unlinkSync(file);
  const directory=path.join(f.org,'watch/observer');fs.mkdirSync(directory,{recursive:true});
  fs.writeFileSync(path.join(directory,'owner.json'),JSON.stringify({schema:'brain.run-observer-owner/v1',org:f.org,repo:f.repo,
    project:gitProject(f.repo).identity,source,socket:herdrSocketPath(),pid:process.pid,identity:ownerIdentity(process.pid),log:path.join(directory,'observations.jsonl')}));
  if(existing)transact(f.org,()=>({add:[{type:'run.updated',id:'R-1',meta:{watcher_pid:process.pid,watcher_identity:ownerIdentity(process.pid)}}]}));
  const r=f.register();
  if(existing){assert.equal(r.status,1);assert.match(r.stderr,/existing watcher\/receipt retained/);assert.equal(fs.existsSync(file),false);}
  else{
    assert.equal(r.status,0,r.stderr);const receipt=JSON.parse(r.stdout);assert.equal(receipt.pid,undefined);assert.equal(receipt.host.pid,process.pid);assert.equal(receipt.shared,file);
    const saved=fs.readFileSync(file),d=JSON.parse(saved);assert.equal(d.native.session,f.native.agent_session.value);assert.equal(d.consumer,'watch/watch.mjs --step');assert.equal(d.stuck_owner,'supervisor-test');assert.ok(!d.argv.includes('--shared'));
    const retry=f.register();assert.equal(retry.status,0,retry.stderr);assert.equal(fs.readFileSync(file).compare(saved),0);ok(f);assert.equal(f.state().phase,'waiting');
  }
});

for(const invalid of [false,true])test('correction vanished '+(invalid?'invalid':'missing')+' report completes without a held consumer or duplicate notice',async t=>{
  const f=fixture(t);f.setNative(null);if(invalid)fs.writeFileSync(f.report,'---\nrun: R-1\noutcome: invalid\n---');
  class Client extends EventEmitter{async snapshot(){return {protocol:22,agents:[],panes:[]};}subscribe(){}close(){}}
  const rows=[],observer=createObserver({repo:f.repo,org:f.org,client:new Client(),consume:()=>{const r=f.step();return {code:r.status};},log:r=>rows.push(r)});
  t.after(()=>observer.close());await observer.reconcile('startup');await observer.idle();
  assert.equal(f.state().phase,'complete');assert.equal(observer.counters.consumer_failures,0);
  assert.equal(fs.existsSync(path.join(observer.directory,'held/R-1.json')),false);
  assert.equal(f.notices().length,1);assert.match(f.notices()[0].text,invalid?/watch-invalid-report/:/state=gone/);
  await observer.reconcile('restart');await observer.idle();ok(f);assert.equal(f.notices().length,1);
  assert.ok(!outstandingEffects(f.org,{...readOwnedRun(f.org,'R-1'),abandoned:{}},gitProject(f.repo).identity).includes('watch:shared-pending'));
});

test('correction genuine native binding error stays failed and held with one owner exception',async t=>{
  const f=fixture(t,{lateSession:true}),state=loadRecord(f.org).state,run=state.runs.get('R-1');
  const fact=sessionBindFact(run,state,{session:f.native.agent_session.value});
  transact(f.org,()=>({add:[fact,{...fact,session:'changed-session'}]}));
  class Client extends EventEmitter{async snapshot(){return {protocol:22,agents:[f.native],panes:[]};}subscribe(){}close(){}}
  const observer=createObserver({repo:f.repo,org:f.org,client:new Client(),consume:()=>({code:f.step().status}),
    notify:(to,message,options)=>({...enqueueSupervisor(to,message,options),queued:true,delivered:false})});
  t.after(()=>observer.close());await observer.reconcile('startup');await observer.idle();
  assert.equal(f.state().phase,'failed');assert.equal(observer.counters.consumer_failures,1);
  const held=path.join(observer.directory,'held/R-1.json');assert.ok(fs.existsSync(held));
  const original=fs.readFileSync(held);await observer.reconcile('hint');await observer.idle();
  assert.deepEqual(fs.readFileSync(held),original);assert.equal(observer.counters.consumer_starts,1);
  assert.equal(readInbox(path.join(f.org,'supervisor/inbox.log')).length,1);assert.equal(f.notices().length,0);
});
