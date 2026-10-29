import test from './helpers/bounded-test.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fold } from '../lib/state.mjs';
import { planRetirement } from '../lib/retire.mjs';
import { classifyRetirement, retirementStatus, renderRetirementStatus, RETIREMENT_CLASSES } from '../lib/retire-status.mjs';
import { readRetirementStatus, readRetirementWorktrees, writeRetirementStatus } from '../lib/retire-runtime.mjs';
import { copyProduct } from '../lib/product-files.mjs';

const root = path.resolve(import.meta.dirname, '..');
function fixture() {
  const events = [
    { type: 'item.added', id: 'ENG-1', role: 'engineer', kind: 'work' },
    { type: 'run.started', id: 'R-1', item: 'ENG-1', workspace: '/repo/lane', meta: {
      agent: 'worker', pane: 'w:p', worker_workspace: 'w', terminal_id: 'term', agent_session_id: 'session', lane: 'topic' } },
    { type: 'report.ingested', run: 'R-1', report: { outcome: 'done' } },
    { type: 'item.closed', id: 'ENG-1', as: 'done' },
  ].map((e, i) => ({ ...e, seq: i + 1, at: '2026-01-01T00:00:00Z' }));
  return { common: '/repo/.git', record: fold(events),
    workspaces: [{ workspace_id: 'w', worktree: { checkout_path: '/repo/lane', repo_key: '/repo/.git', is_linked_worktree: true } }],
    git: [{ path: '/repo/lane', common: '/repo/.git', lane: 'topic', head: 'abc', clean: true, integrated: true }],
    tabs: [{ tab_id: 'w:t', workspace_id: 'w' }],
    panes: [{ pane_id: 'w:p', tab_id: 'w:t', workspace_id: 'w', shellOnly: false, process_info: {
      shell_pid: 1, foreground_processes: [{ pid: 2, name: 'native', argv0: '/bin/native' }], process_tree_complete: true,
      process_tree: [{ pid: 1, command: '[zsh]', identity: 'shell', state: 'S' }, { pid: 2, command: '[native]', identity: 'agent', state: 'S' }] } }],
    agents: [{ name: 'worker', agent: 'native', agent_status: 'done', pane_id: 'w:p', tab_id: 'w:t', workspace_id: 'w',
      cwd: '/repo/lane', terminal_id: 'term', agent_session: { value: 'session' } }], references: [], errors: [], handoffs: [] };
}
const run = s => s.record.runs.get('R-1');
const item = s => s.record.items.get('ENG-1');
const tab = s => retirementStatus(s).rows.find(r => r.type === 'tab');

test('all six classes are reached through real planner fixture snapshots', () => {
  const cases = [
    ['TERMINAL', () => {}],
    ['ACTIVE', s => { s.agents[0].agent_status = 'working'; }],
    ['WAITING', s => { item(s).closed = null; s.git[0].integrated = false; }],
    ['IDLE-NONTERMINAL', s => { item(s).closed = null; s.git[0].integrated = false; s.record.runs.set('R-2', { ...run(s), id: 'R-2', started: { seq: 8 }, meta: { ...run(s).meta, agent: 'new-worker', pane: 'new:p', agent_session_id: 'new-session' } }); }],
    ['UNKNOWN', s => { run(s).meta.terminal_id = 'replacement'; }],
    ['PROTECTED', s => { s.tabs[0].focused = true; }],
  ];
  assert.deepEqual(cases.map(([name]) => name).sort(), [...RETIREMENT_CLASSES].sort());
  for (const [name, mutate] of cases) {
    const s = fixture(); mutate(s);
    const before = structuredClone(s), status = retirementStatus(s);
    assert.equal(status.rows.length, 2);
    assert.deepEqual(status.rows.map(r => r.class), [name, name]);
    assert.equal(status.counts[name], 2);
    assert.deepEqual(s, before, 'display must not mutate the authority snapshot');
    assert.equal(status.rows[1].run, name === 'UNKNOWN' ? null : 'R-1');
  }
});

test('hold overlay preserves the real hold and shows the underlying class and reason', () => {
  const s = fixture(); s.retirementHold = 'retirement held: fixture';
  assert.equal(planRetirement(s).keep[0].why, s.retirementHold);
  const status = retirementStatus(s);
  assert.equal(status.held, s.retirementHold);
  assert.equal(status.rows[0].held, s.retirementHold);
  assert.equal(status.rows[0].class, 'TERMINAL');
  assert.match(status.rows[0].reason, /terminal chain/);
  assert.equal(planRetirement(s).keep[0].why, s.retirementHold);
  assert.match(renderRetirementStatus(status), /Held\s+Reason/);
});

test('unmapped reasons and arbitrary observation errors stay UNKNOWN, with concrete keep reasons', () => {
  const s = fixture();
  for (const why of ['new planner guard', 'unknown watcher callback reference R-1']) {
    const result = classifyRetirement({ decision: 'keep', why }, { snapshot: s, agents: s.agents });
    assert.equal(result.class, 'UNKNOWN'); assert.equal(result.nextAction, `keep; ${why}`);
  }
  s.errors = ['occupant worker is working'];
  assert.equal(tab(s).class, 'UNKNOWN', 'errors cannot masquerade as a known reason');
  const tree = retirementStatus(fixture(), { worktrees: [{ worktree: '/repo/unreadable', error: 'Git unavailable', paneCount: 0 }] }).rows.find(r => r.type === 'worktree');
  assert.equal(tree.class, 'UNKNOWN'); assert.equal(tree.nextAction, 'keep; Git unavailable');
});

test('ignored expired-reference diagnostics do not invent a keep when the planner releases', () => {
  const s = fixture(); s.diagnostics = [{ reason: 'expired reference ignored' }];
  const status = retirementStatus(s), note = status.rows.find(r => r.type === 'diagnostic');
  assert.equal(status.counts.TERMINAL, 2); assert.equal(status.counts.UNKNOWN, 0);
  assert.equal(note.class, null); assert.equal(note.nextAction, 'diagnostic only; no live hold');
});

// This inventory is bound to the planner's reason expressions below. New wording
// must receive an explicit expected class, including reasons mapped to UNKNOWN.
const reasonCases = [
  ['review, correction or integration chain is still open', 'WAITING'],
  ['unknown chain item ${id}', 'UNKNOWN', 'unknown chain item ENG-1'],
  ['open run on ${id}', 'ACTIVE', 'open run on ENG-1'],
  ['${id} awaits correction or disposition', 'WAITING', 'ENG-1 awaits correction or disposition'],
  ['declined blocker ${id}', 'WAITING', 'declined blocker HUM-1'],
  ['review ${id} has no terminal PASS', 'WAITING', 'review REV-1 has no terminal PASS'],
  ['chain item ${id} has no recorded disposition', 'WAITING', 'chain item ENG-1 has no recorded disposition'],
  ["${ref.kind ?? 'live'} reference ${ref.job ?? ref.owner ?? ''}", 'ACTIVE', 'host-check reference job'],
  ['unnamed operator occupant', 'UNKNOWN'],
  ["occupant ${agent.name} is ${agent.agent_status ?? agent.status ?? 'unknown'}", 'ACTIVE', 'occupant worker is working'],
  ['ambiguous recorded launch identity for ${agent.name}', 'UNKNOWN', 'ambiguous recorded launch identity for worker'],
  ['unknown or mismatched recorded launch identity for ${agent.name}', 'UNKNOWN', 'unknown or mismatched recorded launch identity for worker'],
  ['unknown recorded native session identity for ${agent.name}', 'UNKNOWN', 'unknown recorded native session identity for worker'],
  ['retained successor for handoff from ${incoming.from}', 'ACTIVE', 'retained successor for handoff from R-2'],
  ['release for ${run.id} is stale: head moved', 'UNKNOWN', 'release for R-1 is stale: head moved'],
  ['${run.id} report is not ingested', 'ACTIVE', 'R-1 report is not ingested'],
  ['${run.id} awaits correction or disposition', 'WAITING', 'R-1 awaits correction or disposition'],
  ['handoff successor is not retained with its recorded launch identity', 'UNKNOWN'],
  ['open run in lane', 'ACTIVE'],
  ['unknown or mismatched Git identity', 'UNKNOWN'],
  ['lane is not clean and integrated or archived', 'UNKNOWN'],
  ['unknown standard-slot protection evidence; project kept', 'UNKNOWN'],
  ['mismatched standard-slot protection identity; project kept', 'UNKNOWN'],
  ['adopted standard slot ${slot.standardSlot} (${slot.uid}); explicit withdrawal required', 'PROTECTED', 'adopted standard slot chat (desk); explicit withdrawal required'],
  ['callback launch topology changed', 'UNKNOWN'],
  ['reviewer same-session follow-up is expected', 'ACTIVE'],
  ['recorded callback process is still live or unknown', 'UNKNOWN'],
  ['callback has another, working or unknown occupant', 'UNKNOWN'],
  ['self-retiring watcher has an agent occupant', 'UNKNOWN'],
  ['callback shell or process identity changed, or another process remains', 'UNKNOWN'],
  ['callback checkout is not clean and integrated or archived', 'UNKNOWN'],
  ['callback report is not ingested', 'ACTIVE'],
  ['watcher has no recorded run', 'UNKNOWN'],
  ['open run uses callback checkout', 'ACTIVE'],
  ['agent exit topology changed', 'UNKNOWN'],
  ['agent exit terminal identity changed or unknown', 'UNKNOWN'],
  ['agent exit occupant identity changed', 'UNKNOWN'],
  ['agent exit shell identity changed or another process remains', 'UNKNOWN'],
  ['agent exit recorded launch identity changed', 'UNKNOWN'],
  ['agent exit checkout is not clean and integrated or archived', 'UNKNOWN'],
  ['ambiguous agent exit receipts', 'UNKNOWN'],
  ['inert shell is not the sole pane of its tab', 'UNKNOWN'],
  ['inert shell process or terminal observation is incomplete', 'UNKNOWN'],
  ['inert shell terminal identity is unknown', 'UNKNOWN'],
  ['inert shell foreground is not the login shell or another process remains', 'UNKNOWN'],
  ['inert shell cwd differs from lane', 'UNKNOWN'],
  ['initial shell launch identity changed', 'UNKNOWN'],
  ['inert shell has a later occupant claim', 'UNKNOWN'],
  ['inert shell has a live or unknown claim holder', 'UNKNOWN'],
  ['inert shell record or references were not read', 'UNKNOWN'],
  ['inert shell checkout is not clean and integrated or archived', 'UNKNOWN'],
  ['ambiguous initial shell receipts', 'UNKNOWN'],
  ['inert shell has no terminal chain and lane history is fresh or unknown', 'UNKNOWN'],
  ['operator focus or this tab', 'PROTECTED'],
  ['persistent, operator or lab workspace', 'PROTECTED'],
  ['persistent or detached desk workspace', 'PROTECTED'],
  ['unknown occupant or unrecorded shell', 'UNKNOWN'],
  ['wrong or unknown canonical repository identity', 'UNKNOWN'],
  ['agent and pane topology disagree', 'UNKNOWN'],
  ['unknown or unrecorded shell occupant', 'UNKNOWN'],
  ['unknown occupant process state', 'UNKNOWN'],
  ['background or unknown pane process remains', 'UNKNOWN'],
  ['kernel process differs from foreground observation', 'UNKNOWN'],
  ['another or unknown foreground process is here', 'UNKNOWN'],
  ['occupant cwd differs from lane', 'UNKNOWN'],
  ['agent kind has no declared exit command', 'UNKNOWN'],
  ['open recorded run uses lane', 'ACTIVE'],
  ['occupied lane; retire panes before removing the worktree', 'UNKNOWN'],
  ['unknown or mismatched registered lane identity', 'UNKNOWN'],
  ['lane worktree is not clean', null],
  ['lane tip is not integrated in main', null],
  ['lane tip is not integrated in main; archival retirement policy is off', null],
  ['archival retirement policy is unavailable; lane kept', 'UNKNOWN'],
  ['archival retirement Git snapshot changed; lane kept', 'UNKNOWN'],
  ['archival retirement Git observation is incomplete; lane kept', 'UNKNOWN'],
  ['archival retirement has unaccounted merge commits; lane kept', null],
  ['archival retirement has no matched patches; lane kept', null],
  ['archival retirement has unmatched changes; lane kept', null],
  ['archival lane has no commits of its own; dispatch preparation kept', null],
  ['lane has no commits of its own and no recorded terminal chain', null],
  ['lane branch history is unavailable and no recorded terminal chain', null],
  ['promotion queue cleanup pending; retry through queue', 'UNKNOWN'],
];
test('every planner reason expression is enumerated and mapped; source drift fails', () => {
  const source = fs.readFileSync(new URL('../lib/retire.mjs', import.meta.url), 'utf8');
  // Native exit observations return state labels, rather than planner reasons.
  const reasons = source.replace(source.slice(source.indexOf('function exitOccupantState'), source.indexOf('const exitObservation')), '');
  const policy = reasons.slice(0, reasons.indexOf('// One executor')) + reasons.slice(reasons.indexOf('export function laneRemovalReason'));
  const emitted = [...policy.matchAll(/\b(?:return|reason\s*(?:\?\?=|=))\s*('(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`)/g)].map(m => m[1].slice(1, -1));
  // Conditional returns emit either literal; inventory both identity guards.
  const conditional = /\breturn\s+\w+\s*\?\s*('(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`)\s*:\s*('(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`)/g;
  emitted.push(...[...policy.matchAll(conditional)].flatMap(m => m.slice(1).map(value => value.slice(1, -1))));
  assert.deepEqual([...new Set(emitted)].sort(), reasonCases.map(([expression]) => expression).sort());
  const s = fixture(); item(s).closed = null; s.references.push({ kind: 'host-check', job: 'job', owner: 'owner' });
  for (const [expression, expected, sample = expression] of reasonCases) {
    const result = classifyRetirement({ decision: 'keep', why: sample }, { snapshot: s, agents: s.agents });
    assert.equal(result.class, expected, expression);
    if (expected === 'UNKNOWN' || expected === null) assert.equal(result.nextAction, `keep; ${sample}`, expression);
  }
  for (const ambiguous of [false, true]) {
    const current = fixture();
    if (ambiguous) current.record.runs.set('R-2', { ...run(current), id: 'R-2' });
    else run(current).meta.terminal_id = 'replacement';
    const why = ambiguous ? 'ambiguous recorded launch identity for worker' : 'unknown or mismatched recorded launch identity for worker';
    assert.equal(planRetirement(current).keep[0].why, why);
    for (const row of retirementStatus(current).rows) {
      assert.equal(row.class, 'UNKNOWN'); assert.equal(row.run, null);
      assert.equal(row.nextAction, `keep; ${why}`);
    }
  }
  const releaseReasons = [
    'recorded initial shell; unchanged terminal and shell identity',
    'legacy inert-shell retirement',
    'recorded idle agent and its descendants; exit before closing the shell',
    '${exited.run}: recorded agent exit; unchanged terminal and shell identity',
    'recorded ${callback.kind} callback complete; unchanged process and shell identity',
    "record release for ${released.map(r => r.run).join(', ')}; exact session and ${released.some(r => r.head !== git.head) ? 'reverified landed head' : 'head'}",
    "${agents.map(a => matchingRun(a, snapshot.record)?.id).join(', ')}: ingested report; lane content released or terminal chain, or confirmed retained successor",
    'lane removal preconditions verified',
    'integrated lane eligible; preservation verified on apply',
    'archival lane eligible; exact archive and preservation verified on apply',
    'archive-tagged lane eligible; preservation verified on apply',
  ];
  const releases = [...policy.matchAll(/why: reason \?\? (?:\(inert \? initial \? ('[^']*') : ('[^']*') : needsExit \? ('[^']*') : exited \? (`[^`]*`) : callback \? (`[^`]*`) : released\.length \? (`[^`]*`) : (`[^`]*`)|\(candidate\.eligibility === 'archival-retirement' \?\s*('[^']*') : candidate\.eligibility === 'archive-tagged' \?\s*('[^']*') : ('[^']*')\)|('[^']*'))/g)].flatMap(m => m.slice(1).filter(Boolean).map(s => s.slice(1, -1)));
  assert.deepEqual(releases.sort(), releaseReasons.sort());
  for (const why of [
    ...releases,
    'record release for R-1; exact session and head',
    'record release for R-1; exact session and reverified landed head',
  ]) assert.equal(classifyRetirement({ decision: 'release', why }).class, 'TERMINAL', why);
});

test('a scoped malformed initial receipt is UNKNOWN with its explicit keep reason', () => {
  const why = 'initial shell receipt is malformed or unreadable';
  assert.deepEqual(classifyRetirement({ decision: 'keep', why }), { class: 'UNKNOWN', nextAction: `keep; ${why}` });
});

test('an exited worker shell is TERMINAL while changed exit evidence is UNKNOWN with its keep reason', () => {
  const s = fixture(), a = s.agents[0], p = s.panes[0], shell = p.process_info.process_tree[0];
  s.exits = [{ schema: 'retirement-exit/v1', common: s.common, cwd: a.cwd, workspace: 'w', tab: 'w:t', pane: 'w:p', run: 'R-1',
    occupant: { name: a.name, agent: a.agent, pane_id: a.pane_id, workspace_id: a.workspace_id, cwd: a.cwd,
      terminal_id: a.terminal_id, agent_session_id: a.agent_session.value },
    shell: { pid: shell.pid, identity: shell.identity, command: shell.command } }];
  s.agents = []; p.terminal_id = 'term'; p.shellOnly = true;
  p.process_info.process_tree = [shell]; p.process_info.foreground_processes = [{ pid: shell.pid, name: 'zsh' }];
  const pending = tab(s);
  assert.equal(pending.class, 'TERMINAL'); assert.match(pending.reason, /recorded agent exit/);
  assert.equal(pending.nextAction, 'terminal; retire through the guarded executor');
  for (const change of [
    current => { current.panes.push({ ...current.panes[0], pane_id: 'w:q' }); },
    current => { current.panes[0].terminal_id = 'replacement'; },
    current => { current.agents.push({ ...a, terminal_id: 'replacement' }); },
    current => { current.panes[0].process_info.process_tree[0].identity = 'replacement'; },
    current => { run(current).meta.terminal_id = 'replacement'; },
    current => { current.git[0].clean = false; },
    current => { current.exits.push(structuredClone(current.exits[0])); },
  ]) {
    const current = structuredClone(s); change(current);
    const row = tab(current);
    assert.equal(row.class, 'UNKNOWN'); assert.equal(row.nextAction, `keep; ${row.reason}`);
  }
});

test('latest worker and reviewer name the next actor; older idle contexts are release candidates', () => {
  const s = fixture(); item(s).closed = null;
  s.git[0].integrated = false;
  s.record.items.set('REV-1', { id: 'REV-1', parent: 'ENG-1', role: 'reviewer', closed: null });
  assert.match(tab(s).nextAction, /reviewer REV-1/);
  s.record.runs.set('R-2', { id: 'R-2', item: 'REV-1', started: { seq: 6 }, meta: { agent: 'review-owner' }, report: { seq: 7, outcome: 'done', extra: { verdict: 'FAIL' } } });
  assert.match(tab(s).nextAction, /fix owner worker/);
  s.record.items.set('HUM-1', { id: 'HUM-1', parent: 'ENG-1', role: 'human', closed: null });
  assert.match(tab(s).nextAction, /operator: answer HUM-1/);
  s.record.items.delete('HUM-1');
  run(s).report.outcome = 'needs_human';
  assert.match(tab(s).nextAction, /fix owner/);
  assert.doesNotMatch(tab(s).nextAction, /operator/);
  const newer = { ...run(s), id: 'R-3', started: { seq: 10 }, meta: { ...run(s).meta, agent: 'new-owner', pane: 'new:p', agent_session_id: 'new-session' } };
  s.record.runs.set('R-3', newer);
  assert.equal(tab(s).class, 'IDLE-NONTERMINAL');
  assert.match(tab(s).nextAction, /record pane-release/);
});

test('no-report, blocked occupant and exact live references are ACTIVE; unknown sources still keep', () => {
  const s = fixture(); run(s).report = null;
  assert.equal(tab(s).class, 'ACTIVE'); assert.match(tab(s).nextAction, /R-1 report/);
  s.agents[0].agent_status = 'blocked'; assert.equal(tab(s).class, 'ACTIVE');
  s.agents[0].agent_status = 'done'; run(s).report = { seq: 8, outcome: 'done' };
  for (const kind of ['pending promote', 'verify admitted or running', 'test-slot occupant', 'watcher callback', 'host-check']) {
    s.references = [{ kind, job: 'job', item: 'ENG-1', owner: 'resource-owner' }];
    assert.equal(tab(s).class, 'ACTIVE'); assert.match(tab(s).nextAction, /resource-owner \(job\)/);
  }
  s.references = [{ kind: 'unknown watcher callback', run: 'R-1' }]; assert.equal(tab(s).class, 'UNKNOWN');
});

test('unmatched launch names missing fields, never matches pane alone, and uses the newest candidate', () => {
  const s = fixture();
  for (const key of ['worker_workspace', 'terminal_id', 'agent_session_id']) delete run(s).meta[key];
  assert.equal(tab(s).class, 'UNKNOWN'); assert.equal(tab(s).run, null);
  assert.match(tab(s).reason, /worker_workspace, terminal_id, agent_session_id/);
  assert.match(tab(s).reason, /launcher must call dispatch\/record-worker.mjs/);
  s.record.runs.set('R-2', { ...run(s), id: 'R-2', started: { seq: 10 }, meta: { ...run(s).meta, worker_workspace: 'w' } });
  assert.match(tab(s).reason, /newest candidate R-2 lacks terminal_id, agent_session_id/);
  assert.doesNotMatch(tab(s).reason, /lacks worker_workspace/);
  run(s).meta.agent = 'other'; s.record.runs.delete('R-2');
  assert.equal(tab(s).run, null);
  assert.doesNotMatch(tab(s).reason, /newest candidate/, 'a pane id alone is not even a candidate');
});

test('background-process keeps display extra kernel comm names and no argv', () => {
  const s = fixture(), info = s.panes[0].process_info;
  info.process_tree.push(...['codex-code-mode-host', 'node', 'node_repl'].map((name, i) => ({ pid: 3 + i, identity: name, state: 'S', command: `[${name}]`, argv0: 'PLANTED-ARGV' })));
  info.process_tree.push({ pid: 6, identity: 'helper', state: 'S', command: '[helper with spaces]' },
    { pid: 7, identity: 'not-comm', state: 'S', command: 'node PLANTED-ARGV' },
    { pid: 8, identity: 'absolute-argv', state: 'S', command: '/opt/PLANTED-EXECUTABLE/bin/helper' });
  const row = tab(s);
  assert.equal(row.class, 'UNKNOWN');
  assert.match(row.reason, /extra kernel processes: codex-code-mode-host, node, node_repl/);
  assert.match(row.reason, /node_repl, helper with spaces, 2 unnamed$/);
  assert.doesNotMatch(JSON.stringify(retirementStatus(s)), /PLANTED-ARGV|PLANTED-EXECUTABLE/);
});

test('one row per tab and pane, including bare tabs and split panes; labels grant no protection', () => {
  const s = fixture(); s.tabs[0].label = 'operator chat astra';
  s.panes.push({ ...s.panes[0], pane_id: 'w:p2' });
  s.tabs.push({ tab_id: 'w:bare', workspace_id: 'w' });
  const rows = retirementStatus(s).rows;
  assert.equal(rows.filter(r => r.type === 'tab').length, 2);
  assert.equal(rows.filter(r => r.type === 'pane').length, 2);
  assert.ok(rows.every(r => r.class === 'UNKNOWN'));
  assert.match(rows[0].reason, /unrecorded shell occupant/);
});

function runtimeFixture(t, integrationBranch = 'main') {
  const scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'retire-status-')));
  t.after(() => fs.rmSync(scratch, { recursive: true, force: true }));
  const repo = path.join(scratch, 'repo'), lane = path.join(scratch, 'lane'), empty = path.join(scratch, 'empty'), org = path.join(scratch, 'record');
  fs.mkdirSync(repo); fs.mkdirSync(org);
  const env = { ...process.env, ORG_DIR: org, HERDR_MONITOR_FLEET: path.join(scratch, 'fleet'), HERDR_TAB_ID: '', HERDR_PANE_ID: '',
    MONITOR_TEST_SLOT_PATH: path.join(scratch, 'slot'), MONITOR_TEST_SLOT_COMPAT_PATH: path.join(scratch, 'slot'), XDG_STATE_HOME: path.join(scratch, 'state') };
  const git = (args, cwd = repo) => {
    const r = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8', env }); assert.equal(r.status, 0, r.stderr); return r.stdout.trim();
  };
  git(['init', '-qb', integrationBranch]); git(['config', 'user.name', 'Fixture']); git(['config', 'user.email', 'fixture@example.invalid']); git(['config', 'commit.gpgsign', 'false']);
  fs.writeFileSync(path.join(repo, 'seed'), 'base'); fs.writeFileSync(path.join(repo, '.gitignore'), '*.ignored\n');
  git(['add', '.']); git(['commit', '-qm', 'base']); git(['worktree', 'add', '-b', 'lane/topic', lane]); git(['worktree', 'add', '-b', 'lane/empty', empty]);
  git(['tag', 'archive/lane/empty']);
  fs.writeFileSync(path.join(empty, 'one.untracked'), 'retained'); fs.writeFileSync(path.join(empty, 'one.ignored'), 'retained too');
  const common = fs.realpathSync(path.join(repo, '.git')), s = fixture();
  s.common = common; s.workspaces[0].worktree = { ...s.workspaces[0].worktree, checkout_path: lane, repo_root: repo, repo_key: common };
  s.agents[0].cwd = lane;
  const file = path.join(scratch, 'herdr-state.json'), log = path.join(scratch, 'herdr-calls.jsonl'), herdr = path.join(scratch, 'herdr');
  const save = () => fs.writeFileSync(file, JSON.stringify(s)); save();
  fs.writeFileSync(herdr, `#!${process.execPath}
const fs=require('node:fs'),a=process.argv.slice(2),s=JSON.parse(fs.readFileSync(${JSON.stringify(file)}));
fs.appendFileSync(${JSON.stringify(log)},JSON.stringify(a)+'\\n');
let result;
if(a[0]==='workspace'&&a[1]==='list') result={workspaces:s.workspaces};
else if(a[0]==='tab'&&a[1]==='list') result={tabs:s.tabs};
else if(a[0]==='pane'&&a[1]==='list') result={panes:s.panes.map(({process_info,...p})=>p)};
else if(a[0]==='pane'&&a[1]==='process-info') result={process_info:s.panes.find(p=>p.pane_id===a.at(-1)).process_info};
else if(a[0]==='agent'&&a[1]==='list') result={agents:s.agents};
else { console.error('MUTATION OR UNEXPECTED COMMAND'); process.exit(2); }
console.log(JSON.stringify({result}));
`, { mode: 0o755 });
  const events = [
    { type: 'item.added', id: 'ENG-1', role: 'engineer', kind: 'work' },
    { type: 'run.started', id: 'R-1', item: 'ENG-1', workspace: lane, meta: { ...run(s).meta } },
    { type: 'report.ingested', run: 'R-1', report: { outcome: 'done' } },
    { type: 'item.closed', id: 'ENG-1', as: 'done' },
  ].map((e, i) => ({ ...e, seq: i + 1, at: '2026-01-01T00:00:00Z', by: 'fixture' }));
  const eventFile = path.join(org, 'events.jsonl'), eventBytes = events.map(e => JSON.stringify(e) + '\n').join(''); fs.writeFileSync(eventFile, eventBytes);
  const cli = (args = [], product = root) => spawnSync(process.execPath, [path.join(product, 'supervisor/retire.mjs'), 'status', '--repo', lane, '--org', org, '--herdr', herdr, ...args], { cwd: repo, env, encoding: 'utf8' });
  return { scratch, repo, lane, empty, common, org, env, s, save, herdr, log, git, cli, eventFile, eventBytes };
}

test('status JSON uses the shared snapshot and inventories every canonical worktree including an unoccupied one', t => {
  const f = runtimeFixture(t), r = f.cli(['--json']); assert.equal(r.status, 0, r.stderr);
  const status = JSON.parse(r.stdout);
  assert.equal(status.schema, 'lanes-status/v1'); assert.equal(status.project, f.repo); assert.ok(Number.isFinite(Date.parse(status.generatedAt)));
  assert.equal(status.rows.find(r => r.type === 'pane').run, 'R-1');
  const trees = status.rows.filter(r => r.type === 'worktree'); assert.equal(trees.length, 3);
  const unoccupied = trees.find(r => r.worktree === f.empty);
  assert.equal(unoccupied.paneCount, 0); assert.equal(unoccupied.branch, 'lane/empty');
  assert.equal(unoccupied.head, f.git(['rev-parse', 'HEAD']).slice(0, 12));
  assert.equal(unoccupied.integrated, true); assert.equal(unoccupied.clean, false);
  assert.equal(unoccupied.archiveTag, 'archive/lane/empty'); assert.equal(unoccupied.archiveMatchesHead, true);
  assert.equal(unoccupied.untracked, 1); assert.equal(unoccupied.ignored, 1);
  assert.equal(unoccupied.class, null); assert.match(unoccupied.nextAction, /keep; lane worktree is not clean/);
  assert.equal(trees.find(r => r.worktree === f.lane).paneCount, 1);
  fs.writeFileSync(path.join(f.empty, 'seed'), 'new commit'); f.git(['commit', '-am', 'unintegrated'], f.empty);
  const changed = JSON.parse(f.cli(['--json']).stdout).rows.find(r => r.worktree === f.empty);
  assert.equal(changed.integrated, false); assert.equal(changed.archiveMatchesHead, false);
});

test('ordinary dirty and unintegrated lanes stay unclassified; compact inventories never infer a sweep keep', () => {
  const snapshot = { common: '/repo/.git', workspaces: [], tabs: [], panes: [], agents: [], references: [], record: fold([]) };
  const lane = { worktree: '/repo/lane', identity: snapshot.common, linked: true, branch: 'lane/topic', tip: 'a'.repeat(40), head: 'a'.repeat(12), clean: true, integrated: true };
  for (const [delta, reason] of [[{ clean: false }, 'lane worktree is not clean'], [{ integrated: false }, 'lane tip is not integrated in main; archival retirement policy is off']]) {
    const status = retirementStatus(snapshot, { worktrees: [{ ...lane, ...delta }] }), row = status.rows[0];
    assert.equal(row.class, null); assert.equal(status.counts.UNKNOWN, 0);
    assert.ok(row.reason.startsWith(reason)); assert.equal(row.nextAction, `keep; ${reason}`);
  }
  const row = retirementStatus(snapshot, { worktrees: [{ ...lane, clean: null }] }).rows[0];
  assert.equal(row.class, null); assert.doesNotMatch(row.reason, /not clean/); assert.match(row.nextAction, /inventory only/);
});

test('option A worktree classes and actions follow the guarded planner only with explicit activation', () => {
  const s = fixture();
  s.workspaces = []; s.tabs = []; s.panes = []; s.agents = [];
  s.git = [];
  const lane = { worktree: '/repo/lane', identity: s.common, linked: true, branch: 'lane/topic',
    tip: 'a'.repeat(40), clean: true, integrated: true, hasOwnCommits: true, paneCount: 0 };
  for (const policy of [undefined, false, true]) {
    s.closeoutQueuePolicy = policy;
    item(s).closed = null;
    const row = retirementStatus(s, { worktrees: [lane] }).rows[0];
    assert.equal(row.class, policy ? 'TERMINAL' : null);
    assert.equal(row.nextAction, policy ? 'eligible for integrated-lane sweep; evidence and fresh authority verified on apply' :
      'keep; review, correction or integration chain is still open');
    item(s).closed = { as: 'done' };
    const terminal = retirementStatus(s, { worktrees: [lane] }).rows[0];
    assert.equal(terminal.class, policy ? 'TERMINAL' : null, 'legacy foreground candidates retain their inventory-only class');
    assert.match(terminal.nextAction, /^eligible for integrated-lane sweep/);
  }
});

test('retirement observes default-on canonical policy, ignoring a lane opt-in', t => {
  const f = runtimeFixture(t);
  fs.writeFileSync(f.eventFile, f.eventBytes.trim().split('\n').map(JSON.parse).filter(e => e.type !== 'item.closed')
    .map(e => JSON.stringify(e) + '\n').join(''));
  fs.appendFileSync(path.join(f.common, 'info/exclude'), '\n.lane.json\n');
  fs.writeFileSync(path.join(f.lane, '.lane.json'), '{"retirement":{"closeout_queue":true}}');
  const policyFile = path.join(f.repo, '.lane.json');
  for (const policy of [undefined, false, true, false]) {
    if (policy === undefined) fs.rmSync(policyFile, { force: true });
    else fs.writeFileSync(policyFile, JSON.stringify({ retirement: { closeout_queue: policy } }));
    const r = f.cli(['--json']); assert.equal(r.status, 0, r.stderr);
    const status = JSON.parse(r.stdout), tab = status.rows.find(row => row.type === 'tab');
    assert.equal(tab.class, policy !== false ? 'TERMINAL' : 'WAITING');
    assert.match(tab.reason, policy !== false ? /lane content released or terminal chain/ : /chain is still open/);
  }
  fs.writeFileSync(policyFile, '{"retirement":{"closeout_queue":"true"}}');
  const r = f.cli(['--json']); assert.equal(r.status, 0, r.stderr);
  const status = JSON.parse(r.stdout);
  assert.equal(status.rows.find(row => row.type === 'tab').class, 'UNKNOWN');
  assert.match(status.rows.find(row => row.type === 'tab').reason, /archival retirement policy is unavailable/);
  assert.ok(status.rows.some(row => row.type === 'diagnostic' && /closeout policy unreadable/.test(row.reason)));
});

for (const progress of ['dirty', 'unintegrated']) for (const problem of ['missing record', 'invalid reference']) {
  test(`${progress} lane inventory stays unclassified with ${problem}`, async t => {
    const f = runtimeFixture(t);
    if (progress === 'unintegrated') {
      fs.unlinkSync(path.join(f.empty, 'one.untracked'));
      fs.writeFileSync(path.join(f.empty, 'seed'), 'not merged'); f.git(['commit', '-am', 'in progress'], f.empty);
    }
    if (problem === 'missing record') fs.unlinkSync(f.eventFile);
    else {
      fs.mkdirSync(path.join(f.org, 'references')); fs.writeFileSync(path.join(f.org, 'references/bad.json'), '{}');
    }
    const status = await readRetirementStatus({ cwd: f.repo, org: f.org, herdr: f.herdr, env: f.env });
    const row = status.rows.find(row => row.type === 'worktree' && row.worktree === f.empty);
    assert.equal(row.class, null); assert.match(row.reason, progress === 'dirty' ? /lane worktree is not clean/ : /unmatched changes/);
    assert.match(row.nextAction, progress === 'dirty' ? /lane worktree is not clean/ : /unmatched changes/);
    assert.ok(status.rows.some(row => row.type === 'diagnostic' && /missing or unreadable|invalid herdr-reference/.test(row.reason)));
  });
}

for (const problem of ['no discovered record', 'missing record file', 'ambiguous binding', 'wrong record binding', 'fleet discovery error']) {
  test(`status retains tab and pane inventory with ${problem}`, async t => {
    const f = runtimeFixture(t);
    fs.unlinkSync(path.join(f.empty, 'one.untracked'));
    fs.writeFileSync(path.join(f.empty, 'seed'), 'completed work'); f.git(['commit', '-am', 'completed work'], f.empty);
    f.git(['merge', '--ff-only', 'lane/empty']);
    let org = f.org, reason;
    if (problem === 'no discovered record') { org = undefined; f.env.ORG_DIR = ''; reason = /retirement record is missing or unreadable; lane kept/; }
    if (problem === 'missing record file') { fs.unlinkSync(f.eventFile); reason = /retirement record is missing or unreadable; lane kept/; }
    if (['ambiguous binding', 'wrong record binding'].includes(problem)) {
      const entry = { identity: f.common, checkout: f.repo, record: f.org, worktrees: f.scratch, layers: [] };
      fs.mkdirSync(f.env.HERDR_MONITOR_FLEET);
      fs.writeFileSync(path.join(f.env.HERDR_MONITOR_FLEET, 'fleet.json'), JSON.stringify({ version: 1, session_limit: 6,
        projects: { project: entry, ...(problem === 'ambiguous binding' ? { duplicate: entry } : {}) } }));
      if (problem === 'wrong record binding') {
        org = path.join(f.scratch, 'other-record'); fs.mkdirSync(org); fs.writeFileSync(path.join(org, 'events.jsonl'), f.eventBytes);
      }
      reason = /ambiguous projects|differs from canonical project record/;
    }
    if (problem === 'fleet discovery error') {
      org = undefined; f.env.ORG_DIR = '';
      fs.mkdirSync(f.env.HERDR_MONITOR_FLEET); fs.writeFileSync(path.join(f.env.HERDR_MONITOR_FLEET, 'fleet.json'), '{}');
      reason = /invalid fleet/;
    }
    const status = await readRetirementStatus({ cwd: f.repo, org, herdr: f.herdr, env: f.env });
    assert.equal(status.rows.filter(row => row.type === 'tab').length, 1);
    assert.equal(status.rows.filter(row => row.type === 'pane').length, 1);
    const tree = status.rows.find(row => row.type === 'worktree' && row.worktree === f.empty);
    assert.equal(tree.class, 'UNKNOWN'); assert.match(tree.reason, reason); assert.match(tree.nextAction, reason);
    if (problem.includes('binding')) {
      assert.equal(status.rows.find(row => row.type === 'tab').class, 'TERMINAL', 'strict sweep binding does not replace ordinary pane classification');
      assert.equal(status.rows.some(row => row.type === 'diagnostic' && reason.test(row.reason)), false);
    }
    if (problem.includes('record')) assert.doesNotMatch(JSON.stringify(status), /ENOENT|stat '/);
    const calls = fs.readFileSync(f.log, 'utf8').trim().split('\n').map(JSON.parse);
    assert.ok(calls.every(args => ['list', 'process-info'].includes(args[1])), 'status remains read only');
  });
}

test('worktree integration follows the resolved trunk branch, including beside a stale main', async t => {
  const f = runtimeFixture(t, 'trunk'), base = f.git(['rev-parse', 'HEAD']);
  fs.writeFileSync(path.join(f.empty, 'seed'), 'merged into trunk');
  f.git(['commit', '-am', 'merged lane'], f.empty);
  f.git(['merge', '--ff-only', 'lane/empty']);
  const check = () => {
    const r = f.cli(['--json']); assert.equal(r.status, 0, r.stderr);
    const row = JSON.parse(r.stdout).rows.find(r => r.type === 'worktree' && r.worktree === f.empty);
    assert.equal(row.paneCount, 0); assert.equal(row.integrated, true, row.reason);
  };
  await t.test('without a main branch', check);
  f.git(['branch', 'main', base]);
  await t.test('with main behind the merged lane', check);
});

test('unavailable integration branches leave worktree integration unknown with a concrete error', t => {
  const f = runtimeFixture(t);
  for (const main of [undefined, 'missing-branch']) {
    const rows = readRetirementWorktrees(f.common, { main, env: f.env });
    assert.equal(rows.length, 3);
    for (const row of rows) {
      assert.equal(row.integrated, null);
      assert.match(row.error, /Git inventory: .+/);
    }
  }
});

test('read-only proof: every fake Herdr invocation is a read, Git disables optional locks, and record/index/receipts stay byte-identical', async t => {
  const f = runtimeFixture(t), receipt = path.join(f.org, 'retirement/occupants/old.json');
  fs.mkdirSync(path.dirname(receipt), { recursive: true });
  fs.writeFileSync(receipt, JSON.stringify({ schema: 'retirement-occupant/v1', kind: 'watcher', common: f.common, cwd: f.lane, workspace: 'gone', tab: 'gone:t', pane: 'gone:p', shell: { pid: 1, identity: 'shell', command: '[zsh]' }, process: { pid: 2, identity: 'process', command: '[node]' } }));
  const receiptBytes = fs.readFileSync(receipt), index = path.join(f.common, 'index'), indexBytes = fs.readFileSync(index), calls = [];
  const status = await readRetirementStatus({ cwd: f.repo, org: f.org, herdr: f.herdr, env: f.env,
    command(exe, args, options) { calls.push([exe, args, options.env.GIT_OPTIONAL_LOCKS]); return spawnSync(exe, args, options); } });
  assert.equal(status.rows.find(r => r.type === 'tab').class, 'TERMINAL');
  assert.ok(calls.length > 10); assert.ok(calls.every(([, , locks]) => locks === '0'));
  const reads = new Set(['workspace list', 'tab list', 'pane list', 'pane process-info', 'agent list']);
  const herdrCalls = fs.readFileSync(f.log, 'utf8').trim().split('\n').map(JSON.parse);
  assert.ok(herdrCalls.length >= 5); assert.ok(herdrCalls.every(a => reads.has(a.slice(0, 2).join(' '))));
  for (const [exe, args] of calls.filter(([exe]) => exe === 'git')) {
    const command = args[0] === '-C' || args[0] === '--git-dir' ? args[2] : args[0];
    assert.ok(['rev-parse', 'symbolic-ref', 'worktree', 'merge-base', 'status', 'ls-files', 'reflog'].includes(command), `${exe} ${args}`);
    if (command === 'worktree') assert.ok(args.includes('list'));
    if (command === 'reflog') {
      assert.ok(args.includes('show'));
      assert.deepEqual(args.slice(2, 5), ['reflog', 'show', '--format=%H%x00%gs']);
      assert.match(args[5], /^refs\/heads\/lane\//);
      assert.equal(args.length, 6);
    }
  }
  assert.equal(fs.readFileSync(f.eventFile, 'utf8'), f.eventBytes);
  assert.deepEqual(fs.readFileSync(index), indexBytes); assert.deepEqual(fs.readFileSync(receipt), receiptBytes);
  assert.equal(fs.existsSync(path.join(f.org, 'retirement/handled.json')), false);
});

test('CLI hold stays on disk, default is a plain table, and --out writes one Markdown table', t => {
  const f = runtimeFixture(t), held = path.join(f.repo, '.lane/supervisor/HOLD-WORKER-TAB-CLOSE'), out = path.join(f.scratch, 'daily.md');
  fs.mkdirSync(path.dirname(held), { recursive: true }); fs.writeFileSync(held, 'do not remove');
  const r = f.cli(['--out', out]); assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /TERMINAL=2/); assert.match(r.stdout, /Workspace \/ worktree/); assert.match(r.stdout, /record today/);
  assert.equal(fs.readFileSync(held, 'utf8'), 'do not remove');
  const md = fs.readFileSync(out, 'utf8'); assert.equal(md.split('\n').filter(l => l.startsWith('| ---')).length, 1);
  assert.match(md, /TERMINAL \| yes/); assert.match(md, /archive\/lane\/empty/);
  assert.equal(fs.readFileSync(f.eventFile, 'utf8'), f.eventBytes);
});

test('--out publishes only by same-directory rename and preserves the previous file if rename fails', t => {
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'retire-atomic-'))), file = path.join(directory, 'daily.md');
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  fs.writeFileSync(file, 'old');
  const rename = fs.renameSync; let seen = 0;
  fs.renameSync = (temporary, target) => {
    seen++; assert.equal(path.dirname(temporary), directory); assert.equal(target, file);
    assert.equal(fs.readFileSync(file, 'utf8'), 'old'); assert.equal(fs.readFileSync(temporary, 'utf8'), 'new');
    return rename(temporary, target);
  };
  try { writeRetirementStatus(file, 'new'); } finally { fs.renameSync = rename; }
  assert.equal(seen, 1); assert.equal(fs.readFileSync(file, 'utf8'), 'new');
  fs.renameSync = () => { throw Error('injected rename failure'); };
  try { assert.throws(() => writeRetirementStatus(file, 'incomplete'), /injected/); } finally { fs.renameSync = rename; }
  assert.equal(fs.readFileSync(file, 'utf8'), 'new'); assert.deepEqual(fs.readdirSync(directory), ['daily.md']);
});

test('--source uses board/source.mjs, only active rows show, and the built-in queue reuses the observed record', t => {
  const f = runtimeFixture(t), source = path.join(f.scratch, 'rows.mjs');
  f.env.ORG_DIR = path.join(f.scratch, 'wrong-record');
  const row = phase => ({ id: phase, item: 'ENG-1', lane: 'topic', kind: 'promotion', phase, stage: null, startedAt: null, phaseAt: null, endedAt: null,
    status: { code: phase, text: phase }, result: { exit: null, main: null, candidate: null }, where: {}, worktree: f.lane });
  fs.writeFileSync(source, `if(process.cwd()!==${JSON.stringify(f.repo)} || process.env.ORG_DIR!==${JSON.stringify(f.org)}) process.exit(2); console.log(JSON.stringify(${JSON.stringify({ schema: 'board-rows/v1', project: 'external', generatedAt: '2026-01-01T00:00:00Z', rows: ['queued', 'stage', 'landed', 'failed', 'interrupted'].map(row) })}));`);
  const queue = path.join(f.common, 'promote/queue.json'); fs.mkdirSync(path.dirname(queue), { recursive: true });
  fs.writeFileSync(queue, JSON.stringify({ identity: f.common, pending: [{ id: 'built-in', topic: 'topic', run: 'R-1' }, { id: 'without-run', topic: 'topic' }], results: [] }));
  const r = f.cli(['--json', '--source', `external=${source}`]); assert.equal(r.status, 0, r.stderr);
  const rows = JSON.parse(r.stdout).rows.filter(r => r.type === 'promotion');
  assert.deepEqual(rows.map(r => r.id).sort(), ['built-in', 'queued', 'stage', 'without-run']);
  assert.ok(rows.every(r => r.class === 'ACTIVE')); assert.equal(rows.find(r => r.id === 'built-in').item, 'ENG-1');
  assert.equal(rows.find(r => r.id === 'without-run').item, null);
  fs.writeFileSync(source, 'console.log("not-json")');
  const broken = JSON.parse(f.cli(['--json', '--source', `external=${source}`]).stdout).rows.find(r => r.id === 'source-json');
  assert.equal(broken.class, 'UNKNOWN'); assert.match(broken.reason, /source-json/);
  assert.match(broken.nextAction, /^keep; external: source-json/);
});

test('a copied product includes the board sources and can run status without its source checkout', t => {
  const f = runtimeFixture(t), product = path.join(f.scratch, 'installed'); copyProduct(root, product);
  const r = f.cli(['--json'], product); assert.equal(r.status, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout).schema, 'lanes-status/v1');
  for (const name of ['board/source.mjs', 'board/brain.mjs', 'lib/retire-status.mjs']) assert.ok(fs.existsSync(path.join(product, name)));
});

test('observation failures surface UNKNOWN and Markdown escapes source controls and table syntax', async t => {
  const f = runtimeFixture(t); fs.writeFileSync(f.herdr, '#!/bin/sh\necho unavailable >&2\nexit 1\n', { mode: 0o755 });
  const status = await readRetirementStatus({ cwd: f.repo, org: f.org, herdr: f.herdr, env: f.env });
  assert.ok(status.counts.UNKNOWN > 0); assert.match(status.rows.find(r => r.type === 'diagnostic').reason, /unavailable/);
  status.rows.push({ type: 'diagnostic', reason: '<tag>|\x1b[31m\nnext' });
  const md = renderRetirementStatus(status, { markdown: true });
  assert.match(md, /&lt;tag&gt;\\\|/); assert.doesNotMatch(md, /\x1b/);
});
