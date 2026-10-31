import test from './helpers/bounded-test.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {configFixture} from './helpers/config-home-fixture.mjs';
import {loadEvents,transact} from '../lib/store.mjs';
import {fold} from '../lib/state.mjs';
import {gitProject} from '../lib/project.mjs';
import {lineDirectory} from '../line-service/cutoff.mjs';
import {inspectReviewReferences,resolveReviewReference} from '../line-service/review-reference.mjs';
import {referenceProof,resolvedReference} from '../line-service/review-reference-proof.mjs';
import {capturedRange,REVIEW_PROOF_MAX_BYTES} from '../line-service/review-targets.mjs';
import {reviewDigest as hash} from '../line-service/review-resolutions.mjs';
import {reviewAttempt} from '../line-service/review.mjs';
import {queueReviewMutation,validateQueuedReview} from '../line-service/review-queue.mjs';
import {createLineService,sourceRoot} from '../line-service/line-service.mjs';
import {reviewQueueNoMutation} from '../line-service/review-queue-outcome.mjs';
import {reconcileReviewQueue,inspectReviewQueue} from '../line-service/review-queue-reconcile.mjs';
import {terminalQueuePlanningProof,resolvedQueuePlanning} from '../line-service/review-queue-proof.mjs';
import {commandIntent,finishCommand,forgetActiveCommand} from '../lib/command-receipt.mjs';

const root=fs.realpathSync(sourceRoot);
function fixture(t,{diffBytes=0}={}){
  const f=configFixture(t,{custom:true}),repo=f.cwd,org=f.env.ORG_DIR,identity=gitProject(repo).identity;
  fs.writeFileSync(path.join(repo,'.promote.json'),JSON.stringify({to:'fixture-supervisor'}));f.git('add','.promote.json');f.git('commit','-qm','Supervisor policy');
  const base=f.git('rev-parse','HEAD');fs.writeFileSync(path.join(repo,'build'),diffBytes?'landed change\n'.repeat(Math.ceil(diffBytes/14)):'landed change');f.git('add','build');f.git('commit','-qm','Build');const head=f.git('rev-parse','HEAD');
  const reference=path.join(org,'evidence/ENG-1/R-1/review-reference.json');fs.mkdirSync(path.dirname(reference),{recursive:true});
  const report=`---\nrun: R-1\noutcome: done\nsummary: Landed change\nartifacts:\n  - "source: ${head}; base: ${base}"\n  - ${reference}\n---\n`;
  fs.mkdirSync(path.join(org,'reports'),{recursive:true});fs.writeFileSync(path.join(org,'reports/R-1.md'),report);
  const dispatch=path.join(org,'dispatch/source.json');fs.mkdirSync(path.dirname(dispatch),{recursive:true});fs.writeFileSync(dispatch,JSON.stringify({token:'source',run:'R-1',item:'ENG-1',common:identity,org,workspace:repo,base,stage:'complete'}));
  const add=(rows,actor='fixture-supervisor')=>transact(org,()=>({add:rows}),{actor});
  add([
    ...['line-service.cutover','line-service.phase0'].map(type=>({type,id:type,project:identity,repo,org,source:root,main:'main',canonical_head:base})),
    {type:'item.added',id:'ENG-1',title:'Build',role:'engineer',meta:{}},
    {type:'run.started',id:'R-1',item:'ENG-1',workspace:repo,meta:{lane:'source',agent:'fixture-producer',dispatch_journal:dispatch,dispatch_attempt:'source'}},
    {type:'run.claimed',run:'R-1',record:org,project:identity,owner:{controller:'brain',legacy:false,release:{id:'source',root,identity:gitProject(root).identity,commit:null}}},
    {type:'report.ingested',run:'R-1',item:'ENG-1',file:'reports/R-1.md',sha256:hash(report),report:{outcome:'done',artifacts:[`source: ${head}; base: ${base}`,reference]}},
  ]);
  const directory=lineDirectory(org,identity);fs.mkdirSync(directory,{recursive:true});fs.writeFileSync(path.join(directory,'installation.json'),JSON.stringify({repo,org,source:root,node:process.execPath,file:path.join(directory,'service.plist'),target:`gui/${process.getuid()}/dev.herdr.line.${path.basename(directory)}`}));
  const reportAt=loadEvents(org).events.find(e=>e.type==='report.ingested').at;
  const control=(action,phase,at)=>({action,phase,at,target:`gui/${process.getuid()}/dev.herdr.line.${path.basename(directory)}`});
  fs.writeFileSync(path.join(directory,'controls.jsonl'),JSON.stringify(control('stop','stopped',new Date(Date.parse(reportAt)-1000).toISOString()))+'\n');
  const env={...f.env,HERDR_ENV:'1',HERDR_BRAIN_ROOT:root,CODEX_THREAD_ID:'native-session'},native=f.observation.agents[0],calls=[];
  const call=(_exe,args)=>{calls.push(args);return JSON.stringify({result:{agent:native}});};
  const context=()=>{const {events}=loadEvents(org),state=fold(events);return{repo,org,identity,events,state,item:state.items.get('ENG-1'),run:state.runs.get('R-1'),target};};
  const target=inspectReviewReferences({repo,org,runId:'R-1'}).targets[0].target;
  const resolution=path.join(org,'resolution.json'),id='exact-reference';let decisionSeq,input;
  const prepare=(value={run:'R-1',head,base,stage:'worker',native_launch_attempted:false},disposition='needs-review',extra={})=>{
    fs.writeFileSync(reference,JSON.stringify(value));input={item:'ENG-1',run:'R-1',head,base,reference,reference_sha256:hash(fs.readFileSync(reference)),disposition,...extra};fs.writeFileSync(resolution,JSON.stringify(input));
    add([{type:'note.added',id:'ENG-1',decision:true,text:`Resolve ${id} ENG-1 R-1 ${head} ${input.reference_sha256} ${disposition}. Preserve original history.`}]);decisionSeq=loadEvents(org).events.at(-1).seq;
  };
  prepare();
  const args=()=>({repo,org,runId:'R-1',resolution,decisionSeq,id,role:'supervisor',cwd:repo,env,call});
  const serviceEnv={...f.env,ORG_ACTOR:'line-service',HERDR_BRAIN_ROOT:root};for(const k of ['HERDR_ENV','HERDR_PANE_ID','HERDR_WORKSPACE_ID','CODEX_THREAD_ID'])delete serviceEnv[k];
  const queue=()=>{const cwd=process.cwd();try{process.chdir(repo);return transact(org,(events,state)=>queueReviewMutation({state,events,org,repo,runId:'R-1',head,base,env:serviceEnv}),{actor:'line-service'}).result;}finally{process.chdir(cwd);}};
  const captured=()=>fs.readFileSync(path.join(org,'events.jsonl'));
  return{...f,repo,org,identity,base,head,reference,resolution,directory,context,args,prepare,add,calls,queue,captured,serviceEnv,reportAt,control,input:()=>input};
}

test('typed zero-native disposition preserves original evidence and permits one ordinary review',t=>{
  const f=fixture(t),before=f.captured(),bytes=fs.readFileSync(f.reference);
  assert.match(reviewAttempt(f.context().item,f.context()),/typed review reference UNKNOWN/);
  const result=resolveReviewReference(f.args());assert.equal(result.existing,false);
  assert.deepEqual(f.captured().subarray(0,before.length),before);assert.deepEqual(fs.readFileSync(f.reference),bytes);
  assert.equal(reviewAttempt(f.context().item,f.context()),null);
  assert.equal(resolveReviewReference(f.args()).existing,true);
  const q=f.queue();assert.equal(q.existing,false);assert.equal(f.queue().review_item,q.review_item);
  const c=f.context();assert.equal(validateQueuedReview({...c,item:c.state.items.get(q.review_item)}).head,f.head);
  assert.equal(c.events.filter(e=>e.type==='review.reference-resolved').length,1);
  assert.equal(c.events.some(e=>['run.abandoned','change.reviewed'].includes(e.type)),false);
  assert.ok(f.calls.every(a=>a[0]==='agent'&&a[1]==='get'),'no native effects or absence inference');
});

const producerHandoff=(f,shape='head')=>({
  run:'R-1',item:'ENG-1',worker:'fixture-producer',producerEvidence:{kind:'synthetic-producer-checks'},
  ...(shape==='head'?{schema:'record-review-handoff/v1',head:f.head,base:f.base,queueMutation:false,review:'Deferred to the ordinary record queue after STOP',interleavedDependency:{head:f.base}}:
    shape==='ownedScope.head'?{ownedScope:{head:f.head,base:f.base},cumulativeScope:{head:f.base},review:{asynchronous:true,cap:1,reviewerSuites:0,formalFixRounds:1,attemptPolicy:'one ordinary record review'}}:
      {schema:'bch-single-record-review-handoff/1',source:f.head,base:f.base,queueAttempted:false}),
});

const reportWatcher=f=>({run:'R-1',pid:123,identity:'original-watcher-birth',log:path.join(f.org,'dispatch/R-1.watch.log')});
for(const shape of ['dispatch','retained','explicit-queue-flags','recipient-dispatch-A','recipient-retained-B'])test(`producer ${shape} watcher is retained with typed record-backed proof and one ordinary queue`,t=>{
  const f=fixture(t);let watcher=reportWatcher(f);
  if(shape==='retained')watcher={pid:123,to:'fixture-supervisor',retained:true};
  if(shape==='recipient-dispatch-A')watcher={...watcher,release:{commit:f.head,id:'fixture-release',protocol:1,root},recipient:'fixture-supervisor',retained:true,liveness:'Unprobed; unchanged.'};
  if(shape==='recipient-retained-B')watcher={pid:123,identity:'original-watcher-birth',recipient:'fixture-supervisor',retained:true,liveness:'unprobed'};
  f.add([{type:'run.updated',id:'R-1',meta:{watcher_pid:watcher.pid,watcher_identity:watcher.identity,watcher_log:watcher.log??path.join(f.org,'dispatch/R-1.watch.log')}}]);
  f.prepare({...producerHandoff(f),...(shape==='explicit-queue-flags'?{queueAttempted:false,queueMutation:false}:{}),watcher});
  const before=f.captured(),bytes=fs.readFileSync(f.reference);
  const result=resolveReviewReference(f.args());assert.equal(result.existing,false);
  const c=f.context(),event=c.events.find(e=>e.type==='review.reference-resolved');
  assert.equal(event.proof.kind,'producer-record-no-attempt');
  assert.deepEqual(event.proof.watcher,{kind:'producer-report-watcher',run:'R-1',sha256:hash(JSON.stringify(watcher))});
  assert.deepEqual(f.captured().subarray(0,before.length),before);assert.deepEqual(fs.readFileSync(f.reference),bytes);
  assert.equal(resolvedReference({...c,item:'ENG-1',run:'R-1',file:f.reference}),true);
  assert.equal(resolveReviewReference(f.args()).existing,true);
  const q=f.queue();assert.equal(q.existing,false);assert.equal(f.queue().review_item,q.review_item);
  const next=f.context();assert.equal(validateQueuedReview({...next,item:next.state.items.get(q.review_item)}).head,f.head);
  assert.equal(next.events.filter(e=>e.type==='review.reference-resolved').length,1);
  assert.ok(f.calls.every(a=>a[0]==='agent'&&a[1]==='get'),'no watcher or reviewer native effects');
});

for(const kind of ['review-run','review-item','review-link','review-log','review-metadata','review-to','review-target','review-recipient','nested','unknown','recorded-mismatch','missing-stop','competing-attempt','competing-queue'])test(`producer watcher refuses ${kind} without changing original history`,t=>{
  const f=fixture(t),watcher=reportWatcher(f),value={...producerHandoff(f),queueAttempted:false,queueMutation:false,watcher};
  if(kind==='review-run')watcher.run='R-2';
  if(kind==='review-item')watcher.item='REV-1';
  if(kind==='review-link')watcher.review_run='R-2';
  if(kind==='review-log')watcher.log=path.join(f.org,'dispatch/R-2.watch.log');
  if(['review-metadata','review-to','review-target','review-recipient'].includes(kind))f.add([
    {type:'item.added',id:'REV-1',title:'Existing review',role:'reviewer',meta:{}},
    {type:'run.started',id:'R-2',item:'REV-1',workspace:f.repo,meta:kind==='review-metadata'?{watcher_pid:watcher.pid}:{agent:'fixture-reviewer'}},
  ]);
  if(kind==='review-to')watcher.to='fixture-reviewer';
  if(kind==='review-target')watcher.target='fixture-reviewer';
  if(kind==='review-recipient')watcher.recipient='fixture-reviewer';
  if(kind==='nested'){delete value.watcher;value.review={watcher};}
  if(kind==='unknown')value.watcher='unknown';
  if(kind==='recorded-mismatch')f.add([{type:'run.updated',id:'R-1',meta:{watcher_pid:456}}]);
  if(kind==='missing-stop')fs.unlinkSync(path.join(f.directory,'controls.jsonl'));
  if(kind==='competing-attempt'){
    fs.mkdirSync(path.join(f.org,'settle'));fs.writeFileSync(path.join(f.org,'settle/R-1.json'),JSON.stringify({kind:'settle',run:'R-1',head:f.head,native_launch_attempted:true}));
  }
  if(kind==='competing-queue'){fs.unlinkSync(f.reference);f.queue();}
  f.prepare(value);const before=f.captured(),bytes=fs.readFileSync(f.reference);
  assert.throws(()=>resolveReviewReference(f.args()));
  assert.deepEqual(f.captured(),before);assert.deepEqual(fs.readFileSync(f.reference),bytes);
});

for(const [key,values] of [['recipient',['',123,{},[]]],['liveness',[null,false,123,{},[]]]])test(`producer watcher refuses malformed ${key} without changing original history`,t=>{
  const f=fixture(t);
  for(const value of values){
    f.prepare({...producerHandoff(f),watcher:{...reportWatcher(f),[key]:value}});
    const before=f.captured(),bytes=fs.readFileSync(f.reference);
    assert.throws(()=>resolveReviewReference(f.args()),/producer watcher binding is UNKNOWN/);
    assert.deepEqual(f.captured(),before);assert.deepEqual(fs.readFileSync(f.reference),bytes);
  }
});

test('descriptive watcher liveness neither probes a process nor replaces historical STOP proof',t=>{
  const f=fixture(t),descriptions=['','unprobed','Unprobed; unchanged.','Process is absent.','Process is alive.'];
  const prepare=liveness=>f.prepare({...producerHandoff(f),queueAttempted:false,queueMutation:false,watcher:{...reportWatcher(f),recipient:'fixture-supervisor',liveness}});
  for(const liveness of descriptions){
    prepare(liveness);const c=f.context();
    assert.equal(referenceProof({...c,item:'ENG-1',run:'R-1',input:f.input()}).kind,'producer-record-no-attempt');
  }
  fs.unlinkSync(path.join(f.directory,'controls.jsonl'));
  for(const liveness of descriptions){
    prepare(liveness);const before=f.captured(),bytes=fs.readFileSync(f.reference);
    assert.throws(()=>resolveReviewReference(f.args()),/STOP|ENOENT/);
    assert.deepEqual(f.captured(),before);assert.deepEqual(fs.readFileSync(f.reference),bytes);
  }
  assert.ok(f.calls.every(a=>a[0]==='agent'&&a[1]==='get'),'no watcher process probe or native effect');
});

test('multi-megabyte immutable diff keeps its exact hash through watcher disposition and queue admission',t=>{
  const f=fixture(t,{diffBytes:2*1024*1024});f.prepare({...producerHandoff(f),watcher:reportWatcher(f)});
  // Capture/disposition must agree with the historical UTF-8 + trim predicate.
  const output=execFileSync('git',['-C',f.repo,'diff','--no-ext-diff','--no-textconv',f.base,f.head],{encoding:'utf8',maxBuffer:4*1024*1024});
  assert.ok(Buffer.byteLength(output)>1024*1024);
  assert.equal(f.context().target.diff_sha256,hash(output.trim()));
  const c=f.context();assert.throws(()=>capturedRange({...c,target:{...c.target,diff_sha256:'0'.repeat(64)}}),/range\/diff/);
  resolveReviewReference(f.args());const q=f.queue(),next=f.context();
  assert.equal(validateQueuedReview({...next,item:next.state.items.get(q.review_item)}).diff_sha256,c.target.diff_sha256);
});

test('diff above the hard proof ceiling refuses clearly without hashing partial output',t=>{
  const f=fixture(t),row='over-limit change\n';
  fs.writeFileSync(path.join(f.repo,'large.txt'),row.repeat(Math.ceil((REVIEW_PROOF_MAX_BYTES+1024*1024)/row.length)));
  f.git('add','large.txt');f.git('commit','-qm','Oversize immutable diff');const head=f.git('rev-parse','HEAD'),c=f.context();
  const target={...c.target,head,scope:{...c.target.scope,commits:[f.head,head],claims:[f.head,head]},source_group:{...c.target.source_group,owned_commits:[f.head,head]}};
  assert.throws(()=>capturedRange({...c,target}),e=>e.code==='REVIEW_PROOF_OUTPUT_LIMIT'&&/hard 32 MiB ceiling/.test(e.message)&&e.cause.code==='ENOBUFS');
  assert.equal(f.context().events.some(e=>e.type==='review.reference-resolved'),false);
});

for(const shape of ['head','ownedScope.head','source'])test(`producer report-handoff ${shape} preserves its producer and permits one ordinary review`,t=>{
  const f=fixture(t);f.prepare(producerHandoff(f,shape));
  const before=f.captured(),bytes=fs.readFileSync(f.reference),inspected=inspectReviewReferences({repo:f.repo,org:f.org,runId:'R-1'});
  assert.equal(inspected.references[0].typed,true);
  assert.match(reviewAttempt(f.context().item,f.context()),/typed review reference UNKNOWN/);
  resolveReviewReference(f.args());
  assert.deepEqual(f.captured().subarray(0,before.length),before);assert.deepEqual(fs.readFileSync(f.reference),bytes);
  const c=f.context(),event=c.events.find(e=>e.type==='review.reference-resolved');
  assert.equal(event.proof.kind,'producer-record-no-attempt');
  assert.equal(resolvedReference({...c,item:'ENG-1',run:'R-1',file:f.reference}),true);
  assert.equal(resolveReviewReference(f.args()).existing,true);
  const q=f.queue();assert.equal(q.existing,false);assert.equal(f.queue().review_item,q.review_item);
  const next=f.context();assert.equal(validateQueuedReview({...next,item:next.state.items.get(q.review_item)}).head,f.head);
  assert.equal(next.events.filter(e=>e.type==='review.reference-resolved').length,1);
  assert.ok(f.calls.every(a=>a[0]==='agent'&&a[1]==='get'),'inspection only, no native review launch');
});

test('producer metadata variants corroborate record proof without treating dependency heads as source',t=>{
  const f=fixture(t),variants=[
    {...producerHandoff(f,'ownedScope.head'),review:{queueAttempted:false,parallelReviewStarted:false,waitedForVerdict:false}},
    {...producerHandoff(f),schema:undefined,queueMutation:undefined,source:f.head,review:{asynchronous:true,cap:1,reviewerSuites:0,deferred:true,stop:'line STOP'}},
    {...producerHandoff(f),schema:undefined,queueMutation:undefined,source:f.head,review:{queueCommandAttempted:false}},
    {...producerHandoff(f),queueAttempted:false,queueMutation:false},
    {...producerHandoff(f),source:f.head,ownedScope:{head:f.head,base:f.base}},
  ];
  for(const value of variants){
    f.prepare(value);const c=f.context(),proof=referenceProof({...c,item:'ENG-1',run:'R-1',input:f.input()});
    assert.equal(proof.kind,value.queueAttempted===false&&value.queueMutation===false?'producer-queue-not-attempted':'producer-record-no-attempt');
  }
});

test('producer handoff metadata cannot hide explicit review links or top-level queue attempts',t=>{
  const f=fixture(t);
  // The ordinary metadata remains a valid positive control for this added guard.
  f.prepare(producerHandoff(f,'ownedScope.head'));resolveReviewReference(f.args());
  for(const mutation of [
    {review:{item:'REV-existing'}},{review:{run:'R-review-existing'}},
    {queueCommandAttempted:true},{parallelReviewStarted:true},{waitedForVerdict:true},
  ]){
    const value={...producerHandoff(f),...mutation};f.prepare(value);
    const c=f.context();assert.throws(()=>referenceProof({...c,item:'ENG-1',run:'R-1',input:f.input()}),/UNKNOWN\/started\/refused/);
  }
});

const ownQualification=()=>({exitCode:1,tests:3,pass:2,fail:1,node:'v22.22.3',refusal:'PermissionError: synthetic operation not permitted',affectedControl:'harmless timing-exit',provingExecuted:false});
for(const watcher of [false,true])test(`typed producer qualification refusal preserves original evidence${watcher?' and watcher':''} and admits one record review`,t=>{
  const f=fixture(t),value={...producerHandoff(f,'ownedScope.head'),qualification:ownQualification(),
    review:{queueAttempted:false,parallelReviewStarted:false,reviewerSuites:0,existingOrUnknownAttempt:'not replaced',cap:1,
      completionDelivery:'existing prompt',formalFixRounds:1,owner:'fixture-producer',status:'deferred'}};
  if(watcher)value.watcher={pid:123,identity:'original-watcher-birth',recipient:'fixture-supervisor',retained:true,liveness:'unprobed'};
  f.prepare(value);const before=f.captured(),bytes=fs.readFileSync(f.reference);
  assert.match(reviewAttempt(f.context().item,f.context()),/typed review reference UNKNOWN/,'still fenced before exact supervisor disposition');
  resolveReviewReference(f.args());const c=f.context(),event=c.events.find(e=>e.type==='review.reference-resolved');
  assert.equal(event.proof.kind,'producer-record-no-attempt');
  assert.deepEqual(f.captured().subarray(0,before.length),before);assert.deepEqual(fs.readFileSync(f.reference),bytes);
  assert.deepEqual(Buffer.from(JSON.parse(fs.readFileSync(event.archive.file)).original,'base64'),bytes);
  assert.equal(resolvedReference({...c,item:'ENG-1',run:'R-1',file:f.reference}),true);
  assert.equal(resolveReviewReference(f.args()).existing,true);
  const q=f.queue();assert.equal(q.existing,false);assert.equal(f.queue().review_item,q.review_item);
  const next=f.context();assert.equal(validateQueuedReview({...next,item:next.state.items.get(q.review_item)}).head,f.head);
  assert.equal([...next.state.items.values()].filter(q=>q.meta.review_source_run==='R-1').length,1);
  assert.ok(f.calls.every(a=>a[0]==='agent'&&a[1]==='get'),'read-only native binding observations');
});

test('typed producer qualification refuses malformed test results, review launch bindings and unknown content',t=>{
  const f=fixture(t),mutations=[
    ...Object.keys(ownQualification()).map(k=>q=>delete q[k]),
    q=>q.exitCode=0,q=>q.exitCode='1',q=>q.tests++,q=>q.tests='3',q=>q.pass=-1,q=>q.fail=0,q=>q.fail=0.5,
    q=>q.node=22,q=>q.node='UNKNOWN',q=>q.provingExecuted=true,q=>q.provingExecuted='false',
    q=>q.refusal='',q=>q.refusal={error:'PermissionError'},q=>q.affectedControl='',q=>q.affectedControl=[],
    ...['review qualification','review-launch','fixture-reviewer','REV-1','queue','pane','session'].flatMap(text=>[
      q=>q.affectedControl=text,q=>q.refusal=`PermissionError: ${text}`,
    ]),
    ...['subject','actor','run','item','reviewer','review_item','review_run','queue','queueAttempted','native_launch_attempted','launchProcess','sessionBinding','nested'].map(k=>q=>q[k]={run:'R-review',agent:'fixture-reviewer'}),
  ];
  for(const mutate of mutations){
    const qualification=ownQualification();mutate(qualification);f.prepare({...producerHandoff(f),qualification});
    const c=f.context(),before=f.captured(),bytes=fs.readFileSync(f.reference);
    assert.throws(()=>referenceProof({...c,item:'ENG-1',run:'R-1',input:f.input()}),/UNKNOWN\/started\/refused/);
    assert.throws(()=>resolveReviewReference(f.args()),/UNKNOWN\/started\/refused/);
    assert.deepEqual(f.captured(),before);assert.deepEqual(fs.readFileSync(f.reference),bytes);
  }
});

test('producer qualification does not relax the other top-level or review attempt fields',t=>{
  const f=fixture(t),keys=['reviewer','launchProcess','sessionBinding','verdict','native_qualification','review_item','review_run','agent','pane','terminal','session','pid','reviewer_session','reviewer_pane'];
  for(const nested of [false,true])for(const key of [...keys,...(nested?['qualification']:[])]){
    const value={...producerHandoff(f),qualification:ownQualification()},attempt=key.endsWith('qualification')?ownQualification():key==='pid'?123:'existing';
    if(nested)value.review={[key]:attempt};else value[key]=attempt;
    f.prepare(value);const c=f.context();
    assert.throws(()=>referenceProof({...c,item:'ENG-1',run:'R-1',input:f.input()}),/UNKNOWN\/started\/refused/);
  }
});

test('producer qualification refusals do not excuse another retained native attempt or missing STOP evidence',t=>{
  // Even positively attributed producer metadata still requires the existing
  // historical no-review proof; refusal text alone never grants queue admission.
  for(const kind of ['missing-stop','competing-attempt','competing-queue']){
    const f=fixture(t),value=producerHandoff(f,'ownedScope.head');
    value.qualification=ownQualification();
    if(kind==='missing-stop')fs.unlinkSync(path.join(f.directory,'controls.jsonl'));
    if(kind==='competing-attempt'){
      fs.mkdirSync(path.join(f.org,'settle'));fs.writeFileSync(path.join(f.org,'settle/R-1.json'),JSON.stringify({kind:'settle',run:'R-1',head:f.head,native_launch_attempted:true}));
    }
    if(kind==='competing-queue'){fs.unlinkSync(f.reference);f.queue();}
    f.prepare(value);const before=f.captured(),bytes=fs.readFileSync(f.reference);
    assert.throws(()=>resolveReviewReference(f.args()),/ENOENT|STOP|attempt|replacement|retained/);
    assert.deepEqual(f.captured(),before);assert.deepEqual(fs.readFileSync(f.reference),bytes);
  }
});

const handoffRefusals={
  'queue proof':[
    v=>v.queueAttempted=true,v=>v.queueMutation=true,v=>v.queueAttempted='false',
    v=>v.native_launch_attempted=true,v=>v.native_launch_attempted='UNKNOWN',
    v=>v.review={queueAttempted:true},v=>v.review={queueCommandAttempted:true},
    v=>v.review={parallelReviewStarted:true},v=>v.review={waitedForVerdict:true},
  ],
  attribution:[
    v=>{delete v.schema;delete v.producerEvidence;},v=>v.schema='review-report-handoff/v1',v=>v.kind='review',v=>v.role='reviewer',
    v=>v.worker='fixture-reviewer',v=>v.worker={agent:'fixture-producer'},
    v=>v.source_run='R-other',v=>v.source_item='ENG-other',
  ],
  'native evidence':[
    ...['reviewer','launchProcess','sessionBinding','watcher','verdict','native_qualification','review_item','review_run','agent','pane','terminal','session','pid','reviewer_session','reviewer_pane'].map(k=>v=>v[k]=k==='pid'?123:'existing'),
    v=>v.error='EPERM native refusal',v=>v.review={worker:'fixture-reviewer'},v=>v.stage='launched',
  ],
  qualification:[
    ...['UNKNOWN',false,[],{}, {refusal:'PermissionError: synthetic sandbox refusal'},
      {subject:'review',actor:'fixture-reviewer',refusal:'PermissionError: synthetic sandbox refusal'},
      {subject:'review-launch',actor:'fixture-producer',refusal:'PermissionError: synthetic sandbox refusal'},
    ].map(qualification=>v=>v.qualification=qualification),
    v=>v.review={qualification:{subject:'producer',actor:'fixture-producer',refusal:'PermissionError: synthetic sandbox refusal'}},
  ],
  scope:[
    v=>v.ownedScope={head:'0'.repeat(40)},v=>v.source='0'.repeat(40),v=>v.head=v.head.slice(0,12),
    v=>v.ownedScope={base:'0'.repeat(40)},v=>v.source={head:v.head,base:'0'.repeat(40)},
    v=>v.source=[v.head,'0'.repeat(40)],v=>delete v.head,
  ],
};
for(const [group,mutations] of Object.entries(handoffRefusals))test(`producer report-handoff refuses contradictory ${group}`,t=>{
  const f=fixture(t);
  for(const mutate of mutations){
    const value=producerHandoff(f);mutate(value);f.prepare(value);
    const c=f.context();assert.throws(()=>referenceProof({...c,item:'ENG-1',run:'R-1',input:f.input()}));
    const before=f.captured(),bytes=fs.readFileSync(f.reference);
    assert.throws(()=>resolveReviewReference(f.args()));
    assert.deepEqual(f.captured(),before);assert.deepEqual(fs.readFileSync(f.reference),bytes);
  }
});

test('producer record proof refuses absent, uncertain, foreign or out-of-window STOP and rewritten ingested bytes',t=>{
  const f=fixture(t),controls=path.join(f.directory,'controls.jsonl'),original=fs.readFileSync(controls),report=path.join(f.org,'reports/R-1.md'),reportBytes=fs.readFileSync(report);
  const invalid=[
    ()=>fs.unlinkSync(controls),
    ()=>fs.writeFileSync(controls,JSON.stringify(f.control('stop','stopping',f.reportAt))+'\n'),
    ()=>fs.writeFileSync(controls,JSON.stringify(f.control('stop','stopped',new Date(Date.parse(f.reportAt)+1000).toISOString()))+'\n'),
    ()=>fs.appendFileSync(controls,JSON.stringify(f.control('restart','starting',f.reportAt))+'\n'),
    ()=>fs.appendFileSync(controls,JSON.stringify(f.control('restart','uncertain-or-refused',f.reportAt))+'\n'),
    ()=>fs.writeFileSync(controls,JSON.stringify({...f.control('stop','stopped',f.reportAt),target:'foreign-service'})+'\n'),
    ()=>fs.appendFileSync(controls,'{'),
    ()=>fs.appendFileSync(report,'rewritten after ingest\n'),
  ];
  for(const mutate of invalid){
    fs.writeFileSync(controls,original);fs.writeFileSync(report,reportBytes);f.prepare(producerHandoff(f,'ownedScope.head'));mutate();
    const c=f.context();assert.throws(()=>referenceProof({...c,item:'ENG-1',run:'R-1',input:f.input()}));
    assert.throws(()=>resolveReviewReference(f.args()));
  }
});

test('producer record proof retains a competing queue, native UNKNOWN or verdict before disposition',t=>{
  for(const kind of ['queue','native','verdict']){
    const f=fixture(t);fs.unlinkSync(f.reference);
    if(kind==='queue')f.queue();
    if(kind==='verdict')f.add([{type:'change.reviewed',item:'ENG-1',head:f.head,verdict:'PASS'}]);
    if(kind==='native'){
      fs.mkdirSync(path.join(f.org,'settle'));fs.writeFileSync(path.join(f.org,'settle/R-1.json'),JSON.stringify({kind:'settle',run:'R-1',head:f.head,native_launch_attempted:true}));
    }
    f.prepare(producerHandoff(f,'ownedScope.head'));const before=f.captured();assert.throws(()=>resolveReviewReference(f.args()),/attempt|verdict|replacement|retained/);assert.deepEqual(f.captured(),before);
  }
});

for(const kind of ['later-review-base','unrelated-mention'])test(`producer record proof ignores ${kind} in another review and preserves its history`,t=>{
  const f=fixture(t);fs.writeFileSync(path.join(f.repo,'later-change'),'another producer');f.git('add','later-change');f.git('commit','-qm','Later producer');
  const target={base:kind==='later-review-base'?f.head:f.base,head:f.git('rev-parse','HEAD')};
  f.add([
    {type:'item.added',id:'REV-99',role:'reviewer',title:'Another producer review',meta:{review_source_item:'ENG-99',review_source_run:'R-99',review_target:target,review_round_cap:1}},
    {type:'change.reviewed',item:'ENG-99',head:target.head,base:target.base,review_item:'REV-99',review_run:'R-100',verdict:'PASS'},
    {type:'review.finding-linked',item:'ENG-100',source_item:'ENG-99',head:target.head,base:target.base,review_item:'REV-99',review_run:'R-100',
      ...(kind==='unrelated-mention'?{finding:{text:`Related context: ${JSON.stringify('ENG-1')} ${JSON.stringify('R-1')}`},evidence:{item:'ENG-1',run:'R-1',head:f.head}}:{})},
    {type:'review.recovery-intent',item:'ENG-99',run:'R-99',target},
  ]);
  f.prepare(producerHandoff(f,'ownedScope.head'));const before=f.captured(),bytes=fs.readFileSync(f.reference);
  resolveReviewReference(f.args());const c=f.context();
  assert.equal(resolvedReference({...c,item:'ENG-1',run:'R-1',file:f.reference}),true);
  assert.deepEqual(f.captured().subarray(0,before.length),before);assert.deepEqual(fs.readFileSync(f.reference),bytes);
  assert.equal(f.queue().existing,false);assert.equal(f.queue().existing,true);
  assert.equal([...f.context().state.items.values()].filter(q=>q.meta.review_source_run==='R-1').length,1);
});

for(const kind of ['source-run','source-item-head','source-item-target','finding-source','verdict','legacy-verdict','reviewed-head'])test(`producer record proof retains a typed ${kind} without replacing it`,t=>{
  const f=fixture(t);
  const event=kind==='source-run'?{type:'review.original-continuation',item:'ENG-99',run:'R-1',target:{head:f.base}}:
    kind==='source-item-head'?{type:'review.finding-linked',item:'ENG-1',head:f.head}:
    kind==='source-item-target'?{type:'review.recovery-intent',item:'ENG-1',target:{head:f.head,base:f.base}}:
    kind==='finding-source'?{type:'review.finding-linked',item:'ENG-100',source_item:'ENG-1',head:f.head,base:f.base}:
    kind==='reviewed-head'?{type:'review.verdict',item:'ENG-1',run:'R-99',reviewed_head:f.head,verdict:'PASS'}:
    {type:kind==='verdict'?'change.reviewed':'review.verdict',item:'ENG-1',head:f.head,verdict:'PASS'};
  f.add([event]);f.prepare(producerHandoff(f,'ownedScope.head'));const before=f.captured(),bytes=fs.readFileSync(f.reference);
  const c=f.context();assert.throws(()=>referenceProof({...c,item:'ENG-1',run:'R-1',input:f.input()}),/retains a review attempt\/verdict; no replacement/);
  assert.throws(()=>resolveReviewReference(f.args()),/retains a review attempt\/verdict; no replacement/);
  assert.deepEqual(f.captured(),before);assert.deepEqual(fs.readFileSync(f.reference),bytes);
});

test('historical producer proof survives a later restart while its original audit prefix stays bound',t=>{
  const f=fixture(t),controls=path.join(f.directory,'controls.jsonl');f.prepare(producerHandoff(f,'source'));resolveReviewReference(f.args());
  fs.appendFileSync(controls,JSON.stringify(f.control('restart','restarted',new Date(Date.parse(f.reportAt)+1000).toISOString()))+'\n');
  assert.equal(reviewAttempt(f.context().item,f.context()),null);
  fs.writeFileSync(controls,fs.readFileSync(controls,'utf8').replace('stopped','unknown'));
  assert.throws(()=>reviewAttempt(f.context().item,f.context()),/audit prefix changed/);
});

for(const producer of [false,true])test(`line reconsiders its remembered ${producer?'producer handoff':'barrier'} fence after disposition, retaining the original observation across restart`,t=>{
  const f=fixture(t),commands=[],options={repo:f.repo,org:f.org,to:'fixture-supervisor',env:f.serviceEnv,command:(_exe,args)=>{
    if(args[1]!=='queue-review')return{status:0,stdout:'{"created":[]}',stderr:''};
    commands.push(args);return{status:0,stdout:JSON.stringify(f.queue()),stderr:''};
  }};
  if(producer)f.prepare(producerHandoff(f,'ownedScope.head'));
  createLineService(options).pass();const file=path.join(f.directory,'effects.json'),before=JSON.parse(fs.readFileSync(file));
  const key=`review:ENG-1:${f.head}`;assert.match(before.review_reference_observed[key].attempt,/UNKNOWN/);assert.equal(commands.length,0);
  resolveReviewReference(f.args());createLineService(options).pass();createLineService(options).pass();
  const after=JSON.parse(fs.readFileSync(file));assert.deepEqual(after.review_reference_observed[key],before.review_reference_observed[key]);assert.equal(commands.length,1);assert.equal(commands[0][1],'queue-review');
});

const contentionReceipt=(f,pathless=false)=>({status:3,signal:null,stdout:'',signal_sent:false,activity:{duration_s:1,longest_silence_s:1,observations:[]},
  stderr:`record: promotion write guard REFUSED (fail-closed): cannot read the project's promotion queue${pathless?'':` ${path.join(f.identity,'promote/queue.json')}`}: record changed repeatedly while preparing a consistent read; no mutation attempted. Stale entries never expire; repair/inspect the queue before writing. Write the information on an unguarded parent or in the supervisor digest meanwhile, and copy it to the member after landing and reconciliation.\n`});
const failedQueue=(f,receipt=contentionReceipt(f))=>({state:'held',owner:'line-service',subject:`review:ENG-1:${f.head}`,
  at:'2026-10-30T01:00:00Z',finished_at:'2026-10-30T01:01:00Z',review_target:f.context().target,review_operation:'record-queue',
  error:receipt.stderr.trim(),receipt,failure:{kind:'unknown',code:'OUTCOME_UNKNOWN'}});
const noMutation=(f,entry,context=f.context())=>reviewQueueNoMutation({...context,entry,key:`review:ENG-1:${f.head}`});

function planningFixture(t,index=0){
  const f=fixture(t);f.prepare({producerEvidence:{kind:'checks'}});
  const saved=JSON.parse(fs.readFileSync(new URL('./fixtures/review-queue-planning-errors.json',import.meta.url)))[index];
  const receipt={...contentionReceipt(f),status:1,stderr:saved.stderr.replaceAll('<repo>',f.repo)};
  createLineService({repo:f.repo,org:f.org,to:'fixture-supervisor',env:f.serviceEnv,command:(_exe,args)=>args[1]==='queue-review'?receipt:{status:0,stdout:'{"created":[]}',stderr:''}}).pass();
  const file=path.join(f.directory,'effects.json'),key=`review:ENG-1:${f.head}`,journal=JSON.parse(fs.readFileSync(file)),entry=journal.actions[key];
  // Retain a real foreground-helper terminal receipt. The fixture repository
  // models Brain's canonical source/consumer checkout without executing it.
  const ref=commandIntent(f.directory,{exe:process.execPath,args:[path.join(f.repo,'bin/org.mjs'),'queue-review','R-1','--head',f.head,'--base',f.base],cwd:f.repo,project:f.identity,org:f.org,subject:'ENG-1',key,consumer:'line-service'});
  const terminal=finishCommand(ref,receipt,{pid:1234,identity:'fixture-birth',started_at:JSON.parse(fs.readFileSync(ref.file)).at});forgetActiveCommand(ref);
  entry.commands=[ref];entry.finished_at=terminal.finished_at;fs.writeFileSync(file,JSON.stringify(journal));
  const proof=terminalQueuePlanningProof({...f.context(),item:'ENG-1',run:'R-1',entry,key});assert.ok(proof);
  const id='terminal-planning',resolution=path.join(f.org,'queue-resolution.json'),input={item:'ENG-1',run:'R-1',key,attempt:entry.attempt,target:entry.review_target,original_sha256:proof.original_sha256,command_sha256:proof.command_sha256};
  fs.writeFileSync(resolution,JSON.stringify(input));
  f.add([{type:'note.added',id:'ENG-1',decision:true,text:`Reconcile ${id} ENG-1 R-1 ${entry.attempt} ${proof.original_sha256} ${proof.command_sha256}; pure pre-append only, preserve the original.`}]);
  const decisionSeq=f.context().events.at(-1).seq,args=()=>({...f.args(),resolution,decisionSeq,id});
  return{...f,file,key,entry,proof,input,resolution,reconcileArgs:args,receipt};
}

for(const index of [0,1])for(const next of ['queued','unknown','contention'])test(`guarded status-1 planning disposition ${index} permits one line continuation: ${next}`,t=>{
  const f=planningFixture(t,index),before=fs.readFileSync(f.file),terminal=fs.readFileSync(f.entry.commands[0].receipt);
  assert.deepEqual(inspectReviewQueue({repo:f.repo,org:f.org,runId:'R-1',attempt:f.entry.attempt}),f.input);
  assert.equal(noMutation(f,f.entry),null,'status 1 alone never permits continuation');
  const result=reconcileReviewQueue(f.reconcileArgs());assert.equal(result.existing,false);
  assert.deepEqual(fs.readFileSync(f.file),before);assert.deepEqual(fs.readFileSync(f.entry.commands[0].receipt),terminal);
  assert.equal(reconcileReviewQueue(f.reconcileArgs()).existing,true);
  assert.equal(noMutation(f,f.entry).reconciliation_seq,f.context().events.at(-1).seq);
  let calls=0;
  const options={repo:f.repo,org:f.org,to:'fixture-supervisor',env:f.serviceEnv,command:(_exe,args)=>{
    if(args[1]!=='queue-review')return{status:0,stdout:'{"created":[]}',stderr:''};
    calls++;
    if(next==='unknown')return{status:1,signal:null,stdout:'',stderr:'lost reply after possible append',signal_sent:false,activity:{}};
    if(next==='contention')return contentionReceipt(f);
    return{status:0,stdout:JSON.stringify(f.queue()),stderr:''};
  }};
  createLineService(options).pass();createLineService(options).pass();createLineService(options).pass();
  assert.equal(calls,1);
  const after=JSON.parse(fs.readFileSync(f.file)).actions[f.key];assert.deepEqual(after.history,[f.entry]);
  assert.equal(after.queue_recovery.original_sha256,f.proof.original_sha256);
  assert.equal([...f.context().state.items.values()].filter(q=>q.role==='reviewer').length,next==='queued'?1:0);
  assert.equal(f.context().events.filter(e=>e.type==='line-service.review-queue-reconciled').length,1);
  assert.ok(f.calls.every(a=>a[0]==='agent'&&a[1]==='get'),'no native effects');
});

test('terminal planning writer refuses mismatched original inputs and unaudited status-1 results',t=>{
  const f=planningFixture(t),before=f.captured(),originalBytes=fs.readFileSync(f.file);
  for(const mutate of [x=>x.attempt='other',x=>x.target.head=f.base,x=>x.original_sha256='0'.repeat(64),x=>x.command_sha256='0'.repeat(64),x=>x.run='R-99']){
    const input=structuredClone(f.input);mutate(input);fs.writeFileSync(f.resolution,JSON.stringify(input));
    assert.throws(()=>reconcileReviewQueue(f.reconcileArgs()),/differs|not proven/);
    assert.deepEqual(f.captured(),before);assert.deepEqual(fs.readFileSync(f.file),originalBytes);
  }
  fs.writeFileSync(f.resolution,JSON.stringify(f.input));
  for(const mutate of [x=>x.receipt.stderr+='native input refused\n',x=>x.receipt.status=0,x=>x.receipt.signal='SIGTERM',x=>x.receipt.stdout='REV-1',x=>x.receipt.signal_sent=true,x=>x.receipt.error='EPERM',x=>x.history=[f.entry],x=>x.native_launch_attempted=true,x=>x.failure.kind='fence',x=>x.commands=[],x=>x.commands[0].sha256='0'.repeat(64)]){
    const entry=structuredClone(f.entry);mutate(entry);
    let proof;try{proof=terminalQueuePlanningProof({...f.context(),item:'ENG-1',run:'R-1',entry,key:f.key});}catch{proof=null;}
    assert.equal(proof,null,mutate.toString());
  }
  const bytes=fs.readFileSync(f.entry.commands[0].receipt),command=JSON.parse(bytes);command.result.stdout='possible append';fs.writeFileSync(f.entry.commands[0].receipt,JSON.stringify(command));
  assert.throws(()=>reconcileReviewQueue(f.reconcileArgs()),/not proven/);fs.writeFileSync(f.entry.commands[0].receipt,bytes);
  assert.deepEqual(f.captured(),before);
});

for(const obstacle of ['STOP','HOLD','reserved','foreign-native','changed-claim','existing-review','uncertain-command'])test(`terminal planning disposition retains ${obstacle}`,t=>{
  const f=planningFixture(t);
  if(obstacle==='STOP')fs.writeFileSync(path.join(f.directory,'STOP'),'hold');
  if(obstacle==='HOLD'){fs.mkdirSync(path.join(f.repo,'.lane/supervisor'),{recursive:true});fs.writeFileSync(path.join(f.repo,'.lane/supervisor/HOLD'),'hold');}
  if(obstacle==='reserved')f.add([{type:'item.updated',id:'ENG-1',fields:{meta:{operator_reserved:true}}}]);
  if(obstacle==='foreign-native')f.observation.agents[0].name='foreign-supervisor';
  if(obstacle==='changed-claim')f.add([{type:'run.claimed',run:'R-1',record:f.org,project:'/foreign/.git',owner:{controller:'brain',legacy:false,release:{id:'source',root,identity:gitProject(root).identity,commit:null}}}]);
  if(obstacle==='existing-review')f.queue();
  if(obstacle==='uncertain-command')commandIntent(f.directory,{exe:process.execPath,args:[],cwd:f.repo,subject:'ENG-1'});
  const before=f.captured(),journal=fs.readFileSync(f.file);
  assert.throws(()=>reconcileReviewQueue(f.reconcileArgs()),/STOP\/HOLD|held\/reserved|SUPERVISOR|claim|project|review attempt retained|active or UNKNOWN/i);
  assert.deepEqual(f.captured(),before);assert.deepEqual(fs.readFileSync(f.file),journal);
});

test('resolved original planning attempt does not fence a later whole-producer target or excuse its new UNKNOWN',t=>{
  const f=planningFixture(t,1);reconcileReviewQueue(f.reconcileArgs());
  const c=f.context(),target={...c.target,head:f.base,reportHash:'a'.repeat(64),source_group:{...c.target.source_group,owned_commits:[f.head,f.base]}};
  // Discovery remains responsible for producing a real whole target. Inventory
  // must settle only the original, even when that target's key is different.
  const context={...c,target,effects:JSON.parse(fs.readFileSync(f.file))};
  assert.equal(reviewAttempt(c.item,context),null);
  const key=`review:ENG-1:${f.base}`;context.effects.actions[key]={...f.entry,subject:key,review_target:target,attempt:'new-unknown',receipt:{status:1,stderr:'unknown'}};
  assert.match(reviewAttempt(c.item,context),/service intent/);
});

test('queue planning consumers revalidate immutable archive and owner binding',t=>{
  const f=planningFixture(t);reconcileReviewQueue(f.reconcileArgs());
  const c=f.context(),options={...c,item:'ENG-1',run:'R-1',entry:f.entry,key:f.key},event=c.events.find(e=>e.type==='line-service.review-queue-reconciled');
  assert.ok(resolvedQueuePlanning(options));
  const bytes=fs.readFileSync(event.archive.file);fs.chmodSync(event.archive.file,0o600);fs.appendFileSync(event.archive.file,' ');
  assert.throws(()=>resolvedQueuePlanning(options),/archive changed/);fs.writeFileSync(event.archive.file,bytes);
  event.claim_generation++;assert.throws(()=>resolvedQueuePlanning(options),/owner\/claim changed/);
});

for(const next of ['queued','unknown','contention','pathless'])test(`resolved reference settles only proven pre-append contention once; continuation ${next}`,t=>{
  const f=fixture(t);resolveReviewReference(f.args());let calls=0;
  const options={repo:f.repo,org:f.org,to:'fixture-supervisor',env:f.serviceEnv,command:(_exe,args)=>{
    if(args[1]!=='queue-review')return{status:0,stdout:'{"created":[]}',stderr:''};
    calls++;
    if(calls===1||next==='contention')return contentionReceipt(f,next==='pathless');
    if(next==='unknown')return{status:1,signal:null,stdout:'',stderr:'reply lost after possible mutation',signal_sent:false};
    return{status:0,stdout:JSON.stringify(f.queue()),stderr:''};
  }};
  createLineService(options).pass();const file=path.join(f.directory,'effects.json'),key=`review:ENG-1:${f.head}`;
  const original=JSON.parse(fs.readFileSync(file)).actions[key];assert.equal(original.failure.code,'OUTCOME_UNKNOWN');
  assert.equal(calls,1);assert.equal([...f.context().state.items.values()].filter(q=>q.role==='reviewer').length,0);
  assert.equal(noMutation(f,original).schema,'review-queue-no-mutation/v1');
  createLineService(options).pass();createLineService(options).pass();createLineService(options).pass();
  const after=JSON.parse(fs.readFileSync(file)).actions[key];assert.equal(calls,2);
  assert.deepEqual(after.history,[original]);assert.equal(after.queue_recovery.original_sha256,hash(JSON.stringify(original)));
  assert.equal(after.queue_recovery.receipt_sha256,hash(JSON.stringify(original.receipt)));
  assert.equal(after.queue_recovery.reference_resolution_seqs.length,1);
  const reviews=[...f.context().state.items.values()].filter(q=>q.role==='reviewer');
  const queued=['queued','pathless'].includes(next);
  assert.equal(reviews.length,queued?1:0);assert.equal(after.state,queued?'complete':'held');
  if(queued)assert.equal(validateQueuedReview({...f.context(),item:reviews[0]}).head,f.head);
  assert.equal(fs.readFileSync(path.join(f.directory,'passes.jsonl'),'utf8').split('\n').filter(s=>s&&JSON.parse(s).action==='review-queue-no-mutation').length,1);
});

test('queue absence and a resolved reference cannot authorize refused, ambiguous or already consumed receipts',t=>{
  const f=fixture(t),original=failedQueue(f);assert.equal(noMutation(f,original),null,'no disposition');
  resolveReviewReference(f.args());assert.ok(noMutation(f,original));
  const variants=[
    e=>e.state='started',e=>e.owner='other',e=>e.subject='other',e=>e.review_operation='native-review',
    e=>e.review_target.head=f.base,e=>e.failure.kind='fence',e=>e.result={},e=>e.history=[original],
    e=>e.history={},e=>e.native_launch_attempted=true,e=>e.worker={agent:'reviewer'},e=>e.recorded_review_status={},
    e=>e.queue_recovery={},e=>delete e.finished_at,e=>e.finished_at='2026-10-29T00:00:00Z',
    e=>e.receipt.status=1,e=>e.receipt.signal='SIGTERM',e=>e.receipt.stdout='possible review',
    e=>e.receipt.error='EACCES',e=>e.receipt.signal_sent=true,e=>delete e.receipt.signal_sent,
    e=>e.receipt.stderr+='record: native input refused\n',e=>e.receipt.stderr=e.receipt.stderr.replace(f.identity,'/foreign/.git'),
    e=>e.receipt.stderr=e.receipt.stderr.replace('record changed repeatedly while preparing a consistent read; no mutation attempted','invalid queue identity or contents'),
    e=>e.error='native input refused',
  ];
  for(const mutate of variants){const entry=structuredClone(original);mutate(entry);assert.equal(noMutation(f,entry),null,mutate.toString());}
  for(const event of [
    {type:'review.verdict',run:'R-1',head:f.head},
    {type:'review.recovery-intent',item:'ENG-1',target:{head:f.head}},
    {type:'change.reviewed',item:'ENG-1',head:f.head},
  ]){const c=f.context();c.events=[...c.events,{...event,seq:c.events.at(-1).seq+1}];assert.equal(noMutation(f,original,c),null);}
  const queued=f.queue();assert.equal(noMutation(f,original),null,'even an unstarted existing review stays retained');
  f.add([{type:'run.started',id:'R-2',item:queued.review_item,workspace:f.repo,meta:{}}]);assert.equal(noMutation(f,original),null);
});

test('Brain retained outcome:review failures remain held; absence is not a pre-append receipt',t=>{
  const f=fixture(t);resolveReviewReference(f.args());
  const cases=JSON.parse(fs.readFileSync(new URL('./fixtures/review-queue-outcomes.json',import.meta.url))).cases;
  assert.equal(cases.length,6);
  for(const saved of cases){
    const entry={...failedQueue(f),error:saved.error,receipt:saved.receipt,failure:saved.failure};
    assert.equal(noMutation(f,entry),null,saved.source_key);
  }
});

for(const obstacle of ['STOP','competing-attempt','changed-archive','started-continuation'])test(`pre-append continuation retains ${obstacle} without a replacement`,t=>{
  const f=fixture(t);resolveReviewReference(f.args());let calls=0;
  const options={repo:f.repo,org:f.org,to:'fixture-supervisor',env:f.serviceEnv,command:(_exe,args)=>{
    if(args[1]!=='queue-review')return{status:0,stdout:'{"created":[]}',stderr:''};
    calls++;return contentionReceipt(f);
  }};
  createLineService(options).pass();const file=path.join(f.directory,'effects.json'),key=`review:ENG-1:${f.head}`,before=JSON.parse(fs.readFileSync(file));
  if(obstacle==='STOP')fs.writeFileSync(path.join(f.directory,'STOP'),'hold');
  if(obstacle==='competing-attempt'){
    fs.mkdirSync(path.join(f.org,'settle'));fs.writeFileSync(path.join(f.org,'settle/R-1.json'),JSON.stringify({kind:'settle',run:'R-1',head:f.head,native_launch_attempted:true}));
  }
  if(obstacle==='changed-archive'){
    const e=f.context().events.find(e=>e.type==='review.reference-resolved');fs.chmodSync(e.archive.file,0o600);fs.appendFileSync(e.archive.file,' ');
  }
  if(obstacle==='started-continuation'){
    const e=before.actions[key];before.actions[key]={...e,state:'started',history:[e],queue_recovery:noMutation(f,e)};fs.writeFileSync(file,JSON.stringify(before));
  }
  createLineService(options).pass();createLineService(options).pass();
  assert.equal(calls,1);assert.deepEqual(JSON.parse(fs.readFileSync(file)).actions[key],before.actions[key]);
});

for(const disposition of ['mapped-review','superseded'])test(`${disposition} binds the exact existing record review and never creates a replacement`,t=>{
  const f=fixture(t);fs.unlinkSync(f.reference);const q=f.queue(),c=f.context(),target=c.state.items.get(q.review_item).meta.review_target;
  f.add([{type:'run.started',id:'R-2',item:q.review_item,workspace:f.repo,meta:{}}]);
  if(disposition==='superseded')f.add([{type:'change.reviewed',item:'ENG-1',head:f.head,review_item:q.review_item,review_run:'R-2',verdict:'PASS'}]);
  f.prepare({run:'R-1',head:f.head,base:f.base,native_launch_attempted:true,review_item:q.review_item},disposition,{review_item:q.review_item});
  resolveReviewReference(f.args());const next=f.context();
  assert.equal(resolvedReference({...next,item:'ENG-1',run:'R-1',file:f.reference}),true);
  assert.match(reviewAttempt(next.item,next),/existing whole producer/);
  assert.deepEqual(next.state.items.get(q.review_item).meta.review_target,target);
  assert.equal([...next.state.items.values()].filter(i=>i.role==='reviewer').length,1);
});

for(const kind of ['unknown','started','worker','verdict','refused','wrong-head','wrong-base','contradictory-head','contradictory-base','foreign','foreign-dot','hold','ancestor-hold','stop','wrong-supervisor','claim','decision','hash','ambiguous-scope','occupied'])test(`reference disposition refuses ${kind} and preserves the original`,t=>{
  const f=fixture(t),value={run:'R-1',head:f.head,base:f.base,stage:'worker',native_launch_attempted:false};let options={};
  if(kind==='unknown')delete value.native_launch_attempted;
  if(kind==='started')value.native_launch_attempted=true;
  if(kind==='worker')value.worker={agentName:'original'};
  if(kind==='verdict')value.verdict='PASS';
  if(kind==='refused')value.error='EPERM native refusal';
  if(kind==='wrong-head')value.head=f.base;
  if(kind==='wrong-base')value.base=f.head;
  if(kind==='contradictory-head')value.deliveryRange={head:f.base,base:f.base};
  if(kind==='contradictory-base')value.deliveryRange={head:f.head,base:f.head};
  f.prepare(value);
  if(kind==='foreign')options.resolution='/another-owner/input.json';
  if(kind==='foreign-dot')options.resolution=f.ownerRoot+'/../another-owner/input.json';
  if(kind==='hold')f.add([{type:'item.updated',id:'ENG-1',fields:{meta:{hold:true}}}]);
  if(kind==='ancestor-hold')f.add([{type:'item.added',id:'G-1',kind:'goal',meta:{hold:true}},{type:'item.updated',id:'ENG-1',fields:{parent:'G-1'}}]);
  if(kind==='stop')fs.writeFileSync(path.join(f.directory,'STOP'),'stop');
  if(kind==='wrong-supervisor')options.call=()=>JSON.stringify({result:{agent:{...f.observation.agents[0],name:'other'}}});
  if(kind==='claim')f.add([{type:'run.claimed',run:'R-1',record:f.org,project:f.identity,owner:{controller:'foreign',legacy:true}}]);
  if(kind==='decision')options.decisionSeq=1;
  if(kind==='hash')fs.appendFileSync(f.reference,' ');
  if(kind==='ambiguous-scope'){
    const c=f.context(),target={...c.target,scope:{...c.target.scope,unresolved:['UNKNOWN']}};
    assert.throws(()=>referenceProof({...c,item:'ENG-1',run:'R-1',target,input:f.input()}),/scope is UNKNOWN/);return;
  }
  if(kind==='occupied')fs.mkdirSync(path.join(f.directory,'pass.lock'));
  const before=f.captured(),bytes=fs.readFileSync(f.reference);
  assert.throws(()=>resolveReviewReference({...f.args(),...options}));assert.deepEqual(f.captured(),before);assert.deepEqual(fs.readFileSync(f.reference),bytes);
});

for(const producer of [false,true])test(`tampered archives and progressed ${producer?'producer handoff':'barrier'} references remain held at normal admission`,t=>{
  for(const kind of ['archive','reference','missing','untyped']){
    const f=fixture(t);if(producer)f.prepare(producerHandoff(f));resolveReviewReference(f.args());const c=f.context(),e=c.events.find(e=>e.type==='review.reference-resolved');
    const file=kind==='archive'?e.archive.file:f.reference;fs.chmodSync(file,0o600);
    if(kind==='missing')fs.unlinkSync(file);else if(kind==='untyped')fs.writeFileSync(file,'{}');else fs.appendFileSync(file,' ');
    assert.throws(()=>reviewAttempt(c.item,c));assert.throws(()=>f.queue());
  }
});

for(const producer of [false,true])test(`${producer?'producer handoff':'barrier'} disposition never suppresses a second original native attempt or permits an alternative resolution`,t=>{
  const f=fixture(t);if(producer)f.prepare(producerHandoff(f));resolveReviewReference(f.args());
  fs.mkdirSync(path.join(f.org,'settle'));fs.writeFileSync(path.join(f.org,'settle/R-1.json'),JSON.stringify({kind:'settle',run:'R-1',head:f.head,native_launch_attempted:true}));
  assert.match(reviewAttempt(f.context().item,f.context()),/settle attempt/);assert.throws(()=>f.queue(),/already retained/);
  assert.throws(()=>resolveReviewReference({...f.args(),id:'replacement'}),/decision|replacement/);
});

test('mapping refuses an unstarted queue, contradictory references, and a different target or missing verdict',t=>{
  for(const kind of ['unstarted','contradictory','target','verdict']){
    const f=fixture(t);fs.unlinkSync(f.reference);const q=f.queue();
    if(kind!=='unstarted')f.add([{type:'run.started',id:'R-2',item:q.review_item,workspace:f.repo,meta:{}}]);
    const value={run:'R-1',head:f.head,base:f.base,review_item:q.review_item,native_launch_attempted:true};
    if(kind==='contradictory')value.review={item:'REV-other'};
    if(kind==='target')f.add([{type:'item.updated',id:q.review_item,fields:{meta:{...f.context().state.items.get(q.review_item).meta,review_target:{...f.context().target,diff_sha256:'0'.repeat(64)}}}}]);
    f.prepare(value,kind==='verdict'?'superseded':'mapped-review',{review_item:q.review_item});
    const bytes=f.captured();assert.throws(()=>resolveReviewReference(f.args()));assert.deepEqual(f.captured(),bytes);
  }
});
