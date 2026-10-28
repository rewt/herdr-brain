import test from '../../test/helpers/bounded-test.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { withPromotionGuards } from '../guard.mjs';
import { completionFingerprint } from '../../lib/completion.mjs';
import { acquireLock } from '../../lanes/promotion-lock.mjs';
import { fold } from '../../lib/state.mjs';
import { runTrain } from '../train.mjs';
import { resolveValidation } from '../../lanes/validation.mjs';
import { fixture, source } from './completion-fixture.mjs';

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
