import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {spawnSync} from 'node:child_process';
import {copyProduct} from '../lib/product-files.mjs';
import {evaluateSoak, digest} from '../measurement/canary-soak.mjs';
import {probationChain} from '../measurement/probation-chain.mjs';
import {successorFixture} from './helpers/soak-successor-fixture.mjs';
import {at, proof, fixture} from './helpers/soak-fixture.mjs';
const output = process.env.SOAK_CONTROL_OUTPUT;
function retain(name, f, result) {
  if (!output) return;
  fs.mkdirSync(output, {recursive: true});
  fs.writeFileSync(path.join(output, name + '.json'), JSON.stringify({input: f, result}, null, 2));
}
const assess = (name, f) => { const result = evaluateSoak(f); retain(name, f, result); return result; };
const rejected = (name, mutate, expected) => test(name, () => {
  const f = successorFixture(); mutate(f);
  const r = assess(name.replaceAll(/[^a-z0-9-]/g, '-'), f);
  assert.equal(r.offerEligible, false); if (expected) assert.equal(r.status, expected);
});

test('retained real original and successor archives reconstruct the unchanged recovery', {skip: !process.env.SOAK_RETAINED_HISTORY}, () => {
  const input = JSON.parse(fs.readFileSync(process.env.SOAK_RETAINED_HISTORY));
  input.verified = new Set(input.verified);
  const result = probationChain(input);
  assert.equal(result.candidate, null); // The real service is stopped at recovery, never a synthetic PASS.
  assert.equal(result.recovery.commit, '6dc33698bb52b0e398164c15e8030f7e71b76f72');
  retain('retained-recovery-result', null, result);
});

test('one supported successor retains legacy entry, drill, return and rollback history', () => {
  const f = successorFixture({next: false}), before = structuredClone(f), r = assess('supported-successor', f);
  assert.equal(r.status, 'PASS', JSON.stringify(r.issues)); assert.equal(r.offerEligible, true); assert.deepEqual(f, before);
});

test('copied CLI verifies planned original plus earlier successor rollback plus prospective C history', t => {
  const root = output ? path.join(output, 'planned-cli') : fs.mkdtempSync(path.join(os.tmpdir(), 'soak-chain-'));
  fs.mkdirSync(root, {recursive: true}); if (!output) t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  const installed = path.join(root, 'installed'); copyProduct(path.resolve(import.meta.dirname, '..'), installed);
  const f = successorFixture();
  // Exercise real shared-mode representation: one observer, absent per-run watchers.
  for (const r of f.trial.runs) { r.runtime.sharedObserver = r.runtime.watcher; delete r.runtime.watcher; r.shared.perRunWatcherAbsent = true; }
  const save = (id, bytes) => {
    fs.writeFileSync(path.join(root, id + '.json'), bytes);
    f.trial.evidence[id] = {path: id + '.json', sha256: digest(bytes)};
  };
  save('saved', 'saved observations'); save('original', JSON.stringify(f.trial.probation.archive) + '\n');
  const history = structuredClone(f.trial.probation.history);
  history.files = history.files.map(ref => { const id = ref.evidence[0]; save(id, ref.bytes); return {file: ref.file, sha256: ref.sha256, evidence: id}; });
  save('history', JSON.stringify(history)); save('scripted', JSON.stringify(f.trial.scripted));
  f.trial.probation = {archiveEvidence: 'original', historyEvidence: 'history'}; f.trial.scripted = {packetEvidence: 'scripted'};
  fs.writeFileSync(path.join(root, 'trial.json'), JSON.stringify(f.trial, null, 2));
  fs.writeFileSync(path.join(root, 'events.jsonl'), f.events.map(e => JSON.stringify(e)).join('\n'));
  const args = [path.join(installed, 'bin/evaluate-canary-soak.mjs'), '--events', path.join(root, 'events.jsonl'), '--trial', path.join(root, 'trial.json'),
    '--probation-output', path.join(root, 'probation-stage.json')];
  const result = spawnSync(process.execPath, args, {encoding: 'utf8'});
  fs.writeFileSync(path.join(root, 'execution.json'), JSON.stringify({executable: process.execPath, node: process.version, args, exit: result.status, stderr: result.stderr}));
  fs.writeFileSync(path.join(root, 'assessment.json'), result.stdout);
  assert.equal(result.status, 0, result.stderr);
  const r = JSON.parse(result.stdout); assert.equal(r.status, 'PASS', JSON.stringify(r.issues)); assert.equal(r.offerEligible, true); assert.deepEqual(r.issues, []);
  assert.equal(r.counts.all_started, 13); assert.equal(r.counts.completed_ordinary, 10); assert.equal(r.counts.source_units, 3);
  assert.equal(r.counts.turnover_links['R-3'], 'R-2'); assert.equal(r.counts.turnover_links['R-2'], 'R-1');
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'probation-stage.json'))).archive.sha256, f.trial.evidence.original.sha256);
  // Changed bytes must be refused by the shipped reader before any stage exists.
  fs.appendFileSync(path.join(root, 'history-0.json'), ' ');
  const altered = spawnSync(process.execPath, args.slice(0, -2), {encoding: 'utf8'});
  fs.writeFileSync(path.join(root, 'changed-bytes-execution.json'), JSON.stringify(altered));
  assert.equal(altered.status, 1); assert.match(altered.stderr, /evidence digest mismatch/);
});

rejected('wrong current candidate', f => f.trial.candidate.commit = '0'.repeat(40), 'FAIL');
rejected('wrong sealed recovery tuple', f => f.trial.recovery.tuple.inventorySha256 = '0'.repeat(64), 'FAIL');
rejected('absent original authority', f => f.events.splice(0, 1));
rejected('forged successor authority', f => f.events.find(e => e.text?.startsWith('Brain probation successor')).by = 'borrowed', 'FAIL');
rejected('another trial extension', f => f.events.find(e => e.type === 'line-service.probation-successor-authorized').trial = 'other', 'FAIL');
rejected('disconnected extension history', f => f.events.find(e => e.type === 'line-service.probation-successor-switched').previous_seq = 2, 'FAIL');
rejected('changed archive hashes', f => f.trial.probation.history.files[0].sha256 = '0'.repeat(64), 'FAIL');
rejected('ended authority', f => { f.events.push({seq: ++f.trial.window.through_seq, at: at(5000), type: 'line-service.probation-completed', id: 'trial-one'}); });
rejected('withdrawn authority', f => { f.events.push({seq: ++f.trial.window.through_seq, at: at(5000), type: 'line-service.probation-withdrawn', id: 'trial-one'}); });
rejected('partial refused UNKNOWN handoff', f => { const a = structuredClone(f.trial.probation.history.files[0]); a.file += '.unknown'; f.trial.probation.history.files.push(a); }, 'FAIL');
rejected('missing extension authority', f => { f.events = f.events.filter(e => e.type !== 'line-service.probation-successor-authorized'); }, 'FAIL');
rejected('insufficient active duration', f => f.trial.pauses = proof({complete: true, intervals: [{project: 'BCH', from: at(100), until: at(200), owner: 'BCH', reason: 'external pause'}]}), 'INCOMPLETE');
rejected('failed extra start', f => {
  f.events.push({seq: ++f.trial.window.through_seq, at: at(5000), type: 'run.started', id: 'R-extra', item: 'ENG-extra', meta: {dispatch_project: f.trial.project}},
    {seq: ++f.trial.window.through_seq, at: at(5001), type: 'report.ingested', run: 'R-extra', report: {outcome: 'failed'}});
}, 'FAIL');
rejected('late unobserved start', f => f.events.push({seq: ++f.trial.window.through_seq, at: at(5000), type: 'run.started', id: 'R-extra', item: 'ENG-extra', meta: {dispatch_project: f.trial.project}}), 'INCOMPLETE');
rejected('missing endpoint', f => f.trial.controller.samples.pop(), 'INCOMPLETE');
rejected('missing common turn', f => delete f.trial.runs[0].turns.close, 'INCOMPLETE');
rejected('missing causal chain', f => { for (const r of f.trial.runs) delete r.queue.freedBy; }, 'INCOMPLETE');
rejected('missing shared proof', f => delete f.trial.runs[0].shared, 'INCOMPLETE');
rejected('refused manual rescue', f => f.trial.rescues.actions.push({outcome: 'refused', action: 'manual input'}), 'FAIL');
rejected('native safety violation', f => f.trial.safety.violations.push({guard: 'native', outcome: 'refused'}), 'FAIL');
rejected('duplicate shared notice', f => f.trial.runs[0].shared.duplicates++, 'FAIL');
rejected('duplicate report', f => f.events.push({...f.events.find(e => e.type === 'report.ingested'), seq: ++f.trial.window.through_seq}), 'FAIL');
rejected('absent automatic retirement', f => { f.events = f.events.filter(e => !(e.type === 'closeout.effect' && e.run === 'R-1')); }, 'INCOMPLETE');
rejected('original failed review is retained', f => f.events.find(e => e.type === 'report.ingested' && e.run === 'R-11').report.extra.verdict = 'FAIL', 'INCOMPLETE');

test('reordered extension events refuse rather than normalize history', () => {
  const f = successorFixture(), i = f.events.findIndex(e => e.type === 'line-service.probation-successor-authorized');
  [f.events[i], f.events[i + 1]] = [f.events[i + 1], f.events[i]];
  assert.throws(() => evaluateSoak(f), /strictly increasing/);
});

test('slow automatic cleanup remains measured with raw timings and all retirement proof', () => {
  const f = fixture();
  for (const e of f.events) if (e.run === 'R-13' || e.completed_run === 'R-13') {
    if (['item.closed', 'closeout.effect', 'closeout.evaluated'].includes(e.type)) e.at = at(2000);
  }
  const r = assess('slow-cleanup', f); assert.equal(r.status, 'PASS', JSON.stringify(r.issues));
  for (const k of ['report_to_closed', 'report_to_session_release', 'report_to_folder_removed']) {
    assert.equal(r.cleanupTargets[k].exceeded, 1); assert.equal(r.latency[k].max_ms, 420000);
  }
});

test('clipped overlapping BCH pauses subtract union only from active duration', () => {
  const f = fixture(); f.trial.window.cutoff = at(6000);
  for (const field of ['controller', 'host']) f.trial[field].samples.at(-1).at = at(6000);
  f.trial.rescues.cutoff = at(6000);
  f.trial.pauses = proof({complete: true, intervals: [[-100, 200], [100, 300], [5700, 6200], [7000, 7100]].map(([a, b]) =>
    ({project: 'BCH', from: at(a), until: at(b), reason: 'planned external pause', owner: 'BCH'}))});
  const r = assess('pause-union', f); assert.equal(r.status, 'PASS', JSON.stringify(r.issues));
  assert.equal(r.exposure.raw_ms, 6000000); assert.equal(r.exposure.paused_ms, 600000); assert.equal(r.exposure.active_ms, 5400000);
  assert.equal(r.latency.report_to_ingest.max_ms, 2000);
});

test('BCH pauses never forgive hard ingestion or input timing', () => {
  for (const kind of ['ingestion', 'input']) {
    const f = fixture();
    f.trial.pauses = proof({complete: true, intervals: [{project: 'BCH', from: at(0), until: at(100), owner: 'BCH', reason: 'pause'}]});
    if (kind === 'ingestion') f.events.find(e => e.type === 'report.available').observed_at = at(50);
    else { const r = f.trial.runs[0]; r.queue.inputAt = at(300); f.events.find(e => e.type === 'run.session_bound').prompted_at = at(300); }
    const r = assess('hard-' + kind, f); assert.equal(r.status, 'FAIL'); assert.ok(r.issues.some(i => i.code === 'latency'));
  }
});
