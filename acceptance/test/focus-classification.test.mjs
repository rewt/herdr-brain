import test from '../../test/helpers/bounded-test.mjs';
import assert from 'node:assert/strict';
import { ATTRIBUTION_WINDOW_MS, OPERATOR_ACTIVITY_WINDOW_MS, focusCallContext, recordFocusChange } from '../focus-classification.mjs';
import { assertFocus } from '../focus.mjs';
import { cases, runCase } from '../cases.mjs';
import { gateOutcome, resultLine } from '../results.mjs';

function replay(moves, calls = [], { baseline = 'operator:p7', owned = ['scratch'] } = {}) {
  const summary = { baseline, currentBaseline: baseline, samples: 2, elapsedMs: 0,
    errors: [], changes: [], externalChanges: [], notAttributableChanges: [] };
  const rows = [];
  let previousPane = baseline;
  for (const [at, pane, type = 'event'] of moves) {
    const workspace = pane.split(':')[0];
    const row = { at, type, panes: [pane], workspaces: [workspace], phase: { key: 'synthetic' },
      from: summary.currentBaseline, previousPane, previousOwnership: owned.includes(previousPane.split(':')[0]) ? 'harness' : 'operator',
      owned: owned.includes(workspace), ...focusCallContext(calls, at) };
    if (pane !== summary.currentBaseline) recordFocusChange(summary, row);
    previousPane = pane;
    rows.push(row);
  }
  return { summary, rows };
}

function completedCall(args, { at = 2000, origin = 'product', created, targets } = {}) {
  return [{ type: 'start', id: `${origin}-call`, at: at - 100, args, requested: args, origin, targets },
    { type: 'end', id: `${origin}-call`, at, created }];
}

test('the exact October 19 operator sequence retains unknown harness visits as warnings and keeps the gate ready', async () => {
  const calls = [
    ...completedCall(['pane', 'send-keys', 'w3KX:p2', 'Enter'], { at: 1792438823913 }),
    ...completedCall(['pane', 'report-agent', 'w3KX:p2'], { at: 1792438825062, origin: 'harness' }),
  ];
  const { summary, rows } = replay([
    [1792438787559, 'w3KV:p1'],
    [1792438842325, 'w3KX:p1'],
    [1792438842525, 'w3KX:p1', 'sample'],
    [1792438842832, 'w3KX:p1', 'sample'],
    [1792438843136, 'w3KX:p1', 'sample'],
    [1792438843443, 'w3KX:p1', 'sample'],
    [1792438843750, 'w3KX:p2'],
    ...[1792438843772, 1792438844052, 1792438844359, 1792438844665,
      1792438844971, 1792438845275, 1792438845581, 1792438845886,
      1792438846192, 1792438846499].map(at => [at, 'w3KX:p2', 'sample']),
    [1792438846658, 'w2XS:p2'],
    [1792439154047, 'w3KV:p1'],
    [1792439271821, 'w2XS:p2'],
    [1792439409491, 'w3KV:p1', 'sample'],
    [1792439422226, 'w3KV:p2'],
    [1792439425932, 'w3KV:p1'],
    [1792439432724, 'w2XS:p2'],
  ], calls, { baseline: 'w2XS:p2', owned: ['w3KX'] });
  assert.equal(summary.changes.length, 0);
  assert.equal(summary.externalChanges.length, 8);
  assert.equal(summary.notAttributableChanges.length, 2, 'unchanged samples do not repeat or prolong a warning');
  const first = summary.notAttributableChanges[0];
  assert.equal(first.classification, 'not-attributable');
  assert.equal(first.previousPane, 'w3KV:p1');
  assert.equal(first.previousOwnership, 'operator');
  assert.deepEqual(first.calls, []);
  assert.equal(first.nearestCalls.product.completedAt, 1792438823913);
  assert.equal(first.operatorActivity.at, 1792438787559);
  assert.equal(first.operatorActivity.ageMs, 54_766);
  assert.equal(first.operatorActivity.windowMs, 60_000);
  assert.equal(summary.notAttributableChanges[1].operatorActivity.at, first.operatorActivity.at);
  assert.equal(rows.length, 24, 'events and all held-focus samples remain in the trace');
  assert.equal(summary.currentBaseline, 'w2XS:p2');
  const results = [];
  await runCase(results, cases.focus, () => assertFocus(summary));
  assert.equal(results[0].status, 'PASS');
  assert.equal(gateOutcome(results).ready, true);
  assert.match(resultLine(results[0]), /PASS.*WARNING: 2 NOT-ATTRIBUTABLE.*source unknown/);
});

test('create, split and send focus steals to new or sibling owned panes fail immediately and after a multi-second delay', () => {
  const operations = [
    { args: ['workspace', 'create', '--no-focus'], created: { workspaces: ['scratch'] }, destination: 'scratch:p2' },
    { args: ['pane', 'split', 'scratch:p2'], destination: 'scratch:p3' },
    { args: ['pane', 'send-keys', 'scratch:p2', 'Enter'], destination: 'scratch:p3' },
  ];
  for (const origin of ['product', 'harness']) for (const operation of operations) for (const delay of [0, 750, 3000, ATTRIBUTION_WINDOW_MS]) {
    const { summary } = replay([[1000, 'external:p1'], [2000 + delay, operation.destination]],
      completedCall(operation.args, { ...operation, origin }));
    assert.equal(summary.changes.length, 1, `${origin} ${operation.args.join(' ')} after ${delay}ms`);
    assert.equal(summary.changes[0].classification, 'harness');
    assert.equal(summary.changes[0].panes[0], operation.destination);
    assert.equal(summary.changes[0].calls[0].origin, origin);
    assert.equal(summary.changes[0].calls[0].completedAt, 2000);
    assert.equal(summary.notAttributableChanges.length, 0);
    assert.throws(() => assertFocus(summary), /operator focus changed/);
  }
});

test('harness calls and overlapping product calls also take precedence over operator activity', () => {
  for (const origin of ['product', 'harness']) {
    const calls = completedCall(['pane', 'run', 'scratch:p2', 'worker'], { origin }).slice(0, 1);
    const { summary } = replay([[1000, 'external:p1'], [9000, 'scratch:p3']], calls);
    assert.equal(summary.changes.length, 1);
    assert.equal(summary.changes[0].classification, 'harness');
    assert.equal(summary.changes[0].calls[0].origin, origin);
    assert.equal(summary.notAttributableChanges.length, 0);
    assert.throws(() => assertFocus(summary), /operator focus changed/);
  }
});

test('pane option, resolved agent and creation receipts attribute sibling owned panes', () => {
  const operations = [
    { args: ['pane', 'split', '--pane', 'scratch:p2'] },
    { args: ['agent', 'send-keys', 'worker', 'Enter'], targets: { panes: ['scratch:p2'] } },
    { args: ['tab', 'create'], created: { panes: ['scratch:p2'] } },
  ];
  for (const operation of operations) {
    const { summary } = replay([[1000, 'external:p1'], [5000, 'scratch:p3']], completedCall(operation.args, operation));
    assert.equal(summary.changes.length, 1);
    assert.equal(summary.changes[0].classification, 'harness');
    assert.equal(summary.notAttributableChanges.length, 0);
    assert.throws(() => assertFocus(summary), /operator focus changed/);
  }
});

test('a known owned pane without a workspace field still uses its native workspace prefix for attribution', () => {
  const { summary } = replay([[1000, 'external:p1']]);
  const row = { at: 5000, panes: ['scratch:p3'], workspaces: [], owned: true,
    from: 'external:p1', previousPane: 'external:p1', previousOwnership: 'operator',
    ...focusCallContext(completedCall(['pane', 'send-keys', 'scratch:p2', 'Enter']), 5000) };
  recordFocusChange(summary, row);
  assert.equal(row.classification, 'harness');
  assert.equal(summary.notAttributableChanges.length, 0);
  assert.throws(() => assertFocus(summary), /operator focus changed/);
});

test('same-workspace attribution stays limited to owned destinations and the existing call window', () => {
  const scenarios = [
    { args: ['pane', 'send-keys', 'foreign:p2', 'Enter'], destination: 'foreign:p3', at: 5000, classification: 'external' },
    { args: ['pane', 'send-keys', 'scratch-other:p2', 'Enter'], destination: 'scratch:p3', at: 5000, classification: 'not-attributable' },
    { args: ['pane', 'send-keys', 'other:p2', 'scratch:p2'], destination: 'scratch:p3', at: 5000, classification: 'not-attributable' },
    { args: ['pane', 'run', 'other:p2', '--', '--pane', 'scratch:p2'], destination: 'scratch:p3', at: 5000, classification: 'not-attributable' },
    { args: ['agent', 'send-keys', 'scratch:worker', 'Enter'], destination: 'scratch:p3', at: 5000, classification: 'not-attributable' },
    { args: ['pane', 'split', 'scratch:p2'], destination: 'scratch:p3', at: 2000 + ATTRIBUTION_WINDOW_MS + 1, classification: 'not-attributable' },
  ];
  for (const scenario of scenarios) {
    const { summary, rows } = replay([[1000, 'external:p1'], [scenario.at, scenario.destination]], completedCall(scenario.args));
    assert.equal(rows.at(-1).classification, scenario.classification, scenario.args.join(' '));
    assert.equal(summary.changes.length, 0);
    assert.doesNotThrow(() => assertFocus(summary));
  }
});

test('unattributed harness moves with no preceding operator activity still fail', () => {
  const { summary } = replay([[100_000, 'scratch:p2']]);
  assert.equal(summary.notAttributableChanges.length, 0);
  assert.equal(summary.changes.length, 1);
  assert.throws(() => assertFocus(summary), /harness-owned destination/);
});

test('a delayed steal outside call attribution still fails without operator activity', () => {
  const { summary } = replay([[20_000, 'scratch:p2']], completedCall(['pane', 'send-keys', 'scratch:p2', 'Enter']));
  assert.equal(summary.changes.length, 1);
  assert.deepEqual(summary.changes[0].calls, []);
  assert.equal(summary.changes[0].nearestCalls.product.completedAt, 2000);
  assert.throws(() => assertFocus(summary), /operator focus changed/);
});

test('a correlated move outside harness ownership cannot establish operator activity', () => {
  const calls = completedCall(['pane', 'send-keys', 'external:p1', 'Enter']);
  const { summary } = replay([[2000, 'external:p1'], [8000, 'scratch:p2']], calls);
  assert.equal(summary.changes.length, 2);
  assert.equal(summary.operatorActivity, undefined);
  assert.equal(summary.notAttributableChanges.length, 0);
});

test('operator pane navigation alone passes without warnings', () => {
  const { summary } = replay([[1000, 'external:p1'], [5000, 'external:p2'], [80_000, 'operator:p7']]);
  assert.equal(summary.changes.length, 0);
  assert.equal(summary.notAttributableChanges.length, 0);
  assert.equal(summary.externalChanges.length, 3);
  assert.doesNotMatch(assertFocus(summary), /WARNING/);
});

test('operator activity expires at a fixed bound and harness navigation cannot renew it', () => {
  const start = 1000, expiry = start + OPERATOR_ACTIVITY_WINDOW_MS;
  const { summary } = replay([[start, 'external:p1'], [expiry, 'scratch:p1'],
    [expiry, 'scratch:p1', 'sample'], [expiry + 1, 'scratch:p2']]);
  assert.equal(summary.notAttributableChanges.length, 1);
  assert.equal(summary.notAttributableChanges[0].operatorActivity.ageMs, OPERATOR_ACTIVITY_WINDOW_MS);
  assert.equal(summary.changes.length, 1);
  assert.equal(summary.changes[0].panes[0], 'scratch:p2');
  assert.equal(summary.operatorActivity.at, start);
  assert.throws(() => assertFocus(summary), /operator focus changed/);
});

test('a return from the harness and later operator activity cannot excuse an unexplained steal', () => {
  const { summary } = replay([[1000, 'scratch:p1'], [2000, 'external:p1'],
    [3000, 'scratch:p2'], [4000, 'external:p1'], [5000, 'operator:p7']]);
  assert.equal(summary.changes.length, 2);
  assert.equal(summary.notAttributableChanges.length, 0);
  assert.equal(summary.operatorActivity.at, 5000);
  assert.throws(() => assertFocus(summary), /operator focus changed/);
});

test('warnings preserve forbidden-attempt and incomplete-monitor failures', () => {
  const { summary } = replay([[1000, 'external:p1'], [2000, 'scratch:p2']]);
  assert.match(assertFocus(summary), /WARNING: 1 NOT-ATTRIBUTABLE/);
  summary.errors.push('subscription disconnected');
  assert.throws(() => assertFocus(summary), /trace incomplete/);
  summary.forbiddenAttempts = [{ at: 3000, requested: ['pane', 'focus', 'scratch:p2'], error: 'forbidden' }];
  assert.throws(() => assertFocus(summary), /forbidden focus attempt/);
});
