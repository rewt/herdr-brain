import test from './helpers/bounded-test.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {fold,itemStatus} from '../lib/state.mjs';
import {decisionCapture,decisionCandidates,decisionActivation,decisionQueueMutation,decisionApplyMutation,decisionFailureMutation,typedDecision,decisionRoute,decisionBrief,decisionHash,isDecision,queueDecision,applyDecision,decisionRestoreMutation,observeDecisionConsequences} from '../line-service/decisions.mjs';
import {blockedChangeKey,dispatchInput} from '../line-service/phase1.mjs';
import {createLineService,serviceDirectory,sourceRoot,routeFor} from '../line-service/line-service.mjs';
import {transact,loadRecord} from '../lib/store.mjs';
import {gitProject} from '../lib/project.mjs';
import {createHash} from 'node:crypto';
import {createWorkerBrief,lineWorkerPrompt,renderWorkerBrief} from '../lib/worker-brief.mjs';
import {protectRecordMutation} from '../lib/record-guard.mjs';

const config={routes:{unblock:{kind:'codex'},review:{kind:'claude'},engineer:{kind:'codex'}}};
const owner=identity=>({controller:'brain',legacy:false,release:{id:'source',commit:null,root:sourceRoot,identity}});
function fixture(){
  const events=[];const add=e=>events.push({...e,seq:events.length+1,at:'2026-10-27T00:00:00Z',by:'line-service'});
  add({type:'item.added',id:'G-1',kind:'goal',title:'Standing intent',meta:{queue_order:['stable'],queue_default:'stable'}});
  add({type:'item.added',id:'ENG-1',role:'engineer',title:'Real blocked work',parent:'G-1',accept:['Complete delegated work'],meta:{}});
  add({type:'run.started',id:'R-1',item:'ENG-1',workspace:'/source',meta:{}});
  add({type:'run.claimed',run:'R-1',owner:owner('/git')});
  add({type:'report.ingested',run:'R-1',sha256:'blocked-hash',file:'reports/R-1.md',report:{outcome:'blocked',blockers:['Scope needs interpretation']}});
  add({type:'line.decisions-activated',project:'/git',org:'/record',subjects:['ENG-1']});
  const state=()=>fold(events),activation=()=>decisionActivation(events,'/git','/record');
  const request=()=>decisionCapture({state:state(),events,item:state().items.get('ENG-1'),activation:activation()});
  const queue=()=>{const r=request(),m=decisionQueueMutation({events,state:state(),request:r,config,archive:{file:'/request',sha256:'hash'}});m.add.forEach(add);return m.result.item;};
  const answer=(action='reopen',extra={})=>({version:1,key:request().key,action,category:'design',reason:'Implement the existing contract; high confidence; a contradictory contract would falsify this.',...extra});
  const judge=(id,a)=>{add({type:'run.started',id:'R-2',item:id,meta:{harness:'codex'}});add({type:'report.ingested',run:'R-2',sha256:'judge-hash',file:'reports/R-2.md',report:{outcome:'done',extra:{decision:a}}});};
  const apply=(id,a,archive={file:'/application',sha256:'hash'})=>decisionApplyMutation({events,state:state(),item:state().items.get(id),answer:a,archive,activation:activation()});
  return {events,add,state,activation,request,queue,answer,judge,apply};
}

test('one immutable decision per actual intent uses normal role routing and preserves ambiguous starts',()=>{
  const f=fixture(),r=f.request(),id=f.queue();assert.equal(id,'DEC-1');
  assert.equal(f.request().key,r.key,'the decision blocker does not change its own intent');
  assert.equal(decisionCandidates({state:f.state(),events:f.events,identity:'/git',org:'/record'}).length,0);
  const retained=decisionQueueMutation({state:f.state(),events:f.events,request:r,config});assert.equal(retained.add.length,0);
  assert.equal(routeFor(f.state().items.get(id),config),'unblock');assert.match(decisionBrief(f.state().items.get(id)),/Zero|No review/);
  f.add({type:'item.updated',id:'G-1',fields:{accept:['Changed current intent']}});
  assert.notEqual(f.request().key,r.key);
  assert.throws(()=>decisionQueueMutation({state:f.state(),events:f.events,request:f.request(),config}),/pending\/ambiguous/);
});

test('typed answers explicitly restart unchanged blocked work once without granting incidental service notes authority',()=>{
  const f=fixture(),a=f.answer(),id=f.queue();f.judge(id,a);
  assert.equal(dispatchInput({events:f.events,state:f.state(),item:f.state().items.get('ENG-1')}),null);
  const m=f.apply(id,a);m.add.forEach(f.add);
  assert.ok(dispatchInput({events:f.events,state:f.state(),item:f.state().items.get('ENG-1')}));
  assert.equal(itemStatus(f.state(),'ENG-1'),'ready');assert.equal(f.apply(id,a).add.length,0);
  const naked=fixture();naked.add({type:'note.added',id:'ENG-1',text:'Proceed',decision:true});
  assert.equal(blockedChangeKey({events:naked.events,state:naked.state(),item:naked.state().items.get('ENG-1'),run:naked.state().runs.get('R-1')}),null);
});

test('current intent, subject generation, changed claim, ancestor HOLD, and late duplicate answers cannot override newer inputs',()=>{
  for(const change of [
    {type:'item.updated',id:'G-1',fields:{accept:['New intent']}},
    {type:'item.updated',id:'ENG-1',fields:{title:'New subject'}},
    {type:'run.claimed',run:'R-1',owner:owner('/git')},
    {type:'item.updated',id:'G-1',fields:{meta:{hold:true}}},
    {type:'item.updated',id:'ENG-1',fields:{meta:{hold:true}}},
  ]){
    const f=fixture(),a=f.answer(),id=f.queue();f.judge(id,a);f.add(change);
    assert.throws(()=>f.apply(id,a),/changed/);
  }
});

test('reserved outcomes and extra commands are rejected while actual operator questions wait with no default',()=>{
  const f=fixture(),r=f.request();
  for(const category of ['security','publish','funds-and-chain','identity','native-refusal','licensing','priorities','delete-data','operator-design'])
    assert.throws(()=>typedDecision({outcome:'done',extra:{decision:f.answer('reopen',{category})}},r),/reserved/);
  assert.throws(()=>typedDecision({outcome:'done',extra:{decision:f.answer('reopen',{command:'deploy'})}},r),/unsupported/);
  const a=f.answer('ask_operator',{category:'publish',question:'Publish this release?',recommend:'no'}),id=f.queue();f.judge(id,a);
  f.apply(id,a).add.forEach(f.add);
  const question=[...f.state().items.values()].find(i=>i.role==='human');
  assert.equal(question.meta.operator_reserved,true);assert.equal(question.meta.answer,undefined);assert.equal(question.meta.decider,'brain-chat');
  assert.equal(dispatchInput({events:f.events,state:f.state(),item:f.state().items.get('ENG-1')}),null);
});

test('hold, reserved ancestry and unselected report proposals never become automatic decision candidates',()=>{
  for(const change of [{id:'ENG-1',fields:{meta:{hold:true}}},{id:'G-1',fields:{meta:{reserved:true}}},{id:'ENG-1',fields:{meta:{queue_selected:false}}}]){
    const f=fixture();f.add({type:'item.updated',...change});assert.equal(f.request(),null);
  }
  const f=fixture();f.add({type:'line.decisions-deactivated',project:'/git',org:'/record'});assert.equal(f.request(),null);
});

test('reserved question creation cannot be undone through delegated automatic restore',()=>{
  const f=fixture(),a=f.answer('ask_operator',{category:'security',question:'Change the permission boundary?',recommend:'no'}),id=f.queue();f.judge(id,a);
  f.apply(id,a).add.forEach(f.add);
  assert.throws(()=>decisionRestoreMutation({state:f.state(),events:f.events,key:a.key}),/actual operator route/);
  assert.equal([...f.state().items.values()].filter(i=>i.role==='human'&&!i.closed).length,1);
});

test('a typed reshape changes only the delegated contract and resumes work',()=>{
  const f=fixture(),a=f.answer('reshape',{title:'Bounded successor slice',accept:['One concrete affected check']}),id=f.queue();f.judge(id,a);
  f.apply(id,a).add.forEach(f.add);assert.equal(f.state().items.get('ENG-1').title,a.title);
  assert.deepEqual(f.state().items.get('ENG-1').accept,a.accept);assert.equal(itemStatus(f.state(),'ENG-1'),'ready');
});

test('supersede requires exact source recovery and moves unfinished dependencies to a named successor',()=>{
  const f=fixture();for(const id of ['ENG-2','ENG-3','ENG-4'])f.add({type:'item.added',id,role:'engineer',title:id,meta:{}});
  f.add({type:'link.added',blocker:'ENG-1',blocked:'ENG-3'});f.add({type:'link.added',blocker:'ENG-4',blocked:'ENG-1'});
  const a=f.answer('supersede',{successor:'ENG-2'}),id=f.queue();f.judge(id,a);
  assert.throws(()=>f.apply(id,a),/recoverable source/);
  f.apply(id,a,{file:'/archive',sha256:'hash',source:{file:'/tree.tar',sha256:'tree'}}).add.forEach(f.add);
  assert.equal(f.state().items.get('ENG-1').closed.as,'dropped');
  assert.ok(f.state().links.some(l=>l.blocker==='ENG-2'&&l.blocked==='ENG-3'));
  assert.ok(f.state().links.some(l=>l.blocker==='ENG-4'&&l.blocked==='ENG-2'));
  assert.equal(itemStatus(f.state(),'ENG-3'),'blocked');
});

test('one failed typed answer gets a fresh other-family reframe, second parks; live or ambiguous starts are never counted',()=>{
  const f=fixture(),id=f.queue();f.judge(id,{});
  let item=f.state().items.get(id),run=f.state().runs.get('R-2');
  const m=decisionFailureMutation({state:f.state(),events:f.events,item,run,reason:'No typed answer',config});m.add.forEach(f.add);
  assert.equal(m.result.reframe,'review');assert.equal(f.state().items.get(id).meta.route,'review');
  assert.equal(decisionFailureMutation({state:f.state(),events:f.events,item:f.state().items.get(id),run,reason:'Duplicate',config}).add.length,0);
  f.add({type:'run.started',id:'R-3',item:id,meta:{harness:'claude'}});
  f.add({type:'report.ingested',run:'R-3',sha256:'bad',report:{outcome:'failed'}});
  const second=decisionFailureMutation({state:f.state(),events:f.events,item:f.state().items.get(id),run:f.state().runs.get('R-3'),reason:'Still invalid',config});
  second.add.forEach(f.add);assert.equal(second.result.parked,true);assert.equal(f.state().items.get(id).meta.hold,true);
  assert.throws(()=>decisionRoute({routes:{unblock:{kind:'codex'}}},{failedFamily:'codex'}),/unavailable/);
});

test('decision prompts are read-only typed sessions with no self-landing instruction',()=>{
  const f=fixture(),id=f.queue(),item=f.state().items.get(id),c=createWorkerBrief({item,ask:'/ask',askText:decisionBrief(item),project:'/project',org:'/record',lane:'decision-1',route:'unblock',harness:'codex',reviewRoute:'review',exception:{to:'supervisor-test',source:'fixture'}});
  c.workspace='/lane';const run={id:'R-2',item:id,workspace:'/lane',brief_path:'/brief',meta:{lane:c.lane,route:c.route,harness:c.harness,worker_brief:JSON.stringify(c)}};
  const job={workerBrief:c,worker:{agentName:'judge'},to:'judge',repo:c.project,org:c.org,brief:c.ask,lane:c.lane,workspace:c.workspace,route:c.route,declared:{harness:c.harness}};
  const prompt=lineWorkerPrompt({job,run,brief:renderWorkerBrief(c),node:'/node',laneCLI:'/lane.mjs'});
  assert.match(prompt,/only output is one typed report/);assert.doesNotMatch(prompt,/Land with/);
});

// Integration through the actual existing pass lock, record transactions,
// immutable report bytes and effects journal. Native calls are explicit fixtures.
function diskFixture(t){
  const scratch=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'decision-loop-'))),repo=path.join(scratch,'project'),org=path.join(repo,'.org');fs.mkdirSync(org,{recursive:true});
  t.after(()=>fs.rmSync(scratch,{recursive:true,force:true}));
  fs.writeFileSync(path.join(path.dirname(repo),'.identity-root'),'fixture\n');
  fs.writeFileSync(path.join(org,'config.json'),'{}');fs.writeFileSync(path.join(org,'events.jsonl'),'');
  const runGit=args=>execFileSync('git',args,{cwd:repo,encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
  runGit(['init','-qb','main']);runGit(['config','user.email','decision@example.invalid']);runGit(['config','user.name','Fixture']);
  fs.writeFileSync(path.join(repo,'source'),'test');fs.writeFileSync(path.join(repo,'.gitignore'),'.org/\n');fs.writeFileSync(path.join(repo,'.lane.json'),JSON.stringify(config));runGit(['add','.']);runGit(['commit','-qm','Fixture']);
  const identity=gitProject(repo).identity,head=runGit(['rev-parse','HEAD']),directory=serviceDirectory(org,identity);
  fs.mkdirSync(directory,{recursive:true});fs.writeFileSync(path.join(directory,'installation.json'),JSON.stringify({at:'fixture',repo,org,source:sourceRoot,node:process.execPath,file:path.join(directory,'service.plist'),target:`gui/${process.getuid()}/dev.herdr.line.${path.basename(directory)}`}));
  const env={...process.env,ORG_DIR:org,HERDR_BRAIN_ROOT:sourceRoot};for(const key of ['HERDR_ENV','HERDR_PANE_ID','CODEX_THREAD_ID','LANE_CONFIG'])delete env[key];
  const add=(...events)=>transact(org,()=>({add:events}),{actor:'line-service'});
  const report=(id,outcome,extra={})=>{const text=`---\n${JSON.stringify({run:id,outcome,summary:'Fixture report',headline:'Fixture work needs a decision.',blockers:outcome==='blocked'?['Need bounded judgment']:[],...extra})}\n---\n`;
    fs.mkdirSync(path.join(org,'reports'),{recursive:true});fs.writeFileSync(path.join(org,'reports',id+'.md'),text);
    add({type:'report.ingested',run:id,file:'reports/'+id+'.md',sha256:createHash('sha256').update(text).digest('hex'),report:{run:id,outcome,blockers:outcome==='blocked'?['Need bounded judgment']:[],extra}});};
  add({type:'item.added',id:'ENG-1',role:'engineer',title:'Actual fixture blocker',meta:{}},
    {type:'run.started',id:'R-1',item:'ENG-1',workspace:repo,meta:{}},
    {type:'run.claimed',run:'R-1',record:org,project:identity,owner:owner(identity)},
    {type:'line-service.phase0',id:'boundary',project:identity,repo,org,main:'main',canonical_head:head});
  report('R-1','blocked');add({type:'line.decisions-activated',project:identity,org,subjects:['ENG-1']});
  const calls=[];
  const native={name:'judge-fixture',pane_id:'w1:p1',workspace_id:'w1',terminal_id:'terminal',agent_session:{value:'session'},cwd:repo};
  const command=(exe,args)=>{calls.push(args);if(exe==='herdr')return{status:0,stdout:JSON.stringify({result:{agent:native}})};return {status:0,stdout:JSON.stringify({result:'detached'})};};
  const service=()=>createLineService({repo,org,to:'supervisor-test',env,command,capacity:()=>({count:0,cap:4}),haltAfter:100});
  return{repo,org,identity,env,add,report,calls,native,service,load:()=>loadRecord(org)};
}

test('the real line creates and dispatches one fresh judge, consumes immutable typed bytes once and dispatches the blocked subject',t=>{
  const f=diskFixture(t);f.service().pass();let {state}=f.load();const item=[...state.items.values()].find(isDecision);assert.ok(item);
  assert.equal(f.calls.filter(args=>args[1]===item.id).length,1);
  const r=item.meta.decision_request;
  f.add({type:'run.started',id:'R-2',item:item.id,workspace:f.repo,meta:{agent:'judge-fixture',pane:'w1:p1',worker_workspace:'w1',terminal_id:'terminal',agent_session_id:'session',harness:'codex'}},
    {type:'run.claimed',run:'R-2',record:f.org,project:f.identity,owner:owner(f.identity)});
  f.report('R-2','done',{decision:{version:1,key:r.key,action:'reopen',category:'design',reason:'Apply existing bounded scope.'}});
  f.service().pass();f.service().pass();const loaded=f.load();
  assert.equal(loaded.events.filter(e=>e.type==='decision.applied').length,1);
  assert.equal(loaded.state.items.get(item.id).closed.as,'done');
  assert.equal(f.calls.filter(args=>args[1]==='ENG-1').length,1,'explicit restart reaches ordinary dispatch exactly once');
  assert.equal(loaded.events.filter(e=>e.type==='decision.consequence').length,0,'detached ack is not actual live consequence proof');
});

test('exact archived rollback restores absent fields and blocked outcome before downstream work; later writes refuse rollback',t=>{
  const f=diskFixture(t);f.service().pass();let {state}=f.load();const item=[...state.items.values()].find(isDecision),r=item.meta.decision_request,before=state.items.get('ENG-1');
  f.add({type:'run.started',id:'R-2',item:item.id,workspace:f.repo,meta:{agent:'judge-fixture',pane:'w1:p1',worker_workspace:'w1',terminal_id:'terminal',agent_session_id:'session',harness:'codex'}},
    {type:'run.claimed',run:'R-2',record:f.org,project:f.identity,owner:owner(f.identity)});
  f.report('R-2','done',{decision:{version:1,key:r.key,action:'park',category:'design',reason:'Preserve pending work.'}});
  f.service().pass();let loaded=f.load();
  assert.throws(()=>decisionRestoreMutation({...loaded,key:r.key}),/consequence/);
  // Pure control omits the later observation to test the exact pre-consequence restore.
  const events=loaded.events.filter(e=>e.type!=='decision.consequence'),s=fold(events);
  const mutation=decisionRestoreMutation({events,state:s,key:r.key});
  const restored=fold([...events,...mutation.add]);assert.deepEqual(restored.items.get('ENG-1'),before);
  assert.equal(blockedChangeKey({events:[...events,...mutation.add],state:restored,item:before,run:restored.runs.get('R-1')}),null);
  const changed=[...events,{type:'note.added',id:'ENG-1',seq:9999,text:'New intent'}];
  assert.throws(()=>decisionRestoreMutation({events:changed,state:fold(changed),key:r.key}),/affected state/);
});

test('a real native refusal is preserved by the existing effects journal and never retried',t=>{
  const f=diskFixture(t);f.service().pass();const item=[...f.load().state.items.values()].find(isDecision),r=item.meta.decision_request;
  f.add({type:'run.started',id:'R-2',item:item.id,workspace:f.repo,meta:{agent:'judge-fixture',pane:'w1:p1',worker_workspace:'w1',terminal_id:'terminal',agent_session_id:'session',harness:'codex'}},
    {type:'run.claimed',run:'R-2',record:f.org,project:f.identity,owner:owner(f.identity)});
  f.report('R-2','done',{decision:{version:1,key:r.key,action:'reopen',category:'design',reason:'Proceed within scope.'}});
  f.native.terminal_id='replacement';f.service().pass();const count=f.calls.filter(a=>a[0]==='agent').length;f.service().pass();
  assert.equal(f.calls.filter(a=>a[0]==='agent').length,count);
  assert.equal(f.load().events.filter(e=>e.type==='decision.applied').length,0);
  const journal=JSON.parse(fs.readFileSync(path.join(serviceDirectory(f.org,f.identity),'effects.json')));
  assert.ok(Object.values(journal.actions).some(e=>e.state==='held'&&/native ownership/.test(e.error)));
});

test('supersede rollback preserves a successor promotion guard after exact dependency transfer',t=>{
  const f=diskFixture(t);
  f.add({type:'item.added',id:'ENG-2',role:'engineer',title:'Exact successor',meta:{}},
    {type:'item.added',id:'ENG-3',role:'engineer',title:'Unfinished dependent',meta:{}},
    {type:'link.added',blocker:'ENG-1',blocked:'ENG-3'},
    {type:'run.started',id:'R-3',item:'ENG-2',workspace:f.repo,meta:{}});
  f.service().pass();const item=[...f.load().state.items.values()].find(isDecision),request=item.meta.decision_request;
  f.add({type:'run.started',id:'R-2',item:item.id,workspace:f.repo,meta:{agent:'judge-fixture',pane:'w1:p1',worker_workspace:'w1',terminal_id:'terminal',agent_session_id:'session',harness:'codex'}},
    {type:'run.claimed',run:'R-2',record:f.org,project:f.identity,owner:owner(f.identity)});
  f.report('R-2','done',{decision:{version:1,key:request.key,action:'supersede',category:'design',reason:'Preserve unfinished scope under its exact successor.',successor:'ENG-2'}});
  f.service().pass();const loaded=f.load(),events=loaded.events.filter(e=>e.type!=='decision.consequence'),state=fold(events);
  assert.ok(state.links.some(l=>l.blocker==='ENG-2'&&l.blocked==='ENG-3'));
  const mutation=decisionRestoreMutation({events,state,key:request.key});
  fs.mkdirSync(path.join(f.identity,'promote'),{recursive:true});
  fs.writeFileSync(path.join(f.identity,'promote','queue.json'),JSON.stringify({identity:f.identity,pending:[{id:'owned-successor-promotion',run:'R-3',org:f.org}],results:[]}));
  assert.throws(()=>protectRecordMutation({org:f.org,events,state,mutation,command:'exact decision restore'}),/promotion write guard REFUSED/);
  fs.unlinkSync(path.join(f.identity,'promote','queue.json'));
  const restored=fold([...events,...mutation.add]);assert.ok(restored.links.some(l=>l.blocker==='ENG-1'&&l.blocked==='ENG-3'));
  assert.ok(!restored.links.some(l=>l.blocker==='ENG-2'&&l.blocked==='ENG-3'));
});
