import test from './helpers/bounded-test.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {configFixture} from './helpers/config-home-fixture.mjs';
import {gitProject} from '../lib/project.mjs';
import {loadEvents,transact} from '../lib/store.mjs';
import {fold} from '../lib/state.mjs';
import {noticeLock} from '../supervisor/notice-lock.mjs';
import {sourceRoot,serviceDirectory} from '../line-service/line-service.mjs';
import {queueReviewMutation,validateQueuedReview} from '../line-service/review-queue.mjs';
import {observeReviewProgress,recoverServiceReview} from '../line-service/review-recovery.mjs';
import {reviewResolution} from '../line-service/review-resolutions.mjs';
import {checkSessionCap} from '../dispatch/session-cap.mjs';
const hash=v=>createHash('sha256').update(v).digest('hex');

function fixture(t,{started=false,phase='open'}={}){
  const f=configFixture(t,{custom:true}),org=f.env.ORG_DIR,identity=gitProject(f.cwd).identity,base=f.git('rev-parse','HEAD');fs.writeFileSync(path.join(f.cwd,'code.mjs'),'export const source=1;\n');f.git('add','code.mjs');f.git('commit','-qm','Actual landed source');const head=f.git('rev-parse','HEAD');
  const owner={controller:'brain',legacy:false,release:{id:'source',root:sourceRoot,commit:null,identity:gitProject(sourceRoot).identity}},sourceDispatch=path.join(org,'dispatch/source.json');fs.mkdirSync(path.dirname(sourceDispatch),{recursive:true});fs.writeFileSync(sourceDispatch,JSON.stringify({token:'source',stage:'complete',item:'ENG-1',run:'R-1',repo:f.cwd,org,common:identity,workspace:f.cwd,base}));
  const text=`---\nrun: R-1\noutcome: done\nsummary: Landed source.\nartifacts:\n  - "Commit: ${head}"\n---\n`;fs.writeFileSync(path.join(org,'reports/R-1.md'),text);
  const add=rows=>transact(org,()=>({add:rows})),context=()=>{const events=loadEvents(org).events;return{events,state:fold(events),org,repo:f.cwd,identity};};
  add([{type:'line-service.phase0',id:'boundary',project:identity,repo:f.cwd,org,main:'main',canonical_head:base},{type:'item.added',id:'ENG-1',role:'engineer',title:'Source'},
    {type:'run.started',id:'R-1',item:'ENG-1',workspace:f.cwd,meta:{dispatch_journal:sourceDispatch,dispatch_attempt:'source',dispatch_project:identity}}, {type:'run.claimed',run:'R-1',project:identity,record:org,owner},
    {type:'report.ingested',run:'R-1',file:'reports/R-1.md',sha256:hash(text),report:{outcome:'done',artifacts:[`Commit: ${head}`],extra:{},blockers:[],proposals:[]}}]);
  const env={...f.env,ORG_ACTOR:'line-service',HERDR_BRAIN_ROOT:sourceRoot};for(const k of ['HERDR_ENV','HERDR_PANE_ID','CODEX_THREAD_ID'])delete env[k];const before=process.cwd();process.chdir(f.cwd);let queued;try{queued=queueReviewMutation({...context(),runId:'R-1',env});add(queued.add);}finally{process.chdir(before);}
  const qid=queued.result.review_item,target=context().state.items.get(qid).meta.review_target,workspace=path.join(f.scratch,'review-lane');f.git('worktree','add','-qb','lane/review-one',workspace);
  const journal=path.join(org,'dispatch/original.json'),worker={agentName:'reviewer',pane:'review:p',workspaceId:'review-w',terminalId:'review-terminal',agentSessionId:'review-session'},job={token:'original',repo:f.cwd,org,common:identity,release:{root:sourceRoot,protocol:1},item:qid,lane:'review-one',workspace,reviewQueueProtocol:1,reviewQueue:target,stage:started?'complete':phase,run:started?'R-2':null,...(started?{worker,launchProcess:{pid:44444,identity:'original-birth'},native_launch_attempted:true}:{})};fs.writeFileSync(journal,JSON.stringify(job));
  if(started)add([{type:'run.started',id:'R-2',item:qid,workspace,report_path:path.join(org,'runs/R-2/report.md'),meta:{dispatch_project:identity,dispatch_journal:journal,dispatch_attempt:'original',dispatch_role:'review',agent:worker.agentName,pane:worker.pane,worker_workspace:worker.workspaceId,terminal_id:worker.terminalId,agent_session_id:worker.agentSessionId}}, {type:'run.claimed',run:'R-2',project:identity,record:org,owner}]);
  const directory=serviceDirectory(org,identity);fs.mkdirSync(directory,{recursive:true});fs.writeFileSync(path.join(directory,'installation.json'),JSON.stringify({at:'2026-10-27T00:00:00Z',repo:f.cwd,org,source:sourceRoot,node:process.execPath,file:path.join(directory,'service.plist'),target:`gui/${process.getuid()}/dev.herdr.line.${path.basename(directory)}`}));
  const effects={identity,org,pass_number:0,actions:{[`review:ENG-1:${head}`]:{state:'complete',review_operation:'record-queue',review_target:target,result:{review_item:qid}}}},effectFile=path.join(directory,'effects.json');
  const pass=()=>{effects.pass_number++;const observed=observeReviewProgress({...context(),pass:effects.pass_number,previous:effects.review_progress});effects.review_progress=observed.progress;fs.writeFileSync(effectFile,JSON.stringify(effects));return observed;};
  const calls=[],agents=[];let lists=0,lateLive=false;const call=(_exe,args)=>{calls.push(args);if(args[0]==='agent'){lists++;return JSON.stringify({result:{agents:lateLive&&lists===2?[{name:'reviewer',pane_id:'review:p',cwd:workspace}]:agents}});}return JSON.stringify({error:{code:'pane_not_found'}});};
  const args={repo:f.cwd,org,reviewId:qid,env,call,kill:()=>{throw Object.assign(Error('gone'),{code:'ESRCH'});},readProcess:()=>({ok:true,value:null})};
  const invoke=extra=>{const cwd=process.cwd(),release=noticeLock(path.join(directory,'pass.lock'));process.chdir(f.cwd);try{return recoverServiceReview({...args,...extra});}finally{process.chdir(cwd);release();}};
  return{...f,org,identity,head,owner,target,qid,job,journal,effects,effectFile,directory,workspace,worker,env,add,context,pass,invoke,calls,agents,setLateLive:v=>{lateLive=v;lists=0;}};
}

test('automatic progress archives an unchanged serialized pre-start request once without inventing a zero launch and queues its exact whole group',t=>{
  const f=fixture(t),bytes=fs.readFileSync(f.journal);fs.mkdirSync(f.journal+'.driver');fs.writeFileSync(f.journal+'.driver/results.jsonl','Original timeout/unknown receipt; preserve.\n');assert.equal(f.pass().candidates.length,0);assert.throws(()=>f.invoke(),/unchanged original-request proof/);assert.deepEqual(f.pass().candidates,[f.qid]);
  fs.writeFileSync(f.journal+'.lock','55555');const result=f.invoke(),c=f.context(),event=c.events.find(e=>e.type==='review.recovery-completed'),q=c.state.items.get(result.review_item);
  assert.notEqual(q.id,f.qid);assert.deepEqual(q.meta.review_target,f.target);assert.equal(q.meta.review_round_cap,1);assert.equal(c.state.items.get(f.qid).closed.as,'dropped');assert.equal(event.inactivity.original_native_launch_attempted,null);assert.equal(event.inactivity.kind,'serialized-pre-record-start-barrier');assert.equal(event.native_caller,undefined);assert.equal(event.service_authority.kind,'installed-service-progress');assert.deepEqual(fs.readFileSync(f.journal),bytes);
  assert.ok(reviewResolution({...c,item:'ENG-1',head:f.head}).files.has(f.journal+'.driver/results.jsonl'));assert.equal(validateQueuedReview({...c,item:q}).head,f.head);assert.equal(checkSessionCap({config:{dispatch:{max_sessions:1,max_review_sessions:1}},org:f.org,common:f.identity,kind:'review'}).count,0);
  f.pass();assert.deepEqual(f.pass().candidates,[]);assert.equal(f.context().events.filter(e=>e.type==='review.recovery-completed').length,1);assert.ok(f.calls.every(a=>a[0]==='agent'&&a[1]==='list'));
});

test('automatic progress ends a genuinely absent bound reviewer with no verdict and preserves its original native intent journal',t=>{
  const f=fixture(t,{started:true}),bytes=fs.readFileSync(f.journal);f.pass();f.pass();const result=f.invoke(),c=f.context();assert.equal(c.state.runs.get('R-2').abandoned.by,'line-service');assert.equal(c.events.some(e=>e.type==='change.reviewed'),false);assert.equal(c.state.items.get(result.review_item).runs.length,0);assert.deepEqual(fs.readFileSync(f.journal),bytes);assert.ok(f.calls.some(a=>a[0]==='pane'&&a[1]==='get'));assert.ok(f.calls.every(a=>!['prompt','close','wait'].includes(a[1])));
  const g=fixture(t,{started:true});g.pass();g.pass();assert.equal(g.invoke({call:(_exe,args)=>{if(args[0]==='pane')throw Error('{"error":{"code":"pane_not_found"}}');return'{"result":{"agents":[]}}';}}).result,'review_queued');
});

test('automatic progress resumes its same immutable preparation after a late native presence and unrelated service journal updates',t=>{
  const f=fixture(t);f.pass();f.pass();f.setLateLive(true);assert.throws(()=>f.invoke(),/became live/);const pending=f.context().events.find(e=>e.type==='review.recovery-intent');assert.ok(pending);assert.equal(f.context().events.some(e=>e.type==='review.recovery-completed'),false);
  const file=path.join(f.org,'evidence/review-recovery',pending.id,'manifest.json'),bytes=fs.readFileSync(file);f.setLateLive(false);f.pass();f.invoke();assert.deepEqual(fs.readFileSync(file),bytes);assert.equal(f.context().events.filter(e=>e.type==='review.recovery-intent').length,1);assert.equal(f.context().events.filter(e=>e.type==='review.recovery-completed').length,1);
});

test('automatic progress retains active unknown native refusals partial captures new reports STOP and ownership changes',t=>{
  for(const kind of ['active','owner-live','unknown-process','launch-unknown','native-refusal','partial','report','STOP','claim']){
    const f=fixture(t,{started:['active','unknown-process','report','claim'].includes(kind),phase:kind==='launch-unknown'?'launching':'open'});f.pass();f.pass();let options={};
    if(kind==='active')f.agents.push({name:'reviewer',pane_id:'review:p',cwd:f.workspace});
    if(kind==='owner-live'){fs.writeFileSync(f.journal+'.lock','55555');options.kill=()=>{};}
    if(kind==='unknown-process')options.readProcess=()=>({ok:false,error:'EPERM'});
    if(kind==='native-refusal'){fs.writeFileSync(f.journal,JSON.stringify({...f.job,error:'EPERM native refusal'}));f.pass();f.pass();}
    if(kind==='partial')f.add([{type:'item.added',id:'REV-99',role:'reviewer',title:'Retained partial',meta:{review_source_item:'ENG-1',review_source_run:'R-1',review_target:f.target,review_round_cap:1,hold:true}}]);
    if(kind==='report'){fs.mkdirSync(path.join(f.org,'runs/R-2'),{recursive:true});fs.writeFileSync(path.join(f.org,'runs/R-2/report.md'),'Actual incoming report; preserve.');}
    if(kind==='STOP')fs.writeFileSync(path.join(f.directory,'STOP'),'stopped');
    if(kind==='claim')f.add([{type:'run.claimed',run:'R-2',project:f.identity,record:f.org,owner:{...f.owner,controller:'foreign'}}]);
    if(['active','owner-live'].includes(kind))assert.equal(f.invoke(options).result,'review_retained');else assert.throws(()=>f.invoke(options),/UNKNOWN|refusal|partial|report|STOP|OWNED|owner|controller|CAS/i,kind);
    assert.equal(f.context().events.some(e=>e.type==='review.recovery-completed'),false,kind);assert.equal(f.context().state.items.get(f.qid).closed,null,kind);
  }
});
