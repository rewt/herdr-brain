import test from '../../test/helpers/bounded-test.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { declaredFixture, declaration, product } from './helpers/declared-fixture.mjs';
import { runProjectGateSync } from '../gate-profile.mjs';
import { unionRequirements } from '../declared-selection.mjs';
import { runTrain } from '../train.mjs';
import { resolveValidation } from '../../lanes/validation.mjs';
import { integratedTrainJobs } from '../evidence.mjs';
import { waitForInboxIdle } from '../../test/helpers/inbox.mjs';

function train(f, t, options = {}) {
  f.add(options);
  const q = f.queue(), jobs = q.load().pending, file = path.join(q.directory, 'batches/fixture/train.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ schema: 'promotion-train/v1', id: 'fixture-train', identity: q.project.identity, jobs, phase: 'pending' }));
  const result = runProjectGateSync({ canonical: f.repo, receipt: file,
    argv: [path.join(product, 'lanes/lane.mjs'), 'promote-batch', file], cwd: f.repo, env: f.env, encoding: 'utf8' });
  const receipt = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (receipt.native_context?.ok === false && receipt.native_context.code?.startsWith('PROMOTE_NATIVE_')) {
    t.skip(`${receipt.native_context.code}: native sandbox capability refused; rerun this witness natively`);
    return null;
  }
  assert.equal(result.status, 0, result.stderr + result.stdout);
  return { receipt, file, q, result };
}

test('one admitted train binds declaration, identities, typed selection, runtime and receipt before fast-forward', t => {
  const f = declaredFixture(t);
  const before = f.base(), result = train(f, t, { requiredTests: [{ runner: 'tool', args: ['whole.test.ts', '--maxWorkers=1'] }] });
  if (!result) return;
  const { receipt } = result, attempt = receipt.attempts[0];
  assert.equal(receipt.phase, 'complete', JSON.stringify(receipt.results)); assert.equal(attempt.phase, 'complete', JSON.stringify(receipt.results));
  assert.equal(receipt.results[receipt.jobs[0].id].outcome, 'promoted');
  assert.notEqual(f.base(), before); assert.equal(f.base(), attempt.tip);
  assert.equal(attempt.execution_identity.caller_root, f.owner);
  assert.equal(attempt.execution_identity.project_root, f.owner);
  assert.equal(attempt.test_plan.schema, 'promotion-tests/v2');
  assert.equal(attempt.test_plan.required[0].definition.command[1], 'runner.mjs');
  assert.ok(attempt.declared_execution.planner_source.digest);
  assert.ok(attempt.declared_execution.runtime.tool[0].binding.version);
  assert.equal(attempt.gate.declared_gate.selection.steps[0].runner, 'tool');
  assert.equal(attempt.gate.exit_code, 0); assert.equal(attempt.gate.node_version, process.version);
  assert.ok(attempt.gate.command.includes('declared-runner.mjs'));
  assert.equal(attempt.gate.signal, null); assert.equal(f.lines().length, 2);
  const shared = JSON.parse(fs.readFileSync(path.join(result.q.project.identity, 'lane-validation', attempt.gate.key + '.json')));
  assert.deepEqual(shared.declared_gate, attempt.declared_spec);
  assert.equal(shared.tap_totals[0].tests, 1);
});

test('missing admission roots refuse a worker before its first receipt mutation', async t => {
  const f = declaredFixture(t); f.add();
  const q = f.queue(), jobs = q.load().pending;
  delete jobs[0].execution_identity;
  const file = path.join(f.root, 'unbound.json'), bytes = JSON.stringify({ schema: 'promotion-train/v1', identity: q.project.identity, jobs });
  fs.writeFileSync(file, bytes);
  await assert.rejects(runTrain({ file, canonical: f.repo, identity: q.project.identity, main: 'main', prepare: [], validation: resolveValidation({ root: f.repo, env: f.env }) }), /IDENTITY_BINDING_CHANGED/);
  assert.equal(fs.readFileSync(file, 'utf8'), bytes); assert.deepEqual(f.lines(), []);
});

test('a red mandatory command stops selected work and leaves main and the lane intact', t => {
  const f = declaredFixture(t);
  f.write('baseline.mjs', "import fs from 'node:fs';fs.appendFileSync(process.env.CHECK_LOG,'red\\n');process.exit(9);"); f.commit(); f.git(['rebase', 'main'], f.workspace);
  const before = f.base(), head = f.head(), result = train(f, t, { requiredTests: [{ runner: 'tool', args: ['required'] }] });
  if (!result) return;
  assert.equal(result.receipt.attempts[0].phase, 'red');
  assert.equal(result.receipt.attempts[0].gate.exit_code, 9);
  assert.equal(f.base(), before); assert.equal(f.head(), head); assert.deepEqual(f.lines(), ['red']);
});

test('batch union and each bisected subset preserve every included member requirement', () => {
  const first = { requiredTests: ['a.test.mjs', { runner: 'vitest', args: ['one.test.ts'], definition: { command: ['vitest'], cwd: '.' }, scope: 'one', toolchain: 'locked' }] };
  const second = { requiredTests: ['b.test.mjs', 'a.test.mjs'] };
  assert.equal(unionRequirements([first, second]).length, 3);
  assert.deepEqual(unionRequirements([first]), first.requiredTests);
  assert.deepEqual(unionRequirements([second]), ['a.test.mjs', 'b.test.mjs']);
  assert.throws(() => unionRequirements([first, { requiredTests: [{ ...first.requiredTests[1], scope: 'changed' }] }]), /incompatible/);
});

for (const resume of ['queue', 'train']) test(`a declaration-changing fast-forward recovers through the ${resume} under its captured rule`, async t => {
  const f = declaredFixture(t);
  const next = declaration(); next.promotion = 'node future.mjs'; next.gate = { refuse_processes: ['.*'] };
  f.write('.lane.validation.json', JSON.stringify(next), f.workspace);
  f.write('future.mjs', "throw Error('new declaration must not execute during recovery');", f.workspace); f.commit(f.workspace);
  const q = f.queue(), realGit = f.good(f.run('which', ['git'])), bin = path.join(f.root, 'bin'), marker = path.join(f.root, 'after-ff');
  fs.mkdirSync(bin); f.env.PATH = bin + path.delimiter + f.env.PATH;
  fs.writeFileSync(path.join(bin, 'git'), `#!${process.execPath}
const fs=require('fs'),cp=require('child_process'),args=process.argv.slice(2);
const r=cp.spawnSync(${JSON.stringify(realGit)},args,{stdio:'inherit'});
if(r.status===0&&args.includes('merge')&&args.includes('--ff-only')&&!fs.existsSync(${JSON.stringify(marker)})){
 fs.writeFileSync(${JSON.stringify(marker)},'once');
 const lock=${JSON.stringify(path.join(q.project.identity, 'lane-promote.lock'))};
 if(JSON.parse(fs.readFileSync(lock+'/owner.json')).pid===process.ppid)fs.rmSync(lock,{recursive:true});
 process.kill(process.ppid,'SIGKILL');
}process.exit(r.status??1);`, { mode: 0o755 });
  const herdr = path.join(f.root, 'herdr');
  fs.writeFileSync(herdr, `#!${process.execPath}
const a=process.argv.slice(2);
if(a[0]==='agent'&&a[1]==='get')console.log(JSON.stringify({result:{agent:{agent:'claude',agent_status:'idle',pane_id:'fixture'}}}));
else if(a[0]==='pane'&&a[1]==='read')console.log('────────────────────\\n❯ \\n────────────────────');
else console.log(JSON.stringify({result:{workspaces:[],agents:[]}}));`, { mode: 0o755 });
  Object.assign(f.env, { SUPERVISOR_INPUT_WAIT_SECONDS: '2', SUPERVISOR_INPUT_CONFIRM_SECONDS: '0.001', SUPERVISOR_INPUT_POLL_SECONDS: '0.001' });
  const inbox = path.join(q.project.identity, 'supervisor/inbox.log');
  try {
    f.add({ to: 'fixture', herdr, attempts: 1, retry: 0 });
    const first = f.cli(['--drain']); assert.equal(first.status, 0, first.stderr);
    const interrupted = q.load().results[0];
    if (interrupted.code?.startsWith('PROMOTE_NATIVE_') || interrupted.reason?.includes('PROMOTE_NATIVE_')) {
      t.skip(`${interrupted.code ?? interrupted.reason}: L-27; rerun natively`); return;
    }
    assert.equal(interrupted.outcome, 'interrupted', JSON.stringify(interrupted));
    assert.ok(fs.existsSync(marker));
    const bytes = fs.readFileSync(interrupted.receipt, 'utf8'), saved = JSON.parse(bytes), attempt = saved.attempts[0];
    assert.equal(attempt.phase, 'validated'); assert.equal(f.base(), attempt.tip); assert.deepEqual(f.lines(), ['baseline']);
    assert.deepEqual([...integratedTrainJobs({ file: interrupted.receipt, project: q.project, jobs: saved.jobs })], [interrupted.id]);
    const tampered = structuredClone(saved); tampered.attempts[0].gate.log_hash = '0'.repeat(64);
    fs.writeFileSync(interrupted.receipt, JSON.stringify(tampered));
    assert.equal(integratedTrainJobs({ file: interrupted.receipt, project: q.project, jobs: saved.jobs }).size, 0, 'green flags do not replace the log proof');
    fs.writeFileSync(interrupted.receipt, bytes);
    process.chdir(f.foreign);
    await assert.rejects(runTrain({ file: interrupted.receipt, canonical: f.repo, identity: q.project.identity, main: 'main', prepare: [],
      validation: { declared: saved.jobs[0].declared } }), /PROMOTION_IDENTITY_MISMATCH/);
    const foreign = f.cli(['--drain', '--repo', f.repo], f.foreign);
    assert.equal(foreign.status, 1); assert.match(foreign.stderr, /PROMOTION_IDENTITY_MISMATCH/);
    assert.equal(fs.readFileSync(interrupted.receipt, 'utf8'), bytes);
    process.chdir(f.repo);
    if (resume === 'train') await runTrain({ file: interrupted.receipt, canonical: f.repo, identity: q.project.identity, main: 'main', prepare: [],
      validation: resolveValidation({ root: f.repo, env: f.env }) });
    const resumed = f.cli(['--drain']); assert.equal(resumed.status, 0, resumed.stderr);
    assert.equal(q.load().results.at(-1).outcome, 'promoted', JSON.stringify(q.load().results));
    assert.equal(q.load().interrupted.length, 0); assert.deepEqual(f.lines(), ['baseline']);
    const final = JSON.parse(fs.readFileSync(interrupted.receipt, 'utf8'));
    assert.equal(final.phase, 'complete'); assert.equal(final.attempts[0].phase, 'complete');
    assert.equal(f.base(), attempt.tip); assert.deepEqual(final.attempts[0].declared_spec, attempt.declared_spec);
    assert.equal(final.attempts[0].gate.started_at, attempt.gate.started_at);
  } finally { process.chdir(f.repo); await waitForInboxIdle(inbox); }
});
