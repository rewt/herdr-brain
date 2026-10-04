import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

// Real lane CLI and Git topology, isolated from the operator's repository. The pnpm
// double records invocation and simulates build success/failure; package build/guard
// behavior is exercised separately by the wallet tests and stale-signer witnesses.
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'lane-prepare-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const repo = join(root, 'main');
  const lane = join(root, 'worktree');
  const bin = join(root, 'bin');
  mkdirSync(join(repo, 'scripts/lane'), { recursive: true });
  mkdirSync(bin);
  for (const file of ['lane.mjs', 'routing.mjs']) {
    copyFileSync(join(dirname(fileURLToPath(import.meta.url)), file), join(repo, 'scripts/lane', file));
  }
  writeFileSync(join(repo, '.gitignore'), 'node_modules/\ndist/\nbuild-calls.json\n');
  const git = (args, cwd = repo) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git(['init', '-b', 'main']);
  git(['config', 'user.email', 'lane-test@invalid']);
  git(['config', 'user.name', 'Lane Test']);
  git(['add', '.']);
  git(['commit', '-m', 'fixture']);
  git(['worktree', 'add', '-b', 'lane/test-prepare', lane]);
  writeFileSync(join(lane, 'change.txt'), 'promotion fixture\n');
  git(['add', 'change.txt'], lane);
  git(['commit', '-m', 'lane change'], lane);
  mkdirSync(join(lane, 'node_modules'));
  mkdirSync(join(lane, 'packages/protocol-runtime/dist'), { recursive: true });
  mkdirSync(join(lane, 'packages/reference-wallet/dist'), { recursive: true });
  const stale = join(lane, 'packages/reference-wallet/dist/apnt_pool_wallet_signer_v1.js');
  writeFileSync(stale, '// stale output\n');
  writeFileSync(join(bin, 'pnpm'), `#!${process.execPath}\n` + `
    const fs = require('node:fs');
    fs.writeFileSync('build-calls.json', JSON.stringify(process.argv.slice(2)));
    if (process.env.TEST_BUILD_FAIL === '1') process.exit(23);
    fs.rmSync('packages/reference-wallet/dist/apnt_pool_wallet_signer_v1.js', { force: true });
  `, { mode: 0o755 });
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, LANE_VALIDATE: `${process.execPath} -e "process.exit(0)"` };
  const run = (command, extra = {}) => spawnSync(process.execPath, [join(repo, 'scripts/lane/lane.mjs'), command, 'test-prepare'], {
    cwd: repo, env: { ...env, ...extra }, encoding: 'utf8',
  });
  const assertBuild = () => assert.deepEqual(JSON.parse(readFileSync(join(lane, 'build-calls.json'), 'utf8')),
    ['--filter', '@bch-cloak/reference-wallet', '--filter', '@bch-cloak/wizardconnect-client', 'build']);
  return { run, git, stale, assertBuild };
}

test('prepare rebuilds even with protocol-runtime dist present', (t) => {
  const f = fixture(t);
  const run = f.run('prepare');
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /lane ready:/);
  f.assertBuild();
  assert.equal(existsSync(f.stale), false);
});

test('failed preparation reports neither ready nor promoted and leaves main unchanged', (t) => {
  const f = fixture(t);
  const before = f.git(['rev-parse', 'main']);
  for (const command of ['prepare', 'promote']) {
    const run = f.run(command, { TEST_BUILD_FAIL: '1' });
    assert.equal(run.status, 1);
    assert.match(run.stderr, /dist build failed/);
    assert.doesNotMatch(run.stdout, /lane ready:|promoted lane/);
    f.assertBuild();
    assert.equal(f.git(['rev-parse', 'main']), before);
  }
});

test('promotion prepares and fast-forwards an isolated lane after its check succeeds', (t) => {
  const f = fixture(t);
  const run = f.run('promote');
  assert.equal(run.status, 0, run.stderr);
  f.assertBuild();
  assert.equal(existsSync(f.stale), false);
  assert.equal(f.git(['rev-parse', 'main']), f.git(['rev-parse', 'lane/test-prepare']));
  assert.match(run.stdout, /promoted lane\/test-prepare:/);
});
