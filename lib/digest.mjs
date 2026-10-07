// On-demand facts, never a notification sender or a stored status/last-read marker.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { UserError } from './store.mjs';
import { blockedBy, blockersOf, isResolved, statusMap } from './state.mjs';
import { noticeEntries, reportFeed } from './report-feed.mjs';

const stamp = value => Date.parse(value) || 0;
const newest = (a, b) => stamp(b.at) - stamp(a.at) || (b.seq ?? 0) - (a.seq ?? 0) || String(a.id).localeCompare(String(b.id));
const anchor = value => value === undefined ? null : crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const entries = value => value == null ? [] : Array.isArray(value) ? value : [value];

export function readDigestJournal(orgDir) {
  const file = path.join(orgDir, 'supervisor/inbox.log');
  let text;
  try { text = fs.readFileSync(file, 'utf8'); }
  catch (error) {
    if (error.code === 'ENOENT') return { journal: [], warnings: ['No inbox journal; promotion and watch evidence is unavailable.'] };
    throw new UserError(`cannot read digest inbox: ${error.message}`);
  }
  const complete = text.slice(0, text.lastIndexOf('\n') + 1);
  try {
    return { journal: complete.split('\n').filter(Boolean).map(JSON.parse),
      warnings: complete.length === text.length ? [] : ['Incomplete inbox tail ignored.'] };
  } catch { throw new UserError(`malformed digest inbox: ${file}`); }
}

// Cursor offsets cover the actual snapshots, including late/backdated writes.
// Anchors reject truncation/rotation; the canonical record path rejects cross-project reuse.
function boundary(events, journal, org, after) {
  if (after === undefined) return null;
  let c;
  try { c = JSON.parse(Buffer.from(after, 'base64url').toString('utf8')); } catch {}
  if (!c || c.v !== 1 || c.org !== org || !Number.isFinite(Date.parse(c.at))
      || !Number.isSafeInteger(c.events) || c.events < 0 || c.events > events.length
      || !Number.isSafeInteger(c.journal) || c.journal < 0 || c.journal > journal.length
      || c.event_anchor !== anchor(events[c.events - 1]) || c.journal_anchor !== anchor(journal[c.journal - 1])) {
    throw new UserError('invalid digest cursor or changed record/journal; start again with --since');
  }
  return c;
}

export function digestJson(s, events, journal, { orgDir, now, since = null, after, warnings = [] }) {
  const org = fs.realpathSync(orgDir);
  const previous = boundary(events, journal, org, after);
  const eventChanged = new Set(events.filter((e, index) => previous ? index >= previous.events : !since || stamp(e.at) >= since.getTime()));
  const journalChanged = new Set(journal.filter((e, index) => previous ? index >= previous.journal : !since || stamp(e.at) >= since.getTime()));
  const notices = noticeEntries(journal);
  const changedNotices = new Set([...journalChanged].filter(e => e.type === 'notice').map(e => e.id));
  const statuses = statusMap(s);
  const items = [...s.items.values()], runs = [...s.runs.values()];
  const title = id => s.items.get(id)?.title ?? null;
  const cursor = Buffer.from(JSON.stringify({ v: 1, org, at: now.toISOString(), events: events.length,
    journal: journal.length, event_anchor: anchor(events.at(-1)), journal_anchor: anchor(journal.at(-1)) })).toString('base64url');

  // A done report is never a claim of landing. Only durable promotion outcomes
  // say that a fast-forward landed or was refused, independent of delivery state.
  const promotions = notices.filter(n => changedNotices.has(n.id) && n.fields?.kind === 'promote-queue'
    && ['promoted', 'refused'].includes(n.fields.outcome)).map(n => ({
    id: n.id, at: n.at, lane: n.fields.lane, outcome: n.fields.outcome,
    reason: n.fields.reason ?? '', log: n.fields.log ?? null, receipt: n.fields.receipt ?? null,
    source: 'inbox',
  })).sort(newest);

  const changedReports = new Set([...eventChanged].filter(e => e.type === 'report.ingested').map(e => e.run));
  const reportNotices = new Map();
  for (const n of notices) {
    const f = n.fields;
    if (f?.kind !== 'org-report' || reportNotices.has(f.run)) continue;
    const r = s.runs.get(f.run);
    if (r && f.item !== r.item) continue;
    reportNotices.set(f.run, n);
    if (changedNotices.has(n.id)) changedReports.add(f.run);
  }
  const reports = reportFeed({ items, runs }, journal, { limit: Infinity }).filter(r => r.kind === 'report' && changedReports.has(r.run))
    .map(r => ({ ...r, recorded: true, at: stamp(reportNotices.get(r.run)?.at) > stamp(r.at) ? reportNotices.get(r.run).at : r.at }));
  for (const [run, n] of reportNotices) {
    if (!changedReports.has(run) || s.runs.get(run)?.report) continue;
    const f = n.fields;
    reports.push({ id: n.id, kind: 'report', at: n.at, run, item: f.item,
      outcome: f.outcome, headline: f.headline ?? '', check: f.check ?? 'unknown', recorded: false });
  }
  reports.sort(newest);

  const decisions = [];
  for (const e of eventChanged) {
    if (e.type === 'note.added' && e.decision) decisions.push({ id: `decision:${e.seq}`, target: e.id,
      at: e.at, seq: e.seq, by: e.by, text: e.summary ?? e.text });
    if (e.type === 'report.ingested') for (const [index, d] of entries(e.report.decisions ?? e.report.extra?.decisions).entries()) {
      const text = typeof d === 'string' ? d : d?.text ?? d?.decision;
      if (typeof text !== 'string' || !text.trim()) continue;
      decisions.push({ id: `decision:${e.seq}:${index}`, target: e.run, item: e.item, at: e.at, seq: e.seq,
        by: e.by, text: d?.summary ?? text, category: d?.category ?? null, why: d?.why ?? null });
    }
  }
  decisions.sort(newest);

  // Outstanding questions and blocks survive an old window: a conversation
  // must not lose an unresolved operator obligation merely because it read it.
  const questions = items.filter(i => i.role === 'human' && i.kind !== 'goal' && !i.closed && !isResolved(statuses.get(i.id)))
    .map(i => ({ id: i.id, at: i.created.at, title: i.title, category: i.meta.category ?? null,
      recommend: i.meta.recommend ?? null, why: i.notes.find(n => n.kind === 'why')?.text ?? i.created.why ?? null,
      blocks: blockedBy(s, i.id), status: statuses.get(i.id) }));
  const currentRun = r => r && !r.abandoned && !s.items.get(r.item)?.closed && s.items.get(r.item)?.runs.at(-1) === r.id;
  const blocked = [];
  for (const r of runs) {
    if (!currentRun(r) || !['blocked', 'needs_human'].includes(statuses.get(r.item))) continue;
    blocked.push({ id: `blocked:${r.id}`, run: r.id, item: r.item, agent: r.meta.agent ?? null,
      at: r.report?.at ?? r.started.at, source: 'record', status: statuses.get(r.item),
      reason: r.report?.blockers?.join('; ') || r.report?.headline || r.report?.summary || title(r.item),
      blocked_by: blockersOf(s, r.item) });
  }
  const seen = new Set();
  for (const n of notices) {
    const f = n.fields;
    if (!f?.run || !['watch-blocked', 'watch-no-report', 'watch-invalid-report', 'watch-unavailable', 'watch-long-running', 'org-report'].includes(f.kind)
        || seen.has(f.run)) continue;
    const r = s.runs.get(f.run);
    if (!r || f.item !== r.item) continue;
    seen.add(f.run);
    if (f.kind !== 'watch-blocked' || !currentRun(r) || r.report) continue;
    blocked.push({ id: n.id, run: r.id, item: r.item, agent: f.worker ?? r.meta.agent ?? null,
      at: n.at, source: 'inbox', status: 'blocked', reason: 'Worker is blocked at a prompt', blocked_by: blockersOf(s, r.item) });
  }
  blocked.sort(newest);

  return { project: { org, as_of: now.toISOString() }, since: previous?.at ?? since?.toISOString() ?? null,
    cursor, promotions, reports, decisions, questions, blocked, warnings };
}
