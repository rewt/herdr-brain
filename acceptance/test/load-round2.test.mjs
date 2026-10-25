import test from '../../test/helpers/bounded-test.mjs';
import assert from 'node:assert/strict';
import { loadTimeout } from '../../lib/deadline.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createLoadMonitor, waitUntil, LoadTimeout } from '../load.mjs';
import { commandFailure, classifyFailure, requireSuccessfulChecks } from '../limits.mjs';
import { cases, runCase } from '../cases.mjs';
import { settleCase } from '../settle.mjs';
import { supervisorCase, waitForPromotionQueue } from '../supervisor.mjs';
import { loadAwareCommand } from '../commands.mjs';

const candidate = path.resolve('.');
function monitor(t, heavy = true) {
  const previous = process.env.ORG_ACTOR;
  process.env.ORG_ACTOR = `eng103-r127-${t.name}`;
  t.after(() => previous === undefined ? delete process.env.ORG_ACTOR : process.env.ORG_ACTOR = previous);
  const load = createLoadMonitor({ cpus: 2, read: () => heavy ? [28, 25, 22] : [1, 1, 1] });
  t.after(load.stop);
  return load;
}

function queueClock(t, { loadValue = 0, completeAt = Infinity, outcome = 'promoted' } = {}) {
  let at = 0, reads = 0;
  const load = createLoadMonitor({ cpus: 18, read: () => [loadValue, 0, 0], now: () => at });
  t.after(load.stop);
  // An injected queue read exposes command completion without launching a
  // process; host load and real sleeps cannot control these witnesses.
  const queue = () => { reads++; return { results: at >= completeAt ? [{ outcome }] : [] }; };
  const until = (fn, label, ms) => waitUntil(fn, label, ms, {
    load, now: () => at, sleep: async ms => { at += ms; },
  });
  return { wait: () => waitForPromotionQueue(queue, until), load,
    now: () => at, reads: () => reads, setLoad: value => { loadValue = value; } };
}

test('supervisor queue allows measured compound cleanup beyond ten seconds at normal load', async t => {
  const clock = queueClock(t, { completeAt: 12_000 });
  await clock.wait();
  assert.equal(clock.now(), 12_000);
  assert.equal(clock.reads(), 81);
});

test('supervisor queue accepts actual completion beyond its former elapsed limit', async t => {
  const clock = queueClock(t, { completeAt: 3_600_000 });
  await clock.wait();
  assert.equal(clock.now(), 3_600_000);
});

test('supervisor queue scales once using current load and preserves a completed refusal for the case assertion', async t => {
  const clock = queueClock(t, { loadValue: 24, completeAt: 70_050, outcome: 'refused' });
  await clock.wait();
  assert.equal(clock.now(), 70_050, 'the shared factor of six permits a completion beyond 16 s');
  // This wait observes completion only; supervisorCase still asserts promoted.
  const later = queueClock(t, { loadValue: 24, completeAt: 3_600_000 });
  const pending = later.wait();
  later.setLoad(240);
  await pending;
  assert.equal(later.now(), 3_600_000, 'load and an old planning allowance do not reject actual completion');
});

test('a successful TAP test named ETIMEDOUT cannot hide an unrelated assertion failure', (t) => {
  const load = monitor(t), root = fs.mkdtempSync(path.join(os.tmpdir(), 'eng103-mixed-tap-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const script = path.join(root, 'mixed.test.mjs');
  fs.writeFileSync(script, "import test from 'node:test';import assert from 'node:assert/strict';test('handles ETIMEDOUT',()=>{});test('independent product behaviour',()=>assert.equal(1,2));");
  const window = load.begin();
  const env = { ...process.env }; delete env.NODE_TEST_CONTEXT;
  const child = spawnSync(process.execPath, ['--test', script], { env, encoding: 'utf8', timeout: loadTimeout(10000) });
  assert.equal(child.status, 1); assert.equal(child.error, undefined);
  assert.match(child.stdout, /ok 1 - handles ETIMEDOUT/);
  assert.match(child.stdout, /not ok 2 - independent product behaviour/);
  const error = commandFailure(child.stdout + child.stderr, { error: child.error, load: load.snapshot(window) });
  assert.equal(classifyFailure(error).status, 'FAIL');
  assert.equal(classifyFailure(error).origin, 'product');
  const timedOutAfterAssertion = commandFailure(child.stdout + child.stderr,
    { error: { code: 'ETIMEDOUT' }, load: load.snapshot(window) });
  assert.equal(classifyFailure(timedOutAfterAssertion).status, 'FAIL', 'independent failed assertion precedes a later process deadline');
  const command = loadAwareCommand(() => ({ ...child, error: { code: 'ETIMEDOUT', message: 'process deadline' } }), load);
  assert.throws(() => command(process.execPath, [script], {}),
    (failure) => classifyFailure(failure).status === 'FAIL' && /independent product behaviour/.test(failure.message),
    'the measured command helper retains output even when the process API reports a timeout');
  const successName = commandFailure('ok 1 - handles ERR_ASSERTION and ETIMEDOUT\n',
    { error: { code: 'ETIMEDOUT' }, load: load.snapshot(window) });
  assert.equal(classifyFailure(successName).status, 'PENDING', 'a successful name is never an assertion diagnostic');
});

const delegated = [
  { name: 'settle', definition: cases.settle, run: settleCase, command: path.join(candidate, 'settle/settle.mjs'), label: 'watch delivered the fix report' },
  { name: 'supervisor', definition: cases.supervisor, run: supervisorCase, command: path.join(candidate, 'watch/watch.mjs'), label: 'actual watch delivered correction notice' },
];
for (const spec of delegated) {
  for (const heavy of [true, false]) {
    test(`${spec.name} bounded child timeout is ${heavy ? 'PENDING' : 'FAIL'} with its operation samples`, async (t) => {
      const load = monitor(t, heavy), roots = new Set();
      const execute = (file, args, options) => {
        roots.add(path.dirname(options.cwd));
        if (args[0] !== spec.command) return spawnSync(file, args, options);
        return spawnSync(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { ...options, timeout: 100 });
      };
      const results = [];
      await runCase(results, spec.definition, () => spec.run(candidate, { load, execute }));
      assert.equal(results[0].status, heavy ? 'PENDING' : 'FAIL');
      assert.equal(results[0].origin, heavy ? 'harness' : 'product');
      assert.match(results[0].detail, /ETIMEDOUT/);
      if (heavy) assert.match(results[0].detail, /measured heavy load: 28/);
      for (const root of roots) assert.ok(!fs.existsSync(root), `cleanup awaited for ${root}`);
    });

    test(`${spec.name} report deadline is ${heavy ? 'PENDING' : 'FAIL'} with its own wait samples`, async (t) => {
      const load = monitor(t, heavy);
      const until = (fn, label, ms) => {
        if (label === spec.label) throw new LoadTimeout(`timeout: ${label}`, load.snapshot());
        return waitUntil(fn, label, ms, { load });
      }; // Explicit external-failure control, never a productive elapsed stop.
      const results = [];
      await runCase(results, spec.definition, () => spec.run(candidate, { load, until }));
      assert.equal(results[0].status, heavy ? 'PENDING' : 'FAIL');
      assert.equal(results[0].origin, heavy ? 'harness' : 'product');
      assert.ok(results[0].detail.includes(`timeout: ${spec.label}`), results[0].detail);
    });
  }

  test(`${spec.name} independent child assertion failure stays FAIL under heavy load`, async (t) => {
    const load = monitor(t);
    const execute = (file, args, options) => args[0] === spec.command
      ? { status: 1, stdout: 'ok 1 - handles ETIMEDOUT\nnot ok 2 - unrelated assertion\n', stderr: 'independent assertion failed' }
      : spawnSync(file, args, options);
    const results = [];
    await runCase(results, spec.definition, () => spec.run(candidate, { load, execute }));
    assert.equal(results[0].status, 'FAIL'); assert.equal(results[0].origin, 'product');
    assert.doesNotMatch(results[0].detail, /measured heavy load/);
  });
}

for (const heavy of [true, false]) {
  test(`supervisor queue deadline is ${heavy ? 'PENDING' : 'FAIL'} with queue-operation samples`, async (t) => {
    const load = monitor(t, heavy);
    const until = async (fn, label, ms) => {
      // Drain the actual scratch queue before scripting a lost completion
      // observation, so the failure leaves no detached queue worker behind.
      await waitUntil(fn, label, ms, { load });
      if (label === 'queue integration and joined closeout completed') throw new LoadTimeout(`timeout: ${label}`, load.snapshot());
    };
    const results = [];
    await runCase(results, cases.supervisor, () => supervisorCase(candidate, { load, until }));
    assert.equal(results[0].status, heavy ? 'PENDING' : 'FAIL');
    assert.equal(results[0].origin, heavy ? 'harness' : 'product');
    assert.match(results[0].detail, /timeout: queue integration and joined closeout completed/);
  });
}

test('delegated fixture setup timeout also cleans its owned root before returning', async (t) => {
  const load = monitor(t); let root;
  const execute = (file, args, options) => {
    root = path.dirname(options.cwd);
    return spawnSync(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { ...options, timeout: 100 });
  };
  const results = [];
  await runCase(results, cases.settle, () => settleCase(candidate, { load, execute }));
  assert.equal(results[0].status, 'PENDING'); assert.ok(!fs.existsSync(root));
});
