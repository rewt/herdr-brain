import test from './helpers/bounded-test.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { tierFiles } from './helpers/tier.mjs';
import { releasePhases } from './helpers/release-suites.mjs';
import { testInventory } from './helpers/test-inventory.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
test('focused inventory includes historical promotion, release, slot and new module tests independently of tiers', () => {
  const files = ['test/flow.test.mjs', 'promote/test/affected-tests.test.mjs',
    'test-slot/test/slot.test.mjs', 'new-module/nested/consumer.test.mjs', 'test/helpers/fixture.mjs'];
  assert.deepEqual(testInventory([...files, files[0]]), files.slice(0, -1).sort());
  assert.ok(tierFiles('promotion', root).includes('test/flow.test.mjs'));
  assert.throws(() => testInventory(['../outside.test.mjs']), /safe relative paths/);
});

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

test('split closeout files retain whole-file promotion coverage and exclude their shared fixture', () => {
  const files = ['test/closeout.test.mjs', 'test/closeout-selection.test.mjs',
    'test/closeout-continuity.test.mjs', 'test/closeout-policy.test.mjs',
    'test/closeout-lifecycle.test.mjs', 'test/closeout-cli.test.mjs',
    'test/closeout-contention.test.mjs', 'test/closeout-removal.test.mjs'];
  for (const file of files) {
    for (const tier of ['promotion', 'core']) assert.equal(tierFiles(tier, root).filter(candidate => candidate === file).length, 1);
    for (const tier of ['fast', 'release']) assert.ok(!tierFiles(tier, root).includes(file));
  }
  for (const tier of ['fast', 'promotion', 'release', 'core']) {
    assert.ok(!tierFiles(tier, root).includes('test/helpers/closeout-fixture.mjs'));
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
