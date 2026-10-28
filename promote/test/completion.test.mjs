import test from '../../test/helpers/bounded-test.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { reconcileBatchCompletion } from '../completion.mjs';
import { loadTimeout } from '../../lib/deadline.mjs';
import { completionFingerprint } from '../../lib/completion.mjs';
import { acquireLock } from '../../lanes/promotion-lock.mjs';
import { fold } from '../../lib/state.mjs';
import { fold as mainFold } from '../../test/fixtures/state-pre-session-bind.mjs';
import { effectiveWorkerIdentity } from '../../lib/worker-identity.mjs';
import { spawnScenarioChild, waitForExit } from '../../test/helpers/child.mjs';
import { watchPromotionLock } from '../../test/helpers/promotion-lock.mjs';
import { fixture, source } from './completion-fixture.mjs';

test('promotion claim checks keep supervisor cycle modules out of the lane static import graph', () => {
  // Ask Node's parser for static dependencies without evaluating any module.
  // This includes re-exports and multiline imports and stops at lazy loads.
  const roots = ['lib/run-owner-guard.mjs', 'promote/train.mjs', 'promote/completion.mjs', 'promote/guard.mjs', 'lanes/lane.mjs'];
  const probe = `import fs from 'node:fs';import path from 'node:path';import vm from 'node:vm';
import {pathToFileURL,fileURLToPath} from 'node:url';
const root=${JSON.stringify(source)},cache=new Map();
function dependencies(file){if(!cache.has(file))cache.set(file,new vm.SourceTextModule(fs.readFileSync(file,'utf8')).dependencySpecifiers.filter(s=>s.startsWith('.')).map(s=>fileURLToPath(new URL(s,pathToFileURL(file)))));return cache.get(file);}
const result={};for(const entry of ${JSON.stringify(roots)}){const seen=new Set(),pending=[path.join(root,entry)];while(pending.length){const file=pending.pop();if(seen.has(file))continue;seen.add(file);pending.push(...dependencies(file));}result[entry]=[...seen].map(f=>path.relative(root,f)).sort();}
console.log(JSON.stringify(result));`;
  const reply = spawnSync(process.execPath, ['--experimental-vm-modules', '--input-type=module', '-e', probe], { encoding: 'utf8' });
  assert.equal(reply.status, 0, reply.stderr);
  const closures = JSON.parse(reply.stdout);
  for (const root of roots) {
    const closure = closures[root];
    // clean-pass is the existing guard's scope helper, not the notice cycle.
    const expected = ['promote/train.mjs', 'promote/guard.mjs', 'lanes/lane.mjs'].includes(root) ? ['supervisor/clean-pass.mjs'] : [];
    assert.deepEqual(closure.filter(f => f.startsWith('supervisor/')), expected, root);
    assert.ok(!closure.includes('lib/run-owner.mjs'), root);
    assert.ok(!closure.includes('promote/promote.mjs'), root);
    if (root !== 'promote/guard.mjs') assert.ok(closure.includes('lib/run-owner-guard.mjs'), root);
  }
});

test('worker receipt and session bind preserve main run bytes and completion fingerprints', () => {
  const meta = { dispatch_attempt: 'attempt', dispatch_journal: '/repo/.org/dispatch/attempt.json',
    dispatch_project: '/repo/.git', dispatch_record: '/repo/.org' };
  const worker = { agent: 'worker', pane: 'w:p', worker_workspace: 'w', terminal_id: 'terminal' };
  const events = [
    { type: 'item.added', id: 'ENG-1', title: 'Stable completion', role: 'engineer' },
    { type: 'run.started', id: 'R-1', item: 'ENG-1', workspace: '/repo/lane', meta },
    { type: 'run.updated', id: 'R-1', meta: worker },
    { type: 'run.session_bound', run: 'R-1', session: 'late-session',
      dispatch: { attempt: meta.dispatch_attempt, journal: meta.dispatch_journal, project: meta.dispatch_project, record: meta.dispatch_record },
      receipt: { run: 'R-1', started_seq: 2, seq: 3, cwd: '/repo/lane', ...worker }, process: { pid: 123, identity: 'native birth' },
      prompted_at: '2026-10-17T20:00:00Z', observed_at: '2026-10-17T20:00:01Z', deadline: '2026-10-17T20:01:00Z' },
    { type: 'report.ingested', run: 'R-1', report: { outcome: 'done', summary: 'Completed' }, sha256: 'immutable' },
  ].map((e, i) => ({ ...e, seq: i + 1, at: '2026-10-17T20:00:01Z', by: 'fixture' }));
  const state = fold(events), baseline = mainFold(events), run = state.runs.get('R-1');
  assert.equal(JSON.stringify(run), JSON.stringify(baseline.runs.get('R-1')));
  assert.equal(completionFingerprint(state, 'ENG-1'), completionFingerprint(baseline, 'ENG-1'));
  assert.equal(effectiveWorkerIdentity(run, state).agent_session_id, 'late-session');
  // The oracle must detect the R-492 regression: those fields were on runs.
  const regressed = mainFold(events);
  Object.assign(regressed.runs.get('R-1'), { worker_receipt: state.workerReceipts.get('R-1'), session_bindings: state.sessionBindings.get('R-1') });
  assert.notEqual(JSON.stringify(regressed.runs.get('R-1')), JSON.stringify(run));
  assert.notEqual(completionFingerprint(regressed, 'ENG-1'), completionFingerprint(baseline, 'ENG-1'));
});

test('completion fixture delivers through a loaded quiet-confirmation window', async t => {
  // Model slow native reads against a small base window without adding host
  // load or waiting ten seconds for every unsuccessful drain pass.
  const f = fixture(t, { inputWaitMs: 10, inputAllowance: ms => loadTimeout(ms * 500),
    recipientDelayMs: 300, noticeWaitMs: 3000 });
  const member = f.lane('loaded');
  f.drain();
  await f.waitForNotices();
  assert.equal(f.gates(), 1);
  assert.equal(f.show(member.item).closed.as, 'done');
  assert.equal(fs.existsSync(member.workspace), false);
});


for (const size of [1, 3]) test(`native ${size}-member batch reconciles atomically before cleanup and duplicate recovery`, t => {
  const f = fixture(t); for (let i = 0; i < size; i++) f.lane(`lane-${i}`);
  f.drain(); assert.equal(f.gates(), 1);
  const rows = f.queue.load().results;
  assert.equal(rows.length, size);
  assert.ok(rows.every(row => row.delivered === true), 'completion notices reach the quiet scratch terminal before teardown');
  for (const m of f.members) { assert.equal(f.show(m.item).closed.as, 'done'); assert.equal(fs.existsSync(m.workspace), false, JSON.stringify({ queue: f.queue.load(), closeout: f.events().filter(e => e.type.startsWith('closeout.')) })); }
  assert.ok(rows.every(r => r.reconciliation.state === 'complete'));
  const events = f.events(), markers = events.filter(e => e.type === 'promotion.reconciled');
  assert.equal(markers.length, 1); assert.equal(markers[0].items.length, size);
  const velocity = events.filter(e => e.type === 'note.added' && e.text.startsWith('Promotion: report-to-main'));
  assert.ok(velocity.every(e => e.seq > markers[0].seq), 'even pre-cleanup telemetry follows whole-batch reconciliation');
  const before = fs.readFileSync(path.join(f.org, 'events.jsonl'), 'utf8');
  const replay = reconcileBatchCompletion({ project: f.queue.project, jobs: rows, results: rows.map(job => ({ job, result: job })) });
  assert.equal(replay.pending, false); assert.equal(replay.results[0].result.reconciliation.replayed, true);
  assert.equal(fs.readFileSync(path.join(f.org, 'events.jsonl'), 'utf8'), before);
  f.drain(); assert.equal(f.gates(), 1);
});

test('record-bound enqueue completes while a real drain gates another member without lock inversion', async t => {
  const f = fixture(t), first = f.lane('first');
  const gating = path.join(f.root, 'gating'), release = path.join(f.root, 'release-gate');
  fs.writeFileSync(f.checker, `const fs=require('fs');fs.appendFileSync(${JSON.stringify(path.join(f.root, 'gates'))},'gate\\n');
fs.writeFileSync(${JSON.stringify(gating)},'ready');const until=Date.now()+60000;
while(!fs.existsSync(${JSON.stringify(release)})){if(Date.now()>until)throw Error('gate barrier timed out');Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,10);}
console.log('# tests 1');`);
  const child = spawnScenarioChild(t, process.execPath, [path.join(source, 'promote/promote.mjs'), '--drain'], { cwd: f.repo, env: f.env });
  const completed = waitForExit(child);
  let second, reply;
  try {
    const until = Date.now() + loadTimeout(30000);
    while (!fs.existsSync(gating)) {
      assert.ok(Date.now() < until, 'drain reached the bounded gate barrier');
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    // Both record writes and admission run while the drain owns its worker lock.
    second = f.lane('second');
    assert.ok(f.queue.load().pending.some(job => job.id === second.job.id));
    assert.equal(f.queue.load().pending.find(job => job.id === second.job.id).admittedSeq, f.events().at(-1).seq);
  } finally {
    fs.writeFileSync(release, 'continue');
    reply = await completed;
  }
  assert.equal(reply.code, 0, reply.stderr || reply.stdout);
  assert.equal(f.gates(), 2);
  for (const member of [first, second]) assert.equal(f.show(member.item).closed.as, 'done');
  assert.ok(f.queue.load().results.every(result => result.reconciliation.state === 'complete'));
});

test('integrated record refusal retains every lane and resumes records after a closeout holder without another gate', async t => {
  const f = fixture(t); const first = f.lane('first'), second = f.lane('second');
  fs.writeFileSync(f.fault, 'refuse'); f.drain();
  assert.equal(f.gates(), 1); assert.equal((f.queue.load().interrupted ?? []).length, 1);
  for (const m of [first, second]) { assert.equal(f.show(m.item).closed, null); assert.ok(fs.existsSync(m.workspace)); }
  assert.ok(f.queue.load().results.every(r => r.reconciliation.state === 'pending'));
  const receipt = f.queue.load().results[0].receipt, log = fs.readFileSync(f.queue.load().results[0].log, 'utf8');
  const proof = JSON.parse(fs.readFileSync(receipt));
  fs.unlinkSync(f.fault);
  const lock = path.join(f.queue.project.identity, 'lane-promote.lock'), release = acquireLock(lock);
  const owner = fs.readFileSync(path.join(lock, 'owner.json'), 'utf8');
  const waiting = watchPromotionLock(f.root, f.env, lock);
  const child = spawnScenarioChild(t, process.execPath, [path.join(source, 'promote/promote.mjs'), '--drain'], { cwd: f.repo, env: f.env });
  const done = waitForExit(child);
  try {
    const until = Date.now() + loadTimeout(10000);
    while (!fs.existsSync(waiting)) {
      assert.ok(Date.now() < until, 'completion reached the held lifecycle lock');
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert.equal(child.exitCode, null);
    assert.equal(fs.readFileSync(path.join(lock, 'owner.json'), 'utf8'), owner);
    assert.equal(f.gates(), 1);
  } finally { release(); await done; }
  const reply = await done; assert.equal(reply.code, 0, reply.stderr);
  assert.equal(f.gates(), 1);
  assert.equal(fs.readFileSync(f.queue.load().results[0].log, 'utf8'), log);
  assert.deepEqual(JSON.parse(fs.readFileSync(receipt)).attempts, proof.attempts);
  for (const m of [first, second]) { assert.equal(f.show(m.item).closed.as, 'done'); assert.equal(fs.existsSync(m.workspace), false); }
  assert.equal(f.events().filter(e => e.type === 'promotion.reconciled').length, 1);
  assert.equal((f.queue.load().interrupted ?? []).length, 0);
});

test('completed train ownership fence retains integrated proof and refuses record completion until its binding is restored', t => {
  const f = fixture(t), first = f.lane('first'), second = f.lane('second');
  fs.writeFileSync(f.fault, 'refuse'); f.drain();
  assert.equal(f.gates(), 1);
  const receipt = f.queue.load().results[0].receipt, proof = fs.readFileSync(receipt, 'utf8');
  const recordReceipt = fs.readFileSync(receipt + '.record.json', 'utf8');
  const original = structuredClone(f.queue.load().interrupted[0].jobs.find(j => j.id === first.job.id).ownership);
  assert.ok(JSON.parse(proof).attempts.some(a => a.phase === 'complete' && a.gate.exit_code === 0));
  fs.unlinkSync(f.fault);
  f.queue.transaction(data => { data.interrupted[0].jobs.find(j => j.id === first.job.id).ownership.generation++; });
  f.drain();
  assert.equal(f.gates(), 1); assert.equal(fs.readFileSync(receipt, 'utf8'), proof);
  assert.equal(fs.readFileSync(receipt + '.record.json', 'utf8'), recordReceipt);
  assert.equal(f.events().filter(e => e.type === 'promotion.reconciled').length, 0);
  for (const m of [first, second]) { assert.equal(f.show(m.item).closed, null); assert.ok(fs.existsSync(m.workspace)); }
  assert.ok(f.queue.load().results.slice(-2).every(r => r.reconciliation.state === 'pending' && /RUN_OWNED_ELSEWHERE/.test(r.reason)));
  // The exact original binding resumes only reconciliation and cleanup.
  f.queue.transaction(data => { data.interrupted[0].jobs.find(j => j.id === first.job.id).ownership = original; });
  f.drain(); assert.equal(f.gates(), 1);
  assert.equal(f.events().filter(e => e.type === 'promotion.reconciled').length, 1);
  assert.deepEqual(JSON.parse(fs.readFileSync(receipt)).attempts, JSON.parse(proof).attempts);
  for (const m of [first, second]) assert.equal(f.show(m.item).closed.as, 'done');
});

test('bisected batch accounts for its exclusion without mutating newer excluded work', t => {
  const f = fixture(t), first = f.lane('first'), second = f.lane('second'), bad = f.lane('broken', true);
  fs.writeFileSync(f.fault, 'refuse'); f.drain(); assert.equal(f.gates(), 3);
  f.record(['start', bad.item, '--workspace', bad.workspace]);
  f.record(['note', bad.item, 'New excluded correction is underway']);
  const excluded = f.show(bad.item);
  fs.unlinkSync(f.fault); f.drain(); assert.equal(f.gates(), 3);
  assert.deepEqual(f.show(bad.item), excluded); assert.ok(fs.existsSync(bad.workspace));
  for (const m of [first, second]) { assert.equal(f.show(m.item).closed.as, 'done'); assert.equal(fs.existsSync(m.workspace), false); }
  const marker = f.events().find(e => e.type === 'promotion.reconciled');
  assert.deepEqual(marker.excluded, [bad.item]); assert.equal(marker.historical_exclusions[0].run, bad.run);
});

for (const change of ['new-run', 'blocker', 'missing-member']) test(`recovery refuses ${change} and retains all integrated lanes`, t => {
  const f = fixture(t), first = f.lane('first'), second = f.lane('second');
  fs.writeFileSync(f.fault, 'refuse'); f.drain(); const gates = f.gates(); fs.unlinkSync(f.fault);
  if (change === 'new-run') f.recover(first, ['start', first.item, '--workspace', first.workspace]);
  if (change === 'blocker') f.recover(first, ['ask', 'Reserved decision?', '--parent', first.item, '--category', 'design', '--recommend', 'yes', '--why', 'Need operator decision', '--blocks', first.item, '--wait']);
  if (change === 'missing-member') {
    const receipt = f.queue.load().results[0].receipt, plan = JSON.parse(fs.readFileSync(receipt));
    plan.completion.jobs.pop(); fs.writeFileSync(receipt, JSON.stringify(plan));
  }
  f.drain(); assert.equal(f.gates(), gates);
  for (const m of [first, second]) { assert.equal(f.show(m.item).closed, null); assert.ok(fs.existsSync(m.workspace)); }
  assert.equal(f.events().filter(e => e.type === 'promotion.reconciled').length, 0);
  assert.equal((f.queue.load().interrupted ?? []).length, 1);
});


test('lost record acknowledgement replays the receipt before cleanup without repeating the gate or completion events', t => {
  const f = fixture(t), first = f.lane('first'), second = f.lane('second');
  fs.writeFileSync(f.fault, 'lost-ack'); f.drain();
  assert.equal(f.gates(), 1); assert.equal(f.events().filter(e => e.type === 'promotion.reconciled').length, 1);
  for (const m of [first, second]) { assert.equal(f.show(m.item).closed.as, 'done'); assert.ok(fs.existsSync(m.workspace)); }
  const receipt = f.queue.load().results[0].receipt + '.record.json', bytes = fs.readFileSync(receipt, 'utf8');
  fs.unlinkSync(f.fault); f.drain();
  assert.equal(f.gates(), 1); assert.equal(fs.readFileSync(receipt, 'utf8'), bytes);
  assert.equal(f.events().filter(e => e.type === 'promotion.reconciled').length, 1);
  assert.ok(f.queue.load().results.slice(-2).every(r => r.reconciliation.replayed));
  for (const m of [first, second]) assert.equal(fs.existsSync(m.workspace), false);
});
