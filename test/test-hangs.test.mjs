import test from './helpers/bounded-test.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnChild, waitForExit } from './helpers/child.mjs';
import { killProcesses, registerProcess } from './helpers/processes.mjs';

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

for (const signal of ['SIGTERM', 'SIGKILL']) {
  test(`${signal} of an outer runner reaps every nested worker and blocked fixture descendant`, async (t) => {
    const owned = [];
    // If this regression fails, its reproducer must still leave no live fixtures.
    t.after(() => killProcesses(owned));
    const f = fixture(t, (root) => {
      const receipt = path.join(root, 'inner.json');
      const shell = `echo $$ > '${root}/shell'; sleep 60 & echo $! > '${root}/sleep'; wait`;
      const nested = path.join(root, 'nested.test.mjs');
      fs.writeFileSync(nested, `import test from ${JSON.stringify(helper)};
import {spawnChild} from ${JSON.stringify(childHelper)};
import fs from 'node:fs';
test('nested blocked loop',async(t)=>{
const child=spawnChild(t,'/bin/sh',['-c',${JSON.stringify(shell)}]);
while(!fs.existsSync(${JSON.stringify(path.join(root, 'sleep'))}) || !fs.readFileSync(${JSON.stringify(path.join(root, 'sleep'))},'utf8').trim()) await new Promise(r=>setTimeout(r,10));
fs.writeFileSync(${JSON.stringify(receipt + '.tmp')},JSON.stringify({file:process.pid,worker:process.ppid,shell:child.pid,sleep:Number(fs.readFileSync(${JSON.stringify(path.join(root, 'sleep'))},'utf8'))}));
fs.renameSync(${JSON.stringify(receipt + '.tmp')},${JSON.stringify(receipt)});
while(true) {}
});`);
      const outer = path.join(root, 'outer.json');
      return `test('enclosing nested runner',async(t)=>{
const child=spawnChild(t,process.execPath,[${JSON.stringify(runner)},${JSON.stringify(nested)}]);
fs.writeFileSync(${JSON.stringify(outer + '.tmp')},JSON.stringify({file:process.pid,worker:process.ppid,runner:child.pid}));
fs.renameSync(${JSON.stringify(outer + '.tmp')},${JSON.stringify(outer)});
await waitForExit(child);
});`;
    });
    const sentinel = spawnChild(t, process.execPath, ['-e', 'setInterval(()=>{},1000)']);
    const outer = spawnChild(t, process.execPath, [runner, f.file]);
    const deadline = Date.now() + 10_000;
    while (!fs.existsSync(path.join(f.root, 'inner.json')) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
    assert.ok(fs.existsSync(path.join(f.root, 'inner.json')), 'nested fixture never reached its blocked loop');
    const first = JSON.parse(fs.readFileSync(path.join(f.root, 'outer.json'), 'utf8'));
    const second = JSON.parse(fs.readFileSync(path.join(f.root, 'inner.json'), 'utf8'));
    for (const [pid, group] of [
      [outer.pid, true], [first.worker, true], [first.file, false], [first.runner, true],
      [second.worker, true], [second.file, false], [second.shell, true], [second.sleep, false],
    ]) owned.push(registerProcess(pid, group));
    outer.kill(signal);
    const alive = () => owned.filter(({ pid }) => {
      try { process.kill(pid, 0); return true; } catch (error) { if (error.code !== 'ESRCH') throw error; return false; }
    });
    const cleanupDeadline = Date.now() + 5000;
    while (alive().length && Date.now() < cleanupDeadline) await new Promise((resolve) => setTimeout(resolve, 10));
    assert.deepEqual(alive(), [], 'an outer cancellation left a nested descendant alive');
    const result = await waitForExit(outer);
    assert.equal(signal === 'SIGKILL' ? result.signal : result.code, signal === 'SIGKILL' ? 'SIGKILL' : 1, result.stdout + result.stderr);
    assert.doesNotThrow(() => process.kill(sentinel.pid, 0), 'cleanup killed an unrelated fixture');
    sentinel.kill('SIGKILL');
    await waitForExit(sentinel);
  });
}
