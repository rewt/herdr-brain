import test from '../../test/helpers/bounded-test.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { declaration, declaredFixture, emptySelection, reuseInputs } from './helpers/declared-fixture.mjs';
import { selectDeclared, bindRequirements, unionRequirements } from '../declared-selection.mjs';
import { validateExecution } from '../declared-runner.mjs';
import { serializeExecution, recheckDeclaredGate } from '../declared-gates.mjs';
import { planDeclaredGateBounded } from '../declared-gates.mjs';
import { executionIdentity } from '../execution-identity.mjs';
import { readDeclared } from '../../lanes/validation.mjs';
import { validateDeclared } from '../declaration.mjs';
import { observePaths, inputEligibility } from '../declared-inputs.mjs';

test('canonical IDs and declared whole-file coverage retain exact gate definitions and budgets', () => {
  const value = declaration(), required = bindRequirements(['whole.test.ts', { gate: 'tool' }], value);
  const selected = { ...emptySelection(), gates: [{ id: 'tool', reason: 'required', estimated_ms: 900000 }] };
  const plan = selectDeclared(selected, value, required);
  assert.equal(plan.budget.required_over_budget, true); assert.ok(plan.coverage.includes('whole.test.ts'));
  for (const bad of [emptySelection(), { ...selected, command: 'true' }, { ...selected, unknown: ['unmapped'] },
    { ...selected, gates: [...selected.gates, ...selected.gates] }, { ...selected, gates: [{ id: 'missing', reason: 'x' }] },
    { ...selected, gates: [{ id: 'tool', reason: 'x', args: ['-t', 'narrow'] }] },
    { ...selected, deferred: [{ id: 'tool', reason: 'later', destination: 'release-candidate' }] }]) assert.throws(() => selectDeclared(bad, value, required));
  assert.throws(() => selectDeclared(selected, value, []), /budget/);
  const edited = structuredClone(value); edited.gates.tool.command += ' --filter narrow';
  assert.throws(() => bindRequirements(required, edited), /definition changed/);
  assert.equal(unionRequirements([{ requiredTests: required }, { requiredTests: required }]).length, 2);
  assert.throws(() => unionRequirements([{ requiredTests: required }, { requiredTests: [{ ...required[1], definition: edited.gates.tool }] }]), /conflicting/);
});

test('positive deferred work retains estimates and destination but supplies no required coverage', () => {
  const value = declaration(), plan = { ...emptySelection(), deferred: [{ id: 'tool', reason: 'release extras', estimated_ms: 12, estimate: 'measured', destination: 'release-candidate' }] };
  assert.deepEqual(selectDeclared(plan, value, []).deferred, plan.deferred);
  assert.throws(() => selectDeclared(plan, value, ['whole.test.ts']), /missing required/);
  for (const key of ['gates', 'deferred', 'unknown']) assert.throws(() => selectDeclared({ ...emptySelection(), [key]: Array(513).fill({}) }, value, []));
});

test('canonical planner/imports ignore candidate edits and immutable argv cannot omit selection or requirements', t => {
  const f = declaredFixture(t), marker = path.join(f.root, 'candidate-planner');
  f.write('planner.mjs', `import fs from 'node:fs';fs.writeFileSync(${JSON.stringify(marker)},'bad');`, f.workspace);
  f.write('inventory.mjs', "throw Error('candidate inventory ran');", f.workspace); f.commit(f.workspace);
  const execution = f.plan({ required: ['whole.test.ts'] });
  assert.deepEqual(execution.plan.gates.map(row => row.id), ['tool']); assert.equal(fs.existsSync(marker), false);
  const bad = structuredClone(execution.spec); bad.commands.pop();
  assert.throws(() => validateExecution(bad), /order\/definition/);
  const oversized = { ...execution.spec, changed: ['x'.repeat(100000)] };
  assert.throws(() => serializeExecution(oversized), /96 KiB/);
  assert.throws(() => validateDeclared({ ...declaration(), schema: 'declared-gates/v1' }), /unsupported/);
});

test('opaque commands keep shell bytes, quoting, cwd and order, and allow reviewed candidate helper edits', t => {
  const value = declaration();
  value.gates.tool.command = "node runner.mjs 'a; touch injected' \"quoted arg\"";
  const f = declaredFixture(t, { declared: value });
  f.write('runner.mjs', "import fs from 'node:fs';fs.appendFileSync(process.env.CHECK_LOG,'candidate helper '+JSON.stringify(process.argv.slice(2))+'\\n');", f.workspace); f.commit(f.workspace);
  const execution = f.plan({ required: [{ gate: 'tool' }] }), gate = f.execute(execution);
  assert.equal(gate.exit_code, 0); assert.deepEqual(gate.command_order, [value.promotion, value.gates.tool.command]);
  assert.deepEqual(f.lines(), ['baseline', 'candidate helper ["a; touch injected","quoted arg"]']);
  assert.equal(fs.existsSync(path.join(f.workspace, 'injected')), false);
  assert.equal(gate.gates.every(row => row.outcome === 'executed'), true);
});

test('one mandatory failure retains exit, immutable logs and not-reached outcomes', t => {
  const f = declaredFixture(t);
  f.write('baseline.mjs', "console.log('negative control');process.exit(9);", f.workspace); f.commit(f.workspace);
  const gate = f.execute(f.plan({ required: [{ gate: 'tool' }] }));
  assert.equal(gate.exit_code, 9); assert.equal(gate.outcome, 'red');
  assert.deepEqual(gate.gates.map(row => row.outcome), ['failed', 'not reached']);
  assert.match(fs.readFileSync(gate.gates[0].execution.log, 'utf8'), /negative control/);
  assert.ok(gate.gates[0].execution.execution_hash); assert.deepEqual(f.lines(), []);
});

test('canonical preparation cannot alter captured tracked snapshot source', t => {
  const value = declaration(); value.promotion_tests.prepare = [{ run: "printf changed > inventory.mjs" }];
  const f = declaredFixture(t, { declared: value });
  assert.throws(() => f.plan(), /snapshot tracked source changed/); assert.deepEqual(f.lines(), []);
});

test('input digests bind bytes, modes, absent paths, membership, ignored output and contained symlinks', t => {
  const f = declaredFixture(t), deadline = Date.now() + 20000;
  const observe = () => observePaths(f.workspace, ['.fixture/**', 'product.txt', 'absent'], deadline).digest;
  const first = observe(); f.write('.fixture/input', 'one', f.workspace); const added = observe(); assert.notEqual(added, first);
  f.write('.fixture/input', 'two', f.workspace); const bytes = observe(); assert.notEqual(bytes, added);
  fs.chmodSync(path.join(f.workspace, '.fixture/input'), 0o700); const mode = observe(); assert.notEqual(mode, bytes);
  f.write('absent', '', f.workspace); const presence = observe(); assert.notEqual(presence, mode);
  fs.unlinkSync(path.join(f.workspace, '.fixture/input')); assert.notEqual(observe(), presence);
  fs.symlinkSync(f.log, path.join(f.workspace, '.fixture/outside'));
  assert.throws(() => observe(), /ENOENT|escapes/);
});

test('declared-inputs reuses an executed pass across unrelated commits and preserves source logs', t => {
  const value = declaration(); value.inputs = { promotion: reuseInputs() }; delete value.promotion_tests;
  const f = declaredFixture(t, { declared: value }), first = f.execute();
  assert.equal(first.gates[0].outcome, 'executed'); assert.ok(first.gates[0].source);
  f.write('unrelated', 'new commit', f.workspace); f.commit(f.workspace);
  const second = f.execute();
  assert.equal(second.gates[0].outcome, 'reused'); assert.equal(f.lines().length, 1);
  assert.equal(second.gates[0].source, first.gates[0].source); assert.equal(second.gates[0].source_candidate, first.head);
  assert.equal(second.gates[0].source_log, first.gates[0].execution.log);
  assert.ok(second.gates[0].integration_observation);
});

for (const dimension of ['content', 'deletion', 'glob membership', 'mode', 'environment absent-empty', 'toolchain output', 'runtime version output', 'source log integrity', 'execution sidecar integrity', 'reused pointer integrity']) test(`declared-inputs executes once on a ${dimension} miss`, t => {
  const value = declaration(); value.inputs = { promotion: reuseInputs() }; delete value.promotion_tests;
  if (dimension === 'toolchain output') value.inputs.promotion.toolchains.runner = 'cat .fixture/version';
  if (dimension === 'runtime version output') value.inputs.promotion.toolchains.runtime = 'cat .fixture/version';
  const f = declaredFixture(t, { declared: value });
  f.write('.fixture/version', 'v1', f.workspace); f.write('.fixture/input', 'input', f.workspace);
  const first = f.execute(); assert.equal(first.gates[0].outcome, 'executed');
  if (dimension === 'content') { f.write('product.txt', 'changed again', f.workspace); f.commit(f.workspace); }
  if (dimension === 'deletion') { f.git(['rm', 'product.txt'], f.workspace); f.commit(f.workspace); }
  if (dimension === 'glob membership') f.write('.fixture/input-added', 'new ignored input', f.workspace);
  if (dimension === 'mode') fs.chmodSync(path.join(f.workspace, '.fixture/input'), 0o700);
  if (dimension === 'environment absent-empty') f.env.DECLARED_INPUT = '';
  if (['toolchain output', 'runtime version output'].includes(dimension)) f.write('.fixture/version', 'v2', f.workspace);
  if (dimension === 'source log integrity') fs.appendFileSync(first.gates[0].execution.log, 'edited');
  if (dimension === 'execution sidecar integrity') fs.appendFileSync(first.gates[0].execution.execution_receipt, '\n');
  if (dimension === 'reused pointer integrity') {
    const reused = f.execute(); assert.equal(reused.gates[0].outcome, 'reused');
    const pointer = path.join(path.dirname(first.gates[0].source), `${first.gates[0].observation.key}.pointer.json`);
    fs.writeFileSync(pointer, JSON.stringify({ file: reused.result, receipt_hash: reused.result_hash }));
  }
  const second = f.execute(); assert.equal(second.gates[0].outcome, 'executed'); assert.equal(f.lines().length, 2);
});

test('missing runtime/runner, missing input declarations and failed probes cannot mint reusable evidence', () => {
  const inputs = reuseInputs();
  assert.equal(inputEligibility(inputs), null);
  for (const incomplete of [undefined, {}, { ...inputs, environment: undefined }, { ...inputs, paths: [] },
    { ...inputs, toolchains: { runtime: 'node --version' } }, { ...inputs, toolchains: { runner: 'tool --version' } }]) assert.ok(inputEligibility(incomplete));
  assert.ok(inputEligibility(inputs, { OUTSIDE: 'literal' }));
});

test('a reused input changed before integration executes once under current inputs', t => {
  const value = declaration(); value.inputs = { promotion: reuseInputs() }; delete value.promotion_tests;
  const f = declaredFixture(t, { declared: value }); f.execute();
  const execution = f.plan(), second = f.execute(execution); assert.equal(second.gates[0].outcome, 'reused');
  f.write('.fixture/input-late', 'changed', f.workspace);
  const checked = recheckDeclaredGate({ spec: execution.spec, env: f.env, evidence: execution.evidence });
  assert.equal(checked.gates[0].outcome, 'executed'); assert.equal(checked.gates[0].reexecuted, true); assert.equal(f.lines().length, 2);
});

for (const dimension of ['command bytes', 'cwd', 'coverage', 'ordered preparation', 'environment salt', 'wall limit', 'idle limit', 'host policy', 'input specification', 'allowlist names', 'runtime probe declaration', 'runner probe declaration']) test(`declared-inputs executes once when ${dimension} change`, t => {
  const value = declaration(), f = declaredFixture(t, { declared: value });
  value.promotion = 'true'; value.gates.tool.command = `node '${f.workspace}/runner.mjs'`;
  value.gates.tool.inputs = { ...reuseInputs(), paths: ['runner.mjs', 'product.txt', '.fixture/input*'] };
  f.write('nested/.keep', ''); f.write('.lane.validation.json', JSON.stringify(value)); f.commit(); f.git(['rebase', 'main'], f.workspace);
  const required = [{ gate: 'tool' }], first = f.execute(f.plan({ required })); assert.equal(first.gates[1].outcome, 'executed'); assert.ok(first.gates[1].source);
  if (dimension === 'command bytes') value.gates.tool.command += ' "other argument"';
  if (dimension === 'cwd') value.gates.tool.cwd = 'nested';
  if (dimension === 'coverage') value.gates.tool.covers.push('additional reviewed coverage');
  if (dimension === 'ordered preparation') value.gate.prepare = [{ run: ': first' }, { run: ': second' }];
  if (dimension === 'environment salt') value.environment = 'new declared environment';
  if (dimension === 'wall limit') value.timeout_seconds.promotion++;
  if (dimension === 'idle limit') value.idle_timeout_seconds = { promotion: 10 };
  if (dimension === 'host policy') value.gate.wait_seconds = 10;
  if (dimension === 'input specification') value.gates.tool.inputs.paths.push('absent-but-now-declared');
  if (dimension === 'allowlist names') value.gates.tool.inputs.environment.push('ALSO_DECLARED');
  if (dimension === 'runtime probe declaration') value.gates.tool.inputs.toolchains.runtime = 'node -v';
  if (dimension === 'runner probe declaration') value.gates.tool.inputs.toolchains.runner = 'node -v';
  f.write('.lane.validation.json', JSON.stringify(value)); f.commit(); f.git(['rebase', 'main'], f.workspace);
  const second = f.execute(f.plan({ required })); assert.equal(second.gates[1].outcome, 'executed'); assert.equal(f.lines().length, 2);
});

test('allowlisted execution omits ambient values and receipts contain digests instead of environment values', t => {
  const value = declaration(); value.inputs = { promotion: reuseInputs() }; delete value.promotion_tests;
  const f = declaredFixture(t, { declared: value });
  f.write('baseline.mjs', "import fs from 'node:fs';if(process.env.UNLISTED_TEST_VALUE!==undefined)throw Error('ambient value leaked');fs.appendFileSync(process.env.CHECK_LOG,'baseline\\n');", f.workspace); f.commit(f.workspace);
  f.env.UNLISTED_TEST_VALUE = 'ambient-private-fixture-string'; f.env.DECLARED_INPUT = 'nonsecret-allowlisted-fixture-string';
  const gate = f.execute(); assert.equal(gate.exit_code, 0);
  const receipt = fs.readFileSync(gate.gates[0].source, 'utf8');
  assert.equal(receipt.includes(f.env.UNLISTED_TEST_VALUE), false); assert.equal(receipt.includes(f.env.DECLARED_INPUT), false);
  assert.equal(receipt.includes(f.env.CHECK_LOG), false);
});

test('failed probes, missing input roles, unstable paths and always-execute never reuse a pass', t => {
  const value = declaration(); value.inputs = { promotion: reuseInputs() }; value.inputs.promotion.toolchains.runner = 'exit 7'; delete value.promotion_tests;
  const f = declaredFixture(t, { declared: value });
  const first = f.execute(), second = f.execute();
  assert.equal(first.gates[0].source, undefined); assert.equal(second.gates[0].outcome, 'executed'); assert.equal(f.lines().length, 2);
  assert.match(second.gates[0].reuse.reason, /probe unavailable/);
  value.receipt_reuse = 'always-execute'; f.write('.lane.validation.json', JSON.stringify(value)); f.commit(); f.git(['rebase', 'main'], f.workspace);
  const third = f.execute(); assert.equal(third.gates[0].outcome, 'executed'); assert.equal(f.lines().length, 3);
  assert.equal(JSON.parse(fs.readFileSync(third.result, 'utf8')).commands.some(row => row.kind === 'version-probe'), false);
});

test('input enumeration and byte ceilings are hard refusals of reuse evidence', t => {
  const f = declaredFixture(t), deadline = Date.now() + 10000, large = path.join(f.workspace, '.fixture/large');
  fs.mkdirSync(path.dirname(large), { recursive: true }); fs.writeFileSync(large, ''); fs.truncateSync(large, 64 * 1024 * 1024 + 1);
  assert.throws(() => observePaths(f.workspace, ['.fixture/large'], deadline), /64 MiB/);
  fs.unlinkSync(large);
  for (let i = 0; i < 10001; i++) fs.writeFileSync(path.join(f.workspace, `.fixture/${i}`), '');
  assert.throws(() => observePaths(f.workspace, ['.fixture/**'], deadline), /10000 paths/);
});

test('Python module, inline and shell-quoted executable spellings remain ordinary opaque commands', t => {
  const value = declaration(); value.gates.python = { command: `python3 -m fixture_driver && py""thon3 -c 'import os;open(os.environ["CHECK_LOG"],"a").write("python inline\\n")'`, cwd: '.', covers: ['fixture:python-controls'] };
  const f = declaredFixture(t, { declared: value });
  f.write('fixture_driver.py', "import os\nwith open(os.environ['CHECK_LOG'],'a') as log:\n    log.write('python module\\n')\n"); f.commit(); f.git(['rebase', 'main'], f.workspace);
  const gate = f.execute(f.plan({ required: [{ gate: 'python' }] }));
  assert.equal(gate.exit_code, 0); assert.equal(gate.command_order[1], value.gates.python.command);
  assert.deepEqual(f.lines(), ['baseline', 'python module', 'python inline']);
});

test('a signaled gate preserves its original signal and prevents later commands', t => {
  const value = declaration(); value.gates.tool.command = 'kill -TERM $$';
  const f = declaredFixture(t, { declared: value }), gate = f.execute(f.plan({ required: [{ gate: 'tool' }] }));
  assert.equal(gate.outcome, 'red'); assert.equal(gate.gates[1].execution.signal, 'SIGTERM'); assert.equal(gate.gates[1].execution.exit_code, null);
  assert.deepEqual(f.lines(), ['baseline']);
});

for (const scenario of ['malformed planner', 'oversized planner', 'planner preparation deadline', 'candidate preparation deadline', 'gate deadline']) test(`bounded ${scenario} preserves failed command logs and prevents a green pass`, t => {
  const value = declaration(); value.timeout_seconds.promotion = scenario.includes('deadline') ? 2 : 20;
  if (scenario === 'planner preparation deadline') value.promotion_tests.prepare = [{ run: 'node -e "setTimeout(()=>{},60000)"' }];
  if (scenario === 'candidate preparation deadline') value.gate.prepare = [{ run: 'node -e "setTimeout(()=>{},60000)"' }];
  if (scenario === 'gate deadline') value.promotion = 'node -e "setTimeout(()=>{},60000)"';
  const f = declaredFixture(t, { declared: value });
  if (scenario === 'malformed planner') f.write('planner.mjs', "console.log('{');");
  if (scenario === 'oversized planner') f.write('planner.mjs', "process.stdout.write('x'.repeat(1048577));");
  if (scenario.includes('planner') && !scenario.includes('preparation')) { f.commit(); f.git(['rebase', 'main'], f.workspace); }
  const evidence = { commands: [] }, project = f.queue().project;
  const plan = () => planDeclaredGateBounded({ repo: f.repo, common: project.identity, cwd: f.workspace, base: f.base(), candidate: f.head(),
    owner: readDeclared(f.repo), identity: executionIdentity(project), required: [], changed: ['product.txt'], env: f.env, evidence });
  if (scenario.includes('planner')) {
    assert.throws(plan, /planning|planner|deadline|JSON/);
    assert.ok(evidence.commands.length > 0); assert.ok(fs.existsSync(evidence.commands[0].log));
  } else {
    const execution = plan();
    assert.throws(() => f.execute({ ...execution, evidence }), /deadline|limits|execution/);
    assert.ok(evidence.execution?.commands.length > 0); assert.ok(fs.existsSync(evidence.execution.commands[0].log));
  }
  assert.deepEqual(f.lines(), []);
});
