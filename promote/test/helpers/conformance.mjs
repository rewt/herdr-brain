import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { collectMetrics } from '../../metrics.mjs';

export const cli = fileURLToPath(new URL('../../../lanes/lane.mjs', import.meta.url));
export function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'rev465-'))), repo = path.join(root, 'repo');
  fs.mkdirSync(repo); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const config = path.join(root, 'config.json'); fs.writeFileSync(config, '{}');
  const env = { ...process.env, LANE_CONFIG: config, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
  for (const key of Object.keys(env)) if (/^(ORG_|HERDR_(?!TEST_|MONITOR_FLEET)|GIT_(DIR|WORK_TREE|INDEX_FILE|COMMON_DIR|CONFIG_COUNT))/.test(key)) delete env[key];
  delete env.LANE_VALIDATE;
  env.MONITOR_TEST_SLOT_PATH = path.join(root, 'slot');
  env.MONITOR_TEST_SLOT_COMPAT_PATH = env.MONITOR_TEST_SLOT_PATH;
  env.NODE_OPTIONS = `${env.NODE_OPTIONS ?? ''} --import=${JSON.stringify(new URL('../../../test/helpers/memory-fixture.mjs', import.meta.url).href)}`;
  const exec = (args, cwd = repo) => spawnSync(process.execPath, [cli, ...args], { cwd, env, encoding: 'utf8' });
  const git = (args, cwd = repo) => { const r = spawnSync('git', ['-C', cwd, ...args], { env, encoding: 'utf8' }); assert.equal(r.status, 0, r.stderr); return r.stdout.trim(); };
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

