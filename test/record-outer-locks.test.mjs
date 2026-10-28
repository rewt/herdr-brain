import test from './helpers/bounded-test.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import observed, {captureReads,observeGit} from '../lib/record-observation.mjs';
import {gitProject} from '../lib/project.mjs';
import {initOrg,transact,loadEvents,withLock,prepareRecordGuard,withRecordGuard} from '../lib/store.mjs';
import {claimRun,fenceOwner} from '../lib/run-owner.mjs';
import {ownWorktreeGuard} from '../promote/own-worktree.mjs';
import {preparePromotionGuard,withPromotionGuards} from '../promote/guard.mjs';
import {fixtureFleet} from './helpers/offline-herdr.mjs';
import {recordOwnLanding} from '../lib/landing-receipt.mjs';

function fixture(t,{git=false}={}) {
  const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'record-outer-'))),org=path.join(root,'.org'),lock=path.join(org,'lock');
  fixtureFleet(t,root);t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  initOrg(org);
  const exec=args=>{const r=spawnSync('git',['-C',root,...args],{encoding:'utf8'});assert.equal(r.status,0,r.stderr);return r.stdout.trim();};
  if(git){exec(['init','-qb','main']);exec(['config','user.name','Fixture']);exec(['config','user.email','fixture@example.invalid']);fs.writeFileSync(path.join(root,'.git/info/exclude'),'.org/\n');fs.writeFileSync(path.join(root,'.identity-root'),'fixture');exec(['add','.']);exec(['commit','-qm','Fixture']);}
  return {root,org,lock,file:path.join(org,'events.jsonl'),git:exec};
}
function atLock(t,f,action) {
  const mkdir=fs.mkdirSync;
  fs.mkdirSync=function(file,...args){const result=mkdir.call(this,file,...args);if(file===f.lock)action();return result;};
  t.after(()=>{fs.mkdirSync=mkdir;});
}

test('outer preparation runs outside the lock and its single effect retains the lock',t=>{
  const f=fixture(t);let checks=0,effects=0;
  const fence=prepareRecordGuard(f.org,()=>{checks++;assert.equal(fs.existsSync(f.lock),false);return 42;});
  assert.equal(fence.run(value=>{effects++;assert.equal(fs.existsSync(f.lock),true);return value;}),42);
  assert.throws(()=>fence.run(()=>effects++),/already used/);assert.equal(checks,1);assert.equal(effects,1);
});
for(const kind of ['claim','hold','unknown','replacement'])test(`outer source fence refuses a late ${kind} without replaying authority`,t=>{
  const f=fixture(t);let checks=0,effects=0;
  const fence=prepareRecordGuard(f.org,()=>{checks++;});
  atLock(t,f,()=>{if(kind==='replacement')fs.renameSync(f.file,f.file+'.old');fs.writeFileSync(f.file,JSON.stringify({seq:1,type:kind==='claim'?'run.claimed':kind==='hold'?'item.updated':'future.unknown'})+'\n');});
  assert.throws(()=>fence.run(()=>effects++),/guard conflict/);assert.equal(checks,1);assert.equal(effects,0);
});
for(const kind of ['create','replace','symlink'])test(`outer file fence refuses a late ${kind} of a STOP or policy input`,t=>{
  const f=fixture(t),input=path.join(f.root,'STOP');if(kind!=='create')fs.writeFileSync(input,'old');
  const fence=prepareRecordGuard(f.org,()=>{if(observed.existsSync(input))observed.readFileSync(input);});
  atLock(t,f,()=>{if(kind!=='create')fs.renameSync(input,input+'.old');if(kind==='symlink')fs.symlinkSync(input+'.old',input);else fs.writeFileSync(input,'new');});
  assert.throws(()=>fence.run(()=>assert.fail('stale effect')),/observation conflict/);
});
test('outer native refusal stops before lock acquisition and is never replayed',t=>{
  const f=fixture(t);let checks=0;
  atLock(t,f,()=>assert.fail('must not acquire'));
  assert.throws(()=>withRecordGuard(f.org,()=>{checks++;throw Error('native refusal');},()=>assert.fail('effect')),/native refusal/);assert.equal(checks,1);
});
test('dead positive PID is reclaimed immediately and a crashed reclaimer can itself be recovered',t=>{
  const f=fixture(t),kill=process.kill,dead=400001;
  process.kill=(pid,signal)=>{if(pid===dead)throw Object.assign(Error('gone'),{code:'ESRCH'});return kill(pid,signal);};t.after(()=>{process.kill=kill;});
  fs.mkdirSync(f.lock);fs.writeFileSync(path.join(f.lock,'pid'),String(dead));
  const reap=path.join(f.lock,'reap');fs.mkdirSync(reap);fs.writeFileSync(path.join(reap,'pid'),String(dead));
  assert.equal(withLock(f.org,()=>123,{timeoutMs:1000}),123);assert.equal(fs.existsSync(f.lock),false);
});
for(const kind of ['live','EPERM','missing','malformed','negative'])test(`lock recovery preserves ${kind} ownership even after a long wait`,t=>{
  const f=fixture(t),kill=process.kill,now=Date.now,wait=Atomics.wait;let elapsed=0;
  fs.mkdirSync(f.lock);if(kind!=='missing')fs.writeFileSync(path.join(f.lock,'pid'),kind==='malformed'?'1junk':kind==='negative'?'-1':String(process.pid));
  const start=now();Date.now=()=>start+elapsed;Atomics.wait=()=>{elapsed+=1000000;};
  process.kill=kind==='EPERM'?()=>{throw Object.assign(Error('refused'),{code:'EPERM'});}:kill;
  t.after(()=>{process.kill=kill;Date.now=now;Atomics.wait=wait;});
  assert.throws(()=>withLock(f.org,()=>assert.fail('unconfirmed effect'),{timeoutMs:1}),/record is locked/);assert.equal(fs.existsSync(f.lock),true);
});
test('a stale reclaimer cannot remove a replacement live owner',t=>{
  const f=fixture(t),kill=process.kill,mkdir=fs.mkdirSync,now=Date.now,wait=Atomics.wait;let elapsed=0,changed=false;
  fs.mkdirSync(f.lock);fs.writeFileSync(path.join(f.lock,'pid'),'400001');
  process.kill=(pid,signal)=>{if(pid===400001)throw Object.assign(Error('gone'),{code:'ESRCH'});return kill(pid,signal);};
  fs.mkdirSync=function(file,...args){if(file===path.join(f.lock,'reap')&&!changed){changed=true;fs.renameSync(f.lock,f.lock+'.old');mkdir.call(this,f.lock);fs.writeFileSync(path.join(f.lock,'pid'),String(process.pid));}return mkdir.call(this,file,...args);};
  const start=now();Date.now=()=>start+elapsed;Atomics.wait=()=>{elapsed+=1000000;};
  t.after(()=>{process.kill=kill;fs.mkdirSync=mkdir;Date.now=now;Atomics.wait=wait;});
  assert.throws(()=>withLock(f.org,()=>assert.fail('replacement still owns'),{timeoutMs:1}),/record is locked/);assert.equal(fs.readFileSync(path.join(f.lock,'pid'),'utf8'),String(process.pid));
});
test('release never removes a replacement lock and PID publication failure runs no callback',t=>{
  const f=fixture(t);withLock(f.org,()=>{fs.renameSync(f.lock,f.lock+'.old');fs.mkdirSync(f.lock);fs.writeFileSync(path.join(f.lock,'pid'),'replacement');});
  assert.equal(fs.readFileSync(path.join(f.lock,'pid'),'utf8'),'replacement');fs.rmSync(f.lock,{recursive:true});
  const write=fs.writeFileSync;fs.writeFileSync=function(file,...args){if(file===path.join(f.lock,'pid'))throw Error('PID publication failed');return write.call(this,file,...args);};t.after(()=>{fs.writeFileSync=write;});
  assert.throws(()=>withLock(f.org,()=>assert.fail('unidentified writer')),/PID publication failed/);assert.equal(fs.existsSync(f.lock),false);
});
test('claim planning and owner reservation preserve the exact generation at their short fence',t=>{
  const f=fixture(t),owner={controller:'legacy',legacy:true,release:null};
  transact(f.org,()=>({add:[{type:'item.added',id:'ENG-1',role:'engineer',title:'Fixture'},{type:'run.started',id:'R-1',item:'ENG-1',workspace:f.root}]}));
  const claimed=claimRun({org:f.org,run:'R-1',owner});
  assert.equal(claimed.generation,3);assert.equal(claimRun({org:f.org,run:'R-1',owner}).already,true);
  const expected={owner,generation:3};let effects=0;
  fenceOwner(f.org,'R-1',expected,()=>{effects++;assert.equal(fs.existsSync(f.lock),true);});
  atLock(t,f,()=>fs.appendFileSync(f.file,JSON.stringify({seq:4,type:'run.claimed',run:'R-1',record:f.org,project:null,owner})+'\n'));
  assert.throws(()=>fenceOwner(f.org,'R-1',expected,()=>effects++),/guard conflict/);assert.equal(effects,1);
});
test('native own promotion observes its worker outside the record lock and refuses a raced claim',t=>{
  const f=fixture(t,{git:true}),identity=path.join(f.root,'.git'),native={name:'worker',pane_id:'pane',workspace_id:'workspace',terminal_id:'term',cwd:f.root,agent_session:{value:'sid'}};
  transact(f.org,()=>({add:[{type:'item.added',id:'ENG-1',kind:'work',role:'engineer',title:'Fixture'},{type:'run.started',id:'R-1',item:'ENG-1',workspace:f.root,meta:{lane:'topic',agent:'worker',pane:'pane',worker_workspace:'workspace',terminal_id:'term',agent_session_id:'sid'}},{type:'run.claimed',run:'R-1',record:f.org,project:identity,owner:{controller:'brain',legacy:false,release:{id:'source',root:f.root,commit:null,identity}}}]}));
  let calls=0;const guard=ownWorktreeGuard({canonical:f.root,identity,workspace:f.root,topic:'topic',env:{...process.env,ORG_DIR:f.org,HERDR_ENV:'1',HERDR_PANE_ID:'pane',HERDR_WORKSPACE_ID:'workspace',CODEX_THREAD_ID:'sid'},call:()=>{calls++;assert.equal(fs.existsSync(f.lock),false);return JSON.stringify({result:{agent:native}});}});
  guard(()=>assert.equal(fs.existsSync(f.lock),true));assert.equal(calls,2);
  atLock(t,f,()=>fs.appendFileSync(f.file,JSON.stringify({seq:4,type:'item.updated',id:'ENG-1',fields:{meta:{hold:true}}})+'\n'));
  assert.throws(()=>guard(()=>assert.fail('raced native effect')),/guard conflict/);assert.equal(calls,3);
});

test('native own promotion and landing receipts retain the newest non-abandoned owner only',t=>{
  const f=fixture(t,{git:true}),identity=path.join(f.root,'.git'),base=f.git(['rev-parse','HEAD']);
  fs.writeFileSync(path.join(f.root,'owned-source'),'owned');f.git(['add','owned-source']);f.git(['commit','-qm','Owned source']);
  const head=f.git(['rev-parse','HEAD']),native={name:'worker',pane_id:'pane',workspace_id:'workspace',terminal_id:'term',cwd:f.root,agent_session:{value:'sid'}},
    owner={controller:'brain',legacy:false,release:{id:'source',root:f.root,commit:null,identity}},
    env={...process.env,ORG_DIR:f.org,HERDR_ENV:'1',HERDR_PANE_ID:'pane',HERDR_WORKSPACE_ID:'workspace',CODEX_THREAD_ID:'sid'},
    call=()=>{assert.equal(fs.existsSync(f.lock),false);return JSON.stringify({result:{agent:native}});};
  transact(f.org,()=>({add:[{type:'item.added',id:'ENG-1',kind:'work',role:'engineer',title:'Fixture'},
    {type:'run.started',id:'R-1',item:'ENG-1',workspace:f.root,meta:{lane:'topic',agent:'worker',pane:'pane',worker_workspace:'workspace',terminal_id:'term',agent_session_id:'sid'}},
    {type:'run.claimed',run:'R-1',record:f.org,project:identity,owner},
    {type:'run.started',id:'R-2',item:'ENG-1',workspace:f.root},
    {type:'run.abandoned',id:'R-2',why:'Duplicate abandoned without replacing the actual worker'}]}));
  const guard=ownWorktreeGuard({canonical:f.root,identity,workspace:f.root,topic:'topic',env,call});
  guard(()=>assert.equal(fs.existsSync(f.lock),true));
  const receipt=recordOwnLanding({canonical:f.root,workspace:f.root,base,head,landedAt:new Date().toISOString(),env,call});
  assert.equal(receipt.recorded,true);assert.equal(receipt.changes.length,1);assert.equal(receipt.changes[0].run,'R-1');
  transact(f.org,()=>({add:[{type:'run.started',id:'R-3',item:'ENG-1',workspace:f.root}]}));
  assert.throws(()=>guard(()=>assert.fail('superseded owner')),/one active owning native worker/);
  assert.throws(()=>recordOwnLanding({canonical:f.root,workspace:f.root,base,head,landedAt:new Date().toISOString(),env,call}),/ownership is missing\/ambiguous/);
  assert.equal(loadEvents(f.org).events.filter(e=>e.type==='change.landed').length,1);
});

test('native own preflight tolerates concurrent index refresh while full source checks still fence staged changes',t=>{
  const f=fixture(t,{git:true});
  fs.writeFileSync(path.join(f.root,'index-cache-source'),'unchanged source');f.git(['add','index-cache-source']);f.git(['commit','-qm','Index refresh fixture']);
  const identity=path.join(f.root,'.git'),head=f.git(['rev-parse','HEAD']),
    native={name:'worker',pane_id:'pane',workspace_id:'workspace',terminal_id:'term',cwd:f.root,agent_session:{value:'sid'}},
    env={...process.env,ORG_DIR:f.org,HERDR_ENV:'1',HERDR_PANE_ID:'pane',HERDR_WORKSPACE_ID:'workspace',CODEX_THREAD_ID:'sid'};
  transact(f.org,()=>({add:[{type:'item.added',id:'ENG-1',kind:'work',role:'engineer',title:'Fixture'},
    {type:'run.started',id:'R-1',item:'ENG-1',workspace:f.root,meta:{lane:'topic',agent:'worker',pane:'pane',worker_workspace:'workspace',terminal_id:'term',agent_session_id:'sid'}},
    {type:'run.claimed',run:'R-1',record:f.org,project:identity,owner:{controller:'brain',legacy:false,release:{id:'source',root:f.root,commit:null,identity}}}]}));
  let calls=0;
  const index=path.join(identity,'index'),before=fs.readFileSync(index);
  const guard=ownWorktreeGuard({canonical:f.root,identity,workspace:f.root,topic:'topic',env,call:()=>{
    calls++;assert.equal(fs.existsSync(f.lock),false);
    // Same committed bytes, fresh stat cache: ordinary status rewrites index.
    const when=new Date(Date.now()+calls*1000);fs.utimesSync(path.join(f.root,'index-cache-source'),when,when);
    assert.equal(f.git(['status','--porcelain=v1']),'');
    return JSON.stringify({result:{agent:native}});
  }});
  guard(()=>assert.equal(fs.existsSync(f.lock),true));assert.equal(calls,2);
  assert.notDeepEqual(fs.readFileSync(index),before,'fixture produced real index refresh churn');
  const complete=captureReads(()=>{gitProject(f.root);observeGit(f.root);});
  const promotion=preparePromotionGuard({canonical:f.root,identity,workspace:f.root,topic:'topic',expectedHead:head});
  fs.writeFileSync(path.join(f.root,'staged-source'),'new source');f.git(['add','staged-source']);
  assert.throws(complete.validate,/observation conflict/,'full query upgrades the identity-only read set');
  assert.throws(()=>promotion.run(()=>assert.fail('staged source changed')),/observation conflict/);
  const identityOnly=captureReads(()=>gitProject(f.root));f.git(['commit','-qm','Changed committed source']);
  assert.throws(identityOnly.validate,/observation conflict/,'identity-only queries still fence committed refs');
});
test('prepared promotion refuses a late Git ref or STOP without executing FF',t=>{
  const f=fixture(t,{git:true}),head=f.git(['rev-parse','HEAD']),args={canonical:f.root,identity:path.join(f.root,'.git'),workspace:f.root,topic:'topic',expectedHead:head};
  const ref=preparePromotionGuard(args);fs.writeFileSync(path.join(f.root,'.git/refs/heads/main'),head+'\n');assert.throws(()=>ref.run(()=>assert.fail('ref changed')),/observation conflict/);
  const stop=preparePromotionGuard(args);fs.mkdirSync(path.join(f.root,'.lane/supervisor'),{recursive:true});fs.writeFileSync(path.join(f.root,'.lane/supervisor/STOP'),'stop');assert.throws(()=>stop.run(()=>assert.fail('STOP')),/observation conflict/);
});
test('batch promotion prepares every record before taking the first lock and validates all after the last',t=>{
  const f=fixture(t,{git:true}),head=f.git(['rev-parse','HEAD']),owner={controller:'brain',legacy:false,release:{id:'source',root:f.root,commit:null,identity:path.join(f.root,'.git')}};
  transact(f.org,()=>({add:[{type:'item.added',id:'ENG-1',kind:'work',role:'engineer',title:'Fixture'},{type:'run.started',id:'R-1',item:'ENG-1',workspace:f.root},{type:'run.claimed',run:'R-1',record:f.org,project:path.join(f.root,'.git'),owner},{type:'report.ingested',run:'R-1',file:'reports/x',sha256:'a'.repeat(64),report:{outcome:'done'}}]}));
  // A waived candidate needs no independent review in this focused fixture.
  fs.writeFileSync(path.join(f.root,'.lane.validation.json'),JSON.stringify({landing_waiver:'operator-20261025-until-stable-release'}));
  const lane={canonical:f.root,identity:path.join(f.root,'.git'),workspace:f.root,topic:'topic',expectedHead:head,run:'R-1',org:f.org};
  atLock(t,f,()=>fs.appendFileSync(f.file,JSON.stringify({seq:5,type:'future.unknown'})+'\n'));
  assert.throws(()=>withPromotionGuards([lane,lane],()=>assert.fail('changed batch')),/guard conflict/);
});

test('post-FF dynamic receipt loads against the already cached legacy store export surface',t=>{
  const f=fixture(t),loader=path.join(f.root,'legacy-store-loader.mjs'),receipt=new URL('../lib/landing-receipt.mjs',import.meta.url).href;
  fs.writeFileSync(loader,`export async function load(url,context,next){if(url.endsWith('/lib/store.mjs'))return{format:'module',shortCircuit:true,source:'export { LOG_FILE,CONFIG_FILE,DEFAULT_CONFIG,UserError,now,findOrgDir,isOrgDir,initOrg,readConfig,loadEvents,loadRecord,writer,transact,planTransaction,withLock,writeFileAtomic } from '+JSON.stringify(url+'?implementation')+';'};return next(url,context);}`);
  const result=spawnSync(process.execPath,['--experimental-loader',loader,'--input-type=module','-e',`await import(${JSON.stringify(receipt)});`],{encoding:'utf8'});
  assert.equal(result.status,0,result.stderr);
});

test('residual timing attributes the exact callback without changing legacy acquisition labels',t=>{
  const f=fixture(t);transact(f.org,()=>({add:[{type:'future.unknown'}]}));
  const rows=fs.readFileSync(path.join(f.org,'record-lock.timings.jsonl'),'utf8').trim().split('\n').map(JSON.parse),row=rows.at(-1);
  assert.equal(row.label,'transact');assert.match(row.caller,/^test\/record-outer-locks.test.mjs:\d+$/);assert.equal(row.schema,'record-lock/v1');
  assert.equal(loadEvents(f.org).events.length,1);
});

test('measured dispatch completion prepares outside the lock and refuses changed original command bytes',async t=>{
  const {recordDispatchCompletion}=await import('../dispatch/completion.mjs'),f=fixture(t,{git:true});
  transact(f.org,()=>({add:[{type:'item.added',id:'ENG-1',role:'engineer',title:'Fixture'}]}));
  const dir=path.join(f.org,'dispatch');fs.mkdirSync(dir);const journal=path.join(dir,'original.json'),job={token:'original',repo:f.root,org:f.org,common:path.join(f.root,'.git'),item:'ENG-1',stage:'complete',completion_protocol:1};
  fs.writeFileSync(journal,JSON.stringify(job));fs.writeFileSync(journal+'.lock',String(process.pid));
  const read=fs.readFileSync;let prepared=false;
  fs.readFileSync=function(file,...args){if(file===journal){assert.equal(fs.existsSync(f.lock),false);prepared=true;}return read.call(this,file,...args);};t.after(()=>{fs.readFileSync=read;});
  assert.equal(recordDispatchCompletion({job,journal,exitCode:0}).added[0].type,'dispatch.completed');assert.equal(prepared,true);
  atLock(t,f,()=>{job.stage='failed';fs.writeFileSync(journal,JSON.stringify(job));});
  assert.throws(()=>recordDispatchCompletion({job,journal,exitCode:1}),/original command\/source changed/);
  assert.equal(loadEvents(f.org).events.filter(e=>e.type==='dispatch.completed').length,1);
});

test('measured saved session binding plans outside the lock and refuses a raced worker occupant',async t=>{
  const {sessionBindCommand}=await import('../dispatch/session-bind-command.mjs'),{sessionBindFact}=await import('./helpers/session-bind.mjs'),{fold}=await import('../lib/state.mjs'),f=fixture(t,{git:true});
  const prior=process.env.ORG_DIR;process.env.ORG_DIR=f.org;t.after(()=>{if(prior===undefined)delete process.env.ORG_DIR;else process.env.ORG_DIR=prior;});
  const dir=path.join(f.org,'dispatch');fs.mkdirSync(dir);const journal=path.join(dir,'attempt.json'),common=path.join(f.root,'.git');
  transact(f.org,()=>({add:[{type:'item.added',id:'ENG-1',role:'engineer',title:'Fixture'},{type:'run.started',id:'R-1',item:'ENG-1',workspace:f.root,meta:{lane:'topic',dispatch_journal:journal,dispatch_attempt:'attempt',dispatch_project:common,dispatch_record:f.org}},{type:'run.updated',id:'R-1',meta:{agent:'worker',pane:'w:p',worker_workspace:'w',terminal_id:'terminal'}}]}));
  const state=fold(loadEvents(f.org).events),proposed=sessionBindFact(state.runs.get('R-1'),state),job={run:'R-1',repo:f.root,org:f.org,common,workspace:f.root,token:'attempt',stage:'complete',sessionBinding:{status:'observing',process:proposed.process,receipt:proposed.receipt,prompted_at:proposed.prompted_at,deadline:proposed.deadline,proposed}};
  fs.writeFileSync(journal,JSON.stringify(job));const read=fs.readFileSync;let prepared=false;
  fs.readFileSync=function(file,...args){if(file===journal){assert.equal(fs.existsSync(f.lock),false);prepared=true;}return read.call(this,file,...args);};t.after(()=>{fs.readFileSync=read;});
  assert.equal(sessionBindCommand(['--journal',journal]),0);assert.equal(prepared,true);
  // Preserve the first exact receipt; a changed occupant cannot gain another.
  transact(f.org,()=>({add:[{type:'run.updated',id:'R-1',meta:{terminal_id:'replacement'}}]}));
  assert.throws(()=>sessionBindCommand(['--journal',journal]),/does not match|conflicting/);assert.equal(loadEvents(f.org).events.filter(e=>e.type==='run.session_bound').length,1);
});
