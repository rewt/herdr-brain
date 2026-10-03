import test from './helpers/bounded-test.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { repositorySeed } from './helpers/git-seed.mjs';

test('shared Git setup gives each fixture independent common directories, refs, indexes and objects', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'git-seed-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 'Seed test', GIT_AUTHOR_EMAIL: 'seed@example.invalid', GIT_COMMITTER_NAME: 'Seed test', GIT_COMMITTER_EMAIL: 'seed@example.invalid' };
  const git = (repo, args) => {
    const r = spawnSync('git', ['-C', repo, ...args], { env, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr); return r.stdout.trim();
  };
  let initializations = 0;
  const copy = repositorySeed(root, repo => {
    initializations++; git(repo, ['init', '-qb', 'main']);
    fs.writeFileSync(path.join(repo, 'work'), 'base\n');
    git(repo, ['add', '.']); git(repo, ['commit', '-qm', 'Seed']);
  });
  const a = path.join(root, 'a'), b = path.join(root, 'b'), c = path.join(root, 'c');
  copy(a); copy(b);
  assert.notEqual(git(a, ['rev-parse', '--path-format=absolute', '--git-common-dir']), git(b, ['rev-parse', '--path-format=absolute', '--git-common-dir']));
  const original = git(b, ['rev-parse', 'HEAD']);
  fs.writeFileSync(path.join(a, 'work'), 'changed\n'); git(a, ['add', '.']);
  assert.equal(git(b, ['status', '--porcelain']), '');
  git(a, ['commit', '-qm', 'Independent change']);
  assert.notEqual(git(a, ['rev-parse', 'HEAD']), original);
  assert.equal(git(b, ['rev-parse', 'HEAD']), original);
  assert.equal(fs.readFileSync(path.join(b, 'work'), 'utf8'), 'base\n');
  const object = git(a, ['rev-parse', 'HEAD']);
  assert.equal(fs.existsSync(path.join(b, '.git/objects', object.slice(0, 2), object.slice(2))), false);
  copy(c); assert.equal(git(c, ['rev-parse', 'HEAD']), original);
  assert.equal(git(c, ['remote']), ''); assert.equal(initializations, 1);
});
