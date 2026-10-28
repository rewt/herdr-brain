import test from '../../test/helpers/bounded-test.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fixture } from './fixture.mjs';

const result = r => { assert.equal(r.status, 0, r.stderr); return JSON.parse(r.stdout); };
const receiptPath = (f, run) => path.join(f.org, 'settle', `${run}.json`);
const receipt = (f, run) => JSON.parse(fs.readFileSync(receiptPath(f, run), 'utf8'));
const reviews = f => f.calls().filter(a => a[1] === 'prompt' && a[3]?.includes('Private record file: '));
const workers = f => f.calls().filter(a => a[1] === 'prompt' && a[3]?.startsWith('You are run '));
function legacy(f, run) {
  const saved = receipt(f, run);
  assert.equal(saved.stage, 'complete');
  delete saved.result.resume_stage;
  fs.writeFileSync(receiptPath(f, run), JSON.stringify(saved));
}
function advance(f) {
  fs.writeFileSync(path.join(f.repo, 'upstream'), 'later main\n');
  f.git(['add', 'upstream']); f.git(['commit', '-qm', 'Advance main']);
}
function overlap(f) {
  const older = f.start(), run = f.start(); f.commit('correct\n'); f.report(run);
  const refused = result(f.settle(run));
  assert.equal(refused.result, 'escalate'); assert.match(refused.reason, /Another run is open/);
  assert.ok(refused.reason.includes(older)); assert.equal(reviews(f).length, 0);
  return { older, run, refused };
}

for (const superseding of [false, true]) test(`legacy outcome-owner refusal rechecks the repaired fold${superseding ? ' and refuses a truly superseding run' : ' before reviewing'}`, t => {
  const f = fixture(t), { older, run } = overlap(f);
  f.report(older, 'needs_human');
  f.record(['ingest', f.show(older).report_path]);
  assert.equal(f.show(f.show(run).item).outcome, null);
  assert.equal(f.show(f.show(run).item).status, 'ready');
  // Before the ordering fix this late ingest displaced the correction, and a
  // retry saved this terminal refusal. Preserve its receipt shape for recovery.
  const saved = receipt(f, run);
  saved.result.reason = `The current outcome belongs to ${older}, not ${run}; the supervisor must settle that run`;
  delete saved.result.resume_stage;
  fs.writeFileSync(receiptPath(f, run), JSON.stringify(saved));
  advance(f);
  if (superseding) {
    const latest = f.start(); f.report(latest, 'needs_human');
    f.record(['ingest', f.show(latest).report_path]);
    const before = f.show(f.show(run).item);
    const refused = f.retry(run);
    assert.match(refused.status === 0 ? JSON.parse(refused.stdout).reason : refused.stderr, /superseded/);
    assert.deepEqual(f.show(before.id).outcome, before.outcome);
    assert.equal(reviews(f).length, 0);
  } else {
    const ready = result(f.retry(run));
    assert.equal(ready.result, 'promotable'); assert.equal(reviews(f).length, 1);
    assert.equal(receipt(f, run).mainHead, f.git(['rev-parse', 'main']));
    assert.deepEqual(result(f.retry(run)), ready);
    assert.equal(reviews(f).length, 1);
  }
  assert.equal(workers(f).length, 0);
});

for (const oldReceipt of [false, true]) test(`recovery: older overlapping run clears ${oldReceipt ? 'a legacy refusal after main moves' : 'a new refusal'}`, t => {
  const f = fixture(t), { older, run, refused } = overlap(f);
  if (oldReceipt) legacy(f, run);
  assert.equal(result(f.retry(run)).reason, refused.reason);
  assert.equal(reviews(f).length, 0, 'a still-open run cannot authorize review');
  f.record(['abandon', older]);
  if (oldReceipt) advance(f);
  const ready = result(f.retry(run)); assert.equal(ready.result, 'promotable');
  assert.equal(reviews(f).length, 1); assert.equal(workers(f).length, 0);
  assert.equal(receipt(f, run).mainHead, f.git(['rev-parse', 'main']));
  assert.equal(f.show(run).report.sha256, receipt(f, run).reportHash);
  assert.deepEqual(result(f.retry(run)), ready);
  assert.deepEqual(result(f.settle(run)), ready);
  assert.equal(reviews(f).length, 1, 'completed recovery never reviews twice');
  assert.equal(f.git(['rev-list', '--merges', `main..${ready.head}`]), '');
});

test('a fresh handle also rechecks an existing completed overlapping-run refusal', t => {
  const f = fixture(t), { older, run } = overlap(f); legacy(f, run);
  f.record(['abandon', older]);
  assert.equal(result(f.settle(run)).result, 'promotable');
  assert.equal(reviews(f).length, 1);
});

for (const oldReceipt of [false, true]) test(`record readiness recovery retains the completed review${oldReceipt ? ' from a legacy receipt' : ''}`, t => {
  const f = fixture(t), run = f.start(); f.commit('correct\n'); f.report(run);
  const item = f.show(run).item, blocker = f.record(['add', 'Resolve scope', '--role', 'architect']).split(' ')[0];
  fs.writeFileSync(path.join(f.root, 'review-record-action.json'), JSON.stringify(['block', item, '--by', blocker]));
  const refused = result(f.settle(run)); assert.equal(refused.result, 'escalate');
  assert.match(refused.reason, /record still has concurrent work or says blocked/);
  const reviewHash = receipt(f, run).review.sha256;
  if (oldReceipt) legacy(f, run);
  assert.equal(result(f.retry(run)).result, 'escalate'); assert.equal(reviews(f).length, 1);
  f.record(['close', blocker]); advance(f);
  const ready = result(f.retry(run)); assert.equal(ready.result, 'promotable');
  assert.equal(receipt(f, run).review.sha256, reviewHash);
  assert.equal(receipt(f, run).mainHead, f.git(['rev-parse', 'main']));
  assert.deepEqual(result(f.retry(run)), ready); assert.equal(reviews(f).length, 1);
});

test('a legacy correction refusal resumes the fix stage after blockers clear and main moves', t => {
  const f = fixture(t), run = f.start(); f.commit('wrong\n'); f.report(run);
  const item = f.show(run).item, blocker = f.record(['add', 'Resolve scope', '--role', 'architect']).split(' ')[0];
  fs.writeFileSync(path.join(f.root, 'review-record-action.json'), JSON.stringify(['block', item, '--by', blocker]));
  const refused = result(f.requestCorrection(run)); assert.equal(refused.result, 'escalate');
  assert.match(refused.reason, /Correction needs supervisor judgment/); legacy(f, run);
  assert.equal(result(f.retry(run)).result, 'escalate'); assert.equal(workers(f).length, 0);
  f.record(['close', blocker]); advance(f);
  const source = receipt(f, run).finalHead;
  const fixed = result(f.retry(run)); assert.equal(fixed.result, 'fix_round');
  assert.equal(JSON.parse(fs.readFileSync(fixed.fix.journal)).base, source);
  assert.equal(reviews(f).length, 1); assert.equal(workers(f).length, 1);
  assert.deepEqual(result(f.retry(run)), fixed); assert.equal(workers(f).length, 1);
});

test('a legacy dispatching refusal adopts only its existing correction after blockers clear', t => {
  const f = fixture(t), run = f.start(); f.commit('wrong\n'); f.report(run);
  const marker = path.join(f.root, 'watch-fail'), adapter = path.join(f.root, 'watch-adapter.mjs');
  fs.writeFileSync(marker, 'fail');
  fs.writeFileSync(adapter, `#!${process.execPath}
import fs from 'node:fs'; import { spawnSync } from 'node:child_process';
if(fs.existsSync(${JSON.stringify(marker)})){console.error('injected watcher startup failure');process.exit(1);}
const r=spawnSync(process.execPath,[${JSON.stringify(path.join(f.source, 'watch/watch.mjs'))},...process.argv.slice(2)],{stdio:'inherit'});process.exit(r.status??1);
`, { mode: 0o755 });
  const options = ['--watch-cli', adapter], first = f.requestCorrection(run, options);
  assert.equal(first.status, 1); assert.match(first.stderr, /injected watcher startup failure/);
  const item = f.show(run).item, correction = f.show(item).runs.at(-1);
  assert.notEqual(correction, run);
  const blocker = f.record(['add', 'Resolve scope', '--role', 'architect']).split(' ')[0];
  f.record(['block', item, '--by', blocker]);
  assert.equal(result(f.retry(run, options)).result, 'escalate'); legacy(f, run);
  f.record(['close', blocker]); fs.unlinkSync(marker); advance(f);
  const fixed = result(f.retry(run, options)); assert.equal(fixed.result, 'fix_round');
  assert.equal(fixed.fix.run, correction); assert.deepEqual(f.show(item).runs, [run, correction]);
  assert.equal(reviews(f).length, 1); assert.equal(workers(f).length, 1);
  assert.deepEqual(result(f.retry(run, options)), fixed); assert.equal(workers(f).length, 1);
});

for (const mutation of ['identity', 'head', 'dirty', 'report', 'superseded', 'blocked']) test(`legacy refusal recovery rechecks ${mutation} before reviewing`, t => {
  const f = fixture(t), { older, run } = overlap(f); legacy(f, run); f.record(['abandon', older]);
  let expected;
  if (mutation === 'identity' || mutation === 'report') {
    const saved = receipt(f, run);
    if (mutation === 'identity') { saved.common = path.join(f.root, 'another.git'); expected = /different project or record/; }
    else { saved.reportHash = '0'.repeat(64); expected = /recorded report hash/; }
    fs.writeFileSync(receiptPath(f, run), JSON.stringify(saved));
  } else if (mutation === 'head') { f.commit('unrelated\n'); expected = /HEAD or branch moved/; }
  else if (mutation === 'dirty') { fs.writeFileSync(path.join(f.workspace, 'keep.txt'), 'keep'); expected = /worktree changed/; }
  else if (mutation === 'superseded') {
    const newer = f.start(); f.report(newer, 'needs_human'); f.record(['ingest', f.show(newer).report_path]); expected = /superseded/;
  } else {
    const blocker = f.record(['add', 'Resolve new scope', '--role', 'architect']).split(' ')[0];
    f.record(['block', f.show(run).item, '--by', blocker]); expected = /blocked/;
  }
  const head = f.git(['rev-parse', 'HEAD'], f.workspace), dirty = f.git(['status', '--porcelain'], f.workspace);
  const refused = f.retry(run);
  assert.match(refused.status === 0 ? JSON.parse(refused.stdout).reason : refused.stderr, expected);
  assert.equal(reviews(f).length, 0); assert.equal(workers(f).length, 0);
  assert.equal(f.git(['rev-parse', 'HEAD'], f.workspace), head);
  assert.equal(f.git(['status', '--porcelain'], f.workspace), dirty);
});

test('unverified acceptance remains a terminal escalation on retry', t => {
  const f = fixture(t), run = f.start(); f.commit('correct\n'); f.report(run);
  fs.writeFileSync(path.join(f.root, 'unverified'), 'unverified');
  const refused = result(f.settle(run)); assert.equal(refused.result, 'escalate');
  assert.match(refused.reason, /unverified claims/);
  fs.unlinkSync(path.join(f.root, 'unverified')); advance(f);
  assert.deepEqual(result(f.retry(run)), refused); assert.equal(reviews(f).length, 1);
});
