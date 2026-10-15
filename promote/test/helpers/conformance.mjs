import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { collectMetrics } from '../../metrics.mjs';
import { testSlotEnvironment } from '../../../test/helpers/test-slot-env.mjs';
import { stopFixtureInbox } from '../../../test/helpers/inbox.mjs';
import { loadTimeout } from '../../../lib/deadline.mjs';
import { ownFixtureLifetime } from '../../../test/helpers/fixture-lifetime.mjs';
import { lookupProcess } from '../../../lib/processes.mjs';

export const cli = fileURLToPath(new URL('../../../lanes/lane.mjs', import.meta.url));
export function fixture(t) {
  ownFixtureLifetime();
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'rev465-'))), repo = path.join(root, 'repo');
  fs.mkdirSync(repo);
  t.after(async () => {
    const workerLock = path.join(repo, '.git/promote/worker.lock');
    const deadline = Date.now() + loadTimeout(10000);
    while (fs.existsSync(workerLock)) {
      assert.ok(Date.now() < deadline, 'fixture queue sender did not stop before inbox cleanup');
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    await stopFixtureInbox(path.join(repo, '.git/supervisor/inbox.log'), {
      script: fileURLToPath(new URL('../../../supervisor/prompt-supervisor.mjs', import.meta.url)),
    });
    // A native lifetime guard can briefly outlive its finished gate while it
    // closes inherited descriptors. Confirm those orphaned guards have exited
    // before ending the fixture; the runner's strict group audit stays intact.
    const guard = process.env.HERDR_FIXTURE_LIFETIME_EXECUTABLE;
    const fifo = process.env.HERDR_FIXTURE_LIFETIME_FIFO;
    const prefixes = ['--exec', '--watch'].map(mode => `${guard} ${mode} ${fifo} `);
    const guardsBy = Date.now() + loadTimeout(5000);
    for (;;) {
      const snapshot = lookupProcess();
      assert.ok(snapshot.ok, snapshot.error);
      const orphans = [...snapshot.value.values()].filter(row => row.ppid === 1 && !/^Z/.test(row.state) &&
        prefixes.some(prefix => row.command.startsWith(prefix)));
      if (!orphans.length) break;
      assert.ok(Date.now() < guardsBy, `fixture lifetime guards did not exit: ${orphans.map(row => row.pid).join(', ')}`);
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    fs.rmSync(root, { recursive: true, force: true });
  });
  const config = path.join(root, 'config.json'); fs.writeFileSync(config, '{}');
  const env = { ...testSlotEnvironment(), LANE_CONFIG: config, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
  for (const key of Object.keys(env)) if (/^(ORG_|HERDR_(?!TEST_|MONITOR_FLEET)|GIT_(DIR|WORK_TREE|INDEX_FILE|COMMON_DIR|CONFIG_COUNT))/.test(key)) delete env[key];
  env.HERDR_FIXTURE_GATE_LIFETIME = '1';
  delete env.LANE_VALIDATE;
  env.MONITOR_TEST_SLOT_PATH = path.join(root, 'slot');
  env.MONITOR_TEST_SLOT_COMPAT_PATH = env.MONITOR_TEST_SLOT_PATH;
  env.NODE_OPTIONS = `${env.NODE_OPTIONS ?? ''} --import=${JSON.stringify(new URL('../../../test/helpers/memory-fixture.mjs', import.meta.url).href)}`;
  const exec = (args, cwd = repo) => spawnSync(process.execPath, [cli, ...args], { cwd, env, encoding: 'utf8', timeout: 30000 });
  const git = (args, cwd = repo) => { const r = spawnSync('git', ['-C', cwd, ...args], { env, encoding: 'utf8', timeout: 15000 }); assert.equal(r.status, 0, r.stderr); return r.stdout.trim(); };
  git(['init', '-qb', 'main']); git(['config', 'user.name', 'Conformance']); git(['config', 'user.email', 'test@example.invalid']);
  const checker = path.join(root, 'gate.cjs'), counts = path.join(root, 'calls');
  const body = source => fs.writeFileSync(checker, `const fs=require('fs');fs.appendFileSync(${JSON.stringify(counts)},'gate\\n');${source}`);
  body("console.log('green');");
  fs.writeFileSync(path.join(repo, '.lane.validation.json'), JSON.stringify({ promotion: `${process.execPath} ${checker}` }));
  fs.writeFileSync(path.join(repo, 'work'), 'base'); git(['add', '.']); git(['commit', '-qm', 'base']);
  const base = git(['rev-parse', 'HEAD']), identity = fs.realpathSync(path.join(repo, '.git'));
  let serial = 0;
  const lane = topic => { const wt = path.join(root, topic); git(['worktree', 'add', '-qb', `lane/${topic}`, wt]); fs.writeFileSync(path.join(wt, 'work'), topic); git(['add', '.'], wt); git(['commit', '-qm', topic], wt); return wt; };
  const batch = (topics, id = `batch-${++serial}`) => {
    const directory = path.join(identity, 'promote/batches', id); fs.mkdirSync(directory, { recursive: true });
    const file = path.join(directory, 'train.json');
    fs.writeFileSync(file, JSON.stringify({ schema: 'promotion-train/v1', id, identity,
      jobs: topics.map(topic => ({ id: topic, topic, org: null, expectedHead: git(['rev-parse', `lane/${topic}`]) })) }));
    return { file, run: () => exec(['promote-batch', file]), read: () => JSON.parse(fs.readFileSync(file)) };
  };
  return { root, repo, config, env, git, exec, body, base, identity, checker, counts, lane, batch,
    metrics: () => collectMetrics({ project: repo }) };
}
