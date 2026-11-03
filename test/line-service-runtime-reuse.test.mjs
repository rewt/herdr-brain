import test from './helpers/bounded-test.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fixture} from './helpers/line-service-probation-fixture.mjs';
import {loadRecord,transact} from '../lib/store.mjs';
import {runtimeReuse} from '../line-service/runtime-reuse.mjs';

const edited=(file,change)=>{
  const bytes=fs.readFileSync(file),mode=fs.statSync(file).mode;
  fs.chmodSync(file,mode|0o200);fs.writeFileSync(file,change(bytes));fs.chmodSync(file,mode);
  return ()=>{fs.chmodSync(file,mode|0o200);fs.writeFileSync(file,bytes);fs.chmodSync(file,mode);};
};
// Same length, so only the bytes and the timestamps differ.
const flipped=bytes=>{const next=Buffer.from(bytes);next[0]^=1;return next;};
const installedService=async(f,root)=>{
  const {createLineService}=await f.module(root,'line-service/line-service.mjs');
  return createLineService({repo:f.cwd,org:f.org,to:f.agent.name,runtimeHome:f.installationHome,env:f.env,haltAfter:100,
    command:()=>({status:0,stdout:'{"created":[]}'}),capacity:()=>({count:0,cap:2})});
};
const lastPass=directory=>fs.readFileSync(path.join(directory,'passes.jsonl'),'utf8').trim().split('\n').map(JSON.parse).filter(row=>row.action==='pass-complete').at(-1);

test('byte verification is reused only while its key and every physical input are unchanged',t=>{
  const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'runtime-reuse-')));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const tree=path.join(root,'tree'),file=path.join(tree,'lib/payload'),other=path.join(root,'other'),link=path.join(root,'node');
  fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,'payload');fs.writeFileSync(other,'first');fs.symlinkSync(file,link);
  const outcomes=[],reuse=runtimeReuse(outcome=>outcomes.push(outcome));
  let runs=0;
  const check=(key='key',paths=[tree])=>reuse(key,paths,()=>++runs);
  const verified=(operation,message)=>{const before=runs;operation();check();assert.equal(runs,before+1,message);};
  assert.equal(check(),1);assert.equal(check(),1);assert.deepEqual(outcomes,['verified','reused']);
  check('another key');assert.equal(runs,2,'a changed key is a different computation');

  const {atime,mtime}=fs.statSync(file);
  verified(()=>{fs.writeFileSync(file,'PAYLOAD');fs.utimesSync(file,atime,mtime);},'same size and mtime still moves ctime');
  verified(()=>fs.writeFileSync(path.join(tree,'lib/added'),''),'an added file');
  verified(()=>fs.rmSync(path.join(tree,'lib/added')),'a removed file');
  verified(()=>fs.chmodSync(file,0o600),'a changed mode');
  verified(()=>{fs.rmSync(file);fs.writeFileSync(file,'PAYLOAD');},'a replaced file');

  // A failure is never kept, so the same refusal repeats until it is repaired.
  const refused=runtimeReuse();let attempts=0;
  for(const n of [1,2])assert.throws(()=>refused('k',[tree],()=>{attempts++;throw Error('refusal');}),/refusal/);
  assert.equal(attempts,2);
  // A result whose inputs moved while it ran proves nothing about the later bytes.
  const moving=runtimeReuse();let moved=0;
  moving('k',[tree],()=>{moved++;fs.appendFileSync(file,'x');});moving('k',[tree],()=>{moved++;});
  assert.equal(moved,2);moving('k',[tree],()=>{moved++;});assert.equal(moved,2);
  // A missing input keeps the original check's own refusal.
  assert.throws(()=>runtimeReuse()('k',[path.join(root,'missing')],()=>{throw Error('original refusal');}),/original refusal/);
  assert.equal(runtimeReuse()('k',[path.join(root,'missing')],()=>'unverifiable input is never kept'),'unverifiable input is never kept');

  // A retargeted executable link is a changed input, as is the file it reaches.
  const node=runtimeReuse();let hashes=0;
  const hash=()=>node('node',[link],()=>++hashes);
  hash();hash();assert.equal(hashes,1);
  fs.rmSync(link);fs.symlinkSync(other,link);hash();assert.equal(hashes,2);
  fs.writeFileSync(other,'FIRST');hash();assert.equal(hashes,3);hash();assert.equal(hashes,3);
});

test('an active trial reuses hashes across a real pass and every stopping change still stops the next snapshot',async t=>{
  const f=await fixture(t);f.authorize();f.enter();
  assert.equal(f.main(['restart','--repo',f.cwd,'--org',f.org],f.args).restarted,true);
  const service=await installedService(f,f.next);
  // The form the --general-pass child runs, so its first snapshot is inside the pass.
  assert.equal(service.pass({reconcileCloseout:false}).result,'pass-complete');
  const {timing}=lastPass(service.directory);
  assert.ok(timing.snapshots>=2,'the pass observes more than once');
  assert.equal(timing.runtime_bytes_verified,2,'the candidate and previous release hash once');
  assert.equal(timing.runtime_bytes_reused,2*(timing.snapshots-1),'every later snapshot reuses both');
  assert.ok(service.observe().events.length);

  // Changed installation: the running root, then the retained rollback root.
  // Each stops the very next snapshot and repairing the bytes admits again.
  for(const [file,refusal] of [
    [path.join(f.next,'lib/cli-help.mjs'),/incomplete release trial/],
    [path.join(f.next,'.release-manifest.json'),/tuple drifted/],
    [path.join(f.bundle,'lib/cli-help.mjs'),/incomplete release compatible/],
  ]){
    const {atime,mtime}=fs.statSync(file),restore=edited(file,file.endsWith('.json')?bytes=>Buffer.concat([bytes,Buffer.from('\n')]):flipped);
    fs.utimesSync(file,atime,mtime);
    assert.throws(service.observe,refusal,file);assert.throws(service.observe,refusal,'a failed verification is not kept');
    restore();
    assert.ok(service.observe().events.length,`repairing ${file} admits again`);
  }
  const added=path.join(f.next,'lib/added.mjs');fs.writeFileSync(added,'');
  assert.throws(service.observe,/inventory/);fs.rmSync(added);assert.ok(service.observe().events.length);

  // A saved installation is read at process start, before and after this change.
  const {installedContext}=await f.module(f.next,'line-service/cutoff.mjs');
  assert.equal(installedContext(f.cwd,f.org).installation.source,f.next);
  const saved=f.installationFile,restoreSaved=edited(saved,bytes=>Buffer.from(JSON.stringify({...JSON.parse(bytes),node:'/other/node'})+'\n'));
  assert.throws(()=>installedContext(f.cwd,f.org));
  restoreSaved();assert.equal(installedContext(f.cwd,f.org).installation.source,f.next);

  // Record decisions read this snapshot's record, and a foreign one is ignored.
  const log=path.join(f.org,'events.jsonl'),complete=fs.statSync(log).size;
  fs.appendFileSync(log,'{"seq":');
  assert.throws(service.observe,/incomplete record prevents probation admission/);
  fs.truncateSync(log,complete);assert.ok(service.observe().events.length);
  const owner=hold=>transact(f.org,()=>({add:[{type:'item.updated',id:'G-1',fields:{meta:{hold}}}]}));
  owner(true);assert.throws(service.observe,/probation authority HOLD/);
  owner(false);assert.ok(service.observe().events.length);
  const {acceptedRuntime}=await f.module(f.next,'line-service/runtime.mjs');
  const options={root:f.next,home:f.installationHome,verifyFiles:false};
  assert.equal(acceptedRuntime(f.cwd,{...options,record:{org:'/foreign/record',events:[],state:null}}).probation.id,'original-trial');

  // Withdrawn trial: the first snapshot carrying the withdrawal refuses.
  assert.equal(f.withdraw().admissions,false);
  assert.throws(service.observe,/withdrawn\/completed/);
  assert.throws(service.observe,/withdrawn\/completed/);
});

test('a completed trial stops the next snapshot even with all its hashes kept',async t=>{
  const f=await fixture(t);f.authorize();f.enter();
  assert.equal(f.main(['restart','--repo',f.cwd,'--org',f.org],f.args).restarted,true);
  const service=await installedService(f,f.next);
  assert.ok(service.observe().events.length);assert.ok(service.observe().events.length);
  transact(f.org,()=>({add:[{type:'line-service.probation-completed',id:'original-trial',project:f.identity,repo:f.cwd,org:fs.realpathSync(f.org)}]}));
  assert.throws(service.observe,/withdrawn\/completed/);
});

test('a pinned runtime stops the next snapshot on a changed pin or installation and admits again once restored',async t=>{
  const f=await fixture(t);fs.rmSync(f.stop);
  const service=await installedService(f,f.bundle);
  f.release('other',{commit:'3'.repeat(40)});
  assert.ok(service.observe().events.length);
  const pin=release=>{fs.writeFileSync(path.join(f.cwd,'.herdr-release.json'),JSON.stringify({release})+'\n');f.git('add','.herdr-release.json');f.git('commit','-qm',`Pin ${release}`);};
  pin('other');assert.throws(service.observe,/differs from the accepted project pin/);
  pin(null);assert.throws(service.observe,/explicit accepted project pin/);
  pin('compatible');assert.ok(service.observe().events.length);
  const restore=edited(path.join(f.bundle,'.release-manifest.json'),bytes=>Buffer.from(JSON.stringify({...JSON.parse(bytes),commit:'4'.repeat(40)})));
  assert.throws(service.observe,/incomplete or incompatible release/);
  restore();assert.ok(service.observe().events.length);
});

test('a development-recovery trial binds its reuse to the sealed payload and the Node binary',async t=>{
  const f=await fixture(t,{development:true}),preview=f.control({dryRun:true});f.authorize();
  const recovery=preview.scope.previous.release.root;
  const [{acceptedRuntime},{runtimeReuse:reuseFrom}]=await Promise.all(['runtime','runtime-reuse'].map(name=>f.module(f.next,`line-service/${name}.mjs`)));
  const counts={verified:0,reused:0},seen=[],reuse=reuseFrom(outcome=>counts[outcome]++);
  const admit=()=>acceptedRuntime(f.cwd,{root:f.next,home:f.installationHome,verifyFiles:false,record:{...loadRecord(f.org),org:fs.realpathSync(f.org)},
    reuse:(key,paths,verify)=>{seen.push(paths);return reuse(key,paths,verify);}});
  assert.equal(admit().probation.id,'original-trial');assert.deepEqual(counts,{verified:2,reused:0});
  admit();assert.deepEqual(counts,{verified:2,reused:2});
  assert.deepEqual(seen.find(paths=>paths.includes(process.execPath)),[recovery,process.execPath]);
  // The sealed payload refuses a writable file, so a mode change alone must stop it.
  const file=path.join(recovery,'lib/cli-help.mjs'),mode=fs.statSync(file).mode;
  fs.chmodSync(file,mode|0o200);assert.throws(admit,/writable/);
  // Only a success counts as verified; the kept candidate hash stays reused throughout.
  fs.chmodSync(file,mode);admit();assert.deepEqual(counts,{verified:3,reused:4});
});
