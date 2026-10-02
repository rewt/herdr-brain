import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fixture } from '../../settle/test/fixture.mjs';
import { coldStart, renderColdStart, receiptDirectory } from '../context.mjs';
import { entryPolicy } from '../../discovery/policy.mjs';
import { supervisorCase } from '../../acceptance/supervisor.mjs';
import { queueFor } from '../../promote/promote.mjs';
const root = fileURLToPath(new URL('../../', import.meta.url));
process.env.ORG_ACTOR = 'supervisor-test-reader';
const invoke = (f, args, cwd = f.repo) => f.exec(process.execPath, [path.join(root, 'supervisor/supervisor.mjs'), ...args], cwd, { ORG_DIR: f.org });
const result = (r) => { assert.equal(r.status, 0, r.stderr); return JSON.parse(r.stdout); };

// Only defer drain to make the queued mutation deterministic. Enqueue and all
// execution checks still run the real queue, lane CLI, Git and record.
function promotionHarness(f, run) {
  const cli = path.join(f.root, 'deferred-promote.mjs');
  fs.writeFileSync(cli, `import {parseArgs} from 'node:util'; import {queueFor,enqueue} from ${JSON.stringify(path.join(root, 'promote/promote.mjs'))};
const {values:o,positionals:p}=parseArgs({allowPositionals:true,options:Object.fromEntries(['repo','org','to','expected-head','if-current-run'].map(k=>[k,{type:'string'}]))});
const q=queueFor(o.repo);const jobs=enqueue(q,p,{org:o.org,expectedHead:o['expected-head'],run:o['if-current-run'],to:o.to??'supervisor',attempts:1,retry:0,herdr:'herdr',laneCLI:${JSON.stringify(path.join(root, 'lanes/lane.mjs'))},validate:process.env.LANE_VALIDATE??null});console.log(JSON.stringify({jobs,queue:q.file}));\n`);
  const queue = queueFor(f.repo);
  const promote = (extra = []) => invoke(f, ['promote', run, '--role', 'supervisor', '--why', 'Reviewed work under test authority', '--promote-cli', cli, ...extra]);
  const drain = () => result(f.exec(process.execPath, [path.join(root, 'promote/promote.mjs'), '--repo', f.repo, '--drain']));
  const handle = (job) => result(invoke(f, ['handle', '--notice', `[promote-queue] id=${job.id} lane=${job.topic}`, '--role', 'supervisor']));
  return { queue, promote, drain, handle };
}

test('STOP arriving during review retains a resumable correction without launching another worker', { timeout: 25000 }, (t) => {
  const f = fixture(t, { actor: 'supervisor-review-stop-test' }), run = f.start(); f.commit('wrong\n'); f.report(run);
  fs.writeFileSync(path.join(f.root, 'review-stop'), '');
  const stopped = result(invoke(f, ['handle', run, '--role', 'supervisor']));
  assert.equal(stopped.result, 'stopped'); assert.match(stopped.next, /--retry/);
  assert.match(fs.readFileSync(stopped.handoff, 'utf8'), /no new worker launched/);
  const job = JSON.parse(fs.readFileSync(stopped.journal, 'utf8'));
  assert.equal(job.stage, 'fix'); assert.equal(job.review.verdict, 'NEEDS-WORK'); assert.ok(fs.existsSync(job.fixBrief));
  assert.equal(f.show(f.show(run).item).runs.length, 1);
  assert.equal(f.calls().filter((a) => a[1] === 'start').length, 1, 'only the reviewer launched');
  assert.equal(invoke(f, ['handle', run, '--retry', '--role', 'supervisor']).status, 1);
  fs.unlinkSync(path.join(f.repo, '.lane/supervisor/STOP'));
  const resumed = result(invoke(f, ['handle', run, '--retry', '--role', 'supervisor']));
  assert.equal(resumed.result, 'fix_round'); assert.equal(f.calls().filter((a) => a[1] === 'start').length, 2);
  assert.equal(result(invoke(f, ['handle', run, '--role', 'supervisor'])).fix.run, resumed.fix.run);
  assert.equal(f.calls().filter((a) => a[1] === 'start').length, 2, 'no review or correction replay');
});

test('supervisor binds head and run into the queue and retries confirmed refusals with history', { timeout: 25000 }, (t) => {
  const f = fixture(t, { actor: 'supervisor-promotion-retry-test' }), run = f.start(); f.commit('correct\n'); f.report(run);
  const ready = result(invoke(f, ['handle', run, '--role', 'supervisor'])); assert.equal(ready.result, 'promotable');
  const h = promotionHarness(f, run), first = result(h.promote());
  const queued = h.queue.load().pending[0];
  assert.equal(queued.expectedHead, ready.head); assert.equal(queued.run, run); assert.equal(queued.org, f.org);
  assert.equal(result(h.promote()).queue.jobs[0].id, first.queue.jobs[0].id);
  assert.match(h.promote(['--retry']).stderr, /confirmed refused/);
  fs.writeFileSync(path.join(f.repo, 'dirty'), 'Operator edit');
  assert.equal(h.drain().outcome, 'refused'); const refused = h.queue.load().results[0];
  assert.equal(h.handle(refused).result, 'judge_promotion');
  assert.equal(f.show(f.show(run).item).closed, null);
  assert.equal(result(h.promote()).queue.jobs[0].id, first.queue.jobs[0].id);
  assert.notEqual(h.promote(['--retry']).status, 0, 'readiness still refuses the dirty checkout');
  fs.unlinkSync(path.join(f.repo, 'dirty'));
  const retried = result(h.promote(['--retry']));
  assert.notEqual(retried.queue.jobs[0].id, first.queue.jobs[0].id);
  assert.equal(retried.prior_attempts.length, 1); assert.equal(retried.prior_attempts[0].result.id, refused.id);
  assert.equal(h.handle(refused).result, 'judge_promotion', 'late prior refusal remains bound');
  assert.equal(h.drain().outcome, 'promoted'); const promoted = h.queue.load().results[1];
  assert.equal(h.handle(promoted).result, 'recorded_promotion');
  assert.equal(f.show(f.show(run).item).status, 'done');
  assert.equal(result(h.promote(['--retry'])).queue.jobs[0].id, promoted.id, 'success is never retried after lane closure');
  assert.equal(h.handle(promoted).result, 'recorded_promotion');
});

test('bound promotion rechecks queued runs and record changes during validation before integration', { timeout: 40000 }, (t) => {
  for (const mode of ['queued-run', 'gate-blocker', 'gate-run']) {
    const f = fixture(t, { actor: `supervisor-promotion-${mode}-test` }), run = f.start(); f.commit('correct\n'); f.report(run);
    assert.equal(result(invoke(f, ['handle', run, '--role', 'supervisor'])).result, 'promotable');
    if (mode.startsWith('gate-')) {
      const gate = path.join(f.root, 'gate.mjs');
      const args = mode === 'gate-run' ? ['start', f.show(run).item, '--workspace', f.workspace] : ['ask', 'Block during validation?', '--parent', f.show(run).item, '--category', 'design', '--recommend', 'yes', '--why', 'Changed readiness', '--blocks', f.show(run).item, '--wait'];
      fs.writeFileSync(gate, `import {execFileSync} from 'node:child_process'; execFileSync(process.execPath,${JSON.stringify([path.join(root, 'bin/org.mjs'), ...args])},{env:{...process.env,ORG_DIR:${JSON.stringify(f.org)}}});\n`);
      f.env.LANE_VALIDATE = `${process.execPath} ${gate}`;
    }
    const h = promotionHarness(f, run); result(h.promote()); const base = f.git(['rev-parse', 'main']);
    if (mode === 'queued-run') f.start();
    const refused = h.drain(); assert.equal(refused.outcome, 'refused');
    assert.match(refused.reason, mode.endsWith('run') ? /superseded/ : /record readiness changed/);
    assert.equal(f.git(['rev-parse', 'main']), base); assert.ok(fs.existsSync(f.workspace));
    const log = fs.readFileSync(refused.log, 'utf8');
    if (mode === 'queued-run') assert.doesNotMatch(log, /validating in/);
    else assert.match(log, /validating in/);
    assert.equal(h.handle(h.queue.load().results[0]).result, 'judge_promotion');
    assert.equal(f.show(f.show(run).item).closed, null);
  }
});

test('late final reports recover completed promotion after lane closure and retain binding, integration and current-run guards', { timeout: 25000 }, (t) => {
  const f = fixture(t, { actor: 'supervisor-late-report-test' }), run = f.start(); f.commit('correct\n'); f.report(run);
  const ready = result(invoke(f, ['handle', run, '--role', 'supervisor'])); assert.equal(ready.result, 'promotable');
  const h = promotionHarness(f, run); result(h.promote());
  const base = f.git(['rev-parse', 'HEAD']);
  assert.equal(h.drain().outcome, 'promoted');
  assert.ok(!fs.existsSync(f.workspace));
  const notice = `[org-report] run=${run} item=${ready.item} outcome=done headline=The work is correct`;
  const handle = () => invoke(f, ['handle', '--notice', notice, '--role', 'supervisor']);

  // The report can arrive before the queue notice has completed the record.
  assert.equal(f.show(ready.item).closed, null);
  h.queue.transaction((q) => { q.results[0].expectedHead = base; });
  assert.match(handle().stderr, /head or run binding differs/);
  assert.equal(f.show(ready.item).closed, null);
  h.queue.transaction((q) => { q.results[0].expectedHead = ready.head; });
  f.git(['reset', '--hard', base]);
  assert.match(handle().stderr, /not integrated/);
  assert.equal(f.show(ready.item).closed, null);
  f.git(['reset', '--hard', ready.head]);
  const promoted = h.queue.load().results[0];
  const closed = result(handle()); assert.equal(closed.result, 'recorded_promotion'); assert.equal(closed.promotion.id, promoted.id);
  const events = fs.readFileSync(path.join(f.org, 'events.jsonl'), 'utf8');
  const calls = f.calls();
  assert.equal(result(handle()).result, 'recorded_promotion');
  assert.equal(result(invoke(f, ['handle', run, '--role', 'supervisor'])).result, 'recorded_promotion');
  assert.equal(h.handle(promoted).result, 'recorded_promotion');
  assert.equal(fs.readFileSync(path.join(f.org, 'events.jsonl'), 'utf8'), events, 'duplicate completion writes no events');
  assert.deepEqual(f.calls(), calls, 'duplicate completion calls no model or transport');
  assert.equal(h.queue.load().results.length, 1, 'no gate or promotion replay');

  f.start();
  assert.match(handle().stderr, /superseded/);
  assert.match(invoke(f, ['handle', '--notice', `[promote-queue] id=${promoted.id} lane=${promoted.topic}`, '--role', 'supervisor']).stderr, /superseded/);
  assert.equal(f.show(ready.item).status, 'active');
});

test('late original and correction notices after lane removal preserve promotion guards and never replay settlement', { timeout: 25000 }, (t) => {
  const f = fixture(t, { actor: 'supervisor-late-correction-test' }), original = f.start(); f.commit('wrong\n'); f.report(original);
  const correction = result(invoke(f, ['handle', original, '--role', 'supervisor']));
  assert.equal(correction.result, 'fix_round');
  const run = correction.fix.run, ready = result(invoke(f, ['handle', run, '--role', 'supervisor']));
  assert.equal(ready.result, 'promotable');
  const h = promotionHarness(f, run); result(h.promote()); const base = f.git(['rev-parse', 'HEAD']);
  assert.equal(h.drain().outcome, 'promoted'); assert.ok(!fs.existsSync(f.workspace));
  const handle = (id) => invoke(f, ['handle', '--notice', `[org-report] run=${id} item=${ready.item} outcome=done headline=The work is correct`,
    '--role', 'supervisor', '--settle-cli', path.join(f.root, 'must-not-settle.mjs')]);
  assert.equal(result(handle(original)).current_run, run);
  assert.equal(f.show(ready.item).closed, null, 'an old notice only reports supersession, never completes the correction');
  h.queue.transaction((q) => { q.results[0].expectedHead = base; });
  assert.match(handle(run).stderr, /head or run binding differs/);
  h.queue.transaction((q) => { q.results[0].expectedHead = ready.head; });
  f.git(['reset', '--hard', base]);
  assert.match(handle(run).stderr, /not integrated/);
  assert.equal(result(handle(original)).result, 'superseded');
  assert.equal(f.show(ready.item).closed, null, 'a superseded result never attests integration');
  f.git(['reset', '--hard', ready.head]);
  assert.equal(result(handle(run)).result, 'recorded_promotion');
  const events = fs.readFileSync(path.join(f.org, 'events.jsonl'), 'utf8'), calls = f.calls();
  for (let attempt = 0; attempt < 2; attempt++) {
    const old = result(handle(original)); assert.equal(old.result, 'superseded'); assert.equal(old.current_run, run);
    assert.equal(result(handle(run)).result, 'recorded_promotion');
    assert.equal(result(invoke(f, ['handle', original, '--role', 'supervisor'])).result, 'superseded');
  }
  assert.equal(fs.readFileSync(path.join(f.org, 'events.jsonl'), 'utf8'), events);
  assert.deepEqual(f.calls(), calls); assert.equal(h.queue.load().results.length, 1);
  const latest = f.start();
  assert.equal(result(handle(original)).current_run, latest);
  assert.match(handle(run).stderr, /superseded/); assert.equal(f.show(ready.item).status, 'active');
});

test('refusal retry cannot authorize a new unreviewed head or replay an interrupted attempt', { timeout: 20000 }, (t) => {
  const f = fixture(t, { actor: 'supervisor-retry-stale-test' }), run = f.start(); f.commit('correct\n'); f.report(run);
  assert.equal(result(invoke(f, ['handle', run, '--role', 'supervisor'])).result, 'promotable');
  const h = promotionHarness(f, run); const saved = result(h.promote());
  f.commit('Unreviewed new work\n');
  assert.equal(h.drain().outcome, 'refused');
  assert.match(h.promote(['--retry']).stderr, /HEAD or branch moved/);
  assert.equal(h.queue.load().pending.length, 0);
  assert.equal(result(h.promote()).queue.jobs[0].id, saved.queue.jobs[0].id);
  h.queue.transaction((q) => { q.results[0].outcome = 'interrupted'; });
  assert.match(h.promote(['--retry']).stderr, /confirmed refused/);
  assert.equal(h.queue.load().pending.length, 0);
});

test('supervisor entry and final notices carry the unconfigured cycle through actual promotion', { timeout: 90000 }, async () => {
  const proof = await supervisorCase(root);
  assert.match(proof.detail, /guarded record completion/);
});

test('cold start includes routes, priorities, history across midnight and a durable explicit reading cursor', { timeout: 15000 }, (t) => {
  const f = fixture(t, { actor: 'supervisor-cursor-test' }), run = f.start();
  const p = f.exec(process.execPath, [path.join(root, 'bin/org.mjs'), 'priorities', 'add', 'Keep continuity cheap', '--why', 'Operator direction'], f.repo, { ORG_DIR: f.org, ORG_ACTOR: 'human' });
  assert.equal(p.status, 0, p.stderr);
  f.record(['set', run, 'serves=P-1', 'model=opaque-model', 'effort=opaque-effort']);
  const record = (text, when) => {
    const r = f.exec(process.execPath, [path.join(root, 'bin/org.mjs'), 'note', f.show(run).item, text, '--decision'], f.repo, { ORG_DIR: f.org, ORG_NOW: when });
    assert.equal(r.status, 0, r.stderr);
  };
  record('Yesterday remains available', '2026-10-01T23:50:00Z');
  const before = fs.readFileSync(path.join(f.org, 'events.jsonl'), 'utf8');
  const doc = result(invoke(f, ['brief', '--json']));
  assert.equal(doc.priorities[0].title, 'Keep continuity cheap');
  assert.equal(doc.running[0].model, 'opaque-model');
  assert.equal(doc.running[0].serves, 'P-1');
  assert.ok(doc.decisions.some((d) => d.text === 'Yesterday remains available'));
  result(invoke(f, ['brief', '--json']));
  assert.equal(fs.readFileSync(path.join(f.org, 'events.jsonl'), 'utf8'), before);
  assert.ok(!fs.existsSync(receiptDirectory(f.org, path.join(f.repo, '.git'))), 'brief creates no module state');
  result(invoke(f, ['checkpoint', '--through', String(doc.project.through), '--role', 'supervisor']));
  record('New decision after clearing the chat', '2026-10-02T00:10:00Z');
  const next = result(invoke(f, ['brief', '--json']));
  assert.deepEqual(next.decisions.map((d) => d.text), ['New decision after clearing the chat']);
  const all = result(invoke(f, ['brief', '--json', '--since-seq', '0']));
  assert.ok(all.decisions.some((d) => d.text === 'Yesterday remains available'));
  assert.equal(invoke(f, ['checkpoint', '--through', '9999999', '--role', 'supervisor']).status, 1);
});

test('ingested report decisions retain provenance and rationale after closure and across checkpoints, scoped by repository', { timeout: 15000 }, (t) => {
  const f = fixture(t, { actor: 'supervisor-report-decisions-test' }), run = f.start(), item = f.show(run).item;
  const before = result(invoke(f, ['brief', '--json']));
  result(invoke(f, ['checkpoint', '--through', String(before.project.through), '--role', 'supervisor']));
  const report = f.show(run).report_path;
  fs.writeFileSync(report, `---\n${JSON.stringify({ run, outcome: 'done', headline: 'Decisions are recorded', summary: 'Keep the structured facts.',
    decisions: [{ text: 'Keep the record dependency-free.', category: 'design', why: 'Cold starts must work without installs or model calls.' },
      'Keep legacy decisions visible.', { decision: 'Retain older structured decision text.', why: 'Existing reports use this field.' }, {}, null] })}\n---\n\nNarrative decision: this must not enter the decision stream.\n`);
  assert.deepEqual(result(invoke(f, ['brief', '--json'])).decisions, [], 'a worker file alone is not recorded evidence');
  f.record(['ingest', report]);
  const ingestion = f.show(run).report;
  const recorded = result(invoke(f, ['brief', '--json']));
  assert.deepEqual(recorded.decisions.map((d) => d.text), ['Keep the record dependency-free.', 'Keep legacy decisions visible.', 'Retain older structured decision text.']);
  for (const decision of recorded.decisions) {
    assert.equal(decision.seq, ingestion.seq); assert.equal(decision.at, ingestion.at);
    assert.equal(decision.run, run); assert.equal(decision.item, item); assert.equal(decision.id, run);
    assert.equal(decision.source, 'report'); assert.equal(decision.by, 'original'); assert.equal(decision.ingested_by, `run:${run}`);
  }
  assert.equal(recorded.decisions[0].category, 'design');
  assert.equal(recorded.decisions[0].why, 'Cold starts must work without installs or model calls.');
  f.record(['close', item, '--if-current-run', run]);
  // Remove only this fixture's checkout; its exact settle identity receipt is
  // the same repository binding used after a real promotion closes the lane.
  fs.mkdirSync(path.join(f.org, 'settle'), { recursive: true });
  fs.writeFileSync(path.join(f.org, 'settle', `${run}.json`), JSON.stringify({ common: path.join(f.repo, '.git') }));
  f.git(['worktree', 'remove', f.workspace]);
  const events = fs.readFileSync(path.join(f.org, 'events.jsonl'), 'utf8');
  const closed = result(invoke(f, ['brief', '--json']));
  assert.deepEqual(closed.reports, []); assert.deepEqual(closed.decisions, recorded.decisions);
  assert.match(renderColdStart(closed), /R-1.*Keep the record dependency-free/);
  assert.equal(fs.readFileSync(path.join(f.org, 'events.jsonl'), 'utf8'), events, 'fresh sessions only read the record');

  const foreign = fixture(t, { actor: 'supervisor-report-foreign-test' });
  assert.deepEqual(coldStart({ cwd: foreign.repo, org: f.org }).decisions, [], 'closed report decisions cannot cross repository identity');
  result(invoke(f, ['checkpoint', '--through', String(closed.project.through), '--role', 'supervisor']));
  assert.deepEqual(result(invoke(f, ['brief', '--json'])).decisions, []);
  f.record(['note', item, 'Keep decisions after the report checkpoint.', '--decision']);
  assert.deepEqual(result(invoke(f, ['brief', '--json'])).decisions.map((d) => d.text), ['Keep decisions after the report checkpoint.']);
  const recovered = result(invoke(f, ['brief', '--json', '--since-seq', String(before.project.through)]));
  assert.deepEqual(recovered.decisions.slice(0, 3), recorded.decisions, 'explicit history recovery retains full report rationale');
  assert.equal(f.calls().length, 0);
});

test('workers, linked checkouts, STOP and intermediate notices cannot start supervisor mechanics', { timeout: 15000 }, (t) => {
  const f = fixture(t, { actor: 'supervisor-boundary-test' });
  const run = f.start(); f.report(run);
  assert.equal(invoke(f, ['handle', run]).status, 1);
  assert.equal(invoke(f, ['handle', run, '--role', 'worker']).status, 1);
  assert.equal(invoke(f, ['handle', run, '--role', 'supervisor'], f.workspace).status, 1);
  assert.equal(invoke(f, ['promote', run, '--role', 'supervisor', '--why', 'No evidence yet']).status, 1);
  assert.equal(f.show(run).report, null, 'promotion without saved readiness cannot ingest or start a review');
  for (const notice of ['[watch-blocked]', '[watch-invalid-report]', '[watch-no-report]', '[watch-unavailable]', '[watch-long-running]']) {
    assert.equal(result(invoke(f, ['handle', '--notice', `${notice} run=${run}`, '--role', 'supervisor'])).result, 'inspect_notice');
  }
  assert.equal(f.calls().length, 0);
  fs.mkdirSync(path.join(f.repo, '.lane/supervisor'), { recursive: true });
  fs.writeFileSync(path.join(f.repo, '.lane/supervisor/STOP'), 'Operator stop\n');
  assert.equal(invoke(f, ['handle', run, '--role', 'supervisor']).status, 1);
  assert.equal(coldStart({ cwd: f.repo, org: f.org }).project.stopped, true);
  const workerPolicy = entryPolicy({ role: 'worker', workspace: f.workspace, canonical: f.repo, identity: path.join(f.repo, '.git'), org: f.org }, root);
  assert.doesNotMatch(workerPolicy, /Supervisor cold start|supervisor\/supervisor.mjs|--role supervisor|--start/);
});

test('non-done reports hand off substance without review; saved enqueue uncertainty never replays', { timeout: 20000 }, (t) => {
  const f = fixture(t, { actor: 'supervisor-handoff-test' }), run = f.start(); f.report(run, 'blocked');
  const handed = result(invoke(f, ['handle', run, '--role', 'supervisor']));
  assert.equal(handed.result, 'escalate'); assert.match(fs.readFileSync(handed.handoff, 'utf8'), /scope decision/);
  assert.equal(f.calls().length, 0);
  const file = path.join(receiptDirectory(f.org, path.join(f.repo, '.git')), `${run}.json`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ identity: path.join(f.repo, '.git'), org: f.org, run, phase: 'enqueuing' }));
  const uncertain = invoke(f, ['promote', run, '--role', 'supervisor', '--why', 'Inspect prior attempt']);
  assert.equal(uncertain.status, 1); assert.match(uncertain.stderr, /enqueue is uncertain/);
  const uncertainRetry = invoke(f, ['promote', run, '--retry', '--role', 'supervisor', '--why', 'Inspect prior attempt']);
  assert.equal(uncertainRetry.status, 1); assert.match(uncertainRetry.stderr, /enqueue is uncertain/);
  assert.equal(f.calls().length, 0);
  assert.ok(coldStart({ cwd: f.repo, org: f.org }).reports[0].promotion);
});

test('full JSON preserves overflow, file presence awaits watch and foreign runs are excluded by Git identity', { timeout: 15000 }, (t) => {
  const f = fixture(t, { actor: 'supervisor-scope-test' }), run = f.start(); f.report(run);
  const doc = coldStart({ cwd: f.repo, org: f.org });
  assert.equal(doc.running[0].report_file_present, true);
  assert.equal(doc.next[0].action, 'await_watch_or_inspect');
  for (let i = 0; i < 9; i++) f.record(['note', doc.running[0].item, `Decision ${i}`, '--decision']);
  const full = coldStart({ cwd: f.repo, org: f.org });
  assert.equal(full.decisions.length, 9); assert.match(renderColdStart(full), /\+3 more/);
  const other = fixture(t, { actor: 'supervisor-foreign-test' });
  other.record(['start', other.show(other.start()).item, '--workspace', f.workspace]);
  const scoped = coldStart({ cwd: other.repo, org: other.org });
  assert.equal(scoped.running.length, 1, 'only the local run belongs to the second project');
});

test('conditional record completion preserves newer work, unresolved and declined blockers', { timeout: 15000 }, (t) => {
  const f = fixture(t, { actor: 'supervisor-completion-test' }), run = f.start(); f.report(run);
  f.record(['ingest', f.show(run).report_path]);
  const item = f.show(run).item;
  f.record(['reopen', item]);
  const question = f.record(['ask', 'May the scope change?', '--parent', item, '--category', 'design', '--recommend', 'yes', '--why', 'Scope changes the outcome', '--blocks', item, '--wait']).match(/HUM-\d+/)[0];
  const close = () => f.exec(process.execPath, [path.join(root, 'bin/org.mjs'), 'close', item, '--if-current-run', run], f.repo, { ORG_DIR: f.org });
  assert.equal(close().status, 1);
  f.record(['answer', question, 'no']); assert.equal(close().status, 1);
  f.record(['unblock', item, '--by', question]);
  assert.equal(close().status, 0);
  f.start(); assert.equal(close().status, 1);
  assert.equal(f.show(item).status, 'active');
});

test('a disappeared checkout retains its open record run through a dispatch identity receipt', { timeout: 15000 }, (t) => {
  const f = fixture(t, { actor: 'supervisor-missing-checkout-test' }), run = f.start();
  const journal = path.join(f.root, 'dispatch.json');
  fs.writeFileSync(journal, JSON.stringify({ common: path.join(f.repo, '.git'), workspace: f.workspace, run }));
  f.record(['set', run, `dispatch_journal=${journal}`]);
  f.git(['worktree', 'remove', f.workspace]);
  const doc = coldStart({ cwd: f.repo, org: f.org });
  assert.equal(doc.running[0].run, run); assert.equal(doc.running[0].checkout_missing, true);
  assert.equal(doc.next[0].action, 'inspect_open_run_missing_checkout');
  assert.match(renderColdStart(doc), /checkout missing; inspect record/);
  assert.equal(f.calls().length, 0);
});
