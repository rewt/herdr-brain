// End-to-end scratch cycle. Git, validation, report intake, review publication,
// proved rebase and promotion are real; only reviewer model transport is scripted.
import test from '../../test/helpers/bounded-test.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fixture } from './fixture.mjs';
import { queueFor, enqueue } from '../../promote/promote.mjs';

test('distinct worker, settle and queue panes reuse each tree through same-tree rebase and queued promotion', { timeout: 30000 }, t => {
  const f = fixture(t, { actor: 'validation-cycle-test' });
  const log = path.join(f.root, 'trees.jsonl'), checker = path.join(f.root, 'validation.cjs');
  fs.writeFileSync(checker, `const fs=require('fs'),cp=require('child_process');for(const key of ['HERDR_PANE_ID','HERDR_TAB_ID','HERDR_WORKSPACE_ID'])require('assert').equal(process.env[key],undefined);fs.appendFileSync(${JSON.stringify(log)},JSON.stringify({head:cp.execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),tree:cp.execFileSync('git',['rev-parse','HEAD^{tree}'],{encoding:'utf8'}).trim()})+'\\n');`);
  const command = `${process.execPath} ${checker}`;
  const declaration = path.join(f.repo, '.lane.validation.json');
  fs.writeFileSync(declaration, JSON.stringify({ fast: command, promotion: command, release: 'must-never-run-release' }));
  f.git(['add', '.lane.validation.json']); f.git(['commit', '-qm', 'Declare scratch tiers']);
  f.git(['rebase', 'main'], f.workspace);
  const run = f.start(); f.commit('correct\n'); f.report(run);
  Object.assign(f.env, { HERDR_PANE_ID: 'worker:pane', HERDR_TAB_ID: 'worker:tab', HERDR_WORKSPACE_ID: 'worker:workspace' });
  const lane = (args, cwd = f.workspace) => {
    const r = f.exec(process.execPath, [path.join(f.source, 'lanes/lane.mjs'), ...args], cwd);
    assert.equal(r.status, 0, r.stderr + r.stdout); return r.stdout;
  };
  lane(['check']);
  const workerHead = f.git(['rev-parse', 'HEAD'], f.workspace);
  Object.assign(f.env, { HERDR_PANE_ID: 'settle:pane', HERDR_TAB_ID: 'settle:tab', HERDR_WORKSPACE_ID: 'settle:workspace' });
  f.git(['commit', '--allow-empty', '-qm', 'Move integration history without changing its tree']);
  const settled = f.settle(run); assert.equal(settled.status, 0, settled.stderr);
  const result = JSON.parse(settled.stdout); assert.equal(result.result, 'promotable');
  const journal = JSON.parse(fs.readFileSync(path.join(f.org, 'settle', run + '.json'), 'utf8'));
  assert.match(fs.readFileSync(path.join(path.dirname(journal.validation.log), run + '.validation.log'), 'utf8'), /REUSE/);
  assert.equal(result.rebase.state, 'applied');
  const cached = f.settle(run); assert.equal(cached.status, 0, cached.stderr);
  assert.match(fs.readFileSync(JSON.parse(cached.stdout).validation.log, 'utf8'), /REUSE/);
  assert.equal(f.git(['status', '--porcelain'], f.workspace), '');
  const queue = queueFor(f.repo);
  enqueue(queue, ['topic'], { expectedHead: result.head, run, org: f.org, to: 'scratch-supervisor',
    herdr: path.join(f.root, 'bin/herdr'), laneCLI: path.join(f.source, 'lanes/lane.mjs'), attempts: 1, retry: 0 });
  Object.assign(f.env, { HERDR_PANE_ID: 'queue:pane', HERDR_TAB_ID: 'queue:tab', HERDR_WORKSPACE_ID: 'queue:workspace' });
  const promoted = f.exec(process.execPath, [path.join(f.source, 'promote/promote.mjs'), '--drain']);
  assert.equal(promoted.status, 0, promoted.stderr);
  const promotion = queue.load().results[0]; assert.equal(promotion.outcome, 'promoted', promotion.reason);
  assert.match(fs.readFileSync(promotion.log, 'utf8'), /REUSE/);
  const checks = fs.readFileSync(log, 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(checks.length, 2, 'worker tree and tree including the public review record each run once');
  assert.equal(checks[0].head, workerHead); assert.equal(checks[1].head, result.head);
  assert.equal(new Set(checks.map(row => row.tree)).size, 2);
  assert.equal(f.git(['rev-parse', 'main']), result.head);
  assert.equal(f.git(['status', '--porcelain'], f.repo), '');
  assert.equal(fs.existsSync(f.workspace), false, 'queue closed only the scratch lane');
  assert.match(fs.readFileSync(journal.validation.log, 'utf8'), /GATE/);
});

test('saved settle readiness rechecks command and environment without repeating review', { timeout: 30000 }, t => {
  const f = fixture(t, { actor: 'validation-readiness-test' });
  const log = path.join(f.root, 'checks'), checker = path.join(f.root, 'check.cjs');
  fs.writeFileSync(checker, `require('fs').appendFileSync(${JSON.stringify(log)},'check\\n');`);
  f.env.LANE_VALIDATE = `${process.execPath} ${checker}`;
  const run = f.start(); f.commit('correct\n'); f.report(run);
  assert.equal(JSON.parse(f.settle(run).stdout).result, 'promotable');
  const reviews = f.calls().filter(args => args[0] === 'agent' && args[1] === 'start').length;
  assert.equal(fs.readFileSync(log, 'utf8'), 'check\ncheck\n');
  const again = f.settle(run); assert.equal(again.status, 0, again.stderr);
  assert.equal(fs.readFileSync(log, 'utf8'), 'check\ncheck\n');
  f.env.VALIDATION_VARIANT = 'changed';
  assert.equal(f.settle(run).status, 0);
  assert.equal(fs.readFileSync(log, 'utf8'), 'check\ncheck\ncheck\n');
  f.env.LANE_VALIDATE = 'exit 17';
  const red = JSON.parse(f.settle(run).stdout); assert.equal(red.result, 'escalate');
  assert.match(red.reason, /validation no longer passes/);
  assert.equal(f.calls().filter(args => args[0] === 'agent' && args[1] === 'start').length, reviews);
});
