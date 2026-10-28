import test from '../../test/helpers/bounded-test.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { harnessEnvironment } from '../run.mjs';
import { scratchReleaseCase } from '../release.mjs';
import { createProductCheckout } from '../../lib/product-files.mjs';
import { makeSnapshotWritable } from '../snapshot.mjs';

const source = path.resolve(import.meta.dirname, '../..');
function scratch(t) {
  // Match live acceptance: canonical /private/tmp on macOS, scratch HOME and
  // XDG directories, TMPDIR enclosing the checkout, and no account Git config.
  const root = fs.realpathSync(fs.mkdtempSync('/tmp/herdr-acceptance-release-'));
  const env = harnessEnvironment(process.env, root), cwd = path.join(root, 'checkout');
  fs.mkdirSync(env.HOME, { recursive: true });
  fs.mkdirSync(cwd, { mode: 0o700 });
  t.after(() => {
    const releases = path.join(root, 'monitor-home/releases');
    if (fs.existsSync(releases)) makeSnapshotWritable(releases, root);
    fs.rmSync(root, { recursive: true, force: true });
  });
  const commands = [];
  const run = (command, args, { extra = {}, cwd: directory = cwd } = {}) => {
    const result = spawnSync(command, args, { cwd: directory, env: { ...env, ...extra }, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
    commands.push({ command, args, cwd: directory, status: result.status });
    assert.equal(result.status, 0, result.error?.message ?? result.stderr + result.stdout);
    return result;
  };
  const git = (directory, args) => run('git', ['--no-pager', '-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false',
    '-c', 'commit.gpgsign=false', '-C', directory, ...args]).stdout.trim();
  const node = (file, args, options) => run(process.execPath, [file, ...args], options);
  return { root, env, cwd, commands, run, git, node };
}

test('scratch slot fixtures preserve out-of-scratch refusal and clean repeated fast checks', t => {
  const f = scratch(t);
  const result = f.node(path.join(source, 'test/helpers/run.mjs'), [
    '--test-name-pattern=^(compat permits|fast records)',
    path.join(source, 'test-slot/test/host-paths.test.mjs'),
    path.join(source, 'test-slot/test/watchdog.test.mjs'),
  ]);
  assert.equal([...result.stdout.matchAll(/^# pass 1$/gm)].length, 2, result.stdout);
  t.diagnostic('Both selected original checks passed with checkout under TMPDIR and isolated HOME/XDG Git ignores. Other cases were skipped.');
});

test('scratch release build/activate/rollback uses the live step with its bounded tagged gate', t => {
  const f = scratch(t), candidate = path.join(f.root, 'candidate');
  const candidateCommit = f.git(source, ['rev-parse', 'HEAD']);
  createProductCheckout({ source, commit: candidateCommit, destination: candidate, ownedRoot: f.root, git: f.git });
  const detail = scratchReleaseCase({ ...f, candidate, source: candidate, candidateCommit });
  for (const tag of ['candidate', 'second']) {
    const frozen = JSON.parse(fs.readFileSync(path.join(f.root, 'monitor-home/builds', tag, 'validation.json')));
    assert.equal(frozen.declaration.release, 'node bin/org.mjs --help');
    assert.equal(frozen.source, `tag:${tag}:.lane.validation.json`);
    const bundle = path.join(f.root, 'monitor-home/releases', tag);
    assert.equal(fs.statSync(bundle).mode & 0o222, 0, 'published scratch bundle is immutable');
  }
  assert.deepEqual(f.commands.filter(row => row.command === 'bash').map(row => row.args.slice(1)), [
    ['build', 'candidate'], ['build', 'second'], ['activate', 'candidate'],
    ['activate', 'second'], ['activate', 'second'], ['rollback'],
  ]);
  t.diagnostic(detail);
  t.diagnostic(JSON.stringify(f.commands.filter(row => row.command === 'bash')));
});
