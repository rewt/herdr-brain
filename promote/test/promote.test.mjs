import test from '../../test/helpers/bounded-test.mjs';
import { spawnChild, waitForExit, childProcessEntry } from '../../test/helpers/child.mjs';
import { registerProcess, killProcess } from '../../test/helpers/processes.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { queueFor, enqueue } from '../promote.mjs';
import { readInbox } from '../../supervisor/prompt-supervisor.mjs';

const CLI = fileURLToPath(new URL('../promote.mjs', import.meta.url));
const LANE = fileURLToPath(new URL('../../lanes/lane.mjs', import.meta.url));
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const quietFake = `
if (args[0]==='agent' && args[1]==='get') {console.log(JSON.stringify({result:{agent:{agent:'claude',agent_status:'idle',pane_id:'fake:supervisor'}}}));process.exit(0);}
if (args[0]==='pane' && args[1]==='read') {console.log(process.env.PROMOTE_TEST_COMPOSER && fs.existsSync(process.env.PROMOTE_TEST_COMPOSER) ? fs.readFileSync(process.env.PROMOTE_TEST_COMPOSER,'utf8') : '────────────────────\\n❯ \\n────────────────────');process.exit(0);}
`;
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
  env.ORG_ACTOR = 'promote-test-agent';
  env.SUPERVISOR_INPUT_CONFIRM_SECONDS = '0.02';
  env.SUPERVISOR_INPUT_POLL_SECONDS = '0.02';
  env.SUPERVISOR_INPUT_WAIT_SECONDS = '2';
  env.PROMOTE_TEST_COMPOSER = path.join(root, 'composer');
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
  fs.writeFileSync(herdr, `#!${process.execPath}\nimport fs from 'node:fs';\nconst args = process.argv.slice(2);\n${quietFake}\nif (args[0] === 'agent' && args[1] === 'prompt') {\nfs.appendFileSync(${JSON.stringify(notices)}, JSON.stringify(args) + '\\n');\nif (fs.existsSync(${JSON.stringify(path.join(root, 'delivery-fail'))})) process.exit(1);\n}\nprocess.stdout.write(JSON.stringify({result:{workspaces:[],agents:[]}}));\n`);
  fs.chmodSync(herdr, 0o755);
  const queue = queueFor(repo);
  const lane = (topic, content = topic) => {
    const wt = path.join(root, topic); git(['worktree', 'add', '-b', `lane/${topic}`, wt]);
    fs.writeFileSync(path.join(wt, `${topic}.txt`), content); git(['add', '.'], wt); git(['commit', '-qm', topic], wt);
    return wt;
  };
  const processes = new Map();
  const cli = (args, cwd = repo) => {
    const result = spawnSync(process.execPath, [CLI, ...args], { cwd, env, encoding: 'utf8', timeout: 10000 });
    const owner = path.join(queue.directory, 'worker.lock/owner.json');
    if (result.status === 0 && fs.existsSync(owner)) {
      const pid = JSON.parse(fs.readFileSync(owner, 'utf8')).pid;
      if (!processes.has(pid)) {
        const entry = registerProcess(pid);
        assert.ok(entry.command.includes(CLI) && entry.command.includes(repo), 'acknowledged worker command belongs to this fixture');
        processes.set(pid, entry);
      }
    }
    return result;
  };
  const launch = (args) => {
    const r = cli([...args, '--herdr', herdr, '--delivery-attempts', '2', '--retry-seconds', '0']);
    assert.equal(r.status, 0, r.stderr); return JSON.parse(r.stdout);
  };
  const results = () => queue.load().results;
  const messages = () => fs.existsSync(notices) ? fs.readFileSync(notices, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [];
  let cleanupProcesses = async () => {};
  t.after(async () => {
    try {
      await cleanupProcesses();
      await until(() => !fs.existsSync(path.join(queue.directory, 'worker.lock')));
    } finally {
      for (const entry of processes.values()) killProcess(entry);
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
  return { root, repo, env, git, lane, cli, launch, queue, results, messages, herdr, ownedProcess: (pid) => processes.get(pid), onCleanup: (fn) => { cleanupProcesses = fn; } };
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

test('promotion notice queues during typing and delivers after clearing without repeating promotion', async (t) => {
  const f = fixture(t); f.lane('first');
  const inbox = path.join(f.repo, '.git/supervisor/inbox.log');
  fs.writeFileSync(f.env.PROMOTE_TEST_COMPOSER, fs.readFileSync(new URL('../../supervisor/test/fixtures/claude-typed.ansi', import.meta.url)));
  f.launch(['first']);
  await until(() => fs.existsSync(inbox) && readInbox(inbox).length === 1);
  assert.deepEqual(f.messages(), []); assert.equal(f.queue.load().current.phase, 'completed');
  fs.writeFileSync(f.env.PROMOTE_TEST_COMPOSER, fs.readFileSync(new URL('../../supervisor/test/fixtures/claude-empty.ansi', import.meta.url)));
  await until(() => f.results().length === 1);
  assert.equal(f.results()[0].outcome, 'promoted'); assert.equal(f.results()[0].delivered, true);
  assert.equal(f.messages().length, 1); assert.equal(readInbox(inbox)[0].state, 'sent');
});

test('queue refuses a lane changed while pending behind another job before validation or integration', { timeout: 20000 }, (t) => {
  const f = fixture(t); f.lane('first'); const wt = f.lane('second');
  const opts = { to: 'supervisor-herdr', attempts: 1, retry: 0, herdr: f.herdr, laneCLI: LANE, org: null };
  enqueue(f.queue, ['first'], opts);
  const expected = f.git(['rev-parse', 'lane/second']);
  enqueue(f.queue, ['second'], { ...opts, expectedHead: expected });
  fs.writeFileSync(path.join(wt, 'second.txt'), 'unreviewed work'); f.git(['add', '.'], wt); f.git(['commit', '-qm', 'New work while queued'], wt);
  const actual = f.git(['rev-parse', 'lane/second']);
  const r = f.cli(['--drain']); assert.equal(r.status, 0, r.stderr);
  const [first, second] = f.results();
  assert.equal(first.outcome, 'promoted'); assert.equal(second.outcome, 'refused');
  assert.equal(second.expectedHead, expected);
  assert.match(second.reason, new RegExp(`expected ${expected}, found ${actual}`));
  assert.match(f.messages()[1][3], /outcome=refused .*lane tip differs from expected head/);
  assert.doesNotMatch(fs.readFileSync(second.log, 'utf8'), /validating in/);
  assert.equal(f.git(['rev-parse', 'main']), first.tip);
  assert.equal(f.git(['rev-parse', 'lane/second']), actual); assert.ok(fs.existsSync(wt));
});

test('expected head survives CLI enqueue and succeeds exactly; a changed binding cannot reuse a pending job', { timeout: 20000 }, async (t) => {
  const f = fixture(t); f.lane('first'); const expected = f.git(['rev-parse', 'lane/first']);
  const opts = { to: 'supervisor-herdr', attempts: 1, retry: 0, herdr: f.herdr, laneCLI: LANE, org: null, expectedHead: expected };
  const [job] = enqueue(f.queue, ['first'], opts);
  assert.equal(enqueue(f.queue, ['first'], opts)[0].id, job.id);
  assert.throws(() => enqueue(f.queue, ['first'], { ...opts, expectedHead: '0'.repeat(40) }), /different head or run binding/);
  assert.throws(() => enqueue(f.queue, ['first'], { ...opts, expectedHead: undefined }), /different head or run binding/);
  assert.throws(() => enqueue(f.queue, ['first', 'second'], opts), /requires one lane/);
  assert.equal(f.cli(['first', '--expected-head', 'HEAD']).status, 1);
  const request = f.launch(['first', '--expected-head', expected]); assert.equal(request.jobs[0].id, job.id);
  await until(() => f.results().length === 1);
  assert.equal(f.results()[0].expectedHead, expected); assert.equal(f.results()[0].tip, expected);
  assert.equal(f.results()[0].outcome, 'promoted'); assert.equal(f.git(['rev-parse', 'main']), expected);
});

test('expected head refuses an automatic rebase and post-preparation tip changes', { timeout: 20000 }, (t) => {
  for (const mode of ['rebase', 'prepare']) {
    const f = fixture(t); const wt = f.lane('first'), expected = f.git(['rev-parse', 'lane/first']);
    if (mode === 'rebase') {
      fs.writeFileSync(path.join(f.repo, 'new-base'), 'new base'); f.git(['add', '.']); f.git(['commit', '-qm', 'Advance main']);
    } else {
      const file = path.join(f.root, 'prepare.mjs');
      fs.writeFileSync(file, `import fs from 'node:fs'; import {execFileSync} from 'node:child_process'; fs.writeFileSync('new-work','unreviewed'); execFileSync('git',['add','.']);execFileSync('git',['commit','-qm','Preparation changed head']);\n`);
      const config = path.join(f.root, 'lane.json'); fs.writeFileSync(config, JSON.stringify({ prepare: [{ run: `${process.execPath} ${file}` }] }));
      f.env.LANE_CONFIG = config;
    }
    const base = f.git(['rev-parse', 'main']);
    const r = spawnSync(process.execPath, [LANE, 'promote', 'first', '--expected-head', expected], { cwd: f.repo, env: f.env, encoding: 'utf8', timeout: 10000 });
    assert.equal(r.status, 1, r.stdout); assert.match(r.stderr, mode === 'rebase' ? /requires a rebase/ : /tip differs from expected head/);
    assert.doesNotMatch(r.stdout, /validating in/);
    assert.equal(f.git(['rev-parse', 'main']), base); assert.ok(fs.existsSync(wt));
  }
});

test('a completed refusal awaiting delivery permits a fresh attempt without replaying the refused job', { timeout: 15000 }, (t) => {
  const f = fixture(t); f.lane('first');
  const opts = { to: 'supervisor-herdr', attempts: 1, retry: 0, herdr: f.herdr, laneCLI: LANE, org: null, expectedHead: f.git(['rev-parse', 'lane/first']) };
  const [old] = enqueue(f.queue, ['first'], opts);
  f.queue.transaction((q) => { q.current = { ...q.pending.shift(), phase: 'completed', result: { outcome: 'refused', reason: 'Saved lock contention' } }; });
  const [retry] = enqueue(f.queue, ['first'], opts); assert.notEqual(retry.id, old.id);
  assert.equal(f.cli(['--drain']).status, 0);
  assert.deepEqual(f.results().map((r) => [r.id, r.outcome]), [[old.id, 'refused'], [retry.id, 'promoted']]);
  assert.equal(f.git(['rev-parse', 'main']), opts.expectedHead); assert.equal(f.messages().length, 2);
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

test('replay conflict after clean merge-tree preflight names the file in the notice and preserves the lane', async (t) => {
  const f = fixture(t); const bad = f.lane('bad'), good = f.lane('good');
  fs.writeFileSync(path.join(bad, 'shared'), 'lane edit\n');
  f.git(['add', 'shared'], bad); f.git(['commit', '-qm', 'edit shared'], bad);
  fs.writeFileSync(path.join(bad, 'shared'), 'base\n');
  f.git(['add', 'shared'], bad); f.git(['commit', '-qm', 'revert shared'], bad);
  fs.writeFileSync(path.join(f.repo, 'shared'), 'upstream edit\n');
  f.git(['add', 'shared']); f.git(['commit', '-qm', 'upstream edit']);
  const before = f.git(['rev-parse', 'lane/bad']);
  const upstream = f.git(['rev-parse', 'main']);
  const preflight = spawnSync(process.execPath, [LANE, 'rebase-check', 'bad'], {
    cwd: f.repo, env: f.env, encoding: 'utf8',
  });
  assert.equal(preflight.status, 0, preflight.stderr);
  assert.match(preflight.stdout, / clean\n$/);

  f.launch(['bad', 'good']); await until(() => f.results().length === 2);
  const refused = f.results()[0];
  const log = fs.readFileSync(refused.log, 'utf8');
  assert.equal(refused.outcome, 'refused', log);
  assert.equal(refused.delivered, true);
  assert.match(log, /CONFLICT .*shared/);
  assert.doesNotMatch(log, /validating in/);
  assert.match(refused.reason, /^lane: rebase replay onto main failed; conflicts in: shared; lane kept/);
  assert.match(f.messages()[0][3], /lane=bad outcome=refused .*lane: rebase replay onto main failed; conflicts in: shared; lane kept/);
  assert.match(f.messages()[0][3], /resolve or abort the rebase/);
  assert.ok(fs.existsSync(bad));
  assert.equal(f.git(['rev-parse', 'lane/bad']), before);
  assert.equal(f.git(['diff', '--name-only', '--diff-filter=U'], bad), 'shared');
  assert.ok(fs.existsSync(f.git(['rev-parse', '--git-path', 'rebase-merge'], bad)));
  assert.equal(f.results()[1].outcome, 'promoted');
  assert.equal(fs.existsSync(good), false);
  assert.equal(f.git(['merge-base', upstream, 'main']), upstream);
  assert.equal(f.git(['show', 'main:shared']), 'upstream edit');
  assert.equal(fs.existsSync(path.join(f.repo, 'bad.txt')), false);
  assert.equal(f.git(['status', '--porcelain']), '');
  f.git(['rebase', '--abort'], bad);
  assert.equal(f.git(['symbolic-ref', '--short', 'HEAD'], bad), 'lane/bad');
  assert.equal(f.git(['rev-parse', 'HEAD'], bad), before);
  assert.equal(f.git(['status', '--porcelain'], bad), '');
  assert.equal(fs.readFileSync(path.join(bad, 'shared'), 'utf8'), 'base\n');
});

test('uncertain delivery is durable and holds later notices while promotion continues', async (t) => {
  const f = fixture(t); f.lane('first'); f.lane('second'); fs.writeFileSync(path.join(f.root, 'delivery-fail'), '1');
  f.launch(['first', 'second']); await until(() => f.results().length === 2);
  assert.ok(f.results().every((r) => r.outcome === 'promoted' && r.delivered === false && r.delivery_error));
  assert.equal(f.messages().length, 1, 'lost acknowledgements never replay prompts or overtake the first notice');
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

function blockCleanup(f) {
  const org = path.join(f.root, 'cleanup-record');
  const orgCLI = fileURLToPath(new URL('../../bin/org.mjs', import.meta.url));
  const initialized = spawnSync(process.execPath, [orgCLI, 'init', org], { cwd: f.repo, env: f.env, encoding: 'utf8' });
  assert.equal(initialized.status, 0, initialized.stderr);
  const marker = path.join(f.root, 'cleanup-pid');
  const release = path.join(f.root, 'cleanup-release');
  fs.writeFileSync(f.herdr, `#!${process.execPath}\nimport fs from 'node:fs'; const args=process.argv.slice(2);
${quietFake}
if (args[0]==='workspace' && args[1]==='list') {
  fs.writeFileSync(${JSON.stringify(marker)}, String(process.pid));
  while (!fs.existsSync(${JSON.stringify(release)})) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,20);
}
if (args[0]==='agent' && args[1]==='prompt') fs.appendFileSync(${JSON.stringify(path.join(f.root, 'notices.jsonl'))},JSON.stringify(args)+'\\n');
console.log(JSON.stringify({result:{workspaces:[],agents:[]}}));\n`);
  return { marker, release, org };
}
function alive(pid) {
  try { process.kill(pid, 0); return true; } catch (error) { if (error.code === 'ESRCH') return false; throw error; }
}
async function killCreated(entry) {
  if (!entry) return;
  const result = killProcess({ ...entry, group: false });
  assert.equal(result.ok, true, `identity lookup failed for ${entry.pid}; no signal sent`);
  await until(() => !alive(entry.pid));
}

test('crash during actual saved promoted phase never repeats gate or deletes the lane, even with legacy freshness', async (t) => {
  const f = fixture(t); const wt = f.lane('first'); const blocked = blockCleanup(f);
  const gates = path.join(f.root, 'gates');
  const validate = `${process.execPath} -e 'require("fs").appendFileSync(${JSON.stringify(gates)}, "gate\\n")'`;
  const request = f.launch(['first', '--org', blocked.org, '--validate', validate]);
  let blockedEntry;
  const stop = async () => {
    fs.writeFileSync(blocked.release, 'release');
    await killCreated(f.ownedProcess(request.worker.pid));
    await killCreated(blockedEntry);
    fs.rmSync(path.join(f.queue.directory, 'worker.lock'), { recursive: true, force: true });
  };
  f.onCleanup(stop);
  await until(() => fs.existsSync(blocked.marker));
  blockedEntry = registerProcess(Number(fs.readFileSync(blocked.marker, 'utf8')), false);
  assert.ok(blockedEntry.command.includes(f.herdr), 'birth command belongs to the created cleanup fixture');
  const saved = f.queue.load().current;
  // This is the actual checkpoint written after the real lane CLI fast-forward.
  await killCreated(f.ownedProcess(request.worker.pid));
  await killCreated(blockedEntry);
  fs.rmSync(path.join(f.queue.directory, 'worker.lock'), { recursive: true });
  fs.writeFileSync(blocked.release, 'release');
  assert.equal(saved.phase, 'promoted');
  assert.equal(Object.hasOwn(saved, 'fresh'), false, 'freshness must never be durable');
  assert.equal(f.git(['rev-parse', 'main']), f.git(['rev-parse', 'lane/first']));
  // Also recover a checkpoint produced by the older worker that leaked this flag.
  f.queue.transaction((data) => { data.current.fresh = true; });
  const r = f.cli(['--drain']); assert.equal(r.status, 0, r.stderr);
  assert.equal(f.results()[0].outcome, 'interrupted');
  assert.match(f.messages()[0][3], /previous worker stopped in promoted/);
  assert.equal(fs.readFileSync(gates, 'utf8'), 'gate\n');
  assert.equal(fs.existsSync(wt), true);
  assert.equal(f.git(['rev-parse', 'lane/first']), saved.tip);
  assert.equal(Object.hasOwn(f.results()[0], 'fresh'), false);
  f.onCleanup(async () => {});
});

test('direct gate overlapping queued cleanup prevents queue and direct close from deleting its lane', async (t) => {
  const f = fixture(t); const wt = f.lane('first'); const blocked = blockCleanup(f);
  const request = f.launch(['first', '--org', blocked.org]);
  const ready = path.join(f.root, 'direct-gate-pid'); const release = path.join(f.root, 'direct-gate-release');
  const script = path.join(f.root, 'direct-gate.mjs');
  fs.writeFileSync(script, `import fs from 'node:fs'; fs.writeFileSync(${JSON.stringify(ready)},String(process.pid));
while(!fs.existsSync(${JSON.stringify(release)})) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,20);\n`);
  let direct, blockedEntry, gateEntry;
  f.onCleanup(async () => {
    fs.writeFileSync(blocked.release, 'release'); fs.writeFileSync(release, 'release');
    await killCreated(f.ownedProcess(request.worker.pid));
    await killCreated(childProcessEntry(direct));
    for (const entry of [blockedEntry, gateEntry]) await killCreated(entry);
    fs.rmSync(path.join(f.queue.directory, 'worker.lock'), { recursive: true, force: true });
  });
  await until(() => fs.existsSync(blocked.marker));
  blockedEntry = registerProcess(Number(fs.readFileSync(blocked.marker, 'utf8')), false);
  assert.ok(blockedEntry.command.includes(f.herdr));
  const tip = f.git(['rev-parse', 'lane/first']);
  direct = spawnChild(t, process.execPath, [LANE, 'promote', 'first'], { cwd: f.repo,
    env: { ...f.env, LANE_VALIDATE: `${process.execPath} ${script}` }, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = ''; direct.stdout.on('data', (v) => { output += v; }); direct.stderr.on('data', (v) => { output += v; });
  const exited = waitForExit(direct);
  await until(() => fs.existsSync(ready));
  gateEntry = registerProcess(Number(fs.readFileSync(ready, 'utf8')), false);
  assert.ok(gateEntry.command.includes(script));
  fs.writeFileSync(blocked.release, 'release');
  await until(() => f.results().length === 1);
  assert.equal(direct.exitCode, null, 'the direct gate is still in progress');
  assert.equal(f.results()[0].outcome, 'promoted'); assert.equal(f.results()[0].delivered, true);
  assert.match(f.results()[0].reason, /lane close:.*lane-promote.lock/);
  assert.match(f.messages()[0][3], /lane close:.*lane-promote.lock/);
  assert.ok(fs.existsSync(wt)); assert.equal(f.git(['rev-parse', 'lane/first']), tip);
  // All close callers must respect a live gate, even outside queue orchestration.
  const close = spawnSync(process.execPath, [LANE, 'close', 'first', '--git-only'], { cwd: f.repo, env: f.env, encoding: 'utf8' });
  assert.notEqual(close.status, 0); assert.match(close.stderr, /lane-promote.lock/);
  fs.writeFileSync(release, 'release'); assert.equal((await exited).code, 0, output);
  await until(() => !fs.existsSync(path.join(f.queue.directory, 'worker.lock')));
  f.onCleanup(async () => {});
});

test('conditional close rechecks the promoted tip and base before any removal', (t) => {
  const f = fixture(t); const wt = f.lane('first'); const original = f.git(['rev-parse', 'lane/first']);
  f.git(['merge', '--ff-only', 'lane/first']);
  fs.writeFileSync(path.join(wt, 'first.txt'), 'new work'); f.git(['add', '.'], wt); f.git(['commit', '-qm', 'new lane work'], wt);
  const close = (tip) => spawnSync(process.execPath, [LANE, 'close', 'first', '--git-only', '--expected-tip', tip], { cwd: f.repo, env: f.env, encoding: 'utf8' });
  const changed = close(original); assert.notEqual(changed.status, 0); assert.match(changed.stderr, /tip changed/);
  assert.ok(fs.existsSync(wt));
  const unmerged = close(f.git(['rev-parse', 'lane/first']));
  assert.notEqual(unmerged.status, 0); assert.match(unmerged.stderr, /not contained/);
  assert.ok(fs.existsSync(wt)); assert.equal(f.git(['tag', '--list', 'archive/lane/first']), '');
  f.git(['merge', '--ff-only', 'lane/first']);
  const safe = close(f.git(['rev-parse', 'lane/first'])); assert.equal(safe.status, 0, safe.stderr);
  assert.equal(fs.existsSync(wt), false);
});
