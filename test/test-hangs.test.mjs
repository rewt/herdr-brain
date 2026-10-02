import test from './helpers/bounded-test.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnChild, waitForExit } from './helpers/child.mjs';

const helper = new URL('./helpers/bounded-test.mjs', import.meta.url).href;
const childHelper = new URL('./helpers/child.mjs', import.meta.url).href;
const runner = fileURLToPath(new URL('./helpers/run.mjs', import.meta.url));

function fixture(t, source) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'test-hang-regression-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'culprit.test.mjs');
  fs.writeFileSync(file, `import test from ${JSON.stringify(helper)};
import {spawnChild,waitForExit} from ${JSON.stringify(childHelper)};
import fs from 'node:fs';
${source(root)}`);
  return { root, file };
}

function assertGone(pid) {
  assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' }, `fixture process ${pid} survived cleanup`);
}

test('a late waiter receives a child result and output after close', async (t) => {
  const child = spawnChild(t, process.execPath, ['-e', "console.log('already closed')"]);
  await waitForExit(child);
  // The close event has already fired. The old waiter would miss it.
  const result = await waitForExit(child);
  assert.equal(result.code, 0);
  assert.equal(result.stdout, 'already closed\n');
});

for (const kind of ['leak', 'assertion', 'test timeout', 'child timeout']) {
  test(`${kind} names the failed test and reaps its fixture child and grandchild`, async (t) => {
    const name = `deliberately ${kind} fixture watcher`;
    const f = fixture(t, (root) => {
      const command = `echo $$ > '${root}/pid'; sleep 60 & echo $! > '${root}/grandchild'; wait`;
      const options = kind === 'test timeout' ? '{timeout: 500}' : '{}';
      return `test(${JSON.stringify(name)},${options},async(t)=>{
const child=spawnChild(t,'/bin/sh',['-c',${JSON.stringify(command)}],{},${kind === 'child timeout' ? 500 : 15000});
while(!fs.existsSync(${JSON.stringify(path.join(root, 'grandchild'))})) await new Promise(r=>setTimeout(r,10));
${kind === 'assertion' ? "throw Error('injected failure before waitForExit');" : kind === 'leak' ? '' : 'await waitForExit(child);'}
});`;
    });
    const child = spawnChild(t, process.execPath, [runner, f.file]);
    const result = await waitForExit(child);
    assert.equal(result.code, 1, result.stdout + result.stderr);
    assert.ok(result.stdout.includes(name), result.stdout);
    assert.match(result.stdout, kind === 'test timeout' ? /testTimeoutFailure/ : kind === 'child timeout' ? /did not exit within 500ms/ : kind === 'assertion' ? /injected failure before waitForExit/ : /left child running/);
    for (const file of ['pid', 'grandchild']) assertGone(Number(fs.readFileSync(path.join(f.root, file), 'utf8')));
  });
}

for (const kind of ['file', 'suite']) {
  test(`${kind} watchdog bounds a blocked event loop and reaps registered children`, async (t) => {
    const f = fixture(t, (root) => `test('blocked event loop culprit',async(t)=>{
const child=spawnChild(t,process.execPath,['-e','setInterval(()=>{},1000)']);
fs.writeFileSync(${JSON.stringify(path.join(root, 'pid'))},String(child.pid));
while(true) {}
});`);
    const child = spawnChild(t, process.execPath, [runner, `--${kind}-timeout=1000`, f.file]);
    const result = await waitForExit(child);
    assert.equal(result.code, 1, result.stdout + result.stderr);
    assert.ok((result.stdout + result.stderr).includes(f.file), result.stdout + result.stderr);
    assert.match(result.stdout + result.stderr, kind === 'file' ? /testTimeoutFailure/ : /Test suite exceeded 1000ms/);
    assertGone(Number(fs.readFileSync(path.join(f.root, 'pid'), 'utf8')));
  });
}
