import test from '../../test/helpers/bounded-test.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fixture } from './fixture.mjs';
import { ROUTE_PRESET } from '../../lanes/preset.mjs';
const result = (r) => { assert.equal(r.status, 0, r.stderr); return JSON.parse(r.stdout); };
const journal = (f, run) => JSON.parse(fs.readFileSync(path.join(f.org, 'settle', `${run}.json`), 'utf8'));
test('fixture teardown waits for a concurrent child to finish writing before removing its directory', async (t) => {
  let release;
  t.after(() => fs.writeFileSync(release, 'teardown started'));
  const f = fixture(t), proof = fs.mkdtempSync(path.join(os.tmpdir(), 'settle-cleanup-proof-'));
  release = path.join(f.root, 'writer-release');
  const completed = path.join(proof, 'completed'), ready = path.join(f.root, 'writer-ready');
  const script = path.join(f.root, 'late-writer.mjs');
  fs.writeFileSync(script, `import fs from 'node:fs';
fs.writeFileSync(${JSON.stringify(ready)},'ready');
const timer=setInterval(()=>{
 if(!fs.existsSync(${JSON.stringify(release)}))return;
 clearInterval(timer);
 setTimeout(()=>{
 fs.mkdirSync(${JSON.stringify(path.join(f.root, 'late-directory'))});
 fs.writeFileSync(${JSON.stringify(path.join(f.root, 'late-directory/output'))},'finished');
 fs.writeFileSync(${JSON.stringify(completed)},'child finished before directory removal');
 },100);
},10);`);
  f.concurrent('teardown-proof', script);
  const deadline = Date.now() + 5000;
  while (!fs.existsSync(ready) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
  assert.ok(fs.existsSync(ready), 'writer did not start');
  t.after(() => {
    try {
      assert.equal(fs.readFileSync(completed, 'utf8'), 'child finished before directory removal');
      assert.equal(fs.existsSync(f.root), false, 'fixture directory remains after its children finished');
    } finally { fs.rmSync(proof, { recursive: true, force: true }); }
  });
  // The body intentionally returns while its bounded child is still writing.
});
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
  assert.match(prompt, /## Review run budget\nBuild, test, prepare, install and check commands: maximum count 0/);
  const review = fs.readFileSync(second.review.path, 'utf8');
  assert.match(review, /## Non-claims\n- Validation is inherited from settle/);
  assert.match(review, /## Re-executed\n```json\n\[\]/);
  assert.match(review, /## Unverified\nNone/);
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
    const item = f.show(f.show(run).item);
    assert.equal(item.outcome.value, outcome, 'settlement preserves the recorded non-done outcome');
    assert.equal(item.status, outcome === 'failed' ? 'ready' : outcome, 'derived blocked and needs-human views retain the item');
  }
});
test('inherited validation acknowledgments are scoped non-claims, never unresolved acceptance evidence', (t) => {
  const f = fixture(t), run = f.start(); f.commit('correct\n'); f.report(run);
  fs.writeFileSync(path.join(f.root, 'inherited-unverified'), '');
  assert.equal(result(f.settle(run)).result, 'promotable');
  const g = fixture(t), next = g.start(); g.commit('correct\n'); g.report(next);
  fs.writeFileSync(path.join(g.root, 'inherited-unverified'), '');
  fs.writeFileSync(path.join(g.root, 'unverified'), '');
  const unresolved = result(g.settle(next));
  assert.equal(unresolved.result, 'escalate');
  assert.match(unresolved.reason, /unverified claims/);
});
test('discovered project settings override parent settle values and inherit a non-main integration branch', (t) => {
  const f = fixture(t);
  f.git(['branch', '-m', 'main', 'develop']);
  fs.writeFileSync(path.join(f.root, '.lane.json'), JSON.stringify({ ...ROUTE_PRESET, main: 'develop',
    settle: { review_route: 'review-max', fix_route: 'engineer-max', reuse: true, timeout: 17, to: 'parent-supervisor' } }));
  fs.writeFileSync(path.join(f.repo, '.lane.json'), JSON.stringify({ settle: {
    review_route: 'review', fix_route: 'engineer-xhigh', timeout: 25, to: 'configured-supervisor' } }));
  f.git(['add', '.lane.json']); f.git(['commit', '-qm', 'Configure project settlement']);
  f.git(['rebase', 'develop'], f.workspace);
  const run = f.start(); f.commit('wrong\n'); f.report(run);
  const r = result(f.settle(run)); assert.equal(r.result, 'fix_round');
  const saved = journal(f, run);
  assert.equal(saved.main, 'develop'); assert.equal(saved.mainHead, f.git(['rev-parse', 'develop']));
  assert.equal(saved.reviewRoute, 'review'); assert.equal(saved.fixRoute, 'engineer-xhigh');
  assert.equal(saved.reuse, false, 'repository settle object replaces the parent object');
  assert.equal(saved.timeout, 25); assert.equal(saved.to, 'configured-supervisor');
  assert.equal(r.review.route, 'review'); assert.equal(f.show(r.fix.run).meta.route, 'engineer-xhigh');
});
test('explicit configuration selects one layer and command flags override settle settings', (t) => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.root, '.lane.json'), 'invalid ignored parent config');
  const file = path.join(f.root, 'explicit.json');
  fs.writeFileSync(file, JSON.stringify({ ...ROUTE_PRESET, settle: {
    review_route: 'review', fix_route: 'engineer-max', reuse: false, timeout: 23, to: 'configured-supervisor' } }));
  f.env.LANE_CONFIG = file;
  const run = f.start(); f.report(run, 'blocked');
  assert.equal(result(f.settle(run, ['--review-route', 'review-max', '--fix-route', 'engineer-xhigh', '--reuse', '--timeout', '7', '--to', 'flag-supervisor'])).result, 'escalate');
  const saved = journal(f, run);
  assert.equal(saved.reviewRoute, 'review-max'); assert.equal(saved.fixRoute, 'engineer-xhigh');
  assert.equal(saved.reuse, true); assert.equal(saved.timeout, 7); assert.equal(saved.to, 'flag-supervisor');
});
test('an item dropped or blocked during NEEDS-WORK review cannot launch a correction', (t) => {
  for (const change of ['drop', 'block']) {
    const f = fixture(t), run = f.start(); f.commit('wrong\n'); f.report(run);
    const item = f.show(run).item;
    const blocker = change === 'block' ? f.record(['add', 'Resolve scope first', '--role', 'architect']).split(' ')[0] : null;
    const action = change === 'drop' ? ['close', item, '--dropped'] : ['block', item, '--by', blocker];
    fs.writeFileSync(path.join(f.root, 'review-record-action.json'), JSON.stringify(action));
    const r = result(f.settle(run)); assert.equal(r.result, 'escalate');
    assert.equal(r.review.verdict, 'NEEDS-WORK'); assert.match(r.reason, /supervisor judgment/);
    assert.equal(f.show(item).status, change === 'drop' ? 'dropped' : 'blocked');
    assert.deepEqual(f.show(item).runs, [run], 'no correction run was recorded');
    assert.equal(f.calls().filter((a) => a[1] === 'start').length, 1, 'only the independent reviewer started');
    assert.equal(f.calls().filter((a) => a[1] === 'prompt' && a[3]?.startsWith('You are run ')).length, 0);
    assert.match(fs.readFileSync(r.handoff, 'utf8'), /closure or blockers/);
  }
});
test('initial and cached readiness both require a clean canonical checkout', (t) => {
  for (const cached of [false, true]) {
    const f = fixture(t), run = f.start(); f.commit('correct\n'); f.report(run);
    if (cached) assert.equal(result(f.settle(run)).result, 'promotable');
    const laneHead = f.git(['rev-parse', 'HEAD'], f.workspace), base = f.git(['rev-parse', 'main']);
    fs.writeFileSync(path.join(f.repo, 'work.txt'), 'operator edit\n');
    const r = f.settle(run); assert.equal(r.status, 1); assert.match(r.stderr, /canonical checkout is dirty/);
    assert.equal(JSON.parse(r.stdout).result, 'escalate');
    assert.equal(f.git(['rev-parse', 'main']), base);
    if (cached) assert.equal(f.git(['rev-parse', 'HEAD'], f.workspace), laneHead);
    assert.equal(fs.readFileSync(path.join(f.repo, 'work.txt'), 'utf8'), 'operator edit\n');
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
  const r = result(h.settle(ready)); assert.equal(r.result, 'escalate'); assert.match(r.reason, /superseded/);
  const i = fixture(t), concurrent = i.start(); i.commit('correct\n'); i.report(concurrent);
  i.record(['start', i.show(concurrent).item, '--workspace', i.repo]);
  assert.equal(result(i.settle(concurrent)).result, 'escalate');
  assert.equal(i.calls().length, 0, 'an open run on the same item in another checkout prevents overlap');
});
