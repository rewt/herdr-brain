import { healthyMemoryEnvironment } from '../../test/helpers/promotion-memory-fixture.mjs';
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
  const env = { ...healthyMemoryEnvironment(), GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', SUPERVISOR_INPUT_CONFIRM_SECONDS: '0.001', SUPERVISOR_INPUT_POLL_SECONDS: '0.001' };
  for (const key of Object.keys(env)) if (/^(LANE_|ORG_|HERDR_|GIT_(DIR|WORK_TREE|INDEX_FILE|COMMON_DIR|CONFIG_COUNT))/.test(key)) delete env[key];
  const exec = (command, args, cwd = repo) => spawnSync(command, args, { cwd, env, encoding: 'utf8', [commandAllowance]: 60000 });
  const git = (args, cwd = repo) => { const result = exec('git', args, cwd); assert.equal(result.status, 0, result.stderr); return result.stdout.trim(); };
  git(['init', '-qb', 'main']); git(['config', 'user.name', 'Workflow']); git(['config', 'user.email', 'workflow@example.invalid']);
  const counts = path.join(root, 'gates'), checker = path.join(root, 'check.cjs');
  fs.writeFileSync(checker, `const fs=require('fs');fs.appendFileSync(${JSON.stringify(counts)},'gate\\n');console.log('gate output');if(fs.existsSync('bad'))process.exit(7);`);
  fs.writeFileSync(path.join(repo, '.lane.validation.json'), JSON.stringify({ promotion: `${process.execPath} ${checker}` }));
  fs.writeFileSync(path.join(repo, 'base'), 'base');
  // The skipped preparation step must keep looping within preparation rather
  // than retrying the same group forever.
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
  const run = () => exec(process.execPath, [path.join(product, 'lanes/lane.mjs'), 'promote-batch', file]);
  const plan = () => JSON.parse(fs.readFileSync(file));
  return { root, repo, workspace, env, exec, git, identity, file, head, base, run, plan, counts, product };
}

// The Markdown workflow engine was retired. Its saved fields stay readable:
// queue jobs keep "workflow": false/true and receipts may name plan.workflow.
test('a copied product train promotes without any workflow engine', t => {
  const f = fixture(t, { copied: true });
  assert.equal(fs.existsSync(path.join(f.product, 'workflow')), false);
  assert.equal(fs.existsSync(path.join(f.product, '.herdr/workflows')), false);
  const result = f.run(); assert.equal(result.status, 0, result.stderr);
  const plan = f.plan(); assert.equal(plan.results.first.outcome, 'promoted');
  assert.equal(plan.workflow, undefined); assert.equal(plan.workflow_runs, undefined);
  assert.equal(f.git(['rev-parse', 'main']), plan.attempts[0].tip);
  assert.equal(fs.readFileSync(f.counts, 'utf8'), 'gate\n');
  assert.equal(f.git(['status', '--porcelain']), '');
  assert.equal(f.git(['rev-list', '--merges', 'main']), '');
});

test('a receipt saved by the retired workflow engine finishes on the default train', t => {
  const f = fixture(t), plan = f.plan();
  plan.workflow = { file: '/retired/.herdr/workflows/train.md', hash: 'retired' }; fs.writeFileSync(f.file, JSON.stringify(plan));
  const result = f.run(); assert.equal(result.status, 0, result.stderr);
  const saved = f.plan(); assert.equal(saved.results.first.outcome, 'promoted');
  assert.equal(saved.workflow_runs, undefined);
  assert.equal(f.git(['rev-parse', 'main']), saved.attempts[0].tip);
  assert.equal(fs.readFileSync(f.counts, 'utf8'), 'gate\n');
});

test('lane promote-batch no longer takes the retired workflow flag', t => {
  const f = fixture(t);
  const result = f.exec(process.execPath, [path.join(source, 'lanes/lane.mjs'), 'promote-batch', f.file, '--workflow']);
  assert.notEqual(result.status, 0); assert.match(result.stderr, /usage: lane promote-batch RECEIPT/);
  assert.equal(f.git(['rev-parse', 'main']), f.base); assert.equal(fs.existsSync(f.counts), false);
});

test('older queued jobs that carry a workflow field are accepted and promoted on the default train', t => {
  const f = fixture(t), queue = queueFor(f.repo), herdr = path.join(f.root, 'herdr');
  fs.writeFileSync(herdr, `#!${process.execPath}\nconst a=process.argv.slice(2);if(a[0]==='agent'&&a[1]==='get')console.log(JSON.stringify({result:{agent:{agent:'claude',agent_status:'idle',pane_id:'fake'}}}));else if(a[0]==='pane'&&a[1]==='read')console.log('────────────────────\\n❯ \\n────────────────────');else console.log(JSON.stringify({result:{workspaces:[],agents:[]}}));`, { mode: 0o755 });
  enqueue(queue, ['first'], { workflow: true, expectedHead: f.head, org: null, herdr, to: 'fake', attempts: 1, retry: 0, laneCLI: path.join(source, 'lanes/lane.mjs') });
  assert.equal(queue.load().pending[0].workflow, true);
  const result = f.exec(process.execPath, [path.join(source, 'promote/promote.mjs'), '--drain'], f.repo);
  assert.equal(result.status, 0, result.stderr);
  const saved = queue.load().results[0]; assert.equal(saved.outcome, 'promoted', JSON.stringify(saved));
  const plan = JSON.parse(fs.readFileSync(saved.receipt));
  assert.equal(plan.workflow, undefined); assert.equal(plan.workflow_runs, undefined);
  assert.equal(f.git(['rev-parse', 'main']), plan.attempts[0].tip);
});
