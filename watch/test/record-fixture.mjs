import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const CLI = fileURLToPath(new URL('../../bin/org.mjs', import.meta.url));

export function seedSpawnRun(org, cwd, env = process.env) {
  const record = args => {
    const result = spawnSync(process.execPath, [CLI, ...args], {
      cwd, env: { ...env, ORG_DIR: org }, encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    return result.stdout.trim();
  };
  // Bundles carrying .release-commit read the run before the spawn dry-run.
  record(['init', org]);
  const item = record(['add', 'Watch spawn fixture', '--role', 'engineer']);
  for (let index = 1; index <= 6; index++) {
    assert.match(record(['start', item, '--workspace', cwd]), new RegExp(`^R-${index} started `));
  }
}
