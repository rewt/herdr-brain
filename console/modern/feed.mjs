// Read-only, UI-independent facts. This projection can also back a web view.
import fs from 'node:fs';
import path from 'node:path';

const time = value => Date.parse(value) || 0;
const newest = (a, b) => time(b.at) - time(a.at) || String(b.id).localeCompare(String(a.id));

export { noticeFields, noticeEntries, reportFeed } from '../../lib/report-feed.mjs';

export function trainFacts(queue, batches = []) {
  const receipts = new Map(batches.map(b => [b.id, b]));
  const current = queue?.current;
  const batch = current && receipts.get(current.id);
  const attempt = batch?.attempts?.at(-1);
  const results = new Map();
  // Receipts survive queue rotation; the queue has richer delivery timestamps.
  for (const b of batches) for (const [id, result] of Object.entries(b.results ?? {})) {
    const job = b.jobs?.find(j => j.id === id);
    results.set(id, { ...result, id, topic: job?.topic, run: job?.run, queued: job?.queued, batch: result.batch ?? b.id,
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
  for (const [index, member] of (current?.results ?? []).entries()) {
    const r = member.result, job = member.job;
    if (!r || !job) continue;
    const saved = results.get(job.id);
    if (r.outcome === 'interrupted' && ['promoted', 'refused'].includes(saved?.outcome)) continue;
    results.set(job.id, { ...saved, ...job, ...r,
      close_complete: index < current.deliveredCount || current.phase === 'completed' && index === current.deliveredCount,
      at: r.integrated_at ?? r.gate?.finished_at ?? saved?.at });
  }
  return {
    waiting: queue?.pending ?? [], interrupted: queue?.interrupted ?? [], batches,
    current: current ? { id: current.id, lanes: (attempt?.jobs ?? current.jobs ?? [current]).map(j => j.topic),
      phase: current.phase === 'batching' ? (batch?.phase && batch.phase !== 'pending' ? batch.phase
        : attempt?.phase === 'prepared' && batch?.command && !attempt.gate ? 'validating' : attempt?.phase ?? batch?.phase ?? current.phase) : current.phase,
      started: batch?.started_at ?? batch?.created_at ?? null,
      checkStarted: attempt?.gate?.started_at ?? null,
      checkFinished: attempt?.gate?.finished_at ?? null,
      checkDurationSeconds: attempt?.gate?.duration_s ?? null,
      checkComplete: Boolean(attempt?.gate && (attempt.gate.finished_at || attempt.gate.exit_code != null)),
      command: attempt?.gate?.command ?? batch?.command ?? null, log: batch?.log ?? current.log,
      jobs: attempt?.jobs ?? current.jobs ?? [], receipt: batch?.receipt, error: current.phase === 'batching' ? null : current.error } : null,
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
        if (queue?.current?.id === b.id && !b.attempts?.at(-1)?.gate?.command) {
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
