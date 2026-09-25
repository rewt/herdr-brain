// A work block, top down: what the sessions of one stretch of work started from,
// did, spawned, asked and were told, and what is still pending. Deterministic for a
// fixed record, `now` and TZ; zero inference. The console reads it as
// `org recap --json`; `org recap` prints the same thing for a fresh session.
//
// A block is a stretch of activity with no quiet gap longer than GAP_HOURS. A
// stretch longer than MAX_HOURS is cut at local CUT_HOURS, and a piece shorter than
// MIN_HOURS joins its neighbour, so an overnight run reads as one block and a long
// day as its morning, afternoon and evening.
import { ancestors, blockedBy, isResolved, statusMap } from './state.mjs';
import { truncate } from './render.mjs';
import { sanitizeTerminal } from './sanitize.mjs';

export const BLOCK_RULES = { gapHours: 2, maxHours: 8, minHours: 1.5, cutHours: [6, 12, 18, 22], staleHours: 48 };

const HOUR = 3600000;
const ms = (iso) => Date.parse(iso);
const isQuestion = (item) => item?.role === 'human' && item.kind !== 'goal';
const firstSentence = (text) => {
  const t = String(text ?? '').replace(/\s+/g, ' ').trim();
  const m = /^(.{12,}?[.!?])(\s|$)/.exec(t);
  return m ? m[1] : t;
};

// morning 05-12, afternoon 12-17, evening 17-22, overnight otherwise; by the
// local hour at the middle of the block.
export function blockName(startMs, endMs) {
  const mid = new Date((startMs + endMs) / 2);
  const h = mid.getHours();
  const part = h >= 5 && h < 12 ? 'morning' : h >= 12 && h < 17 ? 'afternoon' : h >= 17 && h < 22 ? 'evening' : 'overnight';
  const day = new Date(part === 'overnight' && h < 5 ? startMs : mid).toLocaleDateString('en-US', { weekday: 'short' });
  return `${day} ${part}`;
}

function cutsBetween(startMs, endMs, hours) {
  const out = [];
  const day = new Date(startMs);
  day.setHours(0, 0, 0, 0);
  for (let d = new Date(day); d.getTime() <= endMs; d.setDate(d.getDate() + 1)) {
    for (const h of hours) {
      const t = new Date(d);
      t.setHours(h, 0, 0, 0);
      if (t.getTime() > startMs && t.getTime() < endMs) out.push(t.getTime());
    }
  }
  return out.sort((a, b) => a - b);
}

// Every block in the record, oldest first: { start, end, live, name, events }.
export function listBlocks(events, now, rules = BLOCK_RULES) {
  const times = events.map((e) => ms(e.at)).filter(Number.isFinite).sort((a, b) => a - b);
  const spans = [];
  for (const t of times) {
    const last = spans.at(-1);
    if (last && t - last.times.at(-1) <= rules.gapHours * HOUR) last.times.push(t);
    else spans.push({ times: [t] });
  }
  const pieces = [];
  for (const span of spans) {
    const first = span.times[0], last = span.times.at(-1);
    if (last - first <= rules.maxHours * HOUR) { pieces.push(span.times); continue; }
    const cuts = cutsBetween(first, last, rules.cutHours);
    let parts = [];
    let i = 0;
    for (const cut of [...cuts, Infinity]) {
      const part = [];
      while (i < span.times.length && span.times[i] < cut) part.push(span.times[i++]);
      if (part.length) parts.push(part);
    }
    // A short piece joins its neighbour: the previous one, or the next for the first.
    let merged = true;
    while (merged && parts.length > 1) {
      merged = false;
      for (let k = 0; k < parts.length; k++) {
        const p = parts[k];
        if (p.at(-1) - p[0] >= rules.minHours * HOUR) continue;
        const into = k === 0 ? 1 : k - 1;
        parts[into] = into < k ? [...parts[into], ...p] : [...p, ...parts[into]];
        parts.splice(k, 1);
        merged = true;
        break;
      }
    }
    pieces.push(...parts);
  }
  const nowMs = now.getTime();
  return pieces.map((p, i) => {
    const start = p[0], end = p.at(-1);
    const live = i === pieces.length - 1 && nowMs - end <= rules.gapHours * HOUR;
    return { start: new Date(start).toISOString(), end: new Date(end).toISOString(), live, name: blockName(start, live ? Math.max(end, nowMs) : end), events: p.length };
  });
}

function runAgent(run) {
  return run?.meta?.agent ?? null;
}

// The block `back` blocks before the latest (0 is the latest).
export function blockJson(s, events, { now, orgDir = null, back = 0, rules = BLOCK_RULES } = {}) {
  const all = listBlocks(events, now, rules);
  const index = all.length - 1 - Math.max(0, back);
  const b = all[index] ?? null;
  const statuses = statusMap(s);
  const head = { project: { org: orgDir, as_of: now.toISOString(), events: events.length },
    rules, blocks: { count: all.length, index, previous: all[index - 1] ?? null, next: all[index + 1] ?? null } };
  const waiting = [...s.items.values()].filter((i) => isQuestion(i) && !i.closed)
    .map((i) => questionFacts(s, i, statuses)).sort((a, b) => (a.asked.at < b.asked.at ? 1 : -1));
  if (!b) return { ...head, block: null, waiting, sessions: [], threads: [], decisions: [], pending: [], backlog: backlogFacts(s, events, statuses, new Set(), now, rules) };

  const from = ms(b.start), to = b.live ? Infinity : ms(b.end);
  const inWindow = (e) => { const t = ms(e.at); return t >= from && t <= to; };
  const win = events.filter(inWindow);

  // Items worked (a run started or reported) or created in the block.
  const worked = new Set(), created = new Map(), runsIn = new Map();
  for (const e of win) {
    if (e.type === 'run.started') { runsIn.set(e.id, s.runs.get(e.id)); worked.add(e.item); }
    if (e.type === 'report.ingested') { runsIn.set(e.run, s.runs.get(e.run)); worked.add(e.item); }
    if (e.type === 'item.added' && e.kind !== 'goal') created.set(e.id, e);
  }
  const inBlock = new Set([...worked, ...created.keys()].filter((id) => s.items.get(id) && s.items.get(id).kind !== 'goal'));
  const rootOf = (id) => {
    let cur = id;
    const seen = new Set([id]);
    for (;;) {
      const parent = s.items.get(cur)?.parent;
      if (!parent || seen.has(parent) || !inBlock.has(parent)) return cur;
      seen.add(parent);
      cur = parent;
    }
  };
  // A question answered here but asked earlier joins the thread of the work it blocks.
  const answeredIn = new Map();
  for (const e of win) {
    if (e.type === 'item.updated' && e.fields?.meta?.answer != null && isQuestion(s.items.get(e.id))) answeredIn.set(e.id, e);
  }
  const questionThread = (id) => {
    const q = s.items.get(id);
    if (inBlock.has(id)) return rootOf(id);
    for (const blocked of blockedBy(s, id)) if (inBlock.has(blocked)) return rootOf(blocked);
    if (q?.parent && inBlock.has(q.parent)) return rootOf(q.parent);
    return null;
  };

  const threads = new Map();
  const thread = (root) => {
    if (!threads.has(root)) {
      const r = s.items.get(root);
      const origin = r.parent ? s.items.get(r.parent) : null;
      const goal = ancestors(s, root).find((a) => a.kind === 'goal') ?? null;
      threads.set(root, {
        root: { id: r.id, title: r.title, role: r.role, status: statuses.get(r.id), created: { at: r.created.at, by: r.created.by, run: r.created.run } },
        origin: origin && origin.kind !== 'goal' ? { id: origin.id, title: origin.title, created: { at: origin.created.at, by: origin.created.by } } : null,
        goal: goal ? { id: goal.id, title: goal.title } : null,
        items: [], runs: [], spawned: [], questions: [], decisions: [], agents: [], first: null, last: null, now: null,
      });
    }
    return threads.get(root);
  };
  for (const id of inBlock) if (!isQuestion(s.items.get(id))) thread(rootOf(id)).items.push(id);
  const threadOfItem = new Map();
  for (const [root, t] of threads) for (const id of t.items) threadOfItem.set(id, root);
  const touch = (t, at, text, kind) => {
    if (!t.first || at < t.first) t.first = at;
    if (!t.last || at >= t.last) t.last = at;
    if (text && (!t.now || at >= t.now.at)) t.now = { at, text, kind };
  };

  for (const [id, run] of runsIn) {
    if (!run) continue;
    const root = threadOfItem.get(run.item);
    if (!root) continue;
    const t = thread(root);
    const report = run.report && inWindow({ at: run.report.at }) ? run.report : null;
    t.runs.push({ run: id, item: run.item, role: s.items.get(run.item)?.role ?? null, agent: runAgent(run), lane: run.meta.lane ?? null,
      started: run.started.at, started_by: run.started.by, reported: report?.at ?? null, outcome: report?.outcome ?? null,
      headline: report ? (report.headline ?? firstSentence(report.summary)) : null, open: !run.report && !run.abandoned, abandoned: Boolean(run.abandoned) });
    const agent = runAgent(run) ?? `run ${id}`;
    if (!t.agents.includes(agent)) t.agents.push(agent);
    touch(t, run.started.at);
    if (report) touch(t, report.at, report.headline ?? firstSentence(report.summary), 'report');
  }
  for (const [id, e] of created) {
    const item = s.items.get(id);
    if (!item || isQuestion(item)) continue;
    const t = thread(threadOfItem.get(id));
    if (t.root.id === id) { touch(t, e.at); continue; }
    t.spawned.push({ id, title: item.title, role: item.role, status: statuses.get(id), at: e.at, by: e.by, run: e.from_run ?? null, parent: item.parent });
    touch(t, e.at);
  }
  // Decisions recorded on the thread's items (answer notes belong to their question).
  for (const e of win) {
    if (e.type !== 'note.added' || !e.decision || e.kind === 'answer') continue;
    const root = threadOfItem.get(e.id);
    if (!root) continue;
    const t = thread(root);
    const text = e.summary ?? firstSentence(e.text);
    t.decisions.push({ id: e.id, at: e.at, by: e.by, summary: e.summary ?? null, text });
    touch(t, e.at, text, 'decision');
  }
  for (const e of win) {
    if (e.type === 'item.closed' && threadOfItem.has(e.id) && e.note) touch(thread(threadOfItem.get(e.id)), e.at);
  }
  // A thread with nothing reported or decided yet says what is running.
  for (const t of threads.values()) {
    const last = [...t.runs].sort((a, b) => (a.started < b.started ? -1 : 1)).at(-1);
    if (!t.now && last) {
      t.now = { at: last.started, kind: last.open ? 'running' : 'started',
        text: `${last.run} on ${last.item} ${last.open ? `running since ${hm(last.started)}` : last.abandoned ? 'abandoned' : `started ${hm(last.started)}, reported after this block`}` };
    }
  }

  // Questions: asked in the block, or asked earlier and answered here.
  const questions = new Map();
  for (const [id] of created) if (isQuestion(s.items.get(id))) questions.set(id, s.items.get(id));
  for (const [id] of answeredIn) questions.set(id, s.items.get(id));
  const questionList = [];
  for (const [id, q] of questions) {
    const facts = questionFacts(s, q, statuses);
    const answer = answeredIn.get(id);
    facts.asked_here = created.has(id);
    facts.answered_here = Boolean(answer);
    const root = questionThread(id);
    facts.thread = root && threads.has(root) ? root : null;
    if (facts.thread) {
      const t = threads.get(root);
      t.questions.push(facts);
      touch(t, facts.asked_here ? facts.asked.at : answer.at);
      if (answer) touch(t, answer.at, `${q.id} answered ${facts.answer}${facts.answered?.note ? `: ${firstSentence(facts.answered.note)}` : ''}`, 'answer');
    }
    questionList.push(facts);
  }

  // Sessions: one per actor that is not a run, one per worker agent.
  const sessions = new Map();
  const session = (name, kind) => {
    if (!sessions.has(name)) sessions.set(name, { name, kind, events: 0, runs_started: 0, items_created: 0, answers: 0, decisions: 0, closed: 0, runs: [], lanes: [], unattributed: 0, first: null, last: null, headline: null });
    return sessions.get(name);
  };
  const actorOf = (by) => {
    const m = /^run:(.+)$/.exec(by);
    if (m) { const run = s.runs.get(m[1]); return session(runAgent(run) ?? `run ${m[1]}`, 'worker'); }
    return session(by, by === 'human' ? 'human' : 'session');
  };
  for (const e of win) {
    const x = actorOf(e.by);
    x.events++;
    if (e.unattributed) x.unattributed++;
    if (!x.first) x.first = e.at;
    x.last = e.at;
    if (e.type === 'run.started') x.runs_started++;
    if (e.type === 'item.added') x.items_created++;
    if (e.type === 'item.updated' && e.fields?.meta?.answer != null) x.answers++;
    if (e.type === 'note.added' && e.decision && e.kind !== 'answer') x.decisions++;
    if (e.type === 'item.closed' && !isQuestion(s.items.get(e.id))) x.closed++;
  }
  for (const [id, run] of runsIn) {
    if (!run) continue;
    const x = session(runAgent(run) ?? `run ${id}`, 'worker');
    x.runs.push(id);
    if (run.meta.lane && !x.lanes.includes(run.meta.lane)) x.lanes.push(run.meta.lane);
    if (!x.first || run.started.at < x.first) x.first = run.started.at;
    if (run.report && inWindow({ at: run.report.at })) {
      if (!x.last || run.report.at >= x.last) { x.last = run.report.at; x.headline = run.report.headline ?? firstSentence(run.report.summary); }
    }
  }
  for (const x of sessions.values()) if (x.kind === 'session' && x.runs_started) x.kind = 'orchestrator';
  const kindRank = { orchestrator: 0, session: 1, human: 2, worker: 3 };
  const sessionList = [...sessions.values()].sort((a, b) => kindRank[a.kind] - kindRank[b.kind] || (a.last < b.last ? 1 : -1));

  // Steering and decisions, newest first: questions asked and answered, decision notes.
  const decisions = [];
  for (const q of questionList) {
    if (q.asked_here) decisions.push({ kind: 'asked', at: q.asked.at, id: q.id, title: q.title, by: q.asked.by, run: q.asked.run, thread: q.thread });
    if (q.answered_here) decisions.push({ kind: 'answered', at: q.answered.at, id: q.id, title: q.title, answer: q.answer, by: q.answered.by, note: q.answered.note, thread: q.thread });
  }
  for (const t of threads.values()) for (const d of t.decisions) decisions.push({ kind: 'decision', at: d.at, id: d.id, title: d.text, by: d.by, thread: t.root.id });
  for (const e of win) {
    // Decisions on items outside every thread (a goal, an older item) still steer the block.
    if (e.type !== 'note.added' || !e.decision || e.kind === 'answer' || threadOfItem.has(e.id) || isQuestion(s.items.get(e.id))) continue;
    decisions.push({ kind: 'decision', at: e.at, id: e.id, title: e.summary ?? firstSentence(e.text), by: e.by, thread: null });
  }
  decisions.sort((a, b) => (a.at === b.at ? 0 : a.at < b.at ? 1 : -1));

  const threadList = [...threads.values()].map((t) => {
    const open = t.spawned.filter((x) => !isResolved(statuses.get(x.id)) && statuses.get(x.id) !== 'done');
    return { ...t, counts: { runs: t.runs.length, spawned: t.spawned.length, open: open.length, questions_open: t.questions.filter((q) => !q.answer).length, decisions: t.decisions.length } };
  }).sort((a, b) => (b.counts.questions_open - a.counts.questions_open) || (a.last === b.last ? b.counts.runs - a.counts.runs : a.last < b.last ? 1 : -1));

  // Origins the threads grew from (the item above each root), most common first.
  const origins = new Map();
  for (const t of threadList) if (t.origin) origins.set(t.origin.id, { ...t.origin, threads: (origins.get(t.origin.id)?.threads ?? 0) + 1 });

  const pending = threadList.flatMap((t) => t.spawned.filter((x) => !isResolved(statuses.get(x.id)) && statuses.get(x.id) !== 'done').map((x) => ({ ...x, thread: t.root.id })));
  const counts = {
    runs: runsIn.size,
    reported: [...runsIn.values()].filter((r) => r?.report && inWindow({ at: r.report.at })).length,
    running: [...runsIn.values()].filter((r) => r && !r.report && !r.abandoned).length,
    spawned: [...created.keys()].filter((id) => !isQuestion(s.items.get(id))).length,
    pending: pending.length,
    decisions: decisions.filter((d) => d.kind === 'decision').length,
    asked: questionList.filter((q) => q.asked_here).length,
    answered: questionList.filter((q) => q.answered_here).length,
    workers: sessionList.filter((x) => x.kind === 'worker').length,
    closed: win.filter((e) => e.type === 'item.closed' && e.as !== 'dropped' && !isQuestion(s.items.get(e.id))).length,
    dropped: win.filter((e) => e.type === 'item.closed' && e.as === 'dropped').length,
    unattributed: sessionList.reduce((n, x) => n + x.unattributed, 0),
  };
  return {
    ...head,
    block: { ...b, hours: Math.round(((b.live ? Math.max(ms(b.end), now.getTime()) : ms(b.end)) - from) / HOUR * 10) / 10 },
    counts,
    origins: [...origins.values()].sort((a, b) => b.threads - a.threads),
    waiting,
    sessions: sessionList,
    threads: threadList,
    decisions,
    pending,
    backlog: backlogFacts(s, events, statuses, new Set([...inBlock]), now, rules),
  };
}

function questionFacts(s, q, statuses) {
  const answerNote = [...q.notes].reverse().find((n) => n.kind === 'answer');
  const run = q.created.run ? s.runs.get(q.created.run) : null;
  return {
    id: q.id, title: q.title, status: statuses.get(q.id), category: q.meta.category ?? null, recommend: q.meta.recommend ?? null,
    asked: { at: q.created.at, by: q.created.by, run: q.created.run ?? null, agent: runAgent(run), lane: run?.meta.lane ?? null, parent: q.parent },
    answer: q.closed ? q.meta.answer ?? null : null,
    answered: q.closed ? { at: q.closed.at, by: q.meta.answered_by ?? answerNote?.by ?? q.closed.by, note: q.closed.note ?? null } : null,
    blocks: blockedBy(s, q.id),
  };
}

// Open work outside the block, folded: how much, how stale, and where it came from.
function backlogFacts(s, events, statuses, inBlock, now, rules) {
  const touched = new Map();
  const mark = (id, at) => { if (id) touched.set(id, at); };
  for (const e of events) {
    mark(e.id, e.at); mark(e.item, e.at); mark(e.blocker, e.at); mark(e.blocked, e.at);
    if (e.type === 'run.updated' || e.type === 'run.abandoned') mark(s.runs.get(e.id)?.item, e.at);
  }
  const open = [...s.items.values()].filter((i) => i.kind !== 'goal' && !i.closed && !isQuestion(i));
  const unclosedDone = open.filter((i) => statuses.get(i.id) === 'done').length;
  const work = open.filter((i) => statuses.get(i.id) !== 'done' && !inBlock.has(i.id));
  const stale = new Set(work.filter((i) => now.getTime() - ms(touched.get(i.id) ?? i.created.at) > rules.staleHours * HOUR));
  // Grouped by the goal it sits under, then by the item it was spawned under
  // (a proposal is a child of the item whose run proposed it).
  const byGoal = new Map();
  const newer = (a, b) => (!a || b > a ? b : a);
  for (const i of work) {
    const goal = ancestors(s, i.id).find((a) => a.kind === 'goal') ?? null;
    const key = goal?.id ?? '';
    const g = byGoal.get(key) ?? { goal: goal ? { id: goal.id, title: goal.title } : null, count: 0, stale: 0, from_runs: 0, newest: null, parents: new Map() };
    const t = touched.get(i.id) ?? i.created.at;
    g.count++;
    if (stale.has(i)) g.stale++;
    if (i.created.run) g.from_runs++;
    g.newest = newer(g.newest, t);
    const parent = i.parent && i.parent !== goal?.id ? i.parent : null;
    if (parent) {
      const p = g.parents.get(parent) ?? { id: parent, title: s.items.get(parent)?.title ?? '', status: statuses.get(parent) ?? null, count: 0, stale: 0, newest: null };
      p.count++;
      if (stale.has(i)) p.stale++;
      p.newest = newer(p.newest, t);
      g.parents.set(parent, p);
    }
    byGoal.set(key, g);
  }
  return {
    open: work.length,
    stale: stale.size,
    from_runs: work.filter((i) => i.created.run).length,
    never_run: work.filter((i) => !i.runs.length).length,
    reported_done_unclosed: unclosedDone,
    by_goal: [...byGoal.values()].sort((a, b) => b.count - a.count)
      .map((g) => ({ ...g, direct: g.count - [...g.parents.values()].reduce((n, p) => n + p.count, 0), parents: [...g.parents.values()].sort((a, b) => b.count - a.count || (a.newest < b.newest ? 1 : -1)) })),
  };
}

const hm = (iso) => {
  const d = new Date(iso);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};

export function renderBlock(doc) {
  const out = [];
  if (!doc.block) return 'no activity recorded yet\n';
  const b = doc.block, c = doc.counts;
  out.push(`${b.name} · ${hm(b.start)}–${b.live ? 'now' : hm(b.end)} · ${b.hours}h${b.live ? ' · still going' : ''}  (block ${doc.blocks.index + 1} of ${doc.blocks.count})`);
  out.push(`${c.runs} runs by ${c.workers} worker sessions · ${c.spawned} items spawned, ${c.pending} still open · ${c.decisions} decisions · ${c.asked} asked, ${c.answered} answered`);
  if (c.unattributed) out.push(`${c.unattributed} writes had no ORG_ACTOR and no terminal: recorded as human, unverified`);
  for (const o of doc.origins) out.push(`grew from ${o.id} ${truncate(o.title, 90)} (${o.threads} thread${o.threads === 1 ? '' : 's'})`);
  out.push('', `WAITING ON YOU (${doc.waiting.length})`);
  for (const q of doc.waiting) out.push(`  ${q.id}  ${truncate(q.title, 100)} · asked ${new Date(q.asked.at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })} ${hm(q.asked.at)} by ${q.asked.run ?? q.asked.by}`);
  if (!doc.waiting.length) out.push('  nothing');
  out.push('', `THREADS (${doc.threads.length})`);
  for (const t of doc.threads) {
    out.push(`  ${t.root.id}  ${truncate(t.root.title, 90)}`);
    out.push(`      ${t.counts.runs} runs · ${t.agents.length} sessions · ${t.counts.spawned} spawned, ${t.counts.open} open · ${t.counts.decisions} decisions${t.counts.questions_open ? ` · ${t.counts.questions_open} question open` : ''}`);
    if (t.now) out.push(`      ${hm(t.now.at)} ${truncate(t.now.text, 110)}`);
  }
  out.push('', 'STEERING AND DECISIONS');
  for (const d of doc.decisions.slice(0, 20)) {
    const what = d.kind === 'answered' ? `${d.id} → ${d.answer}${d.note ? `: ${d.note}` : ''}` : d.kind === 'asked' ? `asked ${d.id}: ${d.title}` : `${d.id} ${d.title}`;
    out.push(`  ${hm(d.at)}  ${truncate(what, 110)} · ${d.by}`);
  }
  out.push('', 'SESSIONS');
  for (const x of doc.sessions) {
    const did = x.kind === 'worker' ? `${x.runs.length} runs${x.lanes.length ? ` · ${x.lanes.join(', ')}` : ''}` : `${x.runs_started} runs started · ${x.answers} answers · ${x.decisions} decisions · ${x.items_created} items`;
    out.push(`  ${x.kind.padEnd(12)} ${x.name} · ${did}`);
  }
  const bl = doc.backlog;
  out.push('', `PENDING ${doc.pending.length} spawned this block · BACKLOG ${bl.open} older open items (${bl.stale} untouched ${doc.rules.staleHours}h+) · ${bl.reported_done_unclosed} reported done but not closed`);
  return sanitizeTerminal(out.join('\n') + '\n');
}
