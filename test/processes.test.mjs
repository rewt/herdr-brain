import test from './helpers/bounded-test.mjs';
import assert from 'node:assert/strict';
import { createProcessTracker, parseProcessLookup } from './helpers/processes.mjs';

function row(pid, identity = 'first fixture', command = 'owned fixture', extra = {}) {
  return { pid, identity, command, ppid: 1, pgid: pid, state: 'S', ...extra };
}
function harness() {
  const rows = new Map([[101, row(101)], [202, row(202, 'unrelated generation', 'operator session')]]);
  const signals = [], reports = [], queries = [];
  const hooks = {
    individual: (pid) => ({ ok: true, value: rows.get(pid) ?? null }),
    batch: () => ({ ok: true, value: new Map(rows) }),
  };
  const tracker = createProcessTracker({
    readIdentity: (pid) => { queries.push(pid); return hooks.individual(pid); },
    readIdentities: () => hooks.batch(),
    sendSignal: (pid, signal) => signals.push({ pid, signal }),
    report: (message) => reports.push(message),
  });
  return { rows, signals, reports, queries, hooks, tracker };
}

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
  test(`${failure} audit reports failure but does not prevent fresh group teardown`, () => {
    const h = harness(), entry = h.tracker.registerProcess(101, true);
    h.hooks.batch = () => {
      if (failure === 'thrown') throw Error('ps unavailable');
      return failure === 'incomplete' ? { ok: true, value: new Map([[101, { pid: 101 }]]) } : { ok: false, error: failure };
    };
    assert.equal(h.tracker.auditGroup(entry).ok, false);
    assert.deepEqual(h.signals, [], 'audit is report-only and never suspends a producer');
    assert.equal(h.tracker.killProcess(entry).signaled, true);
    assert.deepEqual(h.signals, [{ pid: process.platform === 'win32' ? 101 : -101, signal: 'SIGKILL' }]);
    assert.match(h.reports.join('\n'), /process snapshot failed.*no signal sent/);
  });
}

test('the audit reports group members whose parent exited, without hunting or signalling them', () => {
  const h = harness(), entry = h.tracker.registerProcess(101, true);
  h.rows.set(303, row(303, 'background child', 'sleep 60', { ppid: 1, pgid: 101 }));
  assert.deepEqual(h.tracker.auditGroup(entry).survivors.map(row => row.pid), [303]);
  assert.deepEqual(h.signals, []);
  h.rows.set(101, row(101, 'recycled leader', 'operator session'));
  assert.equal(h.tracker.auditGroup(entry).ok, false);
  h.tracker.killProcess(entry);
  assert.deepEqual(h.signals, []);
});

test('confirmed absence, command changes and a changed group leader never authorize historical signals', () => {
  const h = harness(), entry = h.tracker.registerProcess(101, true, []);
  h.rows.delete(101); h.tracker.killProcess(entry);
  h.rows.set(101, row(101, entry.identity, 'changed command')); h.tracker.killProcess(entry);
  h.rows.set(101, row(101, entry.identity, entry.command, { pgid: 303 })); h.tracker.killProcess(entry);
  assert.deepEqual(h.signals, []);
  assert.match(h.reports.join('\n'), /no longer its owned group leader/);
});

test('a zombie never licenses a signal even when its command has become defunct', () => {
  const h = harness(), entry = h.tracker.registerProcess(101, true);
  h.rows.set(101, row(101, entry.identity, '<defunct>', { state: 'Z' }));
  assert.deepEqual(h.tracker.killProcess(entry), { ok: true, signaled: false, reason: 'absent' });
  assert.deepEqual(h.signals, []);
});

test('a positive current tuple immediately precedes both PID and group signals', () => {
  const h = harness();
  const single = h.tracker.registerProcess(101, false, []), group = h.tracker.registerProcess(101, true, []);
  h.tracker.killProcess(single, 'SIGTERM'); h.tracker.killProcess(group, 'SIGKILL');
  assert.deepEqual(h.signals, [{ pid: 101, signal: 'SIGTERM' }, { pid: process.platform === 'win32' ? 101 : -101, signal: 'SIGKILL' }]);
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

test('invalid owned identities and mismatched snapshot keys never authorize signals', () => {
  const h = harness();
  for (const entry of [{ pid: 1, identity: 'first fixture', command: 'owned fixture' }, { pid: 101, identity: 'first fixture' }]) {
    assert.equal(h.tracker.killProcess(entry).ok, false);
  }
  const entry = h.tracker.registerProcess(101, true, []);
  h.hooks.batch = () => ({ ok: true, value: new Map([[202, h.rows.get(101)]]) });
  assert.equal(h.tracker.auditGroup(entry).ok, false);
  assert.deepEqual(h.signals, []);
});
