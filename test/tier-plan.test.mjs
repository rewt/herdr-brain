import test from './helpers/bounded-test.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { tierFiles } from './helpers/tier.mjs';
import { releasePhases } from './helpers/release-suites.mjs';
import { spawnScenarioChild, waitForExit } from './helpers/child.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
test('tier selection covers every current test once in promotion or release and excludes support modules', () => {
  const directories = ['test', 'brain/test', 'watch/test', 'dispatch/test', 'housekeeping/test', 'discovery/test', 'promote/test', 'verify/test', 'settle/test', 'supervisor/test', 'lanes/test', 'acceptance/test'];
  const expected = directories.flatMap(dir => fs.readdirSync(path.join(root, dir)).filter(file => file.endsWith('.test.mjs')).map(file => `${dir}/${file}`));
  const promotion = tierFiles('promotion', root);
  assert.ok(promotion.includes('test/contracts-conformance.test.mjs'), 'shared contracts run at promotion');
  const fullFileSteps = ['core', 'cycle', 'lanes', 'acceptance'].flatMap(tier => tierFiles(tier, root));
  assert.deepEqual(fullFileSteps.sort(), [...promotion].sort(), 'release steps cover promotion files once');
  const release = tierFiles('release', root), all = [...promotion, ...release];
  assert.ok(promotion.includes('test/setup.test.mjs'));
  assert.ok(!release.includes('test/setup.test.mjs'));
  assert.equal(new Set(all).size, all.length, 'no file is scheduled twice within a gate');
  assert.deepEqual([...all].sort(), expected.sort());
  assert.ok(release.includes('discovery/test/lessons.test.mjs'));
  assert.ok(release.includes('test/deadline-boundaries.test.mjs'));
  assert.ok(release.includes('settle/test/ref-wallclock.test.mjs'));
  assert.ok(release.includes('test/pty-cache.test.mjs'));
  assert.ok(!promotion.includes('supervisor/test/green-main.test.mjs'), 'enable-time deployment probes never run as promotion-tier checks');
  assert.ok(!tierFiles('cycle', root).includes('supervisor/test/green-main.test.mjs'));
  assert.ok(release.includes('supervisor/test/green-main.test.mjs'), 'release discovery retains the explicitly opt-in probe');
  assert.ok(promotion.includes('supervisor/test/green-manifest.test.mjs'), 'pure offline manifest controls run before merge');
  assert.ok(promotion.includes('supervisor/test/green-pass.test.mjs'), 'green admission authority is checked before merge');
  assert.ok(promotion.includes('test/lane-removal-protection.test.mjs'));
  for (const file of ['test/activation-seam.test.mjs', 'test/file-wait.test.mjs', 'test/git-seed.test.mjs', 'test/tier-plan.test.mjs', 'test/retire-status.test.mjs', 'test/session-release.test.mjs', 'promote/test/workflow-train.test.mjs', 'supervisor/test/autopilot.test.mjs', 'test/bch-cloak-contract.test.mjs', 'supervisor/test/request.test.mjs', 'dispatch/test/retired-flags.test.mjs']) assert.ok(promotion.includes(file));
  assert.ok(!tierFiles('fast', root).includes('lanes/test/validation.test.mjs'));
  assert.ok(tierFiles('fast', root).every(file => promotion.includes(file)));
  assert.throws(() => tierFiles('unknown', root), /unknown test tier/);
});

test('split dispatch files retain whole-file promotion coverage and exclude their shared fixture', () => {
  const files = ['dispatch/test/dispatch-admission.test.mjs', 'dispatch/test/dispatch-options.test.mjs',
    'dispatch/test/dispatch-recovery.test.mjs', 'dispatch/test/dispatch-session.test.mjs'];
  for (const file of files) {
    for (const tier of ['promotion', 'core']) assert.equal(tierFiles(tier, root).filter(candidate => candidate === file).length, 1);
    assert.ok(!tierFiles('release', root).includes(file));
  }
  for (const tier of ['fast', 'promotion', 'release', 'core']) {
    assert.ok(!tierFiles(tier, root).includes('dispatch/test/dispatch-fixture.mjs'));
  }
});

test('split lane CLI files keep release placement and individual suite deadlines', () => {
  const files = ['lanes/test/lane.test.mjs', 'lanes/test/lane-dispatch.test.mjs', 'lanes/test/lane-review.test.mjs'];
  const release = tierFiles('release', root);
  const phases = releasePhases(release);
  for (const file of files) {
    assert.equal(release.filter(candidate => candidate === file).length, 1);
    assert.deepEqual(phases.filter(([, rows]) => rows.includes(file)).map(([, rows]) => rows), [[file]]);
    for (const tier of ['fast', 'promotion', 'lanes']) assert.ok(!tierFiles(tier, root).includes(file));
  }
  for (const tier of ['fast', 'promotion', 'release', 'lanes']) {
    assert.ok(!tierFiles(tier, root).includes('lanes/test/lane-fixture.mjs'));
  }
});

test('split completion files retain release coverage with separate bounded suites', () => {
  const files = ['promote/test/completion.test.mjs', 'promote/test/completion-recovery.test.mjs'];
  const release = tierFiles('release', root), phases = releasePhases(release);
  for (const file of files) {
    assert.equal(release.filter(candidate => candidate === file).length, 1);
    assert.deepEqual(phases.filter(([, rows]) => rows.includes(file)).map(([, rows]) => rows), [[file]]);
    assert.ok(!tierFiles('promotion', root).includes(file));
  }
  assert.ok(!release.includes('promote/test/completion-fixture.mjs'));
});

test('a module folder removed from the planned tree contributes no tests instead of failing the plan', () => {
  const scratch = fs.mkdtempSync(path.join(fs.realpathSync(process.env.TMPDIR || '/tmp'), 'tier-missing-'));
  try {
    fs.mkdirSync(path.join(scratch, 'test'));
    fs.writeFileSync(path.join(scratch, 'test', 'only.test.mjs'), '');
    assert.deepEqual(tierFiles('release', scratch), ['test/only.test.mjs']);
    assert.deepEqual(tierFiles('core', scratch), []);
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});

function tierFixture(t, failure = '') {
  const scratch = fs.mkdtempSync(path.join(fs.realpathSync(process.env.TMPDIR || '/tmp'), 'tier-groups-'));
  t.after(() => fs.rmSync(scratch, { recursive: true, force: true }));
  fs.mkdirSync(path.join(scratch, 'test/helpers'), { recursive: true });
  fs.mkdirSync(path.join(scratch, 'lib'));
  // Give the real tier CLI a small inventory without starting repository tests.
  fs.copyFileSync(path.join(root, 'test/helpers/tier.mjs'), path.join(scratch, 'test/helpers/tier.mjs'));
  for (const file of ['lib/cli-help.mjs', 'test/helpers/release-suites.mjs', 'test/helpers/run.mjs'])
    fs.symlinkSync(path.join(root, file), path.join(scratch, file));
  const files = tierFiles('fast');
  for (const file of files) {
    fs.mkdirSync(path.dirname(path.join(scratch, file)), { recursive: true });
    fs.writeFileSync(path.join(scratch, file), `
import fs from 'node:fs';
import test from 'node:test';
fs.appendFileSync('startups', ${JSON.stringify(file + '\n')});
test('merge guard', () => { ${file === files[4] ? failure : ''} });
test('release integration', () => { throw Error('tier name filter was lost'); });
`);
  }
  return { files, scratch,
    run: options => waitForExit(spawnScenarioChild(t, process.execPath,
      [path.join(scratch, 'test/helpers/tier.mjs'), 'fast', '--test-name-pattern=^merge guard$', '--load-factor=1', ...options], { cwd: scratch })),
    startups: () => fs.readFileSync(path.join(scratch, 'startups'), 'utf8').trim().split('\n'),
  };
}

test('the tier CLI runs bounded sequential groups, isolates lanes and forwards runner options without losing files', async t => {
  const f = tierFixture(t);
  const result = await f.run(['--fixed-deadlines', '--file-timeout=5000', '--suite-timeout=10000']);
  assert.equal(result.code, 0, result.stdout + result.stderr);
  assert.deepEqual(f.startups().sort(), [...f.files].sort(), 'every selected file starts exactly once');
  const groups = [...result.stdout.matchAll(/^Test tier fast group (\S+): (.+\.test\.mjs)$/gm)]
    .map(([, name, files]) => [name, files.split(', ')]);
  assert.deepEqual(groups, releasePhases(f.files));
  assert.deepEqual(groups.map(([, rows]) => rows.length), [4, 2, 1]);
  assert.deepEqual(groups.at(-1)[1], ['lanes/test/routes.test.mjs']);
  const starts = f.startups();
  assert.deepEqual(starts.slice(0, 4).sort(), f.files.slice(0, 4).sort(), 'the first group finishes before the next starts');
  assert.deepEqual(starts.slice(4, 6).sort(), f.files.slice(4, 6).sort());
  assert.deepEqual([...result.stdout.matchAll(/^# pass (\d+)$/gm)].map(([, count]) => Number(count)), [4, 2, 1], 'the name filter reaches every worker');
  assert.deepEqual([...result.stdout.matchAll(/^# skipped (\d+)$/gm)].map(([, count]) => Number(count)), [4, 2, 1]);
  assert.equal((result.stdout.match(/^Test tier fast group .+ finished: duration_ms=\d+\.\d{3} exit=0$/gm) ?? []).length, groups.length);
  assert.match(result.stdout, /^Test tier fast passed: 7 files; duration_ms=\d+\.\d{3}$/m);
});

test('a red tier group stops without replaying passed files or starting later groups', async t => {
  const f = tierFixture(t, "throw Error('injected tier failure');");
  const result = await f.run([]);
  assert.equal(result.code, 1, result.stdout + result.stderr);
  assert.match(result.stdout, /injected tier failure/);
  assert.deepEqual(f.startups().sort(), f.files.slice(0, 6).sort());
  assert.doesNotMatch(result.stdout, /Test tier fast group lanes\//);
  assert.doesNotMatch(result.stdout, /Test tier fast passed/);
});

for (const [limit, options, diagnostic] of [
  ['suite', ['--file-timeout=5000', '--suite-timeout=1000'], /Test suite exceeded 1000ms/],
  ['file', ['--file-timeout=700', '--suite-timeout=5000'], /(?:Test file exceeded 700ms|test timed out after 700ms)/],
]) test(`the tier CLI forwards fixed ${limit} deadlines to every group and stops on timeout`, async t => {
  const f = tierFixture(t, 'Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);');
  const result = await f.run(['--fixed-deadlines', ...options]);
  assert.equal(result.code, 1, result.stdout + result.stderr);
  assert.match(result.stdout + result.stderr, diagnostic);
  assert.deepEqual(f.startups().sort(), f.files.slice(0, 6).sort());
  assert.doesNotMatch(result.stdout, /Test tier fast group lanes\//);
});
