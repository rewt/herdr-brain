import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadTimeout } from '../../lib/deadline.mjs';
import { testSlotEnvironment } from '../../test/helpers/test-slot-env.mjs';

const cli = fileURLToPath(new URL('../test-slot.mjs', import.meta.url));
for (const nested of [false, true]) test(`cancel signals compound gate descendants in a ${nested ? 'nested' : 'top-level'} slot`, { timeout: loadTimeout(10000) }, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'slot-conformance-'));
  const ready = path.join(root, 'ready'), got = path.join(root, 'got'), wrapper = path.join(root, 'wrapper'), lock = path.join(root, 'lock'), result = path.join(root, 'result');
  const env = { ...testSlotEnvironment(), MONITOR_TEST_SLOT_PATH: lock, MONITOR_TEST_SLOT_COMPAT_PATH: lock };
  const leaf = path.join(root, 'leaf.cjs');
  fs.writeFileSync(leaf, `const fs=require('fs');process.on('SIGTERM',()=>{fs.writeFileSync(${JSON.stringify(got)},'SIGTERM');process.exit(0);});fs.writeFileSync(${JSON.stringify(ready)},String(process.pid));setInterval(()=>{},1000);`);
  const shell = `${JSON.stringify(process.execPath)} ${JSON.stringify(leaf)}; :`;
  const args = ['run', 'outer', '--result-path', result, '--', ...(nested ? [process.execPath, cli, 'run', 'inner', '--', '/bin/sh', '-c', `echo $$ > '${wrapper}'; exec /bin/sh -c '${shell}'`] : ['/bin/sh', '-c', shell])];
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
  process.kill(inner, 'SIGTERM');
  // The existing outer test deadline bounds a surviving descendant. Native
  // snapshots, TERM grace and pipe close need not fit a separate 1500 ms timer.
  const finished = await done;
  assert.equal(fs.existsSync(got), true, 'the Node descendant receives the signal');
  assert.equal(fs.readFileSync(got, 'utf8'), 'SIGTERM');
  assert.notEqual(finished, null, stderr); assert.notEqual(finished, 0);
  const receipt = JSON.parse(fs.readFileSync(result, 'utf8'));
  const { lookupProcess } = await import('../../lib/processes.mjs');
  const descendant = lookupProcess(Number(fs.readFileSync(ready, 'utf8')), { identityOnly: true });
  assert.equal(descendant.ok, true, descendant.error); assert.equal(descendant.value, null);
  assert.throws(() => process.kill(-receipt.command_pid, 0), { code: 'ESRCH' }, 'the owned command group has disappeared');
  assert.equal(fs.existsSync(lock), false, 'cancellation releases the slot');
  assert.equal(receipt.attempts, 1); assert.equal(receipt.gate_timeout, null);
  assert.doesNotMatch(stderr, /TEST_SLOT_TIMEOUT_RETRY/);
});

for (const nested of [false, true]) test(`spawnSync timeout signals compound gate descendants in a ${nested ? 'nested' : 'top-level'} slot`, { timeout: loadTimeout(15000) }, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'slot-timeout-'));
  const ready = path.join(root, 'ready'), got = path.join(root, 'got'), result = path.join(root, 'result'), lock = path.join(root, 'lock');
  const env = { ...testSlotEnvironment(), MONITOR_TEST_SLOT_PATH: lock, MONITOR_TEST_SLOT_COMPAT_PATH: lock };
  const leaf = path.join(root, 'leaf.cjs'), adapter = path.join(root, 'adapter.mjs');
  const timeout = loadTimeout(2000);
  fs.writeFileSync(leaf, `const fs=require('fs');process.on('SIGTERM',()=>{fs.writeFileSync(${JSON.stringify(got)},'SIGTERM');process.exit(0);});fs.writeFileSync(${JSON.stringify(ready)},String(process.pid));setInterval(()=>{},1000);`);
  fs.writeFileSync(adapter, `import fs from 'node:fs';import {runTestSlotSync} from ${JSON.stringify(new URL('../run.mjs', import.meta.url).href)};
// Nested cancellation also signals this caller in the held command group.
process.on('SIGTERM',()=>{});
const r=runTestSlotSync('timed-gate',['/bin/sh','-c',${JSON.stringify(`${JSON.stringify(process.execPath)} ${JSON.stringify(leaf)}; :`)}],{retryTimeout:false,timeout:${timeout},killSignal:'SIGTERM',stdio:'inherit'});
fs.writeFileSync(${JSON.stringify(result)},JSON.stringify({error:r.error?.code,signal:r.signal,status:r.status}));process.exit(0);`);
  const child = spawn(process.execPath, nested ? [cli, 'run', 'outer', '--', process.execPath, adapter] : [adapter], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = ''; child.stderr.on('data', d => { stderr += d; }); child.stdout.resume();
  const done = new Promise(resolve => child.once('close', code => resolve(code)));
  t.after(() => {
    for (const file of [ready, lock]) try { const data = fs.readFileSync(file, 'utf8'); const pid = file === lock ? JSON.parse(data).pgid : Number(data); if(pid)process.kill(file === lock ? -pid : pid,'SIGKILL'); } catch {}
    try { child.kill('SIGKILL'); } catch {}
    fs.rmSync(root, { recursive: true, force: true });
  });
  const finished = await Promise.race([done, new Promise(r => setTimeout(() => r(null), timeout + loadTimeout(5000)))]);
  assert.notEqual(finished, null, stderr);
  assert.ok(fs.existsSync(ready), 'the compound gate started before the real timeout');
  assert.equal(fs.readFileSync(got, 'utf8'), 'SIGTERM', 'the descendant receives the timeout signal');
  const timed = JSON.parse(fs.readFileSync(result));
  assert.equal(timed.error, 'ETIMEDOUT');
  // A wrapper that forwards and handles SIGTERM exits with its portable 143.
  assert.ok(timed.signal === 'SIGTERM' || timed.status === 143, JSON.stringify(timed));
});

test('the live synchronous caller watch spawns and hashes nothing after gate startup', { timeout: loadTimeout(10000) }, t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'slot-poll-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const started = path.join(root, 'started'), calls = path.join(root, 'calls'), adapter = path.join(root, 'adapter.mjs'), preload = path.join(root, 'count.mjs'), lock = path.join(root, 'lock');
  fs.writeFileSync(calls, '');
  fs.writeFileSync(preload, `import cp from 'node:child_process';import fs from 'node:fs';import crypto from 'node:crypto';import {syncBuiltinESMExports} from 'node:module';
const execute=cp.spawnSync,hash=crypto.createHash;
const count=kind=>{if(fs.existsSync(${JSON.stringify(started)}))fs.appendFileSync(${JSON.stringify(calls)},kind+'\\n');};
cp.spawnSync=(...args)=>{count('spawn');return execute(...args);};crypto.createHash=(...args)=>{count('hash');return hash(...args);};syncBuiltinESMExports();`);
  // Readiness follows the recorded group identity, even on a loaded host.
  fs.writeFileSync(adapter, `import {runTestSlotSync} from ${JSON.stringify(new URL('../run.mjs', import.meta.url).href)};
const command=[process.execPath,'-e',${JSON.stringify(`const fs=require('fs');const timer=setInterval(()=>{if(JSON.parse(fs.readFileSync(require('path').join(${JSON.stringify(lock + '.occupancy')},fs.readdirSync(${JSON.stringify(lock + '.occupancy')}).find(n=>!n.startsWith('.'))),'utf8')).groupBirth){clearInterval(timer);fs.writeFileSync(${JSON.stringify(started)},'ready');setTimeout(()=>process.exit(0),1000);}},20);`)}];const r=runTestSlotSync('poll-proof',command,{retryTimeout:false,encoding:'utf8',timeout:4000});if(r.status!==0)throw Error(r.stderr);`);
  const env = { ...testSlotEnvironment(), MONITOR_TEST_SLOT_PATH: lock, MONITOR_TEST_SLOT_COMPAT_PATH: lock, NODE_OPTIONS: `--import=${preload}` };
  const r = spawnSync(process.execPath, [adapter], { env, encoding: 'utf8', timeout: loadTimeout(5000) });
  assert.equal(r.status, 0, r.stderr); assert.ok(fs.existsSync(started));
  assert.equal(fs.readFileSync(calls, 'utf8'), '', 'polling does not execute a source or hash its bundled helper');
});

for (const nested of [false, true]) test(`stopping the synchronous gate caller signals its ${nested ? 'nested' : 'top-level'} compound gate group`, { timeout: loadTimeout(10000) }, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'slot-parent-'));
  const ready = path.join(root, 'ready'), got = path.join(root, 'got'), caller = path.join(root, 'caller'), lock = path.join(root, 'lock');
  const env = { ...testSlotEnvironment(), MONITOR_TEST_SLOT_PATH: lock, MONITOR_TEST_SLOT_COMPAT_PATH: lock };
  const leaf = path.join(root, 'leaf.cjs'), adapter = path.join(root, 'adapter.mjs');
  fs.writeFileSync(leaf, `const fs=require('fs');process.on('SIGTERM',()=>{fs.writeFileSync(${JSON.stringify(got)},'SIGTERM');process.exit(0);});fs.writeFileSync(${JSON.stringify(ready)},String(process.pid));setInterval(()=>{},1000);`);
  fs.writeFileSync(adapter, `import fs from 'node:fs';import {runTestSlotSync} from ${JSON.stringify(new URL('../run.mjs', import.meta.url).href)};
fs.writeFileSync(${JSON.stringify(caller)},String(process.pid));runTestSlotSync('gate',['/bin/sh','-c',${JSON.stringify(`${JSON.stringify(process.execPath)} ${JSON.stringify(leaf)}; :`)}],{retryTimeout:false,stdio:'inherit',timeout:5000});`);
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
