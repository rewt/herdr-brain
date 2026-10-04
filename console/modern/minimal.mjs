// Display-only session facts. Ownership always comes from canonical Git identity.
import { workspaceIdentity } from './model.mjs';
import { pad, sanitize, cellWidth, clipStart } from '../lib/text.mjs';

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

export function minimalFrame({ project, sessions = [], runs = [], reports = [], train = {}, errors = {}, loading = false, now = Date.now() }, cols, height) {
  const width = Math.max(1, cols), rows = Math.max(1, height), content = Math.min(width, 116);
  const fit = (text, n) => pad(sanitize(text), n);
  const line = (parts, bold = false) => {
    if (typeof parts === 'string') parts = [{ text: parts, fg: 'text' }];
    let remaining = width;
    const spans = parts.map(part => {
      const text = fit(part.text, Math.min(remaining, cellWidth(sanitize(part.text))));
      remaining -= cellWidth(text);
      return { ...part, text, bg: 'bg', bold };
    });
    if (remaining) spans.push({ text: ' '.repeat(remaining), fg: 'text', bg: 'bg' });
    return { spans };
  };
  const muted = text => line([{ text, fg: 'muted' }]);
  const work = runs;
  const open = work.filter(r => r.stage !== 'landed');
  const context = sessions.filter(s => ['supervisor', 'chat'].includes(s.stage));
  const provider = s => `${s.provider}${s.model ? ` ${shortModel(s.model)}` : ''}`;
  const blocks = [[], [], []];
  const compact = content < 90;
  const stacked = content < 54;
  const runW = Math.max(5, ...work.map(r => cellWidth(clean(r.run))));
  const stageW = 11, providerW = content < 80 ? 11 : 14, startedW = 5, runningW = 7;
  const itemW = Math.max(1, content - runW - stageW - providerW - startedW - runningW - 5);
  const running = r => duration(new Date(now - r.running_seconds * 1000).toISOString(), now);
  const started = r => {
    const ms = timestamp(r.started);
    if (ms === null) return '?';
    const d = new Date(ms);
    return d.toDateString() === new Date(now).toDateString()
      ? `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
      : `${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')}`;
  };
  const runProvider = r => `${/claude/i.test(r.provider ?? '') ? 'Claude' : /codex/i.test(r.provider ?? '') ? 'Codex' : clean(r.provider) || '?'}${r.model ? ` ${shortModel(r.model)}` : ''}`;
  const cells = (r, header = false) => {
    const fg = r.stage === 'blocked' ? 'amber' : header || r.stage === 'landed' ? 'muted' : 'text';
    const dim = r.stage === 'landed';
    const values = header ? ['RUN', 'ITEM', 'STAGE', 'PROVIDER', 'START', 'RUNNING']
      : [r.run, `${r.item} ${shortTitle(r.title)}`, r.stage, runProvider(r), started(r), running(r)];
    if (stacked) return [
      line([{ text: fit(header ? 'RUN / ITEM' : `${r.run} ${values[1]}`, content), fg, dim }]),
      line([{ text: [fit(values[2], stageW), fit(values[3], 11), fit(values[4], startedW), fit(values[5], runningW)].join(' '), fg, dim }]),
    ];
    return [line([{ text: values.map((v, i) => fit(v, [runW, itemW, stageW, providerW, startedW, runningW][i])).join(' '), fg, dim }])];
  };
  if (work.length) blocks[0].push(...cells({}, true), ...work.flatMap(r => cells(r)));
  else blocks[0].push(muted(loading ? 'Reading runs…' : 'No open runs'));
  for (const r of reports) {
    const meta = `${startText(r.at, now)}  ${r.run ?? '?'} ${r.item ?? '?'}  `;
    const result = `${r.outcome} / ${r.check}`;
    const state = [{ text: meta, fg: 'muted' }, { text: result, fg: r.attention || r.check === 'fail' ? 'amber' : r.check === 'pass' ? 'teal' : 'muted' }];
    if (compact) {
      blocks[1].push(line(state));
      blocks[1].push(line(fit(`  ${clean(r.headline)}`, content)));
    } else {
      const metaW = Math.min(57, Math.max(44, cellWidth(meta + result) + 2));
      blocks[1].push(line([...state, { text: ' '.repeat(Math.max(2, metaW - cellWidth(meta + result))) + fit(clean(r.headline), content - metaW), fg: 'text' }]));
    }
  }
  if (!reports.length) blocks[1].push(muted(loading ? 'Reading reports…' : 'No recent reports'));
  const c = train.current;
  if (c) {
    blocks[2].push(line(`Batch · ${c.lanes.join(', ')} · ${c.phase}`));
    blocks[2].push(muted(`  started ${startText(c.started, now)} · ${duration(c.started, now)} · CI ${c.command ?? 'unknown'}`));
    if (c.command) blocks[2].push(muted(`  check started ${startText(c.checkStarted, now)} · ${duration(c.checkStarted, now)}`));
  } else blocks[2].push(muted('No batch running'));
  blocks[2].push(muted(`Waiting · ${train.waiting?.length ? train.waiting.map(j => j.topic).join(', ') : 'none'}`));
  for (const b of train.interrupted ?? []) blocks[2].push(line([{ text: `! interrupted · ${(b.jobs ?? []).map(j => j.topic).join(', ')} · inspect receipt`, fg: 'amber' }]));
  for (const r of (train.results ?? []).slice(0, 3)) {
    blocks[2].push(line([{ text: `${startText(r.at, now)}  ${r.topic ?? '?'}  `, fg: 'muted' },
      { text: r.outcome, fg: r.outcome === 'promoted' ? 'teal' : 'amber' },
      { text: r.outcome === 'promoted' ? '' : ` · ${clean(r.reason)}`, fg: 'text' }]));
    if (r.outcome !== 'promoted') blocks[2].push(muted(`  log ${clipStart(r.log ?? r.receipt ?? 'unknown', content - 6)}`));
  }
  const contextText = context.length ? `Context · ${[
    ...context.filter(s => s.stage === 'supervisor').map(s => `supervisor ${provider(s)}`),
    context.some(s => s.stage === 'chat') ? `${context.filter(s => s.stage === 'chat').length} chats` : null,
  ].filter(Boolean).join(' · ')}` : '';
  const messages = Object.keys(errors).map(source => muted(`${source} unavailable · showing last known data`));
  const lines = [line(`${project?.name ?? 'Project'} · ${open.length} open · ${reports.filter(r => r.attention).length} need attention`, true)];
  if (contextText) lines.push(muted(contextText));
  // Give each section space before spending spare rows on recent history. A
  // small pane always retains all three headings and counts omitted lines.
  const separated = rows >= 18;
  const available = Math.max(0, rows - lines.length - (separated ? 6 : 3) - messages.length - 1);
  const caps = blocks.map(() => 0);
  const minimums = [work.length ? (stacked ? 4 : 2) : 1, compact ? 2 : 1, c ? 3 : 2];
  let left = available;
  for (let pass = 0; pass < Math.max(...minimums) && left; pass++) for (let i = 0; i < 3 && left; i++) {
    if (caps[i] < Math.min(blocks[i].length, minimums[i])) { caps[i]++; left--; }
  }
  while (left && caps.some((cap, i) => cap < blocks[i].length)) for (const i of [0, 1, 2]) {
    if (left && caps[i] < blocks[i].length) { caps[i]++; left--; }
  }
  if (compact) {
    if (work.length && stacked) caps[0] -= caps[0] % 2;
    if (reports.length) caps[1] -= caps[1] % 2;
  }
  const headings = [`Runs · ${open.length} open${work.length > open.length ? ` · ${work.length - open.length} landed` : ''}`, `Reports · recent ${reports.length} · outcome / check`, 'Train'];
  for (let i = 0; i < 3; i++) {
    const hidden = blocks[i].length - caps[i];
    if (separated) lines.push(muted(''));
    lines.push(line(`${headings[i]}${hidden ? ` · +${hidden} lines` : ''}`, true), ...blocks[i].slice(0, caps[i]));
  }
  lines.push(...messages);
  while (lines.length < rows - 1) lines.push(muted(''));
  const bounded = lines.slice(0, rows - 1);
  bounded.push(muted('q quit'));
  return { lines: bounded, hits: [], controls: [] };
}
