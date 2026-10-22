import test from '../../test/helpers/bounded-test.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { enqueue } from '../promote.mjs';
import { reconcileBatchCompletion, recordedBatchCompletion } from '../completion.mjs';
import { loadTimeout } from '../../lib/deadline.mjs';
import { receiptDirectory } from '../../supervisor/context.mjs';
import { reconcile } from '../../supervisor/reconcile.mjs';
import { withPromotionGuards } from '../guard.mjs';
import { completionFingerprint } from '../../lib/completion.mjs';
import { acquireLock } from '../../lanes/promotion-lock.mjs';
import { fold } from '../../lib/state.mjs';
import { fold as mainFold } from '../../test/fixtures/state-pre-session-bind.mjs';
import { effectiveWorkerIdentity } from '../../lib/worker-identity.mjs';
import { spawnScenarioChild, waitForExit } from '../../test/helpers/child.mjs';
import { runTrain } from '../train.mjs';
import { resolveValidation } from '../../lanes/validation.mjs';
import { watchPromotionLock } from '../../test/helpers/promotion-lock.mjs';

import { fixture, source, manualRecovery } from './completion-fixture.mjs';

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


for (const size of [1, 3]) test(`native ${size}-member batch reconciles atomically before cleanup and duplicate recovery`, t => {
  const f = fixture(t); for (let i = 0; i < size; i++) f.lane(`lane-${i}`);
  f.drain(); assert.equal(f.gates(), 1);
  const rows = f.queue.load().results;
  assert.equal(rows.length, size);
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


for (const mode of ['operator-reserved', 'human']) test(`native completion refuses ${mode} work before gating or integration`, t => {
  const f = fixture(t), member = f.lane('reserved'), base = f.git(['rev-parse', 'main']);
  f.recover(member, ['set', member.item, mode === 'human' ? 'role=human' : 'meta.operator_reserved=true']);
  f.drain(); assert.equal(f.gates(), 0); assert.equal(f.git(['rev-parse', 'main']), base);
  assert.ok(fs.existsSync(member.workspace)); assert.equal(f.show(member.item).closed, null);
  assert.equal(f.queue.load().results[0].outcome, 'refused');
  assert.match(f.queue.load().results[0].reason, /not ordinary authorized work/);
});


function rewriteJob(f, member, changes) {
  f.queue.transaction(data => Object.assign(data.pending.find(j => j.id === member.job.id), changes));
}

for (const mode of ['unknown-run', 'wrong-record', 'duplicate-item']) test(`native admission isolates ${mode} while valid members reconcile`, t => {
  const f = fixture(t), first = f.lane('first'), bad = f.lane('invalid'), second = f.lane('second');
  if (mode === 'unknown-run') rewriteJob(f, bad, { run: 'R-99999' });
  if (mode === 'wrong-record') {
    const wrong = path.join(f.root, 'wrong-record'); f.record(['init', wrong]);
    rewriteJob(f, bad, { org: wrong });
  }
  if (mode === 'duplicate-item') rewriteJob(f, bad, { run: first.run });
  f.drain(); assert.equal(f.gates(), 1); assert.equal((f.queue.load().interrupted ?? []).length, 0);
  const rows = f.queue.load().results;
  assert.equal(rows.find(r => r.id === bad.job.id).outcome, 'refused');
  if (mode === 'wrong-record') assert.match(rows.find(r => r.id === bad.job.id).reason, /queue record differs from canonical project record/);
  assert.ok(fs.existsSync(bad.workspace)); assert.equal(f.show(bad.item).closed, null);
  for (const m of [first, second]) { assert.equal(f.show(m.item).closed.as, 'done'); assert.equal(fs.existsSync(m.workspace), false); }
  assert.deepEqual(f.events().find(e => e.type === 'promotion.reconciled').items, [first.item, second.item]);
  f.drain(); assert.equal(f.gates(), 1);
});

const ownershipRefusals = ['unclaimed', 'other-owner', 'stale-generation', 'missing-binding'];
function corruptOwnership(f, member, mode, expected) {
  const job = f.queue.load().pending.find(j => j.id === member.job.id);
  const ownership = mode === 'unclaimed' ? expected : structuredClone(job.ownership);
  if (mode === 'other-owner') ownership.owner.controller = 'other';
  if (mode === 'stale-generation') ownership.generation++;
  // An unclaimed legacy admission rewritten to claim a Brain binding must
  // refuse, just like a queued binding whose owner or generation is stale.
  rewriteJob(f, member, { ownership: mode === 'missing-binding' ? undefined : ownership });
}

for (const mode of ownershipRefusals) test(`native admission isolates ${mode} ownership while valid members reconcile`, t => {
  const f = fixture(t), first = f.lane('first'), bad = f.lane('invalid', false, { owned: mode !== 'unclaimed' }), second = f.lane('second');
  corruptOwnership(f, bad, mode, f.queue.load().pending[0].ownership);
  f.drain(); assert.equal(f.gates(), 1); assert.equal((f.queue.load().interrupted ?? []).length, 0);
  const rows = f.queue.load().results, refused = rows.find(r => r.id === bad.job.id);
  assert.equal(refused.outcome, 'refused');
  assert.equal(refused.code, mode === 'unclaimed' ? 'RUN_OWNER_UNCLAIMED' : 'RUN_OWNED_ELSEWHERE');
  assert.match(refused.reason, new RegExp(mode === 'unclaimed' ? 'RUN_OWNER_UNCLAIMED' : 'RUN_OWNED_ELSEWHERE'));
  assert.ok(fs.existsSync(bad.workspace)); assert.equal(f.show(bad.item).closed, null);
  for (const m of [first, second]) { assert.equal(f.show(m.item).closed.as, 'done'); assert.equal(fs.existsSync(m.workspace), false); }
  assert.deepEqual(f.events().find(e => e.type === 'promotion.reconciled').items, [first.item, second.item]);
  f.drain(); assert.equal(f.gates(), 1);
});

test('train capture isolates ownership refusals and prepares only valid siblings before the native gate', async t => {
  const f = fixture(t), first = f.lane('first');
  const bad = [...ownershipRefusals, 'wrong-record'].map(mode => ({ mode, member: f.lane(`invalid-${mode}`, false, { owned: mode !== 'unclaimed' }) }));
  const second = f.lane('second'), jobs = f.queue.load().pending;
  for (const { mode, member } of bad) {
    if (mode === 'wrong-record') {
      const wrong = path.join(f.root, 'wrong-record'); f.record(['init', wrong]);
      rewriteJob(f, member, { org: wrong });
    } else corruptOwnership(f, member, mode, jobs[0].ownership);
  }
  const file = path.join(f.queue.directory, 'capture-test/train.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ schema: 'promotion-train/v1', id: 'capture-test', identity: f.queue.project.identity, jobs: f.queue.load().pending }));
  // Exercise real capture/preparation without changing native capability
  // checks. A sandbox refusal may stop the gate, but cannot hide admission.
  const release = acquireLock(path.join(f.queue.project.identity, 'lane-promote.lock'));
  try {
    await runTrain({ file, canonical: f.repo, identity: f.queue.project.identity, main: 'main', prepare: [],
      validation: resolveValidation({ root: f.repo, env: f.env }) });
  } finally { release(); }
  const train = JSON.parse(fs.readFileSync(file));
  assert.deepEqual(train.attempts.map(a => a.ids), [[first.job.id, second.job.id]]);
  assert.deepEqual(train.completion.jobs.map(j => j.job), [first.job.id, second.job.id]);
  assert.deepEqual(train.completion.refused, bad.map(({ member }) => member.job.id));
  for (const { mode, member } of bad) {
    assert.equal(train.results[member.job.id].outcome, 'refused');
    if (mode === 'wrong-record') assert.match(train.results[member.job.id].reason, /queue record differs from canonical project record/);
    else {
      assert.equal(train.results[member.job.id].code, mode === 'unclaimed' ? 'RUN_OWNER_UNCLAIMED' : 'RUN_OWNED_ELSEWHERE');
      assert.match(train.results[member.job.id].reason, new RegExp(mode === 'unclaimed' ? 'RUN_OWNER_UNCLAIMED' : 'RUN_OWNED_ELSEWHERE'));
    }
    assert.ok(fs.existsSync(member.workspace)); assert.equal(f.show(member.item).closed, null);
  }
});

test('bound and unbound requests use separate native batches', t => {
  const f = fixture(t), first = f.lane('first'), unbound = f.lane('unbound'), second = f.lane('second');
  rewriteJob(f, unbound, { run: undefined, expectedHead: undefined, superseded: undefined });
  f.drain(); assert.equal((f.queue.load().interrupted ?? []).length, 0);
  assert.ok(f.queue.load().results.every(r => r.outcome === 'promoted'));
  assert.equal(new Set(f.queue.load().results.map(r => r.batch)).size, 3);
  for (const m of [first, second]) assert.equal(f.show(m.item).closed.as, 'done');
  assert.equal(f.show(unbound.item).closed, null);
});

test('a done report with questions is refused before the gate while valid members complete', t => {
  const f = fixture(t), bad = f.lane('questioned', false, { questions: true }), good = f.lane('resolved');
  const badBefore = f.show(bad.item);
  assert.equal(f.show(bad.run).report.extra.questions.length, 1);
  f.drain(); assert.equal(f.gates(), 1);
  const row = f.queue.load().results.find(r => r.id === bad.job.id);
  assert.equal(row.outcome, 'refused'); assert.match(row.reason, /resolution.*blockers\/questions/);
  assert.ok(fs.existsSync(bad.workspace)); assert.deepEqual(f.show(bad.item), badBefore);
  assert.equal(f.show(good.item).closed.as, 'done');
  assert.equal(f.git(['merge-base', f.git(['rev-parse', 'main']), bad.head]), f.git(['rev-parse', `${bad.head}^`]));
  assert.deepEqual(f.events().find(e => e.type === 'promotion.reconciled').excluded, [bad.item]);
  assert.equal((f.queue.load().interrupted ?? []).length, 0);
});

test('included item notes during the gate refuse at the writer and preserve successful reconciliation', t => {
  const f = fixture(t), m = f.lane('changed');
  fs.appendFileSync(f.checker, `const reply=require('child_process').spawnSync(process.execPath, ${JSON.stringify([path.join(source, 'bin/org.mjs'), 'note', m.item, 'Gate-time change'])}, {encoding:'utf8',env:{...process.env,ORG_DIR:${JSON.stringify(f.org)}}});if(reply.status!==3||!reply.stderr.includes('open promotion batch'))throw Error('writer guard failed: '+reply.stderr);console.log(reply.stderr);`);
  f.drain(); assert.equal(f.gates(), 1);
  assert.equal(f.show(m.item).closed.as, 'done'); assert.equal(fs.existsSync(m.workspace), false);
  assert.equal(f.queue.load().results[0].reconciliation.state, 'complete');
  assert.ok(!f.events().some(e => e.type === 'note.added' && e.text === 'Gate-time change'));
  assert.equal((f.queue.load().interrupted ?? []).length, 0);
});

test('the held record lock checks the original fingerprint immediately before fast-forward', t => {
  const f = fixture(t), m = f.lane('guarded'), base = f.git(['rev-parse', 'main']);
  const expected = completionFingerprint(fold(f.events()), m.item);
  const guard = { canonical: f.repo, identity: f.queue.project.identity, workspace: m.workspace,
    topic: m.topic, run: m.run, org: f.org, expectedHead: m.head, completionExpected: expected };
  withPromotionGuards([guard], () => assert.ok(fs.existsSync(path.join(f.org, 'lock'))));
  f.recover(m, ['note', m.item, 'Changed after capture']);
  assert.throws(() => withPromotionGuards([guard], () => f.git(['merge', '--ff-only', m.head])), /changed since batch preparation/);
  assert.equal(f.git(['rev-parse', 'main']), base); assert.equal(fs.existsSync(path.join(f.org, 'lock')), false);
});

test('native completion explicitly retires superseded open runs through the record transaction', t => {
  const f = fixture(t), m = f.lane('superseding', false, { supersede: true }), other = f.lane('other');
  const oldReport = f.show(m.run).report;
  f.drain(); assert.equal(f.gates(), 1); assert.equal((f.queue.load().interrupted ?? []).length, 0);
  assert.ok(f.show(m.superseded[0]).abandoned); assert.deepEqual(f.show(m.run).report, oldReport);
  assert.deepEqual(f.events().find(e => e.type === 'promotion.reconciled').superseded, m.superseded);
  for (const member of [m, other]) { assert.equal(f.show(member.item).closed.as, 'done'); assert.equal(fs.existsSync(member.workspace), false); }
});


for (const mode of ['complete', 'missing-member', 'wrong-head', 'reopened', 'new-run']) test(`manual reconciliation recovery ${mode} retains proof and handles cleanup`, async t => {
  const f = fixture(t), first = f.lane('first'), second = f.lane('second');
  fs.writeFileSync(f.fault, 'refuse'); f.drain(); fs.unlinkSync(f.fault);
  const rows = f.queue.load().results, receipt = rows[0].receipt;
  const attempts = JSON.parse(fs.readFileSync(receipt)).attempts;
  const original = fs.readFileSync(receipt + '.record.json', 'utf8');
  f.recover(first, ['note', first.item, 'Inspected change requires a newly prepared receipt']);
  f.drain(); assert.equal((f.queue.load().interrupted ?? []).length, 1);
  manualRecovery(f, rows, mode);
  if (mode === 'missing-member' || mode === 'wrong-head') {
    f.drain(); assert.equal(f.gates(), 1); assert.equal((f.queue.load().interrupted ?? []).length, 1);
    assert.equal(fs.readFileSync(receipt + '.record.json', 'utf8'), original);
    for (const m of [first, second]) assert.ok(fs.existsSync(m.workspace));
    return;
  }
  if (mode === 'reopened') f.record(['reopen', first.item, '--note', 'Further work']);
  if (mode === 'new-run') f.recover(first, ['start', first.item, '--workspace', first.workspace]);
  if (mode === 'complete') {
    const directory = receiptDirectory(f.org, f.queue.project.identity); fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(directory, `${first.run}.json`), JSON.stringify({ identity: f.queue.project.identity,
      org: f.org, run: first.run, lane: first.topic, head: first.head, phase: 'acknowledged', queue: { jobs: [first.job] } }));
    const retry = spawnSync(process.execPath, [path.join(source, 'supervisor/supervisor.mjs'), 'promote', first.run,
      '--repo', f.repo, '--org', f.org, '--role', 'supervisor', '--retry', '--why', 'Inspected manual reconciliation'],
      { cwd: f.repo, env: f.env, encoding: 'utf8' });
    assert.equal(retry.status, 0, retry.stderr);
    const reply = JSON.parse(retry.stdout);
    assert.equal(reply.result, 'resuming_completion');
    f.workers.remember(reply);
    await f.workers.wait();
    assert.equal(f.queue.load().current, null, 'normal resume worker completes bookkeeping');
  } else f.drain();
  assert.equal(f.gates(), 1); assert.equal((f.queue.load().interrupted ?? []).length, 0);
  assert.equal(fs.readFileSync(receipt + '.record.json', 'utf8'), original);
  assert.deepEqual(JSON.parse(fs.readFileSync(receipt)).attempts, attempts);
  for (const m of [first, second]) {
    const row = f.queue.load().results.findLast(r => r.id === m.job.id);
    assert.equal(row.reconciliation.recovered.batch, 'manual-recovery');
    assert.equal(recordedBatchCompletion({ result: row, project: { ...f.queue.project, org: f.org }, run: { id: m.run, item: m.item } }), true);
    if (mode === 'complete') assert.equal(row.cleanup.state, 'complete', row.reason);
    assert.equal(fs.existsSync(m.workspace), m === first && mode !== 'complete');
  }
  const before = f.events(); f.drain(); assert.equal(f.gates(), 1); assert.deepEqual(f.events(), before);
});


test('native admission refuses omitted superseded attempts without wedging valid work', t => {
  const f = fixture(t), bad = f.lane('omitted', false, { supersede: true }), good = f.lane('good');
  rewriteJob(f, bad, { superseded: [] });
  f.drain(); assert.equal(f.gates(), 1); assert.equal((f.queue.load().interrupted ?? []).length, 0);
  assert.equal(f.queue.load().results.find(r => r.id === bad.job.id).outcome, 'refused');
  assert.equal(f.show(bad.superseded[0]).abandoned, null); assert.ok(fs.existsSync(bad.workspace));
  assert.equal(f.show(good.item).closed.as, 'done');
});

for (const mode of ['covered', 'missing-exclusion']) test(`bisected manual recovery ${mode} accounts for newer excluded work`, t => {
  const f = fixture(t), first = f.lane('first', false, { supersede: true }), second = f.lane('second'), bad = f.lane('broken', true);
  fs.writeFileSync(f.fault, 'refuse'); f.drain(); fs.unlinkSync(f.fault); assert.equal(f.gates(), 3);
  f.recover(first, ['note', first.item, 'Inspected pending native completion']);
  f.record(['start', bad.item, '--workspace', bad.workspace]);
  const excludedBefore = f.show(bad.item), rows = f.queue.load().results;
  const original = JSON.parse(fs.readFileSync(rows[0].receipt + '.record.json'));
  const manifest = path.join(f.repo, '.lane/recovery.json'), prepared = path.join(f.repo, '.lane/recovery-prepared.json');
  fs.mkdirSync(path.dirname(manifest), { recursive: true });
  fs.writeFileSync(manifest, JSON.stringify({ batch: 'bisected-recovery', candidate: original.tip,
    items: original.items, excluded: mode === 'covered' ? original.excluded : [] }));
  const args = ['--repo', f.repo, '--org', f.org, '--role', 'supervisor', '--prepared', prepared];
  reconcile(['prepare', ...args, '--manifest', manifest, '--gate-log', rows[0].log]);
  reconcile(['finish', ...args, '--gate-exit', '0', '--tip', original.tip]);
  f.drain(); assert.equal(f.gates(), 3); assert.deepEqual(f.show(bad.item), excludedBefore);
  assert.ok(fs.existsSync(bad.workspace));
  assert.equal((f.queue.load().interrupted ?? []).length, mode === 'covered' ? 0 : 1);
  for (const m of [first, second]) assert.equal(fs.existsSync(m.workspace), mode !== 'covered');
  assert.ok(f.show(first.superseded[0]).abandoned);
});


test('a refused questioned dependency cannot let another member integrate before completion refuses', t => {
  const f = fixture(t), dependent = f.lane('dependent'), bad = f.lane('questioned', false, { questions: true }), good = f.lane('good');
  f.recover([dependent, bad], ['block', dependent.item, '--by', bad.item]);
  f.drain(); assert.equal(f.gates(), 1); assert.equal((f.queue.load().interrupted ?? []).length, 0);
  for (const m of [dependent, bad]) {
    assert.equal(f.queue.load().results.find(r => r.id === m.job.id).outcome, 'refused');
    assert.equal(f.show(m.item).closed, null); assert.ok(fs.existsSync(m.workspace));
  }
  assert.equal(f.show(good.item).closed.as, 'done');
  assert.deepEqual(new Set(f.events().find(e => e.type === 'promotion.reconciled').excluded), new Set([dependent.item, bad.item]));
});

// A persisted split group is a real train resume input. Only the first half
// has been captured when the canonical/host failure arrives.
