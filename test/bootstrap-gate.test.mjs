import test from './helpers/bounded-test.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { plannedCommand } from '../promote/test-plan.mjs';
import { releasePhases } from './helpers/release-suites.mjs';
import { planBootstrap, verifyManifest, failingFiles, runBootstrap, trainSelection, requireNoRetries, RUNNER_OPTIONS } from './helpers/bootstrap-gate.mjs';

const manifestText = fs.readFileSync(new URL('./helpers/bootstrap-coverage.json', import.meta.url), 'utf8');
const manifest = JSON.parse(manifestText);
const digest = text => createHash('sha256').update(text).digest('hex');
const quiet = { log: () => {}, error: () => {} };

test('empty train append is explicit and appended-suite retries must be disabled upstream', () => {
  assert.deepEqual(trainSelection({}), []);
  assert.deepEqual(trainSelection({ MONITOR_PROMOTION_TEST_FILES: '["test/one.test.mjs"]' }), ['test/one.test.mjs']);
  assert.throws(() => trainSelection({ MONITOR_PROMOTION_TEST_FILES: 'malformed' }));
  requireNoRetries({ MONITOR_TEST_SLOT_TIMEOUT_RETRIED: '1' });
  for (const value of [undefined, '0', 'true']) assert.throws(() => requireNoRetries({ MONITOR_TEST_SLOT_TIMEOUT_RETRIED: value }), /disable appended-suite retries/);
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
