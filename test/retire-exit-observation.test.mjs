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
