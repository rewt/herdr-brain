// Capacity evidence only: never signal, close or alter a recorded session.
import fs from 'node:fs';
import path from 'node:path';
import { fold } from '../lib/state.mjs';
import { loadEvents } from '../lib/store.mjs';
import { gitProject } from '../lib/project.mjs';
import { lookupProcess } from '../lib/processes.mjs';
import { effectiveWorkerIdentity } from '../lib/worker-identity.mjs';
import { nativeProcess } from './session-bind.mjs';

export const DEFAULT_SESSION_CAP = 7;
const positive = n => Number.isSafeInteger(n) && n > 0;
const canonical = file => { try { return fs.realpathSync(file); } catch { return path.resolve(file); } };
const bound = w => w?.agent && w.pane && w.worker_workspace && (w.terminal_id || w.agent_session_id);
const worker = w => w && ({ agent: w.agentName, pane: w.pane, worker_workspace: w.workspaceId,
  terminal_id: w.terminalId, agent_session_id: w.agentSessionId });

// A missing/denied process source is unknown, never proof of death. Compare
// kernel birth identities when saved; a successful PID probe alone is weaker.
export function sessionAlive(owner, { kill = process.kill, readProcess = pid => lookupProcess(pid, { identityOnly: true }) } = {}) {
  if (!positive(owner?.pid)) return true;
  const probe = () => {
    try { kill(owner.pid, 0); return 'present'; }
    catch (e) { return e.code === 'ESRCH' ? 'gone' : 'unknown'; }
  };
  const exists = probe();
  if (exists !== 'present') return exists !== 'gone';
  if (typeof owner.identity !== 'string' || !owner.identity.trim()) return true;
  try {
    const now = readProcess(owner.pid);
    if (now?.ok && now.value?.pid === owner.pid && typeof now.value.identity === 'string' && now.value.identity.trim()) {
      // Old Linux tick-only receipts cannot prove boot continuity.
      if (/^\d+$/.test(owner.identity) && /^[a-f0-9-]{36}:\d+$/i.test(now.value.identity)) return true;
      return owner.identity === now.value.identity;
    }
  } catch { /* Unknown stays occupied, unless a fresh probe proves ESRCH. */ }
  return probe() !== 'gone';
}

export function countSessions({ state, journals = [], reviewers = [], common, agent, processInfo,
  projectIdentity = cwd => gitProject(cwd).identity, ...liveness }) {
  common = canonical(common);
  const sessions = [], jobs = new Map(journals.filter(j => j.run).map(j => [j.run, j]));
  const belongs = (identity, cwd) => {
    if (identity) return canonical(identity) === common;
    try { return canonical(projectIdentity(cwd)) === common; }
    catch { return true; } // Unreadable legacy project evidence cannot free capacity.
  };
  const add = candidate => {
    if (!sessionAlive(candidate.process, liveness)) return;
    const duplicate = sessions.find(s => candidate.identity?.agent_session_id && s.identity?.agent_session_id
      ? candidate.identity.agent_session_id === s.identity.agent_session_id
      : candidate.identity?.terminal_id && candidate.identity.terminal_id === s.identity?.terminal_id);
    if (duplicate) { duplicate.runs = [...new Set([...duplicate.runs, candidate.run])]; return; }
    sessions.push({ ...candidate, runs: [candidate.run] });
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
    } catch { /* Missing native evidence counts as an unknown live session. */ }
    add({ run: run.id, kind: 'worker', identity: launch, process: owner ?? null,
      evidence: owner ? 'native process' : job?.stage === 'launching' ? 'uncertain launch' : 'unknown liveness' });
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

function readJSON(directory, filter = name => name.endsWith('.json')) {
  let files;
  try { files = fs.readdirSync(directory); }
  catch (e) { if (e.code === 'ENOENT') return []; throw e; }
  return files.filter(filter).sort().map(name => JSON.parse(fs.readFileSync(path.join(directory, name), 'utf8')));
}

export function checkSessionCap({ config, org, ...options }) {
  const cap = config.dispatch?.max_sessions ?? DEFAULT_SESSION_CAP;
  if (!positive(cap)) throw Error('dispatch.max_sessions must be a positive integer');
  let sessions;
  try {
    sessions = countSessions({ ...options, state: fold(loadEvents(org).events),
      journals: readJSON(path.join(org, 'dispatch'), name => name.endsWith('.json') && !name.endsWith('.routes.json')),
      reviewers: readJSON(path.join(org, 'retirement/occupants')) });
  } catch (e) { throw Error(`session count unavailable: ${e.message}`); }
  const evidence = { cap, count: sessions.length, sessions };
  if (sessions.length >= cap) {
    const runs = [...new Set(sessions.flatMap(s => s.runs))].sort((a, b) => Number(a.slice(2)) - Number(b.slice(2)));
    const error = Error(`session cap ${cap} reached: ${runs.join(', ')} (counted ${sessions.filter(s => s.kind === 'worker').length} workers, ${sessions.filter(s => s.kind === 'reviewer').length} settle reviewers; unknown liveness counts as alive)`);
    error.code = 'DISPATCH_SESSION_CAP';
    error.sessions = evidence;
    throw error;
  }
  return evidence;
}
