#!/usr/bin/env node
// This project's build/gate declaration. Machine paths stay in the environment.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';

const MODULES = ['console', 'mcp'];
const sha256 = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const readJSON = file => JSON.parse(fs.readFileSync(file, 'utf8'));

export function releaseInputs(env = process.env) {
  const cache = path.resolve(env.RELEASE_NPM_CACHE || env.npm_config_cache || path.join(os.homedir(), '.npm'));
  const index = path.join(cache, '_cacache/index-v5');
  if (!fs.statSync(index, { throwIfNoEntry: false })?.isDirectory()) throw new Error('populate RELEASE_NPM_CACHE with the pinned console/MCP dependencies; see release/README.md');
  fs.accessSync(index, fs.constants.R_OK);
  if (env.RELEASE_BCH_CLOAK && !fs.statSync(path.resolve(env.RELEASE_BCH_CLOAK), { throwIfNoEntry: false })?.isDirectory()) {
    throw new Error('set RELEASE_BCH_CLOAK to the existing project checkout; it is read only to acceptance');
  }
  return { cache, bch: env.RELEASE_BCH_CLOAK ? path.resolve(env.RELEASE_BCH_CLOAK) : null };
}

function* dependencyTarballs(candidate, source) {
  for (const module of MODULES) {
    const lock = readJSON(path.join(candidate, module, 'package-lock.json'));
    for (const pkg of Object.values(lock.packages ?? {})) {
      if (!pkg.integrity) continue;
      const match = pkg.integrity.match(/^(sha512|sha1)-([A-Za-z0-9+/=]+)$/);
      if (!match) throw new Error(`unsupported cache integrity in ${module}`);
      const digest = Buffer.from(match[2], 'base64').toString('hex');
      const relative = path.join('content-v2', match[1], digest.slice(0, 2), digest.slice(2, 4), digest.slice(4));
      const file = path.join(source, '_cacache', relative);
      if (!fs.existsSync(file)) {
        if (pkg.optional) continue;
        throw new Error(`offline cache lacks ${module} dependency ${pkg.resolved}; populate RELEASE_NPM_CACHE first`);
      }
      fs.accessSync(file, fs.constants.R_OK);
      yield { file, relative };
    }
  }
}

export function preflightInputs(candidate, env = process.env) {
  const inputs = releaseInputs(env);
  const dependencies = [...dependencyTarballs(candidate, inputs.cache)].length;
  return { ...inputs, dependencies };
}

export function copyDependencyCache(candidate, source) {
  const files = [...dependencyTarballs(candidate, source)];
  const cache = path.join(candidate, '.release-npm-cache');
  fs.mkdirSync(cache);
  const store = path.join(cache, '_cacache');
  fs.cpSync(path.join(source, '_cacache/index-v5'), path.join(store, 'index-v5'), { recursive: true });
  // Copy only pinned tarballs, never the shared cache's unrelated content.
  for (const { file, relative } of files) {
    fs.mkdirSync(path.dirname(path.join(store, relative)), { recursive: true });
    fs.copyFileSync(file, path.join(store, relative));
  }
  return cache;
}

function buildEvidence(candidate, module) {
  const lockBytes = fs.readFileSync(path.join(candidate, module, 'package-lock.json'));
  let installed = 0;
  for (const [relative, pkg] of Object.entries(JSON.parse(lockBytes).packages ?? {})) {
    if (!relative) continue;
    const file = path.join(candidate, module, relative, 'package.json');
    if (pkg.optional && !fs.existsSync(file)) continue;
    if (readJSON(file).version !== pkg.version) throw new Error(`${module}/${relative} does not match its pinned version`);
    installed++;
  }
  return { module, package_lock_sha256: sha256(lockBytes), installed_packages: installed };
}

export function candidateCommand(stage, candidate, { env = process.env, skipLive = false } = {}) {
  const inputs = releaseInputs(env);
  if (stage === 'prepare') {
    const cache = copyDependencyCache(candidate, inputs.cache);
    return { command: ['bash', path.join(candidate, 'herdr/install.sh')], env: { ...env,
      RELEASE_NO_NPM: '', MONITOR_INSTALL_BUILD_ONLY: '1', npm_config_cache: cache,
      npm_config_offline: 'true', npm_config_update_notifier: 'false' }, cache };
  }
  if (stage !== 'gate') throw new Error('expected prepare or gate');
  const build = readJSON(path.join(candidate, '.release-build.json'));
  if (build.commit !== fs.readFileSync(path.join(candidate, '.release-commit'), 'utf8').trim()) throw new Error('build evidence does not name this candidate');
  return { command: [process.execPath, path.join(candidate, 'acceptance/run.mjs'), '--candidate', candidate,
    '--npm-cache', path.join(candidate, '.release-npm-cache'), ...(inputs.bch ? ['--bch-cloak', inputs.bch] : []), ...(skipLive ? ['--skip-live'] : [])], env };
}

export function main(argv = process.argv.slice(2)) {
  // Build-only candidates copy this driver and install.sh without lib/.
  // Keep help local so those partial distributions remain self-contained.
  const { values, positionals } = parseArgs({ args: argv, allowPositionals: true, options: {
    candidate: { type: 'string' }, 'skip-live': { type: 'boolean' }, help: { type: 'boolean', short: 'h' },
  } });
  if (values.help) {
    console.log('Usage: node herdr/release-candidate.mjs preflight|prepare|gate --candidate DIR [--skip-live (gate only)]\n\nOptions:\n  --candidate DIR\n  --skip-live (gate only)\n  -h, --help');
    return;
  }
  const stage = positionals[0];
  if (positionals.length !== 1 || !values.candidate || !['preflight', 'prepare', 'gate'].includes(stage) || stage !== 'gate' && values['skip-live']) throw new Error('usage: release-candidate.mjs preflight|prepare|gate --candidate DIR [--skip-live (gate only)]');
  const candidate = path.resolve(values.candidate);
  if (stage === 'preflight') {
    const inputs = preflightInputs(candidate);
    console.log(`release preflight: ${JSON.stringify(inputs)}`);
    if (!inputs.bch) console.log('Existing-project compatibility will be skipped: RELEASE_BCH_CLOAK is not configured');
    return;
  }
  const invocation = candidateCommand(stage, candidate, { skipLive: values['skip-live'] });
  console.log(`release ${stage}: ${JSON.stringify(invocation.command)}`);
  let result = spawnSync(invocation.command[0], invocation.command.slice(1), { cwd: candidate, env: invocation.env, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (stage === 'prepare' && result.status === 0) {
    console.log('release prepare: npm run test:release');
    result = spawnSync('npm', ['run', 'test:release'], { cwd: candidate, env: invocation.env, stdio: 'inherit' });
    if (result.error) throw result.error;
  }
  if (stage === 'prepare' && result.status === 0) {
    const build = { commit: fs.readFileSync(path.join(candidate, '.release-commit'), 'utf8').trim(),
      completed_at: new Date().toISOString(), command: invocation.command, offline: true, cache: invocation.cache,
      modules: MODULES.map(module => buildEvidence(candidate, module)) };
    fs.writeFileSync(path.join(candidate, '.release-build.json'), JSON.stringify(build, null, 2) + '\n');
    console.log(`release build evidence: ${JSON.stringify(build)}`);
  }
  process.exitCode = result.status ?? 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(); } catch (error) { console.error(`release candidate: ${error.message}`); process.exitCode = 1; }
}
