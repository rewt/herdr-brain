// This test needs real process groups, like the other raw host-slot tests.
import test from '../../test/helpers/bounded-test.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fixture, cli } from '../../promote/test/helpers/conformance.mjs';

test('hard interruption preserves a started gate and counts it after resuming the prepared attempt', async t => {
  const f = fixture(t); f.lane('topic'); const b = f.batch(['topic']);
  const ready = path.join(f.root, 'running'), finish = path.join(f.root, 'finish');
  f.body(`fs.writeFileSync(${JSON.stringify(ready)},String(process.pid));const timer=setInterval(()=>{if(fs.existsSync(${JSON.stringify(finish)})){clearInterval(timer);console.log('interrupted parent gate finished');process.exit(1);}},20);`);
  const { spawnChild, waitForExit } = await import('../../test/helpers/child.mjs');
  const worker = spawnChild(t, process.execPath, [cli, 'promote-batch', b.file], { cwd: f.repo, env: f.env });
  const until = async predicate => { const end = Date.now() + 5000; while (!predicate() && Date.now() < end) await new Promise(r => setTimeout(r, 20)); assert.ok(predicate()); };
  t.after(() => { if (fs.existsSync(f.root)) fs.writeFileSync(finish, 'finish'); });
  await until(() => fs.existsSync(ready));
  const { registerProcess, killProcess } = await import('../../test/helpers/processes.mjs');
  const leaf = registerProcess(Number(fs.readFileSync(ready, 'utf8')));
  t.after(() => killProcess(leaf));
  const pending = b.read().attempts[0].gate;
  assert.equal(JSON.parse(fs.readFileSync(pending.execution_receipt)).command_started, true);
  assert.equal(f.metrics().summary.gates_executed, 1, 'a still-running gate is an executed gate');
  worker.kill('SIGKILL'); await waitForExit(worker);
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
});
