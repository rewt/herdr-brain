import test from '../../test/helpers/bounded-test.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {EventEmitter} from 'node:events';
import {enqueueSupervisor,readInbox} from '../../supervisor/prompt-supervisor.mjs';
import {digest} from '../shared.mjs';
import {fixture as workerFixture} from './step-fixture.mjs';
import {transact,loadRecord} from '../../lib/store.mjs';
import {sessionBindFact} from '../../test/helpers/session-bind.mjs';
import {createObserver,SAFETY_RECONCILIATION_MS} from '../observer.mjs';
import {sharedDirectory,stepFile,nativeBinding,observerReceipt} from '../shared.mjs';
import {gitProject} from '../../lib/project.mjs';

const source=path.resolve(import.meta.dirname,'../..');
function fixture(t,{count=1,consume,alive=()=>false,timers=globalThis}={}){
  const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'run-observer-'))),repo=path.join(root,'project'),org=path.join(repo,'.org'),socket=path.join(root,'socket');
  fs.mkdirSync(repo);fs.mkdirSync(org);fs.writeFileSync(socket,'original server');
  const fleet=process.env.HERDR_MONITOR_FLEET;process.env.HERDR_MONITOR_FLEET=path.join(root,'fleet');
  const git=(...args)=>{const r=spawnSync('git',args,{cwd:repo,encoding:'utf8'});assert.equal(r.status,0,r.stderr);return r.stdout.trim();};
  git('init','-qb','main');const project=gitProject(repo),rows=[],calls=[],record=new Map(),duties=[],agents=[];
  const ownership={owner:{controller:'brain',legacy:false,release:{id:'source',commit:null,root:source,identity:project.identity}},generation:2};
  fs.mkdirSync(sharedDirectory(org),{recursive:true});fs.mkdirSync(path.dirname(stepFile(org,'R-1')),{recursive:true});
  for(let i=1;i<=count;i++){
    const run=`R-${i}`,native={name:`worker-${i}`,pane_id:`w1:p${i}`,workspace_id:'w1',terminal_id:`term-${i}`,agent_session:{value:`session-${i}`},cwd:repo,
      agent_status:'working',state_change_seq:5,completion_seq:0};agents.push(native);
    const d={schema:'brain.shared-watch/v1',run,org,repo,project:project.identity,cwd:repo,source,ownership,native:nativeBinding(native),
      report:path.join(root,`${run}.md`),to:'supervisor-test',argv:[run,'--org',org,'--cwd',repo,'--to','supervisor-test'],
      consumer:'watch/watch.mjs --step',wake_fact:'native lifecycle, report/record change or coarse-safety-reconciliation',stuck_owner:'supervisor-test'};
    duties.push(d);fs.writeFileSync(path.join(sharedDirectory(org),run+'.json'),JSON.stringify(d));record.set(run,{generation:2,owner:ownership.owner,report:null,abandoned:null,
      workspace:repo,meta:{agent:native.name,pane:native.pane_id,worker_workspace:native.workspace_id,terminal_id:native.terminal_id,agent_session_id:native.agent_session.value}});
  }
  let clock=100_000;
  class Client extends EventEmitter{
    subscriptions=[];available=true;refresh;
    async snapshot(){if(this.refresh)await this.refresh();if(!this.available)throw Error('server unavailable');return structuredClone({protocol:22,version:'fixture',agents,panes:agents.map(a=>({pane_id:a.pane_id}))});}
    subscribe(s){this.subscriptions.push(s);}
    close(){}
  }
  const client=new Client();let observer;
  const save=(run,phase='waiting',extra={})=>fs.writeFileSync(stepFile(org,run),JSON.stringify({phase,ownership,next_at:null,...extra}));
  const build=()=>observer=createObserver({repo,org,socket,client,timers,notify:(to,message,options)=>({...enqueueSupervisor(to,message,options),queued:true,delivered:false}),now:()=>clock,subjects:()=>record,log:r=>rows.push(r),alive,
    consume:async d=>{calls.push(d.run);if(consume)return consume(d,{save,observer});save(d.run);return{code:0};}});
  build();
  t.after(async()=>{await observer.close();if(fleet===undefined)delete process.env.HERDR_MONITOR_FLEET;else process.env.HERDR_MONITOR_FLEET=fleet;fs.rmSync(root,{recursive:true,force:true});});
  return {repo,org,socket,project,client,agents,duties,rows,calls,record,save,build,get observer(){return observer;},advance:ms=>clock+=ms};
}
async function drain(f){await f.observer.idle();await new Promise(resolve=>setImmediate(resolve));await f.observer.idle();}

test('observer resolves a session-less original duty only after run.session_bound and refuses replacement counters',async t=>{
  const f=workerFixture(t,{sessionless:true}),rows=[];
  class Client extends EventEmitter{async snapshot(){return {protocol:22,agents:[f.getNative()],panes:[{pane_id:f.native.pane_id}]};}subscribe(){}close(){}}
  const observer=createObserver({repo:f.repo,org:f.org,client:new Client(),consume:()=>({code:f.step().status}),log:r=>rows.push(r)});
  t.after(()=>observer.close());const original=fs.readFileSync(path.join(sharedDirectory(f.org),'R-1.json'));
  await observer.reconcile('registration');await observer.idle();
  assert.equal(rows.findLast(r=>r.action==='observation').bound,false);assert.equal(f.state().phase,'waiting');
  assert.equal(f.prompt().status,0);await observer.reconcile('prompt');await observer.idle();
  assert.equal(rows.findLast(r=>r.action==='observation').bound,false,'native session alone is not the recorded binding');
  const {state}=loadRecord(f.org),session=f.getNative().agent_session.value;
  transact(f.org,()=>({add:[sessionBindFact(state.runs.get('R-1'),state,{session})]}));
  await observer.reconcile('record-binding');await observer.idle();
  const bound=rows.findLast(r=>r.action==='observation');assert.equal(bound.bound,true);assert.equal(bound.state_change_seq,1);
  assert.equal(bound.record.meta.agent_session_id,session);assert.equal(bound.record.meta.identity_conflict,false);
  f.setNative({...f.getNative(),agent_session:{value:'replacement'},state_change_seq:99});
  await observer.reconcile('replacement');await observer.idle();
  const refused=rows.findLast(r=>r.action==='observation');assert.equal(refused.bound,false);assert.equal(refused.state_change_seq,null);
  assert.equal(f.state().phase,'waiting');assert.equal(observer.counters.consumer_failures,0);
  f.setNative({...f.getNative(),agent_session:{value:session},state_change_seq:2});
  await observer.reconcile('original-restored');await observer.idle();
  assert.equal(rows.findLast(r=>r.action==='observation').bound,true);assert.equal(f.state().state.observedWorking,true);
  assert.deepEqual(fs.readFileSync(path.join(sharedDirectory(f.org),'R-1.json')),original);
});

test('one observer binds counters and consumes duplicate/reversed hints once without per-run residents',async t=>{
  const f=fixture(t,{count:8});await f.observer.reconcile('startup');await drain(f);
  assert.equal(f.calls.length,8);f.calls.length=0;
  f.agents[0].agent_status='blocked';f.agents[0].state_change_seq=6;
  for(let i=0;i<10;i++)f.client.emit('event',{event:'pane.agent_status_changed',data:{pane_id:'w1:p1',state_change_seq:1}});
  await drain(f);assert.deepEqual(f.calls,['R-1']);
  const bound=f.rows.findLast(r=>r.action==='observation'&&r.run==='R-1');
  assert.equal(bound.state_change_seq,6);assert.equal(bound.native.session,'session-1');assert.equal(bound.claim,2);assert.ok(bound.server);
  assert.equal(f.observer.counters.repairs,0);assert.ok(f.rows.every(r=>r.active===undefined||r.active<=2));
});

test('lost final native and file hints recover with no later event at the named coarse bound',async t=>{
  const f=fixture(t);await f.observer.reconcile('startup');await drain(f);f.calls.length=0;
  fs.writeFileSync(f.duties[0].report,'a final report');f.agents[0].agent_status='done';f.agents[0].state_change_seq=7;f.agents[0].completion_seq=7;
  f.advance(SAFETY_RECONCILIATION_MS);await f.observer.tick();await drain(f);
  assert.deepEqual(f.calls,['R-1']);assert.equal(f.observer.counters.repairs,1);
  const repair=f.rows.find(r=>r.action==='safety-repair');assert.equal(repair.current.completion_seq,7);
  await f.observer.tick();await drain(f);assert.equal(f.calls.length,1);
  t.diagnostic(JSON.stringify({witness:'lost-final-hint',recovery_ms:SAFETY_RECONCILIATION_MS,repairs:1,handoffs:1,lost:0,duplicate:0}));
});

test('events during authoritative refresh invalidate it and subscription readiness requires acknowledgement',async t=>{
  const f=fixture(t);let first=true;
  f.client.refresh=async()=>{if(first){first=false;f.client.emit('event',{event:'pane.agent_status_changed',data:{}});}};
  await f.observer.reconcile('startup');await drain(f);
  assert.ok(f.observer.counters.reconciliations>=2);assert.equal(f.rows.findLast(r=>r.action==='reconciled').ready,false);
  f.client.emit('ready');await drain(f);assert.equal(f.rows.findLast(r=>r.action==='reconciled').ready,true);
  f.client.emit('connectionError',Error('invalid pane rejects the entire set'));f.agents.length=0;
  await f.observer.reconcile('rejected');await drain(f);
  assert.equal(f.rows.findLast(r=>r.action==='reconciled').ready,false);
  assert.ok(f.client.subscriptions.at(-1).every(s=>!s.pane_id));
  assert.equal(f.rows.findLast(r=>r.action==='observation').bound,false);
});

test('server replacement resets the observation boundary and never attributes counters to a new occupant',async t=>{
  const f=fixture(t);await f.observer.reconcile('startup');await drain(f);
  const before=f.rows.findLast(r=>r.action==='observation').server;
  fs.renameSync(f.socket,f.socket+'.old');fs.writeFileSync(f.socket,'replacement server');
  f.agents[0].state_change_seq=1;f.agents[0].agent_session.value='replacement session';
  f.client.emit('disconnected');await drain(f);
  const after=f.rows.findLast(r=>r.action==='observation');assert.notEqual(after.server,before);assert.equal(after.bound,false);assert.equal(after.state_change_seq,null);
  f.client.available=false;await f.observer.reconcile('unavailable');await drain(f);
  assert.equal(f.rows.findLast(r=>r.action==='observation').unavailable,'server unavailable');
});

test('host restart retains live finite owner then reconstructs the same duty after proven death',async t=>{
  let live=true;const f=fixture(t,{alive:()=>live});f.save('R-1','running',{pid:88,identity:'original birth'});
  await f.observer.reconcile('startup');await drain(f);assert.equal(f.calls.length,0);
  await f.observer.close();live=false;f.build();await f.observer.reconcile('startup');await drain(f);
  assert.deepEqual(f.calls,['R-1']);assert.equal(f.duties[0].native.session,'session-1');
});

test('finite consumer failure remains held across observer restart and cannot be replaced by a new registration',async t=>{
  const f=fixture(t,{consume:async()=>({code:1})});await f.observer.reconcile('startup');await drain(f);
  assert.equal(f.calls.length,1);assert.equal(f.observer.counters.consumer_failures,1);
  await f.observer.close();f.build();await f.observer.reconcile('startup');await drain(f);assert.equal(f.calls.length,1);
  const file=path.join(sharedDirectory(f.org),'R-1.json'),d=JSON.parse(fs.readFileSync(file));d.to='alternate';fs.writeFileSync(file,JSON.stringify(d));
  await f.observer.reconcile('changed');await drain(f);assert.equal(f.calls.length,1);
  assert.equal(readInbox(path.join(f.org,'supervisor/inbox.log')).length,1);
});

test('STOP and HOLD retain every saved duty and do not begin a finite consumer',async t=>{
  const f=fixture(t);fs.mkdirSync(path.join(f.repo,'.lane/supervisor'),{recursive:true});
  for(const name of ['STOP','HOLD']){
    const file=path.join(f.repo,'.lane/supervisor',name);fs.writeFileSync(file,'original hold');
    assert.deepEqual(await f.observer.reconcile('held'),{held:true});assert.equal(f.calls.length,0);fs.unlinkSync(file);
  }
  await f.observer.reconcile('startup');await drain(f);assert.equal(f.calls.length,1);assert.ok(fs.existsSync(path.join(sharedDirectory(f.org),'R-1.json')));
});

test('observer receipts reject PID reuse and a different project/server/source without fallback',t=>{
  const f=fixture(t),directory=path.join(f.org,'watch/observer');
  const saved={org:f.org,repo:f.repo,project:f.project.identity,source,socket:f.socket,pid:77,identity:'original'};
  fs.writeFileSync(path.join(directory,'owner.json'),JSON.stringify(saved));
  const expected={repo:f.repo,project:f.project.identity,source,socket:f.socket};
  assert.equal(observerReceipt(f.org,expected,()=>true).pid,77);
  assert.throws(()=>observerReceipt(f.org,expected,()=>false),/matching live/);
  assert.throws(()=>observerReceipt(f.org,{...expected,socket:'foreign'},()=>true),/matching live/);
});

for(const variant of ['foreign source','changed held digest','step ownership','redirected registration','oversized registration','malformed registration'])test('correction isolates '+variant+' at host startup and retains one durable owner exception',async t=>{
  const f=fixture(t,{count:2}),bad=path.join(sharedDirectory(f.org),'R-1.json'),held=path.join(f.observer.directory,'held/R-1.json');
  if(variant==='foreign source'){const d={...f.duties[0],source:source+'/older-release'};fs.writeFileSync(bad,JSON.stringify(d));}
  if(variant==='changed held digest'){
    fs.writeFileSync(held,JSON.stringify({run:'R-1',registration:digest(f.duties[0]),stuck_owner:'supervisor-test',reason:'original consumer failure'}));
    fs.writeFileSync(bad,JSON.stringify({...f.duties[0],to:'changed-recipient'}));
  }
  if(variant==='step ownership')f.save('R-1','waiting',{ownership:{...f.duties[0].ownership,generation:999}});
  if(variant==='redirected registration'){fs.renameSync(bad,bad+'.original');fs.symlinkSync(bad+'.original',bad);}
  // Unreadable metadata routes to the committed project supervisor.
  if(['redirected registration','oversized registration','malformed registration'].includes(variant)){
    fs.writeFileSync(path.join(f.repo,'.promote.json'),JSON.stringify({to:'supervisor-test'}));
    assert.equal(spawnSync('git',['add','.promote.json'],{cwd:f.repo}).status,0);
    assert.equal(spawnSync('git',['-c','user.name=Test','-c','user.email=test@example.invalid','commit','-qm','fixture supervisor'],{cwd:f.repo}).status,0);
  }
  if(variant==='malformed registration')fs.writeFileSync(bad,'{broken original JSON');
  if(variant==='oversized registration')fs.writeFileSync(bad,' '.repeat(1024*1024+1));
  const original=fs.readFileSync(bad),originalHeld=fs.existsSync(held)?fs.readFileSync(held):null;
  await f.observer.start();await drain(f);assert.deepEqual(f.calls,['R-2']);
  assert.equal(f.observer.counters.consumer_failures,0);assert.equal(fs.existsSync(path.join(f.observer.directory,'held/R-2.json')),false);
  if(originalHeld)assert.deepEqual(fs.readFileSync(held),originalHeld);
  const savedHeld=fs.readFileSync(held),inbox=path.join(f.org,'supervisor/inbox.log');
  const notices=readInbox(inbox);assert.equal(notices.length,1);assert.equal(notices[0].to,'supervisor-test');assert.equal(notices[0].recipient_role,'project-supervisor');
  assert.equal(notices[0].id,'watch-observer:R-1:held');
  await f.observer.close();f.build();await f.observer.start();await drain(f);
  assert.deepEqual(fs.readFileSync(bad),original);assert.deepEqual(fs.readFileSync(held),savedHeld);assert.equal(readInbox(inbox).length,1);
  f.agents[1].agent_status='blocked';f.agents[1].state_change_seq++;f.client.emit('event',{event:'pane.agent_status_changed',data:{}});await drain(f);
  assert.deepEqual(f.calls,['R-2','R-2','R-2']);
});

test('correction deadline wait arms one earliest timer and re-arms on hints without polling step files',async t=>{
  const timers={pending:new Map(),delays:[],setTimeout(fn,ms){const id=Symbol();this.pending.set(id,fn);this.delays.push(ms);return id;},clearTimeout(id){this.pending.delete(id);}};
  const f=fixture(t,{timers,consume:async(d,{save})=>{save(d.run,'waiting',{next_at:120000});return {code:0};}});
  await f.observer.reconcile('startup');await drain(f);assert.equal(f.observer.nextDelay(),20000);
  const waiting=f.observer.wait();assert.deepEqual(timers.delays,[20000]);assert.equal(timers.pending.size,1);
  f.agents[0].state_change_seq++;f.client.emit('event',{event:'pane.agent_status_changed',data:{}});await drain(f);
  assert.equal(await waiting,'changed');assert.equal(timers.pending.size,0);
  const second=f.observer.wait();assert.equal(timers.pending.size,1);f.observer.interrupt();assert.equal(await second,'stop');assert.equal(timers.pending.size,0);
  const row=f.rows.findLast(r=>r.action==='reconciled');assert.ok(row.cpu_usage_us.user>=0);assert.ok(row.reconciliations_per_second>0);
});

for(const changed of [false,true])test('correction original finite consumer survives '+(changed?'changed held digest':'foreign source')+' through host startup and restart',async t=>{
  const f=workerFixture(t),directory=path.join(f.org,'watch/observer'),bad=path.join(sharedDirectory(f.org),'R-2.json'),held=path.join(directory,'held/R-2.json');
  fs.mkdirSync(path.dirname(held),{recursive:true});
  const good=JSON.parse(fs.readFileSync(path.join(sharedDirectory(f.org),'R-1.json'))),d={...good,run:'R-2',argv:['R-2',...good.argv.slice(1)]};
  if(changed){
    fs.writeFileSync(held,JSON.stringify({run:'R-2',registration:digest(d),reason:'original failure',stuck_owner:d.stuck_owner}));
    d.to='changed';
  }else d.source+='/foreign-release';
  fs.writeFileSync(bad,JSON.stringify(d));const original=fs.readFileSync(bad);
  class Client extends EventEmitter{async snapshot(){return {protocol:22,agents:[f.native],panes:[{pane_id:f.native.pane_id}]};}subscribe(){}close(){}}
  const build=()=>createObserver({repo:f.repo,org:f.org,client:new Client(),
    notify:(to,message,options)=>({...enqueueSupervisor(to,message,options),queued:true,delivered:false})});
  let observer=build();t.after(()=>observer.close());
  await observer.start();await observer.idle();assert.equal(f.state().phase,'waiting');assert.equal(observer.counters.consumer_starts,1);assert.equal(observer.counters.consumer_failures,0);
  const savedHeld=fs.readFileSync(held);assert.equal(fs.existsSync(path.join(directory,'held/R-1.json')),false);
  const inbox=path.join(f.org,'supervisor/inbox.log');assert.equal(readInbox(inbox).length,1);assert.equal(readInbox(inbox)[0].to,d.stuck_owner);
  await observer.close();observer=build();await observer.start();await observer.idle();
  assert.equal(observer.counters.consumer_starts,1);assert.deepEqual(fs.readFileSync(bad),original);assert.deepEqual(fs.readFileSync(held),savedHeld);
  assert.equal(readInbox(inbox).length,1);
});

test('correction original finite consumer preserves a real native-binding failure and one durable exception',async t=>{
  const f=workerFixture(t,{lateSession:true}),state=loadRecord(f.org).state;
  const fact=sessionBindFact(state.runs.get('R-1'),state,{session:f.native.agent_session.value});
  transact(f.org,()=>({add:[fact,{...fact,session:'replacement-session'}]}));
  class Client extends EventEmitter{async snapshot(){return {protocol:22,agents:[f.native],panes:[{pane_id:f.native.pane_id}]};}subscribe(){}close(){}}
  const observer=createObserver({repo:f.repo,org:f.org,client:new Client(),
    notify:(to,message,options)=>({...enqueueSupervisor(to,message,options),queued:true,delivered:false})});
  t.after(()=>observer.close());await observer.start();await observer.idle();
  assert.equal(f.state().phase,'failed');assert.equal(observer.counters.consumer_failures,1);
  const held=path.join(observer.directory,'held/R-1.json'),original=fs.readFileSync(held);
  await observer.reconcile('hint');await observer.idle();assert.deepEqual(fs.readFileSync(held),original);
  assert.equal(observer.counters.consumer_starts,1);assert.equal(readInbox(path.join(f.org,'supervisor/inbox.log')).length,1);
});

test('shared watch observer follows the line STOP and installed-source boundaries without changing duties',async t=>{
  const f=fixture(t),directory=path.join(f.org,'line-service',digest(f.project.identity).slice(0,20));
  fs.mkdirSync(directory,{recursive:true});const original=fs.readFileSync(path.join(sharedDirectory(f.org),'R-1.json'));
  const stop=path.join(directory,'STOP');fs.writeFileSync(stop,'Line stopped');
  assert.equal(f.observer.stoppedByProject(),true);assert.deepEqual(await f.observer.reconcile('held'),{held:true});
  fs.unlinkSync(stop);assert.equal(f.observer.stoppedByProject(),false);
  fs.writeFileSync(path.join(directory,'installation.json'),JSON.stringify({source:'/successor-build'}));
  assert.equal(f.observer.stoppedByProject(),true);assert.equal(f.calls.length,0);
  assert.deepEqual(fs.readFileSync(path.join(sharedDirectory(f.org),'R-1.json')),original);
});
