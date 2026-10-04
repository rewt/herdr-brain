// Display-only session facts. Ownership always comes from canonical Git identity.
import { workspaceIdentity } from './model.mjs';
import { sanitize } from '../lib/text.mjs';

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
  const items = new Map((status?.items ?? []).map(i => [i.id, i]));
  return own.map(agent => {
    // A session ID, when recorded, prevents a reused pane/name inheriting old work.
    const runs = (status?.runs ?? []).filter(r => (!r.workspace || identity(r.workspace)?.key === project.repoKey)
      && (!r.meta?.agent_session_id || r.meta.agent_session_id === agent.session)
      && (r.meta?.agent_session_id ? r.meta.agent_session_id === agent.session
        : r.meta?.agent ? r.meta.agent === agent.name : false));
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
    // A review's subject can be shown from its lane without treating the
    // reviewer as the worker that owns that run (or inheriting its lifecycle).
    const subject = stage === 'review' && !run && topic ? (status?.runs ?? [])
      .filter(r => r.meta?.lane === topic && (!r.workspace || identity(r.workspace)?.key === project.repoKey))
      .sort((a, b) => (timestamp(b.started?.at) ?? 0) - (timestamp(a.started?.at) ?? 0))[0] : null;
    const item = run?.item ?? lane?.item ?? subject?.item;
    const title = shortTitle(items.get(item)?.title ?? topic ?? lane?.goal ?? name);
    return { pane: agent.pane, name, run: run?.id ?? lane?.run ?? subject?.id ?? null, item: item ?? null, title,
      provider, model, stage, started, elapsed: duration(started, now), working: agent.status === 'working', blocked: agent.status === 'blocked' };
  }).filter(Boolean).sort((a, b) => Number(b.working) - Number(a.working)
    || (timestamp(b.started) ?? -Infinity) - (timestamp(a.started) ?? -Infinity) || a.name.localeCompare(b.name) || String(a.pane).localeCompare(String(b.pane)));
}

export function startText(iso, now) {
  const ms = timestamp(iso);
  if (ms === null) return 'unknown';
  const d = new Date(ms), today = new Date(now);
  const time = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  return d.toDateString() === today.toDateString() ? time : `${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')} ${time}`;
}

export function shortTitle(value) {
  return clean(value).split(/\s*\(operator\b|:\s|\s[—–]\s/i)[0];
}

export function shortModel(model) {
  const value = clean(model);
  if (/opus/i.test(value)) return 'Opus';
  if (/sonnet/i.test(value)) return 'Sonnet';
  if (/haiku/i.test(value)) return 'Haiku';
  if (/astra/i.test(value)) return 'Astra';
  if (/luna/i.test(value)) return 'Luna';
  if (/sol/i.test(value)) return 'Sol';
  return value.replace(/^claude-|^gpt-/i, '');
}

// The live view and --print share this Ink tree.
export { minimalFrame, minimalTree, minimalLayout } from './minimal-view.mjs';
