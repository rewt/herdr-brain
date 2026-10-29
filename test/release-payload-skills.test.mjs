import test from './helpers/bounded-test.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { copyProduct, createProductCheckout, verifyProductPayload } from '../lib/product-files.mjs';

test('release checkout retains shared skill discovery while its archive excludes harness trees', t => {
  const source = path.resolve(import.meta.dirname, '..');
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'release-skills-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const repo = path.join(root, 'repo'), checkout = path.join(root, 'checkout'), archive = path.join(root, 'archive');
  copyProduct(source, repo);
  fs.cpSync(path.join(source, 'skills'), path.join(repo, 'skills'), { recursive: true });
  fs.copyFileSync(path.join(source, '.gitattributes'), path.join(repo, '.gitattributes'));
  const names = ['project-deliver', 'project-preflight', 'project-release', 'project-review', 'project-troubleshoot'];
  for (const harness of ['.agents', '.claude']) {
    fs.mkdirSync(path.join(repo, harness, 'skills'), { recursive: true });
    for (const name of names) {
      const link = path.join(harness, 'skills', name);
      assert.equal(fs.realpathSync(path.join(source, link)), path.join(source, 'skills', name));
      fs.symlinkSync(fs.readlinkSync(path.join(source, link)), path.join(repo, link));
    }
  }
  fs.writeFileSync(path.join(repo, '.claude/settings.json'), '{"sourceOnly":true}\n');
  const git = (...args) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim();
  git('init', '-qb', 'main'); git('config', 'user.name', 'Fixture'); git('config', 'user.email', 'fixture@example.invalid');
  git('add', '.');
  // A machine's global ignore file may hide harness configuration in a new repo.
  git('add', '--force', '.agents', '.claude', 'skills', '.gitattributes');
  git('commit', '-qm', 'Shared harness skills');
  const commit = git('rev-parse', 'HEAD');
  assert.equal(git('ls-tree', '-r', commit, '.agents', '.claude').split('\n').filter(row => row.startsWith('120000 ')).length, 10);
  const identity = createProductCheckout({ source: repo, commit, destination: checkout, ownedRoot: root });
  assert.ok(!Object.keys(identity.files).some(file => /^(?:\.agents|\.claude)\//.test(file)));
  fs.mkdirSync(archive);
  const bytes = execFileSync('git', ['-C', repo, 'archive', commit], { maxBuffer: 64 * 1024 * 1024 });
  execFileSync('tar', ['-x', '-C', archive], { input: bytes });
  verifyProductPayload(archive, identity);
  for (const harness of ['.agents', '.claude']) {
    assert.equal(fs.existsSync(path.join(archive, harness)), false);
    for (const name of names) {
      const canonical = path.join(checkout, 'skills', name, 'SKILL.md');
      assert.equal(fs.realpathSync(path.join(checkout, harness, 'skills', name, 'SKILL.md')), canonical);
      assert.equal(fs.readFileSync(path.join(archive, 'skills', name, 'SKILL.md'), 'utf8'), fs.readFileSync(canonical, 'utf8'));
    }
  }
});
