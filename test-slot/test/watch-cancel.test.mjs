import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { testSlotEnvironment } from '../../test/helpers/test-slot-env.mjs';

const cli = fileURLToPath(new URL('../test-slot.mjs', import.meta.url));
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) test(`${signal} during the first watch audit reaches compound descendants`, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'watch-cancel-'));
  const ready = path.join(root, 'ready'), got = path.join(root, 'got'), auditing = path.join(root, 'auditing');
  const resume = path.join(root, 'resume'), lock = path.join(root, 'slot'), preload = path.join(root, 'audit.mjs');
  const leaf = path.join(root, 'leaf.cjs');
  fs.writeFileSync(leaf, `const fs=require('fs');process.on(${JSON.stringify(signal)},()=>{fs.writeFileSync(${JSON.stringify(got)},${JSON.stringify(signal)});process.exit(0);});fs.writeFileSync(${JSON.stringify(ready)},String(process.pid));setInterval(()=>{},1000);`);
  // Hold the real first CPU audit until the payload is ready and cancellation
  // has arrived. This exercises startup ordering without relying on ps speed.
  fs.writeFileSync(preload, `import cp from 'node:child_process';import fs from 'node:fs';import {syncBuiltinESMExports} from 'node:module';
const execute=cp.spawnSync;cp.spawnSync=(file,args,...rest)=>{
  if(file==='/bin/ps'&&args.includes('pid=,time=,stat=')){
    fs.writeFileSync(${JSON.stringify(auditing)},args.at(-1));
    while(!fs.existsSync(${JSON.stringify(resume)}))Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,10);
  }
  return execute(file,args,...rest);
};syncBuiltinESMExports();`);
  const env = { ...testSlotEnvironment(), MONITOR_TEST_SLOT_PATH: lock, MONITOR_TEST_SLOT_COMPAT_PATH: lock };
  env.NODE_OPTIONS = `${env.NODE_OPTIONS ?? ''} --import=${JSON.stringify(preload)}`;
  const child = spawn(process.execPath, [cli, 'run', 'cancel at startup', '--', '/bin/sh', '-c',
    `${JSON.stringify(process.execPath)} ${JSON.stringify(leaf)}; :`], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = ''; child.stderr.on('data', data => { stderr += data; }); child.stdout.resume();
  let spawnError;
  const closed = new Promise(resolve => child.once('close', (code, signal) => resolve({ code, signal })));
  const done = new Promise((resolve, reject) => {
    child.once('error', error => { spawnError = error; reject(error); });
    closed.then(resolve);
  });
  done.catch(() => {}); // The readiness loop also surfaces an early spawn error.
  t.after(async () => {
    fs.writeFileSync(resume, 'resume');
    if (fs.existsSync(auditing)) {
      const pgid = Number(fs.readFileSync(auditing, 'utf8').split(',')[0]);
      try { process.kill(-pgid, 'SIGKILL'); } catch {}
    }
    if (fs.existsSync(ready)) try { process.kill(Number(fs.readFileSync(ready, 'utf8')), 'SIGKILL'); } catch {}
    child.kill('SIGKILL'); await closed;
    fs.rmSync(root, { recursive: true, force: true });
  });
  while (!fs.existsSync(ready) || !fs.existsSync(auditing)) {
    if (spawnError) throw spawnError;
    assert.equal(child.exitCode, null, `watch wrapper exited before readiness: ${stderr}`);
    assert.equal(child.signalCode, null, `watch wrapper was signalled before readiness: ${stderr}`);
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.ok(fs.existsSync(ready) && fs.existsSync(auditing), stderr);
  child.kill(signal);
  fs.writeFileSync(resume, 'resume');
  const result = await done;
  assert.equal(fs.existsSync(got) && fs.readFileSync(got, 'utf8'), signal, 'the descendant handles cancellation during watch startup');
  assert.ok(result, stderr); assert.notEqual(result.code, 0);
  assert.equal(fs.existsSync(lock), false, 'the cancelled gate releases its slot');
  assert.deepEqual(fs.readdirSync(`${lock}.occupancy`), []);
});
