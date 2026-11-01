import test from 'node:test';
import assert from 'node:assert/strict';
import {evaluateSoak, digest} from '../measurement/canary-soak.mjs';
import {canonical} from '../messages/schema.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {copyProduct} from '../lib/product-files.mjs';
import {validateConsumerCanaryEvidence} from '../lib/consumer-offer.mjs';

import {project, at, fixture} from './helpers/soak-fixture.mjs';
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
test('closing sequence fence cannot hide in-window failed starts or other cutoff evidence', () => {
  for (const time of [5000, 5400, -1]) {
    const f = fixture(), seq = f.trial.window.through_seq;
    f.events.push({seq: seq + 1, at: at(time), type: 'note.added', id: 'unrelated'});
    const r = evaluate(f);
    assert.equal(r.status, 'INCOMPLETE'); assert.equal(r.offerEligible, false); assert.ok(has(r, 'fence-cutoff'));
  }
  const f = fixture(), seq = f.trial.window.through_seq;
  f.events.push({seq: seq + 1, at: at(5000), type: 'run.started', id: 'R-late', item: 'ENG-late', meta: {dispatch_project: project}},
    {seq: seq + 2, at: at(5001), type: 'report.ingested', run: 'R-late', report: {outcome: 'failed'}});
  const r = evaluate(f);
  assert.equal(r.status, 'INCOMPLETE'); assert.equal(r.offerEligible, false); assert.ok(has(r, 'fence-cutoff'));
  assert.ok(r.issues.some(i => i.code === 'fence-cutoff' && i.run === 'R-late'));
});
test('opening sequence fence names every excluded in-window project start', () => {
  for (const time of [0, 120, 5400]) {
    const f = fixture(), start = f.events.find(e => e.type === 'run.started' && e.id === 'R-1');
    start.at = at(time); f.trial.window.start_seq = start.seq;
    const r = evaluate(f);
    assert.notEqual(r.status, 'PASS'); assert.equal(r.offerEligible, false); assert.ok(has(r, 'fence-start'));
    assert.ok(r.issues.some(i => i.code === 'fence-start' && i.run === 'R-1' && i.reason.includes(String(start.seq))));
  }
});
test('a late pending candidate run stays in the denominator and withholds the offer', () => {
  const f = fixture(); f.events.push({seq: ++f.trial.window.through_seq, at: at(5000), type: 'run.started', id: 'R-late', item: 'ENG-late', meta: {dispatch_project: project}});
  const r = evaluate(f); assert.equal(r.status, 'INCOMPLETE'); assert.equal(r.counts.all_started, 14); assert.equal(r.offerEligible, false);
  assert.ok(has(r, 'completion'));
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
  for (const [code, mutate] of [['timing-unknown', f => delete f.events.find(e => e.type === 'report.available').observed_at],
    ['physical-evidence', f => delete f.trial.runs[0].physical], ['physical-binding', f => delete f.events.find(e => e.type === 'run.session_bound').session]]) {
    const f = fixture(); mutate(f); const r = evaluate(f); assert.equal(r.status, 'INCOMPLETE'); assert.ok(has(r, code), code);
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
  const f = fixture(); f.trial.rescues.complete = false; const r = evaluate(f);
  assert.equal(r.status, 'INCOMPLETE'); assert.ok(has(r, 'rescue-coverage'));
});
test('original failed canary remains failed despite separate correction evidence', () => {
  const f = fixture(); f.trial.scripted.status = 'FAIL'; f.trial.scripted.failures = [{case: 'S4', separateCorrection: 'fixed elsewhere'}];
  assert.equal(evaluate(f).status, 'FAIL');
});
test('missing or mismatched probation authority and installed rollback prevent an offer', () => {
  for (const [code, mutate] of [['authority', f => delete f.trial.probation], ['rollback-root', f => f.trial.recovery.root = '/development'],
    ['authority', f => f.events[0].by = 'borrowed-identity'], ['rollback-root', f => f.trial.probation.archive.before.plist = ''],
    ['probation-drift', f => f.trial.probation.archive.scope.candidate.release.root = '/other']]) {
    const f = fixture(); mutate(f); const r = evaluate(f); assert.notEqual(r.status, 'PASS'); assert.ok(has(r, code), code);
  }
});
test('probation authority requires a candidate even when its archive and decision agree', () => {
  const f = fixture();
  delete f.trial.probation.archive.scope.candidate;
  delete f.events[1].scope.candidate;
  f.events[0].text = `Brain probation authorized: ${digest(canonical(f.events[1].scope))}`;
  const r = evaluate(f);
  assert.equal(r.status, 'INCOMPLETE'); assert.equal(r.offerEligible, false); assert.ok(has(r, 'authority'));
});
test('review and reviewer roles classify reviews without a REV item prefix', () => {
  for (const role of ['review', 'reviewer']) {
    const f = fixture(), original = 'REV-11', renamed = 'CHECK-11';
    for (const e of f.events) {
      if (e.type === 'item.added' && e.id === original) { e.id = renamed; e.role = role; }
      if (e.type === 'item.closed' && e.id === original) e.id = renamed;
      if (e.item === original) e.item = renamed;
    }
    const r = evaluate(f);
    assert.equal(r.status, 'PASS', JSON.stringify(r.issues)); assert.equal(r.counts.reviews, 3);
    assert.equal(r.runs.find(r => r.run === 'R-11').kind, 'review');
  }
});
test('duplicate report ingestion and shared notices fail', () => {
  const f = fixture(), duplicate = {...f.events.find(e => e.type === 'report.ingested'), seq: ++f.trial.window.through_seq};
  f.events.push(duplicate); assert.equal(evaluate(f).status, 'FAIL');
  const g = fixture(); g.trial.runs[0].shared.duplicates = 1; assert.equal(evaluate(g).status, 'FAIL');
});
test('shared observation must cover memory, latency and dedupe for every run', () => {
  for (const key of ['perRunWatcherRssBytes', 'hostRssBytes', 'noticeLatencyMs', 'deliveredNotices']) {
    const f = fixture(); delete f.trial.runs[12].shared[key]; const r = evaluate(f);
    assert.equal(r.status, 'INCOMPLETE'); assert.ok(has(r, 'shared-observer'), key);
  }
});
test('missing review retirement, cap/suite mismatch and corrections keep offer pending', () => {
  for (const [code, mutate] of [['review-verdict', f => f.trial.runs[10].review.suites = 1], ['pending-review', f => f.trial.runs[0].review.run = 'R-missing'],
    ['corrections', f => f.trial.corrections.pending.push('major')], ['finite-turn', f => f.trial.runs[0].turns.folder = 'later-turn']]) {
    const f = fixture(); mutate(f); const r = evaluate(f); assert.equal(r.status, 'INCOMPLETE'); assert.ok(has(r, code), code);
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
    const r = evaluate(f);
    assert.equal(r.status, contaminated ? 'INCOMPLETE' : 'FAIL'); assert.ok(has(r, contaminated ? 'load-threshold' : 'latency'));
  }
});
test('unverified evidence, short duration and forged physical identities cannot pass', () => {
  for (const [code, mutate] of [['run-evidence', f => f.verifiedEvidence = []], ['duration', f => f.trial.window.cutoff = at(5000)], ['physical-binding', f => f.trial.runs[0].physical.before.folder = '/foreign']]) {
    const f = fixture(); mutate(f); const r = evaluate(f); assert.equal(r.status, 'INCOMPLETE'); assert.ok(has(r, code), code);
  }
});
test('unknown start time is accounted for rather than omitted', () => {
  const f = fixture(); delete f.events.find(e => e.type === 'run.started').at;
  const r = evaluate(f); assert.equal(r.counts.all_started, 13); assert.equal(r.status, 'INCOMPLETE');
  assert.ok(has(r, 'start-time'));
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
  let attempt = 0;
  const run = () => {
    fs.writeFileSync(path.join(root, 'trial.json'), JSON.stringify(f.trial));
    const probation = path.join(root, `probation-stage-${++attempt}.json`);
    return {...spawnSync(process.execPath, [path.join(installed, 'bin/evaluate-canary-soak.mjs'), '--trial', path.join(root, 'trial.json'),
      '--events', path.join(root, 'events.jsonl'), '--probation-output', probation], {encoding: 'utf8'}), probation};
  };
  const pass = run(); assert.equal(pass.status, 0, pass.stderr); assert.equal(JSON.parse(pass.stdout).status, 'PASS');
  const stage = JSON.parse(fs.readFileSync(pass.probation));
  assert.equal(stage.schema, 'brain.probation-stage/v1'); assert.equal(stage.status, 'PASS');
  assert.equal(stage.archive.sha256, f.trial.evidence.probation.sha256);
  assert.equal(stage.assessmentSha256, digest(pass.stdout));
  assert.equal(stage.candidate.commit, packet.candidate.commit);
  const assessment = path.join(root, 'assessment.json'); fs.writeFileSync(assessment, pass.stdout);
  const reference = (stage, file) => ({stage, file, sha256: digest(fs.readFileSync(file))});
  const evidence = () => [reference('installed', path.join(root, 'scripted.json')), reference('probation', pass.probation), reference('soak', assessment)];
  const validate = () => validateConsumerCanaryEvidence(evidence(), {commit: packet.candidate.commit, manifestSha256: packet.candidate.manifestSha256});
  validate(); // Unmodified real CLI output, no top-level candidateCommit wrapper.
  const archiveFile = path.join(root, 'probation.json'), archiveBytes = fs.readFileSync(archiveFile);
  fs.appendFileSync(archiveFile, ' ');
  assert.throws(validate, /probation archive changed/);
  fs.writeFileSync(archiveFile, archiveBytes); validate(); // Restore original provenance.
  fs.appendFileSync(assessment, ' '); assert.throws(validate, /probation provenance/);
  fs.writeFileSync(assessment, pass.stdout); validate();
  for (const mutate of [p => p.candidate.tree = '0'.repeat(40), p => p.candidateCommit = '0'.repeat(40), p => delete p.candidate]) {
    const changed = structuredClone(packet); mutate(changed); save('scripted', changed);
    assert.throws(validate, /candidate tuple mismatch|exact candidate/);
  }
  save('scripted', packet); validate();
  assert.throws(() => validateConsumerCanaryEvidence(evidence().filter(r => r.stage !== 'probation'), {commit: packet.candidate.commit}), /requires probation/);
  const originalStage = fs.readFileSync(pass.probation);
  const overwrite = spawnSync(process.execPath, [path.join(installed, 'bin/evaluate-canary-soak.mjs'), '--trial', path.join(root, 'trial.json'),
    '--events', path.join(root, 'events.jsonl'), '--probation-output', pass.probation], {encoding: 'utf8'});
  assert.equal(overwrite.status, 1); assert.match(overwrite.stderr, /EEXIST/); assert.deepEqual(fs.readFileSync(pass.probation), originalStage);
  packet.status = 'FAIL'; packet.failures = [{case: 'S4'}]; save('scripted', packet);
  const failed = run(); assert.equal(failed.status, 0, failed.stderr); assert.equal(JSON.parse(failed.stdout).status, 'FAIL');
  assert.equal(JSON.parse(fs.readFileSync(failed.probation)).status, 'FAIL');
  assert.throws(validate, /exact candidate/);
  fs.appendFileSync(path.join(root, 'scripted.json'), ' ');
  const drift = run(); assert.equal(drift.status, 1); assert.match(drift.stderr, /evidence digest mismatch/);
  assert.equal(fs.existsSync(drift.probation), false);
  packet.status = 'PASS'; packet.failures = []; save('scripted', packet);
  const wrongArchive = JSON.parse(archiveBytes); wrongArchive.scope.candidate.tree = '0'.repeat(40);
  save('probation', wrongArchive); f.events[1].archive.sha256 = f.trial.evidence.probation.sha256;
  fs.writeFileSync(path.join(root, 'events.jsonl'), f.events.map(e => JSON.stringify(e)).join('\n'));
  const wrong = run(); assert.equal(wrong.status, 0, wrong.stderr);
  assert.equal(JSON.parse(wrong.stdout).status, 'FAIL'); assert.equal(JSON.parse(fs.readFileSync(wrong.probation)).status, 'FAIL');
  delete f.trial.probation;
  const missing = run(); assert.equal(missing.status, 1); assert.match(missing.stderr, /verified original trial archive/);
  assert.equal(fs.existsSync(missing.probation), false);
});

test('saved-input offer probation output withholds missing authority and wrong archived tuple', () => {
  for (const mutate of [f => f.events.splice(0, 1), f => f.trial.probation.archive.scope.candidate.tree = '0'.repeat(40),
    f => f.trial.probation.archive.scope.candidate.release.commit = '0'.repeat(40), f => delete f.trial.probation]) {
    const f = fixture(); mutate(f);
    const result = evaluate(f);
    assert.notEqual(result.status, 'PASS'); assert.equal(result.offerEligible, false);
    assert.ok(result.issues.some(i => ['authority', 'probation-drift', 'probation-evidence'].includes(i.code)));
  }
});
