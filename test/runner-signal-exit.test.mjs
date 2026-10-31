import test from './helpers/bounded-test.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnScenarioChild, waitForExit, childProcessEntry } from './helpers/child.mjs';
import { lookupProcess } from './helpers/processes.mjs';
import { until, producerOutcome } from './helpers/producer-wait.mjs';

const runner = fileURLToPath(new URL('./helpers/run.mjs', import.meta.url));

function fixture(t, source) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'runner-signal-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'signal.test.mjs'), journal = path.join(root, 'timings.jsonl');
  const ready = path.join(root, 'ready');
  fs.writeFileSync(file, `import fs from 'node:fs';\n${source(ready)}`);
  const child = spawnScenarioChild(t, process.execPath, [runner, '--load-factor=1', file], {
    env: { ...process.env, MONITOR_TEST_TIMINGS_PATH: journal,
      MONITOR_TEST_FILE_TIMEOUT_MS: '0', MONITOR_TEST_CONCURRENCY: '1' },
  });
  async function result() {
    const output = await waitForExit(child);
    const completions = [...output.stderr.matchAll(/^FILE_TAP_COMPLETE: (.*)$/gm)].map(match => JSON.parse(match[1]));
    assert.equal(output.code, 1, output.stdout + output.stderr);
    assert.equal(output.signal, null, output.stderr);
    assert.equal(completions.length, 1, output.stderr);
    const completion = completions[0];
    assert.deepEqual(JSON.parse(fs.readFileSync(completion.completion_artifact, 'utf8')), completion);
    assert.equal(completion.exit_code, 1);
    assert.notEqual(completion.reason, 'reporter-error');
    const rows = fs.readFileSync(journal, 'utf8').trim().split('\n').map(JSON.parse);
    return { ...output, completion, rows };
  }
  return { child, ready, result };
}

test('repeated handled self-signals leave no pending observer timer', async t => {
  const f = fixture(t, () => `
    for (const signal of ['SIGTERM', 'SIGINT']) {
      let count = 0;
      process.on(signal, function handler() { count++; });
      for (let i = 0; i < 2; i++) {
        const delivered = new Promise(resolve => process.once(signal, resolve));
        process.kill(process.pid, signal);
        await delivered;
      }
      if (count !== 2) throw Error('signal handler did not observe both requests');
    }
    fs.writeSync(2, 'handled twice per signal');
  `);
  const result = await f.result();
  assert.equal(result.completion.native_exit.signal, null);
  assert.equal(result.completion.native_exit.exit_code, 1);
  assert.equal(fs.readFileSync(result.completion.stderr_artifact, 'utf8'), 'handled twice per signal');
  assert.doesNotMatch(result.stderr, /Self-signal .* was not observed/);
  const finishes = result.rows.filter(row => row.kind === 'file' && row.event === 'finish');
  assert.equal(finishes.length, 1);
  assert.equal(finishes[0].exit_code, 1);
  assert.equal(finishes[0].reason, undefined, 'the existing exit-hook finish must not be duplicated');
});

test('native SIGINT exit receives one timing finish before its completion', async t => {
  const f = fixture(t, () => "process.kill(process.pid, 'SIGINT');");
  const result = await f.result();
  assert.equal(result.completion.native_exit.signal, 'SIGINT');
  assert.equal(result.completion.failure.signal, 'SIGINT');
  const starts = result.rows.filter(row => row.kind === 'file' && row.event === 'start');
  const finishes = result.rows.filter(row => row.kind === 'file' && row.event === 'finish');
  assert.equal(starts.length, 1);
  assert.equal(finishes.length, 1);
  assert.equal(finishes[0].id, starts[0].id);
  assert.equal(finishes[0].exit_code, 1);
  assert.equal(finishes[0].reason, 'native-exit');
  assert.equal(finishes[0].native_exit.pid, starts[0].pid);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  test(`single-file ${signal} cancellation retains native teardown without a reporter error`, async t => {
    const f = fixture(t, ready => `
      fs.writeFileSync(${JSON.stringify(ready)}, String(process.pid));
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
    `);
    await until(() => fs.existsSync(f.ready), {
      signal: t.signal, description: 'blocked admitted file',
      producer: () => producerOutcome([childProcessEntry(f.child)], lookupProcess),
    });
    const pid = Number(fs.readFileSync(f.ready, 'utf8'));
    assert.equal(f.child.kill(signal), true);
    const result = await f.result();
    assert.equal(result.completion.reason, 'worker-exit');
    assert.equal(result.completion.signal, 'SIGKILL');
    assert.equal(result.completion.group_teardown_confirmed, true);
    assert.equal(result.completion.tap_complete, false);
    assert.doesNotMatch(result.stderr, /File process exit was not observed/);
    const current = lookupProcess(pid);
    assert.equal(current.ok, true, current.error);
    assert.ok(!current.value || /^Z/.test(current.value.state), 'blocked file survived cancellation');
  });
}
