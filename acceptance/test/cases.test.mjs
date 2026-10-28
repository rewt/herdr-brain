import test from '../../test/helpers/bounded-test.mjs';
import assert from 'node:assert/strict';
import { cases, runCase, selectCases } from '../cases.mjs';
import { HarnessLimit, Pending, ProductBoundary, classifyFailure, requireSuccessfulChecks } from '../limits.mjs';
import { gateOutcome, resultLine } from '../results.mjs';

test('focused acceptance selects only requested cases plus prerequisites and mandatory controls', () => {
  assert.equal(selectCases(undefined), undefined);
  const scope = selectCases('configured-cycle,default-cycle');
  assert.deepEqual(scope.requested, ['configured-cycle', 'default-cycle']);
  assert.deepEqual(new Set(scope.selected), new Set(['configured-cycle', 'default-cycle', 'herdr-fixture',
    'required-tools', 'candidate-snapshot', 'scope-cleanup', 'operator-focus']));
  assert.ok(scope.unrun.includes('scratch-release'));
  assert.ok(scope.unrun.includes('promotion-queue'));
  for (const value of ['', 'typo', 'configured-cycle,']) assert.throws(() => selectCases(value), /unknown acceptance case/);
});

test('retained dependencies propagate a failed fixture without running dependent bodies', async () => {
  const results = [];
  await runCase(results, cases.fixture, () => { throw new HarnessLimit('no terminal'); });
  await runCase(results, cases.cycle, () => assert.fail('dependent body ran'));
  assert.equal(results[1].status, 'PENDING');
  assert.match(results[1].detail, /no terminal/);
  await assert.rejects(runCase(results, cases.fixture, () => {}), /duplicate case key/);
});

test('inserting an independent case preserves every retained outcome and prerequisite', async () => {
  const order = Object.values(cases);
  const execute = async definitions => {
    const results = [];
    for (const definition of definitions) await runCase(results, definition, () => {
      if (definition === cases.fixture) throw new HarnessLimit('no terminal');
      return 'executed';
    });
    return results.filter(r => r.key !== 'inserted').map(({ key, status, detail }) => ({ key, status, detail }));
  };
  const expected = await execute(order);
  for (let i = 0; i <= order.length; i++) {
    assert.deepEqual(await execute([...order.slice(0, i), { key: 'inserted', name: 'Extra', prerequisites: [] }, ...order.slice(i)]), expected);
  }
});
