import test from './helpers/bounded-test.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { exitFixture } from './helpers/retire-exit-fixture.mjs';
import { hold } from './helpers/retire-fixture.mjs';
import { sameExitShell, executeRetirement, planRetirement } from '../lib/retire.mjs';

test('exit identity admits only kernel/login shell spelling with the exact original birth', () => {
  const original = { pid: 5, identity: 'shell-birth', command: '[zsh]' };
  for (const command of ['[zsh]', 'zsh', '-zsh']) {
    assert.equal(sameExitShell(original, { ...original, command }), true, command);
    assert.equal(sameExitShell({ ...original, command }, original), true, command);
  }
  for (const change of [{ pid: 6 }, { identity: 'replacement' }, { command: '[bash]' },
    { command: '-bash' }, { command: 'zsh -c other' }, { command: '/other/zsh' },
    { command: 'sleep' }, { command: '' }])
    assert.equal(sameExitShell(original, { ...original, ...change }), false, JSON.stringify(change));
  assert.equal(sameExitShell(original, null), false);
});

// Reproduce the native source change without changing the shared fixture or
// its original controls: the prompt runs first, then the same shell exposes argv.
function loginShellExit(f, after = () => {}) {
  return (exe, args, options) => {
    const result = spawnSync(exe, args, options);
    if (exe === f.job.herdr && args[0] === 'agent' && args[1] === 'prompt' && result.status === 0) {
      const state = f.read(); state.info.process_tree[0].command = '-zsh';
      fs.writeFileSync(f.file, JSON.stringify(state)); after();
    }
    return result;
  };
}

test('exit identity records the observed login shell and closes without a second exit', t => {
  const f = exitFixture(t, { bound: true }), logs = [];
  const retirement = f.retirement({ command: loginShellExit(f), log: row => logs.push(row) });
  const plan = retirement.plan(); assert.equal(plan.close[0].shell.command, '[zsh]');
  assert.equal(retirement.apply(plan)[0].action, 'closed');
  const observed = logs.find(row => row.action === 'exit-observed');
  assert.deepEqual(observed.shell, { ...plan.close[0].shell, command: '-zsh' });
  assert.deepEqual(f.read().actions, [['agent', 'prompt', 'worker', '/quit'], ['tab', 'close', 'w:t']]);
});

test('exit identity retains its observed login shell across a late hold and fresh adapter', t => {
  const f = exitFixture(t, { bound: true }); let clear;
  const retirement = f.retirement({ command: loginShellExit(f, () => { clear = hold(f); }) });
  const result = retirement.apply(retirement.plan());
  assert.equal(result[0].action, 'skip-close'); assert.match(result[0].why, /retirement held/);
  const directory = path.join(f.org, 'retirement/exits');
  const receipt = JSON.parse(fs.readFileSync(path.join(directory, fs.readdirSync(directory)[0])));
  assert.equal(receipt.shell.command, '-zsh');
  clear(); const next = f.retirement();
  assert.equal(next.apply(next.plan())[0].action, 'closed');
  assert.deepEqual(f.read().actions, [['agent', 'prompt', 'worker', '/quit'], ['tab', 'close', 'w:t']]);
});

test('exit identity spelling never excuses replacement occupants or changed exit authority', t => {
  const f = exitFixture(t, { bound: true }), before = f.retirement().observe(), plan = planRetirement(before);
  assert.equal(plan.close[0].decision, 'exit');
  const changes = [
    ['shell birth', s => { s.panes[0].process_info.process_tree[0].identity = 'new-birth'; }],
    ['shell PID', s => { s.panes[0].process_info.shell_pid = 99; }],
    ['shell kind', s => { s.panes[0].process_info.process_tree[0].command = '-bash'; }],
    ['terminal', s => { s.panes[0].terminal_id = 'new-terminal'; }],
    ['pane', s => { s.panes[0].pane_id = 'w:new'; }],
    ['second pane', s => { s.panes.push({ ...s.panes[0], pane_id: 'w:new' }); }],
    ['session', s => { s.agents = [{ ...before.agents[0], agent_session: { value: 'new-session' } }]; }],
    ['background job', s => { s.panes[0].process_info.process_tree.push({ pid: 99, identity: 'job', command: 'sleep', state: 'S' }); }],
    ['dirty checkout', s => { s.git[0].clean = false; }],
    ['hold', s => { s.retirementHold = 'owner hold'; }],
    ['closed pane without completion', s => { s.panes = []; s.tabs = []; }],
  ];
  for (const [name, change] of changes) {
    const current = structuredClone(before); let exits = 0;
    const result = executeRetirement(plan, { observe: () => current,
      exit: () => {
        exits++; current.agents = [];
        const pane = current.panes[0], shell = { ...pane.process_info.process_tree[0], command: '-zsh' };
        pane.shellOnly = true;
        pane.process_info = { ...pane.process_info, process_tree: [shell], foreground_processes: [{ pid: shell.pid, name: 'zsh' }] };
        change(current);
      },
      // Supply only a valid original receipt; the fresh ordinary policy must
      // still refuse dirty, held and extra-process cases after observation.
      exitObserved: candidate => { current.exits = [{ schema: 'retirement-exit/v1', common: current.common,
        cwd: f.lane, workspace: 'w', tab: 'w:t', pane: 'w:p', run: 'R-1',
        occupant: { ...before.agents[0], agent_session_id: 'session' },
        shell: { ...candidate.shell, command: '-zsh' } }]; },
      now: () => 0, exitTimeoutMs: 0,
      close: () => assert.fail(`${name} must retain its pane`) });
    assert.equal(exits, 1, name); assert.equal(result[0].action, 'skip-close', name);
  }
});

test('exit transition waits for cleared native fields without mistaking them for completion', t => {
  const f = exitFixture(t, { bound: true }), before = f.retirement().observe(), plan = planRetirement(before);
  for (const after of ['gone', 'replacement', 'never-clears', 'native-refusal', 'deadline']) {
    const current = structuredClone(before), candidate = plan.close[0];
    let requested = 0, paused = 0, observed = 0, clock = 0, readingExit = false;
    const result = executeRetirement(plan, {
      observe: () => {
        if (readingExit && paused && after === 'native-refusal') throw Object.assign(Error('native refusal'), { code: 'EPERM' });
        if (readingExit && paused && after === 'deadline') throw Object.assign(Error('deadline'), { code: 'RETIREMENT_DEADLINE' });
        return current;
      },
      exit: () => {
        requested++; readingExit = true;
        // Native recognition can clear the name/session before removing its
        // row. The original terminal and shell remain, but this is not finality.
        delete current.agents[0].name; delete current.agents[0].agent_session;
        const pane = current.panes[0], shell = pane.process_info.process_tree[0];
        pane.shellOnly = true;
        pane.process_info = { ...pane.process_info, process_tree: [shell], foreground_processes: [{ pid: shell.pid, name: 'zsh' }] };
      },
      exitObserved: () => {
        observed++;
        assert.equal(after, 'gone'); assert.equal(current.agents.length, 0);
        current.exits = [{ schema: 'retirement-exit/v1', common: current.common, cwd: f.lane,
          workspace: 'w', tab: 'w:t', pane: 'w:p', run: 'R-1',
          occupant: { ...before.agents[0], agent_session_id: 'session' }, shell: candidate.shell }];
      },
      now: () => clock, exitTimeoutMs: 500,
      pause: ms => {
        assert.equal(observed, 0); paused++; clock += ms;
        if (after === 'gone') current.agents = [];
        if (after === 'replacement') current.agents = [{ ...before.agents[0], agent_session: { value: 'replacement' } }];
      },
      close: () => { assert.equal(after, 'gone'); assert.equal(observed, 1); },
    });
    assert.equal(requested, 1, after); assert.ok(paused > 0, after);
    assert.equal(result[0].action, after === 'gone' ? 'closed' : after === 'deadline' ? 'deferred' : 'skip-close', after);
    if (after === 'replacement') {
      assert.equal(paused, 1, 'a positive replacement stops immediately');
      assert.equal(result[0].exit_observation.state, 'changed');
      assert.equal(result[0].exit_observation.occupants[0][6], 'replacement');
    }
    if (after === 'never-clears') assert.equal(result[0].exit_observation.state, 'leaving');
    if (after === 'native-refusal') assert.equal(result[0].command_error.code, 'EPERM');
    if (['native-refusal', 'deadline'].includes(after)) {
      assert.equal(paused, 1, 'a thrown read is never retried');
      assert.equal(observed, 0);
      const facts = result[0].exit_observation;
      assert.equal(facts.state, 'leaving');
      assert.equal(facts.panes[0].terminal, candidate.occupant[5]);
      assert.deepEqual(facts.panes[0].tree.map(p => [p.pid, p.identity]), [[candidate.shell.pid, candidate.shell.identity]]);
      assert.deepEqual(facts.occupants[0], [undefined, ...candidate.occupant.slice(1, 6), undefined]);
    }
  }
});

test('exit diagnostics retain the final wait snapshot and distinguish clearing from replacement', t => {
  const f = exitFixture(t, { bound: true }), before = f.retirement().observe(), plan = planRetirement(before);
  for (const after of ['clearing', 'replacement', 'EPERM', 'RETIREMENT_DEADLINE', 'first-read-refusal']) {
    let reads = 0, requested = 0, observed = 0;
    const exited = structuredClone(before), candidate = plan.close[0];
    exited.agents = [];
    const pane = exited.panes[0], shell = pane.process_info.process_tree[0];
    pane.shellOnly = true;
    pane.process_info = { ...pane.process_info, process_tree: [shell], foreground_processes: [{ pid: shell.pid, name: 'zsh' }] };
    const final = structuredClone(exited);
    final.agents = [{ ...before.agents[0] }];
    if (after === 'clearing') { delete final.agents[0].name; delete final.agents[0].agent_session; }
    else final.agents[0].agent_session = { value: 'replacement' };
    const result = executeRetirement(plan, {
      observe: () => {
        reads++;
        if (reads === 1) return before;
        if (reads === 2 && after !== 'first-read-refusal') return exited;
        if (['EPERM', 'RETIREMENT_DEADLINE', 'first-read-refusal'].includes(after))
          throw Object.assign(Error('observation refused'), { code: after === 'first-read-refusal' ? 'EPERM' : after, status: 7 });
        return final;
      },
      exit: () => { requested++; }, exitObserved: () => { observed++; },
      close: () => assert.fail('incomplete or refused observation must keep the pane'),
    })[0];
    assert.equal(requested, 1); assert.equal(reads, after === 'first-read-refusal' ? 2 : 3);
    assert.equal(observed, after === 'first-read-refusal' ? 0 : 1);
    assert.equal(result.action, after === 'RETIREMENT_DEADLINE' ? 'deferred' : 'skip-close');
    const facts = result.exit_observation;
    assert.equal(facts.panes[0].terminal, candidate.occupant[5]);
    if (after === 'clearing') {
      assert.equal(facts.state, 'leaving'); assert.match(result.why, /fields still clearing/);
      assert.doesNotMatch(result.why, /identity changed/);
    } else if (after === 'replacement') {
      assert.equal(facts.state, 'changed'); assert.match(result.why, /identity changed/);
    } else {
      assert.equal(facts.state, 'same');
      assert.equal(result.command_error.status, 7);
      assert.equal(result.command_error.code, after === 'first-read-refusal' ? 'EPERM' : after);
      assert.deepEqual(facts.occupants, after === 'first-read-refusal' ? [candidate.occupant] : []);
      assert.deepEqual(facts.panes[0].tree, (after === 'first-read-refusal' ? before : exited).panes[0].process_info.process_tree);
    }
  }
});
