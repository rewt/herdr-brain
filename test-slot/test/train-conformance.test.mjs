// This test needs real process groups, like the other raw host-slot tests.
import test from '../../test/helpers/bounded-test.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { once } from 'node:events';
import { fixture, cli } from '../../promote/test/helpers/conformance.mjs';
import { gateHistoryKey, historyFile } from '../limits.mjs';
import { holderState } from '../test-slot.mjs';
import { testSlotEnvironment } from '../../test/helpers/test-slot-env.mjs';
import { spawnChild, spawnScenarioChild, waitForExit } from '../../test/helpers/child.mjs';
import { killProcess } from '../../test/helpers/processes.mjs';

test('hard interruption preserves a started gate and counts it after resuming the prepared attempt', async t => {
  const f = fixture(t); f.lane('topic'); const b = f.batch(['topic']);
  f.env.MONITOR_GATE_HISTORY_ROOT = path.join(f.root, 'history');
  // Plant the host-shaped state in this disposable repository, never the host.
  // Include the exact gate key, so a lost override would read foreign clocks.
  const command = ['/bin/sh', '-c', `${process.execPath} ${f.checker}`];
  const foreignHistory = path.join(f.identity, 'gate-watchdog');
  fs.mkdirSync(foreignHistory);
  for (let i = 0; i < 128; i++) {
    const argv = i === 0 ? command : ['foreign', String(i)];
    const file = historyFile(f.identity, 'promotion', argv, undefined, {});
    fs.writeFileSync(file, JSON.stringify({ schema: 'gate-watchdog/v1', tier: 'promotion',
      command_fingerprint: gateHistoryKey('promotion', argv).command_fingerprint,
      runs: Array.from({ length: 3 }, () => ({ command: argv, origin: 'foreign', duration_s: 999999,
        longest_silence_s: 999999, finished_at: new Date().toISOString() })) }));
  }
  const foreignBefore = fs.readdirSync(foreignHistory).sort().map(name => [name, fs.readFileSync(path.join(foreignHistory, name), 'utf8')]);
  assert.equal(foreignBefore.length, 128);
  const foreignSlot = path.join(f.root, 'foreign-slot');
  const holder = spawnScenarioChild(t, process.execPath, ['--input-type=module', '-e', `
    import { acquireTestSlot } from ${JSON.stringify(new URL('../test-slot.mjs', import.meta.url).href)};
    const slot = await acquireTestSlot('foreign holder', { lockPath: ${JSON.stringify(foreignSlot)}, waitSeconds: 0 });
    process.on('message', () => { slot.release(); process.disconnect(); });
    process.send(slot.holder);
  `], { cwd: f.root, env: testSlotEnvironment(), stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  const [foreignHolder] = await Promise.race([
    once(holder, 'message'),
    waitForExit(holder).then(result => assert.fail(`foreign holder exited before its grant: ${result.stderr}`)),
  ]);
  assert.equal(holderState(foreignHolder).state, 'live');

  const ready = path.join(f.root, 'running'), finish = path.join(f.root, 'finish');
  // Interrupt at the real started-gate boundary. Polling for this from the test
  // raced all promotion/Git preparation against an unrelated five-second clock.
  // The existing child watchdog still bounds startup; no timeout is extended.
  f.body(`
    const timer=setInterval(()=>{if(fs.existsSync(${JSON.stringify(finish)})){clearInterval(timer);process.exit(1);}},20);
    (async () => {
      const assert = require('node:assert/strict');
      const { collectMetrics } = await import(${JSON.stringify(new URL('../../promote/metrics.mjs', import.meta.url).href)});
      const { registerProcess, killProcess } = await import(${JSON.stringify(new URL('../../test/helpers/processes.mjs', import.meta.url).href)});
      const plan = JSON.parse(fs.readFileSync(${JSON.stringify(b.file)}));
      const gate = plan.attempts[0].gate;
      const execution = JSON.parse(fs.readFileSync(gate.execution_receipt));
      const owner = JSON.parse(fs.readFileSync(${JSON.stringify(path.join(f.identity, 'lane-promote.lock/owner.json'))}));
      const worker = registerProcess(owner.pid);
      assert.equal(worker.command, ${JSON.stringify([process.execPath, cli, 'promote-batch', b.file].join(' '))});
      fs.writeFileSync(${JSON.stringify(ready)}, JSON.stringify({ gate, execution, worker,
        leaf: registerProcess(process.pid), metrics: collectMetrics({ project: ${JSON.stringify(f.repo)} }),
        history: process.env.MONITOR_GATE_HISTORY_ROOT, slot: process.env.MONITOR_TEST_SLOT_PATH,
        compat: process.env.MONITOR_TEST_SLOT_COMPAT_PATH }));
      assert.equal(killProcess(worker, 'SIGKILL').signaled, true);
    })().catch(error => { console.error(error); process.exit(1); });
  `);
  const worker = spawnChild(t, process.execPath, [cli, 'promote-batch', b.file], { cwd: f.repo, env: f.env });
  const until = async predicate => { const end = Date.now() + 5000; while (!predicate() && Date.now() < end) await new Promise(r => setTimeout(r, 20)); assert.ok(predicate(), 'interrupted gate did not finish its execution receipt'); };
  t.after(() => { if (fs.existsSync(f.root)) fs.writeFileSync(finish, 'finish'); });
  const stopped = await waitForExit(worker);
  assert.equal(stopped.signal, 'SIGKILL', stopped.stderr);
  const observed = JSON.parse(fs.readFileSync(ready));
  t.after(() => killProcess(observed.leaf));
  assert.equal(observed.worker.pid, worker.pid);
  assert.equal(observed.history, f.env.MONITOR_GATE_HISTORY_ROOT);
  assert.equal(observed.slot, f.env.MONITOR_TEST_SLOT_PATH);
  assert.equal(observed.compat, f.env.MONITOR_TEST_SLOT_COMPAT_PATH);
  assert.notEqual(observed.slot, foreignSlot);
  const pending = observed.gate;
  assert.deepEqual(b.read().attempts[0].gate, pending, 'the killed worker preserved the started gate');
  assert.equal(observed.execution.command_started, true);
  assert.equal(observed.execution.finished_at, undefined);
  assert.equal(observed.metrics.summary.gates_executed, 1, 'a still-running gate is an executed gate');
  await until(() => JSON.parse(fs.readFileSync(pending.execution_receipt)).finished_at);
  // Remove only this dead fixture owner's locks; no live-host lock is involved.
  for (const directory of [path.join(f.identity, 'lane-promote.lock'), ...fs.readdirSync(path.join(f.identity, 'lane-validation')).filter(n => n.endsWith('.lock')).map(n => path.join(f.identity, 'lane-validation', n))]) {
    const owner = JSON.parse(fs.readFileSync(path.join(directory, 'owner.json')));
    assert.equal(owner.pid, worker.pid); assert.throws(() => process.kill(owner.pid, 0)); fs.rmSync(directory, { recursive: true });
  }
  f.body("console.log('resumed green');"); const r = b.run(); assert.equal(r.status, 0, r.stderr);
  const m = f.metrics(); assert.equal(m.summary.gates_executed, 2); assert.equal(m.summary.interrupted, 1); assert.equal(m.summary.green, 1);
  assert.equal(m.summary.executed_gate_time_s.samples, 2); assert.equal(m.summary.first_pass.rate, null);
  assert.deepEqual(b.read().attempts[0].gate_history[0], pending);
  assert.equal(holderState(foreignHolder).state, 'live', 'the foreign slot remains held across interruption and resume');
  assert.deepEqual(fs.readdirSync(foreignHistory).sort().map(name => [name, fs.readFileSync(path.join(foreignHistory, name), 'utf8')]), foreignBefore);
  assert.equal(JSON.parse(fs.readFileSync(pending.execution_receipt)).limits.wall_source, 'default', 'foreign clocks were not used');
  holder.send('release');
  const released = await waitForExit(holder); assert.equal(released.status, 0, released.stderr);
});
