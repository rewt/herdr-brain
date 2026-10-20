import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

export function scratchEnvironment(root) {
  const directory = path.join(root, 'sweep-scratch');
  fs.mkdirSync(directory);
  return { HERDR_TEST_SCRATCH_ROOTS: JSON.stringify([directory]) };
}

export function assertFixtureScratch(manifest, env, roots = JSON.parse(env.HERDR_TEST_SCRATCH_ROOTS)) {
  const data = JSON.parse(fs.readFileSync(manifest));
  for (const entry of data.entries) assert.ok(roots.some(root => path.dirname(entry.path) === fs.realpathSync(root)),
    `fixture sweep escaped its private scratch roots: ${entry.path}`);
  return data;
}

export function assertCloseScratch(result, env) {
  for (const line of result.stdout.split('\n').filter(line => line.startsWith('{'))) {
    const row = JSON.parse(line);
    if (row.action === 'scratch-manifest' && fs.existsSync(row.manifest)) assertFixtureScratch(row.manifest, env);
  }
}
