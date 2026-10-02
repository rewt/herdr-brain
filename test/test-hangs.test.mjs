import test from './helpers/bounded-test.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnChild, waitForExit } from './helpers/child.mjs';
import { killProcess, registerProcess, createProcessTracker } from './helpers/processes.mjs';
import { spawnDetachedFixture, waitForDetachedCleanup } from './helpers/detached.mjs';

const helper = new URL('./helpers/bounded-test.mjs', import.meta.url).href;
const childHelper = new URL('./helpers/child.mjs', import.meta.url).href;
const runner = fileURLToPath(new URL('./helpers/run.mjs', import.meta.url));

test('real detached fixture cleanup survives an assertion failure', async (t) => {
  const { root, child } = spawnDetachedFixture(t, 'failure');
  const result = await waitForExit(child);
  assert.equal(result.code, 1, result.stdout + result.stderr);
  assert.match(result.stderr, /injected detached fixture assertion failure/);
  const leaf = JSON.parse(fs.readFileSync(path.join(root, 'leaf.json')));
  assert.equal(leaf.pid, leaf.pgid);
  assert.notEqual(leaf.pgid, leaf.parentGroup);
  await waitForDetachedCleanup(root);
});

for (const kind of ['SIGTERM', 'SIGKILL', 'SIGKILL-before-receipt', 'blocked']) test(`${kind} cleanup bounds genuinely detached fixtures outside the suite group`, async (t) => {
  const detachedHelper = new URL('./helpers/detached.mjs', import.meta.url).href;
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'detached-cancellation-'));
  const f = { root, file: path.join(root, 'culprit.test.mjs') };
  fs.writeFileSync(f.file, `import test from ${JSON.stringify(helper)};
import {waitForExit} from ${JSON.stringify(childHelper)};
import fs from 'node:fs';
import {spawnDetachedFixture} from ${JSON.stringify(detachedHelper)};
test('real detached cancellation fixture',async(t)=>{
const {child}=spawnDetachedFixture(t,${JSON.stringify(kind === 'blocked' ? 'blocked' : kind === 'SIGKILL-before-receipt' ? 'early-cancel' : kind === 'SIGKILL' ? 'blocked-leaf' : 'hold')},${JSON.stringify(root)},${kind === 'blocked' ? 3000 : 15000});
fs.writeFileSync(${JSON.stringify(path.join(root, 'suite'))},String(process.env.HERDR_TEST_SUITE_PID));
await waitForExit(child);
});`);
  const outer = spawnChild(t, process.execPath, [runner, f.file]);
  t.after(async () => {
    await waitForDetachedCleanup(root);
    fs.rmSync(root, { recursive: true, force: true });
  });
  const receiptFile = kind === 'SIGKILL-before-receipt' ? 'spawned.json' : 'leaf.json';
  const deadline = Date.now() + 10000;
  while (!fs.existsSync(path.join(f.root, receiptFile)) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
  assert.ok(fs.existsSync(path.join(f.root, receiptFile)), 'detached cancellation fixture reached its launch');
  const leaf = JSON.parse(fs.readFileSync(path.join(f.root, receiptFile)));
  if (kind === 'SIGKILL-before-receipt') {
    const snapshot = createProcessTracker().snapshot();
    assert.ok(snapshot.ok, snapshot.error);
    leaf.pgid = snapshot.value.get(leaf.pid)?.pgid;
    assert.ok(!fs.existsSync(path.join(root, 'leaf.json')), 'cancellation precedes receipt publication');
  }
  const suite = Number(fs.readFileSync(path.join(f.root, 'suite')));
  assert.equal(leaf.pid, leaf.pgid);
  assert.notEqual(leaf.pgid, leaf.parentGroup);
  assert.notEqual(leaf.pgid, suite, 'leaf is outside the suite group');
  if (kind !== 'blocked') outer.kill(kind === 'SIGKILL-before-receipt' ? 'SIGKILL' : kind);
  const result = await waitForExit(outer);
  if (kind === 'blocked') {
    assert.equal(result.code, 1, result.stdout + result.stderr);
    assert.match(result.stdout, /real detached cancellation fixture/);
    assert.match(result.stdout, /did not exit within 3000ms/);
  }
  await waitForDetachedCleanup(f.root);
});

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

async function assertGone(pid) {
  const deadline = Date.now() + 2000;
  for (;;) {
    try { process.kill(pid, 0); }
    catch (error) { if (error.code === 'ESRCH') return; throw error; }
    if (Date.now() >= deadline) break;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' }, `fixture process ${pid} survived cleanup`);
}

test('a nested bounded suite may exceed one command deadline while ordinary commands retain their bound', async t => {
  assert.throws(() => spawnChild(t, process.execPath, ['-e', 'while(true){}'], {}, 35000), /child timeout must be 1\.\.15000ms/);
  const f = fixture(t, () => `test('aggregate suite longer than one command',async()=>{await new Promise(resolve=>setTimeout(resolve,15500));});`);
  const child = spawnChild(t, process.execPath, [runner, '--file-timeout=25000', '--suite-timeout=30000', f.file], {}, 35000);
  const result = await waitForExit(child);
  assert.equal(result.code, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /aggregate suite longer than one command/);
});

test('a late waiter receives a child result and output after close', async (t) => {
  const child = spawnChild(t, process.execPath, ['-e', "console.log('already closed')"]);
  await waitForExit(child);
  // The close event has already fired. The old waiter would miss it.
  const result = await waitForExit(child);
  assert.equal(result.code, 0);
  assert.equal(result.stdout, 'already closed\n');
});

test('a completed fixture never looks up or signals its historical PID during teardown', async (t) => {
  const f = fixture(t, () => `import cp from 'node:child_process';
import {syncBuiltinESMExports} from 'node:module';
test('already completed fixture',async(t)=>{
const child=spawnChild(t,process.execPath,['-e','console.log("complete")']);
await waitForExit(child);
let queries=0;const original=cp.spawnSync;
cp.spawnSync=(command,...args)=>{if(command==='ps'){queries++;throw Error('historical PID lookup must not happen');}return original(command,...args);};
syncBuiltinESMExports();
if(child.kill('SIGKILL'))throw Error('already completed child was signalled');
t.after(()=>{cp.spawnSync=original;syncBuiltinESMExports();if(queries)throw Error('teardown queried a completed fixture');});
});`);
  const child = spawnChild(t, process.execPath, [runner, f.file]);
  const result = await waitForExit(child);
  assert.equal(result.code, 0, result.stdout + result.stderr);
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
    for (const file of ['pid', 'grandchild']) await assertGone(Number(fs.readFileSync(path.join(f.root, file), 'utf8')));
  });
}

for (const kind of ['file', 'suite']) {
  test(`${kind} watchdog bounds a blocked event loop and clears the fixture group`, async (t) => {
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
    await assertGone(Number(fs.readFileSync(path.join(f.root, 'pid'), 'utf8')));
  });
}

for (const signal of ['SIGTERM', 'SIGKILL']) {
  test(`${signal} of an outer runner reaps every nested worker and blocked fixture descendant`, async (t) => {
    const owned = [];
    // If this regression fails, its reproducer must still leave no live fixtures.
    t.after(() => { for (const entry of owned.toReversed()) killProcess(entry); });
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
      [outer.pid, false], [first.worker, true], [first.file, false], [first.runner, false],
      [second.worker, true], [second.file, false], [second.shell, false], [second.sleep, false],
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

test('a leader exiting before its redirected background child fails the suite and leaves no survivor', async (t) => {
  const name = 'leader exits before background fixture';
  const f = fixture(t, root => `test(${JSON.stringify(name)},async(t)=>{
const child=spawnChild(t,'/bin/sh',['-c',${JSON.stringify(`sleep 60 >/dev/null 2>&1 & echo $! > '${root}/background'; exit 0`)}]);
await waitForExit(child);
});`);
  const child = spawnChild(t, process.execPath, [runner, f.file]);
  const result = await waitForExit(child);
  assert.equal(result.code, 1, result.stdout + result.stderr);
  assert.ok(result.stdout.includes(name), result.stdout);
  assert.match(result.stderr, /Surviving fixture: PID \d+, command sleep 60/);
  await assertGone(Number(fs.readFileSync(path.join(f.root, 'background'), 'utf8')));
});

test('a failed end-of-suite lookup still performs freshly confirmed group teardown without suspending fixtures', async (t) => {
  const f = fixture(t, root => `test('audit lookup failure',async(t)=>{
const child=spawnChild(t,'/bin/sh',['-c',${JSON.stringify(`sleep 60 >/dev/null 2>&1 & echo $! > '${root}/fixture'; exit 0`)}]);
fs.writeFileSync(${JSON.stringify(path.join(root, 'worker'))},String(process.ppid));
await waitForExit(child);
});`);
  const fault = path.join(f.root, 'audit-failure.mjs');
  fs.writeFileSync(fault, `import cp from 'node:child_process';
import {syncBuiltinESMExports} from 'node:module';
const original=cp.spawnSync;
cp.spawnSync=(command,args,options)=>command==='ps'&&args.includes('-A')?{status:null,stdout:'',stderr:'',error:Error('injected audit timeout')}:original(command,args,options);
syncBuiltinESMExports();`);
  const child = spawnChild(t, process.execPath, [runner, f.file], { env: { ...process.env, NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --import=${JSON.stringify(fault)}` } });
  const result = await waitForExit(child);
  assert.equal(result.code, 1, result.stdout + result.stderr);
  assert.match(result.stderr, /process snapshot failed: injected audit timeout/);
  for (const file of ['worker', 'fixture']) await assertGone(Number(fs.readFileSync(path.join(f.root, file), 'utf8')));
});

test('suite cancellation clears a detached spawn frozen before its ownership lookup', async (t) => {
  const f = fixture(t, root => `import cp from 'node:child_process';
import {syncBuiltinESMExports} from 'node:module';
test('spawn before ownership lookup',(t)=>{
const original=cp.spawnSync;
cp.spawnSync=(command,args,options)=>{
 if(command==='ps'&&args.includes('-p')){
  fs.writeFileSync(${JSON.stringify(path.join(root, 'spawning'))},JSON.stringify({child:Number(args.at(-1)),file:process.pid,worker:process.ppid}));
  while(true) {}
 }
 return original(command,args,options);
};
syncBuiltinESMExports();
spawnChild(t,process.execPath,['-e','setInterval(()=>{},1000)'],{detached:true});
});`);
  const child = spawnChild(t, process.execPath, [runner, '--suite-timeout=2500', f.file]);
  const result = await waitForExit(child);
  assert.equal(result.code, 1, result.stdout + result.stderr);
  assert.match(result.stderr, /Test suite exceeded 2500ms/);
  const state = JSON.parse(fs.readFileSync(path.join(f.root, 'spawning'), 'utf8'));
  for (const pid of Object.values(state)) await assertGone(pid);
});

test('fixture environment overrides cannot detach a grandchild from the suite group', async (t) => {
  const f = fixture(t, root => {
    const receipt = path.join(root, 'leaf.json');
    const middle = `const {spawn}=require('node:child_process');const fs=require('node:fs');
const leaf=spawn(process.execPath,['-e','setInterval(()=>{},1000); // r94-policy-leaf'],{detached:true,stdio:'ignore',env:{NODE_OPTIONS:'--no-warnings',PATH:process.env.PATH}});
leaf.unref();fs.writeFileSync(${JSON.stringify(receipt + '.tmp')},JSON.stringify({leaf:leaf.pid}));fs.renameSync(${JSON.stringify(receipt + '.tmp')},${JSON.stringify(receipt)});`;
    const launcher = `require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(middle)}],{detached:true,stdio:'ignore',env:{NODE_OPTIONS:'--no-warnings',PATH:process.env.PATH}}).unref();`;
    return `test('no escaped grandchild',async(t)=>{
const child=spawnChild(t,process.execPath,['-e',${JSON.stringify(launcher)}],{env:{NODE_OPTIONS:'--no-warnings',PATH:process.env.PATH}});
await waitForExit(child);
const deadline=Date.now()+5000;
while(!fs.existsSync(${JSON.stringify(receipt)})&&Date.now()<deadline) await new Promise(r=>setTimeout(r,10));
if(!fs.existsSync(${JSON.stringify(receipt)}))throw Error('grandchild receipt missing');
});`;
  });
  const child = spawnChild(t, process.execPath, [runner, f.file]);
  const result = await waitForExit(child);
  assert.equal(result.code, 1, result.stdout + result.stderr);
  assert.match(result.stderr, /Surviving fixture:.*r94-policy-leaf/);
  await assertGone(JSON.parse(fs.readFileSync(path.join(f.root, 'leaf.json'), 'utf8')).leaf);
});

test('a fresh signal confirms the same owned birth tuple across caller timezone changes', async (t) => {
  const original = process.env.TZ;
  process.env.TZ = 'Pacific/Honolulu';
  const child = spawnChild(t, process.execPath, ['-e', 'setInterval(()=>{},1000)']);
  try {
    process.env.TZ = 'UTC';
    assert.equal(child.kill('SIGTERM'), true, 'time formatting must not turn the same owned process into a mismatch');
    assert.equal(child.killed, true, 'a verified child signal retains native ChildProcess kill bookkeeping');
    assert.equal((await waitForExit(child)).signal, 'SIGTERM');
    await assertGone(child.pid);
  } finally {
    // This also safely reaps the negative control using its original clock.
    process.env.TZ = 'Pacific/Honolulu';
    child.kill('SIGKILL'); await waitForExit(child);
    if (original === undefined) delete process.env.TZ; else process.env.TZ = original;
  }
});
