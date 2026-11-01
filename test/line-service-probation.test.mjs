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
import {fixture,state} from './helpers/line-service-probation-fixture.mjs';

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
  const foreignArgs={repo:foreign.cwd,org:foreign.env.ORG_DIR,cwd:foreign.cwd,env:{...foreign.env,HERDR_ENV:'1',CODEX_THREAD_ID:foreignAgent.agent_session.value},call:()=>JSON.stringify({result:{agent:foreignAgent}})};
  assert.throws(()=>f.control(foreignArgs),/only canonical Brain development/);
  const inherited={GIT_DIR:process.env.GIT_DIR,GIT_WORK_TREE:process.env.GIT_WORK_TREE};
  try{
    Object.assign(process.env,{GIT_DIR:path.join(foreign.cwd,'.git'),GIT_WORK_TREE:foreign.cwd});
    assert.throws(()=>f.control(foreignArgs),/only canonical Brain development/,'inherited Git selectors cannot nominate a consumer as the issuing Brain source');
  }finally{for(const [key,value]of Object.entries(inherited))if(value===undefined)delete process.env[key];else process.env[key]=value;}
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

test('completed probation leaves separately qualified ordinary pin admission available without reviving trial authority',async t=>{
  const f=await fixture(t);f.authorize();f.enter();
  f.main(['probation-complete','--repo',f.cwd,'--org',f.org,'--id','original-trial'],f.args);
  assert.throws(f.admit,/completed/);
  const manifest=fs.readFileSync(path.join(f.next,'.release-manifest.json')),release={root:f.next,id:'trial',commit:JSON.parse(manifest).commit,protocol:1};
  // Synthetic coordinator evidence in private scratch, through the production
  // offer publisher. No real canary, check, READY flag or activation is claimed.
  const evidence=path.join(f.scratch,'synthetic-landing.json'),canary=path.join(f.scratch,'synthetic-canary.json');
  fs.writeFileSync(evidence,JSON.stringify({schema:'lane-validation/v1',executed:true,exit_code:0,node_version:'v20.19.4',command:'synthetic fixture only',
    started_at:'2026-10-30T00:00:00Z',finished_at:'2026-10-30T00:00:01Z',head:release.commit}));
  fs.writeFileSync(canary,JSON.stringify({fixture:true,status:'PASS',candidateCommit:release.commit}));
  const ref=file=>({file,sha256:sha(fs.readFileSync(file))});
  const packet={schema:'consumer-release-offer/v1',commit:release.commit,coordinatorItem:'G-1',manifestSha256:sha(manifest),
    canary:{status:'PASS',scope:'Synthetic isolated coordinator acceptance, not a real canary.',evidence:['installed','probation','soak'].map(stage=>({...ref(canary),stage}))},
    landing:{status:'PASS',scope:'Synthetic isolated producer receipt, not a real check.',evidence:[{...ref(evidence),changedFiles:[],reconciliation:'Identical fixture source commit.'}]},
    majors:{unresolved:[],corrections:[],scope:'Synthetic fixture has no Major findings.'}};
  const attestationDigest=sha(JSON.stringify(packet)),note=transact(f.org,()=>({add:[{type:'note.added',id:'G-1',decision:true,text:`Consumer release offer reconciled: ${attestationDigest}`}]}),{actor:f.agent.name}).added[0];
  const packetFile=path.join(f.scratch,'synthetic-offer.json');fs.writeFileSync(packetFile,JSON.stringify({...packet,attestationDigest,attestationSeq:note.seq}));
  const {publishConsumerOffer}=await f.module(f.next,'lib/consumer-offer.mjs');
  publishConsumerOffer({release,home:f.installationHome,canonical:f.cwd,file:packetFile,env:f.args.env});
  assert.throws(f.admit,/completed/,'qualification alone never replaces a project pin');
  fs.writeFileSync(path.join(f.cwd,'.herdr-release.json'),'{"release":"trial"}\n');f.git('add','.herdr-release.json');f.git('commit','-qm','Accept qualified fixture candidate');
  assert.equal(f.admit().root,f.next);assert.equal(f.admit().probation,undefined);
  assert.equal(selectRelease(f.cwd,f.installationHome).root,f.next);
  assert.deepEqual(fs.readFileSync(path.join(f.next,'.release-manifest.json')),manifest);
  assert.equal(loadEvents(f.org).events.filter(e=>e.type==='line-service.probation-authorized').length,1);
});

function switchArgs(f,id,from,to){return['probation-switch','--repo',f.cwd,'--org',f.org,'--trial','original-trial','--id',id,'--from-root',from,'--target-root',to];}
function switchPlan(f,id,from,to){return f.main([...switchArgs(f,id,from,to),'--dry-run'],f.args);}
function decide(f,text){return transact(f.org,()=>({add:[{type:'note.added',id:'G-1',decision:true,text}]}),{actor:f.agent.name}).added[0].seq;}
function switchApply(f,id,from,to){
  const plan=switchPlan(f,id,from,to),authority=decide(f,plan.required_decision);
  return f.main([...switchArgs(f,id,from,to),'--expected-plan',plan.plan_sha256,'--authority',String(authority)],f.args);
}
async function privatePass(f,root){
  const script=`import {createLineService} from ${JSON.stringify(pathToFileURL(path.join(root,'line-service/line-service.mjs')).href)};
    const service=createLineService({repo:${JSON.stringify(f.cwd)},org:${JSON.stringify(f.org)},to:'fixture-supervisor',haltAfter:100,
      command:()=>({status:0,stdout:'{"created":[]}'}),capacity:()=>({count:0,cap:2})});
    console.log(JSON.stringify(service.pass()));`;
  const r=spawnSync(process.execPath,['--input-type=module','-e',script],{cwd:f.cwd,env:f.env,encoding:'utf8'});
  assert.equal(r.status,0,r.stderr);assert.equal(JSON.parse(r.stdout).result,'pass-complete');
}

test('development recovery accepts a trailing-slash source and preserves original bytes through candidate recovery and return',async t=>{
  const f=await fixture(t,{development:true,phase:'stopped',sourceSuffix:'/'}),before=state(f);
  assert.equal(JSON.parse(before.installation).source,f.cwd+'/');
  for(const source of [f.bundle,f.cwd+'-foreign',path.relative(process.cwd(),f.cwd)]){
    fs.writeFileSync(f.installationFile,JSON.stringify({...JSON.parse(before.installation),source})+'\n');
    assert.throws(()=>f.control({dryRun:true}),/actual original Brain development installation/);
  }
  fs.writeFileSync(f.installationFile,before.installation);
  const preview=f.control({dryRun:true}),p=preview.scope.previous;
  assert.match(preview.plan_sha256,/^[a-f0-9]{64}$/);assert.match(preview.required_decision,/^Brain probation authorized: /);
  assert.equal(p.kind,'development-recovery');assert.equal(p.source.common,f.identity);
  assert.equal(p.source.tree,f.git('rev-parse',`${p.release.commit}^{tree}`));
  assert.equal(p.original.installation,before.installation);assert.equal(p.original.plist,before.plist);
  assert.deepEqual(state(f),before);assert.equal(fs.existsSync(p.release.root),false);
  f.authorize();
  assert.equal(fs.readFileSync(f.installationFile,'utf8'),before.installation);
  assert.equal(fs.readFileSync(f.file,'utf8'),before.plist);
  const original=JSON.parse(fs.readFileSync(path.join(f.directory,'probation/original-trial.json'))).scope.previous.original;
  assert.equal(original.installation,before.installation);assert.equal(original.plist,before.plist);
  // Equal path identity never excuses changing captured installation/plist bytes.
  fs.writeFileSync(f.installationFile,JSON.stringify({...JSON.parse(before.installation),source:f.cwd})+'\n');
  assert.throws(()=>switchPlan(f,'entry',f.cwd,f.next),/initial entry differs/);
  fs.writeFileSync(f.installationFile,before.installation);
  fs.appendFileSync(f.file,'\n');
  assert.throws(()=>switchPlan(f,'entry',f.cwd,f.next),/initial entry differs/);
  fs.writeFileSync(f.file,before.plist);
  const recovery=p.release.root;
  assert.equal(sha(fs.readFileSync(path.join(recovery,'.release-manifest.json'))),p.manifest_sha256);
  assert.equal(fs.statSync(recovery).mode&0o222,0);
  for(const [file,e]of Object.entries(p.source.files)){
    assert.deepEqual(payloadEntry(recovery,file),e);
    assert.equal(fs.statSync(path.join(recovery,file)).mode&0o222,0);
  }
  const blobs=new Map(f.git('ls-tree','-r',p.release.commit).split('\n').map(row=>{const [entry,file]=row.split('\t');return[file,entry.split(' ')[2]];}));
  const files=Object.keys(p.source.files);
  for(let start=0;start<files.length;start+=128){const batch=files.slice(start,start+128);
    assert.deepEqual(f.git('hash-object','--no-filters','--',...batch.map(file=>path.join(recovery,file))).split('\n'),batch.map(file=>blobs.get(file)));}
  assert.throws(()=>requireHomeRelease('runtime',null,f.installationHome),/ENOENT/);
  assert.throws(()=>selectRelease(f.cwd,f.installationHome,{pin:{release:'trial'}}),/READY/);
  const entry=switchApply(f,'entry',f.cwd,f.next);assert.equal(entry.runtime_started,false);
  const entryArchive=JSON.parse(fs.readFileSync(path.join(f.directory,'probation-switches/entry.json')));
  assert.equal(entryArchive.previous_source,f.cwd);
  assert.equal(entryArchive.before.installation,before.installation);assert.equal(entryArchive.before.plist,before.plist);
  assert.equal(f.main(['restart','--repo',f.cwd,'--org',f.org],f.args).restarted,true);await privatePass(f,f.next);
  f.main(['stop','--repo',f.cwd,'--org',f.org],f.args);
  // The retained payload remains executable after canonical product changes.
  fs.appendFileSync(path.join(f.cwd,'bin/org.mjs'),'\n// Subsequent canonical source\n');f.git('add','bin/org.mjs');f.git('commit','-qm','Move canonical development source');
  const rollback=switchApply(f,'recovery',f.next,recovery);assert.equal(rollback.runtime.root,recovery);
  assert.equal(fs.readFileSync(f.file,'utf8'),p.derived.plist);
  const {main:recoveryMain}=await f.module(recovery,'line-service/launchd.mjs');
  assert.equal(recoveryMain(['restart','--repo',f.cwd,'--org',f.org],f.args).restarted,true);await privatePass(f,recovery);
  recoveryMain(['stop','--repo',f.cwd,'--org',f.org],f.args);
  // Exercise the actual sealed package's switch reader/parser for the return.
  const main=f.main;f.main=recoveryMain;
  const returned=switchApply(f,'return',recovery,f.next);f.main=main;
  assert.equal(returned.trial,'original-trial');
  assert.equal(f.main(['restart','--repo',f.cwd,'--org',f.org],f.args).restarted,true);await privatePass(f,f.next);
  const events=loadEvents(f.org).events;
  assert.equal(events.filter(e=>e.type==='line-service.probation-authorized').length,1);
  assert.deepEqual(events.filter(e=>e.type==='line-service.probation-switched').map(e=>e.id),['entry','recovery','return']);
  assert.equal(events.filter(e=>e.type==='line-service.cutover').length,1);
  assert.equal(fs.readFileSync(f.retained,'utf8'),f.jobs);
  assert.equal(JSON.parse(fs.readFileSync(f.installationFile)).phase,'installed');
  assert.equal(JSON.parse(fs.readFileSync(path.join(recovery,'.release-manifest.json'))).acceptance.ready,false);
});

test('development recovery refuses foreign issuance changed plan native owner STOP damaged mutable redirected and incompatible recovery',async t=>{
  const f=await fixture(t,{development:true}),before=state(f),plan=f.control({dryRun:true});
  const {probationControl}=await f.module(f.next,'line-service/probation.mjs');
  assert.throws(()=>probationControl({...f.args,id:'foreign-tool',fromRoot:f.cwd,targetRoot:f.next,developmentRecovery:true,dryRun:true}),/not a git repository|canonical checkout/);
  assert.throws(()=>f.control({env:{...f.args.env,CODEX_THREAD_ID:'stale'}}),/native caller/);
  assert.throws(()=>f.control({fromRoot:f.bundle,dryRun:true}),/actual canonical Brain/);
  assert.throws(()=>f.control({expectedPlan:'0'.repeat(64),authority:1}),/plan changed/);
  assert.deepEqual(state(f),before);
  f.authorize();const recovery=plan.scope.previous.release.root;
  let p=switchPlan(f,'entry',f.cwd,f.next);const authority=decide(f,p.required_decision),argv=switchArgs(f,'entry',f.cwd,f.next);
  assert.throws(()=>f.main([...argv,'--expected-plan','0'.repeat(64),'--authority',String(authority)],f.args),/plan changed/);
  for(const name of ['STOP','HOLD']){
    const file=path.join(f.cwd,'.lane/supervisor',name);fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,'held');
    assert.throws(()=>switchPlan(f,'entry',f.cwd,f.next),/STOP\/HOLD/);fs.unlinkSync(file);
  }
  f.setLoaded(true);assert.throws(()=>switchPlan(f,'entry',f.cwd,f.next),/positively stopped/);f.setLoaded(false);
  fs.chmodSync(recovery,0o755);assert.throws(()=>switchPlan(f,'entry',f.cwd,f.next),/writable/);fs.chmodSync(recovery,0o555);
  const payload=path.join(recovery,'bin/org.mjs'),bytes=fs.readFileSync(payload);
  fs.chmodSync(payload,0o644);fs.appendFileSync(payload,'\n// damaged');fs.chmodSync(payload,0o444);
  assert.throws(()=>switchPlan(f,'entry',f.cwd,f.next),/payload mismatch/);
  fs.chmodSync(payload,0o644);fs.writeFileSync(payload,bytes);fs.chmodSync(payload,plan.scope.previous.source.files['bin/org.mjs'].mode==='100755'?0o555:0o444);
  fs.renameSync(recovery,recovery+'.saved');fs.symlinkSync(recovery+'.saved',recovery);
  assert.throws(()=>switchPlan(f,'entry',f.cwd,f.next),/identity\/node changed/);fs.unlinkSync(recovery);fs.renameSync(recovery+'.saved',recovery);
  assert.equal(switchPlan(f,'entry',f.cwd,f.next).plan_sha256,p.plan_sha256);
  transact(f.org,()=>({add:[{type:'item.future',id:'ENG-1'}]}));
  assert.throws(()=>switchPlan(f,'entry',f.cwd,f.next),/record-incompatible/);
  assert.equal(fs.existsSync(path.join(f.directory,'probation-switches')),false);
  assert.equal(fs.readFileSync(f.retained,'utf8'),f.jobs);
});

test('development recovery preserves original refused installation and UNKNOWN authorization and switch attempts at every boundary',async t=>{
  const f=await fixture(t,{development:true,phase:'uncertain-or-refused'}),preview=f.control({dryRun:true});
  assert.match(preview.scope.previous.original.installation,/Original refused bootstrap/);
  assert.equal(JSON.parse(preview.scope.previous.derived.installation).phase,'installed');
  const authority=decide(f,preview.required_decision);
  assert.throws(()=>f.control({expectedPlan:preview.plan_sha256,authority,fault:stage=>{if(stage==='recovery')throw Error('lost seal reply');}}),/lost seal reply/);
  const original=fs.readFileSync(path.join(f.directory,'probation/original-trial.json'));
  for(const id of ['original-trial','replacement'])assert.throws(()=>f.control({id,dryRun:true}),/existing\/UNKNOWN/);
  assert.deepEqual(fs.readFileSync(path.join(f.directory,'probation/original-trial.json')),original);
  for(const stage of ['intent','plist','installation'])await t.test(stage,async st=>{
    const g=await fixture(st,{development:true});g.authorize();
    const p=switchPlan(g,'entry',g.cwd,g.next),seq=decide(g,p.required_decision);
    const {probationSwitch}=await g.module(g.next,'line-service/probation-switch.mjs');
    const args={...g.args,id:'entry',trial:'original-trial',fromRoot:g.cwd,targetRoot:g.next,expectedPlan:p.plan_sha256,authority:seq};
    assert.throws(()=>probationSwitch({...args,fault:phase=>{if(phase===stage)throw Error('lost switch reply');}}),/lost switch reply/);
    const intent=path.join(g.directory,'probation-switches/entry.json'),bytes=fs.readFileSync(intent);
    for(const id of ['entry','replacement'])assert.throws(()=>probationSwitch({...args,id,dryRun:true}),/UNKNOWN probation switch/);
    const current=JSON.parse(fs.readFileSync(g.installationFile)).source;
    const {main}=await g.module(current,'line-service/launchd.mjs');
    assert.throws(()=>main(['restart','--repo',g.cwd,'--org',g.org],g.args),/UNKNOWN probation switch/);
    assert.deepEqual(fs.readFileSync(intent),bytes);assert.equal(fs.readFileSync(g.retained,'utf8'),g.jobs);
    assert.equal(g.calls.some(c=>c.args[0]==='bootstrap'),false);
  });
});

test('development recovery child launch captures sealed provenance and withdrawal preserves captured callbacks while closing new admission',async t=>{
  const f=await fixture(t,{development:true}),preview=f.control({dryRun:true});f.authorize();
  const recovery=preview.scope.previous.release.root;
  switchApply(f,'entry',f.cwd,f.next);switchApply(f,'recovery',f.next,recovery);fs.unlinkSync(f.stop);
  const d=dispatchFixture(t,{project:f}),topic=`line-${d.item.toLowerCase()}-1`,laneCLI=path.join(d.root,'bin/lane');
  fs.writeFileSync(laneCLI,fs.readFileSync(laneCLI,'utf8').replace('lane/topic',`lane/${topic}`));
  const {createLineService}=await f.module(recovery,'line-service/line-service.mjs');let launches=0;
  const service=createLineService({repo:f.cwd,org:f.org,to:f.agent.name,runtimeHome:f.installationHome,env:{...d.env,HERDR_BRAIN_ROOT:f.cwd},maxStarts:1,haltAfter:100,capacity:()=>({count:0,cap:4}),
    recordNotice:()=>({state:'record-only'}),command:(exe,args,options)=>{
      if(!args[0].endsWith('/dispatch/dispatch.mjs'))return{status:0,stdout:'{"created":[]}'};
      launches++;assert.equal(args[0],path.join(recovery,'dispatch/dispatch.mjs'));assert.equal(options.env.HERDR_BRAIN_ROOT,undefined);
      return spawnSync(exe,[...args.filter(a=>a!=='--detach'),'--lane-cli',laneCLI,'--watch-cli',path.join(d.root,'bin/watch')],options);
    }});
  assert.equal(service.pass().result,'pass-complete');assert.equal(launches,1);
  const {file,job}=d.jobs().map(file=>({file,job:JSON.parse(fs.readFileSync(file))})).find(x=>x.job.item===d.item);
  assert.equal(job.stage,'complete');assert.equal(job.release.root,recovery);assert.equal(job.probation.id,'original-trial');
  assert.equal(d.show(job.run).owner.release.root,recovery);assert.equal(promptCalls(d).length,1);
  f.withdraw();
  const {checkDispatchEligibility}=await f.module(recovery,'dispatch/launch-guard.mjs');
  assert.throws(()=>checkDispatchEligibility(job,file,{boundary:'launch'}),/withdrawn/);checkDispatchEligibility(job,file,{boundary:'prompt'});
  const {selectedReviewConsumer}=await f.module(recovery,'line-service/review.mjs');assert.equal(selectedReviewConsumer({repo:f.cwd,run:d.show(job.run)}).recordRoot,recovery);
  const {main:recoveryMain}=await f.module(recovery,'line-service/launchd.mjs');
  recoveryMain(['stop','--repo',f.cwd,'--org',f.org],f.args);
  assert.throws(()=>switchPlan(f,'return',recovery,f.next),/withdrawn/);
  assert.equal(fs.readFileSync(f.retained,'utf8'),f.jobs);
});
