// Explicit, model-free Herdr reproduction; ordinary offline runners skip it.
// Run directly with LANE_HERDR_WORKSPACE_TEST=1 inside Herdr.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { startFocusMonitor, assertFocus } from '../../acceptance/focus.mjs';
import { cleanupWorkspaces } from '../../acceptance/cleanup.mjs';
import { stopProducers, awaitProducers } from '../../acceptance/producers.mjs';

const enabled = process.env.LANE_HERDR_WORKSPACE_TEST === '1';
const herdr = spawnSync('/bin/sh', ['-c', 'command -v herdr'], { encoding: 'utf8' }).stdout.trim();
const skip = !enabled ? 'opt in with LANE_HERDR_WORKSPACE_TEST=1 for scratch Herdr checks' :
  process.env.HERDR_ENV !== '1' || !herdr || process.env.HERDR_TEST_OFFLINE_ROOT ? 'Herdr is absent or unavailable in this pane' : false;
test('native dispatch opens a one-tab lane from a project with no Herdr workspace and preserves focus', { skip, timeout: 90_000 }, async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-lane-native-')));
  const repo = path.join(root, 'repo'), bin = path.join(root, 'bin'), evidence = path.join(root, 'evidence');
  for (const dir of [repo, bin, evidence]) fs.mkdirSync(dir);
  const env = { ...process.env, TMPDIR: root, ACCEPTANCE_ROOT: root, ORG_ACTOR: 'eng133-native-test',
    GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
  for (const key of Object.keys(env)) if (/^(LANE_|ORG_DIR|GIT_CONFIG_COUNT|GIT_CONFIG_KEY_|GIT_CONFIG_VALUE_)/u.test(key)) delete env[key];
  env.LANE_CONFIG = path.join(root, "lane.json");
  env.LANE_WORKTREE_ROOT = path.join(root, "worktrees");
  fs.writeFileSync(env.LANE_CONFIG, JSON.stringify({ main: "main", validate: "true", worktree_root: env.LANE_WORKTREE_ROOT }));
  const run = (cmd, args, extra = {}) => {
    const result = spawnSync(cmd, args, { cwd: repo, env, encoding: 'utf8', timeout: 40_000, ...extra });
    assert.equal(result.status, 0, result.stderr || result.stdout || result.error?.message);
    return result.stdout;
  };
  const native = args => JSON.parse(run(herdr, args)).result;
  let monitor;
  try {
    run('git', ['init', '-q', '-b', 'main']);
    fs.writeFileSync(path.join(repo, '.gitignore'), '.lane/\n');
    run('git', ['add', '.']);
    run('git', ['-c', 'user.name=Lane Test', '-c', 'user.email=lane@example.invalid', 'commit', '-qm', 'Scratch project']);
    assert.ok(!native(['workspace', 'list']).workspaces.some(w => w.worktree?.checkout_path === repo));
    fs.writeFileSync(path.join(root, 'ownership.json'), JSON.stringify({ binary: herdr, socketPath: process.env.HERDR_SOCKET_PATH,
      workspaces: [], tabs: [], panes: [] }));
    for (const file of ['herdr.mjs', 'environment.mjs', 'receipts.mjs', 'producers.mjs', 'worker.mjs']) {
      fs.copyFileSync(new URL(`../../acceptance/${file}`, import.meta.url), path.join(root, file));
    }
    const quote = value => `'${value.replaceAll("'", "'\\''")}'`;
    fs.writeFileSync(path.join(bin, 'herdr'), `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(path.join(root, 'herdr.mjs'))} "$@"\n`, { mode: 0o755 });
    env.PATH = `${bin}:${env.PATH}`;
    const cli = process.env.LANE_HERDR_TEST_CLI ?? new URL('../lane.mjs', import.meta.url).pathname;
    monitor = await startFocusMonitor({ socketPath: process.env.HERDR_SOCKET_PATH, evidence });
    run(process.execPath, [cli, 'open', 'scratch', '--git-only']);
    assert.ok(!native(['workspace', 'list']).workspaces.some(w => w.worktree?.repo_root === repo));
    const result = JSON.parse(run(process.execPath, [cli, 'dispatch', 'scratch', '--kind', 'codex', '--json']));
    const tabs = native(['tab', 'list', '--workspace', result.workspaceId]).tabs;
    assert.equal(tabs.length, 1);
    assert.equal(tabs[0].tab_id, result.tabId);
    assert.equal(tabs[0].label, 'agent:scratch');
    const calls = fs.readFileSync(path.join(root, 'herdr.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
    const opened = calls.find(row => row.args[0] === 'worktree' && row.args[1] === 'open');
    assert.ok(opened.args.includes('--no-focus'));
    assert.equal(opened.args[opened.args.indexOf('--cwd') + 1], repo);
    assert.ok(!calls.some(row => row.args[0] === 'tab' && row.args[1] === 'create'));
    assert.equal(calls.filter(row => row.args[0] === 'agent' && row.args[1] === 'rename').length, 1);
    console.log(`scratch=${repo} workspace=${result.workspaceId} pane=${result.pane} tabs=${tabs.length}`);
  } finally {
    try {
      stopProducers(root);
      await awaitProducers(root);
      const cleanup = await cleanupWorkspaces({ root, evidence, native });
      assert.deepEqual(cleanup.errors, []);
      assert.deepEqual(cleanup.remaining, []);
      if (monitor) console.log(assertFocus(await monitor.stop(), { evidence }));
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  }
});
