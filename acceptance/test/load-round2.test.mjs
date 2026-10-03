import test from '../../test/helpers/bounded-test.mjs';
import assert from 'node:assert/strict';
import { loadTimeout } from '../../lib/deadline.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createLoadMonitor, waitUntil, LoadTimeout } from '../load.mjs';
import { commandFailure, classifyFailure, withCommandContext, requireSuccessfulChecks } from '../limits.mjs';
import { cases, cutoverChecks, runCase } from '../cases.mjs';
import { settleCase } from '../settle.mjs';
import { supervisorCase } from '../supervisor.mjs';
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

for (const heavy of [true, false]) {
  test(`retry context and cutover aggregate preserve ${heavy ? 'heavy-load PENDING' : 'normal-load FAIL'}`, async (t) => {
    const load = monitor(t, heavy), window = load.begin();
    const original = new LoadTimeout('timeout: same-request child', load.snapshot(window));
    assert.throws(() => withCommandContext('busy refusal passed; same-request retry failed', () => { throw original; }),
      (error) => error === original && error.load === original.load && /retry failed/.test(error.message));
    const checks = [];
    await runCase(checks, cutoverChecks.retry, () => withCommandContext('busy refusal passed; same-request retry failed', () => { throw original; }));
    const results = [{ ...cases.copy, status: 'PASS' }];
    await runCase(results, cases.switches, () => requireSuccessfulChecks(checks));
    await runCase(results, cases.retirement, () => assert.fail('retirement executed'));
    for (const result of [...checks, ...results.slice(1)]) {
      assert.equal(result.status, heavy ? 'PENDING' : 'FAIL');
      assert.equal(result.origin, heavy ? 'harness' : 'product');
      assert.match(result.detail, /same-request retry failed/);
      if (heavy) assert.match(result.detail, /28\.00\/25\.00\/22\.00/);
    }
  });
}

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
      const until = (fn, label, ms) => label === spec.label
        ? waitUntil(() => false, label, 100, { load }) // Script a lost receipt.
        : waitUntil(fn, label, ms, { load });
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
      if (label === 'finite queue completed') await waitUntil(() => false, label, 100, { load });
    };
    const results = [];
    await runCase(results, cases.supervisor, () => supervisorCase(candidate, { load, until }));
    assert.equal(results[0].status, heavy ? 'PENDING' : 'FAIL');
    assert.equal(results[0].origin, heavy ? 'harness' : 'product');
    assert.match(results[0].detail, /timeout: finite queue completed/);
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
