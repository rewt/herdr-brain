import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
const source = fileURLToPath(new URL('../../', import.meta.url));

for (const harness of ['codex', 'claude']) test(`copied ${harness} probe product validates, guards and promotes worker and routing changes offline`, { timeout: 90000 }, (t) => {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'monitor-probe-worker-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (/^(ORG_|LANE_|MONITOR_|GIT_|HERDR_)/u.test(key)) delete env[key];
  delete env.NODE_TEST_CONTEXT; // Project node --test must start its own runner.
  Object.assign(env, { ORG_ACTOR: `r107-copied-${harness}-test`, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' });
  const invoke = (binary, args, cwd = root, extra = {}) => {
    const result = spawnSync(binary, args, { cwd, env: { ...env, ...extra }, encoding: 'utf8', timeout: 35000, killSignal: 'SIGKILL', maxBuffer: 4 * 1024 * 1024 });
    assert.ifError(result.error);
    return result;
  };
  const success = (result) => { assert.equal(result.status, 0, result.stdout + result.stderr); return result.stdout.trim(); };
  const native = path.join(root, 'scripted-native');
  fs.writeFileSync(native, `#!${process.execPath}\nprocess.exit(require(${JSON.stringify(path.join(source, 'discovery/test/helpers/probe-worker.cjs'))})());\n`, { mode: 0o755 });
  // Use the probe's actual snapshot and install. Skipping live work reads no auth
  // and makes no model call; scripted sessions exercise those omitted mechanics.
  const probe = invoke(process.execPath, [path.join(source, 'discovery/acceptance.mjs'), '--harness', harness,
    '--binary', native, '--validator', native, '--skip-live', '--keep']);
  assert.equal(probe.status, 1, probe.stdout + probe.stderr);
  const evidence = probe.stdout.match(/^Evidence: (.+)$/mu)?.[1]; assert.ok(evidence, probe.stdout + probe.stderr);
  const summary = JSON.parse(fs.readFileSync(path.join(evidence, 'summary.json'), 'utf8'));
  t.after(() => {
    fs.rmSync(summary.install, { recursive: true, force: true });
    fs.rmSync(summary.scratch, { recursive: true, force: true });
  });
  assert.equal(summary.setupComplete, true);
  assert.equal(summary.results.filter((row) => row.status === 'FAIL').length, 0);
  assert.equal(summary.results.filter((row) => row.status === 'PENDING').length, 2);
  assert.deepEqual(summary.usage, []);
  const product = path.join(summary.install, 'product'), bin = path.join(summary.install, 'bin');
  assert.ok(!fs.existsSync(path.join(product, 'discovery/test')), 'the copied product contains no source tests');
  const repo = path.join(root, 'project'); fs.mkdirSync(repo);
  const git = (...args) => success(invoke('git', ['-C', repo, ...args]));
  git('init', '-q', '-b', 'main'); git('config', 'user.name', 'Copied probe test'); git('config', 'user.email', 'test@example.invalid');
  fs.writeFileSync(path.join(repo, 'greetings.mjs'), "export const greetings = { en: 'Hello' };\n");
  fs.mkdirSync(path.join(repo, 'test'));
  fs.writeFileSync(path.join(repo, 'test/greetings.test.mjs'), "import test from 'node:test'; import assert from 'node:assert/strict'; import {greetings} from '../greetings.mjs'; test('English stays',()=>assert.equal(greetings.en,'Hello'));\n");
  git('add', '.'); git('commit', '-qm', 'Seed unrelated project');
  const record = (...args) => success(invoke(process.execPath, [path.join(product, 'bin/org.mjs'), ...args], repo, { ORG_DIR: path.join(repo, '.org') }));
  for (const task of ['work', 'routes']) {
    if (task === 'routes') {
      const state = JSON.parse(record('status', '--json'));
      const question = state.items.find((item) => item.role === 'human' && !item.closed); assert.ok(question);
      assert.equal(question.meta.category, 'other');
      success(invoke(process.execPath, [path.join(product, 'bin/org.mjs'), 'answer', question.id, 'yes', '--note', 'Scripted operator approves preset'], repo,
        { ORG_DIR: path.join(repo, '.org'), ORG_ACTOR: 'human' }));
    }
    const receipt = path.join(root, `${task}.json`);
    success(invoke(path.join(bin, `monitor-${harness}`), ['--', 'Scripted offline task'], repo, {
      PROBE_PRODUCT: product, PROBE_TASK: task, PROBE_WORKER_RECEIPT: receipt,
      MONITOR_RUNTIME_DIR: path.join(root, 'runtime'), MONITOR_WORKTREE_ROOT: path.join(root, 'lanes'),
    }));
    const worker = JSON.parse(fs.readFileSync(receipt, 'utf8'));
    assert.equal(git('rev-parse', 'main'), worker.head);
    assert.equal(git('status', '--porcelain'), '');
    assert.equal(git('rev-list', '--merges', 'main'), '');
    const state = JSON.parse(record('status', '--json'));
    assert.equal(state.runs.at(-1).report.outcome, 'done');
    if (task === 'routes') {
      const routes = JSON.parse(fs.readFileSync(path.join(repo, '.lane.json'), 'utf8')).routes;
      assert.equal(routes.engineer.model, 'gpt-6.1-sol'); assert.equal(routes.review.model, 'opus');
      assert.equal(state.items.find((item) => item.id === worker.context.routing.parent).closed.as, 'done');
    }
  }
});
