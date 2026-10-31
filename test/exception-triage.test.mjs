import test from './helpers/bounded-test.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {initOrg,loadRecord,transact} from '../lib/store.mjs';
import {brainOwner} from '../lib/run-owner.mjs';
import {gitProject} from '../lib/project.mjs';
import {noticeLock} from '../supervisor/notice-lock.mjs';
import {enqueueSupervisor,inboxTransaction,readInbox} from '../supervisor/prompt-supervisor.mjs';
import {captureWorkerException} from '../supervisor/exception-source.mjs';
import {consumeExceptions,returnExceptionReports,checkExceptionTriage} from '../line-service/exception-triage.mjs';
import {createLineService,serviceDirectory,sourceRoot} from '../line-service/line-service.mjs';
import {checkDispatchEligibility} from '../dispatch/launch-guard.mjs';

function fixture(t){
  const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'exception-triage-'))),repo=path.join(root,'project'),org=path.join(repo,'.org');
  const oldFleet=process.env.HERDR_MONITOR_FLEET;process.env.HERDR_MONITOR_FLEET=path.join(root,'fleet.json');
  t.after(()=>{if(oldFleet===undefined)delete process.env.HERDR_MONITOR_FLEET;else process.env.HERDR_MONITOR_FLEET=oldFleet;fs.rmSync(root,{recursive:true,force:true});});
  fs.mkdirSync(repo);fs.writeFileSync(path.join(root,'.identity-root'),'fixture');
  const env={...process.env,ORG_DIR:org,ORG_ACTOR:'line-service'};for(const key of ['HERDR_ENV','HERDR_PANE_ID','HERDR_WORKSPACE_ID','CODEX_THREAD_ID','LANE_CONFIG','MONITOR_SUPERVISOR_AGENT'])delete env[key];
  const git=args=>{const r=spawnSync('git',args,{cwd:repo,env,encoding:'utf8'});assert.equal(r.status,0,r.stderr);return r.stdout.trim();};
  git(['init','-qb','main']);git(['config','user.name','Fixture']);git(['config','user.email','fixture@example.invalid']);
  fs.writeFileSync(path.join(repo,'.gitignore'),'.org/\n');fs.writeFileSync(path.join(repo,'source'),'original');
  const config={routes:{engineer:{kind:'codex'},'engineer-xhigh':{kind:'codex'},review:{kind:'claude'}}};
  fs.writeFileSync(path.join(repo,'.lane.json'),JSON.stringify(config));fs.writeFileSync(path.join(repo,'.promote.json'),JSON.stringify({to:'supervisor-test'}));
  git(['add','.']);git(['commit','-qm','Initial']);initOrg(org);
  const identity=gitProject(repo).identity,directory=serviceDirectory(org,identity),file=path.join(org,'supervisor/inbox.log');fs.mkdirSync(directory,{recursive:true});
  fs.writeFileSync(path.join(directory,'installation.json'),JSON.stringify({at:'2026-10-31T00:00:00Z',repo,org,source:sourceRoot,node:process.execPath,file:path.join(directory,'service.plist'),target:`gui/${process.getuid()}/dev.herdr.line.${path.basename(directory)}`}));
  const add=events=>transact(org,()=>({add:events})),read=()=>loadRecord(org);
  const nativeWorker={name:'original-worker',pane_id:'w1:p1',workspace_id:'w1',terminal_id:'terminal-1',agent_session:{value:'session-1'},cwd:repo};
  const supervisor={...nativeWorker,name:'supervisor-test',pane_id:'w0:p1',terminal_id:'supervisor-terminal',agent_session:{value:'supervisor-session'}};
  const source={dispatch_project:identity,dispatch_record:org,dispatch_attempt:'original-attempt',dispatch_journal:path.join(org,'dispatch/original.json')};
  const owner=brainOwner();
  add([{type:'item.added',id:'ENG-1',kind:'work',role:'engineer',title:'Original owning outcome',accept:['Retain the full owning intent.'],meta:{category:'design'}},
    {type:'run.started',id:'R-1',item:'ENG-1',workspace:repo,meta:source},
    {type:'run.claimed',run:'R-1',record:org,project:identity,owner},
    {type:'run.updated',id:'R-1',meta:{agent:nativeWorker.name,pane:nativeWorker.pane_id,worker_workspace:nativeWorker.workspace_id,terminal_id:nativeWorker.terminal_id,agent_session_id:nativeWorker.agent_session.value}},
    {type:'note.added',id:'ENG-1',text:'Existing bounded delegation; reserved actions retain their actual owner.',decision:true}]);
  const project={repo,identity,org},correlation={run:'R-1',record:org,project:identity};
  const message='[worker-question] run=R-1 item=ENG-1 worker=original-worker Which affected control proves this change?; evidence=original-report; recommendation=run only the selected affected control; held-action=check';
  const capture=(text=message)=>captureWorkerException({message:text,project,correlation,cwd:repo,env:{...env,HERDR_ENV:'1',HERDR_PANE_ID:'w1:p1',HERDR_WORKSPACE_ID:'w1'},call:()=>JSON.stringify({result:{agent:nativeWorker}})});
  const notice=(id='question-1',patch={})=>inboxTransaction(file,(_entries,append)=>append({type:'notice',id,to:'supervisor-test',message,project,correlation,recipient_role:'project-supervisor',exception:capture(),...patch}));
  const native=args=>({agent:args[2]==='supervisor-test'?supervisor:args[2]===nativeWorker.name?nativeWorker:null});
  const consume=overrides=>{const release=noticeLock(path.join(directory,'pass.lock'));try{return consumeExceptions({repo,org,env,config,supervisor:'supervisor-test',native,...overrides});}finally{release();}};
  const report=(item,outcome='done')=>{
    const reportFile=path.join(org,'runs/R-2/report.md');fs.mkdirSync(path.dirname(reportFile),{recursive:true});fs.writeFileSync(reportFile,'Bounded agent answer, cited evidence and falsifying observation.');
    const report={outcome,file:path.relative(org,reportFile),sha256:createHash('sha256').update(fs.readFileSync(reportFile)).digest('hex')};
    add([{type:'run.started',id:'R-2',item,workspace:repo,meta:{}},{type:'report.ingested',run:'R-2',id:'R-2',report,file:report.file,sha256:report.sha256}]);return report;
  };
  return {root,repo,org,env,config,identity,directory,file,git,add,read,nativeWorker,supervisor,project,correlation,message,capture,notice,native,consume,report};
}

test('source-bound question creates one ordinary finite owner and duplicates/restarted consumers retain one disposition and original transport',t=>{
  const f=fixture(t);f.notice();const before=fs.readFileSync(f.file);const first=f.consume()[0];
  assert.equal(first.disposition,'assigned');assert.equal(first.handling_ack,false);assert.equal(first.capture.source.claim_generation,f.read().state.runs.get('R-1').owner_generation);
  const item=f.read().state.items.get(first.item);assert.equal(item.role,'engineer');assert.equal(item.meta.queue_selected,true);assert.match(item.accept[0],/full owning intent|full owning/);
  assert.match(item.accept[0],/recommendation=run only/);assert.match(item.accept[0],/Agent|agent answer/);
  assert.deepEqual(fs.readFileSync(f.file),before,'intake never changes delivery, recipient, original ID or receipt');
  assert.deepEqual(f.consume(),[],'fresh finite consumer reads committed disposition after a lost reply');
  f.notice('duplicated-sender-id');const duplicate=f.consume()[0];assert.equal(duplicate.disposition,'duplicate');assert.equal(duplicate.owner,first.owner);
  assert.equal([...f.read().state.items.values()].filter(i=>i.meta.exception_triage).length,1);
  assert.equal(readInbox(f.file)[0].state,'pending');
});

test('overlapping finite consumers recheck the committed disposition under the existing record lock',t=>{
  const f=fixture(t);f.notice();const release=noticeLock(path.join(f.directory,'pass.lock'));let raced=false;
  try{
    const args={repo:f.repo,org:f.org,env:f.env,config:f.config,supervisor:'supervisor-test'};
    const outer=consumeExceptions({...args,native:command=>{if(!raced){raced=true;consumeExceptions({...args,native:f.native});}return f.native(command);}});
    assert.equal(outer.length,0);
  }finally{release();}
  assert.equal([...f.read().state.items.values()].filter(i=>i.meta.exception_triage).length,1);
});

test('a distinct incident cannot acquire a second finite owner while the original owner is live',t=>{
  const f=fixture(t);f.notice();const original=f.consume()[0];
  const run=f.read().state.runs.get('R-1');f.add([{type:'run.claimed',run:'R-1',record:f.org,project:f.identity,owner:run.owner}]);
  f.notice('new-claim-incident');const second=f.consume()[0];assert.equal(second.disposition,'custodian');assert.match(second.reason,/cap1/);
  assert.equal([...f.read().state.items.values()].filter(i=>i.meta.exception_triage).length,1);assert.equal(f.read().state.items.get(original.item).closed,null);
});

for(const [name,alter,pattern]of [
  ['changed claim',f=>{const r=f.read().state.runs.get('R-1');f.add([{type:'run.claimed',run:'R-1',record:f.org,project:f.identity,owner:r.owner}]);},/claim\/source changed/],
  ['changed source',f=>fs.writeFileSync(path.join(f.repo,'source'),'changed'),/source\/policy changed/],
  ['changed policy',f=>fs.writeFileSync(path.join(f.repo,'.promote.json'),JSON.stringify({to:'other'})),/source\/policy changed/],
  ['changed intent',f=>f.add([{type:'item.updated',id:'ENG-1',fields:{title:'New outcome'}}]),/intent\/run changed/],
  ['held subject',f=>f.add([{type:'item.updated',id:'ENG-1',fields:{meta:{hold:true}}}]),/intent\/run changed|held\/reserved/],
  ['reserved question',f=>f.add([{type:'item.updated',id:'ENG-1',fields:{meta:{operator_reserved:true}}}]),/intent\/run changed|reserved/],
  ['expired requester',f=>{f.nativeWorker.agent_session={value:'replacement'};},/expired or changed/],
  ['missing supervisor',f=>{f.supervisor.name='';},/binding is missing/],
  ['UNKNOWN prompt',f=>inboxTransaction(f.file,(_e,append)=>append({type:'sending',id:'question-1',occupant:'original'})),/UNKNOWN\/refused/],
  ['native refusal',f=>inboxTransaction(f.file,(_e,append)=>append({type:'autopilot',id:'question-1',result:{disposition:'handled',undeliverable:{reason:'native-refused'}}})),/UNKNOWN\/refused/],
])test(`finite intake preserves ${name} with the recovery custodian and zero new owner`,t=>{
  const f=fixture(t);f.notice();alter(f);const before=fs.readFileSync(f.file),result=f.consume()[0];
  assert.equal(result.disposition,'custodian');assert.equal(result.owner,'supervisor-test');assert.match(result.reason,pattern);
  assert.equal([...f.read().state.items.values()].filter(i=>i.meta.exception_triage).length,0);assert.deepEqual(fs.readFileSync(f.file),before);
  assert.deepEqual(f.consume(),[],'no idle-tick replacement');
});

test('malformed and legacy questions remain unproven; routine done and reserved operator notices never create triage',t=>{
  const f=fixture(t);f.notice('malformed',{message:'[worker-question] incomplete',exception:{unproven:'missing tuple'}});f.notice('legacy',{exception:undefined});
  f.notice('routine',{message:'[done] ordinary report'});f.notice('reserved',{message:'[operator-ask] question=HUM-1'});
  const results=f.consume();assert.equal(results.length,2);assert.ok(results.every(r=>r.disposition==='custodian'));
  assert.equal([...f.read().state.items.values()].filter(i=>i.meta.exception_triage).length,0);
  assert.ok(f.capture('[worker-question] bad').unproven);
});

test('a question without a recommendation and a dispatcher without its configured route stay custodian-owned',t=>{
  const f=fixture(t);f.notice('no-recommendation',{message:f.message.replace('recommendation=','proposed ')});
  assert.match(f.consume()[0].reason,/recommendation/);
  const run=f.read().state.runs.get('R-1');f.add([{type:'run.claimed',run:'R-1',record:f.org,project:f.identity,owner:run.owner}]);
  f.notice('no-dispatcher');const d=f.consume({config:{routes:{}}})[0];assert.equal(d.disposition,'custodian');assert.match(d.reason,/route/);
});

test('substantiated idle diagnostics reuse the existing halt owner while unrelated alarms retain the native custodian',t=>{
  const f=fixture(t);f.add([{type:'item.added',id:'ENG-2',kind:'work',role:'engineer',title:'Existing idle repair',meta:{halt_repair:1}}]);
  const diagnostics={idle:{inspection_due:true,boundary:'halt-repair',reason:'completed idle passes',scope:{item:'ENG-1'}},native:{inspection_due:true,boundary:'closeout:native',reason:'native refusal',scope:{run:'R-1'}}};
  const result=f.consume({diagnostics,audit:path.join(f.directory,'passes.jsonl')});assert.equal(result.length,2);
  assert.equal(result[0].disposition,'existing-halt-owner');assert.equal(result[0].owner,'ENG-2');assert.equal(result[1].owner,'supervisor-test');
  assert.deepEqual(f.consume({diagnostics}),[]);assert.equal([...f.read().state.items.values()].filter(i=>i.meta.exception_triage).length,0);
});

for(const flag of ['STOP','HOLD'])test(`${flag} fences the finite consumer without a disposition or input`,t=>{
  const f=fixture(t);f.notice();fs.mkdirSync(path.join(f.repo,'.lane/supervisor'),{recursive:true});fs.writeFileSync(path.join(f.repo,'.lane/supervisor',flag),'held');
  assert.throws(()=>f.consume(),/STOP\/HOLD/);assert.equal(f.read().events.some(e=>e.type==='supervisor.exception-disposition'),false);
});

test('native launch and prompt guards reject a stale triage tuple, and an UNKNOWN dispatch is never replaced',t=>{
  const f=fixture(t);f.notice();const d=f.consume()[0],item=f.read().state.items.get(d.item);
  checkExceptionTriage(item,{...f.read(),repo:f.repo,org:f.org,identity:f.identity});
  const job={org:f.org,repo:f.repo,item:d.item,common:f.identity,token:'triage-original',lane:'triage'};
  for(const boundary of ['launch','prompt'])assert.doesNotThrow(()=>checkDispatchEligibility(job,'/original',{boundary}));
  f.add([{type:'run.started',id:'R-2',item:d.item,workspace:f.repo,meta:{dispatch_project:f.identity,lane:'triage',dispatch_journal:'/retained-UNKNOWN'}}]);
  assert.throws(()=>checkDispatchEligibility(job,'/replacement'),/already has open run/);
  fs.writeFileSync(path.join(f.repo,'source'),'changed');
  for(const boundary of ['launch','prompt'])assert.throws(()=>checkDispatchEligibility(job,'/original',{boundary}),/exception source\/policy changed/);
});

test('finite answer returns one immutable pointer to the original requesting item and worker inbox across restart',t=>{
  const f=fixture(t);f.notice();const d=f.consume()[0];f.report(d.item);
  const deliver=()=>{const release=noticeLock(path.join(f.directory,'pass.lock'));try{return returnExceptionReports({repo:f.repo,org:f.org,env:f.env,enqueue:r=>enqueueSupervisor(r.to,r.message,{id:r.id,org:f.org,cwd:f.repo,correlation:r.correlation})});}finally{release();}};
  const first=deliver();assert.equal(first.length,1);assert.equal(first[0].to,'original-worker');
  inboxTransaction(f.file,(_e,append)=>append({type:'sending',id:first[0].id,occupant:'retained'}));
  const bytes=fs.readFileSync(f.file);deliver();assert.deepEqual(fs.readFileSync(f.file),bytes,'UNKNOWN answer input is retained, not replayed');
  const events=f.read().events;assert.equal(events.filter(e=>e.type==='supervisor.exception-return').length,1);assert.equal(events.filter(e=>e.type==='note.added'&&e.text.startsWith('Finite exception')).length,1);
  assert.equal(readInbox(f.file).find(e=>e.id===first[0].id).state,'uncertain');
  assert.equal(f.read().state.items.get('ENG-1').closed,null);assert.equal(f.read().state.runs.get('R-1').report,null);
});

test('a stale or unresolved answer retains its original report and custodian without returning input or reopening work',t=>{
  const f=fixture(t);f.notice();const d=f.consume()[0];f.report(d.item,'blocked');let input=0;
  const release=noticeLock(path.join(f.directory,'pass.lock'));
  try{assert.deepEqual(returnExceptionReports({repo:f.repo,org:f.org,env:f.env,enqueue:()=>input++}),[]);}finally{release();}
  const result=f.read().events.find(e=>e.type==='supervisor.exception-return');assert.equal(result.owner,'supervisor-test');assert.equal(result.disposition,'custodian');assert.equal(input,0);
});

test('a torn inbox remains byte-for-byte retained without a synthetic disposition',t=>{
  const f=fixture(t);f.notice();fs.appendFileSync(f.file,'{"type":');const bytes=fs.readFileSync(f.file);
  assert.throws(()=>f.consume(),/torn inbox tail/);assert.deepEqual(fs.readFileSync(f.file),bytes);
  assert.equal(f.read().events.some(e=>e.type==='supervisor.exception-disposition'),false);
});

test('normal line admission keeps a refused triage dispatch once, cap1 and no recursive repair or retired judge',t=>{
  const f=fixture(t);f.notice();const calls=[];
  const command=(_exe,args)=>{
    calls.push(args);
    if(args[0]==='agent'&&args[1]==='get')return {status:0,stdout:JSON.stringify({result:f.native(args)})};
    return {status:1,stdout:'',stderr:'native refusal; original attempt retained'};
  };
  const service=()=>createLineService({repo:f.repo,org:f.org,to:'brain-chat',env:f.env,command,capacity:()=>({count:1,cap:7,sessions:[{kind:'worker',occupancy:'observed live',runs:['R-1']}]}),haltAfter:100});
  service().pass();const item=[...f.read().state.items.values()].find(i=>i.meta.exception_triage);assert.ok(item);
  service().pass();service().pass();
  assert.equal(calls.filter(a=>a[0]===path.join(sourceRoot,'dispatch/dispatch.mjs')&&a[1]===item.id).length,1);
  assert.equal([...f.read().state.items.values()].filter(i=>i.meta.exception_triage).length,1);assert.equal([...f.read().state.items.values()].filter(i=>i.role==='decision').length,0);
});
