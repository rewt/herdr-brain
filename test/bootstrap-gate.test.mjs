import test from './helpers/bounded-test.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { plannedCommand, noRetryCommand, quote } from '../promote/test-plan.mjs';
import { releasePhases } from './helpers/release-suites.mjs';
import { planBootstrap, verifyManifest, failingFiles, runBootstrap, trainSelection, requireNoRetries, RUNNER_OPTIONS } from './helpers/bootstrap-gate.mjs';
import { spawnScenarioChild, waitForExit } from './helpers/child.mjs';
import { testSlotEnvironment } from './helpers/test-slot-env.mjs';
import { resolveGateLimits } from '../test-slot/limits.mjs';

const manifestText = fs.readFileSync(new URL('./helpers/bootstrap-coverage.json', import.meta.url), 'utf8');
const manifest = JSON.parse(manifestText);
const digest = text => createHash('sha256').update(text).digest('hex');
const quiet = { log: () => {}, error: () => {} };

test('empty train append is explicit and the recipe requires both declaration and propagated no-retry policy', () => {
  assert.deepEqual(trainSelection({}), []);
  assert.deepEqual(trainSelection({ MONITOR_PROMOTION_TEST_FILES: '["test/one.test.mjs"]' }), ['test/one.test.mjs']);
  assert.throws(() => trainSelection({ MONITOR_PROMOTION_TEST_FILES: 'malformed' }));
  const policy = { MONITOR_PROMOTION_NO_RETRIES: '1', MONITOR_TEST_SLOT_TIMEOUT_RETRIED: '1' };
  requireNoRetries(policy);
  for (const value of [undefined, '0', 'true']) {
    assert.throws(() => requireNoRetries({ ...policy, MONITOR_PROMOTION_NO_RETRIES: value }), /declare MONITOR_PROMOTION_NO_RETRIES/);
    assert.throws(() => requireNoRetries({ ...policy, MONITOR_TEST_SLOT_TIMEOUT_RETRIED: value }), /automatic appended-suite retries remain enabled/);
  }
});

test('only a literal leading no-retry declaration changes command policy, including with no append', () => {
  const declared = 'MONITOR_PROMOTION_NO_RETRIES=1 recipe';
  assert.equal(noRetryCommand(declared), true);
  for (const command of ['recipe', 'MONITOR_PROMOTION_NO_RETRIES=10 recipe', 'MONITOR_PROMOTION_NO_RETRIES=0 recipe',
    'echo MONITOR_PROMOTION_NO_RETRIES=1 recipe', '( MONITOR_PROMOTION_NO_RETRIES=1 recipe )']) {
    assert.equal(noRetryCommand(command), false);
    assert.equal(plannedCommand(command, null), command);
  }
  assert.match(plannedCommand(declared, null), /^export MONITOR_PROMOTION_NO_RETRIES=1 MONITOR_TEST_SLOT_TIMEOUT_RETRIED=1; \( /);
  assert.doesNotMatch(plannedCommand(declared, { files: [], command: null }), /&&/);
});

test('the recipe refuses undeclared execution and both default and declared append stop once under watch mode', async t => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bootstrap-retries-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const attempts = path.join(root, 'attempts.jsonl'), guard = path.join(root, 'guard.mjs');
  const recipe = fileURLToPath(new URL('./helpers/bootstrap-gate.mjs', import.meta.url));
  const planner = fileURLToPath(new URL('./helpers/affected-tests.mjs', import.meta.url));
  fs.writeFileSync(guard, `import {requireNoRetries} from ${JSON.stringify(new URL('./helpers/bootstrap-gate.mjs', import.meta.url).href)};requireNoRetries();`);
  const preload = path.join(root, 'load.mjs');
  fs.writeFileSync(preload, "import os from 'node:os';os.loadavg=()=>[4,4,4];os.availableParallelism=()=>1;");
  const files = ['test/red.test.mjs', 'lanes/test/later.test.mjs'];
  for (const [index, file] of files.entries()) {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), `import fs from 'node:fs';
const log=${JSON.stringify(attempts)},file=${JSON.stringify(file)};
const before=fs.existsSync(log)?fs.readFileSync(log,'utf8').trim().split('\\n').map(JSON.parse):[];
fs.appendFileSync(log,JSON.stringify({file,retried:process.env.MONITOR_TEST_SLOT_TIMEOUT_RETRIED})+'\\n');
${index === 0 ? "if(!before.some(row=>row.file===file)){console.error('testTimeoutFailure');process.exit(124);}" : ''}
`);
  }
  const env = { ...testSlotEnvironment(), MONITOR_PROMOTION_NO_RETRIES: '0', MONITOR_TEST_SLOT_TIMEOUT_RETRIED: '0',
    MONITOR_TEST_SLOT_PATH: path.join(root, 'slot'), MONITOR_TEST_SLOT_COMPAT_PATH: path.join(root, 'slot'),
    NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --import=${JSON.stringify(preload)}` };
  delete env.NODE_TEST_CONTEXT;
  const run = command => waitForExit(spawnScenarioChild(t, '/bin/sh', ['-c', command], { cwd: root, env }));
  const guarded = `${quote(process.execPath)} ${quote(guard)}`;
  // main() itself must refuse before manifest preflight or any test execution.
  const refused = await run(`${quote(process.execPath)} ${quote(recipe)} --manifest-sha256=${digest(manifestText)} --recipe-sha256=${digest(fs.readFileSync(recipe))}`);
  assert.notEqual(refused.code, 0); assert.match(refused.stderr, /declare MONITOR_PROMOTION_NO_RETRIES/);
  assert.doesNotMatch(refused.stdout, /Bootstrap group/); assert.equal(fs.existsSync(attempts), false);
  const unpropagated = await run(`MONITOR_PROMOTION_NO_RETRIES=1 ${guarded}`);
  assert.notEqual(unpropagated.code, 0); assert.match(unpropagated.stderr, /automatic appended-suite retries remain enabled/);
  assert.equal(fs.existsSync(attempts), false);
  const noAppend = await run(plannedCommand(`MONITOR_PROMOTION_NO_RETRIES=1 ${guarded}`, null));
  assert.equal(noAppend.code, 0, noAppend.stdout + noAppend.stderr);
  const plan = { files, command: `${quote(process.execPath)} ${quote(planner)} --run ${quote(JSON.stringify(files))}` };
  // The active default never retries a legacy elapsed-only exit. The explicit
  // declaration additionally propagates its saved no-retry state to the append.
  assert.equal(resolveGateLimits().wall_seconds, 0);
  const ordinary = await run(plannedCommand(':', plan));
  assert.notEqual(ordinary.code, 0, ordinary.stdout + ordinary.stderr);
  assert.doesNotMatch(ordinary.stderr, /TEST_SLOT_TIMEOUT_RETRY:/);
  assert.deepEqual(fs.readFileSync(attempts, 'utf8').trim().split('\n').map(JSON.parse), [{ file: files[0], retried: '0' }]);
  fs.unlinkSync(attempts);
  const noRetries = await run(plannedCommand(`MONITOR_PROMOTION_NO_RETRIES=1 ${guarded}`, plan));
  assert.notEqual(noRetries.code, 0, noRetries.stdout + noRetries.stderr);
  assert.doesNotMatch(noRetries.stderr, /TEST_SLOT_TIMEOUT_RETRY:/);
  assert.deepEqual(fs.readFileSync(attempts, 'utf8').trim().split('\n').map(JSON.parse), [{ file: files[0], retried: '1' }]);
});

test('documented bootstrap commands pin the frozen manifest and current recipe with the no-retry declaration', () => {
  const doc = fs.readFileSync(new URL('./helpers/bootstrap-gate.md', import.meta.url), 'utf8');
  const recipeDigest = digest(fs.readFileSync(new URL('./helpers/bootstrap-gate.mjs', import.meta.url)));
  const commands = [...doc.matchAll(/MONITOR_PROMOTION_NO_RETRIES=1 \/Users\/rewt\/[^\n]+bootstrap-gate\.mjs --manifest-sha256=([0-9a-f]{64}) --recipe-sha256=([0-9a-f]{64})/g)];
  assert.equal(commands.length, 2, 'document both the validate value and bare launch');
  for (const [, manifestDigest, documentedRecipeDigest] of commands) {
    assert.equal(manifestDigest, digest(manifestText));
    assert.equal(documentedRecipeDigest, recipeDigest);
  }
  assert.match(doc, /\/Users\/rewt\/\.nvm\/versions\/node\/v20\.19\.4\/bin\/node promote\/promote\.mjs --resume/);
});

test('recipe partitions the frozen files against the actual train append without overlap', () => {
  const selected = manifest.files.filter((_, index) => index % 3 === 0);
  const plan = planBootstrap(manifest.files, selected);
  const own = plan.groups.flatMap(([, rows]) => rows);
  assert.deepEqual([...own, ...selected].sort(), manifest.files);
  assert.equal(new Set([...own, ...selected]).size, manifest.file_count);
  assert.ok(own.every(file => !selected.includes(file)));
  assert.match(plannedCommand('recipe', { files: selected, command: 'append' }), /^export MONITOR_PROMOTION_TEST_FILES='\[/);
  assert.ok(plannedCommand('recipe', { files: selected, command: 'append' }).endsWith('; ( recipe ) && append'));
  assert.throws(() => planBootstrap(manifest.files, ['test/unexpected.test.mjs']), /outside frozen manifest/);
  assert.throws(() => planBootstrap(manifest.files, [selected[0], selected[0]]), /unique/);
  assert.throws(() => planBootstrap(manifest.files, undefined));
});

test('group planning bounds every directory and isolates lanes, acceptance and completions', () => {
  const files = ['promote/test/aaa.test.mjs', 'promote/test/completion.test.mjs', 'promote/test/completion-recovery.test.mjs',
    'promote/test/zzz.test.mjs', 'lanes/test/lane.test.mjs', 'acceptance/test/cleanup.test.mjs',
    ...Array.from({ length: 13 }, (_, index) => `test/growing-${index}.test.mjs`)];
  const { groups } = planBootstrap(files, []);
  assert.deepEqual(groups, releasePhases(files));
  assert.deepEqual(groups.flatMap(([, rows]) => rows).sort(), [...files].sort());
  assert.ok(groups.every(([, rows]) => rows.length <= 4));
  for (const file of files.filter(file => /^(lanes|acceptance)\//.test(file) || file.includes('/completion'))) assert.deepEqual(groups.find(([, rows]) => rows.includes(file))[1], [file]);
  assert.deepEqual(RUNNER_OPTIONS, ['--file-timeout=480000', '--suite-timeout=540000']);
});

test('groups run sequentially once and summarize every recipe and delegated file', async () => {
  const selected = manifest.files.slice(0, 3), attempts = [];
  let active = 0;
  const result = await runBootstrap({ files: manifest.files, selected, ...quiet, execute: async rows => {
    assert.equal(active++, 0, 'parallel groups');
    await Promise.resolve(); attempts.push(...rows); active--;
    return { status: 0 };
  } });
  assert.equal(result.exitCode, 0);
  assert.deepEqual(result.passed, attempts);
  assert.deepEqual([...attempts, ...result.train_pending].sort(), manifest.files);
  assert.deepEqual(result.not_run, []);
  assert.deepEqual(result.red_group, []);
  assert.equal(attempts.length, new Set(attempts).size);
});

test('first red group prints the failing file and accounts for reordered unstarted groups', async () => {
  const files = ['promote/test/aaa.test.mjs', 'promote/test/completion.test.mjs', 'promote/test/zzz.test.mjs', 'lanes/test/lane.test.mjs'];
  const errors = [], attempts = [];
  const result = await runBootstrap({ files, selected: [], log: quiet.log, error: line => errors.push(line), execute: async rows => {
    attempts.push(rows);
    return { status: 1, output: "not ok 2 - injection\n  location: '/scratch/promote/test/zzz.test.mjs:12:1'\n" };
  } });
  assert.equal(result.exitCode, 1);
  assert.deepEqual(attempts, [['promote/test/aaa.test.mjs', 'promote/test/zzz.test.mjs']]);
  assert.deepEqual(result.failing_files, ['promote/test/zzz.test.mjs']);
  assert.deepEqual(errors, ['FAILED FILE: promote/test/zzz.test.mjs']);
  assert.deepEqual(result.not_run, ['promote/test/completion.test.mjs', 'lanes/test/lane.test.mjs']);
  assert.deepEqual([...result.red_group, ...result.not_run].sort(), [...files].sort());
});

test('timeouts, signals and launch errors stop without retries or excusing a group', async () => {
  const files = ['test/one.test.mjs', 'lanes/test/later.test.mjs'];
  for (const failure of [{ status: 1, output: 'Test file exceeded 480000ms. File: test/one.test.mjs' },
    { status: null, signal: 'SIGTERM' }, { status: 0, error: 'fixture audit failed' }, new Error('spawn refused')]) {
    let attempts = 0;
    const result = await runBootstrap({ files, selected: [], ...quiet, execute: async () => {
      attempts++; if (failure instanceof Error) throw failure; return failure;
    } });
    assert.equal(attempts, 1); assert.notEqual(result.exitCode, 0);
    assert.deepEqual(result.not_run, ['lanes/test/later.test.mjs']);
  }
  assert.deepEqual(failingFiles('location: /scratch/test/one.test.mjs:4:1', files), [files[0]]);
});

test('a later red group preserves completed evidence and never starts the tail', async () => {
  const files = ['test/green.test.mjs', 'lanes/test/red.test.mjs', 'watch/test/later.test.mjs'];
  const attempts = [];
  const result = await runBootstrap({ files, selected: [], ...quiet, execute: async rows => {
    attempts.push(...rows);
    return { status: attempts.length === 1 ? 0 : 7, output: 'not ok 1 - lanes/test/red.test.mjs' };
  } });
  assert.equal(result.exitCode, 7);
  assert.deepEqual(attempts, files.slice(0, 2));
  assert.deepEqual(result.passed, [files[0]]);
  assert.deepEqual(result.red_group, [files[1]]);
  assert.deepEqual(result.not_run, [files[2]]);
});

test('empty own partition is accounted for without starting a runner', async () => {
  const result = await runBootstrap({ files: manifest.files, selected: manifest.files, ...quiet, execute: () => { assert.fail('runner should not start'); } });
  assert.equal(result.exitCode, 0);
  assert.deepEqual(result.passed, []);
  assert.deepEqual(result.train_pending, manifest.files);
});

test('digest and group checks reject changes before execution', () => {
  const minimal = { schema: 'bootstrap-coverage/v1', files: ['test/one.test.mjs'], file_count: 1, execution_sources: { 'test/helpers/run.mjs': { sha256: digest('guard') } }, dispatch: { sources: {} } };
  minimal.files_sha256 = digest(JSON.stringify(minimal.files));
  minimal.groups = releasePhases(minimal.files); minimal.groups_sha256 = digest(JSON.stringify(minimal.groups));
  const text = JSON.stringify(minimal);
  assert.deepEqual(verifyManifest(text, digest(text), () => 'guard'), minimal);
  assert.throws(() => verifyManifest(text + '\n', digest(text), () => 'guard'), /manifest digest changed/);
  assert.throws(() => verifyManifest(text, digest(text), () => 'mutated'), /execution source changed/);
  const changed = JSON.stringify({ ...minimal, groups: [] });
  assert.throws(() => verifyManifest(changed, digest(changed), () => 'guard'), /grouping changed/);
});
