// Read-only adapters. Never use registry sidecars, labels, or native transcripts.
import path from 'node:path';
import { HerdrClient, herdrSocketPath } from '../lanes/board/herdr-client.mjs';
import { findOrgDir, loadEvents } from '../lib/store.mjs';
import { fold } from '../lib/state.mjs';
import { workerIdentityEvidence } from '../lib/worker-identity.mjs';
import { readPlainFile } from '../lib/files.mjs';
import { readReport } from '../lib/report.mjs';
import { readInbox } from '../supervisor/prompt-supervisor.mjs';
import { readDeclaredReferences } from '../lib/retire-runtime.mjs';
import { queueJobs } from '../promote/promote.mjs';
import { retirementHold } from '../lib/retire-hold.mjs';
import { canonicalProject } from './project.mjs';
import { parseUniqueJson } from './json.mjs';
import { present } from './runtime.mjs';

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
    const saved = parseUniqueJson(readPlainFile(file));
    if (saved.identity !== project.common || !Array.isArray(saved.pending) || !Array.isArray(saved.results)) throw Error('invalid canonical promotion queue');
    return queueJobs(saved);
  });
  for (const job of queue ?? []) if (!['promoted', 'cancelled'].includes(job.outcome)) references.references.push({
    kind: 'promotion', job: job.id, item: job.item, run: job.run, cwd: job.cwd });
  const stopped = attempt('STOP', () => [org && path.join(org, 'STOP'), path.join(project.root, '.lane/supervisor/STOP')].filter(Boolean).some(present));
  const closeHold = retirementHold(project.root);
  return { record: { runs: [...state.runs.values()], items: [...state.items.values()], links: state.links, revision: state.eventCount,
    ...workerIdentityEvidence(state) },
    dispatches, reports, watches, watchNotices: inbox ?? [], references: references.references,
    stopped: stopped ?? true, closeHold, errors };
}
