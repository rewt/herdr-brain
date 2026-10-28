import test from './helpers/bounded-test.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fixture, hold } from './helpers/retire-fixture.mjs';
import { assertFixtureScratch } from './helpers/scratch-fixture.mjs';
import { fold } from '../lib/state.mjs';
import { fold as olderFold } from './fixtures/state-v0.mjs';
import { digest } from '../lib/completion.mjs';
import { publishCloseoutEvents, readCloseoutEntries, readyLane, retryCloseout, recordCompletedReview, retirementOwnerLock } from '../lib/closeout.mjs';
import { reconcile } from '../supervisor/reconcile.mjs';
import { retirementLock } from '../lib/retire-lock.mjs';
import { createHousekeeping, tidyFinishedTabs } from '../housekeeping/housekeeping.mjs';
import { finishCleanup } from '../promote/promote.mjs';
import { retirementStatus, renderRetirementStatus } from '../lib/retire-status.mjs';
import { closeoutWaitState } from '../lib/closeout-status.mjs';
import { unresolvedCloseoutEffect } from '../lib/closeout.mjs';
import { closer, lanes, events, setup, evaluations, effects, retainNativeOutcome, assertRemoved } from './helpers/closeout-fixture.mjs';

test('optional ready, repeated ready and ingested done are one entry; NEEDS-WORK retains its worker', t => {
  const f = setup(t);
  readyLane({ cwd: f.repo, org: f.org, topic: 'topic', start: false });
  readyLane({ cwd: f.repo, org: f.org, topic: 'topic', start: false });
  f.report();
  f.append([{ type: 'item.added', id: 'REV-1', role: 'reviewer', kind: 'work', parent: 'ENG-1' },
    { type: 'run.started', id: 'R-2', item: 'REV-1', workspace: f.lane, meta: {} },
    { type: 'report.ingested', run: 'R-2', report: { outcome: 'done', extra: { verdict: 'NEEDS-WORK' } } }]);
  assert.equal(readCloseoutEntries(f.common).filter(e => e.run === 'R-1').length, 1);
  f.drain();
  assert.deepEqual(f.read().actions, []);
  assert.ok(evaluations(f).some(e => !e.completed && e.waiting.defect && e.waiting.producers.length === 0));
  const count = evaluations(f).length;
  f.drain(); assert.equal(evaluations(f).length, count, 'no rescan without a resolving revision');
});

for (const project of ['bch-cloak', 'herdr-brain']) test(`${project}: a landed event immediately releases and removes its exact lane, branch and empty workspace`, t => {
  const f = setup(t, { terminal: true });
  fs.mkdirSync(path.join(f.lane, '.lane'));
  fs.writeFileSync(path.join(f.lane, '.lane/evidence'), 'unique report and scratch\n');
  const [scratch] = JSON.parse(f.env.HERDR_TEST_SCRATCH_ROOTS), payload = path.join(scratch, 'run-review');
  fs.mkdirSync(payload, { recursive: true });
  fs.writeFileSync(path.join(payload, '.herdr-scratch.json'), JSON.stringify({ schema: 'herdr-scratch/v1', common: f.common, run: 'R-1' }));
  fs.writeFileSync(path.join(payload, 'result'), 'disposable');
  const nativeCommand = f.options.command;
  f.options.command = (exe, args, options) => exe === '/usr/sbin/lsof' && args.includes('-Fpfn0')
    ? { status: 0, stderr: '', stdout: `p${process.pid}\0fcwd\0n${f.repo}\0\n` }
    : nativeCommand(exe, args, options);
  const landed = readCloseoutEntries(f.common).find(e => e.signal === 'landed');
  assert.equal(landed.source.type, 'promotion.reconciled');
  const ready = readCloseoutEntries(f.common).find(e => e.signal === 'ready');
  const readyBytes = fs.readFileSync(path.join(f.common,'closeout/entries',ready.key+'.json'));
  f.drain(); assertRemoved(f);
  assert.deepEqual(readCloseoutEntries(f.common).map(e=>e.key),[ready.key],'a landed completion cannot prune its unevaluated ready source');
  assert.deepEqual(fs.readFileSync(path.join(f.common,'closeout/entries',ready.key+'.json')),readyBytes);
  const twin=f.drain({keys:[ready.key],retrySafe:true});
  assert.equal(twin.evaluated[0]?.completed,true,JSON.stringify(twin));assert.deepEqual(twin.evaluated[0].source,ready.source);
  assert.match(twin.evaluated[0].reason,/same worktree retired by a later bound request/);
  assert.deepEqual(readCloseoutEntries(f.common), [], 'only durable record evidence remains after exact-source completion');
  const evaluated = evaluations(f).findLast(event => event.completed && event.source.type === 'promotion.reconciled');
  const codeRoot = fs.realpathSync(path.resolve(import.meta.dirname, '..')), marker = path.join(codeRoot, '.release-commit');
  assert.ok(evaluated, 'real consumer completed its bound source');
  assert.equal(evaluated.code.code.root, codeRoot);
  assert.equal(evaluated.code.code.kind, fs.existsSync(marker) ? 'release' : 'checkout');
  assert.equal(evaluated.code.code.commit, fs.existsSync(marker) ? fs.readFileSync(marker, 'utf8').trim() : f.git(['rev-parse', 'HEAD'], codeRoot));
  assert.equal(fs.existsSync(path.join(f.common, 'closeout/consumer.lock')), false, 'completed removal releases its consumer claim');
  const actions = effects(f).map(e => e.action);
  for (const action of ['exit-observed', 'closed', 'lane-preflight', 'worktree-removed', 'branch-removed', 'lane-removed']) assert.ok(actions.includes(action), action);
  const proof = effects(f).find(e => e.action === 'lane-preflight');
  assert.equal(fs.existsSync(payload), false, 'the queue calls the guarded executor scratch sweep');
  const sweep = JSON.parse(fs.readFileSync(proof.scratchManifest));
  assert.equal(sweep.entries.find(e => e.path === payload).disposition, 'removed');
  assert.equal(fs.readFileSync(path.join(proof.evidence.directory, 'files/.lane/evidence'), 'utf8'), 'unique report and scratch\n');
  const completion = events(f).find(e => e.type === 'closeout.effect' && e.outcome.action === 'lane-removed');
  const source = events(f).find(e => e.type === 'promotion.reconciled');
  assert.ok(Date.parse(completion.at) - Date.parse(source.at) < 1800000, 'no scheduling delay before closeout');
  const nativeActions = f.read().actions;
  f.drain(); assert.deepEqual(f.read().actions, nativeActions, 'completed effects do not repeat');
});

for (const abandoned of [false, true, 'at-landing']) test(`a fix round retains its ${abandoned === 'at-landing' ? 'unreported until landing' : abandoned ? 'record-superseded' : 'reported'} worker, and landing closes every ended session in that lane`, t => {
  const f = setup(t);
  if (abandoned) {
    readyLane({ cwd: f.repo, org: f.org, topic: 'topic', start: false });
    if (abandoned === true) f.append([{ type: 'run.abandoned', id: 'R-1', note: 'superseded by a fresh fix worker' }]);
  } else f.report();
  f.drain();
  assert.deepEqual(f.read().actions, [], 'the worker stays available during review and fixes');
  fs.writeFileSync(path.join(f.lane, 'seed'), 'fixed'); f.git(['commit', '-am', 'fix'], f.lane);
  const head = f.git(['rev-parse', 'HEAD'], f.lane); f.git(['merge', '--ff-only', head]);
  f.state.tabs.push({ tab_id: 'w:fix', workspace_id: 'w' });
  f.state.panes.push({ pane_id: 'w:fix:p', tab_id: 'w:fix', workspace_id: 'w', terminal_id: 'fix-terminal' });
  f.state.agents.push({ ...f.state.agents[0], name: 'fix-worker', pane_id: 'w:fix:p', tab_id: 'w:fix',
    terminal_id: 'fix-terminal', agent_session: { value: 'fix-session' } });
  f.save();
  const base = f.options.command;
  f.options.command = (exe, args, opt) => {
    if (exe !== f.job.herdr) return base(exe, args, opt);
    const current = f.read(), out = result => ({ status: 0, stdout: JSON.stringify({ result }), stderr: '' });
    if (args[0] === 'pane' && args[1] === 'process-info') return out({ process_info: current.exited?.includes(args.at(-1)) ? {
      shell_pid: 1, foreground_processes: [{ pid: 1, name: 'zsh' }], process_tree_complete: true, process_tree: [current.info.process_tree[0]],
    } : current.info });
    if (args[0] === 'agent' && args[1] === 'prompt') {
      const agent = current.agents.find(a => a.name === args[2]);
      current.actions.push(args); current.exited = [...(current.exited ?? []), agent.pane_id];
      current.agents = current.agents.filter(a => a.name !== args[2]); fs.writeFileSync(f.file, JSON.stringify(current)); return out({});
    }
    return base(exe, args, opt);
  };
  f.append([{ type: 'run.started', id: 'R-2', item: 'ENG-1', workspace: f.lane, meta: { agent: 'fix-worker', pane: 'w:fix:p',
    worker_workspace: 'w', terminal_id: 'fix-terminal', agent_session_id: 'fix-session', lane: 'topic' } },
    { type: 'report.ingested', run: 'R-2', report: { outcome: 'done' } }]);
  if (abandoned === 'at-landing') {
    f.append([{ type: 'run.abandoned', id: 'R-1', note: 'explicit supersession at reconciliation' }, { type: 'item.closed', id: 'ENG-1', as: 'done' }]);
    f.drain(); assert.deepEqual(f.read().actions, [], 'the successor remains observable for the new supersession proof');
  }
  f.append([...(abandoned === 'at-landing' ? [] : [{ type: 'item.closed', id: 'ENG-1', as: 'done' }]),
    { type: 'promotion.reconciled', identity: f.common, heads: [{ run: 'R-2', item: 'ENG-1', head }], runs: ['R-2'], items: ['ENG-1'] }]);
  const landed = readCloseoutEntries(f.common).find(e => e.signal === 'landed');
  assert.deepEqual(landed.panes.map(p => p.run), ['R-1', 'R-2']);
  f.drain(); assertRemoved(f);
  assert.deepEqual(f.read().actions.filter(a => a[0] === 'agent').map(a => a[2]), ['worker', 'fix-worker']);
  assert.equal(f.read().actions.filter(a => a[0] === 'tab').length, 2);
  if (abandoned) assert.equal(events(f).filter(e => e.type === 'run.abandoned' && e.id === 'R-1').length, 1,
    'the original abandonment remains recorded; closing its exact bound pane does not invent another release');
});

function reviewFixture(t, followup_expected = false) {
  const f = setup(t), initial = events(f);
  initial[1].meta = { ...initial[1].meta, agent: 'original-worker', pane: 'original-pane', terminal_id: 'original-terminal', agent_session_id: 'original-session' };
  fs.writeFileSync(f.eventFile, initial.map(e => JSON.stringify(e) + '\n').join(''));
  f.report();
  const r = f.retirement(f.options);
  r.recordCallback({ kind: 'settle', pane: 'w:p', agent: 'worker', run: 'R-1' });
  const evidence = path.join(f.scratch, 'review.md'), bytes = '**NEEDS-WORK**\nFindings retained.\n';
  fs.writeFileSync(evidence, bytes);
  const receipt = r.recordReviewVerdict({ pane: 'w:p', run: 'R-1', verdict: 'NEEDS-WORK', head: f.head,
    evidence, sha256: createHash('sha256').update(bytes).digest('hex'), followup_expected, deferCloseout: true });
  recordCompletedReview({ cwd: f.repo, org: f.org, receipt, head: f.head, item: 'ENG-1', start: false, env: f.env });
  return f;
}

test('review.verdict releases only its exact reviewer and preserves the worker and lane for fixes', t => {
  const f = reviewFixture(t), before = fold(events(f));
  assert.equal(events(f).filter(e => e.type === 'review.verdict').length, 1);
  f.drain();
  assert.deepEqual(f.read().actions, [['agent', 'prompt', 'worker', '/quit'], ['tab', 'close', 'w:t']]);
  assert.equal(fs.existsSync(f.lane), true);
  assert.equal(f.read().workspaces.length, 1, 'pane-only release cannot close a workspace');
  assert.equal(events(f).find(e => e.type === 'retirement.release').recipient, 'reviewer');
  assert.deepEqual(fold(events(f)).runs, before.runs);
  assert.deepEqual(olderFold(events(f)).runs, olderFold(events(f).filter(e => !e.type.startsWith('review.') && !e.type.startsWith('closeout.'))).runs);
});

test('an explicit same-session reviewer follow-up keeps until its recorded end', t => {
  const f = reviewFixture(t, true);
  f.drain(); assert.deepEqual(f.read().actions, []);
  const review = events(f).find(e => e.type === 'review.verdict');
  f.append([{ type: 'review.followup-ended', review_id: review.review.id, run: review.run, item: review.item, source_seq: review.seq, why: 'follow-up completed' }]);
  f.drain(); assert.equal(f.read().actions.filter(a => a[0] === 'tab').length, 1);
});

test('reviewer completion rejects another review run or source before accepting the exact end', t => {
  const f = reviewFixture(t, true);
  f.drain();
  const review = events(f).find(e => e.type === 'review.verdict');
  const end = { type: 'review.followup-ended', review_id: review.review.id, run: review.run,
    item: review.item, source_seq: review.seq, why: 'follow-up completed' };
  const wait = events(f).findLast(e => e.type === 'closeout.waiting');
  assert.equal(wait.waiting.owner, 'review-followup');
  const calls = f.herdrCalls();
  for (const patch of [{ review_id: 'another-review' }, { run: 'R-999' }, { item: 'ENG-999' }, { source_seq: review.seq - 1 }]) {
    f.append([{ ...end, ...patch }]);
    assert.equal(closeoutWaitState(wait, events(f)), 'pending');
    assert.deepEqual(f.drain().evaluated, []);
    assert.deepEqual(f.herdrCalls(), calls);
    assert.deepEqual(f.read().actions, []);
  }
  f.append([end]);
  f.drain();
  assert.equal(closeoutWaitState(wait, events(f)), 'complete');
  assert.equal(f.read().actions.filter(a => a[0] === 'tab').length, 1);
  assert.ok(fs.existsSync(f.lane), 'review completion preserves the worker lane for fixes');
});

test('Git removal completion stays bound to its original result and preservation proof', t => {
  const f = setup(t, { terminal: true }), command = f.options.command;
  f.options.command = (exe, args, opt) => exe === 'git' && args.includes('worktree') && args.includes('remove') ?
    { status: 1, stdout: '', stderr: 'injected known Git failure' } : command(exe, args, opt);
  f.drain();
  const all = events(f), wait = all.findLast(e => e.type === 'closeout.waiting' && e.waiting.producers.some(p => p.kind === 'git-removal'));
  assert.ok(wait);
  assert.equal(closeoutWaitState(wait, all), 'complete', 'the original synchronous result is the completion');
  const finished = all.findLast(e => e.outcome?.action === 'git-removal-finished');
  const started = all.findLast(e => e.outcome?.action === 'git-removal-started');
  assert.equal(all.filter(e => e.outcome?.action === 'git-removal-started').length, 1, 'no in-drain replay');
  for (const patch of [{ attempt: 'replacement' }, { operation: 'branch' }, { cwd: f.repo }, { tip: 'a'.repeat(40) },
    { evidence: null }, { branchGeneration: null }, { exit_status: 0 }, { exit_status: null }, { code: 'EPERM' }, { reason: 'native refusal' }]) {
    const changed = all.map(e => e === finished ? { ...e, outcome: { ...e.outcome, ...patch } } : e);
    assert.equal(closeoutWaitState(wait, changed), 'pending', JSON.stringify(patch));
  }
  for (const target of [started, finished]) for (const patch of [{ identity: '/foreign' }, { key: 'foreign' }, { source: { seq: 0, type: 'other' } }]) {
    const changed = all.map(e => e === target ? { ...e, ...patch } : e);
    assert.equal(closeoutWaitState(wait, changed), 'pending', JSON.stringify(patch));
  }
  assert.ok(fs.existsSync(f.lane));
  f.options.command = (exe, args, opt) => exe === 'git' && args.includes('worktree') && args.includes('remove') ?
    { status: null, signal: 'SIGTERM', stdout: '', stderr: 'interrupted successor' } : command(exe, args, opt);
  f.drain();
  const interrupted = events(f), calls = f.herdrCalls();
  assert.equal(interrupted.filter(e => e.outcome?.action === 'git-removal-started').length, 2);
  assert.equal(interrupted.filter(e => e.outcome?.action === 'git-removal-finished').length, 1);
  retryCloseout({ cwd: f.repo, org: f.org, topic: 'topic', why: 'later retry cannot reuse the older result', start: false });
  assert.deepEqual(f.drain({ keys: readCloseoutEntries(f.common).map(e => e.key), retrySafe: true }).evaluated, []);
  assert.deepEqual(f.herdrCalls(), calls);
  assert.deepEqual(events(f).slice(0, interrupted.length), interrupted);
});

test('Git removal without a known original completion retains timeout signal and permission failures', t => {
  for (const result of [{ status: null, signal: 'SIGTERM', stdout: '', stderr: 'interrupted' },
    { status: null, error: { code: 'ETIMEDOUT', message: 'timeout' }, stdout: '', stderr: '' },
    { status: 1, error: { code: 'EPERM', message: 'permission denied' }, stdout: '', stderr: '' }]) {
    const f = setup(t, { terminal: true }), command = f.options.command;
    f.options.command = (exe, args, opt) => exe === 'git' && args.includes('worktree') && args.includes('remove') ? result : command(exe, args, opt);
    f.drain();
    const original = events(f), calls = f.herdrCalls();
    assert.ok(original.some(e => e.outcome?.action === 'git-removal-started'));
    assert.equal(original.some(e => e.outcome?.action === 'git-removal-finished'), false);
    f.options.command = command;
    retryCloseout({ cwd: f.repo, org: f.org, topic: 'topic', why: 'transport available again', start: false });
    assert.deepEqual(f.drain({ keys: readCloseoutEntries(f.common).map(e => e.key), retrySafe: true }).evaluated, []);
    assert.deepEqual(f.herdrCalls(), calls);
    assert.deepEqual(events(f).slice(0, original.length), original);
    assert.ok(fs.existsSync(f.lane));
  }
});

test('HOLD without a completion producer stays deferred after removal and a manual retry', t => {
  const f = setup(t, { terminal: true }), releaseHold = hold(f);
  f.drain();
  assert.deepEqual(f.read().actions, []);
  assert.ok(evaluations(f).every(e => !e.completed && e.waiting.owner));
  assert.ok(evaluations(f).some(e => /HOLD/.test(e.reason) && e.waiting.defect && !e.waiting.producers.length));
  const entries = readCloseoutEntries(f.common);
  releaseHold();
  const before = evaluations(f).length;
  f.drain(); assert.equal(evaluations(f).length, before, 'removing an unobservable file is not an implicit poll');
  retryCloseout({ cwd: f.repo, org: f.org, topic: 'topic', why: 'hold-removed', start: false });
  assert.deepEqual(f.drain().evaluated, []);
  assert.equal(fs.existsSync(f.lane), true); assert.deepEqual(f.read().actions, []);
  assert.deepEqual(readCloseoutEntries(f.common), entries, 'retry cannot replace the held source or invent its completion');
});

for (const changed of ['head', 'pane', 'dirty', 'reference']) test(`${changed} changes keep the bound target with a recorded reason`, t => {
  const f = setup(t, { terminal: true });
  if (changed === 'head' || changed === 'dirty') fs.writeFileSync(path.join(f.lane, 'seed'), 'later work');
  if (changed === 'head') f.git(['commit', '-am', 'later'], f.lane);
  if (changed === 'pane') { f.state.agents[0].agent_session.value = 'replacement'; f.save(); }
  if (changed === 'reference') fs.writeFileSync(path.join(f.org, 'references/live.json'), JSON.stringify({ schema: 'herdr-reference/v1', owner: 'fixture',
    kind: 'named follow-up', job: 'follow-up', run: 'R-1', item: 'ENG-1', state: 'running', created_at: '2020-01-01', expires_at: '2099-01-01' }));
  f.drain();
  assert.deepEqual(f.read().actions, []);
  assert.ok(evaluations(f).every(e => !e.completed && e.reason && e.waiting.owner && Array.isArray(e.waiting.producers)));
  assert.equal(fs.existsSync(f.lane), true);
});

test('a blocked target does not hold an unrelated eligible target at the head of the queue', t => {
  const f = setup(t, { terminal: true }), other = path.join(f.scratch, 'other');
  fs.writeFileSync(path.join(f.org, 'references/live.json'), JSON.stringify({ schema: 'herdr-reference/v1', owner: 'fixture',
    kind: 'named follow-up', job: 'follow-up', run: 'R-1', item: 'ENG-1', state: 'running', created_at: '2020-01-01', expires_at: '2099-01-01' }));
  f.git(['worktree', 'add', '-b', 'lane/other', other]);
  fs.writeFileSync(path.join(other, 'seed'), 'other work'); f.git(['commit', '-am', 'other'], other);
  const head = f.git(['rev-parse', 'HEAD'], other); f.git(['merge', '--ff-only', head]);
  f.append([{ type: 'item.added', id: 'ENG-2', kind: 'work', role: 'engineer' },
    { type: 'run.started', id: 'R-2', item: 'ENG-2', workspace: other, meta: {} },
    { type: 'report.ingested', run: 'R-2', report: { outcome: 'done' } }]);
  // These are saved legacy report requests. Commit that representation before
  // landing so today's atomic direct-report writer does not suppress its twin.
  f.append([{ type: 'item.closed', id: 'ENG-2', as: 'done' },
    { type: 'promotion.reconciled', identity: f.common, heads: [{ run: 'R-2', item: 'ENG-2', head }], runs: ['R-2'], items: ['ENG-2'] }]);
  fs.writeFileSync(path.join(f.common, 'closeout/entries', `${'f'.repeat(64)}.json`), '{"schema":"closeout-entry/v999"}\n');
  f.drain();
  assert.equal(fs.existsSync(f.lane), true);
  assert.equal(fs.existsSync(other), false);
  assert.ok(effects(f).some(e => e.action === 'lane-removed' && e.cwd === other));
  assert.ok(events(f).some(e => e.type === 'closeout.invalid' && e.waiting.event === 'entry-repaired'));
});

test('an ended, explicitly dropped unmerged lane is archive-tagged and its evidence survives removal', t => {
  const f = setup(t, { occupied: false, merged: false });
  f.report(); f.append([{ type: 'item.closed', id: 'ENG-1', as: 'dropped' }]);
  f.drain(); assertRemoved(f);
  assert.equal(f.git(['rev-parse', 'refs/tags/archive/lane/topic']), f.head);
  assert.ok(effects(f).some(e => e.action === 'archive-created'));
});

test('a failed shell close retains its original native intent after a manual retry', t => {
  const f = setup(t, { terminal: true });
  f.state.failClose = true; f.save();
  f.drain(); assert.equal(fs.existsSync(f.lane), true);
  const entry = readCloseoutEntries(f.common).find(e => unresolvedCloseoutEffect(e, events(f)));
  assert.ok(entry); const retained = retainNativeOutcome(f, entry);
  const current = f.read(); current.failClose = false; fs.writeFileSync(f.file, JSON.stringify(current));
  retryCloseout({ cwd: f.repo, org: f.org, topic: 'topic', why: 'native close transport recovered', start: false });
  assert.deepEqual(f.drain().evaluated, []); retained();
  assert.equal(fs.existsSync(f.lane), true);
  assert.equal(f.read().actions.filter(a => a[0] === 'agent').length, 1);
  assert.equal(effects(f).filter(e => e.action === 'exit-observed').length, 1);
});

test('restart after worktree removal revalidates preservation and finishes branch/workspace separately', t => {
  const f = setup(t, { terminal: true });
  const [root] = JSON.parse(f.env.HERDR_TEST_SCRATCH_ROOTS), own = path.join(root, 'topic-review');
  fs.mkdirSync(own); fs.writeFileSync(path.join(own, 'result'), 'disposable');
  let refuse = 'worktree';
  const base = f.options.command;
  f.options.command = (exe, args, opt) => exe === 'git' && ((args.includes('-D') && refuse === 'branch') ||
    (args.includes('worktree') && args.includes('remove') && refuse === 'worktree')) ?
    { status: 1, stderr: 'injected branch deletion refusal', stdout: '' } : base(exe, args, opt);
  f.drain();
  assert.equal(fs.existsSync(f.lane), true);
  const discarded = effects(f).find(e => e.action === 'lane-preflight');
  assert.equal(fs.existsSync(discarded.evidence.directory), false, 'failed-removal duplicate was safely discarded');
  assert.equal(fs.existsSync(discarded.scratchManifest), false, 'fallback attempt was discarded with its duplicate evidence');
  assert.ok(fs.existsSync(own));
  refuse = 'branch';
  retryCloseout({ cwd: f.repo, org: f.org, topic: 'topic', why: 'worktree removal recovered', start: false });
  f.drain();
  assert.equal(fs.existsSync(f.lane), false);
  assert.equal(f.git(['rev-parse', 'lane/topic']), f.head);
  assert.ok(fs.existsSync(own), 'scratch survives partial Git removal');
  const interrupted = effects(f).findLast(e => e.action === 'lane-preflight');
  assert.equal(JSON.parse(fs.readFileSync(interrupted.scratchManifest)).phase, 'not-executed');
  assert.ok(effects(f).some(e => e.action === 'worktree-removed'));
  refuse = null;
  retryCloseout({ cwd: f.repo, org: f.org, topic: 'topic', why: 'branch deletion recovered', start: false });
  f.drain(); assertRemoved(f);
  assert.equal(fs.existsSync(own), false, 'queue recovery uses the guarded scratch sweep');
  const completed = effects(f).find(e => e.action === 'lane-removed');
  const manifest = assertFixtureScratch(completed.scratchManifest, f.env);
  assert.equal(manifest.phase, 'complete'); assert.equal(manifest.recovery.manifest, interrupted.scratchManifest);
  assert.equal(manifest.entries.find(entry => entry.path === own).disposition, 'removed');
  assert.equal(effects(f).filter(e => e.action === 'worktree-removed').length, 1);
  assert.equal(effects(f).filter(e => e.action === 'lane-preflight').length, 2, 'each preservation manifest retains its own receipt');
});

for (const [command, action, count] of [
  ['agent prompt', 'agent-exit-requested', 1],
  ['tab close', 'shell-close-requested', 2],
  ['workspace close', 'workspace-close-requested', 3],
]) test(`a lost ${command} reply retains its original intent despite physical effect and a manual retry`, t => {
  const f = setup(t, { terminal: true }), base = f.options.command;
  let lost = 0;
  f.options.command = (exe, args, opt) => {
    const result = base(exe, args, opt), key = args.slice(0, 2).join(' ');
    // Reach each stage with positively acknowledged prerequisites. Losing an
    // earlier reply must stop cleanup before it can attempt the next stage.
    if (exe === f.job.herdr && key === command) {
      lost++; return { ...result, status: 1, stderr: 'injected lost acknowledgement' };
    }
    return result;
  };
  f.drain();
  const entry = readCloseoutEntries(f.common).find(e => unresolvedCloseoutEffect(e, events(f)));
  assert.ok(entry);
  const intent = unresolvedCloseoutEffect(entry, events(f)), original = events(f), native = f.herdrCalls(), recorded = effects(f);
  assert.equal(lost, 1);
  assert.equal(intent.action, action);
  const physical = f.read(), workspace = command === 'workspace close';
  assert.deepEqual(physical.actions, [['agent', 'prompt', 'worker', '/quit'], ['tab', 'close', 'w:t'], ['workspace', 'close', 'w']].slice(0, count));
  assert.deepEqual(physical.agents, [], 'the original exit physically ran even when its reply was lost');
  assert.equal(physical.panes.length, command === 'agent prompt' ? 1 : 0);
  assert.equal(physical.workspaces.length, workspace ? 0 : 1);
  if (workspace) assertRemoved(f);
  else {
    assert.ok(fs.existsSync(f.lane), 'an unresolved session command keeps the worktree');
    assert.equal(f.git(['rev-parse', 'lane/topic']), f.head);
    assert.equal(recorded.some(e => e.action === 'lane-removed'), false);
  }
  const completed = e => action === 'agent-exit-requested' ? e.action === 'exit-observed' && e.pane === 'w:p' :
    e.action === 'closed' && (workspace ? e.workspace_id === 'w' : e.tab_id === 'w:t');
  assert.equal(recorded.some(completed), false, 'physical effect is not the original producer completion');
  const file = path.join(f.common, 'closeout/entries', entry.key + '.json'), bytes = fs.readFileSync(file);
  let nativeCalls = 0;
  f.options.command = (exe, args, opt) => {
    if (exe === f.job.herdr) nativeCalls++;
    return base(exe, args, opt);
  };
  retryCloseout({ cwd: f.repo, org: f.org, topic: 'topic', why: 'reconcile lost native replies', start: false });
  assert.deepEqual(f.drain().evaluated, []);
  assert.equal(nativeCalls, 0, 'a manual retry cannot read back or replay an unresolved native command');
  assert.deepEqual(unresolvedCloseoutEffect(entry, events(f)), intent);
  assert.deepEqual(events(f).slice(0, original.length), original);
  assert.deepEqual(f.herdrCalls(), native); assert.deepEqual(effects(f), recorded); assert.deepEqual(fs.readFileSync(file), bytes);
  assert.equal(evaluations(f).some(e => e.key === entry.key && e.completed), false);
  assert.deepEqual(f.read(), physical);
  assert.equal(fs.existsSync(f.lane), !workspace);
  const intentId = original.find(e => e.type === 'closeout.effect' && e.outcome === intent).effect;
  const waits = events(f).filter(e => e.type === 'closeout.waiting' && e.key === entry.key &&
    (e.waiting.defect || e.waiting.producers.some(p => p.kind === 'native-command' && p.intent === intentId)));
  assert.ok(waits.length > 0, 'the original pending or failed producer remains durably linked');
  for (const wait of waits) assert.notEqual(closeoutWaitState(wait, events(f)), 'complete');
});

test('queue ownership skips both scheduled retirement passes and promotion-owned cleanup', t => {
  const f = setup(t, { terminal: true }), logs = [];
  const release = retirementLock(retirementOwnerLock(f.common)); t.after(release);
  assert.equal(tidyFinishedTabs({ cwd: f.repo, org: f.org, command: () => { throw Error('must not launch tidy'); }, log: e => logs.push(e) }), true);
  const housekeeping = createHousekeeping({ cwd: f.repo, org: f.org, herdr: f.job.herdr, record: undefined,
    command: f.options.command, log: e => logs.push(e) });
  assert.deepEqual(housekeeping.tick({ resume: false }).close, []);
  assert.deepEqual(f.read().actions, []);
  assert.ok(logs.some(e => e.action === 'retirement-skipped'));
  assert.equal(logs.some(e => /sweep|retirement-consumed|promotion-cleanup-retried/.test(e.action)), false);
  assert.equal(finishCleanup(f.job, { outcome: 'promoted' }, f.queue()).cleanup.owner, 'closeout-queue');
});

test('finished-lane age counts worktrees once, including protected/kept lanes, from reconciliation', t => {
  const f = setup(t, { terminal: true }), source = events(f).find(e => e.type === 'promotion.reconciled');
  const snapshot = f.retirement(f.options).observe(), generatedAt = new Date(Date.parse(source.at) + 1800001).toISOString();
  const status = retirementStatus(snapshot, { generatedAt, worktrees: [{ worktree: f.lane, branch: 'lane/topic', tip: f.head }] });
  assert.equal(status.finishedLanesOpenOver30Minutes, 1);
  assert.match(renderRetirementStatus(status), /Finished lanes open longer than 30 min: 1/);
});

test('the closer is finite, has no timers or polling, and a second claim cannot evaluate targets', t => {
  const f = setup(t, { terminal: true });
  const source = fs.readFileSync(new URL('../lib/closeout-executor.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /\bset(?:Interval|Timeout)\s*\(|\bwhile\s*\(\s*(?:true|1)\s*\)|for\s*\(\s*;\s*;/);
  let second;
  f.drain({ onClaim: () => { second = f.drain(); } });
  assert.equal(second.already_running, true);
  assert.equal(fs.existsSync(path.join(f.common, 'closeout/consumer.lock')), false, 'consumer exits after drain');
  const calls = f.herdrCalls(); assert.deepEqual(f.drain().evaluated, []); assert.deepEqual(f.herdrCalls(), calls);
});

test('legacy housekeeping ownership stays held without a linked transfer completion after an explicit retry', t => {
  const f = setup(t, { terminal: true }), owner = path.join(f.org, 'housekeeping/default/lock/owner.json');
  fs.mkdirSync(path.dirname(owner), { recursive: true });
  fs.writeFileSync(owner, JSON.stringify({ cwd: f.repo, org: f.org, pid: process.pid }));
  f.drain(); assert.deepEqual(f.read().actions, []);
  assert.ok(evaluations(f).every(e => /ownership transfer/.test(e.reason)));
  fs.writeFileSync(owner, JSON.stringify({ cwd: f.repo, org: f.org, pid: process.pid, retirement_queue_protocol: 2 }));
  retryCloseout({ cwd: f.repo, org: f.org, topic: 'topic', why: 'legacy retirement stopped and inspected; adopted runtime restarted', start: false });
  assert.deepEqual(f.drain().evaluated, []);
  assert.equal(fs.existsSync(f.lane), true); assert.deepEqual(f.read().actions, []);
  assert.ok(evaluations(f).every(e => !e.completed && e.waiting.defect && !e.waiting.producers.length));
});

test('source publication recovery retains the original binding when the old worktree name has been recreated', t => {
  const f = setup(t, { occupied: false, terminal: true });
  const source = events(f).find(e => e.type === 'promotion.reconciled');
  const entry = readCloseoutEntries(f.common).find(e => e.signal === 'landed');
  fs.unlinkSync(path.join(f.common, 'closeout/entries', `${entry.key}.json`));
  f.git(['worktree', 'remove', f.lane]); f.git(['worktree', 'add', f.lane, 'lane/topic']);
  publishCloseoutEvents({ cwd: f.repo, org: f.org, added: [source], start: false });
  const recovered = readCloseoutEntries(f.common).find(e => e.signal === 'landed');
  assert.deepEqual(recovered.worktreeIdentity, entry.worktreeIdentity);
  f.drain(); assert.equal(fs.existsSync(f.lane), true);
  assert.ok(evaluations(f).some(e => /identity/.test(e.reason)));
});
