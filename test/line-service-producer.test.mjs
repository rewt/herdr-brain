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
  const env={...f.env,HERDR_BRAIN_ROOT:developmentRoot,MONITOR_SUPERVISOR_AGENT:'supervisor-fixture'};for(const key of ['HERDR_ENV','HERDR_PANE_ID','HERDR_WORKSPACE_ID','CODEX_THREAD_ID'])delete env[key];
  const git=(args,cwd=f.cwd)=>{const r=spawnSync('git',['-C',cwd,...args],{env,encoding:'utf8'});assert.equal(r.status,0,r.stderr);return r.stdout.trim();};
  const events=()=>loadEvents(org).events, state=()=>fold(events()), messages=()=>recordMessages(events());
  const add=(items)=>transact(org,()=>({add:items}));
  const diagnostics=()=>fs.readFileSync(path.join(directory,'passes.jsonl'),'utf8').trim().split('\n').map(JSON.parse);
  const calls=[],refreshes=[];
  const service=options=>createLineService({repo:f.cwd,org,to:'brain-chat',env,capacity:()=>({cap:7,count:0}),command:(_exe,args)=>{
    if(args[0]===path.join(developmentRoot,'supervisor/closeout.mjs')){
      assert.deepEqual(args.slice(0,6),[path.join(developmentRoot,'supervisor/closeout.mjs'),'refresh','--repo',f.cwd,'--org',org]);assert.equal(args[6],'--deadline');assert.ok(Number.isSafeInteger(Number(args[7])));
      refreshes.push(args);return {status:0,stdout:'{"created":[]}',stderr:''};
    }
    calls.push(args);return {status:0,stdout:'{"result":"fixture"}',stderr:''};
  },...options});
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
  return {...f,org,identity,directory,actor,nativeEnv,native,env,cut,boundary,git,events,state,messages,add,service,calls,refreshes,build,diagnostics};
}

// Contract answer: ENG-1330 / R-1828, answering
// R-1820:exception:producer-contract; .org/evidence/ENG-1330-R-1828/contract-answer.md.
// Warm negatives retain diagnoses; bound intake drains up to eight new
// inspection-due diagnostics per pass, independently of occurrence counters.
function producerPass(f,t,stage,types) {
  const before=f.events().length,journal=path.join(f.directory,'effects.json'),rename=fs.renameSync;let fullWrites=0;
  fs.renameSync=(from,to)=>{if(path.resolve(String(to))===journal)fullWrites++;return rename(from,to);};
  try{f.service().pass();}finally{fs.renameSync=rename;}
  const added=f.events().slice(before);
  t.diagnostic(JSON.stringify({stage,fullWrites,added:added.map(e=>e.type)}));
  assert.deepEqual(added.map(e=>e.type),types,'every pass addition has an explicit type');
  assert.ok(fullWrites<=5,`${stage} used ${fullWrites} full journal writes`);
  for(const event of added.filter(e=>e.type==='supervisor.exception-disposition')) {
    assert.equal(event.project,f.identity);assert.equal(event.org,f.org);
    assert.equal(event.disposition,'custodian');assert.equal(event.owner,'supervisor-fixture');
    assert.equal(event.handling_ack,false);assert.match(event.notice,/^line-diagnostic:/);
    const key=event.notice.slice('line-diagnostic:'.length),entry=JSON.parse(fs.readFileSync(journal)).record_notices[key];
    assert.equal(entry.inspection_due,true);assert.equal(event.evidence.incident.boundary,entry.boundary);
    assert.equal(f.events().filter(e=>e.type===event.type&&e.notice===event.notice).length,1,'one disposition per diagnostic');
  }
  assert.equal(f.events().filter(e=>/^line-service\.review-(error|health)$/.test(e.type)).length,0);
  assert.equal(f.messages().length,0);assert.equal(f.calls.length,0);
  assert.equal(fs.existsSync(inboxPath({org:f.org})),false);
  return added;
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

test('producer old reported source skips cheaply while an unresolved manual review stays diagnostic',t=>{
  const f=fixture(t,{before:[{type:'item.added',id:'REV-90',role:'reviewer',title:'Old manual review',meta:{}}]});f.build({historical:true});
  const before=f.events(),report=before.findLast(e=>e.type==='report.ingested');
  const added=producerPass(f,t,'historical-first',['closeout.binding-kept','supervisor.exception-disposition']);
  // Historical review intake stays idle, while independent cleanup records
  // the missing original session binding once without granting native effects.
  const kept=added[0];
  assert.equal(kept.type,'closeout.binding-kept');assert.equal(kept.identity,f.identity);
  assert.equal(kept.run,'R-1');assert.equal(kept.item,'ENG-1');assert.equal(kept.signal,'ready');assert.equal(kept.completed,false);
  assert.deepEqual(kept.source,{seq:report.seq,type:report.type});
  assert.equal(kept.condition.kind,'missing-identity');assert.equal(kept.condition.owner,'R-1');assert.equal(kept.condition.continuation.kind,'owner-evidence');
  for(const resource of ['session','folder','branch'])assert.equal(kept.resources[resource].status,'kept');
  producerPass(f,t,'historical-repeat',['supervisor.exception-disposition']);
  const after=f.events();producerPass(f,t,'historical-third',[]);
  assert.deepEqual(f.events(),after,'third unchanged pass appends no record event');
  assert.equal(f.refreshes.length,3,'cleanup refresh is independent of historical source and retained review');
  const diagnostics=f.diagnostics(),notices=diagnostics.filter(r=>r.notice_record);
  assert.equal(f.calls.length,0);assert.equal(f.messages().length,0);
  assert.equal(notices.filter(r=>/legacy\/manual.*UNKNOWN/.test(r.reason)).length,1,'warm cache retains the original manual-review diagnosis');
  assert.equal(notices.filter(r=>/unknown delivered source/.test(r.reason)).length,2,'the closeout binding changes the source input once; the next warm pass retains its diagnosis');
  assert.ok(diagnostics.filter(e=>e.action==='review-health').every(e=>e.health.owed===0));assert.equal(morningDigest({events:f.events(),diagnostics}).review_errors.occurrences,3);
  assert.equal(fs.existsSync(inboxPath({org:f.org})),false);
});

test('producer routine failures collapse in diagnostics with stable counts across volatile occurrences and reload',t=>{
  const f=fixture(t);f.add([{type:'item.added',id:'ENG-1',role:'engineer',title:'Ready',meta:{}}]);
  let n=0;const capacity=()=>{n++;throw Object.assign(Error(`capacity PID ${100+n} at 2026-10-26T21:00:0${n}.000Z\n    at volatile.mjs:${n}:2`),{code:'DISPATCH_SESSION_CAP'});};
  const counts=[];
  for(let pass=0;pass<3;pass++){
    f.service({capacity}).pass();
    counts.push(Object.values(JSON.parse(fs.readFileSync(path.join(f.directory,'effects.json'))).record_notices)[0].count);
  }
  assert.deepEqual(counts,[1,2,4],'the threshold pass also admits the independent halt repair');
  assert.equal(n,7,'three admission checks, three halt observations and one repair admission');
  assert.equal(f.diagnostics().filter(e=>e.action==='halt-capacity-held').length,3);
  assert.equal([...f.state().items.values()].filter(i=>i.meta.halt_repair===1).length,1);
  assert.equal(f.messages().length,0);assert.equal(f.diagnostics().filter(e=>e.inspection_due).length,1);
  assert.equal(fs.existsSync(inboxPath({org:f.org})),false);assert.equal(f.calls.length,0);
  const journal=JSON.parse(fs.readFileSync(path.join(f.directory,'effects.json'))),notices=Object.values(journal.record_notices);assert.equal(notices.length,1);assert.equal(notices[0].count,4);
  assert.equal(canonicalFailure('PID 1 at 2026-10-26T21:00:00.000Z\n at a.mjs:1'),canonicalFailure('pid 2 at 2026-10-26T22:00:00.000Z\n at b.mjs:99'));
});

test('producer reserved decision lost record reply deduplicates its immutable envelope without native fallback',t=>{
  const f=fixture(t);f.add([{type:'item.added',id:'HUM-1',role:'human',title:'Actual decision',meta:{operator_reserved:true,decider:'brain-chat'}}]);
  const input={repo:f.cwd,org:f.org,id:'decision-lost-reply',boundary:'decision:HUM-1',reason:'actual decision',scope:{item:'HUM-1'},first_at:'2026-10-27T01:00:00Z',audit:path.join(f.directory,'passes.jsonl'),counts:'diagnostic-only',env:f.env,kind:'question',question:'HUM-1'};
  const release=noticeLock(path.join(f.directory,'pass.lock'));
  try{const first=recordLineNotice(input),bytes=fs.readFileSync(path.join(f.org,'events.jsonl'));assert.deepEqual(recordLineNotice(input).envelope,first.envelope);assert.deepEqual(fs.readFileSync(path.join(f.org,'events.jsonl')),bytes);assert.equal(f.messages().length,1);assert.throws(()=>recordLineNotice({...input,kind:'fyi',question:undefined}),/diagnostics/);}finally{release();}
  assert.equal(fs.existsSync(inboxPath({org:f.org})),false);
});

test('useful error persistence keeps first errors and repeat counters off the record and checkpoints by stage',t=>{
  const f=fixture(t),number=24;f.add(Array.from({length:number},(_,n)=>({type:'item.added',id:`REV-${n+1}`,role:'reviewer',title:'Retained manual review',meta:{}})));
  const journal=path.join(f.directory,'effects.json');fs.writeFileSync(journal,JSON.stringify({identity:f.identity,org:f.org,actions:{},notices:{},fixture_padding:'x'.repeat(10*1024*1024)}));
  const open=fs.openSync,close=fs.closeSync,flush=fs.fsyncSync,handles=new Map(),yielded=[];let recordCommits=0;
  fs.openSync=(file,...args)=>{const fd=open(file,...args);handles.set(fd,path.resolve(String(file)));return fd;};
  fs.closeSync=fd=>{handles.delete(fd);return close(fd);};
  fs.fsyncSync=fd=>{
    const file=handles.get(fd);if(file===path.join(f.org,'events.jsonl'))recordCommits++;
    const result=flush(fd);
    if(file&&path.dirname(file)===path.join(f.directory,'command-receipts')) {
      const receipt=JSON.parse(fs.readFileSync(file));
      if(receipt.intent.exe==='line-operation'&&receipt.intent.args[0]==='exception-intake') {
        yielded.push({intent:receipt.intent,journal:JSON.parse(fs.readFileSync(journal))});
      }
    }
    return result;
  };
  try{
    producerPass(f,t,'persistence-first',[]);assert.equal(recordCommits,0,'cold diagnostics do not append review events');
    // The custodian drains the 24 first-pass diagnoses in three batches of eight.
    // Unfinished intake is work even when evaluation inputs have not changed.
    for(let batch=0;batch<3;batch++) {
      recordCommits=0;producerPass(f,t,`persistence-drain-${batch+1}`,Array(8).fill('supervisor.exception-disposition'));
      assert.equal(recordCommits,1,'one record transaction for each bounded intake batch');
    }
    recordCommits=0;producerPass(f,t,'persistence-drained',[]);assert.equal(recordCommits,0,'drained warm repeats append nothing');
    assert.equal(morningDigest({events:f.events(),diagnostics:f.diagnostics()}).review_errors.occurrences,number);
  }finally{fs.openSync=open;fs.closeSync=close;fs.fsyncSync=flush;}
  const final=JSON.parse(fs.readFileSync(journal));
  assert.equal(Object.keys(final.record_notices).length,number);
  assert.ok(Object.values(final.record_notices).every(n=>n.count===1&&n.state==='diagnostic-only'));
  assert.equal(yielded.length,5,'each pass actually completed the observation-only intake yield');
  for(const {intent,journal:saved}of yielded) {
    assert.equal(intent.key,'exception-intake');assert.deepEqual(saved.actions,{},'observation yield has no linked action');
    assert.equal(saved.review_health.pass_id,`${f.directory}:${saved.pass_number}`,'dirty health observation persisted before reload');
    assert.equal(saved.ordinary_admission.schema,'ordinary-admission-pass/v1');
    assert.deepEqual(saved.review_progress,{});
  }
  const saved=yielded.at(-1).journal;
  assert.deepEqual(final.review_health,saved.review_health,'dirty observation survives the yield and disk reload');
  assert.deepEqual(final.ordinary_admission,saved.ordinary_admission);
  assert.deepEqual(final.review_progress,saved.review_progress);
});

test('useful error persistence replays only durable notice deltas after a lost journal checkpoint without duplicate envelopes counters or native effects',t=>{
  const f=fixture(t);f.add([{type:'item.added',id:'REV-1',role:'reviewer',title:'Retained manual review',meta:{}}]);
  const journal=path.join(f.directory,'effects.json');
  producerPass(f,t,'replay-first',[]);const checkpoint=fs.readFileSync(journal);
  producerPass(f,t,'replay-repeat',['supervisor.exception-disposition']);
  fs.writeFileSync(journal,checkpoint);producerPass(f,t,'replay-third',[]);
  let notices=Object.values(JSON.parse(fs.readFileSync(journal)).record_notices);
  assert.equal(notices.length,1);assert.equal(notices[0].count,1,'warm negatives produce no synthetic occurrence');
  assert.equal(morningDigest({events:f.events(),diagnostics:f.diagnostics()}).review_errors.occurrences,1);
  assert.equal(f.diagnostics().findLast(r=>r.health).health.gap_passes,0);
  // A real subject revision invalidates its negative and creates a durable delta.
  f.add([{type:'note.added',id:'REV-1',text:'Relevant review input changed',decision:false}]);
  producerPass(f,t,'replay-invalidated',[]);
  const current=JSON.parse(fs.readFileSync(journal)),old=JSON.parse(checkpoint);
  assert.equal(Object.values(current.record_notices)[0].count,2);
  // Lose the notice checkpoint while retaining the newly evaluated cache input:
  // the fsynced audit must restore the delta without evaluating it a second time.
  current.record_notices=old.record_notices;current.notice_audit_offset=old.notice_audit_offset;
  fs.writeFileSync(journal,JSON.stringify(current));producerPass(f,t,'replay-durable-delta',[]);
  notices=Object.values(JSON.parse(fs.readFileSync(journal)).record_notices);
  assert.equal(notices.length,1);assert.equal(notices[0].count,2);
  assert.equal(morningDigest({events:f.events(),diagnostics:f.diagnostics()}).review_errors.occurrences,2);
  assert.ok(f.diagnostics().findLast(r=>r.action==='pass-complete').timing.notice_audit_replayed>0);
  // Replay validates the canonical key/boundary binding before merging audit counts.
  const log=path.join(f.directory,'passes.jsonl'),record={key:'a'.repeat(64),entry:{id:'line-record-'+ 'a'.repeat(64),count:4,first_at:'2026-10-27T01:00:00Z',last_at:'2026-10-27T01:00:01Z',boundary:'dispatch:REV-1',reason:'different reason',scope:{},review:true,state:'recording'}};
  fs.appendFileSync(log,JSON.stringify({action:'hold',notice_record:record})+'\n');
  const before=f.events();assert.throws(()=>f.service().pass(),{message:'notice boundary/source is inconsistent'});
  assert.deepEqual(f.events(),before);assert.equal(f.messages().length,0);assert.equal(f.calls.length,0);assert.equal(fs.existsSync(inboxPath({org:f.org})),false);
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
