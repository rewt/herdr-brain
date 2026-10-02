import test from './helpers/bounded-test.mjs';
import assert from 'node:assert/strict';
import { createProcessTracker, processRegistries, parseProcessLookup } from './helpers/processes.mjs';

function row(pid, identity = 'first fixture', command = 'owned fixture', extra = {}) {
  return { pid, identity, command, ppid: 1, pgid: pid, state: 'S', ...extra };
}
function harness() {
  const rows = new Map([[101, row(101)], [202, row(202, 'unrelated generation', 'operator session')]]);
  const writes = [], signals = [], reports = [], queries = [];
  const hooks = {
    individual: (pid) => ({ ok: true, value: rows.get(pid) ?? null }),
    batch: () => ({ ok: true, value: new Map(rows) }),
  };
  const tracker = createProcessTracker({
    readIdentity: (pid) => { queries.push(pid); return hooks.individual(pid); },
    readIdentities: () => hooks.batch(),
    append: (file, entry) => writes.push({ file, entry }),
    sendSignal: (pid, signal) => signals.push({ pid, signal }),
    report: (message) => reports.push(message),
  });
  return { rows, writes, signals, reports, queries, hooks, tracker };
}

test('PID reuse refreshes every watchdog registration and preserves unrelated generations', () => {
  const h = harness(), files = ['local', 'ancestor'];
  const first = h.tracker.registerProcess(101, false, files);
  assert.equal(h.tracker.registerProcess(101, false, files), first);
  assert.equal(h.writes.length, 2);
  h.rows.set(101, row(101, 'unrelated replacement', 'operator session'));
  h.tracker.killProcess(first); h.tracker.killProcesses([first]);
  assert.deepEqual(h.signals, []);
  h.rows.set(101, row(101, 'new owned fixture', 'owned fixture'));
  const second = h.tracker.registerProcess(101, false, files);
  assert.notEqual(first, second);
  assert.equal(second.identity, 'new owned fixture');
  assert.deepEqual(h.writes.slice(2), files.map((file) => ({ file, entry: second })));
  h.tracker.killProcess(second); h.tracker.killProcesses([first, second]);
  assert.deepEqual(h.signals, [{ pid: 101, signal: 'SIGKILL' }, { pid: 101, signal: 'SIGKILL' }]);
  h.rows.set(101, row(101, 'later unrelated replacement', 'another session'));
  h.signals.length = 0;
  h.tracker.killProcess(second); h.tracker.killProcesses(h.writes.map(({ entry }) => entry));
  assert.deepEqual(h.signals, []);
});

test('descendant registrations reach each distinct ancestor before another registry is added', () => {
  const h = harness();
  const files = processRegistries({ TEST_PROCESS_REGISTRY: 'inner', TEST_PROCESS_ANCESTOR_REGISTRIES: '["middle","outer","middle"]' });
  assert.deepEqual(files, ['inner', 'middle', 'outer']);
  const entry = h.tracker.registerProcess(101, true, files);
  h.tracker.registerProcess(101, true, [...files, 'new ancestor']);
  assert.deepEqual(h.writes.map(({ file }) => file), [...files, 'new ancestor']);
  assert.ok(h.writes.every((write) => write.entry === entry));
});

for (const group of [false, true]) {
  for (const failure of ['timeout', 'failed', 'incomplete', 'thrown']) {
    test(`${failure} individual lookup never signals an unrelated replacement (${group ? 'group' : 'PID'})`, () => {
      const h = harness(), entry = h.tracker.registerProcess(101, group, []);
      h.rows.set(101, row(101, 'recycled PID', 'live operator session'));
      h.hooks.individual = () => {
        if (failure === 'thrown') throw Error('ps unavailable');
        return failure === 'incomplete' ? { ok: true, value: { pid: 101 } } : { ok: false, error: failure };
      };
      assert.equal(h.tracker.killProcess(entry).ok, false);
      assert.deepEqual(h.signals, []);
      assert.match(h.reports.join('\n'), /no signal sent/);
    });
  }
}

for (const failure of ['timeout', 'failed', 'incomplete', 'thrown']) {
  test(`${failure} batch lookup never signals historical groups or unrelated replacements`, () => {
    const h = harness(), entry = h.tracker.registerProcess(101, true, []);
    h.rows.set(101, row(101, 'recycled PID', 'live operator session'));
    h.hooks.batch = () => {
      if (failure === 'thrown') throw Error('ps unavailable');
      return failure === 'incomplete' ? { ok: true, value: new Map([[101, { pid: 101 }]]) } : { ok: false, error: failure };
    };
    assert.equal(h.tracker.killProcesses([entry]).ok, false);
    assert.deepEqual(h.signals, []);
    assert.match(h.reports.join('\n'), /process snapshot failed.*no signal sent/);
  });
}

test('batch cleanup freshly verifies each signal rather than trusting the enumeration snapshot', () => {
  const h = harness(), entry = h.tracker.registerProcess(101, true, []);
  const stale = new Map(h.rows);
  h.hooks.batch = () => ({ ok: true, value: stale });
  for (const replacement of [row(101, 'reused start', 'owned fixture'), row(101, 'first fixture', 'different command')]) {
    h.rows.set(101, replacement);
    h.tracker.killProcesses([entry]);
  }
  h.hooks.individual = () => ({ ok: false, error: 'timed out after snapshot' });
  assert.equal(h.tracker.killProcesses([entry]).ok, false);
  assert.deepEqual(h.signals, []);
  assert.equal(h.queries.length, 4, 'registration plus one current lookup per attempted signal');
  assert.ok(h.reports.some((message) => message.includes('timed out after snapshot')));
});

test('confirmed absence, command changes and a changed group leader never authorize historical signals', () => {
  const h = harness(), entry = h.tracker.registerProcess(101, true, []);
  h.rows.delete(101); h.tracker.killProcess(entry); h.tracker.killProcesses([entry]);
  h.rows.set(101, row(101, entry.identity, 'changed command')); h.tracker.killProcess(entry);
  h.rows.set(101, row(101, entry.identity, entry.command, { pgid: 303 })); h.tracker.killProcess(entry);
  assert.deepEqual(h.signals, []);
  assert.match(h.reports.join('\n'), /no longer its owned group leader/);
});

test('a positive current tuple immediately precedes both PID and group signals', () => {
  const h = harness();
  const single = h.tracker.registerProcess(101, false, []), group = h.tracker.registerProcess(101, true, []);
  h.tracker.killProcess(single, 'SIGTERM'); h.tracker.killProcess(group, 'SIGSTOP');
  assert.deepEqual(h.signals, [{ pid: 101, signal: 'SIGTERM' }, { pid: process.platform === 'win32' ? 101 : -101, signal: 'SIGSTOP' }]);
});

test('ownership is handed to rollback before a registry write can fail', () => {
  let owned;
  const h = harness();
  const tracker = createProcessTracker({ readIdentity: h.hooks.individual, append: () => { throw Error('registry closed'); } });
  assert.throws(() => tracker.registerProcess(101, true, ['closed'], (entry) => { owned = entry; }), /registry closed/);
  assert.equal(owned.identity, 'first fixture'); assert.equal(owned.command, 'owned fixture');
});

test('ps parsing rejects failed, timed-out, truncated and incomplete snapshots before any ownership is inferred', () => {
  const line = `${process.pid} 1 ${process.pid} S Fri Oct  2 01:00:00 2026 owned fixture\n`;
  const good = { status: 0, signal: null, stdout: line, stderr: '' };
  assert.equal(parseProcessLookup(good).ok, true);
  for (const result of [
    { ...good, status: null, error: Error('ETIMEDOUT') },
    { ...good, status: 1 }, { ...good, signal: 'SIGKILL' },
    { ...good, stdout: line.slice(0, -1) }, { ...good, stdout: line + 'partial\n' },
    { ...good, stdout: '101 1 101 S Fri Oct 2 01:00:00 2026 replacement\n' },
    { ...good, stdout: line + line }, { ...good, stdout: '' },
    { ...good, stderr: 'ps: permission denied' },
  ]) assert.equal(parseProcessLookup(result).ok, false);
  assert.deepEqual(parseProcessLookup({ status: 1, stdout: '', stderr: '' }, 101), { ok: true, value: null });
  assert.equal(parseProcessLookup({ status: 1, stdout: '', stderr: 'denied' }, 101).ok, false);
});

test('producer quiescence refuses failed identity and snapshot lookups without unverified signals', async () => {
  const h = harness(), entry = h.tracker.registerProcess(101, true, []);
  h.hooks.individual = () => ({ ok: false, error: 'timeout before stop' });
  assert.equal((await h.tracker.stopProcesses([entry])).ok, false);
  assert.deepEqual(h.signals, []);
  h.hooks.individual = (pid) => ({ ok: true, value: h.rows.get(pid) ?? null });
  h.hooks.batch = () => ({ ok: false, error: 'failed enumeration' });
  assert.equal((await h.tracker.stopProcesses([entry])).ok, false);
  assert.deepEqual(h.signals, [{ pid: process.platform === 'win32' ? 101 : -101, signal: 'SIGSTOP' }]);
  assert.match(h.reports.join('\n'), /failed enumeration.*no signal sent/);
});

test('quiescence finds unregistered descendants and checks their exact tuple while preserving siblings', async () => {
  const rows = new Map([[101, row(101)], [303, row(303, 'new descendant', 'detached fixture', { ppid: 101 })], [202, row(202, 'other session', 'operator')]]);
  const signals = [];
  const tracker = createProcessTracker({
    readIdentity: (pid) => ({ ok: true, value: rows.get(pid) ?? null }),
    readIdentities: () => ({ ok: true, value: new Map(rows) }),
    append: () => {},
    sendSignal: (pid, signal) => {
      signals.push({ pid, signal });
      const process = rows.get(Math.abs(pid)); process.state = 'T';
    },
  });
  const entry = tracker.registerProcess(101, true, []);
  const result = await tracker.stopProcesses([entry]);
  assert.equal(result.ok, true);
  assert.deepEqual(result.entries.map(({ pid }) => pid), [101, 303]);
  assert.deepEqual(signals, [{ pid: process.platform === 'win32' ? 101 : -101, signal: 'SIGSTOP' }, { pid: 303, signal: 'SIGSTOP' }]);
  assert.equal(rows.get(202).state, 'S');
});

test('invalid owned identities and mismatched snapshot keys never authorize signals', () => {
  const h = harness();
  for (const entry of [{ pid: 1, identity: 'first fixture', command: 'owned fixture' }, { pid: 101, identity: 'first fixture' }]) {
    assert.equal(h.tracker.killProcess(entry).ok, false);
  }
  const entry = h.tracker.registerProcess(101, true, []);
  h.hooks.batch = () => ({ ok: true, value: new Map([[202, h.rows.get(101)]]) });
  assert.equal(h.tracker.killProcesses([entry]).ok, false);
  assert.deepEqual(h.signals, []);
});
