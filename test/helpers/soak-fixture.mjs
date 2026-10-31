import {digest} from '../../measurement/canary-soak.mjs';
import {canonical} from '../../messages/schema.mjs';

export const project = '/fixture/brain/.git', from = '2026-10-30T12:00:00.000Z', cutoff = '2026-10-30T13:30:00.000Z';
export const at = seconds => new Date(Date.parse(from) + seconds * 1000).toISOString();
export const proof = extra => ({evidence: ['saved'], ...extra});
export function fixture({order = Array.from({length: 13}, (_, i) => i + 1)} = {}) {
  const candidate = {root: '/installed/exact', commit: 'a'.repeat(40), tree: 'b'.repeat(40), manifestSha256: 'c'.repeat(64),
    inventorySha256: 'd'.repeat(64), node: {executable: '/node20', version: 'v20.19.4'}, protocol: 1, configHome: 1};
  const scope = {brain_common: project, candidate: {release: {root: candidate.root, commit: candidate.commit}, tree: candidate.tree,
    manifest_sha256: candidate.manifestSha256, node: candidate.node}, previous: {release: {root: '/installed/previous'}}};
  const owner = {native: {name: 'supervisor-herdr'}};
  const events = [
    {seq: 1, at: at(-2), type: 'note.added', id: 'ENG-trial', by: 'supervisor-herdr', decision: true, text: `Brain probation authorized: ${digest(canonical(scope))}`},
    {seq: 2, at: at(-1), type: 'line-service.probation-authorized', id: 'trial-one', project, scope, owner, authority: 1, archive: {sha256: 'e'.repeat(64)}}
  ];
  const runs = [], bindings = [];
  function unit(i, review = false) {
    const run = `R-${i}`, item = review ? `REV-${i}` : `ENG-${i}`, t = (order.indexOf(i) + 1) * 120;
    const start = {at: at(t), type: 'run.started', id: run, item, workspace: `/lane/${run}`, by: 'line-service', meta: {dispatch_project: project}};
    const claim = {at: at(t + 1), type: 'run.claimed', run, owner: {release: {root: candidate.root}}};
    const report = {at: at(t + 20), type: 'report.available', run, project, producer: 'original-report-watcher', observed_at: at(t + 20), sha256: run};
    const ingest = {at: at(t + 22), type: 'report.ingested', run, sha256: run, report: {outcome: 'done', extra: review ? {verdict: 'PASS'} : {}}};
    const session = {at: at(t + 24), type: 'closeout.effect', run, identity: project, key: run, effect: 'session', outcome: {action: 'closed', tab_id: `tab-${run}`}};
    const folder = {at: at(t + 25), type: 'closeout.effect', run, identity: project, key: run, effect: 'folder', outcome: {action: 'worktree-removed'}};
    const evaluation = {at: at(t + 26), type: 'closeout.evaluated', run, identity: project, key: run};
    events.push({at: at(t - 2), type: 'item.added', id: item, role: review ? 'review' : 'engineer'}, start, claim,
      {at: at(t + 3), type: 'dispatch.completed', run}, {at: at(t + 4), type: 'run.session_bound', run, session: `native-${run}`, prompted_at: at(t + 2)}, report, ingest,
      {at: at(t + 23), type: 'item.closed', id: item, completed_run: run, as: 'done'}, session, folder, evaluation);
    const o = proof({run, kind: review ? 'review' : 'ordinary', useful: !review,
      runtime: Object.fromEntries(['controller', 'worker', 'watcher'].map(k => [k, proof({candidate})])),
      physical: proof({before: {session: `native-${run}`, tab: `tab-${run}`, folder: start.workspace}, after: {session: 'absent', tab: 'absent', folder: 'absent'}}),
      turns: proof({close: run, session: run, folder: run}), queue: proof({eligibleAt: at(t - 1), freeAt: at(i > 1 && i <= 10 ? (order.indexOf(i - 1) + 1) * 120 + 25 : t - 1), inputAt: at(t + 2), ...(i > 1 && i <= 10 ? {freedBy: `R-${i - 1}`} : {})}),
      review: proof(review ? {cap: 1, suites: 0, original: true} : i <= 3 ? {run: `R-${i + 10}`, cap: 1, suites: 0, original: true} : {required: false}),
      shared: proof({mode: 'shared', perRunWatcherRssBytes: 0, hostRssBytes: 12000000, noticeLatencyMs: 100, expectedNotices: 1, deliveredNotices: 1, duplicates: 0}),
      ...(!review && i <= 3 ? {source: proof({base: '1'.repeat(40), head: '2'.repeat(40)})} : {})});
    runs.push(o); bindings.push({o, start, claim, report, ingest, session, folder, evaluation});
  }
  for (let i = 1; i <= 13; i++) unit(i, i > 10);
  events.sort((a, b) => Date.parse(a.at) - Date.parse(b.at)); events.forEach((e, i) => e.seq = i + 1);
  for (const b of bindings) {
    b.o.startedSeq = b.start.seq; b.o.claimGeneration = b.claim.seq;
    b.report.started_seq = b.start.seq; b.report.claim_generation = b.claim.seq;
    for (const e of [b.session, b.folder, b.evaluation]) e.source = {seq: b.ingest.seq, type: 'report.ingested'};
    b.evaluation.resources = {session: {status: 'closed', receipt: {seq: b.session.seq, effect: 'session'}}, folder: {status: 'removed', receipt: {seq: b.folder.seq, effect: 'folder'}}};
  }
  const trial = {schema: 'brain.canary-soak-input/v1', project, candidate, window: {from, cutoff, start_seq: 2, through_seq: events.at(-1).seq},
    evidence: {saved: {path: 'saved.json', sha256: 'e'.repeat(64)}},
    scripted: proof({schema: 'brain.installed-canary/v1', candidate, status: 'PASS', fixtureOnly: true, ready: false, failures: [], originalReview: 'REV-original', reviewerSuites: 0,
      cases: Object.fromEntries([...Array.from({length: 9}, (_, i) => `S${i}`), 'shared-observer'].map(k => [k, {status: 'PASS'}]))}),
    landing: proof({candidate, selection: 'affected checks', checks: [proof({command: 'node focused-control.mjs', exitStatus: 0, nodeVersion: 'v20.19.4', appliesTo: candidate.commit})]}),
    probation: proof({archive: {schema: 'brain-probation/v1', id: 'trial-one', project, scope, owner, authority: 1, before: {installation: 'original installation', plist: 'original plist'}}}),
    recovery: proof({root: '/installed/previous', accepted: true, compatible: true}),
    controller: proof({samples: [from, cutoff].map(at => proof({at, candidate, newAdmissions: true}))}),
    host: proof({contaminated: false, samples: [from, cutoff].map(at => proof({at, loadPerCore: .5, memoryPressure: 'normal', competingLoad: 'none', herdrVersion: 'saved-version'}))}),
    rescues: proof({complete: true, from, cutoff, actions: []}), safety: proof({complete: true, violations: []}),
    corrections: proof({complete: true, pending: []}), runs};
  // Simulate independent immutable JSON input, without object aliasing.
  return JSON.parse(JSON.stringify({events, trial, verifiedEvidence: ['saved']}));
}
