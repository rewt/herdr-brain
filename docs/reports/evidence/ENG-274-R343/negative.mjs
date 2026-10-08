// Prove the guard fails when a product child drops the scratch history env.
// All writes, including the deliberately leaked history, stay in a disposable
// independent Git repository; the operator's common directory is never used.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
const repo = fileURLToPath(new URL('../../../../', import.meta.url));
const root = fs.mkdtempSync(path.join(fs.realpathSync('/tmp'), 'eng274-negative-'));
const run = (command, args, options = {}) => {
  const r = spawnSync(command, args, { cwd: repo, encoding: 'utf8', timeout: 15000, maxBuffer: 32 * 1024 * 1024, ...options });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout;
};
try {
  const archive = run('git', ['archive', 'HEAD'], { encoding: 'buffer' });
  run('/usr/bin/tar', ['-x', '-C', root], { input: archive });
  const changed = run('git', ['diff', '--name-only', 'HEAD']).trim().split('\n').filter(Boolean);
  for (const file of new Set([...changed, 'test/helpers/gate-history.mjs'])) {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.copyFileSync(path.join(repo, file), path.join(root, file));
  }
  run('git', ['init', '-q'], { cwd: root });
  const preload = path.join(root, 'ignore-history.mjs');
  fs.writeFileSync(preload, "if(process.argv[1]?.endsWith('/test-slot.mjs'))delete process.env.MONITOR_GATE_HISTORY_ROOT;\n");
  const result = spawnSync(process.execPath, ['--test', '--test-name-pattern=fixture gates cannot', 'test-slot/test/watchdog.test.mjs'],
    { cwd: root, encoding: 'utf8', timeout: 15000, env: { ...process.env, NODE_OPTIONS: `--import=${preload}` } });
  process.stdout.write(result.stdout); process.stderr.write(result.stderr);
  assert.equal(result.status, 1);
  assert.match(result.stdout + result.stderr, /TEST_GATE_HISTORY_LEAK/);
  assert.match(result.stdout, /not ok .*fixture gates cannot/);
  assert.ok(fs.existsSync(path.join(root, '.git/gate-watchdog')));
  console.log('Negative control detected the deliberately leaked scratch-repository history');
} finally { fs.rmSync(root, { recursive: true, force: true }); }
