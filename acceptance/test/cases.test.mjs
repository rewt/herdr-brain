import test from '../../test/helpers/bounded-test.mjs';
import assert from 'node:assert/strict';
import { cases, cutoverChecks, runCase } from '../cases.mjs';
import { HarnessLimit, Pending, ProductBoundary, classifyFailure, requireSuccessfulChecks } from '../limits.mjs';

// Exercise the production catalog and executor, including the newly merged queue.
const order = Object.values(cases).filter((definition) => definition !== cases.tools);
async function execute(definitions, faults = {}) {
  const results = [], executed = [];
  for (const definition of definitions) {
    await runCase(results, definition, () => {
      executed.push(definition.key);
      if (faults[definition.key]) throw faults[definition.key];
      return 'executed';
    });
  }
  return { results, executed };
}
const outcomes = (results) => results.filter((v) => !v.key.startsWith('inserted-')).map(({ key, status, origin, detail }) => ({ key, status, origin, detail }));

test('inserting a case anywhere leaves every production dependency and outcome unchanged', async () => {
  assert.ok(order.indexOf(cases.queue) < order.indexOf(cases.console));
  assert.ok(order.indexOf(cases.console) < order.indexOf(cases.copy));
  assert.ok(order.indexOf(cases.path) < order.indexOf(cases.switches));
  const scenarios = [
    { [cases.console.key]: new Pending('optional npm cache omitted') },
    { [cases.copy.key]: new Pending('optional existing-project copy omitted') },
    { [cases.switches.key]: new Error('switch canary is incorrect') },
    { [cases.fixture.key]: new HarnessLimit('native fixture unavailable') },
  ];
  for (const faults of scenarios) {
    const baseline = await execute(order, faults);
    for (let position = 0; position <= order.length; position++) {
      const inserted = { key: `inserted-${position}`, name: 'Unrelated inserted case', prerequisites: [] };
      const definitions = [...order.slice(0, position), inserted, ...order.slice(position)];
      const actual = await execute(definitions, faults);
      assert.deepEqual(outcomes(actual.results), outcomes(baseline.results));
      assert.deepEqual(actual.executed.filter((key) => key !== inserted.key), baseline.executed);
      for (const definition of order) {
        for (const key of definition.prerequisites) {
          const before = baseline.results.find((v) => v.key === key);
          const after = actual.results.find((v) => v.key === key);
          assert.ok(before && after, `unknown prerequisite ${key}`);
          assert.equal(after.status, before.status);
          assert.equal(after.detail, before.detail);
        }
      }
    }
  }
});

test('optional console never gates cutover, omitted copy stays pending, and failed switches prevent retirement', async () => {
  const cache = await execute(order, { [cases.console.key]: new Pending('no npm cache') });
  for (const definition of [cases.copy, cases.switches, cases.retirement]) assert.ok(cache.executed.includes(definition.key));
  const copy = await execute(order, { [cases.copy.key]: new Pending('no existing project') });
  for (const definition of [cases.wrappers, cases.path, cases.switches, cases.retirement]) {
    assert.ok(!copy.executed.includes(definition.key));
    const result = copy.results.find((v) => v.key === definition.key);
    assert.equal(result.status, 'PENDING'); assert.match(result.detail, /no existing project/);
  }
  const failed = await execute(order, { [cases.switches.key]: new Error('failed switch') });
  assert.equal(failed.results.find((v) => v.key === cases.path.key).status, 'PASS');
  assert.ok(!failed.executed.includes(cases.retirement.key));
  assert.equal(failed.results.find((v) => v.key === cases.retirement.key).status, 'FAIL');
});

test('a canary harness limit propagates through recovery, cleanup, aggregate and retirement without product failures', async () => {
  const checks = [], executed = [];
  const canaryError = new HarnessLimit('native transport/layout receipt unavailable');
  await runCase(checks, cutoverChecks.canary, () => { throw canaryError; });
  for (const definition of [cutoverChecks.recovery, cutoverChecks.cleanup]) {
    await runCase(checks, definition, () => executed.push(definition.key));
  }
  assert.deepEqual(executed, []);
  assert.ok(checks.every((v) => v.status === 'PENDING' && v.origin === 'harness' && v.detail.includes(canaryError.message)));
  const results = [{ ...cases.copy, id: '30', status: 'PASS' }];
  await runCase(results, cases.switches, () => requireSuccessfulChecks(checks));
  await runCase(results, cases.retirement, () => executed.push('retirement'));
  assert.deepEqual(executed, []);
  for (const result of results.slice(1)) {
    assert.equal(result.status, 'PENDING'); assert.equal(result.origin, 'harness');
    assert.ok(result.detail.includes(canaryError.message));
  }
});

test('independent product and explicit safety failures retain precedence over genuine canary limits', async () => {
  const checks = [];
  await runCase(checks, cutoverChecks.canary, () => { throw new HarnessLimit('native transport unavailable'); });
  await runCase(checks, cutoverChecks.notices, () => { throw new ProductBoundary('acceptance_product_boundary: foreign pane'); });
  let failure;
  try { requireSuccessfulChecks(checks); } catch (error) { failure = error; }
  assert.deepEqual(classifyFailure(failure), { status: 'FAIL', origin: 'product', detail: failure.message });
  assert.match(failure.message, /foreign pane/);
  const propagated = [];
  await runCase(propagated, cutoverChecks.canary, () => { throw new Error('incorrect candidate delivery'); });
  await runCase(propagated, cutoverChecks.recovery, () => assert.fail('dependent body ran'));
  assert.ok(propagated.every((v) => v.status === 'FAIL' && v.detail.includes('incorrect candidate delivery')));
});

test('case keys are required and unique even when display names differ', async () => {
  const results = [];
  await runCase(results, cases.copy, () => {}); // Missing prerequisite yields a visible harness limit.
  await assert.rejects(runCase(results, { ...cases.copy, name: 'Another name' }, () => {}), /duplicate case key/);
  await assert.rejects(runCase([], { name: 'No key' }, () => {}), /stable key/);
});
