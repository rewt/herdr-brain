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
