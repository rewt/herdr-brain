// Phase1 controls are written before the implementation. No live native/model
// effects: disposable Git/record fixtures, bounded owned children and adapters.
import test from './helpers/bounded-test.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {configFixture} from './helpers/config-home-fixture.mjs';
import {loadEvents,transact} from '../lib/store.mjs';
import {fold} from '../lib/state.mjs';
import {gitProject} from '../lib/project.mjs';
import {createLineService,sourceRoot,serviceDirectory} from '../line-service/line-service.mjs';
import {discoverChanges,blockedChangeKey,reviewResultEvents,morningDigest,recordReviewResults,canonicalReviewIndex,reviewHealth,ensureReviewBoundary,phase0Boundary} from '../line-service/phase1.mjs';
import {reviewAttempt,selectedReviewConsumer} from '../line-service/review.mjs';
import {queueReviewMutation,reviewQueueRoute,validateQueuedReview} from '../line-service/review-queue.mjs';
import {ROUTE_PRESET} from '../lanes/preset.mjs';
import {countSessions,checkSessionCap} from '../dispatch/session-cap.mjs';
import {closeoutCodeIdentity,bindCloseoutCode} from '../lib/closeout-code.mjs';
import {kickCloseout,bindCloseoutSources,publishCloseoutEvents,CLOSEOUT_EXIT_PENDING} from '../lib/closeout.mjs';
import {safeCloseoutRetry} from '../lib/closeout.mjs';
import {establishCutover,developmentRoot} from '../line-service/cutoff.mjs';
import {recordOwnLanding} from '../lib/landing-receipt.mjs';
import {noticeLock} from '../supervisor/notice-lock.mjs';
import {readReport} from '../lib/report.mjs';
import {recoverInactiveReview} from '../line-service/review-recovery.mjs';
import {claimedCommitTokens} from '../settle/review-range.mjs';

const hash=b=>createHash('sha256').update(b).digest('hex');
function fixture(t,{reported=true}={}){
  const f=configFixture(t,{custom:true}),org=f.env.ORG_DIR,identity=gitProject(f.cwd).identity,base=f.git('rev-parse','HEAD');
  const directory=serviceDirectory(org,identity),workspace=path.join(f.scratch,'source-lane');
  f.git('worktree','add','-qb','lane/source',workspace);
  const git=(args,cwd=workspace)=>{const r=spawnSync('git',['-C',cwd,...args],{env:f.env,encoding:'utf8'});assert.equal(r.status,0,r.stderr);return r.stdout.trim();};
  const heads=[];for(const n of [1,2]){fs.writeFileSync(path.join(workspace,`source-${n}`),String(n));git(['add','.']);git(['commit','-qm',`Build change ${n}`]);heads.push(git(['rev-parse','HEAD']));}
  f.git('merge','--ff-only',heads[1]);
  const dispatch=path.join(org,'dispatch/source.json');fs.mkdirSync(path.dirname(dispatch),{recursive:true});
  fs.writeFileSync(dispatch,JSON.stringify({token:'source',stage:'complete',run:'R-1',item:'ENG-1',org,common:identity,workspace,base}));
  const report=`---\nrun: R-1\noutcome: done\nsummary: Actual committed build.\nartifacts:\n${heads.map(h=>`  - "Commit: ${h}"`).join('\n')}\n---\n`,file=path.join(org,'reports/R-1.md');fs.writeFileSync(file,report);
  const events=[{type:'line-service.cutover',id:'old-service',project:identity,repo:f.cwd,org,source:sourceRoot,main:'main',canonical_head:base},
    {type:'line-service.phase0',id:'phase0',project:identity,repo:f.cwd,org,source:sourceRoot,main:'main',canonical_head:base,cutoff_at:'2026-10-26T23:55:00.000Z'},
    {type:'item.added',id:'ENG-1',title:'Build',role:'engineer'},
    {type:'run.started',id:'R-1',item:'ENG-1',workspace,report_path:path.join(org,'runs/R-1/report.md'),meta:{lane:'source',dispatch_project:identity,dispatch_journal:dispatch,dispatch_attempt:'source'}},
    {type:'run.claimed',run:'R-1',record:org,project:identity,owner:{controller:'brain',legacy:false,release:{id:'source',root:sourceRoot,commit:null,identity:gitProject(sourceRoot).identity}}}];
  if(reported)events.push({type:'report.ingested',run:'R-1',item:'ENG-1',file:'reports/R-1.md',sha256:hash(report),report:{run:'R-1',outcome:'done',summary:'Actual source',artifacts:heads.map(h=>`Commit: ${h}`),extra:{},blockers:[],proposals:[]}});
  transact(org,()=>({add:events}));
  const context=()=>{const events=loadEvents(org).events,state=fold(events);return {events,state,org,repo:f.cwd,identity,item:state.items.get('ENG-1'),run:state.runs.get('R-1')};};
  const add=rows=>transact(org,()=>({add:rows}));
  return {...f,org,identity,base,heads,workspace,directory,report,file,git,context,add};
}

function independentProducer(f){
  fs.writeFileSync(path.join(f.cwd,'independent-source'),'separate owner');f.git(['add','.'],f.cwd);f.git(['commit','-qm','Independent source'],f.cwd);const head=f.git(['rev-parse','HEAD'],f.cwd),dispatch=path.join(f.org,'dispatch/independent.json');
  fs.writeFileSync(dispatch,JSON.stringify({token:'independent',stage:'complete',run:'R-3',item:'ENG-2',org:f.org,common:f.identity,workspace:f.cwd,base:f.heads[1]}));
  const report=`---\nrun: R-3\noutcome: done\nsummary: Independent source.\nartifacts:\n  - "Commit: ${head}"\n---\n`;fs.writeFileSync(path.join(f.org,'reports/R-3.md'),report);
  f.add([{type:'item.added',id:'ENG-2',title:'Independent',role:'engineer'},{type:'run.started',id:'R-3',item:'ENG-2',workspace:f.cwd,meta:{dispatch_journal:dispatch,dispatch_attempt:'independent',dispatch_project:f.identity}},
    {type:'run.claimed',run:'R-3',record:f.org,project:f.identity,owner:f.context().run.owner},
    {type:'report.ingested',run:'R-3',file:'reports/R-3.md',sha256:hash(report),report:{outcome:'done',artifacts:[`Commit: ${head}`],extra:{},blockers:[],proposals:[]}}]);return head;
}

function installedService(f){
  fs.mkdirSync(f.directory,{recursive:true});fs.writeFileSync(path.join(f.directory,'installation.json'),JSON.stringify({at:'2026-10-27T00:00:00Z',repo:f.cwd,org:f.org,source:sourceRoot,node:process.execPath,file:path.join(f.directory,'service.plist'),target:`gui/${process.getuid()}/dev.herdr.line.${path.basename(f.directory)}`}));
  const env={...f.env};for(const k of ['HERDR_ENV','HERDR_PANE_ID','CODEX_THREAD_ID'])delete env[k];return env;
}

function recoveryFixture(t,{verdict,kind='never-created'}={}){
  const f=fixture(t),a=f.observation.agents[0],head=f.heads[0],attempt=path.join(f.org,'settle/old-review.json');fs.mkdirSync(path.dirname(attempt),{recursive:true});
  fs.writeFileSync(attempt,JSON.stringify({run:'R-1',head,stage:verdict?'complete':'reviewing',...(verdict?{review:{verdict}}:{})}));
  const resolution=path.join(f.org,'inactive-review.json');
  const input={item:'ENG-1',run:'R-1',head,base:f.base,evidence:f.file,attempts:[attempt],inactive:{kind,verified_by:a.name,reviewer:kind==='absent'?{pane:'old:p',agent:null,terminal:null,session:null}:null,evidence:attempt}};
  fs.writeFileSync(resolution,JSON.stringify(input));transact(f.org,()=>({add:[{type:'note.added',id:'ENG-1',decision:true,text:`Quiet G1 authorized archive/resolution and ONE fresh normal-route review ONLY for ENG-1 R-1 actual landed head ${head} base ${f.base}; preserve original evidence/caps/native refusal and all completed verdicts. Stable id fixture-recovery; no boundary reset or native launch in recovery.`}]}),{actor:a.name});
  const decision=f.context().events.at(-1).seq,env={...f.env,HERDR_ENV:'1',HERDR_PANE_ID:a.pane_id,HERDR_WORKSPACE_ID:a.workspace_id,CODEX_THREAD_ID:a.agent_session.value,HERDR_BRAIN_ROOT:fs.realpathSync(sourceRoot)};
  const call=(_exe,args)=>JSON.stringify(args[0]==='pane'?{error:{code:'pane_not_found'}}:{result:args[1]==='list'?{agents:[a]}:{agent:a}});
  const args={repo:f.cwd,org:f.org,runId:'R-1',head,base:f.base,resolution,decisionSeq:decision,id:'fixture-recovery',role:'supervisor',cwd:f.cwd,env,call};
  return{...f,args,input,attempt,resolution,call,a};
}

test('permanent supervisor-bound recovery backfills one exact historical landed tuple and preserves its original bytes and cap',t=>{
  const f=recoveryFixture(t),events=f.context().events;events.find(e=>e.type==='line-service.phase0').canonical_head=f.heads[1];fs.writeFileSync(path.join(f.org,'events.jsonl'),events.map(e=>JSON.stringify(e)+'\n').join(''));
  assert.equal(discoverChanges(f.context()).changes.length,0);
  const bytes=fs.readFileSync(f.attempt),result=recoverInactiveReview(f.args);assert.equal(result.result,'review_queued');assert.deepEqual(fs.readFileSync(f.attempt),bytes);
  const c=f.context(),q=c.state.items.get(result.review_item);assert.equal(q.meta.review_target.head,f.heads[0]);assert.equal(q.meta.review_target.base,f.base);assert.equal(q.meta.review_round_cap,1);
  assert.equal(c.events.filter(e=>e.type==='review.recovery-completed').length,1);assert.equal(discoverChanges(c).changes.filter(x=>x.target.head===f.heads[0]).length,1);
  assert.equal(recoverInactiveReview(f.args).review_item,q.id);assert.equal([...f.context().state.items.values()].filter(i=>i.role==='reviewer').length,1);
  assert.throws(()=>recoverInactiveReview({...f.args,id:'second-recovery'}),/budget|already|one/);
});

test('permanent recovery preserves completed exact-head verdicts and refuses live foreign unlanded or no-code targets',t=>{
  for(const verdict of ['PASS','NEEDS-WORK']){const f=recoveryFixture(t,{verdict});assert.equal(recoverInactiveReview(f.args).result,'review_preserved');assert.equal(f.context().events.some(e=>e.type==='review.recovery-completed'),false);}
  const f=recoveryFixture(t,{kind:'absent'}),foreign=(_exe,args)=>args[1]==='list'?JSON.stringify({result:{agents:[f.a,{name:'still-live',pane_id:'old:p',agent_status:'working'}]}}):f.call(_exe,args);
  assert.throws(()=>recoverInactiveReview({...f.args,call:foreign}),/live reviewer/);
  assert.throws(()=>recoverInactiveReview({...f.args,env:{...f.args.env,CODEX_THREAD_ID:'foreign'}}),/binding/);
  assert.throws(()=>recoverInactiveReview({...f.args,head:f.base}),/tuple|source|claim/);
  fs.writeFileSync(path.join(f.workspace,'unlanded'),'new');f.git(['add','.']);f.git(['commit','-qm','Unlanded source']);const head=f.git(['rev-parse','HEAD']);
  const input={...f.input,head};fs.writeFileSync(f.resolution,JSON.stringify(input));f.add([{type:'note.added',id:'ENG-1',decision:true,text:`Quiet authorized archive ENG-1 ${head}`}]);
  assert.throws(()=>recoverInactiveReview({...f.args,head,decisionSeq:f.context().events.at(-1).seq}),/landed/);
  assert.equal(f.context().events.some(e=>e.type==='review.recovery-intent'),false);
});

test('permanent recovery archive guards block only their exact change and cannot hide an unrelated owed review',t=>{
  const f=recoveryFixture(t);recoverInactiveReview(f.args);const head=independentProducer(f),c=f.context(),event=c.events.find(e=>e.type==='review.recovery-completed');
  fs.chmodSync(event.archive.file,0o644);fs.appendFileSync(event.archive.file,'changed');
  const found=discoverChanges({...c,pendingOnly:true});assert.ok(found.changes.some(x=>x.target.head===head));
  const target=found.changes.find(x=>x.target.head===head).target;assert.equal(reviewAttempt(c.state.items.get('ENG-2'),{...c,target}),null);
  assert.throws(()=>reviewAttempt(c.item,{...c,target:event.target}),/manifest changed/);
});

function sourceArtifact(f,artifact){
  const text=`---\nrun: R-1\noutcome: done\nsummary: Actual committed source.\nartifacts:\n  - "${artifact}"\n---\n`,events=f.context().events,event=events.find(e=>e.type==='report.ingested'&&e.run==='R-1');
  fs.writeFileSync(f.file,text);event.sha256=hash(text);event.report.artifacts=[artifact];fs.writeFileSync(path.join(f.org,'events.jsonl'),events.map(e=>JSON.stringify(e)+'\n').join(''));
}
test('permanent recovery composes the actual source HEAD base lane artifact with its archived settle deliveryRange',t=>{
  const f=recoveryFixture(t),head=f.heads[0];sourceArtifact(f,`source: ${head}; base: ${f.base}; lane: line-eng-226-1`);
  fs.writeFileSync(f.attempt,JSON.stringify({run:'R-1',item:'ENG-1',head,mainHead:f.base,deliveryRange:{head,base:f.base},stage:'reviewing'}));
  assert.deepEqual(claimedCommitTokens(f.context().run.report.artifacts),[head]);
  const result=recoverInactiveReview(f.args);assert.equal(result.result,'review_queued');const q=f.context().state.items.get(result.review_item);
  assert.equal(q.meta.review_target.head,head);assert.equal(q.meta.review_target.base,f.base);assert.equal(q.meta.review_target.reportHash,hash(fs.readFileSync(f.file)));
});
test('permanent recovery source composition never promotes packet admission base-only or conflicting range context into a source claim',t=>{
  const head='a'.repeat(40),base='b'.repeat(40);assert.deepEqual(claimedCommitTokens([`packet: ${head}; base: ${base}`,`admission: ${head}`,`base: ${base}`,`source selection: ${head}`]),[]);
  const f=recoveryFixture(t);sourceArtifact(f,`source: ${f.heads[0]}; base: ${f.heads[1]}; lane: source`);assert.throws(()=>recoverInactiveReview(f.args),/declared source\/base/);
  sourceArtifact(f,`source: ${f.heads[0]}; base: ${f.base}; lane: source`);fs.writeFileSync(f.attempt,JSON.stringify({run:'R-1',item:'ENG-1',head:f.heads[0],deliveryRange:{head:f.heads[0],base:f.heads[1]}}));assert.throws(()=>recoverInactiveReview(f.args),/deliveryRange/);
  fs.writeFileSync(f.attempt,JSON.stringify({run:'R-1',head:f.heads[0],stage:'reviewing'}));const dispatch=path.join(f.org,'dispatch/source.json'),saved=JSON.parse(fs.readFileSync(dispatch));saved.base=f.heads[0];fs.writeFileSync(dispatch,JSON.stringify(saved));
  assert.throws(()=>recoverInactiveReview(f.args),/admission/);assert.equal(f.context().events.some(e=>e.type==='review.recovery-intent'),false);
});

test('permanent R858 retained recovery resumes its immutable intent and archive with the required review authorization note',t=>{
  const f=recoveryFixture(t),head=f.heads[0];sourceArtifact(f,`source: ${head}; base: ${f.base}; lane: line-eng-226-1`);
  fs.writeFileSync(f.attempt,JSON.stringify({run:'R-1',item:'ENG-1',head,mainHead:f.base,deliveryRange:{head,base:f.base},stage:'reviewing',review:null,qualification:'UNKNOWN',error:'canonical w3PD repository identity mismatch before reviewer creation'}));
  f.add([{type:'note.added',id:'ENG-1',decision:true,text:`Completed SOURCE at integrated ${f.heads[1]}; preserve original held review UNKNOWN, callbacks and final-release obligations.`},
    {type:'item.closed',id:'ENG-1',as:'done'}]);
  const events=f.context().events;events.find(e=>e.type==='line-service.phase0').canonical_head=f.heads[1];fs.writeFileSync(path.join(f.org,'events.jsonl'),events.map(e=>JSON.stringify(e)+'\n').join(''));
  f.git(['worktree','remove',f.workspace],f.cwd);
  const original=fs.readFileSync(f.attempt),authorization=f.context().events.find(e=>e.seq===f.args.decisionSeq);assert.match(authorization.text,/review/);
  let lists=0;const staged=(exe,args)=>{if(args[0]==='agent'&&args[1]==='list'&&++lists===2)throw Error('native inventory unavailable at final queue boundary; retain attempt');return f.call(exe,args);};
  assert.throws(()=>recoverInactiveReview({...f.args,call:staged}),/inventory unavailable/);
  const pending=f.context().events;assert.equal(pending.filter(e=>e.type==='review.recovery-intent').length,1);assert.equal(pending.some(e=>e.type==='review.recovery-completed'),false);
  const manifest=path.join(f.org,'evidence/review-recovery/fixture-recovery/manifest.json'),archived=fs.readFileSync(manifest),intent=pending.find(e=>e.type==='review.recovery-intent');
  const result=recoverInactiveReview(f.args),c=f.context(),q=c.state.items.get(result.review_item);
  assert.equal(q.meta.review_target.head,head);assert.equal(q.meta.review_target.base,f.base);assert.equal(q.meta.review_round_cap,1);assert.equal(q.meta.review_recovery_id,'fixture-recovery');
  assert.deepEqual(fs.readFileSync(f.attempt),original);assert.deepEqual(fs.readFileSync(manifest),archived);assert.deepEqual(c.events.find(e=>e.seq===intent.seq),intent);assert.deepEqual(c.events.find(e=>e.seq===authorization.seq),authorization);
  assert.equal(c.events.filter(e=>e.type==='review.recovery-intent').length,1);assert.equal(c.events.filter(e=>e.type==='review.recovery-completed').length,1);
  assert.equal(recoverInactiveReview(f.args).review_item,q.id);assert.equal([...f.context().state.items.values()].filter(i=>i.role==='reviewer').length,1);
});

test('permanent R858 authorization exempts only its exact validated note and retains independent holds or new unknown evidence',t=>{
  for(const kind of ['older-note','later-note','unknown-attempt']){
    const f=recoveryFixture(t),head=f.heads[0];
    if(kind==='older-note'){
      f.add([{type:'note.added',id:'ENG-1',decision:true,text:`Independent review hold for ENG-1 ${head}; unresolved.`}]);
      // A newer authorization still cannot silently supersede this hold.
      transact(f.org,()=>({add:[{type:'note.added',id:'ENG-1',decision:true,text:`Authorize one inactive review recovery for ENG-1 ${head}; preserve independent holds.`}]}),{actor:f.a.name});f.args.decisionSeq=f.context().events.at(-1).seq;
    }else if(kind==='later-note')f.add([{type:'note.added',id:'R-1',decision:true,text:`New independent review hold for ENG-1 ${head}; unresolved.`}]);
    else fs.writeFileSync(path.join(f.org,'settle/new-unknown.json'),JSON.stringify({run:'R-1',item:'ENG-1',head,stage:'reviewing',review:null,qualification:'UNKNOWN'}));
    const before=f.context().events.filter(e=>e.type==='note.added');
    assert.throws(()=>recoverInactiveReview(f.args),/same-change.*(hold|UNKNOWN)/);
    assert.deepEqual(f.context().events.filter(e=>e.type==='note.added'),before);assert.equal(f.context().events.some(e=>e.type==='review.recovery-completed'),false);
    assert.equal([...f.context().state.items.values()].some(i=>i.role==='reviewer'),false);
  }
});

test('phase1 owes every landed build commit after the boundary even after item close and source worktree cleanup',t=>{
  const f=fixture(t);f.add([{type:'item.closed',id:'ENG-1',as:'done'}]);f.git(['worktree','remove','--force',f.workspace],f.cwd);
  const found=discoverChanges(f.context());assert.deepEqual(found.changes.map(c=>c.target.head),[f.heads[1]]);
  assert.equal(found.changes[0].target.base,f.base);assert.deepEqual(found.changes[0].target.source_group.owned_commits,f.heads);
  assert.equal(canonicalReviewIndex(f.context()).entries.length,2);
  assert.equal(found.changes.some(c=>c.target.head===f.base),false);
});

test('phase1 settled-history scan uses two Git index reads for thousands of old reports',t=>{
  const f=fixture(t),c=f.context(),state=fold(c.events),old=c.run;
  state.runs.clear();for(let n=1;n<=2035;n++)state.runs.set(`R-${n}`,{...old,id:`R-${n}`,report:{...old.report,artifacts:[`Commit: ${f.base}`]}});
  let reads=0;const found=discoverChanges({...c,state,readGit:(repo,args)=>{reads++;return f.git(args,repo);}});
  assert.equal(found.changes.length,0);assert.equal(found.holds.length,0);assert.equal(reads,2);
});

test('phase1 intended boundary preserves old cutover and unknown adoption-time facts under stopped native guards',t=>{
  const f=configFixture(t,{custom:true}),org=f.env.ORG_DIR,project=gitProject(f.cwd),directory=serviceDirectory(org,project.identity),base=f.git('rev-parse','HEAD');
  fs.mkdirSync(directory,{recursive:true});fs.writeFileSync(path.join(directory,'STOP'),'stopped');
  fs.writeFileSync(path.join(directory,'installation.json'),JSON.stringify({repo:f.cwd,org,source:developmentRoot,node:process.execPath,file:path.join(directory,'service.plist'),target:`gui/${process.getuid()}/dev.herdr.line.${path.basename(directory)}`}));
  const actor=structuredClone(f.observation.agents[0]),env={...f.env,HERDR_BRAIN_ROOT:developmentRoot,HERDR_ENV:'1',HERDR_PANE_ID:actor.pane_id,HERDR_WORKSPACE_ID:actor.workspace_id,CODEX_THREAD_ID:actor.agent_session.value};
  const evidence=path.join(f.scratch,'designated.txt');fs.writeFileSync(evidence,'Designated intended source archive; exact minute UNKNOWN.');
  transact(org,()=>({add:[{type:'line-service.cutover',id:'old-retained',project:project.identity,repo:f.cwd,org,canonical_head:base}]}));
  const args={repo:f.cwd,org,id:'phase0-designated',cutover:true,phase0Head:base,evidence,cwd:f.cwd,env,call:()=>JSON.stringify({result:{agent:actor}})};
  const result=establishCutover(args);assert.equal(result.phase0.canonical_head,base);assert.equal(result.phase0.cutoff_at,null);assert.match(result.phase0.time_qualification,/UNKNOWN/);
  assert.equal(establishCutover(args).existing,true);assert.equal(loadEvents(org).events.filter(e=>e.type==='line-service.cutover').length,1);
  assert.throws(()=>establishCutover({...args,id:'reset'}),/no implicit reset/);
  fs.unlinkSync(path.join(directory,'STOP'));assert.throws(()=>establishCutover(args),/own STOP/);
});

test('phase1 post-FF producer facts bind actual source ownership and keep the real landing time once',t=>{
  const f=fixture(t),actor=structuredClone(f.observation.agents[0]);actor.cwd=f.workspace;
  f.add([{type:'run.updated',id:'R-1',meta:{agent:actor.name,pane:actor.pane_id,worker_workspace:actor.workspace_id,terminal_id:actor.terminal_id,agent_session_id:actor.agent_session.value}}]);
  const env={...f.env,HERDR_ENV:'1',HERDR_PANE_ID:actor.pane_id,HERDR_WORKSPACE_ID:actor.workspace_id,CODEX_THREAD_ID:actor.agent_session.value};
  const args={canonical:f.cwd,workspace:f.workspace,base:f.base,head:f.heads[1],landedAt:'2026-10-27T01:30:00Z',env,call:()=>JSON.stringify({result:{agent:actor}})};
  assert.equal(recordOwnLanding(args).changes.length,2);assert.equal(recordOwnLanding(args).changes.length,0);
  assert.equal(f.context().events.find(e=>e.type==='change.landed').landed_at,args.landedAt);
  assert.throws(()=>recordOwnLanding({...args,head:f.base}),/CAS/);
});

test('phase1 only pre-effect lifecycle mutex refusal receives automatic closeout retry',()=>{
  assert.equal(safeCloseoutRetry({completed:false,reason:'locked: lane-promote.lock'}),true);
  for(const reason of ['EPERM native refusal','queued native identity changed','HOLD-WORKER-TAB-CLOSE','callback unknown','unconfirmed exit','ordinary unknown'])assert.equal(safeCloseoutRetry({completed:false,reason}),false);
});

test('phase1 dedup retains same-change UNKNOWN but unrelated old attempts and private folders block no new change',t=>{
  const f=fixture(t),c=f.context(),target=discoverChanges(c).changes[0].target;
  fs.mkdirSync(path.join(f.cwd,'.lane-review-unrelated-r1'));
  fs.mkdirSync(path.join(f.org,'retirement/occupants'),{recursive:true});const file=path.join(f.org,'retirement/occupants/old.json');
  fs.writeFileSync(file,JSON.stringify({kind:'settle',run:'R-90',item:'ENG-1',head:f.base,qualification:'UNKNOWN'}));
  assert.equal(reviewAttempt(c.item,{...c,target}),null);
  fs.writeFileSync(file,JSON.stringify({kind:'settle',run:'R-1',item:'ENG-1',head:target.head,qualification:'UNKNOWN'}));
  assert.match(reviewAttempt(c.item,{...c,target}),/same-change.*UNKNOWN/);
});

test('phase1 explicit current-source manual review reference holds without inspecting another identity',t=>{
  const f=fixture(t),c=f.context(),target=discoverChanges(c).changes[0].target;
  c.run.report.artifacts.push('/outside-owner/archive/source-review.json');
  let probes=0;const stat=fs.lstatSync;fs.lstatSync=(file,...args)=>{if(String(file).startsWith('/outside-owner/'))probes++;return stat(file,...args);};
  try{assert.match(reviewAttempt(c.item,{...c,target}),/source-owner review reference UNKNOWN/);}finally{fs.lstatSync=stat;}
  assert.equal(probes,0);
});

test('phase1 creates one queue item per whole producer change with immutable evidence and never duplicates intermediate tuples',t=>{
  const f=fixture(t),c=f.context(),changes=discoverChanges(c).changes;
  const before=process.cwd(),env={...f.env,ORG_ACTOR:'line-service',HERDR_ENV:'',HERDR_PANE_ID:''};process.chdir(f.cwd);
  try{
    for(const change of changes){const r=queueReviewMutation({...f.context(),runId:'R-1',head:change.target.head,base:change.target.base,env});f.add(r.add);}
    const q=[...f.context().state.items.values()].filter(i=>i.role==='reviewer');assert.equal(q.length,1);assert.deepEqual(q[0].meta.review_target.source_group.owned_commits,f.heads);
    assert.equal(q[0].meta.review_target.base,f.base);assert.equal(q[0].meta.review_target.head,f.heads[1]);assert.equal(q[0].meta.review_round_cap,1);
    assert.throws(()=>queueReviewMutation({...f.context(),runId:'R-1',head:f.heads[0],env}),/missing\/ambiguous/);
    const again=queueReviewMutation({...f.context(),runId:'R-1',head:changes[0].target.head,base:changes[0].target.base,env});assert.equal(again.add.length,0);
  }finally{process.chdir(before);}
});

function partialReview(f,id,{head,base,run,verdict,held=false}){
  const c=f.context(),whole=discoverChanges(c).changes.find(x=>x.run.id==='R-1'),target={...whole.target,head,base,diff_sha256:hash(f.git(['diff','--no-ext-diff','--no-textconv',base,head],f.cwd)),scope:{base,commits:[head],claims:[head],unresolved:[],deferred:false}};delete target.source_group;
  const rows=[{type:'item.added',id,role:'reviewer',title:'Retained exact partial',meta:{review_source_item:'ENG-1',review_source_run:'R-1',review_key:`ENG-1:${head}`,review_target:target,review_round_cap:1,review_cutover:whole.cutoff,...(held?{hold:true}:{})}}];
  if(run)rows.push({type:'run.started',id:run,item:id,workspace:f.cwd,meta:{agent:`review-${run}`,pane:`pane-${run}`,worker_workspace:'review-workspace',terminal_id:`terminal-${run}`,agent_session_id:`session-${run}`}});
  if(verdict){rows.push({type:'report.ingested',run,file:`reports/${run}.md`,sha256:'c'.repeat(64),report:{outcome:'done',extra:{verdict},blockers:[]}},
    {type:'change.reviewed',item:'ENG-1',head,base,review_item:id,review_run:run,verdict,findings:[],report_sha256:'c'.repeat(64)});}
  f.add(rows);return target;
}

test('permanent group preserves R3388-shaped active intermediate and held final without a duplicate or false whole-source coverage',t=>{
  const f=fixture(t);partialReview(f,'REV-1200',{head:f.heads[0],base:f.base,run:'R-3400'});partialReview(f,'REV-1201',{head:f.heads[1],base:f.heads[0],held:true});
  f.add([{type:'change.reviewed',item:'ENG-90',head:f.base,verdict:'PASS',review_item:'REV-666',review_run:'R-666',findings:[]}]);
  const c=f.context(),before=structuredClone(c.events),index=canonicalReviewIndex(c),health=reviewHealth({...c,index});
  assert.equal(health.owed,1);assert.equal(health.owed_commits,2);assert.equal(health.queued,1);assert.equal(health.running,1);assert.equal(health.done,0);assert.deepEqual(health.coverage_gaps.map(x=>x.head),[f.heads[1]]);
  assert.equal(discoverChanges({...c,pendingOnly:true}).changes.length,0);
  const cwd=process.cwd();process.chdir(f.cwd);try{assert.throws(()=>queueReviewMutation({...c,runId:'R-1',env:{...f.env,ORG_ACTOR:'line-service',HERDR_ENV:'',HERDR_PANE_ID:''}}),/whole producer review already retained/);}finally{process.chdir(cwd);}
  assert.throws(()=>validateQueuedReview({...c,item:c.state.items.get('REV-1201')}),/base|producer|target/);
  assert.deepEqual(f.context().events,before);assert.equal(f.context().state.items.get('REV-1201').runs.length,0);assert.equal(c.events.filter(e=>e.type==='change.reviewed').length,1);
});

test('permanent group preserves ARCH679-shaped fixture PASS and active feature scopes while held unstarted partials provide no invented coverage',t=>{
  const f=fixture(t);partialReview(f,'REV-1203',{head:f.heads[1],base:f.heads[0],run:'R-3403',verdict:'PASS'});partialReview(f,'REV-1204',{head:f.heads[0],base:f.base,run:'R-3404'});
  const c=f.context(),health=reviewHealth({...c,index:canonicalReviewIndex(c)});assert.equal(health.owed,1);assert.equal(health.done,0);assert.equal(health.done_commits,1);assert.equal(health.running,1);assert.equal(health.coverage_gaps.length,0);
  assert.equal(c.state.items.get('REV-1203').meta.review_target.base,f.heads[0]);assert.equal(c.state.items.get('REV-1204').meta.review_target.head,f.heads[0]);
  assert.match(reviewAttempt(c.item,{...c,target:discoverChanges(c).changes[0].target}),/whole producer/);
  const g=fixture(t);partialReview(g,'REV-1205',{head:g.heads[0],base:g.base,held:true});partialReview(g,'REV-1206',{head:g.heads[1],base:g.heads[0],held:true});
  const gc=g.context(),gh=reviewHealth({...gc,index:canonicalReviewIndex(gc)});assert.equal(gh.queued,1);assert.equal(gh.running,0);assert.equal(gh.done_commits,0);assert.equal(gh.coverage_gaps.length,2);assert.equal(discoverChanges({...gc,pendingOnly:true}).changes.length,0);
});

test('permanent group uses an explicit immutable whole range and keeps unrelated interleaved ownership and verdict coverage separate',t=>{
  const f=fixture(t);sourceArtifact(f,`source: ${f.heads[1]}; base: ${f.base}; lane: source`);
  let c=f.context(),index=canonicalReviewIndex(c),target=discoverChanges(c).changes[0].target;assert.deepEqual(target.source_group.owned_commits,f.heads);assert.ok(index.entries.every(e=>e.run==='R-1'));
  f.add([{type:'item.added',id:'ENG-99',role:'engineer',title:'Other owner'}, {type:'run.started',id:'R-99',item:'ENG-99',workspace:f.cwd},
    {type:'change.landed',item:'ENG-99',run:'R-99',head:f.heads[0],base:f.base,project:f.identity},
    {type:'change.reviewed',item:'ENG-99',head:f.heads[0],verdict:'PASS',findings:[]}]);
  c=f.context();target=discoverChanges(c).changes[0].target;assert.deepEqual(target.scope.commits,f.heads);assert.deepEqual(target.source_group.owned_commits,[f.heads[1]]);
  index=canonicalReviewIndex(c);assert.equal(index.entries.find(e=>e.head===f.heads[0]).run,'R-99');assert.equal(reviewHealth({...c,index}).done_commits,1);
  assert.equal(reviewAttempt(c.item,{...c,target}),null,'an independently attributed verdict is not this producer attempt');
});

test('permanent group rejects admission packet unresolved omitted and unlanded source instead of reviewing a convenient intermediate',t=>{
  const f=fixture(t),dispatch=path.join(f.org,'dispatch/source.json'),job=JSON.parse(fs.readFileSync(dispatch));
  sourceArtifact(f,`packet: ${f.heads[1]}; admission: ${f.heads[0]}`);assert.equal(discoverChanges(f.context()).changes.length,0);
  sourceArtifact(f,`source: ${f.heads[1]}; base: ${f.heads[0]}; lane: source`);f.add([{type:'change.landed',item:'ENG-1',run:'R-1',head:f.heads[0],base:f.base,project:f.identity}]);assert.match(discoverChanges(f.context()).holds[0].reason,/omits/);
  fs.writeFileSync(dispatch,JSON.stringify({...job,base:f.heads[1]}));assert.match(discoverChanges(f.context()).holds[0].reason,/admission/);
  fs.writeFileSync(dispatch,JSON.stringify(job));f.git(['reset','--hard',f.heads[0]],f.cwd);assert.equal(discoverChanges(f.context()).changes.length,0);
});

test('permanent index counts unclaimed commits and own unreported landings and scopes linked-fix exemptions without relying on creation sequence',t=>{
  const f=fixture(t,{reported:false});f.add([{type:'change.landed',item:'ENG-1',run:'R-1',head:f.heads[0],base:f.base,project:f.identity}]);
  const c=f.context(),index=canonicalReviewIndex(c),health=reviewHealth({...c,index});assert.equal(health.owed_commits,2);assert.equal(health.owed,2);assert.equal(health.attribution_gaps.length,2);assert.ok(health.attribution_gaps.some(g=>g.reason==='missing source attribution'));assert.ok(health.attribution_gaps.some(g=>g.reason==='immutable producer report pending'));
  f.add([{type:'item.added',id:'REV-99',role:'reviewer',title:'Original judgment'},{type:'item.added',id:'ENG-99',role:'engineer',title:'Formal correction',parent:'REV-99',meta:{review_fix_of:'original:key'}},
    {type:'run.started',id:'R-99',item:'ENG-99',workspace:f.cwd}, {type:'change.landed',item:'ENG-99',run:'R-99',head:f.heads[1],base:f.heads[0],project:f.identity}]);
  const changed=f.context(),later=reviewHealth({...changed,index:canonicalReviewIndex(changed)});assert.equal(later.owed_commits,1);assert.equal(later.exemptions[0].head,f.heads[1]);
});

test('permanent boundary auto records first actual main once and preserves explicit qualified boundaries and STOP native-context fences',t=>{
  const f=fixture(t),env=installedService(f),release=noticeLock(path.join(f.directory,'pass.lock'));
  try{
    const original=phase0Boundary(f.context().events,f.context());assert.deepEqual(ensureReviewBoundary({repo:f.cwd,org:f.org,env}),original);
    const events=f.context().events.filter(e=>e.type!=='line-service.phase0');events.push({type:'line-service.phase0',seq:events.at(-1).seq+1,project:f.identity,org:f.org,repo:f.cwd,canonical_head:null,main:'main',time_qualification:'Earlier UNKNOWN retained.'});fs.writeFileSync(path.join(f.org,'events.jsonl'),events.map(e=>JSON.stringify(e)+'\n').join(''));
    const first=ensureReviewBoundary({repo:f.cwd,org:f.org,env});assert.equal(first.canonical_head,f.heads[1]);assert.equal(first.cutoff_at,null);assert.match(first.time_qualification,/no historical18:55/);assert.deepEqual(ensureReviewBoundary({repo:f.cwd,org:f.org,env}),phase0Boundary(f.context().events,f.context()));assert.equal(f.context().events.filter(e=>e.type==='line-service.phase0').length,2);
    assert.throws(()=>ensureReviewBoundary({repo:f.cwd,org:f.org,env:{...env,HERDR_ENV:'1'}}),/native session/);
    fs.writeFileSync(path.join(f.directory,'STOP'),'stopped');assert.throws(()=>ensureReviewBoundary({repo:f.cwd,org:f.org,env}),/STOP/);
  }finally{release();}
});

test('permanent group capability contains an old adopted or saved helper before any automatic review effect',t=>{
  const f=fixture(t),c=f.context();assert.equal(selectedReviewConsumer({...c,resolve:()=>f.bundle}).recordRoot,f.bundle);
  fs.appendFileSync(path.join(f.bundle,'line-service/review-group.mjs'),'\n// older grouping implementation\n');
  assert.throws(()=>selectedReviewConsumer({...c,resolve:()=>f.bundle}),/old\/unknown.*capability/);
  assert.throws(()=>selectedReviewConsumer({...c,run:{...c.run,owner:{...c.run.owner,release:{...c.run.owner.release,root:f.bundle}}}}),/saved review helper capability/);
  assert.equal([...f.context().state.items.values()].some(q=>q.role==='reviewer'),false);
});

test('permanent health records the first review error immediately and one gap notice after four real passes without a session prompt',t=>{
  const f=fixture(t),env=installedService(f);f.add([{type:'item.closed',id:'ENG-1',as:'done'}]);
  let calls=0;const service=()=>createLineService({repo:f.cwd,org:f.org,to:'brain-chat',env,capacity:()=>({cap:0,count:0}),command:(_exe,args)=>{calls++;assert.equal(args[1],'queue-review');return{status:1,stdout:'',stderr:'selected helper cannot certify immutable review target'};}});
  service().pass();let events=f.context().events;assert.equal(events.filter(e=>e.type==='line-service.review-error').length,1);assert.equal(events.filter(e=>e.type==='session.message.v1').length,1);
  for(let n=0;n<4;n++)service().pass();events=f.context().events;const messages=events.filter(e=>e.type==='session.message.v1'),health=events.filter(e=>e.type==='line-service.review-health');
  assert.equal(health.length,5);assert.equal(health.at(-1).gap_passes,5);assert.equal(health.at(-1).owed,1);assert.equal(health.at(-1).owed_commits,2);assert.equal(health.at(-1).queued,0);
  assert.equal(messages.filter(e=>e.envelope.payload.service_notice.boundary==='review-gap').length,1);assert.equal(messages.filter(e=>e.envelope.payload.service_notice.boundary.startsWith('review:')).length,1);assert.equal(calls,5);
  const digest=morningDigest({events});assert.ok(digest.review_errors.occurrences>=5);assert.equal(digest.review_health.pass_id,health.at(-1).pass_id);
  assert.equal(fs.existsSync(path.join(f.org,'supervisor/inbox.log')),false);assert.ok(messages.every(e=>e.envelope.source.kind==='service'&&e.envelope.sessionUid===undefined));
});

test('permanent review route falls back to the existing review route without replacing explicit task policy',()=>{
  const config=structuredClone(ROUTE_PRESET);delete config.routes.reviewer;delete config.selection_policy.by_task_class.review;
  config.routes.review={kind:'codex',model:'fixture-reviewer',effort:'max'};
  assert.equal(reviewQueueRoute(config),'review');
  config.selection_policy.by_task_class.review='review-codex';assert.equal(reviewQueueRoute(config),'review-codex');
  delete config.selection_policy.by_task_class.review;delete config.routes.review;assert.throws(()=>reviewQueueRoute(config),/unknown task class: review/);
  config.routes.review=3;assert.throws(()=>reviewQueueRoute(config),/route|object/);
});

test('phase1 verdict and Major FAIL plus Minor findings become immutable scoped facts and linked work once',t=>{
  const f=fixture(t),target=discoverChanges(f.context()).changes[0].target;
  f.add([{type:'item.added',id:'REV-1',role:'reviewer',title:'Review',meta:{review_source_item:'ENG-1',review_source_run:'R-1',review_key:`ENG-1:${target.head}`,review_target:target,review_round_cap:1}},{type:'run.started',id:'R-2',item:'REV-1',workspace:f.cwd,meta:{dispatch_role:'review'}}]);
  const c=f.context(),run=c.state.runs.get('R-2'),report={outcome:'done',summary:'Findings',extra:{verdict:'FAIL'},proposals:[],body:'- [Major] source-1:1 - broken invariant\n- [Minor] source-2:1 - unclear name'};
  const added=reviewResultEvents({...c,run,report,sha256:'a'.repeat(64)});assert.equal(added.filter(e=>e.type==='change.reviewed').length,1);
  const work=added.filter(e=>e.type==='item.added');assert.equal(work.length,2);assert.ok(work.every(e=>e.parent==='REV-1'&&e.meta.review_fix_of===`ENG-1:${target.head}`));
  f.add(added);assert.equal(reviewResultEvents({...f.context(),run,report,sha256:'a'.repeat(64)}).length,0);
});

test('phase1 ingests an explicit immutable body verdict and holds missing quoted fenced or contradictory judgments',t=>{
  const f=fixture(t),target=discoverChanges(f.context()).changes[0].target;
  f.add([{type:'item.added',id:'REV-1',role:'reviewer',title:'Review',meta:{review_source_item:'ENG-1',review_source_run:'R-1',review_key:`ENG-1:${target.head}`,review_target:target,review_round_cap:1}},
    {type:'run.started',id:'R-2',item:'REV-1',workspace:f.workspace},
    {type:'run.claimed',run:'R-2',record:f.org,project:f.identity,owner:{controller:'brain',legacy:false,release:{id:'compatible',root:f.bundle,commit:'1'.repeat(40)}}}]);
  const text='---\nrun: R-2\noutcome: done\nsummary: Independently reviewed the immutable diff.\nproposals: []\n---\n\nVerdict: PASS\n\nNo findings.\n',parsed=readReport(text),c=f.context(),run=c.state.runs.get('R-2');
  const facts=reviewResultEvents({...c,run,report:parsed.report,body:parsed.body,sha256:hash(text)});
  assert.equal(facts[0].verdict,'PASS');assert.deepEqual(facts[0].verdict_evidence,{frontmatter:false,body_lines:[1]});assert.equal(facts[0].report_sha256,hash(text));
  for(const body of ['No findings.','> Verdict: PASS','```text\nVerdict: PASS\n```','Verdict: PASS\nVerdict: FAIL','Verdict: UNKNOWN'])
    assert.throws(()=>reviewResultEvents({...c,run,report:parsed.report,body,sha256:hash(text)}),/explicit|ambiguous/);
  assert.throws(()=>reviewResultEvents({...c,run,report:{...parsed.report,extra:{verdict:'FAIL'}},body:parsed.body,sha256:hash(text)}),/ambiguous/);
  const file=path.join(f.org,'body-review.md');fs.writeFileSync(file,text);
  const policy=JSON.parse(fs.readFileSync(path.join(f.cwd,'.lane.json'),'utf8'));policy.retirement={closeout_queue:false};fs.writeFileSync(path.join(f.cwd,'.lane.json'),JSON.stringify(policy));
  const env={...f.env,ORG_ACTOR:'line-service',HERDR_BRAIN_ROOT:f.bundle};for(const k of ['HERDR_ENV','HERDR_PANE_ID','HERDR_WORKSPACE_ID','CODEX_SESSION_ID','CODEX_THREAD_ID'])delete env[k];
  const result=spawnSync(process.execPath,[path.join(f.bundle,'bin/org.mjs'),'ingest',file,'--run','R-2'],{cwd:f.cwd,env,encoding:'utf8'});
  assert.equal(result.status,0,result.stderr);assert.equal(f.context().state.runs.get('R-2').report.extra.verdict,'PASS');
  assert.equal(f.context().events.filter(e=>e.type==='change.reviewed'&&e.review_run==='R-2').length,1);
  assert.equal(fs.readFileSync(path.join(f.org,'reports/R-2.md'),'utf8'),text,'original report bytes stay immutable');
});

test('permanent review verdict accepts the actual PASS sentence and bold FAIL prefix with frontmatter agreement and one Major fix',t=>{
  const f=fixture(t),target=discoverChanges(f.context()).changes[0].target;
  f.add([{type:'item.added',id:'REV-1',role:'reviewer',title:'Review',meta:{review_source_item:'ENG-1',review_source_run:'R-1',review_key:`ENG-1:${target.head}`,review_target:target,review_round_cap:1}},
    {type:'run.started',id:'R-2',item:'REV-1',workspace:f.cwd}]);
  const c=f.context(),run=c.state.runs.get('R-2');
  for(const [verdict,body]of [['PASS','Verdict: PASS. No findings.'],['FAIL','Verdict: **FAIL**\n- [Major] source-1:1 - actual source defect']]){
    const report={outcome:'done',summary:'Immutable independent judgment',proposals:[],extra:{verdict}},facts=reviewResultEvents({...c,run,report,body,sha256:hash(body)});
    assert.equal(facts[0].verdict,verdict);assert.equal(facts[0].report_sha256,hash(body));
    assert.equal(facts.filter(e=>e.type==='item.added').length,verdict==='FAIL'?1:0);
    if(verdict==='FAIL')assert.equal(facts[1].meta.review_fix_of,`ENG-1:${target.head}`);
    assert.throws(()=>reviewResultEvents({...c,run,report:{...report,extra:{verdict:verdict==='PASS'?'FAIL':'PASS'}},body,sha256:hash(body)}),/ambiguous/);
  }
});

test('phase1 current service records an old selected consumers immutable review result without changing its owner or pin',t=>{
  const f=fixture(t),target=discoverChanges(f.context()).changes[0].target,key=`ENG-1:${target.head}`;
  const text='---\nrun: R-2\noutcome: done\nsummary: Actual immutable review.\nverdict: FAIL\nproposals:\n  - role: engineer\n    title: Fix the source\n    why: Resolve the Major.\n---\n- [Major] source-1:1 - broken invariant\n';
  fs.writeFileSync(path.join(f.org,'reports/R-2.md'),text);
  const owner=f.context().run.owner;
  f.add([{type:'item.added',id:'REV-1',role:'reviewer',title:'Review',meta:{review_source_item:'ENG-1',review_source_run:'R-1',review_key:key,review_target:target,review_round_cap:1}},
    {type:'run.started',id:'R-2',item:'REV-1',workspace:f.cwd}, {type:'run.claimed',run:'R-2',record:f.org,project:f.identity,owner},
    {type:'report.ingested',run:'R-2',file:'reports/R-2.md',sha256:hash(text),report:{outcome:'done',summary:'Review',extra:{verdict:'FAIL'},proposals:[{role:'engineer',title:'Fix the source'}]}},
    {type:'item.added',id:'ENG-2',role:'engineer',title:'Fix the source',parent:'REV-1',from_run:'R-2'}]);
  fs.mkdirSync(f.directory,{recursive:true});fs.writeFileSync(path.join(f.directory,'installation.json'),JSON.stringify({at:'2026-10-27T01:00:00Z',repo:f.cwd,org:f.org,source:sourceRoot,node:process.execPath,file:path.join(f.directory,'service.plist'),target:`gui/${process.getuid()}/dev.herdr.line.${path.basename(f.directory)}`}));
  const env={...f.env};delete env.HERDR_ENV;delete env.HERDR_PANE_ID;
  const release=noticeLock(path.join(f.directory,'pass.lock'));
  try{assert.equal(recordReviewResults({repo:f.cwd,org:f.org,runId:'R-2',env}).added.filter(e=>e.type==='change.reviewed').length,1);assert.equal(recordReviewResults({repo:f.cwd,org:f.org,runId:'R-2',env}).added.length,0);}
  finally{release();}
  const c=f.context();assert.equal(c.state.items.get('ENG-2').meta.review_fix_of,key);assert.deepEqual(c.state.runs.get('R-2').owner,owner);assert.equal([...c.state.items.values()].filter(i=>i.role==='engineer').length,2);
});

test('phase1 build and three review slots are separate while uncertain starts and unknown owners remain occupied',t=>{
  const f=configFixture(t,{custom:true}),common=gitProject(f.cwd).identity,org=f.env.ORG_DIR,dir=path.join(org,'dispatch');fs.mkdirSync(dir,{recursive:true});
  for(let n=1;n<=3;n++)fs.writeFileSync(path.join(dir,`review-${n}.json`),JSON.stringify({stage:'open',detached:true,common,item:`REV-${n}`,reviewQueue:{head:'a'.repeat(40)}}));
  const config={dispatch:{max_sessions:4,max_review_sessions:3}},base={config,org,common,kill:()=>{throw Object.assign(Error('unknown'),{code:'EPERM'});},readProcess:()=>({ok:false})};
  assert.equal(checkSessionCap({...base,kind:'build'}).count,0);assert.throws(()=>checkSessionCap({...base,kind:'review'}),e=>e.code==='DISPATCH_REVIEW_CAP');
  assert.equal(countSessions({state:{runs:new Map()},journals:[{stage:'launching',common}],common})[0].occupancy,'uncertain launch');
});

test('phase1 blocked report requires genuine new input and ignores its own routine service notes',t=>{
  const f=fixture(t),c=f.context(),run={...c.run,report:{...c.run.report,outcome:'blocked'}},item=c.item;
  assert.equal(blockedChangeKey({...c,run,item}),null);
  const own={type:'note.added',id:item.id,seq:run.report.seq+1,by:'line-service',text:'same hold'};
  assert.equal(blockedChangeKey({...c,run,item,events:[...c.events,own]}),null);
  const human={...own,seq:own.seq+1,by:'source-owner',text:'New brief and evidence supplied'};
  assert.ok(blockedChangeKey({...c,run,item,events:[...c.events,own,human]}));
});

test('phase1 valid report ingests with no live pane and retries a transient safe failure while independent starts continue',t=>{
  const f=fixture(t,{reported:false});fs.mkdirSync(path.join(f.org,'runs/R-1'),{recursive:true});fs.writeFileSync(path.join(f.org,'runs/R-1/report.md'),f.report);
  f.add([{type:'item.added',id:'ENG-2',title:'Ready',role:'engineer'},{type:'item.added',id:'ENG-3',title:'Also ready',role:'engineer'}]);
  const calls=[];let failed=false;
  const command=(_exe,args,options)=>{assert.equal(options.timeout,0);calls.push(args);
    if(args[1]==='ingest'&&!failed){failed=true;return {error:Object.assign(Error('transient'),{code:'ETIMEDOUT'}),status:null,stdout:'',stderr:''};}
    if(args[1]==='ingest'){f.add([{type:'report.ingested',run:'R-1',item:'ENG-1',file:'reports/R-1.md',sha256:hash(f.report),report:{outcome:'done',artifacts:f.heads.map(h=>`Commit: ${h}`),extra:{},blockers:[]}}]);return {status:0,stdout:'ingested',stderr:''};}
    return {status:0,stdout:args[0].endsWith('dispatch.mjs')?JSON.stringify({result:'detached',journal:path.join(f.org,'dispatch',`new-${calls.length}.json`)}):'{}',stderr:''};};
  const service=()=>createLineService({repo:f.cwd,org:f.org,to:'brain-chat',env:f.env,command,capacity:()=>({cap:2,count:0}),recordNotice:d=>({id:d.id,state:'record-only'}),maxStarts:2});
  service().pass();assert.equal(calls.filter(a=>a[0].endsWith('dispatch.mjs')).length,2);assert.ok(calls.filter(a=>a[0].endsWith('dispatch.mjs')).every(a=>a.includes('--detach')));
  service().pass();assert.equal(f.context().run.report.outcome,'done');assert.equal(calls.some(a=>a[0]==='agent'),false);
});

test('phase1 measured inactive owned child failure does not freeze independent work or replay a native launch',t=>{
  const f=fixture(t,{reported:false});fs.mkdirSync(path.join(f.org,'runs/R-1'),{recursive:true});fs.writeFileSync(path.join(f.org,'runs/R-1/report.md'),f.report);f.add([{type:'item.added',id:'ENG-2',title:'Ready',role:'engineer'}]);
  const calls=[];const command=(_exe,args,options)=>{calls.push(args);assert.equal(options.timeout,0);if(args[1]==='ingest')return {status:null,signal:'SIGTERM',stdout:'',stderr:'confirmed inactive owned child',signal_sent:true,activity:{observations:[{kind:'frozen',silence_s:2,inactivity_s:2}]}};return {status:0,stdout:'{}',stderr:''};};
  createLineService({repo:f.cwd,org:f.org,to:'brain-chat',env:f.env,command,capacity:()=>({cap:1,count:0}),recordNotice:d=>({id:d.id}),childTimeoutMs:30,maxStarts:1}).pass();
  assert.ok(calls.some(a=>a[0].endsWith('dispatch.mjs')));assert.equal(fs.existsSync(path.join(f.directory,'pass.lock')),false);
});

test('phase1 three repeated failures make one record-inbox alert and every pass writes a heartbeat',t=>{
  const f=fixture(t,{reported:false});fs.mkdirSync(path.join(f.org,'runs/R-1'),{recursive:true});fs.writeFileSync(path.join(f.org,'runs/R-1/report.md'),f.report);const notes=[];
  const options={repo:f.cwd,org:f.org,to:'brain-chat',env:f.env,command:()=>({status:1,stdout:'',stderr:'temporarily locked'}),capacity:()=>({cap:1,count:0}),recordNotice:d=>{notes.push(d);return {id:d.id};}};
  for(let n=0;n<3;n++)createLineService(options).pass();assert.equal(notes.filter(n=>n.boundary.startsWith('ingest:')).length,1);
  const heartbeat=JSON.parse(fs.readFileSync(path.join(f.directory,'heartbeat.json')));assert.ok(heartbeat.at);assert.equal(heartbeat.project,f.identity);
});

test('phase1 cleanup identity survives unrelated main landings and competing kick leaves ownership with the line',t=>{
  const f=configFixture(t,{custom:true});fs.mkdirSync(path.join(f.cwd,'supervisor'));fs.mkdirSync(path.join(f.cwd,'lib'));
  fs.writeFileSync(path.join(f.cwd,'supervisor/closeout.mjs'),"import '../lib/closer.mjs';\n");fs.writeFileSync(path.join(f.cwd,'lib/closer.mjs'),'export const closer=1;\n');f.git('add','.');f.git('commit','-qm','Closer payload');
  const before=closeoutCodeIdentity(f.cwd),bound=bindCloseoutCode(gitProject(f.cwd),{identity:before});fs.writeFileSync(path.join(f.cwd,'unrelated.txt'),'another landing');f.git('add','.');f.git('commit','-qm','Unrelated landing');const after=closeoutCodeIdentity(f.cwd);assert.equal(before.files,after.files);bound.verify();
  fs.writeFileSync(path.join(f.cwd,'lib/closer.mjs'),'export const closer=2;\n');f.git('add','.');f.git('commit','-qm','Changed closer code');assert.throws(()=>bound.verify(),e=>e.code==='CLOSEOUT_CODE_CHANGED');
  const project=gitProject(f.cwd),directory=serviceDirectory(f.env.ORG_DIR,project.identity);fs.mkdirSync(directory,{recursive:true});fs.writeFileSync(path.join(directory,'installation.json'),JSON.stringify({repo:f.cwd,org:f.env.ORG_DIR,source:sourceRoot,node:process.execPath,file:path.join(directory,'service.plist'),target:`gui/${process.getuid()}/dev.herdr.line.${path.basename(directory)}`}));
  assert.equal(kickCloseout(project,f.env.ORG_DIR,{env:f.env}).owned_by,'line-service');
});

test('phase1 pending pre-effect closeout source handoff continues its original keys instead of becoming complete',t=>{
  const f=fixture(t),policy=JSON.parse(fs.readFileSync(path.join(f.cwd,'.lane.json'),'utf8'));policy.retirement={closeout_queue:true};fs.writeFileSync(path.join(f.cwd,'.lane.json'),JSON.stringify(policy));
  const added=transact(f.org,events=>bindCloseoutSources({cwd:f.cwd,org:f.org,events,env:f.env,mutation:{add:[{type:'item.closed',id:'ENG-1',as:'done',completed_run:'R-1'}]}})).added;
  publishCloseoutEvents({cwd:f.cwd,org:f.org,added,start:false,env:f.env});
  const key=added[0].closeout_targets.find(t=>t.signal==='landed').key,calls=[];
  const service=createLineService({repo:f.cwd,org:f.org,to:'brain-chat',env:f.env,capacity:()=>({count:0,cap:4}),recordNotice:data=>({id:data.id,state:'record-only'}),command:(_exe,args)=>{
    if(args[0]===path.join(sourceRoot,'supervisor/closeout.mjs')){
      calls.push(args);assert.deepEqual(JSON.parse(args[args.indexOf('--keys')+1]),[key]);
      return{status:0,stdout:JSON.stringify(calls.length===1?{evaluated:[],restart:{keys:[key],old:{source:'old'},current:{source:'new'}},successor:{pending:true,reason:'fresh drain required',keys:[key]}}:{evaluated:[{key,run:'R-1',completed:true}]}),stderr:''};
    }
    return{status:0,stdout:'{}',stderr:''};
  }});
  service.pass();const file=path.join(service.directory,'effects.json'),journal=JSON.parse(fs.readFileSync(file,'utf8'));
  const entry=Object.values(journal.actions).find(e=>e.result?.restart);assert.equal(entry.state,'held');
  // Retain compatibility with the actual previously written complete receipt.
  entry.state='complete';delete entry.error;fs.writeFileSync(file,JSON.stringify(journal));
  service.pass();service.pass();assert.equal(calls.length,2,'one fresh drain, then completed effect stays complete');
  const completed=JSON.parse(fs.readFileSync(file,'utf8')),final=Object.values(completed.actions).find(e=>e.result?.evaluated?.[0]?.key===key);
  assert.equal(final.state,'complete');assert.equal(final.history[0].result.successor.pending,true);
  assert.equal(final.result.evaluated[0].completed,true);
  final.result={...final.history[0].result,evaluated:[{key,completed:false,reason:'unresolved native exit intent'}]};
  fs.writeFileSync(file,JSON.stringify(completed));service.pass();assert.equal(calls.length,2,'a native/ambiguous evaluated request is not a pre-effect handoff');
});

test('phase1 service retains unknown exit authority while scheduling only the original supported outcome readback',t=>{
  const f=fixture(t),policy=JSON.parse(fs.readFileSync(path.join(f.cwd,'.lane.json'),'utf8'));policy.retirement={closeout_queue:true};fs.writeFileSync(path.join(f.cwd,'.lane.json'),JSON.stringify(policy));
  const a=f.observation.agents[0];f.add([{type:'run.updated',id:'R-1',meta:{agent:a.name,pane:a.pane_id,worker_workspace:a.workspace_id,terminal_id:a.terminal_id,agent_session_id:a.agent_session.value}}]);
  const added=transact(f.org,events=>bindCloseoutSources({cwd:f.cwd,org:f.org,events,env:f.env,mutation:{add:[{type:'item.closed',id:'ENG-1',as:'done',completed_run:'R-1'}]}})).added;
  publishCloseoutEvents({cwd:f.cwd,org:f.org,added,start:false,env:f.env});const target=added[0].closeout_targets.find(t=>t.signal==='landed'),source={seq:added[0].seq,type:'item.closed'};
  f.add([{type:'closeout.effect',key:target.key,identity:f.identity,source,outcome:{action:'agent-exit-requested',run:'R-1',pane:a.pane_id,tab_id:a.tab_id,occupant:[a.name,a.agent,a.pane_id,a.workspace_id,f.workspace,a.terminal_id,a.agent_session.value],shell:{pid:1,identity:'original-shell',command:'[zsh]'}}},
    {type:'closeout.evaluated',key:target.key,completed:false,revision:source.seq,reason:CLOSEOUT_EXIT_PENDING}]);
  const calls=[],service=createLineService({repo:f.cwd,org:f.org,to:'brain-chat',env:f.env,capacity:()=>({count:0,cap:4}),recordNotice:data=>({id:data.id,state:'record-only'}),command:(_exe,args)=>{
    if(args[0]===path.join(sourceRoot,'supervisor/closeout.mjs')){calls.push(args);assert.ok(args.includes('--retry-safe'));assert.deepEqual(JSON.parse(args[args.indexOf('--keys')+1]),[target.key]);return{status:0,stdout:JSON.stringify({evaluated:[{key:target.key,run:'R-1',completed:false,reason:CLOSEOUT_EXIT_PENDING}]}),stderr:''};}
    return{status:0,stdout:'{}',stderr:''};
  }});
  service.pass();service.pass();assert.equal(calls.length,2,'pending identity/outcome wording is an observation protocol, not a native-identity waiver or a completed effect');
  const entry=Object.values(JSON.parse(fs.readFileSync(path.join(service.directory,'effects.json'),'utf8')).actions).find(e=>e.result?.evaluated?.[0]?.key===target.key);
  assert.equal(entry.state,'held');assert.equal(entry.history.length,1);assert.equal(f.context().events.some(e=>e.type==='closeout.effect'&&e.outcome?.action==='exit-observed'),false);
});

test('phase1 morning digest is record-derived and marks unknown durations rather than inventing zero',()=>{
  const events=[{type:'item.added',id:'ENG-1',role:'engineer',title:'Build',seq:1,at:'2026-10-27T01:00:00Z'},{type:'run.started',id:'R-1',item:'ENG-1',seq:2,at:'2026-10-27T01:01:00Z'},
    {type:'change.landed',item:'ENG-1',run:'R-1',head:'a'.repeat(40),landed_at:'2026-10-27T01:03:00Z',seq:3,at:'2026-10-27T01:04:00Z'},
    {type:'change.reviewed',item:'ENG-1',head:'a'.repeat(40),verdict:'PASS',findings:[],seq:4,at:'2026-10-27T01:05:00Z'}];
  const result=morningDigest({events,since:'2026-10-27T00:00:00Z',now:'2026-10-27T02:00:00Z'});assert.equal(result.landings.length,1);assert.equal(result.reviews.length,1);assert.equal(result.landings[0].build_to_main_minutes,2);assert.equal(result.idle_hours,null);
});
