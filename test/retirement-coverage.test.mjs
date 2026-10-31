import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fixture as soakFixture, proof, at} from './helpers/soak-fixture.mjs';
import {digest} from '../measurement/canary-soak.mjs';
import {canonical} from '../messages/schema.mjs';
import {duties, nudgeEntries, evaluateRetirement, retirementCheckpoint} from '../measurement/retirement-coverage.mjs';
import {copyProduct} from '../lib/product-files.mjs';

function fixture() {
  const f = soakFixture({order: [1, 11, 2, 3, 4, 5, 6, 7, 8, 9, 10, 12, 13]});
  const {events, trial} = f, w = trial.window;
  const authority = {type: 'note.added', id: 'ENG-window', at: at(-.5), by: 'actual-planning-owner', decision: true};
  events.push(authority); events.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  const seqs = new Map(events.map((e, i) => [e.seq, i + 1]));
  for (const [i, e] of events.entries()) {
    e.seq = i + 1;
    if (e.source) e.source.seq = seqs.get(e.source.seq);
    if (e.authority) e.authority = seqs.get(e.authority);
    for (const r of Object.values(e.resources ?? {})) if (r.receipt) r.receipt.seq = seqs.get(r.receipt.seq);
  }
  for (const r of trial.runs) {r.startedSeq = seqs.get(r.startedSeq); r.claimGeneration = seqs.get(r.claimGeneration);}
  trial.probation.archive.authority = seqs.get(trial.probation.archive.authority);
  w.start_seq = authority.seq; w.through_seq = events.at(-1).seq;
  const manifest = {schema: 'brain.retirement-input/v1', fixtureOnly: true, project: trial.project, candidate: trial.candidate,
    configSha256: digest('exact installed config bytes'), configEvidence: 'config',
    evidence: {config: {path: 'config.json', sha256: digest('exact installed config bytes')}}, window: w,
    record: {path: '/fixture/.org', start_seq: w.start_seq, through_seq: w.through_seq, events_sha256: ''},
    plan: {authoritySeq: authority.seq, authorityOwner: authority.by, eligibleItems: trial.runs.filter(r => r.kind === 'ordinary').map(r => `ENG-${r.run.slice(2)}`),
      normalOwners: ['line-service', 'finite-planner', 'finite-observer', 'actual-planning-owner'], recoveryOwner: 'accepted-SR3-owner',
      observerOwner: 'finite-observer', checkInAt: at(5500), checkInRecord: '/fixture/.org/ENG-window'}};
  const report = run => events.find(e => e.type === 'report.ingested' && e.run === run);
  const cleanup = run => events.find(e => e.type === 'closeout.effect' && e.effect === 'folder' && e.run === run);
  const q = events.find(e => e.type === 'item.added' && e.id === 'REV-11');
  q.meta = {review_source_run: 'R-1', review_target: {reportHash: report('R-1').sha256, head: trial.runs[0].source.head}};
  const observations = {
    planning: proof({recoveryAccepted: true, observerIndependent: true, unitMixAccepted: true}),
    absence: proof({...w, complete: true, segments: [proof({from: w.from, cutoff: w.cutoff, nativeComplete: true, standingSessions: [], candidate: trial.candidate, configSha256: manifest.configSha256})]}),
    nudges: proof({schema: 'lifecycle.manual-nudge', from: w.from, cutoff: w.cutoff, complete: true, actions: [],
      entries: Object.fromEntries(nudgeEntries.map(entry => [entry, proof({complete: true, from: w.from, cutoff: w.cutoff})])),
      future: {coverage: 'UNRUN; not credited to current interval'}, historicalTotal: null}),
    effects: proof({complete: true, lost: 0, duplicates: 0, rows: []}),
    callbacks: proof({complete: true, rows: []}), obligations: proof({complete: true, rows: []}),
    checks: [proof({id: 'negative', status: 'PASS'}), proof({id: 'recovery', status: 'PASS'})],
    duties: duties.map(id => proof({id, owner: 'line-service', mode: ['D03', 'D05', 'D07', 'D08', 'D11', 'D13', 'D15'].includes(id) ? 'live' : 'scripted',
      runs: ['R-1', 'R-11', 'R-2'], negative: 'negative', recovery: 'recovery'})),
    handovers: [proof({fromRun: 'R-1', toRun: 'R-11', kind: 'producer-review', reportSeq: report('R-1').seq, causeSeq: q.seq,
      context: proof({recordOnly: true, reportSha256: report('R-1').sha256})}),
    proof({fromRun: 'R-11', toRun: 'R-2', kind: 'next-work', reportSeq: report('R-11').seq, causeSeq: cleanup('R-11').seq,
      context: proof({recordOnly: true, reportSha256: report('R-11').sha256, causal: true})})]
  };
  const input = {events, trial, manifest, observations, verifiedEvidence: ['saved', 'config'], soakEvidence: f.verifiedEvidence};
  seal(input);
  return JSON.parse(JSON.stringify(input));
}

// Rebind the exact planned interval after deliberate fixture changes. Never
// manufacture a new passing artifact to replace a failed installed packet.
function seal(f) {
  const {manifest: m, events} = f;
  const scope = {project: m.project, record: m.record.path, candidate: m.candidate, configSha256: m.configSha256, window: m.window, plan: m.plan};
  events.find(e => e.seq === m.plan.authoritySeq).text = `Brain absence window authorized: ${digest(canonical(scope))}`;
  m.record.events_sha256 = digest(JSON.stringify(events.filter(e => e.seq <= m.window.through_seq && Date.parse(e.at) <= Date.parse(m.window.cutoff))));
}
const has = (r, code) => r.issues.some(i => i.code === code);
const evaluate = f => evaluateRetirement(f);

test('saved mixed cohort joins existing soak/lifecycle, two fresh causal handovers and all duties without mutations', () => {
  const f = fixture(), before = structuredClone(f), r = evaluate(f);
  assert.equal(r.status, 'READY', JSON.stringify(r.issues)); assert.equal(r.soak.status, 'PASS');
  assert.deepEqual(r.counts, {ordinary: 10, review: 3, fix: 0, observation: 0, handovers: 2});
  assert.equal(r.soak.lifecycle.hand_nudges.total, null); assert.equal(r.nudgeCoverage.historicalTotal, null);
  assert.equal(r.soak.layers.stable.liveAcceptance, 'UNRUN'); assert.deepEqual(f, before);
});

const negatives = {
  'absent nudge coverage': f => delete f.observations.nudges,
  'future journal cannot fill a missing current entry': f => delete f.observations.nudges.entries.prompt,
  'manual assistance': f => f.observations.nudges.actions.push({stage: 'review-hand-filing', actor: 'other-chat'}),
  'legacy supervisor callback': f => f.observations.callbacks.rows.push(proof({id: 'original', recipient: 'supervisor-herdr', owner: 'original-owner', next: 'original delivery', disposition: 'sent'})),
  'UNKNOWN effect': f => f.observations.effects.rows.push(proof({id: 'original', owner: 'original-owner', next: 'inspect original receipt', status: 'UNKNOWN'})),
  'mixed candidate': f => f.observations.absence.segments[0].candidate.commit = 'f'.repeat(40),
  'mixed configuration': f => f.observations.absence.segments[0].configSha256 = 'f'.repeat(64),
  'missing configuration bytes': f => f.verifiedEvidence = ['saved'],
  'lost native coverage': f => f.observations.absence.segments[0].nativeComplete = false,
  'endpoint snapshots only': f => f.observations.absence.segments = [],
  'sleeping supervisor still present': f => f.observations.absence.segments[0].standingSessions.push({session: 'standing', state: 'sleeping'}),
  'unowned obligation': f => f.observations.obligations.rows.push(proof({id: 'unowned', status: 'open'})),
  'lost effect': f => f.observations.effects.lost = 1,
  'duplicate effect': f => f.observations.effects.duplicates = 1,
  'unrun control': f => f.observations.checks[0].status = 'UNRUN',
  'failed control': f => f.observations.checks[0].status = 'FAIL',
  'open Major': f => f.observations.obligations.rows.push(proof({id: 'Major', owner: 'fixer', next: 'specific check', severity: 'Major', status: 'open'})),
  'unexercised duty': f => f.observations.duties[0].mode = 'unexercised',
  'record-only context missing': f => f.observations.handovers[1].context.recordOnly = false,
  'unrelated handovers': f => f.observations.handovers[1].fromRun = 'R-12',
  'resumed session': f => f.events.find(e => e.type === 'run.session_bound' && e.run === 'R-11').session = 'native-R-1',
  'forged report context': f => f.observations.handovers[0].context.reportSha256 = 'other report',
  'missing demand': f => f.manifest.plan.eligibleItems = [],
  'unaccepted SR3 recovery': f => f.observations.planning.recoveryAccepted = false,
  'observer depends on dead line': f => f.observations.planning.observerIndependent = false,
  'short interval': f => f.trial.window.cutoff = at(5000),
  'unknown report clock': f => delete f.events.find(e => e.type === 'report.available').observed_at,
  'missing native cleanup receipt': f => delete f.events.find(e => e.type === 'closeout.evaluated').resources.folder.receipt,
  'late authority': f => f.events.find(e => e.seq === f.manifest.plan.authoritySeq).at = at(1)
};
for (const [name, mutate] of Object.entries(negatives)) test(`cannot return ready: ${name}`, () => {
  const f = fixture(); mutate(f); const r = evaluate(f);
  assert.notEqual(r.status, 'READY'); assert.equal(r.ready, false);
});

test('actual journal event uses occurrence time and retains intervening actor and recorder', () => {
  const f = fixture(), e = {seq: ++f.trial.window.through_seq, at: at(5300), type: 'lifecycle.manual-nudge',
    project: f.trial.project, run: 'R-1', actor: 'assisting-owner', by: 'actual-recorder', nudge_id: 'original-prompt', occurred_at: at(240), stage: 'prompt', action: 'prompt', reason: 'stalled', evidence: 'saved'};
  f.events.push(e); f.manifest.window.through_seq = f.trial.window.through_seq;
  f.manifest.record.through_seq = f.trial.window.through_seq; seal(f);
  const r = evaluate(f); assert.equal(r.status, 'FAIL'); assert.ok(has(r, 'manual-assistance'));
  assert.deepEqual(r.nudgeCoverage.recorded, [e]);
});

test('review fixes do not inflate ordinary units; failed/unrun and censored clocks remain visible', () => {
  const f = fixture(); f.events.find(e => e.type === 'item.added' && e.id === 'ENG-10').meta = {review_fix_of: 'original-review'};
  const r = evaluate(f); assert.equal(r.counts.ordinary, 9); assert.equal(r.counts.fix, 1); assert.ok(has(r, 'ordinary-sample'));
  const g = fixture(); delete g.events.find(e => e.type === 'report.available').observed_at;
  const result = evaluate(g); assert.equal(result.soak.runs[0].lifecycle.latency.report_to_ingest.ms, null);
  assert.ok(result.soak.latency.report_to_ingest.unknown > 0);
});

function saveInputs(root, f) {
  const save = (table, id, file, bytes) => {fs.writeFileSync(path.join(root, file), bytes); table[id] = {path: file, sha256: digest(bytes)};};
  f.trial.evidence = {};
  save(f.trial.evidence, 'saved', 'raw-fixture-observations.json', JSON.stringify({fixtureOnly: true, description: 'scripted native/Git and duty controls; no real retirement acceptance'}));
  save(f.trial.evidence, 'probation', 'probation.json', JSON.stringify(f.trial.probation.archive));
  f.events.find(e => e.type === 'line-service.probation-authorized').archive.sha256 = f.trial.evidence.probation.sha256;
  save(f.trial.evidence, 'scripted', 'installed-canary.json', JSON.stringify(f.trial.scripted));
  f.trial.probation = {archiveEvidence: 'probation'}; f.trial.scripted = {packetEvidence: 'scripted'};
  seal(f); f.manifest.evidence = {saved: f.trial.evidence.saved};
  save(f.manifest.evidence, 'config', 'config.json', 'exact installed config bytes');
  save(f.manifest.evidence, 'trial', 'trial.json', JSON.stringify(f.trial));
  save(f.manifest.evidence, 'events', 'events.jsonl', f.events.map(e => JSON.stringify(e)).join('\n') + '\n');
  save(f.manifest.evidence, 'observations', 'retirement-observations.json', JSON.stringify(f.observations));
  Object.assign(f.manifest, {trialEvidence: 'trial', eventsEvidence: 'events', observationsEvidence: 'observations'});
  fs.writeFileSync(path.join(root, 'retirement.json'), JSON.stringify(f.manifest, null, 2) + '\n');
}

test('copied CLI verifies original inputs and resumes interrupted evaluation against identical immutable input', t => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'retirement-coverage-')));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  const previousFleet = process.env.HERDR_MONITOR_FLEET; process.env.HERDR_MONITOR_FLEET = path.join(root, 'fleet.json');
  t.after(() => {if (previousFleet === undefined) delete process.env.HERDR_MONITOR_FLEET; else process.env.HERDR_MONITOR_FLEET = previousFleet;});
  const installed = path.join(root, 'installed'); copyProduct(path.resolve(import.meta.dirname, '..'), installed);
  const f = fixture(); saveInputs(root, f);
  const run = (...args) => spawnSync(process.execPath, [path.join(installed, 'bin/evaluate-retirement.mjs'), '--manifest', path.join(root, 'retirement.json'), ...args], {encoding: 'utf8'});
  const files = () => Object.fromEntries(fs.readdirSync(root).filter(n => n.endsWith('.json') || n.endsWith('.jsonl')).map(n => [n, digest(fs.readFileSync(path.join(root, n)))]));
  const before = files(), first = run(); assert.equal(first.status, 0, first.stderr); assert.equal(JSON.parse(first.stdout).status, 'READY'); assert.deepEqual(files(), before);
  const checkpoint = run('--checkpoint'); assert.equal(checkpoint.status, 0, checkpoint.stderr);
  fs.writeFileSync(path.join(root, 'checkpoint.json'), checkpoint.stdout);
  // Stop at the pure checkpoint boundary; a fresh invocation resumes, with no
  // worker/service process killed and no project state or saved inputs changed.
  const frozen = files(), resumed = run('--resume', path.join(root, 'checkpoint.json'));
  assert.equal(resumed.status, 0, resumed.stderr); assert.equal(resumed.stdout, first.stdout); assert.deepEqual(files(), frozen);
  if (process.env.RETIREMENT_WITNESS_DIR) {
    fs.mkdirSync(process.env.RETIREMENT_WITNESS_DIR, {recursive: true});
    for (const file of Object.keys(frozen)) fs.copyFileSync(path.join(root, file), path.join(process.env.RETIREMENT_WITNESS_DIR, file));
    fs.writeFileSync(path.join(process.env.RETIREMENT_WITNESS_DIR, 'coverage.json'), first.stdout);
    fs.writeFileSync(path.join(process.env.RETIREMENT_WITNESS_DIR, 'resumed-coverage.json'), resumed.stdout);
    const controls = {};
    for (const [name, mutate] of Object.entries(negatives)) {const x = fixture(); mutate(x); const r = evaluate(x); controls[name] = {status: r.status, ready: r.ready, issues: r.issues};}
    fs.writeFileSync(path.join(process.env.RETIREMENT_WITNESS_DIR, 'negative-controls.json'), JSON.stringify(controls, null, 2) + '\n');
  }
  f.manifest.configSha256 = 'f'.repeat(64); fs.writeFileSync(path.join(root, 'retirement.json'), JSON.stringify(f.manifest));
  const changed = run('--resume', path.join(root, 'checkpoint.json')); assert.equal(changed.status, 1); assert.match(changed.stderr, /immutable checkpoint/);
  fs.appendFileSync(path.join(root, 'events.jsonl'), ' ');
  const corrupted = run(); assert.equal(corrupted.status, 1); assert.match(corrupted.stderr, /digest mismatch/);
});

test('pure checkpoint refuses drift and evaluation is deterministic without a checkpoint', () => {
  const f = fixture(), token = retirementCheckpoint(f), first = evaluate(f);
  assert.deepEqual(evaluateRetirement(f, token), first); f.observations.nudges.complete = false;
  assert.throws(() => evaluateRetirement(f, token), /immutable checkpoint/);
});
