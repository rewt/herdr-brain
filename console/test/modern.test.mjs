import test from '../../test/helpers/bounded-test.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { activityEntries, catalog, projectView, createIdentityReader, folderPath, itemOrigin } from '../modern/model.mjs';
import { createModernSession } from '../modern/session.mjs';
import { loadModernConfig, normalizeConfig } from '../lib/config.mjs';
import { parseMouse } from '../lib/mouse.mjs';
import { cellWidth } from '../lib/text.mjs';
import { lineText } from '../lib/frame.mjs';

const identity = cwd => cwd === '/b' ? { key: '/b/.git', root: '/b', name: 'same-name', git: true } : ['/a', '/a-lane'].includes(cwd) ? { key: '/a/.git', root: '/a', name: 'same-name', git: true } : null;
const space = (id, root, linked = false) => ({ workspace_id: id, label: id, active_tab_id: `${id}:t1`, worktree: { repo_key: `${root}/.git`, repo_root: root, repo_name: 'same-name', checkout_path: linked ? `${root}-lane` : root, is_linked_worktree: linked } });
function fixture(overrides = {}) {
  const config = { projects: [{ name: 'Alpha', cwd: '/a', org: '/org-a' }, { name: 'Beta', cwd: '/b', org: '/org-b' }], refresh_seconds: 60 };
  const workspaces = [space('a', '/a'), space('a-work', '/a', true), space('b', '/b')];
  const tabs = workspaces.map(w => ({ tab_id: `${w.workspace_id}:t1`, workspace_id: w.workspace_id, label: 'Terminal' }));
  const agents = [{ name: 'worker', pane: 'a-work:p1', tab: 'a-work:t1', workspace: 'a-work', cwd: '/a-lane', tool: 'codex', status: 'working' }, { name: 'beta', pane: 'b:p1', tab: 'b:t1', workspace: 'b', cwd: '/b', tool: 'claude', status: 'idle' }];
  const items = [{ id: 'G-1', kind: 'goal', title: 'Ship the result', status: 'open', parent: null, notes: [] }, { id: 'ENG-1', kind: 'task', role: 'engineer', title: 'Implement the result', parent: 'G-1', status: 'active', created: { at: '2026-10-01T15:00:00Z', run: 'R-0', why: 'The agent found a missing piece.' }, runs: ['R-1'], notes: [] }, { id: 'ENG-2', kind: 'task', role: 'engineer', title: 'Completed work', parent: 'G-1', status: 'done', notes: [] }];
  const events = [{ seq: 1, at: '2026-10-01T15:00:00Z', type: 'item.added', id: 'ENG-1', kind: 'task', title: 'Implement the result', parent: 'G-1', by: 'worker' },
    { seq: 2, at: '2026-10-01T15:01:00Z', type: 'run.started', id: 'R-1', item: 'ENG-1', meta: { agent: 'worker', harness: 'codex' } }];
  const today = p => ({ project: { top_goal: null }, waiting: [], running: p.name === 'Alpha' ? [{ run: 'R-1', item: 'ENG-1', title: 'Implement the result', agent: 'worker', workspace: '/a-lane', started: new Date().toISOString() }] : [], agent_runs: [], decided: [], finished: [] });
  const reads = [], calls = [], panes = [];
  const deps = { identity, orgToday: async p => today(p), orgStatus: async p => ({ items: p.name === 'Alpha' ? items : [], runs: [] }), orgLog: async p => p.name === 'Alpha' ? events : [], brainQueue: async () => ({ rows: [], off: true }),
    herdrList: async what => what === 'workspace' ? workspaces : what === 'pane' ? panes : tabs, herdrAgents: async () => ({ ok: true, agents }),
    orgDesks: async () => null,
    orgHousekeeping: async () => null,
    orgRoutes: async () => ({ config: { routes: {} }, files: [], editable: false, target: '/a/.lane.json' }),
    herdrRead: async target => { reads.push(target); return { ok: true, text: `EXACT ${target.pane}\n${'output\n'.repeat(45)}` }; }, herdrGo: async target => { calls.push(target); return { ok: true }; }, gitSummary: async () => ({ branch: 'lane/alpha', changes: 2 }), ...overrides };
  const session = createModernSession({ config, deps, env: {} });
  return { session, config, deps, workspaces, tabs, agents, items, events, reads, calls, panes };
}
const rendered = (s, cols = 100, rows = 32) => s.frame(cols, rows).lines.map(lineText).join('\n');

test('C opens only the selected project supervisor chat, while refresh and composing do not', async () => {
  const chats = [];
  const {session} = fixture({herdrProjectChat: async p => {chats.push(p); return {ok: true, available: true};}});
  try {
    await session.refresh(); rendered(session); assert.equal(chats.length, 0);
    await session.key('C'); assert.equal(chats.length, 1); assert.equal(chats[0].name, 'Alpha'); assert.equal(chats[0].repoKey, '/a/.git');
    await session.activate('project:configured:Beta'); rendered(session);
    await session.key('C'); assert.equal(chats[1].repoKey, '/b/.git');
    await session.key('n'); await session.key('C'); assert.equal(chats.length, 2);
    assert.match(session.ui.compose.text, /C/);
  } finally {session.stop();}
});

test('project chat failures are visible and read-only dependencies can refuse C', async () => {
  const {session} = fixture({herdrProjectChat: async () => ({ok: false, error: '--print does not open project chats'})});
  try {await session.refresh(); await session.key('C'); assert.match(session.ui.message, /--print does not open project chats/);}
  finally {session.stop();}
});

test('capital C in the folder path stays in text entry without opening a chat', async () => {
  const chats = [];
  const {session} = fixture({herdrProjectChat: async p => {chats.push(p); return {ok: true};}});
  try {
    await session.refresh(); await session.activate('folder');
    session.ui.text = '/projects/';
    await session.key('C'); await session.key('ode');
    assert.equal(session.ui.text, '/projects/Code');
    assert.deepEqual(chats, []);
    assert.equal(session.ui.view, 'folder');
  } finally {session.stop();}
});

test('completed work category flags stay visible on overview and Needs you and open the source item', async () => {
  const flag = { id: 'ENG-2', kind: 'category', text: 'Category review: tooling is auto but R-2 decisions[0] mentions keys; check operator authority' };
  let items;
  const f = fixture({ orgStatus: async () => ({ items, runs: [], attention: [flag] }) });
  items = f.items;
  await f.session.refresh();
  assert.match(rendered(f.session), /Category review/);
  assert.match(rendered(f.session), /Waiting 1/);
  await f.session.key('c');
  assert.match(rendered(f.session), /Category flags · 1/);
  await f.session.key('!');
  const needs = rendered(f.session).replaceAll('\n', ' ');
  assert.match(needs, /Category review · 1/); assert.match(needs, /mentions keys/);
  await f.session.activate('item:ENG-2');
  assert.match(rendered(f.session), /Completed work/);
  f.session.stop();
});

test('project discovery uses Git identity, deduplicates worktrees, never repo basenames', () => {
  const { config, workspaces } = fixture();
  const list = catalog(config.projects.slice(0, 1), workspaces, identity);
  assert.equal(list.length, 2); assert.equal(list[1].id, 'discovered:/b/.git');
  assert.equal(list[0].org, '/org-a'); assert.equal(list[1].org, null);
});

test('live scope keeps the exact sessions, run relationships and active work only', async () => {
  const { session } = fixture(); await session.refresh();
  assert.deepEqual(session.model.sessions.map(a => [a.pane, a.goal, a.task]), [['a-work:p1', 'G-1', 'ENG-1']]);
  assert.equal(session.model.tasks.length, 1);
  await session.activate('project:configured:Beta');
  assert.deepEqual(session.model.sessions.map(a => a.pane), ['b:p1']); assert.equal(session.model.goals.length, 0);
  assert.doesNotMatch(rendered(session), /Ship the result|ENG-1/);
});

test('activity keeps item lifecycle moments and item pages explain agent-created work', async () => {
  const { session, items, events } = fixture();
  events.push({ seq: 3, at: '2026-10-01T15:02:00Z', type: 'report.ingested', run: 'R-1', item: 'ENG-1', report: { outcome: 'done', headline: 'The missing piece now works.' } });
  const entries = activityEntries({ items, runs: [{ id: 'R-1', item: 'ENG-1' }] }, events);
  assert.deepEqual(entries.map(e => [e.mark, e.verb, e.id]), [['✓', 'reported', 'ENG-1'], ['▶', 'started', 'ENG-1'], ['+', 'created', 'ENG-1']]);
  assert.equal(entries[2].summary, 'The agent found a missing piece.');
  assert.deepEqual(itemOrigin(items[1]), { source: 'proposed by R-0', at: '2026-10-01T15:00:00Z', why: 'The agent found a missing piece.', unattributed: false });
  await session.refresh(); await session.key('a');
  let frame = session.frame(100, 32), activity = frame.lines.map(lineText).join('\n');
  assert.match(activity, /Activity · 3 moments/); assert.match(activity, /ENG-1\s+created\s+Implement the result/); assert.match(activity, /The agent found a missing piece/);
  assert.equal(session.ui.focus, 'activity:3');
  const selected = () => frame.lines.filter(line => line.spans.some(span => span.bg === 'selected')).map(lineText).join('\n');
  assert.match(selected(), /reported/); assert.match(selected(), /R-1/); assert.match(selected(), /The missing piece now works/);
  assert.doesNotMatch(selected(), /started|created/);
  await session.key('j'); frame = session.frame(100, 32);
  assert.equal(session.ui.focus, 'activity:2', 'j reaches an older moment for the same item');
  assert.match(selected(), /started/); assert.doesNotMatch(selected(), /reported|created/);
  await session.key('', { return: true });
  const detail = rendered(session, 100, 32);
  assert.match(detail, /proposed by R-0/); assert.match(detail, /Why: The agent found a missing piece\./);
});

test('an answered question has one answered activity moment, not a duplicate decision', () => {
  const status = { items: [{ id: 'HUM-1', kind: 'question', title: 'Publish?', status: 'done' }], runs: [] };
  const events = [
    { seq: 1, at: '2026-10-01T15:00:00Z', type: 'note.added', id: 'HUM-1', kind: 'answer', decision: true, text: 'ANSWER: yes' },
    { seq: 2, at: '2026-10-01T15:01:00Z', type: 'item.closed', id: 'HUM-1', as: 'done', note: 'yes' },
  ];
  assert.deepEqual(activityEntries(status, events).map(event => [event.verb, event.id]), [['answered', 'HUM-1']]);
});

test('a dropped question reads as dropped, not answered', () => {
  const status = { items: [{ id: 'HUM-2', kind: 'question', title: 'Publish?', status: 'dropped' }], runs: [] };
  const events = [{ seq: 1, at: '2026-10-01T15:00:00Z', type: 'item.closed', id: 'HUM-2', as: 'dropped', note: 'moot' }];
  assert.deepEqual(activityEntries(status, events).map(event => [event.verb, event.id]), [['dropped', 'HUM-2']]);
});

test('output reads the selected pane, history restores task and its keyboard focus', async () => {
  const { session, reads } = fixture(); await session.refresh();
  session.ui.focus = 'item:ENG-1'; await session.activate('item:ENG-1');
  session.ui.focus = 'session:a-work:p1'; await session.activate('session:a-work:p1');
  assert.deepEqual(reads.at(-1), { pane: 'a-work:p1' });
  assert.match(rendered(session), /a-work:p1/);
  await session.key('', { escape: true }); assert.equal(session.ui.view, 'item'); assert.equal(session.ui.focus, 'session:a-work:p1');
  await session.key('', { escape: true }); assert.equal(session.ui.view, 'overview'); assert.equal(session.ui.focus, 'item:ENG-1');
});

test('same-view navigation does not accumulate Back entries', async () => {
  const { session } = fixture(); await session.refresh();
  await session.activate('view:goals'); await session.activate('view:goals'); await session.activate('view:goals');
  await session.activate('back'); assert.equal(session.ui.view, 'overview');
  await session.activate('forward'); assert.equal(session.ui.view, 'goals');
});

test('split tab requires a specific agent and shell tabs do not borrow other output', async () => {
  const { session, agents, reads } = fixture();
  agents.push({ ...agents[0], name: 'second', pane: 'a-work:p2' }); await session.refresh();
  await session.activate('space:a-work'); assert.equal(session.ui.pane, null); assert.equal(reads.length, 0);
  assert.match(rendered(session), /Select a session/);
  await session.activate('session:a-work:p2'); assert.equal(reads.at(-1).pane, 'a-work:p2');
  await session.activate('space:a'); assert.equal(session.ui.pane, null); assert.match(rendered(session), /Shell tab/);
});

test('source failure retains last good data with an error and cannot focus stale sessions', async () => {
  let fail = false;
  const { session, calls, agents } = fixture({ herdrAgents: async () => fail ? { ok: false, error: 'socket disconnected' } : { ok: true, agents } });
  await session.refresh(); await session.activate('session:a-work:p1'); fail = true; await session.refresh();
  assert.equal(session.model.sessions.length, 1); assert.match(rendered(session), /Connection issue/);
  await session.activate('go'); assert.equal(calls.length, 0);
  fail = false; await session.refresh(); assert.equal(session.ui.errors.agents, undefined);
});

test('a disappeared agent retains its last output but cannot be focused as live', async () => {
  const { session, agents, calls } = fixture(); await session.refresh(); await session.activate('session:a-work:p1');
  agents.shift(); await session.refresh(); assert.match(session.ui.outputError, /no longer/);
  assert.match(session.ui.output, /EXACT a-work:p1/); await session.activate('go'); assert.equal(calls.length, 0);
});

test('late output cannot overwrite a newer selection', async () => {
  let release;
  const { session } = fixture({ herdrRead: () => new Promise(resolve => { release = resolve; }) });
  await session.refresh();
  const pending = session.activate('session:a-work:p1'); await new Promise(resolve => setImmediate(resolve));
  await session.activate('view:goals'); release({ ok: true, text: 'STALE RESULT' }); await pending;
  assert.equal(session.ui.view, 'goals'); assert.equal(session.ui.output, null); assert.doesNotMatch(rendered(session), /STALE RESULT/);
});

test('scope switch during a pending refresh never leaks the previous project', async () => {
  const { session, deps } = fixture(); await session.refresh();
  let release; let slow = true;
  const slowSession = createModernSession({ config: fixture().config, deps: { ...deps, orgStatus: async p => {
    if (p.name === 'Alpha' && slow) { slow = false; await new Promise(resolve => release = resolve); }
    return deps.orgStatus(p);
  } } });
  const first = slowSession.refresh(); await new Promise(resolve => setImmediate(resolve));
  const switched = slowSession.activate('project:configured:Beta'); release(); await Promise.all([first, switched]);
  assert.equal(slowSession.project.name, 'Beta'); assert.equal(slowSession.model.goals.length, 0);
  assert.doesNotMatch(rendered(slowSession), /Ship the result/);
});

test('frame is cell-exact and source text cannot inject terminal escapes at target sizes', async () => {
  const { session, items } = fixture(); items[0].title = '\x1b]52;c;secret\x07 A wide 字 outcome'; await session.refresh();
  for (const [cols, rows] of [[80, 24], [100, 34], [140, 42]]) {
    const f = session.frame(cols, rows); assert.equal(f.lines.length, rows);
    for (const l of f.lines) { assert.equal(cellWidth(lineText(l)), cols); assert.doesNotMatch(lineText(l), /\x1b|secret/); }
    assert.ok(f.hits.flat().every(h => h.from >= 0 && h.to <= cols));
    assert.match(lineText(f.lines[0]), /^ Herdr Monitor/);
  }
});

test('mouse hits open the intended live session and Back/Forward use the same history', async () => {
  const { session } = fixture(); await session.refresh(); const frame = session.frame(100, 32);
  const y = frame.hits.findIndex(h => h.some(x => x.id === 'session:a-work:p1'));
  const hit = frame.hits[y].find(x => x.id === 'session:a-work:p1');
  await session.mouse({ x: hit.from, y, button: 'left', press: true }); assert.equal(session.ui.pane, 'a-work:p1');
  await session.mouse(parseMouse('\x1b[<128;1;1M')); assert.equal(session.ui.view, 'overview');
  await session.mouse(parseMouse('\x1b[<129;1;1M')); assert.equal(session.ui.view, 'output');
  assert.equal(parseMouse('\x1b[<160;1;1M').button, 'motion');
});

test('fresh installation reads no config into existence; goals and org are optional', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'modern-empty-'));
  try {
    const file = path.join(dir, 'not-created', 'console.json'); const config = loadModernConfig(file);
    assert.deepEqual(config.projects, []); assert.equal(fs.existsSync(path.dirname(file)), false);
    assert.throws(() => normalizeConfig({ projects: [] }, file), /no projects/);
    const { deps } = fixture(); const session = createModernSession({ config, deps: { ...deps, herdrList: async () => [], herdrAgents: async () => ({ ok: true, agents: [] }) } });
    await session.refresh(); assert.match(rendered(session), /Start where you are/); assert.match(rendered(session), /Open a folder/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('opening a directory without Git creates no project files and can return to the previous scope', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'modern-folder-'));
  try {
    const { session } = fixture({ identity: cwd => identity(cwd) ?? { key: dir, root: dir, name: 'Ideas', git: false } });
    await session.refresh(); await session.activate('folder'); session.ui.text = dir; await session.activate('open-folder');
    assert.equal(session.project.org, null); assert.equal(session.model.goals.length, 0); assert.deepEqual(fs.readdirSync(dir), []);
    assert.match(rendered(session), /No sessions here yet/); assert.doesNotMatch(rendered(session), /task →/); assert.doesNotMatch(rendered(session), /Shell tabs remain/); await session.activate('back'); assert.equal(session.ui.view, 'folder');
    await session.activate('back'); assert.equal(session.project.name, 'Alpha');
    await session.activate('folder'); session.ui.text = path.join(dir, 'missing'); await session.activate('open-folder'); assert.match(session.ui.message, /Cannot open folder/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('canonical discovery groups an actual worktree and a symlink, keeping same-named repos distinct', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'modern-identity-'));
  try {
    const a = path.join(dir, 'one', 'repo'), b = path.join(dir, 'two', 'repo'), lane = path.join(dir, 'lane');
    fs.mkdirSync(a, { recursive: true }); fs.mkdirSync(b, { recursive: true });
    for (const cwd of [a, b]) { execFileSync('git', ['init', '-q', cwd]); execFileSync('git', ['-C', cwd, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '--allow-empty', '-qm', 'Fixture']); }
    execFileSync('git', ['-C', a, 'worktree', 'add', '-qb', 'lane', lane]);
    fs.symlinkSync(a, path.join(dir, 'alias'));
    const read = createIdentityReader();
    assert.equal(read(a).key, read(lane).key); assert.equal(read(a).key, read(path.join(dir, 'alias')).key); assert.notEqual(read(a).key, read(b).key);
    assert.equal(folderPath(path.join(dir, 'alias')), fs.realpathSync(a));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('future-stage and deferred questions remain reachable without inflating Needs you', async () => {
  const { session } = fixture({ orgToday: async () => ({ project: { open_stage: 1 }, waiting: [{ id: 'HUM-1', title: 'Now?', stage: 1 }, { id: 'HUM-2', title: 'Later stage?', stage: 2 }], running: [], agent_runs: [], decided: [], finished: [] }) });
  await session.refresh(); assert.equal(session.model.needs.length, 1); assert.equal(session.model.parked.length, 1);
  await session.activate('view:parked'); assert.match(rendered(session), /Later stage/);
  await session.activate(`need:${session.model.parked[0].key}`); assert.equal(session.ui.view, 'need'); assert.match(rendered(session), /Later stage/);
});

test('list shortcuts focus the first actionable item and Enter drills in', async () => {
  const { session } = fixture(); await session.refresh();
  for (const [key, id] of [['g', 'G-1'], ['t', 'ENG-1']]) {
    await session.key(key); session.frame(100, 34); assert.equal(session.ui.focus, `item:${id}`);
    await session.key('', { return: true }); assert.equal(session.ui.detail, id);
    await session.key('b'); assert.equal(session.ui.focus, `item:${id}`);
  }
  await session.key('s'); assert.equal(session.ui.focus, 'session:a-work:p1');
});

test('narrow lists keep work state readable and narrow sessions retain full state', async () => {
  const { session, items } = fixture(); items[1].title = 'Very long description '.repeat(15); await session.refresh();
  await session.key('t'); for (const cols of [80, 100, 140]) assert.match(rendered(session, cols, 30), /ENG-1\s+active/);
  await session.key('s'); for (const cols of [80, 100, 140]) assert.match(rendered(session, cols, 30), /working/);
});

test('output PageUp reads older lines and PageDown returns to latest', async () => {
  const { session } = fixture(); await session.refresh(); await session.activate('session:a-work:p1');
  rendered(session); await session.key('', { pageUp: true }); rendered(session); assert.ok(session.ui.outputScroll > 0);
  await session.key('', { pageDown: true }); assert.equal(session.ui.outputScroll, 0);
});

test('plugin/caller workspace selects its canonical project without relying on labels', async () => {
  const { config, deps } = fixture(); const session = createModernSession({ config, deps, projectIndex: -1, env: { HERDR_WORKSPACE_ID: 'b' } });
  await session.refresh(); assert.equal(session.project.name, 'Beta'); assert.deepEqual(session.model.sessions.map(a => a.pane), ['b:p1']);
});

test('appearance changes preserve navigation and unsupported preview actions have an honest handoff', async () => {
  const { session, calls } = fixture(); await session.refresh(); await session.key('g');
  const history = session.ui.history.length, focus = session.ui.focus;
  assert.equal(session.ui.appearance, 'dark'); await session.key('D'); assert.equal(session.ui.appearance, 'light');
  assert.equal(session.ui.history.length, history); assert.equal(session.ui.focus, focus);
  await session.activate('unavailable'); assert.match(session.ui.message, /Read-only trial/); assert.deepEqual(calls, []);
});

test('Tab changes regions, arrows stay within them, and central tabs support Left/Right', async () => {
  const { session } = fixture(); await session.refresh(); session.frame(140, 42);
  session.ui.focus = 'space:a'; await session.key('', { downArrow: true }); assert.equal(session.ui.focus, 'space:a-work');
  await session.key('', { tab: true }); assert.equal(session.ui.focus, 'view:overview');
  await session.key('', { tab: true, shift: true }); assert.equal(session.ui.focus, 'space:a-work');
  await session.key('', { tab: true }); await session.key('', { rightArrow: true });
  assert.equal(session.ui.view, 'goals'); assert.equal(session.ui.focus, 'view:goals');
  session.frame(140, 42); await session.key('', { leftArrow: true }); assert.equal(session.ui.view, 'overview');
});

test('scope dropdown preserves background, cancels cleanly, and same-project selection is a no-op', async () => {
  const { session } = fixture(); await session.refresh(); await session.activate('item:G-1'); session.ui.focus = 'item:ENG-1';
  const history = session.ui.history.length;
  await session.key('p'); assert.equal(session.ui.view, 'item'); assert.equal(session.ui.detail, 'G-1');
  assert.match(rendered(session), /type to filter/); assert.equal(session.ui.history.length, history);
  await session.key('', { return: true }); assert.equal(session.ui.view, 'item'); assert.equal(session.ui.history.length, history); assert.equal(session.ui.focus, 'item:ENG-1');
  await session.key('p'); await session.key('nonesuch'); assert.match(rendered(session), /No matching projects/);
  await session.key('', { escape: true }); assert.equal(session.ui.picker, null); assert.equal(session.ui.focus, 'item:ENG-1');
  await session.key('p'); await session.key('', { downArrow: true }); await session.key('', { return: true });
  assert.equal(session.project.name, 'Beta'); await session.key('b'); assert.equal(session.project.name, 'Alpha'); assert.equal(session.ui.detail, 'G-1');
});

test('Herdr companion starts without a duplicate rail, but checkouts can be opened on demand', async () => {
  const { config, deps } = fixture(); const session = createModernSession({ config, deps, env: { HERDR_ENV: '1' } });
  await session.refresh(); assert.equal(session.ui.showCheckouts, false);
  let frame = session.frame(140, 42); assert.ok(!frame.controls.some(c => c.id === 'space:a'));
  await session.key('w'); frame = session.frame(140, 42); assert.ok(frame.controls.some(c => c.id === 'space:a'));
  await session.key('w'); assert.equal(session.ui.showCheckouts, false);
});

test('goal readers put current descendant sessions first and render acceptance as actual criteria', async () => {
  const { session, items } = fixture(); items[0].accept = [];
  items[0].notes = [{ text: 'Long note '.repeat(150) }];
  items.push({ id: 'G-2', kind: 'goal', title: 'Child goal', parent: 'G-1', status: 'open', notes: [] }); items[1].parent = 'G-2';
  await session.refresh(); await session.activate('item:G-1');
  let text = rendered(session, 100, 32); assert.match(text, /Current linked sessions · 1/); assert.match(text, /worker/); assert.match(text, /No success criteria recorded/); assert.doesNotMatch(text, /Success:\s*\n/);
  assert.ok(text.indexOf('worker') < text.indexOf('Long note'));
  items[0].accept = ['First useful check', 'Second useful check']; await session.refresh(); text = rendered(session, 100, 32);
  assert.match(text, /1\. First useful check/); assert.match(text, /2\. Second useful check/);
});

test('native observer keeps latest rows visible, pans locally, and cancels on routes and stop', async () => {
  const observers = [];
  const { session } = fixture({ observeTerminal: options => { const o = { ...options, stopped: false }; observers.push(o); return { stop() { o.stopped = true; } }; } });
  try {
    await session.refresh(); session.frame(140, 42); await session.activate('session:a-work:p1');
    const first = observers[0]; assert.equal(first.pane, 'a-work:p1'); assert.equal(first.followNativeSize, true);
    const frame = () => ({ width: 177, height: 79, seq: 1, lines: Array.from({ length: 79 }, (_, i) => ({ spans: [{ text: (i === 78 ? 'NATIVE COLOR PROMPT' : i === 0 ? 'OLD TOP OF SCREEN' : `ROW ${i + 1}`).padEnd(177), fg: '#12ab34', bg: 'terminalBg', bold: true }] })) });
    first.onFrame(frame()); assert.match(rendered(session, 140, 42), /NATIVE COLOR PROMPT/);
    assert.match(rendered(session, 140, 42), /Native 177×79 · rows \d+–79/); assert.doesNotMatch(rendered(session, 140, 42), /OLD TOP OF SCREEN/);
    assert.ok(session.ui.frame.lines.some(l => l.spans.some(s => s.fg === '#12ab34')));
    assert.match(rendered(session, 80, 24), /NATIVE COLOR PROMPT/); assert.equal(first.stopped, false); assert.equal(observers.length, 1);
    await session.key('', { shift: true, upArrow: true }); assert.equal(session.ui.screenScroll, 3); assert.doesNotMatch(rendered(session, 80, 24), /NATIVE COLOR PROMPT/);
    await session.key('', { shift: true, downArrow: true }); assert.match(rendered(session, 80, 24), /NATIVE COLOR PROMPT/);
    await session.key('', { shift: true, rightArrow: true }); assert.equal(session.ui.outputX, 12); assert.match(rendered(session, 80, 24), /cols 13–/);
    await session.key('', { shift: true, leftArrow: true }); assert.equal(session.ui.outputX, 0); assert.match(rendered(session, 80, 24), /NATIVE COLOR PROMPT/); assert.equal(observers.length, 1);
    await session.activate('view:goals'); assert.equal(first.stopped, true);
    first.onFrame(frame()); assert.equal(session.ui.terminalFrame, null);
    await session.activate('session:a-work:p1'); const last = observers.at(-1); session.stop(); assert.equal(last.stopped, true);
  } finally { session.stop(); }
});

test('observer retry rejects previous callbacks even for the same pane', async () => {
  const observers = [];
  const { session } = fixture({ observeTerminal: o => { observers.push(o); return { stop() {} }; } });
  try {
    await session.refresh(); session.frame(140, 42); await session.activate('session:a-work:p1');
    const first = observers[0]; first.onError('disconnected'); assert.match(session.ui.outputError, /disconnected/);
    await session.activate('refresh'); assert.equal(observers.length, 2);
    first.onFrame({ width: 177, height: 79, seq: 1, lines: [{ spans: [{ text: 'STALE' }] }] });
    assert.equal(session.ui.terminalFrame, null);
    await session.activate('transcript'); assert.equal(session.ui.outputMode, 'transcript'); assert.match(session.ui.output, /EXACT/);
  } finally { session.stop(); }
});

test('goals and tasks render without a selected project instead of crashing', async () => {
  const { deps } = fixture();
  const session = createModernSession({ config: { projects: [], refresh_seconds: 60 }, deps: { ...deps, herdrList: async () => [], herdrAgents: async () => ({ ok: true, agents: [] }) }, projectIndex: -1, env: {} });
  await session.refresh(); assert.equal(session.project, null);
  for (const key of ['g', 't', '!', 's']) { await session.key(key, {}); assert.match(rendered(session), /No organization connected|Nothing|No /); }
});

test('a discovered project whose last workspace closed falls back to a current project', async () => {
  const { deps, workspaces, agents } = fixture();
  const config = { projects: [{ name: 'Alpha', cwd: '/a', org: '/org-a' }], refresh_seconds: 60 };
  const session = createModernSession({ config, deps, env: {} }); await session.refresh();
  await session.activate('project:discovered:/b/.git'); assert.equal(session.project.name, 'same-name');
  await session.key('g', {});
  workspaces.splice(workspaces.findIndex(w => w.workspace_id === 'b'), 1); agents.splice(agents.findIndex(a => a.pane === 'b:p1'), 1);
  await session.refresh();
  assert.equal(session.project.name, 'Alpha'); assert.equal(session.ui.view, 'overview'); assert.match(session.ui.message, /no open workspace/);
  assert.doesNotThrow(() => rendered(session));
});

test('Needs keeps Brain results in the checkout their session ran in, never by label alone', async () => {
  const at = new Date().toISOString();
  const row = (id, where, project) => ({ id, session: `s-${id}`, where, project, at, state: 'idle', status: 'new', digest: { question: `Question ${id}?`, gist: `Gist ${id}` } });
  const rows = [row('in-b', '/b', 'other'), row('in-a', '/a-lane', 'other'), row('mislabeled', '/b', 'Alpha'), row('nowhere', null, 'other'), row('labelled', null, 'Beta')];
  const { session } = fixture({ brainQueue: async () => ({ rows, off: false }) });
  await session.refresh();
  const ids = () => session.model.allNeeds.filter(n => n.kind === 'result').map(n => n.data.id).sort();
  assert.deepEqual(ids(), ['in-a']);
  await session.activate('project:configured:Beta');
  assert.deepEqual(ids(), ['in-b', 'labelled', 'mislabeled']);
});

test('agents are discoverable by their own checkout even when no workspace belongs to it', async () => {
  const lookup = cwd => cwd === '/elsewhere' ? { key: '/elsewhere', root: '/elsewhere', cwd, name: 'elsewhere', git: false } : identity(cwd);
  const { session, agents } = fixture({ identity: lookup });
  agents.push({ name: 'stuck', pane: 'a:p9', tab: 'a:t1', workspace: 'a', cwd: '/elsewhere', tool: 'claude', status: 'blocked' });
  await session.refresh();
  assert.ok(session.ui.projects.some(p => p.id === 'discovered:/elsewhere'));
  assert.ok(!session.model.sessions.some(a => a.pane === 'a:p9'));
  await session.activate('space:a'); assert.equal(session.ui.pane, null);
  const out = rendered(session); assert.match(out, /stuck \(blocked\) is in this tab but works in elsewhere/); assert.doesNotMatch(out, /Shell tab/);
  await session.activate('project:discovered:/elsewhere'); assert.deepEqual(session.model.sessions.map(a => a.pane), ['a:p9']);
});

test('o opens only the session on screen, fixed at the keypress', async () => {
  let release = null, hold = false;
  const { session, calls, workspaces, tabs: all } = fixture({ herdrList: what => what === 'workspace' ? Promise.resolve(workspaces)
    : hold ? new Promise(resolve => { release = () => resolve(all); }) : Promise.resolve(all) });
  await session.refresh(); await session.activate('session:a-work:p1');
  await session.activate('view:goals'); await session.key('o', {});
  assert.equal(calls.length, 0); assert.match(session.ui.message, /Open a session first/);
  await session.activate('back'); assert.equal(session.ui.view, 'output');
  hold = true;
  const pending = session.key('o', {}); await new Promise(resolve => setImmediate(resolve));
  await session.activate('view:tasks'); release(); await pending;
  assert.equal(calls.length, 0);
});

test('Needs folds session results that the org resolved, replaced, only reported, or left unowned', async () => {
  const now = Date.now(), iso = ms => new Date(now - ms).toISOString(), day = 24 * 60 * 60 * 1000;
  const row = (id, extra = {}, digest = {}) => ({ id, session: `s-${id}`, where: '/a-lane', project: 'other', at: iso(60_000), state: 'idle', status: 'digested', pane: `gone:${id}`, digest: { kind: 'decision', needs_you: true, question: `Question ${id}?`, ...digest }, ...extra });
  const rows = [
    row('closed-item', {}, { item: 'ENG-2' }),
    row('older', { at: iso(2 * 60_000) }, { item: 'ENG-1' }), row('newer', {}, { item: 'ENG-1' }),
    row('report', {}, { kind: 'report', needs_you: false }),
    row('unowned', { at: iso(2 * day) }), row('fresh-unowned'), row('old-but-live', { at: iso(2 * day), pane: 'a-work:p1' }),
    row('stranded', { at: iso(2 * day), unsent: 'yes, go ahead' }, { item: 'ENG-2' }),
  ];
  const { session } = fixture({ brainQueue: async () => ({ rows, off: false }), now: () => now });
  await session.refresh();
  const m = session.model, ids = list => list.map(n => n.data.id).sort();
  assert.deepEqual(ids(m.needs), ['fresh-unowned', 'newer', 'old-but-live', 'stranded']);
  assert.deepEqual(ids(m.resolved), ['closed-item', 'older']);
  assert.deepEqual(ids(m.reports), ['report']);
  assert.deepEqual(ids(m.ended), ['unowned']);
  assert.match(m.resolved.find(n => n.data.id === 'closed-item').settled, /ENG-2 is closed/);
  assert.match(m.resolved.find(n => n.data.id === 'older').settled, /newer session result about ENG-1/);
  // Folded groups stay one keypress away and explain themselves.
  await session.activate('view:needs'); let text = rendered(session);
  assert.match(text, /Waiting on you · 4/); assert.match(text, /Resolved 2/); assert.match(text, /Ended sessions 1/); assert.match(text, /Reports 1/);
  await session.activate('view:resolved'); await session.activate(`need:${m.resolved[0].key}`); text = rendered(session);
  assert.match(text, /Folded · /);
});

test('opening a session types into it here, and Ctrl+] or Back releases it and returns', async () => {
  const controllers = [];
  const controlTerminal = options => { const c = { ...options, inputs: [], sizes: [], released: false, input(b) { c.inputs.push(Buffer.from(b).toString()); }, resize(cols, rows) { c.sizes.push([cols, rows]); }, scroll() {}, release() { c.released = true; }, stop() { c.released = true; } }; controllers.push(c); return c; };
  const { session } = fixture({ controlTerminal }); await session.refresh(); session.frame(140, 42);
  await session.key('s'); await session.key('', { return: true });
  assert.equal(session.ui.view, 'output'); assert.equal(session.ui.interactive, true);
  const c = controllers[0]; assert.equal(c.pane, 'a-work:p1');
  c.onFrame({ width: 20, height: 2, seq: 1, cursor: { x: 2, y: 1, visible: true }, lines: [{ spans: [{ text: 'AGENT SCREEN'.padEnd(20), fg: 'terminalFg', bg: 'terminalBg' }] }, { spans: [{ text: '> '.padEnd(20), fg: 'terminalFg', bg: 'terminalBg' }] }] });
  const f = session.frame(140, 42), text = f.lines.map(lineText).join('\n');
  assert.match(text, /‹ Back {2}Ctrl\+\]/); assert.match(text, /AGENT SCREEN/); assert.match(text, /Typing goes to this session/);
  assert.ok(f.lines.some(l => l.spans.some(s => s.inverse)), 'the session cursor is drawn');
  assert.deepEqual(c.sizes.at(-1), [session.ui.screenViewport.cols, session.ui.screenViewport.rows], 'Herdr sizes the terminal to the console area');
  // Console keys belong to the session now; q does not quit.
  assert.equal(await session.key('q', {}), false); assert.equal(session.ui.view, 'output');
  await session.input('hello\r\x1b[<0;3;3M'); assert.deepEqual(c.inputs, ['hello\r']);
  await session.input('\x1d'); assert.equal(c.released, true);
  assert.equal(session.ui.view, 'sessions'); assert.equal(session.ui.interactive, false);
  // Forward returns to typing; i re-enters a watched session; Back from a click works too.
  await session.activate('forward'); assert.equal(session.ui.interactive, true); assert.equal(controllers.length, 2);
  await session.activate('back'); assert.equal(controllers[1].released, true);
  await session.activate('forward'); session.ui.interactive = false; await session.key('i'); assert.equal(session.ui.interactive, true);
  assert.equal(await session.key('c', { ctrl: true }), false, 'Ctrl-C reaches the session');
  await session.activate('back'); assert.equal(await session.key('c', { ctrl: true }), true, 'outside a session Ctrl-C quits');
});

test('a controller Herdr hands elsewhere drops back to watching with a way to retype', async () => {
  const controllers = [];
  const { session } = fixture({ controlTerminal: o => { const c = { ...o, stop() {}, release() {} }; controllers.push(c); return c; } });
  await session.refresh(); await session.activate('session:a-work:p1');
  controllers[0].onClose('detached'); assert.equal(session.ui.interactive, false); assert.match(session.ui.message, /Press i/);
  await session.activate('interact'); controllers[1].onError('refused'); assert.match(session.ui.outputError, /Cannot type into this session: refused/);
});

const hitFor = (f, id) => { const y = f.hits.findIndex(h => h.some(x => x.id === id)); return y < 0 ? null : { y, ...f.hits[y].find(x => x.id === id) }; };

test('project screen: counts, the work block and its tasks, then numbered sessions under their checkout', async () => {
  const { session, items } = fixture(); await session.refresh(); session.ui.showCheckouts = false;
  const f = session.frame(140, 42), lines = f.lines.map(lineText), at = re => lines.findIndex(l => re.test(l));
  assert.match(lines[at(/sessions/)], /1 sessions\s+1 working\s+0 blocked\s+0 idle\s+0 done/);
  assert.match(lines[at(/now · G-1/)], /Ship the result.*1 on it · goals ›/);
  assert.match(lines[at(/ENG-1 /)], /●.*Implement the result.*active\s+#1/); assert.ok(!lines.some(l => /ENG-2/.test(l)), 'finished tasks stay out');
  assert.ok(at(/now · G-1/) < at(/a-lane · 1/));
  assert.match(lines[at(/^\s+1\s+●/)], /1 {2}● beta|1 {2}● .*codex\s+G-1 › ENG-1 Implement the result/);
  assert.ok(f.controls.some(c => c.id === 'session:a-work:p1'));
  // A goal marked as a block is the block by declaration, whatever sessions say.
  items.push({ id: 'G-2', kind: 'goal', title: 'Afternoon: tidy the docs', status: 'open', parent: null, meta: { block: 'afternoon' }, notes: [] });
  await session.refresh(); assert.match(rendered(session, 140, 42), /afternoon · G-2 · Afternoon: tidy the docs/);
});

test('a session number opens it, a task link opens the task, and Back restores the link', async () => {
  const { session, reads } = fixture(); await session.refresh();
  let f = session.frame(140, 42), hit = hitFor(f, 'link-item:ENG-1|a-work:p1');
  await session.mouse({ x: hit.from, y: hit.y, button: 'left', press: true });
  assert.equal(session.ui.detail, 'ENG-1'); assert.equal(reads.length, 0);
  await session.activate('back'); assert.equal(session.ui.focus, 'link-item:ENG-1|a-work:p1');
  await session.key('1'); assert.equal(session.ui.view, 'output'); assert.equal(session.ui.pane, 'a-work:p1');
  await session.activate('back'); f = session.frame(140, 42); hit = hitFor(f, 'link-space:a-work|project');
  await session.mouse({ x: hit.from, y: hit.y, button: 'left', press: true }); assert.equal(session.ui.space, 'a-work');
  await session.activate('back'); await session.key('7'); assert.match(session.ui.message, /No session 7/);
});

test('clicking a session name renames its pane label, never the agent', async () => {
  const renames = [];
  const { session, panes } = fixture({ herdrRename: async (pane, label) => { renames.push([pane, label]); panes.push({ pane_id: pane, label }); return { ok: true }; } });
  await session.refresh(); let f = session.frame(140, 42);
  const hit = hitFor(f, 'rename:a-work:p1'); assert.ok(hit, 'the name is a click target');
  assert.ok(!f.controls.some(c => c.id === 'rename:a-work:p1'), 'but not a keyboard stop');
  await session.mouse({ x: hit.from, y: hit.y, button: 'left', press: true }); assert.equal(session.ui.rename.pane, 'a-work:p1');
  for (let i = 0; i < 30; i++) await session.key('', { backspace: true });
  for (const ch of 'docs pass') await session.key(ch, {});
  assert.match(rendered(session, 140, 42), /docs pass▏/); assert.equal(session.ui.view, 'overview', 'typing does not trigger shortcuts');
  await session.key('', { return: true }); assert.deepEqual(renames, [['a-work:p1', 'docs pass']]);
  assert.match(rendered(session, 140, 42), /1 {2}● docs pass/);
  session.ui.focus = 'session:a-work:p1'; await session.key('e'); assert.equal(session.ui.rename.text, 'docs pass');
  await session.key('', { escape: true }); assert.equal(session.ui.rename, null); assert.equal(renames.length, 1);
});

test('the prompt bar adds a task or starts a chat on one Enter, and says which before', async () => {
  const chats = [], tasks = [];
  const { session } = fixture({ herdrStartChat: async r => { chats.push(r); return { ok: true, pane: 'a:p7', name: r.name }; }, orgAdd: async (p, r) => { tasks.push([p.name, r]); return { ok: true, id: 'W-9' }; } });
  await session.refresh(); session.frame(140, 42);
  const type = async text => { for (const ch of text) await session.key(ch, {}); };
  assert.match(rendered(session, 140, 42), /› write a task or a message….*task → G-1/);
  await session.key('n'); await type('Write the docs'); await session.key('', { return: true });
  assert.deepEqual(tasks, [['Alpha', { title: 'Write the docs', parent: 'G-1' }]]); assert.match(session.ui.message, /Added W-9 under G-1/);
  await session.key('n'); await session.key('', { return: true }); assert.match(session.ui.message, /Type the task first/); assert.equal(tasks.length, 1);
  await session.key('', { escape: true }); assert.equal(session.ui.compose, null);
  // Tab: task, claude, codex. Down picks the next checkout.
  await session.key('n'); await session.key('', { tab: true }); assert.match(rendered(session, 140, 42), /claude → main/);
  await session.key('', { tab: true }); await session.key('', { downArrow: true }); assert.match(rendered(session, 140, 42), /codex → a-lane/);
  await type('hi'); await session.key('', { return: true });
  assert.deepEqual(chats.map(c => [c.workspace, c.cwd, c.kind, c.prompt]), [['a-work', '/a-lane', 'codex', 'hi']]);
  assert.match(session.ui.message, /Started codex in a-lane/);
});

test('a folder without an organization offers chats only', async () => {
  const { session } = fixture(); await session.refresh();
  session.ui.projects.find(p => p.name === 'Alpha').org = null;
  assert.match(rendered(session, 140, 42), /claude → main/);
  await session.key('n'); await session.key('', { tab: true }); await session.key('', { tab: true });
  assert.match(rendered(session, 140, 42), /claude → main/);
});

test('a Needs you item is answered from its page: choices, reply, later, and org questions', async () => {
  const acts = [], answers = [];
  const at = new Date().toISOString();
  const rows = [{ id: 'r1', session: 'worker', where: '/a-lane', project: 'other', at, state: 'idle', status: 'digested', pane: 'a-work:p1', tab_label: 'worker',
    digest: { kind: 'decision', needs_you: true, item: 'ENG-1', question: 'Ship it now?', explain: 'Because.', options: [{ key: '1', label: 'Ship', causes: 'It ships.' }, { key: '2', label: 'Wait', causes: 'It waits.' }], recommend: '1' } }];
  const { session } = fixture({
    brainQueue: async () => ({ rows, off: false }),
    brainAct: async args => { acts.push(args); return { ok: true }; },
    orgAnswer: async (p, r) => { answers.push([p.name, r.question, r.answer, r.note]); return { ok: true }; },
    orgToday: async () => ({ project: {}, waiting: [{ id: 'HUM-1', title: 'Publish?', recommend: 'yes', on_yes: 'It goes out.' }], running: [], agent_runs: [], decided: [], finished: [] }),
  });
  await session.refresh();
  const need = id => session.model.needs.find(n => (n.handle ?? n.question) === id);
  assert.ok(need('ENG-1'), 'the session question is open'); assert.ok(need('HUM-1'), 'the org question is open');
  await session.activate(`need:${need('ENG-1').key}`); let text = rendered(session, 140, 42);
  assert.match(text, /1 {2}Ship {3}★ recommended/); assert.match(text, /It waits\./); assert.match(text, /r {2}Reply in your words/);
  await session.key('2'); assert.match(rendered(session, 140, 42), /Send “Wait” to worker\?/); assert.deepEqual(acts, []);
  await session.key('', { escape: true }); assert.equal(session.ui.act, null);
  await session.key('y'); await session.key('', { return: true });
  assert.equal(acts.length, 1); assert.equal(acts[0].at(-1), 'Ship'); assert.match(session.ui.message, /Done: Send “Ship”/);
  await session.activate(`need:${need('ENG-1').key}`); await session.key('r');
  for (const ch of 'go ahead') await session.key(ch, {}); await session.key('', { return: true });
  assert.deepEqual(acts[1].slice(-1), ['go ahead']);
  await session.activate(`need:${need('HUM-1').key}`); assert.match(rendered(session, 140, 42), /y {2}Approve {3}★ recommended/);
  await session.key('n'); for (const ch of 'not yet') await session.key(ch, {}); await session.key('', { return: true });
  assert.deepEqual(answers, [['Alpha', 'HUM-1', 'no', 'not yet']]);
});

import { lastRecorded } from '../modern/model.mjs';

test('the overview says quiet when no session works and nothing was recorded for 20 minutes', async () => {
  const hoursAgo = h => new Date(Date.now() - h * 3600e3 - 60e3).toISOString();
  const items = [{ id: 'ENG-1', kind: 'task', role: 'engineer', title: 'Implement the result', parent: null, status: 'active', created: { at: hoursAgo(9) }, notes: [{ at: hoursAgo(5), text: 'refused' }] }];
  assert.equal(lastRecorded({ items, runs: [{ id: 'R-1', started: { at: hoursAgo(7) }, report: null }] }), items[0].notes[0].at);
  assert.equal(lastRecorded(null), null);
  const idleAgents = [{ name: 'worker', pane: 'a-work:p1', tab: 'a-work:t1', workspace: 'a-work', cwd: '/a-lane', tool: 'codex', status: 'idle' }];
  const quiet = fixture({ orgStatus: async () => ({ items, runs: [] }), herdrAgents: async () => ({ ok: true, agents: idleAgents }) });
  await quiet.session.refresh();
  assert.match(rendered(quiet.session, 140), /quiet 5h0\dm · nothing working, nothing recorded since \d\d:\d\d/);
  const busy = fixture({ orgStatus: async () => ({ items, runs: [] }) });
  await busy.session.refresh();
  assert.doesNotMatch(rendered(busy.session, 140), /quiet \d/, 'a session working is progress, however quiet');
  quiet.session.stop(); busy.session.stop();
});
