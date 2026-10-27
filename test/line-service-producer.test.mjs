import test from './helpers/bounded-test.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { configFixture } from './helpers/config-home-fixture.mjs';
import { loadEvents,transact } from '../lib/store.mjs';
import { fold } from '../lib/state.mjs';
import { gitProject } from '../lib/project.mjs';
import { createLineService } from '../line-service/line-service.mjs';
import { developmentRoot,lineDirectory,establishCutover,serviceCutoff,postCutoffLanding } from '../line-service/cutoff.mjs';
import { recordLineNotice,canonicalFailure } from '../line-service/record-inbox.mjs';
import { enqueueNamedDecision } from '../line-service/decision-wake.mjs';
import { queueReviewMutation,validateQueuedReview } from '../line-service/review-queue.mjs';
import { recordMessages } from '../messages/operator-inbox.mjs';
import { readInbox,inboxPath } from '../supervisor/prompt-supervisor.mjs';
import { noticeLock } from '../supervisor/notice-lock.mjs';
import {morningDigest} from '../line-service/phase1.mjs';

function fixture(t,{cutoff=true,before=[]}={}) {
  const f=configFixture(t,{custom:true}),org=f.env.ORG_DIR,identity=gitProject(f.cwd).identity,directory=lineDirectory(org,identity);
  fs.mkdirSync(directory,{recursive:true});fs.writeFileSync(path.join(directory,'service.plist'),'<plist/>');
  fs.writeFileSync(path.join(directory,'installation.json'),JSON.stringify({at:'2026-10-26T20:00:00.000Z',repo:f.cwd,org,source:developmentRoot,node:process.execPath,file:path.join(directory,'service.plist'),target:`gui/${process.getuid()}/dev.herdr.line.${path.basename(directory)}`,phase:'installed'}));
  fs.writeFileSync(path.join(directory,'STOP'),'fixture stopped\n');
  const actor=structuredClone(f.observation.agents[0]),nativeEnv={...f.env,HERDR_BRAIN_ROOT:developmentRoot,HERDR_ENV:'1',HERDR_PANE_ID:actor.pane_id,HERDR_WORKSPACE_ID:actor.workspace_id,CODEX_THREAD_ID:actor.agent_session.value};
  const native=(_exe,args)=>{assert.deepEqual(args,['agent','get',actor.pane_id]);return JSON.stringify({result:{agent:actor}});};
  if(before.length)transact(org,()=>({add:before}));
  const cut=()=>establishCutover({repo:f.cwd,org,id:'producer-cutover',cutover:true,cwd:f.cwd,env:nativeEnv,call:native});
  const boundary=cutoff?cut():null;
  if(boundary)transact(org,()=>({add:[{...boundary.cutover,type:'line-service.phase0'}]}));
  fs.unlinkSync(path.join(directory,'STOP'));
  const env={...f.env,HERDR_BRAIN_ROOT:developmentRoot};for(const key of ['HERDR_ENV','HERDR_PANE_ID','HERDR_WORKSPACE_ID','CODEX_THREAD_ID'])delete env[key];
  const git=(args,cwd=f.cwd)=>{const r=spawnSync('git',['-C',cwd,...args],{env,encoding:'utf8'});assert.equal(r.status,0,r.stderr);return r.stdout.trim();};
  const events=()=>loadEvents(org).events, state=()=>fold(events()), messages=()=>recordMessages(events());
  const add=(items)=>transact(org,()=>({add:items}));
  const calls=[];
  const service=options=>createLineService({repo:f.cwd,org,to:'brain-chat',env,capacity:()=>({cap:7,count:0}),command:(_exe,args)=>{calls.push(args);return {status:0,stdout:'{"result":"fixture"}',stderr:''};},...options});
  const build=({historical=false,outcome='blocked'}={})=>{
    const base=boundary?.cutover.canonical_head??git(['rev-parse','HEAD']),workspace=path.join(f.scratch,'source-lane');git(['worktree','add','-qb','lane/producer',workspace]);
    let head=base;
    if(!historical){fs.writeFileSync(path.join(workspace,'new-code.mjs'),'export const value=1;\n');git(['add','new-code.mjs'],workspace);git(['commit','-qm','Actual new source'],workspace);head=git(['rev-parse','HEAD'],workspace);git(['merge','--ff-only',head]);}
    const dispatch=path.join(org,'dispatch','source.json');fs.mkdirSync(path.dirname(dispatch),{recursive:true});fs.writeFileSync(dispatch,JSON.stringify({token:'producer',stage:'complete',run:'R-1',item:'ENG-1',org,common:identity,workspace,base}));
    const file=path.join(org,'reports','R-1.md'),text=`---\nrun: R-1\noutcome: ${outcome}\nsummary: Bound source.\nartifacts:\n  - "Commit: ${head}"\n---\n`;fs.writeFileSync(file,text);
    add([{type:'item.added',id:'ENG-1',role:'engineer',title:'Source',meta:{}},{type:'run.started',id:'R-1',item:'ENG-1',workspace,meta:{lane:'producer',dispatch_journal:dispatch,dispatch_attempt:'producer'}},
      {type:'run.claimed',run:'R-1',record:org,project:identity,owner:{controller:'brain',legacy:false,release:{root:developmentRoot,id:'source',commit:null,identity:gitProject(developmentRoot).identity}}},
      {type:'report.ingested',run:'R-1',item:'ENG-1',file:'reports/R-1.md',sha256:createHash('sha256').update(text).digest('hex'),report:{outcome,summary:'Bound source',artifacts:[`Commit: ${head}`],blockers:[],extra:{}}}]);
    return {head,base,workspace};
  };
  return {...f,org,identity,directory,actor,nativeEnv,native,env,cut,boundary,git,events,state,messages,add,service,calls,build};
}

test('producer cutoff is explicit durable canonical evidence and survives restarts without reopening history',t=>{
  const f=fixture(t),cut=f.boundary.cutover;
  assert.equal(f.boundary.runtime_started,false);assert.equal(cut.canonical_head,f.git(['rev-parse','HEAD']));
  assert.throws(()=>postCutoffLanding({events:f.events(),repo:f.cwd,org:f.org,identity:f.identity,head:cut.canonical_head}),e=>e.code==='REVIEW_CUTOFF');
  const source=f.build();assert.equal(postCutoffLanding({events:f.events(),repo:f.cwd,org:f.org,identity:f.identity,head:source.head}).id,cut.id);
  fs.writeFileSync(path.join(f.directory,'STOP'),'fixture stopped');const again=f.cut();assert.equal(again.existing,true);assert.equal(again.cutover.seq,cut.seq);assert.equal(again.cutover.canonical_head,cut.canonical_head);
  assert.throws(()=>establishCutover({repo:f.cwd,org:f.org,id:'different-reset',cutover:true,cwd:f.cwd,env:f.nativeEnv,call:f.native}),/no implicit reset/);
  assert.equal(f.events().filter(e=>e.type==='line-service.cutover').length,1);
});

test('producer review creation and dispatch require actual post-cutoff landing while old READY builds remain independent',t=>{
  const f=fixture(t),source=f.build();
  const created=spawnSync(process.execPath,[path.join(developmentRoot,'bin/org.mjs'),'queue-review','R-1'],{cwd:f.cwd,env:{...f.env,ORG_ACTOR:'line-service'},encoding:'utf8'});assert.equal(created.status,0,created.stderr);
  const next=f.state(),review=next.items.get(JSON.parse(created.stdout).review_item);
  assert.equal(review.meta.review_cutover.id,f.boundary.cutover.id);
  assert.equal(validateQueuedReview({item:review,state:next,events:f.events(),repo:f.cwd,org:f.org}).head,source.head);
  const historical={...review,created:{...review.created,seq:f.boundary.cutover.seq},meta:{...review.meta,review_cutover:undefined}};
  assert.throws(()=>validateQueuedReview({item:historical,state:next,events:f.events(),repo:f.cwd,org:f.org}),/boundary differs/);
  f.add([{type:'item.added',id:'ENG-2',role:'engineer',title:'Existing ready build',meta:{}}]);
  // Current review remains retained; native capacity hold affects only this
  // fixture's action. A separate no-cutoff service still considers READY build.
  const g=fixture(t,{cutoff:false});g.build();
  const refused=spawnSync(process.execPath,[path.join(developmentRoot,'bin/org.mjs'),'queue-review','R-1'],{cwd:g.cwd,env:{...g.env,ORG_ACTOR:'line-service'},encoding:'utf8'});assert.notEqual(refused.status,0);assert.match(refused.stderr,/Phase0 source boundary/);
  g.add([{type:'item.added',id:'ENG-3',role:'engineer',title:'Authorized ready build',meta:{}}]);g.service().pass();
  assert.ok(g.calls.some(a=>a[1]==='ENG-3'));assert.equal(g.events().some(e=>e.role==='reviewer'),false);
});

test('producer old reported source skips cheaply while an unresolved manual review records one error without a native notice',t=>{
  const f=fixture(t,{before:[{type:'item.added',id:'REV-90',role:'reviewer',title:'Old manual review',meta:{}}]});f.build({historical:true});
  const before=f.events().length;f.service().pass();f.service().pass();
  assert.equal(f.calls.length,0);assert.equal(f.messages().length,1);assert.match(f.messages()[0].envelope.payload.service_notice.reason,/legacy\/manual.*UNKNOWN/);
  assert.ok(f.events().slice(before).filter(e=>e.type==='line-service.review-health').every(e=>e.owed===0));assert.equal(f.events().filter(e=>e.type==='line-service.review-error').length,1);assert.equal(morningDigest({events:f.events()}).review_errors.occurrences,2);
  assert.equal(fs.existsSync(inboxPath({org:f.org})),false);
});

test('producer routine failures use one service-role record envelope with stable counts across volatile occurrences and reload',t=>{
  const f=fixture(t);f.add([{type:'item.added',id:'ENG-1',role:'engineer',title:'Ready',meta:{}}]);
  let n=0;const capacity=()=>{n++;throw Object.assign(Error(`capacity PID ${100+n} at 2026-10-26T21:00:0${n}.000Z\n    at volatile.mjs:${n}:2`),{code:'DISPATCH_SESSION_CAP'});};
  f.service({capacity}).pass();f.service({capacity}).pass();f.service({capacity}).pass();
  assert.equal(f.messages().length,1);const envelope=f.messages()[0].envelope;
  assert.equal(envelope.sessionUid,undefined);assert.equal(envelope.incarnation,undefined);assert.equal(envelope.payload.from.role.name,'line-service');assert.equal(envelope.payload.kind,'fyi');
  assert.equal(fs.existsSync(inboxPath({org:f.org})),false);assert.equal(f.calls.length,0);
  const journal=JSON.parse(fs.readFileSync(path.join(f.directory,'effects.json'))),notices=Object.values(journal.record_notices);assert.equal(notices.length,1);assert.equal(notices[0].count,3);
  assert.equal(canonicalFailure('PID 1 at 2026-10-26T21:00:00.000Z\n at a.mjs:1'),canonicalFailure('pid 2 at 2026-10-26T22:00:00.000Z\n at b.mjs:99'));
});

test('producer lost record reply recovers the same immutable envelope without native fallback',t=>{
  const f=fixture(t);f.add([{type:'item.added',id:'ENG-1',role:'engineer',title:'Ready',meta:{}}]);let lost=true;
  const recordNotice=data=>{const result=recordLineNotice(data);if(lost){lost=false;throw Error('lost record acknowledgment');}return result;};
  const capacity=()=>{throw Object.assign(Error('same native capacity hold'),{code:'DISPATCH_SESSION_CAP'});};
  for(let n=0;n<4;n++)f.service({recordNotice,capacity}).pass();assert.equal(f.messages().length,1,'third occurrence sends, fourth resolves the deliberately lost reply');
  assert.equal(Object.values(JSON.parse(fs.readFileSync(path.join(f.directory,'effects.json'))).record_notices)[0].state,'recorded');assert.equal(fs.existsSync(inboxPath({org:f.org})),false);
});

test('useful error persistence records first errors immediately and batches repeated counters and large journal checkpoints by stage rather than hold count',t=>{
  const f=fixture(t),number=24;f.add(Array.from({length:number},(_,n)=>({type:'item.added',id:`REV-${n+1}`,role:'reviewer',title:'Retained manual review',meta:{}})));
  const journal=path.join(f.directory,'effects.json');fs.writeFileSync(journal,JSON.stringify({identity:f.identity,org:f.org,actions:{},notices:{},fixture_padding:'x'.repeat(10*1024*1024)}));
  const open=fs.openSync,close=fs.closeSync,flush=fs.fsyncSync,rename=fs.renameSync,handles=new Map();let fullWrites=0,recordCommits=0;
  fs.openSync=(file,...args)=>{const fd=open(file,...args);handles.set(fd,path.resolve(String(file)));return fd;};fs.closeSync=fd=>{handles.delete(fd);return close(fd);};fs.fsyncSync=fd=>{if(handles.get(fd)===path.join(f.org,'events.jsonl'))recordCommits++;return flush(fd);};fs.renameSync=(from,to)=>{if(path.resolve(String(to))===journal)fullWrites++;return rename(from,to);};
  try{
    f.service().pass();assert.ok(fullWrites<=5,`first pass used ${fullWrites} full writes for ${number} holds`);assert.ok(recordCommits<=number+3,`first notice and typed error share the same record mutation: ${recordCommits}`);assert.equal(f.events().filter(e=>e.type==='line-service.review-error').length,number);assert.equal(f.messages().length,number);
    fullWrites=0;recordCommits=0;f.service().pass();assert.ok(fullWrites<=5,`repeat pass used ${fullWrites} full writes`);assert.ok(recordCommits<=3,`repeat counters are one batch, not ${number} mutations: ${recordCommits}`);assert.equal(f.messages().length,number);assert.equal(morningDigest({events:f.events()}).review_errors.occurrences,number*2);
  }finally{fs.openSync=open;fs.closeSync=close;fs.fsyncSync=flush;fs.renameSync=rename;}
  assert.equal(f.calls.length,0);assert.equal(fs.existsSync(inboxPath({org:f.org})),false);assert.ok(Object.values(JSON.parse(fs.readFileSync(journal)).record_notices).every(n=>n.count===2&&n.state==='recorded'));
});

test('useful error persistence replays only durable notice deltas after a lost journal checkpoint without duplicate envelopes counters or native effects',t=>{
  const f=fixture(t);f.add([{type:'item.added',id:'REV-1',role:'reviewer',title:'Retained manual review',meta:{}}]);const journal=path.join(f.directory,'effects.json');f.service().pass();const checkpoint=fs.readFileSync(journal);f.service().pass();fs.writeFileSync(journal,checkpoint);f.service().pass();
  const notices=Object.values(JSON.parse(fs.readFileSync(journal)).record_notices);assert.equal(notices.length,1);assert.equal(notices[0].count,3);assert.equal(f.messages().length,1);const errors=f.events().filter(e=>e.type==='line-service.review-error'),repeats=f.events().filter(e=>e.type==='line-service.review-error-counts');assert.deepEqual(errors.map(e=>e.count),[1]);assert.deepEqual(repeats.map(e=>e.counts[errors[0].key]),[2,3]);assert.equal(new Set(repeats.map(e=>e.id)).size,2);assert.equal(morningDigest({events:f.events()}).review_errors.occurrences,3);assert.equal(f.calls.length,0);assert.equal(fs.existsSync(inboxPath({org:f.org})),false);
  // Replay validates the canonical key/boundary binding before merging audit counts.
  const log=path.join(f.directory,'passes.jsonl'),record={key:'a'.repeat(64),entry:{id:'line-record-'+ 'a'.repeat(64),count:4,first_at:'2026-10-27T01:00:00Z',last_at:'2026-10-27T01:00:01Z',boundary:'dispatch:REV-1',reason:'different reason',scope:{},review:true,state:'recording'}};fs.appendFileSync(log,JSON.stringify({action:'hold',notice_record:record})+'\n');assert.throws(()=>f.service().pass(),{message:'notice boundary/source is inconsistent'});assert.equal(f.messages().length,1);assert.equal(f.calls.length,0);assert.equal(fs.existsSync(inboxPath({org:f.org})),false);
});

test('producer only actual named pending reserved decisions enqueue once after durable intent and persistent decider rate limit',t=>{
  const f=fixture(t);f.add([{type:'item.added',id:'HUM-1',role:'human',title:'A real decision',meta:{operator_reserved:true,decider:'brain-chat'}},{type:'item.added',id:'HUM-2',role:'human',title:'Another decision',meta:{operator_reserved:true,decider:'brain-chat'}},{type:'item.added',id:'HUM-3',role:'human',title:'Ordinary error is not reserved',meta:{decider:'brain-chat'}}]);
  let clock='2026-10-26T22:00:00.000Z',wakes=0;
  const wakeDecision=args=>{const effects=JSON.parse(fs.readFileSync(path.join(f.directory,'effects.json')));assert.equal(effects.decisions[args.envelope.payload.refs[0].item].state,'intent');assert.ok(effects.decider_next['brain-chat']>Date.parse(clock));wakes++;
    return enqueueNamedDecision({...args,call:(_exe,nativeArgs)=>{assert.deepEqual(nativeArgs,['agent','get','brain-chat']);return JSON.stringify({result:{agent:{...f.actor,name:'brain-chat'}}});}});};
  f.service({wakeDecision,now:()=>clock}).pass();f.service({wakeDecision,now:()=>clock}).pass();assert.equal(wakes,1);assert.equal(readInbox(inboxPath({org:f.org})).length,1);
  clock='2026-10-26T22:01:01.000Z';f.service({wakeDecision,now:()=>clock}).pass();assert.equal(wakes,2);assert.equal(readInbox(inboxPath({org:f.org})).length,2);
  assert.equal(fs.existsSync(inboxPath({org:f.org})+'.owner.lock'),false);assert.equal(fs.existsSync(inboxPath({org:f.org})+'.drain.lock'),false);
});
