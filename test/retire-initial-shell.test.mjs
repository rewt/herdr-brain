import test from './helpers/bounded-test.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { planRetirement, executeRetirement } from '../lib/retire.mjs';
import { recordInitialShell, initialShellFile, claimInitialShell } from '../lib/initial-shell.mjs';
import { fixture } from './helpers/retire-fixture.mjs';

function shellSnapshot(receipted = false) {
  const shell = { pid: 5, ppid: 1, pgid: 5, identity: 'shell-birth', command: '[zsh]', state: 'S' };
  const snapshot = { common: '/repo/.git',
    workspaces: [{ workspace_id: 'w', worktree: { repo_key: '/repo/.git', checkout_path: '/repo/lane', is_linked_worktree: true } }],
    tabs: [{ tab_id: 'w:t', workspace_id: 'w' }],
    panes: [{ pane_id: 'w:p', tab_id: 'w:t', workspace_id: 'w', terminal_id: 'terminal', foreground_cwd: '/repo/lane', shellOnly: true,
      process_info: { shell_pid: 5, process_tree_complete: true, process_tree: [shell], foreground_processes: [{ pid: 5, name: 'zsh' }] } }],
    agents: [], git: [{ path: '/repo/lane', common: '/repo/.git', lane: 'topic', head: 'tip', clean: true, integrated: true }],
    record: { items: [{ id: 'ENG-1', closed: { as: 'done' } }], runs: [{ id: 'R-1', item: 'ENG-1', workspace: '/repo/lane',
      started: { seq: 1 }, report: { seq: 2, outcome: 'done' }, meta: { lane: 'topic', pane: 'w:worker' } }] },
    shellEvidence: { recordRead: true, referencesRead: true }, shellClaims: [], references: [], errors: [] };
  if (receipted) snapshot.initialShells = [{ schema: 'initial-shell/v1', common: snapshot.common, cwd: '/repo/lane',
    workspace: 'w', tab: 'w:t', pane: 'w:p', terminal: 'terminal', shell: { pid: 5, identity: shell.identity, command: shell.command } }];
  return snapshot;
}

for (const receipted of [true, false]) {
  const kind = receipted ? 'recorded initial' : 'legacy inert';
  test(`${kind} shell closes after stable plan and execution observations, recording the rule and identities`, () => {
    const snapshot = shellSnapshot(receipted), before = JSON.stringify(snapshot), plan = planRetirement(snapshot), closed = [], logs = [];
    assert.equal(plan.close.length, 1);
    const result = executeRetirement(plan, { observe: () => structuredClone(snapshot), close: tab => closed.push(tab), log: row => logs.push(row) });
    assert.deepEqual(closed, ['w:t']); assert.equal(result[0].action, 'closed');
    assert.equal(result[0].rule, receipted ? 'initial-shell/v1' : 'legacy inert-shell retirement');
    assert.equal(result[0].observations.length, 2);
    assert.deepEqual(result[0].observations[0], result[0].observations[1]);
    assert.equal(logs[0].observed.terminal, 'terminal'); assert.equal(logs[0].observed.shell.identity, 'shell-birth');
    assert.equal(JSON.stringify(snapshot), before, 'planning/execution never reconstructs a launch receipt');
  });

  const cases = [
    ['second pane', s => s.panes.push({ ...s.panes[0], pane_id: 'w:q' }), /sole pane/],
    ['foreground job', s => { s.panes[0].process_info.foreground_processes = [{ pid: 9, name: 'zsh' }]; }, /foreground/],
    ['background job', s => s.panes[0].process_info.process_tree.push({ pid: 9, identity: 'child', command: '[sleep]', state: 'S' }), /another process/],
    ['raw zombie child', s => { s.panes[0].process_info.process_tree_raw = [...s.panes[0].process_info.process_tree, { pid: 9, identity: 'child', command: '[sleep]', state: 'Z' }]; }, /another process/],
    ['incomplete process inventory', s => { s.panes[0].process_info.process_tree_complete = false; }, /incomplete/],
    ['missing process identity', s => { delete s.panes[0].process_info.process_tree[0].identity; }, /foreground/],
    ['stopped shell', s => { s.panes[0].process_info.process_tree[0].state = 'T'; }, /foreground/],
    ['unknown terminal', s => { delete s.panes[0].terminal_id; }, /terminal identity/],
    ['wrong cwd', s => { s.panes[0].foreground_cwd = '/repo'; }, /cwd/],
    ['unintegrated tip', s => { s.git[0].integrated = false; s.git[0].archived = true; }, /clean and integrated/],
    ['dirty checkout', s => { s.git[0].clean = false; }, /clean and integrated/],
    ['open run', s => { s.record.runs[0].report = null; }, /open recorded run/],
    ['open chain', s => { s.record.items[0].closed = null; }, /chain is still open/],
    ['unknown record', s => { s.shellEvidence.recordRead = false; }, /were not read/],
    ['unknown references', s => { s.shellEvidence.referencesRead = false; }, /were not read/],
    ['pending reference', s => s.references.push({ kind: 'pending job', pane: 'w:p' }), /pending job reference/],
    ['recorded occupant claim', s => { s.record.runs[0].meta.pane = 'w:p'; }, /occupant claim/],
    ['agent seen during window', s => s.shellClaims.push('w:p'), /occupant claim/],
    ['native pane claim', s => { s.panes[0].agent_session = { value: 'old-session' }; }, /occupant claim/],
    ['focus', s => { s.tabs[0].focused = true; }, /focus/],
    ['protected workspace', s => { s.workspaces[0].lab_owned = true; }, /lab workspace/],
    ['wrong project', s => { s.workspaces[0].worktree.repo_key = '/other/.git'; }, /canonical repository/],
    ['HOLD', s => { s.retirementHold = 'canonical HOLD'; }, /HOLD/],
    ['read error', s => s.errors.push('process source unavailable'), /process source unavailable/],
  ];
  for (const [name, change, reason] of cases) test(`${kind} shell keeps on ${name} at planning and the close edge`, () => {
    const snapshot = shellSnapshot(receipted), plan = planRetirement(snapshot), changed = structuredClone(snapshot); change(changed);
    const fresh = planRetirement(changed);
    assert.equal(fresh.close.length, 0); assert.match(fresh.keep[0].why, reason);
    const result = executeRetirement(plan, { observe: () => changed, close: () => assert.fail('must keep') });
    assert.equal(result[0].decision, 'keep'); assert.match(result[0].why, reason);
  });

  test(`${kind} shell keeps if its identity or lane tip changes between the observations`, () => {
    for (const change of [s => { s.panes[0].terminal_id = 'replacement'; },
      s => { s.panes[0].process_info.process_tree[0].identity = 'replacement'; },
      s => { s.panes[0].process_info.shell_pid = 9; s.panes[0].process_info.process_tree[0].pid = 9; s.panes[0].process_info.foreground_processes[0].pid = 9; },
      s => { s.git[0].head = 'new-tip'; },
      s => { s.agents.push({ name: 'new agent', pane_id: 'w:p', tab_id: 'w:t', workspace_id: 'w', agent_status: 'working' }); }]) {
      const snapshot = shellSnapshot(receipted), plan = planRetirement(snapshot); change(snapshot);
      const result = executeRetirement(plan, { observe: () => snapshot, close: () => assert.fail('changed identity must keep') });
      assert.equal(result[0].action, 'skip-close');
    }
  });
}

test('a receipt is never used after a claim, and absent-chain authority requires a successful read', () => {
  const s = shellSnapshot(true); s.initialShells[0].claimed = true;
  assert.match(planRetirement(s).keep[0].why, /occupant claim/);
  const ambiguous = shellSnapshot(true); ambiguous.initialShells.push(structuredClone(ambiguous.initialShells[0]));
  assert.match(planRetirement(ambiguous).keep[0].why, /ambiguous/);
  const empty = shellSnapshot(); empty.record = { runs: [], items: [] };
  assert.equal(planRetirement(empty).close.length, 1);
  delete empty.shellEvidence.recordRead;
  assert.match(planRetirement(empty).keep[0].why, /were not read/);
});

test('creation receipts bind native identities and are never backfilled or overwritten', t => {
  const f = fixture(t), pane = { pane_id: 'w:initial', terminal_id: 'initial-terminal', foreground_cwd: f.lane };
  const created = { already_open: false, workspace: { workspace_id: 'w' }, tab: { tab_id: 'w:t', workspace_id: 'w' },
    root_pane: { pane_id: pane.pane_id, tab_id: 'w:t', workspace_id: 'w' } };
  const options = { common: f.common, cwd: f.lane, created,
    h: args => args[1] === 'get' ? { pane } : { process_info: { shell_pid: 5, foreground_processes: [{ pid: 5, name: 'zsh' }] } },
    readProcess: pid => { assert.equal(pid, 5); return { ok: true, value: { pid: 5, identity: 'birth', command: '[zsh]' } }; } };
  for (const receipt of [undefined, { ...created, already_open: true }])
    assert.equal(recordInitialShell({ ...options, created: receipt, h: () => assert.fail('must not observe old shell') }), null);
  pane.agent = 'codex'; assert.equal(recordInitialShell(options), null); delete pane.agent;
  const saved = recordInitialShell(options), file = initialShellFile(f.common, 'w:t');
  assert.equal(saved.terminal, pane.terminal_id); assert.equal(saved.common, f.common); assert.equal(saved.cwd, f.lane);
  const bytes = fs.readFileSync(file); assert.throws(() => recordInitialShell(options), /EEXIST/); assert.deepEqual(fs.readFileSync(file), bytes);
  claimInitialShell(f.common, 'w:t'); assert.equal(JSON.parse(fs.readFileSync(file)).claimed, true);
  assert.deepEqual(fs.readFileSync(f.eventFile, 'utf8'), f.eventBytes);
});

for (const receipted of [true, false]) test(`runtime closes a ${receipted ? 'recorded' : 'legacy'} last shell while leaving workspace removal separate`, t => {
  const f = fixture(t), state = f.read(), shell = { pid: 5, identity: 'birth', command: '[zsh]', state: 'S' };
  state.agents = []; state.panes = [{ pane_id: 'w:initial', tab_id: 'w:t', workspace_id: 'w', terminal_id: 'initial-terminal', foreground_cwd: f.lane }];
  state.info = { shell_pid: 5, foreground_processes: [{ pid: 5, name: 'zsh' }], process_tree_complete: true, process_tree: [shell] };
  fs.writeFileSync(f.file, JSON.stringify(state));
  if (receipted) recordInitialShell({ common: f.common, cwd: f.lane,
    created: { already_open: false, workspace: { workspace_id: 'w' }, tab: state.tabs[0], root_pane: state.panes[0] },
    h: args => args[1] === 'get' ? { pane: state.panes[0] } : { process_info: state.info } });
  const retirement = f.retirement(), result = retirement.apply(retirement.plan());
  assert.equal(result[0].action, 'closed'); assert.equal(result[0].observations.length, 2);
  assert.deepEqual(f.read().actions, [['tab', 'close', 'w:t']]);
  assert.equal(f.read().workspaces.length, 1); assert.ok(fs.existsSync(f.lane));
  assert.equal(fs.readFileSync(f.eventFile, 'utf8'), f.eventBytes);
});

test('runtime remembers an agent observed in the window after its registry entry disappears', t => {
  const f = fixture(t), state = f.read();
  state.panes[0] = { ...state.panes[0], pane_id: 'w:initial', terminal_id: 'initial-terminal', foreground_cwd: f.lane };
  state.agents[0] = { ...state.agents[0], pane_id: 'w:initial', terminal_id: 'initial-terminal' };
  state.info = { shell_pid: 5, foreground_processes: [{ pid: 5, name: 'zsh' }], process_tree_complete: true,
    process_tree: [{ pid: 5, identity: 'birth', command: '[zsh]', state: 'S' }] };
  fs.writeFileSync(f.file, JSON.stringify(state));
  const retirement = f.retirement(); retirement.observe();
  state.agents = []; fs.writeFileSync(f.file, JSON.stringify(state));
  const plan = retirement.plan(); assert.equal(plan.close.length, 0); assert.match(plan.keep[0].why, /occupant claim/);
  assert.deepEqual(f.read().actions, []);
});
