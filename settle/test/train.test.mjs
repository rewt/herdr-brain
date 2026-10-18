import test from '../../test/helpers/bounded-test.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fixture } from './fixture.mjs';
import { enqueue, queueFor } from '../../promote/promote.mjs';
import { verifyTrainResult } from '../../promote/train.mjs';
import { gitProject } from '../../lib/project.mjs';
import { moveMainOnSave } from './auto-retry-fixture.mjs';

const receipt = (f, run) => JSON.parse(fs.readFileSync(path.join(f.org, 'settle', `${run}.json`)));
const result = r => { assert.equal(r.status, 0, r.stderr); return JSON.parse(r.stdout); };
const advance = f => {
  fs.writeFileSync(path.join(f.repo, 'upstream'), 'new main\n');
  f.git(['add', 'upstream']); f.git(['commit', '-qm', 'Advance main']);
};

test('settle only reviews code and never executes a configured suite', t => {
  const f = fixture(t), run = f.start(); f.commit('correct\n'); f.report(run);
  f.env.LANE_VALIDATE = 'exit 91';
  assert.equal(result(f.settle(run)).result, 'promotable');
  assert.equal(receipt(f, run).validation.executed, false);
  assert.match(fs.readFileSync(path.join(f.root, 'review-prompt'), 'utf8'), /promotion.*queue|batch.*promotion/i);
});

for (const repeated of [true, false]) test(repeated
  ? 'retry recaptures moving main and keeps a completed independent review'
  : 'one move at decide automatically recaptures main and keeps a completed independent review', t => {
  const f = fixture(t), run = f.start(); f.commit('correct\n'); f.report(run);
  const adapter = path.join(f.root, 'moving-record.mjs'), marker = path.join(f.root, 'moved');
  fs.writeFileSync(adapter, `#!${process.execPath}
import fs from 'node:fs'; import {spawnSync,execFileSync} from 'node:child_process';
const args=process.argv.slice(2), file=${JSON.stringify(path.join(f.org, 'settle', `${run}.json`))};
if(args[0]==='status'&&fs.existsSync(file)&&!fs.existsSync(${JSON.stringify(marker)})&&JSON.parse(fs.readFileSync(file)).stage==='decide') {
 fs.writeFileSync(${JSON.stringify(path.join(f.repo, 'upstream'))},'new main\\n');
 execFileSync('git',['add','upstream']);execFileSync('git',['commit','-qm','Move main during settle']);
 fs.writeFileSync(${JSON.stringify(marker)},'moved');
}
const r=spawnSync(process.execPath,[process.env.SETTLE_TEST_RECORD,...args],{stdio:'inherit'});process.exit(r.status??1);
`, { mode: 0o755 });
  if (repeated) moveMainOnSave(f, run, 'ready', { afterAutomaticRecapture: true });
  const first = f.settle(run, ['--org-cli', adapter]);
  assert.equal(first.status, repeated ? 1 : 0, first.stderr);
  if (repeated) assert.match(first.stderr, /base branch moved/);
  else assert.equal(JSON.parse(first.stdout).result, 'promotable');
  const before = receipt(f, run), reviews = f.calls().filter(a => a[1] === 'start').length;
  assert.equal(reviews, 1);
  assert.equal(before.automaticBaseRetry.stage, 'rebase');
  assert.equal(before.recaptures.length, 1);
  assert.equal(before.recaptures[0].onto, before.automaticBaseRetry.onto);
  assert.equal(before.recaptures[0].onto === f.git(['rev-parse', 'main']), !repeated);
  const resumed = result(f.retry(run)); assert.equal(resumed.result, 'promotable');
  assert.equal(receipt(f, run).review.sha256, before.review.sha256);
  assert.deepEqual(receipt(f, run).automaticBaseRetry, before.automaticBaseRetry);
  assert.equal(receipt(f, run).recaptures.length, repeated ? 2 : 1);
  assert.equal(f.calls().filter(a => a[1] === 'start').length, reviews);
  assert.equal(f.show(f.show(run).item).runs.length, 1);
  assert.equal(f.git(['merge-base', 'main', resumed.head]), f.git(['rev-parse', 'main']));
  assert.equal(fs.readFileSync(path.join(f.workspace, 'upstream'), 'utf8'), 'new main\n');
  if (repeated) assert.equal(fs.readFileSync(path.join(f.workspace, 'second-upstream.txt'), 'utf8'), 'upstream change\n');
});

test('retry refuses dirty or conflicting lanes while main moves', t => {
  for (const mode of ['dirty', 'conflict']) {
    const f = fixture(t), run = f.start(); f.commit('correct\n'); f.report(run);
    fs.writeFileSync(path.join(f.root, 'review-fail'), 'fail');
    assert.equal(f.settle(run).status, 1);
    fs.unlinkSync(path.join(f.root, 'review-fail'));
    const original = f.git(['rev-parse', 'HEAD'], f.workspace);
    if (mode === 'dirty') { advance(f); fs.writeFileSync(path.join(f.workspace, 'local'), 'keep me'); }
    else {
      fs.writeFileSync(path.join(f.repo, 'work.txt'), 'conflict\n');
      f.git(['add', 'work.txt']); f.git(['commit', '-qm', 'Conflict']);
    }
    const r = f.retry(run, ['--review-again']);
    assert.match(r.stdout + r.stderr, mode === 'dirty' ? /worktree changed/ : /conflict/);
    assert.equal(f.git(['rev-parse', 'HEAD'], f.workspace), original);
  }
});

test('review evidence retains inherited validation totals beyond eight KiB', t => {
  const f = fixture(t), run = f.start(); f.commit('correct\n'); f.report(run);
  const checker = path.join(f.root, 'long-log.cjs');
  fs.writeFileSync(checker, "console.log('detail\\n'.repeat(3000)+'# tests 100\\n# pass 100\\n# fail 0');");
  f.env.LANE_VALIDATE = `${process.execPath} ${checker}`;
  const check = f.exec(process.execPath, [path.join(f.source, 'lanes/lane.mjs'), 'check'], f.workspace);
  assert.equal(check.status, 0); assert.match(check.stdout, /# tests 100\n# pass 100\n# fail 0/);
  result(f.settle(run));
  const log = fs.readFileSync(receipt(f, run).validation.log, 'utf8');
  assert.ok(log.length > 8192); assert.match(log, /# tests 100\n# pass 100\n# fail 0/);
  assert.match(fs.readFileSync(path.join(f.root, 'review-prompt'), 'utf8'), new RegExp(receipt(f, run).validation.log.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
});

test('queued integration records report-to-main time on the authorized run', t => {
  const f = fixture(t), run = f.start(); f.commit('correct\n'); f.report(run);
  const settled = result(f.settle(run)), queue = queueFor(f.repo);
  advance(f); // The already reviewed/authorized lane is now behind main.
  enqueue(queue, ['topic'], { expectedHead: settled.head, run, org: f.org, to: 'test',
    herdr: path.join(f.root, 'bin/herdr'), laneCLI: path.join(f.source, 'lanes/lane.mjs'), attempts: 1, retry: 0 });
  const drained = f.exec(process.execPath, [path.join(f.source, 'promote/promote.mjs'), '--drain']);
  assert.equal(drained.status, 0, drained.stderr);
  const promoted = queue.load().results[0]; assert.equal(promoted.outcome, 'promoted', promoted.reason);
  assert.equal(promoted.report_at, f.show(run).report.at);
  assert.ok(promoted.report_to_main_s >= 0);
  assert.equal(promoted.report_to_main_s, (Date.parse(promoted.integrated_at) - Date.parse(promoted.report_at)) / 1000);
  assert.ok(f.show(run).notes.some(note => note.text.includes('report-to-main')));
  const saved = { head: settled.head, run, org: f.org, lane: 'topic' }, project = gitProject(f.repo);
  assert.notEqual(promoted.tip, settled.head);
  assert.equal(verifyTrainResult(promoted, { project, saved }), true);
  assert.equal(verifyTrainResult({ ...promoted, source_head: '0'.repeat(40) }, { project, saved }), false);
});

test('batch rechecks current-run record readiness after its gate', t => {
  const f = fixture(t), run = f.start(); f.commit('correct\n'); f.report(run);
  const settled = result(f.settle(run)), queue = queueFor(f.repo);
  const checker = path.join(f.root, 'supersede.cjs');
  fs.writeFileSync(checker, `require('child_process').execFileSync(process.execPath,[${JSON.stringify(path.join(f.source, 'bin/org.mjs'))},'start',${JSON.stringify(f.show(run).item)},'--workspace',${JSON.stringify(f.workspace)}],{env:{...process.env,ORG_DIR:${JSON.stringify(f.org)}}});`);
  enqueue(queue, ['topic'], { expectedHead: settled.head, run, org: f.org, to: 'test', validate: `${process.execPath} ${checker}`,
    herdr: path.join(f.root, 'bin/herdr'), laneCLI: path.join(f.source, 'lanes/lane.mjs'), attempts: 1, retry: 0 });
  const base = f.git(['rev-parse', 'main']);
  const drained = f.exec(process.execPath, [path.join(f.source, 'promote/promote.mjs'), '--drain']);
  assert.equal(drained.status, 0, drained.stderr);
  assert.equal(queue.load().results[0].outcome, 'refused'); assert.match(queue.load().results[0].reason, /superseded/);
  assert.equal(f.git(['rev-parse', 'main']), base); assert.ok(fs.existsSync(f.workspace));
});

test('main moving while the reviewer runs retains its completed public evidence for retry', t => {
  const f = fixture(t), run = f.start(); f.commit('correct\n'); f.report(run);
  const herdr = path.join(f.root, 'bin/herdr'), original = `${herdr}-original`;
  fs.renameSync(herdr, original);
  fs.writeFileSync(herdr, `#!${process.execPath}
import fs from 'node:fs';import {spawnSync,execFileSync} from 'node:child_process';
const args=process.argv.slice(2),r=spawnSync(${JSON.stringify(original)},args,{stdio:'inherit'});
if(r.status===0&&args[0]==='agent'&&args[1]==='prompt'&&args[3]?.includes('Private record file: ')){
 fs.writeFileSync(${JSON.stringify(path.join(f.repo, 'upstream'))},'new main\\n');
 execFileSync('git',['-C',${JSON.stringify(f.repo)},'add','upstream']);execFileSync('git',['-C',${JSON.stringify(f.repo)},'commit','-qm','Move main during review']);
}
process.exit(r.status??1);`, { mode: 0o755 });
  moveMainOnSave(f, run, 'ready', { afterAutomaticRecapture: true });
  assert.equal(f.settle(run).status, 1);
  const before = receipt(f, run); assert.equal(before.stage, 'ready'); assert.equal(before.review.verdict, 'PASS');
  assert.equal(before.automaticBaseRetry.stage, 'commit-review'); assert.equal(before.recaptures.length, 1);
  assert.notEqual(before.mainHead, f.git(['rev-parse', 'main']));
  const resumed = result(f.retry(run)); assert.equal(resumed.result, 'promotable');
  assert.equal(receipt(f, run).review.sha256, before.review.sha256);
  assert.deepEqual(receipt(f, run).automaticBaseRetry, before.automaticBaseRetry);
  assert.equal(receipt(f, run).recaptures.length, 2);
  assert.equal(f.calls().filter(a => a[1] === 'start').length, 1);
});

test('a batch holds one shared record lock for two authorized lanes', t => {
  const f = fixture(t), run = f.start(); f.commit('correct\n'); f.report(run);
  const settled = result(f.settle(run)), second = path.join(f.root, 'second');
  f.git(['worktree', 'add', '-qb', 'lane/second', second]);
  fs.writeFileSync(path.join(second, 'second'), 'second'); f.git(['add', '.'], second); f.git(['commit', '-qm', 'Second lane'], second);
  const item = f.record(['add', 'Second lane', '--role', 'engineer']).split(' ')[0];
  const other = f.record(['start', item, '--workspace', second, '--meta', 'lane=second']).match(/R-\d+/)[0];
  f.report(other); f.record(['ingest', f.show(other).report_path]);
  const queue = queueFor(f.repo), options = { org: f.org, to: 'test', herdr: path.join(f.root, 'bin/herdr'),
    laneCLI: path.join(f.source, 'lanes/lane.mjs'), attempts: 1, retry: 0 };
  enqueue(queue, ['topic'], { ...options, expectedHead: settled.head, run });
  enqueue(queue, ['second'], { ...options, expectedHead: f.git(['rev-parse', 'HEAD'], second), run: other });
  const drained = f.exec(process.execPath, [path.join(f.source, 'promote/promote.mjs'), '--drain']);
  assert.equal(drained.status, 0, drained.stderr);
  assert.deepEqual(queue.load().results.map(r => r.outcome), ['promoted', 'promoted']);
  const train = JSON.parse(fs.readFileSync(queue.load().results[0].receipt)); assert.equal(train.attempts.length, 1);
});
