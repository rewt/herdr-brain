import test from '../../test/helpers/bounded-test.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fixture } from './helpers/conformance.mjs';

test('profile completed time excludes interruptions and exposes executed time separately', t => {
  const f = fixture(t); f.lane('topic'); const b = f.batch(['topic']);
  let serial = 0;
  const gate = (command, seconds, extra = {}) => ({ command, executed: true,
    started_at: new Date(Date.parse('2026-10-05T12:00:00Z') + serial++ * 1000).toISOString(), finished_at: '2026-10-05T12:00:30Z',
    duration_s: seconds, exit_code: 0, signal: null, ...extra });
  const completed = gate('gate-a', 10), interrupted = gate('gate-a', 4, { signal: 'SIGTERM' });
  const gates = [completed, gate('gate-a', 20, { exit_code: 1 }), interrupted,
    gate('gate-a', undefined, { finished_at: undefined }),
    { ...completed, reused: true }, completed,
    gate('gate-b', 7, { signal: 'SIGTERM' })];
  fs.writeFileSync(b.file, JSON.stringify({ ...b.read(), attempts: gates.map(gate => ({ jobs: [{ topic: 'topic' }], gate })) }));
  const m = f.metrics();
  assert.equal(m.summary.gates_executed, 5);
  assert.equal(m.summary.gate_time_s.total, 30);
  assert.equal(m.summary.executed_gate_time_s.total, 41);
  const [a, other] = m.summary.gate_profiles;
  assert.equal(a.command, 'gate-a'); assert.equal(a.gates, 4);
  assert.deepEqual(a.time_s, { samples: 2, total: 30, median: 15, max: 20 });
  assert.deepEqual(a.executed_time_s, { samples: 3, total: 34, median: 10, max: 20 });
  assert.equal(other.command, 'gate-b'); assert.equal(other.time_s.samples, 0);
  assert.equal(other.executed_time_s.total, 7);
});
