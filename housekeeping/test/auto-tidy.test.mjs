import test from '../../test/helpers/bounded-test.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { spawnChild, waitForExit } from '../../test/helpers/child.mjs';
import { configureCliFixture } from './helpers/cli-fixture.mjs';
import { tidyFinishedTabs } from '../housekeeping.mjs';

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
  const f = configureCliFixture({ root, repo });
  fs.writeFileSync(f.config, JSON.stringify({ enabled: true, resume: false, tick_seconds: 1, cleanup_seconds: 600 }));
  const common = fs.realpathSync(path.join(repo, '.git'));
  const state = { workspaces: [
    { workspace_id: 'main', worktree: { checkout_path: repo, repo_root: repo, repo_key: common, is_linked_worktree: false } },
    { workspace_id: 'lane', worktree: { checkout_path: lane, repo_root: repo, repo_key: common, is_linked_worktree: true } },
  ], tabs: [], panes: [], agents: [], runs: [], actions: [], agentReads: 0 };
  f.add = (id, name, status = 'idle', workspace = 'lane', label = 'worker') => {
    state.tabs.push({ tab_id: id, workspace_id: workspace, label });
    state.panes.push({ pane_id: `${id}:p`, tab_id: id, workspace_id: workspace });
    state.agents.push({ name, agent: 'codex', agent_status: status, pane_id: `${id}:p`, tab_id: id,
      workspace_id: workspace, cwd: workspace === 'lane' ? lane : repo, terminal_id: id });
    state.runs.push({ id: `R-${state.runs.length + 1}`, started: { seq: state.runs.length + 1 },
      workspace: workspace === 'lane' ? lane : repo, meta: { agent: name }, report: { outcome: 'done' } });
  };
  f.add('finished', 'lane-topic-worker');
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
if (a[0] === 'status') out({ runs: s.runs, items: [] });
else if (a[0] === 'workspace') out({ workspaces: s.workspaces });
else if (a[0] === 'tab' && a[1] === 'list') out({ tabs: s.tabs.filter(t => t.workspace_id === a.at(-1)) });
else if (a[0] === 'pane' && a[1] === 'list') out(s.incomplete ? {} : { panes: s.panes.filter(p => p.workspace_id === a.at(-1)) });
else if (a[0] === 'pane' && a[1] === 'process-info') out({ process_info: { shell_pid: 1, foreground_processes: [{ pid: 1, name: 'zsh' }] } });
else if (a[0] === 'agent' && a[1] === 'list') {
  s.agentReads++;
  if (s.change && s.agentReads >= 2) s.agents[0].agent_status = s.change;
  save(); out({ agents: s.agents });
} else if (a[0] === 'tab' && a[1] === 'close') {
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

test('finished worker tabs close before promotion while working, blocked, unnamed and operator tabs stay', t => {
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

test('a reused worker name with a newer open run and an extra unnamed occupant never close', t => {
  const f = fixture(t);
  f.stateData.runs.push({ ...f.stateData.runs[0], id: 'R-2', started: { seq: 2 }, report: null });
  f.save(); assert.equal(f.tidy(), true); assert.deepEqual(f.read().actions, []);
  f.stateData.runs.pop();
  f.stateData.agents.push({ ...f.stateData.agents[0], name: null });
  f.save(); assert.equal(f.tidy(), true); assert.deepEqual(f.read().actions, []);
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

test('finished reviews and old settle sessions use the existing tidy policy', t => {
  const f = fixture(t);
  f.add('review-old', 'lane-topic-review-old'); f.add('review-new', 'lane-topic-review-new');
  f.stateData.runs = f.stateData.runs.slice(0, 1);
  f.add('settle-old', 'settle-r-9-old', 'idle', 'main', 'settle R-9');
  f.add('settle-new', 'settle-r-10-new', 'done', 'main', 'settle R-10');
  const registry = path.join(f.repo, '.lane/sessions.json.d'), reviews = path.join(f.repo, 'docs/reviews/topic');
  fs.mkdirSync(registry, { recursive: true }); fs.mkdirSync(reviews, { recursive: true });
  for (const [name, created_at] of [['lane-topic-review-old', '2020-01-01T00:00:00Z'], ['lane-topic-review-new', '2099-01-01T00:00:00Z']]) {
    fs.writeFileSync(path.join(registry, `${name}.json`), JSON.stringify({ name, topic: 'topic', role: 'review', created_at }));
  }
  fs.writeFileSync(path.join(reviews, 'verdict.md'), '**PASS**\n');
  const ledger = path.join(f.repo, '.lane/supervisor'); fs.mkdirSync(ledger);
  fs.writeFileSync(path.join(ledger, 'sessions-2026-10-03.log'), '12:00:00 settle-r-9-old settle R-9\n13:00:00 settle-r-10-new settle R-10\n');
  f.save(); assert.equal(f.tidy(), true);
  assert.deepEqual(f.read().actions.map(a => a[2]).sort(), ['finished', 'review-old', 'settle-old']);
});

test('failed and incomplete reads close nothing and are logged without stopping housekeeping', t => {
  const f = fixture(t);
  for (const fail of ['agent list', 'status --json', 'tab close']) {
    f.stateData.fail = fail; f.save(); assert.equal(f.tidy(), false);
    assert.equal(f.logs.at(-1).action, 'tidy-failed'); assert.deepEqual(f.read().actions, []);
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
