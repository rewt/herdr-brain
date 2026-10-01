// The items pane: a narrow, live view of an organization's work items, made to
// sit beside a supervisor chat. Agents create items with a category prefix
// (ENG, REV, ARCH, HUM...) and a reason; runs pick them up, report and close
// them. This shows those moments as they happen, with who is on each item, so
// the chat does not have to be read to know what exists. It reads through the
// org CLI and Herdr; it never writes the record. Its effects are focusing a
// session in Herdr and, when the operator presses Enter, one message to the
// supervisor chat.
import { pad, clip, wrap, sanitize } from '../lib/text.mjs';
import * as cli from '../lib/cli.mjs';
import { createChatIndex, indexFile, transcriptPath } from './chatindex.mjs';

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

// The codes a chat has on screen, most recently mentioned first. An org ID is
// itself; a run (R-n) stands for the item it works; a plan's own label (S1, 3A)
// resolves only when an item records it as an alias (meta.alias, comma
// separated), preferring an open item. Anything else is the chat's shorthand.
export function aliases(items) {
  const map = new Map();
  const open = i => !i.closed && !['done', 'dropped'].includes(i.status);
  for (const i of items.values()) for (const a of String(i.meta?.alias ?? '').split(/[,\s]+/).filter(Boolean)) {
    const prior = map.get(a);
    if (!prior || (open(i) && !open(prior))) map.set(a, i);
  }
  return map;
}
export function mentions(text, items, runs) {
  const last = new Map(), screen = String(text ?? '');
  // Dates in file names (REVIEW-20260930) are not IDs.
  for (const m of screen.matchAll(/\b([A-Z][A-Z0-9]{0,5})-(\d{1,5})\b/g)) last.set(m[0], m.index);
  const alias = aliases(items);
  for (const a of alias.keys()) {
    const re = new RegExp(`(?<![\\w-])${a.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\w-])`, 'g');
    for (const m of screen.matchAll(re)) last.set(a, Math.max(last.get(a) ?? -1, m.index));
  }
  // Plan labels the chat uses of its own (3A, 4-DC2, 4a): listed, never resolved.
  const labels = new Map();
  for (const m of screen.matchAll(/(?<![\w.-])(\d{1,2}[A-Z](?:-[A-Z]{1,4}\d*)?|\d{1,2}-[A-Z]{1,4}\d*)(?![\w-])/g)) if (!last.has(m[0]) && !labels.has(m[0])) labels.set(m[0], m.index);
  const seen = new Map(), known = [], unknown = [];
  // Reading order: the legend runs down the chat the way the operator reads it.
  for (const [code] of [...last].sort((a, b) => a[1] - b[1])) {
    const run = runs.get(code), itemId = run ? run.item : alias.get(code)?.id ?? code;
    if (!items.has(itemId)) { unknown.push(code); continue; }
    if (seen.has(itemId)) { const k = seen.get(itemId); if (code !== itemId && !k.said.includes(code)) k.said.push(code); if (run) k.via ??= code; continue; }
    const k = { id: itemId, via: run ? code : null, said: code === itemId ? [] : [code] };
    seen.set(itemId, k); known.push(k);
  }
  const first = code => screen.indexOf(code);
  return { known, unknown: [...unknown.map(c => [c, first(c)]), ...labels].sort((a, b) => a[1] - b[1]).map(([c]) => c) };
}

// What waits on the operator: open org questions, ordered by how much each
// blocks, then newest (or oldest, or by ID).
export function waitingQueue(items, sort = 'blocking') {
  const q = [];
  for (const i of items.values()) {
    if (i.role !== 'human' || i.closed || ['done', 'dropped'].includes(i.status)) continue;
    q.push({ key: i.id, id: i.id, run: i.created?.run ?? null, title: i.title, at: i.created?.at, blocks: i.blocks?.length ?? 0,
      decisions: [{ n: 1, question: i.title, recommend: i.meta?.recommend ?? null, detail: [i.meta?.why, i.meta?.on_yes && `If yes: ${i.meta.on_yes}`, i.meta?.on_no && `If no: ${i.meta.on_no}`].filter(Boolean).join(' ') }] });
  }
  const order = { blocking: (a, b) => b.blocks - a.blocks || Date.parse(b.at) - Date.parse(a.at), oldest: (a, b) => Date.parse(a.at) - Date.parse(b.at), id: (a, b) => a.id.localeCompare(b.id, 'en', { numeric: true }) }[sort] ?? (() => 0);
  return q.sort(order);
}

// The message the supervisor receives: the operator's picks, in order, plus
// their own words. Unanswered decisions are left out, never guessed.
export function answerMessage(entry, picks = {}, note = '') {
  const parts = entry.decisions.filter(d => picks[d.n]).map(d => {
    const p = picks[d.n];
    return entry.decisions.length === 1 ? (p === 'rec' ? `${d.recommend ?? 'as recommended'} (as recommended)` : p) : `${d.n} ${p === 'rec' ? `${d.recommend ?? 'as recommended'} (as recommended)` : p}`;
  });
  if (!parts.length && !note.trim()) return null;
  return `Operator answer from the items pane for ${entry.id}${entry.decisions.length > 1 ? ' decisions' : ''}: ${parts.join('; ')}${note.trim() ? `${parts.length ? '. ' : ''}${note.trim()}` : ''}`;
}

// Whether a Claude Code chat's prompt box holds unsent text: the line after its
// last "❯" between the box's rules. Sending then would merge the two messages.
export function promptDraft(screen) {
  const lines = String(screen ?? '').split('\n');
  const rules = lines.map((l, i) => /^\s*─{8,}/.test(l) ? i : -1).filter(i => i >= 0);
  if (rules.length < 2) return null;
  const box = lines.slice(rules.at(-2) + 1, rules.at(-1)).join(' ');
  const text = /❯\s*(.*)$/.exec(box)?.[1]?.trim() ?? '';
  return text || null;
}

export const isResolved = i => Boolean(i && (i.closed || ['done', 'dropped'].includes(i.status)));

// The action an open item needs from someone: the operator's answer, a
// dispatch, a redeploy, or nothing but time.
export function actionFor(b, runs, live) {
  if (b.role === 'human') return { kind: 'decide', text: 'answer it' };
  if (b.status === 'needs_human') return { kind: 'decide', text: 'decide on its report' };
  const run = runs.get((b.runs ?? []).at(-1));
  if (b.status === 'active') {
    const agent = run && live.get(run.meta?.agent);
    if (agent && ['working', 'blocked'].includes(agent.status)) return { kind: 'wait', text: `${run.id} ${agent.status}`, run: run.id };
    return { kind: 'redeploy', text: run?.report ? `${run.id} reported; settle it` : `${run?.id ?? 'its run'} has no live session; redeploy it`, run: run?.id };
  }
  return { kind: 'dispatch', text: 'not started; dispatch it' };
}

// What unblocks an item: its open blockers, followed down to the ones that
// are not blocked themselves, each with the action it needs.
export function unblockers(item, items, runs, live) {
  const out = new Map(), seen = new Set();
  const visit = id => {
    if (seen.has(id)) return; seen.add(id);
    const b = items.get(id); if (!b || isResolved(b)) return;
    if (b.status === 'blocked' && b.blocked_by?.length) { for (const x of b.blocked_by) visit(x); return; }
    out.set(id, { id, ...actionFor(b, runs, live), via: b });
  };
  for (const x of item.blocked_by ?? []) visit(x);
  return [...out.values()];
}

// Every item the chat has surfaced, with its state now. Codes resolve through
// runs and recorded aliases; open org questions are tracked even when the chat
// never named them.
export function trackedItems({ items, runs, live, chat, waiting, onItem }) {
  const alias = aliases(items), tracked = new Map();
  const add = (id, via, at) => {
    if (!items.has(id)) return;
    const t = tracked.get(id) ?? { id, said: [], last: null };
    if (via && via !== id && !t.said.includes(via)) t.said.push(via);
    if (at && (!t.last || at > t.last)) t.last = at;
    tracked.set(id, t);
  };
  for (const [code, m] of Object.entries(chat?.mentions ?? {})) add(runs.get(code)?.item ?? alias.get(code)?.id ?? code, code, m.last);
  for (const w of waiting) add(w.id, null, w.at);
  const latest = new Set(chat?.lastTurn?.codes ?? []);
  return [...tracked.values()].map(t => {
    const item = items.get(t.id), wait = waiting.find(w => w.id === t.id), working = onItem.get(t.id);
    const state = isResolved(item) ? 'resolved' : wait || item.role === 'human' || item.status === 'needs_human' ? 'decide'
      : item.status === 'blocked' ? 'blocked' : item.status === 'active' ? (working && ['working', 'blocked', 'starting'].includes(working.state) ? 'working' : 'stalled') : 'ready';
    return { ...t, item, state, wait, working, action: state === 'stalled' || state === 'ready' ? actionFor(item, runs, live) : null,
      unblock: state === 'blocked' ? unblockers(item, items, runs, live) : [], latest: latest.has(t.id) || t.said.some(c => latest.has(c)), mentions: [t.id, ...t.said].flatMap(c => chat?.mentions?.[c]?.messages ?? []).sort((a, b) => String(b.at).localeCompare(String(a.at))) };
  }).sort((a, b) => String(b.last ?? '').localeCompare(String(a.last ?? '')));
}

// Idle: no session working and nothing recorded for a while. Long runs leave
// the record quiet for an hour with sessions working, which is progress; with
// no session working, a quiet record means nothing is moving and nobody will
// say so (a refused promotion, a lost watcher).
export function idleState(events, running, now, minutes = 20) {
  const last = events.reduce((a, e) => (!a || e.seq > a.seq ? e : a), null);
  const working = running.filter(r => ['working', 'starting'].includes(r.state)).length;
  const quiet = last ? now - Date.parse(last.at) : null;
  return { idle: working === 0 && quiet !== null && quiet >= minutes * 60e3, quiet, working, last };
}

// Everything the pane shows, derived from `org status --json`, recent `org log`
// events and Herdr's agents. Pure, so it is tested without a server.
export function feedModel({ status, events = [], agents = [], workspaces = [], now = Date.now(), filter = null, screen = '', sort = 'blocking', chat = null, idleMinutes = 20 }) {
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
  // What the chat beside this pane is talking about, with each item's latest moment.
  const latest = new Map();
  for (const x of events.slice().sort((a, b) => b.seq - a.seq)) { const y = entry(x, items, runs); if (y?.id && !latest.has(y.id)) latest.set(y.id, { ...y, at: x.at }); }
  const said = mentions(screen, items, runs);
  const onScreen = said.known.map(k => ({ ...k, item: items.get(k.id), working: onItem.get(k.id) ?? null, latest: latest.get(k.id) ?? null }));
  const waiting = waitingQueue(items, sort);
  // Sessions first: each running agent with the items its runs work on. The
  // summary is the run's latest report headline, else why the item exists.
  const talked = new Set(onScreen.flatMap(o => [o.id, ...o.said]));
  const headline = new Map(events.filter(e => e.type === 'report.ingested').map(e => [e.run, e.report?.headline ?? firstSentence(e.report?.summary)]));
  const sessions = [];
  for (const r of running) {
    const key = r.agent ?? r.run;
    let sess = sessions.find(x => x.key === key);
    // Named as Herdr's sidebar names it: the session's workspace label.
    const space = workspaces.find(w => w.workspace_id === live.get(r.agent)?.workspace);
    if (!sess) sessions.push(sess = { key, agent: r.agent, lane: space?.label ?? (r.lane ? `lane-${r.lane}` : r.agent ?? r.run), harness: r.harness, state: r.state, for: r.for, pane: r.pane, work: [] });
    const item = items.get(r.id), l = latest.get(r.id);
    sess.work.push({ id: r.id, run: r.run, title: item?.title ?? r.text, latest: l, summary: headline.get(r.run) ?? item?.created?.why ?? null, talked: talked.has(r.id) || talked.has(r.run) });
    sess.for = Math.max(sess.for, r.for);
  }
  for (const x of sessions) x.talked = x.work.some(w => w.talked);
  const inSessions = new Set(sessions.flatMap(x => x.work.map(w => w.id))), waitingIds = new Set(waiting.map(w => w.id));
  const alsoInChat = onScreen.filter(o => !inSessions.has(o.id) && !waitingIds.has(o.id));
  const tracked = trackedItems({ items, runs, live, chat, waiting, onItem });
  const idle = idleState(events, running, now, idleMinutes);
  return { items, runs, decide, running, feed, created, onItem, onScreen, shorthand: said.unknown, waiting, sessions, alsoInChat, tracked, idle };
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
const VIEWS = ['unresolved', 'decide', 'blocked', 'working', 'resolved', 'all'];

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
  const section = (title, fg = 'blue') => row([text(title, fg, true)], { bg: 'panel' });
  const para = (t, fg = 'fg', indent = 1, max = 99) => { for (const l of wrap(clean(t), W - indent - 1).slice(0, max)) row([text(`${' '.repeat(indent)}${l}`, fg)]); };
  if (s.view === 'item') {
    const t = itemThread(model, s.detail, s.events);
    const entry = model.waiting.find(w => w.key === s.entryKey) ?? model.waiting.find(w => w.id === s.detail);
    row([text('‹ back', 'blue', true), text(`   ${s.detail}`, categoryColor(s.detail), true), text(t ? ` · ${t.item.status}` : '', 'muted'), ], { id: 'back' });
    if (!t) row([text('This item is not in the organization.', 'muted')]);
    else {
      section('TITLE'); para(t.item.title, 'bright');
      const summary = t.item.created?.why;
      if (summary) { section('SUMMARY'); para(summary, 'fg', 1, 6); }
      if (entry) {
        const a = s.answer?.key === entry.key ? s.answer : { picks: {}, note: '', sel: 1 };
        section(`DECISIONS · ${entry.decisions.length}`, 'amber');
        for (const d of entry.decisions) {
          const pick = a.picks[d.n], mark = pick ? `  → ${pick === 'rec' ? 'as recommended' : pick}` : '';
          const q = wrap(clean(d.question), W - 6);
          q.forEach((l, i) => row([text(i ? '    ' : ` ${d.n}  `, 'amber', true), text(l, 'bright', true), text(i === q.length - 1 ? mark : '', 'teal', true)], { id: `pick:${d.n}`, bg: a.sel === d.n ? 'selected' : 'bg' }));
          if (d.recommend) row([text(`    ★ recommend: ${clean(d.recommend)}`, 'goal')], { id: `pick:${d.n}` });
          if (d.detail && a.sel === d.n) para(d.detail, 'muted', 4, 5);
        }
        section('ACTION', 'teal');
        const n = entry.decisions.length;
        row([text(` ${n > 1 ? `1-${n} choose · ` : ''}y yes · n no · a accept all recommended · e add words`, 'muted')]);
        const msg = answerMessage(entry, a.picks, a.note);
        if (a.typing) row([text(` your words: ${a.note}▏`, 'bright')]);
        if (msg) { row([text(` Enter sends to ${s.watching ?? 'the supervisor'}:`, 'teal', true)], { id: 'send' }); para(`“${msg}”`, 'fg', 2, 6); }
        else row([text(` Choose an answer to send it to ${s.watching ?? 'the supervisor'}.`, 'muted')]);
        if (s.sent?.[entry.key]) row([text(` sent ${when(s.sent[entry.key].at, now)}: waiting for the supervisor to record it`, 'teal')]);
      }
      // What it needs: the blockers' actions, or its own, as messages the
      // supervisor can act on. Answers to decisions are on the blocker's page.
      const tr = model.tracked.find(x => x.id === s.detail);
      const asks = tr?.state === 'blocked' ? tr.unblock : tr?.action ? [{ id: tr.id, ...tr.action }] : [];
      if (asks.length) {
        section(tr.state === 'blocked' ? `BLOCKED BY · ${asks.length}` : 'NEEDS', 'amber');
        for (const u of asks) {
          const target = u.kind === 'decide' ? `item:${u.id}` : u.kind === 'wait' ? `item:${u.id}` : `ask:${u.id}`;
          wrap(`${u.id} ${clean(model.items.get(u.id)?.title ?? '')}`, W - 4).slice(0, 2).forEach((l, n) => row([text(n ? '   ' : ' → ', 'amber'), text(l, n ? 'fg' : categoryColor(u.id), !n)], { id: target }));
          row([text(`   ${u.kind === 'decide' ? `${u.text} · Enter opens it to answer` : u.kind === 'wait' ? u.text : `${u.text} · Enter asks the supervisor`}`, u.kind === 'wait' ? 'teal' : 'muted')], { id: target });
        }
        if (s.ask?.item === s.detail) { row([text(' Enter sends to the supervisor:', 'teal', true)], { id: 'send-ask' }); para(`“${s.ask.text}”`, 'fg', 2, 6); }
      }
      if (tr?.mentions?.length) {
        section(`IN THE CHAT · ${tr.mentions.length}`, 'muted');
        for (const m of tr.mentions.slice(0, 6)) {
          row([text(` ${when(m.at, now)} ${m.role}`, m.role === 'operator' ? 'amber' : 'muted', true)]);
          para(m.text, 'fg', 3, 4);
        }
      }
      section('CONTEXT', 'muted');
      row([text(` created ${when(t.item.created?.at, now)} by ${t.item.created?.run ?? t.item.created?.by ?? '?'}`, 'muted'), text(t.parent ? ` · under ${t.parent.id}` : '', 'muted')], { id: t.parent ? `item:${t.parent.id}` : null });
      if (t.working) row([text(' ● ', 'teal'), text(`${t.working.run} ${t.working.harness} · ${t.working.agent ?? ''} · ${t.working.state} ${ago(t.working.for)} · o open`, 'teal')], { id: 'go' });
      for (const c of t.children.slice(0, 6)) row([text(` ${pad(c.id, 9)}`, categoryColor(c.id)), text(`${pad(c.status, 8)}`, 'muted'), text(clean(c.title), 'fg')], { id: `item:${c.id}` });
      for (const h of t.history.slice(0, 12)) row([text(` ${when(h.at, now)} ${h.mark} `, 'muted'), text(h.verb, 'fg'), text(h.detail ? ` · ${h.detail}` : '', 'muted')]);
    }
  } else {
    row([text(` view: ${VIEWS.map(v => v === (s.view2 ?? 'unresolved') ? `[${v}]` : v).join(' ')}   f`, 'muted')]);
    // Everything the chat surfaced, by what it needs now; f narrows the view.
    const view = s.view2 ?? 'unresolved', groups = { decide: [], blocked: [], stalled: [], working: [], ready: [], resolved: [] };
    for (const t of model.tracked) groups[t.state].push(t);
    const shown = view === 'unresolved' ? ['decide', 'blocked', 'stalled'] : view === 'all' ? ['decide', 'blocked', 'stalled', 'working', 'ready', 'resolved'] : [view];
    const titles = { decide: ['DECIDE', 'amber'], blocked: ['BLOCKED', 'amber'], stalled: ['STALLED · no live session', 'amber'], working: ['WORKING', 'teal'], ready: ['NOT STARTED', 'muted'], resolved: ['RESOLVED', 'muted'] };
    for (const g of shown) {
      const list = groups[g]; if (!list.length && view === 'unresolved') continue;
      section(`${titles[g][0]} · ${list.length}`, titles[g][1]);
      for (const t of list.slice(0, g === 'resolved' ? 40 : 60)) {
        const id = t.wait ? `wait:${t.wait.key}` : `item:${t.id}~t`, said = t.said.length ? `${t.said.slice(0, 2).join(' ')}${t.said.length > 2 ? ` +${t.said.length - 2}` : ''} → ` : '';
        const head = `${said}${t.id}`;
        const lines = wrap(clean(t.item.title), Math.max(12, W - head.length - 3)), cap = lines.length > 3 ? [...lines.slice(0, 2), `${lines[2].slice(0, -1)}…`] : lines;
        cap.forEach((l, n) => row([text(n ? ' '.repeat(head.length + 2) : ` ${head} `, n ? 'fg' : categoryColor(t.id), true), text(l, g === 'resolved' ? 'muted' : 'fg'), text(n === 0 && t.latest ? ' ◂' : '', 'amber')], { id }));
        const ind = ' '.repeat(Math.min(10, head.length + 2));
        if (g === 'decide') {
          const w = t.wait, recs = w ? w.decisions.filter(d => d.recommend).length : 0;
          row([text(`${ind}${w ? [w.decisions.length > 1 ? `${w.decisions.length} decisions` : 'question', recs ? `${recs === w.decisions.length ? 'all' : recs} recommended` : 'no rec', w.run, when(w.at, now), s.sent?.[w.key] ? 'sent' : null].filter(Boolean).join(' · ') : t.item.status === 'needs_human' ? 'its report needs your decision' : 'answer it'}`, s.sent?.[w?.key] ? 'teal' : 'amber')], { id });
        } else if (g === 'blocked') {
          for (const u of t.unblock.slice(0, 4)) row([text(`${ind}→ `, 'amber'), text(`${u.id} `, categoryColor(u.id), true), text(u.text, u.kind === 'wait' ? 'teal' : 'amber')], { id });
          if (!t.unblock.length) row([text(`${ind}${(t.item.blocked_reason ?? []).join(' · ') || 'blocked, no open blocker recorded'}`, 'muted')], { id });
        } else if (t.action) row([text(`${ind}→ ${t.action.text}`, 'amber')], { id });
        else if (t.working) row([text(`${ind}● ${t.working.run} ${t.working.harness} · ${t.working.lane} · ${ago(t.working.for)}`, 'teal')], { id });
        else if (g === 'resolved') row([text(`${ind}${t.item.status} ${when(t.item.closed?.at, now)}`, 'muted')], { id });
      }
      if (!list.length) row([text('   none', 'muted')]);
    }
    if (!model.tracked.length) row([text(s.chatFile ? '   nothing surfaced in the chat yet' : '   no supervisor transcript found beside this pane', 'muted')]);
    if (shown.length) row([]);
    // Then the sessions: the lane, its agent, and the work it holds right now.
    const glyph = st => st === 'working' ? '●' : st === 'blocked' ? '!' : st === 'starting' ? '◌' : '○';
    const tone = st => st === 'working' ? 'teal' : st === 'blocked' ? 'amber' : 'muted';
    const narrowed = !['unresolved', 'all'].includes(s.view2 ?? 'unresolved');
    const live = narrowed ? [] : model.sessions.filter(x => ['working', 'blocked', 'starting'].includes(x.state)), rest = narrowed ? [] : model.sessions.filter(x => !live.includes(x));
    if (!narrowed) section(`SESSIONS · ${live.length} live`, 'teal');
    for (const x of live) {
      const right = `${x.harness} · ${ago(x.for)}${x.state !== 'working' ? ` · ${x.state}` : ''}${x.talked ? ' ◂' : ''}`;
      const id = `item:${x.work[0].id}~r`;
      // The name in full; the facts share its line when they fit.
      if (x.lane.length + right.length + 5 <= W) row([text(` ${glyph(x.state)} `, tone(x.state), true), text(pad(x.lane, W - right.length - 4), x.state === 'working' ? 'bright' : 'fg', true), text(right, x.talked ? 'amber' : 'muted')], { id });
      else {
        wrap(x.lane, W - 4).forEach((l, i) => row([text(i ? '   ' : ` ${glyph(x.state)} `, tone(x.state), true), text(l, x.state === 'working' ? 'bright' : 'fg', true)], { id }));
        row([text(`   ${right}`, x.talked ? 'amber' : 'muted')], { id });
      }
      for (const w of x.work) {
        const wid = `item:${w.id}~r`;
        wrap(clean(w.title), W - 13).forEach((l, i) => row([text(i ? ' '.repeat(12) : `   ${pad(w.id, 9)}`, categoryColor(w.id), true), text(l, 'fg')], { id: wid }));
        const moment = w.latest ? `${w.latest.verb} ${when(w.latest.at, now)}` : '';
        row([text(`${' '.repeat(12)}${[w.run, moment].filter(Boolean).join(' · ')}`, 'muted')], { id: wid });
        if (w.summary) wrap(`“${firstSentence(w.summary)}”`, W - 13).forEach(l => row([text(`${' '.repeat(12)}${l}`, 'muted')], { id: wid }));
      }
    }
    if (!live.length && !narrowed) row([text('   no live sessions', 'muted')]);
    // Stopped, not yet settled: one line each, until their reports are recorded.
    if (rest.length) {
      row([]); section(`STOPPED, NOT SETTLED · ${rest.length}`, 'muted');
      for (const x of rest) {
        const w = x.work[0], right = `${x.state} ${ago(x.for)}${x.talked ? ' ◂' : ''}`;
        row([text(' ○ ', 'muted'), text(x.lane, 'fg'), text(`  ${right}`, x.talked ? 'amber' : 'muted')], { id: `item:${w.id}~r` });
        wrap(clean(w.title), W - 13).slice(0, 2).forEach((l, i) => row([text(i ? ' '.repeat(12) : `   ${pad(w.id, 9)}`, categoryColor(w.id), true), text(l, 'muted')], { id: `item:${w.id}~r` }));
      }
    }
    row([]);
    if ((s.view2 ?? 'unresolved') === 'unresolved') {
      const ready = model.tracked.filter(t => t.state === 'ready');
      if (ready.length) { row([]); section(`NOT STARTED · ${ready.length}`, 'muted'); for (const t of ready.slice(0, 30)) wrap(clean(t.item.title), W - 12).slice(0, 1).forEach(l => row([text(` ${pad(t.id, 10)}`, categoryColor(t.id), true), text(l, 'muted')], { id: `item:${t.id}~t` })); }
    }
    if (!narrowed) {
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
  }
  // Header, body (scrolled to keep the selection visible), footer.
  const top = 2, height = Math.max(1, rows - top - 1);
  const focusRows = body.map((r, i) => r.id && (r.id === s.selected) ? i : -1).filter(i => i >= 0);
  if (focusRows.length) { const first = focusRows[0], last = focusRows.at(-1); if (first < s.scroll) s.scroll = first; if (last >= s.scroll + height) s.scroll = last - height + 1; }
  s.scroll = Math.max(0, Math.min(s.scroll, Math.max(0, body.length - height)));
  s.targets = [...new Set(body.map(r => r.id).filter(id => id && id !== 'back' && id !== 'go'))];
  lines.push({ spans: [span(` ${pad(clip(header, W - clock.length - 3), W - clock.length - 2)}`, 'bright', 'panel', true), span(`${clock} `, 'muted', 'panel')] });
  const errs = Object.values(s.errors ?? {});
  const idle = model.idle?.idle ? model.idle : null;
  const counts = ` ${model.running.filter(r => r.state === 'working').length} working · ${model.tracked.filter(t => t.state === 'decide').length} decide · ${model.tracked.filter(t => t.state === 'blocked').length} blocked · ${model.tracked.filter(t => t.state === 'stalled').length} stalled`;
  const lastSaid = idle ? `${hhmm(idle.last.at)} ${idle.last.type.replace('.', ' ')}${idle.last.id ?? idle.last.item ? ` ${idle.last.id ?? idle.last.item}` : ''}` : '';
  const status = errs.length ? ` ${errs[0]}` : idle ? ` idle ${ago(idle.quiet)} · no session working · last ${lastSaid}` : counts;
  lines.push({ spans: [span(pad(clip(status, W), W), errs.length || idle ? 'amber' : 'muted', 'panel', Boolean(idle) && !errs.length)] });
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
  const hint = s.message || (s.view === 'item' ? (s.entryKey ? ' y/n answer · a all recommended · e words · Enter send · Esc' : ' Esc back · o open the session · ↑↓ · q quit') : ' ↑↓ select · Enter open · s sort · f filter · q quit');
  lines.push({ spans: [span(pad(clip(hint, W), W), s.message ? 'amber' : 'muted', 'panel')] }); hits.push([]);
  return { lines, hits, controls, bodyHeight: height, maxScroll: Math.max(0, body.length - height) };
}

export function createFeedSession({ config, projectIndex = 0, deps = {}, onChange = () => {}, env = process.env }) {
  const d = { orgStatus: cli.orgStatus, orgLog: cli.orgLog, herdrAgents: cli.herdrAgents, herdrGo: cli.herdrGo, herdrList: cli.herdrList, herdrVisible: cli.herdrVisible, herdrPrompt: cli.herdrPrompt,
    now: () => Date.now(), ...deps };
  const project = config.projects[projectIndex] ?? null;
  const chat = project ? (deps.chatIndex ?? createChatIndex({ file: indexFile(project.name, env) })) : null;
  const s = { view: 'feed', detail: null, screen: '', workspaces: [], watching: null, sort: 'blocking', answers: {}, answer: null, sent: {}, entryKey: null, selected: null, scroll: 0, filter: null, events: [], status: null, agents: [], errors: {}, message: '',
    appearance: env.HERDR_CONSOLE_THEME === 'light' ? 'light' : 'dark', interactive: false, targets: [], timer: null, stopped: false, pending: null, history: [] };
  const changed = () => { if (!s.stopped) onChange(); };
  const model = () => feedModel({ chat: chat?.data ?? null, status: s.status, events: s.events, agents: s.agents, workspaces: s.workspaces, now: d.now(), filter: s.filter, screen: s.screen, sort: s.sort });
  async function refresh() {
    if (s.pending || !project?.org) { if (!project?.org) s.errors.org = 'This project has no organization.'; return s.pending; }
    s.pending = (async () => {
      const load = async (key, fn) => { try { const v = await fn(); delete s.errors[key]; return v; } catch (e) { s.errors[key] = `${key}: ${e.message}`; return undefined; } };
      const [status, events, agents] = await Promise.all([load('status', () => d.orgStatus(project)), load('log', () => d.orgLog(project, env.HERDR_FEED_SINCE ?? '36h')), load('agents', async () => { const r = await d.herdrAgents(); if (!r.ok) throw Error(r.error); return r.agents; })]);
      if (status) s.status = status; if (events) s.events = events; if (agents) s.agents = agents;
      const spaces = await load('workspaces', () => d.herdrList('workspace')); if (spaces) s.workspaces = spaces;
      await readBeside();
      readChat();
    })().finally(() => { s.pending = null; changed(); });
    return s.pending;
  }
  // The chat beside this pane: HERDR_FEED_WATCH names a pane or agent; otherwise
  // the agent sharing this pane's tab. Its visible screen is read, never written.
  async function readBeside() {
    try {
      // Panes are re-read each time: a handoff gives the chat a new transcript.
      if (d.herdrList) s.panes = await d.herdrList('pane');
      let target = env.HERDR_FEED_WATCH ?? null;
      if (!target && env.HERDR_PANE_ID && d.herdrList) {
        const panes = s.panes, me = panes.find(p => p.pane_id === env.HERDR_PANE_ID);
        target = panes.find(p => p.tab_id === me?.tab_id && p.pane_id !== me?.pane_id && p.agent)?.pane_id ?? null;
      }
      if (!target) { s.watching = null; return; }
      s.watchPane = target;
      const agent = s.agents.find(a => a.pane === target || a.name === target);
      // Only what is on screen: reading history would scroll the chat (see herdrVisible).
      const r = await d.herdrVisible(agent?.pane ?? target);
      if (r.ok) { s.screen = r.text; s.watching = agent?.name ?? target; delete s.errors.screen; } else s.errors.screen = `screen: ${r.error}`;
    } catch (e) { s.errors.screen = `screen: ${e.message}`; }
  }
  // The supervisor's transcript, indexed incrementally into the chat index.
  function readChat() {
    try {
      const pane = s.panes?.find(p => p.pane_id === (s.agents.find(a => a.name === s.watching)?.pane ?? s.watchPane));
      const id = pane?.agent_session?.value, file = id && (d.transcriptPath ?? transcriptPath)(id, pane.cwd ?? project.cwd ?? '');
      s.chatFile = file ?? null;
      if (file) chat.update(id, file);
    } catch (e) { s.errors.chat = `chat: ${e.message}`; }
  }
  const entryOf = key => model().waiting.find(w => w.key === key);
  // Answering: the picks and words live per entry, so leaving and returning keeps them.
  function answerFor(key) { return (s.answers[key] ??= { key, picks: {}, note: '', sel: 1, typing: false }); }
  async function send() {
    const entry = entryOf(s.entryKey), a = entry && answerFor(entry.key);
    const text = entry && answerMessage(entry, a.picks, a.note);
    if (!text) { s.message = 'Choose an answer first.'; changed(); return; }
    if (await sendText(text)) s.sent[entry.key] = { at: new Date(d.now()).toISOString(), text };
  }
  // One message to the supervisor chat, never over its unsent draft.
  async function sendText(text) {
    const agent = s.agents.find(x => x.name === s.watching || x.pane === s.watching);
    if (!agent?.name) { s.message = 'No supervisor chat with a Herdr agent name beside this pane.'; changed(); return false; }
    const screen = await d.herdrVisible(agent.pane);
    const draft = screen.ok ? promptDraft(screen.text) : null;
    if (draft) { s.message = `${agent.name} has unsent text in its prompt box (“${clip(draft, 30)}”). Send or clear it first.`; changed(); return false; }
    const r = await d.herdrPrompt(agent.name, text);
    s.message = r.ok ? `Sent to ${agent.name}.` : r.blocked ? `${agent.name} is stuck at a prompt and refused it; answer that first.` : `Not sent: ${r.error}`;
    changed(); return r.ok;
  }
  const move = n => {
    const t = s.targets; if (!t.length) return;
    const i = t.indexOf(s.selected);
    s.selected = t[Math.max(0, Math.min(t.length - 1, (i < 0 ? (n > 0 ? -1 : t.length) : i) + n))]; changed();
  };
  const idOf = target => target?.startsWith('item:') ? target.slice(5).split(/[#~]/)[0] : null;
  async function open(target) {
    if (target === 'back') return back();
    if (target === 'go') return go();
    if (target === 'send') return send();
    if (target === 'send-ask') { if (s.ask && await sendText(s.ask.text)) s.ask = null; return; }
    if (target?.startsWith('ask:')) {
      // A dispatch or redeploy is the supervisor's to do; the pane asks it to.
      const id = target.slice(4), tr = model().tracked.find(x => x.id === s.detail), u = [...(tr?.unblock ?? []), ...(tr?.action ? [{ id: tr.id, ...tr.action }] : [])].find(x => x.id === id);
      if (!u) return;
      const why = tr.state === 'blocked' ? `; it blocks ${tr.id}` : '';
      s.ask = { item: s.detail, text: u.kind === 'dispatch' ? `Operator from the items pane: please dispatch ${id}${why}.` : `Operator from the items pane: ${id}: ${u.text}${why}.` };
      s.selected = 'send-ask'; changed(); return;
    }
    if (target?.startsWith('pick:')) { const a = answerFor(s.entryKey); a.sel = Number(target.slice(5)); changed(); return; }
    if (target?.startsWith('wait:')) {
      const entry = entryOf(target.slice(5)); if (!entry) return;
      s.history.push({ view: s.view, detail: s.detail, selected: s.selected, scroll: s.scroll, entryKey: s.entryKey });
      Object.assign(s, { view: 'item', detail: entry.id, entryKey: entry.key, selected: null, scroll: 0, message: '' }); s.answer = answerFor(entry.key); changed(); return;
    }
    const id = idOf(target); if (!id) return;
    s.history.push({ view: s.view, detail: s.detail, selected: s.selected, scroll: s.scroll });
    const waiting = model().waiting.find(w => w.id === id);
    Object.assign(s, { view: 'item', detail: id, entryKey: waiting?.key ?? null, selected: null, scroll: 0, message: '' }); s.answer = waiting ? answerFor(waiting.key) : null; changed();
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
      const entry = s.view === 'item' && s.entryKey ? entryOf(s.entryKey) : null, a = entry ? answerFor(entry.key) : null;
      if (a?.typing) {
        if (k.return || k.escape) a.typing = false;
        else if (k.backspace || k.delete) a.note = [...a.note].slice(0, -1).join('');
        else if (input && !k.ctrl && !k.meta) a.note += input.replace(/[\x00-\x1f\x7f]/g, '');
        changed(); return false;
      }
      if (a && !k.ctrl && !k.meta) {
        const n = entry.decisions.length;
        if (/^[1-9]$/.test(input) && Number(input) <= n) { a.sel = Number(input); changed(); return false; }
        if (input === 'y' || input === 'n') { a.picks[a.sel] = input === 'y' ? 'yes' : 'no'; if (a.sel < n) a.sel++; changed(); return false; }
        if (input === 'a') { for (const d of entry.decisions) a.picks[d.n] = d.recommend ? 'rec' : a.picks[d.n]; changed(); return false; }
        if (input === 'x') { a.picks = {}; a.note = ''; changed(); return false; }
        if (input === 'e') { a.typing = true; changed(); return false; }
        if (k.return && (!s.selected || /^(pick:|send$)/.test(s.selected))) { await send(); return false; }
      }
      if (input === 'q' || (k.ctrl && input === 'c')) return true;
      if (input === 's' && s.view === 'feed') { s.sort = { blocking: 'oldest', oldest: 'id', id: 'blocking' }[s.sort]; changed(); return false; }
      if (k.escape || input === 'b') { back(); return false; }
      if (k.upArrow || input === 'k') move(-1);
      else if (k.downArrow || input === 'j') move(1);
      else if (k.pageDown) { s.scroll += 10; changed(); } else if (k.pageUp) { s.scroll = Math.max(0, s.scroll - 10); changed(); }
      else if (k.return) await open(s.selected ?? (s.ask && s.view === 'item' ? 'send-ask' : s.targets[0]));
      else if (input === 'o' && s.view === 'item') await go();
      else if (input === 'f') { s.view2 = VIEWS[(VIEWS.indexOf(s.view2 ?? 'unresolved') + 1) % VIEWS.length]; s.selected = null; s.scroll = 0; changed(); }
      else if (input === 'F') { s.filter = FILTERS[(FILTERS.indexOf(s.filter) + 1) % FILTERS.length]; s.selected = null; s.scroll = 0; changed(); }
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
      if (target) { if (!['back', 'go', 'send'].includes(target.id) && !target.id.startsWith('pick:')) s.selected = target.id; await open(target.id); }
      return false;
    },
    async start() { s.timer = setInterval(() => refresh().catch(() => {}), (config.feed_seconds ?? 3) * 1000); return refresh(); },
    stop() { s.stopped = true; clearInterval(s.timer); },
  };
}
