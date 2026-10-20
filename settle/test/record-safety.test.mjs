import test from '../../test/helpers/bounded-test.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fixture } from './fixture.mjs';

const result = (r) => { assert.equal(r.status, 0, r.stderr); return JSON.parse(r.stdout); };
const ingest = (f, run) => f.record(['ingest', f.show(run).report_path]);
const workerPrompts = (f) => f.calls().filter((a) => a[1] === 'prompt' && a[3]?.startsWith('You are run '));
const dispatchJob = (f) => {
  const directory = path.join(f.org, 'dispatch');
  const name = fs.readdirSync(directory).find((x) => x.endsWith('.json') && !x.endsWith('.routes.json'));
  return JSON.parse(fs.readFileSync(path.join(directory, name), 'utf8'));
};
function watcherFailure(f) {
  const file = path.join(f.root, 'watch-adapter.mjs');
  fs.writeFileSync(path.join(f.root, 'watch-fail'), '');
  fs.writeFileSync(file, `#!${process.execPath}
import fs from 'node:fs'; import { spawnSync } from 'node:child_process';
fs.appendFileSync(${JSON.stringify(path.join(f.root, 'watch-calls'))}, 'call\\n');
if (fs.existsSync(${JSON.stringify(path.join(f.root, 'watch-fail'))})) { console.error('injected watcher startup failure'); process.exit(1); }
const r = spawnSync(process.execPath, [${JSON.stringify(path.join(f.source, 'watch/watch.mjs'))}, ...process.argv.slice(2)], { env: process.env, encoding: 'utf8' });
process.stdout.write(r.stdout ?? ''); process.stderr.write(r.stderr ?? ''); process.exit(r.status ?? 1);
`, { mode: 0o755 });
  return ['--watch-cli', file];
}

test('settling an ingested older report preserves every newer reported outcome without review or correction', (t) => {
  for (const outcome of ['needs_human', 'blocked', 'done', 'failed']) for (const content of ['correct\n', 'wrong\n']) {
    const f = fixture(t), old = f.start(); f.commit(content); f.report(old); ingest(f, old);
    const newer = f.start(); f.report(newer, outcome); ingest(f, newer);
    const before = f.show(f.show(old).item), head = f.git(['rev-parse', 'HEAD'], f.workspace);
    const settled = result(f.settle(old));
    assert.equal(settled.result, 'escalate'); assert.match(settled.reason, /superseded/); assert.ok(settled.reason.includes(newer));
    const after = f.show(before.id);
    assert.deepEqual(after.outcome, before.outcome); assert.equal(after.status, before.status);
    assert.deepEqual(after.runs, before.runs); assert.equal(f.calls().length, 0);
    assert.equal(f.git(['rev-parse', 'HEAD'], f.workspace), head);
    assert.match(fs.readFileSync(settled.handoff, 'utf8'), /record_outcome/);
  }
});
test('an unrecorded stale report cannot overwrite a newer outcome through ingestion', (t) => {
  const f = fixture(t), old = f.start(); f.commit('correct\n'); f.report(old);
  const newer = f.start(); f.report(newer, 'needs_human'); ingest(f, newer);
  const before = f.show(f.show(old).item);
  assert.equal(result(f.settle(old)).result, 'escalate');
  assert.equal(f.show(old).report, null); assert.equal(f.calls().length, 0);
  const after = f.show(before.id); assert.deepEqual(after.outcome, before.outcome); assert.equal(after.status, before.status);
});
test('cached readiness and uncertain review retries hand off superseded runs', (t) => {
  for (const cached of [true, false]) {
    const f = fixture(t), old = f.start(); f.commit('correct\n'); f.report(old);
    if (cached) assert.equal(result(f.settle(old)).result, 'promotable');
    else { fs.writeFileSync(path.join(f.root, 'review-fail'), ''); assert.equal(f.settle(old).status, 1); }
    const count = f.calls().length, newer = f.start(); f.report(newer, cached ? 'done' : 'needs_human'); ingest(f, newer);
    const before = f.show(f.show(old).item);
    const settled = result(cached ? f.settle(old) : f.retry(old, ['--review-again']));
    assert.equal(settled.result, 'escalate'); assert.match(settled.reason, /superseded/);
    assert.equal(f.calls().length, count, 'no reviewer or worker launch on stale evidence');
    assert.deepEqual(f.show(before.id).outcome, before.outcome); assert.equal(f.show(before.id).status, before.status);
  }
});
test('conditional ingest and reopen protect a newer report arriving immediately before the record write', (t) => {
  for (const command of ['ingest', 'reopen']) {
    const f = fixture(t), old = f.start(); f.commit('correct\n'); f.report(old);
    const item = f.show(old).item, adapter = path.join(f.root, 'race-record.mjs');
    fs.writeFileSync(adapter, `#!${process.execPath}
import fs from 'node:fs'; import { spawnSync } from 'node:child_process';
const cli = ${JSON.stringify(path.join(f.source, 'bin/org.mjs'))}, args = process.argv.slice(2);
const record = (argv) => { const r = spawnSync(process.execPath, [cli, ...argv], { env: process.env, encoding: 'utf8' }); if (r.status !== 0) throw new Error(r.stderr); return r.stdout; };
if (args[0] === ${JSON.stringify(command)} && !fs.existsSync(${JSON.stringify(path.join(f.root, 'race-run'))})) {
  const run = record(['start', ${JSON.stringify(item)}, '--workspace', ${JSON.stringify(f.workspace)}]).match(/R-\\d+/)[0];
  const report = JSON.parse(record(['show', run, '--json'])).report_path;
  fs.writeFileSync(report, '---\\nrun: ' + run + '\\noutcome: needs_human\\nsummary: Newer run requires judgment.\\nblockers: ["Scope decision"]\\nproposals: []\\n---\\n');
  record(['ingest', report]); fs.writeFileSync(${JSON.stringify(path.join(f.root, 'race-run'))}, run);
}
const r = spawnSync(process.execPath, [cli, ...args], { env: process.env, encoding: 'utf8' });
process.stdout.write(r.stdout ?? ''); process.stderr.write(r.stderr ?? ''); process.exit(r.status ?? 1);
`, { mode: 0o755 });
    const settled = result(f.settle(old, ['--org-cli', adapter])); assert.equal(settled.result, 'escalate');
    assert.match(settled.reason, /Conditional.*refused/); assert.match(settled.reason, /superseded/);
    const newer = fs.readFileSync(path.join(f.root, 'race-run'), 'utf8'), current = f.show(item);
    assert.equal(current.outcome.run, newer); assert.equal(current.outcome.value, 'needs_human');
    assert.equal(current.status, command === 'ingest' ? 'active' : 'needs_human');
    assert.equal(Boolean(f.show(old).report), command === 'reopen'); assert.equal(f.calls().length, 0);
  }
});
test('a newer report arriving during PASS or NEEDS-WORK review retains its outcome and prevents follow-up work', (t) => {
  for (const outcome of ['needs_human', 'blocked']) {
    const f = fixture(t), old = f.start(); f.commit(outcome === 'blocked' ? 'wrong\n' : 'correct\n'); f.report(old);
    const item = f.show(old).item;
    fs.writeFileSync(path.join(f.root, 'review-new-report.json'), JSON.stringify({ item, outcome }));
    const settled = result(f.settle(old)); assert.equal(settled.result, 'escalate'); assert.match(settled.reason, /superseded/);
    assert.equal(settled.review.verdict, outcome === 'blocked' ? 'NEEDS-WORK' : 'PASS');
    const current = f.show(item), newer = fs.readFileSync(path.join(f.root, 'review-new-run'), 'utf8');
    assert.equal(current.outcome.run, newer); assert.equal(current.outcome.value, outcome); assert.equal(current.status, outcome);
    assert.deepEqual(current.runs, [old, newer]); assert.equal(workerPrompts(f).length, 0);
    assert.equal(f.calls().filter((a) => a[1] === 'start').length, 1, 'only the reviewer started');
  }
});
test('conditional reopen accepts no-op retries and a late older report cannot block settling the correction', (t) => {
  const f = fixture(t), earlier = f.start(); f.report(earlier, 'needs_human');
  const latest = f.start(); f.commit('correct\n'); f.report(latest); ingest(f, latest);
  f.record(['reopen', f.show(latest).item, '--if-current-run', latest]);
  const events = fs.readFileSync(path.join(f.org, 'events.jsonl'), 'utf8');
  f.record(['reopen', f.show(latest).item, '--if-current-run', latest]);
  assert.equal(fs.readFileSync(path.join(f.org, 'events.jsonl'), 'utf8'), events);
  ingest(f, earlier); const before = f.show(f.show(latest).item);
  assert.equal(before.outcome, null);
  assert.equal(before.status, 'ready');
  assert.equal(f.show(earlier).report.late, true);
  assert.equal(result(f.settle(latest)).result, 'promotable');
  assert.equal(f.calls().filter((a) => a[1] === 'start').length, 1, 'only the independent reviewer starts');
});
test('incomplete correction retry respects unresolved links hidden by active status and sends no worker prompt', (t) => {
  for (const kind of ['open', 'declined']) {
    const f = fixture(t), old = f.start(); f.commit('wrong\n'); f.report(old);
    const options = watcherFailure(f), first = f.settle(old, options);
    assert.equal(first.status, 1); assert.match(first.stderr, /injected watcher startup failure/);
    const dispatch = dispatchJob(f), item = f.show(old).item;
    assert.equal(dispatch.stage, 'watch'); assert.notEqual(dispatch.run, old); assert.equal(workerPrompts(f).length, 0);
    let blocker;
    if (kind === 'open') {
      blocker = f.record(['add', 'Resolve scope before continuing', '--role', 'architect']).split(' ')[0];
      f.record(['block', item, '--by', blocker]);
    } else {
      blocker = f.record(['ask', 'Continue this correction?', '--parent', item, '--category', 'design', '--recommend', 'no', '--why', 'Operator stopped this direction', '--wait', '--blocks', item]).match(/HUM-\d+/)[0];
      f.record(['answer', blocker, 'no']); assert.equal(f.show(blocker).status, 'done');
    }
    const before = f.show(item); assert.equal(before.status, 'active');
    fs.unlinkSync(path.join(f.root, 'watch-fail'));
    const count = f.calls().filter((a) => a[1] === 'start').length;
    const settled = result(f.retry(old, options)); assert.equal(settled.result, 'escalate'); assert.ok(settled.reason.includes(blocker));
    assert.equal(workerPrompts(f).length, 0); assert.equal(fs.readFileSync(path.join(f.root, 'watch-calls'), 'utf8'), 'call\n');
    assert.equal(f.calls().filter((a) => a[1] === 'start').length, count); assert.deepEqual(f.show(item).runs, before.runs);
    assert.deepEqual(f.show(item).outcome, before.outcome); assert.equal(dispatchJob(f).stage, 'watch');
  }
});
test('resolved blocker links allow recovery of only the recorded correction run', (t) => {
  const f = fixture(t), old = f.start(); f.commit('wrong\n'); f.report(old);
  const options = watcherFailure(f); assert.equal(f.settle(old, options).status, 1);
  const dispatch = dispatchJob(f), item = f.show(old).item;
  const blocker = f.record(['add', 'Resolved scope decision', '--role', 'architect']).split(' ')[0];
  f.record(['block', item, '--by', blocker]); f.record(['close', blocker]);
  fs.unlinkSync(path.join(f.root, 'watch-fail'));
  const count = f.calls().filter((a) => a[1] === 'start').length;
  const resumed = result(f.retry(old, options)); assert.equal(resumed.result, 'fix_round'); assert.equal(resumed.fix.run, dispatch.run);
  assert.equal(workerPrompts(f).length, 1); assert.equal(f.calls().filter((a) => a[1] === 'start').length, count);
});
test('correction creation cannot clear a newer outcome arriving before dispatch preflight', (t) => {
  const f = fixture(t), old = f.start(); f.commit('wrong\n'); f.report(old);
  const item = f.show(old).item, adapter = path.join(f.root, 'race-dispatch.mjs');
  fs.writeFileSync(adapter, `#!${process.execPath}
import fs from 'node:fs'; import { spawnSync } from 'node:child_process';
const cli = ${JSON.stringify(path.join(f.source, 'bin/org.mjs'))};
const record = (argv) => { const r = spawnSync(process.execPath, [cli, ...argv], { env: process.env, encoding: 'utf8' }); if (r.status !== 0) throw new Error(r.stderr); return r.stdout; };
const run = record(['start', ${JSON.stringify(item)}, '--workspace', ${JSON.stringify(f.workspace)}]).match(/R-\\d+/)[0];
const report = JSON.parse(record(['show', run, '--json'])).report_path;
fs.writeFileSync(report, '---\\nrun: ' + run + '\\noutcome: needs_human\\nsummary: Newer run requires judgment.\\nblockers: ["Scope decision"]\\nproposals: []\\n---\\n');
record(['ingest', report]); record(['close', ${JSON.stringify(item)}]);
fs.writeFileSync(${JSON.stringify(path.join(f.root, 'race-item.json'))}, record(['show', ${JSON.stringify(item)}, '--json']));
const r = spawnSync(process.execPath, [${JSON.stringify(path.join(f.source, 'dispatch/dispatch.mjs'))}, ...process.argv.slice(2)], { env: process.env, encoding: 'utf8' });
fs.writeFileSync(${JSON.stringify(path.join(f.root, 'race-dispatch-result.json'))}, r.stdout ?? '');
process.stdout.write(r.stdout ?? ''); process.stderr.write(r.stderr ?? ''); process.exit(r.status ?? 1);
`, { mode: 0o755 });
  const refused = f.settle(old, ['--dispatch-cli', adapter]); assert.equal(refused.status, 1);
  assert.match(refused.stderr, /superseded/); assert.equal(JSON.parse(refused.stdout).result, 'escalate');
  const before = JSON.parse(fs.readFileSync(path.join(f.root, 'race-item.json'), 'utf8')), after = f.show(item);
  assert.deepEqual(after.outcome, before.outcome); assert.deepEqual(after.closed, before.closed);
  assert.deepEqual(after.runs, before.runs); assert.equal(after.status, before.status); assert.equal(workerPrompts(f).length, 0);
  assert.equal(f.calls().filter((a) => a[1] === 'start').length, 1, 'no correction worker was launched');
  const dispatch = JSON.parse(fs.readFileSync(path.join(f.root, 'race-dispatch-result.json'), 'utf8'));
  assert.equal(dispatch.result, 'failed'); assert.equal(dispatch.code, 'FROM_RUN_SUPERSEDED');
  assert.equal(fs.existsSync(path.join(f.org, 'dispatch')), false, 'preflight refuses before creating any correction journal');
});
test('conditional record start preserves a newer outcome arriving after dispatch origin checks', (t) => {
  const f = fixture(t), old = f.start(); f.commit('wrong\n'); f.report(old);
  const item = f.show(old).item, adapter = path.join(f.root, 'race-start.mjs');
  fs.writeFileSync(adapter, `#!${process.execPath}
import fs from 'node:fs'; import { spawnSync } from 'node:child_process';
const cli = ${JSON.stringify(path.join(f.source, 'bin/org.mjs'))}, args = process.argv.slice(2);
const record = (argv) => { const r = spawnSync(process.execPath, [cli, ...argv], { env: process.env, encoding: 'utf8' }); if (r.status !== 0) throw new Error(r.stderr); return r.stdout; };
const guardedStart = args[0] === 'start' && args.includes('--if-current-run');
if (guardedStart) {
  fs.writeFileSync(${JSON.stringify(path.join(f.root, 'race-start-args.json'))}, JSON.stringify(args));
  const run = record(['start', ${JSON.stringify(item)}, '--workspace', ${JSON.stringify(f.workspace)}]).match(/R-\\d+/)[0];
  const report = JSON.parse(record(['show', run, '--json'])).report_path;
  fs.writeFileSync(report, '---\\nrun: ' + run + '\\noutcome: needs_human\\nsummary: Newer run requires judgment.\\nblockers: ["Scope decision"]\\nproposals: []\\n---\\n');
  record(['ingest', report]); record(['close', ${JSON.stringify(item)}]);
  fs.writeFileSync(${JSON.stringify(path.join(f.root, 'race-item.json'))}, record(['show', ${JSON.stringify(item)}, '--json']));
}
const r = spawnSync(process.execPath, [cli, ...args], { env: process.env, encoding: 'utf8' });
if (guardedStart) fs.writeFileSync(${JSON.stringify(path.join(f.root, 'race-start-result.json'))}, JSON.stringify({ status: r.status, stderr: r.stderr }));
process.stdout.write(r.stdout ?? ''); process.stderr.write(r.stderr ?? ''); process.exit(r.status ?? 1);
`, { mode: 0o755 });
  const capture = path.join(f.root, 'capture-dispatch.mjs'), captured = path.join(f.root, 'dispatch-result.json');
  fs.writeFileSync(capture, `#!${process.execPath}
import fs from 'node:fs'; import { spawnSync } from 'node:child_process';
const r = spawnSync(process.execPath, [${JSON.stringify(path.join(f.source, 'dispatch/dispatch.mjs'))}, ...process.argv.slice(2)], { env: process.env, encoding: 'utf8' });
fs.writeFileSync(${JSON.stringify(captured)}, r.stdout);
process.stdout.write(r.stdout ?? ''); process.stderr.write(r.stderr ?? ''); process.exit(r.status ?? 1);
`, { mode: 0o755 });
  const refused = f.settle(old, ['--org-cli', adapter, '--dispatch-cli', capture]); assert.equal(refused.status, 1);
  assert.match(refused.stderr, /superseded/); assert.equal(JSON.parse(refused.stdout).result, 'escalate');
  assert.equal(JSON.parse(fs.readFileSync(captured, 'utf8')).code, 'FROM_RUN_SUPERSEDED');
  const before = JSON.parse(fs.readFileSync(path.join(f.root, 'race-item.json'), 'utf8')), after = f.show(item);
  assert.deepEqual(after.outcome, before.outcome); assert.deepEqual(after.closed, before.closed);
  assert.deepEqual(after.runs, before.runs); assert.equal(after.status, before.status); assert.equal(workerPrompts(f).length, 0);
  assert.equal(f.calls().filter((a) => a[1] === 'start').length, 1, 'no correction worker was launched');
  const args = JSON.parse(fs.readFileSync(path.join(f.root, 'race-start-args.json'), 'utf8'));
  assert.equal(args[args.indexOf('--if-current-run') + 1], old);
  const refusal = JSON.parse(fs.readFileSync(path.join(f.root, 'race-start-result.json'), 'utf8'));
  assert.equal(refusal.status, 1, refusal.stderr); assert.match(refusal.stderr, /superseded/);
  const dispatch = dispatchJob(f);
  assert.equal(dispatch.fromRun, old); assert.equal(dispatch.stage, 'starting');
  assert.equal(dispatch.startRefused, true); assert.equal(dispatch.run, null);
});
test('legacy incomplete creation binds its origin on retry and preserves a concurrently newer outcome', (t) => {
  const f = fixture(t), old = f.start(); f.commit('wrong\n'); f.report(old);
  const item = f.show(old).item, adapter = path.join(f.root, 'legacy-record.mjs'), marker = path.join(f.root, 'start-fail');
  fs.writeFileSync(marker, '');
  fs.writeFileSync(adapter, `#!${process.execPath}
import fs from 'node:fs'; import { spawnSync } from 'node:child_process';
const cli = ${JSON.stringify(path.join(f.source, 'bin/org.mjs'))}, args = process.argv.slice(2);
const record = (argv) => { const r = spawnSync(process.execPath, [cli, ...argv], { env: process.env, encoding: 'utf8' }); if (r.status !== 0) throw new Error(r.stderr); return r.stdout; };
if (args[0] === 'start') {
  if (fs.existsSync(${JSON.stringify(marker)})) { console.error('record: injected start refusal'); process.exit(1); }
  const run = record(['start', ${JSON.stringify(item)}, '--workspace', ${JSON.stringify(f.workspace)}]).match(/R-\\d+/)[0];
  const report = JSON.parse(record(['show', run, '--json'])).report_path;
  fs.writeFileSync(report, '---\\nrun: ' + run + '\\noutcome: needs_human\\nsummary: Newer run requires judgment.\\nblockers: ["Scope decision"]\\nproposals: []\\n---\\n');
  record(['ingest', report]); record(['close', ${JSON.stringify(item)}]);
  fs.writeFileSync(${JSON.stringify(path.join(f.root, 'legacy-item.json'))}, record(['show', ${JSON.stringify(item)}, '--json']));
}
const r = spawnSync(process.execPath, [cli, ...args], { env: process.env, encoding: 'utf8' });
process.stdout.write(r.stdout ?? ''); process.stderr.write(r.stderr ?? ''); process.exit(r.status ?? 1);
`, { mode: 0o755 });
  const options = ['--org-cli', adapter], first = f.settle(old, options);
  assert.equal(first.status, 1); assert.match(first.stderr, /injected start refusal/);
  const saved = dispatchJob(f); assert.equal(saved.stage, 'starting'); assert.equal(saved.run, null);
  delete saved.fromRun;
  fs.writeFileSync(path.join(f.org, 'dispatch', `${saved.token}.json`), JSON.stringify(saved));
  fs.unlinkSync(marker);
  const refused = f.retry(old, options); assert.equal(refused.status, 1); assert.match(refused.stderr, /superseded/);
  const before = JSON.parse(fs.readFileSync(path.join(f.root, 'legacy-item.json'), 'utf8')), after = f.show(item);
  assert.deepEqual(after.outcome, before.outcome); assert.deepEqual(after.closed, before.closed); assert.deepEqual(after.runs, before.runs);
  assert.equal(workerPrompts(f).length, 0); assert.equal(dispatchJob(f).fromRun, old);
});
