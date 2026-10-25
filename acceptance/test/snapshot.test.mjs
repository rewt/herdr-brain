import test from '../../test/helpers/bounded-test.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { makeSnapshotWritable } from '../snapshot.mjs';
import { commandFailure, classifyFailure } from '../limits.mjs';
import { cases, runCase } from '../cases.mjs';
import { resultLine } from '../results.mjs';
import { createOwnedTempRoot } from '../temp.mjs';
import { snapshotCandidate } from '../run.mjs';
import { captureProductCheckout, verifyProductCheckoutIsolation, checkoutGit, copyProduct } from '../../lib/product-files.mjs';

function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'acceptance-snapshot-')));
  t.after(() => {
    for (const entry of fs.readdirSync(root)) {
      const file = path.join(root, entry);
      if (fs.lstatSync(file).isDirectory()) makeSnapshotWritable(file, root);
    }
    fs.rmSync(root, { recursive: true, force: true });
  });
  return root;
}

function sourceFixture(t) {
  const root = fixture(t), source = path.join(root, 'source'); fs.mkdirSync(source);
  checkoutGit(source, ['init', '-qb', 'main']);
  checkoutGit(source, ['config', 'user.name', 'Snapshot']); checkoutGit(source, ['config', 'user.email', 'snapshot@example.invalid']);
  fs.mkdirSync(path.join(source, 'lib')); fs.writeFileSync(path.join(source, 'lib/probe.mjs'), 'export const value=1;\n');
  checkoutGit(source, ['add', '.']); checkoutGit(source, ['commit', '-qm', 'Committed source']); checkoutGit(source, ['tag', 'snapshot']);
  return { root, source, commit: checkoutGit(source, ['rev-parse', 'HEAD']) };
}
test('actual source and ref snapshot dispatcher creates isolated genuine detached checkouts of C', t => {
  const f = sourceFixture(t), original = fs.readFileSync(path.join(f.source, 'lib/probe.mjs'));
  for (const [index, input] of [f.source, 'snapshot'].entries()) {
    const destination = path.join(f.root, `candidate-${index}`);
    const result = snapshotCandidate({ input, source: f.source, destination, ownedRoot: f.root });
    const identity = captureProductCheckout(destination, f.commit, { all: true });
    assert.deepEqual(result, { kind: 'checkout', commit: f.commit });
    assert.equal(identity.common, path.join(destination, '.git')); assert.notEqual(identity.common, path.join(f.source, '.git'));
    assert.equal(checkoutGit(destination, ['branch', '--show-current']), '');
    assert.equal(fs.existsSync(path.join(destination, '.git/objects/info/alternates')), false);
    for (const file of ['lib/probe.mjs', '.git/config']) {
      const copied = fs.statSync(path.join(destination, file)), source = fs.statSync(path.join(f.source, file));
      assert.equal(copied.nlink, 1); assert.notEqual(copied.ino, source.ino);
    }
    fs.writeFileSync(path.join(destination, 'lib/probe.mjs'), 'isolated mutation');
    checkoutGit(destination, ['update-ref', 'refs/heads/owned', f.commit]);
    assert.equal(checkoutGit(f.source, ['branch', '--list', 'owned']), '');
    assert.deepEqual(fs.readFileSync(path.join(f.source, 'lib/probe.mjs')), original);
  }
  assert.throws(() => snapshotCandidate({ input: f.source, destination: path.join(path.dirname(f.root), 'foreign'), ownedRoot: f.root }), /owned scratch/);
});
test('generic canonical, linked and shared source proofs retain their own common identity', t => {
  const f = sourceFixture(t), linked = path.join(f.root, 'linked'), shared = path.join(f.root, 'shared');
  checkoutGit(f.source, ['worktree', 'add', '--detach', linked, f.commit]);
  checkoutGit(f.source, ['clone', '--quiet', '--shared', f.source, shared]);
  assert.equal(captureProductCheckout(f.source).common, path.join(f.source, '.git'));
  assert.equal(captureProductCheckout(linked).common, path.join(f.source, '.git'));
  assert.equal(captureProductCheckout(shared).common, path.join(shared, '.git'));
  assert.ok(fs.existsSync(path.join(shared, '.git/objects/info/alternates')));
});
test('constructed clone isolation is rechecked before its source root can retire', t => {
  const f = sourceFixture(t), destination = path.join(f.root, 'candidate');
  snapshotCandidate({ input: f.source, destination, ownedRoot: f.root });
  const identity = captureProductCheckout(destination, f.commit, { all: true }); verifyProductCheckoutIsolation(identity);
  fs.writeFileSync(path.join(destination, '.git/objects/info/alternates'), path.join(f.source, '.git/objects') + '\n');
  assert.throws(() => verifyProductCheckoutIsolation(identity), /not private/);
  assert.equal(fs.readFileSync(path.join(f.source, 'lib/probe.mjs'), 'utf8'), 'export const value=1;\n');
});
for (const fault of ['stripped nested copy', 'dirty', 'hidden index', 'untracked runtime', 'redirected runtime', 'broken sealed marker', 'clean filtered bytes']) test(`actual snapshot dispatcher refuses ${fault}`, t => {
  const f = sourceFixture(t); let input = f.source;
  const file = path.join(f.source, 'lib/probe.mjs');
  if (fault === 'stripped nested copy') { input = path.join(f.source, 'renamed'); copyProduct(f.source, input); }
  if (fault === 'dirty') fs.appendFileSync(file, '// dirty');
  if (fault === 'hidden index') checkoutGit(f.source, ['update-index', '--assume-unchanged', 'lib/probe.mjs']);
  if (fault === 'untracked runtime') fs.writeFileSync(path.join(f.source, 'lib/extra.mjs'), 'extra');
  if (fault === 'redirected runtime') { fs.renameSync(file, path.join(f.root, 'outside')); fs.symlinkSync(path.join(f.root, 'outside'), file); }
  if (fault === 'broken sealed marker') fs.symlinkSync(path.join(f.root, 'absent'), path.join(f.source, '.release-manifest.json'));
  if (fault === 'clean filtered bytes') {
    fs.writeFileSync(path.join(f.source, '.gitattributes'), 'lib/probe.mjs text eol=crlf\n');
    checkoutGit(f.source, ['add', '.gitattributes']);
    // Establish conversion in the index before constructing a Git-clean
    // worktree whose raw bytes still differ from the committed LF blob.
    checkoutGit(f.source, ['add', '--renormalize', 'lib/probe.mjs']);
    checkoutGit(f.source, ['commit', '-qm', 'Clean conversion']);
    fs.writeFileSync(file, 'export const value=1;\r\n');
    assert.equal(checkoutGit(f.source, ['status', '--porcelain', '--untracked-files=no']), '');
  }
  const destination = path.join(f.root, 'candidate');
  assert.throws(() => snapshotCandidate({ input, destination, ownedRoot: f.root }));
  assert.equal(fs.existsSync(destination), false, 'refusal precedes candidate execution');
});
test('completed sealed directory input stays sealed and isolated; corrupt payload cannot become source', t => {
  const root = fixture(t), product = path.resolve(import.meta.dirname, '../..'), source = path.join(root, 'sealed');
  copyProduct(product, source); const commit = checkoutGit(product, ['rev-parse', 'HEAD']);
  fs.writeFileSync(path.join(source, '.release-commit'), commit + '\n');
  const manifest = spawnSync(process.execPath, [path.join(product, 'herdr/releases.mjs'), 'manifest', source], { encoding: 'utf8' });
  assert.equal(manifest.status, 0, manifest.stdout + manifest.stderr);
  const destination = path.join(root, 'candidate');
  assert.deepEqual(snapshotCandidate({ input: source, destination, ownedRoot: root }), { kind: 'release', commit });
  assert.equal(fs.existsSync(path.join(destination, '.git')), false);
  assert.equal(fs.readFileSync(path.join(destination, '.release-commit'), 'utf8'), commit + '\n');
  fs.appendFileSync(path.join(source, 'lib/state.mjs'), '\n// corrupt');
  assert.throws(() => snapshotCandidate({ input: source, destination: path.join(root, 'refused'), ownedRoot: root }), /incomplete release/);
});

test('immutable release copy supports a scratch dependency build and contrib retirement without changing source', (t) => {
  const root = fixture(t), source = path.join(root, 'release'), scratch = path.join(root, 'scratch');
  fs.mkdirSync(scratch); fs.mkdirSync(path.join(source, 'app'), { recursive: true });
  fs.mkdirSync(path.join(source, 'contrib'));
  const compat = 'contrib/settle-watch.mjs';
  fs.writeFileSync(path.join(source, compat), '#!/usr/bin/env node\n');
  fs.writeFileSync(path.join(source, 'app/package.json'), '{}');
  fs.chmodSync(path.join(source, compat), 0o555);
  fs.chmodSync(path.join(source, 'app/package.json'), 0o444);
  for (const file of ['app', 'contrib', '']) fs.chmodSync(path.join(source, file), 0o555);
  const before = ['app', 'contrib', '', compat, 'app/package.json'].map((file) => fs.statSync(path.join(source, file)).mode);
  const candidate = path.join(scratch, 'candidate');
  fs.cpSync(source, candidate, { recursive: true, dereference: true });
  assert.equal(fs.statSync(path.join(candidate, 'app')).mode & 0o777, 0o555);
  makeSnapshotWritable(candidate, scratch);
  fs.mkdirSync(path.join(candidate, 'app/node_modules'));
  fs.writeFileSync(path.join(candidate, 'app/package.json'), '{"scratch":true}');
  const saved = fs.readFileSync(path.join(candidate, compat));
  fs.unlinkSync(path.join(candidate, compat)); fs.writeFileSync(path.join(candidate, compat), saved);
  assert.equal(fs.statSync(path.join(candidate, 'app')).mode & 0o777, 0o755);
  assert.equal(fs.statSync(path.join(candidate, 'app/package.json')).mode & 0o777, 0o644);
  assert.deepEqual(['app', 'contrib', '', compat, 'app/package.json'].map((file) => fs.statSync(path.join(source, file)).mode), before);
  assert.equal(fs.readFileSync(path.join(source, 'app/package.json'), 'utf8'), '{}');
  assert.deepEqual(fs.readFileSync(path.join(source, compat)), saved);
  assert.ok(!fs.existsSync(path.join(source, 'app/node_modules')));
  assert.throws(() => makeSnapshotWritable(source, scratch), /inside scratch/);
  assert.throws(() => makeSnapshotWritable(scratch, scratch), /inside scratch/);
});

test('Git archive executable bits survive and snapshot chmod never follows symlinks', (t) => {
  const root = fixture(t), repo = path.join(root, 'repo'), scratch = path.join(root, 'scratch');
  fs.mkdirSync(repo); fs.mkdirSync(scratch);
  const git = (...args) => {
    const r = spawnSync('git', ['-C', repo, ...args], { env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } });
    assert.equal(r.status, 0, String(r.stderr)); return r.stdout;
  };
  git('init', '-q'); fs.writeFileSync(path.join(repo, 'entry'), '#!/bin/sh\n', { mode: 0o755 });
  git('add', '.'); git('-c', 'user.name=Acceptance', '-c', 'user.email=acceptance@example.invalid', 'commit', '-qm', 'Fixture');
  const candidate = path.join(scratch, 'candidate'); fs.mkdirSync(candidate);
  const extracted = spawnSync('tar', ['-x', '-C', candidate], { input: git('archive', 'HEAD') });
  assert.equal(extracted.status, 0, String(extracted.stderr));
  const external = path.join(root, 'external'); fs.writeFileSync(external, 'untouched', { mode: 0o444 });
  fs.symlinkSync(external, path.join(candidate, 'link'));
  fs.symlinkSync(path.join(candidate, 'entry'), path.join(candidate, 'internal'));
  makeSnapshotWritable(candidate, scratch);
  assert.equal(fs.statSync(path.join(candidate, 'entry')).mode & 0o777, 0o755);
  assert.equal(fs.statSync(external).mode & 0o777, 0o444);
  assert.equal(fs.readlinkSync(path.join(candidate, 'link')), external);
  assert.equal(fs.readlinkSync(path.join(candidate, 'internal')), path.join(candidate, 'entry'));
});

test('actual scratch permission failures and npm stderr become HARNESS through case and prerequisite handling', async (t) => {
  const root = fixture(t), scratch = path.join(root, 'scratch'); fs.mkdirSync(scratch);
  const file = path.join(scratch, 'compat'); fs.writeFileSync(file, 'immutable', { mode: 0o444 });
  let error;
  try { fs.writeFileSync(file, 'retire'); } catch (caught) { error = caught; }
  assert.equal(error?.code, 'EACCES', 'fixture must run as an unprivileged user');
  const results = [];
  await runCase(results, cases.snapshot, () => { throw error; }, { scratchRoot: scratch });
  await runCase(results, { ...cases.policy, prerequisites: [cases.snapshot.key] }, () => assert.fail('dependent body ran'), { scratchRoot: scratch });
  for (const result of results) {
    assert.equal(result.status, 'PENDING'); assert.equal(result.origin, 'harness');
    assert.match(resultLine(result), /HARNESS/);
  }
  const npm = `npm error code EACCES\nnpm error path ${scratch}/candidate/app/node_modules\nnpm error EACCES: permission denied, mkdir '${scratch}/candidate/app/node_modules'`;
  assert.equal(classifyFailure(commandFailure(npm, { scratchRoot: scratch })).origin, 'harness');
  const checks = [];
  await runCase(checks, cases.release, () => { throw commandFailure(npm); }, { scratchRoot: scratch });
  assert.equal(checks[0].origin, 'harness');
  for (const code of ['EROFS', 'ENOSPC', 'EDQUOT', 'EMFILE', 'ENFILE', 'EIO', 'EPERM']) {
    assert.equal(classifyFailure(Object.assign(Error(`${code}: '${file}'`), { code, path: file }), { scratchRoot: scratch }).origin, 'harness');
  }
});

test('scratch context preserves product refusals and excludes foreign, prefix, traversal and symlink paths', (t) => {
  const root = fixture(t), scratch = path.join(root, 'scratch'), foreign = path.join(root, 'foreign');
  fs.mkdirSync(scratch); fs.mkdirSync(foreign);
  fs.symlinkSync(foreign, path.join(scratch, 'escape'));
  for (const file of [path.join(foreign, 'file'), `${scratch}-other/file`, `${scratch}/../foreign/file`, `${scratch}/escape/file`]) {
    assert.equal(classifyFailure(commandFailure(`EACCES: '${file}'`, { scratchRoot: scratch })).status, 'FAIL');
  }
  for (const message of [`acceptance_product_boundary: EACCES: '${scratch}/file'`, `acceptance_boundary: EPERM: '${scratch}/file'`, 'candidate installer missing', 'EACCES without a path']) {
    assert.equal(classifyFailure(commandFailure(message, { scratchRoot: scratch }), { scratchRoot: scratch }).status, 'FAIL');
  }
});

test('foreign symlink followed by a parent segment stays FAIL for real EACCES and command EPERM', async (t) => {
  const root = fixture(t), scratch = path.join(root, 'scratch'), foreign = path.join(root, 'foreign');
  fs.mkdirSync(scratch); fs.mkdirSync(path.join(foreign, 'child'), { recursive: true });
  const denied = path.join(foreign, 'denied'); fs.writeFileSync(denied, 'foreign', { mode: 0o444 });
  fs.symlinkSync(path.join(foreign, 'child'), path.join(scratch, 'escape'));
  const file = `${scratch}/escape/../denied`;
  assert.equal(fs.realpathSync.native(file), denied, 'OS resolves the link before its parent segment');
  let error;
  try { fs.writeFileSync(file, 'bad'); } catch (caught) { error = caught; }
  assert.equal(error?.code, 'EACCES');
  const results = [];
  await runCase(results, cases.release, () => { throw error; }, { scratchRoots: [scratch] });
  assert.equal(results[0].status, 'FAIL'); assert.equal(results[0].origin, 'product');
  assert.equal(classifyFailure(commandFailure(`EPERM: open '${file}'`, { scratchRoots: [scratch] })).status, 'FAIL');
  assert.equal(fs.readFileSync(denied, 'utf8'), 'foreign');
});

test('unresolved links, missing roots, relative and mixed paths fail closed; real aliases qualify', (t) => {
  const root = fixture(t), scratch = path.join(root, 'scratch'), foreign = path.join(root, 'foreign');
  fs.mkdirSync(scratch); fs.mkdirSync(foreign);
  const alias = path.join(root, 'alias'); fs.symlinkSync(scratch, alias);
  fs.symlinkSync(path.join(foreign, 'missing'), path.join(scratch, 'dangling'));
  fs.symlinkSync(path.join(scratch, 'loop'), path.join(scratch, 'loop'));
  for (const file of [`${scratch}/dangling/file`, `${scratch}/loop/file`, `${scratch}/ordinary/../file`]) {
    assert.equal(classifyFailure(commandFailure(`EACCES: '${file}'`, { scratchRoots: [scratch] })).status, 'FAIL');
  }
  assert.equal(classifyFailure(Object.assign(Error('permission denied'), { code: 'EPERM', path: 'relative' }), { scratchRoots: [scratch] }).status, 'FAIL');
  assert.equal(classifyFailure(commandFailure(`EACCES: '${scratch}/missing'`, { scratchRoots: [path.join(root, 'unregistered')] })).status, 'FAIL');
  assert.equal(classifyFailure(commandFailure(`EACCES: '${scratch}/file' and '${foreign}/file'`, { scratchRoots: [scratch] })).status, 'FAIL');
  assert.equal(classifyFailure(Object.assign(Error('copy denied'), { code: 'EACCES', path: `${scratch}/file`, dest: `${foreign}/file` }), { scratchRoots: [scratch] }).status, 'FAIL');
  assert.equal(classifyFailure(commandFailure(`EACCES: '${alias}/missing/file'`, { scratchRoots: [scratch] })).origin, 'harness');
});
