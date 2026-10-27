// Capacity evidence only: never signal, close or alter a recorded session.
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fold } from '../lib/state.mjs';
import { loadEvents } from '../lib/store.mjs';
import { gitProject } from '../lib/project.mjs';
import { lookupProcess } from '../lib/processes.mjs';
import { effectiveWorkerIdentity } from '../lib/worker-identity.mjs';
import { nativeProcess } from './session-bind.mjs';
import { loadTimeout, ADMISSION_WAIT_MS } from '../lib/deadline.mjs';
import { matchesDispatchStart } from './unlanded-cap.mjs';
import {resolvedNotStarted} from './not-started.mjs';

export const DEFAULT_SESSION_CAP = 7;
export const DEFAULT_REVIEW_SESSION_CAP = 3;
const positive = n => Number.isSafeInteger(n) && n > 0;
const canonical = file => { try { return fs.realpathSync(file); } catch { return path.resolve(file); } };
const bound = w => w?.agent && w.pane && w.worker_workspace && (w.terminal_id || w.agent_session_id);
const worker = w => w && ({ agent: w.agentName, pane: w.pane, worker_workspace: w.workspaceId,
  terminal_id: w.terminalId, agent_session_id: w.agentSessionId });

// Separate from promotion locks: a launching journal reserves capacity even if
// the coordinator dies while its launch child survives. Unique contenders
// serialize cleanup too, so two reclaimers cannot remove a newly acquired lock.
export function acquireSessionCapLock(common, { waitMs = ADMISSION_WAIT_MS, allowance = loadTimeout, now = Date.now,
  pause = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms), check = () => {},
  kill = process.kill, readProcess = pid => lookupProcess(pid, { identityOnly: true }) } = {}) {
  const directory = path.join(common, 'dispatch-session-cap'), contenders = `${directory}.contenders`;
  const token = `${process.pid}-${randomUUID()}`, contender = path.join(contenders, token);
  const budget = allowance(waitMs), deadline = now() + budget;
  const busy = () => Object.assign(Error('admission busy'), { code: 'ADMISSION_BUSY' });
  const readOwner = file => {
    try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
    catch (e) {
      if (e.code === 'ENOENT' && !fs.existsSync(directory)) throw busy();
      throw Object.assign(Error(`DISPATCH_SESSION_CAP_LOCK_OWNER_UNREADABLE: session admission lock owner missing or unreadable: ${directory}; inspect surviving dispatch processes, then remove this lock directory and retry`),
        { code: 'DISPATCH_SESSION_CAP_LOCK_OWNER_UNREADABLE' });
    }
  };
  const current = readProcess(process.pid);
  if (!current?.ok || current.value?.pid !== process.pid || typeof current.value.identity !== 'string' || !current.value.identity.trim()) {
    throw Error('session admission owner birth identity unavailable; inspect the native process source and retry');
  }
  const owner = { pid: process.pid, identity: current.value.identity, token, at: new Date().toISOString() };
  // A killed synchronous waiter cannot run its finally block. Only complete
  // staging receipts with proven-dead owners are safe to remove; age, denied
  // probes and missing/malformed receipts never establish that authority.
  for (const entry of fs.readdirSync(common, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.startsWith('.dispatch-session-cap-')) continue;
    check();
    const sibling = path.join(common, entry.name);
    let prior;
    try { prior = JSON.parse(fs.readFileSync(path.join(sibling, 'owner.json'), 'utf8')); }
    catch { continue; }
    if (!sessionAlive(prior, { kill, readProcess })) fs.rmSync(sibling, { recursive: true, force: true });
  }
  fs.mkdirSync(contenders, { recursive: true });
  const temporary = fs.mkdtempSync(path.join(common, '.dispatch-session-cap-'));
  let acquired = false;
  try {
    fs.writeFileSync(path.join(temporary, 'owner.json'), JSON.stringify(owner), { mode: 0o600 });
    for (;;) {
      check();
      // Waiters withdraw their contender before sleeping. Retaining it would
      // make two waiting coordinators hold each other out indefinitely.
      fs.writeFileSync(path.join(temporary, 'contender.json'), JSON.stringify(owner), { mode: 0o600 });
      fs.renameSync(path.join(temporary, 'contender.json'), contender);
      try {
        for (const entry of fs.readdirSync(contenders)) {
          if (entry === token) continue;
          const file = path.join(contenders, entry);
          let other;
          try { other = JSON.parse(fs.readFileSync(file, 'utf8')); }
          catch (e) {
            if (e.code === 'ENOENT') continue;
            // Older contenders contain only the PID in their filename.
            other = { pid: Number(entry.split('-')[0]) };
          }
          if (sessionAlive(other, { kill, readProcess })) throw busy();
          try { fs.unlinkSync(file); } catch (e) { if (e.code !== 'ENOENT') throw e; }
        }
        if (fs.existsSync(directory)) {
          if (sessionAlive(readOwner(path.join(directory, 'owner.json')), { kill, readProcess })) throw busy();
          fs.rmSync(directory, { recursive: true });
        }
        // The shared lock first becomes visible with its complete birth tuple.
        fs.renameSync(temporary, directory);
        acquired = true;
        break;
      } catch (e) {
        if (e.code !== 'ADMISSION_BUSY') throw e;
      } finally {
        if (!acquired) fs.rmSync(contender, { force: true });
      }
      if (now() >= deadline) {
        throw Object.assign(Error(`locked: ${directory}; admission wait exhausted after ${budget} ms; inspect owner.json and surviving dispatch processes, then retry`),
          { code: 'DISPATCH_SESSION_CAP_LOCKED' });
      }
      pause(Math.min(50, deadline - now()));
    }
  } finally {
    if (!acquired) {
      fs.rmSync(contender, { force: true });
      fs.rmSync(temporary, { recursive: true, force: true });
    }
  }
  let released = false;
  return () => {
    if (released) return;
    if (readOwner(path.join(directory, 'owner.json')).token !== token) throw Error('session admission lock owner changed; inspect before retry');
    fs.rmSync(directory, { recursive: true });
    fs.unlinkSync(contender);
    released = true;
  };
}

// A missing/denied process source is unknown, never proof of death. Compare
// kernel birth identities when saved; a successful PID probe alone is weaker.
function sessionLiveness(owner, { kill = process.kill, readProcess = pid => lookupProcess(pid, { identityOnly: true }) } = {}) {
  if (!positive(owner?.pid)) return 'unknown';
  const probe = () => {
    try { kill(owner.pid, 0); return 'present'; }
    catch (e) { return e.code === 'ESRCH' ? 'gone' : 'unknown'; }
  };
  const exists = probe();
  if (exists !== 'present') return exists === 'gone' ? 'dead' : 'unknown';
  if (typeof owner.identity !== 'string' || !owner.identity.trim()) return 'unknown';
  try {
    const now = readProcess(owner.pid);
    if (now?.ok && now.value?.pid === owner.pid && typeof now.value.identity === 'string' && now.value.identity.trim()) {
      // Old Linux tick-only receipts cannot prove boot continuity.
      if (/^\d+$/.test(owner.identity) && /^[a-f0-9-]{36}:\d+$/i.test(now.value.identity)) return 'unknown';
      return owner.identity === now.value.identity ? 'live' : 'dead';
    }
  } catch { /* Unknown stays occupied, unless a fresh probe proves ESRCH. */ }
  return probe() === 'gone' ? 'dead' : 'unknown';
}

export const sessionAlive = (owner, options) => sessionLiveness(owner, options) !== 'dead';

export function countSessions({ state, events = [], journals = [], reviewers = [], common, agent, processInfo, excludeStartJournal,excludePendingJournal,
  projectIdentity = cwd => gitProject(cwd).identity, ...liveness }) {
  common = canonical(common);
  const sessions = [], jobs = new Map(journals.filter(j => j.run).map(j => [j.run, j]));
  const belongs = (identity, cwd) => {
    if (identity) return canonical(identity) === common;
    try { return canonical(projectIdentity(cwd)) === common; }
    catch { return true; } // Unreadable legacy project evidence cannot free capacity.
  };
  const add = candidate => {
    const live = sessionLiveness(candidate.process, liveness);
    if (live === 'dead') return;
    const occupancy = live === 'live' ? 'observed live'
      : candidate.evidence === 'uncertain launch' ? 'uncertain launch' : 'unknown liveness';
    const duplicate = sessions.find(s => candidate.identity?.agent_session_id && s.identity?.agent_session_id
      ? candidate.identity.agent_session_id === s.identity.agent_session_id
      : candidate.identity?.terminal_id && candidate.identity.terminal_id === s.identity?.terminal_id);
    if (duplicate) {
      duplicate.runs = [...new Set([...duplicate.runs, candidate.run])];
      if (occupancy === 'observed live') duplicate.occupancy = occupancy;
      return;
    }
    sessions.push({ ...candidate, occupancy, runs: [candidate.run] });
  };
  for (const run of state.runs.values()) {
    if (run.report || run.abandoned) continue;
    const job = jobs.get(run.id), identity = effectiveWorkerIdentity(run, state);
    if (!belongs(identity.dispatch_project ?? job?.common, run.workspace)) continue;
    const launch = bound(identity) ? identity : worker(job?.worker);
    if (!bound(launch) && job?.stage !== 'launching') continue;
    let owner = job?.launchProcess ?? job?.sessionBinding?.process ?? state.sessionBindings?.get(run.id)?.[0]?.process;
    if (!owner && bound(launch) && !identity.identity_conflict) try {
      const a = agent(launch.agent);
      if (a?.name === launch.agent && a.pane_id === launch.pane && a.workspace_id === launch.worker_workspace &&
          canonical(a.cwd) === canonical(run.workspace) &&
          (!launch.terminal_id || a.terminal_id === launch.terminal_id) &&
          (!launch.agent_session_id || a.agent_session?.value === launch.agent_session_id)) {
        owner = nativeProcess(a, processInfo(launch.pane), liveness.readProcess ??
          (pid => lookupProcess(pid, { identityOnly: true })));
      }
    } catch {
      // Even definitive agent_not_found proves only that Herdr lost the entry,
      // not that its native process exited. Keep the slot until process proof
      // or an explicit report/abandon, and name it for operator inspection.
    }
    add({ run: run.id, kind: run.meta?.dispatch_role === 'review' ? 'reviewer' : 'worker', identity: launch, process: owner ?? null,
      evidence: owner ? 'native process' : job?.stage === 'launching' ? 'uncertain launch' : 'unknown liveness' });
  }
  // A surviving record/launch child retains its durable reservation. A real
  // matching start replaces a starting reservation; coordinator death, age and
  // missing process metadata cannot do so. The owning request may reconcile
  // its own start under its request lock without reserving a second slot.
  for (const j of journals) {
    if (!belongs(j.common, j.workspace)) continue;
    const starting = j.stage === 'starting' && !j.startRefused && j.journal !== excludeStartJournal &&
      !events.some(e => e.type === 'run.started' && matchesDispatchStart(e,j));
    const launching = j.stage === 'launching' && !sessions.some(s => s.runs.includes(j.run));
    const detached=j.detached&&!j.detached_refused&&['open','start','worker'].includes(j.stage)&&!j.worker&&j.journal!==excludePendingJournal;
    if (!starting && !launching && !detached) continue;
    add({ run: j.run ?? null, journal: j.journal, kind: j.reviewQueue || j.unlandedCap?.admission?.kind === 'review' ? 'reviewer' : 'worker',
      identity: worker(j.worker), process: null, evidence: 'uncertain launch' });
  }
  // Reviewers have no worker run: the callback receipt binds the actual native
  // process to the already reported run under review. Retained live reviewers
  // still consume a session, including after a verdict has been recorded.
  for (const r of reviewers) {
    if (r.schema !== 'retirement-occupant/v1' || r.kind !== 'settle' || !r.run ||
        !belongs(r.common, r.cwd)) continue;
    add({ run: r.run, kind: 'reviewer', process: r.process, identity: r, evidence: 'settle launch receipt' });
  }
  return sessions;
}

function readJSON(directory, filter = name => name.endsWith('.json'), withJournal = false) {
  let files;
  try { files = fs.readdirSync(directory); }
  catch (e) { if (e.code === 'ENOENT') return []; throw e; }
  return files.filter(filter).sort().map(name => {
    const file=path.join(directory,name),value=JSON.parse(fs.readFileSync(file,'utf8'));
    return withJournal ? {...value,journal:file} : value;
  });
}

export function checkSessionCap({ config, org, kind='all', ...options }) {
  const nativeCap = config.dispatch?.max_sessions ?? DEFAULT_SESSION_CAP;
  const reviewCap=config.dispatch?.max_review_sessions??DEFAULT_REVIEW_SESSION_CAP;
  if (!positive(nativeCap)||!positive(reviewCap)) throw Error('dispatch session/review caps must be positive integers');
  const cap=kind==='review'?reviewCap:nativeCap;
  let sessions;
  try {
    // Journal first, then record: never miss both sides of a start transition.
    const directory=path.join(org,'dispatch');
    let journals=readJSON(directory, name => name.endsWith('.json') && !name.endsWith('.routes.json'), true);
    const events=loadEvents(org).events;
    journals=journals.filter(j=>{try{return !resolvedNotStarted({events,org,common:options.common,journal:j.journal});}catch{return true;}});
    sessions = countSessions({ ...options, events, state: fold(events), journals,
      reviewers: readJSON(path.join(org, 'retirement/occupants')) });
  } catch (e) { throw Error(`session count unavailable: ${e.message}`); }
  const total=sessions;
  if(kind==='review')sessions=total.filter(s=>s.kind==='reviewer'&&s.evidence!=='settle launch receipt');
  else if(kind==='build')sessions=total.filter(s=>s.kind==='worker');
  const evidence = { cap, count: sessions.length, sessions,kind,native_cap:nativeCap,native_count:total.length };
  if (sessions.length >= cap || total.length>=nativeCap) {
    const poolFull=sessions.length>=cap,held=poolFull?sessions:total,limit=poolFull?cap:nativeCap;
    const runs = list => [...new Set(list.flatMap(s => s.runs.filter(Boolean).length ? s.runs.filter(Boolean) : [`pending start ${s.journal ?? 'UNKNOWN'}`]))].sort((a,b)=>/^R-\d+$/.test(a)&&/^R-\d+$/.test(b)?Number(a.slice(2))-Number(b.slice(2)):a.localeCompare(b)).join(', ');
    const categories = ['observed live', 'unknown liveness', 'uncertain launch'].map(category =>
      `${category}: ${runs(held.filter(s => s.occupancy === category)) || 'none'}`).join('; ');
    const inspect = held.some(s => s.occupancy !== 'observed live')
      ? '; inspect unknown-liveness and uncertain-launch runs and explicitly abandon stale runs after checking their workers' : '';
    const error = Error(`${poolFull&&kind==='review'?'review':'session'} cap ${limit} reached: ${runs(held)} (counted ${held.filter(s => s.kind === 'worker').length} workers, ${held.filter(s => s.kind === 'reviewer').length} reviewers; ${categories}${inspect})`);
    error.code = kind==='review'&&sessions.length>=cap?'DISPATCH_REVIEW_CAP':'DISPATCH_SESSION_CAP';
    error.sessions = evidence;
    throw error;
  }
  return evidence;
}
