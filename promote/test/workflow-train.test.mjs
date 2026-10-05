import test from '../../test/helpers/bounded-test.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { commandAllowance } from '../../test/helpers/command-allowance.mjs';
import { queueFor, enqueue } from '../promote.mjs';
import { waitForInboxIdle } from '../../test/helpers/inbox.mjs';
import { copyProduct } from '../../lib/product-files.mjs';

const source = fileURLToPath(new URL('../../', import.meta.url));
function fixture(t, { red = false, copied = false } = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'workflow-train-'))), repo = path.join(root, 'repo');
  fs.mkdirSync(repo);
  const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', PROMOTE_WORKFLOW_ENGINE: '0',
    SUPERVISOR_INPUT_CONFIRM_SECONDS: '0.001', SUPERVISOR_INPUT_POLL_SECONDS: '0.001' };
  for (const key of Object.keys(env)) if (/^(LANE_|ORG_|HERDR_|GIT_(DIR|WORK_TREE|INDEX_FILE|COMMON_DIR|CONFIG_COUNT))/.test(key)) delete env[key];
  const exec = (command, args, cwd = repo) => spawnSync(command, args, { cwd, env, encoding: 'utf8', [commandAllowance]: 60000 });
  const git = (args, cwd = repo) => { const result = exec('git', args, cwd); assert.equal(result.status, 0, result.stderr); return result.stdout.trim(); };
  git(['init', '-qb', 'main']); git(['config', 'user.name', 'Workflow']); git(['config', 'user.email', 'workflow@example.invalid']);
  const counts = path.join(root, 'gates'), checker = path.join(root, 'check.cjs');
  fs.writeFileSync(checker, `const fs=require('fs');fs.appendFileSync(${JSON.stringify(counts)},'gate\\n');console.log('gate output');if(fs.existsSync('bad'))process.exit(7);`);
  fs.writeFileSync(path.join(repo, '.lane.validation.json'), JSON.stringify({ promotion: `${process.execPath} ${checker}` }));
  fs.writeFileSync(path.join(repo, 'base'), 'base');
  // The skipped preparation step must keep looping within preparation, rather
  // than stopping the workflow or retrying the same group forever.
  fs.writeFileSync(path.join(repo, '.lane.json'), JSON.stringify({ prepare: [{ unless: 'base', run: 'exit 1' }] }));
  git(['add', '.']); git(['commit', '-qm', 'Base']);
  const workspace = path.join(root, 'first'); git(['worktree', 'add', '-qb', 'lane/first', workspace]);
  fs.writeFileSync(path.join(workspace, red ? 'bad' : 'first'), 'first'); git(['add', '.'], workspace); git(['commit', '-qm', 'First'], workspace);
  const identity = fs.realpathSync(path.join(repo, '.git')), directory = path.join(identity, 'promote/batches/example');
  fs.mkdirSync(directory, { recursive: true });
  const file = path.join(directory, 'train.json'), head = git(['rev-parse', 'HEAD'], workspace), base = git(['rev-parse', 'main']);
  fs.writeFileSync(file, JSON.stringify({ schema: 'promotion-train/v1', id: 'example', identity,
    jobs: [{ id: 'first', topic: 'first', expectedHead: head }], phase: 'pending' }));
  t.after(async () => { await waitForInboxIdle(path.join(identity, 'supervisor/inbox.log')); fs.rmSync(root, { recursive: true, force: true }); });
  const product = copied ? path.join(root, 'product') : source;
  if (copied) copyProduct(source, product);
  const run = (...flags) => exec(process.execPath, [path.join(product, 'lanes/lane.mjs'), 'promote-batch', file, ...flags]);
  const plan = () => JSON.parse(fs.readFileSync(file));
  return { root, repo, workspace, env, exec, git, identity, file, head, base, run, plan, counts, product };
}

test('copied default train promotes without the opt-in engine or workflow definitions', t => {
  const f = fixture(t, { copied: true });
  fs.rmSync(path.join(f.product, 'workflow'), { recursive: true, force: true });
  fs.rmSync(path.join(f.product, '.herdr/workflows'), { recursive: true, force: true });
  const result = f.run(); assert.equal(result.status, 0, result.stderr);
  const plan = f.plan(); assert.equal(plan.results.first.outcome, 'promoted');
  assert.equal(plan.workflow, undefined); assert.equal(plan.workflow_runs, undefined);
  assert.equal(f.git(['rev-parse', 'main']), plan.attempts[0].tip);
  assert.equal(fs.readFileSync(f.counts, 'utf8'), 'gate\n');
  assert.equal(f.git(['status', '--porcelain']), '');
  assert.equal(f.git(['rev-list', '--merges', 'main']), '');
});

test('copied opt-in train carries its engine and workflow definitions and promotes with receipts', t => {
  const f = fixture(t, { copied: true });
  assert.ok(!fs.existsSync(path.join(f.product, 'promote/test')), 'the train uses the distributed product');
  const result = f.run('--workflow'); assert.equal(result.status, 0, result.stderr);
  const plan = f.plan(), execution = JSON.parse(fs.readFileSync(plan.workflow_runs[0]));
  assert.equal(plan.results.first.outcome, 'promoted');
  assert.equal(plan.workflow.file, path.join(f.product, '.herdr/workflows/train.md'));
  assert.equal(execution.status, 'succeeded');
  assert.deepEqual(execution.steps.map(s => [s.id, s.status]), ['prepare', 'validate', 'integrate', 'close'].map(id => [id, 'succeeded']));
  assert.equal(f.git(['rev-parse', 'main']), plan.attempts[0].tip);
  assert.equal(fs.readFileSync(f.counts, 'utf8'), 'gate\n');
  assert.equal(f.git(['status', '--porcelain']), '');
  assert.equal(f.git(['rev-list', '--merges', 'main']), '');
});

test('promotion lock stays held while the opt-in engine loads and releases on a load failure', t => {
  const f = fixture(t, { copied: true }), contenderFile = path.join(f.root, 'contender.json');
  const engine = path.join(f.product, 'workflow/engine.mjs');
  // Attempt a second batch from inside module initialization, across the new
  // asynchronous import boundary. It must refuse before touching the plan.
  fs.appendFileSync(engine, `\nconst contender = spawnSync(process.execPath, ${JSON.stringify([path.join(f.product, 'lanes/lane.mjs'), 'promote-batch', f.file])}, { cwd: ${JSON.stringify(f.repo)}, env: process.env, encoding: 'utf8' });\nfs.writeFileSync(${JSON.stringify(contenderFile)}, JSON.stringify({ status: contender.status, stderr: contender.stderr }));\nthrow new Error('scripted engine load failure');\n`);
  const failed = f.run('--workflow'); assert.equal(failed.status, 1); assert.match(failed.stderr, /scripted engine load failure/);
  const contender = JSON.parse(fs.readFileSync(contenderFile));
  assert.equal(contender.status, 1); assert.match(contender.stderr, /locked: .*lane-promote.lock/);
  assert.equal(f.git(['rev-parse', 'main']), f.base);
  assert.equal(fs.existsSync(f.counts), false);
  assert.equal(fs.existsSync(path.join(f.identity, 'lane-promote.lock')), false);
  const retry = f.run(); assert.equal(retry.status, 0, retry.stderr);
  assert.equal(f.plan().results.first.outcome, 'promoted');
});

test('explicit train workflow flag produces per-stage receipts and preserves the actual green gate proof', t => {
  const f = fixture(t), result = f.run('--workflow'); assert.equal(result.status, 0, result.stderr);
  const plan = f.plan(), execution = JSON.parse(fs.readFileSync(plan.workflow_runs[0]));
  assert.equal(plan.phase, 'complete'); assert.equal(plan.results.first.outcome, 'promoted');
  assert.equal(execution.status, 'succeeded');
  assert.deepEqual(execution.steps.map(s => [s.id, s.status]), ['prepare', 'validate', 'integrate', 'close'].map(id => [id, 'succeeded']));
  for (const step of execution.steps) {
    const receipt = JSON.parse(fs.readFileSync(step.receipt));
    assert.equal(receipt.status, 'succeeded'); assert.ok(Date.parse(receipt.finished_at) >= Date.parse(receipt.started_at));
    assert.ok(fs.existsSync(receipt.output_path));
  }
  assert.equal(execution.steps[1].artifact, plan.results.first.gate.log);
  assert.equal(fs.readFileSync(f.counts, 'utf8'), 'gate\n');
  assert.equal(f.git(['rev-parse', 'main']), plan.attempts[0].tip);
  assert.equal(f.git(['rev-list', '--merges', 'main']), ''); assert.equal(f.git(['remote']), '');
  assert.equal(f.git(['status', '--porcelain']), '');
});

test('engine red receipts retain the real gate exit and cannot reach integration', t => {
  const f = fixture(t, { red: true }), result = f.run('--workflow'); assert.equal(result.status, 0, result.stderr);
  const plan = f.plan(), execution = JSON.parse(fs.readFileSync(plan.workflow_runs[0]));
  assert.equal(plan.results.first.outcome, 'refused'); assert.equal(f.git(['rev-parse', 'main']), f.base);
  assert.deepEqual(execution.steps.map(s => s.status), ['succeeded', 'failed', 'skipped', 'skipped']);
  assert.equal(execution.steps[1].exit_code, 7); assert.equal(plan.attempts[0].gate.exit_code, 7);
  assert.ok(fs.existsSync(f.workspace)); assert.equal(fs.readFileSync(f.counts, 'utf8'), 'gate\n');
});

test('default train does not execute a workflow or create workflow receipts', t => {
  const f = fixture(t), result = f.run(); assert.equal(result.status, 0, result.stderr);
  const plan = f.plan(); assert.equal(plan.results.first.outcome, 'promoted');
  assert.equal(plan.workflow, undefined); assert.equal(plan.workflow_runs, undefined);
});

test('a pinned workflow hash refuses a changed definition even when resumed without the flag', t => {
  const f = fixture(t), plan = f.plan(); plan.workflow = { hash: 'changed' }; fs.writeFileSync(f.file, JSON.stringify(plan));
  const result = f.run(); assert.equal(result.status, 1); assert.match(result.stderr, /workflow changed during batch/);
  assert.equal(f.git(['rev-parse', 'main']), f.base); assert.equal(fs.existsSync(f.counts), false);
});

test('the promotion queue persists and forwards the workflow choice independently of worker environment', t => {
  const f = fixture(t), queue = queueFor(f.repo), herdr = path.join(f.root, 'herdr');
  fs.writeFileSync(herdr, `#!${process.execPath}\nconst a=process.argv.slice(2);if(a[0]==='agent'&&a[1]==='get')console.log(JSON.stringify({result:{agent:{agent:'claude',agent_status:'idle',pane_id:'fake'}}}));else if(a[0]==='pane'&&a[1]==='read')console.log('────────────────────\\n❯ \\n────────────────────');else console.log(JSON.stringify({result:{workspaces:[],agents:[]}}));`, { mode: 0o755 });
  enqueue(queue, ['first'], { workflow: true, expectedHead: f.head, org: null, herdr, to: 'fake', attempts: 1, retry: 0, laneCLI: path.join(source, 'lanes/lane.mjs') });
  assert.equal(queue.load().pending[0].workflow, true);
  const result = f.exec(process.execPath, [path.join(source, 'promote/promote.mjs'), '--drain']); assert.equal(result.status, 0, result.stderr);
  const saved = queue.load().results[0]; assert.equal(saved.outcome, 'promoted');
  const plan = JSON.parse(fs.readFileSync(saved.receipt)); assert.ok(plan.workflow.hash); assert.equal(plan.workflow_runs.length, 1);
});
