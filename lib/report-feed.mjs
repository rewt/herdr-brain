// Shared read-only report facts for the console and project chat digest.
const time = value => Date.parse(value) || 0;
const newest = (a, b) => time(b.at) - time(a.at) || String(b.id).localeCompare(String(a.id));

export function noticeFields(message) {
  const kind = /^\[([^\]]+)\]/.exec(message ?? '')?.[1];
  if (!kind) return null;
  const fields = {};
  for (const match of message.matchAll(/([\w-]+)=("(?:\\.|[^"\\])*"|[^\s]+)/g)) {
    try { fields[match[1]] = match[2].startsWith('"') ? JSON.parse(match[2]) : match[2]; } catch {}
  }
  return { kind, ...fields };
}

export function noticeEntries(events = []) {
  const notices = new Map();
  for (const event of events) {
    if (event.type === 'notice') notices.set(event.id, { ...event, delivery: 'pending', fields: noticeFields(event.message) });
    else {
      const notice = notices.get(event.id);
      if (!notice) continue;
      if (event.type === 'sent') notice.delivery = 'sent';
      if (event.type === 'autopilot' && event.result?.disposition === 'handled') notice.delivery = 'handled';
      if (event.type === 'sending') notice.delivery = 'uncertain';
      if (event.type === 'retry') notice.delivery = 'pending';
    }
  }
  return [...notices.values()].sort(newest);
}

export function reportFeed(status, journal = [], { limit = 8 } = {}) {
  const notices = noticeEntries(journal);
  const runs = new Map((status?.runs ?? []).map(r => [r.id, r]));
  const items = new Map((status?.items ?? []).map(i => [i.id, i]));
  const unresolved = r => {
    const item = items.get(r.item);
    return !item?.closed && (!item?.runs?.length || item.runs.at(-1) === r.id);
  };
  const entries = [...runs.values()].filter(r => r.report).map(r => {
    const watch = notices.find(n => n.fields?.kind === 'org-report' && n.fields.run === r.id && n.fields.item === r.item);
    return { id: `report:${r.id}`, kind: 'report', at: r.report.at, run: r.id, item: r.item,
      outcome: r.report.outcome, headline: r.report.headline ?? r.report.summary ?? '',
      check: watch?.fields.check ?? 'unknown', attention: unresolved(r) && ['blocked', 'needs_human', 'failed'].includes(r.report.outcome) };
  });
  // Keep the latest watch state per run. A final report supersedes earlier
  // blocked/no-report notices; transport delivery is not supervisor resolution.
  const seen = new Set();
  const labels = { 'watch-blocked': 'blocked', 'watch-no-report': 'no report', 'watch-invalid-report': 'invalid',
    'watch-unavailable': 'unavailable', 'watch-long-running': 'long running' };
  for (const notice of notices) {
    const f = notice.fields;
    if (!f?.run || seen.has(f.run) || !['org-report', ...Object.keys(labels)].includes(f.kind)) continue;
    seen.add(f.run);
    const report = runs.get(f.run)?.report;
    if (runs.has(f.run) && !unresolved(runs.get(f.run))) continue;
    if (report && time(report.at) >= time(notice.at)) continue;
    if (f.kind === 'org-report' && report) continue;
    entries.push({ id: notice.id, kind: 'notice', at: notice.at, run: f.run, item: f.item,
      outcome: labels[f.kind] ?? 'awaiting ingest', check: f.check ?? 'unknown',
      headline: f.error ?? f.headline ?? (f.kind === 'watch-no-report' ? `Worker ${f.state ?? 'stopped'} without a report` : 'Waiting on supervisor'),
      attention: f.kind !== 'org-report', delivery: notice.delivery });
  }
  const ordered = entries.sort(newest);
  return ordered.filter((entry, index) => index < limit || entry.attention);
}

