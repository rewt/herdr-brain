import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { occupancyProject, sharedOccupancy } from '../occupancy.mjs';
import { processStartRecord } from '../lock-support.mjs';
import { fixtureFleet } from '../../test/helpers/offline-herdr.mjs';

function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'occupancy-project-')));
  fixtureFleet(t, root);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}
function repository(root) {
  const common = path.join(root, '.git');
  fs.mkdirSync(path.join(common, 'objects'), { recursive: true });
  fs.writeFileSync(path.join(common, 'HEAD'), 'ref: refs/heads/main\n');
  return common;
}
function subprocesses(callback, execute = () => { throw Error('unexpected subprocess'); }) {
  const names = ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork'];
  const originals = Object.fromEntries(names.map(name => [name, childProcess[name]]));
  const calls = [];
  for (const name of names) childProcess[name] = (...args) => {
    calls.push({ name, file: args[0], args: args[1] });
    return execute(originals[name], args);
  };
  syncBuiltinESMExports();
  try { callback(calls); }
  finally { Object.assign(childProcess, originals); syncBuiltinESMExports(); }
}

test('occupancy project discovery starts no subprocess on cold or cached lookups', t => {
  const root = fixture(t), common = repository(root);
  subprocesses(calls => {
    assert.equal(occupancyProject(root), common);
    assert.equal(occupancyProject(root), common);
    assert.deepEqual(calls, []);
  });
});

test('shared occupancy writes add no subprocess beyond the existing owner-identity lookup', t => {
  const root = fixture(t), common = repository(root), before = process.cwd();
  let slot;
  process.chdir(root);
  try {
    subprocesses(calls => {
      try { processStartRecord(process.pid); } catch { /* Same nullable identity fallback as the writer. */ }
      const identityCalls = calls.splice(0);
      slot = sharedOccupancy(path.join(root, 'slot'), 'spawn-free project', { reason: 'unprofiled' });
      assert.deepEqual(calls.splice(0), identityCalls);
      assert.equal(JSON.parse(fs.readFileSync(slot.occupancyPath)).project, common);
      slot.setGroup(null, null);
      slot.release();
      assert.deepEqual(calls, []);
    }, (execute, args) => execute(...args));
  } finally { slot?.release(); process.chdir(before); }
});

test('occupancy project caches both identities and fallbacks independently per cwd', t => {
  const root = fixture(t), one = path.join(root, 'one'), two = path.join(root, 'two');
  const common = repository(one);
  fs.mkdirSync(two);
  fs.writeFileSync(path.join(two, '.git'), 'uncertain marker\n');
  assert.equal(occupancyProject(one), common);
  assert.equal(occupancyProject(two), 'two');
  fs.rmSync(path.join(one, '.git'), { recursive: true });
  fs.unlinkSync(path.join(two, '.git')); repository(two);
  assert.equal(occupancyProject(one), common);
  assert.equal(occupancyProject(two), 'two');
});

for (const absolute of [false, true]) test(`occupancy follows ${absolute ? 'absolute' : 'relative'} gitdir and commondir files`, t => {
  const root = fixture(t), common = repository(root), gitdir = path.join(common, 'worktrees/fixture');
  const cwd = path.join(root, 'checkout'), nested = path.join(cwd, 'nested');
  fs.mkdirSync(gitdir, { recursive: true }); fs.mkdirSync(nested, { recursive: true });
  fs.writeFileSync(path.join(gitdir, 'HEAD'), 'ref: refs/heads/topic\n');
  fs.writeFileSync(path.join(gitdir, 'commondir'), (absolute ? common : '../..') + '\n');
  fs.writeFileSync(path.join(cwd, '.git'), `gitdir: ${absolute ? gitdir : path.relative(cwd, gitdir)}\n`);
  assert.equal(occupancyProject(nested), common);
});

test('occupancy accepts a separate git directory without a commondir file', t => {
  const root = fixture(t), common = repository(path.join(root, 'owner')), cwd = path.join(root, 'checkout');
  fs.mkdirSync(cwd); fs.writeFileSync(path.join(cwd, '.git'), `gitdir: ${common}\n`);
  assert.equal(occupancyProject(cwd), common);
});

for (const problem of ['malformed marker', 'missing gitdir', 'malformed commondir', 'missing common', 'dangling marker', 'denied marker'])
  test(`occupancy falls back to the cwd basename on ${problem}`, t => {
    const root = fixture(t), common = repository(root), cwd = path.join(root, 'uncertain');
    fs.mkdirSync(cwd);
    const marker = path.join(cwd, '.git');
    if (problem === 'malformed marker' || problem === 'denied marker') fs.writeFileSync(marker, 'invalid marker\n');
    else if (problem === 'missing gitdir') fs.writeFileSync(marker, 'gitdir: missing\n');
    else if (problem === 'dangling marker') fs.symlinkSync(path.join(root, 'missing'), marker);
    else {
      const gitdir = path.join(root, 'worktree'); fs.mkdirSync(gitdir);
      fs.writeFileSync(marker, `gitdir: ${gitdir}\n`);
      fs.writeFileSync(path.join(gitdir, 'HEAD'), 'ref: refs/heads/topic\n');
      fs.writeFileSync(path.join(gitdir, 'commondir'), problem === 'malformed commondir' ? `${common}\nextra\n` : '../missing\n');
    }
    const read = fs.readFileSync;
    if (problem === 'denied marker') fs.readFileSync = (file, ...args) => {
      if (file === marker) throw Object.assign(Error('denied'), { code: 'EACCES' });
      return read(file, ...args);
    };
    try { assert.equal(occupancyProject(cwd), 'uncertain'); }
    finally { fs.readFileSync = read; }
  });
