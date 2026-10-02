import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fixture } from '../../settle/test/fixture.mjs';
import { coldStart, renderColdStart, receiptDirectory } from '../context.mjs';
import { entryPolicy } from '../../discovery/policy.mjs';
import { supervisorCase } from '../../acceptance/supervisor.mjs';
const root = fileURLToPath(new URL('../../', import.meta.url));
process.env.ORG_ACTOR = 'supervisor-test-reader';
const invoke = (f, args, cwd = f.repo) => f.exec(process.execPath, [path.join(root, 'supervisor/supervisor.mjs'), ...args], cwd, { ORG_DIR: f.org });
const result = (r) => { assert.equal(r.status, 0, r.stderr); return JSON.parse(r.stdout); };

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
