// Read-only assessment of saved evidence. No clock, record writer or executor.
import {createHash} from 'node:crypto';
import {measureLifecycle, distribution, timestamp} from './lifecycle.mjs';
import {canonical} from '../messages/schema.mjs';

export const digest = value => createHash('sha256').update(value).digest('hex');
const equal = (a, b) => canonical(a ?? null) === canonical(b ?? null);
const tupleKeys = ['root', 'commit', 'tree', 'manifestSha256', 'inventorySha256', 'node', 'protocol', 'configHome'];
const tuple = c => Object.fromEntries(tupleKeys.map(k => [k, c?.[k] ?? null]));
const same = (a, b) => equal(tuple(a), tuple(b));
const sha = s => typeof s === 'string' && /^[a-f0-9]{64}$/.test(s);
const commit = s => typeof s === 'string' && /^[a-f0-9]{40}$/.test(s);
const requiredCases = [...Array.from({length: 9}, (_, i) => `S${i}`), 'shared-observer'];

export function evaluateSoak({events, trial, verifiedEvidence = []}) {
  if (trial?.schema !== 'brain.canary-soak-input/v1') throw Error('unsupported soak input schema');
  const w = trial.window, c = trial.candidate;
  if (!w || !Number.isSafeInteger(w.start_seq) || !Number.isSafeInteger(w.through_seq) || w.start_seq < 0 || w.start_seq > w.through_seq)
    throw Error('explicit ordered start/end sequence fences required');
  const lifecycle = measureLifecycle({events, project: trial.project, from: w.from, cutoff: w.cutoff,
    throughSeq: w.through_seq, lineActors: trial.lineActors, handActors: trial.handActors});
  const selected = events.filter(e => e.seq <= w.through_seq && (timestamp(e.at) === null || timestamp(e.at) <= timestamp(w.cutoff)));
  const verified = new Set(verifiedEvidence), issues = [];
  const add = (severity, code, reason, run = null, owner = 'supervisor-herdr') => issues.push({severity, code, run, owner, reason});
  const missing = (code, reason, run) => add('INCOMPLETE', code, reason, run);
  const fail = (code, reason, run) => add('FAIL', code, reason, run);
  const proof = obj => Array.isArray(obj?.evidence) && obj.evidence.length > 0 && obj.evidence.every(id => verified.has(id));
  const need = (obj, code, run) => { if (!proof(obj)) missing(code, 'verified saved evidence required', run); };
  const inTime = at => timestamp(at) !== null && timestamp(at) >= timestamp(w.from) && timestamp(at) <= timestamp(w.cutoff);
  if (!c || !commit(c.commit) || !commit(c.tree) || !sha(c.manifestSha256) || !sha(c.inventorySha256) ||
      !c.root?.startsWith('/') || c.node?.version !== 'v20.19.4' || !c.node?.executable?.startsWith('/') || !c.protocol || !c.configHome)
    missing('candidate', 'complete exact installed candidate tuple required');

  const scripted = trial.scripted;
  need(scripted, 'scripted-evidence');
  if (scripted && !same(c, scripted.candidate)) fail('scripted-drift', 'scripted packet names a different candidate');
  if (scripted?.status === 'FAIL' || scripted?.failures?.length) fail('scripted-failure', 'original installed-canary failure is retained');
  if (scripted?.schema !== 'brain.installed-canary/v1' || scripted.status !== 'PASS' || scripted.fixtureOnly !== true || scripted.ready !== false ||
      !Array.isArray(scripted.failures) || !scripted.originalReview || scripted.reviewerSuites !== 0)
    missing('scripted', 'complete fixture-only installed canary packet required; synthetic READY never qualifies a real soak');
  for (const name of requiredCases) if (!(Array.isArray(scripted?.cases) ? scripted.status === 'PASS' && scripted.cases.includes(name) :
    ['PASS', 'observed assertions completed'].includes(scripted?.cases?.[name]?.status)))
    missing('scripted-case', `${name} has no completed passing outcome`);
  const landing = trial.landing;
  need(landing, 'landing-evidence');
  if (!landing?.candidate || !same(landing.candidate, c) || !landing.selection || !landing.checks?.length)
    missing('landing-checks', 'exact candidate landing-test selection and producer receipts required');
  for (const check of landing?.checks ?? []) {
    need(check, 'landing-receipt');
    if (!check.command || check.exitStatus !== 0 || check.nodeVersion !== 'v20.19.4' || check.appliesTo !== c?.commit)
      missing('landing-result', 'passing scoped producer check and explicit exact-candidate applicability required');
  }

  const p = trial.probation, a = p?.archive, scope = a?.scope;
  need(p, 'probation-evidence');
  const auth = selected.find(e => e.type === 'line-service.probation-authorized' && e.id === a?.id && e.project === trial.project);
  const note = selected.find(e => e.seq === a?.authority);
  if (!auth || !equal(auth.scope, scope) || !equal(auth.owner, a?.owner) || auth.authority !== a?.authority ||
      !p.evidence?.some(id => trial.evidence?.[id]?.sha256 === auth.archive?.sha256) ||
      a?.schema !== 'brain-probation/v1' || a.project !== trial.project || scope?.brain_common !== trial.project ||
      a?.owner?.native?.name !== 'supervisor-herdr' || note?.type !== 'note.added' || note.decision !== true ||
      note.by !== a?.owner?.native?.name || note.text !== `Brain probation authorized: ${digest(canonical(scope ?? {}))}` ||
      auth.seq > w.start_seq || timestamp(auth.at) === null || timestamp(auth.at) > timestamp(w.from))
    missing('authority', 'exact pre-window canonical-supervisor probation archive, event and decision required');
  const pc = scope?.candidate;
  if (pc && (pc.release?.root !== c?.root || pc.release?.commit !== c?.commit || pc.tree !== c?.tree || pc.manifest_sha256 !== c?.manifestSha256 ||
      pc.node?.version !== c?.node?.version || pc.node?.executable !== c?.node?.executable)) fail('probation-drift', 'probation tuple differs from installed candidate');
  const recovery = trial.recovery;
  need(recovery, 'recovery-evidence');
  if (!scope?.previous?.release?.root || recovery?.root !== scope.previous.release.root || recovery?.compatible !== true || recovery?.accepted !== true ||
      !a?.before?.installation || !a?.before?.plist) missing('rollback-root', 'compatible accepted installed previous root and original installation/plist required');
  if (selected.some(e => e.id === a?.id && ['line-service.probation-withdrawn', 'line-service.probation-completed'].includes(e.type) &&
      (timestamp(e.at) === null || timestamp(e.at) < timestamp(w.cutoff)))) missing('ended-trial', 'trial ended before the requested observation cutoff');

  const controller = trial.controller;
  need(controller, 'controller-evidence');
  if (!controller?.samples?.length || !controller.samples.some(s => s.at === w.from) || !controller.samples.some(s => s.at === w.cutoff))
    missing('controller-window', 'controller and new-admission provenance must fence the entire observation window');
  for (const s of controller?.samples ?? []) {
    need(s, 'controller-sample');
    if (!inTime(s.at)) missing('controller-time', 'controller sample outside cutoff');
    if (!same(s.candidate, c)) fail('controller-drift', 'controller runtime drift or development fallback');
    if (s.newAdmissions !== true) missing('controller-admission', 'candidate admission not observed');
  }
  const host = trial.host;
  need(host, 'host-evidence');
  if (!host?.samples?.some(s => s.at === w.from) || !host?.samples?.some(s => s.at === w.cutoff)) missing('host-window', 'host observations must fence the window');
  for (const s of host?.samples ?? []) {
    need(s, 'host-sample');
    if (!inTime(s.at) || !Number.isFinite(s.loadPerCore) || s.loadPerCore < 0 || !s.memoryPressure || !s.competingLoad || !s.herdrVersion)
      missing('host-observation', 'timestamp, load/core, memory pressure, competing load and native version required');
  }
  const ledger = trial.rescues;
  need(ledger, 'rescue-evidence');
  if (ledger?.complete !== true || ledger.from !== w.from || ledger.cutoff !== w.cutoff || !Array.isArray(ledger.actions))
    missing('rescue-coverage', 'complete all-run rescue ledger required; B4 explicit manual-assistance count alone is incomplete');
  if (ledger?.actions?.length || lifecycle.hand_nudges.recorded) fail('rescue', 'a rescue anywhere in the window prevents an offer');
  need(trial.safety, 'safety-evidence');
  if (trial.safety?.complete !== true || !Array.isArray(trial.safety?.violations)) missing('safety-coverage', 'all-run guard/callback/attempt audit required');
  if (trial.safety?.violations?.length) fail('safety', 'guard, callback, attempt or resource violation retained');

  // Never select ten fast successes. Every project start after the opening
  // fence is accounted for, including starts with unknown time/provenance.
  const starts = selected.filter(e => e.type === 'run.started' && e.meta?.dispatch_project === trial.project && e.seq > w.start_seq &&
    (timestamp(e.at) === null || timestamp(e.at) >= timestamp(w.from)));
  if (lifecycle.source.unscoped_starts_in_window.length) missing('unscoped-starts', 'projectless starts require reconciliation');
  const observations = trial.runs ?? [];
  if (new Set(observations.map(r => r.run)).size !== observations.length) throw Error('duplicate run observation');
  const rows = [], timing = {report_to_ingest: [], report_to_closed: [], report_to_folder_removed: [], report_to_session_release: [], eligible_free_to_input: []};
  for (const start of starts) {
    const id = start.id, o = observations.find(r => r.run === id), b = lifecycle.runs.find(r => r.run === id);
    const beforeIssues = issues.length;
    const history = selected.filter(e => (e.run ?? e.id) === id);
    const claim = history.find(e => e.type === 'run.claimed');
    const item = selected.find(e => e.type === 'item.added' && e.id === start.item);
    const kind = item?.role === 'review' || start.item?.startsWith('REV-') ? 'review' : 'ordinary';
    if (timestamp(start.at) === null) missing('start-time', 'start timestamp unknown', id);
    need(o, 'run-evidence', id);
    if (!b || !o || o.startedSeq !== start.seq || o.claimGeneration !== claim?.seq) missing('run-binding', 'exact start/claim observation required', id);
    if (o?.kind !== kind) missing('run-kind', 'ordinary/review classification disagrees with record', id);
    if (claim?.owner?.release?.root && claim.owner.release.root !== c?.root) fail('claim-drift', 'new claim captured another runtime', id);
    for (const name of ['controller', 'worker', 'watcher']) {
      const r = o?.runtime?.[name]; need(r, `${name}-evidence`, id);
      if (!r?.candidate) missing(`${name}-tuple`, 'captured full candidate tuple required', id);
      else if (!same(r.candidate, c)) fail(`${name}-drift`, 'captured runtime differs from candidate', id);
    }
    if (b?.initiation !== 'line' || !b.session_bound || !b.dispatch) missing('ordinary-start', 'line initiation, dispatch and native session binding required', id);
    const ingests = history.filter(e => e.type === 'report.ingested');
    if (ingests.length > 1 || history.filter(e => e.type === 'run.session_bound').length > 1) fail('duplicate', 'duplicate ingestion or native binding', id);
    if (history.some(e => e.type === 'run.abandoned') || ingests.some(e => e.report?.outcome === 'failed')) fail('failed-unit', 'failed or abandoned candidate run', id);
    if (ingests.length !== 1 || ingests[0]?.report?.outcome !== 'done' || !b?.item_closed) missing('completion', 'successful report and explicitly run-attributed item close required', id);
    if (o?.useful !== true && kind === 'ordinary') missing('useful-work', 'genuine selected ordinary work required', id);
    for (const name of ['session', 'tab', 'folder']) if (b?.resources[name]?.state !== 'retired') missing('retirement', `${name} not proven retired`, id);
    need(o?.physical, 'physical-evidence', id);
    for (const name of ['session', 'tab', 'folder']) if (!o?.physical?.before?.[name] || o?.physical?.after?.[name] !== 'absent')
      missing('physical-observation', `${name} before identity and after absence required, separate from retirement receipts`, id);
    const sessionBinding = history.find(e => e.type === 'run.session_bound');
    const sessionEffect = history.find(e => e.seq === b?.resources.session.receipt?.seq);
    if (o?.physical?.before?.folder !== start.workspace || o?.physical?.before?.session !== sessionBinding?.session ||
        !sessionEffect?.outcome?.tab_id || o?.physical?.before?.tab !== sessionEffect.outcome.tab_id)
      missing('physical-binding', 'physical observations must match the actual workspace, native session and retired tab', id);
    need(o?.turns, 'turn-evidence', id);
    if (!o?.turns?.close || o.turns.close !== o.turns.session || o.turns.close !== o.turns.folder) missing('finite-turn', 'close/release/remove must share the same finite closeout turn', id);
    for (const key of ['report_to_ingest', 'report_to_closed', 'report_to_folder_removed']) timing[key].push(b?.latency[key]?.ms ?? null);
    const sessionAt = timestamp(b?.resources.session.receipt?.at), reportAt = timestamp(b?.report?.observed_at);
    const sessionMs = sessionAt !== null && reportAt !== null && sessionAt >= reportAt ? sessionAt - reportAt : null;
    timing.report_to_session_release.push(sessionMs);
    need(o?.queue, 'queue-evidence', id);
    const eligible = timestamp(o?.queue?.eligibleAt), free = timestamp(o?.queue?.freeAt), input = timestamp(o?.queue?.inputAt);
    const queueMs = eligible !== null && free !== null && input !== null && input >= Math.max(eligible, free) && inTime(o.queue.inputAt) &&
      o.queue.inputAt === sessionBinding?.prompted_at ? input - Math.max(eligible, free) : null;
    timing.eligible_free_to_input.push(queueMs);
    const spans = {...b?.latency, report_to_session_release: {ms: sessionMs}, eligible_free_to_input: {ms: queueMs}};
    for (const [key, span] of Object.entries(spans)) {
      if (span.ms === null) missing('timing-unknown', `${key} unknown`, id);
      else if (span.ms > (key === 'report_to_ingest' ? 60000 : 120000)) {
        if (host?.contaminated === true) missing('load-threshold', `${key} misses planning target under documented load`, id);
        else fail('latency', `${key} exceeds planning target`, id);
      }
    }
    const review = o?.review;
    if (kind === 'ordinary' && (o?.source || review?.required !== false)) {
      need(review, 'original-review-evidence', id);
      if (!review?.run || review.original !== true || review.cap !== 1 || review.suites !== 0) missing('original-review', 'one original cap1 review with zero suites required', id);
    } else if (kind === 'review') {
      need(review, 'review-evidence', id);
      if (review?.cap !== 1 || review?.suites !== 0 || review?.original !== true || !['PASS', 'pass'].includes(ingests[0]?.report?.extra?.verdict))
        missing('review-verdict', 'original cap1/zero-suite passing review or specific checked corrections required', id);
    }
    need(o?.shared, 'shared-evidence', id);
    if (o?.shared?.mode !== 'shared' || o.shared.perRunWatcherRssBytes !== 0 || !Number.isFinite(o.shared.hostRssBytes) || o.shared.hostRssBytes <= 0 ||
        !Number.isFinite(o.shared.noticeLatencyMs) || o.shared.noticeLatencyMs < 0 || !Number.isInteger(o.shared.expectedNotices) || o.shared.expectedNotices < 1 ||
        o.shared.deliveredNotices !== o.shared.expectedNotices || o.shared.duplicates !== 0)
      missing('shared-observer', 'shared mode memory, notice latency, delivery count and dedupe observations required', id);
    if (o?.shared?.duplicates > 0) fail('shared-duplicate', 'duplicate shared observer delivery', id);
    const source = o?.source;
    if (source && (!commit(source.base) || !commit(source.head) || source.base === source.head || !proof(source))) missing('source-unit', 'immutable owned source range and landing proof required', id);
    rows.push({run: id, item: start.item, kind, counted: issues.length === beforeIssues && kind === 'ordinary', source: Boolean(source),
      lifecycle: b ?? null, observation: o ?? null, issues: issues.slice(beforeIssues)});
  }
  for (const row of rows.filter(r => r.kind === 'ordinary' && (r.source || r.observation?.review?.required !== false))) if (!rows.some(r => r.kind === 'review' && r.run === row.observation?.review?.run && !r.issues.length))
    missing('pending-review', 'linked original review must finish and retire by cutoff', row.run);
  const ordinary = rows.filter(r => r.kind === 'ordinary'), counted = ordinary.filter(r => r.counted);
  if (counted.length < 10) missing('sample', `${counted.length}/10 complete useful ordinary units`);
  if (counted.filter(r => r.source).length < 3) missing('source-sample', 'at least three completed source units required');
  if (timestamp(w.cutoff) - timestamp(w.from) < 90 * 60000) missing('duration', 'at least 90 minutes required');
  const links = new Map();
  for (const row of ordinary) {
    const q = row.observation?.queue, previous = ordinary.find(r => r.run === q?.freedBy);
    if (!previous || !row.counted || !previous.counted) continue;
    const removed = timestamp(previous.lifecycle?.resources.folder.receipt?.at), free = timestamp(q.freeAt);
    need(q, 'turnover-evidence', row.run);
    if (removed !== null && free !== null && removed <= free && timestamp(previous.lifecycle?.start.at) < timestamp(row.lifecycle?.start.at)) links.set(row.run, previous.run);
  }
  if (![...links.values()].some(id => links.has(id))) missing('turnover', 'two successive ordinary starts causally using retired candidate capacity required');
  if (trial.corrections?.complete !== true || trial.corrections?.pending?.length || !proof(trial.corrections)) missing('corrections', 'all required corrections need specific producer checks');
  const status = issues.some(i => i.severity === 'FAIL') ? 'FAIL' : issues.length ? 'INCOMPLETE' : 'PASS';
  const scriptedStatus = issues.some(i => i.code.startsWith('scripted') && i.severity === 'FAIL') ? 'FAIL' :
    issues.some(i => i.code.startsWith('scripted')) ? 'INCOMPLETE' : 'PASS';
  const realIssues = issues.filter(i => !i.code.startsWith('scripted') && !i.code.startsWith('landing'));
  const realStatus = !starts.length ? 'UNRUN' : realIssues.some(i => i.severity === 'FAIL') ? 'FAIL' : realIssues.length ? 'INCOMPLETE' : 'PASS';
  const shared = rows.map(r => r.observation?.shared);
  const noticeMs = shared.map(s => Number.isFinite(s?.noticeLatencyMs) ? s.noticeLatencyMs : null);
  return {schema: 'brain.canary-soak/v1', status, offerEligible: status === 'PASS', candidate: c, window: w,
    inputs: {trial_sha256: digest(canonical(trial)), events: lifecycle.source, verifiedEvidence: [...verified].sort()},
    layers: {scripted: scriptedStatus, real: realStatus, stable: trial.stable ?? {liveAcceptance: 'UNRUN', fullSuite: 'UNRUN'}},
    counts: {all_started: rows.length, ordinary: ordinary.length, reviews: rows.length - ordinary.length, completed_ordinary: counted.length,
      source_units: counted.filter(r => r.source).length, turnover_links: Object.fromEntries(links)},
    latency: Object.fromEntries(Object.entries(timing).map(([k, values]) => [k, {...distribution(values), max_ms: values.some(v => v !== null) ? Math.max(...values.filter(v => v !== null)) : null}])),
    shared: {covered_runs: shared.filter(s => proof(s)).length, notice_latency: {...distribution(noticeMs), max_ms: noticeMs.some(v => v !== null) ? Math.max(...noticeMs.filter(v => v !== null)) : null},
      memory: shared.map((s, i) => ({run: rows[i].run, host_rss_bytes: s?.hostRssBytes ?? null, per_run_watcher_rss_bytes: s?.perRunWatcherRssBytes ?? null})),
      duplicates: shared.every(s => Number.isInteger(s?.duplicates)) ? shared.reduce((n, s) => n + s.duplicates, 0) : null},
    issues, runs: rows, lifecycle, disposition: status === 'FAIL' ? 'WITHHOLD; canonical supervisor contains admissions and owns archived runtime rollback' :
      status === 'PASS' ? 'OFFER EVIDENCE ONLY; release coordinator and consumer owner retain live, Major and activation authority' : 'WITHHOLD; retain pending evidence and owners',
    limits: ['Saved observations are evidence, not native authority.', 'Full-suite evidence is non-blocking background information under HUM-43.',
      'No publication, READY, consumer consent, pin change, scheduler, withdrawal or rollback is performed.']};
}
