import test from './helpers/bounded-test.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { phases } from './helpers/suite.mjs';
import { tierFiles } from './helpers/tier.mjs';
import { spawnChild, waitForExit } from './helpers/child.mjs';
import { runnerLimits } from './helpers/runner-limits.mjs';

process.env.ORG_ACTOR = 'suite-tests';

for (const [factor, concurrency, fileTimeout, suiteTimeout] of [
  [1, 4, 300_000, 360_000],
  [1.5, 2, 450_000, 720_000],
  [2.6, 1, 780_000, 1_440_000],
  [5, 1, 1_500_000, 1_800_000],
]) test(`runner deadlines cover reduced file concurrency at load factor ${factor}`, () => {
  const limits = runnerLimits({ factor });
  assert.deepEqual(limits, { concurrency, fileTimeout, suiteTimeout });
  assert.ok(limits.suiteTimeout >= 360_000 * (4 / limits.concurrency));
});

test('runner overrides retain their ceilings, fixed cancellation deadlines and finite timer bounds', () => {
  assert.deepEqual(runnerLimits({ factor: 2.6, fileTimeout: 480_000, suiteTimeout: 540_000 }),
    { concurrency: 1, fileTimeout: 1_248_000, suiteTimeout: 2_160_000 });
  assert.deepEqual(runnerLimits({ factor: 2.6, fixedDeadlines: true, fileTimeout: 5000, suiteTimeout: 1000 }),
    { concurrency: 1, fileTimeout: 5000, suiteTimeout: 1000 });
  const extreme = runnerLimits({ factor: Number.MAX_VALUE });
  assert.deepEqual(extreme, { concurrency: 1, fileTimeout: 2 ** 31 - 1, suiteTimeout: 2 ** 31 - 1 });
  for (const factor of [0, 0.9, NaN, Infinity]) assert.throws(() => runnerLimits({ factor }), /invalid test load factor/);
  for (const [name, maximum] of [['fileTimeout', 480_000], ['suiteTimeout', 540_000]]) {
    for (const value of [0, -1, 1.5, NaN, Infinity, maximum + 1])
      assert.throws(() => runnerLimits({ factor: 1, [name]: value }), /must be 1\.\./);
  }
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

test('the phased command forwards suite watchdog overrides to its bounded runner', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'phased-watchdog-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, 'blocked.mjs'), 'Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0);');
  const result = await waitForExit(spawnChild(t, process.execPath, [fileURLToPath(new URL('./helpers/suite.mjs', import.meta.url)), '--fixed-deadlines', '--file-timeout=5000', '--suite-timeout=1000', 'blocked.mjs'], { cwd: root }));
  assert.equal(result.code, 1, result.stdout + result.stderr);
  assert.match(result.stderr, /Test suite exceeded 1000ms/);
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
