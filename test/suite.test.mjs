import test from './helpers/bounded-test.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { phases } from './helpers/suite.mjs';
import { tierFiles } from './helpers/tier.mjs';
import { spawnChild, spawnScenarioChild, waitForExit } from './helpers/child.mjs';
import { runnerLimits } from './helpers/runner-limits.mjs';
import { testSlotEnvironment } from './helpers/test-slot-env.mjs';

process.env.ORG_ACTOR = 'suite-tests';

for (const [factor, concurrency] of [[1, 4], [1.5, 2], [2.6, 1], [5, 1]])
  test(`runner load factor ${factor} changes admission without time caps`, () => {
    assert.deepEqual(runnerLimits({ factor }), { concurrency, fileTimeout: 0, suiteTimeout: 0 });
  });

test('legacy runner deadline arguments cannot restore time caps', () => {
  for (const factor of [1, 2.6, Number.MAX_VALUE]) {
    assert.deepEqual(runnerLimits({ factor, fixedDeadlines: true, fileTimeout: 1, suiteTimeout: 1 }),
      { concurrency: Math.max(1, Math.floor(4 / factor)), fileTimeout: 0, suiteTimeout: 0 });
  }
  for (const factor of [0, 0.9, NaN, Infinity]) assert.throws(() => runnerLimits({ factor }), /invalid test load factor/);
});

test('npm phases preserve every file once and group module families', () => {
  const files = ['test/a.mjs', 'discovery/test/lessons.test.mjs', 'watch/test/b.mjs', 'settle/test/c.mjs', 'supervisor/test/d.mjs'];
  const groups = phases(files);
  assert.deepEqual(groups[0], ['core-and-modules', ['test/a.mjs', 'discovery/test/lessons.test.mjs', 'watch/test/b.mjs']]);
  assert.deepEqual(groups.flatMap(([, rows]) => rows).sort(), [...files].sort());
  assert.equal(groups.length, 2);
  assert.throws(() => phases([]), /nonempty/); assert.throws(() => phases(['a', 'a']), /unique/);
});

test('the phased command propagates a failing suite and never starts its later phase', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'phased-suite-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'settle/test'), { recursive: true });
  fs.writeFileSync(path.join(root, 'fail.mjs'), "import test from 'node:test';test('injected suite failure',()=>{throw Error('stop the phases');});");
  fs.writeFileSync(path.join(root, 'settle/test/later.mjs'), "import fs from 'node:fs';fs.writeFileSync('later-was-run','unsafe');");
  const result = await waitForExit(spawnChild(t, process.execPath, [fileURLToPath(new URL('./helpers/suite.mjs', import.meta.url)), 'fail.mjs', 'settle/test/later.mjs'], { cwd: root }));
  assert.equal(result.code, 1, result.stdout + result.stderr); assert.match(result.stdout, /injected suite failure/);
  assert.equal(fs.existsSync(path.join(root, 'later-was-run')), false);
});

test('the phased command runs a progressing file past legacy file and suite caps', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'phased-watchdog-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, 'blocked.mjs'), `import test from 'node:test';test('slow progress',async()=>{for(let n=0;n<4;n++){console.log('progress');await new Promise(r=>setTimeout(r,50));}});`);
  const result = await waitForExit(spawnChild(t, process.execPath, [fileURLToPath(new URL('./helpers/suite.mjs', import.meta.url)), '--fixed-deadlines', '--file-timeout=1', '--suite-timeout=1', 'blocked.mjs'], { cwd: root }));
  assert.equal(result.code, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /slow progress/);
  assert.doesNotMatch(result.stderr, /exceeded/);
});

// Use the existing bounded owner even when selecting the merge-critical subset.
test('bounded runner selects merge checks and forwards the selection to its worker', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'selected-suite-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, 'selected.mjs'), "import test from 'node:test';import fs from 'node:fs';test('merge guard',()=>fs.writeFileSync('selected','yes'));test('release integration',()=>{throw Error('release-only failure');});");
  const runner = fileURLToPath(new URL('./helpers/run.mjs', import.meta.url));
  const result = await waitForExit(spawnChild(t, process.execPath, [runner, '--test-name-pattern=^merge guard$', 'selected.mjs'], { cwd: root }));
  assert.equal(result.code, 0, result.stdout + result.stderr);
  assert.equal(fs.readFileSync(path.join(root, 'selected'), 'utf8'), 'yes');
  const failed = await waitForExit(spawnChild(t, process.execPath, [runner, '--test-name-pattern=^release integration$', 'selected.mjs'], { cwd: root }));
  assert.equal(failed.code, 1, failed.stdout + failed.stderr);
  assert.match(failed.stdout, /release-only failure/);
});

function requestEnvironmentFixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'runner-request-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const runner = fileURLToPath(new URL('./helpers/run.mjs', import.meta.url));
  const affected = fileURLToPath(new URL('./helpers/affected-tests.mjs', import.meta.url));
  const policy = fileURLToPath(new URL('./helpers/fixture-policy.mjs', import.meta.url));
  const validation = new URL('../lanes/validation.mjs', import.meta.url).href;
  const keys = ['LANE_VALIDATE', 'LANE_CONFIG', 'ORG_DIR', 'HERDR_RETIRE_HERDR', 'MONITOR_PROMOTION_TEST_FILES'];
  const env = { ...testSlotEnvironment(), LANE_VALIDATE: 'poisoned-train-command',
    LANE_CONFIG: path.join(root, 'poisoned-config.json'), ORG_DIR: path.join(root, 'poisoned-record'),
    HERDR_RETIRE_HERDR: path.join(root, 'poisoned-herdr'), MONITOR_PROMOTION_TEST_FILES: '[]',
    MONITOR_TEST_SLOT_TIMEOUT_RETRIED: '1', MONITOR_TEST_SLOT_PATH: path.join(root, 'slot.lock'),
    MONITOR_TEST_SLOT_COMPAT_PATH: path.join(root, 'slot.lock'), HERDR_SOCKET_PATH: path.join(root, 'absent.sock') };
  fs.writeFileSync(path.join(root, '.lane.validation.json'), JSON.stringify({ fast: 'project-fast-command' }));
  const retained = Object.fromEntries(['MONITOR_TEST_SLOT_TIMEOUT_RETRIED', 'MONITOR_TEST_SLOT_PATH',
    'MONITOR_TEST_SLOT_COMPAT_PATH', 'HERDR_SOCKET_PATH', 'HERDR_TEST_OFFLINE_ROOT', 'HERDR_TEST_SCRATCH_ROOTS', 'PATH']
    .map(key => { assert.equal(typeof env[key], 'string', key); return [key, env[key]]; }));
  const checks = `
for (const key of ${JSON.stringify(keys)}) assert.equal(Object.hasOwn(process.env, key), false, key + ' leaked at startup');
for (const [key, value] of Object.entries(${JSON.stringify(retained)})) assert.equal(process.env[key], value, key);
assert.equal(process.execPath, ${JSON.stringify(process.execPath)});
assert.ok(process.env.NODE_OPTIONS.includes(${JSON.stringify(policy)}), 'containment preload retained');
assert.ok(process.env.NODE_OPTIONS.includes(${JSON.stringify(env.NODE_OPTIONS)}), 'other preloads retained');
assert.ok(Number(process.env.HERDR_TEST_SUITE_PID) > 1, 'suite ownership retained');
assert.ok(process.env.HERDR_MONITOR_FLEET.startsWith(process.env.HERDR_TEST_OFFLINE_ROOT + '/'), 'scratch fleet retained');
if (process.env.RUNNER_FIXTURE_DIRECT === '1') {
  assert.equal(process.env.MONITOR_TEST_SLOT_TOKEN, 'fixture-slot-token', 'slot token retained');
  assert.equal(process.env.BCH_CLOAK_TEST_SLOT_TOKEN, 'fixture-slot-token', 'legacy slot token retained');
}
assert.ok(process.env.MONITOR_TEST_SLOT_OCCUPANCY_PATH.startsWith(${JSON.stringify(path.join(root, 'slot.lock.occupancy') + path.sep)}), 'slot occupancy retained');
`;
  // This is the first executed import in each test module. No product consumer
  // loads until both the module and its normally inherited descendant are clean.
  fs.writeFileSync(path.join(root, 'environment.mjs'), `
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
${checks}
const child = spawnSync(process.execPath, ['--input-type=module', '-e', ${JSON.stringify("import assert from 'node:assert/strict';\n" + checks + "console.log('descendant clean');")}], { encoding: 'utf8', timeout: 5000 });
assert.equal(child.status, 0, child.stdout + child.stderr);
assert.equal(child.stdout, 'descendant clean\\n');
const { resolveValidation } = await import(${JSON.stringify(validation)});
const own = resolveValidation({ root: ${JSON.stringify(root)}, config: { validate: 'fallback-command' } });
assert.equal(own.tiers.fast.command, 'project-fast-command');
assert.equal(own.tiers.fast.source, ${JSON.stringify(path.join(root, '.lane.validation.json'))});
process.env.LANE_VALIDATE = 'deliberate-fixture-command';
assert.equal(resolveValidation({ root: ${JSON.stringify(root)} }).tiers.fast.command, 'deliberate-fixture-command');
assert.equal(resolveValidation({ root: ${JSON.stringify(root)} }).tiers.fast.source, 'env');
delete process.env.LANE_VALIDATE;
`);
  const rows = name => fs.existsSync(path.join(root, name)) ? fs.readFileSync(path.join(root, name), 'utf8').trim().split('\n') : [];
  function file(name, releaseFailure = false) {
    fs.writeFileSync(path.join(root, name), `
import test from 'node:test';
import fs from 'node:fs';
await import('./environment.mjs');
fs.appendFileSync('startups', ${JSON.stringify(name + '\n')});
test('merge guard', () => fs.appendFileSync('cases', ${JSON.stringify(name + ':merge\n')}));
test('release integration', () => { ${releaseFailure ? "throw Error('name filter was lost');" : `fs.appendFileSync('cases', ${JSON.stringify(name + ':release\n')});`} });
`);
  }
  return { env, file, rows,
    run: args => waitForExit(spawnChild(t, process.execPath, [runner, ...args], { cwd: root,
      env: { ...env, RUNNER_FIXTURE_DIRECT: '1', MONITOR_TEST_SLOT_TOKEN: 'fixture-slot-token', BCH_CLOAK_TEST_SLOT_TOKEN: 'fixture-slot-token',
        MONITOR_TEST_SLOT_OCCUPANCY_PATH: path.join(root, 'slot.lock.occupancy', 'fixture.json') } })),
    append: files => waitForExit(spawnScenarioChild(t, process.execPath, [affected, '--run', JSON.stringify(files)], { cwd: root, env })),
  };
}

test('an empty promotion selection starts clean modules and descendants and permits deliberate fixture overrides', async t => {
  const f = requestEnvironmentFixture(t);
  f.file('remaining.test.mjs', true);
  const result = await f.run(['--test-name-pattern=^merge guard$', 'remaining.test.mjs']);
  assert.equal(result.code, 0, result.stdout + result.stderr);
  assert.deepEqual(f.rows('startups'), ['remaining.test.mjs']);
  assert.deepEqual(f.rows('cases'), ['remaining.test.mjs:merge']);
  const empty = await f.append([]);
  assert.equal(empty.code, 0, empty.stdout + empty.stderr);
  assert.deepEqual(f.rows('startups'), ['remaining.test.mjs'], 'empty append starts no test files');
  const missing = await f.run([]);
  assert.equal(missing.code, 1, missing.stdout + missing.stderr);
  assert.match(missing.stderr, /usage: node test\/helpers\/run.mjs/);
});

for (const allSelected of [false, true]) test(`promotion selection survives until the worker consumes it (${allSelected ? 'all selected' : 'mixed files'})`, async t => {
  const f = requestEnvironmentFixture(t), selected = ['selected-one.test.mjs', 'selected-two.test.mjs'];
  for (const name of selected) f.file(name);
  f.file('remaining.test.mjs', true);
  f.env.MONITOR_PROMOTION_TEST_FILES = JSON.stringify(selected);
  const patterned = await f.run(['--test-name-pattern=^merge guard$', ...selected, ...(allSelected ? [] : ['remaining.test.mjs'])]);
  assert.equal(patterned.code, 0, patterned.stdout + patterned.stderr);
  const priorStarts = allSelected ? [] : ['remaining.test.mjs'];
  const priorCases = allSelected ? [] : ['remaining.test.mjs:merge'];
  assert.deepEqual(f.rows('startups'), priorStarts, 'P is omitted before any selected module starts');
  assert.deepEqual(f.rows('cases'), priorCases, 'the remaining file retains its name filter');
  const appended = await f.append(selected);
  assert.equal(appended.code, 0, appended.stdout + appended.stderr);
  assert.deepEqual(f.rows('startups').sort(), [...priorStarts, ...selected].sort(), 'actual append starts every P file exactly once');
  assert.deepEqual(f.rows('cases').sort(), [...priorCases, ...selected.flatMap(name => [`${name}:merge`, `${name}:release`])].sort(),
    'actual append runs every P file in full');
});

// The release tier retains all former promotion paths, including future files.
test('release keeps the complete offline suite and promotion covers the fast tier', () => {
  const scripts = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url))).scripts;
  assert.match(scripts['test:release'], /test-slot.*npm run test:release:steps/);
  assert.match(scripts['test:release:steps'], /npm test.*npm run test:lanes.*npm run test:acceptance/);
  for (const step of ['slot', 'core', 'cycle']) assert.ok(scripts.test.includes(`test:${step}`));
  assert.match(scripts['test:release:steps'], /npm run test:release:only/);
  assert.match(scripts['test:release:only'], /test\/helpers\/release-suites\.mjs/);
  assert.match(scripts['test:promotion:core'], /test\/helpers\/tier\.mjs promotion/);
  for (const tier of ['fast', 'core', 'cycle', 'lanes', 'acceptance']) assert.ok(scripts[`test:${tier}`].includes(`test/helpers/tier.mjs ${tier}`));
  const root = fileURLToPath(new URL('../', import.meta.url));
  const releaseFiles = ['core', 'cycle', 'lanes', 'acceptance', 'release'].flatMap(tier => tierFiles(tier, root));
  const expected = ['test', 'brain/test', 'watch/test', 'dispatch/test', 'housekeeping/test', 'discovery/test', 'promote/test', 'verify/test', 'settle/test', 'supervisor/test', 'lanes/test', 'acceptance/test'].flatMap(dir => fs.readdirSync(path.join(root, dir)).filter(name => name.endsWith('.test.mjs')).map(name => `${dir}/${name}`));
  assert.equal(new Set(releaseFiles).size, releaseFiles.length, 'each release file runs once');
  assert.deepEqual([...releaseFiles].sort(), expected.sort());
  assert.match(scripts['test:slot'], /node --test test-slot\/test\/\*\.test\.mjs/);
  for (const file of tierFiles('fast', root)) assert.ok(tierFiles('promotion', root).includes(file), `promotion omits fast check ${file}`);
});
