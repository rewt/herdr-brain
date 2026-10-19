import test from './helpers/bounded-test.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { tierFiles } from './helpers/tier.mjs';
import { releasePhases } from './helpers/release-suites.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
test('tier selection covers every current test once in promotion or release and excludes support modules', () => {
  const directories = ['test', 'brain/test', 'watch/test', 'dispatch/test', 'housekeeping/test', 'discovery/test', 'promote/test', 'verify/test', 'settle/test', 'supervisor/test', 'lanes/test', 'acceptance/test'];
  const expected = directories.flatMap(dir => fs.readdirSync(path.join(root, dir)).filter(file => file.endsWith('.test.mjs')).map(file => `${dir}/${file}`));
  const promotion = tierFiles('promotion', root);
  const fullFileSteps = ['core', 'cycle', 'lanes', 'acceptance'].flatMap(tier => tierFiles(tier, root));
  assert.deepEqual(fullFileSteps.sort(), [...promotion].sort(), 'release steps cover promotion files once');
  const release = tierFiles('release', root), all = [...promotion, ...release];
  assert.equal(new Set(all).size, all.length, 'no file is scheduled twice within a gate');
  assert.deepEqual([...all].sort(), expected.sort());
  assert.ok(release.includes('discovery/test/lessons.test.mjs'));
  assert.ok(release.includes('test/deadline-boundaries.test.mjs'));
  assert.ok(release.includes('settle/test/ref-wallclock.test.mjs'));
  assert.ok(release.includes('test/pty-cache.test.mjs'));
  assert.ok(promotion.includes('test/lane-removal-protection.test.mjs'));
  for (const file of ['test/activation-seam.test.mjs', 'test/file-wait.test.mjs', 'test/git-seed.test.mjs', 'test/tier-plan.test.mjs', 'test/retire-status.test.mjs', 'promote/test/workflow-train.test.mjs', 'supervisor/test/autopilot.test.mjs', 'test/bch-cloak-contract.test.mjs', 'supervisor/test/request.test.mjs', 'dispatch/test/retired-flags.test.mjs']) assert.ok(promotion.includes(file));
  assert.ok(!tierFiles('fast', root).includes('lanes/test/validation.test.mjs'));
  assert.ok(tierFiles('fast', root).every(file => promotion.includes(file)));
  assert.throws(() => tierFiles('unknown', root), /unknown test tier/);
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
