// Record-native obligations. The original append is the durable intent; this
// index is rebuildable, like the other folded facts. It grants NO effect/retry
// authority. Consumers still enter through their existing guarded commands.
const copy = value => structuredClone(value);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
export const obligationId = (kind, ...subject) => JSON.stringify([kind, ...subject]);
const id = obligationId;
const ref = e => ({ seq: e.seq, type: e.type, at: e.at });
const commit = value => /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value ?? '');

export const obligationKinds = Object.freeze({
  'report-intake': { consumer: 'report-ingest', wake: ['report.available', 'report.ingested'], stuck_owner: 'original-report-watcher' },
  'review-handoff': { consumer: 'queue-review', wake: ['change.landed', 'report.ingested', 'item.added:review_source_run'], stuck_owner: 'line-service' },
  closeout: { consumer: 'lane-closeout', wake: ['closeout source', 'closeout.evaluated'], stuck_owner: 'lane-closeout' },
  'closeout-binding': { consumer: null, wake: ['original binding evidence'], stuck_owner: 'original-run' },
  'closeout-wait': { consumer: 'closeout-producer-status', wake: ['closeout.producer-status', 'closeout.evaluated', 'closeout.wait-classified'], stuck_owner: 'waiting.owner' },
  'native-outcome': { consumer: 'original-closeout-executor', wake: ['exact intent-linked closeout result'], stuck_owner: 'original-run' },
  'dispatch-outcome': { consumer: 'dispatch-completion', wake: ['dispatch.completed'], stuck_owner: 'original-dispatch' },
  'source-completion': { consumer: 'conditional-record-close', wake: ['item.closed:completed_run'], stuck_owner: 'line-service' },
  unsupported: { consumer: null, wake: ['named original outcome required'], stuck_owner: 'project-supervisor' },
});

function open(s, kind, subject, e, data = {}) {
  const key = id(kind, ...subject);
  let row = s.obligations.get(key);
  if (!row) {
    const run = s.runs.get(e.run ?? (e.type === 'run.started' ? e.id : null));
    row = { id: key, kind, subject: copy(subject), source: ref(e), run: run?.id ?? e.run ?? null,
      item: e.item ?? run?.item ?? null, project: e.project ?? e.identity ?? e.common ?? run?.meta?.dispatch_project ?? null,
      started_seq: run?.started.seq ?? null, claim_generation: run?.owner_generation ?? null,
      ...copy(obligationKinds[kind]), supported: kind !== 'unsupported' && kind !== 'closeout-binding',
      outcome: null, ...copy(data) };
    s.obligations.set(key, row);
  }
  return row;
}
function finish(row, e, result, consumer = row?.consumer) {
  // First original result wins. Later observations never rewrite an attempt.
  if (row && !row.outcome) row.outcome = { ...ref(e), consumer, result: copy(result) };
}
function unique(rows, value, equal = same) { if (!rows.some(row => equal(row, value))) rows.push(copy(value)); }
function review(s, run, e) {
  return open(s, 'review-handoff', [run], { ...e, run }, { landings: [], reports: [], queues: [], diagnosis: null });
}
function reviewCoverage(row) {
  row.supported = true;
  row.diagnosis = null;
  for (const q of row.queues) {
    q.accepted = q.cap1 && commit(q.target?.head) && commit(q.target?.base) && q.source_item === row.item &&
      (!q.target.source_group?.run || q.target.source_group.run === row.run) &&
      (q.target.evidence_kind === 'native-landings/v1' || row.reports.some(report => report.sha256 && report.sha256 === q.target.reportHash));
    if (q.accepted) finish(row, q.source, { review_item: q.item, target: q.target });
  }
  const covered = landing => row.queues.some(q => q.accepted && q.commits.includes(landing.head));
  row.uncovered_heads = row.landings.filter(l => !covered(l)).map(l => l.head);
  // A report alone is retained as a prerequisite, never fabricated into a
  // landed target (or a claim that a source-free report needs a review).
  row.has_source_prerequisite = row.landings.length > 0;
  row.eligibility = row.landings.length ? 'original guarded queue-review must validate' : 'waiting for original landed source or no-source disposition';
  if (row.queues.length && !row.queues.some(q => q.accepted)) {
    row.supported = false;
    row.diagnosis = 'Original queue capture differs or is incomplete; preserve it for queue-review judgment.';
  }
  if (row.queues.length && row.uncovered_heads.length) row.diagnosis = 'Later or uncovered source retained; the original capture is immutable.';
  if (row.landings.some(l => row.project && l.project !== row.project)) {
    row.supported = false;
    row.diagnosis = 'Original project differs; retain source without admission.';
  }
}

function waitCoverage(row, e) {
  if (row.outcome) return;
  const producers = row.waiting?.producers ?? [];
  const complete = !row.waiting?.defect && producers.length > 0 && producers.every(p => {
    const statuses = row.statuses.filter(status => same(status.producer, p));
    // The existing native consumer can later record a disposition of the SAME
    // attempt (settled UNKNOWN or positively never started). Retain the failed
    // observation; only its latest exact complete status can release this wait.
    const current = p.kind === 'native-command' ? statuses.at(-1) : statuses.find(status => status.verified);
    return current?.verified && current.status === 'complete' &&
      (p.kind === 'native-command' || !statuses.some(status => status.status !== 'complete'));
  });
  row.supported = complete && row.parent_closeout?.completed === true;
  row.diagnosis = row.supported ? null : row.waiting?.defect ??
    'Existing closeoutWaitState owns producer validation; exact complete statuses and a completed parent closeout are required.';
  if (row.supported) finish(row, e, { statuses: row.statuses, parent_closeout: row.parent_closeout });
}

function sourceCompletionCoverage(s, row) {
  if (row.outcome) return;
  const closed = s.items.get(row.item)?.closed;
  row.supported = !closed;
  row.historical_close = copy(closed ?? null);
  row.diagnosis = closed ? 'Item already closed without an exact conditional completion for this run/report; historical or prose-only close is not inferred.' : null;
}

/** Called once per committed fact by the pure fold, AFTER ordinary subject
 * folding. No filesystem, model, native lookup, time, or external action here. */
export function applyObligationEvent(s, e) {
  const run = s.runs.get(e.run ?? (e.type === 'run.started' ? e.id : null));
  if (e.type === 'report.available') {
    open(s, 'report-intake', [e.run, e.sha256, e.claim_generation], e, {
      report: { sha256: e.sha256, file: e.file, started_seq: e.started_seq, claim_generation: e.claim_generation },
    });
  }
  if (e.type === 'report.ingested') {
    const intake = s.obligations.get(id('report-intake', e.run, e.sha256, run?.owner_generation));
    if (intake && intake.report.started_seq === run?.started.seq && (intake.report.file === e.file || intake.report.file === e.source)) {
      intake.supported = true; intake.diagnosis = null;
      finish(intake, e, { sha256: e.sha256, file: e.file, original_file: e.source ?? e.file, outcome: e.report?.outcome });
    }
    for (const row of s.obligations.values()) {
      if (row.kind === 'report-intake' && !row.outcome && row.run === e.run && row.report.sha256 !== e.sha256 &&
          row.report.started_seq === run?.started.seq && row.report.claim_generation === run?.owner_generation &&
          row.source.seq < e.seq && (row.report.file === e.file || row.report.file === e.source)) {
        row.supported = false;
        row.superseded_by = { ...ref(e), sha256: e.sha256 };
        row.diagnosis = 'Earlier report draft superseded by an ingest for the same run, start, claim and original file; original hash retained.';
      }
    }
    const r = review(s, e.run, e);
    unique(r.reports, { source: ref(e), sha256: e.sha256, file: e.file }, (a, b) => a.sha256 === b.sha256 && a.file === b.file);
    reviewCoverage(r);
    if (e.report?.outcome === 'done') sourceCompletionCoverage(s, open(s, 'source-completion', [e.run, e.sha256], e, {
      report: { sha256: e.sha256, file: e.file },
    }));
  }
  if (e.type === 'change.landed') {
    const r = review(s, e.run, e);
    unique(r.landings, { source: ref(e), project: e.project, head: e.head, base: e.base,
      binding: e.source ?? null, producer: e.producer ?? null }, (a, b) => a.project === b.project && a.head === b.head && a.base === b.base && same(a.binding, b.binding) && same(a.producer, b.producer));
    reviewCoverage(r);
  }
  if (e.type === 'item.added' && e.meta?.review_source_run) {
    const t = e.meta.review_target, r = review(s, e.meta.review_source_run, e);
    // This is an outcome of the EXISTING queue entry, never a second launch.
    const commits = t?.source_group?.owned_commits ?? t?.scope?.commits ?? (t?.head ? [t.head] : []);
    unique(r.queues, { source: ref(e), item: e.id, source_item: e.meta.review_source_item,
      cap1: e.meta.review_round_cap === 1, target: copy(t ?? null), commits }, (a, b) => a.item === b.item && same(a.target, b.target));
    reviewCoverage(r);
  }
  for (const target of e.closeout_targets ?? []) {
    open(s, 'closeout', [target.common, target.key, e.seq, e.type], { ...e, run: target.run }, {
      project: target.common, target: copy(target), target_source: { seq: e.seq, type: e.type },
    });
  }
  for (const error of e.closeout_binding_errors ?? []) {
    open(s, 'closeout-binding', [error.run ?? e.run, e.seq], { ...e, run: error.run ?? e.run }, {
      stuck_owner: error.owner ?? error.run ?? e.run, diagnosis: error.reason ?? error.code ?? 'Original binding unavailable', binding_error: copy(error),
    });
  }
  if (e.type === 'closeout.binding-kept') open(s, 'closeout-binding', [e.run, e.source?.seq], e, {
    stuck_owner: e.run, target_source: copy(e.source), diagnosis: e.reason ?? 'Original binding unavailable', condition: copy(e.condition ?? null),
  });
  if (e.type === 'closeout.evaluated') {
    const row = s.obligations.get(id('closeout', e.identity, e.key, e.source?.seq, e.source?.type));
    if (row) {
      row.observation = { ...ref(e), completed: e.completed, condition: copy(e.condition ?? null), resources: copy(e.resources ?? null) };
      if (e.completed === true) finish(row, e, { completed: true, resources: e.resources ?? null });
    }
    for (const wait of s.obligations.values()) {
      if (wait.kind !== 'closeout-wait' || wait.project !== e.identity || wait.target_key !== e.key || !same(wait.target_source, e.source)) continue;
      wait.parent_closeout = { ...ref(e), completed: e.completed };
      waitCoverage(wait, e);
    }
  }
  if (e.type === 'closeout.waiting') {
    const row = open(s, 'closeout-wait', [e.identity, e.key, e.wait_id], e, {
      target_source: copy(e.source), wait_id: e.wait_id, target_key: e.key,
      waiting: copy(e.waiting ?? null), revision: e.revision, statuses: [], supported: false,
      stuck_owner: e.waiting?.owner ?? e.run ?? 'project-supervisor',
    });
    const parent = s.obligations.get(id('closeout', e.identity, e.key, e.source?.seq, e.source?.type));
    if (parent?.observation) row.parent_closeout ??= copy(parent.observation);
    waitCoverage(row, e);
  }
  if (e.type === 'closeout.producer-status') {
    const row = s.obligations.get(id('closeout-wait', e.identity, e.key, e.wait_id));
    if (row && same(row.target_source, e.source) && row.waiting?.producers?.some(p => same(p, e.producer))) {
      const p = e.producer, r = s.runs.get(p.run);
      const reportVerified = p.kind === 'worker-report' && p.claim === r?.owner_generation &&
        e.completion?.type === 'report.ingested' && r?.report?.seq === e.completion.seq &&
        (row.revision === undefined || e.completion.seq > row.revision) &&
        (e.status === 'complete' ? r.report.outcome === 'done' : e.status === 'failed' && r.report.outcome !== 'done');
      // Consume the closer's recorded status, rather than implementing another
      // native validator/executor. The exact wait, descriptor, completion ref
      // and completed parent are required; UNKNOWN/refusal grants no replay.
      const closerRecorded = ['native-command', 'lane-removal'].includes(p.kind) &&
        (e.completion?.type === 'closeout.effect' || p.kind === 'native-command' &&
          ['closeout.exit-settled', 'closeout.command-not-started'].includes(e.completion?.type)) && Number.isSafeInteger(e.completion.seq) &&
        e.completion.seq > (row.revision ?? 0) && e.completion.seq < e.seq;
      unique(row.statuses, { source: ref(e), producer: p, status: e.status, completion: e.completion, verified: reportVerified || closerRecorded });
      // A linked status is a consumer's recorded observation, not permission
      // to repeat a command. Failures and UNKNOWN remain pending and visible.
      waitCoverage(row, e);
    }
  }
  if (e.type === 'closeout.wait-classified') {
    const row = s.obligations.get(id('closeout-wait', e.identity, e.key, e.wait_id));
    if (row && row.source.seq === e.wait_seq && same(row.target_source, e.source)) row.classification = copy(e);
  }
  const nativeActions = ['agent-exit-requested', 'shell-close-requested', 'workspace-close-requested', 'git-removal-started'];
  if (e.type === 'closeout.effect' && nativeActions.includes(e.outcome?.action)) {
    open(s, 'native-outcome', [e.identity, e.key, e.source, e.effect], e, {
      target_source: copy(e.source), attempt: e.effect, original: copy(e.outcome), supported: false,
      stuck_owner: e.run ?? 'project-supervisor', diagnosis: 'Original intent requires exact executor completion; absent/UNKNOWN is never replay authority.',
    });
  }
  if (e.intent && ['closeout.effect', 'closeout.command-failed', 'closeout.command-not-started', 'closeout.exit-settled'].includes(e.type)) {
    const row = s.obligations.get(id('native-outcome', e.identity, e.key, e.source, e.intent));
    if (row) {
      row.result_observation = { ...ref(e), outcome: copy(e.outcome ?? null), failure: copy(e.failure ?? null) };
      // Intents and refusals are retained even after their original result.
      // Physical completion still belongs to the separate closeout obligation.
      const o = row.original, result = e.type === 'closeout.command-failed' && e.failure?.kind === 'fence' ? 'refused' :
        e.type === 'closeout.command-not-started' && e.native_started === false ? 'never-started' :
        e.type === 'closeout.exit-settled' ? 'settled-UNKNOWN' :
        e.type === 'closeout.effect' && (o.action === 'agent-exit-requested' && e.outcome?.action === 'exit-observed' &&
          o.pane === e.outcome.pane && o.occupant?.[5] === e.outcome.occupant?.terminal_id && o.occupant?.[6] === e.outcome.occupant?.agent_session_id ||
          o.action === 'shell-close-requested' && e.outcome?.action === 'closed' && o.tab_id === e.outcome.tab_id ||
          o.action === 'workspace-close-requested' && e.outcome?.action === 'closed' && o.workspace_id === e.outcome.workspace_id)
          ? e.outcome.action : null;
      if (result) finish(row, e, { state: result, observation: row.result_observation });
    }
  }
  if (e.type === 'run.started' && e.meta?.dispatch_attempt) {
    open(s, 'dispatch-outcome', [e.id, e.meta.dispatch_attempt, e.meta.dispatch_journal], e, {
      attempt: e.meta.dispatch_attempt, journal: e.meta.dispatch_journal,
    });
  }
  if (e.type === 'dispatch.completed') {
    const row = s.obligations.get(id('dispatch-outcome', e.run, e.attempt, e.journal));
    if (row && row.project === e.project && row.item === e.item) finish(row, e, {
      exit_code: e.exit_code, stage: e.stage, request_sha256: e.request_sha256,
      native_launch_attempted: e.native_launch_attempted ?? null, failure: copy(e.failure ?? null),
    });
    if (e.exit_code !== 0 && e.native_launch_attempted === true) open(s, 'unsupported', ['dispatch-input', e.run, e.attempt, e.journal], e, {
      consumer: 'original-dispatch', stuck_owner: e.journal, attempt: e.attempt, journal: e.journal, original: copy(e),
      diagnosis: 'Original native dispatch returned unsuccessfully; its input outcome needs original-owner evidence. No replacement or replay.',
    });
  }
  if (e.type === 'item.closed' && e.completed_run) {
    const r = s.runs.get(e.completed_run), row = s.obligations.get(id('source-completion', e.completed_run, r?.report?.sha256));
    if (row && row.item === e.id && e.as === 'done') {
      row.supported = true; row.diagnosis = null;
      finish(row, e, { completed_run: e.completed_run, as: e.as });
    }
  }
  if (['item.closed', 'item.reopened'].includes(e.type)) {
    for (const row of s.obligations.values()) if (row.kind === 'source-completion' && row.item === e.id) sourceCompletionCoverage(s, row);
  }
  if ((/\.(waiting|requested)$/.test(e.type) && e.type !== 'closeout.waiting') || e.pending === true) {
    open(s, 'unsupported', [e.type, e.seq], e, {
      original: copy(e), diagnosis: 'No registered record consumer for this pending kind; original source retained.',
    });
  }
}

export const obligationPending = row => row.kind === 'review-handoff'
  ? row.uncovered_heads.length > 0 || !row.outcome
  : !row.outcome;

/** Observation only. A position/counter never acknowledges an obligation.
 * Source-to-observation is an upper bound including backlog/cache-build time,
 * not a claim of installed event-to-wake or native handoff latency. */
export function obligationInventory(state, { now = Date.now(), position = null, project } = {}) {
  const rows = [], counts = Object.fromEntries(Object.keys(obligationKinds).map(kind => [kind, { total: 0, pending: 0, supported: 0, unsupported: 0, oldest_ms: null }]));
  for (const original of state.obligations.values()) {
    if (project && original.project !== project) continue;
    const row = copy(original), elapsed = now - Date.parse(row.source.at);
    if (row.kind === 'review-handoff' && !row.landings.length && !row.outcome) {
      row.supported = false;
      row.diagnosis ??= 'No original landing or accepted capture: prerequisite-only, source eligibility unproven; no review launch inferred.';
    }
    row.pending = obligationPending(row);
    row.age_ms = Number.isFinite(elapsed) && elapsed >= 0 ? elapsed : null;
    row.event_to_observation_upper_bound_ms = row.age_ms;
    const resultElapsed = Date.parse(row.outcome?.at) - Date.parse(row.source.at);
    row.event_to_outcome_ms = Number.isFinite(resultElapsed) && resultElapsed >= 0 ? resultElapsed : null;
    const bucket = counts[row.kind]; bucket.total++;
    if (row.pending) { bucket.pending++; bucket[row.supported ? 'supported' : 'unsupported']++; if (row.age_ms !== null) bucket.oldest_ms = Math.max(bucket.oldest_ms ?? 0, row.age_ms); }
    rows.push(row);
  }
  return { schema: 'record-obligations/v1', observed_at: new Date(now).toISOString(), position, kinds: copy(obligationKinds), counts, rows,
    limits: 'Read-only source facts, not execution readiness. Saved file-only journals require their existing guarded owners; no absence, cursor, classification or UNKNOWN authorizes replay. Installed event-to-wake latency is unmeasured.' };
}
