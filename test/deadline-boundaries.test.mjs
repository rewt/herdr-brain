import test from './helpers/bounded-test.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { environmentFingerprint } from '../lanes/validation.mjs';
import { spawnChild, waitForExit } from './helpers/child.mjs';
const helper = new URL('./helpers/bounded-test.mjs', import.meta.url).href;
const childHelper = new URL('./helpers/child.mjs', import.meta.url).href;
const runner = fileURLToPath(new URL('./helpers/run.mjs', import.meta.url));
process.env.ORG_ACTOR = 'deadline-boundaries-test';
const withLoad = t => {
  const load = os.loadavg, capacity = os.availableParallelism;
  os.loadavg = () => [24, 24, 24]; os.availableParallelism = () => 4;
  t.after(() => { os.loadavg = load; os.availableParallelism = capacity; });
};
function fixture(t, source) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'deadline-boundary-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'culprit.test.mjs');
  fs.writeFileSync(file, `import test from ${JSON.stringify(helper)};
import {spawnChild,spawnScenarioChild,waitForExit} from ${JSON.stringify(childHelper)};
import fs from 'node:fs';
${source(root)}`);
  return { root, file };
}
test('promotion validation can read Git after the old injected 15-second command deadline', { timeout: 60000 }, t => {
  withLoad(t);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'load-slow-git-'));
  const oldPath = process.env.PATH;
  t.after(() => { process.env.PATH = oldPath; fs.rmSync(root, { recursive: true, force: true }); });
  // A real bounded subprocess reproduces ETIMEDOUT in the old test helper.
  fs.writeFileSync(path.join(root, 'git'), `#!${process.execPath}\nsetTimeout(()=>console.log('git version fixture'),15200);\n`, { mode: 0o755 });
  process.env.PATH = `${root}:${oldPath}`;
  assert.match(environmentFingerprint({ env: { ORG_ACTOR: 'load-git-fixture' } }), /^[a-f0-9]{64}$/);
});

test('a nested bounded suite may exceed one command deadline while ordinary commands retain their bound', async t => {
  assert.throws(() => spawnChild(t, process.execPath, ['-e', 'while(true){}'], {}, 35000), /child timeout must be 1\.\.15000ms/);
  const f = fixture(t, () => `test('aggregate suite longer than one command',async()=>{await new Promise(resolve=>setTimeout(resolve,15500));});`);
  const child = spawnChild(t, process.execPath, [runner, '--file-timeout=25000', '--suite-timeout=30000', f.file], {}, 35000);
  const result = await waitForExit(child);
  assert.equal(result.code, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /aggregate suite longer than one command/);
});

