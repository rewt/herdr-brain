#!/usr/bin/env node
// This executor consumes the entire literal selection. No plan files, shell
// interpolation of argv, replanning or independent green receipts.
import { spawnSync } from 'node:child_process';
import { isMain } from '../lib/cli-help.mjs';
import { gitProject } from '../lib/project.mjs';
import { executionIdentity } from './execution-identity.mjs';
import { closed, refuse, validateDeclared, MAX_PLAN_BYTES } from './declaration.mjs';
import { validateSelection } from './declared-selection.mjs';
import { within } from './declared-policy.mjs';
import { remaining, projectEnvironment } from './declared-runtime.mjs';
import { recheckDeclaredGate } from './declared-gates.mjs';

export function executeDeclared(spec, { cwd = process.cwd(), env = process.env, onCommand = () => {} } = {}) {
  closed(spec, ['schema', 'base', 'candidate', 'common', 'identity', 'declaration', 'selection', 'policy', 'runtime', 'promotion_runtime', 'dependencies', 'planner'], 'literal execution selection');
  if (spec?.schema !== 'declared-gate-execution/v1' || Buffer.byteLength(JSON.stringify(spec)) > MAX_PLAN_BYTES) throw refuse('invalid literal execution selection');
  const project = gitProject(cwd);
  if (project.identity !== spec.common) throw refuse('execution project changed');
  executionIdentity(project, { cwd, bound: spec.identity });
  const value = validateDeclared(spec.declaration.value);
  const { required, ...output } = spec.selection;
  const selection = validateSelection(output, { declaration: value, required });
  // Runtime-only fields are not accepted from a planner. Selection's required
  // and normalized budget are bound by the train's literal spec.
  const deadline = Number(env.MONITOR_VALIDATION_DEADLINE);
  if (!Number.isFinite(deadline)) throw refuse('missing finite attempt deadline');
  env = projectEnvironment(env);
  recheckDeclaredGate({ repo: project.canonical, cwd, owner: spec.declaration, spec, env, deadline });
  const commands = [ { command: ['/bin/sh', '-c', value.promotion], cwd },
    ...selection.steps.map(step => ({ command: [...value.runners[step.runner].command, ...step.args], cwd: within(cwd, value.runners[step.runner].cwd) })),
    ...selection.files.map(file => ({ command: [...value.runners['node-test'].command, file], cwd: within(cwd, value.runners['node-test'].cwd) })) ];
  for (const row of commands) {
    const started_at = new Date().toISOString();
    process.stdout.write(`DECLARED_COMMAND ${JSON.stringify({ ...row, started_at })}\n`);
    const allowance = remaining(deadline), started = Date.now();
    const result = spawnSync(row.command[0], row.command.slice(1), { cwd: row.cwd, env, stdio: 'inherit',
      timeout: allowance, killSignal: 'SIGTERM' });
    const evidence = { ...row, started_at, finished_at: new Date().toISOString(), exit_code: result.status, signal: result.signal ?? null, error: result.error?.code ?? null };
    onCommand(evidence); process.stdout.write(`DECLARED_EXIT ${JSON.stringify(evidence)}\n`);
    if (result.error?.code === 'ETIMEDOUT') process.stderr.write(`GATE_TIMEOUT: wall limit ${allowance / 1000}s exceeded; elapsed ${(Date.now() - started) / 1000}s\n`);
    if (result.error || result.status !== 0 || result.signal) return result.error?.code === 'ETIMEDOUT' ? 124 : result.status ?? 1;
  }
  recheckDeclaredGate({ repo: project.canonical, cwd, owner: spec.declaration, spec, env, deadline });
  return 0;
}
if (isMain(import.meta.url)) {
  try {
    const input = process.argv.slice(2);
    if (input.length !== 1) throw refuse('executor requires one complete literal selection');
    process.exitCode = executeDeclared(JSON.parse(input[0]));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
