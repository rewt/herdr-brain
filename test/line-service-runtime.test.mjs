import test from './helpers/bounded-test.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {spawnSync} from 'node:child_process';
import {configFixture} from './helpers/config-home-fixture.mjs';
import {loadEvents,transact} from '../lib/store.mjs';
import {gitProject} from '../lib/project.mjs';
import {lineDirectory} from '../line-service/cutoff.mjs';
import {launchPlist} from '../line-service/plist.mjs';
import {noticeLock} from '../supervisor/notice-lock.mjs';

async function fixture(t){
  const f=configFixture(t,{custom:true}),org=f.env.ORG_DIR,identity=gitProject(f.cwd).identity,directory=lineDirectory(org,identity);
  fs.writeFileSync(path.join(f.cwd,'.herdr-release.json'),'{"release":"compatible"}\n');f.git('add','.herdr-release.json');f.git('commit','-qm','Accept fixture release');
  fs.mkdirSync(directory,{recursive:true});
  const file=path.join(directory,'service.plist'),stop=path.join(directory,'STOP'),installationFile=path.join(directory,'installation.json');
  const source=path.join(f.scratch,'retained-development-source'); // Deliberately absent: no mutable development dependency.
  const installation={at:'2026-10-27T00:00:00Z',target:`gui/${process.getuid()}/dev.herdr.line.${path.basename(directory)}`,repo:f.cwd,org,source:source+path.sep,node:process.execPath,file,phase:'installed'};
  fs.writeFileSync(installationFile,JSON.stringify(installation)+'\n');
  fs.writeFileSync(file,launchPlist({label:`dev.herdr.line.${path.basename(directory)}`,repo:f.cwd,org,to:'fixture-supervisor',herdr:'/saved/bin/herdr',socket:'/saved/native.sock',directory,
    node:process.execPath,source,interval:47,searchPath:'/saved/bin:/usr/bin:/bin'}));
  fs.writeFileSync(stop,'Original intentional admission stop\n');
  const boundary={id:'original-cutover',project:identity,repo:f.cwd,org,source,main:'main',canonical_head:f.git('rev-parse','HEAD')};
  transact(org,()=>({add:['line-service.cutover','line-service.phase0'].map(type=>({...boundary,type}))}));
  // Retained/UNKNOWN requests are opaque to the migration.
  const jobs=path.join(org,'dispatch');fs.mkdirSync(jobs,{recursive:true});
  fs.writeFileSync(path.join(jobs,'retained.json'),JSON.stringify({stage:'UNKNOWN',root:source,node:'/saved/node',watcher:'original'}));
  fs.writeFileSync(path.join(directory,'effects.json'),JSON.stringify({identity,org,actions:{'review:original':{state:'held',error:'UNKNOWN native attempt'}}}));
  const agent=f.observation.agents[0],env={...f.env,HERDR_ENV:'1',HERDR_PANE_ID:agent.pane_id,HERDR_WORKSPACE_ID:agent.workspace_id,CODEX_THREAD_ID:agent.agent_session.value};
  const call=()=>JSON.stringify({result:{agent}}),calls=[];
  let loaded=false,bootstrapError;
  const command=(exe,args,options)=>{
    calls.push({exe,args});
    if(exe==='/usr/bin/plutil')return spawnSync(exe,args,options);
    assert.equal(exe,'/bin/launchctl');
    if(args[0]==='print')return loaded?{status:0,stdout:'saved job'}:{status:113,stderr:'Could not find service in domain'};
    if(args[0]==='bootstrap')return bootstrapError?{status:1,stderr:bootstrapError}:{status:0,stdout:''};
    throw Error('unexpected native effect '+args.join(' '));
  };
  const module=async relative=>import(pathToFileURL(path.join(f.bundle,relative)).href);
  const {migrateRuntime}=await module('line-service/migrate-runtime.mjs');
  const args={repo:f.cwd,org,id:'fixture-move',cwd:f.cwd,env,call,command,home:f.installationHome};
  args.expectedPlan=migrateRuntime({...args,dryRun:true}).archive.sha256;
  const migrate=extra=>migrateRuntime({...args,...extra});
  const original={installation:fs.readFileSync(installationFile,'utf8'),plist:fs.readFileSync(file,'utf8'),stop:fs.readFileSync(stop,'utf8'),events:fs.readFileSync(path.join(org,'events.jsonl'),'utf8'),
    jobs:fs.readFileSync(path.join(jobs,'retained.json'),'utf8'),effects:fs.readFileSync(path.join(directory,'effects.json'),'utf8')};
  return{...f,org,identity,directory,file,stop,installationFile,installation,args,migrate,module,calls,original,agent,
    setLoaded:v=>loaded=v,setBootstrapError:v=>bootstrapError=v};
}
function unchanged(f){
  assert.equal(fs.readFileSync(f.installationFile,'utf8'),f.original.installation);
  assert.equal(fs.readFileSync(f.file,'utf8'),f.original.plist);
  assert.equal(fs.readFileSync(f.stop,'utf8'),f.original.stop);
  assert.equal(fs.readFileSync(path.join(f.org,'events.jsonl'),'utf8'),f.original.events);
}

test('stopped migration dry-run writes nothing and preserves saved Node, transport, jobs, cutover and phase0 on apply',async t=>{
  const f=await fixture(t),before=fs.readdirSync(f.directory).sort();
  const {main}=await f.module('line-service/launchd.mjs'),args=['migrate','--repo',f.cwd,'--org',f.org,'--id','fixture-move'];
  const plan=main([...args,'--dry-run'],f.args);assert.equal(plan.dry_run,true);assert.equal(plan.runtime_started,false);
  unchanged(f);assert.deepEqual(fs.readdirSync(f.directory).sort(),before);
  const result=main([...args,'--expected-plan',plan.archive.sha256],f.args);assert.equal(result.migrated,true);assert.equal(result.stopped,true);
  const receipt=JSON.parse(fs.readFileSync(f.installationFile)),archive=JSON.parse(fs.readFileSync(result.archive.file));
  assert.equal(receipt.source,f.bundle);assert.equal(receipt.node,f.installation.node);assert.equal(receipt.at,f.installation.at);
  assert.equal(archive.before.installation,f.original.installation);assert.equal(archive.before.plist,f.original.plist);
  const parse=file=>JSON.parse(spawnSync('/usr/bin/plutil',['-convert','json','-o','-','--',file],{encoding:'utf8'}).stdout);
  const old=path.join(f.scratch,'old.plist');fs.writeFileSync(old,f.original.plist);const expected=parse(old),actual=parse(f.file);
  expected.ProgramArguments[1]=path.join(f.bundle,'line-service/line-service.mjs');assert.deepEqual(actual,expected);
  assert.equal(fs.readFileSync(f.stop,'utf8'),f.original.stop);
  assert.equal(fs.readFileSync(path.join(f.org,'dispatch/retained.json'),'utf8'),f.original.jobs);
  assert.equal(fs.readFileSync(path.join(f.directory,'effects.json'),'utf8'),f.original.effects);
  const events=loadEvents(f.org).events;
  assert.deepEqual(events.filter(e=>e.type==='line-service.cutover'||e.type==='line-service.phase0'),f.original.events.trim().split('\n').map(JSON.parse).filter(e=>e.type==='line-service.cutover'||e.type==='line-service.phase0'));
  const {installedContext,serviceCutoff}=await f.module('line-service/cutoff.mjs');
  assert.equal(installedContext(f.cwd,f.org).installation.node,process.execPath);
  assert.equal(serviceCutoff(events,{repo:f.cwd,org:f.org,identity:f.identity}).source,path.resolve(f.installation.source));
  const beforeRetry=fs.readFileSync(path.join(f.org,'events.jsonl'),'utf8');assert.equal(f.migrate().existing,true);
  assert.equal(fs.readFileSync(path.join(f.org,'events.jsonl'),'utf8'),beforeRetry);
  assert.throws(()=>f.migrate({id:'replacement'}),/already migrated/);
  assert.equal(f.calls.some(c=>c.args[0]==='bootstrap'||c.args[0]==='bootout'),false);
});

test('migration refuses loaded, occupied, foreign, held, dirty and drifted bindings without replacing anything',async t=>{
  const f=await fixture(t);
  f.setLoaded(true);assert.throws(()=>f.migrate(),/remains loaded/);f.setLoaded(false);unchanged(f);
  for(const lock of ['pass.lock','control.lock']){const release=noticeLock(path.join(f.directory,lock),{recover:false});try{assert.throws(()=>f.migrate(),/lock/);}finally{release();}unchanged(f);}
  const promotion=noticeLock(path.join(f.identity,'lane-promote.lock'),{recover:false});try{assert.throws(()=>f.migrate(),/lock/);}finally{promotion();}unchanged(f);
  assert.throws(()=>f.migrate({env:{...f.args.env,CODEX_THREAD_ID:'foreign-session'}}),/native caller/);unchanged(f);
  fs.mkdirSync(path.join(f.cwd,'.lane/supervisor'),{recursive:true});const hold=path.join(f.cwd,'.lane/supervisor/HOLD');fs.writeFileSync(hold,'keep');
  assert.throws(()=>f.migrate(),/STOP\/HOLD/);fs.unlinkSync(hold);unchanged(f);
  fs.writeFileSync(path.join(f.cwd,'dirty'),'changed');assert.throws(()=>f.migrate(),/clean canonical/);fs.unlinkSync(path.join(f.cwd,'dirty'));unchanged(f);
  fs.writeFileSync(f.file,f.original.plist.replace('/saved/native.sock','/changed/native.sock'));
  assert.throws(()=>f.migrate(),/plan changed/);
  // Changes during the final native CAS are refused rather than overwritten.
  const initial=f.original.plist;fs.writeFileSync(f.file,initial);
  let prints=0;const command=(exe,args,options)=>{const result=f.args.command(exe,args,options);if(args[0]==='print'&&++prints===2)fs.appendFileSync(f.file,'\n');return result;};
  assert.throws(()=>f.migrate({command}),/CAS changed/);assert.equal(fs.existsSync(path.join(f.directory,'migrations')),false);
  fs.writeFileSync(f.file,initial);
  fs.writeFileSync(f.installationFile,JSON.stringify({...f.installation,node:'/changed/node'}));assert.throws(()=>f.migrate(),/installation binding/);
  fs.writeFileSync(f.installationFile,f.original.installation);unchanged(f);
});

test('migration rejects missing acceptance, changed payload and a different project pin',async t=>{
  const f=await fixture(t),manifestFile=path.join(f.bundle,'.release-manifest.json'),bytes=fs.readFileSync(manifestFile),manifest=JSON.parse(bytes);
  manifest.acceptance.ready=false;fs.writeFileSync(manifestFile,JSON.stringify(manifest));assert.throws(()=>f.migrate(),/acceptance/);fs.writeFileSync(manifestFile,bytes);unchanged(f);
  const payload=path.join(f.bundle,'line-service/line-service.mjs'),original=fs.readFileSync(payload);fs.appendFileSync(payload,'\n// drift\n');assert.throws(()=>f.migrate(),/incomplete release/);fs.writeFileSync(payload,original);unchanged(f);
  fs.writeFileSync(path.join(f.cwd,'.herdr-release.json'),'{"release":null}\n');f.git('add','.herdr-release.json');f.git('commit','-qm','Remove pin');
  assert.throws(()=>f.migrate(),/explicit accepted project pin/);unchanged(f);
});

test('a partial migration remains stopped and UNKNOWN for both the original and a different id',async t=>{
  const f=await fixture(t);
  assert.throws(()=>f.migrate({fault:phase=>{if(phase==='plist')throw Error('lost reply after plist');}}),/lost reply/);
  assert.equal(fs.readFileSync(f.stop,'utf8'),f.original.stop);assert.equal(fs.readFileSync(f.installationFile,'utf8'),f.original.installation);
  assert.equal(loadEvents(f.org).events.some(e=>e.type==='line-service.runtime-migrated'),false);
  for(const id of ['fixture-move','another-id'])assert.throws(()=>f.migrate({id}),/UNKNOWN migration/);
  const {main}=await f.module('line-service/launchd.mjs');
  assert.throws(()=>main(['restart','--repo',f.cwd,'--org',f.org],f.args),/cutover binding/);
  assert.equal(f.calls.some(c=>c.args[0]==='bootstrap'),false);
});

test('accepted migrated release supports guarded restart and a real offline pass without a development Git tree',async t=>{
  const f=await fixture(t);f.migrate();
  const {main}=await f.module('line-service/launchd.mjs');
  const args=['restart','--repo',f.cwd,'--org',f.org];
  f.setBootstrapError('native bootstrap refused');assert.throws(()=>main(args,f.args),/bootstrap refused/);assert.ok(fs.existsSync(f.stop));
  assert.equal(f.calls.filter(c=>c.args[0]==='bootstrap').length,1);
  // No native retry after the refusal: the separate success control gets a
  // fresh disposable service and its own original attempt.
  const g=await fixture(t);g.migrate();const {main:restart}=await g.module('line-service/launchd.mjs');
  assert.equal(restart(['restart','--repo',g.cwd,'--org',g.org],g.args).restarted,true);assert.equal(fs.existsSync(g.stop),false);
  const {createLineService}=await g.module('line-service/line-service.mjs');
  const service=createLineService({repo:g.cwd,org:g.org,to:'fixture-supervisor',runtimeHome:g.installationHome,env:{...g.env,HERDR_ENV:'',HERDR_PANE_ID:''},haltAfter:100,
    command:()=>({status:0,stdout:'{"created":[]}'}),capacity:()=>({count:0,cap:2})});
  assert.equal(service.pass().result,'pass-complete');
  const audit=fs.readFileSync(path.join(g.directory,'passes.jsonl'),'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(audit.find(e=>e.action==='pass-start').source_head,'1'.repeat(40));
  const {installedContext}=await g.module('line-service/cutoff.mjs');
  fs.appendFileSync(g.file,'\n');assert.throws(()=>installedContext(g.cwd,g.org),/drifted/);
});
