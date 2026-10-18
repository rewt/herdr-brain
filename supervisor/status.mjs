// Shared read-only projection for the CLI and minimal console profile.
// Session metadata supplies display fields only, never cycle decisions.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { gitProject } from '../lib/project.mjs';
import { findOrgDir, loadEvents, readConfig } from '../lib/store.mjs';
import { fold } from '../lib/state.mjs';
import { sanitizeTerminal } from '../lib/sanitize.mjs';
import { loadTimeout } from '../lib/deadline.mjs';
import { queueJobs } from '../promote/promote.mjs';
import { receiptDirectory } from './context.mjs';
import { autopilotSettings } from './autopilot.mjs';
import { readConfig as housekeepingConfig } from '../housekeeping/config.mjs';
import { approvalPolicy } from '../lib/discernment.mjs';
import { publishedSummaryStatus } from '../lib/project-summary.mjs';
import { renderPublishedSummaryStatus } from '../lib/render.mjs';
import { effectiveWorkerIdentity } from '../lib/worker-identity.mjs';

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const timestamp = value => typeof value === 'string' && Number.isFinite(Date.parse(value));
const optionalTimestamp = value => value === undefined || timestamp(value);
function validActionReceipt(saved) {
  return object(saved) && typeof saved.key === 'string' && typeof saved.policy === 'string' &&
    timestamp(saved.started) && optionalTimestamp(saved.finished) && Array.isArray(saved.actions) &&
    saved.actions.every(a => object(a) && typeof a.name === 'string' && typeof a.phase === 'string' &&
      timestamp(a.at) && optionalTimestamp(a.finished));
}

const live = agent => ['working', 'idle', 'blocked'].includes(agent?.agent_status);
const samePath = (a, b) => {
  if (!a || !b) return false;
  try { return fs.realpathSync(a) === fs.realpathSync(b); } catch { return a === b; }
};
const occupantMatches = (saved, agent) =>
  (!saved.agent_session_id || saved.agent_session_id === agent.agent_session?.value) &&
  (!saved.terminal_id || saved.terminal_id === agent.terminal_id) &&
  (!saved.pane || saved.pane === agent.pane_id) &&
  (!saved.workspace || saved.workspace === agent.workspace_id);
const sameDay = (a, b) => timestamp(a) && new Date(a).toDateString() === new Date(b).toDateString();

export function supervisorStatus({ cwd = process.cwd(), org, herdr = 'herdr', agents, now = new Date().toISOString() } = {}) {
  const project = gitProject(cwd), warnings = [];
  org = org ?? findOrgDir({ cwd });
  if (!org) throw Error('no record discovered');
  org = fs.realpathSync(org);
  const read = file => {
    try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') warnings.push(`${file}: ${error.message}`); return null; }
  };
  const files = directory => {
    try { return fs.readdirSync(directory).filter(f => f.endsWith('.json')); }
    catch (error) { if (error.code !== 'ENOENT') warnings.push(`${directory}: ${error.message}`); return []; }
  };
  const { events, tornTail } = loadEvents(org), state = fold(events);
  if (tornTail) warnings.push('Incomplete record tail; status uses complete events only.');
  if (agents === undefined) {
    try {
      const r = spawnSync(herdr, ['agent', 'list'], { encoding: 'utf8', timeout: loadTimeout(5000), maxBuffer: 4 * 1024 * 1024 });
      if (r.error || r.status !== 0) throw Error(r.stderr || r.error?.message || `exit ${r.status}`);
      agents = JSON.parse(r.stdout).result?.agents;
      if (!Array.isArray(agents)) throw Error('unrecognised agent list');
    } catch (error) { warnings.push(`Herdr unavailable: ${error.message}`); agents = []; }
  }
  const queue = read(path.join(project.identity, 'promote/queue.json'));
  let jobs = [];
  if (queue) {
    if (queue.identity !== project.identity) warnings.push('Promotion queue identity differs; stages omit it.');
    else try { jobs = queueJobs(queue); } catch (error) { warnings.push(`Promotion queue: ${error.message}`); }
  }
  const settleDir = path.join(org, 'settle'), settlements = new Map(), fixes = new Set();
  for (const name of files(settleDir).filter(name => /^R-\d+\.json$/.test(name))) {
    const saved = read(path.join(settleDir, name));
    if (saved?.common !== project.identity || name !== `${saved.run}.json`) continue;
    settlements.set(saved.run, saved);
    if (saved.result?.result === 'fix_round' && saved.result.fix?.run) fixes.add(saved.result.fix.run);
  }
  const sessionsDir = path.join(project.canonical, '.lane/sessions.json.d');
  const names = files(sessionsDir), done = new Set(names.filter(n => n.endsWith('.done.json')).map(n => n.slice(0, -10)));
  const legacySessions = read(path.join(project.canonical, '.lane/sessions.json'));
  if (legacySessions && !Array.isArray(legacySessions)) warnings.push('Legacy lane sessions are not an array; display omits them.');
  const sessions = [...(Array.isArray(legacySessions) ? legacySessions : []),
    ...names.filter(n => !n.endsWith('.done.json')).map(n => read(path.join(sessionsDir, n)))].filter(s =>
    s && s.repo_id === project.identity && !s.done && !done.has(s.session_id));
  const lanes = [];
  for (const run of state.runs.values()) {
    const item = state.items.get(run.item);
    if (run.abandoned || item?.runs.at(-1) !== run.id || (!run.workspace && !run.meta.lane)) continue;
    const saved = settlements.get(run.id), job = jobs.findLast(j => j.run === run.id && j.org === org);
    if (item.closed && job?.outcome !== 'promoted') continue;
    const checkoutPresent = Boolean(run.workspace && fs.existsSync(run.workspace));
    // Old completed record-only lanes with no retained cycle evidence are
    // history, not active lanes. Missing no-report work remains visible.
    if (!checkoutPresent && !job && !saved && run.report?.outcome === 'done') continue;
    let binding = saved?.common;
    if (checkoutPresent) {
      try { binding = gitProject(run.workspace).identity; } catch {}
    }
    if (!binding && run.meta.dispatch_journal) {
      const dispatch = read(run.meta.dispatch_journal);
      if (dispatch?.run === run.id && dispatch.workspace === run.workspace) binding = dispatch.common;
    }
    if (binding && binding !== project.identity) continue;
    if (!binding) warnings.push(`${run.id}: repository binding unavailable; inspect ${run.workspace ?? 'record-only lane'}`);
    const candidates = agents.filter(a => samePath(a.cwd, run.workspace));
    const identity = effectiveWorkerIdentity(run, state);
    if (identity.identity_conflict) warnings.push(`${run.id}: conflicting recorded worker identity`);
    const worker = !identity.identity_conflict && candidates.find(a => occupantMatches(identity, a) &&
      (identity.agent_session_id || identity.terminal_id || a.name === identity.agent));
    const sessionFor = (a, route) => sessions.filter(s => s.name === a.name && occupantMatches(s, a) && (!route || (s.route ?? s.role) === route))
      .sort((a, b) => String(b.created_at ?? '').localeCompare(String(a.created_at ?? '')))[0];
    const reviewRoute = saved?.reviewRoute ?? saved?.review?.route ?? 'review';
    const reviewing = ['review', 'reviewing', 'commit-review', 'decide'].includes(saved?.stage);
    // A configured route is opaque. Verify the occupant before using its route,
    // and rank working reviewers ahead of idle sessions from previous rounds.
    const reviewers = reviewing ? candidates.filter(a => live(a) && sessions.some(s =>
      s.name === a.name && (s.route ?? s.role) === reviewRoute &&
      (s.agent_session_id || s.terminal_id) && occupantMatches(s, a)))
      .sort((a, b) => Number(b.agent_status === 'working') - Number(a.agent_status === 'working') ||
        String(sessionFor(b, reviewRoute)?.created_at ?? '').localeCompare(String(sessionFor(a, reviewRoute)?.created_at ?? ''))) : [];
    const agent = reviewing ? reviewers[0] : worker;
    const session = agent && sessionFor(agent, reviewing ? reviewRoute : null);
    const inProgress = saved && saved.stage !== 'complete' && !saved.result;
    const blocked = ['refused', 'interrupted', 'timeout'].includes(job?.outcome) ||
      ['escalate', 'stopped'].includes(saved?.result?.result) ||
      (run.report && run.report.outcome !== 'done') || agent?.agent_status === 'blocked';
    const landed = job?.outcome === 'promoted';
    const integrated = landed ? job.integrated_at ?? job.finished : null;
    if (landed && !sameDay(integrated, now)) continue;
    // A retained checkout or a finished settlement is not evidence of activity.
    // Completed reports without a live occupant belong in the report feed.
    if (run.report && !landed && !job && !inProgress && !blocked && !live(agent) && !['promotable', 'promotable_with_findings'].includes(saved?.result?.result)) continue;
    const stage = landed ? 'landed' : blocked ? 'blocked' : job ? 'train'
      : ['fix', 'dispatching'].includes(saved?.stage) ? 'fix'
        : inProgress ? 'review' : ['promotable', 'promotable_with_findings'].includes(saved?.result?.result) ? 'train'
          : run.report ? 'review' : fixes.has(run.id) ? 'fix' : 'engineering';
    if (item.closed && stage !== 'landed') continue;
    const started = session?.created_at ?? run.started.at;
    const end = landed ? integrated : blocked && !live(agent) ? run.report?.at ?? now : now;
    lanes.push({ run: run.id, item: run.item, title: item?.title ?? '', lane: run.meta.lane ?? saved?.lane ?? null, stage,
      provider: agent?.agent ?? session?.harness ?? (reviewing ? null : run.meta.harness) ?? null,
      model: agent?.model ?? session?.model ?? (reviewing ? null : run.meta.model) ?? null,
      started, run_started: run.started.at, integrated_at: integrated,
      running_seconds: Math.max(0, (Date.parse(end) - Date.parse(started)) / 1000) || 0,
      live_status: agent?.agent_status ?? 'unknown', agent: agent?.name ?? (reviewing ? null : run.meta.agent) ?? null,
      pane: agent?.pane_id ?? (reviewing ? null : run.meta.pane) ?? null, workspace: run.workspace,
      evidence: job ? path.join(project.identity, 'promote/queue.json') : saved ? path.join(settleDir, `${run.id}.json`) : null });
  }
  const active = lanes.filter(r => r.stage !== 'landed').sort((a, b) => b.run_started.localeCompare(a.run_started));
  const landed = lanes.filter(r => r.stage === 'landed').sort((a, b) => b.integrated_at.localeCompare(a.integrated_at));
  const actionDir = path.join(receiptDirectory(org, project.identity), 'autopilot');
  const actions = files(actionDir).map(name => ({ receipt: path.join(actionDir, name), saved: read(path.join(actionDir, name)) }))
    .filter(({ saved }) => saved?.project?.identity === project.identity && saved.project.org === org)
    .filter(({ receipt, saved }) => {
      if (validActionReceipt(saved)) return true;
      warnings.push(`Damaged autopilot action receipt: ${receipt}; display omits it.`); return false;
    })
    .sort((a, b) => Date.parse(b.saved.finished ?? b.saved.started) - Date.parse(a.saved.finished ?? a.saved.started)).slice(0, 10)
    .map(({ receipt, saved }) => ({ receipt, key: saved.key, at: saved.finished ?? saved.started, policy: saved.policy,
      disposition: saved.disposition ?? 'uncertain', reason: saved.reason ?? 'inspect started sequence',
      actions: saved.actions.map(a => ({ name: a.name, phase: a.phase, at: a.finished ?? a.at })) }));
  let enabled = false, reason;
  try {
    const settings = autopilotSettings(project.canonical);
    enabled = settings.enabled;
    if (!enabled) reason = 'project kill switch';
    else if (settings.cohort !== 'clean-pass') { enabled = false; reason = `cohort ${settings.cohort ?? 'unset'}`; }
    else if (fs.existsSync(path.join(project.canonical, '.lane/supervisor/STOP'))) { enabled = false; reason = 'STOP'; }
    else if (!housekeepingConfig(path.join(project.canonical, '.housekeeping.json')).enabled) { enabled = false; reason = 'housekeeping paused'; }
    else if (approvalPolicy(readConfig(org), 'tooling') !== 'auto') { enabled = false; reason = 'tooling requires operator authority'; }
  } catch (error) { warnings.push(error.message); reason = error.message; }
  return { project: { ...project, org, as_of: now }, lanes: [...active, ...landed], autopilot: { enabled, reason: reason ?? null, actions },
    published_summary: publishedSummaryStatus(org, { now, project }), warnings };
}

const line = value => sanitizeTerminal(String(value ?? '?')).replace(/\s+/g, ' ').slice(0, 120);
const duration = seconds => seconds < 60 ? `${Math.floor(seconds)}s` : seconds < 3600 ? `${Math.floor(seconds / 60)}m` : `${Math.floor(seconds / 3600)}h ${Math.floor(seconds % 3600 / 60)}m`;
export function renderStatus(doc) {
  const rows = [['RUN', 'ITEM', 'LANE', 'STAGE', 'PROVIDER', 'MODEL', 'STARTED', 'RUNNING'],
    ...doc.lanes.map(r => [r.run, r.item, r.lane, r.stage, r.provider, r.model, r.started, duration(r.running_seconds)])].map(row => row.map(line));
  const widths = rows[0].map((_, i) => Math.max(...rows.map(r => r[i].length)));
  return [`Supervisor status · ${doc.project.canonical}`, ...rows.map(r => r.map((cell, i) => cell.padEnd(widths[i])).join('  ').trimEnd()),
    ...(doc.published_summary ? [renderPublishedSummaryStatus(doc.published_summary).trimEnd()] : []),
    `Autopilot: ${doc.autopilot.enabled ? 'enabled' : `disabled (${doc.autopilot.reason})`}`,
    ...doc.autopilot.actions.map(a => `  ${a.at} ${line(a.key)} ${a.disposition}: ${line(a.reason)}${a.actions.length ? ` (${a.actions.map(step => `${step.name}: ${step.phase}`).join('; ')})` : ''} · ${a.receipt}`),
    ...doc.warnings.map(w => `  ${line(w)}`)].join('\n') + '\n';
}
