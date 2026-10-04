import test from 'node:test';
import assert from 'node:assert/strict';
import { batchPipeline, runPipeline, lifecycleRuns, pipelineDuration } from '../modern/pipelines.mjs';
import { trainFacts } from '../modern/feed.mjs';

const at = seconds => new Date(Date.parse('2026-10-04T17:00:00Z') + seconds * 1000).toISOString();
const now = Date.parse(at(180));
const gate = { started_at: at(30), finished_at: at(90), duration_s: 60, exit_code: 0, signal: null };
const batch = { id: 'b', started_at: at(10), phase: 'complete', jobs: [{ id: 'j', topic: 'one', run: 'R-1', queued: at(0) }],
  attempts: [{ ids: ['j'], jobs: [{ id: 'j' }], phase: 'complete', gate, integrated_at: at(95) }] };
const statuses = links => Object.fromEntries(links.map(l => [l.id.split(':').at(-1), l.status]));
const find = (links, stage) => links.find(l => l.id.endsWith(`:${stage}`));

test('a delivered green batch chains all stages, with only recorded clocks', () => {
  const links = batchPipeline({ batch, results: [{ id: 'j', outcome: 'promoted', finished: at(110), delivered: true }] });
  assert.deepEqual(statuses(links), { queued: 'done', rebase: 'done', ci: 'done', 'fast-forward': 'done', close: 'done', notify: 'done' });
  assert.equal(pipelineDuration(find(links, 'queued'), now), '10s');
  assert.equal(pipelineDuration(find(links, 'ci'), now), '1m 0s');
  for (const stage of ['rebase', 'fast-forward', 'close', 'notify']) assert.equal(pipelineDuration(find(links, stage), now), 'unknown');
  assert.ok(links.every(l => l.open.kind === 'batch-link' && l.open.batch === 'b'));
});

test('real prepared checkpoints use the live batch phase and advance only an in-flight check', () => {
  const b = { ...batch, phase: 'validating', attempts: [{ phase: 'prepared', gate: { started_at: at(30), command: 'offline' } }] };
  const facts = trainFacts({ current: { id: 'b', phase: 'batching', jobs: batch.jobs } }, [b]);
  assert.equal(facts.current.phase, 'validating');
  const links = batchPipeline({ batch: b, current: facts.current });
  assert.equal(find(links, 'ci').status, 'running');
  assert.equal(pipelineDuration(find(links, 'ci'), now), '2m 30s');
  assert.equal(pipelineDuration(find(links, 'ci'), now + 5000), '2m 35s');
  assert.equal(find(links, 'fast-forward').status, 'waiting');
  assert.equal(pipelineDuration(find(batchPipeline({ batch }), 'ci'), now + 5000), '1m 0s');
});

test('queued and legacy batches do not invent start clocks', () => {
  const links = batchPipeline({ batch: { id: 'b', phase: 'pending', jobs: batch.jobs } });
  assert.ok(links.every(l => l.status === 'waiting' && pipelineDuration(l, now) === 'unknown'));
  const legacy = batchPipeline({ batch: { id: 'b', phase: 'validating', attempts: [{ phase: 'prepared' }] }, current: { id: 'b', phase: 'validating' } });
  assert.equal(find(legacy, 'ci').status, 'running'); assert.equal(pipelineDuration(find(legacy, 'ci'), now), 'unknown');
  assert.equal(pipelineDuration({ status: 'done', started_at: at(60), finished_at: at(10) }, now), 'unknown');
  assert.equal(pipelineDuration({ status: 'done', duration_s: -1 }, now), 'unknown');
});

test('red CI and rebase refusals sit on the refusing link and skip unreached integration', () => {
  const red = { ...gate, exit_code: 1 };
  let links = batchPipeline({ batch: { ...batch, attempts: [{ phase: 'red', ids: ['j'], gate: red }] }, results: [
    { id: 'j', topic: 'one', outcome: 'refused', reason: 'batch validation failed (exit 1)', gate: red, finished: at(110), delivered: true },
  ] });
  assert.equal(find(links, 'ci').status, 'failed'); assert.match(find(links, 'ci').detail, /one: batch validation failed/);
  assert.equal(find(links, 'fast-forward').status, 'skipped'); assert.equal(find(links, 'notify').status, 'done');
  links = batchPipeline({ batch: { ...batch, attempts: [{ phase: 'complete', ids: [] }] }, results: [
    { id: 'j', outcome: 'refused', reason: 'rebase replay refused: conflict' },
  ] });
  assert.equal(find(links, 'rebase').status, 'failed'); assert.match(find(links, 'rebase').detail, /conflict/);
  assert.equal(find(links, 'ci').status, 'skipped');
});

test('a post-CI refusal marks fast-forward; mixed batches retain both failure and successful downstream links', () => {
  const refused = { id: 'j', outcome: 'refused', reason: 'main moved after CI', gate };
  let links = batchPipeline({ batch: { ...batch, attempts: [{ phase: 'invalid', ids: ['j'], gate }] }, results: [refused] });
  assert.equal(find(links, 'ci').status, 'done'); assert.equal(find(links, 'fast-forward').status, 'failed');
  links = batchPipeline({ batch, results: [{ ...refused, reason: 'rebase replay refused: conflict' },
    { id: 'other', outcome: 'promoted', finished: at(120), delivered: true }] });
  assert.equal(find(links, 'rebase').status, 'failed'); assert.equal(find(links, 'fast-forward').status, 'done');
  assert.equal(find(links, 'close').status, 'done');
});

test('interrupted gates stop counting and resumed batches supersede stale interruption notices', () => {
  const b = { ...batch, phase: 'validating', attempts: [{ phase: 'prepared', gate: { started_at: at(30) } }] };
  const stopped = batchPipeline({ batch: b, interrupted: true, results: [{ outcome: 'interrupted' }] });
  assert.equal(find(stopped, 'ci').status, 'failed'); assert.equal(pipelineDuration(find(stopped, 'ci'), now + 100000), 'unknown');
  const resumed = batchPipeline({ batch: b, current: { id: 'b', phase: 'validating' }, results: [{ outcome: 'interrupted' }] });
  assert.equal(find(resumed, 'ci').status, 'running');
  const delivering = batchPipeline({ batch: b, current: { id: 'b', phase: 'batch-delivering', error: 'interrupted' }, results: [{ outcome: 'interrupted' }] });
  assert.equal(find(delivering, 'ci').status, 'failed'); assert.equal(find(delivering, 'notify').status, 'running');
});

test('close and delivery receipts remain distinct from integration, including retained lanes and undelivered notices', () => {
  const promoted = { outcome: 'promoted', integrated_at: at(95) };
  let links = batchPipeline({ batch, current: { phase: 'completed' }, results: [promoted] });
  assert.equal(find(links, 'fast-forward').status, 'done'); assert.equal(find(links, 'close').status, 'running');
  assert.equal(find(links, 'notify').status, 'running');
  const facts = trainFacts({ current: { id: 'b', phase: 'completed', deliveredCount: 0,
    results: [{ job: batch.jobs[0], result: promoted }] } }, [batch]);
  links = batchPipeline({ batch, current: facts.current, results: facts.results });
  assert.equal(find(links, 'close').status, 'done'); assert.equal(find(links, 'notify').status, 'running');
  links = batchPipeline({ batch, results: [{ ...promoted, finished: at(120), delivered: false, warnings: ['lane close: retained for inspection'] }] });
  assert.equal(find(links, 'close').status, 'failed'); assert.match(find(links, 'close').detail, /retained/);
  assert.equal(find(links, 'notify').status, 'failed');
  links = batchPipeline({ batch, results: [{ ...promoted, finished: at(120), delivered: true, warnings: ['velocity record: record lock held'] }] });
  assert.equal(find(links, 'close').status, 'done');
});

const runs = [1, 2, 3, 9].map((n, i) => ({ id: `R-${n}`, item: 'ENG-1', started: { at: at(i * 100) },
  report: n === 3 ? null : { at: at(i * 100 + 60), outcome: 'done' } }));
const settlements = new Map([
  ['R-1', { fixRun: 'R-2', review: { verdict: 'NEEDS-WORK' } }],
  ['R-2', { result: { fix: { run: 'R-3' } }, review: { verdict: 'FAIL', started_at: at(160), finished_at: at(180) } }],
]);

test('multi-round lifecycle follows explicit correction receipts in either direction and excludes unrelated runs', () => {
  assert.deepEqual(lifecycleRuns(runs[1], runs, settlements).map(r => r.id), ['R-1', 'R-2', 'R-3']);
  const links = runPipeline({ run: runs[1], runs, settlements });
  assert.deepEqual(links.map(l => l.label), ['Dispatch', 'Engineering', 'Report', 'Review', 'Fix 1 · R-2', 'Report · R-2', 'Review 2',
    'Fix 2 · R-3', 'Report · R-3', 'Review 3', 'Train', 'Landed', 'Release candidate']);
  assert.equal(links.find(l => l.id === 'run:R-1:review').status, 'failed');
  assert.equal(links.find(l => l.id === 'run:R-2:review').status, 'failed');
  assert.equal(pipelineDuration(links.find(l => l.id === 'run:R-2:review'), now), '20s');
  assert.equal(links.find(l => l.id === 'run:R-3:engineering').status, 'running');
  assert.equal(links.find(l => l.id === 'run:R-3:report').status, 'waiting');
});

test('dispatch journals join correction rounds; cycles and other items never extend the chain', () => {
  const dispatches = new Map([['R-2', { fromRun: 'R-1' }], ['R-3', { fromRun: 'R-2' }]]);
  assert.deepEqual(lifecycleRuns(runs[2], runs, new Map(), dispatches).map(r => r.id), ['R-1', 'R-2', 'R-3']);
  const cyclic = new Map([...settlements, ['R-3', { fixRun: 'R-1' }]]);
  assert.equal(new Set(lifecycleRuns(runs[0], runs, cyclic).map(r => r.id)).size, 3);
  assert.deepEqual(lifecycleRuns(runs[0], [runs[0], { ...runs[1], item: 'ENG-2' }], settlements).map(r => r.id), ['R-1']);
});

test('run links open matching evidence, exact candidate membership and failed or interrupted gate results', () => {
  const run = runs[0], promotion = { id: 'j', run: run.id, outcome: 'promoted', tip: 'commit', queued: at(70), integrated_at: at(100) };
  const candidate = { id: 'RC-1', identity: '/git', commit: 'later', commits: ['commit'], started: { at: at(110) },
    gate: { result: 'passed', at: at(170) } };
  const derive = candidates => runPipeline({ run, runs: [run], train: { results: [promotion] }, candidates, identity: '/git' });
  let links = derive([candidate]);
  assert.equal(find(links, 'train').open.kind, 'result'); assert.equal(find(links, 'landed').status, 'done');
  assert.equal(find(links, 'candidate').open.candidate, 'RC-1'); assert.equal(pipelineDuration(find(links, 'candidate'), now), '1m 0s');
  for (const result of ['failed', 'interrupted']) assert.equal(find(derive([{ ...candidate, gate: { result } }]), 'candidate').status, 'failed');
  assert.equal(find(derive([{ ...candidate, identity: '/other' }]), 'candidate').open.candidate, undefined);
  assert.equal(find(derive([{ ...candidate, commits: [] }]), 'candidate').status, 'waiting');
  const failed = runPipeline({ run, runs: [run], train: { results: [{ ...promotion, outcome: 'refused' }] } });
  assert.equal(find(failed, 'train').status, 'failed'); assert.equal(find(failed, 'landed').status, 'skipped'); assert.equal(find(failed, 'candidate').status, 'skipped');
});

test('pending dispatch, running review and abandoned engineering have distinct statuses and honest durations', () => {
  const run = { ...runs[0], report: null };
  let links = runPipeline({ run, runs: [run], dispatches: new Map([[run.id, { stage: 'prompting' }]]) });
  assert.equal(find(links, 'dispatch').status, 'running'); assert.equal(pipelineDuration(find(links, 'dispatch'), now), 'unknown');
  assert.equal(find(links, 'engineering').status, 'waiting');
  links = runPipeline({ run: runs[0], runs, settlements: new Map([[run.id, { stage: 'reviewing' }]]) });
  assert.equal(find(links, 'review').status, 'running'); assert.equal(pipelineDuration(find(links, 'review'), now), 'unknown');
  const abandoned = { ...run, abandoned: { at: at(50) } };
  links = runPipeline({ run: abandoned, runs: [abandoned] });
  assert.equal(find(links, 'engineering').status, 'failed'); assert.equal(pipelineDuration(find(links, 'engineering'), now), '50s');
  for (const stage of ['report', 'review', 'train', 'landed', 'candidate']) assert.equal(find(links, stage).status, 'skipped');
});

test('run lifecycle follows a resumed or newly queued train instead of its stale interrupted or refused result', () => {
  const run = runs[0], old = { id: 'old', run: run.id, outcome: 'interrupted' };
  const activeBatch = { ...batch, phase: 'validating' };
  let links = runPipeline({ run, runs: [run], train: { results: [old], batches: [activeBatch], current: { id: 'b' } } });
  assert.equal(find(links, 'train').status, 'running'); assert.equal(find(links, 'train').open.kind, 'batch');
  links = runPipeline({ run, runs: [run], train: { results: [{ ...old, outcome: 'refused' }], batches: [batch],
    waiting: [{ id: 'new', run: run.id, topic: 'one', queued: at(100) }] } });
  assert.equal(find(links, 'train').status, 'waiting'); assert.equal(find(links, 'train').open.job, 'new');
});
