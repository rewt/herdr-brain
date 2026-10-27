import test from './helpers/bounded-test.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { sealRemovalInputs,sealHousekeepingOwners } from '../lib/retire-local.mjs';

function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'removal-seal-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const retirement = path.join(root, 'retirement'), occupants = path.join(retirement, 'occupants');
  fs.mkdirSync(occupants, { recursive: true });
  const external = path.join(root, 'external.json'); fs.writeFileSync(external, 'not authority');
  return { root, retirement, occupants, external };
}

test('cleanup tail target seal ignores unrelated receipts but detects matching additions edits and redirects',async t=>{
  const {sealScopedRemovalInputs}=await import('../lib/retire-local.mjs');assert.equal(typeof sealScopedRemovalInputs,'function');
  for(const kind of ['unrelated','matching','edit','redirect','malformed']){
    const f=fixture(t),target=path.join(f.occupants,'target.json'),other=path.join(f.occupants,'other.json');
    fs.writeFileSync(target,JSON.stringify({common:'/project/.git',run:'R-1',cwd:'/project/lane'}));
    fs.writeFileSync(other,JSON.stringify({common:'/project/.git',run:'R-2',cwd:'/project/other'}));
    const verify=sealScopedRemovalInputs([f.retirement],{common:'/project/.git',cwd:'/project/lane',runs:['R-1'],items:['ENG-1']});
    if(kind==='unrelated'){fs.writeFileSync(other,JSON.stringify({common:'/project/.git',run:'R-2',cwd:'/project/other',changed:true}));fs.writeFileSync(path.join(f.occupants,'new.json'),JSON.stringify({common:'/project/.git',run:'R-3',cwd:'/project/another'}));assert.doesNotThrow(verify);continue;}
    if(kind==='matching')fs.writeFileSync(path.join(f.occupants,'new.json'),JSON.stringify({common:'/project/.git',run:'R-9',cwd:'/project/lane'}));
    if(kind==='edit')fs.writeFileSync(target,JSON.stringify({common:'/project/.git',run:'R-1',changed:true}));
    if(kind==='redirect'){fs.renameSync(target,target+'.old');fs.symlinkSync(target+'.old',target);}
    if(kind==='malformed')fs.writeFileSync(other,'{unknown');
    assert.throws(verify,/changed|redirect|invalid|JSON|unknown/);
  }
});

test('cleanup tail target seal canonicalizes receipt path aliases before classifying a foreign scope',async t=>{
  const {sealScopedRemovalInputs}=await import('../lib/retire-local.mjs'),f=fixture(t),common=path.join(f.root,'common'),lane=path.join(f.root,'lane'),alias=path.join(f.root,'alias');
  fs.mkdirSync(common);fs.mkdirSync(lane);fs.mkdirSync(alias);fs.symlinkSync(common,path.join(alias,'common'));fs.symlinkSync(lane,path.join(alias,'lane'));
  const target=path.join(f.occupants,'target.json');fs.writeFileSync(target,JSON.stringify({common:path.join(alias,'common'),cwd:path.join(alias,'lane'),run:'R-9'}));
  const verify=sealScopedRemovalInputs([f.retirement],{common,cwd:lane,runs:['R-1'],items:['ENG-1']});
  fs.writeFileSync(target,JSON.stringify({common:path.join(alias,'common'),cwd:path.join(alias,'lane'),run:'R-9',changed:true}));
  assert.throws(verify,/changed/,'the ordinary reader resolves this receipt to the actual target, so the seal must include it');
});

test('an ignored receipt symlink is sealed without following it', t => {
  const f = fixture(t), link = path.join(f.occupants, 'ignored.json');
  fs.symlinkSync(f.external, link);
  const verify = sealRemovalInputs([f.retirement], { inertLinkParents: [f.occupants] });
  verify(); fs.writeFileSync(f.external, 'still not authority'); verify();
  assert.equal(fs.readlinkSync(link), f.external);
  fs.unlinkSync(link); fs.writeFileSync(link, '{}');
  assert.throws(verify, /removal preflight input changed/);
});

for (const change of ['retarget', 'add', 'remove', 'edit-receipt']) test(`receipt inventory ${change} invalidates its removal seal`, t => {
  const f = fixture(t), link = path.join(f.occupants, 'ignored.json'), receipt = path.join(f.occupants, 'real.json');
  fs.symlinkSync(f.external, link); fs.writeFileSync(receipt, '{}');
  const verify = sealRemovalInputs([f.retirement], { inertLinkParents: [f.occupants] });
  if (change === 'retarget') { fs.unlinkSync(link); fs.symlinkSync('different.json', link); }
  if (change === 'add') fs.writeFileSync(path.join(f.occupants, 'new.json'), '{}');
  if (change === 'remove') fs.unlinkSync(link);
  if (change === 'edit-receipt') fs.writeFileSync(receipt, '{"changed":true}');
  assert.throws(verify, /removal preflight input changed/);
});

test('an inert receipt allowance cannot authorize a root or nested authority redirect', t => {
  const f = fixture(t), link = path.join(f.occupants, 'ignored.json'); fs.symlinkSync(f.external, link);
  assert.throws(() => sealRemovalInputs([link], { inertLinkParents: [f.occupants] }), /redirected removal input/);
  assert.throws(() => sealRemovalInputs([f.retirement]), /redirected removal input/);
  fs.unlinkSync(link); const nested = path.join(f.occupants, 'nested'); fs.mkdirSync(nested);
  fs.symlinkSync(f.external, path.join(nested, 'redirect.json'));
  assert.throws(() => sealRemovalInputs([f.retirement], { inertLinkParents: [f.occupants] }), /redirected removal input/);
  fs.rmSync(nested, { recursive: true }); fs.rmdirSync(f.occupants);
  fs.symlinkSync(f.root, f.occupants, 'dir');
  assert.throws(() => sealRemovalInputs([f.retirement], { inertLinkParents: [f.occupants] }), /redirected removal input/);
});

test('housekeeping authority seal allows healthy unrelated log state and directory activity without owner probes',t=>{
  const f=fixture(t),root=path.join(f.root,'housekeeping'),job=path.join(root,'default'),lock=path.join(job,'lock');fs.mkdirSync(lock,{recursive:true});
  const owner=path.join(lock,'owner.json'),bytes=JSON.stringify({pid:40001,cwd:'/fixture/project',retirement_queue_protocol:2});fs.writeFileSync(owner,bytes);const verify=sealHousekeepingOwners(root);
  fs.writeFileSync(path.join(job,'state.json'),'new pass');fs.writeFileSync(path.join(job,'activity.jsonl'),'unrelated event\n');fs.appendFileSync(path.join(job,'activity.jsonl'),'heartbeat\n');fs.mkdirSync(path.join(root,'unlocked-history'));verify();assert.equal(fs.readFileSync(owner,'utf8'),bytes);
});

test('housekeeping authority seal retains owner replacement new owner unknown lock and redirected authority fences',t=>{
  for(const kind of ['replace','add','unknown','redirect']){
    const f=fixture(t),root=path.join(f.root,'housekeeping'),job=path.join(root,'default'),lock=path.join(job,'lock');fs.mkdirSync(lock,{recursive:true});const owner=path.join(lock,'owner.json');fs.writeFileSync(owner,'{"pid":40001}');const verify=sealHousekeepingOwners(root);
    if(kind==='replace')fs.writeFileSync(owner,'{"pid":40002}');
    if(kind==='add'){const next=path.join(root,'next/lock');fs.mkdirSync(next,{recursive:true});fs.writeFileSync(path.join(next,'owner.json'),'{"pid":40003}');}
    if(kind==='unknown')fs.unlinkSync(owner);
    if(kind==='redirect'){fs.renameSync(lock,lock+'-old');fs.symlinkSync(lock+'-old',lock,'dir');}
    assert.throws(verify,/ownership changed|unknown|redirected/);
  }
});
