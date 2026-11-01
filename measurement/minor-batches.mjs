// Read-only Part 1 inventory. No intake, selection, dispatch or service effects.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { loadEvents } from '../lib/store.mjs';
import { fold } from '../lib/state.mjs';
import { readReport } from '../lib/report.mjs';
import { roleIs } from '../lib/roles.mjs';
import { batchedMinorSection, batchedMinorKey } from '../lib/batched-minors.mjs';

const digest = value => createHash('sha256').update(value).digest('hex');
export const DISPOSITION_PREFIX = 'minor-batch: ';

export function reportMinors(text) {
  const parsed = readReport(text);
  if (parsed.errors.length) throw Error(parsed.errors.join('; '));
  const { report, body } = parsed;
  const { rows, malformed, sections } = batchedMinorSection(body);
  const typed = (report.extra?.findings ?? []).filter(f => ['major', 'minor'].includes(String(f?.severity).toLowerCase()));
  const tagged = [];
  for (const line of body.split('\n')) {
    // Intake scans tagged bullets even in fences; retain that actual behavior.
    const tag = /^\s*[-*]\s*\[(Major|Minor)\]\s*(.+)$/i.exec(line);
    if (tag) tagged.push({ severity: tag[1].toLowerCase(), text: tag[2] });
  }
  const hasMajor = [...typed, ...tagged].some(f => String(f.severity).toLowerCase() === 'major');
  const oldMinors = [...typed, ...tagged].filter(f => String(f.severity).toLowerCase() === 'minor');
  const engineerProposals = report.proposals.filter(p => roleIs(p, 'ENG'));
  return { report, rows, malformed, sections, hasMajor, oldMinors, engineerProposals };
}

export function collectMinors({ events, read = file => fs.readFileSync(file, 'utf8'), org }) {
  const state = fold(events), findings = [], reviews = [], legacy = [], issues = [];
  for (const run of state.runs.values()) {
    const review = state.items.get(run.item), target = review?.meta?.review_target;
    if (!roleIs(review, 'REV') || !target || !run.report) continue;
    try {
      // Only the ingested immutable copy, never the worker's editable report_path.
      const file = path.resolve(org, run.report.file);
      const text = read(file);
      if (digest(text) !== run.report.sha256) throw Error(`immutable report hash mismatch: ${file}`);
      const extracted = reportMinors(text);
      if (extracted.report.run !== run.id) throw Error('report run differs from record');
      const context = { review: review.id, run: run.id, source: review.meta.review_source_item,
        source_run: review.meta.review_source_run, base: target.base, head: target.head,
        report: file, report_sha256: run.report.sha256, ingested_seq: run.report.seq };
      const corrections = [...state.items.values()].filter(i => roleIs(i, 'ENG') &&
        (i.created?.run === run.id || i.meta.review_fix_of === `${context.source}:${context.head}`));
      const starts = [...state.runs.values()].filter(r => corrections.some(i => i.id === r.item)).map(r => r.id);
      Object.assign(context, { correction_items: corrections.map(i => i.id), fix_sessions: starts });
      if (!extracted.hasMajor && (extracted.oldMinors.length ||
          extracted.report.extra?.verdict === 'PASS' && extracted.engineerProposals.length))
        legacy.push({ ...context, tagged_or_structured_minors: extracted.oldMinors, engineer_proposals: extracted.engineerProposals });
      if (!extracted.sections) continue;
      if (extracted.hasMajor || extracted.oldMinors.length || extracted.engineerProposals.length ||
          extracted.malformed.length || extracted.sections !== 1 || !extracted.rows.length ||
          extracted.report.extra?.verdict !== 'PASS' || extracted.report.outcome !== 'done') {
        issues.push({ ...context, error: 'Batched Minors requires one nonempty plain section, done/PASS, no Major, typed finding or engineer proposal',
          malformed: extracted.malformed });
        continue;
      }
      reviews.push(context);
      for (const row of extracted.rows) findings.push({ ...context, ...row,
        key: batchedMinorKey(review.id, run.id, run.report.sha256, row) });
    } catch (error) { issues.push({ review: review.id, run: run.id, error: error.message }); }
  }
  const byKey = new Map(findings.map(f => [f.key, f]));
  for (const event of events) {
    if (event.type !== 'review.finding-linked') continue;
    for (const key of event.finding?.batched_minor_keys ?? []) {
      const finding = byKey.get(key), correction = state.items.get(event.correction_item);
      if (!finding || !roleIs(correction, 'ENG') || event.review_item !== finding.review || event.review_run !== finding.run ||
          event.report_sha256 !== finding.report_sha256 || event.head !== finding.head || event.base !== finding.base) continue;
      const disposition = { status: 'batched', batch: correction.id, finding: finding.key,
        reason: 'Immutable Part 1 finding linked by intake to its correction', evidence: `review.finding-linked:${event.seq}`,
        finding_key: event.finding_key, seq: event.seq, at: event.at };
      finding.dispositions = [...(finding.dispositions ?? []), disposition];
      finding.disposition = disposition;
    }
  }
  for (const review of state.items.values()) for (const note of review.notes ?? []) {
    if (!note.text?.startsWith(DISPOSITION_PREFIX)) continue;
    try {
      const d = JSON.parse(note.text.slice(DISPOSITION_PREFIX.length)), finding = byKey.get(d.finding);
      if (d.schema !== 'brain.minor-batch/v1' || !finding || finding.review !== review.id ||
          !['batched', 'fixed', 'stale', 'dismissed'].includes(d.status) ||
          typeof d.reason !== 'string' || !d.reason.trim() || typeof d.evidence !== 'string' || !d.evidence.trim() ||
          (['batched', 'fixed'].includes(d.status) && !roleIs(state.items.get(d.batch), 'ENG')))
        throw Error('disposition must bind an immutable finding on its review, a reason/evidence and an existing engineer batch for batched/fixed');
      finding.dispositions ??= [];
      finding.dispositions.push({ ...d, seq: note.seq, at: note.at });
      finding.dispositions.sort((a,b)=>a.seq-b.seq);
      finding.disposition = finding.dispositions.at(-1);
    } catch (error) { issues.push({ review: review.id, note_seq: note.seq, error: error.message }); }
  }
  const pending = findings.filter(f => !f.disposition);
  const groups = [...new Set(pending.map(f => f.location.replace(/:\d.*$/, '')))].sort().map(file =>
    ({ file, findings: pending.filter(f => f.location.startsWith(`${file}:`)).map(f => f.key) }));
  return { schema: 'brain.minor-batch-inventory/v1', through_seq: events.at(-1)?.seq ?? 0,
    reviews, findings, pending: pending.map(f => f.key), groups, legacy_minor_only: legacy, issues };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const { values, positionals } = parseArgs({ options: { org: { type: 'string' } }, allowPositionals: true });
    if (!values.org || positionals.length) throw Error('usage: node measurement/minor-batches.mjs --org RECORD');
    const org = fs.realpathSync(values.org), loaded = loadEvents(org);
    if (loaded.tornTail) throw Error('record has an incomplete event; preserve it');
    const inventory = collectMinors({ events: loaded.events, org });
    process.stdout.write(`${JSON.stringify(inventory, null, 2)}\n`);
    if (inventory.issues.length) process.exitCode = 1;
  } catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1; }
}
