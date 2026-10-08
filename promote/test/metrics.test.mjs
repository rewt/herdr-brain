import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { collectMetrics, parseLog, importBaseline, renderMetrics, stats } from '../metrics.mjs';

const cli = fileURLToPath(new URL('../metrics.mjs', import.meta.url));
const recordCLI = fileURLToPath(new URL('../../bin/org.mjs', import.meta.url));
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'train-metrics-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const repo = path.join(root, 'project'); fs.mkdirSync(repo);
  const git = (args, cwd = repo) => {
    const r = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8', env: { ...process.env,
      GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.test',
      GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.test' } });
    assert.equal(r.status, 0, r.stderr); return r.stdout.trim();
  };
  git(['init', '-q', '-b', 'main']);
  fs.mkdirSync(path.join(repo, 'test')); fs.writeFileSync(path.join(repo, 'test/bad.test.mjs'), 'old');
  git(['add', '.']); git(['commit', '-qm', 'base']); const base = git(['rev-parse', 'HEAD']);
  git(['checkout', '-qb', 'lane/bad']); fs.writeFileSync(path.join(repo, 'test/bad.test.mjs'), 'new');
  git(['add', '.']); git(['commit', '-qm', 'bad']); const head = git(['rev-parse', 'HEAD']); git(['checkout', '-q', 'main']);
  const identity = fs.realpathSync(path.join(repo, '.git')), directory = path.join(identity, 'promote/batches');
  const bad = { id: 'bad', topic: 'bad', sourceHead: head }, good = { id: 'good', topic: 'good', sourceHead: base };
  function gate(id, code = 0, seconds = 10, extra = {}, log = '') {
    const logPath = path.join(identity, `${id}.log`); fs.writeFileSync(logPath, log);
    return { command: 'npm run test:promotion', started_at: '2026-10-05T12:00:00Z', finished_at: '2026-10-05T12:00:10Z',
      duration_s: seconds, exit_code: code, signal: null, reused: false, log: logPath,
      log_hash: createHash('sha256').update(JSON.stringify(log)).digest('hex'), ...extra };
  }
  function write(id, attempts = [], extra = {}) {
    const dir = path.join(directory, id); fs.mkdirSync(dir, { recursive: true });
    const plan = { schema: 'promotion-train/v1', identity, id, started_at: '2026-10-05T12:00:00Z', phase: 'complete',
      jobs: [bad, good], attempts, results: {}, ...extra };
    fs.writeFileSync(path.join(dir, 'train.json'), JSON.stringify(plan)); return plan;
  }
  const attempt = (jobs, gate, phase = 'complete') => ({ jobs, ids: jobs.map(j => j.id), base, gate, phase });
  return { root, repo, identity, git, gate, write, attempt, bad, good,
    metrics: options => collectMetrics({ project: repo, ...options }),
    cli: args => spawnSync(process.execPath, [cli, '--project', repo, ...args], { encoding: 'utf8' }) };
}
const redLog = `> sample@1 test:checks
> node --test test/bad.test.mjs test/good.test.mjs
TAP version 13
# Subtest: broken
not ok 1 - broken
  ---
  duration_ms: 123
  location: 'test/bad.test.mjs:3:1'
  ...
1..1
# duration_ms 2000
`;

test('known batch clocks split queue, slot, external lock, prepare and command time per lane', t => {
  const f = fixture(t), at = seconds => new Date(Date.parse('2026-10-05T12:00:00Z') + seconds * 1000).toISOString();
  const jobs = [{ ...f.bad, queued: at(-30) }, { ...f.good, queued: at(-15) }];
  const execution = path.join(f.root, 'execution.json');
  fs.writeFileSync(execution, JSON.stringify({ command_started: true, started_at: at(26), finished_at: at(46) }));
  const gate = f.gate('timed', 0, 25, { started_at: at(21), finished_at: at(46),
    slot_receipt: path.join(f.root, 'slot.json'), execution_receipt: execution });
  f.write('timed', [{ ...f.attempt(jobs, gate), prepare: { started_at: at(16), finished_at: at(25) } }],
    { jobs, slot_granted_at: at(15), external_lock_required: true, external_lock_started_at: at(1), external_lock_granted_at: at(5) });
  const m = f.metrics();
  assert.equal(m.schema, 'train-metrics/v1');
  assert.deepEqual(m.batches[0].timing, { queue_wait_s: 30, slot_wait_s: 15, external_lock_wait_s: 4, prepare_time_s: 9, gate_time_s: 20 });
  assert.deepEqual(m.lanes.map(l => l.timing), [m.batches[0].timing, { ...m.batches[0].timing, queue_wait_s: 15 }]);
  assert.equal(m.gates[0].command_time_s, 20);
  assert.equal(m.summary.phase_time_s.slot_wait_s.total, 15);
  assert.match(renderMetrics(m), /lane\/good: queue_wait=15.00s; slot_wait=15.00s; external_lock_wait=4.00s; prepare_time=9.00s; gate_time=20.00s/);
});

test('old receipts retain gate measurements while missing phase clocks are unknown, never zero', t => {
  const f = fixture(t); f.write('old', [f.attempt([f.bad, f.good], f.gate('old', 0, 12))]);
  const m = f.metrics();
  assert.deepEqual(m.batches[0].timing, { queue_wait_s: null, slot_wait_s: null, external_lock_wait_s: null, prepare_time_s: null, gate_time_s: 12 });
  assert.ok(m.lanes.every(l => l.timing.slot_wait_s === null && l.timing.prepare_time_s === null));
  assert.deepEqual(m.summary.phase_time_s.slot_wait_s, { samples: 0, total: null, median: null, max: null, unknown: 1 });
  assert.equal(m.batches[0].external_lock_required, null);
  assert.match(renderMetrics(m), /slot_wait=unknown; external_lock_wait=unknown; prepare_time=unknown/);
});

test('bisection and resume phase totals follow attempt membership without charging reused proofs', t => {
  const f = fixture(t), prep = { started_at: '2026-10-05T12:00:00Z', finished_at: '2026-10-05T12:00:03Z' };
  f.write('split', [
    { ...f.attempt([f.bad, f.good], f.gate('both-timing', 1, 10), 'red'), prepare: prep, prepare_history: [prep] },
    { ...f.attempt([f.bad], f.gate('bad-timing', 1, 4), 'red'), prepare: prep },
    { ...f.attempt([f.good], f.gate('good-timing', 0, 5)), prepare: prep },
    { ...f.attempt([f.good], f.gate('cached-timing', 0, 100, { reused: true })), prepare: prep },
  ], { external_lock_required: false });
  const m = f.metrics();
  assert.equal(m.batches[0].timing.prepare_time_s, 15); assert.equal(m.batches[0].timing.gate_time_s, 19);
  assert.deepEqual(m.lanes.map(l => [l.lane, l.timing.prepare_time_s, l.timing.gate_time_s]), [['bad', 9, 14], ['good', 12, 15]]);
  assert.equal(m.batches[0].external_lock_required, false); assert.equal(m.batches[0].timing.external_lock_wait_s, null);
});

test('unfinished and reversed phase intervals do not become zero or partial totals', t => {
  const f = fixture(t), start = '2026-10-05T12:00:00Z';
  f.write('partial', [{ ...f.attempt([f.bad], f.gate('partial', 0, 2)),
    prepare: { started_at: start }, prepare_history: [{ started_at: start, finished_at: '2026-10-05T12:00:03Z' }] }],
    { jobs: [{ ...f.bad, queued: 'invalid' }], slot_granted_at: '2026-10-05T11:59:59Z' });
  const m = f.metrics(); assert.equal(m.batches[0].timing.queue_wait_s, null);
  assert.equal(m.batches[0].timing.slot_wait_s, null); assert.equal(m.batches[0].timing.prepare_time_s, null);
});

test('bisected red batches count gate executions rather than per-lane outcomes and attribute changed files', t => {
  const f = fixture(t);
  f.write('bisected', [f.attempt([f.bad, f.good], f.gate('both', 1, 20, {}, redLog), 'red'),
    f.attempt([f.bad], f.gate('bad', 1, 10, {}, redLog), 'red'),
    f.attempt([f.good], f.gate('good', 0, 30))], { results: { bad: { outcome: 'refused' }, good: { outcome: 'promoted' } } });
  const m = f.metrics();
  assert.equal(m.summary.gates_executed, 3); assert.equal(m.summary.green, 1); assert.equal(m.summary.red, 2);
  assert.equal(m.summary.bisected_batches, 1); assert.deepEqual(m.summary.gate_time_s, { samples: 3, median: 20, total: 60, max: 30 });
  assert.equal(m.summary.lanes_per_gate.total, 4); assert.equal(m.summary.first_pass.rate, 0);
  assert.equal(m.red_attribution[0].isolated_lane, null); assert.equal(m.red_attribution[1].isolated_lane, 'bad');
  assert.deepEqual(m.red_attribution[0].attribution[0].lanes, ['bad']);
  assert.deepEqual(m.red_attribution[0].failing_steps, ['test:checks']);
  assert.equal(m.slowest_test_groups[0].median, 2); assert.equal(m.slowest_test_files.length, 0);
});

test('unfinished, signalled, exception and refused receipts stay separate from completed gates and first-pass rate', t => {
  const f = fixture(t);
  f.write('running', [f.attempt([f.bad], { command: 'paused', started_at: '2026-10-05T12:00:00Z' }, 'prepared')], { phase: 'validating' });
  f.write('interrupted', [f.attempt([f.bad], f.gate('signal', null, 4, { signal: 'SIGTERM' }), 'red')], { phase: 'validating' });
  f.write('exception', [f.attempt([f.bad], f.gate('exception', undefined, 5, { exit_code: undefined, error: 'lost receipt' }), 'invalid')]);
  f.write('refused', [], { results: { bad: { outcome: 'refused', reason: 'dirty' } } });
  const m = f.metrics({ now: '2026-10-05T12:01:00Z' });
  assert.equal(m.summary.gates_observed, 3); assert.equal(m.summary.gates_executed, 1); assert.equal(m.summary.gates_completed, 0);
  assert.equal(m.summary.unfinished, 1); assert.equal(m.summary.interrupted, 1); assert.equal(m.summary.unknown, 1);
  assert.equal(m.summary.batches_without_gate, 1); assert.equal(m.summary.first_pass.rate, null);
  assert.equal(m.summary.first_pass.unknown, 3); assert.equal(m.summary.gate_time_s.samples, 0);
  assert.equal(m.gates.find(g => g.command === 'paused').elapsed_s, 60); assert.equal(m.red_attribution.length, 0);
});

test('cached and duplicated green proofs never inflate gate time or executions', t => {
  const f = fixture(t), g = f.gate('shared', 0, 42);
  f.write('original', [f.attempt([f.good], g)]);
  f.write('reuse', [f.attempt([f.good], { ...g, reused: true })]);
  f.write('duplicate', [f.attempt([f.good], g)]);
  const m = f.metrics();
  assert.equal(m.summary.gates_executed, 1); assert.equal(m.summary.reused, 1); assert.equal(m.summary.duplicate_evidence, 1);
  assert.equal(m.summary.gate_time_s.total, 42); assert.equal(m.summary.first_pass.rate, 1);
});

test('window uses batch start, including bisection outside the window; missing clocks and foreign receipts are visible', t => {
  const f = fixture(t);
  f.write('before', [], { started_at: '2026-10-04T23:59:59Z' });
  f.write('inside', [f.attempt([f.good], f.gate('after', 0, 3, { started_at: '2026-10-06T00:01:00Z' }))]);
  f.write('end', [], { started_at: '2026-10-06T00:00:00Z' });
  f.write('missing', [], { started_at: undefined });
  f.write('foreign', [], { identity: '/another/.git' });
  const m = f.metrics({ since: '2026-10-05', until: '2026-10-06' });
  assert.deepEqual(m.batches.map(b => b.id), ['inside']); assert.equal(m.summary.gates_executed, 1);
  assert.equal(m.warnings.length, 2);
  assert.throws(() => f.metrics({ since: 'yesterday' }), /ISO/);
  assert.throws(() => f.metrics({ since: '2026-10-06', until: '2026-10-05' }), /precede/);
  assert.throws(() => f.metrics({ since: '2026-10-05T12:00:00' }), /timezone/);
});

test('linked worktrees read the same canonical receipts; text and JSON commands make no changes', t => {
  const f = fixture(t); f.write('green', [f.attempt([f.good], f.gate('green'))]);
  const linked = path.join(f.root, 'linked'); f.git(['worktree', 'add', '-qb', 'lane/metrics', linked]);
  const snapshot = dir => fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => {
    const p = path.join(dir, e.name); return e.isDirectory() ? snapshot(p) : [[p, fs.readFileSync(p).toString('base64')]];
  });
  const before = snapshot(f.repo), branch = f.git(['rev-parse', 'HEAD']);
  const r = f.cli(['--json']); assert.equal(r.status, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout).summary.gates_executed, 1);
  assert.equal(collectMetrics({ project: linked }).identity, f.identity);
  assert.match(f.cli([]).stdout, /First-pass green.*1\/1 = 100.0%/);
  assert.equal(f.cli(['--bad']).status, 1); assert.equal(f.cli(['--since']).status, 1);
  assert.deepEqual(snapshot(f.repo), before); assert.equal(f.git(['rev-parse', 'HEAD']), branch);
});

test('missing and altered gate logs cannot supply attribution or durations; combined train log is not assigned to a red attempt', t => {
  const f = fixture(t), g = f.gate('changed', 1, 10, {}, redLog);
  fs.appendFileSync(g.log, 'changed');
  f.write('changed', [f.attempt([f.bad], g, 'red')]);
  f.write('missing', [f.attempt([f.bad], { ...g, log: '/no-such-metrics-fixture.log' }, 'red')]);
  const p = f.write('combined', [f.attempt([f.bad], { ...g, log: undefined }, 'red')]);
  fs.writeFileSync(path.join(f.identity, 'promote/batches', p.id, 'train.log'), redLog);
  const m = f.metrics();
  assert.equal(m.warnings.length, 3); assert.equal(m.slowest_steps.length, 0);
  assert.ok(m.red_attribution.every(r => r.attribution.length === 0));
});

test('TAP and Vitest timings keep test streams and identifiable files separate and strip ANSI', () => {
  const p = parseLog(`> sample@1 validate:unit /repo
> node --test test/single.test.mjs
TAP version 13
# Subtest: nested suite
    ok 1 - inner
      duration_ms: 999
ok 1 - nested suite
  duration_ms: 1200
# duration_ms 1500
> sample@1 validate:vitest /repo
\u001b[32m ✓ test/fast.test.ts (2 tests) 25ms\u001b[0m
 ❯ test/red.test.ts (1 test | 1 failed) 2s
 Duration 2.4s (transform 100ms)
`, ['/repo']);
  assert.deepEqual(p.steps.map(s => s.duration_s), [1.5, 2.4]);
  assert.deepEqual(p.files.map(f => [f.name, f.duration_s]), [['test/single.test.mjs', 1.5], ['test/fast.test.ts', 0.025], ['test/red.test.ts', 2]]);
  assert.deepEqual(p.failing_files, ['test/red.test.ts']);
  const labels = parseLog('> node --test test/a.test.mjs test/b.test.mjs\nTAP version 13\n# Subtest: /repo/test/a.test.mjs\nok 1 - /repo/test/a.test.mjs\n  duration_ms: 1000\n# duration_ms 1100\n', ['/repo']);
  assert.equal(labels.files.length, 1); assert.equal(labels.groups.length, 0);
  const glob = parseLog('> node --test test/*.test.mjs\nTAP version 13\n# duration_ms 1100\n');
  assert.equal(glob.files.length, 0); assert.equal(glob.groups[0].name, 'test/*.test.mjs');
});

test('slowest steps sum sequential streams per gate rather than treating streams as whole steps', t => {
  const f = fixture(t), log = '> sample@1 test:unit\nTAP version 13\n# duration_ms 1000\nTAP version 13\n# duration_ms 2000\n';
  f.write('one', [f.attempt([f.good], f.gate('one', 0, 4, {}, log))]);
  f.write('two', [f.attempt([f.good], f.gate('two', 0, 8, {}, log.replace('2000', '6000')))]);
  const m = f.metrics();
  assert.equal(m.slowest_steps[0].samples, 2); assert.equal(m.slowest_steps[0].median, 5);
});

test('unattributed failures and unavailable Git history remain explicit hints', t => {
  const f = fixture(t), log = redLog.replaceAll('test/bad.test.mjs', 'test/untouched.test.mjs');
  f.write('untouched', [f.attempt([f.bad], f.gate('untouched', 1, 2, {}, log), 'red')]);
  f.write('missing-history', [f.attempt([{ ...f.bad, sourceHead: '0'.repeat(40) }], f.gate('history', 1, 2, {}, redLog), 'red')]);
  const m = f.metrics();
  const untouched = m.red_attribution.find(r => r.batch === 'untouched').attribution[0];
  assert.deepEqual(untouched.lanes, []); assert.deepEqual(untouched.unavailable, []);
  assert.deepEqual(m.red_attribution.find(r => r.batch === 'missing-history').attribution[0].unavailable, ['bad']);
});

test('malformed receipts are skipped with evidence rather than crashing the project report', t => {
  const f = fixture(t);
  f.write('bad', [null]); f.write('good', [f.attempt([f.good], f.gate('ok'))]);
  const dir = path.join(f.identity, 'promote/batches/json'); fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, 'train.json'), '{');
  const m = f.metrics(); assert.equal(m.summary.batches, 1); assert.equal(m.warnings.length, 2);
});

test('empty projects return unavailable rates and medians instead of invented zero timings', t => {
  const f = fixture(t), m = f.metrics();
  assert.equal(m.summary.batches, 0); assert.equal(m.summary.first_pass.rate, null);
  assert.equal(m.summary.gate_time_s.median, null); assert.match(renderMetrics(m), /unavailable/);
  assert.equal(stats([1, 3, 100, null]).median, 3);
});

test('archived baseline imports read-only with selection bias and lower bounds separate from the current window', t => {
  const f = fixture(t), report = path.join(f.root, 'ENG-949.md'), evidence = path.join(f.root, 'ENG-949-evidence');
  fs.writeFileSync(report, '## First baseline: `gate-report --backfill archive/scratch-manifests/` (read-only)\n');
  fs.mkdirSync(evidence); const evidenceFile = path.join(evidence, 'backfill-report.txt');
  const source = `gate report: 54 runs (0 recorded, 54 backfilled)
gates run (green + red): 54 (promote 54, promote-batch 0; 4 narrow)
gate time, backfilled full gates (lower bound, first vitest start to last vitest end): median 10m23s, total 10h19m over 50 gates

slowest 15 steps by median ([in-log]):
    median max total runs fails name
     3m38s 16m56s 4h10m 47 0 validate:pool-action-modules [in-log]

slowest 15 test files by median (node:test runs of several files are listed together):
    median max total runs fails name
     2m39s 4m37s 2h13m 50 0 packages/slow.test.ts

most frequent failing files:
  (none)
`;
  fs.writeFileSync(evidenceFile, source);
  const b = importBaseline(report);
  assert.equal(b.full_gate_time_s.median, 623); assert.equal(b.gates, 54); assert.equal(b.narrow_gates, 4);
  assert.equal(b.first_pass_rate, null); assert.equal(b.slowest_steps[0].median_s, 218);
  assert.equal(b.slowest_test_files[0].name, 'packages/slow.test.ts');
  const r = f.cli(['--baseline', report, '--since', '2026-10-05', '--json']); assert.equal(r.status, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout).baseline.runs, 54); assert.equal(fs.readFileSync(evidenceFile, 'utf8'), source);
  assert.match(f.cli(['--baseline', report]).stdout, /archive selection/);
  fs.writeFileSync(evidenceFile, 'broken'); assert.throws(() => importBaseline(report), /unsupported/);
});

test('train metrics can include run waits and legacy missing counts without changing either window basis', t => {
  const f = fixture(t), org = path.join(f.root, 'org');
  const env = { ...process.env, ORG_DIR: org, ORG_ACTOR: 'metrics-fixture', HERDR_MONITOR_FLEET: path.join(f.root, 'fleet.json'), ORG_NOW: '2026-10-05T12:00:00Z' };
  const record = args => {
    const r = spawnSync(process.execPath, [recordCLI, ...args], { env, cwd: f.repo, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
  };
  record(['init']); record(['add', 'Legacy dispatch', '--role', 'engineer']); record(['start', 'ENG-1', '--meta', 'lane=legacy']);
  f.write('batch', [f.attempt([f.good], f.gate('gate'))]);
  const m = f.metrics({ org });
  assert.equal(m.summary.gates_completed, 1);
  assert.equal(m.run_timing.summary.runs, 1);
  assert.equal(m.run_timing.summary.dispatch_wait_s.missing, 1);
  assert.equal(m.run_timing.summary.process_end_missing, 1);
  assert.match(renderMetrics(m), /Run timing: 1 runs/);
  assert.match(m.window.basis, /batch started_at/); assert.match(m.run_timing.window.basis, /run started.at/);
  const r = f.cli(['--org', org, '--since', '2026-10-05', '--until', '2026-10-06', '--json']);
  assert.equal(r.status, 0, r.stderr); assert.equal(JSON.parse(r.stdout).run_timing.summary.runs, 1);
  assert.equal(f.metrics({ org, since: '2026-10-06' }).run_timing.summary.runs, 0);
});
