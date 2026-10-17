// Exact recipe declarations select shared work or exclusive proving (ARCH-34).
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { loadFactor } from '../lib/deadline.mjs';

const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));
export const FILE_WORKERS = { maximum: 4, scope: 'test files only; transitive CPU/thread demand unknown',
  formula: 'max(1, floor(4/loadFactor))', source: 'test/helpers/run.mjs' };
export function resourceStanza(id, command, admissionClass = 'SHARED') {
  return { id, revision: 1, command, admission_class: admissionClass, M_bytes: null, C: null,
    worker_caps: FILE_WORKERS, named_claims: [], evidence: ['test/helpers/run.mjs', 'lib/deadline.mjs', 'ARCH-34: ordinary work starts immediately; only declared proving is exclusive'] };
}
export function workerSettings(env = process.env) {
  const factor = loadFactor();
  return { load_factor: factor, test_file_cap: Math.max(1, Math.floor(4 / factor)), maximum_test_file_cap: 4,
    transitive_cpu_bound: null, environment: Object.fromEntries(['UV_THREADPOOL_SIZE', 'OMP_NUM_THREADS', 'GOMAXPROCS', 'CARGO_BUILD_JOBS', 'RAYON_NUM_THREADS']
      .filter(key => env[key] !== undefined).map(key => [key, env[key]])) };
}

// Recipes carry their own stanza; a label alone can never select a profile.
export function resolveResource(argv, { cwd = process.cwd(), env = process.env, resource } = {}) {
  try {
    if (!resource) {
      if (argv[0] === '/bin/sh' && argv[1] === '-c' && argv.length === 3) {
        const profiles = read(path.join(cwd, 'test-slot/validation-resources.json'));
        resource = Object.values(profiles).find(row => row.command === argv[2]);
        if (resource) resource = { ...resource, command: argv };
      } else if (argv[0] === 'npm' && argv[1] === 'run' && argv.length === 3) {
        const pkg = read(path.join(cwd, 'package.json'));
        resource = pkg.resources?.[argv[2]];
        if (resource?.command_sha256 === hash(pkg.scripts?.[argv[2]])) resource = { ...resource, command: argv, recipe: pkg.scripts[argv[2]] };
        else resource = null;
      } else if (argv[0] === 'node' || argv[0] === process.execPath) {
        const pkg = read(path.join(cwd, 'package.json'));
        const command = ['node', ...argv.slice(1)];
        const entry = Object.entries(pkg.resources ?? {}).find(([name, row]) => {
          const recipe = pkg.scripts?.[name];
          return row.command_sha256 === hash(recipe) && JSON.stringify(recipe?.split(' -- ').at(-1).split(' ')) === JSON.stringify(command);
        });
        if (entry) resource = { ...entry[1], command: argv, recipe: pkg.scripts[entry[0]] };
      }
    }
    if (!resource || !/^[\w:./-]+$/.test(resource.id ?? '') || !Number.isSafeInteger(resource.revision) || resource.revision < 1 ||
        JSON.stringify(resource.command) !== JSON.stringify(argv) || !['SHARED', 'EXCLUSIVE'].includes(resource.admission_class) || !(resource.M_bytes === null || (Number.isSafeInteger(resource.M_bytes) && resource.M_bytes >= 0)) ||
        !(resource.C === null || (Number.isSafeInteger(resource.C) && resource.C > 0)) || !resource.worker_caps ||
        !Array.isArray(resource.named_claims) || resource.named_claims.length || !Array.isArray(resource.evidence)) return { admission_class: 'SHARED', reason: 'unprofiled' };
    let target = null;
    try { target = execFileSync('git', ['-C', cwd, 'rev-parse', 'HEAD^{tree}'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { try { target = { release_commit: fs.readFileSync(path.join(cwd, '.release-commit'), 'utf8').trim() }; } catch { /* No invented input identity. */ } }
    // Environment values may be credentials. Bind all execution inputs by hash.
    const environment = Object.entries(env).filter(([key]) => !/^(?:MONITOR_TEST_SLOT_|BCH_CLOAK_TEST_SLOT_|PWD$|OLDPWD$|SHLVL$|_$)/.test(key)).sort(([a], [b]) => a.localeCompare(b));
    const binding = { argv, cwd: fs.realpathSync(cwd), recipe: resource.recipe ?? resource.command, target_identity: target,
      node: { executable: process.execPath, version: process.version }, platform: process.platform, arch: process.arch,
      environment_sha256: hash(environment), worker_caps: resource.worker_caps };
    return { reason: 'profiled', admission_class: resource.admission_class, profile: { ...resource, binding, binding_sha256: hash(binding) } };
  } catch { return { admission_class: 'SHARED', reason: 'unprofiled' }; }
}
