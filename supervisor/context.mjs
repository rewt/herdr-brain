// Read-only continuity. Work status comes from the existing event fold; module
// receipts describe mechanical progress, never authority or stored work status.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { gitProject } from '../lib/project.mjs';
import { findOrgDir, loadEvents, readConfig, now } from '../lib/store.mjs';
import { fold, itemStatus, openRuns, isResolved, attention } from '../lib/state.mjs';
import { prioritiesJson, itemServes } from '../lib/priorities.mjs';
import { describeEvent, approxTokens } from '../lib/render.mjs';
import { sanitizeTerminal } from '../lib/sanitize.mjs';
import { candidateRows } from '../lib/release-record.mjs';
import { housekeepingSnapshot } from '../housekeeping/command.mjs';
import { releaseSettings } from '../release/config.mjs';

export const receiptDirectory = (org, identity) => path.join(org, 'supervisor', createHash('sha256').update(identity).digest('hex').slice(0, 20));
const read = (file) => fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null;
const line = (value, length = 160) => sanitizeTerminal(String(value ?? '')).replace(/\s+/g, ' ').trim().slice(0, length);

export function coldStart({ cwd = process.cwd(), org, sinceSeq, env = process.env } = {}) {
  const project = gitProject(cwd);
  org = org ? path.resolve(org) : findOrgDir({ cwd, env });
  if (!org) throw new Error('no record discovered; enter through discovery first');
  org = fs.realpathSync(org);
  const { events, tornTail } = loadEvents(org), state = fold(events);
  const through = events.at(-1)?.seq ?? 0;
  const directory = receiptDirectory(org, project.identity);
  const cursor = read(path.join(directory, 'cursor.json'));
  if (cursor && (cursor.identity !== project.identity || cursor.org !== org)) throw new Error('supervisor cursor identity changed');
  const after = sinceSeq ?? cursor?.through ?? 0;
  if (!Number.isInteger(after) || after < 0 || after > through) throw new Error('decision cursor must be an existing event sequence or zero');
  const recovery = [];
  const receipt = (file) => {
    try { return read(file); } catch (e) { recovery.push({ file, reason: e.message }); return null; }
  };
  const queueFile = path.join(project.identity, 'promote/queue.json');
  const queue = receipt(queueFile);
  if (queue && queue.identity !== project.identity) throw new Error('promotion queue identity changed');
  const jobs = queue ? [queue.current, ...queue.pending, ...queue.results].filter(Boolean) : [];
  const missing = new Set(), unknown = new Set();
  const belongs = (run) => {
    if (!run.workspace) return true; // Legacy record-only work has no Git binding.
    try { return gitProject(run.workspace).identity === project.identity; }
    catch {
      missing.add(run.id);
      const saved = receipt(path.join(org, 'settle', `${run.id}.json`));
      if (saved?.common) return saved.common === project.identity;
      const dispatch = run.meta.dispatch_journal ? receipt(run.meta.dispatch_journal) : null;
      if (dispatch?.run === run.id && dispatch.workspace === run.workspace && dispatch.common) return dispatch.common === project.identity;
      // A deleted legacy checkout without an identity receipt is unknown, not
      // proven foreign. Keep it visible for inspection; never use its basename.
      unknown.add(run.id); return true;
    }
  };
  const runs = [...state.runs.values()].filter(belongs);
  const ids = new Set(runs.map((r) => r.item));
  // Undispatched work and its goals belong to this record. Items whose runs are
  // exclusively bound to another repository do not enter this project's brief.
  for (const item of state.items.values()) if (!item.runs.length) ids.add(item.id);
  for (const id of [...ids]) {
    let parent = state.items.get(id)?.parent;
    while (parent) { ids.add(parent); parent = state.items.get(parent)?.parent; }
  }
  const items = [...state.items.values()].filter((i) => ids.has(i.id));
  const facts = (r) => ({ run: r.id, item: r.item, title: state.items.get(r.item)?.title,
    route: r.meta.route ?? null, harness: r.meta.harness ?? null, model: r.meta.model ?? null,
    effort: r.meta.effort ?? null, agent: r.meta.agent ?? null, pane: r.meta.pane ?? null,
    watcher_pid: r.meta.watcher_pid ?? null, watcher_log: r.meta.watcher_log ?? null,
    lane: r.meta.lane ?? null, workspace: r.workspace, report: r.report_path,
    serves: r.meta.serves ?? null, started: r.started.at,
    checkout_missing: missing.has(r.id), repository_binding: unknown.has(r.id) ? 'unknown' : r.workspace ? project.identity : 'record_only' });
  const running = runs.filter((r) => openRuns(state, r.item).includes(r)).map((r) => ({ ...facts(r),
    report_file_present: Boolean(r.report_path && fs.existsSync(r.report_path)) }));
  const reports = [];
  for (const r of runs) {
    const item = state.items.get(r.item);
    if (r.abandoned || item.closed || item.runs.at(-1) !== r.id) continue;
    const saved = receipt(path.join(org, 'settle', `${r.id}.json`));
    const promotion = receipt(path.join(directory, `${r.id}.json`));
    const job = promotion?.queue?.jobs?.[0] ? jobs.find((j) => j.id === promotion.queue.jobs[0].id) : null;
    if (!r.report && !fs.existsSync(r.report_path)) continue;
    reports.push({ ...facts(r), outcome: r.report?.outcome ?? null,
      headline: r.report?.headline ?? null, recorded: Boolean(r.report),
      settlement: saved?.common === project.identity ? saved.result ?? { result: 'incomplete', stage: saved.stage } : null,
      journal: saved ? path.join(org, 'settle', `${r.id}.json`) : null,
      promotion: promotion ? { phase: promotion.phase, queue: job ?? promotion.queue } : null });
  }
  const waiting = items.filter((i) => i.role === 'human' && !i.closed).map((i) => ({
    id: i.id, title: i.title, category: i.meta.category ?? null, recommend: i.meta.recommend ?? null,
    why: i.notes.find((n) => n.kind === 'why')?.text ?? i.created.why, memo: i.meta.memo ?? null }));
  const unsettled = new Set(reports.map((r) => r.item));
  const ready = items.filter((i) => i.kind !== 'goal' && i.role !== 'human' && itemStatus(state, i.id) === 'ready' && !unsettled.has(i.id))
    .map((i) => ({ id: i.id, title: i.title, serves: itemServes(state, i.id), priority: i.priority }));
  const priorities = prioritiesJson(state).priorities.map((p) => ({ id: p.id, rank: p.rank, title: p.title }));
  const rank = (i) => priorities.find((p) => p.id === i.serves)?.rank ?? Infinity;
  ready.sort((a, b) => rank(a) - rank(b) || (b.priority ?? -Infinity) - (a.priority ?? -Infinity));
  const held = items.filter((i) => i.role !== 'human' && ['blocked', 'needs_human'].includes(itemStatus(state, i.id)))
    .map((i) => ({ id: i.id, title: i.title, status: itemStatus(state, i.id), outcome: i.outcome }));
  const scopedRuns = new Map(runs.map((r) => [r.id, r]));
  const decisions = events.filter((e) => e.seq > after).flatMap((e) => {
    if ((e.type === 'note.added' && e.decision && (ids.has(e.id) || scopedRuns.has(e.id)))
      || ['priority.added', 'priorities.ranked'].includes(e.type)) {
      return [{ seq: e.seq, at: e.at, by: e.by, id: e.id ?? null, text: e.text ?? describeEvent(e), summary: e.summary ?? null }];
    }
    const run = e.type === 'report.ingested' ? scopedRuns.get(e.run) : null;
    if (!run) return [];
    // The ingestion event is the checkpoint boundary, even for a closed item
    // or deleted lane. Read only structured fields, never report narrative.
    const fields = e.report.decisions ?? e.report.extra?.decisions;
    const entries = Array.isArray(fields) ? fields : fields == null ? [] : [fields];
    return entries.flatMap((decision, index) => {
      const text = typeof decision === 'string' ? decision : decision?.text ?? decision?.decision;
      if (typeof text !== 'string' || !text.trim()) return [];
      return [{ seq: e.seq, at: e.at, by: run.meta.agent ?? `run:${run.id}`, ingested_by: e.by,
        id: run.id, run: run.id, item: run.item, source: 'report', index, text,
        summary: decision?.summary ?? null, category: decision?.category ?? null, why: decision?.why ?? null }];
    });
  });
  const goals = items.filter((i) => i.kind === 'goal' && !isResolved(itemStatus(state, i.id)))
    .map((i) => ({ id: i.id, title: i.title, decisions: i.notes.filter((n) => n.decision) }));
  const stopped = fs.existsSync(path.join(project.canonical, '.lane/supervisor/STOP'));
  const candidates = candidateRows(state, project.identity);
  const release = releaseSettings(project.canonical);
  const next = [];
  for (const r of running.filter((r) => r.checkout_missing)) next.push({ action: 'inspect_open_run_missing_checkout', run: r.run, evidence: r.workspace });
  for (const r of reports) {
    if (r.promotion) next.push({ action: 'handle_promotion_outcome', run: r.run, evidence: queueFile });
    else if (r.checkout_missing) next.push({ action: 'inspect_legacy_disposition', run: r.run, evidence: r.journal ?? r.report });
    else if (!r.recorded) next.push({ action: 'await_watch_or_inspect', run: r.run, evidence: r.report });
    else if (!r.settlement) next.push({ action: 'settle', run: r.run });
    else if (r.settlement.result === 'promotable') next.push({ action: 'decide_promotion', run: r.run, evidence: r.journal });
    else if (r.settlement.result === 'promotable_with_findings') next.push({ action: 'decide_findings', run: r.run, evidence: r.settlement.handoff ?? r.journal });
    else if (r.settlement.result !== 'fix_round') next.push({ action: 'judge_handoff', run: r.run, evidence: r.settlement.handoff ?? r.journal });
  }
  const pendingCandidates = candidates.filter(c => ['awaiting-operator', 'inspect-interrupted', 'pending-gate'].includes(c.status));
  for (const c of pendingCandidates) next.push({ action: c.status === 'awaiting-operator' ? 'await_release_operator' : 'inspect_release', item: c.question ?? c.id, evidence: c.gate?.log ?? c.snapshot });
  for (const i of ready) next.push({ action: 'consider_dispatch', item: i.id, serves: i.serves });
  if (!next.length) next.push({ action: running.length ? 'leave_in_flight' : waiting.length ? 'await_operator' : 'record_next_work' });
  if (!pendingCandidates.length) next.push({ action: 'consider_release_at_quiet_point' });
  let housekeeping = null;
  try { housekeeping = housekeepingSnapshot({ cwd, org, env }); }
  catch (e) { recovery.push({ file: path.join(project.canonical, '.housekeeping.json'), reason: `Housekeeping: ${e.message}` }); }
  const config = readConfig(org), clock = now(env);
  const advisory = attention(state, config, clock).filter((a) => ids.has(a.id));
  return { project: { ...project, org, as_of: clock.toISOString(), through, after, stopped, torn_tail: tornTail },
    priorities, goals, running, reports, waiting, held, ready, decisions, next, recovery,
    approvals: config.approvals, advisory, promotion_queue: queueFile, candidates, release, housekeeping };
}

export function renderColdStart(doc, { limit = 6 } = {}) {
  const out = [`Supervisor cold start · ${doc.project.canonical}`, `Record ${doc.project.org} · events through ${doc.project.through}; decisions after ${doc.project.after}`];
  if (doc.housekeeping) out.push(`Housekeeping: ${doc.housekeeping.process}${doc.housekeeping.pid ? ` (pid ${doc.housekeeping.pid})` : ''}; enabled=${doc.housekeeping.config?.enabled ?? '?'} resume=${doc.housekeeping.config?.resume ?? '?'}${doc.housekeeping.configError ? `; ${line(doc.housekeeping.configError)}` : ''}${doc.housekeeping.warnings.length ? `; ${line(doc.housekeeping.warnings.join('; '))}` : ''}`);
  if (doc.project.stopped) out.push('STOP exists: inspect only; do not dispatch, settle or promote.');
  if (doc.project.torn_tail) out.push('Record has an incomplete final event; inspect before writes.');
  const section = (name, rows, format) => {
    out.push(`${name} (${rows.length}):`);
    if (!rows.length) out.push('  none');
    else {
      out.push(...rows.slice(0, limit).map((r) => `  ${format(r)}`));
      if (rows.length > limit) out.push(`  +${rows.length - limit} more; use brief --json for the full list.`);
    }
  };
  section('Operator priorities', doc.priorities, (p) => `${p.rank}. ${p.id} ${line(p.title, 80)}`);
  section('Running (record; no live pane inference)', doc.running, (r) => `${r.run} ${r.item} ${line(r.title, 65)} · ${r.route ?? '?'} / ${r.harness ?? '?'} / ${r.model ?? '?'} / ${r.effort ?? '?'} · lane ${r.lane ?? '?'} · ${r.agent ?? '?'}${r.pane ? ` @${r.pane}` : ''}${r.checkout_missing ? ' · checkout missing; inspect record' : r.report_file_present ? ' · file awaits final watch notice' : ''}${r.repository_binding === 'unknown' ? ' · repository binding unknown' : ''}`);
  section('Reports and settlement', doc.reports.slice().reverse(), (r) => `${r.run} ${r.item} · ${r.outcome ?? 'file; stop unconfirmed'} · ${r.promotion ? `promotion ${r.promotion.phase}` : r.settlement?.result ?? (r.recorded ? 'no settle receipt' : 'awaits final watch notice')}${r.checkout_missing ? ' · checkout missing; inspect disposition' : ''} · ${line(r.headline ?? r.settlement?.reason ?? r.title, 100)}${r.settlement?.handoff ? ` · ${r.settlement.handoff}` : ''}`);
  section('Waiting on operator', doc.waiting, (q) => `${q.id} ${line(q.title, 100)} · ${q.category ?? '?'} · recommend ${q.recommend ?? '?'}`);
  section('Release candidates', doc.candidates ?? [], c => `${c.id} ${c.tag} · gate ${c.gate?.result ?? 'pending'} · ${c.status}${c.question ? ` · ${c.question}` : ''}`);
  if (doc.release) out.push(`Release gate (${doc.release.source}): ${JSON.stringify(doc.release.config.gate)}; workers never run it. Ship: ${JSON.stringify(doc.release.config.ship)}; operator reserved.`);
  section('Held work', doc.held, (i) => `${i.id} ${line(i.title, 90)} · ${i.status}`);
  section('Decisions since checkpoint', doc.decisions.slice().reverse(), (d) => `#${d.seq} ${d.id ?? ''}${d.item ? ` ${d.item}` : ''} ${d.by}: ${line(d.summary ?? d.text, 200)}`);
  section('Current goals (retrieve authority with record show)', doc.goals, (g) => `${g.id} ${line(g.title, 100)}`);
  section('Next', doc.next, (n) => `${n.action} ${n.run ?? n.item ?? ''}${n.evidence ? ` · ${n.evidence}` : ''}`);
  section('Recovery evidence', doc.recovery, (r) => `${r.file}: ${line(r.reason)}`);
  section('Advisory signals (never work refusals)', doc.advisory, (a) => `${a.id} ${a.kind}: ${line(a.text)}`);
  out.push('Retrieve depth: record show ID; brief --json. Record plans/authority with record note ID --decision; operator alone ranks priorities.',
    `After reading ALL new decisions (use --json when truncated): checkpoint --through ${doc.project.through}. Reading a brief never advances the checkpoint.`);
  return sanitizeTerminal(out.join('\n') + '\n');
}

export const briefSize = (text) => ({ characters: text.length, approximate_tokens: approxTokens(text) });
