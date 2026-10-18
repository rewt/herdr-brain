import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { collectCycleTime, renderCycleTime, publishCycleTime } from '../cycle-time.mjs';
import { receiptDirectory } from '../context.mjs';
import { projectSummary, writeProjectSummary } from '../../lib/project-summary.mjs';
import { fold } from '../../lib/state.mjs';

const cli = fileURLToPath(new URL('../cycle-time.mjs', import.meta.url));
const at = seconds => new Date(Date.parse('2026-10-10T00:00:00Z') + seconds * 1000).toISOString();
function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cycle-time-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const repo = path.join(root, 'project'), org = path.join(root, 'org');
  fs.mkdirSync(repo); fs.mkdirSync(org);
  const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.test', GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.test' };
  const git = args => {
    const r = spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8', env }); assert.equal(r.status, 0, r.stderr); return r.stdout.trim();
  };
  git(['init', '-q', '-b', 'main']); git(['commit', '--allow-empty', '-qm', 'fixture']);
  const identity = fs.realpathSync(path.join(repo, '.git')), events = [];
  const write = (file, value) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(value)); };
  const event = (second, value) => { const e = { seq: events.length + 1, at: at(second), by: 'fixture', ...value }; events.push(e); return e; };
  const save = () => fs.writeFileSync(path.join(org, 'events.jsonl'), events.map(e => JSON.stringify(e) + '\n').join(''));
  function run(number, { item = `ENG-${number}`, start = 0, report = 10 } = {}) {
    if (!events.some(e => e.type === 'item.added' && e.id === item)) event(start, { type: 'item.added', id: item, title: `Work ${item}`, role: 'engineer' });
    const id = `R-${number}`;
    event(start, { type: 'run.started', id, item, report_path: path.join(org, 'missing', id), meta: { lane: 'fixture' } });
    if (report !== null) {
      event(report, { type: 'report.ingested', run: id, item, report: { run: id, outcome: 'done' } });
      event(report, { type: 'note.added', id, text: `Fast path timing: ${JSON.stringify({ clocks: { report: at(report) } })}` });
    }
    return { id, item };
  }
  const review = (r, { start = 20, end = 30, extra = {} } = {}) => write(path.join(org, 'settle', `${r.id}.json`),
    { run: r.id, item: r.item, org, common: identity, review_started_at: start === null ? null : at(start),
      review_finished_at: end === null ? null : at(end), review: { verdict: 'PASS' }, round: 1, reviewPolicy: { round: 1 }, ...extra });
  function train(r, { batch = `b-${r.id}`, queue = 40, gateStart = 50, gateEnd = 70, main = 80, extra = {}, attempts } = {}) {
    const job = { id: `j-${batch}`, topic: 'fixture', run: r.id, org, queued: queue === null ? null : at(queue) };
    const gate = { started_at: at(gateStart), finished_at: at(gateEnd), command_started_at: at(gateStart), command_finished_at: at(gateEnd),
      duration_s: gateEnd - gateStart, exit_code: 0, command: 'true' };
    const plan = { schema: 'promotion-train/v1', identity, id: batch, started_at: at((queue ?? 40) + 1), phase: 'complete', external_lock_required: false,
      jobs: [job], attempts: attempts ?? [{ jobs: [job], phase: 'complete', gate }],
      results: { [job.id]: { outcome: 'promoted', integrated_at: main === null ? null : at(main), tip: 'abc' } }, ...extra };
    write(path.join(identity, 'promote', 'batches', batch, 'train.json'), plan);
    return { plan, job, gate };
  }
  const land = (r, second = 81, batch = `b-${r.id}`) => event(second, { type: 'promotion.reconciled', identity, batch, heads: [{ run: r.id, item: r.item, head: 'abc' }] });
  const action = (r, eligible, extra = {}) => {
    const file = path.join(receiptDirectory(org, identity), 'autopilot', `${r.id}.json`);
    write(file, { policy: 'notice-autopilot/v1', project: { identity, org, repo }, key: `report:${r.id}`, finished: at(45),
      scope: { eligible }, ...extra }); return file;
  };
  const metrics = options => { save(); return collectCycleTime({ project: repo, org, since: at(0), until: at(1000), now: at(1000), ...options }); };
  const summary = (now = at(1000)) => projectSummary({ project: { identity, canonical: repo }, state: fold(events), now });
  return { root, repo, org, identity, events, event, write, save, run, review, train, land, action, metrics, summary };
}

test('known clocks give exact stage times, separate cohorts, median and nearest-rank p90', t => {
  const f = fixture(t);
  for (const [n, main] of [[1, 80], [2, 100], [3, 120]]) {
    const r = f.run(n); f.review(r); f.train(r, { main }); f.land(r, main + 1);
    if (n < 3) f.action(r, n === 1);
  }
  const usable = [{ identity: f.identity, run: 'R-1', item: 'ENG-1', at: at(90), evidence: 'adapter:installed' }];
  const m = f.metrics({ usable }), row = m.items[0];
  assert.deepEqual(row.stages_s, { dispatch_to_report_s: 10, report_to_review_s: 10, review_s: 10, review_to_queue_s: 10,
    queue_to_gate_s: 10, gate_to_main_s: 30, main_to_usable_s: 10, dispatch_to_main_s: 80, dispatch_to_usable_s: 90 });
  assert.equal(row.clocks.ingest, at(10)); assert.equal(row.clocks.reconcile, at(81));
  assert.equal(m.summary.stages_s.dispatch_to_main_s.median, 100);
  assert.equal(m.summary.stages_s.dispatch_to_main_s.p90, 120);
  assert.deepEqual(Object.values(m.cohorts).map(s => s.items), [1, 1, 1]);
  assert.equal(m.summary.clocks_missing.usable, 2);
  assert.equal(m.summary.stages_s.main_to_usable_s.missing, 2);
  assert.match(renderCycleTime(m), /Autopilot cohort: unknown/);
  assert.match(renderCycleTime(m), /dispatch_to_main_s \| 100.000 \| 120.000 \| 3 \| 0/);
  const pair = f.metrics({ until: at(110) });
  assert.equal(pair.summary.stages_s.dispatch_to_main_s.median, 90, 'even median averages middle values');
});

test('missing and reversed clocks stay null and are counted; reconcile never fabricates main or usable', t => {
  const f = fixture(t), r = f.run(1, { report: null });
  f.review(r, { start: 30, end: 20 }); f.train(r, { queue: null, main: null }); f.land(r);
  const m = f.metrics({ usable: [{ identity: f.identity, run: r.id, item: r.item, at: at(90), evidence: 'installed' }] });
  const row = m.items[0];
  assert.equal(row.clocks.main, null); assert.equal(row.clocks.usable, null); assert.equal(row.clocks.report, null);
  assert.equal(row.clocks.queue, null); assert.equal(row.stages_s.review_s, null);
  assert.equal(m.summary.stages_s.review_s.missing, 1); assert.equal(m.summary.clocks_missing.report, 1);
  assert.equal(m.summary.stages_s.dispatch_to_main_s.total, null);
  assert.equal(row.cohort, 'unknown');
  const other = f.run(2); f.train(other, { main: null });
  assert.equal(f.metrics().missing_window_clock, 1);
});

test('correction runs retain original dispatch, gate retries and causes, holds, review rounds and base recaptures', t => {
  const f = fixture(t), first = f.run(1);
  f.review(first, { start: 20, end: 25, extra: { review: { verdict: 'NEEDS-WORK' } } });
  const r = f.run(2, { item: first.item, start: 30, report: 40 });
  f.review(r, { start: 45, end: 50, extra: { reviewPolicy: { round: 2 }, recaptures: [{ at: at(44), from: 'a', onto: 'b' }] } });
  const log = path.join(f.root, 'red.log'); fs.writeFileSync(log, '> app@1 test:slow\nTAP version 13\nnot ok 1 - failure\n# duration_ms 1000\n');
  const red = { started_at: at(60), finished_at: at(65), exit_code: 1, duration_s: 5, command: 'true', log, error: 'fixture gate failed' };
  const job = { id: 'j-b-R-2', topic: 'fixture', run: r.id, org: f.org };
  f.train(r, { queue: 55, gateStart: 70, gateEnd: 75, main: 80, attempts: [
    { jobs: [job], phase: 'red', gate: red, error: 'fixture gate failed' },
    { jobs: [job], phase: 'complete', gate: { started_at: at(70), finished_at: at(75), exit_code: 0, duration_s: 5, command: 'true' } },
  ] });
  f.event(58, { type: 'note.added', id: r.item, text: 'Gate paused behind release build; hold until supervisor resumes.' });
  f.land(r);
  const row = f.metrics().items[0];
  assert.equal(row.clocks.dispatch, at(0)); assert.equal(row.stages_s.dispatch_to_main_s, 80);
  assert.deepEqual(row.runs, ['R-1', 'R-2']); assert.equal(row.waits.review_rounds, 2);
  assert.equal(row.waits.gate_retries, 1); assert.equal(row.waits.gates[0].reason, 'fixture gate failed');
  assert.deepEqual(row.waits.gates[0].failing_steps, ['test:slow']);
  assert.equal(row.waits.holds[0].seconds, null); assert.match(row.waits.holds[0].reason, /release build/);
  assert.equal(row.waits.base_moved.length, 1); assert.equal(row.waits.dispatch.length, 2);
  assert.match(renderCycleTime(f.metrics()), /Gate paused behind release build/);
});

test('window uses main with inclusive lower and exclusive upper bounds and defaults to seven days', t => {
  const f = fixture(t);
  for (const [n, main] of [[1, 80], [2, 100], [3, 120]]) { const r = f.run(n); f.train(r, { main }); f.land(r, main + 1); }
  assert.deepEqual(f.metrics({ since: at(80), until: at(120) }).items.map(r => r.item), ['ENG-1', 'ENG-2']);
  assert.deepEqual(f.metrics({ since: at(100), until: at(120) }).items.map(r => r.item), ['ENG-2']);
  assert.equal(f.metrics({ since: undefined, until: undefined, now: at(604900) }).window.since, at(100));
  assert.deepEqual(f.metrics({ since: undefined, until: undefined, now: at(604900) }).items.map(r => r.item), ['ENG-2', 'ENG-3']);
  assert.throws(() => f.metrics({ since: '2026-10-10T00:00:00' }), /timezone/);
  assert.throws(() => f.metrics({ since: at(100), until: at(100) }), /precede/);
});

test('a later landing cycle starts after its preceding landing and replays do not duplicate rows', t => {
  const f = fixture(t), a = f.run(1); f.train(a); f.land(a);
  const b = f.run(2, { item: a.item, start: 100, report: 110 });
  f.train(b, { queue: 140, gateStart: 150, gateEnd: 170, main: 180 }); f.land(b, 181);
  f.land(b, 182);
  const m = f.metrics(); assert.equal(m.items.length, 2);
  assert.equal(m.items[1].clocks.dispatch, at(100)); assert.deepEqual(m.items[1].runs, ['R-2']);
});

for (const source of ['late reconciliation', 'train receipt only']) {
  test(`a preceding landing known from ${source} excludes its runs from the next cycle`, t => {
    const f = fixture(t), a = f.run(1); f.review(a); f.train(a);
    const b = f.run(2, { item: a.item, start: 100, report: 110 });
    f.review(b, { start: 120, end: 130 });
    if (source === 'late reconciliation') f.land(a, 131);
    f.train(b, { queue: 140, gateStart: 150, gateEnd: 170, main: 180 }); f.land(b, 181);
    const m = f.metrics(), row = m.items[1];
    assert.equal(m.items.length, 2);
    assert.deepEqual(row.runs, ['R-2']); assert.equal(row.clocks.dispatch, at(100));
    assert.equal(row.stages_s.dispatch_to_main_s, 80);
    assert.equal(row.waits.dispatch.length, 1); assert.equal(row.waits.review_rounds, 1);
    assert.equal(row.waits.gate_executions, 1);
    assert.deepEqual(f.metrics({ since: at(100) }).items[0].runs, ['R-2'], 'boundary includes landings outside the window');
  });
}

test('foreign receipts, malformed timing and mismatched usable observations supply no clocks', t => {
  const f = fixture(t), r = f.run(1);
  f.review(r, { extra: { common: '/foreign' } });
  f.train(r, { extra: { identity: '/foreign' } }); f.land(r);
  f.action(r, true, { project: { identity: '/foreign', org: f.org } });
  f.event(20, { type: 'note.added', id: r.id, text: 'Fast path timing: broken' });
  const m = f.metrics({ usable: [{ identity: '/foreign', run: r.id, item: r.item, at: at(90), evidence: 'wrong' }] });
  assert.equal(m.items[0].clocks.main, null); assert.equal(m.items[0].clocks.review_start, null);
  assert.equal(m.items[0].cohort, 'unknown'); assert.equal(m.items[0].clocks.usable, null);
  assert.ok(m.warnings.some(w => w.includes('foreign receipt')));
  assert.ok(m.warnings.some(w => w.includes('foreign settlement')));
  assert.ok(m.warnings.some(w => w.includes('invalid fast path timing')));
});

test('plain CLI prints only; cycle-first publishing allows later summary refreshes without changing the record', t => {
  const f = fixture(t), r = f.run(1); f.review(r); f.train(r); f.land(r); f.save();
  const before = fs.readFileSync(path.join(f.org, 'events.jsonl'), 'utf8');
  const args = [cli, '--project', f.repo, '--org', f.org, '--since', at(0), '--until', at(100)];
  const printed = spawnSync(process.execPath, [...args, '--json'], { encoding: 'utf8' });
  assert.equal(printed.status, 0, printed.stderr); assert.equal(JSON.parse(printed.stdout).summary.items, 1);
  assert.equal(fs.existsSync(path.join(f.org, 'published')), false);
  const result = spawnSync(process.execPath, [...args, '--publish'], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const files = JSON.parse(result.stderr), data = JSON.parse(fs.readFileSync(files.json, 'utf8'));
  assert.equal(fs.readFileSync(files.markdown, 'utf8'), result.stdout);
  assert.equal(fs.readFileSync(files.markdown, 'utf8'), renderCycleTime(data));
  assert.equal(fs.readFileSync(path.join(f.org, 'events.jsonl'), 'utf8'), before);
  assert.ok(fs.lstatSync(path.join(f.org, 'published')).isSymbolicLink());
  for (const now of [at(1000), at(1001), at(1002)]) {
    writeProjectSummary(f.org, f.summary(now));
    assert.equal(JSON.parse(fs.readFileSync(path.join(f.org, 'published/summary.json'), 'utf8')).generated_at, now);
    assert.equal(fs.readFileSync(files.markdown, 'utf8'), renderCycleTime(data));
    assert.deepEqual(JSON.parse(fs.readFileSync(files.json, 'utf8')), data);
  }
  assert.equal(fs.readdirSync(path.join(f.org, '.published-summaries')).length, 2);
  assert.equal(fs.readdirSync(path.join(f.org, 'published')).filter(n => n.endsWith('.tmp')).length, 0);
  assert.ok(files.json.startsWith(path.join(f.org, 'published')));
});

test('summary-first publishing switches complete pairs and keeps the latest cycle-time pair across refreshes', t => {
  const f = fixture(t), r = f.run(1); f.train(r); f.land(r);
  const data = f.metrics(); writeProjectSummary(f.org, f.summary());
  const publicPath = path.join(f.org, 'published'), previous = fs.readlinkSync(publicPath);
  const summary = fs.readFileSync(path.join(publicPath, 'summary.json'), 'utf8');
  const rename = fs.renameSync;
  fs.renameSync = (from, to) => {
    assert.equal(to, publicPath);
    assert.equal(fs.readlinkSync(publicPath), previous);
    assert.deepEqual(fs.readdirSync(publicPath).sort(), ['summary.json', 'summary.md']);
    assert.equal(fs.readFileSync(path.join(from, 'summary.json'), 'utf8'), summary);
    const json = fs.readdirSync(from).find(n => n.startsWith('cycle-time-') && n.endsWith('.json'));
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(from, json), 'utf8')), data);
    assert.equal(fs.readFileSync(path.join(from, json.replace(/\.json$/, '.md')), 'utf8'), renderCycleTime(data));
    throw Error('injected cycle-time switch failure');
  };
  try { assert.throws(() => publishCycleTime(data), /injected cycle-time switch failure/); }
  finally { fs.renameSync = rename; }
  assert.equal(fs.readlinkSync(publicPath), previous);
  assert.equal(fs.existsSync(path.join(f.org, '.summary-publish.lock')), false);
  const first = publishCycleTime(data);
  assert.equal(fs.readFileSync(path.join(publicPath, 'summary.json'), 'utf8'), summary);
  assert.equal(fs.readFileSync(first.markdown, 'utf8'), renderCycleTime(data));
  const nextData = { ...data, generated_at: at(1001) }, next = publishCycleTime(nextData);
  assert.notEqual(next.json, first.json);
  assert.equal(fs.existsSync(first.json), false, 'published exposes only the latest cycle-time pair');
  for (const now of [at(1002), at(1003), at(1004)]) writeProjectSummary(f.org, f.summary(now));
  assert.deepEqual(JSON.parse(fs.readFileSync(next.json, 'utf8')), nextData);
  assert.equal(fs.readFileSync(next.markdown, 'utf8'), renderCycleTime(nextData));
  assert.equal(fs.readdirSync(publicPath).length, 4);
  assert.equal(fs.readdirSync(path.join(f.org, '.published-summaries')).length, 2);
});

test('cycle-time and summary share the publication lock and reject foreign project ownership', t => {
  const f = fixture(t), r = f.run(1); f.train(r); f.land(r);
  const data = f.metrics(); writeProjectSummary(f.org, f.summary());
  const publicPath = path.join(f.org, 'published'), before = fs.readlinkSync(publicPath);
  const lock = path.join(f.org, '.summary-publish.lock'); fs.mkdirSync(lock);
  assert.throws(() => publishCycleTime(data), /EEXIST/);
  assert.equal(fs.readlinkSync(publicPath), before); fs.rmdirSync(lock);
  assert.throws(() => publishCycleTime({ ...data, project: { ...data.project, identity: '/foreign' } }), /different canonical project/);
  assert.equal(fs.readlinkSync(publicPath), before);
  const files = publishCycleTime(data);
  assert.throws(() => writeProjectSummary(f.org, { ...f.summary(), project: { id: 'foreign' } }), /different canonical project/);
  assert.deepEqual(JSON.parse(fs.readFileSync(files.json, 'utf8')), data);

  const other = fixture(t), otherRun = other.run(1); other.train(otherRun); other.land(otherRun);
  publishCycleTime(other.metrics());
  assert.throws(() => writeProjectSummary(other.org, { ...other.summary(), project: { id: 'foreign' } }), /different canonical project/);
  writeProjectSummary(other.org, other.summary());
});

test('publishing rejects foreign generation links and a torn record refuses a partial report', t => {
  const f = fixture(t), r = f.run(1); f.train(r); f.land(r);
  const m = f.metrics(), outside = path.join(f.root, 'outside'); fs.mkdirSync(outside);
  fs.symlinkSync(outside, path.join(f.org, 'published'));
  assert.throws(() => publishCycleTime(m)); assert.deepEqual(fs.readdirSync(outside), []);
  fs.appendFileSync(path.join(f.org, 'events.jsonl'), '{"seq":');
  assert.throws(() => collectCycleTime({ project: f.repo, org: f.org }), /incomplete record tail/);
});
