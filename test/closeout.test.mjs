import test from './helpers/bounded-test.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { exitFixture } from './helpers/retire-exit-fixture.mjs';
import { fixture, hold, isolatedEnv } from './helpers/retire-fixture.mjs';
import { sweepCommands } from './helpers/retire-sweep-fixture.mjs';
import { setTimeout as pause } from 'node:timers/promises';
import { loadTimeout } from '../lib/deadline.mjs';
import { loadEvents, transact } from '../lib/store.mjs';
import { fold } from '../lib/state.mjs';
import { fold as olderFold } from './fixtures/state-v0.mjs';
import { completionFingerprint } from '../lib/completion.mjs';
import { bindCloseoutSources, publishCloseoutEvents, readCloseoutEntries, readyLane, retryCloseout,
  closeoutPolicy, recordCompletedReview, retirementOwnerLock } from '../lib/closeout.mjs';
import { retirementLock } from '../lib/retire-lock.mjs';
import { drainCloseout } from '../lib/closeout-consumer.mjs';
import { createHousekeeping, tidyFinishedTabs } from '../housekeeping/housekeeping.mjs';
import { finishCleanup } from '../promote/promote.mjs';
import { retirementStatus, renderRetirementStatus } from '../lib/retire-status.mjs';

const cli = fileURLToPath(new URL('../bin/org.mjs', import.meta.url));
const closer = fileURLToPath(new URL('../supervisor/closeout.mjs', import.meta.url));
const lanes = fileURLToPath(new URL('../lanes/lane.mjs', import.meta.url));
const retirementCLI = fileURLToPath(new URL('../supervisor/retire.mjs', import.meta.url));
const events = f => loadEvents(f.org).events;
async function waitForChange(_files, predicate, { timeoutMs = 60000 } = {}) {
  const deadline = Date.now() + loadTimeout(timeoutMs);
  while (!predicate()) { if (Date.now() >= deadline) throw Error('bounded fixture observation timed out'); await pause(25); }
}
function setup(t, { occupied = true, merged = true, terminal = false } = {}) {
  const f = occupied ? exitFixture(t) : fixture(t, { occupied, merged });
  if (occupied && !merged) throw Error('use the Git-only fixture for an unintegrated target');
  isolatedEnv(t, f);
  fs.symlinkSync(f.org, path.join(f.repo, '.org'));
  fs.appendFileSync(path.join(f.common, 'info/exclude'), '\n.org\n.lane/\n');
  fs.writeFileSync(path.join(f.repo, '.lane.json'), JSON.stringify({ retirement: { closeout_queue: true } }));
  fs.writeFileSync(f.eventFile, events(f).filter(e => e.type !== 'item.closed' && e.type !== 'report.ingested').map(e => JSON.stringify(e) + '\n').join(''));
  const commands = sweepCommands(f);
  const options = { herdr: f.job.herdr, command: commands.command,
    readOwner: owner => (f.read().info?.process_tree ?? []).some(p => p.pid === owner.pid && p.identity === owner.identity) };
  f.append = add => {
    const result = transact(f.org, current => bindCloseoutSources({ cwd: f.repo, org: f.org, events: current, mutation: { add } }), { actor: 'fixture' });
    publishCloseoutEvents({ cwd: f.repo, org: f.org, added: result.added, start: false, env: f.env });
    return result.added;
  };
  f.options = options;
  f.drain = extra => drainCloseout({ cwd: f.repo, org: f.org, env: f.env, retirementOptions: options, ...extra });
  f.report = () => f.append([{ type: 'report.ingested', run: 'R-1', report: { outcome: 'done', summary: 'Complete' }, sha256: 'fixture' }]);
  f.land = () => f.append([{ type: 'item.closed', id: 'ENG-1', as: 'done' }, {
    type: 'promotion.reconciled', identity: f.common, batch: 'fixture', tip: f.head,
    heads: [{ run: 'R-1', item: 'ENG-1', head: f.head }], runs: ['R-1'], items: ['ENG-1'],
  }]);
  if (terminal) { f.report(); f.land(); }
  return f;
}
const evaluations = f => events(f).filter(e => e.type === 'closeout.evaluated');
const effects = f => events(f).filter(e => e.type === 'closeout.effect').map(e => e.outcome);
function assertRemoved(f) {
  assert.equal(fs.existsSync(f.lane), false);
  assert.equal(f.git(['branch', '--list', 'lane/topic']), '');
  assert.deepEqual(f.read().workspaces, []);
  assert.ok(effects(f).some(e => e.action === 'lane-removed'));
}

test('default off is inert, malformed policy keeps, and a lane copy cannot opt in its project', t => {
  const f = fixture(t, { occupied: false });
  assert.equal(closeoutPolicy(f.repo), false);
  fs.writeFileSync(path.join(f.lane, '.lane.json'), '{"retirement":{"closeout_queue":true}}');
  assert.deepEqual(publishCloseoutEvents({ cwd: f.lane, org: f.org, added: events(f) }), []);
  assert.deepEqual(readCloseoutEntries(f.common), []);
  fs.writeFileSync(path.join(f.repo, '.lane.json'), '{"retirement":{"closeout_queue":"yes"}}');
  assert.throws(() => closeoutPolicy(f.repo), /invalid/);
});

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
  assert.ok(evaluations(f).some(e => !e.completed && e.waiting.event === 'target-record-changed'));
  const count = evaluations(f).length;
  f.drain(); assert.equal(evaluations(f).length, count, 'no rescan without a resolving revision');
});

for (const project of ['bch-cloak', 'herdr-brain']) test(`${project}: a landed event immediately releases and removes its exact lane, branch and empty workspace`, t => {
  const f = setup(t, { terminal: true });
  fs.mkdirSync(path.join(f.lane, '.lane'));
  fs.writeFileSync(path.join(f.lane, '.lane/evidence'), 'unique report and scratch\n');
  const landed = readCloseoutEntries(f.common).find(e => e.signal === 'landed');
  assert.equal(landed.source.type, 'promotion.reconciled');
  f.drain(); assertRemoved(f);
  const actions = effects(f).map(e => e.action);
  for (const action of ['exit-observed', 'closed', 'lane-preflight', 'worktree-removed', 'branch-removed', 'lane-removed']) assert.ok(actions.includes(action), action);
  const proof = effects(f).find(e => e.action === 'lane-preflight');
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
  if (abandoned) assert.ok(events(f).some(e => e.type === 'retirement.release' && e.run === 'R-1'));
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

test('HOLD stays deferred with a named resolving event; explicit removal retry re-enqueues and closes', t => {
  const f = setup(t, { terminal: true }), releaseHold = hold(f);
  f.drain();
  assert.deepEqual(f.read().actions, []);
  assert.ok(evaluations(f).every(e => !e.completed && e.waiting.event === 'hold-removed'));
  releaseHold();
  const before = evaluations(f).length;
  f.drain(); assert.equal(evaluations(f).length, before, 'removing an unobservable file is not an implicit poll');
  retryCloseout({ cwd: f.repo, org: f.org, topic: 'topic', why: 'hold-removed', start: false });
  f.drain(); assertRemoved(f);
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
  assert.ok(evaluations(f).every(e => !e.completed && e.reason && e.waiting.retry));
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
    { type: 'report.ingested', run: 'R-2', report: { outcome: 'done' } }, { type: 'item.closed', id: 'ENG-2', as: 'done' },
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

test('restart after agent exit and a failed shell close resumes the shell without sending exit twice', t => {
  const f = setup(t, { terminal: true });
  f.state.failClose = true; f.save();
  f.drain(); assert.equal(fs.existsSync(f.lane), true);
  const current = f.read(); current.failClose = false; fs.writeFileSync(f.file, JSON.stringify(current));
  retryCloseout({ cwd: f.repo, org: f.org, topic: 'topic', why: 'native close transport recovered', start: false });
  f.drain(); assertRemoved(f);
  assert.equal(f.read().actions.filter(a => a[0] === 'agent').length, 1);
  assert.equal(effects(f).filter(e => e.action === 'exit-observed').length, 1);
});

test('restart after worktree removal revalidates preservation and finishes branch/workspace separately', t => {
  const f = setup(t, { terminal: true });
  let refuse = 'worktree';
  const base = f.options.command;
  f.options.command = (exe, args, opt) => exe === 'git' && ((args.includes('-D') && refuse === 'branch') ||
    (args.includes('worktree') && args.includes('remove') && refuse === 'worktree')) ?
    { status: 1, stderr: 'injected branch deletion refusal', stdout: '' } : base(exe, args, opt);
  f.drain();
  assert.equal(fs.existsSync(f.lane), true);
  const discarded = effects(f).find(e => e.action === 'lane-preflight');
  assert.equal(fs.existsSync(discarded.evidence.directory), false, 'failed-removal duplicate was safely discarded');
  refuse = 'branch';
  retryCloseout({ cwd: f.repo, org: f.org, topic: 'topic', why: 'worktree removal recovered', start: false });
  f.drain();
  assert.equal(fs.existsSync(f.lane), false);
  assert.equal(f.git(['rev-parse', 'lane/topic']), f.head);
  assert.ok(effects(f).some(e => e.action === 'worktree-removed'));
  refuse = null;
  retryCloseout({ cwd: f.repo, org: f.org, topic: 'topic', why: 'branch deletion recovered', start: false });
  f.drain(); assertRemoved(f);
  assert.equal(effects(f).filter(e => e.action === 'worktree-removed').length, 1);
  assert.equal(effects(f).filter(e => e.action === 'lane-preflight').length, 2, 'each preservation manifest retains its own receipt');
});

test('lost native exit, shell-close and workspace-close replies reconcile exact identity without repeating effects', t => {
  const f = setup(t, { terminal: true }), base = f.options.command, lost = new Set();
  f.options.command = (exe, args, opt) => {
    const result = base(exe, args, opt), key = args.slice(0, 2).join(' ');
    if (exe === f.job.herdr && ['agent prompt', 'tab close', 'workspace close'].includes(key) && !lost.has(key)) {
      lost.add(key); return { ...result, status: 1, stderr: 'injected lost acknowledgement' };
    }
    return result;
  };
  f.drain();
  retryCloseout({ cwd: f.repo, org: f.org, topic: 'topic', why: 'reconcile lost native replies', start: false });
  f.drain(); assertRemoved(f);
  assert.deepEqual(f.read().actions, [['agent', 'prompt', 'worker', '/quit'], ['tab', 'close', 'w:t'], ['workspace', 'close', 'w']]);
  assert.ok(effects(f).some(e => e.action === 'closed' && e.tab_id === 'w:t' && e.reconciled));
  assert.ok(effects(f).some(e => e.action === 'closed' && e.workspace_id === 'w' && e.reconciled));
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
  const source = fs.readFileSync(new URL('../lib/closeout-consumer.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /\bset(?:Interval|Timeout)\s*\(|\bwhile\s*\(|for\s*\(\s*;\s*;/);
  let second;
  f.drain({ onClaim: () => { second = f.drain(); } });
  assert.equal(second.already_running, true);
  assert.equal(fs.existsSync(path.join(f.common, 'closeout/consumer.lock')), false, 'consumer exits after drain');
});

test('activation refuses legacy housekeeping ownership until inspected replacement and an explicit retry', t => {
  const f = setup(t, { terminal: true }), owner = path.join(f.org, 'housekeeping/default/lock/owner.json');
  fs.mkdirSync(path.dirname(owner), { recursive: true });
  fs.writeFileSync(owner, JSON.stringify({ cwd: f.repo, org: f.org, pid: process.pid }));
  f.drain(); assert.deepEqual(f.read().actions, []);
  assert.ok(evaluations(f).every(e => /ownership transfer/.test(e.reason)));
  fs.writeFileSync(owner, JSON.stringify({ cwd: f.repo, org: f.org, pid: process.pid, retirement_queue_protocol: 1 }));
  retryCloseout({ cwd: f.repo, org: f.org, topic: 'topic', why: 'legacy retirement stopped and inspected; adopted runtime restarted', start: false });
  f.drain(); assertRemoved(f);
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

test('a report on disk is inert; the actual ingest CLI carries the same optional ready signal', async t => {
  const f = setup(t), file = path.join(f.scratch, 'report.md');
  fs.writeFileSync(file, '---\nrun: R-1\noutcome: done\nsummary: Complete.\nheadline: The change is complete.\nblockers: []\nproposals: []\nlearnings: []\nartifacts: []\ndecisions: []\nquestions: []\nchallenges: []\n---\n');
  assert.deepEqual(readCloseoutEntries(f.common), []);
  readyLane({ cwd: f.repo, org: f.org, topic: 'topic', start: false });
  const result = spawnSync(process.execPath, [cli, 'ingest', file], { cwd: f.repo, env: f.env, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  await waitForChange([f.eventFile], () => evaluations(f).length && !fs.existsSync(path.join(f.common, 'closeout/consumer.lock')), { timeoutMs: 60000 });
  assert.equal(readCloseoutEntries(f.common).length, 1);
  assert.deepEqual(f.read().actions, []);
  assert.equal(events(f).filter(e => e.type === 'report.ingested').length, 1);
});

test('record complete-batch alone produces a landed entry and closes without supervisor, manual release or sweep', async t => {
  const f = setup(t); f.report();
  const gate = path.join(f.scratch, 'gate.log'); fs.writeFileSync(gate, 'offline accepted gate\n');
  const plan = { version: 1, org: f.org, batch: 'bch-eng-1661', identity: f.common, base: f.head, tip: f.head,
    prepared_seq: events(f).at(-1).seq,
    gate: { exit_code: 0, log: gate, sha256: createHash('sha256').update(fs.readFileSync(gate)).digest('hex') },
    items: [{ item: 'ENG-1', run: 'R-1', head: f.head, expected: completionFingerprint(fold(events(f)), 'ENG-1'), why: 'accepted', superseded: [] }], excluded: [] };
  const file = path.join(f.scratch, 'completion.json'); fs.writeFileSync(file, JSON.stringify(plan));
  const result = spawnSync(process.execPath, [cli, 'complete-batch', '--file', file], { cwd: f.repo, env: f.env, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  await waitForChange([f.eventFile], () => effects(f).some(e => e.action === 'lane-removed') && !fs.existsSync(path.join(f.common, 'closeout/consumer.lock')),
    { timeoutMs: 60000 });
  assertRemoved(f);
  assert.equal(events(f).find(e => e.type === 'item.closed').as, 'done');
  assert.deepEqual(f.read().actions, [['agent', 'prompt', 'worker', '/quit'], ['tab', 'close', 'w:t'], ['workspace', 'close', 'w']]);
});

test('named manual recovery records a fresh bound request for a legacy lane without a landed queue entry', async t => {
  const f = setup(t); f.report(); f.append([{ type: 'item.closed', id: 'ENG-1', as: 'done' }]);
  assert.equal(readCloseoutEntries(f.common).some(e => e.signal === 'landed'), false);
  const result = spawnSync(process.execPath, [retirementCLI, 'sweep', '--lane', f.lane, '--repo', f.repo, '--org', f.org], { cwd: f.repo, env: f.env, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  await waitForChange([f.eventFile], () => effects(f).some(e => e.action === 'lane-removed') && !fs.existsSync(path.join(f.common, 'closeout/consumer.lock')), { timeoutMs: 60000 });
  assertRemoved(f);
  assert.equal(readCloseoutEntries(f.common).find(e => e.signal === 'landed').source.type, 'lane.recovery-requested');
});

function child(exe, args, options) {
  return new Promise((resolve, reject) => {
    const c = spawn(exe, args, options); let stdout = '', stderr = '';
    c.stdout.on('data', d => { stdout += d; }); c.stderr.on('data', d => { stderr += d; });
    c.once('error', reject); c.once('close', status => resolve({ status, stdout, stderr }));
  });
}

test('two concurrent ready enqueues bind one entry and one live closer; shutdown enqueue is not stranded', async t => {
  const f = setup(t), stop = hold(f); f.report(); f.land();
  f.state.delayWorkspace = 25; f.save();
  const results = await Promise.all([1, 2].map(() => child(process.execPath, [lanes, 'ready', 'topic'], { cwd: f.repo, env: f.env })));
  for (const result of results) assert.equal(result.status, 0, result.stdout + result.stderr);
  await waitForChange([f.eventFile], () => evaluations(f).length && !fs.existsSync(path.join(f.common, 'closeout/consumer.lock')), { timeoutMs: 60000 });
  assert.equal(readCloseoutEntries(f.common).filter(e => e.signal === 'ready').length, 1);
  // A retry arrives at the atomic empty-exit handoff. It must get either this
  // consumer or a newly claimed consumer; it cannot disappear between them.
  let wake;
  f.drain({ beforeExit: () => { stop(); wake = child(process.execPath, [closer, 'retry', 'topic', '--why', 'hold-removed'], { cwd: f.repo, env: f.env }); } });
  const result = await wake; assert.equal(result.status, 0, result.stdout + result.stderr);
  await waitForChange([f.eventFile], () => effects(f).some(e => e.action === 'lane-removed') && !fs.existsSync(path.join(f.common, 'closeout/consumer.lock')), { timeoutMs: 60000 });
  assertRemoved(f);
  assert.equal(f.read().actions.filter(a => a[0] === 'agent').length, 1);
});
