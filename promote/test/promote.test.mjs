import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { queueFor, enqueue } from '../promote.mjs';

const CLI = fileURLToPath(new URL('../promote.mjs', import.meta.url));
const LANE = fileURLToPath(new URL('../../lanes/lane.mjs', import.meta.url));
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(fn) {
  const end = Date.now() + 30000;
  while (Date.now() < end) { if (fn()) return; await delay(30); }
  assert.fail('timed out waiting for queue evidence');
}
function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'promote-test-')));
  const repo = path.join(root, 'project'); fs.mkdirSync(repo);
  const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
    npm_config_cache: path.join(root, 'cache'), npm_config_update_notifier: 'false' };
  delete env.NODE_TEST_CONTEXT;
  for (const key of Object.keys(env)) if (/^(LANE_|ORG_|HERDR_|GIT_(?:DIR|WORK_TREE|INDEX_FILE|COMMON_DIR|CONFIG_COUNT))/.test(key)) delete env[key];
  const git = (args, cwd = repo) => {
    const r = spawnSync('git', ['-C', cwd, ...args], { env, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr); return r.stdout.trim();
  };
  git(['init', '-b', 'main']); git(['config', 'user.name', 'Queue test']); git(['config', 'user.email', 'queue@example.invalid']);
  fs.writeFileSync(path.join(repo, 'package.json'), JSON.stringify({ scripts: { test: `${process.execPath} --test check.mjs` } }));
  fs.writeFileSync(path.join(repo, 'check.mjs'), "import assert from 'node:assert/strict'; assert.equal(2 + 2, 4);\n");
  fs.writeFileSync(path.join(repo, 'shared'), 'base\n'); git(['add', '.']); git(['commit', '-qm', 'base']);
  const herdr = path.join(root, 'herdr');
  const notices = path.join(root, 'notices.jsonl');
  fs.writeFileSync(herdr, `#!${process.execPath}\nimport fs from 'node:fs';\nconst args = process.argv.slice(2);\nif (args[0] === 'agent' && args[1] === 'prompt') {\nfs.appendFileSync(${JSON.stringify(notices)}, JSON.stringify(args) + '\\n');\nif (fs.existsSync(${JSON.stringify(path.join(root, 'delivery-fail'))})) process.exit(1);\n}\nprocess.stdout.write(JSON.stringify({result:{workspaces:[],agents:[]}}));\n`);
  fs.chmodSync(herdr, 0o755);
  const queue = queueFor(repo);
  const lane = (topic, content = topic) => {
    const wt = path.join(root, topic); git(['worktree', 'add', '-b', `lane/${topic}`, wt]);
    fs.writeFileSync(path.join(wt, `${topic}.txt`), content); git(['add', '.'], wt); git(['commit', '-qm', topic], wt);
    return wt;
  };
  const cli = (args, cwd = repo) => spawnSync(process.execPath, [CLI, ...args], { cwd, env, encoding: 'utf8', timeout: 10000 });
  const launch = (args) => {
    const r = cli([...args, '--herdr', herdr, '--delivery-attempts', '2', '--retry-seconds', '0']);
    assert.equal(r.status, 0, r.stderr); return JSON.parse(r.stdout);
  };
  const results = () => queue.load().results;
  const messages = () => fs.existsSync(notices) ? fs.readFileSync(notices, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [];
  t.after(async () => {
    await until(() => !fs.existsSync(path.join(queue.directory, 'worker.lock')));
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { root, repo, env, git, lane, cli, launch, queue, results, messages, herdr };
}

test('unconfigured project: detached worker promotes two lanes in FIFO order using default npm gate', async (t) => {
  const f = fixture(t); const first = f.lane('first'), second = f.lane('second');
  const launched = f.launch(['first', 'second']); assert.ok(launched.worker.ready);
  await until(() => f.results().length === 2);
  assert.deepEqual(f.results().map((r) => [r.topic, r.outcome, r.delivered]), [['first', 'promoted', true], ['second', 'promoted', true]]);
  assert.equal(fs.existsSync(first), false); assert.equal(fs.existsSync(second), false);
  assert.equal(f.git(['rev-list', '--merges', 'main']), '');
  assert.equal(f.git(['remote']), '');
  assert.deepEqual(f.messages().map((args) => args[2]), ['supervisor-herdr', 'supervisor-herdr']);
  assert.match(f.messages()[0][3], /lane=first outcome=promoted/); assert.match(f.messages()[1][3], /lane=second outcome=promoted/);
  assert.match(fs.readFileSync(f.results()[1].log, 'utf8'), /rebased lane\/second/);
  assert.equal(f.git(['status', '--porcelain']), '');
  assert.equal(fs.existsSync(path.join(f.repo, '.promote.json')), false);
});

for (const mode of ['dirty', 'red', 'conflict']) test(`${mode} refusal is delivered; lane kept; next queued lane still promotes`, async (t) => {
  const f = fixture(t); const bad = f.lane('bad'), good = f.lane('good');
  if (mode === 'dirty') fs.writeFileSync(path.join(bad, 'dirty'), 'work');
  if (mode === 'red') {
    fs.writeFileSync(path.join(bad, 'check.mjs'), 'process.exit(1);\n'); f.git(['add', '.'], bad); f.git(['commit', '-qm', 'red'], bad);
  }
  if (mode === 'conflict') {
    fs.writeFileSync(path.join(bad, 'shared'), 'lane\n'); f.git(['add', '.'], bad); f.git(['commit', '-qm', 'lane edit'], bad);
    fs.writeFileSync(path.join(f.repo, 'shared'), 'main\n'); f.git(['add', '.']); f.git(['commit', '-qm', 'main edit']);
  }
  const before = f.git(['rev-parse', `lane/bad`]);
  f.launch(['bad', 'good']); await until(() => f.results().length === 2);
  assert.equal(f.results()[0].outcome, 'refused', fs.readFileSync(f.results()[0].log, 'utf8')); assert.equal(f.results()[0].delivered, true);
  assert.match(f.results()[0].reason, mode === 'dirty' ? /not clean/ : mode === 'red' ? /validation failed/ : /does not rebase cleanly/);
  assert.equal(f.git(['rev-parse', 'lane/bad']), before);
  assert.ok(fs.existsSync(bad)); assert.equal(fs.existsSync(good), false);
  assert.equal(f.results()[1].outcome, 'promoted');
  assert.match(f.messages()[0][3], /lane=bad outcome=refused/);
});

test('delivery failure is durable with notification fallback; draining continues', async (t) => {
  const f = fixture(t); f.lane('first'); f.lane('second'); fs.writeFileSync(path.join(f.root, 'delivery-fail'), '1');
  f.launch(['first', 'second']); await until(() => f.results().length === 2);
  assert.ok(f.results().every((r) => r.outcome === 'promoted' && r.delivered === false && r.delivery_error));
  assert.equal(f.messages().length, 4);
});

test('project override selects supervisor and duplicate pending lanes do not repeat', async (t) => {
  const f = fixture(t); f.lane('first');
  fs.writeFileSync(path.join(f.repo, '.promote.json'), JSON.stringify({ to: 'project-supervisor' }));
  f.git(['add', '.']); f.git(['commit', '-qm', 'promotion target']);
  const opts = { to: 'project-supervisor', attempts: 1, retry: 0, herdr: f.herdr, laneCLI: LANE, org: null };
  const jobs = enqueue(f.queue, ['first', 'first'], opts);
  assert.equal(jobs[0].id, jobs[1].id); assert.equal(jobs[1].duplicate, true);
  const r = f.cli(['--drain']); assert.equal(r.status, 0, r.stderr);
  assert.equal(f.results().length, 1); assert.equal(f.messages()[0][2], 'project-supervisor');
});

test('two concurrent enqueue commands share one drain; direct promote is excluded during its gate', async (t) => {
  const f = fixture(t); f.lane('first'); f.lane('second');
  const marker = path.join(f.root, 'gate');
  const command = `${process.execPath} -e 'require("fs").writeFileSync(${JSON.stringify(marker)}, "ready"); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1800)'`;
  f.launch(['first', '--validate', command]);
  await until(() => fs.existsSync(marker));
  const direct = spawnSync(process.execPath, [LANE, 'promote', 'second'], { cwd: f.repo, env: f.env, encoding: 'utf8' });
  assert.notEqual(direct.status, 0); assert.match(direct.stderr, /lane-promote.lock/);
  f.launch(['second']); await until(() => f.results().length === 2);
  assert.deepEqual(f.results().map((r) => r.topic), ['first', 'second']);
  assert.ok(f.results().every((r) => r.outcome === 'promoted'));
});

test('enqueue during the empty-worker handoff always starts a new drain', async (t) => {
  const f = fixture(t); f.lane('first'); f.lane('second');
  f.launch(['first']); await until(() => f.results().length === 1);
  f.launch(['second']); await until(() => f.results().length === 2);
  assert.ok(f.results().every((r) => r.outcome === 'promoted'));
});

test('interrupted attempt emits a notice without retrying a gate or deleting its lane', async (t) => {
  const f = fixture(t); const wt = f.lane('first');
  const opts = { to: 'supervisor-herdr', attempts: 1, retry: 0, herdr: f.herdr, laneCLI: LANE, org: null };
  enqueue(f.queue, ['first'], opts);
  f.queue.transaction((data) => { data.current = { ...data.pending.shift(), phase: 'promoting' }; });
  const before = f.git(['rev-parse', 'main']);
  const r = f.cli(['--drain']); assert.equal(r.status, 0, r.stderr);
  assert.equal(f.results()[0].outcome, 'interrupted'); assert.equal(f.git(['rev-parse', 'main']), before);
  assert.ok(fs.existsSync(wt)); assert.match(f.messages()[0][3], /outcome=interrupted/);
});

test('stale worker lock refuses startup while keeping the queued request', async (t) => {
  const f = fixture(t); f.lane('first');
  const lock = path.join(f.queue.directory, 'worker.lock'); fs.mkdirSync(lock);
  fs.writeFileSync(path.join(lock, 'owner.json'), JSON.stringify({ pid: 2147483647 }));
  const r = f.cli(['first', '--herdr', f.herdr]);
  assert.notEqual(r.status, 0); assert.equal(f.queue.load().pending.length, 1);
  fs.rmSync(lock, { recursive: true });
});

test('green gate that modifies its worktree is refused before fast-forward', (t) => {
  const f = fixture(t); const wt = f.lane('first'); const before = f.git(['rev-parse', 'main']);
  const env = { ...f.env, LANE_VALIDATE: `${process.execPath} -e 'require("fs").writeFileSync("first.txt", "changed")'` };
  const r = spawnSync(process.execPath, [LANE, 'promote', 'first'], { cwd: wt, env, encoding: 'utf8' });
  assert.notEqual(r.status, 0); assert.match(r.stderr, /validated lane worktree is not clean/);
  assert.equal(f.git(['rev-parse', 'main']), before);
});

test('recorded completed outcome resumes delivery without repeating promotion', (t) => {
  const f = fixture(t); const wt = f.lane('first');
  enqueue(f.queue, ['first'], { to: 'supervisor-herdr', attempts: 1, retry: 0, herdr: f.herdr, laneCLI: LANE, org: null });
  f.queue.transaction((data) => { data.current = { ...data.pending.shift(), phase: 'completed', result: { outcome: 'refused', reason: 'saved refusal' } }; });
  const before = f.git(['rev-parse', 'main']);
  const r = f.cli(['--drain']); assert.equal(r.status, 0, r.stderr);
  assert.equal(f.git(['rev-parse', 'main']), before); assert.ok(fs.existsSync(wt));
  assert.equal(f.results()[0].reason, 'saved refusal'); assert.match(f.messages()[0][3], /saved refusal/);
});

test('queued cleanup closes the recorded finished tab and preserves operator and other lane tabs', async (t) => {
  const f = fixture(t); const wt = f.lane('first'); const other = f.lane('other');
  const orgCLI = fileURLToPath(new URL('../../bin/org.mjs', import.meta.url));
  const org = path.join(f.root, 'record');
  const record = (args) => {
    const r = spawnSync(process.execPath, [orgCLI, ...args], { cwd: f.repo, env: { ...f.env, ORG_DIR: org }, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr); return r.stdout.trim();
  };
  record(['init', org]);
  const item = record(['add', 'Finished first lane', '--role', 'engineer']).split(/\s/)[0];
  const report = path.join(f.root, 'report.md');
  const run = record(['start', item, '--harness', 'codex', '--model', 'offline', '--effort', 'high', '--workspace', wt, '--report', report]).split(/\s/)[0];
  record(['set', run, 'agent=worker', 'pane=w:p1', 'worker_workspace=w', 'terminal_id=terminal-first', 'lane=first']);
  fs.writeFileSync(report, `---\nrun: ${run}\noutcome: done\nsummary: Finished.\nheadline: Finished lane\nblockers: []\nproposals: []\nlearnings: []\nartifacts: []\n---\n`);
  record(['ingest', report]);
  const calls = path.join(f.root, 'cleanup-calls');
  const topology = {
    workspaces: [
      { workspace_id: 'w', worktree: { checkout_path: wt, repo_root: f.repo, repo_key: f.queue.project.identity, is_linked_worktree: true } },
      { workspace_id: 'other', worktree: { checkout_path: other, repo_root: f.repo, repo_key: f.queue.project.identity, is_linked_worktree: true } },
    ],
    tabs: [{ tab_id: 'w:worker', label: 'worker' }, { tab_id: 'w:operator', label: 'operator' }],
    panes: [{ pane_id: 'w:p1', tab_id: 'w:worker' }, { pane_id: 'w:p2', tab_id: 'w:operator' }],
    agents: [
      { name: 'worker', agent: 'codex', agent_status: 'idle', pane_id: 'w:p1', tab_id: 'w:worker', workspace_id: 'w', cwd: wt, terminal_id: 'terminal-first' },
      { name: null, agent_status: 'idle', pane_id: 'w:p2', tab_id: 'w:operator', workspace_id: 'w', cwd: wt },
    ],
  };
  fs.writeFileSync(f.herdr, `#!${process.execPath}\nimport fs from 'node:fs'; const a=process.argv.slice(2); const d=${JSON.stringify(topology)}; fs.appendFileSync(${JSON.stringify(calls)},JSON.stringify(a)+'\\n'); let r={};
if(a[0]==='workspace'&&a[1]==='list')r={workspaces:d.workspaces};
if(a[0]==='tab'&&a[1]==='list')r={tabs:d.tabs};
if(a[0]==='pane'&&a[1]==='list')r={panes:d.panes};
if(a[0]==='pane'&&a[1]==='process-info')r={process_info:{shell_pid:1,foreground_processes:[{pid:1,name:'zsh'}]}};
if(a[0]==='agent'&&a[1]==='list')r={agents:d.agents};
console.log(JSON.stringify({result:r}));\n`);
  f.launch(['first', '--org', org]); await until(() => f.results().length === 1);
  assert.equal(f.results()[0].outcome, 'promoted'); assert.deepEqual(f.results()[0].warnings, []);
  const actions = fs.readFileSync(calls, 'utf8').trim().split('\n').map(JSON.parse);
  assert.deepEqual(actions.filter((a) => a[0] === 'tab' && a[1] === 'close'), [['tab', 'close', 'w:worker']]);
  assert.ok(!actions.some((a) => a[0] === 'worktree' || a[0] === 'workspace' && a[1] !== 'list'));
  assert.ok(!actions.some((a) => ['pane','tab'].includes(a[0]) && a[1] === 'list' && a.at(-1) === 'other'));
  assert.equal(fs.existsSync(wt), false); assert.equal(fs.existsSync(other), true);
});
