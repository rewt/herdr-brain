import test from '../../test/helpers/bounded-test.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fixture } from './fixture.mjs';

const setup = (t) => fixture(t, { actor: 'settle-rebase-paths-test' });
function adapter(f, realGit, commands, source) {
  const script = path.join(f.root, 'git-adapter.mjs');
  fs.writeFileSync(script, source);
  Object.assign(f.env, { SETTLE_TEST_GIT: realGit, SETTLE_TEST_GIT_ADAPTER: script, SETTLE_TEST_NODE: process.execPath });
  fs.writeFileSync(path.join(f.root, 'bin/git'), `#!/bin/sh
case "$1" in
  ${commands.join('|')}) exec "$SETTLE_TEST_NODE" "$SETTLE_TEST_GIT_ADAPTER" "$@";;
  *) exec "$SETTLE_TEST_GIT" "$@";;
esac
`, { mode: 0o755 });
}
const result = (r) => { assert.equal(r.status, 0, r.stderr); return JSON.parse(r.stdout); };
const commitFile = (f, cwd, file, content) => {
  fs.writeFileSync(path.join(cwd, file), content);
  f.git(['add', '--', file], cwd); f.git(['commit', '-qm', 'Change fixture file'], cwd);
};
const advance = (f) => commitFile(f, f.repo, 'upstream.txt', 'upstream\n');

for (const file of [' leading.txt', ' \t\nréviewed.txt', '\uFEFFleading.txt']) test(`leading whitespace custom driver is refused for ${JSON.stringify(file)}`, (t) => {
  const f = setup(t);
  commitFile(f, f.repo, file, 'base\n');
  commitFile(f, f.repo, '.gitattributes', `${JSON.stringify(file)} merge=keep-current\n`);
  f.git(['config', 'merge.keep-current.driver', 'true']); f.git(['rebase', 'main'], f.workspace);
  const run = f.start(); f.commit('correct\n'); commitFile(f, f.workspace, file, 'reviewed edit\n'); f.report(run);
  const reviewed = f.git(['rev-parse', 'HEAD'], f.workspace);
  commitFile(f, f.repo, file, 'upstream edit\n');
  const tree = f.git(['merge-tree', '--write-tree', 'main', reviewed], f.workspace);
  assert.equal(f.git(['show', `${tree}:${file}`]), 'upstream edit', 'successful driver loses the reviewed edit');
  const r = result(f.settle(run));
  assert.equal(r.result, 'escalate'); assert.ok(r.rebase.custom_merge_paths.includes(file));
  assert.equal(r.rebase.scratch, undefined);
  assert.equal(f.git(['rev-parse', 'HEAD^'], f.workspace), reviewed);
  assert.equal(fs.readFileSync(path.join(f.workspace, file), 'utf8'), 'reviewed edit\n');
  assert.equal(f.git(['status', '--porcelain'], f.workspace), '');
});

test('valid UTF-8 whitespace paths survive a clean automatic rebase', (t) => {
  const f = setup(t), run = f.start(), file = ' \t\n\uFEFFréviewed.txt'; f.commit('correct\n');
  commitFile(f, f.workspace, file, 'reviewed bytes\n'); f.report(run); advance(f);
  const r = result(f.settle(run)); assert.equal(r.result, 'promotable');
  assert.equal(fs.readFileSync(path.join(f.workspace, file), 'utf8'), 'reviewed bytes\n');
  assert.equal(f.git(['merge-base', 'main', r.head]), f.git(['rev-parse', 'main']));
  assert.equal(f.git(['status', '--porcelain'], f.workspace), '');
});

test('intermediate replay conflicts retain the complete whitespace filename', (t) => {
  const f = setup(t), file = ' \tconflict.txt';
  commitFile(f, f.repo, file, 'base\n'); f.git(['rebase', 'main'], f.workspace);
  const run = f.start(); f.commit('correct\n');
  commitFile(f, f.workspace, file, 'temporary reviewed change\n');
  commitFile(f, f.workspace, file, 'base\n'); f.report(run);
  const reviewed = f.git(['rev-parse', 'HEAD'], f.workspace);
  commitFile(f, f.repo, file, 'upstream change\n');
  const r = result(f.settle(run)); assert.equal(r.result, 'escalate');
  assert.deepEqual(r.rebase.conflicts, [file]); assert.match(r.reason, /Rebase replay/);
  assert.equal(f.git(['rev-parse', 'HEAD^'], f.workspace), reviewed);
  assert.equal(fs.readFileSync(path.join(f.workspace, file), 'utf8'), 'base\n');
  assert.equal(f.git(['status', '--porcelain'], f.workspace), '');
});

test('a non-round-trippable raw Git path refuses before attribute lookup or lane replacement', (t) => {
  const f = setup(t), run = f.start(); f.commit('correct\n'); f.report(run); advance(f);
  const reviewed = f.git(['rev-parse', 'HEAD'], f.workspace), realGit = f.exec('which', ['git']).stdout.trim();
  const marker = path.join(f.root, 'attribute-lookup');
  adapter(f, realGit, ['diff', 'check-attr'], `#!/usr/bin/env node
import fs from 'node:fs';import {spawnSync} from 'node:child_process';
const args=process.argv.slice(2);
if(args[0]==='diff'&&args.includes('--name-only')&&args.includes('-z')) {process.stdout.write(Buffer.from([0xff,0]));process.exit(0);}
if(args[0]==='check-attr') fs.writeFileSync(${JSON.stringify(marker)},'unexpected lookup');
const r=spawnSync(${JSON.stringify(realGit)},args,{stdio:'inherit'});process.exit(r.status??1);
`);
  const r = f.settle(run); assert.equal(r.status, 1); assert.match(r.stderr, /cannot round-trip.*UTF-8/i);
  assert.equal(fs.existsSync(marker), false);
  assert.equal(f.git(['rev-parse', 'HEAD^'], f.workspace), reviewed);
  assert.equal(fs.readFileSync(path.join(f.workspace, 'work.txt'), 'utf8'), 'correct\n');
  assert.equal(f.git(['status', '--porcelain'], f.workspace), '');
});

function olderAttributeCLI(f, version) {
  const realGit = f.exec('which', ['git']).stdout.trim(), log = path.join(f.root, 'historical-indices.jsonl');
  const index = f.git(['rev-parse', '--path-format=absolute', '--git-path', 'index'], f.workspace);
  adapter(f, realGit, ['--version', 'check-attr', 'read-tree'], `#!/usr/bin/env node
import fs from 'node:fs';import {spawnSync} from 'node:child_process';
const args=process.argv.slice(2),index=${JSON.stringify(index)};
if(args[0]==='--version') {console.log('git version ${version}');process.exit(0);}
if(args[0]==='check-attr'&&args.some(a=>a==='--source'||a.startsWith('--source='))) {console.error('unknown option: source');process.exit(129);}
const historical=args[0]==='read-tree'&&process.env.GIT_INDEX_FILE;
const before=historical?fs.readFileSync(index):null;
if(args[0]==='check-attr'&&args.includes('--cached')) {
 if(!process.env.GIT_INDEX_FILE||!fs.existsSync(process.env.GIT_INDEX_FILE)||process.env.GIT_INDEX_FILE===index) {console.error('historical attributes need an owned temporary index');process.exit(1);}
 fs.appendFileSync(${JSON.stringify(log)},JSON.stringify({index:process.env.GIT_INDEX_FILE,cached:true})+'\\n');
}
const r=spawnSync(${JSON.stringify(realGit)},args,{stdio:'inherit'});
if(historical&&!before.equals(fs.readFileSync(index))) {console.error('historical read-tree changed the real lane index');process.exit(1);}
process.exit(r.status??1);
`);
  return () => fs.readFileSync(log, 'utf8').trim().split('\n').map(JSON.parse);
}

for (const version of ['2.38.0', '2.39.0']) {
  test(`Git ${version} attribute capabilities allow clean rebase to promotable`, (t) => {
    const f = setup(t), run = f.start(); f.commit('correct\n'); f.report(run); advance(f);
    const inspections = olderAttributeCLI(f, version);
    const r = result(f.settle(run)); assert.equal(r.result, 'promotable');
    assert.equal(fs.readFileSync(path.join(f.workspace, 'work.txt'), 'utf8'), 'correct\n');
    assert.equal(f.git(['merge-base', 'main', r.head]), f.git(['rev-parse', 'main']));
    const rows = inspections(); assert.ok(rows.length >= 3);
    for (const row of rows) assert.equal(fs.existsSync(path.dirname(row.index)), false, 'owned attribute scratch was removed');
  });
  test(`Git ${version} attribute capabilities still catch intermediate custom drivers`, (t) => {
    const f = setup(t), run = f.start(); f.commit('correct\n');
    f.git(['config', 'merge.keep-current.driver', 'true']);
    commitFile(f, f.workspace, '.gitattributes', 'work.txt merge=keep-current\n');
    f.git(['rm', '.gitattributes'], f.workspace); f.git(['commit', '-qm', 'Remove intermediate attributes'], f.workspace);
    f.report(run); advance(f);
    const reviewed = f.git(['rev-parse', 'HEAD'], f.workspace), inspections = olderAttributeCLI(f, version);
    const r = result(f.settle(run)); assert.equal(r.result, 'escalate'); assert.ok(r.rebase.custom_merge_paths.includes('work.txt'));
    assert.equal(f.git(['rev-parse', 'HEAD^'], f.workspace), reviewed);
    assert.equal(fs.readFileSync(path.join(f.workspace, 'work.txt'), 'utf8'), 'correct\n');
    for (const row of inspections()) assert.equal(fs.existsSync(path.dirname(row.index)), false);
  });
}
