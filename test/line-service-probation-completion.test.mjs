import test from './helpers/bounded-test.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {fixture,state} from './helpers/line-service-probation-fixture.mjs';
import {loadEvents,transact} from '../lib/store.mjs';
import {noticeLock} from '../supervisor/notice-lock.mjs';
import {copyProduct,productFiles,payloadEntry} from '../lib/product-files.mjs';
import {freezeReleaseValidation} from '../herdr/validation-admission.mjs';
import {requireRecordCompatibility} from '../lib/record-compatibility.mjs';

const sha=b=>createHash('sha256').update(b).digest('hex');
const decide=(f,text)=>transact(f.org,()=>({add:[{type:'note.added',id:'G-1',decision:true,text}]}),{actor:f.agent.name}).added[0].seq;
function pin(f,id){fs.writeFileSync(path.join(f.cwd,'.herdr-release.json'),JSON.stringify({release:id})+'\n');f.git('add','.herdr-release.json');f.git('commit','-qm','Private fixture pin');}
async function enter(t,options={}){
  const f=await fixture(t,{development:true,...options});f.authorize();
  const argv=['probation-switch','--repo',f.cwd,'--org',f.org,'--trial','original-trial','--id','entry','--from-root',f.cwd,'--target-root',f.next];
  const p=f.main([...argv,'--dry-run'],f.args),authority=decide(f,p.required_decision);
  f.main([...argv,'--expected-plan',p.plan_sha256,'--authority',String(authority)],f.args);
  f.complete=extra=>f.main(['probation-complete','--repo',f.cwd,'--org',f.org,'--id','original-trial',...extra],f.args);
  return f;
}

async function enterSuccessor(f,{productRoot}={}){
  const original=loadEvents(f.org).events.find(e=>e.type==='line-service.probation-authorized'),recovery=original.scope.previous.release.root;
  const argv=['probation-switch','--repo',f.cwd,'--org',f.org,'--trial','original-trial','--id','recovery','--from-root',f.next,'--target-root',recovery];
  const p=f.main([...argv,'--dry-run'],f.args),authority=decide(f,p.required_decision);
  f.main([...argv,'--expected-plan',p.plan_sha256,'--authority',String(authority)],f.args);
  const commit=f.git('rev-parse','HEAD'),next=f.release('successor',{commit});
  if(productRoot)copyProduct(productRoot,next);
  fs.unlinkSync(path.join(next,'.release-acceptance.json'));
  const frozenFile=path.join(next,'.release-validation.json'),frozen=freezeReleaseValidation(f.cwd,'successor',frozenFile,f.env,{commit,mode:'routine'});
  fs.writeFileSync(frozenFile,JSON.stringify({...frozen,validation:{cwd:f.cwd,common:f.identity,commit,tree:f.git('rev-parse',`${commit}^{tree}`),
    inventorySha256:'0'.repeat(64),runtimeSha256:sha(JSON.stringify(Object.fromEntries(productFiles(next).sort().map(file=>[file,payloadEntry(next,file)])))),routine:{fullCoverage:'UNRUN'}}}));
  const manifest=spawnSync(process.execPath,[path.resolve('herdr/releases.mjs'),'manifest',next],{env:f.env,encoding:'utf8'});assert.equal(manifest.status,0,manifest.stderr);
  const {probationSuccessor}=await f.module(f.cwd,'line-service/probation-successor.mjs');
  const successorArgs={...f.args,id:'successor-entry',trial:original.id,fromRoot:recovery,targetRoot:next};
  const preview=probationSuccessor({...successorArgs,dryRun:true}),note=decide(f,preview.required_decision);
  probationSuccessor({...successorArgs,expectedPlan:preview.plan_sha256,authority:note});
  f.next=next;f.main=(await f.module(next,'line-service/launchd.mjs')).main;
  return{recovery,original};
}

// Production offer publication with explicitly synthetic private evidence.
// This qualifies only the fixture bundle; it claims no real canary or activation.
async function qualify(f){
  const manifest=fs.readFileSync(path.join(f.next,'.release-manifest.json'));
  const release={root:f.next,id:path.basename(f.next),commit:JSON.parse(manifest).commit,protocol:1};
  const landing=path.join(f.scratch,'synthetic-landing.json'),canary=path.join(f.scratch,'synthetic-canary.json');
  fs.writeFileSync(landing,JSON.stringify({schema:'lane-validation/v1',executed:true,exit_code:0,node_version:'v20.19.4',command:'synthetic fixture only',
    started_at:'2026-10-30T00:00:00Z',finished_at:'2026-10-30T00:00:01Z',head:release.commit}));
  fs.writeFileSync(canary,JSON.stringify({fixture:true,status:'PASS',candidateCommit:release.commit}));
  const ref=file=>({file,sha256:sha(fs.readFileSync(file))});
  const packet={schema:'consumer-release-offer/v1',commit:release.commit,coordinatorItem:'G-1',manifestSha256:sha(manifest),
    canary:{status:'PASS',scope:'Synthetic fixture only.',evidence:['installed','probation','soak'].map(stage=>({...ref(canary),stage}))},
    landing:{status:'PASS',scope:'Synthetic fixture only.',evidence:[{...ref(landing),changedFiles:[],reconciliation:'Identical fixture source commit.'}]},
    majors:{unresolved:[],corrections:[],scope:'Synthetic fixture has no findings.'}};
  const attestationDigest=sha(JSON.stringify(packet)),attestationSeq=decide(f,`Consumer release offer reconciled: ${attestationDigest}`);
  const file=path.join(f.scratch,'synthetic-offer.json');fs.writeFileSync(file,JSON.stringify({...packet,attestationDigest,attestationSeq}));
  const {publishConsumerOffer}=await f.module(f.next,'lib/consumer-offer.mjs');
  publishConsumerOffer({release,home:f.installationHome,canonical:f.cwd,file,env:f.args.env});
  assert.deepEqual(fs.readFileSync(path.join(f.next,'.release-manifest.json')),manifest);
}
async function history(f){
  const {runtimeHistory}=await f.module(f.next,'line-service/runtime.mjs'),events=loadEvents(f.org).events;
  return()=>runtimeHistory(events,{repo:f.cwd,org:f.org,identity:f.identity,directory:f.directory,
    installation:JSON.parse(fs.readFileSync(f.installationFile)),cutover:events.find(e=>e.type==='line-service.cutover'),root:JSON.parse(fs.readFileSync(f.installationFile)).source});
}

test('bootstrap completion preview refuses premature and unsafe conversion, then recovers without changing original evidence',async t=>{
  const f=await enter(t);let before=state(f);
  assert.throws(()=>f.complete(['--dry-run']),/READY pin/);assert.deepEqual(state(f),before);
  pin(f,'trial');assert.throws(()=>f.complete(['--dry-run']),/READY/);assert.deepEqual(state(f),before);
  await qualify(f);
  before=state(f);
  const plan=f.complete(['--dry-run']);assert.deepEqual(state(f),before);
  assert.throws(()=>f.complete(['--expected-plan','0'.repeat(64)]),/plan changed/);
  f.setLoaded(true);assert.throws(()=>f.complete(['--dry-run']),/positively stopped/);f.setLoaded(false);
  for(const name of ['STOP','HOLD']){
    const file=path.join(f.cwd,'.lane/supervisor',name);fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,'held');
    assert.throws(()=>f.complete(['--dry-run']),/STOP\/HOLD/);fs.unlinkSync(file);
  }
  for(const lock of ['control.lock','pass.lock']){
    const release=noticeLock(path.join(f.directory,lock),{recover:false});
    try{assert.throws(()=>f.complete(['--dry-run']),/lock/);}finally{release();}
  }
  const release=noticeLock(path.join(f.identity,'lane-promote.lock'),{recover:false});
  try{assert.throws(()=>f.complete(['--dry-run']),/lock/);}finally{release();}
  const stop=fs.readFileSync(f.stop);fs.unlinkSync(f.stop);assert.throws(()=>f.complete(['--dry-run']),/ENOENT|own STOP/);fs.writeFileSync(f.stop,stop);
  const {probationControl}=await f.module(f.next,'line-service/probation.mjs');
  assert.throws(()=>probationControl({...f.args,id:'original-trial',finish:'completed',dryRun:true,env:{...f.args.env,CODEX_THREAD_ID:'foreign'}}),/native caller/);
  assert.equal(f.complete(['--dry-run']).expected_plan,plan.expected_plan);
  const result=f.complete(['--expected-plan',plan.expected_plan]);assert.equal(result.converted,true);
  const after=state(f);assert.equal(after.plist,before.plist);assert.equal(after.jobs,before.jobs);
  const saved=JSON.parse(after.installation);assert.equal(saved.probation_bootstrap,undefined);assert.equal(saved.probation_successor,undefined);assert.deepEqual(saved.migration,result.conversion);
  assert.equal(f.admit().probation,undefined);
  assert.equal(f.complete(['--expected-plan',plan.expected_plan]).existing,true);assert.deepEqual(state(f),after);
  const reader=await history(f);assert.equal(reader().last.type,'line-service.runtime-migrated');
  // Replacing the installed receipt with its pre-conversion bytes cannot revive probation.
  fs.writeFileSync(f.installationFile,before.installation);assert.throws(reader,/completion migration binding/);fs.writeFileSync(f.installationFile,after.installation);
  const original=fs.readFileSync(result.conversion.file);fs.chmodSync(result.conversion.file,0o644);fs.appendFileSync(result.conversion.file,'\n');
  assert.throws(reader,/archive\/event changed/);fs.writeFileSync(result.conversion.file,original);fs.chmodSync(result.conversion.file,0o444);assert.ok(reader());
  assert.equal(f.calls.some(c=>['bootstrap','bootout'].includes(c.args[0])),false);
});

test('completed bootstrap follows ordinary upgrade, login history and exact rollback while keeping original trial and callbacks',async t=>{
  const f=await enter(t);await qualify(f);pin(f,'trial');
  const originals=['probation/original-trial.json','probation-switches/entry.json'].map(file=>[file,fs.readFileSync(path.join(f.directory,file))]);
  const p=f.complete(['--dry-run']);f.complete(['--expected-plan',p.expected_plan]);
  // The supervisor's separate supported login operation can now extend this anchor.
  const login=['register-login','--repo',f.cwd,'--org',f.org],lp=f.main([...login,'--dry-run'],f.args);
  f.main([...login,'--expected-plan',lp.expected_plan],f.args);
  const baseline=state(f),next=f.release('next-accepted'),{main}=await f.module(next,'line-service/launchd.mjs');
  pin(f,'next-accepted');
  const up=['upgrade','--repo',f.cwd,'--org',f.org,'--id','ordinary-upgrade','--from-root',f.next,'--target-root',next];
  const preview=main([...up,'--dry-run'],f.args);assert.deepEqual(state(f),baseline);
  assert.equal(main([...up,'--expected-plan',preview.archive.sha256],f.args).direction,'upgrade');
  const upgraded=JSON.parse(fs.readFileSync(f.installationFile));assert.equal(upgraded.source,next);assert.equal(upgraded.runtime.probation,undefined);
  assert.equal((await history(f))().last.direction,'upgrade');
  const {installedContext}=await f.module(next,'line-service/cutoff.mjs');assert.equal(installedContext(f.cwd,f.org).installation.source,next);
  pin(f,'trial');
  const back=['upgrade','--repo',f.cwd,'--org',f.org,'--id','ordinary-rollback','--from-root',next,'--target-root',f.next,'--rollback'];
  const rollback=main([...back,'--dry-run'],f.args);
  assert.equal(main([...back,'--expected-plan',rollback.archive.sha256],f.args).direction,'rollback');
  const restored=state(f);assert.equal(restored.installation,baseline.installation);assert.equal(restored.plist,baseline.plist);assert.equal(restored.jobs,f.jobs);
  assert.equal((await history(f))().last.direction,'rollback');assert.equal(f.admit().probation,undefined);
  for(const [file,bytes]of originals)assert.deepEqual(fs.readFileSync(path.join(f.directory,file)),bytes);
  const events=loadEvents(f.org).events;assert.equal(events.filter(e=>e.type==='line-service.cutover').length,1);
  assert.equal(events.filter(e=>e.type==='line-service.probation-completed').length,1);assert.equal(events.filter(e=>e.type==='line-service.probation-authorized').length,1);
  assert.equal(f.calls.some(c=>['bootstrap','bootout'].includes(c.args[0])),false);
});

test('completion reconstructs an installed successor and preserves its original recovery anchor and fences',async t=>{
  const f=await enter(t);await enterSuccessor(f);const next=f.next;
  const retained=['probation-successors/original-trial.json','probation-successor-effects/successor-entry.json','probation-switches/.successor-successor-entry']
    .map(file=>[path.join(f.directory,file),fs.readFileSync(path.join(f.directory,file))]);
  await qualify(f);pin(f,'successor');
  const plan=f.complete(['--dry-run']);assert.equal(f.complete(['--expected-plan',plan.expected_plan]).converted,true);
  const h=(await history(f))();assert.equal(h.installation.source,next);assert.equal(h.installation.probation_successor,undefined);
  assert.equal(h.installation.probation_bootstrap,undefined);assert.equal(h.last.mode,'probation-completion');
  for(const [file,bytes]of retained)assert.deepEqual(fs.readFileSync(file),bytes);
  assert.equal(fs.readFileSync(f.retained,'utf8'),f.jobs);
});

test('completed bootstrap releases retired readers after a fold-changing upgrade while active recovery and rollback still refuse',async t=>{
  // Deliberately older fold in both the sealed recovery and completed bundle.
  // The following accepted release restores the real lesson.proposed case.
  const older=fs.mkdtempSync(path.join(os.tmpdir(),'completion-older-fold-'));
  t.after(()=>fs.rmSync(older,{recursive:true,force:true}));copyProduct(path.resolve(import.meta.dirname,'..'),older);
  const fold=path.join(older,'lib/state.mjs'),source=fs.readFileSync(fold,'utf8');
  assert.ok(source.includes("case 'lesson.proposed':"));
  fs.writeFileSync(fold,source.replace("case 'lesson.proposed':","case 'lesson.legacy-proposed':"));
  const f=await enter(t,{productRoot:older}),originalRoot=f.next;
  const {recovery}=await enterSuccessor(f,{productRoot:older}),completedRoot=f.next;
  const event={type:'lesson.proposed',id:'L-1',text:'Private later fold case',scope:'project'};
  const active=loadEvents(f.org).events,probe=[...active,{...event,seq:active.at(-1).seq+1}],trial=f.admit().probation;
  const {developmentHistory}=await f.module(completedRoot,'line-service/development-recovery.mjs');
  const before=state(f);
  // Exercise the sealed-recovery check itself, even though ordinary active
  // admission can reject the older candidate before reaching this second fence.
  assert.throws(()=>developmentHistory(probe,{repo:f.cwd,org:f.org,identity:f.identity,directory:f.directory,
    installation:JSON.parse(before.installation),cutover:active.find(e=>e.type==='line-service.cutover'),root:completedRoot,trial}),
  error=>error.message.includes(`record-incompatible: ${recovery} cannot fold lesson.proposed`));
  assert.deepEqual(state(f),before);
  await qualify(f);pin(f,'successor');
  const plan=f.complete(['--dry-run']);f.complete(['--expected-plan',plan.expected_plan]);
  // Keep post-anchor login inventory in the replay, without replaying that
  // operation into the bootstrap prefix.
  const login=['register-login','--repo',f.cwd,'--org',f.org],lp=f.main([...login,'--dry-run'],f.args);
  f.main([...login,'--expected-plan',lp.expected_plan],f.args);
  const next=f.release('fold-changing'),following=f.release('following'),{main}=await f.module(next,'line-service/launchd.mjs');
  pin(f,'fold-changing');
  const up=['upgrade','--repo',f.cwd,'--org',f.org,'--id','fold-upgrade','--from-root',completedRoot,'--target-root',next];
  const preview=main([...up,'--dry-run'],f.args);main([...up,'--expected-plan',preview.archive.sha256],f.args);
  transact(f.org,()=>({add:[event]}));
  const events=loadEvents(f.org).events;
  for(const root of [recovery,originalRoot,completedRoot])assert.throws(()=>requireRecordCompatibility(root,events),/cannot fold lesson.proposed/);
  assert.ok(requireRecordCompatibility(next,events));
  // A rollback target remains an execution dependency and must fold the tail.
  pin(f,'successor');const held=state(f);
  assert.throws(()=>main(['upgrade','--repo',f.cwd,'--org',f.org,'--id','incompatible-return','--from-root',next,'--target-root',completedRoot,'--rollback','--dry-run'],f.args),
    error=>error.message.includes(`record-incompatible: ${completedRoot} cannot fold lesson.proposed`));
  assert.deepEqual(state(f),held);pin(f,'fold-changing');
  const archives=['probation/original-trial.json','probation-switches/entry.json','probation-switches/recovery.json',
    'probation-successors/original-trial.json','probation-successor-effects/successor-entry.json',
    'probation-switches/.successor-successor-entry','probation-completions/original-trial.json']
    .map(file=>[path.join(f.directory,file),fs.readFileSync(path.join(f.directory,file))]);
  for(const root of [recovery,originalRoot,completedRoot])fs.renameSync(root,root+'-retired');
  f.next=next;f.main=main;
  const reader=await history(f),{serviceCutoff}=await f.module(next,'line-service/cutoff.mjs');
  // Replacing the real Node binary is unnecessary: any attempted old-binary
  // hash is a failure, while ordinary current-runtime admission still runs.
  const read=fs.readFileSync;
  fs.readFileSync=(file,...args)=>{assert.notEqual(file,process.execPath,'completed replay must not hash the old Node binary');return read(file,...args);};
  try{
    assert.equal(reader().installation.source,next);
    assert.equal(serviceCutoff(events,{repo:f.cwd,org:f.org,identity:f.identity}).id,'original-cutover');
    assert.equal(main(['restart','--repo',f.cwd,'--org',f.org],f.args).restarted,true);
    main(['stop','--repo',f.cwd,'--org',f.org],f.args);
    pin(f,'following');
    assert.equal(main(['upgrade','--repo',f.cwd,'--org',f.org,'--id','further-upgrade','--from-root',next,'--target-root',following,'--dry-run'],f.args).dry_run,true);
    // Retired payloads may disappear, but changing original authority may not.
    const [file,bytes]=archives[0],mode=fs.statSync(file).mode&0o777;
    fs.chmodSync(file,0o600);fs.appendFileSync(file,'\n');
    assert.throws(reader,/probation authority archive changed/);
    fs.writeFileSync(file,bytes);fs.chmodSync(file,mode);
    assert.equal(reader().installation.source,next);
  }finally{fs.readFileSync=read;}
  for(const [file,bytes]of archives)assert.deepEqual(fs.readFileSync(file),bytes);
  assert.equal(fs.readFileSync(f.retained,'utf8'),f.jobs);
});

for(const stage of ['intent','installation'])test(`interrupted bootstrap completion at ${stage} stays UNKNOWN under the original id and blocks restart and upgrade`,async t=>{
  const f=await enter(t);await qualify(f);pin(f,'trial');const before=state(f),p=f.complete(['--dry-run']);
  const {probationControl}=await f.module(f.next,'line-service/probation.mjs');
  assert.throws(()=>probationControl({...f.args,id:'original-trial',finish:'completed',expectedPlan:p.expected_plan,
    fault:at=>{if(at===stage)throw Error('lost completion reply');}}),/lost completion reply/);
  const bytes=fs.readFileSync(p.conversion.file),held=state(f);
  assert.throws(()=>f.complete(['--dry-run']),/UNKNOWN probation completion/);
  assert.throws(()=>f.main(['restart','--repo',f.cwd,'--org',f.org],f.args),/UNKNOWN probation completion/);
  const next=f.release('next-accepted');pin(f,'next-accepted');
  const {main}=await f.module(next,'line-service/launchd.mjs');
  assert.throws(()=>main(['upgrade','--repo',f.cwd,'--org',f.org,'--id','no-replacement','--from-root',f.next,'--target-root',next,'--dry-run'],f.args),
    /UNKNOWN probation completion|saved migrated\/fresh/);
  assert.deepEqual(fs.readFileSync(p.conversion.file),bytes);assert.deepEqual(state(f),held);
  assert.equal(held.events,before.events);assert.equal(held.plist,before.plist);assert.equal(held.jobs,before.jobs);
  assert.equal(f.calls.some(c=>['bootstrap','bootout'].includes(c.args[0])),false);
});
