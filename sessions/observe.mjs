// Read-only adapters. Never use registry sidecars, labels, or native transcripts.
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { HerdrClient, herdrSocketPath } from '../lanes/board/herdr-client.mjs';
import { findOrgDir, loadEvents } from '../lib/store.mjs';
import { fold } from '../lib/state.mjs';
import { workerIdentityEvidence } from '../lib/worker-identity.mjs';
import { readPlainFile } from '../lib/files.mjs';
import { readReport } from '../lib/report.mjs';
import { readInbox } from '../supervisor/prompt-supervisor.mjs';
import { readDeclaredReferences, readRetirementWorktrees } from '../lib/retire-runtime.mjs';
import { readArchivalRetirementPolicy } from '../lib/retire-archive.mjs';
import { queueJobs } from '../promote/promote.mjs';
import { retirementHold } from '../lib/retire-hold.mjs';
import { canonicalProject } from './project.mjs';
import { parseUniqueJson } from './json.mjs';
import { present } from './runtime.mjs';
import { homeProject } from '../lib/config-home.mjs';

export const nativeId = a => a?.agent_session?.value ?? a?.agent_session_id;
export const agentBinding = (a, server, tab) => ({ server, workspace: a.workspace_id, tab: a.tab_id ?? tab,
  pane: a.pane_id, terminalId: a.terminal_id, agentName: a.name, nativeSessionId: nativeId(a), checkout: a.cwd });
export const sameBinding = (a, b) => Boolean(a && b && ['server', 'workspace', 'tab', 'pane', 'terminalId', 'agentName', 'nativeSessionId', 'checkout']
  .every(key => typeof a[key] === 'string' && a[key] && a[key] === b[key]));

export function createHerdrObserver({ socketPath = herdrSocketPath(), client = new HerdrClient({ socketPath }) } = {}) {
  return { async observe() {
    try {
      const snapshot = await client.snapshot();
      for (const key of ['workspaces', 'tabs', 'panes', 'agents']) if (!Array.isArray(snapshot[key])) throw Error(`incomplete Herdr snapshot: ${key}`);
      const agents = [];
      for (const listed of snapshot.agents) {
        if (!listed.name) { agents.push(listed); continue; }
        const result = await client.request('agent.get', { target: listed.name });
        if (!result?.agent || ['name', 'pane_id', 'tab_id', 'workspace_id', 'terminal_id', 'cwd'].some(k => listed[k] !== result.agent[k]) ||
            nativeId(listed) !== nativeId(result.agent)) throw Error(`agent changed during observation: ${listed.name}`);
        agents.push(result.agent);
      }
      // A snapshot is an observation, not a complete historical log. No event
      // subscription, pane read, prompt, focus or action RPC is exposed here.
      return { server: socketPath, complete: true, workspaces: snapshot.workspaces,
        tabs: snapshot.tabs, panes: snapshot.panes, agents, receipts: [], errors: [] };
    } catch (error) { return { server: socketPath, complete: false, workspaces: [], tabs: [], panes: [], agents: [], receipts: [], errors: [error.message] }; }
  }, close() { client.close(); } };
}

export function readSessionFacts({ project, env = process.env, items } = {}) {
  const binding = homeProject(project.root, env);
  if (binding) {
    if (binding.common !== project.common) throw Error('adopted session project common directory disagrees');
    env = { ...env, ORG_DIR: binding.record };
  }
  const errors = [], dispatches = {}, reports = {}, watches = {};
  const attempt = (label, fn) => { try { return fn(); } catch (error) { errors.push(`${label}: ${error.message}`); return null; } };
  const org = attempt('record discovery', () => findOrgDir({ cwd: project.root, env }));
  const loaded = org && attempt('record', () => loadEvents(org));
  if (!loaded) errors.push('readable project record required');
  if (loaded?.tornTail) errors.push('incomplete record tail');
  const state = fold(loaded?.events ?? []);
  const commons = new Map();
  for (const run of state.runs.values()) {
    if (items && !items.includes(run.item)) continue;
    // Ignore proven foreign checkouts; missing/unreadable bindings hold the
    // relevant worker rather than being promoted from a display registry.
    if (!run.workspace) continue;
    let common;
    try {
      if (!commons.has(run.workspace)) commons.set(run.workspace, canonicalProject(run.workspace).common);
      common = commons.get(run.workspace);
    } catch { continue; }
    if (common !== project.common) continue;
    if (run.meta?.dispatch_journal) {
      const saved = attempt(`dispatch ${run.id}`, () => parseUniqueJson(readPlainFile(run.meta.dispatch_journal)));
      if (saved) { dispatches[run.id] = saved; watches[run.id] = saved.watcher ?? null; }
    }
    if (run.report_path) attempt(`report ${run.id}`, () => {
      if (!present(run.report_path)) return;
      const parsed = readReport(readPlainFile(run.report_path));
      reports[run.id] = { present: true, valid: Boolean(parsed.report?.run === run.id && !parsed.errors?.length) };
    });
  }
  const inbox = org && attempt('watch receipts', () => readInbox(path.join(org, 'supervisor/inbox.log')));
  const references = org ? readDeclaredReferences(org) : { references: [], errors: [] };
  errors.push(...references.errors);
  const queue = attempt('promotion queue', () => {
    const file = path.join(project.common, 'promote/queue.json');
    if (!present(file)) return [];
    // Promotion's complete retained history needs its own byte budget.
    const saved = parseUniqueJson(readPlainFile(file), { maxBytes: 64 * 1024 * 1024 });
    if (saved.identity !== project.common || !Array.isArray(saved.pending) || !Array.isArray(saved.results)) throw Error('invalid canonical promotion queue');
    // Only pending/current/interrupted positions can still write. Retained
    // results are history, even when their last outcome was an interruption.
    return queueJobs({ ...saved, results: [] }).filter(job => {
      const result = job.result ?? job;
      // Promotion releases refusals/timeouts; promoted members can still own
      // reconciliation or lane replacement (see completion/finishBatchJob).
      if (['refused', 'timeout', 'cancelled'].includes(result.outcome)) return false;
      return result.outcome !== 'promoted' || result.reconciliation?.state === 'pending' || result.replacement_pending;
    });
  });
  for (const job of queue ?? []) references.references.push({
    kind: 'promotion', job: job.id, item: job.item, run: job.run, cwd: job.cwd });
  const stopped = attempt('STOP', () => [org && path.join(org, 'STOP'), path.join(project.root, '.lane/supervisor/STOP')].filter(Boolean).some(present));
  const closeHold = retirementHold(project.root);
  // Display evidence only. The closer observes Git and all live guards again.
  const git = [];
  if (items?.length && !closeHold) attempt('lane Git', () => {
    const main = execFileSync('git', ['-C', project.root, 'symbolic-ref', '--short', 'HEAD'],
      { encoding: 'utf8', env, timeout: 10000, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    const policy = readArchivalRetirementPolicy(project.root);
    for (const tree of readRetirementWorktrees(project.common, { main, env, sweep: true, archivalRetirement: policy.archivalRetirementPolicy })) {
      if (![...state.runs.values()].some(r => items.includes(r.item) && r.workspace === tree.worktree)) continue;
      git.push({ path: tree.worktree, common: tree.identity, clean: tree.clean, integrated: tree.integrated,
        patchIntegrated: tree.patchIntegrated, archived: tree.archiveMatchesHead === true, error: tree.error });
    }
  });
  return { record: { runs: [...state.runs.values()], items: [...state.items.values()], links: state.links, revision: state.eventCount,
    ...workerIdentityEvidence(state) },
    dispatches, reports, watches, git, watchNotices: inbox ?? [], references: references.references,
    stopped: stopped ?? true, closeHold, errors };
}
