import test from './helpers/bounded-test.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { setup, events } from './helpers/closeout-fixture.mjs';
import { currentCloseoutEntries, unresolvedCloseoutEffect } from '../lib/closeout.mjs';

test('exit transition preserves exact original mismatch facts and never replays the UNKNOWN effect', t => {
  const f = setup(t, { direct: true, bound: true }); f.report();
  const entry = currentCloseoutEntries(f.common, f.org, events(f))[0], command = f.options.command;
  f.options.command = (exe, args, options) => {
    const result = command(exe, args, options);
    if (exe === f.job.herdr && args[0] === 'agent' && args[1] === 'prompt' && result.status === 0) {
      const state = f.read();
      state.agents = [{ ...f.state.agents[0], agent_session: { value: 'replacement' } }];
      fs.writeFileSync(f.file, JSON.stringify(state));
    }
    return result;
  };
  const drain = () => f.drain({ keys: [entry.key], retrySafe: true });
  const row = drain().evaluated[0], observed = row.native_result.exit_observation;
  assert.equal(observed.state, 'changed');
  assert.equal(observed.occupants[0][6], 'replacement');
  assert.equal(observed.panes[0].terminal, 'term');
  assert.deepEqual(observed.panes[0].tree.map(p => [p.pid, p.identity]), [[1, 'shell']]);
  const original = events(f), failed = original.find(e => e.type === 'closeout.command-failed');
  assert.deepEqual(failed.native_result, row.native_result);
  assert.ok(unresolvedCloseoutEffect(entry, original));
  const calls = f.herdrCalls(), actions = f.read().actions;
  assert.deepEqual(drain().evaluated, []);
  assert.deepEqual(f.herdrCalls(), calls); assert.deepEqual(f.read().actions, actions);
  assert.deepEqual(events(f).slice(0, original.length), original);
});

test('exit diagnostics preserve a thrown observation through closeout events without retry', t => {
  const f = setup(t, { direct: true, bound: true }); f.report();
  const entry = currentCloseoutEntries(f.common, f.org, events(f))[0], command = f.options.command;
  let sent = false, refused = 0;
  f.options.command = (exe, args, options) => {
    if (sent && exe === f.job.herdr && args[0] === 'pane' && args[1] === 'process-info') {
      refused++;
      return { status: 1, stdout: '', stderr: JSON.stringify({ error: { code: 'NATIVE_REFUSAL', message: 'exit observation refused' } }) };
    }
    const result = command(exe, args, options);
    if (exe === f.job.herdr && args[0] === 'agent' && args[1] === 'prompt' && result.status === 0) sent = true;
    return result;
  };
  const drain = () => f.drain({ keys: [entry.key], retrySafe: true });
  const row = drain().evaluated[0], facts = row.native_result.exit_observation;
  assert.equal(refused, 1); assert.equal(facts.state, 'same');
  assert.equal(facts.panes[0].terminal, 'term');
  assert.deepEqual(facts.panes[0].tree.map(p => [p.pid, p.identity]), [[1, 'shell'], [2, 'native'], [3, 'helper']]);
  assert.equal(facts.occupants[0][6], 'session');
  const original = events(f);
  for (const type of ['closeout.evaluated', 'closeout.command-failed'])
    assert.deepEqual(original.find(e => e.type === type && e.key === entry.key).native_result, row.native_result);
  assert.match(row.native_result.reason, /exit observation refused/);
  assert.ok(unresolvedCloseoutEffect(entry, original));
  const calls = f.herdrCalls(), actions = f.read().actions;
  assert.deepEqual(drain().evaluated, []); assert.equal(refused, 1);
  assert.deepEqual(f.herdrCalls(), calls); assert.deepEqual(f.read().actions, actions);
  assert.deepEqual(events(f).slice(0, original.length), original);
});
