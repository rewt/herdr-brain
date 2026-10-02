import test from '../../test/helpers/bounded-test.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fixture } from './fixture.mjs';

const setup = (t) => fixture(t, { actor: 'settle-rebase-review-test' });
const result = (r) => { assert.equal(r.status, 0, r.stderr); return JSON.parse(r.stdout); };
const commit = (f, cwd, subject) => {
  f.git(['add', '-A', '--', '.', ':(exclude).org', ':(exclude).lane'], cwd);
  f.git(['commit', '-qm', subject], cwd);
};
const advance = (f) => { fs.writeFileSync(path.join(f.repo, 'upstream.txt'), 'upstream\n'); commit(f, f.repo, 'Advance main'); };
const receipt = (f, run) => JSON.parse(fs.readFileSync(path.join(f.org, 'settle', `${run}.json`), 'utf8'));

for (const { defaults, driver } of [
  { defaults: false, driver: 'keep-current' }, { defaults: true, driver: 'keep-current' }, { defaults: false, driver: 'text' },
  { defaults: false, driver: 'set' }, { defaults: false, driver: 'unspecified' },
  { defaults: true, driver: ' keep-current' },
]) test(`content-discarding ${defaults ? 'merge.default' : `path merge=${driver}`} driver cannot establish preservation`, (t) => {
  const f = setup(t);
  if (!defaults) {
    fs.writeFileSync(path.join(f.repo, '.gitattributes'), `work.txt merge=${driver}\n`);
    commit(f, f.repo, 'Configure merge attribute'); f.git(['rebase', 'main'], f.workspace);
  } else f.git(['config', 'merge.default', driver]);
  f.git(['config', `merge.${driver}.driver`, 'true']);
  const run = f.start(); f.commit('correct\n'); f.report(run);
  const reviewed = f.git(['rev-parse', 'HEAD'], f.workspace);
  fs.writeFileSync(path.join(f.repo, 'work.txt'), 'upstream conflict\n'); commit(f, f.repo, 'Diverge upstream');
  // Witness the successful driver discarding the reviewed edit in the oracle.
  const merged = f.git(['merge-tree', '--write-tree', 'main', reviewed], f.workspace);
  assert.equal(f.git(['show', `${merged}:work.txt`]), 'upstream conflict');
  const r = result(f.settle(run));
  assert.equal(r.result, 'escalate'); assert.match(r.reason, /Custom merge drivers.*work.txt/);
  assert.ok(r.rebase.custom_merge_paths.includes('work.txt'));
  assert.equal(r.rebase.scratch, undefined, 'refusal precedes replay');
  assert.equal(f.git(['rev-parse', 'HEAD^'], f.workspace), reviewed);
  assert.equal(fs.readFileSync(path.join(f.workspace, 'work.txt'), 'utf8'), 'correct\n');
  assert.equal(f.git(['status', '--porcelain'], f.workspace), '');
});

test('custom attributes in an intermediate reviewed commit also refuse replay', (t) => {
  const f = setup(t), run = f.start(); f.commit('correct\n');
  f.git(['config', 'merge.keep-current.driver', 'true']);
  fs.writeFileSync(path.join(f.workspace, '.gitattributes'), 'work.txt merge=keep-current\n');
  commit(f, f.workspace, 'Add intermediate merge attributes');
  fs.unlinkSync(path.join(f.workspace, '.gitattributes')); commit(f, f.workspace, 'Remove merge attributes'); f.report(run);
  advance(f);
  const r = result(f.settle(run));
  assert.equal(r.result, 'escalate'); assert.ok(r.rebase.custom_merge_paths.includes('work.txt'));
  assert.equal(fs.readFileSync(path.join(f.workspace, 'work.txt'), 'utf8'), 'correct\n');
});

test('directory-rename split conflicts report informational paths without unmerged files', (t) => {
  const f = setup(t);
  fs.mkdirSync(path.join(f.repo, 'old'));
  fs.writeFileSync(path.join(f.repo, 'old/a.txt'), 'a\n'); fs.writeFileSync(path.join(f.repo, 'old/b.txt'), 'b\n');
  const lines = Array.from({ length: 20 }, (_, i) => `line ${i}`);
  fs.writeFileSync(path.join(f.repo, 'shared.txt'), lines.join('\n') + '\n');
  commit(f, f.repo, 'Create directory'); f.git(['rebase', 'main'], f.workspace);
  const run = f.start(); f.commit('correct\n');
  const laneLines = [...lines]; laneLines[0] = 'reviewed shared change';
  fs.writeFileSync(path.join(f.workspace, 'shared.txt'), laneLines.join('\n') + '\n');
  fs.writeFileSync(path.join(f.workspace, 'old/added.txt'), 'reviewed addition\n'); commit(f, f.workspace, 'Add in old directory'); f.report(run);
  const reviewed = f.git(['rev-parse', 'HEAD'], f.workspace);
  fs.mkdirSync(path.join(f.repo, 'one')); fs.mkdirSync(path.join(f.repo, 'two'));
  const upstreamLines = [...lines]; upstreamLines[19] = 'upstream shared change';
  fs.writeFileSync(path.join(f.repo, 'shared.txt'), upstreamLines.join('\n') + '\n');
  f.git(['mv', 'old/a.txt', 'one/a.txt']); f.git(['mv', 'old/b.txt', 'two/b.txt']); commit(f, f.repo, 'Split directory rename');
  const preflight = f.exec('git', ['merge-tree', '--write-tree', '--name-only', '-z', 'main', reviewed], f.workspace);
  assert.equal(preflight.status, 1); assert.equal(preflight.stdout.split('\0')[1], '', 'no unmerged-file section');
  assert.match(preflight.stdout, /CONFLICT\(directory rename unclear split\)/);
  assert.match(preflight.stdout, /Auto-merging/);
  const r = result(f.settle(run));
  assert.equal(r.result, 'escalate'); assert.deepEqual(r.rebase.conflicts, ['old']); assert.match(r.reason, /conflicts in: old/);
  assert.match(fs.readFileSync(r.handoff, 'utf8'), /conflicts in: old/);
  assert.equal(f.git(['rev-parse', 'HEAD^'], f.workspace), reviewed);
  assert.equal(fs.readFileSync(path.join(f.workspace, 'old/added.txt'), 'utf8'), 'reviewed addition\n');
  assert.equal(f.git(['status', '--porcelain'], f.workspace), '');
});

for (const action of ['commit', 'switch']) test(`a concurrent ${action} during the final record read remains intact`, (t) => {
  const f = setup(t), run = f.start(); f.commit('correct\n'); f.report(run); advance(f);
  const adapter = path.join(f.root, 'record-race.mjs'), marker = path.join(f.root, 'race.json');
  fs.writeFileSync(adapter, `#!/usr/bin/env node
import fs from 'node:fs';import {spawnSync,execFileSync} from 'node:child_process';
const args=process.argv.slice(2),file=${JSON.stringify(path.join(f.org, 'settle', `${run}.json`))};
if(args[0]==='status'&&fs.existsSync(file)&&!fs.existsSync(${JSON.stringify(marker)})) {
 const job=JSON.parse(fs.readFileSync(file));
 if(job.rebase?.state==='prepared') {
  const git=(args)=>execFileSync('git',args,{cwd:job.workspace,encoding:'utf8'}).trim();
  ${action === 'commit' ? `fs.writeFileSync(job.workspace+'/concurrent.txt','concurrent committed work\\n');git(['add','concurrent.txt']);git(['commit','-qm','Concurrent lane work']);` : `git(['switch','-c','lane/concurrent']);`}
  fs.writeFileSync(${JSON.stringify(marker)},JSON.stringify({from:job.rebase.from,head:git(['rev-parse','HEAD'])}));
 }
}
const r=spawnSync(process.execPath,[process.env.SETTLE_TEST_RECORD,...args],{stdio:'inherit'});process.exit(r.status??1);
`, { mode: 0o755 });
  const r = f.settle(run, ['--org-cli', adapter]);
  assert.equal(r.status, 1); assert.match(r.stderr, /lane HEAD or branch moved/);
  const race = JSON.parse(fs.readFileSync(marker));
  assert.equal(f.git(['rev-parse', 'HEAD'], f.workspace), race.head);
  assert.equal(f.git(['rev-parse', 'lane/topic']), action === 'commit' ? race.head : race.from);
  assert.equal(f.git(['branch', '--show-current'], f.workspace), action === 'commit' ? 'lane/topic' : 'lane/concurrent');
  if (action === 'commit') assert.equal(fs.readFileSync(path.join(f.workspace, 'concurrent.txt'), 'utf8'), 'concurrent committed work\n');
  assert.equal(fs.existsSync(path.join(f.workspace, 'upstream.txt')), false, 'no prepared tree checked out');
  assert.equal(f.git(['status', '--porcelain'], f.workspace), '');
  assert.equal(receipt(f, run).rebase.state, 'prepared');
});

test('HEAD and index locks exclude native commits and branch switches during the ref transaction', (t) => {
  const f = setup(t), run = f.start(); f.commit('correct\n'); f.report(run); advance(f);
  const realGit = f.exec('which', ['git']).stdout.trim(), marker = path.join(f.root, 'locked-races.json');
  const script = path.join(f.root, 'locked-git.mjs');
  Object.assign(f.env, { SETTLE_TEST_GIT: realGit, SETTLE_TEST_LOCK_SCRIPT: script, SETTLE_TEST_NODE: process.execPath });
  // Start Node only for the injected transaction. Pass-through native Git calls
  // do not need an extra runtime and remain inside the existing command bound.
  fs.writeFileSync(path.join(f.root, 'bin/git'), `#!/bin/sh
if [ "$1" = update-ref ]; then
  exec "$SETTLE_TEST_NODE" "$SETTLE_TEST_LOCK_SCRIPT" "$@"
fi
exec "$SETTLE_TEST_GIT" "$@"
`, { mode: 0o755 });
  fs.writeFileSync(script, `#!/usr/bin/env node
import fs from 'node:fs';import {spawnSync} from 'node:child_process';
const args=process.argv.slice(2);
if(args[0]==='update-ref'&&args.includes('--stdin')) {
 const commit=spawnSync(${JSON.stringify(realGit)},['commit','--allow-empty','-qm','Concurrent commit'],{cwd:${JSON.stringify(f.workspace)},encoding:'utf8'});
 const branch=spawnSync(${JSON.stringify(realGit)},['switch','-c','lane/concurrent'],{cwd:${JSON.stringify(f.workspace)},encoding:'utf8'});
 fs.writeFileSync(${JSON.stringify(marker)},JSON.stringify({commit:commit.status,branch:branch.status,errors:commit.stderr+branch.stderr}));
}
const r=spawnSync(${JSON.stringify(realGit)},args,{stdio:'inherit'});process.exit(r.status??1);
`, { mode: 0o755 });
  assert.equal(result(f.settle(run)).result, 'promotable');
  const races = JSON.parse(fs.readFileSync(marker));
  assert.notEqual(races.commit, 0); assert.notEqual(races.branch, 0); assert.match(races.errors, /index.lock|HEAD.lock/);
  assert.equal(f.git(['branch', '--show-current'], f.workspace), 'lane/topic');
  assert.equal(f.git(['status', '--porcelain'], f.workspace), '');
});

test('the named-ref compare-and-swap refuses a commit after the locked identity check', (t) => {
  const f = setup(t), run = f.start(); f.commit('correct\n'); f.report(run); advance(f);
  const realGit = f.exec('which', ['git']).stdout.trim(), marker = path.join(f.root, 'cas-race');
  fs.writeFileSync(path.join(f.root, 'bin/git'), `#!/usr/bin/env node
import fs from 'node:fs';import {spawnSync,execFileSync} from 'node:child_process';
const args=process.argv.slice(2),git=(args,input)=>execFileSync(${JSON.stringify(realGit)},args,{cwd:${JSON.stringify(f.workspace)},encoding:'utf8',input}).trim();
if(args[0]==='update-ref'&&args.includes('--stdin')) {
 const from=git(['rev-parse','HEAD']),tree=git(['rev-parse','HEAD^{tree}']);
 const to=git(['commit-tree',tree,'-p',from],'Concurrent committed work\\n');
 execFileSync(${JSON.stringify(realGit)},['update-ref','refs/heads/lane/topic',to,from],{cwd:${JSON.stringify(f.repo)}});fs.writeFileSync(${JSON.stringify(marker)},to);
}
const r=spawnSync(${JSON.stringify(realGit)},args,{stdio:'inherit'});process.exit(r.status??1);
`, { mode: 0o755 });
  const r = f.settle(run); assert.equal(r.status, 1); assert.match(r.stderr, /cannot lock ref.*expected/);
  assert.equal(f.git(['rev-parse', 'HEAD'], f.workspace), fs.readFileSync(marker, 'utf8'));
  assert.equal(fs.existsSync(path.join(f.workspace, 'upstream.txt')), false);
  assert.equal(f.git(['status', '--porcelain'], f.workspace), '');
});
