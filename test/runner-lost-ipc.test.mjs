import test from './helpers/bounded-test.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnScenarioChild, waitForExit } from './helpers/child.mjs';

const runner = fileURLToPath(new URL('./helpers/run.mjs', import.meta.url));
const readRows = file => fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line));

async function loseCompletion(t, source) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'runner-lost-ipc-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'case.test.mjs');
  const journal = path.join(root, 'timings.jsonl');
  const dropped = path.join(root, 'dropped.json');
  const preload = path.join(root, 'drop-completion.mjs');
  fs.writeFileSync(file, `import test from 'node:test';\n${source}`);
  // Inject transport loss only in the real worker. Admission and suite-complete
  // messages still use real IPC, so the unmodified coordinator must recover the
  // worker's durable completion during teardown rather than its IPC call site.
  fs.writeFileSync(preload, `import fs from 'node:fs';
    if (process.argv.includes('--worker')) {
      const send = process.send;
      process.send = function(message, ...args) {
        if (!message.fileTapComplete) return send.call(this, message, ...args);
        const completion = message.fileTapComplete;
        const durable = JSON.parse(fs.readFileSync(completion.completion_artifact, 'utf8'));
        const rows = fs.readFileSync(${JSON.stringify(journal)}, 'utf8').trim().split('\\n').map(JSON.parse);
        fs.writeFileSync(${JSON.stringify(dropped)}, JSON.stringify({ completion, durable, rows, worker_pid: process.pid }), { flag: 'wx' });
        const callback = args.at(-1);
        if (typeof callback === 'function') queueMicrotask(() => callback(null));
        return true;
      };
    }
  `);
  const child = spawnScenarioChild(t, process.execPath, [runner, '--load-factor=1', file], {
    env: { ...process.env, MONITOR_TEST_TIMINGS_PATH: journal,
      MONITOR_TEST_FILE_TIMEOUT_MS: '0', MONITOR_TEST_CONCURRENCY: '1',
      HERDR_MONITOR_FLEET: path.join(root, 'fleet.json'),
      NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --import=${pathToFileURL(preload).href}` },
  });
  const result = await waitForExit(child);
  assert.equal(result.signal, null, result.stderr);
  const lost = JSON.parse(fs.readFileSync(dropped, 'utf8'));
  const references = [...result.stderr.matchAll(/^FILE_TAP_COMPLETE: (.*)$/gm)].map(match => JSON.parse(match[1]));
  assert.equal(references.length, 1, result.stderr);
  const completion = references[0];
  assert.equal(completion.file, file);
  assert.equal(completion.observed_by, 'worker', 'recovery must retain the worker artifact, not synthesize one');
  assert.deepEqual(lost.completion, lost.durable);
  assert.deepEqual(completion, lost.durable);
  assert.deepEqual(JSON.parse(fs.readFileSync(completion.completion_artifact, 'utf8')), lost.durable);
  const rows = readRows(journal);
  const starts = rows.filter(row => row.kind === 'file' && row.event === 'start' && path.resolve(row.name) === file);
  assert.equal(starts.length, 1);
  const start = starts[0];
  assert.equal(start.pid, completion.native_exit.pid);
  const before = lost.rows.filter(row => row.id === start.id && row.event === 'finish');
  const finishes = rows.filter(row => row.id === start.id && row.event === 'finish');
  assert.equal(finishes.length, 1, JSON.stringify(rows));
  const finish = finishes[0];
  assert.equal(rows.filter(row => row.kind === 'suite' && row.event === 'finish').length, 1);
  assert.equal(result.code, completion.exit_code, result.stderr);
  // Keep the real pre-loss snapshot and final rows in the producer TAP after
  // fixture teardown, including the evidence distinguishing the two call sites.
  t.diagnostic(JSON.stringify({ lost, rows, recovered_completion: completion, runner_code: result.code }));
  return { result, completion, start, before, finish, worker: lost.worker_pid, coordinator: child.pid };
}

test('lost completion IPC recovers a missing file timing finish from the durable native exit', async t => {
  const { result, completion, start, before, finish, coordinator } = await loseCompletion(t,
    "test('native crash', () => process.kill(process.pid, 'SIGKILL'));\n");
  assert.equal(result.code, 1);
  assert.equal(before.length, 0, 'the file exit hook and IPC recovery must not have supplied a finish');
  assert.equal(completion.native_exit.exit_code, null);
  assert.equal(completion.native_exit.signal, 'SIGKILL');
  assert.equal(finish.exit_code, 1);
  assert.equal(finish.signal, 'SIGKILL');
  assert.equal(finish.reason, 'native-exit');
  assert.equal(finish.observed_by, 'coordinator');
  assert.equal(finish.pid, coordinator);
  assert.equal(finish.file_pid, start.pid);
  assert.deepEqual(finish.native_exit, completion.native_exit);
  assert.equal(finish.duration_s, Math.max(0, (Date.parse(completion.native_exit.at) - Date.parse(start.at)) / 1000));
});

test('lost completion IPC preserves an existing file timing finish without duplicating it', async t => {
  const { result, before, finish } = await loseCompletion(t, "test('normal exit', () => {});\n");
  assert.equal(result.code, 0);
  assert.equal(before.length, 1, 'normal file exit hook must finish before transport loss');
  assert.deepEqual(finish, before[0], 'durable completion recovery must leave the original finish intact');
  assert.equal(finish.exit_code, 0);
  assert.equal(finish.reason, undefined);
  assert.equal(finish.observed_by, undefined);
});
