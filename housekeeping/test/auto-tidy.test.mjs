import test from '../../test/helpers/bounded-test.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { spawnChild, waitForExit } from '../../test/helpers/child.mjs';
import { configureCliFixture } from './helpers/cli-fixture.mjs';
import { tidyFinishedTabs } from '../housekeeping.mjs';
import { planTidy, reviewedAgentsFromRecords } from '../../supervisor/tidy-tabs.mjs';
import { retirementLock } from '../../lib/retire-lock.mjs';
import { retirementOwnerLock } from '../../lib/closeout.mjs';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'auto-tidy-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const repo = path.join(root, 'project'), lane = path.join(root, 'lane');
  fs.mkdirSync(repo);
  for (const args of [['init', '-b', 'main'], ['config', 'user.name', 'Test'],
    ['config', 'user.email', 'test@example.invalid'], ['commit', '--allow-empty', '-m', 'base'],
    ['worktree', 'add', '-b', 'lane/topic', lane]]) {
    const r = spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
  }
  const f = configureCliFixture({ root, repo, lane });
  fs.writeFileSync(f.config, JSON.stringify({ enabled: true, resume: false, tick_seconds: 1, cleanup_seconds: 600 }));
  const common = fs.realpathSync(path.join(repo, '.git'));
  const state = { workspaces: [
    { workspace_id: 'main', worktree: { checkout_path: repo, repo_root: repo, repo_key: common, is_linked_worktree: false } },
    { workspace_id: 'lane', worktree: { checkout_path: lane, repo_root: repo, repo_key: common, is_linked_worktree: true } },
  ], tabs: [], panes: [], agents: [], runs: [], items: [], actions: [], agentReads: 0 };
  f.add = (id, name, status = 'idle', workspace = 'lane', label = 'worker') => {
    state.tabs.push({ tab_id: id, workspace_id: workspace, label });
    state.panes.push({ pane_id: `${id}:p`, tab_id: id, workspace_id: workspace });
    state.agents.push({ name, agent: 'codex', agent_status: status, pane_id: `${id}:p`, tab_id: id,
      workspace_id: workspace, cwd: workspace === 'lane' ? lane : repo, terminal_id: id,
      agent_session: { value: `${id}:session` } });
    const item = `ENG-${state.runs.length + 1}`;
    state.runs.push({ id: `R-${state.runs.length + 1}`, item, started: { seq: state.runs.length + 1 },
      workspace: workspace === 'lane' ? lane : repo,
      meta: { agent: name, pane: `${id}:p`, worker_workspace: workspace, lane: 'topic',
        terminal_id: id, agent_session_id: `${id}:session` }, report: { seq: 10, outcome: 'done' } });
    state.items.push({ id: item, role: 'engineer', closed: { as: 'done', seq: 11 }, status: 'done', blocked_by: [] });
  };
  f.add('finished', 'lane-topic-worker');
  f.reviewSession = (name, extra = {}) => {
    const agent = state.agents.find(a => a.name === name);
    return { name, repo, lane: 'lane/topic', topic: 'topic', role: 'review-codex',
      pane: agent.pane_id, workspace: agent.workspace_id, terminal_id: agent.terminal_id,
      agent_session_id: agent.agent_session.value, created_at: '2020-01-01T00:00:00Z', ...extra };
  };
  const file = path.join(root, 'fake-state.json');
  f.save = () => fs.writeFileSync(file, JSON.stringify(state));
  f.read = () => JSON.parse(fs.readFileSync(file, 'utf8'));
  f.save();
  fs.writeFileSync(f.fake, `#!${process.execPath}
import fs from 'node:fs';
const file = ${JSON.stringify(file)}, s = JSON.parse(fs.readFileSync(file, 'utf8')), a = process.argv.slice(2);
const save = () => fs.writeFileSync(file, JSON.stringify(s));
const out = (result) => console.log(JSON.stringify({result}));
if (s.fail === a.slice(0, 2).join(' ')) { console.error('injected tidy failure'); process.exit(1); }
if (a[0] === 'status') out({ runs: s.runs, items: s.incompleteItems ? undefined : s.items });
else if (a[0] === 'workspace') out({ workspaces: s.workspaces });
else if (a[0] === 'tab' && a[1] === 'list') out({ tabs: s.tabs.filter(t => t.workspace_id === a.at(-1)) });
else if (a[0] === 'pane' && a[1] === 'list') out(s.incomplete ? {} : { panes: s.panes.filter(p => p.workspace_id === a.at(-1)) });
else if (a[0] === 'pane' && a[1] === 'process-info') out({ process_info: { shell_pid: 1, foreground_processes: [{ pid: 1, name: 'zsh' }], process_tree_complete: true, process_tree: [{pid:1,identity:'shell',state:'S',command:'[zsh]'}] } });
else if (a[0] === 'agent' && a[1] === 'list') {
  s.agentReads++;
  if (s.change && s.agentReads >= 2) s.agents[0].agent_status = s.change;
  if (s.newOccupant && s.agentReads >= 2) s.agents.push(s.newOccupant);
  if (s.replacement && s.agentReads >= 2) Object.assign(s.agents[0], s.replacement);
  if (s.waitingReport && s.agentReads >= 2) s.runs[0].report.outcome = s.waitingReport;
  save(); out({ agents: s.agents });
} else if (a[0] === 'agent' && a[1] === 'get') out({ agent: s.agents.find(agent => agent.name === a[2]) });
else if (a[0] === 'tab' && a[1] === 'close') {
  s.actions.push(a); s.tabs = s.tabs.filter(t => t.tab_id !== a[2]);
  s.panes = s.panes.filter(p => p.tab_id !== a[2]); s.agents = s.agents.filter(g => g.tab_id !== a[2]);
  save(); out({});
} else { console.error('unexpected fake command ' + a.join(' ')); process.exit(1); }
`);
  f.tidy = (extra = {}) => tidyFinishedTabs({ cwd: repo, org: root, herdr: f.fake,
    record: [process.execPath, f.fake], log: e => f.logs.push(e), ...extra });
  f.logs = [];
  f.stateData = state;
  f.env = { ...process.env, HERDR_TAB_ID: '', HERDR_PANE_ID: '', ORG_ACTOR: 'auto-tidy-test' };
  return f;
}

test('terminal integrated worker tabs close while working, blocked, unnamed and operator tabs stay', t => {
  const f = fixture(t);
  f.add('finished-round-2', 'lane-topic-worker-2');
  f.add('finished-round-3', 'lane-topic-worker-3');
  for (const [id, name, status] of [['working', 'lane-working', 'working'], ['blocked', 'lane-blocked', 'blocked'],
    ['unnamed', null, 'idle'], ['operator', null, 'done'], ['unknown', 'lane-unknown', 'unknown']]) f.add(id, name, status);
  f.add('operator-session', null, 'idle', 'main', 'settle R-8');
  f.save();
  assert.equal(f.tidy(), true);
  assert.deepEqual(f.read().actions.map(a => a[2]).sort(), ['finished', 'finished-round-2', 'finished-round-3']);
});

test('default-off owner contention skips only retirement through a complete housekeeping iteration', t => {
  const f = fixture(t), release = retirementLock(retirementOwnerLock(fs.realpathSync(path.join(f.repo, '.git'))));
  try {
    assert.equal(f.tidy(), false);
    assert.equal(f.logs[0].action, 'retirement-skipped'); assert.equal(f.logs[0].outcome, 'contended');
    assert.deepEqual(f.read().actions, []);
    const r = spawnSync(process.execPath, [...f.args, '--once'], { encoding: 'utf8', env: f.env });
    assert.equal(r.status, 0, r.stderr);
    const rows = r.stdout.trim().split('\n').map(JSON.parse);
    assert.equal(rows.filter(row => row.action === 'retirement-skipped' && row.outcome === 'contended').length, 2, 'tidy and tick both tolerate the held claim');
    assert.ok(rows.some(row => row.action === 'summary-published'));
    assert.deepEqual(f.read().actions, []);
  } finally { release(); }
});

test('dry-run previews finished tabs and never closes, including through housekeeping --once', t => {
  const f = fixture(t);
  assert.equal(f.tidy({ dryRun: true }), true);
  assert.match(f.logs[0].output, /would close finished/);
  const r = spawnSync(process.execPath, [...f.args, '--once', '--dry-run'], { encoding: 'utf8', env: f.env });
  assert.equal(r.status, 0, r.stderr); assert.match(r.stdout, /would close finished/);
  assert.deepEqual(f.read().actions, []);
});

test('a working or blocked change at the final recheck preserves the finished tab', t => {
  const f = fixture(t);
  for (const status of ['working', 'blocked']) {
    f.stateData.agentReads = 0; f.stateData.change = status; f.stateData.agents[0].agent_status = 'idle'; f.save();
    assert.equal(f.tidy(), true); assert.deepEqual(f.read().actions, []);
  }
});

test('new occupants revealed after the final pane list preserve their tab', t => {
  const f = fixture(t);
  for (const [name, status] of [['lane-new', 'working'], ['lane-new', 'blocked'], [null, 'idle'], ['lane-new', 'idle']]) {
    f.stateData.agentReads = 0;
    f.stateData.newOccupant = { ...f.stateData.agents[0], name, agent_status: status, pane_id: 'new-pane' };
    f.save(); assert.equal(f.tidy(), true); assert.deepEqual(f.read().actions, []);
    assert.equal(f.read().agentReads, 2, 'the new occupant appears only in the final observation');
  }
});

test('conflicting agent tab/workspace and duplicate pane topology cannot authorize a close', () => {
  const tabs = [{ tab_id: 'tab', label: 'worker', lane: true, workspace_id: 'lane' }];
  const panes = [{ pane_id: 'pane', tab_id: 'tab', shellOnly: true }];
  const agent = { name: 'lane-worker', status: 'idle', pane_id: 'pane', tab_id: 'tab', workspace_id: 'lane' };
  for (const snapshot of [
    { agents: [{ ...agent, tab_id: 'other' }], panes },
    { agents: [{ ...agent, workspace_id: 'other' }], panes },
    { agents: [agent], panes: [...panes, { ...panes[0], tab_id: 'other' }] },
    { agents: [agent], panes: [{ ...panes[0], workspace_id: 'other' }] },
  ]) {
    const plan = planTidy({ tabs, ...snapshot, reportedAgents: new Set([agent.name]) });
    assert.deepEqual(plan.close, []); assert.ok(plan.keep[0].why);
  }
});

test('housekeeping --once preserves waiting reports, blocking items and missing item evidence', t => {
  const f = fixture(t), original = structuredClone(f.stateData);
  for (const variant of ['blocked-report', 'needs-human-report', 'blocked-item', 'needs-human-item',
    'open-blocker', 'missing-blocker', 'declined-blocker', 'missing-item', 'incomplete-items']) {
    Object.assign(f.stateData, structuredClone(original));
    const s = f.stateData;
    if (variant.endsWith('-report')) {
      s.runs[0].report.outcome = variant === 'blocked-report' ? 'blocked' : 'needs_human';
      s.items[0].closed = null;
    }
    if (variant.endsWith('-item') && variant !== 'missing-item') s.items[0].closed = null;
    if (variant.endsWith('-blocker')) {
      s.items[0].blocked_by = ['HUM-1'];
      if (variant !== 'missing-blocker') s.items.push({ id: 'HUM-1', status: variant === 'open-blocker' ? 'ready' : 'done',
        closed: variant === 'open-blocker' ? null : {}, meta: { answer: variant === 'declined-blocker' ? 'no' : 'yes' } });
    }
    if (variant === 'missing-item') s.items = [];
    if (variant === 'incomplete-items') s.incompleteItems = true;
    f.save();
    const r = spawnSync(process.execPath, [...f.args, '--once'], { encoding: 'utf8', env: f.env });
    assert.equal(r.status, variant === 'incomplete-items' ? 1 : 0, `${variant}: ${r.stderr}`);
    assert.deepEqual(f.read().actions, [], variant);
    if (variant === 'incomplete-items') assert.match(r.stdout, /tidy-failed/);
  }
  // A resolved blocker allows the completed worker to close before promotion.
  Object.assign(f.stateData, structuredClone(original)); delete f.stateData.incompleteItems;
  f.stateData.items[0].blocked_by = ['HUM-1']; f.stateData.items.push({ id: 'HUM-1', closed: { as: 'done' }, status: 'done' });
  f.save(); assert.equal(f.tidy(), true); assert.deepEqual(f.read().actions, [['tab', 'close', 'finished']]);
});

test('automatic tidy requires the newest recorded occupant and preserves absent or mismatched identity', t => {
  const f = fixture(t), original = structuredClone(f.stateData);
  for (const variant of ['pane', 'cwd', 'workspace', 'terminal', 'session', 'missing-live-terminal',
    'missing-live-session', 'missing-live-cwd', 'missing-record-pane', 'missing-record-workspace',
    'missing-record-cwd', 'missing-record-identities', 'tied-newest']) {
    Object.assign(f.stateData, structuredClone(original));
    const agent = f.stateData.agents[0], run = f.stateData.runs[0];
    if (variant === 'pane') run.meta.pane = 'previous-pane';
    if (variant === 'cwd') agent.cwd = f.repo;
    if (variant === 'workspace') run.meta.worker_workspace = 'previous-workspace';
    if (variant === 'terminal') agent.terminal_id = 'replacement-terminal';
    if (variant === 'session') agent.agent_session.value = 'replacement-session';
    if (variant === 'missing-live-terminal') delete agent.terminal_id;
    if (variant === 'missing-live-session') delete agent.agent_session;
    if (variant === 'missing-live-cwd') delete agent.cwd;
    if (variant === 'missing-record-pane') delete run.meta.pane;
    if (variant === 'missing-record-workspace') delete run.meta.worker_workspace;
    if (variant === 'missing-record-cwd') delete run.workspace;
    if (variant === 'missing-record-identities') { delete run.meta.terminal_id; delete run.meta.agent_session_id; }
    if (variant === 'tied-newest') f.stateData.runs.push({ ...run, id: 'R-2' });
    f.save(); assert.equal(f.tidy(), true); assert.deepEqual(f.read().actions, [], variant);
  }
});

test('replacement identity and a waiting report at the final observation prevent closing', t => {
  const f = fixture(t), original = structuredClone(f.stateData);
  for (const change of [{ replacement: { terminal_id: 'new-terminal' } },
    { replacement: { agent_session: { value: 'new-session' } } }, { waitingReport: 'blocked' }, { waitingReport: 'needs_human' }]) {
    for (const key of ['replacement', 'waitingReport']) delete f.stateData[key];
    Object.assign(f.stateData, structuredClone(original), change);
    f.save(); assert.equal(f.tidy(), true); assert.deepEqual(f.read().actions, []);
    assert.equal(f.read().agentReads, 2);
  }
});

test('a reused worker name with a newer open run and an extra unnamed occupant never close', t => {
  const f = fixture(t);
  f.stateData.runs.push({ ...f.stateData.runs[0], id: 'R-2', started: { seq: 2 }, report: null });
  f.save(); assert.equal(f.tidy(), true); assert.deepEqual(f.read().actions, []);
  f.stateData.runs.pop();
  f.stateData.agents.push({ ...f.stateData.agents[0], name: null });
  f.save(); assert.equal(f.tidy(), true); assert.deepEqual(f.read().actions, []);
});

test('a matching worker cannot authorize another occupant reusing its name', t => {
  const f = fixture(t);
  f.stateData.agents.push({ ...f.stateData.agents[0], terminal_id: 'replacement' });
  f.save(); assert.equal(f.tidy(), true); assert.deepEqual(f.read().actions, []);
  const r = spawnSync(process.execPath, [...f.args, '--once'], { encoding: 'utf8', env: f.env });
  assert.equal(r.status, 0, r.stderr); assert.deepEqual(f.read().actions, []);
});

test('only this Git project is tidied and the caller tab is preserved', t => {
  const f = fixture(t);
  f.stateData.workspaces[1].worktree.repo_key = f.root;
  f.save(); assert.equal(f.tidy(), true); assert.deepEqual(f.read().actions, []);
  f.stateData.workspaces[1].worktree.repo_key = path.join(f.repo, '.git'); f.save();
  const r = spawnSync(process.execPath, [path.join(f.repo, 'supervisor/tidy-tabs.mjs'), '--cwd', f.repo,
    '--org', f.root, '--herdr', f.fake, '--org-cli', f.fake], { encoding: 'utf8', env: { ...f.env, HERDR_TAB_ID: 'finished' } });
  assert.equal(r.status, 0, r.stderr); assert.deepEqual(f.read().actions, []);
});

test('review files and session display metadata do not authorize retirement', t => {
  const f = fixture(t);
  f.add('review-old', 'lane-topic-review-old'); f.add('review-new', 'lane-topic-review-new');
  f.stateData.runs = f.stateData.runs.slice(0, 1);
  f.add('settle-old', 'settle-r-9-old', 'idle', 'main', 'settle R-9');
  f.add('settle-new', 'settle-r-10-new', 'done', 'main', 'settle R-10');
  const registry = path.join(f.repo, '.lane/sessions.json.d'), reviews = path.join(f.repo, 'docs/reviews/topic');
  fs.mkdirSync(registry, { recursive: true }); fs.mkdirSync(reviews, { recursive: true });
  for (const [name, created_at] of [['lane-topic-review-old', '2020-01-01T00:00:00Z'], ['lane-topic-review-new', '2099-01-01T00:00:00Z']]) {
    fs.writeFileSync(path.join(registry, `${name}.json`), JSON.stringify(f.reviewSession(name, { role: 'review', created_at })));
  }
  fs.writeFileSync(path.join(reviews, 'verdict.md'), '**PASS**\n');
  const ledger = path.join(f.repo, '.lane/supervisor'); fs.mkdirSync(ledger);
  fs.writeFileSync(path.join(ledger, 'sessions-2026-10-03.log'), '12:00:00 settle-r-9-old settle R-9\n13:00:00 settle-r-10-new settle R-10\n');
  f.save(); assert.equal(f.tidy(), true);
  assert.deepEqual(f.read().actions.map(a => a[2]).sort(), ['finished']);
});

test('a working correction round preserves the lane and review files never release unrecorded panes', t => {
  const f = fixture(t);
  const registry = path.join(f.repo, '.lane/sessions.json.d'), reviews = path.join(f.lane, 'docs/reviews/topic');
  fs.mkdirSync(registry, { recursive: true }); fs.mkdirSync(reviews, { recursive: true });
  for (let round = 1; round <= 3; round++) {
    if (round > 1) f.add(`worker-${round}`, `lane-topic-worker-${round}`);
    const name = `lane-topic-review-${round}`;
    f.add(`review-${round}`, name);
    f.stateData.runs.pop(); // Lane reviewers have verdict evidence, no worker reports.
    fs.writeFileSync(path.join(registry, `${name}.json`), JSON.stringify(f.reviewSession(name, {
      created_at: `2020-01-0${round}T00:00:00Z` })));
    const file = path.join(reviews, `round-${round}.md`);
    fs.writeFileSync(file, `**${round < 3 ? 'NEEDS-WORK' : 'PASS'}**\nTopic: topic\nRound: ${round}\n`);
    fs.utimesSync(file, new Date(`2020-01-0${round}T01:00:00Z`), new Date(`2020-01-0${round}T01:00:00Z`));
  }
  f.add('working-round', 'lane-topic-working', 'working'); f.stateData.runs.at(-1).report = null;
  f.save();
  const r = spawnSync(process.execPath, [...f.args, '--once'], { encoding: 'utf8', env: f.env });
  assert.equal(r.status, 0, r.stderr);
  const remaining = f.read();
  assert.equal(remaining.tabs.length, 7);
  assert.deepEqual(remaining.actions, []);
});

test('supported review routes need a matching topic verdict newer than their session', () => {
  const sessions = ['review', 'review-codex', 'review-max', 'review-custom', 'engineer'].map(role => ({
    role, name: `lane-topic-${role}`, topic: 'topic', created_at: '2020-01-01T00:00:00Z',
  }));
  sessions.push({ ...sessions[0], name: 'lane-topic-new-review', created_at: '2020-01-03T00:00:00Z' });
  sessions.push({ ...sessions[0], name: 'lane-other-review', topic: 'other' });
  const records = [{ topic: 'topic', verdict: 'FAIL', mtimeMs: Date.parse('2020-01-02T00:00:00Z') }];
  assert.deepEqual([...reviewedAgentsFromRecords(sessions, records)],
    ['lane-topic-review', 'lane-topic-review-codex', 'lane-topic-review-max', 'lane-topic-review-custom']);
});

test('automatic review tidy preserves missing or mismatched occupant evidence without worker runs', t => {
  const f = fixture(t), registry = path.join(f.repo, '.lane/sessions.json.d'), reviews = path.join(f.lane, 'docs/reviews/topic');
  fs.mkdirSync(registry, { recursive: true }); fs.mkdirSync(reviews, { recursive: true });
  f.stateData.runs = []; // The verdict is the only completion evidence.
  const name = f.stateData.agents[0].name, original = structuredClone(f.stateData), session = f.reviewSession(name);
  const record = path.join(registry, 'review.json');
  fs.writeFileSync(path.join(reviews, 'verdict.md'), '**PASS**\n');
  for (const variant of ['pane', 'cwd', 'workspace', 'terminal', 'session', 'missing-live-terminal',
    'missing-live-session', 'missing-live-cwd', 'missing-record-pane', 'missing-record-workspace',
    'missing-record-lane', 'unknown-record-lane', 'missing-record-repo', 'wrong-record-repo',
    'missing-record-identities', 'missing-verdict', 'older-verdict', 'newest-open-review',
    'newest-missing-repo', 'newest-missing-identity', 'tied-newest', 'duplicate-name']) {
    Object.assign(f.stateData, structuredClone(original));
    const agent = f.stateData.agents[0], recorded = structuredClone(session);
    if (variant === 'pane') recorded.pane = 'previous-pane';
    if (variant === 'cwd') agent.cwd = f.repo;
    if (variant === 'workspace') recorded.workspace = 'previous-workspace';
    if (variant === 'terminal') agent.terminal_id = 'replacement-terminal';
    if (variant === 'session') agent.agent_session.value = 'replacement-session';
    if (variant === 'missing-live-terminal') delete agent.terminal_id;
    if (variant === 'missing-live-session') delete agent.agent_session;
    if (variant === 'missing-live-cwd') delete agent.cwd;
    if (variant === 'missing-record-pane') delete recorded.pane;
    if (variant === 'missing-record-workspace') delete recorded.workspace;
    if (variant === 'missing-record-lane') delete recorded.lane;
    if (variant === 'unknown-record-lane') recorded.lane = 'lane/absent';
    if (variant === 'missing-record-repo') delete recorded.repo;
    if (variant === 'wrong-record-repo') recorded.repo = f.root;
    if (variant === 'missing-record-identities') { delete recorded.terminal_id; delete recorded.agent_session_id; }
    if (variant === 'missing-verdict') recorded.topic = 'other';
    if (variant === 'older-verdict') recorded.created_at = '2099-01-01T00:00:00Z';
    if (variant === 'duplicate-name') f.stateData.agents.push({ ...agent, terminal_id: 'replacement' });
    fs.writeFileSync(record, JSON.stringify(recorded));
    const newer = path.join(registry, 'newer.json');
    if (variant.startsWith('newest-') || variant === 'tied-newest') {
      const nextSession = { ...session, created_at: variant === 'tied-newest' ? session.created_at : '2020-01-02T00:00:00Z' };
      if (variant === 'newest-open-review') nextSession.created_at = '2099-01-01T00:00:00Z';
      if (variant === 'newest-missing-repo') delete nextSession.repo;
      if (variant === 'newest-missing-identity') { delete nextSession.terminal_id; delete nextSession.agent_session_id; }
      fs.writeFileSync(newer, JSON.stringify(nextSession));
    }
    f.save();
    const r = spawnSync(process.execPath, [...f.args, '--once'], { encoding: 'utf8', env: f.env });
    assert.equal(r.status, 0, `${variant}: ${r.stderr}`); assert.deepEqual(f.read().actions, [], variant);
    fs.rmSync(newer, { force: true });
  }
  // Either recorded immutable identity suffices; every identity present must match.
  for (const omitted of ['terminal_id', 'agent_session_id']) {
    Object.assign(f.stateData, structuredClone(original));
    const recorded = { ...session }; delete recorded[omitted];
    fs.writeFileSync(record, JSON.stringify(recorded)); f.save();
    assert.equal(f.tidy(), true); assert.deepEqual(f.read().actions, []);
  }
});

test('replacement reviewers at the final observation keep their tabs without worker runs', t => {
  const f = fixture(t), registry = path.join(f.repo, '.lane/sessions.json.d'), reviews = path.join(f.lane, 'docs/reviews/topic');
  fs.mkdirSync(registry, { recursive: true }); fs.mkdirSync(reviews, { recursive: true });
  f.stateData.runs = [];
  fs.writeFileSync(path.join(registry, 'review.json'), JSON.stringify(f.reviewSession(f.stateData.agents[0].name)));
  fs.writeFileSync(path.join(reviews, 'verdict.md'), '**NEEDS-WORK**\n');
  const original = structuredClone(f.stateData);
  for (const replacement of [{ pane_id: 'new-pane' }, { cwd: f.repo }, { workspace_id: 'main' },
    { terminal_id: 'new-terminal' }, { agent_session: { value: 'new-session' } },
    { terminal_id: null }, { agent_session: null }, { cwd: null }]) {
    Object.assign(f.stateData, structuredClone(original), { replacement }); f.save();
    const r = spawnSync(process.execPath, [...f.args, '--once'], { encoding: 'utf8', env: f.env });
    assert.equal(r.status, 0, r.stderr); assert.deepEqual(f.read().actions, []);
    assert.ok(f.read().agentReads >= 1, 'unrecorded reviewer stays without authorization');
  }
});

test('review evidence cannot override a recorded worker waiting on a blocker', t => {
  const f = fixture(t), registry = path.join(f.repo, '.lane/sessions.json.d'), reviews = path.join(f.repo, 'docs/reviews/topic');
  fs.mkdirSync(registry, { recursive: true }); fs.mkdirSync(reviews, { recursive: true });
  fs.writeFileSync(path.join(registry, 'worker.json'), JSON.stringify(f.reviewSession('lane-topic-worker')));
  fs.writeFileSync(path.join(reviews, 'verdict.md'), '**PASS**\n');
  f.stateData.runs[0].report.outcome = 'blocked';
  f.stateData.items[0].closed = null;
  f.save(); assert.equal(f.tidy(), true); assert.deepEqual(f.read().actions, []);
});

test('failed and incomplete reads close nothing and are logged without stopping housekeeping', t => {
  const f = fixture(t);
  for (const fail of ['agent list', 'status --json', 'tab close']) {
    f.stateData.fail = fail; f.save(); assert.equal(f.tidy(), fail === 'tab close');
    assert.equal(f.logs.at(-1).action, fail === 'tab close' ? 'tidy-tabs' : 'tidy-failed'); assert.deepEqual(f.read().actions, []);
  }
  delete f.stateData.fail; f.stateData.incomplete = true; f.save();
  assert.equal(f.tidy(), false); assert.deepEqual(f.read().actions, []);
  delete f.stateData.incomplete; f.save();
  // Only the separate tidy entry point fails; strict housekeeping can still scan.
  const tidyScript = path.join(f.repo, 'supervisor/tidy-tabs.mjs');
  fs.writeFileSync(tidyScript, fs.readFileSync(tidyScript, 'utf8').replace('try { main(); }', 'try { throw new Error("tidy crash"); }'));
  const r = spawnSync(process.execPath, [...f.args, '--once'], { encoding: 'utf8', env: f.env });
  assert.equal(r.status, 0, r.stderr); assert.match(r.stdout, /tidy-failed/); assert.match(r.stdout, /"action":"scan"/);
});

test('every tick tidies despite the ten-minute cleanup interval and a tidy failure', async t => {
  const f = fixture(t);
  // First tick fails; the next two succeed without waiting for cleanup.
  f.stateData.fail = 'tab close'; f.save();
  const child = spawnChild(t, process.execPath, [...f.args, '--loop'], { env: f.env });
  let buffer = '', tidyCount = 0;
  child.stdout.on('data', chunk => {
    buffer += chunk;
    const lines = buffer.split('\n'); buffer = lines.pop();
    for (const line of lines) {
      const entry = JSON.parse(line);
      if (!['tidy-tabs', 'tidy-failed'].includes(entry.action)) continue;
      tidyCount++;
      if (tidyCount === 1) { delete f.stateData.fail; f.save(); }
      if (tidyCount === 3) fs.writeFileSync(f.config, '{"enabled":false}');
    }
  });
  const r = await waitForExit(child);
  assert.equal(r.code, 0, r.stderr); assert.equal(tidyCount, 3);
  const logs = fs.readFileSync(path.join(f.state, 'actions.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.deepEqual(logs.filter(e => e.action === 'scan').map(e => e.cleanup), [true, false, false]);
  assert.deepEqual(f.read().actions, [['tab', 'close', 'finished']]);
});

test('auto-tidy preserves a focused finished worker at initial and final observation', t => {
  const f = fixture(t);
  f.stateData.panes[0].focused = true; f.save();
  assert.equal(f.tidy(), true); assert.deepEqual(f.read().actions, []);
  f.stateData.panes[0].focused = false; f.stateData.agentReads = 0; f.save();
  // The operator enters the tab during the final observation, after planning.
  const code = fs.readFileSync(f.fake, 'utf8').replace("const save = () =>", "if(a[0]==='pane'&&a[1]==='list'&&s.agentReads>=1)s.panes[0].focused=true;\nconst save = () =>");
  fs.writeFileSync(f.fake, code);
  assert.equal(f.tidy(), true); assert.deepEqual(f.read().actions, []);
});
