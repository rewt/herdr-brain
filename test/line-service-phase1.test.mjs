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
import {discoverChanges,blockedChangeKey,dispatchInput,reviewResultEvents,morningDigest,recordReviewResults,canonicalReviewIndex,reviewHealth,ensureReviewBoundary,phase0Boundary} from '../line-service/phase1.mjs';
import {reviewAttempt,selectedReviewConsumer} from '../line-service/review.mjs';
import {queueReviewMutation,reviewQueueRoute,validateQueuedReview} from '../line-service/review-queue.mjs';
import {ROUTE_PRESET} from '../lanes/preset.mjs';
import {loadDiscoveredRoutes,resolveRoute} from '../lanes/routes.mjs';
import {fixture as dispatchFixture,promptCalls} from '../dispatch/test/dispatch-fixture.mjs';
import {countSessions,checkSessionCap} from '../dispatch/session-cap.mjs';
import {closeoutCodeIdentity,bindCloseoutCode} from '../lib/closeout-code.mjs';
import {kickCloseout,bindCloseoutSources,publishCloseoutEvents,CLOSEOUT_EXIT_PENDING} from '../lib/closeout.mjs';
import {safeCloseoutRetry} from '../lib/closeout.mjs';
import {establishCutover,developmentRoot} from '../line-service/cutoff.mjs';
import {recordOwnLanding} from '../lib/landing-receipt.mjs';
import {noticeLock} from '../supervisor/notice-lock.mjs';
import {readReport} from '../lib/report.mjs';
import {recoverInactiveReview,observeReviewProgress,recoverServiceReview} from '../line-service/review-recovery.mjs';
import {claimedCommitTokens} from '../settle/review-range.mjs';
import {capturedReviewCommits} from '../line-service/review-group.mjs';
import {canonicalSelector} from '../line-service/review-targets.mjs';
import {fold as historicalFold} from './fixtures/state-pre-session-bind.mjs';
import {canonical} from '../messages/schema.mjs';
import {nativeCloseoutWait,closeoutWaitState} from '../lib/closeout-status.mjs';
import {setConfig} from '../lib/config-command.mjs';
import {readProjectPolicy} from '../lib/config-policy.mjs';
import {haltObservation,completeHaltPass} from '../line-service/halt-repair.mjs';
import {inspectReviewAdmission} from '../line-service/review-admission.mjs';
import {queueSelected} from '../line-service/priority-order.mjs';

const hash=b=>createHash('sha256').update(b).digest('hex');
function fixture(t,{reported=true,role='engineer'}={}){
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
    {type:'item.added',id:'ENG-1',title:'Build',role},
    {type:'run.started',id:'R-1',item:'ENG-1',workspace,report_path:path.join(org,'runs/R-1/report.md'),meta:{lane:'source',dispatch_record:org,dispatch_project:identity,dispatch_journal:dispatch,dispatch_attempt:'source'}},
    {type:'run.claimed',run:'R-1',record:org,project:identity,owner:{controller:'brain',legacy:false,release:{id:'source',root:sourceRoot,commit:null,identity:gitProject(sourceRoot).identity}}}];
  if(reported)events.push({type:'report.ingested',run:'R-1',item:'ENG-1',file:'reports/R-1.md',sha256:hash(report),report:{run:'R-1',outcome:'done',summary:'Actual source',artifacts:heads.map(h=>`Commit: ${h}`),extra:{},blockers:[],proposals:[]}});
  transact(org,()=>({add:events}));
  const context=()=>{const events=loadEvents(org).events,state=fold(events);return {events,state,org,repo:f.cwd,identity,item:state.items.get('ENG-1'),run:state.runs.get('R-1')};};
  const add=rows=>transact(org,()=>({add:rows}));
  return {...f,org,identity,base,heads,workspace,directory,report,file,git,context,add};
}

const diagnostics=f=>fs.readFileSync(path.join(f.directory,'passes.jsonl'),'utf8').trim().split('\n').map(JSON.parse);
const diagnosticHealth=f=>diagnostics(f).findLast(r=>r.health)?.health;
const closeoutCheckpoint=f=>JSON.parse(fs.readFileSync(path.join(f.directory,'closeout-turn.json'),'utf8'));

test('cleanup tail historical requests are independent of the review phase-zero cutoff',t=>{
  const f=fixture(t),policy=JSON.parse(fs.readFileSync(path.join(f.cwd,'.lane.json')));policy.retirement={closeout_queue:true};fs.writeFileSync(path.join(f.cwd,'.lane.json'),JSON.stringify(policy));
  const source=transact(f.org,events=>bindCloseoutSources({cwd:f.cwd,org:f.org,events,env:f.env,mutation:{add:[{type:'item.closed',id:'ENG-1',as:'done',completed_run:'R-1'}]}})).added;
  publishCloseoutEvents({cwd:f.cwd,org:f.org,added:source,start:false,env:f.env});const key=source[0].closeout_targets[0].key;
  const older=f.context().events.filter(e=>e.type!=='line-service.phase0');fs.writeFileSync(path.join(f.org,'events.jsonl'),older.map(e=>JSON.stringify(e)+'\n').join(''));
  f.add([{type:'line-service.phase0',id:'late-review-boundary',project:f.identity,repo:f.cwd,org:f.org,source:sourceRoot,main:'main',canonical_head:f.heads[1]}]);
  const calls=[];createLineService({repo:f.cwd,org:f.org,to:'brain-chat',env:f.env,capacity:()=>({count:0,cap:4}),recordNotice:d=>({id:d.id}),command:(_exe,args)=>{if(args[0].endsWith('supervisor/closeout.mjs')){calls.push(args);return{status:0,stdout:JSON.stringify(args[1]==='refresh'?{created:[]}:{evaluated:[{key,run:'R-1',completed:true}]}),stderr:''};}return{status:0,stdout:'{}',stderr:''};}}).pass();
  assert.ok(calls.some(a=>a.includes('drain')&&JSON.parse(a[a.indexOf('--keys')+1]).includes(key)),'cleanup must evaluate its valid original binding despite a later review cutoff');
});

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

function admissionService(f,extra={}){
  const calls=[],env=installedService(f);
  const service=createLineService({repo:f.cwd,org:f.org,to:'supervisor-test',env,haltAfter:1,recordNotice:d=>({id:d.id,state:'record-only'}),
    capacity:()=>({count:0,cap:4}),command:(exe,args,options)=>{
      calls.push(args);if(args[1]==='queue-review')return spawnSync(exe,args,options);
      return{status:0,stdout:'{}',stderr:''};
    },...extra});
  return{calls,pass:()=>{const cwd=process.cwd();process.chdir(f.cwd);try{return service.pass();}finally{process.chdir(cwd);}}};
}
const admissionPolicy=(f,policy)=>setConfig('review_admission',JSON.stringify({enabled:true,producer_groups:[],canonical_commits:[],hold_ordinary:true,...policy}),{cwd:f.cwd,env:f.env,who:'review admission fixture'});
function admissionQueue(f){
  const cwd=process.cwd(),env={...installedService(f),ORG_ACTOR:'line-service'};process.chdir(f.cwd);
  try{const mutation=queueReviewMutation({...f.context(),runId:'R-1',head:f.heads[1],base:f.base,env});for(const e of mutation.add.filter(e=>e.type==='item.added'))assert.match(e.accept[0],/^Why:[\s\S]*How we will know it works:/);f.add(mutation.add);return mutation;}
  finally{process.chdir(cwd);}
}

const ordinaryPolicy=(f,policy)=>setConfig('ordinary_admission',JSON.stringify({selected_only:true,...policy}),{cwd:f.cwd,env:f.env,who:'explicit ordinary fixture wave'});

test('ordinary admission read-only preview includes every pending exclusion and proposed named ancestors without applying policy',t=>{
  const f=fixture(t,{reported:false});
  f.add([{type:'item.closed',id:'ENG-1',as:'done'},{type:'item.added',id:'G-9',kind:'goal',title:'Wave'},
    {type:'item.added',id:'ENG-10',role:'engineer',parent:'G-9',title:'Wave work'},
    {type:'item.added',id:'ENG-11',role:'engineer',title:'Historical backlog'},
    {type:'item.added',id:'ENG-12',role:'engineer',parent:'G-9',title:'Veto',meta:{queue_selected:false}}]);
  ordinaryPolicy(f,{items:[]});
  const events=fs.readFileSync(path.join(f.org,'events.jsonl')),bytes=fs.readFileSync(path.join(f.cwd,'.lane.json'));
  const view=inspectReviewAdmission({repo:f.cwd,org:f.org,env:f.env,ordinaryPolicy:{selected_only:true,items:['G-9']}});
  assert.equal(view.ordinary_admission_preview,true);
  const byId=new Map(view.candidates.filter(c=>c.kind==='ordinary').map(c=>[c.item,c]));
  assert.equal(byId.get('ENG-10').selected,true);assert.equal(byId.get('ENG-10').hold,null);
  assert.equal(byId.get('ENG-11').hold.code,'ORDINARY_ADMISSION_NOT_SELECTED');
  assert.equal(byId.get('ENG-12').hold.code,'ORDINARY_ADMISSION_DESELECTED');
  const cli=spawnSync(process.execPath,[path.join(sourceRoot,'line-service/review-admission.mjs'),'--repo',f.cwd,'--org',f.org,'--ordinary-admission',JSON.stringify({selected_only:true,items:['G-9']})],{cwd:f.cwd,env:f.env,encoding:'utf8'});
  assert.equal(cli.status,0,cli.stderr);assert.deepEqual(JSON.parse(cli.stdout).candidates,view.candidates);
  assert.deepEqual(fs.readFileSync(path.join(f.org,'events.jsonl')),events);
  assert.deepEqual(fs.readFileSync(path.join(f.cwd,'.lane.json')),bytes);
  assert.equal(fs.existsSync(path.join(f.directory,'effects.json')),false,'preview creates no service effects');
});

test('ordinary admission selected wave starts concurrently up to the build pool in item-named lanes and resumes after report closeout',t=>{
  const f=fixture(t,{reported:false});
  f.add([{type:'item.closed',id:'ENG-1',as:'done'},{type:'item.added',id:'G-9',kind:'goal',title:'Selected wave'},
    ...[10,11,12,13].map(n=>({type:'item.added',id:`ENG-${n}`,role:'engineer',parent:'G-9',title:`Selected ${n}`})),
    {type:'item.added',id:'ENG-90',role:'engineer',priority:9999,title:'Unflagged historical backlog'},
    {type:'item.added',id:'ENG-91',role:'engineer',parent:'G-9',title:'Deselected descendant',meta:{queue_selected:false}}]);
  ordinaryPolicy(f,{items:['G-9']});
  const config={dispatch:{max_sessions:2,max_review_sessions:3}},launched=[],journals=new Map();
  const capacity=kind=>checkSessionCap({config,org:f.org,common:f.identity,kind,readProcess:()=>({ok:false})});
  const s=admissionService(f,{haltAfter:100,capacity,command:(_exe,args)=>{
    if(!args[0].endsWith('/dispatch/dispatch.mjs'))return{status:0,stdout:'{}',stderr:''};
    const item=args[1],n=Number(item.slice(4)),run=`R-${n}`,journal=path.join(f.org,`dispatch/wave-${item}.json`);
    assert.equal(args[args.indexOf('--lane')+1],`line-${item.toLowerCase()}-1`);
    assert.ok(args.includes('--detach'));assert.equal(launched.includes(item),false,'each original launch occurs once');
    launched.push(item);journals.set(item,journal);
    fs.writeFileSync(journal,JSON.stringify({stage:'open',detached:true,common:f.identity,item,run,org:f.org}));
    f.add([{type:'run.started',id:run,item,workspace:f.cwd,meta:{dispatch_project:f.identity}}]);
    return{status:0,stdout:JSON.stringify({result:'detached',journal}),stderr:''};
  }});
  s.pass();assert.deepEqual(launched,['ENG-10','ENG-11']);
  assert.throws(()=>capacity('build'),e=>e.code==='DISPATCH_SESSION_CAP'&&e.sessions.count===2);
  assert.equal(capacity('review').count,0,'review slots remain separate');
  const effects=JSON.parse(fs.readFileSync(path.join(f.directory,'effects.json')));
  for(const [item,code]of [['ENG-90','ORDINARY_ADMISSION_NOT_SELECTED'],['ENG-91','ORDINARY_ADMISSION_DESELECTED']])
    assert.ok(effects.ordinary_admission.held.some(h=>h.item===item&&h.code===code));
  const original=fs.readFileSync(journals.get('ENG-10'));
  f.add([{type:'report.ingested',run:'R-10',file:'reports/wave.md',report:{outcome:'done',artifacts:[],blockers:[],proposals:[],extra:{}}},
    {type:'item.closed',id:'ENG-10',as:'done',completed_run:'R-10'}]);
  s.pass();assert.deepEqual(launched,['ENG-10','ENG-11','ENG-12']);
  assert.deepEqual(fs.readFileSync(journals.get('ENG-10')),original,'report completion frees capacity without replacing its attempt');
  for(const item of ['ENG-13','ENG-90','ENG-91'])assert.equal(f.context().state.items.get(item).closed,null);
});

test('ordinary admission recovery starts the next selected item as the line while held reserved and backlog work stay pending',t=>{
  const f=fixture(t,{reported:false});
  f.add([{type:'item.closed',id:'ENG-1',as:'done'},
    {type:'item.added',id:'G-9',kind:'goal',title:'Held branch',meta:{hold:true}},
    {type:'item.added',id:'ENG-10',role:'engineer',title:'Next selected',meta:{queue_selected:true}},
    {type:'item.added',id:'ENG-11',role:'engineer',title:'Own hold',priority:99,meta:{queue_selected:true,hold:true}},
    {type:'item.added',id:'ENG-12',role:'engineer',title:'Reserved',priority:98,meta:{queue_selected:true,operator_reserved:true}},
    {type:'item.added',id:'ENG-13',role:'engineer',parent:'G-9',title:'Inherited hold',priority:97,meta:{queue_selected:true}},
    {type:'item.added',id:'ENG-90',role:'engineer',title:'Unflagged backlog',priority:999},
    {type:'item.added',id:'ENG-91',role:'engineer',title:'Explicit veto',priority:998,meta:{queue_selected:false}}]);
  ordinaryPolicy(f,{});admissionPolicy(f,{});
  const before=inspectReviewAdmission({repo:f.cwd,org:f.org,env:f.env}),launches=[];
  const s=admissionService(f,{haltAfter:100,command:(_exe,args,options)=>{
    if(!args[0].endsWith('/dispatch/dispatch.mjs'))return{status:0,stdout:'{}',stderr:''};
    assert.equal(options.env.ORG_ACTOR,'line-service');
    launches.push(args[1]);assert.equal(args[1],'ENG-10');
    // Native launching is an adapter here. Record the start using the actor the
    // line actually passes to dispatch; this is never a live-consumer start.
    transact(f.org,()=>({add:[{type:'run.started',id:'R-10',item:args[1],workspace:f.cwd,
      meta:{dispatch_project:f.identity}}]}),{actor:options.env.ORG_ACTOR});
    return{status:0,stdout:JSON.stringify({result:'dispatched',run:'R-10'}),stderr:''};
  }});
  s.pass();assert.deepEqual(launches,[]);
  assert.ok(diagnostics(f).some(row=>row.item==='ENG-10'&&row.code==='REVIEW_ADMISSION_ORDINARY_HELD'));
  setConfig('review_admission.hold_ordinary','false',{cwd:f.cwd,env:f.env,who:'fixture owner releases ordinary hold'});
  const after=inspectReviewAdmission({repo:f.cwd,org:f.org,env:f.env});
  assert.deepEqual(after.policy,{...before.policy,hold_ordinary:false},'exact review allowlists are retained');
  s.pass();assert.deepEqual(launches,['ENG-10']);
  const {events,state}=f.context(),starts=events.filter(e=>e.type==='run.started'&&e.id==='R-10');
  assert.equal(starts.length,1);assert.equal(starts[0].by,'line-service');
  for(const id of ['ENG-11','ENG-12','ENG-13','ENG-90','ENG-91']){
    const item=state.items.get(id);assert.equal(item.closed,null,id);assert.deepEqual(item.runs,[],id);
    assert.ok(after.candidates.some(row=>row.item===id),`${id} remains visible in inspection`);
  }
  const held=JSON.parse(fs.readFileSync(path.join(f.directory,'effects.json'))).ordinary_admission.held;
  assert.ok(held.some(row=>row.item==='ENG-90'&&row.code==='ORDINARY_ADMISSION_NOT_SELECTED'));
  assert.ok(held.some(row=>row.item==='ENG-91'&&row.code==='ORDINARY_ADMISSION_DESELECTED'));
  t.diagnostic(JSON.stringify({witness:'ordinary-admission-recovery',starts:starts.map(({id,item,by})=>({id,item,by})),
    retained:['ENG-11','ENG-12','ENG-13','ENG-90','ENG-91'],native:'stubbed; installed consumer recovery remains unrun'}));
});

test('ordinary admission rereads policy and selection after capacity without starting a stale or failed attempt',t=>{
  for(const change of ['policy','flag','ancestor']){
    const f=fixture(t,{reported:false});f.add([{type:'item.closed',id:'ENG-1',as:'done'},
      {type:'item.added',id:'G-9',kind:'goal',title:'Wave'},
      {type:'item.added',id:'ENG-10',role:'engineer',title:'Selected',parent:'G-9'}]);
    ordinaryPolicy(f,{items:['G-9']});admissionPolicy(f,{hold_ordinary:false});let changed=false;
    const s=admissionService(f,{capacity:kind=>{
      assert.equal(kind,'build','this fixture isolates ordinary launches from independent review admission');
      if(!changed){changed=true;if(change==='policy')ordinaryPolicy(f,{items:[]});
        else f.add([{type:'item.updated',id:'ENG-10',fields:change==='flag'?{meta:{queue_selected:false}}:{parent:null}}]);}
      return{count:0,cap:4};
    }});s.pass();
    assert.equal(changed,true);assert.equal(s.calls.some(a=>a[0].endsWith('/dispatch/dispatch.mjs')),false,change);
    const effects=JSON.parse(fs.readFileSync(path.join(f.directory,'effects.json')));
    assert.equal(Object.keys(effects.actions).some(k=>k.startsWith('dispatch:')),false,change);
    assert.ok(effects.ordinary_admission.held.some(h=>h.stage==='launch-mutation'),change);
  }
});

test('ordinary admission selected-only halt repair is selected and dispatched once through normal repair admission',t=>{
  const f=fixture(t,{reported:false});
  f.add([{type:'item.closed',id:'ENG-1',as:'done'},
    {type:'item.added',id:'ENG-10',role:'engineer',title:'Selected stalled work'}]);
  const policy={selected_only:true,items:['ENG-10']};
  ordinaryPolicy(f,policy);admissionPolicy(f,{hold_ordinary:false});
  let capacityCalls=0;const dispatched=[];
  const s=admissionService(f,{capacity:kind=>{
    assert.equal(kind,'build');
    // The selected work stalls, then capacity is free for the repair in this pass.
    if(++capacityCalls===1)throw Object.assign(Error('build pool occupied'),{code:'DISPATCH_SESSION_CAP',sessions:{kind:'build',count:1,cap:1,sessions:[]}});
    return{count:0,cap:1,sessions:[]};
  },command:(_exe,args)=>{
    if(!args[0].endsWith('/dispatch/dispatch.mjs'))return{status:0,stdout:'{}',stderr:''};
    const {state}=f.context(),item=state.items.get(args[1]);
    assert.equal(item.meta.halt_repair,1);assert.equal(queueSelected(item,state,policy),true);
    dispatched.push(args);return{status:0,stdout:JSON.stringify({result:'detached'}),stderr:''};
  }});
  s.pass();
  const {state}=f.context(),repairs=[...state.items.values()].filter(i=>i.meta.halt_repair===1);
  assert.equal(repairs.length,1);const [repair]=repairs;
  assert.equal(repair.meta.queue_selected,true);assert.equal(queueSelected(repair,state,policy),true);
  assert.equal(dispatched.length,1);assert.equal(dispatched[0][1],repair.id);
  assert.equal(dispatched[0][dispatched[0].indexOf('--lane')+1],`line-${repair.id.toLowerCase()}-1`);
  assert.ok(dispatched[0].includes('--detach'));assert.equal(capacityCalls,3);
  const rows=diagnostics(f);
  assert.ok(rows.some(r=>r.action==='capacity-held'&&r.item==='ENG-10'));
  assert.ok(rows.some(r=>r.action==='engineering-idle'&&r.item===repair.id&&r.dispatch===true));
  const effects=JSON.parse(fs.readFileSync(path.join(f.directory,'effects.json')));
  assert.equal(effects.ordinary_admission.held.some(h=>h.item===repair.id),false);
});

test('ordinary admission idle repair audits adopted policy before its record transaction and keeps the source revision',async t=>{
  // Adopt before introducing work; the source-review fixture intentionally has
  // an open development writer, which correctly cannot adopt a release home.
  const base=configFixture(t,{custom:true});await base.adopt();
  const org=base.env.ORG_DIR,identity=gitProject(base.cwd).identity,directory=serviceDirectory(org,identity);
  const f={...base,org,identity,directory,context:()=>{const events=loadEvents(org).events;return{events,state:fold(events),org};}};
  transact(org,()=>({add:[{type:'item.added',id:'ENG-10',role:'engineer',title:'Selected stalled work',meta:{queue_selected:true}}]}));
  ordinaryPolicy(f,{});const env=installedService(f),selected=readProjectPolicy(f.cwd,'lane',f.env);
  const config=structuredClone(selected.config);config.ordinary_admission.items=['ENG-10'];
  fs.writeFileSync(selected.file,JSON.stringify(config)+'\n');
  const observation=haltObservation({...f.context(),identity:f.identity,config});
  const release=noticeLock(path.join(f.directory,'pass.lock'));
  try{
    const result=completeHaltPass({repo:f.cwd,org:f.org,env,pass:'ordinary-adopted-policy',observation,route:'engineer',after:1,audit:path.join(f.directory,'passes.jsonl'),effects:path.join(f.directory,'effects.json')});
    assert.ok(result.item);
    const events=f.context().events,audit=events.findLast(e=>e.type==='config.changed'&&e.file===selected.file),repair=events.find(e=>e.type==='item.added'&&e.id===result.item);
    assert.equal(audit.origin,'hand-edit');assert.ok(audit.seq<repair.seq,'policy audit completes before the repair transaction');
    assert.deepEqual(audit.new_value.ordinary_admission,{selected_only:true,items:['ENG-10']});
  }finally{release();}
});

test('ordinary admission selection preserves review holds original UNKNOWN attempts and normal cleanup',t=>{
  const f=fixture(t),policy=JSON.parse(fs.readFileSync(path.join(f.cwd,'.lane.json')));
  policy.retirement={closeout_queue:true};fs.writeFileSync(path.join(f.cwd,'.lane.json'),JSON.stringify(policy));
  const added=transact(f.org,events=>bindCloseoutSources({cwd:f.cwd,org:f.org,events,env:f.env,mutation:{add:[{type:'item.closed',id:'ENG-1',as:'done',completed_run:'R-1'}]}})).added;
  publishCloseoutEvents({cwd:f.cwd,org:f.org,added,start:false,env:f.env});
  f.add([{type:'item.added',id:'ENG-10',role:'engineer',title:'Selected',meta:{queue_selected:true}},
    {type:'item.added',id:'ENG-90',role:'engineer',title:'Backlog'}]);
  ordinaryPolicy(f,{});admissionPolicy(f,{});
  const calls=[],s=admissionService(f,{haltAfter:100,command:(_exe,args)=>{calls.push(args);return{status:0,stdout:args[1]==='drain'?JSON.stringify({evaluated:[{key:added[0].closeout_targets[0].key,completed:true}]}):'{}',stderr:''};}});
  s.pass();assert.ok(diagnostics(f).some(d=>d.action==='review-admission-held'&&d.item==='ENG-10'&&d.code==='REVIEW_ADMISSION_ORDINARY_HELD'));
  assert.equal(closeoutCheckpoint(f).last_result.result.evaluated[0].completed,true,'normal original closeout drain still runs');
  admissionPolicy(f,{hold_ordinary:false});
  const item=f.context().state.items.get('ENG-10'),input=dispatchInput({...f.context(),item}),key=`dispatch:${item.id}:${input}`;
  const effectsFile=path.join(f.directory,'effects.json'),effects=JSON.parse(fs.readFileSync(effectsFile));
  const original={state:'started',owner:'line-service',error:'UNKNOWN original native outcome',receipt:{status:null,stdout:'original evidence'}};
  effects.actions[key]=original;fs.writeFileSync(effectsFile,JSON.stringify(effects));
  s.pass();
  assert.equal(calls.some(a=>a[0].endsWith('/dispatch/dispatch.mjs')),false);
  const kept=JSON.parse(fs.readFileSync(effectsFile)).actions[key];
  for(const [field,value]of Object.entries(original))assert.deepEqual(kept[field],value);
  assert.equal(kept.history,undefined);
  f.add([{type:'item.updated',id:'ENG-10',fields:{meta:{queue_selected:false}}}]);
  admissionService(f).pass();
  assert.equal([...f.context().state.items.values()].some(i=>i.meta.halt_repair),false,'unselected backlog never manufactures a repair');
});

test('review admission queues and launches only exact allowlisted producer groups and canonical commits, visibly retaining every exclusion',t=>{
  const f=fixture(t);independentProducer(f);
  const canonical=[];for(const n of [1,2]){fs.writeFileSync(path.join(f.cwd,'unattributed'),String(n));f.git(['add','.'],f.cwd);f.git(['commit','-qm','Canonical source'],f.cwd);canonical.push(f.git(['rev-parse','HEAD'],f.cwd));}
  f.add([{type:'item.closed',id:'ENG-1',as:'done'},{type:'item.closed',id:'ENG-2',as:'done'},{type:'item.added',id:'ENG-99',role:'engineer',title:'Ordinary work'}]);
  const changes=discoverChanges(f.context()).changes,key=changes.find(c=>c.item.id==='ENG-2').target.source_group.key;
  admissionPolicy(f,{producer_groups:[key],canonical_commits:[canonical[0]]});
  const before=f.context().events,view=inspectReviewAdmission({repo:f.cwd,org:f.org,env:f.env});
  assert.deepEqual(f.context().events,before,'inspection writes no record events');
  assert.ok(view.candidates.some(c=>c.item==='ENG-1'&&c.hold.code==='REVIEW_ADMISSION_PRODUCER_NOT_ALLOWED'));
  assert.ok(view.candidates.some(c=>c.head===canonical[1]&&c.hold.code==='REVIEW_ADMISSION_CANONICAL_NOT_ALLOWED'));
  const s=admissionService(f);s.pass();
  const queues=[...f.context().state.items.values()].filter(q=>q.role==='reviewer');
  assert.equal(queues.length,2);assert.ok(queues.some(q=>q.meta.review_source_item==='ENG-2'));assert.ok(queues.some(q=>q.meta.review_source_selector==='canonical:'+canonical[0]));
  assert.equal(s.calls.filter(a=>a[0].endsWith('/dispatch/dispatch.mjs')).length,2);
  assert.equal(s.calls.some(a=>a[1]==='ENG-99'),false);
  const held=JSON.parse(fs.readFileSync(path.join(f.directory,'effects.json'))).review_admission.held;
  for(const code of ['PRODUCER_NOT_ALLOWED','CANONICAL_NOT_ALLOWED','ORDINARY_HELD'])assert.ok(held.some(h=>h.code==='REVIEW_ADMISSION_'+code));
  assert.equal([...f.context().state.items.values()].some(i=>i.meta.halt_repair),false,'intentional review-only selection does not manufacture an idle repair');
  assert.ok(discoverChanges(f.context()).changes.some(c=>c.item.id==='ENG-1'),'excluded debt remains discoverable');
});

test('review admission holds pre-existing reviews unchanged, then resumes only under the selected policy',t=>{
  const f=fixture(t),mutation=admissionQueue(f);
  const q=f.context().state.items.get(mutation.result.review_item),target=structuredClone(q.meta.review_target),key=target.source_group.key;
  admissionPolicy(f,{});
  const s=admissionService(f);s.pass();s.pass();
  assert.equal(s.calls.some(a=>a[0].endsWith('/dispatch/dispatch.mjs')),false);
  assert.deepEqual(f.context().state.items.get(q.id).meta.review_target,target);assert.deepEqual(f.context().state.items.get(q.id).runs,[]);
  admissionPolicy(f,{producer_groups:[key]});s.pass();
  assert.equal(s.calls.filter(a=>a[0].endsWith('/dispatch/dispatch.mjs')&&a[1]===q.id).length,1);
  assert.deepEqual(f.context().state.items.get(q.id).meta.review_target,target);
});

test('review admission retains an existing UNKNOWN launch and legacy review without replacing either attempt',t=>{
  const f=fixture(t),mutation=admissionQueue(f);
  const q=f.context().state.items.get(mutation.result.review_item),target=structuredClone(q.meta.review_target);
  f.add([{type:'item.added',id:'REV-99',role:'reviewer',title:'Old manual review'}]);
  const input=dispatchInput({...f.context(),item:q}),key=`dispatch:${q.id}:${input}`,original={state:'started',owner:'line-service',error:'UNKNOWN original native outcome',receipt:{status:null,stdout:'original evidence'}};
  const saved=path.join(f.org,'dispatch/retained.json'),savedBytes=JSON.stringify({token:'retained',item:q.id,org:f.org,common:f.identity,repo:f.cwd,stage:'complete',reviewQueueProtocol:1,reviewQueue:target,native_launch_attempted:true});fs.writeFileSync(saved,savedBytes);
  fs.writeFileSync(path.join(f.directory,'effects.json'),JSON.stringify({identity:f.identity,org:f.org,actions:{[key]:original}}));
  admissionPolicy(f,{});const s=admissionService(f);s.pass();s.pass();
  admissionPolicy(f,{producer_groups:[target.source_group.key]});s.pass();
  assert.equal(s.calls.some(a=>a[0].endsWith('/dispatch/dispatch.mjs')),false);
  const kept=JSON.parse(fs.readFileSync(path.join(f.directory,'effects.json'))).actions[key];
  for(const [field,value]of Object.entries(original))assert.deepEqual(kept[field],value,'original attempt and receipt stay intact');
  assert.equal(kept.original_outcome,undefined,'a started or UNKNOWN original command is not re-read or annotated by another pass');
  assert.equal(kept.history,undefined);assert.equal(fs.readFileSync(saved,'utf8'),savedBytes);
  assert.deepEqual(f.context().state.items.get(q.id).meta.review_target,target);
  assert.ok(diagnostics(f).some(r=>r.action==='review-admission-held'&&r.item==='REV-99'&&r.code==='REVIEW_ADMISSION_BINDING_UNKNOWN'));
  assert.ok(diagnostics(f).some(r=>r.action==='review-admission-held'&&r.item===q.id&&r.stage==='recovery'));
  assert.equal([...f.context().state.items.values()].filter(i=>i.role==='reviewer').length,2);
});

test('review admission rereads changed policy after capacity before launch without recording a failed or UNKNOWN attempt',t=>{
  const f=fixture(t);f.add([{type:'item.closed',id:'ENG-1',as:'done'}]);
  const key=discoverChanges(f.context()).changes[0].target.source_group.key;admissionPolicy(f,{producer_groups:[key]});
  let changed=false;const s=admissionService(f,{capacity:()=>{if(!changed){changed=true;admissionPolicy(f,{});}return{count:0,cap:4};}});s.pass();
  assert.equal(changed,true);assert.equal(s.calls.some(a=>a[0].endsWith('/dispatch/dispatch.mjs')),false);
  const effects=JSON.parse(fs.readFileSync(path.join(f.directory,'effects.json')));
  assert.equal(Object.keys(effects.actions).some(k=>k.startsWith('dispatch:')),false);
  assert.ok(effects.review_admission.held.some(h=>h.stage==='launch-mutation'));
});

function assertFiniteRefresh(f,args){
  assert.deepEqual(args.slice(0,6),[path.join(sourceRoot,'supervisor/closeout.mjs'),'refresh','--repo',f.cwd,'--org',f.org]);
  assert.equal(args.length,8);assert.equal(args[6],'--deadline');
  const deadline=Number(args[7]),now=Date.now();
  assert.ok(Number.isSafeInteger(deadline)&&deadline>now&&deadline<=now+60000,'refresh retains its finite original-binding allowance');
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

function predecessorPreparationFixture(t){
  const f=recoveryFixture(t),head=f.heads[0];sourceArtifact(f,`source: ${head}; base: ${f.base}; lane: line-eng-226-1`);
  const original=path.join(f.org,'settle/R-1.json'),copy=path.join(f.org,'evidence/retained-copies/R-1.json'),outcomes=path.join(f.org,'evidence/retained-copies/OUTCOMES.md');fs.mkdirSync(path.dirname(copy),{recursive:true});fs.renameSync(f.attempt,original);fs.writeFileSync(original,JSON.stringify({run:'R-1',item:'ENG-1',head,deliveryRange:{head,base:f.base},stage:'reviewing',review:null,qualification:'UNKNOWN',error:'canonical w3PD repository guard refused before reviewer creation'}));fs.copyFileSync(original,copy);fs.writeFileSync(outcomes,'Original review never created; full old refusal retained.\n');
  f.input.attempts=[copy];f.input.inactive.evidence=outcomes;fs.writeFileSync(f.resolution,JSON.stringify(f.input));f.add([{type:'item.updated',id:'ENG-1',fields:{meta:{review_pending:true,review_hold:{head,qualification:'UNKNOWN'}}}},{type:'item.closed',id:'ENG-1',as:'done'}]);
  const rows=f.context().events;rows.find(e=>e.type==='line-service.phase0').canonical_head=f.heads[1];fs.writeFileSync(path.join(f.org,'events.jsonl'),rows.map(e=>JSON.stringify(e)+'\n').join(''));f.git(['worktree','remove',f.workspace],f.cwd);
  let lists=0;assert.throws(()=>recoverInactiveReview({...f.args,call:(exe,args)=>{if(args[0]==='agent'&&args[1]==='list'&&++lists===2)throw Error('staged inventory boundary before completion');return f.call(exe,args);}}),/staged inventory/);
  const old=f.context().events.find(e=>e.type==='review.recovery-intent'),manifest=path.join(f.org,'evidence/review-recovery/fixture-recovery/manifest.json'),archive=fs.readFileSync(manifest),originalBytes=fs.readFileSync(original),decision=f.context().events.find(e=>e.seq===f.args.decisionSeq),newId='fixture-original-paths';
  transact(f.org,()=>({add:[{type:'note.added',id:'ENG-1',decision:true,text:`Exact inactive review correction ENG-1 R-1 head${head} base${f.base}: correct preparation fixture-recovery intent${old.seq} which listed archive copies. Preserve its unused intent/archive and decision; authorize corrected ${newId} original paths under ONE replacement total. No native launch or journal/report rewrite.`}]}),{actor:f.a.name});const decisionSeq=f.context().events.at(-1).seq,resolution=path.join(f.org,'correct-original-paths.json');fs.writeFileSync(resolution,JSON.stringify({...f.input,attempts:[original]}));
  const callback=path.join(f.org,'retirement/occupants/R-1-watcher.json');fs.mkdirSync(path.dirname(callback),{recursive:true});fs.writeFileSync(callback,JSON.stringify({kind:'watcher',run:'R-1',retained_callback:true}));
  return{...f,original,originalBytes,old,manifest,archive,decision,callback,newId,corrected:{...f.args,id:newId,resolution,decisionSeq,predecessorPreparation:'fixture-recovery'}};
}

test('predecessor preparation composes the full retained R858-shaped archive-copy correction and both authorization notes under one normal-route replacement',t=>{
  const f=predecessorPreparationFixture(t),callback=fs.readFileSync(f.callback),result=recoverInactiveReview(f.corrected),c=f.context(),q=c.state.items.get(result.review_item),completed=c.events.find(e=>e.type==='review.recovery-completed');
  assert.equal(completed.id,f.newId);assert.equal(completed.predecessor_preparation.id,f.old.id);assert.equal(completed.predecessor_preparation.intent_seq,f.old.seq);assert.equal(q.meta.review_round_cap,1);assert.equal(q.meta.review_target.head,f.heads[0]);assert.equal(validateQueuedReview({...c,item:q}).head,f.heads[0]);assert.equal(c.events.filter(e=>e.type==='review.recovery-completed').length,1);assert.equal(recoverInactiveReview(f.corrected).review_item,q.id);assert.equal([...f.context().state.items.values()].filter(i=>i.role==='reviewer').length,1);
  assert.deepEqual(fs.readFileSync(f.original),f.originalBytes);assert.deepEqual(fs.readFileSync(f.manifest),f.archive);assert.deepEqual(fs.readFileSync(f.callback),callback);assert.deepEqual(c.events.find(e=>e.seq===f.old.seq),f.old);assert.deepEqual(c.events.find(e=>e.seq===f.decision.seq),f.decision);assert.equal(c.state.items.get('ENG-1').meta.review_hold.qualification,'UNKNOWN');assert.equal(c.events.some(e=>e.type==='change.reviewed'),false);
});

test('predecessor preparation refuses changed archives callers completed or competing budgets and independent current holds without another reviewer',t=>{
  for(const kind of ['archive','caller','spent','competing','hold','original-progress']){
    const f=predecessorPreparationFixture(t);let args=f.corrected;
    if(kind==='archive'){const value=JSON.parse(fs.readFileSync(f.manifest));fs.renameSync(f.manifest,f.manifest+'.retained-original');fs.writeFileSync(f.manifest,JSON.stringify({...value,request_sha256:'0'.repeat(64)}));}
    if(kind==='caller'){const a={...f.a,terminal_id:'different-terminal',agent_session:{value:'different-session'}};args={...args,call:(_exe,x)=>JSON.stringify({result:x[0]==='agent'&&x[1]==='list'?{agents:[a]}:{agent:a}})};}
    if(kind==='spent')f.add([{type:'review.recovery-completed',id:f.old.id,item:'ENG-1',run:'R-1',target:f.old.target,project:f.identity,org:f.org}]);
    if(kind==='competing')f.add([{type:'review.recovery-intent',id:'other-preparation',predecessor_preparation:{id:f.old.id},item:'ENG-1',run:'R-1',target:f.old.target,project:f.identity}]);
    if(kind==='hold')f.add([{type:'note.added',id:'ENG-1',decision:true,text:`Independent review hold for ${f.heads[0]} remains unresolved.`}]);
    if(kind==='original-progress')fs.appendFileSync(f.original,'new native progress');
    assert.throws(()=>recoverInactiveReview(args),/predecessor|archive|manifest|caller|budget|UNKNOWN|hold|source|review|recovery|native|session|terminal/i,kind);assert.equal([...f.context().state.items.values()].some(i=>i.role==='reviewer'),false,kind);assert.deepEqual(fs.readFileSync(f.callback),Buffer.from(JSON.stringify({kind:'watcher',run:'R-1',retained_callback:true})),kind);
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
  const f=configFixture(t,{custom:true}),org=f.env.ORG_DIR,identity=gitProject(f.cwd).identity,base=f.git('rev-parse','HEAD'),count=2035;
  // Each historical producer owns a real, distinct source delta. Batch creation
  // keeps fixture setup cheap without fabricating hashes or derived run state.
  const imports=[];
  for(let n=1;n<=count;n++){
    const message=`Historical producer ${n}\n`,content=`${n}\n`;
    imports.push(`commit refs/heads/main\nmark :${n}\ncommitter Fixture <fixture@example.invalid> 1793055600 +0000\ndata ${Buffer.byteLength(message)}\n${message}from ${n===1?base:`:${n-1}`}\nM 100644 inline settled-history\ndata ${Buffer.byteLength(content)}\n${content}\n`);
  }
  const imported=spawnSync('git',['-C',f.cwd,'fast-import','--quiet'],{env:f.env,input:imports.join(''),encoding:'utf8'});
  assert.equal(imported.status,0,imported.stderr);f.git('reset','--hard','main');
  const heads=f.git('rev-list','--reverse',`${base}..main`).split('\n');assert.equal(heads.length,count);
  fs.mkdirSync(path.join(org,'dispatch'),{recursive:true});
  const owner={controller:'brain',legacy:false,release:{id:'source',root:sourceRoot,commit:null,identity:gitProject(sourceRoot).identity}};
  const producer=(n,head,previous)=>{
    const run=`R-${n}`,item=`ENG-${n}`,token=`history-${n}`,dispatch=path.join(org,`dispatch/${token}.json`),file=`reports/${run}.md`;
    fs.writeFileSync(dispatch,JSON.stringify({token,stage:'complete',run,item,org,common:identity,workspace:f.cwd,base:previous}));
    const bytes=`---\nrun: ${run}\noutcome: done\nsummary: Producer ${n} source.\nheadline: Historical source is retained\nartifacts:\n  - "source: ${head}; base: ${previous}"\n---\n`,parsed=readReport(bytes);
    assert.deepEqual(parsed.errors,[]);fs.writeFileSync(path.join(org,file),bytes);
    return [{type:'item.added',id:item,title:`Producer ${n}`,role:'engineer'},
      {type:'run.started',id:run,item,workspace:f.cwd,meta:{dispatch_record:org,dispatch_project:identity,dispatch_journal:dispatch,dispatch_attempt:token}},
      {type:'run.claimed',run,record:org,project:identity,owner},
      {type:'report.ingested',run,item,file,sha256:hash(bytes),report:parsed.report},
      {type:'item.closed',id:item,as:'done',completed_run:run}];
  };
  transact(org,()=>({add:[...heads.flatMap((head,i)=>producer(i+1,head,i?heads[i-1]:base)),
    {type:'line-service.phase0',id:'after-history',project:identity,repo:f.cwd,org,source:sourceRoot,main:'main',canonical_head:heads.at(-1)}]}));
  const context=()=>{const events=loadEvents(org).events;return{events,state:fold(events),repo:f.cwd,org,identity};};
  const c=context(),boundary=phase0Boundary(c.events,c);
  assert.equal(c.state.runs.size,count);
  for(const run of c.state.runs.values()){
    assert.ok(run.started.seq<run.owner_generation&&run.owner_generation<run.report.seq&&run.report.seq<boundary.seq);
    const dispatch=JSON.parse(fs.readFileSync(run.meta.dispatch_journal,'utf8')),bytes=fs.readFileSync(path.join(org,run.report.file));
    assert.equal(dispatch.run,run.id);assert.equal(dispatch.item,run.item);assert.equal(dispatch.workspace,run.workspace);
    assert.equal(hash(bytes),run.report.sha256);assert.equal(readReport(bytes).report.run,run.id);
    assert.deepEqual(run.report.artifacts,[`source: ${heads[Number(run.id.slice(2))-1]}; base: ${dispatch.base}`]);
  }
  const reads=[],readGit=(_repo,args)=>{reads.push(args);return f.git(...args);};
  const found=discoverChanges({...c,readGit});
  assert.equal(found.changes.length,0);assert.equal(found.holds.length,0);assert.equal(found.unattributed.length,0);
  assert.deepEqual(reads,[['rev-parse','refs/heads/main'],['rev-list','--parents',`${heads.at(-1)}..${heads.at(-1)}`]]);
  // The same old source cited by a genuinely new report stays UNKNOWN: history
  // does not supply a guarded delivery receipt to a later producer.
  transact(org,()=>({add:producer(count+1,heads.at(-1),heads.at(-2))}));
  const diagnostic=discoverChanges({...context(),readGit});
  assert.equal(diagnostic.changes.length,0);assert.equal(diagnostic.holds.length,1);
  assert.equal(diagnostic.holds[0].run,`R-${count+1}`);assert.equal(diagnostic.holds[0].source_provenance.status,'unknown');
  assert.match(diagnostic.holds[0].source_provenance.ranges[0].reason,/lacks guarded or proven legacy dispatch\/run\/claim evidence/);
  assert.equal(reads.length,4,'each scan retains exactly two batched index reads');
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

for(const role of ['engineer','architect','researcher','reviewer'])test(`phase1 post-FF producer facts bind ${role} source ownership and keep the real landing time once`,t=>{
  const f=fixture(t,{role}),actor=structuredClone(f.observation.agents[0]);actor.cwd=f.workspace;
  f.add([{type:'run.updated',id:'R-1',meta:{agent:actor.name,pane:actor.pane_id,worker_workspace:actor.workspace_id,terminal_id:actor.terminal_id,agent_session_id:actor.agent_session.value}}]);
  const env={...f.env,HERDR_ENV:'1',HERDR_PANE_ID:actor.pane_id,HERDR_WORKSPACE_ID:actor.workspace_id,CODEX_THREAD_ID:actor.agent_session.value};
  const args={canonical:f.cwd,workspace:f.workspace,base:f.base,head:f.heads[1],landedAt:'2026-10-27T01:30:00Z',env,call:()=>JSON.stringify({result:{agent:actor}})};
  assert.throws(()=>recordOwnLanding({...args,call:()=>JSON.stringify({result:{agent:{...actor,terminal_id:'foreign-terminal'}}})}),/ownership is missing\/ambiguous/);
  assert.equal(f.context().events.some(e=>e.type==='change.landed'),false);
  assert.equal(recordOwnLanding(args).changes.length,2);assert.equal(recordOwnLanding(args).changes.length,0);
  const landed=f.context().events.filter(e=>e.type==='change.landed');
  assert.deepEqual(landed.map(e=>({item:e.item,run:e.run,base:e.base,head:e.head,landing_tip:e.landing_tip,previous_main:e.previous_main,landed_at:e.landed_at,producer:e.producer})),f.heads.map((head,i)=>({
    item:'ENG-1',run:'R-1',base:i?f.heads[i-1]:f.base,head,landing_tip:f.heads[1],previous_main:f.base,landed_at:args.landedAt,
    producer:{agent:actor.name,pane:actor.pane_id,terminal:actor.terminal_id,session:actor.agent_session.value,ownership_generation:f.context().run.owner_generation}
  })));
  assert.throws(()=>recordOwnLanding({...args,head:f.base}),/CAS/);
});

test('phase1 post-FF landing attributes a same-session continuation to its one open run, never its reported predecessor',t=>{
  const f=fixture(t),actor=structuredClone(f.observation.agents[0]);actor.cwd=f.workspace;
  const meta={agent:actor.name,pane:actor.pane_id,worker_workspace:actor.workspace_id,terminal_id:actor.terminal_id,agent_session_id:actor.agent_session.value};
  const {type,record,project,owner}=f.context().events.find(e=>e.type==='run.claimed'),claim=run=>({type,run,record,project,owner});
  f.add([{type:'run.updated',id:'R-1',meta},{type:'item.added',id:'ARCH-2',title:'Continuation',role:'architect'},
    {type:'run.started',id:'R-2',item:'ARCH-2',workspace:f.workspace,meta:{lane:'source',dispatch_record:f.org,dispatch_project:f.identity,dispatch_attempt:'continuation',dispatch_journal:path.join(f.org,'dispatch/continuation.json'),...meta}},claim('R-2'),
    {type:'item.added',id:'REV-3',title:'Second open owner',role:'reviewer'},{type:'run.started',id:'R-3',item:'REV-3',workspace:f.workspace,meta:{lane:'source',dispatch_record:f.org,dispatch_project:f.identity,dispatch_attempt:'continuation',dispatch_journal:path.join(f.org,'dispatch/continuation.json'),...meta}},claim('R-3')]);
  const env={...f.env,HERDR_ENV:'1',HERDR_PANE_ID:actor.pane_id,HERDR_WORKSPACE_ID:actor.workspace_id,CODEX_THREAD_ID:actor.agent_session.value};
  const args={canonical:f.cwd,workspace:f.workspace,base:f.base,head:f.heads[1],landedAt:'2026-10-27T01:30:00Z',env,call:()=>JSON.stringify({result:{agent:actor}})};
  assert.throws(()=>recordOwnLanding(args),/ambiguous/,'two open runs on one native tuple stay ambiguous');
  assert.equal(f.context().events.some(e=>e.type==='change.landed'),false);
  f.add([{type:'run.abandoned',id:'R-3',note:'not the landing owner'}]);
  const landed=recordOwnLanding(args).changes;assert.equal(landed.length,2);assert.ok(landed.every(c=>c.run==='R-2'&&c.item==='ARCH-2'),JSON.stringify(landed));
  assert.equal(f.context().events.filter(e=>e.type==='change.landed').every(e=>e.run==='R-2'&&e.landed_at===args.landedAt),true,'the reported predecessor is never bound and no time is invented');
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

test('phase1 explicit current-source manual review references require readable typed same-change evidence',t=>{
  const f=fixture(t),c=f.context(),target=discoverChanges(c).changes[0].target;
  const file=path.join(f.scratch,'source-review.json'),unrelated=path.join(f.scratch,'another-owner');
  fs.mkdirSync(unrelated);fs.writeFileSync(path.join(unrelated,'review.json'),'{"kind":"review","qualification":"UNKNOWN"}');
  c.run.report.artifacts.push(file);
  let probes=0;const stat=fs.lstatSync;fs.lstatSync=(file,...args)=>{if(String(file).startsWith(unrelated+path.sep))probes++;return stat(file,...args);};
  const attempt=()=>reviewAttempt(c.item,{...c,target});
  try{
    assert.equal(attempt(),null,'a missing locator is not an attempt');
    for(const bytes of ['opaque','{}',JSON.stringify({run:'R-1',head:target.head,description:'review mentioned'})]){fs.writeFileSync(file,bytes);assert.equal(attempt(),null);}
    fs.writeFileSync(file,JSON.stringify({run:'R-1',head:target.head,native_launch_attempted:true,qualification:'UNKNOWN'}));
    const saved=fs.readFileSync(file);assert.match(attempt(),/source-owner typed review reference UNKNOWN/);assert.deepEqual(fs.readFileSync(file),saved);
    for(const value of [{run:'R-other',head:f.base},{run:'R-1',head:f.base}]){fs.writeFileSync(file,JSON.stringify({...value,native_launch_attempted:true,qualification:'UNKNOWN'}));assert.equal(attempt(),null,'typed evidence retains only its captured change');}
  }finally{fs.lstatSync=stat;}
  assert.equal(probes,0,'unreferenced owner folders are never inventoried');
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

for(const role of ['architect','researcher','reviewer'])for(const reported of [false,true])test(`phase1 post-FF ${role} non-engineer review covers own landings ${reported?'after':'before'} report once`,t=>{
  const f=fixture(t,{role,reported});
  assert.equal(discoverChanges(f.context()).changes.length,0,'report references alone never establish non-engineer production');
  unreportedNativeLandings(f);
  const found=discoverChanges(f.context());assert.deepEqual(found.holds,[]);assert.deepEqual(found.unattributed,[]);assert.equal(found.changes.length,1);
  const {target}=found.changes[0];assert.equal(target.evidence_kind,'native-landings/v1');assert.deepEqual(target.source_group.owned_commits,f.heads);assert.equal(target.base,f.base);assert.equal(target.head,f.heads[1]);
  const before=process.cwd(),env={...installedService(f),ORG_ACTOR:'line-service'};process.chdir(f.cwd);
  try{
    const result=queueReviewMutation({...f.context(),runId:'R-1',head:target.head,base:target.base,env});f.add(result.add);
    const c=f.context(),q=c.state.items.get(result.result.review_item);
    assert.equal(q.meta.review_round_cap,1);assert.deepEqual(validateQueuedReview({...c,item:q}),q.meta.review_target);
    assert.equal([...c.state.items.values()].filter(i=>i.meta.review_source_run==='R-1').length,1);
    assert.equal(queueReviewMutation({...c,runId:'R-1',env}).add.length,0);assert.equal(discoverChanges({...c,pendingOnly:true}).changes.length,0);
    const health=reviewHealth({...c,index:canonicalReviewIndex(c)});assert.equal(health.owed,1);assert.equal(health.queued,1);assert.equal(health.queued_commits,2);assert.equal(health.missing_queue,0);assert.deepEqual(health.coverage_gaps,[]);assert.deepEqual(health.attribution_gaps,[]);
  }finally{process.chdir(before);}
});

for(const link of ['parent','review_fix_of'])test(`phase1 post-FF non-engineer review preserves ${link} formal-correction exemption`,t=>{
  const f=fixture(t,{role:'architect',reported:false});
  f.add([{type:'item.added',id:'REV-99',title:'Original review',role:'reviewer'},
    {type:'item.updated',id:'ENG-1',fields:link==='parent'?{parent:'REV-99'}:{meta:{review_fix_of:'original:key'}}}]);
  unreportedNativeLandings(f);
  const c=f.context(),found=discoverChanges(c),health=reviewHealth({...c,index:canonicalReviewIndex(c)});
  assert.deepEqual(found.changes,[]);assert.deepEqual(found.unattributed,[]);assert.deepEqual(found.holds,[]);assert.equal(health.exemptions.length,2);assert.equal(health.owed,0);assert.equal(health.missing_queue,0);assert.deepEqual(health.coverage_gaps,[]);
  const before=process.cwd(),env={...installedService(f),ORG_ACTOR:'line-service'};process.chdir(f.cwd);
  try{assert.throws(()=>queueReviewMutation({...c,runId:'R-1',env}),/linked formal correction/);}finally{process.chdir(before);}
});

function unreportedNativeLandings(f){
  const actor=structuredClone(f.observation.agents[0]);actor.cwd=f.workspace;
  f.add([{type:'run.updated',id:'R-1',meta:{agent:actor.name,pane:actor.pane_id,worker_workspace:actor.workspace_id,terminal_id:actor.terminal_id,agent_session_id:actor.agent_session.value}}]);
  const env={...f.env,HERDR_ENV:'1',HERDR_PANE_ID:actor.pane_id,HERDR_WORKSPACE_ID:actor.workspace_id,CODEX_THREAD_ID:actor.agent_session.value};
  recordOwnLanding({canonical:f.cwd,workspace:f.workspace,base:f.base,head:f.heads[1],landedAt:'2026-10-27T07:00:00.000Z',env,call:()=>JSON.stringify({result:{agent:actor}})});
  return actor;
}

test('landing-before-report queues one immutable whole native producer group and validates normal review admission without inventing a producer report',t=>{
  const f=fixture(t,{reported:false});unreportedNativeLandings(f);const c=f.context(),change=discoverChanges(c).changes[0];assert.ok(change);assert.equal(change.target.evidence_kind,'native-landings/v1');assert.deepEqual(change.target.source_group.owned_commits,f.heads);assert.equal(change.target.base,f.base);assert.equal(c.run.report,null);
  const before=process.cwd(),env=installedService(f);process.chdir(f.cwd);
  try{const result=queueReviewMutation({...c,runId:'R-1',head:change.target.head,base:change.target.base,env:{...env,ORG_ACTOR:'line-service'}});f.add(result.add);const fresh=f.context(),q=fresh.state.items.get(result.result.review_item);assert.equal(q.meta.review_round_cap,1);assert.deepEqual(validateQueuedReview({...fresh,item:q}),q.meta.review_target);assert.equal(fresh.run.report,null);assert.equal(fresh.item.closed,null);assert.equal(queueReviewMutation({...fresh,runId:'R-1',env:{...env,ORG_ACTOR:'line-service'}}).add.length,0);
    const bytes=fs.readFileSync(q.meta.review_target.evidence);assert.equal(hash(bytes),q.meta.review_target.reportHash);const proof=JSON.parse(bytes);assert.equal(proof.schema,'native-landings/v1');assert.equal(proof.producer_report,null);assert.equal(proof.validation,'No test or final-release PASS inferred from landing.');assert.equal(proof.landings.length,2);
    const health=reviewHealth({...fresh,index:canonicalReviewIndex(fresh)});assert.equal(health.owed,1);assert.equal(health.queued,1);assert.equal(health.queued_commits,2);assert.equal(health.missing_queue,0);assert.equal(health.attribution_gaps.length,0);
    fs.writeFileSync(path.join(path.dirname(q.meta.review_target.evidence),'review-other-unknown.json'),JSON.stringify({item:'ENG-1',run:'R-1',head:f.heads[1],qualification:'UNKNOWN'}));assert.throws(()=>validateQueuedReview({...fresh,item:q}),/UNKNOWN|attempt/,'only the exact validated producer evidence is exempt');
  }finally{process.chdir(before);}
});

test('landing-before-report keeps a captured native group immutable and queues only its strictly later uncovered supplemental source',t=>{
  const f=fixture(t,{reported:false});unreportedNativeLandings(f);const before=process.cwd(),env={...installedService(f),ORG_ACTOR:'line-service'};process.chdir(f.cwd);
  try{const result=queueReviewMutation({...f.context(),runId:'R-1',env});f.add(result.add);const original=structuredClone(f.context().state.items.get(result.result.review_item).meta.review_target),bytes=fs.readFileSync(original.evidence);
    fs.writeFileSync(path.join(f.workspace,'later-fix'),'later committed source');f.git(['add','.']);f.git(['commit','-qm','Later source']);const later=f.git(['rev-parse','HEAD']);f.git(['merge','--ff-only',later],f.cwd);
    f.add([{type:'change.landed',item:'ENG-1',run:'R-1',head:later,base:f.heads[1],project:f.identity,landed_at:'2026-10-27T07:01:00.000Z'}, {type:'report.ingested',run:'R-1',file:'reports/R-1.md',sha256:hash(f.report),report:{outcome:'done',artifacts:[...[...f.heads,later].map(h=>`Commit: ${h}`),original.evidence],blockers:[],extra:{},proposals:[]}}]);
    const fresh=f.context(),q=fresh.state.items.get(result.result.review_item);assert.deepEqual(validateQueuedReview({...fresh,item:q}),original);assert.deepEqual(fs.readFileSync(original.evidence),bytes);const extra=discoverChanges({...fresh,pendingOnly:true}).changes;assert.equal(extra.length,1);assert.deepEqual(capturedReviewCommits(extra[0].target),[later]);assert.equal(extra[0].target.base,original.head);assert.equal(extra[0].target.evidence_kind,'supplemental-review/v1');
    const queued=queueReviewMutation({...fresh,runId:'R-1',head:later,env});f.add(queued.add);const next=f.context(),supplement=next.state.items.get(queued.result.review_item);assert.deepEqual(validateQueuedReview({...next,item:supplement}),supplement.meta.review_target);assert.deepEqual(validateQueuedReview({...next,item:next.state.items.get(q.id)}),original);assert.equal(queueReviewMutation({...next,runId:'R-1',env}).add.length,0);assert.equal(discoverChanges({...next,pendingOnly:true}).changes.length,0);
    const health=reviewHealth({...next,index:canonicalReviewIndex(next)});assert.equal(health.queued_commits,3);assert.equal(health.coverage_gaps.length,0);assert.equal(health.ambiguous_groups,0);assert.equal([...next.state.items.values()].filter(i=>i.role==='reviewer').length,2);assert.deepEqual(fs.readFileSync(original.evidence),bytes);
    fs.appendFileSync(original.evidence,'altered');assert.throws(()=>validateQueuedReview({...fresh,item:q}),/changed|evidence/);
  }finally{process.chdir(before);}
});

test('landing-before-report actual source queue command is reached by the installed model-free pass while independent native capacity remains authoritative',t=>{
  const f=fixture(t,{reported:false});unreportedNativeLandings(f);f.add([{type:'run.updated',id:'R-1',meta:{harness:'codex'}}]);const env=installedService(f),calls=[],before=process.cwd();let capacityCalls=0;process.chdir(f.cwd);
  try{createLineService({repo:f.cwd,org:f.org,to:'brain-chat',env,maxStarts:1,capacity:()=>{capacityCalls++;throw Object.assign(Error('review pool is occupied'),{code:'DISPATCH_REVIEW_CAP'});},command:(exe,args,options)=>{calls.push(args);if(args[1]==='queue-review')return spawnSync(exe,args,options);assert.equal(args[0].endsWith('dispatch.mjs'),false,'capacity prevents a native launch');return{status:0,stdout:'{}',stderr:''};}}).pass();}
  finally{process.chdir(before);}
  assert.equal(calls.filter(a=>a[1]==='queue-review').length,1);assert.equal(capacityCalls,1,JSON.stringify(diagnostics(f)));const c=f.context(),q=[...c.state.items.values()].filter(i=>i.role==='reviewer');assert.equal(q.length,1);assert.equal(q[0].meta.review_target.evidence_kind,'native-landings/v1');assert.equal(c.run.report,null);assert.equal(c.events.some(e=>e.type==='run.started'&&e.item===q[0].id),false);assert.equal(diagnosticHealth(f).queued,1);
});

test('landing-before-report retains an original UNKNOWN attempt and refuses admission-only foreign or unqualified ownership as positive source evidence',t=>{
  for(const kind of ['unknown','admission','foreign','unqualified']){
    const f=fixture(t,{reported:false});
    if(kind==='unknown'){unreportedNativeLandings(f);fs.mkdirSync(path.join(f.org,'settle'),{recursive:true});fs.writeFileSync(path.join(f.org,'settle/R-1.json'),JSON.stringify({run:'R-1',item:'ENG-1',head:f.heads[1],qualification:'UNKNOWN'}));}
    else f.add([{type:'change.landed',item:'ENG-1',run:'R-1',head:kind==='admission'?f.base:f.heads[1],base:f.base,project:kind==='foreign'?'/foreign/.git':f.identity,landed_at:'2026-10-27T07:00:00.000Z'}]);
    const before=process.cwd();process.chdir(f.cwd);try{assert.throws(()=>queueReviewMutation({...f.context(),runId:'R-1',env:{...f.env,ORG_ACTOR:'line-service',HERDR_ENV:'',HERDR_PANE_ID:''}}),/UNKNOWN|source|ownership|landed|target/);assert.equal([...f.context().state.items.values()].some(i=>i.role==='reviewer'),false);}finally{process.chdir(before);}
  }
});

test('actual native producer receipt shapes distinguish red or unrun validation proofs and foreign record witnesses from this producers review attempts',t=>{
  const f=fixture(t,{reported:false});unreportedNativeLandings(f);const directory=path.join(f.org,'evidence/ENG-1/R-1');fs.mkdirSync(directory,{recursive:true});
  const write=(name,v)=>{const file=path.join(directory,name);fs.writeFileSync(file,JSON.stringify(v,null,2)+'\n');return file;};
  const gate1=write('gate-34.json',{schema:'lane-validation/v1',key:'1'.repeat(64),head:f.heads[0],branch:'lane/source',node_version:'v20.19.4',executed:true,exit_code:1}),gate2=write('gate-35.json',{schema:'lane-validation/v1',key:'2'.repeat(64),head:f.heads[1],branch:'lane/source',node_version:'v20.19.4',executed:false,exit_code:null});
  const proof=write('automatic-review-progress-proof.json',{run:'R-1',head:f.heads[0],base:f.base,gate:gate1,landing:path.join(directory,'landing-34.json'),focused:{pass:0,fail:1,unselected:9}});
  write('review-capacity-proof.json',{run:'R-1',source:f.heads,checks:[{file:gate1},{file:gate2}],native_effects:'Offline fixture controls only; no live review attempt.'});
  write('actual-native-review-attempt-diagnosis.json',{run:'R-1',scope:'read-only actual exact source attempt detector; no queue/native/test/effect',target:{head:f.heads[1],base:f.base,evidence_kind:'native-landings/v1'},reason:'same-change source-owner review receipt/UNKNOWN',scoped_evidence_reads:[proof]});
  const foreign=independentProducer(f);f.add([{type:'item.added',id:'REV-40',role:'reviewer',title:'Other source review',meta:{review_source_item:'ENG-2',review_source_run:'R-3'}},{type:'run.started',id:'R-40',item:'REV-40',workspace:f.cwd},{type:'change.reviewed',item:'ENG-2',head:foreign,review_item:'REV-40',review_run:'R-40',verdict:'PASS'},{type:'item.closed',id:'REV-40',as:'done'},{type:'closeout.effect',identity:f.identity,run:'R-40',item:'REV-40',outcome:{action:'exit-observed'}}]);
  const rows=f.context().events,verdict=rows.find(e=>e.type==='change.reviewed'&&e.review_run==='R-40'),closed=rows.find(e=>e.type==='item.closed'&&e.id==='REV-40'),effect=rows.find(e=>e.type==='closeout.effect'&&e.run==='R-40');
  write('autonomous-review-other-native-receipt.json',{run:'R-1',target:{run:'R-40',item:'REV-40',review:{seq:verdict.seq,item:'ENG-2',head:foreign}},source_binding:closed,native_effects:[effect]});
  const before=process.cwd(),env={...installedService(f),ORG_ACTOR:'line-service'};process.chdir(f.cwd);
  try{const result=queueReviewMutation({...f.context(),runId:'R-1',env});f.add(result.add);const c=f.context(),q=c.state.items.get(result.result.review_item);assert.deepEqual(validateQueuedReview({...c,item:q}),q.meta.review_target);assert.equal(c.run.report,null);assert.equal(c.events.find(e=>e.seq===verdict.seq).verdict,'PASS');
    const unknown=write('manual-review-unknown.json',{run:'R-1',head:f.heads[1],gate:gate2,checks:[{file:gate2}],qualification:'UNKNOWN',native_launch_attempted:true});assert.throws(()=>validateQueuedReview({...c,item:q}),/UNKNOWN|attempt/,'a real/unknown attempt cannot borrow a producer gate as absence proof');fs.unlinkSync(unknown);
    fs.writeFileSync(gate1,JSON.stringify({schema:'lane-validation/v1',head:foreign,branch:'lane/source',executed:true}));const changed=fs.readFileSync(gate1);
    assert.deepEqual(validateQueuedReview({...c,item:q}),q.meta.review_target,'a rejected untyped producer proof does not become a native attempt');assert.deepEqual(fs.readFileSync(gate1),changed);
  }finally{process.chdir(before);}
});

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

test('supplemental coverage keeps pending and verdict scopes immutable and excludes interleaved independent source',t=>{
  const f=fixture(t);partialReview(f,'REV-1203',{head:f.heads[1],base:f.heads[0],run:'R-3403',verdict:'PASS'});partialReview(f,'REV-1204',{head:f.heads[0],base:f.base,run:'R-3404'});
  // Corrections inherit producer references, but are not prior review captures.
  f.add([{type:'item.added',id:'ENG-9001',role:'engineer',title:'Owned correction',parent:'REV-1203',from_run:'R-3403',meta:{review_fix_of:`ENG-1:${f.heads[1]}`,review_source_item:'ENG-1',review_source_run:'R-1',queue_selected:true}}]);
  const correction=structuredClone(f.context().state.items.get('ENG-9001'));
  const original=[...f.context().state.items.values()].filter(q=>q.role==='reviewer').map(q=>structuredClone(q)),foreign=independentProducer(f);
  f.git(['merge','--ff-only',foreign]);const later=[];
  for(const n of [3,4]){fs.writeFileSync(path.join(f.workspace,`later-${n}`),String(n));f.git(['add','.']);f.git(['commit','-qm',`Later ${n}`]);later.push(f.git(['rev-parse','HEAD']));}
  f.git(['merge','--ff-only',later[1]],f.cwd);f.add(later.map((head,n)=>({type:'change.landed',item:'ENG-1',run:'R-1',head,base:n?later[0]:foreign,project:f.identity})));
  const before=process.cwd(),env={...installedService(f),ORG_ACTOR:'line-service'};process.chdir(f.cwd);
  try{
    const changes=discoverChanges({...f.context(),pendingOnly:true}).changes.filter(c=>c.run.id==='R-1');assert.equal(changes.length,1);assert.deepEqual(capturedReviewCommits(changes[0].target),later);assert.equal(changes[0].target.base,foreign);
    const r=queueReviewMutation({...f.context(),runId:'R-1',head:later[1],env});f.add(r.add);const c=f.context(),q=c.state.items.get(r.result.review_item);assert.deepEqual(validateQueuedReview({...c,item:q}),q.meta.review_target);
    for(const old of original)assert.deepEqual(c.state.items.get(old.id),old);assert.deepEqual(c.state.items.get('ENG-9001'),correction);assert.equal(c.events.filter(e=>e.type==='change.reviewed').length,1);assert.equal(queueReviewMutation({...c,runId:'R-1',head:later[1],env}).add.length,0);
    const health=reviewHealth({...c,index:canonicalReviewIndex(c)});assert.equal(health.done_commits,1);assert.ok(!health.coverage_gaps.some(g=>later.includes(g.head)));assert.ok(health.coverage_gaps.some(g=>g.head===foreign));
    fs.mkdirSync(path.join(f.org,'settle'),{recursive:true});fs.writeFileSync(path.join(f.org,'settle/unknown.json'),JSON.stringify({run:'R-1',head:later[1],qualification:'UNKNOWN'}));assert.throws(()=>validateQueuedReview({...c,item:q}),/UNKNOWN|attempt/);
  }finally{process.chdir(before);}
});

test('supplemental coverage refuses UNKNOWN or overlapping prior captures instead of duplicating uncovered source',t=>{
  for(const kind of ['unknown','overlap']){
    const f=fixture(t);partialReview(f,'REV-1200',{head:f.heads[0],base:f.base,run:'R-3400'});
    if(kind==='overlap')partialReview(f,'REV-1201',{head:f.heads[0],base:f.base,run:'R-3401'});
    else f.add([{type:'item.updated',id:'REV-1200',fields:{meta:{review_target:{head:f.heads[0],qualification:'UNKNOWN'}}}}]);
    const c=f.context(),found=discoverChanges({...c,pendingOnly:true});assert.equal(found.changes.length,0);assert.match(found.holds[0].reason,/UNKNOWN|overlapping/);
    const before=process.cwd();process.chdir(f.cwd);try{assert.throws(()=>queueReviewMutation({...c,runId:'R-1',env:{...f.env,ORG_ACTOR:'line-service',HERDR_ENV:'',HERDR_PANE_ID:''}}),/UNKNOWN|retained|scope/);}finally{process.chdir(before);}
  }
});

test('canonical unattributed queue assigns current real reviewer responsibility without historical producer IDs and retains cap1 Major correction semantics',t=>{
  const f=fixture(t,{reported:false}),env={...installedService(f),ORG_ACTOR:'line-service'},before=process.cwd();process.chdir(f.cwd);
  try{
    const c=f.context(),selector=canonicalSelector(f.heads[0]),original=structuredClone(c.events);assert.equal(discoverChanges({...c,pendingOnly:true}).unattributed.length,2);
    const result=queueReviewMutation({...c,runId:selector,env});f.add(result.add);const next=f.context(),q=next.state.items.get(result.result.review_item),target=q.meta.review_target;
    assert.deepEqual(validateQueuedReview({...next,item:q}),target);assert.equal(q.meta.review_source_item,q.id);assert.equal(q.meta.review_source_run,null);assert.equal(q.meta.review_round_cap,1);assert.equal(result.add.some(e=>e.type==='change.landed'||e.type==='run.started'),false);
    assert.deepEqual(target.landed_evidence.historical_producer,{item:null,run:null,owner:null,attribution:'missing'});assert.deepEqual(capturedReviewCommits(target),[f.heads[0]]);assert.equal(target.base,f.base);assert.equal(target.head,f.heads[0]);assert.equal(hash(fs.readFileSync(target.evidence)),target.reportHash);
    assert.match(q.accept[0],/^Why:[\s\S]*Baseline: Captured source/);
    const index=canonicalReviewIndex(next);assert.equal(index.entries.find(e=>e.head===target.head).run,null);assert.equal(index.entries.find(e=>e.head===target.head).item,null);assert.equal(reviewHealth({...next,index}).queued_commits,1);assert.equal(queueReviewMutation({...next,runId:selector,env}).add.length,0);
    assert.equal(discoverChanges({...next,pendingOnly:true}).unattributed.length,1);assert.deepEqual(next.events.slice(0,original.length),original);
    f.add([{type:'run.started',id:'R-50',item:q.id,workspace:f.cwd}]);const started=f.context(),report={outcome:'done',extra:{verdict:'FAIL'},proposals:[]},events=reviewResultEvents({...started,run:started.state.runs.get('R-50'),report,sha256:'d'.repeat(64),body:'- [Major] source-1:1 - Fix this landed change.'});f.add(events);
    const final=f.context(),health=reviewHealth({...final,index:canonicalReviewIndex(final)});assert.equal(health.done_commits,1);assert.equal(events[0].item,q.id);assert.equal(events[1].parent,q.id);assert.equal(events[1].meta.severity,'major');assert.equal(events[1].meta.review_owner_run,null);assert.equal(final.state.runs.has('canonical:'+target.head),false);
    // The frozen fold predates session-bound run ownership; compare the projection it supports.
    const old=historicalFold(final.events);
    assert.deepEqual(old.items,new Map([...final.state.items].map(([id,item])=>[id,Object.fromEntries(Object.entries(item).filter(([key])=>key!=='finding_bindings'))])));
    assert.ok(final.state.items.get(events[1].id).finding_bindings.length,'the current fold retains the newer typed correction binding');assert.deepEqual([...old.runs.keys()],[...final.state.runs.keys()]);
    for(const [id,run] of old.runs){const current=final.state.runs.get(id);assert.deepEqual(Object.keys(current).filter(k=>!Object.hasOwn(run,k)).filter(k=>!['owner','owner_generation'].includes(k)),[]);assert.deepEqual(run,Object.fromEntries(Object.keys(run).map(k=>[k,current[k]])));}for(const e of final.events){if(e.type==='run.started')assert.ok(final.state.items.has(e.item));if(e.type==='change.reviewed')assert.ok(final.state.items.has(e.item)&&final.state.items.has(e.review_item)&&final.state.runs.has(e.review_run));}
    assert.throws(()=>validateQueuedReview({...final,item:final.state.items.get(q.id)}),/already has a run/);assert.equal(queueReviewMutation({...final,runId:selector,env}).add.length,0);
  }finally{process.chdir(before);}
});

test('canonical unattributed targets retain exact-head UNKNOWN attempts, ownership ambiguity, native context and STOP fences',t=>{
  const f=fixture(t,{reported:false}),env={...installedService(f),ORG_ACTOR:'line-service'},before=process.cwd();process.chdir(f.cwd);
  try{
    const selector=canonicalSelector(f.heads[0]);fs.mkdirSync(path.join(f.org,'settle'),{recursive:true});const unknown=path.join(f.org,'settle/unknown.json');fs.writeFileSync(unknown,JSON.stringify({head:f.heads[0],qualification:'UNKNOWN'}));
    const context=f.context(),target=discoverChanges(context).unattributed.find(c=>c.selector===selector).target;
    assert.equal(reviewAttempt({id:selector,runs:[]},{...context,target}),null,'head/qualification alone does not establish a native attempt');
    fs.writeFileSync(unknown,JSON.stringify({kind:'review',head:f.heads[0],qualification:'UNKNOWN'}));const bytes=fs.readFileSync(unknown);
    assert.throws(()=>queueReviewMutation({...f.context(),runId:selector,env}),/UNKNOWN|attempt/);assert.equal([...f.context().state.items.values()].filter(q=>q.role==='reviewer').length,0);assert.deepEqual(fs.readFileSync(unknown),bytes);fs.unlinkSync(unknown);
    assert.throws(()=>queueReviewMutation({...f.context(),runId:selector,env:{...env,HERDR_ENV:'1'}}),/genuine canonical/);
    fs.writeFileSync(path.join(f.directory,'STOP'),'hold');assert.throws(()=>queueReviewMutation({...f.context(),runId:selector,env}),/STOP/);fs.unlinkSync(path.join(f.directory,'STOP'));
    const result=queueReviewMutation({...f.context(),runId:selector,env});f.add(result.add);const c=f.context(),q=c.state.items.get(result.result.review_item);f.add([{type:'item.added',id:'REV-999',role:'reviewer',title:'UNKNOWN duplicate',meta:{review_source_selector:selector,review_source_item:'REV-999',review_target:{head:f.heads[0],qualification:'UNKNOWN'}}}]);
    assert.throws(()=>validateQueuedReview({...f.context(),item:q}),/overlapping|UNKNOWN/);assert.throws(()=>queueReviewMutation({...f.context(),runId:selector,env}),/UNKNOWN/);
  }finally{process.chdir(before);}
  const g=fixture(t,{reported:false});g.add([{type:'item.added',id:'ENG-2',role:'engineer',title:'Other producer'},{type:'run.started',id:'R-2',item:'ENG-2',workspace:g.cwd},...['R-1','R-2'].map((run,n)=>({type:'change.landed',item:`ENG-${n+1}`,run,head:g.heads[0],base:g.base,project:g.identity}))]);assert.ok(!discoverChanges(g.context()).unattributed.some(c=>c.target.head===g.heads[0]));
});

test('canonical unattributed discovery uses the installed ordinary queue and review pool without a producer run or parallel transport',t=>{
  const f=fixture(t,{reported:false}),env=installedService(f),calls=[],before=process.cwd();process.chdir(f.cwd);
  try{createLineService({repo:f.cwd,org:f.org,to:'brain-chat',env,maxStarts:1,capacity:()=>{throw Object.assign(Error('review pool is occupied'),{code:'DISPATCH_REVIEW_CAP'});},command:(exe,args,options)=>{calls.push(args);if(args[1]==='queue-review')return spawnSync(exe,args,options);assert.equal(args[0].endsWith('dispatch.mjs'),false,'native capacity stays authoritative');return{status:0,stdout:'{}',stderr:''};}}).pass();}finally{process.chdir(before);}
  const q=[...f.context().state.items.values()].filter(i=>i.role==='reviewer');assert.equal(q.length,2);assert.equal(calls.filter(a=>a[1]==='queue-review'&&a[2].startsWith('canonical:')).length,2);assert.equal(q.every(i=>i.meta.review_source_item===i.id&&i.meta.review_source_run===null),true);assert.equal(diagnosticHealth(f).queued_commits,2);assert.equal(calls.some(a=>/settle\//.test(a[0])),false);
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

function originalPartialFixture(t){
  const f=fixture(t),target=partialReview(f,'REV-4',{head:f.heads[0],base:f.base});partialReview(f,'REV-5',{head:f.heads[1],base:f.heads[0],run:'R-885',verdict:'PASS'});f.add([{type:'item.closed',id:'REV-5',as:'done'},{type:'item.closed',id:'ENG-1',as:'done'}]);
  const d=dispatchFixture(t,{project:f,sourceEntry:true}),workspace=path.join(f.scratch,'original-review');f.git(['worktree','add','-qb','lane/review-original',workspace,f.heads[0]],f.cwd);
  const lane=path.join(d.root,'bin/lane');fs.writeFileSync(lane,fs.readFileSync(lane,'utf8').replaceAll('lane/topic','lane/review-original'));
  const root=fs.realpathSync(sourceRoot),journal=path.join(f.org,'dispatch/original-r4.json'),route='review-codex',config=loadDiscoveredRoutes({cwd:f.cwd,env:f.env}).config,resolved=resolveRoute(config,{route}),routeConfig=journal.replace('.json','.routes.json');fs.writeFileSync(routeConfig,JSON.stringify(config));
  const job={token:'original-r4',repo:f.cwd,org:f.org,common:f.identity,release:{root,id:null,commit:null,protocol:1},item:'REV-4',lane:'review-original',route,reviewQueueProtocol:1,reviewQueue:target,reviewQueueBrief:`Original saved partial review. Captured immutable HEAD ${target.head}, base ${target.base}. Zero suites.`,workspace,brief:d.brief,report:null,to:null,base:target.head,extra:'',reuse:null,fromRun:null,unblocks:null,declared:{harness:resolved.kind,model:resolved.model??null,effort:resolved.effort??null},routeConfig,operatorRecordCommand:[process.execPath,path.join(root,'bin/org.mjs')],operatorRecordRoot:root,operatorPlainText:true,stage:'open',run:null,native_launch_attempted:false,error:'loaded queue/dispatch implementation changed; wait for next real pass'};fs.writeFileSync(journal,JSON.stringify(job));
  const env=installedService(f),q=f.context().state.items.get('REV-4'),key=`dispatch:REV-4:${q.created.seq}:ordinary`,effects={identity:f.identity,org:f.org,pass_number:0,actions:{[key]:{state:'held',error:job.error,receipt:{status:1,signal:null,stdout:JSON.stringify({result:'failed',code:'DISPATCH_FAILED',reason:job.error,journal}),stderr:job.error}},[`review:ENG-1:${target.head}`]:{state:'complete',review_target:target,review_operation:'record-queue',result:{review_item:q.id}}}};
  for(let pass=1;pass<=2;pass++){effects.pass_number=pass;effects.review_progress=observeReviewProgress({...f.context(),pass,previous:effects.review_progress}).progress;}
  effects.review_recovery_holds={'REV-4':{signature:effects.review_progress['REV-4'].signature,reason:'partial/ambiguous producer attempts remain immutable; no automatic replacement'}};const effectFile=path.join(f.directory,'effects.json');fs.writeFileSync(effectFile,JSON.stringify(effects));
  return{...f,d,env,target,journal,job,effects,effectFile};
}

test('original REV4-shaped continuation preserves its disjoint PASS peer and zero-native journal then uses one same-request native launch without replacement',async t=>{
  const f=originalPartialFixture(t),before=f.context(),original=fs.readFileSync(f.journal),verdict=before.events.find(e=>e.type==='change.reviewed'),calls=[],refreshes=[];
  const service=createLineService({repo:f.cwd,org:f.org,to:'brain-chat',env:f.env,maxStarts:1,capacity:()=>({cap:3,count:0}),recordNotice:d=>({id:d.id,state:'record-only'}),command:(exe,args)=>{
    if(args[0]===path.join(sourceRoot,'supervisor/closeout.mjs')){assertFiniteRefresh(f,args);refreshes.push(args);return{status:0,stdout:'{"created":[]}',stderr:''};}
    calls.push(args);if(exe==='herdr')return{status:0,stdout:'{"result":{"agents":[]}}',stderr:''};
    // A later pass may admit independent engineering work. It is not another
    // launch of the captured review request and uses this test's normal fake.
    if(args[0]===path.join(sourceRoot,'dispatch/dispatch.mjs')&&args[1]==='ENG-2')return{status:0,stdout:'{"result":"dispatched"}',stderr:''};
    assert.equal(args[0],path.join(sourceRoot,'dispatch/dispatch.mjs'));assert.equal(args[args.indexOf('--retry')+1],f.journal);assert.ok(args.includes('--continue-preflight'));return f.d.dispatch(args.slice(1),{env:{...f.d.env,HERDR_BRAIN_ROOT:fs.realpathSync(sourceRoot)}});
  }});service.pass();
  const c=f.context(),proof=c.events.find(e=>e.type==='review.original-prestart');assert.ok(proof,'legacy product hold is reconsidered on the checked original-scope capability');assert.equal(proof.original_native_launch_attempted,false);assert.equal(c.state.items.get('REV-4').closed,null);assert.equal(c.events.some(e=>e.type==='review.recovery-completed'),false);assert.deepEqual(c.events.find(e=>e.seq===verdict.seq),verdict);
  const originalLaunches=()=>calls.filter(a=>a[0]===path.join(sourceRoot,'dispatch/dispatch.mjs')&&a[1]!=='ENG-2');
  assert.equal(originalLaunches().length,1,'a missing-producer diagnostic no longer creates a decision that delays the original continuation');
  service.pass();assert.equal(refreshes.length,2);
  assert.equal(originalLaunches().length,1,JSON.stringify(diagnostics(f)));const archived=JSON.parse(fs.readFileSync(proof.archive.file)),savedOriginal=archived.files.find(f=>f.original===proof.journal);assert.deepEqual(fs.readFileSync(savedOriginal.archive),original);
  const file=f.journal+'.driver/results.jsonl';let terminal;
  for(;;){if(fs.existsSync(file)){terminal=JSON.parse(fs.readFileSync(file,'utf8').trim().split('\n').at(-1));if(terminal.stage==='complete'||terminal.exit_code!==0)break;}await new Promise(resolve=>setTimeout(resolve,25));}
  assert.equal(terminal.stage,'complete',JSON.stringify(terminal));assert.equal(promptCalls(f.d).length,1);const saved=JSON.parse(fs.readFileSync(f.journal));assert.equal(saved.token,'original-r4');assert.equal(saved.reviewQueue.head,f.heads[0]);assert.equal(saved.reviewQueue.base,f.base);assert.equal(saved.native_launch_attempted,true);assert.equal(saved.preflightContinuations[0].native_launch_attempted,false);assert.equal(saved.preflightContinuations[0].original_prestart_seq,proof.seq);assert.equal(f.context().state.items.get('REV-4').runs.length,1);assert.deepEqual(f.context().events.find(e=>e.seq===verdict.seq),verdict);assert.equal([...f.context().state.items.values()].filter(i=>i.role==='reviewer').length,2);
});

test('original partial continuation holds overlap active native owners altered evidence and admission captures without spending a replacement',t=>{
  for(const kind of ['overlap','active','changed','admission']){
    const f=originalPartialFixture(t),cwd=process.cwd(),release=noticeLock(path.join(f.directory,'pass.lock'));process.chdir(f.cwd);
    try{
      if(kind==='overlap')f.add([{type:'item.added',id:'REV-99',role:'reviewer',title:'Overlapping UNKNOWN attempt',meta:{review_source_item:'ENG-1',review_source_run:'R-1',review_target:f.target,review_round_cap:1}}]);
      if(kind==='changed')fs.appendFileSync(f.journal,' ');
      if(kind==='admission'){const events=f.context().events;events.find(e=>e.type==='item.added'&&e.id==='REV-4').meta.review_target.head=f.base;fs.writeFileSync(path.join(f.org,'events.jsonl'),events.map(e=>JSON.stringify(e)+'\n').join(''));}
      const call=()=>JSON.stringify({result:{agents:kind==='active'?[{name:'working',cwd:f.job.workspace}]:[]}}),args={repo:f.cwd,org:f.org,reviewId:'REV-4',env:f.env,call,kill:()=>{throw Object.assign(Error('gone'),{code:'ESRCH'});}};
      if(kind==='active')assert.equal(recoverServiceReview(args).result,'review_retained');else assert.throws(()=>recoverServiceReview(args),/overlapping|CAS|differs|unknown|scope/i);
      assert.equal(f.context().events.some(e=>e.type==='review.original-prestart'||e.type==='review.recovery-completed'),false);assert.equal(f.context().state.items.get('REV-4').closed,null);
    }finally{process.chdir(cwd);release();}
  }
});

function recordedPartialFixture(t){
  const f=originalPartialFixture(t),id='R-886',meta={lane:f.job.lane,route:f.job.route,...f.job.declared,dispatch_project:f.identity,dispatch_record:f.org,dispatch_journal:f.journal,dispatch_attempt:f.job.token,dispatch_role:'review'};
  const sourceOwner=f.context().run.owner,owner={...sourceOwner,release:{...sourceOwner.release,root:fs.realpathSync(sourceRoot)}};
  f.add([{type:'run.started',id,item:'REV-4',workspace:f.job.workspace,brief_path:path.join(f.org,`runs/${id}/brief.md`),report_path:path.join(f.org,`runs/${id}/report.md`),meta},
    {type:'run.claimed',run:id,project:f.identity,record:f.org,owner}]);
  const run=f.context().state.runs.get(id);f.job={...f.job,run:id,stage:'worker',ownership:{owner:run.owner,generation:run.owner_generation}};fs.writeFileSync(f.journal,JSON.stringify(f.job));
  const pass=()=>{f.effects.pass_number++;f.effects.review_progress=observeReviewProgress({...f.context(),pass:f.effects.pass_number,previous:f.effects.review_progress}).progress;fs.writeFileSync(f.effectFile,JSON.stringify(f.effects));};
  const recover=(extra={})=>{pass();pass();const cwd=process.cwd(),release=noticeLock(path.join(f.directory,'pass.lock'));process.chdir(f.cwd);try{return recoverServiceReview({repo:f.cwd,org:f.org,reviewId:'REV-4',env:f.env,call:()=>JSON.stringify({result:{agents:[]}}),...extra});}finally{process.chdir(cwd);release();}};
  return{...f,pass,recover};
}

test('recorded partial zero-native worker continues only its original run and captured scope preserving completed sibling verdict',t=>{
  const f=recordedPartialFixture(t),bytes=fs.readFileSync(f.journal),before=f.context(),verdict=before.events.find(e=>e.type==='change.reviewed'),result=f.recover();assert.equal(result.result,'original_review_ready');
  const proof=f.context().events.find(e=>e.seq===result.proof);assert.equal(proof.kind,'typed-pre-native-worker-barrier');assert.deepEqual(fs.readFileSync(f.journal),bytes);assert.deepEqual(proof.ownership,f.job.ownership);
  const dispatched=[];createLineService({repo:f.cwd,org:f.org,to:'brain-chat',env:f.env,maxStarts:0,recordNotice:d=>({id:d.id,state:'record-only'}),command:(exe,args)=>{
    if(exe==='herdr')return{status:0,stdout:'{"result":{"agents":[]}}',stderr:''};
    assert.equal(args[0],path.join(sourceRoot,'dispatch/dispatch.mjs'));assert.equal(args[args.indexOf('--retry')+1],f.journal);assert.ok(args.includes('--continue-review'));const result=f.d.dispatch(args.slice(1),{env:{...f.d.env,HERDR_BRAIN_ROOT:fs.realpathSync(sourceRoot)}});dispatched.push(result);return result;
  }}).pass();assert.equal(dispatched.length,1);assert.equal(dispatched[0].status,0,dispatched[0].stderr);
  const saved=JSON.parse(fs.readFileSync(f.journal)),after=f.context();assert.equal(saved.stage,'complete');assert.equal(saved.run,'R-886');assert.deepEqual(saved.reviewQueue,f.target);assert.equal(promptCalls(f.d).length,1);assert.deepEqual(after.state.items.get('REV-4').runs,['R-886']);assert.deepEqual(after.events.find(e=>e.seq===verdict.seq),verdict);assert.equal(after.events.some(e=>e.type==='review.recovery-completed'),false);
  assert.equal(f.d.dispatch(['--retry',f.journal,'--continue-review']).status,1);assert.equal(promptCalls(f.d).length,1);
});

test('idle original reviewer resumes one prompt only after exact session and process qualification and retains unknown active and changed bindings',t=>{
  const f=recordedPartialFixture(t);f.recover();f.d.fail('watch');const first=f.d.dispatch(['--retry',f.journal,'--continue-review'],{env:{...f.d.env,HERDR_BRAIN_ROOT:fs.realpathSync(sourceRoot)}});assert.equal(first.status,1);assert.equal(promptCalls(f.d).length,0);
  fs.unlinkSync(path.join(f.d.root,'fail'));const saved=JSON.parse(fs.readFileSync(f.journal));assert.equal(saved.stage,'watch');assert.equal(saved.native_launch_attempted,true);
  const agents=Object.values(JSON.parse(fs.readFileSync(path.join(f.d.root,'workers')))),original=agents[0],process=saved.launchProcess;
  const call=(_exe,args)=>JSON.stringify({result:args[1]==='list'?{agents}:{agent:original}}),options={call,readProcess:()=>({ok:true,value:process})};
  original.agent_status='working';assert.equal(f.recover(options).result,'review_retained');
  original.agent_status='idle';const session=original.agent_session;original.agent_session=null;assert.throws(()=>f.recover(options),/identity changed/);original.agent_session=session;
  assert.throws(()=>f.recover({...options,readProcess:()=>({ok:false,error:'EPERM'})}),/continuity is UNKNOWN/);
  const result=f.recover(options),proof=f.context().events.find(e=>e.seq===result.proof);assert.equal(proof.kind,'bound-unprompted-original');assert.equal(proof.original_native_launch_attempted,true);
  const resumed=f.d.dispatch(['--retry',f.journal,'--continue-review'],{env:{...f.d.env,HERDR_BRAIN_ROOT:fs.realpathSync(sourceRoot)}});assert.equal(resumed.status,0,resumed.stderr);assert.equal(promptCalls(f.d).length,1);assert.equal(f.d.calls().filter(c=>c.type==='lane'&&c.a[0]==='dispatch').length,1);
  assert.equal(JSON.parse(fs.readFileSync(f.journal)).run,'R-886');assert.equal(f.context().events.some(e=>e.type==='review.recovery-completed'),false);
});

function interruptedReviewDelivery(t,stage){
  const f=recordedPartialFixture(t);f.recover();f.d.fail(stage==='watch'?'watch':'screen');
  const dispatch=(args=[],env={})=>f.d.dispatch(['--retry',f.journal,...args],{env:{...f.d.env,HERDR_BRAIN_ROOT:fs.realpathSync(sourceRoot),...env}});
  const first=dispatch(['--continue-review']);assert.equal(first.status,1,first.stderr);assert.equal(promptCalls(f.d).length,0);
  fs.unlinkSync(path.join(f.d.root,'fail'));
  const saved=JSON.parse(fs.readFileSync(f.journal));assert.equal(saved.stage,stage);assert.equal(saved.native_launch_attempted,true);assert.ok(saved.launchProcess?.identity);
  const events=f.context().events,claims=events.filter(e=>e.type==='run.claimed'),verdict=events.find(e=>e.type==='change.reviewed');
  const retained=()=>{
    const current=JSON.parse(fs.readFileSync(f.journal)),c=f.context();
    for(const key of ['token','run','workspace','reviewQueue','reviewQueueBrief','ownership','worker','launchProcess','to','routeConfig'])assert.deepEqual(current[key],saved[key],key);
    if(saved.watcher)assert.deepEqual(current.watcher,saved.watcher);
    assert.deepEqual(c.events.filter(e=>e.type==='run.claimed'),claims);assert.deepEqual(c.events.find(e=>e.seq===verdict.seq),verdict);
    assert.deepEqual(c.state.items.get('REV-4').runs,['R-886']);assert.equal([...c.state.items.values()].filter(i=>i.role==='reviewer').length,2);
    assert.equal(c.events.some(e=>e.type==='review.recovery-completed'),false);assert.equal(f.d.calls().filter(c=>c.type==='lane'&&c.a[0]==='dispatch').length,1);
  };
  return{...f,dispatch,saved,retained};
}

// Change the observation, never the saved launch identity. This models PID
// reuse and an unavailable native source on both supported process sources.
function continuationNativeFault(f,kind){
  const hook=path.join(f.d.root,'continuity-fault.mjs');
  fs.writeFileSync(hook,`import fs from 'node:fs';
import cp from 'node:child_process';
import {syncBuiltinESMExports} from 'node:module';
if(process.argv[1]===${JSON.stringify(path.join(sourceRoot,'dispatch/dispatch.mjs'))}){
 const pid=${f.saved.launchProcess.pid},kind=${JSON.stringify(kind)},read=fs.readFileSync,exec=cp.spawnSync;
 fs.readFileSync=function(file,...args){
  if(String(file)==='/proc/'+pid+'/stat'){
   if(kind==='unknown')throw Error('injected native source unavailable');
   const text=String(read.call(this,file,...args)),start=text.lastIndexOf(') ')+2,fields=text.slice(start).trim().split(/\\s+/);fields[19]=String(Number(fields[19])+1);return text.slice(0,start)+fields.join(' ')+'\\n';
  }
  return read.call(this,file,...args);
 };
 cp.spawnSync=function(file,args,options){
  if(String(file).includes('/process-source-')&&args.at(-1)===String(pid)){
   if(kind==='unknown')return{status:1,stdout:'',stderr:'injected native source unavailable'};
   const r=exec.call(this,file,args,options);if(r.status===0)r.stdout=r.stdout.trim().split('\\n').map(line=>{const row=JSON.parse(line);row.identity=row.identity.replace(/\\d+$/,n=>String(Number(n)+1));return JSON.stringify(row);}).join('\\n')+'\\n';return r;
  }
  return exec.call(this,file,args,options);
 };syncBuiltinESMExports();
}`);
  return{NODE_OPTIONS:`${f.d.env.NODE_OPTIONS??''} --import=${hook}`};
}

for(const stage of ['watch','prompt'])for(const kind of ['working','birth','unknown'])test(`continuation retry from ${stage} retains the original attempt when native is ${kind}`,t=>{
  const f=interruptedReviewDelivery(t,stage),workers=path.join(f.d.root,'workers');let env={};
  if(kind==='working'){const agents=JSON.parse(fs.readFileSync(workers));agents[f.saved.worker.agentName].agent_status='working';fs.writeFileSync(workers,JSON.stringify(agents));}
  else env=continuationNativeFault(f,kind);
  const watches=f.d.calls().filter(c=>c.type==='watch').length,result=f.dispatch([],env);
  assert.equal(result.status,1,result.stderr);assert.match(result.stderr,kind==='unknown'?/unavailable/:/changed or is active/);
  assert.equal(promptCalls(f.d).length,0);assert.equal(f.d.calls().filter(c=>c.type==='watch').length,watches);f.retained();
  const current=JSON.parse(fs.readFileSync(f.journal));assert.deepEqual(current.reviewContinuations,f.saved.reviewContinuations);assert.deepEqual(current.watcher,f.saved.watcher);
});

for(const stage of ['watch','prompt'])test(`continuation retry from ${stage} delivers one original prompt to a qualified idle worker`,t=>{
  const f=interruptedReviewDelivery(t,stage),result=f.dispatch();assert.equal(result.status,0,result.stderr);f.retained();
  const saved=JSON.parse(fs.readFileSync(f.journal));assert.equal(saved.stage,'complete');assert.equal(promptCalls(f.d).length,1);assert.deepEqual(saved.reviewContinuations,f.saved.reviewContinuations);
  assert.equal(f.d.calls().filter(c=>c.type==='watch').length,stage==='watch'?2:1);assert.equal(f.dispatch().status,1);assert.equal(f.dispatch(['--resend']).status,1);assert.equal(promptCalls(f.d).length,1);
});

test('continuation retry of an interrupted bound-unprompted proof keeps its watcher and refuses recovery overrides',t=>{
  const f=interruptedReviewDelivery(t,'prompt'),agents=Object.values(JSON.parse(fs.readFileSync(path.join(f.d.root,'workers')))),original=agents[0];
  const result=f.recover({call:(_exe,args)=>JSON.stringify({result:args[1]==='list'?{agents}:{agent:original}}),readProcess:()=>({ok:true,value:f.saved.launchProcess})});
  const proof=f.context().events.find(e=>e.seq===result.proof);assert.equal(proof.kind,'bound-unprompted-original');
  f.d.fail('screen');const interrupted=f.dispatch(['--continue-review']);assert.equal(interrupted.status,1,interrupted.stderr);fs.unlinkSync(path.join(f.d.root,'fail'));
  const before=JSON.parse(fs.readFileSync(f.journal));assert.equal(before.stage,'prompt');assert.equal(before.reviewContinuations.length,2);assert.equal(promptCalls(f.d).length,0);
  for(const flags of [['--resend'],['--accept-delivered'],['--fresh'],['--adopt',original.name]]){
    const retry=f.dispatch(flags);assert.equal(retry.status,1);assert.match(retry.stderr,/cannot change launch or delivery recovery/);assert.equal(promptCalls(f.d).length,0);
  }
  const workers=path.join(f.d.root,'workers'),values=JSON.parse(fs.readFileSync(workers));values[original.name].agent_status='working';fs.writeFileSync(workers,JSON.stringify(values));
  assert.equal(f.dispatch().status,1);assert.equal(promptCalls(f.d).length,0);values[original.name].agent_status='idle';fs.writeFileSync(workers,JSON.stringify(values));
  const resumed=f.dispatch();assert.equal(resumed.status,0,resumed.stderr);f.retained();assert.equal(promptCalls(f.d).length,1);
  assert.deepEqual(JSON.parse(fs.readFileSync(f.journal)).reviewContinuations,before.reviewContinuations);assert.equal(f.context().events.filter(e=>e.type==='review.original-continuation').length,2);
});

test('continuation retry rechecks native status at delivery after the hook screen observation',t=>{
  const f=interruptedReviewDelivery(t,'prompt'),herdr=path.join(f.d.root,'bin/herdr');
  fs.writeFileSync(herdr,fs.readFileSync(herdr,'utf8').replace("if(a[0]==='pane' && a[1]==='read') {","if(a[0]==='pane' && a[1]==='read') { for(const w of Object.values(workers))w.agent_status='working';save();"));
  const result=f.dispatch();assert.equal(result.status,1);assert.match(result.stderr,/changed or is active before prompt/);assert.equal(promptCalls(f.d).length,0);f.retained();
  assert.equal(JSON.parse(fs.readFileSync(f.journal)).sessionBinding,undefined);
});

test('continuation retry never resends an uncertain original prompt',t=>{
  const f=interruptedReviewDelivery(t,'prompt');f.d.fail('prompt-lost-reply');
  const result=f.dispatch();assert.equal(result.status,1);assert.match(result.stderr,/lost prompt reply/);assert.equal(promptCalls(f.d).length,1);
  const saved=JSON.parse(fs.readFileSync(f.journal));assert.equal(saved.stage,'prompting');fs.unlinkSync(path.join(f.d.root,'fail'));
  for(const flags of [[],['--resend'],['--accept-delivered'],['--continue-review']]){
    const retry=f.dispatch(flags);assert.equal(retry.status,1);assert.match(retry.stderr,/UNKNOWN or progressed/);assert.equal(promptCalls(f.d).length,1);
  }
  assert.deepEqual(JSON.parse(fs.readFileSync(f.journal)),saved);f.retained();
});

test('original worker continuation refuses UNKNOWN native flags changed claim reports STOP and overlapping captures',t=>{
  for(const kind of ['true','unknown','claim','report','STOP','overlap']){
    const f=recordedPartialFixture(t);
    if(['true','unknown'].includes(kind))fs.writeFileSync(f.journal,JSON.stringify({...f.job,native_launch_attempted:kind==='true'?true:null}));
    if(kind==='claim')f.add([{type:'run.claimed',run:'R-886',project:f.identity,record:f.org,owner:{...f.job.ownership.owner,controller:'foreign'}}]);
    if(kind==='report'){const file=f.context().state.runs.get('R-886').report_path;fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,'Incoming original report');}
    if(kind==='STOP')fs.writeFileSync(path.join(f.directory,'STOP'),'STOP');
    if(kind==='overlap')f.add([{type:'item.added',id:'REV-99',role:'reviewer',title:'UNKNOWN overlap',meta:{review_source_item:'ENG-1',review_source_run:'R-1',review_target:f.target,review_round_cap:1}}]);
    assert.throws(()=>f.recover(),/UNKNOWN|partial|owner|controller|report|STOP|overlapping/i,kind);assert.equal(f.context().events.some(e=>e.type==='review.original-continuation'||e.type==='review.recovery-completed'),false,kind);assert.equal(promptCalls(f.d).length,0);
  }
});

test('permanent health and missing review producers stay diagnostic without spawning a decision or replaying the failed attempt',t=>{
  const f=fixture(t),env=installedService(f);f.add([{type:'item.closed',id:'ENG-1',as:'done'}]);const bytes=fs.readFileSync(path.join(f.org,'events.jsonl'));
  let calls=0,refreshes=0,allocations=0;const service=()=>createLineService({repo:f.cwd,org:f.org,to:'brain-chat',env,haltAfter:100,capacity:()=>{throw Object.assign(Error('decision pool occupied'),{code:'DISPATCH_DECISION_CAP'});},command:(_exe,args)=>{
    if(args[0]===path.join(sourceRoot,'supervisor/closeout.mjs')&&args[1]==='allocations'){
      assert.deepEqual(args.slice(2,6),['--repo',f.cwd,'--org',f.org]);assert.equal(args[6],'--deadline');
      const deadline=Number(args[7]);assert.ok(Number.isSafeInteger(deadline)&&deadline>Date.now()&&deadline<=Date.now()+720000);
      allocations++;return{status:0,stdout:'{}',stderr:''};
    }
    if(args[0]===path.join(sourceRoot,'supervisor/closeout.mjs')){assertFiniteRefresh(f,args);refreshes++;return{status:0,stdout:'{"created":[]}',stderr:''};}
    calls++;assert.equal(args[1],'queue-review');return{status:1,stdout:'',stderr:'selected helper cannot certify immutable review target'};
  }});
  for(let n=0;n<5;n++)service().pass();const health=diagnosticHealth(f),rows=diagnostics(f);
  const after=fs.readFileSync(path.join(f.org,'events.jsonl'));assert.deepEqual(after.subarray(0,bytes.length),bytes);
  const added=after.subarray(bytes.length).toString().trim().split('\n').map(JSON.parse);assert.equal(added.length,1);
  const kept=added.find(e=>e.type==='closeout.binding-kept');
  assert.equal(kept.identity,f.identity);assert.equal(kept.run,'R-1');assert.equal(kept.item,'ENG-1');assert.equal(kept.completed,false);
  assert.deepEqual(kept.source,{seq:f.context().run.report.seq,type:'report.ingested'});assert.equal(kept.condition.kind,'missing-identity');
  for(const resource of ['session','folder','branch']){assert.equal(kept.resources[resource].status,'kept');assert.equal(kept.resources[resource].owner,'R-1');}
  assert.equal(added.some(e=>e.type==='item.added'),false);
  assert.ok(rows.some(r=>r.boundary===`outcome:review:ENG-1:${f.heads[1]}`&&r.scope.failure.kind==='unknown'));
  assert.equal(health.gap_passes,5);assert.equal(health.owed,1);assert.equal(health.owed_commits,2);assert.equal(health.queued,0);
  assert.equal(rows.filter(r=>r.boundary==='review-gap'&&r.inspection_due).length,1);assert.equal(calls,1);assert.equal(refreshes,5);
  assert.equal(allocations,1,'the fourth turn performs its existing finite allocation reconciliation');
  assert.deepEqual(closeoutCheckpoint(f).errors,[],'all five finite refreshes completed without a swallowed fixture refusal');
  const digest=morningDigest({events:f.context().events,diagnostics:rows});assert.ok(digest.review_errors.occurrences>=5);assert.equal(digest.review_health.pass_id,health.pass_id);
  assert.equal(fs.existsSync(path.join(f.org,'supervisor/inbox.log')),false);
});

test('continuity discovery producer and index failures preserve diagnostics while independent cleanup and READY admission proceed',t=>{
  for(const kind of ['producer','index']){
    const f=fixture(t),env=installedService(f),policy=JSON.parse(fs.readFileSync(path.join(f.cwd,'.lane.json')));policy.retirement={closeout_queue:true};fs.writeFileSync(path.join(f.cwd,'.lane.json'),JSON.stringify(policy));
    const added=transact(f.org,events=>bindCloseoutSources({cwd:f.cwd,org:f.org,events,env:f.env,mutation:{add:[{type:'item.closed',id:'ENG-1',as:'done',completed_run:'R-1'}]}})).added;
    publishCloseoutEvents({cwd:f.cwd,org:f.org,added,start:false,env:f.env});f.add([{type:'item.added',id:'ENG-2',role:'engineer',title:'Independent ready work'}]);
    if(kind==='producer')fs.appendFileSync(f.file,'changed immutable bytes');
    else{const rows=f.context().events;rows.find(e=>e.type==='line-service.phase0').canonical_head='f'.repeat(40);fs.writeFileSync(path.join(f.org,'events.jsonl'),rows.map(e=>JSON.stringify(e)+'\n').join(''));}
    const calls=[],service=createLineService({repo:f.cwd,org:f.org,to:'brain-chat',env,maxStarts:1,capacity:()=>({cap:1,count:0}),command:(_exe,args)=>{
      calls.push(args);return{status:0,stdout:args[0].endsWith('closeout.mjs')?JSON.stringify({evaluated:[{key:added[0].closeout_targets[0].key,completed:true}]}):args[0].endsWith('dispatch.mjs')?JSON.stringify({result:'detached',journal:path.join(f.org,'dispatch/new.json')}):'{}',stderr:''};
    }});
    service.pass();assert.ok(calls.some(a=>a[0].endsWith('closeout.mjs')),kind);assert.equal(calls.filter(a=>a[0].endsWith('dispatch.mjs')).length,1,kind);
    const notices=diagnostics(f).filter(e=>e.notice_record),held=notices.find(e=>e.boundary.startsWith('review-source:'));
    assert.ok(held,kind);assert.equal(held.scope.review,true);assert.equal('head' in held.scope,false);
    if(kind==='producer'){assert.match(held.reason,/immutable producer report/);assert.equal(held.scope.item,'ENG-1');assert.equal(held.scope.run,'R-1');}
    else{assert.match(held.reason,/bad object|revision|unknown|invalid|not a valid/i);assert.deepEqual(held.scope,{review:true});}
  }
});

test('an older unbound review error is retained while future bound counters stay diagnostic',t=>{
  const f=fixture(t),env=installedService(f);f.add([{type:'item.closed',id:'ENG-1',as:'done'}]);
  const legacyKey='b'.repeat(64),legacy={first_at:'2026-10-26T00:00:00.000Z',reason:'old reason',scope:{},state:'recorded',id:`line-record-${legacyKey}`,count:3,review:true,review_count_recorded:0};
  const file=path.join(f.directory,'effects.json'),audit=path.join(f.directory,'passes.jsonl');
  fs.writeFileSync(file,JSON.stringify({identity:f.identity,org:f.org,actions:{},record_notices:{[legacyKey]:legacy}}));
  const service=createLineService({repo:f.cwd,org:f.org,to:'brain-chat',env,capacity:()=>({cap:0,count:0}),command:(_exe,args)=>({status:1,stdout:'',stderr:'selected helper cannot certify immutable review target'})});
  service.pass();service.pass();service.pass();
  const rows=fs.readFileSync(audit,'utf8').trim().split('\n').map(JSON.parse),events=f.context().events,typed=events.filter(e=>e.type==='line-service.review-error'),repeats=events.filter(e=>e.type==='line-service.review-error-counts');
  assert.equal(rows.some(r=>r.action==='review-error-counter-held'),false,'one unbound row never fails the batch');
  assert.equal(rows.findLast(r=>r.action==='pass-complete').timing.review_error_unbound,1);
  assert.equal(typed.length,0);assert.equal(repeats.length,0,'future counters never append to the record');
  assert.equal(morningDigest({events,diagnostics:rows}).review_errors.occurrences,3);
  const saved=JSON.parse(fs.readFileSync(file)).record_notices[legacyKey];assert.equal(saved.review_count_recorded,0);assert.equal(saved.count,3);assert.equal(saved.boundary,undefined);
});

test('continuity base notices retain identity and recorded state across recurrence audit interruption and batched counter replay',t=>{
  const f=fixture(t),env=installedService(f);f.add([{type:'item.closed',id:'ENG-1',as:'done'}]);
  const boundary=`review:ENG-1:${f.heads[1]}`,reason='selected helper native refusal; preserve original attempt',scope={},key=hash(canonical([boundary,reason,scope])),id=`line-record-${key}`,first_at='2026-10-26T00:00:00.000Z';
  const file=path.join(f.directory,'effects.json'),audit=path.join(f.directory,'passes.jsonl'),prior={first_at,reason,scope,state:'recorded',id,count:4,record:{id,state:'record-only'}};
  fs.writeFileSync(file,JSON.stringify({identity:f.identity,org:f.org,actions:{},record_notices:{[key]:prior},notice_audit_offset:0}));
  let calls=0,deliveries=0,refreshes=0;const service=createLineService({repo:f.cwd,org:f.org,to:'brain-chat',env,haltAfter:100,capacity:()=>{throw Object.assign(Error('decision pool occupied'),{code:'DISPATCH_DECISION_CAP'});},recordNotice:d=>{if(d.id===id){deliveries++;throw Error('recorded notice must not redeliver');}return{id:d.id,state:'record-only'};},command:(_exe,args)=>{
    if(args[0]===path.join(sourceRoot,'supervisor/closeout.mjs')){assertFiniteRefresh(f,args);refreshes++;return{status:0,stdout:'{"created":[]}',stderr:''};}
    calls++;assert.equal(args[1],'queue-review');return{status:1,stdout:'',stderr:reason};
  }});
  // Simulate interruption after the compact fsync but before the journal
  // checkpoint. Already-written counters must deduplicate on recovery too.
  const write=fs.writeFileSync;let interrupted=false;
  fs.writeFileSync=function(target,...args){if(String(target).startsWith(file+'.')&&fs.existsSync(audit)&&fs.readFileSync(audit,'utf8').includes('"notice_record"')){interrupted=true;throw Error('injected journal checkpoint interruption');}return write.call(this,target,...args);};
  try{assert.throws(()=>service.pass(),/injected journal checkpoint interruption/);}finally{fs.writeFileSync=write;}
  assert.equal(interrupted,true);const interruptedRows=fs.readFileSync(audit,'utf8').trim().split('\n').map(JSON.parse),delta=interruptedRows.find(e=>e.notice_record)?.notice_record;
  assert.equal(delta.entry.boundary,boundary);assert.equal(delta.entry.id,id);assert.equal(delta.entry.count,5);assert.equal(delta.entry.first_at,first_at);assert.equal(delta.entry.state,'recorded');
  service.pass();const saved=JSON.parse(fs.readFileSync(file)),entry=saved.record_notices[key];
  assert.equal(entry.boundary,boundary);assert.equal(entry.id,id);assert.equal(entry.first_at,first_at);assert.equal(entry.state,'recorded');assert.deepEqual(entry.record,prior.record);assert.equal(entry.count,6);assert.equal(entry.review_count_recorded,undefined);assert.equal(deliveries,0);
  const rows=fs.readFileSync(audit,'utf8').trim().split('\n').map(JSON.parse),last=rows.findLast(r=>r.action==='pass-complete');
  // The checkpoint failure itself also has a retained review-health delta.
  const interruptedKeys=new Set(interruptedRows.filter(r=>r.notice_record).map(r=>r.notice_record.key));assert.ok(interruptedKeys.has(key));assert.equal(last.timing.notice_audit_replayed,interruptedKeys.size);assert.equal(last.timing.notice_record_attempts,0);
  assert.equal(calls,1,'replay must retain the prior held effect rather than requeue it');
  const typed=f.context().events.filter(e=>e.type==='line-service.review-error'&&e.key===key),repeats=f.context().events.filter(e=>e.type==='line-service.review-error-counts'&&key in e.counts);assert.equal(typed.length,0);assert.equal(repeats.length,0);assert.equal(entry.count,6);
  service.pass();assert.equal(calls,1);assert.equal(refreshes,3);assert.equal(JSON.parse(fs.readFileSync(file)).record_notices[key].count,7);assert.equal(deliveries,0);
});

test('permanent review route falls back to the existing review route without replacing explicit task policy',()=>{
  const config=structuredClone(ROUTE_PRESET);delete config.routes.reviewer;delete config.selection_policy.by_task_class.review;
  config.routes.review={kind:'codex',model:'fixture-reviewer',effort:'max'};
  assert.equal(reviewQueueRoute(config),'review');
  config.selection_policy.by_task_class.review='review-codex';assert.equal(reviewQueueRoute(config),'review-codex');
  delete config.selection_policy.by_task_class.review;delete config.selection_policy.by_task_class['review-other-family'];delete config.routes.review;assert.throws(()=>reviewQueueRoute(config),/unknown task class: review/);
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

test('review intake ingests heading and isolated bold verdicts exactly once through the line service and normal record CLI',t=>{
  const f=fixture(t),target=discoverChanges(f.context()).changes[0].target,owner=f.context().run.owner;
  const policy=JSON.parse(fs.readFileSync(path.join(f.cwd,'.lane.json')));policy.retirement={closeout_queue:false,line_service_cleanup:false};
  fs.writeFileSync(path.join(f.cwd,'.lane.json'),JSON.stringify(policy));
  const cases=[['R-2','REV-1','## Verdict: PASS','PASS'],['R-3','REV-2','**FAIL**','FAIL'],['R-4','REV-3','## Verdict: PASS','PASS']];
  const originals=new Map();
  for(const [id,item,body,verdict]of cases){
    const file=path.join(f.org,`runs/${id}/report.md`),text=`---\nrun: ${id}\noutcome: done\nsummary: Independent immutable review.\nproposals: []\n---\n\n${body}\n\n${verdict==='FAIL'?'- [Major] source-1:1 - broken invariant':'No findings.'}\n`;
    fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,text);originals.set(id,text);
    f.add([{type:'item.added',id:item,role:'reviewer',title:'Review',meta:{review_source_item:'ENG-1',review_source_run:'R-1',review_key:`ENG-1:${target.head}`,review_target:target,review_round_cap:1}},
      {type:'run.started',id,item,workspace:f.workspace,report_path:file,meta:{dispatch_project:f.identity}},
      {type:'run.claimed',run:id,record:f.org,project:f.identity,owner}]);
  }
  const calls=[],env={...f.env,HERDR_BRAIN_ROOT:f.bundle};
  const command=(exe,args,options)=>{
    assert.notEqual(exe,'herdr','intake never consults or relaunches the reviewer');
    if(args[1]!=='ingest')return {status:0,stdout:'{}',stderr:''};
    calls.push(args);
    return spawnSync(process.execPath,[path.join(f.bundle,'bin/org.mjs'),...args.slice(1)],{...options,env:{...options.env,HERDR_BRAIN_ROOT:f.bundle}});
  };
  const service=()=>createLineService({repo:f.cwd,org:f.org,to:'brain-chat',env,command,maxStarts:0,capacity:()=>({count:0,cap:4}),recordNotice:d=>({id:d.id})});
  service().pass();service().pass();assert.equal(calls.length,3);
  for(const [id,item,,verdict]of cases){
    const r=f.context().state.runs.get(id),text=originals.get(id),file=r.report_path;
    assert.equal(r.report.extra.verdict,verdict);assert.equal(r.report.sha256,hash(text));assert.deepEqual(r.owner,owner);
    assert.equal(fs.readFileSync(file,'utf8'),text);assert.equal(fs.readFileSync(path.join(f.org,r.report.file),'utf8'),text);
    const again=spawnSync(process.execPath,[path.join(f.bundle,'bin/org.mjs'),'ingest',file,'--run',id,'--if-current-run',id],{cwd:f.cwd,env,encoding:'utf8'});
    assert.equal(again.status,0,again.stderr);assert.match(again.stdout,/already recorded/);
    const c=f.context(),facts=c.events.filter(e=>e.type==='change.reviewed'&&e.review_run===id);
    assert.equal(c.events.filter(e=>e.type==='report.ingested'&&e.run===id).length,1);assert.equal(facts.length,1);
    assert.equal(facts[0].verdict,verdict);assert.deepEqual(facts[0].verdict_evidence,{frontmatter:false,body_lines:[1]});
    assert.deepEqual(c.state.items.get(item).meta.review_target,target);assert.deepEqual(c.state.items.get(item).runs,[id]);
  }
  const fixes=[...f.context().state.items.values()].filter(i=>i.meta.review_fix_of===`ENG-1:${target.head}`);
  assert.equal(fixes.length,1);assert.equal(fixes[0].parent,'REV-2');assert.equal(fixes[0].meta.severity,'major');
});

test('review intake heading and isolated bold judgments retain quoted fenced malformed indented and contradictory refusals',t=>{
  const f=fixture(t),target=discoverChanges(f.context()).changes[0].target;
  f.add([{type:'item.added',id:'REV-1',role:'reviewer',title:'Review',meta:{review_source_item:'ENG-1',review_source_run:'R-1',review_target:target}},
    {type:'run.started',id:'R-2',item:'REV-1',workspace:f.cwd}]);
  const c=f.context(),run=c.state.runs.get('R-2'),report={outcome:'done',proposals:[],extra:{}};
  for(const body of ['> ## Verdict: PASS','> **FAIL**','```md\n## Verdict: PASS\n```','~~~\n**FAIL**\n~~~',
    '    ## Verdict: PASS','    **FAIL**','\t**FAIL**','- **FAIL**','**FAIL** means a correction is needed.',
    '**FAIL','**UNKNOWN**','####### Verdict: PASS','##Verdict: PASS','## Verdict: UNKNOWN',
    '## Verdict: PASS\n**FAIL**','**PASS**\n## Verdict: FAIL'])
    assert.throws(()=>reviewResultEvents({...c,run,report,body,sha256:hash(body)}),/explicit|ambiguous/,body);
  for(const body of ['## Verdict: PASS','**PASS**'])
    assert.throws(()=>reviewResultEvents({...c,run,report:{...report,extra:{verdict:'FAIL'}},body,sha256:hash(body)}),/ambiguous/);
  for(const body of ['# Verdict: NEEDS-WORK','### **NEEDS-WORK**'])
    assert.equal(reviewResultEvents({...c,run,report,body,sha256:hash(body)})[0].verdict,'NEEDS-WORK');
  assert.deepEqual(f.context().events,c.events,'parsing never writes report, judgment or replacement-attempt events');
  assert.equal(f.context().state.runs.get('R-2').report,null);
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

test('full-bold R3404-shaped verdict with following text records one FAIL and Major while preserving its immutable feature scope and separate fixture PASS',t=>{
  const f=fixture(t),target=partialReview(f,'REV-1204',{head:f.heads[0],base:f.base,run:'R-3404'});
  partialReview(f,'REV-1203',{head:f.heads[1],base:f.heads[0],run:'R-3403',verdict:'PASS'});
  const text='---\nrun: R-3404\noutcome: done\nsummary: Reviewed the captured initial feature.\nproposals: []\n---\n\n**Verdict: FAIL.** Review work is complete; the Major below still needs correction.\n\n- [Major] codec.mjs:41 - decoded aggregate objects passed as paths\n',parsed=readReport(text),file=path.join(f.org,'reports/R-3404.md'),owner=f.context().run.owner;
  assert.deepEqual(parsed.errors,[]);fs.writeFileSync(file,text);
  f.add([{type:'run.claimed',run:'R-3404',record:f.org,project:f.identity,owner},{type:'report.ingested',run:'R-3404',file:'reports/R-3404.md',sha256:hash(text),report:parsed.report}]);
  const before=f.context(),peer=before.events.find(e=>e.type==='change.reviewed'&&e.review_run==='R-3403'),env=installedService(f),release=noticeLock(path.join(f.directory,'pass.lock'));
  try{const result=recordReviewResults({repo:f.cwd,org:f.org,runId:'R-3404',env});assert.equal(result.added.filter(e=>e.type==='change.reviewed').length,1);assert.equal(recordReviewResults({repo:f.cwd,org:f.org,runId:'R-3404',env}).added.length,0);}finally{release();}
  const c=f.context(),facts=c.events.filter(e=>e.type==='change.reviewed'&&e.review_run==='R-3404');assert.equal(facts.length,1);assert.equal(facts[0].verdict,'FAIL');assert.equal(facts[0].head,f.heads[0]);assert.equal(facts[0].base,f.base);assert.deepEqual(facts[0].covered_commits,[f.heads[0]]);assert.equal(facts[0].report_sha256,hash(text));assert.equal(facts[0].findings.length,1);assert.equal(facts[0].findings[0].severity,'major');
  const fixes=[...c.state.items.values()].filter(i=>i.meta.review_fix_of===`ENG-1:${f.heads[0]}`);assert.equal(fixes.length,1);assert.equal(fixes[0].meta.review_round_cap,1);assert.equal(fixes[0].meta.severity,'major');assert.deepEqual(c.events.find(e=>e.type==='change.reviewed'&&e.review_run==='R-3403'),peer);assert.deepEqual(c.state.items.get('REV-1204').meta.review_target,target);assert.equal(c.state.items.get('REV-1204').closed,null);assert.equal(fs.readFileSync(file,'utf8'),text);assert.deepEqual(c.state.runs.get('R-3404').owner,owner);
});

test('full-bold verdict suffix preserves frontmatter agreement and quoted fenced malformed or indented holds without a new review',t=>{
  const f=fixture(t),target=partialReview(f,'REV-1204',{head:f.heads[0],base:f.base,run:'R-3404'}),c=f.context(),run=c.state.runs.get('R-3404'),report={outcome:'done',proposals:[],extra:{verdict:'PASS'}};
  assert.throws(()=>reviewResultEvents({...c,run,report,body:'**Verdict: FAIL.** Review work is complete.',sha256:'a'.repeat(64)}),/ambiguous/);
  for(const body of ['> **Verdict: FAIL.** Review work is complete.','```text\n**Verdict: FAIL.** Review work is complete.\n```','    **Verdict: FAIL.** Review work is complete.','**Verdict: FAIL. Review work is complete.','**Verdict: UNKNOWN.** Review work is complete.'])assert.throws(()=>reviewResultEvents({...c,run,report:{...report,extra:{}},body,sha256:'a'.repeat(64)}),/explicit|ambiguous/);
  assert.deepEqual(f.context().state.items.get('REV-1204').meta.review_target,target);assert.equal(f.context().events.some(e=>e.type==='change.reviewed'),false);assert.equal([...f.context().state.items.values()].filter(i=>i.role==='reviewer').length,1);
});

test('phase1 current service records an old selected consumers immutable review result without changing its owner or pin',t=>{
  const f=fixture(t),target=discoverChanges(f.context()).changes[0].target,key=`ENG-1:${target.head}`;
  const text='---\nrun: R-2\noutcome: done\nsummary: Actual immutable review.\nverdict: FAIL\nproposals:\n  - role: engineer\n    title: Fix the source\n    why: Resolve the Major.\n---\n- [Major] source-1:1 - broken invariant\n';
  fs.writeFileSync(path.join(f.org,'reports/R-2.md'),text);
  const owner=f.context().run.owner;
  f.add([{type:'item.added',id:'REV-1',role:'reviewer',title:'Review',meta:{review_source_item:'ENG-1',review_source_run:'R-1',review_key:key,review_target:target,review_round_cap:1}},
    {type:'run.started',id:'R-2',item:'REV-1',workspace:f.cwd}, {type:'run.claimed',run:'R-2',record:f.org,project:f.identity,owner},
    {type:'report.ingested',run:'R-2',file:'reports/R-2.md',sha256:hash(text),report:{outcome:'done',summary:'Review',extra:{verdict:'FAIL'},proposals:[{role:'engineer',title:'Fix the source'}]}},
    {type:'item.added',id:'ENG-2',role:'engineer',title:'Fix the source',why:'Resolve the Major.',parent:'REV-1',from_run:'R-2'}]);
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

test('permanent review capacity admits review at a full build pool and retains independent review uncertain legacy and explicit shared ceilings',t=>{
  const f=configFixture(t,{custom:true}),common=gitProject(f.cwd).identity,org=f.env.ORG_DIR,dir=path.join(org,'dispatch');fs.mkdirSync(dir,{recursive:true});
  for(let n=0;n<7;n++)fs.writeFileSync(path.join(dir,`build-${n}.json`),JSON.stringify({stage:'open',detached:true,common,item:`ENG-${n+1}`}));
  const config={dispatch:{max_sessions:7,max_review_sessions:3}},args={config,org,common,kill:()=>{throw Object.assign(Error('denied'),{code:'EPERM'});},readProcess:()=>({ok:false})};
  const review=checkSessionCap({...args,kind:'review'});assert.equal(review.count,0);assert.equal(review.native_count,7);assert.equal(review.native_cap,10);assert.equal(review.cap,3);
  assert.throws(()=>checkSessionCap({...args,kind:'build'}),e=>e.code==='DISPATCH_SESSION_CAP'&&e.sessions.count===7);
  assert.throws(()=>checkSessionCap({...args,kind:'review',config:{dispatch:{...config.dispatch,max_total_sessions:7}}}),e=>e.code==='DISPATCH_SESSION_CAP'&&e.sessions.count===0&&e.sessions.native_cap===7);
  for(let n=0;n<2;n++)fs.writeFileSync(path.join(dir,`review-${n}.json`),JSON.stringify({stage:'open',detached:true,common,item:`REV-${n+1}`,reviewQueue:{head:'a'.repeat(40)}}));
  assert.equal(checkSessionCap({...args,kind:'review'}).count,2);
  const occupants=path.join(org,'retirement/occupants');fs.mkdirSync(occupants,{recursive:true});fs.writeFileSync(path.join(occupants,'legacy.json'),JSON.stringify({schema:'retirement-occupant/v1',kind:'settle',run:'R-90',common,process:null}));
  assert.throws(()=>checkSessionCap({...args,kind:'review'}),e=>e.code==='DISPATCH_REVIEW_CAP'&&e.sessions.count===3&&e.sessions.native_count===10&&e.sessions.sessions.some(s=>s.occupancy==='unknown liveness'));
  assert.throws(()=>checkSessionCap({...args,kind:'all'}),e=>e.code==='DISPATCH_SESSION_CAP'&&e.sessions.native_cap===7,'old callers keep their combined ceiling');
});

test('phase1 blocked report requires genuine new input and ignores its own routine service notes',t=>{
  const f=fixture(t),c=f.context(),run={...c.run,report:{...c.run.report,outcome:'blocked'}},item=c.item;
  assert.equal(blockedChangeKey({...c,run,item}),null);
  const own={type:'note.added',id:item.id,seq:run.report.seq+1,by:'line-service',text:'same hold'};
  assert.equal(blockedChangeKey({...c,run,item,events:[...c.events,own]}),null);
  const human={...own,seq:own.seq+1,by:'source-owner',text:'New brief and evidence supplied'};
  assert.equal(blockedChangeKey({...c,run,item,events:[...c.events,own,human]}),null,'an ordinary note is evidence, not dispatch readiness');
  const changed={type:'item.updated',id:item.id,seq:human.seq+1,by:'source-owner',fields:{accept:['A genuinely changed task input']}};
  assert.ok(blockedChangeKey({...c,run,item,events:[...c.events,own,human,changed]}));
});

test('saved-phase readiness preserves immutable blocked evidence and original source ownership until an explicit current-item handoff while independent READY work remains eligible',t=>{
  const f=fixture(t,{reported:false}),text='---\nrun: R-1\noutcome: blocked\nsummary: Source phase blocked; full live work remains.\nblockers: []\n---\n';fs.writeFileSync(f.file,text);f.add([{type:'report.ingested',run:'R-1',file:'reports/R-1.md',sha256:hash(text),report:{outcome:'blocked',summary:'Full live work remains',artifacts:[],blockers:[],proposals:[],extra:{}}}]);
  const original=f.context(),owner=structuredClone(original.run.owner),report=structuredClone(original.run.report);
  f.add([{type:'note.added',id:'R-1',text:'Bounded source phase complete; 42 comparator controls pass; F2/live gaps remain.',decision:false},{type:'note.added',id:'ENG-1',text:'Phase evidence is retained; no whole-item completion.',decision:true},{type:'item.updated',id:'ENG-1',fields:{meta:{phase_receipt:'owned/phase-receipt.json',notify:'supervisor'}}}]);
  assert.equal(dispatchInput(f.context()),null,'routine phase facts and decisions cannot release another build');
  f.add([{type:'item.updated',id:'ENG-1',fields:{accept:['A genuine task input after the blocked report']}}]);assert.ok(dispatchInput(f.context()));
  unreportedNativeLandings(f);assert.equal(dispatchInput(f.context()),null,'positive later original-owner source retains that recovery, not a new build');
  f.add([{type:'item.added',id:'ENG-2',role:'engineer',title:'Independent ready work'}]);const independent=f.context();assert.ok(dispatchInput({...independent,item:independent.state.items.get('ENG-2')}));assert.deepEqual(independent.run.report,report);assert.deepEqual(independent.run.owner,owner);assert.equal(fs.readFileSync(f.file,'utf8'),text);assert.equal(independent.item.closed,null);
  f.add([{type:'item.reopened',id:'ENG-1',note:'Actual owner explicitly hands remaining unfinished scope back to normal work; no done claim.'}]);assert.ok(dispatchInput(f.context()));assert.deepEqual(f.context().run.report,report);assert.equal(f.context().item.closed,null);
});

test('phase1 finite report intake records failure and retries the current owned candidate while independent starts continue without a live pane',t=>{
  const f=fixture(t,{reported:false});fs.mkdirSync(path.join(f.org,'runs/R-1'),{recursive:true});fs.writeFileSync(path.join(f.org,'runs/R-1/report.md'),f.report);
  f.add([{type:'item.added',id:'ENG-2',title:'Ready',role:'engineer'},{type:'item.added',id:'ENG-3',title:'Also ready',role:'engineer'}]);
  const calls=[];let failed=false;
  const command=(_exe,args,options)=>{assert.equal(options.timeout,0);calls.push(args);
    if(args[1]==='ingest'&&!failed){failed=true;return {error:Object.assign(Error('transient'),{code:'ETIMEDOUT'}),status:null,stdout:'',stderr:''};}
    if(args[1]==='ingest'){f.add([{type:'report.ingested',run:'R-1',item:'ENG-1',file:'reports/R-1.md',sha256:hash(f.report),report:{outcome:'done',artifacts:f.heads.map(h=>`Commit: ${h}`),extra:{},blockers:[]}}]);return {status:0,stdout:'ingested',stderr:''};}
    return {status:0,stdout:args[0].endsWith('dispatch.mjs')?JSON.stringify({result:'detached',journal:path.join(f.org,'dispatch',`new-${calls.length}.json`)}):'{}',stderr:''};};
  const service=()=>createLineService({repo:f.cwd,org:f.org,to:'brain-chat',env:f.env,command,capacity:()=>({cap:2,count:0}),recordNotice:d=>({id:d.id,state:'record-only'}),maxStarts:2});
  service().pass();assert.equal(calls.filter(a=>a[0].endsWith('dispatch.mjs')).length,2);assert.ok(calls.filter(a=>a[0].endsWith('dispatch.mjs')).every(a=>a.includes('--detach')));
  const initial=closeoutCheckpoint(f);assert.deepEqual(initial.errors,[{run:'R-1',stage:'ingest',reason:'transient'}]);assert.equal(initial.ingest['R-1'],1);assert.equal(f.context().run.report,null);
  service().pass();assert.equal(f.context().run.report.sha256,hash(f.report));assert.equal(calls.filter(a=>a[1]==='ingest').length,2);
  service().pass();assert.equal(calls.filter(a=>a[1]==='ingest').length,2,'committed ingestion suppresses a third validation attempt');
  assert.equal(f.context().events.filter(e=>e.type==='report.ingested'&&e.run==='R-1').length,1);assert.deepEqual(closeoutCheckpoint(f).errors,[]);
  assert.equal(Object.keys(JSON.parse(fs.readFileSync(path.join(f.directory,'effects.json'))).actions).some(k=>k.startsWith('ingest:')),false,'finite intake does not acquire a general-pass effect intent');
  assert.equal(calls.some(a=>a[0]==='agent'),false);
});

test('phase1 measured inactive owned child failure does not freeze independent work or replay a native launch',t=>{
  const f=fixture(t,{reported:false});fs.mkdirSync(path.join(f.org,'runs/R-1'),{recursive:true});fs.writeFileSync(path.join(f.org,'runs/R-1/report.md'),f.report);f.add([{type:'item.added',id:'ENG-2',title:'Ready',role:'engineer'}]);
  const calls=[];const command=(_exe,args,options)=>{calls.push(args);assert.equal(options.timeout,0);if(args[1]==='ingest')return {status:null,signal:'SIGTERM',stdout:'',stderr:'confirmed inactive owned child',signal_sent:true,activity:{observations:[{kind:'frozen',silence_s:2,inactivity_s:2}]}};return {status:0,stdout:'{}',stderr:''};};
  createLineService({repo:f.cwd,org:f.org,to:'brain-chat',env:f.env,command,capacity:()=>({cap:1,count:0}),recordNotice:d=>({id:d.id}),childTimeoutMs:30,maxStarts:1}).pass();
  assert.ok(calls.some(a=>a[0].endsWith('dispatch.mjs')));assert.equal(fs.existsSync(path.join(f.directory,'pass.lock')),false);
});

test('phase1 repeated finite intake failures stay diagnostic and every pass writes a heartbeat',t=>{
  const f=fixture(t,{reported:false});fs.mkdirSync(path.join(f.org,'runs/R-1'),{recursive:true});fs.writeFileSync(path.join(f.org,'runs/R-1/report.md'),f.report);const notes=[];
  const options={repo:f.cwd,org:f.org,to:'brain-chat',env:f.env,command:()=>({status:1,stdout:'',stderr:'temporarily locked'}),capacity:()=>({cap:1,count:0}),recordNotice:d=>{notes.push(d);return {id:d.id};}};
  for(let n=0;n<3;n++){
    createLineService(options).pass();const checkpoint=closeoutCheckpoint(f);
    assert.equal(checkpoint.ingest['R-1'],n+1);assert.deepEqual(checkpoint.errors,[{run:'R-1',stage:'ingest',reason:'temporarily locked'}]);
    const heartbeat=JSON.parse(fs.readFileSync(path.join(f.directory,'heartbeat.json')));assert.ok(heartbeat.at);assert.equal(heartbeat.project,f.identity);assert.equal(heartbeat.phase,'finished');
  }
  assert.equal(notes.length,0);assert.equal(f.context().run.report,null);
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
  const target=added[0].closeout_targets.find(t=>t.signal==='landed'),key=target.key,source={seq:added[0].seq,type:added[0].type},calls=[],successors=[];
  const service=createLineService({repo:f.cwd,org:f.org,to:'brain-chat',env:f.env,capacity:()=>({count:0,cap:4}),recordNotice:data=>({id:data.id,state:'record-only'}),command:(_exe,args)=>{
    if(args[0]===path.join(sourceRoot,'supervisor/closeout.mjs')){
      calls.push(args);assert.deepEqual(JSON.parse(args[args.indexOf('--keys')+1]),[key]);
      assert.ok(args.includes('--no-restart'));assert.ok(args.includes('--retry-safe'));
      if(calls.length===1)return{status:0,stdout:JSON.stringify({evaluated:[],restart:{keys:[key],old:{source:'old'},current:{source:'new'}}}),stderr:''};
      const row={key,run:'R-1',completed:true};f.add([{type:'closeout.evaluated',identity:f.identity,source,...row}]);
      return{status:0,stdout:JSON.stringify({evaluated:[row]}),stderr:''};
    }
    if(args[0]===path.join(sourceRoot,'line-service/closeout.mjs')){
      successors.push(args);assert.ok(args.includes('--once'));assert.ok(args.includes('--no-handoff'));assert.ok(Number(args[args.indexOf('--deadline')+1])>Date.now());
      return{status:0,stdout:JSON.stringify({result:'closeout-code-handoff-pending',reason:'bounded fresh successor also changed; original obligations retained'}),stderr:''};
    }
    return{status:0,stdout:'{}',stderr:''};
  }});
  service.pass();const pending=closeoutCheckpoint(f);assert.deepEqual(pending.pending,{stage:'closeout',key,source});assert.equal(successors.length,1);
  assert.equal(f.context().events.some(e=>e.type==='closeout.evaluated'&&e.key===key),false,'pending code handoff is not completion');
  service.pass();service.pass();assert.equal(calls.length,2,'one fresh drain, then completed effect stays complete');
  const completed=closeoutCheckpoint(f);assert.equal(completed.pending,undefined);assert.equal(completed.targets[key],2);assert.equal(completed.last_result.result.evaluated[0].completed,true);
  assert.equal(successors.length,1,'only one fresh successor runs inside the original handoff allowance');
});

test('closeout has a viable finite allowance independent of the general pass budget',t=>{
  for(const passBudgetMs of [1000,180000,480000,undefined]){
    const budgetMs=720000;
    const f=fixture(t),policy=JSON.parse(fs.readFileSync(path.join(f.cwd,'.lane.json')));
    policy.retirement={closeout_queue:true};fs.writeFileSync(path.join(f.cwd,'.lane.json'),JSON.stringify(policy));
    const added=transact(f.org,events=>bindCloseoutSources({cwd:f.cwd,org:f.org,events,env:f.env,mutation:{add:[{type:'item.closed',id:'ENG-1',as:'done',completed_run:'R-1'}]}})).added;
    publishCloseoutEvents({cwd:f.cwd,org:f.org,added,start:false,env:f.env});
    const key=added[0].closeout_targets.find(t=>t.signal==='landed').key,calls=[];let clock=0,started;
    const service=createLineService({repo:f.cwd,org:f.org,to:'brain-chat',env:f.env,passBudgetMs,workClock:()=>clock,closeoutMeasure:()=>{},
      command:(_exe,args)=>{
        calls.push(args);
        assert.equal(args[0],path.join(sourceRoot,'supervisor/closeout.mjs'));
        assert.equal(args[1],'drain');assert.deepEqual(JSON.parse(args[args.indexOf('--keys')+1]),[key]);
        const deadline=Number(args[args.indexOf('--deadline')+1]);
        assert.ok(Number.isSafeInteger(deadline)&&deadline>=started+budgetMs-1&&deadline<=Date.now()+budgetMs,
          `passBudgetMs=${passBudgetMs} must grant ${budgetMs} ms`);
        clock=budgetMs;
        return{status:0,stdout:JSON.stringify({evaluated:[{key,completed:true}]}),stderr:''};
      }});
    started=Date.now();const result=service.closeout();
    assert.equal(result.result,'closeout-turn-complete');assert.equal(result.steps,1);assert.deepEqual(result.errors,[]);
    assert.equal(calls.length,1,'no further drain or refresh starts once the selected allowance is spent');
  }
});

test('useful admission proceeds after unrelated productive cleanup exceeds its work budget while a fresh STOP still prevents launch',t=>{
  for(const stopped of [false,true]){
    const f=fixture(t),policy=JSON.parse(fs.readFileSync(path.join(f.cwd,'.lane.json')));policy.retirement={closeout_queue:true};fs.writeFileSync(path.join(f.cwd,'.lane.json'),JSON.stringify(policy));
    const added=transact(f.org,events=>bindCloseoutSources({cwd:f.cwd,org:f.org,events,env:f.env,mutation:{add:[{type:'item.closed',id:'ENG-1',as:'done',completed_run:'R-1'}]}})).added;publishCloseoutEvents({cwd:f.cwd,org:f.org,added,start:false,env:f.env});f.add([{type:'item.added',id:'ENG-2',role:'engineer',title:'Independent genuinely ready work'}]);
    let clock=0;const calls=[],key=added[0].closeout_targets.find(t=>t.signal==='landed').key,service=createLineService({repo:f.cwd,org:f.org,to:'brain-chat',env:f.env,maxStarts:1,passBudgetMs:100,workClock:()=>clock,capacity:()=>({cap:1,count:0}),recordNotice:d=>({id:d.id,state:'record-only'}),command:(_exe,args,options)=>{
      assert.equal(options.timeout,0);calls.push(args);
      if(args[0]===path.join(sourceRoot,'supervisor/closeout.mjs')){clock+=1000;if(stopped)fs.writeFileSync(path.join(f.directory,'STOP'),'fresh stop after productive cleanup');return{status:0,stdout:JSON.stringify({evaluated:[{key,completed:true}]}),stderr:''};}
      return{status:0,stdout:args[0].endsWith('dispatch.mjs')?JSON.stringify({result:'detached',journal:path.join(f.org,'dispatch/new-original.json')}):'{}',stderr:''};
    }});
    const result=service.pass();if(stopped)assert.match(result.held,/STOP/);assert.ok(calls.some(a=>a[0].endsWith('supervisor/closeout.mjs')));assert.equal(calls.filter(a=>a[0].endsWith('dispatch.mjs')).length,stopped?0:1);
    assert.equal(clock,1000,'the independent closeout allowance was spent');
    const rows=diagnostics(f),timing=rows.find(r=>r.action==='closeout-timing');
    assert.equal(timing.duration_ms,1000);assert.equal(timing.budget_ms,720000);
    if(!stopped){assert.equal(rows.find(r=>r.action==='admission-stage').preceding_budget_exhausted,false,'the general pass starts with its own allowance');assert.equal(rows.find(r=>r.action==='pass-complete').starts,1);
      assert.equal(rows.find(r=>r.action==='pass-complete').timing.closeout_ms,1000);}
  }
});

test('cleanup runs before slow review work and a fresh STOP still prevents the review effect',t=>{
  for(const cleanupWorkMs of [10,1000])for(const stopped of [false,true]){
    const f=fixture(t),env=installedService(f),policy=JSON.parse(fs.readFileSync(path.join(f.cwd,'.lane.json')));
    policy.retirement={closeout_queue:true};fs.writeFileSync(path.join(f.cwd,'.lane.json'),JSON.stringify(policy));
    const added=transact(f.org,events=>bindCloseoutSources({cwd:f.cwd,org:f.org,events,env:f.env,mutation:{add:[{type:'item.closed',id:'ENG-1',as:'done',completed_run:'R-1'}]}})).added;
    publishCloseoutEvents({cwd:f.cwd,org:f.org,added,start:false,env:f.env});
    const key=added[0].closeout_targets.find(t=>t.signal==='landed').key,calls=[];let clock=0;
    const service=createLineService({repo:f.cwd,org:f.org,to:'brain-chat',env,passBudgetMs:100,workClock:()=>clock,maxStarts:0,
      capacity:()=>({cap:1,count:0}),recordNotice:d=>({id:d.id,state:'record-only'}),command:(_exe,args)=>{
        calls.push(args);
        if(args[1]==='drain'){
          clock+=cleanupWorkMs;
          if(stopped)fs.writeFileSync(path.join(f.directory,'STOP'),'fresh stop after independent cleanup');
        }
        if(args[1]==='queue-review')clock+=1000;
        return{status:0,stdout:args[0].endsWith('closeout.mjs')?JSON.stringify(args[1]==='refresh'?{created:[]}:{evaluated:[{key,completed:true}]}):'{}',stderr:''};
      }});
    const result=service.pass();if(stopped)assert.match(result.held,/STOP/);
    assert.equal(calls.filter(a=>a[1]==='drain'&&JSON.parse(a[a.indexOf('--keys')+1]).includes(key)).length,1);
    const refreshes=calls.filter(a=>a[1]==='refresh');
    assert.equal(refreshes.length,stopped?0:1,'refresh uses its independent closeout allowance while a fresh STOP still prevents it');
    if(!stopped)assertFiniteRefresh(f,refreshes[0]);
    assert.equal(calls.filter(a=>a[1]==='queue-review').length,stopped?0:1);
    if(!stopped)assert.ok(calls.findIndex(a=>a[1]==='drain')<calls.findIndex(a=>a[1]==='queue-review'),'slow review cannot consume the prior closeout turn');
  }
});

test('phase1 service retains an unknown exit intent and raises one grouped alarm without a replacement decision or native replay',t=>{
  const f=fixture(t),policy=JSON.parse(fs.readFileSync(path.join(f.cwd,'.lane.json'),'utf8'));policy.retirement={closeout_queue:true};fs.writeFileSync(path.join(f.cwd,'.lane.json'),JSON.stringify(policy));
  const env=installedService(f);
  const a=f.observation.agents[0];f.add([{type:'run.updated',id:'R-1',meta:{agent:a.name,pane:a.pane_id,worker_workspace:a.workspace_id,terminal_id:a.terminal_id,agent_session_id:a.agent_session.value}}]);
  const added=transact(f.org,events=>bindCloseoutSources({cwd:f.cwd,org:f.org,events,env:f.env,mutation:{add:[{type:'item.closed',id:'ENG-1',as:'done',completed_run:'R-1'}]}})).added;
  publishCloseoutEvents({cwd:f.cwd,org:f.org,added,start:false,env:f.env});const target={...added[0].closeout_targets.find(t=>t.signal==='landed'),source:{seq:added[0].seq,type:'item.closed'}},source=target.source;
  const intent='original-exit-intent',outcome={action:'agent-exit-requested',run:'R-1',pane:a.pane_id,tab_id:a.tab_id,occupant:[a.name,a.agent,a.pane_id,a.workspace_id,f.workspace,a.terminal_id,a.agent_session.value],shell:{pid:1,identity:'original-shell',command:'[zsh]'}};
  f.add([{type:'closeout.effect',key:target.key,identity:f.identity,source,effect:intent,producer:'native-closeout/v2',outcome},nativeCloseoutWait(target,outcome,intent),
    {type:'closeout.evaluated',key:target.key,identity:f.identity,run:'R-1',source,completed:false,revision:source.seq,reason:CLOSEOUT_EXIT_PENDING}]);
  const original=f.context().events.filter(e=>e.type==='closeout.effect'||e.type==='closeout.evaluated');
  const calls=[],refreshes=[],service=createLineService({repo:f.cwd,org:f.org,to:'brain-chat',env,capacity:()=>({count:0,cap:4}),recordNotice:data=>({id:data.id,state:'record-only'}),command:(_exe,args)=>{
    if(args[0]===path.join(sourceRoot,'supervisor/closeout.mjs')){assert.deepEqual(args.slice(0,6),[path.join(sourceRoot,'supervisor/closeout.mjs'),'refresh','--repo',f.cwd,'--org',f.org]);assert.equal(args[6],'--deadline');assert.ok(Number.isSafeInteger(Number(args[7])));refreshes.push(args);return{status:0,stdout:'{"created":[]}',stderr:''};}
    calls.push(args);
    return{status:0,stdout:'{}',stderr:''};
  }});
  for(let n=0;n<4;n++)service.pass();assert.equal(refreshes.length,4,'independent cleanup inventory remains allowed');
  const c=f.context(),waits=c.events.filter(e=>e.type==='closeout.waiting'&&e.key===target.key);assert.equal(waits.length,1);
  assert.equal(closeoutWaitState(waits[0],c.events),'pending');assert.equal(waits[0].waiting.owner,'native-closeout-command');assert.equal(waits[0].waiting.producers[0].intent,intent);
  const decisions=[...c.state.items.values()].filter(i=>i.meta.uncertain_outcome?.check.subject.key===target.key);assert.equal(decisions.length,0);
  const alarms=fs.readFileSync(path.join(f.directory,'closeout.log'),'utf8').trim().split('\n').map(JSON.parse).filter(e=>e.action==='closeout-supervisor-alarm');
  assert.equal(alarms.length,1);assert.equal(alarms[0].count,1);assert.equal(alarms[0].scopes[0].key,target.key);assert.equal(alarms[0].owner,'project-supervisor');
  // The fixture's landed source remains independently reviewable while its exit intent is held.
  assert.deepEqual(calls,[[path.join(sourceRoot,'bin/org.mjs'),'queue-review','R-1','--head',f.heads[1],'--base',f.base]],'only the exact independent source-review request is allowed');
  assert.equal(Object.keys(JSON.parse(fs.readFileSync(path.join(service.directory,'effects.json'))).actions).some(key=>key.startsWith('closeout:')),false,'no native observation/drain attempt is authorized');
  assert.deepEqual(c.events.filter(e=>e.type==='closeout.effect'||e.type==='closeout.evaluated'),original,'the original unknown outcome is never relabelled');
  assert.equal(c.events.some(e=>e.type==='closeout.effect'&&e.outcome?.action==='exit-observed'),false);
});

test('phase1 morning digest is record-derived and marks unknown durations rather than inventing zero',()=>{
  const events=[{type:'item.added',id:'ENG-1',role:'engineer',title:'Build',seq:1,at:'2026-10-27T01:00:00Z'},{type:'run.started',id:'R-1',item:'ENG-1',seq:2,at:'2026-10-27T01:01:00Z'},
    {type:'change.landed',item:'ENG-1',run:'R-1',head:'a'.repeat(40),landed_at:'2026-10-27T01:03:00Z',seq:3,at:'2026-10-27T01:04:00Z'},
    {type:'change.reviewed',item:'ENG-1',head:'a'.repeat(40),verdict:'PASS',findings:[],seq:4,at:'2026-10-27T01:05:00Z'}];
  const result=morningDigest({events,since:'2026-10-27T00:00:00Z',now:'2026-10-27T02:00:00Z'});assert.equal(result.landings.length,1);assert.equal(result.reviews.length,1);assert.equal(result.landings[0].build_to_main_minutes,2);assert.equal(result.idle_hours,null);
});
