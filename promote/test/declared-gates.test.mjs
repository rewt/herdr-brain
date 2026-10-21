import test from '../../test/helpers/bounded-test.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { declaredFixture, declaration, product } from './helpers/declared-fixture.mjs';
import { bindRequirements, validateSelection } from '../declared-selection.mjs';
import { sameDeclaration } from '../declaration.mjs';
import { readDeclared } from '../../lanes/validation.mjs';
import { recheckDeclaredGate } from '../declared-gates.mjs';
import { executeDeclared } from '../declared-runner.mjs';
import { exactIdentity, explainMiss } from '../../lanes/exact-validation.mjs';
import { resolveGateProfile } from '../gate-profile.mjs';

const empty = () => ({ schema: 'promotion-tests/v2', files: [], steps: [] });
const typed = { runner: 'tool', args: ['whole.test.ts', '--maxWorkers=1', '--testTimeout=60000'] };
const required = () => bindRequirements([typed], declaration(), { scope: 'canonical', toolchain: 'locked' });

test('typed whole invocations, required unions and literal argv cannot be narrowed or covered by aliases', () => {
  const value = declaration(), bound = required();
  const step = { ...typed, reason: 'bound-required' };
  const valid = { ...empty(), steps: [step] };
  assert.doesNotThrow(() => validateSelection(valid, { declaration: value, required: bound }));
  for (const plan of [empty(), { ...empty(), steps: [{ ...step, args: [...typed.args, '-t', 'one case'] }] },
    { ...empty(), covered: [typed] }, { ...empty(), steps: [{ ...step, runner: 'missing' }] }])
    assert.throws(() => validateSelection(plan, { declaration: value, required: bound }));
  assert.throws(() => bindRequirements(bound, { ...value, runners: { ...value.runners, tool: { command: ['node', 'other.mjs'], cwd: '.' } } }, { scope: 'canonical', toolchain: 'locked' }), /changed/);
});

test('closed plans, hard bounds, optional budgets and deferred evidence are enforced independently', () => {
  const value = declaration(), options = { declaration: value };
  for (const plan of [{ ...empty(), extra: true }, { ...empty(), schema: 'promotion-tests/v1' },
    { ...empty(), files: ['../escape.test.mjs'] }, { ...empty(), files: ['a.test.mjs', 'a.test.mjs'] },
    { ...empty(), files: ['a.test.mjs'], covered: ['a.test.mjs'] }, { ...empty(), unknown: ['unmapped.ts'] },
    { ...empty(), steps: [{ runner: 'tool', args: [], reason: '' }] },
    { ...empty(), files: Array.from({ length: 513 }, (_, i) => `t${i}.test.mjs`) },
    { ...empty(), steps: Array.from({ length: 11 }, (_, i) => ({ runner: 'tool', args: [String(i)], reason: 'extra', estimated_ms: 1, estimate: 'measured' })) },
    { ...empty(), steps: [{ runner: 'tool', args: [], reason: 'x'.repeat(1024 * 1024) }] },
    { ...empty(), deferred: [{ ...typed, reason: 'later', destination: 'release-candidate', estimated_ms: -1, estimate: 'measured' }] }]) assert.throws(() => validateSelection(plan, options));
  const rows = Array.from({ length: 11 }, (_, i) => `t${i}.test.mjs`);
  const plan = validateSelection({ ...empty(), files: rows, budget: { required_over_budget: true } }, { ...options, required: rows });
  assert.equal(plan.budget.required_over_budget, true);
  assert.throws(() => validateSelection({ ...empty(), files: rows }, { ...options, required: rows }), /required_over_budget/);
  assert.throws(() => bindRequirements(Array(513).fill('a.test.mjs'), value, {}), /512/);
});

test('typed optional deferral succeeds while selected, covered, duplicate and required overlaps refuse', () => {
  const value = declaration(), bound = required();
  const later = { runner: 'tool', args: ['optional.test.ts'], reason: 'release coverage', destination: 'release-candidate', estimated_ms: 100, estimate: 'measured' };
  const plan = { ...empty(), steps: [{ ...typed, reason: 'required' }], deferred: [later] };
  assert.deepEqual(validateSelection(plan, { declaration: value, required: bound }).deferred, [later]);
  for (const invalid of [
    { ...plan, steps: [...plan.steps, { runner: later.runner, args: later.args, reason: 'also selected' }] },
    { ...plan, deferred: [later, later] },
    { ...plan, deferred: [{ ...later, ...typed }] },
    { ...plan, steps: [] },
    { ...plan, covered: ['covered.test.mjs'], deferred: [{ ...later, runner: 'node-test', args: ['covered.test.mjs'] }] },
  ]) assert.throws(() => validateSelection(invalid, { declaration: value, required: bound }), /overlap|omits|narrows/);
  value.runners.alias = value.runners.tool;
  assert.throws(() => validateSelection({ ...plan, deferred: [{ ...later, runner: 'alias', args: typed.args }] }, { declaration: value, required: bound }), /overlap/);
});

test('the base planner and imports ignore candidate edits and candidate loader paths', t => {
  const f = declaredFixture(t);
  const marker = path.join(f.root, 'lane-planner-ran');
  f.write('planner.mjs', `import fs from 'node:fs';fs.writeFileSync(${JSON.stringify(marker)},'bad');console.log('{}');`, f.workspace);
  f.write('inventory.mjs', "throw Error('lane import executed');", f.workspace); f.commit(f.workspace);
  const execution = f.plan({ env: { ...f.env, NODE_PATH: f.workspace, PYTHONPATH: f.workspace, TSX_TSCONFIG_PATH: path.join(f.workspace, 'tsconfig.json') } });
  assert.deepEqual(execution.plan.files, []);
  assert.equal(fs.existsSync(marker), false);
  assert.ok(execution.evidence.planner_source.paths > 0);
  assert.equal(execution.env.NODE_PATH, undefined);
  assert.ok(execution.command.endsWith("'"));
});

for (const kind of ['PATH directory', 'PATH executable', 'absolute planner', 'absolute preparation']) test(`a symlinked ${kind} into a lane refuses before project code`, t => {
  const value = declaration();
  if (kind.startsWith('PATH')) value.promotion_tests.prepare = [{ run: 'node baseline.mjs' }];
  const f = declaredFixture(t, { declared: value });
  const bin = path.join(f.root, 'external-bin'), laneBin = path.join(f.workspace, '.fixture/bin'), marker = path.join(f.root, 'lane-tool-ran');
  fs.mkdirSync(bin); fs.mkdirSync(laneBin, { recursive: true });
  const tool = path.join(laneBin, 'planner-tool'), link = path.join(bin, 'planner-tool');
  fs.writeFileSync(tool, `#!${process.execPath}\nrequire('fs').writeFileSync(${JSON.stringify(marker)},'bad');`, { mode: 0o755 });
  fs.symlinkSync(tool, link);
  if (kind === 'PATH directory') { const directory = path.join(f.root, 'linked-bin'); fs.symlinkSync(laneBin, directory); f.env.PATH = directory + path.delimiter + f.env.PATH; }
  else if (kind === 'PATH executable') f.env.PATH = bin + path.delimiter + f.env.PATH;
  else {
    if (kind === 'absolute planner') value.promotion_tests.command = [link];
    else value.promotion_tests.prepare = [{ run: link }];
    f.write('.lane.validation.json', JSON.stringify(value)); f.commit(); f.git(['rebase', 'main'], f.workspace);
  }
  assert.throws(() => f.plan(), /planner tool resolves into a candidate or lane/);
  assert.equal(fs.existsSync(marker), false); assert.deepEqual(f.lines(), []);
});

for (const file of ['package.json', 'runtime-lock.json', 'runner.mjs']) test(`canonical ${file} tampering refuses before the baseline`, t => {
  const f = declaredFixture(t);
  if (file !== 'runner.mjs') { f.write(file, file === 'package.json' ? '{"scripts":{"fixture":"node runner.mjs"}}' : '{"runtime":"one"}'); f.commit(); f.git(['rebase', 'main'], f.workspace); }
  f.write(file, file === 'package.json' ? '{"scripts":{"fixture":"true"}}' : file === 'runner.mjs' ? "console.log('narrowed');" : '{"runtime":"two"}', f.workspace); f.commit(f.workspace);
  assert.throws(() => f.plan(), /canonical orchestration/);
  assert.deepEqual(f.lines(), []);
});

test('preparation cannot replace tracked canonical planner inputs', t => {
  const value = declaration(); value.promotion_tests.prepare = [{ run: "node -e \"require('fs').writeFileSync('inventory.mjs','export const files=[]')\"" }];
  const f = declaredFixture(t, { declared: value });
  assert.throws(() => f.plan(), /changed canonical source/);
  assert.deepEqual(f.lines(), []);
});

test('source symlinks cannot import policy outside the canonical snapshot', t => {
  const f = declaredFixture(t), marker = path.join(f.root, 'escaped');
  const source = path.join(f.root, 'foreign-policy.mjs');
  fs.writeFileSync(source, `import fs from 'node:fs';fs.writeFileSync(${JSON.stringify(marker)},'bad');`);
  fs.symlinkSync(source, path.join(f.repo, 'outside.mjs'));
  f.write('planner.mjs', "import './outside.mjs';console.log(JSON.stringify({schema:'promotion-tests/v2',files:[],steps:[]}));");
  f.commit(); f.git(['rebase', 'main'], f.workspace);
  assert.throws(() => f.plan(), /planner failed/);
  assert.equal(fs.existsSync(marker), false);
});

test('an adapter with generated candidate orchestration refuses rather than recapturing a narrower runner', t => {
  const value = declaration(); value.runners.tool.command = ['node', 'dist/runner.mjs'];
  value.gate.prepare = [{ run: 'node make.mjs' }];
  const f = declaredFixture(t, { declared: value });
  f.write('make.mjs', "import fs from 'node:fs';fs.mkdirSync('dist',{recursive:true});fs.writeFileSync('dist/runner.mjs','process.exit(0)');");
  f.commit(); f.git(['rebase', 'main'], f.workspace);
  assert.throws(() => f.plan(), /uncaptured generated runner/);
  assert.deepEqual(f.lines(), []);
});

test('Python helper imports and their transitive modules are bound before driver execution', t => {
  const value = declaration(); value.runners.python = { command: ['python3'], cwd: '.' };
  const f = declaredFixture(t, { declared: value });
  f.write('scripts/driver.py', 'import driver_support\ndriver_support.run()\n');
  f.write('scripts/driver_support.py', 'from controls import check\ndef run():\n    check()\n');
  f.write('scripts/controls.py', 'def check():\n    assert True\n');
  f.commit(); f.git(['rebase', 'main'], f.workspace);
  const obligation = [{ runner: 'python', args: ['scripts/driver.py'] }];
  const original = f.plan({ required: obligation });
  assert.ok(original.spec.policy.files.some(([name]) => name === 'scripts/driver_support.py'));
  assert.ok(original.spec.policy.files.some(([name]) => name === 'scripts/controls.py'));
  f.write('scripts/controls.py', 'def check():\n    pass\n', f.workspace); f.commit(f.workspace);
  assert.throws(() => f.plan({ required: original.plan.required }), /changed|canonical orchestration/);
  assert.deepEqual(f.lines(), []);
});

test('an undeclared generated Python helper refuses before the baseline', t => {
  const value = declaration(); value.runners.python = { command: ['python3'], cwd: '.' };
  value.gate.prepare = [{ run: 'node make.mjs' }];
  const f = declaredFixture(t, { declared: value });
  f.write('driver.py', 'import driver_support\n');
  f.write('make.mjs', "import fs from 'node:fs';fs.mkdirSync('.fixture',{recursive:true});fs.writeFileSync('.fixture/driver_support.py','pass');");
  f.commit(); f.git(['rebase', 'main'], f.workspace);
  assert.throws(() => f.plan({ required: [{ runner: 'python', args: ['driver.py'] }] }), /uncaptured generated Python import/);
  assert.deepEqual(f.lines(), []);
});

test('preparation has one finite attempt deadline and retains its failed command evidence', t => {
  const value = declaration(); delete value.promotion_tests; value.gate.prepare = [{ run: 'node -e "setTimeout(()=>{},60000)"' }];
  const f = declaredFixture(t, { declared: value }), evidence = { commands: [] };
  assert.throws(() => f.plan({ deadline: Date.now() + 2000, limits: { wall_seconds: 2, idle_seconds: 0 }, evidence }), /timed out|deadline/);
  assert.ok(evidence.commands.some(row => row.kind === 'prepare' && (row.timeout || row.error || row.signal || row.exit_code !== 0)));
  assert.deepEqual(f.lines(), []);
});

for (const output of ["process.stdout.write('{')", "process.stdout.write('x'.repeat(1048577))", 'setTimeout(()=>{},60000)']) test(`malformed, oversized or timed-out planner refuses (${output.slice(0, 25)})`, t => {
  const f = declaredFixture(t); f.write('planner.mjs', output); f.commit(); f.git(['rebase', 'main'], f.workspace);
  const evidence = { commands: [] };
  assert.throws(() => f.plan({ deadline: Date.now() + 3500, limits: { wall_seconds: 3.5, idle_seconds: 0 }, evidence }), /malformed|planner failed|deadline/);
  assert.ok(evidence.commands.some(row => row.kind === 'planner'));
  assert.deepEqual(f.lines(), []);
});

test('the literal complete selection runs ordered argv and failures stop later work', t => {
  const f = declaredFixture(t);
  const args = ["a';touch injected;#", '--maxWorkers=1'];
  const execution = f.plan({ required: [{ runner: 'tool', args }] });
  const env = { ...execution.env, MONITOR_VALIDATION_DEADLINE: String(execution.deadline) };
  const commands = [];
  assert.equal(executeDeclared(execution.spec, { cwd: f.workspace, env, onCommand: row => commands.push(row) }), 0);
  assert.equal(commands.length, 2); assert.deepEqual(JSON.parse(f.lines()[1]), args);
  assert.equal(fs.existsSync(path.join(f.workspace, 'injected')), false);
  assert.ok(execution.command.includes(JSON.stringify(execution.spec).replaceAll("'", "'\\''")));
  const changed = { ...execution.spec, selection: { ...execution.spec.selection, steps: [] } };
  assert.throws(() => executeDeclared(changed, { cwd: f.workspace, env }), /omits|narrows/);
});

test('selection/runtime changes miss exact evidence and an admitted owner change needs re-admission', t => {
  const f = declaredFixture(t), execution = f.plan();
  const options = { cwd: f.workspace, common: f.queue().project.identity, base: f.base(), commands: [execution.command],
    declaration: { schema: 'validation-receipts/v1', exclude: [], environment: ['PATH'] }, env: f.env, additional: { declared_gate: execution.spec } };
  const identity = exactIdentity(options);
  assert.equal(explainMiss(exactIdentity({ ...options, additional: { declared_gate: { ...execution.spec, runtime: {} } } }), identity), 'declared');
  assert.equal(explainMiss(exactIdentity({ ...options, commands: [execution.command + ' changed'] }), identity), 'commands');
  assert.throws(() => recheckDeclaredGate({ repo: f.repo, cwd: f.workspace, owner: execution.spec.declaration,
    spec: { ...execution.spec, runtime: { tool: [] } }, env: execution.env, deadline: execution.deadline }), /runtime changed/);
  const bound = readDeclared(f.repo, { env: f.env });
  f.write('.lane.validation.json', JSON.stringify({ ...declaration(), promotion: 'true' })); f.commit();
  assert.throws(() => sameDeclaration(bound, readDeclared(f.repo, { env: f.env })), /re-enqueue/);
});

test('replacing a mandatory-only runtime at the same path invalidates recheck and exact reuse', t => {
  const value = declaration(); value.promotion = 'python3 gate.py'; value.runners = {}; delete value.promotion_tests;
  const f = declaredFixture(t, { declared: value }), bin = path.join(f.root, 'bin'); fs.mkdirSync(bin);
  const python = path.join(bin, 'python3');
  fs.writeFileSync(python, `#!${process.execPath}\n// runtime one\nprocess.exit(0);\n`, { mode: 0o755 });
  f.env.PATH = bin + path.delimiter + f.env.PATH;
  f.write('gate.py', 'pass\n'); f.commit(); f.git(['rebase', 'main'], f.workspace);
  const first = f.plan();
  assert.deepEqual(first.spec.runtime, {}); assert.ok(first.spec.promotion_runtime.length >= 2);
  assert.doesNotThrow(() => recheckDeclaredGate({ repo: f.repo, cwd: f.workspace, owner: first.spec.declaration,
    spec: first.spec, env: first.env, deadline: first.deadline }));
  fs.writeFileSync(python, `#!${process.execPath}\n// runtime two at the identical path\nprocess.exit(0);\n`, { mode: 0o755 });
  assert.throws(() => recheckDeclaredGate({ repo: f.repo, cwd: f.workspace, owner: first.spec.declaration,
    spec: first.spec, env: first.env, deadline: first.deadline }), /mandatory command runtime changed/);
  const second = f.plan();
  assert.notDeepEqual(first.spec.promotion_runtime, second.spec.promotion_runtime);
  const options = { cwd: f.workspace, common: f.queue().project.identity, base: f.base(), commands: ['same command'],
    declaration: { schema: 'validation-receipts/v1', exclude: [], environment: ['PATH'] }, env: f.env };
  assert.equal(explainMiss(exactIdentity({ ...options, additional: { declared_gate: second.spec } }),
    exactIdentity({ ...options, additional: { declared_gate: first.spec } })), 'declared');
  assert.deepEqual(f.lines(), []);
});

for (const promotion of ['node baseline.mjs && python3 gate.py', 'env python3 gate.py', 'pnpm run smoke']) test(`unresolved mandatory runtime provenance refuses (${promotion})`, t => {
  const value = declaration(); value.promotion = promotion; delete value.promotion_tests; value.runners = {};
  const f = declaredFixture(t, { declared: value });
  assert.throws(() => f.plan(), /unresolved.*runtime provenance/);
  assert.deepEqual(f.lines(), []);
});

test('real pnpm build, native Vitest TypeScript, TypeScript-importing planner, Python driver and node:test keep their context', { timeout: 60000 }, t => {
  const artifact = process.env.DECLARED_GATES_FIXTURE_ARTIFACT;
  if (!artifact) return t.skip('requires an explicit hash-locked offline runtime fixture artifact');
  const value = declaration();
  value.promotion_tests = { command: ['node', '.planner/planner.js'], prepare: [{ run: 'node prepare.mjs' }, { run: 'node compile.cjs' }] };
  value.gate.prepare = [{ run: 'node prepare.mjs' }];
  value.runners = { 'node-test': { command: ['node', '--test'], cwd: '.' },
    pnpm: { command: ['./node_modules/.bin/pnpm'], cwd: '.' },
    vitest: { command: ['./node_modules/.bin/pnpm', 'exec', 'vitest', 'run'], cwd: '.' },
    python: { command: ['python3'], cwd: '.' } };
  const f = declaredFixture(t, { declared: value });
  f.env.DECLARED_GATES_FIXTURE_ARTIFACT = artifact;
  Object.assign(f.env, { CI: '1', npm_config_offline: 'true', npm_config_update_notifier: 'false' });
  f.write('runtime-lock.json', JSON.stringify({ sha256: createHash('sha256').update(fs.readFileSync(artifact)).digest('hex') }));
  f.write('prepare.mjs', `import fs from 'node:fs';import {createHash} from 'node:crypto';import {execFileSync} from 'node:child_process';
const bytes=fs.readFileSync(process.env.DECLARED_GATES_FIXTURE_ARTIFACT);if(createHash('sha256').update(bytes).digest('hex')!==JSON.parse(fs.readFileSync('runtime-lock.json')).sha256)throw Error('unlocked artifact');execFileSync('tar',['-xf',process.env.DECLARED_GATES_FIXTURE_ARTIFACT]);`);
  f.write('compile.cjs', `const fs=require('fs'),ts=require('typescript');fs.mkdirSync('.planner',{recursive:true});for(const name of ['planner','inventory'])fs.writeFileSync('.planner/'+name+'.js',ts.transpileModule(fs.readFileSync(name+'.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,esModuleInterop:true}}).outputText);`);
  f.write('inventory.ts', "export const caps: string[] = ['--maxWorkers=1','--testTimeout=60000'];");
  f.write('planner.ts', `import fs from 'node:fs';import {caps} from './inventory';const input=JSON.parse(fs.readFileSync(0,'utf8'));if(process.cwd()===input.candidate_root)throw Error('candidate policy');console.log(JSON.stringify({schema:'promotion-tests/v2',files:['whole.test.mjs'],steps:[{runner:'pnpm',args:['run','fixture-build'],reason:'dependency build'},{runner:'vitest',args:['native.test.ts',...caps],reason:'whole native suite'},{runner:'python',args:['scripts/driver.py'],reason:'fixture and controls'}]}));`);
  f.write('package.json', JSON.stringify({ private: true, scripts: { 'fixture-build': 'node build.mjs' } }));
  f.write('vitest.config.mjs', "export default {cacheDir:'.fixture/vite',test:{cache:false}};\n");
  f.write('build.mjs', "import fs from 'node:fs';fs.mkdirSync('dist',{recursive:true});fs.writeFileSync('dist/product.mjs','export const value='+JSON.stringify(fs.readFileSync('product.txt','utf8'))+';');fs.appendFileSync(process.env.CHECK_LOG,'build\\n');");
  f.write('native.test.ts', "import {test,expect} from 'vitest';import {value} from './dist/product.mjs';test('whole suite',()=>expect(value).toBe('candidate'));test('second control',()=>expect(value.length).toBe(9));");
  f.write('driver.test.ts', "import {test,expect} from 'vitest';import fs from 'node:fs';test('driver control',()=>expect(fs.readFileSync('.fixture/control','utf8')).toBe('ready'));");
  f.write('scripts/driver.py', "import os,subprocess\nos.makedirs('.fixture',exist_ok=True)\nopen('.fixture/control','w').write('ready')\nsubprocess.run(['node','node_modules/vitest/vitest.mjs','run','driver.test.ts','--maxWorkers=1'],check=True)\nopen(os.environ['CHECK_LOG'],'a').write('driver\\n')\n");
  f.write('whole.test.mjs', "import test from 'node:test';import fs from 'node:fs';test('whole node file',()=>fs.appendFileSync(process.env.CHECK_LOG,'node-test\\n'));");
  f.commit(); f.git(['rebase', 'main'], f.workspace);
  const execution = f.plan();
  const commands = [];
  assert.equal(executeDeclared(execution.spec, { cwd: f.workspace, env: { ...execution.env, MONITOR_VALIDATION_DEADLINE: String(execution.deadline) }, onCommand: row => commands.push(row) }), 0);
  assert.deepEqual(f.lines(), ['baseline', 'build', 'driver', 'node-test']);
  assert.equal(commands.length, 5);
  assert.ok(execution.evidence.planner_dependencies.versions.some(row => row.name === 'typescript'));
  assert.ok(execution.evidence.dependencies.versions.some(row => row.name === 'vitest'));
  assert.ok(execution.evidence.runtime.python[0].binding.version.startsWith('Python'));
});
