import test from './helpers/bounded-test.mjs';
import assert from 'node:assert/strict';
import { createProcessTracker, processRegistries } from './helpers/processes.mjs';

test('PID reuse refreshes every watchdog registration and preserves the unrelated generation', () => {
  const starts = new Map([[101, 'first fixture'], [202, 'unrelated process']]);
  const writes = [], signals = [];
  const tracker = createProcessTracker({
    readIdentity: (pid) => starts.get(pid),
    readIdentities: () => new Map(starts),
    append: (file, entry) => writes.push({ file, entry }),
    sendSignal: (pid, signal) => signals.push({ pid, signal }),
  });
  const files = ['local registry', 'ancestor registry'];
  const first = tracker.registerProcess(101, false, files);
  assert.equal(tracker.registerProcess(101, false, files), first);
  assert.equal(writes.length, 2, 'the same acknowledged generation is not duplicated');

  starts.set(101, 'unrelated replacement');
  tracker.killProcess(first);
  tracker.killProcesses([first]);
  assert.deepEqual(signals, [], 'stale ownership must not authorize killing a reused PID');

  // A later fixture is genuinely owned again, with the same numeric PID.
  starts.set(101, 'new owned fixture');
  const second = tracker.registerProcess(101, false, files);
  assert.notEqual(second, first);
  assert.equal(second.identity, 'new owned fixture');
  assert.deepEqual(writes.slice(2), files.map((file) => ({ file, entry: second })));
  tracker.killProcess(second);
  tracker.killProcesses([first, second]);
  assert.deepEqual(signals, [{ pid: 101, signal: 'SIGKILL' }, { pid: 101, signal: 'SIGKILL' }]);
  assert.ok(signals.every(({ pid }) => pid !== 202), 'another live process is left alone');

  starts.set(101, 'another unrelated replacement');
  signals.length = 0;
  tracker.killProcess(second);
  tracker.killProcesses(writes.map(({ entry }) => entry));
  assert.deepEqual(signals, [], 'both old generations must preserve a future unrelated replacement');
});

test('descendant registrations reach every distinct ancestor watchdog', () => {
  const paths = processRegistries({
    TEST_PROCESS_REGISTRY: 'inner',
    TEST_PROCESS_ANCESTOR_REGISTRIES: JSON.stringify(['middle', 'outer', 'middle']),
  });
  assert.deepEqual(paths, ['inner', 'middle', 'outer']);
  const writes = [];
  const tracker = createProcessTracker({ readIdentity: () => 'fixture generation', append: (file, entry) => writes.push({ file, entry }) });
  const entry = tracker.registerProcess(303, true, paths);
  assert.deepEqual(writes.map(({ file }) => file), paths);
  tracker.registerProcess(303, true, [...paths, 'new ancestor']);
  assert.deepEqual(writes.map(({ file }) => file), [...paths, 'new ancestor']);
  assert.ok(writes.every((write) => write.entry === entry));
});
