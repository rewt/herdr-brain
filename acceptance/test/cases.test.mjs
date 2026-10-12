import test from '../../test/helpers/bounded-test.mjs';
import assert from 'node:assert/strict';
import { cases, cutoverChecks, runCase } from '../cases.mjs';
import { HarnessLimit, Pending, ProductBoundary, classifyFailure, requireSuccessfulChecks } from '../limits.mjs';
import { gateOutcome, resultLine } from '../results.mjs';

// Exercise the production catalog and executor, including the newly merged queue.
const order = Object.values(cases).filter((definition) => definition !== cases.tools);
async function execute(definitions, faults = {}, options = {}) {
  const results = [], executed = [];
  for (const definition of definitions) {
    await runCase(results, definition, () => {
      executed.push(definition.key);
      if (faults[definition.key]) throw faults[definition.key];
      return 'executed';
    }, options);
  }
  return { results, executed };
}
const outcomes = (results) => results.filter((v) => !v.key.startsWith('inserted-')).map(({ key, status, origin, detail }) => ({ key, status, origin, detail }));

test('inserting a case anywhere leaves every production dependency and outcome unchanged', async () => {
  assert.ok(order.indexOf(cases.queue) < order.indexOf(cases.release));
  assert.ok(order.indexOf(cases.release) < order.indexOf(cases.copy));
  assert.ok(order.indexOf(cases.path) < order.indexOf(cases.switches));
  const scenarios = [
    { [cases.release.key]: new Pending('scratch release unavailable') },
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

test('an unrelated pending case never gates cutover, omitted copy stays pending, and failed switches prevent retirement', async () => {
  const release = await execute(order, { [cases.release.key]: new Pending('scratch release unavailable') });
  for (const definition of [cases.copy, cases.switches, cases.retirement]) assert.ok(release.executed.includes(definition.key));
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

test('no configured existing project skips all five compatibility bodies visibly and permits a green gate', async () => {
  const { results, executed } = await execute(order, {}, { existingProjectConfigured: false });
  const skipped = results.filter(v => v.status === 'SKIP');
  assert.deepEqual(skipped.map(v => v.key), [cases.copy, cases.wrappers, cases.path, cases.switches, cases.retirement].map(v => v.key));
  for (const result of skipped) {
    assert.ok(!executed.includes(result.key)); assert.equal(result.origin, 'optional');
    assert.match(result.detail, /No existing project configured/);
    assert.match(resultLine(result), /SKIP.*No existing project configured.*--bch-cloak/);
  }
  assert.deepEqual(gateOutcome(results), { counts: { PASS: order.length - 5, FAIL: 0, PENDING: 0, SKIP: 5 }, ready: true });
});

test('optional compatibility never hides other failures or pending live cases', async () => {
  for (const fault of [new Error('product failed'), new HarnessLimit('live fixture unavailable'), new Pending('live checks explicitly skipped')]) {
    const { results } = await execute(order, { [cases.fixture.key]: fault }, { existingProjectConfigured: false });
    assert.equal(results.filter(v => v.status === 'SKIP').length, 5, 'skip precedes unavailable fixture prerequisites');
    assert.equal(gateOutcome(results).ready, false);
    assert.ok(results.find(v => v.key === cases.fixture.key).detail.includes(fault.message));
  }
});

test('configured compatibility retains strict failures and prerequisites', async () => {
  const complete = await execute(order, {}, { existingProjectConfigured: true });
  assert.equal(complete.results.filter(v => v.status === 'SKIP').length, 0);
  assert.ok(complete.executed.includes(cases.retirement.key));
  for (const [key, fault] of [[cases.copy.key, new Error('configured checkout missing')], [cases.switches.key, new Error('switch failure')], [cases.fixture.key, new HarnessLimit('live fixture unavailable')]]) {
    const { results } = await execute(order, { [key]: fault }, { existingProjectConfigured: true });
    assert.equal(results.filter(v => v.status === 'SKIP').length, 0);
    assert.equal(gateOutcome(results).ready, false);
    assert.ok(results.find(v => v.key === cases.retirement.key).detail.includes(fault.message));
  }
});
