#!/usr/bin/env node
// Foreground, read-only join of record clocks and the existing train metrics.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { isMain } from '../lib/cli-help.mjs';
import { findOrgDir, loadEvents } from '../lib/store.mjs';
import { writeFileAtomic } from '../lib/files.mjs';
import { gitProject } from '../lib/project.mjs';
import { fold } from '../lib/state.mjs';
import { runMetrics } from '../dispatch/metrics.mjs';
import { collectMetrics, stats } from '../promote/metrics.mjs';

const clock = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null;
const elapsed = (a, b) => a && b && Date.parse(b) >= Date.parse(a) ? (Date.parse(b) - Date.parse(a)) / 1000 : null;
const earliest = values => values.map(clock).filter(Boolean).sort()[0] ?? null;
const latest = values => values.map(clock).filter(Boolean).sort().at(-1) ?? null;
const executed = g => !g.reused && !g.duplicate && (g.executed || ['green', 'red', 'interrupted'].includes(g.status));
const stages = {
  dispatch_to_report_s: ['dispatch', 'report'], report_to_review_s: ['report', 'review_start'],
  review_s: ['review_start', 'review_end'], review_to_queue_s: ['review_end', 'queue'],
  queue_to_gate_s: ['queue', 'gate_start'], gate_to_main_s: ['gate_start', 'main'],
  main_to_usable_s: ['main', 'usable'], dispatch_to_main_s: ['dispatch', 'main'],
  dispatch_to_usable_s: ['dispatch', 'usable'],
};
const held = /(?:\bgates?\b.{0,100}\b(?:paused?|held|hold|stopped)\b|\b(?:paused?|held|hold)\b.{0,100}\b(?:gates?|promotion|tests)\b|HOLD tests|AUTOPILOT_PAUSED|PROMOTE_LOCK_HELD)/i;
const moved = /(?:base branch|main) moved/i;
function readJSON(file, warnings) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (e) { if (e.code !== 'ENOENT') warnings.push(`${file}: ${e.message}`); return null; }
}
function summary(rows) {
  const measures = Object.keys(stages);
  const summarize = values => {
    const measured = stats(values), sorted = values.filter(v => typeof v === 'number' && Number.isFinite(v) && v >= 0).sort((a, b) => a - b);
    return { ...measured, total: measured.samples ? measured.total : null,
      p90: sorted[Math.ceil(sorted.length * 0.9) - 1] ?? null, missing: values.length - measured.samples };
  };
  return { items: rows.length,
    clocks_missing: Object.fromEntries(['dispatch', 'report', 'ingest', 'review_start', 'review_end', 'queue', 'gate_start', 'gate_end', 'main', 'reconcile', 'usable']
      .map(k => [k, rows.filter(r => r.clocks[k] === null).length])),
    stages_s: Object.fromEntries(measures.map(k => [k, summarize(rows.map(r => r.stages_s[k]))])) };
}
function windowBounds({ since, until, now }) {
  const parse = value => {
    if (!/^\d{4}-\d{2}-\d{2}(?:$|T.*(?:Z|[+-]\d{2}:\d{2})$)/.test(value ?? '') || !clock(value)) throw Error('window requires an ISO date or timestamp with timezone');
    return clock(value);
  };
  const end = parse(until ?? now), start = since === undefined ? new Date(Date.parse(end) - 7 * 86400000).toISOString() : parse(since);
  if (Date.parse(start) >= Date.parse(end)) throw Error('--since must precede --until');
  return { since: start, until: end, basis: 'main clock; reconciliation only for selection when main is missing; lower inclusive, upper exclusive' };
}

// usable is an adapter seam for explicit, run/item/identity-bound observations.
// The Brain record currently has no installed/usable clock; reconciliation and
// release cut/gate are deliberately not treated as one.
export function collectCycleTime({ project = process.cwd(), org, since, until, now = new Date().toISOString(), usable = [] } = {}) {
  const git = gitProject(project);
  org ??= findOrgDir({ cwd: project });
  if (!org) throw Error('a record is required: --org DIR or ORG_DIR');
  org = fs.realpathSync(org);
  const window = windowBounds({ since, until, now });
  const { events, tornTail } = loadEvents(org);
  if (tornTail) throw Error('incomplete record tail; no cycle-time report produced');
  const state = fold(events), train = collectMetrics({ project }), warnings = [...train.warnings];
  const lanes = train.lanes.filter(l => l.org === org && state.runs.has(l.run));
  const directory = path.join(org, 'supervisor', createHash('sha256').update(git.identity).digest('hex').slice(0, 20), 'autopilot');
  const actions = [];
  for (const name of fs.existsSync(directory) ? fs.readdirSync(directory).filter(n => n.endsWith('.json')).sort() : []) {
    const file = path.join(directory, name), action = readJSON(file, warnings);
    if (!action) continue;
    if (action.policy !== 'notice-autopilot/v1' || action.project?.identity !== git.identity || action.project?.org !== org) {
      warnings.push(`${file}: unsupported or foreign autopilot receipt`); continue;
    }
    const run = /^report:(R-\d+)$/.exec(action.key)?.[1] ??
      lanes.find(l => l.id === /^\[promote-queue\] id=(\S+)/.exec(action.notice)?.[1])?.run;
    if (run) actions.push({ ...action, file, run });
  }
  const reconciled = events.filter(e => e.type === 'promotion.reconciled' && e.identity === git.identity);
  const landings = new Map();
  for (const e of reconciled) for (const head of e.heads ?? []) {
    if (!state.runs.has(head.run) || state.runs.get(head.run).item !== head.item) { warnings.push(`event:${e.seq}: unknown or mismatched landing`); continue; }
    // Replay receipts cannot add another observation of the same landed run.
    if (!landings.has(head.run)) landings.set(head.run, { ...head, batch: e.batch, reconcile: e });
  }
  for (const lane of lanes.filter(l => l.outcome === 'promoted')) {
    const prior = landings.get(lane.run), run = state.runs.get(lane.run);
    if (!prior) landings.set(lane.run, { run: run.id, item: run.item, batch: lane.batch, head: lane.tip });
  }
  const settlements = new Map();
  const settle = run => {
    if (!settlements.has(run)) {
      const file = path.join(org, 'settle', `${run}.json`), receipt = readJSON(file, warnings);
      if (receipt && (receipt.run !== run || receipt.org !== org || receipt.common !== git.identity)) warnings.push(`${file}: foreign settlement`);
      settlements.set(run, receipt?.run === run && receipt.org === org && receipt.common === git.identity ? { ...receipt, file } : null);
    }
    return settlements.get(run);
  };
  const rows = []; let missingWindowClock = 0;
  for (const landing of landings.values()) {
    const run = state.runs.get(landing.run), item = state.items.get(landing.item);
    const memberLanes = lanes.filter(l => l.run === run.id);
    const promoted = memberLanes.find(l => l.outcome === 'promoted' && l.batch === landing.batch);
    const runActions = actions.filter(a => a.run === run.id);
    const snapshots = [...runActions.filter(a => a.measurement).map(a => ({ clocks: a.measurement.clocks, source: a.file }))];
    for (const note of run.notes) if (note.text.startsWith('Fast path timing: ')) {
      try { snapshots.push({ clocks: JSON.parse(note.text.slice('Fast path timing: '.length)).clocks, source: `event:${note.seq}` }); }
      catch { warnings.push(`event:${note.seq}: invalid fast path timing`); }
    }
    const snapshot = key => snapshots.find(s => clock(s.clocks?.[key]));
    const main = clock(promoted?.integrated_at) ?? clock(snapshot('main')?.clocks.main);
    const selection = main ?? clock(landing.reconcile?.at);
    if (!selection) { missingWindowClock++; continue; }
    if (selection < window.since || selection >= window.until) continue;
    // Count the whole item cycle, including correction runs, not just the final
    // short fix run. A previous recorded landing starts a new cycle boundary.
    const preceding = reconciled.filter(e => e.seq < run.started.seq && e.heads?.some(h => h.item === item.id)).at(-1)?.seq ?? 0;
    const cycleRuns = item.runs.map(id => state.runs.get(id)).filter(r => r.started.seq > preceding && r.started.seq <= run.started.seq);
    const runIds = new Set(cycleRuns.map(r => r.id));
    const cycleLanes = lanes.filter(l => runIds.has(l.run));
    const cycleActions = actions.filter(a => runIds.has(a.run));
    const reviews = cycleRuns.flatMap(r => {
      const s = settle(r.id); return s ? [{ run: r.id, start: clock(s.review_started_at), end: clock(s.review_finished_at),
        round: s.reviewPolicy?.round ?? null, attempts: s.round ?? null, verdict: s.review?.verdict ?? null, evidence: s.file,
        recaptures: [...(s.recaptures ?? []), ...(s.recapture ? [s.recapture] : [])] }] : [];
    });
    const finalReview = reviews.find(r => r.run === run.id);
    const gates = train.gates.filter(g => cycleLanes.some(l => l.batch === g.batch && g.jobs.includes(l.id)));
    const finalGates = gates.filter(g => memberLanes.some(l => l.batch === g.batch && g.jobs.includes(l.id)) && executed(g));
    const sources = { dispatch: `event:${cycleRuns[0]?.started.seq}`, report: snapshot('report')?.source ?? null,
      ingest: run.report ? `event:${run.report.seq}` : null, review: finalReview?.evidence ?? null,
      trains: [...new Set(cycleLanes.map(l => train.batches.find(b => b.id === l.batch)?.receipt).filter(Boolean))],
      reconcile: landing.reconcile ? `event:${landing.reconcile.seq}` : null, usable: null };
    let report = clock(snapshot('report')?.clocks.report);
    if (!report) {
      try { report = fs.statSync(run.report_path).mtime.toISOString(); sources.report = `mtime:${run.report_path}`; } catch { /* missing */ }
    }
    if (report && main && report > main) { warnings.push(`${run.id}: report mtime/snapshot follows main; unavailable`); report = null; }
    const usableObservation = usable.find(u => u.identity === git.identity && u.run === run.id && u.item === item.id && clock(u.at) && typeof u.evidence === 'string' && u.evidence);
    const clocks = { dispatch: clock(cycleRuns[0]?.started.at), report, ingest: clock(run.report?.at),
      review_start: finalReview?.start ?? clock(snapshot('review_start')?.clocks.review_start),
      review_end: finalReview?.end ?? clock(snapshot('review_end')?.clocks.review_end),
      queue: earliest(memberLanes.map(l => l.queued_at)) ?? clock(snapshot('queue_admission')?.clocks.queue_admission),
      gate_start: earliest(finalGates.map(g => g.command_started_at ?? g.started_at)) ?? clock(snapshot('gate_start')?.clocks.gate_start),
      gate_end: latest(finalGates.map(g => g.command_finished_at ?? g.finished_at)) ?? clock(snapshot('gate_end')?.clocks.gate_end),
      main, reconcile: clock(landing.reconcile?.at), usable: clock(usableObservation?.at) };
    if (clocks.usable && (elapsed(main, clocks.usable) === null)) { warnings.push(`${run.id}: usable precedes main or main is missing`); clocks.usable = null; }
    if (clocks.usable) sources.usable = usableObservation.evidence;
    const scope = runActions.filter(a => typeof a.scope?.eligible === 'boolean').sort((a, b) => (a.finished ?? '').localeCompare(b.finished ?? '')).at(-1);
    const disabled = runActions.find(a => /autopilot disabled|AUTOPILOT_COHORT_UNKNOWN/i.test(a.reason ?? ''));
    const cohort = scope ? scope.scope.eligible ? 'in' : 'out' : disabled ? 'out' : 'unknown';
    const notes = events.filter(e => e.type === 'note.added' && e.seq > preceding && e.at >= clocks.dispatch && e.at <= selection &&
      (e.id === item.id || runIds.has(e.id)));
    const holds = [
      ...notes.filter(n => held.test(n.text)).map(n => ({ at: clock(n.at), reason: n.text, seconds: null, evidence: `event:${n.seq}` })),
      ...cycleActions.filter(a => held.test(a.reason ?? '')).map(a => ({ at: clock(a.finished), reason: a.reason, seconds: null, evidence: a.file })),
      ...cycleLanes.filter(l => held.test(l.reason ?? '')).map(l => ({ at: null, reason: l.reason, seconds: null, evidence: l.batch })),
    ];
    const dispatch = runMetrics(cycleRuns);
    rows.push({ item: item.id, title: item.title, run: run.id, runs: cycleRuns.map(r => r.id), batch: landing.batch, head: landing.head,
      cohort, cohort_evidence: scope?.file ?? disabled?.file ?? null, selected_at: selection, clocks,
      stages_s: Object.fromEntries(Object.entries(stages).map(([k, [a, b]]) => [k, elapsed(clocks[a], clocks[b])])),
      waits: { dispatch: dispatch.runs, promotion: cycleLanes.map(l => ({ run: l.run, batch: l.batch, job: l.id, ...l.timing })),
        gate_observations: gates.length, gate_executions: gates.filter(executed).length,
        gate_retries: Math.max(0, gates.filter(executed).length - 1),
        gates: gates.map(g => ({ batch: g.batch, attempt: g.attempt, execution: g.execution, status: g.status,
          reused: g.reused, duplicate: g.duplicate, seconds: g.command_time_s, reason: g.reason,
          failing_steps: train.red_attribution.find(r => r.batch === g.batch && r.attempt === g.attempt && r.execution === g.execution)?.failing_steps ?? [],
          attribution: train.red_attribution.find(r => r.batch === g.batch && r.attempt === g.attempt && r.execution === g.execution)?.attribution ?? [] })),
        holds, reviews, review_rounds: reviews.filter(r => r.verdict).length,
        review_receipts_missing: cycleRuns.length - reviews.length,
        review_clocks_missing: reviews.filter(r => !r.start || !r.end).length,
        base_moved: [
          ...reviews.flatMap(r => r.recaptures.map(c => ({ run: r.run, at: clock(c.at), reason: 'settle base recapture', evidence: r.evidence }))),
          ...cycleLanes.flatMap(l => l.attempts.filter(a => moved.test(a.reason ?? '')).map(a => ({ run: l.run, reason: a.reason, evidence: l.batch }))),
          ...cycleActions.filter(a => a.retry_used || moved.test(a.reason ?? '')).map(a => ({ run: a.run, at: clock(a.finished), reason: a.reason, evidence: a.file })),
          ...notes.filter(n => moved.test(n.text)).map(n => ({ at: clock(n.at), reason: n.text, evidence: `event:${n.seq}` })),
        ],
        exceptions: cycleActions.filter(a => a.exception).map(a => ({ run: a.run, reason: a.reason, code: a.exception, evidence: a.file })),
      }, sources });
  }
  rows.sort((a, b) => a.selected_at.localeCompare(b.selected_at) || a.item.localeCompare(b.item));
  return { schema: 'project-cycle-time/v1', project: { repo: git.canonical, identity: git.identity, org },
    generated_at: clock(now), through: events.at(-1)?.seq ?? 0, window, units: 'seconds',
    summary: summary(rows), cohorts: Object.fromEntries(['in', 'out', 'unknown'].map(c => [c, summary(rows.filter(r => r.cohort === c))])),
    missing_window_clock: missingWindowClock, items: rows, warnings,
    limitations: [
      'One row per landed item cycle. Dispatch is its first run after the preceding recorded landing; report/review/queue are the landed run. Correction and retry loops remain in end-to-end time and named waits.',
      'Main comes only from integration receipts or retained fast path clocks. A reconciliation selects an otherwise untimed landing without fabricating main. Missing window clocks are excluded and counted.',
      'Report availability uses retained Fast path timing snapshots, then current report-file mtime (an observation, not engineer completion). Ingest is a separate record event.',
      'Usable requires an explicit adapter observation with identity, run, item, at and evidence. Brain has no durable installed/usable clock. Main, reconciliation, release cut and release gate do not prove usability.',
      'Cohort is historical landed-run scope eligibility from bound autopilot receipts, not current configuration or proof autopilot performed the promotion. Disabled/unknown-cohort receipts are out; absent evidence is unknown.',
      'p90 uses nearest rank; median averages the two middle samples. Every missing/invalid/reversed interval is null and counted. Stage intervals cover the final path; shared gate costs must not be summed across items.',
      'Gate counts and causes reuse train metrics (retained observations, not inferred executions). Overwritten history is unavailable. Legacy gate clocks may include slot wait; reused gates supply no new execution clock.',
      'Holds and base moves retain scoped notes/receipt reasons as evidence; uninstrumented hold durations stay null. Review rounds count retained verdicts; overwritten same-run reviews cannot be reconstructed.',
    ] };
}

const cell = value => String(value ?? 'null').replace(/[\r\n]+/g, ' ').replace(/\|/g, '\\|');
const seconds = value => value === null ? 'null' : value.toFixed(3);
export function renderCycleTime(data) {
  const lines = ['# Project cycle time', '', `Project: ${cell(data.project.repo)}`, `Record: ${cell(data.project.org)}; through event ${data.through}`,
    `Window: [${data.window.since}, ${data.window.until})`, `${data.window.basis}. All durations are seconds.`,
    `${data.summary.items} landed items; ${data.missing_window_clock} landings excluded for missing window clocks.`, ''];
  for (const [name, group] of [['All', data.summary], ...Object.entries(data.cohorts).map(([c, s]) => [`Autopilot cohort: ${c}`, s])]) {
    lines.push(`## ${name} (${group.items})`, '', '| Stage | Median s | p90 s | Measured | Missing |', '| --- | ---: | ---: | ---: | ---: |');
    for (const [stage, s] of Object.entries(group.stages_s)) lines.push(`| ${stage} | ${seconds(s.median)} | ${seconds(s.p90)} | ${s.samples} | ${s.missing} |`);
    lines.push('', `Missing clocks: ${Object.entries(group.clocks_missing).map(([k, v]) => `${k}=${v}`).join(', ')}.`, '');
  }
  lines.push('## Landed items', '', '| Item | Run | Cohort | Dispatch | Report | Review start/end | Queue | Gate start/end | Main | Usable | Dispatch to main s |',
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | ---: |');
  for (const row of data.items) {
    const c = row.clocks;
    lines.push(`| ${[row.item, row.run, row.cohort, c.dispatch, c.report, `${c.review_start}/${c.review_end}`, c.queue, `${c.gate_start}/${c.gate_end}`, c.main, c.usable, seconds(row.stages_s.dispatch_to_main_s)].map(cell).join(' | ')} |`);
  }
  for (const row of data.items) {
    lines.push('', `### ${row.item}: ${cell(row.title)}`, '', `Runs: ${row.runs.join(', ')}. Cohort: ${row.cohort}; evidence: ${cell(row.cohort_evidence)}.`,
      `Stage seconds: ${Object.entries(row.stages_s).map(([k, v]) => `${k}=${seconds(v)}`).join('; ')}.`,
      `Gate observations: ${row.waits.gate_observations}; executions: ${row.waits.gate_executions}; retries: ${row.waits.gate_retries}; retained review rounds: ${row.waits.review_rounds}; reviews missing clocks: ${row.waits.review_clocks_missing}; missing review receipts: ${row.waits.review_receipts_missing}.`);
    for (const gate of row.waits.gates) lines.push(`- Gate ${cell(gate.batch)}/${gate.attempt}/${gate.execution}: ${gate.status}; ${seconds(gate.seconds)}s; reused=${gate.reused}; duplicate=${gate.duplicate}; reason=${cell(gate.reason)}; failing steps=${cell(gate.failing_steps.join(', '))}; attribution=${cell(JSON.stringify(gate.attribution))}`);
    for (const kind of ['holds', 'base_moved', 'exceptions']) for (const wait of row.waits[kind]) lines.push(`- ${kind}: ${cell(wait.reason)} (${cell(wait.evidence)}).`);
    for (const review of row.waits.reviews) lines.push(`- Review ${review.run}, round ${review.round}: ${review.verdict}; ${review.start}/${review.end}; evidence=${cell(review.evidence)}.`);
    for (const run of row.waits.dispatch) lines.push(`- Dispatch ${run.run}: ${Object.entries(run.waits).map(([k, v]) => `${k}=${seconds(v.seconds)}s (entries=${v.entries}, stopped=${v.stopped}, failed=${v.failed}, pending=${v.pending})`).join('; ')}.`);
    for (const p of row.waits.promotion) lines.push(`- Promotion ${p.run}/${cell(p.batch)}: ${Object.entries(p).filter(([k]) => k.endsWith('_s')).map(([k, v]) => `${k}=${seconds(v)}`).join('; ')}.`);
    lines.push(`- Sources: ${cell(JSON.stringify(row.sources))}`);
  }
  lines.push('', '## Measurement notes', '', ...data.limitations.map(l => `- ${l}`));
  if (data.warnings.length) lines.push('', '## Warnings', '', ...data.warnings.map(w => `- ${cell(w)}`));
  return lines.join('\n') + '\n';
}
export function publishCycleTime(data) {
  const directory = path.join(data.project.org, 'published');
  const key = createHash('sha256').update(JSON.stringify(data)).digest('hex').slice(0, 24);
  const base = path.join(directory, `cycle-time-${key}`);
  // Immutable, generation-specific pairs; there is no mutable 'latest' pointer
  // that could pair Markdown and JSON from different concurrent reports.
  writeFileAtomic(`${base}.json`, JSON.stringify(data, null, 2) + '\n');
  writeFileAtomic(`${base}.md`, renderCycleTime(data));
  return { json: `${base}.json`, markdown: `${base}.md` };
}
export function main(args = process.argv.slice(2)) {
  const options = {}; let json = false, publish = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--help') {
      process.stdout.write('Usage: node supervisor/cycle-time.mjs [--project PATH] [--org DIR] [--since ISO] [--until ISO] [--usable FILE.json] [--json] [--publish]\nDefault: last 7 days ending now; lower inclusive, upper exclusive, selected by main (or reconciliation if main is missing). Plain command only prints. --publish atomically writes Markdown and JSON in ORG/published. --usable reads explicit adapter observations. No scheduling or model calls.\n'); return;
    }
    if (arg === '--json') { json = true; continue; }
    if (arg === '--publish') { publish = true; continue; }
    if (!['--project', '--org', '--since', '--until', '--usable'].includes(arg) || !args[i + 1] || args[i + 1].startsWith('--')) throw Error(`unknown option or missing value: ${arg}`);
    options[arg.slice(2)] = args[++i];
  }
  if (options.usable) {
    options.usable = JSON.parse(fs.readFileSync(options.usable, 'utf8'));
    if (!Array.isArray(options.usable)) throw Error('--usable requires a JSON array');
  }
  const data = collectCycleTime(options);
  if (publish) process.stderr.write(JSON.stringify(publishCycleTime(data)) + '\n');
  process.stdout.write(json ? JSON.stringify(data, null, 2) + '\n' : renderCycleTime(data));
}
if (isMain(import.meta.url)) {
  try { main(); } catch (error) { process.stderr.write(`cycle time: ${error.message}\n`); process.exitCode = 1; }
}
