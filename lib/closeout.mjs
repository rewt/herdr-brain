// Event references and target bindings only. Eligibility always comes from the
// retirement executor's fresh observation, never from a signal or queue file.
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { gitProject } from './project.mjs';
import { readProjectPolicy } from './config-policy.mjs';
import { findOrgDir, loadEvents, transact } from './store.mjs';
import { fold } from './state.mjs';
import { effectiveWorkerIdentity } from './worker-identity.mjs';
import { retirementLock } from './retire-lock.mjs';
import { ownerAlive } from './process-owner.mjs';
import { protectRecordMutation } from './record-guard.mjs';
import { readReviewVerdicts } from './review-verdict.mjs';
import { readArchivalRetirementPolicy, observeArchivalHistory, patchesIntegrated } from './retire-archive.mjs';

const worker = fileURLToPath(new URL('../supervisor/closeout.mjs', import.meta.url));
export const closeoutKey = (lane, run, signal) => createHash('sha256').update(JSON.stringify([lane, run, signal])).digest('hex');
export const closeoutDirectory = common => path.join(common, 'closeout');
export const retirementOwnerLock = common => path.join(common, 'retirement/owner.lock');
const ownershipClaims = new Map();
export function claimRetirementOwner(common, options) {
  let claim = ownershipClaims.get(common);
  if (!claim) { claim = { count: 0, release: retirementLock(retirementOwnerLock(common), options) }; ownershipClaims.set(common, claim); }
  claim.count++;
  return () => { if (--claim.count === 0) { ownershipClaims.delete(common); claim.release(); } };
}
const git = (cwd, args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', timeout: 10000, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
export const fileIdentity = file => { const s = fs.lstatSync(file); return { dev: s.dev, ino: s.ino, birthtimeMs: s.birthtimeMs }; };
export const sameFileIdentity = (file, expected) => JSON.stringify(fileIdentity(file)) === JSON.stringify(expected);

export function closeoutPolicy(canonical, { source } = {}) {
  let config;
  try { config = readProjectPolicy(canonical, 'lane', process.env, { canonical }).config; }
  catch (e) { if (e.code === 'ENOENT') return false; throw Error(`closeout policy invalid or unavailable: ${e.message}`); }
  if (!config || typeof config !== 'object' || Array.isArray(config) ||
      (config.retirement !== undefined && (!config.retirement || typeof config.retirement !== 'object' || Array.isArray(config.retirement))) ||
      (config.retirement?.closeout_queue !== undefined && typeof config.retirement.closeout_queue !== 'boolean'))
    throw Error('invalid retirement.closeout_queue policy; retirement kept');
  // Landing and named requests use the queue by default. Implicit pre-landing
  // signals retain the full queue's opt-in, so default ingestion cannot create
  // a closer request before promotion/completion has finished with the lane.
  return ['report.ingested', 'review.verdict', 'item.closed'].includes(source)
    ? config.retirement?.closeout_queue === true
    : config.retirement?.closeout_queue !== false;
}

// ORG_DIR selects a CLI record, not the record this Git project's closer owns.
// Resolve the project's binding independently before publishing or consuming.
export function closeoutRecordMatches(project, org, env = process.env) {
  const { ORG_DIR, ...discoveryEnv } = env;
  const record = findOrgDir({ cwd: project.canonical, env: discoveryEnv });
  return Boolean(record && org && fs.realpathSync(record) === fs.realpathSync(org));
}

export function queueTransaction(common, fn) {
  const release = retirementLock(path.join(closeoutDirectory(common), 'queue.lock'), { waitMs: 10000 });
  try { return fn(); } finally { release(); }
}

// Publish a fully fsynced document without replacing another writer's binding.
function publish(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.new-${randomUUID()}`, fd = fs.openSync(temporary, 'wx', 0o600);
  try { fs.writeFileSync(fd, JSON.stringify(value) + '\n'); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  let created = false;
  try { fs.linkSync(temporary, file); created = true; }
  catch (e) { if (e.code !== 'EEXIST') throw e; }
  finally { fs.unlinkSync(temporary); }
  const dir = fs.openSync(path.dirname(file), 'r');
  try { fs.fsyncSync(dir); } finally { fs.closeSync(dir); }
  return created;
}

export function readCloseoutEntries(common, { onInvalid = diagnostic => { throw Error(diagnostic.reason); } } = {}) {
  const directory = path.join(closeoutDirectory(common), 'entries');
  let names;
  try { names = fs.readdirSync(directory).filter(n => n.endsWith('.json')); }
  catch (e) { if (e.code === 'ENOENT') return []; throw e; }
  return names.flatMap(name => {
    const file = path.join(directory, name);
    try {
    if (!fs.lstatSync(file).isFile()) throw Error('closeout entry is not a regular file');
    const e = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (e.schema !== 'closeout-entry/v1' || e.common !== common || !['ready', 'review-done', 'landed', 'parked'].includes(e.signal) ||
        !/^R-\d+$/.test(e.run ?? '') || !/^lane\/[a-z0-9][a-z0-9-]{1,60}$/.test(e.branch ?? '') ||
        e.key !== closeoutKey(e.cwd, e.run, e.signal) || name !== `${e.key}.json` ||
        !Number.isSafeInteger(e.source?.seq) || e.source.seq < 1 || typeof e.source.type !== 'string' ||
        !/^[a-f0-9]{40,64}$/.test(e.head ?? '') || ![e.cwd, e.gitDirectory, e.org, e.project].every(p => typeof p === 'string' && path.isAbsolute(p)) ||
        !e.worktreeIdentity || !e.gitIdentity || !Array.isArray(e.panes)) throw Error(`invalid closeout entry ${name}; keep`);
    return [e];
    } catch (e) { if (e.code === 'ENOENT') return []; // A completed entry was pruned after readdir.
      onInvalid({ file, key: name.slice(0, -5), reason: e.message,
      waiting: { event: 'entry-repaired', observation: 'repair the named entry from its committed source binding, then explicitly drain' } }); return []; }
  }).sort((a, b) => a.source.seq - b.source.seq || a.key.localeCompare(b.key));
}
const queueEntries = common => readCloseoutEntries(common, { onInvalid: d => process.stderr.write(`closeout: ${d.reason}; ${d.file} kept; repair and explicitly drain\n`) });

export const closeoutEvaluation = (entry, events) => events.findLast(e => e.type === 'closeout.evaluated' &&
  e.identity === entry.common && e.key === entry.key && e.run === entry.run);

// Called under queue.lock, only after the completion receipt is durable. The
// source binding and all effect evidence remain in the append-only record.
export function pruneCompletedCloseout(common, org, entries, events) {
  let changed = false;
  for (const entry of entries) {
    const prior = closeoutEvaluation(entry, events);
    const source = events.find(e => e.seq === entry.source.seq && e.type === entry.source.type);
    const bound = source?.closeout_targets?.find(t => t.key === entry.key);
    if (entry.org !== fs.realpathSync(org) || !prior?.completed || JSON.stringify(prior.source) !== JSON.stringify(entry.source) ||
        !bound || Object.keys(bound).some(k => JSON.stringify(bound[k]) !== JSON.stringify(entry[k]))) continue;
    fs.unlinkSync(path.join(closeoutDirectory(common), 'entries', `${entry.key}.json`));
    changed = true;
  }
  if (changed) {
    const fd = fs.openSync(path.join(closeoutDirectory(common), 'entries'), 'r');
    try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  }
}

function registeredLane(project, workspace) {
  if (!workspace) return null;
  const cwd = fs.existsSync(workspace) ? fs.realpathSync(workspace) : path.resolve(workspace);
  if (cwd === project.canonical) return null;
  const row = git(project.canonical, ['worktree', 'list', '--porcelain']).split('\n\n')
    .find(e => e.split('\n').includes(`worktree ${cwd}`) && e.split('\n').some(l => /^branch refs\/heads\/lane\/[a-z0-9][a-z0-9-]{1,60}$/.test(l)));
  return row ? cwd : null;
}

function paneBinding(run, state) {
  const m = effectiveWorkerIdentity(run, state);
  return !m.identity_conflict && m.pane && m.terminal_id && m.agent_session_id && m.worker_workspace && m.agent ?
    { run: run.id, pane: m.pane, terminal: m.terminal_id, session: m.agent_session_id, workspace: m.worker_workspace, agent: m.agent } : null;
}

function bindEntry(project, org, events, source, runId, signal, expectedHead) {
  const state = fold(events), run = state.runs.get(runId);
  const cwd = registeredLane(project, run?.workspace);
  if (!cwd) return null; // Desks, planning and foreign/non-Git workspaces have no lane lifecycle.
  const target = gitProject(cwd);
  if (target.identity !== project.identity || target.checkout !== cwd) throw Error('registered lane project identity changed; keep');
  const branch = git(cwd, ['symbolic-ref', '--short', 'HEAD']);
  if (!/^lane\/[a-z0-9][a-z0-9-]{1,60}$/.test(branch)) return null;
  const head = expectedHead ?? git(cwd, ['rev-parse', 'HEAD']);
  const gitDirectory = fs.realpathSync(git(cwd, ['rev-parse', '--absolute-git-dir']));
  if (!gitDirectory.startsWith(path.join(project.identity, 'worktrees') + path.sep)) throw Error('closeout target is not a registered linked worktree');
  const laneRuns = signal === 'review-done' ? [run] : [...state.runs.values()]
    .filter(r => r.workspace === run.workspace && (r.id === runId || r.report || r.abandoned));
  const runIds = new Set(laneRuns.map(r => r.id));
  const reviews = [...new Map([...readReviewVerdicts(org, project.identity),
    ...events.filter(e => e.type === 'review.verdict' && e.common === project.identity).map(e => e.review)].map(r => [r.id, r])).values()]
    .filter(r => runIds.has(r.run));
  const recipients = signal === 'review-done' ? [source.review] : [
    ...laneRuns.map(r => ({ binding: paneBinding(r, state), seq: r.started.seq })),
    ...reviews.map(r => ({ binding: r, seq: r.record_seq })),
  ].filter(r => r.binding).sort((a,b) => a.seq - b.seq).map(r => r.binding);
  // A reused pane is bound to its newest recorded native occupant. Older
  // distinct panes retire before their retained successors disappear.
  const panes = recipients.filter((p, i) => !recipients.slice(i + 1).some(later => later.pane === p.pane));
  const log = path.join(project.identity, 'logs/refs/heads', branch);
  const branchLog = fs.existsSync(log) ? { path: log, identity: fileIdentity(log), sha256: createHash('sha256').update(fs.readFileSync(log)).digest('hex') } : null;
  return { schema: 'closeout-entry/v1', key: closeoutKey(cwd, runId, signal), common: project.identity, project: project.canonical,
    org: fs.realpathSync(org), source: { seq: source.seq, type: source.type }, run: runId, item: run.item,
    signal, cwd, branch, head, gitDirectory, worktreeIdentity: fileIdentity(cwd), gitIdentity: fileIdentity(gitDirectory), branchLog,
    ...(source.type === 'lane.recovery-requested' && source.content ? { content: source.content } : {}),
    panes: panes.filter(Boolean).map(p => Object.fromEntries(['run', 'pane', 'terminal', 'session', 'workspace', 'agent', 'process', 'shell', 'tab'].filter(k => p[k] !== undefined).map(k => [k, p[k]]))) };
}

function signalTargets(event, state, common) {
  if (Array.isArray(event.closeout_targets)) return [
    ...event.closeout_targets.filter(t => t.common === common).map(t => [t.run, t.signal, t.head]),
    ...(event.closeout_binding_errors ?? []).map(e => [e.run, e.signal]),
  ]; // A committed empty binding means the source had no applicable lane.
  if (event.type === 'lane.recovery-requested' && event.common === common && ['landed', 'parked'].includes(event.signal)) return [[event.run, event.signal, event.head]];
  if (event.type === 'report.ingested' && event.report?.outcome === 'done') return [[event.run, 'ready']];
  if (event.type === 'lane.ready' && event.common === common) return [[event.run, 'ready', event.head]];
  if (event.type === 'review.verdict' && event.common === common) return [[event.run, 'review-done', event.head]];
  if (event.type === 'promotion.reconciled' && event.identity === common) return (event.heads ?? []).filter(h => event.runs?.includes(h.run)).map(h => [h.run, 'landed', h.head]);
  if (event.type === 'item.closed' && event.as === 'dropped') return (state.items.get(event.id)?.runs ?? []).map(id => [id, 'parked']);
  return [];
}

// Bind while the source event is being committed. A crash before queue
// publication can then recover that exact target, never a recreated namesake.
export function bindCloseoutSources({ cwd = process.cwd(), org, events, mutation, env = process.env }) {
  if (!(mutation.add ?? []).some(e => ['report.ingested', 'lane.ready', 'lane.recovery-requested', 'review.verdict', 'promotion.reconciled', 'item.closed'].includes(e.type))) return mutation;
  try { return bindSources({ cwd, org, events, mutation, env }); }
  catch (e) {
    // Lifecycle observations must not prevent a report/record fact from being
    // committed. The missing binding is an explicit KEEP and recoverable by a
    // new named request, never a guessed post-crash target.
    return { ...mutation, add: mutation.add.map(event => ({ ...event, closeout_binding_error: e.message })) };
  }
}
function bindSources({ cwd, org, events, mutation, env }) {
  let project;
  try { project = gitProject(cwd); } catch { return mutation; }
  if (!closeoutPolicy(project.canonical)) return mutation;
  if (!closeoutRecordMatches(project, org, env)) return mutation;
  const projected = [...events, ...(mutation.add ?? [])], state = fold(projected);
  return { ...mutation, add: (mutation.add ?? []).map(event => {
    if (!closeoutPolicy(project.canonical, { source: event.type })) return event;
    const targets = signalTargets(event, state, project.identity);
    if (!targets.length) return event;
    const errors = [], bound = targets.flatMap(([run, signal, head]) => {
      try {
        const entry = bindEntry(project, org, projected, { ...event, seq: 0 }, run, signal, head);
        if (!entry) return [];
        const { source, ...target } = entry;
        return [target];
      } catch (e) { errors.push({ run, signal, reason: e.message }); return []; }
    });
    return { ...event, closeout_targets: bound, ...(errors.length ? { closeout_binding_errors: errors } : {}) };
  }) };
}

export function assertQueueOwnership(project, org) {
  const root = path.join(org, 'housekeeping');
  let names;
  try { names = fs.readdirSync(root); } catch (e) { if (e.code === 'ENOENT') return; throw e; }
  for (const name of names) {
    const file = path.join(root, name, 'lock/owner.json');
    let owner;
    try { owner = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { if (['ENOENT', 'ENOTDIR'].includes(e.code)) continue; throw e; }
    if (owner.cwd === project.canonical && owner.retirement_queue_protocol !== 1)
      throw Error('retirement ownership transfer waits for legacy housekeeping to stop/restart; inspect its owner and children, then retry');
  }
}

export function closeoutRemovalReceipt(entry, events) {
  return events.findLast(e => {
    if (e.type !== 'closeout.effect' || e.identity !== entry.common || e.outcome?.action !== 'lane-removed') return false;
    const source = events.find(s => s.seq === e.source?.seq && s.type === e.source?.type);
    const target = source?.closeout_targets?.find(t => t.key === e.key);
    return target && ['landed', 'parked'].includes(target.signal) && target.common === entry.common && target.cwd === entry.cwd &&
      target.branch === entry.branch && target.head === e.outcome.tip &&
      JSON.stringify(target.worktreeIdentity) === JSON.stringify(entry.worktreeIdentity) && JSON.stringify(target.gitIdentity) === JSON.stringify(entry.gitIdentity);
  });
}

export function closeoutRevision(entry, events, state = fold(events)) {
  // Only explicit, target-related record changes wake deferred work. Runtime
  // receipts never wake themselves. Filesystem/native changes require retry.
  const run = state.runs.get(entry.run);
  const removed = closeoutRemovalReceipt(entry, events);
  const ids = new Set([entry.item]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const item of state.items.values()) if (ids.has(item.parent) && !ids.has(item.id)) { ids.add(item.id); changed = true; }
    for (const link of state.links) if (ids.has(link.blocked) && !ids.has(link.blocker)) { ids.add(link.blocker); changed = true; }
  }
  return events.reduce((revision, e) => {
    if (e.seq <= entry.source.seq) return revision;
    if (e.type === 'closeout.retry' && e.keys?.includes(entry.key)) return e.seq;
    if (e.seq === removed?.seq && e.key !== entry.key) return e.seq;
    if (!['report.ingested', 'review.verdict', 'review.followup-ended', 'promotion.reconciled', 'item.closed', 'item.reopened', 'link.removed',
      'question.answered', 'retirement.handoff', 'retirement.release', 'run.abandoned', 'run.started', 'run.worker-bound', 'run.session-bound'].includes(e.type)) return revision;
    const r = state.runs.get(e.run ?? e.id ?? e.from);
    return ids.has(e.id ?? e.item) || (r && (ids.has(r.item) || r.workspace === run?.workspace)) ||
      e.items?.some(id => ids.has(id)) || ids.has(e.blocked) || ids.has(e.blocker) ? e.seq : revision;
  }, entry.source.seq);
}

export function kickCloseout(project, org, { env = process.env } = {}) {
  if (!closeoutRecordMatches(project, org, env)) return { evaluated: [] };
  // Holding queue.lock across the live-owner check and spawn pairs with the
  // consumer's empty-exit handoff. Two startup contenders still share one claim.
  return queueTransaction(project.identity, () => {
    const directory = closeoutDirectory(project.identity), lock = path.join(directory, 'consumer.lock');
    try { if (ownerAlive(JSON.parse(fs.readFileSync(path.join(lock, 'owner.json'), 'utf8')))) return { already_running: true }; }
    catch (e) { if (e.code !== 'ENOENT') return { kept: true, reason: `closer owner unavailable: ${e.message}; retry explicitly` }; }
    fs.mkdirSync(directory, { recursive: true });
    const output = fs.openSync(path.join(directory, 'worker.log'), 'a', 0o600);
    const childEnv = { ...env, ORG_DIR: org };
    for (const key of ['HERDR_TAB_ID', 'HERDR_PANE_ID', 'HERDR_WORKSPACE_ID', 'LANE_CONFIG', 'LANE_VALIDATE']) delete childEnv[key];
    try {
      const child = spawn(process.execPath, [worker, 'drain', '--repo', project.canonical, '--org', org], {
        cwd: project.canonical, env: childEnv, detached: true, stdio: ['ignore', output, output] });
      child.on('error', e => process.stderr.write(`closeout: startup failed: ${e.message}; queue retained; retry drain\n`));
      child.unref();
      return { pid: child.pid };
    } finally { fs.closeSync(output); }
  });
}

// Called by record CLI mutations after the record lock is released. This is
// outside the model-free store/fold; it never infers ingestion from disk files.
export function publishCloseoutEvents({ cwd = process.cwd(), org, added, start = true, env = process.env } = {}) {
  if (!added?.length) return [];
  let project;
  try { project = gitProject(cwd); } catch { return []; }
  if (!closeoutPolicy(project.canonical)) return [];
  if (!closeoutRecordMatches(project, org, env)) return [];
  const record = fs.realpathSync(org);
  const entriesForRecord = () => queueEntries(project.identity).filter(entry => entry.org === record && entry.project === project.canonical);
  const { events, tornTail } = loadEvents(org);
  if (tornTail) throw Error('closeout record has an incomplete tail');
  const state = fold(events), requested = [];
  for (const event of added) {
    if (!events.some(e => e.seq === event.seq && JSON.stringify(e) === JSON.stringify(event))) throw Error('closeout source is not a committed record event');
    if (!closeoutPolicy(project.canonical, { source: event.type })) continue;
    for (const target of signalTargets(event, state, project.identity)) requested.push([event, ...target]);
  }
  const created = queueTransaction(project.identity, () => {
    // A consumer may have completed and pruned a key while publication waited
    // for queue.lock. Read its receipt after that handoff before recreating it.
    const { events, tornTail } = loadEvents(org);
    if (tornTail) throw Error('closeout record has an incomplete tail');
    const entries = entriesForRecord();
    pruneCompletedCloseout(project.identity, org, entries, events);
    return requested.flatMap(([source, run, signal]) => {
      const existing = entries.find(e => e.run === run && e.signal === signal && e.cwd === state.runs.get(run)?.workspace);
      if (existing) return [];
      const bound = source.closeout_targets?.find(e => e.run === run && e.signal === signal);
      if (!bound) {
        process.stderr.write(`closeout: source event ${source.seq}, ${run} has no durable target binding; kept; use named supervisor recovery\n`);
        return [];
      }
      const entry = { ...bound, source: { seq: source.seq, type: source.type } };
      if (closeoutEvaluation(entry, events)?.completed) return [];
      return publish(path.join(closeoutDirectory(project.identity), 'entries', `${entry.key}.json`), entry) ? [entry] : [];
    });
  });
  if (start && entriesForRecord().some(entry => {
    const prior = events.findLast(e => e.type === 'closeout.evaluated' && e.key === entry.key);
    return !prior?.completed && closeoutRevision(entry, events, state) > (prior?.revision ?? 0);
  })) kickCloseout(project, org, { env });
  return created;
}

export function readyLane({ cwd = process.cwd(), topic, run: runId, env = process.env, org = findOrgDir({ cwd, env }), start = true } = {}) {
  const project = gitProject(cwd), { events } = loadEvents(org), state = fold(events);
  const runs = [...state.runs.values()].filter(r => {
    try {
      return registeredLane(project, r.workspace) && gitProject(r.workspace).identity === project.identity &&
        git(r.workspace, ['symbolic-ref', '--short', 'HEAD']) === `lane/${topic}`;
    } catch { return false; } // An unrelated broken/detached checkout is no match.
  });
  const run = runId ? runs.find(r => r.id === runId) : runs.sort((a,b) => b.started.seq - a.started.seq)[0];
  if (!run) throw Error('lane ready needs its recorded run and linked worktree');
  if (gitProject(run.workspace).identity !== project.identity) throw Error('lane ready project identity differs');
  const result = transact(org, current => {
    const prior = current.find(e => e.type === 'lane.ready' && e.run === run.id && e.common === project.identity);
    return bindCloseoutSources({ cwd, org, env, events: current, mutation: protectRecordMutation({ org, events: current, state: fold(current), command: 'lane ready', mutation: { add: prior ? [] : [
      { type: 'lane.ready', common: project.identity, run: run.id, item: run.item, cwd: run.workspace, head: git(run.workspace, ['rev-parse', 'HEAD']) }], result: prior } }) });
  }, { actor: process.env.ORG_ACTOR || 'lane ready' });
  publishCloseoutEvents({ cwd, org, added: result.added.length ? result.added : [result.result], start, env });
  return { run: run.id, signal: 'ready' };
}

// A named Git observation, not removal authority. The consumer repeats it and
// the adapter validates the selected proof again under the lifecycle lock.
export function observeCloseoutContent({ project, branch, head }) {
  const main = git(project, ['symbolic-ref', '--short', 'HEAD']);
  const mainTip = git(project, ['rev-parse', '--verify', `refs/heads/${main}`]);
  const stable = () => {
    if (git(project, ['symbolic-ref', '--short', 'HEAD']) !== main ||
        git(project, ['rev-parse', '--verify', `refs/heads/${main}`]) !== mainTip ||
        git(project, ['rev-parse', '--verify', `refs/heads/${branch}`]) !== head)
      throw Error('closeout Git snapshot changed; lane kept');
  };
  stable();
  let integrated = false;
  try { git(project, ['merge-base', '--is-ancestor', head, mainTip]); integrated = true; }
  catch (error) { if (error.status !== 1 || error.code) throw error; }
  let kind = 'integrated', archival, archiveTag;
  if (!integrated) {
    archiveTag = `archive/${branch}`;
    if (git(project, ['tag', '--list', archiveTag]) === archiveTag) {
      if (git(project, ['rev-parse', '--verify', `refs/tags/${archiveTag}^{commit}`]) !== head)
        throw Error('closeout archive tag does not match the lane tip; lane kept');
      kind = 'archive-tagged';
    } else {
      const policy = readArchivalRetirementPolicy(project);
      if (policy.archivalRetirementPolicyError) throw Error('archival retirement policy is unavailable; lane kept');
      if (!policy.archivalRetirementPolicy) throw Error('lane tip is not integrated in main; archival retirement policy is off');
      archival = observeArchivalHistory({ branch, tip: head, main, mainTip, git: args => git(project, args) });
      if (!patchesIntegrated(archival)) throw Error(`lane tip is not integrated or exactly archived; ${archival.error ?? 'complete stable patch matches required'}; lane kept`);
      kind = 'archival-retirement'; archiveTag = undefined;
    }
  }
  stable();
  return { content: { kind, head, main, mainTip, ...(kind === 'archive-tagged' ? { archiveTag } : {}) }, archival };
}

export function recoverLane({ cwd = process.cwd(), lane, env = process.env, org = findOrgDir({ cwd, env }), why = 'explicit named supervisor recovery', start = true } = {}) {
  const project = gitProject(cwd), target = fs.realpathSync(lane), state = fold(loadEvents(org).events);
  if (!registeredLane(project, target) || gitProject(target).identity !== project.identity) throw Error('named recovery requires this project\'s registered linked lane; keep');
  const run = [...state.runs.values()].filter(r => r.workspace === target).sort((a,b) => b.started.seq - a.started.seq)[0];
  if (!run) throw Error('named recovery lacks an exact recorded run; keep');
  const item = state.items.get(run.item), head = git(target, ['rev-parse', 'HEAD']);
  const signal = item?.closed?.as === 'dropped' ? 'parked' : 'landed';
  const content = signal === 'landed' ? observeCloseoutContent({ project: project.canonical,
    branch: git(target, ['symbolic-ref', '--short', 'HEAD']), head }).content : undefined;
  const result = transact(org, events => bindCloseoutSources({ cwd, org, env, events, mutation: { add: [
    { type: 'lane.recovery-requested', common: project.identity, run: run.id, item: run.item, head, signal, why, ...(content ? { content } : {}) }],
  } }), { actor: 'named lane recovery' });
  publishCloseoutEvents({ cwd, org, added: result.added, env, start });
  return result.added[0];
}

export function retryCloseout({ cwd = process.cwd(), org = findOrgDir({ cwd }), topic, why, start = true } = {}) {
  const project = gitProject(cwd);
  if (!why?.trim() || !topic) throw Error('retry requires a named topic (or entry key) and reason');
  const entries = readCloseoutEntries(project.identity).filter(e => e.key === topic || e.branch === `lane/${topic}`);
  if (!entries.length) throw Error('no closeout entries for named target');
  const result = transact(org, () => ({ add: [{ type: 'closeout.retry', keys: entries.map(e => e.key), why }] }), { actor: 'closeout retry' });
  publishCloseoutEvents({ cwd, org, added: result.added, start });
  return result.added[0];
}

export function retryPromotionCloseout({ cwd, org, jobs, start = true }) {
  if (!jobs.length) return [];
  const project = gitProject(cwd);
  const result = transact(org, events => {
    const keys = readCloseoutEntries(project.identity).filter(entry => {
      if (entry.org !== fs.realpathSync(org) || entry.signal !== 'landed' || !jobs.some(job =>
        job.run === entry.run && `lane/${job.topic}` === entry.branch && job.tip === entry.head)) return false;
      const prior = closeoutEvaluation(entry, events);
      return prior && !prior.completed && prior.waiting?.event === 'lifecycle-lock-released' &&
        closeoutRevision(entry, events) === prior.revision;
    }).map(entry => entry.key);
    return { add: keys.length ? [{ type: 'closeout.retry', keys, why: 'promotion completion released its references and lifecycle lock' }] : [] };
  }, { actor: 'promotion closeout' });
  publishCloseoutEvents({ cwd, org, added: result.added, start });
  return result.added;
}

export function recordCompletedReview({ cwd, org, receipt, head, item, start = true, env = process.env }) {
  const common = gitProject(cwd).identity;
  if (!receipt || receipt.common !== common || !/^[a-f0-9]{40,64}$/.test(head ?? '') ||
      createHash('sha256').update(fs.readFileSync(receipt.evidence)).digest('hex') !== receipt.sha256) throw Error('completed review evidence is unavailable');
  const recorded = transact(org, events => {
    const prior = events.find(e => e.type === 'review.verdict' && e.review?.id === receipt.id);
    if (prior) {
      if (prior.head !== head || prior.review.sha256 !== receipt.sha256) throw Error('review completion has different evidence');
      return { result: prior.review };
    }
    const review = { ...receipt, record_seq: (events.at(-1)?.seq ?? 0) + 1, at: new Date().toISOString(), followup_expected: receipt.followup_expected ?? false };
    return bindCloseoutSources({ cwd, org, env, events, mutation: { add: [{ type: 'review.verdict', common, run: receipt.run, item, head,
      reviewed_head: receipt.head, review }], result: review } });
  }, { actor: 'settle review' });
  publishCloseoutEvents({ cwd, org, added: recorded.added, start, env });
  return recorded.result;
}

export function endReviewFollowup({ cwd, org, reviewId, why }) {
  if (!why?.trim()) throw Error('ending a reviewer follow-up requires --why TEXT');
  const project = gitProject(cwd);
  const result = transact(org, events => {
    const source = events.find(e => e.type === 'review.verdict' && e.common === project.identity && e.review?.id === reviewId);
    if (!source || !source.review.followup_expected) throw Error('no matching retained reviewer verdict');
    const prior = events.find(e => e.type === 'review.followup-ended' && e.review_id === reviewId);
    return { add: prior ? [] : [{ type: 'review.followup-ended', review_id: reviewId, run: source.run, item: source.item, source_seq: source.seq, why }] };
  }, { actor: 'review follow-up' });
  publishCloseoutEvents({ cwd, org, added: result.added });
  return result.added;
}
