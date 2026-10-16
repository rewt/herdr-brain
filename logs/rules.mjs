// Typed evidence only: no text matching, lifecycle effects or model calls.
import { canonical, digest } from '../messages/schema.mjs';
import { classify } from '../messages/classify.mjs';

export const RULES = Object.freeze({
  commonBlocker: Object.freeze({ id: 'common-blocker', version: 1, lanes: 2, windowMs: 2 * 3600000 }),
  stall: Object.freeze({ id: 'stall', version: 1, idleMs: 30 * 60000 }),
  resourceRefusal: Object.freeze({ id: 'resource-refusal', version: 1, count: 2, windowMs: 3600000 }),
  reviewLoop: Object.freeze({ id: 'review-loop', version: 1, round: 3 }),
  stuckQueue: Object.freeze({ id: 'stuck-queue', version: 1, pendingMs: 60 * 60000 }),
  // The adopted design leaves calibration open. This explicit starting value
  // applies only to a supplied, compatible recorded baseline, never to budgets.
  costSpike: Object.freeze({ id: 'cost-spike', version: 1, baselineMultiplier: 2 }),
});
const text = x => typeof x === 'string' && x.trim().length > 0 && x.length <= 1024;
const finite = x => typeof x === 'number' && Number.isFinite(x) && x >= 0;
const time = x => typeof x === 'string' && x.endsWith('Z') && Number.isFinite(Date.parse(x));

export function evidence(event) {
  if (event.type === 'session.message.v1') return event.payload.evidence?.validated === true ? event.payload.evidence : null;
  const typed = new Set(['run.report.available', 'review.verdict', 'review.round', 'worker.observation',
    'resource.admission', 'queue.receipt', 'run.usage', 'record.dispatch.receipt', 'record.watch.receipt']);
  return typed.has(event.type) && event.payload.validated === true ? event.payload : null;
}
export function route(event) {
  if (event.type === 'detector.hit') return 'telemetry';
  const classified = classify(event);
  if (classified.path !== 'unknown') return classified.path === 'supervisor' ? 'direct' : classified.path;
  const p = evidence(event);
  if (p && (['blocked', 'needs_human', 'needs-work', 'needs_work', 'failed'].includes(p.outcome) || ['NEEDS-WORK', 'FAIL'].includes(p.verdict) || (p.channel === 'auto-review' && p.verdict !== undefined && p.verdict !== 'PASS') || p.reviewScope === 'deferred' || ['watch-no-report', 'watch-blocked', 'watch-invalid-report'].includes(p.channel))) return 'direct';
  if (p && ['run.report.available', 'review.verdict', 'record.dispatch.receipt', 'record.watch.receipt', 'queue.receipt'].includes(event.type)) return 'triage';
  // Uncertain inputs remain visible. New platform telemetry never becomes a
  // stream of model inputs, even if someone adds an inert kind/evidence field.
  if (['worker.observation', 'resource.admission', 'run.usage'].includes(event.type) || event.type.startsWith('service.') || event.type === 'record.dispatch.receipt') return 'telemetry';
  return 'unknown';
}

export function detect(entries) {
  const hits = [], blockers = [], refusals = [], findings = new Map(), seen = new Set();
  const conditions = new Map();
  // Durable observations seed recurrence/notice identity across a retention
  // boundary. Replaying older sources must not make another direct line.
  for (const e of entries) if (e.type === 'detector.hit' && e.producer.id === 'logs-detector') {
    const h = e.payload, id = canonical([h.rule, h.version, h.condition]);
    const previous = conditions.get(id);
    if (!previous || h.recurrence > previous.recurrence) conditions.set(id, { ...h, sources: new Set(h.sourceIds) });
  }
  const emit = (rule, condition, sources, event, path, detail, status = 'hit') => {
    if (Buffer.byteLength(condition) > 1024) condition = `sha256:${digest(condition)}`;
    const id = canonical([rule.id, rule.version, condition]);
    const ids = [...new Set(sources.map(e => e.eventId))].sort(), previous = conditions.get(id);
    const added = ids.filter(source => !previous?.sources.has(source) && (!previous || !event.cursor || sources.find(e => e.eventId === source)?.cursor?.sequence > previous.evaluatedThrough));
    if (previous && !added.length && previous.detail === detail && previous.status === status) return;
    // A partial retained window cannot downgrade the recorded condition.
    if (previous && !added.length) return;
    const all = new Set([...(previous?.sources ?? []), ...ids]);
    const hit = { rule: rule.id, version: rule.version, condition, sourceIds: [...all].sort(),
      recurrence: previous ? previous.recurrence + added.length : ids.length,
      path, status, detail, occurredAt: event.occurredAt,
      first: !previous, sourceRef: event.source?.ref?.length <= 1024 ? event.source.ref : event.eventId,
      evaluatedThrough: event.cursor?.sequence ?? 0 };
    // Bounded evidence per observation. Recurrence remains exact while old
    // source references are represented by their digest and count.
    if (hit.sourceIds.length > 64 || Buffer.byteLength(canonical(hit.sourceIds)) > 4096) {
      hit.sourceDigest = digest(canonical(hit.sourceIds));
      hit.sourceIds = hit.sourceIds.slice(-64);
      while (Buffer.byteLength(canonical(hit.sourceIds)) > 4096) hit.sourceIds.shift();
    }
    conditions.set(id, { ...hit, sources: all }); hits.push(hit);
  };
  for (const event of entries) {
    if (event.type === 'detector.hit' || event.producer.id === 'logs-control' || seen.has(event.eventId)) continue;
    seen.add(event.eventId);
    const p = evidence(event);
    if (!p) continue;
    const at = Date.parse(event.occurredAt);
    // Pairwise absolute windows accommodate out-of-order producer timestamps.
    if (text(p.causeKey) && text(p.lane) && ['blocked', 'needs_human'].includes(p.outcome)) {
      blockers.push(event);
      const group = blockers.filter(e => evidence(e).causeKey === p.causeKey && Math.abs(at - Date.parse(e.occurredAt)) <= RULES.commonBlocker.windowMs);
      if (new Set(group.map(e => evidence(e).lane)).size >= RULES.commonBlocker.lanes)
        emit(RULES.commonBlocker, p.causeKey, group, event, 'triage', 'distinct lanes share a validated blocker');
    }
    if (p.admission === 'refused' && text(p.resource) && text(p.requestId) && text(p.causeKey)) {
      refusals.push(event);
      const group = refusals.filter(e => { const x = evidence(e); return x.resource === p.resource && x.causeKey === p.causeKey && Math.abs(at - Date.parse(e.occurredAt)) <= RULES.resourceRefusal.windowMs; });
      if (new Set(group.map(e => evidence(e).requestId)).size >= RULES.resourceRefusal.count)
        emit(RULES.resourceRefusal, canonical([p.resource, p.causeKey]), group, event, 'triage', 'repeated admission refusals; no retry or policy change');
    }
    const run = event.run ?? p.run;
    const parked = p.parkedReview === true || p.state === 'ParkedAwaitingReview';
    const held = p.expectedHold === true;
    if (text(run) && !parked && !held) {
      const stopped = p.process === 'stopped' && p.report === 'absent';
      const idle = p.process === 'idle' && p.openRun === true && p.report === 'absent' && time(p.idleSince) && at - Date.parse(p.idleSince) > RULES.stall.idleMs;
      if (stopped || idle || p.channel === 'watch-no-report')
        emit(RULES.stall, canonical([run, event.incarnation ?? p.attempt ?? 'run']), [event], event, 'direct', stopped || p.channel === 'watch-no-report' ? 'worker stopped without a report' : 'open run idle for more than 30 minutes');
      else if (p.openRun === true && (p.process === 'unknown' || (p.process === 'idle' && (!time(p.idleSince) || p.report !== 'absent'))))
        emit(RULES.stall, canonical([run, 'uncertain']), [event], event, 'triage', 'idle/process/report evidence unknown or contradictory', 'unknown');
    }
    const chain = p.reviewChain ?? event.item;
    if (text(chain) && (event.type.startsWith('review.') || p.channel === 'auto-review')) {
      if (Number.isSafeInteger(p.round) && p.round >= RULES.reviewLoop.round)
        emit(RULES.reviewLoop, canonical([chain, 'round']), [event], event, 'triage', 'third or later review round');
      if (text(p.findingKey)) {
        const id = canonical([chain, p.findingKey]);
        const group = findings.get(id) ?? []; group.push(event); findings.set(id, group);
        if (new Set(group.map(e => evidence(e).round ?? e.run)).size >= 2)
          emit(RULES.reviewLoop, id, group, event, 'triage', 'stable finding returned in another review round');
      }
    }
    if (p.queueState === 'pending' && text(p.jobId) && time(p.pendingSince) && at - Date.parse(p.pendingSince) > RULES.stuckQueue.pendingMs)
      emit(RULES.stuckQueue, p.jobId, [event], event, held || text(p.holdOwner) ? 'triage' : 'direct', held || text(p.holdOwner) ? 'pending promotion has hold evidence' : 'promotion pending more than 60 minutes without an explained hold');
    if (event.type === 'run.usage' && text(run)) {
      const u = p.usage, b = p.baseline;
      if (!u || !b || !finite(u.value) || !finite(b.usual) || b.usual === 0 || !text(u.unit) || u.unit !== b.unit || !text(p.route) || b.route !== p.route || !text(b.ref))
        emit(RULES.costSpike, canonical([run, p.route ?? 'unknown', 'unknown']), [event], event, 'triage', 'usage or compatible recorded baseline unknown', 'unknown');
      else if (u.value > b.usual * RULES.costSpike.baselineMultiplier)
        emit(RULES.costSpike, canonical([run, p.route]), [event], event, 'triage', 'usage exceeds twice the recorded route baseline');
    }
  }
  return hits;
}
export function observation(hit, { identity, commonDir }) {
  const id = digest(canonical([hit.rule, hit.version, hit.condition, hit.sourceIds, hit.sourceDigest ?? null]));
  return { schema: 'brain.log/v1', eventId: `detector:${id}`, producer: { id: 'logs-detector', epoch: id, sequence: 1 },
    occurredAt: hit.occurredAt, type: 'detector.hit', level: hit.status === 'unknown' ? 'info' : 'warn', identity,
    project: { commonDir }, source: { kind: 'detector-evidence', ref: hit.sourceRef }, payload: hit };
}
export function directShadow(entries) {
  const seen = new Set(), lines = [];
  for (const e of entries) if (e.type === 'detector.hit' && e.producer.id === 'logs-detector' && e.payload.path === 'direct' && e.payload.status === 'hit') {
    const p = e.payload, id = canonical([p.rule, p.version, p.condition]);
    if (!seen.has(id)) { seen.add(id); lines.push(`[log-shadow] ${p.rule}: ${p.detail} source=${e.source.ref} event=${p.sourceIds.at(-1)}`); }
  }
  return lines;
}
