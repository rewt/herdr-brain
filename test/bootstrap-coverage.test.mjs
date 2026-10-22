import test from './helpers/bounded-test.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { SOURCE_COMMIT, MONOLITH, DISPATCH_FILES, SMOKE_FILES, replaceDispatch, reconcileDispatch, checkFiles } from './helpers/bootstrap-coverage.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const manifest = JSON.parse(fs.readFileSync(new URL('./helpers/bootstrap-coverage.json', import.meta.url), 'utf8'));

test('frozen manifest regenerates deterministically from pinned Git objects and registrations', () => {
  const args = ['--experimental-vm-modules', 'test/helpers/bootstrap-coverage.mjs', '--stdout'];
  const generate = () => execFileSync(process.execPath, args, { cwd: root, encoding: 'utf8', timeout: 15000, stdio: ['ignore', 'pipe', 'pipe'] });
  const first = generate(), second = generate();
  assert.equal(first, second);
  assert.equal(first, fs.readFileSync(new URL('./helpers/bootstrap-coverage.json', import.meta.url), 'utf8'));
  assert.equal(manifest.source_commit, SOURCE_COMMIT);
  assert.equal(manifest.coverage.promotion.length, 78);
  assert.equal(manifest.coverage.slot.length, 16);
  assert.equal(manifest.coverage.lane.length, 1);
  assert.equal(manifest.coverage.logic.length, 11);
  assert.deepEqual(manifest.coverage.smoke, SMOKE_FILES);
  assert.equal(manifest.dispatch.registered_names, 100);
  assert.deepEqual(Object.values(manifest.dispatch.groups), [32, 4, 24, 40]);
});

test('dispatch replacement applies to every coverage source and deduplicates the union', () => {
  assert.deepEqual(replaceDispatch([MONOLITH, 'test/a.test.mjs', MONOLITH, ...DISPATCH_FILES]), [...DISPATCH_FILES, 'test/a.test.mjs'].sort());
  assert.ok(!manifest.files.includes(MONOLITH));
  for (const file of DISPATCH_FILES) assert.ok(manifest.files.includes(file));
  const inputs = JSON.parse(fs.readFileSync(new URL('./helpers/bootstrap-inputs.json', import.meta.url), 'utf8'));
  const expected = replaceDispatch([...Object.values(manifest.coverage).flat(), ...inputs.required_tests.flatMap(row => row.files), ...manifest.changed_tests, ...inputs.bootstrap_tests]);
  assert.deepEqual(manifest.files, expected);
  assert.equal(manifest.files.length, new Set(manifest.files).size);
});

test('dispatch provenance rejects changed bodies, missing cases and duplicate names', () => {
  const before = manifest.dispatch.registrations;
  assert.equal(reconcileDispatch(before, { split: before }).registered_names, 100);
  assert.throws(() => reconcileDispatch(before, { split: before.slice(1) }));
  assert.throws(() => reconcileDispatch(before, { split: [...before.slice(1), before[1]] }));
  assert.throws(() => reconcileDispatch(before, { split: before.map((row, index) => index ? row : { ...row, body_sha256: 'changed' }) }), /callback bodies changed/);
});

test('bootstrap inventory refuses duplicate, unsafe and non-test paths', () => {
  for (const files of [['../escape.test.mjs'], ['/root/a.test.mjs'], ['a.test.mjs', 'a.test.mjs'], ['a.mjs'], [null]]) assert.throws(() => checkFiles(files));
  assert.deepEqual(checkFiles(['test/one.test.mjs']), ['test/one.test.mjs']);
});
