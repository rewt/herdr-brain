#!/usr/bin/env node
// This project's build/gate declaration. Machine paths stay in the environment.
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { parseArgs } from 'node:util';

// The product has no npm dependencies, so a candidate needs no package cache.
export function releaseInputs(env = process.env) {
  if (env.RELEASE_BCH_CLOAK && !fs.statSync(path.resolve(env.RELEASE_BCH_CLOAK), { throwIfNoEntry: false })?.isDirectory()) {
    throw new Error('set RELEASE_BCH_CLOAK to the existing project checkout; it is read only to acceptance');
  }
  return { bch: env.RELEASE_BCH_CLOAK ? path.resolve(env.RELEASE_BCH_CLOAK) : null };
}

export function candidateCommand(stage, candidate, { env = process.env, skipLive = false } = {}) {
  const inputs = releaseInputs(env);
  if (stage === 'prepare') {
    return { command: ['bash', path.join(candidate, 'herdr/install.sh')], env: { ...env, MONITOR_INSTALL_BUILD_ONLY: '1' } };
  }
  if (stage !== 'gate') throw new Error('expected prepare or gate');
  const build = JSON.parse(fs.readFileSync(path.join(candidate, '.release-build.json'), 'utf8'));
  if (build.commit !== fs.readFileSync(path.join(candidate, '.release-commit'), 'utf8').trim()) throw new Error('build evidence does not name this candidate');
  return { command: [process.execPath, path.join(candidate, 'acceptance/run.mjs'), '--candidate', candidate,
    ...(inputs.bch ? ['--bch-cloak', inputs.bch] : []), ...(skipLive ? ['--skip-live'] : [])], env };
}

export function main(argv = process.argv.slice(2)) {
  // Keep the candidate driver's stage-specific help local.
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
    const inputs = releaseInputs();
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
      completed_at: new Date().toISOString(), command: invocation.command };
    fs.writeFileSync(path.join(candidate, '.release-build.json'), JSON.stringify(build, null, 2) + '\n');
    console.log(`release build evidence: ${JSON.stringify(build)}`);
  }
  process.exitCode = result.status ?? 1;
}

// Build-only partial candidates carry this driver without lib/ (ARCH-19).
function isMain() {
  try { return fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url)); }
  catch { return false; }
}

if (isMain()) {
  try { main(); } catch (error) { console.error(`release candidate: ${error.message}`); process.exitCode = 1; }
}
