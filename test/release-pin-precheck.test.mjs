import test from './helpers/bounded-test.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import cp from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { pathToFileURL } from 'node:url';
import { fixtureFleet } from './helpers/offline-herdr.mjs';
import { copyProduct } from '../lib/product-files.mjs';

const source = path.resolve(import.meta.dirname, '..');
function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pin-precheck-')));
  fixtureFleet(t, root);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
  for (const key of Object.keys(env)) if (key.startsWith('GIT_') && !['GIT_CONFIG_GLOBAL', 'GIT_CONFIG_NOSYSTEM'].includes(key)) delete env[key];
  const git = (repo, ...args) => cp.execFileSync('git', ['-C', repo, ...args], { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const project = name => {
    const repo = path.join(root, name); fs.mkdirSync(repo);
    git(repo, 'init', '-qb', 'main'); git(repo, 'config', 'user.name', 'Fixture'); git(repo, 'config', 'user.email', 'fixture@example.invalid');
    fs.writeFileSync(path.join(repo, 'work'), 'base\n'); git(repo, 'add', '.'); git(repo, 'commit', '-qm', 'initial');
    return repo;
  };
  const bundle = path.join(project('runtime'), '.git/promote/batches/fixture/scratch-0');
  copyProduct(source, bundle);
  fs.writeFileSync(path.join(bundle, 'package.json'), '{"type":"module"}');
  return { root, git, project, module: () => import(pathToFileURL(path.join(bundle, 'lib/releases.mjs'))), bundle };
}
function measured(fn) {
  const originals = new Map(), calls = [];
  for (const name of ['execFileSync', 'spawnSync', 'spawn', 'execSync', 'execFile', 'exec']) {
    const original = cp[name]; originals.set(name, original);
    cp[name] = function(command, ...args) {
      calls.push({ api: name, command });
      return original.call(this, command, ...args);
    };
  }
  syncBuiltinESMExports();
  try { return { value: fn(), calls }; }
  finally { for (const [name, original] of originals) cp[name] = original; syncBuiltinESMExports(); }
}

test('no-pin source admission spawns no processes from canonical, linked, nested and aliased paths', async t => {
  const f = fixture(t), repo = f.project('target'), lane = path.join(f.root, 'lane');
  f.git(repo, 'worktree', 'add', '-qb', 'lane/hostile', lane);
  fs.writeFileSync(path.join(lane, '.herdr-release.json'), '{"release":"foreign"}');
  f.git(lane, 'add', '.'); f.git(lane, 'commit', '-qm', 'lane cannot adopt a pin');
  const nested = path.join(repo, 'nested'), alias = path.join(f.root, 'alias'); fs.mkdirSync(nested); fs.symlinkSync(lane, alias);
  const other = f.project('other'); fs.writeFileSync(path.join(other, '.herdr-release.json'), '{"release":"other"}');
  f.git(other, 'add', '.'); f.git(other, 'commit', '-qm', 'other pin');
  const prior = Object.fromEntries(['GIT_DIR', 'GIT_COMMON_DIR', 'GIT_WORK_TREE'].map(key => [key, process.env[key]]));
  Object.assign(process.env, { GIT_DIR: path.join(other, '.git'), GIT_COMMON_DIR: path.join(other, '.git'), GIT_WORK_TREE: other });
  const { projectPin, forwardRelease, bundleRelease } = await f.module();
  try {
    for (const cwd of [repo, nested, lane, alias, f.root]) {
      const result = measured(() => { const pin = projectPin(cwd); assert.equal(pin?.release ?? null, null); return forwardRelease('bin/org.mjs', cwd); });
      assert.equal(result.value, null); assert.deepEqual(result.calls, [], cwd);
    }
    assert.deepEqual(bundleRelease(), { root: f.bundle, id: null, commit: null, protocol: 1 });
  } finally {
    for (const [key, value] of Object.entries(prior)) if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
});

test('canonical pins deleted from the worktree or index fail closed, including packed HEAD objects', async t => {
  const f = fixture(t), repo = f.project('target'), lane = path.join(f.root, 'lane');
  f.git(repo, 'worktree', 'add', '-qb', 'lane/test', lane);
  const { projectPin } = await f.module(), file = path.join(repo, '.herdr-release.json');
  fs.writeFileSync(file, '{"release":"blue"}'); f.git(repo, 'add', '.'); f.git(repo, 'commit', '-qm', 'adopt blue');
  assert.equal(projectPin(lane).release, 'blue');
  const drift = /committed but missing from the canonical working tree/;
  fs.unlinkSync(file);
  for (const cwd of [repo, lane]) {
    const result = measured(() => assert.throws(() => projectPin(cwd), drift));
    assert.deepEqual(result.calls, []);
  }
  f.git(repo, 'add', '-u');
  assert.throws(() => projectPin(lane), drift, 'staging deletion cannot hide HEAD\'s pin');
  f.git(repo, 'restore', '--source=HEAD', '--staged', '--worktree', '.herdr-release.json');
  f.git(repo, 'gc', '--prune=now'); fs.unlinkSync(file);
  const packed = measured(() => assert.throws(() => projectPin(lane), drift));
  assert.ok(packed.calls.some(call => call.command === 'git'), 'unreadable loose proof requires Git verification');
  f.git(repo, 'add', '-u'); f.git(repo, 'commit', '-qm', 'accept configuration removal');
  assert.equal(projectPin(lane).release, null, 'only a canonical commit accepts removal');
});

test('zero-process absence proof follows packed refs and loose alternates and refreshes HEAD each admission', async t => {
  const f = fixture(t), repo = f.project('target'), clone = path.join(f.root, 'clone');
  f.git(repo, 'pack-refs', '--all');
  const { projectPin } = await f.module();
  assert.deepEqual(measured(() => projectPin(repo)).calls, []);
  f.git(f.root, 'clone', '--shared', repo, clone);
  assert.deepEqual(measured(() => projectPin(clone)).calls, []);
  fs.writeFileSync(path.join(repo, '.herdr-release.json'), '{"release":"blue"}');
  f.git(repo, 'add', '.'); f.git(repo, 'commit', '-qm', 'late adoption');
  assert.equal(projectPin(repo).release, 'blue');
  fs.unlinkSync(path.join(repo, '.herdr-release.json')); f.git(repo, 'add', '-u'); f.git(repo, 'commit', '-qm', 'accepted removal');
  const after = measured(() => projectPin(repo)); assert.equal(after.value.release, null); assert.deepEqual(after.calls, []);
});

test('uncertain metadata and separate Git directories retain verified selection instead of an absence guess', async t => {
  const f = fixture(t), repo = f.project('target');
  const { projectPin } = await f.module();
  fs.writeFileSync(path.join(repo, '.git/config.worktree'), '[core]\n');
  const unknown = measured(() => projectPin(repo)); assert.equal(unknown.value.release, null); assert.ok(unknown.calls.length);
  fs.unlinkSync(path.join(repo, '.git/config.worktree'));
  const separate = path.join(f.root, 'separate.git'); f.git(repo, 'init', '--separate-git-dir', separate);
  const fallback = measured(() => projectPin(repo)); assert.equal(fallback.value.project.identity, separate); assert.ok(fallback.calls.length);
});
