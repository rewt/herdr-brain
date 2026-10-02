import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { makeSnapshotWritable } from '../snapshot.mjs';
import { commandFailure, classifyFailure } from '../limits.mjs';
import { cases, cutoverChecks, runCase } from '../cases.mjs';
import { resultLine } from '../results.mjs';

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

test('immutable release copy supports console build and contrib retirement without changing source', (t) => {
  const root = fixture(t), source = path.join(root, 'release'), scratch = path.join(root, 'scratch');
  fs.mkdirSync(scratch); fs.mkdirSync(path.join(source, 'console'), { recursive: true });
  fs.mkdirSync(path.join(source, 'contrib'));
  const compat = 'contrib/settle-watch.mjs';
  fs.writeFileSync(path.join(source, compat), '#!/usr/bin/env node\n');
  fs.writeFileSync(path.join(source, 'console/package.json'), '{}');
  fs.chmodSync(path.join(source, compat), 0o555);
  fs.chmodSync(path.join(source, 'console/package.json'), 0o444);
  for (const file of ['console', 'contrib', '']) fs.chmodSync(path.join(source, file), 0o555);
  const before = ['console', 'contrib', '', compat, 'console/package.json'].map((file) => fs.statSync(path.join(source, file)).mode);
  const candidate = path.join(scratch, 'candidate');
  fs.cpSync(source, candidate, { recursive: true, dereference: true });
  assert.equal(fs.statSync(path.join(candidate, 'console')).mode & 0o777, 0o555);
  makeSnapshotWritable(candidate, scratch);
  fs.mkdirSync(path.join(candidate, 'console/node_modules'));
  fs.writeFileSync(path.join(candidate, 'console/package.json'), '{"scratch":true}');
  const saved = fs.readFileSync(path.join(candidate, compat));
  fs.unlinkSync(path.join(candidate, compat)); fs.writeFileSync(path.join(candidate, compat), saved);
  assert.equal(fs.statSync(path.join(candidate, 'console')).mode & 0o777, 0o755);
  assert.equal(fs.statSync(path.join(candidate, 'console/package.json')).mode & 0o777, 0o644);
  assert.deepEqual(['console', 'contrib', '', compat, 'console/package.json'].map((file) => fs.statSync(path.join(source, file)).mode), before);
  assert.equal(fs.readFileSync(path.join(source, 'console/package.json'), 'utf8'), '{}');
  assert.deepEqual(fs.readFileSync(path.join(source, compat)), saved);
  assert.ok(!fs.existsSync(path.join(source, 'console/node_modules')));
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
  await runCase(results, cases.switches, () => { throw error; }, { scratchRoot: scratch });
  await runCase(results, cases.retirement, () => assert.fail('dependent body ran'), { scratchRoot: scratch });
  for (const result of results) {
    assert.equal(result.status, 'PENDING'); assert.equal(result.origin, 'harness');
    assert.match(resultLine(result), /HARNESS/);
  }
  const npm = `npm error code EACCES\nnpm error path ${scratch}/candidate/console/node_modules\nnpm error EACCES: permission denied, mkdir '${scratch}/candidate/console/node_modules'`;
  assert.equal(classifyFailure(commandFailure(npm, { scratchRoot: scratch })).origin, 'harness');
  const checks = [];
  await runCase(checks, cutoverChecks.canary, () => { throw commandFailure(npm); }, { scratchRoot: scratch });
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
