import test from './helpers/bounded-test.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { phases } from './helpers/suite.mjs';
import { spawnChild, waitForExit } from './helpers/child.mjs';

process.env.ORG_ACTOR = 'suite-tests';
test('npm phases preserve every file once and isolate copied-entry probes', () => {
  const files = ['test/a.mjs', 'discovery/test/acceptance.test.mjs', 'console/test/b.mjs', 'settle/test/c.mjs', 'supervisor/test/d.mjs', 'release/test/e.mjs'];
  const groups = phases(files);
  assert.deepEqual(groups[0], ['copied-entry', ['discovery/test/acceptance.test.mjs']]);
  assert.deepEqual(groups.flatMap(([, rows]) => rows).sort(), [...files].sort());
  assert.equal(groups.length, 3);
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
