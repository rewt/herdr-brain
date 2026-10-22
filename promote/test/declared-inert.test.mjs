import test from '../../test/helpers/bounded-test.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { configFixture } from '../../test/helpers/config-home-fixture.mjs';
import { declaration, declaredFixture, product } from './helpers/declared-fixture.mjs';
import { policyLocation } from '../../lib/config-home.mjs';
import { writeAuditedConfig, pendingConfigWrite } from '../../lib/config-audit.mjs';
import { readDeclared, resolveValidation, canonicalValidation, validateTree, fenceDeclaredMode } from '../../lanes/validation.mjs';
import { gitProject } from '../../lib/project.mjs';
import { executionIdentity } from '../execution-identity.mjs';
import { validateDeclared, snapshotDeclaration, gateDefinition, hash } from '../declaration.mjs';
import { selectDeclared } from '../declared-selection.mjs';
import { fenceGateIdentity, resolveGateProfile, runProjectGateSync } from '../gate-profile.mjs';
import { queueFor, fenceDeclaredTarget, checkDeclaredJobs, enqueue, drain, finishCleanup, retryCleanup } from '../promote.mjs';
import { planDeclaredGate, planDeclaredGateBounded, executeDeclaredGate, recheckDeclaredGate, assertExecutionBinding } from '../declared-gates.mjs';
import { admittedDeclaredTestPlan } from '../declared-planning.mjs';
import { runDeclaredExecution, validateExecution } from '../declared-runner.mjs';
import { main as boundedPlanner } from '../declared-planner.mjs';
import { runDeclaredCommand, prepareDeclared } from '../declared-command.mjs';
import { receiptDirectory, withReceiptLock, publishSource, verifySource } from '../declared-receipts.mjs';
import { runTrain } from '../train.mjs';
import { terminalTrainJobs, verifyTrainResult } from '../evidence.mjs';
import { configSnapshot } from '../../lib/config-command.mjs';
import { desksSnapshot } from '../../settle/desks-command.mjs';
import { doctor } from '../../setup/setup.mjs';
import { main as supervisor } from '../../supervisor/supervisor.mjs';

const code = 'DECLARED_GATES_V2_INERT';
const refused = error => { assert.equal(error.code, code); assert.match(error.message, /ENG-538/); return true; };

// Include absent directories, inventory, modes and every byte, so new logs,
// locks, sidecars, audit events and recovered pending writes are observable.
function snapshot(roots) {
  const rows = [];
  const visit = file => {
    if (!fs.existsSync(file)) { rows.push([file, null]); return; }
    const stat = fs.lstatSync(file);
    if (stat.isDirectory()) {
      rows.push([file, 'directory', stat.mode]);
      for (const name of fs.readdirSync(file).sort()) visit(path.join(file, name));
    } else rows.push([file, stat.mode, stat.isSymbolicLink() ? fs.readlinkSync(file) : fs.readFileSync(file).toString('base64')]);
  };
  roots.forEach(visit); return rows;
}

async function fixture(t, change) {
  const f = configFixture(t, { custom: 'owner' }); await f.adopt();
  const previous = process.cwd(); t.after(() => process.chdir(previous)); process.chdir(f.cwd);
  const binding = f.binding(), project = gitProject(f.cwd), identity = executionIdentity(project);
  const queue = queueFor(f.cwd, { readOnly: true }), base = f.git('rev-parse', 'HEAD');
  const file = policyLocation(f.cwd, 'validation', f.env).file, value = declaration();
  delete value.promotion_tests; value.promotion = 'node --version';
  writeAuditedConfig({ file, value, kind: 'validation', binding, cwd: f.cwd, env: f.env, validate: validateDeclared });
  const owner = { schema: value.schema, selection_schema: 'promotion-gates/v1', value,
    source: { file, revision: `sha256:${hash(value)}`, digest: hash(value), storage: 'config-home' } };
  // Construct captured input as data, never by admitting v2 through a test seam.
  const directory = path.join(project.identity, 'promote/declared-attempts/inert-control'); fs.mkdirSync(directory, { recursive: true });
  const selection = selectDeclared({ schema: 'promotion-gates/v1', gates: [], deferred: [], unknown: [] }, value, []);
  const spec = { schema: 'declared-gate-execution/v2', repo: f.cwd, common: project.identity, base, cwd: f.cwd, candidate: base,
    branch: 'main', identity, declaration: snapshotDeclaration(owner), required: [], changed: [], jobs: [],
    limits: { wall_seconds: 120, idle_seconds: 0 }, deadline: Date.now() + 120000, directory,
    selection, commands: [{ id: 'promotion', definition: gateDefinition(value, 'promotion') }] };
  const job = { id: 'bound-job', topic: 'topic', expectedHead: base, gate_mode: value.schema, declared: owner, execution_identity: identity,
    requiredTests: [], validate: null, laneConfig: null, cleanup: { state: 'pending' } };
  const batch = path.join(project.identity, 'promote/batches/inert-control'); fs.mkdirSync(batch, { recursive: true });
  const receipt = path.join(batch, 'train.json'), resultFile = path.join(directory, 'result.json');
  for (const at of [resultFile, path.join(batch, 'host-gate.json'), path.join(batch, 'test-slot-wait.json'),
    path.join(directory, 'executor.execution.json'), path.join(directory, 'command.log')]) fs.writeFileSync(at, '{"prior":"preserve evidence"}\n');
  const context = { repo: f.cwd, common: project.identity, base, cwd: f.cwd, candidate: base, identity, owner,
    required: [], changed: [], env: f.env, evidence: { commands: [] } };
  const next = { ...value, environment: 'unaudited revision' };
  if (change === 'pending write') assert.throws(() => writeAuditedConfig({ file, value: next, kind: 'validation', binding, cwd: f.cwd, env: f.env, validate: validateDeclared,
    afterReplace() { throw Error('interrupted after replacement'); } }), /interrupted after replacement/);
  else {
    fs.writeFileSync(file, JSON.stringify(next));
    // Even discovery of an edited identity home must remain inspection-only.
    const defaults = JSON.parse(fs.readFileSync(binding.identityFile));
    fs.writeFileSync(binding.identityFile, JSON.stringify({ ...defaults, worktree_root: change === 'malformed identity defaults' ? 17 : 'unaudited-lanes' }));
    if (change === 'malformed identity defaults') fs.unlinkSync(path.join(f.cwd, '.brain'));
  }
  const roots = [binding.record, path.join(path.dirname(binding.identityFile), '.org'), binding.directory, binding.identityFile,
    queue.directory, path.join(project.identity, 'lane-validation'), path.join(project.identity, 'declared-gates'), path.join(f.cwd, '.lane')];
  return { ...f, binding, project, identity, queue, base, file, value, owner, spec, job, context, receipt, resultFile, roots };
}

for (const change of ['unaudited edit', 'pending write', 'malformed identity defaults']) test(`v2 admission is inert before effects with ${change}`, async t => {
  const f = await fixture(t, change);
  const sibling = path.join(f.ownerRoot, 'sibling'), foreign = path.join(f.scratch, 'foreign');
  fs.mkdirSync(sibling); fs.mkdirSync(foreign); fs.writeFileSync(path.join(foreign, '.identity-root'), '');
  for (const at of [sibling, foreign]) {
    const initialized = spawnSync('git', ['init', '-qb', 'main', at], { env: f.env, encoding: 'utf8' }); assert.equal(initialized.status, 0, initialized.stderr);
  }
  for (const [caller, cwd] of [['owner', f.cwd], ['same identity foreign project', sibling], ['foreign identity', foreign]]) {
    for (const omitted of [false, true]) await t.test(`${caller}, captured identity ${omitted ? 'omitted' : 'present'}`, async t => {
      process.chdir(cwd);
      const spec = structuredClone(f.spec), context = { ...f.context }, job = structuredClone(f.job);
      if (omitted) { delete spec.identity; delete context.identity; delete job.execution_identity; }
      const captured = { schema: 'promotion-train/v2', id: 'inert-control', identity: f.project.identity, jobs: [job],
        attempts: [{ gate_mode: f.value.schema, ...(omitted ? {} : { execution_identity: f.identity }), jobs: [job], declared_spec: spec, phase: 'validated' }] };
      fs.writeFileSync(f.receipt, JSON.stringify(captured));
      fs.writeFileSync(f.queue.file, JSON.stringify({ identity: f.project.identity, pending: [], results: [job], current: { id: captured.id, jobs: [job] } }));
      const before = snapshot(f.roots);
      const unchanged = () => {
        assert.deepEqual(snapshot(f.roots), before);
        assert.deepEqual(context.evidence, { commands: [] });
        if (change === 'pending write') assert.equal(pendingConfigWrite(f.binding.record, f.file).length, 1);
      };
      const entries = {
        'mode inspection': () => fenceDeclaredMode(f.cwd, { env: f.env }),
        'readDeclared audited': () => readDeclared(f.cwd, { env: f.env }),
        'readDeclared inspection': () => readDeclared(f.cwd, { env: f.env, audit: false }),
        resolveValidation: () => resolveValidation({ root: f.cwd, env: f.env }),
        canonicalValidation: () => canonicalValidation(f.cwd, f.env),
        validateTree: () => validateTree({ cwd: f.cwd, common: f.project.identity, command: 'node --version', env: f.env, tier: 'fast' }),
        'identity fence': () => fenceGateIdentity(f.cwd, f.env, { captured }),
        profile: () => resolveGateProfile(f.cwd, f.env, { captured }),
        adapter: () => runProjectGateSync({ canonical: f.cwd, receipt: f.receipt, argv: ['--version'], env: f.env }),
        'queue fence': () => fenceDeclaredTarget(f.project, { jobs: [job] }),
        queueFor: () => queueFor(f.cwd),
        'queueFor inspection': () => queueFor(f.cwd, { readOnly: true }),
        'queue transaction': () => f.queue.transaction(() => assert.fail('queue mutation ran')),
        enqueue: () => enqueue(f.queue, ['topic'], {}),
        checkDeclaredJobs: () => checkDeclaredJobs(f.queue, [job]),
        finishCleanup: () => finishCleanup(job, { outcome: 'promoted' }, f.queue),
        retryCleanup: () => retryCleanup(f.queue),
        admittedDeclaredTestPlan: () => admittedDeclaredTestPlan(context),
        planDeclaredGateBounded: () => planDeclaredGateBounded(context),
        planDeclaredGate: () => planDeclaredGate(context),
        assertExecutionBinding: () => assertExecutionBinding(spec),
        'captured-only execution binding': () => assertExecutionBinding(spec, { current: false }),
        executeDeclaredGate: () => executeDeclaredGate({ spec, env: f.env, evidence: context.evidence }),
        recheckDeclaredGate: () => recheckDeclaredGate({ spec, env: f.env, evidence: context.evidence }),
        validateExecution: () => validateExecution(spec),
        runDeclaredExecution: () => runDeclaredExecution(spec, f.resultFile),
        'runner recheck': () => runDeclaredExecution(spec, f.resultFile, { recheck: true }),
        'bounded output planner': () => boundedPlanner([JSON.stringify(['node', '--version'])]),
        runDeclaredCommand: () => runDeclaredCommand({ ...context, directory: spec.directory, command: 'node --version' }),
        prepareDeclared: () => prepareDeclared([{ run: 'node --version' }], context),
        receiptDirectory: () => receiptDirectory(f.project.identity),
        withReceiptLock: () => withReceiptLock(f.project.identity, 'key', spec.deadline, () => assert.fail('receipt lock callback ran')),
        publishSource: () => publishSource(spec.directory, { spec }),
        verifySource: () => verifySource(f.project.identity, f.resultFile, { key: 'key' }, spec.deadline),
        configSnapshot: () => configSnapshot({ cwd: f.cwd, env: f.env }),
        desksSnapshot: () => desksSnapshot(f.cwd),
        terminalTrainJobs: () => terminalTrainJobs({ file: f.receipt, project: f.project, jobs: [job] }),
        verifyTrainResult: () => verifyTrainResult({}, { project: f.project, saved: job }),
      };
      for (const [name, entry] of Object.entries(entries)) await t.test(name, () => { assert.throws(entry, refused); unchanged(); });
      for (const [name, entry] of Object.entries({
        train: () => runTrain({ file: f.receipt, ...f.project, ...(omitted ? { identity: undefined } : {}), main: 'main', prepare: [], validation: { declared: f.owner } }),
        'train recovery': () => runTrain({ file: f.receipt, ...f.project, main: 'main', prepare: [], validation: { declared: f.owner }, recoveryOnly: true }),
        drain: () => drain(f.queue),
        doctor: () => doctor({ ...f.options, observer: { observe() { assert.fail('observer ran before refusal'); } } }),
      })) await t.test(name, async () => { await assert.rejects(entry(), refused); unchanged(); });
      for (const action of ['promote', 'handle']) await t.test(`supervisor ${action} API`, () => {
        assert.throws(() => supervisor([action, 'R-999', '--repo', f.cwd, '--org', f.env.ORG_DIR, '--role', 'supervisor', '--why', 'inert witness']), refused); unchanged();
      });
      const cli = (relative, args, env = f.env) => {
        const result = spawnSync(process.execPath, [path.join(product, relative), ...args], { cwd, env, encoding: 'utf8' });
        assert.notEqual(result.status, 0, result.stdout + result.stderr);
        assert.match(result.stderr, /DECLARED_GATES_V2_INERT:.*ENG-538/); unchanged();
      };
      for (const mode of ['--lock', '--held', '--execute']) await t.test(`host ${mode}`, () => cli('promote/host-gate.mjs', [mode, f.cwd, f.receipt, '--version']));
      const input = { ...context }; delete input.env; delete input.evidence;
      for (const relative of ['promote/declared-plan-runner.mjs', 'promote/declared-planning.mjs'])
        await t.test(relative, () => cli(relative, [JSON.stringify(input), f.receipt]));
      await t.test('bounded output planner CLI', () => cli('promote/declared-planner.mjs', [JSON.stringify(['node', '--version'])]));
      for (const prefix of [[], ['--recheck']]) await t.test(`runner CLI ${prefix.join(' ')}`, () => cli('promote/declared-runner.mjs', [...prefix, JSON.stringify(spec), f.resultFile]));
      for (const args of [['topic'], ['--drain'], ['--resume'], ['--cleanup-job', job.id]])
        await t.test(`promote CLI ${args[0]}`, () => cli('promote/promote.mjs', [...args, '--repo', f.cwd]));
      for (const action of ['promote', 'handle']) await t.test(`supervisor ${action} CLI`, () => cli('supervisor/supervisor.mjs', [action, 'R-999', '--repo', f.cwd, '--org', f.env.ORG_DIR, '--role', 'supervisor', '--why', 'inert witness']));
      await t.test('settle CLI', () => cli('settle/settle.mjs', ['R-999', '--repo', f.cwd, '--org', f.env.ORG_DIR]));
      for (const args of [['check'], ['promote', 'topic'], ['promote-batch', f.receipt], ['config']]) await t.test(`lane ${args[0]}`, () => {
        cli('lanes/lane.mjs', args, { ...f.env, GIT_DIR: f.project.identity, GIT_WORK_TREE: f.cwd });
      });
    });
  }
});

test('committed v2 refuses from canonical and linked Git subdirectories before record, command or receipt effects', async t => {
  const f = declaredFixture(t), project = gitProject(f.repo), record = path.join(f.repo, '.org');
  assert.equal(policyLocation(f.repo, 'validation', f.env, { audit: false }).home, false);
  fs.mkdirSync(record); fs.writeFileSync(path.join(record, 'events.jsonl'), '');
  const shared = path.join(project.identity, 'lane-validation'), host = path.join(project.identity, 'inert-subdirectory.json');
  fs.mkdirSync(shared); fs.writeFileSync(path.join(shared, 'prior.json'), '{"prior":"preserve receipt"}\n');
  fs.writeFileSync(host, '{"prior":"preserve host receipt"}\n');
  for (const checkout of [f.repo, f.workspace]) {
    const cwd = path.join(checkout, 'nested/deeper'); fs.mkdirSync(cwd, { recursive: true });
    const local = path.join(checkout, '.lane'); fs.mkdirSync(local, { recursive: true });
    fs.writeFileSync(path.join(local, 'gate.json'), '{"prior":"preserve lane pointer"}\n');
    process.chdir(cwd);
    const roots = [record, shared, host, path.join(project.identity, 'promote'), local, f.log];
    const before = snapshot(roots), unchanged = () => assert.deepEqual(snapshot(roots), before);
    const entries = {
      'mode inspection': () => fenceDeclaredMode(cwd, { env: f.env }),
      'readDeclared audited': () => readDeclared(cwd, { env: f.env }),
      'readDeclared inspection': () => readDeclared(cwd, { env: f.env, audit: false }),
      resolveValidation: () => resolveValidation({ root: cwd, env: f.env }),
      canonicalValidation: () => canonicalValidation(cwd, f.env),
      validateTree: () => validateTree({ cwd, common: project.identity, env: f.env, tier: 'fast',
        command: 'node -e \'require("node:fs").writeFileSync(process.env.CHECK_LOG,"unexpected command")\'',
        onStart() { assert.fail('validation command admission ran'); } }),
      'identity fence': () => fenceGateIdentity(cwd, f.env),
      profile: () => resolveGateProfile(cwd, f.env),
      adapter: () => runProjectGateSync({ canonical: cwd, receipt: host, argv: ['--version'], env: f.env }),
      queueFor: () => queueFor(cwd),
      'queueFor inspection': () => queueFor(cwd, { readOnly: true }),
      configSnapshot: () => configSnapshot({ cwd, env: f.env }),
      desksSnapshot: () => desksSnapshot(cwd),
    };
    for (const [name, entry] of Object.entries(entries)) await t.test(`${path.basename(checkout)} subdirectory ${name}`, () => {
      assert.throws(entry, refused); unchanged();
    });
    await t.test(`${path.basename(checkout)} subdirectory doctor`, async () => {
      await assert.rejects(doctor({ cwd, env: f.env, observer: { observe() { assert.fail('observer ran'); } } }), refused); unchanged();
    });
    for (const action of ['promote', 'handle']) await t.test(`${path.basename(checkout)} subdirectory supervisor ${action}`, () => {
      assert.throws(() => supervisor([action, 'R-999', '--repo', cwd, '--org', record, '--role', 'supervisor', '--why', 'inert witness']), refused); unchanged();
    });
    for (const [relative, args] of [
      ...['--lock', '--held', '--execute'].map(mode => ['promote/host-gate.mjs', [mode, cwd, host, '--version']]),
      ...[['config'], ['check'], ['promote', 'topic'], ['promote-batch', host]].map(args => ['lanes/lane.mjs', args]),
      ['promote/promote.mjs', ['--drain', '--repo', cwd]],
      ['settle/settle.mjs', ['R-999', '--repo', cwd, '--org', record]],
    ]) await t.test(`${path.basename(checkout)} subdirectory ${relative} ${args[0]}`, () => {
      const result = f.run(process.execPath, [path.join(product, relative), ...args], cwd);
      assert.notEqual(result.status, 0, result.stdout + result.stderr);
      assert.match(result.stderr, /DECLARED_GATES_V2_INERT:.*ENG-538/); unchanged();
    });
  }
});

test('v2 detection needs no valid identity JSON, identity root or home link', async t => {
  const f = await fixture(t, 'malformed identity defaults');
  for (const bytes of ['{', JSON.stringify({ identity_root: 17 }), JSON.stringify({ identity_root: f.ownerRoot, launch: 17 })]) {
    fs.writeFileSync(f.binding.identityFile, bytes);
    const before = snapshot(f.roots);
    for (const entry of [() => fenceDeclaredMode(f.cwd, { env: f.env }), () => readDeclared(f.cwd, { env: f.env }),
      () => configSnapshot({ cwd: f.cwd, env: f.env }), () => queueFor(f.cwd, { readOnly: true })]) {
      assert.throws(entry, refused); assert.deepEqual(snapshot(f.roots), before);
    }
  }
});

test('committed v2 stays inert at bare Git roots and their linked subdirectories', async t => {
  const f = declaredFixture(t), bare = path.join(f.root, 'repository.git'), linked = path.join(f.root, 'bare-linked');
  f.git(['clone', '--bare', f.repo, bare]); f.git(['--git-dir', bare, 'worktree', 'add', linked, 'main']);
  const subdirectory = path.join(linked, 'nested/deeper'); fs.mkdirSync(subdirectory, { recursive: true });
  const receipts = path.join(bare, 'lane-validation'); fs.mkdirSync(receipts);
  fs.writeFileSync(path.join(receipts, 'prior.json'), '{"prior":"preserve receipt"}\n');
  const before = snapshot([bare, f.log]);
  for (const cwd of [bare, subdirectory]) for (const [name, entry] of Object.entries({
    'mode inspection': () => fenceDeclaredMode(cwd, { env: f.env }),
    readDeclared: () => readDeclared(cwd, { env: f.env }),
    canonicalValidation: () => canonicalValidation(cwd, f.env),
    validateTree: () => validateTree({ cwd, common: bare, command: 'node --version', tier: 'fast', env: f.env }),
    profile: () => resolveGateProfile(cwd, f.env),
    configSnapshot: () => configSnapshot({ cwd, env: f.env }),
  })) await t.test(`${path.basename(cwd)} ${name}`, () => {
    assert.throws(entry, refused); assert.deepEqual(snapshot([bare, f.log]), before);
  });
});

test('committed v2 stays inert at separate Git directories and checkout subdirectories', async t => {
  const f = declaredFixture(t), common = path.join(f.root, 'metadata/repository.git'), checkout = path.join(f.root, 'separate-checkout');
  fs.mkdirSync(path.dirname(common)); f.git(['clone', '--separate-git-dir', common, f.repo, checkout]);
  const subdirectory = path.join(checkout, 'nested/deeper'); fs.mkdirSync(subdirectory, { recursive: true });
  const receipts = path.join(common, 'lane-validation'); fs.mkdirSync(receipts);
  fs.writeFileSync(path.join(receipts, 'prior.json'), '{"prior":"preserve receipt"}\n');
  const before = snapshot([common, f.log]);
  for (const cwd of [common, subdirectory]) for (const [name, entry] of Object.entries({
    'mode inspection': () => fenceDeclaredMode(cwd, { env: f.env }),
    readDeclared: () => readDeclared(cwd, { env: f.env }),
    canonicalValidation: () => canonicalValidation(cwd, f.env),
    validateTree: () => validateTree({ cwd, common, command: 'node --version', tier: 'fast', env: f.env }),
    profile: () => resolveGateProfile(cwd, f.env),
    configSnapshot: () => configSnapshot({ cwd, env: f.env }),
  })) await t.test(`${path.basename(cwd)} ${name}`, () => {
    assert.throws(entry, refused); assert.deepEqual(snapshot([common, f.log]), before);
  });
});

test('inconclusive non-v2 inspection holds without audited fallback', async t => {
  const f = configFixture(t, { custom: 'owner' }); await f.adopt();
  const binding = f.binding(), project = gitProject(f.cwd);
  const defaults = JSON.parse(fs.readFileSync(binding.identityFile));
  fs.writeFileSync(binding.identityFile, JSON.stringify({ ...defaults, worktree_root: 17 }));
  const roots = [binding.record, path.join(path.dirname(binding.identityFile), '.org'), binding.directory, binding.identityFile,
    path.join(project.identity, 'lane-validation'), path.join(f.cwd, '.lane')], before = snapshot(roots);
  for (const entry of [() => readDeclared(f.cwd, { env: f.env }), () => configSnapshot({ cwd: f.cwd, env: f.env }),
    () => validateTree({ cwd: f.cwd, common: project.identity, command: 'node --version', tier: 'fast', env: f.env })]) {
    assert.throws(entry, /worktree_root/); assert.deepEqual(snapshot(roots), before);
  }
});

test('captured v2 cleanup and recovery remain inert after the owner removes its declaration', async t => {
  const f = declaredFixture(t, { declared: {} }), queue = queueFor(f.repo), project = queue.project;
  const job = { id: 'captured-v2', gate_mode: 'declared-gates/v2', declared: { schema: 'declared-gates/v2', value: declaration() }, cleanup: { state: 'pending' } };
  queue.transaction(data => data.results.push(job));
  const file = path.join(queue.directory, 'batches/captured-v2/train.json'); fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ schema: 'promotion-train/v2', jobs: [job] }));
  const before = snapshot([queue.directory]);
  for (const entry of [() => queueFor(f.repo), () => fenceDeclaredTarget(project), () => checkDeclaredJobs(queue, [job]),
    () => queue.transaction(() => assert.fail('captured v2 queue mutation ran')),
    () => finishCleanup(job, { outcome: 'promoted' }, queue), () => retryCleanup(queue),
    () => resolveGateProfile(f.repo, f.env, { captured: { jobs: [job] } }),
    () => terminalTrainJobs({ file: 'must not read', project, jobs: [job] }),
    () => verifyTrainResult({ source_head: f.base(), receipt: file }, { project, saved: { head: f.base() } })]) assert.throws(entry, refused);
  await assert.rejects(drain(queue), refused);
  await assert.rejects(runTrain({ file, canonical: f.repo, validation: {}, recoveryOnly: true }), refused);
  assert.deepEqual(snapshot([queue.directory]), before); assert.deepEqual(f.lines(), []);
});

test('mode refusal precedes v2 shape errors, overrides and caller bindings', t => {
  const value = { schema: 'declared-gates/v2', typo: true }, f = declaredFixture(t, { declared: value });
  assert.throws(() => readDeclared(f.repo, { env: { ...f.env, LANE_VALIDATE: 'true' }, override: 'true' }), refused);
  assert.throws(() => resolveValidation({ root: f.repo, config: { validation: value } }), refused);
  assert.throws(() => planDeclaredGate({}), refused);
  assert.throws(() => planDeclaredGateBounded({}), refused);
  assert.throws(() => admittedDeclaredTestPlan({}), refused);
  assert.throws(() => assertExecutionBinding({}), refused);
  assert.throws(() => validateExecution({}), refused);
});
