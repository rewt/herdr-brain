// The line owns record-only replay, never dispatch --retry or native discovery.
import fs from 'node:fs';
import path from 'node:path';
import { gitProject } from '../lib/project.mjs';
import { writeFileAtomic } from '../lib/store.mjs';
import { assertOwner, readOwnedRun, requireController, fenceOwner } from '../lib/run-owner.mjs';
import { lockRequest } from './request-lock.mjs';
import { commitSessionBinding } from './session-bind.mjs';

export function pendingSessionBinding(run, org, project) {
  const journal = run.meta?.dispatch_journal;
  if (!journal || run.meta.dispatch_project !== project || run.meta.dispatch_record !== org ||
      !run.owner || run.owner.controller !== 'brain' || run.owner.legacy ||
      path.dirname(journal) !== path.join(org, 'dispatch')) return false;
  const job = JSON.parse(fs.readFileSync(journal, 'utf8'));
  return job.run === run.id && job.stage === 'complete' && job.sessionBinding?.status === 'observing' &&
    !!job.sessionBinding.proposed && !job.sessionBinding.record_refusal;
}

export function replaySessionBinding({ journal, org, project, guard, record }) {
  if (fs.realpathSync(org) !== org || fs.realpathSync(journal) !== journal ||
      path.dirname(journal) !== path.join(org, 'dispatch')) throw Error('session binding replay record/journal identity changed');
  const lock = lockRequest(journal);
  try {
    guard();
    let bytes = fs.readFileSync(journal);
    const job = JSON.parse(bytes), b = job.sessionBinding;
    if (job.stage !== 'complete' || b?.status !== 'observing' || !b.proposed || b.record_refusal) return;
    if (job.org !== org || job.common !== project || gitProject(job.repo).identity !== project ||
        path.basename(journal) !== `${job.token}.json`) throw Error('session binding replay original dispatch changed');
    const run = readOwnedRun(org, job.run);
    requireController(run, 'brain'); assertOwner(run, job.ownership);
    if (run.meta?.dispatch_journal !== journal || run.meta.dispatch_attempt !== job.token ||
        run.meta.dispatch_project !== project || run.meta.dispatch_record !== org ||
        run.item !== job.item) throw Error('session binding replay original run changed');
    const save = () => {
      guard();
      fenceOwner(org, job.run, job.ownership, () => {
        if (!fs.readFileSync(journal).equals(bytes) || fs.readFileSync(lock.lock, 'utf8') !== String(process.pid))
          throw Error('session binding replay source/lock changed');
        const next = JSON.stringify(job, null, 2) + '\n';
        writeFileAtomic(journal, next, 0o600); bytes = Buffer.from(next);
      });
    };
    return commitSessionBinding({ job, save, record: () => {
      guard();
      const reply = record(journal), receipt = typeof reply === 'string' ? JSON.parse(reply) : reply;
      if (receipt?.schema !== 'dispatch-session-binding/v1' || receipt.outcome !== 'bound' ||
          receipt.run !== job.run || receipt.journal !== journal || receipt.attempt !== job.token ||
          receipt.session !== b.proposed.session || !Number.isSafeInteger(receipt.event_seq) || receipt.event_seq < 1 ||
          typeof receipt.recorded !== 'boolean') throw Error('session binding reply lacks the original typed receipt');
      return receipt;
    } });
  } finally { lock.release(); }
}
