import test from './helpers/bounded-test.mjs';
import assert from 'node:assert/strict';
import { createProcessTracker, parseProcessLookup, lookupGroupProcesses } from './helpers/processes.mjs';
import { createReceiptTracker } from './helpers/receipts.mjs';

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

test('group inventory reads argv only for suite members after kernel birth selection', () => {
  const leader = row(101), orphan = row(303, 'orphan', 'sleep 60', { ppid: 1, pgid: 101 });
  const foreign = row(202, 'foreign', 'unreadable argv');
  const calls = [];
  const result = lookupGroupProcesses(leader, (pid, options) => {
    calls.push([pid, options]);
    if (pid === undefined) {
      assert.equal(options.identityOnly, true);
      return { ok: true, value: new Map([leader, orphan, foreign].map(row => [row.pid, { ...row, command: '[kernel]' }])) };
    }
    assert.notEqual(pid, foreign.pid, 'foreign argv must never be requested');
    return { ok: true, value: pid === leader.pid ? leader : orphan };
  });
  assert.deepEqual(calls.map(([pid]) => pid), [undefined, leader.pid, orphan.pid]);
  assert.deepEqual([...result.value.values()], [leader, orphan]);
  const tracker = createProcessTracker({ readIdentities: entry => { assert.equal(entry, leader); return result; }, report: () => {} });
  assert.deepEqual(tracker.auditGroup(leader).survivors, [orphan]);
});

for (const failure of ['kernel-denied', 'member-denied', 'birth-changed', 'group-changed', 'incomplete', 'member-exited']) {
  test(`group inventory preserves failed or changed ownership evidence: ${failure}`, () => {
    const leader = row(101);
    const result = lookupGroupProcesses(leader, pid => {
      if (pid === undefined) return failure === 'kernel-denied' ? { ok: false, error: 'kernel denied' }
        : { ok: true, value: new Map([[leader.pid, leader]]) };
      if (failure === 'member-denied') return { ok: false, error: 'member denied' };
      if (failure === 'member-exited') return { ok: true, value: null };
      return { ok: true, value: failure === 'incomplete' ? { pid } : { ...leader,
        ...(failure === 'birth-changed' ? { identity: 'reused' } : { pgid: 202 }) } };
    });
    assert.equal(result.ok, failure === 'member-exited');
    if (result.ok) assert.equal(result.value.size, 0);
    else assert.match(result.error, /denied|changed during audit/);
  });
}

test('exited guard drain waits for exact orphan identities without signalling or exempting survivors', async () => {
  const h = harness(), command = '/fixture-guard --watch /suite/alive 60 404';
  const guard = row(303, 'guard birth', command, { pgid: 101 });
  h.rows.set(303, guard);
  const rows = [guard, row(304, 'fixture', 'sleep 60', { pgid: 101 }),
    row(305, 'live guard', command, { ppid: 404, pgid: 101 })];
  let pauses = 0;
  await h.tracker.drainExitedGuards(rows, new Set([command]), { drainMs: 100,
    now: () => 0, pause: async () => { pauses++; h.rows.delete(303); } });
  assert.equal(pauses, 1);
  assert.deepEqual(h.queries, [303, 303]);
  assert.deepEqual(h.signals, []);
  assert.equal(h.tracker.drainExitedGuards(rows.slice(1), new Set([command]), { drainMs: 100 }), null);
  assert.equal(h.tracker.drainExitedGuards(rows, new Set([command + ' changed']), { drainMs: 100 }), null);
});

for (const initial of ['argv', 'kernel']) {
  test(`exited guard drain joins ${initial} evidence through kernel-only exit without signalling`, async () => {
    const h = harness(), exitCommand = '[17f859a4bccd76ec]';
    const guard = row(303, 'guard birth', initial === 'argv' ? '/fixture-guard --watch /suite/alive 60 404' : exitCommand,
      { pgid: 101 });
    h.rows.set(303, { ...guard });
    let pauses = 0;
    await h.tracker.drainExitedGuards([guard], new Set([guard.command]), { drainMs: 100, exitCommand,
      now: () => 0, pause: async () => {
        if (++pauses === 1) h.rows.get(303).command = exitCommand;
        else h.rows.delete(303);
      } });
    assert.equal(pauses, 2);
    assert.deepEqual(h.queries, [303, 303, 303]);
    assert.deepEqual(h.signals, []);
  });
}

for (const failure of ['birth', 'command', 'failed', 'stuck', 'exec']) {
  test(`exited guard drain kernel-only evidence still fails closed on ${failure}`, async () => {
    const h = harness(), exitCommand = '[17f859a4bccd76ec]';
    const guard = row(303, 'guard birth', exitCommand, { pgid: 101 });
    h.rows.set(303, { ...guard });
    if (failure === 'birth') h.rows.get(303).identity = 'replacement';
    if (failure === 'command') h.rows.get(303).command = '[different]';
    if (failure === 'exec') h.rows.get(303).command = '/fixture-guard --watch /suite/alive 60 404';
    if (failure === 'failed') h.hooks.individual = () => ({ ok: false, error: 'argv read refused' });
    let now = 0, pauses = 0;
    await assert.rejects(h.tracker.drainExitedGuards([guard], new Set([guard.command]), {
      drainMs: 100, exitCommand, now: () => now, pause: async () => { pauses++; now += 100; },
    }), /identity changed|argv read refused|drain exceeded/);
    if (failure !== 'stuck') assert.equal(pauses, 0, 'failed evidence must stop the drain immediately');
    if (failure === 'failed') assert.deepEqual(h.queries, [303], 'a refused read must not be retried');
    assert.deepEqual(h.signals, []);
  });
}

test('exited guard drain rejects a return to argv after kernel-only exit evidence', async () => {
  const h = harness(), exitCommand = '[17f859a4bccd76ec]';
  const guard = row(303, 'guard birth', '/fixture-guard --watch /suite/alive 60 404', { pgid: 101 });
  h.rows.set(303, { ...guard });
  let pauses = 0;
  await assert.rejects(h.tracker.drainExitedGuards([guard], new Set([guard.command]), {
    drainMs: 100, exitCommand, now: () => 0, pause: async () => {
      h.rows.get(303).command = ++pauses === 1 ? exitCommand : guard.command;
    },
  }), /identity changed/);
  assert.equal(pauses, 2);
  assert.deepEqual(h.signals, []);
});

for (const failure of ['birth', 'command', 'parent', 'group', 'incomplete', 'failed', 'thrown', 'stuck']) {
  test(`exited guard drain fails closed on ${failure} evidence`, async () => {
    const h = harness(), guard = row(303, 'guard birth', 'exact guard', { pgid: 101 });
    h.rows.set(303, { ...guard });
    const current = h.rows.get(303);
    if (failure === 'birth') current.identity = 'replacement';
    if (failure === 'command') current.command = 'other command';
    if (failure === 'parent') current.ppid = 404;
    if (failure === 'group') current.pgid = 202;
    if (failure === 'incomplete') h.hooks.individual = () => ({ ok: true, value: { pid: 303 } });
    if (failure === 'failed') h.hooks.individual = () => ({ ok: false, error: 'native unavailable' });
    if (failure === 'thrown') h.hooks.individual = () => { throw Error('native refused'); };
    let now = 0;
    await assert.rejects(h.tracker.drainExitedGuards([guard], new Set([guard.command]), {
      drainMs: 100, now: () => now, pause: async () => { now += 100; },
    }), /identity changed|lookup failed|native refused|drain exceeded/);
    assert.deepEqual(h.signals, []);
  });
}

for (const failure of ['absent', 'zombie', 'failed', 'incomplete', 'changed leader', 'nonleader']) {
  test(`receipt registration refuses ${failure} ownership without signalling`, () => {
    const h = harness();
    const receipts = createReceiptTracker({ tracker: h.tracker, suitePid: 101 });
    h.rows.set(202, row(202, 'fixture birth', 'expected command', { pgid: 101 }));
    if (failure === 'absent') h.rows.delete(202);
    if (failure === 'zombie') h.rows.get(202).state = 'Z';
    if (failure === 'changed leader') h.rows.set(101, row(101, 'replacement leader'));
    if (failure === 'nonleader') h.rows.get(101).pgid = 303;
    if (['failed', 'incomplete'].includes(failure)) h.hooks.individual = pid => pid === 101
      ? failure === 'failed' ? { ok: false, error: 'ps failed' } : { ok: true, value: { pid } }
      : { ok: true, value: h.rows.get(pid) };
    if (['absent', 'zombie'].includes(failure)) assert.equal(receipts.remember(202, 'expected command'), null);
    else assert.throws(() => receipts.remember(202, 'expected command'), /cannot verify live suite group/);
    receipts.cleanup();
    assert.deepEqual(h.signals, []);
  });
}

for (const group of [false, true]) {
  for (const failure of ['timeout', 'failed', 'incomplete', 'thrown']) {
    test(`${failure} individual lookup never signals an unrelated replacement (${group ? 'group' : 'PID'})`, () => {
      const h = harness(), entry = h.tracker.registerProcess(101, group);
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
  const h = harness(), entry = h.tracker.registerProcess(101, true);
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
  const single = h.tracker.registerProcess(101, false), group = h.tracker.registerProcess(101, true);
  h.tracker.killProcess(single, 'SIGTERM'); h.tracker.killProcess(group, 'SIGKILL');
  assert.deepEqual(h.signals, [{ pid: 101, signal: 'SIGTERM' }, { pid: process.platform === 'win32' ? 101 : -101, signal: 'SIGKILL' }]);
});

test('process source parsing rejects failed, timed-out, truncated and incomplete snapshots before any ownership is inferred', () => {
  const line = JSON.stringify(row(process.pid, '1700000000:123456')) + '\n';
  const good = { status: 0, signal: null, stdout: line, stderr: '' };
  assert.equal(parseProcessLookup(good).ok, true);
  for (const result of [
    { ...good, status: null, error: Error('ETIMEDOUT') },
    { ...good, status: 1 }, { ...good, signal: 'SIGKILL' },
    { ...good, stdout: line.slice(0, -1) }, { ...good, stdout: line + 'partial\n' },
    { ...good, stdout: JSON.stringify(row(101, '1700000000:123456')) + '\n' },
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
  const entry = h.tracker.registerProcess(101, true);
  h.hooks.batch = () => ({ ok: true, value: new Map([[202, h.rows.get(101)]]) });
  assert.equal(h.tracker.auditGroup(entry).ok, false);
  assert.deepEqual(h.signals, []);
});
