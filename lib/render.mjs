// Views over the durable record. Everything here is deterministic given (state, now).
import fs from 'node:fs';
import path from 'node:path';
import {
  ancestors, attention, blockedBy, blockersOf, children, effectiveBudget, isDeclined, openRuns,
  releases, rollup, runLabel, runUsage, sortItems, statusMap, truthy, usageSummary,
} from './state.mjs';
import { reportTemplate } from './report.mjs';
import { categoryFlagText } from './discernment.mjs';
import { sanitizeTerminal } from './sanitize.mjs';
import { prioritiesJson } from './priorities.mjs';

const terminalView = (lines) => sanitizeTerminal(lines.join('\n') + '\n');

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

export function renderPriorities(doc, { plain = false } = {}) {
  const out = ['Operator priorities'];
  if (!doc.priorities.length) out.push('No priorities yet. Operator: add one with record priorities add "Outcome" --why "Reason".');
  for (const p of doc.priorities) {
    const change = p.history.at(-1);
    out.push(plain ? `${p.rank}. ${p.title} (${p.id})` : `${p.rank}. ${p.id} ${p.title}`, `   by ${change?.by ?? 'unknown'} · ${change?.why ?? ''}`);
    for (const i of p.work) out.push(plain ? `   ${i.status} · ${i.title} (${i.id})` : `   ${i.id} ${i.status} · ${i.title}`);
    if (!p.work.length) out.push('   No open work serving this priority.');
  }
  out.push(`Unaligned · ${doc.unaligned.work.length} open work · advisory`);
  for (const i of doc.unaligned.work) out.push(plain ? `   ${i.status} · ${i.title} (${i.id})` : `   ${i.id} ${i.status} · ${i.title}`);
  return terminalView(out);
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

const ROLLUP_ORDER = ['done', 'active', 'needs_human', 'blocked', 'ready', 'dropped'];

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
  return blockersOf(s, id).filter((b) => !releases(s, b, statuses.get(b))).map((b) =>
    isDeclined(s.items.get(b)) ? `${b} declined: ${s.items.get(b).title}` : `${b} ${statuses.get(b)}`);
}

// A question answered no is closed as done, but it still holds its work back.
function blockerStatus(s, id, statuses) {
  return isDeclined(s.items.get(id)) ? 'declined (answered no)' : statuses.get(id);
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
    case 'priority.added':
      return `added operator priority ${e.id} "${e.title}": ${e.why}`;
    case 'priorities.ranked':
      return `operator priorities: ${e.order.join(' > ')}; ${e.why}`;
    case 'category.flagged':
      return `${e.id} ${categoryFlagText(e)}`;
    case 'item.added':
      return `added ${e.id} "${truncate(e.title, 60)}"${e.parent ? ` under ${e.parent}` : ''}${e.from_run ? ` (proposed by ${e.from_run})` : ''}`;
    case 'item.updated':
      return `updated ${e.id}: ${kv(e.fields)}`;
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
  out.push('', renderPriorities(prioritiesJson(s)).trimEnd());
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
  const statuses = statusMap(s);
  const budget = effectiveBudget(s, item.id, config);
  const chain = ancestors(s, item.id);
  const out = [
    `# Brief: run ${run.id} on ${item.id}`,
    '',
    'You are a fresh session. What earlier sessions established is summarized below and recorded in the record; you do not need any earlier conversation. Do the work, then write one report when you stop.',
    '',
    '## Work item',
    `- **${item.id}** ${item.title}`,
  ];
  const facts = [
    item.role && `role: ${item.role}`,
    item.capability && `capability: ${item.capability}`,
    item.priority != null && `priority: ${item.priority}`,
  ].filter(Boolean);
  if (facts.length) out.push(`- ${facts.join(' · ')}`);
  const priority = s.priorities.get(run.meta.serves);
  out.push(priority ? `- serves operator priority ${s.priorityOrder.indexOf(priority.id) + 1}: **${priority.id}** ${priority.title}` : '- alignment: **Unaligned** · no operator priority named; advisory, work may proceed');
  out.push('- The operator owns priority ranks. Agents propose additions or re-ranks with `record priorities propose "Question" --parent ID --recommend yes --why "Reason"`; the question waits for the operator.');
  if (chain.length) out.push(`- part of: ${[...chain].reverse().map((a) => `${a.id} ${a.title}`).join(' → ')}`);
  if (item.created.why) out.push(`- why it exists${item.created.run ? ` (proposed in ${item.created.run})` : ''}: ${item.created.why}`);
  if (item.accept.length) out.push('- acceptance:', ...item.accept.map((a) => `  - ${a}`));
  out.push(`- this is run ${item.runs.indexOf(runId) + 1} on this item (expected ≤ ${budget.max_runs}; limits are advisory)`);

  const context = [];
  const prior = item.runs.filter((r) => r !== runId).map((r) => s.runs.get(r)).filter((r) => r?.report).slice(-5);
  if (prior.length) context.push('', '### Earlier runs on this item', ...prior.flatMap(reportDigest));
  const blockers = blockersOf(s, item.id).map((id) => s.items.get(id)).filter(Boolean);
  if (blockers.length) {
    context.push('', '### Blockers');
    for (const blocker of blockers) {
      const r = latestReport(s, blocker);
      context.push(`- **${blocker.id}** ${blocker.title} — ${blockerStatus(s, blocker.id, statuses)}${r ? `: ${truncate(r.summary, 400)}` : ''}`);
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
    '- `record snapshot`: the current state of the whole record',
    '',
    '## When you stop: write one report',
    `Write your report to \`${run.report_path}\` when you finish, get blocked, need a human decision, or give up. No progress updates are needed.`,
    'Fill in `headline:` with one plain sentence the operator will read (no item codes or hashes).',
    `Check it with \`record check ${run.report_path}\`, fix anything it reports, then stop.`,
    'If you discover follow-on or unblocking work, list it under proposals: each becomes a new item without anyone triaging it. If something important needs more work than the limits above suggest, propose it anyway and say why.',
    '',
    '```markdown',
    reportTemplate(run.id).trimEnd(),
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
  const escalations = item.runs.filter((r) => truthy(s.runs.get(r)?.meta.escalation)).length;
  out.push(`budget (advisory): runs ${item.runs.length}/${budget.max_runs} · children ${kids.length}/${budget.max_children} · depth ${chain.length}/${budget.max_depth} · escalations ${escalations}/${budget.escalation_budget}`);
  const blockers = blockersOf(s, id);
  if (blockers.length) out.push(`blocked by: ${blockers.map((b) => `${b} (${blockerStatus(s, b, statuses)})`).join(', ')}`);
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
    priorities: prioritiesJson(s),
    attention: attention(s, ctx.config, ctx.now, statuses),
  };
}
