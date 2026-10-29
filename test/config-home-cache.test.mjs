import test from './helpers/bounded-test.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { configFixture } from './helpers/config-home-fixture.mjs';
import { homeBindings, homeProject, readConfigJSON } from '../lib/config-home.mjs';
import { transact, withLock } from '../lib/store.mjs';
import {captureReads} from '../lib/record-observation.mjs';

function countRecordReads(record, action) {
  const open = fs.openSync, read = fs.readFileSync; let reads = 0;
  fs.openSync = function(file, ...args) {
    if (typeof file === 'string' && path.resolve(file) === path.join(record, 'events.jsonl')) reads++;
    return open.call(this, file, ...args);
  };
  fs.readFileSync = function(file, ...args) {
    if (typeof file === 'string' && path.resolve(file) === path.join(record, 'events.jsonl')) reads++;
    return read.call(this, file, ...args);
  };
  try { action(); return reads; } finally { fs.openSync = open; fs.readFileSync = read; }
}

test('config verification cache reuses stable physical evidence and never exports mutable authority', async t => {
  const f = configFixture(t); await f.adopt(); const binding = f.binding();
  const reads = countRecordReads(binding.record, () => {
    for (let i = 0; i < 3; i++) {
      const found = homeProject(f.cwd, f.env); assert.equal(found.common, binding.common);
      found.adoption.scope_sha256 = '0'.repeat(64);
    }
  });
  assert.equal(reads, 0, 'stable verification must not parse the selected project record again');
  assert.equal(f.binding().adoption.scope_sha256, binding.adoption.scope_sha256);
});

test('adopted binding projections ignore unrelated canonical index/config writes and retain the actual home link',async t=>{
  const f=configFixture(t);await f.adopt();
  const observed=captureReads(()=>homeProject(f.cwd,f.env));
  const git=(...args)=>execFileSync('git',['-C',f.cwd,...args],{env:f.env,encoding:'utf8'});
  git('config','color.ui','false');git('update-index','--index-version','4');
  assert.doesNotThrow(observed.validate);
  fs.unlinkSync(path.join(f.cwd,'.brain'));fs.symlinkSync(f.scratch,path.join(f.cwd,'.brain'));
  assert.throws(observed.validate,/conflicting home link|observation conflict/);
});

test('sealed adopted binding inputs tolerate planning churn and refuse a late home link change without reads under lock',async t=>{
  const f=configFixture(t);await f.adopt();
  const observation=captureReads(()=>homeProject(f.cwd,f.env));
  execFileSync('git',['-C',f.cwd,'config','color.ui','false'],{env:f.env});
  execFileSync('git',['-C',f.cwd,'update-index','--index-version','4'],{env:f.env});
  const validate=observation.seal(),read=fs.readFileSync;
  fs.readFileSync=function(file,...args){
    assert.equal(fs.existsSync(path.join(observation.value.record,'lock')),false,'commit validation only stats sealed inputs');
    return read.call(this,file,...args);
  };
  try{
    withLock(observation.value.record,validate);
    fs.unlinkSync(path.join(f.cwd,'.brain'));fs.symlinkSync(f.scratch,path.join(f.cwd,'.brain'));
    assert.throws(()=>withLock(observation.value.record,validate),/record.*observation conflict/);
  }finally{fs.readFileSync=read;}
});

test('config verification cache invalidates on record replacement, same-size writes, scope and link changes', async t => {
  const f = configFixture(t); await f.adopt(); const binding = f.binding();
  const file = path.join(binding.record, 'events.jsonl'), bytes = fs.readFileSync(file), stat = fs.statSync(file);
  const replacement = file + '.replacement'; fs.writeFileSync(replacement, bytes); fs.utimesSync(replacement, stat.atime, stat.mtime); fs.renameSync(replacement, file);
  assert.ok(countRecordReads(binding.record, () => f.binding()) > 0, 'new inode must reverify');
  const changed = bytes.toString().replace('"answer":"yes"', '"answer":"no "');
  assert.equal(Buffer.byteLength(changed), bytes.length); assert.notEqual(changed, bytes.toString());
  fs.writeFileSync(file, changed); fs.utimesSync(file, stat.atime, stat.mtime);
  assert.throws(() => f.binding(), /human record answer/);
  fs.writeFileSync(file, bytes); f.binding();
  const scope = fs.readFileSync(binding.adoption.scope_file);
  fs.writeFileSync(binding.adoption.scope_file, scope.toString().replace('"identity":', '"changed_identity":'));
  assert.throws(() => f.binding(), /provenance/); fs.writeFileSync(binding.adoption.scope_file, scope); f.binding();
  fs.unlinkSync(path.join(f.cwd, '.brain')); fs.symlinkSync(f.scratch, path.join(f.cwd, '.brain'));
  assert.throws(() => f.binding(), /conflicting home link/);
});

for (const change of ['authorization append', 'target replacement', 'same-size rewrite', 'incomplete tail']) {
  test(`config verification cache invalidates a symlinked external log after ${change}`, async t => {
    const f = configFixture(t); await f.adopt(); const binding = f.binding();
    const file = path.join(binding.record, 'events.jsonl');
    const external = path.join(f.scratch, 'external'); fs.mkdirSync(external);
    const target = path.join(external, 'events.jsonl');
    fs.renameSync(file, target); fs.symlinkSync(target, file);
    assert.ok(countRecordReads(binding.record, () => f.binding()) > 0, 'warm verification must follow the external log');
    assert.equal(countRecordReads(binding.record, () => f.binding()), 0, 'stable symlink target may reuse verification');
    const link = fs.lstatSync(file, { bigint: true }), stat = fs.statSync(target), bytes = fs.readFileSync(target);
    let error = /human record answer/;
    if (change === 'authorization append') {
      transact(binding.record, () => ({ add: [{ type: 'item.updated', id: f.decision.id, fields: { meta: { answer: 'no' } } }] }), { actor: 'human' });
    } else if (change === 'target replacement') {
      // Keep the pathname, length and mtime; the new inode has no adoption completion.
      const changed = bytes.toString().replace('"type":"config.adopted"', '"type":"config.changed"');
      assert.notEqual(changed, bytes.toString()); assert.equal(Buffer.byteLength(changed), bytes.length);
      fs.writeFileSync(target + '.replacement', changed);
      fs.utimesSync(target + '.replacement', stat.atime, stat.mtime);
      fs.renameSync(target + '.replacement', target);
      assert.notEqual(fs.statSync(target).ino, stat.ino);
      error = /adoption completion record changed/;
    } else if (change === 'same-size rewrite') {
      const changed = bytes.toString().replace('"answer":"yes"', '"answer":"no "');
      assert.notEqual(changed, bytes.toString()); assert.equal(Buffer.byteLength(changed), bytes.length);
      fs.writeFileSync(target, changed); fs.utimesSync(target, stat.atime, stat.mtime);
      assert.equal(fs.statSync(target).ino, stat.ino);
    } else {
      fs.appendFileSync(target, '{"type":'); error = /incomplete tail/;
    }
    const after = fs.lstatSync(file, { bigint: true });
    for (const key of ['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs']) assert.equal(after[key], link[key], `link ${key} stays unchanged`);
    assert.equal(fs.realpathSync(file), target, 'resolved pathname stays unchanged');
    assert.ok(countRecordReads(binding.record, () => assert.throws(() => f.binding(), error)) > 0, 'changed target must be read and refused');
  });
}

test('config verification selects only claimed projects while selected damage and overlapping record claims still hold', async t => {
  const f = configFixture(t); await f.adopt(); const binding = f.binding(), raw = readConfigJSON(binding.file);
  const directory = path.join(path.dirname(binding.directory), 'foreign'); fs.mkdirSync(directory);
  const foreign = { ...raw, project: 'foreign', common: path.join(f.scratch, 'foreign.git'),
    checkout: path.join(f.scratch, 'foreign'), record: path.join(f.scratch, 'foreign-record'),
    adoption: { ...raw.adoption, authorization: { ...raw.adoption.authorization, record: path.join(f.scratch, 'foreign-record') } } };
  fs.writeFileSync(path.join(directory, 'project.json'), JSON.stringify(foreign));
  assert.equal(homeProject(f.cwd, f.env).common, binding.common, 'unrelated missing foreign source/record is never verified');
  assert.throws(() => homeBindings(f.env), /canonical checkout unavailable/, 'unscoped inspection still verifies all bindings');
  fs.writeFileSync(binding.file, JSON.stringify({ ...raw, adoption: { ...raw.adoption, scope_sha256: '0'.repeat(64) } }));
  assert.throws(() => f.binding(), /provenance/); fs.writeFileSync(binding.file, JSON.stringify(raw));
  fs.writeFileSync(path.join(directory, 'project.json'), JSON.stringify({ ...foreign, record: binding.record,
    adoption: { ...foreign.adoption, authorization: { ...foreign.adoption.authorization, record: binding.record } } }));
  assert.throws(() => f.binding(), /canonical checkout unavailable/, 'a foreign claimant of the selected record cannot be skipped');
});

test('config verification leaves unrelated identity audits untouched and still holds damaged selected identity', async t => {
  const f = configFixture(t); await f.adopt(); const binding = f.binding();
  const checkout = path.join(f.ownerRoot, 'unadopted'); fs.mkdirSync(checkout);
  execFileSync('git', ['-C', checkout, 'init', '-qb', 'main'], { env: f.env, stdio: 'ignore' });
  const selected = { common: path.join(checkout, '.git'), checkout };
  const identityRecord = path.join(path.dirname(binding.identityFile), '.org');
  assert.equal(countRecordReads(identityRecord, () => assert.equal(homeBindings(f.env, selected).bindings.length, 0)), 0);
  fs.writeFileSync(binding.identityFile, JSON.stringify({ ...binding.defaults, identity_root: 'relative' }));
  assert.throws(() => f.binding(), /identity_root must be a canonical absolute directory/);
});
