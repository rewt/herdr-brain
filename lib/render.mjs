// Views over the durable record. Everything here is deterministic given (state, now).
import fs from 'node:fs';
import { candidateRows, renderCandidates } from './release-record.mjs';
import path from 'node:path';
import {
  ancestors, attention, blockedBy, blockersOf, children, effectiveBudget, failedVerdict, isDeclined, itemStatus, openRuns,
  releases, dependencyReleases, itemConditions, rollup, runLabel, runUsage, sortItems, statusMap, truthy, usageSummary,
} from './state.mjs';
import { reportTemplate } from './report.mjs';
import { categoryFlagText } from './discernment.mjs';
import { sanitizeTerminal } from './sanitize.mjs';
import { LESSON_TEXT_LIMIT, lessonsForItem } from './lessons.mjs';
import { HANDOFF_SECTIONS } from './handoffs.mjs';
import { runWorkerBrief, renderWorkerBrief } from './worker-brief.mjs';
import { briefContext, contextDecision } from './brief-context.mjs';
import { dispatchPrompt } from './dispatch-template.mjs';

const terminalView = (lines) => sanitizeTerminal(lines.join('\n') + '\n');

export function renderHandoff(entry) {
  return sanitizeTerminal(`Handoff (${entry.workspace}/${entry.slot}): ${entry.path} sha256=${entry.sha256} author=${entry.author}`);
}

export function renderHandoffTemplate() {
  const prompts = [
    'List runs, lanes, heads, owners and next boundaries; or say none.',
    'For each job list its address/PID, evidence, stop condition and exact re-arm command; or say none.',
    'Record pending decisions and the authority/evidence needed to resolve them; or say none.',
    'List peer agent names, pane/workspace addresses and what each is handling; or say none.',
    'Name the archive directories and durable results saved there; durable results go to the archive before the lane closes. If no archive resolves, say so.',
    'List the first concrete actions for the successor, in order.',
  ];
  return '# Slot handoff\n\n' + HANDOFF_SECTIONS.map((title, index) => `## ${title}\n\n${prompts[index]}\n`).join('\n');
}

export function renderHandoffCheck({ missing_sections }) {
  return terminalView([missing_sections.length ? `Missing handoff sections (advisory): ${missing_sections.join('; ')}` : 'All standard handoff sections present.']);
}

export function renderSafePoint(doc) {
  return terminalView([`Safe point ${doc.pane} (${doc.agent ?? 'agent unknown'}): ${doc.safe ? 'SAFE' : 'HOLD'}`,
    ...doc.reasons.map(r => `  ${r.kind}: ${r.message}`),
    'Read-only observation; no pane input or lifecycle action.']);
}

export const LESSON_VIEW_LIMIT = 5;

export function renderLessonClaim(text) {
  const points = [...sanitizeTerminal(text).replace(/\s+/g, ' ').trim()];
  return points.length > LESSON_TEXT_LIMIT ? points.slice(0, LESSON_TEXT_LIMIT - 1).join('') + '…' : points.join('');
}

export function renderLessons(lessons, { more = 'record lessons --json with the same filters' } = {}) {
  if (!lessons.length) return terminalView(['No matching lessons.']);
  const out = ['Lessons'];
  for (const lesson of lessons.slice(0, LESSON_VIEW_LIMIT)) {
    const targets = [...lesson.paths.map(p => `path:${p}`), ...lesson.modules.map(m => `module:${m}`)];
    const evidence = lesson.evidence.map(ref => ref.kind === 'event' ? `event:${ref.seq}` : ref.id);
    const claim = renderLessonClaim(lesson.text);
    out.push(`${lesson.id} [${lesson.scope} · ${lesson.state}] ${claim}`,
      `  Applies: ${targets.length ? truncate(targets.join(', '), 100) : 'whole scope'} · proposed by ${truncate(lesson.proposed.by, 60)}`,
      `  Evidence: ${truncate(evidence.join(', '), 100)}`);
    if (lesson.supersession) out.push(`  Superseded by ${lesson.supersession.by_lesson}: ${truncate(lesson.supersession.reason, 160)}`);
    else if (lesson.retirement) out.push(`  Retired: ${truncate(lesson.retirement.reason, 160)}`);
  }
  if (lessons.length > LESSON_VIEW_LIMIT) out.push(`… ${lessons.length - LESSON_VIEW_LIMIT} more (${more})`);
  return terminalView(out);
}

export function renderHousekeeping(doc) {
  return terminalView([
    `Housekeeping · ${doc.process}${doc.pid ? ` · pid ${doc.pid}` : ''}`,
    doc.configError ? `Invalid config: ${doc.configError}` : `Enabled: ${doc.config.enabled} · resume: ${doc.config.resume} · tick: ${doc.config.tick_seconds}s · cleanup: ${doc.config.cleanup_seconds}s`,
    `Last live scan: ${doc.lastScan?.at ?? 'not recorded'}`,
    `Config: ${doc.target}`, `State: ${doc.stateDir ?? 'no record'}`,
    ...doc.warnings,
    ...doc.actions.flatMap(a => [
      `${a.at} · ${a.action}${a.dryRun ? ' (preview)' : ''} · ${a.label ?? a.run ?? a.tab_id ?? a.pane ?? ''}`,
      ...(a.error ? [`  Error: ${a.error}`] : []),
      ...(a.why ? [`  ${a.error ? 'Reason: ' : ''}${a.why}`] : []),
      ...(a.action === 'scan' ? [`  ${a.close} close candidates, ${a.keep} kept`] : []),
    ]),
  ]);
}

export function renderRoutes({ config, files, suggested }) {
  const defaults = config.dispatch ?? {};
  return terminalView([
    suggested ? 'Suggested routes (confirmation pending)' : 'Project routes',
    ...files,
    ...Object.keys(config.routes ?? {}).sort().map(name => {
      const route = config.routes[name];
      return [name, route.kind ?? defaults.kind ?? 'claude', route.model ?? defaults.model ?? '(default)', route.effort ?? defaults.effort ?? '(default)'].join('\t');
    }),
  ]);
}

export function renderDesks({ settings, defaults, source, target, config, validation }) {
  return terminalView(['Settle and review desks', `Source: ${source}`, `Save: ${target}`,
    `Review: ${settings.review_route ?? (config.selection_policy ? JSON.stringify(config.selection_policy.by_task_class.review ?? '(missing review selection)') : 'review (default)')}`,
    `Fix: ${settings.fix_route ?? 'worker route, otherwise engineer'}`,
    ...['review_round_cap', 'timeout', 'reuse', 'to'].map(key => `${key}: ${settings[key] ?? defaults[key]}`),
    ...Object.entries(validation?.tiers ?? {}).map(([tier, value]) => `validation.${tier}: ${value.command} (${value.source})`),
    'Item round-cap overrides win; saved receipts retain intake settings.']);
}

export function truncate(text, max) {
  // Sanitize before cutting: truncation must not remove the terminator from a
  // control string and turn it into a sequence that hides the following view.
  const t = sanitizeTerminal(text).replace(/\s+/g, ' ').trim();
  return t.length > max ? t.slice(0, max - 1).trimEnd() + '…' : t;
}

const two = (n) => String(n).padStart(2, '0');

export function fmtStamp(iso) {
  const d = new Date(iso);
  return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())} ${two(d.getHours())}:${two(d.getMinutes())}`;
}

export function fmtWhen(iso, now) {
  const d = new Date(iso);
  const sameDay = d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate();
  return sameDay ? `${two(d.getHours())}:${two(d.getMinutes())}` : fmtStamp(iso);
}

export function fmtAgo(iso, now) {
  const minutes = Math.floor((now - new Date(iso)) / 60000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  return hours < 48 ? `${hours}h ago` : `${Math.floor(hours / 24)}d ago`;
}

export function fmtTokens(n) {
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${Math.round(n / 1e3)}k`;
  return String(n);
}

export function approxTokens(text) {
  return Math.ceil(text.length / 4);
}

const ROLLUP_ORDER = ['done', 'active', 'needs_human', 'blocked', 'ready', 'proposed', 'lapsed', 'dropped'];

function rollupText(counts) {
  const parts = ROLLUP_ORDER.filter((k) => counts[k]).map((k) => `${counts[k]} ${k.replace('_', ' ')}`);
  return parts.length ? parts.join(' · ') : 'no items yet';
}

function roleCap(item) {
  return [item.role, item.capability].filter(Boolean).join('/');
}

function latestReport(s, item) {
  return item.outcome ? s.runs.get(item.outcome.run)?.report ?? null : null;
}

function describeRun(run) {
  const label = runLabel(run);
  return label ? `${run.id} (${label})` : run.id;
}

export function blockReason(s, id, statuses = statusMap(s)) {
  return blockersOf(s, id).filter((b) => !dependencyReleases(s, b, id, itemStatus(s, b, new Set(), id))).map((b) =>
    isDeclined(s.items.get(b)) ? `${b} declined: ${s.items.get(b).title}` : s.links.some(l => l.blocker === b && l.blocked === id && l.requires === 'accepted')
      ? `${b} acceptance ${itemConditions(s, b).Accepted.status}: ${itemConditions(s, b).Accepted.reason}` : `${b} ${blockerStatus(s, b, statuses, id)}`);
}

// A question answered no is closed as done, but it still holds its work back; so does a review
// that finished without a PASS verdict.
function blockerStatus(s, id, statuses, blocked) {
  if (isDeclined(s.items.get(id))) return 'declined (answered no)';
  const status = blocked ? itemStatus(s, id, new Set(), blocked) : statuses.get(id);
  if (status === 'done' && failedVerdict(s, id))
    return `done, verdict ${String(latestReport(s, s.items.get(id)).extra.verdict).trim()}`;
  return status;
}

function blockerText(s, item, statuses) {
  const unresolved = blockReason(s, item.id, statuses);
  if (unresolved.length) return '← ' + unresolved.join(', ');
  const report = latestReport(s, item);
  return `waiting: ${truncate(report?.blockers[0] ?? report?.summary ?? 'no detail recorded', 70)}`;
}

function doneSeq(item) {
  return item.closed?.seq ?? item.outcome?.seq ?? 0;
}

function usageLine(runs) {
  const u = usageSummary(runs);
  if (!u.recorded) return null;
  return `${u.recorded}/${u.runs} runs recorded · in ${fmtTokens(u.tokens_in)} · out ${fmtTokens(u.tokens_out)}${u.cost ? ` · $${u.cost.toFixed(2)}` : ''}`;
}

export function describeEvent(e) {
  const kv = (obj) => Object.entries(obj ?? {}).map(([k, v]) => `${k}=${typeof v === 'object' && v !== null ? JSON.stringify(v) : v}`).join(', ');
  switch (e.type) {
    case 'lesson.proposed':
      return `proposed lesson ${e.id} [${e.scope}]: ${truncate(e.text, 90)}`;
    case 'lesson.activated':
      return `activated lesson ${e.id}`;
    case 'lesson.retired':
      return `retired lesson ${e.id}: ${truncate(e.reason, 90)}`;
    case 'lesson.superseded':
      return `lesson ${e.id} superseded by ${e.by_lesson}: ${truncate(e.reason, 90)}`;
    case 'category.flagged':
      return `${e.id} ${categoryFlagText(e)}`;
    case 'item.added':
      return `added ${e.id} "${truncate(e.title, 60)}"${e.parent ? ` under ${e.parent}` : ''}${e.from_run ? ` (proposed by ${e.from_run})` : ''}`;
    case 'item.updated':
      return `updated ${e.id}: ${kv(e.fields)}`;
    case 'item.acceptance-amended':
      return `amended acceptance on ${e.id}: ${truncate(e.why, 90)}`;
    case 'item.closed':
      return `closed ${e.id} as ${e.as}${e.note ? `: ${truncate(e.note, 80)}` : ''}`;
    case 'item.reopened':
      return `reopened ${e.id}${e.note ? `: ${truncate(e.note, 80)}` : ''}`;
    case 'link.added':
      return `${e.blocker} blocks ${e.blocked}`;
    case 'link.removed':
      return `${e.blocker} no longer blocks ${e.blocked}`;
    case 'note.added':
      return `${e.decision ? 'decision' : 'note'} on ${e.id}: ${truncate(e.text, 90)}`;
    case 'run.started': {
      const label = [e.meta?.harness, e.meta?.model].filter(Boolean).join(' · ');
      return `started ${e.id} on ${e.item}${label ? ` (${label})` : ''}`;
    }
    case 'run.updated':
      return `updated ${e.id}: ${kv(e.meta)}`;
    case 'run.abandoned':
      return `abandoned ${e.id}${e.note ? `: ${truncate(e.note, 80)}` : ''}`;
    case 'report.ingested':
      return `${e.run} reported ${e.report?.outcome} on ${e.item}${e.late ? ' (late)' : ''}: ${truncate(e.report?.summary, 90)}`;
    case 'handoff.recorded': return `handoff ${e.workspace}/${e.slot}: ${e.path} sha256=${e.sha256} author=${e.author}`;
    case 'promotion.reconciled': return `reconciled batch ${e.batch}: ${e.items.join(', ')}; superseded ${e.superseded.length}; excluded ${e.excluded.length}`;
    case 'promotion.delta-accepted':
      return `${e.by} accepted plain-note delta ${e.delta_digest} for batch ${e.batch}: ${e.items.map(i =>
        `${i.item} (seq ${i.events.map(change => change.seq).join(', ')})`).join('; ')}; ${e.why}`;
    case 'release.cut': return `release candidate ${e.id} ${e.tag} at ${e.commit}`;
    case 'release.gate.started': return `release gate started for ${e.id}`;
    case 'release.gate.finished': return `release gate ${e.gate.result} for ${e.id}${e.question ? `; operator decision ${e.question}` : ''}`;
    default:
      return e.type;
  }
}

export function renderStatus(s, ctx) {
  const { now, config, events } = ctx;
  const statuses = statusMap(s);
  const all = sortItems(s.items.values());
  const goals = all.filter((i) => i.kind === 'goal');
  const work = all.filter((i) => i.kind !== 'goal');
  const width = Math.max(4, ...all.map((i) => i.id.length));
  const row = (id, title, detail) => `  ${id.padEnd(width)}  ${truncate(title, 44).padEnd(44)}  ${detail ?? ''}`.trimEnd();
  const byStatus = (st) => work.filter((i) => statuses.get(i.id) === st);
  const out = [`${ctx.orgDir} · ${s.eventCount} events · ${fmtStamp(now.toISOString())}`];
  if (s.candidates.size) out.push('', 'RELEASE CANDIDATES', renderCandidates(candidateRows(s)).trimEnd());
  if (ctx.tornTail) out.push('warning: ignoring an incomplete last line in events.jsonl (an interrupted write); the next change repairs it');
  if (!all.length) {
    out.push('', 'No items yet. Start with: record add --goal "What we are trying to achieve"');
    return terminalView(out);
  }
  const section = (title, rows) => {
    if (rows.length) out.push('', title, ...rows);
  };

  section('GOALS', goals.map((g) => row(g.id, g.title, g.closed ? g.closed.as : rollupText(rollup(s, g.id, statuses)))));
  section('NEEDS YOU', byStatus('needs_human').map((i) => {
    const r = latestReport(s, i);
    return row(i.id, i.title, r ? `${i.outcome.run}: ${truncate(r.blockers[0] ?? r.summary, 70)}` : '');
  }));
  section('ACTIVE', byStatus('active').flatMap((i) =>
    openRuns(s, i.id).map((r) => row(i.id, i.title, `${describeRun(r)} · ${fmtAgo(r.started.at, now)}`))));
  section('BLOCKED', byStatus('blocked').map((i) => row(i.id, i.title, blockerText(s, i, statuses))));
  section('PROPOSAL NOTES', byStatus('proposed').map(i => row(i.id, i.title, 'awaiting explicit selection')));
  section('LAPSED NOTES', byStatus('lapsed').map(i => row(i.id, i.title, 'retained; separately select to revive')));
  section('READY', byStatus('ready').map((i) => row(i.id, i.title, [
    roleCap(i),
    i.outcome?.value === 'failed' ? `last run failed (${i.outcome.run})` : '',
    i.outcome?.value === 'blocked' ? 'blockers resolved' : '',
  ].filter(Boolean).join(' · '))));
  const done = byStatus('done').sort((a, b) => doneSeq(b) - doneSeq(a));
  section('RECENTLY DONE', done.slice(0, 5).map((i) =>
    row(i.id, i.title, i.closed ? `closed ${fmtAgo(i.closed.at, now)}` : `${i.outcome.run} · ${fmtAgo(i.outcome.at, now)}`)));
  if (done.length > 5) out.push(`  … ${done.length - 5} more (record log)`);
  section('ATTENTION', attention(s, config, now, statuses).map((a) => `  ${a.id.padEnd(width)}  ${a.text}`));
  const usage = usageLine(s.runs.values());
  if (usage) out.push('', `USAGE  ${usage}`);
  section('RECENT', events.slice(-5).reverse().map((e) => `  ${fmtWhen(e.at, now).padEnd(5)}  ${describeEvent(e)}`));
  return terminalView(out);
}

function collectNotes(s) {
  const notes = [];
  for (const target of [...s.items.values(), ...s.runs.values()]) {
    for (const note of target.notes) notes.push({ ...note, target: target.id });
  }
  return notes.sort((a, b) => a.seq - b.seq);
}

export function renderSnapshot(s, ctx) {
  const { now, config, events, cli } = ctx;
  const statuses = statusMap(s);
  const all = sortItems(s.items.values());
  const work = all.filter((i) => i.kind !== 'goal');
  const byStatus = (st) => work.filter((i) => statuses.get(i.id) === st);
  const summaryOf = (i) => {
    const r = latestReport(s, i);
    return r ? ` — ${i.outcome.run}: ${truncate(r.summary, 240)}` : '';
  };
  const out = [
    '# Organization snapshot',
    '',
    `Generated deterministically from the durable record (${s.eventCount} events, as of ${fmtStamp(now.toISOString())}). It stands in for any earlier supervisor conversation; you do not need one.`,
    '',
    `Record CLI: \`${cli}\` (called \`record\` below). Read-only lookups are always safe: \`record show <ID>\` for full history and reports, \`record log --since <time>\`, \`record status\`.`,
  ];
  const section = (title, rows, cap, more) => {
    if (!rows.length) return;
    out.push('', `## ${title}`, ...rows.slice(0, cap));
    if (rows.length > cap) out.push(`- …and ${rows.length - cap} more (${more})`);
  };

  if (!all.length) out.push('', 'No work has been recorded yet.');
  section('Goals', all.filter((i) => i.kind === 'goal').map((g) =>
    `- **${g.id}** ${g.title} — ${g.closed ? g.closed.as : rollupText(rollup(s, g.id, statuses))}`), 10, '`record status`');
  section('Needs a human', byStatus('needs_human').map((i) => {
    const r = latestReport(s, i);
    return `- **${i.id}** ${i.title}${summaryOf(i)}${r?.blockers.length ? ` Needs: ${truncate(r.blockers.join('; '), 200)}` : ''}`;
  }), 10, '`record status`');
  section('Active runs', byStatus('active').flatMap((i) => openRuns(s, i.id).map((r) =>
    `- **${r.id}** on ${i.id} ${i.title}${runLabel(r) ? ` (${runLabel(r)})` : ''}, started ${fmtAgo(r.started.at, now)}`)), 10, '`record status`');
  section('Blocked', byStatus('blocked').map((i) => `- **${i.id}** ${i.title} — ${blockerText(s, i, statuses)}`), 15, '`record status`');
  section('Proposal notes (unselected)', byStatus('proposed').map(i => `- **${i.id}** ${i.title}`), 15, '`record status`');
  section('Lapsed notes (retained)', byStatus('lapsed').map(i => `- **${i.id}** ${i.title}`), 15, '`record status`');
  section('Ready', byStatus('ready').map((i) => [
    `- **${i.id}** ${i.title}`,
    roleCap(i) ? ` [${roleCap(i)}]` : '',
    i.created.why ? ` — why: ${truncate(i.created.why, 160)}` : '',
    i.outcome?.value === 'failed' ? ` — last run failed${summaryOf(i)}` : '',
  ].join('')), 15, '`record status`');
  const done = byStatus('done').sort((a, b) => doneSeq(b) - doneSeq(a));
  section('Recently done', done.map((i) => `- **${i.id}** ${i.title}${summaryOf(i)}`), 8, '`record log`');
  const decisions = collectNotes(s).filter((n) => n.decision).reverse();
  section('Decisions', decisions.map((n) => `- ${n.target} (${fmtStamp(n.at)}): ${truncate(n.text, 300)}`), 10, '`record show <ID>`');
  const learnings = [...s.runs.values()]
    .filter((r) => r.report?.learnings.length)
    .sort((a, b) => b.report.seq - a.report.seq)
    .flatMap((r) => r.report.learnings.map((l) => `- ${truncate(l, 240)} (${r.id} on ${r.item})`));
  section('Recent learnings', learnings, 12, '`record show <ID>`');
  section('Attention (advisory)', attention(s, config, now, statuses).map((a) => `- ${a.id}: ${a.text}`), 10, '`record status`');
  // Links a report proposed and usage bookkeeping repeat what other lines already say.
  const notable = events.filter((e) => e.type !== 'run.updated' && !(e.type === 'link.added' && e.from_run));
  section('Recent activity', notable.slice(-12).reverse().map((e) => `- ${fmtStamp(e.at)} ${describeEvent(e)}`), 12, '`record log`');
  return terminalView(out);
}

function reportDigest(run) {
  const r = run.report;
  const lines = [`- **${run.id}**${runLabel(run) ? ` (${runLabel(run)})` : ''} ${r.outcome}: ${truncate(r.summary, 400)}`];
  if (r.blockers.length) lines.push(`  - blockers: ${truncate(r.blockers.join('; '), 300)}`);
  for (const l of r.learnings.slice(0, 5)) lines.push(`  - learned: ${truncate(l, 240)}`);
  if (r.artifacts.length) lines.push(`  - artifacts: ${truncate(r.artifacts.join('; '), 240)}`);
  return lines;
}

export function renderBrief(s, runId, ctx) {
  const { config, cli } = ctx;
  const run = s.runs.get(runId);
  const item = s.items.get(run.item);
  const workerBrief = runWorkerBrief(run);
  const statuses = statusMap(s);
  const budget = effectiveBudget(s, item.id, config);
  const chain = ancestors(s, item.id);
  const out = [
    `# Brief: run ${run.id} on ${item.id}`,
    '',
    'You are a fresh session. What earlier sessions established is summarized below and recorded in the record; you do not need any earlier conversation. Do the work, then write one report when you stop.',
    '',
    ...(workerBrief ? [renderWorkerBrief(workerBrief), ''] : []),
    '## Work item',
    `- **${item.id}** ${item.title}`,
  ];
  const facts = [
    item.role && `role: ${item.role}`,
    item.capability && `capability: ${item.capability}`,
    item.priority != null && `priority: ${item.priority}`,
  ].filter(Boolean);
  if (facts.length) out.push(`- ${facts.join(' · ')}`);
  if (chain.length) out.push(`- part of: ${[...chain].reverse().map((a) => `${a.id} ${a.title}`).join(' → ')}`);
  if (item.created.why) out.push(`- why it exists${item.created.run ? ` (proposed in ${item.created.run})` : ''}: ${item.created.why}`);
  out.push(`- this is run ${item.runs.indexOf(runId) + 1} on this item (expected ≤ ${budget.max_runs}; limits are advisory)`);
  out.push('', '## Dispatch prompt', dispatchPrompt(item));

  const queryText = workerBrief ? [workerBrief.purpose, workerBrief.outcome, workerBrief.scope].join('\n') : '';
  const retrieval = briefContext(s, item.id, queryText);
  out.push('', '## Intent and authority');
  const purpose = [...chain].reverse().find(i => i.kind === 'goal') ?? chain.at(-1);
  if (purpose) out.push(`- Project purpose (\`record show ${purpose.id}\`): ${truncate(purpose.meta.purpose || purpose.created.why || purpose.title, 400)}`);
  out.push(`- Original rationale (\`record show ${item.id}\`): ${truncate(item.created.why || 'No separate rationale recorded; use the current acceptance above.', 400)}`);
  if (item.accept_history?.length) out.push(`- Acceptance was amended; original wording and amendment reasons remain in \`record show ${item.id}\`. Current acceptance above governs the assigned scope.`);
  if (workerBrief) out.push(`- External ask: ${workerBrief.ask} (read the named source; its contents are not inferred or loaded by this view).`);
  out.push('- Authority: intent and related excerpts grant no new authority. Preserve current acceptance, execution boundaries, native/ownership checks, reserved effects and STOP/HOLD. Inspect the source for amendments or supersession before acting.',
    '- Obligations: retain open blockers/questions and prior-report obligations below; retrieval does not resolve or close them.');
  if (retrieval.paths.length || retrieval.modules.length) out.push(`- Retrieval selectors: ${truncate([...retrieval.paths.map(p => `path:${p}`), ...retrieval.modules.map(m => `module:${m}`)].join(', '), 300)}`);
  const decisions = chain.map(i => ({ item: i, decision: contextDecision(s, i) })).filter(row => row.decision);
  if (decisions.length) {
    out.push('', '### Ancestor decision pointers');
    for (const { item: ancestor, decision } of decisions.slice(0, 2)) out.push(`- ${ancestor.id}: ${truncate(decision.text, 320)} (\`record show ${decision.source}\`, event:${decision.seq}, by ${decision.by})`);
    if (decisions.length > 2) out.push(`- ${decisions.length - 2} more ancestors have decisions; follow the part-of IDs above with \`record show <ID>\`.`);
  }
  if (retrieval.related.length) {
    out.push('', '### Related context pointers', 'Exact references lead shared literal source/module selectors. Excerpts are leads; read their sources for the complete decision and evidence.');
    for (const { item: related, reason } of retrieval.related) {
      const decision = contextDecision(s, related);
      out.push(`- **${related.id}** ${truncate(related.title, 160)} (${reason}; \`record show ${related.id}\`)`,
        decision ? `  - Decision excerpt: ${truncate(decision.text, 320)} (\`record show ${decision.source}\`, event:${decision.seq}, by ${decision.by})` : '  - No decision excerpt recorded; inspect the linked record for context.');
    }
    if (retrieval.omitted) out.push(`- ${retrieval.omitted} more matching records omitted; follow exact IDs in the owning item with \`record show <ID>\`.`);
  }
  if (retrieval.missing.length) out.push(`- Unresolved references: ${retrieval.missing.slice(0, 4).join(', ')}${retrieval.missing.length > 4 ? `; ${retrieval.missing.length - 4} more` : ''} are absent from this record. No other record was searched; inspect the owning source for the intended link.`);
  const lessons = lessonsForItem(s, item.id, { related: retrieval.related.map(row => row.item.id), text: queryText });
  if (lessons.length) out.push('', '## Lessons',
    'Active lessons only: literal path/module mentions, evidence tied to this item, ancestors or selected related records, then lessons without selectors; scope and numeric ID break ties. Retired/superseded claims are excluded.',
    renderLessons(lessons, { more: 'record lessons --json lists all active lessons' }).split('\n').slice(1).join('\n').trimEnd());

  const context = [];
  const prior = item.runs.filter((r) => r !== runId).map((r) => s.runs.get(r)).filter((r) => r?.report).slice(-5);
  if (prior.length) context.push('', '### Earlier runs on this item', ...prior.flatMap(reportDigest));
  const blockers = blockersOf(s, item.id).map((id) => s.items.get(id)).filter(Boolean);
  if (blockers.length) {
    context.push('', '### Blockers');
    for (const blocker of blockers) {
      const r = latestReport(s, blocker);
      context.push(`- **${blocker.id}** ${blocker.title} — ${blockerStatus(s, blocker.id, statuses, item.id)}${r ? `: ${truncate(r.summary, 400)}` : ''}`);
      for (const l of r?.learnings.slice(0, 5) ?? []) context.push(`  - learned: ${truncate(l, 240)}`);
      if (r?.artifacts.length) context.push(`  - artifacts: ${truncate(r.artifacts.join('; '), 240)}`);
      if (r) context.push(`  - full report: \`record show ${blocker.outcome.run}\``);
    }
  }
  const parent = item.parent ? s.items.get(item.parent) : null;
  if (parent && parent.kind !== 'goal') {
    const r = latestReport(s, parent);
    context.push('', '### Parent item', `- **${parent.id}** ${parent.title} — ${statuses.get(parent.id)}${r ? `: ${truncate(r.summary, 400)}` : ''}`);
    for (const l of r?.learnings.slice(0, 5) ?? []) context.push(`  - learned: ${truncate(l, 240)}`);
    if (r) context.push(`  - full report: \`record show ${parent.outcome.run}\``);
  }
  const siblings = parent ? children(s, parent.id).filter((i) => i.id !== item.id && i.kind !== 'goal') : [];
  if (siblings.length) {
    context.push('', '### Related items (same parent)', ...siblings.slice(0, 8).map((i) => `- **${i.id}** ${i.title} — ${statuses.get(i.id)}`));
  }
  const kids = children(s, item.id);
  if (kids.length) context.push('', '### Child items', ...kids.map((k) => `- **${k.id}** ${k.title} — ${statuses.get(k.id)}`));
  const questions = prior.flatMap(r => (r.report.extra?.questions ?? r.report.questions ?? []).filter(q => !q.id || !s.items.get(q.id)?.closed)
    .map(q => `- ${truncate(q.question, 320)} (${q.id ? `\`record show ${q.id}\`; ` : ''}source \`record show ${r.id}\`; unresolved here, inspect the original authority/answer)`));
  if (questions.length) context.push('', '### Prior question obligations', ...questions);
  const notes = [
    ...[item, ...chain].flatMap((i) => i.notes.map((n) => ({ ...n, target: i.id }))),
    ...[...blockers, ...kids].flatMap((i) => i.notes.filter((n) => n.decision).map((n) => ({ ...n, target: i.id }))),
  ].sort((a, b) => a.seq - b.seq).slice(-8);
  if (notes.length) {
    context.push('', '### Notes and decisions',
      ...notes.map((n) => `- ${n.target}${n.decision ? ' decision' : ''} (${fmtStamp(n.at)}): ${truncate(n.text, 400)}`));
  }
  out.push('', '## What earlier work established');
  if (context.length) out.push(...context.slice(1));
  else out.push('Nothing recorded yet for this item.');

  out.push(
    '',
    '## Looking things up (optional)',
    `Record CLI: \`${cli}\` (called \`record\` below). Use it only if you need more than this brief.`,
    '- `record show <ID>`: full history of an item or run, including complete reports',
    '- `record lessons --path <project-relative-path> --json` or `record lessons --module <name> --json`: active lessons and original evidence; `--state all` exposes retirement/supersession',
    '- Choose deeper reads when these pointers are insufficient. If code conflicts with the intended outcome, record the changed premise, current source, evidence and proposed method; interpretation does not authorize a reserved effect.',
    '- `record snapshot`: the current state of the whole record',
    '',
    '## Durable locations',
    ...(ctx.archiveError ? [`Archive unavailable: ${sanitizeTerminal(ctx.archiveError).replace(/\s+/g, ' ').trim()}`] : ctx.archive?.length ? [
      'Archive directories:', ...ctx.archive.map(dir => `- ${dir}`),
      'Durable results go to the archive before the lane closes.',
    ] : ['No archive directories resolved.']),
    '',
    '## When you stop: write one report',
    `Write your report to \`${run.report_path}\` when you finish, get blocked, need a human decision, or give up. No progress updates are needed.`,
    'Fill in `headline:` with one plain sentence the operator will read (no item codes or hashes).',
    `Check it with \`record check ${run.report_path}\`, fix anything it reports, then stop.`,
    'Report ingestion carries your closeout signal; optionally run `lane ready <topic>` as your last step (the same signal, deduplicated).',
    'List follow-on work under proposals: ordinary proposals become durable notes awaiting separate selection. More than three ordinary follow-ups share one reshape note retaining every source. Formal findings retain their correction obligations. Say why important work is needed.',
    '',
    '```markdown',
    reportTemplate(run.id, { includeWorkflow: !workerBrief }).trimEnd(),
    '```',
  );
  return terminalView(out);
}

function runState(run, now) {
  if (run.report) return `reported ${run.report.outcome} ${fmtStamp(run.report.at)}${run.report.late ? ' (late)' : ''}`;
  if (run.abandoned) return `abandoned ${fmtStamp(run.abandoned.at)}${run.abandoned.note ? ` (${run.abandoned.note})` : ''}`;
  return `open, started ${fmtAgo(run.started.at, now)}`;
}

function indentBlock(text, spaces) {
  return String(text).split('\n').map((line) => ' '.repeat(spaces) + line);
}

function touches(s, e, id) {
  if (e.id === id || e.item === id || e.blocker === id || e.blocked === id || e.parent === id) return true;
  if (e.type === 'promotion.delta-accepted' && e.items.some(i => i.item === id)) return true;
  const runId = e.run ?? e.id;
  return Boolean(runId && s.runs.get(runId)?.item === id);
}

export function renderShowItem(s, id, ctx) {
  const { now, config, events, orgDir } = ctx;
  const item = s.items.get(id);
  const statuses = statusMap(s);
  const budget = effectiveBudget(s, id, config);
  const kids = children(s, id);
  const chain = ancestors(s, id);
  const out = [`${item.id}  ${item.title}`];
  out.push([
    `status: ${statuses.get(id)}${item.kind === 'goal' ? ' (goal)' : ''}`,
    item.role && `role: ${item.role}`,
    item.capability && `capability: ${item.capability}`,
    item.priority != null && `priority: ${item.priority}`,
  ].filter(Boolean).join(' · '));
  if (chain.length) out.push(`within: ${[...chain].reverse().map((a) => `${a.id} ${truncate(a.title, 40)}`).join(' → ')}`);
  out.push(`created: ${fmtStamp(item.created.at)} by ${item.created.by}${item.created.run ? ` (proposed in ${item.created.run})` : ''}`);
  if (item.created.why) out.push(`why: ${item.created.why}`);
  if (item.closed) out.push(`closed: ${item.closed.as} ${fmtStamp(item.closed.at)} by ${item.closed.by}${item.closed.note ? ` — ${item.closed.note}` : ''}`);
  if (item.accept.length) out.push('acceptance:', ...item.accept.map((a) => `  - ${a}`));
  if (item.accept_history) {
    out.push('', 'acceptance history (all revisions, verbatim text):');
    for (const [index, revision] of item.accept_history.entries()) {
      out.push(`  ${index === 0 ? 'original' : `amendment ${index}`}${index === item.accept_history.length - 1 ? ' (current)' : ''}: ${revision.at} by ${revision.by} (event ${revision.seq})`);
      if (revision.why != null) out.push('    reason:', ...indentBlock(revision.why, 6));
      if (revision.accept.length) for (const text of revision.accept) out.push('    text:', ...indentBlock(text, 6));
      else out.push('    (no acceptance text)');
    }
  }
  const escalations = item.runs.filter((r) => truthy(s.runs.get(r)?.meta.escalation)).length;
  out.push(`budget (advisory): runs ${item.runs.length}/${budget.max_runs} · children ${kids.length}/${budget.max_children} · depth ${chain.length}/${budget.max_depth} · escalations ${escalations}/${budget.escalation_budget}`);
  const blockers = blockersOf(s, id);
  if (blockers.length) out.push(`blocked by: ${blockers.map((b) => `${b} (${blockerStatus(s, b, statuses, id)})`).join(', ')}`);
  const blocks = blockedBy(s, id);
  if (blocks.length) out.push(`blocks: ${blocks.map((b) => `${b} (${statuses.get(b)})`).join(', ')}`);
  if (kids.length) out.push('children:', ...kids.map((k) => `  ${k.id.padEnd(8)} ${statuses.get(k.id).padEnd(11)} ${truncate(k.title, 60)}`));
  const flagged = attention(s, config, now, statuses).filter((a) => a.id === id);
  if (flagged.length) out.push('attention:', ...flagged.map((a) => `  - ${a.text}`));
  const usage = usageLine(item.runs.map((r) => s.runs.get(r)));
  if (usage) out.push(`usage: ${usage}`);

  if (item.runs.length) {
    out.push('', 'runs:');
    for (const runId of item.runs) {
      const run = s.runs.get(runId);
      out.push(`  ${run.id}  ${runLabel(run) || 'harness not recorded'}  started ${fmtStamp(run.started.at)} · ${runState(run, now)}`);
      const r = run.report;
      if (!r) continue;
      out.push('    summary:', ...indentBlock(r.summary, 6));
      for (const [label, list] of [['blockers', r.blockers], ['learnings', r.learnings], ['artifacts', r.artifacts]]) {
        if (list.length) out.push(`    ${label}:`, ...list.map((x) => `      - ${x}`));
      }
      const created = [...s.items.values()].filter((i) => i.created.run === run.id).map((i) => i.id);
      if (created.length) out.push(`    proposed: ${created.join(', ')}`);
      out.push(`    report: ${path.join(orgDir, r.file)}`);
    }
  }
  if (item.notes.length) {
    out.push('', 'notes:', ...item.notes.map((n) => `  ${fmtStamp(n.at)} ${n.by}${n.decision ? ' [decision]' : ''}: ${n.text}`));
  }
  const history = events.filter((e) => touches(s, e, id));
  if (history.length) out.push('', 'history:', ...history.map((e) => `  ${fmtStamp(e.at)}  ${describeEvent(e)}`));
  return terminalView(out);
}

export function renderShowRun(s, id, ctx) {
  const { now, orgDir } = ctx;
  const run = s.runs.get(id);
  const item = s.items.get(run.item);
  const out = [`${run.id}  on ${item.id} ${item.title}`, `state: ${runState(run, now)}`, `started: ${fmtStamp(run.started.at)} by ${run.started.by}`];
  const meta = Object.entries(run.meta).map(([k, v]) => `${k}: ${v}`);
  if (meta.length) out.push(meta.join(' · '));
  if (run.workspace) out.push(`workspace: ${run.workspace}`);
  const briefSize = fs.existsSync(run.brief_path) ? ` (${fs.statSync(run.brief_path).size} bytes)` : ' (missing: record brief regenerates it)';
  out.push(`brief: ${run.brief_path}${briefSize}`, `report path: ${run.report_path}`);
  const usage = runUsage(run);
  if (usage) out.push(`usage: ${Object.entries(usage).filter(([, v]) => v !== undefined).map(([k, v]) => `${k} ${v}`).join(' · ')}`);
  if (run.notes.length) out.push('notes:', ...run.notes.map((n) => `  ${fmtStamp(n.at)} ${n.by}: ${n.text}`));
  if (run.report) {
    const stored = path.join(orgDir, run.report.file);
    out.push('', `recorded report (${stored}):`, '');
    out.push(fs.existsSync(stored) ? fs.readFileSync(stored, 'utf8').trimEnd() : `(file missing) ${run.report.outcome}: ${run.report.summary}`);
  }
  return terminalView(out);
}

export function renderLog(events) {
  if (!events.length) return 'no events\n';
  return sanitizeTerminal(events.map((e) => `${fmtStamp(e.at)}  ${String(e.by).padEnd(8)}  ${describeEvent(e)}`).join('\n') + '\n');
}

export function itemJson(s, id, statuses = statusMap(s)) {
  return {
    ...s.items.get(id),
    status: statuses.get(id),
    conditions: itemConditions(s, id),
    ...(statuses.get(id) === 'blocked' ? { blocked_reason: blockReason(s, id, statuses) } : {}),
    blocked_by: blockersOf(s, id),
    blocks: blockedBy(s, id),
    children: children(s, id).map((c) => c.id),
  };
}

export function statusJson(s, ctx) {
  const statuses = statusMap(s);
  return {
    org: ctx.orgDir,
    events: s.eventCount,
    as_of: ctx.now.toISOString(),
    items: sortItems(s.items.values()).map((i) => itemJson(s, i.id, statuses)),
    runs: [...s.runs.values()],
    candidates: candidateRows(s),
    attention: attention(s, ctx.config, ctx.now, statuses),
  };
}

export function renderPublishedSummaryStatus(status) {
  return `Published summary: ${status.status}; age ${status.age_seconds === null ? 'unknown' : `${status.age_seconds}s`}${status.stale_after_seconds === null ? '' : `; stale after ${status.stale_after_seconds}s`}.\n`;
}

export function renderProjectSummary(doc) {
  const md = value => String(value ?? 'unknown').replace(/[\\`*_{}\[\]<>#|]/g, '\\$&');
  const rows = [`# ${md(doc.project.name)}`, '', `As of ${doc.generated_at}; stale after ${doc.stale_after_seconds}s.`, '',
    `Status: ${Object.entries(doc.status.counts).map(([k, v]) => `${k}=${v}`).join(', ')}`, '',
    `Today (${doc.today.date}): ${doc.today.landings.length} landings, ${doc.today.decisions.length} decisions.`,
    ...doc.today.landings.slice(0, 10).map(r => `- Landed ${r.item ?? '?'} (${r.run ?? '?'}): ${md(r.summary)}`),
    ...doc.today.decisions.slice(0, 10).map(r => `- Decided ${r.id ?? '?'}: ${md(r.summary)}`), '',
    `Lanes view: ${Object.entries(doc.lanes.counts).map(([k, v]) => `${k}=${v}`).join(', ')}`,
    ...doc.lanes.oldest_unresolved.map(r => `- ${r.type} ${r.runs.join(', ') || r.items.join(', ') || '?'}: ${r.class}; owner ${md(r.owner)}; age ${r.age_seconds === null ? 'unknown' : `${r.age_seconds}s`}`), '',
    ...(doc.archive?.dirs?.length ? ['Archive directories:', ...doc.archive.dirs.map(dir => `- ${md(dir)}`)] : ['Archive directories: none resolved.']), '',
    `Release: current ${doc.releases.current ?? 'unknown'}; pinned ${doc.releases.pinned ?? 'unavailable'}.`,
    `Exceptions: ${doc.exceptions.map(e => e.name).join(', ') || 'none'}.`];
  return rows.join('\n') + '\n';
}
export function renderOperatorDigest(doc) {
  if (!doc.messages.length) return 'No updates in this view.\n';
  return doc.messages.map((e, index) => {
    const text = e.operator_text ?? { headline: 'An update is available.', happened: 'The original summary is included in the details.',
      action: 'Check the details to see whether you need to act.', details: `Original message: ${e.summary}; message=${e.id}` };
    const detail = `${text.details}; sequence=${e.seq}; kind=${e.kind}; delivery=${e.push}` +
      (index === doc.messages.length - 1 ? `; remaining=${doc.remaining}; next=${doc.next}` : '');
    const oneLine = value => sanitizeTerminal(value).replace(/\s+/gu, ' ').trim();
    return [text.headline, text.happened, text.action, `Details: ${detail}`].map(oneLine).join('\n') + '\n';
  }).join('\n');
}
