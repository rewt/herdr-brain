import test from '../../test/helpers/bounded-test.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fixture } from './fixture.mjs';

const result = (r) => { assert.equal(r.status, 0, r.stderr); return JSON.parse(r.stdout); };
const workerPrompts = (f) => f.calls().filter((a) => a[1] === 'prompt' && a[3]?.startsWith('You are run '));
const workerLaunchCalls = (f) => f.calls().filter((a) =>
  (a[0] === 'tab' && a[1] === 'create') || (a[0] === 'agent' &&
    (a[1] === 'start' || (a[1] === 'prompt' && a[3]?.startsWith('You are run ')))));
function recordAdapter(f, body) {
  const file = path.join(f.root, 'record-adapter.mjs');
  fs.writeFileSync(file, `#!${process.execPath}
import fs from 'node:fs'; import { spawnSync } from 'node:child_process';
const cli = ${JSON.stringify(path.join(f.source, 'bin/org.mjs'))}, args = process.argv.slice(2);
const record = (argv) => spawnSync(process.execPath, [cli, ...argv], { env: process.env, encoding: 'utf8' });
const checked = (argv) => { const r = record(argv); if (r.status !== 0) throw new Error(r.stderr); return r.stdout; };
const forward = (r) => { process.stdout.write(r.stdout ?? ''); process.stderr.write(r.stderr ?? ''); process.exit(r.status ?? 1); };
${body}
forward(record(args));
`, { mode: 0o755 });
  return ['--org-cli', file];
}
function lostStart(f) {
  const run = f.start(); f.commit('wrong\n'); f.report(run);
  const marker = path.join(f.root, 'lose-start-response'); fs.writeFileSync(marker, '');
  const options = recordAdapter(f, `
if (args[0] === 'start' && fs.existsSync(${JSON.stringify(marker)})) {
  const r = record(args);
  if (r.status === 0) { console.error('injected lost successful start response'); process.exit(1); }
  forward(r);
}`);
  const first = f.requestCorrection(run, options);
  assert.equal(first.status, 1); assert.match(first.stderr, /lost successful start response/);
  const directory = path.join(f.org, 'dispatch');
  const file = path.join(directory, fs.readdirSync(directory).find((x) => x.endsWith('.json') && !x.endsWith('.routes.json')));
  const job = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(job.stage, 'starting'); assert.equal(job.run, null);
  const item = f.show(run).item, runs = f.show(item).runs;
  assert.equal(runs.length, 2); assert.equal(f.show(runs[1]).meta.dispatch_journal, file);
  assert.equal(workerPrompts(f).length, 0);
  fs.unlinkSync(marker);
  return { run, correction: runs[1], item, options, file };
}

test('ingestion receipt requires the captured recorded report before review or correction', (t) => {
  for (const mode of ['abandon', 'omit', 'different']) for (const content of ['correct\n', 'wrong\n']) {
    const actor = 'settle-ingest-receipt-test-agent', f = fixture(t, { actor }), run = f.start();
    assert.equal(f.show(run).started.by, actor);
    f.commit(content); f.report(run);
    const item = f.show(run).item, head = f.git(['rev-parse', 'HEAD'], f.workspace);
    const snapshot = path.join(f.root, 'ingest-receipt.json');
    const options = recordAdapter(f, `
if (args[0] === 'ingest') {
  let response = { status: 0, stdout: 'ingest accepted\\n', stderr: '' };
  if (${JSON.stringify(mode)} === 'abandon') checked(['abandon', ${JSON.stringify(run)}]);
  if (${JSON.stringify(mode)} === 'different') {
    const alternate = ${JSON.stringify(path.join(f.root, 'alternate-report.md'))};
    fs.writeFileSync(alternate, fs.readFileSync(args[1], 'utf8') + '\\nAn alternate report was recorded.\\n'); args[1] = alternate;
  }
  if (${JSON.stringify(mode)} !== 'omit') response = record(args);
  fs.writeFileSync(${JSON.stringify(snapshot)}, checked(['show', ${JSON.stringify(item)}, '--json']));
  forward(response);
}`);
    const settled = result(f.settle(run, options));
    assert.equal(settled.result, 'escalate');
    assert.match(settled.reason, mode === 'abandon' ? /abandoned/ : mode === 'omit' ? /not recorded/ : /hash/);
    const before = JSON.parse(fs.readFileSync(snapshot, 'utf8')), after = f.show(item);
    assert.deepEqual(after.outcome, before.outcome); assert.equal(after.status, before.status);
    assert.deepEqual(after.runs, [run]); assert.equal(f.calls().length, 0);
    assert.equal(f.git(['rev-parse', 'HEAD'], f.workspace), head);
    assert.equal(fs.readFileSync(path.join(f.org, 'events.jsonl'), 'utf8').includes('"type":"item.reopened"'), false);
    const recorded = f.show(run);
    assert.equal(Boolean(recorded.abandoned), mode === 'abandon');
    assert.equal(Boolean(recorded.report), mode === 'different');
    assert.match(fs.readFileSync(settled.handoff, 'utf8'), /record_outcome/);
  }
});

test('lost successful correction start recovers through settle retry with one recorded run and one prompt', (t) => {
  const f = fixture(t, { actor: 'settle-start-recovery-test-agent' });
  const { run, correction, item, options, file } = lostStart(f);
  const before = f.show(item), launches = f.calls().filter((a) => a[1] === 'start').length;
  const recovered = result(f.retry(run, options));
  assert.equal(recovered.result, 'fix_round'); assert.equal(recovered.fix.run, correction);
  assert.deepEqual(f.show(item).runs, before.runs); assert.equal(workerPrompts(f).length, 1);
  assert.equal(f.calls().filter((a) => a[1] === 'start').length, launches + 1);
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).run, correction);
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).stage, 'complete');
  // The detached watcher may append reads or a supervisor notice during this
  // retry. Compare worker dispatch mutations to prove no duplicate launch/work.
  const calls = workerLaunchCalls(f);
  assert.deepEqual(result(f.retry(run, options)), recovered); assert.deepEqual(workerLaunchCalls(f), calls);
  assert.deepEqual(f.show(item).runs, before.runs);
});

test('lost-start reconciliation retains closures, unresolved and declined blockers, and newer outcomes', (t) => {
  for (const change of ['closed', 'dropped', 'blocked', 'declined', 'newer']) {
    const f = fixture(t, { actor: 'settle-start-guard-test-agent' });
    const { run, item, options, file } = lostStart(f);
    let blocker;
    if (change === 'closed' || change === 'dropped') f.record(['close', item, ...(change === 'dropped' ? ['--dropped'] : [])]);
    if (change === 'blocked') {
      blocker = f.record(['add', 'Resolve scope', '--role', 'architect']).split(' ')[0];
      f.record(['block', item, '--by', blocker]);
    }
    if (change === 'declined') {
      blocker = f.record(['ask', 'Continue correction?', '--parent', item, '--category', 'design', '--recommend', 'no', '--why', 'Direction stopped', '--wait', '--blocks', item]).match(/HUM-\d+/)[0];
      f.record(['answer', blocker, 'no']); assert.equal(f.show(blocker).status, 'done');
    }
    if (change === 'newer') { const newer = f.start(); f.report(newer, 'needs_human'); f.record(['ingest', f.show(newer).report_path]); }
    const before = f.show(item), calls = f.calls().length;
    if (blocker) assert.equal(before.status, 'active', 'the correction hides blockers in derived status');
    const stopped = result(f.retry(run, options)); assert.equal(stopped.result, 'escalate');
    assert.match(stopped.reason, change === 'newer' ? /superseded/ : /closure or blockers/);
    if (blocker) assert.ok(stopped.reason.includes(blocker));
    const after = f.show(item);
    assert.deepEqual(after.outcome, before.outcome); assert.deepEqual(after.closed, before.closed);
    assert.deepEqual(after.runs, before.runs); assert.equal(after.status, before.status);
    assert.equal(f.calls().length, calls); assert.equal(workerPrompts(f).length, 0);
    assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).stage, 'starting');
  }
});

test('lost-start reconciliation refuses multiple recorded matches without launching work', (t) => {
  const f = fixture(t, { actor: 'settle-start-ambiguity-test-agent' });
  const { run, item, options, file } = lostStart(f);
  f.record(['start', item, '--workspace', f.workspace, '--meta', `dispatch_journal=${file}`]);
  const before = f.show(item), calls = f.calls().length;
  const stopped = result(f.retry(run, options)); assert.equal(stopped.result, 'escalate');
  assert.match(stopped.reason, /multiple.*matching|multiple.*matches/);
  assert.deepEqual(f.show(item).runs, before.runs); assert.equal(f.calls().length, calls);
  assert.equal(workerPrompts(f).length, 0);
});
