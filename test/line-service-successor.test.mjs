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
import {probationChain} from '../measurement/probation-chain.mjs';
import {successorRecordDigest} from '../line-service/probation-successor-record.mjs';

const originalCommit='d3271f06ef0ceb80a84cb624f4b04f3b5373c57f';
const product=path.resolve(import.meta.dirname,'..'),sha=b=>createHash('sha256').update(b).digest('hex');
const decide=(f,text)=>transact(f.org,()=>({add:[{type:'note.added',id:'G-1',decision:true,text}]}),{actor:f.agent.name}).added[0].seq;
function legacy(f,id,from,to){
  const args=['probation-switch','--repo',f.cwd,'--org',f.org,'--trial','original-trial','--id',id,'--from-root',from,'--target-root',to];
  const p=f.main([...args,'--dry-run'],f.args),authority=decide(f,p.required_decision);
  return f.main([...args,'--expected-plan',p.plan_sha256,'--authority',String(authority)],f.args);
}
async function successorFixture(t,{currentRecovery=false,incompatibleCandidate=false,legacyCandidate=false}={}){
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
  const commit=f.git('rev-parse','HEAD');
  function candidate(name,{legacy=false,incompatible=false}={}){
    const next=f.release(name,{commit});copyProduct(product,next);fs.unlinkSync(path.join(next,'.release-acceptance.json'));
    {
      // Retain exact admitted readers; changing the canonical writer does not
      // self-register a new reader profile in this fixture or in production.
      const reader=legacy?'ab671e89865ccf85d6d7d6d410688703d019d8ca':'bb50836ee56b56ed720a902035ec7e8cbe5699e4';
      const exact=path.join(f.scratch,'exact-'+name);fs.mkdirSync(exact);
      const tar=spawnSync('git',['archive',reader],{cwd:product,maxBuffer:128*1024*1024});assert.equal(tar.status,0,tar.stderr?.toString());
      const extracted=spawnSync('/usr/bin/tar',['-xf','-','-C',exact],{input:tar.stdout});assert.equal(extracted.status,0,extracted.stderr?.toString());
      fs.rmSync(next,{recursive:true});copyProduct(exact,next);fs.writeFileSync(path.join(next,'.release-commit'),commit+'\n');
    }
    fs.writeFileSync(path.join(next,'lib/obligations.mjs'),frozenHelper);
    if(incompatible)fs.appendFileSync(path.join(next,'line-service/launchd.mjs'),'\nthrow Error("target protocol must never execute during admission");\n');
    const frozenFile=path.join(next,'.release-validation.json'),frozen=freezeReleaseValidation(f.cwd,name,frozenFile,f.env,{commit,mode:'routine'});
    const runtime=productFiles(next).sort();
    fs.writeFileSync(frozenFile,JSON.stringify({...frozen,validation:{cwd:f.cwd,common:f.identity,commit,tree:f.git('rev-parse',`${commit}^{tree}`),
      inventorySha256:'0'.repeat(64),runtimeSha256:sha(JSON.stringify(Object.fromEntries(runtime.map(file=>[file,payloadEntry(next,file)])))),routine:{fullCoverage:'UNRUN'}}}));
    const manifest=spawnSync(process.execPath,[path.join(product,'herdr/releases.mjs'),'manifest',next],{env:f.env,encoding:'utf8'});assert.equal(manifest.status,0,manifest.stderr);
    return next;
  }
  const next=candidate('successor',{legacy:legacyCandidate,incompatible:incompatibleCandidate});
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
    const {faultStage,mutateStage,appendStage,appendEvents=[],loaded=false,nativeRefusal,tool=f.cwd,cli=false,...extra}=options;
    const args={...f.args,id:'successor-entry',trial:'original-trial',fromRoot:recovery,targetRoot:next,...extra};
    // Fresh process: no cached old canonical imports can supply new readers.
    const script=`import {spawnSync} from 'node:child_process';import fs from 'node:fs';
      import {transact} from ${JSON.stringify(pathToFileURL(path.join(f.cwd,'lib/store.mjs')).href)};
      const args=${JSON.stringify(args)};
      args.call=()=>JSON.stringify({result:{agent:${JSON.stringify(f.agent)}}});
      args.command=(exe,argv,opts)=>exe==='/usr/bin/plutil'?spawnSync(exe,argv,opts):${nativeRefusal?JSON.stringify({status:1,stderr:nativeRefusal}):loaded?JSON.stringify({status:0,stdout:'loaded'}):JSON.stringify({status:113,stderr:'Could not find service in domain'})};
      args.fault=stage=>{if(stage===${JSON.stringify(faultStage)})throw Error('injected '+stage);if(stage===${JSON.stringify(mutateStage)})fs.appendFileSync(${JSON.stringify(f.stop)},'STOP drift');
        if(stage===${JSON.stringify(appendStage)})transact(args.org,()=>({add:${JSON.stringify(appendEvents)}}));};
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
  return{...f,candidate,successor:next,recovery,anchor,original,originalArchive,originalBytes,run,apply,back,returned,frozenHelper,candidateManifest};
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

test('successor record binding includes lifecycle authorities and owner holds while excluding worker progress',()=>{
  const c={identity:'/private/brain/.git',org:'/private/record'},events=[
    {type:'item.added',seq:1,id:'G-1',kind:'goal'},
    {type:'item.added',seq:2,id:'ENG-1',parent:'G-1'},
    {type:'run.started',seq:3,id:'R-1',item:'ENG-1'},
    {type:'note.added',seq:4,id:'R-1',decision:true,text:'exact authority'},
    {type:'line-service.probation-authorized',seq:5,project:c.identity,org:c.org,authority:4}];
  const digest=extra=>successorRecordDigest([...events,...extra],c),initial=digest([]);
  assert.equal(digest([{type:'note.added',seq:6,id:'R-1',text:'progress'},
    {type:'item.updated',seq:7,id:'ENG-1',fields:{title:'done',meta:{unrelated:true}}},
    {type:'report.ingested',seq:8,run:'R-1',report:{outcome:'done'}},
    {type:'item.closed',seq:9,id:'G-1',as:'done'}]),initial);
  for(const type of ['line-service.cutover','line-service.phase0','line-service.runtime-migrated','line-service.runtime-upgraded',
    'line-service.probation-authorized','line-service.probation-withdrawn','line-service.probation-completed',
    'line-service.probation-switched','line-service.probation-successor-authorized','line-service.probation-successor-switched',
    'line-service.recipient-retargeted','line-service.login-registered']){
    const event={type,seq:6,project:c.identity,org:c.org};
    assert.notEqual(digest([event]),initial,type);
    assert.equal(digest([{...event,project:'foreign'}]),initial,type+' foreign project');
    assert.equal(digest([{...event,org:'foreign'}]),initial,type+' foreign record');
  }
  for(const flag of ['hold','held','operator_reserved','reserved'])
    assert.notEqual(digest([{type:'item.updated',seq:6,id:'G-1',fields:{meta:{[flag]:true}}}]),initial,flag);
  for(const fields of [{parent:'missing'},{parent:'ENG-1'},{role:'human'}])
    assert.notEqual(digest([{type:'item.updated',seq:6,id:'G-1',fields}]),initial);
  assert.notEqual(digest([{type:'run.abandoned',seq:6,id:'R-1'}]),initial);
  assert.notEqual(successorRecordDigest(events.map(e=>e.seq===4?{...e,text:'changed'}:e),c),initial);
  const recoveryNote={type:'note.added',seq:6,id:'G-1',decision:true,text:'recovery excess'};
  assert.equal(digest([recoveryNote]),initial);
  assert.notEqual(successorRecordDigest([...events,recoveryNote],c,{recoveryAuthority:6}),initial);
});

test('successor rollback preview survives worker events through fence clear and refuses a fresh relevant hold before recovery',async t=>{
  const f=await successorFixture(t);f.apply();
  const options={id:'successor-recovery',fromRoot:f.successor,targetRoot:f.recovery,rollback:true};
  const plan=f.run({...options,dryRun:true}),authority=decide(f,plan.required_decision);
  transact(f.org,()=>({add:[{type:'item.added',id:'ENG-1',title:'Worker continues'},
    {type:'run.started',id:'R-1',item:'ENG-1'},
    {type:'note.added',id:'G-1',text:'Unrelated owner progress'},
    {type:'item.updated',id:'G-1',fields:{title:'Owner progress',meta:{unrelated:true}}}]}));
  assert.equal(f.run({...options,dryRun:true}).plan_sha256,plan.plan_sha256);
  transact(f.org,()=>({add:[{type:'item.updated',id:'G-1',fields:{meta:{hold:true}}}]}));
  const held=state(f);
  assert.throws(()=>f.run({...options,expectedPlan:plan.plan_sha256,authority}),/HOLD/);
  assert.deepEqual(state(f),held);
  transact(f.org,()=>({add:[{type:'item.updated',id:'G-1',fields:{meta:{hold:false}}}]}));
  const back=f.run({...options,expectedPlan:plan.plan_sha256,authority,appendStage:'completion',
    appendEvents:[{type:'report.ingested',run:'R-1',sha256:'a'.repeat(64),report:{outcome:'done'}}]});
  assert.equal(back.runtime.root,f.recovery);
  assert.equal(fs.readFileSync(f.installationFile,'utf8'),f.anchor.installation);
  assert.equal(fs.readFileSync(f.file,'utf8'),f.anchor.plist);
  assert.deepEqual(fs.readdirSync(path.join(f.directory,'probation-switches')).filter(n=>n.startsWith('.successor-')),[]);
  assert.ok(fs.existsSync(path.join(f.directory,'probation-successor-clears/successor-recovery.json')));
  assert.deepEqual(fs.readFileSync(f.originalArchive),f.originalBytes);
  await startPassStop(f,f.recovery);
});

test('successor rollback retains fences when relevant lifecycle history changes before clear',async t=>{
  const f=await successorFixture(t);f.apply();
  assert.throws(()=>f.back({appendStage:'completion',appendEvents:[{type:'line-service.probation-withdrawn',
    id:'original-trial',project:f.identity,org:f.org}]}),/record CAS changed before fence clear/);
  assert.equal(fs.readFileSync(f.installationFile,'utf8'),f.anchor.installation);
  assert.ok(fs.existsSync(path.join(f.directory,'probation-switches/.successor-successor-recovery')));
  assert.equal(fs.existsSync(path.join(f.directory,'probation-successor-clears/successor-recovery.json')),false);
});

test('successor CLI preserves the original OLD sealed recovery through executable entry rollback and exact return',async t=>{
  const f=await successorFixture(t),before=state(f),p=f.run({dryRun:true,cli:true});
  assert.deepEqual(state(f),before);assert.equal(p.runtime_started,false);assert.equal(p.stable_ready,false);
  assert.equal(p.scope_sha256,f.original.scope_sha256);
  assert.match(p.plan_sha256,/^[a-f0-9]{64}$/);assert.equal(p.successor_scope.original.recovery_sha256,p.recovery_sha256);
  assert.equal(fs.existsSync(path.join(f.recovery,'line-service/probation-successor.mjs')),false);
  await startPassStop(f,f.recovery);
  const entry=f.apply({cli:true});assert.equal(entry.runtime.root,f.successor);assert.equal(entry.stable_ready,false);
  // Entry carries the job class; the sealed recovery's own plist never had it.
  assert.doesNotMatch(f.anchor.plist,/ProcessType|Nice/);
  assert.match(fs.readFileSync(f.file,'utf8'),/<key>ProcessType<\/key><string>Interactive<\/string>\n<key>Nice<\/key><integer>5<\/integer>/);
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
  // Both immutable helpers retain the existing record contract; canonical bytes moved
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

function savedChain(f){
  // Feed the independently shipped evaluator the SAME immutable archives and
  // completed event history, rather than a second hand-authored model.
  const events=loadEvents(f.org).events;
  const original=JSON.parse(fs.readFileSync(f.originalArchive,'utf8'));
  const history={installation:fs.readFileSync(f.installationFile,'utf8'),plist:fs.readFileSync(f.file,'utf8'),files:[]};
  const references={},verified=new Set();
  for(const folder of ['probation-switches','probation-successors','probation-successor-effects','probation-successor-clears']){
    const dir=path.join(f.directory,folder);if(!fs.existsSync(dir))continue;
    for(const name of fs.readdirSync(dir)){
      const file=path.join(dir,name),bytes=fs.readFileSync(file,'utf8'),id='archive-'+history.files.length;
      history.files.push({file,bytes,sha256:sha(bytes),evidence:[id]});
      references[id]={sha256:sha(bytes)};verified.add(id);
    }
  }
  return{events,original,authority:events.find(e=>e.type==='line-service.probation-authorized'),
    history,verified,references,from:new Date(Date.now()+1000).toISOString(),startSeq:events.at(-1).seq};
}

test('successor refuses reused legacy effect IDs before effects',async t=>{
  const f=await successorFixture(t),before=state(f);
  for(const id of ['old-entry','old-anchor'])assert.throws(()=>f.run({id,dryRun:true}),/completed legacy probation effect id retained/);
  assert.equal(f.run({id:'fresh-entry',dryRun:true}).runtime.root,f.successor);
  assert.deepEqual(state(f),before);
  assert.equal(fs.existsSync(path.join(f.directory,'probation-successor-effects')),false);
});

test('append-only extensions preserve the actual legacy first archive and sealed recovery, and return to an earlier compatible extension',async t=>{
  const f=await successorFixture(t),legacy=f.candidate('legacy',{legacy:true}),second=f.candidate('successor-two');
  const names=['probation-successor.mjs','probation-successor-history.mjs','probation.mjs','development-recovery.mjs','runtime.mjs','launchd.mjs'];
  const canonical=new Map(names.map(n=>[n,fs.readFileSync(path.join(f.cwd,'line-service',n))]));
  for(const name of names)fs.copyFileSync(path.join(legacy,'line-service',name),path.join(f.cwd,'line-service',name));
  f.git('add','line-service');f.git('commit','-qm','Establish the retained legacy successor with its actual writer');
  f.apply({id:'legacy-entry',targetRoot:legacy});f.back({id:'legacy-back',fromRoot:legacy});
  const firstFile=path.join(f.directory,'probation-successors/original-trial.json'),firstBytes=fs.readFileSync(firstFile);
  for(const [name,bytes]of canonical)fs.writeFileSync(path.join(f.cwd,'line-service',name),bytes);
  f.git('add','line-service');f.git('commit','-qm','Restore collection writer without rewriting retained history');
  f.apply();await startPassStop(f,f.successor);f.back();await startPassStop(f,f.recovery);
  f.apply({id:'two-entry',targetRoot:second});await startPassStop(f,second);
  assert.throws(()=>f.run({id:'direct-switch',fromRoot:second,targetRoot:f.successor,dryRun:true}),/recovery entry/);
  assert.throws(()=>f.run({id:'wrong-rollback',fromRoot:f.successor,targetRoot:f.recovery,rollback:true,dryRun:true}),/current root differs/);
  f.back({id:'two-back',fromRoot:second});await startPassStop(f,f.recovery);
  const recovered=state(f);
  assert.throws(()=>f.run({id:'legacy-return',targetRoot:legacy,dryRun:true}),/profile ab671e8986 lacks successor-history\/v2/);
  assert.deepEqual(state(f),recovered);
  assert.equal(fs.readFileSync(f.installationFile,'utf8'),f.anchor.installation);assert.equal(fs.readFileSync(f.file,'utf8'),f.anchor.plist);
  f.returned();await startPassStop(f,f.successor);
  const {acceptedRuntime}=await f.module(f.successor,'line-service/runtime.mjs');
  assert.equal(acceptedRuntime(f.cwd,{root:f.successor,home:f.installationHome}).probation.successor.archive.file,
    path.join(f.directory,'probation-successors/original-trial--successor-entry.json'));
  assert.deepEqual(fs.readFileSync(firstFile),firstBytes);assert.deepEqual(fs.readFileSync(f.originalArchive),f.originalBytes);
  for(const [file,e]of Object.entries(f.original.scope.previous.source.files))assert.deepEqual(payloadEntry(f.recovery,file),e);
  assert.equal(loadEvents(f.org).events.filter(e=>e.type==='line-service.probation-authorized').length,1);
  assert.equal(loadEvents(f.org).events.filter(e=>e.type==='line-service.probation-successor-authorized').length,3);
  assert.equal(fs.readFileSync(f.retained,'utf8'),f.jobs);
  const chain=savedChain(f);
  assert.equal(probationChain(chain).candidate.release.root,f.successor);
  assert.equal(probationChain(chain).lastSeq,loadEvents(f.org).events.at(-1).seq);

  const record=path.join(f.org,'events.jsonl'),recordBytes=fs.readFileSync(record,'utf8');
  for(const change of [
    rows=>{rows.find(e=>e.type==='line-service.probation-successor-authorized').trial='other-trial';},
    rows=>{rows.find(e=>e.type==='line-service.probation-successor-authorized').native_caller.name='foreign';},
    rows=>{rows.find(e=>e.id==='two-entry'&&e.type==='line-service.probation-successor-authorized').candidate=rows.find(e=>e.id==='successor-entry'&&e.type==='line-service.probation-successor-authorized').candidate;},
    rows=>{rows.find(e=>e.id==='two-entry'&&e.type==='line-service.probation-successor-switched').previous_seq=1;},
    rows=>{rows.find(e=>e.id==='two-entry'&&e.type==='line-service.probation-successor-switched').archive=rows.find(e=>e.id==='successor-entry'&&e.type==='line-service.probation-successor-switched').archive;},
  ]){
    const rows=recordBytes.trim().split('\n').map(JSON.parse);change(rows);fs.writeFileSync(record,rows.map(e=>JSON.stringify(e)).join('\n')+'\n');
    assert.throws(()=>f.run({id:'bad-history',fromRoot:f.successor,targetRoot:f.recovery,rollback:true,dryRun:true}),/successor|authority/);
    fs.writeFileSync(record,recordBytes);
  }
  fs.chmodSync(firstFile,0o644);assert.throws(()=>f.run({dryRun:true}),/mutable/);fs.chmodSync(firstFile,0o444);
  const orphan=path.join(f.directory,'probation-successors/orphan.json');fs.writeFileSync(orphan,'{}');
  assert.throws(()=>f.run({dryRun:true}),/UNKNOWN/);fs.unlinkSync(orphan);
  assert.deepEqual(fs.readFileSync(firstFile),firstBytes);
});

test('successor rejects an incompatible sealed candidate before effects without executing target code',async t=>{
  const f=await successorFixture(t,{incompatibleCandidate:true}),before=state(f);
  assert.throws(()=>f.run({dryRun:true,cli:true}),/successor-incompatible: unrecognized successor-reader\/v1/);
  assert.deepEqual(state(f),before);
  assert.equal(fs.existsSync(path.join(f.directory,'probation-successor-effects')),false);
});

test('successor history v2 refuses the actual frozen v1 reader without rewriting its profile',async t=>{
  const f=await successorFixture(t,{legacyCandidate:true}),before=state(f);
  assert.throws(()=>requireSuccessorCapabilities(f.successor),/profile ab671e8986 lacks successor-history\/v2/);
  assert.throws(()=>f.run({dryRun:true,cli:true}),/profile ab671e8986 lacks successor-history\/v2/);
  assert.deepEqual(state(f),before);
  assert.equal(fs.existsSync(path.join(f.directory,'probation-successor-effects')),false);
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
  const candidateCLI=path.join(f.successor,'bin/org.mjs'),candidateBytes=fs.readFileSync(candidateCLI);
  fs.appendFileSync(candidateCLI,'\n// drift');assert.throws(()=>f.run({dryRun:true}),/incomplete release/);
  fs.writeFileSync(candidateCLI,candidateBytes);
  assert.equal(f.run({dryRun:true}).plan_sha256,p.plan_sha256,'restored owner hold and unrelated record traffic preserve the preview');
  fs.appendFileSync(path.join(f.cwd,'bin/org.mjs'),'\n// Canonical source moved after preview.\n');
  f.git('add','bin/org.mjs');f.git('commit','-qm','Move source after successor preview');
  assert.throws(()=>f.run({expectedPlan:p.plan_sha256,authority:seq}),/plan changed/,'fresh source identity still invalidates a stale preview');
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

test('partial later extensions and completed later rollback clears retain startup and replacement fences',async t=>{
  for(const stage of ['fence','authority','intent','plist','installation','clear-receipt'])await t.test(stage,async st=>{
    const f=await successorFixture(st);f.apply();f.back();
    const firstFile=path.join(f.directory,'probation-successors/original-trial.json'),firstBytes=fs.readFileSync(firstFile);
    const second=f.candidate('second-unknown');
    const options=stage==='clear-receipt'
      ?(f.apply({id:'second-entry',targetRoot:second}),{id:'second-back',fromRoot:second,targetRoot:f.recovery,rollback:true})
      :{id:'second-entry',targetRoot:second};
    const preview=f.run({...options,dryRun:true}),authority=decide(f,preview.required_decision);
    assert.throws(()=>f.run({...options,expectedPlan:preview.plan_sha256,authority,faultStage:stage}),new RegExp('injected '+stage));
    const retained=state(f);
    for(const id of [options.id,'replacement'])assert.throws(()=>f.run({id,dryRun:true}),/UNKNOWN|completed successor|fence retained/);
    await oldRefuses(f);
    const {main}=await f.module(second,'line-service/launchd.mjs');
    assert.throws(()=>main(['restart','--repo',f.cwd,'--org',f.org],f.args),/UNKNOWN|fence retained|binding differs|drifted|executing line runtime differs from the accepted project pin/);
    assert.deepEqual(state(f),retained);assert.deepEqual(fs.readFileSync(firstFile),firstBytes);
    assert.equal(fs.readFileSync(f.retained,'utf8'),f.jobs);
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
