#!/usr/bin/env node
// Coordination is a foreground CLI. Only watch owns a background process.
import { ownerAlive } from '../lib/process-owner.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseArgs } from '../lib/cli-help.mjs';
import { loadDiscoveredRoutes, resolveRoute, resolveLaunchRoute } from '../lanes/routes.mjs';
import { findOrgDir } from '../lib/store.mjs';
import { waitForMemory } from '../lib/memory.mjs';
import { readTiming, timedMemoryWait, timingMetadata } from '../lib/run-timing.mjs';
import { gitProject } from '../lib/project.mjs';
import { hookReviewDialog, codexProfile } from './hook-review.mjs';

const local = (file) => fileURLToPath(new URL(file, import.meta.url));
const { values: opt, positionals } = parseArgs({ usage: "Usage: node dispatch/dispatch.mjs ITEM --lane TOPIC --route ROUTE --brief FILE [OPTIONS] | --retry R-n|JOURNAL | --status R-n|JOURNAL", allowPositionals: true, options: {
  repo: { type: 'string', default: process.cwd() }, org: { type: 'string', default: process.env.ORG_DIR },
  lane: { type: 'string' }, route: { type: 'string' }, brief: { type: 'string' }, report: { type: 'string' },
  serves: { type: 'string' }, awaited: { type: 'boolean' }, 'awaited-step': { type: 'string' },
  to: { type: 'string', default: process.env.MONITOR_SUPERVISOR_AGENT || 'supervisor-herdr' }, base: { type: 'string' }, extra: { type: 'string' },
  reuse: { type: 'string' }, retry: { type: 'string' }, status: { type: 'string' },
  adopt: { type: 'string' }, fresh: { type: 'boolean' }, resend: { type: 'boolean' },
  'accept-delivered': { type: 'boolean' }, 'recover-run': { type: 'string' },
  'from-run': { type: 'string' },
  'org-cli': { type: 'string' }, 'lane-cli': { type: 'string' }, 'watch-cli': { type: 'string' },
}});
const cli = (name, fallback) => opt[`${name}-cli`] ? [opt[`${name}-cli`]] : [process.execPath, local(fallback)];
const recordCLI = cli('org', '../bin/org.mjs');
const laneCLI = cli('lane', '../lanes/lane.mjs');
const watchCLI = cli('watch', '../watch/watch.mjs');
let job, journal, lock, contender, ownsLock = false;
const atomic = (file, value) => {
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temp, file);
};
const save = () => atomic(journal, job);
function command(argv, args, cwd = job?.repo ?? path.resolve(opt.repo)) {
  const result = spawnSync(argv[0], [...argv.slice(1), ...args], {
    cwd, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024,
    env: { ...process.env, ORG_DIR: job?.org ?? opt.org },
  });
  if (result.error || result.status !== 0) {
    const error = new Error(`${argv[0]} ${args[0]}: ${(result.stderr || result.stdout || result.error?.message || `exit ${result.status}`).trim()}`);
    error.recordRefusal = !result.error && !result.signal && result.status === 1 &&
      result.stderr.trim().split('\n').at(-1).startsWith('record: ');
    throw error;
  }
  return result.stdout.trim();
}
const record = (args) => command(recordCLI, args);
const lane = (args) => command(laneCLI, args);
const git = (args, cwd) => command(['git'], args, cwd);
const json = (text) => { const value = JSON.parse(text); if (value.error) throw new Error(JSON.stringify(value.error)); return value.result ?? value; };
const herdr = (args) => json(command(['herdr'], args));
const note = (text) => record(['note', job.run, `Dispatch: ${text}`]);
let dispatchWaits;
function timingFailure(phase) {
  // Missing telemetry is visible without persisting arbitrary errors or making
  // the record CLI (or even this diagnostic write) a dispatch prerequisite.
  job.timing_missing = (job.timing_missing ?? 0) + 1;
  try { save(); } catch {}
  try { process.stderr.write(`dispatch: run timing ${phase} failed; continuing with missing data\n`); } catch {}
}
function syncTiming() {
  if (!job.run) return;
  try {
    const value = timingMetadata(readTiming(journal).filter(e => e.kind !== 'process_end'), job.run);
    if (value === dispatchWaits) return;
    record(['set', job.run, `dispatch_waits=${value}`]);
    dispatchWaits = value;
  } catch { timingFailure('sync'); }
}
function memoryGate(kind, label, check) {
  return timedMemoryWait({ journal, run: job.run, item: job.item, lane: job.lane, kind,
    wait: () => waitForMemory({ label, check }), persist: syncTiming, onError: timingFailure });
}
function locate(value) {
  if (!/^R-\d+$/.test(value)) return path.resolve(value);
  const run = json(record(['show', value, '--json']));
  if (!run.meta?.dispatch_journal) throw new Error(`${value} has no dispatch journal`);
  return run.meta.dispatch_journal;
}
function worktree() {
  const entries = git(['worktree', 'list', '--porcelain']).split('\n\n');
  const entry = entries.find((text) => text.split('\n').includes(`branch refs/heads/lane/${job.lane}`));
  return entry?.split('\n').find((line) => line.startsWith('worktree '))?.slice(9);
}
function liveWorker(worker) {
  lane(['verify-agent', worker.agentName, job.workspace]);
  const agent = herdr(['agent', 'get', worker.agentName]).agent;
  if (!agent || agent.pane_id !== worker.pane || agent.workspace_id !== worker.workspaceId ||
      (worker.terminalId && agent.terminal_id !== worker.terminalId) ||
      (worker.agentSessionId && agent.agent_session?.value !== worker.agentSessionId)) {
    throw new Error('worker occupant identity changed; inspect it before recovery');
  }
  return agent;
}
function capture(name) {
  lane(['verify-agent', name, job.workspace]);
  const agent = herdr(['agent', 'get', name]).agent;
  if (!agent?.pane_id || !agent.workspace_id) throw new Error('agent has no pane/workspace identity');
  return { agentName: name, pane: agent.pane_id, workspaceId: agent.workspace_id,
    terminalId: agent.terminal_id ?? null, agentSessionId: agent.agent_session?.value ?? null, cwd: job.workspace };
}
function lockJob() {
  lock = `${journal}.lock`;
  // Publish a unique contender before inspecting any owner. Every later contender
  // sees this live PID and refuses; stale cleanup can never delete a new owner's
  // contender. This also serializes takeover of the original single-file lock.
  const directory = `${lock}s`;
  fs.mkdirSync(directory, { recursive: true });
  contender = path.join(directory, `${process.pid}-${randomUUID()}`);
  fs.writeFileSync(contender, '', { flag: 'wx', mode: 0o600 });
  for (const entry of fs.readdirSync(directory)) {
    const file = path.join(directory, entry);
    if (file === contender) continue;
    const pid = Number(entry.split('-')[0]);
    if (!Number.isInteger(pid) || pid < 1) throw new Error('invalid dispatch lock owner; inspect request locks');
    try { process.kill(pid, 0); throw new Error(`dispatch is already running (pid ${pid})`); }
    catch (error) { if (error.code !== 'ESRCH') throw error; }
    try { fs.unlinkSync(file); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  try {
    const pid = Number(fs.readFileSync(lock, 'utf8'));
    if (!Number.isInteger(pid) || pid < 1) throw new Error('invalid dispatch lock owner; inspect request lock');
    try { process.kill(pid, 0); throw new Error(`dispatch is already running (pid ${pid})`); }
    catch (error) { if (error.code !== 'ESRCH') throw error; }
    fs.unlinkSync(lock);
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  fs.writeFileSync(lock, String(process.pid), { flag: 'wx', mode: 0o600 });
  ownsLock = true;
}
async function main() {
  if (!positionals.length && !opt.retry && !opt.status) {
    process.stdout.write(`dispatch ITEM --lane TOPIC --route ROUTE --brief FILE --report FILE [--org DIR] [--serves P-n] [--awaited [--awaited-step TEXT]]\nRecord is discovered from the canonical project. Routes carry a suggested preset; ask the operator before adopting it.\nUse discovery/adapters/codex.mjs for project entry; workers report, watch validates and ingests, then lane check/promote fast-forward without push. Only the canonical supervisor starts housekeeping.\n`);
    return;
  }
  opt.org ??= findOrgDir({ cwd: opt.repo });
  if (!opt.org) throw new Error('--org DIR or ORG_DIR is required');
  if (opt['awaited-step'] !== undefined && (!opt.awaited || !opt['awaited-step'].trim())) throw new Error('--awaited-step requires --awaited and nonempty text');
  if ((opt.adopt && opt.fresh) || (opt.resend && opt['accept-delivered'])) throw new Error('choose one launch recovery and one delivery recovery');
  if (opt.status) {
    journal = locate(opt.status);
    process.stdout.write(`${fs.readFileSync(journal, 'utf8')}\n`);
    return;
  }
  if (opt.retry) {
    if (positionals.length || ['lane', 'route', 'brief', 'report', 'reuse', 'base', 'extra', 'serves', 'awaited', 'awaited-step'].some((key) => opt[key] !== undefined)) {
      throw new Error('--retry uses the saved request; do not supply new work flags');
    }
    journal = locate(opt.retry);
    lockJob();
    const saved = JSON.parse(fs.readFileSync(journal, 'utf8'));
    if (saved.org !== fs.realpathSync(opt.org)) throw new Error('retry belongs to a different record');
    job = saved;
    if (opt['from-run'] !== undefined) {
      if (job.fromRun && job.fromRun !== opt['from-run']) throw new Error('--from-run cannot replace the saved origin');
      const origin = json(record(['show', opt['from-run'], '--json']));
      if (!/^R-\d+$/.test(opt['from-run']) || origin.item !== job.item) throw new Error('--from-run must name a run on the dispatched item');
      job.fromRun = opt['from-run'];
    }
  } else {
    if (opt.adopt || opt.fresh || opt.resend || opt['accept-delivered'] || opt['recover-run']) throw new Error('recovery flags require --retry');
    if (positionals.length !== 1 || !opt.lane || !opt.route || !opt.brief) throw new Error('usage: dispatch.mjs ITEM --org DIR --lane TOPIC --route ROUTE --brief FILE [--report FILE] [--to AGENT] [--base REF] [--reuse R-n] [--extra TEXT] | --retry R-n|JOURNAL | --status R-n|JOURNAL');
    if (!/^[a-z0-9][a-z0-9-]{1,60}$/.test(opt.lane)) throw new Error('lane must be short kebab-case');
    const repo = fs.realpathSync(path.resolve(opt.repo));
    const org = fs.realpathSync(path.resolve(opt.org));
    const brief = fs.realpathSync(path.resolve(opt.brief));
    if (!fs.statSync(brief).isFile() || !fs.readFileSync(brief, 'utf8').trim()) throw new Error('brief must be a nonempty file');
    // Validate item, target and launch route before opening a lane or starting a run.
    const item = json(record(['show', positionals[0], '--json']));
    if (Object.hasOwn(item, 'item') || !Array.isArray(item.runs)) throw new Error('dispatch ITEM must be an item, not a run');
    if (opt.serves) {
      const priorities = json(record(['priorities', '--json']));
      if (!priorities.priorities.some(p => p.id === opt.serves)) throw new Error(`unknown priority ${opt.serves}`);
    }
    if (opt['from-run'] !== undefined) {
      const origin = json(record(['show', opt['from-run'], '--json']));
      if (!/^R-\d+$/.test(opt['from-run']) || origin.item !== item.id) throw new Error('--from-run must name a run on the dispatched item');
    }
    if (opt.reuse) {
      const prior = json(record(['show', opt.reuse, '--json']));
      if (!prior.report && !prior.abandoned) throw new Error('reuse run must be reported or abandoned; finish the previous run first');
    }
    herdr(['agent', 'get', opt.to]);
    const { config } = loadDiscoveredRoutes({ cwd: repo });
    const declared = resolveRoute(config, { route: opt.route });
    resolveLaunchRoute(config, { route: opt.route });
    const common = fs.realpathSync(git(['rev-parse', '--path-format=absolute', '--git-common-dir'], repo));
    const token = randomUUID();
    const directory = path.join(org, 'dispatch');
    fs.mkdirSync(directory, { recursive: true });
    journal = path.join(directory, `${token}.json`);
    job = { token, repo, org, common, item: positionals[0], lane: opt.lane, route: opt.route,
      brief, report: opt.report ?? null, to: opt.to, serves: opt.serves,
      base: opt.base ?? null, extra: opt.extra ?? '', reuse: opt.reuse ?? null, fromRun: opt['from-run'] ?? null,
      declared: { harness: declared.kind, model: declared.model ?? null, effort: declared.effort ?? null },
      stage: 'open', run: null };
    // Only routing fields are frozen. Lifecycle paths keep their original config provenance.
    job.routeConfig = path.join(directory, `${token}.routes.json`);
    atomic(job.routeConfig, config);
    if (opt.awaited) record(['set', job.item, 'meta.notify=supervisor', ...(opt['awaited-step'] ? [`meta.notify_step=${opt['awaited-step']}`] : [])]);
    save();
    lockJob();
  }
  const common = fs.realpathSync(git(['rev-parse', '--path-format=absolute', '--git-common-dir']));
  if (common !== job.common) throw new Error('repository common-directory identity changed');
  const stop = path.join(gitProject(job.repo).canonical, '.lane/supervisor/STOP');
  const checkStop = () => {
    if (fs.existsSync(stop)) {
      const error = new Error('Supervisor STOP appeared before dispatch; no new worker launched');
      error.code = 'DISPATCH_STOPPED';
      throw error;
    }
  };
  if (opt['recover-run']) {
    const run = json(record(['show', opt['recover-run'], '--json']));
    if (job.run || run.item !== job.item || run.meta?.dispatch_journal !== journal) throw new Error('recovery run does not belong to this request');
    job.run = run.id; job.stage = 'worker'; save();
  }
  if (job.stage === 'open') {
    memoryGate('memory_open', 'dispatch', checkStop);
    if (!worktree()) lane(['open', job.lane, ...(job.base ? [job.base] : []), '--git-only']);
    job.workspace = fs.realpathSync(worktree());
    // prepare validates that the registered lane is owned by this repository.
    lane(['prepare', job.lane]);
    if (job.base) {
      if (git(['status', '--porcelain=v1'], job.workspace)) throw new Error('base fast-forward requires a clean lane');
      git(['merge', '--ff-only', '--no-edit', '--', job.base], job.workspace);
    }
    job.stage = 'start'; save();
  }
  if (job.stage === 'starting') {
    const item = json(record(['show', job.item, '--json']));
    const matches = item.runs.map((id) => json(record(['show', id, '--json'])))
      .filter((run) => run.meta?.dispatch_journal === journal);
    if (matches.length === 1) {
      job.run = matches[0].id; job.stage = 'worker'; save();
    } else if (matches.length === 0 && job.startRefused) {
      job.stage = 'start'; save();
    } else {
      throw new Error('record start outcome is unknown or has multiple matches; inspect record and use --recover-run R-n');
    }
  }
  if (job.stage === 'start') {
    delete job.startRefused;
    job.stage = 'starting'; save();
    let output;
    try { output = record(['start', job.item, '--route', job.route, '--route-config', job.routeConfig,
      '--workspace', job.workspace, '--meta', `lane=${job.lane}`, '--meta', `dispatch_journal=${journal}`,
      ...(job.serves !== undefined ? [`--serves=${job.serves}`] : []),
      ...(job.fromRun ? ['--if-current-run', job.fromRun] : []),
      ...(job.report ? ['--report', path.resolve(job.workspace, job.report)] : [])]); }
    catch (error) { job.startRefused = error.recordRefusal === true; save(); throw error; }
    job.run = output.match(/^(R-\d+) started/m)?.[1];
    if (!job.run) throw new Error('record start returned no run id; inspect record before retry');
    job.stage = 'worker'; save();
    note(`run started; request ${journal}`);
  }
  const run = json(record(['show', job.run, '--json']));
  if (run.abandoned || run.report) throw new Error('run is already abandoned or reported; start a new run');
  if (run.item !== job.item || run.meta?.dispatch_journal !== journal || fs.realpathSync(run.workspace) !== job.workspace) throw new Error('run no longer matches dispatch request');
  if (run.meta?.route !== job.route || Object.entries(job.declared).some(([key, value]) => (run.meta?.[key] ?? null) !== value)) throw new Error('run routing metadata changed; inspect before recovery');
  if (job.serves !== undefined && (run.meta?.serves ?? null) !== (job.serves || null)) throw new Error('run priority alignment changed; inspect before recovery');
  dispatchWaits = run.meta?.dispatch_waits;
  syncTiming();
  // start may have committed the run before failing to materialize its brief.
  // The existing record command recreates a missing brief from durable context.
  if (!fs.existsSync(run.brief_path)) record(['brief', job.run]);
  if (job.stage === 'launching') {
    if (opt.fresh) {
      job.stage = 'worker'; save();
      note('caller requested a fresh launch after inspecting the uncertain prior attempt');
    } else {
      if (!opt.adopt) throw new Error('worker launch outcome is unknown; inspect lane, then use --adopt AGENT or --fresh (never auto-relaunch)');
      job.worker = capture(opt.adopt); job.stage = 'record-worker'; save();
      note(`caller adopted worker ${opt.adopt} after uncertain launch`);
    }
  }
  if (job.stage === 'worker') {
    memoryGate('memory_worker', 'dispatch worker', checkStop);
    if (job.reuse) {
      const prior = json(record(['show', job.reuse, '--json']));
      if (!prior.report && !prior.abandoned) throw new Error('reuse run must be reported or abandoned; finish the previous run first');
      if (prior.item !== job.item || prior.meta?.lane !== job.lane || prior.meta?.route !== job.route ||
          fs.realpathSync(prior.workspace) !== job.workspace ||
          Object.entries(job.declared).some(([key, value]) => (prior.meta?.[key] ?? null) !== value)) throw new Error('reuse run must match item, lane, route and declared harness/model/effort; use a fresh worker');
      if (!prior.meta.agent_session_id && !prior.meta.terminal_id) throw new Error('reuse needs recorded occupant identity; use a fresh worker');
      job.worker = { agentName: prior.meta.agent, pane: prior.meta.pane, workspaceId: prior.meta.worker_workspace,
        terminalId: prior.meta.terminal_id, agentSessionId: prior.meta.agent_session_id };
      const agent = liveWorker(job.worker);
      if (!['idle', 'done'].includes(agent.agent_status)) throw new Error('reuse worker must be idle or done');
    } else {
      job.stage = 'launching'; save();
      const output = lane(['dispatch', job.lane, '--route', job.route, '--route-config', job.routeConfig, '--json', '--memory-checked']);
      const launched = JSON.parse(output);
      if (launched.result === 'stopped') {
        job.stage = 'worker'; save();
        const error = new Error(launched.reason);
        error.code = 'DISPATCH_STOPPED';
        throw error;
      }
      job.worker = json(output);
    }
    job.stage = 'record-worker'; save();
  }
  if (job.stage === 'record-worker') {
    liveWorker(job.worker);
    const worker = job.worker;
    record(['worker', job.run, '--agent', worker.agentName, '--pane', worker.pane,
      '--worker-workspace', worker.workspaceId, '--cwd', job.workspace,
      ...(worker.agentSessionId ? ['--agent-session-id', worker.agentSessionId] : []),
      ...(worker.terminalId ? ['--terminal-id', worker.terminalId] : [])]);
    note(`worker ${worker.agentName} in ${worker.pane} recorded; prompt not sent`);
    job.stage = 'watch'; save();
  }
  if (job.stage === 'watch' || job.stage === 'prompting' || job.stage === 'prompt' || job.stage === 'complete') {
    liveWorker(job.worker);
    // Re-arm only through watch's exclusive per-run lock. It refuses duplicates.
    if (!job.watcher) {
      job.watcher = json(command(watchCLI, [job.run, '--org', job.org, '--to', job.to,
        '--cwd', job.repo, '--detach', '--log', path.join(job.org, 'dispatch', `${job.run}.watch.log`),
        ...(opt['org-cli'] ? ['--org-cli', opt['org-cli']] : [])]));
      save();
    } else {
      if (!ownerAlive(job.watcher)) {
        job.watcher = null; save();
        throw new Error('watcher stopped; retry to re-arm it without replaying the prompt');
      }
    }
    if (!Number.isInteger(job.watcher.pid) || job.watcher.pid < 1) throw new Error('watcher returned an invalid PID');
    if (!ownerAlive(job.watcher)) throw new Error('watcher stopped before its receipt was recorded');
    record(['set', job.run, `watcher_pid=${job.watcher.pid}`, `watcher_identity=${job.watcher.identity}`, `watcher_log=${job.watcher.log}`]);
    if (job.stage === 'watch') note(`watcher ready (pid ${job.watcher.pid}); prompt not sent`);
    if (job.stage === 'watch') { job.stage = 'prompt'; save(); }
    if (job.stage === 'prompting' && opt['accept-delivered']) {
      job.stage = 'complete'; save();
      note('caller confirmed the uncertain prompt was delivered; no resend');
    }
    if (job.stage === 'prompting' && !opt.resend) throw new Error('prompt delivery outcome is unknown; inspect worker, then --accept-delivered or --resend only if delivery did not land');
    if (job.stage === 'prompt' || (job.stage === 'prompting' && opt.resend)) {
      liveWorker(job.worker);
      if (job.declared.harness === 'codex') {
        const screen = command(['herdr'], ['pane', 'read', job.worker.pane, '--source', 'visible', '--format', 'text']);
        const dialog = hookReviewDialog(screen);
        if (dialog) {
          const launch = resolveLaunchRoute(JSON.parse(fs.readFileSync(job.routeConfig, 'utf8')), { route: job.route });
          const profile = codexProfile(launch.args);
          const scope = profile ? `profile ${JSON.stringify(profile)} (-p ${JSON.stringify(profile)})`
            : 'the configured default profile (no -p/--profile in the saved route)';
          const error = new Error(`Codex hook-review dialog "${dialog}" blocks worker ${job.worker.agentName} in ${job.worker.pane}, ${scope}; brief not sent. Open /hooks in that worker session and review the hooks in that profile, then retry with --retry ${job.run}. Hook trust is the operator's decision.`);
          error.code = 'DISPATCH_HOOK_REVIEW';
          throw error;
        }
      }
      const prompt = `You are run ${job.run} on org item ${job.item}. Read ${job.brief} (the ask) and ${run.brief_path} (the record context and report template), then do the work. Write the report to ${run.report_path}; the report's run field is ${job.run}.${job.extra ? `\n\n${job.extra}` : ''}`;
      job.stage = 'prompting'; save();
      herdr(['agent', 'prompt', job.worker.agentName, prompt]);
      job.stage = 'complete'; save();
      note(`prompt sent; worker ${job.worker.agentName} and watcher ${job.watcher.pid} started`);
    }
  }
  delete job.error; save();
  process.stdout.write(`${JSON.stringify({ run: job.run, item: job.item, lane: job.lane, route: job.route, serves: run.meta?.serves ?? null, ...job.declared,
    agent: job.worker.agentName, pane: job.worker.pane, watcher: job.watcher, journal })}\n`);
}
try { await main(); }
catch (error) {
  if (job && journal && ownsLock) {
    job.error = error.message; save();
    if (job.run) try { note(`incomplete at ${job.stage}: ${error.message}; retry with --retry ${job.run}`); } catch {}
  }
  process.stderr.write(`dispatch: ${error.message}${journal ? `\nrequest: ${journal}` : ''}\n`);
  if (error.code === 'DISPATCH_STOPPED') {
    process.stdout.write(`${JSON.stringify({ result: 'stopped', run: job.run, item: job.item, lane: job.lane,
      reason: error.message, stage: job.stage, journal })}\n`);
  } else if (error.code === 'DISPATCH_HOOK_REVIEW') {
    process.stdout.write(`${JSON.stringify({ result: 'blocked', code: error.code, run: job.run, item: job.item,
      agent: job.worker.agentName, pane: job.worker.pane, reason: error.message, stage: job.stage, journal })}\n`);
    process.exitCode = 1;
  } else {
    // Coordinators inherit stderr for live waits; retain failure evidence on
    // their captured stdout as well, including failures before a journal exists.
    process.stdout.write(`${JSON.stringify({ result: 'failed', reason: error.message, journal })}\n`);
    process.exitCode = 1;
  }
} finally {
  if (ownsLock) try { if (fs.readFileSync(lock, 'utf8') === String(process.pid)) fs.unlinkSync(lock); } catch {}
  if (contender) try { fs.unlinkSync(contender); } catch {}
}
