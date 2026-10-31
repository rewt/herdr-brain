import test from 'node:test';
import assert from 'node:assert/strict';
import {evaluateSoak, digest} from '../measurement/canary-soak.mjs';
import {canonical} from '../messages/schema.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {copyProduct} from '../lib/product-files.mjs';

const project = '/fixture/brain/.git', from = '2026-10-30T12:00:00.000Z', cutoff = '2026-10-30T13:30:00.000Z';
const at = seconds => new Date(Date.parse(from) + seconds * 1000).toISOString();
const proof = extra => ({evidence: ['saved'], ...extra});
function fixture() {
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
    const run = `R-${i}`, item = review ? `REV-${i}` : `ENG-${i}`, t = i * 120;
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
      turns: proof({close: run, session: run, folder: run}), queue: proof({eligibleAt: at(t - 1), freeAt: at(i > 1 && i <= 10 ? (i - 1) * 120 + 25 : t - 1), inputAt: at(t + 2), ...(i > 1 && i <= 10 ? {freedBy: `R-${i - 1}`} : {})}),
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
const evaluate = f => evaluateSoak(f);
const has = (result, code) => result.issues.some(i => i.code === code);

test('both layers pass with all ordinary/review runs, B4 metrics and shared dimensions separate', () => {
  const f = fixture(), before = structuredClone(f), r = evaluate(f);
  assert.equal(r.status, 'PASS', JSON.stringify(r.issues)); assert.equal(r.offerEligible, true);
  assert.equal(r.counts.all_started, 13); assert.equal(r.counts.ordinary, 10); assert.equal(r.counts.reviews, 3);
  assert.equal(r.counts.source_units, 3); assert.equal(r.latency.report_to_ingest.max_ms, 2000);
  assert.equal(r.layers.stable.liveAcceptance, 'UNRUN'); assert.deepEqual(f, before);
});
test('fixed event cutoff is deterministic under later appends', () => {
  const f = fixture(), first = evaluate(f);
  f.events.push({seq: f.events.at(-1).seq + 1, at: at(6000), type: 'run.started', id: 'R-later', meta: {dispatch_project: project}});
  assert.deepEqual(evaluate(f), first);
});
test('scripted PASS cannot mask a later failed unit outside ten fast successes', () => {
  const f = fixture(), seq = f.events.at(-1).seq;
  f.events.push({seq: seq + 1, at: at(5000), type: 'run.started', id: 'R-late', item: 'ENG-late', meta: {dispatch_project: project}},
    {seq: seq + 2, at: at(5001), type: 'report.ingested', run: 'R-late', report: {outcome: 'failed'}});
  f.trial.window.through_seq += 2;
  const r = evaluate(f); assert.equal(r.status, 'FAIL'); assert.equal(r.counts.all_started, 14); assert.ok(has(r, 'failed-unit'));
});
test('a late pending candidate run stays in the denominator and withholds the offer', () => {
  const f = fixture(); f.events.push({seq: ++f.trial.window.through_seq, at: at(5000), type: 'run.started', id: 'R-late', item: 'ENG-late', meta: {dispatch_project: project}});
  const r = evaluate(f); assert.equal(r.status, 'INCOMPLETE'); assert.equal(r.counts.all_started, 14); assert.equal(r.offerEligible, false);
});
test('zero work and insufficient genuine demand never pass a ninety-minute window', () => {
  for (const n of [0, 9]) {
    const f = fixture(); const keep = new Set(f.trial.runs.slice(0, n).map(r => r.run));
    f.events = f.events.filter(e => e.seq <= 2 || keep.has(e.run ?? e.id) || e.type === 'item.added');
    f.trial.window.through_seq = f.events.at(-1).seq;
    const r = evaluate(f); assert.equal(r.status, 'INCOMPLETE'); assert.ok(has(r, 'sample'));
  }
});
test('missing report timestamps and physical/native observations stay unknown', () => {
  for (const mutate of [f => delete f.events.find(e => e.type === 'report.available').observed_at,
    f => delete f.trial.runs[0].physical, f => delete f.events.find(e => e.type === 'run.session_bound').session]) {
    const f = fixture(); mutate(f); assert.equal(evaluate(f).status, 'INCOMPLETE');
  }
});
test('a different controller, worker, watcher, claim or scripted tuple fails', () => {
  for (const mutate of [f => f.trial.controller.samples[0].candidate.root = '/development',
    f => f.trial.runs[0].runtime.worker.candidate.commit = 'f'.repeat(40),
    f => f.trial.runs[0].runtime.watcher.candidate.manifestSha256 = 'f'.repeat(64),
    f => f.events.find(e => e.type === 'run.claimed').owner.release.root = '/other',
    f => f.trial.scripted.candidate.inventorySha256 = 'f'.repeat(64)]) {
    const f = fixture(); mutate(f); assert.equal(evaluate(f).status, 'FAIL');
  }
});
test('rescues and safety violations fail even when every unit completed', () => {
  for (const field of ['rescues', 'safety']) { const f = fixture(); f.trial[field][field === 'rescues' ? 'actions' : 'violations'].push({reason: 'manual intervention'}); assert.equal(evaluate(f).status, 'FAIL'); }
  const f = fixture(); f.trial.rescues.complete = false; assert.equal(evaluate(f).status, 'INCOMPLETE');
});
test('original failed canary remains failed despite separate correction evidence', () => {
  const f = fixture(); f.trial.scripted.status = 'FAIL'; f.trial.scripted.failures = [{case: 'S4', separateCorrection: 'fixed elsewhere'}];
  assert.equal(evaluate(f).status, 'FAIL');
});
test('missing or mismatched probation authority and installed rollback prevent an offer', () => {
  for (const mutate of [f => delete f.trial.probation, f => f.trial.recovery.root = '/development',
    f => f.events[0].by = 'borrowed-identity', f => f.trial.probation.archive.before.plist = '',
    f => f.trial.probation.archive.scope.candidate.release.root = '/other']) {
    const f = fixture(); mutate(f); assert.notEqual(evaluate(f).status, 'PASS');
  }
});
test('duplicate report ingestion and shared notices fail', () => {
  const f = fixture(), duplicate = {...f.events.find(e => e.type === 'report.ingested'), seq: ++f.trial.window.through_seq};
  f.events.push(duplicate); assert.equal(evaluate(f).status, 'FAIL');
  const g = fixture(); g.trial.runs[0].shared.duplicates = 1; assert.equal(evaluate(g).status, 'FAIL');
});
test('shared observation must cover memory, latency and dedupe for every run', () => {
  for (const key of ['perRunWatcherRssBytes', 'hostRssBytes', 'noticeLatencyMs', 'deliveredNotices']) {
    const f = fixture(); delete f.trial.runs[12].shared[key]; assert.equal(evaluate(f).status, 'INCOMPLETE');
  }
});
test('missing review retirement, cap/suite mismatch and corrections keep offer pending', () => {
  for (const mutate of [f => f.trial.runs[10].review.suites = 1, f => f.trial.runs[0].review.run = 'R-missing',
    f => f.trial.corrections.pending.push('major'), f => f.trial.runs[0].turns.folder = 'later-turn']) {
    const f = fixture(); mutate(f); assert.equal(evaluate(f).status, 'INCOMPLETE');
  }
});
test('two successive capacity turnovers and three source units are independently required', () => {
  const f = fixture(); for (const r of f.trial.runs) delete r.queue.freedBy;
  assert.ok(has(evaluate(f), 'turnover'));
  const g = fixture(); delete g.trial.runs[0].source; assert.ok(has(evaluate(g), 'source-sample'));
});
test('load-contaminated misses are incomplete; ordinary threshold failures fail', () => {
  for (const contaminated of [false, true]) {
    const f = fixture(); f.trial.host.contaminated = contaminated;
    f.events.find(e => e.type === 'report.available').observed_at = at(-100);
    assert.equal(evaluate(f).status, contaminated ? 'INCOMPLETE' : 'FAIL');
  }
});
test('unverified evidence, short duration and forged physical identities cannot pass', () => {
  for (const mutate of [f => f.verifiedEvidence = [], f => f.trial.window.cutoff = at(5000), f => f.trial.runs[0].physical.before.folder = '/foreign']) {
    const f = fixture(); mutate(f); assert.equal(evaluate(f).status, 'INCOMPLETE');
  }
});
test('unknown start time is accounted for rather than omitted', () => {
  const f = fixture(); delete f.events.find(e => e.type === 'run.started').at;
  const r = evaluate(f); assert.equal(r.counts.all_started, 13); assert.equal(r.status, 'INCOMPLETE');
});
test('canary results do not substitute for exact-candidate landing tests', () => {
  const f = fixture(); delete f.trial.landing; const r = evaluate(f);
  assert.equal(r.status, 'INCOMPLETE'); assert.equal(r.layers.real, 'PASS'); assert.ok(has(r, 'landing-checks'));
});
test('copied installed CLI verifies artifacts and consumes original packets instead of inline status', t => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'canary-soak-')));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  const installed = path.join(root, 'installed'); copyProduct(path.resolve(import.meta.dirname, '..'), installed);
  const f = fixture(), saved = 'saved observations';
  fs.writeFileSync(path.join(root, 'saved.json'), saved); f.trial.evidence.saved.sha256 = digest(saved);
  function save(id, value) {
    const bytes = JSON.stringify(value); fs.writeFileSync(path.join(root, id + '.json'), bytes);
    f.trial.evidence[id] = {path: id + '.json', sha256: digest(bytes)};
  }
  save('probation', f.trial.probation.archive);
  f.events[1].archive.sha256 = f.trial.evidence.probation.sha256;
  const packet = f.trial.scripted; save('scripted', packet);
  f.trial.probation = {archiveEvidence: 'probation'}; f.trial.scripted = {packetEvidence: 'scripted', status: 'PASS'};
  fs.writeFileSync(path.join(root, 'events.jsonl'), f.events.map(e => JSON.stringify(e)).join('\n'));
  const run = () => {
    fs.writeFileSync(path.join(root, 'trial.json'), JSON.stringify(f.trial));
    return spawnSync(process.execPath, [path.join(installed, 'bin/evaluate-canary-soak.mjs'), '--trial', path.join(root, 'trial.json'), '--events', path.join(root, 'events.jsonl')], {encoding: 'utf8'});
  };
  const pass = run(); assert.equal(pass.status, 0, pass.stderr); assert.equal(JSON.parse(pass.stdout).status, 'PASS');
  packet.status = 'FAIL'; packet.failures = [{case: 'S4'}]; save('scripted', packet);
  const failed = run(); assert.equal(failed.status, 0, failed.stderr); assert.equal(JSON.parse(failed.stdout).status, 'FAIL');
  fs.appendFileSync(path.join(root, 'scripted.json'), ' ');
  const drift = run(); assert.equal(drift.status, 1); assert.match(drift.stderr, /evidence digest mismatch/);
});
