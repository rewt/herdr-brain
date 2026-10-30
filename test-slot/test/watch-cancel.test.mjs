import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { testSlotEnvironment } from '../../test/helpers/test-slot-env.mjs';

const cli = fileURLToPath(new URL('../test-slot.mjs', import.meta.url));
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) test(`${signal} during the first payload watch audit reaches compound descendants`, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'watch-cancel-'));
  const ready = path.join(root, 'ready'), got = path.join(root, 'got'), auditing = path.join(root, 'auditing');
  const startupAudit = path.join(root, 'startup-audit');
  const resume = path.join(root, 'resume'), lock = path.join(root, 'slot'), preload = path.join(root, 'audit.mjs');
  const leaf = path.join(root, 'leaf.cjs');
  fs.writeFileSync(leaf, `const fs=require('fs');process.on(${JSON.stringify(signal)},()=>{fs.writeFileSync(${JSON.stringify(got)},${JSON.stringify(signal)});process.exit(0);});fs.writeFileSync(${JSON.stringify(ready)},String(process.pid)+'\\n');setInterval(()=>{},1000);`);
  // The occupancy barrier must finish its pre-payload audit before granting
  // exec. Hold the first real CPU audit containing the ready descendant so
  // cancellation still exercises the compound tree without a circular wait.
  fs.writeFileSync(preload, `import cp from 'node:child_process';import fs from 'node:fs';import {syncBuiltinESMExports} from 'node:module';
const execute=cp.spawnSync;cp.spawnSync=(file,args,...rest)=>{
  if(file==='/bin/ps'&&args.includes('pid=,time=,stat=')){
    const pids=args.at(-1).split(',');
    if(!fs.existsSync(${JSON.stringify(startupAudit)}))fs.writeFileSync(${JSON.stringify(startupAudit)},JSON.stringify({pids,payload_ready:fs.existsSync(${JSON.stringify(ready)})}));
    const descendant=fs.existsSync(${JSON.stringify(ready)})?fs.readFileSync(${JSON.stringify(ready)},'utf8'):'';
    if(descendant.endsWith('\\n')&&pids.includes(descendant.trim())){
      fs.writeFileSync(${JSON.stringify(auditing)},args.at(-1)+'\\n');
      while(!fs.existsSync(${JSON.stringify(resume)}))Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,10);
    }
  }
  return execute(file,args,...rest);
};syncBuiltinESMExports();`);
  // Poll every 250 ms via the idle clock, while keeping frozen cancellation
  // well above the brief audit hold. These clocks apply only to this fixture.
  const env = { ...testSlotEnvironment(), MONITOR_TEST_SLOT_PATH: lock, MONITOR_TEST_SLOT_COMPAT_PATH: lock,
    MONITOR_TEST_SLOT_FROZEN_SECONDS: '120' };
  env.NODE_OPTIONS = `${env.NODE_OPTIONS ?? ''} --import=${JSON.stringify(preload)}`;
  const child = spawn(process.execPath, [cli, 'run', 'cancel at startup', '--idle-timeout-seconds', '1', '--', '/bin/sh', '-c',
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
  // Newline framing distinguishes complete fixture writes from empty/partial
  // files. Hold cancellation until the audit actually contains the ready pid.
  let descendant;
  for (;;) {
    if (spawnError) throw spawnError;
    assert.equal(child.exitCode, null, `watch wrapper exited before readiness: ${stderr}`);
    assert.equal(child.signalCode, null, `watch wrapper was signalled before readiness: ${stderr}`);
    const readyPid = fs.existsSync(ready) ? fs.readFileSync(ready, 'utf8') : '';
    const audit = fs.existsSync(auditing) ? fs.readFileSync(auditing, 'utf8') : '';
    if (readyPid.endsWith('\n') && audit.endsWith('\n') && audit.trim().split(',').includes(readyPid.trim())) {
      descendant = readyPid.trim();
      break;
    }
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.ok(fs.existsSync(ready) && fs.existsSync(auditing), stderr);
  const startup = JSON.parse(fs.readFileSync(startupAudit, 'utf8'));
  assert.equal(startup.payload_ready, false, 'the pre-grant audit completes before the payload can start');
  assert.equal(startup.pids.includes(descendant), false);
  assert.ok(fs.readFileSync(auditing, 'utf8').trim().split(',').includes(descendant), 'cancellation is held in an audit of the ready descendant');
  child.kill(signal);
  fs.writeFileSync(resume, 'resume');
  const result = await done;
  assert.equal(fs.existsSync(got) && fs.readFileSync(got, 'utf8'), signal, 'the descendant handles cancellation during watch startup');
  assert.ok(result, stderr); assert.notEqual(result.code, 0);
  assert.equal(fs.existsSync(lock), false, 'the cancelled gate releases its slot');
  assert.deepEqual(fs.readdirSync(`${lock}.occupancy`), []);
});
