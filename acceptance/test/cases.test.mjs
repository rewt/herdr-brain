import test from '../../test/helpers/bounded-test.mjs';
import assert from 'node:assert/strict';
import { cases, runCase } from '../cases.mjs';
import { HarnessLimit, Pending, ProductBoundary, classifyFailure, requireSuccessfulChecks } from '../limits.mjs';
import { gateOutcome, resultLine } from '../results.mjs';

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
