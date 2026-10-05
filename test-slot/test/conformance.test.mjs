import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadTimeout } from '../../lib/deadline.mjs';

const cli = fileURLToPath(new URL('../test-slot.mjs', import.meta.url));
for (const nested of [false, true]) for (const cause of ['cancel', 'timeout']) test(`${cause} signals compound gate descendants in a ${nested ? 'nested' : 'top-level'} slot`, { timeout: loadTimeout(10000) }, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'slot-conformance-'));
  const ready = path.join(root, 'ready'), got = path.join(root, 'got'), wrapper = path.join(root, 'wrapper'), lock = path.join(root, 'lock');
  const env = { ...process.env, MONITOR_TEST_SLOT_PATH: lock, MONITOR_TEST_SLOT_COMPAT_PATH: lock };
  for (const key of ['MONITOR_TEST_SLOT_TOKEN', 'BCH_CLOAK_TEST_SLOT_TOKEN', 'MONITOR_TEST_SLOT_TIMEOUT_RETRIED']) delete env[key];
  const leaf = path.join(root, 'leaf.cjs');
  fs.writeFileSync(leaf, `const fs=require('fs');process.on('SIGTERM',()=>{fs.writeFileSync(${JSON.stringify(got)},'SIGTERM');process.exit(0);});fs.writeFileSync(${JSON.stringify(ready)},String(process.pid));setInterval(()=>{},1000);`);
  const shell = `${JSON.stringify(process.execPath)} ${JSON.stringify(leaf)}; :`;
  const args = ['run', 'outer', '--', ...(nested ? [process.execPath, cli, 'run', 'inner', '--', '/bin/sh', '-c', `echo $$ > '${wrapper}'; exec /bin/sh -c '${shell}'`] : ['/bin/sh', '-c', shell])];
  const child = spawn(process.execPath, [cli, ...args], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = ''; child.stderr.on('data', d => { stderr += d; }); child.stdout.resume();
  const done = new Promise(resolve => child.once('close', code => resolve(code)));
  t.after(() => {
    for (const file of [ready, lock]) try { const data = fs.readFileSync(file, 'utf8'); const pid = file === lock ? JSON.parse(data).pgid : Number(data); if(pid)process.kill(file === lock ? -pid : pid,'SIGKILL'); } catch {}
    try { child.kill('SIGKILL'); } catch {}
    fs.rmSync(root, { recursive: true, force: true });
  });
  const deadline = Date.now() + loadTimeout(5000);
  while (!fs.existsSync(ready) && Date.now() < deadline) await new Promise(r => setTimeout(r, 20));
  assert.ok(fs.existsSync(ready), stderr);
  const target = nested ? Number(fs.readFileSync(wrapper, 'utf8')) : child.pid;
  // shell wrapper execs retain its PID; the inner CLI is its parent.
  let inner = target;
  if (nested) {
    const { lookupProcess } = await import('../../lib/processes.mjs');
    inner = lookupProcess(target).value.ppid;
  }
  if (cause === 'timeout') await new Promise(r => setTimeout(() => { process.kill(inner, 'SIGTERM'); r(); }, 100));
  else process.kill(inner, 'SIGTERM');
  // Bound the witness so a surviving descendant cannot hang the suite.
  const finished = await Promise.race([done, new Promise(r => setTimeout(() => r(null), 1500))]);
  assert.equal(fs.existsSync(got), true, 'the Node descendant receives the signal');
  assert.notEqual(finished, null, stderr); assert.notEqual(finished, 0);
});

for (const nested of [false, true]) test(`stopping the synchronous gate caller signals its ${nested ? 'nested' : 'top-level'} compound gate group`, { timeout: loadTimeout(10000) }, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'slot-parent-'));
  const ready = path.join(root, 'ready'), got = path.join(root, 'got'), caller = path.join(root, 'caller'), lock = path.join(root, 'lock');
  const env = { ...process.env, MONITOR_TEST_SLOT_PATH: lock, MONITOR_TEST_SLOT_COMPAT_PATH: lock };
  for (const key of ['MONITOR_TEST_SLOT_TOKEN', 'BCH_CLOAK_TEST_SLOT_TOKEN', 'MONITOR_TEST_SLOT_TIMEOUT_RETRIED']) delete env[key];
  const leaf = path.join(root, 'leaf.cjs'), adapter = path.join(root, 'adapter.mjs');
  fs.writeFileSync(leaf, `const fs=require('fs');process.on('SIGTERM',()=>{fs.writeFileSync(${JSON.stringify(got)},'SIGTERM');process.exit(0);});fs.writeFileSync(${JSON.stringify(ready)},String(process.pid));setInterval(()=>{},1000);`);
  fs.writeFileSync(adapter, `import fs from 'node:fs';import {runTestSlotSync} from ${JSON.stringify(new URL('../run.mjs', import.meta.url).href)};
fs.writeFileSync(${JSON.stringify(caller)},String(process.pid));runTestSlotSync('gate',['/bin/sh','-c',${JSON.stringify(`${JSON.stringify(process.execPath)} ${JSON.stringify(leaf)}; :`)}],{retryTimeout:false,stdio:'inherit'});`);
  const args = nested ? [cli, 'run', 'outer', '--', process.execPath, adapter] : [adapter];
  const child = spawn(process.execPath, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.resume(); child.stderr.resume(); const done = new Promise(resolve => child.once('close', resolve));
  t.after(() => {
    for (const file of [ready, lock]) try { const data = fs.readFileSync(file, 'utf8'); const pid = file === lock ? JSON.parse(data).pgid : Number(data); if(pid)process.kill(file === lock ? -pid : pid,'SIGKILL'); } catch {}
    try { child.kill('SIGKILL'); } catch {}
    fs.rmSync(root, { recursive: true, force: true });
  });
  const deadline = Date.now() + loadTimeout(5000);
  while (!fs.existsSync(ready) && Date.now() < deadline) await new Promise(r => setTimeout(r, 20));
  assert.ok(fs.existsSync(ready)); process.kill(Number(fs.readFileSync(caller, 'utf8')), 'SIGTERM');
  await Promise.race([done, new Promise(r => setTimeout(r, 1500))]);
  assert.ok(fs.existsSync(got), 'orphaned gate descendant receives cancellation');
});
