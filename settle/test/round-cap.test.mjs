import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fixture } from './fixture.mjs';

const result = (r) => { assert.equal(r.status, 0, r.stderr); return JSON.parse(r.stdout); };
const moderate = '- [Moderate] work.txt:1 - Narrow remaining issue; Fix: follow up';
const minor = '- [Minor] work.txt:1 - Small remaining issue; Fix: follow up';
function review(f, verdict = 'NEEDS-WORK', findings = moderate) {
  fs.writeFileSync(path.join(f.root, 'review-result.json'), JSON.stringify({ verdict, findings }));
}
function config(f, cap) {
  fs.writeFileSync(path.join(f.repo, '.lane.json'), JSON.stringify({ settle: { review_round_cap: cap } }));
  f.git(['add', '.lane.json']); f.git(['commit', '-qm', 'Configure review round cap']);
  f.git(['rebase', 'main'], f.workspace);
}
function landed(f) { const run = f.start(); f.commit('correct\n'); f.report(run); return run; }

test('project cap counts completed reviews across fix runs and records the no-dispatch decision', { timeout: 45000 }, (t) => {
  const f = fixture(t, { actor: 'settle-cap-project-test' }); config(f, 2); review(f, 'NEEDS-WORK', `${moderate}\n${minor}`);
  const run = landed(f), first = result(f.settle(run));
  assert.equal(first.result, 'fix_round');
  assert.deepEqual(first.review_policy, { cap: 2, source: 'project', round: 1, prior_runs: [] });
  const head = f.git(['rev-parse', 'HEAD'], f.workspace), starts = f.calls().filter((a) => a[1] === 'start').length;
  const second = result(f.settle(first.fix.run));
  assert.equal(second.result, 'promotable_with_findings'); assert.equal(second.reviewed_commit, head);
  assert.equal(second.review_policy.round, 2); assert.deepEqual(second.review_policy.prior_runs, [run]);
  assert.equal(second.findings, `${moderate}\n${minor}`); assert.equal(second.validation.executed, false);
  assert.match(fs.readFileSync(second.handoff, 'utf8'), /Narrow remaining issue/);
  assert.equal(f.calls().filter((a) => a[1] === 'start').length, starts + 1, 'only the independent reviewer starts');
  assert.deepEqual(f.show(second.item).runs, [run, first.fix.run]);
  assert.ok(f.show(first.fix.run).notes.some((n) => n.decision && /promotable_with_findings.*cap: 2.*round: 2/.test(n.text)));
  assert.equal(f.git(['status', '--porcelain'], f.workspace), '');
  assert.deepEqual(result(f.settle(first.fix.run)), second, 'cached capped result is idempotent');
});

test('a recorded item cap overrides the project and flag overrides persist on the item', { timeout: 45000 }, (t) => {
  const f = fixture(t, { actor: 'settle-cap-item-test' }); config(f, 4); review(f);
  const run = landed(f), item = f.show(run).item;
  const ready = result(f.settle(run, ['--review-round-cap', '1']));
  assert.equal(ready.result, 'promotable_with_findings'); assert.equal(ready.review_policy.source, 'item');
  assert.equal(f.show(item).meta.settle_review_round_cap, 1);
  const continued = result(f.retry(run, ['--fix-findings']));
  assert.equal(continued.result, 'fix_round');
  const starts = f.calls().filter((a) => a[1] === 'start').length;
  assert.equal(result(f.retry(run, ['--fix-findings'])).fix.run, continued.fix.run);
  assert.equal(f.calls().filter((a) => a[1] === 'start').length, starts);
  const next = result(f.settle(continued.fix.run)); assert.equal(next.result, 'promotable_with_findings');
  assert.equal(next.review_policy.cap, 1); assert.equal(next.review_policy.round, 2);
  assert.ok(f.show(run).notes.some((n) => n.decision && /requested another correction/.test(n.text)));
});

test('explicit correction after capped findings remains resumable under STOP', { timeout: 45000 }, (t) => {
  const f = fixture(t, { actor: 'settle-cap-stop-test' }); review(f);
  const run = landed(f), ready = result(f.settle(run, ['--review-round-cap', '1']));
  assert.equal(ready.result, 'promotable_with_findings');
  const stop = path.join(f.repo, '.lane/supervisor/STOP');
  fs.mkdirSync(path.dirname(stop), { recursive: true }); fs.writeFileSync(stop, 'Pause correction');
  const starts = f.calls().filter((a) => a[1] === 'start').length;
  assert.equal(result(f.retry(run, ['--fix-findings'])).result, 'stopped');
  assert.equal(f.calls().filter((a) => a[1] === 'start').length, starts);
  const saved = JSON.parse(fs.readFileSync(path.join(f.org, 'settle', `${run}.json`), 'utf8'));
  assert.deepEqual(saved.cappedResult, ready); assert.equal(saved.stage, 'fix');
  fs.unlinkSync(stop);
  assert.equal(result(f.retry(run)).result, 'fix_round');
  assert.equal(f.calls().filter((a) => a[1] === 'start').length, starts + 1);
});

test('zero item cap disables the project cap; worker starts without reviews do not consume rounds', { timeout: 45000 }, (t) => {
  const f = fixture(t, { actor: 'settle-cap-zero-test' }); config(f, 1); review(f);
  const unused = f.start(); f.record(['abandon', unused, '--note', 'Never reviewed']);
  const run = landed(f); f.record(['set', f.show(run).item, 'meta.settle_review_round_cap=0']);
  const r = result(f.settle(run)); assert.equal(r.result, 'fix_round');
  assert.equal(r.review_policy.cap, 0); assert.equal(r.review_policy.round, 1);
});

test('cap reached still dispatches for Major or FAIL', { timeout: 60000 }, (t) => {
  for (const kind of ['Major', 'FAIL']) {
    const f = fixture(t, { actor: `settle-cap-${kind}-test` }); config(f, 1);
    review(f, kind === 'FAIL' ? 'FAIL' : 'NEEDS-WORK', kind === 'Major' ? moderate.replace('Moderate', 'Major') : moderate);
    const run = landed(f);
    const r = result(f.settle(run)); assert.equal(r.result, 'fix_round', kind); assert.ok(r.fix.run);
  }
});

test('cap cannot waive unverified claims or unparsed finding severity', { timeout: 45000 }, (t) => {
  for (const kind of ['unverified', 'unparsed']) {
    const f = fixture(t, { actor: `settle-cap-${kind}-test` }); config(f, 1);
    review(f, 'NEEDS-WORK', kind === 'unparsed' ? 'A Major issue in free prose' : moderate);
    if (kind === 'unverified') fs.writeFileSync(path.join(f.root, 'unverified'), '');
    const run = landed(f), r = result(f.settle(run));
    assert.equal(r.result, 'escalate'); assert.match(r.reason, kind === 'unparsed' ? /unparsed findings/ : /unverified claims/);
    assert.deepEqual(f.show(r.item).runs, [run]);
  }
});

test('uncertain reviewer retries retain the cap snapshot and do not consume another completed round', { timeout: 45000 }, (t) => {
  const f = fixture(t, { actor: 'settle-cap-retry-test' }); config(f, 2); review(f);
  const run = landed(f); fs.writeFileSync(path.join(f.root, 'review-fail'), '');
  assert.equal(f.settle(run).status, 1);
  f.record(['set', f.show(run).item, 'meta.settle_review_round_cap=1']);
  fs.unlinkSync(path.join(f.root, 'review-fail'));
  const r = result(f.retry(run, ['--review-again']));
  assert.equal(r.result, 'fix_round'); assert.equal(r.review_policy.cap, 2); assert.equal(r.review_policy.round, 1);
});

test('cached capped findings and explicit correction recheck head and current run', { timeout: 45000 }, (t) => {
  for (const kind of ['moved', 'superseded']) {
    const f = fixture(t, { actor: `settle-cap-${kind}-test` }); review(f);
    const run = landed(f); assert.equal(result(f.settle(run, ['--review-round-cap', '1'])).result, 'promotable_with_findings');
    const count = f.calls().length;
    if (kind === 'moved') f.commit('changed\n'); else f.start();
    const r = f.retry(run, ['--fix-findings']);
    if (kind === 'moved') { assert.equal(r.status, 1); assert.match(r.stderr, /HEAD or branch moved/); }
    else { assert.equal(result(r).result, 'escalate'); assert.match(JSON.parse(r.stdout).reason, /superseded/); }
    assert.equal(f.calls().length, count, 'no worker or review starts');
  }
});

test('malformed cap config or flags are refused before review and dispatch', { timeout: 45000 }, (t) => {
  for (const cap of [-1, 1.5, '2', false]) {
    const f = fixture(t, { actor: 'settle-cap-invalid-config-test' }); config(f, cap);
    const r = f.settle(landed(f)); assert.equal(r.status, 1); assert.match(r.stderr, /nonnegative safe integer/);
    assert.equal(f.calls().length, 0);
  }
  const f = fixture(t, { actor: 'settle-cap-invalid-flag-test' }), run = landed(f);
  const r = f.settle(run, ['--review-round-cap', '1e2']); assert.equal(r.status, 1); assert.match(r.stderr, /nonnegative safe integer/);
  assert.equal(f.show(f.show(run).item).meta.settle_review_round_cap, undefined);
});

test('capped decisions recover missing or lost record responses without repeating review or writing duplicate notes', { timeout: 45000 }, (t) => {
  for (const lost of [false, true]) {
    const f = fixture(t, { actor: 'settle-cap-decision-recovery-test' }); review(f);
    const run = landed(f), marker = path.join(f.root, 'fail-decision'), adapter = path.join(f.root, 'record-adapter.mjs');
    fs.writeFileSync(marker, '');
    fs.writeFileSync(adapter, `#!${process.execPath}
import fs from 'node:fs'; import {spawnSync} from 'node:child_process';
const args=process.argv.slice(2);
const forward=()=>spawnSync(process.execPath,[${JSON.stringify(path.join(f.source, 'bin/org.mjs'))},...args],{env:process.env,encoding:'utf8'});
if(args[0]==='note' && args[2]?.startsWith('Settle: ') && fs.existsSync(${JSON.stringify(marker)})) {
  if(${lost}) forward();
  console.error('injected decision response failure'); process.exit(1);
}
const r=forward();process.stdout.write(r.stdout??'');process.stderr.write(r.stderr??'');process.exit(r.status??1);
`, { mode: 0o755 });
    const failed = f.settle(run, ['--review-round-cap', '1', '--org-cli', adapter]);
    assert.equal(failed.status, 1); assert.match(failed.stderr, /decision response failure/);
    const starts = f.calls().filter((a) => a[1] === 'start').length;
    fs.unlinkSync(marker);
    assert.equal(result(f.retry(run, ['--org-cli', adapter])).result, 'promotable_with_findings');
    assert.equal(f.calls().filter((a) => a[1] === 'start').length, starts);
    assert.equal(f.show(run).notes.filter((n) => n.decision && n.text.startsWith('Settle: promotable_with_findings')).length, 1);
  }
});
