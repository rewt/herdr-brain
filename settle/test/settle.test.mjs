import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fixture } from './fixture.mjs';
const result = (r) => { assert.equal(r.status, 0, r.stderr); return JSON.parse(r.stdout); };
test('unconfigured project: report, independent claim finding, fresh fix run, report, settle, promotable', async (t) => {
  const f = fixture(t), run = f.start(); f.commit('wrong\n'); f.report(run);
  assert.ok(!fs.existsSync(path.join(f.repo, '.lane.json')));
  const first = result(f.settle(run)); assert.equal(first.result, 'fix_round');
  assert.notEqual(first.fix.run, run); assert.equal(f.show(first.fix.run).item, f.show(run).item);
  assert.equal(f.show(first.fix.run).workspace, f.workspace);
  assert.ok(f.show(run).report); assert.match(fs.readFileSync(first.review.path, 'utf8'), /Report claims correct/);
  const end = Date.now() + 8000;
  while (!f.calls().some((a) => a[1] === 'prompt' && a[3]?.includes(`[org-report] run=${first.fix.run} `)) && Date.now() < end) await new Promise((r) => setTimeout(r, 50));
  assert.ok(f.calls().some((a) => a[3]?.includes(`[org-report] run=${first.fix.run} `)), 'real watch delivered correction report');
  const second = result(f.settle(first.fix.run)); assert.equal(second.result, 'promotable');
  assert.equal(second.review.verdict, 'PASS'); assert.equal(second.validation.exit_code, 0);
  assert.equal(f.git(['status', '--porcelain'], f.workspace), '');
  assert.equal(f.git(['rev-list', '--merges', 'HEAD'], f.workspace), '');
  const prompt = fs.readFileSync(path.join(f.root, 'review-prompt'), 'utf8');
  assert.match(prompt, /Claim: work.txt contains correct/); assert.match(prompt, /work.txt must contain correct/);
  assert.ok(!fs.existsSync(path.join(f.repo, '.lane.json')));
  const count = f.calls().filter((a) => a[1] === 'start').length;
  assert.equal(result(f.settle(first.fix.run)).result, 'promotable');
  assert.equal(f.calls().filter((a) => a[1] === 'start').length, count, 'settle is idempotent');
});
test('already ingested reports use immutable bytes and never create duplicate proposals', (t) => {
  const f = fixture(t), run = f.start(); f.commit('correct\n'); f.report(run);
  const source = f.show(run).report_path;
  fs.writeFileSync(source, fs.readFileSync(source, 'utf8').replace('proposals: []', 'proposals:\n  - role: engineer\n    title: Inspect additional work'));
  f.record(['ingest', f.show(run).report_path]);
  fs.writeFileSync(f.show(run).report_path, 'changed source');
  assert.equal(result(f.settle(run)).result, 'promotable');
  assert.equal(f.show(f.show(run).item).children.length, 1);
});
test('non-done outcomes escalate with substance without launching a reviewer or correction', (t) => {
  for (const outcome of ['blocked', 'needs_human', 'failed']) {
    const f = fixture(t), run = f.start(); f.report(run, outcome);
    const r = result(f.settle(run)); assert.equal(r.result, 'escalate');
    assert.match(fs.readFileSync(r.handoff, 'utf8'), /scope|Worker reported/);
    assert.ok(f.show(run).report); assert.equal(f.calls().length, 0);
  }
});
test('dirty lanes and foreign Git identities cannot be reviewed or dispatched', (t) => {
  const f = fixture(t), run = f.start(); f.commit('correct\n'); f.report(run);
  fs.writeFileSync(path.join(f.workspace, 'dirty'), 'retain me');
  let r = f.settle(run); assert.equal(r.status, 1); assert.match(r.stderr, /worktree changed/);
  assert.equal(f.calls().length, 0); fs.unlinkSync(path.join(f.workspace, 'dirty'));
  assert.equal(result(f.retry(run)).result, 'promotable');
  const foreign = fixture(t); foreign.record(['start', foreign.show(foreign.start()).item, '--workspace', f.workspace]);
  r = foreign.settle('R-2'); assert.equal(r.status, 1); assert.match(r.stderr, /another Git common directory/);
});
test('malformed reviews never silently retry models; inspected uncertain launches can start a new round', (t) => {
  const f = fixture(t), run = f.start(); f.commit('correct\n'); f.report(run);
  fs.writeFileSync(path.join(f.root, 'wrong-head'), '');
  let r = f.settle(run); assert.equal(r.status, 1); assert.match(r.stderr, /review did not complete/);
  const count = f.calls().filter((a) => a[1] === 'start').length;
  r = f.retry(run); assert.equal(r.status, 1); assert.match(r.stderr, /outcome is uncertain/);
  assert.equal(f.calls().filter((a) => a[1] === 'start').length, count);
  const g = fixture(t), next = g.start(); g.commit('correct\n'); g.report(next);
  fs.writeFileSync(path.join(g.root, 'review-fail'), '');
  assert.equal(g.settle(next).status, 1);
  fs.unlinkSync(path.join(g.root, 'review-fail'));
  assert.equal(result(g.retry(next, ['--review-again'])).result, 'promotable');
});
test('uncertain fix delivery recovers the dispatch journal and never starts a second correction', (t) => {
  const f = fixture(t), run = f.start(); f.commit('wrong\n'); f.report(run);
  fs.writeFileSync(path.join(f.root, 'prompt-fail'), '');
  const failed = f.settle(run); assert.equal(failed.status, 1); assert.match(failed.stderr, /uncertain delivery/);
  const count = f.calls().filter((a) => a[1] === 'start').length;
  const retry = f.retry(run); assert.equal(retry.status, 1); assert.match(retry.stderr, /delivery outcome is unknown/);
  assert.equal(f.calls().filter((a) => a[1] === 'start').length, count);
  fs.unlinkSync(path.join(f.root, 'prompt-fail'));
  const dispatchDir = path.join(f.org, 'dispatch');
  const file = fs.readdirSync(dispatchDir).find((x) => x.endsWith('.json') && !x.endsWith('.routes.json'));
  const resumed = f.exec(process.execPath, [path.join(f.source, 'dispatch/dispatch.mjs'), '--org', f.org, '--retry', path.join(dispatchDir, file), '--resend']);
  assert.equal(resumed.status, 0, resumed.stderr);
  assert.equal(result(f.retry(run)).result, 'fix_round');
  assert.equal(f.calls().filter((a) => a[1] === 'start').length, count);
});
test('failed validation cannot become promotable even with an independent PASS', (t) => {
  const f = fixture(t), run = f.start(); f.commit('correct\n'); f.report(run);
  fs.writeFileSync(path.join(f.workspace, 'test.mjs'), "import test from 'node:test';test('red gate',()=>{throw new Error('red');});\n");
  f.git(['add', 'test.mjs'], f.workspace); f.git(['commit', '-qm', 'Reproduce red validation'], f.workspace);
  assert.equal(result(f.settle(run)).result, 'fix_round');
});
test('PASS with unverified claims and moved heads do not return promotable', (t) => {
  const f = fixture(t), run = f.start(); f.commit('correct\n'); f.report(run);
  fs.writeFileSync(path.join(f.root, 'unverified'), '');
  assert.equal(result(f.settle(run)).result, 'escalate');
  const g = fixture(t), next = g.start(); g.commit('correct\n'); g.report(next);
  assert.equal(result(g.settle(next)).result, 'promotable'); g.commit('new code\n');
  const r = g.settle(next); assert.equal(r.status, 1); assert.match(r.stderr, /HEAD or branch moved/);
});
test('same-lane contenders cannot run two independent reviews', async (t) => {
  const f = fixture(t), run = f.start(); f.commit('correct\n'); f.report(run);
  const first = f.concurrent(run), second = f.concurrent(run);
  const outputs = await Promise.all([first.done, second.done]);
  assert.ok(outputs.some((r) => r.status === 1 && /already running/.test(r.stderr)));
  assert.ok(f.calls().filter((a) => a[1] === 'start').length <= 1);
  const again = fs.existsSync(path.join(f.org, 'settle', `${run}.json`)) ? f.retry(run) : f.settle(run);
  assert.equal(result(again).result, 'promotable');
});
test('other-item lane work and dropped items require judgment; a saved PASS rechecks the record', (t) => {
  const f = fixture(t), run = f.start(); f.commit('correct\n'); f.report(run);
  const other = f.record(['add', 'Other lane work', '--role', 'engineer']).split(' ')[0];
  f.record(['start', other, '--workspace', f.workspace]);
  assert.equal(result(f.settle(run)).result, 'escalate'); assert.equal(f.calls().length, 0);
  const g = fixture(t), dropped = g.start(); g.report(dropped);
  g.record(['close', g.show(dropped).item, '--dropped']);
  assert.equal(result(g.settle(dropped)).result, 'escalate'); assert.equal(g.show(g.show(dropped).item).status, 'dropped');
  const h = fixture(t), ready = h.start(); h.commit('correct\n'); h.report(ready);
  assert.equal(result(h.settle(ready)).result, 'promotable'); h.start();
  const r = h.settle(ready); assert.equal(r.status, 1); assert.match(r.stderr, /readiness changed/);
});
