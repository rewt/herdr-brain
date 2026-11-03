import {digest} from '../../measurement/canary-soak.mjs';
import {canonical} from '../../messages/schema.mjs';
import {selectCapacityAllocation} from '../../dispatch/capacity-lineage.mjs';

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
    {seq: 1, at: at(-200), type: 'note.added', id: 'ENG-trial', by: 'supervisor-herdr', decision: true, text: `Brain probation authorized: ${digest(canonical(scope))}`},
    {seq: 2, at: at(-199), type: 'line-service.probation-authorized', id: 'trial-one', project, scope, owner, authority: 1, archive: {sha256: 'e'.repeat(64)}}
  ];
  const runs = [], bindings = [];
  function unit(i, review = false) {
    const run = `R-${i}`, item = review ? `REV-${i}` : `ENG-${i}`, t = (order.indexOf(i) + 1) * 120;
    const start = {at: at(t), type: 'run.started', id: run, item, workspace: `/lane/${run}`, by: 'line-service', meta: {dispatch_project: project}};
    const claim = {at: at(t + 1), type: 'run.claimed', run, owner: {release: {root: candidate.root}}};
    const report = {at: at(t + 20), type: 'report.available', run, project, producer: 'original-report-watcher', observed_at: at(t + 20), sha256: digest('report-' + run)};
    const ingest = {at: at(t + 22), type: 'report.ingested', run, sha256: digest('report-' + run), report: {outcome: 'done', extra: review ? {verdict: 'PASS'} : {}}};
    const session = {at: at(t + 24), type: 'closeout.effect', run, identity: project, key: run, effect: 'session', outcome: {action: 'closed', tab_id: `tab-${run}`}};
    const folder = {at: at(t + 25), type: 'closeout.effect', run, identity: project, key: run, effect: 'folder', outcome: {action: 'worktree-removed'}};
    const evaluation = {at: at(t + 26), type: 'closeout.evaluated', run, identity: project, key: run};
    events.push({at: at(t - 2), type: 'item.added', id: item, role: review ? 'review' : 'engineer'}, start, claim,
      {at: at(t + 3), type: 'dispatch.completed', run}, {at: at(t + 4), type: 'run.session_bound', run, session: `native-${run}`, prompted_at: at(t + 2)}, report, ingest,
      {at: at(t + 23), type: 'item.closed', id: item, completed_run: run, as: 'done'}, session, folder, evaluation);
    const o = proof({run, kind: review ? 'review' : 'ordinary', useful: !review,
      runtime: Object.fromEntries(['controller', 'worker', 'watcher'].map(k => [k, proof({candidate})])),
      physical: proof({before: {session: `native-${run}`, tab: `tab-${run}`, folder: start.workspace}, after: {session: 'absent', tab: 'absent', folder: 'absent'}}),
      turns: proof({close: run, session: run, folder: run}), queue: proof({eligibleAt: at(t - 1), inputAt: at(t + 2)}),
      review: proof(review ? {cap: 1, suites: 0, original: true} : i <= 3 ? {run: `R-${i + 10}`, cap: 1, suites: 0, original: true} : {required: false}),
      shared: proof({mode: 'shared', perRunWatcherRssBytes: 0, hostRssBytes: 12000000, noticeLatencyMs: 100, expectedNotices: 1, deliveredNotices: 1, duplicates: 0, expectedNoticeIds: [`notice-${run}`], deliveredNoticeIds: [`notice-${run}`]}),
      ...(!review && i <= 3 ? {source: proof({base: '1'.repeat(40), head: '2'.repeat(40)})} : {})});
    runs.push(o); bindings.push({o, start, claim, report, ingest, session, folder, evaluation});
  }
  for (let i = 1; i <= 13; i++) unit(i, i > 10);
  // Verified pre-window roots give first in-window inputs a genuine logical
  // release origin. These are carry-in ancestors, never candidate sample units.
  for (const [n, review] of [['seed-build', false], ['seed-review', true]]) {
    const run = `R-${n}`, item = review ? 'REV-seed' : 'ENG-seed';
    const start = {at: at(-100), type: 'run.started', id: run, item, workspace: `/lane/${run}`, by: 'line-service', meta: {dispatch_project: project}};
    const claim = {at: at(-99), type: 'run.claimed', run};
    const ingest = {at: at(-90), type: 'report.ingested', run, sha256: digest('report-' + run), report: {outcome: 'done'}};
    const session = {at: at(-89), type: 'closeout.effect', identity: project, run, key: run, effect: 'session', outcome: {action: 'closed', tab_id: run}};
    const folder = {at: at(-88), type: 'closeout.effect', identity: project, run, key: run, effect: 'folder', outcome: {action: 'worktree-removed'}};
    const evaluation = {at: at(-87), type: 'closeout.evaluated', identity: project, run, key: run};
    events.push({at: at(-101), type: 'item.added', id: item, role: review ? 'review' : 'engineer'}, start, claim, ingest, session, folder, evaluation);
    bindings.push({o: {}, start, claim, report: {}, ingest, session, folder, evaluation});
  }
  events.sort((a, b) => Date.parse(a.at) - Date.parse(b.at)); events.forEach((e, i) => e.seq = i + 1);
  for (const b of bindings) {
    b.o.startedSeq = b.start.seq; b.o.claimGeneration = b.claim.seq;
    b.report.started_seq = b.start.seq; b.report.claim_generation = b.claim.seq;
    for (const e of [b.session, b.folder, b.evaluation]) e.source = {seq: b.ingest.seq, type: 'report.ingested'};
    b.evaluation.resources = {session: {status: 'closed', receipt: {seq: b.session.seq, effect: 'session'}}, folder: {status: 'removed', receipt: {seq: b.folder.seq, effect: 'folder'}}};
  }
  const trial = {schema: 'brain.canary-soak-input/v1', project, candidate, window: {from, cutoff, start_seq: events.filter(e => Date.parse(e.at) < Date.parse(from)).at(-1).seq, through_seq: events.at(-1).seq},
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
  return bindSavedEvidence(JSON.parse(JSON.stringify({events, trial, verifiedEvidence: ['saved']})));
}

// Rebuild originals after successor fixtures move sequence numbers. This uses
// the actual allocator receipt producer; the evaluator still only reads bytes.
export function bindSavedEvidence(f) {
  const {events, trial} = f, journals = [], identities = [], org = '/fixture/record';
  const saved = {};
  const save = (id, value) => {
    const bytes = JSON.stringify(value); saved[id] = bytes;
    trial.evidence[id] = {path: id + '.json', sha256: digest(bytes)};
    if (!f.verifiedEvidence.includes(id)) f.verifiedEvidence.push(id);
    return id;
  };
  for (const start of events.filter(e => e.type === 'run.started')) {
    const claim = events.find(e => e.type === 'run.claimed' && e.run === start.id);
    const journal = `/fixture/record/dispatch/${start.id}.json`, token = `attempt-${start.id}`;
    Object.assign(start.meta, {dispatch_record: org, dispatch_attempt: token, dispatch_journal: journal});
    Object.assign(claim, {project, record: org});
    const job = {run: start.id, common: project, org, token, workspace: start.workspace, ownership: {generation: claim.seq}};
    const role = events.find(e => e.type === 'item.added' && e.id === start.item)?.role;
    job.sessionCap = {kind: role === 'review' ? 'review' : 'build', cap: 1, build_cap: 1, review_cap: 1, decision_cap: 1};
    job.capacityAllocation = selectCapacityAllocation({job, journal, events: events.filter(e => e.seq <= claim.seq), journals,
      evidence: job.sessionCap,
      now: () => new Date(Date.parse(start.at) + 1500).toISOString()});
    journals.push({...job, journal});
    if (!identities.some(i => canonical(i) === canonical(job.capacityAllocation.capacity))) identities.push(job.capacityAllocation.capacity);
    const row = trial.runs.find(r => r.run === start.id);
    if (row) Object.assign(row.queue, {allocation: job.capacityAllocation, freedBy: job.capacityAllocation.freedBy, freeAt: job.capacityAllocation.freeAt});
  }
  trial.capacity = {complete: true, journalRefs: journals.map(({journal, ...job}, i) => ({journal, evidence: save('capacity-job-' + i, job)})),
    inventoryEvidence: save('capacity-inventory', {complete: true, journals: journals.map(j => j.journal)}),
    configEvidence: save('capacity-config', {identities}),
    censusEvidence: save('capacity-census', {complete: true, at: trial.window.from, through_seq: trial.window.start_seq, resources: []}), saved};
  trial.turnEvidence = [];
  trial.turnWitnesses = trial.runs.map(row => {
    const h = events.filter(e => e.run === row.run), report = h.find(e => e.type === 'report.ingested'), evaluation = h.find(e => e.type === 'closeout.evaluated');
    const witness = {schema: 'brain.hold-closeout/v1', id: row.run, project, org,
      before: {record: {seq: report.seq}, at: report.at}, after: {record: {seq: evaluation.seq}, at: evaluation.at},
      subjects: [{run: row.run, key: row.run, source: {seq: report.seq, type: report.type}}]};
    const id = save('turn-' + row.run, witness); trial.turnEvidence.push(id);
    return {bytes: saved[id], evidence: [id]};
  });
  return JSON.parse(JSON.stringify(f));
}
export function saveSoakOriginals(f, save) {
  for (const [id, bytes] of Object.entries(f.trial.capacity.saved)) save(id, bytes);
}
