// The items pane: a narrow, live view of an organization's work items, made to
// sit beside a supervisor chat. Agents create items with a category prefix
// (ENG, REV, ARCH, HUM...) and a reason; runs pick them up, report and close
// them. This shows those moments as they happen, with who is on each item, so
// the chat does not have to be read to know what exists. It reads through the
// org CLI and Herdr's agent list; its only effect is focusing a session in Herdr.
import { pad, clip, wrap, sanitize } from '../lib/text.mjs';
import * as cli from '../lib/cli.mjs';

const clean = t => sanitize(String(t ?? '')).replace(/\s+/g, ' ').trim();
const hhmm = at => { const d = new Date(at); return Number.isNaN(d.getTime()) ? '' : `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; };
// A time today reads 16:05; an older one carries its day.
const when = (at, now) => { const d = new Date(at); if (Number.isNaN(d.getTime())) return ''; return d.toDateString() === new Date(now).toDateString() ? hhmm(at) : `${d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })} ${hhmm(at)}`; };
const ago = (ms) => ms < 60e3 ? `${Math.max(0, Math.floor(ms / 1e3))}s` : ms < 3600e3 ? `${Math.floor(ms / 60e3)}m` : ms < 86400e3 ? `${Math.floor(ms / 3600e3)}h` : `${Math.floor(ms / 86400e3)}d`;
export const prefixOf = id => /^([A-Z]+)-\d+$/.exec(id ?? '')?.[1] ?? '';
// Category colours: a question to the operator stands out; the rest are calm.
export const categoryColor = id => ({ HUM: 'amber', ENG: 'teal', IMPL: 'teal', REV: 'blue', ARCH: 'goal', ORCH: 'muted', G: 'goal' })[prefixOf(id)] ?? 'fg';
const firstSentence = t => { const s = clean(t); const m = /^(.{20,}?[.!?])\s/.exec(s); return m ? m[1] : s; };

// The events worth a line, each with its mark and one sentence.
function entry(e, items, runs) {
  const item = items.get(e.id) ?? items.get(e.item);
  switch (e.type) {
    case 'item.added': {
      if (e.kind === 'goal') return null;
      const created = item?.created ?? {};
      return { mark: prefixOf(e.id) === 'HUM' ? '?' : '+', verb: prefixOf(e.id) === 'HUM' ? 'asks' : 'new', id: e.id, text: e.title,
        detail: [created.run ?? (e.by !== 'human' ? e.by : null), e.parent ? `under ${e.parent}` : null].filter(Boolean).join(' · '), why: created.why ?? null };
    }
    case 'run.started': {
      const m = e.meta ?? {};
      return { mark: '▶', verb: 'started', id: e.item, text: items.get(e.item)?.title ?? '', detail: [e.id, m.harness, m.model, m.lane].filter(Boolean).join(' · ') };
    }
    case 'report.ingested': {
      const r = e.report ?? {};
      return { mark: r.outcome === 'done' ? '✓' : '!', verb: r.outcome === 'done' ? 'reported' : r.outcome ?? 'reported', id: e.item, text: items.get(e.item)?.title ?? '',
        detail: [e.run, r.proposals?.length ? `${r.proposals.length} proposed` : null].filter(Boolean).join(' · '), why: r.headline ?? firstSentence(r.summary) };
    }
    case 'item.closed':
      if (items.get(e.id)?.kind === 'goal') return null;
      return { mark: e.as === 'dropped' ? '✗' : '■', verb: prefixOf(e.id) === 'HUM' ? 'answered' : e.as === 'dropped' ? 'dropped' : 'closed', id: e.id, text: items.get(e.id)?.title ?? '', why: e.note ?? null };
    case 'note.added':
      return e.decision ? { mark: '◆', verb: 'decided', id: e.id, text: items.get(e.id)?.title ?? '', why: e.text } : null;
    case 'run.abandoned':
      return { mark: '✗', verb: 'abandoned', id: runs.get(e.id)?.item, text: '', detail: e.id };
    default:
      return null;
  }
}

// Everything the pane shows, derived from `org status --json`, recent `org log`
// events and Herdr's agents. Pure, so it is tested without a server.
export function feedModel({ status, events = [], agents = [], now = Date.now(), filter = null }) {
  const items = new Map((status?.items ?? []).map(i => [i.id, i]));
  const runs = new Map((status?.runs ?? []).map(r => [r.id, r]));
  const live = new Map(agents.filter(a => a.name).map(a => [a.name, a]));
  const decide = [...items.values()].filter(i => i.role === 'human' && !i.closed && !['done', 'dropped'].includes(i.status))
    .map(i => ({ id: i.id, text: i.title, asked: i.created?.at, by: i.created?.run ?? null, recommend: i.meta?.recommend ?? null }));
  const running = [...runs.values()].filter(r => !r.report && !r.abandoned && r.started).map(r => {
    const agent = live.get(r.meta?.agent);
    return { run: r.id, id: r.item, text: items.get(r.item)?.title ?? '', agent: r.meta?.agent ?? null, pane: agent?.pane ?? r.meta?.pane ?? null,
      state: agent ? agent.status : now - Date.parse(r.started.at) < 3 * 60e3 ? 'starting' : 'no session', harness: r.meta?.harness ?? agent?.tool ?? '', lane: r.meta?.lane ?? '', for: now - Date.parse(r.started.at) };
  }).filter(r => r.state !== 'no session' || r.for < 12 * 3600e3).sort((a, b) => a.for - b.for);
  const onItem = new Map(running.filter(r => r.state !== 'no session').map(r => [r.id, r]));
  const feed = events.slice().sort((a, b) => b.seq - a.seq).map(e => {
    const x = entry(e, items, runs);
    return x && x.id ? { ...x, seq: e.seq, at: e.at, by: e.by, working: onItem.get(x.id) ?? null } : null;
  }).filter(Boolean).filter(x => !filter || prefixOf(x.id) === filter);
  const today = new Date(now).toDateString();
  const created = events.filter(e => e.type === 'item.added' && e.kind !== 'goal' && new Date(e.at).toDateString() === today).length;
  return { items, runs, decide, running, feed, created, onItem };
}

// The item's own thread: why it exists, who is on it, what happened, newest first.
export function itemThread(model, id, events = []) {
  const item = model.items.get(id);
  if (!item) return null;
  const runs = (item.runs ?? []).map(r => model.runs.get(r)).filter(Boolean);
  const history = events.filter(e => e.id === id || e.item === id).sort((a, b) => b.seq - a.seq).map(e => entry(e, model.items, model.runs) && { ...entry(e, model.items, model.runs), at: e.at, seq: e.seq }).filter(Boolean);
  const children = [...model.items.values()].filter(i => i.parent === id);
  return { item, runs, history, children, parent: model.items.get(item.parent) ?? null, working: model.onItem.get(id) ?? null };
}

const FILTERS = [null, 'HUM', 'ENG', 'REV', 'ARCH'];

export function renderFeed({ s, model, project, now }, cols, rows) {
  const lines = [], hits = [], controls = [];
  const span = (text, fg = 'fg', bg = 'bg', bold = false) => ({ text: sanitize(String(text ?? '')), fg, bg, bold });
  const blank = () => ({ spans: [span(' '.repeat(cols))] });
  const body = [];
  // A row is a list of [text, fg, bold] cells laid left to right, clipped to the pane.
  const row = (cells, { id = null, bg = 'bg' } = {}) => body.push({ cells, id, bg });
  const text = (t, fg = 'fg', bold = false) => [t, fg, bold];
  const selected = id => s.selected === id;
  const W = Math.max(20, cols);
  const header = `${project?.name ?? 'no project'} · items`;
  const clock = hhmm(now);
  if (s.view === 'item') {
    const t = itemThread(model, s.detail, s.events);
    row([text('‹ back', 'blue', true), text(`   ${s.detail}`, categoryColor(s.detail), true), text(t ? ` · ${t.item.status}` : '', 'muted')], { id: 'back' });
    row([]);
    if (!t) row([text('This item is not in the organization.', 'muted')]);
    else {
      for (const l of wrap(clean(t.item.title), W - 2)) row([text(l, 'bright', true)]);
      if (t.item.created?.why) { row([]); for (const l of wrap(clean(t.item.created.why), W - 2)) row([text(l, 'fg')]); }
      row([]);
      row([text(`created ${hhmm(t.item.created?.at)} by ${t.item.created?.run ?? t.item.created?.by ?? '?'}`, 'muted'), text(t.parent ? ` · under ${t.parent.id}` : '', 'muted')], { id: t.parent ? `item:${t.parent.id}` : null });
      if (t.working) row([text('● ', 'teal'), text(`${t.working.run} ${t.working.harness} · ${t.working.agent ?? ''} · ${t.working.state} ${ago(t.working.for)}`, 'teal')], { id: 'go' });
      if (t.children.length) {
        row([]); row([text(`spawned · ${t.children.length}`, 'blue', true)]);
        for (const c of t.children.slice(0, 8)) row([text(`${pad(c.id, 9)}`, categoryColor(c.id)), text(`${pad(c.status, 8)}`, 'muted'), text(clean(c.title), 'fg')], { id: `item:${c.id}` });
      }
      row([]); row([text('history', 'blue', true)]);
      for (const h of t.history.slice(0, 30)) {
        row([text(`${hhmm(h.at)} ${h.mark} `, 'muted'), text(h.verb, h.mark === '?' ? 'amber' : 'fg', true), text(h.detail ? ` · ${h.detail}` : '', 'muted')]);
        if (h.why) for (const l of wrap(clean(h.why), W - 8).slice(0, 4)) row([text(`      ${l}`, 'muted')]);
      }
      for (const n of (t.item.notes ?? []).filter(n => !n.decision).slice(-3)) { row([text('note', 'muted')]); for (const l of wrap(clean(n.text), W - 6).slice(0, 3)) row([text(`      ${l}`, 'muted')]); }
    }
  } else {
    if (model.decide.length) {
      row([text(`decide · ${model.decide.length}`, 'amber', true)], { bg: 'attentionBg' });
      for (const d of model.decide) {
        row([text(` ${pad(d.id, 8)}`, 'amber', true), text(clean(d.text), 'bright')], { id: `item:${d.id}`, bg: 'attentionBg' });
        row([text(`          ${[d.recommend ? `recommend ${d.recommend}` : 'no recommendation', d.asked ? `asked ${when(d.asked, now)}` : null, d.by].filter(Boolean).join(' · ')}`, 'muted')], { id: `item:${d.id}`, bg: 'attentionBg' });
      }
      row([]);
    }
    row([text(`running · ${model.running.length}`, 'teal', true)]);
    for (const r of model.running) {
      row([text(` ${r.state === 'working' ? '●' : r.state === 'blocked' ? '!' : '○'} `, r.state === 'working' ? 'teal' : r.state === 'blocked' ? 'amber' : 'muted'), text(`${pad(r.id, 9)}`, categoryColor(r.id), true), text(clean(r.text), 'fg')], { id: `item:${r.id}` });
      row([text(`   ${[r.run, r.harness, r.lane, r.state, ago(r.for)].filter(Boolean).join(' · ')}`, 'muted')], { id: `item:${r.id}` });
    }
    if (!model.running.length) row([text('   nothing running', 'muted')]);
    row([]);
    row([text(`activity${s.filter ? ` · ${s.filter} only` : ''}`, 'blue', true), text(`   f filter · ${model.created} new today`, 'muted')]);
    let lastDay = null;
    for (const x of model.feed.slice(0, 200)) {
      const day = new Date(x.at).toDateString();
      if (lastDay && day !== lastDay) row([text(`   ${new Date(x.at).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })}`, 'muted')]);
      lastDay = day;
      row([text(`${hhmm(x.at)} `, 'muted'), text(`${x.mark} `, x.mark === '?' ? 'amber' : x.mark === '✓' || x.mark === '■' ? 'teal' : 'muted'), text(`${pad(x.id, 9)}`, categoryColor(x.id), true),
        text(`${x.verb} `, x.mark === '?' ? 'amber' : 'fg', true), text(clean(x.text), 'fg')], { id: `item:${x.id}#${x.seq}` });
      const second = [x.detail, x.working ? `● ${x.working.harness} ${x.working.state}` : null].filter(Boolean).join(' · ');
      if (second) row([text(`        ${second}`, 'muted')], { id: `item:${x.id}#${x.seq}` });
      // The agent's own reason or result, on its own lines: the summary to read.
      if (x.why) for (const l of wrap(`“${firstSentence(x.why)}”`, W - 9).slice(0, 2)) row([text(`        ${l}`, 'fg')], { id: `item:${x.id}#${x.seq}` });
    }
    if (!model.feed.length) row([text('   no activity in the window', 'muted')]);
  }
  // Header, body (scrolled to keep the selection visible), footer.
  const top = 2, height = Math.max(1, rows - top - 1);
  const focusRows = body.map((r, i) => r.id && (r.id === s.selected) ? i : -1).filter(i => i >= 0);
  if (focusRows.length) { const first = focusRows[0], last = focusRows.at(-1); if (first < s.scroll) s.scroll = first; if (last >= s.scroll + height) s.scroll = last - height + 1; }
  s.scroll = Math.max(0, Math.min(s.scroll, Math.max(0, body.length - height)));
  s.targets = [...new Set(body.map(r => r.id).filter(id => id && id !== 'back' && id !== 'go'))];
  lines.push({ spans: [span(` ${pad(clip(header, W - clock.length - 3), W - clock.length - 2)}`, 'bright', 'panel', true), span(`${clock} `, 'muted', 'panel')] });
  const errs = Object.values(s.errors ?? {});
  lines.push({ spans: [span(pad(errs.length ? ` ${errs[0]}` : ` ${model.decide.length} decide · ${model.running.length} running · ${model.running.filter(r => r.state === 'working').length} working`, W), errs.length ? 'amber' : 'muted', 'panel')] });
  hits.push([], []);
  for (let i = 0; i < height; i++) {
    const r = body[s.scroll + i];
    if (!r) { lines.push(blank()); hits.push([]); continue; }
    const bg = r.id && selected(r.id) ? 'selected' : r.bg;
    const spans = []; let used = 0;
    for (const [t, fg, bold] of r.cells) { if (used >= W) break; const c = clip(String(t), W - used); spans.push(span(c, fg, bg, bold)); used += c.length; }
    spans.push(span(' '.repeat(Math.max(0, W - used)), 'fg', bg));
    lines.push({ spans }); hits.push(r.id ? [{ from: 0, to: W, id: r.id }] : []);
  }
  const hint = s.message || (s.view === 'item' ? ' Esc back · o open the session · ↑↓ · q quit' : ' ↑↓ select · Enter open · f filter · r refresh · q quit');
  lines.push({ spans: [span(pad(clip(hint, W), W), s.message ? 'amber' : 'muted', 'panel')] }); hits.push([]);
  return { lines, hits, controls, bodyHeight: height, maxScroll: Math.max(0, body.length - height) };
}

export function createFeedSession({ config, projectIndex = 0, deps = {}, onChange = () => {}, env = process.env }) {
  const d = { orgStatus: cli.orgStatus, orgLog: cli.orgLog, herdrAgents: cli.herdrAgents, herdrGo: cli.herdrGo, now: () => Date.now(), ...deps };
  const project = config.projects[projectIndex] ?? null;
  const s = { view: 'feed', detail: null, selected: null, scroll: 0, filter: null, events: [], status: null, agents: [], errors: {}, message: '',
    appearance: env.HERDR_CONSOLE_THEME === 'light' ? 'light' : 'dark', interactive: false, targets: [], timer: null, stopped: false, pending: null, history: [] };
  const changed = () => { if (!s.stopped) onChange(); };
  const model = () => feedModel({ status: s.status, events: s.events, agents: s.agents, now: d.now(), filter: s.filter });
  async function refresh() {
    if (s.pending || !project?.org) { if (!project?.org) s.errors.org = 'This project has no organization.'; return s.pending; }
    s.pending = (async () => {
      const load = async (key, fn) => { try { const v = await fn(); delete s.errors[key]; return v; } catch (e) { s.errors[key] = `${key}: ${e.message}`; return undefined; } };
      const [status, events, agents] = await Promise.all([load('status', () => d.orgStatus(project)), load('log', () => d.orgLog(project, env.HERDR_FEED_SINCE ?? '36h')), load('agents', async () => { const r = await d.herdrAgents(); if (!r.ok) throw Error(r.error); return r.agents; })]);
      if (status) s.status = status; if (events) s.events = events; if (agents) s.agents = agents;
    })().finally(() => { s.pending = null; changed(); });
    return s.pending;
  }
  const move = n => {
    const t = s.targets; if (!t.length) return;
    const i = t.indexOf(s.selected);
    s.selected = t[Math.max(0, Math.min(t.length - 1, (i < 0 ? (n > 0 ? -1 : t.length) : i) + n))]; changed();
  };
  const idOf = target => target?.startsWith('item:') ? target.slice(5).split('#')[0] : null;
  async function open(target) {
    if (target === 'back') return back();
    if (target === 'go') return go();
    const id = idOf(target); if (!id) return;
    s.history.push({ view: s.view, detail: s.detail, selected: s.selected, scroll: s.scroll });
    Object.assign(s, { view: 'item', detail: id, selected: null, scroll: 0, message: '' }); changed();
  }
  function back() { const prior = s.history.pop(); if (prior) Object.assign(s, prior, { message: '' }); changed(); }
  async function go() {
    const w = model().onItem.get(s.detail);
    if (!w?.agent) { s.message = 'No session is working on this item now.'; changed(); return; }
    const r = await d.herdrGo({ agent: w.agent }); s.message = r.ok ? `Opened ${w.agent} in Herdr.` : r.error; changed();
  }
  return {
    get ui() { return s; }, set ui(v) { Object.assign(s, v); }, get model() { return model(); },
    frame(cols, rows) { const f = renderFeed({ s, model: model(), project, now: d.now() }, cols, rows); s.lastHits = f.hits; return f; },
    refresh, input: async () => false, waitForOutput: async () => {},
    async key(input, k = {}) {
      if (input === 'q' || (k.ctrl && input === 'c')) return true;
      if (k.escape || input === 'b') { back(); return false; }
      if (k.upArrow || input === 'k') move(-1);
      else if (k.downArrow || input === 'j') move(1);
      else if (k.pageDown) { s.scroll += 10; changed(); } else if (k.pageUp) { s.scroll = Math.max(0, s.scroll - 10); changed(); }
      else if (k.return) await open(s.selected ?? s.targets[0]);
      else if (input === 'o' && s.view === 'item') await go();
      else if (input === 'f') { s.filter = FILTERS[(FILTERS.indexOf(s.filter) + 1) % FILTERS.length]; s.selected = null; s.scroll = 0; changed(); }
      else if (input === 'r') await refresh();
      else if (input === 'D') { s.appearance = s.appearance === 'dark' ? 'light' : 'dark'; changed(); }
      return false;
    },
    async mouse(e) {
      if (!e.press) return false;
      if (e.button === 'wheelDown' || e.button === 'wheelUp') { s.scroll = Math.max(0, s.scroll + (e.button === 'wheelDown' ? 3 : -3)); changed(); return false; }
      if (e.button === 'back') { back(); return false; }
      if (e.button !== 'left') return false;
      const target = s.lastHits?.[e.y]?.find(h => e.x >= h.from && e.x < h.to);
      if (target) { if (!['back', 'go'].includes(target.id)) s.selected = target.id; await open(target.id); }
      return false;
    },
    async start() { s.timer = setInterval(() => refresh().catch(() => {}), (config.feed_seconds ?? 3) * 1000); return refresh(); },
    stop() { s.stopped = true; clearInterval(s.timer); },
  };
}
