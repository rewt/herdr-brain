#!/usr/bin/env node
// Explicit local release gate; deliberately outside npm test.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { discovery } from './live.mjs';
import { auditCopies, relocate, within, copiedSandbox, workspaceIdentityCutover } from './security.mjs';
import { HarnessLimit, Pending, commandFailure, classifyFailure } from './limits.mjs';
import { installSignalCleanup, removeCredentials } from './signal-cleanup.mjs';
import { safeGitArgs } from './verify.mjs';
import { retainedRoots, resultLine } from './results.mjs';
import { liveSocket } from './probe.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SOURCE = path.dirname(HERE);
const { values: opt } = parseArgs({ options: {
  candidate: { type: 'string' }, source: { type: 'string', default: SOURCE },
  'bch-cloak': { type: 'string' }, keep: { type: 'boolean', default: false },
  'npm-cache': { type: 'string' },
  'skip-live': { type: 'boolean', default: false },
  'discovery-model': { type: 'string', default: 'gpt-5.6-luna' },
  'discovery-effort': { type: 'string', default: 'low' },
} });
if (!opt.candidate) { console.error('usage: node acceptance/run.mjs --candidate TAG|REF|DIRECTORY [--source REPO] [--bch-cloak LIVE_REPO] [--keep]'); process.exit(2); }
const root = fs.realpathSync(fs.mkdtempSync(path.join(process.env.ACCEPTANCE_TMPDIR ?? '/tmp', 'herdr-acceptance-')));
const evidence = path.join(root, 'evidence');
fs.mkdirSync(evidence);
const started = Date.now();
const results = [];
let logFile, candidateCommit, fixture, supervisor;
const pids = new Set();
const discoveryRoots = [];
const env = { ...process.env };
for (const key of Object.keys(env)) if (/^(ORG_|LANE_|HERDR_|RELEASE_|ACCEPTANCE_|MONITOR_)/.test(key)) delete env[key];
Object.assign(env, { ACCEPTANCE_ROOT: root, TMPDIR: root, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
  npm_config_cache: path.join(root, 'npm-cache'), npm_config_update_notifier: 'false' });
const write = (file, value) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, value); };
const read = (file) => fs.readFileSync(file, 'utf8');
const json = (text) => { const v = JSON.parse(text); return v.result ?? v; };
const quote = (s) => "'" + s.replaceAll("'", "'\\''") + "'";
const pending = (reason) => { throw new Pending(reason); };
function run(command, args, { cwd = root, extra = {}, ok = true, timeout = 60_000, input, binary = false, isolatedEnv } = {}) {
  const r = spawnSync(command, args, { cwd, env: isolatedEnv ?? { ...env, ...extra }, encoding: binary ? undefined : 'utf8',
    input, maxBuffer: 32 * 1024 * 1024, timeout });
  if (logFile) fs.appendFileSync(logFile, JSON.stringify({ command, args, cwd, status: r.status, error: r.error?.message,
    stdout: binary ? '(archive)' : r.stdout, stderr: String(r.stderr ?? '') }) + '\n');
  if (ok && (r.error || r.status !== 0)) {
    const message = `${path.basename(command)} ${args[0]}: ${r.error?.message ?? String(r.stderr || r.stdout).trim()}`;
    throw commandFailure(message);
  }
  return r;
}
const scratchHome = path.join(root, 'copy-home'); fs.mkdirSync(scratchHome);
const copiedPolicy = path.join(root, 'copied.sb');
// Independent kernel write boundary: copied code cannot escape through a
// dynamically computed record path even if a textual audit misses its spelling.
write(copiedPolicy, copiedSandbox(root, [fs.realpathSync(path.join(path.dirname(process.execPath), '..'))]));
let liveCopyReady = false, copy, live;
function runCopy(command, args, options = {}) {
  if (!liveCopyReady) throw new Error('copied scripts were not successfully relocated/audited');
  auditCopies(copy, { live, home: process.env.HOME });
  const org = options.extra?.ORG_DIR;
  if (!org || !fs.existsSync(org) || !within(root, org)) throw new Error('copied invocation requires an explicit scratch ORG_DIR');
  // Allow the installed native Herdr executable only as a tool for the scoped
  // adapter. Live project code, activated releases and records stay unreadable.
  const native = JSON.parse(read(path.join(root, 'ownership.json'))).binary;
  const toolPolicy = read(copiedPolicy) + [native, fs.realpathSync(native)].map((file) => `(allow file-read* (literal ${JSON.stringify(file)}))\n`).join('');
  write(copiedPolicy, toolPolicy);
  return run('/usr/bin/sandbox-exec', ['-f', copiedPolicy, command, ...args],
    { ...options, extra: { ...options.extra, HOME: scratchHome, TMPPREFIX: path.join(root, 'zsh'), ACCEPTANCE_PINNED_ORG: org } });
}
const node = (file, args, options) => run(process.execPath, [file, ...args], options);
const git = (cwd, args) => run('git', safeGitArgs(cwd, args)).stdout.trim();
const candidate = path.join(root, 'candidate');
const present = (file) => fs.existsSync(path.join(candidate, file));
const requireCandidate = (file) => { if (!present(file)) pending(`candidate lacks ${file}`); return path.join(candidate, file); };
async function test(name, fn) {
  const id = String(results.length + 1).padStart(2, '0');
  logFile = path.join(evidence, `${id}.jsonl`);
  write(logFile, '');
  let status = 'PASS', detail = '', origin = 'product';
  try { detail = await fn() ?? ''; }
  catch (e) { ({ status, origin, detail } = classifyFailure(e, { cleanup: name === 'Cleanup and scope audit' })); }
  results.push({ id, name, status, origin, detail, evidence: `${id}.jsonl` });
  logFile = undefined;
}
async function until(fn, label, ms = 25_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (fn()) return; await new Promise((r) => setTimeout(r, 150)); }
  throw new Error(`timeout: ${label}`);
}
const h = (...args) => json(node(path.join(root, 'herdr.mjs'), args).stdout);
const record = (args, options = {}) => node(path.join(candidate, 'bin/org.mjs'), args, { cwd: fixture.repo, extra: { ORG_DIR: fixture.org }, ...options }).stdout;
const lane = (args, cwd = fixture.repo, options = {}) => node(path.join(candidate, 'lanes/lane.mjs'), args, { cwd, ...options }).stdout;
const inbox = () => fs.existsSync(path.join(root, 'supervisor-input.jsonl')) ? read(path.join(root, 'supervisor-input.jsonl')) : '';
function initRepo(repo) {
  fs.mkdirSync(repo, { recursive: true });
  git(repo, ['init', '-q', '-b', 'main']);
  git(repo, ['config', 'user.name', 'Release acceptance']);
  git(repo, ['config', 'user.email', 'acceptance@example.invalid']);
  write(path.join(repo, 'README.md'), 'A new project.\n');
  git(repo, ['add', '.']); git(repo, ['commit', '-qm', 'Create scratch project']);
}
function auditSnapshot(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) {
      const target = fs.realpathSync(file);
      const offset = path.relative(candidate, target);
      assert.ok(offset !== '..' && !offset.startsWith(`..${path.sep}`) && !path.isAbsolute(offset), `candidate symlink escapes snapshot: ${file}`);
    } else if (entry.isDirectory()) auditSnapshot(file);
  }
}
async function dispatch(mode, topic, { reuse, item } = {}) {
  if (!fixture || !supervisor) pending('configured fixture unavailable');
  requireCandidate('dispatch/dispatch.mjs');
  write(path.join(root, 'mode'), mode);
  if (!item) item = record(['add', `Acceptance ${topic}`, '--role', 'engineer']).match(/^(\S+)/)[1];
  const args = [item, '--repo', fixture.repo, '--org', fixture.org, '--lane', topic, '--route', 'scripted',
    '--brief', fixture.brief, '--report', path.join(fixture.org, `${topic}-${Date.now()}.md`), '--to', supervisor.name];
  if (reuse) args.push('--reuse', reuse);
  const job = json(node(path.join(candidate, 'dispatch/dispatch.mjs'), args, { cwd: fixture.repo, timeout: 90_000 }).stdout);
  pids.add(job.watcher.pid);
  return { ...job, info: json(record(['show', job.run, '--json'])) };
}
async function final(job, { ingest = true } = {}) {
  await until(() => inbox().includes(`[org-report] run=${job.run} `), `supervisor received ${job.run}`, 30_000);
  const notices = read(path.join(root, 'supervisor-input.jsonl')).split('\n').filter(Boolean).map(JSON.parse)
    .filter((v) => v.line.includes(`[org-report] run=${job.run} `));
  assert.equal(notices.length, 1, 'exactly one final delivery');
  assert.match(notices[0].line, /headline=.+check=pass.*report=/);
  assert.ok(!notices[0].line.includes('verdict='));
  record(['check', job.info.report_path]);
  if (ingest) {
    record(['ingest', job.info.report_path, '--run', job.run]);
    assert.ok(json(record(['show', job.run, '--json'])).report);
  }
}
async function stopWatcher(job) {
  record(['abandon', job.run, '--note', 'Acceptance failure path complete']);
  // A waiting watcher wakes on the real reported state transition.
  h('pane', 'report-agent', job.pane, '--source', 'acceptance-script', '--agent', 'codex', '--state', 'working', '--seq', '100');
  await new Promise((r) => setTimeout(r, 300));
  h('pane', 'report-agent', job.pane, '--source', 'acceptance-script', '--agent', 'codex', '--state', 'idle', '--seq', '101');
  await until(() => read(job.watcher.log).includes('was abandoned; stopping'), 'abandoned watcher stops');
  lane(['close', job.lane]);
}

async function cleanupScope() {
  const errors = [];
  try {
    // PIDs originate only in successful candidate detach receipts or in this
    // scratch record’s dispatch journals (including partially failed dispatch).
    if (fixture && fs.existsSync(path.join(fixture.org, 'dispatch'))) {
      for (const file of fs.readdirSync(path.join(fixture.org, 'dispatch'))) {
        if (!file.endsWith('.json') || file.endsWith('.routes.json')) continue;
        const job = JSON.parse(read(path.join(fixture.org, 'dispatch', file)));
        if (job.watcher?.pid) pids.add(job.watcher.pid);
      }
    }
    for (const pid of pids) { try { process.kill(pid, 'SIGTERM'); } catch (e) { if (e.code !== 'ESRCH') errors.push(e.message); } }
    if (fs.existsSync(path.join(root, 'ownership.json'))) {
      const owned = JSON.parse(read(path.join(root, 'ownership.json')));
      for (const id of [...new Set(owned.workspaces)].reverse()) {
        try {
          const r = node(path.join(root, 'herdr.mjs'), ['workspace', 'get', id], { ok: false });
          if (r.status === 0) h('workspace', 'close', id);
        } catch (error) { errors.push(`workspace ${id}: ${error.message}`); }
      }
      const remaining = h('workspace', 'list').workspaces;
      write(path.join(evidence, 'ownership.json'), JSON.stringify(owned, null, 2));
      write(path.join(evidence, 'cleanup-residue.json'), JSON.stringify({ workspaces: remaining, errors }, null, 2));
      for (const file of ['herdr.jsonl', 'denied.jsonl', 'supervisor-input.jsonl', 'worker-input.jsonl']) {
        if (fs.existsSync(path.join(root, file))) fs.copyFileSync(path.join(root, file), path.join(evidence, file));
      }
      if (remaining.length) errors.push(`${remaining.length} owned workspace(s) left`);
    }
    // Authentication copies are never evidence, even with --keep or a failed
    // session. Remove them after the owned panes/processes have stopped.
    removeCredentials(root);
    if (errors.length) throw new HarnessLimit(`cleanup failed: ${errors.join('; ')}`);
    if (!opt.keep) for (const directory of discoveryRoots) fs.rmSync(directory, { recursive: true, force: true });
    // Preserve only evidence unless requested. chmod is limited to this mkdtemp.
    if (!opt.keep) {
      run('chmod', ['-R', 'u+w', root]);
      for (const entry of fs.readdirSync(root)) if (entry !== 'evidence') fs.rmSync(path.join(root, entry), { recursive: true, force: true });
    }
    return opt.keep ? `scratch retained: ${root}; all created workspaces closed` : 'all created workspaces closed; only evidence retained';
  } finally { removeCredentials(root); }
}

function emitSummary(interruption = {}) {
  const elapsedSeconds = Math.round((Date.now() - started) / 1000);
  const counts = Object.fromEntries(['PASS', 'FAIL', 'PENDING'].map((status) => [status, results.filter((v) => v.status === status).length]));
  const authDirectory = path.join(root, 'codex-runtime');
  const summary = { candidate: opt.candidate, candidateCommit, elapsedSeconds, counts, evidence, results,
    credentialResidue: fs.existsSync(authDirectory) ? [authDirectory] : [], retainedDiscoveryRoots: retainedRoots(discoveryRoots), ...interruption };
  write(path.join(evidence, 'summary.json'), JSON.stringify(summary, null, 2) + '\n');
  const screen = [`Release acceptance: ${opt.candidate} (${elapsedSeconds}s) — ${counts.PASS} pass / ${counts.FAIL} fail / ${counts.PENDING} pending — ${counts.FAIL || counts.PENDING ? 'NOT READY' : 'READY'}`,
    ...results.map((v) => resultLine(v, summary.retainedDiscoveryRoots)), `Evidence: ${evidence} (NN.jsonl; summary.json has reasons)`].join('\n');
  write(path.join(evidence, 'screen.txt'), screen + '\n'); console.log(screen);
  process.exitCode = counts.FAIL || counts.PENDING ? 1 : 0;
}

installSignalCleanup({ root, cleanup: cleanupScope, summarize: (interruption) => {
  results.push({ id: 'interrupt', name: 'Interrupted run', status: 'PENDING', origin: 'harness', detail: interruption.signal, evidence: 'summary.json' });
  emitSummary(interruption);
} });

try {
  const missing = ['node', 'git', 'bash', 'zsh', 'rg', 'python3', 'tar', 'npm', 'chmod', 'sandbox-exec', 'herdr',
    ...(opt['skip-live'] ? [] : ['codex'])].filter((tool) => run('which', [tool], { ok: false }).status !== 0);
  if (missing.length) {
    await test('Required tools', () => { throw new HarnessLimit(`missing prerequisite: ${missing.join(', ')}`); });
    throw new Pending('prerequisites unavailable; no candidate or copied code executed');
  }
  await test('Candidate snapshot', () => {
    fs.mkdirSync(candidate);
    if (fs.existsSync(opt.candidate) && fs.statSync(opt.candidate).isDirectory()) {
      const sourceDir = fs.realpathSync(opt.candidate);
      fs.cpSync(sourceDir, candidate, { recursive: true, dereference: true, filter: (p) => !['.git', 'node_modules', '.org', '.lane'].includes(path.basename(p)) });
      candidateCommit = fs.existsSync(path.join(sourceDir, '.release-commit')) ? read(path.join(sourceDir, '.release-commit')).trim() : 'directory snapshot';
    } else {
      candidateCommit = git(opt.source, ['rev-parse', '--verify', `${opt.candidate}^{commit}`]);
      const archive = run('git', ['-C', opt.source, 'archive', candidateCommit], { binary: true }).stdout;
      run('tar', ['-x', '-C', candidate], { input: archive });
    }
    auditSnapshot(candidate);
    assert.ok(present('bin/org.mjs')); return `${opt.candidate}: ${candidateCommit}`;
  });
  if (results[0].status !== 'PASS') throw new Error('unsafe or unavailable candidate snapshot; no candidate commands executed');
  const fresh = path.join(root, 'new-project');
  initRepo(fresh);
  await test('New project: record discovers and populates', () => {
    assert.ok(!fs.existsSync(path.join(fresh, '.org')));
    const status = node(path.join(candidate, 'bin/org.mjs'), ['status', '--json'], { cwd: fresh, ok: false });
    const add = node(path.join(candidate, 'bin/org.mjs'), ['add', 'Work discovered by entering agent'], { cwd: fresh, ok: false });
    assert.equal(status.status, 0, `record status requires setup: ${status.stderr.trim()}`);
    assert.equal(add.status, 0, `record add requires setup: ${add.stderr.trim()}`);
    assert.ok(fs.existsSync(path.join(fresh, '.org/events.jsonl')), 'record must populate in the new project');
  });
  await test('New project: routes resolve without config', () => {
    requireCandidate('lanes/routes.mjs');
    const probe = path.join(root, 'routes-probe.mjs');
    write(probe, `import {loadDiscoveredRoutes,resolveLaunchRoute} from ${JSON.stringify(path.join(candidate, 'lanes/routes.mjs'))};\nconsole.log(JSON.stringify(resolveLaunchRoute(loadDiscoveredRoutes().config)));\n`);
    node(probe, [], { cwd: fresh });
  });
  await test('New project: installed supervisor entry and record bootstrap', () => {
    requireCandidate('dispatch/dispatch.mjs'); requireCandidate('watch/watch.mjs');
    const bootstrap = path.join(root, 'entry-project'); initRepo(bootstrap);
    for (const name of ['.org', '.lane.json', 'AGENTS.md']) assert.ok(!fs.existsSync(path.join(bootstrap, name)), 'entry bootstrap must start from a separate untouched project');
    if (present('discovery/install.mjs') && present('discovery/adapters/codex.mjs')) {
      const binary = fs.realpathSync(run('which', ['codex'], { extra: { PATH: process.env.PATH } }).stdout.trim());
      const policy = node(path.join(candidate, 'discovery/adapters/codex.mjs'), ['--repo', bootstrap, '--binary', binary, '--role', 'supervisor', '--policy-only'], { cwd: bootstrap }).stdout;
      write(path.join(evidence, 'new-project-discovery.txt'), policy);
      assert.match(policy, /dispatch.*ITEM/); assert.match(policy, /watch\/watch.mjs/); assert.match(policy, /Only a supervisor/);
      assert.ok(fs.existsSync(path.join(bootstrap, '.org/events.jsonl')), 'product entry must bootstrap its own project record');
      return 'actual supervisor entry executed in an untouched project and bootstrapped the record; this does not execute a dispatch/watch cycle';
    }
    assert.fail('candidate has no installed supervisor entry to execute and bootstrap an unconfigured project');
  });
  await test('Real Herdr boundary and configured fixture', async () => {
    if (process.env.HERDR_ENV !== '1') throw new HarnessLimit('run inside Herdr (HERDR_ENV=1); no session inspected');
    const binary = run('which', ['herdr']).stdout.trim();
    write(path.join(root, 'ownership.json'), JSON.stringify({ binary, socketPath: liveSocket(process.env), workspaces: [], tabs: [], panes: [] }));
    for (const file of ['herdr.mjs', 'worker.mjs']) fs.copyFileSync(path.join(HERE, file), path.join(root, file));
    const bin = path.join(root, 'bin'); fs.mkdirSync(bin);
    write(path.join(bin, 'herdr'), `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(path.join(root, 'herdr.mjs'))} "$@"\n`); fs.chmodSync(path.join(bin, 'herdr'), 0o755);
    for (const name of ['codex', 'claude', 'ai', 'cmem-domain', 'launchctl']) {
      write(path.join(bin, name), '#!/bin/sh\necho "acceptance: forbidden external executable" >&2\nexit 97\n'); fs.chmodSync(path.join(bin, name), 0o755);
    }
    fs.copyFileSync(path.join(HERE, 'record-shim.mjs'), path.join(root, 'record-shim.mjs'));
    for (const name of ['org', 'record']) {
      write(path.join(bin, name), `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(path.join(root, 'record-shim.mjs'))} "$@"\n`);
      fs.chmodSync(path.join(bin, name), 0o755);
    }
    fs.symlinkSync(path.join(candidate, 'lanes/lane.mjs'), path.join(bin, 'lane'));
    env.PATH = `${bin}:${process.env.PATH}`;
    fixture = { repo: path.join(root, 'configured-project'), org: path.join(root, 'record'), brief: path.join(root, 'ask.md') };
    initRepo(fixture.repo);
    write(fixture.brief, 'Commit a scratch work file and write the supplied report. No model.\n');
    write(path.join(fixture.repo, '.lane.json'), JSON.stringify({ main: 'main', validate: 'node --test',
      worktree_root: path.join(root, 'worktrees'), routes: { scripted: { kind: 'codex', model: 'scripted-no-model', effort: 'low' } } }));
    write(path.join(fixture.repo, '.gitignore'), '.lane/\n');
    write(path.join(fixture.repo, 'test/scratch.test.mjs'), "import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';test('committed work is present',()=>{assert.ok(fs.readdirSync('.').some(f=>f.startsWith('work-R-')));});\n");
    git(fixture.repo, ['add', '.']); git(fixture.repo, ['commit', '-qm', 'Configure explicit acceptance fixture']);
    record(['init', fixture.org]);
    const ws = h('workspace', 'create', '--cwd', fixture.repo, '--label', 'acceptance-project', '--no-focus');
    await until(() => h('pane', 'get', ws.root_pane.pane_id).pane.foreground_cwd === fixture.repo, 'scratch shell cwd');
    const tab = h('tab', 'create', '--workspace', ws.workspace.workspace_id, '--cwd', fixture.repo, '--label', 'acceptance-supervisor', '--no-focus');
    await until(() => h('pane', 'get', tab.root_pane.pane_id).pane.foreground_cwd === fixture.repo, 'supervisor shell cwd');
    supervisor = { name: `accept-${process.pid}`, pane: tab.root_pane.pane_id, workspace: ws.workspace.workspace_id };
    h('pane', 'run', supervisor.pane, [process.execPath, path.join(root, 'worker.mjs'), root, 'supervisor', supervisor.name].map(quote).join(' '));
    await until(() => {
      const r = node(path.join(root, 'herdr.mjs'), ['agent', 'get', supervisor.pane], { ok: false });
      return r.status === 0 && json(r.stdout).agent?.agent_status === 'idle';
    }, 'supervisor stand-in ready');
    h('agent', 'rename', supervisor.pane, supervisor.name);
    for (const args of [['pane', 'run', 'unowned:p1', 'echo bad'], ['workspace', 'close', 'unowned'], ['agent', 'prompt', 'unowned-agent', 'bad'],
      ['workspace', 'create', '--cwd', '/'], ['server', 'stop']]) {
      const r = node(path.join(root, 'herdr.mjs'), args, { ok: false }); assert.notEqual(r.status, 0, 'boundary must deny');
    }
    return 'PTY workers use explicit report-agent states; all targets constrained to creation receipts and scratch cwd';
  });
  await test('Configured cycle: dispatch/report/ingest/promote/close', async () => {
    const job = await dispatch('done', 'happy-path');
    await final(job);
    lane(['check'], job.info.workspace);
    // Promotion must refuse a dirty tree and a red gate without moving main.
    const before = git(fixture.repo, ['rev-parse', 'main']);
    write(path.join(job.info.workspace, 'dirty'), 'uncommitted');
    assert.notEqual(node(path.join(candidate, 'lanes/lane.mjs'), ['promote', job.lane], { cwd: fixture.repo, ok: false }).status, 0);
    fs.unlinkSync(path.join(job.info.workspace, 'dirty'));
    assert.notEqual(node(path.join(candidate, 'lanes/lane.mjs'), ['promote', job.lane], { cwd: fixture.repo, extra: { LANE_VALIDATE: 'false' }, ok: false }).status, 0);
    assert.equal(git(fixture.repo, ['rev-parse', 'main']), before);
    lane(['promote', job.lane]);
    assert.equal(git(fixture.repo, ['rev-parse', 'main']), git(job.info.workspace, ['rev-parse', 'HEAD']));
    assert.equal(git(fixture.repo, ['rev-list', '--merges', 'main']), '');
    lane(['close', job.lane]);
    assert.ok(!fs.existsSync(job.info.workspace));
    return `${job.run}: one notice, recorded report, green fast-forward, lane removed; red/dirty gates refused`;
  });
  for (const [mode, prefix] of [['missing', 'watch-no-report'], ['invalid', 'watch-invalid-report'], ['blocked', 'watch-blocked']]) {
    await test(`Failure path: ${mode} worker`, async () => {
      const job = await dispatch(mode, `failure-${mode}`);
      await until(() => inbox().includes(`[${prefix}] run=${job.run} `), `${prefix} delivered`, 30_000);
      assert.ok(!inbox().includes(`[org-report] run=${job.run} `));
      process.kill(job.watcher.pid, 0);
      assert.equal(json(record(['show', job.run, '--json'])).report, null);
      await stopWatcher(job);
      return `${job.run}: matching intermediate notice, watcher alive, no ingestion; abandoned and closed`;
    });
  }
  await test('Fix round: same worker, fresh durable run', async () => {
    const first = await dispatch('blocked-report', 'fix-round');
    await final(first);
    await until(() => ['idle', 'done'].includes(h('agent', 'get', first.agent).agent.agent_status), 'worker idle');
    const second = await dispatch('done', first.lane, { item: first.item, reuse: first.run });
    assert.equal(first.agent, second.agent); assert.equal(first.pane, second.pane); assert.notEqual(first.run, second.run);
    await final(second); lane(['check'], second.info.workspace); lane(['promote', second.lane]); lane(['close', second.lane]);
    return `${first.run} -> ${second.run}: blocked report then done, same PTY, distinct run/report`;
  });
  await test('Watch cutover: idle grace and exclusive watcher', async () => {
    requireCandidate('watch/watch.mjs');
    const job = await dispatch('missing', 'idle-grace');
    await until(() => inbox().includes(`[watch-no-report] run=${job.run} `), 'initial stop notice');
    // Stop the exact saved watcher, then arm the candidate with the actual 900s setting.
    process.kill(job.watcher.pid, 'SIGTERM');
    await until(() => { try { process.kill(job.watcher.pid, 0); return false; } catch { return true; } }, 'old watcher exits');
    // The replacement must observe a fresh working -> stopped transition; an
    // already stopped worker is not eligible for transient-idle grace.
    h('agent', 'prompt', job.agent, `You are run ${job.run}. Write the report to ${job.info.report_path};`);
    const log = path.join(evidence, 'grace-watch.log');
    const args = [job.run, '--org', fixture.org, '--to', supervisor.name, '--idle-grace', '900', '--start-grace', '0', '--detach', '--cwd', fixture.repo, '--log', log];
    const watcher = json(node(path.join(candidate, 'watch/watch.mjs'), args).stdout); pids.add(watcher.pid); job.watcher = watcher;
    const duplicate = node(path.join(candidate, 'watch/watch.mjs'), args, { ok: false }); assert.notEqual(duplicate.status, 0);
    await until(() => read(log).includes('waiting up to 900s'), '900-second grace armed');
    await new Promise((r) => setTimeout(r, 1000));
    assert.ok(!read(log).includes('[watch-no-report]'), 'no early no-report notice');
    write(path.join(root, 'mode'), 'done');
    h('agent', 'prompt', job.agent, `You are run ${job.run}. Write the report to ${job.info.report_path};`);
    await final(job); assert.match(read(log), /\[org-report\]/); lane(['promote', job.lane]); lane(['close', job.lane]);
    return '900-second configuration stayed quiet for observed interval, resume/report woke it, duplicate refused (full 900s expiry not tested)';
  });
  await test('Housekeeping closes only eligible finished workers', async () => {
    const script = requireCandidate('housekeeping/housekeeping.mjs');
    const jobs = [];
    try {
      const done = await dispatch('done', 'housekeeping-done'); jobs.push(done);
      await final(done); lane(['check'], done.info.workspace); lane(['promote', done.lane]);
      const blocked = await dispatch('blocked-report', 'housekeeping-blocked'); jobs.push(blocked);
      await final(blocked);
      const human = await dispatch('needs-human', 'housekeeping-human'); jobs.push(human);
      await final(human);
      const state = path.join(root, 'housekeeping-state');
      let failure;
      try {
        node(script, ['--once', '--cwd', fixture.repo, '--org', fixture.org, '--state-dir', state],
          { cwd: fixture.repo, extra: { HERDR_PANE_ID: '', HERDR_TAB_ID: '', HERDR_WORKSPACE_ID: '' }, timeout: 60_000 });
      } catch (error) { failure = error; }
      if (fs.existsSync(path.join(state, 'actions.jsonl'))) fs.copyFileSync(path.join(state, 'actions.jsonl'), path.join(evidence, 'housekeeping-actions.jsonl'));
      for (const job of [blocked, human]) assert.equal(node(path.join(root, 'herdr.mjs'), ['pane', 'get', job.pane], { ok: false }).status, 0,
        'blocked and needs-human workers must remain');
      if (failure) throw failure;
      const close = node(path.join(root, 'herdr.mjs'), ['pane', 'get', done.pane], { ok: false });
      assert.notEqual(close.status, 0, 'one real housekeeping pass left the promoted, ingested done worker open; inspect canonical workspace metadata and action log');
      assert.match(read(path.join(state, 'actions.jsonl')), /"action":"closed"/);
      return 'actual released one-pass entrypoint closed promoted done worker; blocked/needs-human panes preserved';
    } finally {
      for (const job of jobs) lane(['close', job.lane]);
    }
  });
  await test('Scratch release build/activate/rollback/restore', () => {
    const script = requireCandidate('herdr/release.sh');
    const repo = path.join(root, 'release-source'); fs.cpSync(candidate, repo, { recursive: true });
    git(repo, ['init', '-q', '-b', 'main']); git(repo, ['config', 'user.email', 'acceptance@example.invalid']); git(repo, ['config', 'user.name', 'Acceptance']);
    git(repo, ['add', '-A']); git(repo, ['commit', '-qm', 'Candidate snapshot']); git(repo, ['tag', 'candidate']);
    write(path.join(repo, 'acceptance-release-marker'), 'rollback fixture'); git(repo, ['add', '-A']); git(repo, ['commit', '-qm', 'Second scratch release']); git(repo, ['tag', 'second']);
    const home = path.join(root, 'monitor-home'), bin = path.join(root, 'release-bin'); fs.mkdirSync(bin);
    fs.symlinkSync(path.join(candidate, 'bin/org.mjs'), path.join(bin, 'org'));
    fs.symlinkSync(path.join(candidate, 'lanes/lane.mjs'), path.join(bin, 'lane'));
    write(path.join(home, 'before/org'), path.join(candidate, 'bin/org.mjs') + '\n');
    write(path.join(home, 'before/lane'), path.join(candidate, 'lanes/lane.mjs') + '\n');
    const extra = { HERDR_MONITOR_REPO: repo, HERDR_MONITOR_HOME: home, HERDR_MONITOR_BIN: bin, HERDR_MONITOR_PLIST: path.join(root, 'absent.plist'),
      RELEASE_NO_HERDR: '1', RELEASE_NO_LAUNCHD: '1', RELEASE_NO_NPM: '1' };
    const release = (...a) => run('bash', [script, ...a], { extra });
    release('build', 'candidate'); release('build', 'second'); release('activate', 'candidate');
    assert.ok(fs.existsSync(path.join(home, 'before/record.missing')), 'record introduced after first activation must be remembered');
    node(path.join(bin, 'record'), ['--help']); node(path.join(bin, 'org'), ['--help']);
    release('activate', 'second'); release('activate', 'second'); release('rollback');
    assert.equal(fs.readlinkSync(path.join(home, 'current')), path.join(home, 'releases/candidate'));
    release('restore'); assert.ok(!fs.existsSync(path.join(bin, 'record')));
    assert.equal(fs.readlinkSync(path.join(bin, 'org')), path.join(candidate, 'bin/org.mjs'));
    return 'candidate code archived into immutable scratch releases; old-install launcher migration checked; npm/plugin/launchd excluded';
  });
  await test('Full console dependency build (offline)', () => {
    requireCandidate('console/package-lock.json');
    if (!opt['npm-cache']) pending('supply --npm-cache DIRECTORY to copy an existing cache into scratch for npm ci --offline');
    const cache = path.resolve(opt['npm-cache']);
    const store = path.join(cache, '_cacache');
    const scratchStore = path.join(root, 'npm-cache/_cacache');
    // Copy cache indexes and only lockfile tarballs, never write the source
    // cache or copy gigabytes of unrelated dependency content.
    fs.cpSync(path.join(store, 'index-v5'), path.join(scratchStore, 'index-v5'), { recursive: true });
    const lockfile = JSON.parse(read(path.join(candidate, 'console/package-lock.json')));
    for (const pkg of Object.values(lockfile.packages ?? {})) {
      if (!pkg.integrity?.startsWith('sha512-')) continue;
      const digest = Buffer.from(pkg.integrity.slice(7), 'base64').toString('hex');
      const rel = path.join('content-v2/sha512', digest.slice(0, 2), digest.slice(2, 4), digest.slice(4));
      const src = path.join(store, rel);
      if (fs.existsSync(src)) write(path.join(scratchStore, rel), fs.readFileSync(src));
    }
    run('npm', ['--prefix', path.join(candidate, 'console'), 'ci', '--offline', '--no-audit', '--no-fund'], { ok: true, timeout: 60_000 });
  });
  // Existing-project compatibility and proposed switches are one section of the
  // gate. Every file comes from a fresh read-only copy, never the inventory kit.
  live = opt['bch-cloak'] ? path.resolve(opt['bch-cloak']) : undefined;
  copy = path.join(root, 'existing/bch-cloak');
  const tracked = ['.claude/skills/lane/SKILL.md', 'scripts/lane/launch-supervisor.mjs', 'scripts/lane/routing.mjs', 'scripts/lane/routing.json', 'scripts/lane/routing.test.mjs', 'scripts/lane/lane.mjs',
    ...['continue.sh', 'arm-watch.sh', 'dispatch.sh', 'notify-watch.sh', 'SETTLE.md', 'WORK-PATTERN.md', 'session-start.sh', 'tidy-tabs.sh', 'apply-settle.sh', 'close-finished-agents.sh'].map((v) => `.lane/supervisor/${v}`)];
  const backup = path.join(root, 'backup');
  const inventory = [];
  await test('Existing project: copy live calls and inventory drift', () => {
    if (!live) pending('pass --bch-cloak LIVE_REPO to check the existing installation');
    for (const rel of tracked) {
      const src = path.join(live, rel); const st = fs.lstatSync(src); assert.ok(st.isFile(), 'copy regular script files only');
      const bytes = fs.readFileSync(src);
      const sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
      inventory.push({ file: rel, sha256, mode: st.mode & 0o777 });
      write(path.join(copy, rel), bytes); fs.chmodSync(path.join(copy, rel), st.mode & 0o777);
      write(path.join(backup, rel), bytes); fs.chmodSync(path.join(backup, rel), st.mode & 0o777);
    }
    write(path.join(evidence, 'live-copy-manifest.json'), JSON.stringify(inventory, null, 2));
    // Read other scripts only into scratch, then scan the copy for omitted calls.
    for (const dir of ['scripts/lane', '.lane/supervisor']) {
      for (const entry of fs.readdirSync(path.join(live, dir), { withFileTypes: true })) {
        if (!entry.isFile() || !/\.(mjs|sh|py)$/.test(entry.name)) continue;
        const rel = path.join(dir, entry.name); if (tracked.includes(rel)) continue;
        write(path.join(copy, rel), fs.readFileSync(path.join(live, rel)));
      }
    }
    const scan = run('rg', ['-n', 'org |herdr-monitor|herdr-brain|lane.mjs|notify-watch|settle-watch', copy], { ok: false });
    write(path.join(evidence, 'existing-call-inventory.txt'), scan.stdout);
    // Only path constants are relocated; route table and command arguments stay intact.
    const transform = (directory) => {
      for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        const file = path.join(directory, entry.name);
        if (entry.isDirectory()) { transform(file); continue; }
        write(file, relocate(read(file), { live, home: process.env.HOME, scratchHome, copy, candidate, root,
          launcher: file === path.join(copy, 'scripts/lane/launch-supervisor.mjs') }));
      }
    };
    transform(copy); auditCopies(copy, { live, home: process.env.HOME }); liveCopyReady = true;
    return 'live launcher already uses current/contrib; extra callers: dispatch, notify, tidy, settle, stage and promotion/desks (inventory retained)';
  });
  const existingReady = () => { if (!liveCopyReady) pending('live existing-project copy not safely relocated/audited'); if (!fixture || !supervisor) pending('scratch record/supervisor unavailable'); };
  await test('Existing project: routing and both wrapper dry runs', async () => {
    existingReady(); requireCandidate('contrib/settle-watch.mjs');
    initRepo(copy);
    const org = path.join(path.dirname(copy), '.org'); node(path.join(candidate, 'bin/org.mjs'), ['init', org]);
    const item = node(path.join(candidate, 'bin/org.mjs'), ['add', 'Legacy wrapper'], { cwd: copy, extra: { ORG_DIR: org } }).stdout.match(/^(\S+)/)[1];
    const report = path.join(root, 'legacy-report.md');
    const output = node(path.join(candidate, 'bin/org.mjs'), ['start', item, '--harness', 'codex', '--model', 'scripted', '--effort', 'low', '--workspace', copy, '--report', report], { extra: { ORG_DIR: org } }).stdout;
    const id = output.match(/^(R-\d+)/)[1]; node(path.join(candidate, 'bin/org.mjs'), ['set', id, `agent=${supervisor.name}`], { extra: { ORG_DIR: org } });
    const existingWs = h('workspace', 'create', '--cwd', copy, '--label', 'acceptance-existing-project', '--no-focus');
    const cwdProbes = [], cwdStart = Date.now();
    try {
      await until(() => {
        const pane = h('pane', 'get', existingWs.root_pane.pane_id).pane;
        cwdProbes.push({ elapsedMs: Date.now() - cwdStart, pane });
        return pane.foreground_cwd === copy;
      }, 'existing-project shell cwd before metadata lookup');
    } catch (error) { throw new HarnessLimit(error.message); }
    finally { write(path.join(evidence, 'existing-shell-cwd-probe.json'), JSON.stringify(cwdProbes, null, 2)); }
    // Retain native resolver and UI metadata separately. The caller's native
    // lookup must work even if UI metadata never appears in the bounded poll.
    h('worktree', 'list', '--workspace', existingWs.workspace.workspace_id);
    const probes = [], metadataStart = Date.now();
    let metadataReady = false;
    try {
      await until(() => {
        const workspace = h('workspace', 'list').workspaces.find((w) => w.workspace_id === existingWs.workspace.workspace_id);
        const configured = h('workspace', 'list').workspaces.find((w) => w.workspace_id === supervisor.workspace);
        probes.push({ elapsedMs: Date.now() - metadataStart, workspace, configured });
        metadataReady = workspace?.worktree?.checkout_path === copy && workspace.worktree.repo_root === copy;
        return metadataReady;
      }, 'canonical workspace metadata before wrapper execution', 15_000);
    } catch (error) {
      if (error.message !== 'timeout: canonical workspace metadata before wrapper execution') throw error;
    } finally { write(path.join(evidence, 'workspace-metadata-probe.json'), JSON.stringify(probes, null, 2)); }
    const persona = path.join(root, 'persona-env');
    write(persona, `#!/bin/sh\nprintf 'CLAUDE_CONFIG_DIR=%s\\n' ${quote(path.join(root, 'persona'))}\n`); fs.chmodSync(persona, 0o755);
    fs.mkdirSync(path.dirname(copy), { recursive: true });
    // Invocation builder resolves routing.json, passes its exact --model/--effort.
    const probe = path.join(root, 'legacy-routes.mjs');
    write(probe, `import assert from 'node:assert/strict';import {buildSupervisorInvocation} from ${JSON.stringify(path.join(copy, 'scripts/lane/launch-supervisor.mjs'))};for(const route of ['executive','settle','settle-critical']){const i=buildSupervisorInvocation(${JSON.stringify(copy)},['--route',route,'--',...(route==='executive'?['--open']:['${id}']),'--dry-run']);assert.ok(i.args.includes('--model'));assert.ok(i.args.includes('--effort'));console.log(JSON.stringify(i));}`);
    runCopy(process.execPath, [probe], { extra: { ORG_DIR: org } });
    const isolation = ['--dry-run', '--launcher', persona, '--cmem-domain', path.join(root, 'bin/cmem-domain')];
    const executive = runCopy('/bin/sh', [path.join(copy, '.lane/supervisor/continue.sh'), ...isolation], { cwd: copy, extra: { ORG_DIR: org }, ok: false });
    const settle = runCopy('/bin/sh', [path.join(copy, '.lane/supervisor/arm-watch.sh'), id, ...isolation], { cwd: copy, extra: { ORG_DIR: org }, ok: false });
    const routing = runCopy(process.execPath, ['--test', path.join(copy, 'scripts/lane/routing.test.mjs')], { cwd: copy, extra: { ORG_DIR: org }, ok: false });
    for (const r of [executive, settle, routing]) {
      if (r.status !== 0 && /acceptance_(?:harness_limit|product_boundary)/.test(r.stdout + r.stderr)) {
        throw commandFailure(r.stdout + r.stderr);
      }
    }
    if (!metadataReady) {
      for (const r of [executive, settle]) {
        assert.notEqual(r.status, 0, 'frozen contrib caller must expose the background identity gap');
        assert.match(r.stdout, /no Herdr workspace has .* as its canonical checkout/);
      }
    } else {
      for (const r of [executive, settle]) assert.equal(r.status, 0, r.stdout + r.stderr);
    }
    assert.equal(routing.status, 0, routing.stdout + routing.stderr);
    requireCandidate('supervisor/open-session.mjs');
    const launcher = path.join(copy, 'scripts/lane/launch-supervisor.mjs');
    const before = fs.readFileSync(launcher), mode = fs.statSync(launcher).mode & 0o777;
    const switched = workspaceIdentityCutover(before.toString(), candidate);
    const checks = { metadataReady, legacy: { executive: executive.status, settle: settle.status },
      beforeSha256: crypto.createHash('sha256').update(before).digest('hex'),
      switchedSha256: crypto.createHash('sha256').update(switched).digest('hex'),
      switch: 'only supervisor entry target: contrib/settle-watch.mjs -> supervisor/open-session.mjs' };
    try {
      write(launcher, switched); fs.chmodSync(launcher, mode);
      // Rebuild route invocations after the real target switch. Flags and route
      // declarations remain the copied live bytes, and every call is audited.
      runCopy(process.execPath, [probe], { extra: { ORG_DIR: org } });
      for (const [name, args] of [['continue', [path.join(copy, '.lane/supervisor/continue.sh'), ...isolation]],
        ['arm-watch', [path.join(copy, '.lane/supervisor/arm-watch.sh'), id, ...isolation]]]) {
        const r = runCopy('/bin/sh', args, { cwd: copy, extra: { ORG_DIR: org }, ok: false });
        checks[name] = r.status;
        if (r.status !== 0) throw commandFailure(`${name}: ${r.stdout + r.stderr}`);
        assert.ok(r.stdout.includes(`--workspace ${existingWs.workspace.workspace_id} --cwd ${copy}`), 'native lookup selected the created background workspace');
      }
      const switchedRouting = runCopy(process.execPath, ['--test', path.join(copy, 'scripts/lane/routing.test.mjs')], { cwd: copy, extra: { ORG_DIR: org }, ok: false });
      checks.routing = switchedRouting.status;
      if (switchedRouting.status !== 0) throw commandFailure(switchedRouting.stdout + switchedRouting.stderr);
    } finally {
      fs.writeFileSync(launcher, before); fs.chmodSync(launcher, mode);
      assert.deepEqual(fs.readFileSync(launcher), before); assert.equal(fs.statSync(launcher).mode & 0o777, mode);
      checks.restored = true;
      write(path.join(evidence, 'workspace-identity-cutover.json'), JSON.stringify(checks, null, 2));
    }
    return 'background identity resolved by native Git lookup; both copied wrappers and routing tests pass after the scratch-only supervisor entry switch; original bytes/mode restored';
  });
  await test('Existing project: org PATH consumers', () => {
    existingReady();
    // The live close script runs against the configured scratch record and sees
    // only this run’s panes. Dry-run prevents its legacy path policy deleting.
    runCopy('/bin/zsh', ['-f', path.join(copy, '.lane/supervisor/close-finished-agents.sh'), '--dry-run'], { cwd: copy, extra: { ORG_DIR: fixture.org } });
    const settle = path.join(root, 'settle.md'); write(settle, 'next_action: dispatch-review\nsettled_run: R-1\ndispatch_command: "dispatch ITEM review-lane lane/happy-path"\n');
    // apply-settle dry-run reads its own relocated record; stage a run there.
    const org = path.join(path.dirname(copy), '.org');
    runCopy('/bin/zsh', ['-f', path.join(copy, '.lane/supervisor/apply-settle.sh'), settle, 'R-1', '--dry-run'], { cwd: copy, extra: { ORG_DIR: org } });
    const rec = (a) => node(path.join(candidate, 'bin/org.mjs'), a, { cwd: copy, extra: { ORG_DIR: org } }).stdout;
    const item = rec(['add', 'Settle PATH acceptance', '--role', 'orchestrator']).match(/^(\S+)/)[1];
    const id = rec(['start', item, '--harness', 'codex', '--model', 'scripted', '--effort', 'low']).match(/^(R-\d+)/)[1];
    write(settle, `---\nrun: ${id}\noutcome: done\nsummary: Exercise the copied settle command consumer.\nheadline: The settle command consumer ran\nblockers: []\nproposals: []\nlearnings: []\nartifacts: []\nnext_action: dispatch-review\nsettled_run: R-1\norg_commands: ["org add 'Independent acceptance review' --role reviewer"]\ndispatch_command: "dispatch ITEM review-lane lane/happy-path"\n---\n\nIntentionally no Draft section: stop after record commands, before any review desk.\n`);
    const applied = runCopy('/bin/zsh', ['-f', path.join(copy, '.lane/supervisor/apply-settle.sh'), settle, id], { cwd: copy, extra: { ORG_DIR: org }, ok: false });
    assert.notEqual(applied.status, 0, 'fixture must stop before review desk dispatch');
    assert.match(applied.stderr, /substring not found/);
    assert.ok(json(rec(['show', id, '--json'])).report, 'O ingest used the actual org launcher on PATH');
    assert.ok(JSON.parse(rec(['status', '--json'])).items.some((i) => i.title === 'Independent acceptance review'));
    return 'copied close status parser plus actual apply-settle org add/ingest through PATH; intentional missing Draft stops before review desk';
  });
  const switches = [
    ['launch-supervisor.mjs', 'scripts/lane/launch-supervisor.mjs', 'supervisor/open-session.mjs'],
    ['continue.sh', '.lane/supervisor/continue.sh', 'launch-supervisor.mjs'],
    ['arm-watch.sh', '.lane/supervisor/arm-watch.sh', 'watch/watch.mjs'],
    ['dispatch.sh', '.lane/supervisor/dispatch.sh', 'arm-watch.sh'],
    ['tidy recovery', '.lane/supervisor/tidy-tabs.sh', 'watch-logs'],
    ['stable supervisor name', '.lane/supervisor/session-start.sh', 'supervisor-opus'],
    ['SETTLE protocol', '.lane/supervisor/SETTLE.md', 'open-session'],
    ['WORK-PATTERN notices/cleanup', '.lane/supervisor/WORK-PATTERN.md', 'watch-no-report'],
    ['routing tests', 'scripts/lane/routing.test.mjs', 'open-session'],
    ['notify retirement', '.lane/supervisor/notify-watch.sh', null],
  ];
  await test('ENG-64: every file switch and rollback', () => {
    existingReady();
    const checks = [];
    for (const [name, rel, marker] of switches) {
      const source = path.join(backup, rel), sandbox = path.join(copy, rel);
      const before = fs.readFileSync(source), mode = fs.statSync(source).mode & 0o777;
      const current = read(sandbox);
      const applied = marker === null ? !read(path.join(copy, '.lane/supervisor/dispatch.sh')).includes('notify-watch.sh')
        : current.includes(marker) && (name !== 'stable supervisor name' || !current.includes('|| true'));
      // Exercise actual byte/mode restoration even while the switch is pending.
      fs.writeFileSync(sandbox, 'scratch rollback probe\n'); fs.chmodSync(sandbox, 0o600);
      fs.copyFileSync(source, sandbox); fs.chmodSync(sandbox, mode);
      assert.deepEqual(fs.readFileSync(sandbox), before); assert.equal(fs.statSync(sandbox).mode & 0o777, mode);
      checks.push({ name, file: rel, switch: applied ? 'PENDING: marker present; behavioral canary still required' : 'PENDING: switch not implemented in copied live file', rollback: 'PASS: exact bytes and mode restored' });
    }
    write(path.join(evidence, 'cutover-switches.json'), JSON.stringify(checks, null, 2));
    pending('ten file switches each enumerated; rollback bytes/modes pass; live cutover is unapplied, so wrapper/recovery/name/canary checks cannot pass');
  });
  await test('ENG-64: final contrib removal and restoration', () => {
    existingReady();
    const compat = requireCandidate('contrib/settle-watch.mjs');
    const saved = fs.readFileSync(compat), mode = fs.statSync(compat).mode & 0o777;
    fs.unlinkSync(compat); write(compat, saved); fs.chmodSync(compat, mode);
    assert.deepEqual(fs.readFileSync(compat), saved);
    pending('compatibility blob restoration passes in scratch; existing launcher still calls contrib, so retirement is forbidden');
  });
  await discovery({ root, discoveryRoots, evidence, candidate, opt, env, test, pending, initRepo, run, node, git, h, until, write, read });
  await test('New project: default supervisor dispatch/watch/ingest cycle', () => {
    pending('unconfigured default-route dispatch, armed watch and ingestion are not executed; the entry/bootstrap and configured-cycle cases cannot satisfy this gate');
  });
} catch (error) {
  if (!(error instanceof Pending)) results.push({ id: 'fatal', name: 'Harness setup', status: 'PENDING', origin: 'harness', detail: error.stack, evidence: logFile ? path.basename(logFile) : 'summary.json' });
} finally {
  await test('Cleanup and scope audit', cleanupScope);
  emitSummary();
}
