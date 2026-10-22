import test from './helpers/bounded-test.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fold } from '../lib/state.mjs';
import { loadEvents } from '../lib/store.mjs';
import { paneReleaseEvents } from '../lib/retire-command.mjs';
import { executeRetirement, planRetirement } from '../lib/retire.mjs';
import { SESSION_RELEASE_POLICY } from '../lib/session-release.mjs';
import { fixture } from './helpers/retire-fixture.mjs';

const oldHead = 'a'.repeat(40), landedHead = 'b'.repeat(40);
const shell = () => ({ pid: 5, identity: 'original-shell-birth', command: '[zsh]', state: 'S' });
const processInfo = () => ({ shell_pid: 5, process_tree_complete: true,
  foreground_processes: [{ pid: 5, name: 'zsh' }], process_tree: [shell()] });
const nextMeta = meta => ({ ...meta, agent: 'successor', pane: 'w:q', terminal_id: 'next-terminal', agent_session_id: 'next-session' });
const target = plan => [...plan.close, ...plan.keep].find(row => row.tab_id === 'w:t');

function snapshot() {
  const meta = { agent: 'worker', pane: 'w:p', worker_workspace: 'w', terminal_id: 'terminal', agent_session_id: 'session', lane: 'topic' };
  const events = [
    { type: 'item.added', id: 'ENG-1', role: 'engineer', kind: 'work' },
    { type: 'run.started', id: 'R-1', item: 'ENG-1', workspace: '/repo/lane', meta },
    { type: 'report.ingested', run: 'R-1', report: { outcome: 'done' } },
    { type: 'retirement.release', run: 'R-1', item: 'ENG-1', pane: 'w:p', terminal: 'terminal', session: 'session',
      workspace: 'w', cwd: '/repo/lane', head: oldHead, confirmed: true, policy: SESSION_RELEASE_POLICY },
    { type: 'run.started', id: 'R-2', item: 'ENG-1', workspace: '/repo/lane', meta: nextMeta(meta) },
    { type: 'report.ingested', run: 'R-2', report: { outcome: 'done' } },
    { type: 'item.closed', id: 'ENG-1', as: 'done' },
    { type: 'promotion.reconciled', identity: '/repo/.git', runs: ['R-2'],
      heads: [{ run: 'R-2', item: 'ENG-1', head: landedHead }] },
  ].map((e, i) => ({ ...e, seq: i + 1 }));
  return { common: '/repo/.git', events, record: fold(events), sessionReleasePolicy: true,
    releases: [events[3]], references: [], handoffs: [], errors: [],
    git: [{ common: '/repo/.git', path: '/repo/lane', head: landedHead, lane: 'topic', clean: true, integrated: true }],
    workspaces: [{ workspace_id: 'w', worktree: { checkout_path: '/repo/lane', repo_key: '/repo/.git', is_linked_worktree: true } }],
    tabs: [{ tab_id: 'w:t', workspace_id: 'w' }],
    panes: [{ pane_id: 'w:p', tab_id: 'w:t', workspace_id: 'w', terminal_id: 'terminal', shellOnly: true, process_info: processInfo() }],
    agents: [{ name: 'worker', agent: 'codex', agent_status: 'idle', pane_id: 'w:p', tab_id: 'w:t', workspace_id: 'w',
      terminal_id: 'terminal', agent_session: { value: 'session' }, cwd: '/repo/lane' }] };
}

test('a superseded released bare shell closes against the exact landed successor head without refreshing its release', () => {
  const s = snapshot(), before = structuredClone(s), closed = [], plan = planRetirement(s);
  assert.equal(target(plan).decision, 'release');
  assert.match(target(plan).why, /exact session and reverified landed head/);
  assert.equal(plan.sessionReleases?.length ?? 0, 0);
  const result = executeRetirement(plan, { observe: () => structuredClone(s), close: id => closed.push(id),
    exit: () => assert.fail('a stale release cannot authorize native exit') });
  assert.deepEqual(closed, ['w:t']); assert.equal(result[0].action, 'closed');
  assert.deepEqual(s, before, 'neither the release nor the record is rewritten');
  assert.equal(s.releases[0].head, oldHead);
});

const refusals = [
  ['unlanded lane', s => { s.git[0].integrated = false; }],
  ['archived unlanded lane', s => { s.git[0].integrated = false; s.git[0].archived = true; }],
  ['dirty lane', s => { s.git[0].clean = false; }],
  ['different repository', s => { s.git[0].common = '/foreign/.git'; }],
  ['different lane', s => { s.git[0].lane = 'other'; }],
  ['missing successor', s => { s.record.runs.delete('R-2'); }],
  ['different successor item', s => { s.record.runs.get('R-2').item = 'ENG-2'; }],
  ['different successor checkout', s => { s.record.runs.get('R-2').workspace = '/repo/other'; }],
  ['different successor lane', s => { s.record.runs.get('R-2').meta.lane = 'other'; }],
  ['unreported successor', s => { s.record.runs.get('R-2').report = null; }],
  ['failed successor', s => { s.record.runs.get('R-2').report.outcome = 'failed'; }],
  ['abandoned successor', s => { s.record.runs.get('R-2').abandoned = { seq: 9 }; }],
  ['newer unlanded round', s => {
    const next = s.record.runs.get('R-2');
    s.record.runs.set('R-3', { ...next, id: 'R-3', started: { seq: 9 }, report: { seq: 10, outcome: 'done' },
      meta: { ...next.meta, agent: 'third', pane: 'w:r', terminal_id: 'third-terminal', agent_session_id: 'third-session' } });
  }],
  ['missing integration receipt', s => { s.events.pop(); }],
  ['foreign integration receipt', s => { s.events.at(-1).identity = '/foreign/.git'; }],
  ['wrong integrated run', s => { s.events.at(-1).runs = ['R-999']; }],
  ['wrong receipt head run', s => { s.events.at(-1).heads[0].run = 'R-999'; }],
  ['wrong receipt head item', s => { s.events.at(-1).heads[0].item = 'ENG-999'; }],
  ['wrong receipt head', s => { s.events.at(-1).heads[0].head = oldHead; }],
  ['integration before release', s => { s.events.at(-1).seq = s.releases[0].seq; }],
  ['integration before successor report', s => { s.events.at(-1).seq = s.record.runs.get('R-2').report.seq; }],
  ['unreported original run', s => { s.record.runs.get('R-1').report = null; }],
  ['abandoned unreported original run', s => {
    s.events[2] = { type: 'run.abandoned', id: 'R-1', seq: s.events[2].seq };
    s.record = fold(s.events);
  }],
  ['item awaiting correction', s => {
    s.record.items.get('ENG-1').closed = null; s.record.runs.get('R-2').report.outcome = 'blocked';
  }],
  ['open review', s => { s.record.items.set('REV-1', { id: 'REV-1', parent: 'ENG-1', role: 'reviewer' }); }],
  ['live callback', s => { s.references.push({ run: 'R-1', kind: 'watcher callback' }); }],
  ['successor callback', s => { s.references.push({ item: 'ENG-1', run: 'R-2', kind: 'pending callback' }); }],
  ['retained handoff successor', s => {
    const old = s.record.runs.get('R-1');
    s.record.runs.set('R-0', { ...old, id: 'R-0', started: { seq: 1 }, meta: {
      ...old.meta, agent: 'predecessor', pane: 'w:prior', terminal_id: 'prior-terminal', agent_session_id: 'prior-session' } });
    s.agents.push({ ...s.agents[0], name: 'predecessor', pane_id: 'w:prior', tab_id: 'w:prior-tab',
      terminal_id: 'prior-terminal', agent_session: { value: 'prior-session' } });
    s.handoffs.push({ from: 'R-0', to: 'R-1', confirmed: true, seq: 9 });
  }],
  ['replacement session', s => { s.agents[0].agent_session.value = 'replacement'; }],
  ['replacement terminal', s => { s.agents[0].terminal_id = s.panes[0].terminal_id = 'replacement'; }],
  ['replacement pane', s => { s.agents[0].pane_id = s.panes[0].pane_id = 'w:replacement'; }],
  ['mismatched pane terminal', s => { s.panes[0].terminal_id = 'replacement'; }],
  ['live foreground agent', s => {
    s.panes[0].shellOnly = false;
    s.panes[0].process_info.foreground_processes = [{ pid: 10, name: 'codex' }];
    s.panes[0].process_info.process_tree.push({ pid: 10, ppid: 5, identity: 'agent', command: '[codex]', state: 'S' });
  }],
  ['background process', s => { s.panes[0].process_info.process_tree.push({ pid: 10, identity: 'job', command: '[sleep]', state: 'S' }); }],
  ['raw zombie child', s => { s.panes[0].process_info.process_tree_raw = [shell(), { pid: 10, identity: 'job', command: '[sleep]', state: 'Z' }]; }],
  ['incomplete process tree', s => { s.panes[0].process_info.process_tree_complete = false; }],
  ['non-shell process', s => { s.panes[0].process_info.process_tree[0].command = '[sleep]'; }],
  ['foreground birth disagreement', s => { s.panes[0].process_info.foreground_processes[0].identity = 'replacement'; }],
  ['ambiguous terminal', s => { s.panes.push({ pane_id: 'w:other', tab_id: 'w:other-tab', terminal_id: 'terminal' }); }],
  ['operator focus', s => { s.tabs[0].focused = true; }],
  ['retirement hold', s => { s.retirementHold = 'held by owner'; }],
  ['operator workspace', s => { s.workspaces[0].operator = true; }],
  ['unread evidence', s => { s.errors.push('record unreadable'); }],
];
for (const field of ['pane', 'terminal_id', 'agent_session_id']) {
  refusals.push([`successor reusing ${field}`, s => { s.record.runs.get('R-2').meta[field] = s.record.runs.get('R-1').meta[field]; }]);
  refusals.push([`another item reusing ${field}`, s => {
    const meta = { ...nextMeta(s.record.runs.get('R-1').meta), agent: 'reuser', pane: 'w:reuse', terminal_id: 'reuse-terminal', agent_session_id: 'reuse-session' };
    meta[field] = s.record.runs.get('R-1').meta[field];
    s.record.runs.set('R-3', { id: 'R-3', item: 'ENG-3', workspace: '/repo/lane', meta, started: { seq: 9 }, report: { seq: 10, outcome: 'done' } });
  }]);
}
for (const [name, change] of refusals) test(`a stale release keeps on ${name} in planning and at execution`, () => {
  const s = snapshot(), plan = planRetirement(s); change(s);
  assert.equal(target(plan).decision, 'release', 'positive control must reach the new path');
  assert.equal(target(planRetirement(s)).decision, 'keep');
  const result = executeRetirement(plan, { observe: () => s, close: () => assert.fail('must keep original pane'),
    exit: () => assert.fail('must not send native input') });
  assert.equal(result[0].decision, 'keep');
  assert.ok(['skip-close', 'held'].includes(result[0].action));
});

test('a different but still bare shell birth cannot reuse the landed-head plan', () => {
  const s = snapshot(), plan = planRetirement(s);
  s.panes[0].process_info.process_tree[0].identity = 'replacement-shell-birth';
  assert.equal(target(planRetirement(s)).decision, 'release');
  const result = executeRetirement(plan, { observe: () => s, close: () => assert.fail('shell changed since plan') });
  assert.equal(result[0].action, 'skip-close'); assert.match(result[0].why, /authority changed/);
});

function landedFixture(t, { exited = false, landed = true } = {}) {
  const f = fixture(t, { merged: false });
  const events = loadEvents(f.org).events.filter(e => e.type !== 'item.closed');
  const append = more => {
    events.push(...more.map((e, i) => ({ ...e, seq: events.length + i + 1 })));
    fs.writeFileSync(f.eventFile, events.map(e => JSON.stringify(e) + '\n').join(''));
  };
  append(paneReleaseEvents(events, 'R-1', { session: 'session', terminal: 'term', pane: 'w:p', head: f.head,
    authority: 'fixture supervisor', next: 'continue at successor', unresolved: 'lane work',
    evidence: ['fixture release'], confirm: true, why: 'old round finished' }).add);
  f.state.agents[0].agent_status = 'idle';
  Object.assign(f.state.panes[0], { terminal_id: 'term', foreground_cwd: f.lane });
  f.state.info = processInfo(); f.save();
  assert.equal(target(f.retirement().plan()).decision, 'release', 'the original head release works before the next commit');
  append([
    { type: 'run.started', id: 'R-2', item: 'ENG-1', workspace: f.lane, meta: nextMeta(events[1].meta) },
    { type: 'report.ingested', run: 'R-2', report: { outcome: 'done' } },
  ]);
  fs.writeFileSync(path.join(f.lane, 'seed'), 'successor fix'); f.git(['commit', '-am', 'successor fix'], f.lane);
  const head = f.git(['rev-parse', 'HEAD'], f.lane);
  if (landed) {
    f.git(['merge', '--ff-only', head]);
    append([{ type: 'item.closed', id: 'ENG-1', as: 'done' },
      { type: 'promotion.reconciled', identity: f.common, batch: 'successor', runs: ['R-2'], items: ['ENG-1'],
        heads: [{ run: 'R-2', item: 'ENG-1', head }] }]);
  }
  if (exited) {
    const agent = f.state.agents[0], { pid, identity, command } = f.state.info.process_tree[0];
    const directory = path.join(f.org, 'retirement/exits'); fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(directory, 'prior-exit.json'), JSON.stringify({ schema: 'retirement-exit/v1',
      common: f.common, cwd: f.lane, workspace: 'w', tab: 'w:t', pane: 'w:p', run: 'R-1', shell: { pid, identity, command },
      occupant: { name: agent.name, agent: agent.agent, pane_id: 'w:p', workspace_id: 'w', cwd: f.lane,
        terminal_id: 'term', agent_session_id: 'session' } }));
    f.state.agents = []; f.save();
  }
  return { ...f, landedHead: head };
}

for (const exited of [false, true]) test(`runtime closes the released old bare shell after its successor lands (${exited ? 'observed exit' : 'retained registry'})`, t => {
  const f = landedFixture(t, { exited }), r = f.retirement(), before = fs.readFileSync(f.eventFile, 'utf8');
  const plan = r.plan(); assert.equal(target(plan).decision, 'release');
  assert.equal(plan.sessionReleases?.length ?? 0, 0);
  const result = r.apply(plan);
  assert.equal(result.find(row => row.tab_id === 'w:t').action, 'closed', JSON.stringify(result));
  assert.deepEqual(f.read().actions, [['tab', 'close', 'w:t']], 'no exit prompt or fresh release is needed');
  assert.equal(fs.readFileSync(f.eventFile, 'utf8'), before);
  assert.equal(loadEvents(f.org).events.find(e => e.type === 'retirement.release').head, f.head);
  assert.notEqual(f.head, f.landedHead);
  assert.equal(fs.existsSync(f.lane), true, 'the tab exception cannot remove the lane');
});

for (const change of ['unlanded', 'session', 'pane', 'foreground']) test(`runtime refuses the old release with ${change}`, t => {
  const f = landedFixture(t, { landed: change !== 'unlanded' }), r = f.retirement(), plan = r.plan();
  if (change === 'session') f.state.agents[0].agent_session.value = 'replacement';
  if (change === 'pane') f.state.agents[0].pane_id = f.state.panes[0].pane_id = 'w:replacement';
  if (change === 'foreground') {
    f.state.info.foreground_processes = [{ pid: 10, name: 'native' }];
    f.state.info.process_tree.push({ pid: 10, ppid: 5, identity: 'agent', command: '[native]', state: 'S' });
  }
  f.save();
  assert.equal(target(r.plan()).decision, 'keep');
  r.apply(plan);
  assert.deepEqual(f.read().actions, []);
  assert.equal(fs.existsSync(f.lane), true);
});
