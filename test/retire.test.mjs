import test from './helpers/bounded-test.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fold } from '../lib/state.mjs';
import { fold as olderFold } from './fixtures/state-v0.mjs';
import { chainFor, planRetirement, executeRetirement, laneRemovalReason } from '../lib/retire.mjs';
import { readDeclaredReferences, readLiveReferences } from '../supervisor/retire.mjs';
import { retirementDeadline } from '../lib/retire-lock.mjs';
import { retirementHold, RETIREMENT_HOLD_REASON } from '../lib/retire-hold.mjs';
import { sessionBindFact } from './helpers/session-bind.mjs';
import { effectiveWorkerIdentity } from '../lib/worker-identity.mjs';
import { retirementStatus } from '../lib/retire-status.mjs';
import { processStartRecord } from '../test-slot/lock-support.mjs';
import { readTestSlotOccupancy } from '../test-slot/occupancy.mjs';
import { readProvingReservations } from '../test-slot/reservations.mjs';
import { readSlot } from '../board/facts.mjs';

function fixture() {
  const events = [
    { type: 'item.added', id: 'ENG-1', kind: 'work', role: 'engineer' },
    { type: 'run.started', id: 'R-1', item: 'ENG-1', workspace: '/repo/lane', meta: {
      agent: 'worker', pane: 'w:p', worker_workspace: 'w', terminal_id: 'terminal', agent_session_id: 'session', lane: 'topic' } },
    { type: 'report.ingested', run: 'R-1', report: { outcome: 'done' }, sha256: 'immutable' },
    { type: 'item.closed', id: 'ENG-1', as: 'done' },
  ].map((e, i) => ({ ...e, seq: i + 1, at: '2026-01-01T00:00:00Z' }));
  const record = fold(events);
  const snapshot = { common: '/repo/.git', record,
    git: [{ path: '/repo/lane', common: '/repo/.git', head: 'abc', clean: true, integrated: true, lane: 'topic' }],
    workspaces: [{ workspace_id: 'w', worktree: { checkout_path: '/repo/lane', repo_key: '/repo/.git', is_linked_worktree: true } }],
    tabs: [{ tab_id: 'w:t', workspace_id: 'w' }],
    panes: [{ pane_id: 'w:p', tab_id: 'w:t', workspace_id: 'w', shellOnly: false,
      process_info: { shell_pid: 5, foreground_processes: [{ name: 'native', pid: 10 }], process_tree_complete: true, process_tree: [{pid:5,identity:'shell',state:'S',command:'[zsh]'},{pid:10,identity:'agent',state:'S',command:'[native]'}] } }],
    agents: [{ name: 'worker', agent: 'native', agent_status: 'done', pane_id: 'w:p', tab_id: 'w:t', workspace_id: 'w',
      cwd: '/repo/lane', terminal_id: 'terminal', agent_session: { value: 'session' }, state_change_seq: 4 }],
    references: [], handoffs: [], errors: [] };
  return { ...snapshot, events };
}
const kept = s => { const p = planRetirement(s); assert.equal(p.close.length, 0); assert.equal(p.keep.length, 1); return p.keep[0].why; };

function lateBound(s) {
  const r = s.record.runs.get('R-1');
  delete r.meta.agent_session_id;
  Object.assign(r.meta, { dispatch_attempt: 'attempt', dispatch_journal: '/repo/.org/dispatch/attempt.json',
    dispatch_project: '/repo/.git', dispatch_record: '/repo/.org' });
  s.record.workerReceipts.set(r.id, { seq: 3, agent: 'worker', pane: 'w:p', worker_workspace: 'w', terminal_id: 'terminal' });
  r.report.seq = 5;
  s.record.sessionBindings.set(r.id, [sessionBindFact(r, s.record, { seq: 4 })]);
  return r;
}

test('a finished late-bound worker has the same retirement classification as a native-session reviewer', () => {
  const worker = fixture(), reviewer = fixture();
  const r = lateBound(worker);
  assert.equal(effectiveWorkerIdentity(r, worker.record).agent_session_id, 'session');
  reviewer.record.items.get('ENG-1').role = 'reviewer';
  reviewer.record.runs.get('R-1').report.extra = { verdict: 'PASS' };
  for (const [snapshot, kind] of [[worker, 'codex'], [reviewer, 'claude']]) {
    snapshot.agents[0].agent = kind;
    snapshot.panes[0].process_info.foreground_processes[0].name = kind;
    snapshot.panes[0].process_info.process_tree[1].command = `[${kind}]`;
  }
  assert.equal(planRetirement(worker).panes[0].decision, planRetirement(reviewer).panes[0].decision);
  assert.equal(planRetirement(worker).close.length, 1);
  assert.equal(retirementStatus(worker).rows[0].class, 'TERMINAL');
  assert.equal(retirementStatus(reviewer).rows[0].class, 'TERMINAL');
  // Binding supplies identity alone; every pre-existing keep still applies.
  for (const change of [s => { s.record.runs.get('R-1').report = null; },
    s => { s.record.items.get('ENG-1').closed = null; }, s => { s.git[0].clean = false; },
    s => { s.retirementHold = 'retirement held'; }, s => { s.agents[0].agent_status = 'working'; }]) {
    const s = fixture(); lateBound(s); change(s); assert.equal(planRetirement(s).close.length, 0);
  }
});

test('a late-bound older round status recommends pane-release with its effective native session', () => {
  const s = fixture(), r = lateBound(s);
  s.record.items.get('ENG-1').closed = null;
  s.record.runs.set('R-2', { ...r, id: 'R-2', started: { seq: 6 },
    meta: { ...r.meta, agent: 'next', pane: 'w:q', terminal_id: 'next-terminal', agent_session_id: 'next-session' },
    report: { seq: 7, outcome: 'failed' } });
  const row = retirementStatus(s).rows.find(row => row.type === 'tab');
  assert.equal(row.class, 'IDLE-NONTERMINAL');
  assert.match(row.recommendation, /record pane-release R-1 --session 'session' --terminal 'terminal'/);
});

test('late binding conflicts and replacement sessions stay KEEP while legacy terminal-only KEEP is unchanged', () => {
  const s = fixture(), r = lateBound(s), good = structuredClone(s.record.sessionBindings.get(r.id));
  for (const bad of [() => { s.record.sessionBindings.get(r.id)[0].session = 'replacement'; },
    () => { s.record.sessionBindings.get(r.id)[0].receipt.terminal_id = 'replacement'; },
    () => { s.record.sessionBindings.get(r.id).push({ ...s.record.sessionBindings.get(r.id)[0], session: 'other' }); }]) {
    s.record.sessionBindings.set(r.id, structuredClone(good)); bad(); assert.match(kept(s), /identity/);
  }
  s.record.sessionBindings.set(r.id, []); assert.match(kept(s), /unknown recorded native session identity/);
});

test('ingestion AND terminal chain plus clean integrated Git releases; no report or fold mutation', () => {
  const s = fixture(), before = JSON.stringify([...s.record.runs.values()]);
  const plan = planRetirement(s); assert.equal(plan.close.length, 1); assert.equal(plan.panes[0].decision, 'release');
  assert.equal(JSON.stringify([...s.record.runs.values()]), before);
  const actions = []; executeRetirement(plan, { observe: () => s, close: id => actions.push(id) });
  assert.deepEqual(actions, ['w:t']);
});

test('retirement hold: pure policy retains every pane and executor logs a distinct held outcome', () => {
  const s = fixture(), actions = [], logs = [], reason = 'retirement held: .lane/supervisor/HOLD-WORKER-TAB-CLOSE';
  const stale = planRetirement(s); s.retirementHold = reason;
  const plan = planRetirement(s); assert.equal(plan.close.length, 0); assert.equal(plan.keep[0].why, reason);
  assert.ok(plan.panes.every(p => p.decision === 'keep' && p.why === reason));
  const result = executeRetirement(stale, { observe: () => s, close: id => actions.push(id), log: row => logs.push(row) });
  assert.deepEqual(actions, []); assert.equal(result[0].action, 'held'); assert.deepEqual(logs, result);
  delete s.retirementHold; executeRetirement(planRetirement(s), { observe: () => s, close: id => actions.push(id) }); assert.deepEqual(actions, ['w:t']);
});

test('retirement hold: executor checks each tab and empty workspace immediately before closing', () => {
  const s = fixture(), plan = planRetirement(s), actions = [], reason = 'retirement held: .lane/supervisor/HOLD-WORKER-TAB-CLOSE';
  plan.close.push({ ...plan.close[0], tab_id: 'later' }); let held = null;
  const results = executeRetirement(plan, { observe: () => s, hold: () => held, close: id => { actions.push(id); held = reason; } });
  assert.deepEqual(actions, ['w:t']); assert.equal(results[1].action, 'held');
  const empty = fixture(); empty.tabs = []; empty.panes = []; empty.agents = [];
  const workspacePlan = { close: [], workspaceClose: [{ workspace_id: 'w', cwd: '/repo/lane', token: planRetirement(empty).token }] };
  held = null;
  const blocked = executeRetirement(workspacePlan, { observe: () => { held = reason; return empty; }, hold: () => held, closeWorkspace: id => actions.push(id) });
  assert.equal(blocked[0].action, 'held'); assert.deepEqual(actions, ['w:t']);
  held = null; executeRetirement(workspacePlan, { observe: () => empty, hold: () => held, closeWorkspace: id => actions.push(id) });
  assert.deepEqual(actions, ['w:t', 'w']);
});

test('workspace close intent precedes the native callback and requires an actual callback', () => {
  const s = fixture(); s.tabs = []; s.panes = []; s.agents = [];
  const plan = { close: [], workspaceClose: [{ workspace_id: 'w', cwd: '/repo/lane', token: planRetirement(s).token }] };
  const order = [];
  const results = executeRetirement(plan, { observe: () => s, log: row => order.push(row),
    closeWorkspace: id => order.push({ native: id }) });
  assert.deepEqual(order[0], { action: 'workspace-close-requested', workspace_id: 'w' });
  assert.deepEqual(order[1], { native: 'w' });
  assert.equal(order[2].action, 'closed'); assert.equal(results[0].action, 'closed');
  const omitted = [];
  assert.deepEqual(executeRetirement(plan, { observe: () => s, log: row => omitted.push(row) }), []);
  assert.deepEqual(omitted, []);
  const refused = [];
  executeRetirement(plan, { observe: () => ({ ...s, retirementHold: 'hold' }),
    closeWorkspace: () => assert.fail('held workspace'), log: row => refused.push(row) });
  assert.equal(refused[0].action, 'held');
  assert.ok(refused.every(row => row.action !== 'workspace-close-requested'));
});

test('process state changes do not change identity tokens, but stopped processes still keep on fresh decision', () => {
  const s=fixture(), plan=planRetirement(s);
  s.panes[0].process_info.process_tree[1].state='R';
  assert.equal(planRetirement(s).close[0].token,plan.close[0].token);
  assert.equal(executeRetirement(plan,{observe:()=>s,close:()=>{}})[0].action,'closed');
  s.panes[0].process_info.process_tree[1].state='T';
  const refused=executeRetirement(plan,{observe:()=>s,close:()=>assert.fail('stopped process')});
  assert.equal(refused[0].action,'skip-close');assert.match(refused[0].why,/process/);
});

test('the shared executor stops cleanly at a deadline without acting on later candidates', () => {
  const s = fixture(), planned = planRetirement(s);
  planned.close.push({ ...planned.close[0], tab_id: 'later' });
  let reads = 0; const actions = [];
  const results = executeRetirement(planned, { observe: () => { if (++reads === 2) throw retirementDeadline(); return s; }, close: id => actions.push(id) });
  assert.deepEqual(actions, ['w:t']); assert.deepEqual(results.map(result => result.action), ['closed', 'deferred']);
});

test('pruning another tab callback does not invalidate this tab token', () => {
  const s = fixture(); s.callbacks = [{ tab: 'another-tab', process_gone: true }];
  const token = planRetirement(s).close[0].token;
  s.callbacks = [];
  assert.equal(planRetirement(s).close[0].token, token);
});

test('narrow watcher retirement keeps focus, extra occupants, jobs, missing ingestion and changed birth identities', () => {
  const base=fixture();base.agents=[];base.selfTab='w:t';base.selfRetirement={tab:'w:t',pane:'w:p',pid:10};
  base.callbacks=[{schema:'retirement-occupant/v1',kind:'watcher',common:base.common,cwd:'/repo/lane',workspace:'w',tab:'w:t',pane:'w:p',run:'R-1',
    shell:{pid:5,identity:'shell',command:'[zsh]'},process:{pid:10,identity:'agent',command:'[native]'},process_gone:false}];
  assert.equal(planRetirement(base).close.length,1);
  for(const variant of ['focus','extra-pane','extra-process','job','not-ingested','wrong-pid','wrong-birth','live-other-callback']) {
    const s=structuredClone(base);
    if(variant==='focus')s.tabs[0].focused=true;
    if(variant==='extra-pane')s.panes.push({...s.panes[0],pane_id:'w:q'});
    if(variant==='extra-process')s.panes[0].process_info.process_tree.push({pid:99,identity:'extra',command:'server',state:'S'});
    if(variant==='job')s.references.push({kind:'job',item:'ENG-1'});
    if(variant==='not-ingested')s.record.runs.get('R-1').report=null;
    if(variant==='wrong-pid')s.selfRetirement.pid=99;
    if(variant==='wrong-birth')s.callbacks[0].process.identity='replacement';
    if(variant==='live-other-callback')delete s.selfRetirement;
    assert.equal(planRetirement(s).close.length,0,variant);
  }
});

for (const variant of ['report-file-only', 'report-before-review', 'blocked', 'needs-human', 'working', 'unknown', 'wrong-common',
  'wrong-head', 'dirty', 'wrong-terminal', 'wrong-session', 'wrong-pane', 'wrong-cwd', 'new-shell', 'other-program',
  'focused', 'lab', 'persistent', 'operator', 'missing-process']) test(`keeps ${variant}`, () => {
  const s = fixture(), r = s.record.runs.get('R-1'), a = s.agents[0];
  if (variant === 'report-file-only') { r.report = null; r.report_path = '/exists/report.md'; }
  if (variant === 'report-before-review') s.record.items.get('ENG-1').closed = null;
  if (variant === 'blocked') { r.report.outcome = 'blocked'; s.record.items.get('ENG-1').closed = null; }
  if (variant === 'needs-human') { r.report.outcome = 'needs_human'; s.record.items.get('ENG-1').closed = null; }
  if (['working', 'unknown'].includes(variant)) a.agent_status = variant;
  if (variant === 'wrong-common') s.git[0].common = '/another/.git';
  if (variant === 'wrong-head') s.git[0].integrated = false;
  if (variant === 'dirty') s.git[0].clean = false;
  if (variant === 'wrong-terminal') a.terminal_id = 'reused';
  if (variant === 'wrong-session') a.agent_session.value = 'reused';
  if (variant === 'wrong-pane') r.meta.pane = 'w:q';
  if (variant === 'wrong-cwd') a.cwd = '/another/lane';
  if (variant === 'new-shell') s.panes.push({ ...s.panes[0], pane_id: 'w:q', shellOnly: true });
  if (variant === 'other-program') s.panes[0].process_info.foreground_processes.push({ name: 'server', pid: 99 });
  if (variant === 'focused') s.tabs[0].focused = true;
  if (variant === 'lab') s.workspaces[0].lab_owned = true;
  if (variant === 'persistent') s.workspaces[0].persistent = true;
  if (variant === 'operator') s.workspaces[0].operator = true;
  if (variant === 'missing-process') delete s.panes[0].process_info;
  assert.ok(kept(s));
});

for (const as of ['dropped', 'done']) for (const outcome of ['blocked', 'needs_human', 'failed'])
  test(`explicit ${as} disposition supersedes a ${outcome} report for tab and lane retirement`, () => {
    const s = fixture(), item = s.record.items.get('ENG-1');
    item.closed.as = as; s.record.runs.get('R-1').report.outcome = outcome;
    assert.equal(planRetirement(s).close.length, 1);
    const vacant = () => ({ ...s, tabs: [], panes: [], agents: [] });
    assert.equal(laneRemovalReason(vacant(), '/repo/lane'), null);
    item.closed = null;
    assert.match(kept(s), /R-1 awaits correction or disposition/);
    assert.match(laneRemovalReason(vacant(), '/repo/lane'), /chain is still open/);
  });

for (const transport of ['blocked_by', 'links']) test(`closed ${transport} blocker is checked without expanding its chain`, () => {
  const s = fixture(), run = s.record.runs.get('R-1');
  const blocker = { id: 'ENG-2', role: 'engineer', closed: { as: 'done' }, blocked_by: ['ENG-3'] };
  s.record.items.set(blocker.id, blocker);
  s.record.items.set('HUM-1', { id: 'HUM-1', role: 'human', parent: blocker.id });
  s.record.items.set('ENG-3', { id: 'ENG-3', role: 'engineer' });
  if (transport === 'blocked_by') s.record.items.get(run.item).blocked_by = [blocker.id];
  else {
    delete blocker.blocked_by;
    s.record.links = [{ blocked: run.item, blocker: blocker.id }, { blocked: blocker.id, blocker: 'ENG-3' }];
  }
  assert.deepEqual([...chainFor(s.record, run).ids].sort(), ['ENG-1', 'ENG-2']);
  assert.equal(planRetirement(s).close.length, 1);
  const vacant = () => ({ ...s, tabs: [], panes: [], agents: [] });
  assert.equal(laneRemovalReason(vacant(), '/repo/lane'), null);
  s.references.push({ item: blocker.id, kind: 'callback' });
  assert.match(kept(s), /callback reference/);
  s.references = [];
  s.record.runs.set('R-2', { id: 'R-2', item: blocker.id, started: { seq: 5 } });
  assert.match(kept(s), /open run on ENG-2/);
  s.record.runs.delete('R-2');
  blocker.meta = { answer: 'no' };
  assert.match(kept(s), /declined blocker ENG-2/);
  delete blocker.meta;
  blocker.closed = null;
  assert.deepEqual([...chainFor(s.record, run).ids].sort(), ['ENG-1', 'ENG-2', 'ENG-3', 'HUM-1']);
  assert.match(kept(s), /ENG-2 has no recorded disposition/);
  assert.match(laneRemovalReason(vacant(), '/repo/lane'), /ENG-2 has no recorded disposition/);
});

test('a closed blocker reached later through the root subtree still expands; reviewer roots climb to the engineer', () => {
  const s = fixture(), run = s.record.runs.get('R-1');
  const root = s.record.items.get(run.item);
  root.blocked_by = ['ENG-2'];
  s.record.items.set('ENG-2', { id: 'ENG-2', role: 'engineer', parent: 'ENG-3', closed: { as: 'done' } });
  s.record.items.set('ENG-3', { id: 'ENG-3', role: 'engineer', parent: root.id, closed: { as: 'done' } });
  s.record.items.set('HUM-1', { id: 'HUM-1', role: 'human', parent: 'ENG-2' });
  s.record.items.set('REV-1', { id: 'REV-1', role: 'reviewer', parent: root.id });
  const reviewer = { id: 'R-2', item: 'REV-1', started: { seq: 5 }, report: { seq: 6, outcome: 'done', extra: { verdict: 'PASS' } } };
  s.record.runs.set(reviewer.id, reviewer);
  assert.equal(chainFor(s.record, reviewer).root.id, root.id);
  assert.ok(chainFor(s.record, reviewer).ids.has('HUM-1'));
  assert.match(kept(s), /HUM-1 has no recorded disposition/);
  root.closed = null;
  assert.match(laneRemovalReason({ ...s, panes: [], tabs: [], agents: [] }, '/repo/lane'), /chain is still open/);
});

test('a closed engineer does not discharge an open correction with a blocked report', () => {
  const s = fixture();
  s.record.items.set('ENG-2', { id: 'ENG-2', role: 'engineer', parent: 'ENG-1' });
  s.record.runs.set('R-2', { id: 'R-2', item: 'ENG-2', started: { seq: 5 }, report: { seq: 6, outcome: 'blocked' } });
  assert.match(kept(s), /ENG-2 awaits correction or disposition/);
  assert.match(laneRemovalReason({ ...s, panes: [], tabs: [], agents: [] }, '/repo/lane'), /ENG-2 awaits correction or disposition/);
});

test('pending review and NEEDS-WORK preserve the engineer across a fix gap', () => {
  const s = fixture(); s.record.items.set('REV-1', { id: 'REV-1', kind: 'work', role: 'reviewer', parent: 'ENG-1' });
  assert.match(kept(s), /review/);
  s.record.runs.set('R-2', { id: 'R-2', item: 'REV-1', started: { seq: 5 }, report: { seq: 6, outcome: 'done', extra: { verdict: 'NEEDS-WORK' } } });
  assert.match(kept(s), /PASS/);
  s.record.runs.get('R-2').report.extra.verdict = 'PASS'; assert.equal(planRetirement(s).close.length, 1);
  s.record.items.set('HUM-1', { id: 'HUM-1', role: 'human', parent: 'REV-1' }); assert.match(kept(s), /disposition/);
});

test('same native session new run keeps even after a rename and with immutable older report', () => {
  const s = fixture(), old = s.record.runs.get('R-1');
  s.record.runs.set('R-2', { ...old, id: 'R-2', started: { seq: 9 }, report: null, meta: { ...old.meta, agent: 'renamed' } });
  s.agents[0].name = 'renamed';
  assert.match(kept(s), /not ingested/); assert.equal(old.report.sha256, 'immutable');
});

test('confirmed successor never releases a warm open chain; disposition still needs the retained identity', () => {
  const s = fixture(), old = s.record.runs.get('R-1'); old.report = null; s.record.items.get('ENG-1').closed = null;
  const newer = { ...old, id: 'R-2', started: { seq: 10 }, meta: { ...old.meta, agent: 'successor', pane: 'w:q', terminal_id: 'new-term', agent_session_id: 'new-session' } };
  s.record.runs.set(newer.id, newer);
  s.tabs.push({ tab_id: 'w:u', workspace_id: 'w' }); s.panes.push({ ...s.panes[0], pane_id: 'w:q', tab_id: 'w:u' });
  s.agents.push({ ...s.agents[0], name: 'successor', pane_id: 'w:q', tab_id: 'w:u', terminal_id: 'new-term', agent_session: { value: 'new-session' }, agent_status: 'working' });
  s.handoffs.push({ from: 'R-1', to: 'R-2', seq: 11, confirmed: true });
  assert.equal(planRetirement(s).close.length, 0, 'delayed ingestion keeps even with a successor');
  old.report = { seq: 12, outcome: 'done' }; newer.report = { seq: 13, outcome: 'done' };
  assert.equal(planRetirement(s).close.length, 0, 'unreviewed chain keeps even with a successor');
  s.record.items.get('ENG-1').closed = { seq: 14, as: 'done' };
  assert.deepEqual(planRetirement(s).close.map(t => t.tab_id), ['w:t']);
  s.agents.pop(); assert.equal(planRetirement(s).close.length, 0);
});

function releasedFixture() {
  const s = fixture(), run = s.record.runs.get('R-1');
  s.record.items.get('ENG-1').closed = null;
  s.git[0].head = 'a'.repeat(40); s.git[0].clean = false; s.git[0].integrated = false;
  s.agents[0].agent_status = 'idle';
  s.releases = [{ type: 'retirement.release', run: run.id, item: run.item, pane: 'w:p', terminal: 'terminal', session: 'session',
    workspace: 'w', cwd: run.workspace, head: s.git[0].head, authority: 'owner ruling', confirmed: true, why: 'continue at desk', seq: 5 }];
  return s;
}

test('explicit release lifts only the session KEEP; an ingested open chain alone stays and lane removal still keeps', () => {
  const s = releasedFixture(), releases = s.releases, before = structuredClone(s.record);
  s.releases = []; assert.match(kept(s), /chain is still open/);
  s.releases = releases; const plan = planRetirement(s);
  assert.equal(plan.close.length, 1); assert.match(plan.close[0].why, /record release for R-1/);
  const actions = []; executeRetirement(plan, { observe: () => s, close: id => actions.push(id),
    closeWorkspace: () => assert.fail('workspace'), removeLane: () => assert.fail('lane') });
  assert.deepEqual(actions, ['w:t']); assert.deepEqual(s.record, before);
  s.tabs = []; s.panes = []; s.agents = [];
  assert.match(laneRemovalReason(s, '/repo/lane'), /chain is still open/);
});

for (const outcome of ['blocked', 'needs_human', 'failed']) test(`explicit release permits a reported ${outcome} session`, () => {
  const s = releasedFixture(); s.record.runs.get('R-1').report.outcome = outcome;
  assert.equal(planRetirement(s).close.length, 1);
});

for (const change of ['session', 'terminal', 'pane', 'workspace', 'cwd', 'unstamped', 'before-report', 'unconfirmed', 'head',
  'git-common', 'git-path', 'git-error', 'missing-report', 'working', 'process', 'focus', 'standard-slot', 'persistent', 'operator', 'lab', 'hold', 'error', 'other-occupant'])
  test(`explicit release keeps ${change}`, () => {
    const s = releasedFixture(), release = s.releases[0];
    if (['session', 'terminal', 'pane', 'workspace', 'cwd'].includes(change)) release[change] = 'wrong';
    if (change === 'unstamped') delete release.seq;
    if (change === 'before-report') release.seq = s.record.runs.get('R-1').report.seq;
    if (change === 'unconfirmed') release.confirmed = false;
    if (change === 'head') s.git[0].head = 'b'.repeat(40);
    if (change === 'git-common') s.git[0].common = '/other/.git';
    if (change === 'git-path') s.git[0].path = '/other/lane';
    if (change === 'git-error') s.git[0].error = 'Git unreadable';
    if (change === 'missing-report') s.record.runs.get('R-1').report = null;
    if (change === 'working') s.agents[0].agent_status = 'working';
    if (change === 'process') s.panes[0].process_info.process_tree.push({ pid: 99, identity: 'server', command: 'server', state: 'S' });
    if (change === 'focus') s.tabs[0].focused = true;
    if (change === 'standard-slot') s.standardSlots = standardSlots(s);
    if (change === 'persistent') s.workspaces[0].persistent = true;
    if (change === 'operator') s.workspaces[0].operator = true;
    if (change === 'lab') s.workspaces[0].lab_owned = true;
    if (change === 'hold') s.retirementHold = RETIREMENT_HOLD_REASON;
    if (change === 'error') s.errors.push('unreadable evidence');
    if (change === 'other-occupant') { s.panes.push({ ...s.panes[0], pane_id: 'w:q' }); s.agents.push({ ...s.agents[0], name: 'unknown', pane_id: 'w:q' }); }
    const reason = kept(s);
    if (change === 'head') assert.equal(reason, 'release for R-1 is stale: head moved');
    if (change === 'hold') assert.equal(reason, RETIREMENT_HOLD_REASON);
  });

for (const ref of [{ item: 'ENG-1' }, { run: 'R-1' }, { pane: 'w:p' }, { cwd: '/repo/lane' }])
  test(`explicit release rechecks new live reference ${Object.keys(ref)[0]}`, () => {
    const s = releasedFixture(), plan = planRetirement(s); s.references.push({ ...ref, kind: 'new work' });
    assert.match(kept(s), /new work reference/);
    assert.equal(executeRetirement(plan, { observe: () => s, close: () => assert.fail('new reference') })[0].action, 'skip-close');
  });

for (const change of ['terminal', 'session', 'same-pane-run', 'same-session-run']) test(`explicit release cannot close later occupant ${change}`, () => {
  const s = releasedFixture(), plan = planRetirement(s), old = s.record.runs.get('R-1');
  if (change === 'terminal') s.agents[0].terminal_id = 'later';
  if (change === 'session') s.agents[0].agent_session.value = 'later';
  if (change.endsWith('-run')) {
    const meta = { ...old.meta, agent: 'continuation' };
    if (change === 'same-pane-run') { meta.terminal_id = 'later'; meta.agent_session_id = 'later'; }
    if (change === 'same-session-run') meta.pane = 'w:q';
    s.record.runs.set('R-2256', { ...old, id: 'R-2256', started: { seq: 6 }, meta, report: null });
    Object.assign(s.agents[0], { name: meta.agent, terminal_id: meta.terminal_id, agent_session: { value: meta.agent_session_id } });
  }
  assert.ok(kept(s));
  assert.equal(executeRetirement(plan, { observe: () => s, close: () => assert.fail('later occupant') })[0].action, 'skip-close');
});

test('explicit release ignores unrelated open lane runs but retains pane, session and run references', () => {
  for (const meta of [{}, { pane: 'w:p' }, { agent_session_id: 'session' }, { run: 'R-1' }]) {
    const s = releasedFixture();
    s.record.runs.set('R-2', { id: 'R-2', item: 'ENG-2', workspace: '/repo/lane', started: { seq: 1 }, report: null, meta });
    if (!Object.keys(meta).length) assert.equal(planRetirement(s).close.length, 1);
    else assert.match(kept(s), /open run in lane/);
  }
});

test('release authority changes both plan and tab tokens and executor freshly keeps a moved head', () => {
  const s = releasedFixture(), plan = planRetirement(s);
  s.releases[0].authority = 'new ruling';
  assert.notEqual(planRetirement(s).token, plan.token); assert.notEqual(planRetirement(s).close[0].token, plan.close[0].token);
  assert.equal(executeRetirement(plan, { observe: () => s, close: () => assert.fail('changed authority') })[0].action, 'skip-close');
  const fresh = planRetirement(s); s.git[0].head = 'b'.repeat(40);
  assert.match(executeRetirement(fresh, { observe: () => s, close: () => assert.fail('moved head') })[0].why, /stale: head moved/);
});

test('explicit release cannot override an incoming handoff reservation', () => {
  const s = releasedFixture(), run = s.record.runs.get('R-1');
  run.started.seq = 3;
  const predecessor = { ...run, id: 'R-0', started: { seq: 2 }, meta: { ...run.meta,
    agent: 'predecessor', pane: 'w:q', terminal_id: 'old-term', agent_session_id: 'old-session' } };
  s.record.runs.set(predecessor.id, predecessor);
  s.tabs.push({ tab_id: 'w:u', workspace_id: 'w' }); s.panes.push({ ...s.panes[0], pane_id: 'w:q', tab_id: 'w:u' });
  s.agents.push({ ...s.agents[0], name: 'predecessor', pane_id: 'w:q', tab_id: 'w:u', terminal_id: 'old-term', agent_session: { value: 'old-session' } });
  s.handoffs.push({ from: 'R-0', to: 'R-1', confirmed: true, seq: 6 });
  const plan = planRetirement(s); assert.equal(plan.close.length, 0);
  assert.match(plan.keep.find(t => t.tab_id === 'w:t').why, /retained successor for handoff/);
});

test('older folds ignore retirement.release and both folds preserve the ingested report', () => {
  const events = [{ type: 'item.added', id: 'ENG-1', role: 'engineer', seq: 1 },
    { type: 'run.started', id: 'R-1', item: 'ENG-1', seq: 2 },
    { type: 'report.ingested', run: 'R-1', report: { outcome: 'done' }, sha256: 'immutable', seq: 3 },
    { type: 'retirement.release', run: 'R-1', confirmed: true, seq: 4 }];
  for (const f of [fold, olderFold]) assert.deepEqual([...f(events).runs.values()], [...f(events.slice(0, -1)).runs.values()]);
});

function standardSlots(s) {
  return { schema: 'standard-slot-history/v1', errors: [], slots: [{ uid: 'adopted-logs', common: s.common, server: 'default', workspace: 'w', checkout: '/repo/lane', tab: 'w:t', standardSlot: 'logs', panes: [{ pane: 'w:p', paneSlot: 'viewer' }, { pane: 'w:q', paneSlot: 'triage' }] }] };
}
test('adopted standard tabs and both logs panes KEEP in a linked lane; display labels cannot change it', () => {
  const s = fixture(); s.standardSlots = standardSlots(s); s.tabs[0].label = 'ordinary worker';
  s.panes.push({ ...s.panes[0], pane_id: 'w:q' });
  const plan = planRetirement(s); assert.match(plan.keep[0].why, /adopted standard slot/);
  assert.equal(plan.panes.length, 2); assert.ok(plan.panes.every(p => p.decision === 'keep'));
  s.tabs = []; s.panes = []; s.agents = [];
  assert.match(laneRemovalReason(s, '/repo/lane'), /explicit withdrawal/);
  const workspacePlan = { close: [], workspaceClose: [{ workspace_id: 'w', cwd: '/repo/lane', token: planRetirement(s).token }] };
  const result = executeRetirement(workspacePlan, { observe: () => s, closeWorkspace: () => assert.fail('protected workspace') });
  assert.equal(result[0].action, 'skip-close'); assert.match(result[0].why, /adopted/);
  const mismatchedPath = { close: [], workspaceClose: [{ workspace_id: 'w', cwd: '/another', token: planRetirement(s).token }] };
  assert.match(executeRetirement(mismatchedPath, { observe: () => s, closeWorkspace: () => assert.fail('protected id') })[0].why, /adopted/);
  s.standardSlots.slots = []; assert.equal(laneRemovalReason(s, '/repo/lane'), null);
});
for (const evidence of [null, {}, { schema: 'future/v2', slots: [], errors: [] }, { schema: 'standard-slot-history/v1', slots: [null], errors: [] },
  { schema: 'standard-slot-history/v1', slots: [], errors: ['unreadable protection; project kept'] }]) test(`unknown standard-slot evidence keeps: ${JSON.stringify(evidence)}`, () => {
  const s = fixture(), plan = planRetirement(s); s.standardSlots = evidence;
  assert.match(kept(s), /protection|standard-slot/);
  const result = executeRetirement(plan, { observe: () => s, close: () => assert.fail('unknown protection') });
  assert.equal(result[0].action, 'skip-close');
});
test('execution freshly rechecks receipt adoption and warm review corrections', () => {
  for (const change of ['adoption', 'review', 'correction']) {
    const s = fixture(), plan = planRetirement(s);
    if (change === 'adoption') s.standardSlots = standardSlots(s);
    if (change === 'review') s.record.items.set('REV-1', { id: 'REV-1', role: 'reviewer', parent: 'ENG-1' });
    if (change === 'correction') s.record.runs.set('R-2', { id: 'R-2', item: 'ENG-1', started: { seq: 20 }, report: null });
    const result = executeRetirement(plan, { observe: () => s, close: () => assert.fail(change) });
    assert.equal(result[0].action, 'skip-close');
  }
});

test('unreadable canonical hold lookup fails closed before execution', t => {
  const s = fixture(), plan = planRetirement(s);
  const original = fs.lstatSync;
  t.mock.method(fs, 'lstatSync', function(file, ...args) {
    if (String(file).endsWith('HOLD-WORKER-TAB-CLOSE')) throw Object.assign(Error('fixture denied'), { code: 'EACCES' });
    return original.call(this, file, ...args);
  });
  assert.equal(retirementHold('/repo'), RETIREMENT_HOLD_REASON);
  const result = executeRetirement(plan, { hold: () => retirementHold('/repo'), observe: () => assert.fail('hold must veto'), close: () => assert.fail('unreadable hold') });
  assert.equal(result[0].action, 'held');
});

test('all tab occupants must be independently eligible; metadata never releases', () => {
  const s = fixture(); s.panes.push({ ...s.panes[0], pane_id: 'w:q' }); s.agents.push({ ...s.agents[0], name: 'unrecorded', pane_id: 'w:q' });
  s.agents[1].session_metadata = { status: 'done', report: true, retired: true };
  assert.match(kept(s), /identity/);
});

for (const reference of [{ kind: 'promote', lane: 'topic' }, { kind: 'verify', item: 'ENG-1' }, { kind: 'host-check', run: 'R-1' },
  { kind: 'callback', pane: 'w:p' }, { kind: 'test-slot', cwd: '/repo/lane/subdir' }, { kind: 'waiter', label: 'checks in /repo/lane' },
  { kind: 'reconcile', global: true }]) test(`reference only keeps: ${reference.kind}`, () => {
  const s = fixture(); s.references.push(reference); assert.match(kept(s), /reference/);
  s.record.runs.get('R-1').report = null; assert.equal(planRetirement(s).close.length, 0);
});

for (const change of ['reactivated', 'native-session', 'head', 'record-reopened', 'reference', 'new-pane', 'read-error']) test(`executor rechecks ${change} and reports the fresh reason`, () => {
  const s = fixture(), plan = planRetirement(s), actions = [], logs = [];
  if (change === 'reactivated') s.agents[0].agent_status = 'working';
  if (change === 'native-session') s.agents[0].agent_session.value = 'new';
  if (change === 'head') s.git[0].head = 'changed-but-also-integrated';
  if (change === 'record-reopened') s.record.items.get('ENG-1').closed = null;
  if (change === 'reference') s.references.push({ run: 'R-1', kind: 'host-check', job: 'new' });
  if (change === 'new-pane') s.panes.push({ ...s.panes[0], pane_id: 'w:q' });
  const result = executeRetirement(plan, { observe: () => { if (change === 'read-error') throw Error('record unreadable'); return s; }, close: id => actions.push(id), log: e => logs.push(e) });
  assert.deepEqual(actions, []); assert.ok(result[0].why); assert.equal(logs[0].why, result[0].why);
  if (change === 'reactivated') assert.match(result[0].why, /working/);
});

test('restart/idempotency uses fresh authority; failures are cleanup failures', () => {
  const s = fixture(), plan = planRetirement(s);
  const failed = executeRetirement(plan, { observe: () => s, close: () => { throw Error('server unavailable'); } });
  assert.equal(failed[0].action, 'close-failed');
  s.tabs = []; s.panes = []; s.agents = [];
  assert.equal(executeRetirement(plan, { observe: () => s, close: () => assert.fail() })[0].action, 'already-gone');
  assert.equal(planRetirement(s).close.length, 0);
});

test('Git-only deletion rejects even a releasable pane until its removal is observed', () => {
  const s = fixture(); assert.match(laneRemovalReason(s, '/repo/lane'), /occupied/);
  s.tabs = []; s.panes = []; s.agents = []; assert.equal(laneRemovalReason(s, '/repo/lane'), null);
  s.references.push({ cwd: '/repo/lane', kind: 'host-check' }); assert.match(laneRemovalReason(s, '/repo/lane'), /reference/);
});

function referenceFixture(t) {
  const org = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'retirement-reference-')));
  t.after(() => fs.rmSync(org, { recursive: true, force: true })); fs.mkdirSync(path.join(org, 'references'));
  const file = path.join(org, 'references/job.json');
  const ref = { schema: 'herdr-reference/v1', owner: 'test', kind: 'host-check', job: 'job', state: 'running', item: 'ENG-1',
    created_at: '2026-01-01T00:00:00Z', expires_at: '2026-01-02T00:00:00Z' };
  return { org, file, ref, write: value => fs.writeFileSync(file, JSON.stringify(value)), now: Date.parse('2026-01-01T12:00:00Z') };
}
test('herdr-reference/v1 matches each declared key, expires visibly, and never releases', t => {
  const f = referenceFixture(t);
  for (const key of ['item', 'run', 'lane', 'cwd', 'pane']) {
    const ref = { ...f.ref, item: 'OTHER', [key]: { item: 'ENG-1', run: 'R-1', lane: 'topic', cwd: '/repo/lane', pane: 'w:p' }[key] };
    f.write(ref); const observed = readDeclaredReferences(f.org, f.now), s = fixture(); Object.assign(s, observed);
    assert.match(kept(s), /host-check reference job/);
    s.record.runs.get('R-1').report = null; assert.equal(planRetirement(s).close.length, 0);
  }
  f.write({ ...f.ref, expires_at: '2026-01-01T10:00:00Z' });
  const observed = readDeclaredReferences(f.org, f.now); assert.equal(observed.references.length, 0); assert.match(observed.diagnostics[0].reason, /expired/);
  const s = fixture(); Object.assign(s, observed); assert.equal(planRetirement(s).close.length, 1);
});
test('malformed, missing expiry, unknown schema, unreadable reference fail the whole project closed', t => {
  const f = referenceFixture(t);
  for (const value of [{ ...f.ref, schema: 'future/v2' }, { ...f.ref, expires_at: null }, { ...f.ref, state: 'done' }]) {
    f.write(value); const s = fixture(); Object.assign(s, readDeclaredReferences(f.org, f.now)); assert.match(kept(s), /project kept/);
  }
  fs.writeFileSync(f.file, '{'); assert.equal(readDeclaredReferences(f.org, f.now).errors.length, 1);
  const read = fs.readFileSync;
  fs.readFileSync = (file, ...args) => { if (file === f.file) throw Object.assign(Error('denied'), { code: 'EACCES' }); return read(file, ...args); };
  try { assert.match(readDeclaredReferences(f.org, f.now).errors[0], /denied.*project kept/); }
  finally { fs.readFileSync = read; }
});
test('declared references ignore directories, dotfiles and non-JSON files', t => {
  const f = referenceFixture(t);
  fs.mkdirSync(f.file); assert.deepEqual(readDeclaredReferences(f.org, f.now).errors, []);
  for (const name of ['notes.txt', '.hidden.json']) fs.writeFileSync(path.join(f.org, 'references', name), '{');
  assert.deepEqual(readDeclaredReferences(f.org, f.now).errors, []);
});
test('generic promote and trusted verify sources are read-only and include interrupted/reconcile holds', t => {
  const f = referenceFixture(t), common = path.join(f.org, 'common'), verifyStateDir = path.join(f.org, 'trusted');
  fs.mkdirSync(path.join(common, 'promote'), { recursive: true }); fs.mkdirSync(verifyStateDir);
  const file = path.join(common, 'promote/queue.json');
  const bytes = JSON.stringify({ identity: common, pending: [{ id: 'pending', topic: 'topic' }],
    current: { id: 'current', topic: 'topic' }, interrupted: [{ jobs: [{ id: 'interrupted', topic: 'topic' }] }],
    results: [{ id: 'reconcile', topic: 'topic', reconciliation: { state: 'pending' } }] }); fs.writeFileSync(file, bytes);
  fs.writeFileSync(path.join(verifyStateDir, 'queue.json'), JSON.stringify({ schema: 'verify-queue/v1', identity: common,
    jobs: [{ id: 'verify', item: 'ENG-1', admission: {} }, { id: 'old', item: 'ENG-1', admission: {}, completed_at: 'then' }] }));
  const observed = readLiveReferences({ common, org: f.org, verifyStateDir, env: { MONITOR_TEST_SLOT_PATH: path.join(f.org, 'slot'), MONITOR_TEST_SLOT_COMPAT_PATH: path.join(f.org, 'slot') } });
  assert.equal(observed.errors.length, 0); assert.deepEqual(observed.references.map(r => r.job), ['pending', 'interrupted', 'current', 'reconcile', 'verify']);
  assert.equal(fs.readFileSync(file, 'utf8'), bytes);
});

for (const state of ['live', 'gone', 'EPERM']) for (const match of ['cwd', 'label'])
  test(`shared occupancy ${state} matched by ${match} participates in tab and lane retirement without pruning`, t => {
    const f = referenceFixture(t), common = path.join(f.org, 'common'), lock = path.join(f.org, 'slot');
    const directory = `${lock}.occupancy`, file = path.join(directory, 'fixture.json');
    fs.mkdirSync(directory);
    const owner = 2147483000, group = owner + 1, kill = process.kill, probes = [];
    const record = { schema: 'occupancy/v1', class: 'shared', pid: owner, processStart: null,
      pgid: group, groupStart: null, [match]: match === 'cwd' ? '/repo/lane' : 'promotion /repo/lane' };
    const bytes = JSON.stringify(record), future = JSON.stringify({ ...record, schema: 'occupancy/future' });
    fs.writeFileSync(file, bytes); fs.writeFileSync(path.join(directory, 'future.json'), future);
    process.kill = (pid, signal) => {
      assert.equal(signal, 0); assert.ok([owner, group, -group].includes(pid)); probes.push(pid);
      if (state !== 'live') throw Object.assign(Error(state), { code: state === 'gone' ? 'ESRCH' : 'EPERM' });
      return true;
    };
    let observed;
    try { observed = readLiveReferences({ common, org: f.org, verifyStateDir: path.join(f.org, 'verify'),
      env: { MONITOR_TEST_SLOT_PATH: lock, MONITOR_TEST_SLOT_COMPAT_PATH: lock } }); }
    finally { process.kill = kill; }
    assert.deepEqual(observed.errors, []);
    assert.deepEqual(probes, state === 'gone' ? [owner, group, -group] : [owner], 'read the v1 owner/groups and skip unknown schemas');
    const s = fixture(); Object.assign(s, observed);
    if (state === 'gone') {
      assert.ok(probes.includes(group)); assert.ok(probes.includes(-group));
      assert.deepEqual(observed.references, []);
      assert.equal(planRetirement(s).close.length, 1);
      assert.equal(laneRemovalReason({ ...s, panes: [], tabs: [], agents: [] }, '/repo/lane'), null);
    } else {
      assert.equal(observed.references.length, 1); assert.equal(observed.references[0].kind, 'test-slot occupant');
      assert.match(kept(s), /test-slot occupant reference/);
      assert.match(laneRemovalReason({ ...s, panes: [], tabs: [], agents: [] }, '/repo/lane'), /test-slot occupant reference/);
    }
    assert.equal(fs.readFileSync(file, 'utf8'), bytes); assert.equal(fs.readFileSync(path.join(directory, 'future.json'), 'utf8'), future);
  });

test('BCH exact occupancy/v1 with UUID filename and null births is counted, kept and pruned only when gone', t => {
  const f = referenceFixture(t), common = path.join(f.org, 'common'), lock = path.join(f.org, 'slot');
  const file = path.join(`${lock}.occupancy`, 'd0e1f200-1111-4111-8111-123456789abc.json');
  fs.mkdirSync(`${lock}.occupancy`);
  const acquiredAt = new Date().toISOString();
  const record = { schema: 'occupancy/v1', class: 'shared', pid: process.pid, processStart: processStartRecord(process.pid).start,
    processBirth: null, pgid: null, groupStart: null, groupBirth: null, acquiredAt, startedAt: acquiredAt,
    project: common, label: 'BCH test', cwd: '/repo/lane', host: os.hostname(), reason: 'unprofiled' };
  const bytes = JSON.stringify(record) + '\n'; fs.writeFileSync(file, bytes);
  assert.equal(readTestSlotOccupancy(lock)[0].state, 'live');
  assert.equal(readSlot({ lockPath: lock, compatPath: lock }).sharedCount, 1);
  const env = { MONITOR_TEST_SLOT_PATH: lock, MONITOR_TEST_SLOT_COMPAT_PATH: lock };
  const observed = readLiveReferences({ common, org: f.org, verifyStateDir: path.join(f.org, 'verify'), env });
  assert.deepEqual(observed.errors, []); assert.equal(observed.references[0].kind, 'test-slot occupant');
  assert.match(kept(Object.assign(fixture(), observed)), /test-slot occupant reference/);
  assert.equal(fs.readFileSync(file, 'utf8'), bytes);
  const gone = () => { throw Object.assign(Error('gone'), { code: 'ESRCH' }); };
  assert.equal(readTestSlotOccupancy(lock, { kill: gone })[0].state, 'gone'); assert.ok(fs.existsSync(file));
  let changed = false;
  readTestSlotOccupancy(lock, { prune: true, kill: () => { if (!changed) { changed = true; fs.appendFileSync(file, ' '); } gone(); } });
  assert.ok(fs.existsSync(file));
  readTestSlotOccupancy(lock, { prune: true, kill: gone }); assert.equal(fs.existsSync(file), false);
});

for (const state of ['live', 'expired']) for (const target of ['matched', 'unrelated'])
test(`${state} ${target} proving reservation scopes lane and tab retirement read-only`, t => {
  const f = referenceFixture(t), common = path.join(f.org, 'common'), lock = path.join(f.org, 'slot'), now = Date.now();
  const file = path.join(`${lock}.occupancy`, 'proving.json'), identity = processStartRecord(process.pid);
  fs.mkdirSync(`${lock}.occupancy`);
  const record = { schema: 'host-reservation/v1', class: 'proving', pid: process.pid, processStart: identity.start, processBirth: identity.birth,
    pgid: null, groupStart: null, groupBirth: null, acquiredAt: new Date(now - 60000).toISOString(),
    expectedEnd: new Date(now + 60000).toISOString(), expiresAt: new Date(now + (state === 'live' ? 60000 : -1000)).toISOString(),
    project: common, label: target === 'matched' ? 'proving /repo/lane' : 'other proving step',
    cwd: target === 'matched' ? '/repo/lane' : '/another-project/lane', host: os.hostname(), reason: 'ENG-424 R-626' };
  const bytes = JSON.stringify(record) + '\n'; fs.writeFileSync(file, bytes);
  assert.equal(readProvingReservations(lock, { now })[0].state, state);
  const env = { MONITOR_TEST_SLOT_PATH: lock, MONITOR_TEST_SLOT_COMPAT_PATH: lock };
  const observed = readLiveReferences({ common, org: f.org, verifyStateDir: path.join(f.org, 'verify'), env });
  assert.deepEqual(observed.errors, []); assert.equal(observed.references.length, 1);
  assert.equal(observed.references[0].kind, 'test-slot occupant');
  const s = Object.assign(fixture(), observed);
  if (target === 'matched') {
    assert.match(kept(s), /test-slot occupant reference/);
    assert.match(laneRemovalReason({ ...s, panes: [], tabs: [], agents: [] }, '/repo/lane'), /test-slot occupant reference/);
  } else {
    assert.equal(planRetirement(s).close.length, 1, 'an unrelated reservation cannot keep a finished tab');
    assert.equal(laneRemovalReason({ ...s, panes: [], tabs: [], agents: [] }, '/repo/lane'), null);
  }
  assert.equal(fs.readFileSync(file, 'utf8'), bytes, 'retirement never prunes or rewrites the reservation');
});

test('promotion references follow the latest request checkpoint and preserve active holds', t => {
  const f = referenceFixture(t), common = path.join(f.org, 'common');
  fs.mkdirSync(path.join(common, 'promote'), { recursive: true });
  const file = path.join(common, 'promote/queue.json');
  const job = { id: 'recovered', topic: 'topic' }, other = { id: 'other', topic: 'other' };
  const pending = { outcome: 'promoted', reconciliation: { state: 'pending' } };
  const complete = { outcome: 'promoted', reconciliation: { state: 'complete' } };
  const queue = { identity: common, pending: [], results: [{ ...job, ...pending }, { ...other, ...pending }],
    current: { id: 'batch', jobs: [job], results: [{ job, result: complete }] } };
  const read = () => {
    const bytes = JSON.stringify(queue); fs.writeFileSync(file, bytes);
    const observed = readLiveReferences({ common, org: f.org, verifyStateDir: path.join(f.org, 'verify'),
      env: { MONITOR_TEST_SLOT_PATH: path.join(f.org, 'slot'), MONITOR_TEST_SLOT_COMPAT_PATH: path.join(f.org, 'slot') } });
    assert.deepEqual(observed.errors, []); assert.equal(fs.readFileSync(file, 'utf8'), bytes);
    return observed.references.map(ref => ref.job);
  };
  assert.deepEqual(read(), ['other'], 'durable current completion supersedes its historical pending result');
  queue.current.results[0].result = pending;
  assert.deepEqual(read(), ['recovered', 'other'], 'current reconciliation still pending keeps');
  queue.current.results[0].result = { ...complete, replacement_pending: true };
  assert.deepEqual(read(), ['recovered', 'other'], 'replacement work still keeps');
  queue.current = null; queue.results.push({ ...job, ...complete });
  assert.deepEqual(read(), ['other'], 'the latest persisted result supersedes only the same request');
  queue.results.push({ ...job, ...pending });
  assert.deepEqual(read(), ['recovered', 'other'], 'a later pending result restores the hold');
  queue.results.push({ ...job, ...complete }); queue.pending = [job];
  assert.deepEqual(read(), ['recovered', 'other'], 'newly pending work overrides completed history');
  queue.pending = []; queue.interrupted = [{ jobs: [job] }];
  assert.deepEqual(read(), ['recovered', 'other'], 'interrupted work keeps even with completed history');
});

test('pending settlement callbacks keep; completed receipts remain historical', t => {
  const f=referenceFixture(t), common=fs.realpathSync(f.org);
  fs.mkdirSync(path.join(f.org,'settle'));
  const file=path.join(f.org,'settle/R-1.json');
  fs.writeFileSync(file,JSON.stringify({common,run:'R-1',item:'ENG-1',lane:'topic',stage:'decide'}));
  const observe=()=>readLiveReferences({common,org:f.org,env:{MONITOR_TEST_SLOT_PATH:path.join(f.org,'slot'),MONITOR_TEST_SLOT_COMPAT_PATH:path.join(f.org,'slot')}});
  assert.equal(observe().references[0].kind,'settle callback');
  fs.writeFileSync(file,JSON.stringify({common,run:'R-1',stage:'complete'}));assert.deepEqual(observe().references,[]);
});
test('session display changes have no retirement authority', () => {
  const s=fixture(),plan=planRetirement(s),actions=[];
  s.agents[0].terminal_title='New display';s.agents[0].session_metadata={status:'working'};
  executeRetirement(plan,{observe:()=>s,close:id=>actions.push(id)});assert.deepEqual(actions,['w:t']);
});

test('background descendants and unknown kernel birth keep, and PID reuse invalidates a plan', () => {
  const s=fixture();s.panes[0].process_info.process_tree.push({pid:99,identity:'background',state:'S'});assert.match(kept(s),/process/);
  s.panes[0].process_info.process_tree.pop();const plan=planRetirement(s);s.panes[0].process_info.process_tree[1].identity='reused-pid';
  assert.equal(executeRetirement(plan,{observe:()=>s,close:()=>assert.fail()})[0].action,'skip-close');
});

test('older folds ignore the confirmed handoff event', () => {
  const events=[{type:'item.added',id:'ENG-1',role:'engineer',seq:1},{type:'run.started',id:'R-1',item:'ENG-1',seq:2},
    {type:'retirement.handoff',from:'R-1',to:'R-2',confirmed:true,seq:3}];
  assert.deepEqual([...olderFold(events).runs.values()],[...olderFold(events.slice(0,2)).runs.values()]);
});

test('a reported successor is reserved until the superseded pane is actually gone', () => {
  const s=fixture(),old=s.record.runs.get('R-1');
  const successor={...old,id:'R-2',started:{seq:10},meta:{...old.meta,agent:'successor',pane:'w:q',terminal_id:'next-term',agent_session_id:'next-session'}};
  s.record.runs.set('R-2',successor);s.tabs.push({tab_id:'w:u',workspace_id:'w'});s.panes.push({...s.panes[0],pane_id:'w:q',tab_id:'w:u'});
  s.agents.push({...s.agents[0],name:'successor',pane_id:'w:q',tab_id:'w:u',terminal_id:'next-term',agent_session:{value:'next-session'}});
  s.handoffs.push({from:'R-1',to:'R-2',seq:11,confirmed:true});
  const plan=planRetirement(s);assert.deepEqual(plan.close.map(t=>t.tab_id),['w:t']);assert.match(plan.keep[0].why,/retained successor/);
  s.tabs.shift();s.panes.shift();s.agents.shift();assert.deepEqual(planRetirement(s).close.map(t=>t.tab_id),['w:u']);
});

test('a native session without its launch receipt stays unknown even on the old terminal', () => {
  const s=fixture();delete s.record.runs.get('R-1').meta.agent_session_id;assert.match(kept(s),/identity/);
});

test('project reference damage is reported even when no tabs are present', () => {
  const s=fixture();s.tabs=[];s.panes=[];s.agents=[];s.errors=['malformed reference; project kept'];
  assert.deepEqual(planRetirement(s).diagnostics,[{reason:s.errors[0],scope:'project'}]);
});

test('lane removal uses fresh shared authority: new references and HOLD both stop the executor', () => {
  const s = fixture(); s.tabs = []; s.panes = []; s.agents = [];
  s.removal = { cwd: '/repo/lane', branch: 'lane/topic', tip: 'abc', evidence: { sha256: 'hash' } };
  const actions = [], plan = planRetirement(s); assert.equal(plan.laneClose.length, 1);
  s.references.push({ kind: 'verify desk', job: 'job', cwd: '/repo/lane' });
  const kept = executeRetirement(plan, { observe: () => s, removeLane: row => actions.push(row) });
  assert.equal(kept[0].action, 'skip-close'); assert.match(kept[0].why, /verify desk/); assert.deepEqual(actions, []);
  s.references = []; s.retirementHold = 'held by supervisor';
  assert.equal(executeRetirement(plan, { observe: () => s, removeLane: row => actions.push(row) })[0].action, 'held');
  assert.deepEqual(actions, []);
  delete s.retirementHold;
  const done = executeRetirement(planRetirement(s), { observe: () => s, removeLane: row => actions.push(row) });
  assert.equal(done[0].action, 'lane-removed'); assert.equal(actions.length, 1);
});

function removalSnapshot() {
  const s = fixture(); s.tabs = []; s.panes = []; s.agents = [];
  s.removal = { cwd: '/repo/lane', branch: 'lane/topic', tip: 'abc', integrated: true,
    archiveTag: null, evidence: { sha256: 'hash' } };
  return s;
}

for (const change of ['agent', 'record', 'workspace', 'tab', 'reference']) test(`lane removal ignores unrelated ${change} changes while global authority changes`, () => {
  const s = removalSnapshot();
  s.agents.push({ name: 'other', cwd: '/repo/other', pane_id: 'other:p', agent_status: 'working', state_change_seq: 1 });
  s.workspaces.push({ workspace_id: 'other', worktree: { checkout_path: '/repo/other' } });
  const plan = planRetirement(s);
  if (change === 'agent') Object.assign(s.agents[0], { agent_status: 'idle', state_change_seq: 2 });
  if (change === 'record') {
    s.record = fold([...s.events, { type: 'item.added', id: 'ENG-2', role: 'engineer', seq: 5 }]);
    s.record.revision = 5;
  }
  if (change === 'workspace') s.workspaces.push({ workspace_id: 'new', worktree: { checkout_path: '/repo/new' } });
  if (change === 'tab') s.tabs.push({ tab_id: 'other:t', workspace_id: 'other' });
  if (change === 'reference') s.references.push({ kind: 'other job', cwd: '/repo/other' });
  const fresh = planRetirement(s);
  assert.notEqual(fresh.token, plan.token);
  assert.equal(fresh.laneClose[0].token, plan.laneClose[0].token);
  const removed = [];
  const result = executeRetirement({ ...plan, close: [] }, { observe: () => s, removeLane: row => removed.push(row) });
  assert.equal(result[0].action, 'lane-removed'); assert.equal(removed.length, 1);
});

for (const change of ['pane', 'agent', 'run', 'terminal-run', 'chain', 'tip', 'archive', 'evidence', 'error', 'HOLD']) test(`lane removal rechecks its own ${change} authority`, () => {
  const s = removalSnapshot(), plan = planRetirement(s);
  if (change === 'pane') { s.tabs = fixture().tabs; s.panes = fixture().panes; }
  if (change === 'agent') s.agents = fixture().agents;
  if (change === 'run' || change === 'terminal-run') s.record.runs.set('R-2', { ...s.record.runs.get('R-1'), id: 'R-2', started: { seq: 10 },
    ...(change === 'run' ? { report: null } : {}) });
  if (change === 'chain') s.record.items.get('ENG-1').closed.as = 'dropped';
  if (change === 'tip') s.git[0].head = 'new-tip';
  if (change === 'archive') s.removal.archiveTag = 'archive/lane/topic';
  if (change === 'evidence') s.removal.evidence.sha256 = 'new-hash';
  if (change === 'error') s.errors.push('record unreadable; project kept');
  if (change === 'HOLD') s.retirementHold = 'held by supervisor';
  const fresh = planRetirement(s);
  assert.notEqual([...fresh.laneClose, ...fresh.laneKeep][0].token, plan.laneClose[0].token);
  const result = executeRetirement(plan, { observe: () => s, removeLane: () => assert.fail('changed lane authority') });
  assert.equal(result[0].action, change === 'HOLD' ? 'held' : 'skip-close');
  if (['terminal-run', 'chain', 'tip', 'archive', 'evidence'].includes(change)) assert.equal(result[0].why, 'authority changed since lane removal plan');
});

for (const ref of [{ global: true }, { item: 'ENG-1' }, { run: 'R-1' }, { lane: 'topic' },
  { cwd: '/repo' }, { cwd: '/repo/lane/child' }, { head: 'abc' }, { label: 'job /repo/lane' }]) test(`lane removal retains a new matching reference: ${JSON.stringify(ref)}`, () => {
  const s = removalSnapshot(), plan = planRetirement(s);
  s.references.push({ kind: 'new callback', ...ref });
  const result = executeRetirement(plan, { observe: () => s, removeLane: () => assert.fail('new lane reference') });
  assert.equal(result[0].action, 'skip-close'); assert.match(result[0].why, /new callback reference/);
});

for (const change of ['pane', 'agent', 'tree', 'raw-tree']) test(`lane keep token binds its own ${change} even when the reason stays occupied`, () => {
  const s = fixture(); s.removal = removalSnapshot().removal;
  const before = planRetirement(s).laneKeep[0];
  if (change === 'pane') s.panes[0].terminal_id = 'changed-terminal';
  if (change === 'agent') s.agents[0].state_change_seq++;
  if (change === 'tree') s.panes[0].process_info.process_tree[0].identity = 'new-birth';
  if (change === 'raw-tree') s.panes[0].process_info.process_tree_raw = [{ pid: 99, identity: 'new', command: '[job]', state: 'Z' }];
  const after = planRetirement(s).laneKeep[0];
  assert.equal(after.why, before.why); assert.notEqual(after.token, before.token);
});

function nativeHelpers(s) {
  s.agents[0].agent = 'codex';
  const info = s.panes[0].process_info;
  info.foreground_processes = [{ name: 'codex', pid: 10 }];
  info.process_tree[1].command = '[codex]';
  info.process_tree[1].ppid = info.shell_pid;
  info.process_tree.push({ pid: 20, ppid: 10, identity: 'helper', state: 'S', command: '[node]' });
  return s;
}
function bareShell(s) {
  const p = s.panes[0], info = p.process_info;
  p.shellOnly = true; info.process_tree = [info.process_tree[0]];
  info.foreground_processes = [{ pid: info.shell_pid, name: 'zsh' }];
}

test('native exit wait is bounded and never escalates to a close or a process signal', () => {
  const s = nativeHelpers(fixture()), plan = planRetirement(s);
  assert.equal(plan.close[0].decision, 'exit');
  let clock = 0, sends = 0;
  const results = executeRetirement(plan, { observe: () => s, exit: () => sends++,
    now: () => clock, pause: ms => { clock += ms; }, exitTimeoutMs: 60000,
    close: () => assert.fail('an agent that did not exit must remain') });
  assert.equal(clock, 60000); assert.equal(sends, 1);
  assert.equal(results[0].decision, 'keep'); assert.equal(results[0].why, 'agent did not exit through its exit command');
});

for (const change of ['reference', 'focus', 'HOLD', 'working', 'session', 'shell', 'background', 'foreground-shell']) test(`native exit's final ordinary plan keeps a newly changed ${change}`, () => {
  const s = nativeHelpers(fixture()), plan = planRetirement(s);
  let reads = 0, sends = 0, closes = 0;
  const result = executeRetirement(plan, { observe: () => {
    if (++reads === 3) {
      if (change === 'reference') s.references.push({ pane: 'w:p', kind: 'new job' });
      if (change === 'focus') s.tabs[0].focused = true;
      if (change === 'HOLD') s.retirementHold = 'new hold';
      if (change === 'working') s.agents[0].agent_status = 'working';
      if (change === 'session') s.agents[0].agent_session.value = 'replacement';
      if (change === 'shell') s.panes[0].process_info.process_tree[0].identity = 'new shell';
      if (change === 'background') s.panes[0].process_info.process_tree.push({ pid: 99, identity: 'job', state: 'S', command: '[job]' });
      if (change === 'foreground-shell') {
        s.panes[0].process_info.process_tree.push({ pid: 99, ppid: 5, identity: 'job', state: 'S', command: '[zsh]' });
        s.panes[0].process_info.foreground_processes = [{ pid: 99, name: 'zsh' }];
      }
    }
    return s;
  }, exit: () => { sends++; bareShell(s); }, close: () => { closes++; } });
  assert.equal(sends, 1); assert.equal(closes, 0); assert.equal(result[0].decision, 'keep'); assert.equal(result[0].action, 'skip-close');
});

test('a stale native exit token cannot send input to a shell or a different process tree', () => {
  for (const change of ['shell', 'parent', 'birth']) {
    const s = nativeHelpers(fixture()), plan = planRetirement(s);
    let sends = 0, closes = 0;
    if (change === 'shell') bareShell(s);
    if (change === 'parent') s.panes[0].process_info.process_tree[2].ppid = 5;
    if (change === 'birth') s.panes[0].process_info.process_tree[2].identity = 'new birth';
    const result = executeRetirement(plan, { observe: () => s, exit: () => { sends++; }, close: () => { closes++; } });
    assert.equal(sends, 0); assert.equal(closes, 0);
    assert.equal(result[0].action, 'skip-close');
  }
});
