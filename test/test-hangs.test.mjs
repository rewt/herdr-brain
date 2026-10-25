import test from './helpers/bounded-test.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnChild, spawnScenarioChild, waitForExit } from './helpers/child.mjs';
import { killProcess, registerProcess } from './helpers/processes.mjs';

const helper = new URL('./helpers/bounded-test.mjs', import.meta.url).href;
const childHelper = new URL('./helpers/child.mjs', import.meta.url).href;
const runner = fileURLToPath(new URL('./helpers/run.mjs', import.meta.url));
process.env.ORG_ACTOR = 'test-hangs-regression';

function runFixture(t, args, options = {}) {
  return spawnScenarioChild(t, process.execPath, [runner, ...args], options);
}
async function launched(child, file) {
  let result, failure;
  waitForExit(child).then(value => { result = value; }, error => { failure = error; });
  while (!fs.existsSync(file) && !result && !failure)
    await new Promise(resolve => setTimeout(resolve, 20));
  if (failure) throw failure;
  assert.ok(fs.existsSync(file), `fixture did not publish ${file}\n${result ? result.stdout + result.stderr : ''}`);
}

function fixture(t, source) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'test-hang-regression-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'culprit.test.mjs');
  fs.writeFileSync(file, `import test from ${JSON.stringify(helper)};
import {spawnChild,spawnScenarioChild,waitForExit} from ${JSON.stringify(childHelper)};
import fs from 'node:fs';
${source(root)}`);
  return { root, file };
}

async function assertGone(pid) {
  for (;;) {
    try { process.kill(pid, 0); }
    catch (error) { if (error.code === 'ESRCH') break; throw error; }
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' }, `fixture process ${pid} survived cleanup`);
}

test('compound fixture scenarios retain legacy arguments and owned cleanup', async t => {
  const child = spawnScenarioChild(t, process.execPath, ['-e', "setTimeout(()=>console.log('scenario completed'),50)"],
    { env: { ...process.env, ORG_ACTOR: 'compound-scenario-test' } }, 35000);
  const result = await waitForExit(child);
  assert.equal(result.code, 0, result.stderr); assert.match(result.stdout, /scenario completed/);
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
let queries=0;const original=cp.spawnSync, originalRead=fs.readFileSync;
fs.readFileSync=(file,...args)=>{if(String(file).startsWith('/proc/')){queries++;throw Error('historical PID lookup must not happen');}return originalRead(file,...args);};
cp.spawnSync=(command,...args)=>{if(String(command).includes('process-source-')){queries++;throw Error('historical PID lookup must not happen');}return original(command,...args);};
syncBuiltinESMExports();
if(child.kill('SIGKILL'))throw Error('already completed child was signalled');
t.after(()=>{cp.spawnSync=original;fs.readFileSync=originalRead;syncBuiltinESMExports();if(queries)throw Error('teardown queried a completed fixture');});
});`);
  const child = runFixture(t, [f.file]);
  const result = await waitForExit(child);
  assert.equal(result.code, 0, result.stdout + result.stderr);
});

for (const kind of ['leak', 'assertion']) {
  test(`${kind} names the failed test and reaps its fixture child and grandchild`, async (t) => {
    const name = `deliberately ${kind} fixture watcher`;
    const f = fixture(t, (root) => {
      const command = `echo $$ > '${root}/pid'; sleep 60 & echo $! > '${root}/grandchild'; wait`;
      return `test(${JSON.stringify(name)},async(t)=>{
const child=spawnChild(t,'/bin/sh',['-c',${JSON.stringify(command)}],{},15000);
while(!fs.existsSync(${JSON.stringify(path.join(root, 'grandchild'))})) await new Promise(r=>setTimeout(r,10));
${kind === 'assertion' ? "throw Error('injected failure before waitForExit');" : ''}
});`;
    });
    const child = runFixture(t, [f.file]);
    const result = await waitForExit(child);
    assert.equal(result.code, 1, result.stdout + result.stderr);
    assert.ok(result.stdout.includes(name), result.stdout);
    assert.match(result.stdout, kind === 'assertion' ? /injected failure before waitForExit/ : /left child running/);
    for (const file of ['pid', 'grandchild']) await assertGone(Number(fs.readFileSync(path.join(f.root, file), 'utf8')));
  });
}

for (const kind of ['SIGTERM', 'SIGHUP']) {
  test(`${kind} cancellation clears a blocked event loop and the fixture group`, async (t) => {
    const f = fixture(t, (root) => `test('blocked event loop culprit',async(t)=>{
const child=spawnChild(t,process.execPath,['-e','setInterval(()=>{},1000)']);
fs.writeFileSync(${JSON.stringify(path.join(root, 'pid'))},String(child.pid));
Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0);
});`);
    // Include deliberately slow startup in the reproducer. A one-second suite
    // deadline can kill the launcher before this test ever owns a fixture PID.
    const preload = path.join(f.root, 'slow-start.mjs');
    fs.writeFileSync(preload, `if(process.argv[1]===${JSON.stringify(f.file)}) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,1250);`);
    const child = runFixture(t, [f.file], {
      env: { ...process.env, NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --import=${JSON.stringify(preload)}` },
    });
    await launched(child, path.join(f.root, 'pid'));
    child.kill(kind);
    const result = await waitForExit(child);
    assert.equal(result.code, 1, result.stdout + result.stderr);
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
Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0);
});`);
      const outer = path.join(root, 'outer.json');
      return `test('enclosing nested runner',async(t)=>{
const child=spawnScenarioChild(t,process.execPath,[${JSON.stringify(runner)},${JSON.stringify(nested)}]);
fs.writeFileSync(${JSON.stringify(outer + '.tmp')},JSON.stringify({file:process.pid,worker:process.ppid,runner:child.pid}));
fs.renameSync(${JSON.stringify(outer + '.tmp')},${JSON.stringify(outer)});
await waitForExit(child);
});`;
    });
    const sentinel = spawnChild(t, process.execPath, ['-e', 'setInterval(()=>{},1000)']);
    const outer = runFixture(t, [f.file]);
    await launched(outer, path.join(f.root, 'inner.json'));
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
    while (alive().length) await new Promise((resolve) => setTimeout(resolve, 10));
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
  const child = runFixture(t, [f.file]);
  const result = await waitForExit(child);
  assert.equal(result.code, 1, result.stdout + result.stderr);
  assert.ok(result.stdout.includes(name), result.stdout);
  assert.match(result.stderr, /Surviving fixture: PID \d+, command sleep 60/);
  await assertGone(Number(fs.readFileSync(path.join(f.root, 'background'), 'utf8')));
});

test('a failed end-of-suite lookup still performs freshly confirmed group teardown without suspending fixtures', async (t) => {
  const f = fixture(t, root => `test('audit lookup failure',async(t)=>{
const child=spawnChild(t,'/bin/sh',['-c',${JSON.stringify(`sleep 60 >/dev/null 2>&1 & echo $! > '${root}/fixture'; sleep 0.05; exit 0`)}]);
fs.writeFileSync(${JSON.stringify(path.join(root, 'worker'))},String(process.ppid));
await waitForExit(child);
});`);
  const fault = path.join(f.root, 'audit-failure.mjs');
  fs.writeFileSync(fault, `import cp from 'node:child_process'; import fs from 'node:fs';
import {syncBuiltinESMExports} from 'node:module';
const original=cp.spawnSync, originalList=fs.readdirSync;
fs.readdirSync=(file,...args)=>{if(file==='/proc')throw Error('injected audit timeout');return originalList(file,...args);};
cp.spawnSync=(command,args,options)=>String(command).includes('process-source-')&&!args.length?{status:null,stdout:'',stderr:'',error:Error('injected audit timeout')}:original(command,args,options);
syncBuiltinESMExports();`);
  const child = runFixture(t, [f.file], { env: { ...process.env, NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --import=${JSON.stringify(fault)}` } });
  const result = await waitForExit(child);
  assert.equal(result.code, 1, result.stdout + result.stderr);
  assert.match(result.stderr, /process snapshot failed: process source unavailable: injected audit timeout/);
  for (const file of ['worker', 'fixture']) await assertGone(Number(fs.readFileSync(path.join(f.root, file), 'utf8')));
});

test('suite cancellation clears a detached spawn frozen before its ownership lookup', async (t) => {
  const f = fixture(t, root => `import cp from 'node:child_process';
import {syncBuiltinESMExports} from 'node:module';
test('spawn before ownership lookup',(t)=>{
const original=cp.spawnSync, originalRead=fs.readFileSync;
fs.readFileSync=(file,...args)=>{const match=String(file).match(/^\\/proc\\/(\\d+)\\/stat$/);if(match){fs.writeFileSync(${JSON.stringify(path.join(root, 'spawning'))},JSON.stringify({child:Number(match[1]),file:process.pid,worker:process.ppid}));while(true){}}return originalRead(file,...args);};
cp.spawnSync=(command,args,options)=>{
 if(String(command).includes('process-source-')&&args.length===1){
  fs.writeFileSync(${JSON.stringify(path.join(root, 'spawning'))},JSON.stringify({child:Number(args.at(-1)),file:process.pid,worker:process.ppid}));
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0);
 }
 return original(command,args,options);
};
syncBuiltinESMExports();
spawnChild(t,process.execPath,['-e','setInterval(()=>{},1000)'],{detached:true});
});`);
  const child = runFixture(t, [f.file]);
  await launched(child, path.join(f.root, 'spawning'));
  child.kill('SIGTERM');
  const result = await waitForExit(child);
  assert.equal(result.code, 1, result.stdout + result.stderr);
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
while(!fs.existsSync(${JSON.stringify(receipt)})) await new Promise(r=>setTimeout(r,10));
if(!fs.existsSync(${JSON.stringify(receipt)}))throw Error('grandchild receipt missing');
});`;
  });
  const child = runFixture(t, [f.file]);
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
