import test from '../../test/helpers/bounded-test.mjs';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createLoadMonitor, waitUntil, LoadTimeout } from '../load.mjs';
import { classifyFailure, commandFailure, HarnessLimit, requireSuccessfulChecks } from '../limits.mjs';
import { cases, cutoverChecks, runCase } from '../cases.mjs';
import { resultLine } from '../results.mjs';

function fixture(t, averages = [28, 25, 22], cpus = 18) {
  const previous = process.env.ORG_ACTOR;
  process.env.ORG_ACTOR = `eng103-${t.name}`;
  t.after(() => previous === undefined ? delete process.env.ORG_ACTOR : process.env.ORG_ACTOR = previous);
  let at = 0, current = averages;
  const samples = [];
  const load = createLoadMonitor({ cpus, read: () => current, now: () => at, record: (v) => samples.push(v) });
  t.after(load.stop);
  return { load, samples, set: (value) => { current = value; },
    wait: (fn = () => false) => waitUntil(fn, 'held worker report', 300, {
      load, now: () => at, sleep: async (ms) => { at += ms; },
    }) };
}

test('measured heavy-load report timeout is harness pending and names load on the screen', async (t) => {
  const f = fixture(t);
  let error; try { await f.wait(); } catch (value) { error = value; }
  const result = { id: '19', name: 'Worker report', ...classifyFailure(error) };
  assert.equal(result.status, 'PENDING'); assert.equal(result.origin, 'harness');
  assert.match(resultLine(result), /HARNESS.*28\.00\/25\.00\/22\.00.*18 CPUs.*held worker report/);
  assert.ok(f.samples.length >= 4);
});

test('candidate that never reports at normal load remains product fail', async (t) => {
  const f = fixture(t, [2, 3, 4]);
  let error; try { await f.wait(); } catch (value) { error = value; }
  assert.deepEqual(classifyFailure(error), { status: 'FAIL', origin: 'product', detail: 'timeout: held worker report' });
});

test('heavy load is relative to capacity even on a single-CPU host', async (t) => {
  const f = fixture(t, [2, 2, 2], 1);
  let error; try { await f.wait(); } catch (value) { error = value; }
  assert.equal(classifyFailure(error).status, 'PENDING');
  assert.equal(error.load.peak.threshold, 1);
});

test('load is scoped to each wait and successful reports pass even under heavy load', async (t) => {
  const f = fixture(t);
  await f.wait(() => true);
  f.set([1, 1, 1]);
  let error; try { await f.wait(); } catch (value) { error = value; }
  assert.equal(classifyFailure(error).status, 'FAIL');
  assert.equal(f.load.snapshot().heavy, true, 'run evidence retains the earlier peak');
});

test('a wait retains measured contention even if load falls before its deadline', async (t) => {
  const f = fixture(t);
  let error; try { await f.wait(() => { f.set([1, 1, 1]); return false; }); } catch (value) { error = value; }
  assert.equal(classifyFailure(error).status, 'PENDING');
});

test('bounded child command and native focus timeouts name measured heavy load', (t) => {
  const f = fixture(t), measured = f.load.snapshot();
  for (const [message, error] of [['spawnSync ETIMEDOUT', { code: 'ETIMEDOUT' }]]) {
    const failure = commandFailure(message, { error, load: measured });
    assert.ok(failure instanceof LoadTimeout);
    assert.equal(classifyFailure(failure).status, 'PENDING');
    assert.equal(classifyFailure(commandFailure(message, { error, load: { ...measured, heavy: false } })).status, 'FAIL');
  }
  assert.equal(classifyFailure(commandFailure('Herdr request timed out: pane.current', { load: measured })).status, 'FAIL',
    'untyped ordinary child output cannot prove which operation failed');
  const result = classifyFailure(new HarnessLimit('operator focus trace incomplete: Herdr request timed out: pane.current'), { load: measured });
  assert.equal(result.status, 'PENDING'); assert.match(result.detail, /measured heavy load/);
});

test('actual stalled child timeout uses the measured command window', (t) => {
  const f = fixture(t), window = f.load.begin();
  const child = spawnSync(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    env: { ...process.env, ORG_ACTOR: 'eng103-stalled-child' }, timeout: 100, encoding: 'utf8',
  });
  assert.equal(child.error?.code, 'ETIMEDOUT');
  const error = commandFailure(child.error.message, { error: child.error, load: f.load.snapshot(window) });
  assert.equal(classifyFailure(error).status, 'PENDING');
});

test('heavy load cannot hide incorrect candidate behaviour or safety refusals', (t) => {
  const f = fixture(t), load = f.load.snapshot();
  for (const error of [new Error('incorrect report'), commandFailure('acceptance_product_boundary: timed out escaping scratch', { load }),
    new LoadTimeout('acceptance_boundary: unowned pane', load)]) {
    assert.equal(classifyFailure(error, { load }).status, 'FAIL');
  }
});

test('heavy-load canary timeout propagates through aggregate and retirement as harness pending', async (t) => {
  const f = fixture(t), checks = [];
  await runCase(checks, cutoverChecks.canary, () => f.wait());
  for (const definition of [cutoverChecks.recovery, cutoverChecks.cleanup]) {
    await runCase(checks, definition, () => assert.fail('dependent executed'));
  }
  const results = [{ ...cases.copy, status: 'PASS' }];
  await runCase(results, cases.switches, () => requireSuccessfulChecks(checks));
  await runCase(results, cases.retirement, () => assert.fail('retirement executed'));
  for (const result of [...checks, ...results.slice(1)]) {
    assert.equal(result.status, 'PENDING'); assert.equal(result.origin, 'harness');
    assert.match(result.detail, /28\.00\/25\.00\/22\.00/);
  }
});
