import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createHousekeeping, interruptedComposer, matchingRun, readConfig } from '../housekeeping.mjs';

const screen = fs.readFileSync(new URL('./fixtures/interrupted.txt', import.meta.url), 'utf8');
const cli = fileURLToPath(new URL('../housekeeping.mjs', import.meta.url));
function fixture(t, { promoted = true, reported = true } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'housekeeping-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const repo = path.join(root, 'project'), lane = path.join(root, 'lane');
  fs.mkdirSync(repo);
  const git = (args, cwd = repo) => {
    const r = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr); return r.stdout.trim();
  };
  git(['init', '-b', 'main']); git(['config', 'user.name', 'Test']); git(['config', 'user.email', 'test@example.invalid']);
  fs.writeFileSync(path.join(repo, 'file'), 'base'); git(['add', '.']); git(['commit', '-m', 'base']);
  git(['worktree', 'add', '-b', 'lane/topic', lane]);
  fs.writeFileSync(path.join(lane, 'file'), 'work'); git(['add', '.'], lane); git(['commit', '-m', 'work'], lane);
  if (promoted) git(['merge', '--ff-only', 'lane/topic']);
  const common = fs.realpathSync(path.join(repo, '.git'));
  const agent = { name: 'lane-worker', agent: 'codex', agent_status: 'idle', pane_id: 'w:p', tab_id: 'w:t',
    workspace_id: 'w', cwd: lane, terminal_id: 'term-a', state_change_seq: 7 };
  const run = { id: 'R-1', item: 'ENG-1', started: { seq: 1 }, workspace: lane, report_path: path.join(lane, 'report.md'),
    meta: { agent: agent.name, pane: agent.pane_id, worker_workspace: 'w', terminal_id: agent.terminal_id, lane: 'topic' },
    report: reported ? { outcome: 'done' } : null, abandoned: null };
  const f = { root, repo, lane, git, common, agent, run,
    items: [{ id: 'ENG-1', status: reported ? 'done' : 'active', blocked_by: [] }], runs: [run], agents: [agent],
    tabs: [{ tab_id: 'w:t', label: 'worker' }], panes: [{ pane_id: 'w:p', tab_id: 'w:t' }],
    ws: [{ workspace_id: 'w', worktree: { checkout_path: lane, repo_root: repo, repo_key: common, is_linked_worktree: true } }],
    actions: [], logs: [], shell: true, text: screen, before: () => {} };
  f.command = (exe, args, options) => {
    if (exe === 'git') return spawnSync(exe, args, options);
    f.before(exe, args);
    const result = (value) => ({ status: 0, stdout: JSON.stringify({ result: value }), stderr: '' });
    if (exe === 'fake-record') return result({ runs: f.runs, items: f.items });
    assert.equal(exe, 'fake-herdr');
    if (args[0] === 'workspace') return result({ workspaces: f.ws });
    if (args[0] === 'tab' && args[1] === 'list') return result({ tabs: f.tabs });
    if (args[0] === 'pane' && args[1] === 'list') return result({ panes: f.panes });
    if (args[0] === 'pane' && args[1] === 'process-info') return result({ process_info: { shell_pid: 1,
      foreground_processes: [{ pid: f.shell ? 1 : 2, name: f.shell ? 'zsh' : 'node' }] } });
    if (args[0] === 'agent' && args[1] === 'list') return result({ agents: f.agents });
    if (args[0] === 'agent' && args[1] === 'read') return { status: 0, stdout: f.text, stderr: '' };
    f.actions.push(args);
    return result({});
  };
  f.runner = (extra = {}) => createHousekeeping({ cwd: repo, org: root, herdr: 'fake-herdr', record: ['fake-record'],
    command: f.command, log: (entry) => f.logs.push(entry), selfTab: null, ...extra });
  return f;
}

test('interruption requires the current banner and an exclusively wheel-junk composer', () => {
  assert.equal(interruptedComposer(screen), true);
  assert.equal(interruptedComposer(screen.replace('<65;12;9M<64;12;9M', '\x1b[<65;12;9M')), true);
  for (const value of [screen.replace('■ Conversation interrupted', 'Finished'),
    screen.replace('› <65;12;9M<64;12;9M', '› continue'),
    screen.replace('<65;12;9M', 'stop <65;12;9M'),
    screen.replace('\n›', '\n• Finished and wrote the report.\n›'),
    screen.replace('<65;12;9M<64;12;9M', '<0;12;9M'),
    screen.replace('› <65;12;9M<64;12;9M', '› Ask Codex to do anything')]) assert.equal(interruptedComposer(value), false);
});

test('recorded promoted workers close through the shared tidy planner', (t) => {
  const f = fixture(t); const plan = f.runner().tick();
  assert.equal(plan.close.length, 1); assert.deepEqual(f.actions, [['tab', 'close', 'w:t']]);
  assert.match(f.logs.find((x) => x.action === 'closed').why, /R-1/);
});

test('abandoned promoted workers may close', (t) => {
  const f = fixture(t); f.run.report = null; f.run.abandoned = { seq: 4 };
  f.runner().tick(); assert.equal(f.actions.length, 1);
});

test('CLI-closed unmerged work is authorized by its Git archive, never a session done marker', (t) => {
  const f = fixture(t, { promoted: false });
  f.git(['worktree', 'remove', f.lane]); f.git(['tag', 'archive/lane/topic', 'lane/topic']); f.git(['branch', '-D', 'lane/topic']);
  f.runner().tick(); assert.deepEqual(f.actions, [['tab', 'close', 'w:t']]);
});

for (const variant of ['open', 'unpromoted', 'dirty', 'blocked', 'working', 'unknown', 'unnamed', 'unrecorded',
  'replaced', 'waiting', 'report-blocked', 'report-needs-human', 'new-open-run', 'declined', 'wrong-repo', 'mixed-pane', 'running-shell', 'session-done', 'review-file']) {
  test(`preserves ${variant} workers/tabs`, (t) => {
    const f = fixture(t, { promoted: !['unpromoted', 'session-done', 'review-file'].includes(variant) });
    if (variant === 'session-done') {
      fs.mkdirSync(path.join(f.repo, '.lane/sessions.json.d'), { recursive: true });
      fs.writeFileSync(path.join(f.repo, '.lane/sessions.json.d/display.done.json'), JSON.stringify({ name: f.agent.name, done: true }));
    }
    if (variant === 'review-file') {
      fs.mkdirSync(path.join(f.lane, 'docs/reviews/topic'), { recursive: true });
      fs.writeFileSync(path.join(f.lane, 'docs/reviews/topic/latest.md'), '**PASS**');
    }
    if (variant === 'open') { f.run.report = null; f.text = 'finished\n› Ask Codex'; }
    if (variant === 'dirty') fs.writeFileSync(path.join(f.lane, 'file'), 'dirty');
    if (['blocked', 'working', 'unknown'].includes(variant)) f.agent.agent_status = variant;
    if (variant === 'unnamed') delete f.agent.name;
    if (variant === 'unrecorded') f.runs = [];
    if (variant === 'replaced') f.agent.terminal_id = 'term-new';
    if (variant === 'waiting') { f.items[0].blocked_by = ['HUM-1']; f.items.push({ id: 'HUM-1', status: 'ready' }); }
    if (variant === 'declined') { f.items[0].blocked_by = ['HUM-1']; f.items.push({ id: 'HUM-1', status: 'done', closed: {}, meta: { answer: 'no' } }); }
    if (variant.startsWith('report-')) f.run.report.outcome = variant === 'report-blocked' ? 'blocked' : 'needs_human';
    if (variant === 'new-open-run') f.runs.push({ ...f.run, id: 'R-2', report: null, started: { seq: 2 }, meta: { ...f.run.meta, agent: 'new-worker' } });
    if (variant === 'wrong-repo') f.ws[0].worktree.repo_key = f.root;
    if (variant === 'mixed-pane') { f.agents.push({ ...f.agent, name: 'operator', pane_id: 'w:q' }); f.panes.push({ pane_id: 'w:q', tab_id: 'w:t' }); }
    if (variant === 'running-shell') { f.shell = false; f.panes.push({ pane_id: 'w:q', tab_id: 'w:t' }); }
    f.runner().tick(); assert.deepEqual(f.actions, []);
  });
}

test('latest open fix round defeats an older reported run using the same worker name', (t) => {
  const f = fixture(t); const later = { ...f.run, id: 'R-2', report: null, started: { seq: 2 } };
  f.runs.push(later); assert.equal(matchingRun(f.agent, f.runs), later);
  f.text = 'finished\n› Ask Codex'; f.runner().tick(); assert.deepEqual(f.actions, []);
});

test('unknown finished sessions stay; exited watcher shell tabs use tidy-tabs', (t) => {
  const f = fixture(t); f.ws[0].worktree.is_linked_worktree = false;
  f.ws[0].worktree.checkout_path = f.repo;
  f.tabs[0].label = 'watch R-99'; f.agents = [];
  f.runner().tick(); assert.deepEqual(f.actions, [['tab', 'close', 'w:t']]);
  f.actions = []; f.tabs[0].label = 'executive'; f.agents = [{ ...f.agent, name: 'exec-1' }];
  f.runner().tick(); assert.deepEqual(f.actions, []);
});

test('never closes or resumes its own tab', (t) => {
  const f = fixture(t); f.runner({ selfTab: 'w:t' }).tick(); assert.deepEqual(f.actions, []);
  f.run.report = null; f.runner({ selfTab: 'w:t' }).tick(); assert.deepEqual(f.actions, []);
});

test('an interrupted open worker resumes once, and durable attempts survive a new runner', (t) => {
  const f = fixture(t, { reported: false }); const seen = new Set(), attempts = [];
  f.runner().tick({ seen, remember: (key) => attempts.push(key) });
  assert.equal(attempts.length, 1);
  assert.deepEqual(f.actions.map((a) => a.slice(0, 2)), [['agent', 'send-keys'], ['agent', 'prompt']]);
  f.runner().tick({ seen: new Set(attempts) }); assert.equal(f.actions.length, 2);
});

test('failed prompt is logged and never replayed at the same state sequence', (t) => {
  const f = fixture(t, { reported: false }); const seen = new Set();
  const original = f.command;
  f.command = (exe, args, opts) => args[1] === 'prompt' ? { status: 1, stderr: 'offline', stdout: '' } : original(exe, args, opts);
  f.runner().tick({ seen }); f.runner().tick({ seen });
  assert.equal(f.actions.length, 1); assert.equal(f.logs.some((e) => e.action === 'resume-failed'), true);
});

test('unrecorded disk report, human words, other harness and absent identity prevent resume', (t) => {
  const f = fixture(t, { reported: false });
  fs.writeFileSync(f.run.report_path, 'not yet ingested'); f.runner().tick(); assert.deepEqual(f.actions, []);
  fs.unlinkSync(f.run.report_path);
  f.text = screen.replace('<65;', 'stop <65;'); f.runner().tick(); assert.deepEqual(f.actions, []);
  f.text = screen; f.agent.agent = 'claude'; f.runner().tick(); assert.deepEqual(f.actions, []);
  f.agent.agent = 'codex'; delete f.run.meta.terminal_id; f.runner().tick(); assert.deepEqual(f.actions, []);
});

test('dry run reports close/resume plans and persists no attempts or live actions', (t) => {
  const f = fixture(t); f.runner().tick({ dryRun: true }); assert.equal(f.logs.some((e) => e.action === 'would-close'), true);
  f.run.report = null;
  f.runner().tick({ dryRun: true, remember: () => assert.fail('persisted') });
  assert.equal(f.logs.some((e) => e.action === 'would-resume'), true); assert.deepEqual(f.actions, []);
});

test('fresh state or record changes prevent deletion', (t) => {
  const f = fixture(t); let reads = 0;
  f.before = (exe, args) => { if (args[0] === 'agent' && args[1] === 'list' && ++reads === 2) f.agent.agent_status = 'working'; };
  f.runner().tick(); assert.deepEqual(f.actions, []); assert.equal(f.logs.some((e) => e.action === 'skip-close'), true);
});

test('a run completed during the pre-input recheck receives no resume input', (t) => {
  const f = fixture(t, { reported: false }); let reads = 0;
  f.before = (exe) => { if (exe === 'fake-record' && ++reads === 2) f.run.report = { outcome: 'done' }; };
  f.runner().tick(); assert.deepEqual(f.actions, []);
});

test('a record change after clearing composer suppresses the prompt', (t) => {
  const f = fixture(t, { reported: false }); let reads = 0;
  f.before = (exe) => { if (exe === 'fake-record' && ++reads === 3) f.run.report = { outcome: 'done' }; };
  f.runner().tick(); assert.deepEqual(f.actions.map((a) => a[1]), ['send-keys']);
  assert.equal(f.logs.some((e) => e.action === 'skip-resume'), true);
});

test('incomplete or failed reads never authorize any action', (t) => {
  const f = fixture(t); const original = f.command;
  for (const failure of ['herdr', 'record', 'topology']) {
    f.command = (exe, args, opts) => {
      if ((failure === 'herdr' && args[0] === 'agent') || (failure === 'record' && exe === 'fake-record')) return { status: 1, stdout: '', stderr: 'offline' };
      if (failure === 'topology' && args[0] === 'pane' && args[1] === 'list') return { status: 0, stdout: '{"result":{}}' };
      return original(exe, args, opts);
    };
    assert.throws(() => f.runner().tick(), /offline|topology/); assert.deepEqual(f.actions, []);
  }
});

function cliFixture(t) {
  const f = fixture(t);
  f.config = path.join(f.root, 'config.json'); f.state = path.join(f.root, 'state');
  fs.writeFileSync(f.config, JSON.stringify({ enabled: true, tick_seconds: 1, cleanup_seconds: 2 }));
  const fake = path.join(f.root, 'fake.mjs');
  fs.writeFileSync(fake, `#!${process.execPath}\nconst [group, op] = process.argv.slice(2);\nconst result = group === 'status' ? {runs:[], items:[]} : group === 'workspace' ? {workspaces:[]} : {agents:[]};\nconsole.log(JSON.stringify({result}));\n`);
  fs.chmodSync(fake, 0o755);
  f.args = [cli, '--cwd', f.repo, '--org', f.root, '--config', f.config, '--state-dir', f.state, '--herdr', fake, '--org-cli', fake];
  return f;
}

test('one-shot logs actions, disabled config stops, invalid config refuses, and overlap refuses', (t) => {
  const f = cliFixture(t);
  const run = () => spawnSync(process.execPath, [...f.args, '--once'], { encoding: 'utf8' });
  assert.equal(run().status, 0);
  assert.equal(fs.existsSync(path.join(f.state, 'actions.jsonl')), true);
  fs.writeFileSync(f.config, '{"enabled":false}'); assert.match(run().stdout, /disabled/);
  fs.writeFileSync(f.config, '{"enabled":"yes"}'); assert.equal(run().status, 1);
  assert.throws(() => readConfig(f.config), /enabled/);
  fs.mkdirSync(path.join(f.state, 'lock')); assert.equal(run().status, 1);
});

test('the loop rereads opt-in and shuts down with its lock removed', async (t) => {
  const f = cliFixture(t);
  const child = spawn(process.execPath, [...f.args, '--loop'], { stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => child.kill());
  let output = '', errors = '';
  child.stdout.on('data', (chunk) => {
    output += chunk;
    if (output.includes('scan')) fs.writeFileSync(f.config, '{"enabled":false}');
  });
  child.stderr.on('data', (chunk) => { errors += chunk; });
  const code = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.kill(); reject(new Error(`loop did not exit: ${output} ${errors}`)); }, 5000);
    child.on('exit', (code) => { clearTimeout(timer); resolve(code); });
  });
  assert.equal(code, 0, errors); assert.match(output, /disabled/);
  assert.equal(fs.existsSync(path.join(f.state, 'lock')), false);
});

test('no configuration defaults on and project record/main are discovered from a linked checkout', (t) => {
  const f = cliFixture(t);
  fs.mkdirSync(path.join(f.repo, '.org'));
  fs.writeFileSync(path.join(f.repo, '.org/events.jsonl'), '');
  f.git(['branch', '-m', 'main', 'trunk']);
  const args = f.args.filter((arg, i, all) => !['--org', '--config'].includes(arg) && !['--org', '--config'].includes(all[i - 1]));
  args[args.indexOf('--cwd') + 1] = f.lane;
  const r = spawnSync(process.execPath, [...args, '--once'], { encoding: 'utf8', env: { ...process.env, ORG_DIR: '' } });
  assert.equal(r.status, 0, r.stderr); assert.match(r.stdout, /scan/);
  assert.deepEqual(readConfig(path.join(f.root, 'missing')), { enabled: true, tick_seconds: 60, cleanup_seconds: 600 });
});

test('no record and no Git project are quiet no-ops', (t) => {
  const f = cliFixture(t);
  const r = spawnSync(process.execPath, [cli, '--once', '--cwd', f.lane], { encoding: 'utf8', env: { ...process.env, ORG_DIR: '' } });
  assert.equal(r.status, 0); assert.match(r.stdout, /no-record/);
  const outside = spawnSync(process.execPath, [cli, '--once', '--cwd', f.root], { encoding: 'utf8' });
  assert.equal(outside.status, 0); assert.match(outside.stdout, /no-project/);
});

test('agent-entry start runs one detached deterministic schedule and repeated start is idempotent', async (t) => {
  const f = cliFixture(t);
  const start = () => spawnSync(process.execPath, [...f.args, '--start'], { encoding: 'utf8', timeout: 10000 });
  const first = start(); assert.equal(first.status, 0, first.stderr); assert.match(first.stdout, /started/);
  const lock = path.join(f.state, 'lock');
  const pid = JSON.parse(fs.readFileSync(path.join(lock, 'owner.json'), 'utf8')).pid;
  t.after(() => { try { process.kill(pid, 'SIGTERM'); } catch {} });
  const again = start(); assert.equal(again.status, 0, again.stderr); assert.match(again.stdout, /already-running/);
  fs.writeFileSync(f.config, '{"enabled":false}');
  await new Promise((resolve, reject) => {
    const deadline = Date.now() + 5000;
    const check = () => {
      if (!fs.existsSync(lock)) return resolve();
      if (Date.now() > deadline) return reject(new Error('detached schedule did not stop'));
      setTimeout(check, 50);
    }; check();
  });
  assert.match(fs.readFileSync(path.join(f.state, 'actions.jsonl'), 'utf8'), /disabled/);
});

test('dry-run start leaves no timer process', (t) => {
  const f = cliFixture(t);
  const r = spawnSync(process.execPath, [...f.args, '--start', '--dry-run'], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr); assert.match(r.stdout, /would-start/);
  assert.equal(fs.existsSync(path.join(f.state, 'lock')), false);
});
