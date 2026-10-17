import test from './helpers/bounded-test.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { completionFixture, hold, heldReason, assertNoRemoval, traceLane } from './helpers/retire-fixture.mjs';
import { installRuntime } from '../housekeeping/test/helpers/cli-fixture.mjs';
import { finishCleanup, retryCleanup } from '../promote/promote.mjs';
import { loadEvents } from '../lib/store.mjs';
import { fold } from '../lib/state.mjs';

const reconcile = fileURLToPath(new URL('../supervisor/reconcile.mjs', import.meta.url));
const jsonLines = file => fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);

for (const canonical of [true, false]) test(`activation seam: ${canonical ? 'canonical HOLD preserves completed work until bounded retry' : 'lane-local HOLD still permits guarded cleanup'}`, t => {
  const f = completionFixture(t), traced = traceLane(f), job = { ...traced.job, laneConfig: f.config };
  // In-process cleanup must inherit the same Git tracer as the CLI steps.
  const originalPath = process.env.PATH;
  process.env.PATH = f.env.PATH;
  t.after(() => { process.env.PATH = originalPath; });
  const release = hold(f, 'file', canonical ? f.repo : f.lane);
  const options = ['--repo', f.repo, '--org', f.org, '--role', 'supervisor', '--prepared', f.prepared];
  assert.equal(JSON.parse(f.run([reconcile, 'prepare', ...options, '--manifest', f.manifest, '--gate-log', f.gate]).stdout).result, 'prepared');
  const promoted = f.run([job.laneCLI, 'promote', 'topic']);
  fs.writeFileSync(f.gate, promoted.stdout + promoted.stderr);
  assert.equal(f.git(['rev-parse', 'main']), f.head);
  assert.equal(Boolean(fold(loadEvents(f.org).events).items.get('ENG-1').closed), false);
  const finished = JSON.parse(f.run([reconcile, 'finish', ...options, '--gate-exit', '0', '--tip', f.head]).stdout);
  assert.equal(finished.result, 'reconciled');
  assert.equal(fold(loadEvents(f.org).events).items.get('ENG-1').closed.as, 'done');
  const completedEvents = fs.readFileSync(f.eventFile);

  const queue = f.queue(), cleanupFile = path.join(queue.directory, 'job-cleanup.jsonl');
  const result = finishCleanup(job, { outcome: 'promoted', tip: f.head, workspace: f.lane }, queue, { now: 1000 });
  assert.equal(result.outcome, 'promoted');

  // Exercise the actual foreground housekeeping tick, including its tidy-tabs
  // subprocess. The runtime and all targets are disposable; Herdr is a fake.
  const runtime = installRuntime(path.join(f.scratch, 'runtime'));
  const config = path.join(f.scratch, 'housekeeping.json'), state = path.join(f.scratch, 'housekeeping-state');
  fs.writeFileSync(config, JSON.stringify({ enabled: true, resume: false }));
  const tick = f.run([runtime, '--once', '--cwd', f.repo, '--org', f.org,
    '--config', config, '--state-dir', state, '--herdr', f.job.herdr]);
  const logs = tick.stdout.trim().split('\n').map(JSON.parse);
  assert.ok(logs.some(row => row.action === 'tidy-tabs'), tick.stdout);
  assert.equal(logs.some(row => ['tidy-failed', 'error'].includes(row.action)), false, tick.stdout);
  assert.ok(logs.some(row => row.action === 'scan' && row.dryRun === false), tick.stdout);

  if (canonical) {
    assert.equal(result.cleanup.state, 'pending');
    assert.equal(result.cleanup.outcome, 'held');
    assert.equal(result.cleanup.last_refusal, `lane cleanup: ${heldReason}`);
    assert.deepEqual(jsonLines(cleanupFile), [{ action: 'held', why: heldReason }]);
    assert.ok(logs.some(row => row.action === 'tidy-tabs' && row.output.includes(heldReason)), tick.stdout);
    assert.ok(logs.some(row => row.action === 'scan' && row.close === 0 && row.keep === 1));
    assert.ok(logs.some(row => row.action === 'held' && row.tab_id === 'w:t' && row.why === heldReason));
    assertNoRemoval(f);
    assert.deepEqual(f.herdrCalls().filter(args => ['close', 'remove'].includes(args[1])), []);
    assert.deepEqual(jsonLines(traced.calls), [['promote', 'topic']], 'no lane close was invoked');
    assert.deepEqual(f.read().tabs, f.state.tabs);
    assert.deepEqual(f.read().panes, f.state.panes);
    assert.deepEqual(f.read().workspaces, f.state.workspaces);
    assert.ok(fs.existsSync(f.lane));
    assert.ok(f.git(['worktree', 'list', '--porcelain']).includes(`worktree ${f.lane}\n`));
    assert.equal(f.git(['rev-parse', 'lane/topic']), f.head);
    assert.equal(f.git(['rev-parse', 'HEAD'], f.lane), f.head);
    assert.deepEqual(fs.readFileSync(f.scratchFile), f.bytes);
    assert.deepEqual(fs.readFileSync(f.eventFile), completedEvents);

    queue.transaction(data => data.results.push({ ...job, ...result }));
    release();
    // The same worker is eligible as soon as the only keep reason disappears.
    const plan = f.retirement().plan(f.lane);
    assert.deepEqual(plan.keep, []);
    assert.deepEqual(plan.close.map(tab => tab.tab_id), ['w:t']);
    retryCleanup(queue, { now: result.cleanup.next_attempt_at });
    const retried = queue.load().results[0];
    assert.equal(retried.outcome, 'promoted');
    assert.equal(retried.cleanup.state, 'complete', retried.reason);
    assert.equal(retried.cleanup.attempts, 1, 'hold removal starts one retry for the new revision');
  } else {
    assert.equal(result.cleanup.state, 'complete', result.reason);
  }

  // Both release paths use the guarded executor and its existing evidence
  // preservation before removing the integrated lane and its branch.
  assert.deepEqual(f.read().actions, [['tab', 'close', 'w:t'], ['workspace', 'close', 'w']]);
  assert.deepEqual(f.herdrCalls().filter(args => ['close', 'remove'].includes(args[1])), f.read().actions);
  assert.deepEqual(jsonLines(traced.calls), [['promote', 'topic'], ['close', 'topic', '--git-only', '--expected-tip', f.head]]);
  assert.equal(fs.existsSync(f.lane), false);
  assert.equal(f.git(['branch', '--list', 'lane/topic']), '');
  assert.equal(f.git(['worktree', 'list', '--porcelain']).includes(`worktree ${f.lane}\n`), false);
  assert.deepEqual(f.read().workspaces, []);
  const receipt = jsonLines(cleanupFile), preflight = receipt.findIndex(row => row.action === 'lane-preflight');
  assert.ok(preflight >= 0);
  const proof = receipt[preflight];
  assert.equal(proof.integrated, true);
  assert.equal(proof.tip, f.head);
  assert.deepEqual(fs.readFileSync(path.join(proof.evidence.directory, 'files/.lane/review-and-scratch')), f.bytes);
  const manifest = fs.readFileSync(proof.evidence.manifest);
  assert.equal(createHash('sha256').update(manifest).digest('hex'), proof.evidence.sha256);
  assert.ok(receipt.findIndex(row => row.action === 'closed' && row.tab_id === 'w:t') < preflight);
  assert.ok(preflight < receipt.findIndex(row => row.action === 'lane-removed'));
  assert.ok(f.gitCalls().some(args => args.includes('worktree') && args.includes('remove')));
  assert.deepEqual(fs.readFileSync(f.eventFile), completedEvents);
  assert.equal(fold(loadEvents(f.org).events).items.get('ENG-1').closed.as, 'done');
});
