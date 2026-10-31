// A finite, model-free join over the existing soak, lifecycle and saved audits.
// This module has no filesystem, clock, record writer or native executor.
import {evaluateSoak, digest} from './canary-soak.mjs';
import {timestamp} from './lifecycle.mjs';
import {canonical} from '../messages/schema.mjs';

export const duties = Array.from({length: 16}, (_, i) => `D${String(i + 1).padStart(2, '0')}`);
export const nudgeEntries = ['start', 'resume', 'prompt', 'retry', 'review-hand-filing', 'hand-close', 'hold-relay', 'recovery'];
const equal = (a, b) => canonical(a ?? null) === canonical(b ?? null);
const sha = s => typeof s === 'string' && /^[a-f0-9]{64}$/.test(s);
const named = s => typeof s === 'string' && s.trim().length > 0;

export function retirementCheckpoint(input) {
  return {schema: 'brain.retirement-checkpoint/v1', input_sha256: digest(canonical(input))};
}

export function evaluateRetirement(input, resume = null) {
  const {events, trial, manifest: m, observations: o, verifiedEvidence = [], soakEvidence = []} = input;
  if (m?.schema !== 'brain.retirement-input/v1') throw Error('unsupported retirement input schema');
  const checkpoint = retirementCheckpoint(input);
  if (resume && !equal(resume, checkpoint)) throw Error('resume input differs from immutable checkpoint');
  const soak = evaluateSoak({events, trial, verifiedEvidence: soakEvidence});
  const w = trial.window, issues = [], verified = new Set(verifiedEvidence);
  const add = (severity, code, reason) => issues.push({severity, code, reason});
  const missing = (code, reason) => add('INCONCLUSIVE', code, reason);
  const fail = (code, reason) => add('FAIL', code, reason);
  const proof = x => Array.isArray(x?.evidence) && x.evidence.length > 0 && x.evidence.every(id => verified.has(id));
  const need = (x, code) => { if (!proof(x)) missing(code, 'verified saved source evidence required'); };
  const exactWindow = x => x?.from === w.from && x?.cutoff === w.cutoff;
  const selected = events.filter(e => e.seq <= w.through_seq && (timestamp(e.at) === null || timestamp(e.at) <= timestamp(w.cutoff)));
  const event = seq => selected.find(e => e.seq === seq);
  const inWindow = at => timestamp(at) !== null && timestamp(at) >= timestamp(w.from) && timestamp(at) <= timestamp(w.cutoff);
  if (soak.status !== 'PASS') add(soak.status === 'FAIL' ? 'FAIL' : 'INCONCLUSIVE', 'soak', 'existing exact-candidate installed soak has not passed');
  if (m.project !== trial.project || !equal(m.window, w) || !equal(m.candidate, trial.candidate) ||
      !m.record?.path?.startsWith('/') || m.record.start_seq !== w.start_seq || m.record.through_seq !== w.through_seq ||
      m.record.events_sha256 !== soak.lifecycle.source.events_sha256 || !sha(m.configSha256) ||
      !verified.has(m.configEvidence) || m.evidence?.[m.configEvidence]?.sha256 !== m.configSha256)
    missing('scope', 'exact project, record digest/fences, candidate, configuration and interval required');
  if (timestamp(w.cutoff) - timestamp(w.from) < 90 * 60000) missing('duration', 'at least 90 minutes required');
  if (soak.lifecycle.source.missing_timestamp_seqs.some(seq => seq > w.start_seq)) missing('unknown-clock', 'undated events inside the interval remain unknown');

  const plan = m.plan, authority = event(plan?.authoritySeq);
  const scope = {project: m.project, record: m.record?.path, candidate: m.candidate, configSha256: m.configSha256, window: m.window, plan};
  need(o?.planning, 'planning-evidence');
  if (!Array.isArray(plan?.eligibleItems) || !plan.eligibleItems.length || new Set(plan.eligibleItems).size !== plan.eligibleItems.length ||
      !Array.isArray(plan?.normalOwners) || !plan.normalOwners.length || plan.normalOwners.some(x => !named(x)) || new Set(plan.normalOwners).size !== plan.normalOwners.length ||
      !named(plan?.authorityOwner) || !named(plan?.recoveryOwner) || !named(plan?.observerOwner) || !named(plan?.checkInRecord) ||
      timestamp(plan?.checkInAt) === null || timestamp(plan.checkInAt) < timestamp(w.cutoff) ||
      authority?.type !== 'note.added' || authority.decision !== true || authority.by !== plan.authorityOwner ||
      authority.seq > w.start_seq || timestamp(authority.at) === null || timestamp(authority.at) > timestamp(w.from) ||
      authority.text !== `Brain absence window authorized: ${digest(canonical(scope))}` ||
      o?.planning?.recoveryAccepted !== true || o.planning.observerIndependent !== true || o.planning.unitMixAccepted !== true)
    missing('planned-window', 'pre-window scoped authorization, genuine intended demand, accepted independent observer/recovery check-in and normal owner set required');

  // Reuse soak completion/receipt joins; corrections and observation runs cannot
  // inflate the ordinary-work denominator, even if the older soak counted them.
  const rows = soak.runs.map(row => {
    const item = selected.find(e => e.type === 'item.added' && e.id === row.item);
    const meta = Object.assign({}, item?.meta, ...selected.filter(e => e.type === 'item.updated' && e.id === row.item).map(e => e.fields?.meta));
    const kind = row.kind === 'review' ? 'review' : meta.review_fix_of ? 'fix' : row.observation?.retirementKind === 'observation' ? 'observation' : 'ordinary';
    if (kind === 'ordinary' && !plan?.eligibleItems?.includes(row.item)) missing('demand', `${row.run} is outside the planned eligible demand`);
    return {...row, retirementKind: kind};
  });
  const ordinary = rows.filter(r => r.retirementKind === 'ordinary' && r.counted);
  if (ordinary.length < 10) missing('ordinary-sample', `${ordinary.length}/10 genuine completed ordinary units; review/fix/observation runs separate`);

  const absence = o?.absence;
  need(absence, 'absence-evidence');
  if (!exactWindow(absence) || absence?.complete !== true || !Array.isArray(absence?.segments) || !absence.segments.length)
    missing('absence-coverage', 'interval native coverage required; endpoint snapshots alone cannot prove absence');
  let cursor = timestamp(w.from);
  for (const segment of absence?.segments ?? []) {
    need(segment, 'native-observation');
    if (timestamp(segment.from) !== cursor || timestamp(segment.cutoff) === null || timestamp(segment.cutoff) <= cursor ||
        timestamp(segment.cutoff) > timestamp(w.cutoff) || segment.nativeComplete !== true || !Array.isArray(segment.standingSessions))
      missing('native-coverage', 'ordered gap-free native observation coverage required');
    cursor = timestamp(segment.cutoff);
    if (segment.standingSessions?.length) missing('supervisor-present', 'idle, sleeping or paused standing supervisors are still present');
    if (!equal(segment.candidate, m.candidate) || segment.configSha256 !== m.configSha256) fail('runtime-drift', 'candidate/configuration changed; split the cohort');
  }
  if (cursor !== timestamp(w.cutoff)) missing('native-coverage', 'native observations do not cover the entire planned interval');

  const nudges = o?.nudges;
  need(nudges, 'nudge-evidence');
  if (nudges?.schema !== 'lifecycle.manual-nudge' || !exactWindow(nudges) || nudges.complete !== true || !Array.isArray(nudges.actions))
    missing('nudge-coverage', 'actual ENG-1140 schema and complete current interval capture required; journal silence is insufficient');
  for (const entry of nudgeEntries) {
    const capture = nudges?.entries?.[entry]; need(capture, 'nudge-entry');
    if (capture?.complete !== true || !exactWindow(capture)) missing('nudge-entry', `${entry} capture missing; future coverage cannot fill the interval`);
  }
  const explicit = selected.filter(e => e.type === 'lifecycle.manual-nudge' && e.project === trial.project &&
    (inWindow(e.occurred_at) || timestamp(e.occurred_at) === null && e.seq > w.start_seq));
  if (explicit.some(e => timestamp(e.occurred_at) === null)) missing('nudge-clock', 'nudge occurrence time unknown');
  if (explicit.length || soak.lifecycle.hand_nudges.recorded || nudges?.actions?.length) fail('manual-assistance', 'manual starts/resumes/prompts/retries/hand-filing/close/hold relays/recovery invalidate this interval');

  for (const field of ['effects', 'callbacks', 'obligations']) {
    need(o?.[field], `${field}-evidence`);
    if (o?.[field]?.complete !== true || !Array.isArray(o[field].rows)) missing(`${field}-coverage`, 'complete inventory including carry-in work required');
  }
  if (!Number.isSafeInteger(o?.effects?.lost) || !Number.isSafeInteger(o?.effects?.duplicates) || o.effects.lost < 0 || o.effects.duplicates < 0)
    missing('effects-counts', 'lost and duplicate effects stay unknown until observed');
  if (o?.effects?.lost > 0 || o?.effects?.duplicates > 0) fail('lost-duplicate', 'lost or duplicate effect retained');
  const projectRuns = new Set(selected.filter(e => e.type === 'run.started' && e.meta?.dispatch_project === trial.project).map(e => e.id));
  for (const e of selected.filter(e => e.seq > w.start_seq && (e.identity === trial.project || projectRuns.has(e.run)) && e.type === 'closeout.command-failed')) {
    if (e.failure?.kind === 'fence') fail('native-refusal', `original native refusal at ${e.seq} stops that effect`);
    else missing('unknown-native-effect', `original failed/UNKNOWN native attempt at ${e.seq} retained`);
  }
  for (const effect of o?.effects?.rows ?? []) {
    need(effect, 'effect-evidence');
    if (!named(effect.id) || !named(effect.owner) || !named(effect.next)) fail('unowned-effect', 'every original effect needs an owner and next event');
    if (effect.status !== 'done') missing('unresolved-effect', `${effect.id}: original ${effect.status ?? 'UNKNOWN'} retained; never reset or retried`);
  }
  for (const callback of o?.callbacks?.rows ?? []) {
    need(callback, 'callback-evidence');
    if (!named(callback.owner) || !named(callback.next)) fail('unowned-callback', 'original callback must retain its owner and next event');
    if (!['drained', 'handed-off'].includes(callback.disposition) || callback.disposition === 'handed-off' && callback.accepted !== true)
      missing('legacy-callback', 'legacy supervisor callback needs actual completion or supported accepted handoff; transport ACK alone is insufficient');
  }
  const checks = new Map((o?.checks ?? []).map(c => [c.id, c]));
  const check = id => {
    const c = checks.get(id); need(c, 'check-evidence');
    if (c?.status === 'FAIL') fail('failed-check', `original failed check ${id} retained`);
    if (c?.status !== 'PASS') missing('unrun-check', `${id ?? 'unnamed'} is unrun or unknown`);
    return c;
  };
  if (!checks.size || checks.size !== o?.checks?.length) missing('checks', 'unique named passing controls required; failures and unrun retained');
  for (const id of checks.keys()) check(id);
  for (const obligation of o?.obligations?.rows ?? []) {
    need(obligation, 'obligation-evidence');
    if (!named(obligation.owner) || !named(obligation.next)) fail('unowned-obligation', 'obligation has no actual owner/next event');
    if (obligation.severity?.toLowerCase() === 'major' && (obligation.status !== 'corrected' || !obligation.correctionChecks?.length)) missing('major', 'Major retains specific correction-check obligation');
    for (const id of obligation.correctionChecks ?? []) check(id);
    if (obligation.dangerous === true && obligation.status !== 'done' && obligation.status !== 'corrected') missing('dangerous-obligation', 'unsettled dangerous obligation retained');
  }
  const coverage = o?.duties ?? [];
  if (coverage.length !== duties.length || new Set(coverage.map(d => d.id)).size !== duties.length) missing('duties', 'exactly one row per D01–D16 required');
  for (const id of duties) {
    const d = coverage.find(d => d.id === id); need(d, 'duty-evidence');
    if (!named(d?.owner) || !plan?.normalOwners?.includes(d.owner)) fail('unowned-duty', `${id} lacks its planned normal owner`);
    if (!['live', 'scripted'].includes(d?.mode)) missing('unexercised-duty', `${id} remains ${d?.mode ?? 'unexercised'}`);
    if (['D03', 'D05', 'D07', 'D08', 'D11', 'D13', 'D15'].includes(id) && d?.mode !== 'live') missing('ordinary-duty', `${id} needs live coverage in this cohort`);
    check(d?.negative); check(d?.recovery);
    if (d?.mode === 'live' && !d.runs?.some(run => rows.some(r => r.run === run && !r.issues.length))) missing('live-duty', `${id} needs a completed cohort run`);
  }

  const handovers = o?.handovers ?? [], valid = [];
  for (const h of handovers) {
    const before = issues.length, from = rows.find(r => r.run === h.fromRun), to = rows.find(r => r.run === h.toRun);
    const oldSession = selected.find(e => e.type === 'run.session_bound' && e.run === h.fromRun);
    const newSession = selected.find(e => e.type === 'run.session_bound' && e.run === h.toRun);
    const report = event(h.reportSeq), cause = event(h.causeSeq);
    need(h, 'handover-evidence'); need(h.context, 'context-evidence');
    if (!from || !to || from.issues.length || to.issues.length || !named(oldSession?.session) || !named(newSession?.session) ||
        oldSession.session === newSession.session || !inWindow(newSession.prompted_at) ||
        selected.some(e => e.type === 'run.session_bound' && e.seq < newSession.seq && e.session === newSession.session) ||
        h.context?.recordOnly !== true || h.context.reportSha256 !== report?.sha256 || report?.type !== 'report.ingested' || report.run !== h.fromRun ||
        report.seq >= newSession?.seq || timestamp(report.at) === null || timestamp(report.at) > timestamp(newSession?.prompted_at))
      missing('fresh-handover', 'distinct fresh native owners must consume the original immutable report using record-only context');
    if (h.kind === 'producer-review') {
      const target = cause?.meta?.review_target;
      if (from?.retirementKind !== 'ordinary' || to?.retirementKind !== 'review' || cause?.type !== 'item.added' || cause.id !== to.item ||
          cause.meta?.review_source_run !== h.fromRun || target?.reportHash !== report?.sha256 || target?.head !== from?.observation?.source?.head ||
          cause.seq <= report?.seq || cause.seq >= to?.lifecycle?.start.seq) missing('review-handover', 'original queue target must bind the producer source/report before review starts');
    } else if (h.kind === 'next-work') {
      if (to?.retirementKind !== 'ordinary' || cause?.seq !== from?.lifecycle?.resources.folder.receipt?.seq ||
          timestamp(cause?.at) === null || timestamp(cause.at) > timestamp(newSession?.prompted_at) || h.context?.causal !== true)
        missing('next-handover', 'saved causal next-owner context and original cleanup receipt required');
    } else missing('handover-kind', 'producer-review or subsequent next-work handover required');
    if (issues.length === before) valid.push(h);
  }
  if (!valid.some(a => a.kind === 'producer-review' && valid.some(b => b.kind === 'next-work' && b.fromRun === a.toRun && b.toRun !== a.fromRun)))
    missing('handover-chain', 'two connected producer → fresh reviewer → subsequent owner/next-work handovers required');

  const status = issues.some(i => i.severity === 'FAIL') ? 'FAIL' : issues.length ? 'INCONCLUSIVE' : 'READY';
  return {schema: 'brain.retirement-coverage/v1', status, ready: status === 'READY', fixtureOnly: m.fixtureOnly === true, checkpoint,
    project: m.project, record: m.record, candidate: m.candidate, configSha256: m.configSha256, window: w,
    counts: {ordinary: ordinary.length, review: rows.filter(r => r.retirementKind === 'review').length,
      fix: rows.filter(r => r.retirementKind === 'fix').length, observation: rows.filter(r => r.retirementKind === 'observation').length, handovers: valid.length},
    duties: coverage, handovers, observations: o, soak, issues,
    nudgeCoverage: {recorded: explicit, current: nudges ?? null, historicalTotal: null, future: nudges?.future ?? null},
    recovery: {owner: plan?.recoveryOwner ?? null, next: status === 'READY' ? 'evidence only; actual retirement remains separately authorized' : 'record this interval and route to the accepted SR3 recovery owner through the original durable inbox',
      checkInAt: plan?.checkInAt ?? null, checkInRecord: plan?.checkInRecord ?? null},
    limits: ['Saved coverage assertions require their raw observations and owner review; hashes establish byte identity, not native authority.',
      'No HOLD clearing, UNKNOWN reset, native input, selection, scheduling, activation, retirement or BCH certification is performed.']};
}
