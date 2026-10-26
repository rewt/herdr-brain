#!/usr/bin/env node
// One model-free pass. launchd supplies the schedule, existing CLIs own effects.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { gitProject } from '../lib/project.mjs';
import { findOrgDir, loadEvents, writeFileAtomic } from '../lib/store.mjs';
import { fold, itemStatus, sortItems } from '../lib/state.mjs';
import { effectiveWorkerIdentity, workerReceipt } from '../lib/worker-identity.mjs';
import { readOwnedRun, requireController } from '../lib/run-owner.mjs';
import { loadDiscoveredRoutes, resolveLaunchRoute, selectRoute } from '../lanes/routes.mjs';
import { checkSessionCap } from '../dispatch/session-cap.mjs';
import { checkUnlandedCap } from '../dispatch/unlanded-cap.mjs';
import { noticeLock } from '../supervisor/notice-lock.mjs';
import { enqueueSupervisor } from '../supervisor/prompt-supervisor.mjs';
import { readCloseoutEntries } from '../lib/closeout.mjs';
import { parseArgs, isMain } from '../lib/cli-help.mjs';

export const sourceRoot = fileURLToPath(new URL('../', import.meta.url));
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const read = file => {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (e) { if (e.code === 'ENOENT') return null; throw e; }
};
const files = directory => {
  try { return fs.readdirSync(directory).filter(f => f.endsWith('.json')).map(f => read(path.join(directory, f))); }
  catch (e) { if (e.code === 'ENOENT') return []; throw e; }
};
export const serviceDirectory = (org, identity) => path.join(org, 'line-service', digest(identity).slice(0, 20));
export function reserved(item) {
  return item.role === 'human' || item.meta.operator_reserved || item.meta.reserved ||
    ['security', 'funds-and-chain', 'publish', 'delete-data', 'licensing', 'priorities'].includes(item.meta.category);
}
export function routeFor(item, config) {
  const task = { engineer: 'implementation', architect: 'planning', reviewer: 'review', writer: 'writing', researcher: 'research' }[item.role];
  const route = item.meta.route ?? (config.routes?.[item.role] ? item.role : selectRoute(config, item.capability ?? task));
  resolveLaunchRoute(config, { route });
  return route;
}

// Any attempt, including an uncertain one, spends the automatic review launch.
export function reviewAttempt(item, { org, identity, events }) {
  const runs = new Set(item.runs);
  if (events.some(e => e.type === 'review.verdict' && e.common === identity && runs.has(e.run))) return 'recorded verdict';
  for (const id of runs) if (read(path.join(org, 'settle', `${id}.json`)) || read(path.join(org, 'settle', `${id}.review-launch.json`))) return `existing settle ${id}`;
  if (files(path.join(org, 'retirement/occupants')).some(r => r?.kind === 'settle' && r.common === identity && runs.has(r.run))) return 'existing native reviewer';
  if (files(path.join(org, 'retirement/reviews')).some(r => r?.common === identity && runs.has(r.run))) return 'existing review receipt';
  return null;
}

export function createLineService({ repo, org, to, herdr = 'herdr', env = process.env, command = spawnSync,
  notify = enqueueSupervisor, capacity, now = () => new Date().toISOString() }) {
  const project = gitProject(repo);
  if (project.checkout !== project.canonical) throw Error('line service requires the canonical project checkout');
  repo = project.canonical;
  const discovered = findOrgDir({ cwd: repo, env: { ...env, ORG_DIR: '' } });
  org = fs.realpathSync(org ?? discovered);
  if (!discovered || fs.realpathSync(discovered) !== org) throw Error('line-service record differs from the project record');
  if (typeof to !== 'string' || !/^[a-z][a-z0-9_-]{0,31}$/.test(to)) throw Error('name the actual project supervisor or brain-chat recipient with --to');
  const directory = serviceDirectory(org, project.identity), journal = path.join(directory, 'effects.json');
  fs.mkdirSync(directory, { recursive: true });
  const log = row => {
    const fd = fs.openSync(path.join(directory, 'passes.jsonl'), 'a', 0o600);
    try { fs.writeFileSync(fd, JSON.stringify({ at: now(), ...row }) + '\n'); fs.fsyncSync(fd); }
    finally { fs.closeSync(fd); }
  };
  const childEnv = { ...env, ORG_DIR: org, HERDR_BRAIN_ROOT: sourceRoot, MONITOR_SUPERVISOR_AGENT: to };
  // A launchd controller has no pane/session identity. Never inherit an installer's.
  for (const key of Object.keys(childEnv)) if (/^(HERDR_(ENV|PANE_ID|TAB_ID|WORKSPACE_ID)|CODEX_(SESSION_ID|THREAD_ID)|GIT_.*|LANE_CONFIG)$/.test(key)) delete childEnv[key];
  const invoke = (exe, args) => {
    const r = command(exe, args, { cwd: repo, env: childEnv, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
    if (r.error || r.status !== 0) throw Object.assign(Error((r.stderr || r.stdout || r.error?.message || `exit ${r.status}`).trim()), { receipt: { status: r.status, signal: r.signal, stdout: r.stdout, stderr: r.stderr } });
    return r.stdout?.trim() ?? '';
  };
  const native = args => JSON.parse(invoke(herdr, args)).result;
  const cli = (file, args) => invoke(process.execPath, [path.join(sourceRoot, file), ...args]);
  const observe = () => {
    const live = gitProject(repo);
    if (live.identity !== project.identity || live.canonical !== repo) throw Error('project identity changed');
    if (fs.existsSync(path.join(directory, 'STOP')) || fs.existsSync(path.join(repo, '.lane/supervisor/STOP')) || fs.existsSync(path.join(repo, '.lane/supervisor/HOLD'))) throw Error('STOP/HOLD prevents line-service effects');
    const loaded = loadEvents(org);
    if (loaded.tornTail) throw Error('incomplete record tail');
    return { ...loaded, state: fold(loaded.events) };
  };
  const guardRun = (id, { reported = true } = {}) => {
    const snapshot = observe(), run = snapshot.state.runs.get(id), item = run && snapshot.state.items.get(run.item);
    if (!run || run.abandoned || !item || item.runs.at(-1) !== id) throw Error('unknown, abandoned or superseded run');
    requireController(readOwnedRun(org, id), 'brain');
    if (gitProject(run.workspace).identity !== project.identity) throw Error('foreign run workspace');
    if (reported && !run.report) throw Error('report not ingested');
    return { ...snapshot, run, item };
  };
  function pass() {
    const release = noticeLock(path.join(directory, 'pass.lock'));
    let effects;
    try {
      effects = read(journal) ?? { identity: project.identity, org, actions: {}, notices: {} };
      if (effects.identity !== project.identity || effects.org !== org) throw Error('effect journal project binding changed');
      const save = () => writeFileAtomic(journal, JSON.stringify(effects, null, 2) + '\n', 0o600);
      const note = (boundary, reason) => {
        const key = digest([boundary, reason]);
        log({ action: 'hold', boundary, reason });
        if (effects.notices[key]) return;
        // Persist intent before native inbox enqueue. Lost replies never replay an effect.
        effects.notices[key] = { at: now(), reason, state: 'sending' }; save();
        try {
          effects.notices[key] = { ...effects.notices[key], state: 'queued', ...notify(to,
            `[line-service] ${boundary}: ${reason}. Evidence ${journal}`, { cwd: repo, org, herdr, id: `line-${key}` }) }; save();
        } catch (e) { effects.notices[key].error = e.message; save(); log({ action: 'notice-failed', error: e.message }); }
      };
      const effect = (key, run) => {
        if (effects.actions[key]) {
          const prior = effects.actions[key];
          log({ action: 'effect-retained', key, state: prior.state });
          if (prior.state !== 'complete') note(key, 'prior failed/uncertain effect retained; inspect its existing receipt, do not replay');
          return;
        }
        observe();
        const entry = effects.actions[key] = { state: 'started', at: now() }; save();
        try {
          entry.result = run(); entry.state = 'complete';
          if (['escalate', 'failed', 'stopped', 'judge_promotion'].includes(entry.result?.result)) {
            entry.state = 'held'; entry.error = entry.result.reason ?? entry.result.result;
          }
          const deferred = entry.result?.evaluated?.filter(row => !row.completed);
          if (deferred?.length) { entry.state = 'held'; entry.error = deferred.map(row => `${row.run}: ${row.reason}`).join('; '); }
        }
        catch (e) { entry.state = 'held'; entry.error = e.message; entry.receipt = e.receipt; }
        entry.finished_at = now(); save(); log({ action: 'effect', key, ...entry });
        if (entry.state === 'held') note(key, entry.error);
        return entry;
      };
      log({ action: 'pass-start', pid: process.pid, identity: project.identity, source: sourceRoot });
      let snapshot;
      try { snapshot = observe(); } catch (e) { log({ action: 'pass-held', reason: e.message }); return { held: e.message, directory }; }
      for (const run of snapshot.state.runs.values()) {
        if (run.abandoned || run.report || !run.workspace || !run.report_path || !fs.existsSync(run.report_path)) continue;
        const item = snapshot.state.items.get(run.item);
        if (item?.runs.at(-1) !== run.id) continue;
        try {
          if (gitProject(run.workspace).identity !== project.identity) continue;
          if (effects.actions[`ingest:${run.id}`]) continue;
          const bound = guardRun(run.id, { reported: false }), w = effectiveWorkerIdentity(bound.run, bound.state), receipt = workerReceipt(bound.run, bound.state);
          if (!receipt || w.identity_conflict || !w.agent || !w.terminal_id || ['agent', 'pane', 'worker_workspace', 'terminal_id'].some(k => receipt[k] !== w[k])) throw Error('native worker receipt missing or conflicted');
          const a = native(['agent', 'get', w.agent])?.agent;
          if (!a || a.name !== w.agent || a.pane_id !== w.pane || a.workspace_id !== w.worker_workspace || a.terminal_id !== w.terminal_id ||
              (w.agent_session_id && a.agent_session?.value !== w.agent_session_id) || fs.realpathSync(a.cwd) !== fs.realpathSync(run.workspace)) throw Error('native worker identity differs from its recorded receipt');
          if (!['idle', 'done'].includes(a.agent_status)) { log({ action: 'report-in-flight', run: run.id }); continue; }
          effect(`ingest:${run.id}`, () => { guardRun(run.id, { reported: false }); return cli('bin/org.mjs', ['ingest', run.report_path, '--run', run.id, '--if-current-run', run.id]); });
        } catch (e) { note(`intake:${run.id}`, e.message); }
      }
      snapshot = observe();
      for (const item of snapshot.state.items.values()) {
        const run = snapshot.state.runs.get(item.runs.at(-1));
        if (!run?.report || run.abandoned || !run.workspace) continue;
        try {
          if (gitProject(run.workspace).identity !== project.identity) continue;
          if (run.report.outcome !== 'done' || run.report.blockers?.length || (run.report.questions ?? run.report.extra?.questions)?.length) note(`report:${run.id}:${run.report.sha256}`, 'worker report needs supervisor judgment');
          const attempt = reviewAttempt(item, { org, identity: project.identity, events: snapshot.events });
          if (attempt) { log({ action: 'review-retained', item: item.id, reason: attempt }); continue; }
          if (reserved(item) || item.meta.hold || item.meta.held) { note(`review:${item.id}`, 'held or reserved item needs judgment'); continue; }
          effect(`review:${item.id}`, () => {
            guardRun(run.id);
            const fresh = observe();
            const existing = reviewAttempt(fresh.state.items.get(item.id), { org, identity: project.identity, events: fresh.events });
            if (existing) return { retained: existing };
            return JSON.parse(cli('supervisor/supervisor.mjs', ['handle', run.id, '--repo', repo, '--org', org, '--role', 'supervisor', '--to', run.meta.agent ?? to, '--timeout', '0']));
          });
        } catch (e) { note(`review:${item.id}`, e.message); }
      }
      try {
        const entries = readCloseoutEntries(project.identity).filter(e => e.org === org && e.project === repo);
        if (entries.length) {
          const revisions = observe().events.filter(e => ['closeout.retry', 'closeout.handoff', 'closeout.code-handoff', 'closeout.migrated'].includes(e.type)).at(-1)?.seq;
          effect(`closeout:${digest([entries, revisions])}`, () => JSON.parse(cli('supervisor/closeout.mjs', ['drain', '--repo', repo, '--org', org, '--no-restart'])));
        }
      } catch (e) { note('closeout', e.message); }
      // Failed cleanup/review never prevents considering independent ready work.
      snapshot = observe();
      const { config } = loadDiscoveredRoutes({ cwd: repo, env: childEnv });
      for (const item of sortItems(snapshot.state.items.values())) {
        if (item.kind === 'goal' || item.closed || itemStatus(snapshot.state, item.id) !== 'ready') continue;
        if (reserved(item) || item.meta.hold || item.meta.held) { note(`dispatch:${item.id}`, 'held or reserved ready item needs judgment'); continue; }
        try {
          const key = `dispatch:${item.id}:${item.runs.at(-1) ?? item.created.seq}`;
          if (effects.actions[key]) { log({ action: 'dispatch-retained', key, state: effects.actions[key].state }); continue; }
          const route = routeFor(item, config);
          const count = capacity ?? (() => checkSessionCap({ config, org, common: project.identity,
            agent: name => native(['agent', 'get', name]).agent,
            processInfo: pane => native(['pane', 'process-info', '--pane', pane]).process_info }));
          const occupancy = count(); log({ action: 'capacity', ...occupancy });
          checkUnlandedCap({ config, org, common: project.identity, request: { item: item.id } });
          const dispatched = effect(key, () => {
            const fresh = observe(), current = fresh.state.items.get(item.id);
            if (!current || current.closed || itemStatus(fresh.state, item.id) !== 'ready' || reserved(current) || current.meta.hold || current.meta.held || routeFor(current, config) !== route) throw Error('dispatch readiness or route changed');
            const brief = path.join(directory, `${digest(key)}.ask.md`);
            writeFileAtomic(brief, `# ${current.title}\n\n${current.accept.join('\n')}\n\nWork from the existing item/run brief and accepted directions. Self-land OWN source; one async independent post-code review, zero reviewer suites. Preserve STOP/HOLD, claims and native guards. Escalate judgment to ${to} through the existing native inbox.\n`, 0o600);
            return JSON.parse(cli('dispatch/dispatch.mjs', [item.id, '--repo', repo, '--org', org, '--lane', `line-${item.id.toLowerCase()}-${current.runs.length + 1}`, '--route', route, '--brief', brief]));
          });
          // Fresh occupancy and readiness on the next scheduled pass. Dispatch
          // performs the authoritative, locked applicable-cap admission itself.
          if (dispatched?.state === 'complete') break;
        } catch (e) {
          if (['DISPATCH_SESSION_CAP', 'DISPATCH_UNLANDED_CAP'].includes(e.code)) { log({ action: 'capacity-held', reason: e.message }); break; }
          note(`dispatch:${item.id}`, e.message);
        }
      }
      log({ action: 'pass-complete' });
      return { result: 'pass-complete', directory };
    } finally { release(); }
  }
  return { pass, directory, log };
}

export async function main(argv = process.argv.slice(2)) {
  const { values } = parseArgs({ args: argv, usage: 'line-service.mjs --once --repo CANONICAL --org RECORD --to SUPERVISOR', options: {
    once: { type: 'boolean' }, repo: { type: 'string' }, org: { type: 'string' }, to: { type: 'string' }, herdr: { type: 'string' },
  } });
  if (!values.once || !values.repo) throw Error('use --once --repo CANONICAL; launchd owns the schedule');
  const source = gitProject(sourceRoot);
  if (source.checkout !== source.canonical) throw Error('live line service must use the canonical development source');
  const service = createLineService(values);
  const result = service.pass();
  process.stdout.write(JSON.stringify(result) + '\n');
}
if (isMain(import.meta.url)) main().catch(e => { process.stderr.write(`line-service: ${e.message}\n`); process.exitCode = 1; });
