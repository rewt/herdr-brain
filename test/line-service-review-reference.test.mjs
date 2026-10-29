import test from './helpers/bounded-test.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {configFixture} from './helpers/config-home-fixture.mjs';
import {loadEvents,transact} from '../lib/store.mjs';
import {fold} from '../lib/state.mjs';
import {gitProject} from '../lib/project.mjs';
import {lineDirectory} from '../line-service/cutoff.mjs';
import {inspectReviewReferences,resolveReviewReference} from '../line-service/review-reference.mjs';
import {referenceProof,resolvedReference} from '../line-service/review-reference-proof.mjs';
import {reviewDigest as hash} from '../line-service/review-resolutions.mjs';
import {reviewAttempt} from '../line-service/review.mjs';
import {queueReviewMutation,validateQueuedReview} from '../line-service/review-queue.mjs';
import {createLineService,sourceRoot} from '../line-service/line-service.mjs';

const root=fs.realpathSync(sourceRoot);
function fixture(t){
  const f=configFixture(t,{custom:true}),repo=f.cwd,org=f.env.ORG_DIR,identity=gitProject(repo).identity;
  fs.writeFileSync(path.join(repo,'.promote.json'),JSON.stringify({to:'fixture-supervisor'}));f.git('add','.promote.json');f.git('commit','-qm','Supervisor policy');
  const base=f.git('rev-parse','HEAD');fs.writeFileSync(path.join(repo,'build'),'landed change');f.git('add','build');f.git('commit','-qm','Build');const head=f.git('rev-parse','HEAD');
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
    ...['reviewer','launchProcess','sessionBinding','watcher','verdict','review_item','review_run','agent','pane','terminal','session','pid','reviewer_session','reviewer_pane'].map(k=>v=>v[k]=k==='pid'?123:'existing'),
    v=>v.error='EPERM native refusal',v=>v.review={worker:'fixture-reviewer'},v=>v.stage='launched',
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
