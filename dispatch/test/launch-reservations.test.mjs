import test from '../../test/helpers/bounded-test.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {configFixture} from '../../test/helpers/config-home-fixture.mjs';
import {loadEvents,transact} from '../../lib/store.mjs';
import {fold} from '../../lib/state.mjs';
import {gitProject} from '../../lib/project.mjs';
import {launchDisposition,inspectLaunch,resolveLaunch,MIN_LAUNCH_AGE_MS} from '../launch-reservations.mjs';
import {acquireSessionCapLock,checkSessionCap} from '../session-cap.mjs';

const source=fs.realpathSync(fileURLToPath(new URL('../../',import.meta.url)));
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const old='2026-01-01T00:00:00Z';
const run={id:'R-1',meta:{},started:{at:old}};
const job={stage:'launching',native_launch_attempted:false};

test('disposition requires positive pre-native proof and never infers absence from age',()=>{
  const inspect=(j=job,r=run,extra={})=>launchDisposition({job:j,run:r,...extra});
  assert.equal(inspect().disposition,'ELIGIBLE');
  for(const native_launch_attempted of [true,undefined])assert.equal(inspect({...job,native_launch_attempted}).disposition,'KEEP');
  assert.equal(inspect(job,{...run,started:{at:new Date().toISOString()}}).disposition,'KEEP');
  assert.equal(inspect(job,{...run,started:{at:'unknown'}}).disposition,'KEEP');
  assert.equal(inspect(job,run,{now:Date.parse(old)+MIN_LAUNCH_AGE_MS-1}).disposition,'KEEP');
  assert.equal(inspect(job,run,{now:Date.parse(old)+MIN_LAUNCH_AGE_MS}).disposition,'ELIGIBLE');
  for(const key of ['worker','launchProcess','sessionBinding','watcher'])assert.equal(inspect({...job,[key]:{}}).disposition,'KEEP');
  assert.equal(inspect(job,{...run,meta:{agent:'worker'}}).disposition,'KEEP');
  assert.equal(inspect(job,run,{events:[{type:'run.updated',id:'R-1',meta:{pane:'old-pane'}}]}).disposition,'KEEP');
  for(const error of ['EPERM','native refusal','STOP','identity mismatch'])assert.equal(inspect({...job,error}).disposition,'KEEP');
  assert.equal(inspect({...job,stage:'prompt'}).disposition,'KEEP');
  assert.equal(inspect(job,{...run,abandoned:{seq:4}}).disposition,'RELEASED');
  assert.equal(inspect({...job,worker:{}},{...run,report:{seq:4}}).disposition,'RELEASED');
});

test('legacy shell refusal is definitive while an import code without audited source stays ambiguous',()=>{
  const shell={stage:'launching',error:'/node dispatch: lane: could not verify initial pane environment w47W:p1; initial tab retained, nothing started'};
  assert.equal(launchDisposition({job:shell,run}).disposition,'ELIGIBLE');
  assert.equal(launchDisposition({job:shell,run,events:[{type:'dispatch.completed',run:run.id,stage:'launching',exit_code:1}]}).disposition,'ELIGIBLE',
    'a failed dispatcher completion is not a native worker completion');
  assert.equal(launchDisposition({job:shell,run,events:[{type:'dispatch.completed',run:run.id,stage:'complete',exit_code:0}]}).disposition,'KEEP');
  assert.equal(launchDisposition({job:{...shell,error:shell.error+'\nunknown native outcome'},run}).disposition,'KEEP');
  const crash={stage:'launching',native_launch_attempted:true,error:'/node dispatch: lane: require() cannot be used on an ESM graph with top-level await.',failure:{code:'ERR_REQUIRE_ASYNC_MODULE',stage:'launching',observed_at:old}};
  for(const laneSource of [undefined,Buffer.from('unrelated source')])assert.equal(launchDisposition({job:crash,run,laneSource}).disposition,'KEEP');
});

function fixture(t){
  const f=configFixture(t,{custom:true}),org=f.env.ORG_DIR,common=gitProject(f.cwd).identity,native=f.observation.agents[0];
  fs.writeFileSync(path.join(f.cwd,'.promote.json'),JSON.stringify({to:native.name}));f.git('add','.promote.json');f.git('commit','-qm','Set actual project supervisor');
  const workspace=path.join(f.ownerRoot,'unlaunched');f.git('worktree','add','-qb','lane/original',workspace);
  const journal=path.join(org,'dispatch/original.json');fs.mkdirSync(path.dirname(journal),{recursive:true});
  const owner={controller:'brain',legacy:false,release:{id:'source',root:source,commit:null,identity:gitProject(source).identity}};
  const add=rows=>transact(org,()=>({add:rows}),{actor:native.name});
  add([{type:'item.added',id:'ENG-1',role:'engineer',title:'Original work'},
    {type:'run.started',id:'R-1',at:old,item:'ENG-1',workspace,meta:{dispatch_journal:journal,dispatch_attempt:'original',dispatch_project:common,dispatch_record:org}},
    {type:'run.claimed',run:'R-1',project:common,record:org,owner}]);
  const r=fold(loadEvents(org).events).runs.get('R-1');
  const saved={...job,run:r.id,item:r.item,token:'original',repo:f.cwd,org,common,workspace,lane:'original',base:f.git('rev-parse','HEAD'),ownership:{owner:r.owner,generation:r.owner_generation}};
  fs.writeFileSync(journal,JSON.stringify(saved));
  const id='original-launch',authorize=()=>{add([{type:'note.added',id:'ENG-1',decision:true,text:`Authorize NOT_STARTED ${id} ${journal} ${hash(fs.readFileSync(journal))}`}]);return loadEvents(org).events.at(-1).seq;};
  const decisionSeq=authorize(),calls=[];
  const call=(_exe,args)=>{calls.push(args);return JSON.stringify({result:args[1]==='list'?{agents:[native]}:{agent:native}});};
  const env={...f.env,HERDR_ENV:'1',HERDR_PANE_ID:native.pane_id,HERDR_WORKSPACE_ID:native.workspace_id,CODEX_THREAD_ID:native.agent_session.value,HERDR_BRAIN_ROOT:source};
  // Real lock protocol with deterministic offline process observations.
  const admissionLock=common=>acquireSessionCapLock(common,{kill:()=>{},readProcess:pid=>({ok:true,value:{pid,identity:'fixture birth'}})});
  const args={repo:f.cwd,org,journal,id,decisionSeq,cwd:f.cwd,env,call,admissionLock};
  return{...f,org,common,native,workspace,journal,saved,args,calls,add,authorize};
}

test('supported resolution preserves original bytes and claim, records no completion and releases capacity once',t=>{
  const f=fixture(t),bytes=fs.readFileSync(f.journal),before=fold(loadEvents(f.org).events).runs.get('R-1');
  const cap={config:{dispatch:{max_sessions:1}},org:f.org,common:f.common};
  assert.throws(()=>checkSessionCap(cap),/cap 1 reached/);
  assert.equal(inspectLaunch(f.args).disposition,'ELIGIBLE');
  const result=resolveLaunch(f.args),events=loadEvents(f.org).events,after=fold(events).runs.get('R-1');
  assert.equal(result.disposition,'NOT_STARTED');assert.equal(result.native_completion,false);
  assert.equal(after.report,null);assert.ok(after.abandoned);assert.deepEqual(after.owner,before.owner);assert.equal(after.owner_generation,before.owner_generation);
  assert.deepEqual(fs.readFileSync(f.journal),bytes);assert.deepEqual(fs.readFileSync(result.archive.file),bytes);
  assert.equal(checkSessionCap(cap).count,0);assert.equal(resolveLaunch(f.args).existing,true);
  assert.equal(loadEvents(f.org).events.filter(e=>e.type==='dispatch.launch-resolved').length,1);
  assert.ok(f.calls.every(a=>a[0]==='agent'&&['get','list'].includes(a[1])));
  assert.throws(()=>resolveLaunch({...f.args,id:'replacement'}),/existing disposition differs/);
  fs.chmodSync(result.archive.file,0o600);fs.writeFileSync(result.archive.file,'changed');
  assert.throws(()=>resolveLaunch(f.args),/archive changed/);
});

test('resolution refuses ambiguity, authority, claim, source, competing request, native and hold changes without disposition',t=>{
  const f=fixture(t),initial=loadEvents(f.org).events.length;
  const reject=args=>{assert.throws(()=>resolveLaunch({...f.args,...args}));assert.equal(loadEvents(f.org).events.some(e=>e.type==='dispatch.launch-resolved'),false);};
  reject({decisionSeq:0});reject({env:{...f.args.env,CODEX_THREAD_ID:'foreign'}});
  const stranger={...f.native,name:'other-agent'};reject({call:(_e,a)=>JSON.stringify({result:a[1]==='list'?{agents:[]}:{agent:stranger}})});
  reject({call:(_e,a)=>a[1]==='list'?JSON.stringify({error:{code:'EPERM'}}):f.args.call(_e,a)});
  reject({call:(_e,a)=>a[1]==='list'?JSON.stringify({result:{agents:[{cwd:f.workspace}]}}):f.args.call(_e,a)});
  for(const mutation of [{native_launch_attempted:true},{ownership:{...f.saved.ownership,generation:0}},{worker:{agentName:'maybe'}}]){
    fs.writeFileSync(f.journal,JSON.stringify({...f.saved,...mutation}));reject({decisionSeq:f.authorize()});
  }
  fs.writeFileSync(f.journal,JSON.stringify(f.saved));
  fs.writeFileSync(path.join(f.workspace,'unfinished'),'unsaved');reject({});fs.unlinkSync(path.join(f.workspace,'unfinished'));
  fs.writeFileSync(path.join(f.org,'dispatch/peer.json'),JSON.stringify({...f.saved,token:'peer'}));reject({});fs.unlinkSync(path.join(f.org,'dispatch/peer.json'));
  fs.mkdirSync(path.join(f.cwd,'.lane/supervisor'),{recursive:true});fs.writeFileSync(path.join(f.cwd,'.lane/supervisor/STOP'),'stop');reject({});fs.unlinkSync(path.join(f.cwd,'.lane/supervisor/STOP'));
  const changing=(_e,a)=>{const result=f.args.call(_e,a);if(a[1]==='list')fs.writeFileSync(f.journal,JSON.stringify({...f.saved,worker:{agentName:'racing'}}));return result;};
  reject({call:changing});fs.writeFileSync(f.journal,JSON.stringify(f.saved));
  f.add([{type:'item.updated',id:'ENG-1',fields:{meta:{hold:true}}}]);reject({});
  assert.equal(loadEvents(f.org).events.filter(e=>e.type==='run.abandoned').length,0);
  assert.ok(loadEvents(f.org).events.length>initial);
});
