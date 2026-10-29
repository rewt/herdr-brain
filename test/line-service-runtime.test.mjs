import test from './helpers/bounded-test.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {configFixture} from './helpers/config-home-fixture.mjs';
import {loadEvents,transact} from '../lib/store.mjs';
import {gitProject} from '../lib/project.mjs';
import {lineDirectory} from '../line-service/cutoff.mjs';
import {launchPlist} from '../line-service/plist.mjs';
import {noticeLock} from '../supervisor/notice-lock.mjs';
import {fixture as dispatchFixture,promptCalls} from '../dispatch/test/dispatch-fixture.mjs';

async function fixture(t,{phase='installed'}={}){
  const f=configFixture(t,{custom:true}),org=f.env.ORG_DIR,identity=gitProject(f.cwd).identity,directory=lineDirectory(org,identity);
  fs.writeFileSync(path.join(f.cwd,'.herdr-release.json'),'{"release":"compatible"}\n');f.git('add','.herdr-release.json');f.git('commit','-qm','Accept fixture release');
  fs.mkdirSync(directory,{recursive:true});
  const file=path.join(directory,'service.plist'),stop=path.join(directory,'STOP'),installationFile=path.join(directory,'installation.json');
  const source=path.join(f.scratch,'retained-development-source'); // Deliberately absent: no mutable development dependency.
  const installation={at:'2026-10-27T00:00:00Z',target:`gui/${process.getuid()}/dev.herdr.line.${path.basename(directory)}`,repo:f.cwd,org,source:source+path.sep,node:process.execPath,file,phase,
    ...(phase==='uncertain-or-refused'?{error:'Bootstrap failed: 5: Input/output error'}:{})};
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
    if(args[0]==='bootstrap'){if(bootstrapError)return{status:1,stderr:bootstrapError};loaded=true;return{status:0,stdout:''};}
    if(args[0]==='bootout'){loaded=false;return{status:0,stdout:''};}
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

test('stopped uncertain install migrates with an append-only observation and preserves its original refused effect',async t=>{
  const f=await fixture(t,{phase:'uncertain-or-refused'}),before=fs.readdirSync(f.directory).sort();
  const plan=f.migrate({dryRun:true});unchanged(f);assert.deepEqual(fs.readdirSync(f.directory).sort(),before);
  const result=f.migrate({expectedPlan:plan.archive.sha256}),archive=JSON.parse(fs.readFileSync(result.archive.file));
  const saved=JSON.parse(fs.readFileSync(f.installationFile));
  assert.equal(saved.phase,'uncertain-or-refused');assert.equal(saved.error,f.installation.error);
  assert.equal(archive.before.installation,f.original.installation);
  const observed=loadEvents(f.org).events.filter(e=>e.type==='line-service.stopped-installation-verified');
  assert.equal(observed.length,1);assert.equal(observed[0].observation.schema,'line-stopped-installation/v1');
  assert.equal(observed[0].observation.service.loaded,false);assert.match(observed[0].observation.service.native,/Could not find service/);
  assert.equal(observed[0].observation.bootstrap_replayed,false);assert.equal(observed[0].archive.sha256,result.archive.sha256);
  assert.deepEqual(observed[0].observation,archive.stopped_installation);
  assert.equal(fs.readFileSync(f.stop,'utf8'),f.original.stop);
  assert.equal(fs.readFileSync(path.join(f.org,'dispatch/retained.json'),'utf8'),f.original.jobs);
  assert.equal(fs.readFileSync(path.join(f.directory,'effects.json'),'utf8'),f.original.effects);
  const {installedContext}=await f.module('line-service/cutoff.mjs');assert.equal(installedContext(f.cwd,f.org).installation.phase,'uncertain-or-refused');
  const events=fs.readFileSync(path.join(f.org,'events.jsonl'),'utf8');assert.equal(f.migrate().existing,true);
  assert.equal(fs.readFileSync(path.join(f.org,'events.jsonl'),'utf8'),events);
  assert.equal(f.calls.some(c=>c.args[0]==='bootstrap'||c.args[0]==='bootout'),false);
});

test('uncertain install still requires positive absence, STOP, exact original phase and final observation CAS',async t=>{
  const f=await fixture(t,{phase:'uncertain-or-refused'});
  f.setLoaded(true);assert.throws(()=>f.migrate(),/remains loaded/);f.setLoaded(false);unchanged(f);
  const command=(exe,args,options)=>args[0]==='print'?{status:1,stderr:'Permission denied'}:f.args.command(exe,args,options);
  assert.throws(()=>f.migrate({command}),/Permission denied/);unchanged(f);
  fs.unlinkSync(f.stop);assert.throws(()=>f.migrate(),/ENOENT|own STOP/);fs.writeFileSync(f.stop,f.original.stop);
  fs.writeFileSync(f.installationFile,JSON.stringify({...f.installation,phase:'starting'}));
  assert.throws(()=>f.migrate(),/installation binding/);fs.writeFileSync(f.installationFile,f.original.installation);unchanged(f);
  let prints=0;
  const changed=(exe,args,options)=>{
    const result=f.args.command(exe,args,options);
    if(args[0]==='print'&&++prints===2)fs.appendFileSync(f.installationFile,' ');
    return result;
  };
  assert.throws(()=>f.migrate({command:changed}),/CAS changed/);
  assert.equal(fs.existsSync(path.join(f.directory,'migrations')),false);
  assert.equal(loadEvents(f.org).events.some(e=>e.type==='line-service.stopped-installation-verified'),false);
  assert.equal(f.calls.some(c=>c.args[0]==='bootstrap'||c.args[0]==='bootout'),false);
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

test('accepted release line pass creates a dispatch in that same release despite an inherited source override',async t=>{
  const f=await fixture(t);f.migrate();fs.unlinkSync(f.stop);
  const d=dispatchFixture(t,{project:f}),pin=fs.readFileSync(path.join(f.cwd,'.herdr-release.json'));
  const topic=`line-${d.item.toLowerCase()}-1`,laneCLI=path.join(d.root,'bin/lane');
  // The existing fake lane adapter locates one fixed topic; bind it to the
  // actual topic generated by this pass instead of changing the dispatch argv.
  fs.writeFileSync(laneCLI,fs.readFileSync(laneCLI,'utf8').replace('lane/topic',`lane/${topic}`));
  const {createLineService}=await f.module('line-service/line-service.mjs');
  let launches=0;
  const service=createLineService({repo:f.cwd,org:f.org,to:'fixture-supervisor',runtimeHome:f.installationHome,
    env:{...d.env,HERDR_BRAIN_ROOT:f.cwd},maxStarts:1,haltAfter:100,capacity:()=>({count:0,cap:4}),
    recordNotice:data=>({id:data.id,state:'record-only'}),command:(exe,args,options)=>{
      if(!args[0].endsWith('/dispatch/dispatch.mjs'))return{status:0,stdout:'{"created":[]}'};
      launches++;assert.equal(args[0],path.join(f.bundle,'dispatch/dispatch.mjs'));
      assert.equal(options.env.HERDR_BRAIN_ROOT,undefined);
      // Run the real release dispatcher synchronously through its native and
      // watcher fakes so the test joins the complete effect before teardown.
      return spawnSync(exe,[...args.filter(a=>a!=='--detach'),'--lane-cli',laneCLI,'--watch-cli',path.join(d.root,'bin/watch')],options);
    }});
  assert.equal(service.pass().result,'pass-complete');
  assert.equal(launches,1);
  const jobs=d.jobs().map(file=>JSON.parse(fs.readFileSync(file))).filter(job=>job.item===d.item);
  assert.equal(jobs.length,1,fs.readFileSync(path.join(f.directory,'passes.jsonl'),'utf8'));
  const [job]=jobs;assert.equal(job.stage,'complete');assert.equal(job.release.root,f.bundle);
  assert.equal(job.release.commit,'1'.repeat(40));assert.equal(job.sourceSelection,null);
  assert.equal(d.show(job.run).owner.release.root,f.bundle);assert.equal(promptCalls(d).length,1);
  assert.deepEqual(fs.readFileSync(path.join(f.cwd,'.herdr-release.json')),pin);
  assert.equal(fs.readFileSync(path.join(f.org,'dispatch/retained.json'),'utf8'),f.original.jobs);
});

async function successor(t,options){
  const f=await fixture(t,options);f.migrate();
  const migrated={installation:fs.readFileSync(f.installationFile,'utf8'),plist:fs.readFileSync(f.file,'utf8'),events:loadEvents(f.org).events};
  const next=f.release('successor',{commit:'2'.repeat(40)});
  const pin=id=>{fs.writeFileSync(path.join(f.cwd,'.herdr-release.json'),JSON.stringify({release:id})+'\n');f.git('add','.herdr-release.json');f.git('commit','-qm','Select '+id);};
  pin('successor');
  const {main}=await import(pathToFileURL(path.join(next,'line-service/launchd.mjs')).href);
  const argv=['upgrade','--repo',f.cwd,'--org',f.org,'--id','fixture-upgrade','--from-root',f.bundle,'--target-root',next];
  const plan=()=>main([...argv,'--dry-run'],f.args);
  const upgrade=extra=>main([...argv,'--expected-plan',plan().archive.sha256,...(extra??[])],f.args);
  return {...f,next,pin,main,argv,plan,upgrade,migrated};
}
function retained(f){
  return {installation:fs.readFileSync(f.installationFile,'utf8'),plist:fs.readFileSync(f.file,'utf8'),stop:fs.readFileSync(f.stop,'utf8'),events:fs.readFileSync(path.join(f.org,'events.jsonl'),'utf8')};
}

test('upgrade preserves a verified stopped uncertain installation and its original bootstrap refusal',async t=>{
  const f=await successor(t,{phase:'uncertain-or-refused'}),before=JSON.parse(f.migrated.installation);
  const observed=loadEvents(f.org).events.find(e=>e.type==='line-service.stopped-installation-verified');
  const result=f.upgrade(),saved=JSON.parse(fs.readFileSync(f.installationFile));
  assert.equal(saved.phase,before.phase);assert.equal(saved.error,before.error);assert.deepEqual(saved.migration,before.migration);
  assert.equal(result.runtime_started,false);assert.ok(fs.existsSync(f.stop));
  const {installedContext}=await import(pathToFileURL(path.join(f.next,'line-service/cutoff.mjs')).href);
  assert.equal(installedContext(f.cwd,f.org).installation.source,f.next);
  assert.deepEqual(loadEvents(f.org).events.find(e=>e.type==='line-service.stopped-installation-verified'),observed);
  assert.equal(f.calls.some(c=>['bootstrap','bootout'].includes(c.args[0])),false);
});

test('release upgrade retains original migration and cutoff, restarts the successor and rolls back through the same guarded path',async t=>{
  const f=await successor(t),before=retained(f),files=fs.readdirSync(f.directory).sort(),plan=f.plan();
  assert.deepEqual(retained(f),before);assert.deepEqual(fs.readdirSync(f.directory).sort(),files);
  const result=f.main([...f.argv,'--expected-plan',plan.archive.sha256],f.args);assert.equal(result.upgraded,true);
  assert.equal(result.runtime_started,false);assert.equal(fs.readFileSync(f.stop,'utf8'),f.original.stop);
  const installed=JSON.parse(fs.readFileSync(f.installationFile));
  assert.equal(installed.source,f.next);assert.deepEqual(installed.migration,JSON.parse(f.migrated.installation).migration);
  const originalMigration=installed.migration,originalArchive=fs.readFileSync(originalMigration.file,'utf8');
  const {serviceCutoff,installedContext}=await import(pathToFileURL(path.join(f.next,'line-service/cutoff.mjs')).href);
  assert.equal(serviceCutoff(loadEvents(f.org).events,{repo:f.cwd,org:f.org,identity:f.identity}).seq,f.migrated.events.find(e=>e.type==='line-service.cutover').seq);
  assert.equal(installedContext(f.cwd,f.org).installation.source,f.next);
  assert.equal(f.main([...f.argv,'--expected-plan',plan.archive.sha256],f.args).existing,true);
  assert.equal(loadEvents(f.org).events.filter(e=>e.type==='line-service.runtime-upgraded').length,1);
  assert.throws(()=>f.main([...f.argv,'--expected-plan','a'.repeat(64)],f.args),/exact dry-run/);
  assert.equal(fs.readFileSync(path.join(f.directory,'effects.json'),'utf8'),f.original.effects);
  assert.equal(f.main(['restart','--repo',f.cwd,'--org',f.org],f.args).restarted,true);
  const {createLineService}=await import(pathToFileURL(path.join(f.next,'line-service/line-service.mjs')).href);
  const service=createLineService({repo:f.cwd,org:f.org,to:'fixture-supervisor',runtimeHome:f.installationHome,env:{...f.env,HERDR_ENV:'',HERDR_PANE_ID:''},haltAfter:100,
    command:()=>({status:0,stdout:'{"created":[]}'}),capacity:()=>({count:0,cap:2})});
  assert.equal(service.pass().result,'pass-complete');
  const audit=fs.readFileSync(path.join(f.directory,'passes.jsonl'),'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(audit.find(e=>e.action==='pass-start').source_head,'2'.repeat(40));
  f.main(['stop','--repo',f.cwd,'--org',f.org],f.args);f.pin('compatible');
  const rollback=['upgrade','--repo',f.cwd,'--org',f.org,'--id','fixture-rollback','--from-root',f.next,'--target-root',f.bundle,'--rollback'];
  const back=f.main([...rollback,'--dry-run'],f.args);
  assert.equal(f.main([...rollback,'--expected-plan',back.archive.sha256],f.args).direction,'rollback');
  assert.equal(fs.readFileSync(f.installationFile,'utf8'),f.migrated.installation);
  assert.equal(fs.readFileSync(f.file,'utf8'),f.migrated.plist);assert.equal(fs.readFileSync(originalMigration.file,'utf8'),originalArchive);
  assert.deepEqual(loadEvents(f.org).events.filter(e=>['line-service.cutover','line-service.phase0','line-service.runtime-migrated'].includes(e.type)),f.migrated.events);
  const {main:restart}=await f.module('line-service/launchd.mjs');
  assert.equal(restart(['restart','--repo',f.cwd,'--org',f.org],f.args).restarted,true);
  assert.equal(fs.readFileSync(path.join(f.org,'dispatch/retained.json'),'utf8'),f.original.jobs);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(f.directory,'effects.json'))).actions['review:original'],JSON.parse(f.original.effects).actions['review:original']);
});

test('upgrade refuses foreign owners, mismatched roots and records, STOP/HOLD, live locks, loaded service and changed native CAS',async t=>{
  const f=await successor(t),before=retained(f),plan=f.plan();
  const apply=extra=>f.main([...f.argv,'--expected-plan',plan.archive.sha256],{...f.args,...extra});
  assert.throws(()=>apply({env:{...f.args.env,CODEX_THREAD_ID:'foreign-session'}}),/native caller/);
  assert.throws(()=>f.main([...f.argv,'--dry-run','--org',f.scratch],f.args),/record differs/);
  assert.throws(()=>f.main([...f.argv,'--dry-run','--from-root',f.next],f.args),/different current/);
  f.setLoaded(true);assert.throws(()=>apply(),/remains loaded/);f.setLoaded(false);
  for(const name of ['STOP','HOLD']){
    const file=path.join(f.cwd,'.lane/supervisor',name);fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,'keep');
    assert.throws(()=>apply(),/STOP\/HOLD/);fs.unlinkSync(file);
  }
  for(const file of [path.join(f.directory,'pass.lock'),path.join(f.directory,'control.lock'),path.join(f.identity,'lane-promote.lock')]){
    const release=noticeLock(file,{recover:false});try{assert.throws(()=>apply(),/lock/);assert.throws(()=>f.plan(),/lock/);}finally{release();}
  }
  assert.throws(()=>f.main([...f.argv,'--dry-run','--rollback'],f.args),/previous accepted root/);
  let prints=0;
  const command=(exe,args,options)=>{const r=f.args.command(exe,args,options);if(args[0]==='print'&&++prints===2)fs.appendFileSync(f.file,'\n');return r;};
  assert.throws(()=>apply({command}),/CAS changed/);fs.writeFileSync(f.file,before.plist);
  assert.deepEqual(retained(f),before);assert.equal(fs.existsSync(path.join(f.directory,'upgrades')),false);
  assert.equal(f.calls.some(c=>['bootstrap','bootout'].includes(c.args[0])),false);
});

test('upgrade requires sealed READY payloads, an exact target pin and the unchanged dry-run plan',async t=>{
  const f=await successor(t),before=retained(f),plan=f.plan(),manifestFile=path.join(f.next,'.release-manifest.json'),manifestBytes=fs.readFileSync(manifestFile);
  const manifest=JSON.parse(manifestBytes);manifest.acceptance.ready=false;fs.writeFileSync(manifestFile,JSON.stringify(manifest));
  assert.throws(()=>f.plan(),/acceptance/);fs.writeFileSync(manifestFile,manifestBytes);
  const payload=path.join(f.next,'line-service/line-service.mjs'),payloadBytes=fs.readFileSync(payload);fs.appendFileSync(payload,'\n// unsealed change\n');
  assert.throws(()=>f.plan(),/incomplete release/);fs.writeFileSync(payload,payloadBytes);
  f.pin('compatible');assert.throws(()=>f.plan(),/accepted project pin/);f.pin('successor');
  assert.throws(()=>f.main([...f.argv,'--expected-plan',plan.archive.sha256],f.args),/plan changed/);
  assert.throws(()=>f.main(f.argv,f.args),/expected-plan/);
  assert.deepEqual(retained(f),before);
});

test('partial upgrades keep STOP and immutable UNKNOWN intent and refuse both ids and restart at every write boundary',async t=>{
  for(const point of ['intent','plist','installation']){
    const f=await successor(t),{upgradeRuntime}=await import(pathToFileURL(path.join(f.next,'line-service/upgrade-runtime.mjs')).href),plan=f.plan();
    assert.throws(()=>upgradeRuntime({...f.args,id:'fixture-upgrade',fromRoot:f.bundle,targetRoot:f.next,expectedPlan:plan.archive.sha256,
      fault:phase=>{if(phase===point)throw Error('lost reply at '+point);}}),/lost reply/);
    assert.equal(fs.readFileSync(f.stop,'utf8'),f.original.stop);
    assert.equal(loadEvents(f.org).events.filter(e=>e.type==='line-service.runtime-upgraded').length,0);
    for(const id of ['fixture-upgrade','different-id'])assert.throws(()=>f.main([...f.argv,'--id',id,'--dry-run'],f.args),/UNKNOWN runtime upgrade/);
    assert.throws(()=>f.main(['restart','--repo',f.cwd,'--org',f.org],f.args),/UNKNOWN runtime upgrade|cutover binding/);
    assert.equal(f.calls.some(c=>c.args[0]==='bootstrap'),false);
  }
});

test('partial rollback cannot expose a legacy-readable installation before its durable event',async t=>{
  for(const point of ['plist','record']){
    const f=await successor(t);f.upgrade();f.pin('compatible');
    const {upgradeRuntime}=await import(pathToFileURL(path.join(f.next,'line-service/upgrade-runtime.mjs')).href);
    const args={...f.args,id:'rollback-interrupted',fromRoot:f.next,targetRoot:f.bundle,rollback:true};
    const plan=upgradeRuntime({...args,dryRun:true});
    assert.throws(()=>upgradeRuntime({...args,expectedPlan:plan.archive.sha256,fault:phase=>{if(phase===point)throw Error('interrupted rollback');}}),/interrupted rollback/);
    assert.equal(JSON.parse(fs.readFileSync(f.installationFile)).source,f.next);
    assert.ok(fs.existsSync(f.stop));
    const {main:old}=await f.module('line-service/launchd.mjs');
    assert.throws(()=>old(['restart','--repo',f.cwd,'--org',f.org],f.args),/cutover binding/);
    assert.throws(()=>upgradeRuntime({...args,dryRun:true}),/UNKNOWN runtime upgrade|drifted/);
    assert.equal(f.calls.some(c=>c.args[0]==='bootstrap'),false);
  }
});

test('successive accepted upgrades validate the whole archive chain and reject changed archives and saved bindings',async t=>{
  const f=await successor(t);const first=f.upgrade();
  const third=f.release('third',{commit:'3'.repeat(40)});f.pin('third');
  const {main}=await import(pathToFileURL(path.join(third,'line-service/launchd.mjs')).href);
  const argv=['upgrade','--repo',f.cwd,'--org',f.org,'--id','third-upgrade','--from-root',f.next,'--target-root',third];
  const plan=main([...argv,'--dry-run'],f.args);main([...argv,'--expected-plan',plan.archive.sha256],f.args);
  const {installedContext}=await import(pathToFileURL(path.join(third,'line-service/cutoff.mjs')).href);
  assert.equal(installedContext(f.cwd,f.org).installation.source,third);
  const bytes=fs.readFileSync(first.archive.file);fs.chmodSync(first.archive.file,0o644);fs.appendFileSync(first.archive.file,'\n');
  assert.throws(()=>installedContext(f.cwd,f.org),/archive changed/);fs.writeFileSync(first.archive.file,bytes);
  const installation=fs.readFileSync(f.installationFile,'utf8');fs.writeFileSync(f.installationFile,installation.replace('2026-10-27','2026-10-28'));
  assert.throws(()=>installedContext(f.cwd,f.org),/drifted/);
});

function stalePass(t, f, name = 'pass.lock') {
  const directory = path.join(f.directory, name), pid = 2147483647, kill = process.kill;
  t.mock.method(process, 'kill', (target, signal) => {
    if (target === pid) throw Object.assign(Error('fixture owner absent'), { code: 'ESRCH' });
    return kill(target, signal);
  });
  const owner = {pid, at:'2026-10-27T20:15:22Z', argv:['node','line-service.mjs','--once','--to','brain-chat']};
  fs.mkdirSync(directory);fs.writeFileSync(path.join(directory,'owner.json'),JSON.stringify(owner));
  return {directory,owner};
}
function recoveryEvents(f) {return loadEvents(f.org).events.filter(e=>e.type==='line-service.lock-recovery');}

for (const operation of ['migration','upgrade']) for (const dryRun of [true,false])
  test(`${operation} ${dryRun?'dry-run':'apply'} recovers a dead pass owner with append-only intent and completion`,async t=>{
    const f=await (operation==='migration'?fixture(t):successor(t)),before=retained(f);
    const plan=operation==='migration'?f.migrate({dryRun:true}):f.plan();
    const stale=stalePass(t,f),guard=stalePass(t,f,'pass.lock.recovery');
    const invoke=()=>operation==='migration'?f.migrate({dryRun,expectedPlan:plan.archive.sha256}):
      f.main([...f.argv,...(dryRun?['--dry-run']:['--expected-plan',plan.archive.sha256])],f.args);
    const result=invoke(),events=recoveryEvents(f);
    assert.equal(dryRun?result.dry_run:(result.migrated??result.upgraded),true);
    assert.deepEqual(events.map(e=>[e.directory,e.phase]),[
      [guard.directory,'intent'],[guard.directory,'recovered'],[stale.directory,'intent'],[stale.directory,'recovered']]);
    for(const event of events){
      assert.equal(event.schema,'line-lock-recovery/v1');assert.equal(event.operation,operation);
      assert.equal(event.dry_run,dryRun);assert.equal(event.project,f.identity);assert.equal(event.org,f.org);
      assert.equal(event.native_caller.name,f.agent.name);assert.deepEqual(event.owner,stale.owner);
      assert.equal(event.proof.result,'ESRCH');assert.equal(event.proof.method,'kill(pid, 0)');
      assert.equal(event.owner_sha256,createHash('sha256').update(JSON.stringify(stale.owner)).digest('hex'));
      assert.ok(event.lock_identity);
    }
    assert.equal(fs.existsSync(stale.directory),false);assert.equal(fs.existsSync(guard.directory),false);
    assert.equal(fs.readFileSync(f.stop,'utf8'),before.stop);
    if(dryRun){
      assert.equal(fs.readFileSync(f.installationFile,'utf8'),before.installation);
      assert.equal(fs.readFileSync(f.file,'utf8'),before.plist);
      assert.equal(plan.archive.sha256,result.archive.sha256,'recovery receipts do not change the dry-run plan');
      assert.ok(fs.readFileSync(path.join(f.org,'events.jsonl'),'utf8').startsWith(before.events));
      invoke();assert.deepEqual(recoveryEvents(f),events,'a clean retry does not duplicate recovery receipts');
      const applied=operation==='migration'?f.migrate({expectedPlan:result.archive.sha256}):
        f.main([...f.argv,'--expected-plan',result.archive.sha256],f.args);
      assert.equal(applied.migrated??applied.upgraded,true);
    }
    assert.equal(f.calls.some(c=>['bootstrap','bootout'].includes(c.args[0])),false);
  });

for(const operation of ['migration','upgrade'])
  test(`${operation} preserves unidentified, live, reused-PID and unprobeable pass owners and dead control/promotion owners`,async t=>{
    const f=await (operation==='migration'?fixture(t):successor(t)),before=retained(f);
    const plan=operation==='migration'?f.migrate({dryRun:true}):f.plan();
    const apply=dryRun=>operation==='migration'?f.migrate({dryRun,expectedPlan:plan.archive.sha256}):
      f.main([...f.argv,...(dryRun?['--dry-run']:['--expected-plan',plan.archive.sha256])],f.args);
    const dead=2147483647,denied=2147483646,kill=process.kill;
    t.mock.method(process,'kill',(pid,signal)=>{
      if(pid===dead||pid===denied)throw Object.assign(Error('fixture probe'),{code:pid===dead?'ESRCH':'EPERM'});
      return kill(pid,signal);
    });
    for(const value of ['{',JSON.stringify({pid:dead}),JSON.stringify({pid:process.pid,identity:'old-birth'}),
        JSON.stringify({pid:denied,identity:'recorded-birth'})]){
      const lock=path.join(f.directory,'pass.lock');fs.mkdirSync(lock);fs.writeFileSync(path.join(lock,'owner.json'),value);
      for(const dryRun of [true,false]){
        assert.throws(()=>apply(dryRun),/lock/);assert.equal(fs.readFileSync(path.join(lock,'owner.json'),'utf8'),value);
        assert.deepEqual(retained(f),before);assert.equal(recoveryEvents(f).length,0);
      }
      fs.rmSync(lock,{recursive:true});
    }
    for(const lock of [path.join(f.directory,'control.lock'),path.join(f.identity,'lane-promote.lock')]){
      const bytes=JSON.stringify({pid:dead,at:'2026-10-27T20:15:22Z',argv:['line-service']});
      fs.mkdirSync(lock);fs.writeFileSync(path.join(lock,'owner.json'),bytes);
      for(const dryRun of [true,false]){assert.throws(()=>apply(dryRun),/lock/);assert.equal(fs.readFileSync(path.join(lock,'owner.json'),'utf8'),bytes);}
      fs.rmSync(lock,{recursive:true});assert.deepEqual(retained(f),before);
    }
  });

for(const operation of ['migration','upgrade'])
  test(`${operation} retains the dead pass owner when its append-only receipt cannot be committed`,async t=>{
    const f=await (operation==='migration'?fixture(t):successor(t)),before=retained(f),stale=stalePass(t,f);
    const recordLock=path.join(f.org,'lock');fs.mkdirSync(recordLock);fs.writeFileSync(path.join(recordLock,'pid'),String(process.pid));
    try{
      assert.throws(()=>operation==='migration'?f.migrate({dryRun:true}):f.plan(),/record is locked/);
      assert.deepEqual(JSON.parse(fs.readFileSync(path.join(stale.directory,'owner.json'))),stale.owner);
      assert.equal(fs.existsSync(`${stale.directory}.recovery`),false);
      assert.deepEqual(retained(f),before);
    }finally{fs.rmSync(recordLock,{recursive:true});}
  });
