import test from './helpers/bounded-test.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {execFileSync,spawnSync} from 'node:child_process';
import {configFixture} from './helpers/config-home-fixture.mjs';
import {copyProduct} from '../lib/product-files.mjs';
import {transact} from '../lib/store.mjs';
import {requireRecordFileCompatibility} from '../lib/record-compatibility.mjs';

const source=path.resolve(import.meta.dirname,'..');
function fixture(t) {
  const f=configFixture(t,{custom:true}),bin=path.join(f.scratch,'bin'),plist=path.join(f.scratch,'service.plist');
  fs.mkdirSync(bin);
  fs.mkdirSync(f.env.HERDR_MONITOR_FLEET,{recursive:true});
  fs.writeFileSync(path.join(f.env.HERDR_MONITOR_FLEET,'fleet.json'),JSON.stringify({version:1,session_limit:6,projects:{
    consumer:{identity:path.join(f.cwd,'.git'),checkout:f.cwd,record:f.env.ORG_DIR,worktrees:path.join(f.scratch,'lanes'),layers:[]},
  }}));
  const env={...f.env,PATH:path.dirname(process.execPath)+':'+f.env.PATH,
    HERDR_MONITOR_HOME:f.installationHome,HERDR_MONITOR_BIN:bin,HERDR_MONITOR_PLIST:plist,
    HERDR_BIN_PATH:path.join(f.scratch,'no-native-plugin'),RELEASE_NO_LAUNCHD:'1'};
  const run=(file,args)=>spawnSync(file,args,{cwd:f.cwd,env,encoding:'utf8'});
  const ok=result=>{assert.equal(result.status,0,result.stdout+result.stderr);return result.stdout;};
  const seal=(root,commit)=>{
    fs.writeFileSync(path.join(root,'.release-commit'),commit+'\n');
    const summary=path.join(root,'.release-acceptance.json');
    fs.writeFileSync(summary,JSON.stringify({ready:true,candidateCommit:commit,elapsedSeconds:1,counts:{PASS:1,FAIL:0,PENDING:0,SKIP:0}}));
    ok(run(process.execPath,[path.join(source,'herdr/releases.mjs'),'manifest',root,summary]));
  };
  const pin=id=>{
    fs.writeFileSync(path.join(f.cwd,'.herdr-release.json'),JSON.stringify({release:id})+'\n');
    f.git('add','.herdr-release.json');f.git('commit','-qm','Accept '+id);
  };
  const activate=(id,tools=source)=>run('bash',[path.join(tools,'herdr/release.sh'),'activate',id]);
  const record=path.join(f.env.ORG_DIR,'events.jsonl');
  transact(f.env.ORG_DIR,()=>({add:[{type:'item.added',id:'ENG-1',title:'Pinned consumer work',role:'engineer'},
    {type:'report.ingested',run:'R-1',report:{outcome:'done'}},{type:'change.landed',run:'R-1'}]}));
  return {...f,bin,plist,env,run,ok,seal,pin,activate,record};
}

test('activating a scratch release preserves real commands on the historical BCH pin and its events',t=>{
  const f=fixture(t),commit='98002dc75cb064dd639e79c922ddeb98d3781bc2';
  const archive=path.join(f.scratch,'historical'),root=path.join(f.installationHome,'releases','old');
  fs.mkdirSync(archive);
  const bytes=execFileSync('git',['archive',commit],{maxBuffer:64*1024*1024});
  execFileSync('tar',['-x','-C',archive],{input:bytes});
  copyProduct(archive,root);f.seal(root,commit);f.pin('old');
  assert.equal(fs.existsSync(path.join(root,'lib/record-compatibility.mjs')),false);
  // Preserve the observed failure premise without executing any live consumer.
  assert.throws(()=>requireRecordFileCompatibility(root,f.record),/record-incompatible:.*report.ingested.*change.landed/);
  const before=fs.readFileSync(f.record,'utf8'),pin=fs.readFileSync(path.join(f.cwd,'.herdr-release.json'),'utf8');
  const activated=f.ok(f.activate('compatible'));
  assert.match(activated,/"admission":"legacy"/);
  for(const name of ['org','record']) {
    assert.match(f.ok(f.run(process.execPath,[path.join(f.bin,name),'show','ENG-1'])),/Pinned consumer work/);
  }
  assert.match(f.ok(f.run(process.execPath,[path.join(f.bin,'lane'),'--help'])),/lane/i);
  // The mutable-current direct entry forwards through the same selected contract.
  assert.match(f.ok(f.run(process.execPath,[path.join(f.installationHome,'current/bin/org.mjs'),'show','ENG-1'])),/Pinned consumer work/);
  assert.equal(fs.readFileSync(f.record,'utf8'),before);
  assert.equal(fs.readFileSync(path.join(f.cwd,'.herdr-release.json'),'utf8'),pin);
});

test('a newer router uses the selected admission contract rather than its own stricter contract',t=>{
  const f=fixture(t);f.pin('compatible');
  const newer=f.release('newer'),module=path.join(newer,'lib/record-compatibility.mjs');
  fs.writeFileSync(module,fs.readFileSync(module,'utf8').replace('export function requireRecordCompatibility(root, events) {',
    "export function requireRecordCompatibility(root, events) {\n  throw Error('new router contract refuses this record');"));
  f.seal(newer,'2'.repeat(40));
  f.ok(f.activate('newer',newer));
  for(const entry of [path.join(f.bin,'record'),path.join(f.installationHome,'current/bin/org.mjs')])
    assert.match(f.ok(f.run(process.execPath,[entry,'show','ENG-1'])),/Pinned consumer work/);
  // A consumer selecting the newer contract still gets that contract's refusal.
  f.pin('newer');
  const refused=f.run(process.execPath,[path.join(f.bin,'record'),'show','ENG-1']);
  assert.notEqual(refused.status,0);assert.match(refused.stderr,/new router contract refuses/);assert.equal(refused.stdout,'');
});

test('the first array-based admission contract remains usable and still refuses unsupported core events',t=>{
  const f=fixture(t),commit=execFileSync('git',['rev-parse','fc75053b'],{encoding:'utf8'}).trim();
  const archive=path.join(f.scratch,'first-admission'),root=path.join(f.installationHome,'releases','array');
  fs.mkdirSync(archive);
  const bytes=execFileSync('git',['archive',commit],{maxBuffer:64*1024*1024});
  execFileSync('tar',['-x','-C',archive],{input:bytes});
  copyProduct(archive,root);f.seal(root,commit);f.pin('array');f.ok(f.activate('compatible'));
  assert.match(f.ok(f.run(process.execPath,[path.join(f.bin,'record'),'show','ENG-1'])),/Pinned consumer work/);
  fs.appendFileSync(f.record,JSON.stringify({type:'item.future-contract',seq:999})+'\n');
  const refused=f.run(process.execPath,[path.join(f.bin,'record'),'show','ENG-1']);
  assert.notEqual(refused.status,0);assert.match(refused.stderr,/item.future-contract/);assert.equal(refused.stdout,'');
});

test('consumer pin refusal precedes activation effects and recovery retains the original links and pin',t=>{
  const f=fixture(t);f.pin('compatible');f.ok(f.activate('compatible'));
  const newer=f.release('newer'),before=fs.readFileSync(f.record,'utf8');
  const links=[path.join(f.installationHome,'current'),path.join(f.bin,'record')].map(file=>[file,fs.readlinkSync(file)]);
  fs.writeFileSync(f.plist,'untouched service');
  fs.appendFileSync(f.record,JSON.stringify({type:'item.future-contract',seq:999})+'\n');
  const refused=f.activate('newer');
  assert.notEqual(refused.status,0);assert.match(refused.stderr,/consumer pin preflight failed for consumer:.*item.future-contract/);
  for(const [file,target] of links)assert.equal(fs.readlinkSync(file),target);
  assert.equal(fs.existsSync(path.join(f.installationHome,'previous')),false);
  assert.equal(fs.readFileSync(f.plist,'utf8'),'untouched service');
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.cwd,'.herdr-release.json'))).release,'compatible');
  // Scratch-only repair of the intentionally incompatible log, followed by the
  // same activation; the consumer continues to use its unchanged accepted pin.
  fs.writeFileSync(f.record,before);f.ok(f.activate('newer'));
  assert.equal(fs.readlinkSync(path.join(f.installationHome,'current')),newer);
  assert.match(f.ok(f.run(process.execPath,[path.join(f.bin,'record'),'show','ENG-1'])),/Pinned consumer work/);
});

function assertInstalledTools(f) {
  for(const name of ['org','record','lane']) {
    const launcher=fs.readlinkSync(path.join(f.bin,name));
    assert.equal(path.dirname(path.dirname(launcher)),path.join(f.installationHome,'routing'));
    assert.equal(fs.readFileSync(path.join(path.dirname(launcher),'lib/releases.mjs'),'utf8'),
      fs.readFileSync(path.join(source,'lib/releases.mjs'),'utf8'));
  }
}

test('rollback restores the previous release despite a consumer preflight refusal',t=>{
  const f=fixture(t);
  fs.appendFileSync(path.join(f.bundle,'lib/releases.mjs'),'\n// Release A differs from the recovery tools.\n');
  f.seal(f.bundle,'1'.repeat(40));f.pin('compatible');f.ok(f.activate('compatible'));
  const newer=f.release('newer');f.ok(f.activate('newer'));
  const current=path.join(f.installationHome,'current'),previous=path.join(f.installationHome,'previous');
  assert.equal(fs.readlinkSync(previous),f.bundle);
  const pinFile=path.join(f.cwd,'.herdr-release.json'),pin=fs.readFileSync(pinFile);
  fs.appendFileSync(f.record,JSON.stringify({type:'item.future-contract',seq:999})+'\n');
  // Require recovery to reinstall all launchers from the tools in use.
  for(const name of ['org','record','lane'])fs.unlinkSync(path.join(f.bin,name));
  f.ok(f.run('bash',[path.join(source,'herdr/release.sh'),'rollback']));
  assert.equal(fs.readlinkSync(current),f.bundle);
  assert.equal(fs.readlinkSync(previous),newer);
  assertInstalledTools(f);
  assert.deepEqual(fs.readFileSync(pinFile),pin);
  const links=[current,previous,...['org','record','lane'].map(name=>path.join(f.bin,name))]
    .map(file=>[file,fs.readlinkSync(file)]);
  fs.writeFileSync(f.plist,'untouched service');
  const refused=f.activate('newer');
  assert.notEqual(refused.status,0);assert.match(refused.stderr,/consumer pin preflight failed.*item.future-contract/);
  for(const [file,target] of links)assert.equal(fs.readlinkSync(file),target);
  assert.equal(fs.readFileSync(f.plist,'utf8'),'untouched service');
  assert.deepEqual(fs.readFileSync(pinFile),pin);
});

test('ship completes automatic rollback and repairs previous when a consumer fault appears after activation',t=>{
  const f=fixture(t);
  fs.appendFileSync(path.join(f.bundle,'lib/releases.mjs'),'\n// Release A differs from the recovery tools.\n');
  f.seal(f.bundle,'1'.repeat(40));f.pin('compatible');f.ok(f.activate('compatible'));
  const earlier=f.release('earlier');f.ok(f.activate('earlier'));f.ok(f.activate('compatible'));
  const newer=f.release('newer');
  fs.writeFileSync(path.join(newer,'contrib/settle-watch.mjs'),'const broken = ;\n');
  f.seal(newer,'2'.repeat(40));
  const pinFile=path.join(f.cwd,'.herdr-release.json'),pin=fs.readFileSync(pinFile);
  // Exercise the real ship/activate/verify/rollback functions with a prebuilt
  // scratch candidate. Building a candidate (and its suites) is outside this control.
  const script=fs.readFileSync(path.join(source,'herdr/release.sh'),'utf8')
    .split('case "${1:-}" in\n')[0].replace('verify_installed() {','check_installed() {')+`
build() { [ "$1" = newer ]; }
verify_installed() {
  [ "$(readlink "$HOME_DIR/current")" = "$HOME_DIR/releases/newer" ] || exit 90
  printf '%s\\n' '{"type":"item.future-contract","seq":999}' >> "$ORG_DIR/events.jsonl"
  check_installed
}
ship newer
`;
  const shipped=f.run('bash',['-c',script,path.join(source,'herdr/release.sh')]);
  assert.equal(shipped.status,1,shipped.stdout+shipped.stderr);
  assert.match(shipped.stderr,/failed its post-activation check; rolled back to compatible/);
  assert.equal(fs.readlinkSync(path.join(f.installationHome,'current')),f.bundle);
  assert.equal(fs.readlinkSync(path.join(f.installationHome,'previous')),earlier);
  assert.match(fs.readFileSync(f.record,'utf8'),/item.future-contract/);
  assertInstalledTools(f);
  assert.deepEqual(fs.readFileSync(pinFile),pin);
});

test('an unpinned stale registration cannot block activation but an unreadable accepted pin does',t=>{
  const f=fixture(t),fleetFile=path.join(f.env.HERDR_MONITOR_FLEET,'fleet.json');
  const fleet=JSON.parse(fs.readFileSync(fleetFile));
  // The checkout still has an explicit accepted unpin, but its registered
  // identity is stale. No pinned consumer contract needs that identity check.
  fleet.projects.consumer.identity=path.join(f.scratch,'stale.git');
  fs.writeFileSync(fleetFile,JSON.stringify(fleet));
  f.ok(f.activate('compatible'));
  // A stale non-repository registration likewise has no accepted pin.
  const stale=path.join(f.scratch,'stale-checkout');fs.mkdirSync(stale);
  fleet.projects.consumer.checkout=stale;fs.writeFileSync(fleetFile,JSON.stringify(fleet));
  const newer=f.release('newer');f.ok(f.activate('newer'));
  assert.equal(fs.readlinkSync(path.join(f.installationHome,'current')),newer);
  fleet.projects.consumer.checkout=f.cwd;fleet.projects.consumer.identity=path.join(f.cwd,'.git');
  fs.writeFileSync(fleetFile,JSON.stringify(fleet));
  f.pin('compatible');fs.unlinkSync(path.join(f.cwd,'.herdr-release.json'));
  const refused=f.activate('compatible');
  assert.notEqual(refused.status,0);assert.match(refused.stderr,/consumer pin preflight failed.*committed.*missing/);
  assert.equal(fs.readlinkSync(path.join(f.installationHome,'current')),newer);
});

test('a missing or changed listed admission module refuses instead of becoming a legacy bypass',t=>{
  const f=fixture(t);f.pin('compatible');f.ok(f.activate('compatible'));
  const module=path.join(f.bundle,'lib/record-compatibility.mjs'),original=fs.readFileSync(module);
  for(const change of [()=>fs.appendFileSync(module,'\n// changed\n'),()=>fs.unlinkSync(module)]) {
    change();
    const refused=f.run(process.execPath,[path.join(f.bin,'record'),'show','ENG-1']);
    assert.notEqual(refused.status,0);assert.equal(refused.stdout,'');assert.match(refused.stderr,/record-compatibility.mjs/);
    fs.writeFileSync(module,original);
  }
  assert.match(f.ok(f.run(process.execPath,[path.join(f.bin,'record'),'show','ENG-1'])),/Pinned consumer work/);
});
