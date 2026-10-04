#!/usr/bin/env node
// Only called by trusted entry code. Project validation and preparation retain
// the native workspace-write sandbox, including protected Git metadata.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { runTemporary, temporaryEnvironment } from './temporary.mjs';
import { nativeSessionContext } from './native-sandbox.mjs';
import { removePlainDirectory } from '../lib/files.mjs';
import { lifetimeScope, closeScope, boundedArgs } from './lifetime.mjs';
import { sandboxCommand } from './confinement.mjs';
import { validationTimeout, validationStepTimeout, VALIDATION_WRAPPER_GRACE } from './deadlines.mjs';
const [binary, cwd, sharedPathsJSON, declaredCommand] = process.argv.slice(2);
try {
  const sharedPaths = JSON.parse(sharedPathsJSON);
  const tier = process.env.MONITOR_VALIDATION_TIER ?? 'fast';
  validationTimeout(tier);
  const file = process.env.MONITOR_PROJECT_CONFIG;
  const config = file && fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
  const localFile = path.join(cwd, '.lane.json');
  const localConfig = fs.existsSync(localFile) ? JSON.parse(fs.readFileSync(localFile, 'utf8')) : {};
  const has = (key) => Object.hasOwn(config, key);
  const source = (key) => has(key) ? `canonical ${file}` : `lane ${localFile}`;
  const prepare = has('prepare') ? config.prepare : localConfig.prepare;
  let validate = declaredCommand ?? (has('validate') ? config.validate : localConfig.validate);
  let validationSource = declaredCommand !== undefined ? `canonical project validation (${file})` : source('validate');
  if (!validate && fs.existsSync(path.join(cwd, 'package.json'))) {
    if (JSON.parse(fs.readFileSync(path.join(cwd, 'package.json'), 'utf8')).scripts?.test) { validate = 'npm test'; validationSource = `project ${path.join(cwd, 'package.json')}`; }
  }
  if (!validate && fs.existsSync(path.join(cwd, 'test'))) { validate = 'node --test'; validationSource = `project ${path.join(cwd, 'test')}`; }
  if (!validate) throw new Error('project validation is unknown; set validate in .lane.json to the real project check');
  if (prepare != null && !Array.isArray(prepare)) throw new Error('invalid preparation commands');
  if (has('validate') && (typeof config.validate !== 'string' || !config.validate.trim())) throw new Error('invalid canonical validation command');
  console.log(`prepare source: ${source('prepare')}; commands: ${JSON.stringify(prepare ?? [])}`);
  const steps = [...(prepare ?? []).filter((s) => !s.unless || !fs.existsSync(path.join(cwd, s.unless))).map((s) => ({ command: s.run, source: source('prepare'), tier: 'fast' })), { command: validate, source: validationSource, tier }];
  for (const { command: step, source: commandSource, tier: stepTier } of steps) {
    if (typeof step !== 'string' || !step.trim()) throw new Error('invalid validation command');
    console.log(`sandboxed command (${commandSource}): ${step}`);
    const timeoutMs = validationStepTimeout(stepTier, process.env.MONITOR_VALIDATION_DEADLINE);
    const temporary = runTemporary(process.env.MONITOR_PROJECT_TEMP ?? nativeSessionContext(cwd)?.tempRoot);
    let scope;
    let r;
    try {
      scope = lifetimeScope(cwd, { temporary });
      const sandbox = sandboxCommand(binary, cwd, { sharedPaths, temporaryPaths: [temporary], lifetime: scope });
      r = spawnSync(process.execPath, [new URL('./bounded.mjs', import.meta.url).pathname,
        '--timeout-ms', String(timeoutMs), ...boundedArgs(scope, sandbox.binary, sandbox.args, ['/bin/sh', '-c', step])], { cwd, stdio: 'inherit', timeout: timeoutMs + VALIDATION_WRAPPER_GRACE, killSignal: 'SIGKILL',
        env: { ...process.env, ...temporaryEnvironment(temporary), LANE_CONFIG: '', LANE_VALIDATE: '', MONITOR_REQUEST_DIR: '', ORG_DIR: '', MONITOR_VALIDATION_TIER: undefined, MONITOR_VALIDATION_DEADLINE: undefined } });
    } finally { closeScope(scope); removePlainDirectory(temporary); }
    if (r.error || r.status !== 0) throw new Error(r.error?.message ?? `sandboxed validation exited ${r.status}`);
  }
} catch (e) { console.error(`monitor validation: ${e.message}`); process.exitCode = 1; }
