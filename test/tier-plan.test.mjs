import test from './helpers/bounded-test.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { tierFiles } from './helpers/tier.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
test('tier selection covers every current test once in promotion or release and excludes support modules', () => {
  const directories = ['test', 'brain/test', 'console/test', 'console/proto', 'watch/test', 'dispatch/test', 'housekeeping/test', 'discovery/test', 'promote/test', 'settle/test', 'supervisor/test', 'release/test', 'lanes/test', 'acceptance/test'];
  const expected = directories.flatMap(dir => fs.readdirSync(path.join(root, dir)).filter(file => file.endsWith('.test.mjs')).map(file => `${dir}/${file}`));
  const promotion = ['core', 'cycle', 'lanes', 'acceptance'].flatMap(tier => tierFiles(tier, root));
  const release = tierFiles('release', root), all = [...promotion, ...release];
  assert.equal(new Set(all).size, all.length, 'no file is scheduled twice within a gate');
  assert.deepEqual([...all].sort(), expected.sort());
  assert.ok(release.includes('discovery/test/acceptance.test.mjs'));
  assert.ok(release.includes('test/deadline-boundaries.test.mjs'));
  assert.ok(!tierFiles('fast', root).includes('lanes/test/validation.test.mjs'));
  assert.ok(tierFiles('fast', root).every(file => promotion.includes(file)));
  assert.throws(() => tierFiles('unknown', root), /unknown test tier/);
});
