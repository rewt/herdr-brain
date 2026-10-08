import test from '../../test/helpers/bounded-test.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fixture } from './helpers/conformance.mjs';

test('unconfigured train retains slot grants, prepare clocks and command evidence in its receipt', t => {
  const f = fixture(t); f.lane('timing'); const b = f.batch(['timing']);
  const queued = new Date(Date.now() - 1000).toISOString();
  const plan = b.read(); plan.jobs[0].queued = queued; fs.writeFileSync(b.file, JSON.stringify(plan));
  const r = b.run(); assert.equal(r.status, 0, r.stdout + r.stderr);
  const train = b.read(), attempt = train.attempts[0];
  assert.ok(Date.parse(train.slot_granted_at) >= Date.parse(train.started_at));
  assert.ok(Date.parse(attempt.prepare.finished_at) >= Date.parse(attempt.prepare.started_at));
  assert.equal(train.external_lock_required, false);
  const slot = JSON.parse(fs.readFileSync(attempt.gate.slot_receipt));
  assert.equal(slot.acquired_at, train.slot_granted_at); assert.equal(slot.state, 'acquired');
  const execution = JSON.parse(fs.readFileSync(attempt.gate.execution_receipt));
  assert.equal(attempt.gate.command_started_at, execution.started_at);
  assert.equal(attempt.gate.command_finished_at, execution.finished_at);
  fs.unlinkSync(attempt.gate.execution_receipt); // Completed receipts carry their own command clocks.
  const m = f.metrics(), timing = m.batches[0].timing;
  assert.equal(timing.queue_wait_s, (Date.parse(train.started_at) - Date.parse(queued)) / 1000);
  assert.equal(timing.slot_wait_s, (Date.parse(slot.acquired_at) - Date.parse(train.started_at)) / 1000);
  assert.equal(timing.gate_time_s, (Date.parse(execution.finished_at) - Date.parse(execution.started_at)) / 1000);
});

test('preparation refusal closes its measured interval without inventing slot or gate time', t => {
  const f = fixture(t);
  fs.writeFileSync(f.config, JSON.stringify({ prepare: [{ run: 'exit 9' }] }));
  f.lane('refused'); const b = f.batch(['refused']);
  const r = b.run(); assert.equal(r.status, 0, r.stdout + r.stderr);
  const plan = b.read(), preparation = plan.attempts[0].prepare;
  assert.ok(Date.parse(preparation.finished_at) >= Date.parse(preparation.started_at));
  assert.equal(plan.attempts[0].gate, undefined); assert.equal(plan.slot_granted_at, undefined);
  const timing = f.metrics().batches[0].timing;
  assert.ok(timing.prepare_time_s >= 0); assert.equal(timing.slot_wait_s, null); assert.equal(timing.gate_time_s, null);
});

test('resuming preparation keeps prior intervals and the first slot grant', t => {
  const f = fixture(t); f.lane('resumed'); const b = f.batch(['resumed']);
  f.body("process.exit(1)"); assert.equal(b.run().status, 0);
  const before = b.read(), firstGrant = before.slot_granted_at;
  before.results = {}; before.groups = [['resumed']]; before.attempts[0].phase = 'prepared';
  delete before.slot_granted_at; // A lost caller response left only the durable slot sidecar.
  f.git(['worktree', 'add', '-b', before.attempts[0].branch, before.attempts[0].scratch, before.attempts[0].tip]);
  fs.writeFileSync(b.file, JSON.stringify(before));
  f.body("console.log('green')"); const r = b.run(); assert.equal(r.status, 0, r.stderr);
  const after = b.read(); assert.equal(after.started_at, before.started_at);
  assert.equal(after.slot_granted_at, firstGrant);
  assert.deepEqual(after.attempts[0].prepare_history, [before.attempts[0].prepare]);
  assert.equal(f.metrics().summary.gates_executed, 2);
});
