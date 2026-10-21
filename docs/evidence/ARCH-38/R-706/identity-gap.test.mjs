// Archived diagnostic of the pre-implementation interfaces, not gate acceptance.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { enqueue, queueFor } from '../../../../promote/promote.mjs';
import { validateValidation } from '../../../../lanes/validation.mjs';

test('gap witness: legacy enqueue persists a job with no native execution provenance', t => {
  const scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'declared-gates-gap-')));
  const originalCwd = process.cwd();
  const originals = Object.fromEntries(['HERDR_MONITOR_FLEET', 'BRAIN_SHADOW_ROOT'].map(key => [key, process.env[key]]));
  t.after(() => {
    process.chdir(originalCwd);
    for (const [key, value] of Object.entries(originals)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    fs.rmSync(scratch, { recursive: true, force: true });
  });
  // Isolate in-process product calls as well as Git subprocesses (L-3).
  process.env.HERDR_MONITOR_FLEET = path.join(scratch, 'fleet');
  process.env.BRAIN_SHADOW_ROOT = path.join(scratch, 'shadow');
  const owner = path.join(scratch, 'owner'), caller = path.join(scratch, 'caller');
  for (const root of [owner, caller]) {
    fs.mkdirSync(root);
    fs.writeFileSync(path.join(root, '.identity-root'), '');
  }
  const repo = path.join(owner, 'project');
  fs.mkdirSync(repo);
  const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
  for (const key of Object.keys(env)) if (/^GIT_(?:DIR|WORK_TREE|INDEX_FILE|COMMON_DIR|CONFIG_COUNT|CONFIG_KEY_|CONFIG_VALUE_)/.test(key)) delete env[key];
  execFileSync('git', ['init', '-qb', 'main', repo], { env, stdio: 'pipe' });
  execFileSync('git', ['-C', repo, '-c', 'user.name=Gap fixture', '-c', 'user.email=gap@example.invalid',
    'commit', '--allow-empty', '-qm', 'Fixture base'], { env, stdio: 'pipe' });
  process.chdir(caller);
  const queue = queueFor(repo);
  assert.equal(fs.existsSync(queue.directory), true);
  const admitted = enqueue(queue, ['example'], { org: null });
  const saved = JSON.parse(fs.readFileSync(queue.file, 'utf8'));
  assert.equal(admitted.length, 1);
  assert.equal(saved.pending.length, 1);
  assert.equal(saved.pending[0].topic, 'example');
  // No authorization was passed; no worker or project command was invoked.
  assert.deepEqual(Object.keys(saved.pending[0]).sort(), ['id', 'org', 'queued', 'release', 'topic']);
  assert.equal(fs.existsSync(path.join(queue.directory, 'worker.lock')), false);
  assert.equal(fs.existsSync(path.join(queue.directory, 'worker.log')), false);
});

test('gap witness: the existing validation reader refuses the opt-in schema', () => {
  assert.throws(() => validateValidation({ schema: 'declared-gates/v1', promotion: 'fixture-promotion',
    release: 'fixture-release', promotion_tests: { command: ['fixture-planner'] } }), /unknown validation field: schema/);
});
