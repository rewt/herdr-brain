#!/usr/bin/env node
// Explicit local release gate; deliberately outside npm test.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { parseArgs, isMain } from '../lib/cli-help.mjs';
import { fileURLToPath } from 'node:url';
import { HarnessLimit, Pending, commandFailure, requirePrerequisite } from './limits.mjs';
import { installSignalCleanup, removeCredentials, credentialResidue } from './signal-cleanup.mjs';
import { stopProducers, awaitProducers } from './producers.mjs';
import { retainedRoots, resultLine, gateOutcome, writeSummary } from './results.mjs';
import { liveSocket } from './probe.mjs';
import { cases, runCase, selectCases } from './cases.mjs';
import { verifyLiveContinuation, retainedLiveEvidence } from '../lib/live-coverage.mjs';
import { makeSnapshotWritable } from './snapshot.mjs';
import { createOwnedTempRoot, createLiveSessionTemp } from './temp.mjs';
import { settleCase } from './settle.mjs';
import { supervisorCase } from './supervisor.mjs';
import { assertHousekeepingActions } from './housekeeping.mjs';
import { startFocusMonitor, assertFocus } from './focus.mjs';
import { cleanupWorkspaces, cleanupInboxes } from './cleanup.mjs';
import { testSlotEnvironment, scratchProductHomes, assertScratchHomes, enterScratchHomes } from './environment.mjs';
import { fleetPath } from '../lib/fleet.mjs';
import { loadAwareCommand } from './commands.mjs';
import { createLoadMonitor, waitUntil } from './load.mjs';
import { noticeDeliveryBudgetMs } from './notice-budget.mjs';
import { matchingRun } from '../supervisor/tidy-tabs.mjs';
import { ownerAlive } from '../lib/process-owner.mjs';
import { scriptedProcesses, awaitScriptedExit, retireScriptedWorker } from './retirement.mjs';
import { captureProductCheckout, createProductCheckout, verifyProductCheckoutIsolation, checkoutGit, releaseMetadata, productFiles, payloadEntry } from '../lib/product-files.mjs';
import { checkBundle } from '../lib/releases.mjs';

// The actual snapshot case and offline witnesses share this input boundary.
export function snapshotCandidate({ input, source, destination, ownedRoot, git = checkoutGit }) {
  let commit;
  if (fs.existsSync(input) && fs.statSync(input).isDirectory()) {
    source = fs.realpathSync(input);
    if (releaseMetadata.some(file => fs.lstatSync(path.join(source, file), { throwIfNoEntry: false }))) {
      const bundle = checkBundle(source, { verifyFiles: true }), offset = path.relative(fs.realpathSync(ownedRoot), destination);
      if (!offset || offset.startsWith('..') || path.isAbsolute(offset) || fs.realpathSync(path.dirname(destination)) !== path.dirname(destination) ||
          fs.lstatSync(destination, { throwIfNoEntry: false })) throw Error('sealed copy requires new owned scratch');
      fs.cpSync(source, destination, { recursive: true, dereference: false, filter: file => !['.git', '.org', '.lane', 'node_modules'].includes(path.basename(file)) });
      checkBundle(destination, { verifyFiles: true });
      return { kind: 'release', commit: bundle.commit };
    }
    commit = captureProductCheckout(source, undefined, { git }).commit;
  } else commit = git(source, ['rev-parse', '--verify', '--end-of-options', `${input}^{commit}`]).trim();
  const identity = createProductCheckout({ source, commit, destination, ownedRoot, git });
  return { kind: 'checkout', commit: identity.commit };
}

// The configured fixture keeps its record outside the checkout. Both command
// paths must select it; lane retirement otherwise observes an empty record.
export function configuredCommands(node, candidate, { repo, org }) {
  const call = (file, args, cwd, options) => node(path.join(candidate, file), args,
    { ...options, cwd, extra: { ...options.extra, ORG_DIR: org } }).stdout;
  return {
    record: (args, options = {}) => call('bin/org.mjs', args, repo, options),
    lane: (args, cwd = repo, options = {}) => call('lanes/lane.mjs', args, cwd, options),
    retire: (job, options = {}) => JSON.parse(call('supervisor/retire.mjs',
      ['apply', '--repo', repo, '--org', org, '--lane', job.info.workspace], repo, options)),
  };
}

// Direct lane promotion does not complete record work. The scripted supervisor
// records that disposition only after integration succeeds, as a real one does.
export function promoteAndComplete(job, { lane, record }) {
  lane(['promote', job.lane]);
  record(['close', job.item, '--if-current-run', job.run, '--note', 'Acceptance supervisor confirmed successful integration']);
}

// Unresolved fixtures exercise KEEP, then the receipt-owned scratch cleanup
// disposes of them after all producers drain. Abandonment is not completion.
export function assertWorkerKept(job, { lane, reason }) {
  const output = lane(['close', job.lane], undefined, { ok: false });
  const actions = output.split('\n').filter(line => line.startsWith('{')).map(JSON.parse);
  assert.ok(actions.some(action => action.action === 'keep' &&
    action.workspace_id === job.info.meta.worker_workspace && reason.test(action.why)),
    `${job.run}: expected worker KEEP (${reason}): ${output}`);
  assert.ok(fs.existsSync(job.info.workspace), `${job.run}: kept worktree remains`);
}

// A PTY input/ingestion receipt can precede the sender's delivery confirmation.
// Keep its callback reference until the exact recorded watcher has exited.
export async function awaitWatcherExit(job, { until, alive = ownerAlive }) {
  await until(() => !alive(job.watcher), `${job.run} watcher exits`, 30_000);
}

export function harnessEnvironment(input, root) {
  const env = { ...input };
  for (const key of Object.keys(env)) if (/^(ORG_|LANE_|HERDR_|RELEASE_|ACCEPTANCE_|MONITOR_|SE_|NW_)/.test(key) || key.startsWith('GIT_')) delete env[key];
  Object.assign(env, testSlotEnvironment(input), scratchProductHomes(root), { ACCEPTANCE_ROOT: root, TMPDIR: root, TMP: root, TEMP: root, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
    ORG_ACTOR: 'release-acceptance-setup', npm_config_cache: path.join(root, 'npm-cache'), npm_config_update_notifier: 'false' });
  return assertScratchHomes(env, [root], { realHome: input.HOME, fleetFile: fleetPath(env) });
}

export function initializeHerdrOwnership(root, { binary, socketPath, fleetRoot }) {
  // Unconfigured entry puts worktrees in the separately owned short fleet.
  // Grant its creation paths and live pane cwds before starting PTY workers.
  fs.writeFileSync(path.join(root, 'ownership.json'), JSON.stringify({ binary, socketPath,
    creationRoots: [fs.realpathSync(fleetRoot)], workspaces: [], tabs: [], panes: [] }));
}

export async function abandonWatcher(job, { record, h, until, read, alive = ownerAlive }) {
  record(['abandon', job.run, '--note', 'Acceptance failure path complete']);
  // Notice confirmation may still be running when the PTY receipt arrives.
  // Hold working until the watcher actually observes abandonment, so its next
  // agent.wait cannot miss a transient 300ms pulse while confirming delivery.
  h('pane', 'report-agent', job.pane, '--source', 'acceptance-script', '--agent', 'codex', '--state', 'working', '--seq', '100');
  try { await until(() => read(job.watcher.log).includes('was abandoned; stopping'), 'abandoned watcher stops'); }
  finally { h('pane', 'report-agent', job.pane, '--source', 'acceptance-script', '--agent', 'codex', '--state', 'idle', '--seq', '101'); }
  await awaitWatcherExit(job, { until, alive });
}

async function main() {
const HERE = path.dirname(fileURLToPath(import.meta.url));
const SOURCE = path.dirname(HERE);
const { values: opt } = parseArgs({ options: {
  candidate: { type: 'string' }, source: { type: 'string', default: SOURCE },
  'summary-file': { type: 'string' },
  'continue': { type: 'string' },
  cases: { type: 'string' },
  keep: { type: 'boolean', default: false },
  'skip-live': { type: 'boolean', default: false },
} });
if (!opt.candidate) { console.error('usage: node acceptance/run.mjs --candidate TAG|REF|DIRECTORY [--source REPO] [--keep] [--summary-file FILE]'); process.exit(2); }
if (opt.continue && opt['skip-live']) throw Error('live continuation requires actual live scope checks');
if (opt.continue && opt.cases !== undefined) throw Error('focused acceptance cannot reuse live release coverage');
const scope = selectCases(opt.cases);
const scratchRoots = [];
const realHome = os.homedir();
const root = createOwnedTempRoot(path.join(process.env.ACCEPTANCE_TMPDIR ?? '/tmp', 'herdr-acceptance-'), scratchRoots);
const evidence = path.join(root, 'evidence');
fs.mkdirSync(evidence);
const started = Date.now();
const load = createLoadMonitor({ record: (sample) => fs.appendFileSync(path.join(evidence, 'load.jsonl'), JSON.stringify(sample) + '\n') });
const results = [];
let logFile, candidateCommit, candidateSnapshot, fixture, supervisor, defaultOrg, record, lane, retire;
let focusMonitor, focusError;
let liveContinuation;
let stopping = false, cleanupPromise, focusPromise;
const pids = new Set();
const discoveryRoots = [];
const env = harnessEnvironment(process.env, root);
// Keep the scripted cycle fleet separately owned and short,
// separately owned and included in the same cleanup registry.
const fleetRoot = createLiveSessionTemp(scratchRoots, discoveryRoots);
env.HERDR_MONITOR_FLEET = path.join(fleetRoot, 'f');
fs.mkdirSync(env.HOME, { recursive: true });
const checkHomes = selected => assertScratchHomes(selected, scratchRoots, { realHome, fleetFile: fleetPath(selected) });
const write = (file, value) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, value); };
const read = (file) => fs.readFileSync(file, 'utf8');
const json = (text) => { const v = JSON.parse(text); return v.result ?? v; };
const quote = (s) => "'" + s.replaceAll("'", "'\\''") + "'";
const pending = (reason) => { throw new Pending(reason); };
const executeCommand = loadAwareCommand((command, args, options) => {
  const r = spawnSync(command, args, options);
  if (logFile) fs.appendFileSync(logFile, JSON.stringify({ command, args, cwd: options.cwd, timeoutMs: options.timeout,
    status: r.status, error: r.error?.message, stdout: options.encoding ? r.stdout : '(archive)', stderr: String(r.stderr ?? '') }) + '\n');
  return r;
}, load, { scratchRoots });
function run(command, args, { cwd = root, extra = {}, ok = true, input, binary = false, isolatedEnv, duringCleanup = false } = {}) {
  if (stopping && !duringCleanup) throw new Pending('run interrupted; no further candidate commands allowed');
  const r = executeCommand(command, args, { cwd, env: checkHomes(isolatedEnv ?? { ...env, ...extra }), encoding: binary ? undefined : 'utf8',
    input, maxBuffer: 32 * 1024 * 1024 });
  if (ok && r.status !== 0) {
    const diagnostic = ((binary ? '' : String(r.stdout ?? '')) + String(r.stderr ?? '')).trim();
    throw commandFailure(`${path.basename(command)} ${args[0]}: ${diagnostic}`, { scratchRoots });
  }
  return r;
}
const scratchHome = path.join(root, 'session-home'); fs.mkdirSync(scratchHome);
const safeGitArgs = (repo, args) => ['--no-pager', '-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-c', 'commit.gpgsign=false', '-C', repo, ...args];
const node = (file, args, options) => run(process.execPath, [file, ...args], options);
const git = (cwd, args) => run('git', safeGitArgs(cwd, args)).stdout.trim();
const candidate = path.join(root, 'candidate');
const present = (file) => fs.existsSync(path.join(candidate, file));
const requireCandidate = (file) => { if (!present(file)) pending(`candidate lacks ${file}`); return path.join(candidate, file); };
async function test(definition, fn) {
  if (stopping && ![cases.cleanup.key, cases.focus.key].includes(definition.key)) throw new Pending('run interrupted');
  if (scope && !scope.selected.includes(definition.key)) {
    const result = { id: String(results.length + 1).padStart(2, '0'), key: definition.key, name: definition.name,
      status: 'SKIP', origin: 'harness', detail: 'Unrun: outside the explicit focused case selection' };
    results.push(result); return result;
  }
  const retained = liveContinuation?.retained.find(r => r.key === definition.key);
  if (retained) {
    const result = { ...retained, evidence: retainedLiveEvidence(liveContinuation.prior, retained),
      retained: { sha256: liveContinuation.certificate.prior.sha256, commit: liveContinuation.certificate.sourceCommit, key: retained.key } };
    results.push(result); return result;
  }
  const previousActor = env.ORG_ACTOR;
  checkHomes(env);
  // Some offline cases call product modules in this process. Give them the
  // same machine homes as subprocesses, restoring operator context afterward.
  const restoreHomes = enterScratchHomes(env, scratchRoots, { realHome, fleetFile: fleetPath(env) });
  env.ORG_ACTOR = `release-acceptance-${definition.key}`;
  const window = load.begin();
  const id = String(results.length + 1).padStart(2, '0');
  logFile = path.join(evidence, `${id}.jsonl`);
  write(logFile, '');
  const phaseFile = path.join(evidence, 'focus-phase.json');
  write(`${phaseFile}.tmp`, JSON.stringify({ key: definition.key, id }));
  fs.renameSync(`${phaseFile}.tmp`, phaseFile);
  try {
    const result = await runCase(results, definition, fn, { scratchRoots,
      load: () => load.snapshot(definition === cases.focus ? 0 : window) });
    result.load = load.snapshot(window);
    result.evidence = `${id}.jsonl`;
    return result;
  } finally {
    logFile = undefined; env.ORG_ACTOR = previousActor;
    restoreHomes();
  }
}
async function until(fn, label, ms = 25_000) {
  return waitUntil(() => {
    if (stopping) throw new Pending('run interrupted');
    return fn();
  }, label, ms, { load });
}
const h = (...args) => json(node(path.join(root, 'herdr.mjs'), args, { extra: { ACCEPTANCE_CALLER: 'harness' } }).stdout);
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
  requirePrerequisite(results, cases.fixture.key);
  requireCandidate('dispatch/dispatch.mjs');
  write(path.join(root, 'mode'), mode);
  if (!item) item = record(['add', `Acceptance ${topic}`, '--role', 'engineer']).match(/^(\S+)/)[1];
  const args = [item, '--repo', fixture.repo, '--org', fixture.org, '--lane', topic, '--route', 'scripted',
    '--brief', fixture.brief, '--report', path.join(fixture.org, `${topic}-${Date.now()}.md`), '--to', supervisor.name];
  if (reuse) args.push('--reuse', reuse);
  const job = json(node(path.join(candidate, 'dispatch/dispatch.mjs'), args, { cwd: fixture.repo }).stdout);
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
  await awaitWatcherExit(job, { until });
}
const stopWatcher = job => abandonWatcher(job, { record, h, until, read });
async function closeWorker(job) {
  const receipt = await retireScriptedWorker(job, { h, retire, until });
  fs.appendFileSync(logFile, JSON.stringify(receipt) + '\n');
  lane(['close', job.lane]);
}

let cleanupSucceeded = false;
function cleanupScope() {
  return cleanupPromise ??= closeScope();
}
async function closeScope() {
  const errors = [];
  try {
    // Stop PTY workers and adapter admissions before reading dispatch journals:
    // an active default-cycle dispatch may publish another watcher receipt.
    stopProducers(root);
    await awaitProducers(root);
    // PIDs originate only in successful candidate detach receipts or in this
    // scratch record’s dispatch journals (including partially failed dispatch).
    for (const org of [fixture?.org, defaultOrg].filter(Boolean)) {
      if (!fs.existsSync(path.join(org, 'dispatch'))) continue;
      for (const file of fs.readdirSync(path.join(org, 'dispatch'))) {
        if (!file.endsWith('.json') || file.endsWith('.routes.json')) continue;
        try {
          const job = JSON.parse(read(path.join(org, 'dispatch', file)));
          if (job.watcher?.pid) pids.add(job.watcher.pid);
        } catch (error) { errors.push(`watcher journal ${file}: ${error.message}`); }
      }
    }
    for (const pid of pids) { try { process.kill(pid, 'SIGTERM'); } catch (e) { if (e.code !== 'ESRCH') errors.push(e.message); } }
    const alive = pid => { try { process.kill(pid, 0); return true; } catch (e) { if (e.code === 'ESRCH') return false; throw e; } };
    while ([...pids].some(alive)) {
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    try { await cleanupInboxes({ root, candidate, evidence }); }
    catch (error) { errors.push(error.message); }
    if (fs.existsSync(path.join(root, 'ownership.json'))) {
      const state = JSON.parse(read(path.join(root, 'ownership.json')));
      const cleaned = await cleanupWorkspaces({ root, evidence, native: (args) => {
        const id = `cleanup:${crypto.randomUUID()}`;
        const trace = type => fs.appendFileSync(path.join(evidence, 'focus-calls.jsonl'), JSON.stringify({
          type, id, at: Date.now(), args, requested: args, origin: 'harness', actor: 'release-acceptance-cleanup',
        }) + '\n');
        trace('start');
        try { return json(run(state.binary, args, { extra: { HERDR_SOCKET_PATH: state.socketPath }, duringCleanup: true }).stdout); }
        finally { trace('end'); }
      } });
      errors.push(...cleaned.errors);
      for (const file of ['creation-intents.jsonl', 'creations.jsonl', 'herdr.jsonl', 'denied.jsonl', 'supervisor-input.jsonl', 'worker-input.jsonl', 'notifications.jsonl']) {
        if (fs.existsSync(path.join(root, file))) fs.copyFileSync(path.join(root, file), path.join(evidence, file));
      }
    }
    // Authentication copies are never evidence, even with --keep or a failed
    // session. Remove them after the owned panes/processes have stopped.
    removeCredentials(root);
    if (errors.length) throw new HarnessLimit(`cleanup failed: ${errors.join('; ')}`);
    cleanupSucceeded = true;
    return 'all created workspaces closed; focus and source audit precede scratch disposal';
  } finally { removeCredentials(root); }
}

function emitSummary(interruption = {}) {
  const measuredLoad = load.snapshot(); load.stop();
  const elapsedSeconds = Math.round((Date.now() - started) / 1000);
  const { counts, ready: passed } = gateOutcome(results);
  const ready = !scope && passed;
  const summary = { candidate: opt.candidate, candidateCommit, elapsedSeconds, counts, ready, evidence, results, load: measuredLoad,
    ...(scope ? { scope, selectionPassed: passed } : {}),
    ...(liveContinuation ? { liveCoverage: { kind: 'supervisor-reconciled-live-coverage',
      sha256: liveContinuation.sha256, inputBase64: liveContinuation.inputBase64 },
      freshCases: results.filter(r => !r.retained).map(r => r.key), retainedCases: results.filter(r => r.retained).map(r => r.key) } : {}),
    credentialResidue: credentialResidue(root), retainedDiscoveryRoots: retainedRoots(discoveryRoots), ...interruption };
  // The build requests an exact copy before sealing the immutable bundle.
  writeSummary(summary, opt['summary-file']);
  const screen = [`${scope ? 'Focused' : 'Release'} acceptance: ${opt.candidate} (${elapsedSeconds}s) — ${counts.PASS} pass / ${counts.FAIL} fail / ${counts.PENDING} pending / ${counts.SKIP} skipped — ${scope ? (passed ? 'SELECTION PASSED; RELEASE UNQUALIFIED' : 'SELECTION FAILED') : (ready ? 'READY' : 'NOT READY')}`,
    ...results.map((v) => resultLine(v, summary.retainedDiscoveryRoots)), `Evidence: ${evidence} (NN.jsonl; summary.json has reasons)`].join('\n');
  write(path.join(evidence, 'screen.txt'), screen + '\n'); console.log(screen);
  process.exitCode = passed ? 0 : 1;
}

function finishFocus() {
  return focusPromise ??= closeFocus();
}
async function closeFocus() {
  await test(cases.focus, async () => {
    let summary, error = focusError;
    if (focusMonitor) {
      try { summary = await focusMonitor.stop(); }
      catch (value) { error = value; }
    }
    // Read forbidden attempts even if the monitor failed or a candidate caller
    // swallowed its refusal. A missing focus change cannot green such a call.
    const detail = assertFocus(summary, { evidence, error });
    // Cleanup's case has completed before this distinct focus case starts.
    // Keep both evidence streams and ordinals intact; only then discard roots.
    if (!cleanupSucceeded) throw new HarnessLimit('cleanup completion uncertain; scratch roots retained');
    if (!candidateSnapshot) throw new HarnessLimit('candidate identity uncertain; source roots retained');
    if (candidateSnapshot.kind === 'checkout') verifyProductCheckoutIsolation(captureProductCheckout(candidate, candidateCommit, { all: true, git }), git);
    if (!opt.keep) for (const directory of discoveryRoots) fs.rmSync(directory, { recursive: true, force: true });
    if (!opt.keep) {
      run('chmod', ['-R', 'u+w', root], { duringCleanup: true });
      for (const entry of fs.readdirSync(root)) if (entry !== 'evidence') fs.rmSync(path.join(root, entry), { recursive: true, force: true });
    }
    return detail;
  });
}
installSignalCleanup({ root, onSignal: () => { stopping = true; }, cleanup: async () => {
  try { return await cleanupScope(); } finally { await finishFocus(); }
}, summarize: (interruption) => {
  results.push({ id: 'interrupt', key: 'interrupted-run', name: 'Interrupted run', status: 'PENDING', origin: 'harness', detail: interruption.signal, evidence: 'summary.json' });
  emitSummary(interruption);
} });

try {
  const missing = ['node', 'git', 'bash', 'zsh', 'rg', 'python3', 'tar', 'npm', 'chmod', 'herdr'].filter((tool) => run('which', [tool], { ok: false }).status !== 0);
  if (missing.length) {
    await test(cases.tools, () => { throw new HarnessLimit(`missing prerequisite: ${missing.join(', ')}`); });
    throw new Pending('prerequisites unavailable; no candidate code executed');
  }
  if (process.env.HERDR_ENV === '1') {
    try { focusMonitor = await startFocusMonitor({ socketPath: liveSocket(process.env), evidence }); }
    catch (error) { focusError = error; }
  }
  await test(cases.snapshot, () => {
    candidateSnapshot = snapshotCandidate({ input: opt.candidate, source: opt.source, destination: candidate, ownedRoot: root, git });
    candidateCommit = candidateSnapshot.commit;
    auditSnapshot(candidate);
    makeSnapshotWritable(candidate, root);
    assert.ok(present('bin/org.mjs')); return `${opt.candidate}: ${candidateCommit}`;
  });
  if (results.find((v) => v.key === cases.snapshot.key).status !== 'PASS') throw new Error('unsafe or unavailable candidate snapshot; no candidate commands executed');
  if (opt.continue) {
    const tree = git(candidate, ['rev-parse', 'HEAD^{tree}']);
    liveContinuation = verifyLiveContinuation(opt.continue, { commit: candidateCommit, tree, canonical: opt.source });
  }
  const fresh = path.join(root, 'new-project');
  initRepo(fresh);
  await test(cases.record, () => {
    assert.ok(!fs.existsSync(path.join(fresh, '.org')));
    const status = node(path.join(candidate, 'bin/org.mjs'), ['status', '--json'], { cwd: fresh, ok: false });
    const add = node(path.join(candidate, 'bin/org.mjs'), ['add', 'Work discovered by entering agent'], { cwd: fresh, ok: false });
    assert.equal(status.status, 0, `record status requires setup: ${status.stderr.trim()}`);
    assert.equal(add.status, 0, `record add requires setup: ${add.stderr.trim()}`);
    assert.ok(fs.existsSync(path.join(fresh, '.org/events.jsonl')), 'record must populate in the new project');
  });
  await test(cases.routes, () => {
    requireCandidate('lanes/routes.mjs');
    const probe = path.join(root, 'routes-probe.mjs');
    write(probe, `import {loadDiscoveredRoutes,resolveLaunchRoute} from ${JSON.stringify(path.join(candidate, 'lanes/routes.mjs'))};\nconsole.log(JSON.stringify(resolveLaunchRoute(loadDiscoveredRoutes().config)));\n`);
    node(probe, [], { cwd: fresh });
  });
  await test(cases.policy, () => {
    requireCandidate('supervisor/supervisor.mjs');
    const brief = node(path.join(candidate, 'supervisor/supervisor.mjs'), ['brief', '--repo', fresh, '--org', path.join(fresh, '.org')], { cwd: fresh }).stdout;
    assert.match(brief, /Supervisor cold start/);
    return 'foreground supervisor cold start reads the initialized record without entry adapters';
  });
  await test(cases.fixture, async () => {
    if (process.env.HERDR_ENV !== '1') throw new HarnessLimit('run inside Herdr (HERDR_ENV=1); no session inspected');
    if (focusError) throw focusError;
    const binary = run('which', ['herdr']).stdout.trim();
    initializeHerdrOwnership(root, { binary, socketPath: liveSocket(process.env), fleetRoot });
    fs.copyFileSync(path.join(SOURCE, 'lib/deadline.mjs'), path.join(root, 'deadline.mjs'));
    for (const file of ['herdr.mjs', 'receipts.mjs', 'producers.mjs', 'worker.mjs', 'environment.mjs', 'poll.mjs']) fs.copyFileSync(path.join(HERE, file), path.join(root, file));
    write(path.join(root, 'test-slot-env.json'), JSON.stringify(testSlotEnvironment(env)));
    write(path.join(root, 'product-home-env.json'), JSON.stringify({ realHome, roots: [...scratchRoots], homes: Object.fromEntries(Object.keys(scratchProductHomes(root)).map(key => [key, env[key]])) }));
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
    // A legacy detached watcher has no dispatch journal. Its scratch nohup
    // adapter emits its own process receipt before exec; cleanup never scans PIDs.
    write(path.join(bin, 'nohup'), `#!/bin/sh\nprintf '%s\\n' "$$" >> ${quote(path.join(root, 'legacy-watcher-pids'))}\nexec /usr/bin/nohup "$@"\n`);
    fs.chmodSync(path.join(bin, 'nohup'), 0o755);
    fs.symlinkSync(path.join(candidate, 'lanes/lane.mjs'), path.join(bin, 'lane'));
    env.PATH = `${bin}:${process.env.PATH}`;
    fixture = { repo: path.join(root, 'configured-project'), org: path.join(root, 'record'), brief: path.join(root, 'ask.md') };
    ({ record, lane, retire } = configuredCommands(node, candidate, fixture));
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
  await test(cases.cycle, async () => {
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
    promoteAndComplete(job, { lane, record });
    assert.equal(git(fixture.repo, ['rev-parse', 'main']), git(job.info.workspace, ['rev-parse', 'HEAD']));
    assert.equal(git(fixture.repo, ['rev-list', '--merges', 'main']), '');
    await closeWorker(job);
    assert.ok(!fs.existsSync(job.info.workspace));
    return `${job.run}: one notice, recorded report, green fast-forward, lane removed; red/dirty gates refused`;
  });
  await test(cases.queue, async () => {
    const script = requireCandidate('promote/promote.mjs');
    if (!supervisor) pending('owned supervisor stand-in unavailable');
    const repo = path.join(root, 'promotion-project'); initRepo(repo);
    write(path.join(repo, 'package.json'), JSON.stringify({ scripts: { test: 'node --test check.mjs' } }));
    write(path.join(repo, 'check.mjs'), "import assert from 'node:assert/strict'; assert.equal(2 + 2, 4);\n");
    git(repo, ['add', '.']); git(repo, ['commit', '-qm', 'Add default project tests']);
    const worktrees = new Map();
    for (const topic of ['queue-first', 'queue-second', 'queue-refusal']) {
      const workspace = path.join(root, topic); worktrees.set(topic, workspace);
      git(repo, ['worktree', 'add', '-b', `lane/${topic}`, workspace]);
      write(path.join(workspace, `${topic}.txt`), topic);
      git(workspace, ['add', '.']); git(workspace, ['commit', '-qm', topic]);
    }
    write(path.join(worktrees.get('queue-refusal'), 'dirty'), 'uncommitted work');
    const extra = { ORG_DIR: '', LANE_CONFIG: '', LANE_VALIDATE: undefined, NODE_TEST_CONTEXT: undefined, SUPERVISOR_INPUT_WAIT_SECONDS: undefined };
    // No .lane.json, .promote.json, record or Herdr workspace for this project.
    // Notices go to this run's already owned supervisor PTY via its scoped adapter.
    const request = json(node(script, ['queue-first', 'queue-second', 'queue-refusal', '--to', supervisor.name,
      '--delivery-attempts', '2', '--retry-seconds', '0'], { cwd: repo, extra }).stdout);
    pids.add(request.worker.pid);
    const queueFile = path.join(repo, '.git/promote/queue.json');
    await until(() => JSON.parse(read(queueFile)).results.length === 3, 'ordered queue drained', 60_000);
    await until(() => !fs.existsSync(path.join(repo, '.git/promote/worker.lock')), 'promotion worker exited');
    pids.delete(request.worker.pid);
    const state = JSON.parse(read(queueFile));
    assert.equal(state.current, null);
    assert.deepEqual(state.pending, []);
    assert.deepEqual(state.results.map((r) => [r.topic, r.outcome]), [
      ['queue-first', 'promoted'], ['queue-second', 'promoted'], ['queue-refusal', 'refused'],
    ]);
    // Default delivery hands off to an acknowledged independent inbox owner.
    // The queue receipt is a snapshot; actual PTY receipt is proved below.
    for (const result of state.results) {
      assert.equal(result.delivery_id, 'promote:' + result.id);
      assert.equal(result.inbox, path.join(repo, '.git/supervisor/inbox.log'));
      assert.equal(typeof result.delivered, 'boolean');
      assert.equal(result.queued, !result.delivered);
    }
    // The owner delivers at production cadence: about 30 s for three notices.
    await until(() => state.results.every((r) => inbox().includes(`[promote-queue] id=${r.id} `)), 'every promotion notice reached supervisor PTY',
      noticeDeliveryBudgetMs(state.results.length));
    const messages = inbox().split('\n').filter(Boolean).map(JSON.parse).map((entry) => entry.line)
      .filter((line) => line.includes('[promote-queue]'));
    assert.deepEqual(messages.map((line) => /lane=(\S+)/.exec(line)[1]), ['queue-first', 'queue-second', 'queue-refusal']);
    for (const result of state.results) {
      const received = messages.filter(line => line.startsWith('[promote-queue] id=' + result.id + ' '));
      assert.equal(received.length, 1, 'each job reaches the supervisor PTY exactly once');
      assert.ok(received[0].includes('lane=' + result.topic + ' outcome=' + result.outcome));
    }
    assert.ok(!fs.existsSync(worktrees.get('queue-first')) && !fs.existsSync(worktrees.get('queue-second')));
    assert.ok(fs.existsSync(worktrees.get('queue-refusal')));
    assert.match(state.results[2].reason, /not clean/);
    assert.equal(git(repo, ['rev-list', '--merges', 'main']), '');
    assert.equal(git(repo, ['status', '--porcelain']), '');
    assert.equal(git(repo, ['remote']), '');
    fs.copyFileSync(queueFile, path.join(evidence, 'promotion-queue.json'));
    for (const result of state.results) fs.copyFileSync(result.log, path.join(evidence, `${result.topic}.log`));
    return 'unconfigured project: two default npm gates promoted FIFO, lanes closed; dirty refusal kept its lane; three supervisor PTY notices';
  });
  for (const [mode, prefix] of [['missing', 'watch-no-report'], ['invalid', 'watch-invalid-report'], ['blocked', 'watch-blocked']]) {
    await test(cases[mode], async () => {
      const job = await dispatch(mode, `failure-${mode}`);
      await until(() => inbox().includes(`[${prefix}] run=${job.run} `), `${prefix} delivered`, 30_000);
      assert.ok(!inbox().includes(`[org-report] run=${job.run} `));
      process.kill(job.watcher.pid, 0);
      assert.equal(json(record(['show', job.run, '--json'])).report, null);
      await stopWatcher(job);
      assertWorkerKept(job, { lane, reason: /report is not ingested/ });
      return `${job.run}: matching intermediate notice, watcher alive, no ingestion; abandoned watcher exited, unresolved worker kept for scratch cleanup`;
    });
  }
  await test(cases.fix, async () => {
    const first = await dispatch('blocked-report', 'fix-round');
    await final(first);
    await until(() => ['idle', 'done'].includes(h('agent', 'get', first.agent).agent.agent_status), 'worker idle');
    const second = await dispatch('done', first.lane, { item: first.item, reuse: first.run });
    assert.equal(first.agent, second.agent); assert.equal(first.pane, second.pane); assert.notEqual(first.run, second.run);
    await final(second); lane(['check'], second.info.workspace); promoteAndComplete(second, { lane, record }); await closeWorker(second);
    return `${first.run} -> ${second.run}: blocked report then done, same PTY, distinct run/report`;
  });
  await test(cases.grace, async () => {
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
    await final(job); assert.match(read(log), /\[org-report\]/); promoteAndComplete(job, { lane, record }); await closeWorker(job);
    return '900-second configuration stayed quiet for observed interval, resume/report woke it, duplicate refused (full 900s expiry not tested)';
  });
  await test(cases.housekeeping, async () => {
    const script = requireCandidate('housekeeping/housekeeping.mjs');
    // This witness exercises supported direct retirement. Default queue-owned
    // closeout is proved by the queue/supervisor cases; it must not be stolen
    // by housekeeping. Select legacy mode only in this owned scratch fixture.
    const configFile = path.join(fixture.repo, '.lane.json'), originalConfig = read(configFile);
    const legacyConfig = JSON.parse(originalConfig);
    legacyConfig.retirement = { ...legacyConfig.retirement, closeout_queue: false };
    write(configFile, JSON.stringify(legacyConfig));
    git(fixture.repo, ['add', '.lane.json']); git(fixture.repo, ['commit', '-qm', 'Select direct housekeeping witness']);
    try {
    const done = await dispatch('done', 'housekeeping-done');
    await final(done); lane(['check'], done.info.workspace); promoteAndComplete(done, { lane, record });
    const blocked = await dispatch('blocked-report', 'housekeeping-blocked');
    await final(blocked);
    const human = await dispatch('needs-human', 'housekeeping-human');
    await final(human);
    const tabFor = (job) => h('pane', 'get', job.pane).pane.tab_id;
    const closedTab = tabFor(done), keptTabs = [blocked, human].map(tabFor);
    const doneProcesses = scriptedProcesses(done, { h });
    const state = path.join(root, 'housekeeping-state');
    let failure;
    try {
      node(script, ['--once', '--cwd', fixture.repo, '--org', fixture.org, '--state-dir', state],
        { cwd: fixture.repo, extra: { HERDR_PANE_ID: '', HERDR_TAB_ID: '', HERDR_WORKSPACE_ID: '' } });
    } catch (error) { failure = error; }
    if (fs.existsSync(path.join(state, 'actions.jsonl'))) fs.copyFileSync(path.join(state, 'actions.jsonl'), path.join(evidence, 'housekeeping-actions.jsonl'));
    for (const job of [blocked, human]) assert.equal(node(path.join(root, 'herdr.mjs'), ['pane', 'get', job.pane], { ok: false }).status, 0,
      'blocked and needs-human workers must remain');
    if (failure) throw failure;
    const close = node(path.join(root, 'herdr.mjs'), ['pane', 'get', done.pane], { ok: false });
    assert.notEqual(close.status, 0, 'one real housekeeping pass left the promoted, ingested done worker open; inspect canonical workspace metadata and action log');
    assertHousekeepingActions(read(path.join(state, 'actions.jsonl')), { closedTab, keptTabs });
    await awaitScriptedExit(done, doneProcesses, { until });
    fs.appendFileSync(logFile, JSON.stringify({ action: 'scripted-worker-retired', run: done.run, processes: doneProcesses }) + '\n');
    for (const job of [blocked, human]) assertWorkerKept(job, { lane, reason: /awaits correction or disposition/ });
    return 'actual released one-pass entrypoint closed promoted done worker; blocked/needs-human panes preserved';
    } finally {
      write(configFile, originalConfig);
      git(fixture.repo, ['add', '.lane.json']); git(fixture.repo, ['commit', '-qm', 'Restore default closeout ownership']);
    }
  });
  await test(cases.release, () => {
    const script = requireCandidate('herdr/release.sh');
    const repo = path.join(root, 'release-source');
    createProductCheckout({ source: candidateSnapshot.kind === 'checkout' ? candidate : opt.source, commit: candidateCommit, destination: repo, ownedRoot: root, git });
    assert.deepEqual(productFiles(repo).sort().map(file => [file, payloadEntry(repo, file)]), productFiles(candidate).sort().map(file => [file, payloadEntry(candidate, file)]));
    // The enclosing candidate already passed its full offline gate. These tagged
    // switch fixtures run a small gate rather than replaying that whole suite.
    const packageFile = path.join(repo, 'package.json');
    const packageDoc = JSON.parse(read(packageFile));
    packageDoc.scripts['test:release'] = 'node bin/org.mjs --help';
    write(packageFile, JSON.stringify(packageDoc));
    git(repo, ['init', '-q', '-b', 'main']); git(repo, ['config', 'user.email', 'acceptance@example.invalid']); git(repo, ['config', 'user.name', 'Acceptance']);
    git(repo, ['add', '-A']); git(repo, ['commit', '-qm', 'Candidate snapshot']); git(repo, ['tag', 'candidate']);
    write(path.join(repo, 'acceptance-release-marker'), 'rollback fixture'); git(repo, ['add', '-A']); git(repo, ['commit', '-qm', 'Second scratch release']); git(repo, ['tag', 'second']);
    const home = path.join(root, 'monitor-home'), bin = path.join(root, 'release-bin'); fs.mkdirSync(bin);
    fs.symlinkSync(path.join(candidate, 'bin/org.mjs'), path.join(bin, 'org'));
    // A legacy detached watcher has no dispatch journal. Its scratch nohup
    // adapter emits its own process receipt before exec; cleanup never scans PIDs.
    write(path.join(bin, 'nohup'), `#!/bin/sh\nprintf '%s\\n' "$$" >> ${quote(path.join(root, 'legacy-watcher-pids'))}\nexec /usr/bin/nohup "$@"\n`);
    fs.chmodSync(path.join(bin, 'nohup'), 0o755);
    fs.symlinkSync(path.join(candidate, 'lanes/lane.mjs'), path.join(bin, 'lane'));
    const userHome = path.join(root, 'release-user-home'); fs.mkdirSync(userHome);
    const native = run('which', ['true']).stdout.trim();
    const extra = { HOME: userHome, ZDOTDIR: userHome, CODEX_HOME: path.join(userHome, '.codex'), CLAUDE_CONFIG_DIR: path.join(userHome, '.claude'),
      ORG_ACTOR: 'acceptance-release-install', HERDR_MONITOR_CODEX: native, HERDR_MONITOR_CLAUDE: '-',
      HERDR_MONITOR_REPO: repo, HERDR_MONITOR_HOME: home, HERDR_MONITOR_BIN: bin, HERDR_MONITOR_PLIST: path.join(root, 'absent.plist'),
      HERDR_BIN_PATH: path.join(root, 'absent-herdr') };
    const release = (...a) => run('bash', [script, ...a], { extra });
    release('build', 'candidate'); release('build', 'second'); release('activate', 'candidate');
    node(path.join(bin, 'record'), ['--help']); node(path.join(bin, 'org'), ['--help']);
    release('activate', 'second'); release('activate', 'second'); release('rollback');
    assert.equal(fs.readlinkSync(path.join(home, 'current')), path.join(home, 'releases/candidate'));
    assert.ok(!fs.existsSync(path.join(userHome, '.zshenv')));
    return 'immutable scratch releases and launcher activation and rollback checked in an isolated home';
  });
  await test(cases.defaultCycle, async () => {
    for (const file of ['dispatch/dispatch.mjs', 'watch/watch.mjs']) assert.ok(present(file), `default cycle candidate lacks ${file}`);
    requirePrerequisite(results, cases.fixture.key);
    const repo = path.join(root, 'default-cycle'); initRepo(repo);
    // Ordinary project validation, never workflow configuration.
    write(path.join(repo, 'package.json'), JSON.stringify({ private: true, scripts: { test: 'node --test' } }));
    git(repo, ['add', '.']); git(repo, ['commit', '-qm', 'Ordinary project validation']);
    for (const name of ['.org', '.lane.json', '.housekeeping.json', 'AGENTS.md']) assert.ok(!fs.existsSync(path.join(repo, name)));
    const extra = { HOME: scratchHome };
    defaultOrg = path.join(repo, '.org');
    const ask = path.join(root, 'default-cycle-ask.md'); write(ask, 'Commit one scratch file and report.\n');
    write(path.join(root, 'mode'), 'done');
    write(path.join(root, 'default-supervisor-task.json'), JSON.stringify({ repo, home: scratchHome, ask }));
    // The real PTY supervisor executes record creation and
    // dispatch, then consumes watch's notice and checks/ingests through the CLI.
    h('agent', 'prompt', supervisor.name, 'acceptance-default-cycle');
    const receipt = path.join(root, 'default-supervisor-job.json');
    await until(() => fs.existsSync(receipt), 'default supervisor dispatch receipt', 90_000);
    const saved = JSON.parse(read(receipt));
    if (saved.error) throw commandFailure(saved.error);
    const { job, info } = saved; pids.add(job.watcher.pid);
    await until(() => fs.existsSync(path.join(root, 'default-supervisor-ingest.json')), 'default supervisor ingestion receipt');
    const ingested = JSON.parse(read(path.join(root, 'default-supervisor-ingest.json')));
    if (ingested.error) throw commandFailure(ingested.error);
    assert.equal(ingested.report.outcome, 'done');
    await awaitWatcherExit(job, { until });
    const notices = inbox().split('\n').filter(Boolean).map(JSON.parse).filter((v) => v.line.includes(`[org-report] run=${job.run} `) && v.line.includes(`report=${info.report_path}`));
    assert.equal(notices.length, 1); assert.match(notices[0].line, /check=pass/);
    for (const file of ['default-supervisor-job.json', 'default-supervisor-ingest.json', 'default-supervisor-policy.txt']) fs.copyFileSync(path.join(root, file), path.join(evidence, file));
    assert.ok(!fs.existsSync(path.join(repo, '.lane.json')), 'cycle must retain discovered defaults');
    assert.ok(!fs.existsSync(path.join(repo, '.housekeeping.json')));
    const commands = configuredCommands(node, candidate, { repo, org: defaultOrg });
    const defaultLane = args => commands.lane(args, repo, { extra });
    commands.lane(['check'], info.workspace, { extra });
    promoteAndComplete(job, { lane: defaultLane, record: args => commands.record(args, { extra }) });
    const retired = await retireScriptedWorker({ ...job, info }, { h, until, retire: job => commands.retire(job, { extra }) });
    fs.appendFileSync(logFile, JSON.stringify(retired) + '\n');
    defaultLane(['close', job.lane]);
    return `${job.run}: supervisor initialized record, suggested engineer route dispatched without config, armed watch delivered exactly once, real PTY supervisor CLI check/ingest recorded done, default validation, fast-forward and record completion passed`;
  });
  await test(cases.settle, async () => {
    requireCandidate('settle/settle.mjs');
    const result = await settleCase(candidate, { load, until });
    fs.appendFileSync(logFile, JSON.stringify(result) + '\n');
    return result.detail;
  });
  await test(cases.supervisor, async () => {
    requireCandidate('supervisor/supervisor.mjs');
    const result = await supervisorCase(candidate, { load, until });
    fs.appendFileSync(logFile, JSON.stringify(result) + '\n');
    return result.detail;
  });
} catch (error) {
  if (!(error instanceof Pending)) results.push({ id: 'fatal', key: 'harness-setup', name: 'Harness setup', status: 'PENDING', origin: 'harness', detail: error.stack, evidence: logFile ? path.basename(logFile) : 'summary.json' });
} finally {
  await test(cases.cleanup, cleanupScope);
  await finishFocus();
  emitSummary();
}

}
if (isMain(import.meta.url)) await main();
