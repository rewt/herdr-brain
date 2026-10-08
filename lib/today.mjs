// The operator's read model: what waits on them, what was decided, what runs and
// what finished today. Deterministic given (state, config, now, TZ); the console and
// any other front end read only this document (org today --json).
import path from 'node:path';
import { attention, blockedBy, isResolved, openRuns, statusMap, waitingImpact, waitingImpactIndex } from './state.mjs';
import { truncate, renderPriorities } from './render.mjs';
import { sanitizeTerminal } from './sanitize.mjs';
import { prioritiesJson } from './priorities.mjs';

const two = (n) => String(n).padStart(2, '0');

export function dayBounds(now) {
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  const end = new Date(start);
  end.setDate(end.getDate() + 1);
  const date = `${start.getFullYear()}-${two(start.getMonth() + 1)}-${two(start.getDate())}`;
  return { start, end, date };
}

export function isQuestion(item) {
  return item.role === 'human' && item.kind !== 'goal';
}

function isAnswered(item) {
  return Boolean(item.closed) && item.meta.answer != null;
}

function sameAnswer(a, b) {
  return String(a ?? '').trim().toLowerCase() === String(b ?? '').trim().toLowerCase();
}

// Unresolved items with a priority that wait, directly or transitively, on id.
export function unblocksPrioritized(s, id, statuses) {
  const seen = new Set([id]);
  const stack = [id];
  let count = 0;
  while (stack.length) {
    for (const next of blockedBy(s, stack.pop())) {
      if (seen.has(next)) continue;
      seen.add(next);
      const item = s.items.get(next);
      if (!item || isResolved(statuses.get(next))) continue;
      if (typeof item.priority === 'number') count++;
      stack.push(next);
    }
  }
  return count;
}

const AGENT_RUNS_MAX = 50;
const PARK_AFTER_MS = 7 * 24 * 60 * 60 * 1000;

const newestFirst = (a, b) => (a.at === b.at ? b.seq - a.seq : a.at < b.at ? 1 : -1);

export function todayJson(s, ctx) {
  const { now, config, orgDir } = ctx;
  const statuses = statusMap(s);
  const { start, end, date } = dayBounds(now);
  const isToday = (iso) => {
    const t = new Date(iso);
    return t >= start && t < end;
  };
  const items = [...s.items.values()];
  const title = (id) => s.items.get(id)?.title ?? null;
  const whyOf = (item) => item.notes.find((n) => n.kind === 'why')?.text ?? item.created.why ?? null;
  const answerNote = (item) => [...item.notes].reverse().find((n) => n.kind === 'answer') ?? null;

  const questions = items.filter((i) => isQuestion(i) && !i.closed);
  const impactIndex = questions.length ? waitingImpactIndex(s, statuses) : null;
  const waiting = questions
    .map((i) => {
      const impact = waitingImpact(s, i.id, statuses, impactIndex);
      return {
        id: i.id,
        title: i.title,
        status: statuses.get(i.id),
        category: i.meta.category ?? null,
        recommend: i.meta.recommend ?? null,
        why: whyOf(i),
        on_yes: i.meta.on_yes ?? null,
        on_no: i.meta.on_no ?? null,
        memo: i.meta.memo ?? null,
        priority: i.priority,
        stage: i.meta.stage ?? null,
        created: { at: i.created.at, by: i.created.by },
        blocks: blockedBy(s, i.id).map((id) => ({ id, title: title(id) })),
        unblocks_prioritized: unblocksPrioritized(s, i.id, statuses),
        blocked_work: impact,
        blocked_count: impact.items + impact.runs + impact.plan_steps,
        parked: now - new Date(i.created.at) > PARK_AFTER_MS,
        seq: i.created.seq,
      };
    })
    .sort((a, b) => b.blocked_count - a.blocked_count
      || new Date(a.created.at) - new Date(b.created.at)
      || a.seq - b.seq)
    .map(({ seq, ...rest }) => rest);

  const decided = [];
  for (const i of items) {
    if (isQuestion(i) && isAnswered(i) && isToday(i.closed.at)) {
      const note = answerNote(i);
      decided.push({
        kind: 'question',
        id: i.id,
        seq: i.closed.seq,
        title: i.title,
        category: i.meta.category ?? null,
        recommend: i.meta.recommend ?? null,
        answer: i.meta.answer,
        answered_by: i.meta.answered_by ?? null,
        overruled: i.meta.overruled === true,
        note: i.closed.note ?? null,
        why: whyOf(i),
        memo: i.meta.memo ?? null,
        // After a no, only dependents that are neither running nor closed stay held.
        blocks: blockedBy(s, i.id).map((id) => ({
          id, title: title(id), status: statuses.get(id) ?? null, open_runs: openRuns(s, id).map((r) => r.id),
        })),
        at: i.closed.at,
        by: note?.by ?? i.closed.by,
      });
    }
  }
  for (const target of [...s.items.values(), ...s.runs.values()]) {
    for (const n of target.notes) {
      if (!n.decision || n.kind === 'answer' || !isToday(n.at)) continue;
      decided.push({
        kind: 'note',
        id: target.id,
        seq: n.seq,
        title: s.items.get(target.id)?.title ?? title(target.item),
        summary: n.summary ?? null,
        text: n.text,
        at: n.at,
        by: n.by,
      });
    }
  }
  decided.sort(newestFirst);

  const runFacts = (r) => ({
    run: r.id,
    item: r.item,
    title: title(r.item),
    role: s.items.get(r.item)?.role ?? null,
    started: r.started.at,
    agent: r.meta.agent ?? null,
    lane: r.meta.lane ?? null,
    harness: r.meta.harness ?? null,
    model: r.meta.model ?? null,
    effort: r.meta.effort ?? null,
    workspace: r.workspace ?? null,
    // Which run on its item this is: 1 for the first.
    round: (s.items.get(r.item)?.runs ?? []).indexOf(r.id) + 1 || null,
    brief_path: r.brief_path,
    report_path: r.report_path,
  });
  const isOpen = (r) => openRuns(s, r.item).includes(r);
  const running = [...s.runs.values()]
    .filter(isOpen)
    .sort((a, b) => a.started.seq - b.started.seq)
    .map(runFacts);
  // The latest finished run of each agent name, newest first, so a front end can name an
  // agent that outlived its run. At most AGENT_RUNS_MAX of them.
  const byAgent = new Map();
  for (const r of [...s.runs.values()].sort((a, b) => b.started.seq - a.started.seq)) {
    if (!r.meta.agent || byAgent.has(r.meta.agent)) continue;
    byAgent.set(r.meta.agent, r);
  }
  const agentRuns = [...byAgent.values()].filter((r) => !isOpen(r)).slice(0, AGENT_RUNS_MAX).map(runFacts);

  const finished = [];
  for (const r of s.runs.values()) {
    if (!r.report || !isToday(r.report.at)) continue;
    finished.push({
      kind: 'report',
      run: r.id,
      item: r.item,
      seq: r.report.seq,
      title: title(r.item),
      role: s.items.get(r.item)?.role ?? null,
      outcome: r.report.outcome,
      headline: r.report.headline ?? null,
      summary: r.report.summary,
      report_file: path.join(orgDir, r.report.file),
      late: r.report.late,
      abandoned: Boolean(r.abandoned),
      at: r.report.at,
    });
  }
  for (const i of items) {
    if (!i.closed || !isToday(i.closed.at) || (isQuestion(i) && isAnswered(i))) continue;
    finished.push({
      kind: 'closed', item: i.id, seq: i.closed.seq, title: i.title, role: i.role, as: i.closed.as,
      note: i.closed.note, at: i.closed.at, by: i.closed.by,
    });
  }
  finished.sort(newestFirst);

  // The stage the project is working now: the goal that carries meta.stage_now.
  // Questions for a later stage, or parked, are not the operator's problem yet.
  const stageGoal = items.find((i) => !i.closed && i.meta.stage_now != null);
  // Where an instruction to the whole project is recorded: the goal every
  // session reads first. The stage goal when there is one, else the first open
  // top-level goal.
  const topGoal = stageGoal ?? items.find((i) => i.kind === 'goal' && !i.parent && !i.closed) ?? null;

  const counts = {};
  for (const i of items) {
    if (!isQuestion(i) || !isAnswered(i)) continue;
    const c = (counts[i.meta.category ?? 'uncategorized'] ??= { answered: 0, answered_as_recommended: 0, overruled: 0, auto: 0 });
    c.answered++;
    if (sameAnswer(i.meta.answer, i.meta.recommend)) c.answered_as_recommended++;
    if (i.meta.overruled === true) c.overruled++;
    if (i.meta.answered_by === 'auto') c.auto++;
  }

  return {
    project: {
      org: orgDir,
      as_of: now.toISOString(),
      events: s.eventCount,
      // The item-id prefixes in use, so front ends strip only codes this organization issues.
      item_prefixes: [...new Set(items.map((i) => /^(.+)-\d+$/.exec(i.id)?.[1]).filter(Boolean))].sort(),
      day: { date, start: start.toISOString(), end: end.toISOString(), tz: Intl.DateTimeFormat().resolvedOptions().timeZone },
      open_stage: stageGoal ? stageGoal.meta.stage_now : null,
      top_goal: topGoal ? { id: topGoal.id, title: topGoal.title } : null,
    },
    waiting,
    priorities: prioritiesJson(s),
    decided,
    running,
    agent_runs: agentRuns,
    finished,
    approvals: { policy: config.approvals, counts },
    attention: attention(s, config, now, statuses),
  };
}

const OUTCOME_WORDS = { done: 'finished', blocked: 'blocked', needs_human: 'needs a decision', failed: 'failed' };

export function outcomeWords(outcome) {
  return OUTCOME_WORDS[outcome] ?? outcome ?? 'outcome not recorded';
}

function hhmm(iso) {
  const d = new Date(iso);
  return `${two(d.getHours())}:${two(d.getMinutes())}`;
}

export function renderToday(doc, { parked = false } = {}) {
  const out = [`${doc.project.org} · ${doc.project.day.date} · as of ${hhmm(doc.project.as_of)}`];
  if (doc.priorities) out.push('', renderPriorities(doc.priorities, { plain: true }).trimEnd());
  const section = (heading, rows) => {
    out.push('', `${heading} (${rows.length})`, ...(rows.length ? rows : ['  nothing']));
  };
  const questions = doc.waiting.filter(w => parked ? w.parked : !w.parked);
  section(parked ? 'PARKED QUESTIONS' : 'WAITING ON YOU', questions.map((w) => `  ${[
    truncate(w.title, 100),
    w.category ?? 'no category',
    `recommend: ${w.recommend ?? 'not recorded'}`,
    w.blocked_count ? `unblocks ${w.blocked_count}` : null,
    w.status === 'blocked' ? 'blocked' : null,
  ].filter(Boolean).join(' · ')} (${w.id})`));
  const parkedCount = doc.waiting.filter(w => w.parked).length;
  if (!parked && parkedCount) out.push(`  ${parkedCount} question${parkedCount === 1 ? '' : 's'} older than 7 days parked · record today --parked`);
  section('DECIDED TODAY', doc.decided.map((d) => (d.kind === 'question'
    ? `  ${hhmm(d.at)}  ${truncate(d.title, 80)} → ${truncate(d.answer, 40)} · by ${d.answered_by ?? 'unknown'}${d.overruled ? ' (overruled)' : ''} (${d.id})`
    : `  ${hhmm(d.at)}  ${truncate(d.summary ?? d.text, 100)}${d.summary ? '' : ' · no plain summary'} · by ${d.by} (${d.id})`)));
  section('RUNNING', doc.running.map((r) =>
    `  ${truncate(r.title ?? 'untitled', 80)} · ${r.role ?? 'no role'} · since ${hhmm(r.started)}${r.agent ? ` · ${r.agent}` : ''} (${r.run})`));
  section('FINISHED TODAY', doc.finished.map((f) => (f.kind === 'report'
    ? `  ${hhmm(f.at)}  ${truncate(f.headline ?? `${f.title}: ${outcomeWords(f.outcome)}`, 100)} (${f.run})`
    : `  ${hhmm(f.at)}  ${truncate(f.title, 80)} · ${f.as} (${f.item})`)));
  if (doc.attention.length) section('ATTENTION', doc.attention.map((a) => `  ${a.text} (${a.id})`));
  return sanitizeTerminal(out.join('\n') + '\n');
}
