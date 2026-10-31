// A historical projection only: no record writer, native executor, model or clock.
import {createHash} from 'node:crypto';

export const timestamp = value => typeof value === 'string' && /T.*(?:Z|[+-]\d\d:\d\d)$/.test(value) && Number.isFinite(Date.parse(value)) ? Date.parse(value) : null;
const hash = value => createHash('sha256').update(value).digest('hex');
const ref = e => e ? {seq: e.seq, type: e.type, at: e.at ?? null} : null;
const sourceEqual = (a, b) => a?.seq === b?.seq && a?.type === b?.type;
const count = (rows, key) => Object.fromEntries([...new Set(rows.map(key))].sort().map(k => [k, rows.filter(r => key(r) === k).length]));
const inWindow = (e, from, cutoff) => timestamp(e?.at) !== null && timestamp(e.at) >= from && timestamp(e.at) <= cutoff;

export function distribution(values) {
  const known = values.filter(v => v !== null).sort((a, b) => a - b), n = known.length;
  return {count: values.length, known: n, unknown: values.length - n,
    median_ms: n ? (known[Math.floor((n - 1) / 2)] + known[Math.floor(n / 2)]) / 2 : null,
    p90_ms: n ? known[Math.ceil(n * .9) - 1] : null};
}

function latency(origin, end) {
  if (!origin) return {ms: null, reason: 'report timestamp unknown'};
  if (!end) return {ms: null, reason: 'completion not recorded by cutoff'};
  const a = timestamp(origin.observed_at), b = timestamp(end.at);
  if (a === null || b === null) return {ms: null, reason: 'timestamp unknown'};
  return b >= a ? {ms: b - a, reason: null} : {ms: null, reason: 'completion precedes report observation'};
}

// Observation is evidence of presence/absence at its saved time, never of a
// retirement action or its time. In particular no worktree-list absence proof.
function observation(census, binding, cwd) {
  if (!census) return null;
  const inv = census.inventory, native = inv.coverage?.native === true;
  const session = binding.agent_session_id ?? binding.agent_session?.value;
  const agents = inv.agents ?? [], panes = inv.panes ?? [];
  return {at: census.observed_at,
    session: !native || !session ? 'unknown' : agents.some(a => a.agent_session?.value === session) ? 'present' : 'absent',
    tab: !native || !binding.tab ? 'unknown' : panes.some(p => p.tab_id === binding.tab) ? 'present' : 'absent',
    folder: !cwd || inv.coverage?.git !== true ? 'unknown' :
      inv.folders?.find(f => f.cwd === cwd)?.present === true ? 'present' :
      inv.folders?.find(f => f.cwd === cwd)?.present === false ? 'absent' : 'unknown'};
}

export function measureLifecycle({events, project, from, cutoff, throughSeq, lineActors = ['line-service'], handActors = [], census = null}) {
  const startTime = timestamp(from), endTime = timestamp(cutoff);
  if (startTime === null || endTime === null || startTime > endTime) throw Error('from/cutoff must be ordered timestamps with timezone');
  if (typeof project !== 'string' || !project) throw Error('project common-directory identity is required');
  if (lineActors.some(a => handActors.includes(a))) throw Error('line and hand actor sets overlap');
  if (events.some((e, i) => !Number.isSafeInteger(e.seq) || e.seq < 1 || i && e.seq <= events[i - 1].seq)) throw Error('event sequence must be positive and strictly increasing');
  const max = events.filter(e => timestamp(e.at) !== null && timestamp(e.at) <= endTime).at(-1)?.seq ?? 0;
  const fence = throughSeq ?? max;
  if (!Number.isSafeInteger(fence) || fence < 0) throw Error('through-seq must be a nonnegative integer');
  if (fence && !events.some(e => e.seq === fence)) throw Error('through-seq is not present in input');
  // Keep undated events inside the sequence fence for joins and diagnostics.
  const selected = events.filter(e => e.seq <= fence && (timestamp(e.at) === null || timestamp(e.at) <= endTime));
  if (census && (census.project !== project || timestamp(census.observed_at) === null || timestamp(census.observed_at) > endTime || census.cutoff?.seq > fence)) throw Error('census project/time/sequence is outside measurement scope');
  const starts = selected.filter(e => e.type === 'run.started' && e.meta?.dispatch_project === project);
  const runIds = new Set(starts.map(e => e.id));
  const scoped = selected.filter(e => runIds.has(e.run ?? e.id));
  const histories = new Map(), closures = new Map();
  for (const e of scoped) {const id = e.run ?? e.id; if (!histories.has(id)) histories.set(id, []); histories.get(id).push(e);}
  for (const e of selected) if (e.type === 'item.closed' && e.completed_run && e.as === 'done') {
    const key = JSON.stringify([e.id, e.completed_run]); if (!closures.has(key)) closures.set(key, e);
  }
  const rows = [];
  for (const start of starts) {
    const history = histories.get(start.id) ?? [];
    const ingested = history.find(e => e.type === 'report.ingested');
    const availability = history.filter(e => e.type === 'report.available' && e.project === project && e.started_seq === start.seq &&
      history.some(c => c.type === 'run.claimed' && c.seq === e.claim_generation && c.seq < e.seq) &&
      e.producer === 'original-report-watcher' && (timestamp(e.observed_at) === null || timestamp(e.observed_at) <= endTime) &&
      (!ingested || e.seq < ingested.seq && e.sha256 === ingested.sha256));
    const report = availability[0];
    const reportInWindow = inWindow(report ? {at: report.observed_at ?? report.at} : null, startTime, endTime) || inWindow(ingested, startTime, endTime);
    if (!inWindow(start, startTime, endTime) && !reportInWindow) continue;
    const close = closures.get(JSON.stringify([start.item, start.id]));
    // Match cleanup to the exact immutable report source, allocation key and
    // actual effect receipt. Repeated evaluations cannot multiply a completion.
    const evaluations = history.filter(e => e.type === 'closeout.evaluated' && e.identity === project &&
      ingested && sourceEqual(e.source, {seq: ingested.seq, type: ingested.type}));
    const effects = history.filter(e => e.type === 'closeout.effect' && e.identity === project &&
      ingested && sourceEqual(e.source, {seq: ingested.seq, type: ingested.type}));
    const verified = (name, statuses, actions) => {
      for (const evaluation of evaluations) {
        const resource = evaluation.resources?.[name];
        if (!statuses.includes(resource?.status)) continue;
        for (const r of [...(resource.receipts ?? []), ...(resource.receipt ? [resource.receipt] : [])]) {
          const effect = effects.find(e => e.seq === r.seq && e.effect === r.effect && e.seq < evaluation.seq && e.key === evaluation.key && actions.includes(e.outcome?.action));
          if (effect) return effect;
        }
      }
      return null;
    };
    const session = verified('session', ['closed'], ['closed']);
    const folder = verified('folder', ['removed'], ['worktree-removed', 'lane-removed']);
    const tab = session?.outcome.tab_id ? session : null;
    const last = evaluations.at(-1);
    let binding = {...start.meta};
    for (const e of history) if (e.type === 'run.updated') binding = {...binding, ...e.meta};
    const worker = history.findLast(e => e.type === 'run.session_bound');
    binding.agent_session_id = worker?.session ?? binding.agent_session_id;
    // Pane and tab counters need not agree. Only an actual tab receipt or census
    // pane-to-tab relation may supply the tab identity.
    binding.tab = tab?.outcome.tab_id ?? census?.inventory.panes?.find(p => p.pane_id === binding.pane && p.terminal_id === binding.terminal_id)?.tab_id ?? null;
    const resources = {};
    for (const [name, completion] of [['session', session], ['tab', tab], ['folder', folder]]) {
      const held = last?.resources?.[name === 'tab' ? 'session' : name];
      resources[name] = completion ? {state: 'retired', receipt: ref(completion), owner: null, reason: null} : {
        state: held?.status === 'kept' ? 'pending' : 'unknown', receipt: null,
        owner: held?.owner ?? last?.owner ?? null,
        reason: held?.reason ?? last?.reason ?? 'no linked retirement receipt or explicit hold'};
    }
    const actor = start.by ?? null;
    rows.push({run: start.id, item: start.item, start: ref(start), start_in_window: inWindow(start, startTime, endTime),
      initiation: lineActors.includes(actor) ? 'line' : handActors.includes(actor) ? 'hand' : 'unknown', actor,
      report_in_window: reportInWindow, report: report ? {...ref(report), observed_at: report.observed_at ?? null, sha256: report.sha256} : null,
      ingest: ref(ingested), item_closed: ref(close),
      latency: {report_to_ingest: latency(report, ingested), report_to_closed: latency(report, close), report_to_folder_removed: latency(report, folder)},
      resources, observation: observation(census, binding, start.workspace),
      dispatch: ref(history.find(e => e.type === 'dispatch.completed')), session_bound: Boolean(worker),
      abandoned: ref(history.find(e => e.type === 'run.abandoned')),
      pending_owner: last?.owner ?? null, pending_reason: last?.reason ?? (ingested ? 'no closeout evaluation' : 'report not ingested'),
      evaluation: ref(last)});
  }
  const reportRows = rows.filter(r => r.report_in_window), startRows = rows.filter(r => r.start_in_window);
  const manual = scoped.filter(e => e.type === 'closeout.manual-assistance' && inWindow(e, startTime, endTime) ||
    e.type === 'lifecycle.manual-nudge' && e.project === project && inWindow({at: e.occurred_at}, startTime, endTime));
  const lifecycle = Object.fromEntries(['session', 'tab', 'folder'].map(name => [name, {retired: 0, pending: 0, unknown: 0, ...count(reportRows, r => r.resources[name].state)}]));
  const pending = reportRows.flatMap(r => Object.entries(r.resources).filter(([, resource]) => resource.state !== 'retired').map(([resource, state]) =>
    ({run: r.run, item: r.item, resource, ...state})));
  const groups = new Map();
  for (const p of pending) {const key = JSON.stringify([p.state, p.owner, p.reason]); if (!groups.has(key)) groups.set(key, {state: p.state, owner: p.owner, reason: p.reason, count: 0}); groups.get(key).count++;}
  return {schema: 'consumer-lifecycle/v1', project, window: {from, cutoff, through_seq: fence},
    source: {events_sha256: hash(JSON.stringify(selected)), events: selected.length, first_seq: selected[0]?.seq ?? null,
      missing_timestamp_seqs: selected.filter(e => timestamp(e.at) === null).map(e => e.seq),
      unscoped_starts_in_window: selected.filter(e => e.type === 'run.started' && !e.meta?.dispatch_project && inWindow(e, startTime, endTime)).map(e => e.seq)},
    census: census ? {observed_at: census.observed_at, cutoff: census.cutoff, inventory_sha256: hash(JSON.stringify(census.inventory)), coverage: census.inventory.coverage} : null,
    counts: {starts: startRows.length, starts_by_initiator: count(startRows, r => r.initiation), starts_by_actor: count(startRows, r => r.actor ?? 'unknown'),
      session_bound_starts: startRows.filter(r => r.session_bound).length,
      reports_ingested: scoped.filter(e => e.type === 'report.ingested' && inWindow(e, startTime, endTime)).length,
      report_cohort: reportRows.length, lifecycle},
    latency: Object.fromEntries(['report_to_ingest', 'report_to_closed', 'report_to_folder_removed'].map(k => [k, distribution(reportRows.map(r => r.latency[k].ms))])),
    hand_nudges: {recorded: manual.length, total: null, coverage: 'unknown: only explicit closeout.manual-assistance and lifecycle.manual-nudge events are counted; free-text notes and native prompts are not a complete nudge journal', receipts: manual.map(ref),
      journal: manual.filter(e => e.type === 'lifecycle.manual-nudge').map(e => ({...ref(e), id: e.nudge_id, run: e.run, item: e.item,
        project: e.project, actor: e.actor, recorded_by: e.by, occurred_at: e.occurred_at, stage: e.stage, action: e.action, reason: e.reason, evidence: e.evidence}))},
    pending_by_owner_reason: [...groups.values()], pending, runs: rows};
}
