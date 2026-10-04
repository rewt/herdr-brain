import test from '../../test/helpers/bounded-test.mjs';
import assert from 'node:assert/strict';
import { assertHousekeepingActions } from '../housekeeping.mjs';

const expected = { closedTab: 'done:t1', keptTabs: ['blocked:t1', 'human:t1'] };
const kept = expected.keptTabs.map(tab_id => ({ action: 'keep', tab_id, dryRun: false }));
const log = (...actions) => [...actions, ...kept].map(JSON.stringify).join('\n') + '\n';
const tidy = (output, extra = {}) => ({ action: 'tidy-tabs', output, dryRun: false, ...extra });
const closure = 'closed done:t1 "agent:housekeeping-done": worker finished and its result is recorded (worker-done)';

test('housekeeping accepts either its direct closure or auto-tidy for the eligible worker', () => {
  assertHousekeepingActions(log({ action: 'closed', tab_id: 'done:t1' }), expected);
  assertHousekeepingActions(log(tidy(closure + '\ntidy-tabs: closed 1 of 1 finished tab(s) for project')), expected);
});

test('housekeeping rejects unrelated closures, dry runs and failed tidy output', () => {
  for (const entry of [
    { action: 'closed', tab_id: 'other:t1' },
    { action: 'closed', tab_id: 'done:t1', dryRun: true },
    tidy(closure.replace('done:t1', 'done:t10')),
    tidy(closure, { dryRun: true }),
    tidy('would close done:t1 "agent:done"'),
    tidy('tidy-tabs: closed 1 of 1 finished tab(s) for project'),
    { action: 'tidy-failed', output: closure },
  ]) assert.throws(() => assertHousekeepingActions(log(entry), expected), /must log closure/);
});

test('housekeeping rejects closure of any ineligible worker through either path', () => {
  for (const tab_id of expected.keptTabs) {
    for (const entry of [{ action: 'closed', tab_id }, tidy(`closed ${tab_id} "worker": finished`)]) {
      assert.throws(() => assertHousekeepingActions(log(tidy(closure), entry), expected), /must not close ineligible/);
    }
  }
});

test('housekeeping requires a keep action for every ineligible worker', () => {
  for (const missing of expected.keptTabs) {
    const text = [tidy(closure), ...kept.filter(entry => entry.tab_id !== missing)].map(JSON.stringify).join('\n');
    assert.throws(() => assertHousekeepingActions(text, expected), /must keep ineligible/);
  }
});
