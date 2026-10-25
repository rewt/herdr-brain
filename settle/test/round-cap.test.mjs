import test from '../../test/helpers/bounded-test.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fixture } from './fixture.mjs';
import { gitProject, ignoreRuntime } from '../../lib/project.mjs';

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
const launchCalls = (f) => f.calls().filter((a) => a[1] === 'start' ||
  (a[1] === 'prompt' && (a[3].startsWith('You are run ') || a[3].includes('Private record file: '))));
function retainWorker(f, run) {
  // The shared fake normally expires clients with their launching CLI. These
  // scenarios model a retained native worker after that foreground CLI exits.
  const file = path.join(f.root, 'agents.json'), agents = JSON.parse(fs.readFileSync(file));
  delete agents[f.show(run).meta.agent].client_owner;
  fs.writeFileSync(file, JSON.stringify(agents));
}
function dispatchWorker(f, item, extra = []) {
  ignoreRuntime(gitProject(f.repo, { env: f.env }));
  const receipt = result(f.exec(process.execPath, [path.join(f.source, 'dispatch/dispatch.mjs'), item,
    '--lane', 'topic', '--route', 'engineer', '--brief', path.join(f.root, 'ask with spaces.md'), ...extra]));
  retainWorker(f, receipt.run);
  return receipt;
}

test('unconfigured projects use cap1 and request one formal fix explicitly', t => {
  const f = fixture(t); review(f);
  const run = landed(f), first = result(f.settle(run));
  assert.equal(first.result, 'promotable_with_findings');
  assert.deepEqual(first.review_policy, { cap: 1, source: 'default', round: 1, prior_runs: [] });
  const workers = () => f.calls().filter(a => a[1] === 'prompt' && a[3].startsWith('You are run '));
  const reviews = () => f.calls().filter(a => a[1] === 'prompt' && a[3].includes('Private record file: '));
  assert.equal(workers().length, 0); assert.equal(reviews().length, 1);
  const correction = result(f.retry(run, ['--fix-findings']));
  assert.equal(correction.result, 'fix_round');
  assert.equal(workers().length, 1); assert.equal(reviews().length, 1);
  assert.deepEqual(result(f.retry(run, ['--fix-findings'])), correction);
  assert.equal(workers().length, 1); assert.equal(reviews().length, 1);
});

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

test('cap reached with Major or FAIL escalates without dispatch; supervisor correction dispatches exactly once', { timeout: 60000 }, (t) => {
  for (const kind of ['Major', 'FAIL']) {
    const f = fixture(t, { actor: `settle-cap-${kind}-test` }); config(f, 1);
    review(f, kind === 'FAIL' ? 'FAIL' : 'NEEDS-WORK', kind === 'Major' ? moderate.replace('Moderate', 'Major') : moderate);
    const run = landed(f);
    const r = result(f.settle(run)); assert.equal(r.result, 'escalate', kind); assert.equal(r.code, 'REVIEW_CAP_REACHED');
    assert.equal(f.calls().filter((a) => a[1] === 'start').length, 1, 'only the reviewer starts');
    assert.equal(f.calls().filter((a) => a[1] === 'prompt' && a[3].startsWith('You are run ')).length, 0);
    assert.deepEqual(f.show(r.item).runs, [run]);
    assert.match(fs.readFileSync(r.handoff, 'utf8'), /--retry --fix-findings/);
    assert.deepEqual(result(f.retry(run)), r, 'ordinary retry never dispatches past the cap');
    const correction = result(f.retry(run, ['--fix-findings']));
    assert.equal(correction.result, 'fix_round'); assert.ok(correction.fix.run);
    const calls = launchCalls(f);
    assert.deepEqual(result(f.retry(run, ['--fix-findings'])), correction);
    assert.deepEqual(launchCalls(f), calls, 'repeated explicit correction adopts its receipt');
    assert.equal(f.calls().filter((a) => a[1] === 'prompt' && a[3].startsWith('You are run ')).length, 1);
    assert.equal(f.show(run).notes.filter((n) => n.decision && /requested another correction/.test(n.text)).length, 1);
    const saved = JSON.parse(fs.readFileSync(path.join(f.org, 'settle', `${run}.json`)));
    assert.deepEqual(saved.cappedResult, r);
  }
});

test('historical explicit cap3 control allows two automatic fix rounds then stops at Major findings', { timeout: 60000 }, (t) => {
  const f = fixture(t, { actor: 'settle-cap-bch-test' }); config(f, 3);
  review(f, 'NEEDS-WORK', moderate.replace('Moderate', 'Major'));
  let run = landed(f);
  for (const round of [1, 2, 3]) {
    const r = result(f.settle(run));
    assert.equal(r.review_policy.round, round); assert.equal(r.review_policy.cap, 3);
    assert.equal(r.result, round < 3 ? 'fix_round' : 'escalate');
    if (round < 3) run = r.fix.run;
    else assert.equal(r.code, 'REVIEW_CAP_REACHED');
  }
  assert.equal(f.calls().filter((a) => a[1] === 'prompt' && a[3].startsWith('You are run ')).length, 2);
});

test('settle reuses the same route with continuation metadata and starts fresh when the fix route changes', { timeout: 60000 }, (t) => {
  for (const changed of [false, true]) {
    const f = fixture(t, { actor: 'settle-reuse-route-test' }); review(f);
    const item = JSON.parse(f.record(['status', '--json'])).items[0].id;
    const first = dispatchWorker(f, item), prior = f.show(first.run);
    const reviewed = result(f.settle(first.run, ['--reuse', ...(changed ? ['--fix-route', 'engineer-max'] : [])]));
    assert.equal(reviewed.review_policy.cap, 1);
    assert.equal(reviewed.result, 'promotable_with_findings');
    // Intake has captured the reuse/route choice. Request the one formal fix
    // from that receipt; retry must not replace those saved settings.
    const r = result(f.retry(first.run, ['--fix-findings']));
    assert.equal(r.result, 'fix_round');
    const next = f.show(r.fix.run);
    if (changed) {
      assert.equal(r.reuse_skipped, 'route_changed'); assert.notEqual(next.meta.agent, prior.meta.agent);
      assert.equal(next.meta.route, 'engineer-max'); assert.equal(next.meta.continuation_of, undefined);
      assert.equal(next.meta.same_session, undefined);
    } else {
      assert.equal(r.reuse_skipped, undefined);
      for (const key of ['agent', 'pane', 'agent_session_id', 'terminal_id']) assert.equal(next.meta[key], prior.meta[key]);
      assert.equal(next.meta.continuation_of, first.run); assert.equal(next.meta.same_session, true);
    }
    const saved = JSON.parse(fs.readFileSync(path.join(f.org, 'settle', `${first.run}.json`)));
    assert.equal(saved.reuse_skipped, r.reuse_skipped);
    const calls = launchCalls(f);
    assert.deepEqual(result(f.retry(first.run)), r); assert.deepEqual(launchCalls(f), calls);
  }
});

test('cross-item reuse neither consumes another item review round nor resets the original count', { timeout: 60000 }, (t) => {
  const f = fixture(t, { actor: 'settle-cross-item-rounds-test' }); config(f, 2); review(f);
  const item = JSON.parse(f.record(['status', '--json'])).items[0].id;
  const first = dispatchWorker(f, item), reviewed = result(f.settle(first.run, ['--reuse']));
  assert.equal(reviewed.review_policy.round, 1); assert.equal(reviewed.result, 'fix_round');
  f.record(['ingest', f.show(reviewed.fix.run).report_path]);
  retainWorker(f, reviewed.fix.run);
  const sibling = f.record(['add', 'Sibling slice', '--role', 'engineer']).split(' ')[0];
  const other = dispatchWorker(f, sibling, ['--reuse', reviewed.fix.run]);
  const otherReview = result(f.settle(other.run, ['--review-round-cap', '1']));
  assert.equal(otherReview.result, 'promotable_with_findings');
  assert.equal(otherReview.review_policy.round, 1); assert.deepEqual(otherReview.review_policy.prior_runs, []);
  const back = dispatchWorker(f, item, ['--reuse', other.run]);
  const next = result(f.settle(back.run));
  assert.equal(next.result, 'promotable_with_findings'); assert.equal(next.review_policy.round, 2);
  assert.deepEqual(next.review_policy.prior_runs, [first.run]);
  const savedOther = JSON.parse(fs.readFileSync(path.join(f.org, 'settle', `${other.run}.json`)));
  assert.deepEqual(savedOther.result.review_policy, otherReview.review_policy);
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
