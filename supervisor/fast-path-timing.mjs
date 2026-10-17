// Project existing clocks into the action receipt and one terminal run note.
// Missing clocks stay null; no polling, timing service or validation execution.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadEvents } from '../lib/store.mjs';
import { fold } from '../lib/state.mjs';
import { noticeLock } from './notice-lock.mjs';
import { receiptDirectory } from './context.mjs';
import { runMetrics } from '../dispatch/metrics.mjs';
import { queueJobs } from '../promote/promote.mjs';
const record = fileURLToPath(new URL('../bin/org.mjs', import.meta.url));
const read = file => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } };
const elapsed = (a, b) => a && b && Date.parse(b) >= Date.parse(a) ? (Date.parse(b) - Date.parse(a)) / 1000 : null;
export function fastPathTiming(project, runId, receipt, { terminal = false } = {}) {
  const { events, tornTail } = loadEvents(project.org);
  if (tornTail) throw Error('timing: incomplete record tail');
  const run = fold(events).runs.get(runId); if (!run) return null;
  const settled = read(path.join(project.org, 'settle', `${runId}.json`));
  const queue = read(path.join(project.identity, 'promote/queue.json'));
  const job = queue?.identity === project.identity ? queueJobs(queue).findLast(j => j.run === runId && j.org === project.org) : null;
  const train = job?.receipt && read(job.receipt);
  // Delivery has a legacy boolean named queued; the immutable train keeps
  // the admission timestamp even after that delivery field overlays the row.
  const admitted = typeof job?.queued === 'string' ? job.queued : train?.jobs?.find(j => j.id === job?.id)?.queued ?? null;
  const reconcile = events.findLast(e => e.type === 'promotion.reconciled' && e.identity === project.identity && e.heads?.some(h => h.run === runId));
  let reportAvailable = null;
  try { reportAvailable = fs.statSync(run.report_path).mtime.toISOString(); } catch { /* unavailable */ }
  const measurement = {
    clocks: { dispatch: run.started?.at ?? null, report: reportAvailable, ingest: run.report?.at ?? null,
      review_start: settled?.review_started_at ?? null, review_end: settled?.review_finished_at ?? null,
      queue_admission: admitted, gate_start: job?.gate?.command_started_at ?? job?.gate?.started_at ?? null,
      gate_end: job?.gate?.command_finished_at ?? job?.gate?.finished_at ?? null,
      main: job?.integrated_at ?? null, reconcile: reconcile?.at ?? null },
    waits: { dispatch: runMetrics([run]).runs[0]?.waits ?? null, pending: !job?.integrated_at ? job?.phase ?? receipt.reason : null, queue_s: elapsed(admitted, train?.started_at), slot_s: elapsed(train?.started_at, train?.slot_granted_at),
      external_lock_s: elapsed(train?.external_lock_started_at, train?.external_lock_granted_at) },
    exceptions: receipt.disposition === 'wake' && receipt.reason !== 'awaited item landed' ? [receipt.exception ?? receipt.reason] : [],
    outcome: job?.outcome ?? receipt.reason, reused: job?.gate?.reused ?? null,
    sources: { action: receipt.key, settle: settled ? path.join(project.org, 'settle', `${runId}.json`) : null,
      train: job?.receipt ?? null },
  };
  if (terminal) {
    const unlock = noticeLock(path.join(receiptDirectory(project.org, project.identity), 'autopilot', `timing-${runId}.lock`));
    try {
      // Promotion and delayed report notices have different action locks.
      // Serialize the note's read/append and adopt even a lost CLI reply.
      const loaded = loadEvents(project.org);
      if (loaded.tornTail) throw Error('timing: incomplete record tail');
      const latest = fold(loaded.events).runs.get(runId);
      if (!latest.notes.some(n => n.text.startsWith('Fast path timing: '))) {
        const r = spawnSync(process.execPath, [record, 'note', runId, `Fast path timing: ${JSON.stringify(measurement)}`], {
          cwd: project.repo, env: { ...process.env, ORG_DIR: project.org, ORG_ACTOR: 'supervisor-autopilot' }, encoding: 'utf8', timeout: 30000 });
        if (r.error || r.status !== 0) throw Error(r.stderr || r.error?.message || 'timing note refused');
      }
    } finally { unlock(); }
  }

  return measurement;
}
