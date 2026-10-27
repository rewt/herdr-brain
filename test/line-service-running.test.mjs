import test from './helpers/bounded-test.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { configFixture } from './helpers/config-home-fixture.mjs';
import { countSessions,checkSessionCap,acquireSessionCapLock } from '../dispatch/session-cap.mjs';
import { checkSourceAdmission,matchesDispatchStart } from '../dispatch/unlanded-cap.mjs';
import { createLineService,sourceRoot,serviceDirectory } from '../line-service/line-service.mjs';
import { gitProject } from '../lib/project.mjs';
import { loadEvents,transact } from '../lib/store.mjs';

const common='/fixture/project/.git';
const worker=n=>({id:`R-${n}`,item:`ENG-${n}`,workspace:'/fixture/lane',meta:{dispatch_project:common,agent:`worker-${n}`,pane:`p-${n}`,worker_workspace:'w',terminal_id:`t-${n}`}});
const state=runs=>({runs:new Map(runs.map(r=>[r.id,r]))});
const live=pid=>({ok:true,value:{pid,identity:'fixture-birth'}});
const journal=n=>({run:`R-${n}`,common,launchProcess:{pid:n,identity:'fixture-birth'}});

test('running capacity ignores many unlanded and done lifecycle rows while live workers and reviewers retain resources',()=>{
  const historical=Array.from({length:50},(_,n)=>({...worker(n+10),report:{outcome:'done'}}));
  historical.push({id:'R-100',item:'ENG-100',workspace:'/fixture/retired',meta:{dispatch_project:common,dispatch_unlanded_admitted:true}});
  const review={schema:'retirement-occupant/v1',kind:'settle',common,run:'R-10',process:{pid:90,identity:'fixture-birth'},terminal_id:'review'};
  const sessions=countSessions({state:state([...historical,worker(1),{...worker(2),meta:{...worker(2).meta,dispatch_role:'review'}}]),journals:[journal(1),journal(2)],reviewers:[review],common,kill:()=>{},readProcess:live});
  assert.deepEqual(sessions.map(s=>[s.run,s.kind]),[['R-1','worker'],['R-2','reviewer'],['R-10','reviewer']]);
  assert.equal(historical[0].report.outcome,'done');assert.equal(historical.at(-1).meta.dispatch_unlanded_admitted,true);
  assert.equal(countSessions({state:state([worker(1)]),journals:[journal(1)],common,kill:()=>{throw Object.assign(Error('unknown'),{code:'EPERM'});},readProcess:live})[0].occupancy,'unknown liveness');
});

test('running capacity retains unmatched starts and ambiguous launches until exact original evidence replaces them',()=>{
  const start={journal:'/fixture/start.json',item:'ENG-1',token:'one',common,stage:'starting',unlandedCap:{admission:{kind:'regular',admitted:false}}};
  const event={type:'run.started',id:'R-1',item:'ENG-1',workspace:'/fixture/lane',meta:{dispatch_project:common,dispatch_journal:start.journal,dispatch_attempt:'one',dispatch_unlanded_admitted:false}};
  const options={state:state([]),events:[],journals:[start],common};
  assert.equal(countSessions(options).length,1);assert.equal(countSessions(options)[0].occupancy,'uncertain launch');
  assert.equal(countSessions({...options,journals:[{...start,startRefused:true}]}).length,0);
  assert.equal(countSessions({...options,excludeStartJournal:start.journal}).length,0);
  assert.equal(matchesDispatchStart(event,start),true);
  assert.equal(countSessions({...options,events:[event],state:state([{...event,meta:event.meta}])}).length,0);
  assert.equal(countSessions({...options,events:[{...event,meta:{...event.meta,dispatch_attempt:'foreign'}}]}).length,1);
  assert.equal(countSessions({...options,journals:[{...start,stage:'launching',run:'R-2'}]}).length,1);
  assert.equal(countSessions({...options,journals:[{...start,common:'/foreign/.git'}]}).length,0);
});

test('running admission serialized contenders recount durable reservations and native full occupancy',t=>{
  const f=configFixture(t,{custom:true}),org=f.env.ORG_DIR,identity=gitProject(f.cwd).identity;
  const config={dispatch:{max_sessions:1}},options={config,org,common:identity,kill:()=>{},readProcess:live};
  assert.equal(checkSessionCap(options).count,0);
  const lockOptions={waitMs:0,kill:()=>{},readProcess:live};
  const release=acquireSessionCapLock(identity,lockOptions);
  const directory=path.join(org,'dispatch');fs.mkdirSync(directory,{recursive:true});
  const pending={common:identity,item:'ENG-1',token:'concurrent',stage:'starting',unlandedCap:{admission:{kind:'regular',admitted:false}}};
  fs.writeFileSync(path.join(directory,'pending.json'),JSON.stringify(pending));
  try{assert.throws(()=>acquireSessionCapLock(identity,lockOptions),e=>e.code==='DISPATCH_SESSION_CAP_LOCKED');}finally{release();}
  const second=acquireSessionCapLock(identity,lockOptions);
  try{assert.throws(()=>checkSessionCap(options),e=>e.code==='DISPATCH_SESSION_CAP'&&/pending start/.test(e.message));}finally{second();}
  fs.unlinkSync(path.join(directory,'pending.json'));
  const meta={...worker(1).meta,dispatch_project:identity};
  transact(org,()=>({add:[{type:'item.added',id:'ENG-1',title:'Running',role:'engineer'},{type:'run.started',id:'R-1',item:'ENG-1',workspace:f.cwd,meta}]}));
  fs.writeFileSync(path.join(directory,'active.json'),JSON.stringify({...journal(1),common:identity}));
  assert.throws(()=>checkSessionCap(options),e=>e.code==='DISPATCH_SESSION_CAP'&&/R-1/.test(e.message));
});

test('running source admission preserves real relations without charging unlanded history or build-review crossover',()=>{
  const events=[{type:'item.added',id:'ENG-1',title:'Old',role:'engineer'},{type:'item.added',id:'ENG-2',title:'Next',role:'engineer'},{type:'item.added',id:'REV-1',title:'Review',role:'reviewer'},
    {type:'run.started',id:'R-1',item:'ENG-1',workspace:'/fixture/lane',meta:{dispatch_project:common,dispatch_unlanded_admitted:true}}];
  const opts={config:{dispatch:{max_unlanded:1}},events,journals:[],common};
  const next=checkSourceAdmission({...opts,request:{item:'ENG-2'}});assert.equal(next.counted,false);assert.equal(next.historical_unlanded.count,1);assert.equal(next.admission.admitted,false);
  assert.throws(()=>checkSourceAdmission({...opts,request:{item:'ENG-2',fromRun:'R-1'}}),e=>e.code==='FROM_RUN_OTHER_ITEM');
  assert.throws(()=>checkSourceAdmission({...opts,request:{item:'ENG-2',unblocks:'ENG-2'}}),e=>e.code==='DISPATCH_UNBLOCKS_INVALID');
  assert.equal(checkSourceAdmission({...opts,request:{item:'ENG-2',unblocks:'ENG-1'}}).admission.unblocks,'ENG-1');
  assert.equal(checkSourceAdmission({...opts,request:{item:'REV-1'}}).admission.kind,'review');
  assert.throws(()=>checkSourceAdmission({...opts,request:{item:'REV-1',fromRun:'R-1'}}),e=>e.code==='DISPATCH_REVIEW_REPLACEMENT');
});

test('running line service dispatches genuine READY work despite lifecycle backlog and leaves native full occupancy held',t=>{
  const f=configFixture(t,{custom:true}),org=f.env.ORG_DIR,identity=gitProject(f.cwd).identity;
  fs.writeFileSync(path.join(f.cwd,'.lane.json'),JSON.stringify({routes:{engineer:{kind:'codex'}},dispatch:{max_unlanded:1,max_sessions:1}}));
  const history=[];for(let n=1;n<=12;n++)history.push({type:'item.added',id:`ENG-${n}`,title:'Historical open',role:'engineer'}, {type:'run.started',id:`R-${n}`,item:`ENG-${n}`,workspace:'/missing/history',meta:{dispatch_project:identity,dispatch_unlanded_admitted:true}});
  history.push({type:'line-service.cutover',id:'fixture',project:identity,repo:f.cwd,org,source:sourceRoot,main:'main',canonical_head:f.git('rev-parse','HEAD')},{type:'item.added',id:'ENG-99',title:'Actually ready',role:'engineer'});
  transact(org,()=>({add:history}));const calls=[],notes=[];
  const options={repo:f.cwd,org,to:'brain-chat',env:f.env,recordNotice:d=>{notes.push(d);return {id:d.id,state:'recorded'};},command:(_exe,args)=>{calls.push(args);return {status:0,stdout:'{"run":"R-99"}',stderr:''};}};
  createLineService({...options,capacity:()=>({cap:1,count:0})}).pass();
  assert.equal(calls.length,1);assert.equal(calls[0][1],'ENG-99');assert.ok(calls[0][0].endsWith('dispatch/dispatch.mjs'));
  assert.equal(loadEvents(org).events.some(e=>e.type==='item.closed'),false);
  // Independent actually-ready item receives no effect when native occupancy is full.
  transact(org,()=>({add:[{type:'item.added',id:'ENG-100',title:'Another ready',priority:9,role:'engineer'}]}));
  createLineService({...options,capacity:()=>{throw Object.assign(Error('native full'),{code:'DISPATCH_SESSION_CAP'});}}).pass();
  assert.equal(calls.length,1);assert.equal(notes.length,0);assert.ok(Object.values(JSON.parse(fs.readFileSync(path.join(serviceDirectory(org,identity),'effects.json'))).record_notices).some(n=>n.reason==='native full'));
});
