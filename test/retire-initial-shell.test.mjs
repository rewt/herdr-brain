import test from './helpers/bounded-test.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { planRetirement, executeRetirement } from '../lib/retire.mjs';
import { recordInitialShell, initialShellFile, claimInitialShell, recordLaneOpen, initialShellLock } from '../lib/initial-shell.mjs';
import { fixture, hold, isolatedEnv } from './helpers/retire-fixture.mjs';
import { createHousekeeping } from '../housekeeping/housekeeping.mjs';
import { fileURLToPath } from 'node:url';

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
  for (const history of ['fresh', 'unknown', undefined]) {
    empty.git[0].initialShellHistory = history;
    assert.match(planRetirement(empty).keep[0].why, /no terminal chain/);
  }
  empty.git[0].initialShellHistory = 'progressed';
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
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.throws(() => claimInitialShell(f.common, 'missing'), /receipt is missing/);
  assert.deepEqual(fs.readFileSync(f.eventFile, 'utf8'), f.eventBytes);
});

function initialFixture(t) {
  const f = fixture(t), state = f.read();
  state.agents = []; state.panes = [{ pane_id: 'w:initial', tab_id: 'w:t', workspace_id: 'w', terminal_id: 'initial-terminal', foreground_cwd: f.lane }];
  state.info = { shell_pid: 5, foreground_processes: [{ pid: 5, name: 'zsh' }], process_tree_complete: true,
    process_tree: [{ pid: 5, identity: 'birth', command: '[zsh]', state: 'S' }] };
  const save = () => fs.writeFileSync(f.file, JSON.stringify(state)); save();
  const record = (extra = {}) => recordInitialShell({ common: f.common, cwd: f.lane,
    created: { already_open: false, workspace: { workspace_id: 'w' }, tab: state.tabs[0], root_pane: state.panes[0] },
    h: args => args[1] === 'get' ? { pane: state.panes[0] } : { process_info: state.info }, ...extra });
  return { ...f, state, save, record, receiptFile: initialShellFile(f.common, 'w:t') };
}

test('housekeeping during the dispatch receipt-to-claim window keeps the already claimed shell', t => {
  const f = initialFixture(t); isolatedEnv(t, f);
  const retirement = f.retirement(), stalePlan = retirement.plan(), unlock = initialShellLock(f.common, 'w:t');
  assert.equal(stalePlan.close.length, 1);
  try {
    f.record({ claimed: true, locked: true });
    const runner = createHousekeeping({ cwd: f.repo, org: f.org, herdr: f.env.HERDR_RETIRE_HERDR, selfTab: null,
      record: [process.execPath, fileURLToPath(new URL('../bin/org.mjs', import.meta.url))] });
    const plan = runner.tick({ resume: false });
    assert.equal(plan.close.length, 0); assert.match(plan.keep[0].why, /occupant claim/);
    assert.deepEqual(f.read().actions, []); assert.equal(JSON.parse(fs.readFileSync(f.receiptFile)).claimed, true);
    const stale = retirement.apply(stalePlan); assert.match(stale[0].why, /locked:/);
    assert.deepEqual(f.read().actions, [], 'a stale pre-dispatch plan cannot cross the shared tab lock');
  } finally { unlock(); }
});

for (const receipted of [true, false]) test(`${receipted ? 'recorded' : 'legacy'} creation-only shell needs a terminal lane chain`, t => {
  const f = initialFixture(t); if (receipted) f.record();
  const base = f.git(['rev-parse', 'lane/topic@{1}']);
  f.git(['reset', '--hard', base], f.lane); recordLaneOpen(f.common, f.lane, base);
  fs.writeFileSync(f.eventFile, '');
  const retirement = f.retirement(), plan = retirement.plan();
  assert.equal(plan.close.length, 0); assert.match(plan.keep[0].why, /no terminal chain.*fresh or unknown/);
  retirement.apply(plan); assert.deepEqual(f.read().actions, []);
  // Explicit terminal disposition can authorize a fresh lane; it is not age
  // or the mere fact that its base is already integrated.
  fs.writeFileSync(f.eventFile, f.eventBytes);
  assert.equal(retirement.plan().close.length, 1);
});

test('a creation-only legacy reflog keeps without a lane-open sidecar', t => {
  const f = initialFixture(t);
  f.git(['worktree', 'add', '-b', 'lane/fresh', path.join(f.scratch, 'fresh')]);
  const fresh = path.join(f.scratch, 'fresh');
  f.state.workspaces[0].worktree.checkout_path = fresh; f.state.panes[0].foreground_cwd = fresh; f.save();
  fs.writeFileSync(f.eventFile, '');
  const snapshot = f.retirement().observe();
  assert.equal(snapshot.git[0].initialShellHistory, 'fresh');
  assert.match(planRetirement(snapshot).keep[0].why, /no terminal chain/);
});

test('a native tab ID may be reused only through a new creation identity; receipt writes are atomic and private', t => {
  const f = initialFixture(t); f.record({ claimed: true });
  const before = fs.readFileSync(f.receiptFile), rename = fs.renameSync;
  f.state.panes[0].terminal_id = 'new-terminal'; f.state.info.process_tree[0].identity = 'new-birth';
  fs.renameSync = (from, to) => {
    if (to === path.basename(f.receiptFile)) {
      assert.deepEqual(fs.readFileSync(to), before, 'old complete receipt stays visible until rename');
      throw Error('injected atomic publication failure');
    }
    return rename(from, to);
  };
  try { assert.throws(() => f.record(), /atomic publication failure/); }
  finally { fs.renameSync = rename; }
  assert.deepEqual(fs.readFileSync(f.receiptFile), before);
  f.record(); const next = JSON.parse(fs.readFileSync(f.receiptFile));
  assert.equal(next.terminal, 'new-terminal'); assert.equal(next.shell.identity, 'new-birth');
  assert.equal(next.claimed, undefined); assert.equal(fs.statSync(f.receiptFile).mode & 0o777, 0o600);
  assert.deepEqual(fs.readdirSync(path.dirname(f.receiptFile)), [path.basename(f.receiptFile)]);
});

test('a failed first atomic receipt publication leaves no truncated target or temporary file', t => {
  const f = initialFixture(t), rename = fs.renameSync;
  fs.renameSync = (from, to) => {
    if (to === path.basename(f.receiptFile)) {
      assert.equal(fs.existsSync(to), false); throw Error('injected first publication failure');
    }
    return rename(from, to);
  };
  try { assert.throws(() => f.record(), /first publication failure/); }
  finally { fs.renameSync = rename; }
  assert.equal(fs.existsSync(f.receiptFile), false);
  assert.deepEqual(fs.readdirSync(path.dirname(f.receiptFile)), []);
});

test('initial receipts are pruned after close or freshly verified absence, with HOLD and reappearance checks', t => {
  const f = initialFixture(t); f.record();
  const retirement = f.retirement();
  retirement.apply(retirement.plan()); assert.equal(fs.existsSync(f.receiptFile), false, 'closed tab receipt is pruned');
  f.save(); f.record();
  const liveState = structuredClone(f.state);
  f.state.tabs = []; f.state.panes = []; f.save();
  const snapshot = retirement.observe(); assert.ok(fs.existsSync(f.receiptFile), 'observe is read-only');
  fs.writeFileSync(f.file, JSON.stringify(liveState));
  retirement.apply(planRetirement(snapshot), undefined, snapshot);
  assert.ok(fs.existsSync(f.receiptFile), 'fresh native reappearance prevents stale absence pruning');
  f.save(); const old = retirement.observe();
  fs.writeFileSync(f.receiptFile, JSON.stringify({ ...JSON.parse(fs.readFileSync(f.receiptFile)), claimed: true }));
  retirement.apply(planRetirement(old), undefined, old);
  assert.ok(fs.existsSync(f.receiptFile), 'a newer receipt is not erased using old observed contents');
  f.save(); const clear = hold(f); retirement.apply(retirement.plan());
  assert.ok(fs.existsSync(f.receiptFile)); clear();
  retirement.apply(retirement.plan()); assert.equal(fs.existsSync(f.receiptFile), false);
});

test('malformed initial receipts keep only their filename-bound tab while another tab retires', t => {
  const f = initialFixture(t); f.record();
  fs.writeFileSync(f.receiptFile, '{truncated');
  f.state.tabs.push({ tab_id: 'w:other', workspace_id: 'w' });
  f.state.panes.push({ ...f.state.panes[0], pane_id: 'w:other:p', tab_id: 'w:other', terminal_id: 'other-terminal' }); f.save();
  const retirement = f.retirement(), snapshot = retirement.observe(), plan = planRetirement(snapshot);
  assert.deepEqual(snapshot.errors, []); assert.equal(plan.keep.length, 1);
  assert.equal(plan.keep[0].tab_id, 'w:t'); assert.match(plan.keep[0].why, /malformed or unreadable/);
  assert.deepEqual(plan.close.map(row => row.tab_id), ['w:other']);
  assert.equal(retirement.apply(plan)[0].action, 'closed');
  assert.deepEqual(f.read().tabs.map(tab => tab.tab_id), ['w:t']);
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
