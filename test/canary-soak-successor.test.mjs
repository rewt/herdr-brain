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
import {at, proof, fixture, bindSavedEvidence, saveSoakOriginals} from './helpers/soak-fixture.mjs';
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
  saveSoakOriginals(f, save);
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
  const capacityFile = path.join(root, 'capacity-job-0.json'), originalCapacity = fs.readFileSync(capacityFile);
  fs.appendFileSync(capacityFile, ' ');
  const changedCapacity = spawnSync(process.execPath, args.slice(0, -2), {encoding: 'utf8'});
  fs.writeFileSync(path.join(root, 'changed-capacity-execution.json'), JSON.stringify(changedCapacity));
  assert.equal(changedCapacity.status, 1); assert.match(changedCapacity.stderr, /evidence digest mismatch/);
  fs.writeFileSync(capacityFile, originalCapacity);
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
rejected('duplicate report', f => f.events.push({...f.events.find(e => e.type === 'report.ingested' && e.run === 'R-1'), seq: ++f.trial.window.through_seq}), 'FAIL');
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
  const r = assess('slow-cleanup', bindSavedEvidence(f)); assert.equal(r.status, 'PASS', JSON.stringify(r.issues));
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

test('BCH pauses preserve hard ingestion and measured input timing', () => {
  for (const kind of ['ingestion', 'input']) {
    const f = fixture();
    f.trial.pauses = proof({complete: true, intervals: [{project: 'BCH', from: at(0), until: at(100), owner: 'BCH', reason: 'pause'}]});
    if (kind === 'ingestion') f.events.find(e => e.type === 'report.available').observed_at = at(50);
    else { const r = f.trial.runs[0]; r.queue.inputAt = at(300); f.events.find(e => e.type === 'run.session_bound').prompted_at = at(300); }
    const r = assess('hard-' + kind, f);
    if (kind === 'ingestion') { assert.equal(r.status, 'FAIL'); assert.ok(r.issues.some(i => i.code === 'latency')); }
    else { assert.equal(r.issues.some(i => i.code === 'latency'), false); assert.equal(r.inputTargets.eligible_free_to_input.exceeded, 1); assert.equal(r.latency.eligible_free_to_input.max_ms, 181000); }
  }
});

function savedPacket(f, id, mutate) {
  const value = JSON.parse(f.trial.capacity.saved[id]); mutate(value);
  const bytes = JSON.stringify(value); f.trial.capacity.saved[id] = bytes; f.trial.evidence[id].sha256 = digest(bytes);
}
function originalJob(f, run, mutate, reseal = true) {
  const ref = f.trial.capacity.journalRefs.find(ref => JSON.parse(f.trial.capacity.saved[ref.evidence]).run === run);
  savedPacket(f, ref.evidence, job => {
    mutate(job);
    if (reseal) { const {id, ...payload} = job.capacityAllocation; job.capacityAllocation.id = digest(JSON.stringify(payload)); }
    const row = f.trial.runs.find(r => r.run === run);
    if (row) Object.assign(row.queue, {allocation: structuredClone(job.capacityAllocation), freedBy: job.capacityAllocation.freedBy, freeAt: job.capacityAllocation.freeAt});
  });
}
function rebind(f) {
  const old = new Map(f.events.map(e => [e, e.seq]));
  f.events.sort((a, b) => Date.parse(a.at) - Date.parse(b.at) || a.seq - b.seq);
  const seqs = new Map(f.events.map((e, i) => [old.get(e), i + 1]));
  for (const e of f.events) {
    e.seq = seqs.get(old.get(e));
    for (const k of ['started_seq', 'claim_generation']) if (e[k]) e[k] = seqs.get(e[k]);
    if (e.source?.seq) e.source.seq = seqs.get(e.source.seq);
    for (const resource of Object.values(e.resources ?? {})) if (resource.receipt) resource.receipt.seq = seqs.get(resource.receipt.seq);
  }
  for (const r of f.trial.runs) { r.startedSeq = seqs.get(r.startedSeq); r.claimGeneration = seqs.get(r.claimGeneration); }
  f.trial.window.start_seq = f.events.filter(e => Date.parse(e.at) < Date.parse(f.trial.window.from)).at(-1).seq;
  f.trial.window.through_seq = f.events.at(-1).seq;
  return bindSavedEvidence(f);
}

test('logical turnovers survive physical overlap and expose carry-in debt without a cap failure', () => {
  let f = fixture();
  for (const [run, end] of [['R-seed-build', 200], ['R-1', 400], ['R-2', 410]])
    for (const e of f.events) if (e.run === run && ['closeout.effect', 'closeout.evaluated'].includes(e.type)) e.at = at(end + (e.type === 'closeout.evaluated' ? 1 : 0));
  f = rebind(f);
  const root = JSON.parse(f.trial.capacity.saved['capacity-job-0']);
  savedPacket(f, f.trial.capacity.censusEvidence, census => census.resources.push({run: root.run, allocation: root.capacityAllocation.id,
    capacity: root.capacityAllocation.capacity, startedAt: at(-100), session: 'present', tab: 'present', folder: 'present'}));
  const before = structuredClone(f), r = assess('logical-overlap-debt', f);
  assert.equal(r.status, 'PASS', JSON.stringify(r.issues)); assert.deepEqual(f, before); assert.deepEqual(evaluateSoak(f), r);
  assert.equal(r.counts.all_started, 13); assert.equal(r.counts.reviews, 3); assert.equal(r.exposure.active_ms, 5400000);
  assert.equal(r.counts.turnover_links['R-2'], 'R-1'); assert.equal(r.counts.turnover_links['R-3'], 'R-2');
  const pool = r.capacity.pools.find(p => p.capacity.pool === 'build');
  assert.equal(pool.physical.opening, 1); assert.equal(pool.physical.peak, 3); assert.equal(pool.physical.cutoff, 0);
  assert.equal(pool.debt.opening, 1); assert.equal(pool.debt.peak, 3); assert.equal(pool.debt.cutoff, 0);
  assert.equal(pool.debt.created, 10); assert.equal(pool.debt.resolved, 11); assert.equal(pool.debt.oldest_known_age_ms, null);
  assert.equal(r.latency.report_to_folder_removed.max_ms, 260000);
  assert.equal(pool.debt.opening_oldest_known_age_ms, 90000);
  assert.equal(r.capacity.coverage.complete, true); assert.equal(r.issues.some(i => i.code === 'capacity-admission'), false);
});

test('equal release/start wall times use the immutable event sequence', () => {
  const move = (f, release) => {
    const times = {'report.available': release - 2, 'report.ingested': release, 'item.closed': release + 2, 'closeout.effect': release + 3, 'closeout.evaluated': release + 4};
    for (const e of f.events) if ((e.run ?? e.completed_run) === 'R-1' && times[e.type]) {
      e.at = at(times[e.type]); if (e.type === 'report.available') e.observed_at = e.at;
    }
  };
  let f = fixture(); move(f, 240);
  f = rebind(f); const r = assess('equal-report-start', f);
  assert.equal(r.counts.turnover_links['R-2'], 'R-1');
  // Original release is after the start but before allocator selection: valid
  // admission proof, without the requested start-after-report turnover.
  f = fixture(); move(f, 241);
  f = rebind(f); const later = assess('post-start-release', f);
  assert.equal(later.issues.some(i => i.code === 'capacity-allocation'), false);
  assert.equal(later.counts.turnover_links['R-2'], undefined);
});

for (const [name, mutate] of [
  ['seq', a => a.freedBy.seq++], ['hash', a => a.freedBy.sha256 = 'forged'], ['run', a => a.freedBy.run = 'R-foreign'],
  ['type', a => a.freedBy.type = 'item.closed'], ['freeAt', a => a.freeAt = at(1)],
  ['predecessor id', a => a.predecessor.id = 'foreign'], ['predecessor journal', a => a.predecessor.journal = '/foreign'],
  ['pool', a => a.capacity.pool = 'decision'], ['slot', a => a.slot = 2], ['project', a => a.capacity.project = '/foreign/.git'],
  ['record', a => a.capacity.org = '/foreign'], ['generation', a => a.allocation.claim_generation++],
  ['cycle', a => a.predecessor = {id: a.id, journal: a.allocation.journal}]
]) test('native allocation rejects forged ' + name, () => {
  const f = fixture(); originalJob(f, 'R-2', job => mutate(job.capacityAllocation));
  const r = assess('forged-allocation-' + name.replaceAll(' ', '-'), f);
  assert.equal(r.status, 'FAIL'); assert.ok(r.issues.some(i => i.code === 'capacity-allocation' && i.run === 'R-2'));
  assert.equal(r.counts.turnover_links['R-2'], undefined);
});

test('duplicate sibling consumption is visible outside the selected turnover runs', () => {
  const f = fixture();
  originalJob(f, 'R-10', job => {
    const a = f.trial.runs[1].queue.allocation;
    Object.assign(job.capacityAllocation, {predecessor: a.predecessor, freedBy: a.freedBy, freeAt: a.freeAt});
  });
  const r = assess('duplicate-sibling', f); assert.equal(r.status, 'FAIL');
  assert.ok(r.issues.some(i => i.code === 'capacity-allocation' && /already selected/.test(i.reason)));
});

test('missing original, inventory and carry-in proof stays incomplete instead of accepting inline overrides', () => {
  for (const [index, mutate] of [
    f => delete f.trial.capacity.saved['capacity-job-0'],
    f => f.trial.capacity.complete = false,
    f => savedPacket(f, 'capacity-inventory', i => i.journals.pop()),
    f => savedPacket(f, 'capacity-census', c => c.complete = false),
    f => { f.trial.capacity.complete = false; f.trial.capacity.journalRefs.shift(); }
  ].entries()) {
    const f = fixture(); mutate(f); f.trial.capacity.journals = [{capacityAllocation: f.trial.runs[0].queue.allocation}];
    const r = assess('missing-original-' + index, f);
    assert.equal(r.status, 'INCOMPLETE', JSON.stringify(r.issues)); assert.equal(r.capacity.coverage.complete, false); assert.equal(r.capacity.coverage.peak_lower_bound, true);
    assert.deepEqual(r.counts.turnover_links, {});
  }
});

test('roots retain unknown timing and review/carry-in/reset links supply no ordinary turnover', () => {
  const f = fixture(); originalJob(f, 'R-1', job => Object.assign(job.capacityAllocation, {predecessor: null, freeAt: null, freedBy: null}));
  const r = assess('unknown-root', f);
  assert.ok(r.issues.some(i => i.code === 'timing-unknown' && i.run === 'R-1'));
  assert.equal(r.counts.turnover_links['R-1'], undefined);
  assert.equal(r.counts.turnover_links['R-11'], undefined); assert.equal(r.counts.turnover_links['R-seed-build'], undefined);
  const g = fixture(); originalJob(g, 'R-2', job => { job.capacityAllocation.reset_after = {id: 'abandoned', journal: '/missing', source: {type: 'run.abandoned', seq: 1, run: 'R-old'}}; });
  assert.equal(assess('forged-reset', g).offerEligible, false);
});

test('missing held future retirement or physical absence never earns ordinary turnover credit', () => {
  for (const mode of ['absent', 'held', 'time', 'seq', 'physical']) {
    const f = fixture(), effect = f.events.find(e => e.type === 'closeout.effect' && e.run === 'R-2' && e.effect === 'folder');
    if (mode === 'absent') f.events = f.events.filter(e => e !== effect);
    if (mode === 'held') { effect.outcome.action = 'kept'; }
    if (mode === 'time') effect.at = at(6000);
    if (mode === 'seq') f.trial.window.through_seq = effect.seq - 1;
    if (mode === 'physical') f.trial.runs[1].physical.after.folder = 'unknown';
    const r = assess('retirement-' + mode, f);
    assert.equal(r.offerEligible, false); assert.equal(r.counts.turnover_links['R-2'], undefined); assert.equal(r.counts.turnover_links['R-3'], undefined);
  }
});

test('process-only learning reports actual watcher RSS and deliveries and withholds the offer', () => {
  const f = fixture(); f.trial.purpose = 'process-learning';
  for (const row of f.trial.runs) {
    delete row.shared;
    row.process = proof({mode: 'process', watcherRssBytes: 21000000, noticeLatencyMs: 50, expectedNoticeIds: ['notice-' + row.run], deliveredNoticeIds: ['notice-' + row.run]});
  }
  const r = assess('process-learning', f);
  assert.equal(r.offerEligible, false); assert.equal(r.status, 'INCOMPLETE'); assert.equal(r.learning.sharedCoverage, 'UNPROVED');
  assert.equal(r.learning.operational_completed_ordinary, 10); assert.equal(r.learning.turnover_links['R-3'], 'R-2');
  assert.equal(r.learning.process[0].watcherRssBytes, 21000000); assert.equal(r.shared.memory[0].per_run_watcher_rss_bytes, null);
  assert.ok(r.issues.some(i => i.code === 'shared-observer'));
  f.trial.runs[0].process.watcherRssBytes = 0;
  assert.ok(evaluateSoak(f).issues.some(i => i.code === 'process-observer'));
  f.trial.runs[0].process.deliveredNoticeIds.push('notice-R-1');
  assert.equal(evaluateSoak(f).status, 'FAIL');
});

test('real-shaped late session binding and separate item closure retain truthful endpoint diagnostics', () => {
  let f = fixture();
  const binding = f.events.find(e => e.type === 'run.session_bound' && e.run === 'R-1');
  delete binding.session;
  assert.ok(evaluateSoak(f).issues.some(i => i.code === 'physical-binding'));
  binding.session = 'native-R-1'; assert.equal(evaluateSoak(f).status, 'PASS');
  // A real general-pass item closure can be outside the finite resource turn.
  const id = 'turn-R-1', packet = f.trial.turnWitnesses.find(p => p.evidence[0] === id);
  const w = JSON.parse(packet.bytes), closed = f.events.find(e => e.completed_run === 'R-1');
  w.before.record.seq = closed.seq; w.before.at = closed.at;
  packet.bytes = JSON.stringify(w); f.trial.evidence[id].sha256 = digest(packet.bytes);
  const r = assess('separate-item-close', f), turn = r.learning.turns.find(t => t.run === 'R-1');
  assert.equal(r.offerEligible, false); assert.equal(turn.same_resource_turn, true); assert.equal(turn.same_offer_turn, false);
  assert.equal(turn.source_close_before_original_verdict, true); assert.equal(turn.item_closed.seq, closed.seq);
  // An identical string label without original fence/key/project joins is no proof.
  w.project = '/foreign'; packet.bytes = JSON.stringify(w); f.trial.evidence[id].sha256 = digest(packet.bytes);
  assert.equal(evaluateSoak(f).learning.turns[0].same_resource_turn, false);
});

test('input target misses retain raw values under load while unknown or absent automatic input remains incomplete', () => {
  for (const contaminated of [false, true]) {
    const f = fixture(); f.trial.host.contaminated = contaminated;
    f.trial.runs[0].queue.inputAt = at(300); f.events.find(e => e.type === 'run.session_bound' && e.run === 'R-1').prompted_at = at(300);
    const r = assess('measured-input-' + contaminated, f);
    assert.equal(r.status, 'PASS', JSON.stringify(r.issues)); assert.equal(r.inputTargets.eligible_free_to_input.exceeded, 1);
    assert.equal(r.latency.eligible_free_to_input.max_ms, 181000); assert.equal(r.counts.completed_ordinary, 10);
  }
  for (const value of [null, 'malformed', at(1)]) {
    const f = fixture(); f.trial.runs[0].queue.inputAt = value;
    f.events.find(e => e.type === 'run.session_bound' && e.run === 'R-1').prompted_at = value;
    const r = assess('unknown-input-' + String(value).replaceAll(/[^a-z0-9]/g, '-'), f);
    assert.equal(r.offerEligible, false); assert.equal(r.inputTargets.eligible_free_to_input.unknown, 1);
    assert.ok(r.issues.some(i => i.code === 'timing-unknown'));
  }
});

test('physical overlap is descriptive but actual logical over-admission stays adverse', () => {
  const f = fixture();
  f.events.find(e => e.type === 'report.ingested' && e.run === 'R-1').at = at(300);
  originalJob(f, 'R-2', job => Object.assign(job.capacityAllocation, {predecessor: null, freeAt: null, freedBy: null}));
  const r = assess('logical-admission-violation', f);
  assert.equal(r.status, 'FAIL'); assert.ok(r.issues.some(i => i.code === 'capacity-admission'));
});

test('incomplete or unverified correction declarations never discharge offer obligations', () => {
  for (const value of [proof({complete: false, pending: []}), {complete: true, pending: [], evidence: ['unverified']}, proof({complete: true, pending: ['Major']})]) {
    const f = fixture(); f.trial.corrections = value;
    const r = assess('corrections-' + String(value.complete) + '-' + value.evidence[0] + '-' + value.pending.length, f);
    assert.equal(r.offerEligible, false); assert.ok(r.issues.some(i => i.code === 'corrections'));
  }
});

test('matching but forged turn labels do not replace the original witnessed IDs', () => {
  const f = fixture(); Object.assign(f.trial.runs[0].turns, {close: 'forged', session: 'forged', folder: 'forged'});
  const r = assess('forged-turn-labels', f);
  assert.equal(r.offerEligible, false); assert.ok(r.issues.some(i => i.code === 'turn-binding' && i.run === 'R-1'));
  assert.equal(r.learning.turns[0].claimed_turns_match, false);
});
