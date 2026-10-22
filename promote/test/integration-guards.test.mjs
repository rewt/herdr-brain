import test from '../../test/helpers/bounded-test.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { declaredFixture, declaration, reuseInputs } from './helpers/declared-fixture.mjs';
import { resolveGateProfile, HOST_ENV } from '../gate-profile.mjs';
import { withPromotionGuards } from '../guard.mjs';
import { recheckDeclaredGate } from '../declared-gates.mjs';
import { runTrain } from '../train.mjs';
import { terminalTrainJobs } from '../evidence.mjs';

function checkpoint(f, t) {
  f.add();
  const q = f.queue(), job = q.load().pending[0], id = 'validated-checkpoint';
  const directory = path.join(q.directory, 'batches', id); fs.mkdirSync(directory, { recursive: true });
  const scratch = path.join(directory, 'scratch'), branch = 'promote-train/checkpoint';
  f.git(['worktree', 'add', '-b', branch, scratch, f.head()]);
  const execution = f.plan({ cwd: scratch }), gate = f.execute(execution);
  assert.equal(gate.exit_code, 0);
  const captured = { ...job, sourceHead: f.head(), workspace: f.workspace };
  const attempt = { ids: [job.id], jobs: [captured], base: f.base(), tip: f.head(), tips: { [job.id]: f.head() },
    scratch, branch, phase: 'validated', gate_mode: job.gate_mode, execution_identity: job.execution_identity,
    gate, declared_spec: execution.spec, declared_execution: execution.evidence };
  const plan = { schema: 'promotion-train/v2', id, identity: q.project.identity, jobs: [job], attempts: [attempt],
    phase: 'validating', results: {}, groups: [[job.id]], integration_branch: 'main', completion: { version: 1, git_only: true } };
  const file = path.join(directory, 'train.json'), save = () => fs.writeFileSync(file, JSON.stringify(plan)); save();
  const previous = process.env[HOST_ENV]; process.env[HOST_ENV] = resolveGateProfile(f.repo).fingerprint;
  t.after(() => { if (previous === undefined) delete process.env[HOST_ENV]; else process.env[HOST_ENV] = previous; });
  return { q, job, attempt, plan, file, save, read: () => JSON.parse(fs.readFileSync(file, 'utf8')),
    resume: options => runTrain({ file, ...q.project, main: 'main', prepare: [], validation: { declared: job.declared }, ...options }) };
}

test('crash recovery finishes a canonical refusal after successful validation once the checkout is cleaned', async t => {
  const value = declaration(); delete value.promotion_tests;
  const f = declaredFixture(t, { declared: value }), r = checkpoint(f, t), base = f.base();
  f.write('operator-edit', 'retain this unrelated edit');
  await r.resume();
  const saved = r.read(), final = saved.results[r.job.id], lines = f.lines();
  assert.equal(saved.attempts[0].phase, 'validated'); assert.equal(saved.attempts[0].gate.exit_code, 0);
  assert.equal(final.outcome, 'refused'); assert.match(final.reason, /not clean/); assert.equal(f.base(), base);
  assert.equal(fs.readFileSync(path.join(f.repo, 'operator-edit'), 'utf8'), 'retain this unrelated edit');
  // A lost completion response must retain the final refusal, not reinterpret
  // its validated attempt as an unproved successful fast-forward.
  saved.phase = 'closing'; fs.writeFileSync(r.file, JSON.stringify(saved));
  fs.unlinkSync(path.join(f.repo, 'operator-edit'));
  const next = declaration(); next.promotion = 'false'; next.gate.refuse_processes = ['.*'];
  f.write('.lane.validation.json', JSON.stringify(next)); f.commit();
  assert.ok(terminalTrainJobs({ file: r.file, project: r.q.project, jobs: saved.jobs }).has(r.job.id));
  await r.resume({ recoveryOnly: true });
  assert.equal(r.read().phase, 'complete'); assert.deepEqual(r.read().results[r.job.id], final);
  assert.deepEqual(f.lines(), lines); assert.notEqual(f.base(), r.attempt.tip);
  assert.equal(f.git(['status', '--porcelain']), ''); assert.equal(f.git(['rev-parse', 'lane/topic']), r.job.expectedHead);
});

for (const corrupt of [false, true]) test(`a lost fast-forward after validation ${corrupt ? 'still rejects corrupted integration evidence' : 'recovers with full proof after main advances'}`, async t => {
  const value = declaration(); delete value.promotion_tests;
  const f = declaredFixture(t, { declared: value }), r = checkpoint(f, t), lines = f.lines();
  f.git(['merge', '--ff-only', r.attempt.tip]); f.write('later', 'subsequent batch'); f.commit();
  const main = f.base();
  if (corrupt) fs.appendFileSync(r.attempt.gate.log, 'corrupted');
  const recovered = terminalTrainJobs({ file: r.file, project: r.q.project, jobs: r.plan.jobs });
  assert.equal(recovered.has(r.job.id), !corrupt);
  if (!corrupt) {
    await r.resume({ recoveryOnly: true });
    assert.equal(r.read().results[r.job.id].outcome, 'promoted'); assert.equal(r.read().attempts[0].phase, 'complete');
  } else {
    r.plan.results[r.job.id] = { outcome: 'refused', reason: 'cannot substitute refusal for integration proof', batch: r.plan.id }; r.save();
    const bytes = fs.readFileSync(r.file);
    await assert.rejects(r.resume({ recoveryOnly: true }), /terminal|evidence/); assert.deepEqual(fs.readFileSync(r.file), bytes);
  }
  assert.equal(f.base(), main); assert.deepEqual(f.lines(), lines);
});

for (const mutation of ['branch', 'dirty']) test(`final promotion guards refuse a canonical ${mutation} change made by a late reuse probe`, t => {
  const value = declaration(); delete value.promotion_tests; value.inputs = { promotion: reuseInputs() };
  const f = declaredFixture(t, { declared: value }), trigger = path.join(f.root, 'trigger'), changed = path.join(f.root, 'changed');
  const probe = path.join(f.root, 'version.cjs');
  fs.writeFileSync(probe, `const fs=require('node:fs'),cp=require('node:child_process');
if(fs.existsSync(${JSON.stringify(trigger)})&&!fs.existsSync(${JSON.stringify(changed)})){
  ${mutation === 'branch' ? `cp.execFileSync('git',['-C',${JSON.stringify(f.repo)},'switch','-qc','operator']);` : `fs.writeFileSync(${JSON.stringify(path.join(f.repo, 'operator-edit'))},'keep');`}
  fs.writeFileSync(${JSON.stringify(changed)},'late probe');
}console.log('stable version');`);
  value.inputs.promotion.toolchains.runner = `node '${probe}'`;
  f.write('.lane.validation.json', JSON.stringify(value)); f.commit(); f.git(['rebase', 'main'], f.workspace);
  assert.equal(f.execute().gates[0].outcome, 'executed');
  const execution = f.plan(), reused = f.execute(execution), base = f.base();
  assert.equal(reused.gates[0].outcome, 'reused'); fs.writeFileSync(trigger, 'integration recheck');
  const checked = recheckDeclaredGate({ spec: execution.spec, env: f.env, evidence: execution.evidence });
  assert.equal(checked.exit_code, 0); assert.ok(fs.existsSync(changed));
  // HEAD equality alone accepts both changes. The final guard must hold the
  // canonical branch, cleanliness and base before allowing any Git effect.
  assert.equal(f.git(['rev-parse', 'HEAD']), base);
  assert.throws(() => withPromotionGuards([{ canonical: f.repo, identity: f.queue().project.identity, workspace: f.workspace,
    topic: 'topic', expectedHead: f.head(), integration: { branch: 'main', base } }], () => f.git(['merge', '--ff-only', f.head()])),
  mutation === 'branch' ? /must be on main/ : /not clean/);
  assert.equal(f.base(), base); assert.equal(fs.readFileSync(path.join(f.repo, 'product.txt'), 'utf8'), 'base');
  if (mutation === 'branch') assert.equal(f.git(['rev-parse', 'operator']), base);
  else assert.equal(fs.readFileSync(path.join(f.repo, 'operator-edit'), 'utf8'), 'keep');
  assert.equal(f.lines().length, 1);
});

test('final promotion guards refuse movement from the captured canonical base', t => {
  const f = declaredFixture(t), base = f.base(); f.write('upstream', 'new base'); f.commit();
  assert.throws(() => withPromotionGuards([{ canonical: f.repo, identity: f.queue().project.identity, workspace: f.workspace,
    expectedHead: f.head(), integration: { branch: 'main', base } }], () => assert.fail('fast-forward must not run')), /canonical base changed/);
  assert.equal(fs.readFileSync(path.join(f.repo, 'product.txt'), 'utf8'), 'base');
});
