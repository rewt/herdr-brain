import test from './helpers/bounded-test.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {closeoutWaitState,registerCloseoutWait,linkedCloseoutStatuses,nativeCloseoutWait,closeoutProducer,closeoutNextStage,closeoutCommandNotStarted} from '../lib/closeout-status.mjs';
import {closeoutRevision,bindCloseoutSources,unresolvedCloseoutEffect} from '../lib/closeout.mjs';
import {outcomeFailure,uncertainOutcomeDoctrine} from '../lib/uncertain-outcome.mjs';
import {originalDispatchOutcome} from '../dispatch/outcome.mjs';
import {recordDispatchCompletion} from '../dispatch/completion.mjs';
import {configFixture} from './helpers/config-home-fixture.mjs';
import {gitProject} from '../lib/project.mjs';
import {transact,loadEvents} from '../lib/store.mjs';
import {fold} from '../lib/state.mjs';
import {noticeLock} from '../supervisor/notice-lock.mjs';
import {serviceDirectory,sourceRoot,createLineService} from '../line-service/line-service.mjs';
import {queueOutcomeDecision} from '../line-service/outcome-decision.mjs';
const entry={common:'/project/.git',org:'/project/.org',project:'/project',key:'a'.repeat(64),source:{seq:1,type:'item.closed'},run:'R-1',item:'ENG-1',cwd:'/lane',head:'c'.repeat(40),branch:'lane/topic',worktreeIdentity:{ino:1}};
const prior={revision:4,reason:'R-1 report is not ingested',completed:false};
const events=[{type:'item.added',id:'ENG-1',role:'engineer',title:'Subject',seq:1},{type:'run.started',id:'R-1',item:'ENG-1',workspace:'/lane',seq:2},{type:'run.claimed',run:'R-1',seq:3,owner:{controller:'brain',legacy:false},record:entry.org,project:entry.common}];
const append=(history,add)=>[...history,...add.map((e,i)=>({...e,seq:history.at(-1).seq+i+1,at:'2026-10-27T00:00:00Z'}))];

test('producer linked worker-report waits sleep through passes manual retries and unrelated changes until exact recorded completion',()=>{
  const waiting=registerCloseoutWait(entry,prior,events,[entry]);assert.equal(waiting.length,1);
  let history=append(events,waiting),wait=history.at(-1);assert.equal(wait.waiting.producers[0].claim,3);assert.equal(closeoutWaitState(wait,history),'pending');
  history=append(history,[{type:'closeout.retry',keys:[entry.key]},{type:'item.closed',id:'ENG-other',as:'done'}]);
  for(let i=0;i<100;i++)assert.equal(closeoutRevision(entry,history),prior.revision);
  assert.deepEqual(registerCloseoutWait(entry,prior,history,[entry]),[]);
  const report={type:'report.ingested',run:'R-1',item:'ENG-1',report:{outcome:'done'}};
  const links=linkedCloseoutStatuses(history,[report]);assert.equal(links.length,1);history=append(history,[report,...links]);
  assert.equal(closeoutWaitState(wait,history),'complete');assert.ok(closeoutRevision(entry,history)>prior.revision);
  assert.equal(linkedCloseoutStatuses(history,[report]).length,0);
  const wrong=structuredClone(history);wrong.find(e=>e.type==='closeout.producer-status').completion.seq=9999;
  assert.equal(closeoutWaitState(wait,wrong),'pending','a status cannot invent its actual completion writer');
});

test('producer linked report ownership changes and other subjects cannot satisfy an original wait',()=>{
  const wait=registerCloseoutWait(entry,prior,events,[entry])[0],history=append(events,[wait,{type:'run.claimed',run:'R-1',owner:{controller:'brain',legacy:false}}]);
  assert.deepEqual(linkedCloseoutStatuses(history,[{type:'report.ingested',run:'R-1',report:{outcome:'done'}}]),[]);
  assert.deepEqual(linkedCloseoutStatuses(append(events,[wait]),[{type:'report.ingested',run:'R-other',report:{outcome:'done'}}]),[]);
});

test('producer linked lane-removal completion wakes only its exact dependent entry and preserves failure truth',()=>{
  // A ready twin is owned progress and registers no wait; a wait already
  // recorded with this lane-removal producer still links only its exact receipt.
  const owner={...entry,key:'b'.repeat(64),signal:'landed'},twin={...prior,reason:'landed or parked request owns the remaining bound sessions'};
  assert.deepEqual(registerCloseoutWait({...entry,signal:'ready'},twin,events,[entry,owner]),[]);
  const wait={type:'closeout.waiting',identity:entry.common,key:entry.key,source:entry.source,revision:prior.revision,wait_id:'recorded-twin',waiting:closeoutProducer(entry,twin,{events,entries:[entry,owner]})};
  let history=append(events,[wait]);const effect={type:'closeout.effect',identity:entry.common,key:owner.key,source:owner.source,outcome:{action:'lane-removed',cwd:entry.cwd,tip:entry.head}};
  assert.equal(linkedCloseoutStatuses(history,[{...effect,key:entry.key}]).length,0);
  const links=linkedCloseoutStatuses(history,[effect]);assert.equal(links.length,1);history=append(history,[effect,...links]);assert.equal(closeoutWaitState(wait,history),'complete');
  const reportWait=registerCloseoutWait(entry,prior,events,[entry])[0],base=append(events,[reportWait]),failure={type:'report.ingested',run:'R-1',report:{outcome:'failed'}};
  assert.equal(closeoutWaitState(reportWait,append(base,[failure,...linkedCloseoutStatuses(base,[failure])])),'failed');
});

test('producer linked native command writes only observed exit or actual close response and retains failed commands',()=>{
  const row={action:'agent-exit-requested',pane:'pane',occupant:['worker','codex','pane','workspace','/lane','terminal','session']},wait=nativeCloseoutWait(entry,row,'intent'),base=append(events,[{type:'closeout.effect',effect:'intent',identity:entry.common,key:entry.key,source:entry.source,outcome:row},wait]);
  const observed={type:'closeout.effect',identity:entry.common,key:entry.key,source:entry.source,outcome:{action:'exit-observed',pane:'pane',occupant:{terminal_id:'terminal',agent_session_id:'session'}}};
  assert.equal(linkedCloseoutStatuses(base,[{...observed,outcome:{...observed.outcome,occupant:{terminal_id:'other',agent_session_id:'session'}}}]).length,0);
  assert.equal(closeoutWaitState(wait,append(base,[observed,...linkedCloseoutStatuses(base,[observed])])),'complete');
  const failure={type:'closeout.command-failed',identity:entry.common,key:entry.key,source:entry.source,failure:{code:'EACCES'}};
  assert.equal(closeoutWaitState(wait,append(base,[failure,...linkedCloseoutStatuses(base,[failure])])),'failed');
  assert.equal(closeoutProducer(entry,{...prior,reason:'unresolved native exit/close intent retained'},{events,entries:[entry]}).producers.length,0);
  assert.match(closeoutProducer(entry,{...prior,reason:'retirement held: HOLD-WORKER-TAB-CLOSE'},{events,entries:[entry]}).defect,/no existing record completion writer/);
});

test('producer linked unsent intent isolates later attempts',()=>{
  for(const row of [{action:'agent-exit-requested',pane:'pane',occupant:['worker','codex','pane','workspace','/lane','terminal','session']},
    {action:'shell-close-requested',tab_id:'tab',panes:[{pane:'pane',terminal:'terminal'}]},{action:'workspace-close-requested',workspace_id:'workspace'}]){
    const effect=id=>({type:'closeout.effect',effect:id,identity:entry.common,key:entry.key,source:entry.source,outcome:row}),
      original=nativeCloseoutWait(entry,row,'unsent'),later=nativeCloseoutWait(entry,row,'actual'),
      unsent=closeoutCommandNotStarted(entry,'unsent',row.action,Object.assign(Error('code changed'),{code:'CLOSEOUT_CODE_CHANGED'}));
    let history=append(events,[effect('unsent'),original]);history=append(history,[unsent,...linkedCloseoutStatuses(history,[unsent])]);
    const originalEvidence=structuredClone(history);assert.equal(closeoutWaitState(original,history),'complete');assert.equal(unresolvedCloseoutEffect(entry,history),undefined);
    history=append(history,[effect('actual'),later]);assert.notEqual(later.wait_id,original.wait_id);assert.equal(closeoutWaitState(later,history),'pending');assert.deepEqual(unresolvedCloseoutEffect(entry,history),row);
    assert.deepEqual(linkedCloseoutStatuses(history,[unsent]),[],'an earlier unsent receipt cannot complete the later producer');
    const failure={type:'closeout.command-failed',identity:entry.common,key:entry.key,source:entry.source,intent:'actual',failure:{code:'OUTCOME_UNKNOWN'}};
    assert.deepEqual(linkedCloseoutStatuses(history,[{...failure,intent:'unsent'}]),[],'failure ownership is exact');
    const links=linkedCloseoutStatuses(history,[failure]);assert.equal(links.length,1);assert.equal(links[0].producer.intent,'actual');
    history=append(history,[failure,...links]);assert.equal(closeoutWaitState(later,history),'failed');assert.deepEqual(unresolvedCloseoutEffect(entry,history),row);
    const outcome=row.action==='agent-exit-requested'?{action:'exit-observed',pane:'pane',occupant:{terminal_id:'terminal',agent_session_id:'session'}}:
      row.action==='shell-close-requested'?{action:'closed',tab_id:'tab'}:{action:'closed',workspace_id:'workspace'},
      completion={type:'closeout.effect',identity:entry.common,key:entry.key,source:entry.source,intent:'actual',outcome};
    assert.deepEqual(linkedCloseoutStatuses(history,[{...completion,intent:'unsent'}]),[]);
    assert.deepEqual(linkedCloseoutStatuses(history,[{...completion,source:{seq:999,type:'item.closed'}}]),[]);
    assert.equal(closeoutWaitState(later,history),'failed');
    const completed=linkedCloseoutStatuses(history,[completion]);assert.equal(completed.length,1);assert.equal(completed[0].producer.intent,'actual');assert.equal(completed[0].status,'complete');
    history=append(history,[completion,...completed]);assert.equal(closeoutWaitState(later,history),'complete');assert.equal(unresolvedCloseoutEffect(entry,history),undefined);
    assert.equal(closeoutWaitState(original,history),'complete');assert.deepEqual(history.slice(0,originalEvidence.length),originalEvidence);
    assert.deepEqual(linkedCloseoutStatuses(history,[failure,completion]),[],'completed attempts remain immutable and are not failed again');
  }
});

test('producer linked typed failures and positive no-execution never infer native absence from missing fields',t=>{
  assert.equal(outcomeFailure({message:'native identity reserved supervisor judgment'}).kind,'unknown');assert.equal(outcomeFailure({code:'EACCES'}).kind,'fence');
  const f=configFixture(t,{custom:true}),org=f.env.ORG_DIR,repo=f.cwd,common=gitProject(repo).identity,dir=path.join(org,'dispatch');fs.mkdirSync(dir,{recursive:true});
  const file=path.join(dir,'original.json'),brief=path.join(org,'ask.md'),job={token:'original',repo,org,common,item:'ENG-1',brief,stage:'open',native_launch_attempted:false,error:'pre-native input changed',failure:{code:'DISPATCH_IMPLEMENTATION_CHANGED',stage:'open',native_launch_attempted:false}},input={repo,org,common,item:'ENG-1',brief,events:[]};
  fs.writeFileSync(file,JSON.stringify(job));assert.equal(originalDispatchOutcome(input).status,'retained');
  fs.mkdirSync(file+'.driver');fs.writeFileSync(file+'.driver/results.jsonl',JSON.stringify({journal:file,stage:'open',exit_code:1,error:job.error,code:job.failure.code,native_launch_attempted:false})+'\n');
  assert.equal(originalDispatchOutcome(input).status,'not-started');
  fs.writeFileSync(file,JSON.stringify({...job,native_launch_attempted:undefined}));assert.equal(originalDispatchOutcome(input).status,'retained');
  fs.writeFileSync(file,JSON.stringify({...job,completion_protocol:1}));fs.writeFileSync(file+'.lock',String(process.pid));
  transact(org,()=>({add:[{type:'item.added',id:'ENG-1',role:'engineer',title:'Original dispatch'}]}));
  recordDispatchCompletion({job:{...job,completion_protocol:1},journal:file,exitCode:1});recordDispatchCompletion({job:{...job,completion_protocol:1},journal:file,exitCode:1});
  assert.equal(loadEvents(org).events.filter(e=>e.type==='dispatch.completed').length,1);
});

test('producer linked missing-producer decision deduplicates through normal owned queue without blocking independent work',t=>{
  const f=configFixture(t,{custom:true}),repo=f.cwd,org=f.env.ORG_DIR,identity=gitProject(repo).identity,directory=serviceDirectory(org,identity);
  fs.mkdirSync(directory,{recursive:true});fs.writeFileSync(path.join(directory,'installation.json'),JSON.stringify({at:'2026-10-27T00:00:00Z',repo,org,source:sourceRoot,node:process.execPath,file:path.join(directory,'service.plist'),target:`gui/${process.getuid()}/dev.herdr.line.${path.basename(directory)}`}));
  transact(org,()=>({add:[{type:'item.added',id:'ENG-1',role:'engineer',title:'Original subject'}]}));
  const env={...f.env};delete env.HERDR_ENV;delete env.HERDR_PANE_ID;
  const release=noticeLock(path.join(directory,'pass.lock')),check={key:'original',subject:{item:'ENG-1',head:'captured'},defect:'Runtime completion transport absent'};
  try{const a=queueOutcomeDecision({repo,org,env,check});assert.deepEqual(queueOutcomeDecision({repo,org,env,check}),a);const state=fold(loadEvents(org).events);assert.equal(state.items.get(a.item).role,'decision');assert.equal(state.links.length,0);assert.match(state.items.get(a.item).accept[0],/^Why:[\s\S]*How we will know it works:/);assert.ok(state.items.get(a.item).accept[0].includes(uncertainOutcomeDoctrine));}finally{release();}
});

test('producer linked completed pass health remains diagnostic with no bulk record telemetry',t=>{
  const f=configFixture(t,{custom:true}),service=createLineService({repo:f.cwd,org:f.env.ORG_DIR,to:'brain-chat',env:f.env,command:()=>({status:0,stdout:'{}',stderr:''}),capacity:()=>({cap:7,count:0})});
  service.pass();const row=fs.readFileSync(path.join(service.directory,'passes.jsonl'),'utf8').trim().split('\n').map(JSON.parse).findLast(r=>r.action==='pass-complete');
  for(const field of ['unknown_open','unknown_oldest_min','unknown_settled','unknown_escalated'])assert.equal(row[field],0);
  assert.equal(loadEvents(f.env.ORG_DIR).events.some(e=>e.type?.includes('unknown')),false);
});

test('producer linked midpoint and ready-twin stages are owned progress while refusals and unknown intents stay single decisions',()=>{
  const midpoint={revision:4,completed:false,sessions_retired:true,reason:'bound sessions retired; physical cleanup remains queued'};
  assert.deepEqual(closeoutNextStage(entry,midpoint,events),{stage:'physical',ready:true});
  for(let i=0;i<100;i++)assert.deepEqual(registerCloseoutWait(entry,midpoint,events,[entry]),[],'repeated folded progress registers no wait');
  assert.equal(closeoutNextStage(entry,{...midpoint,sessions_retired:undefined},events),undefined,'the label alone is not a stage fact');
  const ready={...entry,key:'d'.repeat(64),signal:'ready',panes:[]},owner={...ready,key:'e'.repeat(64),signal:'landed',source:{seq:4,type:'item.closed'}};
  const twin={revision:4,completed:false,reason:'landed or parked request owns the remaining bound sessions; awaiting its retirement effects'};
  const bound=append(events,[{type:'item.closed',id:'ENG-1',as:'done',closeout_targets:[{key:owner.key,panes:owner.panes}]}]);
  assert.deepEqual(closeoutNextStage(ready,twin,bound,[ready,owner]),{stage:'twin-removal',ready:false});
  assert.deepEqual(registerCloseoutWait(ready,twin,bound,[ready,owner]),[]);
  assert.deepEqual(closeoutNextStage(ready,twin,append(bound,[{type:'closeout.evaluated',key:owner.key,completed:true}]),[ready,owner]),{stage:'twin-removal',ready:true});
  assert.deepEqual(closeoutNextStage(ready,twin,bound,[ready]),{stage:'twin-removal',ready:true},'a pruned sibling is not a missing producer');
  const refused={revision:4,completed:false,reason:'EPERM native refusal'};assert.equal(closeoutNextStage(entry,refused,events),undefined);
  const [wait]=registerCloseoutWait(entry,refused,events,[entry]);assert.match(wait.waiting.defect,/native refusal/);
  assert.deepEqual(registerCloseoutWait(entry,refused,append(events,[wait]),[entry]),[],'a true refusal is retained once');
  const intent={type:'closeout.effect',effect:'intent',identity:entry.common,key:entry.key,source:entry.source,outcome:{action:'shell-close-requested',tab_id:'tab',panes:[{pane:'pane',terminal:'terminal'}]}};
  assert.equal(closeoutNextStage(entry,midpoint,append(events,[intent]),[entry]),undefined,'an unresolved original intent is never progress');
  const unsent=closeoutCommandNotStarted(entry,'intent','shell-close-requested',Object.assign(Error('closer code changed'),{code:'CLOSEOUT_CODE_CHANGED'}));
  const neverSent=append(events,[intent,unsent]);
  assert.deepEqual(closeoutNextStage(entry,midpoint,neverSent,[entry]),{stage:'never-sent',ready:true},'new positive non-execution evidence takes precedence over the physical midpoint');
  assert.deepEqual(registerCloseoutWait(entry,midpoint,neverSent,[entry]),[],'never-sent is owned progress, not a missing producer');
  assert.deepEqual(closeoutNextStage(entry,{...midpoint,seq:neverSent.at(-1).seq},neverSent,[entry]),{stage:'physical',ready:true},'an already observed no-start receipt does not reopen the never-sent stage');
  for(const reason of ['EPERM native refusal','EACCES native refusal','native refusal','retirement held: HOLD-WORKER-TAB-CLOSE','STOP']){
    assert.equal(closeoutNextStage(entry,{...refused,reason},neverSent,[entry]),undefined,`${reason} is not reopened by a no-start receipt`);
  }
  assert.equal(closeoutNextStage(entry,{...refused,reason:'native command failed',failure:{kind:'unknown'}},neverSent,[entry]),undefined,'a recorded failure is not reopened by a no-start receipt');
  assert.equal(closeoutNextStage(entry,midpoint,append(neverSent,[{...intent,effect:'later-intent'}]),[entry]),undefined,'an earlier no-start receipt cannot release a later unresolved intent');
  const native=nativeCloseoutWait(entry,{action:'shell-close-requested',tab_id:'tab'},'intent'),base=append(events,[intent,native]);
  assert.equal(closeoutWaitState(native,append(base,[unsent,...linkedCloseoutStatuses(base,[unsent])])),'complete');
  assert.equal(closeoutWaitState(native,append(base,[{...unsent,intent:'other'},...linkedCloseoutStatuses(base,[{...unsent,intent:'other'}])])),'pending');
});
