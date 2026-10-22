import test from '../../test/helpers/bounded-test.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { configFixture } from '../../test/helpers/config-home-fixture.mjs';
import { declaration, product } from './helpers/declared-fixture.mjs';
import { policyLocation } from '../../lib/config-home.mjs';
import { writeAuditedConfig, pendingConfigWrite } from '../../lib/config-audit.mjs';
import { readDeclared } from '../../lanes/validation.mjs';
import { gitProject } from '../../lib/project.mjs';
import { executionIdentity } from '../execution-identity.mjs';
import { validateDeclared } from '../declaration.mjs';
import { resolveGateProfile, runProjectGateSync } from '../gate-profile.mjs';
import { queueFor, checkDeclaredJobs, enqueue, drain, finishCleanup, retryCleanup } from '../promote.mjs';
import { planDeclaredGate, planDeclaredGateBounded, executeDeclaredGate, recheckDeclaredGate } from '../declared-gates.mjs';
import { admittedDeclaredTestPlan } from '../declared-planning.mjs';
import { runDeclaredExecution } from '../declared-runner.mjs';
import { runTrain } from '../train.mjs';

async function fixture(t, change) {
  const f = configFixture(t, { custom: 'owner' }); await f.adopt();
  const previous = process.cwd(); t.after(() => process.chdir(previous)); process.chdir(f.cwd);
  const file = policyLocation(f.cwd, 'validation', f.env).file, value = declaration();
  delete value.promotion_tests; value.promotion = 'node --version'; value.timeout_seconds.promotion = 120;
  fs.writeFileSync(file, JSON.stringify(value));
  const owner = readDeclared(f.cwd, { env: f.env }), project = gitProject(f.cwd), identity = executionIdentity(project);
  const queue = queueFor(f.cwd, { readOnly: true }), base = f.git('rev-parse', 'HEAD');
  const context = { repo: f.cwd, common: project.identity, base, cwd: f.cwd, candidate: base, identity, owner,
    required: [], changed: [], env: f.env, evidence: { commands: [] } };
  const execution = planDeclaredGate(context);
  const job = { id: 'bound-job', topic: 'topic', expectedHead: base, gate_mode: owner.schema, declared: owner,
    execution_identity: identity, requiredTests: [], validate: null, laneConfig: null };
  const directory = path.join(project.identity, 'promote/batches/identity-control'); fs.mkdirSync(directory, { recursive: true });
  const receipt = path.join(directory, 'train.json'), host = path.join(directory, 'host-gate.json'), slot = path.join(directory, 'test-slot-wait.json');
  const captured = { schema: 'promotion-train/v2', id: 'identity-control', identity: project.identity, jobs: [job],
    attempts: [{ gate_mode: owner.schema, execution_identity: identity, jobs: [job], declared_spec: execution.spec }] };
  fs.writeFileSync(queue.file, JSON.stringify({ identity: project.identity, pending: [], results: [], current: { id: captured.id, jobs: [job] } }));
  fs.writeFileSync(receipt, JSON.stringify(captured)); fs.writeFileSync(host, '{"prior":"host evidence"}\n'); fs.writeFileSync(slot, '{"prior":"slot evidence"}\n');
  const resultFile = path.join(execution.spec.directory, 'result.json'); fs.writeFileSync(resultFile, '{"prior":"execution evidence"}\n');
  const binding = f.binding(), next = { ...value, environment: 'unaudited revision' };
  if (change === 'pending write') assert.throws(() => writeAuditedConfig({ file, value: next, kind: 'validation', binding, cwd: f.cwd, env: f.env, validate: validateDeclared,
    afterReplace() { throw Error('interrupted after replacement'); } }), /interrupted after replacement/);
  else fs.writeFileSync(file, JSON.stringify(next));
  const protectedFiles = [path.join(binding.record, 'events.jsonl'), path.join(path.dirname(binding.identityFile), '.org/events.jsonl'), file, queue.file, receipt, host, slot, resultFile];
  const bytes = protectedFiles.map(file => fs.readFileSync(file));
  const inventory = fs.readdirSync(path.join(project.identity, 'promote'), { recursive: true }).sort();
  const unchanged = () => {
    protectedFiles.forEach((file, i) => assert.deepEqual(fs.readFileSync(file), bytes[i], file));
    assert.deepEqual(fs.readdirSync(path.join(project.identity, 'promote'), { recursive: true }).sort(), inventory);
    if (change === 'pending write') assert.equal(pendingConfigWrite(binding.record, file).length, 1);
  };
  const cli = (relative, args, env = f.env) => {
    const result = spawnSync(process.execPath, [path.join(product, relative), ...args], { cwd: process.cwd(), env, encoding: 'utf8' });
    assert.notEqual(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stderr, /PROMOTION_(?:IDENTITY|PROJECT)_/); unchanged();
  };
  return { ...f, file, value, owner, project, identity, queue, context, execution, captured, receipt, resultFile, unchanged, cli };
}

for (const change of ['unaudited edit', 'pending write']) test(`every declared execution entry preserves record and receipt bytes for a foreign caller with ${change === 'pending write' ? 'a' : 'an'} ${change}`, async t => {
  const f = await fixture(t, change), foreign = path.join(f.scratch, 'foreign');
  fs.mkdirSync(foreign); fs.writeFileSync(path.join(foreign, '.identity-root'), ''); process.chdir(foreign);
  const entries = {
    profile: () => resolveGateProfile(f.cwd, f.env),
    adapter: () => runProjectGateSync({ canonical: f.cwd, receipt: f.receipt, argv: ['-e', "throw Error('foreign command ran')"], env: f.env }),
    queue: () => queueFor(f.cwd),
    enqueue: () => enqueue(f.queue, ['topic'], {}),
    'job admission': () => checkDeclaredJobs(f.queue, f.captured.jobs),
    'finish cleanup': () => finishCleanup(f.captured.jobs[0], { outcome: 'promoted' }, f.queue),
    'retry cleanup': () => retryCleanup(f.queue),
    'settle planner': () => admittedDeclaredTestPlan(f.context),
    'bounded planner': () => planDeclaredGateBounded(f.context),
    'direct planner': () => planDeclaredGate(f.context),
    executor: () => executeDeclaredGate({ spec: f.execution.spec, env: f.env, evidence: f.context.evidence }),
    recheck: () => recheckDeclaredGate({ spec: f.execution.spec, env: f.env, evidence: f.context.evidence }),
    'direct runner': () => runDeclaredExecution(f.execution.spec, f.resultFile),
  };
  for (const [name, entry] of Object.entries(entries)) await t.test(name, () => {
    assert.throws(entry, /PROMOTION_IDENTITY_MISMATCH/); f.unchanged();
  });
  await t.test('train', async () => {
    await assert.rejects(runTrain({ file: f.receipt, ...f.project, main: 'main', prepare: [], validation: { declared: f.owner } }), /PROMOTION_IDENTITY_MISMATCH/);
    f.unchanged();
  });
  await t.test('drain', async () => { await assert.rejects(drain(f.queue), /PROMOTION_IDENTITY_MISMATCH/); f.unchanged(); });
  for (const mode of ['--lock', '--held', '--execute']) await t.test(`host ${mode}`, () => f.cli('promote/host-gate.mjs', [mode, f.cwd, f.receipt, '-e', "throw Error('foreign command ran')"]));
  for (const relative of ['promote/declared-plan-runner.mjs', 'promote/declared-planning.mjs']) await t.test(relative, () => {
    const input = { ...f.context }; delete input.env; delete input.evidence;
    f.cli(relative, [JSON.stringify(input), f.receipt]);
  });
  await t.test('runner CLI', () => f.cli('promote/declared-runner.mjs', [JSON.stringify(f.execution.spec), f.resultFile]));
  for (const action of ['promote', 'handle']) await t.test(`supervisor ${action}`, () => f.cli('supervisor/supervisor.mjs', [action, 'R-999', '--repo', f.cwd, '--org', f.env.ORG_DIR, '--role', 'supervisor', '--why', 'identity control']));
  await t.test('settle CLI', () => f.cli('settle/settle.mjs', ['R-999', '--repo', f.cwd, '--org', f.env.ORG_DIR]));
  for (const args of [['check'], ['promote', 'topic'], ['promote-batch', f.receipt], ['config']]) await t.test(`lane ${args[0]} with foreign Git selectors`, () => {
    f.cli('lanes/lane.mjs', args, { ...f.env, GIT_DIR: f.project.identity, GIT_WORK_TREE: f.cwd });
  });
  // The same owner still audits or completes the pending write after the fence.
  process.chdir(f.cwd); assert.equal(readDeclared(f.cwd, { env: f.env }).value.environment, 'unaudited revision');
  assert.equal(pendingConfigWrite(f.env.ORG_DIR, f.file).length, 0);
});

for (const change of ['unaudited edit', 'pending write']) test(`host and adapter check every captured identity before auditing ${change === 'pending write' ? 'a' : 'an'} ${change}`, async t => {
  const f = await fixture(t, change);
  for (const target of ['job', 'attempt', 'attempt job', 'execution spec']) {
    const captured = structuredClone(f.captured), wrong = { ...f.identity, project_root: null };
    if (target === 'job') captured.jobs[0].execution_identity = wrong;
    if (target === 'attempt') captured.attempts[0].execution_identity = wrong;
    if (target === 'attempt job') captured.attempts[0].jobs[0].execution_identity = wrong;
    if (target === 'execution spec') captured.attempts[0].declared_spec.identity = wrong;
    const before = fs.readFileSync(f.receipt); fs.writeFileSync(f.receipt, JSON.stringify(captured));
    const bytes = fs.readFileSync(f.receipt);
    assert.throws(() => resolveGateProfile(f.cwd, f.env, { captured }), /PROMOTION_IDENTITY_BINDING_CHANGED/);
    assert.throws(() => runProjectGateSync({ canonical: f.cwd, receipt: f.receipt, argv: [], env: f.env }), /PROMOTION_IDENTITY_BINDING_CHANGED/);
    assert.throws(() => queueFor(f.cwd), /PROMOTION_IDENTITY_BINDING_CHANGED/);
    assert.throws(() => checkDeclaredJobs(f.queue, f.captured.jobs), /PROMOTION_IDENTITY_BINDING_CHANGED/);
    assert.throws(() => retryCleanup(f.queue), /PROMOTION_IDENTITY_BINDING_CHANGED/);
    await assert.rejects(drain(f.queue), /PROMOTION_IDENTITY_BINDING_CHANGED/);
    await assert.rejects(runTrain({ file: f.receipt, ...f.project, main: 'main', prepare: [], validation: { declared: f.owner } }), /PROMOTION_IDENTITY_BINDING_CHANGED/);
    assert.deepEqual(fs.readFileSync(f.receipt), bytes);
    for (const mode of ['--lock', '--held', '--execute']) {
      const result = spawnSync(process.execPath, [path.join(product, 'promote/host-gate.mjs'), mode, f.cwd, f.receipt], { cwd: f.cwd, env: f.env, encoding: 'utf8' });
      assert.equal(result.status, 75); assert.match(result.stderr, /PROMOTION_IDENTITY_BINDING_CHANGED/); assert.deepEqual(fs.readFileSync(f.receipt), bytes);
    }
    fs.writeFileSync(f.receipt, before); f.unchanged();
  }
});
