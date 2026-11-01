import test from './helpers/bounded-test.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {fixture,state} from './helpers/line-service-probation-fixture.mjs';
import {copyProduct,productFiles,payloadEntry} from '../lib/product-files.mjs';
import {freezeReleaseValidation} from '../herdr/validation-admission.mjs';
import {loadEvents,transact} from '../lib/store.mjs';
import {requireHomeRelease,selectRelease} from '../lib/releases.mjs';
import {fixture as dispatchFixture,promptCalls} from '../dispatch/test/dispatch-fixture.mjs';
import {requireSuccessorCapabilities} from '../line-service/probation-successor-capabilities.mjs';

const originalCommit='d3271f06ef0ceb80a84cb624f4b04f3b5373c57f';
const product=path.resolve(import.meta.dirname,'..'),sha=b=>createHash('sha256').update(b).digest('hex');
const decide=(f,text)=>transact(f.org,()=>({add:[{type:'note.added',id:'G-1',decision:true,text}]}),{actor:f.agent.name}).added[0].seq;
function legacy(f,id,from,to){
  const args=['probation-switch','--repo',f.cwd,'--org',f.org,'--trial','original-trial','--id',id,'--from-root',from,'--target-root',to];
  const p=f.main([...args,'--dry-run'],f.args),authority=decide(f,p.required_decision);
  return f.main([...args,'--expected-plan',p.plan_sha256,'--authority',String(authority)],f.args);
}
async function successorFixture(t,{currentRecovery=false,incompatibleCandidate=false}={}){
  // Default to the complete OLD product revision (actual legacy helper). The
  // second control covers current bytes. Seal BOTH roots before moving only
  // canonical helper bytes, retaining frozen startup code and exact authorities.
  const old=fs.mkdtempSync(path.join(os.tmpdir(),'successor-old-'));
  t.after(()=>fs.rmSync(old,{recursive:true,force:true}));
  if(currentRecovery)copyProduct(product,old);
  else{
    const tar=spawnSync('git',['archive',originalCommit],{cwd:product,maxBuffer:128*1024*1024});assert.equal(tar.status,0,tar.stderr?.toString());
    const extracted=spawnSync('/usr/bin/tar',['-xf','-','-C',old],{input:tar.stdout});assert.equal(extracted.status,0,extracted.stderr?.toString());
  }
  const f=await fixture(t,{development:true,productRoot:old});
  const original=f.control({dryRun:true});f.authorize();
  const recovery=original.scope.previous.release.root;
  legacy(f,'old-entry',f.cwd,f.next);legacy(f,'old-anchor',f.next,recovery);
  const anchor={installation:fs.readFileSync(f.installationFile,'utf8'),plist:fs.readFileSync(f.file,'utf8')};
  const originalArchive=path.join(f.directory,'probation/original-trial.json'),originalBytes=fs.readFileSync(originalArchive);
  copyProduct(product,f.cwd);
  const frozenHelper=fs.readFileSync(path.join(recovery,'lib/obligations.mjs'));
  assert.equal(sha(frozenHelper),currentRecovery?'7d96691e48bcb8fbf1096a99a204c4284e6cec89847198646587870af8911b6e':'8f4e3cc3ce09ebf632d5a21b0eda28edf505e556480cb5044cf849e02d2b04f0');
  fs.writeFileSync(path.join(f.cwd,'lib/obligations.mjs'),frozenHelper);
  f.git('add','.');f.git('commit',...(currentRecovery?['--allow-empty']:[]),'-qm','Install successor protocol in private canonical');
  const commit=f.git('rev-parse','HEAD'),next=f.release('successor',{commit});fs.unlinkSync(path.join(next,'.release-acceptance.json'));
  if(!currentRecovery){
    // Exercise the existing successor's OWN reader/service code as well as the
    // complete OLD recovery. No modern fold or startup is substituted in it.
    const exact=path.join(f.scratch,'exact-successor-source');fs.mkdirSync(exact);
    const tar=spawnSync('git',['archive','ab671e89865ccf85d6d7d6d410688703d019d8ca'],{cwd:product,maxBuffer:128*1024*1024});assert.equal(tar.status,0,tar.stderr?.toString());
    const extracted=spawnSync('/usr/bin/tar',['-xf','-','-C',exact],{input:tar.stdout});assert.equal(extracted.status,0,extracted.stderr?.toString());
    fs.rmSync(next,{recursive:true});copyProduct(exact,next);fs.writeFileSync(path.join(next,'.release-commit'),commit+'\n');
    assert.equal(sha(fs.readFileSync(path.join(next,'lib/record-compatibility.mjs'))),'be456941bfbfb60e672375c0ad1a3b8e2b07d94c63833dda96e6ab9a3cc01f2a');
  }
  if(incompatibleCandidate)fs.appendFileSync(path.join(next,'line-service/launchd.mjs'),'\nthrow Error("target protocol must never execute during admission");\n');
  const frozenFile=path.join(next,'.release-validation.json'),frozen=freezeReleaseValidation(f.cwd,'successor',frozenFile,f.env,{commit,mode:'routine'});
  const runtime=productFiles(next).sort();
  fs.writeFileSync(frozenFile,JSON.stringify({...frozen,validation:{cwd:f.cwd,common:f.identity,commit,tree:f.git('rev-parse',`${commit}^{tree}`),
    inventorySha256:'0'.repeat(64),runtimeSha256:sha(JSON.stringify(Object.fromEntries(runtime.map(file=>[file,payloadEntry(next,file)])))),routine:{fullCoverage:'UNRUN'}}}));
  const manifest=spawnSync(process.execPath,[path.join(product,'herdr/releases.mjs'),'manifest',next],{env:f.env,encoding:'utf8'});assert.equal(manifest.status,0,manifest.stderr);
  const candidateManifest=fs.readFileSync(path.join(next,'.release-manifest.json'));
  // No reseal or authority rewrite: only the canonical implementation moves.
  fs.writeFileSync(path.join(f.cwd,'lib/obligations.mjs'),fs.readFileSync(path.join(product,'lib/obligations.mjs'),'utf8')+'\n// Compatible canonical implementation revision.\n');
  f.git('add','lib/obligations.mjs');f.git('commit','-qm','Move canonical helper after immutable roots sealed');
  // Every formerly equality-gated file moves AFTER the candidate is sealed.
  for(const name of ['probation-successor.mjs','probation-successor-history.mjs','probation.mjs','development-recovery.mjs','runtime.mjs','launchd.mjs'])
    fs.appendFileSync(path.join(f.cwd,'line-service',name),'\n// Compatible canonical protocol revision after sealing.\n');
  f.git('add','line-service');f.git('commit','-qm','Move canonical protocol after immutable roots sealed');
  assert.deepEqual(fs.readFileSync(path.join(next,'lib/obligations.mjs')),frozenHelper);
  assert.notDeepEqual(fs.readFileSync(path.join(f.cwd,'lib/obligations.mjs')),frozenHelper);
  const run=(options={})=>{
    const {faultStage,mutateStage,loaded=false,nativeRefusal,tool=f.cwd,cli=false,...extra}=options;
    const args={...f.args,id:'successor-entry',trial:'original-trial',fromRoot:recovery,targetRoot:next,...extra};
    // Fresh process: no cached old canonical imports can supply new readers.
    const script=`import {spawnSync} from 'node:child_process';import fs from 'node:fs';
      const args=${JSON.stringify(args)};
      args.call=()=>JSON.stringify({result:{agent:${JSON.stringify(f.agent)}}});
      args.command=(exe,argv,opts)=>exe==='/usr/bin/plutil'?spawnSync(exe,argv,opts):${nativeRefusal?JSON.stringify({status:1,stderr:nativeRefusal}):loaded?JSON.stringify({status:0,stdout:'loaded'}):JSON.stringify({status:113,stderr:'Could not find service in domain'})};
      args.fault=stage=>{if(stage===${JSON.stringify(faultStage)})throw Error('injected '+stage);if(stage===${JSON.stringify(mutateStage)})fs.appendFileSync(${JSON.stringify(f.stop)},'STOP drift');};
      try{const m=await import(${JSON.stringify(pathToFileURL(path.join(tool,cli?'line-service/launchd.mjs':'line-service/probation-successor.mjs')).href)});
        const result=${cli?`m.main(['probation-successor','--repo',args.repo,'--org',args.org,'--trial',args.trial,'--id',args.id,'--from-root',args.fromRoot,'--target-root',args.targetRoot,...(args.rollback?['--rollback']:[]),...(args.dryRun?['--dry-run']:[]),...(args.expectedPlan?['--expected-plan',args.expectedPlan]:[]),...(args.authority?['--authority',String(args.authority)]:[])],args)`:'m.probationSuccessor(args)'};console.log(JSON.stringify({result}));
      }catch(error){console.log(JSON.stringify({error:error.message}));}`;
    const r=spawnSync(process.execPath,['--input-type=module','-e',script],{cwd:f.cwd,env:f.args.env,encoding:'utf8',maxBuffer:4*1024*1024});
    assert.equal(r.status,0,r.stderr);const out=JSON.parse(r.stdout);if(out.error)throw Error(out.error);return out.result;
  };
  const apply=(options={})=>{
    const p=run({...options,dryRun:true}),authority=decide(f,p.required_decision);
    return run({...options,expectedPlan:p.plan_sha256,authority});
  };
  const back=(options={})=>apply({id:'successor-recovery',fromRoot:next,targetRoot:recovery,rollback:true,...options});
  const returned=(options={})=>apply({id:'successor-return',...options});
  return{...f,successor:next,recovery,anchor,original,originalArchive,originalBytes,run,apply,back,returned,frozenHelper,candidateManifest};
}
async function startPassStop(f,root){
  const {main}=await f.module(root,'line-service/launchd.mjs');
  assert.equal(main(['restart','--repo',f.cwd,'--org',f.org],f.args).restarted,true);
  const script=`import {createLineService} from ${JSON.stringify(pathToFileURL(path.join(root,'line-service/line-service.mjs')).href)};
    const service=createLineService({repo:${JSON.stringify(f.cwd)},org:${JSON.stringify(f.org)},to:'fixture-supervisor',haltAfter:100,
      command:()=>({status:0,stdout:'{"created":[]}'}),capacity:()=>({count:0,cap:2})});console.log(JSON.stringify(service.pass()));`;
  const r=spawnSync(process.execPath,['--input-type=module','-e',script],{cwd:f.cwd,env:f.args.env,encoding:'utf8'});
  assert.equal(r.status,0,r.stderr);assert.equal(JSON.parse(r.stdout).result,'pass-complete');
  main(['stop','--repo',f.cwd,'--org',f.org],f.args);
}
async function oldRefuses(f){
  for(const root of [f.next,f.recovery]){
    const {main}=await f.module(root,'line-service/launchd.mjs');
    assert.throws(()=>main(['restart','--repo',f.cwd,'--org',f.org],f.args),/UNKNOWN probation switch|binding differs|drifted/);
  }
}

test('successor CLI preserves the original OLD sealed recovery through executable entry rollback and exact return',async t=>{
  const f=await successorFixture(t),before=state(f),p=f.run({dryRun:true,cli:true});
  assert.deepEqual(state(f),before);assert.equal(p.runtime_started,false);assert.equal(p.stable_ready,false);
  assert.equal(p.scope_sha256,f.original.scope_sha256);
  assert.match(p.plan_sha256,/^[a-f0-9]{64}$/);assert.equal(p.successor_scope.original.recovery_sha256,p.recovery_sha256);
  assert.equal(fs.existsSync(path.join(f.recovery,'line-service/probation-successor.mjs')),false);
  await startPassStop(f,f.recovery);
  const entry=f.apply({cli:true});assert.equal(entry.runtime.root,f.successor);assert.equal(entry.stable_ready,false);
  const {acceptedRuntime}=await f.module(f.successor,'line-service/runtime.mjs');
  assert.equal(acceptedRuntime(f.cwd,{root:f.successor,home:f.installationHome}).probation.successor.archive.sha256,p.extension.sha256);
  await oldRefuses(f);await startPassStop(f,f.successor);
  assert.throws(()=>requireHomeRelease('successor',null,f.installationHome),/READY/);
  assert.throws(()=>selectRelease(f.cwd,f.installationHome,{pin:{release:'successor'}}),/READY/);
  const back=f.back();assert.equal(back.runtime.root,f.recovery);
  assert.equal(fs.readFileSync(f.installationFile,'utf8'),f.anchor.installation);assert.equal(fs.readFileSync(f.file,'utf8'),f.anchor.plist);
  transact(f.org,()=>({add:[{type:'item.added',id:'ENG-1',role:'engineer',title:'Frozen-reader recovery work'},
    {type:'run.started',id:'R-1',item:'ENG-1'},
    {type:'report.ingested',run:'R-1',sha256:'a'.repeat(64),report:{outcome:'done'}}]}));
  await startPassStop(f,f.recovery); // Actual OLD parser, history and service code.
  f.returned({cli:true});await startPassStop(f,f.successor);
  assert.deepEqual(fs.readFileSync(f.originalArchive),f.originalBytes);
  assert.deepEqual(fs.readFileSync(path.join(f.successor,'.release-manifest.json')),f.candidateManifest);
  assert.deepEqual(fs.readFileSync(path.join(f.successor,'lib/obligations.mjs')),f.frozenHelper);
  for(const [file,e]of Object.entries(f.original.scope.previous.source.files))assert.deepEqual(payloadEntry(f.recovery,file),e);
  const events=loadEvents(f.org).events;
  assert.equal(events.filter(e=>e.type==='line-service.probation-authorized').length,1);
  assert.equal(events.filter(e=>e.type==='line-service.probation-successor-authorized').length,1);
  assert.deepEqual(events.filter(e=>e.type==='line-service.probation-successor-switched').map(e=>e.id),['successor-entry','successor-recovery','successor-return']);
  assert.equal(fs.readFileSync(f.retained,'utf8'),f.jobs);
});

test('successor cleared rollback return previews completed reports and preserves clear receipt fences',async t=>{
  // Both immutable helpers retain the current profile; canonical bytes moved
  // after sealing. The other lifecycle control exercises actual OLD readers.
  const f=await successorFixture(t,{currentRecovery:true});f.apply();f.back();
  const clearFile=path.join(f.directory,'probation-successor-clears/successor-recovery.json'),clearBytes=fs.readFileSync(clearFile,'utf8');
  assert.deepEqual(fs.readdirSync(path.join(f.directory,'probation-switches')).filter(n=>n.startsWith('.successor-')),[]);
  transact(f.org,()=>({add:[{type:'item.added',id:'ENG-1',role:'engineer',title:'Recovery worker'},
    {type:'run.started',id:'R-1',item:'ENG-1'},
    {type:'report.ingested',run:'R-1',sha256:'a'.repeat(64),report:{outcome:'done',summary:'Recovery work completed'}}]}));
  const before=state(f),clear=JSON.parse(clearBytes);
  fs.chmodSync(clearFile,0o644);fs.writeFileSync(clearFile,JSON.stringify({...clear,completion_seq:clear.completion_seq-1})+'\n');fs.chmodSync(clearFile,0o444);
  assert.throws(()=>f.run({id:'successor-return',dryRun:true,cli:true}),/rollback clear receipt changed/);
  assert.deepEqual(state(f),before);
  fs.chmodSync(clearFile,0o644);fs.writeFileSync(clearFile,clearBytes);fs.chmodSync(clearFile,0o444);
  const preview=f.run({id:'successor-return',dryRun:true,cli:true});
  assert.match(preview.plan_sha256,/^[a-f0-9]{64}$/);
  assert.equal(preview.required_decision,`Brain probation successor authorized: successor-return ${preview.plan_sha256}`);
  assert.deepEqual(state(f),before);assert.equal(fs.readFileSync(clearFile,'utf8'),clearBytes);
  const returned=f.returned({cli:true});assert.equal(returned.runtime.root,f.successor);
  await startPassStop(f,f.successor);
  assert.deepEqual(fs.readFileSync(f.originalArchive),f.originalBytes);
  assert.deepEqual(fs.readFileSync(path.join(f.successor,'.release-manifest.json')),f.candidateManifest);
  assert.deepEqual(fs.readFileSync(path.join(f.successor,'lib/obligations.mjs')),f.frozenHelper);
  assert.equal(fs.readFileSync(clearFile,'utf8'),clearBytes);
});

test('successor rejects an incompatible sealed candidate before effects without executing target code',async t=>{
  const f=await successorFixture(t,{incompatibleCandidate:true}),before=state(f);
  assert.throws(()=>f.run({dryRun:true,cli:true}),/successor-incompatible: unrecognized successor-reader\/v1/);
  assert.deepEqual(state(f),before);
  assert.equal(fs.existsSync(path.join(f.directory,'probation-successor-effects')),false);
});

test('successor capability requirement changes refuse the frozen reader before entry and recover without resealing',async t=>{
  const f=await successorFixture(t),registry=path.join(f.cwd,'line-service/probation-successor-capabilities.mjs');
  const bytes=fs.readFileSync(registry,'utf8'),before=state(f);
  assert.equal(requireSuccessorCapabilities(f.successor).profile,'ab671e8986');
  const changed=bytes.replace("export const successorRequirements = () => ['successor-effect/v1'", "export const successorRequirements = () => ['successor-effect/v2'");
  assert.notEqual(changed,bytes);fs.writeFileSync(registry,changed);
  f.git('add','line-service');f.git('commit','-qm','Require a new writer contract with unchanged frozen reader');
  assert.throws(()=>f.run({dryRun:true,cli:true}),/profile ab671e8986 lacks successor-effect\/v2/);
  assert.deepEqual(state(f),before);
  assert.equal(fs.existsSync(path.join(f.directory,'probation-successor-effects')),false);
  fs.writeFileSync(registry,bytes);f.git('add','line-service');f.git('commit','-qm','Restore compatible writer contract');
  assert.equal(f.run({dryRun:true,cli:true}).runtime.root,f.successor);
  assert.deepEqual(fs.readFileSync(path.join(f.successor,'.release-manifest.json')),f.candidateManifest);
});

test('successor verifies all six target sources and rollback bypasses reader admission while return refuses and recovers',async t=>{
  const f=await successorFixture(t,{currentRecovery:true});
  assert.equal(requireSuccessorCapabilities(f.successor).capability,'successor-reader/v1');
  for(const name of ['probation-successor.mjs','probation-successor-history.mjs','probation.mjs','development-recovery.mjs','runtime.mjs','launchd.mjs']){
    const file=path.join(f.successor,'line-service',name),bytes=fs.readFileSync(file);
    fs.appendFileSync(file,'\n// Unknown target revision.\n');
    assert.throws(()=>requireSuccessorCapabilities(f.successor),/successor-incompatible/);
    fs.writeFileSync(file,bytes);
  }
  f.apply();
  // A new canonical effect contract must not silently upgrade the sealed reader.
  // Rollback still restores recovery, while return refuses before effects.
  const registry=path.join(f.cwd,'line-service/probation-successor-capabilities.mjs'),bytes=fs.readFileSync(registry,'utf8');
  const changed=bytes.replace("export const successorRequirements = () => ['successor-effect/v1'", "export const successorRequirements = () => ['successor-effect/v2'");
  assert.notEqual(changed,bytes);
  fs.writeFileSync(registry,changed);
  f.git('add','line-service');f.git('commit','-qm','Require a new canonical successor effect contract');
  const back=f.back({cli:true});assert.equal(back.runtime.root,f.recovery);
  assert.equal(fs.readFileSync(f.installationFile,'utf8'),f.anchor.installation);
  const before=state(f);
  assert.throws(()=>f.run({id:'successor-return',dryRun:true,cli:true}),/successor-incompatible: profile .* lacks successor-effect\/v2/);
  assert.deepEqual(state(f),before);
  fs.writeFileSync(registry,bytes);f.git('add','line-service');f.git('commit','-qm','Restore compatible canonical writer requirement');
  assert.equal(f.returned({cli:true}).runtime.root,f.successor);
});

test('successor authority source STOP native history record and integrity refusals precede effects',async t=>{
  const f=await successorFixture(t),before=state(f),p=f.run({dryRun:true}),seq=decide(f,p.required_decision);
  assert.throws(()=>f.run({expectedPlan:'0'.repeat(64),authority:seq}),/plan changed/);
  assert.throws(()=>f.run({expectedPlan:p.plan_sha256,authority:1}),/plan changed|effect authority/);
  assert.throws(()=>f.run({dryRun:true,tool:f.successor}),/canonical Brain tool root/);
  assert.throws(()=>f.run({dryRun:true,env:{...f.args.env,CODEX_THREAD_ID:'foreign'}}),/native caller/);
  assert.throws(()=>f.run({dryRun:true,nativeRefusal:'native refused'}),/native refused/);
  assert.throws(()=>f.run({dryRun:true,loaded:true}),/positively stopped/);
  for(const name of ['STOP','HOLD']){
    const file=path.join(f.cwd,'.lane/supervisor',name);fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,'held');
    assert.throws(()=>f.run({dryRun:true}),/STOP\/HOLD/);fs.unlinkSync(file);
  }
  transact(f.org,()=>({add:[{type:'item.updated',id:'G-1',fields:{meta:{hold:true}}}]}));
  assert.throws(()=>f.run({dryRun:true}),/HOLD/);
  transact(f.org,()=>({add:[{type:'item.updated',id:'G-1',fields:{meta:{hold:false}}}]}));
  const payload=path.join(f.recovery,'bin/org.mjs'),bytes=fs.readFileSync(payload),mode=fs.statSync(payload).mode&0o777;
  fs.chmodSync(payload,0o644);assert.throws(()=>f.run({dryRun:true}),/writable/);fs.chmodSync(payload,mode);
  fs.chmodSync(payload,0o644);fs.appendFileSync(payload,'\n// damage');fs.chmodSync(payload,mode);
  assert.throws(()=>f.run({dryRun:true}),/payload mismatch/);fs.chmodSync(payload,0o644);fs.writeFileSync(payload,bytes);fs.chmodSync(payload,mode);
  fs.renameSync(f.recovery,f.recovery+'.saved');fs.symlinkSync(f.recovery+'.saved',f.recovery);
  assert.throws(()=>f.run({dryRun:true}),/identity\/node changed|ENOTDIR: not a directory, open 'runtime'/);fs.unlinkSync(f.recovery);fs.renameSync(f.recovery+'.saved',f.recovery);
  fs.appendFileSync(path.join(f.successor,'bin/org.mjs'),'\n// drift');assert.throws(()=>f.run({dryRun:true}),/incomplete release/);
  fs.writeFileSync(path.join(f.successor,'bin/org.mjs'),fs.readFileSync(path.join(f.cwd,'bin/org.mjs')));
  assert.throws(()=>f.run({expectedPlan:p.plan_sha256,authority:seq}),/plan changed/,'intervening record changes invalidate the original preview');
  assert.equal(fs.readFileSync(f.installationFile,'utf8'),before.installation);assert.equal(fs.readFileSync(f.file,'utf8'),before.plist);
  assert.equal(fs.existsSync(path.join(f.directory,'probation-successor-effects')),false);
  transact(f.org,()=>({add:[{type:'item.future',id:'ENG-1'}]}));assert.throws(()=>f.run({dryRun:true}),/record-incompatible/);
});

test('successor UNKNOWN intents fence OLD and new startup and every replacement ID before the first config write',async t=>{
  for(const stage of ['fence','authority','intent','plist','installation'])await t.test(stage,async st=>{
    const f=await successorFixture(st),p=f.run({dryRun:true}),authority=decide(f,p.required_decision);
    assert.throws(()=>f.run({expectedPlan:p.plan_sha256,authority,faultStage:stage}),new RegExp('injected '+stage));
    const marker=path.join(f.directory,'probation-switches/.successor-successor-entry'),bytes=fs.readFileSync(marker);
    for(const id of ['successor-entry','replacement'])assert.throws(()=>f.run({id,dryRun:true}),/UNKNOWN|completed successor/);
    await oldRefuses(f);
    const {main}=await f.module(f.successor,'line-service/launchd.mjs');
    assert.throws(()=>main(['restart','--repo',f.cwd,'--org',f.org],f.args),/UNKNOWN|accepted project pin|binding differs|drifted/);
    assert.deepEqual(fs.readFileSync(marker),bytes);assert.equal(fs.readFileSync(f.retained,'utf8'),f.jobs);
  });
});

test('successor effect STOP CAS and completed rollback cleanup fault retain their original fences',async t=>{
  const f=await successorFixture(t),p=f.run({dryRun:true}),authority=decide(f,p.required_decision);
  assert.throws(()=>f.run({expectedPlan:p.plan_sha256,authority,mutateStage:'intent'}),/CAS changed/);
  assert.equal(fs.readFileSync(f.installationFile,'utf8'),f.anchor.installation);await oldRefuses(f);
  const g=await successorFixture(t);g.apply();
  const rollback={id:'successor-recovery',fromRoot:g.successor,targetRoot:g.recovery,rollback:true};
  const plan=g.run({...rollback,dryRun:true}),seq=decide(g,plan.required_decision);
  assert.throws(()=>g.run({...rollback,expectedPlan:plan.plan_sha256,authority:seq,faultStage:'clear-receipt'}),/injected clear-receipt/);
  assert.equal(fs.readFileSync(g.installationFile,'utf8'),g.anchor.installation);await oldRefuses(g);
  assert.throws(()=>g.run({id:'replacement',dryRun:true}),/fence retained/);
  assert.ok(fs.existsSync(path.join(g.directory,'probation-successor-clears/successor-recovery.json')));
});

test('successor children retain exact trial/root and captured callbacks survive withdrawal while new admission closes',async t=>{
  const f=await successorFixture(t);f.apply();const stopBytes=fs.readFileSync(f.stop);fs.unlinkSync(f.stop);
  const d=dispatchFixture(t,{project:f}),topic=`line-${d.item.toLowerCase()}-1`,laneCLI=path.join(d.root,'bin/lane');
  fs.writeFileSync(laneCLI,fs.readFileSync(laneCLI,'utf8').replace('lane/topic',`lane/${topic}`));
  const {createLineService}=await f.module(f.successor,'line-service/line-service.mjs');
  const service=createLineService({repo:f.cwd,org:f.org,to:f.agent.name,runtimeHome:f.installationHome,env:d.env,maxStarts:1,haltAfter:100,capacity:()=>({count:0,cap:4}),
    recordNotice:()=>({state:'record-only'}),command:(exe,args,options)=>{
      if(!args[0].endsWith('/dispatch/dispatch.mjs'))return{status:0,stdout:'{"created":[]}'};
      assert.equal(args[0],path.join(f.successor,'dispatch/dispatch.mjs'));
      return spawnSync(exe,[...args.filter(a=>a!=='--detach'),'--lane-cli',laneCLI,'--watch-cli',path.join(d.root,'bin/watch')],options);
    }});
  assert.equal(service.pass().result,'pass-complete');
  const {file,job}=d.jobs().map(file=>({file,job:JSON.parse(fs.readFileSync(file))})).find(x=>x.job.item===d.item);
  assert.equal(job.stage,'complete');assert.equal(job.release.root,f.successor);assert.equal(job.probation.id,'original-trial');
  assert.ok(job.probation.successor.archive.sha256);assert.equal(d.show(job.run).owner.release.root,f.successor);assert.equal(promptCalls(d).length,1);
  const {main}=await f.module(f.successor,'line-service/launchd.mjs');main(['probation-withdraw','--repo',f.cwd,'--org',f.org,'--id','original-trial'],f.args);
  const {checkDispatchEligibility}=await f.module(f.successor,'dispatch/launch-guard.mjs');
  assert.throws(()=>checkDispatchEligibility(job,file,{boundary:'launch'}),/withdrawn/);checkDispatchEligibility(job,file,{boundary:'prompt'});
  const {selectedReviewConsumer}=await f.module(f.successor,'line-service/review.mjs');assert.equal(selectedReviewConsumer({repo:f.cwd,run:d.show(job.run)}).recordRoot,f.successor);
  fs.writeFileSync(f.stop,stopBytes);
  assert.throws(()=>f.run({id:'new-after-withdrawal',dryRun:true}),/withdrawn/);assert.equal(fs.readFileSync(f.retained,'utf8'),f.jobs);
});
