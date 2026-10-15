// Attention classification only: no delivery, detectors, authority or effects.
export const PATHS = ['supervisor', 'rule', 'triage', 'telemetry', 'unknown'];
export const CLASSIFICATION_VERSION = 'shadow-routing/v1';
const telemetry = new Set([
  'session.started', 'session.parked', 'session.recovered', 'dispatch.delivery.uncertain',
  'retirement.kept', 'service.source.gap', 'service.events.coalesced', 'service.health',
  'controller.lifecycle', 'herdr.observation', 'detector.hit', 'delivery.receipt',
]);
const route = (path, reason) => ({ version: CLASSIFICATION_VERSION, path, reason,
  wouldWake: path === 'unknown' ? null : ['supervisor', 'triage'].includes(path) });

export function classify(event) {
  if (telemetry.has(event.type)) return route('telemetry', 'platform observation; rules and viewer only');
  if (event.type !== 'session.message.v1') return route('unknown', 'unrecognized event type');
  const p = event.payload, e = p.evidence ?? {};
  const verdict = typeof e.verdict === 'string' ? e.verdict.trim().toUpperCase() : e.verdict;
  if (['fyi', 'ack', 'hold', 'release'].includes(p.kind)) return route('rule', `explicit ${p.kind}; no model wake or implied control authority`);
  if (['question', 'request', 'decision'].includes(p.kind)) return route('supervisor', `explicit ${p.kind}; direct judgment, authority must still be checked`);
  if (p.kind === 'reply') return route('unknown', 'pending thread and exact recipient require future transport validation');
  if (e.validated !== true) return route('unknown', 'unvalidated or untyped operational input; preserve for inspection');
  if (['operator', 'coordinator'].includes(e.origin)) return route('supervisor', 'substantive operator/coordinator relay; provenance is separate from authority');
  if (e.reviewScope === 'deferred') return route('supervisor', 'deferred review scope requires judgment');
  if (['blocked', 'needs_human', 'needs-work', 'needs_work', 'failed'].includes(e.outcome) || ['NEEDS-WORK', 'FAIL'].includes(verdict))
    return route('supervisor', 'blocked, needs-work or failed report requires judgment');
  if (['watch-blocked', 'watch-no-report', 'watch-invalid-report'].includes(e.channel))
    return route('supervisor', 'worker blocked or stopped without a valid report');
  if (['watch-long-running', 'watch-unavailable'].includes(e.channel))
    return route('triage', 'operational watch observation; no established stall inferred');
  if (e.channel === 'org-report') {
    if (e.outcome === 'done' && (verdict === undefined || verdict === 'PASS')) return route('triage', 'validated routine report outcome');
    return route('unknown', 'unrecognized report outcome or review verdict');
  }
  if (e.channel === 'auto-review') {
    if (e.outcome === 'skipped' && e.skipReason === 'unsupported-role') return route('triage', 'verified unsupported-role skip');
    if (e.outcome === 'done' && verdict === 'PASS') return route('triage', 'verified routine review PASS');
    return route('unknown', 'review skip/outcome has no verified routine interpretation');
  }
  if (e.channel === 'promote-queue' && ['promoted', 'refused', 'interrupted', 'skipped', 'timeout', 'held'].includes(e.outcome))
    return route('triage', 'existing operational queue outcome');
  if (e.channel === 'operational' && ['completion', 'progress', 'peer', 'relay'].includes(e.outcome))
    return route('triage', 'typed operational outcome');
  return route('unknown', 'unrecognized operational channel or outcome');
}

// Only model-free notices whose entire type establishes the condition are
// recognized here. Reports and review skips need their producer's evidence.
export function noticeEvidence(message) {
  const tag = /^\[(watch-blocked|watch-no-report|watch-invalid-report|watch-long-running|watch-unavailable)\] run=R-\d+ item=\S+ /.exec(message)?.[1];
  return tag ? { channel: tag, validated: true } : { channel: 'supervisor-inbox', validated: false };
}
