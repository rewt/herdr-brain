#!/usr/bin/env node
// Trusted parent adapter: command authority is reloaded from canonical Git.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync, execFileSync } from 'node:child_process';
import { hostSuitePlan, assertHostSuiteSupport } from '../lanes/host-suites.mjs';
import { gitProject } from '../lib/project.mjs';
import { findOrgDir } from '../lib/store.mjs';
import { runTemporary, temporaryEnvironment } from './temporary.mjs';
import { removePlainDirectory } from '../lib/files.mjs';
import { sandboxCommand } from './confinement.mjs';
import { lifetimeScope, closeScope, boundedArgs } from './lifetime.mjs';
import { HOST_OPERATION_TIMEOUT, VALIDATION_WRAPPER_GRACE } from './deadlines.mjs';
import { isMain } from '../lib/cli-help.mjs';
import { checkedDirectory } from './paths.mjs';

export function runHostSuite([cwd, name, hash, tree, sharedJSON = '[]', tempRoot = '']) {
  const project = gitProject(cwd), [suite] = hostSuitePlan(cwd, [name]);
  assertHostSuiteSupport([suite]);
  const git = args => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const head = git(['rev-parse', 'HEAD']);
  if (suite.declaration_hash !== hash || git(['rev-parse', 'HEAD^{tree}']) !== tree ||
      (process.env.MONITOR_HOST_VALIDATED_HEAD && head !== process.env.MONITOR_HOST_VALIDATED_HEAD) || git(['status', '--porcelain', '--untracked-files=all']))
    throw Error('host suite requires the exact clean committed tree and unchanged declaration');
  // Never trust an environment variable to remove these mandatory exclusions.
  const record = findOrgDir({ cwd: project.canonical, env: {} });
  const sharedPaths = [...JSON.parse(sharedJSON), project.identity, path.join(project.canonical, '.lane'), path.join(project.canonical, '.org'),
    ...(record ? [record, ...['events.jsonl', 'runs', 'supervisor'].map(name => path.join(record, name))] : [])];
  if (process.platform !== 'darwin' || !fs.existsSync('/usr/bin/sandbox-exec')) throw Error('HOST_PROFILE_UNAVAILABLE: macOS sandbox-exec required');
  // Reject unenforceable policy before making temporary state or launching tests.
  if (suite.external_network.length) throw Error('HOST_PROFILE_UNAVAILABLE: Seatbelt cannot enforce external host:port addresses; refusing the declared allowlist');
  const suppliedTemp = JSON.parse(process.env.MONITOR_HOST_RUN_TEMPS || '{}')[name];
  const temporary = suppliedTemp ? checkedDirectory(suppliedTemp) : runTemporary(tempRoot || '/private/tmp/herdr-host');
  let scope;
  try {
    scope = lifetimeScope(cwd, { temporary });
    const sandbox = sandboxCommand('/usr/bin/sandbox-exec', cwd, { sharedPaths, temporaryPaths: [temporary], lifetime: scope, hostSuite: suite });
    console.log(`host suite ${name}: declaration=${hash} head=${head} temp=${temporary}`);
    console.log(suite.tcp_listener_limit);
    const result = spawnSync(process.execPath, [new URL('./bounded.mjs', import.meta.url).pathname, '--timeout-ms', String(HOST_OPERATION_TIMEOUT), '--host-validation',
      ...boundedArgs(scope, sandbox.binary, sandbox.args, ['/bin/sh', '-c', suite.command])], {
      cwd, stdio: 'inherit', timeout: HOST_OPERATION_TIMEOUT + VALIDATION_WRAPPER_GRACE, killSignal: 'SIGKILL',
      env: { ...process.env, ...temporaryEnvironment(temporary), MONITOR_REQUEST_DIR: '', LANE_CONFIG: '', LANE_VALIDATE: '', ORG_DIR: '',
        MONITOR_HOST_SHARED_PATHS: '', MONITOR_HOST_TEMP: '', MONITOR_PROJECT_CONFIG: '', MONITOR_PROJECT_TEMP: '',
        MONITOR_HOST_RUN_TEMPS: '', MONITOR_HOST_VALIDATED_HEAD: '' },
    });
    if (result.error) throw result.error;
    return result.status ?? 1;
  } finally { closeScope(scope); removePlainDirectory(temporary); }
}
if (isMain(import.meta.url)) {
  try { process.exitCode = runHostSuite(process.argv.slice(2)); }
  catch (error) { console.error(`host validation: ${error.message}`); process.exitCode = 1; }
}
