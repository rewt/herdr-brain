// Display-only session facts. Ownership always comes from canonical Git identity.
import { workspaceIdentity } from './model.mjs';
import { pad, sanitize } from '../lib/text.mjs';

const clean = value => sanitize(value).replace(/\s+/g, ' ').trim();
const timestamp = value => {
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
};

export function duration(started, now) {
  const start = timestamp(started);
  if (start === null) return 'unknown';
  const minutes = Math.max(0, Math.floor((now - start) / 60000));
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ${minutes % 60}m`;
  return `${Math.floor(hours / 24)}d ${hours % 24}h`;
}

export function sessionStage(agent, run, lane, dispatch) {
  const roles = [agent.role, lane?.role, run?.meta?.role, run?.meta?.stage].map(x => clean(x).toLowerCase());
  if (roles.some(x => /^(review(?:er)?|settle)(?:-|$)/.test(x)) || /^(settle-r-\d+|review(?:er)?-)/i.test(agent.name ?? '')) return 'review';
  if (roles.includes('supervisor') || /^supervisor(?:-|$)/i.test(agent.name ?? '')) return 'supervisor';
  if (roles.some(x => ['fix', 'correction'].includes(x)) || dispatch?.fromRun || run?.meta?.from_run) return 'fix';
  if (run || roles.some(x => /^(engineer(?:ing)?|worker)(?:-|$)/.test(x))) return 'engineering';
  return 'chat';
}

export function minimalRows({ project, agents = [], workspaces = [], panes = [], tabs = [], status, identity,
  details = () => ({}), now = Date.now() }) {
  if (!project?.repoKey) return [];
  const spaces = new Set(workspaces.filter(w => workspaceIdentity(w, identity)?.key === project.repoKey).map(w => w.workspace_id));
  // Herdr can list a named launch-pending shell before an agent is detected.
  const own = agents.filter(a => (a.tool || a.session) && (a.cwd ? identity(a.cwd)?.key === project.repoKey : spaces.has(a.workspace)));
  return own.map(agent => {
    // A session ID, when recorded, prevents a reused pane/name inheriting old work.
    const runs = (status?.runs ?? []).filter(r => (!r.workspace || identity(r.workspace)?.key === project.repoKey)
      && (!r.meta?.agent_session_id || r.meta.agent_session_id === agent.session)
      && ((agent.name && r.meta?.agent === agent.name) || (agent.pane && r.meta?.pane === agent.pane)));
    const run = runs.sort((a, b) => (timestamp(b.started?.at) ?? 0) - (timestamp(a.started?.at) ?? 0))[0];
    const { lane, transcript, dispatch } = details(agent, run) ?? {};
    const stage = sessionStage(agent, run, lane, dispatch);
    const busy = ['working', 'blocked'].includes(agent.status);
    if (!busy && ((run && (run.report || run.abandoned)) || (agent.status === 'done' && ['engineering', 'review', 'fix'].includes(stage)))) return null;
    const model = clean(transcript?.model ?? lane?.model ?? run?.meta?.model ?? agent.model);
    const tool = clean(agent.tool ?? run?.meta?.harness).toLowerCase();
    const provider = /claude/.test(tool) ? 'Claude' : /codex/.test(tool) ? 'Codex' : 'unknown';
    const started = [lane?.created_at, lane?.started_at, lane?.started, transcript?.firstAt, agent.started, run?.started?.at].find(x => timestamp(x) !== null) ?? null;
    const label = panes.find(p => p.pane_id === agent.pane)?.label;
    const topic = lane?.topic ?? run?.meta?.lane;
    const name = clean(label || (topic ? `${stage === 'review' ? 'review' : 'lane'} ${topic}` : agent.name)
      || tabs.find(t => t.tab_id === agent.tab)?.label || agent.title || agent.pane);
    return { pane: agent.pane, name, provider, model, stage, started, elapsed: duration(started, now), working: agent.status === 'working' };
  }).filter(Boolean).sort((a, b) => Number(b.working) - Number(a.working)
    || (timestamp(b.started) ?? -Infinity) - (timestamp(a.started) ?? -Infinity) || a.name.localeCompare(b.name) || String(a.pane).localeCompare(String(b.pane)));
}

function startText(iso, now) {
  const ms = timestamp(iso);
  if (ms === null) return 'unknown';
  const d = new Date(ms), today = new Date(now);
  const time = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  return d.toDateString() === today.toDateString() ? time : `${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')} ${time}`;
}

export function minimalFrame({ project, sessions = [], errors = {}, loading = false, now = Date.now() }, cols, height) {
  const width = Math.max(1, cols), rows = Math.max(1, height);
  const fit = (text, n) => pad(sanitize(text), n);
  const lines = [];
  const add = (text, fg = 'text', bold = false) => lines.push({ spans: [{ text: fit(text, width), fg, bg: 'bg', bold }] });
  add(`${project?.name ?? 'Sessions'} · ${sessions.length} active`, 'text', true);
  add('');
  if (width < 80) {
    add('Enlarge pane to 80 columns for session columns', 'muted');
    while (lines.length < rows - 1) add('');
    add('q quit', 'muted');
    return { lines: lines.slice(0, rows), hits: [], controls: [] };
  }
  // Five columns at 80 cells: 21 / 21 / 11 / 11 / 8, separated by two spaces.
  const stageW = 11, startW = 11, elapsedW = 8;
  const flexible = Math.max(2, width - stageW - startW - elapsedW - 8);
  const nameW = Math.max(1, Math.floor(flexible * .5)), providerW = Math.max(1, flexible - nameW);
  const table = cells => cells.map((v, i) => fit(v, [nameW, providerW, stageW, startW, elapsedW][i])).join('  ');
  add(table(['Session', 'Provider / model', 'Stage', 'Started', 'Running']), 'muted');
  const messages = Object.entries(errors).map(([source]) => `${source} unavailable · showing last known data`);
  const capacity = Math.max(0, rows - 5 - messages.length);
  const shown = sessions.slice(0, capacity);
  for (const s of shown) add(table([s.name, `${s.provider}${s.model ? ` ${s.model}` : ''}`, s.stage, startText(s.started, now), s.elapsed]), s.working ? 'text' : 'muted');
  if (!sessions.length && capacity) add(loading ? 'Reading sessions…' : 'No active sessions', 'muted');
  for (const message of messages) add(message, 'muted');
  while (lines.length < rows - 1) add('');
  add(`${sessions.length > shown.length ? `+${sessions.length - shown.length} more · enlarge pane   ` : ''}q quit`, 'muted');
  return { lines: lines.slice(0, rows), hits: [], controls: [] };
}
