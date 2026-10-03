import test from '../../test/helpers/bounded-test.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fixture } from './fixture.mjs';

const setup = (t) => fixture(t, { actor: 'settle-rebase-test' });
const result = (r) => { assert.equal(r.status, 0, r.stderr); return JSON.parse(r.stdout); };
const commitMain = (f, file, text) => {
  fs.writeFileSync(path.join(f.repo, file), text);
  f.git(['add', '--', file]); f.git(['commit', '-qm', 'Advance integration branch']);
};
const saved = (f, run) => JSON.parse(fs.readFileSync(path.join(f.org, 'settle', `${run}.json`), 'utf8'));

test('clean rebase preserves reviewed changes without running a suite', (t) => {
  const f = setup(t), run = f.start(); f.commit('correct\n'); f.report(run);
  const reviewed = f.git(['rev-parse', 'HEAD'], f.workspace);
  commitMain(f, 'main-only.txt', 'upstream work\n');
  const main = f.git(['rev-parse', 'main']);
  const checks = path.join(f.root, 'checks.jsonl'), checker = path.join(f.root, 'check.cjs');
  fs.writeFileSync(checker, `const fs=require('node:fs'),cp=require('node:child_process');
fs.appendFileSync(${JSON.stringify(checks)},JSON.stringify({head:cp.execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),upstream:fs.existsSync('main-only.txt')})+'\\n');
cp.execFileSync(process.execPath,['--test','test.mjs'],{stdio:'inherit'});\n`);
  f.env.LANE_VALIDATE = `node ${checker}`;
  const r = result(f.settle(run));
  assert.equal(r.result, 'promotable'); assert.equal(r.reviewed_commit, reviewed);
  assert.notEqual(r.head, reviewed);
  assert.equal(f.git(['merge-base', main, r.head]), main);
  assert.equal(fs.readFileSync(path.join(f.workspace, 'work.txt'), 'utf8'), 'correct\n');
  assert.equal(fs.readFileSync(path.join(f.workspace, 'main-only.txt'), 'utf8'), 'upstream work\n');
  assert.equal(f.git(['rev-parse', 'main']), main, 'settle does not promote');
  assert.equal(f.git(['status', '--porcelain'], f.workspace), '');
  assert.equal(fs.existsSync(checks), false, 'settle runs no suite');
  assert.equal(r.rebase.expected_tree, f.git(['rev-parse', `${r.head}^{tree}`]));
  assert.equal(fs.existsSync(r.rebase.scratch), false, 'owned scratch worktree was removed');
  const launches = f.calls().filter(a => a[1] === 'start').length;
  assert.deepEqual(result(f.settle(run)), r, 'saved readiness stays idempotent after rebase');
  assert.equal(f.calls().filter(a => a[1] === 'start').length, launches);
  assert.equal(saved(f, run).head, reviewed, 'review remains bound to its original source');
});

test('conflicting reviewed diff escalates with paths and leaves the lane intact', (t) => {
  const f = setup(t), run = f.start(); f.commit('correct\n'); f.report(run);
  const reviewed = f.git(['rev-parse', 'HEAD'], f.workspace);
  commitMain(f, 'work.txt', 'upstream conflict\n');
  const r = result(f.settle(run));
  assert.equal(r.result, 'escalate'); assert.match(r.reason, /conflict.*work.txt/);
  assert.match(fs.readFileSync(r.handoff, 'utf8'), /work.txt/);
  assert.equal(f.git(['rev-parse', 'HEAD^'], f.workspace), reviewed, 'only the review record was added');
  assert.equal(fs.readFileSync(path.join(f.workspace, 'work.txt'), 'utf8'), 'correct\n');
  assert.equal(f.git(['status', '--porcelain'], f.workspace), '');
  assert.equal(fs.existsSync(f.git(['rev-parse', '--git-path', 'rebase-merge'], f.workspace)), false);
});

test('intermediate replay conflicts escalate even when the final trees merge cleanly', (t) => {
  const f = setup(t);
  commitMain(f, 'intermediate.txt', 'base\n'); f.git(['rebase', 'main'], f.workspace);
  const run = f.start(); f.commit('correct\n');
  fs.writeFileSync(path.join(f.workspace, 'intermediate.txt'), 'temporary lane change\n');
  f.git(['add', '.'], f.workspace); f.git(['commit', '-qm', 'Change intermediate file'], f.workspace);
  fs.writeFileSync(path.join(f.workspace, 'intermediate.txt'), 'base\n');
  f.git(['add', '.'], f.workspace); f.git(['commit', '-qm', 'Restore intermediate file'], f.workspace); f.report(run);
  const reviewed = f.git(['rev-parse', 'HEAD'], f.workspace);
  commitMain(f, 'intermediate.txt', 'upstream change\n');
  const r = result(f.settle(run));
  assert.equal(r.result, 'escalate'); assert.match(r.reason, /replay.*conflict.*intermediate.txt/);
  assert.equal(f.git(['rev-parse', 'HEAD^'], f.workspace), reviewed);
  assert.equal(fs.readFileSync(path.join(f.workspace, 'intermediate.txt'), 'utf8'), 'base\n');
  assert.equal(f.git(['status', '--porcelain'], f.workspace), '');
  assert.equal(fs.existsSync(r.rebase.scratch), false);
});

test('a clean replay that loses reviewed content fails preservation before changing the lane', (t) => {
  const f = setup(t), run = f.start(); f.commit('correct\n'); f.report(run);
  const reviewed = f.git(['rev-parse', 'HEAD'], f.workspace);
  commitMain(f, 'main-only.txt', 'upstream work\n');
  const hooks = path.join(f.root, 'hooks'); fs.mkdirSync(hooks);
  fs.writeFileSync(path.join(hooks, 'post-rewrite'), `#!/bin/sh
printf 'lost reviewed content\\n' > work.txt
git -c core.hooksPath=/dev/null add work.txt
git -c core.hooksPath=/dev/null commit --amend --no-edit --quiet
`, { mode: 0o755 });
  f.git(['config', 'core.hooksPath', hooks]);
  const r = result(f.settle(run));
  assert.equal(r.result, 'escalate'); assert.match(r.reason, /preserve the reviewed diff/i);
  assert.equal(f.git(['rev-parse', 'HEAD^'], f.workspace), reviewed);
  assert.equal(fs.readFileSync(path.join(f.workspace, 'work.txt'), 'utf8'), 'correct\n');
  assert.equal(f.git(['status', '--porcelain'], f.workspace), '');
  assert.equal(fs.existsSync(r.rebase.scratch), false);
});

test('reviewed changes already present upstream survive an empty replay', (t) => {
  const f = setup(t), run = f.start(); f.commit('correct\n'); f.report(run);
  commitMain(f, 'work.txt', 'correct\n');
  const r = result(f.settle(run));
  assert.equal(r.result, 'promotable');
  assert.equal(fs.readFileSync(path.join(f.workspace, 'work.txt'), 'utf8'), 'correct\n');
  assert.equal(f.git(['merge-base', 'main', r.head]), f.git(['rev-parse', 'main']));
});

test('post-rebase suite failure belongs to promotion without a new worker', (t) => {
  const f = setup(t), run = f.start(); f.commit('correct\n'); f.report(run);
  commitMain(f, 'test.mjs', "import test from 'node:test';test('new integration failure',()=>{throw Error('red after rebase');});\n");
  const r = result(f.settle(run));
  assert.equal(r.result, 'promotable'); assert.equal(r.validation.executed, false);
  const promoted = f.exec(process.execPath, [path.join(f.source, 'lanes/lane.mjs'), 'promote', 'topic'], f.repo);
  assert.equal(promoted.status, 1); assert.match(promoted.stderr, /validation failed/);
  assert.match(promoted.stdout, /red after rebase/);
  assert.equal(f.git(['merge-base', 'main', r.head]), f.git(['rev-parse', 'main']));
  assert.equal(f.calls().filter(a => a[1] === 'start').length, 1, 'only the reviewer was launched');
});
