import test from './helpers/bounded-test.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { planRetirement, executeRetirement } from '../lib/retire.mjs';
import { recordInitialShell, initialShellFile, claimInitialShell, recordLaneOpen, initialShellLock } from '../lib/initial-shell.mjs';
import { fixture, hold, isolatedEnv } from './helpers/retire-fixture.mjs';
import { createHousekeeping } from '../housekeeping/housekeeping.mjs';
import { retirementDeadline } from '../lib/retire-lock.mjs';
import { fileURLToPath } from 'node:url';
import { readLiveReferences, readDeclaredReferences } from '../lib/retire-runtime.mjs';

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

function terminalClaimSnapshot(receipted = false) {
  const s = shellSnapshot(receipted);
  Object.assign(s.record.runs[0].meta, { pane: 'w:p', terminal_id: 'terminal' });
  return s;
}

for (const receipt of ['legacy', 'unclaimed', 'claimed']) for (const disposition of ['reported', 'abandoned'])
  test(`${receipt} shell releases a ${disposition} worker's stored claim after self-exit`, () => {
    const s = terminalClaimSnapshot(receipt !== 'legacy'), closed = [];
    if (receipt === 'claimed') s.initialShells[0].claimed = true;
    if (disposition === 'abandoned') { s.record.runs[0].report = null; s.record.runs[0].abandoned = { seq: 2 }; }
    const plan = planRetirement(s); assert.equal(plan.close.length, 1);
    assert.equal(executeRetirement(plan, { observe: () => structuredClone(s), close: tab => closed.push(tab) })[0].action, 'closed');
    assert.deepEqual(closed, ['w:t']);
  });

const claimProtections = [
  ['unreported run', s => { s.record.runs[0].report = null; }],
  ['another unreported claimant', s => s.record.runs.push({ id: 'R-2', item: 'ENG-1', meta: { terminal_id: 'terminal' } })],
  ['report without record sequence', s => { delete s.record.runs[0].report.seq; }],
  ['conflicting identity', s => { s.record.sessionBindings = { 'R-1': [{ seq: 3 }] }; }],
  ['live process', s => s.panes[0].process_info.process_tree.push({ pid: 9, identity: 'worker', state: 'S', command: '[codex]' })],
  ['agent using the terminal', s => s.agents.push({ name: 'worker', pane_id: 'other:p', tab_id: 'other:t', terminal_id: 'terminal', agent_status: 'working' })],
  ['live callback receipt', s => { s.callbacks = [{ tab: 'other:t', pane: 'w:p', process_gone: false }]; }],
  ['exit receipt with conflicting topology', s => { s.exits = [{ tab: 'other:t', pane: 'w:p' }]; }],
  ['terminal reference', s => s.references.push({ kind: 'pending callback', terminal_id: 'terminal' })],
  ['run reference', s => s.references.push({ kind: 'pending callback', run: 'R-1' })],
  ['unread process tree', s => { s.panes[0].process_info.process_tree_complete = false; }],
  ['unread references', s => { s.shellEvidence.referencesRead = false; }],
  ['open chain', s => { delete s.record.items[0].closed; }],
  ['unmerged lane', s => { s.git[0].integrated = false; }],
  ['dirty lane', s => { s.git[0].clean = false; }],
  ['focus', s => { s.tabs[0].focused = true; }],
  ['operator workspace', s => { s.workspaces[0].operator = true; }],
  ['adopted slot', s => { s.standardSlots = { schema: 'standard-slot-history/v1', errors: [], slots: [{
    common: s.common, uid: 'chat', server: 'default', workspace: 'w', checkout: '/repo/lane', tab: 'w:t',
    standardSlot: 'chat', panes: [{ pane: 'w:p', paneSlot: 'primary' }] }] }; }],
  ['HOLD', s => { s.retirementHold = 'canonical HOLD'; }],
];
for (const claimed of [false, true]) for (const [name, change] of claimProtections) test(`a ${claimed ? 'claimed' : 'unclaimed'} receipt with a terminal stored claim still keeps on ${name}, including at the close edge`, () => {
  const s = terminalClaimSnapshot(true);
  if (claimed) s.initialShells[0].claimed = true;
  const plan = planRetirement(s); change(s);
  assert.equal(plan.close.length, 1); assert.equal(planRetirement(s).close.length, 0);
  const result = executeRetirement(plan, { observe: () => s, close: () => assert.fail('claim protection must keep') });
  assert.equal(result[0].action, name === 'HOLD' ? 'held' : 'skip-close');
});

for (const claimed of [false, true]) test(`a terminal record claim with a ${claimed ? 'claimed' : 'unclaimed'} receipt never restores the pristine-tab exception in an open dirty lane`, () => {
  const s = openLaneSnapshot();
  if (claimed) s.initialShells[0].claimed = true;
  s.record.runs.push({ id: 'R-2', item: 'ENG-1', workspace: '/repo/lane', started: { seq: 3 },
    report: { seq: 4, outcome: 'done' }, meta: { pane: 'w:p', terminal_id: 'terminal' } });
  assert.equal(targetDecision(planRetirement(s)).decision, 'keep');
});

for (const match of ['pane-only', 'terminal-only', 'neither']) test(`a claimed receipt keeps a ${match} run identity match`, () => {
  const s = terminalClaimSnapshot(true); s.initialShells[0].claimed = true;
  if (match !== 'pane-only') s.record.runs[0].meta.pane = 'other:p';
  if (match !== 'terminal-only') s.record.runs[0].meta.terminal_id = 'other-terminal';
  const plan = planRetirement(s);
  assert.equal(plan.close.length, 0); assert.match(plan.keep[0].why, /occupant claim/);
});

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
    ['unreported occupant claim', s => { s.record.runs[0].meta.pane = 'w:p'; s.record.runs[0].report = null; }, /occupant claim/],
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

test('a claimed receipt without a matching run keeps, and absent-chain authority requires a successful read', () => {
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

function selfExitedFixture(t, disposition, claimed) {
  const f = initialFixture(t), events = f.eventBytes.trim().split('\n').map(JSON.parse);
  if (claimed) {
    f.record(); claimInitialShell(f.common, 'w:t');
    assert.equal(JSON.parse(fs.readFileSync(f.receiptFile)).claimed, true);
  }
  // Model record worker's stored identity update, followed by terminal evidence.
  const launch = events[1].meta;
  events[1].meta = { lane: 'topic' };
  events.splice(2, 0, { type: 'run.updated', id: 'R-1', meta: { ...launch,
    pane: 'w:initial', terminal_id: 'initial-terminal' } });
  if (disposition === 'abandoned') events[3] = { type: 'run.abandoned', id: 'R-1', note: 'self-exited; lane already integrated' };
  if (disposition === 'unreported') events.splice(3, 1);
  const bytes = events.map((e, i) => JSON.stringify({ ...e, seq: i + 1, at: '2026-01-01T00:00:00Z', by: 'test' }) + '\n').join('');
  fs.writeFileSync(f.eventFile, bytes);
  return { ...f, bytes };
}

for (const claimed of [false, true]) for (const disposition of ['reported', 'abandoned']) test(`CLI closes a landed lane after its ${disposition} recorded worker self-exits ${claimed ? 'with a claimed creation receipt' : 'without a creation receipt'}`, t => {
  const f = selfExitedFixture(t, disposition, claimed);
  const snapshot = f.retirement().observe(f.lane);
  if (claimed) assert.equal(snapshot.initialShells[0].claimed, true);
  assert.equal(snapshot.record.workerReceipts['R-1'].pane, 'w:initial');
  assert.deepEqual(snapshot.agents, []); assert.deepEqual(snapshot.exits, []);
  const r = f.close(false); assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(fs.existsSync(f.lane), false); assert.equal(f.git(['branch', '--list', 'lane/topic']), '');
  assert.ok(f.read().actions.some(a => a[0] === 'tab' && a[1] === 'close'));
  assert.equal(fs.readFileSync(f.eventFile, 'utf8'), f.bytes);
});

for (const reason of ['unreported', 'live process', 'HOLD']) test(`CLI retains a claimed creation receipt and its lane on ${reason}`, t => {
  const f = selfExitedFixture(t, reason === 'unreported' ? 'unreported' : 'reported', true);
  if (reason === 'live process') {
    f.state.info.process_tree.push({ pid: 9, ppid: 5, identity: 'worker', state: 'S', command: '[codex]' }); f.save();
  }
  if (reason === 'HOLD') hold(f);
  const bytes = fs.readFileSync(f.eventFile, 'utf8'), r = f.close(false);
  assert.notEqual(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stderr, reason === 'unreported' ? /occupant claim/ : reason === 'HOLD' ? /retirement held/ : /another process/);
  assert.equal(fs.existsSync(f.lane), true); assert.equal(f.git(['rev-parse', 'lane/topic']), f.head);
  assert.equal(JSON.parse(fs.readFileSync(f.receiptFile)).claimed, true);
  assert.deepEqual(f.read().actions, []); assert.equal(fs.readFileSync(f.eventFile, 'utf8'), bytes);
});

for (const claimed of [false, true]) test(`housekeeping during the dispatch receipt-to-claim window cannot close the locked initial shell (claimed: ${claimed})`, t => {
  const f = initialFixture(t); isolatedEnv(t, f);
  const retirement = f.retirement(), stalePlan = retirement.plan(), unlock = initialShellLock(f.common, 'w:t');
  assert.equal(stalePlan.close.length, 1);
  try {
    f.record({ claimed, locked: true });
    const runner = createHousekeeping({ cwd: f.repo, org: f.org, herdr: f.env.HERDR_RETIRE_HERDR, selfTab: null,
      record: [process.execPath, fileURLToPath(new URL('../bin/org.mjs', import.meta.url))] });
    const plan = runner.tick({ resume: false });
    assert.equal(plan.close.length, claimed ? 0 : 1);
    if (claimed) assert.match(plan.keep[0].why, /occupant claim/);
    assert.deepEqual(f.read().actions, []); assert.equal(JSON.parse(fs.readFileSync(f.receiptFile)).claimed, claimed ? true : undefined);
    const stale = retirement.apply(stalePlan); assert.match(stale[0].why, /locked:/);
    assert.deepEqual(f.read().actions, [], 'a stale pre-dispatch plan cannot cross the shared tab lock');
    claimInitialShell(f.common, 'w:t', { locked: true });
    const claimedPlan = retirement.plan(); assert.equal(claimedPlan.close.length, 0); assert.match(claimedPlan.keep[0].why, /occupant claim/);
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

for (const failure of ['tab lock', 'Herdr listing', 'unlink', 'deadline']) test(`pre-execution initial receipt pruning handles ${failure} without bypassing retirement guards`, t => {
  const f = initialFixture(t); f.record();
  f.state.tabs = [{ tab_id: 'w:other', workspace_id: 'w' }];
  f.state.panes = [{ ...f.state.panes[0], tab_id: 'w:other', pane_id: 'w:other:p', terminal_id: 'other-terminal' }]; f.save();
  const logs = []; let failPrune = false;
  const retirement = f.retirement({ log: row => logs.push(row), command(exe, args, options) {
    if (failPrune && exe === f.job.herdr && args[0] === 'workspace' && args[1] === 'list') {
      failPrune = false;
      if (failure === 'deadline') throw retirementDeadline();
      return { status: 1, stderr: 'injected pruning listing failure' };
    }
    return spawnSync(exe, args, options);
  } });
  const snapshot = retirement.observe(), plan = planRetirement(snapshot), unlink = fs.unlinkSync;
  assert.deepEqual(plan.close.map(row => row.tab_id), ['w:other']);
  assert.equal(snapshot.initialPruning[0].absent, true);
  const unlock = failure === 'tab lock' ? initialShellLock(f.common, 'w:t') : null;
  if (failure === 'unlink') fs.unlinkSync = file => {
    if (file === f.receiptFile) throw Object.assign(Error('injected pruning unlink failure'), { code: 'EACCES' });
    return unlink(file);
  };
  failPrune = failure === 'Herdr listing' || failure === 'deadline';
  try {
    if (failure === 'deadline') {
      assert.throws(() => retirement.apply(plan, undefined, snapshot), { code: 'RETIREMENT_DEADLINE' });
      assert.deepEqual(f.read().actions, [], 'a deadline still stops the pass');
      assert.deepEqual(retirement.diagnostics, []);
    } else {
      const results = retirement.apply(plan, undefined, snapshot);
      assert.equal(results[0].action, 'closed');
      assert.deepEqual(f.read().actions, [['tab', 'close', 'w:other']]);
      const diagnostic = retirement.diagnostics.find(row => row.action === 'receipt-pruning-diagnostic');
      assert.equal(diagnostic.file, f.receiptFile); assert.equal(diagnostic.tab_id, 'w:t');
      assert.match(diagnostic.reason, /locked:|injected pruning/);
      assert.ok(logs.includes(diagnostic), 'the pruning failure is logged');
    }
    assert.ok(fs.existsSync(f.receiptFile), 'failed pruning retains the receipt');
  } finally { fs.unlinkSync = unlink; unlock?.(); }
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

function openLaneSnapshot() {
  const s = shellSnapshot(true), run = s.record.runs[0];
  s.git[0].clean = false; s.git[0].integrated = false;
  delete s.record.items[0].closed; delete run.report;
  run.meta = { lane: 'topic', agent: 'worker', pane: 'w:worker', worker_workspace: 'w', terminal_id: 'worker-terminal', agent_session_id: 'worker-session' };
  s.tabs.push({ tab_id: 'w:t2', workspace_id: 'w' });
  s.panes.push({ pane_id: 'w:worker', tab_id: 'w:t2', workspace_id: 'w', terminal_id: 'worker-terminal', shellOnly: false,
    process_info: { shell_pid: 10, process_tree_complete: true,
      process_tree: [{ pid: 10, ppid: 1, identity: 'worker-shell', command: '[zsh]', state: 'S' },
        { pid: 20, ppid: 10, identity: 'worker-process', command: '[codex]', state: 'S' }],
      foreground_processes: [{ pid: 20, name: 'codex' }] } });
  s.agents.push({ name: 'worker', agent: 'codex', agent_status: 'working', pane_id: 'w:worker', tab_id: 'w:t2', workspace_id: 'w',
    cwd: '/repo/lane', terminal_id: 'worker-terminal', agent_session: { value: 'worker-session' }, state_change_seq: 3 });
  s.removal = { cwd: '/repo/lane', branch: 'lane/topic', tip: 'tip' };
  return s;
}
const targetDecision = plan => [...plan.close, ...plan.keep].find(t => t.tab_id === 'w:t');

test('pristine creation tab alone releases in an open dirty unmerged lane, retaining the agent and every lane-removal guard', () => {
  const s = openLaneSnapshot();
  s.references = [{ kind: 'sibling callback', run: 'R-1', pane: 'w:worker', tab: 'w:t2', terminal: 'worker-terminal' },
    { kind: 'lane job', item: 'ENG-1', lane: 'topic', cwd: '/repo/lane' }, { kind: 'lane head', head: 'tip' }];
  const before = JSON.stringify(s), plan = planRetirement(s), closed = [], logs = [];
  assert.deepEqual(plan.close.map(t => t.tab_id), ['w:t']); assert.deepEqual(plan.keep.map(t => t.tab_id), ['w:t2']);
  assert.equal(plan.close[0].rule, 'pristine-first-tab/v1'); assert.deepEqual(plan.close[0].receipt, s.initialShells[0]);
  assert.equal(plan.close[0].observed.shell.identity, 'shell-birth');
  assert.equal(plan.close[0].survivor.run, 'R-1'); assert.equal(plan.close[0].survivor.agent, 'worker');
  assert.equal(plan.close[0].survivor.tab, 'w:t2'); assert.equal(plan.close[0].survivor.pane, 'w:worker');
  assert.equal(plan.close[0].survivor.terminal, 'worker-terminal'); assert.equal(plan.close[0].survivor.session, 'worker-session');
  assert.equal(plan.laneClose.length, 0); assert.match(plan.laneKeep[0].why, /open recorded run/);
  assert.deepEqual(plan.workspaceClose ?? [], []); assert.deepEqual(plan.sessionReleases ?? [], []);
  const result = executeRetirement(plan, { observe: () => structuredClone(s), close: tab => closed.push(tab),
    exit: () => assert.fail('tab-only action must not exit an agent'), removeLane: () => assert.fail('must retain lane'),
    closeWorkspace: () => assert.fail('must retain workspace'), log: row => logs.push(row) });
  assert.deepEqual(closed, ['w:t']); assert.equal(result[0].action, 'closed');
  assert.deepEqual(logs[0].receipt, s.initialShells[0]); assert.deepEqual(logs[0].survivor, plan.close[0].survivor);
  assert.deepEqual(result[0].observations, [plan.close[0].observed, plan.close[0].observed]);
  assert.equal(JSON.stringify(s), before, 'the exception cannot change items or its authority inputs');
  s.tabs.shift(); s.panes.shift();
  const after = planRetirement(s);
  assert.equal(after.laneClose.length, 0); assert.equal(after.laneKeep[0].why, plan.laneKeep[0].why);
  assert.deepEqual(after.workspaceClose ?? [], []); assert.deepEqual(after.close, []);
});

const pristineRefusals = [
  ['no creation receipt', s => { delete s.initialShells; }],
  ['claimed receipt', s => { s.initialShells[0].claimed = true; }],
  ['ambiguous receipt', s => s.initialShells.push(structuredClone(s.initialShells[0]))],
  ['unknown receipt schema', s => { s.initialShells[0].schema = 'other/v1'; }],
  ['second target pane', s => s.panes.push({ ...s.panes[0], pane_id: 'w:split' })],
  ['child process', s => s.panes[0].process_info.process_tree.push({ pid: 9, identity: 'job', command: '[sleep]', state: 'S' })],
  ['foreground job', s => { s.panes[0].process_info.foreground_processes = [{ pid: 9, name: 'sleep' }]; }],
  ['raw zombie child', s => { s.panes[0].process_info.process_tree_raw = [...s.panes[0].process_info.process_tree, { pid: 9, command: '[sleep]', state: 'Z', identity: 'job' }]; }],
  ['incomplete process tree', s => { s.panes[0].process_info.process_tree_complete = false; }],
  ['unknown terminal observation', s => { s.panes[0].shellObservationError = 'unreadable'; }],
  ['ambiguous terminal ownership', s => s.panes.push({ pane_id: 'w:other', tab_id: 'w:t2', workspace_id: 'w', terminal_id: 'terminal' })],
  ['unread record', s => { s.shellEvidence.recordRead = false; }],
  ['unread references', s => { s.shellEvidence.referencesRead = false; }],
  ['launch reservation', s => { s.panes[0].launch_pending = true; }],
  ['native pane claim', s => { s.panes[0].name = 'operator shell'; }],
  ['remembered claim', s => s.shellClaims.push('w:p')],
  ['run pane claim', s => s.record.runs.push({ id: 'R-2', meta: { pane: 'w:p' } })],
  ['run terminal claim', s => s.record.runs.push({ id: 'R-2', meta: { terminal_id: 'terminal' } })],
  ['missing agent', s => { s.agents = []; }],
  ['missing survivor pane', s => { s.panes.pop(); }],
  ['last tab', s => { s.tabs.pop(); }],
  ['unrecorded survivor', s => { s.record.runs[0].meta.agent_session_id = 'unknown'; }],
  ['survivor from another lane', s => { s.record.runs[0].meta.lane = 'other'; }],
  ['survivor in another workspace', s => {
    s.tabs[1].workspace_id = 'other'; s.panes[1].workspace_id = 'other'; s.agents[0].workspace_id = 'other';
    s.record.runs[0].meta.worker_workspace = 'other';
    s.workspaces.push({ ...s.workspaces[0], workspace_id: 'other' });
  }],
  ['survivor process gone', s => { s.panes[1].shellOnly = true; }],
  ['survivor topology disagreement', s => { s.panes[1].terminal_id = 'unknown'; }],
  ['ambiguous survivor agent', s => s.agents.push({ ...s.agents[0], name: 'duplicate' })],
  ['HOLD', s => { s.retirementHold = 'canonical HOLD'; }],
  ['operator tab focus', s => { s.tabs[0].focused = true; }],
  ['operator pane focus', s => { s.panes[0].focused = true; }],
  ['protected workspace', s => { s.workspaces[0].persistent = true; }],
  ['operator workspace', s => { s.workspaces[0].operator = true; }],
  ['lab workspace', s => { s.labWorkspaces = ['w']; }],
];
for (const [name, change] of pristineRefusals) test(`pristine tab keeps on ${name} in planning and at the close edge`, () => {
  const s = openLaneSnapshot(), plan = planRetirement(s), changed = structuredClone(s); change(changed);
  assert.equal(targetDecision(plan).decision, 'release'); assert.equal(targetDecision(planRetirement(changed)).decision, 'keep');
  const result = executeRetirement(plan, { observe: () => changed, close: () => assert.fail('must keep target') });
  assert.equal(result[0].decision, 'keep'); assert.equal(result[0].action, name === 'HOLD' ? 'held' : 'skip-close');
  assert.equal(result[0].rule, 'pristine-first-tab/v1'); assert.deepEqual(result[0].receipt, plan.close[0].receipt);
});

for (const field of ['common', 'cwd', 'workspace', 'tab', 'pane', 'terminal', 'shell.pid', 'shell.identity', 'shell.command'])
  test(`pristine tab keeps with mismatched receipt ${field}`, () => {
    const s = openLaneSnapshot(), plan = planRetirement(s), changed = structuredClone(s), [key, subkey] = field.split('.');
    if (subkey) changed.initialShells[0][key][subkey] = subkey === 'pid' ? 99 : 'different';
    else changed.initialShells[0][key] = 'different';
    assert.equal(targetDecision(planRetirement(changed)).decision, 'keep');
    assert.equal(executeRetirement(plan, { observe: () => changed, close: () => assert.fail('receipt must bind target') })[0].action, 'skip-close');
  });

for (const reference of [
  { pane: 'w:p' }, { tab: 'w:t' }, { terminal: 'terminal' }, { pane_id: 'w:p' }, { tab_id: 'w:t' }, { terminal_id: 'terminal' },
  { global: true }, { item: 'ENG-1' }, { run: 'unknown', cwd: '/repo/lane' }, { pane: 'unknown', lane: 'topic' },
  { terminal: 'unknown', run: 'R-1' }, { tab: 'unknown', lane: 'topic' }, { pane: 'w:worker', tab: 'w:t' }, {},
]) test(`pristine tab keeps a target or unclear reference ${JSON.stringify(reference)}`, () => {
  const s = openLaneSnapshot(), plan = planRetirement(s), changed = structuredClone(s);
  changed.references.push({ kind: 'pending job', ...reference });
  assert.equal(targetDecision(planRetirement(changed)).decision, 'keep');
  const result = executeRetirement(plan, { observe: () => changed, close: () => assert.fail('must keep target') });
  assert.equal(result[0].action, 'skip-close'); assert.equal(result[0].decision, 'keep');
});

test('pristine references keep contradictory native owners even within the same surviving tab', () => {
  const s = openLaneSnapshot();
  s.panes.push({ pane_id: 'w:other', tab_id: 'w:t2', workspace_id: 'w', terminal_id: 'other-terminal' });
  s.references.push({ pane: 'w:worker', terminal: 'other-terminal' });
  assert.equal(targetDecision(planRetirement(s)).decision, 'keep');
});

test('pristine reference adapter preserves queued native identities and rejects malformed declared tab or terminal scopes', t => {
  const f = fixture(t), directory = path.join(f.common, 'promote'); fs.mkdirSync(directory, { recursive: true });
  for (const native of [{ tab: 'w:t' }, { terminal: 'terminal' }, { tab_id: 'w:t' }, { terminal_id: 'terminal' },
    { pane: 'w:worker', pane_id: 'w:p' }, { terminal: 'worker-terminal', terminal_id: 'terminal' }]) {
    fs.writeFileSync(path.join(directory, 'queue.json'), JSON.stringify({ identity: f.common, pending: [{ id: 'job', lane: 'topic', ...native }], results: [] }));
    const refs = readLiveReferences({ common: f.common, org: f.org, env: f.env });
    assert.deepEqual(refs.errors, []);
    for (const [key, value] of Object.entries(native)) assert.equal(refs.references[0][key], value);
    const s = openLaneSnapshot(); s.references = refs.references;
    assert.equal(targetDecision(planRetirement(s)).decision, 'keep');
  }
  for (const scope of ['tab', 'terminal', 'tab_id', 'terminal_id']) {
    fs.writeFileSync(path.join(f.org, 'references/job.json'), JSON.stringify({ schema: 'herdr-reference/v1', state: 'running',
      owner: 'test', kind: 'pending job', job: 'job', item: 'ENG-1', [scope]: 7,
      created_at: '2026-01-01T00:00:00Z', expires_at: '2999-01-01T00:00:00Z' }));
    const refs = readDeclaredReferences(f.org);
    assert.equal(refs.references.length, 0); assert.match(refs.errors[0], /invalid herdr-reference.*project kept/);
  }
});

for (const change of ['terminal', 'pane', 'tab', 'session', 'agent', 'process', 'status-sequence'])
  test(`pristine token binds a still-eligible survivor's ${change}`, () => {
    const s = openLaneSnapshot(), plan = planRetirement(s), changed = structuredClone(s), agent = changed.agents[0], run = changed.record.runs[0];
    if (change === 'terminal') { agent.terminal_id = changed.panes[1].terminal_id = run.meta.terminal_id = 'new-terminal'; }
    if (change === 'pane') { agent.pane_id = changed.panes[1].pane_id = run.meta.pane = 'w:new-pane'; }
    if (change === 'tab') { agent.tab_id = changed.panes[1].tab_id = changed.tabs[1].tab_id = 'w:new-tab'; }
    if (change === 'session') { agent.agent_session.value = run.meta.agent_session_id = 'new-session'; }
    if (change === 'agent') { agent.name = run.meta.agent = 'new-agent'; }
    if (change === 'process') changed.panes[1].process_info.process_tree[1].identity = 'new-birth';
    if (change === 'status-sequence') agent.state_change_seq++;
    const fresh = targetDecision(planRetirement(changed));
    assert.equal(fresh.rule, 'pristine-first-tab/v1'); assert.notEqual(fresh.token, targetDecision(plan).token);
    const result = executeRetirement(plan, { observe: () => changed, close: () => assert.fail('survivor changed') });
    assert.equal(result[0].action, 'skip-close'); assert.match(result[0].why, /authority changed/);
  });

for (const exit of [false, true]) test(`pristine tab cannot borrow an agent tab scheduled for ${exit ? 'exit' : 'release'}`, () => {
  const s = openLaneSnapshot(); s.agents[0].agent_status = 'idle'; s.record.runs[0].report = { seq: 2, outcome: 'done' };
  s.releases = [{ run: 'R-1', confirmed: true, pane: 'w:worker', terminal: 'worker-terminal', session: 'worker-session', workspace: 'w', cwd: '/repo/lane', head: 'tip', seq: 4 }];
  if (exit) s.panes[1].process_info.process_tree.push({ pid: 30, ppid: 20, identity: 'helper', command: '[node]', state: 'S' });
  const plan = planRetirement(s);
  assert.equal(targetDecision(plan).decision, 'keep'); assert.equal(plan.close[0].tab_id, 'w:t2');
  assert.equal(plan.close[0].decision, exit ? 'exit' : 'release');
});

test('pristine tab cannot borrow a prospective per-run session-release tab', () => {
  const s = openLaneSnapshot(); s.sessionReleasePolicy = true; s.agents[0].agent_status = 'idle';
  s.record.items[0].role = 'reviewer'; s.record.runs[0].report = { seq: 2, outcome: 'done', extra: { verdict: 'PASS' } };
  const plan = planRetirement(s);
  assert.equal(plan.sessionReleases[0].tab_id, 'w:t2'); assert.equal(targetDecision(plan).decision, 'keep');
});

test('pristine authority follows creation evidence, not tab order or a t1 name', () => {
  const s = openLaneSnapshot(); s.tabs.reverse();
  s.tabs[1].tab_id = s.panes[0].tab_id = s.initialShells[0].tab = 'w:arbitrary-creation';
  const plan = planRetirement(s);
  assert.equal(plan.close[0].tab_id, 'w:arbitrary-creation'); assert.equal(plan.close[0].rule, 'pristine-first-tab/v1');
});

test('pristine executor holds the target and survivor locks across recheck and close and releases both on failure', () => {
  for (const failure of ['none', 'survivor lock', 'observation', 'close']) {
    const s = openLaneSnapshot(), plan = planRetirement(s), locks = new Set(), logs = [];
    const result = executeRetirement(plan, { lockTab: id => {
      if (id === 'w:t2' && failure === 'survivor lock') throw Error('survivor locked');
      assert.equal(locks.has(id), false); locks.add(id); return () => locks.delete(id);
    }, observe: () => {
      assert.deepEqual([...locks], ['w:t', 'w:t2']);
      if (failure === 'observation') throw Error('observation failed');
      return s;
    }, close: () => {
      assert.deepEqual([...locks], ['w:t', 'w:t2']);
      if (failure === 'close') throw Error('close failed');
    }, log: row => logs.push(row) });
    assert.equal(locks.size, 0); assert.equal(result[0].action, failure === 'none' ? 'closed' : 'close-failed');
    assert.equal(logs[0].rule, 'pristine-first-tab/v1'); assert.equal(logs[0].survivor.tab, 'w:t2');
  }
});

function openInitialFixture(t, command) {
  const f = fixture(t, { merged: false }), state = f.state;
  state.tabs.push({ tab_id: 'w:t2', workspace_id: 'w' });
  state.agents[0].tab_id = 'w:t2'; state.agents[0].agent_status = 'working';
  state.panes[0] = { pane_id: 'w:initial', tab_id: 'w:t', workspace_id: 'w', terminal_id: 'initial-terminal', foreground_cwd: f.lane };
  state.panes.push({ pane_id: 'w:p', tab_id: 'w:t2', workspace_id: 'w', terminal_id: 'term', foreground_cwd: f.lane });
  state.info = { shell_pid: 5, foreground_processes: [{ pid: 5, name: 'zsh' }], process_tree_complete: true,
    process_tree: [{ pid: 5, identity: 'birth', command: '[zsh]', state: 'S' }] }; f.save();
  const events = f.eventBytes.trim().split('\n').map(JSON.parse).filter(e => ['item.added', 'run.started'].includes(e.type));
  const eventBytes = events.map(e => JSON.stringify(e) + '\n').join(''); fs.writeFileSync(f.eventFile, eventBytes);
  fs.writeFileSync(path.join(f.lane, 'seed'), 'unfinished dirty work');
  recordInitialShell({ common: f.common, cwd: f.lane,
    created: { already_open: false, workspace: { workspace_id: 'w' }, tab: state.tabs[0], root_pane: state.panes[0] },
    h: args => args[1] === 'get' ? { pane: state.panes[0] } : { process_info: state.info } });
  const invoke = (exe, args, options) => {
    command?.(f, exe, args);
    if (exe === f.job.herdr && args[0] === 'pane' && args[1] === 'process-info' && args.at(-1) === 'w:p')
      return { status: 0, stdout: JSON.stringify({ result: { process_info: { shell_pid: 10, process_tree_complete: true,
        foreground_processes: [{ pid: 20, name: 'native' }],
        process_tree: [{ pid: 10, ppid: 1, identity: 'worker-shell', command: '[zsh]', state: 'S' },
          { pid: 20, ppid: 10, identity: 'worker-process', command: '[native]', state: 'S' }] } } }) };
    return spawnSync(exe, args, options);
  };
  return { ...f, eventBytes, retirement: options => f.retirement({ command: invoke, ...options }), receiptFile: initialShellFile(f.common, 'w:t') };
}

test('runtime closes only the pristine creation tab under the shared dispatch lock, preserving the dirty open lane and record', t => {
  let closeLocked = false;
  const f = openInitialFixture(t, (fixture, exe, args) => {
    if (exe === fixture.job.herdr && args[0] === 'tab' && args[1] === 'close') {
      assert.throws(() => initialShellLock(fixture.common, 'w:t'), /locked:/);
      assert.throws(() => initialShellLock(fixture.common, 'w:t2'), /locked:/); closeLocked = true;
    }
  });
  const logs = [], retirement = f.retirement({ log: row => logs.push(row) }), snapshot = retirement.observe();
  const receipt = JSON.parse(fs.readFileSync(f.receiptFile)), plan = planRetirement(snapshot);
  assert.equal(snapshot.git[0].clean, false); assert.equal(snapshot.git[0].integrated, false);
  assert.equal(snapshot.record.runs[0].report, null); assert.equal(snapshot.record.items[0].closed, null);
  assert.deepEqual(plan.close.map(t => t.tab_id), ['w:t']); assert.deepEqual(plan.laneClose, []);
  f.traceGit(); const result = retirement.apply(plan, undefined, snapshot);
  assert.equal(result[0].action, 'closed'); assert.equal(closeLocked, true);
  assert.equal(result[0].rule, 'pristine-first-tab/v1'); assert.deepEqual(result[0].receipt, receipt);
  assert.equal(result[0].survivor.terminal, 'term'); assert.ok(logs.some(row => row.action === 'closed' && row.survivor.tab === 'w:t2'));
  assert.deepEqual(f.read().actions, [['tab', 'close', 'w:t']]); assert.deepEqual(f.read().tabs.map(t => t.tab_id), ['w:t2']);
  assert.equal(f.read().workspaces.length, 1); assert.equal(f.read().agents.length, 1);
  assert.equal(f.git(['rev-parse', 'refs/heads/lane/topic']), f.head); assert.ok(fs.existsSync(f.lane));
  assert.equal(fs.readFileSync(path.join(f.lane, 'seed'), 'utf8'), 'unfinished dirty work');
  assert.equal(fs.readFileSync(f.eventFile, 'utf8'), f.eventBytes); assert.equal(fs.existsSync(f.receiptFile), false);
  assert.deepEqual(f.gitCalls().filter(a => a.includes('worktree') && a.includes('remove')), []);
  assert.equal(retirement.plan().close.length, 0, 'remaining agent is retained by ordinary retirement');
});

for (const race of ['survivor', 'target reference', 'HOLD', 'dispatch lock', 'survivor lock'])
  test(`runtime pristine close edge refuses a new ${race}`, t => {
    let armed = false;
    const f = openInitialFixture(t, (fixture, exe, args) => {
      if (!armed || exe !== fixture.job.herdr || args[0] !== 'workspace' || args[1] !== 'list') return;
      armed = false;
      assert.throws(() => initialShellLock(fixture.common, 'w:t'), /locked:/);
      assert.throws(() => initialShellLock(fixture.common, 'w:t2'), /locked:/);
      if (race === 'survivor') { fixture.state.agents[0].terminal_id = fixture.state.panes[1].terminal_id = 'replacement'; fixture.save(); }
      if (race === 'target reference') fs.writeFileSync(path.join(fixture.org, 'references/late.json'), JSON.stringify({
        schema: 'herdr-reference/v1', state: 'running', owner: 'test', kind: 'pending job', job: 'late', item: 'ENG-1',
        tab: 'w:t', created_at: '2026-01-01T00:00:00Z', expires_at: '2999-01-01T00:00:00Z' }));
      if (race === 'HOLD') hold(fixture);
    });
    const retirement = f.retirement(), snapshot = retirement.observe(), plan = planRetirement(snapshot);
    assert.equal(plan.close[0].rule, 'pristine-first-tab/v1');
    const unlock = ['dispatch lock', 'survivor lock'].includes(race) ? initialShellLock(f.common, race === 'dispatch lock' ? 'w:t' : 'w:t2') : null;
    armed = !unlock;
    try {
      const result = retirement.apply(plan, undefined, snapshot);
      assert.equal(result[0].decision === 'keep' || result[0].action === 'close-failed', true);
      assert.deepEqual(f.read().actions, []); assert.equal(fs.existsSync(f.receiptFile), true);
    } finally { unlock?.(); }
  });
