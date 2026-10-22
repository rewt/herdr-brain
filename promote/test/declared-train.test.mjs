import test from '../../test/helpers/bounded-test.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { declaredFixture, declaration, product } from './helpers/declared-fixture.mjs';
import { runProjectGateSync } from '../gate-profile.mjs';
import { runTrain } from '../train.mjs';
import { terminalTrainJobs, verifyTrainResult } from '../evidence.mjs';
import { checkDeclaredJobs } from '../promote.mjs';
import { fixture as completionFixture } from './completion-fixture.mjs';

function train(f, t, options = {}) {
  f.add(options);
  const q = f.queue(), jobs = q.load().pending, id = 'fixture-train', file = path.join(q.directory, 'batches', id, 'train.json');
  q.transaction(data => { data.pending = []; data.current = { id, phase: 'batching', jobs }; });
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ schema: 'promotion-train/v2', id, identity: q.project.identity, jobs, phase: 'pending' }));
  const result = runProjectGateSync({ canonical: f.repo, receipt: file,
    argv: [path.join(product, 'lanes/lane.mjs'), 'promote-batch', file], cwd: f.repo, env: f.env, encoding: 'utf8' });
  const read = () => JSON.parse(fs.readFileSync(file, 'utf8')), receipt = read();
  const native = receipt.native_context?.ok === false ? receipt.native_context : Object.values(receipt.results ?? {}).find(row => row.code?.startsWith('PROMOTE_NATIVE_'));
  if (native) { t.skip(native.reason); return null; }
  assert.equal(result.status, 0, result.stderr + result.stdout + JSON.stringify(receipt));
  return { q, file, read, receipt, result };
}

test('one admitted v2 train validates the exact clean candidate and fast-forwards with complete command evidence', t => {
  const f = declaredFixture(t), before = f.base(), r = train(f, t, { requiredTests: [{ gate: 'tool' }, 'whole.test.ts'] }); if (!r) return;
  const attempt = r.receipt.attempts[0], job = r.receipt.jobs[0];
  assert.equal(r.receipt.results[job.id].outcome, 'promoted', JSON.stringify(r.receipt));
  assert.equal(f.base(), attempt.tip); assert.notEqual(f.base(), before); assert.equal(attempt.gate.exit_code, 0);
  assert.equal(attempt.declared_spec.schema, 'declared-gate-execution/v2'); assert.equal(attempt.test_plan.schema, 'promotion-gates/v1');
  assert.deepEqual(attempt.gate.command_order, [declaration().promotion, declaration().gates.tool.command]);
  assert.equal(attempt.gate.node_version, process.version); assert.equal(attempt.gate.tap_totals[0].tests, 1);
  assert.equal(f.lines().length, 2); assert.equal(f.git(['rev-list', '--merges', 'main']), '');
  assert.ok(verifyTrainResult({ id: job.id, batch: r.receipt.id, receipt: r.file, source_head: job.expectedHead, tip: attempt.tip },
    { project: r.q.project, saved: { lane: job.topic, head: job.expectedHead, run: job.run, org: job.org, requiredTests: job.requiredTests } }));
});

for (const checkpoint of ['validated', 'integrated', 'complete']) test(`terminal ${checkpoint} integration recovers after declaration change without execution or admission`, async t => {
  const f = declaredFixture(t), next = declaration(); next.promotion = 'node future.mjs'; next.gate.refuse_processes = ['.*'];
  f.write('.lane.validation.json', JSON.stringify(next), f.workspace); f.write('future.mjs', "throw Error('recovery executed future policy');", f.workspace); f.commit(f.workspace);
  const r = train(f, t); if (!r) return;
  const saved = r.read(), job = saved.jobs[0], attempt = saved.attempts[0], lines = f.lines();
  assert.equal(saved.results[job.id].outcome, 'promoted', JSON.stringify(saved));
  saved.phase = 'closing'; attempt.phase = checkpoint;
  if (checkpoint !== 'complete') delete saved.results[job.id];
  fs.writeFileSync(r.file, JSON.stringify(saved));
  assert.ok(terminalTrainJobs({ file: r.file, project: r.q.project, jobs: saved.jobs }).has(job.id));
  const bytes = fs.readFileSync(r.file, 'utf8'); process.chdir(f.foreign);
  await assert.rejects(runTrain({ file: r.file, canonical: f.repo, identity: r.q.project.identity, main: 'main', prepare: [], validation: { declared: job.declared }, recoveryOnly: true }), /IDENTITY_MISMATCH/);
  assert.equal(fs.readFileSync(r.file, 'utf8'), bytes); process.chdir(f.repo);
  await runTrain({ file: r.file, canonical: f.repo, identity: r.q.project.identity, main: 'main', prepare: [], validation: { declared: job.declared }, recoveryOnly: true });
  assert.equal(r.read().phase, 'complete'); assert.equal(r.read().results[job.id].outcome, 'promoted'); assert.deepEqual(f.lines(), lines);
  assert.equal(f.base(), attempt.tip);
  const resumed = f.cli(['--drain']); f.good(resumed);
  assert.equal(r.q.load().results.at(-1).outcome, 'promoted'); assert.deepEqual(f.lines(), lines);
});

test('refusal-only terminal recovery precedes current declaration and host admission', async t => {
  const f = declaredFixture(t); f.write('baseline.mjs', "console.log('red');process.exit(9);", f.workspace); f.commit(f.workspace);
  const r = train(f, t, { requiredTests: [{ gate: 'tool' }] }); if (!r) return;
  const saved = r.read(), job = saved.jobs[0], final = saved.results[job.id]; assert.equal(final.outcome, 'refused');
  const next = declaration(); next.promotion = 'false'; next.gate.refuse_processes = ['.*'];
  f.write('.lane.validation.json', JSON.stringify(next)); f.commit();
  saved.phase = 'validating'; fs.writeFileSync(r.file, JSON.stringify(saved));
  assert.ok(terminalTrainJobs({ file: r.file, project: r.q.project, jobs: saved.jobs }).has(job.id));
  assert.doesNotThrow(() => checkDeclaredJobs(r.q, saved.jobs));
  f.good(f.cli(['--drain']));
  assert.deepEqual(r.read().results[job.id], final); assert.equal(r.q.load().results.at(-1).outcome, 'refused'); assert.deepEqual(f.lines(), []);
});

test('mixed refused and integrated bisection recovers each saved terminal member under its captured declaration', async t => {
  const f = declaredFixture(t);
  f.write('baseline.mjs', "import fs from 'node:fs';const red=fs.existsSync('bad');fs.appendFileSync(process.env.CHECK_LOG,red?'red\\n':'green\\n');process.exitCode=red?9:0;"); f.commit(); f.git(['rebase', 'main'], f.workspace);
  f.write('bad', 'lane isolated', f.workspace); f.commit(f.workspace);
  const good = path.join(f.owner, 'good'); f.git(['worktree', 'add', '-qb', 'lane/good', good]);
  const next = declaration(); next.promotion = 'false'; next.gate.refuse_processes = ['.*'];
  f.write('.lane.validation.json', JSON.stringify(next), good); f.commit(good); f.add(); f.add({}, 'good');
  const r = train(f, t); if (!r) return;
  const saved = r.read(), refused = saved.jobs.find(job => job.topic === 'topic'), promoted = saved.jobs.find(job => job.topic === 'good');
  assert.equal(saved.attempts.length, 3, JSON.stringify(saved)); assert.equal(saved.results[refused.id].outcome, 'refused'); assert.equal(saved.results[promoted.id].outcome, 'promoted');
  assert.deepEqual(f.lines(), ['red', 'red', 'green']);
  // Queue arrival order is good, topic. Preserve the final refusal while
  // simulating a lost integration acknowledgement for the green sibling.
  const integrated = saved.attempts.find(attempt => attempt.gate?.exit_code === 0);
  integrated.phase = 'validated'; delete saved.results[promoted.id]; saved.phase = 'closing'; fs.writeFileSync(r.file, JSON.stringify(saved));
  const finalRefusal = structuredClone(saved.results[refused.id]);
  f.good(f.cli(['--drain']));
  assert.deepEqual(r.read().results[refused.id], finalRefusal); assert.equal(r.read().results[promoted.id].outcome, 'promoted');
  assert.deepEqual(f.lines(), ['red', 'red', 'green']);
});

test('unfinished captured work holds on a changed declaration and damaged integration logs cannot recover', t => {
  const f = declaredFixture(t); f.add(); const q = f.queue(), jobs = q.load().pending;
  const next = declaration(); next.promotion = 'false'; f.write('.lane.validation.json', JSON.stringify(next)); f.commit();
  const bytes = fs.readFileSync(q.file, 'utf8'); assert.throws(() => checkDeclaredJobs(q, jobs), /re-admission/);
  assert.equal(fs.readFileSync(q.file, 'utf8'), bytes); assert.deepEqual(f.lines(), []);
});

test('declared v2 record-bound promotion completes the existing guarded record transaction', t => {
  const previous = process.cwd(); t.after(() => process.chdir(previous));
  const f = completionFixture(t); process.chdir(f.repo);
  const value = declaration(); value.promotion = `${process.execPath} '${f.checker}'`; delete value.promotion_tests; value.gates = {};
  fs.writeFileSync(path.join(f.repo, '.lane.validation.json'), JSON.stringify(value)); f.git(['add', '.']); f.git(['commit', '-qm', 'Declare v2']);
  const member = f.lane('recorded'); f.drain();
  const result = f.queue.load().results.at(-1);
  if (result.code?.startsWith('PROMOTE_NATIVE_')) { t.skip(result.reason); return; }
  assert.equal(result.outcome, 'promoted', JSON.stringify(result)); assert.equal(result.reconciliation.state, 'complete', JSON.stringify(result));
  assert.equal(f.show(member.item).closed.as, 'done'); assert.equal(f.gates(), 1);
  const saved = JSON.parse(fs.readFileSync(result.receipt, 'utf8')); assert.equal(saved.schema, 'promotion-train/v2');
  assert.equal(saved.attempts[0].declared_spec.jobs[0].run, member.run);
  assert.equal(f.events().filter(row => row.type === 'promotion.reconciled').length, 1);
});

test('a pre-execution refusal with no attempt or integration branch recovers its bound recorded job without current policy', async t => {
  const f = declaredFixture(t); f.add(); const q = f.queue(), jobs = q.load().pending, id = 'early-refusal';
  const file = path.join(q.directory, 'batches', id, 'train.json'); fs.mkdirSync(path.dirname(file), { recursive: true });
  const final = { outcome: 'refused', code: 'PROMOTION_STOPPED', reason: 'captured pre-execution refusal', batch: id };
  // A run/record binding remains opaque to refusal bookkeeping: no new capture
  // or execution is needed to rediscover an already final result.
  jobs[0].run = 'R-999'; jobs[0].org = path.join(f.root, 'original-record');
  const saved = { schema: 'promotion-train/v2', id, identity: q.project.identity, jobs, phase: 'validating', results: { [jobs[0].id]: final } };
  fs.writeFileSync(file, JSON.stringify(saved));
  fs.writeFileSync(path.join(f.repo, '.lane.validation.json'), '{'); f.commit();
  await runTrain({ file, canonical: f.repo, identity: q.project.identity, main: undefined, prepare: [], validation: { declared: jobs[0].declared }, recoveryOnly: true });
  const recovered = JSON.parse(fs.readFileSync(file, 'utf8')); assert.equal(recovered.phase, 'complete'); assert.deepEqual(recovered.results[jobs[0].id], final); assert.deepEqual(f.lines(), []);
});
