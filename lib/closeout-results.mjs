// Read durable, exact closeout outcomes after a completion outbox was acked.
// This never starts cleanup, republishes a handoff, integrates or validates.
import fs from 'node:fs';
import { loadEvents } from './store.mjs';
import { verifyCloseoutHandoff } from './closeout-handoff.mjs';
import { recordedCloseoutHandoff } from './closeout.mjs';

export function promotionCloseoutOutcome(job, common) {
  try {
    if (job.outcome !== 'promoted' || job.cleanup?.owner !== 'closeout-queue' ||
        job.reconciliation?.state !== 'complete' || !job.org || !job.run || !job.tip || !job.topic) return null;
    const org = fs.realpathSync(job.org), loaded = loadEvents(org);
    if (loaded.tornTail) return null;
    const fingerprint = job.reconciliation.recovered?.fingerprint ?? job.reconciliation.fingerprint;
    if (!fingerprint) return null;
    const sources = loaded.events.filter(e => e.type === 'promotion.reconciled' && e.identity === common && e.fingerprint === fingerprint &&
      (!job.cleanup.source || (e.seq === job.cleanup.source.seq && e.type === job.cleanup.source.type && e.fingerprint === job.cleanup.source.fingerprint)));
    if (sources.length !== 1) return null;
    const source = sources[0], targets = (source.closeout_targets ?? []).filter(t => t.common === common && t.org === org &&
      t.run === job.run && t.branch === `lane/${job.topic}` && t.head === job.tip && (!job.item || t.item === job.item) &&
      source.heads?.some(h => h.run === t.run && h.item === t.item && h.head === t.head));
    if (targets.length !== 1) return null;
    const keys = targets.map(t => t.key);
    if (job.cleanup.keys && (job.cleanup.keys.length !== keys.length || !keys.every(k => job.cleanup.keys.includes(k)))) return null;
    const outcomes = targets.map(target => {
      const outcome = loaded.events.findLast(e => e.type === 'closeout.evaluated' && e.identity === common && e.key === target.key &&
        e.run === target.run && e.item === target.item && e.source?.seq === source.seq && e.source.type === source.type);
      const entry = { ...target, source: { seq: source.seq, type: source.type } };
      const evidence = outcome?.completed ? loaded.events.filter(e => e.seq <= outcome.seq) : loaded.events;
      const handoff = recordedCloseoutHandoff(entry, evidence, outcome?.completed ? outcome : undefined);
      if (!handoff) return undefined;
      verifyCloseoutHandoff({ ...entry, handoff: { seq: handoff.seq, digest: handoff.digest } }, evidence);
      return outcome;
    });
    return { complete: outcomes.every(e => e?.completed === true), keys, outcomes,
      source: { seq: source.seq, type: source.type, fingerprint: source.fingerprint } };
  } catch { return null; } // Unknown/changed proof retains cleanup-pending.
}
