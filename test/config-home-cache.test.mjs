import test from './helpers/bounded-test.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { configFixture } from './helpers/config-home-fixture.mjs';
import { homeBindings, homeProject, readConfigJSON } from '../lib/config-home.mjs';

function countRecordReads(record, action) {
  const open = fs.openSync; let reads = 0;
  fs.openSync = function(file, ...args) {
    if (typeof file === 'string' && path.resolve(file) === path.join(record, 'events.jsonl')) reads++;
    return open.call(this, file, ...args);
  };
  try { action(); return reads; } finally { fs.openSync = open; }
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
