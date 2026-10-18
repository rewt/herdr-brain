import test from '../../test/helpers/bounded-test.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fixture } from './fixture.mjs';

const receipt = (f, run) => JSON.parse(fs.readFileSync(path.join(f.org, 'settle', `${run}.json`)));
const result = r => { assert.equal(r.status, 0, r.stderr); return JSON.parse(r.stdout); };
const reviews = f => f.calls().filter(a => a[1] === 'start');
const workers = f => f.calls().filter(a => a[1] === 'prompt' && a[3]?.startsWith('You are run '));

// Return the real lane review unchanged, advancing main only after the reviewer
// has finished. This exercises settle's own base check and recovery, not a mock.
function moveDuringReview(f, { file = 'upstream.txt', mutation = null } = {}) {
  const adapter = path.join(f.root, 'lane-adapter.mjs');
  fs.writeFileSync(adapter, `#!${process.execPath}
import fs from 'node:fs'; import path from 'node:path'; import { spawnSync, execFileSync } from 'node:child_process';
const args = process.argv.slice(2);
const r = spawnSync(process.execPath, [${JSON.stringify(path.join(f.source, 'lanes/lane.mjs'))}, ...args], { encoding: 'utf8' });
if (args[0] === 'review') {
  const git = (cwd, args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
  const repo = ${JSON.stringify(f.repo)}, workspace = ${JSON.stringify(f.workspace)};
  fs.writeFileSync(path.join(repo, ${JSON.stringify(file)}), 'upstream change\\n');
  git(repo, ['add', '--', ${JSON.stringify(file)}]); git(repo, ['commit', '-qm', 'Move main during review']);
  if (${JSON.stringify(mutation)} === 'head') {
    fs.writeFileSync(path.join(workspace, 'concurrent.txt'), 'concurrent work\\n');
    git(workspace, ['add', 'concurrent.txt']); git(workspace, ['commit', '-qm', 'Concurrent lane work']);
  }
  if (${JSON.stringify(mutation)} === 'dirty') fs.writeFileSync(path.join(workspace, 'concurrent.txt'), 'keep this edit\\n');
}
process.stdout.write(r.stdout ?? ''); process.stderr.write(r.stderr ?? ''); process.exit(r.status ?? 1);
`, { mode: 0o755 });
  return ['--lane-cli', adapter];
}

for (const verdict of ['PASS', 'NEEDS-WORK']) test(`a clean move retries once automatically and retains the ${verdict} review and cap`, t => {
  const f = fixture(t), run = f.start(); f.commit('correct\n'); f.report(run);
  const reviewed = f.git(['rev-parse', 'HEAD'], f.workspace), base = f.git(['rev-parse', 'main']);
  if (verdict === 'NEEDS-WORK') fs.writeFileSync(path.join(f.root, 'review-result.json'), JSON.stringify({ verdict,
    findings: '- [Moderate] work.txt:1 - Narrow remaining issue; Fix: follow up' }));
  const ready = result(f.settle(run, [...moveDuringReview(f), '--review-round-cap', '1']));
  assert.equal(ready.result, verdict === 'PASS' ? 'promotable' : 'promotable_with_findings');
  assert.equal(ready.reviewed_commit, reviewed); assert.equal(ready.review.verdict, verdict);
  assert.deepEqual(ready.review_policy, { cap: 1, source: 'item', round: 1, prior_runs: [] });
  const saved = receipt(f, run), main = f.git(['rev-parse', 'main']);
  assert.deepEqual(saved.automaticBaseRetry, { from: base, onto: main, stage: 'commit-review', at: saved.automaticBaseRetry.at });
  assert.ok(Number.isFinite(Date.parse(saved.automaticBaseRetry.at)));
  assert.equal(saved.recaptures.length, 1); assert.equal(saved.recaptures[0].from, base); assert.equal(saved.recaptures[0].onto, main);
  assert.equal(saved.recapture, undefined); assert.equal(saved.mainHead, main); assert.equal(saved.round, 1);
  assert.equal(saved.rebase.state, 'applied'); assert.equal(saved.rebase.expected_tree, saved.rebase.actual_tree);
  assert.equal(f.git(['merge-base', main, ready.head]), main);
  assert.equal(f.git(['show', `${ready.head}:${saved.reviewRelative}`]), saved.review.text.trimEnd());
  assert.equal(fs.readFileSync(path.join(f.workspace, 'work.txt'), 'utf8'), 'correct\n');
  assert.equal(fs.readFileSync(path.join(f.workspace, 'upstream.txt'), 'utf8'), 'upstream change\n');
  assert.equal(f.git(['status', '--porcelain'], f.workspace), '');
  assert.equal(reviews(f).length, 1); assert.equal(workers(f).length, 0); assert.deepEqual(f.show(ready.item).runs, [run]);
  assert.equal(ready.validation.executed, false);
  assert.deepEqual(result(f.settle(run)), ready); assert.equal(reviews(f).length, 1);
  assert.deepEqual(receipt(f, run).automaticBaseRetry, saved.automaticBaseRetry);
});

test('an automatic recapture conflict escalates without replaying or repeating review', t => {
  const f = fixture(t), run = f.start(); f.commit('correct\n'); f.report(run);
  const reviewed = f.git(['rev-parse', 'HEAD'], f.workspace), base = f.git(['rev-parse', 'main']);
  const stopped = result(f.settle(run, moveDuringReview(f, { file: 'work.txt' })));
  assert.equal(stopped.result, 'escalate'); assert.match(stopped.reason, /conflicts in: work.txt/);
  assert.match(fs.readFileSync(stopped.handoff, 'utf8'), /conflicts in: work.txt/);
  const saved = receipt(f, run);
  assert.equal(saved.automaticBaseRetry.onto, f.git(['rev-parse', 'main']));
  assert.equal(saved.mainHead, base); assert.equal(saved.recaptures, undefined); assert.equal(saved.rebase.scratch, undefined);
  assert.equal(f.git(['rev-parse', 'HEAD^'], f.workspace), reviewed);
  assert.equal(fs.readFileSync(path.join(f.workspace, 'work.txt'), 'utf8'), 'correct\n');
  assert.equal(f.git(['status', '--porcelain'], f.workspace), '');
  assert.deepEqual(result(f.retry(run)), stopped);
  assert.equal(reviews(f).length, 1); assert.equal(workers(f).length, 0);
});

test('a second clean main move during the automatic replay escalates and cannot replenish the retry', t => {
  const f = fixture(t), run = f.start(); f.commit('correct\n'); f.report(run);
  const reviewed = f.git(['rev-parse', 'HEAD'], f.workspace), base = f.git(['rev-parse', 'main']);
  const hooks = path.join(f.root, 'hooks'); fs.mkdirSync(hooks);
  fs.writeFileSync(path.join(hooks, 'post-rewrite'), `#!/bin/sh
unset GIT_INDEX_FILE GIT_DIR GIT_WORK_TREE
printf 'another unrelated landing\\n' > '${f.repo}/second-upstream.txt'
git -C '${f.repo}' add second-upstream.txt
git -C '${f.repo}' -c core.hooksPath=/dev/null commit -qm 'Move main again during replay'
`, { mode: 0o755 });
  f.git(['config', 'core.hooksPath', hooks]);
  const stopped = f.settle(run, moveDuringReview(f));
  assert.equal(stopped.status, 1); assert.match(stopped.stderr, /base branch moved; use --retry/);
  assert.equal(JSON.parse(stopped.stdout).result, 'escalate');
  const saved = receipt(f, run);
  assert.equal(saved.mainHead, base); assert.equal(saved.recaptures, undefined);
  assert.equal(saved.recapture.onto, saved.automaticBaseRetry.onto);
  assert.notEqual(saved.automaticBaseRetry.onto, f.git(['rev-parse', 'main']));
  assert.equal(saved.rebase.state, 'prepared'); assert.equal(saved.rebase.expected_tree, saved.rebase.actual_tree);
  assert.equal(fs.existsSync(saved.rebase.scratch), false);
  assert.equal(f.git(['rev-parse', 'HEAD^'], f.workspace), reviewed);
  assert.equal(f.git(['status', '--porcelain'], f.workspace), '');
  assert.equal(fs.existsSync(path.join(f.workspace, 'upstream.txt')), false);
  assert.equal(f.settle(run).status, 1, 'a fresh invocation still requires explicit recovery');
  assert.deepEqual(receipt(f, run).automaticBaseRetry, saved.automaticBaseRetry);
  assert.equal(reviews(f).length, 1); assert.equal(workers(f).length, 0);
});

for (const mutation of ['head', 'dirty', 'superseded']) test(`a moved main never bypasses the ${mutation} refusal`, t => {
  const f = fixture(t), run = f.start(); f.commit('correct\n'); f.report(run);
  const head = f.git(['rev-parse', 'HEAD'], f.workspace), base = f.git(['rev-parse', 'main']);
  if (mutation === 'superseded') fs.writeFileSync(path.join(f.root, 'review-record-action.json'),
    JSON.stringify(['start', f.show(run).item, '--workspace', f.workspace]));
  const stopped = f.settle(run, moveDuringReview(f, { mutation }));
  assert.equal(stopped.status, 1);
  assert.match(stopped.stderr, mutation === 'head' ? /HEAD or branch moved/ : mutation === 'dirty' ? /worktree changed/ : /superseded/);
  const saved = receipt(f, run);
  assert.equal(saved.mainHead, base); assert.equal(saved.recapture, undefined); assert.equal(saved.rebase, undefined);
  assert.equal(saved.automaticBaseRetry === undefined, mutation !== 'superseded');
  if (mutation === 'head') assert.equal(fs.readFileSync(path.join(f.workspace, 'concurrent.txt'), 'utf8'), 'concurrent work\n');
  else assert.equal(f.git(['rev-parse', 'HEAD'], f.workspace), head);
  if (mutation === 'dirty') assert.equal(fs.readFileSync(path.join(f.workspace, 'concurrent.txt'), 'utf8'), 'keep this edit\n');
  assert.equal(reviews(f).length, 1); assert.equal(workers(f).length, 0);
});

test('a moved main does not automatically restart an uncertain reviewer', t => {
  const f = fixture(t), run = f.start(); f.commit('correct\n'); f.report(run);
  fs.writeFileSync(path.join(f.root, 'review-fail'), 'fail');
  assert.equal(f.settle(run, moveDuringReview(f)).status, 1);
  assert.equal(receipt(f, run).stage, 'reviewing'); assert.equal(receipt(f, run).automaticBaseRetry, undefined);
  fs.unlinkSync(path.join(f.root, 'review-fail'));
  const refused = f.retry(run); assert.equal(refused.status, 1); assert.match(refused.stderr, /review outcome is uncertain/);
  assert.equal(receipt(f, run).automaticBaseRetry, undefined);
  assert.equal(reviews(f).length, 1); assert.equal(workers(f).length, 0);
});
