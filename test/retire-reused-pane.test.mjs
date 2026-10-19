import test from './helpers/bounded-test.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fixture } from './helpers/retire-fixture.mjs';
import { initialShellFile, recordInitialShell, claimInitialShell } from '../lib/initial-shell.mjs';
import { planRetirement } from '../lib/retire.mjs';

function reusedPane(t, receipted) {
  const f = fixture(t, { merged: false }), state = f.state;
  state.tabs[0].tab_id = 'w:t1';
  state.panes[0] = { pane_id: 'w:p1', tab_id: 'w:t1', workspace_id: 'w', terminal_id: 'term', foreground_cwd: f.lane };
  const shell = { pid: 1, identity: 'shell', state: 'S', command: '[zsh]' };
  const info = { shell_pid: 1, foreground_processes: [{ pid: 1, name: 'zsh' }], process_tree_complete: true, process_tree: [shell] };
  if (receipted) {
    recordInitialShell({ common: f.common, cwd: f.lane,
      created: { already_open: false, workspace: state.workspaces[0], tab: state.tabs[0], root_pane: state.panes[0] },
      h: args => args[1] === 'get' ? { pane: state.panes[0] } : { process_info: info } });
    claimInitialShell(f.common, 'w:t1');
  }
  Object.assign(state.agents[0], { agent: 'codex', pane_id: 'w:p1', tab_id: 'w:t1' });
  // The acceptance dispatch has a terminal receipt before a native session ID.
  delete state.agents[0].agent_session;
  state.info = { ...info, foreground_processes: [{ pid: 2, name: 'codex' }],
    process_tree: [shell, { pid: 2, ppid: 1, identity: 'worker', state: 'S', command: '[codex]' }] };
  const events = f.eventBytes.trim().split('\n').map(JSON.parse);
  Object.assign(events[1].meta, { pane: 'w:p1' });
  delete events[1].meta.agent_session_id;
  const writeEvents = count => fs.writeFileSync(f.eventFile, events.slice(0, count).map(e => JSON.stringify(e) + '\n').join(''));
  writeEvents(2); f.save();
  return { ...f, writeEvents, receipt: initialShellFile(f.common, 'w:t1') };
}

for (const receipted of [false, true]) test(`lane close retires the recorded agent in reused t1 with ${receipted ? 'a claimed' : 'no'} initial-shell receipt`, t => {
  const f = reusedPane(t, receipted);
  assert.equal(fs.existsSync(f.receipt), receipted);
  assert.equal(f.retirement().plan(f.lane).close.length, 0, 'an unreported dispatch stays open');
  f.writeEvents(3);
  assert.equal(f.retirement().plan(f.lane).close.length, 0, 'a report alone does not close the integration chain');
  f.git(['merge', '--ff-only', f.head]); f.writeEvents(4);
  const plan = f.retirement().plan(f.lane);
  assert.deepEqual(plan.keep, []); assert.equal(plan.close[0].tab_id, 'w:t1');
  assert.equal(plan.close[0].rule, undefined, 'the agent path supplies authority');
  const result = f.close(false);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.deepEqual(f.read().actions, [['tab', 'close', 'w:t1'], ['workspace', 'close', 'w']]);
  assert.equal(fs.existsSync(f.lane), false);
  assert.equal(f.git(['branch', '--list', 'lane/topic']), '');
});

test('initial-shell receipt errors and ambiguity cannot replace the occupied agent identity checks', t => {
  const f = reusedPane(t, true); f.git(['merge', '--ff-only', f.head]); f.writeEvents(4);
  const snapshot = f.retirement().observe(f.lane);
  snapshot.initialShells.push(structuredClone(snapshot.initialShells[0]));
  snapshot.initialShellErrors.push({ tab: 'w:t1', reason: 'initial shell receipt is malformed or unreadable' });
  assert.equal(planRetirement(snapshot).close[0].tab_id, 'w:t1');
  snapshot.agents[0].terminal_id = 'replacement';
  assert.match(planRetirement(snapshot).keep[0].why, /recorded launch identity/);
  // Exercise the same precedence through the runtime and lane-close consumer.
  fs.writeFileSync(f.receipt, '{truncated');
  const result = f.close(false);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(fs.existsSync(f.lane), false);
});

for (const guard of ['terminal', 'agent', 'pane', 'foreground', 'unoccupied foreground', 'reference', 'HOLD'])
  test(`reused t1 lane close keeps ${guard} without removing its tab or worktree`, t => {
    const f = reusedPane(t, false); f.git(['merge', '--ff-only', f.head]); f.writeEvents(4);
    let reason = /recorded launch identity/;
    if (guard === 'terminal') f.state.agents[0].terminal_id = 'replacement';
    if (guard === 'agent') f.state.agents[0].name = 'replacement';
    if (guard === 'pane') f.state.agents[0].pane_id = 'w:replacement';
    if (guard.includes('foreground')) {
      f.state.info.foreground_processes[0].name = 'node';
      f.state.info.process_tree[1].command = '[node]';
      reason = /another or unknown foreground process/;
      if (guard === 'unoccupied foreground') { f.state.agents = []; reason = /inert shell foreground/; }
    }
    if (guard === 'reference') {
      fs.writeFileSync(path.join(f.org, 'references/job.json'), JSON.stringify({ schema: 'herdr-reference/v1', state: 'running',
        owner: 'fixture', kind: 'live fixture', job: 'job', item: 'ENG-1',
        created_at: new Date().toISOString(), expires_at: new Date(Date.now() + 60000).toISOString() }));
      reason = /live fixture reference/;
    }
    if (guard === 'HOLD') {
      const file = path.join(f.repo, '.lane/supervisor/HOLD-WORKER-TAB-CLOSE');
      fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, 'held'); reason = /retirement held/;
    }
    f.save();
    const result = f.close(false);
    assert.notEqual(result.status, 0); assert.match(result.stdout + result.stderr, guard === 'pane' ? /topology disagree/ : reason);
    assert.deepEqual(f.read().actions, []); assert.ok(fs.existsSync(f.lane));
    assert.equal(f.git(['rev-parse', 'lane/topic']), f.head);
  });
