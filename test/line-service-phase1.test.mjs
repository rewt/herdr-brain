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
import {discoverChanges,blockedChangeKey,reviewResultEvents,morningDigest} from '../line-service/phase1.mjs';
import {reviewAttempt} from '../line-service/review.mjs';
import {queueReviewMutation} from '../line-service/review-queue.mjs';
import {countSessions,checkSessionCap} from '../dispatch/session-cap.mjs';
import {closeoutCodeIdentity} from '../lib/closeout-code.mjs';
import {kickCloseout} from '../lib/closeout.mjs';

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

test('phase1 owes every landed build commit after the boundary even after item close and source worktree cleanup',t=>{
  const f=fixture(t);f.add([{type:'item.closed',id:'ENG-1',as:'done'}]);f.git(['worktree','remove','--force',f.workspace],f.cwd);
  const found=discoverChanges(f.context());assert.deepEqual(found.changes.map(c=>c.target.head),f.heads);
  assert.equal(found.changes[0].target.base,f.base);assert.equal(found.changes[1].target.base,f.heads[0]);
  assert.equal(found.changes.some(c=>c.target.head===f.base),false);
});

test('phase1 dedup retains same-change UNKNOWN but unrelated old attempts and private folders block no new change',t=>{
  const f=fixture(t),c=f.context(),target=discoverChanges(c).changes[1].target;
  fs.mkdirSync(path.join(f.cwd,'.lane-review-unrelated-r1'));
  fs.mkdirSync(path.join(f.org,'retirement/occupants'),{recursive:true});const file=path.join(f.org,'retirement/occupants/old.json');
  fs.writeFileSync(file,JSON.stringify({kind:'settle',run:'R-1',item:'ENG-1',head:f.heads[0],qualification:'UNKNOWN'}));
  assert.equal(reviewAttempt(c.item,{...c,target}),null);
  fs.writeFileSync(file,JSON.stringify({kind:'settle',run:'R-1',item:'ENG-1',head:target.head,qualification:'UNKNOWN'}));
  assert.match(reviewAttempt(c.item,{...c,target}),/review|native|receipt|retained/);
});

test('phase1 creates one queue item per landed change with immutable evidence and never duplicates the same key',t=>{
  const f=fixture(t),c=f.context(),changes=discoverChanges(c).changes;
  const before=process.cwd(),env={...f.env,ORG_ACTOR:'line-service',HERDR_ENV:'',HERDR_PANE_ID:''};process.chdir(f.cwd);
  try{
    for(const change of changes){const r=queueReviewMutation({...f.context(),runId:'R-1',head:change.target.head,base:change.target.base,env});f.add(r.add);}
    const q=[...f.context().state.items.values()].filter(i=>i.role==='reviewer');assert.equal(q.length,2);assert.notEqual(q[0].meta.review_key,q[1].meta.review_key);
    const again=queueReviewMutation({...f.context(),runId:'R-1',head:changes[0].target.head,base:changes[0].target.base,env});assert.equal(again.add.length,0);
  }finally{process.chdir(before);}
});

test('phase1 verdict and Major FAIL plus Minor findings become immutable scoped facts and linked work once',t=>{
  const f=fixture(t),target=discoverChanges(f.context()).changes[0].target;
  f.add([{type:'item.added',id:'REV-1',role:'reviewer',title:'Review',meta:{review_source_item:'ENG-1',review_source_run:'R-1',review_key:`ENG-1:${target.head}`,review_target:target,review_round_cap:1}},{type:'run.started',id:'R-2',item:'REV-1',workspace:f.cwd,meta:{dispatch_role:'review'}}]);
  const c=f.context(),run=c.state.runs.get('R-2'),report={outcome:'done',summary:'Findings',extra:{verdict:'FAIL'},proposals:[],body:'- [Major] source-1:1 - broken invariant\n- [Minor] source-2:1 - unclear name'};
  const added=reviewResultEvents({...c,run,report,sha256:'a'.repeat(64)});assert.equal(added.filter(e=>e.type==='change.reviewed').length,1);
  const work=added.filter(e=>e.type==='item.added');assert.equal(work.length,2);assert.ok(work.every(e=>e.parent==='REV-1'&&e.meta.review_fix_of===`ENG-1:${target.head}`));
  f.add(added);assert.equal(reviewResultEvents({...f.context(),run,report,sha256:'a'.repeat(64)}).length,0);
});

test('phase1 build and three review slots are separate while uncertain starts and unknown owners remain occupied',t=>{
  const f=configFixture(t,{custom:true}),common=gitProject(f.cwd).identity,org=f.env.ORG_DIR,dir=path.join(org,'dispatch');fs.mkdirSync(dir,{recursive:true});
  for(let n=1;n<=3;n++)fs.writeFileSync(path.join(dir,`review-${n}.json`),JSON.stringify({stage:'launching',common,item:`REV-${n}`,unlandedCap:{admission:{kind:'review'}}}));
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
  const command=(_exe,args,options)=>{assert.ok(options.timeout>0);calls.push(args);
    if(args[1]==='ingest'&&!failed){failed=true;return {error:Object.assign(Error('transient'),{code:'ETIMEDOUT'}),status:null,stdout:'',stderr:''};}
    if(args[1]==='ingest'){f.add([{type:'report.ingested',run:'R-1',item:'ENG-1',file:'reports/R-1.md',sha256:hash(f.report),report:{outcome:'done',artifacts:f.heads.map(h=>`Commit: ${h}`),extra:{},blockers:[]}}]);return {status:0,stdout:'ingested',stderr:''};}
    return {status:0,stdout:args[0].endsWith('dispatch.mjs')?JSON.stringify({result:'detached',journal:path.join(f.org,'dispatch',`new-${calls.length}.json`)}):'{}',stderr:''};};
  const service=()=>createLineService({repo:f.cwd,org:f.org,to:'brain-chat',env:f.env,command,capacity:()=>({cap:2,count:0}),recordNotice:d=>({id:d.id,state:'record-only'}),maxStarts:2});
  service().pass();assert.equal(calls.filter(a=>a[0].endsWith('dispatch.mjs')).length,2);assert.ok(calls.filter(a=>a[0].endsWith('dispatch.mjs')).every(a=>a.includes('--detach')));
  service().pass();assert.equal(f.context().run.report.outcome,'done');assert.equal(calls.some(a=>a[0]==='agent'),false);
});

test('phase1 hung owned child is bounded and does not freeze independent work or replay a native launch',t=>{
  const f=fixture(t,{reported:false});fs.mkdirSync(path.join(f.org,'runs/R-1'),{recursive:true});fs.writeFileSync(path.join(f.org,'runs/R-1/report.md'),f.report);f.add([{type:'item.added',id:'ENG-2',title:'Ready',role:'engineer'}]);
  const calls=[];const command=(_exe,args,options)=>{calls.push(args);if(args[1]==='ingest')return spawnSync(process.execPath,['-e','setInterval(()=>{},1000)'],{encoding:'utf8',timeout:Math.min(options.timeout,30)});return {status:0,stdout:'{}',stderr:''};};
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
  const before=closeoutCodeIdentity(f.cwd);fs.writeFileSync(path.join(f.cwd,'unrelated.txt'),'another landing');f.git('add','.');f.git('commit','-qm','Unrelated landing');const after=closeoutCodeIdentity(f.cwd);assert.equal(before.files,after.files);
  const project=gitProject(f.cwd),directory=serviceDirectory(f.env.ORG_DIR,project.identity);fs.mkdirSync(directory,{recursive:true});fs.writeFileSync(path.join(directory,'installation.json'),JSON.stringify({repo:f.cwd,org:f.env.ORG_DIR,source:sourceRoot,node:process.execPath,file:path.join(directory,'service.plist'),target:`gui/${process.getuid()}/dev.herdr.line.${path.basename(directory)}`}));
  assert.equal(kickCloseout(project,f.env.ORG_DIR,{env:f.env}).owned_by,'line-service');
});

test('phase1 morning digest is record-derived and marks unknown durations rather than inventing zero',()=>{
  const events=[{type:'item.added',id:'ENG-1',role:'engineer',title:'Build',seq:1,at:'2026-10-27T01:00:00Z'},{type:'run.started',id:'R-1',item:'ENG-1',seq:2,at:'2026-10-27T01:01:00Z'},
    {type:'change.landed',item:'ENG-1',run:'R-1',head:'a'.repeat(40),landed_at:'2026-10-27T01:03:00Z',seq:3,at:'2026-10-27T01:04:00Z'},
    {type:'change.reviewed',item:'ENG-1',head:'a'.repeat(40),verdict:'PASS',findings:[],seq:4,at:'2026-10-27T01:05:00Z'}];
  const result=morningDigest({events,since:'2026-10-27T01:00:00Z',now:'2026-10-27T02:00:00Z'});assert.equal(result.landings.length,1);assert.equal(result.reviews.length,1);assert.equal(result.landings[0].build_to_main_minutes,2);assert.equal(result.idle_hours,null);
});
