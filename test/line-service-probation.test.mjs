import test from './helpers/bounded-test.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {configFixture} from './helpers/config-home-fixture.mjs';
import {copyProduct,productFiles,payloadEntry} from '../lib/product-files.mjs';
import {freezeReleaseValidation} from '../herdr/validation-admission.mjs';
import {loadEvents,transact} from '../lib/store.mjs';
import {gitProject} from '../lib/project.mjs';
import {lineDirectory} from '../line-service/cutoff.mjs';
import {launchPlist} from '../line-service/plist.mjs';
import {requireReadyAcceptance,selectRelease,requireHomeRelease} from '../lib/releases.mjs';
import {fixture as dispatchFixture,promptCalls} from '../dispatch/test/dispatch-fixture.mjs';

const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
async function fixture(t){
  const f=configFixture(t,{custom:true}),org=f.env.ORG_DIR;
  // A private canonical Brain source, record, fleet and native observations.
  // Every release/READY/native receipt here is synthetic offline fixture data.
  copyProduct(path.resolve(import.meta.dirname,'..'),f.cwd);
  fs.writeFileSync(path.join(f.cwd,'.promote.json'),'{"to":"fixture-supervisor"}\n');
  fs.writeFileSync(path.join(f.cwd,'.herdr-release.json'),'{"release":"compatible"}\n');
  f.git('add','.');f.git('commit','-qm','Private Brain source');
  const commit=f.git('rev-parse','HEAD'),identity=gitProject(f.cwd).identity,directory=lineDirectory(org,identity);
  fs.mkdirSync(directory,{recursive:true});
  const file=path.join(directory,'service.plist'),installationFile=path.join(directory,'installation.json'),stop=path.join(directory,'STOP');
  const installation={target:`gui/${process.getuid()}/dev.herdr.line.${path.basename(directory)}`,repo:f.cwd,org,source:f.cwd,node:process.execPath,file,phase:'installed'};
  fs.writeFileSync(installationFile,JSON.stringify(installation)+'\n');
  fs.writeFileSync(file,launchPlist({label:`dev.herdr.line.${path.basename(directory)}`,repo:f.cwd,org,to:'fixture-supervisor',herdr:'/saved/bin/herdr',socket:'/saved/native.sock',directory,node:process.execPath,source:f.cwd}));
  fs.writeFileSync(stop,'Original service STOP\n');
  const boundary={id:'original-cutover',project:identity,repo:f.cwd,org,source:f.cwd,main:'main',canonical_head:commit};
  transact(org,()=>({add:[{type:'item.added',id:'G-1',kind:'goal',title:'Private trial owner'}]}));
  transact(org,()=>({add:['line-service.cutover','line-service.phase0'].map(type=>({...boundary,type}))}));
  const retained=path.join(org,'dispatch/retained.json');fs.mkdirSync(path.dirname(retained),{recursive:true});
  const jobs=JSON.stringify({stage:'UNKNOWN',root:f.bundle,watcher:{callback:'original-review',recipient:'fixture-supervisor'},sharedObserver:{root:f.bundle,registration:'original'}});
  fs.writeFileSync(retained,jobs);
  const agent=f.observation.agents[0],env={...f.env,HERDR_ENV:'1',HERDR_PANE_ID:agent.pane_id,HERDR_WORKSPACE_ID:agent.workspace_id,CODEX_THREAD_ID:agent.agent_session.value};
  const call=()=>JSON.stringify({result:{agent}}),calls=[];let loaded=false,refusal;
  const command=(exe,args,options)=>{
    calls.push({exe,args});
    if(exe==='/usr/bin/plutil')return spawnSync(exe,args,options);
    assert.equal(exe,'/bin/launchctl');
    if(args[0]==='print')return loaded?{status:0,stdout:'loaded'}:{status:113,stderr:'Could not find service in domain'};
    if(args[0]==='bootstrap'){if(refusal)return{status:1,stderr:refusal};loaded=true;return{status:0};}
    if(args[0]==='bootout'){loaded=false;return{status:0};}
    throw Error('unexpected native operation');
  };
  const module=(root,file)=>import(pathToFileURL(path.join(root,file)).href),args={repo:f.cwd,org,cwd:f.cwd,env,call,command,home:f.installationHome};
  const {migrateRuntime}=await module(f.bundle,'line-service/migrate-runtime.mjs');
  const migration={...args,id:'fixture-migration'},plan=migrateRuntime({...migration,dryRun:true});
  migrateRuntime({...migration,expectedPlan:plan.archive.sha256});
  const previous={installation:fs.readFileSync(installationFile,'utf8'),plist:fs.readFileSync(file,'utf8')};
  const next=f.release('trial',{commit});fs.unlinkSync(path.join(next,'.release-acceptance.json'));
  const frozenFile=path.join(next,'.release-validation.json');
  const frozen=freezeReleaseValidation(f.cwd,'trial',frozenFile,env,{commit,mode:'routine'});
  // Synthetic package provenance follows the production routine manifest
  // contract; it is not producer/live/stable evidence for a real release.
  const runtime=productFiles(next).sort();
  fs.writeFileSync(frozenFile,JSON.stringify({...frozen,validation:{cwd:f.cwd,common:identity,commit,tree:f.git('rev-parse',`${commit}^{tree}`),
    inventorySha256:'0'.repeat(64),runtimeSha256:sha(JSON.stringify(Object.fromEntries(runtime.map(file=>[file,payloadEntry(next,file)])))),routine:{fullCoverage:'UNRUN'}}}));
  const manifest=spawnSync(process.execPath,[path.resolve('herdr/releases.mjs'),'manifest',next],{env,encoding:'utf8'});assert.equal(manifest.status,0,manifest.stderr);
  const {probationControl}=await module(f.cwd,'line-service/probation.mjs');
  const control=extra=>probationControl({...args,id:'original-trial',fromRoot:f.bundle,targetRoot:next,...extra});
  const authorize=()=>{
    const preview=control({dryRun:true});
    const note=transact(org,()=>({add:[{type:'note.added',id:'G-1',decision:true,text:preview.required_decision}]}),{actor:agent.name}).added[0];
    return control({expectedPlan:preview.plan_sha256,authority:note.seq});
  };
  const {main}=await module(next,'line-service/launchd.mjs');
  const upgrade=['upgrade','--repo',f.cwd,'--org',org,'--id','trial-entry','--from-root',f.bundle,'--target-root',next];
  const enter=()=>{const p=main([...upgrade,'--dry-run'],args);return main([...upgrade,'--expected-plan',p.archive.sha256],args);};
  const withdraw=()=>main(['probation-withdraw','--repo',f.cwd,'--org',org,'--id','original-trial'],args);
  const rollback=['upgrade','--repo',f.cwd,'--org',org,'--id','trial-rollback','--from-root',next,'--target-root',f.bundle,'--rollback'];
  const back=extra=>{const p=main([...rollback,'--dry-run'],args);return main([...rollback,'--expected-plan',p.archive.sha256],{...args,...extra});};
  const {acceptedRuntime}=await module(next,'line-service/runtime.mjs');
  const admit=()=>acceptedRuntime(f.cwd,{root:next,home:f.installationHome});
  return{...f,org,identity,directory,file,installationFile,stop,retained,jobs,agent,args,module,next,control,authorize,main,enter,withdraw,back,rollback,admit,previous,calls,
    setLoaded:v=>loaded=v,setRefusal:v=>refusal=v};
}
const state=f=>({installation:fs.readFileSync(f.installationFile,'utf8'),plist:fs.readFileSync(f.file,'utf8'),events:fs.readFileSync(path.join(f.org,'events.jsonl'),'utf8'),jobs:fs.readFileSync(f.retained,'utf8')});

test('Brain probation admits exactly one sealed non-READY tuple while ordinary pin and home-policy admission still refuse',async t=>{
  const f=await fixture(t),before=state(f),preview=f.control({dryRun:true});
  assert.deepEqual(state(f),before);assert.equal(preview.scope.stable_ready,false);
  assert.throws(f.admit,/accepted project pin/);
  assert.throws(()=>f.control({expectedPlan:preview.plan_sha256,authority:1}),/recorded supervisor trial authority/);
  assert.deepEqual(state(f),before);
  const authority=f.authorize();assert.equal(authority.stable_ready,false);assert.equal(authority.runtime_started,false);
  assert.equal(f.admit().probation.id,'original-trial');
  const manifest=path.join(f.next,'.release-manifest.json'),sealed=fs.readFileSync(manifest);
  fs.appendFileSync(manifest,'\n');assert.throws(f.admit,/tuple drifted/);fs.writeFileSync(manifest,sealed);
  assert.throws(()=>f.control({id:'replacement',dryRun:true}),/one probation already exists/);
  const release={root:f.next,id:'trial',commit:preview.scope.candidate.release.commit,protocol:1};
  assert.throws(()=>requireReadyAcceptance(release,f.installationHome),/READY/);
  assert.throws(()=>requireHomeRelease('trial',null,f.installationHome),/READY/);
  fs.writeFileSync(path.join(f.cwd,'.herdr-release.json'),'{"release":"trial"}\n');f.git('add','.herdr-release.json');f.git('commit','-qm','Rejected ordinary pin control');
  assert.throws(()=>selectRelease(f.cwd,f.installationHome),/READY/);
  assert.equal(f.admit().commit,release.commit,'moving source main cannot reselect the trial');
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(f.next,'.release-manifest.json'))).acceptance,{ran:false,ready:false});
  assert.equal(f.main(['probation-complete','--repo',f.cwd,'--org',f.org,'--id','original-trial'],f.args).admissions,false);
  assert.throws(f.admit,/completed/);
  assert.throws(()=>f.control({id:'replacement',dryRun:true}),/existing\/UNKNOWN probation/);
});

test('probation authorization refuses wrong project/source, native session, STOP/HOLD, dirty source, missing recovery and tuple drift before writes',async t=>{
  const f=await fixture(t),before=state(f),preview=f.control({dryRun:true});
  assert.throws(()=>f.control({env:{...f.args.env,CODEX_THREAD_ID:'stale'}}),/native caller/);
  const changed={...f.agent,name:'another-native-agent'};
  assert.throws(()=>f.control({call:()=>JSON.stringify({result:{agent:changed}})}),/recorded actual canonical/);
  const {probationControl}=await f.module(f.bundle,'line-service/probation.mjs');
  assert.throws(()=>probationControl({...f.args,id:'wrong-source',fromRoot:f.bundle,targetRoot:f.next,dryRun:true}),/not a git repository|canonical checkout/);
  const foreign=configFixture(t,{custom:true});
  fs.writeFileSync(path.join(foreign.cwd,'.promote.json'),'{"to":"fixture-supervisor"}');foreign.git('add','.promote.json');foreign.git('commit','-qm','Foreign supervisor');
  const foreignAgent=foreign.observation.agents[0];
  assert.throws(()=>f.control({repo:foreign.cwd,org:foreign.env.ORG_DIR,cwd:foreign.cwd,env:{...foreign.env,HERDR_ENV:'1',CODEX_THREAD_ID:foreignAgent.agent_session.value},call:()=>JSON.stringify({result:{agent:foreignAgent}})}),/only canonical Brain development/);
  for(const name of ['STOP','HOLD']){
    const file=path.join(f.cwd,'.lane/supervisor',name);fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,'hold');
    assert.throws(()=>f.control({dryRun:true}),/STOP\/HOLD/);fs.unlinkSync(file);
  }
  fs.writeFileSync(path.join(f.cwd,'dirty'),'changed');assert.throws(()=>f.control({dryRun:true}),/clean canonical/);fs.unlinkSync(path.join(f.cwd,'dirty'));
  f.setLoaded(true);assert.throws(()=>f.control({dryRun:true}),/positively stopped/);f.setLoaded(false);
  const original=fs.readFileSync(path.join(f.next,'.release-manifest.json'));
  fs.appendFileSync(path.join(f.next,'bin/org.mjs'),'\n// candidate drift');assert.throws(()=>f.control({dryRun:true}),/incomplete release/);
  const payload=fs.readFileSync(path.join(f.cwd,'bin/org.mjs'));fs.writeFileSync(path.join(f.next,'bin/org.mjs'),payload);
  assert.deepEqual(fs.readFileSync(path.join(f.next,'.release-manifest.json')),original);
  fs.renameSync(f.bundle,f.bundle+'.missing');assert.throws(()=>f.control({dryRun:true}),/ENOENT/);fs.renameSync(f.bundle+'.missing',f.bundle);
  assert.deepEqual(state(f),before);assert.equal(f.control({dryRun:true}).plan_sha256,preview.plan_sha256);
});

test('withdrawal stops controller/new admissions and archived rollback restores exact installation/plist without touching original callbacks',async t=>{
  const f=await fixture(t);f.authorize();const entered=f.enter();
  assert.equal(entered.runtime.probation.id,'original-trial');assert.equal(entered.runtime_started,false);
  const archive=JSON.parse(fs.readFileSync(entered.archive.file));
  assert.equal(archive.before.installation,f.previous.installation);assert.equal(archive.before.plist,f.previous.plist);
  assert.equal(f.main(['restart','--repo',f.cwd,'--org',f.org],f.args).restarted,true);
  const {createLineService}=await f.module(f.next,'line-service/line-service.mjs');
  const service=createLineService({repo:f.cwd,org:f.org,to:f.agent.name,runtimeHome:f.installationHome,env:f.env,haltAfter:100,
    command:()=>({status:0,stdout:'{"created":[]}'}),capacity:()=>({count:0,cap:2})});
  assert.equal(service.pass().result,'pass-complete');
  fs.writeFileSync(path.join(f.cwd,'ordinary-source'),'main moves');f.git('add','ordinary-source');f.git('commit','-qm','Ordinary source work');
  assert.equal(f.admit().root,f.next);
  assert.equal(f.withdraw().admissions,false);assert.throws(f.admit,/withdrawn/);
  assert.equal(f.withdraw().existing,true);
  f.main(['stop','--repo',f.cwd,'--org',f.org],f.args);
  assert.equal(f.back().direction,'rollback');
  assert.equal(fs.readFileSync(f.installationFile,'utf8'),f.previous.installation);
  assert.equal(fs.readFileSync(f.file,'utf8'),f.previous.plist);
  assert.equal(fs.readFileSync(f.retained,'utf8'),f.jobs);
  const {main}=await f.module(f.bundle,'line-service/launchd.mjs');
  assert.equal(main(['restart','--repo',f.cwd,'--org',f.org],f.args).restarted,true);
  assert.equal(loadEvents(f.org).events.filter(e=>e.type==='line-service.probation-authorized').length,1);
});

test('candidate-started dispatcher and watcher retain immutable provenance and their captured worker survives withdrawal',async t=>{
  const f=await fixture(t);f.authorize();f.enter();fs.unlinkSync(f.stop);
  const d=dispatchFixture(t,{project:f}),topic=`line-${d.item.toLowerCase()}-1`,laneCLI=path.join(d.root,'bin/lane');
  fs.writeFileSync(laneCLI,fs.readFileSync(laneCLI,'utf8').replace('lane/topic',`lane/${topic}`));
  const {createLineService}=await f.module(f.next,'line-service/line-service.mjs');let launches=0;
  const service=createLineService({repo:f.cwd,org:f.org,to:f.agent.name,runtimeHome:f.installationHome,env:{...d.env,HERDR_BRAIN_ROOT:f.cwd},maxStarts:1,haltAfter:100,capacity:()=>({count:0,cap:4}),
    recordNotice:()=>({state:'record-only'}),command:(exe,args,options)=>{
      if(!args[0].endsWith('/dispatch/dispatch.mjs'))return{status:0,stdout:'{"created":[]}'};
      launches++;assert.equal(args[0],path.join(f.next,'dispatch/dispatch.mjs'));assert.equal(options.env.HERDR_BRAIN_ROOT,undefined);
      return spawnSync(exe,[...args.filter(a=>a!=='--detach'),'--lane-cli',laneCLI,'--watch-cli',path.join(d.root,'bin/watch')],options);
    }});
  assert.equal(service.pass().result,'pass-complete');assert.equal(launches,1);
  const jobs=d.jobs().map(file=>({file,job:JSON.parse(fs.readFileSync(file))})).filter(x=>x.job.item===d.item);
  assert.equal(jobs.length,1,fs.readFileSync(path.join(f.directory,'passes.jsonl'),'utf8'));
  const {file,job}=jobs[0];assert.equal(job.stage,'complete');assert.equal(job.release.root,f.next);assert.equal(job.probation.id,'original-trial');
  assert.equal(d.show(job.run).owner.release.root,f.next);assert.equal(promptCalls(d).length,1);
  // Preserve the actual watcher argv/runtime capture, including a shared mode
  // registration when used; the trial never rewrites saved requests.
  assert.equal(job.watcher.pid>0,true);
  assert.equal(job.invocation['watch-cli'],path.join(d.root,'bin/watch'),'only the native watcher process is scripted');
  const {operationFile}=await f.module(f.next,'lib/releases.mjs');
  assert.equal(operationFile('watch/watch.mjs',job.release),path.join(f.next,'watch/watch.mjs'));
  const {selectedReviewConsumer}=await f.module(f.next,'line-service/review.mjs');
  assert.equal(selectedReviewConsumer({repo:f.cwd,run:d.show(job.run)}).recordRoot,f.next);
  const {checkDispatchEligibility}=await f.module(f.next,'dispatch/launch-guard.mjs');
  assert.throws(()=>checkDispatchEligibility({...job,ownership:{...job.ownership,generation:job.ownership.generation+1}},file,{boundary:'launch'}),/RUN_OWNED_ELSEWHERE/);
  f.withdraw();
  assert.throws(()=>checkDispatchEligibility(job,file,{boundary:'launch'}),/withdrawn/);
  checkDispatchEligibility(job,file,{boundary:'prompt'});
  assert.equal(fs.readFileSync(f.retained,'utf8'),f.jobs);
});

test('probation rollback retains a missing target, record incompatibility and original UNKNOWN intent without replacement',async t=>{
  const f=await fixture(t);f.authorize();f.enter();f.withdraw();const before=state(f);
  fs.renameSync(f.bundle,f.bundle+'.missing');assert.throws(()=>f.back(),/ENOENT/);fs.renameSync(f.bundle+'.missing',f.bundle);assert.deepEqual(state(f),before);
  transact(f.org,()=>({add:[{type:'item.future',id:'ENG-1'}]}));
  assert.throws(()=>f.back(),/record-incompatible/);
  // Keep this failure; a separate fixture owns the independent UNKNOWN case.
  const g=await fixture(t);g.authorize();g.enter();g.withdraw();
  const {upgradeRuntime}=await g.module(g.next,'line-service/upgrade-runtime.mjs');
  const args={...g.args,id:'trial-rollback',fromRoot:g.next,targetRoot:g.bundle,rollback:true};
  const plan=upgradeRuntime({...args,dryRun:true});
  assert.throws(()=>upgradeRuntime({...args,expectedPlan:plan.archive.sha256,fault:phase=>{if(phase==='plist')throw Error('lost rollback reply');}}),/lost rollback reply/);
  const intent=path.join(g.directory,'upgrades/trial-rollback.json'),bytes=fs.readFileSync(intent);
  for(const id of ['trial-rollback','replacement'])assert.throws(()=>upgradeRuntime({...args,id,dryRun:true}),/UNKNOWN runtime upgrade/);
  assert.deepEqual(fs.readFileSync(intent),bytes);assert.equal(fs.readFileSync(g.retained,'utf8'),g.jobs);
  assert.equal(g.calls.some(c=>c.args[0]==='bootstrap'),false);
});

test('trial restart native refusal stops that original effect and leaves STOP and recovery archives intact',async t=>{
  const f=await fixture(t);f.authorize();const entry=f.enter();f.setRefusal('native bootstrap refused');
  assert.throws(()=>f.main(['restart','--repo',f.cwd,'--org',f.org],f.args),/native bootstrap refused/);
  assert.equal(f.calls.filter(c=>c.args[0]==='bootstrap').length,1);
  assert.match(fs.readFileSync(f.stop,'utf8'),/Restart refused or uncertain/);
  assert.ok(fs.existsSync(entry.archive.file));assert.equal(fs.readFileSync(f.retained,'utf8'),f.jobs);
});
