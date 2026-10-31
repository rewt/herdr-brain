import test from 'node:test';
import assert from 'node:assert/strict';
import {evaluateSoak, digest} from '../measurement/canary-soak.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {copyProduct} from '../lib/product-files.mjs';

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
