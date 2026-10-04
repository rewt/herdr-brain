// Display-only chains derived from record facts and durable receipts. No Ink.
import { sanitize } from '../lib/text.mjs';

export const PIPELINE_MARKS = { done: '\u2713', running: '\u25cf', failed: '\u00d7', waiting: '\u25cb', skipped: '\u2013' };
const clean = value => sanitize(value ?? '');
const stamp = value => Date.parse(value);
export const pipelineSeconds = (start, finish) => {
  const a = stamp(start), b = stamp(finish);
  return Number.isFinite(a) && Number.isFinite(b) && b >= a ? (b - a) / 1000 : null;
};
export function pipelineDuration(link, now = Date.now()) {
  const seconds = Number.isFinite(link.duration_s) && link.duration_s >= 0 ? link.duration_s
    : pipelineSeconds(link.started_at, link.finished_at ?? (link.status === 'running' ? new Date(now).toISOString() : null));
  if (seconds === null) return 'unknown';
  if (seconds < 60) return `${Math.floor(seconds)}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${Math.floor(seconds % 60)}s`;
  return `${Math.floor(seconds / 3600)}h ${Math.floor(seconds % 3600 / 60)}m`;
}
const link = (id, label, status, evidence, timing = {}, detail = '') => ({ id, label: clean(label), status,
  open: evidence, ...timing, detail: clean(detail) });
const gateTiming = gate => ({ started_at: gate?.started_at, finished_at: gate?.finished_at,
  duration_s: gate?.duration_s });
const finishedGate = gate => Boolean(gate && (gate.finished_at || gate.exit_code != null || gate.error));

// Older receipts omit refusal phase. Use their explicit reason and checkpoints,
// keeping an unexplained refusal at the last evidenced phase.
function refusalStage(result, attempt) {
  const reason = result.reason ?? attempt?.error ?? '';
  if (/rebase|replay|merge driver|merge commits/i.test(reason)) return 'rebase';
  if (/validation|TEST_SLOT|preparation|scratch/i.test(reason) || result.gate?.exit_code != null && result.gate.exit_code !== 0) return 'ci';
  return result.gate?.exit_code === 0 || attempt?.phase === 'validated' || attempt?.gate?.exit_code === 0 ? 'fast-forward' : 'rebase';
}

export function batchPipeline({ batch, current, results = [], interrupted = false } = {}) {
  const attempt = batch?.attempts?.at(-1), gate = attempt?.gate;
  const phase = current?.phase === 'batching' ? batch?.phase : current?.phase ?? batch?.phase ?? attempt?.phase;
  const evidence = stage => ({ kind: 'batch-link', batch: batch?.id ?? current?.id, stage });
  const order = ['queued', 'rebase', 'ci', 'fast-forward', 'close', 'notify'];
  const links = order.map((id, i) => link(`batch:${id}`, ['Queued', 'Rebase', 'CI', 'Fast-forward', 'Close lanes', 'Notify'][i], 'waiting', evidence(id)));
  const get = id => links[order.indexOf(id)];
  const jobs = batch?.jobs ?? current?.jobs ?? [];
  const queued = jobs.map(j => j.queued).filter(t => Number.isFinite(stamp(t))).sort((a, b) => stamp(a) - stamp(b))[0];
  Object.assign(get('queued'), { status: batch?.started_at || attempt || results.length ? 'done' : 'waiting', started_at: queued, finished_at: batch?.started_at });
  const integrated = results.some(r => r.outcome === 'promoted') || Boolean(attempt?.integrated_at);
  const prepared = Boolean(gate || ['prepared', 'validated', 'red', 'integrated'].includes(attempt?.phase) || integrated);
  get('rebase').status = prepared ? 'done' : ['preparing', 'rebasing'].includes(phase) ? 'running' : 'waiting';
  if (gate) Object.assign(get('ci'), gateTiming(gate), { status: finishedGate(gate)
    ? gate.error || gate.exit_code !== 0 || gate.signal ? 'failed' : 'done' : phase === 'validating' && !interrupted ? 'running' : 'waiting',
    detail: gate.error ?? (gate.signal ? `Interrupted by ${gate.signal}` : '') });
  else if (phase === 'validating') get('ci').status = interrupted ? 'waiting' : 'running';
  get('fast-forward').status = integrated ? 'done' : phase === 'fast-forwarding' ? 'running' : 'waiting';
  // The train's "closing" checkpoint replaces lane tips. Actual close happens
  // in the queue, before its delivery receipt; don't equate integration to close.
  const promoted = results.filter(r => r.outcome === 'promoted');
  get('close').status = promoted.length && promoted.every(r => r.close_complete || r.finished || r.delivery_id) ? 'done'
    : integrated && ['closing', 'batch-delivering', 'completed'].includes(phase) ? 'running' : 'waiting';
  const warnings = promoted.flatMap(r => r.warnings ?? []).filter(w => !/^velocity record:/.test(w));
  if (warnings.length) Object.assign(get('close'), { status: 'failed', detail: warnings.join('; ') });
  const delivered = results.filter(r => r.finished || r.delivery_id);
  get('notify').status = results.length && delivered.length === results.length ? 'done'
    : ['batch-delivering', 'completed'].includes(phase) ? 'running' : 'waiting';
  const undelivered = delivered.filter(r => r.delivered === false || r.ok === false || r.pending || r.uncertain);
  if (undelivered.length) Object.assign(get('notify'), { status: 'failed', detail: 'Notice delivery pending or uncertain; inspect the notice journal.' });
  const refused = results.filter(r => r.outcome === 'refused');
  for (const result of refused) {
    const owner = batch?.attempts?.findLast(a => a.jobs?.some(j => j.id === result.id) || a.ids?.includes(result.id));
    const stage = refusalStage(result, owner), at = order.indexOf(stage);
    Object.assign(get(stage), { status: 'failed', detail: [get(stage).detail, `${result.topic ?? result.id ?? 'Lane'}: ${result.reason ?? 'refused'}`].filter(Boolean).join('; ') });
    if (!integrated && phase === 'complete') for (const id of order.slice(at + 1, 5)) if (get(id).status === 'waiting') get(id).status = 'skipped';
  }
  if (interrupted || current?.error || !current && results.some(r => r.outcome === 'interrupted') && !results.every(r => ['promoted', 'refused'].includes(r.outcome))) {
    const active = gate && !finishedGate(gate) ? get('ci')
      : links.slice(0, 5).find(l => l.status === 'running') ?? (prepared ? get('fast-forward') : get('rebase'));
    Object.assign(active, { status: 'failed', detail: 'Batch interrupted; inspect the receipt before resuming.' });
    // An interrupted link has no finish clock; never keep counting a dead gate.
  }
  return links;
}

const successor = saved => saved?.fixRun ?? saved?.result?.fix?.run ?? saved?.dispatch?.run;
export function lifecycleRuns(run, runs, settlements = new Map(), dispatches = new Map()) {
  if (!run) return [];
  const own = new Map(runs.filter(r => r.item === run.item).map(r => [r.id, r]));
  const parent = r => dispatches.get(r.id)?.fromRun ?? [...settlements].find(([, saved]) => successor(saved) === r.id)?.[0];
  let first = run; const visited = new Set([first.id]);
  while (own.has(parent(first)) && !visited.has(parent(first))) { first = own.get(parent(first)); visited.add(first.id); }
  const chain = []; visited.clear();
  for (let r = first; r && !visited.has(r.id);) {
    chain.push(r); visited.add(r.id);
    const next = successor(settlements.get(r.id)) ?? [...dispatches].find(([, saved]) => saved.fromRun === r.id)?.[0];
    r = own.get(next);
  }
  return chain;
}

export function runPipeline({ run, runs = [], settlements = new Map(), dispatches = new Map(), train = {}, candidates = [], identity } = {}) {
  const chain = lifecycleRuns(run, runs, settlements, dispatches), links = [];
  const evidence = (r, stage) => ({ kind: 'run-link', run: r.id, stage });
  for (const [i, r] of chain.entries()) {
    const saved = settlements.get(r.id), dispatch = dispatches.get(r.id);
    const sent = r.notes?.findLast(n => /^Dispatch: (?:prompt sent|caller accepted)/.test(n.text));
    if (!i) links.push(link(`run:${r.id}:dispatch`, 'Dispatch', dispatch && dispatch.stage !== 'complete' ? 'running' : 'done', evidence(r, 'dispatch'),
      { started_at: dispatch?.started_at, finished_at: dispatch?.finished_at ?? sent?.at }));
    const engineering = r.abandoned || r.report?.outcome === 'failed' ? 'failed' : r.report ? 'done' : dispatch && dispatch.stage !== 'complete' ? 'waiting' : 'running';
    links.push(link(`run:${r.id}:engineering`, i ? `Fix ${i} \u00b7 ${r.id}` : 'Engineering', engineering, evidence(r, 'engineering'),
      { started_at: sent?.at ?? r.started?.at, finished_at: r.report?.at ?? r.abandoned?.at }, r.abandoned ? 'Run abandoned' : ''));
    links.push(link(`run:${r.id}:report`, i ? `Report \u00b7 ${r.id}` : 'Report', r.report ? ['failed', 'blocked', 'needs_human'].includes(r.report.outcome) ? 'failed' : 'done'
      : r.abandoned ? 'skipped' : 'waiting', { kind: 'report', run: r.id }, {}, r.report && r.report.outcome !== 'done' ? r.report.outcome : ''));
    const verdict = saved?.review?.verdict;
    const reviewing = ['review', 'reviewing', 'commit-review'].includes(saved?.stage);
    links.push(link(`run:${r.id}:review`, i ? `Review ${i + 1}` : 'Review', verdict ? verdict === 'PASS' ? 'done' : 'failed'
      : reviewing ? 'running' : r.abandoned ? 'skipped' : 'waiting', evidence(r, 'review'), gateTiming(saved?.review),
      verdict ?? saved?.result?.reason ?? ''));
  }
  const final = chain.at(-1);
  if (!final) return links;
  const saved = settlements.get(final.id);
  const priorPromotion = train.results?.find(r => r.run === final.id || !r.run && saved?.finalHead && r.topic === saved.lane && r.source_head === saved.finalHead);
  const batch = train.batches?.find(b => b.id === train.current?.id && b.jobs?.some(j => j.run === final.id))
    ?? train.batches?.findLast(b => b.jobs?.some(j => j.run === final.id));
  const waiting = train.waiting?.find(j => j.run === final.id);
  const job = waiting ?? batch?.jobs?.find(j => j.run === final.id);
  const active = batch && train.current?.id === batch.id;
  const retrying = priorPromotion?.outcome !== 'promoted' && (active && batch.phase !== 'complete' || waiting && waiting.id !== priorPromotion?.id);
  const promotion = retrying ? null : priorPromotion;
  const trainStatus = promotion ? promotion.outcome === 'promoted' ? 'done' : 'failed' : final.abandoned ? 'skipped' : active ? 'running' : 'waiting';
  links.push(link(`run:${final.id}:train`, 'Train', trainStatus, promotion ? { kind: 'result', job: promotion.id }
    : waiting && !active ? { kind: 'queued', job: waiting.id, topic: waiting.topic } : batch ? { kind: 'batch', batch: batch.id }
      : job ? { kind: 'queued', job: job.id, topic: job.topic } : evidence(final, 'train'),
  { started_at: promotion?.queued ?? job?.queued, finished_at: promotion?.integrated_at ?? promotion?.finished }, promotion?.reason ?? ''));
  const landed = promotion?.outcome === 'promoted';
  links.push(link(`run:${final.id}:landed`, 'Landed', landed ? 'done' : ['failed', 'skipped'].includes(trainStatus) ? 'skipped' : 'waiting', evidence(final, 'landed')));
  // Candidate membership is an exact recorded commit, never a time/title guess.
  const candidate = landed && candidates.find(c => c.identity === identity && (c.commit === promotion.tip || c.commits?.includes(promotion.tip)));
  links.push(link(`run:${final.id}:candidate`, 'Release candidate', candidate?.gate ? candidate.gate.result === 'passed' ? 'done' : 'failed'
    : ['failed', 'skipped'].includes(trainStatus) ? 'skipped' : 'waiting',
    { ...evidence(final, 'candidate'), candidate: candidate?.id },
    { started_at: candidate?.started?.at, finished_at: candidate?.gate?.at }, candidate ? `${candidate.id}: ${candidate.gate?.result ?? 'Gate result not recorded'}` : ''));
  return links;
}
