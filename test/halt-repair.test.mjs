import test from './helpers/bounded-test.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {initOrg,loadRecord,transact} from '../lib/store.mjs';
import {gitProject} from '../lib/project.mjs';
import {createLineService,serviceDirectory,sourceRoot} from '../line-service/line-service.mjs';
import {haltObservation,completeHaltPass} from '../line-service/halt-repair.mjs';
import {initialBriefRefusal} from '../dispatch/preflight.mjs';
import {createWorkerBrief} from '../lib/worker-brief.mjs';
import {noticeLock} from '../supervisor/notice-lock.mjs';
import {checkDispatchEligibility} from '../dispatch/launch-guard.mjs';

function fixture(t){
  const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'halt-repair-'))),repo=path.join(root,'project'),org=path.join(repo,'.org');
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));fs.mkdirSync(repo);fs.writeFileSync(path.join(root,'.identity-root'),'fixture');
  const env={...process.env,ORG_DIR:org,ORG_ACTOR:'line-service'};for(const k of ['HERDR_ENV','HERDR_PANE_ID','LANE_CONFIG','MONITOR_SUPERVISOR_AGENT'])delete env[k];
  const git=args=>{const r=spawnSync('git',args,{cwd:repo,env,encoding:'utf8'});assert.equal(r.status,0,r.stderr);return r.stdout.trim();};
  git(['init','-qb','main']);git(['config','user.name','Fixture']);git(['config','user.email','fixture@example.invalid']);
  fs.writeFileSync(path.join(repo,'source'),'initial');git(['add','.']);git(['commit','-qm','Initial']);initOrg(org);
  const config={routes:{engineer:{kind:'codex'},'engineer-xhigh':{kind:'codex'},review:{kind:'claude'}},selection_policy:{by_task_class:{review:'review'}}};
  fs.writeFileSync(path.join(repo,'.lane.json'),JSON.stringify(config));
  const identity=gitProject(repo).identity,directory=serviceDirectory(org,identity);fs.mkdirSync(directory,{recursive:true});
  fs.writeFileSync(path.join(directory,'installation.json'),JSON.stringify({at:'2026-10-27T00:00:00Z',repo,org,source:sourceRoot,node:process.execPath,file:path.join(directory,'service.plist'),target:`gui/${process.getuid()}/dev.herdr.line.${path.basename(directory)}`}));
  const add=events=>transact(org,()=>({add:events}));
  const boundary={id:'fixture',project:identity,repo,org,source:fs.realpathSync(sourceRoot),main:'main',canonical_head:git(['rev-parse','HEAD'])};
  add(['line-service.cutover','line-service.phase0'].map(type=>({...boundary,type})));
  const item=(id='ENG-1',meta={})=>add([{type:'item.added',id,kind:'work',role:'engineer',title:'Stalled admission',meta}]);
  const read=()=>loadRecord(org),calls=[];
  const service=overrides=>createLineService({repo,org,to:'brain-chat',env,capacity:()=>({count:0,cap:7,sessions:[]}),command:(_exe,args)=>{calls.push(args);return {status:1,signal:null,stdout:'',stderr:'native refusal; original attempt retained'};},...overrides});
  return {repo,org,env,identity,directory,config,add,item,read,calls,service};
}

test('zero-ready passes never file a repair and completed idle passes deduplicate their record intent after a lost reply',t=>{
  const f=fixture(t);for(let n=0;n<4;n++)f.service().pass();
  assert.equal([...f.read().state.items.values()].length,0);
  f.item();const lock=noticeLock(path.join(f.directory,'pass.lock'));
  try{
    const observe=()=>haltObservation({...f.read(),identity:f.identity,config:f.config});
    let previous;
    const pass=id=>{const result=completeHaltPass({repo:f.repo,org:f.org,env:f.env,pass:id,previous,observation:observe(),route:'engineer-xhigh',after:3,audit:path.join(f.directory,'passes.jsonl'),effects:path.join(f.directory,'effects.json')});previous=result.progress;return result;};
    assert.equal(pass('one').count,1);assert.equal(pass('two').count,2);const third=pass('three');assert.ok(third.item);
    assert.equal(pass('three').item,third.item,'a repeated completed pass is a readback, not a second count');
    assert.equal(pass('four').item,third.item);assert.equal([...f.read().state.items.values()].filter(i=>i.meta.halt_repair).length,1);
    const acceptance=f.read().state.items.get(third.item).accept.join('\n');
    assert.match(acceptance,/^Why:[\s\S]*How we will know it works:/);
    assert.match(acceptance,/Preserve item\/ancestor\/reserved holds, ownership, STOP\/HOLD and resource guards/);
    assert.match(acceptance,/close its session and remove its worktree folder in the same step/);
    assert.match(acceptance,/delete its branch only if it is already on main/);
    assert.match(acceptance,/keep the folder only if it has unsaved changes/);
  }finally{lock();}
  assert.equal(f.read().events.some(e=>e.type==='line-service.halt-pass'),false,'routine counts never enter the event record');
});

test('selection and final launch use the same ancestor hold while independent ready work still admits',t=>{
  const f=fixture(t);f.add([{type:'item.added',id:'G-1',kind:'goal',title:'Actual reserved ancestor',meta:{reserved:true}}]);
  f.item();f.add([{type:'item.updated',id:'ENG-1',fields:{parent:'G-1'}}]);f.item('ENG-2');
  f.service({haltAfter:100}).pass();
  assert.equal(f.calls.filter(a=>a[1]==='ENG-1').length,0);assert.equal(f.calls.filter(a=>a[1]==='ENG-2').length,1);
  assert.throws(()=>checkDispatchEligibility({org:f.org,item:'ENG-1',common:f.identity,token:'same'},'/unused'),/G-1 is closed\/held\/reserved/);
});

test('review activity and detached acknowledgements do not hide a stall; productive native engineering does',t=>{
  const f=fixture(t);f.item();f.add([{type:'item.added',id:'REV-1',role:'reviewer',title:'Unrelated review'},
    {type:'run.started',id:'R-1',item:'REV-1',workspace:f.repo,meta:{dispatch_project:f.identity}},
    {type:'run.session_bound',run:'R-1',process:{pid:123,identity:'review'}}]);
  const context=()=>({...f.read(),identity:f.identity,config:f.config});
  const review=haltObservation({...context(),occupancy:{sessions:[{kind:'reviewer',occupancy:'observed live',runs:['R-1']}]}});
  assert.equal(review.productive.length,0);assert.equal(review.progress,0);
  f.add([{type:'item.added',id:'ENG-2',role:'engineer',title:'Productive engineer'},
    {type:'run.started',id:'R-2',item:'ENG-2',workspace:f.repo,meta:{dispatch_project:f.identity}},
    {type:'run.session_bound',run:'R-2',process:{pid:456,identity:'engineer'}}]);
  const occupancy={sessions:[{kind:'worker',occupancy:'observed live',runs:['R-2']}]};
  assert.equal(haltObservation({...context(),occupancy}).productive.length,1);
  for(let n=0;n<4;n++)f.service({capacity:()=>({...occupancy,count:1,cap:7})}).pass();
  assert.equal([...f.read().state.items.values()].filter(i=>i.meta.halt_repair).length,0);
  assert.equal(haltObservation({...context(),occupancy:{sessions:[{...occupancy.sessions[0],occupancy:'uncertain launch'}]}}).productive.length,0);
});

test('held-only backlog never files diagnosis; independent ready work can stall while held and native-capacity guards still refuse effects',t=>{
  const f=fixture(t);f.add([{type:'item.added',id:'G-1',kind:'goal',title:'Held parent',meta:{held:true}}]);f.item('ENG-1',{operator_reserved:true});
  f.add([{type:'item.updated',id:'ENG-1',fields:{parent:'G-1'}}]);
  let capacityCalls=0;
  const service=f.service({capacity:()=>{capacityCalls++;throw Object.assign(Error('real native shared cap'),{code:'DISPATCH_SESSION_CAP'});}});
  for(let n=0;n<3;n++)service.pass();
  assert.deepEqual(haltObservation({...f.read(),org:f.org,identity:f.identity,config:f.config}).ready,[]);
  assert.equal([...f.read().state.items.values()].filter(i=>i.meta.halt_repair).length,0);
  assert.equal(capacityCalls,0,'held work never reaches native admission');
  f.item('ENG-2');for(let n=0;n<3;n++)service.pass();
  const repair=[...f.read().state.items.values()].find(i=>i.meta.halt_repair);assert.ok(repair);
  assert.equal(f.calls.filter(a=>a[0]===path.join(sourceRoot,'dispatch/dispatch.mjs')).length,0,'capacity refusal never reaches dispatch');
  assert.ok(capacityCalls>0,'independent ready work still reaches the native-capacity guard');
  const job={org:f.org,item:'ENG-1',common:f.identity,token:'pending'};
  assert.throws(()=>checkDispatchEligibility(job,'/unused'),/held\/reserved/);
  f.add([{type:'item.updated',id:'ENG-1',fields:{meta:{operator_reserved:false}}}]);
  assert.throws(()=>checkDispatchEligibility(job,'/unused'),/held\/reserved/);
  assert.equal(f.read().state.items.get('G-1').meta.held,true);assert.equal(repair.meta.route,'engineer-xhigh');
});

test('completed repair stays exclusive without changed inputs and a pending repair stays exclusive across changed causes',t=>{
  // A pre-admission capacity refusal keeps the idle input stable. A fake
  // dispatch without a completion producer creates a new decision input.
  const f=fixture(t),service=f.service({capacity:()=>{throw Object.assign(Error('real native shared cap'),{code:'DISPATCH_SESSION_CAP'});}});
  f.item();for(let n=0;n<3;n++)service.pass();
  const first=[...f.read().state.items.values()].find(i=>i.meta.halt_repair);assert.ok(first);
  f.add([{type:'item.closed',id:first.id,as:'done'}]);for(let n=0;n<4;n++)service.pass();
  assert.equal([...f.read().state.items.values()].filter(i=>i.meta.halt_repair).length,1);
  f.add([{type:'item.updated',id:'ENG-1',fields:{priority:42}}]);for(let n=0;n<3;n++)service.pass();
  assert.equal([...f.read().state.items.values()].filter(i=>i.meta.halt_repair).length,2,'real ready-priority change starts a new counted episode');
  f.add([{type:'item.updated',id:'ENG-1',fields:{priority:43}}]);for(let n=0;n<4;n++)service.pass();
  assert.equal([...f.read().state.items.values()].filter(i=>i.meta.halt_repair).length,2,'pending repair stays exclusive despite another cause change');
});

test('only the exact completed pre-journal brief error with a changed valid address qualifies, never missing or uncertain evidence',()=>{
  const item={id:'ENG-1',role:'engineer',title:'Restore admission',accept:['Restore admission'],meta:{}},contract=createWorkerBrief({item,ask:'/record/ask',askText:'scope',project:'/project',org:'/record',lane:'line-eng-1-1',route:'engineer',harness:'codex',reviewRoute:'review',exception:{to:'supervisor-test',source:'project promote.to'}});
  const reason='Worker brief missing required fields: PROJECT SUPERVISOR address (configure owning project promote.to or launch MONITOR_SUPERVISOR_AGENT); no worker spawned',entry={state:'held',at:'2026-10-27T00:00:00Z',error:'dispatch: '+reason,receipt:{status:1,signal:null,stdout:JSON.stringify({result:'failed',code:'DISPATCH_FAILED',reason})}};
  const args={entry,contract,events:[],item:'ENG-1',outcome:{status:'unknown',reason:'original request outcome unavailable; no replacement'}};
  assert.equal(initialBriefRefusal(args).kind,'changed-brief-address');
  for(const patch of [{receipt:{...entry.receipt,status:null}},{receipt:{...entry.receipt,signal:'SIGTERM'}},{error:'EPERM native refusal'},{receipt:{...entry.receipt,stdout:JSON.stringify({result:'failed',code:'DISPATCH_FAILED',reason,journal:'/existing'})}},{receipt:{...entry.receipt,stdout:JSON.stringify({result:'failed',code:'DISPATCH_FAILED',reason,native_launch_attempted:true})}}])
    assert.equal(initialBriefRefusal({...args,entry:{...entry,...patch}}),null);
  assert.equal(initialBriefRefusal({...args,outcome:{status:'retained',native_launch_attempted:null}}),null);
  assert.equal(initialBriefRefusal({...args,events:[{type:'run.started',item:'ENG-1',at:entry.at}]}),null);
  assert.throws(()=>initialBriefRefusal({...args,contract:{...contract,exception:{to:null}}}),/PROJECT SUPERVISOR address/);
});

test('an existing uncertain native launch remains the original exclusive request while one independent diagnosis may start',t=>{
  const f=fixture(t);f.item();let original,originalCalls=0;
  const command=(_exe,args)=>{
    f.calls.push(args);if(args[1]!=='ENG-1')return {status:1,stdout:'',stderr:'native refusal retained'};
    originalCalls++;const directory=path.join(f.org,'dispatch');fs.mkdirSync(directory,{recursive:true});
    original=path.join(directory,'uncertain.json');
    const job={token:'uncertain',repo:f.repo,org:f.org,common:f.identity,item:'ENG-1',brief:args[args.indexOf('--brief')+1],stage:'launching',run:null,native_launch_attempted:true};
    fs.writeFileSync(original,JSON.stringify(job));return {status:1,signal:null,stdout:JSON.stringify({result:'failed',code:'DISPATCH_FAILED',journal:original,reason:'uncertain native launch'}),stderr:'uncertain native launch'};
  };
  f.service({command}).pass();const bytes=fs.readFileSync(original);
  for(let n=0;n<5;n++)f.service({command}).pass();
  assert.equal(originalCalls,1);assert.deepEqual(fs.readFileSync(original),bytes);
  assert.equal([...f.read().state.items.values()].filter(i=>i.meta.halt_repair).length,1);
});
