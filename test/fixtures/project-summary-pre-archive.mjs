// Frozen summary readers from 2a040174, before archive.dirs was added.
// Only their imports/identity helpers are included; keep reader bodies unchanged.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { now as clock } from '../../lib/store.mjs';

export const SUMMARY_SCHEMA = 'project-summary/v1';
const hash = value => createHash('sha256').update(value).digest('hex');
const projectId = project => hash(project.identity);
const iso = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null;

export function publishedSummaryStatus(org, { now = clock().toISOString(), project } = {}) {
  const result = { status: 'missing', generated_at: null, age_seconds: null, stale_after_seconds: null };
  try {
    const doc = JSON.parse(fs.readFileSync(path.join(org, 'published/summary.json'), 'utf8'));
    if (doc.schema !== SUMMARY_SCHEMA || !iso(doc.generated_at) || !Number.isSafeInteger(doc.stale_after_seconds) || doc.stale_after_seconds < 1 ||
        (project && doc.project?.id !== projectId(project)))
      return { ...result, status: 'invalid' };
    const age = (Date.parse(now) - Date.parse(doc.generated_at)) / 1000;
    if (!Number.isFinite(age) || age < 0) return { ...result, status: 'invalid' };
    return { status: age > doc.stale_after_seconds ? 'stale' : 'fresh', generated_at: iso(doc.generated_at),
      age_seconds: Math.floor(age), stale_after_seconds: doc.stale_after_seconds };
  } catch (error) { return { ...result, status: error.code === 'ENOENT' ? 'missing' : 'invalid' }; }
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
    `Release: current ${doc.releases.current ?? 'unknown'}; pinned ${doc.releases.pinned ?? 'unavailable'}.`,
    `Exceptions: ${doc.exceptions.map(e => e.name).join(', ') || 'none'}.`];
  return rows.join('\n') + '\n';
}
