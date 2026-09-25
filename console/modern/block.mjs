// The block screen: one stretch of work, top down. What the sessions started
// from, what each thread did, spawned and asked, where the operator steered,
// what is pending, with the older backlog folded. Everything comes from
// `org recap --json` (the org's own derivation), joined to live Herdr sessions
// by agent name for display only. Pure: no IO, no model.
import { pad, padStart, clip, wrap } from '../lib/text.mjs';
import { sessionGroups, sessionName, shortAge, checkoutName } from './project.mjs';

const cell = (text, col, w, extra = {}) => ({ text, col, w, fg: 'fg', bg: 'bg', ...extra });
const GLYPH = { working: '●', blocked: '!', idle: '○', done: '✔' };
const stateColor = state => state === 'working' ? 'teal' : state === 'blocked' ? 'amber' : state === 'done' ? 'teal' : 'muted';

export function hm(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}
export function dayHm(iso, ref) {
  if (!iso) return '';
  const d = new Date(iso), r = ref ? new Date(ref) : null;
  const same = r && d.toDateString() === r.toDateString();
  return same ? hm(iso) : `${d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })} ${hm(iso)}`;
}

// A title as the operator reads it: no leading record code, first sentence only.
export function plainTitle(title) {
  let t = String(title ?? '').replace(/\s+/g, ' ').trim().replace(/^[A-Z]{1,6}-\d+:\s*/, '');
  const m = /^(.{16,}?[.;])(\s|$)/.exec(t);
  if (m) t = m[1].replace(/[.;]$/, '');
  return t ? t[0].toUpperCase() + t.slice(1) : t;
}

// A lane and its review lanes are one line of work.
export const laneFamily = lane => String(lane ?? '').replace(/-review\d*$/, '');

// Who did something, in words: the operator, a named session, or a run with its lane.
export function actorWords(by, recap) {
  if (!by) return '';
  // Recorded as human: the operator, or a session that did not name itself.
  if (by === 'human') return 'human';
  const m = /^run:(R-\d+)$/.exec(by);
  if (!m) return by;
  const run = recap?.threads?.flatMap(t => t.runs).find(r => r.run === m[1]);
  return run?.lane ? `${m[1]} ${laneFamily(run.lane)}` : m[1];
}

// Where an item came from, in one line: which run (or session) created it, while
// working on what, and when. Built from org status JSON (items and runs).
export function provenance(item, runsById, itemsById) {
  if (!item?.created) return null;
  const c = item.created, when = dayHm(c.at);
  if (c.run) {
    const run = runsById?.get(c.run);
    const on = run?.item ? itemsById?.get(run.item) : null;
    const lane = run?.meta?.lane ? ` · lane ${laneFamily(run.meta.lane)}` : '';
    return `Spawned by ${c.run}${lane}${on ? ` while working ${on.id} ${plainTitle(on.title)}` : ''} · ${when}`;
  }
  if (c.by === 'human') return c.unattributed ? `Added as human with no session named (unverified) · ${when}` : `Added by you, or a session that did not name itself · ${when}`;
  return `Added by ${c.by} · ${when}`;
}

// The view model for the block screen.
export function blockView(m) {
  const r = m.recap;
  if (!r?.block) return null;
  const needFor = id => m.allNeeds.find(n => n.kind === 'question' && n.question === id) ?? null;
  const decide = r.waiting.map(q => ({ ...q, need: needFor(q.id) }));
  // What stopped sessions left behind that the org does not record: shown as
  // such, never counted as the org's decisions.
  const prompts = m.needs.filter(n => n.kind === 'result');
  const workers = new Map(r.sessions.map(x => [x.name, x]));
  const { order } = sessionGroups(m);
  const live = order.map((a, i) => {
    const agent = a.run?.agent ?? a.agent ?? a.live?.name ?? null;
    return { a, n: i + 1, block: workers.get(agent) ?? workers.get(a.session) ?? null };
  });
  const threads = r.threads.map(t => ({ ...t, lanes: [...new Set(t.runs.map(x => laneFamily(x.lane)).filter(Boolean))] }));
  return { r, decide, prompts, live, threads };
}

// The overview body when a recap is available.
export function blockRows({ model: m, state: s, width, height, now = Date.now() }) {
  const v = blockView(m);
  const rows = [], add = (region, ...cells) => rows.push(cells.map(c => ({ region, ...c })));
  const blank = () => add('content', cell('', 0, width));
  const { r, decide, prompts, live, threads } = v, b = r.block, c = r.counts;
  const compact = width < 110;

  // The block: when, how much, and what it grew from.
  const when = `${b.name} · ${hm(b.start)}–${b.live ? 'now' : hm(b.end)} · ${b.hours}h${b.live ? ' · still going' : ` · ended ${shortAge(now - Date.parse(b.end))} ago`}`;
  const prev = r.blocks.previous, next = r.blocks.next;
  const nav = `${prev ? `‹ [ ${prev.name}` : ''}${prev && next ? '   ' : ''}${next ? `${next.name} ] ›` : ''}`;
  const navW = Math.min(40, nav.length + 2);
  add('goals', cell(` ${when}`, 0, width - navW, { fg: 'bright', bg: 'goalBg', bold: true }),
    ...(prev ? [cell(`‹ [ ${prev.name}`, width - navW, prev && next ? navW - next.name.length - 8 : navW, { id: 'block:prev', fg: 'goal', bg: 'goalBg' })] : []),
    ...(next ? [cell(`${next.name} ] ›`, width - next.name.length - 5, next.name.length + 5, { id: 'block:next', fg: 'goal', bg: 'goalBg' })] : []),
    ...(!prev && !next ? [cell('', width - navW, navW, { bg: 'goalBg' })] : []));
  const facts = `${c.runs} runs by ${c.workers} worker sessions · ${c.decisions} decided · ${c.answered} answered · ${c.spawned} spawned${c.dropped ? ` · ${c.dropped} dropped` : ''}`;
  const pend = `${c.pending} still pending ›`;
  add('goals', cell(` ${facts} · `, 0, facts.length + 4, { fg: 'muted' }),
    cell(pend, facts.length + 4, width - facts.length - 4, { id: 'view:pending', fg: c.pending ? 'blue' : 'muted', bold: Boolean(c.pending) }));
  for (const o of r.origins.slice(0, 2)) {
    add('goals', cell(` grew from ${o.id} `, 0, o.id.length + 12, { id: `item:${o.id}`, fg: 'goal' }),
      cell(`${plainTitle(o.title)}${r.origins.length > 1 ? ` · ${o.threads} of ${threads.length} threads` : ''}`, o.id.length + 12, width - o.id.length - 12, { fg: 'goal' }));
  }
  if (c.unattributed) add('content', cell(` ${c.unattributed} writes in this block named no session: recorded as human, unverified`, 0, width, { fg: 'amber' }));
  blank();

  // Decide: the org's open questions, the same list org today and org status show.
  add('needs', cell(` Decide · ${decide.length}${r.blocks.next ? ' now' : ''}`, 0, 16, { fg: 'amber', bg: 'attentionBg', bold: true }),
    cell(padStart(compact ? 'the org\'s open questions ' : 'the org\'s open questions · the same list as org today ', width - 16), 16, width - 16, { fg: 'amber', bg: 'attentionBg' }));
  for (const q of decide) {
    const from = q.asked.run ? `${q.asked.run}${q.asked.lane ? ` ${laneFamily(q.asked.lane)}` : ''}` : actorWords(q.asked.by, r);
    const hint = ` ${q.recommend ? `recommend ${q.recommend} · ` : 'no recommendation · '}asked ${dayHm(q.asked.at, b.end)} · ${from}`;
    const hw = compact ? 0 : Math.min(58, hint.length + 1);
    add('needs', cell(`  ${pad(q.id, 9)}${plainTitle(q.title)}`, 0, width - hw, { id: q.need ? `need:${q.need.key}` : `item:${q.id}`, fg: 'bright', bg: 'attentionBg' }),
      ...(hw ? [cell(hint, width - hw, hw, { fg: 'muted', bg: 'attentionBg' })] : []));
  }
  if (!decide.length) add('needs', cell('  Nothing in the org waits on you.', 0, width, { fg: 'muted', bg: 'attentionBg' }));
  if (prompts.length) {
    const oldest = prompts.map(p => p.data?.at).filter(Boolean).sort()[0];
    add('needs', cell(`  + ${prompts.length} stopped session${prompts.length === 1 ? '' : 's'} left a question the org does not record${oldest ? ` · oldest ${dayHm(oldest, b.end)}` : ''} · review ›`, 0, width, { id: 'view:needs', fg: 'muted', bg: 'attentionBg' }));
  }
  blank();

  // Threads: each line of work in the block, from the item it started on.
  const tw = compact ? Math.max(18, Math.floor((width - 30) * .45)) : Math.max(24, Math.floor((width - 45) * .4));
  const cols = compact ? [['runs', 5], ['open', 5]] : [['runs', 5], ['lanes', 6], ['spawned', 8], ['open', 5]];
  const numsW = cols.reduce((n, [, w]) => n + w, 0), lastX = 12 + tw + numsW + 2, lastW = width - lastX;
  add('tasks', cell(` Threads · ${threads.length}`, 0, 12 + tw, { fg: 'blue', bold: true, bg: 'panel' }),
    ...cols.map(([name, w], i) => cell(padStart(name, w), 12 + tw + cols.slice(0, i).reduce((n, [, x]) => n + x, 0), w, { fg: 'muted', bg: 'panel' })),
    cell('  latest', 12 + tw + numsW, width - 12 - tw - numsW, { fg: 'muted', bg: 'panel' }));
  for (const t of threads) {
    const id = `thread:${t.root.id}`, asking = t.counts.questions_open > 0;
    const nums = { runs: t.counts.runs, lanes: t.lanes.length, spawned: t.counts.spawned, open: t.counts.open };
    add('tasks', cell(` ${asking ? '?' : ' '}${pad(t.root.id, 10)}`, 0, 12, { id, fg: asking ? 'amber' : 'goal', bold: asking }),
      cell(plainTitle(t.root.title), 12, tw, { id, fg: 'bright' }),
      ...cols.map(([name, w], i) => cell(padStart(nums[name] || '·', w), 12 + tw + cols.slice(0, i).reduce((n, [, x]) => n + x, 0), w, { id, fg: name === 'open' && nums.open ? 'blue' : 'muted' })),
      cell(`  ${t.now ? `${hm(t.now.at)} ${t.now.text}` : ''}`, lastX - 2, lastW + 2, { id, fg: t.now?.kind === 'decision' || t.now?.kind === 'answer' ? 'teal' : 'fg' }));
  }
  if (!threads.length) add('tasks', cell('  No work was started or spawned in this block.', 0, width, { fg: 'muted' }));
  blank();

  // Steered and decided: every point where a session decided, asked, or was answered.
  const steer = r.decisions;
  const shown = Math.max(3, Math.min(steer.length, height - rows.length - live.length - 7));
  add('content', cell(` Steered and decided · ${steer.length}`, 0, 30, { fg: 'goal', bold: true, bg: 'panel' }),
    cell(padStart(steer.length > shown ? `newest first · all ${steer.length} › ` : 'newest first ', width - 30), 30, width - 30, { id: steer.length > shown ? 'view:steered' : null, fg: 'muted', bg: 'panel' }));
  for (const d of steer.slice(0, shown)) add('content', ...steerCells(d, r, width));
  if (!steer.length) add('content', cell('  Nothing was decided or asked in this block.', 0, width, { fg: 'muted' }));
  blank();

  // Sessions now: live Herdr sessions, numbered, with what each did in this block.
  add('sessions', cell(` Sessions now · ${live.length}`, 0, 20, { fg: 'teal', bold: true, bg: 'panel' }),
    cell(padStart('a number opens it · click a name to rename ', width - 20), 20, width - 20, { fg: 'muted', bg: 'panel' }));
  const nameW = Math.max(16, Math.min(30, Math.floor(width * .22))), whereW = compact ? 0 : 22, stW = 14;
  for (const { a, n, block } of live) {
    const row = `session:${a.pane}`, renaming = s.rename?.pane === a.pane;
    const since = a.since ? shortAge(now - a.since) : a.up === 'unknown' ? '' : a.up ?? '';
    const did = block?.kind === 'worker' ? `${block.runs.length} run${block.runs.length === 1 ? '' : 's'} this block${block.headline ? ` · ${block.headline}` : ''}`
      : block ? `${block.runs_started} runs started · ${block.answers} answers · ${block.decisions} decisions this block`
        : a.task ? `${a.task}${a.recorded ? ' (last)' : ''} ${plainTitle(m.itemsById.get(a.task)?.title ?? '')}` : a.doing && a.doing !== 'no description' ? a.doing : 'chat';
    const x = 5 + 1 + nameW + whereW + stW;
    add('sessions', cell(`${padStart(n, 3)}  `, 0, 5, { id: row, fg: 'muted' }),
      cell(GLYPH[a.state] ?? '·', 5, 1, { id: row, fg: stateColor(a.state) }),
      renaming ? cell(` ${s.rename.text}▏`, 6, nameW, { fg: 'bright', bg: 'selected', bold: true })
        : cell(` ${sessionName(a)}`, 6, nameW, { id: `rename:${a.pane}`, hitOnly: true, focusAs: row, fg: a.state === 'blocked' ? 'amber' : 'bright', bold: a.state === 'working' || a.state === 'blocked' }),
      ...(whereW ? [cell(` ${checkoutName(m.spaces.find(w => w.workspace_id === a.space)) ?? ''}`, 6 + nameW, whereW, { id: row, fg: 'muted' })] : []),
      cell(` ${pad(a.state ?? '', 7)} ${padStart(since, 4)}`, 6 + nameW + whereW, stW, { id: row, fg: stateColor(a.state) }),
      cell(` ${did}`, x, width - x, { id: row, fg: block ? 'fg' : 'muted' }));
  }
  // Org sessions of this block that no live session carries the name of.
  const joined = new Set(live.map(x => x.block?.name).filter(Boolean));
  for (const x of r.sessions.filter(x => x.kind !== 'worker' && !joined.has(x.name))) {
    const did = `${x.runs_started} runs started · ${x.answers} answers · ${x.decisions} decisions · ${x.items_created} items added`;
    const note = x.kind === 'human' ? (x.unattributed ? `${x.unattributed} writes by unnamed sessions` : 'the operator, or a session that did not set ORG_ACTOR') : 'org name only: no live session carries it';
    add('sessions', cell(`     · ${x.name}`, 0, 6 + nameW, { fg: 'fg' }),
      cell(` ${x.kind}`, 6 + nameW, whereW + stW, { fg: 'muted' }),
      cell(` ${did} · ${note}`, 6 + nameW + whereW + stW, width - 6 - nameW - whereW - stW, { fg: 'muted' }));
  }
  if (!live.length) add('sessions', cell(s.errors?.agents ? '  Session data is unavailable. Refresh to reconnect.' : '  No live sessions. Write below to start one.', 0, width, { fg: 'muted' }));
  blank();

  // Everything else stays folded: one line, one keypress away.
  const bl = r.backlog;
  add('content', cell(` Backlog · ${bl.open} older open items, folded · ${bl.stale} untouched ${Math.round(r.rules.staleHours / 24)}d+ · ${bl.reported_done_unclosed} reported done, never closed ›`, 0, width, { id: 'view:backlog', fg: 'muted' }));
  return rows;
}

function steerCells(d, r, width) {
  const by = actorWords(d.by, r);
  const tag = d.kind === 'answered' ? `${d.id} → ${clip(String(d.answer), 5)}` : d.kind === 'asked' ? `asked ${d.id}` : 'decided';
  const text = d.kind === 'answered' ? (d.note ?? plainTitle(d.title)) : d.kind === 'asked' ? plainTitle(d.title) : d.title;
  const byW = Math.min(width < 110 ? 18 : 30, by.length + 3), tagW = 16;
  const id = d.kind === 'decision' ? `item:${d.id}` : `item:${d.id}`;
  return [cell(`  ${hm(d.at)}  `, 0, 9, { id, fg: 'muted' }),
    cell(tag, 9, tagW, { id, fg: d.kind === 'asked' ? 'amber' : d.kind === 'answered' ? 'goal' : 'teal', bold: d.kind !== 'decision' }),
    cell(text, 9 + tagW, width - 9 - tagW - byW, { id, fg: 'fg' }),
    cell(` · ${by}`, width - byW, byW, { id, fg: 'muted' })];
}

// One thread, opened: where it started, what is pending in it, what was asked and
// decided, and every run, newest first.
export function threadRows({ model: m, detail, width }) {
  const v = blockView(m), rows = [], add = (region, ...cells) => rows.push(cells.map(c => ({ region, ...c })));
  const t = v?.threads.find(x => x.root.id === detail);
  if (!t) { add('content', cell('This thread is not in the block on screen. Esc goes back.', 0, width, { fg: 'muted' })); return rows; }
  const r = v.r, ref = r.block.end;
  add('goals', cell(` ${t.root.id} · ${t.root.status} · ${t.counts.runs} runs by ${t.agents.length} sessions in ${t.lanes.length} lane${t.lanes.length === 1 ? '' : 's'}`, 0, width, { id: `item:${t.root.id}`, fg: 'goal', bg: 'goalBg', bold: true }));
  for (const line of wrap(t.root.title, width - 4).slice(0, 4)) add('goals', cell(`   ${line}`, 0, width, { fg: 'bright' }));
  if (t.origin) add('goals', cell(`   grew from ${t.origin.id} ${plainTitle(t.origin.title)} · added ${dayHm(t.origin.created.at, ref)} by ${actorWords(t.origin.created.by, r)}`, 0, width, { id: `item:${t.origin.id}`, fg: 'goal' }));
  if (t.lanes.length) add('goals', cell(`   lanes: ${t.lanes.join(', ')}`, 0, width, { fg: 'muted' }));
  add('content', cell('', 0, width));
  const open = t.spawned.filter(x => !['done', 'dropped'].includes(x.status));
  add('tasks', cell(` Pending here · ${open.length} of ${t.spawned.length} spawned`, 0, width, { fg: 'blue', bold: true, bg: 'panel' }));
  for (const x of open) add('tasks', ...itemCells(x, r, width, ref));
  if (!open.length) add('tasks', cell('  Everything this thread spawned is done or dropped.', 0, width, { fg: 'muted' }));
  add('content', cell('', 0, width));
  add('needs', cell(` Asked and decided · ${t.questions.length + t.decisions.length}`, 0, width, { fg: 'goal', bold: true, bg: 'panel' }));
  const steer = r.decisions.filter(d => d.thread === t.root.id);
  for (const d of steer) add('needs', ...steerCells(d, r, width));
  if (!steer.length) add('needs', cell('  No questions or decisions in this thread.', 0, width, { fg: 'muted' }));
  add('content', cell('', 0, width));
  add('content', cell(` Runs · ${t.runs.length}, newest first`, 0, width, { fg: 'teal', bold: true, bg: 'panel' }));
  for (const x of [...t.runs].sort((a, b) => ((b.reported ?? b.started) > (a.reported ?? a.started) ? 1 : -1))) {
    const at = x.reported ?? x.started, lane = laneFamily(x.lane) + (/-review\d*$/.test(x.lane ?? '') ? ' review' : '');
    add('content', cell(`  ${hm(at)}  ${pad(x.run, 6)} ${pad(x.item, 9)}`, 0, 28, { id: `item:${x.item}`, fg: 'muted' }),
      cell(pad(x.open ? 'running' : x.abandoned ? 'abandoned' : x.outcome ?? '', 12), 28, 12, { id: `item:${x.item}`, fg: x.outcome === 'done' ? 'teal' : x.open ? 'blue' : x.abandoned ? 'muted' : 'amber' }),
      cell(x.headline ?? '', 40, width - 40 - 26, { id: `item:${x.item}` }),
      cell(clip(lane, 25), width - 25, 25, { fg: 'muted' }));
  }
  return rows;
}

function itemCells(x, r, width, ref) {
  const from = x.run ? `${x.run}` : actorWords(x.by, r);
  const hint = ` ${from} · ${dayHm(x.at, ref)}`, hw = Math.min(26, hint.length + 1);
  return [cell(`  ${pad(x.id, 9)}${pad(x.status, 8)}`, 0, 19, { id: `item:${x.id}`, fg: x.status === 'blocked' ? 'amber' : 'muted' }),
    cell(plainTitle(x.title), 19, width - 19 - hw, { id: `item:${x.id}` }),
    cell(hint, width - hw, hw, { fg: 'muted' })];
}

// Everything spawned in the block and still open, by thread.
export function pendingRows({ model: m, width }) {
  const v = blockView(m), rows = [], add = (region, ...cells) => rows.push(cells.map(c => ({ region, ...c })));
  if (!v) { add('content', cell('No block recorded yet.', 0, width, { fg: 'muted' })); return rows; }
  add('content', cell(` Pending · ${v.r.pending.length} items the sessions identified in ${v.r.block.name} and nobody has finished`, 0, width, { fg: 'blue', bold: true, bg: 'panel' }));
  add('content', cell('   Follow-ups the agents spawned while working. Nothing here starts by itself; the orchestrator or you pick them up.', 0, width, { fg: 'muted' }));
  for (const t of v.threads) {
    const open = v.r.pending.filter(p => p.thread === t.root.id);
    if (!open.length) continue;
    add('content', cell('', 0, width));
    add('tasks', cell(` ${t.root.id} `, 0, t.root.id.length + 2, { id: `thread:${t.root.id}`, fg: 'goal', bold: true }),
      cell(`${plainTitle(t.root.title)} · ${open.length}`, t.root.id.length + 2, width - t.root.id.length - 2, { id: `thread:${t.root.id}`, fg: 'goal' }));
    for (const x of open) add('tasks', ...itemCells(x, v.r, width, v.r.block.end));
  }
  return rows;
}

// Every point where a session decided, asked or was answered, newest first.
export function steeredRows({ model: m, width }) {
  const v = blockView(m), rows = [], add = (region, ...cells) => rows.push(cells.map(c => ({ region, ...c })));
  if (!v) return rows;
  add('content', cell(` Steered and decided · ${v.r.decisions.length} in ${v.r.block.name}`, 0, width, { fg: 'goal', bold: true, bg: 'panel' }));
  for (const d of v.r.decisions) add('content', ...steerCells(d, v.r, width));
  return rows;
}

// The folded backlog: how much, how stale, under which goal and which item.
export function backlogRows({ model: m, width }) {
  const r = m.recap, rows = [], add = (region, ...cells) => rows.push(cells.map(c => ({ region, ...c })));
  if (!r) { add('content', cell('No organization data.', 0, width, { fg: 'muted' })); return rows; }
  const bl = r.backlog, days = Math.round(r.rules.staleHours / 24);
  add('content', cell(` Backlog · ${bl.open} open items outside this block`, 0, width, { fg: 'blue', bold: true, bg: 'panel' }));
  add('content', cell(`   ${bl.stale} untouched for ${days}d+ · ${bl.from_runs} proposed by runs · ${bl.never_run} never started · ${bl.reported_done_unclosed} more reported done but never closed (not counted)`, 0, width, { fg: 'muted' }));
  add('content', cell('   Folded, not deleted: grooming closes items as dropped with a note, and org reopen brings any back.', 0, width, { fg: 'muted' }));
  for (const g of bl.by_goal) {
    add('content', cell('', 0, width));
    const head = `${g.count} open · ${g.stale} untouched ${days}d+ · newest ${dayHm(g.newest, r.project.as_of)}`;
    add('goals', cell(` ${g.goal?.id ?? 'no goal'} `, 0, (g.goal?.id ?? 'no goal').length + 2, { id: g.goal ? `item:${g.goal.id}` : null, fg: 'goal', bold: true }),
      cell(plainTitle(g.goal?.title ?? ''), (g.goal?.id ?? 'no goal').length + 2, width - head.length - (g.goal?.id ?? '').length - 5, { fg: 'goal' }),
      cell(head, width - head.length - 1, head.length + 1, { fg: 'muted' }));
    for (const p of g.parents.slice(0, 6)) {
      add('tasks', cell(`   ${pad(p.id, 9)}${padStart(p.count, 3)} `, 0, 16, { id: `item:${p.id}`, fg: 'muted' }),
        cell(plainTitle(p.title), 16, width - 16 - 22, { id: `item:${p.id}` }),
        cell(padStart(`${p.stale ? `${p.stale} stale · ` : ''}${dayHm(p.newest, r.project.as_of)}`, 21), width - 21, 21, { fg: 'muted' }));
    }
    const rest = g.parents.length - Math.min(6, g.parents.length);
    if (rest || g.direct) add('tasks', cell(`   ${rest ? `${rest} more parents · ` : ''}${g.direct ? `${g.direct} directly under the goal` : ''}`, 0, width, { fg: 'muted' }));
  }
  return rows;
}
