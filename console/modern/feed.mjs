// Read-only, UI-independent facts. This projection can also back a web view.
import fs from 'node:fs';
import path from 'node:path';

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

export function trainFacts(queue, batches = []) {
  const receipts = new Map(batches.map(b => [b.id, b]));
  const current = queue?.current;
  const batch = current && receipts.get(current.id);
  const attempt = batch?.attempts?.at(-1);
  const results = new Map();
  // Receipts survive queue rotation; the queue has richer delivery timestamps.
  for (const b of batches) for (const [id, result] of Object.entries(b.results ?? {})) {
    const job = b.jobs?.find(j => j.id === id);
    results.set(id, { ...result, id, topic: job?.topic, run: job?.run,
      at: result.integrated_at ?? result.gate?.finished_at ?? b.updated_at,
      log: result.log ?? b.log, receipt: b.receipt });
  }
  for (const r of queue?.results ?? []) {
    const saved = results.get(r.id);
    // A resumed receipt can finish before its replacement delivery is queued.
    // The old interrupted notice must not turn that final result backwards.
    if (r.outcome === 'interrupted' && ['promoted', 'refused'].includes(saved?.outcome)) continue;
    results.set(r.id, { ...saved, ...r, at: r.finished ?? r.integrated_at ?? r.gate?.finished_at ?? saved?.at });
  }
  return {
    waiting: queue?.pending ?? [], interrupted: queue?.interrupted ?? [],
    current: current ? { id: current.id, lanes: (attempt?.jobs ?? current.jobs ?? [current]).map(j => j.topic),
      phase: current.phase === 'batching' ? (attempt?.phase === 'prepared' && batch?.command && !attempt.gate ? 'validating' : attempt?.phase ?? batch?.phase ?? current.phase) : current.phase,
      started: batch?.started_at ?? batch?.created_at ?? null,
      checkStarted: attempt?.gate?.started_at ?? null,
      checkFinished: attempt?.gate?.finished_at ?? null,
      checkDurationSeconds: attempt?.gate?.duration_s ?? null,
      checkComplete: Boolean(attempt?.gate && (attempt.gate.finished_at || attempt.gate.exit_code != null)),
      command: attempt?.gate?.command ?? batch?.command ?? null, log: batch?.log ?? current.log } : null,
    results: [...results.values()].sort(newest),
  };
}

export function createFeedReader({ fsApi = fs } = {}) {
  // A changed, malformed source fails explicitly; its caller retains last good
  // data. Optional absent files are normal. Never create directories or locks.
  const cache = new Map();
  function read(file, parse) {
    let st;
    try { st = fsApi.statSync(file); } catch (e) { if (e.code === 'ENOENT') return null; throw e; }
    const signature = `${st.mtimeMs}:${st.size}`;
    if (cache.get(file)?.signature === signature) return cache.get(file).value;
    const value = parse(fsApi.readFileSync(file, 'utf8'));
    cache.set(file, { signature, value });
    return value;
  }
  return {
    journal(project) {
      if (!project) return [];
      const file = path.join(project.org ?? project.repoKey, 'supervisor/inbox.log');
      return read(file, text => {
        // Concurrent appends can expose a partial tail. Complete lines only.
        return text.slice(0, text.lastIndexOf('\n') + 1).split('\n').filter(Boolean).map(JSON.parse);
      }) ?? [];
    },
    train(project) {
      if (!project?.git) return trainFacts(null);
      const directory = path.join(project.repoKey, 'promote');
      const queue = read(path.join(directory, 'queue.json'), JSON.parse);
      if (queue && queue.identity !== project.repoKey) throw Error('Promotion queue repository identity changed');
      const root = path.join(directory, 'batches');
      let names;
      try { names = fsApi.readdirSync(root); } catch (e) { if (e.code === 'ENOENT') names = []; else throw e; }
      const batches = [];
      for (const name of names) {
        const receipt = path.join(root, name, 'train.json');
        const b = read(receipt, JSON.parse);
        if (!b) continue;
        if (b.identity !== project.repoKey) throw Error('Train receipt repository identity changed');
        const st = fsApi.statSync(receipt);
        // Unlike train.json, the batch directory is not atomically replaced.
        const directoryStat = fsApi.statSync(path.dirname(receipt));
        const log = path.join(root, name, 'train.log');
        // The current receipt writer records its creation, not a running gate's
        // clock. Preserve that distinction. The validating line names the CI.
        let command = null;
        if (queue?.current?.id === b.id) {
          const validating = read(log, text => [...text.matchAll(/^validating in (.+?): (.+)$/gm)].map(m => ({ scratch: m[1], command: m[2] })));
          command = validating?.filter(v => !b.attempts?.at(-1)?.scratch || v.scratch === b.attempts.at(-1).scratch).at(-1)?.command ?? null;
        }
        batches.push({ ...b, command, log, receipt,
          created_at: b.created_at ?? (directoryStat.birthtimeMs > 0 ? new Date(directoryStat.birthtimeMs).toISOString() : null),
          updated_at: new Date(st.mtimeMs).toISOString() });
      }
      return trainFacts(queue, batches);
    },
  };
}
